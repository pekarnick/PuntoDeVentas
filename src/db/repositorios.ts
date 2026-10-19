/**
 * Repositorios transaccionales SQLite con auditoría encadenada obligatoria y cola de sincronización.
 * Cumple Reglas 1, 2, 3, 4, 5, 6, 11, 13, 14, 15, 16 y 20 de PLAN.md.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  HASH_GENESIS_AUDITORIA,
  calcularHashAuditoria,
  sanitizarValoresAuditoria,
  verificarCadenaAuditoria,
  type DatosContenidoAuditoria,
  type RegistroAuditoriaCompleto,
  type ResultadoVerificacionAuditoria,
} from '../domain/auditoria.ts';
import {
  exigirPermiso,
  puedeAutorizarAnulacion,
  puedeVerCostos,
  requiereAutorizacionParaAnular,
  type RolUsuario,
} from '../domain/permisos.ts';
import {
  calcularStockActual,
  normalizarMovimientoStock,
  type TipoMovimientoStock,
} from '../domain/stock.ts';
import {
  calcularTotalesVenta,
  proyectarProductoParaVenta,
  validarPagosVenta,
  type AlicuotaIva,
  type ItemVentaInput,
  type PagoVentaInput,
} from '../domain/totales.ts';
import { asegurarCentavos, type Centavos } from '../domain/dinero.ts';
import { generarUuidV7 } from '../domain/uuid.ts';

export interface ActorContexto {
  readonly comercio_id: string;
  readonly usuario_id: string;
  readonly usuario_nombre: string;
  readonly rol: RolUsuario;
  readonly device_id: string;
}

export interface AutorizadorContexto {
  readonly usuario_id: string;
  readonly usuario_nombre: string;
  readonly rol: RolUsuario;
}

/**
 * Encola un cambio en sync_cola dentro de la transacción activa.
 */
function encolarSync(
  db: DatabaseSync,
  tabla: string,
  registroId: string,
  operacion: 'insert' | 'update' | 'delete_logico',
  timestamp: string
): void {
  db.prepare(
    `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
     VALUES (?, ?, ?, ?, ?, 'pendiente', 0)`
  ).run(generarUuidV7(), tabla, registroId, operacion, timestamp);
}

/**
 * Inserta un registro en la tabla auditoria encadenando su hash SHA-256 con el registro anterior.
 * Debe invocarse siempre dentro de una transacción abierta (Regla 13).
 */
