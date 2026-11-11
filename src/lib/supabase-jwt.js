// =====================================================================
// Validación del token de Supabase.
//
// El front inicia sesión con Supabase Auth y nos manda el access token en
// `Authorization: Bearer <token>`. Acá se verifica la firma y la vigencia:
//
//   - Proyectos nuevos: claves asimétricas (ES256/RS256), se validan con el
//     JWKS público del proyecto (SUPABASE_URL).
//   - Proyectos viejos: JWT firmado con HS256 y el secreto compartido
//     (SUPABASE_JWT_SECRET).
//
// Nunca se confía en el contenido del token sin verificarlo, ni en el rol que
// diga el token: el rol se lee de la tabla `usuario`.
// =====================================================================

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config/env.js';
import { AppError, UnauthorizedError } from '../lib/errors.js';

let jwks = null;
let secreto = null;

function obtenerJwks() {
  if (!config.supabase.url) return null;

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  return jwks;
}

function opcionesDeVerificacion() {
  const opciones = {
    audience: config.supabase.audience,
    clockTolerance: 30, // segundos de diferencia de reloj tolerados
  };

  if (config.supabase.url) {
    opciones.issuer = `${config.supabase.url}/auth/v1`;
  }

  return opciones;
}

/**
 * Verifica el token y devuelve sus claims.
 * @param {string} token
 * @returns {Promise<import('jose').JWTPayload>}
 */
export async function verificarTokenDeAcceso(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new UnauthorizedError('El token de sesión no tiene el formato esperado. Volvé a iniciar sesión.');
  }

  const problemas = [];
  const opciones = opcionesDeVerificacion();
  const jwksRemoto = obtenerJwks();

  if (jwksRemoto) {
    try {
      // Se restringe a algoritmos asimétricos: nunca HS256 contra un JWKS.
      const { payload } = await jwtVerify(token, jwksRemoto, {
        ...opciones,
        algorithms: ['ES256', 'RS256', 'EdDSA'],
      });
      return payload;
    } catch (error) {
      problemas.push(`JWKS: ${error.code ?? error.message}`);
    }
  }

  if (config.supabase.jwtSecret) {
    try {
      secreto ??= new TextEncoder().encode(config.supabase.jwtSecret);
      const { payload } = await jwtVerify(token, secreto, { ...opciones, algorithms: ['HS256'] });
      return payload;
    } catch (error) {
      problemas.push(`HS256: ${error.code ?? error.message}`);
    }
  }

  if (!jwksRemoto && !config.supabase.jwtSecret) {
    throw new AppError(
      'El servidor no está configurado para validar sesiones: falta SUPABASE_URL o SUPABASE_JWT_SECRET.',
      { codigo: 'CONFIGURACION_INCOMPLETA', estado: 500 },
    );
  }

  throw new UnauthorizedError('La sesión no es válida o venció. Volvé a iniciar sesión.', {
    codigo: 'TOKEN_INVALIDO',
    detalles: problemas,
  });
}
