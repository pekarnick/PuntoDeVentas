/**
 * Lógica pura de totales de venta, IVA argentino, ganancia histórica, pagos mixtos y arqueo de caja.
 * Todos los importes monetarios están expresados en centavos enteros (Regla 2).
 */

import { aMiliunidades } from './cantidades.ts';
import { asegurarCentavos, type Centavos } from './dinero.ts';

export type AlicuotaIva = 0 | 10.5 | 21 | 27;

export const ALICUOTAS_IVA_VALIDAS: readonly AlicuotaIva[] = [
  0,
  10.5,
  21,
  27,
] as const;

export function desglosarIvaPorItem(
  subtotalCentavos: Centavos,
  alicuotaIva: AlicuotaIva,
  exentoIva: boolean,
  preciosIncluyenIva = true
): { neto: Centavos; iva: Centavos; total: Centavos } {
  asegurarCentavos(subtotalCentavos, 'subtotalCentavos');
  if (exentoIva || alicuotaIva === 0) {
    return {
      neto: subtotalCentavos,
      iva: 0,
      total: subtotalCentavos,
    };
  }
  if (preciosIncluyenIva) {
    const neto = Math.round(subtotalCentavos / (1 + alicuotaIva / 100));
    const iva = subtotalCentavos - neto;
    return { neto, iva, total: subtotalCentavos };
  }
  const neto = subtotalCentavos;
  const iva = Math.round((subtotalCentavos * alicuotaIva) / 100);
  return { neto, iva, total: neto + iva };
}

export type MedioPago =
  | 'efectivo'
  | 'transferencia'
  | 'mercado_pago'
  | 'qr'
  | 'debito'
  | 'credito'
  | 'cuenta_corriente'
  | 'otro';

export interface ItemVentaInput {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precio_unitario: Centavos;
  readonly costo_unitario: Centavos;
  readonly descuento?: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva?: boolean;
}

export interface ItemVentaCalculado {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precio_unitario: Centavos;
  readonly costo_unitario: Centavos;
  readonly bruto: Centavos;
  readonly descuento: Centavos;
  readonly subtotal: Centavos;
  readonly costo_total: Centavos;
  readonly ganancia_bruta: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva: boolean;
  readonly neto_sin_iva: Centavos;
  readonly monto_iva: Centavos;
}

export interface DesgloseIva {
  readonly alicuota: AlicuotaIva | 'exento';
  readonly neto: Centavos;
  readonly iva: Centavos;
  readonly total: Centavos;
}

export interface ResumenVentaCalculado {
  readonly items: readonly ItemVentaCalculado[];
  readonly subtotal: Centavos;
  readonly descuento_global: Centavos;
  readonly total: Centavos;
  readonly costo_total: Centavos;
  readonly ganancia_bruta: Centavos;
  readonly margen_porcentaje: number;
  readonly desglose_iva: readonly DesgloseIva[];
}

export interface PagoVentaInput {
  readonly medio: MedioPago;
  readonly monto: Centavos;
}

/**
 * Calcula un ítem de venta con redondeo exacto al centavo más cercano.
 */
