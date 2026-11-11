import './helpers/entorno.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { leerExcel } from '../src/modules/productos/importacion/excel.lector.js';
import { ENCABEZADOS, crearLibro, crearLibroConHojas } from './helpers/excel.js';

const FILAS_OK = [
  ENCABEZADOS,
  ['P001', 'Teclado Logitech', 'Perifericos', 25, 15000],
  ['P002', 'Mouse Genius', 'Perifericos', 40, 8500],
];

test('lee la hoja principal y respeta el número de fila de Excel', () => {
  const buffer = crearLibro(FILAS_OK);
  const lectura = leerExcel(buffer);

  assert.equal(lectura.hoja, 'Hoja1');
  assert.equal(lectura.filaEncabezado, 1);
  assert.equal(lectura.filas.length, 2);

  assert.deepEqual(lectura.filas[0], {
    numeroFila: 2,
    valores: {
      codigo: 'P001',
      nombre: 'Teclado Logitech',
      categoria: 'Perifericos',
      stock: 25,
      precio: 15000,
    },
  });

  assert.equal(lectura.filas[1].numeroFila, 3);
  assert.equal(lectura.filasVacias, 0);
});

test('ignora filas vacías y las cuenta aparte', () => {
  const buffer = crearLibro([
    ENCABEZADOS,
    ['P001', 'Teclado', 'Perifericos', 1, 100],
    [null, null, null, null, null],
    ['   ', '', ' ', null, ''],
    ['P002', 'Mouse', 'Perifericos', 2, 200],
  ]);

  const lectura = leerExcel(buffer);

  assert.equal(lectura.filas.length, 2);
  assert.equal(lectura.filasVacias, 2);
  assert.equal(lectura.filas[1].numeroFila, 5);
});

test('encuentra el encabezado aunque haya filas de título arriba', () => {
  const buffer = crearLibro([
    ['StockFX - Importación de productos'],
    ['Generado el 11/11/2026'],
    [],
    ['Código', 'Descripción', 'Categoría', 'Stock', 'Precio'],
    ['P001', 'Teclado', 'Perifericos', 1, 100],
  ]);

  const lectura = leerExcel(buffer);

  assert.equal(lectura.filaEncabezado, 4);
  assert.equal(lectura.filas[0].numeroFila, 5);
  assert.equal(lectura.filas[0].valores.codigo, 'P001');
});

test('acepta encabezados alternativos (alias)', () => {
  const buffer = crearLibro([
    ['SKU', 'Producto', 'Rubro', 'Cantidad', 'Precio Venta'],
    ['P001', 'Teclado', 'Perifericos', 3, 100],
  ]);

  const lectura = leerExcel(buffer);

  assert.deepEqual(lectura.filas[0].valores, {
    codigo: 'P001',
    nombre: 'Teclado',
    categoria: 'Perifericos',
    stock: 3,
    precio: 100,
  });
});

test('toma la columna "Detalle" como descripción larga, no como nombre', () => {
  const buffer = crearLibro([
    ['Codigo', 'Descripcion', 'Detalle', 'Stock', 'Precio'],
    ['P001', 'Teclado', 'Teclado mecánico RGB', 1, 100],
  ]);

  const lectura = leerExcel(buffer);

  assert.equal(lectura.filas[0].valores.nombre, 'Teclado');
  assert.equal(lectura.filas[0].valores.descripcion, 'Teclado mecánico RGB');
});

test('informa las columnas que no conoce', () => {
  const buffer = crearLibro([
    ['Codigo', 'Descripcion', 'Stock', 'Precio', 'Proveedor'],
    ['P001', 'Teclado', 1, 100, 'Logitech'],
  ]);

  const lectura = leerExcel(buffer);

  assert.deepEqual(lectura.columnasIgnoradas, ['Proveedor']);
});

test('falla con un mensaje claro si faltan columnas obligatorias', () => {
  const buffer = crearLibro([
    ['Codigo', 'Descripcion', 'Categoria'],
    ['P001', 'Teclado', 'Perifericos'],
  ]);

  assert.throws(
    () => leerExcel(buffer),
    (error) => {
      assert.equal(error.codigo, 'COLUMNAS_FALTANTES');
      assert.match(error.message, /Stock/);
      assert.match(error.message, /Precio/);
      assert.deepEqual(
        error.detalles.faltantes.map(({ campo }) => campo),
        ['stock', 'precio'],
      );
      return true;
    },
  );
});

test('falla si no encuentra la fila de encabezados', () => {
  const buffer = crearLibro([
    ['hola'],
    ['esto no es una planilla'],
    [1, 2, 3],
  ]);

  assert.throws(
    () => leerExcel(buffer),
    (error) => error.codigo === 'ENCABEZADO_NO_ENCONTRADO',
  );
});

test('respeta el máximo de filas configurado', () => {
  const filas = [ENCABEZADOS];
  for (let i = 1; i <= 5; i += 1) {
    filas.push([`P00${i}`, `Producto ${i}`, 'Perifericos', i, 100 * i]);
  }

  assert.throws(
    () => leerExcel(crearLibro(filas), { maxFilas: 2 }),
    (error) => {
      assert.equal(error.codigo, 'DEMASIADAS_FILAS');
      assert.equal(error.detalles.maxFilas, 2);
      return true;
    },
  );
});

test('detecta una planilla enorme aunque se corte la lectura', () => {
  const filas = [ENCABEZADOS];
  for (let i = 1; i <= 40; i += 1) {
    filas.push([`P${i}`, `Producto ${i}`, 'Perifericos', i, 100]);
  }

  assert.throws(
    () => leerExcel(crearLibro(filas), { maxFilas: 2 }),
    (error) => error.codigo === 'DEMASIADAS_FILAS',
  );
});

test('selecciona la hoja pedida y avisa si no existe', () => {
  const buffer = crearLibroConHojas({
    Resumen: [['nada']],
    Productos: FILAS_OK,
  });

  const lectura = leerExcel(buffer, { nombreHoja: 'productos' });
  assert.equal(lectura.hoja, 'Productos');
  assert.equal(lectura.filas.length, 2);

  assert.throws(
    () => leerExcel(buffer, { nombreHoja: 'NoExiste' }),
    (error) => {
      assert.equal(error.codigo, 'HOJA_INEXISTENTE');
      assert.deepEqual(error.detalles.hojasDisponibles, ['Resumen', 'Productos']);
      return true;
    },
  );
});

test('lee archivos .xls viejos', () => {
  const buffer = crearLibro(FILAS_OK, { tipo: 'xls' });
  const lectura = leerExcel(buffer);

  assert.equal(lectura.filas.length, 2);
  assert.equal(lectura.filas[0].valores.codigo, 'P001');
});

test('rechaza un archivo vacío o que no es Excel', () => {
  assert.throws(
    () => leerExcel(Buffer.alloc(0)),
    (error) => error.codigo === 'ARCHIVO_VACIO',
  );

  assert.throws(
    () => leerExcel(Buffer.from('esto no es un excel')),
    (error) => error.codigo === 'ARCHIVO_ILEGIBLE',
  );
});

test('rechaza una planilla sin filas de datos', () => {
  assert.throws(
    () => leerExcel(crearLibro([ENCABEZADOS])),
    (error) => error.codigo === 'SIN_FILAS',
  );
});
