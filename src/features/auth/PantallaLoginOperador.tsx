import React, { useState } from 'react';
import { PiePaginaInstitucional } from '../../components/layout/PiePaginaInstitucional.tsx';
import type { ModoTemaVisual } from '../../types/estado_app.ts';

export interface PantallaLoginOperadorProps {
  readonly modoTema: ModoTemaVisual;
  readonly onAlternarTema: () => void;
  readonly fechaHoy: string;
  readonly rutaBaseDatos?: string;
  readonly onIniciarSesion: (usuario: string, clave: string) => Promise<void>;
}

export function PantallaLoginOperador({
  modoTema,
  onAlternarTema,
  fechaHoy,
  rutaBaseDatos,
  onIniciarSesion,
}: PantallaLoginOperadorProps): React.ReactElement {
  const [loginUsuarioInput, setLoginUsuarioInput] = useState('');
  const [loginClaveInput, setLoginClaveInput] = useState('');
  const [mostrarClaveLogin, setMostrarClaveLogin] = useState(false);
  const [loginCargando, setLoginCargando] = useState(false);
  const [loginErrorMsg, setLoginErrorMsg] = useState<string | null>(null);

  async function manejarSubmitLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginErrorMsg(null);
    const usuarioLimpio = loginUsuarioInput.trim();
    if (!usuarioLimpio || !loginClaveInput) {
      setLoginErrorMsg('Ingresá tu nombre de usuario y tu contraseña.');
      return;
    }

    setLoginCargando(true);
    try {
      await onIniciarSesion(usuarioLimpio, loginClaveInput);
      setLoginUsuarioInput('');
      setLoginClaveInput('');
    } catch (err) {
      setLoginErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo iniciar sesión con esas credenciales.'
      );
    } finally {
      setLoginCargando(false);
    }
  }

  return (
    <div
      className={`app-layout theme-${modoTema}`}
      data-theme={modoTema}
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
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
            <button
              type="button"
              className="nav-btn nav-btn-compact theme-toggle-btn"
              onClick={onAlternarTema}
              aria-label={
                modoTema === 'claro'
                  ? 'Cambiar a modo oscuro'
                  : 'Cambiar a modo claro'
              }
            >
              {modoTema === 'claro' ? '🌙 Modo Oscuro' : '☀️ Modo Claro'}
            </button>
            <span className="topbar-date">{fechaHoy}</span>
          </div>
        </div>
      </header>

      <main
        className="main-content"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1rem',
          flex: 1,
        }}
      >
        <section
          className="card"
          style={{
            width: '100%',
            maxWidth: '550px',
            padding: '1.75rem',
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.12)',
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
            <h1 style={{ margin: '0 0 0.35rem 0', fontSize: '1.45rem' }}>
              🔐 Iniciar Sesión
            </h1>
            <p className="text-muted" style={{ margin: 0 }}>
              Ingresá tu usuario y contraseña para acceder al Punto de Venta
            </p>
          </div>

          {loginErrorMsg && (
            <div
              className="alert-error"
              role="alert"
              style={{ marginBottom: '1rem' }}
            >
              {loginErrorMsg}
            </div>
          )}

          <form
            onSubmit={(e) => void manejarSubmitLogin(e)}
            className="form-stack"
          >
            <div className="form-group">
              <label htmlFor="input-login-usuario">Usuario</label>
              <input
                id="input-login-usuario"
                type="text"
                autoFocus
                autoComplete="username"
                value={loginUsuarioInput}
                onChange={(e) => setLoginUsuarioInput(e.target.value)}
                placeholder="Tu nombre de usuario"
              />
            </div>

            <div className="form-group">
              <label htmlFor="input-login-clave">Contraseña</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  id="input-login-clave"
                  type={mostrarClaveLogin ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={loginClaveInput}
                  onChange={(e) => setLoginClaveInput(e.target.value)}
                  placeholder="Tu contraseña de acceso"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setMostrarClaveLogin((prev) => !prev)}
                  title="Mostrar u ocultar contraseña"
                >
                  {mostrarClaveLogin ? '🙈 Ocultar' : '👁️ Ver'}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loginCargando}
              style={{
                width: '100%',
                padding: '0.75rem',
                fontSize: '1rem',
                marginTop: '0.35rem',
              }}
            >
              {loginCargando
                ? 'Verificando credenciales...'
                : 'Ingresar al Punto de Venta'}
            </button>
          </form>
        </section>
      </main>

      <PiePaginaInstitucional subtitulo="Sistema Punto de Venta Offline-First · Acceso Seguro Argon2id" />
    </div>
  );
}
