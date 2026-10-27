import React, { useEffect, useState } from 'react';
import {
  generarQrSvgUrlPublica,
  validarUrlPublicaVentaMovil,
} from '@pos/domain';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { formatearFechaHoraAR } from '../../domain/dinero.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';
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
  proveedor_nube?: 'supabase' | 'firebase' | 'ambos';
  supabase_url: string | null;
  supabase_anon_key: string | null;
  firebase_project_id?: string | null;
  firebase_api_key?: string | null;
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

export interface EstadoConfiguracionArcaDTO {
  readonly comercio_id: string;
  readonly nombre_comercio: string;
  readonly razon_social: string | null;
  readonly cuit: string | null;
  readonly condicion_iva:
    | 'monotributo'
    | 'responsable_inscripto'
    | 'exento'
    | 'consumidor_final';
  readonly domicilio: string | null;
  readonly arca_habilitada: boolean;
  readonly arca_ambiente: 'homologacion' | 'produccion';
  readonly arca_punto_venta: number;
  readonly arca_proveedor:
    | 'afip_sdk'
    | 'tus_facturas'
    | 'simulador_homologacion';
  readonly arca_tope_consumidor_final: number;
  readonly resumen_comprobantes: {
    readonly emitidos: number;
    readonly pendientes: number;
    readonly con_error: number;
  };
}