export function calcularItemVenta(
  item: ItemVentaInput,
  preciosIncluyenIva = true
): ItemVentaCalculado {
  asegurarCentavos(item.precio_unitario, 'precio_unitario');
  asegurarCentavos(item.costo_unitario, 'costo_unitario');
  const descuento = item.descuento ?? 0;
  asegurarCentavos(descuento, 'descuento');

  if (item.precio_unitario < 0 || item.costo_unitario < 0 || descuento < 0) {
    throw new Error('Los importes del ítem no pueden ser negativos.');
  }

  const cantidadMili = aMiliunidades(item.cantidad);
  if (cantidadMili <= 0) {
    throw new Error('La cantidad del ítem debe ser mayor a cero.');
  }

  const bruto = Math.round((cantidadMili * item.precio_unitario) / 1000);
  if (descuento > bruto) {
    throw new Error('El descuento del ítem no puede superar su importe bruto.');
  }

  const subtotal = bruto - descuento;
  const costoTotal = Math.round((cantidadMili * item.costo_unitario) / 1000);
  const exento = Boolean(item.exento_iva);

  let netoSinIva = subtotal;
  let montoIva = 0;

  if (!exento && item.alicuota_iva > 0) {
    if (preciosIncluyenIva) {
      netoSinIva = Math.round(subtotal / (1 + item.alicuota_iva / 100));
      montoIva = subtotal - netoSinIva;
    } else {
      netoSinIva = subtotal;
      montoIva = Math.round((subtotal * item.alicuota_iva) / 100);
    }
  }

  const totalItemConIva = preciosIncluyenIva ? subtotal : netoSinIva + montoIva;
  const gananciaBruta = totalItemConIva - costoTotal;

  return {
    producto_id: item.producto_id,
    descripcion: item.descripcion,
    cantidad: item.cantidad,
    precio_unitario: item.precio_unitario,
    costo_unitario: item.costo_unitario,
    bruto,
    descuento,
    subtotal: totalItemConIva,
    costo_total: costoTotal,
    ganancia_bruta: gananciaBruta,
    alicuota_iva: item.alicuota_iva,
    exento_iva: exento,
    neto_sin_iva: netoSinIva,
    monto_iva: montoIva,
  };
}

/**
 * Calcula los totales de una venta completa, incluyendo descuento global, IVA y ganancia histórica.
 */
export function calcularTotalesVenta(
  itemsInput: readonly ItemVentaInput[],
  descuentoGlobal: Centavos = 0,
  preciosIncluyenIva = true
): ResumenVentaCalculado {
  if (itemsInput.length === 0) {
    throw new Error('Una venta debe tener al menos un ítem.');
  }
  asegurarCentavos(descuentoGlobal, 'descuentoGlobal');
  if (descuentoGlobal < 0) {
    throw new Error('El descuento global no puede ser negativo.');
  }

  const items = itemsInput.map((item) => calcularItemVenta(item, preciosIncluyenIva));
  const subtotal = items.reduce((acc, it) => acc + it.subtotal, 0);

  if (descuentoGlobal > subtotal) {
    throw new Error('El descuento global no puede superar el subtotal de la venta.');
  }

  const total = subtotal - descuentoGlobal;
  const costoTotal = items.reduce((acc, it) => acc + it.costo_total, 0);
  const gananciaBruta = total - costoTotal;
  const margenPorcentaje =
    total > 0 ? Math.round((gananciaBruta / total) * 10000) / 100 : 0;

  // Agrupar IVA proporcional al descuento global si existe
  const factorDescuento = subtotal > 0 ? total / subtotal : 1;
  const mapaIva = new Map<AlicuotaIva | 'exento', { neto: number; iva: number; total: number }>();

  for (const it of items) {
    const clave: AlicuotaIva | 'exento' = it.exento_iva ? 'exento' : it.alicuota_iva;
    const actual = mapaIva.get(clave) ?? { neto: 0, iva: 0, total: 0 };
    const totalAjustado = Math.round(it.subtotal * factorDescuento);
    let netoAjustado = totalAjustado;
    let ivaAjustado = 0;

    if (clave !== 'exento' && clave > 0) {
      netoAjustado = Math.round(totalAjustado / (1 + clave / 100));
      ivaAjustado = totalAjustado - netoAjustado;
    }

    mapaIva.set(clave, {
      neto: actual.neto + netoAjustado,
      iva: actual.iva + ivaAjustado,
      total: actual.total + totalAjustado,
    });
  }

  const desgloseIva: DesgloseIva[] = Array.from(mapaIva.entries()).map(
    ([alicuota, valores]) => ({
      alicuota,
      neto: valores.neto,
      iva: valores.iva,
      total: valores.total,
    })
  );

  return {
    items,
    subtotal,
    descuento_global: descuentoGlobal,
    total,
    costo_total: costoTotal,
    ganancia_bruta: gananciaBruta,
    margen_porcentaje: margenPorcentaje,
    desglose_iva: desgloseIva,
  };
}

