import './helpers/entorno.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claveCategoria,
  claveCodigo,
  normalizarEncabezado,
  normalizarTexto,
  paraMensaje,
  quitarAcentos,
} from '../src/modules/productos/importacion/textos.js';

test('normalizarTexto limpia espacios, invisibles y nulos', () => {
  assert.equal(normalizarTexto('  Teclado   Logitech '), 'Teclado Logitech');
  assert.equal(normalizarTexto('Mouse\u00a0Genius'), 'Mouse Genius');
  assert.equal(normalizarTexto('\u200bP001\ufeff'), 'P001');
  assert.equal(normalizarTexto('   '), null);
  assert.equal(normalizarTexto(null), null);
  assert.equal(normalizarTexto(undefined), null);
  assert.equal(normalizarTexto(1001), '1001');
});

test('normalizarEncabezado ignora acentos, mayúsculas y signos', () => {
  assert.equal(normalizarEncabezado('  Código '), 'codigo');
  assert.equal(normalizarEncabezado('Precio_Venta'), 'precio venta');
  assert.equal(normalizarEncabezado('Categoría'), 'categoria');
  assert.equal(normalizarEncabezado('Descripción *'), 'descripcion');
  assert.equal(normalizarEncabezado(null), '');
});

test('claveCodigo puede ignorar mayúsculas', () => {
  assert.equal(claveCodigo(' P001 '), 'p001');
  assert.equal(claveCodigo(' P001 ', { sinMayusculas: false }), 'P001');
  assert.equal(claveCodigo(null), '');
});

test('claveCategoria es la misma regla que el SQL (lower + trim)', () => {
  assert.equal(claveCategoria(' Periféricos '), 'periféricos');
});

test('quitarAcentos y paraMensaje', () => {
  assert.equal(quitarAcentos('Categoría'), 'Categoria');
  assert.equal(paraMensaje('abc'), 'abc');
  assert.equal(paraMensaje(null), '(vacío)');
  assert.equal(paraMensaje('x'.repeat(200), 10), `${'x'.repeat(10)}…`);
});
