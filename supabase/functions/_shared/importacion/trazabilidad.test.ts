import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firmarTrazabilidad, verificarTrazabilidad } from './trazabilidad.ts'

const secreto = 's'.repeat(40)
const contexto = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sub: '11111111-1111-1111-1111-111111111111',
  hash: 'a'.repeat(64),
  hoja: 'Productos',
  mapeo: { codigo: 0, nombre: 1 },
  exp: 2_000_000_000_000,
  usada: true,
  modelo: 'modelo-prueba',
  ms: 123,
}

test('token se valida solo para usuario, archivo, hoja y mapeo firmados', async () => {
  const token = await firmarTrazabilidad(secreto, contexto)
  assert.deepEqual(
    await verificarTrazabilidad(secreto, token, {
      sub: contexto.sub,
      hash: contexto.hash,
      hoja: contexto.hoja,
      mapeo: contexto.mapeo,
    }, 1_900_000_000_000),
    contexto,
  )
  assert.equal(await verificarTrazabilidad(secreto, token, {
    sub: '22222222-2222-2222-2222-222222222222',
    hash: contexto.hash,
    hoja: contexto.hoja,
    mapeo: contexto.mapeo,
  }), null)
  assert.equal(await verificarTrazabilidad(secreto, token, {
    sub: contexto.sub, hash: contexto.hash, hoja: 'Otra hoja', mapeo: contexto.mapeo,
  }), null)
  assert.equal(await verificarTrazabilidad(secreto, token, {
    sub: contexto.sub, hash: contexto.hash, hoja: contexto.hoja, mapeo: { codigo: 1, nombre: 0 },
  }), null)
})

test('token expirado en el instante exp <= ahora es rechazado', async () => {
  const token = await firmarTrazabilidad(secreto, { ...contexto, exp: 1000 })
  assert.equal(await verificarTrazabilidad(secreto, token, contexto, 1000), null)
})

test('token alterado y secreto débil son rechazados', async () => {
  const token = await firmarTrazabilidad(secreto, contexto)
  const [cuerpo, firma] = token.split('.')
  assert.equal(
    await verificarTrazabilidad(secreto, `${cuerpo.slice(0, -1)}A.${firma}`, contexto),
    null,
  )
  await assert.rejects(() => firmarTrazabilidad('corto', contexto))
})
