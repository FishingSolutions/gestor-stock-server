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
import { iaConfigurada, sugerirMapeo, type ResultadoIA } from '../_shared/importacion/ia.ts'
import {
  firmarTrazabilidad as firmarToken,
  verificarTrazabilidad as verificarToken,
  type TrazabilidadIA,
} from '../_shared/importacion/trazabilidad.ts'
import {
  ejecutarIAConReserva,
  finalizarSolicitudIA,
  reservarSolicitudIA,
} from '../_shared/importacion/consumo-ia.ts'
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

    const contexto = await clienteDelAdmin(req)
    const formulario = await leerFormulario(req)
    const accion = String(formulario.get('accion') ?? 'analizar').toLowerCase()

    if (accion === 'analizar') return await analizar(formulario, contexto)
    if (accion === 'confirmar') return await confirmar(formulario, contexto)

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
interface ContextoAdmin {
  inventario: SupabaseClient
  interno: SupabaseClient | null
  idUsuario: string
}

async function clienteDelAdmin(req: Request): Promise<ContextoAdmin> {
  const autorizacion = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+/i.test(autorizacion)) {
    throw new ErrorHttp(401, 'SIN_SESION', 'Tenés que iniciar sesión para importar productos.')
  }
  const accessToken = autorizacion.replace(/^Bearer\s+/i, '').trim()

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: autorizacion } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: usuario, error: errorUsuario } = await supabase.auth.getUser(accessToken)
  if (errorUsuario || !usuario.user?.id) {
    throw new ErrorHttp(401, 'SIN_SESION', 'Tenés que iniciar sesión para importar productos.')
  }
  const { data: rol, error } = await supabase.rpc('rol_actual')
  if (error) throw new ErrorHttp(401, 'SIN_SESION', 'Tenés que iniciar sesión para importar productos.')
  if (rol !== 'ADMINISTRADOR') {
    throw new ErrorHttp(403, 'SOLO_ADMINISTRADOR', 'Solo un administrador puede importar productos.')
  }

  // Solo se crea el cliente privilegiado después de validar JWT, usuario y rol.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const interno = serviceKey
    ? createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    : null
  return { inventario: supabase, interno, idUsuario: usuario.user.id }
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
async function analizar(formulario: FormData, contexto: ContextoAdmin) {
  const { inventario: supabase, interno, idUsuario } = contexto
  const { bytes, nombre, hash, archivo } = await leerArchivo(formulario)
  const hojaPedida = texto(formulario.get('hoja'))
  const modo = leerModo(texto(formulario.get('modoStock')))
  const mapeoPedido = leerJson<Mapeo | null>(formulario.get('mapeo'), null)
  const tokenOrigen = texto(formulario.get('iaToken'))

  const lectura = leerLibro(bytes, hojaPedida, ALIAS_CONOCIDOS)
  let base = mapearPorAlias(lectura.encabezados)

  // El cliente puede mandar el mapeo que ya revisó: en ese caso no se llama a la IA.
  if (mapeoPedido && typeof mapeoPedido === 'object') {
    base = combinarMapeo({}, { columnas: mapeoPedido }, lectura.encabezados.length).mapeo
  }

  const sinMapear = columnasSinMapear(lectura.encabezados, base)
  let ia: ResultadoIA = { usada: false, modelo: null, ms: 0, motivo: 'NO_HIZO_FALTA', sugerencias: null }
  let rechazadasIA: string[] = []
  let iaOrigen: TrazabilidadIA | null = null

  if (tokenOrigen) {
    iaOrigen = await verificarToken(
      Deno.env.get('IMPORTACION_IA_SIGNING_SECRET') ?? '',
      tokenOrigen,
      { sub: idUsuario, hash, hoja: lectura.hoja },
    )
    if (!iaOrigen || !(await validarAnalisisPersistido(interno, iaOrigen))) {
      throw new ErrorHttp(400, 'TRAZABILIDAD_IA_INVALIDA', 'El análisis anterior no corresponde a este usuario, archivo u hoja.')
    }
    ia = {
      usada: iaOrigen.usada,
      modelo: iaOrigen.modelo,
      ms: iaOrigen.ms,
      motivo: iaOrigen.usada ? null : 'IA_SIN_APORTES',
      sugerencias: null,
    }
  }

  if (!tokenOrigen && !mapeoPedido && (faltanCamposClave(base) || sinMapear.length > 0)) {
    if (!iaConfigurada()) {
      ia = { ...ia, motivo: 'IA_NO_CONFIGURADA' }
    } else if (!interno || !(await trazabilidadDisponible())) {
      ia = { ...ia, motivo: 'IA_CONTROL_NO_DISPONIBLE' }
    } else {
      ia = await ejecutarIAConReserva(
        () => reservarIA(interno, idUsuario),
        () => sugerirMapeo(lectura.encabezados, lectura.filas),
        (id, resultado) => finalizarIA(interno, id, resultado),
        Deno.env.get('AI_MODEL')?.trim() ?? null,
        (evento) => console.error(`Control IA: ${evento}`),
      )
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
    }
  }
  if (!interno) {
    throw new ErrorHttp(503, 'CONTROL_IA_NO_DISPONIBLE', 'No está disponible el registro seguro del análisis.')
  }
  const iaToken = await crearAnalisisFirmado(
    interno,
    idUsuario,
    hash,
    lectura.hoja,
    base,
    ia,
    iaOrigen,
  )

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
      iaToken,
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
    iaToken,
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

async function confirmar(formulario: FormData, contexto: ContextoAdmin) {
  const { inventario: supabase, idUsuario } = contexto
  const { bytes, nombre, hash, archivo } = await leerArchivo(formulario)
  const hoja = texto(formulario.get('hoja'))
  const modo = leerModo(texto(formulario.get('modoStock')))
  const clave = texto(formulario.get('idempotencyKey'))
  const crearCategorias = texto(formulario.get('crearCategorias')) === 'true'
  const mapeoPedido = leerJson<Mapeo | null>(formulario.get('mapeo'), null)
  const decisionesCrudas = leerJson<unknown>(formulario.get('decisiones'), {})
  const iaToken = texto(formulario.get('iaToken'))

  if (!clave || !UUID.test(clave)) {
    throw new ErrorHttp(400, 'IDEMPOTENCIA_FALTANTE', 'Falta la clave de idempotencia de la importación.')
  }

  const lectura = leerLibro(bytes, hoja, ALIAS_CONOCIDOS)
  const base = mapeoPedido && typeof mapeoPedido === 'object'
    ? combinarMapeo({}, { columnas: mapeoPedido }, lectura.encabezados.length).mapeo
    : mapearPorAlias(lectura.encabezados)

  const ia = iaToken
    ? await verificarToken(
      Deno.env.get('IMPORTACION_IA_SIGNING_SECRET') ?? '',
      iaToken,
      { sub: idUsuario, hash, hoja: lectura.hoja, mapeo: base },
      Date.now(),
      true,
    )
    : null
  if (!ia) {
    throw new ErrorHttp(400, 'TRAZABILIDAD_IA_INVALIDA', 'El análisis no corresponde a este usuario, archivo, hoja o mapeo. Volvé a analizarlo.')
  }

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
  const decisiones = validarDecisiones(decisionesCrudas, filas)
  const productos = await cargarProductos(supabase)
  const previa = clasificarFilas(filas, productos, modo)

  const errores: { fila: number; codigo: string; mensaje: string }[] = []
  const pagos: Record<string, unknown>[] = []

  for (const fila of previa) {
    const decision = decisiones[String(fila.fila)] ?? null
    if (decision && decision.accion !== 'EXCLUIR' && fila.estado !== 'ambigua') {
      throw new ErrorHttp(
        400,
        'DECISION_NO_APLICABLE',
        `La fila ${fila.fila} no requiere resolver una coincidencia ambigua.`,
      )
    }

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
      pagos.push(aPago(fila, 'UPSERT', null))
      continue
    }

    // existente o sin_cambios
    // La intención por código permanece estable entre el primer intento y
    // un reintento posterior a la confirmación (cuando ya existe el producto).
    pagos.push(aPago(fila, 'UPSERT', null))
  }

  if (errores.length > 0) {
    throw new ErrorHttp(
      422,
      'FILAS_SIN_RESOLVER',
      'Hay filas que no se pueden importar. Corregilas o excluilas y volvé a confirmar.',
      { errores },
    )
  }

  const { data: resultado, error } = await supabase.rpc('confirmar_importacion_productos_vinculada', {
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
      decisiones,
    },
    p_id_analisis: ia.id,
  })

  if (error) {
    if (/ANALISIS_IMPORTACION_YA_VINCULADA/.test(error.message ?? '')) {
      throw new ErrorHttp(
        409,
        'ANALISIS_IA_YA_VINCULADO',
        'Este análisis o esta importación ya están asociados a otra operación. Volvé a analizar el archivo.',
      )
    }
    if (/IDEMPOTENCIA_CONFLICTO/.test(error.message ?? '')) {
      throw new ErrorHttp(
        409,
        'IDEMPOTENCIA_CONFLICTO',
        'Esta clave ya se usó para una operación distinta. Iniciá una nueva importación para aplicar otros cambios.',
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

function validarDecisiones(
  valor: unknown,
  filas: ReturnType<typeof construirFilas>,
): Record<string, Decision> {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ErrorHttp(400, 'DECISIONES_INVALIDAS', 'Las decisiones de filas no tienen un formato válido.')
  }

  const existentes = new Map(filas.map((fila) => [String(fila.fila), fila]))
  const resultado: Record<string, Decision> = {}

  for (const [numero, decision] of Object.entries(valor)) {
    if (!/^[1-9]\d*$/.test(numero) || !existentes.has(numero)) {
      throw new ErrorHttp(400, 'DECISION_FILA_INVALIDA', `La fila "${numero}" no pertenece al archivo.`)
    }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new ErrorHttp(400, 'DECISION_INVALIDA', `La decisión de la fila ${numero} no es válida.`)
    }

    const objeto = decision as Record<string, unknown>
    if (Object.keys(objeto).some((campo) => !['accion', 'idProducto'].includes(campo))) {
      throw new ErrorHttp(400, 'DECISION_INVALIDA', `La decisión de la fila ${numero} contiene campos no permitidos.`)
    }

    const accion = objeto.accion
    if (accion !== 'VINCULAR' && accion !== 'CREAR' && accion !== 'EXCLUIR') {
      throw new ErrorHttp(400, 'DECISION_INVALIDA', `La acción de la fila ${numero} no es válida.`)
    }

    if (accion === 'VINCULAR') {
      if (!Number.isSafeInteger(objeto.idProducto) || Number(objeto.idProducto) <= 0) {
        throw new ErrorHttp(400, 'PRODUCTO_INVALIDO', `El producto elegido para la fila ${numero} no es válido.`)
      }
      resultado[numero] = { accion, idProducto: Number(objeto.idProducto) }
    } else {
      if (objeto.idProducto !== undefined) {
        throw new ErrorHttp(400, 'DECISION_INVALIDA', `La decisión de la fila ${numero} no debe incluir un producto.`)
      }
      resultado[numero] = { accion: accion as Decision['accion'] }
    }
  }

  return resultado
}

// ---------------------------------------------------------------------
// Reserva global y trazabilidad de IA (el contador es fail-closed).
// ---------------------------------------------------------------------
async function reservarIA(
  interno: SupabaseClient,
  idUsuario: string,
): Promise<{ ok: true; id: number } | { ok: false; limite: boolean }> {
  return reservarSolicitudIA(
    async (nombre, parametros) => {
      const { data, error } = await interno.rpc(nombre as never, parametros as never)
      return { data, error }
    },
    idUsuario,
    Deno.env.get('AI_MODEL')?.trim() ?? null,
    (evento) => console.error(`Control IA: ${evento}`),
  )
}

async function finalizarIA(interno: SupabaseClient, id: number, resultado: ResultadoIA) {
  // La excepción secundaria no oculta el resultado del análisis. La fila
  // RESERVADA sigue contando y puede marcarse manualmente como TIMEOUT.
  await finalizarSolicitudIA(
    async (nombre, parametros) => {
      const { data, error } = await interno.rpc(nombre as never, parametros as never)
      return { data, error }
    },
    id,
    resultado,
    (evento) => console.error(`Control IA: ${evento}; solicitud=${id}`),
  )
}

function trazabilidadDisponible(): boolean {
  return (Deno.env.get('IMPORTACION_IA_SIGNING_SECRET') ?? '').length >= 32
}

async function validarAnalisisPersistido(
  interno: SupabaseClient | null,
  claims: TrazabilidadIA,
): Promise<boolean> {
  if (!interno) return false
  const { data, error } = await interno
    .from('importacion_ia_analisis')
    .select('id_analisis,id_usuario,hash_archivo,hoja,mapeo,expira_en,ia_usada,ia_modelo,ia_ms,idempotency_key')
    .eq('id_analisis', claims.id)
    .eq('id_usuario', claims.sub)
    .maybeSingle()
  if (error || !data || data.idempotency_key) return false
  const mapeoPersistido = JSON.stringify(
    Object.fromEntries(Object.entries(data.mapeo as Record<string, number>).sort(([a], [b]) => a.localeCompare(b))),
  )
  const mapeoToken = JSON.stringify(
    Object.fromEntries(Object.entries(claims.mapeo).sort(([a], [b]) => a.localeCompare(b))),
  )
  return data.hash_archivo === claims.hash &&
    data.hoja === claims.hoja &&
    mapeoPersistido === mapeoToken &&
    data.ia_usada === claims.usada &&
    data.ia_modelo === claims.modelo &&
    data.ia_ms === claims.ms &&
    new Date(data.expira_en).getTime() > Date.now()
}

async function crearAnalisisFirmado(
  interno: SupabaseClient,
  idUsuario: string,
  hash: string,
  hoja: string,
  mapeo: Mapeo,
  ia: ResultadoIA,
  origen: TrazabilidadIA | null,
): Promise<string> {
  const secreto = Deno.env.get('IMPORTACION_IA_SIGNING_SECRET') ?? ''
  if (secreto.length < 32) {
    throw new ErrorHttp(503, 'TRAZABILIDAD_IA_NO_DISPONIBLE', 'No está configurada la firma segura del análisis.')
  }
  const exp = Date.now() + 30 * 60 * 1000
  const id = origen?.id ?? crypto.randomUUID()
  if (origen) {
    if (!(await validarAnalisisPersistido(interno, origen))) {
      throw new ErrorHttp(409, 'ANALISIS_IA_CAMBIADO', 'El análisis ya cambió o expiró. Volvé a analizar el archivo.')
    }
    const { data, error } = await interno
      .from('importacion_ia_analisis')
      .update({
        mapeo,
        expira_en: new Date(exp).toISOString(),
      })
      .eq('id_analisis', id)
      .eq('id_usuario', idUsuario)
      .is('idempotency_key', null)
      .gt('expira_en', new Date().toISOString())
      .select('id_analisis')
      .maybeSingle()
    if (error || !data) {
      console.error('No se pudo actualizar el contexto persistido del análisis.')
      throw new ErrorHttp(409, 'ANALISIS_IA_CAMBIADO', 'El análisis ya fue confirmado o expiró. Volvé a analizarlo.')
    }
  } else {
    const { error } = await interno.from('importacion_ia_analisis').insert({
      id_analisis: id,
      id_usuario: idUsuario,
      hash_archivo: hash,
      hoja,
      mapeo,
      expira_en: new Date(exp).toISOString(),
      ia_usada: ia.usada,
      ia_modelo: ia.modelo,
      ia_ms: Math.max(0, Math.trunc(ia.ms)),
    })
    if (error) {
      console.error('No se pudo persistir el análisis IA.')
      throw new ErrorHttp(503, 'TRAZABILIDAD_IA_NO_DISPONIBLE', 'No se pudo registrar el análisis de forma segura.')
    }
  }
  return firmarToken(secreto, {
    id,
    sub: idUsuario,
    hash,
    hoja,
    mapeo,
    exp,
    usada: ia.usada,
    modelo: ia.modelo,
    ms: Math.max(0, Math.trunc(ia.ms)),
  })
}

function leerModo(valor: string | null): ModoStock | null {
  if (!valor) return null
  const modo = valor.toUpperCase()
  if (modo !== 'REEMPLAZAR' && modo !== 'SUMAR') {
    throw new ErrorHttp(400, 'MODO_STOCK_INVALIDO', 'El modo de stock tiene que ser REEMPLAZAR o SUMAR.')
  }
  return modo
}
