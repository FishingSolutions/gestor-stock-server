import { HttpError } from './errors.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseIntegerId(value, name = 'id') {
  const text = String(value ?? '').trim()

  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, `El ${name} es inválido.`)
  }

  return text
}

export function parseUuid(value, name = 'id') {
  const text = String(value ?? '').trim()

  if (!UUID_PATTERN.test(text)) {
    throw new HttpError(400, `El ${name} es inválido.`)
  }

  return text
}

export function parseText(
  value,
  { name = 'campo', required = false, max = 500 } = {},
) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `El ${name} es obligatorio.`)
    return null
  }

  const text = String(value).trim()

  if (!text) {
    if (required) throw new HttpError(400, `El ${name} es obligatorio.`)
    return null
  }

  if (text.length > max) {
    throw new HttpError(400, `El ${name} no puede tener más de ${max} caracteres.`)
  }

  return text
}

export function parseNonNegativeNumber(
  value,
  { name = 'valor', required = false } = {},
) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `El ${name} es obligatorio.`)
    return null
  }

  const number = Number(value)

  if (!Number.isFinite(number) || number < 0) {
    throw new HttpError(400, `El ${name} tiene que ser un número mayor o igual a 0.`)
  }

  return number
}

export function parseNonNegativeInteger(
  value,
  { name = 'valor', required = false } = {},
) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `El ${name} es obligatorio.`)
    return null
  }

  const number = Number(value)

  if (!Number.isInteger(number) || number < 0) {
    throw new HttpError(
      400,
      `El ${name} tiene que ser un número entero mayor o igual a 0.`,
    )
  }

  return number
}

export function parsePositiveInteger(
  value,
  { name = 'valor', required = false } = {},
) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `El ${name} es obligatorio.`)
    return null
  }

  const number = Number(value)

  if (!Number.isInteger(number) || number <= 0) {
    throw new HttpError(400, `El ${name} tiene que ser un entero mayor a 0.`)
  }

  return number
}

export function parseBoolean(value, { name = 'valor', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `El ${name} es obligatorio.`)
    return null
  }

  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false

  throw new HttpError(400, `El ${name} tiene que ser verdadero o falso.`)
}

export function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)

  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new HttpError(
      400,
      `El límite tiene que ser un entero entre 1 y ${maxLimit}.`,
    )
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new HttpError(400, 'El desplazamiento tiene que ser un entero mayor o igual a 0.')
  }

  return { limit, offset }
}
