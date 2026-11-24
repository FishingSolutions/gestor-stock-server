// Pruebas del enmascarado de datos que se envían a la IA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ejecutarIAConReserva } from './consumo-ia.ts'
import {
  enmascarar,
  limiteEntero,
  muestrasParaIA,
  sugerirMapeo,
  validarConfiguracionProveedor,
} from './ia.ts'

test('la IA requiere proveedor y modelo configurados explícitamente', () => {
  assert.equal(validarConfiguracionProveedor('clave', null, 'modelo'), null)
  assert.equal(validarConfiguracionProveedor('clave', 'https://generativelanguage.googleapis.com/v1beta/openai', null), null)
  assert.equal(
    validarConfiguracionProveedor('clave', 'http://generativelanguage.googleapis.com/v1beta/openai', 'modelo'),
    null,
  )

  const configuracion = validarConfiguracionProveedor(
    ' clave ',
    'https://generativelanguage.googleapis.com/v1beta/openai/',
    ' modelo-confirmado ',
  )
  assert.equal(configuracion?.apiKey, 'clave')
  assert.equal(configuracion?.url.href, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  assert.equal(configuracion?.modelo, 'modelo-confirmado')
  assert.equal(
    validarConfiguracionProveedor('clave', 'https://api.openai.com/v1', 'modelo')?.url.href,
    'https://api.openai.com/v1/chat/completions',
  )
})

test('rechaza URLs de proveedor maliciosas o incompatibles', () => {
  const maliciosas = [
    'http://generativelanguage.googleapis.com/v1beta/openai',
    'https://generativelanguage.googleapis.com.attacker.example/v1beta/openai',
    'https://attacker.example/generativelanguage.googleapis.com/v1beta/openai',
    'https://user:pass@generativelanguage.googleapis.com/v1beta/openai',
    'https://generativelanguage.googleapis.com:8443/v1beta/openai',
    'https://generativelanguage.googleapis.com/v1beta/openai?redirect=https://attacker.example',
    'https://generativelanguage.googleapis.com/v1beta/openai#fragment',
    'https://generativelanguage.googleapis.com/v1',
  ]
  for (const url of maliciosas) {
    assert.equal(validarConfiguracionProveedor('clave', url, 'modelo'), null, url)
  }
})

test('valida estrictamente timeout y cantidad de muestras', () => {
  assert.equal(limiteEntero(undefined, 15000, 1000, 30000), 15000)
  assert.equal(limiteEntero('abc', 15000, 1000, 30000), 15000)
  assert.equal(limiteEntero('1.5', 15000, 1000, 30000), 15000)
  assert.equal(limiteEntero('999999', 15000, 1000, 30000), 30000)
  assert.equal(limiteEntero('10', 10, 1, 10), 10)
  assert.equal(limiteEntero('0', 10, 1, 10), 1)
  assert.equal(limiteEntero('-5', 10, 1, 10), 1)
})

test('configuración fuera de rango se limita a valores seguros', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalError = console.error
  let body: any
  let timeoutSignal: AbortSignal | undefined
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secret',
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
      AI_TIMEOUT_MS: '999999',
      AI_MAX_SAMPLE_ROWS: '999999',
    }[name]) },
  }
  console.error = () => {}
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body))
    timeoutSignal = init?.signal as AbortSignal
    return Response.json({ choices: [{ message: { content: '{"columnas":{}}' } }] })
  }
  try {
    await sugerirMapeo(['A'], Array.from({ length: 20 }, (_, i) => ({ celdas: [String(i)] })))
    const texto = body.messages[1].content
    const muestras = JSON.parse(texto.slice(texto.indexOf('[', texto.indexOf('muestra'))))
    assert.equal(muestras.length, 10)
    assert.equal(timeoutSignal?.aborted, false)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('los números no salen del sistema', () => {
  assert.equal(enmascarar(1500), '<numero>')
  assert.equal(enmascarar('1500'), '<numero>')
  assert.equal(enmascarar('15.000'), '<numero>')
  assert.equal(enmascarar('$ 1.500,50'), '<numero>')
  assert.equal(enmascarar('ARS 300'), '<numero>')
})

test('las fechas se reemplazan por su tipo', () => {
  assert.equal(enmascarar('18/11/2026'), '<fecha>')
  assert.equal(enmascarar(new Date('2026-11-18')), '<fecha>')
})

test('los textos comerciales se reemplazan por un marcador genérico', () => {
  assert.equal(enmascarar('SKU-CLIENTE-123'), '<texto>')
  assert.equal(enmascarar('Teclado Logitech'), '<texto>')
  assert.equal(enmascarar('SI'), '<booleano>')
})

test('las muestras solo incluyen hasta 10 filas y sin números', () => {
  const filas = Array.from({ length: 30 }, (_, i) => ({
    celdas: [`SKU-PRIVADO-${i}`, 1000 + i, 'Cliente confidencial'],
  }))
  const muestras = muestrasParaIA(filas, ['Codigo', 'Precio', 'Nombre'])

  assert.equal(muestras.length, 10)
  assert.deepEqual(muestras[0], ['<texto>', '<numero>', '<texto>'])
  assert.equal(JSON.stringify(muestras).includes('SKU-PRIVADO'), false)
  assert.equal(JSON.stringify(muestras).includes('Cliente confidencial'), false)
})

test('HTTP 429 se devuelve como resultado controlado sin exponer la clave', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalError = console.error
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secreto-no-loguear',
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
    }[name]) },
  }
  console.error = () => {}
  globalThis.fetch = async () => new Response('', { status: 429 })
  try {
    const resultado = await sugerirMapeo(['sku', 'desc'], [{ celdas: ['private', 'private'] }])
    assert.equal(resultado.usada, false)
    assert.equal(resultado.motivo, 'IA_SIN_CUOTA')
    assert.equal(JSON.stringify(resultado).includes('secreto-no-loguear'), false)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('timeout del proveedor se devuelve como TIMEOUT y no filtra credenciales', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalError = console.error
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secreto-no-loguear',
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
    }[name]) },
  }
  console.error = () => {}
  globalThis.fetch = async () => {
    const error = new Error('request aborted')
    error.name = 'AbortError'
    throw error
  }
  try {
    const resultado = await sugerirMapeo(['sku'], [{ celdas: ['private'] }])
    assert.equal(resultado.usada, false)
    assert.equal(resultado.motivo, 'IA_TIMEOUT')
    assert.equal(JSON.stringify(resultado).includes('secreto-no-loguear'), false)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('request exitoso usa endpoint compatible y la forma esperada', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const apiKey = 'key-no-debe-aparecer-en-logs'
  let request: { url: string; init: RequestInit } | null = null
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: apiKey,
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-3.5-flash-lite',
    }[name]) },
  }
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init: init as RequestInit }
    return Response.json({
      choices: [{ message: { content: '{"columnas":{"codigo":0}}' } }],
    })
  }
  try {
    const resultado = await sugerirMapeo(
      ['SKU interno', 'Precio venta', 'X'.repeat(50_000)],
      [{ celdas: ['dato-comercial', 1234, 'otro-dato'] }],
    )
    assert.equal(resultado.usada, true)
    assert.equal(resultado.motivo, null)
    assert.equal(request?.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    const body = JSON.parse(String(request?.init.body))
    assert.equal(body.model, 'gemini-3.5-flash-lite')
    assert.equal(body.max_tokens, 400)
    assert.equal(body.temperature, 0)
    assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['system', 'user'])
    assert.equal(JSON.stringify(body).includes('dato-comercial'), false)
    assert.equal(JSON.stringify(body).includes('X'.repeat(201)), false)
    assert.ok(JSON.stringify(body).length < 5000)
    assert.equal((request?.init.headers as Record<string, string>).Authorization, `Bearer ${apiKey}`)
  } finally {
    globalThis.fetch = originalFetch
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('errores HTTP se diferencian y el diagnóstico no filtra clave ni encabezados', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const originalWarn = console.warn
  const apiKey = 'provider-secret-key-for-test'
  const logs: unknown[] = []
  const casos = [
    [400, 'IA_ERROR_HTTP_400'],
    [401, 'IA_ERROR_HTTP_401'],
    [403, 'IA_ERROR_HTTP_403'],
    [404, 'IA_ERROR_HTTP_404'],
    [429, 'IA_SIN_CUOTA'],
    [500, 'IA_ERROR_HTTP_500'],
    [503, 'IA_ERROR_HTTP_503'],
  ] as const
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: apiKey,
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
    }[name]) },
  }
  console.error = (...args) => logs.push(args)
  console.warn = (...args) => logs.push(args)
  try {
    for (const [status, motivo] of casos) {
      let intentos = 0
      globalThis.fetch = async () => {
        intentos++
        return Response.json({
          error: {
            code: `PROVIDER_${status}`,
            status: `STATUS_${status}`,
            message: `Rejected Customer Header with key=${apiKey}`,
          },
        }, { status })
      }
      const resultado = await sugerirMapeo(
        ['Customer Header', 'price'],
        [{ celdas: ['<texto>', '<numero>'] }],
      )
      assert.equal(resultado.motivo, motivo)
      assert.equal(resultado.usada, false)
      assert.equal(intentos, status === 503 ? 2 : 1)
    }

    const textoLogs = JSON.stringify(logs)
    assert.equal(textoLogs.includes(apiKey), false)
    assert.equal(textoLogs.includes('Customer Header'), false)
    assert.match(textoLogs, /PROVIDER_503/)
    assert.match(textoLogs, /STATUS_503/)
    assert.match(textoLogs, /Rejected/)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    console.warn = originalWarn
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('un 503 se reintenta una vez bajo una sola reserva y finalización', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const originalError = console.error
  let intentosProveedor = 0
  let reservas = 0
  let finalizaciones = 0
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secret',
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
    }[name]) },
  }
  console.warn = () => {}
  console.error = () => {}
  globalThis.fetch = async () => {
    intentosProveedor++
    if (intentosProveedor === 1) {
      return Response.json({ error: { code: 'UNAVAILABLE', message: 'temporary' } }, { status: 503 })
    }
    return Response.json({
      choices: [{ message: { content: '{"columnas":{"codigo":0}}' } }],
    })
  }
  try {
    const resultado = await ejecutarIAConReserva(
      async () => {
        reservas++
        return { ok: true as const, id: 31 }
      },
      () => sugerirMapeo(['SKU'], [{ celdas: ['masked'] }]),
      async () => {
        finalizaciones++
      },
      'gemini-test',
    )
    assert.equal(resultado.usada, true)
    assert.equal(intentosProveedor, 2)
    assert.equal(reservas, 1)
    assert.equal(finalizaciones, 1)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    console.error = originalError
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('el timeout total aborta la solicitud y no intenta recuperarla como error HTTP', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalError = console.error
  let intentos = 0
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secret',
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
      AI_TIMEOUT_MS: '10',
    }[name]) },
  }
  console.error = () => {}
  globalThis.fetch = async (_url, init) => {
    intentos++
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      })
    })
  }
  try {
    const resultado = await sugerirMapeo(['SKU'], [{ celdas: ['masked'] }])
    assert.equal(resultado.motivo, 'IA_TIMEOUT')
    assert.equal(intentos, 1)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('el 503 no extiende el límite total de timeout configurado', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const originalWarn = console.warn
  let intentos = 0
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secret',
      AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      AI_MODEL: 'gemini-test',
      AI_TIMEOUT_MS: '10',
    }[name]) },
  }
  console.error = () => {}
  console.warn = () => {}
  globalThis.fetch = async (_url, init) => {
    intentos++
    if (intentos === 1) {
      return Response.json({ error: { code: 'UNAVAILABLE', message: 'temporary' } }, { status: 503 })
    }
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      })
    })
  }
  try {
    const resultado = await sugerirMapeo(['SKU'], [{ celdas: ['masked'] }])
    assert.equal(resultado.motivo, 'IA_TIMEOUT')
    assert.equal(intentos, 2)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    console.warn = originalWarn
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})
