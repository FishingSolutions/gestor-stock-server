// =====================================================================
// Edge Function: importar-productos-ia
//
// Importa productos desde un Excel en dos pasos, siempre como ADMINISTRADOR:
//
//   POST accion=analizar   -> lee el archivo, mapea columnas (alias + una
//                             llamada a la IA si hace falta) y devuelve la
//                             vista previa. NO escribe nada.
//   POST accion=confirmar  -> vuelve a leer el archivo, revalida todo y
//                             llama a rpc('confirmar_importacion_productos'),
//                             que aplica el lote en una transacción.
//
// Corre con la sesión del usuario (nunca con la service_role): la base
// vuelve a verificar el rol y aplica todas sus reglas.
// =====================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { ErrorArchivo, LIMITES, leerLibro } from '../_shared/importacion/excel.ts'
import {
  ALIAS_CONOCIDOS,
  columnasSinMapear,
  combinarMapeo,
  faltanCamposClave,
  mapearPorAlias,
} from '../_shared/importacion/mapeo.ts'
import { construirFilas } from '../_shared/importacion/filas.ts'
import { clasificarFilas, resumirFilas } from '../_shared/importacion/coincidencias.ts'
import { sugerirMapeo, type ResultadoIA } from '../_shared/importacion/ia.ts'
import { cargarCategorias, cargarProductos } from '../_shared/importacion/datos.ts'
import type { Mapeo, ModoStock } from '../_shared/importacion/tipos.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class ErrorHttp extends Error {
  constructor(
    public estado: number,
    public codigo: string,
    mensaje: string,
    public detalles: unknown = null,
  ) {
    super(mensaje)
  }
}

const responder = (estado: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const responderError = (e: ErrorHttp, extra: Record<string, unknown> = {}) =>
  responder(e.estado, {
    ok: false,
    ...extra,
    error: { codigo: e.codigo, mensaje: e.message, detalles: e.detalles },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    if (req.method !== 'POST') {
      throw new ErrorHttp(405, 'METODO_NO_PERMITIDO', 'Usá POST con multipart/form-data.')
    }

    const supabase = await clienteDelAdmin(req)
    const formulario = await leerFormulario(req)
    const accion = String(formulario.get('accion') ?? 'analizar').toLowerCase()

    if (accion === 'analizar') return await analizar(formulario, supabase)
    if (accion === 'confirmar') return await confirmar(formulario, supabase)

    throw new ErrorHttp(400, 'ACCION_INVALIDA', 'La acción tiene que ser "analizar" o "confirmar".')
  } catch (error) {
    if (error instanceof ErrorHttp) return responderError(error)
    if (error instanceof ErrorArchivo) {
      return responderError(new ErrorHttp(400, error.codigo, error.message, error.detalles))
    }
    console.error(error)
    return responderError(
      new ErrorHttp(500, 'ERROR_INESPERADO', 'Error inesperado en la importación. Intentá de nuevo.'),
    )
  }
})

// ---------------------------------------------------------------------
// Autenticación: solo ADMINISTRADOR activo
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Utilidades del formulario y del archivo
// ---------------------------------------------------------------------
async function leerFormulario(req: Request): Promise<FormData> {
  try {
    return await req.formData()
  } catch {
    throw new ErrorHttp(400, 'SIN_ARCHIVO', 'Mandá el Excel como multipart/form-data en el campo "archivo".')
  }
}

interface ArchivoLeido {
  archivo: File
  bytes: Uint8Array
  nombre: string
  hash: string
}

