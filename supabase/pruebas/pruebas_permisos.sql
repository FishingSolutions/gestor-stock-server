\pset pager off
\set admin_id '11111111-1111-1111-1111-111111111111'
\set emp_id   '22222222-2222-2222-2222-222222222222'

\echo '=== A. Estructura después de la migración'
select conname, confdeltype as al_borrar from pg_constraint
where conname in ('movimiento_stock_id_producto_fkey','movimiento_stock_id_usuario_fkey','usuario_id_usuario_fkey','uq_categoria_nombre','categoria_nombre_key')
order by 1;  -- r = restrict, c = cascade
select c.relname, c.relrowsecurity as rls, (select count(*) from pg_policies p where p.tablename = c.relname) as reglas
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;

\echo '=== B. Crear la cuenta de login del Admin Prueba (como en Authentication > Add user)'
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values (:'admin_id', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@stockfx.com', '{}', now(), now());
\echo '--> esperado: la fila existente se vincula con la cuenta y sigue siendo ADMINISTRADOR'
select id_usuario, email, rol from public.usuario order by email;

\echo '=== C. Alguien se registra pidiendo ser ADMINISTRADOR en sus datos'
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values (:'emp_id', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'empleado@stockfx.com', '{"nombre":"Juan","apellido":"Perez","rol":"ADMINISTRADOR"}', now(), now());
\echo '--> esperado: se crea como EMPLEADO igual'
select id_usuario, nombre, apellido, email, rol from public.usuario order by email;

\echo '=== D. Sin login (anon) leyendo productos --> esperado: permission denied'
begin; set local role anon;
select count(*) from public.producto;
rollback;

\echo '=== E. EMPLEADO ve productos --> esperado: 2'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
select count(*) as productos_visibles from public.producto;
rollback;

\echo '=== F. EMPLEADO intenta crear un producto --> esperado: error de RLS'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
insert into public.producto (codigo, nombre, stock_actual) values ('X1', 'Trucho', 1);
rollback;

\echo '=== G. EMPLEADO intenta cambiar stock directo --> esperado: 0 filas modificadas'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
update public.producto set stock_actual = 999 where codigo = 'COCA500';
rollback;

\echo '=== H. EMPLEADO intenta insertar un movimiento directo --> esperado: permission denied'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
insert into public.movimiento_stock (id_producto, id_usuario, tipo_movimiento, cantidad, motivo)
select id_producto, :'emp_id', 'ENTRADA', 1, 'x' from public.producto limit 1;
rollback;

\echo '=== I. EMPLEADO intenta hacerse ADMINISTRADOR --> esperado: 0 filas modificadas'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
update public.usuario set rol = 'ADMINISTRADOR' where id_usuario = :'emp_id';
rollback;

\echo '=== J. EMPLEADO ve usuarios --> esperado: solo su fila con la migración correcciones_esquema; a todos desde registrar_movimiento (KAN-37)'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
select email from public.usuario;
rollback;

\echo '=== K. ADMIN crea, modifica producto y ve todos los usuarios --> esperado: todo OK'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin_id', 'role', 'authenticated')::text, true);
insert into public.producto (codigo, nombre, precio_venta, stock_actual, stock_minimo, stock_maximo)
values ('ACEITE', 'Aceite 1,5L', 3000, 8, 2, 20) returning id_producto, nombre;
update public.producto set precio_venta = 1300 where codigo = 'COCA500' returning nombre, precio_venta;
select count(*) as usuarios_visibles from public.usuario;
rollback;

\echo '=== L. ADMIN intenta cambiarse el id o el email --> esperado: permission denied'
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin_id', 'role', 'authenticated')::text, true);
update public.usuario set email = 'otro@x.com' where id_usuario = :'admin_id';
rollback;

\echo '=== M. Usuario desactivado ya no ve productos --> esperado: 0'
begin;
update public.usuario set activo = false where id_usuario = :'emp_id';
set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'emp_id', 'role', 'authenticated')::text, true);
select count(*) as productos_visibles from public.producto;
rollback;

\echo '=== N. Movimiento sin usuario --> esperado: error not-null'
begin;
insert into public.movimiento_stock (id_producto, tipo_movimiento, cantidad, motivo, stock_anterior, stock_resultante)
select id_producto, 'ENTRADA', 1, 'x', 10, 11 from public.producto limit 1;
rollback;

\echo '=== O. Borrar un producto con movimientos --> esperado: error de foreign key'
begin;
insert into public.movimiento_stock (id_producto, id_usuario, tipo_movimiento, cantidad, motivo, stock_anterior, stock_resultante)
select id_producto, :'emp_id', 'SALIDA', 2, 'Venta', 10, 8 from public.producto where codigo = 'COCA500';
delete from public.producto where codigo = 'COCA500';
rollback;

\echo '=== P. Borrar un producto SIN movimientos --> esperado: se borra (DELETE 1)'
begin;
delete from public.producto where codigo = 'YERBA1K';
rollback;

\echo '=== Q. Categoría repetida --> esperado: error de unique (sigue habiendo una restricción)'
begin;
insert into public.categoria (nombre) values ('Bebidas');
rollback;

\echo '=== FIN'
