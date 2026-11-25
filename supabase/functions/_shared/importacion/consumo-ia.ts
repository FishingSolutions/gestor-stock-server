export interface RpcIA {
  (nombre: string, parametros: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>
}

export interface ResultadoProveedorIA {
  usada: boolean
  ms: number
  motivo: string | null
}

export type ReservaIA =
  | { ok: true; id: number }
  | { ok: false; limite: boolean }

export async function ejecutarIAConReserva<T extends ResultadoProveedorIA & { sugerencias: unknown }>(
  reservar: () => Promise<ReservaIA>,
  proveedor: () => Promise<T>,
  finalizar: (id: number, resultado: T) => Promise<unknown>,
  modelo: string | null,
  registrarError: (evento: string) => void = () => {},
): Promise<T> {
  let reserva: ReservaIA
  try {
    reserva = await reservar()
  } catch {
    registrarError('reserva_excepcion')
    reserva = { ok: false, limite: false }
  }
  if (!reserva.ok) {
    return {
      usada: false,
      modelo: null,
      ms: 0,
      motivo: reserva.limite ? 'IA_LIMITE_DIARIO' : 'IA_CONTROL_NO_DISPONIBLE',
      sugerencias: null,
    } as T
  }

  let resultado: T
  try {
    resultado = await proveedor()
  } catch {
    registrarError('proveedor_excepcion_inesperada')
    resultado = {
      usada: false,
      modelo,
      ms: 0,
      motivo: 'IA_NO_DISPONIBLE',
      sugerencias: null,
    } as T
  }
  try {
    await finalizar(reserva.id, resultado)
  } catch {
    // Error técnico de finalización: no ocultar el resultado ni liberar cupo.
    registrarError('finalizacion_excepcion_inesperada')
  }
  return resultado
}

export async function reservarSolicitudIA(
  rpc: RpcIA,
  idUsuario: string,
  modelo: string | null,
  registrarError: (evento: string) => void = () => {},
): Promise<ReservaIA> {
  try {
    const { data, error } = await rpc('reservar_solicitud_ia', {
      p_id_usuario: idUsuario,
      p_modelo: modelo,
    })
    if (error) {
      registrarError('reserva_rpc_error')
      return { ok: false, limite: false }
    }
    if (data === null) return { ok: false, limite: true }
    const id = Number(data)
    if (!Number.isSafeInteger(id) || id <= 0) {
      registrarError('reserva_respuesta_invalida')
      return { ok: false, limite: false }
    }
    return { ok: true, id }
  } catch {
    registrarError('reserva_transporte_error')
    return { ok: false, limite: false }
  }
}

/** No libera reservas ni reintenta el proveedor; solicitudes sin finalizar siguen contando. */
export async function finalizarSolicitudIA(
  rpc: RpcIA,
  id: number,
  resultado: ResultadoProveedorIA,
  registrarError: (evento: string) => void = () => {},
): Promise<boolean> {
  const estado = resultado.usada ? 'EXITOSA' : resultado.motivo === 'IA_TIMEOUT' ? 'TIMEOUT' : 'ERROR'
  try {
    const { data, error } = await rpc('finalizar_solicitud_ia', {
      p_id_solicitud: id,
      p_estado: estado,
      p_duracion_ms: Math.max(0, Math.trunc(resultado.ms)),
      p_motivo: resultado.motivo,
    })
    if (error) {
      registrarError('finalizacion_rpc_error')
      return false
    }
    if (data !== true) {
      registrarError('finalizacion_no_aplicada')
      return false
    }
    return true
  } catch {
    registrarError('finalizacion_transporte_error')
    return false
  }
}
