// =====================================================================
// Logger propio (sin dependencias nuevas).
//
// Escribe líneas JSON (una por evento) a:
//   logs/app-AAAA-MM-DD.log            todo
//   logs/errores-AAAA-MM-DD.log        warn y error
//   logs/importaciones-AAAA-MM-DD.log  lo que pasa en una importación
//
// Si no se puede escribir a disco (permisos, disco lleno), sigue funcionando
// solo por consola: un fallo de logging nunca tiene que tumbar una petición.
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';

const NIVELES = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, silent: 99 });
const nivelConfigurado = NIVELES[config.logs.nivel] ?? NIVELES.info;

let directorioListo = false;
let avisoDirectorioMostrado = false;

function asegurarDirectorio() {
  if (directorioListo || !config.logs.aArchivo) return directorioListo;

  try {
    fs.mkdirSync(config.logs.dir, { recursive: true });
    directorioListo = true;
  } catch (error) {
    // Avisamos una sola vez por consola para no inundar la salida.
    if (!avisoDirectorioMostrado) {
      avisoDirectorioMostrado = true;
      console.warn(
        `[logger] No se pudo crear el directorio de logs "${config.logs.dir}": ${error.message}. Se sigue logueando por consola.`,
      );
    }
    directorioListo = false;
  }

  return directorioListo;
}

function fechaLocal(ahora) {
  // YYYY-MM-DD en hora local (no UTC), que es como se busca el archivo a mano.
  const desfase = ahora.getTimezoneOffset() * 60000;
  return new Date(ahora.getTime() - desfase).toISOString().slice(0, 10);
}

function escribir(nombreArchivo, linea) {
  if (!config.logs.aArchivo || !asegurarDirectorio()) return;

  fs.appendFile(path.join(config.logs.dir, nombreArchivo), `${linea}\n`, (error) => {
    if (error && !avisoDirectorioMostrado) {
      avisoDirectorioMostrado = true;
      console.warn(`[logger] No se pudo escribir el log de errores: ${error.message}`);
    }
  });
}

function serializarError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      nombre: error.name,
      mensaje: error.message,
      codigo: error.codigo,
      stack: error.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  return { mensaje: String(error) };
}

/**
 * @param {string} nivel
 * @param {string} mensaje
 * @param {object} [contexto]  Datos extra del evento (se agregan al JSON).
 */
function registrar(nivel, mensaje, contexto = {}) {
  if ((NIVELES[nivel] ?? NIVELES.info) > nivelConfigurado) return;

  const ahora = new Date();
  const evento = {
    fecha: ahora.toISOString(),
    nivel,
    mensaje,
    ...contexto,
  };

  if (evento.error instanceof Error) {
    evento.error = serializarError(evento.error);
  }

  const linea = JSON.stringify(evento);

  if (nivel === 'error') console.error(`[error] ${mensaje}`, contexto.error ?? '', contexto.importacion ?? '');
  else if (nivel === 'warn') console.warn(`[warn] ${mensaje}`, contexto.error ?? '');
  else if (nivel === 'info') console.log(`[info] ${mensaje}`);

  const sufijo = fechaLocal(ahora);
  escribir(`app-${sufijo}.log`, linea);
  if (nivel === 'error' || nivel === 'warn') escribir(`errores-${sufijo}.log`, linea);
  if (contexto.modulo === 'importacion') escribir(`importaciones-${sufijo}.log`, linea);
}

const base = {
  error: (mensaje, contexto) => registrar('error', mensaje, contexto),
  warn: (mensaje, contexto) => registrar('warn', mensaje, contexto),
  info: (mensaje, contexto) => registrar('info', mensaje, contexto),
  debug: (mensaje, contexto) => registrar('debug', mensaje, contexto),
  /** Logger con campos fijos (por ejemplo { modulo: 'importacion' }). */
  con: (camposFijos) => ({
    error: (mensaje, contexto) => registrar('error', mensaje, { ...camposFijos, ...contexto }),
    warn: (mensaje, contexto) => registrar('warn', mensaje, { ...camposFijos, ...contexto }),
    info: (mensaje, contexto) => registrar('info', mensaje, { ...camposFijos, ...contexto }),
    debug: (mensaje, contexto) => registrar('debug', mensaje, { ...camposFijos, ...contexto }),
  }),
};

export const logger = base;

export const loggerImportacion = base.con({ modulo: 'importacion' });
