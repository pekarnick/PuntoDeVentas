/**
 * Lógica pura de Sincronización, Resolución de Conflictos, Estado de Sync
 * y Validación de Seguridad del Cliente Supabase (PLAN.md §3 Regla 8, §5 y §5.1).
 */

import type { RolUsuario } from './permisos.ts';

export const ORDEN_TABLAS_SYNC = [
  'comercios',
  'usuarios',
  'dispositivos',
  'sesiones_moviles',
  'categorias',
  'marcas',
  'proveedores',
  'listas_precio',
  'productos',
  'codigos_barras',
  'precios',
  'variantes',
  'combos',
  'combos_items',
  'clientes',
  'caja_sesiones',
  'caja_movimientos',
  'ventas',
  'ventas_items',
  'ventas_pagos',
  'compras',
  'compras_items',
  'movimientos_stock',
  'cuenta_corriente_movimientos',
  'auditoria',
] as const;

export type TablaSincronizable = (typeof ORDEN_TABLAS_SYNC)[number];

export const TABLAS_APPEND_ONLY: ReadonlySet<TablaSincronizable> = new Set([
  'auditoria',
  'movimientos_stock',
  'ventas',
  'ventas_items',
  'ventas_pagos',
  'caja_sesiones',
  'caja_movimientos',
]);

export interface RegistroSincronizableBase {
  id: string;
  comercio_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  device_id: string;
  [clave: string]: unknown;
}

export interface ResultadoResolucionConflicto<
  T extends RegistroSincronizableBase = RegistroSincronizableBase,
> {
  ganador: 'local' | 'remoto' | 'fusionado_restrictivo' | 'sin_cambio';
  registroResultante: T;
  huboConflicto: boolean;
  reglaAplicada:
    | 'append_only_idempotente'
    | 'append_only_transicion_estado'
    | 'usuarios_cambio_mas_restrictivo'
    | 'lww_updated_at'
    | 'lww_desempate_device_id';
  detalleAuditoria: string;
}

const PRIORIDAD_RESTRICTIVA_ROL: Record<RolUsuario, number> = {
  // Menor valor = más restrictivo (PLAN.md §5: gana el cambio más restrictivo)
  cajero: 1,
  encargado: 2,
  superadmin: 3,
};

/**
 * Compara dos registros por updated_at y, en caso de empate exacto,
 * desempata ganando el device_id lexicográficamente menor (PLAN.md §5).
 */
export function compararLastWriteWins(
  local: RegistroSincronizableBase,
  remoto: RegistroSincronizableBase
): {
  ganador: 'local' | 'remoto';
  regla: 'lww_updated_at' | 'lww_desempate_device_id';
} {
  const tsLocal = Date.parse(local.updated_at);
  const tsRemoto = Date.parse(remoto.updated_at);

  if (!Number.isNaN(tsLocal) && !Number.isNaN(tsRemoto) && tsLocal !== tsRemoto) {
    return {
      ganador: tsRemoto > tsLocal ? 'remoto' : 'local',
      regla: 'lww_updated_at',
    };
  }

  if (local.updated_at !== remoto.updated_at) {
    return {
      ganador: remoto.updated_at > local.updated_at ? 'remoto' : 'local',
      regla: 'lww_updated_at',
    };
  }

  // Empate exacto de timestamp: gana el device_id menor de forma determinística
  const ganaRemoto = remoto.device_id < local.device_id;
  return {
    ganador: ganaRemoto ? 'remoto' : 'local',
    regla: 'lww_desempate_device_id',
  };
}

function normalizarBooleanoSQLite(valor: unknown): boolean {
  return valor === 1 || valor === true || valor === '1';
}

/**
 * Resuelve conflictos entre un registro local pendiente y un registro remoto recibido
 * siguiendo estrictamente las reglas de PLAN.md §5.
 */
