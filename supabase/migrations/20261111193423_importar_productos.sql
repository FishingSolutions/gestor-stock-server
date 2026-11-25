-- =====================================================================
-- Importar productos desde Excel, dentro de Supabase
--
-- Flujo:
--   front --(archivo)--> Edge Function `importar-productos`
--                         lee el Excel y valida cada fila
--                         --(productos válidos)--> rpc('importar_productos')
--                                                  inserta en UNA transacción
--                                                  y guarda el historial
--
-- Esta función es la parte "base de datos" del proceso:
--   1. Solo la puede usar un ADMINISTRADOR activo.
--   2. Vuelve a validar cada producto (por si alguien la llama directo).
--   3. Rechaza códigos repetidos en la planilla y códigos que ya existen
--      (sin distinguir mayúsculas: "p001" y "P001" son el mismo).
--   4. Crea las categorías que no existan.
--   5. Inserta los válidos. Si algo falla, no queda nada a medias.
--   6. Guarda el resumen y los errores en importacion_producto(_error).
--
-- Los productos entran activos, con su stock inicial y mínimo/máximo en 0
-- (igual que al crear un producto a mano).
-- =====================================================================

create or replace function public.importar_productos(
  p_productos         jsonb,
  p_archivo           text,
  p_hoja              text    default null,
  p_tamano_bytes      bigint  default null,
  p_filas_procesadas  integer default null,
  p_filas_vacias      integer default 0,
  p_errores           jsonb   default '[]'::jsonb,
  p_detalle           jsonb   default '{}'::jsonb,
  p_duracion_ms       integer default null
)
returns jsonb
language plpgsql
security definer   -- escribe el historial, que nadie puede escribir directo; por eso valida el rol
set search_path = ''
as $$
declare
  v_usuario        uuid := (select auth.uid());
  v_importados     jsonb;
  v_errores        jsonb;
  v_categorias     jsonb;
  v_cant_import    integer;
  v_filas_error    integer;
  v_total_errores  integer;
  v_procesadas     integer;
  v_estado         text;
  v_id             bigint;
