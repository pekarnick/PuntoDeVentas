/**
 * Repositorio SQLite para Administración de Sucursales, Stock por Ubicación
 * y Transferencias / Migración de Mercadería entre Sucursales (PLAN.md §3 Reglas 4, 13, 14; §4 y §5).
 */

import type { DatabaseSync } from 'node:sqlite';
import { exigirPermiso } from '../domain/permisos.ts';
import { normalizarMovimientoStock } from '../domain/stock.ts';
import {
  calcularMapaStockPorSucursal,
  validarTransferenciaEntreSucursales,
  type ItemTransferenciaSucursalInput,
  type MovimientoStockSucursalInput,
  type ResumenStockMultiSucursalProducto,
  type SucursalDominio,
} from '../domain/sucursales.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  ejecutarEnTransaccion,
  encolarSync,
  insertarRegistroAuditoria,
  type ActorContexto,
} from './repositorios.ts';

export interface SucursalResumenDB extends SucursalDominio {
  readonly comercio_id: string;
  readonly cantidad_productos_con_stock: number;
  readonly total_unidades_stock: number;
  readonly cantidad_ventas: number;
}

export interface TransferenciaSucursalResumenDB {
  readonly id: string;
  readonly fecha: string;
  readonly sucursal_origen_id: string;
  readonly sucursal_origen_nombre: string;
  readonly sucursal_destino_id: string;
  readonly sucursal_destino_nombre: string;
  readonly usuario_id: string;
  readonly usuario_nombre: string;
  readonly motivo: string;
  readonly cantidad_items: number;
  readonly total_unidades: number;
}

/**
 * Garantiza que el comercio tenga al menos una sucursal principal ("Casa Central").
 * Si aún no existe ninguna sucursal activa para el comercio, la crea automáticamente.
 */
export function asegurarSucursalPrincipalComercio(
  db: DatabaseSync,
  comercioId: string,
  deviceId = 'terminal-local'
): SucursalDominio {
  const existente = db
    .prepare(
      `SELECT id, nombre, codigo, direccion, telefono, es_principal, activo
       FROM sucursales
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY es_principal DESC, created_at ASC
       LIMIT 1`
    )
    .get(comercioId) as
    | {
        id: string;
        nombre: string;
        codigo: string | null;
        direccion: string | null;
        telefono: string | null;
        es_principal: number;
        activo: number;
      }
    | undefined;

  if (existente) {
    return {
      id: existente.id,
      nombre: existente.nombre,
      codigo: existente.codigo,
      direccion: existente.direccion,
      telefono: existente.telefono,
      es_principal: existente.es_principal === 1,
      activo: existente.activo === 1,
    };
  }

  const comercioRow = db
    .prepare(`SELECT domicilio FROM comercios WHERE id = ? LIMIT 1`)
    .get(comercioId) as { domicilio: string | null } | undefined;

  const ahora = new Date().toISOString();
  const id = generarUuidV7();
  const direccionInicial = comercioRow?.domicilio ?? null;

  db.prepare(
    `INSERT INTO sucursales (
      id, comercio_id, nombre, codigo, direccion, telefono,
      es_principal, activo, created_at, updated_at, deleted_at, device_id, sync_status
    ) VALUES (?, ?, 'Casa Central', 'SUC-01', ?, NULL, 1, 1, ?, ?, NULL, ?, 'pendiente')`
  ).run(id, comercioId, direccionInicial, ahora, ahora, deviceId);

  encolarSync(db, 'sucursales', id, 'insert', ahora);

  return {
    id,
    nombre: 'Casa Central',
    codigo: 'SUC-01',
    direccion: direccionInicial,
    telefono: null,
    es_principal: true,
    activo: true,
  };
}

/**
 * Obtiene la sucursal actualmente activa en esta terminal.
 */
export function obtenerSucursalActivaTerminal(
  db: DatabaseSync,
  comercioId: string,
  deviceId = 'terminal-local'
): SucursalDominio {
  const principal = asegurarSucursalPrincipalComercio(db, comercioId, deviceId);

  const cfg = db
    .prepare(
      `SELECT sucursal_activa_id FROM configuracion_sistema WHERE comercio_id = ? LIMIT 1`
    )
    .get(comercioId) as { sucursal_activa_id: string | null } | undefined;

  if (cfg?.sucursal_activa_id) {
    const suc = db
      .prepare(
        `SELECT id, nombre, codigo, direccion, telefono, es_principal, activo
         FROM sucursales
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL AND activo = 1
         LIMIT 1`
      )
      .get(cfg.sucursal_activa_id, comercioId) as
      | {
          id: string;
          nombre: string;
          codigo: string | null;
          direccion: string | null;
          telefono: string | null;
          es_principal: number;
          activo: number;
        }
      | undefined;

    if (suc) {
      return {
        id: suc.id,
        nombre: suc.nombre,
        codigo: suc.codigo,
        direccion: suc.direccion,
        telefono: suc.telefono,
        es_principal: suc.es_principal === 1,
        activo: suc.activo === 1,
      };
    }
  }

  return principal;
}

