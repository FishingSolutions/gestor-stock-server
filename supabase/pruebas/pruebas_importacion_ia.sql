-- =====================================================================
-- Pruebas de confirmar_importacion_productos (importación con IA)
--
-- Se corre con psql sobre la base local, después de aplicar las
-- migraciones y datos_demo.sql. Todo pasa dentro de transacciones que
-- terminan en ROLLBACK: no deja datos ni historial.
--
--   docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres \
--     < supabase/pruebas/pruebas_importacion_ia.sql
--
-- El flujo normal es por la API (ver prueba_importacion_ia.sh). Estas
-- pruebas llaman a la función SQL directamente para verificar que la base
-- se defiende sola aunque alguien saltee la Edge Function.
-- =====================================================================
\pset pager off
-- Las pruebas de reglas SQL ejecutan como owner para seguir cubriendo la RPC
-- subyacente, ahora privada para authenticated. La identidad se simula con
-- claims y el control de permisos de ambas RPC se prueba aparte.
\set como_admin 'set local role postgres; set local request.jwt.claims to ''{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}'';'
\set como_emp   'set local role postgres; set local request.jwt.claims to ''{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}'';'
\set coca      '(select id_producto from public.producto where codigo = ''COCA500'')'
\set agua      '(select id_producto from public.producto where codigo = ''AGUA2L'')'

\echo '=== 1. EMPLEADO: no puede confirmar ninguna importación'
begin; :como_emp
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000001', 'api.xlsx', null, null, null,
  $f$[{"fila":2,"codigo":"Q1","nombre":"Trucho","precio":10}]$f$::jsonb
);
rollback;

\echo ''
\echo '=== 2. Fila inválida (precio 0): RECHAZADA y no crea nada'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000002', 'invalida.xlsx', null, null, null,
  $f$[{"fila":2,"codigo":"INV1","nombre":"Producto inválido","precio":0,"stock":3}]$f$::jsonb
);
select count(*) as inv1_creados from public.producto where codigo = 'INV1';
select estado from public.importacion_producto where archivo = 'invalida.xlsx';
select numero_fila, mensaje from public.importacion_producto_error
 where id_importacion = (select max(id_importacion) from public.importacion_producto);
rollback;

\echo ''
\echo '=== 3. Lote mixto (una fila mala): no se aplica la buena'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000003', 'mixto.xlsx', null, null, null,
  $f$[
    {"fila":2,"codigo":"MIX1","nombre":"Producto bueno","precio":100,"stock":5},
    {"fila":3,"codigo":"MIX2","nombre":"Producto malo","precio":100,"stock":-1}
  ]$f$::jsonb
);
select count(*) as mix_creados from public.producto where codigo in ('MIX1','MIX2');
select numero_fila, mensaje from public.importacion_producto_error
 where id_importacion = (select max(id_importacion) from public.importacion_producto);
rollback;

\echo ''
\echo '=== 4. SUMAR stock de AGUA2L (6 -> 10): movimiento ENTRADA'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000004', 'sumar.xlsx', null, null, 'SUMAR',
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'AGUA2L', 'nombre', 'Agua mineral 2L', 'stock', 4, 'accion', 'ACTUALIZAR'
  ))
);
select stock_actual from public.producto where codigo = 'AGUA2L';
select tipo_movimiento, cantidad, stock_anterior, stock_resultante
  from public.movimiento_stock
 where id_producto = :agua and motivo like 'Importación de Excel%'
 order by id_movimiento desc limit 1;
rollback;

\echo ''
\echo '=== 5. REEMPLAZAR stock de AGUA2L (6 -> 99): movimiento AJUSTE'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000005', 'reemplazar.xlsx', null, null, 'REEMPLAZAR',
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'AGUA2L', 'nombre', 'Agua mineral 2L', 'stock', 99, 'accion', 'ACTUALIZAR'
  ))
);
select stock_actual from public.producto where codigo = 'AGUA2L';
select tipo_movimiento, cantidad, stock_anterior, stock_resultante
  from public.movimiento_stock
 where id_producto = :agua and motivo like 'Importación de Excel%'
 order by id_movimiento desc limit 1;
rollback;

