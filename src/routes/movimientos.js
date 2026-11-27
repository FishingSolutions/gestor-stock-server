import { Router } from 'express'
import { pool, withUserContext } from '../db.js'
import { HttpError, asyncHandler } from '../errors.js'
import { requireActiveUser, requireAuth } from '../auth.js'
import { toMovement } from '../mappers.js'
import {
  parseIntegerId,
  parseNonNegativeInteger,
  parsePagination,
  parsePositiveInteger,
  parseText,
} from '../validate.js'

const router = Router()

router.use(requireAuth, requireActiveUser)

const VIEW = 'public.v_movimiento'
const TIPOS = ['ENTRADA', 'SALIDA', 'AJUSTE']

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 20 })

    const conditions = []
    const params = []

    if (req.query.idProducto) {
      params.push(parseIntegerId(req.query.idProducto, 'id de producto'))
      conditions.push(`id_producto = $${params.length}`)
    }

    if (req.query.tipo) {
      const tipo = parseText(req.query.tipo, {
        name: 'tipo de movimiento',
        required: true,
        max: 20,
      }).toUpperCase()

      if (!TIPOS.includes(tipo)) {
        throw new HttpError(
          400,
          'El tipo tiene que ser ENTRADA, SALIDA o AJUSTE.',
        )
      }

      params.push(tipo)
      conditions.push(`tipo_movimiento = $${params.length}`)
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
        order by fecha_movimiento desc, id_movimiento desc
        limit $${pageParams.length - 1} offset $${pageParams.length}`,
      pageParams,
    )

    res.json({
      items: rows.map(toMovement),
      total: countRows[0].total,
      limit,
      offset,
    })
  }),
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {}

    const idProducto = parseIntegerId(
      body.idProducto ?? body.id_producto,
      'id de producto',
    )

    const tipo = parseText(body.tipo, {
      name: 'tipo de movimiento',
      required: true,
      max: 20,
    }).toUpperCase()

    if (!TIPOS.includes(tipo)) {
      throw new HttpError(400, 'El tipo tiene que ser ENTRADA, SALIDA o AJUSTE.')
    }

    const cantidad =
      tipo === 'AJUSTE'
        ? parseNonNegativeInteger(body.cantidad, {
            name: 'stock contado',
            required: true,
          })
        : parsePositiveInteger(body.cantidad, {
            name: 'cantidad',
            required: true,
          })

    const motivo = parseText(body.motivo, {
      name: 'motivo',
      required: true,
      max: 500,
    })

    const movement = await withUserContext(
      req.profile.id_usuario,
      async (client) => {
        const { rows: inserted } = await client.query(
          'select * from public.registrar_movimiento($1, $2, $3, $4)',
          [idProducto, tipo, cantidad, motivo],
        )

        const { rows } = await client.query(
          `select * from ${VIEW} where id_movimiento = $1`,
          [inserted[0].id_movimiento],
        )

        return rows[0] ?? inserted[0]
      },
    )

    res.status(201).json({
      ...toMovement(movement),
      stockActual: Number(movement.stock_resultante) || 0,
    })
  }),
)

export default router
