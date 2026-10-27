/**
 * Lógica pura de dominio para la Fase 4 (PLAN.md §3 Reglas 18, 19, 20; §6.3; §8; §9 y §10):
 * - Facturación Electrónica ARCA (ex-AFIP): determinación de comprobantes (A/B/C y Notas de Crédito),
 *   validación de receptor por monto y condición frente al IVA, generación del código QR oficial
 *   RG 4892/2020 (`https://www.afip.gob.ar/fe/qr/?p=...`), validación de no-almacenamiento de
 *   certificados/secretos en el cliente, y plantilla imprimible/PDF sin costos (Regla 20).
 * - Extras de Fase 4: decodificación de códigos de barras EAN-13 de balanzas (peso/precio embebido),
 *   múltiples listas de precio, variantes y cálculo de stock/precios de combos.
 */

import { aMiliunidades, desdeMiliunidades } from './cantidades.ts';
import { validarCuitModulo11 } from './cuit.ts';

function normalizarDocumentoArgentino(input: string): string {
  return input.replace(/\D/g, '');
}
import {
  asegurarCentavos,
  formatearFechaAR,
  formatearFechaHoraAR,
  formatearMonedaARS,
  type Centavos,
} from './dinero.ts';
import { desglosarIvaPorItem, type AlicuotaIva } from './totales.ts';
import { generarQrSvgDesdeBytes } from './venta_movil.ts';

export type CondicionIva =
  | 'monotributo'
  | 'responsable_inscripto'
  | 'exento'
  | 'consumidor_final';

export type AmbienteArca = 'homologacion' | 'produccion';

export type ProveedorArca =
  | 'afip_sdk'
  | 'tus_facturas'
  | 'simulador_homologacion';

export type TipoComprobanteFiscal =
  | 'ticket_no_fiscal'
  | 'factura_a'
  | 'factura_b'
  | 'factura_c'
  | 'nota_credito_a'
  | 'nota_credito_b'
  | 'nota_credito_c';

export type EstadoFacturacionArca =
  | 'no_aplica'
  | 'pendiente'
  | 'emitida'
  | 'error';

/**
 * Tope predeterminado en centavos a partir del cual ARCA exige identificar al Consumidor Final
 * ($ 344.488,00 = 34.448.800 centavos; configurable por comercio según actualizaciones de ARCA).
 */
export const TOPE_IDENTIFICACION_CONSUMIDOR_FINAL_CENTAVOS: Centavos = 34448800;

/**
 * Determina el tipo de comprobante y estado inicial de facturación según la condición IVA
 * del comercio emisor y del cliente receptor (PLAN.md §6.3 y §8).
 * - Si `arcaHabilitada === false`, devuelve siempre `'ticket_no_fiscal'` y `'no_aplica'`.
 */
export function determinarTipoComprobanteArca(params: {
  readonly arcaHabilitada: boolean;
  readonly condicionIvaEmisor: CondicionIva;
  readonly condicionIvaReceptor?: CondicionIva | null;
}): {
  readonly tipoComprobante: 'ticket_no_fiscal' | 'factura_a' | 'factura_b' | 'factura_c';
  readonly estadoFacturacionInicial: EstadoFacturacionArca;
  readonly letra: 'X' | 'A' | 'B' | 'C';
  readonly discriminaIva: boolean;
} {
  if (!params.arcaHabilitada) {
    return {
      tipoComprobante: 'ticket_no_fiscal',
      estadoFacturacionInicial: 'no_aplica',
      letra: 'X',
      discriminaIva: false,
    };
  }

  const receptor: CondicionIva =
    params.condicionIvaReceptor ?? 'consumidor_final';

  if (params.condicionIvaEmisor === 'responsable_inscripto') {
    if (
      receptor === 'responsable_inscripto' ||
      receptor === 'monotributo'
    ) {
      return {
        tipoComprobante: 'factura_a',
        estadoFacturacionInicial: 'pendiente',
        letra: 'A',
        discriminaIva: true,
      };
    }

    return {
      tipoComprobante: 'factura_b',
      estadoFacturacionInicial: 'pendiente',
      letra: 'B',
      discriminaIva: false,
    };
  }

  // Emisor monotributo, exento o consumidor_final emite Factura C
  return {
    tipoComprobante: 'factura_c',
    estadoFacturacionInicial: 'pendiente',
    letra: 'C',
    discriminaIva: false,
  };
}

/**
 * Determina la Nota de Crédito correspondiente para anular una venta ya facturada en ARCA (PLAN.md §6.3).
 */
