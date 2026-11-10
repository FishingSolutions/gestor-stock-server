#!/usr/bin/env bash
# =====================================================================
# Pruebas por la API (igual que el front) de:
#   - la Edge Function gestionar-usuarios (crear / desactivar / activar)
#   - las diferencias entre ADMINISTRADOR y EMPLEADO
#
# SOLO BASE LOCAL. Antes:
#   npx supabase start -x realtime,storage-api,imgproxy,mailpit,studio,logflare,vector,supavisor,postgres-meta
#   npx supabase db reset --local --no-seed
#   docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/datos_demo.sql
# =====================================================================
set -u
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY)=')"
OK=0; FALLO=0
TMP=$(mktemp)

check() {  # nombre, obtenido, esperado
  if [ "$2" = "$3" ]; then OK=$((OK+1)); printf 'OK    %-62s %s\n' "$1" "$2"
  else FALLO=$((FALLO+1)); printf 'FALLO %-62s obtenido=%s esperado=%s\n' "$1" "$2" "$3"; fi
}
campo() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){if(k)v=v?.[k]}console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("NO-JSON")}})' "$1"; }
login() { printf '{"email":"%s","password":"%s"}' "$1" "$2" | curl -s "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H "Content-Type: application/json" --data-binary @-; }
token() { login "$1" "$2" | campo access_token; }
# pedido HTTP: metodo, ruta, token, datos -> imprime el código y deja el cuerpo en $TMP
# Los datos van por stdin (no como argumento) para que los acentos lleguen bien en Windows
pedir() { printf "%s" "${4:-}" | curl -s -o "$TMP" -w '%{http_code}' -X "$1" "$API_URL$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $3" -H "Content-Type: application/json; charset=utf-8" -H "Prefer: return=representation" ${4:+--data-binary @-}; }
cuerpo() { campo "$1" < "$TMP"; }
fn() { pedir POST /functions/v1/gestionar-usuarios "$1" "$2"; }

ADMIN=$(token admin@stockfx.com demo-local-123)
EMP=$(token empleado@stockfx.com demo-local-123)
ADMIN_ID=11111111-1111-1111-1111-111111111111
EMP_ID=22222222-2222-2222-2222-222222222222
[ ${#ADMIN} -gt 20 ] && [ ${#EMP} -gt 20 ] || { echo "No se pudo iniciar sesión con los usuarios de demo"; exit 1; }

echo "=============== USUARIOS (Edge Function gestionar-usuarios) ==============="
check "Sin login: crear usuario"                       "$(fn "$ANON_KEY" '{"accion":"crear"}')" 401
check "EMPLEADO: crear usuario"                        "$(fn "$EMP" '{"accion":"crear","email":"x@x.com","password":"12345678","nombre":"X","apellido":"Y"}')" 403
check "  mensaje"                                      "$(cuerpo error)" "Solo un administrador puede gestionar usuarios"

check "ADMIN: crear EMPLEADO juan@stockfx.com"         "$(fn "$ADMIN" '{"accion":"crear","email":"Juan@StockFX.com","password":"juan-local-123","nombre":"Juan","apellido":"Gómez"}')" 201
check "  rol y estado"                                 "$(cuerpo usuario.rol)/$(cuerpo usuario.activo)" "EMPLEADO/true"
check "  email guardado en minúscula"                  "$(cuerpo usuario.email)" "juan@stockfx.com"
JUAN_ID=$(cuerpo usuario.id_usuario)
check "  Juan puede iniciar sesión"                    "$(t=$(token juan@stockfx.com juan-local-123); [ ${#t} -gt 20 ] && echo si || echo no)" si

check "ADMIN: crear con email repetido"                "$(fn "$ADMIN" '{"accion":"crear","email":"juan@stockfx.com","password":"otra-clave-123","nombre":"J","apellido":"G"}')" 409
check "  mensaje"                                      "$(cuerpo error)" "Ya existe un usuario con ese email"
check "ADMIN: contraseña de menos de 8"                "$(fn "$ADMIN" '{"accion":"crear","email":"a@stockfx.com","password":"1234","nombre":"A","apellido":"B"}')" 400
check "ADMIN: sin nombre"                              "$(fn "$ADMIN" '{"accion":"crear","email":"a@stockfx.com","password":"12345678","nombre":"","apellido":"B"}')" 400
check "ADMIN: rol inventado"                           "$(fn "$ADMIN" '{"accion":"crear","email":"a@stockfx.com","password":"12345678","nombre":"A","apellido":"B","rol":"DUEÑO"}')" 400
check "ADMIN: acción inventada"                        "$(fn "$ADMIN" '{"accion":"borrar","id_usuario":"x"}')" 400
check "ADMIN: crear otro ADMINISTRADOR"                "$(fn "$ADMIN" '{"accion":"crear","email":"segunda@stockfx.com","password":"segunda-local-123","nombre":"Laura","apellido":"Díaz","rol":"administrador"}')" 201
check "  rol"                                          "$(cuerpo usuario.rol)" "ADMINISTRADOR"
SEG_ID=$(cuerpo usuario.id_usuario)

check "ADMIN: desactivar a Juan"                       "$(fn "$ADMIN" "{\"accion\":\"desactivar\",\"id_usuario\":\"$JUAN_ID\"}")" 200
check "  activo"                                       "$(cuerpo usuario.activo)" "false"
check "  Juan ya no puede iniciar sesión"              "$(login juan@stockfx.com juan-local-123 | campo error_code)" "user_banned"
check "ADMIN: activar a Juan"                          "$(fn "$ADMIN" "{\"accion\":\"activar\",\"id_usuario\":\"$JUAN_ID\"}")" 200
check "  Juan vuelve a iniciar sesión"                 "$(t=$(token juan@stockfx.com juan-local-123); [ ${#t} -gt 20 ] && echo si || echo no)" si
check "ADMIN: desactivarse a sí mismo"                 "$(fn "$ADMIN" "{\"accion\":\"desactivar\",\"id_usuario\":\"$ADMIN_ID\"}")" 400
check "  mensaje"                                      "$(cuerpo error)" "No podés desactivar tu propio usuario"
check "ADMIN: desactivar usuario inexistente"          "$(fn "$ADMIN" '{"accion":"desactivar","id_usuario":"99999999-9999-9999-9999-999999999999"}')" 404
check "EMPLEADO: desactivar a otro"                    "$(fn "$EMP" "{\"accion\":\"desactivar\",\"id_usuario\":\"$JUAN_ID\"}")" 403

check "ADMIN: poner activo=false editando la tabla"    "$(pedir PATCH "/rest/v1/usuario?id_usuario=eq.$JUAN_ID" "$ADMIN" '{"activo":false}')" 403
check "  (solo se puede con la Edge Function)"         "$(cuerpo code)" "42501"
check "ADMIN: cambiar rol de Juan editando la tabla"   "$(pedir PATCH "/rest/v1/usuario?id_usuario=eq.$JUAN_ID" "$ADMIN" '{"rol":"ADMINISTRADOR"}')/$(cuerpo 0.rol)" "200/ADMINISTRADOR"
pedir PATCH "/rest/v1/usuario?id_usuario=eq.$JUAN_ID" "$ADMIN" '{"rol":"EMPLEADO"}' >/dev/null
check "EMPLEADO: cambiarse el rol a sí mismo"          "$(pedir PATCH "/rest/v1/usuario?id_usuario=eq.$EMP_ID" "$EMP" '{"rol":"ADMINISTRADOR"}')/$(cuerpo length)" "200/0"

# Último admin: con 2 admins se puede bajar a uno; con 1 solo, no.
check "Con 2 admins: desactivar a Laura"               "$(fn "$ADMIN" "{\"accion\":\"desactivar\",\"id_usuario\":\"$SEG_ID\"}")" 200
check "Único admin activo se quita el rol"             "$(pedir PATCH "/rest/v1/usuario?id_usuario=eq.$ADMIN_ID" "$ADMIN" '{"rol":"EMPLEADO"}')"  400
check "  mensaje"                                      "$(cuerpo message)" "Tiene que quedar al menos un administrador activo"

echo
echo "=============== ALGUIEN SE REGISTRA SOLO (registro público encendido) ==============="
pedir GET "/rest/v1/producto?codigo=eq.COCA500&select=id_producto" "$ADMIN" >/dev/null
COCA=$(cuerpo 0.id_producto)
check "Desconocido se registra con la clave pública"   "$(pedir POST /auth/v1/signup "$ANON_KEY" '{"email":"intruso@gmail.com","password":"intruso-123"}')" 200
INTRUSO=$(token intruso@gmail.com intruso-123)
check "  puede iniciar sesión (Supabase lo permite)"   "$([ ${#INTRUSO} -gt 20 ] && echo si || echo no)" si
pedir GET "/rest/v1/usuario?email=eq.intruso@gmail.com&select=rol,activo" "$ADMIN" >/dev/null
check "  queda EMPLEADO y DESACTIVADO"                 "$(cuerpo 0.rol)/$(cuerpo 0.activo)" "EMPLEADO/false"
INTRUSO_ID=$(pedir GET "/rest/v1/usuario?email=eq.intruso@gmail.com&select=id_usuario" "$ADMIN" >/dev/null; cuerpo 0.id_usuario)
check "  NO ve productos"                              "$(pedir GET "/rest/v1/v_producto?select=codigo" "$INTRUSO")/$(cuerpo length)" "200/0"
check "  NO ve KPIs"                                   "$(pedir POST /rest/v1/rpc/kpis_productos "$INTRUSO" '{}')" 400
check "  mensaje"                                      "$(cuerpo message)" "No tenés permiso para ver el inventario (usuario sin cuenta o inactivo)"
check "  NO puede registrar una venta"                 "$(pedir POST /rest/v1/rpc/registrar_movimiento "$INTRUSO" "{\"p_id_producto\":$COCA,\"p_tipo\":\"SALIDA\",\"p_cantidad\":1,\"p_motivo\":\"x\"}")" 400
check "  mensaje"                                      "$(cuerpo message)" "No tenés permiso para registrar movimientos (usuario sin cuenta o inactivo)"
check "  NO puede crear usuarios"                      "$(fn "$INTRUSO" '{"accion":"crear"}')" 403
check "Otro se registra fingiendo ser admin"           "$(pedir POST /auth/v1/signup "$ANON_KEY" '{"email":"trampa@gmail.com","password":"trampa-123","data":{"creado_por_admin":true,"rol":"ADMINISTRADOR"}}')" 200
pedir GET "/rest/v1/usuario?email=eq.trampa@gmail.com&select=rol,activo" "$ADMIN" >/dev/null
check "  igual queda EMPLEADO y DESACTIVADO"           "$(cuerpo 0.rol)/$(cuerpo 0.activo)" "EMPLEADO/false"
check "El admin lo activa desde la app"                "$(fn "$ADMIN" "{\"accion\":\"activar\",\"id_usuario\":\"$INTRUSO_ID\"}")" 200
check "  recién ahí ve productos"                      "$(pedir GET "/rest/v1/v_producto?select=codigo&limit=1" "$INTRUSO")/$(cuerpo length)" "200/1"

echo
echo "=============== ADMINISTRADOR vs EMPLEADO ==============="
pedir GET "/rest/v1/producto?codigo=eq.COCA500&select=id_producto" "$ADMIN" >/dev/null
COCA=$(cuerpo 0.id_producto)
NUEVO='{"codigo":"PRUEBA1","nombre":"Producto de prueba","precio_venta":100,"stock_actual":5,"stock_minimo":1,"stock_maximo":10}'

check "EMPLEADO: ver productos"                        "$(pedir GET "/rest/v1/v_producto?select=codigo&limit=1" "$EMP")/$(cuerpo length)" "200/1"
check "EMPLEADO: ver KPIs y dashboard"                 "$(pedir POST /rest/v1/rpc/kpis_productos "$EMP" '{}')/$(pedir POST /rest/v1/rpc/dashboard_resumen "$EMP" '{}')" "200/200"
check "EMPLEADO: crear producto"                       "$(pedir POST /rest/v1/producto "$EMP" "$NUEVO")" 403
check "EMPLEADO: crear categoría"                      "$(pedir POST /rest/v1/categoria "$EMP" '{"nombre":"Nueva"}')" 403
check "EMPLEADO: cambiar precio"                       "$(pedir PATCH "/rest/v1/producto?id_producto=eq.$COCA" "$EMP" '{"precio_venta":1}')/$(cuerpo length)" "200/0"
check "EMPLEADO: dar de baja un producto"              "$(pedir PATCH "/rest/v1/producto?id_producto=eq.$COCA" "$EMP" '{"activo":false}')/$(cuerpo length)" "200/0"
check "EMPLEADO: borrar un producto"                   "$(pedir DELETE "/rest/v1/producto?id_producto=eq.$COCA" "$EMP")/$(cuerpo length)" "200/0"
check "EMPLEADO: cambiar stock a mano"                 "$(pedir PATCH "/rest/v1/producto?id_producto=eq.$COCA" "$EMP" '{"stock_actual":999}')" 403
check "EMPLEADO: ENTRADA (ingreso de mercadería)"      "$(pedir POST /rest/v1/rpc/registrar_movimiento "$EMP" "{\"p_id_producto\":$COCA,\"p_tipo\":\"ENTRADA\",\"p_cantidad\":10,\"p_motivo\":\"Llegó el proveedor\"}")/$(cuerpo stock_resultante)" "200/56"
check "EMPLEADO: SALIDA (venta)"                       "$(pedir POST /rest/v1/rpc/registrar_movimiento "$EMP" "{\"p_id_producto\":$COCA,\"p_tipo\":\"SALIDA\",\"p_cantidad\":6,\"p_motivo\":\"Venta\"}")/$(cuerpo stock_resultante)" "200/50"
check "EMPLEADO: AJUSTE por conteo"                    "$(pedir POST /rest/v1/rpc/registrar_movimiento "$EMP" "{\"p_id_producto\":$COCA,\"p_tipo\":\"AJUSTE\",\"p_cantidad\":48,\"p_motivo\":\"Conteo\"}")" 400
check "  mensaje"                                      "$(cuerpo message)" "Solo un administrador puede hacer ajustes de stock"
check "EMPLEADO: crear usuarios"                       "$(fn "$EMP" '{"accion":"crear"}')" 403

check "ADMIN: crear producto"                          "$(pedir POST /rest/v1/producto "$ADMIN" "$NUEVO")" 201
PRUEBA=$(cuerpo 0.id_producto)
check "ADMIN: crear categoría"                         "$(pedir POST /rest/v1/categoria "$ADMIN" '{"nombre":"Nueva"}')" 201
check "ADMIN: cambiar precio"                          "$(pedir PATCH "/rest/v1/producto?id_producto=eq.$COCA" "$ADMIN" '{"precio_venta":1250}')/$(cuerpo 0.precio_venta)" "200/1250"
check "ADMIN: dar de baja un producto"                     "$(pedir PATCH "/rest/v1/producto?id_producto=eq.$PRUEBA" "$ADMIN" '{"activo":false}')/$(cuerpo 0.activo)" "200/false"
check "ADMIN: cambiar stock a mano"                    "$(pedir PATCH "/rest/v1/producto?id_producto=eq.$COCA" "$ADMIN" '{"stock_actual":999}')" 403
check "ADMIN: AJUSTE por conteo"                       "$(pedir POST /rest/v1/rpc/registrar_movimiento "$ADMIN" "{\"p_id_producto\":$COCA,\"p_tipo\":\"AJUSTE\",\"p_cantidad\":48,\"p_motivo\":\"Conteo físico\"}")/$(cuerpo stock_resultante)" "200/48"
check "ADMIN: borrar producto SIN movimientos"         "$(pedir DELETE "/rest/v1/producto?id_producto=eq.$PRUEBA" "$ADMIN")/$(cuerpo length)" "200/1"
check "ADMIN: borrar producto CON movimientos"         "$(pedir DELETE "/rest/v1/producto?id_producto=eq.$COCA" "$ADMIN")" 409

echo
echo "TOTAL: $((OK+FALLO)) pruebas, $OK OK, $FALLO FALLO"
rm -f "$TMP"
