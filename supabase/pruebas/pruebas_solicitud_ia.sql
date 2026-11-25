-- Pruebas locales del contador global. Requiere migraciones y datos_demo.sql.
-- Ejecutar con psql como postgres; no deja registros (ROLLBACK).
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.reservar_solicitud_ia(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated no debe poder reservar IA';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reservar_solicitud_ia(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role debe poder reservar IA';
  END IF;
  IF has_function_privilege('authenticated', 'public.finalizar_solicitud_ia(bigint,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated no debe poder finalizar IA';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.confirmar_importacion_productos(uuid,text,text,bigint,text,jsonb,boolean,jsonb,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated no debe poder saltarse la confirmación vinculada';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.confirmar_importacion_productos_vinculada(uuid,text,text,bigint,text,jsonb,boolean,jsonb,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated debe poder confirmar mediante vínculo de análisis';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.importar_productos(jsonb,text,text,bigint,integer,integer,jsonb,jsonb,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'la importación tradicional debe conservar su permiso authenticated';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.importar_productos(jsonb,text,text,bigint,integer,integer,jsonb,jsonb,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon no debe poder ejecutar la importación tradicional';
  END IF;
END;
$$;

DELETE FROM public.solicitud_ia
WHERE (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date =
      (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_usuario uuid := '11111111-1111-1111-1111-111111111111';
  v_id bigint;
  v_n integer;
BEGIN
  FOR v_n IN 1..20 LOOP
    v_id := public.reservar_solicitud_ia(v_usuario, 'modelo-prueba');
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'la reserva % no debió alcanzar el límite', v_n;
    END IF;
  END LOOP;

  IF public.reservar_solicitud_ia(v_usuario, 'modelo-prueba') IS NOT NULL THEN
    RAISE EXCEPTION 'la solicitud 21 debe rechazarse';
  END IF;

  IF NOT public.finalizar_solicitud_ia(v_id, 'EXITOSA', 12, NULL) THEN
    RAISE EXCEPTION 'la reserva debe finalizar';
  END IF;
  IF public.finalizar_solicitud_ia(v_id, 'ERROR', 13, 'duplicada') THEN
    RAISE EXCEPTION 'no debe finalizarse dos veces';
  END IF;
END;
$$;

ROLLBACK;
