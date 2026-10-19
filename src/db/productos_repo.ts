/**
 * Repositorio de gestión de productos, múltiples códigos de barras, cambios de precio/costo,
 * borrado lógico y consultas seguras para la pantalla de venta y tickets (PLAN.md §3 regla 20, §4, §6.1, §9).
 */

import type { DatabaseSync } from 'node:sqlite';
import { asegurarCentavos, type Centavos } from '../domain/dinero.ts';
import { exigirPermiso } from '../domain/permisos.ts';
import {
  construirDatosTicketSeguro,
  type DatosTicketNoFiscal,
} from '../domain/ticket.ts';
import {
  proyectarProductoParaVenta,
  type AlicuotaIva,
  type MedioPago,
} from '../domain/totales.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  ejecutarEnTransaccion,
  insertarRegistroAuditoria,
  type ActorContexto,
} from './repositorios.ts';

function encolarSyncProducto(
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
 * Actualiza un producto y/o su precio de venta o costo de compra en una transacción auditada (PLAN.md §6.1).
 * Si cambia el precio de venta o el costo de compra, actualiza fecha_ultimo_cambio_precio y registra el cambio.
 */
export function actualizarProductoYPrecio(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    productoId: string;
    nombre?: string;
    codigoInterno?: string | null;
    costoCompraCentavos?: Centavos;
    precioVentaCentavos?: Centavos;
    alicuotaIva?: AlicuotaIva;
    exentoIva?: boolean;
    stockMinimo?: number;
    botonRapido?: boolean;
    activo?: boolean;
    motivo?: string;
  }
): void {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  if (params.costoCompraCentavos !== undefined) {
    asegurarCentavos(params.costoCompraCentavos, 'costoCompraCentavos');
  }
  if (params.precioVentaCentavos !== undefined) {
    asegurarCentavos(params.precioVentaCentavos, 'precioVentaCentavos');
  }

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();

    const actual = db
      .prepare(
        `SELECT
          p.id, p.nombre, p.codigo_interno, p.costo_compra, p.alicuota_iva,
          p.exento_iva, p.stock_minimo, p.boton_rapido, p.activo,
          p.fecha_ultimo_cambio_precio,
          pr.id AS precio_id, pr.precio_venta
         FROM productos p
         LEFT JOIN listas_precio lp
           ON lp.comercio_id = p.comercio_id AND lp.es_predeterminada = 1 AND lp.deleted_at IS NULL
         LEFT JOIN precios pr
           ON pr.producto_id = p.id AND pr.lista_precio_id = lp.id AND pr.deleted_at IS NULL
         WHERE p.id = ? AND p.comercio_id = ? AND p.deleted_at IS NULL`
      )
      .get(params.productoId, actor.comercio_id) as
      | {
          id: string;
          nombre: string;
          codigo_interno: string | null;
          costo_compra: Centavos;
          alicuota_iva: AlicuotaIva;
          exento_iva: number;
          stock_minimo: number;
          boton_rapido: number;
          activo: number;
          fecha_ultimo_cambio_precio: string | null;
          precio_id: string | null;
          precio_venta: Centavos | null;
        }
      | undefined;

    if (!actual) {
      throw new Error('Producto no encontrado.');
    }

    const nuevoNombre = params.nombre?.trim() ?? actual.nombre;
    const nuevoCodigoInterno =
      params.codigoInterno !== undefined
        ? params.codigoInterno
        : actual.codigo_interno;
    const nuevoCosto = params.costoCompraCentavos ?? actual.costo_compra;
    const nuevoPrecio =
      params.precioVentaCentavos ?? actual.precio_venta ?? 0;
    const nuevaAlicuota = params.alicuotaIva ?? actual.alicuota_iva;
    const nuevoExento =
      params.exentoIva !== undefined
        ? params.exentoIva
          ? 1
          : 0
        : actual.exento_iva;
    const nuevoStockMin = params.stockMinimo ?? actual.stock_minimo;
    const nuevoBotonRapido =
      params.botonRapido !== undefined
        ? params.botonRapido
          ? 1
          : 0
        : actual.boton_rapido;
    const nuevoActivo =
      params.activo !== undefined ? (params.activo ? 1 : 0) : actual.activo;

    const cambioPrecioOCosto =
      nuevoCosto !== actual.costo_compra || nuevoPrecio !== actual.precio_venta;
    const fechaCambioPrecio = cambioPrecioOCosto
      ? ahora
      : actual.fecha_ultimo_cambio_precio;

    db.prepare(
      `UPDATE productos
       SET nombre = ?,
           codigo_interno = ?,
           costo_compra = ?,
           alicuota_iva = ?,
           exento_iva = ?,
           stock_minimo = ?,
           boton_rapido = ?,
           activo = ?,
           fecha_ultimo_cambio_precio = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      nuevoNombre,
      nuevoCodigoInterno,
      nuevoCosto,
      nuevaAlicuota,
      nuevoExento,
      nuevoStockMin,
      nuevoBotonRapido,
      nuevoActivo,
      fechaCambioPrecio,
      ahora,
      actor.device_id,
      params.productoId,
      actor.comercio_id
    );
    encolarSyncProducto(db, 'productos', params.productoId, 'update', ahora);

    if (actual.precio_id && params.precioVentaCentavos !== undefined) {
      db.prepare(
        `UPDATE precios
         SET precio_venta = ?,
             updated_at = ?,
             device_id = ?,
             sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(
        nuevoPrecio,
        ahora,
        actor.device_id,
        actual.precio_id,
        actor.comercio_id
      );
      encolarSyncProducto(db, 'precios', actual.precio_id, 'update', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: cambioPrecioOCosto ? 'precio_costo_cambiar' : 'producto_editar',
      entidad: 'productos',
      entidad_id: params.productoId,
      valores_antes: {
        nombre: actual.nombre,
        costo_compra: actual.costo_compra,
        precio_venta: actual.precio_venta,
        activo: actual.activo,
      },
      valores_despues: {
        nombre: nuevoNombre,
        costo_compra: nuevoCosto,
        precio_venta: nuevoPrecio,
        activo: nuevoActivo,
      },
      motivo: params.motivo ?? null,
      ahoraIso: ahora,
    });
  });
}

