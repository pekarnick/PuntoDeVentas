import React, { useState } from 'react';
import { generarClaveTemporal } from '../../domain/claves.ts';
import {
  validarProteccionUltimoSuperadmin,
  type RolUsuario,
} from '../../domain/permisos.ts';

interface UsuarioFilaUI {
  readonly id: string;
  readonly nombre: string;
  readonly usuario: string;
  readonly rol: RolUsuario;
  readonly activo: boolean;
  readonly debe_cambiar_clave: boolean;
}

export function PanelUsuarios(): React.ReactElement {
  const [usuarios, setUsuarios] = useState<UsuarioFilaUI[]>([
    {
      id: 'usr-1',
      nombre: 'María Superadmin',
      usuario: 'maria',
      rol: 'superadmin',
      activo: true,
      debe_cambiar_clave: false,
    },
    {
      id: 'usr-2',
      nombre: 'Carlos Encargado',
      usuario: 'carlos',
      rol: 'encargado',
      activo: true,
      debe_cambiar_clave: false,
    },
    {
      id: 'usr-3',
      nombre: 'Lucas Cajero',
      usuario: 'lucas',
      rol: 'cajero',
      activo: true,
      debe_cambiar_clave: true,
    },
  ]);

  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoUsuario, setNuevoUsuario] = useState('');
  const [nuevoRol, setNuevoRol] = useState<RolUsuario>('cajero');
  const [mensajeClaveTemporal, setMensajeClaveTemporal] = useState<string | null>(
    null
  );
  const [mensajeError, setMensajeError] = useState<string | null>(null);

  function obtenerSuperadminsActivosIds(lista: readonly UsuarioFilaUI[]): string[] {
    return lista
      .filter((u) => u.rol === 'superadmin' && u.activo)
      .map((u) => u.id);
  }

  function manejarCrearUsuario(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeClaveTemporal(null);

    if (!nuevoNombre.trim() || !nuevoUsuario.trim()) {
      setMensajeError('Completá el nombre completo y el nombre de usuario.');
      return;
    }

    if (
      usuarios.some(
        (u) => u.usuario.toLowerCase() === nuevoUsuario.trim().toLowerCase()
      )
    ) {
      setMensajeError('Ya existe un usuario con ese identificador en el comercio.');
      return;
    }

    const claveTemporal = generarClaveTemporal();
    const creado: UsuarioFilaUI = {
      id: `usr-${Date.now()}`,
      nombre: nuevoNombre.trim(),
      usuario: nuevoUsuario.trim().toLowerCase(),
      rol: nuevoRol,
      activo: true,
      debe_cambiar_clave: true,
    };

    setUsuarios((prev) => [...prev, creado]);
    setNuevoNombre('');
    setNuevoUsuario('');
    setMensajeClaveTemporal(
      `Usuario "${creado.usuario}" creado con éxito. Clave temporal (deberá cambiarla al ingresar): ${claveTemporal}`
    );
  }

  function manejarCambiarEstado(u: UsuarioFilaUI) {
    setMensajeError(null);
    setMensajeClaveTemporal(null);
    try {
      const nuevoActivo = !u.activo;
      validarProteccionUltimoSuperadmin({
        usuarioObjetivo: u,
        nuevoRol: u.rol,
        nuevoActivo,
        superadminsActivosIds: obtenerSuperadminsActivosIds(usuarios),
      });

      setUsuarios((prev) =>
        prev.map((item) =>
          item.id === u.id ? { ...item, activo: nuevoActivo } : item
        )
      );
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo actualizar el usuario.'
      );
    }
  }

  function manejarResetearClave(u: UsuarioFilaUI) {
    setMensajeError(null);
    const claveTemporal = generarClaveTemporal();
    setUsuarios((prev) =>
      prev.map((item) =>
        item.id === u.id ? { ...item, debe_cambiar_clave: true } : item
      )
    );
    setMensajeClaveTemporal(
      `Clave reseteada para "${u.usuario}". Nueva clave temporal: ${claveTemporal}`
    );
  }

  return (
    <section className="pos-card">
      <div className="card-header">
        <h2>Gestión de Usuarios y Roles (Solo Superadmin)</h2>
      </div>

      <div className="alert-info">
        <strong>Nota sobre terminales sin conexión (PLAN.md §6.1):</strong> Si desactivás un
        usuario, otra terminal que esté operando sin internet podría seguir aceptándolo hasta
        su próxima sincronización. Los usuarios nunca se borran físicamente para preservar la
        trazabilidad histórica.
      </div>

      {mensajeError && <div className="alert-error">{mensajeError}</div>}
      {mensajeClaveTemporal && (
        <div className="alert-ok">{mensajeClaveTemporal}</div>
      )}

      <form onSubmit={manejarCrearUsuario} className="form-row">
        <label>
          Nombre y apellido:
          <input
            type="text"
            value={nuevoNombre}
            onChange={(e) => setNuevoNombre(e.target.value)}
            placeholder="Ej. Sofía Gómez"
          />
        </label>
        <label>
          Usuario:
          <input
            type="text"
            value={nuevoUsuario}
            onChange={(e) => setNuevoUsuario(e.target.value)}
            placeholder="sofia"
          />
        </label>
        <label>
          Rol:
          <select
            value={nuevoRol}
            onChange={(e) => setNuevoRol(e.target.value as RolUsuario)}
          >
            <option value="cajero">Cajero (sin costos ni informes)</option>
            <option value="encargado">Encargado (productos, compras, informes)</option>
            <option value="superadmin">Superadmin (acceso total + auditoría)</option>
          </select>
        </label>
        <button type="submit" className="btn-primary">
          Crear Usuario con Clave Temporal
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Usuario</th>
            <th>Rol</th>
            <th>Estado</th>
            <th>Cambio de clave</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {usuarios.map((u) => (
            <tr key={u.id}>
              <td>{u.nombre}</td>
              <td>
                <code>{u.usuario}</code>
              </td>
              <td>{u.rol}</td>
              <td>{u.activo ? 'Activo' : 'Desactivado'}</td>
              <td>
                {u.debe_cambiar_clave ? 'Pendiente al ingresar' : 'Al día'}
              </td>
              <td className="actions-cell">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => manejarCambiarEstado(u)}
                >
                  {u.activo ? 'Desactivar' : 'Reactivar'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => manejarResetearClave(u)}
                >
                  Resetear clave
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
