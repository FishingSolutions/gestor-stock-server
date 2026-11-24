# Importar productos con IA

Importación de productos desde Excel en **dos pasos**: primero se muestra una vista previa de lo
que va a pasar y recién cuando el administrador confirma se escribe, todo en **una sola
transacción**. La IA se usa únicamente para **interpretar los encabezados** de la planilla; los
datos (códigos, precios, cantidades) salen siempre del archivo.

> Esta funcionalidad **no modifica** el importador anterior (`importar-productos`) ni sus tablas:
> convive con él. Tampoco cambia RLS, `registrar_movimiento` ni la forma de crear productos.

---

## 1. Cómo funciona

```
Front (React)                                          Supabase
┌────────────────────────────┐
│ Botón "Importar con IA"    │
│ Modal de vista previa      │  1. POST accion=analizar
│  · mapeo de columnas       │ ───────────────────────▶ Edge Function importar-productos-ia
│  · modo de stock           │                          · lee el Excel
│  · filas ambiguas          │                          · mapea columnas (alias + IA)
│  · resumen                 │                          · clasifica filas contra el inventario
└────────────────────────────┘ ◀─────────────────────── · NO escribe nada
             │
             │  2. POST accion=confirmar (archivo + decisiones + clave)
             ▼
                          Edge Function ── rpc('confirmar_importacion_productos') ──▶ PostgreSQL
                                                                                      · revalida todo
                                                                                      · aplica en 1 transacción
                                                                                      · guarda historial y detalle
```

**Por qué así:** leer Excel no se puede hacer en SQL (lo hace la Edge Function en Deno) y aplicar el
lote con garantías de atomicidad, idempotencia y permisos es trabajo de la base (lo hace la función
SQL). La Edge Function corre **con la sesión del usuario**, nunca con `service_role`.

### Archivos

| Archivo | Qué hace |
|---|---|
| `supabase/functions/importar-productos-ia/index.ts` | Edge Function: auth, límites, acciones `analizar` y `confirmar` |
| `supabase/functions/_shared/importacion/tipos.ts` | Tipos y campos soportados |
| `supabase/functions/_shared/importacion/texto.ts` | Normalización de textos y números argentinos |
| `supabase/functions/_shared/importacion/excel.ts` | Lector de Excel, detección de encabezado y límites |
| `supabase/functions/_shared/importacion/mapeo.ts` | Alias deterministas y validación del JSON de la IA |
| `supabase/functions/_shared/importacion/filas.ts` | Interpretación y validación de cada fila |
| `supabase/functions/_shared/importacion/coincidencias.ts` | Cruce con el inventario y clasificación |
| `supabase/functions/_shared/importacion/ia.ts` | Llamada OpenAI-compatible, enmascarado y timeout |
| `supabase/functions/_shared/importacion/datos.ts` | Lectura paginada de productos y categorías (RLS) |
| `supabase/migrations/20261118201500_importacion_ia.sql` | Columnas de historial, tabla de detalle y RPC |
| `gestor-stock-client/src/components/products/ImportProductsModal/` | Modal, dropzone, mapeo y tabla de vista previa |
| `gestor-stock-client/src/features/import/services/importService.js` | Cliente de la Edge Function |
| `gestor-stock-client/src/features/import/utils/xlsx.js` | Generador mínimo de `.xlsx` (sin librerías pesadas) |
| `gestor-stock-client/src/features/import/utils/exportProducts.js` | Exportación real y plantilla |
| `gestor-stock-client/src/features/import/utils/importStatus.js` | Etiquetas, formato y resumen de la vista previa |

---

## 2. Puesta en marcha

### 2.1 Base de datos

Aplicar la migración nueva:

```bash
cd gestor-stock-server
npx supabase db push          # proyecto remoto
# o, en local:
npx supabase migration up
```

La migración es **aditiva**:

* agrega columnas al historial (`idempotency_key`, `hash_archivo`, `hash_operacion`, `modo_stock`, contadores, `ia_*`);
* crea `importacion_producto_fila` (detalle por fila, RLS solo admin);
* crea `confirmar_importacion_productos(...)`.

### 2.2 Edge Function

```bash
cd gestor-stock-server
npx supabase functions deploy importar-productos-ia
```

No hace falta `--no-verify-jwt`: la función valida la sesión y además el rol ADMINISTRADOR.

