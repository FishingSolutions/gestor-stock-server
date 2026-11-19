#!/usr/bin/env bash
# =====================================================================
# Pruebas por la API de "Importar con IA" (importar-productos-ia).
#
# SOLO BASE LOCAL. Antes:
#   npx supabase start -x realtime,storage-api,imgproxy,mailpit,studio,logflare,vector,supavisor,postgres-meta
#   npx supabase db reset --local --no-seed
#   docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/datos_demo.sql
#   npm install   (las planillas se generan con la librería xlsx)
#
# La IA no se prueba acá: sin AI_API_KEY la función tiene que seguir
# funcionando con el mapeo por encabezados (eso es justamente lo que se
# verifica). Para probar la IA, configurá los secretos y mirá el README.
# =====================================================================
set -u
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY)=')"
if [ -z "${API_URL:-}" ] || [ -z "${ANON_KEY:-}" ]; then
  echo "No se pudo leer API_URL/ANON_KEY. ¿Está corriendo 'npx supabase start'?"
  exit 1
fi

OK=0; FALLO=0
TMP=$(mktemp)
DIR=supabase/pruebas/.planillas_ia_tmp
mkdir -p "$DIR"
trap 'rm -rf "$DIR" "$TMP"' EXIT

check() {
  if [ "$2" = "$3" ]; then OK=$((OK+1)); printf 'OK    %-62s %s\n' "$1" "$2"
  else FALLO=$((FALLO+1)); printf 'FALLO %-62s obtenido=%s esperado=%s\n' "$1" "$2" "$3"; fi
}
campo() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){if(k)v=v?.[k]}console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("NO-JSON")}})' "$1"; }
cuerpo() { campo "$1" < "$TMP"; }
token() { printf '{"email":"%s","password":"demo-local-123"}' "$1" | curl -s "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H "Content-Type: application/json" --data-binary @- | campo access_token; }
rest() { curl -s -o "$TMP" -w '%{http_code}' "$API_URL/rest/v1/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H "Content-Type: application/json" ${3:+-X POST --data-binary "$3"}; }
FN="$API_URL/functions/v1/importar-productos-ia"

post() {
  local tk="$1"; shift
  curl -s -o "$TMP" -w '%{http_code}' -X POST "$FN" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $tk" "$@"
}
analizar() {
  local tk="$1" f="$2"; shift 2
  post "$tk" -F "accion=analizar" -F "archivo=@$f" "$@"
}
confirmar() {
  local tk="$1" f="$2" key="$3" modo="$4" decisiones="$5" crear="$6" mapeo="$7"
  [ -z "$decisiones" ] && decisiones='{}'
  [ -z "$crear" ] && crear=false
  local args=(-F "accion=confirmar" -F "archivo=@$f" -F "idempotencyKey=$key"
              -F "decisiones=$decisiones" -F "crearCategorias=$crear")
  [ -n "$modo" ] && args+=(-F "modoStock=$modo")
  [ -n "$mapeo" ] && args+=(-F "mapeo=$mapeo")
  post "$tk" "${args[@]}"
}
idp() { rest "$ADMIN" "producto?codigo=eq.$1&select=id_producto" >/dev/null; cuerpo 0.id_producto; }
mov() { rest "$ADMIN" "movimiento_stock?id_producto=eq.$1&motivo=like.*Importaci*&select=tipo_movimiento,cantidad,stock_anterior,stock_resultante&order=id_movimiento.desc&limit=1" >/dev/null; }

K1=aaaaaaaa-1111-4111-8111-000000000001
K2=aaaaaaaa-1111-4111-8111-000000000002
K3=aaaaaaaa-1111-4111-8111-000000000003
K4=aaaaaaaa-1111-4111-8111-000000000004
K5=aaaaaaaa-1111-4111-8111-000000000005
K6=aaaaaaaa-1111-4111-8111-000000000006
K7=aaaaaaaa-1111-4111-8111-000000000007
K8=aaaaaaaa-1111-4111-8111-000000000008
K9=aaaaaaaa-1111-4111-8111-000000000009
K10=aaaaaaaa-1111-4111-8111-000000000010
K11=aaaaaaaa-1111-4111-8111-000000000011

ADMIN=$(token admin@stockfx.com); EMP=$(token empleado@stockfx.com)
[ ${#ADMIN} -gt 20 ] && [ ${#EMP} -gt 20 ] || { echo "No se pudo iniciar sesión con los usuarios de demo"; exit 1; }

# ---- Planillas de prueba -------------------------------------------------
node --input-type=module - "$DIR" <<'JS'
import XLSX from 'xlsx'
import { writeFileSync } from 'node:fs'
const dir = process.argv[2]
const guardar = (nombre, filas) => {
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), 'Productos')
  writeFileSync(`${dir}/${nombre}`, XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }))
}

