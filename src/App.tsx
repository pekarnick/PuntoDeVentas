import React, { useCallback, useEffect, useState } from 'react';
import { ContenedorModuloActivo } from './components/layout/ContenedorModuloActivo.tsx';
import { EncabezadoPrincipalPos } from './components/layout/EncabezadoPrincipalPos.tsx';
import { PiePaginaInstitucional } from './components/layout/PiePaginaInstitucional.tsx';
import { invocarPosApi } from './db/cliente_pos_api.ts';
import { formatearFechaAR } from './domain/dinero.ts';
import type { RolUsuario } from './domain/permisos.ts';
import { PantallaCambioClaveInicial } from './features/auth/PantallaCambioClaveInicial.tsx';
import { PantallaConfiguracionInicial } from './features/auth/PantallaConfiguracionInicial.tsx';
import { PantallaLoginOperador } from './features/auth/PantallaLoginOperador.tsx';
import { useEstadoServidorPos } from './hooks/useEstadoServidorPos.ts';
import { useSesionOperador } from './hooks/useSesionOperador.ts';
import { useTemaVisual } from './hooks/useTemaVisual.ts';
import {
  calcularPermisosModulosPorRol,
  esPestaniaPermitidaParaRol,
  type PestaniaActiva,
} from './types/estado_app.ts';

export type {
  EstadoInicialServidor,
  ModoTemaVisual,
  OperadorItemUI,
  PermisosModulosUI,
  PestaniaActiva,
} from './types/estado_app.ts';

