/**
 * Repositorios transaccionales SQLite para la Fase 3 — Gestión completa (PLAN.md §3, §4, §7, §8, §10):
 * - Categorías, Marcas y Proveedores con validación de CUIT
 * - Compras a Proveedores (`compras` + `compras_items` + `movimientos_stock` + `cuenta_corriente_movimientos`)
 * - Clientes y Cuenta Corriente (`clientes` + `cuenta_corriente_movimientos` + control de `limite_credito`)
 * - Actualización masiva de precios e importación de catálogo por CSV
 * - Libro IVA Ventas y Libro IVA Compras exportable a Excel (.xlsx) para el contador
 * - Generación de comandos de impresión térmica ESC/POS desde una venta registrada (Regla 20: sin costos)
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  validarCuitArgentino,
  validarCuitODniCliente,
  type CondicionIvaReceptor,
} from '../domain/cuit.ts';
import {
  exigirEnteroCentavos,
  formatearFechaAR,
  type Centavos,
} from '../domain/dinero.ts';
import {
  calcularEstadoCuentaCorriente,
  calcularFilaLibroIvaDesdeItems,
  calcularNuevoPrecioMasivo,
  consolidarResumenLibroIva,
  generarComandosEscPosTicket,
  parsearCsvImportacionCatalogo,
  validarCargoCuentaCorrienteCliente,
  type AnchoPapelTermico,
  type FilaLibroIva,
  type ReglaRedondeoPrecio,
  type ResumenLibroIva,
} from '../domain/gestion_fase3.ts';
import { exigirPermiso } from '../domain/permisos.ts';
import { desglosarIvaPorItem, type AlicuotaIva } from '../domain/totales.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import { generarLibroXlsx } from '../domain/xlsx.ts';
import { obtenerDatosTicketDeVentaDb } from './productos_repo.ts';
import {
  crearProducto,
  ejecutarEnTransaccion,
  encolarSync,
  insertarRegistroAuditoria,
  type ActorContexto,
} from './repositorios.ts';

// ============================================================================
// 1. Categorías y Marcas
// ============================================================================

export interface CategoriaFila {
  readonly id: string;
  readonly nombre: string;
  readonly padre_id: string | null;
}

export interface MarcaFila {
  readonly id: string;
  readonly nombre: string;
}

export function listarCategorias(
  db: DatabaseSync,
  comercioId: string
): CategoriaFila[] {
  return db
    .prepare(
      `SELECT id, nombre, padre_id
       FROM categorias
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY nombre ASC`
    )
    .all(comercioId) as unknown as CategoriaFila[];
}

export function crearCategoria(
  db: DatabaseSync,
  actor: ActorContexto,
  params: { nombre: string; padreId?: string | null }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const nombre = params.nombre.trim();
  if (!nombre) {
    throw new Error('El nombre de la categoría es obligatorio.');
  }

  return ejecutarEnTransaccion(db, () => {
    const existente = db
      .prepare(
        `SELECT id FROM categorias
         WHERE comercio_id = ? AND lower(nombre) = lower(?) AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(actor.comercio_id, nombre) as { id: string } | undefined;
    if (existente) {
      return existente.id;
    }

    const ahora = new Date().toISOString();
    const id = generarUuidV7();
    db.prepare(
      `INSERT INTO categorias (
        id, comercio_id, nombre, padre_id,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      nombre,
      params.padreId ?? null,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'categorias', id, 'insert', ahora);
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'categoria_crear',
      entidad: 'categorias',
      entidad_id: id,
      valores_despues: { id, nombre, padre_id: params.padreId ?? null },
      ahoraIso: ahora,
    });

    return id;
  });
}

export function listarMarcas(db: DatabaseSync, comercioId: string): MarcaFila[] {
  return db
    .prepare(
      `SELECT id, nombre
       FROM marcas
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY nombre ASC`
    )
    .all(comercioId) as unknown as MarcaFila[];
}

export function crearMarca(
  db: DatabaseSync,
  actor: ActorContexto,
  params: { nombre: string }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const nombre = params.nombre.trim();
  if (!nombre) {
    throw new Error('El nombre de la marca es obligatorio.');
  }

  return ejecutarEnTransaccion(db, () => {
    const existente = db
      .prepare(
        `SELECT id FROM marcas
         WHERE comercio_id = ? AND lower(nombre) = lower(?) AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(actor.comercio_id, nombre) as { id: string } | undefined;
    if (existente) {
      return existente.id;
    }

    const ahora = new Date().toISOString();
    const id = generarUuidV7();
    db.prepare(
      `INSERT INTO marcas (
        id, comercio_id, nombre,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(id, actor.comercio_id, nombre, ahora, ahora, actor.device_id);

    encolarSync(db, 'marcas', id, 'insert', ahora);
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'marca_crear',
      entidad: 'marcas',
      entidad_id: id,
      valores_despues: { id, nombre },
      ahoraIso: ahora,
    });

    return id;
  });
}

// ============================================================================
// 2. Proveedores y Compras (PLAN.md §4, §6.1, §10)
// ============================================================================

export interface ProveedorConSaldoFila {
  readonly id: string;
  readonly nombre: string;
  readonly razon_social: string;
  readonly cuit: string | null;
  readonly contacto: string | null;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly condiciones_pago: string | null;
  readonly total_cargos_centavos: Centavos;
  readonly total_pagos_centavos: Centavos;
  readonly saldo_pendiente_centavos: Centavos;
}

export function crearProveedor(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    nombre?: string;
    razonSocial?: string;
    cuit?: string | null;
    contacto?: string | null;
    telefono?: string | null;
    email?: string | null;
    condicionesPago?: string | null;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const nombre = (params.nombre ?? params.razonSocial ?? '').trim();
  if (!nombre) {
    throw new Error('El nombre o razón social del proveedor es obligatorio.');
  }

  let cuitNormalizado: string | null = null;
  if (params.cuit && params.cuit.trim().length > 0) {
    const valCuit = validarCuitArgentino(params.cuit);
    if (!valCuit.valido) {
      throw new Error(valCuit.motivo ?? 'CUIT del proveedor inválido.');
    }
    cuitNormalizado = valCuit.cuitFormateado;
  }

  const contactoUnificado =
    params.contacto?.trim() ||
    [params.telefono?.trim(), params.email?.trim()].filter(Boolean).join(' | ') ||
    null;

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const id = generarUuidV7();

    db.prepare(
      `INSERT INTO proveedores (
        id, comercio_id, nombre, cuit, contacto, condiciones_pago,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      nombre,
      cuitNormalizado,
      contactoUnificado,
      params.condicionesPago?.trim() || null,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'proveedores', id, 'insert', ahora);
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'proveedor_crear',
      entidad: 'proveedores',
      entidad_id: id,
      valores_despues: {
        id,
        nombre,
        cuit: cuitNormalizado,
        contacto: contactoUnificado,
      },
      ahoraIso: ahora,
    });

    return id;
  });
}

export function obtenerEstadoEntidadCuentaCorriente(
  db: DatabaseSync,
  comercioId: string,
  entidadTipo: 'cliente' | 'proveedor',
  entidadId: string
) {
  const movs = db
    .prepare(
      `SELECT id, tipo, monto
       FROM cuenta_corriente_movimientos
       WHERE comercio_id = ?
         AND entidad_tipo = ?
         AND entidad_id = ?
         AND deleted_at IS NULL`
    )
    .all(comercioId, entidadTipo, entidadId) as unknown as {
    id: string;
    tipo: 'cargo' | 'pago';
    monto: Centavos;
  }[];

  return calcularEstadoCuentaCorriente(movs);
}

export function obtenerSaldoEntidadCuentaCorriente(
  db: DatabaseSync,
  comercioId: string,
  entidadTipo: 'cliente' | 'proveedor',
  entidadId: string
): Centavos {
  return obtenerEstadoEntidadCuentaCorriente(
    db,
    comercioId,
    entidadTipo,
    entidadId
  ).saldoPendienteCentavos;
}

export function listarProveedoresConSaldo(
  db: DatabaseSync,
  actorOComercioId: ActorContexto | string
): ProveedorConSaldoFila[] {
  const comercioId =
    typeof actorOComercioId === 'string'
      ? actorOComercioId
      : actorOComercioId.comercio_id;

  if (typeof actorOComercioId !== 'string') {
    exigirPermiso(actorOComercioId.rol, 'abm_productos_precios_stock_compras');
  }

  const filas = db
    .prepare(
      `SELECT id, nombre, cuit, contacto, condiciones_pago
       FROM proveedores
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    nombre: string;
    cuit: string | null;
    contacto: string | null;
    condiciones_pago: string | null;
  }>;

  return filas.map((f) => {
    const estado = obtenerEstadoEntidadCuentaCorriente(
      db,
      comercioId,
      'proveedor',
      f.id
    );
    return {
      ...f,
      razon_social: f.nombre,
      telefono: f.contacto,
      email: null,
      total_cargos_centavos: estado.totalCargosCentavos,
      total_pagos_centavos: estado.totalPagosCentavos,
      saldo_pendiente_centavos: estado.saldoPendienteCentavos,
    };
  });
}

export interface ItemCompraInput {
  readonly productoId: string;
  readonly cantidad: number;
  readonly costoUnitarioCentavos: Centavos;
  readonly alicuotaIva?: AlicuotaIva;
  readonly actualizarCostoProducto?: boolean;
  readonly nuevoPrecioVentaCentavos?: Centavos;
}

export interface ResumenCompraFila {
  readonly id: string;
  readonly fecha: string;
  readonly proveedor_id: string;
  readonly proveedor_nombre: string;
  readonly comprobante_proveedor: string | null;
  readonly numero_comprobante: string | null;
  readonly subtotal: Centavos;
  readonly iva: Centavos;
  readonly total: Centavos;
  readonly total_centavos: Centavos;
  readonly usuario_nombre: string;
  readonly estado: 'registrada' | 'anulada';
  readonly cantidad_items: number;
}

/**
 * Registra una factura/remito de compra a un proveedor en una sola transacción:
 * 1. Inserta cabecera en `compras` e ítems en `compras_items`.
 * 2. Inserta movimientos positivos `tipo = 'compra'` en `movimientos_stock` (Regla 4).
 * 3. Actualiza `costo_compra` del producto (si `actualizarCostoProducto !== false`).
 * 4. Si se deja en cuenta corriente con el proveedor, registra un `cargo` (y opcionalmente un `pago` parcial en el acto).
 * 5. Registra todo en `auditoria` y `sync_cola`.
 */
