import type { ProductoCatalogoVenta } from '../domain/escaner.ts';
import { tienePermiso, type RolUsuario } from '../domain/permisos.ts';
import type { ResumenEstadoSyncUI } from '../domain/sync.ts';
import type { EstadoCajaServidorUI } from '../features/caja/PanelCaja.tsx';
import type { ClienteConSaldoUI } from '../features/clientes/PanelClientesCuentaCorriente.tsx';
import type {
  CompraResumenUI,
  ProveedorConSaldoUI,
} from '../features/compras/PanelComprasProveedores.tsx';
import type {
  ConfiguracionSistemaDTO,
  EstadisticasEspacioImagenesDTO,
  EstadoConfiguracionArcaDTO,
  EstadoConfigVentaMovilDTO,
  RegistroHistorialBackupDTO,
} from '../features/configuracion/PanelConfiguracionSync.tsx';
import type {
  CategoriaItemUI,
  MarcaItemUI,
  ProductoAdminItemUI,
  SucursalResumenUI,
  TransferenciaSucursalUI,
} from '../features/productos/PanelProductosStock.tsx';
import type {
  ComboPromocionUI,
  ListaPrecioUI,
  VentaRecienteResumenUI,
} from '../features/venta/PanelVentaPOS.tsx';

export type PestaniaActiva =
  | 'venta'
  | 'productos'
  | 'compras'
  | 'clientes'
  | 'caja'
  | 'informes'
  | 'usuarios'
  | 'auditoria'
  | 'configuracion'
  | 'ayuda';

export type ModoTemaVisual = 'claro' | 'oscuro';

export const NOMBRES_OPERADOR: Record<RolUsuario, string> = {
  superadmin: 'María Superadmin',
  encargado: 'Carlos Encargado',
  cajero: 'Lucas Cajero',
};

export interface OperadorItemUI {
  readonly id: string;
  readonly nombre: string;
  readonly usuario?: string;
  readonly rol: RolUsuario;
  readonly debe_cambiar_clave?: boolean;
}

export interface EstadoInicialServidor {
  readonly rutaBaseDatos: string;
  readonly operadorActual?: OperadorItemUI;
  readonly usuariosOperadores?: readonly OperadorItemUI[];
  readonly cambiosPendientesSync: number;
  readonly estadoSync?: ResumenEstadoSyncUI;
  readonly configuracionSistema?: ConfiguracionSistemaDTO | null;
  readonly configVentaMovil?: EstadoConfigVentaMovilDTO | null;
  readonly configArca?: EstadoConfiguracionArcaDTO | null;
  readonly listasPrecio?: readonly ListaPrecioUI[];
  readonly combos?: readonly ComboPromocionUI[];
  readonly sucursales?: readonly SucursalResumenUI[];
  readonly sucursalActiva?: SucursalResumenUI | null;
  readonly transferenciasSucursales?: readonly TransferenciaSucursalUI[];
  readonly historialBackups?: readonly RegistroHistorialBackupDTO[];
  readonly espacioImagenes?: EstadisticasEspacioImagenesDTO;
  readonly catalogoVenta: readonly ProductoCatalogoVenta[];
  readonly catalogoAdmin: readonly ProductoAdminItemUI[];
  readonly ventasRecientes: readonly VentaRecienteResumenUI[];
  readonly estadoCaja: EstadoCajaServidorUI | null;
  readonly categorias?: readonly CategoriaItemUI[];
  readonly marcas?: readonly MarcaItemUI[];
  readonly proveedores?: readonly ProveedorConSaldoUI[];
  readonly comprasRecientes?: readonly CompraResumenUI[];
  readonly clientes?: readonly ClienteConSaldoUI[];
}

export interface PermisosModulosUI {
  readonly puedeGestionarCompras: boolean;
  readonly puedeVerInformes: boolean;
  readonly puedeGestionarUsuarios: boolean;
  readonly puedeVerAuditoria: boolean;
  readonly puedeConfigurarSistema: boolean;
}

export function calcularPermisosModulosPorRol(
  rolActivo: RolUsuario
): PermisosModulosUI {
  return {
    puedeGestionarCompras: tienePermiso(
      rolActivo,
      'abm_productos_precios_stock_compras'
    ),
    puedeVerInformes: tienePermiso(rolActivo, 'ver_informes_gestion'),
    puedeGestionarUsuarios: tienePermiso(rolActivo, 'gestionar_usuarios'),
    puedeVerAuditoria: tienePermiso(rolActivo, 'ver_exportar_auditoria'),
    puedeConfigurarSistema: tienePermiso(rolActivo, 'configuracion_sensible'),
  };
}

export function esPestaniaPermitidaParaRol(
  pestania: PestaniaActiva,
  rol: RolUsuario
): boolean {
  if (
    pestania === 'compras' &&
    !tienePermiso(rol, 'abm_productos_precios_stock_compras')
  ) {
    return false;
  }
  if (
    pestania === 'informes' &&
    !tienePermiso(rol, 'ver_informes_gestion')
  ) {
    return false;
  }
  if (pestania === 'usuarios' && !tienePermiso(rol, 'gestionar_usuarios')) {
    return false;
  }
  if (
    pestania === 'auditoria' &&
    !tienePermiso(rol, 'ver_exportar_auditoria')
  ) {
    return false;
  }
  if (
    pestania === 'configuracion' &&
    !tienePermiso(rol, 'configuracion_sensible')
  ) {
    return false;
  }
  return true;
}
