// Lectura Excel para la Edge Function. La ruta común de lectura y validación
// vive en excel-reader.ts y recibe el parser para poder probarse con XLSX real.
import * as XLSX from 'npm:@e965/xlsx@0.20.3'
import { leerLibroConParser } from './excel-reader.ts'
import type { LecturaArchivo } from './tipos.ts'

export {
  ErrorArchivo,
  pareceExcel,
} from './excel-reader.ts'
export {
  LIMITES,
  normalizarEncabezado,
  normalizarTexto,
  paraMensaje,
  parsearNumero,
} from './texto.ts'
export type { Numero } from './texto.ts'

export function leerLibro(
  bytes: Uint8Array,
  nombreHoja: string | null,
  alias: Set<string>,
): Promise<LecturaArchivo> {
  return leerLibroConParser(bytes, nombreHoja, alias, XLSX)
}
