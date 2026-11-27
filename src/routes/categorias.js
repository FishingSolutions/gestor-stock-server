import { Router } from 'express'
import { pool } from '../db.js'
import { HttpError, asyncHandler } from '../errors.js'
import { requireActiveUser, requireAdmin, requireAuth } from '../auth.js'
import { toCategory } from '../mappers.js'
import { parseText, parseUuid } from '../validate.js'

const router = Router()

router.use(requireAuth, requireActiveUser)

const CATEGORY_FIELDS = 'id_categoria, nombre, descripcion'

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `select ${CATEGORY_FIELDS}
         from public.categoria
        order by lower(nombre)`,
    )

    res.json(rows.map(toCategory))
  }),
)

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const nombre = parseText(req.body?.nombre, {
      name: 'nombre',
      required: true,
      max: 100,
    })
    const descripcion = parseText(req.body?.descripcion, {
      name: 'descripción',
      max: 2000,
    })

    const { rows } = await pool.query(
      `insert into public.categoria (nombre, descripcion)
       values ($1, $2)
       returning ${CATEGORY_FIELDS}`,
      [nombre, descripcion],
    )

    res.status(201).json(toCategory(rows[0]))
  }),
)

router.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseUuid(req.params.id, 'id de categoría')
    const body = req.body ?? {}

    const { rows: currentRows } = await pool.query(
      `select ${CATEGORY_FIELDS} from public.categoria where id_categoria = $1`,
      [id],
    )

    const current = currentRows[0]

    if (!current) {
      throw new HttpError(404, 'La categoría no existe.')
    }

    const nombre =
      body.nombre === undefined
        ? current.nombre
        : parseText(body.nombre, { name: 'nombre', required: true, max: 100 })

    const descripcion =
      body.descripcion === undefined
        ? current.descripcion
        : parseText(body.descripcion, { name: 'descripción', max: 2000 })

    const { rows } = await pool.query(
      `update public.categoria
          set nombre = $1, descripcion = $2
        where id_categoria = $3
        returning ${CATEGORY_FIELDS}`,
      [nombre, descripcion, id],
    )

    res.json(toCategory(rows[0]))
  }),
)

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseUuid(req.params.id, 'id de categoría')

    const { rowCount } = await pool.query(
      'delete from public.categoria where id_categoria = $1',
      [id],
    )

    if (rowCount === 0) {
      throw new HttpError(404, 'La categoría no existe.')
    }

    res.status(204).end()
  }),
)

export default router