\echo ''
\echo '=== 6. REEMPLAZAR con el mismo stock: no genera movimiento'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000006', 'igual.xlsx', null, null, 'REEMPLAZAR',
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'AGUA2L', 'nombre', 'Agua mineral 2L', 'stock', 6, 'accion', 'ACTUALIZAR'
  ))
);
select count(*) as movimientos_nuevos
  from public.movimiento_stock
 where id_producto = :agua and motivo like 'Importación de Excel%';
rollback;

\echo ''
\echo '=== 7. Producto nuevo con stock 7: entra en 0 y luego ENTRADA de 7'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000007', 'nuevo.xlsx', null, null, 'REEMPLAZAR',
  $f$[{"fila":2,"codigo":"0001","nombre":"Producto con ceros","precio":500,"stock":7}]$f$::jsonb
);
select codigo, stock_actual from public.producto where codigo = '0001';
select tipo_movimiento, cantidad, stock_anterior, stock_resultante
  from public.movimiento_stock
 where id_producto = (select id_producto from public.producto where codigo = '0001');
rollback;

\echo ''
\echo '=== 8. Idempotencia: la misma clave y el mismo archivo no duplica'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000008', 'idem.xlsx', null, null, 'SUMAR',
  $f$[{"fila":2,"codigo":"IDEM1","nombre":"Producto idempotente","precio":10,"stock":2}]$f$::jsonb,
  false, $d${"hashArchivo":"hash-1"}$d$::jsonb
) ->> 'repetida' as primera_vez;

select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000008', 'idem.xlsx', null, null, 'SUMAR',
  $f$[{"fila":2,"codigo":"IDEM1","nombre":"Producto idempotente","precio":10,"stock":2}]$f$::jsonb,
  false, $d${"hashArchivo":"hash-1"}$d$::jsonb
) ->> 'repetida' as segunda_vez;

select count(*) as productos_idem from public.producto where codigo = 'IDEM1';
rollback;

\echo ''
\echo '=== 8b. Misma clave, contenido final distinto: conflicto'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000008', 'idem.xlsx', null, null, 'SUMAR',
  $f$[{"fila":2,"codigo":"IDEM1","nombre":"Producto idempotente","precio":10,"stock":2}]$f$::jsonb,
  false, $d${"hashArchivo":"hash-1"}$d$::jsonb
);
do $$
begin
  begin
    perform public.confirmar_importacion_productos(
      'aaaaaaaa-0000-0000-0000-000000000008', 'idem.xlsx', 'OtraHoja', null, 'SUMAR',
      '[{"fila":2,"codigo":"IDEM1","nombre":"Producto idempotente","precio":10,"stock":2}]'::jsonb,
      false, '{"hashArchivo":"hash-1","mapeo":{"codigo":3},"decisiones":{"2":{"accion":"CREAR"}}}'::jsonb
    );
    raise exception 'PRUEBA_FALLO: se aceptó una operación distinta con la misma clave';
  exception when others then
    if sqlerrm not like 'IDEMPOTENCIA_CONFLICTO:%' then
      raise;
    end if;
    raise notice 'OK: hoja, mapeo y decisiones distintos producen conflicto';
  end;
  begin
    perform public.confirmar_importacion_productos(
      'aaaaaaaa-0000-0000-0000-000000000008', 'idem.xlsx', null, null, 'SUMAR',
      '[{"fila":2,"codigo":"IDEM1","nombre":"Producto idempotente","precio":11,"stock":2}]'::jsonb,
      false, '{"hashArchivo":"hash-1"}'::jsonb
    );
    raise exception 'PRUEBA_FALLO: se aceptaron datos finales distintos con la misma clave';
  exception when others then
    if sqlerrm not like 'IDEMPOTENCIA_CONFLICTO:%' then
      raise;
    end if;
    raise notice 'OK: valores finales distintos producen conflicto';
  end;
  end;
end;
rollback;

\echo ''
\echo '=== 9. Idempotencia: la misma clave con otro archivo es un conflicto'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000009', 'uno.xlsx', null, null, 'SUMAR',
  $f$[{"fila":2,"codigo":"CONF1","nombre":"Producto conflicto","precio":10,"stock":1}]$f$::jsonb,
  false, $d${"hashArchivo":"hash-a"}$d$::jsonb
);
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000009', 'dos.xlsx', null, null, 'SUMAR',
  $f$[{"fila":2,"codigo":"CONF1","nombre":"Producto conflicto","precio":10,"stock":1}]$f$::jsonb,
  false, $d${"hashArchivo":"hash-b"}$d$::jsonb
);
rollback;