export function insertarRegistroAuditoria(
  db: DatabaseSync,
  params: {
    actor: ActorContexto;
    accion: string;
    entidad: string;
    entidad_id: string | null;
    valores_antes?: Record<string, unknown> | null;
    valores_despues?: Record<string, unknown> | null;
    motivo?: string | null;
    autorizador?: AutorizadorContexto | null;
    ahoraIso?: string;
  }
): RegistroAuditoriaCompleto {
  const ahora = params.ahoraIso ?? new Date().toISOString();
  const id = generarUuidV7();

  const ultimoRow = db
    .prepare(
      `SELECT hash FROM auditoria
       WHERE comercio_id = ?
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get(params.actor.comercio_id) as { hash: string } | undefined;

  const hashPrev = ultimoRow?.hash ?? HASH_GENESIS_AUDITORIA;

  const datosContenido: DatosContenidoAuditoria = {
    id,
    comercio_id: params.actor.comercio_id,
    fecha_hora: ahora,
    usuario_id: params.actor.usuario_id,
    usuario_nombre: params.actor.usuario_nombre,
    rol: params.actor.rol,
    device_id: params.actor.device_id,
    accion: params.accion,
    entidad: params.entidad,
    entidad_id: params.entidad_id,
    valores_antes: sanitizarValoresAuditoria(params.valores_antes),
    valores_despues: sanitizarValoresAuditoria(params.valores_despues),
    motivo: params.motivo ?? null,
    autorizado_por_id: params.autorizador?.usuario_id ?? null,
    autorizado_por_nombre: params.autorizador?.usuario_nombre ?? null,
  };

  const hash = calcularHashAuditoria(datosContenido, hashPrev);

  db.prepare(
    `INSERT INTO auditoria (
      id, comercio_id, fecha_hora, usuario_id, usuario_nombre, rol, device_id,
      accion, entidad, entidad_id, valores_antes, valores_despues, motivo,
      autorizado_por_id, autorizado_por_nombre, hash_prev, hash,
      created_at, updated_at, deleted_at, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pendiente')`
  ).run(
    datosContenido.id,
    datosContenido.comercio_id,
    datosContenido.fecha_hora,
    datosContenido.usuario_id,
    datosContenido.usuario_nombre,
    datosContenido.rol,
    datosContenido.device_id,
    datosContenido.accion,
    datosContenido.entidad,
    datosContenido.entidad_id,
    datosContenido.valores_antes,
    datosContenido.valores_despues,
    datosContenido.motivo,
    datosContenido.autorizado_por_id ?? null,
    datosContenido.autorizado_por_nombre ?? null,
    hashPrev,
    hash,
    ahora,
    ahora
  );

  encolarSync(db, 'auditoria', id, 'insert', ahora);

  return {
    ...datosContenido,
    hash_prev: hashPrev,
    hash,
  };
}

/**
 * Ejecuta una operación de base de datos en una transacción atómica garantizando la escritura en auditoría.
 * Si cualquier paso (o la auditoría) falla, se hace ROLLBACK completo (Regla 13).
 */
export function ejecutarEnTransaccion<T>(
  db: DatabaseSync,
  fn: () => T
): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const resultado = fn();
    db.exec('COMMIT;');
    return resultado;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

/**
 * Crea un comercio y su primer usuario superadmin inicial en una transacción auditada.
 */
export function inicializarComercioYSuperadmin(
  db: DatabaseSync,
  params: {
    nombreComercio: string;
    cuit?: string;
    condicionIva?: 'monotributo' | 'responsable_inscripto' | 'exento';
    nombreAdmin: string;
    usuarioAdmin: string;
    claveHashAdmin: string;
    deviceId: string;
  }
): { comercioId: string; superadminId: string; listaPrecioId: string } {
  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const comercioId = generarUuidV7();
    const superadminId = generarUuidV7();
    const listaPrecioId = generarUuidV7();

    db.prepare(
      `INSERT INTO comercios (
        id, comercio_id, nombre, cuit, condicion_iva, moneda,
        venta_movil_habilitada, arca_habilitada,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, 'ARS', 0, 0, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      comercioId,
      comercioId,
      params.nombreComercio,
      params.cuit ?? null,
      params.condicionIva ?? 'monotributo',
      ahora,
      ahora,
      params.deviceId
    );
    encolarSync(db, 'comercios', comercioId, 'insert', ahora);

    db.prepare(
      `INSERT INTO usuarios (
        id, comercio_id, nombre, usuario, clave_hash, rol,
        puede_vender_movil, activo, debe_cambiar_clave,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, 'superadmin', 1, 1, 0, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      superadminId,
      comercioId,
      params.nombreAdmin,
      params.usuarioAdmin,
      params.claveHashAdmin,
      ahora,
      ahora,
      params.deviceId
    );
    encolarSync(db, 'usuarios', superadminId, 'insert', ahora);

    db.prepare(
      `INSERT INTO listas_precio (
        id, comercio_id, nombre, es_predeterminada,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, 'Mostrador', 1, ?, ?, NULL, ?, 'pendiente')`
    ).run(listaPrecioId, comercioId, ahora, ahora, params.deviceId);
    encolarSync(db, 'listas_precio', listaPrecioId, 'insert', ahora);

    const actor: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: params.nombreAdmin,
      rol: 'superadmin',
      device_id: params.deviceId,
    };

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'inicializar_comercio',
      entidad: 'comercios',
      entidad_id: comercioId,
      valores_despues: {
        nombre: params.nombreComercio,
        superadmin_usuario: params.usuarioAdmin,
        clave_hash: params.claveHashAdmin, // Será omitido por sanitizarValoresAuditoria (Regla 16)
      },
      ahoraIso: ahora,
    });

    return { comercioId, superadminId, listaPrecioId };
  });
}

/**
 * Crea un nuevo usuario (solo permitido para superadmin, PLAN.md §6.1).
 */
