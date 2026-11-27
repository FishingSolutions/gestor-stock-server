/**
 * Prueba end-to-end de la API usando un usuario real de Supabase.
 *
 * Uso:
 *   1. Completá TEST_EMAIL y TEST_PASSWORD en gestor-stock-server/.env
 *   2. npm run dev   (en otra terminal)
 *   3. node scripts/test-api.js
 *
 * Ojo: registra una ENTRADA y una SALIDA compensatoria sobre el primer
 * producto, así que deja dos movimientos de prueba en el historial (el stock
 * final queda igual al inicial).
 */
import 'dotenv/config'

const API_URL = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '')
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
const EMAIL = process.env.TEST_EMAIL
const PASSWORD = process.env.TEST_PASSWORD

let fallos = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  OK   ${label}`)
  } else {
    fallos += 1
    console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`)
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let data = null

  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  return { status: response.status, data }
}

async function login() {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: EMAIL.trim(), password: PASSWORD }),
    },
  )

  const data = await response.json().catch(() => null)

  if (!response.ok || !data?.access_token) {
    throw new Error(
      `No se pudo iniciar sesión: ${data?.error_description || data?.msg || response.status}`,
    )
  }

  return data.access_token
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Faltan SUPABASE_URL / SUPABASE_ANON_KEY en el .env.')
  }

  if (!EMAIL || !PASSWORD) {
    throw new Error(
      'Completá TEST_EMAIL y TEST_PASSWORD en gestor-stock-server/.env para correr esta prueba.',
    )
  }

  console.log(`\nAPI: ${API_URL}\n`)

  console.log('1. Sin token')
  const noToken = await api('/api/movimientos')
  check('GET /api/movimientos responde 401', noToken.status === 401, noToken.status)

  console.log('\n2. Login en Supabase')
  const token = await login()
  console.log('  OK   token obtenido')

  console.log('\n3. Lecturas autenticadas')
  const productos = await api('/api/productos?limit=1', { token })
  check('GET /api/productos responde 200', productos.status === 200, productos.status)
  check('devuelve items', Array.isArray(productos.data?.items))

  const categorias = await api('/api/categorias', { token })
  check('GET /api/categorias responde 200', categorias.status === 200, categorias.status)

  const movimientos = await api('/api/movimientos?limit=5', { token })
  check('GET /api/movimientos responde 200', movimientos.status === 200, movimientos.status)

  const producto = productos.data?.items?.[0]

  if (!producto) {
    console.log('\nNo hay productos: se omiten las pruebas de escritura.')
    return
  }

  console.log(`\n4. Movimientos sobre "${producto.nombre}" (#${producto.id})`)
  const stockInicial = producto.stockActual

  const entrada = await api('/api/movimientos', {
    method: 'POST',
    token,
    body: {
      idProducto: producto.id,
      tipo: 'ENTRADA',
      cantidad: 2,
      motivo: 'Prueba automática de API (entrada)',
    },
  })
  check('POST ENTRADA responde 201', entrada.status === 201, `${entrada.status} ${JSON.stringify(entrada.data)}`)
  check(
    'el stock sube 2',
    entrada.data?.stockActual === stockInicial + 2,
    `${entrada.data?.stockActual} vs ${stockInicial + 2}`,
  )

  const salida = await api('/api/movimientos', {
    method: 'POST',
    token,
    body: {
      idProducto: producto.id,
      tipo: 'SALIDA',
      cantidad: 2,
      motivo: 'Prueba automática de API (salida)',
    },
  })
  check('POST SALIDA responde 201', salida.status === 201, salida.status)
  check(
    'el stock vuelve al valor inicial',
    salida.data?.stockActual === stockInicial,
    `${salida.data?.stockActual} vs ${stockInicial}`,
  )

  console.log('\n5. Validaciones')
  const tipoInvalido = await api('/api/movimientos', {
    method: 'POST',
    token,
    body: {
      idProducto: producto.id,
      tipo: 'COSA',
      cantidad: 1,
      motivo: 'Prueba inválida',
    },
  })
  check('tipo inválido responde 400', tipoInvalido.status === 400, tipoInvalido.status)

  const sinMotivo = await api('/api/movimientos', {
    method: 'POST',
    token,
    body: { idProducto: producto.id, tipo: 'ENTRADA', cantidad: 1, motivo: '' },
  })
  check('motivo vacío responde 400', sinMotivo.status === 400, sinMotivo.status)

  const historial = await api(`/api/movimientos?idProducto=${producto.id}&limit=2`, {
    token,
  })
  check(
    'el historial del producto incluye los movimientos nuevos',
    historial.status === 200 && historial.data?.total >= 2,
    historial.data?.total,
  )
}

main()
  .catch((error) => {
    fallos += 1
    console.error(`\nERROR: ${error.message}`)
  })
  .finally(() => {
    console.log(
      fallos === 0
        ? '\nTodo OK.\n'
        : `\n${fallos} comprobación(es) fallaron.\n`,
    )
    process.exitCode = fallos === 0 ? 0 : 1
  })
