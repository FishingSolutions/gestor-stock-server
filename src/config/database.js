// =====================================================================
// Acceso a PostgreSQL (pool + transacciones).
//
// Todo el módulo de importación recibe estas funciones por parámetro, así en
// las pruebas se pueden reemplazar sin tocar una base real (ver test/).
// =====================================================================

import pg from 'pg';
import { config } from './env.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

const { Pool } = pg;

let pool = null;

/** Crea (una sola vez) el pool de conexiones. */
export function obtenerPool() {
  if (pool) return pool;

  if (!config.baseDeDatos.url) {
    throw new AppError(
      'Falta configurar DATABASE_URL en el archivo .env: sin conexión a PostgreSQL no se pueden importar productos.',
      { codigo: 'BASE_DE_DATOS_SIN_CONFIGURAR', estado: 500 },
    );
  }

  pool = new Pool({
    connectionString: config.baseDeDatos.url,
    ssl: config.baseDeDatos.ssl,
    max: config.baseDeDatos.maximoConexiones,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.baseDeDatos.tiempoMaximoSentenciaMs,
    application_name: 'gestor-stock-server',
  });

  pool.on('error', (error) => {
    // Un cliente inactivo que se cae no tiene que tumbar el proceso.
    logger.error('Error inesperado en una conexión inactiva de PostgreSQL', { error });
  });

  return pool;
}

/**
 * Ejecuta una consulta suelta.
 * @param {string} texto SQL con placeholders ($1, $2...).
 * @param {unknown[]} [valores]
 */
export async function consultar(texto, valores = []) {
  return obtenerPool().query(texto, valores);
}

/**
 * Ejecuta `trabajo` dentro de una transacción: si algo falla se hace ROLLBACK
 * y no queda nada a medias. La función recibe el cliente para poder ejecutar
 * varias consultas con la misma conexión.
 *
 * @template T
 * @param {(cliente: import('pg').PoolClient) => Promise<T>} trabajo
 * @returns {Promise<T>}
 */
export async function conTransaccion(trabajo) {
  const cliente = await obtenerPool().connect();

  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    try {
      await cliente.query('ROLLBACK');
    } catch (errorRollback) {
      logger.error('No se pudo hacer ROLLBACK de la importación', { error: errorRollback });
    }
    throw error;
  } finally {
    cliente.release();
  }
}

/** Cierra el pool (ordenado en el apagado del servidor y en las pruebas). */
export async function cerrarPool() {
  if (!pool) return;
  const poolActual = pool;
  pool = null;
  await poolActual.end();
}
