-- =====================================================================
-- Borrado lógico de productos
--
-- Cuando el admin borra un producto (el mismo DELETE de siempre:
-- supabase.from('producto').delete().eq('id_producto', id)), la base NO lo
-- borra: lo marca como eliminado, con fecha y quién lo hizo.
--   - Deja de aparecer en v_producto, KPIs y dashboard.
--   - Sus movimientos siguen en el historial (v_movimiento).
--   - No se le pueden registrar movimientos (queda activo = false).
--   - Se puede recuperar con rpc('restaurar_producto', { p_id_producto }).
-- Antes, un producto con movimientos no se podía borrar; ahora se puede.
-- =====================================================================

alter table public.producto
  add column eliminado               boolean not null default false,
  add column fecha_eliminacion       timestamptz,
  add column id_usuario_eliminacion  uuid references public.usuario(id_usuario) on delete set null;

-- El DELETE se convierte en "marcar como eliminado".
-- RLS ya filtró antes: solo llega acá si quien borra es ADMINISTRADOR.
create or replace function public.borrado_logico_producto()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.producto
  set eliminado = true,
      activo = false,
      fecha_eliminacion = now(),
      id_usuario_eliminacion = (select auth.uid())
  where id_producto = old.id_producto
    and not eliminado;
  return null; -- cancela el borrado real
end;
$$;

revoke execute on function public.borrado_logico_producto() from public, anon, authenticated;

create trigger borrado_logico
  before delete on public.producto
  for each row execute function public.borrado_logico_producto();


-- Recuperar un producto eliminado (solo ADMINISTRADOR). Vuelve activo.
create or replace function public.restaurar_producto(p_id_producto bigint)
returns public.producto
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_producto public.producto;
begin
  if public.rol_actual() is distinct from 'ADMINISTRADOR' then
    raise exception 'Solo un administrador puede restaurar productos';
  end if;

  update public.producto
  set eliminado = false, activo = true, fecha_eliminacion = null, id_usuario_eliminacion = null
  where id_producto = p_id_producto and eliminado
  returning * into v_producto;

  if not found then
    raise exception 'El producto no existe o no está eliminado';
  end if;
  return v_producto;
end;
$$;

revoke execute on function public.restaurar_producto(bigint) from public, anon;
grant  execute on function public.restaurar_producto(bigint) to authenticated;


-- v_producto (tabla, KPIs y dashboard) deja afuera los eliminados
create or replace view public.v_producto
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
) e
where not p.eliminado;
