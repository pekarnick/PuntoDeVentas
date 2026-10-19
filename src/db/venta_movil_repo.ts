/**
 * Repositorio de Venta Móvil Web (/web-pos, PLAN.md §6.2 — Fase 3b):
 * - Configuración de Venta Móvil y generación de QR (Regla 19: solo URL pública).
 * - Gestión de sesiones móviles (login móvil, expiración por inactividad y revocación auditada).
 * - Catálogo proyectado desde vista_productos_venta (Regla 20: nunca incluye costo_compra).
 * - Función transaccional e idempotente crear_venta_movil con recálculo de precios en servidor.
 * - Caja móvil por vendedor y consulta de ventas propias del día.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  asegurarCentavos,
  calcularArqueoCaja,
  calcularVentaMovilDesdeCatalogo,
  formatearComprobanteMovilWhatsApp,
  generarQrSvgUrlPublica,
  normalizarMovimientoStock,
  proyectarProductoParaVenta,
  validarUrlPublicaVentaMovil,
  type AlicuotaIva,
  type Centavos,
  type ItemPedidoMovilInput,
  type MedioPago,
  type PagoVentaInput,
  type ProductoCatalogoMovil,
} from '@pos/domain';
import { exigirPermiso } from '../domain/permisos.ts';
import { autenticarUsuario } from './auth_caja_repo.ts';
import {
  calcularEstadoCuentaCorriente,
  validarCargoCuentaCorrienteCliente,
} from '../domain/gestion_fase3.ts';
import {
  ejecutarEnTransaccion,
  encolarSync,
  generarUuidV7,
  insertarAuditoriaEnTransaccion,
  type ActorContexto,
} from './repositorios.ts';

export interface SesionMovilResumen {
  readonly id: string;
  readonly usuario_id: string;
  readonly usuario_nombre: string;
  readonly usuario_login: string;
  readonly dispositivo_id: string;
  readonly dispositivo_nombre: string;
  readonly user_agent: string | null;
  readonly iniciada_at: string;
  readonly ultima_actividad_at: string;
  readonly expira_at: string;
  readonly estado: 'activa' | 'revocada' | 'expirada' | 'cerrada';
  readonly revocada_at: string | null;
  readonly motivo_revocacion: string | null;
}

export interface EstadoConfigVentaMovil {
  readonly comercio_id: string;
  readonly comercio_nombre: string;
  readonly venta_movil_habilitada: boolean;
  readonly venta_movil_url: string;
  readonly qr_svg: string;
  readonly sesiones: readonly SesionMovilResumen[];
  readonly usuarios_moviles: readonly {
    readonly id: string;
    readonly nombre: string;
    readonly usuario: string;
    readonly rol: string;
    readonly activo: boolean;
    readonly puede_vender_movil: boolean;
  }[];
}

/**
 * Obtiene la configuración actual de Venta Móvil, el código QR SVG (Regla 19) y las sesiones activas.
 */
