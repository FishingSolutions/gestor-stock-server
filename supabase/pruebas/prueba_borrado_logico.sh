#!/usr/bin/env bash
# Borrado lógico de productos, probado por la API como lo usa el front.
# SOLO BASE LOCAL. Antes: db reset --local --no-seed + datos_demo.sql
set -u
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY)=')"
OK=0; FALLO=0; TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
check() { if [ "$2" = "$3" ]; then OK=$((OK+1)); printf 'OK    %-55s %s\n' "$1" "$2"; else FALLO=$((FALLO+1)); printf 'FALLO %-55s obtenido=%s esperado=%s\n' "$1" "$2" "$3"; fi; }
campo() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){if(k)v=v?.[k]}console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("NO-JSON")}})' "$1"; }
cuerpo() { campo "$1" < "$TMP"; }
token() { printf '{"email":"%s","password":"demo-local-123"}' "$1" | curl -s "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H "Content-Type: application/json" --data-binary @- | campo access_token; }
pedir() { printf "%s" "${4:-}" | curl -s -o "$TMP" -w '%{http_code}' -X "$1" "$API_URL/rest/v1/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -H "Prefer: return=representation" ${4:+--data-binary @-}; }
DB="docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres -tAc"

ADMIN=$(token admin@stockfx.com); EMP=$(token empleado@stockfx.com)
COCA=$($DB "select id_producto from producto where codigo='COCA500'")      # tiene movimientos
MOVS=$($DB "select count(*) from movimiento_stock where id_producto=$COCA")
TOTAL=$(pedir POST rpc/kpis_productos "$ADMIN" '{}' >/dev/null; cuerpo total_productos)

check "EMPLEADO borra un producto"                   "$(pedir DELETE "producto?id_producto=eq.$COCA" "$EMP")/$($DB "select eliminado from producto where id_producto=$COCA")" "200/f"
check "ADMIN borra un producto CON movimientos"      "$(pedir DELETE "producto?id_producto=eq.$COCA" "$ADMIN")" 200
check "  la fila sigue en la base, marcada"          "$($DB "select eliminado||'/'||activo||'/'||(fecha_eliminacion is not null)||'/'||(id_usuario_eliminacion is not null) from producto where id_producto=$COCA")" "true/false/true/true"
check "  ya no aparece en v_producto"                "$(pedir GET "v_producto?id_producto=eq.$COCA&select=codigo" "$ADMIN")/$(cuerpo length)" "200/0"
check "  los KPIs cuentan un producto menos"         "$(pedir POST rpc/kpis_productos "$ADMIN" '{}')/$(cuerpo total_productos)" "200/$((TOTAL-1))"
check "  sus movimientos siguen en el historial"     "$(pedir GET "v_movimiento?id_producto=eq.$COCA&select=id_movimiento" "$ADMIN")/$(cuerpo length)" "200/$MOVS"
check "  no se le pueden registrar movimientos"      "$(pedir POST rpc/registrar_movimiento "$EMP" "{\"p_id_producto\":$COCA,\"p_tipo\":\"ENTRADA\",\"p_cantidad\":1,\"p_motivo\":\"x\"}")" 400
check "  borrarlo otra vez no hace nada"             "$(pedir DELETE "producto?id_producto=eq.$COCA" "$ADMIN")" 200
check "  el admin no puede tocar 'eliminado' a mano" "$(pedir PATCH "producto?id_producto=eq.$COCA" "$ADMIN" '{"eliminado":false}')" 403
check "EMPLEADO intenta restaurarlo"                 "$(pedir POST rpc/restaurar_producto "$EMP" "{\"p_id_producto\":$COCA}")" 400
check "ADMIN lo restaura"                            "$(pedir POST rpc/restaurar_producto "$ADMIN" "{\"p_id_producto\":$COCA}")/$(cuerpo eliminado)/$(cuerpo activo)" "200/false/true"
check "  vuelve a aparecer en v_producto"            "$(pedir GET "v_producto?id_producto=eq.$COCA&select=codigo" "$ADMIN")/$(cuerpo 0.codigo)" "200/COCA500"
check "Restaurar uno que no está eliminado"          "$(pedir POST rpc/restaurar_producto "$ADMIN" "{\"p_id_producto\":$COCA}")" 400
echo; echo "TOTAL: $((OK+FALLO)) pruebas, $OK OK, $FALLO FALLO"
