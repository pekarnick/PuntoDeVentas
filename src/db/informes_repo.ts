/**
 * Repositorio de Informes de Gestión de Fase 1 y exportación auditada a Excel (.xlsx).
 * Cumple PLAN.md §3 (reglas 11, 13, 20), §6.1, §7, §10 y §13.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  formatearFechaHoraAR,
  formatearMonedaARS,
  type Centavos,
} from '../domain/dinero.ts';
import {
  calcularBalanceSimplePeriodo,
  calcularRentabilidadHistorica,
  calcularStockValorizado,
  type ItemVendidoHistoricoInput,
  type ProductoStockValorizadoInput,
  type ResumenRentabilidadPeriodo,
  type ResumenStockValorizado,
} from '../domain/informes.ts';
import { exigirPermiso } from '../domain/permisos.ts';
import type { MedioPago } from '../domain/totales.ts';
import { generarLibroXlsx } from '../domain/xlsx.ts';
import {
  auditarExportacionInforme,
  consultarRegistrosAuditoria,
  type FiltrosAuditoria,
} from './usuarios_auth_repo.ts';
import type { ActorContexto } from './repositorios.ts';

export interface FiltrosPeriodoInforme {
  readonly fechaDesdeIso?: string;
  readonly fechaHastaIso?: string;
}

export interface ResumenVentasPorUsuario {
  readonly usuario_id: string;
  readonly usuario_nombre: string;
  readonly ventas_completadas: number;
  readonly ventas_anuladas: number;
  readonly total_descuentos_centavos: Centavos;
  readonly total_vendido_centavos: Centavos;
}

export interface InformeGestionFase1 {
  readonly ventasPorMedioPago: ReadonlyArray<{
    readonly medio: MedioPago;
    readonly total_centavos: Centavos;
  }>;
  readonly ventasPorUsuario: readonly ResumenVentasPorUsuario[];
  readonly rentabilidad: ResumenRentabilidadPeriodo;
  readonly stockValorizado: ResumenStockValorizado;
  readonly balancePeriodo: {
    readonly ventasNetasCentavos: Centavos;
    readonly costoMercaderiaVendidaCentavos: Centavos;
    readonly gananciaBrutaCentavos: Centavos;
    readonly egresosCajaCentavos: Centavos;
    readonly resultadoNetoOperativoCentavos: Centavos;
  };
}

/**
 * Obtiene todos los informes de gestión de la Fase 1 (solo permitido a superadmin y encargado, Reglas 11 y 20).
 */
