// =====================================================================
// Edge Function: importar-productos
//
// Importa productos desde un Excel (.xlsx o .xls). Solo ADMINISTRADOR activo.
//
//   POST  (multipart/form-data, campo `archivo`; opcional `hoja`)
//         -> lee la hoja, valida cada fila y llama a rpc('importar_productos'),
//            que inserta los válidos en una sola transacción y guarda el historial
//   GET   -> descarga la plantilla de ejemplo (plantilla-productos.xlsx)
//
// Corre con la sesión del usuario (nunca con la clave secreta): la base vuelve
// a verificar el rol y aplica todas sus reglas.
//
// Uso desde el front:
//   const datos = new FormData()
//   datos.append('archivo', archivo)          // File del <input type="file">
//   const { data, error } = await supabase.functions.invoke('importar-productos', { body: datos })
// =====================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { ErrorArchivo, LIMITES, generarPlantilla, leerExcel, validarFilas } from './excel.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-disposition',
}

class ErrorHttp extends Error {
  constructor(public estado: number, public codigo: string, mensaje: string, public detalles: unknown = null) {
    super(mensaje)
  }
}

const responder = (estado: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, 'Content-Type': 'application/json' } })

const responderError = (e: ErrorHttp) =>
  responder(e.estado, { ok: false, error: { codigo: e.codigo, mensaje: e.message, detalles: e.detalles } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabase = await clienteDelAdmin(req)

    if (req.method === 'GET') {
      return new Response(generarPlantilla(), {
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="plantilla-productos.xlsx"',
        },
      })
    }
    if (req.method !== 'POST') throw new ErrorHttp(405, 'METODO_NO_PERMITIDO', 'Usá POST para importar o GET para la plantilla.')

    return await importar(req, supabase)
  } catch (error) {
    if (error instanceof ErrorHttp) return responderError(error)
    console.error(error)
    return responderError(new ErrorHttp(500, 'ERROR_INESPERADO', 'Error inesperado al importar. Intentá de nuevo.'))
  }
})

// Cliente con la sesión de quien llama. Solo sigue si es ADMINISTRADOR activo.
async function clienteDelAdmin(req: Request): Promise<SupabaseClient> {
  const autorizacion = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+/i.test(autorizacion)) {
    throw new ErrorHttp(401, 'SIN_SESION', 'Tenés que iniciar sesión para importar productos.')
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: autorizacion } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: rol, error } = await supabase.rpc('rol_actual')
  if (error) throw new ErrorHttp(401, 'SIN_SESION', 'Tenés que iniciar sesión para importar productos.')
  if (rol !== 'ADMINISTRADOR') {
    throw new ErrorHttp(403, 'SOLO_ADMINISTRADOR', 'Solo un administrador puede importar productos.')
  }

  return supabase
}

async function importar(req: Request, supabase: SupabaseClient) {
  const inicio = performance.now()

  let formulario: FormData
  try {
    formulario = await req.formData()
  } catch {
    throw new ErrorHttp(400, 'SIN_ARCHIVO', 'Mandá el Excel como multipart/form-data en el campo "archivo".')
  }

  const archivo = formulario.get('archivo')
  if (!(archivo instanceof File)) {
    throw new ErrorHttp(400, 'SIN_ARCHIVO', 'No se recibió ningún archivo. Elegí un Excel (.xlsx o .xls).')
  }
  if (!/\.(xlsx|xls)$/i.test(archivo.name)) {
    throw new ErrorHttp(415, 'TIPO_NO_PERMITIDO', 'El archivo tiene que ser un Excel (.xlsx o .xls).')
  }
  if (archivo.size > LIMITES.maxBytes) {
    throw new ErrorHttp(413, 'ARCHIVO_MUY_GRANDE', `El archivo supera el máximo de ${LIMITES.maxBytes / 1024 / 1024} MB.`)
  }

  const nombreArchivo = archivo.name.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 255)
  const hojaPedida = typeof formulario.get('hoja') === 'string' ? (formulario.get('hoja') as string) : null

  // 1. Leer y validar el Excel ------------------------------------------
  let lectura: ReturnType<typeof leerExcel>
  try {
    lectura = leerExcel(new Uint8Array(await archivo.arrayBuffer()), hojaPedida)
  } catch (error) {
    if (!(error instanceof ErrorArchivo)) throw error

    // Un archivo ilegible también queda en el historial (como RECHAZADA)
    const { data } = await supabase.rpc('importar_productos', {
      p_productos: [],
      p_archivo: nombreArchivo,
      p_hoja: hojaPedida,
      p_tamano_bytes: archivo.size,
      p_filas_procesadas: 0,
      p_errores: [{ fila: null, codigo: null, campo: null, mensaje: error.message }],
      p_detalle: { motivo: error.codigo },
      p_duracion_ms: Math.round(performance.now() - inicio),
    })
    return responder(400, {
      ok: false,
      idImportacion: data?.idImportacion ?? null,
      error: { codigo: error.codigo, mensaje: error.message, detalles: error.detalles },
    })
  }

  const { validos, errores } = validarFilas(lectura.filas)

  // 2. Guardar en la base (una transacción) -------------------------------
  const { data: resultado, error } = await supabase.rpc('importar_productos', {
    p_productos: validos,
    p_archivo: nombreArchivo,
    p_hoja: lectura.hoja,
    p_tamano_bytes: archivo.size,
    p_filas_procesadas: lectura.filas.length,
    p_filas_vacias: lectura.filasVacias,
    p_errores: errores,
    p_detalle: { hojas: lectura.hojas, filaEncabezado: lectura.filaEncabezado, columnasIgnoradas: lectura.columnasIgnoradas },
    p_duracion_ms: Math.round(performance.now() - inicio),
  })

  if (error) {
    if (/administrador/i.test(error.message)) throw new ErrorHttp(403, 'SOLO_ADMINISTRADOR', error.message)
    console.error('importar_productos falló', error)
    throw new ErrorHttp(500, 'ERROR_BASE_DE_DATOS', 'No se pudo guardar la importación. No se cargó ningún producto.')
  }

  // 3. Resumen (mismo formato que el importador original) -----------------
  return responder(200, {
    ok: true,
    estado: resultado.estado,
    idImportacion: resultado.idImportacion,
    archivo: {
      nombre: nombreArchivo,
      tamanoBytes: archivo.size,
      hoja: lectura.hoja,
      hojas: lectura.hojas,
      filaEncabezado: lectura.filaEncabezado,
      columnasIgnoradas: lectura.columnasIgnoradas,
    },
    fecha: new Date().toISOString(),
    duracionMs: Math.round(performance.now() - inicio),
    resumen: resultado.resumen,
    importados: resultado.importados,
    errores: resultado.errores,
  })
}
