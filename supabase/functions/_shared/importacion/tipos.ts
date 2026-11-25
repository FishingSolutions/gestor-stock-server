// =====================================================================
// Tipos compartidos por la importación con IA.
//
// El esquema es fijo: estos son los únicos campos que se pueden mapear
// desde una planilla. Cualquier columna que no caiga acá se ignora y se
// informa al usuario.
// =====================================================================

export type Campo =
  | 'codigo'
  | 'nombre'
  | 'descripcion'
  | 'categoria'
  | 'stock'
  | 'precio'
  | 'costo'
  | 'stockMinimo'
  | 'stockMaximo'
  | 'activo'

export const CAMPOS: Campo[] = [
  'codigo',
  'nombre',
  'descripcion',
  'categoria',
  'stock',
  'precio',
  'costo',
  'stockMinimo',
  'stockMaximo',
  'activo',
]

/** Mapeo campo -> índice de columna (0 = primera columna). */
export type Mapeo = Partial<Record<Campo, number>>

/** Estados con los que se muestra cada fila en la vista previa. */
export type EstadoFila =
  | 'nuevo'
  | 'existente'
  | 'sin_cambios'
  | 'ambigua'
  | 'invalida'

export type ModoStock = 'REEMPLAZAR' | 'SUMAR'

export interface ProductoExistente {
  idProducto: number
  codigo: string
  nombre: string
  descripcion: string | null
  categoria: string | null
  idCategoria: string | null
  stock: number
  precio: number
  costo: number
  stockMinimo: number
  stockMaximo: number
  activo: boolean
}

export interface FilaArchivo {
  numeroFila: number
  celdas: unknown[]
}

export interface LecturaArchivo {
  hoja: string
  hojas: string[]
  filaEncabezado: number
  encabezados: string[]
  filas: FilaArchivo[]
  filasVacias: number
}

/** Una fila del archivo ya interpretada y validada. */
export interface FilaImportada {
  fila: number
  codigo: string
  nombre: string
  descripcion: string | null
  categoria: string | null
  stock: number | null
  precio: number | null
  costo: number | null
  stockMinimo: number | null
  stockMaximo: number | null
  activo: boolean | null
  errores: string[]
}

/** Fila que se le devuelve al front en la vista previa. */
export interface FilaPrevia extends FilaImportada {
  estado: EstadoFila
  accion: 'CREAR' | 'ACTUALIZAR' | 'EXCLUIR'
  idProducto: number | null
  actual: ProductoExistente | null
  cambios: { campo: string; antes: unknown; despues: unknown }[]
  sugerencias: { idProducto: number; codigo: string; nombre: string; similitud: number }[]
}
