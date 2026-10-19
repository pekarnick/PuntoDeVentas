/**
 * Lógica pura de stock (PLAN.md §3 regla 4 y §4).
 * El stock NUNCA es un campo editable: es siempre la suma de movimientos_stock.
 */

import { aMiliunidades, desdeMiliunidades } from './cantidades.ts';

export type TipoMovimientoStock =
  | 'compra'
  | 'venta'
  | 'anulacion_venta'
  | 'ajuste'
  | 'devolucion'
  | 'merma';

export interface MovimientoStockItem {
  readonly id?: string;
  readonly producto_id: string;
  readonly tipo: TipoMovimientoStock;
  readonly cantidad: number;
  readonly motivo?: string | null;
  readonly deleted_at?: string | null;
}

/**
 * Normaliza y valida el signo de un movimiento de stock según su tipo.
 */
export function normalizarMovimientoStock(input: {
  tipo: TipoMovimientoStock;
  cantidad: number;
  motivo?: string | null;
}): number {
  const mili = aMiliunidades(input.cantidad);
  if (mili === 0) {
    throw new Error('La cantidad del movimiento de stock no puede ser cero.');
  }

  switch (input.tipo) {
    case 'compra':
    case 'anulacion_venta':
    case 'devolucion':
      return desdeMiliunidades(Math.abs(mili));

    case 'venta':
      return desdeMiliunidades(-Math.abs(mili));

    case 'merma':
      if (!input.motivo || input.motivo.trim().length === 0) {
        throw new Error('Los movimientos por merma requieren un motivo obligatorio.');
      }
      return desdeMiliunidades(-Math.abs(mili));

    case 'ajuste':
      if (!input.motivo || input.motivo.trim().length === 0) {
        throw new Error('Los ajustes de stock requieren un motivo obligatorio.');
      }
      return desdeMiliunidades(mili);
  }
}

export function calcularStockActual(
  movimientos: readonly Pick<MovimientoStockItem, 'cantidad' | 'deleted_at'>[]
): number {
  let totalMili = 0;
  for (const mov of movimientos) {
    if (mov.deleted_at) continue;
    totalMili += aMiliunidades(mov.cantidad);
  }
  return desdeMiliunidades(totalMili);
}

export function calcularStockPorProducto(
  movimientos: readonly Pick<
    MovimientoStockItem,
    'producto_id' | 'cantidad' | 'deleted_at'
  >[]
): Record<string, number> {
  const acumuladoMili: Record<string, number> = {};
  for (const mov of movimientos) {
    if (mov.deleted_at) continue;
    acumuladoMili[mov.producto_id] =
      (acumuladoMili[mov.producto_id] ?? 0) + aMiliunidades(mov.cantidad);
  }

  const resultado: Record<string, number> = {};
  for (const [productoId, mili] of Object.entries(acumuladoMili)) {
    resultado[productoId] = desdeMiliunidades(mili);
  }
  return resultado;
}

export function estaBajoStockMinimo(
  stockActual: number,
  stockMinimo: number
): boolean {
  return aMiliunidades(stockActual) <= aMiliunidades(stockMinimo);
}
