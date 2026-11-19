// =====================================================================
// Texto y números tal como vienen en una planilla.
//
// Está separado de `excel.ts` para poder probarlo con Node sin cargar
// SheetJS (que se importa por URL desde el CDN).
// =====================================================================

export const LIMITES = {
  maxFilas: 2000,
  maxColumnas: 60,
  maxBytes: 5 * 1024 * 1024,
  filasParaBuscarEncabezado: 15,
  codigo: 50,
  nombre: 150,
  descripcion: 2000,
  categoria: 100,
  stockMaximo: 2_147_483_647,
  precioMaximo: 9_999_999_999.99,
}

export function normalizarTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : null
  if (typeof valor === 'boolean') return String(valor)
  if (valor instanceof Date) return valor.toISOString()

  const limpio = String(valor)
    .replace(/[\u00a0\u2007\u202f]/g, ' ') // espacios "invisibles" de Excel/Word
    .replace(/[\u200b-\u200d\ufeff]/g, '') // ancho cero / BOM
    .replace(/\s+/g, ' ')
    .trim()

  return limpio === '' ? null : limpio
}

/** Encabezado comparable: sin acentos, minúsculas y solo letras/números. */
export function normalizarEncabezado(valor: unknown): string {
  const texto = normalizarTexto(valor)
  if (!texto) return ''
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function paraMensaje(valor: unknown, maximo = 60): string {
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
  if (comas > 0) {
    return sonGruposDeMiles(texto.split(',')) ? texto.replace(/,/g, '') : texto.replace(/,/g, '.')
  }
  if (puntos > 0) return sonGruposDeMiles(texto.split('.')) ? texto.replace(/\./g, '') : texto
  return texto
}

export type Numero = { ok: true; valor: number } | { ok: false; motivo: 'vacio' | 'no_es_numero' }

export function parsearNumero(valor: unknown): Numero {
  if (valor === null || valor === undefined) return { ok: false, motivo: 'vacio' }
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? { ok: true, valor } : { ok: false, motivo: 'no_es_numero' }
  }
  if (typeof valor === 'boolean' || valor instanceof Date) return { ok: false, motivo: 'no_es_numero' }

  let texto = String(valor).replace(/[\u00a0\u2007\u202f]/g, ' ').trim()
  if (texto === '') return { ok: false, motivo: 'vacio' }

  texto = texto.replace(MONEDA_INICIO, '').replace(MONEDA_FIN, '').replace(/\$/g, '').replace(/\s/g, '')
  if (texto === '' || !SOLO_NUMERO.test(texto)) return { ok: false, motivo: 'no_es_numero' }

  const numero = Number(normalizarSeparadores(texto))
  return Number.isFinite(numero) ? { ok: true, valor: numero } : { ok: false, motivo: 'no_es_numero' }
}
