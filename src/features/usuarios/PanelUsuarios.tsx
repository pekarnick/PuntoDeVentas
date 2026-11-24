import React, { useEffect, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';
import type { RolUsuario } from '../../domain/permisos.ts';

interface UsuarioFilaUI {
  readonly id: string;
  readonly nombre: string;
  readonly usuario: string;
  readonly rol: RolUsuario;
  readonly puede_vender_movil?: boolean;
  readonly activo: boolean;
  readonly debe_cambiar_clave: boolean;
}

export function PanelUsuarios(): React.ReactElement {
  const [usuarios, setUsuarios] = useState<UsuarioFilaUI[]>([]);
  const [paginaUsuarios, setPaginaUsuarios] = useState(1);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoUsuario, setNuevoUsuario] = useState('');
  const [nuevaClaveInicial, setNuevaClaveInicial] = useState('');
  const [nuevoRol, setNuevoRol] = useState<RolUsuario>('cajero');

  // Estado para cambiar la contraseña directamente desde el listado de usuarios
  const [usuarioEditandoClaveId, setUsuarioEditandoClaveId] = useState<
    string | null
  >(null);
  const [claveNuevaEdicion, setClaveNuevaEdicion] = useState('');
  const [mostrarClaveEdicion, setMostrarClaveEdicion] = useState(false);

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

    if (
      nuevaClaveInicial.trim().length > 0 &&
      nuevaClaveInicial.trim().length < 8
    ) {
      setMensajeError(
        'La contraseña debe tener al menos 8 caracteres (ej: Cajero1234).'
      );
      return;
    }

    try {
      const res = await invocarPosApi<{
        id: string;
        claveAsignada?: string;
        esTemporal?: boolean;
      }>('crear_usuario', {
        rolActivo: 'superadmin',
        nombre: nuevoNombre.trim(),
        usuario: nuevoUsuario.trim().toLowerCase(),
        claveNueva: nuevaClaveInicial.trim() || undefined,
        rol: nuevoRol,
      });

      const usrCreado = nuevoUsuario.trim().toLowerCase();
      const fuePersonalizada = nuevaClaveInicial.trim().length >= 8;
      setNuevoNombre('');
      setNuevoUsuario('');
      setNuevaClaveInicial('');
      setMensajeClaveTemporal(
        fuePersonalizada
          ? `✅ Usuario "${usrCreado}" creado con su contraseña personalizada y estado "Al día".`
          : `Usuario "${usrCreado}" guardado en la base de datos. Clave temporal asignada: ${res.claveAsignada ?? 'Temporal2026!'}`
      );
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo crear el usuario.'
      );
    }
  }

  async function manejarGuardarNuevaClaveDirecta(u: UsuarioFilaUI) {
    setMensajeError(null);
    setMensajeClaveTemporal(null);

    const limpia = claveNuevaEdicion.trim();
    if (limpia.length < 8) {
      setMensajeError(
        `La nueva contraseña para "${u.usuario}" debe tener al menos 8 caracteres.`
      );
      return;
    }

    try {
      await invocarPosApi('cambiar_clave_usuario', {
        rolActivo: 'superadmin',
        usuarioObjetivoId: u.id,
        claveNueva: limpia,
        debeCambiarAlIngresar: false,
      });
      setUsuarioEditandoClaveId(null);
      setClaveNuevaEdicion('');
      setMostrarClaveEdicion(false);
      setMensajeClaveTemporal(
        `✅ Contraseña actualizada correctamente para "${u.nombre}" (${u.usuario}). El estado de clave quedó "Al día".`
      );
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo guardar la nueva contraseña.'
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
        `Clave reseteada en la base de datos para "${u.usuario}". Nueva clave temporal: ${res.claveTemporal}`
      );
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo resetear la clave.'
      );
    }
  }

  async function manejarCambiarPermisoMovil(u: UsuarioFilaUI) {
    setMensajeError(null);
    try {
      await invocarPosApi('actualizar_permiso_venta_movil', {
        rolActivo: 'superadmin',
        usuarioObjetivoId: u.id,
        puedeVenderMovil: !u.puede_vender_movil,
      });
      await cargarUsuarios();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo actualizar el permiso de venta móvil.'
      );
    }
  }

  const paginacionUsuarios = paginarListado(
    usuarios,
    paginaUsuarios,
    TAMANIO_PAGINA_POR_DEFECTO
  );

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
        style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}
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
          Contraseña inicial (mín. 8 caract.):
          <input
            type="password"
            value={nuevaClaveInicial}
            onChange={(e) => setNuevaClaveInicial(e.target.value)}
            placeholder="Ej: Cajero1234 (o vacío = temporal)"
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
          Crear Usuario
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Usuario</th>
            <th>Rol</th>
            <th>Venta Móvil</th>
            <th>Estado</th>
            <th>Cambio de clave</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {paginacionUsuarios.itemsPagina.map((u) => {
            const editandoEstaFila = usuarioEditandoClaveId === u.id;
            return (
              <React.Fragment key={u.id}>
                <tr>
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
                        checked={Boolean(u.puede_vender_movil)}
                        onChange={() => void manejarCambiarPermisoMovil(u)}
                      />
                      <span>{u.puede_vender_movil ? 'Habilitado' : 'No'}</span>
                    </label>
                  </td>
                  <td>{u.activo ? 'Activo' : 'Desactivado'}</td>
                  <td>
                    {u.debe_cambiar_clave ? (
                      <span
                        className="badge-rol rol-encargado"
                        style={{ cursor: 'pointer' }}
                        title="Hacé clic para asignar la contraseña definitiva"
                        onClick={() => {
                          setUsuarioEditandoClaveId(u.id);
                          setClaveNuevaEdicion('');
                          setMensajeError(null);
                        }}
                      >
                        Pendiente al ingresar (clic para cambiar)
                      </span>
                    ) : (
                      <span className="badge-rol rol-cajero">Al día</span>
                    )}
                  </td>
                  <td
                    className="actions-cell"
                    style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}
                  >
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        if (editandoEstaFila) {
                          setUsuarioEditandoClaveId(null);
                          setClaveNuevaEdicion('');
                        } else {
                          setUsuarioEditandoClaveId(u.id);
                          setClaveNuevaEdicion('');
                          setMensajeError(null);
                        }
                      }}
                    >
                      🔑 Cambiar clave
                    </button>
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
                      title="Generar clave temporal aleatoria y pedir cambio al ingresar"
                    >
                      Resetear temporal
                    </button>
                  </td>
                </tr>
                {editandoEstaFila && (
                  <tr>
                    <td colSpan={7}>
                      <div
                        className="subcard-box"
                        style={{
                          padding: '0.85rem 1rem',
                          borderRadius: '0.5rem',
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.65rem',
                          alignItems: 'flex-end',
                        }}
                      >
                        <div style={{ flex: '1 1 260px' }}>
                          <label
                            htmlFor={`input-nueva-clave-${u.id}`}
                            style={{
                              display: 'block',
                              fontWeight: 600,
                              marginBottom: '0.3rem',
                            }}
                          >
                            🔑 Nueva contraseña para {u.nombre} (
                            <code>{u.usuario}</code>):
                          </label>
                          <div style={{ display: 'flex', gap: '0.4rem' }}>
                            <input
                              id={`input-nueva-clave-${u.id}`}
                              type={mostrarClaveEdicion ? 'text' : 'password'}
                              autoFocus
                              value={claveNuevaEdicion}
                              onChange={(e) =>
                                setClaveNuevaEdicion(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void manejarGuardarNuevaClaveDirecta(u);
                                }
                              }}
                              placeholder="Escribí la contraseña nueva (mínimo 8 caracteres)"
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() =>
                                setMostrarClaveEdicion((prev) => !prev)
                              }
                            >
                              {mostrarClaveEdicion ? '🙈 Ocultar' : '👁️ Ver'}
                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => void manejarGuardarNuevaClaveDirecta(u)}
                        >
                          💾 Guardar nueva contraseña
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setUsuarioEditandoClaveId(null);
                            setClaveNuevaEdicion('');
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <PaginadorTabla
        paginaActual={paginacionUsuarios.paginaActual}
        totalPaginas={paginacionUsuarios.totalPaginas}
        totalItems={paginacionUsuarios.totalItems}
        desdeRegistro={paginacionUsuarios.desdeRegistro}
        hastaRegistro={paginacionUsuarios.hastaRegistro}
        tamanioPagina={paginacionUsuarios.tamanioPagina}
        onCambiarPagina={setPaginaUsuarios}
        etiquetaItems="usuarios"
      />
    </section>
  );
}
