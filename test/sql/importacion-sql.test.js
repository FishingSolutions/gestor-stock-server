// =====================================================================
// Pruebas del SQL real del importador contra PostgreSQL (PGlite).
//
// No reemplazan a las pruebas contra Supabase, pero corren sin Docker y sin
// credenciales: validan la migración, las transacciones, el ON CONFLICT, la
// creación de categorías y la auditoría, todo con PostgreSQL de verdad.
// =====================================================================

import '../helpers/entorno.js';
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { RepositorioImportacionProductos } from '../../src/modules/productos/importacion/repositorio.js';
import { ServicioImportacionProductos } from '../../src/modules/productos/importacion/servicio.js';
import { ENCABEZADOS, crearLibro } from '../helpers/excel.js';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MIGRACION = path.join(RAIZ, 'supabase/migrations/20261111120000_importacion_productos.sql');
const ESQUEMA = path.join(RAIZ, 'test/sql/esquema-base.sql');

const ID_ADMIN = '11111111-1111-1111-1111-111111111111';

const loggerSilencioso = { error() {}, warn() {}, info() {}, debug() {} };

let db;
let repositorio;
let servicio;

function consultar(texto, valores = []) {
  return db.query(texto, valores);
}

function conTransaccion(trabajo) {
  return db.transaction((tx) => trabajo({ query: (texto, valores) => tx.query(texto, valores) }));
}

async function contar(sql, valores = []) {
  const { rows } = await db.query(sql, valores);
  return Number(Object.values(rows[0])[0]);
}

function libroConFilas(filas) {
  return crearLibro([ENCABEZADOS, ...filas]);
}

before(async () => {
  db = new PGlite();

  await db.exec(await readFile(ESQUEMA, 'utf8'));
  await db.exec(await readFile(MIGRACION, 'utf8'));

  repositorio = new RepositorioImportacionProductos({
    consultar,
    conTransaccion,
    loteInsercion: 2, // lotes chicos a propósito para probar la división
  });

  servicio = new ServicioImportacionProductos({ repositorio, logger: loggerSilencioso });
});