export function determinarNotaCreditoArca(
  tipoComprobanteOriginal: TipoComprobanteFiscal
): 'nota_credito_a' | 'nota_credito_b' | 'nota_credito_c' | null {
  switch (tipoComprobanteOriginal) {
    case 'factura_a':
      return 'nota_credito_a';
    case 'factura_b':
      return 'nota_credito_b';
    case 'factura_c':
      return 'nota_credito_c';
    default:
      return null;
  }
}

/**
 * Devuelve el código numérico oficial de tabla de comprobantes de ARCA/AFIP.
 */
export function obtenerCodigoNumericoComprobanteArca(
  tipo: TipoComprobanteFiscal
): number {
  switch (tipo) {
    case 'factura_a':
      return 1;
    case 'nota_credito_a':
      return 3;
    case 'factura_b':
      return 6;
    case 'nota_credito_b':
      return 8;
    case 'factura_c':
      return 11;
    case 'nota_credito_c':
      return 13;
    case 'ticket_no_fiscal':
      return 0;
  }
}

export interface ResultadoValidacionReceptorArca {
  readonly valido: boolean;
  readonly tipoDocArca: 80 | 96 | 99; // 80 = CUIT, 96 = DNI, 99 = Consumidor Final sin identificar
  readonly nroDocArca: number;
  readonly motivo?: string;
}

/**
 * Valida los datos del receptor exigidos por ARCA según el tipo de comprobante y el monto total (PLAN.md §6.3).
 */
export function validarReceptorComprobanteArca(params: {
  readonly tipoComprobante: TipoComprobanteFiscal;
  readonly totalCentavos: Centavos;
  readonly condicionIvaReceptor?: CondicionIva | null;
  readonly cuitDniReceptor?: string | null;
  readonly nombreReceptor?: string | null;
  readonly topeConsumidorFinalCentavos?: Centavos;
}): ResultadoValidacionReceptorArca {
  asegurarCentavos(params.totalCentavos, 'totalCentavos');

  if (params.tipoComprobante === 'ticket_no_fiscal') {
    return { valido: true, tipoDocArca: 99, nroDocArca: 0 };
  }

  const docLimpio = normalizarDocumentoArgentino(params.cuitDniReceptor ?? '');

  if (
    params.tipoComprobante === 'factura_a' ||
    params.tipoComprobante === 'nota_credito_a'
  ) {
    if (!docLimpio || docLimpio.length !== 11 || !validarCuitModulo11(docLimpio)) {
      return {
        valido: false,
        tipoDocArca: 80,
        nroDocArca: 0,
        motivo:
          'Para emitir Factura A es obligatorio seleccionar un cliente con CUIT válido de 11 dígitos (módulo 11).',
      };
    }
    return {
      valido: true,
      tipoDocArca: 80,
      nroDocArca: Number(docLimpio),
    };
  }

  const tope =
    params.topeConsumidorFinalCentavos ??
    TOPE_IDENTIFICACION_CONSUMIDOR_FINAL_CENTAVOS;

  if (!docLimpio) {
    if (params.totalCentavos >= tope) {
      return {
        valido: false,
        tipoDocArca: 99,
        nroDocArca: 0,
        motivo: `El monto (${formatearMonedaARS(params.totalCentavos)}) supera el tope reglamentario de Consumidor Final (${formatearMonedaARS(tope)}). Debe informar DNI o CUIT del cliente.`,
      };
    }
    return {
      valido: true,
      tipoDocArca: 99,
      nroDocArca: 0,
    };
  }

  if (docLimpio.length === 11) {
    if (!validarCuitModulo11(docLimpio)) {
      return {
        valido: false,
        tipoDocArca: 80,
        nroDocArca: 0,
        motivo: `El CUIT del cliente (${params.cuitDniReceptor}) no supera la validación de dígito verificador módulo 11.`,
      };
    }
    return {
      valido: true,
      tipoDocArca: 80,
      nroDocArca: Number(docLimpio),
    };
  }

  if (docLimpio.length >= 7 && docLimpio.length <= 8) {
    return {
      valido: true,
      tipoDocArca: 96,
      nroDocArca: Number(docLimpio),
    };
  }

  return {
    valido: false,
    tipoDocArca: 99,
    nroDocArca: 0,
    motivo:
      'El documento del cliente debe ser un DNI válido (7 a 8 dígitos) o un CUIT válido (11 dígitos).',
  };
}

