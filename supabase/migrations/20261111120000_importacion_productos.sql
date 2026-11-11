-- =====================================================================
-- Historial de importaciones de productos desde Excel
--
-- Guarda el resumen de cada importación y el detalle de las filas rechazadas,
-- para poder responder "¿qué pasó con la planilla de ayer?" sin depender de
-- los logs del servidor.
--
-- Es una migración SOLO ADITIVA: crea dos tablas nuevas. No toca `producto`,
-- `categoria` ni los permisos existentes.
--
-- Quién escribe: únicamente el servidor (cadena de conexión con permisos de
-- base de datos / service_role), que ignora RLS. Los usuarios logueados solo
-- pueden LEER, y solo si son ADMINISTRADOR. No hay policy de INSERT: nadie
-- puede falsear el historial desde el front.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Una fila por importación
-- ---------------------------------------------------------------------
create table if not exists public.importacion_producto (
  id_importacion       bigint generated always as identity primary key,
  fecha                timestamptz not null default now(),
  id_usuario           uuid references public.usuario(id_usuario) on delete set null,
  archivo              text not null,
  hoja                 text,
  tamano_bytes         bigint check (tamano_bytes >= 0),
  filas_procesadas     integer not null default 0 check (filas_procesadas >= 0),
  filas_vacias         integer not null default 0 check (filas_vacias >= 0),
  productos_importados integer not null default 0 check (productos_importados >= 0),
  filas_con_error      integer not null default 0 check (filas_con_error >= 0),
  errores_encontrados  integer not null default 0 check (errores_encontrados >= 0),
  estado               text not null check (estado in ('COMPLETADA', 'COMPLETADA_CON_ERRORES', 'RECHAZADA', 'FALLIDA')),
  duracion_ms          integer check (duracion_ms >= 0),
  detalle              jsonb not null default '{}'::jsonb
);


-- ---------------------------------------------------------------------
-- 2. Detalle de errores por fila
-- ---------------------------------------------------------------------
create table if not exists public.importacion_producto_error (
  id_error       bigint generated always as identity primary key,
  id_importacion bigint not null references public.importacion_producto(id_importacion) on delete cascade,
  numero_fila    integer,
  codigo         text,
  mensaje        text not null
);


-- ---------------------------------------------------------------------
-- 3. Índices para la pantalla de historial
-- ---------------------------------------------------------------------
create index if not exists idx_importacion_fecha
  on public.importacion_producto (fecha desc);

create index if not exists idx_importacion_usuario
  on public.importacion_producto (id_usuario);

create index if not exists idx_importacion_error_importacion
  on public.importacion_producto_error (id_importacion);


-- ---------------------------------------------------------------------
-- 4. RLS: el admin lee, el servidor escribe
-- ---------------------------------------------------------------------
alter table public.importacion_producto enable row level security;
alter table public.importacion_producto_error enable row level security;

revoke all on public.importacion_producto from public, anon;
revoke all on public.importacion_producto_error from public, anon;

grant select on public.importacion_producto to authenticated;
grant select on public.importacion_producto_error to authenticated;
grant all on public.importacion_producto to service_role;
grant all on public.importacion_producto_error to service_role;

create policy "importacion: admin puede ver"
  on public.importacion_producto
  for select
  to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR');

create policy "importacion error: admin puede ver"
  on public.importacion_producto_error
  for select
  to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR');


-- Comentarios para quien mire la base desde el dashboard de Supabase.
comment on table public.importacion_producto is
  'Resumen de cada importación de productos desde Excel (historial de solo lectura)';
comment on table public.importacion_producto_error is
  'Filas rechazadas en una importación, con el motivo';
