import XLSX from 'xlsx';

/** Crea un .xlsx (o .xls con tipo 'xls') en memoria a partir de una matriz de filas. */
export function crearLibro(filas, { nombreHoja = 'Hoja1', tipo = 'xlsx' } = {}) {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), nombreHoja);
  return XLSX.write(libro, {
    type: 'buffer',
    bookType: tipo === 'xls' ? 'biff8' : 'xlsx',
  });
}

/** Crea un .xlsx con varias hojas: { 'Hoja1': filas, 'Otra': filas }. */
export function crearLibroConHojas(hojas) {
  const libro = XLSX.utils.book_new();

  for (const [nombre, filas] of Object.entries(hojas)) {
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), nombre);
  }

  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

export const ENCABEZADOS = ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio'];