/**
 * Cambia la sucursal activa de trabajo en la terminal local y registra la acción en auditoría.
 */
export function seleccionarSucursalActivaTerminal(
  db: DatabaseSync,
  actor: ActorContexto,
  sucursalId: string
): SucursalDominio {
  return ejecutarEnTransaccion(db, () => {
    asegurarSucursalPrincipalComercio(db, actor.comercio_id, actor.device_id);
    const suc = db
      .prepare(
        `SELECT id, nombre, codigo, direccion, telefono, es_principal, activo
         FROM sucursales
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL AND activo = 1
         LIMIT 1`
      )
      .get(sucursalId, actor.comercio_id) as
      | {
          id: string;
          nombre: string;
          codigo: string | null;
          direccion: string | null;
          telefono: string | null;
          es_principal: number;
          activo: number;
        }
      | undefined;

    if (!suc) {
      throw new Error('La sucursal seleccionada no existe o está inactiva.');
    }

    const ahora = new Date().toISOString();
    const existeCfg = db
      .prepare(
        `SELECT comercio_id FROM configuracion_sistema WHERE comercio_id = ? LIMIT 1`
      )
      .get(actor.comercio_id) as { comercio_id: string } | undefined;

    if (existeCfg) {
      db.prepare(
        `UPDATE configuracion_sistema
         SET sucursal_activa_id = ?, updated_at = ?
         WHERE comercio_id = ?`
      ).run(suc.id, ahora, actor.comercio_id);
    } else {
      db.prepare(
        `INSERT INTO configuracion_sistema (
          comercio_id, sucursal_activa_id, updated_at
        ) VALUES (?, ?, ?)`
      ).run(actor.comercio_id, suc.id, ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'sucursal_cambiar_activa',
      entidad: 'sucursales',
      entidad_id: suc.id,
      valores_despues: {
        sucursal_activa_id: suc.id,
        nombre: suc.nombre,
      },
      ahoraIso: ahora,
    });

    return {
      id: suc.id,
      nombre: suc.nombre,
      codigo: suc.codigo,
      direccion: suc.direccion,
      telefono: suc.telefono,
      es_principal: suc.es_principal === 1,
      activo: suc.activo === 1,
    };
  });
}

/**
 * Calcula el mapa completo de stock por sucursal para todos los productos del comercio.
 */