/**
 * Asocia un código de barras adicional a un producto existente (PLAN.md §4: un producto puede tener varios códigos).
 */
export function agregarCodigoBarrasProducto(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    productoId: string;
    codigo: string;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const codigoLimpio = params.codigo.trim();
  if (!codigoLimpio) {
    throw new Error('El código de barras no puede estar vacío.');
  }

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const cbId = generarUuidV7();

    db.prepare(
      `INSERT INTO codigos_barras (
        id, comercio_id, producto_id, codigo,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      cbId,
      actor.comercio_id,
      params.productoId,
      codigoLimpio,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSyncProducto(db, 'codigos_barras', cbId, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'codigo_barras_agregar',
      entidad: 'codigos_barras',
      entidad_id: cbId,
      valores_despues: {
        producto_id: params.productoId,
        codigo: codigoLimpio,
      },
      ahoraIso: ahora,
    });

    return cbId;
  });
}

/**
 * Borrado lógico (deleted_at) de un producto maestro (Regla 5 y PLAN.md §5.1).
 * Nunca hace DELETE físico ni elimina el archivo de imagen local.
 */
export function eliminarProductoLogico(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    productoId: string;
    motivo?: string;
  }
): void {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const prod = db
      .prepare(
        `SELECT id, nombre, imagen_path FROM productos
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.productoId, actor.comercio_id) as
      | { id: string; nombre: string; imagen_path: string | null }
      | undefined;

    if (!prod) {
      throw new Error('Producto no encontrado o ya dado de baja.');
    }

    db.prepare(
      `UPDATE productos
       SET deleted_at = ?,
           activo = 0,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      ahora,
      ahora,
      actor.device_id,
      params.productoId,
      actor.comercio_id
    );

    encolarSyncProducto(
      db,
      'productos',
      params.productoId,
      'delete_logico',
      ahora
    );

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'producto_baja_logica',
      entidad: 'productos',
      entidad_id: params.productoId,
      valores_antes: { nombre: prod.nombre, deleted_at: null },
      valores_despues: { nombre: prod.nombre, deleted_at: ahora },
      motivo: params.motivo ?? 'Baja lógica de producto',
      ahoraIso: ahora,
    });
  });
}

/**
 * Busca productos activos para la pantalla de venta por nombre, código interno, código de barras
 * o listado de botones rápidos, NUNCA devolviendo costo_compra (Regla 20).
 */
export function buscarProductosParaMostrador(
  db: DatabaseSync,
  comercioId: string,
  opciones: {
    textoBusqueda?: string;
    soloBotonesRapidos?: boolean;
  } = {}
): Array<{
  id: string;
  nombre: string;
  codigo_interno: string | null;
  unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
  permite_decimales: number;
  alicuota_iva: AlicuotaIva;
  exento_iva: number;
  boton_rapido: number;
  imagen_path: string | null;
  precio_venta: Centavos;
}> {
  const condiciones: string[] = ['v.comercio_id = ?', 'v.activo = 1'];
  const params: Array<string | number> = [comercioId];

  if (opciones.soloBotonesRapidos) {
    condiciones.push('v.boton_rapido = 1');
  }

  if (opciones.textoBusqueda && opciones.textoBusqueda.trim().length > 0) {
    const patron = `%${opciones.textoBusqueda.trim()}%`;
    condiciones.push(
      `(v.nombre LIKE ? OR v.codigo_interno LIKE ? OR EXISTS (
        SELECT 1 FROM codigos_barras cb
        WHERE cb.producto_id = v.id
          AND cb.comercio_id = v.comercio_id
          AND cb.deleted_at IS NULL
          AND cb.codigo LIKE ?
      ))`
    );
    params.push(patron, patron, patron);
  }

  const filas = db
    .prepare(
      `SELECT
        v.id,
        v.nombre,
        v.codigo_interno,
        v.unidad,
        v.permite_decimales,
        v.alicuota_iva,
        v.exento_iva,
        v.boton_rapido,
        v.imagen_path,
        COALESCE(v.precio_venta, 0) AS precio_venta
       FROM vista_productos_venta v
       WHERE ${condiciones.join(' AND ')}
       ORDER BY v.nombre ASC
       LIMIT 50`
    )
    .all(...params) as unknown as Array<{
    id: string;
    nombre: string;
    codigo_interno: string | null;
    unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
    permite_decimales: number;
    alicuota_iva: AlicuotaIva;
    exento_iva: number;
    boton_rapido: number;
    imagen_path: string | null;
    precio_venta: Centavos;
  }>;

  return filas.map((f) => proyectarProductoParaVenta(f));
}

/**
 * Obtiene los datos de un ticket de venta desde SQLite asegurando que jamás se incluya costo_unitario ni costo_compra (Regla 20).
 */
export function obtenerDatosTicketDeVentaDb(
  db: DatabaseSync,
  comercioId: string,
  ventaId: string
): DatosTicketNoFiscal {
  const cabecera = db
    .prepare(
      `SELECT
        v.id,
        v.fecha,
        v.subtotal,
        v.descuento,
        v.total,
        c.nombre AS comercio_nombre,
        c.cuit AS comercio_cuit,
        c.domicilio AS comercio_domicilio,
        c.condicion_iva AS comercio_condicion_iva,
        u.nombre AS cajero_nombre,
        cl.nombre AS cliente_nombre
       FROM ventas v
       INNER JOIN comercios c ON c.id = v.comercio_id
       INNER JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN clientes cl ON cl.id = v.cliente_id
       WHERE v.id = ? AND v.comercio_id = ? AND v.deleted_at IS NULL`
    )
    .get(ventaId, comercioId) as
    | {
        id: string;
        fecha: string;
        subtotal: Centavos;
        descuento: Centavos;
        total: Centavos;
        comercio_nombre: string;
        comercio_cuit: string | null;
        comercio_domicilio: string | null;
        comercio_condicion_iva: string;
        cajero_nombre: string;
        cliente_nombre: string | null;
      }
    | undefined;

  if (!cabecera) {
    throw new Error('Venta no encontrada para generar el ticket.');
  }

  // Notar que la consulta SQL a ventas_items ni siquiera selecciona la columna costo_unitario (Regla 20)
  const items = db
    .prepare(
      `SELECT
        producto_id,
        descripcion,
        cantidad,
        precio_unitario,
        descuento,
        subtotal,
        alicuota_iva,
        exento_iva
       FROM ventas_items
       WHERE venta_id = ? AND comercio_id = ? AND deleted_at IS NULL
       ORDER BY rowid ASC`
    )
    .all(ventaId, comercioId) as unknown as Array<{
    producto_id: string;
    descripcion: string;
    cantidad: number;
    precio_unitario: Centavos;
    descuento: Centavos;
    subtotal: Centavos;
    alicuota_iva: AlicuotaIva;
    exento_iva: number;
  }>;

  const pagos = db
    .prepare(
      `SELECT medio, monto
       FROM ventas_pagos
       WHERE venta_id = ? AND comercio_id = ? AND deleted_at IS NULL
       ORDER BY rowid ASC`
    )
    .all(ventaId, comercioId) as unknown as Array<{
    medio: MedioPago;
    monto: Centavos;
  }>;

  return construirDatosTicketSeguro({
    comercioNombre: cabecera.comercio_nombre,
    comercioCuit: cabecera.comercio_cuit,
    comercioDomicilio: cabecera.comercio_domicilio,
    comercioCondicionIva: cabecera.comercio_condicion_iva,
    ventaId: cabecera.id,
    fechaIso: cabecera.fecha,
    cajeroNombre: cabecera.cajero_nombre,
    clienteNombre: cabecera.cliente_nombre,
    items: items.map((it) => ({
      producto_id: it.producto_id,
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precio_unitario: it.precio_unitario,
      descuento: it.descuento,
      subtotal: it.subtotal,
      alicuota_iva: it.alicuota_iva,
      exento_iva: it.exento_iva === 1,
    })),
    subtotal: cabecera.subtotal,
    descuentoGlobal: cabecera.descuento,
    total: cabecera.total,
    pagos,
  });
}
