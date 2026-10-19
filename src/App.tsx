import React, { useState } from 'react';
import { formatearFechaAR } from './domain/dinero.ts';
import { tienePermiso, type RolUsuario } from './domain/permisos.ts';
import { PanelAuditoria } from './features/auditoria/PanelAuditoria.tsx';
import { PanelCaja } from './features/caja/PanelCaja.tsx';
import { PanelProductosStock } from './features/productos/PanelProductosStock.tsx';
import { PanelUsuarios } from './features/usuarios/PanelUsuarios.tsx';
import { PanelVentaPOS } from './features/venta/PanelVentaPOS.tsx';
import { formatearEstadoSync } from './sync/index.ts';

type PestaniaActiva = 'venta' | 'productos' | 'caja' | 'usuarios' | 'auditoria';

const NOMBRES_OPERADOR: Record<RolUsuario, string> = {
  superadmin: 'María Superadmin',
  encargado: 'Carlos Encargado',
  cajero: 'Lucas Cajero',
};

export function App(): React.ReactElement {
  const [rolActivo, setRolActivo] = useState<RolUsuario>('superadmin');
  const [pestania, setPestania] = useState<PestaniaActiva>('venta');

  const estadoSync = formatearEstadoSync({
    estado: 'pendiente',
    cambiosPendientes: 3,
  });

  const hoy = formatearFechaAR(new Date());

  const puedeGestionarUsuarios = tienePermiso(rolActivo, 'gestionar_usuarios');
  const puedeVerAuditoria = tienePermiso(rolActivo, 'ver_exportar_auditoria');

  function cambiarRolDemo(nuevoRol: RolUsuario) {
    setRolActivo(nuevoRol);
    if (
      (pestania === 'usuarios' && !tienePermiso(nuevoRol, 'gestionar_usuarios')) ||
      (pestania === 'auditoria' && !tienePermiso(nuevoRol, 'ver_exportar_auditoria'))
    ) {
      setPestania('venta');
    }
  }

  return (
    <div className="app-layout">
      <header className="topbar">
        <div className="topbar-brand">
          <strong>Punto de Ventas</strong>
          <span className="badge-fase">Fase 1 · Local Offline-First</span>
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
          />
        )}
        {pestania === 'productos' && (
          <PanelProductosStock rolActivo={rolActivo} />
        )}
        {pestania === 'caja' && <PanelCaja />}
        {pestania === 'usuarios' && puedeGestionarUsuarios && <PanelUsuarios />}
        {pestania === 'auditoria' && puedeVerAuditoria && <PanelAuditoria />}
      </main>
    </div>
  );
}

export default App;
