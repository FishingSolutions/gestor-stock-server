import { pool } from './db.js'
import { HttpError } from './errors.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

function readBearerToken(req) {
  const header = req.headers.authorization

  if (!header) return null

  const [scheme, token] = header.split(' ')
  if (!token || scheme.toLowerCase() !== 'bearer') return null

  return token.trim()
}

/**
 * Valida el access token de Supabase contra su API de Auth.
 * No usamos dependencias nuevas: alcanza con `fetch`.
 *
 * Deja el usuario en `req.authUser = { id, email }`.
 */
export async function requireAuth(req, res, next) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new HttpError(
        500,
        'El servidor no tiene configuradas SUPABASE_URL y SUPABASE_ANON_KEY.',
      )
    }

    const token = readBearerToken(req)

    if (!token) {
      throw new HttpError(401, 'Falta el token de autenticación.')
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    })

    if (!response.ok) {
      throw new HttpError(401, 'El token es inválido o expiró.')
    }

    const user = await response.json()

    if (!user?.id) {
      throw new HttpError(401, 'El token no corresponde a un usuario válido.')
    }

    req.authUser = { id: user.id, email: user.email ?? null }
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Carga el perfil local (`public.usuario`) y exige que esté activo.
 * Deja el perfil en `req.profile`.
 */
export async function requireActiveUser(req, res, next) {
  try {
    const { rows } = await pool.query(
      `select id_usuario, nombre, apellido, email, rol, activo
         from public.usuario
        where id_usuario = $1`,
      [req.authUser.id],
    )

    const profile = rows[0]

    if (!profile) {
      throw new HttpError(403, 'Tu usuario no tiene perfil en el sistema.')
    }

    if (!profile.activo) {
      throw new HttpError(403, 'Tu usuario está inactivo.')
    }

    req.profile = profile
    next()
  } catch (error) {
    next(error)
  }
}

/** Exige rol ADMINISTRADOR para las operaciones de escritura. */
export function requireAdmin(req, res, next) {
  if (req.profile?.rol !== 'ADMINISTRADOR') {
    return next(
      new HttpError(403, 'Solo un administrador puede realizar esta acción.'),
    )
  }

  next()
}