\echo ''
\echo '=== 10. Coincidencia ambigua: vincular a COCA500 con un código nuevo'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000010', 'vincular.xlsx', null, null, null,
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'NUEVO-COCA', 'nombre', 'Coca-Cola 500ml',
    'precio', 1250, 'accion', 'ACTUALIZAR', 'idProducto', :coca
  ))
);
select codigo, nombre, precio_venta from public.producto where id_producto = :coca;
select count(*) as se_creo_el_codigo_nuevo from public.producto where codigo = 'NUEVO-COCA';
rollback;

\echo ''
\echo '=== 11. Vincular a un producto cuyo código choca con otro: se rechaza'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000011', 'choque.xlsx', null, null, null,
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'AGUA2L', 'nombre', 'Coca-Cola 500ml',
    'precio', 1250, 'accion', 'ACTUALIZAR', 'idProducto', :coca
  ))
);
select mensaje from public.importacion_producto_error
 where id_importacion = (select max(id_importacion) from public.importacion_producto);
rollback;

\echo ''
\echo '=== 12. Categoría inexistente: se rechaza salvo que se autoricen nuevas'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000012', 'categoria.xlsx', null, null, null,
  $f$[{"fila":2,"codigo":"CAT1","nombre":"Producto categoría","precio":10,"categoria":"Sin existir"}]$f$::jsonb
) ->> 'estado' as sin_permiso;

select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000012', 'categoria.xlsx', null, null, null,
  $f$[{"fila":2,"codigo":"CAT1","nombre":"Producto categoría","precio":10,"categoria":"Sin existir"}]$f$::jsonb,
  true
) ->> 'estado' as con_permiso;

select nombre from public.categoria where lower(nombre) = 'sin existir';
rollback;

\echo ''
\echo '=== 13. Fila excluida a mano: no se valida y no frena al resto'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000013', 'excluir.xlsx', null, null, null,
  $f$[
    {"fila":2,"codigo":"EXC1","nombre":"Producto bueno","precio":10},
    {"fila":3,"codigo":"","nombre":"","stock":-5,"accion":"EXCLUIR"}
  ]$f$::jsonb
);
select count(*) as exc1_creados from public.producto where codigo = 'EXC1';
select numero_fila, accion from public.importacion_producto_fila
 where id_importacion = (select max(id_importacion) from public.importacion_producto)
 order by numero_fila;
rollback;

\echo ''
\echo '=== 14. Modalidad obligatoria para tocar stock de un producto existente'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000014', 'sin-modo.xlsx', null, null, null,
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'AGUA2L', 'nombre', 'Agua mineral 2L', 'stock', 50, 'accion', 'ACTUALIZAR'
  ))
);
select stock_actual from public.producto where codigo = 'AGUA2L';
rollback;

\echo ''
\echo '=== 15. Producto dado de baja: no puede recibir stock'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000015', 'baja.xlsx', null, null, 'SUMAR',
  jsonb_build_array(jsonb_build_object(
    'fila', 2, 'codigo', 'VIEJO01', 'nombre', 'Producto discontinuado', 'stock', 5, 'accion', 'ACTUALIZAR'
  ))
);
select stock_actual from public.producto where codigo = 'VIEJO01';
select estado, detalle ->> 'error' as error from public.importacion_producto
 where id_importacion = (select max(id_importacion) from public.importacion_producto);
rollback;

\echo ''
\echo '=== 16. Un empleado no ve el detalle por fila (RLS)'
begin; :como_admin
select public.confirmar_importacion_productos(
  'aaaaaaaa-0000-0000-0000-000000000016', 'rls.xlsx', null, null, null,
  $f$[{"fila":2,"codigo":"RLS1","nombre":"Producto RLS","precio":10}]$f$::jsonb
);
:como_emp
select count(*) as ve_el_empleado from public.importacion_producto_fila;
rollback;
