// =====================================================================
// Mapeo de columnas: encabezado de la planilla -> campo del sistema.
//
// Hay dos pasos:
//   1. Alias deterministas (gratis y sin red).
//   2. Si falta algo importante, una única llamada a la IA que devuelve
//      candidatos. Lo que devuelve el modelo se valida acá: si propone un
//      campo inexistente, una columna fuera de rango o repetida, se
//      descarta. Nunca se confía en el JSON del modelo.
// =====================================================================
import { normalizarEncabezado } from './texto.ts'
import { CAMPOS, type Campo, type Mapeo } from './tipos.ts'

// Nombres de columna aceptados. Se comparan sin acentos ni mayúsculas.
// El orden importa: si un alias se repite gana el primer campo, por eso
// `nombre` va antes que `descripcion`.
export const ALIAS: Record<Campo, string[]> = {
  codigo: [
    'codigo', 'cod', 'cod producto', 'codigo producto', 'codigo de producto',
    'cod articulo', 'codigo articulo', 'sku', 'referencia', 'ref', 'codigo interno',
  ],
  nombre: [
    'nombre', 'descripcion', 'producto', 'nombre producto', 'descripcion producto',
    'denominacion', 'articulo', 'nombre del producto',
  ],
  descripcion: [
    'detalle', 'descripcion larga', 'descripcion detallada', 'observaciones',
    'notas', 'comentarios', 'detalle producto',
  ],
  categoria: ['categoria', 'rubro', 'familia', 'grupo', 'linea', 'tipo'],
  stock: [
    'stock', 'stock actual', 'cantidad', 'existencias', 'existencia', 'unidades',
    'stock disponible', 'cant', 'cantidad actual',
  ],
  precio: [
    'precio', 'precio venta', 'precio de venta', 'pvp', 'precio publico',
    'precio unitario', 'importe', 'precio final', 'precio lista',
  ],
  costo: [
    'costo', 'precio costo', 'precio de costo', 'precio compra', 'precio de compra',
    'costo unitario', 'costo neto',
  ],
  stockMinimo: [
    'stock minimo', 'stock min', 'minimo', 'min', 'punto de pedido', 'stock de seguridad',
  ],
  stockMaximo: ['stock maximo', 'stock max', 'maximo', 'max', 'stock tope'],
  activo: ['activo', 'habilitado', 'vigente', 'estado', 'estado producto'],
}

// Títulos que se usan al mostrar el mapeo y en el mensaje de error.
export const TITULOS: Record<Campo, string> = {
  codigo: 'Código',
  nombre: 'Descripción',
  descripcion: 'Detalle',
  categoria: 'Categoría',
  stock: 'Stock',
  precio: 'Precio',
  costo: 'Costo',
  stockMinimo: 'Stock mínimo',
  stockMaximo: 'Stock máximo',
  activo: 'Activo',
}

const ALIAS_NORMALIZADOS = (() => {
  const mapa = new Map<string, Campo>()
  for (const campo of CAMPOS) {
    for (const nombre of ALIAS[campo]) {
      const clave = normalizarEncabezado(nombre)
      if (clave && !mapa.has(clave)) mapa.set(clave, campo)
    }
  }
  return mapa
})()

/** Todos los alias conocidos, ya normalizados (lo usa el lector de Excel). */
export const ALIAS_CONOCIDOS: Set<string> = new Set(ALIAS_NORMALIZADOS.keys())

/** Mapeo por alias: la primera columna que matchea gana. */
export function mapearPorAlias(encabezados: string[]): Mapeo {
  const mapeo: Mapeo = {}
  const usados = new Set<number>()

  encabezados.forEach((encabezado, columna) => {
    const campo = ALIAS_NORMALIZADOS.get(normalizarEncabezado(encabezado))
    if (!campo || mapeo[campo] !== undefined || usados.has(columna)) return
    mapeo[campo] = columna
    usados.add(columna)
  })

  return mapeo
}

/**
 * Mezcla las sugerencias de la IA con el mapeo determinista.
 * Devuelve también los motivos de rechazo, para mostrarlos como advertencia.
 */
export function combinarMapeo(
  base: Mapeo,
  sugerencias: unknown,
  totalColumnas: number,
): { mapeo: Mapeo; rechazadas: string[] } {
  const mapeo: Mapeo = { ...base }
  const rechazadas: string[] = []

  if (!sugerencias || typeof sugerencias !== 'object') {
    return { mapeo, rechazadas: ['La IA no devolvió un objeto de columnas.'] }
  }

  const columnas = (sugerencias as { columnas?: unknown }).columnas
  if (!columnas || typeof columnas !== 'object') {
    return { mapeo, rechazadas: ['La IA no devolvió el campo "columnas".'] }
  }

  const yaUsadas = new Set(Object.values(mapeo))

  for (const [campo, valor] of Object.entries(columnas as Record<string, unknown>)) {
    if (!CAMPOS.includes(campo as Campo)) {
      rechazadas.push(`La IA propuso un campo desconocido: "${campo}".`)
      continue
    }
    if (mapeo[campo as Campo] !== undefined) {
      // El alias determinista tiene prioridad sobre la IA.
      continue
    }
    if (!Number.isInteger(valor) || (valor as number) < 0 || (valor as number) >= totalColumnas) {
      rechazadas.push(`La IA propuso una columna inválida para "${campo}".`)
      continue
    }
    if (yaUsadas.has(valor as number)) {
      rechazadas.push(`La IA propuso la misma columna para dos campos distintos ("${campo}").`)
      continue
    }

    mapeo[campo as Campo] = valor as number
    yaUsadas.add(valor as number)
  }

  return { mapeo, rechazadas }
}

/** Columnas del archivo que quedaron sin mapear (se informan al usuario). */
export function columnasSinMapear(encabezados: string[], mapeo: Mapeo): string[] {
  const usadas = new Set(Object.values(mapeo))
  return encabezados.filter((_, columna) => !usadas.has(columna))
}

/** ¿Vale la pena llamar a la IA? Sí cuando falta un campo clave. */
export function faltanCamposClave(mapeo: Mapeo): boolean {
  return mapeo.codigo === undefined || mapeo.nombre === undefined
}
