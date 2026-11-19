// =====================================================================
// Cruce contra el inventario actual y clasificación de cada fila.
//
// Reglas:
//   * código igual (sin distinguir mayúsculas)  -> actualizar ese producto
//   * nombre muy parecido y código nuevo        -> ambiguo (decide el admin)
//   * sin coincidencias                          -> producto nuevo
//   * sin cambios                                -> se informa y no se escribe
//
// La similitud de nombres se calcula localmente: no se manda el inventario
// a la IA. Solo se usan las filas del archivo, que el admin ya tiene.
// =====================================================================
import type {
  FilaImportada,
  FilaPrevia,
  ModoStock,
  ProductoExistente,
} from './tipos.ts'

const UMBRAL_SUGERENCIA = 0.75
const UMBRAL_AMBIGUO = 0.86

export function normalizarNombre(texto: string | null | undefined): string {
  if (!texto) return ''
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function distancia(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i)
  let actual = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    actual[0] = i
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      actual[j] = Math.min(actual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + costo)
    }
    const tmp = anterior
    anterior = actual
    actual = tmp
  }

  return anterior[b.length]
}

/** Similitud 0..1 entre dos nombres de producto. */
export function similitud(a: string, b: string): number {
  const na = normalizarNombre(a)
  const nb = normalizarNombre(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.95

  const ta = new Set(na.split(' '))
  const tb = new Set(nb.split(' '))
  const interseccion = [...ta].filter((t) => tb.has(t)).length
  const union = new Set([...ta, ...tb]).size
  const jaccard = union === 0 ? 0 : interseccion / union

  const ratio = 1 - distancia(na, nb) / Math.max(na.length, nb.length)

  return Math.round((0.5 * jaccard + 0.5 * ratio) * 1000) / 1000
}

interface Cambio {
  campo: string
  antes: unknown
  despues: unknown
}

/** Cambios que aplicaría la importación sobre un producto existente. */
function calcularCambios(
  fila: FilaImportada,
  producto: ProductoExistente,
  modo: ModoStock | null,
): Cambio[] {
  const cambios: Cambio[] = []

  if (fila.nombre && fila.nombre !== producto.nombre) {
    cambios.push({ campo: 'nombre', antes: producto.nombre, despues: fila.nombre })
  }
  if (fila.descripcion !== null && fila.descripcion !== producto.descripcion) {
    cambios.push({ campo: 'descripcion', antes: producto.descripcion, despues: fila.descripcion })
  }
  if (fila.categoria !== null && fila.categoria !== producto.categoria) {
    cambios.push({ campo: 'categoria', antes: producto.categoria, despues: fila.categoria })
  }
  if (fila.precio !== null && fila.precio !== producto.precio) {
    cambios.push({ campo: 'precio', antes: producto.precio, despues: fila.precio })
  }
  if (fila.costo !== null && fila.costo !== producto.costo) {
    cambios.push({ campo: 'costo', antes: producto.costo, despues: fila.costo })
  }
  if (fila.stockMinimo !== null && fila.stockMinimo !== producto.stockMinimo) {
    cambios.push({ campo: 'stockMinimo', antes: producto.stockMinimo, despues: fila.stockMinimo })
  }
  if (fila.stockMaximo !== null && fila.stockMaximo !== producto.stockMaximo) {
    cambios.push({ campo: 'stockMaximo', antes: producto.stockMaximo, despues: fila.stockMaximo })
  }
  if (fila.activo !== null && fila.activo !== producto.activo) {
    cambios.push({ campo: 'activo', antes: producto.activo, despues: fila.activo })
  }

  if (modo && fila.stock !== null) {
    const propuesto = modo === 'SUMAR' ? producto.stock + fila.stock : fila.stock
    if (propuesto !== producto.stock) {
      cambios.push({ campo: 'stock', antes: producto.stock, despues: propuesto })
    }
  }

  return cambios
}

export function clasificarFilas(
  filas: FilaImportada[],
  productos: ProductoExistente[],
  modo: ModoStock | null,
): FilaPrevia[] {
  const porCodigo = new Map<string, ProductoExistente>()
  for (const producto of productos) {
    porCodigo.set(producto.codigo.trim().toLowerCase(), producto)
  }

  return filas.map((fila) => {
    const base: Omit<FilaPrevia, 'estado' | 'accion' | 'idProducto' | 'actual' | 'cambios' | 'sugerencias'> = fila
    const errores = [...fila.errores]

    // 1. Fila con datos inválidos: no se puede importar.
    if (errores.length > 0) {
      return {
        ...base,
        errores,
        estado: 'invalida' as const,
        accion: 'EXCLUIR' as const,
        idProducto: null,
        actual: null,
        cambios: [],
        sugerencias: [],
      }
    }

    // 2. Mismo código: se actualiza ese producto.
    const existente = porCodigo.get(fila.codigo.trim().toLowerCase()) ?? null

    if (existente) {
      const cambios = calcularCambios(fila, existente, modo)

      // Un producto dado de baja no puede recibir stock, salvo que la misma
      // fila lo reactive.
      if (
        modo &&
        fila.stock !== null &&
        !(fila.activo ?? existente.activo) &&
        cambios.some((c) => c.campo === 'stock')
      ) {
        errores.push(
          `El producto "${existente.nombre}" está dado de baja. Activalo antes de importar stock o excluí la fila.`,
        )
        return {
          ...base,
          errores,
          estado: 'invalida' as const,
          accion: 'EXCLUIR' as const,
          idProducto: null,
          actual: existente,
          cambios: [],
          sugerencias: [],
        }
      }

      return {
        ...base,
        errores,
        estado: cambios.length === 0 ? ('sin_cambios' as const) : ('existente' as const),
        accion: 'ACTUALIZAR' as const,
        idProducto: existente.idProducto,
        actual: existente,
        cambios,
        sugerencias: [],
      }
    }

    // 3. Nombre parecido a un producto que ya existe: decide el admin.
    const sugerencias = productos
      .map((producto) => ({
        idProducto: producto.idProducto,
        codigo: producto.codigo,
        nombre: producto.nombre,
        similitud: similitud(fila.nombre, producto.nombre),
      }))
      .filter((s) => s.similitud >= UMBRAL_SUGERENCIA)
      .sort((a, b) => b.similitud - a.similitud)
      .slice(0, 3)

    if (sugerencias.length > 0 && sugerencias[0].similitud >= UMBRAL_AMBIGUO) {
      return {
        ...base,
        errores,
        estado: 'ambigua' as const,
        accion: 'EXCLUIR' as const, // hasta que el admin elija
        idProducto: null,
        actual: null,
        cambios: [],
        sugerencias,
      }
    }

    // 4. Producto nuevo: necesita precio, no se inventa.
    if (fila.precio === null) {
      errores.push('El precio es obligatorio para un producto nuevo.')
      return {
        ...base,
        errores,
        estado: 'invalida' as const,
        accion: 'EXCLUIR' as const,
        idProducto: null,
        actual: null,
        cambios: [],
        sugerencias,
      }
    }

    return {
      ...base,
      errores,
      estado: 'nuevo' as const,
      accion: 'CREAR' as const,
      idProducto: null,
      actual: null,
      cambios: [],
      sugerencias,
    }
  })
}

export function resumirFilas(filas: FilaPrevia[]) {
  return {
    filas: filas.length,
    nuevos: filas.filter((f) => f.estado === 'nuevo').length,
    existentes: filas.filter((f) => f.estado === 'existente').length,
    sinCambios: filas.filter((f) => f.estado === 'sin_cambios').length,
    ambiguas: filas.filter((f) => f.estado === 'ambigua').length,
    invalidas: filas.filter((f) => f.estado === 'invalida').length,
  }
}
