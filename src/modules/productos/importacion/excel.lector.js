// =====================================================================
// Lectura del archivo Excel.
//
// Responsabilidad ÚNICA: convertir el buffer del archivo en filas con datos
// crudos y su número de fila real. Acá NO se valida el contenido de cada
// celda (eso es validador.js) ni se guarda nada (repositorio.js).
//
// Soporta .xlsx y .xls, elige la hoja principal (la primera, o la que pida el
// usuario) y tolera planillas con filas de título arriba del encabezado.
// =====================================================================

import XLSX from 'xlsx';
import { ALIAS, CAMPOS_REQUERIDOS, LIMITES, TITULOS } from './constantes.js';
import { normalizarEncabezado, normalizarTexto } from './textos.js';
import { ValidationError } from '../../../lib/errors.js';
import { config } from '../../../config/env.js';

/**
 * Alias -> campo, ya normalizados. Si un alias se repite, gana el primer
 * campo declarado en ALIAS (por eso `nombre` está antes que `descripcion`).
 */
const ALIAS_NORMALIZADOS = (() => {
  const mapa = new Map();

  for (const [campo, alias] of Object.entries(ALIAS)) {
    for (const nombre of alias) {
      const clave = normalizarEncabezado(nombre);
      if (clave && !mapa.has(clave)) mapa.set(clave, campo);
    }
  }

  return mapa;
})();

function esFilaVacia(celdas) {
  return !Array.isArray(celdas) || celdas.every((celda) => normalizarTexto(celda) === null);
}

/**
 * Firma del archivo. SheetJS es muy tolerante y "lee" un .txt como CSV; acá
 * solo aceptamos lo que de verdad es un Excel:
 *   - .xlsx / .xlsm: ZIP  -> 50 4B 03 04
 *   - .xls (BIFF8):  OLE2 -> D0 CF 11 E0 A1 B1 1A E1
 */
function pareceArchivoExcel(buffer) {
  if (buffer.length < 8) return false;

  const esZip =
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2]) &&
    [0x04, 0x06, 0x08].includes(buffer[3]);

  const esOle2 =
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1;

  return esZip || esOle2;
}

/** Busca la fila de encabezados: la que tiene más columnas reconocidas. */
function ubicarEncabezado(filasCrudas) {
  const limite = Math.min(filasCrudas.length, LIMITES.filasParaBuscarEncabezado);
  let mejor = null;

  for (let indice = 0; indice < limite; indice += 1) {
    const celdas = filasCrudas[indice] ?? [];
    const columnas = new Map();
    const encabezados = [];

    celdas.forEach((celda, columna) => {
      const titulo = normalizarTexto(celda);
      const campo = ALIAS_NORMALIZADOS.get(normalizarEncabezado(celda));

      if (campo && !columnas.has(campo)) {
        columnas.set(campo, columna);
        encabezados.push({ campo, columna, titulo: titulo ?? `Columna ${columna + 1}` });
      }
    });

    // Una fila con al menos dos columnas conocidas (y código entre ellas) es
    // el encabezado. Menos que eso es texto suelto.
    if (columnas.size >= 2 && columnas.has('codigo') && (!mejor || columnas.size > mejor.columnas.size)) {
      mejor = { indice, columnas, encabezados };
    }
  }

  return mejor;
}

function elegirHoja(libro, nombreHoja) {
  if (!nombreHoja) return libro.SheetNames[0];

  const buscada = normalizarEncabezado(nombreHoja);
  const encontrada = libro.SheetNames.find((nombre) => normalizarEncabezado(nombre) === buscada);

  if (!encontrada) {
    throw new ValidationError(`La hoja "${nombreHoja}" no existe en el archivo.`, {
      codigo: 'HOJA_INEXISTENTE',
      detalles: { hojasDisponibles: libro.SheetNames },
    });
  }

  return encontrada;
}

/**
 * @param {Buffer} buffer Contenido del archivo.
 * @param {object} [opciones]
 * @param {string} [opciones.nombreHoja] Hoja a leer (por defecto la primera).
 * @param {number} [opciones.maxFilas]
 */
