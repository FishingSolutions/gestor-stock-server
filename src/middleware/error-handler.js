// =====================================================================
// Manejo central de errores.
//
// Todo error que llegue acá se transforma en una respuesta JSON con el mismo
// formato: { ok:false, error:{ codigo, mensaje, detalles }, requestId }.
// Los errores 5xx se loguean con stack; los 4xx como warn.
// =====================================================================

import multer from 'multer';
import { AppError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/env.js';

function desdeMulter(error) {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new AppError(`El archivo supera el máximo permitido (${config.importacion.maxArchivoMb} MB).`, {
        codigo: 'ARCHIVO_DEMASIADO_GRANDE',
        estado: 413,
      });
    case 'LIMIT_UNEXPECTED_FILE':
      return new AppError('El archivo tiene que ir en el campo "archivo" del formulario.', {
        codigo: 'CAMPO_ARCHIVO_INCORRECTO',
        estado: 400,
        detalles: { campoRecibido: error.field },
      });
    case 'LIMIT_FILE_COUNT':
      return new AppError('Mandá un solo archivo por importación.', {
        codigo: 'DEMASIADOS_ARCHIVOS',
        estado: 400,
      });
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return new AppError('El formulario tiene demasiados campos.', {
        codigo: 'FORMULARIO_INVALIDO',
        estado: 400,
      });
    default:
      return null;
  }
}

function desdePostgres(error) {
  switch (error.code) {
    case '23505':
      return new AppError('Ya existe un registro con ese dato único (por ejemplo, el código).', {
        codigo: 'REGISTRO_DUPLICADO',
        estado: 409,
        detalles: { restriccion: error.constraint ?? null },
      });
    case '23503':
      return new AppError('El registro hace referencia a un dato que no existe.', {
        codigo: 'REFERENCIA_INVALIDA',
        estado: 409,
      });
    case '23514':
      return new AppError('Un dato no cumple una regla de la base (por ejemplo, stock negativo).', {
        codigo: 'DATO_FUERA_DE_RANGO',
        estado: 422,
      });
    case '22P02':
      return new AppError('Alguno de los datos tiene un formato inválido.', {
        codigo: 'FORMATO_INVALIDO',
        estado: 400,
      });
    case '57014':
      return new AppError('La operación tardó demasiado y se canceló. Probá con menos filas.', {
        codigo: 'TIEMPO_AGOTADO',
        estado: 503,
      });
    default:
      return null;
  }
}

/** Convierte cualquier error en { estado, codigo, mensaje, detalles }. */
export function normalizarError(error) {
  if (error instanceof AppError) {
    return {
      estado: error.estado,
      codigo: error.codigo,
      mensaje: error.message,
      detalles: error.detalles ?? null,
    };
  }

  if (error instanceof multer.MulterError) {
    const traducido = desdeMulter(error);
    if (traducido) return normalizarError(traducido);
  }

  if (error && typeof error === 'object') {
    // express.json(): body inválido o demasiado grande.
    if (error.type === 'entity.parse.failed') {
      return {
        estado: 400,
        codigo: 'JSON_INVALIDO',
        mensaje: 'El cuerpo de la petición no es un JSON válido.',
        detalles: null,
      };
    }

    if (error.type === 'entity.too.large') {
      return {
        estado: 413,
        codigo: 'SOLICITUD_DEMASIADO_GRANDE',
        mensaje: 'La petición es demasiado grande.',
        detalles: null,
      };
    }

    if (typeof error.code === 'string') {
      const traducido = desdePostgres(error);
      if (traducido) return normalizarError(traducido);
    }
  }

  return {
    estado: 500,
    codigo: 'ERROR_INTERNO',
    mensaje: 'Ocurrió un error inesperado. El equipo técnico puede revisar el log con el id de la petición.',
    detalles: null,
  };
}

/** 404 para rutas que no existen. */
export function rutaNoEncontrada(req, res) {
  const error = new NotFoundError(`No existe la ruta ${req.method} ${req.originalUrl}.`, {
    codigo: 'RUTA_NO_ENCONTRADA',
  });

  res.status(404).json({
    ok: false,
    error: { codigo: error.codigo, mensaje: error.message, detalles: null },
    requestId: req.id ?? null,
  });
}

/** Manejador central. Express lo reconoce por los cuatro parámetros. */
// eslint-disable-next-line no-unused-vars
export function manejadorDeErrores(error, req, res, next) {
  if (res.headersSent) return next(error);

  const { estado, codigo, mensaje, detalles } = normalizarError(error);

  const contexto = {
    requestId: req.id ?? null,
    metodo: req.method,
    ruta: req.originalUrl,
    codigo,
    error,
  };

  if (estado >= 500) {
    logger.error('Error no controlado al procesar una petición', contexto);
  } else {
    logger.warn('Petición rechazada', { ...contexto, error: undefined, motivo: mensaje });
  }

  res.status(estado).json({
    ok: false,
    error: { codigo, mensaje, detalles },
    requestId: req.id ?? null,
  });
}
