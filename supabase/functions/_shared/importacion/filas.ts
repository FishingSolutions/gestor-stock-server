// =====================================================================
// Interpretación y validación de cada fila del Excel.
//
// No se inventa nada: si falta un dato obligatorio o viene mal, la fila
// queda marcada como inválida con el motivo. Los valores numéricos se
// parsean como vienen en las planillas argentinas ("15.000", "$ 1.500,50").
// =====================================================================
import {
  LIMITES,
  normalizarTexto,
  parsearNumero,
  paraMensaje,
} from './texto.ts'
import type { FilaImportada, LecturaArchivo, Mapeo } from './tipos.ts'

const redondear2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Un texto que empieza con "=" es una fórmula: no se acepta como dato. */
function esFormula(valor: unknown): boolean {
  if (typeof valor !== 'string') return false
  return /^\s*=/.test(valor)
}

function celda(celdas: unknown[], mapeo: Mapeo, campo: keyof Mapeo): unknown {
  const columna = mapeo[campo as keyof Mapeo]
  if (columna === undefined) return null
  return celdas[columna] ?? null
}

/** Valores de la columna "Activo": sí/no, true/false, 1/0, activo/inactivo. */
function parsearActivo(valor: unknown): boolean | null {
  const texto = normalizarTexto(valor)
  if (texto === null) return null

  const limpio = texto.toLowerCase()
  if (['si', 'sí', 's', 'true', '1', 'x', 'activo', 'habilitado'].includes(limpio)) return true
  if (['no', 'n', 'false', '0', 'inactivo', 'deshabilitado', 'baja'].includes(limpio)) return false
  return null
}

