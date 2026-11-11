import './helpers/entorno.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ValidadorImportacionProductos } from '../src/modules/productos/importacion/validador.js';

const validador = new ValidadorImportacionProductos();

const fila = (numeroFila, valores) => ({ numeroFila, valores });

const VALORES_OK = {
  codigo: 'P001',
  nombre: 'Teclado Logitech',
  categoria: 'Perifericos',
  stock: 25,
  precio: 15000,
};

/** Valida una sola fila y devuelve el resultado. */
function validarUna(valores, numeroFila = 2, codigosVistos = new Map()) {
  return validador.validarFila(fila(numeroFila, valores), codigosVistos);
}

function mensajes(resultado) {
  return resultado.errores.map((error) => error.mensaje).join(' | ');
}

test('una fila correcta devuelve los datos normalizados', () => {
  const resultado = validarUna({ ...VALORES_OK, codigo: '  p001 ', nombre: '  Teclado   Logitech ' });

  assert.equal(resultado.errores.length, 0);
  assert.deepEqual(resultado.datos, {
    codigo: 'p001',
    nombre: 'Teclado Logitech',
    descripcion: null,
    categoria: 'Perifericos',
    stock: 25,
    precio: 15000,
    costo: 0,
  });
});

test('el stock 0 es válido', () => {
  const resultado = validarUna({ ...VALORES_OK, stock: 0 });
  assert.equal(resultado.errores.length, 0);
  assert.equal(resultado.datos.stock, 0);
});

test('el código es obligatorio', () => {
  const resultado = validarUna({ ...VALORES_OK, codigo: '   ' });
  assert.match(mensajes(resultado), /El código es obligatorio/);
  assert.equal(resultado.datos, null);
});

test('el código no puede superar los 50 caracteres', () => {
  const resultado = validarUna({ ...VALORES_OK, codigo: 'X'.repeat(51) });
  assert.match(mensajes(resultado), /no puede superar los 50 caracteres/);
});

test('la descripción es obligatoria y tiene máximo', () => {
  assert.match(mensajes(validarUna({ ...VALORES_OK, nombre: null })), /La descripción es obligatoria/);
  assert.match(
    mensajes(validarUna({ ...VALORES_OK, nombre: 'X'.repeat(151) })),
    /no puede superar los 150 caracteres/,
  );
});

test('el stock tiene que ser entero y no negativo', () => {
  assert.match(mensajes(validarUna({ ...VALORES_OK, stock: null })), /El stock es obligatorio/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, stock: 'mucho' })), /número entero/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, stock: 2.5 })), /sin decimales/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, stock: -1 })), /no puede ser negativo/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, stock: 2_147_483_648 })), /no puede superar/);
});

test('el precio tiene que ser un número mayor que cero', () => {
  assert.match(mensajes(validarUna({ ...VALORES_OK, precio: null })), /El precio es obligatorio/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, precio: 'gratis' })), /tiene que ser un número/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, precio: 0 })), /mayor que cero/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, precio: -100 })), /mayor que cero/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, precio: 10_000_000_000 })), /no puede superar/);
});

test('el precio se redondea a dos decimales', () => {
  const resultado = validarUna({ ...VALORES_OK, precio: 1500.555 });
  assert.equal(resultado.datos.precio, 1500.56);
});

test('el costo es opcional y no puede ser negativo', () => {
  assert.equal(validarUna({ ...VALORES_OK }).datos.costo, 0);
  assert.equal(validarUna({ ...VALORES_OK, costo: '1.200,50' }).datos.costo, 1200.5);
  assert.match(mensajes(validarUna({ ...VALORES_OK, costo: -5 })), /El costo no puede ser negativo/);
  assert.match(mensajes(validarUna({ ...VALORES_OK, costo: 'abc' })), /El costo tiene que ser un número/);
});

test('la categoría es opcional', () => {
  const resultado = validarUna({ ...VALORES_OK, categoria: '   ' });
  assert.equal(resultado.errores.length, 0);
  assert.equal(resultado.datos.categoria, null);
});

test('junta todos los errores de una fila, no solo el primero', () => {
  const resultado = validarUna({
    codigo: null,
    nombre: null,
    stock: -2,
    precio: 0,
  });

  assert.equal(resultado.errores.length, 4);
  assert.deepEqual(
    resultado.errores.map(({ campo }) => campo),
    ['codigo', 'nombre', 'stock', 'precio'],
  );
  assert.ok(resultado.errores.every(({ fila }) => fila === 2));
});

test('detecta códigos repetidos dentro del mismo archivo (sin distinguir mayúsculas)', () => {
  const { validas, errores, registrosProcesados } = validador.validar([
    fila(2, { ...VALORES_OK, codigo: 'P001' }),
    fila(3, { ...VALORES_OK, codigo: 'p001' }),
    fila(4, { ...VALORES_OK, codigo: 'P002' }),
  ]);

  assert.equal(registrosProcesados, 3);
  assert.equal(validas.length, 2);
  assert.equal(errores.length, 1);
  assert.match(errores[0].mensaje, /"p001" está repetido en el archivo \(ya aparece en la fila 2\)/);
  assert.equal(errores[0].fila, 3);
});

test('una fila con errores no se devuelve como válida', () => {
  const { validas, errores } = validador.validar([
    fila(2, VALORES_OK),
    fila(3, { ...VALORES_OK, codigo: 'P002', precio: 0 }),
  ]);

  assert.equal(validas.length, 1);
  assert.equal(validas[0].fila, 2);
  assert.equal(errores.length, 1);
  assert.equal(errores[0].codigo, 'P002');
});
