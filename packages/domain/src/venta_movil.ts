/**
 * Lógica pura compartida para Venta Móvil Web (/web-pos, PLAN.md §6.2):
 * - Validación de URL pública para QR (Regla 19: nunca claves ni tokens en el QR).
 * - Generador puro ISO/IEC 18004 QR en SVG sin dependencias externas.
 * - Cálculo de carrito móvil sin exponer costo_compra (Regla 20).
 * - Formateo de comprobante móvil para pantalla y WhatsApp (Regla 20).
 */

import { aMiliunidades, validarCantidadProducto } from './cantidades.ts';
import {
  asegurarCentavos,
  formatearFechaHoraAR,
  formatearMonedaARS,
  type Centavos,
} from './dinero.ts';
import {
  desglosarIvaPorItem,
  validarPagosVenta,
  type AlicuotaIva,
  type MedioPago,
  type PagoVentaInput,
} from './totales.ts';

export interface ProductoCatalogoMovil {
  readonly id: string;
  readonly codigo_interno: string | null;
  readonly nombre: string;
  readonly unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja' | 'litro' | 'metro' | 'par';
  readonly permite_decimales: boolean;
  readonly precio_venta: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva: boolean;
  readonly boton_rapido: boolean;
  readonly imagen_path: string | null;
  readonly codigos_barras: readonly string[];
  readonly stock_actual: number;
}

export interface ItemPedidoMovilInput {
  readonly producto_id: string;
  readonly cantidad: number;
  readonly descuento?: Centavos;
}

export interface ItemVentaMovilCalculado {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precio_unitario: Centavos;
  readonly bruto: Centavos;
  readonly descuento: Centavos;
  readonly subtotal: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva: boolean;
  readonly neto_sin_iva: Centavos;
  readonly monto_iva: Centavos;
}

export interface ResumenVentaMovilCalculado {
  readonly items: readonly ItemVentaMovilCalculado[];
  readonly subtotal: Centavos;
  readonly descuento_global: Centavos;
  readonly total: Centavos;
}

/**
 * Regla 19 (PLAN.md §3 y §6.2):
 * El QR de la venta móvil contiene SOLO la URL pública, nunca claves, secretos ni tokens.
 */
export function validarUrlPublicaVentaMovil(urlInput: string): string {
  const limpia = urlInput.trim();
  if (!limpia) {
    throw new Error('La dirección web de Venta Móvil no puede estar vacía.');
  }

  let parsed: URL;
  try {
    parsed = new URL(limpia);
  } catch {
    throw new Error(`Dirección web inválida: "${limpia}".`);
  }

  const esLocalhost =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && esLocalhost)) {
    throw new Error(
      'La dirección de Venta Móvil debe usar HTTPS obligatorio (salvo localhost en desarrollo).'
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      'SEGURIDAD_QR (Regla 19): La dirección web no puede incluir usuario ni contraseña.'
    );
  }

  const patronProhibido =
    /(token|key|apikey|api_key|secret|anon|jwt|password|clave|service_role|sb_secret|auth|bearer)/i;

  if (
    patronProhibido.test(parsed.search) ||
    patronProhibido.test(parsed.hash) ||
    patronProhibido.test(parsed.pathname)
  ) {
    throw new Error(
      'SEGURIDAD_QR (Regla 19): El código QR debe contener únicamente la URL pública, nunca claves ni tokens.'
    );
  }

  return parsed.toString();
}

/**
 * Calcula los totales de una venta móvil a partir de los precios oficiales del catálogo.
 * Ignora cualquier precio que pudiera venir del cliente y nunca incluye costo_compra (Regla 20).
 */
