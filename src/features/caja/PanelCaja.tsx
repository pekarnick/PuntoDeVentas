import React, { useEffect, useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  formatearFechaHoraAR,
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from '../../domain/dinero.ts';
import type { RolUsuario } from '../../domain/permisos.ts';
import type { MedioPago } from '../../domain/totales.ts';

export interface EstadoCajaServidorUI {
  readonly sesion: {
    readonly id: string;
    readonly fecha_apertura: string;
    readonly monto_inicial: Centavos;
    readonly estado: 'abierta' | 'cerrada';
  };
  readonly totalesPorMedio: Record<MedioPago, Centavos>;
  readonly efectivoEsperado: Centavos;
  readonly movimientosManuales: ReadonlyArray<{
    readonly id: string;
    readonly fecha: string;
    readonly tipo: 'ingreso' | 'egreso';
    readonly concepto: string;
    readonly monto: Centavos;
    readonly medio: MedioPago;
  }>;
}

export interface PanelCajaProps {
  readonly rolActivo?: RolUsuario;
  readonly estadoCajaInicial?: EstadoCajaServidorUI | null;
  readonly onDatosActualizados?: () => void;
}

export function PanelCaja({
  rolActivo = 'superadmin',
  estadoCajaInicial = null,
  onDatosActualizados,
}: PanelCajaProps): React.ReactElement {
  const [estadoCaja, setEstadoCaja] = useState<EstadoCajaServidorUI | null>(
    estadoCajaInicial
  );

  useEffect(() => {
    setEstadoCaja(estadoCajaInicial);
  }, [estadoCajaInicial]);

  const [montoInicialInput, setMontoInicialInput] = useState('15000,00');
  const [tipoMov, setTipoMov] = useState<'ingreso' | 'egreso'>('egreso');
  const [conceptoMov, setConceptoMov] = useState('');
  const [montoMovInput, setMontoMovInput] = useState('');
  const [efectivoContadoInput, setEfectivoContadoInput] = useState('15000,00');
  const [mensajeError, setMensajeError] = useState<string | null>(null);
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);

  const cajaAbierta = estadoCaja?.sesion.estado === 'abierta';
  const montoInicialCentavos = estadoCaja?.sesion.monto_inicial ?? 1500000;
  const efectivoEsperado = estadoCaja?.efectivoEsperado ?? 1500000;
  const totalesPorMedio: Record<MedioPago, Centavos> =
    estadoCaja?.totalesPorMedio ?? {
      efectivo: 0,
      transferencia: 0,
      mercado_pago: 0,
      qr: 0,
      debito: 0,
      credito: 0,
      cuenta_corriente: 0,
      otro: 0,
    };

  let efectivoContadoCentavos = 0;
  try {
    efectivoContadoCentavos = efectivoContadoInput.trim()
      ? pesosACentavos(efectivoContadoInput)
      : 0;
  } catch {
    efectivoContadoCentavos = 0;
  }

  const diferenciaEfectivo = efectivoContadoCentavos - efectivoEsperado;

  async function manejarAgregarMovimiento(e: React.FormEvent) {
    e.preventDefault();
    if (!estadoCaja) return;
    setMensajeError(null);
    setMensajeExito(null);

    try {
      if (!conceptoMov.trim()) {
        throw new Error(
          'Ingresá un concepto obligatorio para el movimiento de caja.'
        );
      }
      const monto = pesosACentavos(montoMovInput);
      if (monto <= 0) {
        throw new Error('El importe debe ser mayor a $ 0,00.');
      }

      await invocarPosApi('movimiento_manual_caja', {
        rolActivo,
        cajaSesionId: estadoCaja.sesion.id,
        tipo: tipoMov,
        concepto: conceptoMov.trim(),
        montoCentavos: monto,
        medio: 'efectivo',
      });

      setConceptoMov('');
      setMontoMovInput('');
      setMensajeExito(
        'Movimiento guardado en la base de datos local y auditado en la sesión de caja.'
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo registrar el movimiento.'
      );
    }
  }

  async function manejarAbrirCaja(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeExito(null);
    try {
      const inicial = pesosACentavos(montoInicialInput);
      if (inicial < 0) {
        throw new Error('El monto inicial no puede ser negativo.');
      }
      await invocarPosApi('abrir_caja', {
        rolActivo,
        montoInicialCentavos: inicial,
      });
      setMensajeExito('Sesión de caja abierta correctamente.');
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Importe inicial inválido.'
      );
    }
  }

  async function manejarCerrarCaja() {
    if (!estadoCaja) return;
    setMensajeError(null);
    try {
      await invocarPosApi('cerrar_caja', {
        rolActivo,
        cajaSesionId: estadoCaja.sesion.id,
        efectivoContadoCentavos,
      });
      setMensajeExito(
        `Caja cerrada y auditada. Diferencia de efectivo: ${formatearMonedaARS(diferenciaEfectivo)}.`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo cerrar la caja.'
      );
    }
  }

  return (
    <section className="panel-grid">
      <div className="pos-card">
        <div className="card-header">
          <h2>Estado de Caja ({cajaAbierta ? 'Abierta' : 'Cerrada'})</h2>
          {estadoCaja && (
            <span className="text-muted">
              Apertura: {formatearFechaHoraAR(estadoCaja.sesion.fecha_apertura)}
            </span>
          )}
        </div>

        {mensajeError && <div className="alert-error">{mensajeError}</div>}
        {mensajeExito && <div className="alert-ok">{mensajeExito}</div>}

        {!cajaAbierta ? (
          <form
            onSubmit={(e) => void manejarAbrirCaja(e)}
            className="form-inline"
          >
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
          <form
            onSubmit={(e) => void manejarAgregarMovimiento(e)}
            className="form-stack"
          >
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
                Registrar Movimiento
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
            {(estadoCaja?.movimientosManuales ?? []).map((m) => (
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
          Desglose real de cobros de ventas completadas y cálculo de diferencia de efectivo.
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
              <td className="num">
                {formatearMonedaARS(totalesPorMedio.efectivo)}
              </td>
            </tr>
            <tr>
              <td>Mercado Pago</td>
              <td className="num">
                {formatearMonedaARS(totalesPorMedio.mercado_pago)}
              </td>
            </tr>
            <tr>
              <td>Transferencia</td>
              <td className="num">
                {formatearMonedaARS(totalesPorMedio.transferencia)}
              </td>
            </tr>
            <tr>
              <td>Tarjeta de Débito</td>
              <td className="num">
                {formatearMonedaARS(totalesPorMedio.debito)}
              </td>
            </tr>
            <tr>
              <td>Tarjeta de Crédito</td>
              <td className="num">
                {formatearMonedaARS(totalesPorMedio.credito)}
              </td>
            </tr>
            <tr>
              <td>QR / Otros</td>
              <td className="num">
                {formatearMonedaARS(totalesPorMedio.qr + totalesPorMedio.otro)}
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
            <strong>{formatearMonedaARS(efectivoEsperado)}</strong>
          </div>
          <div className="arqueo-line">
            <label htmlFor="efectivo-contado">
              Efectivo físico contado ($):
            </label>
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
                diferenciaEfectivo < 0
                  ? 'diff-negativa'
                  : diferenciaEfectivo > 0
                    ? 'diff-positiva'
                    : ''
              }
            >
              {formatearMonedaARS(diferenciaEfectivo)}
            </strong>
          </div>

          {cajaAbierta && (
            <button
              type="button"
              className="btn-primary full-width"
              onClick={() => void manejarCerrarCaja()}
            >
              Cerrar Caja y Guardar Arqueo
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
