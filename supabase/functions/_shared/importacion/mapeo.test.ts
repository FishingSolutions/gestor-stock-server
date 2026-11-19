// Pruebas del mapeo de columnas, incluida la validación del JSON de la IA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  columnasSinMapear,
  combinarMapeo,
  faltanCamposClave,
  mapearPorAlias,
} from './mapeo.ts'

test('mapearPorAlias reconoce los encabezados habituales', () => {
  const mapeo = mapearPorAlias(['SKU', 'Producto', 'Rubro', 'Cantidad', 'PVP'])

  assert.equal(mapeo.codigo, 0)
  assert.equal(mapeo.nombre, 1)
  assert.equal(mapeo.categoria, 2)
  assert.equal(mapeo.stock, 3)
  assert.equal(mapeo.precio, 4)
})

test('"Descripcion" se usa como nombre y "Detalle" como descripción larga', () => {
  const mapeo = mapearPorAlias(['Codigo', 'Descripcion', 'Detalle'])

  assert.equal(mapeo.codigo, 0)
  assert.equal(mapeo.nombre, 1)
  assert.equal(mapeo.descripcion, 2)
})

test('una columna repetida no se asigna dos veces', () => {
  const mapeo = mapearPorAlias(['Codigo', 'Nombre'])

  assert.equal(mapeo.codigo, 0)
  assert.equal(mapeo.nombre, 1)
  assert.equal(Object.keys(mapeo).length, 2)
})

test('columnasSinMapear informa las que se ignoran', () => {
  const mapeo = mapearPorAlias(['Codigo', 'Nombre', 'Proveedor'])
  assert.deepEqual(columnasSinMapear(['Codigo', 'Nombre', 'Proveedor'], mapeo), ['Proveedor'])
})

test('faltanCamposClave detecta lo obligatorio', () => {
  assert.equal(faltanCamposClave({ codigo: 0, nombre: 1 }), false)
  assert.equal(faltanCamposClave({ codigo: 0 }), true)
  assert.equal(faltanCamposClave({}), true)
})

test('la IA completa lo que el alias no encontró', () => {
  const base = mapearPorAlias(['Art', 'Precio lista'])
  const { mapeo, rechazadas } = combinarMapeo(base, { columnas: { codigo: 0, precio: 1 } }, 2)

  assert.equal(mapeo.codigo, 0)
  assert.equal(mapeo.precio, 1)
  assert.deepEqual(rechazadas, [])
})

test('el alias determinista gana sobre la IA', () => {
  const base = mapearPorAlias(['Codigo', 'Nombre'])
  const { mapeo } = combinarMapeo(base, { columnas: { codigo: 1 } }, 2)

  assert.equal(mapeo.codigo, 0)
})

test('se descarta lo que la IA devuelve mal', () => {
  const { mapeo, rechazadas } = combinarMapeo(
    {},
    {
      columnas: {
        codigo: 0,
        nombre: 9, // fuera de rango
        inventado: 1, // campo que no existe
        precio: 0, // columna ya usada
      },
    },
    2,
  )

  assert.equal(mapeo.codigo, 0)
  assert.equal(mapeo.nombre, undefined)
  assert.equal(mapeo.precio, undefined)
  assert.equal(rechazadas.length, 3)
})

test('una respuesta sin "columnas" no rompe nada', () => {
  const { mapeo, rechazadas } = combinarMapeo({ codigo: 0 }, { otra: 'cosa' }, 3)

  assert.equal(mapeo.codigo, 0)
  assert.equal(rechazadas.length, 1)
})