const T = ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio', 'Costo']

guardar('basico.xlsx', [
  T,
  ['NUEVO01', 'Producto nuevo', 'Bebidas', 7, 500, 300],
  ['COCA500', 'Coca-Cola 500ml', 'Bebidas', 40, 1200, 800],
  ['AGUA2L', 'Agua mineral 2L', 'Bebidas', 6, 950, 500],
])

guardar('sumar.xlsx', [
  T,
  ['NUEVO01', 'Producto nuevo', 'Bebidas', 5, 500, 300],
  ['AGUA2L', 'Agua mineral 2L', 'Bebidas', 4, 950, 500],
])

guardar('reemplazar.xlsx', [T, ['AGUA2L', 'Agua mineral 2L', 'Bebidas', 99, 950, 500]])

guardar('ambigua.xlsx', [T, ['NUEVO-COCA', 'Coca-Cola 500ml', 'Bebidas', 1, 1250, 800]])
guardar('ambigua-crear.xlsx', [T, ['NUEVO-COCA2', 'Coca-Cola 500ml', 'Bebidas', 1, 1300, 800]])
guardar('ambigua-vincular.xlsx', [T, ['NUEVO-COCA', 'Coca-Cola 500ml', 'Bebidas', 1, 1250, 800]])

guardar('mixto.xlsx', [
  T,
  ['MIX-OK', 'Producto bueno', '', 2, 100, 50],
  ['MIX-MAL', 'Producto malo', '', -5, 100, 50],
])

guardar('categoria.xlsx', [T, ['CAT-NEW', 'Producto categoría nueva', 'Categoría IA', 1, 10, 5]])
guardar('duplicado.xlsx', [T, ['DUP1', 'Duplicado uno', '', 1, 10, 5], ['DUP1', 'Duplicado dos', '', 2, 20, 10]])
guardar('formula.xlsx', [T, ['=SUM(A1:A2)', 'Código fórmula', '', 1, 10, 5], ['F-OK', 'Producto sano', '', 1, 10, 5]])
guardar('ceros.xlsx', [T, ['0001', 'Código con ceros', '', 1, 10, 5]])
guardar('sin-precio.xlsx', [['Codigo', 'Descripcion', 'Stock'], ['X1', 'Sin precio', 5]])
guardar('sin-codigo.xlsx', [['SKU interno', 'Nombre comercial', 'Precio'], ['M-1', 'Producto mapeado', 100]])

// 2001 filas: supera el máximo permitido
const muchas = [T]
for (let i = 1; i <= 2001; i++) muchas.push([`T${i}`, `Producto ${i}`, '', 1, 10, 5])
guardar('demasiadas.xlsx', muchas)

writeFileSync(`${dir}/no-es-excel.xlsx`, 'Codigo,Descripcion,Stock,Precio\nZ1,Trucho,1,1\n')
writeFileSync(`${dir}/datos.csv`, 'Codigo,Descripcion,Stock,Precio\nZ1,Trucho,1,1\n')
JS