export function calcularVentaMovilDesdeCatalogo(params: {
  itemsPedido: readonly ItemPedidoMovilInput[];
  catalogoPorId: ReadonlyMap<string, ProductoCatalogoMovil>;
  descuentoGlobal?: Centavos;
  preciosIncluyenIva?: boolean;
  pagos?: readonly PagoVentaInput[];
}): ResumenVentaMovilCalculado {
  const {
    itemsPedido,
    catalogoPorId,
    descuentoGlobal = 0,
    preciosIncluyenIva = true,
    pagos,
  } = params;

  if (itemsPedido.length === 0) {
    throw new Error('El carrito móvil debe tener al menos un producto.');
  }
  asegurarCentavos(descuentoGlobal, 'descuentoGlobal');
  if (descuentoGlobal < 0) {
    throw new Error('El descuento no puede ser negativo.');
  }

  const itemsCalculados: ItemVentaMovilCalculado[] = [];

  for (const pedido of itemsPedido) {
    const prod = catalogoPorId.get(pedido.producto_id);
    if (!prod) {
      throw new Error(
        `El producto "${pedido.producto_id}" no existe o no está disponible para la venta.`
      );
    }

    validarCantidadProducto(pedido.cantidad, prod.permite_decimales);
    asegurarCentavos(prod.precio_venta, 'precio_venta');

    const descuentoItem = pedido.descuento ?? 0;
    asegurarCentavos(descuentoItem, 'descuentoItem');
    if (descuentoItem < 0) {
      throw new Error('El descuento por ítem no puede ser negativo.');
    }

    const cantidadMili = aMiliunidades(pedido.cantidad);
    const bruto = Math.round((cantidadMili * prod.precio_venta) / 1000);
    if (descuentoItem > bruto) {
      throw new Error(
        `El descuento del producto "${prod.nombre}" no puede superar su subtotal.`
      );
    }

    const subtotalBase = bruto - descuentoItem;
    const desglose = desglosarIvaPorItem(
      subtotalBase,
      prod.alicuota_iva,
      prod.exento_iva,
      preciosIncluyenIva
    );

    itemsCalculados.push({
      producto_id: prod.id,
      descripcion: prod.nombre,
      cantidad: pedido.cantidad,
      precio_unitario: prod.precio_venta,
      bruto,
      descuento: descuentoItem,
      subtotal: desglose.total,
      alicuota_iva: prod.alicuota_iva,
      exento_iva: prod.exento_iva,
      neto_sin_iva: desglose.neto,
      monto_iva: desglose.iva,
    });
  }

  const subtotal = itemsCalculados.reduce((acc, it) => acc + it.subtotal, 0);
  if (descuentoGlobal > subtotal) {
    throw new Error('El descuento global no puede superar el subtotal de la venta.');
  }

  const total = subtotal - descuentoGlobal;

  if (pagos) {
    validarPagosVenta(pagos, total);
  }

  return {
    items: itemsCalculados,
    subtotal,
    descuento_global: descuentoGlobal,
    total,
  };
}

export interface DatosComprobanteMovil {
  readonly venta_id: string;
  readonly fecha_iso: string;
  readonly comercio_nombre: string;
  readonly comercio_cuit?: string | null;
  readonly comercio_domicilio?: string | null;
  readonly vendedor_nombre: string;
  readonly cliente_nombre?: string | null;
  readonly cliente_cuit_dni?: string | null;
  readonly items: readonly {
    readonly descripcion: string;
    readonly cantidad: number;
    readonly precio_unitario: Centavos;
    readonly subtotal: Centavos;
  }[];
  readonly subtotal: Centavos;
  readonly descuento: Centavos;
  readonly total: Centavos;
  readonly pagos: readonly {
    readonly medio: MedioPago;
    readonly monto: Centavos;
  }[];
}

/**
 * Formatea un comprobante de venta móvil para compartir por WhatsApp o mostrar en pantalla.
 * Cumple estrictamente la Regla 20: jamás incluye costo_compra ni ganancia.
 */
export function formatearComprobanteMovilWhatsApp(
  datos: DatosComprobanteMovil
): {
  textoPlano: string;
  urlWhatsApp: string;
} {
  const lineas: string[] = [];
  lineas.push(`*${datos.comercio_nombre.toUpperCase()}*`);
  if (datos.comercio_cuit) {
    lineas.push(`CUIT: ${datos.comercio_cuit}`);
  }
  if (datos.comercio_domicilio) {
    lineas.push(datos.comercio_domicilio);
  }
  lineas.push(`Fecha: ${formatearFechaHoraAR(datos.fecha_iso)}`);
  lineas.push(`Comprobante: #${datos.venta_id.slice(-8).toUpperCase()}`);
  lineas.push(`Atendió: ${datos.vendedor_nombre}`);
  if (datos.cliente_nombre) {
    lineas.push(
      `Cliente: ${datos.cliente_nombre}${
        datos.cliente_cuit_dni ? ` (${datos.cliente_cuit_dni})` : ''
      }`
    );
  }
  lineas.push('--------------------------------');

  for (const item of datos.items) {
    lineas.push(
      `${item.cantidad} x ${item.descripcion} (${formatearMonedaARS(
        item.precio_unitario
      )}) = *${formatearMonedaARS(item.subtotal)}*`
    );
  }

  lineas.push('--------------------------------');
  if (datos.descuento > 0) {
    lineas.push(`Subtotal: ${formatearMonedaARS(datos.subtotal)}`);
    lineas.push(`Descuento: -${formatearMonedaARS(datos.descuento)}`);
  }
  lineas.push(`*TOTAL: ${formatearMonedaARS(datos.total)}*`);

  const pagosTexto = datos.pagos
    .map((p) => `${p.medio.replace('_', ' ')}: ${formatearMonedaARS(p.monto)}`)
    .join(', ');
  lineas.push(`Pago: ${pagosTexto}`);
  lineas.push('¡Gracias por su compra!');

  const textoPlano = lineas.join('\n');
  const urlWhatsApp = `https://wa.me/?text=${encodeURIComponent(textoPlano)}`;

  return {
    textoPlano,
    urlWhatsApp,
  };
}

