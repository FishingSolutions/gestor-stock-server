import type { Mapeo } from './tipos.ts'

export interface TrazabilidadIA {
  id: string
  sub: string
  hash: string
  hoja: string
  mapeo: Mapeo
  exp: number
  usada: boolean
  modelo: string | null
  ms: number
}

function base64url(bytes: Uint8Array): string {
  let binario = ''
  for (const byte of bytes) binario += String.fromCharCode(byte)
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodificar(valor: string): Uint8Array {
  return Uint8Array.from(
    atob(valor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - valor.length % 4) % 4)),
    (caracter) => caracter.charCodeAt(0),
  )
}

async function claveFirma(secreto: string): Promise<CryptoKey> {
  if (secreto.length < 32) throw new Error('La clave de firma debe tener al menos 32 caracteres.')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function firmarTrazabilidad(secreto: string, payload: TrazabilidadIA): Promise<string> {
  const cuerpo = base64url(new TextEncoder().encode(JSON.stringify(payload)))
  const firma = await crypto.subtle.sign('HMAC', await claveFirma(secreto), new TextEncoder().encode(cuerpo))
  return `${cuerpo}.${base64url(new Uint8Array(firma))}`
}

export async function verificarTrazabilidad(
  secreto: string,
  token: string,
  esperado: Pick<TrazabilidadIA, 'sub' | 'hash' | 'hoja'> & Partial<Pick<TrazabilidadIA, 'id' | 'mapeo'>>,
  ahora = Date.now(),
  permitirExpirado = false,
): Promise<TrazabilidadIA | null> {
  try {
    if (token.length > 8192) return null
    const [cuerpo, firma, extra] = token.split('.')
    if (!cuerpo || !firma || extra !== undefined) return null
    const valido = await crypto.subtle.verify(
      'HMAC',
      await claveFirma(secreto),
      decodificar(firma),
      new TextEncoder().encode(cuerpo),
    )
    if (!valido) return null
    const payload = JSON.parse(new TextDecoder().decode(decodificar(cuerpo))) as TrazabilidadIA
    if (
      (esperado.id !== undefined && payload.id !== esperado.id) ||
      payload.sub !== esperado.sub || payload.hash !== esperado.hash || payload.hoja !== esperado.hoja ||
      !/^[0-9a-f]{64}$/i.test(payload.hash) ||
      !/^[0-9a-f-]{36}$/i.test(payload.sub) ||
      !payload.mapeo || typeof payload.mapeo !== 'object' || Array.isArray(payload.mapeo) ||
      (esperado.mapeo !== undefined && canonico(payload.mapeo) !== canonico(esperado.mapeo)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id) ||
      !Number.isSafeInteger(payload.exp) || (!permitirExpirado && payload.exp <= ahora) ||
      typeof payload.usada !== 'boolean' || !Number.isSafeInteger(payload.ms) || payload.ms < 0 ||
      (payload.modelo !== null && typeof payload.modelo !== 'string')
    ) return null
    return payload
  } catch {
    return null
  }
}

function canonico(valor: object): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(valor as Record<string, number>).sort(([a], [b]) => a.localeCompare(b)),
    ),
  )
}
