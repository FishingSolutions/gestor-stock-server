// =====================================================================
// Lectura de números "como vienen en la planilla".
//
// Excel puede entregar la celda como número (25), como texto ("25") o con
// formato local: "15.000", "1.500,50", "$ 15.000,00", "15,000.50".
// Esta función devuelve siempre un número o un motivo de error, nunca NaN.
// =====================================================================

/** Símbolos de moneda que se ignoran al principio o al final del valor. */
const MONEDA_INICIO = /^\s*(ars|usd|eur|uyu|\$)\s*/i;
const MONEDA_FIN = /\s*(ars|usd|eur|uyu)\s*$/i;
const SOLO_NUMERO = /^[+-]?\d[\d.,]*$/;

/** ¿Los grupos separados por `separador` son de miles? ("1.500.000", "1,500") */
function sonGruposDeMiles(partes) {
  if (partes.length < 2) return false;
  if (partes[0] === '') return false;
  return partes.slice(1).every((parte) => parte.length === 3);
}

/**
 * Interpreta el separador decimal y los de miles.
 * Criterio (documentado en docs/importar-productos/README.md):
 *   - Si están los dos, el último es el decimal: 1.500,50 / 1,500.50
 *   - Un único separador con exactamente 3 dígitos detrás se toma como miles:
 *     1.500 -> 1500 ; 1,500 -> 1500
 *   - En cualquier otro caso es decimal: 1.5 -> 1.5 ; 15,75 -> 15.75
 */
export function normalizarSeparadores(texto) {
  const comas = (texto.match(/,/g) ?? []).length;
  const puntos = (texto.match(/\./g) ?? []).length;

  if (comas > 0 && puntos > 0) {
    return texto.lastIndexOf(',') > texto.lastIndexOf('.')
      ? texto.replace(/\./g, '').replace(/,/g, '.') // 1.500,50 (es-AR)
      : texto.replace(/,/g, ''); // 1,500.50 (en-US)
  }

  if (comas > 0) {
    const partes = texto.split(',');
    return sonGruposDeMiles(partes) ? texto.replace(/,/g, '') : texto.replace(/,/g, '.');
  }

  if (puntos > 0) {
    const partes = texto.split('.');
    return sonGruposDeMiles(partes) ? texto.replace(/\./g, '') : texto;
  }

  return texto;
}

/**
 * @param {unknown} valor
 * @returns {{ ok: true, valor: number } | { ok: false, motivo: 'vacío' | 'no es un número' }}
 */
export function parsearNumero(valor) {
  if (valor === null || valor === undefined) return { ok: false, motivo: 'vacío' };

  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? { ok: true, valor } : { ok: false, motivo: 'no es un número' };
  }

  // Booleanos y fechas no son números válidos aunque se puedan convertir.
  if (typeof valor === 'boolean' || valor instanceof Date) {
    return { ok: false, motivo: 'no es un número' };
  }

  let texto = String(valor)
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .trim();

  if (texto === '') return { ok: false, motivo: 'vacío' };

  texto = texto.replace(MONEDA_INICIO, '').replace(MONEDA_FIN, '').replace(/\$/g, '').replace(/\s/g, '');

  if (texto === '' || !SOLO_NUMERO.test(texto)) return { ok: false, motivo: 'no es un número' };

  const numero = Number(normalizarSeparadores(texto));

  return Number.isFinite(numero) ? { ok: true, valor: numero } : { ok: false, motivo: 'no es un número' };
}

/** Redondea a 2 decimales sin los errores de coma flotante de Math.round(x*100). */
export function redondear2(numero) {
  return Math.round((numero + Number.EPSILON) * 100) / 100;
}
