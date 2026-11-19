// Pruebas de texto y números: lo que más se rompe con planillas reales.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizarEncabezado, normalizarTexto, parsearNumero } from './texto.ts'

test('normalizarTexto limpia espacios invisibles y vacíos', () => {
  assert.equal(normalizarTexto('  Hola   mundo \u00a0 '), 'Hola mundo')
  assert.equal(normalizarTexto('\u200b'), null)
  assert.equal(normalizarTexto(''), null)
  assert.equal(normalizarTexto(null), null)
  assert.equal(normalizarTexto(15), '15')
})

test('normalizarEncabezado ignora acentos, mayúsculas y signos', () => {
  assert.equal(normalizarEncabezado('Código'), 'codigo')
  assert.equal(normalizarEncabezado('  Stock Mínimo '), 'stock minimo')
  assert.equal(normalizarEncabezado('Precio de Venta'), 'precio de venta')
  assert.equal(normalizarEncabezado(''), '')
})

test('parsearNumero entiende números argentinos y con moneda', () => {
  assert.deepEqual(parsearNumero(25), { ok: true, valor: 25 })
  assert.deepEqual(parsearNumero('15.000'), { ok: true, valor: 15000 })
  assert.deepEqual(parsearNumero('1.500,50'), { ok: true, valor: 1500.5 })
  assert.deepEqual(parsearNumero('$ 1.500,50'), { ok: true, valor: 1500.5 })
  assert.deepEqual(parsearNumero('1,234.56'), { ok: true, valor: 1234.56 })
  assert.deepEqual(parsearNumero('ARS 300'), { ok: true, valor: 300 })
  assert.deepEqual(parsearNumero('-5'), { ok: true, valor: -5 })
})

test('parsearNumero distingue vacío de texto inválido', () => {
  assert.deepEqual(parsearNumero(''), { ok: false, motivo: 'vacio' })
  assert.deepEqual(parsearNumero(null), { ok: false, motivo: 'vacio' })
  assert.deepEqual(parsearNumero('abc'), { ok: false, motivo: 'no_es_numero' })
  assert.deepEqual(parsearNumero('12a'), { ok: false, motivo: 'no_es_numero' })
  assert.deepEqual(parsearNumero(true), { ok: false, motivo: 'no_es_numero' })
})
