import { useCallback, useState } from 'react';
import {
  establecerTokenSesionLocal,
  establecerUsuarioActivoClientePos,
  invocarPosApi,
  limpiarTokenSesionLocal,
} from '../db/cliente_pos_api.ts';
import type { RolUsuario } from '../domain/permisos.ts';
import {
  NOMBRES_OPERADOR,
  type OperadorItemUI,
} from '../types/estado_app.ts';

const CLAVE_SESION_OPERADOR_STORAGE = 'pos_sesion_operador_activo';

function leerSesionOperadorInicial(): OperadorItemUI | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(CLAVE_SESION_OPERADOR_STORAGE);
      if (raw) {
        const parsed = JSON.parse(raw) as OperadorItemUI;
        if (
          parsed &&
          typeof parsed.id === 'string' &&
          typeof parsed.nombre === 'string' &&
          (parsed.rol === 'superadmin' ||
            parsed.rol === 'encargado' ||
            parsed.rol === 'cajero')
        ) {
          establecerUsuarioActivoClientePos(parsed.id);
          return parsed;
        }
      }
    }
  } catch {
    // Ignorar errores de sessionStorage
  }
  return null;
}

function guardarSesionOperadorEnStorage(op: OperadorItemUI | null): void {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      if (op) {
        window.sessionStorage.setItem(
          CLAVE_SESION_OPERADOR_STORAGE,
          JSON.stringify(op)
        );
      } else {
        window.sessionStorage.removeItem(CLAVE_SESION_OPERADOR_STORAGE);
      }
    }
  } catch {
    // Ignorar errores de sessionStorage
  }
}

export interface UseSesionOperadorOpciones {
  readonly onRolActivoCambiado?: (nuevoRol: RolUsuario) => void;
  readonly onSesionCerrada?: () => void;
}

