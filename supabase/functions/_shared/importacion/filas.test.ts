// Pruebas de interpretación y validación de filas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { construirFilas } from './filas.ts'
import { mapearPorAlias } from './mapeo.ts'
import type { LecturaArchivo, Mapeo } from './tipos.ts'

function lectura(filas: unknown[][]): LecturaArchivo {
  return {
    hoja: 'Productos',
    hojas: ['Productos'],
    filaEncabezado: 1,
    encabezados: ['Codigo', 'Nombre', 'Categoria', 'Stock', 'Precio', 'Costo'],
    filasVacias: 0,
    filas: filas.map((celdas, indice) => ({ numeroFila: indice + 2, celdas })),
  }
}

const MAPEO: Mapeo = {
  codigo: 0,
  nombre: 1,
  categoria: 2,
  stock: 3,
  precio: 4,
  costo: 5,
}

test('interpreta una fila completa', () => {
  const [fila] = construirFilas(lectura([['P001', 'Teclado', 'Perifericos', '15.000', '$ 1.500,50', '900']]), MAPEO)

  assert.equal(fila.errores.length, 0)
  assert.equal(fila.codigo, 'P001')
  assert.equal(fila.stock, 15000)
  assert.equal(fila.precio, 1500.5)
  assert.equal(fila.costo, 900)
})

test('interpreta los campos de una planilla con nombre y descripcion separados', () => {
  const encabezados = [
    'codigo',
    'nombre',
    'descripcion',
    'precio',
    'stock_actual',
    'stock_minimo',
    'stock_maximo',
    'categoria',
  ]
  const lecturaConEncabezados: LecturaArchivo = {
    ...lectura([['SKU-42', 'Café', 'Grano tostado', 1250.5, 18, 2, 40, 'Bebidas']]),
    encabezados,
  }
  const [fila] = construirFilas(lecturaConEncabezados, mapearPorAlias(encabezados))

  assert.equal(fila.codigo, 'SKU-42')
  assert.equal(fila.nombre, 'Café')
  assert.equal(fila.descripcion, 'Grano tostado')
  assert.equal(fila.precio, 1250.5)
  assert.equal(fila.stock, 18)
  assert.equal(fila.stockMinimo, 2)
  assert.equal(fila.stockMaximo, 40)
  assert.equal(fila.categoria, 'Bebidas')
  assert.deepEqual(fila.errores, [])
})

test('el stock faltante queda en null (no se inventa)', () => {
  const [fila] = construirFilas(lectura([['P001', 'Teclado', '', '', 1500, '']]), MAPEO)

  assert.equal(fila.errores.length, 0)
  assert.equal(fila.stock, null)
  assert.equal(fila.precio, 1500)
})

test('stock con decimales o negativo es error', () => {
  const [decimales] = construirFilas(lectura([['P001', 'Teclado', '', '2,5', 10, '']]), MAPEO)
  const [negativo] = construirFilas(lectura([['P002', 'Mouse', '', -3, 10, '']]), MAPEO)

  assert.match(decimales.errores[0], /entero/)
  assert.match(negativo.errores[0], /negativo/)
})

test('una fórmula como código se rechaza', () => {
  const [fila] = construirFilas(lectura([['=HYPERLINK("x")', 'Teclado', '', 1, 10, '']]), MAPEO)

  assert.ok(fila.errores.some((error) => /fórmula/.test(error)))
})

test('códigos repetidos en el archivo se marcan en la segunda fila', () => {
  const filas = construirFilas(
    lectura([
      ['P001', 'Teclado', '', 1, 10, ''],
      ['p001', 'Teclado 2', '', 2, 20, ''],
    ]),
    MAPEO,
  )

  assert.equal(filas[0].errores.length, 0)
  assert.ok(filas[1].errores.some((error) => /repetido/.test(error)))
})

test('un precio que no es número es error', () => {
  const [fila] = construirFilas(lectura([['P001', 'Teclado', '', 1, 'diez', '']]), MAPEO)

  assert.ok(fila.errores.some((error) => /precio/.test(error)))
})

test('el estado SI/NO se interpreta', () => {
  const mapeo: Mapeo = { ...MAPEO, activo: 6 }
  const filas = construirFilas(
    lectura([
      ['P001', 'Teclado', '', 1, 10, '', 'SI'],
      ['P002', 'Mouse', '', 1, 10, '', 'no'],
      ['P003', 'Pad', '', 1, 10, '', 'tal vez'],
    ]),
    mapeo,
  )

  assert.equal(filas[0].activo, true)
  assert.equal(filas[1].activo, false)
  assert.equal(filas[2].activo, null)
  assert.ok(filas[2].errores.some((error) => /estado/.test(error)))
})
