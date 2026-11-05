import React, { useEffect, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import type { LibroIvaPeriodoResult } from '../../db/gestion_fase3_repo.ts';
import type { InformeGestionFase1 } from '../../db/informes_repo.ts';
import { aCentavos, formatearMonedaARS } from '../../domain/dinero.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';
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
  const [libroIva, setLibroIva] = useState<LibroIvaPeriodoResult | null>(null);
  const [mensajeExportacion, setMensajeExportacion] = useState<string | null>(
    null
  );
  const [paginaStockValorizado, setPaginaStockValorizado] = useState(1);
  const [paginaRentabilidad, setPaginaRentabilidad] = useState(1);

  async function cargarInformes() {
    try {
      const [data, ivaData] = await Promise.all([
        invocarPosApi<InformeGestionFase1>('obtener_informes_fase1', {
          rolActivo,
          fechaDesdeIso: `${fechaDesde}T00:00:00.000Z`,
          fechaHastaIso: `${fechaHasta}T23:59:59.999Z`,
        }),
        invocarPosApi<LibroIvaPeriodoResult>('obtener_libro_iva', {
          rolActivo,
          fechaDesdeIso: `${fechaDesde}T00:00:00.000Z`,
          fechaHastaIso: `${fechaHasta}T23:59:59.999Z`,
        }),
      ]);
      setInforme(data);
      setLibroIva(ivaData);
    } catch {
      // Fallback en entorno de pruebas sin servidor
    }
  }

  useEffect(() => {
    void cargarInformes();
  }, [rolActivo, fechaDesde, fechaHasta]);

  function descargarBlobXlsx(base64: string, nombreArchivo: string) {
    if (
      typeof window !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      const binario = atob(base64);
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
      a.download = nombreArchivo;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

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
      descargarBlobXlsx(
        res.xlsxBase64,
        `informes-gestion-${fechaDesde}-a-${fechaHasta}.xlsx`
      );

      setMensajeExportacion(
        `Archivo Excel (.xlsx, ${res.bytesLength} bytes) descargado y registrado en la auditoría de la base de datos.`
      );
    } catch {
      // Fallback
    }
  }

  async function manejarExportarLibroIvaXlsx() {
    try {
      const res = await invocarPosApi<{
        xlsxBase64: string;
        bytesLength: number;
        libro: LibroIvaPeriodoResult;
      }>('exportar_libro_iva_xlsx', {
        rolActivo,
        fechaDesdeIso: `${fechaDesde}T00:00:00.000Z`,
        fechaHastaIso: `${fechaHasta}T23:59:59.999Z`,
      });

      setLibroIva(res.libro);
      descargarBlobXlsx(
        res.xlsxBase64,
        `libro-iva-ventas-compras-${fechaDesde}-a-${fechaHasta}.xlsx`
      );

      setMensajeExportacion(
        `Libro IVA Ventas y Compras (.xlsx, ${res.bytesLength} bytes) exportado para el contador y auditado.`
      );
    } catch {
      // Fallback
    }
  }

  const balance = informe?.balancePeriodo ?? {
    ventasNetasCentavos: aCentavos(0),
    costoMercaderiaVendidaCentavos: aCentavos(0),
    gananciaBrutaCentavos: aCentavos(0),
    egresosCajaCentavos: aCentavos(0),
    resultadoNetoOperativoCentavos: aCentavos(0),
  };

  const rentabilidad = informe?.rentabilidad ?? {
    porProducto: [],
    ventasTotalesCentavos: aCentavos(0),
    costoMercaderiaVendidaCentavos: aCentavos(0),
    gananciaBrutaTotalCentavos: aCentavos(0),
    margenPromedioPorcentaje: 0,
  };

  const stockValorizado = informe?.stockValorizado ?? {
    items: [],
    cantidadProductosBajoMinimo: 0,
    totalValorizadoCostoCentavos: aCentavos(0),
    totalValorizadoVentaCentavos: aCentavos(0),
  };

  const paginacionRentabilidad = paginarListado(
    rentabilidad.porProducto,
    paginaRentabilidad,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  const paginacionStockValorizado = paginarListado(
    stockValorizado.items,
    paginaStockValorizado,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  const ivaVentas = libroIva?.ivaVentas ?? {
    filas: [],
    total_neto_gravado_centavos: aCentavos(0),
    total_iva_21_centavos: aCentavos(0),
    total_iva_105_centavos: aCentavos(0),
    total_iva_27_centavos: aCentavos(0),
    total_exento_centavos: aCentavos(0),
    total_general_centavos: aCentavos(0),
  };

  const ivaCompras = libroIva?.ivaCompras ?? {
    filas: [],
    total_neto_gravado_centavos: aCentavos(0),
    total_iva_21_centavos: aCentavos(0),
    total_iva_105_centavos: aCentavos(0),
    total_iva_27_centavos: aCentavos(0),
    total_exento_centavos: aCentavos(0),
    total_general_centavos: aCentavos(0),
  };

  return (
    <section className="pos-venta-wrapper">
      <div className="pos-card">
        <div className="card-header">
          <div>
            <h2>
              Informes de Gestión en Vivo (Superadmin y Encargado)
            </h2>
            <p className="text-muted">
              Ganancia bruta calculada con el costo histórico copiado en cada
              venta, stock valorizado y Libro IVA Ventas / Compras.
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
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void manejarExportarLibroIvaXlsx()}
            >
              Exportar Libro IVA Contador (.xlsx)
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

      {/* Libro IVA Ventas y Libro IVA Compras (Fase 3) */}
      <div className="panel-grid">
        <div className="pos-card">
          <h3>Libro IVA Ventas ({ivaVentas.filas.length} comprobantes)</h3>
          <div className="arqueo-box">
            <div className="arqueo-line">
              <span>Neto Gravado:</span>
              <strong>
                {formatearMonedaARS(ivaVentas.total_neto_gravado_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Débito Fiscal IVA 21%:</span>
              <strong>
                {formatearMonedaARS(ivaVentas.total_iva_21_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Débito Fiscal IVA 10,5%:</span>
              <strong>
                {formatearMonedaARS(ivaVentas.total_iva_105_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Débito Fiscal IVA 27%:</span>
              <strong>
                {formatearMonedaARS(ivaVentas.total_iva_27_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>No Gravado / Exento:</span>
              <strong>
                {formatearMonedaARS(ivaVentas.total_exento_centavos)}
              </strong>
            </div>
            <div className="arqueo-line destaque">
              <span>Total Libro IVA Ventas:</span>
              <strong>
                {formatearMonedaARS(ivaVentas.total_general_centavos)}
              </strong>
            </div>
          </div>
        </div>

        <div className="pos-card">
          <h3>Libro IVA Compras ({ivaCompras.filas.length} comprobantes)</h3>
          <div className="arqueo-box">
            <div className="arqueo-line">
              <span>Neto Gravado Compras:</span>
              <strong>
                {formatearMonedaARS(ivaCompras.total_neto_gravado_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Crédito Fiscal IVA 21%:</span>
              <strong>
                {formatearMonedaARS(ivaCompras.total_iva_21_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Crédito Fiscal IVA 10,5%:</span>
              <strong>
                {formatearMonedaARS(ivaCompras.total_iva_105_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>Crédito Fiscal IVA 27%:</span>
              <strong>
                {formatearMonedaARS(ivaCompras.total_iva_27_centavos)}
              </strong>
            </div>
            <div className="arqueo-line">
              <span>No Gravado / Exento:</span>
              <strong>
                {formatearMonedaARS(ivaCompras.total_exento_centavos)}
              </strong>
            </div>
            <div className="arqueo-line destaque">
              <span>Total Libro IVA Compras:</span>
              <strong>
                {formatearMonedaARS(ivaCompras.total_general_centavos)}
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
                paginacionRentabilidad.itemsPagina.map((p) => (
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
          <PaginadorTabla
            paginaActual={paginacionRentabilidad.paginaActual}
            totalPaginas={paginacionRentabilidad.totalPaginas}
            totalItems={paginacionRentabilidad.totalItems}
            desdeRegistro={paginacionRentabilidad.desdeRegistro}
            hastaRegistro={paginacionRentabilidad.hastaRegistro}
            tamanioPagina={paginacionRentabilidad.tamanioPagina}
            onCambiarPagina={setPaginaRentabilidad}
            etiquetaItems="productos vendidos"
          />
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
              {paginacionStockValorizado.itemsPagina.map((s) => (
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
          <PaginadorTabla
            paginaActual={paginacionStockValorizado.paginaActual}
            totalPaginas={paginacionStockValorizado.totalPaginas}
            totalItems={paginacionStockValorizado.totalItems}
            desdeRegistro={paginacionStockValorizado.desdeRegistro}
            hastaRegistro={paginacionStockValorizado.hastaRegistro}
            tamanioPagina={paginacionStockValorizado.tamanioPagina}
            onCambiarPagina={setPaginaStockValorizado}
            etiquetaItems="productos en stock"
          />
        </div>
      </div>
    </section>
  );
}
