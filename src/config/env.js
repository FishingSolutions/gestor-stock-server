// =====================================================================
// Configuración centralizada.
//
// Toda la configuración se lee UNA sola vez desde las variables de entorno
// y se valida acá. Así el resto del código no toca `process.env` y, si falta
// algo o está mal escrito, el error aparece al arrancar y no en producción.
//
// Valores por defecto pensados para que el servidor siga arrancando igual
// que antes (sin .env): lo único obligatorio para importar es DATABASE_URL.
// =====================================================================

import 'dotenv/config';
import path from 'node:path';

/** Lee un entero del entorno, con mínimo y máximo. Falla al arrancar si no es válido. */
function entero(nombre, porDefecto, { minimo = 1, maximo = Number.MAX_SAFE_INTEGER } = {}) {
  const crudo = process.env[nombre];

  if (crudo === undefined || crudo.trim() === '') {
    return porDefecto;
  }

  const valor = Number(crudo);

  if (!Number.isInteger(valor) || valor < minimo || valor > maximo) {
    throw new Error(
      `La variable de entorno ${nombre} tiene que ser un número entero entre ${minimo} y ${maximo}. Valor recibido: "${crudo}".`,
    );
  }

  return valor;
}

/** Lee un booleano del entorno. Acepta true/false, 1/0, si/no. */
function booleano(nombre, porDefecto) {
  const crudo = process.env[nombre];

  if (crudo === undefined || crudo.trim() === '') {
    return porDefecto;
  }

  const normalizado = crudo.trim().toLowerCase();

  if (['true', '1', 'si', 'sí', 'yes'].includes(normalizado)) return true;
  if (['false', '0', 'no'].includes(normalizado)) return false;

  throw new Error(
    `La variable de entorno ${nombre} tiene que ser true o false. Valor recibido: "${crudo}".`,
  );
}

function texto(nombre, porDefecto = '') {
  const crudo = process.env[nombre];
  return crudo === undefined || crudo.trim() === '' ? porDefecto : crudo.trim();
}

export const config = Object.freeze({
  entorno: texto('NODE_ENV', 'development'),
  puerto: entero('PORT', 4000, { minimo: 1, maximo: 65535 }),

  baseDeDatos: Object.freeze({
    url: texto('DATABASE_URL'),
    // Supabase (pooler) exige SSL. rejectUnauthorized:false porque el pooler
    // usa un certificado propio; la conexión sigue cifrada.
    ssl: booleano('DB_SSL', false) ? { rejectUnauthorized: false } : false,
    tiempoMaximoSentenciaMs: entero('DB_STATEMENT_TIMEOUT_MS', 30000, { minimo: 1000 }),
    maximoConexiones: entero('DB_POOL_MAX', 10, { minimo: 1, maximo: 100 }),
  }),

  // Se usan para validar el token de Supabase (login del front).
  supabase: Object.freeze({
    url: texto('SUPABASE_URL').replace(/\/+$/, ''),
    jwtSecret: texto('SUPABASE_JWT_SECRET'),
    audience: texto('SUPABASE_JWT_AUDIENCE', 'authenticated'),
  }),

  importacion: Object.freeze({
    maxArchivoMb: entero('IMPORT_MAX_MB', 5, { minimo: 1, maximo: 50 }),
    maxFilas: entero('IMPORT_MAX_FILAS', 2000, { minimo: 1, maximo: 50000 }),
    loteInsercion: entero('IMPORT_LOTE_INSERCION', 500, { minimo: 1, maximo: 2000 }),
    // Solo para desarrollo/pruebas locales: deja el endpoint sin login.
    permitirSinAutenticacion: booleano('IMPORT_PERMITIR_SIN_AUTH', false),
    // "p001" y "P001" se consideran el mismo código al importar.
    compararCodigoSinMayusculas: booleano('IMPORT_CODIGO_SIN_MAYUSCULAS', true),
    // Si la categoría de la planilla no existe, se crea.
    crearCategoriasFaltantes: booleano('IMPORT_CREAR_CATEGORIAS', true),
  }),

  logs: Object.freeze({
    dir: texto('LOG_DIR', path.join(process.cwd(), 'logs')),
    nivel: texto('LOG_NIVEL', 'info').toLowerCase(),
    aArchivo: booleano('LOG_ARCHIVO', true),
  }),
});
