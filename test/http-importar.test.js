import './helpers/entorno.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import XLSX from 'xlsx';

import { crearRutasImportacion } from '../src/modules/productos/importacion/rutas.js';
import { crearControladorImportacion } from '../src/modules/productos/importacion/controlador.js';
import { manejadorDeErrores } from '../src/middleware/error-handler.js';
import { requestId } from '../src/middleware/request-id.js';
import { generarPlantilla } from '../src/modules/productos/importacion/plantilla.js';
import { ValidationError } from '../src/lib/errors.js';

const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function crearServicioFalso(resultadoExtra = {}) {
  return {
    llamadas: [],
    async importar(entrada) {
      this.llamadas.push(entrada);

      return {
        ok: true,
        estado: 'COMPLETADA',
        idImportacion: 9,
        archivo: { nombre: entrada.nombreArchivo },
        resumen: {
          registrosProcesados: 1,
          productosImportados: 1,
          registrosConError: 0,
          erroresEncontrados: 0,
          filasVacias: 0,
          categoriasNuevas: [],
        },
        importados: [{ fila: 2, codigo: 'P001', idProducto: 1 }],
        errores: [],
        ...resultadoExtra,
      };
    },
    async historial(limite) {
      return { disponible: true, importaciones: [{ id_importacion: 1, limite }] };
    },
  };
}

/** Levanta la app en un puerto libre y devuelve helpers para pegarle. */
async function levantar({ autenticar, servicio, maxArchivoMb } = {}) {
  const app = express();
  app.use(requestId);
  app.use(
    '/api/productos/importar',
    crearRutasImportacion({
      autenticar:
        autenticar ??
        ((req, res, next) => {
          req.usuario = { id_usuario: null, rol: 'ADMINISTRADOR' };
          next();
        }),
      controlador: crearControladorImportacion({ servicio }),
      maxArchivoMb,
    }),
  );
  app.use(manejadorDeErrores);

  const servidor = app.listen(0);
  await new Promise((resolver) => servidor.once('listening', resolver));

  const { port } = servidor.address();

  return {
    url: `http://127.0.0.1:${port}/api/productos/importar`,
    cerrar: () => new Promise((resolver) => servidor.close(resolver)),
  };
}

function formularioConArchivo(buffer, nombre = 'productos.xlsx', tipo = TIPO_XLSX) {
  const datos = new FormData();
  datos.append('archivo', new Blob([buffer], { type: tipo }), nombre);
  return datos;
}

test('POST con un Excel devuelve el resumen y le pasa el archivo al servicio', async () => {
  const servicio = crearServicioFalso();
  const app = await levantar({ servicio });

  try {
    const datos = formularioConArchivo(Buffer.from('contenido de prueba'));
    datos.append('hoja', 'Productos');

    const respuesta = await fetch(app.url, { method: 'POST', body: datos });
    const cuerpo = await respuesta.json();

    assert.equal(respuesta.status, 200);
    assert.equal(cuerpo.estado, 'COMPLETADA');
    assert.equal(cuerpo.resumen.productosImportados, 1);
    assert.equal(respuesta.headers.get('x-request-id')?.length > 0, true);

    assert.equal(servicio.llamadas.length, 1);
    assert.equal(servicio.llamadas[0].nombreArchivo, 'productos.xlsx');
    assert.equal(servicio.llamadas[0].hoja, 'Productos');
    assert.ok(Buffer.isBuffer(servicio.llamadas[0].buffer));
    assert.equal(servicio.llamadas[0].buffer.toString(), 'contenido de prueba');
  } finally {
    await app.cerrar();
  }
});

test('POST sin archivo responde 400 con un mensaje claro', async () => {
  const app = await levantar({ servicio: crearServicioFalso() });

  try {
    const respuesta = await fetch(app.url, { method: 'POST', body: new FormData() });
    const cuerpo = await respuesta.json();

    assert.equal(respuesta.status, 400);
    assert.equal(cuerpo.ok, false);
    assert.equal(cuerpo.error.codigo, 'ARCHIVO_FALTANTE');
    assert.match(cuerpo.error.mensaje, /Adjuntá un archivo Excel/);
    assert.ok(cuerpo.requestId);
  } finally {
    await app.cerrar();
  }
});

