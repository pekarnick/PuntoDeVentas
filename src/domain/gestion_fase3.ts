/**
 * Funciones puras de dominio para la Fase 3 — Gestión completa (PLAN.md §3, §7, §8, §10):
 * - Actualización masiva de precios en centavos con redondeo configurable.
 * - Cálculo de saldos de Cuenta Corriente (clientes y proveedores) y límite de crédito.
 * - Desglose de Libro IVA Ventas y Libro IVA Compras por alícuota para el contador.
 * - Generador de comandos binarios ESC/POS para impresoras térmicas de 58 mm y 80 mm (Regla 20: sin costos).
 * - Parseo de archivos CSV de importación masiva de catálogo.
 */

import {
  exigirEnteroCentavos,
  formatearFechaHoraAR,
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from './dinero.ts';
import type { DatosTicketNoFiscal } from './ticket.ts';
import {
  ALICUOTAS_IVA_VALIDAS,
  desglosarIvaPorItem,
  type AlicuotaIva,
} from './totales.ts';

// ============================================================================
// 1. Actualización Masiva de Precios (Inflación / Listas, PLAN.md §8 y §10)
// ============================================================================

export type ReglaRedondeoPrecio =
  | 'exacto'
  | 'exacto_centavos'
  | 'pesos_enteros'
  | 'entero_peso' // Múltiplo de $ 1,00 (100 centavos)
  | 'multiplo_10_pesos'
  | 'decena_peso' // Múltiplo de $ 10,00 (1.000 centavos)
  | 'multiplo_50_pesos' // Múltiplo de $ 50,00 (5.000 centavos)
  | 'multiplo_100_pesos'
  | 'centena_peso'; // Múltiplo de $ 100,00 (10.000 centavos)

export function aplicarRedondeoCentavos(
  centavos: Centavos,
  regla: ReglaRedondeoPrecio
): Centavos {
  exigirEnteroCentavos(centavos, 'centavos');
  if (centavos <= 0 || regla === 'exacto' || regla === 'exacto_centavos') {
    return Math.max(0, centavos);
  }

  const paso =
    regla === 'entero_peso' || regla === 'pesos_enteros'
      ? 100
      : regla === 'decena_peso' || regla === 'multiplo_10_pesos'
        ? 1000
        : regla === 'multiplo_50_pesos'
          ? 5000
          : 10000;

  return Math.round(centavos / paso) * paso;
}

export function calcularNuevoPrecioMasivo(
  paramsOPrecio:
    | {
        readonly precioActualCentavos: Centavos;
        readonly porcentajeVariacion: number;
        readonly reglaRedondeo?: ReglaRedondeoPrecio;
      }
    | Centavos,
  porcentajePosicional?: number,
  reglaPosicional?: ReglaRedondeoPrecio
): Centavos {
  const params =
    typeof paramsOPrecio === 'number'
      ? {
          precioActualCentavos: paramsOPrecio,
          porcentajeVariacion: porcentajePosicional ?? 0,
          reglaRedondeo: reglaPosicional ?? 'exacto_centavos',
        }
      : paramsOPrecio;

  exigirEnteroCentavos(params.precioActualCentavos, 'precioActualCentavos');
  if (
    !Number.isFinite(params.porcentajeVariacion) ||
    params.porcentajeVariacion <= -100
  ) {
    throw new Error(
      'El porcentaje de variación debe ser mayor a -100% (ej. 15 para +15%).'
    );
  }

  // Convertimos porcentaje a puntos básicos enteros (1% = 100 bp)
  const bp = Math.round(params.porcentajeVariacion * 100);
  const factorBp = 10000 + bp; // 100.00% = 10000 bp

  const brutoCentavos = Math.round(
    (params.precioActualCentavos * factorBp) / 10000
  );

  return aplicarRedondeoCentavos(
    Math.max(0, brutoCentavos),
    params.reglaRedondeo ?? 'exacto_centavos'
  );
}

// ============================================================================
// 2. Cuenta Corriente de Clientes y Proveedores (PLAN.md §4, §7 y §10)
// ============================================================================

export interface MovimientoCuentaCorrienteInput {
  readonly id: string;
  readonly tipo: 'cargo' | 'pago';
  readonly monto: Centavos;
  readonly fecha?: string;
}

export interface ResumenCuentaCorriente {
  readonly totalCargosCentavos: Centavos;
  readonly totalPagosCentavos: Centavos;
  /**
   * Saldo pendiente en centavos (`cargos - pagos`).
   * En clientes: deuda del cliente con el comercio.
   * En proveedores: deuda del comercio con el proveedor.
   */
  readonly saldoPendienteCentavos: Centavos;
}

export function calcularEstadoCuentaCorriente(
  movimientos: readonly MovimientoCuentaCorrienteInput[]
): ResumenCuentaCorriente {
  let cargos = 0;
  let pagos = 0;

  for (const m of movimientos) {
    exigirEnteroCentavos(m.monto, 'monto movimiento cuenta corriente');
    if (m.monto <= 0) {
      throw new Error('El monto del movimiento de cuenta corriente debe ser > 0.');
    }
    if (m.tipo === 'cargo') {
      cargos += m.monto;
    } else {
      pagos += m.monto;
    }
  }

  return {
    totalCargosCentavos: cargos,
    totalPagosCentavos: pagos,
    saldoPendienteCentavos: cargos - pagos,
  };
}

export function validarCargoCuentaCorrienteCliente(params: {
  readonly saldoActualCentavos: Centavos;
  readonly nuevoCargoCentavos: Centavos;
  readonly limiteCreditoCentavos: Centavos;
}): {
  readonly permitido: boolean;
  readonly nuevoSaldoProyectadoCentavos: Centavos;
  readonly excedenteCentavos: Centavos;
  readonly motivo?: string;
} {
  exigirEnteroCentavos(params.saldoActualCentavos, 'saldoActualCentavos');
  exigirEnteroCentavos(params.nuevoCargoCentavos, 'nuevoCargoCentavos');
  exigirEnteroCentavos(params.limiteCreditoCentavos, 'limiteCreditoCentavos');

  const nuevoSaldo = params.saldoActualCentavos + params.nuevoCargoCentavos;

  // Si limite_credito === 0 significa que el cliente no tiene tope restrictivo o se evalúa contra el límite configurado
  if (
    params.limiteCreditoCentavos > 0 &&
    nuevoSaldo > params.limiteCreditoCentavos
  ) {
    const excedente = nuevoSaldo - params.limiteCreditoCentavos;
    return {
      permitido: false,
      nuevoSaldoProyectadoCentavos: nuevoSaldo,
      excedenteCentavos: excedente,
      motivo: `LIMITE_CREDITO_EXCEDIDO: El nuevo saldo (${formatearMonedaARS(nuevoSaldo)}) supera el límite de crédito del cliente (${formatearMonedaARS(params.limiteCreditoCentavos)}) por ${formatearMonedaARS(excedente)}.`,
    };
  }

  return {
    permitido: true,
    nuevoSaldoProyectadoCentavos: nuevoSaldo,
    excedenteCentavos: 0,
  };
}

// ============================================================================
// 3. Libro IVA Ventas y Libro IVA Compras (PLAN.md §7 y §10)
// ============================================================================

export interface ItemComprobanteParaIva {
  readonly subtotalCentavos: Centavos;
  readonly alicuotaIva: AlicuotaIva;
  readonly exentoIva: boolean;
}

export interface FilaLibroIva {
  readonly id: string;
  readonly fecha: string;
  readonly tipoComprobante: string;
  readonly numeroComprobante: string;
  readonly contraparteNombre: string;
  readonly contraparteCuitDni: string;
  readonly netoGravadoCentavos: Centavos;
  readonly iva105Centavos: Centavos;
  readonly iva21Centavos: Centavos;
  readonly iva27Centavos: Centavos;
  readonly exentoNoGravadoCentavos: Centavos;
  readonly totalCentavos: Centavos;
}

export interface ResumenLibroIva {
  readonly filas: readonly FilaLibroIva[];
  readonly totalNetoGravadoCentavos: Centavos;
  readonly totalIva105Centavos: Centavos;
  readonly totalIva21Centavos: Centavos;
  readonly totalIva27Centavos: Centavos;
  readonly totalIvaGeneralCentavos: Centavos;
  readonly totalExentoNoGravadoCentavos: Centavos;
  readonly totalGeneralCentavos: Centavos;
}

export function calcularFilaLibroIvaDesdeItems(params: {
  readonly id: string;
  readonly fecha: string;
  readonly tipoComprobante: string;
  readonly numeroComprobante: string;
  readonly contraparteNombre: string;
  readonly contraparteCuitDni: string;
  readonly preciosIncluyenIva: boolean;
  readonly items: readonly ItemComprobanteParaIva[];
}): FilaLibroIva {
  let netoGravado = 0;
  let iva105 = 0;
  let iva21 = 0;
  let iva27 = 0;
  let exento = 0;
  let total = 0;

  for (const item of params.items) {
    const d = desglosarIvaPorItem(
      item.subtotalCentavos,
      item.alicuotaIva,
      item.exentoIva,
      params.preciosIncluyenIva
    );

    if (item.exentoIva || item.alicuotaIva === 0) {
      exento += d.total;
    } else {
      netoGravado += d.neto;
      if (item.alicuotaIva === 10.5) iva105 += d.iva;
      else if (item.alicuotaIva === 21) iva21 += d.iva;
      else if (item.alicuotaIva === 27) iva27 += d.iva;
    }
    total += d.total;
  }

  return {
    id: params.id,
    fecha: params.fecha,
    tipoComprobante: params.tipoComprobante,
    numeroComprobante: params.numeroComprobante,
    contraparteNombre: params.contraparteNombre,
    contraparteCuitDni: params.contraparteCuitDni,
    netoGravadoCentavos: netoGravado,
    iva105Centavos: iva105,
    iva21Centavos: iva21,
    iva27Centavos: iva27,
    exentoNoGravadoCentavos: exento,
    totalCentavos: total,
  };
}

export function consolidarResumenLibroIva(
  filas: readonly FilaLibroIva[]
): ResumenLibroIva {
  let totalNeto = 0;
  let total105 = 0;
  let total21 = 0;
  let total27 = 0;
  let totalExento = 0;
  let totalGeneral = 0;

  for (const f of filas) {
    totalNeto += f.netoGravadoCentavos;
    total105 += f.iva105Centavos;
    total21 += f.iva21Centavos;
    total27 += f.iva27Centavos;
    totalExento += f.exentoNoGravadoCentavos;
    totalGeneral += f.totalCentavos;
  }

  return {
    filas,
    totalNetoGravadoCentavos: totalNeto,
    totalIva105Centavos: total105,
    totalIva21Centavos: total21,
    totalIva27Centavos: total27,
    totalIvaGeneralCentavos: total105 + total21 + total27,
    totalExentoNoGravadoCentavos: totalExento,
    totalGeneralCentavos: totalGeneral,
  };
}

// ============================================================================
// 4. Impresión Térmica ESC/POS (58 mm / 80 mm) — Regla 20 (jamás incluye costos)
// ============================================================================

export type AnchoPapelTermico = '58mm' | '80mm';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/**
 * Genera los bytes de comandos estándar ESC/POS (`ESC @`, `ESC a`, `ESC E`, `GS V`)
 * a partir de un `DatosTicketNoFiscal` ya sanitizado sin costos (Regla 20).
 */
export function generarComandosEscPosTicket(
  datos: DatosTicketNoFiscal,
  anchoPapel: AnchoPapelTermico = '80mm'
): {
  readonly bytes: Uint8Array;
  readonly textoImpresora: string;
  readonly columnas: number;
} {
  // Defensa adicional en profundidad por Regla 20
  const serializado = JSON.stringify(datos).toLowerCase();
  if (serializado.includes('costo_compra') || serializado.includes('costo_unitario')) {
    throw new Error(
      'VIOLACION_REGLA_20: No se permite enviar costos de compra a la impresora de tickets.'
    );
  }

  const cols = anchoPapel === '58mm' ? 32 : 48;
  const separador = '-'.repeat(cols);

  const alinearExtremos = (izq: string, der: string): string => {
    const espacios = Math.max(1, cols - izq.length - der.length);
    return `${izq.slice(0, Math.max(1, cols - der.length - 1))}${' '.repeat(espacios)}${der}`;
  };

  const lineasTexto: string[] = [];
  lineasTexto.push(datos.comercioNombre.toUpperCase());
  if (datos.comercioCuit) {
    lineasTexto.push(`CUIT: ${datos.comercioCuit}`);
  }
  if (datos.comercioDomicilio) {
    lineasTexto.push(datos.comercioDomicilio);
  }
  lineasTexto.push('DOCUMENTO NO VALIDO COMO FACTURA');
  lineasTexto.push(separador);
  lineasTexto.push(`Fecha: ${formatearFechaHoraAR(datos.fechaIso)}`);
  lineasTexto.push(`Ticket: #${datos.ventaId.slice(-8).toUpperCase()}`);
  lineasTexto.push(`Atendio: ${datos.cajeroNombre}`);
  lineasTexto.push(separador);

  for (const item of datos.items) {
    lineasTexto.push(item.descripcion.slice(0, cols));
    const detalleCant = `  ${item.cantidad} x ${formatearMonedaARS(item.precio_unitario)}`;
    const subtotalStr = formatearMonedaARS(item.subtotal);
    lineasTexto.push(alinearExtremos(detalleCant, subtotalStr));
  }

  lineasTexto.push(separador);
  if (datos.descuentoGlobal > 0) {
    lineasTexto.push(
      alinearExtremos('SUBTOTAL:', formatearMonedaARS(datos.subtotal))
    );
    lineasTexto.push(
      alinearExtremos('DESCUENTO:', `-${formatearMonedaARS(datos.descuentoGlobal)}`)
    );
  }
  lineasTexto.push(
    alinearExtremos('TOTAL A PAGAR:', formatearMonedaARS(datos.total))
  );
  lineasTexto.push(separador);

  for (const p of datos.pagos) {
    lineasTexto.push(
      alinearExtremos(
        `Pago (${p.medio.replace(/_/g, ' ')}):`,
        formatearMonedaARS(p.monto)
      )
    );
  }
  lineasTexto.push(separador);
  lineasTexto.push('Gracias por su compra');

  const textoImpresora = lineasTexto.join('\n');

  // Construcción del flujo binario ESC/POS:
  // ESC @ (Init), ESC a 1 (Centrar encabezado), ESC E 1 (Negrita título), ESC E 0, ESC a 0 (Izquierda), cuerpo, avance y GS V 66 0 (Corte parcial)
  const encoder = new TextEncoder();
  const cuerpoBytes = encoder.encode(
    textoImpresora
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') + '\n\n\n'
  );

  const headerCmds = new Uint8Array([
    ESC,
    0x40, // Initialize printer
    ESC,
    0x61,
    0x00, // Left alignment
  ]);
  const footerCmds = new Uint8Array([
    LF,
    GS,
    0x56,
    0x42,
    0x00, // Partial paper cut
  ]);

  const bytes = new Uint8Array(
    headerCmds.length + cuerpoBytes.length + footerCmds.length
  );
  bytes.set(headerCmds, 0);
  bytes.set(cuerpoBytes, headerCmds.length);
  bytes.set(footerCmds, headerCmds.length + cuerpoBytes.length);

  return {
    bytes,
    textoImpresora,
    columnas: cols,
  };
}

// ============================================================================
// 5. Parseo de Importación Masiva CSV de Catálogo (PLAN.md §10)
// ============================================================================

export interface FilaProductoImportadoCsv {
  readonly filaNumero: number;
  readonly nombre: string;
  readonly codigoInterno?: string;
  readonly codigoBarras?: string;
  readonly costoCompraCentavos: Centavos;
  readonly precioVentaCentavos: Centavos;
  readonly alicuotaIva: AlicuotaIva;
  readonly stockInicial: number;
  readonly stockMinimo: number;
  readonly categoriaNombre?: string;
  readonly marcaNombre?: string;
}

export interface ResultadoParseoCsvCatalogo {
  readonly filasValidas: readonly FilaProductoImportadoCsv[];
  readonly filas: readonly FilaProductoImportadoCsv[];
  readonly errores: readonly string[];
}

/**
 * Parsea un texto CSV (separado por `;` o `,`, con encabezados en la primera línea).
 * Columnas soportadas: `nombre;codigo_interno;codigo_barras;costo_compra;precio_venta;alicuota_iva;stock_inicial;stock_minimo;categoria;marca`
 */
export function parsearCsvImportacionCatalogo(
  contenidoCsv: string
): ResultadoParseoCsvCatalogo {
  const lineas = contenidoCsv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lineas.length < 2) {
    return {
      filasValidas: [],
      filas: [],
      errores: [
        'El archivo CSV debe incluir una fila de encabezados y al menos una fila de productos.',
      ],
    };
  }

  const cabeceraRaw = lineas[0]!;
  const delimitador = cabeceraRaw.includes(';') ? ';' : ',';
  const cabeceras = cabeceraRaw
    .split(delimitador)
    .map((c) => c.trim().toLowerCase().replace(/^["']|["']$/g, ''));

  const idxNombre = cabeceras.findIndex((c) => c === 'nombre' || c === 'descripcion');
  const idxCodigoInterno = cabeceras.findIndex(
    (c) => c === 'codigo_interno' || c === 'codigo' || c === 'sku'
  );
  const idxCodigoBarras = cabeceras.findIndex(
    (c) => c === 'codigo_barras' || c === 'ean' || c === 'barras'
  );
  const idxCosto = cabeceras.findIndex(
    (c) => c === 'costo_compra' || c === 'costo'
  );
  const idxPrecio = cabeceras.findIndex(
    (c) => c === 'precio_venta' || c === 'precio'
  );
  const idxIva = cabeceras.findIndex(
    (c) => c === 'alicuota_iva' || c === 'iva'
  );
  const idxStockInicial = cabeceras.findIndex(
    (c) => c === 'stock_inicial' || c === 'stock'
  );
  const idxStockMinimo = cabeceras.findIndex((c) => c === 'stock_minimo');
  const idxCategoria = cabeceras.findIndex((c) => c === 'categoria');
  const idxMarca = cabeceras.findIndex((c) => c === 'marca');

  if (idxNombre === -1 || idxPrecio === -1) {
    return {
      filasValidas: [],
      filas: [],
      errores: [
        'El CSV debe tener al menos las columnas "nombre" y "precio_venta" (o "precio").',
      ],
    };
  }

  const filasValidas: FilaProductoImportadoCsv[] = [];
  const errores: string[] = [];

  for (let i = 1; i < lineas.length; i++) {
    const numFila = i + 1;
    const cols = lineas[i]!
      .split(delimitador)
      .map((c) => c.trim().replace(/^["']|["']$/g, ''));

    const nombre = (cols[idxNombre] ?? '').trim();
    if (!nombre) {
      errores.push(`Fila ${numFila}: El nombre del producto está vacío.`);
      continue;
    }

    try {
      const precioRaw = (cols[idxPrecio] ?? '0').trim() || '0';
      const costoRaw =
        idxCosto >= 0 ? (cols[idxCosto] ?? '0').trim() || '0' : '0';

      const precioVentaCentavos = pesosACentavos(precioRaw);
      const costoCompraCentavos = pesosACentavos(costoRaw);

      let alicuotaIva: AlicuotaIva = 21;
      if (idxIva >= 0 && cols[idxIva]) {
        const ivaNum = Number(cols[idxIva]!.replace(',', '.'));
        if (ALICUOTAS_IVA_VALIDAS.includes(ivaNum as AlicuotaIva)) {
          alicuotaIva = ivaNum as AlicuotaIva;
        }
      }

      const stockInicial =
        idxStockInicial >= 0 && cols[idxStockInicial]
          ? Number(cols[idxStockInicial]!.replace(',', '.')) || 0
          : 0;
      const stockMinimo =
        idxStockMinimo >= 0 && cols[idxStockMinimo]
          ? Number(cols[idxStockMinimo]!.replace(',', '.')) || 0
          : 0;

      const rawCodigoBarras =
        idxCodigoBarras >= 0 && cols[idxCodigoBarras]
          ? cols[idxCodigoBarras]!.trim()
          : '';
      const codigoBarrasLimpio =
        rawCodigoBarras &&
        !['0', '-', '--', 'n/a', 'na', 's/c', 'sc', 'null', 'ninguno'].includes(
          rawCodigoBarras.toLowerCase()
        )
          ? rawCodigoBarras
          : undefined;

      filasValidas.push({
        filaNumero: numFila,
        nombre,
        codigoInterno:
          idxCodigoInterno >= 0 && cols[idxCodigoInterno]
            ? cols[idxCodigoInterno]
            : undefined,
        codigoBarras: codigoBarrasLimpio,
        costoCompraCentavos,
        precioVentaCentavos,
        alicuotaIva,
        stockInicial,
        stockMinimo,
        categoriaNombre:
          idxCategoria >= 0 && cols[idxCategoria]
            ? cols[idxCategoria]
            : undefined,
        marcaNombre:
          idxMarca >= 0 && cols[idxMarca] ? cols[idxMarca] : undefined,
      });
    } catch (err) {
      errores.push(
        `Fila ${numFila} ("${nombre}"): ${err instanceof Error ? err.message : 'Formato numérico inválido.'}`
      );
    }
  }

  return { filasValidas, filas: filasValidas, errores };
}
