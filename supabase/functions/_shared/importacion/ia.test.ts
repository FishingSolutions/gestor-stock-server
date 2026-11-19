// Pruebas del enmascarado de datos que se envían a la IA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enmascarar, muestrasParaIA } from './ia.ts'

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

test('los textos cortos se mantienen y los largos se recortan', () => {
  assert.equal(enmascarar('Teclado Logitech'), 'Teclado Logitech')
  const largo = enmascarar('x'.repeat(200))
  assert.ok(largo.length <= 41)
  assert.ok(largo.endsWith('…'))
})

test('las muestras solo incluyen hasta 10 filas y sin números', () => {
  const filas = Array.from({ length: 30 }, (_, i) => ({ celdas: [`P${i}`, 1000 + i, 'Teclado'] }))
  const muestras = muestrasParaIA(filas, ['Codigo', 'Precio', 'Nombre'])

  assert.equal(muestras.length, 10)
  assert.deepEqual(muestras[0], ['P0', '<numero>', 'Teclado'])
})