export interface UseSesionOperadorResultado {
  readonly operadorAutenticado: OperadorItemUI | null;
  readonly rolActivo: RolUsuario;
  readonly usuarioActivoId: string | null;
  readonly operadorNombreActivo: string;
  readonly esSuperadminAutenticado: boolean;
  readonly actualizarNombreOperadorServidor: (nombre: string) => void;
  readonly iniciarSesionConCredenciales: (
    usuario: string,
    clave: string
  ) => Promise<OperadorItemUI>;
  readonly inicializarPrimerSuperadmin: (params: {
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
  readonly completarCambioClaveInicial: (
    claveActual: string,
    claveNueva: string
  ) => Promise<void>;
  readonly cerrarSesionOperador: () => void;
  readonly cambiarRolDemo: (
    valorSeleccionado: string,
    usuariosOperadores?: readonly OperadorItemUI[]
  ) => void;
}

export function useSesionOperador(
  opciones: UseSesionOperadorOpciones = {}
): UseSesionOperadorResultado {
  const { onRolActivoCambiado, onSesionCerrada } = opciones;

  const [operadorAutenticado, setOperadorAutenticado] =
    useState<OperadorItemUI | null>(() => leerSesionOperadorInicial());
  const [rolActivo, setRolActivo] = useState<RolUsuario>(
    () => leerSesionOperadorInicial()?.rol ?? 'cajero'
  );
  const [usuarioActivoId, setUsuarioActivoId] = useState<string | null>(
    () => leerSesionOperadorInicial()?.id ?? null
  );
  const [operadorNombreActivo, setOperadorNombreActivo] = useState<string>(
    () => leerSesionOperadorInicial()?.nombre ?? NOMBRES_OPERADOR.cajero
  );

  const actualizarNombreOperadorServidor = useCallback((nombre: string) => {
    setOperadorNombreActivo(nombre);
  }, []);

  const iniciarSesionConCredenciales = useCallback(
    async (usuario: string, clave: string): Promise<OperadorItemUI> => {
      const res = await invocarPosApi<{
        sessionToken?: string;
        operadorActual: OperadorItemUI;
      }>('iniciar_sesion_operador', {
        usuario,
        clave,
      });
      if (res.sessionToken) {
        establecerTokenSesionLocal(res.sessionToken);
      }
      const op = res.operadorActual;
      setOperadorAutenticado(op);
      guardarSesionOperadorEnStorage(op);
      establecerUsuarioActivoClientePos(op.id);
      setUsuarioActivoId(op.id);
      setRolActivo(op.rol);
      setOperadorNombreActivo(op.nombre);
      onRolActivoCambiado?.(op.rol);
      return op;
    },
    [onRolActivoCambiado]
  );

  const inicializarPrimerSuperadmin = useCallback(
    async (params: {
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
    }): Promise<OperadorItemUI> => {
      const res = await invocarPosApi<{
        sessionToken?: string;
        operadorActual: OperadorItemUI;
      }>('inicializar_primer_superadmin', params);
      if (res.sessionToken) {
        establecerTokenSesionLocal(res.sessionToken);
      }
      const op = res.operadorActual;
      setOperadorAutenticado(op);
      guardarSesionOperadorEnStorage(op);
      establecerUsuarioActivoClientePos(op.id);
      setUsuarioActivoId(op.id);
      setRolActivo(op.rol);
      setOperadorNombreActivo(op.nombre);
      onRolActivoCambiado?.(op.rol);
      return op;
    },
    [onRolActivoCambiado]
  );

  const completarCambioClaveInicial = useCallback(
    async (claveActual: string, claveNueva: string): Promise<void> => {
      if (!operadorAutenticado) return;
      await invocarPosApi('cambiar_clave_usuario', {
        usuarioObjetivoId: operadorAutenticado.id,
        claveActual,
        claveNueva,
        debeCambiarAlIngresar: false,
      });
      const actualizado: OperadorItemUI = {
        ...operadorAutenticado,
        debe_cambiar_clave: false,
      };
      setOperadorAutenticado(actualizado);
      guardarSesionOperadorEnStorage(actualizado);
    },
    [operadorAutenticado]
  );

  const cerrarSesionOperador = useCallback(() => {
    void invocarPosApi('cerrar_sesion_operador', {}).catch(() => {});
    setOperadorAutenticado(null);
    guardarSesionOperadorEnStorage(null);
    limpiarTokenSesionLocal();
    establecerUsuarioActivoClientePos(null);
    setUsuarioActivoId(null);
    setRolActivo('cajero');
    setOperadorNombreActivo(NOMBRES_OPERADOR.cajero);
    onSesionCerrada?.();
  }, [onSesionCerrada]);

  const cambiarRolDemo = useCallback(
    (
      valorSeleccionado: string,
      usuariosOperadores?: readonly OperadorItemUI[]
    ) => {
      // Exclusivo para cuando el usuario autenticado real es superadmin y desea probar vistas/roles
      if (operadorAutenticado?.rol !== 'superadmin') return;

      if (valorSeleccionado.startsWith('usr:')) {
        const idBuscado = valorSeleccionado.slice(4);
        const op = usuariosOperadores?.find((u) => u.id === idBuscado);
        if (op) {
          establecerUsuarioActivoClientePos(op.id);
          setUsuarioActivoId(op.id);
          setRolActivo(op.rol);
          setOperadorNombreActivo(op.nombre);
          onRolActivoCambiado?.(op.rol);
          return;
        }
      }

      const nuevoRol = valorSeleccionado as RolUsuario;
      const opPorRol = usuariosOperadores?.find((u) => u.rol === nuevoRol);
      establecerUsuarioActivoClientePos(opPorRol?.id ?? operadorAutenticado.id);
      setUsuarioActivoId(opPorRol?.id ?? operadorAutenticado.id);
      setRolActivo(nuevoRol);
      setOperadorNombreActivo(opPorRol?.nombre ?? NOMBRES_OPERADOR[nuevoRol]);
      onRolActivoCambiado?.(nuevoRol);
    },
    [operadorAutenticado, onRolActivoCambiado]
  );

  return {
    operadorAutenticado,
    rolActivo,
    usuarioActivoId,
    operadorNombreActivo,
    esSuperadminAutenticado: operadorAutenticado?.rol === 'superadmin',
    actualizarNombreOperadorServidor,
    iniciarSesionConCredenciales,
    inicializarPrimerSuperadmin,
    completarCambioClaveInicial,
    cerrarSesionOperador,
    cambiarRolDemo,
  };
}
