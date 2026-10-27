-- =====================================================================
-- KAN-37: registrar movimientos de stock sin permitir stock negativo
--
-- Es la ÚNICA forma de registrar un movimiento: nadie puede insertar en
-- movimiento_stock ni cambiar producto.stock_actual directamente.
--
-- Tipos de movimiento:
--   ENTRADA  p_cantidad = unidades que entran (> 0).  Cualquier usuario activo.
--   SALIDA   p_cantidad = unidades que salen (> 0).   Cualquier usuario activo.
--            Si no alcanza el stock, se rechaza.
--   AJUSTE   p_cantidad = stock CONTADO en el depósito (>= 0). Solo ADMINISTRADOR.
--            La función calcula la diferencia con el stock del sistema.
--
-- Uso desde el front:
--   const { data, error } = await supabase.rpc('registrar_movimiento', {
--     p_id_producto: 1, p_tipo: 'SALIDA', p_cantidad: 3, p_motivo: 'Venta'
--   })
--   data  -> el movimiento registrado (incluye stock_anterior y stock_resultante)
--   error -> error.message trae el motivo en español
-- =====================================================================


-- ---------------------------------------------------------------------
-- Cada movimiento guarda el stock antes y después.
-- Sirve para el historial y para saber si un AJUSTE subió o bajó el stock
-- (cantidad siempre es > 0, así que sola no alcanza).
-- ---------------------------------------------------------------------
alter table public.movimiento_stock
  add column stock_anterior   integer,
  add column stock_resultante integer;

-- Todavía no hay movimientos cargados, así que pueden ser obligatorias desde ya.
alter table public.movimiento_stock
  alter column stock_anterior   set not null,
  alter column stock_resultante set not null,
  add constraint chk_stock_anterior   check (stock_anterior >= 0),
  add constraint chk_stock_resultante check (stock_resultante >= 0);


-- ---------------------------------------------------------------------
-- Función registrar_movimiento
-- security definer: corre con permisos de dueño para poder actualizar el
-- stock e insertar el movimiento. Por eso valida el rol ella misma.
-- ---------------------------------------------------------------------
create or replace function public.registrar_movimiento(
  p_id_producto bigint,
  p_tipo        text,
  p_cantidad    integer,
  p_motivo      text
)
returns public.movimiento_stock
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usuario   uuid := (select auth.uid());
  v_rol       text := public.rol_actual();
  v_tipo      text := upper(trim(p_tipo));
  v_motivo    text := nullif(trim(p_motivo), '');
  v_producto  public.producto%rowtype;
  v_cantidad  integer;
  v_nuevo     integer;
  v_resultado public.movimiento_stock%rowtype;
begin
  -- Quién lo pide
  if v_rol is null then
    raise exception 'No tenés permiso para registrar movimientos (usuario sin cuenta o inactivo)';
  end if;

  -- Qué pide
  if v_tipo is null or v_tipo not in ('ENTRADA', 'SALIDA', 'AJUSTE') then
    raise exception 'Tipo de movimiento inválido: usá ENTRADA, SALIDA o AJUSTE';
  end if;

  if v_tipo = 'AJUSTE' and v_rol <> 'ADMINISTRADOR' then
    raise exception 'Solo un administrador puede hacer ajustes de stock';
  end if;

  if v_motivo is null then
    raise exception 'El motivo es obligatorio';
  end if;

  if v_tipo in ('ENTRADA', 'SALIDA') and (p_cantidad is null or p_cantidad <= 0) then
    raise exception 'La cantidad tiene que ser mayor a 0';
  end if;

  if v_tipo = 'AJUSTE' and (p_cantidad is null or p_cantidad < 0) then
    raise exception 'El stock contado no puede ser negativo';
  end if;

  -- Bloquea la fila del producto hasta terminar: si dos personas registran
  -- una salida al mismo tiempo, la segunda espera y ve el stock ya descontado.
  select * into v_producto
  from public.producto
  where id_producto = p_id_producto
  for update;

  if not found then
    raise exception 'El producto no existe';
  end if;

  if not v_producto.activo then
    raise exception 'El producto "%" está dado de baja', v_producto.nombre;
  end if;

  -- Calcular el stock nuevo
  case v_tipo
    when 'ENTRADA' then
      v_cantidad := p_cantidad;
      v_nuevo    := v_producto.stock_actual + p_cantidad;

    when 'SALIDA' then
      if p_cantidad > v_producto.stock_actual then
        raise exception 'Stock insuficiente de "%": hay %, se pidieron %',
          v_producto.nombre, v_producto.stock_actual, p_cantidad;
      end if;
      v_cantidad := p_cantidad;
      v_nuevo    := v_producto.stock_actual - p_cantidad;

    when 'AJUSTE' then
      v_cantidad := abs(p_cantidad - v_producto.stock_actual);
      v_nuevo    := p_cantidad;
      if v_cantidad = 0 then
        raise exception 'El stock contado es igual al del sistema (%): no hay nada que ajustar',
          v_producto.stock_actual;
      end if;
  end case;

  -- Guardar
  update public.producto
  set stock_actual = v_nuevo
  where id_producto = p_id_producto;

  insert into public.movimiento_stock
    (id_producto, id_usuario, tipo_movimiento, cantidad, motivo, stock_anterior, stock_resultante)
  values
    (p_id_producto, v_usuario, v_tipo, v_cantidad, v_motivo, v_producto.stock_actual, v_nuevo)
  returning * into v_resultado;

  return v_resultado;
end;
$$;

-- Solo usuarios con sesión iniciada pueden llamarla
revoke execute on function public.registrar_movimiento(bigint, text, integer, text) from public, anon;
grant  execute on function public.registrar_movimiento(bigint, text, integer, text) to authenticated;


-- ---------------------------------------------------------------------
-- El historial tiene que mostrar quién hizo cada movimiento.
-- Antes un EMPLEADO solo veía su propia fila de usuario, así que los
-- movimientos de otros aparecían sin autor. Ahora los usuarios activos
-- ven a sus compañeros. Modificar usuarios sigue siendo solo del admin.
-- ---------------------------------------------------------------------
drop policy "usuario: ver la propia fila o admin ve todas" on public.usuario;

create policy "usuario: ver la propia fila o usuarios activos ven a todos"
  on public.usuario for select to authenticated
  using (
    id_usuario = (select auth.uid())
    or (select public.rol_actual()) is not null
  );