export function obtenerMapaStockPorSucursalDb(
  db: DatabaseSync,
  comercioId: string,
  deviceId = 'terminal-local'
): {
  readonly sucursales: readonly SucursalDominio[];
  readonly mapaPorProducto: ReadonlyMap<string, ResumenStockMultiSucursalProducto>;
} {
  asegurarSucursalPrincipalComercio(db, comercioId, deviceId);

  const filasSuc = db
    .prepare(
      `SELECT id, nombre, codigo, direccion, telefono, es_principal, activo
       FROM sucursales
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY es_principal DESC, nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    nombre: string;
    codigo: string | null;
    direccion: string | null;
    telefono: string | null;
    es_principal: number;
    activo: number;
  }>;

  const sucursales: SucursalDominio[] = filasSuc.map((s) => ({
    id: s.id,
    nombre: s.nombre,
    codigo: s.codigo,
    direccion: s.direccion,
    telefono: s.telefono,
    es_principal: s.es_principal === 1,
    activo: s.activo === 1,
  }));

  const filasProds = db
    .prepare(
      `SELECT id FROM productos WHERE comercio_id = ? AND deleted_at IS NULL`
    )
    .all(comercioId) as unknown as Array<{ id: string }>;

  const filasMovs = db
    .prepare(
      `SELECT producto_id, sucursal_id, cantidad, deleted_at
       FROM movimientos_stock
       WHERE comercio_id = ? AND deleted_at IS NULL`
    )
    .all(comercioId) as unknown as MovimientoStockSucursalInput[];

  const mapaPorProducto = calcularMapaStockPorSucursal({
    sucursales,
    movimientos: filasMovs,
    productosIds: filasProds.map((p) => p.id),
  });

  return { sucursales, mapaPorProducto };
}

/**
 * Lista todas las sucursales del comercio con sus indicadores de stock y ventas.
 */
export function listarSucursalesComercio(
  db: DatabaseSync,
  comercioId: string,
  deviceId = 'terminal-local'
): SucursalResumenDB[] {
  const { sucursales, mapaPorProducto } = obtenerMapaStockPorSucursalDb(
    db,
    comercioId,
    deviceId
  );

  const sucPrincipalId =
    sucursales.find((s) => s.es_principal)?.id ?? sucursales[0]?.id ?? '';

  const ventasPorSucRows = db
    .prepare(
      `SELECT COALESCE(sucursal_id, ?) AS suc_id, COUNT(*) AS cant
       FROM ventas
       WHERE comercio_id = ? AND estado = 'completada' AND deleted_at IS NULL
       GROUP BY COALESCE(sucursal_id, ?)`
    )
    .all(sucPrincipalId, comercioId, sucPrincipalId) as unknown as Array<{
    suc_id: string;
    cant: number;
  }>;

  const mapaVentasCount = new Map(
    ventasPorSucRows.map((r) => [r.suc_id, Number(r.cant)])
  );

  return sucursales.map((suc) => {
    let prodsConStock = 0;
    let totalUnidades = 0;
    for (const resProd of mapaPorProducto.values()) {
      const stk = resProd.por_sucursal[suc.id] ?? 0;
      if (stk > 0) {
        prodsConStock += 1;
        totalUnidades += stk;
      }
    }

    return {
      ...suc,
      comercio_id: comercioId,
      cantidad_productos_con_stock: prodsConStock,
      total_unidades_stock: Math.round(totalUnidades * 1000) / 1000,
      cantidad_ventas: mapaVentasCount.get(suc.id) ?? 0,
    };
  });
}

/**
 * Crea una nueva sucursal en el comercio (superadmin o encargado).
 */
export function crearSucursalComercio(
  db: DatabaseSync,
  actor: ActorContexto,
  datos: {
    readonly nombre: string;
    readonly codigo?: string | null;
    readonly direccion?: string | null;
    readonly telefono?: string | null;
    readonly esPrincipal?: boolean;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const nombreLimpio = datos.nombre.trim();
  if (!nombreLimpio) {
    throw new Error('El nombre de la sucursal es obligatorio.');
  }

  return ejecutarEnTransaccion(db, () => {
    asegurarSucursalPrincipalComercio(db, actor.comercio_id, actor.device_id);
    const ahora = new Date().toISOString();
    const id = generarUuidV7();

    if (datos.esPrincipal) {
      db.prepare(
        `UPDATE sucursales
         SET es_principal = 0, updated_at = ?, device_id = ?, sync_status = 'pendiente'
         WHERE comercio_id = ? AND es_principal = 1`
      ).run(ahora, actor.device_id, actor.comercio_id);
    }

    db.prepare(
      `INSERT INTO sucursales (
        id, comercio_id, nombre, codigo, direccion, telefono,
        es_principal, activo, created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      nombreLimpio,
      datos.codigo?.trim() || null,
      datos.direccion?.trim() || null,
      datos.telefono?.trim() || null,
      datos.esPrincipal ? 1 : 0,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'sucursales', id, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'sucursal_crear',
      entidad: 'sucursales',
      entidad_id: id,
      valores_despues: {
        id,
        nombre: nombreLimpio,
        codigo: datos.codigo?.trim() || null,
        direccion: datos.direccion?.trim() || null,
        telefono: datos.telefono?.trim() || null,
        es_principal: datos.esPrincipal ? 1 : 0,
      },
      ahoraIso: ahora,
    });

    return id;
  });
}

/**
 * Actualiza los datos o el estado activo de una sucursal existente.
 */
