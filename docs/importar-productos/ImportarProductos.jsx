// =====================================================================
// Pantalla "Importar productos desde Excel" (front de referencia)
//
// Implementada con el mismo stack del proyecto: React + Tailwind + lucide-react.
// Para usarla en `gestor-stock-client`:
//
//   1. Copiar este archivo a `src/screens/ImportarProductos.jsx`.
//   2. Agregar la ruta en `src/routes/AppRoutes.jsx`:
//        <Route path="/productos/importar" element={<ImportarProductos ... />} />
//   3. Pasarle el token de la sesión de Supabase y un callback para refrescar:
//        <ImportarProductos token={session.access_token} onImportado={refrescar} />
//   4. Usa VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY, que el front ya tiene en `.env`.
//
// Llama a la Edge Function `importar-productos` de Supabase (no hace falta
// ningún servidor aparte). El token se recibe por prop para no acoplar esta
// pantalla al proveedor de autenticación que use el front.
// =====================================================================

import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';

// Edge Function de Supabase: POST importa, GET descarga la plantilla
const URL_IMPORTAR = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/importar-productos`;
const encabezados = (token) => ({
  apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const MAX_MB = 5;
const TIPOS_ACEPTADOS = ['.xlsx', '.xls'];

const numero = new Intl.NumberFormat('es-AR');

function extensionDe(nombre) {
  const punto = nombre.lastIndexOf('.');
  return punto === -1 ? '' : nombre.slice(punto).toLowerCase();
}

function formatearBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ImportarProductos({ token, onImportado }) {
  const [archivo, setArchivo] = useState(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [estado, setEstado] = useState('inicial'); // inicial | procesando | resultado | error
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState(null);
  const [filtroCampo, setFiltroCampo] = useState('todos');
  const inputRef = useRef(null);

  const errores = resultado?.errores ?? [];

  const campos = useMemo(
    () => [...new Set(errores.map((item) => item.campo))],
    [errores],
  );

  const erroresVisibles =
    filtroCampo === 'todos' ? errores : errores.filter((item) => item.campo === filtroCampo);

  function reiniciar() {
    setArchivo(null);
    setResultado(null);
    setError(null);
    setEstado('inicial');
    setFiltroCampo('todos');
    if (inputRef.current) inputRef.current.value = '';
  }

  function elegirArchivo(file) {
    if (!file) return;

    const extension = extensionDe(file.name);

    if (!TIPOS_ACEPTADOS.includes(extension)) {
      setError('El archivo tiene que ser de Excel (.xlsx o .xls).');
      setEstado('error');
      return;
    }

    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`El archivo supera el máximo de ${MAX_MB} MB.`);
      setEstado('error');
      return;
    }

    setArchivo(file);
    setResultado(null);
    setError(null);
    setEstado('inicial');
  }

  function soltar(evento) {
    evento.preventDefault();
    setArrastrando(false);
    elegirArchivo(evento.dataTransfer.files?.[0]);
  }

  async function importar() {
    if (!archivo || estado === 'procesando') return;

    setEstado('procesando');
    setError(null);

    const datos = new FormData();
    datos.append('archivo', archivo);

    try {
      const respuesta = await fetch(URL_IMPORTAR, {
        method: 'POST',
        headers: encabezados(token),
        body: datos,
      });

      const cuerpo = await respuesta.json().catch(() => null);

      if (!respuesta.ok) {
        setError(cuerpo?.error?.mensaje ?? `No se pudo importar (HTTP ${respuesta.status}).`);
        setEstado('error');
        return;
      }

      setResultado(cuerpo);
      setEstado('resultado');

      if (cuerpo.resumen?.productosImportados > 0) {
        onImportado?.(cuerpo);
      }
    } catch {
      setError('No se pudo conectar con el servidor. Revisá que esté funcionando.');
      setEstado('error');
    }
  }

  async function descargarPlantilla() {
    try {
      const respuesta = await fetch(URL_IMPORTAR, { headers: encabezados(token) });

      if (!respuesta.ok) throw new Error('no');

      const blob = await respuesta.blob();
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = 'plantilla-importacion-productos.xlsx';
      enlace.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('No se pudo descargar la plantilla.');
      setEstado('error');
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-[#434655]">Importar productos desde Excel</h1>
        <p className="text-sm text-slate-500 mt-1">
          Cada fila de la planilla se convierte en un producto. Antes de guardar se validan los datos.
        </p>
      </header>

      {/* Zona de carga */}
      <section
        onDragOver={(evento) => {
          evento.preventDefault();
          setArrastrando(true);
        }}
        onDragLeave={() => setArrastrando(false)}
        onDrop={soltar}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          arrastrando ? 'border-[#6b8fd6] bg-[#dce9ff]/60' : 'border-slate-200 bg-white'
        }`}
      >
        <Upload className="mx-auto text-slate-400" size={32} />
        <p className="mt-3 font-medium text-[#434655]">
          Arrastrá tu planilla acá o elegí un archivo
        </p>
        <p className="text-sm text-slate-500">.xlsx o .xls · hasta {MAX_MB} MB</p>

        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(evento) => elegirArchivo(evento.target.files?.[0])}
        />

        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-[#434655] text-white text-sm font-medium hover:bg-[#353845]"
          >
            Elegir archivo
          </button>
          <button
            type="button"
            onClick={descargarPlantilla}
            className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-[#434655] hover:bg-[#dce9ff] inline-flex items-center gap-2"
          >
            <Download size={16} /> Descargar plantilla
          </button>
        </div>

        {archivo && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#dce9ff] px-3 py-2 text-sm text-[#434655]">
            <FileSpreadsheet size={16} />
            <span className="font-medium">{archivo.name}</span>
            <span className="text-slate-500">{formatearBytes(archivo.size)}</span>
            <button type="button" onClick={reiniciar} aria-label="Quitar archivo">
              <X size={14} />
            </button>
          </div>
        )}
      </section>

      {archivo && estado !== 'resultado' && (
        <button
          type="button"
          onClick={importar}
          disabled={estado === 'procesando'}
          className="w-full py-3 rounded-lg bg-[#2f6fed] text-white font-medium hover:bg-[#255bc7] disabled:opacity-60 inline-flex items-center justify-center gap-2"
        >
          {estado === 'procesando' ? (
            <>
              <Loader2 className="animate-spin" size={18} /> Procesando la planilla…
            </>
          ) : (
            <>
              <Upload size={18} /> Importar productos
            </>
          )}
        </button>
      )}

      {/* Error general */}
      {estado === 'error' && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex gap-3">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">No se importó nada</p>
            <p>{error}</p>
          </div>
          <button type="button" onClick={reiniciar} className="text-red-700 underline">
            Reintentar
          </button>
        </div>
      )}

      {/* Resultado */}
      {estado === 'resultado' && resultado && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Tarjeta
              titulo="Registros procesados"
              valor={resultado.resumen.registrosProcesados}
              detalle={`${resultado.resumen.filasVacias} filas vacías ignoradas`}
            />
            <Tarjeta
              titulo="Productos importados"
              valor={resultado.resumen.productosImportados}
              detalle={
                resultado.resumen.categoriasNuevas.length > 0
                  ? `Categorías nuevas: ${resultado.resumen.categoriasNuevas.join(', ')}`
                  : 'Sin categorías nuevas'
              }
              tono="exito"
            />
            <Tarjeta
              titulo="Con error"
              valor={resultado.resumen.registrosConError}
              detalle={`${resultado.resumen.erroresEncontrados} mensajes de error`}
              tono={resultado.resumen.registrosConError > 0 ? 'alerta' : undefined}
            />
          </div>

          {resultado.estado === 'RECHAZADA' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              No se importó ningún producto: revisá los errores y volvé a subir la planilla.
            </div>
          )}

          {errores.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-100">
                <h2 className="font-semibold text-[#434655]">Detalle de errores</h2>
                <div className="flex items-center gap-2 text-sm">
                  <label htmlFor="filtro-campo" className="text-slate-500">
                    Columna:
                  </label>
                  <select
                    id="filtro-campo"
                    value={filtroCampo}
                    onChange={(evento) => setFiltroCampo(evento.target.value)}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-[#434655]"
                  >
                    <option value="todos">Todas</option>
                    {campos.map((campo) => (
                      <option key={campo} value={campo}>
                        {campo}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 sticky top-0">
                    <tr>
                      <th className="text-left font-medium px-4 py-2 w-16">Fila</th>
                      <th className="text-left font-medium px-4 py-2 w-28">Código</th>
                      <th className="text-left font-medium px-4 py-2">Problema</th>
                    </tr>
                  </thead>
                  <tbody>
                    {erroresVisibles.map((item, indice) => (
                      <tr key={`${item.fila}-${indice}`} className="border-t border-slate-100">
                        <td className="px-4 py-2 text-slate-500">{item.fila}</td>
                        <td className="px-4 py-2 font-medium text-[#434655]">{item.codigo ?? '—'}</td>
                        <td className="px-4 py-2 text-slate-600">{item.mensaje}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-100">
                Mostrando {erroresVisibles.length} de {errores.length} errores ·{' '}
                {numero.format(resultado.resumen.productosImportados)} productos importados en{' '}
                {resultado.duracionMs} ms
              </div>
            </section>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={reiniciar}
              className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-[#434655] hover:bg-[#dce9ff] inline-flex items-center gap-2"
            >
              <RotateCcw size={16} /> Volver a importar
            </button>
            <a
              href="/productos"
              className="px-4 py-2 rounded-lg bg-[#434655] text-white text-sm font-medium hover:bg-[#353845]"
            >
              Ver productos
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function Tarjeta({ titulo, valor, detalle, tono }) {
  const colores =
    tono === 'exito'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : tono === 'alerta'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-white text-[#434655]';

  const Icono = tono === 'exito' ? CheckCircle2 : tono === 'alerta' ? AlertTriangle : FileSpreadsheet;

  return (
    <div className={`rounded-xl border p-4 ${colores}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">
        <Icono size={14} /> {titulo}
      </div>
      <p className="text-3xl font-bold mt-1">{valor}</p>
      <p className="text-xs mt-1 opacity-70">{detalle}</p>
    </div>
  );
}