/**
 * Reglas 8, 18 y 19 (PLAN.md §3 y §6.3):
 * Verifica que la configuración ARCA guardada en el cliente jamás contenga certificados digitales (.crt/.key),
 * claves privadas ni tokens secretos. Las credenciales viven únicamente en los secretos de la Edge Function.
 */
export function validarConfiguracionArcaCliente(params: {
  readonly arcaHabilitada: boolean;
  readonly cuitEmisor?: string | null;
  readonly puntoVenta?: number | null;
  readonly ambiente?: string | null;
  readonly proveedor?: string | null;
  readonly camposExtra?: Record<string, unknown>;
}): { valido: boolean; motivo?: string } {
  if (params.camposExtra) {
    const jsonExtra = JSON.stringify(params.camposExtra);
    if (
      /-----BEGIN (RSA |EC )?(PRIVATE KEY|CERTIFICATE)-----/i.test(jsonExtra) ||
      /(cert_pem|key_pem|private_key|arca_secret|afip_token|service_role|sb_secret)/i.test(
        jsonExtra
      )
    ) {
      return {
        valido: false,
        motivo:
          'SEGURIDAD_ARCA (Regla 18 y 19): Las credenciales, tokens y certificados digitales de ARCA nunca pueden guardarse en el cliente ni en la base local. Deben configurarse como secretos en la Edge Function de Supabase.',
      };
    }
  }

  if (!params.arcaHabilitada) {
    return { valido: true };
  }

  const cuitLimpio = normalizarDocumentoArgentino(params.cuitEmisor ?? '');
  if (cuitLimpio.length !== 11 || !validarCuitModulo11(cuitLimpio)) {
    return {
      valido: false,
      motivo:
        'Para activar la facturación electrónica ARCA debés ingresar un CUIT del comercio válido de 11 dígitos (módulo 11).',
    };
  }

  const ptoVta = Number(params.puntoVenta ?? 0);
  if (!Number.isInteger(ptoVta) || ptoVta < 1 || ptoVta > 99999) {
    return {
      valido: false,
      motivo:
        'El punto de venta electrónico de ARCA debe ser un número entero entre 1 y 99999.',
    };
  }

  if (
    params.ambiente !== 'homologacion' &&
    params.ambiente !== 'produccion'
  ) {
    return {
      valido: false,
      motivo:
        'El ambiente de ARCA debe ser "homologacion" (pruebas) o "produccion".',
    };
  }

  return { valido: true };
}

export interface PayloadQrOficialArca {
  readonly ver: 1;
  readonly fecha: string; // YYYY-MM-DD
  readonly cuit: number;
  readonly ptoVta: number;
  readonly tipoCmp: number;
  readonly nroCmp: number;
  readonly importe: number;
  readonly moneda: 'PES';
  readonly ctz: 1;
  readonly tipoDocRec: 80 | 96 | 99;
  readonly nroDocRec: number;
  readonly tipoCodAut: 'E';
  readonly codAut: number;
}

function codificarTextoABase64(texto: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(texto, 'utf-8').toString('base64');
  }
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  for (const b of bytes) {
    binario += String.fromCharCode(b);
  }
  return btoa(binario);
}

/**
 * Construye el JSON oficial RG 4892/2020 y la URL pública `https://www.afip.gob.ar/fe/qr/?p=<base64>`
 * exigida por ARCA en todos los comprobantes electrónicos.
 * Nunca incluye claves privadas, tokens ni costos (Reglas 19 y 20).
 */