echo "=============== QUIÉN PUEDE IMPORTAR ==============="
check "Sin login (analizar)"                        "$(analizar "$ANON_KEY" "$DIR/basico.xlsx")/$(cuerpo error.codigo)" "401/SIN_SESION"
check "EMPLEADO (analizar)"                         "$(analizar "$EMP" "$DIR/basico.xlsx")/$(cuerpo error.codigo)" "403/SOLO_ADMINISTRADOR"
check "  mensaje"                                   "$(cuerpo error.mensaje)" "Solo un administrador puede importar productos."
check "EMPLEADO llamando a la función SQL directo"  "$(rest "$EMP" rpc/confirmar_importacion_productos '{"p_idempotency_key":"bbbbbbbb-1111-4111-8111-000000000001","p_archivo":"x.xlsx","p_filas":[]}')/$(cuerpo message)" "400/Solo un administrador puede importar productos"

echo; echo "=============== ANALIZAR: VISTA PREVIA SIN ESCRIBIR ==============="
rest "$ADMIN" "importacion_producto?select=id_importacion" >/dev/null
ANTES=$(cuerpo length)
check "ADMIN analiza basico.xlsx"                   "$(analizar "$ADMIN" "$DIR/basico.xlsx")" "200"
check "  cantidad de filas"                         "$(cuerpo resumen.filas)" "3"
check "  estados (nuevo/sin cambios/existente)"     "$(cuerpo filas | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(f=>f.estado).join(",")))')" "nuevo,sin_cambios,existente"
check "  código conservado como texto"              "$(cuerpo filas.0.codigo)" "NUEVO01"
if [ -z "${AI_API_KEY:-}" ]; then
  check "  IA no configurada no finge uso"          "$(cuerpo ia.usada)" "false"
fi
rest "$ADMIN" "producto?codigo=eq.NUEVO01&select=id_producto" >/dev/null
check "  no se creó el producto"                    "$(cuerpo length)" "0"
rest "$ADMIN" "importacion_producto?select=id_importacion" >/dev/null
check "  no se guardó historial"                    "$(cuerpo length)" "$ANTES"
check "Sin modo de stock no deja confirmar"         "$(confirmar "$ADMIN" "$DIR/basico.xlsx" "$K1" "" "{}")/$(cuerpo error.codigo)" "400/MODO_STOCK_REQUERIDO"

echo; echo "=============== ARCHIVOS INVÁLIDOS ==============="
check "Texto disfrazado de .xlsx"                   "$(analizar "$ADMIN" "$DIR/no-es-excel.xlsx")/$(cuerpo error.codigo)" "400/ARCHIVO_ILEGIBLE"
check "Archivo .csv"                                "$(analizar "$ADMIN" "$DIR/datos.csv")/$(cuerpo error.codigo)" "415/TIPO_NO_PERMITIDO"
check "Sin archivo"                                 "$(post "$ADMIN" -F 'accion=analizar' -F 'otro=1')/$(cuerpo error.codigo)" "400/SIN_ARCHIVO"
check "Hoja inexistente"                            "$(analizar "$ADMIN" "$DIR/basico.xlsx" -F 'hoja=NoExiste')/$(cuerpo error.codigo)" "400/HOJA_INEXISTENTE"
check "Más de 2.000 filas"                          "$(analizar "$ADMIN" "$DIR/demasiadas.xlsx")/$(cuerpo error.codigo)" "400/DEMASIADAS_FILAS"
check "Columnas no reconocidas: pide mapeo"         "$(analizar "$ADMIN" "$DIR/sin-codigo.xlsx")/$(cuerpo necesitaMapeo)" "200/true"
check "  con mapeo manual funciona"                 "$(analizar "$ADMIN" "$DIR/sin-codigo.xlsx" -F 'mapeo={"codigo":0,"nombre":1,"precio":2}')/$(cuerpo filas.0.estado)" "200/nuevo"