async function leerArchivo(formulario: FormData): Promise<ArchivoLeido> {
  const archivo = formulario.get('archivo')
  if (!(archivo instanceof File)) {
    throw new ErrorHttp(400, 'SIN_ARCHIVO', 'No se recibió ningún archivo. Elegí un Excel (.xlsx o .xls).')
  }
  if (!/\.(xlsx|xls)$/i.test(archivo.name)) {
    throw new ErrorHttp(415, 'TIPO_NO_PERMITIDO', 'El archivo tiene que ser un Excel (.xlsx o .xls).')
  }
  if (archivo.size > LIMITES.maxBytes) {
    throw new ErrorHttp(
      413,
      'ARCHIVO_MUY_GRANDE',
      `El archivo supera el máximo de ${LIMITES.maxBytes / 1024 / 1024} MB.`,
    )
  }

  const bytes = new Uint8Array(await archivo.arrayBuffer())
  const nombre = archivo.name.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 255)

  return { archivo, bytes, nombre, hash: await hashArchivo(bytes) }
}

async function hashArchivo(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function texto(valor: FormDataEntryValue | null): string | null {
  if (typeof valor !== 'string') return null
  const limpio = valor.trim()
  return limpio === '' ? null : limpio
}

function leerJson<T>(valor: FormDataEntryValue | null, porDefecto: T): T {
  const crudo = texto(valor)
  if (!crudo) return porDefecto
  try {
    return JSON.parse(crudo) as T
  } catch {
    throw new ErrorHttp(400, 'JSON_INVALIDO', 'Alguno de los datos enviados no es un JSON válido.')
  }
}

// ---------------------------------------------------------------------
// Paso 1: analizar (sin escribir nada)
// ---------------------------------------------------------------------
async function analizar(formulario: FormData, supabase: SupabaseClient) {
  const { bytes, nombre, hash, archivo } = await leerArchivo(formulario)
  const hoja = texto(formulario.get('hoja'))
  const modo = leerModo(texto(formulario.get('modoStock')))
  const mapeoPedido = leerJson<Mapeo | null>(formulario.get('mapeo'), null)

  const lectura = leerLibro(bytes, hoja, ALIAS_CONOCIDOS)
  let base = mapearPorAlias(lectura.encabezados)

  // El cliente puede mandar el mapeo que ya revisó: en ese caso no se llama a la IA.
  if (mapeoPedido && typeof mapeoPedido === 'object') {
    base = combinarMapeo({}, { columnas: mapeoPedido }, lectura.encabezados.length).mapeo
  }

  const sinMapear = columnasSinMapear(lectura.encabezados, base)
  let ia: ResultadoIA = { usada: false, modelo: null, ms: 0, motivo: 'NO_HIZO_FALTA', sugerencias: null }
  let rechazadasIA: string[] = []

  if (!mapeoPedido && (faltanCamposClave(base) || sinMapear.length > 0)) {
    if (await puedeUsarIA(supabase)) {
      ia = await sugerirMapeo(lectura.encabezados, lectura.filas)
      if (ia.usada) {
        const antes = Object.keys(base).length
        const combinado = combinarMapeo(base, ia.sugerencias, lectura.encabezados.length)
        base = combinado.mapeo
        rechazadasIA = combinado.rechazadas

        // Si la IA no sumó ninguna columna nueva, no se muestra como usada:
        // el mapeo real salió de los encabezados.
        if (Object.keys(base).length <= antes) {
          ia = { ...ia, usada: false, motivo: 'IA_SIN_APORTES' }
        }
      }
    } else {
      ia = { usada: false, modelo: null, ms: 0, motivo: 'IA_LIMITE_DIARIO', sugerencias: null }
    }
  }

  const advertencias = [...rechazadasIA]

  // Sin código o sin descripción no se puede ni interpretar las filas: se
  // devuelve el encabezado crudo para que el administrador corrija el mapeo.
  if (faltanCamposClave(base)) {
    advertencias.push('No se pudo identificar la columna de código o de descripción. Corregí el mapeo y volvé a analizar.')
    return responder(200, {
      ok: true,
      accion: 'analizar',
      necesitaMapeo: true,
      archivo: {
        nombre,
        tamanoBytes: archivo.size,
        hoja: lectura.hoja,
        hojas: lectura.hojas,
        filaEncabezado: lectura.filaEncabezado,
        filasVacias: lectura.filasVacias,
        hashArchivo: hash,
      },
      encabezados: lectura.encabezados,
      mapeo: base,
      columnasIgnoradas: columnasSinMapear(lectura.encabezados, base),
      ia: {
        usada: ia.usada,
        modelo: ia.modelo,
        ms: ia.ms,
        motivo: ia.motivo,
        rechazadas: rechazadasIA,
      },
      modoStock: modo,
      resumen: { filas: 0, nuevos: 0, existentes: 0, sinCambios: 0, ambiguas: 0, invalidas: 0 },
      advertencias,
      filas: [],
    })
  }

  if (base.precio === undefined && base.costo === undefined) {
    advertencias.push('La planilla no tiene columna de precio: solo se podrán actualizar productos existentes.')
  }

  const filas = construirFilas(lectura, base)
  const productos = await cargarProductos(supabase)
  const previa = clasificarFilas(filas, productos, modo)

  // Categorías que trae el archivo y todavía no existen: el admin decide si
  // se crean (nunca se crean solas).
  let categoriasNuevas: string[] = []
  try {
    const existentes = await cargarCategorias(supabase)
    categoriasNuevas = [
      ...new Set(
        filas
          .map((fila) => fila.categoria?.trim())
          .filter((nombre): nombre is string => Boolean(nombre))
          .filter((nombre) => !existentes.has(nombre.toLowerCase())),
      ),
    ]
  } catch {
    // Si falla la lectura de categorías, la importación puede seguir: la
    // función SQL vuelve a validar cada categoría.
  }

  const resumen = resumirFilas(previa)
  if (resumen.ambiguas > 0) {
    advertencias.push(
      `Hay ${resumen.ambiguas} fila(s) con nombre parecido a un producto existente: elegí si vincularlas o crearlas de nuevo.`,
    )
  }
  if (resumen.invalidas > 0) {
    advertencias.push(`Hay ${resumen.invalidas} fila(s) con errores: corregilas en el Excel, excluilas o resolvelas.`)
  }

  const ignoradas = columnasSinMapear(lectura.encabezados, base)
  if (ignoradas.length > 0) {
    advertencias.push(`Se ignoran ${ignoradas.length} columna(s) sin usar: ${ignoradas.join(', ')}.`)
  }

  return responder(200, {
    ok: true,
    accion: 'analizar',
    archivo: {
      nombre,
      tamanoBytes: archivo.size,
      hoja: lectura.hoja,
      hojas: lectura.hojas,
      filaEncabezado: lectura.filaEncabezado,
      filasVacias: lectura.filasVacias,
      hashArchivo: hash,
    },
    encabezados: lectura.encabezados,
    mapeo: base,
    columnasIgnoradas: ignoradas,
    ia: {
      usada: ia.usada,
      modelo: ia.modelo,
      ms: ia.ms,
      motivo: ia.motivo,
      rechazadas: rechazadasIA,
    },
    modoStock: modo,
    categoriasNuevas,
    resumen,
    advertencias,
    filas: previa,
  })
}

// ---------------------------------------------------------------------
// Paso 2: confirmar (una transacción en la base)
// ---------------------------------------------------------------------
interface Decision {
  accion?: 'VINCULAR' | 'CREAR' | 'EXCLUIR'
  idProducto?: number
}

async function confirmar(formulario: FormData, supabase: SupabaseClient) {
  const { bytes, nombre, hash, archivo } = await leerArchivo(formulario)
  const hoja = texto(formulario.get('hoja'))
  const modo = leerModo(texto(formulario.get('modoStock')))
  const clave = texto(formulario.get('idempotencyKey'))
  const crearCategorias = texto(formulario.get('crearCategorias')) === 'true'
  const mapeoPedido = leerJson<Mapeo | null>(formulario.get('mapeo'), null)
  const decisiones = leerJson<Record<string, Decision>>(formulario.get('decisiones'), {})
  const ia = leerJson<{ usada?: boolean; modelo?: string | null; ms?: number }>(
    formulario.get('ia'),
    { usada: false, modelo: null, ms: 0 },
  )

  if (!clave || !UUID.test(clave)) {
    throw new ErrorHttp(400, 'IDEMPOTENCIA_FALTANTE', 'Falta la clave de idempotencia de la importación.')
  }

  const lectura = leerLibro(bytes, hoja, ALIAS_CONOCIDOS)
  const base = mapeoPedido && typeof mapeoPedido === 'object'
    ? combinarMapeo({}, { columnas: mapeoPedido }, lectura.encabezados.length).mapeo
    : mapearPorAlias(lectura.encabezados)

  if (faltanCamposClave(base)) {
    throw new ErrorHttp(
      422,
      'COLUMNAS_FALTANTES',
      'No se pudo identificar la columna de código o de descripción. Volvé a analizar el archivo.',
    )
  }

  // El modo es obligatorio cuando la planilla tiene columna de stock: la
  // decisión de reemplazar o sumar la toma siempre el administrador.
  const hayStock = base.stock !== undefined
  if (hayStock && !modo) {
    throw new ErrorHttp(
      400,
      'MODO_STOCK_REQUERIDO',
      'Elegí qué hacer con el stock de los productos existentes: reemplazar o sumar existencias.',
    )
  }

  const filas = construirFilas(lectura, base)
  const productos = await cargarProductos(supabase)
  const previa = clasificarFilas(filas, productos, modo)

  const errores: { fila: number; codigo: string; mensaje: string }[] = []
  const pagos: Record<string, unknown>[] = []

  for (const fila of previa) {
    const decision = decisiones[String(fila.fila)] ?? null

    // Excluida a mano: se manda igual para que quede en el historial.
    if (decision?.accion === 'EXCLUIR') {
      pagos.push(aPago(fila, 'EXCLUIR', null))
      continue
    }

    if (fila.estado === 'invalida') {
      errores.push({
        fila: fila.fila,
        codigo: fila.codigo,
        mensaje: fila.errores[0] ?? 'La fila tiene errores.',
      })
      continue
    }

    if (fila.estado === 'ambigua') {
      if (decision?.accion === 'VINCULAR') {
        const sugerida = fila.sugerencias.find((s) => s.idProducto === decision.idProducto)
        if (!sugerida) {
          errores.push({
            fila: fila.fila,
            codigo: fila.codigo,
            mensaje: 'El producto elegido para la coincidencia ambigua no corresponde a esta fila.',
          })
          continue
        }
        pagos.push(aPago(fila, 'ACTUALIZAR', sugerida.idProducto))
        continue
      }
      if (decision?.accion === 'CREAR') {
        if (fila.precio === null) {
          errores.push({
            fila: fila.fila,
            codigo: fila.codigo,
            mensaje: 'El precio es obligatorio para crear el producto.',
          })
          continue
        }
        pagos.push(aPago(fila, 'CREAR', null))
        continue
      }
      errores.push({
        fila: fila.fila,
        codigo: fila.codigo,
        mensaje: 'Coincidencia ambigua sin resolver: elegí vincular a un producto existente, crear uno nuevo o excluir la fila.',
      })
      continue
    }

    if (fila.estado === 'nuevo') {
      pagos.push(aPago(fila, 'CREAR', null))
      continue
    }

    // existente o sin_cambios
    pagos.push(aPago(fila, 'ACTUALIZAR', fila.idProducto))
  }

  if (errores.length > 0) {
    throw new ErrorHttp(
      422,
      'FILAS_SIN_RESOLVER',
      'Hay filas que no se pueden importar. Corregilas o excluilas y volvé a confirmar.',
      { errores },
    )
  }

  const { data: resultado, error } = await supabase.rpc('confirmar_importacion_productos', {
    p_idempotency_key: clave,
    p_archivo: nombre,
    p_hoja: lectura.hoja,
    p_tamano_bytes: archivo.size,
    p_modo_stock: modo,
    p_filas: pagos,
    p_crear_categorias: crearCategorias,
    p_detalle: {
      hashArchivo: hash,
      filasAmbiguas: previa.filter((f) => f.estado === 'ambigua').length,
      filasVacias: lectura.filasVacias,
      encabezados: lectura.encabezados,
      mapeo: base,
      filaEncabezado: lectura.filaEncabezado,
      columnasIgnoradas: columnasSinMapear(lectura.encabezados, base),
    },
    p_ia: { usada: ia.usada === true, modelo: ia.modelo ?? null, ms: Number(ia.ms) || 0 },
  })

  if (error) {
    if (/IDEMPOTENCIA_CONFLICTO/.test(error.message ?? '')) {
      throw new ErrorHttp(
        409,
        'IDEMPOTENCIA_CONFLICTO',
        'Esta importación ya se confirmó con otro archivo o con otro modo de stock. Volvé a analizar el archivo.',
      )
    }
    if (/administrador/i.test(error.message ?? '')) {
      throw new ErrorHttp(403, 'SOLO_ADMINISTRADOR', error.message)
    }
    console.error('confirmar_importacion_productos falló', error)
    throw new ErrorHttp(500, 'ERROR_BASE_DE_DATOS', error.message ?? 'No se pudo guardar la importación.')
  }

  const cuerpo = resultado as Record<string, unknown>

  if (cuerpo?.estado === 'RECHAZADA') {
    return responder(422, {
      ok: false,
      estado: 'RECHAZADA',
      idImportacion: cuerpo.idImportacion ?? null,
      resumen: cuerpo.resumen ?? null,
      errores: cuerpo.errores ?? [],
      error: {
        codigo: 'IMPORTACION_RECHAZADA',
        mensaje: 'La base rechazó el lote: no se cargó nada. Revisá las filas con error.',
        detalles: null,
      },
    })
  }

  if (cuerpo?.estado === 'FALLIDA') {
    return responder(500, {
      ok: false,
      estado: 'FALLIDA',
      idImportacion: cuerpo.idImportacion ?? null,
      error: {
        codigo: 'IMPORTACION_FALLIDA',
        mensaje: (cuerpo.mensaje as string) || 'La importación falló y no se aplicó ningún cambio.',
        detalles: null,
      },
    })
  }

  return responder(200, {
    ok: true,
    accion: 'confirmar',
    estado: cuerpo.estado,
    idImportacion: cuerpo.idImportacion,
    repetida: cuerpo.repetida === true,
    resumen: cuerpo.resumen,
    filas: cuerpo.filas,
  })
}

function aPago(fila: ReturnType<typeof clasificarFilas>[number], accion: string, idProducto: number | null) {
  return {
    fila: fila.fila,
    codigo: fila.codigo,
    nombre: fila.nombre,
    descripcion: fila.descripcion,
    categoria: fila.categoria,
    stock: fila.stock,
    precio: fila.precio,
    costo: fila.costo,
    stockMinimo: fila.stockMinimo,
    stockMaximo: fila.stockMaximo,
    activo: fila.activo,
    accion,
    idProducto,
  }
}

// ---------------------------------------------------------------------
// Control de costo de la IA: un tope diario configurable
// ---------------------------------------------------------------------
async function puedeUsarIA(supabase: SupabaseClient): Promise<boolean> {
  const limite = Number(Deno.env.get('AI_DAILY_LIMIT')) || 20
  try {
    const desde = new Date()
    desde.setHours(0, 0, 0, 0)

    const { count } = await supabase
      .from('importacion_producto')
      .select('id_importacion', { count: 'exact', head: true })
      .eq('ia_usada', true)
      .gte('fecha', desde.toISOString())

    return (count ?? 0) < limite
  } catch {
    // Si no se puede contar, se permite: el límite es una protección, no una regla de negocio.
    return true
  }
}

function leerModo(valor: string | null): ModoStock | null {
  if (!valor) return null
  const modo = valor.toUpperCase()
  if (modo !== 'REEMPLAZAR' && modo !== 'SUMAR') {
    throw new ErrorHttp(400, 'MODO_STOCK_INVALIDO', 'El modo de stock tiene que ser REEMPLAZAR o SUMAR.')
  }
  return modo
}