export function App(): React.ReactElement {
  const [pestania, setPestania] = useState<PestaniaActiva>('venta');
  const [requiereConfigInicial, setRequiereConfigInicial] = useState(false);
  const [rutaArranqueDb, setRutaArranqueDb] = useState<string | undefined>(
    undefined
  );
  const esEntornoTest =
    typeof import.meta !== 'undefined' &&
    Boolean((import.meta as { env?: { MODE?: string } }).env?.MODE === 'test');
  const [cargandoArranque, setCargandoArranque] = useState(!esEntornoTest);
  const [errorArranque, setErrorArranque] = useState<string | null>(null);
  const { modoTema, alternarTemaVisual } = useTemaVisual();

  const ajustarPestaniaSegunRol = useCallback((nuevoRol: RolUsuario) => {
    setPestania((actual) =>
      esPestaniaPermitidaParaRol(actual, nuevoRol) ? actual : 'venta'
    );
  }, []);

  const reiniciarPestaniaAlSalir = useCallback(() => {
    setPestania('venta');
  }, []);

  const {
    operadorAutenticado,
    rolActivo,
    usuarioActivoId,
    operadorNombreActivo,
    esSuperadminAutenticado,
    actualizarNombreOperadorServidor,
    iniciarSesionConCredenciales,
    inicializarPrimerSuperadmin,
    completarCambioClaveInicial,
    cerrarSesionOperador,
    cambiarRolDemo,
  } = useSesionOperador({
    onRolActivoCambiado: ajustarPestaniaSegunRol,
    onSesionCerrada: reiniciarPestaniaAlSalir,
  });

  const consultarEstadoArranque = useCallback(async () => {
    setErrorArranque(null);
    if (!esEntornoTest) {
      setCargandoArranque(true);
    }
    try {
      const res = await invocarPosApi<{
        requiereConfiguracionInicial: boolean;
        rutaBaseDatos?: string;
      }>('obtener_estado_arranque', {});
      setRequiereConfigInicial(Boolean(res.requiereConfiguracionInicial));
      setRutaArranqueDb(res.rutaBaseDatos);
      setErrorArranque(null);
    } catch (err) {
      if (!esEntornoTest) {
        setErrorArranque(
          err instanceof Error
            ? err.message
            : 'No se pudo conectar con la base de datos local.'
        );
      }
    } finally {
      setCargandoArranque(false);
    }
  }, [esEntornoTest]);

  useEffect(() => {
    if (operadorAutenticado) {
      setRequiereConfigInicial(false);
      setCargandoArranque(false);
      setErrorArranque(null);
      return;
    }
    void consultarEstadoArranque();
  }, [operadorAutenticado, consultarEstadoArranque]);

  const {
    datosServidor,
    sincronizandoEnCurso,
    resumenSync,
    cajaAbiertaEnServidor,
    recargarEstadoLocal,
    ejecutarSubidaManual,
    ejecutarBajadaManual,
    ejecutarCicloSync,
    cambiarSucursalRapida,
  } = useEstadoServidorPos({
    autenticado: Boolean(operadorAutenticado),
    rolActivo,
    usuarioActivoId,
    onOperadorActualDetectado: actualizarNombreOperadorServidor,
  });

  const hoy = formatearFechaAR(new Date());
  const permisosModulos = calcularPermisosModulosPorRol(rolActivo);

  if (!operadorAutenticado) {
    if (cargandoArranque) {
      return (
        <div
          className={`app-layout theme-${modoTema}`}
          data-theme={modoTema}
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <section className="card" style={{ padding: '1.5rem 2rem', textAlign: 'center' }}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              Iniciando base de datos local...
            </p>
          </section>
        </div>
      );
    }

    if (errorArranque) {
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
              style={{ width: '100%', maxWidth: '520px', padding: '1.75rem' }}
            >
              <h1 style={{ margin: '0 0 0.5rem 0', fontSize: '1.35rem' }}>
                No se pudo iniciar la base de datos local
              </h1>
              <p className="text-muted" style={{ marginTop: 0 }}>
                El sistema necesita acceso a su base de datos local para iniciar.
              </p>
              <div className="alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                {errorArranque}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void consultarEstadoArranque()}
              >
                Reintentar conexión
              </button>
            </section>
          </main>
          <PiePaginaInstitucional />
        </div>
      );
    }

    if (requiereConfigInicial) {
      return (
        <PantallaConfiguracionInicial
          modoTema={modoTema}
          onAlternarTema={alternarTemaVisual}
          fechaHoy={hoy}
          rutaBaseDatos={rutaArranqueDb}
          onInicializarComercio={async (params) => {
            const op = await inicializarPrimerSuperadmin(params);
            setRequiereConfigInicial(false);
            return op;
          }}
        />
      );
    }

    return (
      <PantallaLoginOperador
        modoTema={modoTema}
        onAlternarTema={alternarTemaVisual}
        fechaHoy={hoy}
        rutaBaseDatos={rutaArranqueDb ?? datosServidor?.rutaBaseDatos}
        onIniciarSesion={async (usuario, clave) => {
          await iniciarSesionConCredenciales(usuario, clave);
        }}
      />
    );
  }

  if (operadorAutenticado.debe_cambiar_clave) {
    return (
      <PantallaCambioClaveInicial
        modoTema={modoTema}
        operadorAutenticado={operadorAutenticado}
        onGuardarNuevaClave={async (claveActual, claveNueva) => {
          await completarCambioClaveInicial(claveActual, claveNueva);
          await recargarEstadoLocal();
        }}
        onCancelarYSalir={cerrarSesionOperador}
      />
    );
  }

  return (
    <div className={`app-layout theme-${modoTema}`} data-theme={modoTema}>
      <EncabezadoPrincipalPos
        rutaBaseDatos={datosServidor?.rutaBaseDatos}
        sucursales={datosServidor?.sucursales}
        sucursalActiva={datosServidor?.sucursalActiva}
        onCambiarSucursal={(id) => void cambiarSucursalRapida(id)}
        modoTema={modoTema}
        onAlternarTema={alternarTemaVisual}
        operadorAutenticado={operadorAutenticado}
        operadorNombreActivo={operadorNombreActivo}
        rolActivo={rolActivo}
        usuarioActivoId={usuarioActivoId}
        usuariosOperadores={datosServidor?.usuariosOperadores}
        esSuperadminAutenticado={esSuperadminAutenticado}
        onCambiarRolDemo={(valor) =>
          cambiarRolDemo(valor, datosServidor?.usuariosOperadores)
        }
        onCerrarSesion={cerrarSesionOperador}
        fechaHoy={hoy}
        resumenSync={resumenSync}
        sincronizandoEnCurso={sincronizandoEnCurso}
        onSubirAhora={() => void ejecutarSubidaManual()}
        onBajarAhora={() => void ejecutarBajadaManual()}
        pestaniaActiva={pestania}
        onCambiarPestania={setPestania}
        permisos={permisosModulos}
        tieneDatosServidor={Boolean(datosServidor)}
        cajaAbiertaEnServidor={cajaAbiertaEnServidor}
      />

      <ContenedorModuloActivo
        pestania={pestania}
        rolActivo={rolActivo}
        operadorNombreActivo={operadorNombreActivo}
        datosServidor={datosServidor}
        resumenSync={resumenSync}
        permisos={permisosModulos}
        onCambiarPestania={setPestania}
        onRecargarEstadoLocal={recargarEstadoLocal}
        onSubirAhora={ejecutarSubidaManual}
        onBajarAhora={ejecutarBajadaManual}
        onSincronizarCicloCompleto={ejecutarCicloSync}
      />

      <PiePaginaInstitucional />
    </div>
  );
}

export default App;
