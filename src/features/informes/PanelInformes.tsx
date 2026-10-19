import React, { useEffect, useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import type { InformeGestionFase1 } from '../../db/informes_repo.ts';
import { formatearMonedaARS } from '../../domain/dinero.ts';
import type { RolUsuario } from '../../domain/permisos.ts';

export interface PanelInformesProps {
  readonly rolActivo?: RolUsuario;
}

export function PanelInformes({
  rolActivo = 'superadmin',
}: PanelInformesProps): React.ReactElement {
  const [fechaDesde, setFechaDesde] = useState('2026-10-01');
  const [fechaHasta, setFechaHasta] = useState('2026-10-31');
  const [informe, setInforme] = useState<InformeGestionFase1 | null>(null);
  const [mensajeExportacion, setMensajeExportacion] = useState<string | null>(
    null
  );

  async function cargarInformes() {
    try {
      const data = await invocarPosApi<InformeGestionFase1>(
        'obtener_informes_fase1',
        {
          rolActivo,
          fechaDesdeIso: `${fechaDesde}T00:00:00.000Z`,
          fechaHastaIso: `${fechaHasta}T23:59:59.999Z`,
        }
      );
      setInforme(data);
    } catch {
      // Fallback
    }
  }

  useEffect(() => {
    void cargarInformes();
  }, [rolActivo, fechaDesde, fechaHasta]);

  async function manejarExportarXlsx() {
    try {
      const res = await invocarPosApi<{
        xlsxBase64: string;
        bytesLength: number;
        informe: InformeGestionFase1;
      }>('exportar_informes_xlsx', {
        rolActivo,
        fechaDesdeIso: `${fechaDesde}T00:00:00.000Z`,
        fechaHastaIso: `${fechaHasta}T23:59:59.999Z`,
      });

      setInforme(res.informe);

      if (
        typeof window !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        const binario = atob(res.xlsxBase64);
        const bytes = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) {
          bytes[i] = binario.charCodeAt(i);
        }
        const blob = new Blob([bytes.buffer], {
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
        `Archivo Excel (.xlsx, ${res.bytesLength} bytes) descargado y registrado en la auditoría de SQLite.`
      );
    } catch {
      // Fallback
    }
  }

  const balance = informe?.balancePeriodo ?? {
    ventasNetasCentavos: 0,
    costoMercaderiaVendidaCentavos: 0,
    gananciaBrutaCentavos: 0,
    egresosCajaCentavos: 0,
    resultadoNetoOperativoCentavos: 0,
  };

  const rentabilidad = informe?.rentabilidad ?? {
    porProducto: [],
    ventasTotalesCentavos: 0,
    costoMercaderiaVendidaCentavos: 0,
    gananciaBrutaTotalCentavos: 0,
    margenPromedioPorcentaje: 0,
  };

  const stockValorizado = informe?.stockValorizado ?? {
    items: [],
    cantidadProductosBajoMinimo: 0,
    totalValorizadoCostoCentavos: 0,
    totalValorizadoVentaCentavos: 0,
  };

  return (
    <section className="pos-venta-wrapper">
      <div className="pos-card">
        <div className="card-header">
          <div>
            <h2>Informes de Gestión en Vivo desde SQLite (Superadmin y Encargado)</h2>
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
              onClick={() => void manejarExportarXlsx()}
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
              <span>
                Ganancia bruta ({rentabilidad.margenPromedioPorcentaje}%):
              </span>
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
              {rentabilidad.porProducto.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    Todavía no hay ventas completadas en el rango seleccionado.
                  </td>
                </tr>
              ) : (
                rentabilidad.porProducto.map((p) => (
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
                ))
              )}
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
