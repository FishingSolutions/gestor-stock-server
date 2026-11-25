-- Control global del consumo de IA para importaciones.
-- Aditiva. Si solicitud_ia ya existe (por ejemplo en StockFX-Testing), se
-- valida su forma antes de conceder permisos o reemplazar las RPC; CREATE
-- TABLE IF NOT EXISTS por sí solo no valida compatibilidad.

CREATE TABLE IF NOT EXISTS public.solicitud_ia (
    id_solicitud BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_usuario UUID NOT NULL REFERENCES public.usuario(id_usuario),
    fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
    modelo TEXT,
    estado TEXT NOT NULL DEFAULT 'RESERVADA'
        CHECK (estado IN ('RESERVADA', 'EXITOSA', 'ERROR', 'TIMEOUT')),
    duracion_ms INTEGER
        CHECK (duracion_ms IS NULL OR duracion_ms >= 0),
    motivo TEXT
);

ALTER TABLE public.solicitud_ia ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solicitud_ia FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.solicitud_ia TO service_role;
DO $$
DECLARE
    v_faltantes text;
    v_secuencia text;
BEGIN
    SELECT string_agg(requerida.nombre, ', ' ORDER BY requerida.nombre)
      INTO v_faltantes
    FROM (VALUES
      ('id_solicitud', 'bigint'),
      ('id_usuario', 'uuid'),
      ('fecha', 'timestamp with time zone'),
      ('modelo', 'text'),
      ('estado', 'text'),
      ('duracion_ms', 'integer'),
      ('motivo', 'text')
    ) AS requerida(nombre, tipo)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = 'solicitud_ia'
     AND c.column_name = requerida.nombre
     AND c.data_type = requerida.tipo
    WHERE c.column_name IS NULL;

    IF v_faltantes IS NOT NULL THEN
        RAISE EXCEPTION
          'public.solicitud_ia no es compatible; faltan columnas o tipos: %',
          v_faltantes;
    END IF;

    v_secuencia := pg_catalog.pg_get_serial_sequence(
      'public.solicitud_ia', 'id_solicitud'
    );
    IF v_secuencia IS NULL THEN
        RAISE EXCEPTION
          'public.solicitud_ia.id_solicitud debe tener una secuencia/identity';
    END IF;
    EXECUTE pg_catalog.format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', v_secuencia);
END;
$$;
CREATE INDEX IF NOT EXISTS idx_solicitud_ia_fecha ON public.solicitud_ia (fecha);