export function construirFilas(lectura: LecturaArchivo, mapeo: Mapeo): FilaImportada[] {
  const filas: FilaImportada[] = []
  const codigosVistos = new Map<string, number>()

  for (const { numeroFila, celdas } of lectura.filas) {
    const errores: string[] = []

    const codigo = normalizarTexto(celda(celdas, mapeo, 'codigo'))
    const nombre = normalizarTexto(celda(celdas, mapeo, 'nombre'))
    const descripcion = normalizarTexto(celda(celdas, mapeo, 'descripcion'))
    const categoria = normalizarTexto(celda(celdas, mapeo, 'categoria'))

    // --- Código -------------------------------------------------------
    if (!codigo) {
      errores.push('El código es obligatorio.')
    } else {
      if (/[\u0000-\u001f\u007f]/.test(codigo)) errores.push('El código tiene caracteres no permitidos.')
      if (codigo.length > LIMITES.codigo) {
        errores.push(`El código no puede superar los ${LIMITES.codigo} caracteres.`)
      }
      if (esFormula(codigo)) errores.push('El código no puede ser una fórmula.')

      const clave = codigo.toLowerCase()
      if (codigosVistos.has(clave)) {
        errores.push(`El código "${codigo}" está repetido en el archivo (ya aparece en la fila ${codigosVistos.get(clave)}).`)
      } else {
        codigosVistos.set(clave, numeroFila)
      }
    }

    // --- Nombre -------------------------------------------------------
    if (!nombre) {
      errores.push('La descripción es obligatoria.')
    } else {
      if (nombre.length > LIMITES.nombre) {
        errores.push(`La descripción no puede superar los ${LIMITES.nombre} caracteres.`)
      }
      if (esFormula(nombre)) errores.push('La descripción no puede ser una fórmula.')
    }

    if (descripcion && descripcion.length > LIMITES.descripcion) {
      errores.push(`El detalle no puede superar los ${LIMITES.descripcion} caracteres.`)
    }
    if (descripcion && esFormula(descripcion)) errores.push('El detalle no puede ser una fórmula.')

    if (categoria && categoria.length > LIMITES.categoria) {
      errores.push(`La categoría no puede superar los ${LIMITES.categoria} caracteres.`)
    }
    if (categoria && esFormula(categoria)) errores.push('La categoría no puede ser una fórmula.')

    // --- Stock (opcional: si no viene la columna, no se toca) ----------
    let stock: number | null = null
    const stockCrudo = celda(celdas, mapeo, 'stock')
    if (normalizarTexto(stockCrudo) !== null) {
      const s = parsearNumero(stockCrudo)
      if (!s.ok) {
        errores.push(`El stock tiene que ser un número entero. Valor recibido: ${paraMensaje(stockCrudo)}.`)
      } else if (!Number.isInteger(s.valor)) {
        errores.push(`El stock tiene que ser un número entero, sin decimales. Valor recibido: ${paraMensaje(stockCrudo)}.`)
      } else if (s.valor < 0) {
        errores.push('El stock no puede ser negativo.')
      } else if (s.valor > LIMITES.stockMaximo) {
        errores.push(`El stock no puede superar ${LIMITES.stockMaximo}.`)
      } else {
        stock = s.valor
      }
    }

    // --- Precio -------------------------------------------------------
    let precio: number | null = null
    const precioCrudo = celda(celdas, mapeo, 'precio')
    if (normalizarTexto(precioCrudo) !== null) {
      const p = parsearNumero(precioCrudo)
      if (!p.ok) {
        errores.push(`El precio tiene que ser un número. Valor recibido: ${paraMensaje(precioCrudo)}.`)
      } else if (p.valor <= 0) {
        errores.push('El precio tiene que ser mayor que cero.')
      } else if (p.valor > LIMITES.precioMaximo) {
        errores.push(`El precio no puede superar ${LIMITES.precioMaximo}.`)
      } else {
        precio = redondear2(p.valor)
      }
    }

    // --- Costo --------------------------------------------------------
    let costo: number | null = null
    const costoCrudo = celda(celdas, mapeo, 'costo')
    if (normalizarTexto(costoCrudo) !== null) {
      const c = parsearNumero(costoCrudo)
      if (!c.ok) {
        errores.push(`El costo tiene que ser un número. Valor recibido: ${paraMensaje(costoCrudo)}.`)
      } else if (c.valor < 0) {
        errores.push('El costo no puede ser negativo.')
      } else if (c.valor > LIMITES.precioMaximo) {
        errores.push(`El costo no puede superar ${LIMITES.precioMaximo}.`)
      } else {
        costo = redondear2(c.valor)
      }
    }

    // --- Stock mínimo / máximo ---------------------------------------
    let stockMinimo: number | null = null
    const minimoCrudo = celda(celdas, mapeo, 'stockMinimo')
    if (normalizarTexto(minimoCrudo) !== null) {
      const m = parsearNumero(minimoCrudo)
      if (!m.ok || !Number.isInteger(m.valor) || m.valor < 0) {
        errores.push(`El stock mínimo tiene que ser un entero, 0 o más. Valor recibido: ${paraMensaje(minimoCrudo)}.`)
      } else {
        stockMinimo = m.valor
      }
    }

    let stockMaximo: number | null = null
    const maximoCrudo = celda(celdas, mapeo, 'stockMaximo')
    if (normalizarTexto(maximoCrudo) !== null) {
      const m = parsearNumero(maximoCrudo)
      if (!m.ok || !Number.isInteger(m.valor) || m.valor < 0) {
        errores.push(`El stock máximo tiene que ser un entero, 0 o más. Valor recibido: ${paraMensaje(maximoCrudo)}.`)
      } else {
        stockMaximo = m.valor
      }
    }

    if (stockMinimo !== null && stockMaximo !== null && stockMaximo > 0 && stockMinimo > stockMaximo) {
      errores.push('El stock mínimo no puede ser mayor que el stock máximo.')
    }

    // --- Activo -------------------------------------------------------
    const activoCrudo = celda(celdas, mapeo, 'activo')
    const activo = parsearActivo(activoCrudo)
    if (normalizarTexto(activoCrudo) !== null && activo === null) {
      errores.push(`El estado tiene que ser SI o NO. Valor recibido: ${paraMensaje(activoCrudo)}.`)
    }

    filas.push({
      fila: numeroFila,
      codigo: codigo ?? '',
      nombre: nombre ?? '',
      descripcion,
      categoria,
      stock,
      precio,
      costo,
      stockMinimo,
      stockMaximo,
      activo,
      errores,
    })
  }

  return filas
}
