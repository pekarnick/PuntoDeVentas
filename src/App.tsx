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

  useEffect(() => {
    if (operadorAutenticado) {
      setRequiereConfigInicial(false);
      return;
    }
    void invocarPosApi<{
      requiereConfiguracionInicial: boolean;
      rutaBaseDatos?: string;
    }>('obtener_estado_arranque', {})
      .then((res) => {
        setRequiereConfigInicial(Boolean(res.requiereConfiguracionInicial));
        setRutaArranqueDb(res.rutaBaseDatos);
      })
      .catch(() => {
        // Ignorar si no hay servidor local en tests aislados
      });
  }, [operadorAutenticado]);

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
