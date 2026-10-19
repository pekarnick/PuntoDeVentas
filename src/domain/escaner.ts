/**
 * Lógica pura del lector de códigos de barras (modo teclado HID), atajos sin mouse y carrito de venta.
 * Cumple PLAN.md §6.1, §9 y §13 ("Con el lector y el teclado se puede completar una venta sin usar el mouse").
 */

import { aMiliunidades, desdeMiliunidades, validarCantidadProducto } from './cantidades.ts';
import { asegurarCentavos, type Centavos } from './dinero.ts';
import {
  calcularTotalesVenta,
  proyectarProductoParaVenta,
  type AlicuotaIva,
  type ResumenVentaCalculado,
} from './totales.ts';

export const UMBRAL_RAFAGA_MS_POR_TECLA = 55;
export const LARGO_MINIMO_CODIGO_RAFAGA = 4;

export interface ProductoCatalogoVenta {
  readonly id: string;
  readonly nombre: string;
  readonly codigo_interno?: string | null;
  readonly codigos_barras: readonly string[];
  readonly unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
  readonly permite_decimales: boolean;
  readonly precio_venta: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva: boolean;
  readonly boton_rapido?: boolean;
  readonly imagen_path?: string | null;
  readonly stock_actual?: number;
}

export interface ItemCarritoPOS {
  readonly producto_id: string;
  readonly descripcion: string;
  readonly unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
  readonly permite_decimales: boolean;
  readonly cantidad: number;
  readonly precio_unitario: Centavos;
  readonly descuento: Centavos;
  readonly alicuota_iva: AlicuotaIva;
  readonly exento_iva: boolean;
}

export interface EventoTeclaLector {
  readonly tecla: string;
  readonly timestampMs: number;
}

/**
 * Filtra y ordena productos del catálogo de venta que coinciden con el criterio escrito en el buscador
 * (por código de barras, código interno o palabras del nombre) para mostrar en el desplegable de sugerencias.
 */
export function filtrarSugerenciasCatalogoPOS(
  catalogo: readonly ProductoCatalogoVenta[],
  consultaRaw: string,
  limite = 8
): ProductoCatalogoVenta[] {
  const consulta = consultaRaw.trim().toLowerCase();
  if (!consulta) {
    return [];
  }

  const terminos = consulta.split(/\s+/).filter(Boolean);

  const coincidencias = catalogo.filter((prod) => {
    const textoProducto = [
      prod.nombre.toLowerCase(),
      (prod.codigo_interno ?? '').toLowerCase(),
      ...prod.codigos_barras.map((c) => c.toLowerCase()),
    ].join(' ');

    return terminos.every((t) => textoProducto.includes(t));
  });

  // Priorizar coincidencia exacta de código, luego prefijo del nombre, luego orden alfabético
  return coincidencias
    .sort((a, b) => {
      const aExacto =
        a.codigos_barras.some((c) => c.toLowerCase() === consulta) ||
        (a.codigo_interno ?? '').toLowerCase() === consulta;
      const bExacto =
        b.codigos_barras.some((c) => c.toLowerCase() === consulta) ||
        (b.codigo_interno ?? '').toLowerCase() === consulta;
      if (aExacto !== bExacto) return aExacto ? -1 : 1;

      const aPrefijo = a.nombre.toLowerCase().startsWith(consulta);
      const bPrefijo = b.nombre.toLowerCase().startsWith(consulta);
      if (aPrefijo !== bPrefijo) return aPrefijo ? -1 : 1;

      return a.nombre.localeCompare(b.nombre, 'es-AR');
    })
    .slice(0, limite);
}

/**
 * Determina si una secuencia de teclas finalizada en Enter proviene de un lector de códigos de barras
 * (varios caracteres en pocos milisegundos + Enter, PLAN.md §9).
 */