test('POST con un archivo que no es Excel responde 400', async () => {
  const app = await levantar({ servicio: crearServicioFalso() });

  try {
    const datos = formularioConArchivo(Buffer.from('hola'), 'productos.txt', 'text/plain');
    const respuesta = await fetch(app.url, { method: 'POST', body: datos });
    const cuerpo = await respuesta.json();

    assert.equal(respuesta.status, 400);
    assert.equal(cuerpo.error.codigo, 'ARCHIVO_NO_EXCEL');
  } finally {
    await app.cerrar();
  }
});

test('POST con un archivo más grande que el máximo responde 413', async () => {
  const app = await levantar({ servicio: crearServicioFalso(), maxArchivoMb: 1 });

  try {
    const grande = Buffer.alloc(1.5 * 1024 * 1024, 1);
    const respuesta = await fetch(app.url, { method: 'POST', body: formularioConArchivo(grande) });
    const cuerpo = await respuesta.json();

    assert.equal(respuesta.status, 413);
    assert.equal(cuerpo.error.codigo, 'ARCHIVO_DEMASIADO_GRANDE');
  } finally {
    await app.cerrar();
  }
});

test('un error de negocio se responde con el formato estándar', async () => {
  const servicio = {
    async importar() {
      throw new ValidationError('El archivo está vacío.', { codigo: 'ARCHIVO_VACIO' });
    },
    async historial() {
      return { disponible: true, importaciones: [] };
    },
  };

  const app = await levantar({ servicio });

  try {
    const respuesta = await fetch(app.url, {
      method: 'POST',
      body: formularioConArchivo(Buffer.from('x')),
    });
    const cuerpo = await respuesta.json();

    assert.equal(respuesta.status, 422);
    assert.equal(cuerpo.ok, false);
    assert.equal(cuerpo.error.codigo, 'ARCHIVO_VACIO');
    assert.equal(cuerpo.error.mensaje, 'El archivo está vacío.');
    assert.ok(cuerpo.requestId);
  } finally {
    await app.cerrar();
  }
});

test('sin permiso no se procesa el archivo', async () => {
  const servicio = crearServicioFalso();
  const autenticar = (req, res) =>
    res.status(403).json({ ok: false, error: { codigo: 'SOLO_ADMINISTRADOR', mensaje: 'Solo un administrador' } });

  const app = await levantar({ servicio, autenticar });

  try {
    const respuesta = await fetch(app.url, {
      method: 'POST',
      body: formularioConArchivo(Buffer.from('x')),
    });

    assert.equal(respuesta.status, 403);
    assert.equal(servicio.llamadas.length, 0);
  } finally {
    await app.cerrar();
  }
});

test('GET /plantilla descarga un Excel con las columnas esperadas', async () => {
  const app = await levantar({ servicio: crearServicioFalso() });

  try {
    const respuesta = await fetch(`${app.url}/plantilla`);
    const buffer = Buffer.from(await respuesta.arrayBuffer());

    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers.get('content-type'), /spreadsheetml/);
    assert.match(respuesta.headers.get('content-disposition'), /plantilla-importacion-productos\.xlsx/);

    const libro = XLSX.read(buffer, { type: 'buffer' });
    const filas = XLSX.utils.sheet_to_json(libro.Sheets.Productos, { header: 1 });

    assert.deepEqual(filas[0], ['Codigo', 'Descripcion', 'Categoria', 'Stock', 'Precio']);
    assert.equal(filas.length, 3);
    assert.deepEqual(libro.SheetNames, ['Productos', 'Instrucciones']);
  } finally {
    await app.cerrar();
  }
});

test('GET /historial devuelve las últimas importaciones', async () => {
  const app = await levantar({ servicio: crearServicioFalso() });

  try {
    const respuesta = await fetch(`${app.url}/historial?limite=5`);
    const cuerpo = await respuesta.json();

    assert.equal(respuesta.status, 200);
    assert.equal(cuerpo.ok, true);
    assert.equal(cuerpo.disponible, true);
    assert.equal(cuerpo.importaciones[0].limite, 5);
  } finally {
    await app.cerrar();
  }
});

test('la plantilla generada se puede volver a importar', async () => {
  const servicio = crearServicioFalso();
  const app = await levantar({ servicio });

  try {
    const plantilla = generarPlantilla();
    const respuesta = await fetch(app.url, {
      method: 'POST',
      body: formularioConArchivo(plantilla, 'plantilla.xlsx'),
    });

    assert.equal(respuesta.status, 200);
    assert.equal(servicio.llamadas[0].nombreArchivo, 'plantilla.xlsx');
  } finally {
    await app.cerrar();
  }
});
