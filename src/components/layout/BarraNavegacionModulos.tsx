import React from 'react';
import type {
  PermisosModulosUI,
  PestaniaActiva,
} from '../../types/estado_app.ts';

export interface BarraNavegacionModulosProps {
  readonly pestaniaActiva: PestaniaActiva;
  readonly onCambiarPestania: (nuevaPestania: PestaniaActiva) => void;
  readonly permisos: PermisosModulosUI;
  readonly tieneDatosServidor: boolean;
  readonly cajaAbiertaEnServidor: boolean;
}

export function BarraNavegacionModulos({
  pestaniaActiva,
  onCambiarPestania,
  permisos,
  tieneDatosServidor,
  cajaAbiertaEnServidor,
}: BarraNavegacionModulosProps): React.ReactElement {
  const {
    puedeGestionarCompras,
    puedeVerInformes,
    puedeGestionarUsuarios,
    puedeVerAuditoria,
    puedeConfigurarSistema,
  } = permisos;

  return (
    <nav className="topbar-nav" aria-label="Módulos del sistema">
      <button
        type="button"
        className={pestaniaActiva === 'venta' ? 'nav-btn active' : 'nav-btn'}
        onClick={() => onCambiarPestania('venta')}
      >
        Venta (Mostrador)
      </button>

      <button
        type="button"
        className={pestaniaActiva === 'caja' ? 'nav-btn active' : 'nav-btn'}
        onClick={() => onCambiarPestania('caja')}
        title={
          tieneDatosServidor
            ? cajaAbiertaEnServidor
              ? 'Turno de caja abierto y operativo'
              : 'Caja cerrada: hacé clic para abrir el turno'
            : 'Apertura, movimientos y cierre de caja'
        }
      >
        {tieneDatosServidor
          ? cajaAbiertaEnServidor
            ? '🟢 Caja y Arqueo'
            : '🔴 Caja y Arqueo (Cerrada)'
          : 'Caja y Arqueo'}
      </button>

      <button
        type="button"
        className={
          pestaniaActiva === 'productos' ? 'nav-btn active' : 'nav-btn'
        }
        onClick={() => onCambiarPestania('productos')}
      >
        Productos y Stock
      </button>

      {puedeGestionarCompras && (
        <button
          type="button"
          className={
            pestaniaActiva === 'compras' ? 'nav-btn active' : 'nav-btn'
          }
          onClick={() => onCambiarPestania('compras')}
        >
          Compras y Proveedores
        </button>
      )}

      <button
        type="button"
        className={pestaniaActiva === 'clientes' ? 'nav-btn active' : 'nav-btn'}
        onClick={() => onCambiarPestania('clientes')}
      >
        Clientes y Cta. Cte.
      </button>

      {puedeVerInformes && (
        <button
          type="button"
          className={
            pestaniaActiva === 'informes' ? 'nav-btn active' : 'nav-btn'
          }
          onClick={() => onCambiarPestania('informes')}
        >
          Informes y Libro IVA
        </button>
      )}

      {puedeGestionarUsuarios && (
        <button
          type="button"
          className={
            pestaniaActiva === 'usuarios' ? 'nav-btn active' : 'nav-btn'
          }
          onClick={() => onCambiarPestania('usuarios')}
        >
          Usuarios y Roles
        </button>
      )}

      {puedeVerAuditoria && (
        <button
          type="button"
          className={
            pestaniaActiva === 'auditoria' ? 'nav-btn active' : 'nav-btn'
          }
          onClick={() => onCambiarPestania('auditoria')}
        >
          Auditoría SHA-256
        </button>
      )}

      {puedeConfigurarSistema && (
        <button
          type="button"
          className={
            pestaniaActiva === 'configuracion' ? 'nav-btn active' : 'nav-btn'
          }
          onClick={() => onCambiarPestania('configuracion')}
        >
          Configuración y Sync
        </button>
      )}

      <button
        type="button"
        className={pestaniaActiva === 'ayuda' ? 'nav-btn active' : 'nav-btn'}
        onClick={() => onCambiarPestania('ayuda')}
      >
        📖 Ayuda y Manual
      </button>
    </nav>
  );
}