export function detectarEscaneoRafaga(
  eventos: readonly EventoTeclaLector[],
  umbralMsPorTecla: number = UMBRAL_RAFAGA_MS_POR_TECLA
): { esEscaneo: boolean; codigo: string; duracionTotalMs: number } {
  const imprimibles = eventos.filter(
    (e) => e.tecla.length === 1 && e.tecla !== '\r' && e.tecla !== '\n'
  );

  if (imprimibles.length < LARGO_MINIMO_CODIGO_RAFAGA) {
    return {
      esEscaneo: false,
      codigo: imprimibles.map((e) => e.tecla).join('').trim(),
      duracionTotalMs: 0,
    };
  }

  const primero = imprimibles[0]!;
  const ultimo = imprimibles[imprimibles.length - 1]!;
  const duracionTotalMs = Math.max(0, ultimo.timestampMs - primero.timestampMs);
  const promedioPorIntervalo = duracionTotalMs / (imprimibles.length - 1);

  return {
    esEscaneo: promedioPorIntervalo <= umbralMsPorTecla,
    codigo: imprimibles.map((e) => e.tecla).join('').trim(),
    duracionTotalMs,
  };
}

/**
 * Sanitiza un producto del catálogo para asegurar que en la pantalla de venta NUNCA viaje costo_compra (Regla 20).
 */
export function sanitizarProductoCatalogoParaPOS<
  T extends ProductoCatalogoVenta & { costo_compra?: unknown; margen_bp?: unknown },
>(producto: T): ProductoCatalogoVenta {
  const limpio = proyectarProductoParaVenta(producto);
  return {
    id: limpio.id,
    nombre: limpio.nombre,
    codigo_interno: limpio.codigo_interno ?? null,
    codigos_barras: [...limpio.codigos_barras],
    unidad: limpio.unidad,
    permite_decimales: limpio.permite_decimales,
    precio_venta: limpio.precio_venta,
    alicuota_iva: limpio.alicuota_iva,
    exento_iva: limpio.exento_iva,
    boton_rapido: Boolean(limpio.boton_rapido),
    imagen_path: limpio.imagen_path ?? null,
    ...(limpio.stock_actual !== undefined
      ? { stock_actual: limpio.stock_actual }
      : {}),
  };
}

/**
 * Agrega un producto al carrito o incrementa su cantidad si ya estaba presente.
 */
export function agregarProductoAlCarrito(
  carritoActual: readonly ItemCarritoPOS[],
  producto: ProductoCatalogoVenta,
  cantidadAAgregar = 1
): ItemCarritoPOS[] {
  validarCantidadProducto(cantidadAAgregar, producto.permite_decimales);
  asegurarCentavos(producto.precio_venta, 'precio_venta');

  const indiceExistente = carritoActual.findIndex(
    (it) => it.producto_id === producto.id
  );

  if (indiceExistente === -1) {
    return [
      ...carritoActual,
      {
        producto_id: producto.id,
        descripcion: producto.nombre,
        unidad: producto.unidad,
        permite_decimales: producto.permite_decimales,
        cantidad: desdeMiliunidades(aMiliunidades(cantidadAAgregar)),
        precio_unitario: producto.precio_venta,
        descuento: 0,
        alicuota_iva: producto.alicuota_iva,
        exento_iva: producto.exento_iva,
      },
    ];
  }

  return carritoActual.map((item, idx) => {
    if (idx !== indiceExistente) return item;
    const nuevaCantidad = desdeMiliunidades(
      aMiliunidades(item.cantidad) + aMiliunidades(cantidadAAgregar)
    );
    return {
      ...item,
      cantidad: nuevaCantidad,
    };
  });
}

/**
 * Modifica la cantidad de un ítem del carrito (si llega a <= 0, lo quita del carrito).
 */
