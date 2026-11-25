#!/usr/bin/env bash
# Prueba concurrente local del vínculo de un análisis a una sola operación.
# Requiere psql, DATABASE_URL local, migraciones y datos_demo.sql.
set -u

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Definí DATABASE_URL de la base local."
  exit 2
fi

tmp="$(mktemp -d)"
analysis_id="$(psql "$DATABASE_URL" -XAtqc 'select gen_random_uuid()')"
analysis_shared_a="$(psql "$DATABASE_URL" -XAtqc 'select gen_random_uuid()')"
analysis_shared_b="$(psql "$DATABASE_URL" -XAtqc 'select gen_random_uuid()')"
key_a="$(psql "$DATABASE_URL" -XAtqc 'select gen_random_uuid()')"
key_b="$(psql "$DATABASE_URL" -XAtqc 'select gen_random_uuid()')"
key_shared="$(psql "$DATABASE_URL" -XAtqc 'select gen_random_uuid()')"
fixture=0

cleanup() {
  if [ "$fixture" = 1 ]; then
    psql "$DATABASE_URL" -Xq <<SQL >/dev/null 2>&1 || true
DELETE FROM public.importacion_producto_fila
WHERE id_importacion IN (
  SELECT id_importacion FROM public.importacion_producto
  WHERE idempotency_key IN ('$key_a'::uuid, '$key_b'::uuid, '$key_shared'::uuid)
);
DELETE FROM public.importacion_producto_error
WHERE id_importacion IN (
  SELECT id_importacion FROM public.importacion_producto
  WHERE idempotency_key IN ('$key_a'::uuid, '$key_b'::uuid, '$key_shared'::uuid)
);
DELETE FROM public.importacion_producto
WHERE idempotency_key IN ('$key_a'::uuid, '$key_b'::uuid, '$key_shared'::uuid);
DELETE FROM public.importacion_ia_analisis
WHERE id_analisis IN (
  '$analysis_id'::uuid,
  '$analysis_shared_a'::uuid,
  '$analysis_shared_b'::uuid
);
SQL
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

psql "$DATABASE_URL" -Xv ON_ERROR_STOP=1 <<SQL
INSERT INTO public.importacion_ia_analisis (
  id_analisis, id_usuario, hash_archivo, hoja, mapeo, expira_en
) VALUES (
  '$analysis_id'::uuid, '11111111-1111-1111-1111-111111111111',
  repeat('c', 64), 'Concurrente', '{"codigo":0,"nombre":1}'::jsonb,
  now() + interval '30 minutes'
);
INSERT INTO public.importacion_ia_analisis (
  id_analisis, id_usuario, hash_archivo, hoja, mapeo, expira_en
) VALUES
  (
    '$analysis_shared_a'::uuid, '11111111-1111-1111-1111-111111111111',
    repeat('d', 64), 'Misma clave', '{"codigo":0,"nombre":1}'::jsonb,
    now() + interval '30 minutes'
  ),
  (
    '$analysis_shared_b'::uuid, '11111111-1111-1111-1111-111111111111',
    repeat('d', 64), 'Misma clave', '{"codigo":0,"nombre":1}'::jsonb,
    now() + interval '30 minutes'
  );
SQL
fixture=1

run_confirmation() {
  local key="$1"
  local output="$2"
  local target_analysis="${3:-$analysis_id}"
  psql "$DATABASE_URL" -Xv ON_ERROR_STOP=1 >"$output" 2>&1 <<SQL
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.confirmar_importacion_productos_vinculada(
  '$key'::uuid,
  'concurrente.xlsx',
  'Concurrente',
  100,
  NULL,
  '[{"fila":2,"codigo":"CONC","nombre":"Fila excluida","accion":"EXCLUIR"}]'::jsonb,
  false,
  jsonb_build_object(
    'hashArchivo', repeat('c', 64),
    'mapeo', '{"codigo":0,"nombre":1}'::jsonb,
    'decisiones', '{}'::jsonb
  ),
  '$target_analysis'::uuid
);
COMMIT;
SQL
}

run_confirmation "$key_a" "$tmp/a.log" &
pid_a=$!
run_confirmation "$key_b" "$tmp/b.log" &
pid_b=$!

set +e
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?
set -e

if { [ "$status_a" -eq 0 ] && [ "$status_b" -eq 0 ]; } ||
   { [ "$status_a" -ne 0 ] && [ "$status_b" -ne 0 ]; }; then
  cat "$tmp/a.log" "$tmp/b.log"
  echo "FALLO: se esperaba exactamente una confirmación exitosa."
  exit 1
fi

echo "OK: una confirmación ganó y la otra fue rechazada por el vínculo persistente."

run_confirmation "$key_shared" "$tmp/shared-a.log" "$analysis_shared_a" &
pid_a=$!
run_confirmation "$key_shared" "$tmp/shared-b.log" "$analysis_shared_b" &
pid_b=$!

set +e
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?
set -e

if { [ "$status_a" -eq 0 ] && [ "$status_b" -eq 0 ]; } ||
   { [ "$status_a" -ne 0 ] && [ "$status_b" -ne 0 ]; }; then
  cat "$tmp/shared-a.log" "$tmp/shared-b.log"
  echo "FALLO: exactamente un análisis debe quedar asociado a la clave compartida."
  exit 1
fi

if ! grep -q 'ANALISIS_IMPORTACION_YA_VINCULADA' "$tmp/shared-a.log" "$tmp/shared-b.log"; then
  cat "$tmp/shared-a.log" "$tmp/shared-b.log"
  echo "FALLO: el análisis perdedor no informó el conflicto de asociación."
  exit 1
fi

echo "OK: dos análisis concurrentes no pudieron asociarse a una misma clave/importación."