export function resolverConflictoRegistro<T extends RegistroSincronizableBase>(
  tabla: TablaSincronizable,
  local: T,
  remoto: T,
  localEstabaPendiente = true
): ResultadoResolucionConflicto<T> {
  if (local.id !== remoto.id) {
    throw new Error(
      `No se pueden comparar registros con distinto ID (${local.id} vs ${remoto.id}).`
    );
  }

  // 1. Tablas append-only (ventas, ventas_items, ventas_pagos, movimientos_stock, caja_*, auditoria)
  if (TABLAS_APPEND_ONLY.has(tabla)) {
    if (tabla === 'ventas') {
      const estadoLocal = String(local.estado ?? 'completada');
      const estadoRemoto = String(remoto.estado ?? 'completada');
      if (estadoLocal !== estadoRemoto) {
        const ganador = estadoRemoto === 'anulada' ? 'remoto' : 'local';
        const registroGanador = ganador === 'remoto' ? remoto : local;
        return {
          ganador,
          registroResultante: { ...registroGanador },
          huboConflicto: true,
          reglaAplicada: 'append_only_transicion_estado',
          detalleAuditoria: `Venta ${local.id}: prevalece estado 'anulada' (${ganador}).`,
        };
      }

      const factLocal = String(local.estado_facturacion ?? 'no_aplica');
      const factRemoto = String(remoto.estado_facturacion ?? 'no_aplica');
      if (factLocal !== factRemoto) {
        const ganador =
          factRemoto === 'emitida'
            ? 'remoto'
            : factLocal === 'emitida'
              ? 'local'
              : compararLastWriteWins(local, remoto).ganador;
        const registroGanador = ganador === 'remoto' ? remoto : local;
        return {
          ganador,
          registroResultante: { ...registroGanador },
          huboConflicto: true,
          reglaAplicada: 'append_only_transicion_estado',
          detalleAuditoria: `Venta ${local.id}: prevalece estado_facturacion (${ganador}).`,
        };
      }
    }

    if (tabla === 'caja_sesiones') {
      const estadoLocal = String(local.estado ?? 'abierta');
      const estadoRemoto = String(remoto.estado ?? 'abierta');
      if (estadoLocal !== estadoRemoto) {
        const ganador = estadoRemoto === 'cerrada' ? 'remoto' : 'local';
        const registroGanador = ganador === 'remoto' ? remoto : local;
        return {
          ganador,
          registroResultante: { ...registroGanador },
          huboConflicto: true,
          reglaAplicada: 'append_only_transicion_estado',
          detalleAuditoria: `Sesión de caja ${local.id}: prevalece estado 'cerrada' (${ganador}).`,
        };
      }
    }

    return {
      ganador: 'sin_cambio',
      registroResultante: { ...local },
      huboConflicto: false,
      reglaAplicada: 'append_only_idempotente',
      detalleAuditoria: `Registro append-only en ${tabla} (${local.id}) ya presente; idempotente.`,
    };
  }

  // Si el registro local ya estaba sincronizado y no tenía cambios locales pendientes,
  // aplicamos directamente la versión remota más nueva sin marcar conflicto.
  if (!localEstabaPendiente) {
    const comp = compararLastWriteWins(local, remoto);
    const elegido = comp.ganador === 'remoto' ? remoto : local;
    return {
      ganador: comp.ganador,
      registroResultante: { ...elegido },
      huboConflicto: false,
      reglaAplicada: comp.regla,
      detalleAuditoria: `Actualización sin conflicto en ${tabla} (${local.id}).`,
    };
  }

  // 2. Tabla usuarios: los cambios de rol, desactivación y reseteo de clave tienen
  // prioridad sobre ediciones concurrentes (gana el cambio más restrictivo, PLAN.md §5).
  if (tabla === 'usuarios') {
    const lww = compararLastWriteWins(local, remoto);
    const baseGanadora = lww.ganador === 'remoto' ? { ...remoto } : { ...local };

    const rolLocal = (local.rol as RolUsuario) ?? 'cajero';
    const rolRemoto = (remoto.rol as RolUsuario) ?? 'cajero';
    const rolMasRestrictivo =
      PRIORIDAD_RESTRICTIVA_ROL[rolLocal] <= PRIORIDAD_RESTRICTIVA_ROL[rolRemoto]
        ? rolLocal
        : rolRemoto;

    const activoLocal =
      normalizarBooleanoSQLite(local.activo) && local.deleted_at === null;
    const activoRemoto =
      normalizarBooleanoSQLite(remoto.activo) && remoto.deleted_at === null;
    const activoFinal = activoLocal && activoRemoto ? 1 : 0;

    const debeCambiarLocal = normalizarBooleanoSQLite(local.debe_cambiar_clave);
    const debeCambiarRemoto = normalizarBooleanoSQLite(remoto.debe_cambiar_clave);
    const debeCambiarFinal = debeCambiarLocal || debeCambiarRemoto ? 1 : 0;

    const puedeMovilLocal = normalizarBooleanoSQLite(local.puede_vender_movil);
    const puedeMovilRemoto = normalizarBooleanoSQLite(remoto.puede_vender_movil);
    const puedeMovilFinal = puedeMovilLocal && puedeMovilRemoto ? 1 : 0;

    // Si un lado forzó debe_cambiar_clave = 1 y el otro no, preservar el hash de quien reseteó
    let claveHashFinal = baseGanadora.clave_hash;
    if (debeCambiarRemoto && !debeCambiarLocal) {
      claveHashFinal = remoto.clave_hash;
    } else if (debeCambiarLocal && !debeCambiarRemoto) {
      claveHashFinal = local.clave_hash;
    }

    const huboDiferenciaRestrictiva =
      rolLocal !== rolRemoto ||
      activoLocal !== activoRemoto ||
      debeCambiarLocal !== debeCambiarRemoto ||
      puedeMovilLocal !== puedeMovilRemoto;

    const fusionado: T = {
      ...baseGanadora,
      rol: rolMasRestrictivo,
      activo: activoFinal,
      debe_cambiar_clave: debeCambiarFinal,
      puede_vender_movil: puedeMovilFinal,
      clave_hash: claveHashFinal,
      deleted_at: local.deleted_at ?? remoto.deleted_at ?? null,
    };

    return {
      ganador: huboDiferenciaRestrictiva ? 'fusionado_restrictivo' : lww.ganador,
      registroResultante: fusionado,
      huboConflicto: true,
      reglaAplicada: huboDiferenciaRestrictiva
        ? 'usuarios_cambio_mas_restrictivo'
        : lww.regla,
      detalleAuditoria: `Conflicto concurrente en usuario ${local.id}: rol=${rolMasRestrictivo}, activo=${activoFinal}, debe_cambiar_clave=${debeCambiarFinal}.`,
    };
  }

  // 3. Resto de tablas maestras (productos, precios, clientes, proveedores, etc.):
  // Last-Write-Wins por updated_at; empate desempata por device_id menor (PLAN.md §5).
  const comp = compararLastWriteWins(local, remoto);
  const elegido = comp.ganador === 'remoto' ? remoto : local;

  return {
    ganador: comp.ganador,
    registroResultante: { ...elegido },
    huboConflicto: true,
    reglaAplicada: comp.regla,
    detalleAuditoria: `Conflicto LWW en ${tabla} (${local.id}): ganó ${comp.ganador} (regla=${comp.regla}, local.updated_at=${local.updated_at} [${local.device_id}] vs remoto.updated_at=${remoto.updated_at} [${remoto.device_id}]).`,
  };
}

