// =====================================================================
// Normalización de textos.
//
// Las planillas reales traen de todo: mayúsculas mezcladas, acentos,
// espacios dobles, espacios que no se ven (NBSP) y celdas numéricas donde
// se esperaba texto. Estas funciones dejan todo comparable sin cambiar lo
// que se guarda en la base (el código y el nombre se guardan "limpios").
// =====================================================================

/** Quita acentos y diacríticos. */
export function quitarAcentos(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Texto limpio: sin espacios al borde, sin espacios repetidos y sin
 * caracteres invisibles. Devuelve `null` si queda vacío.
 */
export function normalizarTexto(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : null;
  if (typeof valor === 'boolean') return String(valor);
  if (valor instanceof Date) return valor.toISOString();

  const limpio = String(valor)
    .replace(/[\u00a0\u2007\u202f]/g, ' ') // espacios "invisibles" de Excel/Word
    .replace(/[\u200b-\u200d\ufeff]/g, '') // ancho cero / BOM
    .replace(/\s+/g, ' ')
    .trim();

  return limpio === '' ? null : limpio;
}

/**
 * Normaliza un encabezado de columna para compararlo con los alias:
 * "  Código " -> "codigo", "Precio_Venta" -> "precio venta".
 */
export function normalizarEncabezado(valor) {
  const texto = normalizarTexto(valor);
  if (!texto) return '';

  return quitarAcentos(texto)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Clave para comparar códigos. Con `sinMayusculas` (por defecto) "p001" y
 * "P001" son el mismo código, igual que hace la consulta SQL con lower().
 */
export function claveCodigo(codigo, { sinMayusculas = true } = {}) {
  const texto = normalizarTexto(codigo);
  if (!texto) return '';
  return sinMayusculas ? texto.toLowerCase() : texto;
}

/** Clave para comparar nombres de categoría (misma regla que el SQL: lower + trim). */
export function claveCategoria(nombre) {
  const texto = normalizarTexto(nombre);
  return texto ? texto.toLowerCase() : '';
}

/** Recorta para mostrar en un mensaje sin llenar la respuesta de texto. */
export function paraMensaje(valor, maximo = 60) {
  const texto = normalizarTexto(valor);
  if (texto === null) return '(vacío)';

  return texto.length > maximo ? `${texto.slice(0, maximo)}…` : texto;
}
