// =====================================================================
// Persistencia de la importación.
//
// Única capa que habla SQL. Recibe las dependencias por constructor para
// poder probarla sin base de datos.
//
// Decisiones importantes:
//   - Los productos válidos se insertan en UNA transacción: o entran todos o
//     no entra ninguno (nunca queda media planilla cargada).
//   - `ON CONFLICT (codigo) DO NOTHING`: si dos personas importan al mismo
//     tiempo y el código se crea en el medio, la fila se informa como error en
//     vez de abortar toda la importación.
//   - El stock inicial SE CARGA al crear el producto (es la misma regla que ya
//     usa la app al crear un producto a mano). No se genera movimiento.
//   - La auditoría es "best effort": si la tabla todavía no existe (migración
//     sin aplicar), la importación igual funciona.
// =====================================================================

import { config } from '../../../config/env.js';
import { conTransaccion as transaccionDb, consultar as consultarDb } from '../../../config/database.js';
import { loggerImportacion } from '../../../lib/logger.js';
import { claveCategoria } from './textos.js';

const COLUMNAS = Object.freeze([
  'codigo',
  'nombre',
  'descripcion',
  'precio_costo',
  'precio_venta',
  'stock_actual',
  'stock_minimo',
  'stock_maximo',
  'id_categoria',
  'activo',
]);

const SQL_INSERTAR_PRODUCTOS = `
  insert into public.producto (${COLUMNAS.join(', ')})
  values %VALUES%
  on conflict (codigo) do nothing
  returning id_producto, codigo
`;

const SQL_CATEGORIAS_EXISTENTES =
  "select id_categoria, nombre from public.categoria where lower(btrim(nombre)) = any($1::text[])";

function dividirEnLotes(elementos, tamano) {
  const lotes = [];
  for (let i = 0; i < elementos.length; i += tamano) lotes.push(elementos.slice(i, i + tamano));
  return lotes;
}

/** Arma el INSERT multi-fila y la lista de parámetros. */
function construirInsercion(productos, idsCategoria) {
  const valores = [];

  const tuplas = productos.map(({ datos }, indice) => {
    const idCategoria = datos.categoria
      ? (idsCategoria.get(claveCategoria(datos.categoria)) ?? null)
      : null;

    valores.push(
      datos.codigo,
      datos.nombre,
      datos.descripcion,
      datos.costo,
      datos.precio,
      datos.stock,
      0, // stock_minimo
      0, // stock_maximo
      idCategoria,
      true, // activo
    );

    const base = indice * COLUMNAS.length;
    const marcadores = COLUMNAS.map((_, posicion) => `$${base + posicion + 1}`);
    return `(${marcadores.join(', ')})`;
  });

  return { texto: SQL_INSERTAR_PRODUCTOS.replace('%VALUES%', tuplas.join(', ')), valores };
}

export class RepositorioImportacionProductos {
  constructor({
    consultar = consultarDb,
    conTransaccion = transaccionDb,
    loteInsercion = config.importacion.loteInsercion,
    auditar = true,
  } = {}) {
    this.consultar = consultar;
    this.conTransaccion = conTransaccion;
    this.loteInsercion = loteInsercion;
    this.auditar = auditar;
    // Se consulta una sola vez si existe la tabla de auditoría.
    this.auditoriaDisponible = null;
  }

  /**
   * Códigos que YA existen en la base.
   * @param {string[]} codigos
   * @param {{ sinMayusculas?: boolean }} [opciones]
   * @returns {Promise<Set<string>>} claves (en minúscula si sinMayusculas)
   */
  async buscarCodigosExistentes(codigos, { sinMayusculas = true } = {}) {
    const unicos = [...new Set(codigos.filter(Boolean))];
    if (unicos.length === 0) return new Set();

    const parametros = sinMayusculas ? unicos.map((codigo) => codigo.toLowerCase()) : unicos;
    const sql = sinMayusculas
      ? 'select codigo from public.producto where lower(btrim(codigo)) = any($1::text[])'
      : 'select codigo from public.producto where codigo = any($1::text[])';

    const { rows } = await this.consultar(sql, [parametros]);

    return new Set(rows.map((fila) => (sinMayusculas ? fila.codigo.toLowerCase() : fila.codigo)));
  }

  /**
   * Categorías existentes por nombre (comparación sin distinguir mayúsculas).
   * @param {string[]} nombres
   * @returns {Promise<Map<string, string>>} clave -> id_categoria
   */
  async buscarCategoriasExistentes(nombres, ejecutor = null) {
    const unicos = [...new Set(nombres.filter(Boolean))];
    if (unicos.length === 0) return new Map();

    const claves = [...new Set(unicos.map(claveCategoria))];
    const { rows } = ejecutor
      ? await ejecutor.query(SQL_CATEGORIAS_EXISTENTES, [claves])
      : await this.consultar(SQL_CATEGORIAS_EXISTENTES, [claves]);

    const mapa = new Map();
    for (const fila of rows) {
      const clave = claveCategoria(fila.nombre);
      if (!mapa.has(clave)) mapa.set(clave, fila.id_categoria);
    }

    return mapa;
  }

