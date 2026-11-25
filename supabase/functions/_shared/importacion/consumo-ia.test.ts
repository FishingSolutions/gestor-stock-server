import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ejecutarIAConReserva,
  finalizarSolicitudIA,
  reservarSolicitudIA,
  type RpcIA,
} from './consumo-ia.ts'

test('fallo de reserva es fail-closed y no devuelve un cupo', async () => {
  const rpc: RpcIA = async () => ({ data: null, error: new Error('db') })
  assert.deepEqual(await reservarSolicitudIA(rpc, 'admin', 'modelo'), { ok: false, limite: false })
  assert.deepEqual(await reservarSolicitudIA(async () => { throw new Error('offline') }, 'admin', 'modelo'), {
    ok: false,
    limite: false,
  })
  assert.deepEqual(await reservarSolicitudIA(async () => ({ data: null, error: null }), 'admin', 'modelo'), {
    ok: false,
    limite: true,
  })
})

test('finalización comprueba error, booleano false y errores de transporte sin lanzar', async () => {
  const eventos: string[] = []
  const registrar = (evento: string) => eventos.push(evento)
  assert.equal(await finalizarSolicitudIA(async () => ({ data: false, error: null }), 4, {
    usada: true, ms: 1, motivo: null,
  }, registrar), false)
  assert.equal(await finalizarSolicitudIA(async () => ({ data: null, error: new Error('db') }), 4, {
    usada: false, ms: 2, motivo: 'IA_TIMEOUT',
  }, registrar), false)
  assert.equal(await finalizarSolicitudIA(async () => { throw new Error('offline') }, 4, {
    usada: false, ms: 3, motivo: 'IA_NO_DISPONIBLE',
  }, registrar), false)
  assert.deepEqual(eventos, [
    'finalizacion_no_aplicada',
    'finalizacion_rpc_error',
    'finalizacion_transporte_error',
  ])
})

test('reserva válida y estados de finalización se transmiten sin exponer payloads', async () => {
  const llamadas: Array<{ nombre: string; parametros: Record<string, unknown> }> = []
  const rpc: RpcIA = async (nombre, parametros) => {
    llamadas.push({ nombre, parametros })
    return { data: nombre === 'reservar_solicitud_ia' ? 22 : true, error: null }
  }
  assert.deepEqual(await reservarSolicitudIA(rpc, 'admin', 'gemini'), { ok: true, id: 22 })
  assert.equal(await finalizarSolicitudIA(rpc, 22, {
    usada: false, ms: 77, motivo: 'IA_SIN_CUOTA',
  }), true)
  assert.equal(llamadas[0].parametros.p_modelo, 'gemini')
  assert.equal(llamadas[1].parametros.p_estado, 'ERROR')
  assert.equal(JSON.stringify(llamadas).includes('secret'), false)
})

test('sin reserva no se invoca el proveedor y una finalización fallida no oculta resultado', async () => {
  let llamadasProveedor = 0
  const sinCupo = await ejecutarIAConReserva(
    async () => ({ ok: false as const, limite: true }),
    async () => {
      llamadasProveedor++
      return { usada: true, ms: 1, motivo: null, sugerencias: {} }
    },
    async () => {},
    'modelo',
  )
  assert.equal(llamadasProveedor, 0)
  assert.equal(sinCupo.motivo, 'IA_LIMITE_DIARIO')

  const eventos: string[] = []
  const conCupo = await ejecutarIAConReserva(
    async () => ({ ok: true as const, id: 99 }),
    async () => ({ usada: false, ms: 25, motivo: 'IA_SIN_CUOTA', sugerencias: null }),
    async () => { throw new Error('finalización inaccesible') },
    'modelo',
    (evento) => eventos.push(evento),
  )
  assert.equal(conCupo.motivo, 'IA_SIN_CUOTA')
  assert.deepEqual(eventos, ['finalizacion_excepcion_inesperada'])
})

test('excepción inesperada del proveedor finaliza como ERROR sin segundo intento', async () => {
  let llamadasProveedor = 0
  const estados: string[] = []
  const resultado = await ejecutarIAConReserva(
    async () => ({ ok: true as const, id: 100 }),
    async () => {
      llamadasProveedor++
      throw new Error('no registrar detalles con secretos')
    },
    async (_id, value) => { estados.push(value.motivo ?? '') },
    'modelo',
  )
  assert.equal(llamadasProveedor, 1)
  assert.equal(resultado.motivo, 'IA_NO_DISPONIBLE')
  assert.deepEqual(estados, ['IA_NO_DISPONIBLE'])
})
