import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import { ALIAS_CONOCIDOS } from './mapeo.ts'
import { ErrorArchivo, leerLibroConParser } from './excel-reader.ts'
import { LIMITES_ZIP_XLSX } from './zip-seguro.ts'

function crearXlsx(repeticion = false): Uint8Array {
  const libro = XLSX.utils.book_new()
  const datos = repeticion
    ? [
        ['Código', 'Nombre', 'Precio'],
        ...Array.from({ length: 350 }, (_, indice) => [
          `SKU-${indice}`,
          'Artículo repetitivo '.repeat(25),
          123.45,
        ]),
      ]
    : [
        ['Código', 'Nombre', 'Precio'],
        ['A-1', 'Producto uno', 10],
      ]

  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(datos), 'Productos')
  XLSX.utils.book_append_sheet(
    libro,
    XLSX.utils.aoa_to_sheet([['Código', 'Nombre'], ['B-2', 'Producto dos']]),
    'Segunda',
  )
  return new Uint8Array(XLSX.write(libro, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }))
}

function crearZipConEntradasVacias(cantidad: number): Uint8Array {
  const nombre = new TextEncoder().encode('entry')
  const localLargo = 30 + nombre.length
  const centralLargo = 46 + nombre.length
  const offsetCentral = localLargo * cantidad
  const largoCentral = centralLargo * cantidad
  const bytes = new Uint8Array(offsetCentral + largoCentral + 22)
  const vista = new DataView(bytes.buffer)

  for (let indice = 0; indice < cantidad; indice++) {
    const nombreIndice = new TextEncoder().encode(`e${String(indice).padStart(4, '0')}`)
    const local = indice * localLargo
    vista.setUint32(local, 0x04034b50, true)
    vista.setUint16(local + 4, 20, true)
    vista.setUint16(local + 26, nombreIndice.length, true)
    bytes.set(nombreIndice, local + 30)

    const central = offsetCentral + indice * centralLargo
    vista.setUint32(central, 0x02014b50, true)
    vista.setUint16(central + 4, 20, true)
    vista.setUint16(central + 6, 20, true)
    vista.setUint16(central + 28, nombreIndice.length, true)
    vista.setUint32(central + 42, local, true)
    bytes.set(nombreIndice, central + 46)
  }

  const eocd = offsetCentral + largoCentral
  vista.setUint32(eocd, 0x06054b50, true)
  vista.setUint16(eocd + 8, cantidad, true)
  vista.setUint16(eocd + 10, cantidad, true)
  vista.setUint32(eocd + 12, largoCentral, true)
  vista.setUint32(eocd + 16, offsetCentral, true)
  return bytes
}

function encontrarCentral(bytes: Uint8Array): { central: number; local: number } {
  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let indice = 0; indice <= bytes.length - 46; indice++) {
    if (vista.getUint32(indice, true) === 0x02014b50) {
      return { central: indice, local: vista.getUint32(indice + 42, true) }
    }
  }
  throw new Error('Fixture sin directorio central ZIP')
}

async function leer(bytes: Uint8Array, limitesZip = LIMITES_ZIP_XLSX) {
  return leerLibroConParser(bytes, null, ALIAS_CONOCIDOS, XLSX, limitesZip)
}

test('lee un XLSX real de varias hojas a través del parser usado por producción', async () => {
  const lectura = await leer(crearXlsx())
  assert.equal(lectura.hojas.length, 2)
  assert.equal(lectura.hoja, 'Productos')
  assert.equal(lectura.filas[0].celdas[0], 'A-1')
})

test('conserva la lectura de las planillas de ejemplo ya existentes', async () => {
  for (const archivo of [
    '../../../../docs/importar-productos/ejemplos/productos-ejemplo.xlsx',
    '../../../../docs/importar-productos/ejemplos/productos-con-errores.xlsx',
  ]) {
    const bytes = new Uint8Array(await readFile(new URL(archivo, import.meta.url)))
    const lectura = await leer(bytes)
    assert.ok(lectura.hojas.length >= 1, archivo)
    assert.ok(lectura.filas.length > 0, archivo)
  }
})

test('acepta XLSX legítimo con XML muy repetitivo', async () => {
  const bytes = crearXlsx(true)
  const lectura = await leer(bytes)
  assert.equal(lectura.filas.length, 350)
  assert.ok(bytes.length < 1024 * 1024)
})

test('rechaza tamaños centrales y locales manipulados contra la expansión efectiva', async () => {
  const bytes = crearXlsx()
  const { central, local } = encontrarCentral(bytes)
  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  vista.setUint32(central + 24, 1, true)
  vista.setUint32(local + 22, 1, true)
  let parserInvocado = false
  await assert.rejects(
    () => leerLibroConParser(
      bytes,
      null,
      ALIAS_CONOCIDOS,
      { ...XLSX, read: (...args: any[]) => { parserInvocado = true; return XLSX.read(...args) } },
    ),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )
  assert.equal(parserInvocado, false)
})

test('rechaza encabezados locales inconsistentes antes de invocar SheetJS', async () => {
  const bytes = crearXlsx()
  const { local } = encontrarCentral(bytes)
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(local + 8, 0, true)
  let parserInvocado = false
  await assert.rejects(
    () => leerLibroConParser(
      bytes,
      null,
      ALIAS_CONOCIDOS,
      { ...XLSX, read: (...args: any[]) => { parserInvocado = true; return XLSX.read(...args) } },
    ),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )
  assert.equal(parserInvocado, false)
})

test('aplica límites de cantidad de entradas y bytes realmente expandidos', async () => {
  await assert.rejects(
    () => leer(crearZipConEntradasVacias(LIMITES_ZIP_XLSX.entradas + 1)),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )

  // Los topes reducidos permiten probar expansión real sin generar archivos grandes.
  const bytes = crearXlsx()
  const limiteDePrueba = {
    ...LIMITES_ZIP_XLSX,
    bytesEntrada: 32,
    bytesDescomprimidos: 64,
  }
  await assert.rejects(
    () => leer(bytes, limiteDePrueba),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )

  const metadatosReducidos = crearXlsx()
  const { central, local } = encontrarCentral(metadatosReducidos)
  const vista = new DataView(metadatosReducidos.buffer, metadatosReducidos.byteOffset, metadatosReducidos.byteLength)
  vista.setUint32(central + 24, 1, true)
  vista.setUint32(local + 22, 1, true)
  await assert.rejects(
    () => leer(metadatosReducidos, limiteDePrueba),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )
})

test('rechaza archivo XLSX truncado o corrupto', async () => {
  const bytes = crearXlsx()
  await assert.rejects(
    () => leer(bytes.slice(0, bytes.length - 12)),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )

  const corrupto = crearXlsx()
  const { local } = encontrarCentral(corrupto)
  corrupto[local] = 0
  await assert.rejects(
    () => leer(corrupto),
    (error) => error instanceof ErrorArchivo && error.codigo === 'ARCHIVO_ILEGIBLE',
  )
})
