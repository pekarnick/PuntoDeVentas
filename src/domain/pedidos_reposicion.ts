/**
 * Lógica pura de dominio para el armado automático de Pedidos de Reposición de productos
 * con stock bajo (`stock_actual <= stock_minimo`), agrupados por Proveedor, Marca o Categoría,
 * y su exportación a PDF (PLAN.md §3 Reglas 2, 4, 20; §6 y §10).
 */

import { aMiliunidades, desdeMiliunidades } from './cantidades.ts';
import {
  asegurarCentavos,
  formatearFechaHoraAR,
  formatearMonedaARS,
  type Centavos,
} from './dinero.ts';
import { generarDocumentoPdf, type SeccionTablaPdf } from './pdf.ts';
import { estaBajoStockMinimo } from './stock.ts';

export type CriterioAgrupacionPedido = 'proveedor' | 'marca' | 'categoria';

export const ID_GRUPO_SIN_ASIGNAR = '__sin_asignar__';

export interface ProductoParaPedidoInput {
  readonly id: string;
  readonly nombre: string;
  readonly codigo_interno?: string | null;
  readonly codigos_barras?: readonly string[];
  readonly unidad?: string;
  readonly stock_actual: number;
  readonly stock_minimo: number;
  readonly costo_compra?: Centavos;
  readonly precio_venta?: Centavos;
  readonly proveedor_id?: string | null;
  readonly proveedor_nombre?: string | null;
  readonly marca_id?: string | null;
  readonly marca_nombre?: string | null;
  readonly categoria_id?: string | null;
  readonly categoria_nombre?: string | null;
}

export interface ItemPedidoReposicion {
  readonly producto_id: string;
  readonly nombre: string;
  readonly codigo_mostrar: string;
  readonly unidad: string;
  readonly stock_actual: number;
  readonly stock_minimo: number;
  readonly faltante_stock: number;
  readonly cantidad_a_pedir: number;
  readonly costo_unitario_centavos: Centavos;
  readonly subtotal_costo_estimado_centavos: Centavos;
  readonly proveedor_id: string | null;
  readonly proveedor_nombre: string;
  readonly marca_id: string | null;
  readonly marca_nombre: string;
  readonly categoria_id: string | null;
  readonly categoria_nombre: string;
}

export interface GrupoPedidoReposicion {
  readonly criterio: CriterioAgrupacionPedido;
  readonly grupo_id: string;
  readonly grupo_nombre: string;
  readonly items: readonly ItemPedidoReposicion[];
  readonly cantidad_productos: number;
  readonly total_unidades_a_pedir: number;
  readonly costo_total_estimado_centavos: Centavos;
}

export interface ResumenPedidosReposicion {
  readonly criterio: CriterioAgrupacionPedido;
  readonly filtro_grupo_id: string | null;
  readonly grupos: readonly GrupoPedidoReposicion[];
  readonly total_grupos: number;
  readonly total_productos_bajo_stock: number;
  readonly total_unidades_general: number;
  readonly costo_total_general_centavos: Centavos;
}

/**
 * Calcula la cantidad sugerida a pedir para reponer un producto en o bajo su stock mínimo.
 * - Si `stock_actual < stock_minimo`, sugiere al menos la diferencia (`stock_minimo - stock_actual`)
 *   o el `stock_minimo` completo si el comercio desea reponer el lote base.
 * - Si `stock_actual === stock_minimo` (alerta preventiva en el límite), sugiere pedir `Math.max(1, stock_minimo)`.
 */
export function calcularCantidadSugeridaReposicion(
  stockActual: number,
  stockMinimo: number,
  cantidadPersonalizada?: number
): number {
  if (
    cantidadPersonalizada !== undefined &&
    Number.isFinite(cantidadPersonalizada) &&
    cantidadPersonalizada > 0
  ) {
    return desdeMiliunidades(aMiliunidades(cantidadPersonalizada));
  }

  const actualMili = aMiliunidades(stockActual);
  const minMili = aMiliunidades(stockMinimo);
  const faltanteMili = Math.max(0, minMili - actualMili);

  if (faltanteMili > 0) {
    return desdeMiliunidades(faltanteMili);
  }
  return desdeMiliunidades(Math.max(1000, minMili));
}

/**
 * Filtra del catálogo los productos que están en o por debajo de su `stock_minimo`
 * y construye los ítems de reposición con sus cantidades y costos estimados.
 */
