-- =====================================================================
-- Importación de productos con IA: vista previa y confirmación atómica
--
-- El flujo nuevo es de dos pasos:
--
--   1. ANALIZAR (Edge Function `importar-productos-ia`, action=analizar)
--      Lee el Excel, mapea las columnas y clasifica cada fila. NO escribe
--      nada en la base: solo devuelve una vista previa para que el admin
--      revise y decida.
--
--   2. CONFIRMAR (misma Edge Function, action=confirmar)
--      Vuelve a leer el archivo y llama a esta función, que aplica todo
--      en UNA transacción y guarda el historial.
--
-- Esta migración es SOLO ADITIVA sobre lo que ya existe:
--   * agrega columnas al historial de importaciones;
--   * crea la tabla de detalle por fila;
--   * agrega la función `confirmar_importacion_productos`.
--
-- NO modifica `importar_productos` ni sus tablas, así que las pruebas del
-- importador anterior siguen funcionando igual.
--
-- Reglas de stock (nunca se escribe `producto.stock_actual` a mano):
--   * producto nuevo con stock  -> se inserta en 0 y se registra ENTRADA.
--   * modo REEMPLAZAR           -> registrar_movimiento(AJUSTE, stock contado)
--   * modo SUMAR                -> registrar_movimiento(ENTRADA, cantidad)
--   * modo null                 -> no se toca el stock de los existentes
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Datos nuevos en el historial de importaciones
-- ---------------------------------------------------------------------
alter table public.importacion_producto
  add column if not exists idempotency_key        uuid,
  add column if not exists hash_archivo           text,
  add column if not exists modo_stock             text,
  add column if not exists productos_actualizados integer not null default 0,
  add column if not exists productos_sin_cambios  integer not null default 0,
  add column if not exists filas_ambiguas         integer not null default 0,
  add column if not exists ia_usada               boolean not null default false,
  add column if not exists ia_modelo              text,
  add column if not exists ia_ms                  integer;

-- El modo es obligatorio para la importación nueva, pero las filas viejas
-- (del importador anterior) quedan en null.
alter table public.importacion_producto
  drop constraint if exists chk_importacion_modo_stock;
alter table public.importacion_producto
  add constraint chk_importacion_modo_stock
  check (modo_stock is null or modo_stock in ('REEMPLAZAR', 'SUMAR'));

-- Una clave de idempotencia no se puede reutilizar en dos importaciones.
-- Es parcial porque las importaciones viejas no tienen clave.
create unique index if not exists uq_importacion_idempotency
  on public.importacion_producto (idempotency_key)
  where idempotency_key is not null;


-- ---------------------------------------------------------------------
-- 2. Detalle de cada fila de la importación
--
-- Sirve para responder "¿qué pasó con la fila 12?" sin mirar logs: guarda
-- la acción aplicada, el stock antes/después y el movimiento generado.
-- ---------------------------------------------------------------------
create table if not exists public.importacion_producto_fila (
  id_fila           bigint generated always as identity primary key,
  id_importacion    bigint not null references public.importacion_producto(id_importacion) on delete cascade,
  numero_fila       integer,
  codigo            text,
  nombre            text,
  accion            text not null check (accion in ('CREAR', 'ACTUALIZAR', 'SIN_CAMBIOS', 'EXCLUIDA', 'ERROR')),
  id_producto       bigint references public.producto(id_producto) on delete set null,
  stock_anterior    integer,
  stock_resultante  integer,
  id_movimiento     bigint references public.movimiento_stock(id_movimiento) on delete set null,
  mensaje           text
);

create index if not exists idx_importacion_fila_importacion
  on public.importacion_producto_fila (id_importacion);

alter table public.importacion_producto_fila enable row level security;

revoke all on public.importacion_producto_fila from public, anon;
grant select on public.importacion_producto_fila to authenticated;
grant all on public.importacion_producto_fila to service_role;

create policy "importacion fila: admin puede ver"
  on public.importacion_producto_fila
  for select
  to authenticated
  using ((select public.rol_actual()) = 'ADMINISTRADOR');

comment on table public.importacion_producto_fila is
  'Detalle por fila de una importación: acción aplicada, stock y movimiento generado';


