import React, { useEffect, useState } from 'react';
import { formatearFechaHoraAR } from '../../domain/dinero.ts';
import { tienePermiso, type RolUsuario } from '../../domain/permisos.ts';
import {
  validarConfiguracionSupabaseCliente,
  type ResumenEstadoSyncUI,
} from '../../domain/sync.ts';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';

export interface ConfiguracionSistemaDTO {
  comercio_id: string;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  sync_automatico_habilitado: boolean;
  sync_intervalo_minutos: number;
  carpeta_backups: string;
  backup_diario_habilitado: boolean;
  ultimo_backup_at: string | null;
  ultimo_backup_archivo: string | null;
  updated_at: string;
}

export interface RegistroHistorialBackupDTO {
  id: string;
  comercio_id: string;
  fecha: string;
  ruta_archivo: string;
  tamano_bytes: number;
  tipo: 'automatico_diario' | 'manual' | 'previo_restauracion';
  usuario_id: string | null;
  created_at: string;
}

export interface EstadisticasEspacioImagenesDTO {
  cantidadArchivos: number;
  bytesTotales: number;
  kbTotales: number;
  mbTotales: number;
  porcentajeCuotaGratuita: number;
}

export interface PanelConfiguracionSyncProps {
  rolActivo: RolUsuario;
  estadoSync: ResumenEstadoSyncUI;
  configuracionInicial: ConfiguracionSistemaDTO | null;
  historialBackupsInicial: RegistroHistorialBackupDTO[];
  espacioImagenes: EstadisticasEspacioImagenesDTO;
  onSubirAhora: () => Promise<void>;
  onBajarAhora: () => Promise<void>;
  onSincronizarCicloCompleto: () => Promise<void>;
  onDatosActualizados: () => void;
}

