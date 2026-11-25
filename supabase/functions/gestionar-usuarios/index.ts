// =====================================================================
// Edge Function: gestionar-usuarios
//
// Permite que un ADMINISTRADOR, desde la app, cree usuarios y los active
// o desactive. Corre en el servidor de Supabase: acá sí se puede usar la
// clave secreta (service_role), que NUNCA puede estar en el front.
//
// Uso desde el front (con la sesión del admin iniciada):
//   const { data, error } = await supabase.functions.invoke('gestionar-usuarios', {
//     body: { accion: 'crear', email, password, nombre, apellido, rol: 'EMPLEADO' }
//   })
//   body: { accion: 'desactivar', id_usuario }
//   body: { accion: 'activar',    id_usuario }
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CAMPOS = 'id_usuario, nombre, apellido, email, rol, activo'
const ROLES = ['ADMINISTRADOR', 'EMPLEADO']
const BLOQUEO_LOGIN = '876000h' // ~100 años: el usuario desactivado no puede iniciar sesión

// Cliente con la clave secreta: puede crear cuentas y saltear RLS.
// Por eso cada pedido verifica primero que quien llama sea admin.
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

class ErrorApp extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function responder(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return responder(405, { error: 'Usá POST' })

  try {
    const idAdmin = await verificarAdmin(req)

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      throw new ErrorApp(400, 'El pedido tiene que ser JSON')
    }

    switch (body?.accion) {
      case 'crear':
        return responder(201, { usuario: await crearUsuario(body) })
      case 'desactivar':
        return responder(200, { usuario: await cambiarEstado(body, false, idAdmin) })
      case 'activar':
        return responder(200, { usuario: await cambiarEstado(body, true, idAdmin) })
      default:
        throw new ErrorApp(400, 'Acción inválida: usá crear, desactivar o activar')
    }
  } catch (error) {
    if (error instanceof ErrorApp) return responder(error.status, { error: error.message })
    console.error(error)
    return responder(500, { error: 'Error inesperado. Intentá de nuevo.' })
  }
})

// Quien llama tiene que tener sesión y ser ADMINISTRADOR activo
async function verificarAdmin(req: Request): Promise<string> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new ErrorApp(401, 'Tenés que iniciar sesión')

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) throw new ErrorApp(401, 'Tenés que iniciar sesión')

  const { data: perfil } = await admin
    .from('usuario')
    .select('rol, activo')
    .eq('id_usuario', data.user.id)
    .maybeSingle()

  if (!perfil || !perfil.activo || perfil.rol !== 'ADMINISTRADOR') {
    throw new ErrorApp(403, 'Solo un administrador puede gestionar usuarios')
  }

  return data.user.id
}

async function crearUsuario(body: Record<string, unknown>) {
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const nombre = String(body.nombre ?? '').trim()
  const apellido = String(body.apellido ?? '').trim()
  const rol = String(body.rol ?? 'EMPLEADO').trim().toUpperCase()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErrorApp(400, 'El email no es válido')
  if (password.length < 8) throw new ErrorApp(400, 'La contraseña tiene que tener al menos 8 caracteres')
  if (!nombre || !apellido) throw new ErrorApp(400, 'Nombre y apellido son obligatorios')
  if (!ROLES.includes(rol)) throw new ErrorApp(400, 'El rol tiene que ser ADMINISTRADOR o EMPLEADO')

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // lo crea el admin: no hace falta confirmar por mail
    user_metadata: { nombre, apellido },
    // Marca que solo puede poner el servidor: la base deja activas únicamente
    // las cuentas creadas por un admin (las que se registran solas entran desactivadas)
    app_metadata: { creado_por_admin: true },
  })

  if (error) {
    if (error.code === 'email_exists' || /already been registered/i.test(error.message)) {
      throw new ErrorApp(409, 'Ya existe un usuario con ese email')
    }
    if (error.code === 'weak_password') throw new ErrorApp(400, 'La contraseña es muy débil')
    throw new ErrorApp(400, error.message)
  }

  // El trigger de la base ya creó la fila en `usuario` como EMPLEADO.
  // Acá se completan los datos y el rol elegido por el admin, y queda activo.
  const { data: usuario, error: errorPerfil } = await admin
    .from('usuario')
    .update({ nombre, apellido, rol, activo: true })
    .eq('id_usuario', data.user.id)
    .select(CAMPOS)
    .single()

  if (errorPerfil) {
    // Si no se pudo completar el perfil, no dejar una cuenta a medias
    await admin.auth.admin.deleteUser(data.user.id)
    throw errorPerfil
  }

  return usuario
}

async function cambiarEstado(body: Record<string, unknown>, activo: boolean, idAdmin: string) {
  const id = String(body.id_usuario ?? '')

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ErrorApp(400, 'id_usuario no es válido')
  }
  if (!activo && id === idAdmin) {
    throw new ErrorApp(400, 'No podés desactivar tu propio usuario')
  }

  // 1. Marcar en la base (el trigger impide dejar el sistema sin admins)
  const { data: usuario, error } = await admin
    .from('usuario')
    .update({ activo })
    .eq('id_usuario', id)
    .select(CAMPOS)
    .maybeSingle()

  if (error) {
    if (/al menos un administrador/i.test(error.message)) throw new ErrorApp(409, error.message)
    throw error
  }
  if (!usuario) throw new ErrorApp(404, 'El usuario no existe')

  // 2. Bloquear o desbloquear el login
  const { error: errorLogin } = await admin.auth.admin.updateUserById(id, {
    ban_duration: activo ? 'none' : BLOQUEO_LOGIN,
  })

  if (errorLogin) {
    // Volver atrás para que la base y el login no queden distintos
    await admin.from('usuario').update({ activo: !activo }).eq('id_usuario', id)
    throw errorLogin
  }

  return usuario
}