export function construirItemsBajoStockParaPedido(
  productos: readonly ProductoParaPedidoInput[],
  cantidadesPersonalizadasPorProducto?: Readonly<Record<string, number>>
): ItemPedidoReposicion[] {
  const resultado: ItemPedidoReposicion[] = [];

  for (const p of productos) {
    if (!estaBajoStockMinimo(p.stock_actual, p.stock_minimo)) {
      continue;
    }

    const costoUnitario = p.costo_compra ?? 0;
    asegurarCentavos(costoUnitario, 'costo_compra');

    const faltante = desdeMiliunidades(
      Math.max(0, aMiliunidades(p.stock_minimo) - aMiliunidades(p.stock_actual))
    );
    const cantPersonalizada = cantidadesPersonalizadasPorProducto?.[p.id];
    const cantidadAPedir = calcularCantidadSugeridaReposicion(
      p.stock_actual,
      p.stock_minimo,
      cantPersonalizada
    );

    const cantMili = aMiliunidades(cantidadAPedir);
    const subtotalCosto = Math.round((cantMili * costoUnitario) / 1000);

    const codigoMostrar =
      (p.codigo_interno && p.codigo_interno.trim()) ||
      (p.codigos_barras && p.codigos_barras[0]) ||
      'S/C';

    resultado.push({
      producto_id: p.id,
      nombre: p.nombre,
      codigo_mostrar: codigoMostrar,
      unidad: p.unidad ?? 'unidad',
      stock_actual: p.stock_actual,
      stock_minimo: p.stock_minimo,
      faltante_stock: faltante,
      cantidad_a_pedir: cantidadAPedir,
      costo_unitario_centavos: costoUnitario,
      subtotal_costo_estimado_centavos: subtotalCosto,
      proveedor_id: p.proveedor_id ?? null,
      proveedor_nombre: p.proveedor_nombre?.trim() || 'Sin proveedor asignado',
      marca_id: p.marca_id ?? null,
      marca_nombre: p.marca_nombre?.trim() || 'Sin marca asignada',
      categoria_id: p.categoria_id ?? null,
      categoria_nombre: p.categoria_nombre?.trim() || 'Sin categoría asignada',
    });
  }

  // Ordenar por urgencia: menor stock_actual primero y luego alfabético por nombre
  resultado.sort((a, b) => {
    if (a.stock_actual !== b.stock_actual) {
      return a.stock_actual - b.stock_actual;
    }
    return a.nombre.localeCompare(b.nombre, 'es-AR');
  });

  return resultado;
}

/**
 * Agrupa automáticamente los productos con stock bajo por Proveedor, por Marca o por Categoría,
 * permitiendo opcionalmente filtrar un grupo específico (ej. un proveedor puntual, una marca o una categoría).
 */
export function agruparPedidoReposicionStockBajo(params: {
  readonly productos: readonly ProductoParaPedidoInput[];
  readonly criterio: CriterioAgrupacionPedido;
  readonly filtroGrupoId?: string | null;
  readonly cantidadesPersonalizadasPorProducto?: Readonly<Record<string, number>>;
}): ResumenPedidosReposicion {
  const itemsBajoStock = construirItemsBajoStockParaPedido(
    params.productos,
    params.cantidadesPersonalizadasPorProducto
  );

  const mapaGrupos = new Map<
    string,
    {
      grupo_id: string;
      grupo_nombre: string;
      items: ItemPedidoReposicion[];
      unidadesMili: number;
      costoCentavos: number;
    }
  >();

  for (const item of itemsBajoStock) {
    let grupoId: string;
    let grupoNombre: string;

    if (params.criterio === 'proveedor') {
      grupoId = item.proveedor_id || ID_GRUPO_SIN_ASIGNAR;
      grupoNombre = item.proveedor_nombre;
    } else if (params.criterio === 'marca') {
      grupoId = item.marca_id || ID_GRUPO_SIN_ASIGNAR;
      grupoNombre = item.marca_nombre;
    } else {
      grupoId = item.categoria_id || ID_GRUPO_SIN_ASIGNAR;
      grupoNombre = item.categoria_nombre;
    }

    if (
      params.filtroGrupoId &&
      params.filtroGrupoId.trim() !== '' &&
      params.filtroGrupoId !== 'todos' &&
      grupoId !== params.filtroGrupoId
    ) {
      continue;
    }

    const existente = mapaGrupos.get(grupoId) ?? {
      grupo_id: grupoId,
      grupo_nombre: grupoNombre,
      items: [],
      unidadesMili: 0,
      costoCentavos: 0,
    };

    existente.items.push(item);
    existente.unidadesMili += aMiliunidades(item.cantidad_a_pedir);
    existente.costoCentavos += item.subtotal_costo_estimado_centavos;
    mapaGrupos.set(grupoId, existente);
  }

  const grupos: GrupoPedidoReposicion[] = Array.from(mapaGrupos.values())
    .map((g) => ({
      criterio: params.criterio,
      grupo_id: g.grupo_id,
      grupo_nombre: g.grupo_nombre,
      items: g.items,
      cantidad_productos: g.items.length,
      total_unidades_a_pedir: desdeMiliunidades(g.unidadesMili),
      costo_total_estimado_centavos: g.costoCentavos,
    }))
    .sort((a, b) => {
      if (a.grupo_id === ID_GRUPO_SIN_ASIGNAR) return 1;
      if (b.grupo_id === ID_GRUPO_SIN_ASIGNAR) return -1;
      return a.grupo_nombre.localeCompare(b.grupo_nombre, 'es-AR');
    });

  let totalProductos = 0;
  let totalUnidadesMili = 0;
  let costoGeneral = 0;

  for (const g of grupos) {
    totalProductos += g.cantidad_productos;
    totalUnidadesMili += aMiliunidades(g.total_unidades_a_pedir);
    costoGeneral += g.costo_total_estimado_centavos;
  }

  return {
    criterio: params.criterio,
    filtro_grupo_id: params.filtroGrupoId ?? null,
    grupos,
    total_grupos: grupos.length,
    total_productos_bajo_stock: totalProductos,
    total_unidades_general: desdeMiliunidades(totalUnidadesMili),
    costo_total_general_centavos: costoGeneral,
  };
}