function descargarBase64ComoArchivo(
  base64: string,
  nombreArchivo: string,
  mimeType: string
): void {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) {
    bytes[i] = binario.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function PanelConfiguracionSync({
  rolActivo,
  estadoSync,
  configuracionInicial,
  historialBackupsInicial,
  espacioImagenes,
  onSubirAhora,
  onBajarAhora,
  onSincronizarCicloCompleto,
  onDatosActualizados,
}: PanelConfiguracionSyncProps): React.ReactElement {
  const puedeConfigurar = tienePermiso(rolActivo, 'configuracion_sensible');

  const [supabaseUrl, setSupabaseUrl] = useState(
    configuracionInicial?.supabase_url ?? ''
  );
  const [supabaseAnonKey, setSupabaseAnonKey] = useState(
    configuracionInicial?.supabase_anon_key ?? ''
  );
  const [syncAuto, setSyncAuto] = useState(
    configuracionInicial?.sync_automatico_habilitado ?? true
  );
  const [intervaloMinutos, setIntervaloMinutos] = useState(
    String(configuracionInicial?.sync_intervalo_minutos ?? 5)
  );
  const [carpetaBackups, setCarpetaBackups] = useState(
    configuracionInicial?.carpeta_backups ?? 'backups'
  );
  const [backupDiario, setBackupDiario] = useState(
    configuracionInicial?.backup_diario_habilitado ?? true
  );
  const [rutaRestauracionManual, setRutaRestauracionManual] = useState('');

  const [procesando, setProcesando] = useState(false);
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);
  const [mensajeError, setMensajeError] = useState<string | null>(null);

  useEffect(() => {
    if (configuracionInicial) {
      setSupabaseUrl(configuracionInicial.supabase_url ?? '');
      setSupabaseAnonKey(configuracionInicial.supabase_anon_key ?? '');
      setSyncAuto(configuracionInicial.sync_automatico_habilitado);
      setIntervaloMinutos(String(configuracionInicial.sync_intervalo_minutos));
      setCarpetaBackups(configuracionInicial.carpeta_backups);
      setBackupDiario(configuracionInicial.backup_diario_habilitado);
    }
  }, [configuracionInicial]);

  if (!puedeConfigurar) {
    return (
      <section className="card" aria-label="Acceso restringido a configuración">
        <h2>Configuración, Sincronización y Backups</h2>
        <p className="alert-error">
          Acceso restringido: Solo el rol <strong>superadmin</strong> puede
          administrar la sincronización en la nube, configurar backups o
          restaurar copias de seguridad (PLAN.md §6.1).
        </p>
      </section>
    );
  }

  async function manejarGuardarConfiguracion(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeExito(null);

    const validacion = validarConfiguracionSupabaseCliente(
      supabaseUrl,
      supabaseAnonKey
    );
    if (!validacion.valida) {
      setMensajeError(validacion.motivo ?? 'Configuración de Supabase inválida.');
      return;
    }

    setProcesando(true);
    try {
      await invocarPosApi('guardar_configuracion_sistema', {
        rolActivo,
        supabaseUrl: supabaseUrl.trim() || null,
        supabaseAnonKey: supabaseAnonKey.trim() || null,
        syncAutomaticoHabilitado: syncAuto,
        syncIntervaloMinutos: Number(intervaloMinutos) || 5,
        carpetaBackups: carpetaBackups.trim() || 'backups',
        backupDiarioHabilitado: backupDiario,
      });
      setMensajeExito(
        'Configuración guardada en SQLite y registrada en la auditoría.'
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo guardar la configuración.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarAccionSync(
    tipo: 'subir' | 'bajar' | 'completo'
  ): Promise<void> {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      if (tipo === 'subir') {
        await onSubirAhora();
        setMensajeExito(
          'Subida de datos e imágenes (Push) completada correctamente.'
        );
      } else if (tipo === 'bajar') {
        await onBajarAhora();
        setMensajeExito(
          'Bajada de datos e imágenes (Pull) completada correctamente.'
        );
      } else {
        await onSincronizarCicloCompleto();
        setMensajeExito(
          'Ciclo completo (Push + Pull + Cola de Imágenes) finalizado.'
        );
      }
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Error durante la sincronización.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarCrearBackupAhora() {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const bkp = await invocarPosApi<RegistroHistorialBackupDTO>(
        'crear_backup_manual',
        { rolActivo }
      );
      setMensajeExito(
        `Copia de seguridad creada con éxito en: ${bkp.ruta_archivo}`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al crear el backup.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarExportarTodoAExcel() {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const res = await invocarPosApi<{
        xlsxBase64: string;
        bytesLength: number;
      }>('exportar_todo_excel', { rolActivo });
      const hoy = new Date().toISOString().slice(0, 10);
      descargarBase64ComoArchivo(
        res.xlsxBase64,
        `pos_exportacion_completa_${hoy}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      setMensajeExito(
        `Exportación completa generada (${Math.round(res.bytesLength / 1024)} KB) y registrada en auditoría.`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al exportar a Excel.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarRestaurarBackup(rutaArchivo: string) {
    if (!rutaArchivo.trim()) {
      setMensajeError('Indicá la ruta del archivo .db de backup a restaurar.');
      return;
    }

    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const res = await invocarPosApi<{
        backupResguardoPrevio: RegistroHistorialBackupDTO;
        registrosRestaurados: number;
      }>('restaurar_desde_backup', {
        rolActivo,
        rutaArchivoBackup: rutaArchivo.trim(),
      });
      setMensajeExito(
        `Base restaurada (${res.registrosRestaurados} registros). Se guardó resguardo previo automático en: ${res.backupResguardoPrevio.ruta_archivo}`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al restaurar desde backup.'
      );
    } finally {
      setProcesando(false);
    }
  }

  return (
    <div className="pos-grid">
      <div>
        {mensajeExito ? (
          <div className="alert-ok" role="status">
            {mensajeExito}
          </div>
        ) : null}
        {mensajeError ? (
          <div className="alert-error" role="alert">
            {mensajeError}
          </div>
        ) : null}

        <section className="card" style={{ marginBottom: '1rem' }}>
          <h2>Estado de Sincronización (Nube Supabase)</h2>
          <p style={{ color: '#475569', fontSize: '0.9rem' }}>
            La base SQLite local es la fuente de verdad de trabajo. Primero
            sincronizan los datos y después, en segundo plano y con su propia
            cola, las imágenes WebP de los productos (PLAN.md §5 y §5.1).
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.75rem',
              margin: '1rem 0',
            }}
          >
            <div className="stat-box">
              <div className="stat-label">Estado actual</div>
              <div className="stat-value" style={{ fontSize: '1.1rem' }}>
                {estadoSync.etiqueta}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Cola de Datos</div>
              <div className="stat-value">
                {estadoSync.datosPendientes} pendientes
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Cola de Imágenes (separada)</div>
              <div className="stat-value">
                {estadoSync.imagenesPendientes} pendientes
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Última subida / bajada</div>
              <div style={{ fontSize: '0.82rem', marginTop: '0.25rem' }}>
                <div>
                  ↑{' '}
                  {estadoSync.ultimaSubidaAt
                    ? formatearFechaHoraAR(estadoSync.ultimaSubidaAt)
                    : 'Sin subidas aún'}
                </div>
                <div>
                  ↓{' '}
                  {estadoSync.ultimaBajadaAt
                    ? formatearFechaHoraAR(estadoSync.ultimaBajadaAt)
                    : 'Sin bajadas aún'}
                </div>
              </div>
            </div>
          </div>

          {estadoSync.ultimoErrorDetalle ? (
            <div className="alert-error" style={{ marginBottom: '0.75rem' }}>
              <strong>Detalle del último error:</strong>{' '}
              {estadoSync.ultimoErrorDetalle}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={procesando}
              onClick={() => void manejarAccionSync('subir')}
            >
              ↑ Subir datos ahora
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={procesando}
              onClick={() => void manejarAccionSync('bajar')}
            >
              ↓ Bajar datos ahora
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={procesando}
              onClick={() => void manejarAccionSync('completo')}
            >
              ⟳ Sincronizar todo (Datos + Imágenes)
            </button>
          </div>
        </section>

        <section className="card">
          <h2>Parámetros de Conexión Supabase y Backups</h2>
          <form onSubmit={(e) => void manejarGuardarConfiguracion(e)}>
            <div className="form-group">
              <label htmlFor="cfg-supabase-url">
                URL del Proyecto Supabase (opcional en modo 100% local)
              </label>
              <input
                id="cfg-supabase-url"
                type="text"
                placeholder="https://tu-proyecto.supabase.co"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="cfg-supabase-key">
                Clave pública de Supabase (<code>anon</code> /{' '}
                <code>publishable</code>)
              </label>
              <input
                id="cfg-supabase-key"
                type="password"
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... (Solo clave anon pública)"
                value={supabaseAnonKey}
                onChange={(e) => setSupabaseAnonKey(e.target.value)}
              />
              <small style={{ color: '#64748b' }}>
                Regla 8: Nunca ingreses la clave <code>service_role</code> ni{' '}
                <code>sb_secret_</code>. El sistema las bloquea por seguridad y
                aplica Row Level Security (RLS).
              </small>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '0.75rem',
              }}
            >
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={syncAuto}
                    onChange={(e) => setSyncAuto(e.target.checked)}
                  />{' '}
                  Sincronizar automáticamente en segundo plano
                </label>
              </div>
              <div className="form-group">
                <label htmlFor="cfg-intervalo">
                  Intervalo periódico (minutos)
                </label>
                <input
                  id="cfg-intervalo"
                  type="number"
                  min={1}
                  max={1440}
                  value={intervaloMinutos}
                  onChange={(e) => setIntervaloMinutos(e.target.value)}
                />
              </div>
            </div>

            <hr style={{ margin: '1rem 0', borderColor: '#e2e8f0' }} />

            <div className="form-group">
              <label htmlFor="cfg-carpeta-backups">
                Carpeta de Backups locales (podés apuntarla a Google Drive,
                Dropbox o un pendrive)
              </label>
              <input
                id="cfg-carpeta-backups"
                type="text"
                placeholder="backups o C:\Users\...\Google Drive\BackupsPOS"
                value={carpetaBackups}
                onChange={(e) => setCarpetaBackups(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={backupDiario}
                  onChange={(e) => setBackupDiario(e.target.checked)}
                />{' '}
                Realizar copia diaria automática del archivo SQLite
              </label>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={procesando}
            >
              Guardar configuración
            </button>
          </form>
        </section>
      </div>

      <div>
        <section className="card" style={{ marginBottom: '1rem' }}>
          <h2>Espacio usado por Imágenes de Productos (§5.1)</h2>
          <p style={{ fontSize: '0.88rem', color: '#475569' }}>
            Todas las fotos se convierten a WebP (&le; 150 KB) + miniatura (200
            px) y sin metadatos EXIF/GPS para proteger el plan gratuito.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '0.5rem',
              marginTop: '0.75rem',
            }}
          >
            <div className="stat-box">
              <div className="stat-label">Archivos WebP</div>
              <div className="stat-value">
                {espacioImagenes.cantidadArchivos}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Espacio en disco</div>
              <div className="stat-value">{espacioImagenes.kbTotales} KB</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Cuota 1 GB Nube</div>
              <div className="stat-value">
                {espacioImagenes.porcentajeCuotaGratuita}%
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Backups Independientes y Restauración (§5)</h2>
          <div
            style={{
              display: 'flex',
              gap: '0.6rem',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}
          >
            <button
              type="button"
              className="btn btn-primary"
              disabled={procesando}
              onClick={() => void manejarCrearBackupAhora()}
            >
              Crear backup SQLite ahora
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={procesando}
              onClick={() => void manejarExportarTodoAExcel()}
            >
              Exportar todo a Excel (.xlsx)
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '1rem',
              alignItems: 'flex-end',
            }}
          >
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label htmlFor="input-restaurar-ruta">
                Restaurar desde ruta de archivo <code>.db</code>
              </label>
              <input
                id="input-restaurar-ruta"
                type="text"
                placeholder="Ruta al archivo .db de backup..."
                value={rutaRestauracionManual}
                onChange={(e) => setRutaRestauracionManual(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-danger"
              disabled={procesando || !rutaRestauracionManual.trim()}
              onClick={() => void manejarRestaurarBackup(rutaRestauracionManual)}
            >
              Restaurar desde backup
            </button>
          </div>

          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>
            Historial de copias locales recientes
          </h3>
          <table className="pos-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Tamaño</th>
                <th>Archivo</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {historialBackupsInicial.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center' }}>
                    Aún no hay copias registradas.
                  </td>
                </tr>
              ) : (
                historialBackupsInicial.map((b) => (
                  <tr key={b.id}>
                    <td>{formatearFechaHoraAR(b.fecha)}</td>
                    <td>
                      {b.tipo === 'automatico_diario'
                        ? 'Diario automático'
                        : b.tipo === 'previo_restauracion'
                          ? 'Resguardo pre-restauración'
                          : 'Manual'}
                    </td>
                    <td>{Math.round(b.tamano_bytes / 1024)} KB</td>
                    <td
                      style={{
                        maxWidth: '200px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '0.8rem',
                      }}
                      title={b.ruta_archivo}
                    >
                      {b.ruta_archivo}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: '0.2rem 0.5rem', fontSize: '0.78rem' }}
                        disabled={procesando}
                        onClick={() =>
                          void manejarRestaurarBackup(b.ruta_archivo)
                        }
                      >
                        Restaurar
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
