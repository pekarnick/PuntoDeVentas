import React, { useState } from 'react';
import {
  formatearFechaHoraAR,
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from '../../domain/dinero.ts';
import { calcularArqueoCaja, type MedioPago } from '../../domain/totales.ts';

export interface MovimientoManualUI {
  readonly id: string;
  readonly fecha: string;
  readonly tipo: 'ingreso' | 'egreso';
  readonly concepto: string;
  readonly monto: Centavos;
  readonly medio: MedioPago;
}

export function PanelCaja(): React.ReactElement {
  const [cajaAbierta, setCajaAbierta] = useState(true);
  const [fechaApertura] = useState<string>(() => new Date().toISOString());
  const [montoInicialInput, setMontoInicialInput] = useState('15000,00');
  const [montoInicialCentavos, setMontoInicialCentavos] = useState<Centavos>(1500000);

  const [movimientos, setMovimientos] = useState<MovimientoManualUI[]>([
    {
      id: 'mov-1',
      fecha: new Date().toISOString(),
      tipo: 'egreso',
      concepto: 'Pago proveedor hielo',
      monto: 250000,
      medio: 'efectivo',
    },
  ]);

  const [pagosVentas] = useState<Array<{ medio: MedioPago; monto: Centavos }>>([
    { medio: 'efectivo', monto: 840000 },
    { medio: 'mercado_pago', monto: 520000 },
    { medio: 'debito', monto: 310000 },
    { medio: 'transferencia', monto: 190000 },
  ]);

  const [tipoMov, setTipoMov] = useState<'ingreso' | 'egreso'>('egreso');
  const [conceptoMov, setConceptoMov] = useState('');
  const [montoMovInput, setMontoMovInput] = useState('');
  const [efectivoContadoInput, setEfectivoContadoInput] = useState('20900,00');
  const [mensajeError, setMensajeError] = useState<string | null>(null);
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);

  let efectivoContadoCentavos = 0;
  try {
    efectivoContadoCentavos = efectivoContadoInput.trim()
      ? pesosACentavos(efectivoContadoInput)
      : 0;
  } catch {
    efectivoContadoCentavos = 0;
  }

  const arqueo = calcularArqueoCaja({
    montoInicial: montoInicialCentavos,
    pagosVentasCompletadas: pagosVentas,
    movimientosManuales: movimientos,
    efectivoContado: efectivoContadoCentavos,
  });

  function manejarAgregarMovimiento(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeExito(null);

    try {
      if (!conceptoMov.trim()) {
        throw new Error('Ingresá un concepto obligatorio para el movimiento de caja.');
      }
      const monto = pesosACentavos(montoMovInput);
      if (monto <= 0) {
        throw new Error('El importe debe ser mayor a $ 0,00.');
      }

      setMovimientos((prev) => [
        ...prev,
        {
          id: `mov-${Date.now()}`,
          fecha: new Date().toISOString(),
          tipo: tipoMov,
          concepto: conceptoMov.trim(),
          monto,
          medio: 'efectivo',
        },
      ]);
      setConceptoMov('');
      setMontoMovInput('');
      setMensajeExito('Movimiento registrado y auditado en la sesión de caja.');
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo registrar el movimiento.'
      );
    }
  }

  function manejarAbrirCaja(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeExito(null);
    try {
      const inicial = pesosACentavos(montoInicialInput);
      if (inicial < 0) {
        throw new Error('El monto inicial no puede ser negativo.');
      }
      setMontoInicialCentavos(inicial);
      setCajaAbierta(true);
      setMensajeExito('Sesión de caja abierta correctamente.');
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Importe inicial inválido.'
      );
    }
  }

  function manejarCerrarCaja() {
    setMensajeError(null);
    setCajaAbierta(false);
    setMensajeExito(
      `Caja cerrada y auditada. Diferencia de efectivo: ${formatearMonedaARS(arqueo.diferenciaEfectivo)}.`
    );
  }

  return (
    <section className="panel-grid">
      <div className="pos-card">
        <div className="card-header">
          <h2>Estado de Caja ({cajaAbierta ? 'Abierta' : 'Cerrada'})</h2>
          <span className="text-muted">
            Apertura: {formatearFechaHoraAR(fechaApertura)}
          </span>
        </div>

        {mensajeError && <div className="alert-error">{mensajeError}</div>}
        {mensajeExito && <div className="alert-ok">{mensajeExito}</div>}

        {!cajaAbierta ? (
          <form onSubmit={manejarAbrirCaja} className="form-inline">
            <label>
              Monto inicial en efectivo ($):
              <input
                type="text"
                value={montoInicialInput}
                onChange={(e) => setMontoInicialInput(e.target.value)}
                placeholder="15000,00"
              />
            </label>
            <button type="submit" className="btn-primary">
              Abrir Caja
            </button>
          </form>
        ) : (
          <form onSubmit={manejarAgregarMovimiento} className="form-stack">
            <h3>Registrar ingreso o egreso manual</h3>
            <div className="form-row">
              <label>
                Tipo:
                <select
                  value={tipoMov}
                  onChange={(e) =>
                    setTipoMov(e.target.value as 'ingreso' | 'egreso')
                  }
                >
                  <option value="egreso">Egreso / Retiro</option>
                  <option value="ingreso">Ingreso de cambio</option>
                </select>
              </label>
              <label>
                Concepto:
                <input
                  type="text"
                  value={conceptoMov}
                  onChange={(e) => setConceptoMov(e.target.value)}
                  placeholder="Ej. Pago proveedor o cambio chico"
                />
              </label>
              <label>
                Monto ($):
                <input
                  type="text"
                  value={montoMovInput}
                  onChange={(e) => setMontoMovInput(e.target.value)}
                  placeholder="1500,00"
                />
              </label>
              <button type="submit" className="btn-secondary">
                Registrar
              </button>
            </div>
          </form>
        )}

        <h3 className="section-subtitle">Movimientos manuales de la sesión</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha/Hora</th>
              <th>Tipo</th>
              <th>Concepto</th>
              <th className="num">Importe</th>
            </tr>
          </thead>
          <tbody>
            {movimientos.map((m) => (
              <tr key={m.id}>
                <td>{formatearFechaHoraAR(m.fecha)}</td>
                <td>{m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'}</td>
                <td>{m.concepto}</td>
                <td className="num">
                  {m.tipo === 'egreso' ? '-' : '+'} {formatearMonedaARS(m.monto)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pos-card">
        <h2>Arqueo y Cierre por Medio de Pago</h2>
        <p className="text-muted">
          Desglose de cobros de ventas completadas y cálculo de diferencia de efectivo.
        </p>

        <table className="data-table">
          <thead>
            <tr>
              <th>Medio de pago</th>
              <th className="num">Total cobrado</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Efectivo (ventas)</td>
              <td className="num">{formatearMonedaARS(arqueo.totalesPorMedio.efectivo)}</td>
            </tr>
            <tr>
              <td>Mercado Pago</td>
              <td className="num">{formatearMonedaARS(arqueo.totalesPorMedio.mercado_pago)}</td>
            </tr>
            <tr>
              <td>Transferencia</td>
              <td className="num">{formatearMonedaARS(arqueo.totalesPorMedio.transferencia)}</td>
            </tr>
            <tr>
              <td>Tarjeta de Débito</td>
              <td className="num">{formatearMonedaARS(arqueo.totalesPorMedio.debito)}</td>
            </tr>
            <tr>
              <td>Tarjeta de Crédito</td>
              <td className="num">{formatearMonedaARS(arqueo.totalesPorMedio.credito)}</td>
            </tr>
            <tr>
              <td>QR / Otros</td>
              <td className="num">
                {formatearMonedaARS(
                  arqueo.totalesPorMedio.qr + arqueo.totalesPorMedio.otro
                )}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="arqueo-box">
          <div className="arqueo-line">
            <span>Monto inicial:</span>
            <strong>{formatearMonedaARS(montoInicialCentavos)}</strong>
          </div>
          <div className="arqueo-line">
            <span>Efectivo esperado en cajón:</span>
            <strong>{formatearMonedaARS(arqueo.efectivoEsperado)}</strong>
          </div>
          <div className="arqueo-line">
            <label htmlFor="efectivo-contado">Efectivo físico contado ($):</label>
            <input
              id="efectivo-contado"
              type="text"
              value={efectivoContadoInput}
              onChange={(e) => setEfectivoContadoInput(e.target.value)}
              disabled={!cajaAbierta}
            />
          </div>
          <div className="arqueo-line destaque">
            <span>Diferencia de efectivo:</span>
            <strong
              className={
                arqueo.diferenciaEfectivo < 0
                  ? 'diff-negativa'
                  : arqueo.diferenciaEfectivo > 0
                    ? 'diff-positiva'
                    : ''
              }
            >
              {formatearMonedaARS(arqueo.diferenciaEfectivo)}
            </strong>
          </div>

          {cajaAbierta && (
            <button
              type="button"
              className="btn-primary full-width"
              onClick={manejarCerrarCaja}
            >
              Cerrar Caja y Guardar Arqueo
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