/**
 * Genera el archivo PDF (Uint8Array) listo para enviar al proveedor o imprimir,
 * organizado según el criterio elegido (`proveedor`, `marca` o `categoria`).
 */
export function generarPdfPedidoReposicion(params: {
  readonly resumen: ResumenPedidosReposicion;
  readonly comercioNombre?: string;
  readonly fechaIso?: string;
}): Uint8Array {
  const nombreComercio = params.comercioNombre?.trim() || 'Punto de Ventas';
  const fechaTexto = formatearFechaHoraAR(
    params.fechaIso ?? new Date().toISOString()
  );

  const etiquetaCriterio: Record<CriterioAgrupacionPedido, string> = {
    proveedor: 'Por Proveedor',
    marca: 'Por Marca',
    categoria: 'Por Categoría',
  };

  const etiquetaSingular: Record<CriterioAgrupacionPedido, string> = {
    proveedor: 'Proveedor',
    marca: 'Marca',
    categoria: 'Categoría',
  };

  const secciones: SeccionTablaPdf[] = params.resumen.grupos.map((grupo) => ({
    tituloSeccion: `${etiquetaSingular[params.resumen.criterio]}: ${grupo.grupo_nombre}`,
    subtituloSeccion: `${grupo.cantidad_productos} artículo(s) bajo stock mínimo · Unidades a pedir: ${grupo.total_unidades_a_pedir}`,
    columnas: [
      { encabezado: 'Código', anchoPuntos: 62, alineacion: 'left' },
      { encabezado: 'Producto', anchoPuntos: 165, alineacion: 'left' },
      {
        encabezado:
          params.resumen.criterio === 'proveedor'
            ? 'Marca / Cat.'
            : 'Proveedor',
        anchoPuntos: 90,
        alineacion: 'left',
      },
      { encabezado: 'Actual', anchoPuntos: 40, alineacion: 'right' },
      { encabezado: 'Mín.', anchoPuntos: 36, alineacion: 'right' },
      { encabezado: 'A Pedir', anchoPuntos: 44, alineacion: 'right' },
      { encabezado: 'Costo Unit.', anchoPuntos: 42, alineacion: 'right' },
      { encabezado: 'Subtotal', anchoPuntos: 44, alineacion: 'right' },
    ],
    filas: grupo.items.map((it) => [
      it.codigo_mostrar,
      it.nombre,
      params.resumen.criterio === 'proveedor'
        ? `${it.marca_nombre !== 'Sin marca asignada' ? it.marca_nombre : it.categoria_nombre}`
        : it.proveedor_nombre,
      `${it.stock_actual}`,
      `${it.stock_minimo}`,
      `${it.cantidad_a_pedir} ${it.unidad}`,
      formatearMonedaARS(it.costo_unitario_centavos),
      formatearMonedaARS(it.subtotal_costo_estimado_centavos),
    ]),
    pieSeccion: `Subtotal estimado (${grupo.grupo_nombre}): ${formatearMonedaARS(grupo.costo_total_estimado_centavos)}`,
  }));

  return generarDocumentoPdf({
    titulo: `ORDEN DE PEDIDO / REPOSICIÓN DE STOCK (${etiquetaCriterio[params.resumen.criterio].toUpperCase()})`,
    subtitulo: `${nombreComercio} · Fecha de emisión: ${fechaTexto}`,
    metadatosLineas: [
      `Agrupación: ${etiquetaCriterio[params.resumen.criterio]} · Grupos incluidos: ${params.resumen.total_grupos} · Artículos bajo stock mínimo: ${params.resumen.total_productos_bajo_stock}`,
    ],
    secciones,
    pieDocumento: `TOTAL GENERAL ESTIMADO DE REPOSICIÓN: ${formatearMonedaARS(params.resumen.costo_total_general_centavos)} (${params.resumen.total_unidades_general} unidades en ${params.resumen.total_productos_bajo_stock} productos)`,
  });
}
