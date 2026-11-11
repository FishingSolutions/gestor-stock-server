// =====================================================================
// Constantes de la importación de productos desde Excel.
//
// La planilla esperada es:
//
//   | Codigo | Descripcion | Categoria | Stock | Precio |
//
// `Categoria` es opcional (el producto queda sin categoría) y también se
// aceptan nombres de columna alternativos por si el archivo viene de otro
// sistema (ver ALIAS). El orden de ALIAS importa: la primera coincidencia gana.
// =====================================================================

export const CAMPO = Object.freeze({
  CODIGO: 'codigo',
  NOMBRE: 'nombre',
  DESCRIPCION: 'descripcion',
  CATEGORIA: 'categoria',
  STOCK: 'stock',
  PRECIO: 'precio',
  COSTO: 'costo',
});

/** Título que se muestra en los mensajes de error. */
export const TITULOS = Object.freeze({
  [CAMPO.CODIGO]: 'Código',
  [CAMPO.NOMBRE]: 'Descripción',
  [CAMPO.DESCRIPCION]: 'Detalle',
  [CAMPO.CATEGORIA]: 'Categoría',
  [CAMPO.STOCK]: 'Stock',
  [CAMPO.PRECIO]: 'Precio',
  [CAMPO.COSTO]: 'Costo',
});

/** Alias aceptados para cada columna (se comparan sin acentos ni mayúsculas). */
export const ALIAS = Object.freeze({
  [CAMPO.CODIGO]: [
    'codigo',
    'cod',
    'cod producto',
    'codigo producto',
    'codigo de producto',
    'cod articulo',
    'codigo articulo',
    'sku',
  ],
  [CAMPO.NOMBRE]: [
    'nombre',
    'descripcion',
    'producto',
    'nombre producto',
    'descripcion producto',
    'denominacion',
  ],
  // "Detalle" es OPCIONAL: solo se toma si la planilla trae una columna aparte.
  // Si la planilla trae únicamente "Descripcion", ese texto va a `nombre`
  // (que es el campo obligatorio de la tabla producto).
  [CAMPO.DESCRIPCION]: [
    'detalle',
    'descripcion larga',
    'descripcion detallada',
    'observaciones',
    'notas',
  ],
  [CAMPO.CATEGORIA]: ['categoria', 'rubro', 'familia', 'grupo'],
  [CAMPO.STOCK]: [
    'stock',
    'stock actual',
    'cantidad',
    'existencias',
    'existencia',
    'unidades',
    'stock disponible',
  ],
  [CAMPO.PRECIO]: [
    'precio',
    'precio venta',
    'precio de venta',
    'pvp',
    'precio publico',
    'precio unitario',
    'importe',
  ],
  // Costo opcional: si no viene, el producto se crea con precio_costo = 0.
  [CAMPO.COSTO]: [
    'costo',
    'precio costo',
    'precio de costo',
    'precio compra',
    'precio de compra',
    'costo unitario',
  ],
});

/** Columnas sin las cuales no se puede importar. */
export const CAMPOS_REQUERIDOS = Object.freeze([
  CAMPO.CODIGO,
  CAMPO.NOMBRE,
  CAMPO.STOCK,
  CAMPO.PRECIO,
]);

/** Estados posibles de una importación. */
export const ESTADO_IMPORTACION = Object.freeze({
  COMPLETADA: 'COMPLETADA',
  COMPLETADA_CON_ERRORES: 'COMPLETADA_CON_ERRORES',
  RECHAZADA: 'RECHAZADA',
  FALLIDA: 'FALLIDA',
});

/** Límites alineados con el modelo de datos (ver supabase/migrations). */
export const LIMITES = Object.freeze({
  codigo: 50, // varchar(50)
  nombre: 150, // varchar(150)
  descripcion: 2000, // text, pero no tiene sentido guardar más desde una planilla
  categoria: 100, // varchar(100)
  stockMaximo: 2_147_483_647, // integer
  precioMaximo: 9_999_999_999.99, // numeric(12,2)
  // Cuántas filas del principio se revisan buscando el encabezado.
  filasParaBuscarEncabezado: 15,
});
