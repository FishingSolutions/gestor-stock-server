// =====================================================================
// Errores de la aplicación.
//
// La idea es que la capa de servicio/validación lance errores con un código
// estable (`codigo`), un mensaje ya en español listo para mostrar y el estado
// HTTP que corresponde. El manejador de errores los traduce a JSON y los
// errores inesperados quedan como 500 sin filtrar detalles internos.
// =====================================================================

export class AppError extends Error {
  /**
   * @param {string} mensaje  Mensaje en español, apto para mostrar al usuario.
   * @param {object} [opciones]
   * @param {string} [opciones.codigo]   Código estable para el front (ej.: ARCHIVO_NO_EXCEL).
   * @param {number} [opciones.estado]   Código HTTP (por defecto 500).
   * @param {unknown} [opciones.detalles] Información extra (nunca datos sensibles).
   * @param {Error} [opciones.causa]     Error original, solo para los logs.
   */
  constructor(mensaje, { codigo = 'ERROR_INTERNO', estado = 500, detalles = null, causa = null } = {}) {
    super(mensaje, causa ? { cause: causa } : undefined);
    this.name = new.target.name;
    this.codigo = codigo;
    this.estado = estado;
    this.detalles = detalles;
    this.esOperativo = true;
  }
}

/** 400: la petición está mal armada (falta el archivo, campo desconocido...). */
export class BadRequestError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'SOLICITUD_INVALIDA', estado: 400, ...opciones });
  }
}

/** 401: no hay sesión o el token no sirve. */
export class UnauthorizedError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'SIN_SESION', estado: 401, ...opciones });
  }
}

/** 403: hay sesión, pero el rol no alcanza. */
export class ForbiddenError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'SIN_PERMISO', estado: 403, ...opciones });
  }
}

/** 404: no existe el recurso. */
export class NotFoundError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'NO_ENCONTRADO', estado: 404, ...opciones });
  }
}

/** 409: choca con un dato que ya existe. */
export class ConflictError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'CONFLICTO', estado: 409, ...opciones });
  }
}

/** 422: el archivo o los datos no son válidos, pero la petición está bien armada. */
export class ValidationError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'DATOS_INVALIDOS', estado: 422, ...opciones });
  }
}

/** 413: el archivo supera el máximo permitido. */
export class PayloadTooLargeError extends AppError {
  constructor(mensaje, opciones = {}) {
    super(mensaje, { codigo: 'ARCHIVO_DEMASIADO_GRANDE', estado: 413, ...opciones });
  }
}
