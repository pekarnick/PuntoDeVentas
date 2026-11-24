import React, { useState } from 'react';
import { PiePaginaInstitucional } from '../../components/layout/PiePaginaInstitucional.tsx';
import type { ModoTemaVisual, OperadorItemUI } from '../../types/estado_app.ts';

export interface PantallaConfiguracionInicialProps {
  readonly modoTema: ModoTemaVisual;
  readonly onAlternarTema: () => void;
  readonly fechaHoy: string;
  readonly rutaBaseDatos?: string;
  readonly onInicializarComercio: (params: {
    nombreComercio: string;
    cuit: string;
    condicionIva:
      | 'monotributo'
      | 'responsable_inscripto'
      | 'exento'
      | 'consumidor_final';
    nombreAdmin: string;
    usuarioAdmin: string;
    claveAdmin: string;
  }) => Promise<OperadorItemUI>;
}

export function PantallaConfiguracionInicial({
  modoTema,
  onAlternarTema,
  fechaHoy,
  rutaBaseDatos,
  onInicializarComercio,
}: PantallaConfiguracionInicialProps): React.ReactElement {
  const [nombreComercio, setNombreComercio] = useState('');
  const [cuit, setCuit] = useState('');
  const [condicionIva, setCondicionIva] = useState<
    'monotributo' | 'responsable_inscripto' | 'exento' | 'consumidor_final'
  >('monotributo');
  const [nombreAdmin, setNombreAdmin] = useState('');
  const [usuarioAdmin, setUsuarioAdmin] = useState('');
  const [claveAdmin, setClaveAdmin] = useState('');
  const [confirmarClave, setConfirmarClave] = useState('');
  const [mostrarClave, setMostrarClave] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function manejarSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    if (!nombreComercio.trim() || !nombreAdmin.trim() || !usuarioAdmin.trim()) {
      setErrorMsg(
        'Completá el nombre del comercio, tu nombre completo y tu usuario.'
      );
      return;
    }
    if (claveAdmin.length < 8) {
      setErrorMsg('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (claveAdmin !== confirmarClave) {
      setErrorMsg('Las contraseñas ingresadas no coinciden.');
      return;
    }

    setCargando(true);
    try {
      await onInicializarComercio({
        nombreComercio: nombreComercio.trim(),
        cuit: cuit.trim(),
        condicionIva,
        nombreAdmin: nombreAdmin.trim(),
        usuarioAdmin: usuarioAdmin.trim(),
        claveAdmin,
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo inicializar el comercio.'
      );
    } finally {
      setCargando(false);
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
              Primer Uso
            </span>
          </div>
          <div className="topbar-status">
            <button
              type="button"
              className="nav-btn nav-btn-compact theme-toggle-btn"
              onClick={onAlternarTema}
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
          style={{ width: '100%', maxWidth: '580px', padding: '1.75rem' }}
        >
          <h1 style={{ margin: '0 0 0.35rem 0', fontSize: '1.45rem' }}>
            🏪 Configuración Inicial del Comercio
          </h1>
          <p className="text-muted" style={{ marginTop: 0 }}>
            Creá tu comercio y la cuenta de <strong>Administrador (Superadmin)</strong>{' '}
            con tu propia contraseña segura.
          </p>

          {errorMsg && (
            <div
              className="alert-error"
              role="alert"
              style={{ marginBottom: '1rem' }}
            >
              {errorMsg}
            </div>
          )}

          <form onSubmit={(e) => void manejarSubmit(e)} className="form-stack">
            <div className="form-group">
              <label htmlFor="init-comercio">Nombre del comercio</label>
              <input
                id="init-comercio"
                type="text"
                autoFocus
                value={nombreComercio}
                onChange={(e) => setNombreComercio(e.target.value)}
                placeholder="Ej: Kiosco y Librería El Sol"
              />
            </div>

            <div className="form-row-2">
              <div className="form-group">
                <label htmlFor="init-cuit">CUIT (opcional)</label>
                <input
                  id="init-cuit"
                  type="text"
                  value={cuit}
                  onChange={(e) => setCuit(e.target.value)}
                  placeholder="20-12345678-6"
                />
              </div>
              <div className="form-group">
                <label htmlFor="init-iva">Condición frente al IVA</label>
                <select
                  id="init-iva"
                  value={condicionIva}
                  onChange={(e) =>
                    setCondicionIva(
                      e.target.value as
                        | 'monotributo'
                        | 'responsable_inscripto'
                        | 'exento'
                        | 'consumidor_final'
                    )
                  }
                >
                  <option value="monotributo">Monotributo</option>
                  <option value="responsable_inscripto">
                    Responsable Inscripto
                  </option>
                  <option value="exento">Exento</option>
                </select>
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-group">
                <label htmlFor="init-nombre-admin">Tu nombre completo</label>
                <input
                  id="init-nombre-admin"
                  type="text"
                  value={nombreAdmin}
                  onChange={(e) => setNombreAdmin(e.target.value)}
                  placeholder="Ej: María Pérez"
                />
              </div>
              <div className="form-group">
                <label htmlFor="init-usuario-admin">Usuario de acceso</label>
                <input
                  id="init-usuario-admin"
                  type="text"
                  value={usuarioAdmin}
                  onChange={(e) => setUsuarioAdmin(e.target.value)}
                  placeholder="Ej: admin"
                />
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-group">
                <label htmlFor="init-clave">Contraseña (mín. 8 caracteres)</label>
                <input
                  id="init-clave"
                  type={mostrarClave ? 'text' : 'password'}
                  value={claveAdmin}
                  onChange={(e) => setClaveAdmin(e.target.value)}
                  placeholder="Elegí una clave segura"
                />
              </div>
              <div className="form-group">
                <label htmlFor="init-clave-conf">Confirmar contraseña</label>
                <input
                  id="init-clave-conf"
                  type={mostrarClave ? 'text' : 'password'}
                  value={confirmarClave}
                  onChange={(e) => setConfirmarClave(e.target.value)}
                  placeholder="Repetí tu contraseña"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setMostrarClave((p) => !p)}
              >
                {mostrarClave ? '🙈 Ocultar' : '👁️ Ver claves'}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={cargando}
                style={{ flex: 1 }}
              >
                {cargando
                  ? 'Creando comercio...'
                  : '✅ Crear Comercio e Ingresar'}
              </button>
            </div>
          </form>
        </section>
      </main>

      <PiePaginaInstitucional subtitulo="Sistema Punto de Venta Offline-First · Acceso Seguro Argon2id" />
    </div>
  );
}