export function construirUrlQrOficialArca(params: {
  readonly fechaIso: string;
  readonly cuitEmisor: string;
  readonly puntoVenta: number;
  readonly tipoComprobante: TipoComprobanteFiscal;
  readonly numeroComprobante: number;
  readonly totalCentavos: Centavos;
  readonly cuitDniReceptor?: string | null;
  readonly cae: string;
}): {
  readonly payload: PayloadQrOficialArca;
  readonly base64Payload: string;
  readonly urlQrOficial: string;
} {
  asegurarCentavos(params.totalCentavos, 'totalCentavos');
  const cuitLimpio = normalizarDocumentoArgentino(params.cuitEmisor);
  if (cuitLimpio.length !== 11 || !validarCuitModulo11(cuitLimpio)) {
    throw new Error('El CUIT del emisor para el QR de ARCA es inválido.');
  }

  const caeLimpio = params.cae.replace(/\D/g, '');
  if (caeLimpio.length < 10) {
    throw new Error('El CAE para generar el QR oficial de ARCA es inválido.');
  }

  const tipoCmp = obtenerCodigoNumericoComprobanteArca(params.tipoComprobante);
  if (tipoCmp === 0) {
    throw new Error(
      'No corresponde generar QR fiscal de ARCA para un ticket no fiscal.'
    );
  }

  const docReceptor = normalizarDocumentoArgentino(
    params.cuitDniReceptor ?? ''
  );
  let tipoDocRec: 80 | 96 | 99 = 99;
  let nroDocRec = 0;
  if (docReceptor.length === 11) {
    tipoDocRec = 80;
    nroDocRec = Number(docReceptor);
  } else if (docReceptor.length >= 7 && docReceptor.length <= 8) {
    tipoDocRec = 96;
    nroDocRec = Number(docReceptor);
  }

  const fechaSoloDia = params.fechaIso.slice(0, 10);
  const importePesos = Number((params.totalCentavos / 100).toFixed(2));

  const payload: PayloadQrOficialArca = {
    ver: 1,
    fecha: fechaSoloDia,
    cuit: Number(cuitLimpio),
    ptoVta: Math.trunc(params.puntoVenta),
    tipoCmp,
    nroCmp: Math.trunc(params.numeroComprobante),
    importe: importePesos,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec,
    nroDocRec,
    tipoCodAut: 'E',
    codAut: Number(caeLimpio),
  };

  const json = JSON.stringify(payload);
  const base64Payload = codificarTextoABase64(json);
  const urlQrOficial = `https://www.afip.gob.ar/fe/qr/?p=${base64Payload}`;

  return {
    payload,
    base64Payload,
    urlQrOficial,
  };
}

/**
 * Genera el SVG del código QR oficial de ARCA listo para incrustar en facturas PDF y tickets térmicos.
 */
export function generarQrOficialArcaSvg(
  params: Parameters<typeof construirUrlQrOficialArca>[0],
  tamanoPx = 180
): {
  readonly payload: PayloadQrOficialArca;
  readonly urlQrOficial: string;
  readonly svg: string;
} {
  const { payload, urlQrOficial } = construirUrlQrOficialArca(params);
  const bytes = new TextEncoder().encode(urlQrOficial);
  const { svg } = generarQrSvgDesdeBytes(
    bytes,
    tamanoPx,
    'Código QR Oficial ARCA'
  );
  return {
    payload,
    urlQrOficial,
    svg,
  };
}

/**
 * Formatea Punto de Venta y Número de Comprobante en formato fiscal estándar `0001-00000001`.
 */
export function formatearNumeroComprobanteFiscal(
  puntoVenta: number | null | undefined,
  numeroComprobante: number | null | undefined
): string {
  const pv = String(Math.max(1, Math.trunc(puntoVenta ?? 1))).padStart(4, '0');
  const nro = String(Math.max(1, Math.trunc(numeroComprobante ?? 1))).padStart(
    8,
    '0'
  );
  return `${pv}-${nro}`;
}

export interface ItemComprobanteFiscal {
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precioUnitarioCentavos: Centavos;
  readonly descuentoCentavos?: Centavos;
  readonly subtotalCentavos: Centavos;
  readonly alicuotaIva: AlicuotaIva;
  readonly exentoIva?: boolean;
}

export interface DatosComprobanteFiscalImprimible {
  readonly comercioNombre: string;
  readonly comercioRazonSocial?: string | null;
  readonly comercioCuit: string;
  readonly comercioCondicionIva: CondicionIva;
  readonly comercioDomicilio?: string | null;
  readonly tipoComprobante: TipoComprobanteFiscal;
  readonly puntoVenta: number;
  readonly numeroComprobante: number;
  readonly fechaIso: string;
  readonly cae: string;
  readonly caeVencimientoIso: string;
  readonly ambiente: AmbienteArca;
  readonly clienteNombre?: string | null;
  readonly clienteCuitDni?: string | null;
  readonly clienteCondicionIva?: CondicionIva | null;
  readonly items: readonly ItemComprobanteFiscal[];
  readonly subtotalCentavos: Centavos;
  readonly descuentoGlobalCentavos: Centavos;
  readonly totalCentavos: Centavos;
}

/**
 * Genera el comprobante fiscal electrónico (HTML imprimible/PDF y texto térmico) con CAE,
 * vencimiento y QR oficial de ARCA.
 * Cumple estrictamente la Regla 20 (PLAN.md §3): jamás incluye `costo_compra`, `costo_unitario` ni ganancias.
 */
