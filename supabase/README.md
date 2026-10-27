# Base de datos de StockFX (Supabase)

El backend de StockFX es una base PostgreSQL en Supabase. Todo cambio a la base se guarda acá como **migración**: un archivo `.sql` que se revisa en un PR como cualquier otro código.

> **Reglas del equipo**
> - Nunca commitear a `main`. Cada uno trabaja en su rama y abre PR.
> - Los cambios a la base se hacen con migraciones, no a mano en el dashboard.
> - `npx supabase db push` (aplicar a Supabase) solo después de que el PR esté aprobado y mergeado.
> - **Nunca** correr `npx supabase db reset --linked`: borra la base real del equipo. `reset` solo con `--local`.

---

## Índice

1. [Qué hay en esta carpeta](#qué-hay-en-esta-carpeta)
2. [Preparar tu compu (una sola vez)](#preparar-tu-compu-una-sola-vez)
3. [Esquema de la base](#esquema-de-la-base)
4. [Roles y permisos](#roles-y-permisos)
5. [API para el front](#api-para-el-front)
6. [Usuarios y login](#usuarios-y-login)
7. [Cómo hacer un cambio en la base](#cómo-hacer-un-cambio-en-la-base)
8. [Probar en la base local](#probar-en-la-base-local)
9. [Problemas conocidos y soluciones](#problemas-conocidos-y-soluciones)
10. [Historial de migraciones](#historial-de-migraciones)
11. [Registro de trabajo](#registro-de-trabajo)
12. [Pendientes](#pendientes)

---

## Qué hay en esta carpeta

```
supabase/
├── config.toml              Configuración de la CLI (no tiene claves)
├── migrations/              Cambios a la base, en orden de fecha
│   ├── 20261026155217_remote_schema.sql          Esquema tal como estaba en Supabase (KAN-39, 40, 41)
│   ├── 20261026161316_correcciones_esquema.sql   Permisos, RLS, login y protección del historial
│   └── 20261027122541_registrar_movimiento.sql   KAN-37: función para registrar movimientos
├── pruebas/
│   ├── simular_base_actual.sql            Carga datos de ejemplo como los de Supabase
│   ├── pruebas_permisos.sql               17 pruebas de roles, permisos y borrados
│   ├── pruebas_registrar_movimiento.sql   19 pruebas de la función registrar_movimiento
│   └── prueba_ventas_simultaneas.sh       Dos ventas al mismo tiempo: el stock nunca queda negativo
└── .temp/                   Datos locales de la CLI (NO se sube, está en .gitignore)
```

`database/schema.sql` (rama `feature/database`) quedó desactualizado: la base real tiene otros nombres de columnas y tipos de ID. **La fuente de verdad son las migraciones de esta carpeta.**

---

## Preparar tu compu (una sola vez)

### Requisitos
- **Node.js** (ya lo usa el proyecto).
- **Docker Desktop**, abierto y con "Engine running". Lo necesitan `db pull` y la base local.
  - En Windows usa WSL 2. Si el instalador dice que falta "Virtual Machine Platform", correr `wsl --install` en PowerShell como administrador y reiniciar.
  - Necesita espacio en disco: dejar **al menos 10 GB libres** en C:.
- Una **cuenta de Supabase que sea miembro del proyecto**. Si no lo es, pedirle al dueño que te invite en *Organization → Team → Invite*.

### Pasos
La CLI de Supabase ya está en `devDependencies`, así que alcanza con:

```bash
npm install
npx supabase login
npx supabase link --project-ref dcsudaeolwqnatkogkbj
```

- `login` abre el navegador. Fijate de estar con la cuenta correcta (si tenés otra abierta, usá una ventana de incógnito). Pegá en la terminal **solo** el código de 8 caracteres que te muestra.
- `link` puede pedir la contraseña de la base: está en *Project Settings → Database*.
- El login y el link quedan guardados **solo en tu compu**. Cada integrante hace los suyos; no se comparten cuentas por el repo.

---

## Esquema de la base

### `categoria`
| Columna | Tipo | Notas |
|---|---|---|
| `id_categoria` | uuid | PK, se genera solo |
| `nombre` | varchar(100) | obligatorio, único |
| `descripcion` | text | opcional |

### `producto`
| Columna | Tipo | Notas |
|---|---|---|
| `id_producto` | bigint | PK, número autoincremental |
| `codigo` | varchar(50) | obligatorio, único |
| `nombre` | varchar(150) | obligatorio |
| `descripcion` | text | opcional |
| `precio_costo` | numeric(12,2) | ≥ 0, por defecto 0 |
| `precio_venta` | numeric(12,2) | ≥ 0, por defecto 0 |
| `stock_actual` | integer | ≥ 0 (nunca negativo) |
| `stock_minimo` | integer | ≥ 0 |
| `stock_maximo` | integer | ≥ `stock_minimo` |
| `activo` | boolean | `false` = dado de baja |
| `id_categoria` | uuid | FK a `categoria`; si se borra la categoría queda en null |

### `movimiento_stock`
| Columna | Tipo | Notas |
|---|---|---|
| `id_movimiento` | bigint | PK, autoincremental |
| `id_producto` | bigint | FK a `producto`, obligatorio |
| `id_usuario` | uuid | FK a `usuario`, **obligatorio** |
| `tipo_movimiento` | varchar(20) | `ENTRADA`, `SALIDA` o `AJUSTE` |
| `cantidad` | integer | > 0 (unidades que entraron, salieron o se ajustaron) |
| `motivo` | text | obligatorio |
| `fecha_movimiento` | timestamptz | se completa sola con la fecha y hora |
| `stock_anterior` | integer | stock del producto antes del movimiento |
| `stock_resultante` | integer | stock del producto después del movimiento |

Los movimientos solo se crean con la función [`registrar_movimiento`](#registrar_movimiento-kan-37).

### `usuario`
| Columna | Tipo | Notas |
|---|---|---|
| `id_usuario` | uuid | PK, es **el mismo id** de la cuenta de login (`auth.users`) |
| `nombre`, `apellido` | varchar(100) | obligatorios |
| `email` | varchar(255) | único |
| `activo` | boolean | `false` = no puede ver nada |
| `rol` | varchar(20) | `ADMINISTRADOR` o `EMPLEADO` (por defecto `EMPLEADO`) |

### Borrados (historial protegido)
- **No se puede borrar un producto que tenga movimientos.** Para sacarlo de la lista se usa `activo = false`.
- **No se puede borrar un usuario que tenga movimientos.** Se desactiva con `activo = false`.
- Los movimientos no se modifican ni se borran: son el historial.

---

## Roles y permisos

La seguridad está en la base con **RLS** (Row Level Security): aunque alguien saltee el front, la base no le deja hacer lo que su rol no permite.

| Acción | Sin login | EMPLEADO | ADMINISTRADOR |
|---|:-:|:-:|:-:|
| Ver productos y categorías | ❌ | ✅ | ✅ |
| Crear / modificar / borrar productos y categorías | ❌ | ❌ | ✅ |
| Ver movimientos | ❌ | ✅ | ✅ |
| Registrar ENTRADA y SALIDA (con `registrar_movimiento`) | ❌ | ✅ | ✅ |
| Registrar AJUSTE (con `registrar_movimiento`) | ❌ | ❌ | ✅ |
| Insertar / modificar / borrar movimientos directo en la tabla | ❌ | ❌ | ❌ |
| Ver usuarios (nombre, email, rol) | ❌ | ✅ | ✅ |
| Cambiar nombre, apellido, rol o activo de un usuario | ❌ | ❌ | ✅ |
| Cambiar id o email de un usuario | ❌ | ❌ | ❌ |

- Un usuario con `activo = false` no ve nada, aunque tenga cuenta.
- La función `public.rol_actual()` devuelve el rol del usuario logueado (o null). Las reglas RLS la usan.
- La clave `service_role` (secreta, solo para servidor) ignora RLS. **Nunca** va en el front ni en el repo.

---

## API para el front

Supabase genera la API sola a partir de las tablas y funciones. El front la usa con la librería `@supabase/supabase-js`, la URL del proyecto y la clave pública (`anon` / `publishable`). **Nunca** usar la clave `service_role` en el front.

### 1. Iniciar sesión (obligatorio)
Sin sesión, todas las consultas dan "permission denied".
```js
const { error } = await supabase.auth.signInWithPassword({ email, password })
```

### 2. Leer datos
```js
// Productos activos con su categoría
const { data: productos } = await supabase
  .from('producto')
  .select('id_producto, codigo, nombre, precio_venta, stock_actual, stock_minimo, categoria(nombre)')
  .eq('activo', true)
  .order('nombre')

// Historial de movimientos con producto y autor
const { data: historial } = await supabase
  .from('movimiento_stock')
  .select('fecha_movimiento, tipo_movimiento, cantidad, stock_anterior, stock_resultante, motivo, producto(nombre), usuario(nombre, apellido)')
  .order('fecha_movimiento', { ascending: false })

// Rol del usuario logueado (para mostrar u ocultar botones)
const { data: rol } = await supabase.rpc('rol_actual')   // 'ADMINISTRADOR', 'EMPLEADO' o null
```

### `registrar_movimiento` (KAN-37)
Es la **única** forma de registrar entradas, salidas y ajustes. Actualiza el stock y guarda el movimiento en un solo paso. Si algo no está bien, no cambia nada.

```js
const { data, error } = await supabase.rpc('registrar_movimiento', {
  p_id_producto: 12,
  p_tipo: 'SALIDA',        // 'ENTRADA' | 'SALIDA' | 'AJUSTE' (mayúsculas o minúsculas)
  p_cantidad: 3,
  p_motivo: 'Venta mostrador'
})

if (error) {
  mostrarAviso(error.message)   // el mensaje ya viene en español, listo para mostrar
} else {
  // data = el movimiento registrado
  // { id_movimiento, id_producto, id_usuario, tipo_movimiento, cantidad, motivo,
  //   fecha_movimiento, stock_anterior, stock_resultante }
}
```

**Parámetros**

| Parámetro | Tipo | Qué es |
|---|---|---|
| `p_id_producto` | número | `id_producto` del producto |
| `p_tipo` | texto | `ENTRADA`, `SALIDA` o `AJUSTE` |
| `p_cantidad` | número entero | ENTRADA / SALIDA: unidades (> 0). AJUSTE: **stock contado** en el depósito (≥ 0) |
| `p_motivo` | texto | obligatorio (ej.: "Venta", "Llegó el proveedor", "Conteo físico") |

**Cómo funciona cada tipo**
- **ENTRADA**: suma `p_cantidad` al stock. Cualquier usuario activo.
- **SALIDA**: resta `p_cantidad`. Si no alcanza el stock, se rechaza. Cualquier usuario activo.
- **AJUSTE**: se informa cuánto se **contó**. La función calcula la diferencia con el sistema, la guarda en `cantidad` y deja el stock igual a lo contado. `stock_anterior` y `stock_resultante` muestran si subió o bajó. Solo ADMINISTRADOR.

**Errores posibles** (`error.message`)

| Mensaje | Cuándo |
|---|---|
| `Stock insuficiente de "<producto>": hay X, se pidieron Y` | SALIDA mayor al stock |
| `La cantidad tiene que ser mayor a 0` | ENTRADA o SALIDA con 0, negativo o vacío |
| `El stock contado no puede ser negativo` | AJUSTE con número negativo |
| `El stock contado es igual al del sistema (X): no hay nada que ajustar` | AJUSTE sin diferencia |
| `Tipo de movimiento inválido: usá ENTRADA, SALIDA o AJUSTE` | tipo desconocido |
| `El motivo es obligatorio` | motivo vacío |
| `El producto no existe` | id inexistente |
| `El producto "<producto>" está dado de baja` | producto con `activo = false` |
| `Solo un administrador puede hacer ajustes de stock` | EMPLEADO intentando AJUSTE |
| `No tenés permiso para registrar movimientos (usuario sin cuenta o inactivo)` | usuario inactivo o sin fila en `usuario` |
| `permission denied for function registrar_movimiento` | no hay sesión iniciada |

**Ventas simultáneas:** la función bloquea el producto mientras registra. Si dos personas venden el mismo producto al mismo tiempo, la segunda espera a la primera y ve el stock ya descontado. Así nunca queda negativo (probado con `pruebas/prueba_ventas_simultaneas.sh`).

---

## Usuarios y login

Cada fila de `usuario` corresponde a una cuenta de login de Supabase (`auth.users`). Un trigger (`al_crear_cuenta_de_login`) mantiene las dos tablas sincronizadas:

- Cuando se crea una cuenta de login, se crea su fila en `usuario` con rol **EMPLEADO**.
- El rol **nunca** se toma de lo que manda quien se registra, para que nadie se haga admin solo. Un ADMINISTRADOR lo cambia después.
- Si ya existía una fila en `usuario` con ese email, se vincula con la cuenta nueva y **conserva su rol**.

### Usuario de prueba para el equipo ✅

| | |
|---|---|
| **Email** | `admin@stockfx.com` |
| **Rol** | ADMINISTRADOR |
| **Contraseña** | Pedírsela a Milagros o buscarla en el grupo del equipo |

> La contraseña **no** se escribe en este repo: es público, y con ese usuario cualquiera podría modificar o borrar los datos de la base.

Cuenta creada el 27/10/2026 y verificada: vinculada con la fila de `usuario`, confirmada y activa.

### Cómo se creó (por si hay que repetirlo con otro usuario)
La fila `admin@stockfx.com` ya estaba en la tabla `usuario`, pero sin cuenta de login. Se creó así:

1. Dashboard → **Authentication → Users → Add user → Create new user**.
2. Email: `admin@stockfx.com`, la contraseña que elija el equipo (Supabase pide **mínimo 6 caracteres**), tildar **Auto Confirm User**.
3. El trigger la vincula sola: queda como ADMINISTRADOR.

La contraseña no se escribe en el repo ni en este README: compartila con el equipo por otro medio.

Opcional, cuando todos los usuarios tengan cuenta: correr en el SQL Editor
`alter table public.usuario validate constraint usuario_id_usuario_fkey;`
(la relación se creó como `NOT VALID` para no fallar con el Admin Prueba que aún no tenía cuenta).

---

## Cómo hacer un cambio en la base

1. Pararte en tu rama:
   ```bash
   git checkout tu-rama
   ```
2. Crear el archivo de migración:
   ```bash
   npx supabase migration new descripcion_corta
   ```
   Se crea `supabase/migrations/<fecha>_descripcion_corta.sql`. Escribir ahí el SQL.
3. Probarlo en la base local (ver la sección siguiente).
4. Commit, push de tu rama y PR.
5. Cuando el PR esté aprobado y mergeado, **una sola persona** lo aplica a Supabase:
   ```bash
   npx supabase db push
   ```

Si alguien cambió algo a mano en el dashboard, traerlo al repo con:
```bash
npx supabase db pull --linked --diff-engine migra
```

---

## Probar en la base local

La base local corre en Docker, en tu compu. Es una copia vacía con el mismo esquema: se puede romper sin miedo.

```bash
# 1. Levantar solo la base y el login (más liviano)
npx supabase start -x kong,postgrest,realtime,storage-api,imgproxy,mailpit,studio,edge-runtime,logflare,vector,supavisor,postgres-meta
```
Si querés el dashboard local (Studio, en http://localhost:54323), usá `npx supabase start` sin `-x` (descarga bastante más).

Para probar una migración nueva **sobre datos parecidos a los reales**:

```bash
# 2. Dejar la base local como está hoy Supabase (sin la migración nueva)
npx supabase db reset --local --version 20261026155217 --no-seed

# 3. Cargar datos de ejemplo
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/simular_base_actual.sql

# 4. Aplicar las migraciones pendientes
npx supabase migration up --local

# 5a. Pruebas de permisos
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/pruebas_permisos.sql

# 5b. Pruebas de registrar_movimiento: antes repetir los pasos 2, 3 y 4
#     (las dos pruebas crean los mismos usuarios de prueba)
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/pruebas_registrar_movimiento.sql
bash supabase/pruebas/prueba_ventas_simultaneas.sh

# 6. Revisor de seguridad de Supabase
npx supabase db advisors --local

# 7. Apagar la base local
npx supabase stop
```

Para ver qué se va a aplicar en Supabase antes de hacerlo: `npx supabase db push --dry-run`.

### Resultado de las pruebas (26/10/2026, migración `correcciones_esquema`)
Todas dieron lo esperado y el revisor de seguridad no encontró problemas.

| | Prueba | Resultado |
|---|---|---|
| A | Restricciones y RLS activas en las 4 tablas | ✅ |
| B | Crear la cuenta del Admin Prueba lo vincula y sigue ADMINISTRADOR | ✅ |
| C | Registrarse pidiendo ser admin → queda EMPLEADO | ✅ |
| D | Sin login no puede leer productos | ✅ permission denied |
| E | EMPLEADO ve productos | ✅ |
| F | EMPLEADO no puede crear productos | ✅ error de RLS |
| G | EMPLEADO no puede cambiar stock directo | ✅ 0 filas |
| H | EMPLEADO no puede insertar movimientos directo | ✅ permission denied |
| I | EMPLEADO no puede hacerse admin | ✅ 0 filas |
| J | EMPLEADO solo ve su propia fila de usuario (desde KAN-37 ve a todos, para el historial) | ✅ |
| K | ADMIN crea y modifica productos, ve todos los usuarios | ✅ |
| L | Nadie puede cambiar id o email de un usuario | ✅ permission denied |
| M | Usuario desactivado no ve nada | ✅ |
| N | Movimiento sin usuario | ✅ rechazado |
| O | Borrar producto con movimientos | ✅ rechazado |
| P | Borrar producto sin movimientos | ✅ permitido |
| Q | Categoría con nombre repetido | ✅ rechazado |

### Resultado de las pruebas (27/10/2026, migración `registrar_movimiento`)
Todas dieron lo esperado. Las pruebas de permisos se volvieron a correr con esta migración y siguen dando bien. El revisor de seguridad no encontró problemas.

| | Prueba | Resultado |
|---|---|---|
| 1 | EMPLEADO: ENTRADA de 5 (10 → 15) | ✅ |
| 2 | EMPLEADO: SALIDA de 3, tipo en minúscula (15 → 12) | ✅ |
| 3 | SALIDA de 100 con stock 12 | ✅ "Stock insuficiente … hay 12" |
| 4 | SALIDA de todo el stock (12 → 0) | ✅ |
| 5 | SALIDA con stock 0 | ✅ rechazada |
| 6–7 | Cantidad 0 o negativa | ✅ rechazada |
| 8 | Tipo inválido | ✅ rechazado |
| 9 | Motivo vacío | ✅ rechazado |
| 10 | Producto inexistente | ✅ rechazado |
| 11 | Producto dado de baja | ✅ rechazado |
| 12 | EMPLEADO intenta AJUSTE | ✅ rechazado |
| 13 | ADMIN: AJUSTE, sistema 3 y contó 7 (cantidad 4, 3 → 7) | ✅ |
| 14 | ADMIN: AJUSTE, sistema 7 y contó 2 (cantidad 5, 7 → 2) | ✅ |
| 15 | AJUSTE igual al sistema | ✅ rechazado |
| 16 | Usuario inactivo | ✅ rechazado |
| 17 | Sin login | ✅ permission denied |
| 18 | EMPLEADO ve el historial con el autor de cada movimiento | ✅ |
| 19 | Stock final coherente con los movimientos | ✅ |
| — | Dos ventas simultáneas de 4 con stock 5 | ✅ una pasa (5 → 1), la otra espera y se rechaza |

---

## Problemas conocidos y soluciones

| Problema | Causa | Solución |
|---|---|---|
| `failed to connect to the docker API ... docker_engine` | Docker Desktop no está abierto | Abrirlo y esperar "Engine running" |
| Instalador de Docker: falta "Virtual Machine Platform" | WSL no está activado | `wsl --install` en PowerShell como administrador, reiniciar |
| `db pull` falla con `PgDeltaEngineError ... invalid secret format` | Falla del motor de comparación nuevo | Usar `--diff-engine migra` |
| Docker: `read-only file system` | Disco C: lleno | Liberar espacio, cerrar Docker Desktop, `wsl --shutdown`, volver a abrirlo |
| `supabase start`: `unable to find user kong` | Imagen de kong dañada (pasa después de quedarse sin disco) | Agregar `kong` al `-x`, o borrar la imagen con `docker rmi` y volver a arrancar |
| Login de la CLI: `device_code: Invalid string` | Se pegó algo que no era el código | `Ctrl + C`, `npx supabase login` de nuevo y pegar solo el código de 8 caracteres |
| La CLI abre otra cuenta de Supabase | Hay otra sesión abierta en el navegador | Usar ventana de incógnito o `npx supabase login --token <token>` |

---

## Historial de migraciones

| Migración | Qué hace | ¿Aplicada en Supabase? |
|---|---|---|
| `20261026155217_remote_schema` | Esquema de KAN-39, 40 y 41 traído desde Supabase con `db pull` | ✅ (ya estaba) |
| `20261026161316_correcciones_esquema` | Permisos, RLS por rol, `usuario` conectado al login, historial protegido, UNIQUE repetido eliminado | ✅ 27/10/2026 |
| `20261027122541_registrar_movimiento` | KAN-37: columnas `stock_anterior` y `stock_resultante`, función `registrar_movimiento`, los usuarios activos ven a sus compañeros | ⏳ Pendiente de `db push` |

---

## Registro de trabajo

### 26/10/2026 — Milagros Maldonado (rama `milagros`)

**Contexto.** Ya estaban hechos en Supabase, directo desde el dashboard, KAN-39 (esquema), KAN-40 (restricciones) y KAN-41 (datos iniciales: 5 categorías, 15 productos y el usuario Admin Prueba). Faltaba guardar la base en el repo y preparar la seguridad antes de conectar el front.

**1. Herramientas instaladas**
- CLI de Supabase como dependencia de desarrollo (`npm install supabase --save-dev`).
- Docker Desktop con WSL 2 (hizo falta activar "Virtual Machine Platform").
- `npx supabase login`, `npx supabase init` y `npx supabase link --project-ref dcsudaeolwqnatkogkbj`.

**2. Esquema de Supabase guardado en el repo**
- `npx supabase db pull --linked --diff-engine migra` generó `migrations/20261026155217_remote_schema.sql`.
- Se marcó en Supabase como "ya aplicada", para que `db push` no intente crear las tablas de nuevo. No cambió tablas ni datos.

**3. Revisión de la base real** (con consultas de solo lectura)

Problemas encontrados:
1. Los roles de la app (`anon` y `authenticated`) no tenían permisos sobre ninguna tabla: el front no iba a poder leer datos.
2. No había RLS en ninguna tabla.
3. `admin@stockfx.com` existía en `usuario` pero no tenía cuenta de login (`auth.users` estaba vacía), y `usuario` no estaba conectada con `auth.users`.
4. Borrar un producto borraba su historial de movimientos (`ON DELETE CASCADE`), y borrar un usuario dejaba movimientos sin autor (`SET NULL`).
5. `categoria.nombre` tenía dos restricciones UNIQUE iguales.

Comparación con la rama `feature/database`: su `schema.sql` no coincide con la base real (IDs UUID en lugar de `bigint`, otros nombres de columnas, tiene `tiene_caducidad`). De esa versión se tomó la idea de conectar `usuario` con el login y de exigir usuario en cada movimiento. Las migraciones de esta carpeta pasan a ser la fuente de verdad.

**4. Migración de correcciones** (`migrations/20261026161316_correcciones_esquema.sql`)
- Permisos mínimos para `authenticated`; nada para `anon`; todo para `service_role`.
- RLS en las 4 tablas, con reglas por rol (ver [Roles y permisos](#roles-y-permisos)). Función `rol_actual()`.
- `usuario.id_usuario` conectado a `auth.users`, más el trigger `al_crear_cuenta_de_login`.
- Productos y usuarios con movimientos no se pueden borrar (`ON DELETE RESTRICT`), y `movimiento_stock.id_usuario` pasa a ser obligatorio.
- Se eliminó el UNIQUE repetido `uq_categoria_nombre`.

**5. Pruebas en base local**
- Base local en Docker, llevada al estado actual de Supabase con `db reset --version` y `pruebas/simular_base_actual.sql`.
- Se aplicó la migración y se corrieron las 17 pruebas de `pruebas/pruebas_permisos.sql`: todas dieron lo esperado (ver [resultados](#resultado-de-las-pruebas-26102026-migración-correcciones_esquema)).
- `npx supabase db advisors --local`: sin problemas de seguridad ni rendimiento.

**6. Problemas resueltos en el camino** (detalle en [Problemas conocidos](#problemas-conocidos-y-soluciones))
- El login de la CLI abría otra cuenta de Supabase.
- Docker no arrancaba porque faltaba WSL.
- El motor `pg-delta` de `db pull` fallaba; se usó `migra`.
- El disco C: se llenó y Docker quedó en solo lectura. Se liberó espacio y se reinició Docker y WSL.
- La imagen de `kong` quedó dañada; se excluye al levantar la base local.

**7. Documentación**
- Este README, un enlace desde el `README.md` principal y los scripts de `pruebas/`.

**Estado al cierre:** todo está en la rama local `milagros`, **sin commit ni push**. La migración de correcciones **no está aplicada** en Supabase. El servidor Express (`src/server.js`) y el front no se modificaron.

### 27/10/2026 — Milagros Maldonado (rama `milagros`)

**1. Correcciones aplicadas en Supabase**
- Antes de aplicar se confirmó que la base real seguía igual: 0 movimientos, 0 cuentas de login, 15 productos y 1 usuario.
- `npx supabase db push --linked` aplicó `20261026161316_correcciones_esquema`.
- Verificado en Supabase: RLS activo en las 4 tablas, `anon` sin acceso, `authenticated` con acceso, trigger `al_crear_cuenta_de_login` creado, borrados protegidos y Admin Prueba sigue como ADMINISTRADOR.
- Se creó la cuenta de login de `admin@stockfx.com` desde el dashboard. El trigger la vinculó sola con la fila existente y sigue como ADMINISTRADOR (verificado).

**2. KAN-37: `registrar_movimiento`** (`migrations/20261027122541_registrar_movimiento.sql`)
- Función que valida rol, tipo, cantidad, motivo y producto (que exista y esté activo), bloquea el producto, calcula el stock nuevo, lo guarda y registra el movimiento. Todo en un paso.
- Se definió **AJUSTE** como "stock contado": lo informa el admin y la función calcula la diferencia.
- Columnas nuevas en `movimiento_stock`: `stock_anterior` y `stock_resultante`, para el historial y para saber si un ajuste subió o bajó el stock.
- Al probar se vio que un EMPLEADO no veía quién hizo los movimientos de otros, porque solo podía ver su propia fila de `usuario`. Se cambió la regla: los usuarios activos ven a sus compañeros, y modificarlos sigue siendo solo del admin.
- Documentada en [API para el front](#api-para-el-front), con parámetros, respuesta y errores.

**3. Pruebas en base local**
- 19 pruebas de la función, prueba de ventas simultáneas y las 17 de permisos otra vez: todo bien (ver [resultados](#resultado-de-las-pruebas-27102026-migración-registrar_movimiento)).
- Se actualizaron dos pruebas de permisos que insertaban movimientos a mano, para incluir las columnas nuevas.
- `db advisors`: sin problemas.

**Estado al cierre:** `registrar_movimiento` está probada en local y **no aplicada** en Supabase. Todo se subió a la rama `milagros` en GitHub.

---

## Pendientes

- [x] Commit y push de la rama `milagros`.
- [ ] PR para que el equipo revise.
- [x] Crear la cuenta de login de `admin@stockfx.com` (ver [Usuarios y login](#usuarios-y-login)).
- [ ] Aplicar `registrar_movimiento` en Supabase (`npx supabase db push`).
- [ ] Avisar al front: hay que iniciar sesión antes de pedir datos (KAN-33) y los movimientos se registran con `registrar_movimiento` (KAN-35).
- [ ] Alertas: stock bajo (KAN-36), próximos a agotarse, mercadería inmovilizada y sugerencias de reposición.
- [ ] Decidir si hace falta `tiene_caducidad` en `producto` (estaba en `feature/database`, no en la base real).
- [ ] Decidir si los roles se amplían a dueño / encargado / vendedor (hoy: ADMINISTRADOR / EMPLEADO).
- [ ] Decidir si se sigue usando el servidor Express de este repo o si el front habla directo con Supabase.
