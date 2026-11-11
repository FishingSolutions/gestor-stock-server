#!/usr/bin/env bash
# =====================================================================
# Pruebas por la API (igual que el front) de la importación de productos
# desde Excel: Edge Function `importar-productos` + rpc('importar_productos').
#
# SOLO BASE LOCAL. Antes:
#   npx supabase start -x realtime,storage-api,imgproxy,mailpit,studio,logflare,vector,supavisor,postgres-meta
#   npx supabase db reset --local --no-seed
#   docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/datos_demo.sql
#   npm install   (las planillas de prueba se generan con la librería xlsx)
# =====================================================================
set -u
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY)=')"
OK=0; FALLO=0
TMP=$(mktemp)
DIR=supabase/pruebas/.planillas_tmp
mkdir -p "$DIR"
trap 'rm -rf "$DIR" "$TMP"' EXIT

check() {
  if [ "$2" = "$3" ]; then OK=$((OK+1)); printf 'OK    %-60s %s\n' "$1" "$2"
  else FALLO=$((FALLO+1)); printf 'FALLO %-60s obtenido=%s esperado=%s\n' "$1" "$2" "$3"; fi
}
campo() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){if(k)v=v?.[k]}console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("NO-JSON")}})' "$1"; }
cuerpo() { campo "$1" < "$TMP"; }
token() { printf '{"email":"%s","password":"demo-local-123"}' "$1" | curl -s "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H "Content-Type: application/json" --data-binary @- | campo access_token; }
FN="$API_URL/functions/v1/importar-productos"
subir() {  # token, archivo [, nombre con el que se sube]
  curl -s -o "$TMP" -w '%{http_code}' -X POST "$FN" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" \
       -F "archivo=@$2;filename=${3:-$(basename "$2")}"
}
rest() { curl -s -o "$TMP" -w '%{http_code}' "$API_URL/rest/v1/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H "Content-Type: application/json" ${3:+-X POST --data-binary "$3"}; }

ADMIN=$(token admin@stockfx.com); EMP=$(token empleado@stockfx.com)
[ ${#ADMIN} -gt 20 ] && [ ${#EMP} -gt 20 ] || { echo "No se pudo iniciar sesión con los usuarios de demo"; exit 1; }

# ---- Planillas de prueba -------------------------------------------------
node --input-type=module - "$DIR" <<'JS'
import XLSX from 'xlsx'
import { writeFileSync } from 'node:fs'
const dir = process.argv[2]
const guardar = (nombre, filas, opciones = {}) => {
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), 'Productos')
  // (con import, SheetJS no escribe archivos solo: se genera en memoria y se guarda)
  writeFileSync(`${dir}/${nombre}`, XLSX.write(libro, { type: 'buffer', bookType: 'xlsx', ...opciones }))
}
const T = ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio']
guardar('formatos.xlsx', [
  ['Planilla de stock - Almacén Don Pepe'],                 // título arriba del encabezado
  [],
  ['SKU', 'Producto', 'Rubro', 'Cantidad', 'PVP', 'Precio compra'],   // alias
  ['F001', 'Galletitas surtidas', 'almacén', '15.000', '$ 1.500,50', '1.000'],
  ['F002', '  Fideos   moño  ', 'ALMACÉN', 3, 899.999, ''],
  ['coca500', 'Coca repetida en minúscula', 'Bebidas', 1, 10],         // ya existe COCA500
])
guardar('sin-precio.xlsx', [['Codigo', 'Descripcion', 'Stock'], ['X1', 'Algo', 1]])
guardar('vieja.xls', [T, ['V001', 'Producto en .xls', 'Varios', 2, 100]], { bookType: 'biff8' })
writeFileSync(`${dir}/no-es-excel.xlsx`, 'Codigo,Descripcion,Stock,Precio\nZ1,Trucho,1,1\n')
writeFileSync(`${dir}/datos.csv`, 'Codigo,Descripcion,Stock,Precio\nZ1,Trucho,1,1\n')
JS
EJ=docs/importar-productos/ejemplos

echo "=============== QUIÉN PUEDE IMPORTAR ==============="
check "Sin login"                                   "$(subir "$ANON_KEY" $EJ/productos-ejemplo.xlsx)" 401
check "EMPLEADO"                                    "$(subir "$EMP" $EJ/productos-ejemplo.xlsx)" 403
check "  mensaje"                                   "$(cuerpo error.mensaje)" "Solo un administrador puede importar productos."
check "EMPLEADO llamando a la función SQL directo"  "$(rest "$EMP" rpc/importar_productos '{"p_productos":[],"p_archivo":"x.xlsx"}')" 400
check "  mensaje"                                   "$(cuerpo message)" "Solo un administrador puede importar productos"
check "ADMIN descarga la plantilla"                 "$(curl -s -o "$TMP" -w '%{http_code}' "$FN" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ADMIN")" 200
check "  es un .xlsx (empieza con PK)"              "$(head -c 2 "$TMP")" "PK"

echo; echo "=============== PLANILLA CON ERRORES (ejemplo del repo) ==============="
check "ADMIN importa productos-con-errores.xlsx"    "$(subir "$ADMIN" $EJ/productos-con-errores.xlsx)" 200
check "  estado"                                    "$(cuerpo estado)" "COMPLETADA_CON_ERRORES"
check "  procesados / importados"                   "$(cuerpo resumen.registrosProcesados)/$(cuerpo resumen.productosImportados)" "9/2"
check "  filas con error / errores"                 "$(cuerpo resumen.registrosConError)/$(cuerpo resumen.erroresEncontrados)" "7/7"
check "  filas vacías ignoradas"                    "$(cuerpo resumen.filasVacias)" "1"
check "  importados (fila:código)"                  "$(cuerpo importados | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(i=>i.fila+":"+i.codigo).join(",")))')" "2:P001,7:P005"
check "  error stock negativo (fila 3)"             "$(cuerpo errores.0.mensaje)" "El stock no puede ser negativo."
check "  error repetido en el archivo (fila 8)"     "$(cuerpo errores | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(e=>e.fila===8).mensaje))')" 'El código "P005" está repetido en el archivo (ya aparece en la fila 7).'
check "  error stock con decimales (fila 11)"       "$(cuerpo errores | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(e=>e.fila===11).campo))')" "stock"

echo; echo "=============== PLANILLA DE EJEMPLO (8 productos, 2 ya cargados) ==============="
check "ADMIN importa productos-ejemplo.xlsx"        "$(subir "$ADMIN" $EJ/productos-ejemplo.xlsx)" 200
check "  importados / errores"                      "$(cuerpo resumen.productosImportados)/$(cuerpo resumen.erroresEncontrados)" "6/2"
check "  P001 ya existía"                           "$(cuerpo errores.0.mensaje)" 'El código "P001" ya existe en el sistema.'
check "  categorías nuevas"                         "$(cuerpo resumen.categoriasNuevas)" '["Impresoras","Monitores","Muebles","Notebooks"]'
rest "$ADMIN" "v_producto?codigo=eq.P003&select=nombre,categoria,stock_actual,precio_venta,stock_minimo,activo,estado_stock" >/dev/null
check "  P003 guardado bien"                        "$(cuerpo 0)" '{"nombre":"Monitor Samsung 24\"","categoria":"Monitores","stock_actual":12,"precio_venta":185000,"stock_minimo":0,"activo":true,"estado_stock":"NORMAL"}'
check "Importar la misma planilla otra vez"         "$(subir "$ADMIN" $EJ/productos-ejemplo.xlsx)" 200
check "  no carga nada (RECHAZADA, 8 errores)"      "$(cuerpo estado)/$(cuerpo resumen.productosImportados)/$(cuerpo resumen.erroresEncontrados)" "RECHAZADA/0/8"

echo; echo "=============== FORMATOS DE PLANILLA ==============="
check "Título arriba, alias de columnas, números AR" "$(subir "$ADMIN" $DIR/formatos.xlsx)" 200
check "  importados / errores"                      "$(cuerpo resumen.productosImportados)/$(cuerpo resumen.erroresEncontrados)" "2/1"
check "  'coca500' choca con COCA500 (mayúsculas)"  "$(cuerpo errores.0.mensaje)" 'El código "coca500" ya existe en el sistema.'
check "  columna ignorada"                          "$(cuerpo archivo.columnasIgnoradas)" '[]'
check "  fila del encabezado"                       "$(cuerpo archivo.filaEncabezado)" "3"
rest "$ADMIN" "v_producto?codigo=in.(F001,F002)&select=codigo,nombre,categoria,stock_actual,precio_venta,precio_costo&order=codigo" >/dev/null
check "  '15.000' / '\$ 1.500,50' / '1.000'"        "$(cuerpo 0.stock_actual)/$(cuerpo 0.precio_venta)/$(cuerpo 0.precio_costo)" "15000/1500.5/1000"
check "  categoría existente sin importar acentos"  "$(cuerpo 0.categoria)/$(cuerpo 1.categoria)" "Almacén/Almacén"
check "  espacios limpios y precio redondeado"      "$(cuerpo 1.nombre)/$(cuerpo 1.precio_venta)" "Fideos moño/900"
check "Excel viejo (.xls)"                          "$(subir "$ADMIN" $DIR/vieja.xls)/$(cuerpo resumen.productosImportados)" "200/1"

echo; echo "=============== ARCHIVOS INVÁLIDOS ==============="
check "Falta la columna Precio"                     "$(subir "$ADMIN" $DIR/sin-precio.xlsx)/$(cuerpo error.codigo)" "400/COLUMNAS_FALTANTES"
check "  mensaje"                                   "$(cuerpo error.mensaje)" "A la planilla le falta la columna: Precio."
check "  queda en el historial"                     "$([ "$(cuerpo idImportacion)" != "null" ] && echo si || echo no)" si
check "Texto disfrazado de .xlsx"                   "$(subir "$ADMIN" $DIR/no-es-excel.xlsx)/$(cuerpo error.codigo)" "400/ARCHIVO_ILEGIBLE"
check "Archivo .csv"                                "$(subir "$ADMIN" $DIR/datos.csv)/$(cuerpo error.codigo)" "415/TIPO_NO_PERMITIDO"
check "Sin archivo"                                 "$(curl -s -o "$TMP" -w '%{http_code}' -X POST "$FN" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ADMIN" -F 'otro=1')/$(cuerpo error.codigo)" "400/SIN_ARCHIVO"

