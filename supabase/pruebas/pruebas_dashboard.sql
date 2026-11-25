-- Pruebas del Dashboard y la vista Productos.
-- Se corre después de: db reset --local  +  datos_demo.sql
-- Cada línea dice OK o FALLO con el valor obtenido y el esperado.
\pset pager off
\pset tuples_only on
\set emp   'set local role authenticated; set local request.jwt.claims to ''{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}'';'
\set inac  'set local role authenticated; set local request.jwt.claims to ''{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}'';'

create temp table chk (orden serial, prueba text, obtenido text, esperado text);
grant all on chk to authenticated;
grant usage on sequence chk_orden_seq to authenticated;

\echo '=== kpis_productos() como EMPLEADO'
begin; :emp
insert into chk (prueba, obtenido, esperado)
select x.prueba, x.obtenido, x.esperado
from public.kpis_productos() k,
lateral (values
  ('KPI total_productos',          k->>'total_productos',          '10'),
  ('KPI productos_activos',        k->>'productos_activos',        '9'),
  ('KPI productos_inactivos',      k->>'productos_inactivos',      '1'),
  ('KPI nuevos_este_mes',          k->>'nuevos_este_mes',          '3'),
  ('KPI variacion_mes_pct',        k->>'variacion_mes_pct',        '50.0'),
  ('KPI unidades_en_stock',        k->>'unidades_en_stock',        '140'),
  ('KPI valor_stock_costo',        k->>'valor_stock_costo',        '126550.00'),
  ('KPI valor_stock_venta',        k->>'valor_stock_venta',        '194500.00'),
  ('KPI stock_normal',             k->>'stock_normal',             '4'),
  ('KPI porcentaje_stock_normal',  k->>'porcentaje_stock_normal',  '44.4'),
  ('KPI stock_bajo (bajo+crítico)',k->>'stock_bajo',               '3'),
  ('KPI stock_critico',            k->>'stock_critico',            '1'),
  ('KPI sin_stock',                k->>'sin_stock',                '2')
) as x(prueba, obtenido, esperado);
commit;

\echo '=== dashboard_resumen() como EMPLEADO (7 días, 5 ítems)'
begin; :emp
insert into chk (prueba, obtenido, esperado)
select x.prueba, x.obtenido, x.esperado
from public.dashboard_resumen() d,
lateral (values
  ('Reponer: total',               d->'productos_a_reponer'->>'total', '5'),
  ('Reponer: orden por urgencia',  (select string_agg(i->>'codigo', ',' order by n)
                                    from jsonb_array_elements(d->'productos_a_reponer'->'items') with ordinality as a(i, n)),
                                   'FIDEOS500,LECHE1L,YERBA1K,AGUA2L,LAVANDINA'),
  ('Reponer: estados',             (select string_agg(i->>'estado_stock', ',' order by n)
                                    from jsonb_array_elements(d->'productos_a_reponer'->'items') with ordinality as a(i, n)),
                                   'SIN_STOCK,SIN_STOCK,CRITICO,BAJO,BAJO'),
  ('Balance: cantidad de días',    jsonb_array_length(d->'balance'->'dias')::text, '7'),
  ('Balance: total entradas',      d->'balance'->>'total_entradas', '30'),
  ('Balance: total salidas',       d->'balance'->>'total_salidas',  '31'),
  ('Balance: flujo neto',          d->'balance'->>'flujo_neto',     '-1'),
  ('Balance: ajustes',             d->'balance'->>'total_ajustes',  '1'),
  ('Balance: por día (E/S)',       (select string_agg((i->>'entradas') || '/' || (i->>'salidas'), ' ' order by i->>'fecha')
                                    from jsonb_array_elements(d->'balance'->'dias') i),
                                   '30/0 0/0 0/0 0/12 0/5 0/4 0/10'),
  ('Últimos: cantidad',            jsonb_array_length(d->'ultimos_movimientos')::text, '5'),
  ('Últimos: orden',               (select string_agg((i->>'tipo_movimiento') || ':' || (i->>'codigo'), ',' order by n)
                                    from jsonb_array_elements(d->'ultimos_movimientos') with ordinality as a(i, n)),
                                   'AJUSTE:YOGUR1L,SALIDA:YOGUR1L,SALIDA:COCA500,SALIDA:DETERG750,SALIDA:ARROZ1K'),
  ('Últimos: autor',               d->'ultimos_movimientos'->0->>'usuario_nombre', 'Admin')
) as x(prueba, obtenido, esperado);
commit;

