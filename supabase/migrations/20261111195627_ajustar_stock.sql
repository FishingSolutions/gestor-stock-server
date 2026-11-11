-- =====================================================================
-- ajustar_stock: el ADMINISTRADOR corrige el stock indicando CUÁNTO sube o
-- baja y por qué (ej.: -5, 'Rotura: se cayó una caja').
--
-- Es un atajo sobre registrar_movimiento('AJUSTE', ...): queda en el
-- historial como cualquier ajuste (con stock_anterior y stock_resultante),
-- y valida rol, motivo y producto activo de la misma forma.
--
--   supabase.rpc('ajustar_stock', { p_id_producto: 12, p_diferencia: -5, p_motivo: 'Rotura' })
-- =====================================================================
create or replace function public.ajustar_stock(
  p_id_producto bigint,
  p_diferencia  integer,
  p_motivo      text
)
returns public.movimiento_stock
language plpgsql
set search_path = ''
as $$
declare
  v_stock integer;
begin
  if public.rol_actual() is distinct from 'ADMINISTRADOR' then
    raise exception 'Solo un administrador puede hacer ajustes de stock';
  end if;
  if p_diferencia is null or p_diferencia = 0 then
    raise exception 'Indicá cuántas unidades sube o baja el stock (distinto de 0)';
  end if;

  -- Se bloquea el producto antes de calcular, para que una venta simultánea
  -- no cambie el stock entre la lectura y el ajuste
  select stock_actual into v_stock
  from public.producto where id_producto = p_id_producto
  for update;

  if not found then
    raise exception 'El producto no existe';
  end if;
  if v_stock + p_diferencia < 0 then
    raise exception 'El ajuste dejaría el stock en negativo: hay %, se quieren restar %', v_stock, -p_diferencia;
  end if;

  return public.registrar_movimiento(p_id_producto, 'AJUSTE', v_stock + p_diferencia, p_motivo);
end;
$$;

revoke execute on function public.ajustar_stock(bigint, integer, text) from public, anon;
grant  execute on function public.ajustar_stock(bigint, integer, text) to authenticated;