echo; echo "=============== DEFENSA EN LA BASE (llamada directa a la función SQL) ==============="
check "ADMIN manda un producto con precio 0"        "$(rest "$ADMIN" rpc/importar_productos '{"p_productos":[{"fila":2,"codigo":"Q1","nombre":"Trucho","stock":1,"precio":0}],"p_archivo":"api.xlsx"}')/$(cuerpo resumen.productosImportados)" "200/0"
check "  mensaje"                                   "$(cuerpo errores.0.mensaje)" "El precio tiene que ser mayor que cero."
check "ADMIN manda stock con decimales"             "$(rest "$ADMIN" rpc/importar_productos '{"p_productos":[{"fila":2,"codigo":"Q2","nombre":"Trucho","stock":1.5,"precio":1}],"p_archivo":"api.xlsx"}')/$(cuerpo errores.0.campo)" "200/stock"

echo; echo "=============== HISTORIAL ==============="
rest "$ADMIN" "importacion_producto?select=archivo,estado,productos_importados&order=id_importacion" >/dev/null
check "ADMIN ve el historial (9 importaciones)"     "$(cuerpo length)" "9"
check "  primera"                                   "$(cuerpo 0.archivo)/$(cuerpo 0.estado)/$(cuerpo 0.productos_importados)" "productos-con-errores.xlsx/COMPLETADA_CON_ERRORES/2"
rest "$ADMIN" "importacion_producto_error?select=numero_fila,mensaje&limit=1&order=id_error" >/dev/null
check "  detalle de errores guardado"               "$(cuerpo 0.numero_fila)" "3"
check "EMPLEADO no ve el historial"                 "$(rest "$EMP" "importacion_producto?select=id_importacion")/$(cuerpo length)" "200/0"

echo
echo "TOTAL: $((OK+FALLO)) pruebas, $OK OK, $FALLO FALLO"
