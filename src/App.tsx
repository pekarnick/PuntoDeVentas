import React, { useCallback, useEffect, useState } from 'react';
import { invocarPosApi } from './db/cliente_pos_api.ts';
import { formatearFechaAR } from './domain/dinero.ts';
import type { ProductoCatalogoVenta } from './domain/escaner.ts';
import { tienePermiso, type RolUsuario } from './domain/permisos.ts';
import {
  calcularIndicadorEstadoSync,
  type ResumenEstadoSyncUI,
} from './domain/sync.ts';
import { PanelAuditoria } from './features/auditoria/PanelAuditoria.tsx';
import {
  PanelCaja,
  type EstadoCajaServidorUI,
} from './features/caja/PanelCaja.tsx';
import {
  PanelClientesCuentaCorriente,
  type ClienteConSaldoUI,
} from './features/clientes/PanelClientesCuentaCorriente.tsx';
import {
  PanelComprasProveedores,
  type CompraResumenUI,
  type ProveedorConSaldoUI,
} from './features/compras/PanelComprasProveedores.tsx';
import {
  PanelConfiguracionSync,
  type ConfiguracionSistemaDTO,
  type EstadisticasEspacioImagenesDTO,
  type EstadoConfiguracionArcaDTO,
  type EstadoConfigVentaMovilDTO,
  type RegistroHistorialBackupDTO,
} from './features/configuracion/PanelConfiguracionSync.tsx';
import { PanelInformes } from './features/informes/PanelInformes.tsx';
import {
  PanelProductosStock,
  type CategoriaItemUI,
  type MarcaItemUI,
  type ProductoAdminItemUI,
} from './features/productos/PanelProductosStock.tsx';
import { PanelUsuarios } from './features/usuarios/PanelUsuarios.tsx';
import {
  PanelVentaPOS,
  type ComboPromocionUI,
  type ListaPrecioUI,
  type VentaRecienteResumenUI,
} from './features/venta/PanelVentaPOS.tsx';

type PestaniaActiva =
  | 'venta'
  | 'productos'
  | 'compras'
  | 'clientes'
  | 'caja'
  | 'informes'
  | 'usuarios'
  | 'auditoria'
  | 'configuracion';

const NOMBRES_OPERADOR: Record<RolUsuario, string> = {
  superadmin: 'María Superadmin',
  encargado: 'Carlos Encargado',
  cajero: 'Lucas Cajero',
};

interface EstadoInicialServidor {
  readonly rutaBaseDatos: string;
  readonly cambiosPendientesSync: number;
  readonly estadoSync?: ResumenEstadoSyncUI;
  readonly configuracionSistema?: ConfiguracionSistemaDTO | null;
  readonly configVentaMovil?: EstadoConfigVentaMovilDTO | null;
  readonly configArca?: EstadoConfiguracionArcaDTO | null;
  readonly listasPrecio?: readonly ListaPrecioUI[];
  readonly combos?: readonly ComboPromocionUI[];
  readonly historialBackups?: readonly RegistroHistorialBackupDTO[];
  readonly espacioImagenes?: EstadisticasEspacioImagenesDTO;
  readonly catalogoVenta: readonly ProductoCatalogoVenta[];
  readonly catalogoAdmin: readonly ProductoAdminItemUI[];
  readonly ventasRecientes: readonly VentaRecienteResumenUI[];
  readonly estadoCaja: EstadoCajaServidorUI | null;
  readonly categorias?: readonly CategoriaItemUI[];
  readonly marcas?: readonly MarcaItemUI[];
  readonly proveedores?: readonly ProveedorConSaldoUI[];
  readonly comprasRecientes?: readonly CompraResumenUI[];
  readonly clientes?: readonly ClienteConSaldoUI[];
}

type ModoTemaVisual = 'claro' | 'oscuro';
const CLAVE_TEMA_STORAGE = 'pos_tema_visual';

function leerTemaInicial(): ModoTemaVisual {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const guardado = window.localStorage.getItem(CLAVE_TEMA_STORAGE);
      if (guardado === 'oscuro' || guardado === 'claro') {
        return guardado;
      }
    }
  } catch {
    // En entornos sin localStorage usar claro por defecto
  }
  return 'claro';
}

