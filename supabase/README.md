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
│   ├── 20261027122541_registrar_movimiento.sql   KAN-37: función para registrar movimientos
│   ├── 20261109233502_dashboard_y_productos.sql  Datos del Dashboard y de la vista Productos
│   ├── 20261109235056_usuarios_y_roles.sql       Reglas de usuarios y stock solo por movimientos
│   └── 20261110011736_cuentas_nuevas_desactivadas.sql  Quien se registra solo entra desactivado
├── functions/
│   └── gestionar-usuarios/index.ts    Edge Function: el admin crea, activa y desactiva usuarios
├── pruebas/
│   ├── simular_base_actual.sql            Carga datos de ejemplo como los de Supabase
│   ├── pruebas_permisos.sql               17 pruebas de roles, permisos y borrados
│   ├── pruebas_registrar_movimiento.sql   19 pruebas de la función registrar_movimiento
│   ├── prueba_ventas_simultaneas.sh       Dos ventas al mismo tiempo: el stock nunca queda negativo
│   ├── datos_demo.sql                     Usuarios, productos y movimientos de demo (solo local)
│   ├── pruebas_dashboard.sql              47 pruebas del Dashboard y la vista Productos
│   ├── prueba_rendimiento.sql             5.000 productos y 100.000 movimientos: mide tiempos
│   └── prueba_usuarios_y_roles.sh         65 pruebas por la API: usuarios, registro propio y ADMIN vs EMPLEADO
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
| `fecha_alta` | timestamptz | se completa sola al crear el producto. Los cargados antes del 09/11/2026 quedan en null |

### Estado de stock (una sola regla para todo el sistema)
La calcula la base en la vista `v_producto`, con la misma regla que ya usaba el front:

| `estado_stock` | Cuándo | Etiqueta sugerida |
|---|---|---|
| `SIN_STOCK` | stock ≤ 0 | Sin stock |
| `CRITICO` | stock < 50 % del mínimo | Crítico |
| `BAJO` | stock ≤ mínimo | Stock bajo / Reponer |
| `NORMAL` | el resto, o si el producto no tiene mínimo cargado | En stock |

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

