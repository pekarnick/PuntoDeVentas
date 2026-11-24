import React from 'react';
import type { RolUsuario } from '../../domain/permisos.ts';
import type { ResumenEstadoSyncUI } from '../../domain/sync.ts';
import type { SucursalResumenUI } from '../../features/productos/PanelProductosStock.tsx';
import type {
  ModoTemaVisual,
  OperadorItemUI,
  PermisosModulosUI,
  PestaniaActiva,
} from '../../types/estado_app.ts';
import { BarraNavegacionModulos } from './BarraNavegacionModulos.tsx';

export interface EncabezadoPrincipalPosProps {
  readonly rutaBaseDatos?: string;
  readonly sucursales?: readonly SucursalResumenUI[];
  readonly sucursalActiva?: SucursalResumenUI | null;
  readonly onCambiarSucursal: (nuevaSucursalId: string) => void;
  readonly modoTema: ModoTemaVisual;
  readonly onAlternarTema: () => void;
  readonly operadorAutenticado: OperadorItemUI;
  readonly operadorNombreActivo: string;
  readonly rolActivo: RolUsuario;
  readonly usuarioActivoId: string | null;
  readonly usuariosOperadores?: readonly OperadorItemUI[];
  readonly esSuperadminAutenticado: boolean;
  readonly onCambiarRolDemo: (valorSeleccionado: string) => void;
  readonly onCerrarSesion: () => void;
  readonly fechaHoy: string;
  readonly resumenSync: ResumenEstadoSyncUI;
  readonly sincronizandoEnCurso: boolean;
  readonly onSubirAhora: () => void;
  readonly onBajarAhora: () => void;
  readonly pestaniaActiva: PestaniaActiva;
  readonly onCambiarPestania: (nuevaPestania: PestaniaActiva) => void;
  readonly permisos: PermisosModulosUI;
  readonly tieneDatosServidor: boolean;
  readonly cajaAbiertaEnServidor: boolean;
}

export function EncabezadoPrincipalPos({
  rutaBaseDatos,
  sucursales,
  sucursalActiva,
  onCambiarSucursal,
  modoTema,
  onAlternarTema,
  operadorAutenticado,
  operadorNombreActivo,
  rolActivo,
  usuarioActivoId,
  usuariosOperadores,
  esSuperadminAutenticado,
  onCambiarRolDemo,
  onCerrarSesion,
  fechaHoy,
  resumenSync,
  sincronizandoEnCurso,
  onSubirAhora,
  onBajarAhora,
  pestaniaActiva,
  onCambiarPestania,
  permisos,
  tieneDatosServidor,
  cajaAbiertaEnServidor,
}: EncabezadoPrincipalPosProps): React.ReactElement {
  return (
    <header className="topbar">
      <div className="topbar-row-top">
        <div className="topbar-brand">
          <span className="brand-dot" aria-hidden="true" />
          <strong>Punto de Ventas</strong>
          <span
            className="badge-fase"
            title={rutaBaseDatos ?? 'data/pos_local.db'}
          >
            Base de Datos: local
          </span>
        </div>

        <div className="topbar-status">
          {sucursales && sucursales.length > 0 && (
            <label
              className="role-switcher"
              title="Sucursal activa en esta terminal"
            >
              <span>📍 Sucursal:</span>
              <select
                value={sucursalActiva?.id ?? sucursales[0]?.id ?? ''}
                onChange={(e) => onCambiarSucursal(e.target.value)}
              >
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre} ({s.codigo})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="nav-btn nav-btn-compact theme-toggle-btn"
            onClick={onAlternarTema}
            aria-label={
              modoTema === 'claro'
                ? 'Cambiar a modo oscuro'
                : 'Cambiar a modo claro'
            }
            title="Alternar entre Modo Claro y Modo Oscuro"
          >
            {modoTema === 'claro' ? '🌙 Modo Oscuro' : '☀️ Modo Claro'}
          </button>

          <span
            className="badge-fase"
            title={`Sesión iniciada como ${operadorAutenticado.nombre} (rol real: ${operadorAutenticado.rol})`}
          >
            👤 {operadorNombreActivo} ({rolActivo})
          </span>

          {esSuperadminAutenticado && (
            <label
              className="role-switcher"
              title="Exclusivo para Superadmin: probar cómo se ve el sistema con otros roles"
            >
              <span>🧪 Probar rol:</span>
              <select
                value={
                  usuarioActivoId &&
                  usuariosOperadores?.some((u) => u.id === usuarioActivoId)
                    ? `usr:${usuarioActivoId}`
                    : rolActivo
                }
                onChange={(e) => onCambiarRolDemo(e.target.value)}
              >
                <option value="superadmin">María (superadmin)</option>
                <option value="encargado">Carlos (encargado)</option>
                <option value="cajero">Lucas (cajero)</option>
                {usuariosOperadores && usuariosOperadores.length > 0 && (
                  <optgroup label="Operadores activos en base de datos">
                    {usuariosOperadores.map((op) => (
                      <option key={op.id} value={`usr:${op.id}`}>
                        {op.nombre} ({op.rol})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}

          <button
            type="button"
            className="nav-btn nav-btn-compact"
            onClick={onCerrarSesion}
            title="Cerrar sesión actual y volver a la pantalla de ingreso"
          >
            🚪 Cerrar sesión
          </button>
          <span className="topbar-date">{fechaHoy}</span>
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
              onClick={onSubirAhora}
            >
              ↑ Subir
            </button>
            <button
              type="button"
              className="nav-btn nav-btn-compact"
              disabled={sincronizandoEnCurso}
              title="Bajar datos ahora (Pull)"
              onClick={onBajarAhora}
            >
              ↓ Bajar
            </button>
          </div>
        </div>
      </div>

      <BarraNavegacionModulos
        pestaniaActiva={pestaniaActiva}
        onCambiarPestania={onCambiarPestania}
        permisos={permisos}
        tieneDatosServidor={tieneDatosServidor}
        cajaAbiertaEnServidor={cajaAbiertaEnServidor}
      />
    </header>
  );
}
