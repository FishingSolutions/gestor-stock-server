import './helpers/entorno.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizarSeparadores,
  parsearNumero,
  redondear2,
} from '../src/modules/productos/importacion/numeros.js';

test('parsearNumero acepta números y los formatos de planilla habituales', () => {
  const casos = [
    [25, 25],
    [0, 0],
    [-3, -3],
    [15000.5, 15000.5],
    ['25', 25],
    [' 8.500 ', 8500],
    ['15.000', 15000],
    ['1.500,50', 1500.5],
    ['15,000.50', 15000.5],
    ['$ 15.000,00', 15000],
    ['15000 ARS', 15000],
    ['1,5', 1.5],
    ['0,75', 0.75],
    ['1.500.000', 1500000],
  ];

  for (const [entrada, esperado] of casos) {
    const resultado = parsearNumero(entrada);
    assert.equal(resultado.ok, true, `debería aceptar ${JSON.stringify(entrada)}`);
    assert.equal(resultado.valor, esperado, `valor de ${JSON.stringify(entrada)}`);
  }
});

test('parsearNumero marca "vacío" cuando no hay valor', () => {
  for (const entrada of [null, undefined, '', '   ', '\u00a0']) {
    assert.deepEqual(parsearNumero(entrada), { ok: false, motivo: 'vacío' });
  }
});

test('parsearNumero rechaza textos y valores que no son números', () => {
  for (const entrada of ['abc', '12abc', '1e3', '12,3,4x', true, false, new Date(), NaN, Infinity, '-']) {
    const resultado = parsearNumero(entrada);
    assert.equal(resultado.ok, false, `debería rechazar ${String(entrada)}`);
    assert.equal(resultado.motivo, 'no es un número');
  }
});

test('normalizarSeparadores distingue miles de decimales', () => {
  assert.equal(normalizarSeparadores('1.500'), '1500');
  assert.equal(normalizarSeparadores('1,500'), '1500');
  assert.equal(normalizarSeparadores('1.500,50'), '1500.50');
  assert.equal(normalizarSeparadores('1,500.50'), '1500.50');
  assert.equal(normalizarSeparadores('1.5'), '1.5');
  assert.equal(normalizarSeparadores('15'), '15');
});

test('redondear2 no arrastra errores de coma flotante', () => {
  assert.equal(redondear2(1234.565), 1234.57);
  assert.equal(redondear2(0.1 + 0.2), 0.3);
  assert.equal(redondear2(15000), 15000);
});
