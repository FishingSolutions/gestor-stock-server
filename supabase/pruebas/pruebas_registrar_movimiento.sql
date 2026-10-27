-- Pruebas de registrar_movimiento (KAN-37)
-- Se corre después de: reset a remote_schema + simular_base_actual.sql + migration up
-- (ver supabase/README.md, sección "Probar en la base local").
\pset pager off
\set admin_id '11111111-1111-1111-1111-111111111111'
\set emp_id   '22222222-2222-2222-2222-222222222222'
\set tres_id  '33333333-3333-3333-3333-333333333333'

-- Preparación: cuentas de login (el trigger crea/vincula las filas de usuario)
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
  (:'admin_id', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@stockfx.com', '{}', now(), now()),
  (:'emp_id',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'empleado@stockfx.com', '{"nombre":"Juan","apellido":"Perez"}', now(), now()),
  (:'tres_id',  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inactivo@stockfx.com', '{}', now(), now());
update public.usuario set activo = false where id_usuario = :'tres_id';
-- Un producto dado de baja para probar
insert into public.producto (codigo, nombre, stock_actual, activo) values ('VIEJO', 'Producto discontinuado', 5, false);
\set coca  '(select id_producto from public.producto where codigo = ''COCA500'')'
\set yerba '(select id_producto from public.producto where codigo = ''YERBA1K'')'
\set viejo '(select id_producto from public.producto where codigo = ''VIEJO'')'
select codigo, stock_actual from public.producto order by codigo;

-- Cada prueba entra como un usuario (igual que el front con sesión iniciada)
\set como_emp   'set local role authenticated; set local request.jwt.claims to ''{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}'';'
\set como_admin 'set local role authenticated; set local request.jwt.claims to ''{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}'';'
\set como_inac  'set local role authenticated; set local request.jwt.claims to ''{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}'';'
\set mostrar 'select tipo_movimiento, cantidad, stock_anterior, stock_resultante, motivo from public.registrar_movimiento'

\echo '=== 1. EMPLEADO: ENTRADA de 5 Coca (stock 10) --> esperado: 10 -> 15'
begin; :como_emp
:mostrar (:coca, 'ENTRADA', 5, 'Llegó el proveedor');
commit;

\echo '=== 2. EMPLEADO: SALIDA de 3, tipo en minúscula --> esperado: 15 -> 12'
begin; :como_emp
:mostrar (:coca, 'salida', 3, 'Venta mostrador');
commit;

\echo '=== 3. EMPLEADO: SALIDA de 100 --> esperado: error "Stock insuficiente ... hay 12"'
begin; :como_emp
:mostrar (:coca, 'SALIDA', 100, 'Venta');
commit;

\echo '=== 4. EMPLEADO: SALIDA de todo el stock (12) --> esperado: 12 -> 0'
begin; :como_emp
:mostrar (:coca, 'SALIDA', 12, 'Venta mayorista');
commit;

\echo '=== 5. EMPLEADO: SALIDA de 1 con stock 0 --> esperado: error "Stock insuficiente"'
begin; :como_emp
:mostrar (:coca, 'SALIDA', 1, 'Venta');
commit;

\echo '=== 6. Cantidad 0 --> esperado: error "mayor a 0"'
begin; :como_emp
:mostrar (:coca, 'ENTRADA', 0, 'x');
commit;

\echo '=== 7. Cantidad negativa --> esperado: error "mayor a 0"'
begin; :como_emp
:mostrar (:coca, 'ENTRADA', -5, 'x');
commit;

\echo '=== 8. Tipo inválido --> esperado: error "Tipo de movimiento inválido"'
begin; :como_emp
:mostrar (:coca, 'VENTA', 1, 'x');
commit;

\echo '=== 9. Motivo vacío --> esperado: error "motivo es obligatorio"'
begin; :como_emp
:mostrar (:coca, 'ENTRADA', 1, '   ');
commit;

\echo '=== 10. Producto que no existe --> esperado: error "no existe"'
begin; :como_emp
:mostrar (999999, 'ENTRADA', 1, 'x');
commit;

\echo '=== 11. Producto dado de baja --> esperado: error "dado de baja"'
begin; :como_emp
:mostrar (:viejo, 'ENTRADA', 1, 'x');
commit;

\echo '=== 12. EMPLEADO intenta AJUSTE --> esperado: error "Solo un administrador"'
begin; :como_emp
:mostrar (:yerba, 'AJUSTE', 7, 'Conteo');
commit;

\echo '=== 13. ADMIN: AJUSTE Yerba, sistema 3 y contó 7 --> esperado: cantidad 4, 3 -> 7'
begin; :como_admin
:mostrar (:yerba, 'AJUSTE', 7, 'Conteo físico');
commit;

\echo '=== 14. ADMIN: AJUSTE Yerba, contó 2 (faltan) --> esperado: cantidad 5, 7 -> 2'
begin; :como_admin
:mostrar (:yerba, 'AJUSTE', 2, 'Conteo físico: faltante');
commit;

\echo '=== 15. ADMIN: AJUSTE igual al sistema --> esperado: error "no hay nada que ajustar"'
begin; :como_admin
:mostrar (:yerba, 'AJUSTE', 2, 'Conteo');
commit;

\echo '=== 16. Usuario inactivo --> esperado: error "No tenés permiso"'
begin; :como_inac
:mostrar (:coca, 'ENTRADA', 1, 'x');
commit;

\echo '=== 17. Sin login (anon) --> esperado: permission denied for function'
select id_producto as coca_id from public.producto where codigo = 'COCA500' \gset
begin; set local role anon;
:mostrar (:coca_id, 'ENTRADA', 1, 'x');
commit;

\echo '=== 18. EMPLEADO ve el historial con el autor de cada movimiento (también los del admin)'
begin; :como_emp
select p.codigo, m.tipo_movimiento, m.cantidad, m.stock_anterior, m.stock_resultante, u.email as quien
from public.movimiento_stock m
join public.producto p using (id_producto)
left join public.usuario u using (id_usuario)
order by m.id_movimiento;
commit;

\echo '=== 19. Stock final --> esperado: COCA500 0, YERBA1K 2, VIEJO 5'
select codigo, stock_actual from public.producto order by codigo;
\echo '=== FIN'
