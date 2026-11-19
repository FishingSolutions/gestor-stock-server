// Pruebas de coincidencias y clasificación de filas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clasificarFilas, normalizarNombre, similitud } from './coincidencias.ts'
import type { FilaImportada, ProductoExistente } from './tipos.ts'

function producto(parcial: Partial<ProductoExistente>): ProductoExistente {
  return {
    idProducto: 1,
    codigo: 'P001',
    nombre: 'Teclado Logitech',
    descripcion: null,
    categoria: 'Perifericos',
    idCategoria: 'cat-1',
    stock: 10,
    precio: 1500,
    costo: 1000,
    stockMinimo: 0,
    stockMaximo: 0,
    activo: true,
    ...parcial,
  }
}

function fila(parcial: Partial<FilaImportada>): FilaImportada {
  return {
    fila: 2,
    codigo: 'P001',
    nombre: 'Teclado Logitech',
    descripcion: null,
    categoria: null,
    stock: null,
    precio: null,
    costo: null,
    stockMinimo: null,
    stockMaximo: null,
    activo: null,
    errores: [],
    ...parcial,
  }
}

test('normalizarNombre quita acentos y signos', () => {
  assert.equal(normalizarNombre('Teclado  Logitech®'), 'teclado logitech')
})

test('similitud distingue nombres parecidos de distintos', () => {
  assert.equal(similitud('Teclado Logitech', 'teclado logitech'), 1)
  assert.ok(similitud('Teclado Logitech K120', 'Teclado Logitech') > 0.9)
  assert.ok(similitud('Teclado Logitech', 'Mouse Genius') < 0.5)
})

test('mismo código y mismos datos: sin cambios', () => {
  const [resultado] = clasificarFilas([fila({})], [producto({})], null)

  assert.equal(resultado.estado, 'sin_cambios')
  assert.equal(resultado.accion, 'ACTUALIZAR')
  assert.equal(resultado.idProducto, 1)
})

test('mismo código con otro precio: existente', () => {
  const [resultado] = clasificarFilas([fila({ precio: 2000 })], [producto({})], null)

  assert.equal(resultado.estado, 'existente')
  assert.deepEqual(resultado.cambios.map((c) => c.campo), ['precio'])
})

test('el stock solo cambia si hay modo elegido', () => {
  const sinModo = clasificarFilas([fila({ stock: 99 })], [producto({})], null)[0]
  const sumando = clasificarFilas([fila({ stock: 5 })], [producto({})], 'SUMAR')[0]
  const reemplazando = clasificarFilas([fila({ stock: 99 })], [producto({})], 'REEMPLAZAR')[0]

  assert.equal(sinModo.estado, 'sin_cambios')
  assert.equal(sumando.estado, 'existente')
  assert.deepEqual(sumando.cambios.find((c) => c.campo === 'stock'), {
    campo: 'stock',
    antes: 10,
    despues: 15,
  })
  assert.deepEqual(reemplazando.cambios.find((c) => c.campo === 'stock'), {
    campo: 'stock',
    antes: 10,
    despues: 99,
  })
})

test('sumar 0 unidades no genera cambio de stock', () => {
  const [resultado] = clasificarFilas([fila({ stock: 0 })], [producto({})], 'SUMAR')

  assert.equal(resultado.estado, 'sin_cambios')
})

test('un producto nuevo sin precio es inválido', () => {
  const [resultado] = clasificarFilas([fila({ codigo: 'N001', nombre: 'Producto nuevo', precio: null })], [producto({})], null)

  assert.equal(resultado.estado, 'invalida')
  assert.ok(resultado.errores.some((error) => /precio/.test(error)))
})

test('un nombre muy parecido con código nuevo es ambiguo', () => {
  const [resultado] = clasificarFilas(
    [fila({ codigo: 'N001', nombre: 'Teclado Logitech K120', precio: 100 })],
    [producto({})],
    null,
  )

  assert.equal(resultado.estado, 'ambigua')
  assert.equal(resultado.accion, 'EXCLUIR')
  assert.equal(resultado.sugerencias[0].idProducto, 1)
})

test('un producto nuevo con precio entra como CREAR', () => {
  const [resultado] = clasificarFilas(
    [fila({ codigo: 'N001', nombre: 'Cable USB', precio: 500 })],
    [producto({})],
    null,
  )

  assert.equal(resultado.estado, 'nuevo')
  assert.equal(resultado.accion, 'CREAR')
})

test('no se puede cambiar el stock de un producto dado de baja', () => {
  const [resultado] = clasificarFilas(
    [fila({ stock: 50 })],
    [producto({ activo: false })],
    'REEMPLAZAR',
  )

  assert.equal(resultado.estado, 'invalida')
  assert.ok(resultado.errores.some((error) => /dado de baja/.test(error)))
})

test('la columna Activo genera un cambio real', () => {
  const [resultado] = clasificarFilas([fila({ activo: false })], [producto({})], null)

  assert.equal(resultado.estado, 'existente')
  assert.deepEqual(resultado.cambios, [{ campo: 'activo', antes: true, despues: false }])
})

test('reactivar en la misma fila permite cargar stock', () => {
  const [resultado] = clasificarFilas(
    [fila({ stock: 50, activo: true })],
    [producto({ activo: false })],
    'REEMPLAZAR',
  )

  assert.equal(resultado.estado, 'existente')
  assert.equal(resultado.errores.length, 0)
})
