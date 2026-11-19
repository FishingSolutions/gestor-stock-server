// =====================================================================
// Lectura del Excel para la importación con IA.
//
// A diferencia del importador viejo (que exige encontrar los alias exactos
// de las columnas), acá solo se detecta la FILA DE ENCABEZADOS y se
// devuelven las celdas crudas. El mapeo de columnas lo resuelve `mapeo.ts`
// (alias) y, si hace falta, una única llamada a la IA.
//
// Lógica pura: no toca la base ni la red.
// =====================================================================
// SheetJS publica las versiones seguras en su propio CDN
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'

import { LIMITES, normalizarEncabezado, normalizarTexto } from './texto.ts'
import type { FilaArchivo, LecturaArchivo } from './tipos.ts'

export { LIMITES, normalizarEncabezado, normalizarTexto, paraMensaje, parsearNumero } from './texto.ts'
export type { Numero } from './texto.ts'

export class ErrorArchivo extends Error {
  constructor(
    public codigo: string,
    mensaje: string,
    public detalles: unknown = null,
  ) {
    super(mensaje)
  }
}

// ---------------------------------------------------------------------
// Firma real del archivo: SheetJS "lee" un .txt como CSV, así que solo se
// acepta un Excel de verdad (.xlsx = ZIP ; .xls = OLE2).
// ---------------------------------------------------------------------
export function pareceExcel(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  const zip =
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(bytes[2]) &&
    [0x04, 0x06, 0x08].includes(bytes[3])
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => bytes[i] === v)
  return zip || ole
}

// ---------------------------------------------------------------------
// Encabezado: la fila que tiene más columnas conocidas y más texto. Con
// esto funciona una planilla con título arriba o con filas en blanco.
// ---------------------------------------------------------------------
function puntajeFila(celdas: unknown[], alias: Set<string>): { puntos: number; noVacias: number } {
  let noVacias = 0
  let conocidas = 0

  for (const celda of celdas) {
    if (normalizarTexto(celda) === null) continue
    noVacias++
    if (alias.has(normalizarEncabezado(celda))) conocidas++
  }

  return { puntos: conocidas * 3 + Math.min(noVacias, 10), noVacias }
}

export function leerLibro(
  bytes: Uint8Array,
  nombreHoja: string | null,
  alias: Set<string>,
): LecturaArchivo {
  if (bytes.length === 0) throw new ErrorArchivo('ARCHIVO_VACIO', 'El archivo está vacío.')
  if (bytes.length > LIMITES.maxBytes) {
    throw new ErrorArchivo(
      'ARCHIVO_MUY_GRANDE',
      `El archivo supera el máximo de ${LIMITES.maxBytes / 1024 / 1024} MB.`,
    )
  }
  if (!pareceExcel(bytes)) {
    throw new ErrorArchivo('ARCHIVO_ILEGIBLE', 'El archivo no es un Excel válido (.xlsx o .xls).')
  }

  const tope = LIMITES.maxFilas + LIMITES.filasParaBuscarEncabezado + 1
  let libro: XLSX.WorkBook
  try {
    libro = XLSX.read(bytes, {
      type: 'array',
      dense: true,
      cellDates: false,
      cellNF: false,
      cellText: false,
      sheetRows: tope,
    })
  } catch {
    throw new ErrorArchivo(
      'ARCHIVO_ILEGIBLE',
      'No se pudo leer el archivo. Verificá que sea un Excel válido (.xlsx o .xls) y que no esté dañado o protegido con contraseña.',
    )
  }

  if (!libro.SheetNames?.length) {
    throw new ErrorArchivo('ARCHIVO_SIN_HOJAS', 'El archivo no tiene ninguna hoja de cálculo.')
  }

  let hojaElegida = libro.SheetNames[0]
  if (nombreHoja) {
    const encontrada = libro.SheetNames.find(
      (n) => normalizarEncabezado(n) === normalizarEncabezado(nombreHoja),
    )
    if (!encontrada) {
      throw new ErrorArchivo('HOJA_INEXISTENTE', `La hoja "${nombreHoja}" no existe en el archivo.`, {
        hojasDisponibles: libro.SheetNames,
      })
    }
    hojaElegida = encontrada
  }

  const hoja = libro.Sheets[hojaElegida]
  if (!hoja || !hoja['!ref']) throw new ErrorArchivo('HOJA_VACIA', `La hoja "${hojaElegida}" está vacía.`)

  const rango = XLSX.utils.decode_range(hoja['!ref'])
  const crudas = XLSX.utils.sheet_to_json<unknown[]>(hoja, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  })

  if (crudas.length === 0) throw new ErrorArchivo('HOJA_VACIA', `La hoja "${hojaElegida}" está vacía.`)

  // 1. Ubicar el encabezado
  let indiceEncabezado = -1
  let mejorPuntaje = -1
  const limite = Math.min(crudas.length, LIMITES.filasParaBuscarEncabezado)

  for (let i = 0; i < limite; i++) {
    const { puntos, noVacias } = puntajeFila(crudas[i] ?? [], alias)
    if (noVacias < 2) continue
    if (puntos > mejorPuntaje) {
      mejorPuntaje = puntos
      indiceEncabezado = i
    }
  }

  if (indiceEncabezado === -1) {
    throw new ErrorArchivo(
      'ENCABEZADO_NO_ENCONTRADO',
      'No se encontró una fila de encabezados con al menos dos columnas con nombre.',
    )
  }

  const filaCruda = crudas[indiceEncabezado] ?? []
  const cantidadColumnas = Math.max(...crudas.map((fila) => (fila ?? []).length))
  if (cantidadColumnas > LIMITES.maxColumnas) {
    throw new ErrorArchivo(
      'DEMASIADAS_COLUMNAS',
      `La planilla supera el máximo de ${LIMITES.maxColumnas} columnas.`,
    )
  }

  const encabezados: string[] = []
  for (let c = 0; c < cantidadColumnas; c++) {
    encabezados.push(normalizarTexto(filaCruda[c]) ?? `Columna ${c + 1}`)
  }

  // 2. Filas de datos
  const filas: FilaArchivo[] = []
  let filasVacias = 0

  for (let i = indiceEncabezado + 1; i < crudas.length; i++) {
    const celdas = (crudas[i] ?? []).slice(0, cantidadColumnas)
    if (celdas.every((c) => normalizarTexto(c) === null)) {
      filasVacias++
      continue
    }
    filas.push({ numeroFila: rango.s.r + i + 1, celdas }) // número de fila como se ve en Excel
    if (filas.length > LIMITES.maxFilas) {
      throw new ErrorArchivo(
        'DEMASIADAS_FILAS',
        `La planilla supera el máximo de ${LIMITES.maxFilas} filas por importación. Dividila en varios archivos más chicos.`,
      )
    }
  }

  if (filas.length === 0) {
    throw new ErrorArchivo('SIN_FILAS', 'La planilla no tiene filas con datos para importar.')
  }

  return {
    hoja: hojaElegida,
    hojas: libro.SheetNames,
    filaEncabezado: rango.s.r + indiceEncabezado + 1,
    encabezados,
    filas,
    filasVacias,
  }
}
