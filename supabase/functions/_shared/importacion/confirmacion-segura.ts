import type { FilaImportada } from './tipos.ts'

export interface DecisionImportacion {
  accion?: 'VINCULAR' | 'CREAR' | 'EXCLUIR'
  idProducto?: number
}

export class ErrorDecision extends Error {
  constructor(public codigo: string, mensaje: string) {
    super(mensaje)
  }
}

export function claveIdempotenciaValida(clave: string | null): clave is string {
  return Boolean(clave && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clave))
}

export function validarDecisiones(
  valor: unknown,
  filas: Pick<FilaImportada, 'fila'>[],
): Record<string, DecisionImportacion> {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ErrorDecision('DECISIONES_INVALIDAS', 'Las decisiones de filas no tienen un formato válido.')
  }

  const existentes = new Set(filas.map((fila) => String(fila.fila)))
  const resultado: Record<string, DecisionImportacion> = {}
  for (const [numero, decision] of Object.entries(valor)) {
    if (!/^[1-9]\d*$/.test(numero) || !existentes.has(numero)) {
      throw new ErrorDecision('DECISION_FILA_INVALIDA', `La fila "${numero}" no pertenece al archivo.`)
    }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new ErrorDecision('DECISION_INVALIDA', `La decisión de la fila ${numero} no es válida.`)
    }

    const objeto = decision as Record<string, unknown>
    if (Object.keys(objeto).some((campo) => !['accion', 'idProducto'].includes(campo))) {
      throw new ErrorDecision('DECISION_INVALIDA', `La decisión de la fila ${numero} contiene campos no permitidos.`)
    }
    const accion = objeto.accion
    if (accion !== 'VINCULAR' && accion !== 'CREAR' && accion !== 'EXCLUIR') {
      throw new ErrorDecision('DECISION_INVALIDA', `La acción de la fila ${numero} no es válida.`)
    }
    if (accion === 'VINCULAR') {
      if (!Number.isSafeInteger(objeto.idProducto) || Number(objeto.idProducto) <= 0) {
        throw new ErrorDecision('PRODUCTO_INVALIDO', `El producto elegido para la fila ${numero} no es válido.`)
      }
      resultado[numero] = { accion, idProducto: Number(objeto.idProducto) }
    } else {
      if (objeto.idProducto !== undefined) {
        throw new ErrorDecision('DECISION_INVALIDA', `La decisión de la fila ${numero} no debe incluir un producto.`)
      }
      resultado[numero] = { accion }
    }
  }
  return resultado
}

export function analisisPuedeReutilizarse(
  fila: {
    idempotency_key: string | null
    hash_archivo: string
    hoja: string
    mapeo: Record<string, number>
    expira_en: string
    ia_usada: boolean
    ia_modelo: string | null
    ia_ms: number
  },
  claims: {
    hash: string
    hoja: string
    mapeo: Record<string, number>
    usada: boolean
    modelo: string | null
    ms: number
  },
  ahora = Date.now(),
): boolean {
  if (fila.idempotency_key) return false
  const canonizar = (mapeo: Record<string, number>) =>
    JSON.stringify(Object.fromEntries(Object.entries(mapeo).sort(([a], [b]) => a.localeCompare(b))))
  return fila.hash_archivo === claims.hash &&
    fila.hoja === claims.hoja &&
    canonizar(fila.mapeo) === canonizar(claims.mapeo) &&
    fila.ia_usada === claims.usada &&
    fila.ia_modelo === claims.modelo &&
    fila.ia_ms === claims.ms &&
    new Date(fila.expira_en).getTime() > ahora
}
