import React, { useState } from 'react';
import type {
  ModoTemaVisual,
  OperadorItemUI,
} from '../../types/estado_app.ts';

export interface PantallaCambioClaveInicialProps {
  readonly modoTema: ModoTemaVisual;
  readonly operadorAutenticado: OperadorItemUI;
  readonly onGuardarNuevaClave: (
    claveActual: string,
    claveNueva: string
  ) => Promise<void>;
  readonly onCancelarYSalir: () => void;
}

export function PantallaCambioClaveInicial({
  modoTema,
  operadorAutenticado,
  onGuardarNuevaClave,
  onCancelarYSalir,
}: PantallaCambioClaveInicialProps): React.ReactElement {
  const [claveActualPrimerIngreso, setClaveActualPrimerIngreso] = useState('');
  const [claveNuevaPrimerIngreso, setClaveNuevaPrimerIngreso] = useState('');
  const [claveConfirmarPrimerIngreso, setClaveConfirmarPrimerIngreso] =
    useState('');
  const [mostrarClave, setMostrarClave] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function manejarSubmitCambioClave(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    const actual = claveActualPrimerIngreso;
    const nueva = claveNuevaPrimerIngreso.trim();
    const confirmacion = claveConfirmarPrimerIngreso.trim();
    if (!actual) {
      setErrorMsg('Ingresá tu contraseña actual o temporal.');
      return;
    }
    if (nueva.length < 8) {
      setErrorMsg('La contraseña nueva debe tener al menos 8 caracteres.');
      return;
    }
    if (nueva !== confirmacion) {
      setErrorMsg('Las contraseñas ingresadas no coinciden.');
      return;
    }

    setCargando(true);
    try {
      await onGuardarNuevaClave(actual, nueva);
      setClaveActualPrimerIngreso('');
      setClaveNuevaPrimerIngreso('');
      setClaveConfirmarPrimerIngreso('');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo actualizar la contraseña.'
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
          </div>
          <div className="topbar-status">
            <span className="badge-fase">
              👤 {operadorAutenticado.nombre} ({operadorAutenticado.rol})
            </span>
            <button
              type="button"
              className="nav-btn nav-btn-compact"
              onClick={onCancelarYSalir}
            >
              🚪 Cancelar / Salir
            </button>
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
            maxWidth: '480px',
            padding: '1.75rem',
          }}
        >
          <h2 style={{ marginTop: 0 }}>
            🔑 Definir tu Nueva Contraseña Personal
          </h2>
          <p className="text-muted">
            Hola <strong>{operadorAutenticado.nombre}</strong>, tu cuenta tiene
            una clave temporal o pendiente de cambio. Escribí tu nueva
            contraseña (mínimo 8 caracteres) para dejarla{' '}
            <strong>Al día</strong>:
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

          <form
            onSubmit={(e) => void manejarSubmitCambioClave(e)}
            className="form-stack"
          >
            <div className="form-group">
              <label htmlFor="input-actual-clave-ingreso">
                Contraseña actual o temporal
              </label>
              <input
                id="input-actual-clave-ingreso"
                type={mostrarClave ? 'text' : 'password'}
                autoFocus
                value={claveActualPrimerIngreso}
                onChange={(e) => setClaveActualPrimerIngreso(e.target.value)}
                placeholder="Ingresá la clave con la que iniciaste sesión"
              />
            </div>

            <div className="form-group">
              <label htmlFor="input-nueva-clave-ingreso">
                Nueva contraseña (mín. 8 caracteres)
              </label>
              <input
                id="input-nueva-clave-ingreso"
                type={mostrarClave ? 'text' : 'password'}
                value={claveNuevaPrimerIngreso}
                onChange={(e) => setClaveNuevaPrimerIngreso(e.target.value)}
                placeholder="Escribí tu nueva contraseña"
              />
            </div>

            <div className="form-group">
              <label htmlFor="input-confirmar-clave-ingreso">
                Repetir nueva contraseña
              </label>
              <input
                id="input-confirmar-clave-ingreso"
                type={mostrarClave ? 'text' : 'password'}
                value={claveConfirmarPrimerIngreso}
                onChange={(e) => setClaveConfirmarPrimerIngreso(e.target.value)}
                placeholder="Repetí la contraseña"
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setMostrarClave((prev) => !prev)}
              >
                {mostrarClave ? '🙈 Ocultar' : '👁️ Ver contraseñas'}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={cargando}
                style={{ flex: 1 }}
              >
                {cargando
                  ? 'Guardando...'
                  : '💾 Guardar Contraseña e Ingresar'}
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
