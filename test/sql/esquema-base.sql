-- =====================================================================
-- Esquema MÍNIMO para las pruebas de SQL del importador.
--
-- No es una copia completa de Supabase: solo las tablas, columnas,
-- restricciones y funciones que toca la importación, con los mismos nombres
-- y tipos que las migraciones reales de supabase/migrations.
-- Si cambia el esquema real, actualizá esto también.
-- =====================================================================

create schema if not exists auth;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- En Supabase la define el servicio de Auth; acá nadie está logueado.
create function auth.uid()
returns uuid
language sql
stable
as $$ select null::uuid $$;


create table public.usuario (
  id_usuario uuid primary key,
  nombre     varchar(100) not null,
  apellido   varchar(100) not null,
  email      varchar(255) not null unique,
  activo     boolean not null default true,
  rol        varchar(20) not null default 'EMPLEADO'
             check (rol in ('ADMINISTRADOR', 'EMPLEADO'))
);

create table public.categoria (
  id_categoria uuid primary key default gen_random_uuid(),
  nombre       varchar(100) not null,
  descripcion  text,
  constraint categoria_nombre_key unique (nombre)
);

create table public.producto (
  id_producto  bigint generated always as identity primary key,
  codigo       varchar(50) not null,
  nombre       varchar(150) not null,
  descripcion  text,
  precio_costo numeric(12,2) not null default 0 check (precio_costo >= 0),
  precio_venta numeric(12,2) not null default 0 check (precio_venta >= 0),
  stock_actual integer not null default 0 check (stock_actual >= 0),
  stock_minimo integer not null default 0 check (stock_minimo >= 0),
  stock_maximo integer not null default 0 check (stock_maximo >= stock_minimo),
  activo       boolean not null default true,
  id_categoria uuid references public.categoria(id_categoria) on delete set null,
  fecha_alta   timestamptz default now(),
  constraint producto_codigo_key unique (codigo)
);

create function public.rol_actual()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select rol
  from public.usuario
  where id_usuario = (select auth.uid())
    and activo;
$$;

grant usage on schema public to authenticated, service_role;
