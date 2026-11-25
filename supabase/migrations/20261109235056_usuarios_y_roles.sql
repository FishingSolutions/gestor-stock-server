-- =====================================================================
-- Usuarios: alta y baja de empleados desde la app
--
-- Crear cuentas de login necesita la clave secreta de Supabase, así que eso
-- lo hace la Edge Function `gestionar-usuarios` (supabase/functions/).
-- Esta migración agrega las reglas que la base hace cumplir siempre:
--
--   1. activar / desactivar un usuario SOLO con la Edge Function
--      (así, además de marcarlo inactivo, se le bloquea el login)
--   2. siempre tiene que quedar al menos un ADMINISTRADOR activo
--   3. el stock de un producto SOLO cambia con movimientos
--      (registrar_movimiento), nunca editándolo a mano: así todo cambio
--      de stock queda en el historial. Vale también para el admin.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 3. Editar un producto: todo menos el stock y el id
--    (al CREAR un producto sí se carga el stock inicial)
-- ---------------------------------------------------------------------
revoke update on public.producto from authenticated;
grant update (codigo, nombre, descripcion, precio_costo, precio_venta,
              stock_minimo, stock_maximo, activo, id_categoria)
  on public.producto to authenticated;


-- ---------------------------------------------------------------------
-- 1. El admin puede cambiar nombre, apellido y rol desde la app,
--    pero no `activo`: eso pasa por la Edge Function.
-- ---------------------------------------------------------------------
revoke update (activo) on public.usuario from authenticated;


-- ---------------------------------------------------------------------
-- 2. Nunca dejar el sistema sin administradores activos
-- ---------------------------------------------------------------------
create or replace function public.proteger_ultimo_admin()
returns trigger
language plpgsql
security definer   -- cuenta TODOS los admins, sin depender de qué filas ve quien edita
set search_path = ''
as $$
begin
  -- Solo importa si el que cambia ERA un admin activo y deja de serlo
  if old.rol = 'ADMINISTRADOR' and old.activo
     and (tg_op = 'DELETE' or new.rol <> 'ADMINISTRADOR' or not new.activo)
     and not exists (
       select 1 from public.usuario
       where rol = 'ADMINISTRADOR' and activo and id_usuario <> old.id_usuario
     )
  then
    raise exception 'Tiene que quedar al menos un administrador activo';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger proteger_ultimo_admin
  before update of rol, activo or delete on public.usuario
  for each row execute function public.proteger_ultimo_admin();

revoke execute on function public.proteger_ultimo_admin() from public, anon, authenticated;
