import './helpers/entorno.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ServicioImportacionProductos } from '../src/modules/productos/importacion/servicio.js';
import { ENCABEZADOS, crearLibro } from './helpers/excel.js';

function crearRepositorioFalso(opciones = {}) {
  const {
    codigosExistentes = [],
    categoriasExistentes = [],
    categoriasNuevas = [],
    fallarInsercion = null,
    fallarAuditoria = false,
    idAuditoria = 55,
  } = opciones;

  const llamadas = { insertar: [], codigos: [], auditoria: [], categorias: [] };

  return {
    llamadas,
    async buscarCodigosExistentes(codigos) {
      llamadas.codigos.push(codigos);
      const existentes = new Set(codigosExistentes.map((codigo) => codigo.toLowerCase()));
      return new Set(
        codigos.filter((codigo) => existentes.has(codigo.toLowerCase())).map((codigo) => codigo.toLowerCase()),
      );
    },
    async buscarCategoriasExistentes(nombres) {
      llamadas.categorias.push(nombres);
      const mapa = new Map();
      for (const nombre of nombres) {
        if (categoriasExistentes.includes(nombre.toLowerCase())) {
          mapa.set(nombre.toLowerCase(), `uuid-${nombre}`);
        }
      }
      return mapa;
    },
    async insertar(productos) {
      llamadas.insertar.push(productos);
      if (fallarInsercion) throw fallarInsercion;
      return {
        insertados: productos.map((producto, indice) => ({
          id_producto: String(101 + indice),
          codigo: producto.datos.codigo,
        })),
        categoriasNuevas,
      };
    },
    async registrarImportacion(registro) {
      llamadas.auditoria.push(registro);
      if (fallarAuditoria) throw new Error('la tabla de auditoría no está');
      return idAuditoria;
    },
    async historial() {
      return [];
    },
  };
}

function libroConFilas(filas) {
  return crearLibro([ENCABEZADOS, ...filas]);
}

const FILAS_OK = [
  ['P001', 'Teclado Logitech', 'Perifericos', 25, 15000],
  ['P002', 'Mouse Genius', 'Perifericos', 40, 8500],
];

test('importa todas las filas válidas y devuelve el resumen', async () => {
  const repositorio = crearRepositorioFalso();
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas(FILAS_OK),
    nombreArchivo: 'productos.xlsx',
    usuario: { id_usuario: '11111111-1111-1111-1111-111111111111' },
    tamanoBytes: 1234,
  });

  assert.equal(resultado.ok, true);
  assert.equal(resultado.estado, 'COMPLETADA');
  assert.equal(resultado.idImportacion, 55);
  assert.equal(resultado.archivo.nombre, 'productos.xlsx');
  assert.equal(resultado.archivo.hoja, 'Hoja1');

  assert.deepEqual(resultado.resumen, {
    registrosProcesados: 2,
    productosImportados: 2,
    registrosConError: 0,
    erroresEncontrados: 0,
    filasVacias: 0,
    categoriasNuevas: [],
  });

  assert.deepEqual(resultado.importados, [
    { fila: 2, codigo: 'P001', idProducto: 101 },
    { fila: 3, codigo: 'P002', idProducto: 102 },
  ]);
  assert.deepEqual(resultado.errores, []);

  // Se guardó una sola vez, con las dos filas juntas (misma transacción).
  assert.equal(repositorio.llamadas.insertar.length, 1);
  assert.equal(repositorio.llamadas.insertar[0].length, 2);

  const auditoria = repositorio.llamadas.auditoria[0];
  assert.equal(auditoria.estado, 'COMPLETADA');
  assert.equal(auditoria.productosImportados, 2);
  assert.equal(auditoria.idUsuario, '11111111-1111-1111-1111-111111111111');
});

test('importa las válidas y detalla las que tienen error', async () => {
  const repositorio = crearRepositorioFalso();
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas([
      ['P001', 'Teclado', 'Perifericos', 25, 15000],
      ['P002', 'Mouse', 'Perifericos', 40, 0],
      ['P003', 'Monitor', 'Perifericos', 10, 90000],
    ]),
    nombreArchivo: 'mixto.xlsx',
  });

  assert.equal(resultado.estado, 'COMPLETADA_CON_ERRORES');
  assert.equal(resultado.resumen.registrosProcesados, 3);
  assert.equal(resultado.resumen.productosImportados, 2);
  assert.equal(resultado.resumen.registrosConError, 1);
  assert.equal(resultado.resumen.erroresEncontrados, 1);
  assert.equal(resultado.errores[0].fila, 3);
  assert.equal(resultado.errores[0].codigo, 'P002');
  assert.match(resultado.errores[0].mensaje, /mayor que cero/);

  // Solo se insertaron las dos válidas.
  assert.deepEqual(
    repositorio.llamadas.insertar[0].map(({ datos }) => datos.codigo),
    ['P001', 'P003'],
  );
});

