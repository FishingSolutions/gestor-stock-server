// =====================================================================
// Controlador HTTP de la importación.
//
// Solo traduce HTTP <-> servicio: valida que venga el archivo, arma la
// entrada del servicio y responde. Nada de SQL ni de reglas de negocio.
// =====================================================================

import { BadRequestError } from '../../../lib/errors.js';
import { asyncHandler } from '../../../lib/async-handler.js';
import { nombreArchivoSeguro } from '../../../middleware/upload.js';
import { NOMBRE_PLANTILLA, generarPlantilla } from './plantilla.js';
import { ServicioImportacionProductos } from './servicio.js';

export function crearControladorImportacion({
  servicio = new ServicioImportacionProductos(),
} = {}) {
  return {
    /** POST /api/productos/importar (multipart/form-data, campo "archivo"). */
    importar: asyncHandler(async (req, res) => {
      const archivo = req.file;

      if (!archivo) {
        throw new BadRequestError('Adjuntá un archivo Excel en el campo "archivo" del formulario.', {
          codigo: 'ARCHIVO_FALTANTE',
        });
      }

      if (!archivo.buffer || archivo.buffer.length === 0) {
        throw new BadRequestError('El archivo está vacío.', { codigo: 'ARCHIVO_VACIO' });
      }

      const hojaSolicitada = (req.body?.hoja ?? req.query?.hoja ?? '').toString().trim();

      const resultado = await servicio.importar({
        buffer: archivo.buffer,
        nombreArchivo: nombreArchivoSeguro(archivo.originalname),
        hoja: hojaSolicitada === '' ? null : hojaSolicitada.slice(0, 100),
        usuario: req.usuario ?? null,
        tamanoBytes: archivo.size ?? archivo.buffer.length,
      });

      res.status(200).json(resultado);
    }),

    /** GET /api/productos/importar/plantilla */
    plantilla: asyncHandler(async (req, res) => {
      const buffer = generarPlantilla();

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${NOMBRE_PLANTILLA}"`);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(buffer);
    }),

    /** GET /api/productos/importar/historial?limite=10 */
    historial: asyncHandler(async (req, res) => {
      const pedido = Number.parseInt(req.query?.limite, 10);
      const limite = Number.isFinite(pedido) ? Math.min(Math.max(pedido, 1), 100) : 10;

      const resultado = await servicio.historial(limite);

      res.status(200).json({ ok: true, ...resultado });
    }),
  };
}