export function crearUsuario(
  db: DatabaseSync,
  actor: ActorContexto,
  datos: {
    nombre: string;
    usuario: string;
    claveHash: string;
    rol: RolUsuario;
    puedeVenderMovil?: boolean;
  }
): string {
  exigirPermiso(actor.rol, 'gestionar_usuarios');

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const id = generarUuidV7();

    db.prepare(
      `INSERT INTO usuarios (
        id, comercio_id, nombre, usuario, clave_hash, rol,
        puede_vender_movil, activo, debe_cambiar_clave, creado_por,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      datos.nombre,
      datos.usuario,
      datos.claveHash,
      datos.rol,
      datos.puedeVenderMovil ? 1 : 0,
      actor.usuario_id,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'usuarios', id, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'usuario_crear',
      entidad: 'usuarios',
      entidad_id: id,
      valores_despues: {
        id,
        nombre: datos.nombre,
        usuario: datos.usuario,
        rol: datos.rol,
        activo: 1,
        clave_hash: datos.claveHash,
      },
      ahoraIso: ahora,
    });

    return id;
  });
}

/**
 * Actualiza el rol o estado activo de un usuario (solo superadmin; protege al último superadmin activo).
 */
export function actualizarRolOEstadoUsuario(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    usuarioObjetivoId: string;
    nuevoRol: RolUsuario;
    nuevoActivo: boolean;
    motivo?: string;
  }
): void {
  exigirPermiso(actor.rol, 'gestionar_usuarios');

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const actual = db
      .prepare(
        `SELECT id, nombre, usuario, rol, activo FROM usuarios
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.usuarioObjetivoId, actor.comercio_id) as
      | {
          id: string;
          nombre: string;
          usuario: string;
          rol: RolUsuario;
          activo: number;
        }
      | undefined;

    if (!actual) {
      throw new Error('Usuario no encontrado.');
    }

    db.prepare(
      `UPDATE usuarios
       SET rol = ?, activo = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      params.nuevoRol,
      params.nuevoActivo ? 1 : 0,
      ahora,
      actor.device_id,
      params.usuarioObjetivoId,
      actor.comercio_id
    );

    encolarSync(db, 'usuarios', params.usuarioObjetivoId, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'usuario_actualizar_rol_estado',
      entidad: 'usuarios',
      entidad_id: params.usuarioObjetivoId,
      valores_antes: { rol: actual.rol, activo: actual.activo },
      valores_despues: {
        rol: params.nuevoRol,
        activo: params.nuevoActivo ? 1 : 0,
      },
      motivo: params.motivo ?? null,
      ahoraIso: ahora,
    });
  });
}

/**
 * Crea un producto con su precio en la lista predeterminada, códigos de barras y stock inicial opcional.
 */
export function crearProducto(
  db: DatabaseSync,
  actor: ActorContexto,
  datos: {
    nombre: string;
    codigoInterno?: string;
    unidad?: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
    permiteDecimales?: boolean;
    costoCompraCentavos: Centavos;
    precioVentaCentavos: Centavos;
    alicuotaIva?: AlicuotaIva;
    exentoIva?: boolean;
    stockMinimo?: number;
    botonRapido?: boolean;
    codigosBarras?: readonly string[];
    stockInicial?: number;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  asegurarCentavos(datos.costoCompraCentavos, 'costoCompraCentavos');
  asegurarCentavos(datos.precioVentaCentavos, 'precioVentaCentavos');

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const productoId = generarUuidV7();

    db.prepare(
      `INSERT INTO productos (
        id, comercio_id, codigo_interno, nombre, unidad, permite_decimales,
        costo_compra, alicuota_iva, exento_iva, stock_minimo, activo, boton_rapido,
        fecha_ultimo_cambio_precio, created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      productoId,
      actor.comercio_id,
      datos.codigoInterno ?? null,
      datos.nombre,
      datos.unidad ?? 'unidad',
      datos.permiteDecimales ? 1 : 0,
      datos.costoCompraCentavos,
      datos.alicuotaIva ?? 21,
      datos.exentoIva ? 1 : 0,
      datos.stockMinimo ?? 0,
      datos.botonRapido ? 1 : 0,
      ahora,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'productos', productoId, 'insert', ahora);

    const listaRow = db
      .prepare(
        `SELECT id FROM listas_precio
         WHERE comercio_id = ? AND es_predeterminada = 1 AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(actor.comercio_id) as { id: string } | undefined;

    if (!listaRow) {
      throw new Error('No existe una lista de precios predeterminada para el comercio.');
    }

    const precioId = generarUuidV7();
    db.prepare(
      `INSERT INTO precios (
        id, comercio_id, producto_id, lista_precio_id, precio_venta,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      precioId,
      actor.comercio_id,
      productoId,
      listaRow.id,
      datos.precioVentaCentavos,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'precios', precioId, 'insert', ahora);

    for (const codigo of datos.codigosBarras ?? []) {
      const cbId = generarUuidV7();
      db.prepare(
        `INSERT INTO codigos_barras (
          id, comercio_id, producto_id, codigo,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(cbId, actor.comercio_id, productoId, codigo.trim(), ahora, ahora, actor.device_id);
      encolarSync(db, 'codigos_barras', cbId, 'insert', ahora);
    }

    if (datos.stockInicial && datos.stockInicial !== 0) {
      const movId = generarUuidV7();
      const cantidadNormalizada = normalizarMovimientoStock({
        tipo: 'ajuste',
        cantidad: datos.stockInicial,
        motivo: 'Stock inicial al crear producto',
      });
      db.prepare(
        `INSERT INTO movimientos_stock (
          id, comercio_id, producto_id, tipo, cantidad, costo_unitario,
          referencia_id, motivo, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, 'ajuste', ?, ?, ?, 'Stock inicial al crear producto', ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        movId,
        actor.comercio_id,
        productoId,
        cantidadNormalizada,
        datos.costoCompraCentavos,
        productoId,
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'movimientos_stock', movId, 'insert', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'producto_crear',
      entidad: 'productos',
      entidad_id: productoId,
      valores_despues: {
        id: productoId,
        nombre: datos.nombre,
        costo_compra: datos.costoCompraCentavos,
        precio_venta: datos.precioVentaCentavos,
        codigos_barras: datos.codigosBarras ?? [],
        stock_inicial: datos.stockInicial ?? 0,
      },
      ahoraIso: ahora,
    });

    return productoId;
  });
}

/**
 * Registra un movimiento de stock manual (compra, ajuste, devolución, merma) en una transacción auditada.
 */
export function registrarMovimientoStock(
  db: DatabaseSync,
  actor: ActorContexto,
  datos: {
    productoId: string;
    tipo: TipoMovimientoStock;
    cantidad: number;
    costoUnitarioCentavos?: Centavos;
    referenciaId?: string;
    motivo?: string;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const movId = generarUuidV7();
    const cantidadConSigno = normalizarMovimientoStock({
      tipo: datos.tipo,
      cantidad: datos.cantidad,
      motivo: datos.motivo,
    });
    const costo = datos.costoUnitarioCentavos ?? 0;
    asegurarCentavos(costo, 'costoUnitarioCentavos');

    db.prepare(
      `INSERT INTO movimientos_stock (
        id, comercio_id, producto_id, tipo, cantidad, costo_unitario,
        referencia_id, motivo, usuario_id,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      movId,
      actor.comercio_id,
      datos.productoId,
      datos.tipo,
      cantidadConSigno,
      costo,
      datos.referenciaId ?? null,
      datos.motivo ?? null,
      actor.usuario_id,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'movimientos_stock', movId, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: `stock_${datos.tipo}`,
      entidad: 'movimientos_stock',
      entidad_id: movId,
      valores_despues: {
        producto_id: datos.productoId,
        tipo: datos.tipo,
        cantidad: cantidadConSigno,
        costo_unitario: costo,
      },
      motivo: datos.motivo ?? null,
      ahoraIso: ahora,
    });

    return movId;
  });
}

/**
 * Obtiene el stock actual de un producto calculándolo desde la tabla movimientos_stock (Regla 4).
 */
export function obtenerStockProducto(
  db: DatabaseSync,
  comercioId: string,
  productoId: string
): number {
  const filas = db
    .prepare(
      `SELECT cantidad, deleted_at
       FROM movimientos_stock
       WHERE comercio_id = ? AND producto_id = ?`
    )
    .all(comercioId, productoId) as unknown as {
    cantidad: number;
    deleted_at: string | null;
  }[];

  return calcularStockActual(filas);
}

/**
 * Consulta un producto por código de barras para la pantalla de venta (sin exponer costo_compra, Regla 20).
 */
export function buscarProductoPorCodigoParaVenta(
  db: DatabaseSync,
  comercioId: string,
  codigoBarras: string
): {
  id: string;
  nombre: string;
  unidad: string;
  permite_decimales: number;
  alicuota_iva: AlicuotaIva;
  exento_iva: number;
  precio_venta: Centavos;
} | null {
  const fila = db
    .prepare(
      `SELECT
        v.id,
        v.nombre,
        v.unidad,
        v.permite_decimales,
        v.alicuota_iva,
        v.exento_iva,
        v.precio_venta
       FROM codigos_barras cb
       INNER JOIN vista_productos_venta v
         ON v.id = cb.producto_id
         AND v.comercio_id = cb.comercio_id
       WHERE cb.comercio_id = ?
         AND cb.codigo = ?
         AND cb.deleted_at IS NULL
         AND v.activo = 1
       LIMIT 1`
    )
    .get(comercioId, codigoBarras.trim()) as
    | {
        id: string;
        nombre: string;
        unidad: string;
        permite_decimales: number;
        alicuota_iva: AlicuotaIva;
        exento_iva: number;
        precio_venta: Centavos;
      }
    | undefined;

  if (!fila) return null;
  return proyectarProductoParaVenta(fila);
}

/**
 * Consulta productos en el listado de administración aplicando permisos por rol (Reglas 11 y 20).
 * Si el actor es cajero, lanza error de permiso; solo superadmin y encargado pueden ver costos.
 */
export function listarProductosAdministracion(
  db: DatabaseSync,
  actor: ActorContexto
): Array<{
  id: string;
  nombre: string;
  costo_compra: Centavos;
  precio_venta: Centavos;
  stock_actual: number;
}> {
  if (!puedeVerCostos(actor.rol)) {
    exigirPermiso(actor.rol, 'ver_costos_ganancias_margenes');
  }

  return db
    .prepare(
      `SELECT
        p.id,
        p.nombre,
        p.costo_compra,
        COALESCE(v.precio_venta, 0) AS precio_venta,
        COALESCE(s.stock_actual, 0) AS stock_actual
       FROM productos p
       LEFT JOIN vista_productos_venta v
         ON v.id = p.id AND v.comercio_id = p.comercio_id
       LEFT JOIN vista_stock_actual s
         ON s.producto_id = p.id AND s.comercio_id = p.comercio_id
       WHERE p.comercio_id = ? AND p.deleted_at IS NULL
       ORDER BY p.nombre ASC`
    )
    .all(actor.comercio_id) as unknown as Array<{
    id: string;
    nombre: string;
    costo_compra: Centavos;
    precio_venta: Centavos;
    stock_actual: number;
  }>;
}

/**
 * Registra una venta completa en una única transacción:
 * - Cabecera en `ventas`
 * - Ítems en `ventas_items` (copiando costo_unitario histórico desde productos)
 * - Pagos en `ventas_pagos`
 * - Movimientos negativos en `movimientos_stock`
 * - Registro en `auditoria` y `sync_cola`
 */
export function registrarVenta(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    items: readonly {
      productoId: string;
      cantidad: number;
      descuentoCentavos?: Centavos;
    }[];
    descuentoGlobalCentavos?: Centavos;
    pagos: readonly PagoVentaInput[];
    clienteId?: string;
    cajaSesionId?: string;
    canal?: 'escritorio' | 'web';
  }
): {
  ventaId: string;
  totalCentavos: Centavos;
  subtotalCentavos: Centavos;
} {
  exigirPermiso(actor.rol, 'vender_y_caja');

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const ventaId = generarUuidV7();

    const itemsInput: ItemVentaInput[] = params.items.map((it) => {
      const prod = db
        .prepare(
          `SELECT
            p.id,
            p.nombre,
            p.costo_compra,
            p.alicuota_iva,
            p.exento_iva,
            v.precio_venta
           FROM productos p
           INNER JOIN vista_productos_venta v
             ON v.id = p.id AND v.comercio_id = p.comercio_id
           WHERE p.id = ? AND p.comercio_id = ? AND p.deleted_at IS NULL AND p.activo = 1`
        )
        .get(it.productoId, actor.comercio_id) as
        | {
            id: string;
            nombre: string;
            costo_compra: Centavos;
            alicuota_iva: AlicuotaIva;
            exento_iva: number;
            precio_venta: Centavos;
          }
        | undefined;

      if (!prod) {
        throw new Error(`Producto no encontrado o inactivo: ${it.productoId}`);
      }

      return {
        producto_id: prod.id,
        descripcion: prod.nombre,
        cantidad: it.cantidad,
        precio_unitario: prod.precio_venta,
        costo_unitario: prod.costo_compra,
        descuento: it.descuentoCentavos ?? 0,
        alicuota_iva: prod.alicuota_iva,
        exento_iva: prod.exento_iva === 1,
      };
    });

    const resumen = calcularTotalesVenta(
      itemsInput,
      params.descuentoGlobalCentavos ?? 0,
      true
    );

    validarPagosVenta(params.pagos, resumen.total);

    db.prepare(
      `INSERT INTO ventas (
        id, comercio_id, fecha, usuario_id, cliente_id,
        subtotal, descuento, total, estado, caja_sesion_id,
        tipo_comprobante, canal, dispositivo_id, estado_facturacion,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completada', ?, 'ticket_no_fiscal', ?, ?, 'no_aplica', ?, ?, NULL, ?, 'pendiente')`
    ).run(
      ventaId,
      actor.comercio_id,
      ahora,
      actor.usuario_id,
      params.clienteId ?? null,
      resumen.subtotal,
      resumen.descuento_global,
      resumen.total,
      params.cajaSesionId ?? null,
      params.canal ?? 'escritorio',
      actor.device_id,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'ventas', ventaId, 'insert', ahora);

    for (const item of resumen.items) {
      const itemId = generarUuidV7();
      db.prepare(
        `INSERT INTO ventas_items (
          id, comercio_id, venta_id, producto_id, descripcion,
          cantidad, precio_unitario, costo_unitario, descuento, subtotal,
          alicuota_iva, exento_iva,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        itemId,
        actor.comercio_id,
        ventaId,
        item.producto_id,
        item.descripcion,
        item.cantidad,
        item.precio_unitario,
        item.costo_unitario,
        item.descuento,
        item.subtotal,
        item.alicuota_iva,
        item.exento_iva ? 1 : 0,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'ventas_items', itemId, 'insert', ahora);

      const movId = generarUuidV7();
      const cantidadDescuentoStock = normalizarMovimientoStock({
        tipo: 'venta',
        cantidad: item.cantidad,
      });

      db.prepare(
        `INSERT INTO movimientos_stock (
          id, comercio_id, producto_id, tipo, cantidad, costo_unitario,
          referencia_id, motivo, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, 'venta', ?, ?, ?, 'Venta de mostrador', ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        movId,
        actor.comercio_id,
        item.producto_id,
        cantidadDescuentoStock,
        item.costo_unitario,
        ventaId,
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'movimientos_stock', movId, 'insert', ahora);
    }

    for (const pago of params.pagos) {
      const pagoId = generarUuidV7();
      db.prepare(
        `INSERT INTO ventas_pagos (
          id, comercio_id, venta_id, medio, monto,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        pagoId,
        actor.comercio_id,
        ventaId,
        pago.medio,
        pago.monto,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'ventas_pagos', pagoId, 'insert', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'venta_crear',
      entidad: 'ventas',
      entidad_id: ventaId,
      valores_despues: {
        id: ventaId,
        subtotal: resumen.subtotal,
        descuento: resumen.descuento_global,
        total: resumen.total,
        cantidad_items: resumen.items.length,
        pagos: params.pagos,
      },
      ahoraIso: ahora,
    });

    return {
      ventaId,
      totalCentavos: resumen.total,
      subtotalCentavos: resumen.subtotal,
    };
  });
}

/**
 * Anula una venta completada devolviendo el stock mediante movimientos `anulacion_venta`
 * y registrando la auditoría (con autorizador obligatorio si el actor es cajero, PLAN.md §6.1 y §13).
 */
export function anularVenta(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    ventaId: string;
    motivo: string;
    autorizador?: AutorizadorContexto;
  }
): void {
  if (!params.motivo || params.motivo.trim().length === 0) {
    throw new Error('El motivo de anulación es obligatorio.');
  }

  if (requiereAutorizacionParaAnular(actor.rol)) {
    if (!params.autorizador) {
      throw new Error(
        'AUTORIZACION_REQUERIDA: Un cajero necesita autorización de un encargado o superadmin para anular una venta.'
      );
    }
    if (!puedeAutorizarAnulacion(params.autorizador.rol)) {
      throw new Error(
        `PERMISO_DENEGADO: El usuario autorizador (${params.autorizador.rol}) no tiene permisos para autorizar anulaciones.`
      );
    }
  }

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const venta = db
      .prepare(
        `SELECT id, estado, total FROM ventas
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.ventaId, actor.comercio_id) as
      | { id: string; estado: 'completada' | 'anulada'; total: Centavos }
      | undefined;

    if (!venta) {
      throw new Error('Venta no encontrada.');
    }
    if (venta.estado === 'anulada') {
      throw new Error('La venta ya fue anulada previamente.');
    }

    const autorizadorId = params.autorizador?.usuario_id ?? actor.usuario_id;

    db.prepare(
      `UPDATE ventas
       SET estado = 'anulada',
           anulada_por_id = ?,
           autorizada_por_id = ?,
           fecha_anulacion = ?,
           motivo_anulacion = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      actor.usuario_id,
      autorizadorId,
      ahora,
      params.motivo.trim(),
      ahora,
      actor.device_id,
      params.ventaId,
      actor.comercio_id
    );
    encolarSync(db, 'ventas', params.ventaId, 'update', ahora);

    const items = db
      .prepare(
        `SELECT producto_id, cantidad, costo_unitario
         FROM ventas_items
         WHERE venta_id = ? AND comercio_id = ?`
      )
      .all(params.ventaId, actor.comercio_id) as unknown as {
      producto_id: string;
      cantidad: number;
      costo_unitario: Centavos;
    }[];

    for (const item of items) {
      const movId = generarUuidV7();
      const cantidadDevolucion = normalizarMovimientoStock({
        tipo: 'anulacion_venta',
        cantidad: item.cantidad,
      });

      db.prepare(
        `INSERT INTO movimientos_stock (
          id, comercio_id, producto_id, tipo, cantidad, costo_unitario,
          referencia_id, motivo, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, 'anulacion_venta', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        movId,
        actor.comercio_id,
        item.producto_id,
        cantidadDevolucion,
        item.costo_unitario,
        params.ventaId,
        params.motivo.trim(),
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'movimientos_stock', movId, 'insert', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'venta_anular',
      entidad: 'ventas',
      entidad_id: params.ventaId,
      valores_antes: { estado: 'completada', total: venta.total },
      valores_despues: {
        estado: 'anulada',
        anulada_por_id: actor.usuario_id,
        autorizada_por_id: autorizadorId,
      },
      motivo: params.motivo.trim(),
      autorizador: params.autorizador ?? null,
      ahoraIso: ahora,
    });
  });
}

/**
 * Recorre los registros de auditoria de la base de datos y verifica la cadena SHA-256.
 */
export function verificarIntegridadAuditoriaDb(
  db: DatabaseSync,
  comercioId: string
): ResultadoVerificacionAuditoria {
  const filas = db
    .prepare(
      `SELECT
        id, comercio_id, fecha_hora, usuario_id, usuario_nombre, rol, device_id,
        accion, entidad, entidad_id, valores_antes, valores_despues, motivo,
        autorizado_por_id, autorizado_por_nombre, hash_prev, hash
       FROM auditoria
       WHERE comercio_id = ?
       ORDER BY rowid ASC`
    )
    .all(comercioId) as unknown as RegistroAuditoriaCompleto[];

  return verificarCadenaAuditoria(filas);
}