export function formatearComprobanteFiscalImprimible(
  datos: DatosComprobanteFiscalImprimible
): {
  readonly numeroFormateado: string;
  readonly letra: string;
  readonly codigoNumerico: string;
  readonly urlQrOficial: string;
  readonly qrSvg: string;
  readonly textoTermico: string;
  readonly htmlImprimible: string;
} {
  const numeroFormateado = formatearNumeroComprobanteFiscal(
    datos.puntoVenta,
    datos.numeroComprobante
  );
  const codigoNum = obtenerCodigoNumericoComprobanteArca(datos.tipoComprobante);
  const codigoNumerico = `COD. ${String(codigoNum).padStart(3, '0')}`;

  const mapaLetra: Record<TipoComprobanteFiscal, string> = {
    ticket_no_fiscal: 'X',
    factura_a: 'A',
    factura_b: 'B',
    factura_c: 'C',
    nota_credito_a: 'NC A',
    nota_credito_b: 'NC B',
    nota_credito_c: 'NC C',
  };
  const letra = mapaLetra[datos.tipoComprobante];

  const { urlQrOficial, svg: qrSvg } = generarQrOficialArcaSvg({
    fechaIso: datos.fechaIso,
    cuitEmisor: datos.comercioCuit,
    puntoVenta: datos.puntoVenta,
    tipoComprobante: datos.tipoComprobante,
    numeroComprobante: datos.numeroComprobante,
    totalCentavos: datos.totalCentavos,
    cuitDniReceptor: datos.clienteCuitDni ?? null,
    cae: datos.cae,
  });

  let netoTotalCentavos = 0;
  let ivaTotalCentavos = 0;
  for (const it of datos.items) {
    const desglose = desglosarIvaPorItem(
      it.subtotalCentavos,
      it.alicuotaIva,
      Boolean(it.exentoIva),
      true
    );
    netoTotalCentavos += desglose.neto;
    ivaTotalCentavos += desglose.iva;
  }

  const fechaEmision = formatearFechaHoraAR(datos.fechaIso);
  const fechaVtoCae = formatearFechaAR(datos.caeVencimientoIso);
  const etiquetaComprobante = datos.tipoComprobante
    .replace(/_/g, ' ')
    .toUpperCase();

  const lineas: string[] = [
    '========================================',
    datos.comercioRazonSocial || datos.comercioNombre,
    `CUIT: ${datos.comercioCuit} - IVA: ${datos.comercioCondicionIva.toUpperCase()}`,
    ...(datos.comercioDomicilio ? [`Domicilio: ${datos.comercioDomicilio}`] : []),
    '----------------------------------------',
    `${etiquetaComprobante} [${letra}] (${codigoNumerico})`,
    `Nro: ${numeroFormateado}`,
    `Fecha: ${fechaEmision}`,
    ...(datos.ambiente === 'homologacion'
      ? ['*** AMBIENTE HOMOLOGACION (SIN VALIDEZ FISCAL) ***']
      : []),
    '----------------------------------------',
    `Cliente: ${datos.clienteNombre || 'Consumidor Final'}`,
    ...(datos.clienteCuitDni ? [`Doc: ${datos.clienteCuitDni}`] : []),
    '----------------------------------------',
  ];

  for (const it of datos.items) {
    lineas.push(
      `${it.cantidad} x ${formatearMonedaARS(it.precioUnitarioCentavos)} (${it.alicuotaIva}%)`
    );
    lineas.push(`  ${it.descripcion}: ${formatearMonedaARS(it.subtotalCentavos)}`);
  }

  lineas.push('----------------------------------------');
  if (
    datos.tipoComprobante === 'factura_a' ||
    datos.tipoComprobante === 'nota_credito_a'
  ) {
    lineas.push(`Subtotal Neto Gravado: ${formatearMonedaARS(netoTotalCentavos)}`);
    lineas.push(`IVA Liquidado: ${formatearMonedaARS(ivaTotalCentavos)}`);
  } else if (
    datos.tipoComprobante === 'factura_b' ||
    datos.tipoComprobante === 'nota_credito_b'
  ) {
    lineas.push(
      `Régimen de Transparencia Fiscal (Ley 27.743) - IVA Contenido: ${formatearMonedaARS(ivaTotalCentavos)}`
    );
  }
  if (datos.descuentoGlobalCentavos > 0) {
    lineas.push(`Descuento: -${formatearMonedaARS(datos.descuentoGlobalCentavos)}`);
  }
  lineas.push(`TOTAL: ${formatearMonedaARS(datos.totalCentavos)}`);
  lineas.push('----------------------------------------');
  lineas.push(`CAE N°: ${datos.cae}`);
  lineas.push(`Vto. CAE: ${fechaVtoCae}`);
  lineas.push(`QR ARCA: ${urlQrOficial}`);
  lineas.push('========================================');

  const filasHtml = datos.items
    .map(
      (it) =>
        `<tr>
          <td>${it.descripcion}</td>
          <td style="text-align:right">${it.cantidad}</td>
          <td style="text-align:right">${formatearMonedaARS(it.precioUnitarioCentavos)}</td>
          <td style="text-align:right">${it.exentoIva ? 'Exento' : `${it.alicuotaIva}%`}</td>
          <td style="text-align:right">${formatearMonedaARS(it.subtotalCentavos)}</td>
        </tr>`
    )
    .join('');

  const htmlImprimible = `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="utf-8" />
  <title>${etiquetaComprobante} ${numeroFormateado}</title>
</head>
<body style="font-family: system-ui, sans-serif; color: #0f172a; max-width: 720px; margin: 0 auto; padding: 16px;">
  <header style="display:flex; justify-content:space-between; border-bottom: 2px solid #0f172a; padding-bottom: 12px;">
    <div>
      <h2 style="margin:0">${datos.comercioRazonSocial || datos.comercioNombre}</h2>
      <p style="margin:4px 0">CUIT: ${datos.comercioCuit} · Condición IVA: ${datos.comercioCondicionIva}</p>
      ${datos.comercioDomicilio ? `<p style="margin:4px 0">${datos.comercioDomicilio}</p>` : ''}
    </div>
    <div style="text-align:center; border: 2px solid #0f172a; padding: 8px 16px; border-radius: 6px;">
      <strong style="font-size: 24px;">${letra}</strong>
      <div style="font-size: 11px;">${codigoNumerico}</div>
    </div>
    <div style="text-align:right">
      <h3 style="margin:0">${etiquetaComprobante}</h3>
      <p style="margin:4px 0"><strong>N° ${numeroFormateado}</strong></p>
      <p style="margin:4px 0">Fecha: ${fechaEmision}</p>
    </div>
  </header>
  ${
    datos.ambiente === 'homologacion'
      ? '<div style="background:#fef3c7;color:#92400e;padding:6px 10px;margin-top:8px;font-weight:bold;text-align:center;">COMPROBANTE EMITIDO EN AMBIENTE DE HOMOLOGACIÓN (PRUEBAS)</div>'
      : ''
  }
  <section style="margin: 12px 0; padding: 8px; background: #f8fafc; border-radius: 6px;">
    <strong>Receptor:</strong> ${datos.clienteNombre || 'Consumidor Final'}
    ${datos.clienteCuitDni ? ` · <strong>CUIT/DNI:</strong> ${datos.clienteCuitDni}` : ''}
    ${datos.clienteCondicionIva ? ` · <strong>IVA:</strong> ${datos.clienteCondicionIva}` : ''}
  </section>
  <table style="width:100%; border-collapse:collapse; margin: 12px 0;">
    <thead>
      <tr style="border-bottom: 1px solid #cbd5e1;">
        <th style="text-align:left;padding:6px">Descripción</th>
        <th style="text-align:right;padding:6px">Cant.</th>
        <th style="text-align:right;padding:6px">P. Unitario</th>
        <th style="text-align:right;padding:6px">IVA</th>
        <th style="text-align:right;padding:6px">Subtotal</th>
      </tr>
    </thead>
    <tbody>${filasHtml}</tbody>
  </table>
  <footer style="display:flex; justify-content:space-between; align-items:center; border-top: 2px solid #0f172a; padding-top: 12px; margin-top: 12px;">
    <div style="display:flex; align-items:center; gap: 12px;">
      ${qrSvg}
      <div>
        <div><strong>Comprobante Autorizado por ARCA</strong></div>
        <div>CAE N°: <strong>${datos.cae}</strong></div>
        <div>Fecha Vto. CAE: <strong>${fechaVtoCae}</strong></div>
      </div>
    </div>
    <div style="text-align:right;">
      ${
        datos.tipoComprobante === 'factura_a' ||
        datos.tipoComprobante === 'nota_credito_a'
          ? `<div>Neto Gravado: ${formatearMonedaARS(netoTotalCentavos)}</div><div>IVA: ${formatearMonedaARS(ivaTotalCentavos)}</div>`
          : `<div>IVA Contenido (Ley 27.743): ${formatearMonedaARS(ivaTotalCentavos)}</div>`
      }
      <div style="font-size: 20px; font-weight: bold; margin-top: 6px;">TOTAL: ${formatearMonedaARS(datos.totalCentavos)}</div>
    </div>
  </footer>
</body>
</html>`;

  return {
    numeroFormateado,
    letra,
    codigoNumerico,
    urlQrOficial,
    qrSvg,
    textoTermico: lineas.join('\n'),
    htmlImprimible,
  };
}

