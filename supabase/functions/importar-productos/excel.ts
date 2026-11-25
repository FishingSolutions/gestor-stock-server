// =====================================================================
// Lectura y validación del Excel de productos.
//
// Lógica pura (no toca la base ni la red): recibe los bytes del archivo y
// devuelve las filas válidas y los errores. Mismas reglas y mensajes que el
// importador original de src/modules/productos/importacion.
// =====================================================================
// SheetJS publica las versiones seguras en su propio CDN (la de npm está desactualizada)
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'

export const LIMITES = {
  maxFilas: 2000,
  maxBytes: 5 * 1024 * 1024,
  codigo: 50,
  nombre: 150,
  descripcion: 2000,
  categoria: 100,
  stockMaximo: 2_147_483_647,
  precioMaximo: 9_999_999_999.99,
  filasParaBuscarEncabezado: 15,
}

type Campo = 'codigo' | 'nombre' | 'descripcion' | 'categoria' | 'stock' | 'precio' | 'costo'

const TITULOS: Record<Campo, string> = {
  codigo: 'Código',
  nombre: 'Descripción',
  descripcion: 'Detalle',
  categoria: 'Categoría',
  stock: 'Stock',
  precio: 'Precio',
  costo: 'Costo',
}

// Nombres de columna aceptados (se comparan sin acentos ni mayúsculas).
// Si un alias se repite gana el primer campo: por eso `nombre` va antes que `descripcion`.
const ALIAS: Record<Campo, string[]> = {
  codigo: ['codigo', 'cod', 'cod producto', 'codigo producto', 'codigo de producto', 'cod articulo', 'codigo articulo', 'sku'],
  nombre: ['nombre', 'descripcion', 'producto', 'nombre producto', 'descripcion producto', 'denominacion'],
  descripcion: ['detalle', 'descripcion larga', 'descripcion detallada', 'observaciones', 'notas'],
  categoria: ['categoria', 'rubro', 'familia', 'grupo'],
  stock: ['stock', 'stock actual', 'cantidad', 'existencias', 'existencia', 'unidades', 'stock disponible'],
  precio: ['precio', 'precio venta', 'precio de venta', 'pvp', 'precio publico', 'precio unitario', 'importe'],
  costo: ['costo', 'precio costo', 'precio de costo', 'precio compra', 'precio de compra', 'costo unitario'],
}

const REQUERIDOS: Campo[] = ['codigo', 'nombre', 'stock', 'precio']

export class ErrorArchivo extends Error {
  constructor(public codigo: string, mensaje: string, public detalles: unknown = null) {
    super(mensaje)
  }
}

export interface ErrorFila {
  fila: number | null
  codigo: string | null
  campo: string | null
  mensaje: string
}

export interface ProductoValido {
  fila: number
  codigo: string
  nombre: string
  descripcion: string | null
  categoria: string | null
  stock: number
  precio: number
  costo: number
}

// ---------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------
export function normalizarTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : null
  if (typeof valor === 'boolean') return String(valor)
  if (valor instanceof Date) return valor.toISOString()

  const limpio = String(valor)
    .replace(/[   ]/g, ' ') // espacios "invisibles" de Excel/Word
    .replace(/[​-‍﻿]/g, '') // ancho cero / BOM
    .replace(/\s+/g, ' ')
    .trim()

  return limpio === '' ? null : limpio
}