after(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate table public.importacion_producto_error,
                   public.importacion_producto,
                   public.producto,
                   public.categoria,
                   public.usuario
    restart identity cascade
  `);

  await db.query(
    `insert into public.usuario (id_usuario, nombre, apellido, email, rol, activo)
     values ($1, 'Ada', 'Admin', 'ada@stockfx.com', 'ADMINISTRADOR', true)`,
    [ID_ADMIN],
  );
});

test('la migración crea las tablas de auditoría y sus reglas de lectura', async () => {
  assert.equal(await contar("select count(*) from pg_tables where schemaname = 'public' and tablename like 'importacion%'"), 2);
  assert.equal(await contar("select count(*) from pg_policies where schemaname = 'public' and tablename like 'importacion%'"), 2);
  assert.equal(await contar("select relrowsecurity::int from pg_class where relname = 'importacion_producto'"), 1);
});

test('importa contra PostgreSQL, crea la categoría y guarda la auditoría', async () => {
  const resultado = await servicio.importar({
    buffer: libroConFilas([
      ['P001', 'Teclado Logitech', 'Perifericos', 25, 15000],
      ['P002', 'Mouse Genius', 'Perifericos', 40, 8500],
      ['P003', 'Monitor roto', 'Perifericos', 3, 0],
    ]),
    nombreArchivo: 'productos.xlsx',
    usuario: { id_usuario: ID_ADMIN },
    tamanoBytes: 2048,
  });

  assert.equal(resultado.estado, 'COMPLETADA_CON_ERRORES');
  assert.equal(resultado.resumen.productosImportados, 2);
  assert.equal(resultado.resumen.registrosConError, 1);
  assert.deepEqual(resultado.resumen.categoriasNuevas, ['Perifericos']);
  assert.ok(resultado.idImportacion > 0);

  // Los dos productos válidos quedaron en la base, con su categoría.
  const { rows: productos } = await db.query(
    `select p.codigo, p.nombre, p.precio_venta::text as precio, p.stock_actual, p.activo,
            p.fecha_alta is not null as con_fecha, c.nombre as categoria
       from public.producto p
       left join public.categoria c on c.id_categoria = p.id_categoria
      order by p.codigo`,
  );

  assert.equal(productos.length, 2);
  assert.equal(productos[0].codigo, 'P001');
  assert.equal(productos[0].precio, '15000.00');
  assert.equal(productos[0].stock_actual, 25);
  assert.equal(productos[0].activo, true);
  assert.equal(productos[0].con_fecha, true);
  assert.equal(productos[0].categoria, 'Perifericos');
  assert.equal(await contar('select count(*) from public.categoria'), 1);

  // Auditoría: resumen + detalle del error.
  const { rows: auditorias } = await db.query(
    `select estado, filas_procesadas, productos_importados, filas_con_error,
            errores_encontrados, filas_vacias, archivo, hoja, detalle
       from public.importacion_producto`,
  );

  assert.equal(auditorias.length, 1);
  assert.equal(auditorias[0].estado, 'COMPLETADA_CON_ERRORES');
  assert.equal(auditorias[0].filas_procesadas, 3);
  assert.equal(auditorias[0].productos_importados, 2);
  assert.equal(auditorias[0].filas_con_error, 1);
  assert.equal(auditorias[0].errores_encontrados, 1);
  assert.equal(auditorias[0].archivo, 'productos.xlsx');
  assert.equal(auditorias[0].hoja, 'Hoja1');
  assert.deepEqual(auditorias[0].detalle.categoriasNuevas, ['Perifericos']);

  const { rows: errores } = await db.query(
    'select numero_fila, codigo, mensaje from public.importacion_producto_error',
  );

  assert.equal(errores.length, 1);
  assert.equal(errores[0].numero_fila, 4);
  assert.equal(errores[0].codigo, 'P003');
  assert.match(errores[0].mensaje, /mayor que cero/);
});

test('reutiliza la categoría existente sin distinguir mayúsculas', async () => {
  await db.query("insert into public.categoria (nombre) values ('PERIFERICOS')");

  const resultado = await servicio.importar({
    buffer: libroConFilas([['P001', 'Teclado', 'Perifericos', 1, 100]]),
    nombreArchivo: 'productos.xlsx',
  });

  assert.equal(resultado.estado, 'COMPLETADA');
  assert.deepEqual(resultado.resumen.categoriasNuevas, []);
  assert.equal(await contar('select count(*) from public.categoria'), 1);
  assert.equal(
    await contar('select count(*) from public.producto p join public.categoria c using (id_categoria)'),
    1,
  );
});

test('la segunda importación del mismo archivo queda rechazada por códigos existentes', async () => {
  const buffer = libroConFilas([['P001', 'Teclado', 'Perifericos', 1, 100]]);

  const primera = await servicio.importar({ buffer, nombreArchivo: 'uno.xlsx' });
  const segunda = await servicio.importar({ buffer, nombreArchivo: 'dos.xlsx' });

  assert.equal(primera.estado, 'COMPLETADA');
  assert.equal(segunda.estado, 'RECHAZADA');
  assert.match(segunda.errores[0].mensaje, /ya existe en el sistema/);
  assert.equal(await contar('select count(*) from public.producto'), 1);
  assert.equal(await contar('select count(*) from public.importacion_producto'), 2);
});

test('si una fila falla en la base, la transacción no guarda NINGUNA', async () => {
  await db.exec(`
    create function public.romper_importacion() returns trigger
    language plpgsql as $$
    begin
      if new.codigo = 'ROMPE' then
        raise exception 'falla forzada en la prueba';
      end if;
      return new;
    end $$;

    create trigger romper_importacion
      before insert on public.producto
      for each row execute function public.romper_importacion();
  `);

  try {
    await assert.rejects(
      () =>
        servicio.importar({
          buffer: libroConFilas([
            ['P100', 'Producto bueno', 'Categoria nueva', 5, 1000],
            ['ROMPE', 'Producto malo', 'Categoria nueva', 5, 1000],
          ]),
          nombreArchivo: 'rollback.xlsx',
        }),
      /falla forzada en la prueba/,
    );

    assert.equal(await contar('select count(*) from public.producto'), 0);
    assert.equal(await contar('select count(*) from public.categoria'), 0);
    assert.equal(await contar("select count(*) from public.importacion_producto where estado = 'FALLIDA'"), 1);
  } finally {
    await db.exec('drop trigger if exists romper_importacion on public.producto; drop function if exists public.romper_importacion();');
  }

  // Se puede volver a importar sin el trigger.
  const despues = await servicio.importar({
    buffer: libroConFilas([['P100', 'Producto bueno', 'Categoria nueva', 5, 1000]]),
    nombreArchivo: 'rollback.xlsx',
  });

  assert.equal(despues.estado, 'COMPLETADA');
});

test('inserta en varios lotes sin perder filas', async () => {
  const filas = Array.from({ length: 5 }, (_, indice) => [
    `P10${indice}`,
    `Producto ${indice}`,
    'Perifericos',
    indice,
    100 * (indice + 1),
  ]);

  const resultado = await servicio.importar({
    buffer: libroConFilas(filas),
    nombreArchivo: 'lotes.xlsx',
  });

  assert.equal(resultado.estado, 'COMPLETADA');
  assert.equal(resultado.resumen.productosImportados, 5);
  assert.equal(await contar('select count(*) from public.producto'), 5);
});

test('ON CONFLICT DO NOTHING evita romper la importación si el código apareció en el medio', async () => {
  await db.query(
    `insert into public.producto (codigo, nombre, precio_venta, stock_actual)
     values ('P001', 'Ya estaba', 100, 1)`,
  );

  const { insertados, categoriasNuevas } = await repositorio.insertar([
    {
      fila: 2,
      datos: {
        codigo: 'P001',
        nombre: 'Duplicado concurrente',
        descripcion: null,
        categoria: null,
        stock: 1,
        precio: 100,
        costo: 0,
      },
    },
  ]);

  assert.deepEqual(insertados, []);
  assert.deepEqual(categoriasNuevas, []);
  assert.equal(await contar('select count(*) from public.producto'), 1);
});

test('el historial devuelve las importaciones con el usuario que las hizo', async () => {
  await servicio.importar({
    buffer: libroConFilas([['P001', 'Teclado', 'Perifericos', 1, 100]]),
    nombreArchivo: 'historial.xlsx',
    usuario: { id_usuario: ID_ADMIN },
  });

  const historial = await servicio.historial(5);

  assert.equal(historial.disponible, true);
  assert.equal(historial.importaciones.length, 1);
  assert.equal(historial.importaciones[0].archivo, 'historial.xlsx');
  assert.equal(historial.importaciones[0].estado, 'COMPLETADA');
  assert.equal(historial.importaciones[0].usuario, 'Ada Admin');
  assert.equal(typeof historial.importaciones[0].id_importacion, 'number');
});