export function obtenerInformeGestionFase1(
  db: DatabaseSync,
  actor: ActorContexto,
  filtros: FiltrosPeriodoInforme = {}
): InformeGestionFase1 {
  exigirPermiso(actor.rol, 'ver_informes_gestion');

  const condFechaVenta: string[] = ['v.comercio_id = ?', 'v.deleted_at IS NULL'];
  const paramsFechaVenta: Array<string> = [actor.comercio_id];

  if (filtros.fechaDesdeIso) {
    condFechaVenta.push('v.fecha >= ?');
    paramsFechaVenta.push(filtros.fechaDesdeIso);
  }
  if (filtros.fechaHastaIso) {
    condFechaVenta.push('v.fecha <= ?');
    paramsFechaVenta.push(filtros.fechaHastaIso);
  }

  const whereVentas = condFechaVenta.join(' AND ');

  // 1. Ventas por medio de pago (solo completadas)
  const ventasPorMedioPago = db
    .prepare(
      `SELECT
        vp.medio AS medio,
        COALESCE(SUM(vp.monto), 0) AS total_centavos
       FROM ventas_pagos vp
       INNER JOIN ventas v
         ON v.id = vp.venta_id AND v.comercio_id = vp.comercio_id
       WHERE ${whereVentas} AND v.estado = 'completada' AND vp.deleted_at IS NULL
       GROUP BY vp.medio
       ORDER BY total_centavos DESC`
    )
    .all(...paramsFechaVenta) as unknown as Array<{
    medio: MedioPago;
    total_centavos: Centavos;
  }>;

  // 2. Ventas, anulaciones y descuentos por usuario (PLAN.md §7)
  const ventasPorUsuario = db
    .prepare(
      `SELECT
        u.id AS usuario_id,
        u.nombre AS usuario_nombre,
        SUM(CASE WHEN v.estado = 'completada' THEN 1 ELSE 0 END) AS ventas_completadas,
        SUM(CASE WHEN v.estado = 'anulada' THEN 1 ELSE 0 END) AS ventas_anuladas,
        COALESCE(SUM(CASE WHEN v.estado = 'completada' THEN v.descuento ELSE 0 END), 0) AS total_descuentos_centavos,
        COALESCE(SUM(CASE WHEN v.estado = 'completada' THEN v.total ELSE 0 END), 0) AS total_vendido_centavos
       FROM ventas v
       INNER JOIN usuarios u ON u.id = v.usuario_id
       WHERE ${whereVentas}
       GROUP BY u.id, u.nombre
       ORDER BY total_vendido_centavos DESC`
    )
    .all(...paramsFechaVenta) as unknown as ResumenVentasPorUsuario[];

  // 3. Ítems vendidos con su costo_unitario histórico copiado al momento de la venta (PLAN.md §4 y §7)
  const filasItemsVendidos = db
    .prepare(
      `SELECT
        vi.producto_id,
        vi.descripcion,
        vi.cantidad,
        vi.subtotal AS item_subtotal,
        vi.costo_unitario,
        v.subtotal AS venta_subtotal,
        v.total AS venta_total
       FROM ventas_items vi
       INNER JOIN ventas v
         ON v.id = vi.venta_id AND v.comercio_id = vi.comercio_id
       WHERE ${whereVentas} AND v.estado = 'completada' AND vi.deleted_at IS NULL`
    )
    .all(...paramsFechaVenta) as unknown as Array<{
    producto_id: string;
    descripcion: string;
    cantidad: number;
    item_subtotal: Centavos;
    costo_unitario: Centavos;
    venta_subtotal: Centavos;
    venta_total: Centavos;
  }>;

  const itemsHistoricos: ItemVendidoHistoricoInput[] = filasItemsVendidos.map(
    (f) => {
      // Si la venta tuvo un descuento global, prorratearlo sobre el subtotal del ítem
      const factor =
        f.venta_subtotal > 0 ? f.venta_total / f.venta_subtotal : 1;
      const subtotalNeto = Math.round(f.item_subtotal * factor);
      return {
        producto_id: f.producto_id,
        descripcion: f.descripcion,
        cantidad: f.cantidad,
        subtotal_venta: subtotalNeto,
        costo_unitario_historico: f.costo_unitario,
      };
    }
  );

  const rentabilidad = calcularRentabilidadHistorica(itemsHistoricos);

  // 4. Stock actual, stock bajo mínimo y stock valorizado a costo y a precio de venta (PLAN.md §7)
  const filasStock = db
    .prepare(
      `SELECT
        p.id AS producto_id,
        p.nombre,
        COALESCE(s.stock_actual, 0) AS stock_actual,
        p.stock_minimo,
        p.costo_compra,
        COALESCE(v.precio_venta, 0) AS precio_venta
       FROM productos p
       LEFT JOIN vista_stock_actual s
         ON s.producto_id = p.id AND s.comercio_id = p.comercio_id
       LEFT JOIN vista_productos_venta v
         ON v.id = p.id AND v.comercio_id = p.comercio_id
       WHERE p.comercio_id = ? AND p.deleted_at IS NULL
       ORDER BY p.nombre ASC`
    )
    .all(actor.comercio_id) as unknown as ProductoStockValorizadoInput[];

  const stockValorizado = calcularStockValorizado(filasStock);

  // 5. Egresos manuales de caja en el período para el balance simple
  const condFechaCaja: string[] = [
    'cm.comercio_id = ?',
    "cm.tipo = 'egreso'",
    'cm.deleted_at IS NULL',
  ];
  const paramsFechaCaja: string[] = [actor.comercio_id];
  if (filtros.fechaDesdeIso) {
    condFechaCaja.push('cm.fecha >= ?');
    paramsFechaCaja.push(filtros.fechaDesdeIso);
  }
  if (filtros.fechaHastaIso) {
    condFechaCaja.push('cm.fecha <= ?');
    paramsFechaCaja.push(filtros.fechaHastaIso);
  }

  const rowEgresos = db
    .prepare(
      `SELECT COALESCE(SUM(cm.monto), 0) AS total_egresos
       FROM caja_movimientos cm
       WHERE ${condFechaCaja.join(' AND ')}`
    )
    .get(...paramsFechaCaja) as { total_egresos: Centavos };

  const balancePeriodo = calcularBalanceSimplePeriodo({
    ventasNetasCentavos: rentabilidad.ventasTotalesCentavos,
    costoMercaderiaVendidaCentavos: rentabilidad.costoMercaderiaVendidaCentavos,
    egresosCajaCentavos: rowEgresos.total_egresos,
  });

  return {
    ventasPorMedioPago,
    ventasPorUsuario,
    rentabilidad,
    stockValorizado,
    balancePeriodo,
  };
}

/**
 * Exporta todos los informes de gestión de la Fase 1 a un libro Excel (.xlsx) multipágina
 * y registra la exportación en la auditoría (PLAN.md §6.1, §7 y §13).
 */
