// =====================================================================
// Genera los Excel de ejemplo para probar la importación.
//
//   node scripts/generar-ejemplos.mjs
//
// Deja dos archivos en docs/importar-productos/ejemplos/:
//   - productos-ejemplo.xlsx        todo válido (se importa completo)
//   - productos-con-errores.xlsx    mezcla de filas válidas y con errores
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const DESTINO = path.join(process.cwd(), 'docs', 'importar-productos', 'ejemplos');

const ENCABEZADOS = ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio'];

const VALIDOS = [
  ENCABEZADOS,
  ['P001', 'Teclado Logitech K120', 'Perifericos', 25, 15000],
  ['P002', 'Mouse Genius DX-110', 'Perifericos', 40, 8500],
  ['P003', 'Monitor Samsung 24"', 'Monitores', 12, 185000],
  ['P004', 'Notebook Lenovo IdeaPad', 'Notebooks', 5, 890000],
  ['P005', 'Auriculares HyperX Cloud', 'Audio', 18, 62000],
  ['P006', 'Webcam Logitech C920', 'Perifericos', 9, 78000],
  ['P007', 'Impresora HP LaserJet', 'Impresoras', 3, 245000],
  ['P008', 'Silla ergonómica', 'Muebles', 0, 132000],
];

// Cada fila de acá tiene un problema distinto, para ver el detalle del resumen.
const CON_ERRORES = [
  ENCABEZADOS,
  ['P001', 'Teclado Logitech K120', 'Perifericos', 25, 15000], // válido
  ['P002', 'Mouse Genius DX-110', 'Perifericos', -4, 8500], // stock negativo
  ['P003', 'Monitor Samsung 24"', 'Monitores', 12, 0], // precio 0
  ['P004', 'Notebook Lenovo', 'Notebooks', 5, 'consultar'], // precio no numérico
  [null, null, null, null, null], // fila vacía: se ignora
  ['P005', 'Auriculares HyperX', 'Audio', 18, 62000], // válido
  ['P005', 'Auriculares repetido', 'Audio', 2, 63000], // código duplicado
  ['', 'Producto sin código', 'Varios', 1, 1000], // falta el código
  ['P007', '', 'Impresoras', 3, 245000], // falta la descripción
  ['P008', 'Teclado con stock decimal', 'Perifericos', 2.5, 15000], // stock no entero
];

function crearLibro(filas) {
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(filas);
  hoja['!cols'] = [{ wch: 14 }, { wch: 38 }, { wch: 18 }, { wch: 10 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(libro, hoja, 'Productos');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx', compression: true });
}

fs.mkdirSync(DESTINO, { recursive: true });

const archivos = [
  ['productos-ejemplo.xlsx', VALIDOS],
  ['productos-con-errores.xlsx', CON_ERRORES],
];

for (const [nombre, filas] of archivos) {
  const ruta = path.join(DESTINO, nombre);
  fs.writeFileSync(ruta, crearLibro(filas));
  console.log(`Generado ${path.relative(process.cwd(), ruta)} (${filas.length - 1} filas)`);
}
