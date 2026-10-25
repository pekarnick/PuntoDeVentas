import React, { useEffect, useState } from 'react';
import {
  generarQrSvgUrlPublica,
  validarUrlPublicaVentaMovil,
} from '@pos/domain';
import { formatearFechaHoraAR } from '../../domain/dinero.ts';
import { tienePermiso, type RolUsuario } from '../../domain/permisos.ts';
import {
  validarConfiguracionSupabaseCliente,
  type ResumenEstadoSyncUI,
} from '../../domain/sync.ts';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';

export interface SesionMovilResumenDTO {
  readonly id: string;
  readonly usuario_id: string;
  readonly usuario_nombre: string;
  readonly usuario_login: string;
  readonly dispositivo_id: string;
  readonly dispositivo_nombre: string;
  readonly user_agent: string | null;
  readonly iniciada_at: string;
  readonly ultima_actividad_at: string;
  readonly expira_at: string;
  readonly estado: 'activa' | 'revocada' | 'expirada' | 'cerrada';
  readonly revocada_at: string | null;
  readonly motivo_revocacion: string | null;
}

export interface EstadoConfigVentaMovilDTO {
  readonly comercio_id: string;
  readonly comercio_nombre: string;
  readonly venta_movil_habilitada: boolean;
  readonly venta_movil_url: string;
  readonly qr_svg: string;
  readonly sesiones: readonly SesionMovilResumenDTO[];
  readonly usuarios_moviles: readonly {
    readonly id: string;
    readonly nombre: string;
    readonly usuario: string;
    readonly rol: string;
    readonly activo: boolean;
    readonly puede_vender_movil: boolean;
  }[];
}

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
  configVentaMovilInicial?: EstadoConfigVentaMovilDTO | null;
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
  configVentaMovilInicial = null,
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

  const [configMovil, setConfigMovil] =
    useState<EstadoConfigVentaMovilDTO | null>(configVentaMovilInicial);
  const [ventaMovilHabilitada, setVentaMovilHabilitada] = useState(
    configVentaMovilInicial?.venta_movil_habilitada ?? false
  );
  const [ventaMovilUrl, setVentaMovilUrl] = useState(
    configVentaMovilInicial?.venta_movil_url ??
      (typeof window !== 'undefined'
        ? `${window.location.origin}/web-pos/`
        : 'https://pos-movil.ejemplo.com/web-pos')
  );

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

  useEffect(() => {
    if (configVentaMovilInicial) {
      setConfigMovil(configVentaMovilInicial);
      setVentaMovilHabilitada(configVentaMovilInicial.venta_movil_habilitada);
      setVentaMovilUrl(configVentaMovilInicial.venta_movil_url);
    }
  }, [configVentaMovilInicial]);

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

  const [confirmandoReset, setConfirmandoReset] = useState(false);

  async function manejarGuardarVentaMovil(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeExito(null);

    let urlValidada: string;
    try {
      urlValidada = validarUrlPublicaVentaMovil(ventaMovilUrl);
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Dirección de Venta Móvil inválida.'
      );
      return;
    }

    setProcesando(true);
    try {
      const actualizado = await invocarPosApi<EstadoConfigVentaMovilDTO>(
        'configurar_venta_movil',
        {
          rolActivo,
          habilitada: ventaMovilHabilitada,
          urlPublica: urlValidada,
        }
      );
      setConfigMovil(actualizado);
      setVentaMovilHabilitada(actualizado.venta_movil_habilitada);
      setVentaMovilUrl(actualizado.venta_movil_url);
      setMensajeExito(
        `Venta Móvil ${
          actualizado.venta_movil_habilitada ? 'habilitada' : 'deshabilitada'
        } y QR actualizado (Regla 19).`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo actualizar la configuración de Venta Móvil.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarTogglePermisoMovilUsuario(
    usuarioId: string,
    nuevoValor: boolean
  ) {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const actualizado = await invocarPosApi<EstadoConfigVentaMovilDTO>(
        'actualizar_permiso_venta_movil',
        {
          rolActivo,
          usuarioObjetivoId: usuarioId,
          puedeVenderMovil: nuevoValor,
        }
      );
      setConfigMovil(actualizado);
      setMensajeExito(
        `Permiso de Venta Móvil ${
          nuevoValor ? 'otorgado' : 'revocado'
        } y registrado en auditoría.`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo actualizar el permiso de Venta Móvil.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarRevocarSesionMovil(sesionId: string) {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const actualizado = await invocarPosApi<EstadoConfigVentaMovilDTO>(
        'revocar_sesion_movil',
        {
          rolActivo,
          sesionId,
          motivo: 'Sesión revocada desde el panel de Configuración de escritorio',
        }
      );
      setConfigMovil(actualizado);
      setMensajeExito(
        'Sesión móvil revocada inmediatamente y registrada en auditoría.'
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo revocar la sesión móvil.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarCopiarUrlMovil() {
    setMensajeError(null);
    try {
      const urlLimpia = validarUrlPublicaVentaMovil(ventaMovilUrl);
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(urlLimpia);
      }
      setMensajeExito(`Dirección copiada al portapapeles: ${urlLimpia}`);
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo copiar la dirección.'
      );
    }
  }

  function manejarImprimirQrMovil() {
    setMensajeError(null);
    try {
      const { svg, urlValidada } = generarQrSvgUrlPublica(ventaMovilUrl, 320);
      if (typeof window !== 'undefined') {
        const win = window.open('', '_blank', 'width=540,height=680');
        if (win) {
          win.document.write(`<!doctype html>
<html lang="es-AR">
<head>
  <meta charset="utf-8" />
  <title>Imprimir QR Venta Móvil</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 32px; color: #0f172a; }
    .box { border: 2px solid #0f172a; border-radius: 16px; padding: 24px; max-width: 380px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { font-size: 13px; color: #475569; word-break: break-all; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${configMovil?.comercio_nombre ?? 'Punto de Venta'} — Venta Móvil</h1>
    <p>Escaneá el código con la cámara del celular e ingresá con tu usuario y clave:</p>
    <div style="margin: 16px 0;">${svg}</div>
    <p><strong>${urlValidada}</strong></p>
  </div>
  <script>window.onload = () => { window.print(); };</script>
</body>
</html>`);
          win.document.close();
        }
      }
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Dirección inválida para generar el QR imprimible.'
      );
    }
  }

  let qrPreviewSvg: string | null = configMovil?.qr_svg ?? null;
  let errorValidacionUrlMovil: string | null = null;
  try {
    qrPreviewSvg = generarQrSvgUrlPublica(ventaMovilUrl, 190).svg;
  } catch (err) {
    errorValidacionUrlMovil =
      err instanceof Error ? err.message : 'URL inválida.';
  }

  async function manejarResetearBaseDatos() {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const res = await invocarPosApi<{
        backupResguardoPrevio: RegistroHistorialBackupDTO;
        superadminConservado: string;
      }>('resetear_base_datos', { rolActivo });
      setConfirmandoReset(false);
      setMensajeExito(
        `Base de datos reiniciada a cero. Se conservó únicamente al administrador (${res.superadminConservado}), el comercio, la lista General y las credenciales de Supabase. Resguardo previo en: ${res.backupResguardoPrevio.ruta_archivo}`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Error al reiniciar la base de datos.'
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

        <section className="card" style={{ marginBottom: '1.25rem' }}>
          <h2>Estado de Sincronización (Nube Supabase)</h2>
          <p className="text-muted">
            La base SQLite local es la fuente de verdad de trabajo. Primero
            sincronizan los datos y después, en segundo plano y con su propia
            cola, las imágenes WebP de los productos (PLAN.md §5 y §5.1).
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: '0.75rem',
              margin: '0.5rem 0',
            }}
          >
            <div className="stat-box">
              <div className="stat-label">Estado actual</div>
              <div className="stat-value" style={{ fontSize: '1.05rem' }}>
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
              <div className="stat-label">Cola de Imágenes</div>
              <div className="stat-value">
                {estadoSync.imagenesPendientes} pendientes
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Última subida / bajada</div>
              <div style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
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
                URL del Proyecto Supabase (guardada en tabla{' '}
                <code>configuracion_sistema</code> de SQLite)
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
              <small style={{ color: '#64748b', lineHeight: 1.4 }}>
                Regla 8: Se guarda localmente en{' '}
                <code>data/pos_local.db</code> (tabla{' '}
                <code>configuracion_sistema</code>). Nunca ingreses la clave{' '}
                <code>service_role</code> ni <code>sb_secret_</code>.
              </small>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '0.85rem',
                alignItems: 'center',
              }}
            >
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={syncAuto}
                    onChange={(e) => setSyncAuto(e.target.checked)}
                  />
                  <span>Sincronizar automáticamente en segundo plano</span>
                </label>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
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
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={backupDiario}
                  onChange={(e) => setBackupDiario(e.target.checked)}
                />
                <span>Realizar copia diaria automática del archivo SQLite</span>
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

        <section className="card" style={{ marginTop: '1.25rem' }}>
          <h2>Venta Móvil Web (/web-pos) — QR y Sesiones Activas (§6.2)</h2>
          <p className="text-muted">
            Publicada en HTTPS contra Supabase (sin certificados ni servidor
            local en la red del comercio). El código QR contiene{' '}
            <strong>solo la URL pública</strong> (Regla 19) y nunca expone{' '}
            <code>costo_compra</code> (Regla 20).
          </p>

          <form onSubmit={(e) => void manejarGuardarVentaMovil(e)}>
            <div className="form-group">
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={ventaMovilHabilitada}
                  onChange={(e) => setVentaMovilHabilitada(e.target.checked)}
                />
                <span>
                  <strong>Habilitar Venta Móvil en este comercio</strong>
                </span>
              </label>
            </div>

            <div className="form-group">
              <label htmlFor="cfg-venta-movil-url">
                Dirección pública de la PWA móvil (HTTPS o localhost en desarrollo)
              </label>
              <input
                id="cfg-venta-movil-url"
                type="text"
                value={ventaMovilUrl}
                onChange={(e) => setVentaMovilUrl(e.target.value)}
                placeholder="https://mi-comercio.vercel.app/web-pos"
              />
              {errorValidacionUrlMovil ? (
                <small style={{ color: '#b91c1c', display: 'block', marginTop: '0.25rem' }}>
                  {errorValidacionUrlMovil}
                </small>
              ) : (
                <small style={{ color: '#64748b', display: 'block', marginTop: '0.25rem' }}>
                  Regla 19: El QR solo codifica esta URL pública, jamás claves ni tokens.
                </small>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'center',
                flexWrap: 'wrap',
                margin: '0.75rem 0',
                padding: '0.75rem',
                background: '#f8fafc',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0',
              }}
            >
              {qrPreviewSvg ? (
                <div
                  aria-label="Vista previa Código QR Venta Móvil"
                  style={{
                    background: '#ffffff',
                    padding: '0.4rem',
                    borderRadius: '0.5rem',
                    border: '1px solid #cbd5e1',
                    lineHeight: 0,
                  }}
                  dangerouslySetInnerHTML={{ __html: qrPreviewSvg }}
                />
              ) : null}

              <div style={{ flex: 1, minWidth: '210px' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                  Estado:{' '}
                  <span
                    style={{
                      color: ventaMovilHabilitada ? '#15803d' : '#b45309',
                    }}
                  >
                    {ventaMovilHabilitada ? 'Activa' : 'Deshabilitada'}
                  </span>
                </div>
                <p
                  className="text-muted"
                  style={{ fontSize: '0.82rem', marginBottom: '0.65rem' }}
                >
                  El vendedor escanea el QR con la cámara del celular e ingresa
                  con su usuario y clave individual.
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={procesando || Boolean(errorValidacionUrlMovil)}
                  >
                    Guardar Venta Móvil
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={Boolean(errorValidacionUrlMovil)}
                    onClick={() => void manejarCopiarUrlMovil()}
                  >
                    Copiar dirección
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={Boolean(errorValidacionUrlMovil)}
                    onClick={manejarImprimirQrMovil}
                  >
                    Imprimir QR
                  </button>
                  <a
                    href="/web-pos/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ textDecoration: 'none' }}
                  >
                    Abrir /web-pos ↗
                  </a>
                </div>
              </div>
            </div>
          </form>

          <h3 style={{ marginTop: '1rem' }}>
            Usuarios autorizados para Venta Móvil (<code>puede_vender_movil</code>)
          </h3>
          <div className="table-scroll" style={{ marginBottom: '1rem' }}>
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Puede vender desde el celular</th>
                </tr>
              </thead>
              <tbody>
                {(configMovil?.usuarios_moviles ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center' }}>
                      Sin usuarios cargados.
                    </td>
                  </tr>
                ) : (
                  (configMovil?.usuarios_moviles ?? []).map((u) => (
                    <tr key={u.id}>
                      <td>{u.nombre}</td>
                      <td>
                        <code>{u.usuario}</code>
                      </td>
                      <td>{u.rol}</td>
                      <td>
                        <label
                          className="checkbox-inline"
                          style={{ cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={u.puede_vender_movil}
                            disabled={procesando}
                            onChange={(e) =>
                              void manejarTogglePermisoMovilUsuario(
                                u.id,
                                e.target.checked
                              )
                            }
                          />
                          <span>
                            {u.puede_vender_movil ? 'Autorizado' : 'Sin acceso'}
                          </span>
                        </label>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h3>Sesiones móviles registradas y revocación inmediata</h3>
          <div className="table-scroll">
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Vendedor</th>
                  <th>Dispositivo</th>
                  <th>Última actividad</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {(configMovil?.sesiones ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center' }}>
                      No hay sesiones móviles registradas todavía.
                    </td>
                  </tr>
                ) : (
                  (configMovil?.sesiones ?? []).map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.usuario_nombre} (<code>{s.usuario_login}</code>)
                      </td>
                      <td>{s.dispositivo_nombre}</td>
                      <td>{formatearFechaHoraAR(s.ultima_actividad_at)}</td>
                      <td>
                        <strong>{s.estado.toUpperCase()}</strong>
                      </td>
                      <td>
                        {s.estado === 'activa' ? (
                          <button
                            type="button"
                            className="btn btn-danger"
                            style={{
                              padding: '0.25rem 0.55rem',
                              fontSize: '0.78rem',
                            }}
                            disabled={procesando}
                            onClick={() => void manejarRevocarSesionMovil(s.id)}
                          >
                            Revocar sesión
                          </button>
                        ) : (
                          <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                            {s.motivo_revocacion ?? 'Finalizada'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div>
        <section className="card" style={{ marginBottom: '1.25rem' }}>
          <h2>Espacio usado por Imágenes de Productos (§5.1)</h2>
          <p className="text-muted">
            Todas las fotos se convierten a WebP (&le; 150 KB) + miniatura (200
            px) y sin metadatos EXIF/GPS para proteger el plan gratuito.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '0.65rem',
              marginTop: '0.35rem',
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

        <section className="card" style={{ marginBottom: '1.25rem' }}>
          <h2>Backups Independientes y Restauración (§5)</h2>
          <div
            style={{
              display: 'flex',
              gap: '0.6rem',
              flexWrap: 'wrap',
              marginBottom: '0.75rem',
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
              marginBottom: '0.75rem',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
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

          <h3>Historial de copias locales recientes</h3>
          <div className="table-scroll">
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
                            ? 'Resguardo previo'
                            : 'Manual'}
                      </td>
                      <td>{Math.round(b.tamano_bytes / 1024)} KB</td>
                      <td
                        style={{
                          maxWidth: '180px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: '0.8rem',
                        }}
                        title={b.ruta_archivo}
                      >
                        {b.ruta_archivo.split(/[\\/]/).pop() ?? b.ruta_archivo}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.55rem', fontSize: '0.78rem' }}
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
          </div>
        </section>

        <section className="card danger-zone-card">
          <h2>Zona de Mantenimiento: Reiniciar Base de Datos a Cero</h2>
          <p className="text-muted">
            Limpia todos los productos, movimientos de stock, sesiones de caja,
            ventas y usuarios secundarios. Deja únicamente los datos fijos:{' '}
            <strong>el comercio</strong>,{' '}
            <strong>un único administrador (superadmin)</strong>,{' '}
            <strong>la lista de precios General</strong> y las{' '}
            <strong>credenciales de Supabase</strong>. Antes de vaciar, guarda
            un backup automático de resguardo en <code>data/backups/</code>.
          </p>

          {!confirmandoReset ? (
            <div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={procesando}
                onClick={() => setConfirmandoReset(true)}
              >
                Resetear base de datos (dejar solo Admin y datos fijos)
              </button>
            </div>
          ) : (
            <div className="alert-error" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <strong>
                ¿Confirmás reiniciar la base de datos local a cero?
              </strong>
              <span>
                Se creará una copia de seguridad previa en{' '}
                <code>data/backups/</code> y se eliminarán todos los productos,
                ventas, movimientos y usuarios no administradores.
              </span>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={procesando}
                  onClick={() => void manejarResetearBaseDatos()}
                >
                  Sí, confirmar reinicio a cero
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={procesando}
                  onClick={() => setConfirmandoReset(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
