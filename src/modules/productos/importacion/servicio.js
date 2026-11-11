// =====================================================================
// Servicio: orquesta la importación.
//
//   leer (excel.lector) -> validar (validador) -> chequear contra la base
//   (repositorio) -> guardar en transacción (repositorio) -> resumen + log
//
// No sabe nada de HTTP (eso es controlador.js) ni de SQL (repositorio.js).
// Todas las dependencias se pueden inyectar para probarla sin base de datos.
// =====================================================================

import { config } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';
import { loggerImportacion } from '../../../lib/logger.js';
import { ESTADO_IMPORTACION } from './constantes.js';
import { leerExcel } from './excel.lector.js';
import { RepositorioImportacionProductos } from './repositorio.js';
import { claveCategoria, claveCodigo } from './textos.js';
import { ValidadorImportacionProductos } from './validador.js';

/** bigint de Postgres: número si entra seguro en JS, si no string. */
function idProducto(valor) {
  const numero = Number(valor);
  return Number.isSafeInteger(numero) ? numero : String(valor);
}

export class ServicioImportacionProductos {
  constructor({
    lector = leerExcel,
    validador = new ValidadorImportacionProductos(),
    repositorio = new RepositorioImportacionProductos(),
    maxFilas = config.importacion.maxFilas,
    compararCodigoSinMayusculas = config.importacion.compararCodigoSinMayusculas,
    crearCategoriasFaltantes = config.importacion.crearCategoriasFaltantes,
    logger = loggerImportacion,
  } = {}) {
    this.lector = lector;
    this.validador = validador;
    this.repositorio = repositorio;
    this.maxFilas = maxFilas;
    this.compararCodigoSinMayusculas = compararCodigoSinMayusculas;
    this.crearCategoriasFaltantes = crearCategoriasFaltantes;
    this.logger = logger;
  }