  /**
   * Inserta los productos válidos en una sola transacción.
   *
   * @param {{ fila: number, datos: object }[]} productos
   * @param {{ crearCategoriasFaltantes?: boolean }} [opciones]
   * @returns {Promise<{ insertados: { id_producto: string, codigo: string }[], categoriasNuevas: string[] }>}
   */
  async insertar(productos, { crearCategoriasFaltantes = config.importacion.crearCategoriasFaltantes } = {}) {
    return this.conTransaccion(async (cliente) => {
      const nombresCategoria = [...new Set(productos.map(({ datos }) => datos.categoria).filter(Boolean))];
      const idsCategoria = await this.buscarCategoriasExistentes(nombresCategoria, cliente);
      const categoriasNuevas = [];

      if (crearCategoriasFaltantes) {
        for (const nombre of nombresCategoria) {
          if (idsCategoria.has(claveCategoria(nombre))) continue;

          const { rows } = await cliente.query(
            `insert into public.categoria (nombre) values ($1)
             on conflict (nombre) do update set nombre = excluded.nombre
             returning id_categoria`,
            [nombre],
          );

          idsCategoria.set(claveCategoria(nombre), rows[0].id_categoria);
          categoriasNuevas.push(nombre);
        }
      }

      const insertados = [];

      for (const lote of dividirEnLotes(productos, this.loteInsercion)) {
        const { texto, valores } = construirInsercion(lote, idsCategoria);
        const { rows } = await cliente.query(texto, valores);
        insertados.push(...rows);
      }

      return { insertados, categoriasNuevas };
    });
  }

  /** ¿Existe la tabla de auditoría? Se cachea el resultado por instancia. */
  async hayAuditoria() {
    if (!this.auditar) return false;
    if (this.auditoriaDisponible !== null) return this.auditoriaDisponible;

    try {
      const { rows } = await this.consultar(
        "select to_regclass('public.importacion_producto') is not null as existe",
        [],
      );
      this.auditoriaDisponible = Boolean(rows[0]?.existe);
    } catch {
      this.auditoriaDisponible = false;
    }

    return this.auditoriaDisponible;
  }

  /**
   * Guarda el resumen de la importación para poder consultarlo después.
   * Nunca lanza: un problema de auditoría no puede romper una importación.
   *
   * @returns {Promise<number|null>} id de la importación
   */
  async registrarImportacion(registro) {
    if (!(await this.hayAuditoria())) return null;

    const {
      idUsuario = null,
      archivo = null,
      hoja = null,
      tamanoBytes = null,
      registrosProcesados = 0,
      filasVacias = 0,
      productosImportados = 0,
      registrosConError = 0,
      erroresEncontrados = 0,
      estado = 'FALLIDA',
      duracionMs = null,
      detalle = {},
      errores = [],
    } = registro;

    try {
      return await this.conTransaccion(async (cliente) => {
        const { rows } = await cliente.query(
          `insert into public.importacion_producto
             (id_usuario, archivo, hoja, tamano_bytes, filas_procesadas, filas_vacias,
              productos_importados, filas_con_error, errores_encontrados, estado, duracion_ms, detalle)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning id_importacion`,
          [
            idUsuario,
            archivo,
            hoja,
            tamanoBytes,
            registrosProcesados,
            filasVacias,
            productosImportados,
            registrosConError,
            erroresEncontrados,
            estado,
            duracionMs,
            JSON.stringify(detalle ?? {}),
          ],
        );

        const idImportacion = Number(rows[0].id_importacion);

        if (errores.length > 0) {
          const muestra = errores.slice(0, 1000);
          await cliente.query(
            `insert into public.importacion_producto_error (id_importacion, numero_fila, codigo, mensaje)
             select $1::bigint, * from unnest($2::int[], $3::text[], $4::text[])`,
            [
              idImportacion,
              muestra.map((error) => error.fila ?? null),
              muestra.map((error) => error.codigo ?? null),
              muestra.map((error) => error.mensaje ?? String(error)),
            ],
          );
        }

        return idImportacion;
      });
    } catch (error) {
      loggerImportacion.warn('No se pudo guardar la auditoría de la importación', { error });
      return null;
    }
  }

  /** Últimas importaciones (para la pantalla de historial). */
  async historial(limite = 10) {
    if (!(await this.hayAuditoria())) return null;

    const { rows } = await this.consultar(
      `select i.id_importacion, i.fecha, i.archivo, i.hoja, i.filas_procesadas,
              i.productos_importados, i.filas_con_error, i.errores_encontrados,
              i.filas_vacias, i.estado, i.duracion_ms,
              u.nombre || ' ' || u.apellido as usuario
         from public.importacion_producto i
         left join public.usuario u on u.id_usuario = i.id_usuario
        order by i.fecha desc
        limit $1`,
      [limite],
    );

    return rows.map((fila) => ({ ...fila, id_importacion: Number(fila.id_importacion) }));
  }
}