export function actualizarSucursalComercio(
  db: DatabaseSync,
  actor: ActorContexto,
  datos: {
    readonly sucursalId: string;
    readonly nombre: string;
    readonly codigo?: string | null;
    readonly direccion?: string | null;
    readonly telefono?: string | null;
    readonly activo?: boolean;
  }
): void {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const nombreLimpio = datos.nombre.trim();
  if (!nombreLimpio) {
    throw new Error('El nombre de la sucursal es obligatorio.');
  }

  ejecutarEnTransaccion(db, () => {
    const actual = db
      .prepare(
        `SELECT id, nombre, codigo, direccion, telefono, es_principal, activo
         FROM sucursales
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(datos.sucursalId, actor.comercio_id) as
      | {
          id: string;
          nombre: string;
          codigo: string | null;
          direccion: string | null;
          telefono: string | null;
          es_principal: number;
          activo: number;
        }
      | undefined;

    if (!actual) {
      throw new Error('Sucursal no encontrada.');
    }

    const nuevoActivo = datos.activo !== undefined ? (datos.activo ? 1 : 0) : actual.activo;
    if (nuevoActivo === 0 && actual.es_principal === 1) {
      throw new Error(
        'No se puede desactivar la Sucursal Principal del comercio.'
      );
    }

    const ahora = new Date().toISOString();
    db.prepare(
      `UPDATE sucursales
       SET nombre = ?, codigo = ?, direccion = ?, telefono = ?, activo = ?,
           updated_at = ?, device_id = ?, sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      nombreLimpio,
      datos.codigo?.trim() || null,
      datos.direccion?.trim() || null,
      datos.telefono?.trim() || null,
      nuevoActivo,
      ahora,
      actor.device_id,
      datos.sucursalId,
      actor.comercio_id
    );

    encolarSync(db, 'sucursales', datos.sucursalId, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'sucursal_actualizar',
      entidad: 'sucursales',
      entidad_id: datos.sucursalId,
      valores_antes: {
        nombre: actual.nombre,
        codigo: actual.codigo,
        direccion: actual.direccion,
        telefono: actual.telefono,
        activo: actual.activo,
      },
      valores_despues: {
        nombre: nombreLimpio,
        codigo: datos.codigo?.trim() || null,
        direccion: datos.direccion?.trim() || null,
        telefono: datos.telefono?.trim() || null,
        activo: nuevoActivo,
      },
      ahoraIso: ahora,
    });
  });
}

/**
 * Transfiere / migra productos de una sucursal de origen a una sucursal de destino
 * mediante movimientos de stock append-only compensados en una misma transacción atómica.
 */