test('si no hay ninguna fila válida no toca la base y responde RECHAZADA', async () => {
  const repositorio = crearRepositorioFalso();
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas([
      ['', 'Sin código', 'Perifericos', 1, 100],
      ['P002', null, 'Perifericos', 1, 100],
    ]),
    nombreArchivo: 'todo-mal.xlsx',
  });

  assert.equal(resultado.estado, 'RECHAZADA');
  assert.equal(resultado.resumen.productosImportados, 0);
  assert.equal(resultado.resumen.registrosConError, 2);
  assert.equal(repositorio.llamadas.insertar.length, 0);
  assert.equal(repositorio.llamadas.auditoria[0].estado, 'RECHAZADA');
});

test('marca los códigos que ya existen en el sistema', async () => {
  const repositorio = crearRepositorioFalso({ codigosExistentes: ['P001'] });
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas(FILAS_OK),
    nombreArchivo: 'productos.xlsx',
  });

  assert.equal(resultado.resumen.productosImportados, 1);
  assert.equal(resultado.errores.length, 1);
  assert.match(resultado.errores[0].mensaje, /"P001" ya existe en el sistema/);
  assert.equal(resultado.errores[0].fila, 2);
  assert.equal(repositorio.llamadas.codigos[0].length, 2);
});

test('detecta duplicados dentro del mismo Excel y no los inserta dos veces', async () => {
  const repositorio = crearRepositorioFalso();
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas([
      ['P001', 'Teclado', 'Perifericos', 25, 15000],
      ['P001', 'Teclado repetido', 'Perifericos', 5, 15000],
    ]),
    nombreArchivo: 'duplicados.xlsx',
  });

  assert.equal(resultado.resumen.productosImportados, 1);
  assert.equal(resultado.resumen.erroresEncontrados, 1);
  assert.match(resultado.errores[0].mensaje, /repetido en el archivo/);
});

test('informa las categorías nuevas que creó', async () => {
  const repositorio = crearRepositorioFalso({ categoriasNuevas: ['Perifericos'] });
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas(FILAS_OK),
    nombreArchivo: 'productos.xlsx',
  });

  assert.deepEqual(resultado.resumen.categoriasNuevas, ['Perifericos']);
});

test('si no se crean categorías, avisa cuáles faltan y no inserta esa fila', async () => {
  const repositorio = crearRepositorioFalso({ categoriasExistentes: [] });
  const servicio = new ServicioImportacionProductos({
    repositorio,
    crearCategoriasFaltantes: false,
  });

  const resultado = await servicio.importar({
    buffer: libroConFilas([['P001', 'Teclado', 'Inexistente', 1, 100]]),
    nombreArchivo: 'productos.xlsx',
  });

  assert.equal(resultado.estado, 'RECHAZADA');
  assert.match(resultado.errores[0].mensaje, /La categoría "Inexistente" no existe/);
  assert.equal(repositorio.llamadas.insertar.length, 0);
});

test('cuenta las filas vacías sin contarlas como procesadas', async () => {
  const repositorio = crearRepositorioFalso();
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: crearLibro([ENCABEZADOS, FILAS_OK[0], [null, null, null, null, null], FILAS_OK[1]]),
    nombreArchivo: 'productos.xlsx',
  });

  assert.equal(resultado.resumen.registrosProcesados, 2);
  assert.equal(resultado.resumen.filasVacias, 1);
});

test('si falla la inserción, no se guarda nada y el error se propaga', async () => {
  const repositorio = crearRepositorioFalso({ fallarInsercion: new Error('boom de postgres') });
  const servicio = new ServicioImportacionProductos({ repositorio });

  await assert.rejects(
    () => servicio.importar({ buffer: libroConFilas(FILAS_OK), nombreArchivo: 'productos.xlsx' }),
    /boom de postgres/,
  );

  assert.equal(repositorio.llamadas.auditoria[0].estado, 'FALLIDA');
});

test('si falla la auditoría, la importación igual termina bien', async () => {
  const repositorio = crearRepositorioFalso({ fallarAuditoria: true });
  const servicio = new ServicioImportacionProductos({ repositorio });

  const resultado = await servicio.importar({
    buffer: libroConFilas(FILAS_OK),
    nombreArchivo: 'productos.xlsx',
  });

  assert.equal(resultado.estado, 'COMPLETADA');
  assert.equal(resultado.idImportacion, null);
});

test('un archivo ilegible se rechaza y queda registrado', async () => {
  const repositorio = crearRepositorioFalso();
  const servicio = new ServicioImportacionProductos({ repositorio });

  await assert.rejects(
    () => servicio.importar({ buffer: Buffer.from('no soy un excel'), nombreArchivo: 'roto.xlsx' }),
    (error) => {
      assert.equal(error.codigo, 'ARCHIVO_ILEGIBLE');
      assert.equal(error.estado, 422);
      return true;
    },
  );

  assert.equal(repositorio.llamadas.auditoria[0].estado, 'RECHAZADA');
  assert.equal(repositorio.llamadas.insertar.length, 0);
});
