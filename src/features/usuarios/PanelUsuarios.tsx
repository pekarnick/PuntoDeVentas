import React, { useEffect, useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import type { RolUsuario } from '../../domain/permisos.ts';

interface UsuarioFilaUI {
  readonly id: string;
  readonly nombre: string;
  readonly usuario: string;
  readonly rol: RolUsuario;
  readonly activo: boolean;
  readonly debe_cambiar_clave: boolean;
}

export function PanelUsuarios(): React.ReactElement {
  const [usuarios, setUsuarios] = useState<UsuarioFilaUI[]>([]);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoUsuario, setNuevoUsuario] = useState('');
  const [nuevoRol, setNuevoRol] = useState<RolUsuario>('cajero');
  const [mensajeClaveTemporal, setMensajeClaveTemporal] = useState<
    string | null
  >(null);
  const [mensajeError, setMensajeError] = useState<string | null>(null);

  async function cargarUsuarios() {
    try {
      const lista = await invocarPosApi<UsuarioFilaUI[]>('listar_usuarios', {
        rolActivo: 'superadmin',
      });
      setUsuarios(lista);
    } catch {
      // Fallback para entornos sin servidor activo
    }
  }

  useEffect(() => {
    void cargarUsuarios();
  }, []);

  async function manejarCrearUsuario(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeClaveTemporal(null);

    if (!nuevoNombre.trim() || !nuevoUsuario.trim()) {
      setMensajeError('Completá el nombre completo y el nombre de usuario.');
      return;
    }

    try {
      await invocarPosApi('crear_usuario', {
        rolActivo: 'superadmin',
        nombre: nuevoNombre.trim(),
        usuario: nuevoUsuario.trim().toLowerCase(),
        rol: nuevoRol,
      });

      setNuevoNombre('');
      setNuevoUsuario('');
      setMensajeClaveTemporal(
        `Usuario "${nuevoUsuario.trim().toLowerCase()}" guardado en SQLite. Clave temporal asignada: Temporal2026!`
      );
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo crear el usuario.'
      );
    }
  }

  async function manejarCambiarEstado(u: UsuarioFilaUI) {
    setMensajeError(null);
    setMensajeClaveTemporal(null);
    try {
      await invocarPosApi('actualizar_usuario', {
        rolActivo: 'superadmin',
        usuarioObjetivoId: u.id,
        nuevoRol: u.rol,
        nuevoActivo: !u.activo,
      });
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo actualizar el usuario.'
      );
    }
  }

  async function manejarResetearClave(u: UsuarioFilaUI) {
    setMensajeError(null);
    try {
      const res = await invocarPosApi<{ claveTemporal: string }>(
        'resetear_clave_usuario',
        {
          rolActivo: 'superadmin',
          usuarioObjetivoId: u.id,
        }
      );
      setMensajeClaveTemporal(
        `Clave reseteada en SQLite para "${u.usuario}". Nueva clave temporal: ${res.claveTemporal}`
      );
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo resetear la clave.'
      );
    }
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

      <form
        onSubmit={(e) => void manejarCrearUsuario(e)}
        className="form-row"
      >
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
            <option value="encargado">
              Encargado (productos, compras, informes)
            </option>
            <option value="superadmin">
              Superadmin (acceso total + auditoría)
            </option>
          </select>
        </label>
        <button type="submit" className="btn-primary">
          Crear Usuario en SQLite
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
                  onClick={() => void manejarCambiarEstado(u)}
                >
                  {u.activo ? 'Desactivar' : 'Reactivar'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void manejarResetearClave(u)}
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