echo; echo "=============== CONFIRMAR: ALTA + IDEMPOTENCIA ==============="
check "ADMIN confirma basico.xlsx (REEMPLAZAR)"     "$(confirmar "$ADMIN" "$DIR/basico.xlsx" "$K1" REEMPLAZAR '{}')/$(cuerpo estado)" "200/COMPLETADA"
check "  creados / actualizados / sin cambios"      "$(cuerpo resumen.productosCreados)/$(cuerpo resumen.productosActualizados)/$(cuerpo resumen.productosSinCambios)" "1/1/1"
rest "$ADMIN" "producto?codigo=eq.NUEVO01&select=codigo,stock_actual,precio_venta" >/dev/null
check "  NUEVO01 creado con stock 7"                "$(cuerpo 0.codigo)/$(cuerpo 0.stock_actual)/$(cuerpo 0.precio_venta)" "NUEVO01/7/500"
NUEVO_ID=$(idp NUEVO01)
mov "$NUEVO_ID"
check "  el alta dejó un movimiento ENTRADA"        "$(cuerpo 0.tipo_movimiento)/$(cuerpo 0.cantidad)/$(cuerpo 0.stock_anterior)/$(cuerpo 0.stock_resultante)" "ENTRADA/7/0/7"
rest "$ADMIN" "producto?codigo=eq.AGUA2L&select=precio_venta" >/dev/null
check "  AGUA2L actualizado"                        "$(cuerpo 0.precio_venta)" "950"
check "Repetir la confirmación (misma clave)"       "$(confirmar "$ADMIN" "$DIR/basico.xlsx" "$K1" REEMPLAZAR '{}')/$(cuerpo repetida)" "200/true"
rest "$ADMIN" "producto?codigo=eq.NUEVO01&select=stock_actual" >/dev/null
check "  no se duplicó el stock"                    "$(cuerpo 0.stock_actual)" "7"
check "Misma clave con otro modo es conflicto"      "$(confirmar "$ADMIN" "$DIR/basico.xlsx" "$K1" SUMAR '{}')/$(cuerpo error.codigo)" "409/IDEMPOTENCIA_CONFLICTO"

echo; echo "=============== STOCK: SUMAR Y REEMPLAZAR ==============="
check "SUMAR stock (NUEVO01 7->12, AGUA2L 6->10)"   "$(confirmar "$ADMIN" "$DIR/sumar.xlsx" "$K2" SUMAR '{}')/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?codigo=eq.NUEVO01&select=stock_actual" >/dev/null
NUEVO_STOCK=$(cuerpo 0.stock_actual)
rest "$ADMIN" "producto?codigo=eq.AGUA2L&select=stock_actual" >/dev/null
AGUA_STOCK=$(cuerpo 0.stock_actual)
check "  stocks resultantes"                        "$NUEVO_STOCK/$(cuerpo 0.stock_actual)" "12/10"
mov "$NUEVO_ID"
check "  ENTRADA de 5 (7 -> 12)"                    "$(cuerpo 0.tipo_movimiento)/$(cuerpo 0.cantidad)/$(cuerpo 0.stock_anterior)/$(cuerpo 0.stock_resultante)" "ENTRADA/5/7/12"
AGUA_ID=$(idp AGUA2L); mov "$AGUA_ID"
check "  ENTRADA de 4 (6 -> 10)"                    "$(cuerpo 0.tipo_movimiento)/$(cuerpo 0.cantidad)/$(cuerpo 0.stock_anterior)/$(cuerpo 0.stock_resultante)" "ENTRADA/4/6/10"
check "REEMPLAZAR stock (AGUA2L 10->99)"            "$(confirmar "$ADMIN" "$DIR/reemplazar.xlsx" "$K3" REEMPLAZAR '{}')/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?codigo=eq.AGUA2L&select=stock_actual" >/dev/null
check "  stock resultante"                          "$(cuerpo 0.stock_actual)" "99"
mov "$AGUA_ID"
check "  AJUSTE de 89 (10 -> 99)"                   "$(cuerpo 0.tipo_movimiento)/$(cuerpo 0.cantidad)/$(cuerpo 0.stock_anterior)/$(cuerpo 0.stock_resultante)" "AJUSTE/89/10/99"