begin
  -- 1. Quién llama ---------------------------------------------------------
  if public.rol_actual() is distinct from 'ADMINISTRADOR' then
    raise exception 'Solo un administrador puede importar productos';
  end if;

  -- Parámetros
  p_productos := coalesce(p_productos, '[]'::jsonb);
  p_errores   := coalesce(p_errores, '[]'::jsonb);

  if jsonb_typeof(p_productos) <> 'array' or jsonb_typeof(p_errores) <> 'array' then
    raise exception 'p_productos y p_errores tienen que ser listas';
  end if;
  if jsonb_array_length(p_productos) > 2000 then
    raise exception 'Se pueden importar como máximo 2000 productos por vez';
  end if;
  if nullif(btrim(p_archivo), '') is null then
    raise exception 'Falta el nombre del archivo';
  end if;

  -- 2. Productos recibidos, con el texto limpio -----------------------------
  drop table if exists pg_temp.imp_entrada;
  create temp table imp_entrada on commit drop as
  select
    x.fila,
    nullif(btrim(x.codigo), '')      as codigo,
    nullif(btrim(x.nombre), '')      as nombre,
    nullif(btrim(x.descripcion), '') as descripcion,
    nullif(btrim(x.categoria), '')   as categoria,
    x.stock,
    x.precio,
    coalesce(x.costo, 0)             as costo,
    null::text                       as campo,
    null::text                       as error,
    null::bigint                     as id_producto
  from jsonb_to_recordset(p_productos)
    as x(fila integer, codigo text, nombre text, descripcion text, categoria text,
         stock numeric, precio numeric, costo numeric);

  -- 3. Reglas de cada producto (la primera que falle) ------------------------
  update pg_temp.imp_entrada e
  set (campo, error) = (
    select v.campo, v.error from (values
      ('codigo',      case when e.codigo is null then 'El código es obligatorio.'
                           when length(e.codigo) > 50 then 'El código no puede superar los 50 caracteres.' end),
      ('nombre',      case when e.nombre is null then 'La descripción es obligatoria.'
                           when length(e.nombre) > 150 then 'La descripción no puede superar los 150 caracteres.' end),
      ('categoria',   case when length(e.categoria) > 100 then 'La categoría no puede superar los 100 caracteres.' end),
      ('stock',       case when e.stock is null or e.stock < 0 or e.stock <> trunc(e.stock) or e.stock > 2147483647
                           then 'El stock tiene que ser un número entero, 0 o más.' end),
      ('precio',      case when e.precio is null or e.precio <= 0 then 'El precio tiene que ser mayor que cero.'
                           when e.precio > 9999999999.99 then 'El precio es demasiado grande.' end),
      ('costo',       case when e.costo < 0 then 'El costo no puede ser negativo.'
                           when e.costo > 9999999999.99 then 'El costo es demasiado grande.' end)
    ) as v(campo, error)
    where v.error is not null
    limit 1
  )
  -- (Supabase rechaza UPDATE sin WHERE en llamadas por la API: pg_safeupdate)
  where e.error is null;

  -- Repetidos dentro de la misma planilla: vale la primera aparición
  with orden as (
    select ctid as id,
           first_value(fila) over w as primera,
           row_number()      over w as n
    from pg_temp.imp_entrada
    where codigo is not null
    window w as (partition by lower(codigo) order by fila, ctid)
  )
  update pg_temp.imp_entrada e
  set campo = 'codigo',
      error = format('El código "%s" está repetido en el archivo (ya aparece en la fila %s).', e.codigo, o.primera)
  from orden o
  where e.ctid = o.id and o.n > 1 and e.error is null;

  -- Códigos que ya existen en la base
  update pg_temp.imp_entrada e
  set campo = 'codigo',
      error = format('El código "%s" ya existe en el sistema.', e.codigo)
  where e.error is null
    and exists (select 1 from public.producto p where lower(btrim(p.codigo)) = lower(e.codigo));

  -- 4. Categorías que no existen: se crean --------------------------------
  with nuevas as (
    insert into public.categoria (nombre)
    select distinct on (lower(e.categoria)) e.categoria
    from pg_temp.imp_entrada e
    where e.error is null
      and e.categoria is not null
      and not exists (select 1 from public.categoria c where lower(btrim(c.nombre)) = lower(e.categoria))
    order by lower(e.categoria), e.fila
    on conflict (nombre) do nothing
    returning nombre
  )
  select coalesce(jsonb_agg(nombre order by nombre), '[]'::jsonb) into v_categorias from nuevas;

  -- 5. Insertar los válidos (si otro los creó recién, se saltean) ------------
  with insertados as (
    insert into public.producto
      (codigo, nombre, descripcion, precio_costo, precio_venta,
       stock_actual, stock_minimo, stock_maximo, id_categoria, activo)
    select e.codigo, e.nombre, e.descripcion, round(e.costo, 2), round(e.precio, 2),
           e.stock::integer, 0, 0,
           (select c.id_categoria from public.categoria c
             where lower(btrim(c.nombre)) = lower(e.categoria) limit 1),
           true
    from pg_temp.imp_entrada e
    where e.error is null
    order by e.fila
    on conflict (codigo) do nothing
    returning id_producto, codigo
  )
  update pg_temp.imp_entrada e
  set id_producto = i.id_producto
  from insertados i
  where i.codigo = e.codigo and e.error is null;

  update pg_temp.imp_entrada e
  set campo = 'codigo',
      error = format('El código "%s" ya existe en el sistema (se cargó al mismo tiempo).', e.codigo)
  where e.error is null and e.id_producto is null;

  -- 6. Resumen ------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object('fila', fila, 'codigo', codigo, 'idProducto', id_producto)
                            order by fila), '[]'::jsonb),
         count(*)
  into v_importados, v_cant_import
  from pg_temp.imp_entrada where id_producto is not null;

  -- Errores de la lectura (los manda la Edge Function) + los de la base
  select coalesce(jsonb_agg(err order by (err->>'fila')::integer nulls first), '[]'::jsonb)
  into v_errores
  from (
    select jsonb_build_object(
             'fila', (x->>'fila')::integer, 'codigo', x->>'codigo',
             'campo', x->>'campo', 'mensaje', coalesce(x->>'mensaje', 'Error sin detalle')) as err
    from jsonb_array_elements(p_errores) x
    union all
    select jsonb_build_object('fila', fila, 'codigo', codigo, 'campo', campo, 'mensaje', error)
    from pg_temp.imp_entrada where error is not null
  ) t;

  v_total_errores := jsonb_array_length(v_errores);
  select count(distinct coalesce((e->>'fila')::integer, -1)) into v_filas_error
  from jsonb_array_elements(v_errores) e;

  v_procesadas := coalesce(p_filas_procesadas, jsonb_array_length(p_productos));
  v_estado := case
    when v_cant_import = 0 then 'RECHAZADA'
    when v_total_errores > 0 then 'COMPLETADA_CON_ERRORES'
    else 'COMPLETADA'
  end;

  -- 7. Historial ------------------------------------------------------------
  insert into public.importacion_producto
    (id_usuario, archivo, hoja, tamano_bytes, filas_procesadas, filas_vacias,
     productos_importados, filas_con_error, errores_encontrados, estado, duracion_ms, detalle)
  values
    (v_usuario, left(btrim(p_archivo), 255), p_hoja, p_tamano_bytes, greatest(v_procesadas, 0),
     greatest(coalesce(p_filas_vacias, 0), 0), v_cant_import, v_filas_error, v_total_errores,
     v_estado, p_duracion_ms,
     coalesce(p_detalle, '{}'::jsonb) || jsonb_build_object('categoriasNuevas', v_categorias))
  returning id_importacion into v_id;

  insert into public.importacion_producto_error (id_importacion, numero_fila, codigo, mensaje)
  select v_id, (e->>'fila')::integer, e->>'codigo', e->>'mensaje'
  from jsonb_array_elements(v_errores) with ordinality as t(e, n)
  where n <= 1000;

  return jsonb_build_object(
    'estado',        v_estado,
    'idImportacion', v_id,
    'resumen', jsonb_build_object(
      'registrosProcesados', v_procesadas,
      'productosImportados', v_cant_import,
      'registrosConError',   v_filas_error,
      'erroresEncontrados',  v_total_errores,
      'filasVacias',         coalesce(p_filas_vacias, 0),
      'categoriasNuevas',    v_categorias
    ),
    'importados', v_importados,
    'errores',    v_errores
  );
end;
$$;

revoke execute on function public.importar_productos(jsonb, text, text, bigint, integer, integer, jsonb, jsonb, integer)
  from public, anon;
grant execute on function public.importar_productos(jsonb, text, text, bigint, integer, integer, jsonb, jsonb, integer)
  to authenticated;