// ============================================================================
// Extras de Fase 4: Balanzas EAN-13, Listas de Precio, Variantes y Combos
// ============================================================================

export interface ResultadoEscaneoBalanza {
  readonly esCodigoBalanza: boolean;
  readonly modo?: 'peso' | 'importe';
  readonly prefijo?: string;
  readonly codigoPlu?: string;
  /** Cantidad en kilogramos con 3 decimales exactos (cuando modo === 'peso'). */
  readonly cantidadKg?: number;
  /** Importe pesado en centavos enteros (cuando modo === 'importe'). */
  readonly importeCentavos?: Centavos;
}

/**
 * Calcula el dígito verificador estándar EAN-13 sobre los primeros 12 dígitos.
 */
export function calcularDigitoVerificadorEan13(doceDigitos: string): number {
  if (!/^\d{12}$/.test(doceDigitos)) {
    throw new Error('Se requieren exactamente 12 dígitos numéricos para EAN-13.');
  }
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const digito = Number(doceDigitos[i]);
    suma += i % 2 === 0 ? digito : digito * 3;
  }
  const resto = suma % 10;
  return resto === 0 ? 0 : 10 - resto;
}

/**
 * Construye un código EAN-13 de balanza válido de 13 dígitos (útil para pruebas y simulador de etiquetas):
 * - Prefijo `'20'` + 5 dígitos PLU + 5 dígitos de peso en gramos (`01250` = 1,250 kg) + dígito verificador.
 * - Prefijo `'21'` + 5 dígitos PLU + 5 dígitos de importe en pesos enteros (`02500` = $ 2.500,00) + dígito verificador.
 */