export function registrarCompraProveedor(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    proveedorId?: string | null;
    comprobanteProveedor?: string | null;
    numeroComprobante?: string | null;
    ivaCentavos?: Centavos;
    enCuentaCorriente?: boolean;
    registrarCargoCuentaCorriente?: boolean;
    montoPagadoEnElActoCentavos?: Centavos;
    items: readonly ItemCompraInput[];
  }
): {
  compraId: string;
  subtotalCentavos: Centavos;
  ivaCentavos: Centavos;
  totalCentavos: Centavos;
} {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  if (params.items.length === 0) {
    throw new Error('La compra debe incluir al menos un producto.');
  }

  return ejecutarEnTransaccion(db, () => {
    let provIdEfectivo = params.proveedorId ?? null;
    let provNombre = 'Compra Directa';

    if (provIdEfectivo) {
      const prov = db
        .prepare(
          `SELECT id, nombre FROM proveedores
           WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
        )
        .get(provIdEfectivo, actor.comercio_id) as
        | { id: string; nombre: string }
        | undefined;

      if (!prov) {
        throw new Error('Proveedor no encontrado.');
      }
      provNombre = prov.nombre;
    } else {
      // Garantizar proveedor general si se registra compra directa sin proveedor seleccionado
      provIdEfectivo = crearProveedor(db, actor, {
        nombre: 'Proveedor General (Compra Directa)',
      });
    }

    const ahora = new Date().toISOString();
    const compraId = generarUuidV7();
    const nroComprobante =
      (params.comprobanteProveedor ?? params.numeroComprobante ?? '').trim() ||
      null;

    let subtotal = 0;
    let ivaCalculado = 0;

    for (const item of params.items) {
      if (item.cantidad <= 0) {
        throw new Error('La cantidad comprada debe ser mayor a 0.');
      }
      exigirEnteroCentavos(
        item.costoUnitarioCentavos,
        'costoUnitarioCentavos en compra'
      );
      if (item.costoUnitarioCentavos < 0) {
        throw new Error('El costo unitario no puede ser negativo.');
      }
      const subItem = Math.round(item.cantidad * item.costoUnitarioCentavos);
      const alicuota = item.alicuotaIva ?? 21;
      const desglose = desglosarIvaPorItem(subItem, alicuota, alicuota === 0, true);
      subtotal += desglose.neto;
      ivaCalculado += desglose.iva;
    }

    const ivaCentavos =
      params.ivaCentavos !== undefined ? params.ivaCentavos : ivaCalculado;
    exigirEnteroCentavos(ivaCentavos, 'ivaCentavos');
    const totalCentavos =
      params.ivaCentavos !== undefined
        ? subtotal + ivaCalculado + params.ivaCentavos
        : subtotal + ivaCentavos;

    db.prepare(
      `INSERT INTO compras (
        id, comercio_id, proveedor_id, usuario_id, fecha, comprobante_proveedor,
        subtotal, iva, total, estado,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'registrada', ?, ?, NULL, ?, 'pendiente')`
    ).run(
      compraId,
      actor.comercio_id,
      provIdEfectivo,
      actor.usuario_id,
      ahora,
      nroComprobante,
      subtotal,
      ivaCentavos,
      totalCentavos,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'compras', compraId, 'insert', ahora);

    const listaDefault = db
      .prepare(
        `SELECT id FROM listas_precio
         WHERE comercio_id = ? AND es_predeterminada = 1 AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(actor.comercio_id) as { id: string } | undefined;

    for (const item of params.items) {
      const prodExistente = db
        .prepare(
          `SELECT id, nombre, costo_compra FROM productos
           WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
        )
        .get(item.productoId, actor.comercio_id) as
        | { id: string; nombre: string; costo_compra: Centavos }
        | undefined;

      if (!prodExistente) {
        throw new Error(`Producto no encontrado en compra: ${item.productoId}`);
      }

      const itemId = generarUuidV7();
      db.prepare(
        `INSERT INTO compras_items (
          id, comercio_id, compra_id, producto_id, cantidad, costo_unitario,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        itemId,
        actor.comercio_id,
        compraId,
        item.productoId,
        item.cantidad,
        item.costoUnitarioCentavos,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'compras_items', itemId, 'insert', ahora);

      // Movimiento de ingreso de stock (Regla 4)
      const movStockId = generarUuidV7();
      db.prepare(
        `INSERT INTO movimientos_stock (
          id, comercio_id, producto_id, tipo, cantidad, costo_unitario,
          referencia_id, motivo, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, 'compra', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        movStockId,
        actor.comercio_id,
        item.productoId,
        Math.abs(item.cantidad),
        item.costoUnitarioCentavos,
        compraId,
        `Compra a ${provNombre}${nroComprobante ? ` (${nroComprobante})` : ''}`,
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'movimientos_stock', movStockId, 'insert', ahora);

      // Actualizar costo_compra (si actualizarCostoProducto !== false) y proveedor_principal_id
      if (item.actualizarCostoProducto !== false) {
        db.prepare(
          `UPDATE productos
           SET costo_compra = ?,
               proveedor_principal_id = ?,
               updated_at = ?,
               device_id = ?,
               sync_status = 'pendiente'
           WHERE id = ? AND comercio_id = ?`
        ).run(
          item.costoUnitarioCentavos,
          provIdEfectivo,
          ahora,
          actor.device_id,
          item.productoId,
          actor.comercio_id
        );
        encolarSync(db, 'productos', item.productoId, 'update', ahora);
      }

      if (
        item.nuevoPrecioVentaCentavos !== undefined &&
        item.nuevoPrecioVentaCentavos > 0 &&
        listaDefault
      ) {
        exigirEnteroCentavos(
          item.nuevoPrecioVentaCentavos,
          'nuevoPrecioVentaCentavos'
        );
        const margenBp =
          item.costoUnitarioCentavos > 0
            ? Math.round(
                ((item.nuevoPrecioVentaCentavos - item.costoUnitarioCentavos) /
                  item.costoUnitarioCentavos) *
                  10000
              )
            : null;

        const precioRow = db
          .prepare(
            `SELECT id FROM precios
             WHERE comercio_id = ? AND producto_id = ? AND lista_precio_id = ? AND deleted_at IS NULL`
          )
          .get(actor.comercio_id, item.productoId, listaDefault.id) as
          | { id: string }
          | undefined;

        if (precioRow) {
          db.prepare(
            `UPDATE precios
             SET precio_venta = ?, margen_bp = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
             WHERE id = ?`
          ).run(
            item.nuevoPrecioVentaCentavos,
            margenBp,
            ahora,
            actor.device_id,
            precioRow.id
          );
          encolarSync(db, 'precios', precioRow.id, 'update', ahora);
        }
      }
    }

    const cargarCc =
      Boolean(params.enCuentaCorriente) ||
      Boolean(params.registrarCargoCuentaCorriente);

    if (cargarCc && totalCentavos > 0) {
      const ccId = generarUuidV7();
      db.prepare(
        `INSERT INTO cuenta_corriente_movimientos (
          id, comercio_id, entidad_tipo, entidad_id, tipo, monto,
          referencia_id, observaciones, usuario_id,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, 'proveedor', ?, 'cargo', ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        ccId,
        actor.comercio_id,
        provIdEfectivo,
        totalCentavos,
        compraId,
        `Compra ${nroComprobante || compraId.slice(-8)}`,
        actor.usuario_id,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'cuenta_corriente_movimientos', ccId, 'insert', ahora);

      const pagadoActo = params.montoPagadoEnElActoCentavos ?? 0;
      if (pagadoActo > 0) {
        const pagoId = generarUuidV7();
        db.prepare(
          `INSERT INTO cuenta_corriente_movimientos (
            id, comercio_id, entidad_tipo, entidad_id, tipo, monto,
            referencia_id, observaciones, usuario_id,
            created_at, updated_at, deleted_at, device_id, sync_status
          ) VALUES (?, ?, 'proveedor', ?, 'pago', ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
        ).run(
          pagoId,
          actor.comercio_id,
          provIdEfectivo,
          pagadoActo,
          compraId,
          `Pago en el acto s/compra ${nroComprobante || compraId.slice(-8)}`,
          actor.usuario_id,
          ahora,
          ahora,
          actor.device_id
        );
        encolarSync(db, 'cuenta_corriente_movimientos', pagoId, 'insert', ahora);
      }
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'compra_registrar',
      entidad: 'compras',
      entidad_id: compraId,
      valores_despues: {
        id: compraId,
        proveedor_id: provIdEfectivo,
        comprobante_proveedor: nroComprobante,
        subtotal,
        iva: ivaCentavos,
        total: totalCentavos,
        en_cuenta_corriente: cargarCc,
        items_count: params.items.length,
      },
      ahoraIso: ahora,
    });

    return {
      compraId,
      subtotalCentavos: subtotal,
      ivaCentavos,
      totalCentavos,
    };
  });
}

export function listarComprasRecientes(
  db: DatabaseSync,
  actor: ActorContexto
): ResumenCompraFila[] {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  const filas = db
    .prepare(
      `SELECT
        c.id,
        c.fecha,
        c.proveedor_id,
        p.nombre AS proveedor_nombre,
        c.comprobante_proveedor,
        c.subtotal,
        c.iva,
        c.total,
        c.estado,
        u.nombre AS usuario_nombre,
        (SELECT COUNT(*) FROM compras_items ci WHERE ci.compra_id = c.id AND ci.deleted_at IS NULL) AS cantidad_items
       FROM compras c
       LEFT JOIN proveedores p ON p.id = c.proveedor_id
       INNER JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.comercio_id = ? AND c.deleted_at IS NULL
       ORDER BY c.fecha DESC
       LIMIT 500`
    )
    .all(actor.comercio_id) as unknown as Array<{
    id: string;
    fecha: string;
    proveedor_id: string;
    proveedor_nombre: string;
    comprobante_proveedor: string | null;
    subtotal: Centavos;
    iva: Centavos;
    total: Centavos;
    estado: 'registrada' | 'anulada';
    usuario_nombre: string;
    cantidad_items: number;
  }>;

  return filas.map((f) => ({
    ...f,
    numero_comprobante: f.comprobante_proveedor,
    total_centavos: f.total,
  }));
}

// ============================================================================
// 3. Clientes y Cuenta Corriente (PLAN.md §4, §7, §10)
// ============================================================================

export interface ClienteConSaldoFila {
  readonly id: string;
  readonly nombre: string;
  readonly cuit_dni: string | null;
  readonly documento: string | null;
  readonly condicion_iva: CondicionIvaReceptor;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly domicilio: string | null;
  readonly limite_credito: Centavos;
  readonly limite_credito_centavos: Centavos;
  readonly total_cargos_centavos: Centavos;
  readonly total_pagos_centavos: Centavos;
  readonly saldo_pendiente_centavos: Centavos;
  readonly credito_disponible_centavos: Centavos;
}

export interface MovimientoCuentaCorrienteFila {
  readonly id: string;
  readonly entidad_tipo: 'cliente' | 'proveedor';
  readonly entidad_id: string;
  readonly tipo: 'cargo' | 'pago';
  readonly monto: Centavos;
  readonly monto_centavos: Centavos;
  readonly referencia_id: string | null;
  readonly observaciones: string | null;
  readonly created_at: string;
  readonly fecha: string;
}

export function crearCliente(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    nombre: string;
    cuitDni?: string | null;
    documento?: string | null;
    condicionIva?: CondicionIvaReceptor;
    telefono?: string | null;
    email?: string | null;
    domicilio?: string | null;
    limiteCreditoCentavos?: Centavos;
  }
): string {
  exigirPermiso(actor.rol, 'vender_y_caja');
  const nombre = params.nombre.trim();
  if (!nombre) {
    throw new Error('El nombre del cliente es obligatorio.');
  }

  const docRaw = params.cuitDni ?? params.documento ?? '';
  const valDoc = validarCuitODniCliente(docRaw);
  if (!valDoc.valido) {
    throw new Error(valDoc.motivo ?? 'CUIT/DNI del cliente inválido.');
  }

  const limiteCredito = params.limiteCreditoCentavos ?? 0;
  exigirEnteroCentavos(limiteCredito, 'limiteCreditoCentavos');

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const id = generarUuidV7();
    const condicionIva = params.condicionIva ?? 'consumidor_final';

    db.prepare(
      `INSERT INTO clientes (
        id, comercio_id, nombre, cuit_dni, condicion_iva,
        telefono, email, domicilio, limite_credito,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      nombre,
      valDoc.valorFormateado || null,
      condicionIva,
      params.telefono?.trim() || null,
      params.email?.trim() || null,
      params.domicilio?.trim() || null,
      limiteCredito,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'clientes', id, 'insert', ahora);
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'cliente_crear',
      entidad: 'clientes',
      entidad_id: id,
      valores_despues: {
        id,
        nombre,
        cuit_dni: valDoc.valorFormateado || null,
        condicion_iva: condicionIva,
        limite_credito: limiteCredito,
      },
      ahoraIso: ahora,
    });

    return id;
  });
}

export function listarClientesConSaldo(
  db: DatabaseSync,
  comercioId: string
): ClienteConSaldoFila[] {
  const filas = db
    .prepare(
      `SELECT id, nombre, cuit_dni, condicion_iva, telefono, email, domicilio, limite_credito
       FROM clientes
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    nombre: string;
    cuit_dni: string | null;
    condicion_iva: CondicionIvaReceptor;
    telefono: string | null;
    email: string | null;
    domicilio: string | null;
    limite_credito: Centavos;
  }>;

  return filas.map((f) => {
    const estado = obtenerEstadoEntidadCuentaCorriente(
      db,
      comercioId,
      'cliente',
      f.id
    );
    const disponible =
      f.limite_credito > 0
        ? Math.max(0, f.limite_credito - estado.saldoPendienteCentavos)
        : 0;
    return {
      ...f,
      documento: f.cuit_dni,
      limite_credito_centavos: f.limite_credito,
      total_cargos_centavos: estado.totalCargosCentavos,
      total_pagos_centavos: estado.totalPagosCentavos,
      saldo_pendiente_centavos: estado.saldoPendienteCentavos,
      credito_disponible_centavos: disponible,
    };
  });
}

export function registrarMovimientoCuentaCorriente(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    entidadTipo: 'cliente' | 'proveedor';
    entidadId: string;
    tipo: 'cargo' | 'pago';
    montoCentavos: Centavos;
    referenciaId?: string | null;
    observaciones?: string | null;
  }
): {
  movimientoId: string;
  nuevoSaldoCentavos: Centavos;
} {
  exigirPermiso(actor.rol, 'vender_y_caja');
  exigirEnteroCentavos(params.montoCentavos, 'montoCentavos');
  if (params.montoCentavos <= 0) {
    throw new Error('El monto del movimiento debe ser mayor a $ 0,00.');
  }

  return ejecutarEnTransaccion(db, () => {
    const saldoActual = obtenerSaldoEntidadCuentaCorriente(
      db,
      actor.comercio_id,
      params.entidadTipo,
      params.entidadId
    );

    if (params.entidadTipo === 'cliente' && params.tipo === 'cargo') {
      const cli = db
        .prepare(
          `SELECT id, nombre, limite_credito FROM clientes
           WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
        )
        .get(params.entidadId, actor.comercio_id) as
        | { id: string; nombre: string; limite_credito: Centavos }
        | undefined;

      if (!cli) {
        throw new Error('Cliente no encontrado.');
      }

      const validacion = validarCargoCuentaCorrienteCliente({
        saldoActualCentavos: saldoActual,
        nuevoCargoCentavos: params.montoCentavos,
        limiteCreditoCentavos: cli.limite_credito,
      });

      if (!validacion.permitido) {
        throw new Error(validacion.motivo);
      }
    }

    const ahora = new Date().toISOString();
    const id = generarUuidV7();

    db.prepare(
      `INSERT INTO cuenta_corriente_movimientos (
        id, comercio_id, entidad_tipo, entidad_id, tipo, monto,
        referencia_id, observaciones, usuario_id,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      params.entidadTipo,
      params.entidadId,
      params.tipo,
      params.montoCentavos,
      params.referenciaId ?? null,
      params.observaciones?.trim() || null,
      actor.usuario_id,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSync(db, 'cuenta_corriente_movimientos', id, 'insert', ahora);
    insertarRegistroAuditoria(db, {
      actor,
      accion: `cuenta_corriente_${params.tipo}`,
      entidad: 'cuenta_corriente_movimientos',
      entidad_id: id,
      valores_despues: {
        entidad_tipo: params.entidadTipo,
        entidad_id: params.entidadId,
        tipo: params.tipo,
        monto: params.montoCentavos,
        observaciones: params.observaciones?.trim() || null,
      },
      ahoraIso: ahora,
    });

    const nuevoSaldo = obtenerSaldoEntidadCuentaCorriente(
      db,
      actor.comercio_id,
      params.entidadTipo,
      params.entidadId
    );

    return {
      movimientoId: id,
      nuevoSaldoCentavos: nuevoSaldo,
    };
  });
}

export function listarMovimientosCuentaCorriente(
  db: DatabaseSync,
  comercioId: string,
  entidadTipo: 'cliente' | 'proveedor',
  entidadId: string
): MovimientoCuentaCorrienteFila[] {
  const filas = db
    .prepare(
      `SELECT id, entidad_tipo, entidad_id, tipo, monto, referencia_id, observaciones, created_at
       FROM cuenta_corriente_movimientos
       WHERE comercio_id = ?
         AND entidad_tipo = ?
         AND entidad_id = ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(comercioId, entidadTipo, entidadId) as unknown as Array<{
    id: string;
    entidad_tipo: 'cliente' | 'proveedor';
    entidad_id: string;
    tipo: 'cargo' | 'pago';
    monto: Centavos;
    referencia_id: string | null;
    observaciones: string | null;
    created_at: string;
  }>;

  return filas.map((f) => ({
    ...f,
    monto_centavos: f.monto,
    fecha: f.created_at,
  }));
}

// ============================================================================
// 4. Actualización Masiva de Precios e Importación CSV (PLAN.md §8 y §10)
// ============================================================================

export function aplicarActualizacionMasivaPrecios(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    porcentajeVariacion?: number;
    porcentaje?: number;
    reglaRedondeo?: ReglaRedondeoPrecio;
    aplicarACostosTambien?: boolean;
    actualizarCostoCompraTambien?: boolean;
    categoriaId?: string | null;
    marcaId?: string | null;
    proveedorId?: string | null;
    motivo?: string;
  }
): {
  productosActualizados: number;
} {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  const porcentajeEfectivo =
    params.porcentajeVariacion ?? params.porcentaje ?? 0;
  const aplicarACostos =
    Boolean(params.aplicarACostosTambien) ||
    Boolean(params.actualizarCostoCompraTambien);

  const condiciones = [
    'p.comercio_id = ?',
    'p.deleted_at IS NULL',
    'p.activo = 1',
  ];
  const args: (string | number)[] = [actor.comercio_id];

  if (params.categoriaId) {
    condiciones.push('p.categoria_id = ?');
    args.push(params.categoriaId);
  }
  if (params.marcaId) {
    condiciones.push('p.marca_id = ?');
    args.push(params.marcaId);
  }
  if (params.proveedorId) {
    condiciones.push('p.proveedor_principal_id = ?');
    args.push(params.proveedorId);
  }

  return ejecutarEnTransaccion(db, () => {
    const productos = db
      .prepare(
        `SELECT p.id, p.nombre, p.costo_compra, pr.id AS precio_id, pr.precio_venta
         FROM productos p
         INNER JOIN listas_precio lp
           ON lp.comercio_id = p.comercio_id AND lp.es_predeterminada = 1 AND lp.deleted_at IS NULL
         INNER JOIN precios pr
           ON pr.producto_id = p.id AND pr.lista_precio_id = lp.id AND pr.deleted_at IS NULL
         WHERE ${condiciones.join(' AND ')}`
      )
      .all(...args) as unknown as Array<{
      id: string;
      nombre: string;
      costo_compra: Centavos;
      precio_id: string;
      precio_venta: Centavos;
    }>;

    const ahora = new Date().toISOString();
    const reglaRedondeo = params.reglaRedondeo ?? 'entero_peso';
    let actualizados = 0;

    for (const prod of productos) {
      const nuevoPrecio = calcularNuevoPrecioMasivo({
        precioActualCentavos: prod.precio_venta,
        porcentajeVariacion: porcentajeEfectivo,
        reglaRedondeo,
      });

      const nuevoCosto = aplicarACostos
        ? calcularNuevoPrecioMasivo({
            precioActualCentavos: prod.costo_compra,
            porcentajeVariacion: porcentajeEfectivo,
            reglaRedondeo: 'exacto_centavos',
          })
        : prod.costo_compra;

      const margenBp =
        nuevoCosto > 0
          ? Math.round(((nuevoPrecio - nuevoCosto) / nuevoCosto) * 10000)
          : null;

      db.prepare(
        `UPDATE precios
         SET precio_venta = ?, margen_bp = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
         WHERE id = ?`
      ).run(nuevoPrecio, margenBp, ahora, actor.device_id, prod.precio_id);
      encolarSync(db, 'precios', prod.precio_id, 'update', ahora);

      db.prepare(
        `UPDATE productos
         SET costo_compra = ?, fecha_ultimo_cambio_precio = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
         WHERE id = ?`
      ).run(nuevoCosto, ahora, ahora, actor.device_id, prod.id);
      encolarSync(db, 'productos', prod.id, 'update', ahora);

      actualizados++;
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'precios_actualizacion_masiva',
      entidad: 'precios',
      entidad_id: actor.comercio_id,
      valores_despues: {
        porcentaje_variacion: porcentajeEfectivo,
        regla_redondeo: reglaRedondeo,
        aplicar_a_costos: aplicarACostos,
        categoria_id: params.categoriaId ?? null,
        marca_id: params.marcaId ?? null,
        proveedor_id: params.proveedorId ?? null,
        productos_actualizados: actualizados,
      },
      motivo:
        params.motivo?.trim() ||
        `Actualización masiva de precios (${porcentajeEfectivo > 0 ? '+' : ''}${porcentajeEfectivo}%)`,
      ahoraIso: ahora,
    });

    return { productosActualizados: actualizados };
  });
}

export function importarProductosDesdeCsv(
  db: DatabaseSync,
  actor: ActorContexto,
  contenidoOPayload:
    | string
    | {
        contenidoCsv: string;
        actualizarSiExisteCodigo?: boolean;
      }
): {
  creados: number;
  actualizados: number;
  productosCreados: number;
  productosActualizados: number;
  errores: readonly string[];
} {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  const contenidoCsv =
    typeof contenidoOPayload === 'string'
      ? contenidoOPayload
      : contenidoOPayload.contenidoCsv;
  const actualizarExistentes =
    typeof contenidoOPayload === 'string'
      ? true
      : (contenidoOPayload.actualizarSiExisteCodigo ?? true);

  const parseo = parsearCsvImportacionCatalogo(contenidoCsv);
  if (parseo.filasValidas.length === 0) {
    return {
      creados: 0,
      actualizados: 0,
      productosCreados: 0,
      productosActualizados: 0,
      errores: parseo.errores,
    };
  }

  let creados = 0;
  let actualizados = 0;
  const erroresImportacion: string[] = [...parseo.errores];

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const listaDefault = db
      .prepare(
        `SELECT id FROM listas_precio
         WHERE comercio_id = ? AND es_predeterminada = 1 AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(actor.comercio_id) as { id: string } | undefined;

    for (const fila of parseo.filasValidas) {
      let categoriaId: string | null = null;
      if (fila.categoriaNombre) {
        categoriaId = crearCategoria(db, actor, {
          nombre: fila.categoriaNombre,
        });
      }

      let marcaId: string | null = null;
      if (fila.marcaNombre) {
        marcaId = crearMarca(db, actor, { nombre: fila.marcaNombre });
      }

      const codigoInternoLimpio = fila.codigoInterno?.trim() || undefined;
      const codigoBarrasLimpio = fila.codigoBarras?.trim() || undefined;

      // 1. Buscar producto existente por codigo_interno (activo o borrado lógicamente)
      let productoExistente = codigoInternoLimpio
        ? (db
            .prepare(
              `SELECT id, codigo_interno, nombre, deleted_at FROM productos
               WHERE comercio_id = ? AND lower(codigo_interno) = lower(?)
               ORDER BY deleted_at IS NOT NULL ASC
               LIMIT 1`
            )
            .get(actor.comercio_id, codigoInternoLimpio) as
            | {
                id: string;
                codigo_interno: string | null;
                nombre: string;
                deleted_at: string | null;
              }
            | undefined)
        : undefined;

      // 2. Verificar si el código de barras ya existe en codigos_barras para este comercio
      const barraExistente = codigoBarrasLimpio
        ? (db
            .prepare(
              `SELECT cb.id AS cb_id, cb.producto_id, cb.deleted_at AS cb_deleted_at,
                      p.codigo_interno AS prod_codigo_interno, p.nombre AS prod_nombre
               FROM codigos_barras cb
               INNER JOIN productos p ON p.id = cb.producto_id
               WHERE cb.comercio_id = ? AND cb.codigo = ?
               ORDER BY cb.deleted_at IS NOT NULL ASC
               LIMIT 1`
            )
            .get(actor.comercio_id, codigoBarrasLimpio) as
            | {
                cb_id: string;
                producto_id: string;
                cb_deleted_at: string | null;
                prod_codigo_interno: string | null;
                prod_nombre: string;
              }
            | undefined)
        : undefined;

      // Si no se encontró por codigo_interno pero el código de barras ya pertenece a un producto
      // (y la fila no trae un codigo_interno distinto al de ese producto), tratarlo como el mismo producto
      if (
        !productoExistente &&
        barraExistente &&
        (!codigoInternoLimpio ||
          !barraExistente.prod_codigo_interno ||
          barraExistente.prod_codigo_interno.toLowerCase() ===
            codigoInternoLimpio.toLowerCase())
      ) {
        productoExistente = {
          id: barraExistente.producto_id,
          codigo_interno: barraExistente.prod_codigo_interno,
          nombre: barraExistente.prod_nombre,
          deleted_at: null,
        };
      }

      if (productoExistente && listaDefault) {
        if (actualizarExistentes || productoExistente.deleted_at !== null) {
          db.prepare(
            `UPDATE productos
             SET nombre = ?,
                 codigo_interno = COALESCE(?, codigo_interno),
                 costo_compra = ?,
                 alicuota_iva = ?,
                 stock_minimo = ?,
                 categoria_id = COALESCE(?, categoria_id),
                 marca_id = COALESCE(?, marca_id),
                 activo = 1,
                 deleted_at = NULL,
                 fecha_ultimo_cambio_precio = ?,
                 updated_at = ?,
                 device_id = ?,
                 sync_status = 'pendiente'
             WHERE id = ?`
          ).run(
            fila.nombre,
            codigoInternoLimpio ?? null,
            fila.costoCompraCentavos,
            fila.alicuotaIva,
            fila.stockMinimo,
            categoriaId,
            marcaId,
            ahora,
            ahora,
            actor.device_id,
            productoExistente.id
          );
          encolarSync(db, 'productos', productoExistente.id, 'update', ahora);

          const precioRow = db
            .prepare(
              `SELECT id FROM precios
               WHERE comercio_id = ? AND producto_id = ? AND lista_precio_id = ? AND deleted_at IS NULL`
            )
            .get(
              actor.comercio_id,
              productoExistente.id,
              listaDefault.id
            ) as { id: string } | undefined;

          if (precioRow) {
            db.prepare(
              `UPDATE precios
               SET precio_venta = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
               WHERE id = ?`
            ).run(
              fila.precioVentaCentavos,
              ahora,
              actor.device_id,
              precioRow.id
            );
            encolarSync(db, 'precios', precioRow.id, 'update', ahora);
          } else {
            const nuevoPrecioId = generarUuidV7();
            db.prepare(
              `INSERT INTO precios (
                id, comercio_id, producto_id, lista_precio_id, precio_venta,
                created_at, updated_at, deleted_at, device_id, sync_status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
            ).run(
              nuevoPrecioId,
              actor.comercio_id,
              productoExistente.id,
              listaDefault.id,
              fila.precioVentaCentavos,
              ahora,
              ahora,
              actor.device_id
            );
            encolarSync(db, 'precios', nuevoPrecioId, 'insert', ahora);
          }

          // Asociar el código de barras si aún no estaba activo o pertenecía a este mismo producto
          if (codigoBarrasLimpio) {
            if (!barraExistente) {
              const nuevoCbId = generarUuidV7();
              db.prepare(
                `INSERT INTO codigos_barras (
                  id, comercio_id, producto_id, codigo,
                  created_at, updated_at, deleted_at, device_id, sync_status
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
              ).run(
                nuevoCbId,
                actor.comercio_id,
                productoExistente.id,
                codigoBarrasLimpio,
                ahora,
                ahora,
                actor.device_id
              );
              encolarSync(db, 'codigos_barras', nuevoCbId, 'insert', ahora);
            } else if (
              barraExistente.cb_deleted_at !== null ||
              barraExistente.producto_id === productoExistente.id
            ) {
              db.prepare(
                `UPDATE codigos_barras
                 SET producto_id = ?, deleted_at = NULL, updated_at = ?, device_id = ?, sync_status = 'pendiente'
                 WHERE id = ?`
              ).run(
                productoExistente.id,
                ahora,
                actor.device_id,
                barraExistente.cb_id
              );
              encolarSync(
                db,
                'codigos_barras',
                barraExistente.cb_id,
                'update',
                ahora
              );
            }
          }

          actualizados++;
        }
      } else if (!productoExistente) {
        // Si el código de barras ya está activo en otro producto distinto, importar el producto sin repetir el código de barras
        let codigosAInsertar: string[] = [];
        if (codigoBarrasLimpio) {
          if (barraExistente && barraExistente.cb_deleted_at === null) {
            erroresImportacion.push(
              `Fila ${fila.filaNumero} ("${fila.nombre}"): El código de barras "${codigoBarrasLimpio}" ya pertenece a "${barraExistente.prod_nombre}"; se creó el producto sin repetir el código de barras.`
            );
          } else {
            codigosAInsertar = [codigoBarrasLimpio];
          }
        }

        crearProducto(db, actor, {
          nombre: fila.nombre,
          codigoInterno: codigoInternoLimpio,
          categoriaId,
          marcaId,
          costoCompraCentavos: fila.costoCompraCentavos,
          precioVentaCentavos: fila.precioVentaCentavos,
          alicuotaIva: fila.alicuotaIva,
          stockMinimo: fila.stockMinimo,
          codigosBarras: codigosAInsertar,
          stockInicial: fila.stockInicial,
        });
        creados++;
      }
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'catalogo_importar_csv',
      entidad: 'productos',
      entidad_id: actor.comercio_id,
      valores_despues: {
        productos_creados: creados,
        productos_actualizados: actualizados,
        errores_count: erroresImportacion.length,
      },
      ahoraIso: ahora,
    });
  });

  return {
    creados,
    actualizados,
    productosCreados: creados,
    productosActualizados: actualizados,
    errores: erroresImportacion,
  };
}

// ============================================================================
// 5. Libro IVA Ventas y Libro IVA Compras (PLAN.md §7 y §10)
// ============================================================================

export interface ResumenLibroIvaConAlias extends ResumenLibroIva {
  readonly total_neto_gravado_centavos: Centavos;
  readonly total_iva_21_centavos: Centavos;
  readonly total_iva_105_centavos: Centavos;
  readonly total_iva_27_centavos: Centavos;
  readonly total_exento_centavos: Centavos;
  readonly total_general_centavos: Centavos;
}

export interface InformeLibroIvaCompleto {
  readonly ventas: ResumenLibroIvaConAlias;
  readonly compras: ResumenLibroIvaConAlias;
  readonly ivaVentas: ResumenLibroIvaConAlias;
  readonly ivaCompras: ResumenLibroIvaConAlias;
}

export type LibroIvaPeriodoResult = InformeLibroIvaCompleto;

function enriquecerResumenLibroIva(
  r: ResumenLibroIva
): ResumenLibroIvaConAlias {
  return {
    ...r,
    total_neto_gravado_centavos: r.totalNetoGravadoCentavos,
    total_iva_21_centavos: r.totalIva21Centavos,
    total_iva_105_centavos: r.totalIva105Centavos,
    total_iva_27_centavos: r.totalIva27Centavos,
    total_exento_centavos: r.totalExentoNoGravadoCentavos,
    total_general_centavos: r.totalGeneralCentavos,
  };
}

export function obtenerLibroIvaPeriodo(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    fechaDesdeIso?: string;
    fechaHastaIso?: string;
  } = {}
): InformeLibroIvaCompleto {
  exigirPermiso(actor.rol, 'ver_informes_gestion');

  const desde = params.fechaDesdeIso ?? '1970-01-01T00:00:00.000Z';
  const hasta = params.fechaHastaIso ?? '9999-12-31T23:59:59.999Z';

  // 1. Libro IVA Ventas (incluye ventas completadas y anuladas para trazabilidad, pero solo las completadas suman importe)
  const ventasRows = db
    .prepare(
      `SELECT
        v.id,
        v.fecha,
        v.estado,
        v.tipo_comprobante,
        v.punto_venta,
        v.numero_comprobante,
        COALESCE(c.nombre, 'Consumidor Final') AS cliente_nombre,
        COALESCE(c.cuit_dni, '-') AS cliente_doc
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.comercio_id = ?
         AND v.deleted_at IS NULL
         AND v.fecha >= ?
         AND v.fecha <= ?
       ORDER BY v.fecha ASC`
    )
    .all(actor.comercio_id, desde, hasta) as unknown as Array<{
    id: string;
    fecha: string;
    estado: 'completada' | 'anulada';
    tipo_comprobante: string;
    punto_venta: number | null;
    numero_comprobante: number | null;
    cliente_nombre: string;
    cliente_doc: string;
  }>;

  const filasIvaVentas: FilaLibroIva[] = ventasRows.map((v) => {
    const nro =
      v.punto_venta && v.numero_comprobante
        ? `${String(v.punto_venta).padStart(4, '0')}-${String(v.numero_comprobante).padStart(8, '0')}`
        : `#${v.id.slice(-8).toUpperCase()}`;

    if (v.estado === 'anulada') {
      return {
        id: v.id,
        fecha: v.fecha,
        tipoComprobante: `${v.tipo_comprobante} (ANULADA)`,
        numeroComprobante: nro,
        contraparteNombre: v.cliente_nombre,
        contraparteCuitDni: v.cliente_doc,
        netoGravadoCentavos: 0,
        iva105Centavos: 0,
        iva21Centavos: 0,
        iva27Centavos: 0,
        exentoNoGravadoCentavos: 0,
        totalCentavos: 0,
      };
    }

    const items = db
      .prepare(
        `SELECT subtotal, alicuota_iva, exento_iva
         FROM ventas_items
         WHERE venta_id = ? AND comercio_id = ?`
      )
      .all(v.id, actor.comercio_id) as unknown as Array<{
      subtotal: Centavos;
      alicuota_iva: AlicuotaIva;
      exento_iva: number;
    }>;

    return calcularFilaLibroIvaDesdeItems({
      id: v.id,
      fecha: v.fecha,
      tipoComprobante: v.tipo_comprobante,
      numeroComprobante: nro,
      contraparteNombre: v.cliente_nombre,
      contraparteCuitDni: v.cliente_doc,
      preciosIncluyenIva: true,
      items: items.map((it) => ({
        subtotalCentavos: it.subtotal,
        alicuotaIva: it.alicuota_iva,
        exentoIva: it.exento_iva === 1,
      })),
    });
  });

  // 2. Libro IVA Compras (compras registradas en el rango)
  const comprasRows = db
    .prepare(
      `SELECT
        c.id,
        c.fecha,
        c.comprobante_proveedor,
        c.subtotal,
        c.iva,
        c.total,
        p.nombre AS proveedor_nombre,
        COALESCE(p.cuit, '-') AS proveedor_cuit
       FROM compras c
       INNER JOIN proveedores p ON p.id = c.proveedor_id
       WHERE c.comercio_id = ?
         AND c.estado = 'registrada'
         AND c.deleted_at IS NULL
         AND c.fecha >= ?
         AND c.fecha <= ?
       ORDER BY c.fecha ASC`
    )
    .all(actor.comercio_id, desde, hasta) as unknown as Array<{
    id: string;
    fecha: string;
    comprobante_proveedor: string | null;
    subtotal: Centavos;
    iva: Centavos;
    total: Centavos;
    proveedor_nombre: string;
    proveedor_cuit: string;
  }>;

  const filasIvaCompras: FilaLibroIva[] = comprasRows.map((c) => ({
    id: c.id,
    fecha: c.fecha,
    tipoComprobante: 'factura_compra',
    numeroComprobante:
      c.comprobante_proveedor ?? `#${c.id.slice(-8).toUpperCase()}`,
    contraparteNombre: c.proveedor_nombre,
    contraparteCuitDni: c.proveedor_cuit,
    netoGravadoCentavos: c.subtotal,
    iva105Centavos: 0,
    iva21Centavos: c.iva,
    iva27Centavos: 0,
    exentoNoGravadoCentavos: 0,
    totalCentavos: c.total,
  }));

  const ventas = enriquecerResumenLibroIva(
    consolidarResumenLibroIva(filasIvaVentas)
  );
  const compras = enriquecerResumenLibroIva(
    consolidarResumenLibroIva(filasIvaCompras)
  );

  return {
    ventas,
    compras,
    ivaVentas: ventas,
    ivaCompras: compras,
  };
}

export function exportarLibroIvaAXlsx(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    fechaDesdeIso?: string;
    fechaHastaIso?: string;
  } = {}
): {
  xlsxBytes: Uint8Array;
  libroIva: InformeLibroIvaCompleto;
  libro: InformeLibroIvaCompleto;
} {
  const libroIva = obtenerLibroIvaPeriodo(db, actor, params);

  const construirFilasHoja = (resumen: ResumenLibroIva) => [
    ...resumen.filas.map((f) => [
      formatearFechaAR(f.fecha),
      f.tipoComprobante,
      f.numeroComprobante,
      f.contraparteNombre,
      f.contraparteCuitDni,
      f.netoGravadoCentavos / 100,
      f.iva105Centavos / 100,
      f.iva21Centavos / 100,
      f.iva27Centavos / 100,
      f.exentoNoGravadoCentavos / 100,
      f.totalCentavos / 100,
    ]),
    [
      'TOTALES DEL PERÍODO',
      '',
      '',
      '',
      '',
      resumen.totalNetoGravadoCentavos / 100,
      resumen.totalIva105Centavos / 100,
      resumen.totalIva21Centavos / 100,
      resumen.totalIva27Centavos / 100,
      resumen.totalExentoNoGravadoCentavos / 100,
      resumen.totalGeneralCentavos / 100,
    ],
  ];

  const xlsxBytes = generarLibroXlsx([
    {
      nombre: 'Libro IVA Ventas',
      encabezados: [
        'Fecha',
        'Comprobante',
        'Numero',
        'Cliente',
        'CUIT / DNI',
        'Neto Gravado ($)',
        'IVA 10,5% ($)',
        'IVA 21% ($)',
        'IVA 27% ($)',
        'Exento / No Gravado ($)',
        'Total ($)',
      ],
      filas: construirFilasHoja(libroIva.ventas),
    },
    {
      nombre: 'Libro IVA Compras',
      encabezados: [
        'Fecha',
        'Comprobante',
        'Numero',
        'Proveedor',
        'CUIT / DNI',
        'Neto Gravado ($)',
        'IVA 10,5% ($)',
        'IVA 21% ($)',
        'IVA 27% ($)',
        'Exento / No Gravado ($)',
        'Total ($)',
      ],
      filas: construirFilasHoja(libroIva.compras),
    },
  ]);

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'informe_exportar_libro_iva',
      entidad: 'informes',
      entidad_id: actor.comercio_id,
      valores_despues: {
        fecha_desde: params.fechaDesdeIso ?? null,
        fecha_hasta: params.fechaHastaIso ?? null,
        filas_iva_ventas: libroIva.ventas.filas.length,
        filas_iva_compras: libroIva.compras.filas.length,
      },
      ahoraIso: ahora,
    });
  });

  return {
    xlsxBytes,
    libroIva,
    libro: libroIva,
  };
}