CREATE OR REPLACE FUNCTION public.reservar_solicitud_ia(
    p_id_usuario uuid,
    p_modelo text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_hoy date;
    v_cantidad integer;
    v_id bigint;
BEGIN
    IF p_id_usuario IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.usuario u
        WHERE u.id_usuario = p_id_usuario
          AND u.activo = true
          AND u.rol = 'ADMINISTRADOR'
    ) THEN
        RAISE EXCEPTION 'ADMINISTRADOR_NO_AUTORIZADO'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(831240, 1);
    v_hoy := (
        pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires'
    )::date;

    SELECT count(*) INTO v_cantidad
    FROM public.solicitud_ia s
    WHERE (
        s.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires'
    )::date = v_hoy;

    IF v_cantidad >= 20 THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.solicitud_ia (id_usuario, modelo, estado)
    VALUES (p_id_usuario, pg_catalog.left(p_modelo, 200), 'RESERVADA')
    RETURNING id_solicitud INTO v_id;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reservar_solicitud_ia(uuid, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservar_solicitud_ia(uuid, text)
TO service_role;

CREATE OR REPLACE FUNCTION public.finalizar_solicitud_ia(
    p_id_solicitud bigint,
    p_estado text,
    p_duracion_ms integer DEFAULT NULL,
    p_motivo text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF p_estado NOT IN ('EXITOSA', 'ERROR', 'TIMEOUT') OR p_estado IS NULL THEN
        RAISE EXCEPTION 'ESTADO_IA_INVALIDO' USING ERRCODE = '22023';
    END IF;
    IF p_duracion_ms IS NOT NULL AND p_duracion_ms < 0 THEN
        RAISE EXCEPTION 'DURACION_IA_INVALIDA' USING ERRCODE = '22023';
    END IF;

    UPDATE public.solicitud_ia
    SET estado = p_estado,
        duracion_ms = p_duracion_ms,
        motivo = pg_catalog.left(p_motivo, 200)
    WHERE id_solicitud = p_id_solicitud AND estado = 'RESERVADA';
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.finalizar_solicitud_ia(bigint, text, integer, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_solicitud_ia(bigint, text, integer, text)
TO service_role;

-- Recuperación operativa manual: solicitudes antiguas quedan TIMEOUT, nunca
-- se eliminan ni liberan cupo. No crea un job ni un proceso programado.
CREATE OR REPLACE FUNCTION public.recuperar_solicitudes_ia_abandonadas()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_actualizadas integer;
BEGIN
    UPDATE public.solicitud_ia
    SET estado = 'TIMEOUT',
        duracion_ms = least(
          2147483647,
          greatest(0, floor(extract(epoch FROM (pg_catalog.now() - fecha)) * 1000)::bigint)
        )::integer,
        motivo = 'RECUPERACION_MANUAL_RESERVA_ABANDONADA'
    WHERE estado = 'RESERVADA'
      AND fecha < pg_catalog.now() - interval '10 minutes';
    GET DIAGNOSTICS v_actualizadas = ROW_COUNT;
    RETURN v_actualizadas;
END;
$$;

REVOKE ALL ON FUNCTION public.recuperar_solicitudes_ia_abandonadas()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recuperar_solicitudes_ia_abandonadas()
TO service_role;

-- Registro del análisis producido por la Edge Function. El registro es
-- inmutable salvo por su vínculo atómico con la primera confirmación exitosa.
CREATE TABLE IF NOT EXISTS public.importacion_ia_analisis (
    id_analisis UUID PRIMARY KEY,
    id_usuario UUID NOT NULL REFERENCES public.usuario(id_usuario),
    hash_archivo TEXT NOT NULL CHECK (hash_archivo ~ '^[0-9a-f]{64}$'),
    hoja TEXT NOT NULL,
    mapeo JSONB NOT NULL,
    expira_en TIMESTAMPTZ NOT NULL,
    ia_usada BOOLEAN NOT NULL DEFAULT false,
    ia_modelo TEXT,
    ia_ms INTEGER NOT NULL DEFAULT 0 CHECK (ia_ms >= 0),
    idempotency_key UUID,
    hash_operacion TEXT,
    id_importacion BIGINT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      (idempotency_key IS NULL AND hash_operacion IS NULL AND id_importacion IS NULL)
      OR
      (idempotency_key IS NOT NULL AND hash_operacion IS NOT NULL AND id_importacion IS NOT NULL)
    )
);

ALTER TABLE public.importacion_ia_analisis ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.importacion_ia_analisis FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_ia_analisis TO service_role;
CREATE INDEX IF NOT EXISTS idx_importacion_ia_analisis_expira
  ON public.importacion_ia_analisis (expira_en)
  WHERE idempotency_key IS NULL;
-- Una clave y una importación solo pueden pertenecer a un análisis. Los NULL
-- corresponden a análisis todavía no confirmados y no colisionan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_importacion_ia_analisis_idempotency_key
  ON public.importacion_ia_analisis (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_importacion_ia_analisis_id_importacion
  ON public.importacion_ia_analisis (id_importacion)
  WHERE id_importacion IS NOT NULL;

-- Limpieza manual acotada: conserva todos los análisis ya vinculados al
-- historial y solo elimina vistas previas no confirmadas con más de 7 días.
CREATE OR REPLACE FUNCTION public.limpiar_analisis_ia_expirados()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_eliminados integer;
BEGIN
    DELETE FROM public.importacion_ia_analisis
    WHERE idempotency_key IS NULL
      AND expira_en < pg_catalog.now() - interval '7 days';
    GET DIAGNOSTICS v_eliminados = ROW_COUNT;
    RETURN v_eliminados;
END;
$$;

REVOKE ALL ON FUNCTION public.limpiar_analisis_ia_expirados()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.limpiar_analisis_ia_expirados()
TO service_role;

-- La reserva de análisis es operada por la Edge Function solo después de
-- validar JWT y rol. La confirmación exige el token y vuelve a comprobar los
-- claims contra este registro bajo bloqueo de fila.
CREATE OR REPLACE FUNCTION public.confirmar_importacion_productos_vinculada(
    p_idempotency_key UUID,
    p_archivo TEXT,
    p_hoja TEXT,
    p_tamano_bytes BIGINT,
    p_modo_stock TEXT,
    p_filas JSONB,
    p_crear_categorias BOOLEAN,
    p_detalle JSONB,
    p_id_analisis UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_usuario UUID := (SELECT auth.uid());
    v_analisis public.importacion_ia_analisis%ROWTYPE;
    v_resultado JSONB;
    v_id_importacion BIGINT;
    v_hash_operacion TEXT;
BEGIN
    IF public.rol_actual() IS DISTINCT FROM 'ADMINISTRADOR' THEN
        RAISE EXCEPTION 'Solo un administrador puede importar productos';
    END IF;
    IF p_id_analisis IS NULL THEN
        RAISE EXCEPTION 'Falta el identificador del análisis';
    END IF;

    SELECT * INTO v_analisis
    FROM public.importacion_ia_analisis a
    WHERE a.id_analisis = p_id_analisis
      AND a.id_usuario = v_usuario
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ANALISIS_IA_NO_ENCONTRADO';
    END IF;
    IF v_analisis.hash_archivo IS DISTINCT FROM lower(p_detalle ->> 'hashArchivo')
       OR v_analisis.hoja IS DISTINCT FROM p_hoja
       OR v_analisis.mapeo IS DISTINCT FROM (p_detalle -> 'mapeo') THEN
        RAISE EXCEPTION 'ANALISIS_IA_CONTEXTO_INVALIDO';
    END IF;
    IF v_analisis.idempotency_key IS NOT NULL
       AND v_analisis.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
        RAISE EXCEPTION 'ANALISIS_IA_YA_VINCULADO';
    END IF;
    IF v_analisis.idempotency_key IS NULL AND v_analisis.expira_en <= pg_catalog.now() THEN
        RAISE EXCEPTION 'ANALISIS_IA_EXPIRADO';
    END IF;

    -- Usa el mismo lock transaccional que la RPC original antes de comprobar
    -- asociaciones existentes. Así dos análisis distintos que compitan por
    -- la misma clave se serializan y el segundo observa el vínculo confirmado.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_idempotency_key::text)
    );

    IF EXISTS (
      SELECT 1
      FROM public.importacion_ia_analisis a
      WHERE a.id_analisis <> p_id_analisis
        AND (
          a.idempotency_key = p_idempotency_key
          OR (
            v_analisis.id_importacion IS NOT NULL
            AND a.id_importacion = v_analisis.id_importacion
          )
        )
    ) THEN
      RAISE EXCEPTION 'ANALISIS_IMPORTACION_YA_VINCULADA';
    END IF;

    -- El backend nunca puede sobrescribir la metadata IA persistida con datos
    -- del formulario: el RPC toma los valores desde la fila de análisis.
    v_resultado := public.confirmar_importacion_productos(
        p_idempotency_key => p_idempotency_key,
        p_archivo => p_archivo,
        p_hoja => p_hoja,
        p_tamano_bytes => p_tamano_bytes,
        p_modo_stock => p_modo_stock,
        p_filas => p_filas,
        p_crear_categorias => p_crear_categorias,
        p_detalle => p_detalle,
        p_ia => jsonb_build_object(
            'usada', v_analisis.ia_usada,
            'modelo', v_analisis.ia_modelo,
            'ms', v_analisis.ia_ms
        )
    );

    -- RECHAZADA/FALLIDA no consolidan la clave de idempotencia y permiten al
    -- administrador corregir filas y volver a intentar este análisis.
    IF v_resultado ->> 'estado' <> 'COMPLETADA' THEN
        RETURN v_resultado;
    END IF;

    SELECT i.id_importacion, i.hash_operacion
      INTO v_id_importacion, v_hash_operacion
    FROM public.importacion_producto i
    WHERE i.idempotency_key = p_idempotency_key
      AND i.id_usuario = v_usuario
      AND i.estado = 'COMPLETADA'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'IMPORTACION_IDEMPOTENTE_NO_ENCONTRADA';
    END IF;

    IF v_analisis.idempotency_key IS NOT NULL THEN
        IF v_analisis.hash_operacion IS DISTINCT FROM v_hash_operacion
           OR v_analisis.id_importacion IS DISTINCT FROM v_id_importacion THEN
            RAISE EXCEPTION 'ANALISIS_IA_REINTENTO_CONFLICTIVO';
        END IF;
    ELSE
        IF EXISTS (
          SELECT 1
          FROM public.importacion_ia_analisis a
          WHERE a.id_analisis <> p_id_analisis
            AND (
              a.idempotency_key = p_idempotency_key
              OR a.id_importacion = v_id_importacion
            )
        ) THEN
            RAISE EXCEPTION 'ANALISIS_IMPORTACION_YA_VINCULADA';
        END IF;

        UPDATE public.importacion_ia_analisis
        SET idempotency_key = p_idempotency_key,
            hash_operacion = v_hash_operacion,
            id_importacion = v_id_importacion
        WHERE id_analisis = p_id_analisis;
    END IF;

    RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_importacion_productos_vinculada(
    uuid, text, text, bigint, text, jsonb, boolean, jsonb, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_importacion_productos_vinculada(
    uuid, text, text, bigint, text, jsonb, boolean, jsonb, uuid
) TO authenticated;

-- Evita saltarse la vinculación llamando directamente a la RPC anterior.
REVOKE EXECUTE ON FUNCTION public.confirmar_importacion_productos(
    uuid, text, text, bigint, text, jsonb, boolean, jsonb, jsonb
) FROM authenticated;
