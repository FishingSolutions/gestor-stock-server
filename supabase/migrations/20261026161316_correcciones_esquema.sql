-- =====================================================================
-- Correcciones al esquema inicial de StockFX
--
--   1. Permisos para que la app pueda leer y escribir las tablas
--   2. Seguridad por filas (RLS) según el rol del usuario
--   3. La tabla usuario queda conectada con el login de Supabase (auth.users)
--   4. No se puede borrar un producto o usuario que tenga movimientos
--   + Se quita una restricción UNIQUE repetida en categoria.nombre
--
-- Roles:
--   ADMINISTRADOR: ve y modifica productos, categorías y usuarios.
--   EMPLEADO:      ve productos, categorías y movimientos.
--                  Los movimientos se registran solo con la función
--                  registrar_movimiento (KAN-37), nunca insertando directo.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Restricción repetida: categoria.nombre ya tiene categoria_nombre_key
-- ---------------------------------------------------------------------
alter table public.categoria drop constraint if exists uq_categoria_nombre;


-- ---------------------------------------------------------------------
-- 4. Historial de movimientos protegido
--    Antes: borrar un producto borraba sus movimientos (CASCADE) y borrar
--    un usuario dejaba movimientos sin autor (SET NULL).
--    Ahora: no se puede borrar ninguno de los dos si tiene movimientos.
--    Para "dar de baja" se usa activo = false.
-- ---------------------------------------------------------------------
alter table public.movimiento_stock
  drop constraint movimiento_stock_id_producto_fkey,
  add constraint movimiento_stock_id_producto_fkey
    foreign key (id_producto) references public.producto (id_producto)
    on delete restrict;

alter table public.movimiento_stock
  drop constraint movimiento_stock_id_usuario_fkey,
  add constraint movimiento_stock_id_usuario_fkey
    foreign key (id_usuario) references public.usuario (id_usuario)
    on update cascade
    on delete restrict;

-- Todo movimiento tiene que tener un usuario responsable
alter table public.movimiento_stock alter column id_usuario set not null;


-- ---------------------------------------------------------------------
-- 3. usuario conectado con el login de Supabase
--    El id de cada fila de usuario es el mismo id de auth.users.
-- ---------------------------------------------------------------------
alter table public.usuario alter column id_usuario drop default;
alter table public.usuario alter column rol set default 'EMPLEADO';

-- NOT VALID: no revisa las filas que ya existen (el Admin Prueba todavía
-- no tiene cuenta de login), pero sí todas las filas nuevas o modificadas.
alter table public.usuario
  add constraint usuario_id_usuario_fkey
    foreign key (id_usuario) references auth.users (id)
    on delete cascade
    not valid;

-- Cuando se crea una cuenta de login, se crea (o se vincula) su fila en usuario.
--   - Si ya existe un usuario con ese email (como admin@stockfx.com),
--     se le asigna el id de la cuenta y conserva su rol.
--   - Si no existe, se crea como EMPLEADO. El rol nunca se toma de los
--     datos que manda quien se registra, para que nadie se haga admin solo.
create or replace function public.crear_usuario_desde_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.usuario (id_usuario, nombre, apellido, email, rol)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'nombre', ''), split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'apellido', ''),
    new.email,
    'EMPLEADO'
  )
  on conflict (email) do update
    set id_usuario = excluded.id_usuario;
  return new;
end;
$$;

revoke execute on function public.crear_usuario_desde_auth() from public, anon, authenticated;

create trigger al_crear_cuenta_de_login
  after insert on auth.users
  for each row execute function public.crear_usuario_desde_auth();


-- ---------------------------------------------------------------------
-- Rol del usuario logueado (null si no tiene fila en usuario o está inactivo)
-- security definer: puede leer usuario sin chocar con sus propias reglas RLS
-- ---------------------------------------------------------------------
create or replace function public.rol_actual()
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

revoke execute on function public.rol_actual() from public, anon;
grant execute on function public.rol_actual() to authenticated;


-- ---------------------------------------------------------------------
-- 1. Permisos de tabla
--    anon (sin login): nada.
--    authenticated: lo justo; las reglas RLS de abajo deciden qué filas.
--    service_role: todo (es la clave secreta del servidor, ignora RLS).
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.categoria, public.producto to authenticated;
grant select on public.movimiento_stock to authenticated;
grant select on public.usuario to authenticated;
grant update (nombre, apellido, rol, activo) on public.usuario to authenticated;

grant all on public.categoria, public.producto, public.movimiento_stock, public.usuario to service_role;


-- ---------------------------------------------------------------------
-- 2. Seguridad por filas (RLS)
-- ---------------------------------------------------------------------
alter table public.categoria        enable row level security;
alter table public.producto         enable row level security;
alter table public.movimiento_stock enable row level security;
alter table public.usuario          enable row level security;

-- categoria
create policy "categoria: usuarios activos pueden ver"
  on public.categoria for select to authenticated
  using ((select public.rol_actual()) is not null);

create policy "categoria: admin puede crear"
  on public.categoria for insert to authenticated
  with check ((select public.rol_actual()) = 'ADMINISTRADOR');

create policy "categoria: admin puede modificar"
  on public.categoria for update to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR')
  with check ((select public.rol_actual()) = 'ADMINISTRADOR');

create policy "categoria: admin puede borrar"
  on public.categoria for delete to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR');

-- producto
create policy "producto: usuarios activos pueden ver"
  on public.producto for select to authenticated
  using ((select public.rol_actual()) is not null);

create policy "producto: admin puede crear"
  on public.producto for insert to authenticated
  with check ((select public.rol_actual()) = 'ADMINISTRADOR');

create policy "producto: admin puede modificar"
  on public.producto for update to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR')
  with check ((select public.rol_actual()) = 'ADMINISTRADOR');

create policy "producto: admin puede borrar"
  on public.producto for delete to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR');

-- movimiento_stock: solo lectura. Se registran con registrar_movimiento (KAN-37)
-- y no se modifican ni se borran: son el historial.
create policy "movimiento: usuarios activos pueden ver"
  on public.movimiento_stock for select to authenticated
  using ((select public.rol_actual()) is not null);

-- usuario: cada uno ve su propia fila; el admin ve y modifica a todos
create policy "usuario: ver la propia fila o admin ve todas"
  on public.usuario for select to authenticated
  using (
    id_usuario = (select auth.uid())
    or (select public.rol_actual()) = 'ADMINISTRADOR'
  );

create policy "usuario: admin puede modificar"
  on public.usuario for update to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR')
  with check ((select public.rol_actual()) = 'ADMINISTRADOR');