function normalizarEncabezado(valor: unknown): string {
  const texto = normalizarTexto(valor)
  if (!texto) return ''
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function paraMensaje(valor: unknown, maximo = 60): string {
  const texto = normalizarTexto(valor)
  if (texto === null) return '(vacío)'
  return texto.length > maximo ? `${texto.slice(0, maximo)}…` : texto
}

// ---------------------------------------------------------------------
// Números "como vienen en la planilla": 25, "15.000", "1.500,50", "$ 15.000"
// ---------------------------------------------------------------------
const MONEDA_INICIO = /^\s*(ars|usd|eur|uyu|\$)\s*/i
const MONEDA_FIN = /\s*(ars|usd|eur|uyu)\s*$/i
const SOLO_NUMERO = /^[+-]?\d[\d.,]*$/

function sonGruposDeMiles(partes: string[]): boolean {
  return partes.length >= 2 && partes[0] !== '' && partes.slice(1).every((p) => p.length === 3)
}

// Si están coma y punto, el último es el decimal. Un solo separador seguido
// de exactamente 3 dígitos es de miles (1.500 -> 1500). Si no, es decimal.
function normalizarSeparadores(texto: string): string {
  const comas = (texto.match(/,/g) ?? []).length
  const puntos = (texto.match(/\./g) ?? []).length

  if (comas > 0 && puntos > 0) {
    return texto.lastIndexOf(',') > texto.lastIndexOf('.')
      ? texto.replace(/\./g, '').replace(/,/g, '.')
      : texto.replace(/,/g, '')
  }
  if (comas > 0) return sonGruposDeMiles(texto.split(',')) ? texto.replace(/,/g, '') : texto.replace(/,/g, '.')
  if (puntos > 0) return sonGruposDeMiles(texto.split('.')) ? texto.replace(/\./g, '') : texto
  return texto
}

type Numero = { ok: true; valor: number } | { ok: false; motivo: 'vacío' | 'no es un número' }

export function parsearNumero(valor: unknown): Numero {
  if (valor === null || valor === undefined) return { ok: false, motivo: 'vacío' }
  if (typeof valor === 'number') return Number.isFinite(valor) ? { ok: true, valor } : { ok: false, motivo: 'no es un número' }
  if (typeof valor === 'boolean' || valor instanceof Date) return { ok: false, motivo: 'no es un número' }

  let texto = String(valor).replace(/[   ]/g, ' ').trim()
  if (texto === '') return { ok: false, motivo: 'vacío' }

  texto = texto.replace(MONEDA_INICIO, '').replace(MONEDA_FIN, '').replace(/\$/g, '').replace(/\s/g, '')
  if (texto === '' || !SOLO_NUMERO.test(texto)) return { ok: false, motivo: 'no es un número' }

  const numero = Number(normalizarSeparadores(texto))
  return Number.isFinite(numero) ? { ok: true, valor: numero } : { ok: false, motivo: 'no es un número' }
}

const redondear2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// ---------------------------------------------------------------------
// Lectura del archivo
// ---------------------------------------------------------------------
const ALIAS_NORMALIZADOS = (() => {
  const mapa = new Map<string, Campo>()
  for (const [campo, alias] of Object.entries(ALIAS) as [Campo, string[]][]) {
    for (const nombre of alias) {
      const clave = normalizarEncabezado(nombre)
      if (clave && !mapa.has(clave)) mapa.set(clave, campo)
    }
  }
  return mapa
})()

// SheetJS "lee" hasta un .txt como CSV: acá solo se acepta un Excel de verdad
// (.xlsx = ZIP 50 4B 03 04 ; .xls = OLE2 D0 CF 11 E0 A1 B1 1A E1)
function pareceExcel(b: Uint8Array): boolean {
  if (b.length < 8) return false
  const zip = b[0] === 0x50 && b[1] === 0x4b && [0x03, 0x05, 0x07].includes(b[2]) && [0x04, 0x06, 0x08].includes(b[3])
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => b[i] === v)
  return zip || ole
}

// La fila de encabezados es la que tiene más columnas conocidas (y el código).
function ubicarEncabezado(filas: unknown[][]) {
  let mejor: { indice: number; columnas: Map<Campo, number>; titulos: string[] } | null = null
  const limite = Math.min(filas.length, LIMITES.filasParaBuscarEncabezado)

  for (let indice = 0; indice < limite; indice++) {
    const columnas = new Map<Campo, number>()
    const titulos: string[] = []
    ;(filas[indice] ?? []).forEach((celda, columna) => {
      const campo = ALIAS_NORMALIZADOS.get(normalizarEncabezado(celda))
      if (campo && !columnas.has(campo)) {
        columnas.set(campo, columna)
        titulos.push(normalizarTexto(celda) ?? `Columna ${columna + 1}`)
      }
    })
    if (columnas.size >= 2 && columnas.has('codigo') && (!mejor || columnas.size > mejor.columnas.size)) {
      mejor = { indice, columnas, titulos }
    }
  }
  return mejor
}

