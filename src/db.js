import pg from 'pg'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    'Falta DATABASE_URL en el archivo .env del servidor (ver .env.example).',
  )
}

/**
 * Pool único de PostgreSQL para todo el backend.
 * Supabase exige SSL; el certificado del pooler se acepta sin verificación
 * local porque lo gestiona Supabase.
 */
export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
})

pool.on('error', (error) => {
  console.error('Error inesperado en el pool de PostgreSQL:', error.message)
})

/**
 * Ejecuta `fn` dentro de una transacción con el usuario de Supabase como
 * contexto, para que `auth.uid()` y `rol_actual()` funcionen igual que en el
 * cliente (las RPC de la base dependen de eso).
 *
 * El backend se conecta como `postgres` (bypassa RLS), así que además cada
 * endpoint valida permisos por su cuenta.
 */
export async function withUserContext(userId, fn) {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])

    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Si la conexión ya está rota no hay nada más que hacer.
    }
    throw error
  } finally {
    client.release()
  }
}