export function obtenerConfigVentaMovil(
  db: DatabaseSync,
  comercioId: string
): EstadoConfigVentaMovil {
  const comercio = db
    .prepare(
      `SELECT id, nombre, venta_movil_habilitada
       FROM comercios
       WHERE id = ? AND deleted_at IS NULL`
    )
    .get(comercioId) as
    | { id: string; nombre: string; venta_movil_habilitada: number }
    | undefined;

  if (!comercio) {
    throw new Error('Comercio no encontrado.');
  }

  const configRow = db
    .prepare(
      `SELECT venta_movil_url
       FROM configuracion_sistema
       WHERE comercio_id = ?`
    )
    .get(comercioId) as { venta_movil_url: string } | undefined;

  const urlPublica =
    configRow?.venta_movil_url?.trim() || 'https://pos-movil.ejemplo.com/web-pos';

  // Expirar automáticamente sesiones vencidas antes de listar
  const ahoraIso = new Date().toISOString();
  db.prepare(
    `UPDATE sesiones_moviles
     SET estado = 'expirada', updated_at = ?
     WHERE comercio_id = ? AND estado = 'activa' AND expira_at <= ?`
  ).run(ahoraIso, comercioId, ahoraIso);

  const { svg, urlValidada } = generarQrSvgUrlPublica(urlPublica, 240);

  const sesionesRows = db
    .prepare(
      `SELECT
        s.id,
        s.usuario_id,
        u.nombre AS usuario_nombre,
        u.usuario AS usuario_login,
        s.dispositivo_id,
        s.dispositivo_nombre,
        s.user_agent,
        s.iniciada_at,
        s.ultima_actividad_at,
        s.expira_at,
        s.estado,
        s.revocada_at,
        s.motivo_revocacion
       FROM sesiones_moviles s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.comercio_id = ? AND s.deleted_at IS NULL
       ORDER BY
         CASE WHEN s.estado = 'activa' THEN 0 ELSE 1 END ASC,
         s.ultima_actividad_at DESC
       LIMIT 50`
    )
    .all(comercioId) as unknown as SesionMovilResumen[];

  const usuariosRows = db
    .prepare(
      `SELECT id, nombre, usuario, rol, activo, puede_vender_movil
       FROM usuarios
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    nombre: string;
    usuario: string;
    rol: string;
    activo: number;
    puede_vender_movil: number;
  }>;

  return {
    comercio_id: comercio.id,
    comercio_nombre: comercio.nombre,
    venta_movil_habilitada: comercio.venta_movil_habilitada === 1,
    venta_movil_url: urlValidada,
    qr_svg: svg,
    sesiones: sesionesRows,
    usuarios_moviles: usuariosRows.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      usuario: u.usuario,
      rol: u.rol,
      activo: u.activo === 1,
      puede_vender_movil: u.puede_vender_movil === 1,
    })),
  };
}

/**
 * Activa o desactiva la Venta Móvil y actualiza la URL pública del código QR (solo superadmin).
 * Cumple Regla 13 (auditoría obligatoria) y Regla 19 (URL pública sin claves ni tokens).
 */
export function configurarVentaMovilComercio(
  db: DatabaseSync,
  params: {
    actor: ActorContexto;
    habilitada: boolean;
    urlPublica: string;
  }
): EstadoConfigVentaMovil {
  exigirPermiso(params.actor, 'configurar_sistema');
  const urlValidada = validarUrlPublicaVentaMovil(params.urlPublica);

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const antes = db
      .prepare(
        `SELECT venta_movil_habilitada FROM comercios WHERE id = ? AND deleted_at IS NULL`
      )
      .get(params.actor.comercio_id) as { venta_movil_habilitada: number } | undefined;

    if (!antes) {
      throw new Error('Comercio no encontrado.');
    }

    const nuevoValor = params.habilitada ? 1 : 0;

    db.prepare(
      `UPDATE comercios
       SET venta_movil_habilitada = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
       WHERE id = ?`
    ).run(nuevoValor, ahora, params.actor.device_id, params.actor.comercio_id);

    const existeConfig = db
      .prepare('SELECT comercio_id FROM configuracion_sistema WHERE comercio_id = ?')
      .get(params.actor.comercio_id);

    if (existeConfig) {
      db.prepare(
        `UPDATE configuracion_sistema
         SET venta_movil_url = ?, updated_at = ?
         WHERE comercio_id = ?`
      ).run(urlValidada, ahora, params.actor.comercio_id);
    } else {
      db.prepare(
        `INSERT INTO configuracion_sistema (
          comercio_id, venta_movil_url, updated_at
        ) VALUES (?, ?, ?)`
      ).run(params.actor.comercio_id, urlValidada, ahora);
    }

    encolarSync(db, 'comercios', params.actor.comercio_id, 'update', ahora);

    insertarAuditoriaEnTransaccion(db, {
      actor: params.actor,
      accion: params.habilitada ? 'activar_venta_movil' : 'desactivar_venta_movil',
      entidad: 'comercios',
      entidad_id: params.actor.comercio_id,
      valores_antes: {
        venta_movil_habilitada: antes.venta_movil_habilitada === 1,
      },
      valores_despues: {
        venta_movil_habilitada: params.habilitada,
        venta_movil_url: urlValidada,
      },
      motivo: params.habilitada
        ? 'Habilitación de canal de Venta Móvil Web (/web-pos)'
        : 'Deshabilitación de canal de Venta Móvil Web (/web-pos)',
      fecha_hora: ahora,
    });
  });

  return obtenerConfigVentaMovil(db, params.actor.comercio_id);
}

/**
 * Habilita o revoca el permiso puede_vender_movil para un usuario específico (solo superadmin).
 */
export function actualizarPermisoVentaMovilUsuario(
  db: DatabaseSync,
  params: {
    actor: ActorContexto;
    usuarioObjetivoId: string;
    puedeVenderMovil: boolean;
  }
): void {
  exigirPermiso(params.actor, 'gestionar_usuarios');

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const actual = db
      .prepare(
        `SELECT id, nombre, usuario, puede_vender_movil
         FROM usuarios
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.usuarioObjetivoId, params.actor.comercio_id) as
      | { id: string; nombre: string; usuario: string; puede_vender_movil: number }
      | undefined;

    if (!actual) {
      throw new Error('Usuario no encontrado.');
    }

    const nuevoValor = params.puedeVenderMovil ? 1 : 0;
    db.prepare(
      `UPDATE usuarios
       SET puede_vender_movil = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      nuevoValor,
      ahora,
      params.actor.device_id,
      params.usuarioObjetivoId,
      params.actor.comercio_id
    );

    encolarSync(db, 'usuarios', params.usuarioObjetivoId, 'update', ahora);

    insertarAuditoriaEnTransaccion(db, {
      actor: params.actor,
      accion: 'cambiar_permiso_venta_movil',
      entidad: 'usuarios',
      entidad_id: params.usuarioObjetivoId,
      valores_antes: { puede_vender_movil: actual.puede_vender_movil === 1 },
      valores_despues: { puede_vender_movil: params.puedeVenderMovil },
      motivo: `Permiso de venta móvil ${
        params.puedeVenderMovil ? 'habilitado' : 'deshabilitado'
      } para ${actual.nombre}`,
      fecha_hora: ahora,
    });
  });
}

/**
 * Inicia una sesión de Venta Móvil verificando que el comercio tenga habilitada la venta móvil
 * y que el usuario tenga el permiso puede_vender_movil (PLAN.md §6.2).
 */
export async function iniciarSesionMovil(
  db: DatabaseSync,
  params: {
    comercioId: string;
    usuario: string;
    clave: string;
    dispositivoId: string;
    dispositivoNombre?: string;
    userAgent?: string;
    duracionMinutos?: number;
  }
): Promise<{
  sesion_id: string;
  expira_at: string;
  comercio_id: string;
  comercio_nombre: string;
  usuario: {
    id: string;
    nombre: string;
    usuario: string;
    rol: string;
  };
}> {
  const comercio = db
    .prepare(
      `SELECT id, nombre, venta_movil_habilitada
       FROM comercios
       WHERE id = ? AND deleted_at IS NULL`
    )
    .get(params.comercioId) as
    | { id: string; nombre: string; venta_movil_habilitada: number }
    | undefined;

  if (!comercio || comercio.venta_movil_habilitada !== 1) {
    throw new Error(
      'La Venta Móvil se encuentra deshabilitada en este comercio. Activála desde Configuración > Venta Móvil en la terminal principal.'
    );
  }

  const usuarioAutenticado = await autenticarUsuario(db, {
    comercioId: params.comercioId,
    usuario: params.usuario,
    clave: params.clave,
    deviceId: params.dispositivoId,
  });

  if (!usuarioAutenticado.puede_vender_movil) {
    throw new Error(
      `El usuario "${usuarioAutenticado.nombre}" no tiene habilitado el permiso de Venta Móvil.`
    );
  }

  const duracionMin = params.duracionMinutos ?? 120; // 2 horas por defecto
  const ahora = new Date();
  const ahoraIso = ahora.toISOString();
  const expiraIso = new Date(ahora.getTime() + duracionMin * 60_000).toISOString();
  const sesionId = generarUuidV7();
  const nombreDisp = params.dispositivoNombre?.trim() || 'Celular / Web POS';

  ejecutarEnTransaccion(db, () => {
    db.prepare(
      `INSERT INTO sesiones_moviles (
        id, comercio_id, usuario_id, dispositivo_id, dispositivo_nombre,
        user_agent, iniciada_at, ultima_actividad_at, expira_at, estado,
        created_at, updated_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?, 'pendiente')`
    ).run(
      sesionId,
      params.comercioId,
      usuarioAutenticado.id,
      params.dispositivoId,
      nombreDisp,
      params.userAgent ?? null,
      ahoraIso,
      ahoraIso,
      expiraIso,
      ahoraIso,
      ahoraIso,
      params.dispositivoId
    );

    encolarSync(db, 'sesiones_moviles', sesionId, 'insert', ahoraIso);

    insertarAuditoriaEnTransaccion(db, {
      actor: {
        comercio_id: params.comercioId,
        usuario_id: usuarioAutenticado.id,
        usuario_nombre: usuarioAutenticado.nombre,
        rol: usuarioAutenticado.rol,
        device_id: params.dispositivoId,
      },
      accion: 'login_movil_exitoso',
      entidad: 'sesiones_moviles',
      entidad_id: sesionId,
      valores_despues: {
        dispositivo_id: params.dispositivoId,
        dispositivo_nombre: nombreDisp,
        expira_at: expiraIso,
      },
      fecha_hora: ahoraIso,
    });
  });

  return {
    sesion_id: sesionId,
    expira_at: expiraIso,
    comercio_id: comercio.id,
    comercio_nombre: comercio.nombre,
    usuario: {
      id: usuarioAutenticado.id,
      nombre: usuarioAutenticado.nombre,
      usuario: usuarioAutenticado.usuario,
      rol: usuarioAutenticado.rol,
    },
  };
}

/**
 * Revoca una sesión móvil activa desde la terminal de escritorio (solo superadmin).
 * Queda registrado en auditoría (PLAN.md §6.1 y §6.2).
 */
export function revocarSesionMovil(
  db: DatabaseSync,
  params: {
    actor: ActorContexto;
    sesionId: string;
    motivo?: string;
  }
): void {
  exigirPermiso(params.actor, 'configurar_sistema');

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const sesion = db
      .prepare(
        `SELECT id, usuario_id, dispositivo_nombre, estado
         FROM sesiones_moviles
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.sesionId, params.actor.comercio_id) as
      | {
          id: string;
          usuario_id: string;
          dispositivo_nombre: string;
          estado: string;
        }
      | undefined;

    if (!sesion) {
      throw new Error('Sesión móvil no encontrada.');
    }

    const motivoFinal =
      params.motivo?.trim() || 'Sesión revocada manualmente por el administrador';

    db.prepare(
      `UPDATE sesiones_moviles
       SET estado = 'revocada',
           revocada_at = ?,
           revocada_por_id = ?,
           motivo_revocacion = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      ahora,
      params.actor.usuario_id,
      motivoFinal,
      ahora,
      params.actor.device_id,
      params.sesionId,
      params.actor.comercio_id
    );

    encolarSync(db, 'sesiones_moviles', params.sesionId, 'update', ahora);

    insertarAuditoriaEnTransaccion(db, {
      actor: params.actor,
      accion: 'revocar_sesion_movil',
      entidad: 'sesiones_moviles',
      entidad_id: params.sesionId,
      valores_antes: { estado: sesion.estado },
      valores_despues: {
        estado: 'revocada',
        revocada_at: ahora,
        dispositivo_nombre: sesion.dispositivo_nombre,
      },
      motivo: motivoFinal,
      fecha_hora: ahora,
    });
  });
}

/**
 * Valida que una sesión móvil esté activa, no haya sido revocada ni haya expirado por inactividad,
 * y renueva su ventana de actividad.
 */
export function validarYRenovarSesionMovil(
  db: DatabaseSync,
  params: {
    sesionId: string;
    comercioId: string;
    duracionMinutos?: number;
  }
): {
  usuario_id: string;
  usuario_nombre: string;
  rol: 'superadmin' | 'encargado' | 'cajero';
  dispositivo_id: string;
} {
  const fila = db
    .prepare(
      `SELECT
        s.id,
        s.usuario_id,
        s.dispositivo_id,
        s.expira_at,
        s.estado,
        s.motivo_revocacion,
        u.nombre AS usuario_nombre,
        u.rol,
        u.activo,
        u.puede_vender_movil,
        c.venta_movil_habilitada
       FROM sesiones_moviles s
       JOIN usuarios u ON u.id = s.usuario_id
       JOIN comercios c ON c.id = s.comercio_id
       WHERE s.id = ? AND s.comercio_id = ? AND s.deleted_at IS NULL`
    )
    .get(params.sesionId, params.comercioId) as
    | {
        id: string;
        usuario_id: string;
        dispositivo_id: string;
        expira_at: string;
        estado: string;
        motivo_revocacion: string | null;
        usuario_nombre: string;
        rol: 'superadmin' | 'encargado' | 'cajero';
        activo: number;
        puede_vender_movil: number;
        venta_movil_habilitada: number;
      }
    | undefined;

  if (!fila) {
    throw new Error('SESION_INVALIDA: La sesión móvil no existe.');
  }

  if (fila.venta_movil_habilitada !== 1) {
    throw new Error(
      'VENTA_MOVIL_DESHABILITADA: La Venta Móvil fue desactivada en este comercio.'
    );
  }

  if (fila.estado === 'revocada') {
    throw new Error(
      `SESION_REVOCADA: Tu sesión fue revocada desde la terminal central (${
        fila.motivo_revocacion ?? 'sin motivo especificado'
      }).`
    );
  }

  if (fila.estado !== 'activa') {
    throw new Error('SESION_CERRADA: Tu sesión móvil ya no está activa.');
  }

  const ahora = new Date();
  if (new Date(fila.expira_at).getTime() <= ahora.getTime()) {
    const ahoraIso = ahora.toISOString();
    db.prepare(
      `UPDATE sesiones_moviles SET estado = 'expirada', updated_at = ? WHERE id = ?`
    ).run(ahoraIso, fila.id);
    throw new Error(
      'SESION_EXPIRADA: Tu sesión móvil se cerró por inactividad. Volvé a iniciar sesión.'
    );
  }

  if (fila.activo !== 1 || fila.puede_vender_movil !== 1) {
    throw new Error(
      'PERMISO_REVOCADO: Tu usuario ya no tiene permisos para operar en Venta Móvil.'
    );
  }

  const duracionMin = params.duracionMinutos ?? 120;
  const ahoraIso = ahora.toISOString();
  const nuevaExpiracion = new Date(ahora.getTime() + duracionMin * 60_000).toISOString();

  db.prepare(
    `UPDATE sesiones_moviles
     SET ultima_actividad_at = ?, expira_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(ahoraIso, nuevaExpiracion, ahoraIso, fila.id);

  return {
    usuario_id: fila.usuario_id,
    usuario_nombre: fila.usuario_nombre,
    rol: fila.rol,
    dispositivo_id: fila.dispositivo_id,
  };
}

/**
 * Lee el catálogo de productos para la app móvil exclusivamente a través de vista_productos_venta.
 * Regla 20: NUNCA incluye costo_compra ni márgenes de ganancia.
 */
export function obtenerCatalogoVentaMovil(
  db: DatabaseSync,
  comercioId: string
): ProductoCatalogoMovil[] {
  const filas = db
    .prepare(
      `SELECT
        v.id,
        v.codigo_interno,
        v.nombre,
        v.unidad,
        v.permite_decimales,
        COALESCE(v.precio_venta, 0) AS precio_venta,
        v.alicuota_iva,
        v.exento_iva,
        v.boton_rapido,
        v.imagen_path,
        COALESCE(s.stock_actual, 0) AS stock_actual
       FROM vista_productos_venta v
       LEFT JOIN vista_stock_actual s
         ON s.producto_id = v.id AND s.comercio_id = v.comercio_id
       WHERE v.comercio_id = ? AND v.activo = 1
       ORDER BY v.nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    codigo_interno: string | null;
    nombre: string;
    unidad: 'unidad' | 'kg' | 'litro' | 'metro' | 'par';
    permite_decimales: number;
    precio_venta: number;
    alicuota_iva: AlicuotaIva;
    exento_iva: number;
    boton_rapido: number;
    imagen_path: string | null;
    stock_actual: number;
  }>;

  const codigosRows = db
    .prepare(
      `SELECT producto_id, codigo
       FROM codigos_barras
       WHERE comercio_id = ? AND deleted_at IS NULL`
    )
    .all(comercioId) as unknown as Array<{ producto_id: string; codigo: string }>;

  const codigosPorProducto = new Map<string, string[]>();
  for (const row of codigosRows) {
    const lista = codigosPorProducto.get(row.producto_id) ?? [];
    lista.push(row.codigo);
    codigosPorProducto.set(row.producto_id, lista);
  }

  return filas.map((f) => {
    const proyectado = proyectarProductoParaVenta({
      id: f.id,
      codigo_interno: f.codigo_interno,
      nombre: f.nombre,
      unidad: f.unidad,
      permite_decimales: f.permite_decimales === 1,
      precio_venta: f.precio_venta,
      alicuota_iva: f.alicuota_iva,
      exento_iva: f.exento_iva === 1,
      boton_rapido: f.boton_rapido === 1,
      imagen_path: f.imagen_path,
      codigos_barras: codigosPorProducto.get(f.id) ?? [],
      stock_actual: f.stock_actual,
    });
    return proyectado;
  });
}

export interface ResultadoCrearVentaMovil {
  readonly idempotente: boolean;
  readonly venta_id: string;
  readonly fecha: string;
  readonly canal: 'web';
  readonly subtotal: Centavos;
  readonly descuento: Centavos;
  readonly total: Centavos;
  readonly items: readonly {
    readonly producto_id: string;
    readonly descripcion: string;
    readonly cantidad: number;
    readonly precio_unitario: Centavos;
    readonly descuento: Centavos;
    readonly subtotal: Centavos;
  }[];
  readonly pagos: readonly PagoVentaInput[];
  readonly comprobante_texto: string;
  readonly whatsapp_url: string;
}

/**
 * Implementación en el servidor de la función RPC `crear_venta_movil` (PLAN.md §6.2):
 * - Verifica que la venta móvil esté activa en el comercio y que el usuario tenga `puede_vender_movil`.
 * - Garantiza idempotencia por `ventaId` UUID generado en el celular.
 * - Ignora cualquier precio enviado por el cliente y recalcula desde `precios` en el servidor.
 * - Inserta venta (`canal = 'web'`), ítems, pagos, movimientos de stock, caja y auditoría en una sola transacción.
 * - Devuelve el comprobante sin exponer jamás `costo_compra` ni `costo_unitario` (Regla 20).
 */
export function crearVentaMovilServidor(
  db: DatabaseSync,
  params: {
    ventaId: string;
    comercioId: string;
    usuarioId: string;
    dispositivoId: string;
    sesionMovilId?: string;
    items: readonly ItemPedidoMovilInput[];
    pagos: readonly PagoVentaInput[];
    descuentoGlobal?: Centavos;
    clienteId?: string | null;
    cajaSesionId?: string | null;
  }
): ResultadoCrearVentaMovil {
  if (!params.ventaId || params.ventaId.trim().length < 10) {
    throw new Error('UUID de venta móvil inválido.');
  }

  return ejecutarEnTransaccion(db, () => {
    // 1. Verificar sesión móvil si fue provista
    if (params.sesionMovilId) {
      validarYRenovarSesionMovil(db, {
        sesionId: params.sesionMovilId,
        comercioId: params.comercioId,
      });
    }

    // 2. Verificar comercio
    const comercio = db
      .prepare(
        `SELECT id, nombre, cuit, domicilio, venta_movil_habilitada, precios_incluyen_iva
         FROM comercios
         WHERE id = ? AND deleted_at IS NULL`
      )
      .get(params.comercioId) as
      | {
          id: string;
          nombre: string;
          cuit: string | null;
          domicilio: string | null;
          venta_movil_habilitada: number;
          precios_incluyen_iva: number;
        }
      | undefined;

    if (!comercio || comercio.venta_movil_habilitada !== 1) {
      throw new Error(
        'VENTA_MOVIL_DESHABILITADA: La Venta Móvil no está habilitada en este comercio.'
      );
    }

    // 3. Verificar usuario y permiso puede_vender_movil
    const usuario = db
      .prepare(
        `SELECT id, nombre, rol, activo, puede_vender_movil
         FROM usuarios
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.usuarioId, params.comercioId) as
      | {
          id: string;
          nombre: string;
          rol: 'superadmin' | 'encargado' | 'cajero';
          activo: number;
          puede_vender_movil: number;
        }
      | undefined;

    if (!usuario || usuario.activo !== 1 || usuario.puede_vender_movil !== 1) {
      throw new Error(
        'PERMISO_DENEGADO: El usuario no tiene permiso activo para vender desde el celular.'
      );
    }

    // 4. Idempotencia por UUID de venta generado en el celular (PLAN.md §6.2)
    const ventaExistente = db
      .prepare(
        `SELECT id, fecha, subtotal, descuento, total, cliente_id
         FROM ventas
         WHERE id = ? AND comercio_id = ?`
      )
      .get(params.ventaId, params.comercioId) as
      | {
          id: string;
          fecha: string;
          subtotal: Centavos;
          descuento: Centavos;
          total: Centavos;
          cliente_id: string | null;
        }
      | undefined;

    if (ventaExistente) {
      const itemsExistentes = db
        .prepare(
          `SELECT producto_id, descripcion, cantidad, precio_unitario, descuento, subtotal
           FROM ventas_items
           WHERE venta_id = ? AND comercio_id = ?`
        )
        .all(params.ventaId, params.comercioId) as unknown as Array<{
        producto_id: string;
        descripcion: string;
        cantidad: number;
        precio_unitario: Centavos;
        descuento: Centavos;
        subtotal: Centavos;
      }>;

      const pagosExistentes = db
        .prepare(
          `SELECT medio, monto
           FROM ventas_pagos
           WHERE venta_id = ? AND comercio_id = ?`
        )
        .all(params.ventaId, params.comercioId) as unknown as PagoVentaInput[];

      const comp = formatearComprobanteMovilWhatsApp({
        venta_id: ventaExistente.id,
        fecha_iso: ventaExistente.fecha,
        comercio_nombre: comercio.nombre,
        comercio_cuit: comercio.cuit,
        comercio_domicilio: comercio.domicilio,
        vendedor_nombre: usuario.nombre,
        items: itemsExistentes,
        subtotal: ventaExistente.subtotal,
        descuento: ventaExistente.descuento,
        total: ventaExistente.total,
        pagos: pagosExistentes,
      });

      return {
        idempotente: true,
        venta_id: ventaExistente.id,
        fecha: ventaExistente.fecha,
        canal: 'web',
        subtotal: ventaExistente.subtotal,
        descuento: ventaExistente.descuento,
        total: ventaExistente.total,
        items: itemsExistentes,
        pagos: pagosExistentes,
        comprobante_texto: comp.textoPlano,
        whatsapp_url: comp.urlWhatsApp,
      };
    }

    // 5. Cargar precios oficiales en el servidor y recalcular totales con el paquete compartido @pos/domain
    const catalogoLista = obtenerCatalogoVentaMovil(db, params.comercioId);
    const catalogoMapa = new Map<string, ProductoCatalogoMovil>(
      catalogoLista.map((p) => [p.id, p])
    );

    const resumenCalculado = calcularVentaMovilDesdeCatalogo({
      itemsPedido: params.items,
      catalogoPorId: catalogoMapa,
      descuentoGlobal: params.descuentoGlobal ?? 0,
      preciosIncluyenIva: comercio.precios_incluyen_iva === 1,
      pagos: params.pagos,
    });

    // 6. Verificar cliente y límite de crédito si hay pago en cuenta_corriente
    let clienteDatos: { nombre: string; cuit_dni: string | null; limite_credito: Centavos } | null =
      null;
    if (params.clienteId) {
      const cli = db
        .prepare(
          `SELECT nombre, cuit_dni, limite_credito
           FROM clientes
           WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
        )
        .get(params.clienteId, params.comercioId) as
        | { nombre: string; cuit_dni: string | null; limite_credito: Centavos }
        | undefined;
      if (!cli) {
        throw new Error('El cliente seleccionado no existe.');
      }
      clienteDatos = cli;
    }

    const montoCtaCte = params.pagos
      .filter((p) => p.medio === 'cuenta_corriente')
      .reduce((acc, p) => acc + p.monto, 0);

    if (montoCtaCte > 0) {
      if (!params.clienteId || !clienteDatos) {
        throw new Error(
          'Para cobrar en Cuenta Corriente desde el celular es obligatorio seleccionar un cliente.'
        );
      }
      const movsPrevios = db
        .prepare(
          `SELECT tipo, monto, deleted_at
           FROM cuenta_corriente_movimientos
           WHERE comercio_id = ? AND entidad_tipo = 'cliente' AND entidad_id = ? AND deleted_at IS NULL`
        )
        .all(params.comercioId, params.clienteId) as unknown as Array<{
        tipo: 'cargo' | 'pago';
        monto: Centavos;
        deleted_at: string | null;
      }>;
      const estadoCc = calcularEstadoCuentaCorriente(
        movsPrevios,
        clienteDatos.limite_credito
      );
      const validacionCc = validarCargoCuentaCorrienteCliente({
        saldoActualCentavos: estadoCc.saldoActualCentavos,
        limiteCreditoCentavos: clienteDatos.limite_credito,
        nuevoCargoCentavos: montoCtaCte,
      });
      if (!validacionCc.permitido) {
        throw new Error(validacionCc.motivoRechazo ?? 'Límite de crédito excedido.');
      }
    }

    const ahora = new Date().toISOString();

    // 7. Insertar cabecera de venta (canal = 'web')
    db.prepare(
      `INSERT INTO ventas (
        id, comercio_id, fecha, usuario_id, cliente_id,
        subtotal, descuento, total, estado, caja_sesion_id,
        tipo_comprobante, canal, dispositivo_id, estado_facturacion,
        created_at, updated_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completada', ?, 'ticket_no_fiscal', 'web', ?, 'no_aplica', ?, ?, ?, 'pendiente')`
    ).run(
      params.ventaId,
      params.comercioId,
      ahora,
      params.usuarioId,
      params.clienteId ?? null,
      resumenCalculado.subtotal,
      resumenCalculado.descuento_global,
      resumenCalculado.total,
      params.cajaSesionId ?? null,
      params.dispositivoId,
      ahora,
      ahora,
      params.dispositivoId
    );
    encolarSync(db, 'ventas', params.ventaId, 'insert', ahora);

    // 8. Insertar ítems (copiando costo_compra internamente en la BD sin exponerlo en la respuesta) y movimientos de stock
    const stmtCostoInterno = db.prepare(
      `SELECT costo_compra FROM productos WHERE id = ? AND comercio_id = ?`
    );
    const stmtInsertItem = db.prepare(
      `INSERT INTO ventas_items (
        id, comercio_id, venta_id, producto_id, descripcion,
        cantidad, precio_unitario, costo_unitario, descuento, subtotal,
        alicuota_iva, exento_iva, created_at, updated_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`
    );
    const stmtInsertMovStock = db.prepare(
      `INSERT INTO movimientos_stock (
        id, comercio_id, producto_id, tipo, cantidad,
        referencia_tipo, referencia_id, motivo, usuario_id,
        created_at, updated_at, device_id, sync_status
      ) VALUES (?, ?, ?, 'venta', ?, 'venta_movil', ?, 'Venta móvil web', ?, ?, ?, ?, 'pendiente')`
    );

    for (const item of resumenCalculado.items) {
      const rowCosto = stmtCostoInterno.get(item.producto_id, params.comercioId) as
        | { costo_compra: Centavos }
        | undefined;
      const costoUnitarioInterno = rowCosto?.costo_compra ?? 0;

      const itemId = generarUuidV7();
      stmtInsertItem.run(
        itemId,
        params.comercioId,
        params.ventaId,
        item.producto_id,
        item.descripcion,
        item.cantidad,
        item.precio_unitario,
        costoUnitarioInterno,
        item.descuento,
        item.subtotal,
        item.alicuota_iva,
        item.exento_iva ? 1 : 0,
        ahora,
        ahora,
        params.dispositivoId
      );
      encolarSync(db, 'ventas_items', itemId, 'insert', ahora);

      const movStockId = generarUuidV7();
      const cantidadNegativa = normalizarMovimientoStock({
        tipo: 'venta',
        cantidad: item.cantidad,
      });
      stmtInsertMovStock.run(
        movStockId,
        params.comercioId,
        item.producto_id,
        cantidadNegativa,
        params.ventaId,
        params.usuarioId,
        ahora,
        ahora,
        params.dispositivoId
      );
      encolarSync(db, 'movimientos_stock', movStockId, 'insert', ahora);
    }

    // 9. Insertar pagos y cuenta corriente si aplica
    const stmtInsertPago = db.prepare(
      `INSERT INTO ventas_pagos (
        id, comercio_id, venta_id, medio, monto,
        created_at, updated_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`
    );

    for (const pago of params.pagos) {
      const pagoId = generarUuidV7();
      stmtInsertPago.run(
        pagoId,
        params.comercioId,
        params.ventaId,
        pago.medio,
        pago.monto,
        ahora,
        ahora,
        params.dispositivoId
      );
      encolarSync(db, 'ventas_pagos', pagoId, 'insert', ahora);

      if (pago.medio === 'cuenta_corriente' && params.clienteId) {
        const movCcId = generarUuidV7();
        db.prepare(
          `INSERT INTO cuenta_corriente_movimientos (
            id, comercio_id, entidad_tipo, entidad_id, tipo, monto,
            referencia_id, observaciones, usuario_id,
            created_at, updated_at, device_id, sync_status
          ) VALUES (?, ?, 'cliente', ?, 'cargo', ?, ?, ?, ?, ?, ?, ?, 'pendiente')`
        ).run(
          movCcId,
          params.comercioId,
          params.clienteId,
          pago.monto,
          params.ventaId,
          `Cargo por venta móvil #${params.ventaId.slice(-8)}`,
          params.usuarioId,
          ahora,
          ahora,
          params.dispositivoId
        );
        encolarSync(db, 'cuenta_corriente_movimientos', movCcId, 'insert', ahora);
      }
    }

    // 10. Auditoría obligatoria en la misma transacción (Regla 13)
    insertarAuditoriaEnTransaccion(db, {
      actor: {
        comercio_id: params.comercioId,
        usuario_id: usuario.id,
        usuario_nombre: usuario.nombre,
        rol: usuario.rol,
        device_id: params.dispositivoId,
      },
      accion: 'crear_venta_movil',
      entidad: 'ventas',
      entidad_id: params.ventaId,
      valores_despues: {
        canal: 'web',
        subtotal: resumenCalculado.subtotal,
        descuento: resumenCalculado.descuento_global,
        total: resumenCalculado.total,
        cantidad_items: resumenCalculado.items.length,
        pagos: params.pagos,
      },
      motivo: 'Venta registrada desde aplicación móvil /web-pos',
      fecha_hora: ahora,
    });

    const itemsRespuesta = resumenCalculado.items.map((it) => ({
      producto_id: it.producto_id,
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precio_unitario: it.precio_unitario,
      descuento: it.descuento,
      subtotal: it.subtotal,
    }));

    const comp = formatearComprobanteMovilWhatsApp({
      venta_id: params.ventaId,
      fecha_iso: ahora,
      comercio_nombre: comercio.nombre,
      comercio_cuit: comercio.cuit,
      comercio_domicilio: comercio.domicilio,
      vendedor_nombre: usuario.nombre,
      cliente_nombre: clienteDatos?.nombre ?? null,
      cliente_cuit_dni: clienteDatos?.cuit_dni ?? null,
      items: itemsRespuesta,
      subtotal: resumenCalculado.subtotal,
      descuento: resumenCalculado.descuento_global,
      total: resumenCalculado.total,
      pagos: params.pagos,
    });

    return {
      idempotente: false,
      venta_id: params.ventaId,
      fecha: ahora,
      canal: 'web',
      subtotal: resumenCalculado.subtotal,
      descuento: resumenCalculado.descuento_global,
      total: resumenCalculado.total,
      items: itemsRespuesta,
      pagos: params.pagos,
      comprobante_texto: comp.textoPlano,
      whatsapp_url: comp.urlWhatsApp,
    };
  });
}

// ============================================================================
// Caja Móvil y Ventas propias del día del vendedor móvil (PLAN.md §6.2)
// ============================================================================

export interface EstadoCajaMovil {
  readonly sesion: {
    readonly id: string;
    readonly usuario_id: string;
    readonly fecha_apertura: string;
    readonly monto_inicial: Centavos;
    readonly estado: 'abierta' | 'cerrada';
    readonly observaciones: string | null;
  } | null;
  readonly totales_por_medio: Record<MedioPago, Centavos>;
  readonly efectivo_esperado: Centavos;
  readonly cantidad_ventas: number;
}

export function obtenerEstadoCajaMovilUsuario(
  db: DatabaseSync,
  comercioId: string,
  usuarioId: string
): EstadoCajaMovil {
  const sesion = db
    .prepare(
      `SELECT id, usuario_id, fecha_apertura, monto_inicial, estado, observaciones
       FROM caja_sesiones
       WHERE comercio_id = ? AND usuario_id = ? AND estado = 'abierta' AND deleted_at IS NULL
       ORDER BY fecha_apertura DESC
       LIMIT 1`
    )
    .get(comercioId, usuarioId) as
    | {
        id: string;
        usuario_id: string;
        fecha_apertura: string;
        monto_inicial: Centavos;
        estado: 'abierta' | 'cerrada';
        observaciones: string | null;
      }
    | undefined;

  if (!sesion) {
    return {
      sesion: null,
      totales_por_medio: {
        efectivo: 0,
        transferencia: 0,
        mercado_pago: 0,
        qr: 0,
        debito: 0,
        credito: 0,
        cuenta_corriente: 0,
        otro: 0,
      },
      efectivo_esperado: 0,
      cantidad_ventas: 0,
    };
  }

  const pagos = db
    .prepare(
      `SELECT vp.medio, vp.monto
       FROM ventas_pagos vp
       JOIN ventas v ON v.id = vp.venta_id
       WHERE v.comercio_id = ?
         AND v.caja_sesion_id = ?
         AND v.estado = 'completada'
         AND v.deleted_at IS NULL`
    )
    .all(comercioId, sesion.id) as unknown as PagoVentaInput[];

  const cantRow = db
    .prepare(
      `SELECT COUNT(*) AS cantidad
       FROM ventas
       WHERE comercio_id = ? AND caja_sesion_id = ? AND estado = 'completada' AND deleted_at IS NULL`
    )
    .get(comercioId, sesion.id) as { cantidad: number };

  const arqueo = calcularArqueoCaja({
    montoInicial: sesion.monto_inicial,
    pagosVentasCompletadas: pagos,
    movimientosManuales: [],
    efectivoContado: sesion.monto_inicial,
  });

  return {
    sesion,
    totales_por_medio: arqueo.totalesPorMedio,
    efectivo_esperado: arqueo.efectivoEsperado,
    cantidad_ventas: cantRow.cantidad,
  };
}

export function abrirCajaMovilUsuario(
  db: DatabaseSync,
  params: {
    comercioId: string;
    usuarioId: string;
    dispositivoId: string;
    montoInicialCentavos: Centavos;
    observaciones?: string;
  }
): EstadoCajaMovil {
  asegurarCentavos(params.montoInicialCentavos, 'montoInicialCentavos');
  if (params.montoInicialCentavos < 0) {
    throw new Error('El monto inicial de la caja móvil no puede ser negativo.');
  }

  const abierta = obtenerEstadoCajaMovilUsuario(
    db,
    params.comercioId,
    params.usuarioId
  );
  if (abierta.sesion) {
    return abierta;
  }

  ejecutarEnTransaccion(db, () => {
    const usuario = db
      .prepare(
        `SELECT id, nombre, rol FROM usuarios WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.usuarioId, params.comercioId) as
      | { id: string; nombre: string; rol: 'superadmin' | 'encargado' | 'cajero' }
      | undefined;

    if (!usuario) {
      throw new Error('Usuario no encontrado.');
    }

    const ahora = new Date().toISOString();
    const cajaId = generarUuidV7();
    const obs = params.observaciones?.trim() || 'Caja móvil (/web-pos)';

    db.prepare(
      `INSERT INTO caja_sesiones (
        id, comercio_id, usuario_id, fecha_apertura, monto_inicial,
        estado, observaciones, created_at, updated_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, 'abierta', ?, ?, ?, ?, 'pendiente')`
    ).run(
      cajaId,
      params.comercioId,
      params.usuarioId,
      ahora,
      params.montoInicialCentavos,
      obs,
      ahora,
      ahora,
      params.dispositivoId
    );

    encolarSync(db, 'caja_sesiones', cajaId, 'insert', ahora);

    insertarAuditoriaEnTransaccion(db, {
      actor: {
        comercio_id: params.comercioId,
        usuario_id: usuario.id,
        usuario_nombre: usuario.nombre,
        rol: usuario.rol,
        device_id: params.dispositivoId,
      },
      accion: 'abrir_caja_movil',
      entidad: 'caja_sesiones',
      entidad_id: cajaId,
      valores_despues: {
        monto_inicial: params.montoInicialCentavos,
        canal: 'web',
      },
      motivo: obs,
      fecha_hora: ahora,
    });
  });

  return obtenerEstadoCajaMovilUsuario(db, params.comercioId, params.usuarioId);
}

export function cerrarCajaMovilUsuario(
  db: DatabaseSync,
  params: {
    comercioId: string;
    usuarioId: string;
    dispositivoId: string;
    efectivoContadoCentavos: Centavos;
    observaciones?: string;
  }
): {
  caja_sesion_id: string;
  efectivo_esperado: Centavos;
  efectivo_contado: Centavos;
  diferencia: Centavos;
  totales_por_medio: Record<MedioPago, Centavos>;
} {
  asegurarCentavos(params.efectivoContadoCentavos, 'efectivoContadoCentavos');
  const estadoActual = obtenerEstadoCajaMovilUsuario(
    db,
    params.comercioId,
    params.usuarioId
  );

  if (!estadoActual.sesion) {
    throw new Error('No tenés una caja móvil abierta.');
  }

  const sesion = estadoActual.sesion;
  const diferencia =
    params.efectivoContadoCentavos - estadoActual.efectivo_esperado;

  ejecutarEnTransaccion(db, () => {
    const usuario = db
      .prepare(
        `SELECT id, nombre, rol FROM usuarios WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.usuarioId, params.comercioId) as
      | { id: string; nombre: string; rol: 'superadmin' | 'encargado' | 'cajero' }
      | undefined;

    if (!usuario) {
      throw new Error('Usuario no encontrado.');
    }

    const ahora = new Date().toISOString();
    db.prepare(
      `UPDATE caja_sesiones
       SET fecha_cierre = ?,
           usuario_cierre_id = ?,
           efectivo_esperado = ?,
           efectivo_contado = ?,
           diferencia = ?,
           estado = 'cerrada',
           observaciones = COALESCE(?, observaciones),
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      ahora,
      params.usuarioId,
      estadoActual.efectivo_esperado,
      params.efectivoContadoCentavos,
      diferencia,
      params.observaciones?.trim() || null,
      ahora,
      params.dispositivoId,
      sesion.id,
      params.comercioId
    );

    encolarSync(db, 'caja_sesiones', sesion.id, 'update', ahora);

    insertarAuditoriaEnTransaccion(db, {
      actor: {
        comercio_id: params.comercioId,
        usuario_id: usuario.id,
        usuario_nombre: usuario.nombre,
        rol: usuario.rol,
        device_id: params.dispositivoId,
      },
      accion: 'cerrar_caja_movil',
      entidad: 'caja_sesiones',
      entidad_id: sesion.id,
      valores_antes: { estado: 'abierta' },
      valores_despues: {
        estado: 'cerrada',
        efectivo_esperado: estadoActual.efectivo_esperado,
        efectivo_contado: params.efectivoContadoCentavos,
        diferencia,
      },
      motivo: params.observaciones?.trim() || 'Cierre de caja móvil desde /web-pos',
      fecha_hora: ahora,
    });
  });

  return {
    caja_sesion_id: sesion.id,
    efectivo_esperado: estadoActual.efectivo_esperado,
    efectivo_contado: params.efectivoContadoCentavos,
    diferencia,
    totales_por_medio: estadoActual.totales_por_medio,
  };
}

/**
 * Lista las ventas propias del día emitidas por el vendedor móvil (sin costos, Regla 20).
 */
export function listarVentasPropiasDelDiaMovil(
  db: DatabaseSync,
  comercioId: string,
  usuarioId: string
): Array<{
  id: string;
  fecha: string;
  total: Centavos;
  canal: 'escritorio' | 'web';
  estado: 'completada' | 'anulada';
  cliente_nombre: string | null;
  items: Array<{
    descripcion: string;
    cantidad: number;
    precio_unitario: Centavos;
    subtotal: Centavos;
  }>;
  pagos: Array<{
    medio: MedioPago;
    monto: Centavos;
  }>;
}> {
  const hoyPrefijo = new Date().toISOString().slice(0, 10);
  const ventasRows = db
    .prepare(
      `SELECT
        v.id,
        v.fecha,
        v.total,
        v.canal,
        v.estado,
        c.nombre AS cliente_nombre
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.comercio_id = ?
         AND v.usuario_id = ?
         AND v.fecha >= ?
         AND v.deleted_at IS NULL
       ORDER BY v.fecha DESC
       LIMIT 100`
    )
    .all(comercioId, usuarioId, `${hoyPrefijo}T00:00:00.000Z`) as unknown as Array<{
    id: string;
    fecha: string;
    total: Centavos;
    canal: 'escritorio' | 'web';
    estado: 'completada' | 'anulada';
    cliente_nombre: string | null;
  }>;

  const stmtItems = db.prepare(
    `SELECT descripcion, cantidad, precio_unitario, subtotal
     FROM ventas_items
     WHERE venta_id = ? AND comercio_id = ?`
  );
  const stmtPagos = db.prepare(
    `SELECT medio, monto
     FROM ventas_pagos
     WHERE venta_id = ? AND comercio_id = ?`
  );

  return ventasRows.map((v) => ({
    ...v,
    items: stmtItems.all(v.id, comercioId) as unknown as Array<{
      descripcion: string;
      cantidad: number;
      precio_unitario: Centavos;
      subtotal: Centavos;
    }>,
    pagos: stmtPagos.all(v.id, comercioId) as unknown as Array<{
      medio: MedioPago;
      monto: Centavos;
    }>,
  }));
}