export function transferirProductosEntreSucursales(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly sucursalOrigenId: string;
    readonly sucursalDestinoId: string;
    readonly motivo: string;
    readonly items: ReadonlyArray<{
      readonly productoId: string;
      readonly cantidad: number;
    }>;
  }
): {
  readonly transferenciaId: string;
  readonly cantidadItems: number;
  readonly totalUnidades: number;
} {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  return ejecutarEnTransaccion(db, () => {
    const { sucursales, mapaPorProducto } = obtenerMapaStockPorSucursalDb(
      db,
      actor.comercio_id,
      actor.device_id
    );

    const sucOrigen = sucursales.find((s) => s.id === params.sucursalOrigenId);
    const sucDestino = sucursales.find((s) => s.id === params.sucursalDestinoId);

    if (!sucOrigen || !sucDestino || !sucOrigen.activo || !sucDestino.activo) {
      throw new Error(
        'La sucursal de origen o la sucursal de destino no existe o está inactiva.'
      );
    }

    const cantidadesAgregadas = new Map<string, number>();
    for (const it of params.items) {
      cantidadesAgregadas.set(
        it.productoId,
        (cantidadesAgregadas.get(it.productoId) ?? 0) + it.cantidad
      );
    }

    const itemsConStockOrigen: Array<
      ItemTransferenciaSucursalInput & { costoCompra: number }
    > = Array.from(cantidadesAgregadas.entries()).map(
      ([productoId, cantidadTotal]) => {
        const prodRow = db
          .prepare(
            `SELECT id, nombre, costo_compra FROM productos
             WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
          )
          .get(productoId, actor.comercio_id) as
          | { id: string; nombre: string; costo_compra: number }
          | undefined;

        if (!prodRow) {
          throw new Error(`Producto no encontrado: ${productoId}`);
        }

        const resStock = mapaPorProducto.get(productoId);
        const dispOrigen =
          resStock?.por_sucursal[params.sucursalOrigenId] ?? 0;

        return {
          productoId: prodRow.id,
          nombreProducto: prodRow.nombre,
          cantidad: cantidadTotal,
          stockDisponibleOrigen: dispOrigen,
          costoCompra: prodRow.costo_compra,
        };
      }
    );

    const validado = validarTransferenciaEntreSucursales({
      sucursalOrigenId: params.sucursalOrigenId,
      sucursalDestinoId: params.sucursalDestinoId,
      motivo: params.motivo,
      items: itemsConStockOrigen,
    });

    const ahora = new Date().toISOString();
    const transferenciaId = generarUuidV7();
    const motivoLimpio = params.motivo.trim();

    db.prepare(
      `INSERT INTO transferencias_sucursales (
        id, comercio_id, sucursal_origen_id, sucursal_destino_id,
        usuario_id, motivo, fecha, cantidad_items, total_unidades,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      transferenciaId,
      actor.comercio_id,
      params.sucursalOrigenId,
      params.sucursalDestinoId,
      actor.usuario_id,
      motivoLimpio,
      ahora,
      validado.itemsNormalizados.length,
      validado.totalUnidades,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'transferencias_sucursales', transferenciaId, 'insert', ahora);

    for (let i = 0; i < validado.itemsNormalizados.length; i += 1) {
      const norm = validado.itemsNormalizados[i]!;
      const infoExtra = itemsConStockOrigen[i]!;

      // 1. Movimiento de salida en la sucursal de origen (negativo)
      const movSalidaId = generarUuidV7();
      const cantSalida = normalizarMovimientoStock({
        tipo: 'ajuste',
        cantidad: -Math.abs(norm.cantidad),
        motivo: `Transferencia hacia ${sucDestino.nombre}: ${motivoLimpio}`,
      });

      db.prepare(
        `INSERT INTO movimientos_stock (
          id, comercio_id, producto_id, sucursal_id, tipo, cantidad, costo_unitario,
          referencia_id, motivo, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, 'ajuste', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        movSalidaId,
        actor.comercio_id,
        norm.productoId,
        params.sucursalOrigenId,
        cantSalida,
        infoExtra.costoCompra,
        transferenciaId,
        `Transferencia hacia ${sucDestino.nombre}: ${motivoLimpio}`,
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'movimientos_stock', movSalidaId, 'insert', ahora);

      // 2. Movimiento de entrada en la sucursal de destino (positivo)
      const movEntradaId = generarUuidV7();
      const cantEntrada = normalizarMovimientoStock({
        tipo: 'ajuste',
        cantidad: Math.abs(norm.cantidad),
        motivo: `Transferencia desde ${sucOrigen.nombre}: ${motivoLimpio}`,
      });

      db.prepare(
        `INSERT INTO movimientos_stock (
          id, comercio_id, producto_id, sucursal_id, tipo, cantidad, costo_unitario,
          referencia_id, motivo, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, 'ajuste', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        movEntradaId,
        actor.comercio_id,
        norm.productoId,
        params.sucursalDestinoId,
        cantEntrada,
        infoExtra.costoCompra,
        transferenciaId,
        `Transferencia desde ${sucOrigen.nombre}: ${motivoLimpio}`,
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'movimientos_stock', movEntradaId, 'insert', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'sucursal_transferir_stock',
      entidad: 'transferencias_sucursales',
      entidad_id: transferenciaId,
      valores_despues: {
        id: transferenciaId,
        sucursal_origen_id: params.sucursalOrigenId,
        sucursal_origen_nombre: sucOrigen.nombre,
        sucursal_destino_id: params.sucursalDestinoId,
        sucursal_destino_nombre: sucDestino.nombre,
        cantidad_items: validado.itemsNormalizados.length,
        total_unidades: validado.totalUnidades,
        items: validado.itemsNormalizados,
      },
      motivo: motivoLimpio,
      ahoraIso: ahora,
    });

    return {
      transferenciaId,
      cantidadItems: validado.itemsNormalizados.length,
      totalUnidades: validado.totalUnidades,
    };
  });
}

/**
 * Lista el historial de transferencias de mercadería realizadas entre sucursales.
 */
export function listarTransferenciasSucursales(
  db: DatabaseSync,
  comercioId: string,
  limite = 50
): TransferenciaSucursalResumenDB[] {
  return db
    .prepare(
      `SELECT
         t.id,
         t.fecha,
         t.sucursal_origen_id,
         COALESCE(so.nombre, 'Sucursal Origen') AS sucursal_origen_nombre,
         t.sucursal_destino_id,
         COALESCE(sd.nombre, 'Sucursal Destino') AS sucursal_destino_nombre,
         t.usuario_id,
         COALESCE(u.nombre, 'Operador') AS usuario_nombre,
         t.motivo,
         t.cantidad_items,
         t.total_unidades
       FROM transferencias_sucursales t
       LEFT JOIN sucursales so ON so.id = t.sucursal_origen_id
       LEFT JOIN sucursales sd ON sd.id = t.sucursal_destino_id
       LEFT JOIN usuarios u ON u.id = t.usuario_id
       WHERE t.comercio_id = ? AND t.deleted_at IS NULL
       ORDER BY t.fecha DESC
       LIMIT ?`
    )
    .all(comercioId, limite) as unknown as TransferenciaSucursalResumenDB[];
}
