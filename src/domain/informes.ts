/**
 * Cálculos puros para los Informes de Gestión de Fase 1 (PLAN.md §7, §10 y §13):
 * - Ganancia bruta y margen histórico (usando costo_unitario copiado en cada ítem vendido).
 * - Stock valorizado a costo de compra y a precio de venta.
 * - Balance simple del período (ventas, CMV histórico, ganancia bruta, egresos de caja).
 */

import { aMiliunidades } from './cantidades.ts';
import { asegurarCentavos, type Centavos } from './dinero.ts';
import { estaBajoStockMinimo } from './stock.ts';

export interface ItemVendidoHistoricoInput {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly subtotal_venta: Centavos;
  readonly costo_unitario_historico: Centavos;
}

export interface RentabilidadProductoCalculada {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly cantidad_vendida: number;
  readonly ventas_netas_centavos: Centavos;
  readonly costo_historico_total_centavos: Centavos;
  readonly ganancia_bruta_centavos: Centavos;
  readonly margen_porcentaje: number;
}

export interface ResumenRentabilidadPeriodo {
  readonly porProducto: readonly RentabilidadProductoCalculada[];
  readonly ventasTotalesCentavos: Centavos;
  readonly costoMercaderiaVendidaCentavos: Centavos;
  readonly gananciaBrutaTotalCentavos: Centavos;
  readonly margenPromedioPorcentaje: number;
}

export interface ProductoStockValorizadoInput {
  readonly producto_id: string;
  readonly nombre: string;
  readonly stock_actual: number;
  readonly stock_minimo: number;
  readonly costo_compra: Centavos;
  readonly precio_venta: Centavos;
}

export interface ProductoStockValorizadoCalculado extends ProductoStockValorizadoInput {
  readonly bajo_stock_minimo: boolean;
  readonly valorizado_costo_centavos: Centavos;
  readonly valorizado_venta_centavos: Centavos;
}

export interface ResumenStockValorizado {
  readonly items: readonly ProductoStockValorizadoCalculado[];
  readonly cantidadProductosBajoMinimo: number;
  readonly totalValorizadoCostoCentavos: Centavos;
  readonly totalValorizadoVentaCentavos: Centavos;
}

/**
 * Calcula la ganancia bruta histórica y el ranking por producto usando el `costo_unitario`
 * copiado en cada ítem al momento de la venta (PLAN.md §4 y §7).
 */
export function calcularRentabilidadHistorica(
  itemsVendidos: readonly ItemVendidoHistoricoInput[]
): ResumenRentabilidadPeriodo {
  const acumulador = new Map<
    string,
    {
      descripcion: string;
      cantidadMili: number;
      ventasCentavos: number;
      costoCentavos: number;
    }
  >();

  let ventasTotales = 0;
  let cmvTotal = 0;

  for (const item of itemsVendidos) {
    asegurarCentavos(item.subtotal_venta, 'subtotal_venta');
    asegurarCentavos(
      item.costo_unitario_historico,
      'costo_unitario_historico'
    );
    const cantMili = aMiliunidades(item.cantidad);
    const costoItem = Math.round(
      (cantMili * item.costo_unitario_historico) / 1000
    );

    ventasTotales += item.subtotal_venta;
    cmvTotal += costoItem;

    const previo = acumulador.get(item.producto_id) ?? {
      descripcion: item.descripcion,
      cantidadMili: 0,
      ventasCentavos: 0,
      costoCentavos: 0,
    };

    acumulador.set(item.producto_id, {
      descripcion: previo.descripcion,
      cantidadMili: previo.cantidadMili + cantMili,
      ventasCentavos: previo.ventasCentavos + item.subtotal_venta,
      costoCentavos: previo.costoCentavos + costoItem,
    });
  }

  const porProducto: RentabilidadProductoCalculada[] = Array.from(
    acumulador.entries()
  )
    .map(([producto_id, datos]) => {
      const ganancia = datos.ventasCentavos - datos.costoCentavos;
      const margen =
        datos.ventasCentavos > 0
          ? Math.round((ganancia / datos.ventasCentavos) * 10000) / 100
          : 0;
      return {
        producto_id,
        descripcion: datos.descripcion,
        cantidad_vendida: Math.round(datos.cantidadMili) / 1000,
        ventas_netas_centavos: datos.ventasCentavos,
        costo_historico_total_centavos: datos.costoCentavos,
        ganancia_bruta_centavos: ganancia,
        margen_porcentaje: margen,
      };
    })
    .sort((a, b) => b.cantidad_vendida - a.cantidad_vendida);

  const gananciaTotal = ventasTotales - cmvTotal;
  const margenPromedio =
    ventasTotales > 0
      ? Math.round((gananciaTotal / ventasTotales) * 10000) / 100
      : 0;

  return {
    porProducto,
    ventasTotalesCentavos: ventasTotales,
    costoMercaderiaVendidaCentavos: cmvTotal,
    gananciaBrutaTotalCentavos: gananciaTotal,
    margenPromedioPorcentaje: margenPromedio,
  };
}