export function construirCodigoBarrasBalanzaEan13(params: {
  readonly prefijo: '20' | '21';
  readonly codigoPlu: string;
  readonly valorCincoDigitos: number;
}): string {
  const plu = params.codigoPlu.replace(/\D/g, '').padStart(5, '0').slice(-5);
  const val = String(Math.max(0, Math.trunc(params.valorCincoDigitos)))
    .padStart(5, '0')
    .slice(-5);
  const doce = `${params.prefijo}${plu}${val}`;
  const dv = calcularDigitoVerificadorEan13(doce);
  return `${doce}${dv}`;
}

/**
 * Decodifica un código de barras EAN-13 emitido por balanza comercial (PLAN.md §9 y §10):
 * - `20PPPPPPGGGGV`: `20` + 5 dígitos de PLU + 5 dígitos de peso en gramos (ej. `01250` -> `1.25 kg`) + dígito verificador.
 * - `21PPPPPPIIIIV`: `21` + 5 dígitos de PLU + 5 dígitos de importe en pesos (ej. `01500` -> `$ 1.500,00` = `150000` centavos) + dígito verificador.
 */
export function parsearCodigoBarrasBalanza(
  codigoInput: string
): ResultadoEscaneoBalanza {
  const limpio = codigoInput.trim();
  if (!/^\d{13}$/.test(limpio)) {
    return { esCodigoBalanza: false };
  }

  const prefijo = limpio.slice(0, 2);
  if (prefijo !== '20' && prefijo !== '21') {
    return { esCodigoBalanza: false };
  }

  const doce = limpio.slice(0, 12);
  const dvEsperado = calcularDigitoVerificadorEan13(doce);
  const dvActual = Number(limpio[12]);
  if (dvActual !== dvEsperado) {
    return { esCodigoBalanza: false };
  }

  const codigoPlu = limpio.slice(2, 7);
  const valorCinco = Number(limpio.slice(7, 12));
  if (valorCinco <= 0) {
    return { esCodigoBalanza: false };
  }

  if (prefijo === '20') {
    // Peso en gramos -> kilogramos con 3 decimales exactos
    const cantidadKg = desdeMiliunidades(valorCinco);
    return {
      esCodigoBalanza: true,
      modo: 'peso',
      prefijo: '20',
      codigoPlu,
      cantidadKg,
    };
  }

  // Prefijo 21: importe en pesos enteros -> centavos
  const importeCentavos = asegurarCentavos(valorCinco * 100, 'importeBalanza');
  return {
    esCodigoBalanza: true,
    modo: 'importe',
    prefijo: '21',
    codigoPlu,
    importeCentavos,
  };
}

