// =====================================================================
// Subida del archivo Excel.
//
// Se guarda en memoria (no se escribe nada en disco): el archivo se lee, se
// valida y se descarta. Límites de tamaño y de partes para que un archivo
// enorme o un formulario raro no tumben el servidor.
// =====================================================================

import multer from 'multer';
import { config } from '../config/env.js';
import { BadRequestError, PayloadTooLargeError } from '../lib/errors.js';

const EXTENSIONES = new Set(['.xlsx', '.xls']);

// Algunos navegadores mandan un tipo genérico; la extensión es el control real.
const TIPOS_PERMITIDOS = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  '',
]);

export const CAMPO_ARCHIVO = 'archivo';

function extensionDe(nombreArchivo) {
  const punto = nombreArchivo.lastIndexOf('.');
  return punto === -1 ? '' : nombreArchivo.slice(punto).toLowerCase();
}

/** Nombre seguro para logs y mensajes (sin rutas ni caracteres de control). */
export function nombreArchivoSeguro(nombre) {
  if (typeof nombre !== 'string') return 'archivo';

  const base = nombre.split(/[\\/]/).pop() ?? 'archivo';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'archivo';
}

/**
 * @param {object} [opciones]
 * @param {number} [opciones.maxArchivoMb]
 * @param {string} [opciones.campo]
 */
export function crearMiddlewareSubida({
  maxArchivoMb = config.importacion.maxArchivoMb,
  campo = CAMPO_ARCHIVO,
} = {}) {
  const limiteBytes = maxArchivoMb * 1024 * 1024;

  const subida = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: limiteBytes,
      files: 1,
      fields: 5,
      fieldSize: 100 * 1024,
      parts: 10,
    },
    fileFilter(req, file, cb) {
      const extension = extensionDe(file.originalname ?? '');

      if (!EXTENSIONES.has(extension)) {
        return cb(
          new BadRequestError('El archivo tiene que ser de Excel (.xlsx o .xls).', {
            codigo: 'ARCHIVO_NO_EXCEL',
            detalles: { extensionRecibida: extension || null },
          }),
        );
      }

      if (!TIPOS_PERMITIDOS.has((file.mimetype ?? '').toLowerCase())) {
        return cb(
          new BadRequestError('El archivo no parece ser un Excel válido.', {
            codigo: 'TIPO_ARCHIVO_INVALIDO',
            detalles: { tipoRecibido: file.mimetype },
          }),
        );
      }

      cb(null, true);
    },
  });

  return function middleware(req, res, next) {
    subida.single(campo)(req, res, (error) => {
      if (!error) return next();

      // Mensaje propio cuando el archivo supera el máximo.
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(
          new PayloadTooLargeError(
            `El archivo supera el máximo permitido (${maxArchivoMb} MB). Dividilo en planillas más chicas.`,
            { detalles: { maxArchivoMb } },
          ),
        );
      }

      return next(error);
    });
  };
}
