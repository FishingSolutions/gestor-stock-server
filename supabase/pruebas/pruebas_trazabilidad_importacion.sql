-- Pruebas de integración local para el RPC que vincula el análisis.
-- Requiere migraciones, datos_demo.sql y psql con rol postgres.
\set ON_ERROR_STOP on
\pset pager off
BEGIN;
SET LOCAL request.jwt.claims TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

INSERT INTO public.importacion_ia_analisis (
  id_analisis, id_usuario, hash_archivo, hoja, mapeo, expira_en, ia_usada, ia_modelo, ia_ms
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  repeat('a', 64), 'Hoja A', '{"codigo":0,"nombre":1}'::jsonb,
  now() + interval '30 minutes', true, 'gemini-test', 123
);

INSERT INTO public.importacion_ia_analisis (
  id_analisis, id_usuario, hash_archivo, hoja, mapeo, expira_en
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '11111111-1111-1111-1111-111111111111',
  repeat('a', 64), 'Hoja B', '{"codigo":0,"nombre":1}'::jsonb,
  now() - interval '1 minute'
);

INSERT INTO public.importacion_ia_analisis (
  id_analisis, id_usuario, hash_archivo, hoja, mapeo, expira_en
) VALUES (
  '99999999-9999-4999-8999-999999999999',
  '11111111-1111-1111-1111-111111111111',
  repeat('a', 64), 'Hoja A', '{"codigo":0,"nombre":1}'::jsonb,
  now() + interval '30 minutes'
);

-- Un segundo administrador temporal verifica el aislamiento por propietario.
UPDATE public.usuario
SET rol = 'ADMINISTRADOR', activo = true
WHERE id_usuario = '22222222-2222-2222-2222-222222222222';

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_clave uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_filas jsonb := '[{"fila":2,"codigo":"IA-TEST","nombre":"Fila excluida","accion":"EXCLUIR"}]'::jsonb;
  v_detalle jsonb := jsonb_build_object(
    'hashArchivo', repeat('a', 64),
    'mapeo', '{"codigo":0,"nombre":1}'::jsonb,
    'decisiones', '{}'::jsonb
  );
  v_resultado jsonb;
