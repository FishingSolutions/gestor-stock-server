import { Router } from 'express'
import { pool, withUserContext } from '../db.js'
import { HttpError, asyncHandler } from '../errors.js'
import { requireActiveUser, requireAdmin, requireAuth } from '../auth.js'
import { toProduct } from '../mappers.js'
import {
  parseBoolean,
  parseIntegerId,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parsePagination,
  parseText,
  parseUuid,
} from '../validate.js'

const router = Router()

router.use(requireAuth, requireActiveUser)

const VIEW = 'public.v_producto'

async function findProductRow(client, id) {
  const { rows } = await client.query(
    `select * from ${VIEW} where id_producto = $1`,
    [id],
  )

  return rows[0] ?? null
}

async function assertCategoryExists(client, idCategoria) {
  if (!idCategoria) return

  const { rowCount } = await client.query(
    'select 1 from public.categoria where id_categoria = $1',
    [idCategoria],
  )

  if (rowCount === 0) {
    throw new HttpError(400, 'La categoría indicada no existe.')
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query)

    const conditions = []
    const params = []

    if (req.query.search) {
      const term = `%${parseText(req.query.search, { name: 'búsqueda', max: 100 })}%`
      params.push(term)
      conditions.push(
        `(codigo ilike $${params.length} or nombre ilike $${params.length})`,
      )
    }

    const activo = parseBoolean(req.query.activo, { name: 'activo' })
    if (activo !== null) {
      params.push(activo)
      conditions.push(`activo = $${params.length}`)
    }

    if (req.query.idCategoria) {
      params.push(parseUuid(req.query.idCategoria, 'id de categoría'))
      conditions.push(`id_categoria = $${params.length}`)
    }

    const where = conditions.length ? `where ${conditions.join(' and ')}` : ''

    const { rows: countRows } = await pool.query(
      `select count(*)::int as total from ${VIEW} ${where}`,
      params,
    )

    const pageParams = [...params, limit, offset]
    const { rows } = await pool.query(
      `select * from ${VIEW}
        ${where}
        order by id_producto desc
        limit $${pageParams.length - 1} offset $${pageParams.length}`,
      pageParams,
    )

    res.json({
      items: rows.map(toProduct),
      total: countRows[0].total,
      limit,
      offset,
    })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntegerId(req.params.id, 'id de producto')
    const product = await findProductRow(pool, id)

    if (!product) {
      throw new HttpError(404, 'El producto no existe.')
    }

    res.json(toProduct(product))
  }),
)

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {}

    const codigo = parseText(body.codigo, {
      name: 'código',
      required: true,
      max: 50,
    })
    const nombre = parseText(body.nombre, {
      name: 'nombre',
      required: true,
      max: 100,
    })
    const descripcion = parseText(body.descripcion, {
      name: 'descripción',
      max: 2000,
    })
    const precioCosto =
      parseNonNegativeNumber(body.precioCosto, { name: 'precio de costo' }) ?? 0
    const precioVenta =
      parseNonNegativeNumber(body.precioVenta, { name: 'precio de venta' }) ?? 0
    const stockActual =
      parseNonNegativeInteger(body.stockActual, { name: 'stock actual' }) ?? 0
    const stockMinimo =
      parseNonNegativeInteger(body.stockMinimo, { name: 'stock mínimo' }) ?? 0
    const stockMaximo =
      parseNonNegativeInteger(body.stockMaximo, { name: 'stock máximo' }) ?? 0
    const activo = parseBoolean(body.activo, { name: 'activo' }) ?? true
    const idCategoria = body.idCategoria
      ? parseUuid(body.idCategoria, 'id de categoría')
      : null

    if (stockMaximo < stockMinimo) {
      throw new HttpError(
        400,
        'El stock máximo no puede ser menor que el stock mínimo.',
      )
    }

    const product = await withUserContext(req.profile.id_usuario, async (client) => {
      await assertCategoryExists(client, idCategoria)

      const { rows: inserted } = await client.query(
        `insert into public.producto
           (codigo, nombre, descripcion, precio_costo, precio_venta,
            stock_actual, stock_minimo, stock_maximo, activo, id_categoria)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id_producto`,
        [
          codigo,
          nombre,
          descripcion,
          precioCosto,
          precioVenta,
          stockActual,
          stockMinimo,
          stockMaximo,
          activo,
          idCategoria,
        ],
      )

      return findProductRow(client, inserted[0].id_producto)
    })

    res.status(201).json(toProduct(product))
  }),
)