/**
 * Determina si una imagen local de producto debe encolarse para subida a Supabase Storage
 * comparando su hash SHA-256 actual contra el último hash sincronizado (PLAN.md §5.1).
 */
export function debeSubirImagenProducto(params: {
  imagenPathLocal: string | null;
  imagenHashLocal: string | null;
  ultimoHashSincronizado: string | null;
}): boolean {
  if (!params.imagenPathLocal || !params.imagenHashLocal) {
    return false;
  }
  return params.imagenHashLocal !== params.ultimoHashSincronizado;
}

/**
 * Determina si un producto recibido por pull requiere descargar su imagen en segundo plano
 * desde Supabase Storage hacia la caché local imagenes/ (PLAN.md §5.1).
 */
export function debeBajarImagenProducto(params: {
  imagenPathRemoto: string | null;
  imagenHashRemoto: string | null;
  existeArchivoLocal: boolean;
  imagenHashLocal: string | null;
}): boolean {
  if (!params.imagenPathRemoto || !params.imagenHashRemoto) {
    return false;
  }
  if (!params.existeArchivoLocal) {
    return true;
  }
  return params.imagenHashRemoto !== params.imagenHashLocal;
}

export type EtiquetaEstadoSync =
  | 'Sincronizado'
  | `Pendiente (${number} cambios)`
  | 'Sin conexión'
  | 'Error (ver detalle)';

export interface ResumenEstadoSyncUI {
  etiqueta: EtiquetaEstadoSync;
  tipoBadge: 'ok' | 'pendiente' | 'offline' | 'error';
  totalPendientes: number;
  datosPendientes: number;
  imagenesPendientes: number;
  erroresCount: number;
  ultimoErrorDetalle: string | null;
  ultimaSubidaAt: string | null;
  ultimaBajadaAt: string | null;
}

/**
 * Construye el indicador de estado visible siempre en la interfaz (PLAN.md §5):
 * `Sincronizado` · `Pendiente (N cambios)` · `Sin conexión` · `Error (ver detalle)`.
 */