// ============================================================================
// 6. Salida ESC/POS desde Venta en SQLite (Regla 20: nunca incluye costos)
// ============================================================================

export function generarTicketEscPosDeVentaDb(
  db: DatabaseSync,
  comercioId: string,
  ventaOPayload: string | { ventaId: string; anchoMm?: 58 | 80 },
  anchoPapel: AnchoPapelTermico = '80mm'
): {
  bytesBase64: string;
  comandosEscPosBase64: string;
  textoImpresora: string;
  textoPlano: string;
  columnas: number;
  anchoCaracteres: number;
} {
  const ventaId =
    typeof ventaOPayload === 'string' ? ventaOPayload : ventaOPayload.ventaId;
  const anchoEfectivo: AnchoPapelTermico =
    typeof ventaOPayload === 'string'
      ? anchoPapel
      : ventaOPayload.anchoMm === 58
        ? '58mm'
        : '80mm';

  const datosSeguros = obtenerDatosTicketDeVentaDb(db, comercioId, ventaId);
  const escpos = generarComandosEscPosTicket(datosSeguros, anchoEfectivo);
  const base64 = Buffer.from(escpos.bytes).toString('base64');

  return {
    bytesBase64: base64,
    comandosEscPosBase64: base64,
    textoImpresora: escpos.textoImpresora,
    textoPlano: escpos.textoImpresora,
    columnas: escpos.columnas,
    anchoCaracteres: escpos.columnas,
  };
}