\echo '=== dashboard_resumen(30, 3)'
begin; :emp
insert into chk (prueba, obtenido, esperado)
select x.prueba, x.obtenido, x.esperado
from public.dashboard_resumen(30, 3) d,
lateral (values
  ('30 días: cantidad de días',    jsonb_array_length(d->'balance'->'dias')::text, '30'),
  ('30 días: total entradas',      d->'balance'->>'total_entradas', '40'),
  ('Límite 3: ítems a reponer',    jsonb_array_length(d->'productos_a_reponer'->'items')::text, '3'),
  ('Límite 3: total igual a 5',    d->'productos_a_reponer'->>'total', '5'),
  ('Límite 3: últimos movimientos',jsonb_array_length(d->'ultimos_movimientos')::text, '3')
) as x(prueba, obtenido, esperado);
commit;

\echo '=== v_producto: filtros y orden como los usaría el front'
begin; :emp
insert into chk (prueba, obtenido, esperado) values
  ('v_producto: filas visibles',
     (select count(*)::text from public.v_producto), '10'),
  ('v_producto: estado Yerba',
     (select estado_stock from public.v_producto where codigo = 'YERBA1K'), 'CRITICO'),
  ('v_producto: Detergente sin mínimo = NORMAL',
     (select estado_stock from public.v_producto where codigo = 'DETERG750'), 'NORMAL'),
  ('v_producto: Lavandina igual al mínimo = BAJO',
     (select estado_stock from public.v_producto where codigo = 'LAVANDINA'), 'BAJO'),
  ('v_producto: categoría incluida',
     (select categoria from public.v_producto where codigo = 'LECHE1L'), 'Lácteos'),
  ('v_producto: búsqueda "yo" en nombre o código',
     (select string_agg(codigo, ',' order by codigo) from public.v_producto where nombre ilike '%yo%' or codigo ilike '%yo%'), 'YOGUR1L'),
  ('v_producto: página 2 de a 3 por nombre',
     (select string_agg(codigo, ',' order by n) from (
        select codigo, row_number() over () n from (
          select codigo from public.v_producto where activo order by nombre limit 3 offset 3) s) t),
     'DETERG750,FIDEOS500,LAVANDINA'),
  ('v_movimiento: variación del ajuste',
     (select variacion::text from public.v_movimiento where tipo_movimiento = 'AJUSTE'), '-1');
commit;

\echo '=== Permisos'
-- Usuario inactivo: las funciones lo rechazan
begin; :inac
do $$ begin
  perform public.kpis_productos();
  insert into chk (prueba, obtenido, esperado) values ('Inactivo: kpis_productos', 'permitido', 'rechazado');
exception when others then
  insert into chk (prueba, obtenido, esperado) values ('Inactivo: kpis_productos', 'rechazado', 'rechazado');
end $$;
do $$ begin
  perform public.dashboard_resumen();
  insert into chk (prueba, obtenido, esperado) values ('Inactivo: dashboard_resumen', 'permitido', 'rechazado');
exception when others then
  insert into chk (prueba, obtenido, esperado) values ('Inactivo: dashboard_resumen', 'rechazado', 'rechazado');
end $$;
insert into chk (prueba, obtenido, esperado)
  values ('Inactivo: v_producto vacía', (select count(*)::text from public.v_producto), '0');
commit;

-- Sin login (anon): ni las vistas ni las funciones
insert into chk (prueba, obtenido, esperado) values
  ('anon: SELECT v_producto',     has_table_privilege('anon', 'public.v_producto', 'SELECT')::text, 'false'),
  ('anon: SELECT v_movimiento',   has_table_privilege('anon', 'public.v_movimiento', 'SELECT')::text, 'false'),
  ('anon: EXECUTE kpis_productos',has_function_privilege('anon', 'public.kpis_productos()', 'EXECUTE')::text, 'false'),
  ('anon: EXECUTE dashboard',     has_function_privilege('anon', 'public.dashboard_resumen(integer,integer)', 'EXECUTE')::text, 'false'),
  ('Vistas con security_invoker', (select string_agg(relname, ',' order by relname) from pg_class
                                   where relname in ('v_producto','v_movimiento')
                                     and 'security_invoker=true' = any(reloptions)), 'v_movimiento,v_producto');

-- Parámetros inválidos
begin; :emp
do $$ begin
  perform public.dashboard_resumen(0, 5);
  insert into chk (prueba, obtenido, esperado) values ('p_dias = 0', 'permitido', 'rechazado');
exception when others then
  insert into chk (prueba, obtenido, esperado) values ('p_dias = 0', 'rechazado', 'rechazado');
end $$;
commit;

\echo
\echo '=== RESULTADOS'
select format('%-4s %-46s obtenido=%s esperado=%s',
              case when obtenido is not distinct from esperado then 'OK' else 'FALLO' end,
              prueba, coalesce(obtenido, 'null'), esperado)
from chk order by orden;
select format('TOTAL: %s pruebas, %s OK, %s FALLO',
              count(*), count(*) filter (where obtenido is not distinct from esperado),
              count(*) filter (where obtenido is distinct from esperado))
from chk;
