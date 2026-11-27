/**
 * Traductores de filas de Postgres (snake_case, numeric como string) al JSON
 * camelCase que ya consume el frontend.
 */

export function toProduct(row) {
  return {
    id: String(row.id_producto),
    codigo: row.codigo,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    idCategoria: row.id_categoria ?? null,
    categoria: row.categoria ?? 'Sin categoría',
    precioCosto: Number(row.precio_costo) || 0,
    precioVenta: Number(row.precio_venta) || 0,
    stockActual: Number(row.stock_actual) || 0,
    stockMinimo: Number(row.stock_minimo) || 0,
    stockMaximo: Number(row.stock_maximo) || 0,
    activo: row.activo !== false,
    fechaAlta: row.fecha_alta ?? null,
    estadoStock: row.estado_stock ?? null,
    prioridad: row.prioridad ?? null,
    valorCosto: Number(row.valor_costo) || 0,
    valorVenta: Number(row.valor_venta) || 0,
  }
}

export function toCategory(row) {
  return {
    id: row.id_categoria,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
  }
}

export function toMovement(row) {
  const nombre = row.usuario_nombre ?? null
  const apellido = row.usuario_apellido ?? null

  return {
    id: String(row.id_movimiento),
    idProducto: String(row.id_producto),
    codigo: row.codigo ?? null,
    producto: row.producto ?? null,
    tipo: row.tipo_movimiento,
    cantidad: Number(row.cantidad) || 0,
    variacion: Number(row.variacion) || 0,
    stockAnterior: Number(row.stock_anterior) || 0,
    stockResultante: Number(row.stock_resultante) || 0,
    motivo: row.motivo ?? '',
    fecha: row.fecha_movimiento,
    usuario: {
      id: row.id_usuario ?? null,
      nombre,
      apellido,
      nombreCompleto: [nombre, apellido].filter(Boolean).join(' ') || null,
    },
  }
}
