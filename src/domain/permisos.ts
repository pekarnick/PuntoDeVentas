/**
 * Matriz de permisos por rol y reglas de negocio de usuarios (PLAN.md §6.1 y §13).
 */

export type RolUsuario = 'superadmin' | 'encargado' | 'cajero';

export type PermisoSistema =
  | 'vender_y_caja'
  | 'ver_productos_precios_venta'
  | 'ver_costos_ganancias_margenes'
  | 'abm_productos_precios_stock_compras'
  | 'anular_venta_directo'
  | 'autorizar_anulacion_venta'
  | 'ver_informes_gestion'
  | 'gestionar_usuarios'
  | 'ver_exportar_auditoria'
  | 'configuracion_sensible'
  | 'configurar_venta_movil_y_arca';

const MATRIZ_PERMISOS: Record<RolUsuario, ReadonlySet<PermisoSistema>> = {
  superadmin: new Set<PermisoSistema>([
    'vender_y_caja',
    'ver_productos_precios_venta',
    'ver_costos_ganancias_margenes',
    'abm_productos_precios_stock_compras',
    'anular_venta_directo',
    'autorizar_anulacion_venta',
    'ver_informes_gestion',
    'gestionar_usuarios',
    'ver_exportar_auditoria',
    'configuracion_sensible',
    'configurar_venta_movil_y_arca',
  ]),
  encargado: new Set<PermisoSistema>([
    'vender_y_caja',
    'ver_productos_precios_venta',
    'ver_costos_ganancias_margenes',
    'abm_productos_precios_stock_compras',
    'anular_venta_directo',
    'autorizar_anulacion_venta',
    'ver_informes_gestion',
  ]),
  cajero: new Set<PermisoSistema>([
    'vender_y_caja',
    'ver_productos_precios_venta',
  ]),
};

export function tienePermiso(rol: RolUsuario, permiso: PermisoSistema): boolean {
  return MATRIZ_PERMISOS[rol].has(permiso);
}

export function exigirPermiso(rol: RolUsuario, permiso: PermisoSistema): void {
  if (!tienePermiso(rol, permiso)) {
    throw new Error(
      `PERMISO_DENEGADO: El rol "${rol}" no tiene permiso para "${permiso}".`
    );
  }
}

export function puedeVerCostos(rol: RolUsuario): boolean {
  return tienePermiso(rol, 'ver_costos_ganancias_margenes');
}

export function requiereAutorizacionParaAnular(rol: RolUsuario): boolean {
  return !tienePermiso(rol, 'anular_venta_directo');
}

export function puedeAutorizarAnulacion(rol: RolUsuario): boolean {
  return tienePermiso(rol, 'autorizar_anulacion_venta');
}

/**
 * Verifica que una modificación de usuario no deje al comercio sin al menos un superadmin activo.
 */
export function validarProteccionUltimoSuperadmin(params: {
  usuarioObjetivo: { id: string; rol: RolUsuario; activo: boolean };
  nuevoRol: RolUsuario;
  nuevoActivo: boolean;
  superadminsActivosIds: readonly string[];
}): void {
  const { usuarioObjetivo, nuevoRol, nuevoActivo, superadminsActivosIds } = params;

  const eraSuperadminActivo =
    usuarioObjetivo.rol === 'superadmin' && usuarioObjetivo.activo;
  const seguiraSiendoSuperadminActivo =
    nuevoRol === 'superadmin' && nuevoActivo;

  if (eraSuperadminActivo && !seguiraSiendoSuperadminActivo) {
    const otrosSuperadmins = superadminsActivosIds.filter(
      (id) => id !== usuarioObjetivo.id
    );
    if (otrosSuperadmins.length === 0) {
      throw new Error(
        'ULTIMO_SUPERADMIN: Siempre debe existir al menos un superadmin activo.'
      );
    }
  }
}