  /**
   * @param {object} entrada
   * @param {Buffer} entrada.buffer
   * @param {string} entrada.nombreArchivo
   * @param {string} [entrada.hoja]
   * @param {{ id_usuario?: string|null }|null} [entrada.usuario]
   * @param {number} [entrada.tamanoBytes]
   */
  async importar({ buffer, nombreArchivo, hoja = null, usuario = null, tamanoBytes = null }) {
    const inicio = performance.now();
    const idUsuario = usuario?.id_usuario ?? null;
    const clave = (codigo) => claveCodigo(codigo, { sinMayusculas: this.compararCodigoSinMayusculas });

    let lectura = null;
    let registro = null;

    try {
      // 1) LEER ------------------------------------------------------
      lectura = this.lector(buffer, { nombreHoja: hoja, maxFilas: this.maxFilas });

      // 2) VALIDAR (reglas de la planilla) ---------------------------
      const validacion = this.validador.validar(lectura.filas);
      const errores = [...validacion.errores];

      // 3) VALIDAR CONTRA LA BASE: códigos que ya existen ------------
      const codigosExistentes = await this.repositorio.buscarCodigosExistentes(
        validacion.validas.map(({ datos }) => datos.codigo),
        { sinMayusculas: this.compararCodigoSinMayusculas },
      );

      let candidatos = [];

      for (const fila of validacion.validas) {
        if (codigosExistentes.has(clave(fila.datos.codigo))) {
          errores.push({
            fila: fila.fila,
            codigo: fila.datos.codigo,
            campo: 'codigo',
            mensaje: `El código "${fila.datos.codigo}" ya existe en el sistema.`,
          });
        } else {
          candidatos.push(fila);
        }
      }

      // 4) CATEGORÍAS: si no se crean solas, se avisa cuáles faltan ---
      if (!this.crearCategoriasFaltantes && candidatos.length > 0) {
        const nombres = [...new Set(candidatos.map(({ datos }) => datos.categoria).filter(Boolean))];
        const existentes = await this.repositorio.buscarCategoriasExistentes(nombres);

        candidatos = candidatos.filter((fila) => {
          if (!fila.datos.categoria) return true;
          if (existentes.has(claveCategoria(fila.datos.categoria))) return true;

          errores.push({
            fila: fila.fila,
            codigo: fila.datos.codigo,
            campo: 'categoria',
            mensaje: `La categoría "${fila.datos.categoria}" no existe.`,
          });
          return false;
        });
      }

      // 5) GUARDAR: solo los válidos, en una transacción -------------
      const importados = [];
      let categoriasNuevas = [];

      if (candidatos.length > 0) {
        const resultado = await this.repositorio.insertar(candidatos, {
          crearCategoriasFaltantes: this.crearCategoriasFaltantes,
        });

        categoriasNuevas = resultado.categoriasNuevas ?? [];

        const insertadosPorCodigo = new Map(
          resultado.insertados.map((fila) => [clave(fila.codigo), fila]),
        );

        for (const fila of candidatos) {
          const insertado = insertadosPorCodigo.get(clave(fila.datos.codigo));

          if (insertado) {
            importados.push({
              fila: fila.fila,
              codigo: fila.datos.codigo,
              idProducto: idProducto(insertado.id_producto),
            });
          } else {
            // ON CONFLICT DO NOTHING: alguien lo creó al mismo tiempo.
            errores.push({
              fila: fila.fila,
              codigo: fila.datos.codigo,
              campo: 'codigo',
              mensaje: `El código "${fila.datos.codigo}" ya existe en el sistema (se cargó al mismo tiempo).`,
            });
          }
        }
      }

      // 6) RESUMEN ---------------------------------------------------
      errores.sort((a, b) => a.fila - b.fila);

      const filasConError = new Set(errores.map((error) => error.fila)).size;
      const duracionMs = Math.round(performance.now() - inicio);
      const estado =
        importados.length === 0
          ? ESTADO_IMPORTACION.RECHAZADA
          : errores.length > 0
            ? ESTADO_IMPORTACION.COMPLETADA_CON_ERRORES
            : ESTADO_IMPORTACION.COMPLETADA;

      const resumen = {
        registrosProcesados: validacion.registrosProcesados,
        productosImportados: importados.length,
        registrosConError: filasConError,
        erroresEncontrados: errores.length,
        filasVacias: lectura.filasVacias,
        categoriasNuevas,
      };

      registro = {
        idUsuario,
        archivo: nombreArchivo ?? null,
        hoja: lectura.hoja,
        tamanoBytes: tamanoBytes ?? (Buffer.isBuffer(buffer) ? buffer.length : null),
        registrosProcesados: resumen.registrosProcesados,
        filasVacias: resumen.filasVacias,
        productosImportados: resumen.productosImportados,
        registrosConError: resumen.registrosConError,
        erroresEncontrados: resumen.erroresEncontrados,
        estado,
        duracionMs,
        detalle: {
          archivo: nombreArchivo ?? null,
          hojas: lectura.hojas,
          filaEncabezado: lectura.filaEncabezado,
          categoriasNuevas,
        },
        errores,
      };

      const idImportacion = await this._auditar(registro, duracionMs);

      this.logger.info('Importación de productos finalizada', {
        archivo: nombreArchivo,
        hoja: lectura.hoja,
        estado,
        duracionMs,
        idImportacion,
        ...resumen,
        errores: errores.slice(0, 20),
      });

      return {
        ok: true,
        estado,
        idImportacion,
        archivo: {
          nombre: nombreArchivo ?? null,
          tamanoBytes: registro.tamanoBytes,
          hoja: lectura.hoja,
          hojas: lectura.hojas,
          filaEncabezado: lectura.filaEncabezado,
          columnasIgnoradas: lectura.columnasIgnoradas,
        },
        fecha: new Date().toISOString(),
        duracionMs,
        resumen,
        importados,
        errores,
      };
    } catch (error) {
      const duracionMs = Math.round(performance.now() - inicio);

      // Un archivo ilegible también queda registrado (si hay auditoría).
      await this._auditar(
        {
          idUsuario,
          archivo: nombreArchivo ?? null,
          hoja: lectura?.hoja ?? hoja ?? null,
          tamanoBytes: tamanoBytes ?? (Buffer.isBuffer(buffer) ? buffer.length : null),
          estado: error instanceof AppError && error.estado < 500
            ? ESTADO_IMPORTACION.RECHAZADA
            : ESTADO_IMPORTACION.FALLIDA,
          duracionMs,
          detalle: { archivo: nombreArchivo ?? null, motivo: error.message },
          errores: [{ fila: null, codigo: null, mensaje: error.message }],
        },
        duracionMs,
      );

      this.logger.error('Falló una importación de productos', {
        archivo: nombreArchivo,
        hoja,
        duracionMs,
        error,
      });

      throw error;
    }
  }

  /** La auditoría nunca corta la importación. */
  async _auditar(registro, duracionMs) {
    try {
      return await this.repositorio.registrarImportacion({ ...registro, duracionMs });
    } catch (error) {
      this.logger.warn('No se pudo registrar la auditoría de la importación', { error });
      return null;
    }
  }

  /**
   * Últimas importaciones registradas.
   * @param {number} [limite]
   * @returns {Promise<{ disponible: boolean, importaciones: object[] }>}
   */
  async historial(limite = 10) {
    const importaciones = await this.repositorio.historial(limite);

    return {
      disponible: importaciones !== null,
      importaciones: importaciones ?? [],
    };
  }
}
