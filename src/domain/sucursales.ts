/**
 * Lógica pura de dominio para Administración de Sucursales, Stock por Ubicación
 * y Transferencias / Migración de Mercadería entre Sucursales (PLAN.md §3 Regla 4, §4 y §6).
 */

import { aMiliunidades, desdeMiliunidades } from './cantidades.ts';

export interface SucursalDominio {
  readonly id: string;
  readonly nombre: string;
  readonly codigo: string | null;
  readonly direccion: string | null;
  readonly telefono: string | null;
  readonly es_principal: boolean;
  readonly activo: boolean;
}

export interface MovimientoStockSucursalInput {
  readonly producto_id: string;
  readonly sucursal_id: string | null;
  readonly cantidad: number;
  readonly deleted_at?: string | null;
}

export interface StockUbicacionSucursal {
  readonly sucursal_id: string;
  readonly sucursal_nombre: string;
  readonly sucursal_codigo: string | null;
  readonly es_principal: boolean;
  readonly stock_actual: number;
}

export interface ResumenStockMultiSucursalProducto {
  readonly producto_id: string;
  readonly stock_global_comercio: number;
  readonly por_sucursal: Readonly<Record<string, number>>;
  readonly detalle_ubicaciones: readonly StockUbicacionSucursal[];
}

export interface ItemTransferenciaSucursalInput {
  readonly productoId: string;
  readonly nombreProducto?: string;
  readonly cantidad: number;
  readonly stockDisponibleOrigen: number;
}

/**
 * Calcula el stock exacto de cada producto en cada sucursal del comercio a partir de
 * los movimientos append-only (`movimientos_stock`).
 * Los movimientos históricos con `sucursal_id === null` se imputan automáticamente
 * a la sucursal principal (`es_principal = true`).
 */
export function calcularMapaStockPorSucursal(params: {
  readonly sucursales: readonly SucursalDominio[];
  readonly movimientos: readonly MovimientoStockSucursalInput[];
  readonly productosIds?: readonly string[];
}): ReadonlyMap<string, ResumenStockMultiSucursalProducto> {
  const sucursalesActivas = params.sucursales;
  const sucursalPrincipal =
    sucursalesActivas.find((s) => s.es_principal) ?? sucursalesActivas[0];
  const idPrincipal = sucursalPrincipal?.id ?? 'principal';

  const miliPorProdYSucursal = new Map<string, Map<string, number>>();
  const miliGlobalPorProd = new Map<string, number>();

  const asegurarProducto = (prodId: string) => {
    if (!miliPorProdYSucursal.has(prodId)) {
      const mapaSuc = new Map<string, number>();
      for (const s of sucursalesActivas) {
        mapaSuc.set(s.id, 0);
      }
      miliPorProdYSucursal.set(prodId, mapaSuc);
    }
    if (!miliGlobalPorProd.has(prodId)) {
      miliGlobalPorProd.set(prodId, 0);
    }
  };

  for (const prodId of params.productosIds ?? []) {
    asegurarProducto(prodId);
  }

  for (const mov of params.movimientos) {
    if (mov.deleted_at !== undefined && mov.deleted_at !== null) {
      continue;
    }
    asegurarProducto(mov.producto_id);
    const cantMili = aMiliunidades(mov.cantidad);
    const sucIdEfectiva =
      mov.sucursal_id &&
      sucursalesActivas.some((s) => s.id === mov.sucursal_id)
        ? mov.sucursal_id
        : idPrincipal;

    const mapaSuc = miliPorProdYSucursal.get(mov.producto_id)!;
    mapaSuc.set(sucIdEfectiva, (mapaSuc.get(sucIdEfectiva) ?? 0) + cantMili);
    miliGlobalPorProd.set(
      mov.producto_id,
      (miliGlobalPorProd.get(mov.producto_id) ?? 0) + cantMili
    );
  }

  const resultado = new Map<string, ResumenStockMultiSucursalProducto>();

  for (const [prodId, mapaSuc] of miliPorProdYSucursal.entries()) {
    const porSucursalRecord: Record<string, number> = {};
    const detalleUbicaciones: StockUbicacionSucursal[] = [];

    for (const suc of sucursalesActivas) {
      const stockSuc = desdeMiliunidades(mapaSuc.get(suc.id) ?? 0);
      porSucursalRecord[suc.id] = stockSuc;
      detalleUbicaciones.push({
        sucursal_id: suc.id,
        sucursal_nombre: suc.nombre,
        sucursal_codigo: suc.codigo,
        es_principal: suc.es_principal,
        stock_actual: stockSuc,
      });
    }

    resultado.set(prodId, {
      producto_id: prodId,
      stock_global_comercio: desdeMiliunidades(
        miliGlobalPorProd.get(prodId) ?? 0
      ),
      por_sucursal: porSucursalRecord,
      detalle_ubicaciones: detalleUbicaciones,
    });
  }

  return resultado;
}

/**
 * Valida una solicitud de transferencia / migración de mercadería entre dos sucursales.
 */
export function validarTransferenciaEntreSucursales(params: {
  readonly sucursalOrigenId: string;
  readonly sucursalDestinoId: string;
  readonly motivo: string;
  readonly items: readonly ItemTransferenciaSucursalInput[];
}): { readonly itemsNormalizados: ReadonlyArray<{ productoId: string; cantidad: number }>; readonly totalUnidades: number } {
  if (!params.sucursalOrigenId || !params.sucursalDestinoId) {
    throw new Error('Debés seleccionar la sucursal de origen y la sucursal de destino.');
  }
  if (params.sucursalOrigenId === params.sucursalDestinoId) {
    throw new Error(
      'SUCURSAL_IGUAL: La sucursal de origen y la de destino deben ser distintas.'
    );
  }
  if (!params.motivo || params.motivo.trim().length === 0) {
    throw new Error(
      'El motivo de la transferencia entre sucursales es obligatorio.'
    );
  }
  if (params.items.length === 0) {
    throw new Error(
      'Debés incluir al menos un producto para transferir entre sucursales.'
    );
  }

  let totalMili = 0;
  const itemsNormalizados: Array<{ productoId: string; cantidad: number }> = [];

  for (const item of params.items) {
    if (!Number.isFinite(item.cantidad) || item.cantidad <= 0) {
      throw new Error(
        `La cantidad a transferir de "${item.nombreProducto ?? item.productoId}" debe ser mayor a cero.`
      );
    }
    const cantMili = aMiliunidades(item.cantidad);
    const dispMili = aMiliunidades(item.stockDisponibleOrigen);
    if (cantMili > dispMili) {
      throw new Error(
        `STOCK_INSUFICIENTE_SUCURSAL: "${item.nombreProducto ?? item.productoId}" tiene ${item.stockDisponibleOrigen} en la sucursal de origen y se intentó transferir ${item.cantidad}.`
      );
    }

    totalMili += cantMili;
    itemsNormalizados.push({
      productoId: item.productoId,
      cantidad: desdeMiliunidades(cantMili),
    });
  }

  return {
    itemsNormalizados,
    totalUnidades: desdeMiliunidades(totalMili),
  };
}
