// Pruebas del enmascarado de datos que se envían a la IA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enmascarar, muestrasParaIA, sugerirMapeo, validarConfiguracionProveedor } from './ia.ts'

test('la IA requiere proveedor y modelo configurados explícitamente', () => {
  assert.equal(validarConfiguracionProveedor('clave', null, 'modelo'), null)
  assert.equal(validarConfiguracionProveedor('clave', 'https://api.example.com/v1', null), null)
  assert.equal(
    validarConfiguracionProveedor('clave', 'http://api.example.com/v1', 'modelo'),
    null,
  )

  const configuracion = validarConfiguracionProveedor(
    ' clave ',
    'https://api.example.com/v1/',
    ' modelo-confirmado ',
  )
  assert.equal(configuracion?.apiKey, 'clave')
  assert.equal(configuracion?.url.href, 'https://api.example.com/v1/chat/completions')
  assert.equal(configuracion?.modelo, 'modelo-confirmado')
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
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secreto-no-loguear',
      AI_BASE_URL: 'https://api.example.com/v1',
      AI_MODEL: 'gemini-test',
    }[name]) },
  }
  globalThis.fetch = async () => new Response('', { status: 429 })
  try {
    const resultado = await sugerirMapeo(['sku', 'desc'], [{ celdas: ['private', 'private'] }])
    assert.equal(resultado.usada, false)
    assert.equal(resultado.motivo, 'IA_SIN_CUOTA')
    assert.equal(JSON.stringify(resultado).includes('secreto-no-loguear'), false)
  } finally {
    globalThis.fetch = originalFetch
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})

test('timeout del proveedor se devuelve como TIMEOUT y no filtra credenciales', async () => {
  const originalDeno = (globalThis as any).Deno
  const originalFetch = globalThis.fetch
  ;(globalThis as any).Deno = {
    env: { get: (name: string) => ({
      AI_API_KEY: 'secreto-no-loguear',
      AI_BASE_URL: 'https://api.example.com/v1',
      AI_MODEL: 'gemini-test',
    }[name]) },
  }
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
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
  }
})
