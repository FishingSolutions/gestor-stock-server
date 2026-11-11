// =====================================================================
// Rutas de importación de productos.
//
// Se montan en server.js como  /api/productos/importar
//
//   POST /api/productos/importar            sube y procesa la planilla
//   GET  /api/productos/importar/plantilla  descarga la plantilla .xlsx
//   GET  /api/productos/importar/historial  últimas importaciones
//
// Las tres exigen sesión de ADMINISTRADOR (ver middleware/auth.js).
// =====================================================================

import { Router } from 'express';
import { requiereAdministrador } from '../../../middleware/auth.js';
import { crearMiddlewareSubida } from '../../../middleware/upload.js';
import { crearControladorImportacion } from './controlador.js';

/**
 * Fábrica con dependencias inyectables (para las pruebas HTTP).
 *
 * @param {object} [deps]
 * @param {import('express').RequestHandler} [deps.autenticar]
 * @param {ReturnType<typeof crearControladorImportacion>} [deps.controlador]
 * @param {number} [deps.maxArchivoMb]
 */
export function crearRutasImportacion({
  autenticar = requiereAdministrador,
  controlador = crearControladorImportacion(),
  maxArchivoMb,
} = {}) {
  const router = Router();
  const recibirArchivo = crearMiddlewareSubida({ maxArchivoMb });

  router.get('/plantilla', autenticar, controlador.plantilla);
  router.get('/historial', autenticar, controlador.historial);
  router.post('/', autenticar, recibirArchivo, controlador.importar);

  return router;
}

export default crearRutasImportacion();
