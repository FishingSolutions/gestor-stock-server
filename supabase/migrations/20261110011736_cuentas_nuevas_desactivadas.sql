-- =====================================================================
-- Cuentas nuevas entran DESACTIVADAS, salvo que las cree un admin
--
-- Problema: en Supabase el registro público está encendido ("Allow new
-- users to sign up"). Con la clave pública del front, cualquiera podía
-- crearse una cuenta y quedaba como EMPLEADO activo: veía el inventario
-- y (con KAN-37) podía registrar ventas.
--
-- Solución: al crearse una cuenta de login, su fila en `usuario` queda
--   activo = true   solo si la creó un ADMINISTRADOR con la Edge Function
--                   `gestionar-usuarios` (marca creado_por_admin en app_metadata)
--   activo = false  en cualquier otro caso (registro propio, cuenta creada
--                   a mano en el dashboard, etc.)
--
-- Una cuenta desactivada no ve nada ni puede hacer nada (RLS y funciones
-- usan rol_actual(), que da null). Un admin la activa desde la app.
--
-- app_metadata solo lo puede escribir el servidor (clave service_role):
-- quien se registra solo NO puede ponerse la marca.
-- =====================================================================

create or replace function public.crear_usuario_desde_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creado_por_admin boolean := (new.raw_app_meta_data ->> 'creado_por_admin') = 'true';
begin
  insert into public.usuario (id_usuario, nombre, apellido, email, rol, activo)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'nombre', ''), split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'apellido', ''),
    new.email,
    'EMPLEADO',                         -- nunca se toma el rol de lo que manda quien se registra
    coalesce(v_creado_por_admin, false) -- activo solo si la creó un admin
  )
  -- Si ya había una fila con ese email sin cuenta de login (como pasó con
  -- el Admin Prueba), se vincula y conserva su rol y estado.
  on conflict (email) do update
    set id_usuario = excluded.id_usuario;
  return new;
end;
$$;

revoke execute on function public.crear_usuario_desde_auth() from public, anon, authenticated;
