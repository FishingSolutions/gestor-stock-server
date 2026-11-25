// =====================================================================
// Lectura del inventario actual con la sesión del administrador.
//
// Se usa el cliente de Supabase del usuario (nunca la service_role): las
// políticas RLS siguen aplicándose. Solo se traen los campos que hacen
// falta para comparar.
// =====================================================================
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { ProductoExistente } from './tipos.ts'

const CAMPOS_PRODUCTO =
  'id_producto, codigo, nombre, descripcion, precio_costo, precio_venta, stock_actual, stock_minimo, stock_maximo, activo, id_categoria'
const PAGINA = 1000

export async function cargarProductos(supabase: SupabaseClient): Promise<ProductoExistente[]> {
  const filas: Record<string, unknown>[] = []
  let desde = 0

  while (true) {
    // Se excluyen los productos con borrado lógico. Si la base todavía no
    // tiene la columna `eliminado`, se reintenta sin el filtro.
    let consulta = supabase
      .from('producto')
      .select(`${CAMPOS_PRODUCTO}, eliminado`)
      .order('id_producto', { ascending: true })
      .range(desde, desde + PAGINA - 1)

    let { data, error } = await consulta

    if (error && /eliminado/i.test(error.message ?? '')) {
      const reintento = await supabase
        .from('producto')
        .select(CAMPOS_PRODUCTO)
        .order('id_producto', { ascending: true })
        .range(desde, desde + PAGINA - 1)
      data = reintento.data as typeof data
      error = reintento.error
    }

    if (error) throw new Error(`No se pudo leer el inventario: ${error.message}`)

    const lote = (data ?? []) as Record<string, unknown>[]
    filas.push(...lote)
    if (lote.length < PAGINA) break
    desde += PAGINA
  }

  const { data: categorias, error: errorCategorias } = await supabase
    .from('categoria')
    .select('id_categoria, nombre')

  if (errorCategorias) throw new Error(`No se pudieron leer las categorías: ${errorCategorias.message}`)

  const nombreCategoria = new Map(
    (categorias ?? []).map((c) => [String(c.id_categoria), String(c.nombre)]),
  )

  return filas
    .filter((fila) => fila.eliminado !== true)
    .map((fila) => ({
      idProducto: Number(fila.id_producto),
      codigo: String(fila.codigo ?? ''),
      nombre: String(fila.nombre ?? ''),
      descripcion: (fila.descripcion as string | null) ?? null,
      categoria: fila.id_categoria ? nombreCategoria.get(String(fila.id_categoria)) ?? null : null,
      idCategoria: fila.id_categoria ? String(fila.id_categoria) : null,
      stock: Number(fila.stock_actual) || 0,
      precio: Number(fila.precio_venta) || 0,
      costo: Number(fila.precio_costo) || 0,
      stockMinimo: Number(fila.stock_minimo) || 0,
      stockMaximo: Number(fila.stock_maximo) || 0,
      activo: fila.activo !== false,
    }))
}

/** Nombres de categoría existentes, normalizados, para detectar las nuevas. */
export async function cargarCategorias(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('categoria').select('nombre')
  if (error) throw new Error(`No se pudieron leer las categorías: ${error.message}`)

  return new Set((data ?? []).map((c) => String(c.nombre).trim().toLowerCase()))
}