export function App(): React.ReactElement {
  const [rolActivo, setRolActivo] = useState<RolUsuario>('superadmin');
  const [pestania, setPestania] = useState<PestaniaActiva>('venta');
  const [modoTema, setModoTema] = useState<ModoTemaVisual>(() =>
    leerTemaInicial()
  );
  const [datosServidor, setDatosServidor] =
    useState<EstadoInicialServidor | null>(null);
  const [sinConexionNavegador, setSinConexionNavegador] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [sincronizandoEnCurso, setSincronizandoEnCurso] = useState(false);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', modoTema);
      document.body.setAttribute('data-theme', modoTema);
    }
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(CLAVE_TEMA_STORAGE, modoTema);
      }
    } catch {
      // Ignorar fallo de almacenamiento local
    }
  }, [modoTema]);

  function alternarTemaVisual() {
    setModoTema((prev) => (prev === 'claro' ? 'oscuro' : 'claro'));
  }

  const recargarEstadoLocal = useCallback(async () => {
    try {
      const estado = await invocarPosApi<EstadoInicialServidor>(
        'obtener_estado_inicial',
        {
          rolActivo,
          sinConexion: sinConexionNavegador,
        }
      );
      setDatosServidor(estado);
    } catch {
      // En tests unitarios sin servidor Vite se usan los valores por defecto de los paneles
    }
  }, [rolActivo, sinConexionNavegador]);

  const ejecutarSubidaManual = useCallback(async () => {
    setSincronizandoEnCurso(true);
    try {
      await invocarPosApi('sync_subir_ahora', { rolActivo });
      await recargarEstadoLocal();
    } finally {
      setSincronizandoEnCurso(false);
    }
  }, [rolActivo, recargarEstadoLocal]);

  const ejecutarBajadaManual = useCallback(async () => {
    setSincronizandoEnCurso(true);
    try {
      await invocarPosApi('sync_bajar_ahora', { rolActivo });
      await recargarEstadoLocal();
    } finally {
      setSincronizandoEnCurso(false);
    }
  }, [rolActivo, recargarEstadoLocal]);

  const ejecutarCicloSync = useCallback(async () => {
    if (sinConexionNavegador) return;
    setSincronizandoEnCurso(true);
    try {
      await invocarPosApi('sync_ciclo_completo', { rolActivo });
      await recargarEstadoLocal();
    } catch {
      // No bloquear nunca la caja ante fallos de red en segundo plano (Regla 7)
    } finally {
      setSincronizandoEnCurso(false);
    }
  }, [rolActivo, sinConexionNavegador, recargarEstadoLocal]);

  useEffect(() => {
    void recargarEstadoLocal();
  }, [recargarEstadoLocal]);

  // Disparador 1 (PLAN.md §5): Al abrir la app, sincroniza en segundo plano sin bloquear la pantalla de venta
  useEffect(() => {
    void ejecutarCicloSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (pendientes > 0 && !sinConexionNavegador) {
        try {
          void fetch('/api/pos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accion: 'sync_subir_ahora',
              payload: { rolActivo },
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

  const hoy = formatearFechaAR(new Date());

  const puedeGestionarCompras = tienePermiso(
    rolActivo,
    'abm_productos_precios_stock_compras'
  );
  const puedeVerInformes = tienePermiso(rolActivo, 'ver_informes_gestion');
  const puedeGestionarUsuarios = tienePermiso(rolActivo, 'gestionar_usuarios');
  const puedeVerAuditoria = tienePermiso(rolActivo, 'ver_exportar_auditoria');
  const puedeConfigurarSistema = tienePermiso(
    rolActivo,
    'configuracion_sensible'
  );

  function cambiarRolDemo(nuevoRol: RolUsuario) {
    setRolActivo(nuevoRol);
    if (
      (pestania === 'compras' &&
        !tienePermiso(nuevoRol, 'abm_productos_precios_stock_compras')) ||
      (pestania === 'informes' &&
        !tienePermiso(nuevoRol, 'ver_informes_gestion')) ||
      (pestania === 'usuarios' &&
        !tienePermiso(nuevoRol, 'gestionar_usuarios')) ||
      (pestania === 'auditoria' &&
        !tienePermiso(nuevoRol, 'ver_exportar_auditoria')) ||
      (pestania === 'configuracion' &&
        !tienePermiso(nuevoRol, 'configuracion_sensible'))
    ) {
      setPestania('venta');
    }
  }

  return (
    <div
      className={`app-layout theme-${modoTema}`}
      data-theme={modoTema}
    >
      <header className="topbar">
        <div className="topbar-row-top">
          <div className="topbar-brand">
            <span className="brand-dot" aria-hidden="true" />
            <strong>Punto de Ventas</strong>
            <span
              className="badge-fase"
              title={
                datosServidor?.rutaBaseDatos ?? 'data/pos_local.db'
              }
            >
              SQLite: data/pos_local.db
            </span>
          </div>

          <div className="topbar-status">
            <button
              type="button"
              className="nav-btn nav-btn-compact theme-toggle-btn"
              onClick={alternarTemaVisual}
              aria-label={
                modoTema === 'claro'
                  ? 'Cambiar a modo oscuro'
                  : 'Cambiar a modo claro'
              }
              title="Alternar entre Modo Claro y Modo Oscuro"
            >
              {modoTema === 'claro' ? '🌙 Modo Oscuro' : '☀️ Modo Claro'}
            </button>
            <label className="role-switcher">
              <span>Sesión:</span>
              <select
                value={rolActivo}
                onChange={(e) => cambiarRolDemo(e.target.value as RolUsuario)}
              >
                <option value="superadmin">María (superadmin)</option>
                <option value="encargado">Carlos (encargado)</option>
                <option value="cajero">Lucas (cajero)</option>
              </select>
            </label>
            <span className="topbar-date">{hoy}</span>
            <span
              className={`sync-pill sync-pill-${resumenSync.tipoBadge}`}
              title={
                resumenSync.ultimoErrorDetalle ??
                `Datos pendientes: ${resumenSync.datosPendientes} | Imágenes pendientes: ${resumenSync.imagenesPendientes}`
              }
            >
              {sincronizandoEnCurso ? 'Sincronizando...' : resumenSync.etiqueta}
            </span>
            <div className="topbar-sync-actions">
              <button
                type="button"
                className="nav-btn nav-btn-compact"
                disabled={sincronizandoEnCurso}
                title="Subir datos ahora (Push)"
                onClick={() => void ejecutarSubidaManual()}
              >
                ↑ Subir
              </button>
              <button
                type="button"
                className="nav-btn nav-btn-compact"
                disabled={sincronizandoEnCurso}
                title="Bajar datos ahora (Pull)"
                onClick={() => void ejecutarBajadaManual()}
              >
                ↓ Bajar
              </button>
            </div>
          </div>
        </div>

        <nav className="topbar-nav" aria-label="Módulos del sistema">
          <button
            type="button"
            className={pestania === 'venta' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setPestania('venta')}
          >
            Venta (Mostrador)
          </button>

          <button
            type="button"
            className={pestania === 'productos' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setPestania('productos')}
          >
            Productos y Stock
          </button>

          {puedeGestionarCompras && (
            <button
              type="button"
              className={pestania === 'compras' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setPestania('compras')}
            >
              Compras y Proveedores
            </button>
          )}

          <button
            type="button"
            className={pestania === 'clientes' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setPestania('clientes')}
          >
            Clientes y Cta. Cte.
          </button>

          <button
            type="button"
            className={pestania === 'caja' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setPestania('caja')}
          >
            Caja y Arqueo
          </button>

          {puedeVerInformes && (
            <button
              type="button"
              className={pestania === 'informes' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setPestania('informes')}
            >
              Informes y Libro IVA
            </button>
          )}

          {puedeGestionarUsuarios && (
            <button
              type="button"
              className={pestania === 'usuarios' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setPestania('usuarios')}
            >
              Usuarios y Roles
            </button>
          )}

          {puedeVerAuditoria && (
            <button
              type="button"
              className={
                pestania === 'auditoria' ? 'nav-btn active' : 'nav-btn'
              }
              onClick={() => setPestania('auditoria')}
            >
              Auditoría SHA-256
            </button>
          )}

          {puedeConfigurarSistema && (
            <button
              type="button"
              className={
                pestania === 'configuracion' ? 'nav-btn active' : 'nav-btn'
              }
              onClick={() => setPestania('configuracion')}
            >
              Configuración y Sync
            </button>
          )}
        </nav>
      </header>

      <main className="main-content">
        {pestania === 'venta' && (
          <PanelVentaPOS
            rolActivo={rolActivo}
            operadorNombre={NOMBRES_OPERADOR[rolActivo]}
            catalogoInicial={datosServidor ? datosServidor.catalogoVenta : []}
            ventasRecientesIniciales={
              datosServidor ? datosServidor.ventasRecientes : []
            }
            clientesDisponibles={datosServidor?.clientes ?? []}
            configArca={datosServidor?.configArca ?? null}
            listasPrecioDisponibles={datosServidor?.listasPrecio ?? []}
            combosDisponibles={datosServidor?.combos ?? []}
            onDatosActualizados={() => void recargarEstadoLocal()}
          />
        )}
        {pestania === 'productos' && (
          <PanelProductosStock
            rolActivo={rolActivo}
            productosIniciales={
              datosServidor ? datosServidor.catalogoAdmin : []
            }
            categoriasServidor={datosServidor?.categorias ?? []}
            marcasServidor={datosServidor?.marcas ?? []}
            proveedoresServidor={datosServidor?.proveedores ?? []}
            onDatosActualizados={() => void recargarEstadoLocal()}
          />
        )}
        {pestania === 'compras' && puedeGestionarCompras && (
          <PanelComprasProveedores
            rolActivo={rolActivo}
            proveedoresServidor={datosServidor?.proveedores ?? []}
            comprasRecientesServidor={datosServidor?.comprasRecientes ?? []}
            catalogoProductos={datosServidor?.catalogoAdmin ?? []}
            onDatosModificados={() => void recargarEstadoLocal()}
          />
        )}
        {pestania === 'clientes' && (
          <PanelClientesCuentaCorriente
            rolActivo={rolActivo}
            clientesServidor={datosServidor?.clientes ?? []}
            onDatosModificados={() => void recargarEstadoLocal()}
          />
        )}
        {pestania === 'caja' && (
          <PanelCaja
            rolActivo={rolActivo}
            estadoCajaInicial={datosServidor?.estadoCaja}
            onDatosActualizados={() => void recargarEstadoLocal()}
          />
        )}
        {pestania === 'informes' && puedeVerInformes && (
          <PanelInformes rolActivo={rolActivo} />
        )}
        {pestania === 'usuarios' && puedeGestionarUsuarios && <PanelUsuarios />}
        {pestania === 'auditoria' && puedeVerAuditoria && <PanelAuditoria />}
        {pestania === 'configuracion' && puedeConfigurarSistema && (
          <PanelConfiguracionSync
            rolActivo={rolActivo}
            estadoSync={resumenSync}
            configuracionInicial={datosServidor?.configuracionSistema ?? null}
            configVentaMovilInicial={datosServidor?.configVentaMovil ?? null}
            configArcaInicial={datosServidor?.configArca ?? null}
            historialBackupsInicial={[
              ...(datosServidor?.historialBackups ?? []),
            ]}
            espacioImagenes={
              datosServidor?.espacioImagenes ?? {
                cantidadArchivos: 0,
                bytesTotales: 0,
                kbTotales: 0,
                mbTotales: 0,
                porcentajeCuotaGratuita: 0,
              }
            }
            onSubirAhora={ejecutarSubidaManual}
            onBajarAhora={ejecutarBajadaManual}
            onSincronizarCicloCompleto={ejecutarCicloSync}
            onDatosActualizados={() => void recargarEstadoLocal()}
          />
        )}
      </main>

      <footer className="app-footer" role="contentinfo">
        <div className="app-footer-inner">
          <span className="app-footer-brand">
            <strong>GAR</strong> - Guillermo Adolfo Rohde
          </span>
          <span className="app-footer-meta">
            Sistema Punto de Venta Offline-First · SQLite + Nube
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;