export function calcularIndicadorEstadoSync(params: {
  sinConexion: boolean;
  datosPendientes: number;
  imagenesPendientes: number;
  erroresCount: number;
  ultimoErrorDetalle?: string | null;
  ultimaSubidaAt?: string | null;
  ultimaBajadaAt?: string | null;
}): ResumenEstadoSyncUI {
  const datosPend = Math.max(0, Math.trunc(params.datosPendientes));
  const imgsPend = Math.max(0, Math.trunc(params.imagenesPendientes));
  const totalPendientes = datosPend + imgsPend;
  const errores = Math.max(0, Math.trunc(params.erroresCount));

  if (errores > 0) {
    return {
      etiqueta: 'Error (ver detalle)',
      tipoBadge: 'error',
      totalPendientes,
      datosPendientes: datosPend,
      imagenesPendientes: imgsPend,
      erroresCount: errores,
      ultimoErrorDetalle:
        params.ultimoErrorDetalle ?? 'Error en la cola de sincronización.',
      ultimaSubidaAt: params.ultimaSubidaAt ?? null,
      ultimaBajadaAt: params.ultimaBajadaAt ?? null,
    };
  }

  if (params.sinConexion) {
    return {
      etiqueta: 'Sin conexión',
      tipoBadge: 'offline',
      totalPendientes,
      datosPendientes: datosPend,
      imagenesPendientes: imgsPend,
      erroresCount: 0,
      ultimoErrorDetalle: null,
      ultimaSubidaAt: params.ultimaSubidaAt ?? null,
      ultimaBajadaAt: params.ultimaBajadaAt ?? null,
    };
  }

  if (totalPendientes > 0) {
    return {
      etiqueta: `Pendiente (${totalPendientes} cambios)`,
      tipoBadge: 'pendiente',
      totalPendientes,
      datosPendientes: datosPend,
      imagenesPendientes: imgsPend,
      erroresCount: 0,
      ultimoErrorDetalle: null,
      ultimaSubidaAt: params.ultimaSubidaAt ?? null,
      ultimaBajadaAt: params.ultimaBajadaAt ?? null,
    };
  }

  return {
    etiqueta: 'Sincronizado',
    tipoBadge: 'ok',
    totalPendientes: 0,
    datosPendientes: 0,
    imagenesPendientes: 0,
    erroresCount: 0,
    ultimoErrorDetalle: null,
    ultimaSubidaAt: params.ultimaSubidaAt ?? null,
    ultimaBajadaAt: params.ultimaBajadaAt ?? null,
  };
}

/**
 * Regla 8 (PLAN.md §3): Nunca pedir ni guardar claves de servicio de Supabase en el cliente.
 * Valida que la clave configurada sea únicamente una clave pública (anon / sb_publishable)
 * e inspecciona el payload si es un JWT para rechazar `role: "service_role"`.
 */
export function validarConfiguracionSupabaseCliente(
  supabaseUrl: string | null | undefined,
  supabaseAnonKey: string | null | undefined
): { valida: boolean; motivo?: string } {
  const url = (supabaseUrl ?? '').trim();
  const key = (supabaseAnonKey ?? '').trim();

  if (!url && !key) {
    return { valida: true }; // Modo 100% local sin nube configurada aún
  }

  if (!url || !key) {
    return {
      valida: false,
      motivo:
        'Para conectar con Supabase debés completar tanto la URL del proyecto como la clave pública (anon key).',
    };
  }

  if (!/^https:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(url)) {
    return {
      valida: false,
      motivo: 'La URL de Supabase debe comenzar con https://.',
    };
  }

  const keyLower = key.toLowerCase();
  if (
    keyLower.startsWith('sb_secret_') ||
    keyLower.includes('service_role') ||
    keyLower.includes('secret')
  ) {
    return {
      valida: false,
      motivo:
        'PROHIBIDO (Regla 8): No se permite ingresar claves secretas ni service_role en el cliente. Usá únicamente la clave pública (anon / publishable).',
    };
  }

  // Si es un JWT (header.payload.signature), decodificar el payload y verificar que role !== 'service_role'
  const partesJwt = key.split('.');
  if (partesJwt.length === 3 && partesJwt[1]) {
    try {
      const base64 = partesJwt[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload =
        typeof atob === 'function'
          ? atob(base64)
          : Buffer.from(base64, 'base64').toString('utf-8');
      const payload = JSON.parse(jsonPayload) as { role?: string };
      if (payload.role === 'service_role' || payload.role === 'supabase_admin') {
        return {
          valida: false,
          motivo:
            'PROHIBIDO (Regla 8): El token JWT proporcionado tiene rol service_role. Usá únicamente el token público con rol anon.',
        };
      }
    } catch {
      // Si no es JSON válido en base64, continuar
    }
  }

  return { valida: true };
}
