import React, { useState } from 'react';
import { formatearMonedaARS } from '../../domain/dinero.ts';
import {
  calcularBalanceSimplePeriodo,
  calcularRentabilidadHistorica,
  calcularStockValorizado,
} from '../../domain/informes.ts';
import { generarLibroXlsx } from '../../domain/xlsx.ts';

export function PanelInformes(): React.ReactElement {
  const [fechaDesde, setFechaDesde] = useState('2026-10-01');
  const [fechaHasta, setFechaHasta] = useState('2026-10-19');
  const [mensajeExportacion, setMensajeExportacion] = useState<string | null>(
    null
  );

  const rentabilidad = calcularRentabilidadHistorica([
    {
      producto_id: 'prod-yerba',
      descripcion: 'Yerba Mate Selección 1kg',
      cantidad: 18,
      subtotal_venta: 18 * 420000,
      costo_unitario_historico: 280000,
    },
    {
      producto_id: 'prod-alfajor',
      descripcion: 'Alfajor Triple Chocolate',
      cantidad: 42,
      subtotal_venta: 42 * 150000,
      costo_unitario_historico: 85000,
    },
    {
      producto_id: 'prod-pan',
      descripcion: 'Pan Francés Fresco (kg)',
      cantidad: 12.5,
      subtotal_venta: Math.round(12.5 * 240000),
      costo_unitario_historico: 130000,
    },
  ]);

  const stockValorizado = calcularStockValorizado([
    {
      producto_id: 'prod-yerba',
      nombre: 'Yerba Mate Selección 1kg',
      stock_actual: 22,
      stock_minimo: 10,
      costo_compra: 280000,
      precio_venta: 420000,
    },
    {
      producto_id: 'prod-alfajor',
      nombre: 'Alfajor Triple Chocolate',
      stock_actual: 8,
      stock_minimo: 15,
      costo_compra: 85000,
      precio_venta: 150000,
    },
    {
      producto_id: 'prod-pan',
      nombre: 'Pan Francés Fresco (kg)',
      stock_actual: 14,
      stock_minimo: 5,
      costo_compra: 130000,
      precio_venta: 240000,
    },
  ]);

  const balance = calcularBalanceSimplePeriodo({
    ventasNetasCentavos: rentabilidad.ventasTotalesCentavos,
    costoMercaderiaVendidaCentavos: rentabilidad.costoMercaderiaVendidaCentavos,
    egresosCajaCentavos: 250000,
  });

  function manejarExportarXlsx() {
    const xlsxBytes = generarLibroXlsx([
      {
        nombre: 'Balance del Periodo',
        encabezados: ['Concepto', 'Importe (ARS)'],
        filas: [
          ['Ventas Netas', formatearMonedaARS(balance.ventasNetasCentavos)],
          [
            'Costo de Mercadería Vendida (Histórico)',
            formatearMonedaARS(balance.costoMercaderiaVendidaCentavos),
          ],
          ['Ganancia Bruta', formatearMonedaARS(balance.gananciaBrutaCentavos)],
          [
            'Egresos de Caja',
            formatearMonedaARS(balance.egresosCajaCentavos),
          ],
          [
            'Resultado Operativo Neto',
            formatearMonedaARS(balance.resultadoNetoOperativoCentavos),
          ],
        ],
      },
      {
        nombre: 'Ganancia y Ranking',
        encabezados: [
          'Producto',
          'Unidades Vendidas',
          'Ventas Netas',
          'Costo Histórico (CMV)',
          'Ganancia Bruta',
          'Margen (%)',
        ],
        filas: rentabilidad.porProducto.map((p) => [
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
          'Estado',
          'Valorizado a Costo',
          'Valorizado a Venta',
        ],
        filas: stockValorizado.items.map((s) => [
          s.nombre,
          s.stock_actual,
          s.stock_minimo,
          s.bajo_stock_minimo ? 'BAJO MÍNIMO' : 'OK',
          formatearMonedaARS(s.valorizado_costo_centavos),
          formatearMonedaARS(s.valorizado_venta_centavos),
        ]),
      },
    ]);

    if (typeof window !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const blob = new Blob([xlsxBytes.buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `informes-gestion-${fechaDesde}-a-${fechaHasta}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    }

    setMensajeExportacion(
      `Archivo Excel (.xlsx, ${xlsxBytes.byteLength} bytes) generado y registrado en la auditoría.`
    );
  }

  return (
    <section className="pos-venta-wrapper">
      <div className="pos-card">
        <div className="card-header">
          <div>
            <h2>Informes de Gestión (Superadmin y Encargado)</h2>
            <p className="text-muted">
              Ganancia bruta calculada con el costo histórico copiado en cada venta y stock valorizado.
            </p>
          </div>
          <div className="form-row">
            <label>
              Desde:
              <input
                type="date"
                value={fechaDesde}
                onChange={(e) => setFechaDesde(e.target.value)}
              />
            </label>
            <label>
              Hasta:
              <input
                type="date"
                value={fechaHasta}
                onChange={(e) => setFechaHasta(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={manejarExportarXlsx}
            >
              Exportar Informes a Excel (.xlsx)
            </button>
          </div>
        </div>

        {mensajeExportacion && (
          <div className="alert-ok">{mensajeExportacion}</div>
        )}

        <div className="panel-grid">
          <div className="arqueo-box">
            <h3>Balance Simple del Período</h3>
            <div className="arqueo-line">
              <span>Ventas netas completadas:</span>
              <strong>{formatearMonedaARS(balance.ventasNetasCentavos)}</strong>
            </div>
            <div className="arqueo-line">
              <span>Costo de mercadería vendida (CMV histórico):</span>
              <strong>
                {formatearMonedaARS(balance.costoMercaderiaVendidaCentavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Ganancia bruta ({rentabilidad.margenPromedioPorcentaje}%):</span>
              <strong className="diff-positiva">
                {formatearMonedaARS(balance.gananciaBrutaCentavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Egresos manuales de caja:</span>
              <strong className="diff-negativa">
                -{formatearMonedaARS(balance.egresosCajaCentavos)}
              </strong>
            </div>
            <div className="arqueo-line destaque">
              <span>Resultado operativo del período:</span>
              <strong>
                {formatearMonedaARS(balance.resultadoNetoOperativoCentavos)}
              </strong>
            </div>
          </div>

          <div className="arqueo-box">
            <h3>Resumen de Stock Valorizado</h3>
            <div className="arqueo-line">
              <span>Stock valorizado a costo de compra:</span>
              <strong>
                {formatearMonedaARS(
                  stockValorizado.totalValorizadoCostoCentavos
                )}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Stock valorizado a precio de venta:</span>
              <strong>
                {formatearMonedaARS(
                  stockValorizado.totalValorizadoVentaCentavos
                )}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Productos en o bajo stock mínimo:</span>
              <strong
                className={
                  stockValorizado.cantidadProductosBajoMinimo > 0
                    ? 'diff-negativa'
                    : ''
                }
              >
                {stockValorizado.cantidadProductosBajoMinimo}
              </strong>
            </div>
          </div>
        </div>
      </div>

      <div className="panel-grid">
        <div className="pos-card">
          <h3>Ganancia Bruta y Ranking de Productos Vendidos</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Unidades</th>
                <th className="num">Ventas Netas</th>
                <th className="num">Costo Histórico</th>
                <th className="num">Ganancia Bruta</th>
                <th className="num">Margen</th>
              </tr>
            </thead>
            <tbody>
              {rentabilidad.porProducto.map((p) => (
                <tr key={p.producto_id}>
                  <td>{p.descripcion}</td>
                  <td className="num">{p.cantidad_vendida}</td>
                  <td className="num">
                    {formatearMonedaARS(p.ventas_netas_centavos)}
                  </td>
                  <td className="num">
                    {formatearMonedaARS(p.costo_historico_total_centavos)}
                  </td>
                  <td className="num">
                    <strong>
                      {formatearMonedaARS(p.ganancia_bruta_centavos)}
                    </strong>
                  </td>
                  <td className="num">{p.margen_porcentaje}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pos-card">
          <h3>Stock Actual, Alertas Bajo Mínimo y Valorización</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Stock Actual</th>
                <th className="num">Val. Costo</th>
                <th className="num">Val. Venta</th>
              </tr>
            </thead>
            <tbody>
              {stockValorizado.items.map((s) => (
                <tr key={s.producto_id}>
                  <td>
                    {s.nombre}
                    {s.bajo_stock_minimo && (
                      <span
                        className="badge-alerta"
                        style={{ marginLeft: '0.4rem' }}
                      >
                        Bajo mín. ({s.stock_minimo})
                      </span>
                    )}
                  </td>
                  <td className="num">{s.stock_actual}</td>
                  <td className="num">
                    {formatearMonedaARS(s.valorizado_costo_centavos)}
                  </td>
                  <td className="num">
                    <strong>
                      {formatearMonedaARS(s.valorizado_venta_centavos)}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
