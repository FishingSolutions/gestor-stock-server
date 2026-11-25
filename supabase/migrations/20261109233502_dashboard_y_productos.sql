-- =====================================================================
-- Dashboard y vista de Productos: todos los números se calculan en la base
--
-- Antes el front descargaba TODOS los productos y calculaba los KPIs en el
-- navegador. Ahora pide solo lo que muestra:
--
--   Vista Dashboard  -> rpc('dashboard_resumen')   una sola llamada con:
--                       productos a reponer, balance entradas/salidas
--                       y últimos movimientos
--   Vista Productos  -> rpc('kpis_productos')      tarjetas de KPIs
--                    -> from('v_producto')         tabla con filtros, orden
--                                                  y paginación en el servidor
--   Historial        -> from('v_movimiento')       movimientos con producto y autor
--
-- Todo respeta RLS: sin sesión no se ve nada, y un usuario inactivo tampoco.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Fecha de alta de cada producto (para "nuevos este mes")
--    Los productos que ya existían quedan sin fecha: no se sabe cuándo se cargaron.
-- ---------------------------------------------------------------------
alter table public.producto add column fecha_alta timestamptz;
alter table public.producto alter column fecha_alta set default now();


-- ---------------------------------------------------------------------
-- 2. Índices para que el dashboard y el historial respondan rápido
-- ---------------------------------------------------------------------
create index if not exists idx_movimiento_fecha
  on public.movimiento_stock (fecha_movimiento desc);
create index if not exists idx_movimiento_producto
  on public.movimiento_stock (id_producto, fecha_movimiento desc);
create index if not exists idx_movimiento_usuario
  on public.movimiento_stock (id_usuario);
create index if not exists idx_producto_categoria
  on public.producto (id_categoria);


-- ---------------------------------------------------------------------
-- 3. v_producto: productos con categoría, estado de stock y valorización
--
--    estado_stock (una sola regla para todo el sistema, igual a la del front):
--      SIN_STOCK  stock <= 0
--      CRITICO    stock < 50% del mínimo
--      BAJO       stock <= mínimo
--      NORMAL     el resto (o si no tiene mínimo cargado)
--    prioridad: 1 SIN_STOCK, 2 CRITICO, 3 BAJO, 4 NORMAL (para ordenar por urgencia)
--
--    security_invoker: la vista usa los permisos de quien consulta (aplica RLS).
-- ---------------------------------------------------------------------
create view public.v_producto
with (security_invoker = true)
as
select
  p.id_producto,
  p.codigo,
  p.nombre,
  p.descripcion,
  p.id_categoria,
  c.nombre                                  as categoria,
  p.precio_costo,
  p.precio_venta,
  p.stock_actual,
  p.stock_minimo,
  p.stock_maximo,
  p.activo,
  p.fecha_alta,
  e.estado_stock,
  case e.estado_stock
    when 'SIN_STOCK' then 1
    when 'CRITICO'   then 2
    when 'BAJO'      then 3
    else 4
  end                                       as prioridad,
  (p.stock_actual * p.precio_costo)::numeric(14,2) as valor_costo,
  (p.stock_actual * p.precio_venta)::numeric(14,2) as valor_venta
from public.producto p
left join public.categoria c on c.id_categoria = p.id_categoria
cross join lateral (
  select case
    when p.stock_actual <= 0 then 'SIN_STOCK'
    when p.stock_minimo > 0 and p.stock_actual < p.stock_minimo * 0.5 then 'CRITICO'
    when p.stock_minimo > 0 and p.stock_actual <= p.stock_minimo then 'BAJO'
    else 'NORMAL'
  end as estado_stock
) e;

revoke all on public.v_producto from public, anon;
grant select on public.v_producto to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 4. v_movimiento: historial con producto y usuario (KAN-42 y dashboard)
-- ---------------------------------------------------------------------
create view public.v_movimiento
with (security_invoker = true)
as
select
  m.id_movimiento,
  m.fecha_movimiento,
  m.tipo_movimiento,
  m.cantidad,
  m.stock_anterior,
  m.stock_resultante,
  m.stock_resultante - m.stock_anterior     as variacion,
  m.motivo,
  m.id_producto,
  p.codigo,
  p.nombre                                  as producto,
  m.id_usuario,
  u.nombre                                  as usuario_nombre,
  u.apellido                                as usuario_apellido
from public.movimiento_stock m
join public.producto p on p.id_producto = m.id_producto
left join public.usuario u on u.id_usuario = m.id_usuario;

revoke all on public.v_movimiento from public, anon;
grant select on public.v_movimiento to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 5. kpis_productos(): tarjetas de la vista Productos
--    Cuenta solo productos ACTIVOS, salvo total/inactivos.
-- ---------------------------------------------------------------------
create or replace function public.kpis_productos()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inicio_mes timestamptz := date_trunc('month', now(), 'America/Argentina/Buenos_Aires');
  v_resultado  jsonb;
