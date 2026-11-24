// Verifica estructura ZIP y descomprime cada entrada en streaming antes de
// entregar el XLSX a SheetJS. Solo se cuentan bytes; nunca se retiene la salida.
export const LIMITES_ZIP_XLSX = {
  entradas: 4096,
  bytesDescomprimidos: 50 * 1024 * 1024,
  bytesEntrada: 20 * 1024 * 1024,
}

type LimitesZip = typeof LIMITES_ZIP_XLSX

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const DESCRIPTOR = 0x08074b50
const CRC_TABLA = (() => {
  const tabla = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let valor = n
    for (let bit = 0; bit < 8; bit++) {
      valor = (valor & 1) ? (0xedb88320 ^ (valor >>> 1)) : (valor >>> 1)
    }
    tabla[n] = valor >>> 0
  }
  return tabla
})()

interface EntradaZip {
  flags: number
  metodo: number
  crc: number
  comprimido: number
  expandidoDeclarado: number
  localOffset: number
  nombre: Uint8Array
}

async function expandirContando(
  datos: Uint8Array,
  metodo: number,
  esperado: number,
  crcEsperado: number,
  limiteEntrada: number,
  limiteTotal: number,
  limiteTotalGlobal: number,
): Promise<number | null> {
  let cantidad = 0
  let crc = 0xffffffff
  const consumir = (parte: Uint8Array): boolean => {
    cantidad += parte.length
    if (cantidad > limiteEntrada || cantidad + limiteTotal > limiteTotalGlobal) {
      return false
    }
    for (const byte of parte) crc = CRC_TABLA[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return true
  }

  if (metodo === 0) {
    if (!consumir(datos)) return null
  } else {
    try {
      const compresion = new DecompressionStream('deflate-raw')
      const salida = new Blob([datos]).stream().pipeThrough(compresion)
      const lector = salida.getReader()
      try {
        while (true) {
          const { done, value } = await lector.read()
          if (done) break
          if (!consumir(value)) {
            await lector.cancel()
            return null
          }
        }
      } finally {
        try {
          lector.releaseLock()
        } catch {
          // Cancelación al exceder el límite.
        }
      }
    } catch {
      return null
    }
  }

  const crcReal = (crc ^ 0xffffffff) >>> 0
  return cantidad === esperado && crcReal === crcEsperado ? cantidad : null
}

/**
 * Valida estructura local/central, expande realmente cada entrada con un
 * stream limitado, y verifica longitud y CRC antes de que el parser la reciba.
 * `limites` se puede reducir en tests; producción usa los límites fijos.
 */
export async function zipXlsxSeguro(
  bytes: Uint8Array,
  limites: LimitesZip = LIMITES_ZIP_XLSX,
): Promise<boolean> {
  if (bytes.length < 22) return false
  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const inicioBusqueda = Math.max(0, bytes.length - 22 - 0xffff)
  let eocd = -1
  for (let indice = bytes.length - 22; indice >= inicioBusqueda; indice--) {
    if (vista.getUint32(indice, true) === EOCD) {
      const largoComentario = vista.getUint16(indice + 20, true)
      if (indice + 22 + largoComentario === bytes.length) {
        eocd = indice
        break
      }
    }
  }
  if (eocd < 0) return false

  const disco = vista.getUint16(eocd + 4, true)
  const discoDirectorio = vista.getUint16(eocd + 6, true)
  const entradasDisco = vista.getUint16(eocd + 8, true)
  const entradas = vista.getUint16(eocd + 10, true)
  const bytesDirectorio = vista.getUint32(eocd + 12, true)
  const offsetDirectorio = vista.getUint32(eocd + 16, true)
  const finDirectorio = offsetDirectorio + bytesDirectorio
  if (
    disco !== 0 ||
    discoDirectorio !== 0 ||
    entradasDisco !== entradas ||
    entradas === 0 ||
    entradas > limites.entradas ||
    entradas === 0xffff ||
    bytesDirectorio === 0xffffffff ||
    offsetDirectorio === 0xffffffff ||
    finDirectorio !== eocd
  ) return false

  const vistaDentro = (offset: number, largo: number) =>
    Number.isSafeInteger(offset) && Number.isSafeInteger(largo) &&
    offset >= 0 && largo >= 0 && offset + largo <= bytes.length
  const entradasZip: EntradaZip[] = []
  let posicion = offsetDirectorio

  for (let indice = 0; indice < entradas; indice++) {
    if (!vistaDentro(posicion, 46) || vista.getUint32(posicion, true) !== CENTRAL) return false
    const flags = vista.getUint16(posicion + 8, true)
    const metodo = vista.getUint16(posicion + 10, true)
    const crc = vista.getUint32(posicion + 16, true)
    const comprimido = vista.getUint32(posicion + 20, true)
    const expandidoDeclarado = vista.getUint32(posicion + 24, true)
    const largoNombre = vista.getUint16(posicion + 28, true)
    const largoExtra = vista.getUint16(posicion + 30, true)
    const largoComentario = vista.getUint16(posicion + 32, true)
    const discoInicio = vista.getUint16(posicion + 34, true)
    const localOffset = vista.getUint32(posicion + 42, true)
    const largoEntradaCentral = 46 + largoNombre + largoExtra + largoComentario
    if (
      !vistaDentro(posicion, largoEntradaCentral) ||
      posicion + largoEntradaCentral > finDirectorio ||
      discoInicio !== 0 ||
      (flags & 0x0001) !== 0 ||
      (flags & ~0x080e) !== 0 ||
      ![0, 8].includes(metodo) ||
      comprimido === 0xffffffff ||
      expandidoDeclarado === 0xffffffff ||
      comprimido > bytes.length ||
      expandidoDeclarado > limites.bytesEntrada ||
      (metodo === 0 && comprimido !== expandidoDeclarado)
    ) return false

    const nombre = bytes.slice(posicion + 46, posicion + 46 + largoNombre)
    entradasZip.push({ flags, metodo, crc, comprimido, expandidoDeclarado, localOffset, nombre })
    posicion += largoEntradaCentral
  }
  if (posicion !== finDirectorio) return false

  const intervalos: { inicio: number; fin: number }[] = []
  let totalExpandido = 0
  for (const entrada of entradasZip) {
    const { localOffset, nombre, flags, metodo, crc, comprimido, expandidoDeclarado } = entrada
    if (!vistaDentro(localOffset, 30) || vista.getUint32(localOffset, true) !== LOCAL) return false
    const flagsLocal = vista.getUint16(localOffset + 6, true)
    const metodoLocal = vista.getUint16(localOffset + 8, true)
    const crcLocal = vista.getUint32(localOffset + 14, true)
    const comprimidoLocal = vista.getUint32(localOffset + 18, true)
    const expandidoLocal = vista.getUint32(localOffset + 22, true)
    const largoNombreLocal = vista.getUint16(localOffset + 26, true)
    const largoExtraLocal = vista.getUint16(localOffset + 28, true)
    const inicioDatos = localOffset + 30 + largoNombreLocal + largoExtraLocal
    const finDatos = inicioDatos + comprimido
    if (
      flagsLocal !== flags ||
      metodoLocal !== metodo ||
      largoNombreLocal !== nombre.length ||
      !vistaDentro(localOffset + 30, largoNombreLocal + largoExtraLocal) ||
      !bytes.slice(localOffset + 30, localOffset + 30 + largoNombreLocal).every(
        (byte, indice) => byte === nombre[indice],
      ) ||
      !vistaDentro(inicioDatos, comprimido) ||
      finDatos > offsetDirectorio
    ) return false

    const tieneDescriptor = (flags & 0x0008) !== 0
    if (
      (!tieneDescriptor && (crcLocal !== crc || comprimidoLocal !== comprimido || expandidoLocal !== expandidoDeclarado)) ||
      (tieneDescriptor &&
        !((crcLocal === 0 || crcLocal === crc) &&
          (comprimidoLocal === 0 || comprimidoLocal === comprimido) &&
          (expandidoLocal === 0 || expandidoLocal === expandidoDeclarado)))
    ) return false

    let finEntrada = finDatos
    if (tieneDescriptor) {
      const coincideDescriptor = (offset: number) =>
        vistaDentro(offset, 12) &&
        vista.getUint32(offset, true) === crc &&
        vista.getUint32(offset + 4, true) === comprimido &&
        vista.getUint32(offset + 8, true) === expandidoDeclarado
      if (
        vistaDentro(finDatos, 16) &&
        vista.getUint32(finDatos, true) === DESCRIPTOR &&
        coincideDescriptor(finDatos + 4)
      ) {
        finEntrada = finDatos + 16
      } else if (coincideDescriptor(finDatos)) {
        finEntrada = finDatos + 12
      } else {
        return false
      }
    }
    intervalos.push({ inicio: localOffset, fin: finEntrada })

    const expandidoReal = await expandirContando(
      bytes.subarray(inicioDatos, finDatos),
      metodo,
      expandidoDeclarado,
      crc,
      limites.bytesEntrada,
      totalExpandido,
      limites.bytesDescomprimidos,
    )
    if (expandidoReal === null) return false
    totalExpandido += expandidoReal
    if (totalExpandido > limites.bytesDescomprimidos) return false
  }

  intervalos.sort((a, b) => a.inicio - b.inicio)
  let finAnterior = 0
  for (const intervalo of intervalos) {
    if (intervalo.inicio < finAnterior || intervalo.fin > offsetDirectorio) return false
    finAnterior = intervalo.fin
  }
  return true
}