export function leerExcel(bytes: Uint8Array, nombreHoja?: string | null) {
  if (bytes.length === 0) throw new ErrorArchivo('ARCHIVO_VACIO', 'El archivo está vacío.')
  if (!pareceExcel(bytes)) {
    throw new ErrorArchivo('ARCHIVO_ILEGIBLE', 'El archivo no es un Excel válido (.xlsx o .xls).')
  }

  const tope = LIMITES.maxFilas + LIMITES.filasParaBuscarEncabezado + 1
  let libro: XLSX.WorkBook
  try {
    libro = XLSX.read(bytes, { type: 'array', dense: true, cellDates: false, cellNF: false, cellText: false, sheetRows: tope })
  } catch {
    throw new ErrorArchivo(
      'ARCHIVO_ILEGIBLE',
      'No se pudo leer el archivo. Verificá que sea un Excel válido (.xlsx o .xls) y que no esté dañado o protegido con contraseña.',
    )
  }

  if (!libro.SheetNames?.length) throw new ErrorArchivo('ARCHIVO_SIN_HOJAS', 'El archivo no tiene ninguna hoja de cálculo.')

  let hojaElegida = libro.SheetNames[0]
  if (nombreHoja) {
    const encontrada = libro.SheetNames.find((n) => normalizarEncabezado(n) === normalizarEncabezado(nombreHoja))
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
  const crudas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: null, blankrows: true })
  const encabezado = ubicarEncabezado(crudas)

  if (!encabezado) {
    throw new ErrorArchivo(
      'ENCABEZADO_NO_ENCONTRADO',
      `No se encontró la fila de encabezados. La planilla tiene que tener una fila con las columnas: ${REQUERIDOS.map((c) => TITULOS[c]).join(', ')}.`,
      { columnasEsperadas: REQUERIDOS.map((c) => TITULOS[c]) },
    )
  }

  const faltantes = REQUERIDOS.filter((c) => !encabezado.columnas.has(c))
  if (faltantes.length > 0) {
    const n = faltantes.length === 1
    throw new ErrorArchivo(
      'COLUMNAS_FALTANTES',
      `A la planilla le falta${n ? '' : 'n'} la${n ? '' : 's'} columna${n ? '' : 's'}: ${faltantes.map((c) => TITULOS[c]).join(', ')}.`,
      { faltantes: faltantes.map((c) => TITULOS[c]), encontradas: encabezado.titulos },
    )
  }

  const filas: { numeroFila: number; valores: Partial<Record<Campo, unknown>> }[] = []
  let filasVacias = 0

  for (let i = encabezado.indice + 1; i < crudas.length; i++) {
    const celdas = crudas[i] ?? []
    if (celdas.every((c) => normalizarTexto(c) === null)) {
      filasVacias++
      continue
    }
    const valores: Partial<Record<Campo, unknown>> = {}
    for (const [campo, columna] of encabezado.columnas) valores[campo] = celdas[columna] ?? null
    filas.push({ numeroFila: rango.s.r + i + 1, valores }) // número de fila como se ve en Excel
  }

  const filasLeidas = rango.e.r - rango.s.r + 1
  if (filas.length > LIMITES.maxFilas || (filasLeidas >= tope && filas.length >= LIMITES.maxFilas)) {
    throw new ErrorArchivo(
      'DEMASIADAS_FILAS',
      `La planilla supera el máximo de ${LIMITES.maxFilas} filas por importación. Dividila en varios archivos más chicos.`,
    )
  }
  if (filas.length === 0) throw new ErrorArchivo('SIN_FILAS', 'La planilla no tiene filas con datos para importar.')

  const conocidas = new Set(encabezado.columnas.values())
  const columnasIgnoradas = (crudas[encabezado.indice] ?? [])
    .map((celda, columna) => ({ columna, titulo: normalizarTexto(celda) }))
    .filter(({ columna, titulo }) => titulo !== null && !conocidas.has(columna))
    .map(({ titulo }) => titulo as string)

  return {
    hoja: hojaElegida,
    hojas: libro.SheetNames,
    filaEncabezado: rango.s.r + encabezado.indice + 1,
    filas,
    filasVacias,
    columnasIgnoradas,
  }
}