// ============================================================================
// Generador ISO/IEC 18004 QR Code puro en SVG (Byte mode, ECC Level L)
// ============================================================================

interface VersionInfoQr {
  readonly version: number;
  readonly size: number;
  readonly totalDataCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly numBlocksGroup1: number;
  readonly dataCodewordsGroup1: number;
  readonly numBlocksGroup2: number;
  readonly dataCodewordsGroup2: number;
  readonly alignmentCenters: readonly number[];
}

// Versiones 1 a 14 en nivel L (soporta hasta 458 bytes UTF-8, incluye QR oficial ARCA RG 4892/2020)
const VERSIONES_QR_L: readonly VersionInfoQr[] = [
  { version: 1, size: 21, totalDataCodewords: 19, ecCodewordsPerBlock: 7, numBlocksGroup1: 1, dataCodewordsGroup1: 19, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [] },
  { version: 2, size: 25, totalDataCodewords: 34, ecCodewordsPerBlock: 10, numBlocksGroup1: 1, dataCodewordsGroup1: 34, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 18] },
  { version: 3, size: 29, totalDataCodewords: 55, ecCodewordsPerBlock: 15, numBlocksGroup1: 1, dataCodewordsGroup1: 55, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 22] },
  { version: 4, size: 33, totalDataCodewords: 80, ecCodewordsPerBlock: 20, numBlocksGroup1: 1, dataCodewordsGroup1: 80, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 26] },
  { version: 5, size: 37, totalDataCodewords: 108, ecCodewordsPerBlock: 26, numBlocksGroup1: 1, dataCodewordsGroup1: 108, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 30] },
  { version: 6, size: 41, totalDataCodewords: 136, ecCodewordsPerBlock: 18, numBlocksGroup1: 2, dataCodewordsGroup1: 68, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 34] },
  { version: 7, size: 45, totalDataCodewords: 156, ecCodewordsPerBlock: 20, numBlocksGroup1: 2, dataCodewordsGroup1: 78, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 22, 38] },
  { version: 8, size: 49, totalDataCodewords: 194, ecCodewordsPerBlock: 24, numBlocksGroup1: 2, dataCodewordsGroup1: 97, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 24, 42] },
  { version: 9, size: 53, totalDataCodewords: 232, ecCodewordsPerBlock: 30, numBlocksGroup1: 2, dataCodewordsGroup1: 116, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 26, 46] },
  { version: 10, size: 57, totalDataCodewords: 274, ecCodewordsPerBlock: 18, numBlocksGroup1: 2, dataCodewordsGroup1: 68, numBlocksGroup2: 2, dataCodewordsGroup2: 69, alignmentCenters: [6, 28, 50] },
  { version: 11, size: 61, totalDataCodewords: 324, ecCodewordsPerBlock: 20, numBlocksGroup1: 4, dataCodewordsGroup1: 81, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 30, 54] },
  { version: 12, size: 65, totalDataCodewords: 370, ecCodewordsPerBlock: 24, numBlocksGroup1: 2, dataCodewordsGroup1: 92, numBlocksGroup2: 2, dataCodewordsGroup2: 93, alignmentCenters: [6, 32, 58] },
  { version: 13, size: 69, totalDataCodewords: 428, ecCodewordsPerBlock: 26, numBlocksGroup1: 4, dataCodewordsGroup1: 107, numBlocksGroup2: 0, dataCodewordsGroup2: 0, alignmentCenters: [6, 34, 62] },
  { version: 14, size: 73, totalDataCodewords: 461, ecCodewordsPerBlock: 30, numBlocksGroup1: 3, dataCodewordsGroup1: 115, numBlocksGroup2: 1, dataCodewordsGroup2: 116, alignmentCenters: [6, 26, 46, 66] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function calcularPolinomioGeneradorRs(grado: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < grado; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function calcularRestoReedSolomon(datos: Uint8Array, ecLen: number): Uint8Array {
  const gen = calcularPolinomioGeneradorRs(ecLen);
  const resto = new Uint8Array(ecLen);
  for (let i = 0; i < datos.length; i++) {
    const factor = datos[i]! ^ resto[0]!;
    resto.copyWithin(0, 1);
    resto[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) {
      resto[j] = (resto[j] ?? 0) ^ gfMul(gen[j + 1]!, factor);
    }
  }
  return resto;
}

function codificarDatosQrNivelL(bytes: Uint8Array): {
  info: VersionInfoQr;
  codewords: Uint8Array;
} {
  let infoSeleccionada: VersionInfoQr | undefined;
  for (const v of VERSIONES_QR_L) {
    const bitsLongitud = v.version <= 9 ? 8 : 16;
    const capacidadBytes = Math.floor((v.totalDataCodewords * 8 - 4 - bitsLongitud) / 8);
    if (bytes.length <= capacidadBytes) {
      infoSeleccionada = v;
      break;
    }
  }
  if (!infoSeleccionada) {
    throw new Error('La URL supera el tamaño máximo soportado por el generador QR.');
  }

  const bits: number[] = [];
  const pushBits = (valor: number, cantidad: number) => {
    for (let i = cantidad - 1; i >= 0; i--) {
      bits.push((valor >>> i) & 1);
    }
  };

  // Modo Byte = 0100
  pushBits(0b0100, 4);
  pushBits(bytes.length, infoSeleccionada.version <= 9 ? 8 : 16);
  for (const b of bytes) {
    pushBits(b, 8);
  }

  const maxBits = infoSeleccionada.totalDataCodewords * 8;
  const terminador = Math.min(4, maxBits - bits.length);
  pushBits(0, terminador);

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const dataBytes = new Uint8Array(infoSeleccionada.totalDataCodewords);
  const bytesActuales = bits.length / 8;
  for (let i = 0; i < bytesActuales; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | bits[i * 8 + b]!;
    }
    dataBytes[i] = val;
  }

  const pads = [0xec, 0x11];
  for (let i = bytesActuales; i < infoSeleccionada.totalDataCodewords; i++) {
    dataBytes[i] = pads[(i - bytesActuales) % 2]!;
  }

  // Dividir en bloques y calcular ECC
  const bloquesDatos: Uint8Array[] = [];
  const bloquesEc: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < infoSeleccionada.numBlocksGroup1; i++) {
    const bloque = dataBytes.subarray(offset, offset + infoSeleccionada.dataCodewordsGroup1);
    offset += infoSeleccionada.dataCodewordsGroup1;
    bloquesDatos.push(bloque);
    bloquesEc.push(calcularRestoReedSolomon(bloque, infoSeleccionada.ecCodewordsPerBlock));
  }
  for (let i = 0; i < infoSeleccionada.numBlocksGroup2; i++) {
    const bloque = dataBytes.subarray(offset, offset + infoSeleccionada.dataCodewordsGroup2);
    offset += infoSeleccionada.dataCodewordsGroup2;
    bloquesDatos.push(bloque);
    bloquesEc.push(calcularRestoReedSolomon(bloque, infoSeleccionada.ecCodewordsPerBlock));
  }

  const resultado: number[] = [];
  const maxDataLen = Math.max(
    infoSeleccionada.dataCodewordsGroup1,
    infoSeleccionada.dataCodewordsGroup2
  );
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of bloquesDatos) {
      if (i < b.length) resultado.push(b[i]!);
    }
  }
  for (let i = 0; i < infoSeleccionada.ecCodewordsPerBlock; i++) {
    for (const ec of bloquesEc) {
      resultado.push(ec[i]!);
    }
  }

  return {
    info: infoSeleccionada,
    codewords: new Uint8Array(resultado),
  };
}

