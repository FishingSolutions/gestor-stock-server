// =====================================================================
// Validación de cada fila, antes de tocar la base.
//
// Reglas (las mismas que pide el sistema, alineadas con el modelo):
//   - Código obligatorio, máximo 50 caracteres y único en el archivo.
//   - Descripción obligatoria, máximo 150 caracteres.
//   - Stock numérico, entero y >= 0.
//   - Precio numérico y > 0.
//   - Categoría y detalle opcionales.
//   - Las filas vacías no llegan acá (las filtra el lector).
//
// No se corta en el primer error: se juntan TODOS los problemas de la fila
// para que el usuario pueda corregir la planilla de una sola vez.
// =====================================================================

import { config } from '../../../config/env.js';
import { LIMITES } from './constantes.js';
import { parsearNumero, redondear2 } from './numeros.js';
import { claveCodigo, normalizarTexto, paraMensaje } from './textos.js';

export class ValidadorImportacionProductos {
  constructor({ compararCodigoSinMayusculas = config.importacion.compararCodigoSinMayusculas } = {}) {
    this.compararCodigoSinMayusculas = compararCodigoSinMayusculas;
  }

  /**
   * @param {{ numeroFila: number, valores: Record<string, unknown> }[]} filas
   * @returns {{
   *   validas: { fila: number, datos: object }[],
   *   errores: { fila: number, codigo: string|null, campo: string, mensaje: string }[],
   *   registrosProcesados: number
   * }}
   */
  validar(filas) {
    const validas = [];
    const errores = [];
    const codigosVistos = new Map(); // clave del código -> primera fila donde aparece

    for (const fila of filas) {
      const { errores: erroresFila, datos } = this.validarFila(fila, codigosVistos);

      if (erroresFila.length > 0) errores.push(...erroresFila);
      else validas.push({ fila: fila.numeroFila, datos });
    }

    return { validas, errores, registrosProcesados: filas.length };
  }

  /**
   * Valida una fila. El mapa `codigosVistos` se actualiza aunque la fila tenga
   * otros errores: el duplicado se marca sobre la primera aparición.
   */
  validarFila(fila, codigosVistos = new Map()) {
    const errores = [];
    const numero = fila.numeroFila;
    const valores = fila.valores ?? {};

    const codigo = normalizarTexto(valores.codigo);

    const agregar = (campo, mensaje) => {
      errores.push({ fila: numero, codigo, campo, mensaje });
    };

    // --- Código -----------------------------------------------------
    if (!codigo) {
      agregar('codigo', 'El código es obligatorio.');
    } else {
      if (/[\u0000-\u001f\u007f]/.test(codigo)) {
        agregar('codigo', 'El código tiene caracteres no permitidos.');
      }

      if (codigo.length > LIMITES.codigo) {
        agregar(
          'codigo',
          `El código no puede superar los ${LIMITES.codigo} caracteres (tiene ${codigo.length}).`,
        );
      }

      const clave = claveCodigo(codigo, { sinMayusculas: this.compararCodigoSinMayusculas });

      if (codigosVistos.has(clave)) {
        agregar(
          'codigo',
          `El código "${codigo}" está repetido en el archivo (ya aparece en la fila ${codigosVistos.get(clave)}).`,
        );
      } else {
        codigosVistos.set(clave, numero);
      }
    }

    // --- Descripción (nombre del producto) ---------------------------
    const nombre = normalizarTexto(valores.nombre);

    if (!nombre) {
      agregar('nombre', 'La descripción es obligatoria.');
    } else if (nombre.length > LIMITES.nombre) {
      agregar(
        'nombre',
        `La descripción no puede superar los ${LIMITES.nombre} caracteres (tiene ${nombre.length}).`,
      );
    }

    // --- Detalle opcional -------------------------------------------
    const descripcion = normalizarTexto(valores.descripcion);

    if (descripcion && descripcion.length > LIMITES.descripcion) {
      agregar(
        'descripcion',
        `El detalle no puede superar los ${LIMITES.descripcion} caracteres (tiene ${descripcion.length}).`,
      );
    }

    // --- Categoría opcional -----------------------------------------
    const categoria = normalizarTexto(valores.categoria);

    if (categoria && categoria.length > LIMITES.categoria) {
      agregar(
        'categoria',
        `La categoría no puede superar los ${LIMITES.categoria} caracteres (tiene ${categoria.length}).`,
      );
    }

    // --- Stock -------------------------------------------------------
    const stock = parsearNumero(valores.stock);
    let stockValido = null;

    if (!stock.ok) {
      agregar(
        'stock',
        stock.motivo === 'vacío'
          ? 'El stock es obligatorio (0 o más).'
          : `El stock tiene que ser un número entero. Valor recibido: ${paraMensaje(valores.stock)}.`,
      );
    } else if (!Number.isInteger(stock.valor)) {
      agregar(
        'stock',
        `El stock tiene que ser un número entero, sin decimales. Valor recibido: ${paraMensaje(valores.stock)}.`,
      );
    } else if (stock.valor < 0) {
      agregar('stock', 'El stock no puede ser negativo.');
    } else if (stock.valor > LIMITES.stockMaximo) {
      agregar('stock', `El stock no puede superar ${LIMITES.stockMaximo}.`);
    } else {
      stockValido = stock.valor;
    }

    // --- Precio ------------------------------------------------------
    const precio = parsearNumero(valores.precio);
    let precioValido = null;

    if (!precio.ok) {
      agregar(
        'precio',
        precio.motivo === 'vacío'
          ? 'El precio es obligatorio.'
          : `El precio tiene que ser un número. Valor recibido: ${paraMensaje(valores.precio)}.`,
      );
    } else if (precio.valor <= 0) {
      agregar('precio', 'El precio tiene que ser mayor que cero.');
    } else if (precio.valor > LIMITES.precioMaximo) {
      agregar('precio', `El precio no puede superar ${LIMITES.precioMaximo}.`);
    } else {
      precioValido = redondear2(precio.valor);
    }

    // --- Costo opcional (si no viene, 0) -----------------------------
    let costoValido = 0;

    if (normalizarTexto(valores.costo) !== null) {
      const costo = parsearNumero(valores.costo);

      if (!costo.ok) {
        agregar(
          'costo',
          `El costo tiene que ser un número. Valor recibido: ${paraMensaje(valores.costo)}.`,
        );
      } else if (costo.valor < 0) {
        agregar('costo', 'El costo no puede ser negativo.');
      } else if (costo.valor > LIMITES.precioMaximo) {
        agregar('costo', `El costo no puede superar ${LIMITES.precioMaximo}.`);
      } else {
        costoValido = redondear2(costo.valor);
      }
    }

    if (errores.length > 0) return { errores, datos: null };

    return {
      errores,
      datos: {
        codigo,
        nombre,
        descripcion,
        categoria,
        stock: stockValido,
        precio: precioValido,
        costo: costoValido,
      },
    };
  }
}