BEGIN
  -- El mismo hash no hace intercambiables dos hojas.
  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      v_clave, 'audit.xlsx', 'Hoja B', 100, NULL, v_filas, false, v_detalle, v_id
    );
    RAISE EXCEPTION 'debió rechazar hoja distinta';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debió rechazar hoja distinta' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ANALISIS_IA_CONTEXTO_INVALIDO%' THEN RAISE; END IF;
  END;

  -- Tampoco permite sustituir el mapeo firmado.
  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      v_clave, 'audit.xlsx', 'Hoja A', 100, NULL, v_filas, false,
      jsonb_set(v_detalle, '{mapeo}', '{"codigo":1,"nombre":0}'::jsonb), v_id
    );
    RAISE EXCEPTION 'debió rechazar mapeo distinto';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debió rechazar mapeo distinto' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ANALISIS_IA_CONTEXTO_INVALIDO%' THEN RAISE; END IF;
  END;

  -- Primera confirmación vincula el análisis dentro de la misma transacción.
  v_resultado := public.confirmar_importacion_productos_vinculada(
    v_clave, 'audit.xlsx', 'Hoja A', 100, NULL, v_filas, false, v_detalle, v_id
  );
  IF v_resultado ->> 'estado' <> 'COMPLETADA' THEN
    RAISE EXCEPTION 'la confirmación de prueba no se completó: %', v_resultado;
  END IF;

  -- Reintento legítimo: misma clave y huella devuelve el resultado anterior.
  v_resultado := public.confirmar_importacion_productos_vinculada(
    v_clave, 'audit.xlsx', 'Hoja A', 100, NULL, v_filas, false, v_detalle, v_id
  );
  IF v_resultado ->> 'repetida' <> 'true' THEN
    RAISE EXCEPTION 'el reintento idéntico no fue idempotente';
  END IF;

  -- Otro análisis distinto no puede reclamar la clave ya asociada.
  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      v_clave, 'audit.xlsx', 'Hoja A', 100, NULL, v_filas, false, v_detalle,
      '99999999-9999-4999-8999-999999999999'
    );
    RAISE EXCEPTION 'otro análisis no debió reclamar la misma clave';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'otro análisis no debió reclamar la misma clave' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ANALISIS_IMPORTACION_YA_VINCULADA%' THEN RAISE; END IF;
  END;

  -- La defensa UNIQUE impide asociar un segundo análisis al mismo historial,
  -- incluso si una ruta futura omite la comprobación explícita de la RPC.
  BEGIN
    UPDATE public.importacion_ia_analisis
    SET idempotency_key = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        hash_operacion = repeat('d', 64),
        id_importacion = (v_resultado ->> 'idImportacion')::bigint
    WHERE id_analisis = '99999999-9999-4999-8999-999999999999';
    RAISE EXCEPTION 'UNIQUE debió impedir reutilizar id_importacion';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      v_clave, 'audit.xlsx', 'Hoja A', 100, NULL,
      '[{"fila":2,"codigo":"IA-TEST","nombre":"otra huella","accion":"EXCLUIR"}]'::jsonb,
      false, v_detalle, v_id
    );
    RAISE EXCEPTION 'debió rechazar una huella distinta con la misma clave';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debió rechazar una huella distinta con la misma clave' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCIA_CONFLICTO%' THEN RAISE; END IF;
  END;

  -- El mismo análisis no se puede consumir para otra clave.
  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'audit.xlsx', 'Hoja A', 100, NULL, v_filas, false, v_detalle, v_id
    );
    RAISE EXCEPTION 'debió rechazar reutilización del análisis';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debió rechazar reutilización del análisis' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ANALISIS_IA_YA_VINCULADO%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'audit.xlsx', 'Hoja B', 100, NULL,
      '[{"fila":2,"codigo":"IA-TEST-2","nombre":"x","accion":"EXCLUIR"}]'::jsonb,
      false,
      jsonb_build_object('hashArchivo', repeat('a', 64), 'mapeo', '{"codigo":0,"nombre":1}'::jsonb),
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    );
    RAISE EXCEPTION 'debió rechazar el análisis expirado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debió rechazar el análisis expirado' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ANALISIS_IA_EXPIRADO%' THEN RAISE; END IF;
  END;
END;
$$;

RESET ROLE;
UPDATE public.importacion_ia_analisis
SET expira_en = now() - interval '1 minute'
WHERE id_analisis = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_resultado jsonb;
BEGIN
  -- La expiración no impide repetir exactamente una operación ya vinculada.
  v_resultado := public.confirmar_importacion_productos_vinculada(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'audit.xlsx',
    'Hoja A',
    100,
    NULL,
    '[{"fila":2,"codigo":"IA-TEST","nombre":"Fila excluida","accion":"EXCLUIR"}]'::jsonb,
    false,
    jsonb_build_object(
      'hashArchivo', repeat('a', 64),
      'mapeo', '{"codigo":0,"nombre":1}'::jsonb,
      'decisiones', '{}'::jsonb
    ),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF v_resultado ->> 'repetida' <> 'true' THEN
    RAISE EXCEPTION 'no se conservó el reintento legítimo tras expirar el token';
  END IF;
END;
$$;

DO $$
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}',
    true
  );
  BEGIN
    PERFORM public.confirmar_importacion_productos_vinculada(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      'audit.xlsx', 'Hoja A', 100, NULL,
      '[{"fila":2,"codigo":"X","nombre":"x","accion":"EXCLUIR"}]'::jsonb,
      false,
      jsonb_build_object('hashArchivo', repeat('a', 64), 'mapeo', '{"codigo":0,"nombre":1}'::jsonb),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'debió rechazar un análisis de otro administrador';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debió rechazar un análisis de otro administrador' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ANALISIS_IA_NO_ENCONTRADO%' THEN RAISE; END IF;
  END;
END;
$$;

ROLLBACK;
