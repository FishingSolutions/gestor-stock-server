-- Prueba de rendimiento del Dashboard y la vista Productos.
-- SOLO BASE LOCAL. Se corre después de datos_demo.sql.
-- Agrega 5.000 productos y 100.000 movimientos (90 días) y mide cada consulta
-- como la haría un EMPLEADO logueado (con RLS activo).
\pset pager off
\timing off

insert into public.producto (codigo, nombre, precio_costo, precio_venta, stock_actual, stock_minimo, stock_maximo, id_categoria, fecha_alta)
select 'PERF' || g, 'Producto de prueba ' || g, 100 + g % 900, 200 + g % 1500,
       (g * 7) % 120, (g * 3) % 40, 200,
       (select id_categoria from public.categoria order by nombre limit 1 offset g % 4),
       now() - make_interval(days => g % 90)
from generate_series(1, 5000) g;

insert into public.movimiento_stock (id_producto, id_usuario, tipo_movimiento, cantidad, motivo, stock_anterior, stock_resultante, fecha_movimiento)
select p.id_producto,
       '22222222-2222-2222-2222-222222222222',
       case when g % 2 = 0 then 'ENTRADA' else 'SALIDA' end,
       1 + g % 20, 'Carga de prueba', 50, 50,
       now() - make_interval(mins => (g * 37) % (90 * 24 * 60))
from generate_series(1, 100000) g
join public.producto p on p.codigo = 'PERF' || (1 + g % 5000);

analyze public.producto;
analyze public.movimiento_stock;

select (select count(*) from public.producto) as productos, (select count(*) from public.movimiento_stock) as movimientos;

\timing on
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

\echo '--- dashboard_resumen(7, 5)'
select length(public.dashboard_resumen(7, 5)::text) as bytes;
\echo '--- dashboard_resumen(30, 5)'
select length(public.dashboard_resumen(30, 5)::text) as bytes;
\echo '--- kpis_productos()'
select length(public.kpis_productos()::text) as bytes;
\echo '--- v_producto: página de 10 filtrada por estado, con total (como PostgREST con count=exact)'
select count(*) over () as total, codigo from public.v_producto
where activo and estado_stock in ('BAJO', 'CRITICO', 'SIN_STOCK')
order by prioridad, nombre limit 10;
\echo '--- v_movimiento: últimos 20 del historial'
select count(*) from (select * from public.v_movimiento order by fecha_movimiento desc limit 20) t;
\echo '--- ANTES (front actual): descargar TODOS los productos para calcular KPIs en el navegador'
select count(*) as filas, pg_size_pretty(sum(length(row_to_json(p)::text))::bigint) as datos
from (select id_producto, codigo, nombre, descripcion, precio_costo, precio_venta, stock_actual,
             stock_minimo, stock_maximo, activo, id_categoria from public.producto) p;
commit;