echo; echo "=============== COINCIDENCIAS AMBIGUAS ==============="
check "Analizar nombre parecido con código nuevo"   "$(analizar "$ADMIN" "$DIR/ambigua.xlsx")/$(cuerpo filas.0.estado)" "200/ambigua"
check "  sugiere COCA500"                           "$(cuerpo filas.0.sugerencias.0.codigo)" "COCA500"
COCA_ID=$(idp COCA500)
check "Confirmar sin resolver: no escribe nada"     "$(confirmar "$ADMIN" "$DIR/ambigua.xlsx" "$K4" REEMPLAZAR '{}')/$(cuerpo error.codigo)" "422/FILAS_SIN_RESOLVER"
check "VINCULAR a COCA500 (código distinto)"        "$(confirmar "$ADMIN" "$DIR/ambigua-vincular.xlsx" "$K4" REEMPLAZAR "{\"2\":{\"accion\":\"VINCULAR\",\"idProducto\":$COCA_ID}}")/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?id_producto=eq.$COCA_ID&select=codigo,precio_venta" >/dev/null
check "  se actualizó COCA500 y no se creó otro"    "$(cuerpo 0.codigo)/$(cuerpo 0.precio_venta)" "COCA500/1250"
rest "$ADMIN" "producto?codigo=eq.NUEVO-COCA&select=id_producto" >/dev/null
check "  el código nuevo no existe"                 "$(cuerpo length)" "0"
check "VINCULAR a un producto que no corresponde"   "$(confirmar "$ADMIN" "$DIR/ambigua.xlsx" "$K5" REEMPLAZAR "{\"2\":{\"accion\":\"VINCULAR\",\"idProducto\":$AGUA_ID}}")/$(cuerpo error.codigo)" "422/FILAS_SIN_RESOLVER"
check "CREAR a pesar del nombre parecido"           "$(confirmar "$ADMIN" "$DIR/ambigua-crear.xlsx" "$K6" REEMPLAZAR '{"2":{"accion":"CREAR"}}')/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?codigo=eq.NUEVO-COCA2&select=codigo" >/dev/null
check "  se creó el producto nuevo"                 "$(cuerpo 0.codigo)" "NUEVO-COCA2"

echo; echo "=============== ARCHIVO PARCIALMENTE INVÁLIDO ==============="
check "Analizar mixto: 1 buena + 1 inválida"        "$(analizar "$ADMIN" "$DIR/mixto.xlsx")/$(cuerpo resumen.nuevos)/$(cuerpo resumen.invalidas)" "200/1/1"
check "Confirmar sin excluir: no escribe nada"      "$(confirmar "$ADMIN" "$DIR/mixto.xlsx" "$K7" REEMPLAZAR '{}')/$(cuerpo error.codigo)" "422/FILAS_SIN_RESOLVER"
rest "$ADMIN" "producto?codigo=eq.MIX-OK&select=id_producto" >/dev/null
check "  no se creó la fila buena"                  "$(cuerpo length)" "0"
check "Excluir la fila mala y reintentar"           "$(confirmar "$ADMIN" "$DIR/mixto.xlsx" "$K7" REEMPLAZAR '{"3":{"accion":"EXCLUIR"}}')/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?codigo=eq.MIX-OK&select=codigo" >/dev/null
check "  ahora sí se creó la buena"                 "$(cuerpo 0.codigo)" "MIX-OK"