export function leerExcel(buffer, { nombreHoja, maxFilas = config.importacion.maxFilas } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError('El archivo está vacío.', { codigo: 'ARCHIVO_VACIO' });
  }

  if (!pareceArchivoExcel(buffer)) {
    throw new ValidationError('El archivo no es un Excel válido (.xlsx o .xls).', {
      codigo: 'ARCHIVO_ILEGIBLE',
      detalles: { motivo: 'La firma del archivo no corresponde a un Excel.' },
    });
  }

  // Se corta la lectura un poco después del máximo de filas: alcanza para
  // avisar "son demasiadas" sin cargar un archivo enorme en memoria.
  const topeLectura = maxFilas + LIMITES.filasParaBuscarEncabezado + 1;

  let libro;
  try {
    libro = XLSX.read(buffer, {
      type: 'buffer',
      dense: true,
      cellDates: false,
      cellNF: false,
      cellText: false,
      sheetRows: topeLectura,
    });
  } catch (error) {
    throw new ValidationError(
      'No se pudo leer el archivo. Verificá que sea un Excel válido (.xlsx o .xls) y que no esté dañado o protegido con contraseña.',
      { codigo: 'ARCHIVO_ILEGIBLE', causa: error },
    );
  }

  if (!libro.SheetNames?.length) {
    throw new ValidationError('El archivo no tiene ninguna hoja de cálculo.', {
      codigo: 'ARCHIVO_SIN_HOJAS',
    });
  }

  const hojaElegida = elegirHoja(libro, nombreHoja);
  const hoja = libro.Sheets[hojaElegida];

  if (!hoja || !hoja['!ref']) {
    throw new ValidationError(`La hoja "${hojaElegida}" está vacía.`, {
      codigo: 'HOJA_VACIA',
      detalles: { hoja: hojaElegida },
    });
  }

  const rango = XLSX.utils.decode_range(hoja['!ref']);

  // blankrows:true mantiene la correspondencia entre índice y fila real.
  const filasCrudas = XLSX.utils.sheet_to_json(hoja, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });

  const encabezado = ubicarEncabezado(filasCrudas);

  if (!encabezado) {
    throw new ValidationError(
      `No se encontró la fila de encabezados. La planilla tiene que tener una fila con las columnas: ${CAMPOS_REQUERIDOS.map((campo) => TITULOS[campo]).join(', ')}.`,
      {
        codigo: 'ENCABEZADO_NO_ENCONTRADO',
        detalles: {
          columnasEsperadas: CAMPOS_REQUERIDOS.map((campo) => TITULOS[campo]),
          filasRevisadas: Math.min(filasCrudas.length, LIMITES.filasParaBuscarEncabezado),
        },
      },
    );
  }

  const faltantes = CAMPOS_REQUERIDOS.filter((campo) => !encabezado.columnas.has(campo));

  if (faltantes.length > 0) {
    throw new ValidationError(
      `A la planilla le falta${faltantes.length === 1 ? '' : 'n'} la${faltantes.length === 1 ? '' : 's'} columna${faltantes.length === 1 ? '' : 's'}: ${faltantes
        .map((campo) => TITULOS[campo])
        .join(', ')}.`,
      {
        codigo: 'COLUMNAS_FALTANTES',
        detalles: {
          faltantes: faltantes.map((campo) => ({ campo, titulo: TITULOS[campo] })),
          encontradas: encabezado.encabezados.map(({ titulo }) => titulo),
        },
      },
    );
  }

  const filas = [];
  let filasVacias = 0;

  for (let indice = encabezado.indice + 1; indice < filasCrudas.length; indice += 1) {
    const celdas = filasCrudas[indice] ?? [];

    if (esFilaVacia(celdas)) {
      filasVacias += 1;
      continue;
    }

    const valores = {};
    for (const [campo, columna] of encabezado.columnas) {
      valores[campo] = celdas[columna] ?? null;
    }

    filas.push({
      // Número de fila tal como se ve en Excel (la 1 es la primera de arriba).
      numeroFila: rango.s.r + indice + 1,
      valores,
    });
  }

  // El recorte de lectura puede haber escondido filas: si llegamos al tope,
  // avisamos que el archivo es más grande de lo permitido.
  const filasLeidas = rango.e.r - rango.s.r + 1;
  if (filas.length > maxFilas || (filasLeidas >= topeLectura && filas.length >= maxFilas)) {
    throw new ValidationError(
      `La planilla supera el máximo de ${maxFilas} filas por importación. Dividila en varios archivos más chicos.`,
      { codigo: 'DEMASIADAS_FILAS', detalles: { maxFilas, filasLeidas: filas.length } },
    );
  }

  if (filas.length === 0) {
    throw new ValidationError('La planilla no tiene filas con datos para importar.', {
      codigo: 'SIN_FILAS',
      detalles: { hoja: hojaElegida, filaEncabezado: rango.s.r + encabezado.indice + 1 },
    });
  }

  const columnasConocidas = new Set(encabezado.encabezados.map(({ columna }) => columna));
  const columnasIgnoradas = (filasCrudas[encabezado.indice] ?? [])
    .map((celda, columna) => ({ columna, titulo: normalizarTexto(celda) }))
    .filter(({ columna, titulo }) => titulo !== null && !columnasConocidas.has(columna))
    .map(({ titulo }) => titulo);

  return {
    hoja: hojaElegida,
    hojas: libro.SheetNames,
    encabezados: encabezado.encabezados.map(({ campo, titulo }) => ({ campo, titulo })),
    filaEncabezado: rango.s.r + encabezado.indice + 1,
    filas,
    filasVacias,
    columnasIgnoradas,
  };
}