/**
 * Resuelve el precio de venta de un producto en una lista de precios seleccionada
 * con fallback seguro al precio de la lista predeterminada y diferencial opcional de variante (PLAN.md §4 y §10).
 */
export function resolverPrecioProductoEnLista(params: {
  readonly precioPredeterminadoCentavos: Centavos;
  readonly preciosPorLista?: Readonly<Record<string, Centavos>>;
  readonly listaPrecioSeleccionadaId?: string | null;
  readonly precioAdicionalVarianteCentavos?: Centavos;
}): Centavos {
  asegurarCentavos(
    params.precioPredeterminadoCentavos,
    'precioPredeterminadoCentavos'
  );
  const adicional = params.precioAdicionalVarianteCentavos ?? 0;
  asegurarCentavos(adicional, 'precioAdicionalVarianteCentavos');

  const base =
    params.listaPrecioSeleccionadaId &&
    params.preciosPorLista &&
    params.preciosPorLista[params.listaPrecioSeleccionadaId] !== undefined
      ? params.preciosPorLista[params.listaPrecioSeleccionadaId]!
      : params.precioPredeterminadoCentavos;

  return Math.max(0, base + adicional);
}

export interface ComponenteComboInput {
  readonly productoId: string;
  readonly nombreProducto: string;
  readonly cantidadPorCombo: number;
  readonly precioUnitarioNormalCentavos: Centavos;
  readonly stockActualComponente: number;
}

export interface ResumenComboCalculado {
  readonly precioSumaNormalCentavos: Centavos;
  readonly precioComboCentavos: Centavos;
  readonly ahorroCentavos: Centavos;
  readonly porcentajeDescuento: number;
  /** Stock disponible de combos completos calculado desde el stock de sus componentes (Regla 4). */
  readonly stockCombosDisponibles: number;
}

/**
 * Calcula el stock máximo armable de un combo a partir del stock actual de sus productos componentes
 * y el ahorro frente a la compra individual (PLAN.md §4 Regla 4 y §10).
 */
export function calcularPrecioYStockCombo(params: {
  readonly componentes: readonly ComponenteComboInput[];
  readonly precioComboCentavos: Centavos;
}): ResumenComboCalculado {
  if (params.componentes.length === 0) {
    throw new Error('Un combo debe tener al menos un producto componente.');
  }
  asegurarCentavos(params.precioComboCentavos, 'precioComboCentavos');
  if (params.precioComboCentavos <= 0) {
    throw new Error('El precio de venta del combo debe ser mayor a cero.');
  }

  let sumaNormal = 0;
  let minCombosDisponibles = Number.POSITIVE_INFINITY;

  for (const comp of params.componentes) {
    if (comp.cantidadPorCombo <= 0) {
      throw new Error(
        `La cantidad requerida del componente "${comp.nombreProducto}" debe ser mayor a cero.`
      );
    }
    asegurarCentavos(
      comp.precioUnitarioNormalCentavos,
      'precioUnitarioNormalCentavos'
    );

    const miliCant = aMiliunidades(comp.cantidadPorCombo);
    const subtotalComp = Math.round(
      (miliCant * comp.precioUnitarioNormalCentavos) / 1000
    );
    sumaNormal += subtotalComp;

    const miliStock = aMiliunidades(Math.max(0, comp.stockActualComponente));
    const combosPorComponente = Math.floor(miliStock / miliCant);
    if (combosPorComponente < minCombosDisponibles) {
      minCombosDisponibles = combosPorComponente;
    }
  }

  const ahorroCentavos = Math.max(0, sumaNormal - params.precioComboCentavos);
  const porcentajeDescuento =
    sumaNormal > 0
      ? Number(((ahorroCentavos / sumaNormal) * 100).toFixed(2))
      : 0;

  return {
    precioSumaNormalCentavos: sumaNormal,
    precioComboCentavos: params.precioComboCentavos,
    ahorroCentavos,
    porcentajeDescuento,
    stockCombosDisponibles: Number.isFinite(minCombosDisponibles)
      ? minCombosDisponibles
      : 0,
  };
}