router.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseIntegerId(req.params.id, 'id de producto')
    const body = req.body ?? {}

    const motivoAjuste = parseText(body.motivoAjuste ?? body.motivo, {
      name: 'motivo del ajuste',
      max: 500,
    })

    const result = await withUserContext(req.profile.id_usuario, async (client) => {
      const { rows: currentRows } = await client.query(
        'select * from public.producto where id_producto = $1 for update',
        [id],
      )

      const current = currentRows[0]

      if (!current) {
        throw new HttpError(404, 'El producto no existe.')
      }

      const codigo =
        body.codigo === undefined
          ? current.codigo
          : parseText(body.codigo, {
              name: 'código',
              required: true,
              max: 50,
            })
      const nombre =
        body.nombre === undefined
          ? current.nombre
          : parseText(body.nombre, {
              name: 'nombre',
              required: true,
              max: 100,
            })
      const descripcion =
        body.descripcion === undefined
          ? current.descripcion
          : parseText(body.descripcion, { name: 'descripción', max: 2000 })
      const precioCosto =
        body.precioCosto === undefined
          ? Number(current.precio_costo)
          : parseNonNegativeNumber(body.precioCosto, {
              name: 'precio de costo',
            })
      const precioVenta =
        body.precioVenta === undefined
          ? Number(current.precio_venta)
          : parseNonNegativeNumber(body.precioVenta, {
              name: 'precio de venta',
            })
      const stockMinimo =
        body.stockMinimo === undefined
          ? current.stock_minimo
          : parseNonNegativeInteger(body.stockMinimo, {
              name: 'stock mínimo',
            })
      const stockMaximo =
        body.stockMaximo === undefined
          ? current.stock_maximo
          : parseNonNegativeInteger(body.stockMaximo, {
              name: 'stock máximo',
            })
      const activo =
        body.activo === undefined
          ? current.activo
          : parseBoolean(body.activo, { name: 'activo' })
      const idCategoria =
        body.idCategoria === undefined
          ? current.id_categoria
          : body.idCategoria === null || body.idCategoria === ''
            ? null
            : parseUuid(body.idCategoria, 'id de categoría')
      const stockActual =
        body.stockActual === undefined
          ? current.stock_actual
          : parseNonNegativeInteger(body.stockActual, { name: 'stock actual' })

      if (stockMaximo < stockMinimo) {
        throw new HttpError(
          400,
          'El stock máximo no puede ser menor que el stock mínimo.',
        )
      }

      await assertCategoryExists(client, idCategoria)

      await client.query(
        `update public.producto
            set codigo = $1,
                nombre = $2,
                descripcion = $3,
                precio_costo = $4,
                precio_venta = $5,
                stock_minimo = $6,
                stock_maximo = $7,
                activo = $8,
                id_categoria = $9
          where id_producto = $10`,
        [
          codigo,
          nombre,
          descripcion,
          precioCosto,
          precioVenta,
          stockMinimo,
          stockMaximo,
          activo,
          idCategoria,
          id,
        ],
      )

      let movimiento = null

      if (stockActual !== current.stock_actual) {
        if (!motivoAjuste) {
          throw new HttpError(
            400,
            'Indicá el motivo del ajuste de stock para registrarlo.',
          )
        }

        const { rows } = await client.query(
          'select * from public.registrar_movimiento($1, $2, $3, $4)',
          [id, 'AJUSTE', stockActual, motivoAjuste],
        )

        movimiento = rows[0]
      }

      const product = await findProductRow(client, id)

      return {
        product,
        movimientoId: movimiento ? String(movimiento.id_movimiento) : null,
      }
    })

    res.json({
      ...toProduct(result.product),
      movimientoId: result.movimientoId,
    })
  }),
)

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseIntegerId(req.params.id, 'id de producto')

    const { rowCount } = await pool.query(
      'delete from public.producto where id_producto = $1',
      [id],
    )

    if (rowCount === 0) {
      throw new HttpError(404, 'El producto no existe.')
    }

    res.status(204).end()
  }),
)

export default router
