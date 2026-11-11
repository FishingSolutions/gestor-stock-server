// =====================================================================
// Plantilla de Excel para descargar desde la interfaz.
//
// Trae las columnas exactas que espera el importador, dos filas de ejemplo y
// una hoja de instrucciones. Se genera al vuelo: no hay archivo binario en el
// repositorio (no se desactualiza).
// =====================================================================

import XLSX from 'xlsx';

export const NOMBRE_PLANTILLA = 'plantilla-importacion-productos.xlsx';

const ENCABEZADOS = ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio'];

const EJEMPLOS = [
  ['P001', 'Teclado Logitech', 'Perifericos', 25, 15000],
  ['P002', 'Mouse Genius', 'Perifericos', 40, 8500],
];

const INSTRUCCIONES = [
  ['Cómo completar la planilla'],
  [],
  ['1. No cambies los nombres de las columnas de la hoja "Productos".'],
  ['2. Cada fila es un producto. La fila 1 es el encabezado.'],
  ['3. Codigo: obligatorio, único, hasta 50 caracteres.'],
  ['4. Descripcion: obligatorio (es el nombre del producto), hasta 150 caracteres.'],
  ['5. Categoria: opcional. Si no existe, se crea.'],
  ['6. Stock: número entero, 0 o más.'],
  ['7. Precio: número mayor que cero.'],
  ['8. Las filas vacías se ignoran.'],
  ['9. Si un código está repetido en la planilla, o ya existe en el sistema, esa fila no se importa y se informa el error.'],
  [],
  ['Formatos de número aceptados: 15000 / 15.000 / 15.000,50 / 15,000.50'],
];

/**
 * @returns {Buffer} archivo .xlsx listo para enviar
 */
export function generarPlantilla() {
  const libro = XLSX.utils.book_new();

  const hojaProductos = XLSX.utils.aoa_to_sheet([ENCABEZADOS, ...EJEMPLOS]);
  hojaProductos['!cols'] = [
    { wch: 14 }, // Codigo
    { wch: 42 }, // Descripcion
    { wch: 22 }, // Categoria
    { wch: 10 }, // Stock
    { wch: 14 }, // Precio
  ];

  const hojaInstrucciones = XLSX.utils.aoa_to_sheet(INSTRUCCIONES);
  hojaInstrucciones['!cols'] = [{ wch: 100 }];

  XLSX.utils.book_append_sheet(libro, hojaProductos, 'Productos');
  XLSX.utils.book_append_sheet(libro, hojaInstrucciones, 'Instrucciones');

  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx', compression: true });
}