export function exportarInformeGestionFase1AXlsx(
  db: DatabaseSync,
  actor: ActorContexto,
  filtros: FiltrosPeriodoInforme = {}
): {
  xlsxBytes: Uint8Array;
  informe: InformeGestionFase1;
} {
  const informe = obtenerInformeGestionFase1(db, actor, filtros);

  const xlsxBytes = generarLibroXlsx([
    {
      nombre: 'Balance del Periodo',
      encabezados: ['Concepto', 'Importe Formateado (ARS)', 'Centavos'],
      filas: [
        [
          'Ventas Netas Completadas',
          formatearMonedaARS(informe.balancePeriodo.ventasNetasCentavos),
          informe.balancePeriodo.ventasNetasCentavos,
        ],
        [
          'Costo de Mercadería Vendida (Histórico)',
          formatearMonedaARS(
            informe.balancePeriodo.costoMercaderiaVendidaCentavos
          ),
          informe.balancePeriodo.costoMercaderiaVendidaCentavos,
        ],
        [
          'Ganancia Bruta',
          formatearMonedaARS(informe.balancePeriodo.gananciaBrutaCentavos),
          informe.balancePeriodo.gananciaBrutaCentavos,
        ],
        [
          'Egresos Manuales de Caja',
          formatearMonedaARS(informe.balancePeriodo.egresosCajaCentavos),
          informe.balancePeriodo.egresosCajaCentavos,
        ],
        [
          'Resultado Operativo Neto',
          formatearMonedaARS(
            informe.balancePeriodo.resultadoNetoOperativoCentavos
          ),
          informe.balancePeriodo.resultadoNetoOperativoCentavos,
        ],
      ],
    },
    {
      nombre: 'Ganancia y Ranking',
      encabezados: [
        'Producto',
        'Unidades Vendidas',
        'Ventas Netas (ARS)',
        'Costo Histórico CMV (ARS)',
        'Ganancia Bruta (ARS)',
        'Margen (%)',
      ],
      filas: informe.rentabilidad.porProducto.map((p) => [
        p.descripcion,
        p.cantidad_vendida,
        formatearMonedaARS(p.ventas_netas_centavos),
        formatearMonedaARS(p.costo_historico_total_centavos),
        formatearMonedaARS(p.ganancia_bruta_centavos),
        p.margen_porcentaje,
      ]),
    },
    {
      nombre: 'Stock Valorizado',
      encabezados: [
        'Producto',
        'Stock Actual',
        'Stock Mínimo',
        'Estado Alerta',
        'Costo Compra Unit. (ARS)',
        'Precio Venta Unit. (ARS)',
        'Valorizado a Costo (ARS)',
        'Valorizado a Venta (ARS)',
      ],
      filas: informe.stockValorizado.items.map((s) => [
        s.nombre,
        s.stock_actual,
        s.stock_minimo,
        s.bajo_stock_minimo ? 'BAJO MÍNIMO' : 'OK',
        formatearMonedaARS(s.costo_compra),
        formatearMonedaARS(s.precio_venta),
        formatearMonedaARS(s.valorizado_costo_centavos),
        formatearMonedaARS(s.valorizado_venta_centavos),
      ]),
    },
    {
      nombre: 'Ventas por Usuario y Medio',
      encabezados: [
        'Tipo Agrupación',
        'Nombre / Medio',
        'Cant. Completadas',
        'Cant. Anuladas',
        'Total (ARS)',
      ],
      filas: [
        ...informe.ventasPorUsuario.map((u) => [
          'Usuario',
          u.usuario_nombre,
          u.ventas_completadas,
          u.ventas_anuladas,
          formatearMonedaARS(u.total_vendido_centavos),
        ]),
        ...informe.ventasPorMedioPago.map((m) => [
          'Medio de Pago',
          m.medio,
          '-',
          '-',
          formatearMonedaARS(m.total_centavos),
        ]),
      ],
    },
  ]);

  auditarExportacionInforme(db, actor, {
    nombreInforme: 'informe_gestion_fase1',
    formato: 'xlsx',
    filtrosAplicados: {
      fechaDesdeIso: filtros.fechaDesdeIso ?? null,
      fechaHastaIso: filtros.fechaHastaIso ?? null,
    },
  });

  return { xlsxBytes, informe };
}

/**
 * Exporta la auditoría del comercio a Excel (.xlsx) restringido a superadmin y auditando la exportación (PLAN.md §6.1).
 */
export function exportarAuditoriaAXlsx(
  db: DatabaseSync,
  actor: ActorContexto,
  filtros: FiltrosAuditoria = {}
): Uint8Array {
  const registros = consultarRegistrosAuditoria(db, actor, filtros);

  const xlsxBytes = generarLibroXlsx([
    {
      nombre: 'Auditoria SHA256',
      encabezados: [
        'Fecha/Hora (AR)',
        'Usuario',
        'Rol',
        'Terminal',
        'Acción',
        'Entidad',
        'ID Entidad',
        'Motivo',
        'Autorizado Por',
        'Hash Anterior',
        'Hash SHA-256',
      ],
      filas: registros.map((r) => [
        formatearFechaHoraAR(r.fecha_hora),
        r.usuario_nombre,
        r.rol,
        r.device_id,
        r.accion,
        r.entidad,
        r.entidad_id ?? '',
        r.motivo ?? '',
        r.autorizado_por_nombre ?? '',
        r.hash_prev,
        r.hash,
      ]),
    },
  ]);

  auditarExportacionInforme(db, actor, {
    nombreInforme: 'auditoria_sha256',
    formato: 'xlsx',
    filtrosAplicados: { ...filtros },
  });

  return xlsxBytes;
}
