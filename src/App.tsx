import React, { useCallback, useEffect, useState } from 'react';
import { invocarPosApi } from './db/cliente_pos_api.ts';
import { formatearFechaAR } from './domain/dinero.ts';
import type { ProductoCatalogoVenta } from './domain/escaner.ts';
import { tienePermiso, type RolUsuario } from './domain/permisos.ts';
import { PanelAuditoria } from './features/auditoria/PanelAuditoria.tsx';
import {
  PanelCaja,
  type EstadoCajaServidorUI,
} from './features/caja/PanelCaja.tsx';
import { PanelInformes } from './features/informes/PanelInformes.tsx';
import {
  PanelProductosStock,
  type ProductoAdminItemUI,
} from './features/productos/PanelProductosStock.tsx';
import { PanelUsuarios } from './features/usuarios/PanelUsuarios.tsx';
import {
  PanelVentaPOS,
  type VentaRecienteResumenUI,
} from './features/venta/PanelVentaPOS.tsx';
import { formatearEstadoSync } from './sync/index.ts';

type PestaniaActiva =
  | 'venta'
  | 'productos'
  | 'caja'
  | 'informes'
  | 'usuarios'
  | 'auditoria';

const NOMBRES_OPERADOR: Record<RolUsuario, string> = {
  superadmin: 'María Superadmin',
  encargado: 'Carlos Encargado',
  cajero: 'Lucas Cajero',
};

interface EstadoInicialServidor {
  readonly rutaBaseDatos: string;
  readonly cambiosPendientesSync: number;
  readonly catalogoVenta: readonly ProductoCatalogoVenta[];
  readonly catalogoAdmin: readonly ProductoAdminItemUI[];
  readonly ventasRecientes: readonly VentaRecienteResumenUI[];
  readonly estadoCaja: EstadoCajaServidorUI | null;
}

export function App(): React.ReactElement {
  const [rolActivo, setRolActivo] = useState<RolUsuario>('superadmin');
  const [pestania, setPestania] = useState<PestaniaActiva>('venta');
  const [datosServidor, setDatosServidor] =
    useState<EstadoInicialServidor | null>(null);

  const recargarEstadoLocal = useCallback(async () => {
    try {
      const estado = await invocarPosApi<EstadoInicialServidor>(
        'obtener_estado_inicial',
        { rolActivo }
      );
      setDatosServidor(estado);
    } catch {
      // En tests unitarios sin servidor Vite se usan los valores por defecto de los paneles
    }
  }, [rolActivo]);

  useEffect(() => {
    void recargarEstadoLocal();
  }, [recargarEstadoLocal]);

  const estadoSync = formatearEstadoSync({
    estado: 'pendiente',
    cambiosPendientes: datosServidor?.cambiosPendientesSync ?? 0,
  });

  const hoy = formatearFechaAR(new Date());

  const puedeVerInformes = tienePermiso(rolActivo, 'ver_informes_gestion');
  const puedeGestionarUsuarios = tienePermiso(rolActivo, 'gestionar_usuarios');
  const puedeVerAuditoria = tienePermiso(rolActivo, 'ver_exportar_auditoria');

  function cambiarRolDemo(nuevoRol: RolUsuario) {
    setRolActivo(nuevoRol);
    if (
      (pestania === 'informes' &&
        !tienePermiso(nuevoRol, 'ver_informes_gestion')) ||
      (pestania === 'usuarios' &&
        !tienePermiso(nuevoRol, 'gestionar_usuarios')) ||
      (pestania === 'auditoria' &&
        !tienePermiso(nuevoRol, 'ver_exportar_auditoria'))
    ) {
      setPestania('venta');
    }
  }

  return (
    <div className="app-layout">
      <header className="topbar">
        <div className="topbar-brand">
          <strong>Punto de Ventas</strong>
          <span className="badge-fase" title={datosServidor?.rutaBaseDatos}>
            SQLite: {datosServidor?.rutaBaseDatos ?? 'data/pos_local.db'}
          </span>
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
              Informes y Excel
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
              className={pestania === 'auditoria' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setPestania('auditoria')}
            >
              Auditoría SHA-256
            </button>
          )}
        </nav>

        <div className="topbar-status">
          <label className="role-switcher">
            Sesión activa:
            <select
              value={rolActivo}
              onChange={(e) => cambiarRolDemo(e.target.value as RolUsuario)}
            >
              <option value="superadmin">María (superadmin)</option>
              <option value="encargado">Carlos (encargado)</option>
              <option value="cajero">Lucas (cajero)</option>
            </select>
          </label>
          <span>{hoy}</span>
          <span className="sync-pill" title="Estado de sincronización">
            {estadoSync}
          </span>
        </div>
      </header>

      <main className="main-content">
        {pestania === 'venta' && (
          <PanelVentaPOS
            rolActivo={rolActivo}
            operadorNombre={NOMBRES_OPERADOR[rolActivo]}
            catalogoInicial={datosServidor?.catalogoVenta}
            ventasRecientesIniciales={datosServidor?.ventasRecientes}
            onDatosActualizados={() => void recargarEstadoLocal()}
          />
        )}
        {pestania === 'productos' && (
          <PanelProductosStock
            rolActivo={rolActivo}
            productosIniciales={datosServidor?.catalogoAdmin}
            onDatosActualizados={() => void recargarEstadoLocal()}
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
      </main>
    </div>
  );
}

export default App;