export function actualizarCantidadEnCarrito(
  carritoActual: readonly ItemCarritoPOS[],
  productoId: string,
  nuevaCantidad: number
): ItemCarritoPOS[] {
  const mili = aMiliunidades(nuevaCantidad);
  if (mili <= 0) {
    return carritoActual.filter((it) => it.producto_id !== productoId);
  }

  return carritoActual.map((item) => {
    if (item.producto_id !== productoId) return item;
    validarCantidadProducto(nuevaCantidad, item.permite_decimales);
    return {
      ...item,
      cantidad: desdeMiliunidades(mili),
    };
  });
}

/**
 * Aplica un descuento en centavos a un ítem específico del carrito.
 */
export function aplicarDescuentoItemEnCarrito(
  carritoActual: readonly ItemCarritoPOS[],
  productoId: string,
  descuentoCentavos: Centavos
): ItemCarritoPOS[] {
  asegurarCentavos(descuentoCentavos, 'descuentoCentavos');
  if (descuentoCentavos < 0) {
    throw new Error('El descuento no puede ser negativo.');
  }

  return carritoActual.map((item) => {
    if (item.producto_id !== productoId) return item;
    const bruto = Math.round(
      (aMiliunidades(item.cantidad) * item.precio_unitario) / 1000
    );
    if (descuentoCentavos > bruto) {
      throw new Error('El descuento del ítem no puede superar su subtotal bruto.');
    }
    return {
      ...item,
      descuento: descuentoCentavos,
    };
  });
}

/**
 * Calcula los totales del carrito para la pantalla de venta (sin incluir ningún costo de compra, Regla 20).
 */
export function calcularResumenCarritoPOS(
  carrito: readonly ItemCarritoPOS[],
  descuentoGlobalCentavos: Centavos = 0
): Omit<ResumenVentaCalculado, 'costo_total' | 'ganancia_bruta' | 'margen_porcentaje'> {
  if (carrito.length === 0) {
    return {
      items: [],
      subtotal: 0,
      descuento_global: 0,
      total: 0,
      desglose_iva: [],
    };
  }

  const calculado = calcularTotalesVenta(
    carrito.map((it) => ({
      producto_id: it.producto_id,
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precio_unitario: it.precio_unitario,
      costo_unitario: 0, // En el carrito de cliente/cajero no se expone ni calcula costo_compra (Regla 20)
      descuento: it.descuento,
      alicuota_iva: it.alicuota_iva,
      exento_iva: it.exento_iva,
    })),
    descuentoGlobalCentavos,
    true
  );

  return {
    items: calculado.items,
    subtotal: calculado.subtotal,
    descuento_global: calculado.descuento_global,
    total: calculado.total,
    desglose_iva: calculado.desglose_iva,
  };
}

export type AccionAtajoPOS =
  | 'ENFOCAR_ENTRADA_LECTOR'
  | 'CONFIRMAR_COBRO_RAPIDO_EFECTIVO'
  | 'ABRIR_MODAL_PAGOS_MIXTOS'
  | 'ABRIR_DESCUENTO_GLOBAL'
  | 'INCREMENTAR_ULTIMO_ITEM'
  | 'DECREMENTAR_ULTIMO_ITEM'
  | 'VACIAR_O_CANCELAR';

/**
 * Resuelve atajos de teclado de la pantalla de venta para operar 100% sin mouse (PLAN.md §6.1 y §13).
 */
export function resolverAtajoTecladoPOS(evento: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
}): AccionAtajoPOS | null {
  switch (evento.key) {
    case 'F2':
      return 'ENFOCAR_ENTRADA_LECTOR';
    case 'F4':
      return 'CONFIRMAR_COBRO_RAPIDO_EFECTIVO';
    case 'F8':
      return 'ABRIR_DESCUENTO_GLOBAL';
    case 'F9':
      return 'ABRIR_MODAL_PAGOS_MIXTOS';
    case '+':
      return evento.ctrlKey ? 'INCREMENTAR_ULTIMO_ITEM' : null;
    case '-':
      return evento.ctrlKey ? 'DECREMENTAR_ULTIMO_ITEM' : null;
    case 'Escape':
      return 'VACIAR_O_CANCELAR';
    default:
      return null;
  }
}