echo; echo "=============== CATEGORÍAS, DUPLICADOS Y FÓRMULAS ==============="
check "Categoría nueva sin autorización: rechaza"   "$(confirmar "$ADMIN" "$DIR/categoria.xlsx" "$K8" REEMPLAZAR '{}')/$(cuerpo error.codigo)" "422/IMPORTACION_RECHAZADA"
rest "$ADMIN" "importacion_producto?archivo=eq.categoria.xlsx&select=estado,productos_importados" >/dev/null
check "  queda el historial RECHAZADA sin escribir" "$(cuerpo 0.estado)/$(cuerpo 0.productos_importados)" "RECHAZADA/0"
check "Con 'crear categorías' funciona"             "$(confirmar "$ADMIN" "$DIR/categoria.xlsx" "$K8" REEMPLAZAR '{}' true)/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "categoria?nombre=eq.Categor%C3%ADa%20IA&select=nombre" >/dev/null
check "  la categoría quedó creada"                 "$(cuerpo 0.nombre)" "Categoría IA"
check "Código repetido: la segunda es inválida"     "$(analizar "$ADMIN" "$DIR/duplicado.xlsx")/$(cuerpo resumen.invalidas)" "200/1"
check "  se puede excluir y crear una sola vez"     "$(confirmar "$ADMIN" "$DIR/duplicado.xlsx" "$K9" REEMPLAZAR '{"3":{"accion":"EXCLUIR"}}')/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?codigo=eq.DUP1&select=codigo" >/dev/null
check "  queda una sola fila DUP1"                  "$(cuerpo length)" "1"
check "Código con fórmula: inválido"                "$(analizar "$ADMIN" "$DIR/formula.xlsx")/$(cuerpo filas.0.errores.0)" "200/El código no puede ser una fórmula."
check "  excluirla deja importar el resto"          "$(confirmar "$ADMIN" "$DIR/formula.xlsx" "$K11" REEMPLAZAR '{"2":{"accion":"EXCLUIR"}}')/$(cuerpo estado)" "200/COMPLETADA"
check "Código 0001 se guarda como texto"            "$(confirmar "$ADMIN" "$DIR/ceros.xlsx" "$K10" REEMPLAZAR '{}')/$(cuerpo estado)" "200/COMPLETADA"
rest "$ADMIN" "producto?codigo=eq.0001&select=codigo" >/dev/null
check "  el código no perdió los ceros"             "$(cuerpo 0.codigo)" "0001"

echo; echo "=============== HISTORIAL Y DETALLE ==============="
rest "$ADMIN" "importacion_producto?select=archivo,estado,productos_importados,modo_stock&order=id_importacion.desc&limit=1" >/dev/null
check "El historial guarda el modo y el resultado"  "$(cuerpo 0.archivo)/$(cuerpo 0.estado)/$(cuerpo 0.productos_importados)/$(cuerpo 0.modo_stock)" "ceros.xlsx/COMPLETADA/1/REEMPLAZAR"
rest "$ADMIN" "importacion_producto?archivo=eq.sumar.xlsx&select=id_importacion" >/dev/null
SUMAR_ID=$(cuerpo 0.id_importacion)
rest "$ADMIN" "importacion_producto_fila?select=numero_fila,accion,stock_anterior,stock_resultante,id_movimiento&id_importacion=eq.$SUMAR_ID&order=numero_fila" >/dev/null
check "El detalle por fila guarda stock y movimiento" "$(cuerpo 0.accion)/$(cuerpo 0.stock_anterior)/$(cuerpo 0.stock_resultante)/$([ "$(cuerpo 0.id_movimiento)" != "null" ] && echo si || echo no)" "ACTUALIZAR/7/12/si"
rest "$EMP" "importacion_producto_fila?select=id_fila" >/dev/null
check "EMPLEADO no ve el detalle (RLS)"             "$(cuerpo length)" "0"
rest "$EMP" "importacion_producto?select=id_importacion" >/dev/null
check "EMPLEADO no ve el historial (RLS)"           "$(cuerpo length)" "0"

echo
echo "TOTAL: $((OK+FALLO)) pruebas, $OK OK, $FALLO FALLO"
[ "$FALLO" -eq 0 ]