begin
  if public.rol_actual() is null then
    raise exception 'No tenés permiso para ver el inventario (usuario sin cuenta o inactivo)';
  end if;

  with k as (
    select
      count(*)                                                             as total,
      count(*) filter (where activo)                                       as activos,
      count(*) filter (where activo and fecha_alta >= v_inicio_mes)        as nuevos,
      coalesce(sum(stock_actual) filter (where activo), 0)                 as unidades,
      coalesce(sum(valor_costo)  filter (where activo), 0)                 as valor_costo,
      coalesce(sum(valor_venta)  filter (where activo), 0)                 as valor_venta,
      count(*) filter (where activo and estado_stock = 'NORMAL')           as normal,
      count(*) filter (where activo and estado_stock in ('BAJO', 'CRITICO')) as bajo,
      count(*) filter (where activo and estado_stock = 'CRITICO')          as critico,
      count(*) filter (where activo and estado_stock = 'SIN_STOCK')        as sin_stock
    from public.v_producto
  )
  select jsonb_build_object(
    'total_productos',         total,
    'productos_activos',       activos,
    'productos_inactivos',     total - activos,
    'nuevos_este_mes',         nuevos,
    'variacion_mes_pct',       round(100.0 * nuevos / nullif(activos - nuevos, 0), 1),
    'unidades_en_stock',       unidades,
    'valor_stock_costo',       valor_costo,
    'valor_stock_venta',       valor_venta,
    'stock_normal',            normal,
    'porcentaje_stock_normal', round(100.0 * normal / nullif(activos, 0), 1),
    'stock_bajo',              bajo,
    'stock_critico',           critico,
    'sin_stock',               sin_stock,
    'generado',                now()
  )
  into v_resultado
  from k;

  return v_resultado;
end;
$$;

revoke execute on function public.kpis_productos() from public, anon;
grant execute on function public.kpis_productos() to authenticated;


-- ---------------------------------------------------------------------
-- 6. dashboard_resumen(): todo el Dashboard en una sola llamada
--    p_dias:   días del balance de entradas/salidas (7 = última semana, 30 = mes)
--    p_limite: cuántos productos a reponer y cuántos movimientos devolver
-- ---------------------------------------------------------------------
create or replace function public.dashboard_resumen(
  p_dias   integer default 7,
  p_limite integer default 5
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz         constant text := 'America/Argentina/Buenos_Aires';
  v_hoy        date := (now() at time zone v_tz)::date;
  v_desde      date;
  v_a_reponer  jsonb;
  v_balance    jsonb;
  v_ultimos    jsonb;
begin
  if public.rol_actual() is null then
    raise exception 'No tenés permiso para ver el inventario (usuario sin cuenta o inactivo)';
  end if;

  if p_dias is null or p_dias < 1 or p_dias > 365 then
    raise exception 'p_dias tiene que estar entre 1 y 365';
  end if;

  if p_limite is null or p_limite < 1 or p_limite > 50 then
    raise exception 'p_limite tiene que estar entre 1 y 50';
  end if;

  v_desde := v_hoy - (p_dias - 1);

  -- Productos a reponer: los más urgentes primero
  select jsonb_build_object(
    'total', (select count(*) from public.v_producto where activo and estado_stock <> 'NORMAL'),
    'items', coalesce(jsonb_agg(
               jsonb_build_object(
                 'id_producto',  t.id_producto,
                 'codigo',       t.codigo,
                 'nombre',       t.nombre,
                 'categoria',    t.categoria,
                 'stock_actual', t.stock_actual,
                 'stock_minimo', t.stock_minimo,
                 'estado_stock', t.estado_stock
               ) order by t.prioridad, t.ratio, t.nombre
             ), '[]'::jsonb)
  )
  into v_a_reponer
  from (
    select *, stock_actual::numeric / nullif(stock_minimo, 0) as ratio
    from public.v_producto
    where activo and estado_stock <> 'NORMAL'
    order by prioridad, ratio, nombre
    limit p_limite
  ) t;

  -- Balance de entradas vs salidas por día (incluye días sin movimientos)
  with dias as (
    select d::date as fecha
    from generate_series(v_desde, v_hoy, interval '1 day') d
  ),
  mov as (
    select (fecha_movimiento at time zone v_tz)::date as fecha, tipo_movimiento, cantidad
    from public.movimiento_stock
    where fecha_movimiento >= (v_desde::timestamp at time zone v_tz)
  ),
  por_dia as (
    select
      d.fecha,
      coalesce(sum(m.cantidad) filter (where m.tipo_movimiento = 'ENTRADA'), 0) as entradas,
      coalesce(sum(m.cantidad) filter (where m.tipo_movimiento = 'SALIDA'), 0)  as salidas,
      count(m.fecha)           filter (where m.tipo_movimiento = 'AJUSTE')      as ajustes
    from dias d
    left join mov m on m.fecha = d.fecha
    group by d.fecha
  )
  select jsonb_build_object(
    'desde',          v_desde,
    'hasta',          v_hoy,
    'dias',           jsonb_agg(jsonb_build_object(
                        'fecha', fecha, 'entradas', entradas,
                        'salidas', salidas, 'ajustes', ajustes) order by fecha),
    'total_entradas', sum(entradas),
    'total_salidas',  sum(salidas),
    'flujo_neto',     sum(entradas) - sum(salidas),
    'total_ajustes',  sum(ajustes)
  )
  into v_balance
  from por_dia;

  -- Últimos movimientos
  select coalesce(jsonb_agg(to_jsonb(u) order by u.fecha_movimiento desc, u.id_movimiento desc), '[]'::jsonb)
  into v_ultimos
  from (
    select id_movimiento, fecha_movimiento, tipo_movimiento, cantidad,
           stock_anterior, stock_resultante, motivo,
           id_producto, codigo, producto, usuario_nombre, usuario_apellido
    from public.v_movimiento
    order by fecha_movimiento desc, id_movimiento desc
    limit p_limite
  ) u;

  return jsonb_build_object(
    'productos_a_reponer', v_a_reponer,
    'balance',             v_balance,
    'ultimos_movimientos', v_ultimos,
    'generado',            now()
  );
end;
$$;

revoke execute on function public.dashboard_resumen(integer, integer) from public, anon;
grant execute on function public.dashboard_resumen(integer, integer) to authenticated;