// ---------------------------------------------------------------------
// Validación de cada fila (los códigos repetidos y los que ya existen en la
// base los revisa además la función SQL importar_productos)
// ---------------------------------------------------------------------
export function validarFilas(filas: { numeroFila: number; valores: Partial<Record<Campo, unknown>> }[]) {
  const validos: ProductoValido[] = []
  const errores: ErrorFila[] = []
  const vistos = new Map<string, number>()

  for (const { numeroFila: fila, valores } of filas) {
    const erroresFila: ErrorFila[] = []
    const codigo = normalizarTexto(valores.codigo)
    const agregar = (campo: string, mensaje: string) => erroresFila.push({ fila, codigo, campo, mensaje })

    if (!codigo) {
      agregar('codigo', 'El código es obligatorio.')
    } else {
      if (/[\u0000-\u001f\u007f]/.test(codigo)) agregar('codigo', 'El código tiene caracteres no permitidos.')
      if (codigo.length > LIMITES.codigo) {
        agregar('codigo', `El código no puede superar los ${LIMITES.codigo} caracteres (tiene ${codigo.length}).`)
      }
      const clave = codigo.toLowerCase()
      if (vistos.has(clave)) {
        agregar('codigo', `El código "${codigo}" está repetido en el archivo (ya aparece en la fila ${vistos.get(clave)}).`)
      } else {
        vistos.set(clave, fila)
      }
    }

    const nombre = normalizarTexto(valores.nombre)
    if (!nombre) agregar('nombre', 'La descripción es obligatoria.')
    else if (nombre.length > LIMITES.nombre) {
      agregar('nombre', `La descripción no puede superar los ${LIMITES.nombre} caracteres (tiene ${nombre.length}).`)
    }

    const descripcion = normalizarTexto(valores.descripcion)
    if (descripcion && descripcion.length > LIMITES.descripcion) {
      agregar('descripcion', `El detalle no puede superar los ${LIMITES.descripcion} caracteres (tiene ${descripcion.length}).`)
    }

    const categoria = normalizarTexto(valores.categoria)
    if (categoria && categoria.length > LIMITES.categoria) {
      agregar('categoria', `La categoría no puede superar los ${LIMITES.categoria} caracteres (tiene ${categoria.length}).`)
    }

    let stock = 0
    const s = parsearNumero(valores.stock)
    if (!s.ok) {
      agregar('stock', s.motivo === 'vacío'
        ? 'El stock es obligatorio (0 o más).'
        : `El stock tiene que ser un número entero. Valor recibido: ${paraMensaje(valores.stock)}.`)
    } else if (!Number.isInteger(s.valor)) {
      agregar('stock', `El stock tiene que ser un número entero, sin decimales. Valor recibido: ${paraMensaje(valores.stock)}.`)
    } else if (s.valor < 0) agregar('stock', 'El stock no puede ser negativo.')
    else if (s.valor > LIMITES.stockMaximo) agregar('stock', `El stock no puede superar ${LIMITES.stockMaximo}.`)
    else stock = s.valor

    let precio = 0
    const p = parsearNumero(valores.precio)
    if (!p.ok) {
      agregar('precio', p.motivo === 'vacío'
        ? 'El precio es obligatorio.'
        : `El precio tiene que ser un número. Valor recibido: ${paraMensaje(valores.precio)}.`)
    } else if (p.valor <= 0) agregar('precio', 'El precio tiene que ser mayor que cero.')
    else if (p.valor > LIMITES.precioMaximo) agregar('precio', `El precio no puede superar ${LIMITES.precioMaximo}.`)
    else precio = redondear2(p.valor)

    let costo = 0
    if (normalizarTexto(valores.costo) !== null) {
      const c = parsearNumero(valores.costo)
      if (!c.ok) agregar('costo', `El costo tiene que ser un número. Valor recibido: ${paraMensaje(valores.costo)}.`)
      else if (c.valor < 0) agregar('costo', 'El costo no puede ser negativo.')
      else if (c.valor > LIMITES.precioMaximo) agregar('costo', `El costo no puede superar ${LIMITES.precioMaximo}.`)
      else costo = redondear2(c.valor)
    }

    if (erroresFila.length > 0) errores.push(...erroresFila)
    else validos.push({ fila, codigo: codigo!, nombre: nombre!, descripcion, categoria, stock, precio, costo })
  }

  return { validos, errores }
}

// ---------------------------------------------------------------------
// Plantilla para descargar
// ---------------------------------------------------------------------
export function generarPlantilla(): Uint8Array {
  const hoja = XLSX.utils.aoa_to_sheet([
    ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio', 'Costo', 'Detalle'],
    ['P001', 'Teclado Logitech', 'Perifericos', 25, 15000, 11000, 'Teclado USB en español'],
    ['P002', 'Mouse Genius', 'Perifericos', 40, 8500, 6000, ''],
  ])
  hoja['!cols'] = [{ wch: 12 }, { wch: 32 }, { wch: 18 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 30 }]
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, 'Productos')
  return new Uint8Array(XLSX.write(libro, { type: 'array', bookType: 'xlsx' }))
}
