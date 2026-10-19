/**
 * Generador puro de tickets no fiscales y comprobantes para el cliente (PLAN.md §3 regla 20, §8 y §13).
 * Regla 20: En la pantalla de venta, el ticket y la factura NO aparece ningún costo de compra, solo precio_venta.
 */

import {
  formatearFechaHoraAR,
  formatearMonedaARS,
  type Centavos,
} from './dinero.ts';
import type { AlicuotaIva, MedioPago } from './totales.ts';

export interface ItemEntradaTicket {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precio_unitario: Centavos;
  readonly descuento?: Centavos;
  readonly subtotal: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva?: boolean;
  // Si por error alguien pasa un objeto con costo_unitario o costo_compra, se elimina explícitamente
  readonly costo_unitario?: unknown;
  readonly costo_compra?: unknown;
  readonly ganancia_bruta?: unknown;
}

export interface DatosTicketNoFiscal {
  readonly comercioNombre: string;
  readonly comercioCuit?: string | null;
  readonly comercioDomicilio?: string | null;
  readonly comercioCondicionIva?: string;
  readonly ventaId: string;
  readonly fechaIso: string;
  readonly cajeroNombre: string;
  readonly clienteNombre?: string | null;
  readonly items: ReadonlyArray<{
    readonly descripcion: string;
    readonly cantidad: number;
    readonly precio_unitario: Centavos;
    readonly descuento: Centavos;
    readonly subtotal: Centavos;
  }>;
  readonly subtotal: Centavos;
  readonly descuentoGlobal: Centavos;
  readonly total: Centavos;
  readonly pagos: ReadonlyArray<{
    readonly medio: MedioPago;
    readonly monto: Centavos;
  }>;
}

const ETIQUETAS_MEDIO_PAGO: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  mercado_pago: 'Mercado Pago',
  qr: 'QR',
  debito: 'Tarjeta Débito',
  credito: 'Tarjeta Crédito',
  cuenta_corriente: 'Cuenta Corriente',
  otro: 'Otro',
};

/**
 * Construye el modelo de datos seguro de un ticket eliminando cualquier propiedad de costo o margen (Regla 20).
 */
export function construirDatosTicketSeguro(params: {
  comercioNombre: string;
  comercioCuit?: string | null;
  comercioDomicilio?: string | null;
  comercioCondicionIva?: string;
  ventaId: string;
  fechaIso: string;
  cajeroNombre: string;
  clienteNombre?: string | null;
  items: readonly ItemEntradaTicket[];
  subtotal: Centavos;
  descuentoGlobal: Centavos;
  total: Centavos;
  pagos: ReadonlyArray<{ medio: MedioPago; monto: Centavos }>;
}): DatosTicketNoFiscal {
  return {
    comercioNombre: params.comercioNombre,
    comercioCuit: params.comercioCuit ?? null,
    comercioDomicilio: params.comercioDomicilio ?? null,
    comercioCondicionIva: params.comercioCondicionIva ?? 'Monotributo',
    ventaId: params.ventaId,
    fechaIso: params.fechaIso,
    cajeroNombre: params.cajeroNombre,
    clienteNombre: params.clienteNombre ?? 'Consumidor Final',
    items: params.items.map((it) => ({
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precio_unitario: it.precio_unitario,
      descuento: it.descuento ?? 0,
      subtotal: it.subtotal,
    })),
    subtotal: params.subtotal,
    descuentoGlobal: params.descuentoGlobal,
    total: params.total,
    pagos: params.pagos.map((p) => ({
      medio: p.medio,
      monto: p.monto,
    })),
  };
}

/**
 * Renderiza el ticket no fiscal en formato texto de 40 columnas listo para pantalla o impresora térmica.
 * Garantiza que jamás aparezca costo_compra ni ganancia.
 */
export function formatearTicketNoFiscalTexto(datos: DatosTicketNoFiscal): string {
  const lineas: string[] = [];
  const separador = '-'.repeat(40);

  lineas.push(datos.comercioNombre.toUpperCase());
  if (datos.comercioDomicilio) {
    lineas.push(datos.comercioDomicilio);
  }
  if (datos.comercioCuit) {
    lineas.push(`CUIT: ${datos.comercioCuit}`);
  }
  lineas.push(separador);
  lineas.push('COMPROBANTE NO VÁLIDO COMO FACTURA');
  lineas.push(`Fecha: ${formatearFechaHoraAR(datos.fechaIso)}`);
  lineas.push(`Operador: ${datos.cajeroNombre}`);
  lineas.push(`Cliente: ${datos.clienteNombre ?? 'Consumidor Final'}`);
  lineas.push(`Operación: #${datos.ventaId.slice(-8)}`);
  lineas.push(separador);

  for (const item of datos.items) {
    lineas.push(item.descripcion);
    const lineaDetalle = `  ${item.cantidad} x ${formatearMonedaARS(item.precio_unitario)} = ${formatearMonedaARS(item.subtotal)}`;
    lineas.push(lineaDetalle);
    if (item.descuento > 0) {
      lineas.push(`  Bonif. ítem: -${formatearMonedaARS(item.descuento)}`);
    }
  }

  lineas.push(separador);
  if (datos.descuentoGlobal > 0) {
    lineas.push(`Subtotal: ${formatearMonedaARS(datos.subtotal)}`);
    lineas.push(`Descuento: -${formatearMonedaARS(datos.descuentoGlobal)}`);
  }
  lineas.push(`TOTAL: ${formatearMonedaARS(datos.total)}`);
  lineas.push(separador);
  lineas.push('Medios de pago:');
  for (const p of datos.pagos) {
    lineas.push(
      `  ${ETIQUETAS_MEDIO_PAGO[p.medio]}: ${formatearMonedaARS(p.monto)}`
    );
  }
  lineas.push(separador);
  lineas.push('¡Gracias por su compra!');

  return lineas.join('\n');
}
