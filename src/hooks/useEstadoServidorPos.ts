import { useCallback, useEffect, useState } from 'react';
import {
  invocarPosApi,
  obtenerConfigBackendLocalSincrono,
  obtenerTokenSesionLocal,
} from '../db/cliente_pos_api.ts';
import type { RolUsuario } from '../domain/permisos.ts';
import {
  calcularIndicadorEstadoSync,
  type ResumenEstadoSyncUI,
} from '../domain/sync.ts';
import type { EstadoInicialServidor } from '../types/estado_app.ts';

export interface UseEstadoServidorPosOpciones {
  readonly autenticado: boolean;
  readonly rolActivo: RolUsuario;
  readonly usuarioActivoId: string | null;
  readonly onOperadorActualDetectado?: (nombre: string) => void;
}

export interface UseEstadoServidorPosResultado {
  readonly datosServidor: EstadoInicialServidor | null;
  readonly sinConexionNavegador: boolean;
  readonly sincronizandoEnCurso: boolean;
  readonly resumenSync: ResumenEstadoSyncUI;
  readonly cajaAbiertaEnServidor: boolean;
  readonly recargarEstadoLocal: () => Promise<void>;
  readonly ejecutarSubidaManual: () => Promise<void>;
  readonly ejecutarBajadaManual: () => Promise<void>;
  readonly ejecutarCicloSync: () => Promise<void>;
  readonly cambiarSucursalRapida: (nuevaSucursalId: string) => Promise<void>;
}