-- ---------------------------------------------------------------------
-- 3. Confirmar una importación ya revisada por el administrador
--
-- Recibe SOLO filas ya validadas y clasificadas por la Edge Function, pero
-- vuelve a verificar todo: códigos, precios, stock, categorías y que el
-- producto elegido para una fila sea realmente el del código.
--
-- Si una sola fila tiene error, no se aplica NADA y queda un historial
-- RECHAZADA (sin clave de idempotencia, para poder corregir y reintentar).
-- ---------------------------------------------------------------------
create or replace function public.confirmar_importacion_productos(
  p_idempotency_key  uuid,
  p_archivo          text,
  p_hoja             text    default null,
  p_tamano_bytes     bigint  default null,
  p_modo_stock       text    default null,
  p_filas            jsonb   default '[]'::jsonb,
  p_crear_categorias boolean default false,
  p_detalle          jsonb   default '{}'::jsonb,
  p_ia               jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer   -- escribe producto, categoría e historial; por eso valida el rol
set search_path = ''
as $$
declare
  v_usuario        uuid := (select auth.uid());
  v_modo           text := nullif(upper(btrim(coalesce(p_modo_stock, ''))), '');
  v_hash           text := nullif(btrim(coalesce(p_detalle ->> 'hashArchivo', '')), '');
  v_previa         public.importacion_producto%rowtype;
  v_producto       public.producto%rowtype;
  v_fila           record;
  v_ctids          tid[];
  v_ct             tid;
  v_id             bigint;
  v_id_producto    bigint;
  v_id_categoria   uuid;
  v_stock_final    integer;
  v_movimiento     bigint;
  v_motivo         text;
  v_cambio         boolean;
  v_cambio_campos  boolean;
  v_creados        integer := 0;
  v_actualizados   integer := 0;
  v_sin_cambios    integer := 0;
  v_excluidas      integer := 0;
  v_con_error      integer := 0;
  v_filas_total    integer := 0;
  v_errores        jsonb;
  v_filas          jsonb;
  v_resumen        jsonb;
  v_resultado      jsonb;
begin
  -- 1. Quién llama -------------------------------------------------------
  if public.rol_actual() is distinct from 'ADMINISTRADOR' then
    raise exception 'Solo un administrador puede importar productos';
  end if;

  if p_idempotency_key is null then
    raise exception 'Falta la clave de idempotencia de la importación';
  end if;
  if v_modo is not null and v_modo not in ('REEMPLAZAR', 'SUMAR') then
    raise exception 'Modo de stock inválido: usá REEMPLAZAR o SUMAR';
  end if;
  if nullif(btrim(p_archivo), '') is null then
    raise exception 'Falta el nombre del archivo';
  end if;

  p_filas := coalesce(p_filas, '[]'::jsonb);
  p_detalle := coalesce(p_detalle, '{}'::jsonb);
  p_ia := coalesce(p_ia, '{}'::jsonb);

  if jsonb_typeof(p_filas) <> 'array' then
    raise exception 'p_filas tiene que ser una lista';
  end if;
  if jsonb_array_length(p_filas) > 2000 then
    raise exception 'Se pueden importar como máximo 2000 filas por vez';
  end if;

  -- 2. Idempotencia ------------------------------------------------------
  -- El lock hace que dos confirmaciones simultáneas con la misma clave se
  -- esperen en vez de intentar escribir las dos.
  perform pg_advisory_xact_lock(hashtext(p_idempotency_key::text));

  select * into v_previa
  from public.importacion_producto
  where idempotency_key = p_idempotency_key;

  if found then
    -- Mismo archivo y mismo modo: se devuelve el resultado anterior y no se
    -- duplica ni un producto ni un movimiento.
    if v_previa.hash_archivo is not distinct from v_hash
       and v_previa.modo_stock is not distinct from v_modo then
      -- Se devuelve el resultado guardado, marcado como repetido para que
      -- el front no lo muestre como una importación nueva.
      return coalesce(
        v_previa.detalle -> 'resultado',
        jsonb_build_object(
          'estado', v_previa.estado,
          'idImportacion', v_previa.id_importacion
        )
      ) || jsonb_build_object('repetida', true);
    end if;

    raise exception 'IDEMPOTENCIA_CONFLICTO: esta importación ya se confirmó con otro archivo o con otro modo de stock';
  end if;

  -- 3. Filas recibidas, con el texto limpio ------------------------------
  drop table if exists pg_temp.imp_filas;
  create temp table imp_filas on commit drop as
  select
    coalesce(x.fila, 0)                       as fila,
    nullif(btrim(x.codigo), '')               as codigo,
    nullif(btrim(x.nombre), '')               as nombre,
    nullif(btrim(x.descripcion), '')          as descripcion,
    nullif(btrim(x.categoria), '')            as categoria,
    x.stock                                   as stock,
    x.precio                                  as precio,
    x.costo                                   as costo,
    x."stockMinimo"                           as stock_minimo,
    x."stockMaximo"                           as stock_maximo,
    x.activo                                  as activo,
    upper(coalesce(nullif(btrim(x.accion), ''), 'CREAR')) as accion,
    x."idProducto"                            as id_pedido,
    null::bigint                              as id_producto,
    null::text                                as error,
    null::integer                             as stock_anterior,
    null::integer                             as stock_resultante,
    null::bigint                              as id_movimiento
  from jsonb_to_recordset(p_filas)
    as x(fila integer, codigo text, nombre text, descripcion text, categoria text,
         stock numeric, precio numeric, costo numeric, "stockMinimo" numeric,
         "stockMaximo" numeric, activo boolean, accion text, "idProducto" bigint);

  -- 4. Reglas de cada fila (gana la primera que falla).
  --    Las filas EXCLUIR no se validan: el administrador ya decidió no
  --    importarlas y muchas veces se excluyen justamente porque están mal.
  update pg_temp.imp_filas e
  set error = (
    select v.error from (values
      (case when e.accion not in ('CREAR', 'ACTUALIZAR', 'EXCLUIR')
            then 'Acción inválida para la fila.' end),
      (case when e.codigo is null then 'El código es obligatorio.'
            when e.codigo ~ '[[:cntrl:]]' then 'El código tiene caracteres no permitidos.'
            when length(e.codigo) > 50 then 'El código no puede superar los 50 caracteres.' end),
      (case when e.nombre is null then 'La descripción es obligatoria.'
            when length(e.nombre) > 150 then 'La descripción no puede superar los 150 caracteres.' end),
      (case when length(e.descripcion) > 2000 then 'El detalle no puede superar los 2000 caracteres.' end),
      (case when length(e.categoria) > 100 then 'La categoría no puede superar los 100 caracteres.' end),
      (case when e.stock is not null
             and (e.stock < 0 or e.stock <> trunc(e.stock) or e.stock > 2147483647)
            then 'El stock tiene que ser un número entero, 0 o más.' end),
      (case when e.precio is not null and e.precio <= 0 then 'El precio tiene que ser mayor que cero.'
            when e.precio is not null and e.precio > 9999999999.99 then 'El precio es demasiado grande.' end),
      (case when e.costo is not null and e.costo < 0 then 'El costo no puede ser negativo.'
            when e.costo is not null and e.costo > 9999999999.99 then 'El costo es demasiado grande.' end),
      (case when e.stock_minimo is not null and e.stock_minimo < 0
            then 'El stock mínimo no puede ser negativo.' end),
      (case when e.stock_maximo is not null and e.stock_maximo < 0
            then 'El stock máximo no puede ser negativo.' end),
      (case when e.stock_minimo is not null and e.stock_maximo is not null
             and e.stock_minimo > e.stock_maximo
            then 'El stock mínimo no puede ser mayor que el stock máximo.' end),
      -- Un producto nuevo necesita precio: no se inventan precios.
      (case when e.accion = 'CREAR' and e.precio is null
            then 'El precio es obligatorio para un producto nuevo.' end)
    ) as v(error)
    where v.error is not null
    limit 1
  )
  where e.accion <> 'EXCLUIR';

  -- 5. Resolver a qué producto corresponde cada fila ----------------------
  -- 5.1 Producto elegido a mano (coincidencia ambigua resuelta por el admin):
  --     tiene que existir y estar vigente. Se permite que el código de la fila
  --     no coincida (el producto se encontró por nombre), pero solo si ese
  --     código no pertenece a otro producto: nunca se pisa un producto ajeno.
  update pg_temp.imp_filas e
  set id_producto = p.id_producto
  from public.producto p
  where e.error is null
    and e.accion <> 'EXCLUIR'
    and e.id_pedido is not null
    and p.id_producto = e.id_pedido
    and not coalesce(p.eliminado, false)
    and (
      lower(btrim(p.codigo)) = lower(e.codigo)
      or not exists (
        select 1
        from public.producto q
        where q.id_producto <> p.id_producto
          and lower(btrim(q.codigo)) = lower(e.codigo)
      )
    );

  -- 5.2 Si se pidió un producto que no sirve, es un error: nunca se toca
  --     un producto distinto al que quiso el administrador.
  update pg_temp.imp_filas e
  set error = format(
    'El producto %s no existe, está eliminado o su código choca con el de la fila "%s".',
    e.id_pedido, e.codigo
  )
  where e.error is null
    and e.accion <> 'EXCLUIR'
    and e.id_pedido is not null
    and e.id_producto is null;

  -- 5.3 Sin producto elegido: se busca por código (sin distinguir mayúsculas)
  update pg_temp.imp_filas e
  set id_producto = p.id_producto
  from public.producto p
  where e.error is null
    and e.accion <> 'EXCLUIR'
    and e.id_producto is null
    and lower(btrim(p.codigo)) = lower(e.codigo)
    and not coalesce(p.eliminado, false);

  -- 5.4 "Crear" un código que ya existe es un error: se actualiza, no se duplica.
  update pg_temp.imp_filas e
  set error = format(
    'El código "%s" ya existe en el sistema. Elegí actualizar el producto existente en la vista previa.',
    e.codigo
  )
  where e.error is null and e.accion = 'CREAR' and e.id_producto is not null;

  -- 5.4b "Crear" un código que pertenece a un producto eliminado también es
  --      un error: el código sigue ocupado y el alta fallaría con una
  --      violación de unicidad poco clara.
  update pg_temp.imp_filas e
  set error = format(
    'El código "%s" pertenece a un producto eliminado. Restauralo o usá otro código.',
    e.codigo
  )
  where e.error is null
    and e.accion = 'CREAR'
    and exists (
      select 1
      from public.producto p
      where lower(btrim(p.codigo)) = lower(e.codigo)
    );

  -- 5.5 "Actualizar" un código que no existe es un error.
  update pg_temp.imp_filas e
  set error = format(
    'El código "%s" no existe en el sistema. Volvé a analizar el archivo.',
    e.codigo
  )
  where e.error is null and e.accion = 'ACTUALIZAR' and e.id_producto is null;

  -- 6. Códigos repetidos dentro del archivo (vale la primera aparición) ----
  with orden as (
    select ctid as id,
           first_value(fila) over w as primera,
           row_number() over w as n
    from pg_temp.imp_filas
    where codigo is not null and accion <> 'EXCLUIR'
    window w as (partition by lower(codigo) order by fila, ctid)
  )
  update pg_temp.imp_filas e
  set error = format('El código "%s" está repetido en el archivo (ya aparece en la fila %s).', e.codigo, o.primera)
  from orden o
  where e.ctid = o.id and o.n > 1 and e.error is null;

  -- 7. Categorías --------------------------------------------------------
  -- Solo se crean si el administrador lo confirmó en la vista previa.
  if coalesce(p_crear_categorias, false) then
    insert into public.categoria (nombre)
    select distinct on (lower(e.categoria)) e.categoria
    from pg_temp.imp_filas e
    where e.error is null
      and e.accion <> 'EXCLUIR'
      and e.categoria is not null
      and not exists (
        select 1 from public.categoria c where lower(btrim(c.nombre)) = lower(e.categoria)
      )
    order by lower(e.categoria), e.fila
    on conflict (nombre) do nothing;
  end if;

  update pg_temp.imp_filas e
  set error = format('La categoría "%s" no existe. Marcá "crear categorías nuevas" y volvé a confirmar.', e.categoria)
  where e.error is null
    and e.accion <> 'EXCLUIR'
    and e.categoria is not null
    and not exists (
      select 1 from public.categoria c where lower(btrim(c.nombre)) = lower(e.categoria)
    );

  -- 8. Historial del intento (después pasa a COMPLETADA o FALLIDA) --------
  select count(*) filter (where error is not null),
         count(*)
  into v_con_error, v_filas_total
  from pg_temp.imp_filas;

  insert into public.importacion_producto
    (id_usuario, archivo, hoja, tamano_bytes, filas_procesadas, filas_vacias, productos_importados,
     filas_con_error, errores_encontrados, estado, detalle, modo_stock,
     filas_ambiguas, ia_usada, ia_modelo, ia_ms)
  values
    (v_usuario, left(btrim(p_archivo), 255), p_hoja, p_tamano_bytes, v_filas_total,
     coalesce((p_detalle ->> 'filasVacias')::integer, 0), 0,
     v_con_error, v_con_error, 'FALLIDA', p_detalle, v_modo,
     greatest(coalesce((p_detalle ->> 'filasAmbiguas')::integer, 0), 0),
     coalesce((p_ia ->> 'usada')::boolean, false),
     nullif(p_ia ->> 'modelo', ''),
     nullif((p_ia ->> 'ms')::integer, 0))
  returning id_importacion into v_id;

  -- 8.1 Si hay una sola fila con error, no se aplica nada: el lote es
  --     atómico y el administrador tiene que corregir o excluir esa fila.
  if v_con_error > 0 then
    update public.importacion_producto
    set estado = 'RECHAZADA'
    where id_importacion = v_id;

    select coalesce(
      jsonb_agg(jsonb_build_object(
        'fila', fila, 'codigo', codigo, 'mensaje', error
      ) order by fila),
      '[]'::jsonb
    )
    into v_errores
    from pg_temp.imp_filas
    where error is not null;

    insert into public.importacion_producto_error (id_importacion, numero_fila, codigo, mensaje)
    select v_id, (e ->> 'fila')::integer, e ->> 'codigo', e ->> 'mensaje'
    from jsonb_array_elements(v_errores) with ordinality as t(e, n)
    where n <= 1000;

    return jsonb_build_object(
      'estado', 'RECHAZADA',
      'idImportacion', v_id,
      'rechazada', true,
      'resumen', jsonb_build_object(
        'filasProcesadas', v_filas_total,
        'filasConError', v_con_error,
        'productosCreados', 0,
        'productosActualizados', 0,
        'productosSinCambios', 0,
        'filasExcluidas', 0
      ),
      'filas', '[]'::jsonb,
      'errores', v_errores
    );
  end if;

  -- 9. Aplicar los cambios, fila por fila, en la misma transacción --------
  -- Si algo falla acá, el bloque de abajo revierte el lote y deja el
  -- historial como FALLIDA para que quede el motivo.
  begin
    v_motivo := case v_modo
      when 'REEMPLAZAR' then 'Importación de Excel: reemplazo de stock'
      when 'SUMAR'      then 'Importación de Excel: suma de stock'
      else 'Importación de Excel: alta de producto'
    end;

    select array_agg(ctid order by fila) into v_ctids from pg_temp.imp_filas;

    foreach v_ct in array v_ctids loop
      select * into v_fila from pg_temp.imp_filas where ctid = v_ct;

      -- Excluida a mano por el administrador
      if v_fila.accion = 'EXCLUIR' then
        v_excluidas := v_excluidas + 1;
        update pg_temp.imp_filas set accion = 'EXCLUIDA' where ctid = v_ct;
        continue;
      end if;

      -- 9.1 Producto nuevo: entra en 0 y el stock inicial queda como ENTRADA
      if v_fila.accion = 'CREAR' then
        v_id_categoria := null;
        if v_fila.categoria is not null then
          select c.id_categoria into v_id_categoria
          from public.categoria c
          where lower(btrim(c.nombre)) = lower(v_fila.categoria)
          limit 1;
        end if;

        insert into public.producto
          (codigo, nombre, descripcion, precio_costo, precio_venta,
           stock_actual, stock_minimo, stock_maximo, id_categoria, activo)
        values
          (v_fila.codigo, v_fila.nombre, v_fila.descripcion,
           round(coalesce(v_fila.costo, 0), 2), round(v_fila.precio, 2),
           0,
           coalesce(greatest(v_fila.stock_minimo, 0), 0),
           coalesce(greatest(v_fila.stock_maximo, 0), 0),
           v_id_categoria, coalesce(v_fila.activo, true))
        returning id_producto, stock_actual into v_id_producto, v_stock_final;

        v_movimiento := null;
        if coalesce(v_fila.stock, 0) > 0 then
          v_movimiento := (public.registrar_movimiento(
            v_id_producto, 'ENTRADA', v_fila.stock::integer,
            'Stock inicial por importación de Excel'
          )).id_movimiento;
          v_stock_final := v_fila.stock::integer;
        end if;

        v_creados := v_creados + 1;

        update pg_temp.imp_filas
        set accion = 'CREAR',
            id_producto = v_id_producto,
            stock_anterior = 0,
            stock_resultante = v_stock_final,
            id_movimiento = v_movimiento
        where ctid = v_ct;

        continue;
      end if;

      -- 9.2 Producto existente
      select * into v_producto
      from public.producto
      where id_producto = v_fila.id_producto
      for update;

      if not found then
        raise exception 'El producto % no existe (fila %)', v_fila.id_producto, v_fila.fila;
      end if;
      if coalesce(v_producto.eliminado, false) then
        raise exception 'El producto "%" está eliminado (fila %)', v_producto.nombre, v_fila.fila;
      end if;

      v_stock_final := v_producto.stock_actual;
      v_cambio_campos := false;
      v_movimiento := null;

      -- Categoría: solo si la fila trae una y es distinta a la actual
      v_id_categoria := v_producto.id_categoria;
      if v_fila.categoria is not null then
        select c.id_categoria into v_id_categoria
        from public.categoria c
        where lower(btrim(c.nombre)) = lower(v_fila.categoria)
        limit 1;

        if v_id_categoria is distinct from v_producto.id_categoria then
          v_cambio_campos := true;
        end if;
      end if;

      if v_producto.nombre is distinct from v_fila.nombre
         or (v_fila.descripcion is not null and v_producto.descripcion is distinct from v_fila.descripcion)
         or (v_fila.precio is not null and v_producto.precio_venta is distinct from round(v_fila.precio, 2))
         or (v_fila.costo is not null and v_producto.precio_costo is distinct from round(v_fila.costo, 2))
         or (v_fila.stock_minimo is not null and v_producto.stock_minimo is distinct from v_fila.stock_minimo::integer)
         or (v_fila.stock_maximo is not null and v_producto.stock_maximo is distinct from v_fila.stock_maximo::integer)
         or (v_fila.activo is not null and v_producto.activo is distinct from v_fila.activo)
      then
        v_cambio_campos := true;
      end if;

      -- Los campos del producto se guardan antes del movimiento de stock: si
      -- la fila reactiva un producto dado de baja, registrar_movimiento ya
      -- tiene que verlo activo.
      if v_cambio_campos then
        update public.producto
        set nombre       = v_fila.nombre,
            descripcion  = coalesce(v_fila.descripcion, descripcion),
            precio_venta = coalesce(round(v_fila.precio, 2), precio_venta),
            precio_costo = coalesce(round(v_fila.costo, 2), precio_costo),
            stock_minimo = coalesce(greatest(v_fila.stock_minimo, 0), stock_minimo),
            stock_maximo = coalesce(greatest(v_fila.stock_maximo, 0), stock_maximo),
            activo       = coalesce(v_fila.activo, activo),
            id_categoria = v_id_categoria
        where id_producto = v_producto.id_producto;
      end if;

      -- Stock: solo si hay modo elegido y la fila trae una cantidad.
      -- El estado "activo" que cuenta es el que quedará después de la fila.
      if v_modo is not null and v_fila.stock is not null then
        if v_modo = 'REEMPLAZAR' and v_fila.stock::integer <> v_producto.stock_actual then
          if not coalesce(v_fila.activo, v_producto.activo) then
            raise exception 'El producto "%" está dado de baja: activalo antes de importar su stock (fila %)',
              v_producto.nombre, v_fila.fila;
          end if;

          v_movimiento := (public.registrar_movimiento(
            v_producto.id_producto, 'AJUSTE', v_fila.stock::integer, v_motivo
          )).id_movimiento;
          v_stock_final := v_fila.stock::integer;

        elsif v_modo = 'SUMAR' and v_fila.stock::integer > 0 then
          if not coalesce(v_fila.activo, v_producto.activo) then
            raise exception 'El producto "%" está dado de baja: activalo antes de importar su stock (fila %)',
              v_producto.nombre, v_fila.fila;
          end if;

          v_movimiento := (public.registrar_movimiento(
            v_producto.id_producto, 'ENTRADA', v_fila.stock::integer, v_motivo
          )).id_movimiento;
          v_stock_final := v_producto.stock_actual + v_fila.stock::integer;
        end if;
      end if;

      v_cambio := v_cambio_campos or v_movimiento is not null;

      if v_cambio then
        v_actualizados := v_actualizados + 1;
      else
        v_sin_cambios := v_sin_cambios + 1;
      end if;

      update pg_temp.imp_filas
      set accion = case when v_cambio then 'ACTUALIZAR' else 'SIN_CAMBIOS' end,
          stock_anterior = v_producto.stock_actual,
          stock_resultante = v_stock_final,
          id_movimiento = v_movimiento
      where ctid = v_ct;
    end loop;

  exception when others then
    -- El lote entero se revierte (transacción implícita del bloque).
    update public.importacion_producto
    set estado = 'FALLIDA',
        detalle = detalle || jsonb_build_object('error', sqlerrm)
    where id_importacion = v_id;

    return jsonb_build_object(
      'estado', 'FALLIDA',
      'idImportacion', v_id,
      'mensaje', sqlerrm,
      'resumen', jsonb_build_object(
        'filasProcesadas', v_filas_total,
        'filasConError', 0,
        'productosCreados', 0,
        'productosActualizados', 0,
        'productosSinCambios', 0,
        'filasExcluidas', 0
      ),
      'filas', '[]'::jsonb,
      'errores', jsonb_build_array(jsonb_build_object('fila', null, 'codigo', null, 'mensaje', sqlerrm))
    );
  end;

  -- 10. Resumen, historial y detalle -------------------------------------
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'fila', fila,
      'codigo', codigo,
      'nombre', nombre,
      'accion', accion,
      'idProducto', id_producto,
      'stockAnterior', stock_anterior,
      'stockResultante', stock_resultante,
      'idMovimiento', id_movimiento
    ) order by fila),
    '[]'::jsonb
  )
  into v_filas
  from pg_temp.imp_filas;

  v_resumen := jsonb_build_object(
    'filasProcesadas', v_filas_total,
    'productosCreados', v_creados,
    'productosActualizados', v_actualizados,
    'productosSinCambios', v_sin_cambios,
    'filasExcluidas', v_excluidas,
    'filasConError', 0
  );

  v_resultado := jsonb_build_object(
    'estado', 'COMPLETADA',
    'idImportacion', v_id,
    'repetida', false,
    'resumen', v_resumen,
    'filas', v_filas
  );

  update public.importacion_producto
  set estado = 'COMPLETADA',
      idempotency_key = p_idempotency_key,
      hash_archivo = v_hash,
      productos_importados = v_creados,
      productos_actualizados = v_actualizados,
      productos_sin_cambios = v_sin_cambios,
      filas_con_error = 0,
      errores_encontrados = 0,
      detalle = detalle || jsonb_build_object('resultado', v_resultado)
  where id_importacion = v_id;

  insert into public.importacion_producto_fila
    (id_importacion, numero_fila, codigo, nombre, accion, id_producto,
     stock_anterior, stock_resultante, id_movimiento, mensaje)
  select v_id, fila, codigo, nombre, accion, id_producto,
         stock_anterior, stock_resultante, id_movimiento,
         case accion
           when 'EXCLUIDA' then 'Excluida por el administrador en la vista previa.'
           else null
         end
  from pg_temp.imp_filas
  order by fila;

  return v_resultado;
end;
$$;

revoke execute on function public.confirmar_importacion_productos(uuid, text, text, bigint, text, jsonb, boolean, jsonb, jsonb)
  from public, anon;
grant execute on function public.confirmar_importacion_productos(uuid, text, text, bigint, text, jsonb, boolean, jsonb, jsonb)
  to authenticated;

comment on function public.confirmar_importacion_productos(uuid, text, text, bigint, text, jsonb, boolean, jsonb, jsonb) is
  'Aplica una importación de Excel ya revisada por el administrador. Atómica e idempotente.';
