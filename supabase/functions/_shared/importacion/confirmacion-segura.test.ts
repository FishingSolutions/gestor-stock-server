import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analisisPuedeReutilizarse,
  claveIdempotenciaValida,
  ErrorDecision,
  validarDecisiones,
} from './confirmacion-segura.ts'

const filas = [{ fila: 2 }, { fila: 3 }]

test('rechaza decisiones manipuladas, filas ajenas y propiedades inesperadas', () => {
  const invalidas = [
    null,
    [],
    { 1: { accion: 'EXCLUIR' } },
    { 2: { accion: 'ADMIN' } },
    { 2: { accion: 'VINCULAR', idProducto: -1 } },
    { 2: { accion: 'VINCULAR', idProducto: 1.5 } },
    { 2: { accion: 'CREAR', idProducto: 4 } },
    { 2: { accion: 'EXCLUIR', permitido: true } },
  ]
  for (const entrada of invalidas) {
    assert.throws(
      () => validarDecisiones(entrada, filas as any),
      (error) => error instanceof ErrorDecision,
    )
  }
})

test('acepta solo decisiones válidas para filas presentes', () => {
  assert.deepEqual(validarDecisiones({
    2: { accion: 'VINCULAR', idProducto: 123 },
    3: { accion: 'EXCLUIR' },
  }, filas as any), {
    2: { accion: 'VINCULAR', idProducto: 123 },
    3: { accion: 'EXCLUIR' },
  })
})

test('valida formato UUID de la clave de idempotencia', () => {
  assert.equal(claveIdempotenciaValida('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true)
  assert.equal(claveIdempotenciaValida(''), false)
  assert.equal(claveIdempotenciaValida('not-a-uuid'), false)
  assert.equal(claveIdempotenciaValida(null), false)
})

test('rechaza reutilizar análisis vinculado, expirado o alterado', () => {
  const fila = {
    idempotency_key: null,
    hash_archivo: 'a'.repeat(64),
    hoja: 'Productos',
    mapeo: { codigo: 0, nombre: 1 },
    expira_en: new Date(2000).toISOString(),
    ia_usada: true,
    ia_modelo: 'gemini-test',
    ia_ms: 100,
  }
  const claims = {
    hash: fila.hash_archivo,
    hoja: fila.hoja,
    mapeo: { nombre: 1, codigo: 0 },
    usada: true,
    modelo: 'gemini-test',
    ms: 100,
  }
  assert.equal(analisisPuedeReutilizarse(fila, claims, 1000), true)
  assert.equal(analisisPuedeReutilizarse({ ...fila, idempotency_key: 'key' }, claims, 1000), false)
  assert.equal(analisisPuedeReutilizarse(fila, claims, 2000), false)
  assert.equal(analisisPuedeReutilizarse(fila, { ...claims, hoja: 'Otra' }, 1000), false)
})