export function useEstadoServidorPos({
  autenticado,
  rolActivo,
  usuarioActivoId,
  onOperadorActualDetectado,
}: UseEstadoServidorPosOpciones): UseEstadoServidorPosResultado {
  const [datosServidor, setDatosServidor] =
    useState<EstadoInicialServidor | null>(null);
  const [sinConexionNavegador, setSinConexionNavegador] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [sincronizandoEnCurso, setSincronizandoEnCurso] = useState(false);

  const recargarEstadoLocal = useCallback(async () => {
    if (!autenticado) {
      setDatosServidor(null);
      return;
    }
    try {
      const estado = await invocarPosApi<EstadoInicialServidor>(
        'obtener_estado_inicial',
        {
          rolDemo: rolActivo,
          usuarioActivoId: usuarioActivoId ?? undefined,
          sinConexion: sinConexionNavegador,
        }
      );
      setDatosServidor(estado);
      if (estado.operadorActual) {
        onOperadorActualDetectado?.(estado.operadorActual.nombre);
      }
    } catch {
      // En tests unitarios sin servidor Vite se usan los valores por defecto de los paneles
    }
  }, [
    autenticado,
    rolActivo,
    usuarioActivoId,
    sinConexionNavegador,
    onOperadorActualDetectado,
  ]);

  const ejecutarSubidaManual = useCallback(async () => {
    if (!autenticado) return;
    setSincronizandoEnCurso(true);
    try {
      await invocarPosApi('sync_subir_ahora', { rolDemo: rolActivo });
      await recargarEstadoLocal();
    } finally {
      setSincronizandoEnCurso(false);
    }
  }, [autenticado, rolActivo, recargarEstadoLocal]);

  const ejecutarBajadaManual = useCallback(async () => {
    if (!autenticado) return;
    setSincronizandoEnCurso(true);
    try {
      await invocarPosApi('sync_bajar_ahora', { rolDemo: rolActivo });
      await recargarEstadoLocal();
    } finally {
      setSincronizandoEnCurso(false);
    }
  }, [autenticado, rolActivo, recargarEstadoLocal]);

  const ejecutarCicloSync = useCallback(async () => {
    if (!autenticado || sinConexionNavegador) return;
    setSincronizandoEnCurso(true);
    try {
      await invocarPosApi('sync_ciclo_completo', { rolDemo: rolActivo });
      await recargarEstadoLocal();
    } catch {
      // No bloquear nunca la caja ante fallos de red en segundo plano (Regla 7)
    } finally {
      setSincronizandoEnCurso(false);
    }
  }, [autenticado, rolActivo, sinConexionNavegador, recargarEstadoLocal]);

  const cambiarSucursalRapida = useCallback(
    async (nuevaSucursalId: string) => {
      if (!autenticado) return;
      try {
        await invocarPosApi('seleccionar_sucursal_activa', {
          rolDemo: rolActivo,
          sucursalId: nuevaSucursalId,
        });
        await recargarEstadoLocal();
      } catch {
        // Ignorar si no hay servidor en tests aislados
      }
    },
    [autenticado, rolActivo, recargarEstadoLocal]
  );

  useEffect(() => {
    void recargarEstadoLocal();
  }, [recargarEstadoLocal]);

  // Disparador 1 (PLAN.md §5): Al abrir la app autenticado, sincroniza en segundo plano sin bloquear la caja
  useEffect(() => {
    if (autenticado) {
      void ejecutarCicloSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autenticado]);

  // Escuchar cambios de conectividad del sistema operativo/navegador
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const alConectar = () => {
      setSinConexionNavegador(false);
      void ejecutarCicloSync();
    };
    const alDesconectar = () => setSinConexionNavegador(true);

    window.addEventListener('online', alConectar);
    window.addEventListener('offline', alDesconectar);
    return () => {
      window.removeEventListener('online', alConectar);
      window.removeEventListener('offline', alDesconectar);
    };
  }, [ejecutarCicloSync]);

  // Disparador 5 (PLAN.md §5): Sincronización periódica cada X minutos mientras está abierta y hay conexión
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cfg = datosServidor?.configuracionSistema;
    if (cfg && !cfg.sync_automatico_habilitado) return;

    const minutos = cfg?.sync_intervalo_minutos ?? 5;
    const timer = window.setInterval(
      () => {
        if (!sinConexionNavegador) {
          void ejecutarCicloSync();
        }
      },
      minutos * 60 * 1000
    );
    return () => window.clearInterval(timer);
  }, [
    datosServidor?.configuracionSistema,
    sinConexionNavegador,
    ejecutarCicloSync,
  ]);

  // Disparador 2 (PLAN.md §5): Al cerrar la app, si hay cambios pendientes intenta subirlos con timeout corto sin trabar el cierre
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const alCerrar = () => {
      const pendientes = datosServidor?.cambiosPendientesSync ?? 0;
      if (autenticado && pendientes > 0 && !sinConexionNavegador) {
        try {
          const token = obtenerTokenSesionLocal();
          const { baseUrl, bootToken } = obtenerConfigBackendLocalSincrono();
          const urlApi = baseUrl ? `${baseUrl}/api/pos` : '/api/pos';
          void fetch(urlApi, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'X-POS-Session': token } : {}),
              ...(bootToken ? { 'X-POS-Boot-Token': bootToken } : {}),
            },
            body: JSON.stringify({
              accion: 'sync_subir_ahora',
              payload: { rolDemo: rolActivo },
            }),
            keepalive: true,
            signal: AbortSignal.timeout(1500),
          });
        } catch {
          // Lo que no suba queda pendiente en sync_cola
        }
      }
    };
    window.addEventListener('pagehide', alCerrar);
    return () => window.removeEventListener('pagehide', alCerrar);
  }, [
    autenticado,
    datosServidor?.cambiosPendientesSync,
    sinConexionNavegador,
    rolActivo,
  ]);

  const resumenSync: ResumenEstadoSyncUI =
    datosServidor?.estadoSync ??
    calcularIndicadorEstadoSync({
      sinConexion: sinConexionNavegador,
      datosPendientes: datosServidor?.cambiosPendientesSync ?? 0,
      imagenesPendientes: 0,
      erroresCount: 0,
    });

  const cajaAbiertaEnServidor =
    datosServidor?.estadoCaja?.sesion.estado === 'abierta';

  return {
    datosServidor,
    sinConexionNavegador,
    sincronizandoEnCurso,
    resumenSync,
    cajaAbiertaEnServidor,
    recargarEstadoLocal,
    ejecutarSubidaManual,
    ejecutarBajadaManual,
    ejecutarCicloSync,
    cambiarSucursalRapida,
  };
}
