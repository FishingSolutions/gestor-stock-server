/**
 * Error con estado HTTP explícito. Los routers lanzan estos errores y el
 * middleware final los traduce a JSON sin filtrar detalles internos.
 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Envuelve handlers async para que los errores lleguen al middleware. */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

const CONSTRAINT_MESSAGES = {
  producto_codigo_key: 'Ya existe un producto con ese código.',
  categoria_nombre_key: 'Ya existe una categoría con ese nombre.',
  producto_pkey: 'El producto ya existe.',
  categoria_pkey: 'La categoría ya existe.',
}

/**
 * Convierte errores conocidos de PostgreSQL en HttpError con un mensaje
 * entendible en español. Devuelve null si no reconoce el código.
 */
export function mapPgError(error) {
  switch (error.code) {
    case '23505':
      return new HttpError(
        409,
        CONSTRAINT_MESSAGES[error.constraint] ||
          'Ya existe un registro con ese valor único.',
      )
    case '23503':
      return new HttpError(
        409,
        'La operación choca con registros relacionados (por ejemplo, movimientos de stock).',
      )
    case '23502':
      return new HttpError(400, 'Faltan datos obligatorios.')
    case '23514':
      return new HttpError(
        400,
        'Datos inválidos: revisá límites de stock y valores negativos.',
      )
    case '22P02':
      return new HttpError(400, 'Algún identificador o valor tiene un formato inválido.')
    case 'P0001':
      // Las funciones de la base ya devuelven mensajes claros en español.
      return new HttpError(400, error.message)
    default:
      return null
  }
}

/** Middleware final de errores. */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error)

  if (error.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: 'El cuerpo de la solicitud no es JSON válido.' })
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El cuerpo de la solicitud es demasiado grande.' })
  }

  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message })
  }

  const mapped = mapPgError(error)
  if (mapped) {
    return res.status(mapped.status).json({ error: mapped.message })
  }

  console.error('Error no controlado:', error)
  return res.status(500).json({ error: 'Error interno del servidor.' })
}