/**
 * Valida que la suma de pagos mixtos coincida exactamente con el total de la venta.
 */
export function validarPagosVenta(
  pagos: readonly PagoVentaInput[],
  totalVenta: Centavos
): void {
  asegurarCentavos(totalVenta, 'totalVenta');
  if (pagos.length === 0) {
    throw new Error('Debe indicar al menos un medio de pago.');
  }

  let sumaPagos = 0;
  for (const p of pagos) {
    asegurarCentavos(p.monto, `pago (${p.medio})`);
    if (p.monto <= 0) {
      throw new Error(`El monto del pago con ${p.medio} debe ser mayor a cero.`);
    }
    sumaPagos += p.monto;
  }

  if (sumaPagos !== totalVenta) {
    throw new Error(
      `La suma de los pagos (${sumaPagos}) no coincide con el total de la venta (${totalVenta}).`
    );
  }
}

/**
 * Calcula el arqueo y cierre de caja desglosado por medio de pago y la diferencia de efectivo (§13).
 */
export function calcularArqueoCaja(params: {
  montoInicial: Centavos;
  pagosVentasCompletadas: readonly PagoVentaInput[];
  movimientosManuales: readonly {
    tipo: 'ingreso' | 'egreso';
    medio: MedioPago;
    monto: Centavos;
  }[];
  efectivoContado: Centavos;
}): {
  totalesPorMedio: Record<MedioPago, Centavos>;
  efectivoEsperado: Centavos;
  efectivoContado: Centavos;
  diferenciaEfectivo: Centavos;
} {
  asegurarCentavos(params.montoInicial, 'montoInicial');
  asegurarCentavos(params.efectivoContado, 'efectivoContado');

  const totalesPorMedio: Record<MedioPago, Centavos> = {
    efectivo: 0,
    transferencia: 0,
    mercado_pago: 0,
    qr: 0,
    debito: 0,
    credito: 0,
    cuenta_corriente: 0,
    otro: 0,
  };

  for (const pago of params.pagosVentasCompletadas) {
    asegurarCentavos(pago.monto, 'pago.monto');
    totalesPorMedio[pago.medio] += pago.monto;
  }

  let ajusteManualEfectivo = 0;
  for (const mov of params.movimientosManuales) {
    asegurarCentavos(mov.monto, 'movimiento.monto');
    const signo = mov.tipo === 'ingreso' ? 1 : -1;
    if (mov.medio === 'efectivo') {
      ajusteManualEfectivo += signo * mov.monto;
    }
  }

  const efectivoEsperado =
    params.montoInicial + totalesPorMedio.efectivo + ajusteManualEfectivo;
  const diferenciaEfectivo = params.efectivoContado - efectivoEsperado;

  return {
    totalesPorMedio,
    efectivoEsperado,
    efectivoContado: params.efectivoContado,
    diferenciaEfectivo,
  };
}

/**
 * Regla 20 (PLAN.md §3): Proyecta un producto o ítem de venta para pantalla de venta,
 * ticket, factura, PDF o venta móvil eliminando cualquier rastro de costos o márgenes.
 */
export function proyectarProductoParaVenta<
  T extends {
    id: string;
    nombre: string;
    precio_venta: Centavos;
    costo_compra?: unknown;
    margen_bp?: unknown;
  },
>(producto: T): Omit<T, 'costo_compra' | 'margen_bp'> {
  const copia = { ...producto };
  delete copia.costo_compra;
  delete copia.margen_bp;
  return copia;
}

export function proyectarItemParaTicket(item: ItemVentaCalculado): {
  producto_id: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: Centavos;
  descuento: Centavos;
  subtotal: Centavos;
  alicuota_iva: AlicuotaIva;
  exento_iva: boolean;
} {
  return {
    producto_id: item.producto_id,
    descripcion: item.descripcion,
    cantidad: item.cantidad,
    precio_unitario: item.precio_unitario,
    descuento: item.descuento,
    subtotal: item.subtotal,
    alicuota_iva: item.alicuota_iva,
    exento_iva: item.exento_iva,
  };
}
