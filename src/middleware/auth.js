// =====================================================================
// Autorización: solo un ADMINISTRADOR activo puede importar productos.
//
// Es la misma regla que ya aplica RLS para crear productos. La escribimos
// también acá porque la importación entra a PostgreSQL con la cadena de
// conexión del servidor (que no pasa por RLS), así que el control de rol
// tiene que estar en el código.
// =====================================================================

import { config } from '../config/env.js';
import { consultar } from '../config/database.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { verificarTokenDeAcceso } from '../lib/supabase-jwt.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let avisoSinAutenticacionMostrado = false;

/** Saca el token del header `Authorization: Bearer ...`. */
export function extraerToken(req) {
  const encabezado = req.get('authorization');
  if (typeof encabezado !== 'string') return null;

  const [esquema, valor] = encabezado.split(' ');
  if (!valor || esquema.toLowerCase() !== 'bearer') return null;

  return valor.trim() || null;
}

/** Busca al usuario logueado en la tabla `usuario` (fuente de verdad del rol). */
export async function buscarUsuarioPorId(idUsuario, { consultarFn = consultar } = {}) {
  if (typeof idUsuario !== 'string' || !UUID.test(idUsuario)) return null;

  const { rows } = await consultarFn(
    'select id_usuario, nombre, apellido, email, rol, activo from public.usuario where id_usuario = $1',
    [idUsuario],
  );

  return rows[0] ?? null;
}

/**
 * Fábrica con dependencias inyectables (para las pruebas).
 *
 * @param {object} [deps]
 * @param {typeof verificarTokenDeAcceso} [deps.verificarToken]
 * @param {typeof buscarUsuarioPorId} [deps.buscarUsuario]
 */
export function crearRequiereAdministrador({
  verificarToken = verificarTokenDeAcceso,
  buscarUsuario = buscarUsuarioPorId,
} = {}) {
  return async function requiereAdministrador(req, res, next) {
    try {
      if (config.importacion.permitirSinAutenticacion) {
        req.usuario = { id_usuario: null, rol: 'ADMINISTRADOR', activo: true, sinAutenticacion: true };

        if (!avisoSinAutenticacionMostrado) {
          avisoSinAutenticacionMostrado = true;
          logger.warn(
            'La importación está corriendo SIN autenticación (IMPORT_PERMITIR_SIN_AUTH=true). Solo para desarrollo local.',
            { modulo: 'importacion' },
          );
        }

        return next();
      }

      const token = extraerToken(req);

      if (!token) {
        throw new UnauthorizedError('Tenés que iniciar sesión para importar productos.', {
          codigo: 'SIN_SESION',
        });
      }

      const claims = await verificarToken(token);
      const usuario = await buscarUsuario(claims.sub);

      if (!usuario || !usuario.activo) {
        throw new ForbiddenError(
          'No tenés permiso para importar productos (usuario sin cuenta o inactivo).',
          { codigo: 'USUARIO_INACTIVO' },
        );
      }

      if (usuario.rol !== 'ADMINISTRADOR') {
        throw new ForbiddenError('Solo un administrador puede importar productos.', {
          codigo: 'SOLO_ADMINISTRADOR',
        });
      }

      req.usuario = usuario;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Instancia lista para usar en las rutas. */
export const requiereAdministrador = crearRequiereAdministrador();