/**
 * Genera la matriz booleana y el SVG de un código QR estándar a partir de bytes UTF-8.
 */
export function generarQrSvgDesdeBytes(
  bytes: Uint8Array,
  tamanoPx = 240,
  ariaLabel = 'Código QR Venta Móvil'
): {
  matriz: readonly (readonly boolean[])[];
  svg: string;
} {
  const { info, codewords } = codificarDatosQrNivelL(bytes);
  const n = info.size;

  const modulos: boolean[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => false)
  );
  const esFuncion: boolean[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => false)
  );

  const setFuncion = (r: number, c: number, val: boolean) => {
    if (r >= 0 && r < n && c >= 0 && c < n) {
      modulos[r]![c] = val;
      esFuncion[r]![c] = true;
    }
  };

  const dibujarFinder = (filaCentro: number, colCentro: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const val = dist !== 2 && dist !== 4;
        setFuncion(filaCentro + dy, colCentro + dx, val);
      }
    }
  };

  dibujarFinder(3, 3);
  dibujarFinder(3, n - 4);
  dibujarFinder(n - 4, 3);

  for (let i = 0; i < n; i++) {
    if (!esFuncion[6]![i]) setFuncion(6, i, i % 2 === 0);
    if (!esFuncion[i]![6]) setFuncion(i, 6, i % 2 === 0);
  }

  const centros = info.alignmentCenters;
  for (let i = 0; i < centros.length; i++) {
    for (let j = 0; j < centros.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centros.length - 1) ||
        (i === centros.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = centros[i]!;
      const cc = centros[j]!;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFuncion(cr + dy, cc + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reservar áreas de formato y módulo oscuro fijo
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      if (!esFuncion[8]![i]) setFuncion(8, i, false);
      if (!esFuncion[i]![8]) setFuncion(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    if (!esFuncion[8]![n - 1 - i]) setFuncion(8, n - 1 - i, false);
    if (!esFuncion[n - 1 - i]![8]) setFuncion(n - 1 - i, 8, false);
  }
  setFuncion(n - 8, 8, true);

  // Colocar bits de datos en zigzag
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? n - 1 - vert : vert;
        if (!esFuncion[r]![c]) {
          let bit = false;
          if (bitIdx < totalBits) {
            bit = ((codewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1) !== 0;
            bitIdx++;
          }
          // Máscara 0: (r + c) % 2 === 0
          if ((r + c) % 2 === 0) {
            bit = !bit;
          }
          modulos[r]![c] = bit;
        }
      }
    }
  }

  // Escribir bits de formato para ECC Level L (01) + Máscara 0 (000) -> 0x77c4
  const formatBits = 0x77c4;
  for (let i = 0; i <= 5; i++) setFuncion(8, i, ((formatBits >>> i) & 1) !== 0);
  setFuncion(8, 7, ((formatBits >>> 6) & 1) !== 0);
  setFuncion(8, 8, ((formatBits >>> 7) & 1) !== 0);
  setFuncion(7, 8, ((formatBits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) setFuncion(14 - i, 8, ((formatBits >>> i) & 1) !== 0);

  for (let i = 0; i < 8; i++) setFuncion(8, n - 1 - i, ((formatBits >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) setFuncion(n - 15 + i, 8, ((formatBits >>> i) & 1) !== 0);
  setFuncion(n - 8, 8, true);

  const margen = 4;
  const totalUnidades = n + margen * 2;
  const paths: string[] = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modulos[r]![c]) {
        paths.push(`M${c + margen},${r + margen}h1v1h-1z`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalUnidades} ${totalUnidades}" width="${tamanoPx}" height="${tamanoPx}" shape-rendering="crispEdges" role="img" aria-label="${ariaLabel}"><rect width="100%" height="100%" fill="#ffffff"/><path d="${paths.join('')}" fill="#0f172a"/></svg>`;

  return {
    matriz: modulos,
    svg,
  };
}

/**
 * Genera la matriz booleana y el SVG de un código QR estándar para la URL pública de Venta Móvil.
 * Valida previamente la Regla 19 (nunca claves ni tokens en la URL).
 */
export function generarQrSvgUrlPublica(
  urlPublica: string,
  tamanoPx = 240
): {
  urlValidada: string;
  matriz: readonly (readonly boolean[])[];
  svg: string;
} {
  const urlValidada = validarUrlPublicaVentaMovil(urlPublica);
  const bytes = new TextEncoder().encode(urlValidada);
  const { matriz, svg } = generarQrSvgDesdeBytes(
    bytes,
    tamanoPx,
    'Código QR Venta Móvil'
  );

  return {
    urlValidada,
    matriz,
    svg,
  };
}