/**
 * Calcula el stock valorizado a costo de compra y a precio de venta e identifica productos bajo mínimo (PLAN.md §7).
 */
export function calcularStockValorizado(
  productos: readonly ProductoStockValorizadoInput[]
): ResumenStockValorizado {
  let totalCosto = 0;
  let totalVenta = 0;
  let bajoMinimoCount = 0;

  const items: ProductoStockValorizadoCalculado[] = productos.map((p) => {
    asegurarCentavos(p.costo_compra, 'costo_compra');
    asegurarCentavos(p.precio_venta, 'precio_venta');

    const stockMili = Math.max(0, aMiliunidades(p.stock_actual));
    const valCosto = Math.round((stockMili * p.costo_compra) / 1000);
    const valVenta = Math.round((stockMili * p.precio_venta) / 1000);
    const bajoMinimo = estaBajoStockMinimo(p.stock_actual, p.stock_minimo);

    if (bajoMinimo) {
      bajoMinimoCount++;
    }
    totalCosto += valCosto;
    totalVenta += valVenta;

    return {
      ...p,
      bajo_stock_minimo: bajoMinimo,
      valorizado_costo_centavos: valCosto,
      valorizado_venta_centavos: valVenta,
    };
  });

  return {
    items,
    cantidadProductosBajoMinimo: bajoMinimoCount,
    totalValorizadoCostoCentavos: totalCosto,
    totalValorizadoVentaCentavos: totalVenta,
  };
}

/**
 * Calcula el balance simple del período (PLAN.md §7: ventas, costo de mercadería vendida, ganancia bruta, egresos de caja).
 */
export function calcularBalanceSimplePeriodo(params: {
  ventasNetasCentavos: Centavos;
  costoMercaderiaVendidaCentavos: Centavos;
  egresosCajaCentavos: Centavos;
}): {
  ventasNetasCentavos: Centavos;
  costoMercaderiaVendidaCentavos: Centavos;
  gananciaBrutaCentavos: Centavos;
  egresosCajaCentavos: Centavos;
  resultadoNetoOperativoCentavos: Centavos;
} {
  asegurarCentavos(params.ventasNetasCentavos, 'ventasNetasCentavos');
  asegurarCentavos(
    params.costoMercaderiaVendidaCentavos,
    'costoMercaderiaVendidaCentavos'
  );
  asegurarCentavos(params.egresosCajaCentavos, 'egresosCajaCentavos');

  const gananciaBruta =
    params.ventasNetasCentavos - params.costoMercaderiaVendidaCentavos;
  const resultadoNetoOperativo = gananciaBruta - params.egresosCajaCentavos;

  return {
    ventasNetasCentavos: params.ventasNetasCentavos,
    costoMercaderiaVendidaCentavos: params.costoMercaderiaVendidaCentavos,
    gananciaBrutaCentavos: gananciaBruta,
    egresosCajaCentavos: params.egresosCajaCentavos,
    resultadoNetoOperativoCentavos: resultadoNetoOperativo,
  };
}
