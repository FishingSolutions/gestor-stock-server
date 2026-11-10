-- =====================================================================
-- Datos de demo para probar el Dashboard y la vista Productos.
-- SOLO PARA LA BASE LOCAL: se corre después de `npx supabase db reset --local`.
--
-- Usuarios de prueba (solo existen en la base local de tu compu):
--   admin@stockfx.com     ADMINISTRADOR   contraseña: demo-local-123
--   empleado@stockfx.com  EMPLEADO        contraseña: demo-local-123
--   inactivo@stockfx.com  EMPLEADO, activo = false
--
-- Resultado esperado (lo verifica pruebas_dashboard.sql):
--   9 productos activos + 1 inactivo
--   NORMAL: Coca, Arroz, Detergente, Yogur | BAJO: Agua, Lavandina
--   CRITICO: Yerba | SIN_STOCK: Fideos, Leche
-- =====================================================================

-- Cuentas de login (el trigger crea la fila en usuario como EMPLEADO)
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       email, extensions.crypt('demo-local-123', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', meta::jsonb, now(), now(),
       '', '', '', ''
from (values
  ('11111111-1111-1111-1111-111111111111', 'admin@stockfx.com',    '{"nombre":"Admin","apellido":"Prueba"}'),
  ('22222222-2222-2222-2222-222222222222', 'empleado@stockfx.com', '{"nombre":"Mariana","apellido":"Valenzuela"}'),
  ('33333333-3333-3333-3333-333333333333', 'inactivo@stockfx.com', '{"nombre":"Ex","apellido":"Empleado"}')
) as u(id, email, meta);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at)
select gen_random_uuid(), id, id::text, 'email',
       jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true), now(), now(), now()
from auth.users;

update public.usuario set rol = 'ADMINISTRADOR' where email = 'admin@stockfx.com';
update public.usuario set activo = false        where email = 'inactivo@stockfx.com';

-- Categorías
insert into public.categoria (nombre) values ('Bebidas'), ('Almacén'), ('Limpieza'), ('Lácteos');

-- Productos (stock inicial, antes de los movimientos)
insert into public.producto
  (codigo, nombre, descripcion, precio_costo, precio_venta, stock_actual, stock_minimo, stock_maximo, activo, fecha_alta, id_categoria)
select v.codigo, v.nombre, v.descripcion, v.costo, v.venta, v.stock, v.minimo, v.maximo, v.activo,
       case when v.alta_dias is null then null else now() - make_interval(days => v.alta_dias) end,
       c.id_categoria
from (values
  ('COCA500',   'Coca-Cola 500ml',        'Gaseosa',        800,  1200, 40, 10,  80, true,  60,   'Bebidas'),
  ('AGUA2L',    'Agua mineral 2L',        'Sin gas',        500,   900,  6, 10,  50, true,  60,   'Bebidas'),
  ('YERBA1K',   'Yerba mate 1kg',         'Con palo',      3000,  4500,  3,  8,  40, true,  60,   'Almacén'),
  ('FIDEOS500', 'Fideos tirabuzón 500g',  'Pasta seca',     700,  1100,  0, 15,  60, true,  60,   'Almacén'),
  ('ARROZ1K',   'Arroz largo fino 1kg',   null,             900,  1400, 25, 10,  60, true,  60,   'Almacén'),
  ('LAVANDINA', 'Lavandina 1L',           null,             600,   950, 10, 10,  40, true,  60,   'Limpieza'),
  ('DETERG750', 'Detergente 750ml',       'Limón',         1100,  1700, 30,  0,  40, true,   0,   'Limpieza'),
  ('LECHE1L',   'Leche entera 1L',        'Sachet',        1000,  1500,  0, 20,  80, true,   2,   'Lácteos'),
  ('YOGUR1L',   'Yogur bebible 1L',       'Frutilla',       850,  1300, 18, 12,  40, true,   5,   'Lácteos'),
  ('VIEJO01',   'Producto discontinuado', null,             100,   200,  0,  5,  10, false, null, 'Almacén')
) as v(codigo, nombre, descripcion, costo, venta, stock, minimo, maximo, activo, alta_dias, categoria)
join public.categoria c on c.nombre = v.categoria;

-- Movimientos registrados con la función real (como lo haría el front),
-- y después se les pone una fecha de los últimos días.
do $$
declare
  v_tz  constant text := 'America/Argentina/Buenos_Aires';
  r     record;
  v_mov public.movimiento_stock;
begin
  for r in
    select * from (values
      -- quien,      producto,    tipo,      cant, motivo,                 hace_dias, hora
      ('empleado', 'ARROZ1K',   'ENTRADA',  10, 'Compra mensual',          20, '09:00'),
      ('empleado', 'COCA500',   'ENTRADA',  24, 'Llegó el proveedor',       6, '10:00'),
      ('empleado', 'YOGUR1L',   'ENTRADA',   6, 'Reposición',               6, '11:00'),
      ('empleado', 'COCA500',   'SALIDA',   12, 'Venta mostrador',          3, '15:30'),
      ('empleado', 'ARROZ1K',   'SALIDA',    5, 'Venta mostrador',          2, '18:10'),
      ('admin',    'DETERG750', 'SALIDA',    4, 'Venta mostrador',          1, '12:00'),
      ('empleado', 'COCA500',   'SALIDA',    6, 'Venta mostrador',          0, '09:15'),
      ('empleado', 'YOGUR1L',   'SALIDA',    4, 'Venta mostrador',          0, '09:40'),
      ('admin',    'YOGUR1L',   'AJUSTE',   19, 'Conteo físico',            0, '10:05')
    ) as t(quien, codigo, tipo, cantidad, motivo, hace_dias, hora)
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select id_usuario from public.usuario where email = r.quien || '@stockfx.com'))::text,
      true);

    select * into v_mov
    from public.registrar_movimiento(
      (select id_producto from public.producto where codigo = r.codigo),
      r.tipo, r.cantidad, r.motivo);

    update public.movimiento_stock
    set fecha_movimiento = (((now() at time zone v_tz)::date - r.hace_dias) + r.hora::time) at time zone v_tz
    where id_movimiento = v_mov.id_movimiento;
  end loop;
end;
$$;

select codigo, stock_actual, stock_minimo from public.producto order by codigo;