### 2.3 Variables de entorno (secretos de la función)

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `AI_API_KEY` | no | — | Clave del proveedor. Sin ella, el importador funciona con alias y avisa `IA_NO_CONFIGURADA`. |
| `AI_BASE_URL` | sí, junto con la clave | — | Endpoint HTTPS compatible con OpenAI, elegido según el proveedor. |
| `AI_MODEL` | sí, junto con la clave | — | Identificador del modelo habilitado en la cuenta/proveedor. No hay modelo predeterminado. |
| `AI_TIMEOUT_MS` | no | `15000` | Timeout limitado a 1.000–30.000 ms. Valores inválidos usan el valor predeterminado. |
| `AI_MAX_SAMPLE_ROWS` | no | `10` | Muestras limitadas a 1–10 filas. Valores inválidos usan el máximo seguro (10). |
| `IMPORTACION_IA_SIGNING_SECRET` | sí | — | Secreto aleatorio de al menos 32 caracteres para firmar el vínculo persistido entre análisis y confirmación. Requerido también cuando se usa el fallback determinista. |

Ejemplo de configuración con un endpoint de Google Gemini compatible con OpenAI (confirmá en AI Studio que el modelo indicado esté habilitado en tu cuenta):

1. Crear una clave en [Google AI Studio](https://aistudio.google.com/apikey).
2. Guardar los secretos:

```bash
npx supabase secrets set \
  AI_API_KEY=tu_clave \
  AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
  AI_MODEL=MODELO_DISPONIBLE_EN_TU_CUENTA \
  IMPORTACION_IA_SIGNING_SECRET="$(openssl rand -hex 32)"
```

Si falta la clave, el endpoint o el modelo, la función no llama a un proveedor y usa el mapeo
determinista. El mismo fallback aplica si hay timeout, error HTTP o respuesta inválida.

La URL del proveedor se limita a `https://generativelanguage.googleapis.com/v1beta/openai`
(Gemini) y `https://api.openai.com/v1`; se rechazan credenciales, parámetros, puertos
alternativos y redirecciones. Para habilitar otro proveedor se requiere revisar y ampliar
explícitamente esta allowlist en código.

#### Revisión manual de seguridad de Supabase

La revisión del código no permite verificar la configuración del proyecto remoto. Antes de
desplegar, el responsable debe confirmar en Supabase Auth que las cuentas administradoras tengan
MFA y políticas de contraseña acordes al riesgo, y que la vigencia de los JWT sea la esperada.
Este cambio no modifica usuarios ni configuración de Auth.

No se detectaron secretos reconocibles en archivos versionados durante el escaneo local. Si una
clave del proveedor IA o `IMPORTACION_IA_SIGNING_SECRET` estuvo expuesta, rotarla manualmente en
Supabase Edge Function Secrets y en el proveedor, y revisar los logs. El escaneo local no demuestra
que nunca haya existido exposición histórica.

El límite de consumo es de 20 reservas por día calendario de `America/Argentina/Buenos_Aires`,
compartido por todos los administradores del proyecto y contabilizado al iniciar cada solicitud.
Si falta la configuración del proveedor, no se reserva cupo. Si falla la reserva o el registro
persistente del análisis, Gemini no se invoca. La Edge Function usa `SUPABASE_SERVICE_ROLE_KEY`
solo para el contador y registro privado; las lecturas y escrituras de inventario siguen usando el
JWT del administrador.
Si falla la finalización después de llamar a Gemini, el resultado del análisis se conserva y la
reserva queda contabilizada. Para marcar reservas colgadas de más de
10 minutos como `TIMEOUT` sin liberar cupo, un operador puede invocar manualmente
`public.recuperar_solicitudes_ia_abandonadas()` con `service_role`; no hay un job automático.

Cada análisis tiene un UUID persistido y queda vinculado atómicamente a la primera confirmación
exitosa. La misma clave de idempotencia y huella puede reintentarse, incluso tras vencer el token;
otro uso requiere un nuevo análisis. Un reanálisis con mapeo corregido actualiza el contexto del
análisis antes de la confirmación.
Las vistas previas nunca confirmadas pueden limpiarse manualmente con
`public.limpiar_analisis_ia_expirados()` (`service_role`); conserva los vínculos del historial.

La importación tradicional sigue disponible por separado mediante la Edge Function
`importar-productos` y su RPC `importar_productos`. Esta ruta no consume ni confirma análisis IA:
solo inserta productos nuevos, valida el rol de administrador en Edge y SQL, valida campos y
registra su propio historial. No se revocan sus permisos como parte del despliegue IA.

Para probar en local, crear `supabase/functions/.env` con las variables anteriores.

### 2.4 Cliente

```bash
cd gestor-stock-client
npm install
npm run dev
```

`fflate` ya está agregado a `package.json`; es la única dependencia nueva y se usa solo para armar
el `.xlsx` de exportación/plantilla en el navegador.

---

## 3. Reglas de la planilla

### Columnas reconocidas

Se comparan sin acentos, mayúsculas ni signos. Algunos alias:

| Campo | Alias habituales |
|---|---|
| Código | `codigo`, `cod`, `sku`, `referencia`, `codigo interno` |
| Descripción | `nombre`, `descripcion`, `producto`, `articulo` |
| Detalle | `detalle`, `observaciones`, `notas`, `descripcion larga` |
| Categoría | `categoria`, `rubro`, `familia`, `grupo` |
| Stock | `stock`, `cantidad`, `existencias`, `unidades` |
| Precio de venta | `precio`, `precio venta`, `pvp`, `importe`, `precio lista` |
| Precio de costo | `costo`, `precio costo`, `precio compra` |
| Stock mínimo / máximo | `stock minimo`, `minimo`, `stock maximo`, `maximo` |
| Activo | `activo`, `habilitado`, `vigente`, `estado` |

* La **primera fila con al menos dos nombres conocidos** se toma como encabezado, así que puede
  haber un título arriba o filas en blanco.
* Las columnas desconocidas se ignoran y se informan.
* Si no se reconoce **código** o **descripción**, el modal pide corregir el mapeo a mano.

### Celdas vacías

Una celda vacía significa **“no tocar ese dato”**, nunca “poner cero”:

| Celda vacía | Resultado |
|---|---|
| Stock | No se modifica el stock del producto existente. En un producto nuevo queda en 0. |
| Precio / costo | No se modifica. En un producto nuevo el precio es obligatorio. |
| Categoría | Se conserva la categoría actual. |
| Detalle | Se conserva el detalle actual. |
| Stock mínimo / máximo | Se conservan los valores actuales. |
| Activo | Se conserva el estado actual. |

### Números

Se aceptan formatos argentinos e internacionales: `15000`, `15.000`, `1.500,50`, `$ 1.500,50`,
`1,234.56`, `ARS 300`. El stock tiene que ser un entero, 0 o más. El precio, mayor que cero.

### Fórmulas

Un valor que empieza con `=` se rechaza como **código**, **descripción**, **detalle** o
**categoría** (`El código no puede ser una fórmula.`). Al exportar, todo se escribe como texto
literal, así que Excel nunca ejecuta una fórmula inyectada.

### Códigos

* Se conservan como **texto**: `0001` no se convierte en `1`.
* No se distinguen mayúsculas para buscar coincidencias (`coca500` encuentra `COCA500`), pero el
  producto creado conserva el código tal como vino en el archivo.
* Un código repetido **dentro del archivo** marca la segunda aparición como inválida.
* Un código que ya existe no se duplica: se actualiza el producto.

---

## 4. Vista previa y clasificación

Cada fila queda en uno de estos estados:

| Estado | Significado |
|---|---|
| **Nuevo** | El código no existe: se crea el producto. |
| **Existente** | El código existe y hay cambios: se actualiza. |
| **Sin cambios** | El código existe y no hay nada distinto: no se escribe. |
| **Revisar** | El nombre se parece mucho a un producto existente pero el código es nuevo. |
| **Inválida** | Tiene un error de datos: no se puede importar. |

### Coincidencias ambiguas

Se comparan los nombres (sin acentos, mayúsculas ni signos). Si el nombre es muy parecido a un
producto existente y el código es nuevo, **no se decide solo**: el administrador elige

1. **Vincular** a uno de los productos sugeridos (se actualiza ese producto, conserva su código), o
2. **Crear** un producto nuevo con el código del archivo, o
3. **Excluir** la fila.

La búsqueda es local: **el inventario no se manda a la IA**.

### Modo de stock (obligatorio)

Si la planilla tiene columna de stock, hay que elegir explícitamente:

| Modo | Producto existente | Movimiento |
|---|---|---|
| **Reemplazar existencias** | El stock pasa a ser el de la planilla | `AJUSTE` con el stock contado |
| **Sumar existencias** | La cantidad de la planilla se suma | `ENTRADA` con la cantidad |

* Producto nuevo: se inserta en 0 y el stock inicial se registra como `ENTRADA`.
* Sumar 0 no genera movimiento.
* Un producto **dado de baja** no recibe stock, salvo que la misma fila lo reactive (`Activo = SI`).
* Nunca se escribe `stock_actual` a mano: todo pasa por `registrar_movimiento`.

### Archivos parcialmente inválidos

La importación es **todo o nada**:

* En la vista previa, las filas inválidas vienen desmarcadas y no se pueden confirmar.
* Si el administrador las excluye, el resto se importa normalmente.
* Si se manda una fila inválida a confirmar, la base rechaza **todo el lote**, no escribe nada y
  deja el intento como `RECHAZADA` (con las filas con error) para poder corregir.

---

## 5. Seguridad y límites

### Permisos

* Solo un **ADMINISTRADOR activo** puede importar. Se valida en la Edge Function y otra vez en la
  función SQL.
* La Edge Function usa el JWT del usuario y la `anon key`; **nunca** `service_role`.
* RLS sigue activo: la lectura del inventario y la escritura pasan por las mismas políticas de
  siempre. El detalle por fila (`importacion_producto_fila`) solo lo puede leer un administrador.
* La RPC es `security definer` (necesita escribir productos y movimientos), pero valida el rol
  adentro y está revocada para `anon`.

### Archivos

| Límite | Valor |
|---|---|
| Tamaño | 5 MB |
| Filas | 2.000 |
| Columnas | 60 |
| Formatos | `.xlsx` y `.xls` (se verifica la firma real del archivo, no la extensión) |
| Hojas | La primera, o la que se indique |
| Fila de encabezado | Se busca en las primeras 15 filas |

También se rechazan archivos vacíos, corruptos, con contraseña o con más filas de las permitidas.

### IA: qué se manda y qué no

* Se hace **una sola llamada por archivo**, no una por fila.
* Los encabezados y hasta 10 filas de muestra se usan para inferir tipos de columna.
* De las filas no salen valores comerciales: números, fechas, booleanos y textos se reemplazan por
  `<numero>`, `<fecha>`, `<booleano>` y `<texto>`. Los únicos valores reales enviados son los
  nombres de encabezado.
* Las celdas se declaran explícitamente como **datos, no instrucciones** (defensa ante *prompt
  injection*).
* Todo lo que devuelve el modelo se valida: campo existente, índice en rango y columna no repetida.
  Si algo no cumple, se descarta y se avisa.
* Si no hay clave, se agota la cuota (429), hay timeout o el JSON es inválido, se sigue con el
  mapeo por encabezados y se muestra el motivo. **Nunca se finge que se usó IA.**

### Idempotencia y atomicidad

* El cliente genera una **clave única** al empezar y la manda al confirmar.
* PostgreSQL calcula una huella SHA-256 determinista de la operación final: contenido del archivo,
  hoja, mapeo, decisiones, modo, creación de categorías y filas/valores definitivos.
* Reintentar una operación equivalente con la misma clave devuelve el resultado anterior
  (`repetida: true`) sin duplicar productos ni movimientos.
* Reutilizar la clave cambiando cualquier parte de la operación devuelve
  `409 IDEMPOTENCIA_CONFLICTO`.
* Si el lote se rechaza, la clave **no se consume**: se puede corregir y reintentar.
* Toda la aplicación del lote ocurre en una transacción: si una fila falla, no se aplica ninguna.

---

## 6. Exportación y plantilla

* El botón **Exportar** descarga exactamente lo que se está viendo (búsqueda, categoría, estado y
  orden) y usa las mismas columnas que entiende el importador.
* **Descargar plantilla** (dentro del modal) genera un archivo con las columnas y dos filas de
  ejemplo.
* Los códigos y textos se escriben como `inlineStr`, es decir, **siempre texto**: `0001` conserva
  los ceros y `=SUM(A1)` no se ejecuta.
* Si no hay productos para exportar, se muestra un aviso; no se descarga un archivo vacío.

---

## 7. Pruebas

### Unitarias (sin base ni red)

```bash
cd gestor-stock-server && npm test     # 37 pruebas: texto, mapeo, filas, coincidencias, IA
cd gestor-stock-client && npm test     # 20 pruebas: xlsx, exportación, estados y resumen
cd gestor-stock-client && npm run lint
cd gestor-stock-client && npm run build
```

Cubren, entre otras cosas:

* números argentinos, moneda y separadores;
* alias de columnas y rechazo del JSON inválido de la IA;
* filas nuevas, existentes, sin cambios, ambiguas e inválidas;
* enmascarado de datos y tope de muestras;
* archivos `.xlsx` reales con códigos como texto y sin fórmulas;
* exportación y plantilla compatibles con el importador.

### SQL (defensa en la base)

```bash
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres \
  < supabase/pruebas/pruebas_importacion_ia.sql
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres \
  < supabase/pruebas/pruebas_solicitud_ia.sql
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres \
  < supabase/pruebas/pruebas_trazabilidad_importacion.sql
```

Verifica rol, atomicidad, rechazo de lotes inválidos, `SUMAR`/`REEMPLAZAR`, altas con stock,
idempotencia y RLS. Las nuevas pruebas cubren permisos de RPC, cuota, vínculo persistente,
hojas/mapas/usuarios distintos, replay idempotente y expiración. Todo corre en transacciones con
`ROLLBACK`.

### API / End-to-End

```bash
cd gestor-stock-server
npx supabase start -x realtime,storage-api,imgproxy,mailpit,studio,logflare,vector,supavisor,postgres-meta
npx supabase db reset --local --no-seed
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/datos_demo.sql
bash supabase/pruebas/prueba_importacion_ia.sh
```

La función local necesita `IMPORTACION_IA_SIGNING_SECRET` en
`supabase/functions/.env` (se admite no configurar Gemini para probar el fallback determinista).
La concurrencia del vínculo se prueba por separado con una base local disponible:

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
bash supabase/pruebas/prueba_trazabilidad_concurrente.sh
```

Cubre 40+ casos por HTTP: permisos, vista previa sin escrituras, archivos inválidos, alta,
idempotencia, suma/reemplazo de stock, ambigüedades (vincular/crear), exclusiones, categorías,
duplicados, fórmulas, códigos con ceros e historial.

---

## 8. Prueba manual

1. Aplicar la migración y desplegar la función.
2. Entrar como administrador (`admin@stockfx.com` en local).
3. En **Productos**, tocar **Exportar** y verificar que se descarga un `.xlsx` con el inventario.
4. Abrir el archivo, cambiar un precio y el stock de un producto, y guardar.
5. Tocar **Importar con IA** y elegir el archivo.
6. Revisar el mapeo, elegir **Reemplazar existencias** o **Sumar existencias** y mirar la vista
   previa.
7. Confirmar. Debe aparecer el resumen y el stock debe haber cambiado.
8. Repetir la confirmación: debe decir que ya estaba aplicada y no duplicar nada.
9. Probar un archivo con una fila inválida: el modal no deja confirmar hasta excluirla o corregirla.
10. Cerrar sesión con un empleado: el botón **Importar con IA** no aparece.

---

## 9. Limitaciones conocidas

* **Tope diario de IA aproximado:** se cuentan las importaciones confirmadas con IA del día. Si se
  analizan muchos archivos sin confirmar, el tope puede tardar en reflejarlo; igualmente Gemini
  aplica su propia cuota y el 429 se maneja bien.
* **El borrado lógico no se revierte:** un código que pertenece a un producto eliminado no se puede
  volver a crear hasta restaurarlo o usar otro código. El mensaje lo explica.
* **No hay “deshacer”:** para revertir una importación hay que corregir el stock con un ajuste o
  volver a importar la planilla anterior.
* **El modo de stock aplica a todo el lote:** no se puede reemplazar para unas filas y sumar para
  otras en la misma importación.
* **Las categorías nuevas no se crean solas:** hay que marcar la opción en el modal; si no, el lote
  se rechaza y no se escribe nada.
* **La IA no se usa para detectar duplicados ni para completar datos:** solo para mapear columnas.
* **No se corrigen en esta rama** los RPC heredados `ajustar_stock` y `registrar_stock_inicial`
  (tienen firmas desactualizadas en el cliente). La importación no los usa: usa
  `registrar_movimiento`.