export interface PanelConfiguracionSyncProps {
  rolActivo: RolUsuario;
  estadoSync: ResumenEstadoSyncUI;
  configuracionInicial: ConfiguracionSistemaDTO | null;
  configVentaMovilInicial?: EstadoConfigVentaMovilDTO | null;
  configArcaInicial?: EstadoConfiguracionArcaDTO | null;
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
  configArcaInicial = null,
  historialBackupsInicial,
  espacioImagenes,
  onSubirAhora,
  onBajarAhora,
  onSincronizarCicloCompleto,
  onDatosActualizados,
}: PanelConfiguracionSyncProps): React.ReactElement {
  const puedeConfigurar = tienePermiso(rolActivo, 'configuracion_sensible');

  const [proveedorNube, setProveedorNube] = useState<
    'supabase' | 'firebase' | 'ambos'
  >(configuracionInicial?.proveedor_nube ?? 'supabase');
  const [supabaseUrl, setSupabaseUrl] = useState(
    configuracionInicial?.supabase_url ?? ''
  );
  const [supabaseAnonKey, setSupabaseAnonKey] = useState(
    configuracionInicial?.supabase_anon_key ?? ''
  );
  const [firebaseProjectId, setFirebaseProjectId] = useState(
    configuracionInicial?.firebase_project_id ?? ''
  );
  const [firebaseApiKey, setFirebaseApiKey] = useState(
    configuracionInicial?.firebase_api_key ?? ''
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

  const [configArca, setConfigArca] =
    useState<EstadoConfiguracionArcaDTO | null>(configArcaInicial);
  const [arcaHabilitada, setArcaHabilitada] = useState(
    configArcaInicial?.arca_habilitada ?? false
  );
  const [arcaRazonSocial, setArcaRazonSocial] = useState(
    configArcaInicial?.razon_social ?? ''
  );
  const [arcaCuit, setArcaCuit] = useState(
    configArcaInicial?.cuit ?? '20-11111111-2'
  );
  const [arcaCondicionIva, setArcaCondicionIva] = useState<
    'monotributo' | 'responsable_inscripto' | 'exento' | 'consumidor_final'
  >(configArcaInicial?.condicion_iva ?? 'monotributo');
  const [arcaDomicilio, setArcaDomicilio] = useState(
    configArcaInicial?.domicilio ?? ''
  );
  const [arcaPuntoVenta, setArcaPuntoVenta] = useState(
    String(configArcaInicial?.arca_punto_venta ?? 1)
  );
  const [arcaAmbiente, setArcaAmbiente] = useState<
    'homologacion' | 'produccion'
  >(configArcaInicial?.arca_ambiente ?? 'homologacion');
  const [arcaProveedor, setArcaProveedor] = useState<
    'afip_sdk' | 'tus_facturas' | 'simulador_homologacion'
  >(configArcaInicial?.arca_proveedor ?? 'afip_sdk');

  const [procesando, setProcesando] = useState(false);
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);
  const [mensajeError, setMensajeError] = useState<string | null>(null);

  const [paginaBackups, setPaginaBackups] = useState(1);
  const [paginaUsuariosMoviles, setPaginaUsuariosMoviles] = useState(1);
  const [paginaSesionesMoviles, setPaginaSesionesMoviles] = useState(1);

  const paginacionBackups = paginarListado(
    historialBackupsInicial,
    paginaBackups,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionUsuariosMoviles = paginarListado(
    configMovil?.usuarios_moviles ?? [],
    paginaUsuariosMoviles,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionSesionesMoviles = paginarListado(
    configMovil?.sesiones ?? [],
    paginaSesionesMoviles,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  useEffect(() => {
    if (configuracionInicial) {
      setProveedorNube(configuracionInicial.proveedor_nube ?? 'supabase');
      setSupabaseUrl(configuracionInicial.supabase_url ?? '');
      setSupabaseAnonKey(configuracionInicial.supabase_anon_key ?? '');
      setFirebaseProjectId(configuracionInicial.firebase_project_id ?? '');
      setFirebaseApiKey(configuracionInicial.firebase_api_key ?? '');
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

  useEffect(() => {
    if (configArcaInicial) {
      setConfigArca(configArcaInicial);
      setArcaHabilitada(configArcaInicial.arca_habilitada);
      setArcaRazonSocial(configArcaInicial.razon_social ?? '');
      setArcaCuit(configArcaInicial.cuit ?? '20-11111111-2');
      setArcaCondicionIva(configArcaInicial.condicion_iva);
      setArcaDomicilio(configArcaInicial.domicilio ?? '');
      setArcaPuntoVenta(String(configArcaInicial.arca_punto_venta ?? 1));
      setArcaAmbiente(configArcaInicial.arca_ambiente);
      setArcaProveedor(configArcaInicial.arca_proveedor);
    }
  }, [configArcaInicial]);

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
        proveedorNube,
        supabaseUrl: supabaseUrl.trim() || null,
        supabaseAnonKey: supabaseAnonKey.trim() || null,
        firebaseProjectId: firebaseProjectId.trim() || null,
        firebaseApiKey: firebaseApiKey.trim() || null,
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
  const [vaciarSupabaseEnReset, setVaciarSupabaseEnReset] = useState(true);

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

  async function manejarGuardarConfigArca(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const actualizado = await invocarPosApi<EstadoConfiguracionArcaDTO>(
        'guardar_configuracion_arca',
        {
          rolActivo,
          arcaHabilitada,
          razonSocial: arcaRazonSocial,
          cuit: arcaCuit,
          condicionIva: arcaCondicionIva,
          domicilio: arcaDomicilio,
          puntoVenta: Number(arcaPuntoVenta) || 1,
          ambiente: arcaAmbiente,
          proveedor: arcaProveedor,
        }
      );
      setConfigArca(actualizado);
      setArcaHabilitada(actualizado.arca_habilitada);
      setMensajeExito(
        actualizado.arca_habilitada
          ? `Facturación electrónica ARCA habilitada en ambiente "${actualizado.arca_ambiente.toUpperCase()}" (Punto de Venta ${String(actualizado.arca_punto_venta).padStart(4, '0')}).`
          : 'Facturación ARCA desactivada. El sistema opera con Ticket No Fiscal.'
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo guardar la configuración de ARCA.'
      );
    } finally {
      setProcesando(false);
    }
  }

  async function manejarReintentarPendientesArca() {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const res = await invocarPosApi<{
        procesados: number;
        emitidos: number;
        siguenPendientes: number;
        conError: number;
      }>('reintentar_pendientes_arca', { rolActivo });
      setMensajeExito(
        `Cola ARCA procesada: ${res.emitidos} comprobante(s) emitido(s) con CAE (${res.siguenPendientes} pendiente(s), ${res.conError} con error).`
      );
      onDatosActualizados();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Error al reintentar comprobantes ARCA pendientes.'
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

  async function manejarCopiarSqlMigracionSupabase() {
    setMensajeError(null);
    setMensajeExito(null);
    try {
      const res = await invocarPosApi<{ sql: string }>(
        'obtener_sql_migracion_supabase',
        { rolActivo }
      );
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(res.sql);
      }
      setMensajeExito(
        'Script SQL de actualización (sesiones_moviles, variantes, combos, ARCA y resetear_comercio_a_fabrica) copiado al portapapeles. Pegalo y ejecutalo en el SQL Editor de tu proyecto Supabase.'
      );
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo copiar el script SQL de migración.'
      );
    }
  }

  async function manejarResetearBaseDatos() {
    setMensajeError(null);
    setMensajeExito(null);
    setProcesando(true);
    try {
      const res = await invocarPosApi<{
        backupResguardoPrevio: RegistroHistorialBackupDTO;
        superadminConservado: string;
        nubeVaciada?: boolean;
        tablasRemotasVaciadas?: number;
      }>('resetear_base_datos', {
        rolActivo,
        vaciarSupabaseTambien: vaciarSupabaseEnReset,
      });
      setConfirmandoReset(false);
      const detalleNube = res.nubeVaciada
        ? ` También se vaciaron ${res.tablasRemotasVaciadas ?? 0} tablas en Supabase.`
        : '';
      setMensajeExito(
        `Base de datos reiniciada a cero.${detalleNube} Se conservó únicamente al administrador (${res.superadminConservado}), el comercio, la lista General y las credenciales de Supabase. Resguardo previo en: ${res.backupResguardoPrevio.ruta_archivo}`
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
            <button
              type="button"
              className="btn btn-secondary"
              disabled={procesando}
              onClick={() => void manejarCopiarSqlMigracionSupabase()}
              title="Copia al portapapeles el SQL de actualización de esquema para pegar en el SQL Editor de Supabase"
            >
              📋 Copiar SQL actualización Supabase
            </button>
          </div>
        </section>

        <section className="card">
          <h2>Parámetros de Conexión Supabase, Firebase y Backups</h2>
          <form onSubmit={(e) => void manejarGuardarConfiguracion(e)}>
            <div className="form-group">
              <label htmlFor="cfg-proveedor-nube">
                Proveedor de sincronización en la nube
              </label>
              <select
                id="cfg-proveedor-nube"
                value={proveedorNube}
                onChange={(e) =>
                  setProveedorNube(
                    e.target.value as 'supabase' | 'firebase' | 'ambos'
                  )
                }
              >
                <option value="supabase">
                  Supabase (PostgreSQL + RLS + Storage — Principal)
                </option>
                <option value="firebase">
                  Firebase (Cloud Firestore REST + Storage)
                </option>
                <option value="ambos">
                  Ambos en paralelo (Espejo redundante Supabase + Firebase)
                </option>
              </select>
            </div>

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

            {(proveedorNube === 'firebase' || proveedorNube === 'ambos') && (
              <div
                className="subcard-box"
                style={{
                  padding: '0.85rem',
                  borderRadius: '0.5rem',
                  marginBottom: '0.85rem',
                }}
              >
                <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>
                  🔥 Configuración de Firebase (Cloud Firestore + Storage)
                </h3>
                <div className="form-group">
                  <label htmlFor="cfg-firebase-project-id">
                    Firebase Project ID
                  </label>
                  <input
                    id="cfg-firebase-project-id"
                    type="text"
                    placeholder="ej: mi-pos-comercio-ar"
                    value={firebaseProjectId}
                    onChange={(e) => setFirebaseProjectId(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label htmlFor="cfg-firebase-api-key">
                    Firebase Web API Key pública (<code>AIza...</code>)
                  </label>
                  <input
                    id="cfg-firebase-api-key"
                    type="password"
                    placeholder="AIzaSy... (Nunca ingreses JSON de Service Account)"
                    value={firebaseApiKey}
                    onChange={(e) => setFirebaseApiKey(e.target.value)}
                  />
                  <small style={{ color: '#64748b', lineHeight: 1.4 }}>
                    Regla 8: Usá únicamente la Web API Key pública con Security
                    Rules en Firestore. Prohibido ingresar claves privadas de
                    Firebase Admin SDK.
                  </small>
                </div>
              </div>
            )}

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
              className="subcard-box"
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'center',
                flexWrap: 'wrap',
                margin: '0.75rem 0',
                padding: '0.75rem',
                borderRadius: '0.5rem',
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
                  paginacionUsuariosMoviles.itemsPagina.map((u) => (
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
            <PaginadorTabla
              paginaActual={paginacionUsuariosMoviles.paginaActual}
              totalPaginas={paginacionUsuariosMoviles.totalPaginas}
              totalItems={paginacionUsuariosMoviles.totalItems}
              desdeRegistro={paginacionUsuariosMoviles.desdeRegistro}
              hastaRegistro={paginacionUsuariosMoviles.hastaRegistro}
              tamanioPagina={paginacionUsuariosMoviles.tamanioPagina}
              onCambiarPagina={setPaginaUsuariosMoviles}
              etiquetaItems="usuarios móviles"
            />
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
                  paginacionSesionesMoviles.itemsPagina.map((s) => (
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
            <PaginadorTabla
              paginaActual={paginacionSesionesMoviles.paginaActual}
              totalPaginas={paginacionSesionesMoviles.totalPaginas}
              totalItems={paginacionSesionesMoviles.totalItems}
              desdeRegistro={paginacionSesionesMoviles.desdeRegistro}
              hastaRegistro={paginacionSesionesMoviles.hastaRegistro}
              tamanioPagina={paginacionSesionesMoviles.tamanioPagina}
              onCambiarPagina={setPaginaSesionesMoviles}
              etiquetaItems="sesiones móviles"
            />
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
                  paginacionBackups.itemsPagina.map((b) => (
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
            <PaginadorTabla
              paginaActual={paginacionBackups.paginaActual}
              totalPaginas={paginacionBackups.totalPaginas}
              totalItems={paginacionBackups.totalItems}
              desdeRegistro={paginacionBackups.desdeRegistro}
              hastaRegistro={paginacionBackups.hastaRegistro}
              tamanioPagina={paginacionBackups.tamanioPagina}
              onCambiarPagina={setPaginaBackups}
              etiquetaItems="backups"
            />
          </div>
        </section>

        <section
          className="card"
          aria-label="Facturación electrónica ARCA opcional"
          style={{ marginBottom: '1.25rem' }}
        >
          <div className="section-header-row">
            <div>
              <h2>
                Facturación Electrónica ARCA (ex-AFIP, Opcional — PLAN.md §6.3)
              </h2>
              <p className="text-muted">
                Viene <strong>apagada por defecto</strong>. Con ARCA apagada no
                aparece ninguna opción fiscal y todo funciona con ticket no
                fiscal. Las credenciales y certificados digitales viven como
                secretos en la Edge Function{' '}
                <code>emitir_comprobante_arca</code> de Supabase y{' '}
                <strong>nunca se guardan en el cliente ni en el repositorio</strong>{' '}
                (Reglas 18 y 19).
              </p>
            </div>
            <span
              className={`sync-pill ${
                arcaHabilitada ? 'sync-pill-ok' : 'sync-pill-offline'
              }`}
            >
              {arcaHabilitada
                ? `ARCA Activa (${arcaAmbiente.toUpperCase()})`
                : 'ARCA Apagada (Ticket No Fiscal)'}
            </span>
          </div>

          <form
            onSubmit={(e) => void manejarGuardarConfigArca(e)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
              marginTop: '0.75rem',
            }}
          >
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={arcaHabilitada}
                onChange={(e) => setArcaHabilitada(e.target.checked)}
              />
              <span>
                <strong>Habilitar Facturación Electrónica ARCA</strong> (emite
                Factura A, B o C y Nota de Crédito según condición IVA, con QR
                oficial RG 4892/2020)
              </span>
            </label>

            <div className="form-grid-2">
              <label className="field-label">
                <span>Razón Social del Emisor</span>
                <input
                  type="text"
                  className="input-base"
                  placeholder="Comercio Ejemplo S.R.L."
                  value={arcaRazonSocial}
                  onChange={(e) => setArcaRazonSocial(e.target.value)}
                />
              </label>

              <label className="field-label">
                <span>CUIT del Comercio (11 dígitos con Módulo 11)</span>
                <input
                  type="text"
                  className="input-base"
                  placeholder="20-11111111-2"
                  value={arcaCuit}
                  onChange={(e) => setArcaCuit(e.target.value)}
                />
              </label>
            </div>

            <div className="form-grid-2">
              <label className="field-label">
                <span>Condición frente al IVA del Emisor</span>
                <select
                  className="input-base"
                  value={arcaCondicionIva}
                  onChange={(e) =>
                    setArcaCondicionIva(
                      e.target.value as
                        | 'monotributo'
                        | 'responsable_inscripto'
                        | 'exento'
                    )
                  }
                >
                  <option value="monotributo">
                    Monotributo (emite Factura C / NC C)
                  </option>
                  <option value="responsable_inscripto">
                    Responsable Inscripto (emite Factura A o B / NC A o B)
                  </option>
                  <option value="exento">
                    IVA Sujeto Exento (emite Factura C / NC C)
                  </option>
                </select>
              </label>

              <label className="field-label">
                <span>Punto de Venta Electrónico ARCA</span>
                <input
                  type="number"
                  min={1}
                  max={99999}
                  className="input-base"
                  value={arcaPuntoVenta}
                  onChange={(e) => setArcaPuntoVenta(e.target.value)}
                />
              </label>
            </div>

            <div className="form-grid-2">
              <label className="field-label">
                <span>Ambiente ARCA (Probar siempre primero en Homologación)</span>
                <select
                  className="input-base"
                  value={arcaAmbiente}
                  onChange={(e) =>
                    setArcaAmbiente(
                      e.target.value as 'homologacion' | 'produccion'
                    )
                  }
                >
                  <option value="homologacion">
                    Homologación (Pruebas — CAE de prueba sin validez fiscal)
                  </option>
                  <option value="produccion">
                    Producción (Emisión real con secretos en Edge Function)
                  </option>
                </select>
              </label>

              <label className="field-label">
                <span>Servicio de Terceros en Edge Function</span>
                <select
                  className="input-base"
                  value={arcaProveedor}
                  onChange={(e) =>
                    setArcaProveedor(
                      e.target.value as
                        | 'afip_sdk'
                        | 'tus_facturas'
                        | 'simulador_homologacion'
                    )
                  }
                >
                  <option value="afip_sdk">Afip SDK (Edge Function)</option>
                  <option value="tus_facturas">
                    TusFacturasAPP (Edge Function)
                  </option>
                  <option value="simulador_homologacion">
                    Simulador Homologación Local
                  </option>
                </select>
              </label>
            </div>

            <label className="field-label">
              <span>Domicilio Comercial</span>
              <input
                type="text"
                className="input-base"
                placeholder="Av. Corrientes 1234, CABA"
                value={arcaDomicilio}
                onChange={(e) => setArcaDomicilio(e.target.value)}
              />
            </label>

            <div
              style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <button
                type="submit"
                className="btn btn-primary"
                disabled={procesando}
              >
                Guardar configuración ARCA
              </button>

              {configArca && (
                <div
                  style={{
                    display: 'flex',
                    gap: '0.6rem',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <span className="badge-neutral">
                    Emitidos: <strong>{configArca.resumen_comprobantes.emitidos}</strong>
                  </span>
                  <span className="badge-neutral">
                    Pendientes:{' '}
                    <strong>{configArca.resumen_comprobantes.pendientes}</strong>
                  </span>
                  <span className="badge-neutral">
                    Con error:{' '}
                    <strong>{configArca.resumen_comprobantes.con_error}</strong>
                  </span>
                  {(configArca.resumen_comprobantes.pendientes > 0 ||
                    configArca.resumen_comprobantes.con_error > 0) && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={procesando}
                      onClick={() => void manejarReintentarPendientesArca()}
                    >
                      Reintentar pendientes ARCA ahora
                    </button>
                  )}
                </div>
              )}
            </div>
          </form>
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
                ¿Confirmás reiniciar la base de datos a cero?
              </strong>
              <span>
                Se creará una copia de seguridad previa en{' '}
                <code>data/backups/</code> y se eliminarán todos los productos,
                ventas, movimientos y usuarios no administradores.
              </span>
              <label className="checkbox-inline" style={{ marginTop: '0.25rem' }}>
                <input
                  type="checkbox"
                  checked={vaciarSupabaseEnReset}
                  onChange={(e) => setVaciarSupabaseEnReset(e.target.checked)}
                />
                <span>
                  <strong>
                    Vaciar también las tablas que están en Supabase
                  </strong>{' '}
                  (mantiene local y nube limpios y alineados)
                </span>
              </label>
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