Los movimientos solo se crean con la función [`registrar_movimiento`](#7-registrar_movimiento-kan-37).

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

La seguridad está en la base con **RLS** (Row Level Security) y permisos por columna: aunque alguien saltee el front, la base no le deja hacer lo que su rol no permite.

**En una frase:**
- **EMPLEADO:** consulta todo y **mueve el stock**, registrando ventas (SALIDA) e ingresos de mercadería (ENTRADA).
- **ADMINISTRADOR:** además administra el catálogo (productos y categorías), hace ajustes por conteo y gestiona los usuarios.

| Acción | Sin login | EMPLEADO | ADMINISTRADOR |
|---|:-:|:-:|:-:|
| **Consultar** | | | |
| Ver productos, categorías, KPIs y dashboard | ❌ | ✅ | ✅ |
| Ver historial de movimientos | ❌ | ✅ | ✅ |
| Ver usuarios (nombre, email, rol) | ❌ | ✅ | ✅ |
| **Stock** (solo con `registrar_movimiento`) | | | |
| ENTRADA: ingreso de mercadería, devolución, etc. | ❌ | ✅ | ✅ |
| SALIDA: venta, consumo interno, rotura, etc. | ❌ | ✅ | ✅ |
| AJUSTE: corregir el stock según un conteo físico | ❌ | ❌ | ✅ |
| Cambiar `stock_actual` editando el producto a mano | ❌ | ❌ | ❌ |
| Modificar o borrar movimientos | ❌ | ❌ | ❌ |
| **Catálogo** | | | |
| Crear productos (con su stock inicial) | ❌ | ❌ | ✅ |
| Editar productos (precio, nombre, mínimo, categoría…) | ❌ | ❌ | ✅ |
| Dar de baja / reactivar productos (`activo`) | ❌ | ❌ | ✅ |
| Borrar productos (solo si no tienen movimientos) | ❌ | ❌ | ✅ |
| Crear / editar / borrar categorías | ❌ | ❌ | ✅ |
| **Usuarios** | | | |
| Crear usuarios (`gestionar-usuarios`) | ❌ | ❌ | ✅ |
| Desactivar / activar usuarios (`gestionar-usuarios`) | ❌ | ❌ | ✅ (no a sí mismo) |
| Cambiar nombre, apellido o rol de un usuario | ❌ | ❌ | ✅ |
| Cambiar id o email de un usuario | ❌ | ❌ | ❌ |

Reglas que la base hace cumplir siempre:
- Un usuario con `activo = false` **no puede iniciar sesión** y, si tenía una sesión abierta, no ve nada.
- **Una cuenta que se registra sola entra desactivada**: no ve ni puede hacer nada hasta que un admin la activa. Solo entran activas las cuentas que crea un admin con `gestionar-usuarios`.
- Siempre queda **al menos un ADMINISTRADOR activo**: no se puede desactivar ni quitarle el rol al último.
- El stock **nunca** se edita a mano, tampoco el admin. Todo cambio pasa por un movimiento y queda en el historial.
- La función `public.rol_actual()` devuelve el rol del usuario logueado (o null). Las reglas RLS la usan.
- La clave `service_role` (secreta, solo para servidor) ignora RLS. **Nunca** va en el front ni en el repo; solo la usa la Edge Function, del lado del servidor.

Todo esto está probado por la API con `pruebas/prueba_usuarios_y_roles.sh` (ver [resultados](#resultado-de-las-pruebas-09112026-usuarios-y-roles)).

---

## API para el front

Supabase genera la API sola a partir de las tablas y funciones. El front la usa con la librería `@supabase/supabase-js`, la URL del proyecto y la clave pública (`anon` / `publishable`). **Nunca** usar la clave `service_role` en el front.

### 1. Iniciar sesión (obligatorio)
Sin sesión, todas las consultas dan "permission denied".
```js
const { error } = await supabase.auth.signInWithPassword({ email, password })
```

### 2. Rol del usuario logueado
```js
const { data: rol } = await supabase.rpc('rol_actual')   // 'ADMINISTRADOR', 'EMPLEADO' o null
```

### 3. Vista Dashboard: `dashboard_resumen` (una sola llamada)
Trae todo lo del Dashboard: productos a reponer, balance de entradas y salidas, y últimos movimientos. Los KPIs de productos **no** van acá: están en la vista Productos.

```js
const { data, error } = await supabase.rpc('dashboard_resumen', {
  p_dias: 7,     // días del balance: 7 = "Últimos 7 días", 30 = "Últimos 30 días" (1 a 365)
  p_limite: 5    // cuántos productos a reponer y cuántos movimientos devolver (1 a 50)
})
```

Respuesta:
```js
{
  productos_a_reponer: {
    total: 6,                       // para "Mostrando 4 de 6" y el número rojo del menú "Stock Bajo"
    items: [                        // los más urgentes primero: SIN_STOCK, CRITICO, BAJO
      { id_producto, codigo, nombre, categoria, stock_actual, stock_minimo, estado_stock }
    ]
  },
  balance: {                        // gráfico "Balance de Entradas vs Salidas"
    desde: '2026-11-03', hasta: '2026-11-09',
    dias: [ { fecha: '2026-11-03', entradas: 30, salidas: 0, ajustes: 0 }, ... ],  // incluye días sin movimientos
    total_entradas: 30, total_salidas: 31, flujo_neto: -1, total_ajustes: 1
  },
  ultimos_movimientos: [            // tabla "Últimos movimientos de stock"
    { id_movimiento, fecha_movimiento, tipo_movimiento, cantidad, stock_anterior, stock_resultante,
      motivo, id_producto, codigo, producto, usuario_nombre, usuario_apellido }
  ],
  generado: '2026-11-09T23:43:18Z'
}
```
- Las fechas de `fecha_movimiento` vienen en UTC: mostrarlas con `new Date(...).toLocaleString('es-AR')`.
- Los días del balance se calculan en hora de Argentina.
- En el balance, los AJUSTES se cuentan aparte (`ajustes`); no suman ni como entradas ni como salidas.

### 4. Vista Productos: KPIs con `kpis_productos`
Son las tarjetas de arriba de Productos, incluidas las 4 que antes estaban en el Dashboard.
```js
const { data: kpis } = await supabase.rpc('kpis_productos')
```

| Campo | Tarjeta del diseño |
|---|---|
| `total_productos`, `productos_activos`, `productos_inactivos` | Total de productos / Total referencias |
| `nuevos_este_mes`, `variacion_mes_pct` | "+12 nuevos este mes" / "+3.8 % este mes" |
| `unidades_en_stock` | Unidades en stock |
| `valor_stock_costo`, `valor_stock_venta` | Valoración del inventario (en pesos) |
| `stock_normal`, `porcentaje_stock_normal` | En stock normal / "94.9 % operativo" |
| `stock_bajo` (incluye críticos), `stock_critico` | Stock bajo / Puntos de reorden |
| `sin_stock` | Sin stock / Agotados |

Todo cuenta solo productos **activos**, salvo `total_productos` y `productos_inactivos`.

### 5. Vista Productos: tabla con `v_producto`
Es una vista: se consulta como una tabla, pero ya trae la categoría, el estado de stock y el valor. **Filtros, orden y paginación los resuelve el servidor**: no hace falta descargar todos los productos.

```js
const pagina = 1, porPagina = 10
const desde = (pagina - 1) * porPagina

let consulta = supabase
  .from('v_producto')
  .select('*', { count: 'exact' })           // count = total para "Mostrando 1 a 10 de 1.420"
  .eq('activo', true)

if (busqueda)  consulta = consulta.or(`nombre.ilike.%${busqueda}%,codigo.ilike.%${busqueda}%`)
if (categoria) consulta = consulta.eq('id_categoria', categoria)
if (estados)   consulta = consulta.in('estado_stock', estados)   // ej.: ['BAJO', 'CRITICO']

const { data, count, error } = await consulta
  .order('prioridad')                        // o 'nombre', 'stock_actual', 'precio_venta'...
  .order('nombre')
  .range(desde, desde + porPagina - 1)
```

Columnas: `id_producto, codigo, nombre, descripcion, id_categoria, categoria, precio_costo, precio_venta, stock_actual, stock_minimo, stock_maximo, activo, fecha_alta, estado_stock, prioridad, valor_costo, valor_venta`.

La página **Stock Bajo** (KAN-36) es esta misma consulta con `.in('estado_stock', ['SIN_STOCK', 'CRITICO', 'BAJO'])` y orden por `prioridad`.

Para **crear o editar** productos se sigue usando la tabla `producto` (solo ADMINISTRADOR).

### 6. Historial con `v_movimiento`
```js
const { data, count } = await supabase
  .from('v_movimiento')
  .select('*', { count: 'exact' })
  .order('fecha_movimiento', { ascending: false })
  .range(0, 19)
// filtros posibles: .eq('id_producto', 12), .eq('tipo_movimiento', 'SALIDA'),
//                   .gte('fecha_movimiento', '2026-11-01')
```
Columnas: `id_movimiento, fecha_movimiento, tipo_movimiento, cantidad, stock_anterior, stock_resultante, variacion, motivo, id_producto, codigo, producto, id_usuario, usuario_nombre, usuario_apellido`.

### Errores de las funciones de lectura
| Mensaje | Cuándo |
|---|---|
| `permission denied for function ...` / `for view ...` | no hay sesión iniciada |
| `No tenés permiso para ver el inventario (usuario sin cuenta o inactivo)` | usuario desactivado |
| `p_dias tiene que estar entre 1 y 365` / `p_limite tiene que estar entre 1 y 50` | parámetros fuera de rango |

### Rendimiento
Medido en la base local con 5.000 productos y 100.000 movimientos (`pruebas/prueba_rendimiento.sql`):

| Consulta | Tiempo | Tamaño de la respuesta |
|---|---|---|
| `dashboard_resumen(7, 5)` | ~21 ms | ~3 KB |
| `dashboard_resumen(30, 5)` | ~43 ms | ~5 KB |
| `kpis_productos()` | ~12 ms | ~0,4 KB |
| `v_producto`, página de 10 filtrada, con total | ~4 ms | 10 filas |
| `v_movimiento`, últimos 20 | ~2 ms | 20 filas |
| **Antes:** descargar todos los productos para calcular KPIs en el navegador | ~21 ms en la base, más la descarga | **~1,3 MB** |

Se agregaron índices por fecha, producto, usuario y categoría para que estos tiempos se mantengan con más datos.

### 7. `registrar_movimiento` (KAN-37)
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

### 8. Gestionar usuarios: Edge Function `gestionar-usuarios` (solo ADMINISTRADOR)
Crear cuentas de login necesita la clave secreta de Supabase, que no puede estar en el front. Por eso esto lo hace una **Edge Function**, que corre en el servidor de Supabase. Antes de hacer nada, verifica que quien la llama sea un ADMINISTRADOR activo.

```js
// Crear un empleado
const { data, error } = await supabase.functions.invoke('gestionar-usuarios', {
  body: {
    accion: 'crear',
    email: 'juan@almacen.com',
    password: 'una-clave-segura',   // mínimo 8 caracteres
    nombre: 'Juan',
    apellido: 'Gómez',
    rol: 'EMPLEADO'                 // opcional: 'EMPLEADO' (por defecto) o 'ADMINISTRADOR'
  }
})
// data.usuario = { id_usuario, nombre, apellido, email, rol, activo }
// La cuenta queda confirmada: el empleado ya puede iniciar sesión.

// Desactivar (bloquea el login) / volver a activar
await supabase.functions.invoke('gestionar-usuarios', { body: { accion: 'desactivar', id_usuario } })
await supabase.functions.invoke('gestionar-usuarios', { body: { accion: 'activar',    id_usuario } })

// Cambiar el rol de alguien: directo en la tabla (solo admin)
await supabase.from('usuario').update({ rol: 'ADMINISTRADOR' }).eq('id_usuario', id_usuario)

// Listar usuarios para la pantalla de Configuración
const { data: usuarios } = await supabase.from('usuario').select('id_usuario, nombre, apellido, email, rol, activo').order('apellido')
```

**Cómo leer el error.** Con `functions.invoke`, si la respuesta no es 2xx, el mensaje en español está en el cuerpo:
```js
if (error) {
  const { error: mensaje } = await error.context.json()
  mostrarAviso(mensaje)
}
```

| Código | Mensaje | Cuándo |
|---|---|---|
| 401 | `Tenés que iniciar sesión` | sin sesión |
| 403 | `Solo un administrador puede gestionar usuarios` | lo pide un EMPLEADO o un usuario inactivo |
| 400 | `El email no es válido` | |
| 400 | `La contraseña tiene que tener al menos 8 caracteres` | |
| 400 | `Nombre y apellido son obligatorios` | |
| 400 | `El rol tiene que ser ADMINISTRADOR o EMPLEADO` | |
| 400 | `No podés desactivar tu propio usuario` | |
| 400 | `Acción inválida: usá crear, desactivar o activar` | |
| 404 | `El usuario no existe` | `id_usuario` inexistente |
| 409 | `Ya existe un usuario con ese email` | |
| 409 | `Tiene que quedar al menos un administrador activo` | desactivar al último admin |

**En el login**, un usuario desactivado recibe el error `user_banned`. El front ya lo traduce como *"Tu usuario está bloqueado. Contactá al administrador."*

**Publicarla en Supabase** (una vez, y cada vez que cambie):
```bash
npx supabase functions deploy gestionar-usuarios
```

---

## Usuarios y login

Cada fila de `usuario` corresponde a una cuenta de login de Supabase (`auth.users`). Un trigger (`al_crear_cuenta_de_login`) mantiene las dos tablas sincronizadas:

- Cuando se crea una cuenta de login, se crea su fila en `usuario` con rol **EMPLEADO**.
- El rol **nunca** se toma de lo que manda quien se registra, para que nadie se haga admin solo. Un ADMINISTRADOR lo cambia después.
- Si ya existía una fila en `usuario` con ese email, se vincula con la cuenta nueva y **conserva su rol**.

**Cómo se dan de alta los usuarios:** los crea un ADMINISTRADOR desde la app, con la Edge Function [`gestionar-usuarios`](#8-gestionar-usuarios-edge-function-gestionar-usuarios-solo-administrador). Esas cuentas entran **activas**.

**¿Y si alguien se registra solo?** En Supabase está encendido *"Allow new users to sign up"* (el registro público), y no todos los integrantes tienen permiso para apagarlo. Con la clave pública del front, cualquiera podría crearse una cuenta. Por eso, desde la migración `cuentas_nuevas_desactivadas`:

| Cómo se creó la cuenta | Cómo queda en `usuario` |
|---|---|
| La creó un admin con `gestionar-usuarios` | EMPLEADO (o el rol elegido), **activa** |
| Se registró sola desde la API / la app | EMPLEADO, **desactivada**: no ve ni hace nada |
| Se creó a mano en el dashboard de Supabase (*Add user*) | EMPLEADO, **desactivada**: un admin la activa desde la app |
| Ya había una fila en `usuario` con ese email (como el Admin Prueba) | se vincula y **conserva** su rol y estado |

La función marca sus cuentas con `creado_por_admin` en `app_metadata`. Ese dato **solo lo puede escribir el servidor**: quien se registra solo no puede ponérselo (está probado).

Igual conviene **apagar el registro público** cuando alguien con permiso pueda (Owner o Administrator del proyecto): *Authentication → Sign In / Providers → "Allow new users to sign up"*. La Edge Function sigue creando usuarios con el registro apagado.

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

### Probar el Dashboard y la vista Productos (con datos de demo)
```bash
# 1. Base local con TODAS las migraciones, vacía
npx supabase db reset --local --no-seed

# 2. Datos de demo: usuarios, 10 productos y 9 movimientos de los últimos días
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/datos_demo.sql

# 3. 47 pruebas (cada línea dice OK o FALLO)
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/pruebas_dashboard.sql

# 4. Opcional: rendimiento con 5.000 productos y 100.000 movimientos
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/prueba_rendimiento.sql
```

**Para que el front pruebe contra la base local** (sin tocar los datos reales):
1. Levantar la base local con la API: `npx supabase start -x realtime,storage-api,imgproxy,mailpit,studio,edge-runtime,logflare,vector,supavisor,postgres-meta`.
2. Hacer los pasos 1 y 2 de arriba.
3. En el `.env.local` del front, poner `VITE_SUPABASE_URL=http://127.0.0.1:54321` y la `ANON_KEY` que muestra `npx supabase status`. Son claves de prueba que solo sirven en tu compu.
4. Iniciar sesión con `empleado@stockfx.com` o `admin@stockfx.com`, contraseña `demo-local-123`. Esos usuarios **solo existen en la base local**.

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

### Resultado de las pruebas (09/11/2026, migración `dashboard_y_productos`)
**47 de 47 OK** (`pruebas/pruebas_dashboard.sql`). Las pruebas de permisos y de `registrar_movimiento` se volvieron a correr y siguen dando bien. El revisor de seguridad no encontró problemas.

| Grupo | Qué se verificó | Resultado |
|---|---|---|
| `kpis_productos` | Los 13 números contra valores calculados a mano (total, activos, nuevos del mes, unidades, valor a costo y a venta, normal, bajo, crítico, sin stock, porcentajes) | ✅ 13/13 |
| `dashboard_resumen` | Productos a reponer (total, orden por urgencia, estados), balance de 7 días (por día y totales), últimos movimientos (orden y autor) | ✅ 12/12 |
| Parámetros | 30 días de balance y límite de 3 ítems | ✅ 5/5 |
| `v_producto` / `v_movimiento` | Estados de stock en los casos límite (igual al mínimo, sin mínimo), categoría, búsqueda, paginación y variación de ajustes | ✅ 8/8 |
| Permisos | Usuario inactivo rechazado; sin login no puede usar vistas ni funciones; vistas con `security_invoker` | ✅ 8/8 |
| Validación | `p_dias = 0` rechazado | ✅ 1/1 |

**También se probó por la API local** (HTTP, como el front con `supabase-js`): login de empleado, `rpc/dashboard_resumen`, `rpc/kpis_productos`, `v_producto` con filtro por estado, orden, paginación y total (`Content-Range: 0-2/5`), búsqueda por nombre y código, `v_movimiento`. Sin login responde `permission denied`, y con un usuario inactivo devuelve el mensaje en español.

### Probar usuarios y roles (Edge Function, por la API)
```bash
# 1. Base local con la API y las funciones (sin -x edge-runtime)
npx supabase start -x realtime,storage-api,imgproxy,mailpit,studio,logflare,vector,supavisor,postgres-meta

# 2. Base vacía con todas las migraciones + datos de demo
npx supabase db reset --local --no-seed
docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres < supabase/pruebas/datos_demo.sql

# 3. 65 pruebas por HTTP (cada línea dice OK o FALLO)
bash supabase/pruebas/prueba_usuarios_y_roles.sh
```

### Resultado de las pruebas (09/11/2026, usuarios y roles)
**52 de 52 OK** por la API local, igual que lo haría el front. Las demás suites (47 del dashboard, permisos, `registrar_movimiento` y ventas simultáneas) se volvieron a correr y siguen dando bien. El revisor de seguridad no encontró problemas.

| Grupo | Qué se verificó | Resultado |
|---|---|---|
| Quién puede usar `gestionar-usuarios` | Sin login → 401; EMPLEADO → 403 | ✅ |
| Crear | Empleado y admin creados; pueden iniciar sesión; email en minúscula; email repetido, contraseña corta, sin nombre, rol o acción inventados → rechazados | ✅ 15/15 |
| Desactivar / activar | Al desactivar, el login da `user_banned`; al reactivar, vuelve a entrar; no puede desactivarse a sí mismo; usuario inexistente → 404; EMPLEADO no puede | ✅ 9/9 |
| Reglas de la tabla `usuario` | `activo` no se edita a mano (solo por la función); el admin sí cambia roles; el empleado no puede cambiarse el rol; no se puede dejar el sistema sin admins | ✅ 7/7 |
| EMPLEADO | Ve productos, KPIs y dashboard; registra ENTRADA y SALIDA. **No puede** crear productos o categorías, cambiar precios, dar de baja, borrar, editar stock a mano, hacer AJUSTE ni crear usuarios | ✅ 13/13 |
| ADMINISTRADOR | Crea productos y categorías, cambia precios, da de baja, hace AJUSTE, borra productos sin movimientos. **No puede** editar stock a mano ni borrar productos con movimientos | ✅ 8/8 |

### Resultado de las pruebas (10/11/2026, migración `cuentas_nuevas_desactivadas`)
**65 de 65 OK** por la API local: las 52 anteriores más 13 de registro propio. Las demás suites (47 del dashboard, permisos, `registrar_movimiento` y ventas simultáneas) siguen dando bien. El revisor de seguridad no encontró problemas.

| Qué se verificó | Resultado |
|---|---|
| Un desconocido se registra con la clave pública: puede iniciar sesión, pero queda EMPLEADO **desactivado** | ✅ |
| Ese usuario **no** ve productos ni KPIs, **no** puede registrar ventas ni crear usuarios | ✅ |
| Otro se registra mandando `creado_por_admin: true` y `rol: ADMINISTRADOR` en sus datos: **igual** queda EMPLEADO desactivado | ✅ |
| Cuando el admin lo activa desde la app, recién ahí ve productos | ✅ |
| Las cuentas que crea el admin siguen entrando activas | ✅ |

---

## Problemas conocidos y soluciones

| Problema | Causa | Solución |
|---|---|---|
| `db push` o `db pull`: `FATAL: (EAUTHQUERY) unsupported or invalid secret format` | Falla momentánea de la conexión automática de la CLI | Reintentar. Si sigue: `npx supabase db push --password "<contraseña de la base>"` o actualizar la CLI (`npm install supabase@latest --save-dev`) |
| `failed to connect to the docker API ... docker_engine` | Docker Desktop no está abierto | Abrirlo y esperar "Engine running" |
| Instalador de Docker: falta "Virtual Machine Platform" | WSL no está activado | `wsl --install` en PowerShell como administrador, reiniciar |
| `db pull` falla con `PgDeltaEngineError ... invalid secret format` | Falla del motor de comparación nuevo | Usar `--diff-engine migra` |
| Docker: `read-only file system` | Disco C: lleno | Liberar espacio, cerrar Docker Desktop, `wsl --shutdown`, volver a abrirlo |
| `supabase start`: `unable to find user kong` o `exec /bin/postgrest: exec format error` | Imagen de Docker dañada (pasa después de quedarse sin disco) | `npx supabase stop`, borrar esa imagen (`docker image rm -f public.ecr.aws/supabase/kong:2.8.1` o `.../postgrest:v14.5`) y volver a arrancar: se descarga de nuevo |
| Login de la CLI: `device_code: Invalid string` | Se pegó algo que no era el código | `Ctrl + C`, `npx supabase login` de nuevo y pegar solo el código de 8 caracteres |
| La CLI abre otra cuenta de Supabase | Hay otra sesión abierta en el navegador | Usar ventana de incógnito o `npx supabase login --token <token>` |

---

## Historial de migraciones

| Migración | Qué hace | ¿Aplicada en Supabase? |
|---|---|---|
| `20261026155217_remote_schema` | Esquema de KAN-39, 40 y 41 traído desde Supabase con `db pull` | ✅ (ya estaba) |
| `20261026161316_correcciones_esquema` | Permisos, RLS por rol, `usuario` conectado al login, historial protegido, UNIQUE repetido eliminado | ✅ 27/10/2026 |
| `20261027122541_registrar_movimiento` | KAN-37: columnas `stock_anterior` y `stock_resultante`, función `registrar_movimiento`, los usuarios activos ven a sus compañeros | ✅ 10/11/2026 |
| `20261109233502_dashboard_y_productos` | `producto.fecha_alta`, índices, vistas `v_producto` y `v_movimiento`, funciones `kpis_productos` y `dashboard_resumen` | ✅ 10/11/2026 |
| `20261109235056_usuarios_y_roles` | `activo` solo por Edge Function, al menos un admin activo, `stock_actual` no editable a mano | ✅ 10/11/2026 |
| `20261110011736_cuentas_nuevas_desactivadas` | Las cuentas que se registran solas entran desactivadas; solo entran activas las que crea un admin | ✅ 10/11/2026 |
| Edge Function `gestionar-usuarios` | Crear, activar y desactivar usuarios | ✅ Publicada el 09/11/2026 y actualizada el 10/11/2026 (versión 2, con la marca `creado_por_admin`) |

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

### 09/11/2026 — Milagros Maldonado (rama `milagros`)

**Contexto.** El front ya tiene login (PR #3 de `gestor-stock-client`) y una vista de productos con KPIs (PRs #4, #5 y #6), pero calculaba los KPIs en el navegador descargando **todos** los productos. Según el diseño de Stitch:
- el **Dashboard** muestra productos con stock bajo, el balance de entradas vs salidas y los últimos movimientos;
- las 4 tarjetas de KPIs (total, unidades, stock bajo, sin stock) pasan a la vista **Productos**, junto con las de esa vista.

**1. Migración `20261109233502_dashboard_y_productos.sql`**
- `producto.fecha_alta`, para "nuevos este mes". Los productos existentes quedan en null.
- Vista `v_producto`: producto, categoría, `estado_stock` (misma regla que el front), `prioridad` para ordenar por urgencia y valorización. Permite filtrar, ordenar y paginar en el servidor.
- Vista `v_movimiento`: historial con producto, autor y variación.
- Función `kpis_productos()`: todas las tarjetas de la vista Productos en una llamada.
- Función `dashboard_resumen(p_dias, p_limite)`: todo el Dashboard en una llamada.
- Índices en `movimiento_stock` (fecha, producto, usuario) y `producto` (categoría).
- Seguridad: las vistas usan `security_invoker` y las funciones corren con los permisos de quien llama, así que RLS se aplica igual. Sin login no se puede usar nada, y un usuario inactivo recibe un mensaje claro.

**2. Pruebas** (ver [resultados](#resultado-de-las-pruebas-09112026-migración-dashboard_y_productos))
- `datos_demo.sql` con estados de stock y movimientos conocidos; `pruebas_dashboard.sql`: 47/47 OK.
- Prueba por la API local, como lo hace el front.
- Rendimiento con 5.000 productos y 100.000 movimientos: todo en menos de 45 ms (ver [Rendimiento](#rendimiento)).
- Las pruebas anteriores siguen dando bien; `db advisors` sin problemas.
- Se arreglaron las imágenes dañadas de `kong` y `postgrest` para poder levantar la API local.

**3. Encontrado al revisar el login**
- El login del front está bien hecho: usa Supabase Auth, que ya es el backend. No hay que moverlo.
- **El registro público está habilitado en Supabase** (`disable_signup: false`): cualquiera con la clave pública puede crearse una cuenta y entrar como EMPLEADO. Hay que apagarlo en el dashboard (ver Pendientes).

**4. Usuarios: ADMINISTRADOR y EMPLEADO**
- Edge Function `gestionar-usuarios` (`functions/gestionar-usuarios/index.ts`): el admin crea usuarios (confirmados, listos para entrar) y los activa o desactiva. Al desactivar se **bloquea el login**, no solo la vista de datos. Verifica que quien llama sea admin activo.
- Migración `20261109235056_usuarios_y_roles.sql`:
  - `usuario.activo` solo se cambia con la Edge Function, así la base y el login nunca quedan distintos;
  - un trigger impide dejar el sistema sin un ADMINISTRADOR activo;
  - **`producto.stock_actual` ya no se puede editar a mano, ni siquiera el admin**: todo cambio de stock pasa por `registrar_movimiento` y queda en el historial. Al crear un producto sí se carga el stock inicial.
- Diferencias entre roles documentadas en [Roles y permisos](#roles-y-permisos): el EMPLEADO consulta y registra ventas e ingresos; el ADMINISTRADOR además maneja el catálogo, los ajustes y los usuarios.
- Pruebas: `prueba_usuarios_y_roles.sh`, 52/52 OK por HTTP (65 desde el 10/11). Se actualizó lo esperado en la prueba G de permisos: ahora la base rechaza con `permission denied` en lugar de modificar 0 filas.

**Estado al cierre:** se subió a la rama `milagros` en GitHub y se publicó la Edge Function `gestionar-usuarios` en Supabase. Las migraciones **no** se aplicaron. El front no se modificó.

### 10/11/2026 — Milagros Maldonado (rama `milagros`)

**Problema.** El registro público de Supabase (*"Allow new users to sign up"*) está encendido y no se pudo apagar desde la cuenta de Milagros: el botón aparece bloqueado, seguramente por falta de permisos de Owner o Administrator. Con la clave pública del front, cualquiera podía crearse una cuenta, quedar como EMPLEADO activo, ver el inventario y, con KAN-37, registrar ventas. "Allow anonymous sign-ins" ya estaba apagado: ese no es el problema.

**Solución desde la base** (`migrations/20261110011736_cuentas_nuevas_desactivadas.sql`)
- El trigger que crea la fila en `usuario` ahora la deja **desactivada**, salvo que la cuenta tenga `creado_por_admin` en `app_metadata`, un dato que solo puede escribir el servidor.
- La Edge Function `gestionar-usuarios` pone esa marca al crear usuarios, así que las cuentas del admin entran activas.
- Las filas que ya existían no cambian.

**Pruebas:** 13 casos nuevos en `prueba_usuarios_y_roles.sh`, incluido alguien que intenta ponerse la marca de admin al registrarse: 65/65 OK. Se ajustaron `datos_demo.sql`, `pruebas_registrar_movimiento.sql` y la prueba C de `pruebas_permisos.sql`, porque sus usuarios de prueba se crean directo en la base. Todas las suites siguen dando bien.

**Aplicado en Supabase**
- `npx supabase functions deploy gestionar-usuarios`: versión 2, con la marca `creado_por_admin`.
- `npx supabase db push`: las 4 migraciones pendientes. El primer intento falló al conectarse (`EAUTHQUERY ... invalid secret format`) sin aplicar nada; el segundo intento terminó bien.
- Antes de aplicar se verificó que hubiera 0 movimientos y una sola cuenta (el admin).
- Verificado después en Supabase:
  - las 6 migraciones figuran aplicadas;
  - existen las funciones nuevas y las vistas, con `security_invoker`;
  - `stock_actual` y `usuario.activo` no se pueden editar a mano;
  - `anon` no puede registrar movimientos;
  - los triggers están activos;
  - el Admin Prueba sigue ADMINISTRADOR activo.

**Revisor de seguridad en Supabase** (`npx supabase db advisors --linked`): 3 avisos, ninguno es un problema.
- `registrar_movimiento` y `rol_actual` son `SECURITY DEFINER` y las puede llamar un usuario logueado. **Es a propósito:** son la forma de registrar movimientos y de saber el rol, y las dos validan quién llama.
- *Leaked password protection* desactivado: es un ajuste de Authentication que rechaza contraseñas filtradas. Conviene activarlo si el plan lo permite (Authentication → Policies / Passwords); lo tiene que hacer alguien con permiso.

**Estado al cierre:** todo aplicado en Supabase; los archivos, subidos a la rama `milagros`.

---

## Pendientes

- [x] Commit y push de la rama `milagros` (hasta el 09/11).
- [x] Commit y push de los cambios del 10/11.
- [ ] PR para que el equipo revise.
- [x] Crear la cuenta de login de `admin@stockfx.com` (ver [Usuarios y login](#usuarios-y-login)).
- [x] Proteger el sistema del registro público: las cuentas que se registran solas entran desactivadas (`cuentas_nuevas_desactivadas`).
- [ ] Opcional: apagar el registro público. Lo tiene que hacer alguien con rol Owner o Administrator: Authentication → Sign In / Providers → "Allow new users to sign up".
- [x] Volver a publicar la Edge Function (versión 2) y aplicar las 4 migraciones con `npx supabase db push` (10/11/2026).
- [ ] Front: usar `dashboard_resumen` en el Dashboard, y `kpis_productos` + `v_producto` en Productos, en lugar de descargar todos los productos (ver [API para el front](#api-para-el-front)).
- [x] Usuarios: forma de que el admin cree y desactive empleados desde la app (Edge Function `gestionar-usuarios`).
- [ ] Front: pantalla de usuarios en Configuración (solo admin), usando `gestionar-usuarios`. Ocultar botones según el rol (`rpc('rol_actual')`).
- [ ] Crear una cuenta de EMPLEADO de prueba en Supabase (cuando la Edge Function esté publicada, desde la app).
- [ ] Avisar al front: hay que iniciar sesión antes de pedir datos (KAN-33) y los movimientos se registran con `registrar_movimiento` (KAN-35).
- [ ] Alertas: stock bajo (KAN-36), próximos a agotarse, mercadería inmovilizada y sugerencias de reposición.
- [ ] Decidir si hace falta `tiene_caducidad` en `producto` (estaba en `feature/database`, no en la base real).
- [ ] Decidir si los roles se amplían a dueño / encargado / vendedor (hoy: ADMINISTRADOR / EMPLEADO).
- [ ] Decidir si se sigue usando el servidor Express de este repo o si el front habla directo con Supabase.
