import React, { useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  aCentavos,
  formatearFechaAR,
  formatearPesos,
  pesosACentavos,
} from '../../domain/dinero.ts';
import {
  validarDocumentoArgentino,
  type CondicionIvaReceptor,
} from '../../domain/cuit.ts';
import type { RolUsuario } from '../../domain/permisos.ts';
import type { MovimientoCcUI } from '../compras/PanelComprasProveedores.tsx';

export interface ClienteConSaldoUI {
  readonly id: string;
  readonly nombre: string;
  readonly documento: string | null;
  readonly condicion_iva: CondicionIvaReceptor;
  readonly telefono: string | null;
  readonly domicilio: string | null;
  readonly limite_credito_centavos: number;
  readonly total_cargos_centavos: number;
  readonly total_pagos_centavos: number;
  readonly saldo_pendiente_centavos: number;
  readonly credito_disponible_centavos: number;
}

export interface PanelClientesCuentaCorrienteProps {
  readonly rolActivo: RolUsuario;
  readonly clientesServidor?: readonly ClienteConSaldoUI[];
  readonly onDatosModificados?: () => void | Promise<void>;
}

const ETIQUETAS_CONDICION_IVA: Record<CondicionIvaReceptor, string> = {
  consumidor_final: 'Consumidor Final',
  monotributo: 'Responsable Monotributo',
  responsable_inscripto: 'IVA Responsable Inscripto',
  exento: 'IVA Sujeto Exento',
};

export function PanelClientesCuentaCorriente({
  rolActivo,
  clientesServidor = [],
  onDatosModificados,
}: PanelClientesCuentaCorrienteProps): React.ReactElement {
  const [nombre, setNombre] = useState('');
  const [documento, setDocumento] = useState('');
  const [condicionIva, setCondicionIva] =
    useState<CondicionIvaReceptor>('consumidor_final');
  const [telefono, setTelefono] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [limiteCreditoInput, setLimiteCreditoInput] = useState('50000');

  const [clienteDetalleId, setClienteDetalleId] = useState<string>('');
  const [movimientosCc, setMovimientosCc] = useState<readonly MovimientoCcUI[]>(
    []
  );
  const [tipoMovimientoInput, setTipoMovimientoInput] = useState<
    'pago' | 'cargo'
  >('pago');
  const [montoMovimientoInput, setMontoMovimientoInput] = useState('');
  const [obsMovimientoInput, setObsMovimientoInput] = useState('');

  const [mensajeExito, setMensajeExito] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const validacionEnVivo = documento.trim()
    ? validarDocumentoArgentino(documento)
    : null;

  async function manejarCrearCliente(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (!nombre.trim()) {
        throw new Error('El nombre o razón social del cliente es obligatorio.');
      }

      const limiteCentavos = limiteCreditoInput.trim()
        ? pesosACentavos(limiteCreditoInput)
        : aCentavos(0);

      await invocarPosApi('crear_cliente', {
        rolActivo,
        nombre: nombre.trim(),
        documento: documento.trim() || null,
        condicionIva,
        telefono: telefono.trim() || null,
        domicilio: domicilio.trim() || null,
        limiteCreditoCentavos: limiteCentavos,
      });

      setNombre('');
      setDocumento('');
      setCondicionIva('consumidor_final');
      setTelefono('');
      setDomicilio('');
      setLimiteCreditoInput('50000');
      setMensajeExito('Cliente registrado correctamente.');
      await onDatosModificados?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error al registrar el cliente.'
      );
    }
  }

  async function seleccionarClienteDetalle(cliId: string) {
    setClienteDetalleId(cliId);
    if (!cliId) {
      setMovimientosCc([]);
      return;
    }
    try {
      const res = await invocarPosApi<{
        movimientos: readonly MovimientoCcUI[];
      }>('listar_movimientos_cc', {
        rolActivo,
        entidadTipo: 'cliente',
        entidadId: cliId,
      });
      setMovimientosCc(res.movimientos);
    } catch {
      setMovimientosCc([]);
    }
  }

  async function manejarMovimientoCuentaCorriente(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (!clienteDetalleId) {
        throw new Error('Seleccioná primero un cliente del listado.');
      }
      const montoCentavos = pesosACentavos(montoMovimientoInput);
      if (montoCentavos <= 0) {
        throw new Error('El monto debe ser mayor a cero.');
      }

      await invocarPosApi('registrar_movimiento_cc', {
        rolActivo,
        entidadTipo: 'cliente',
        entidadId: clienteDetalleId,
        tipo: tipoMovimientoInput,
        montoCentavos,
        observaciones:
          obsMovimientoInput.trim() ||
          (tipoMovimientoInput === 'pago'
            ? 'Cobro de saldo en cuenta corriente'
            : 'Cargo manual en cuenta corriente'),
      });

      setMontoMovimientoInput('');
      setObsMovimientoInput('');
      setMensajeExito(
        tipoMovimientoInput === 'pago'
          ? 'Cobro registrado en la cuenta corriente del cliente.'
          : 'Cargo registrado en la cuenta corriente del cliente.'
      );
      await onDatosModificados?.();
      await seleccionarClienteDetalle(clienteDetalleId);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Error al registrar movimiento en cuenta corriente.'
      );
    }
  }

  const clienteSeleccionado = clientesServidor.find(
    (c) => c.id === clienteDetalleId
  );

  return (
    <div className="pos-grid">
      {/* Alta de cliente */}
      <section className="card">
        <h2>Alta de Cliente y Límite de Cuenta Corriente</h2>
        <p className="text-muted">
          Validación automática de DNI (7 u 8 dígitos) y CUIT/CUIL (11 dígitos
          con dígito verificador Módulo 11).
        </p>

        {errorMsg && (
          <div className="alert-error" role="alert">
            {errorMsg}
          </div>
        )}
        {mensajeExito && (
          <div className="alert-success" role="status">
            {mensajeExito}
          </div>
        )}

        <form onSubmit={manejarCrearCliente}>
          <div className="form-group">
            <label htmlFor="input-nombre-cliente">
              Nombre y Apellido / Razón Social
            </label>
            <input
              id="input-nombre-cliente"
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Ej: Ferretería San Martín S.A. o Juan Pérez"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="input-doc-cliente">CUIT / CUIL / DNI</label>
              <input
                id="input-doc-cliente"
                type="text"
                value={documento}
                onChange={(e) => setDocumento(e.target.value)}
                placeholder="Ej: 20-12345678-6 o 30112233"
              />
              {validacionEnVivo && (
                <small
                  style={{
                    color: validacionEnVivo.valido ? '#15803d' : '#b91c1c',
                    fontWeight: 600,
                  }}
                >
                  {validacionEnVivo.valido
                    ? `✓ ${validacionEnVivo.tipo.toUpperCase()}: ${validacionEnVivo.documentoFormateado}`
                    : `✗ ${validacionEnVivo.error}`}
                </small>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="select-iva-cliente">Condición frente al IVA</label>
              <select
                id="select-iva-cliente"
                value={condicionIva}
                onChange={(e) =>
                  setCondicionIva(e.target.value as CondicionIvaReceptor)
                }
              >
                <option value="consumidor_final">Consumidor Final</option>
                <option value="monotributo">Responsable Monotributo</option>
                <option value="responsable_inscripto">
                  IVA Responsable Inscripto
                </option>
                <option value="exento">IVA Sujeto Exento</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="input-tel-cliente">Teléfono / WhatsApp</label>
              <input
                id="input-tel-cliente"
                type="text"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="Ej: 11 5544-3322"
              />
            </div>

            <div className="form-group">
              <label htmlFor="input-limite-cliente">
                Límite de Crédito en Cta. Cte. ($)
              </label>
              <input
                id="input-limite-cliente"
                type="text"
                value={limiteCreditoInput}
                onChange={(e) => setLimiteCreditoInput(e.target.value)}
                placeholder="0 = sin tope"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="input-dom-cliente">Domicilio Comercial</label>
            <input
              id="input-dom-cliente"
              type="text"
              value={domicilio}
              onChange={(e) => setDomicilio(e.target.value)}
              placeholder="Ej: Av. Rivadavia 4520, CABA"
            />
          </div>

          <button type="submit" className="btn-primary btn-block">
            Guardar Cliente
          </button>
        </form>
      </section>

      {/* Listado de Clientes y Estado de Cuenta Corriente */}
      <section className="card">
        <h2>Padron de Clientes y Cuentas Corrientes</h2>
        <table className="pos-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Documento / IVA</th>
              <th>Límite Crédito</th>
              <th>Saldo Deudor</th>
              <th>Disponible</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clientesServidor.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  No hay clientes registrados. Creá el primero en el formulario.
                </td>
              </tr>
            ) : (
              clientesServidor.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.nombre}</strong>
                    {c.telefono && (
                      <div className="text-muted">{c.telefono}</div>
                    )}
                  </td>
                  <td>
                    <div>{c.documento ?? 'Sin doc.'}</div>
                    <small className="text-muted">
                      {ETIQUETAS_CONDICION_IVA[c.condicion_iva]}
                    </small>
                  </td>
                  <td>
                    {c.limite_credito_centavos > 0
                      ? formatearPesos(aCentavos(c.limite_credito_centavos))
                      : 'Sin tope'}
                  </td>
                  <td>
                    <strong
                      style={{
                        color:
                          c.saldo_pendiente_centavos > 0
                            ? '#b91c1c'
                            : '#15803d',
                      }}
                    >
                      {formatearPesos(aCentavos(c.saldo_pendiente_centavos))}
                    </strong>
                  </td>
                  <td>
                    {c.limite_credito_centavos > 0
                      ? formatearPesos(aCentavos(c.credito_disponible_centavos))
                      : 'Ilimitado'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void seleccionarClienteDetalle(c.id)}
                    >
                      Cta. Cte.
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {clienteSeleccionado && (
          <div
            style={{
              marginTop: '1.1rem',
              padding: '0.9rem',
              background: '#f8fafc',
              borderRadius: '0.65rem',
              border: '1px solid #cbd5e1',
            }}
          >
            <h3>
              Cuenta Corriente: {clienteSeleccionado.nombre} — Saldo actual:{' '}
              {formatearPesos(
                aCentavos(clienteSeleccionado.saldo_pendiente_centavos)
              )}
            </h3>

            <form onSubmit={manejarMovimientoCuentaCorriente}>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="select-tipo-mov-cli">Operación</label>
                  <select
                    id="select-tipo-mov-cli"
                    value={tipoMovimientoInput}
                    onChange={(e) =>
                      setTipoMovimientoInput(
                        e.target.value as 'pago' | 'cargo'
                      )
                    }
                  >
                    <option value="pago">
                      Cobrar entrega / Pago del cliente (reduce deuda)
                    </option>
                    <option value="cargo">
                      Cargo manual en cuenta corriente (aumenta deuda)
                    </option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="input-monto-mov-cli">Monto ($)</label>
                  <input
                    id="input-monto-mov-cli"
                    type="text"
                    value={montoMovimientoInput}
                    onChange={(e) => setMontoMovimientoInput(e.target.value)}
                    placeholder="Ej: 8500"
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="input-obs-mov-cli">Detalle / Recibo</label>
                <input
                  id="input-obs-mov-cli"
                  type="text"
                  value={obsMovimientoInput}
                  onChange={(e) => setObsMovimientoInput(e.target.value)}
                  placeholder="Ej: Cobro en efectivo s/recibo"
                />
              </div>

              <button type="submit" className="btn-primary">
                Registrar en Cuenta Corriente
              </button>
            </form>

            {movimientosCc.length > 0 && (
              <table className="pos-table" style={{ marginTop: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th>Monto</th>
                    <th>Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {movimientosCc.map((m) => (
                    <tr key={m.id}>
                      <td>{formatearFechaAR(new Date(m.fecha))}</td>
                      <td>
                        <span
                          className={`badge-rol ${
                            m.tipo === 'cargo' ? 'rol-encargado' : 'rol-cajero'
                          }`}
                        >
                          {m.tipo.toUpperCase()}
                        </span>
                      </td>
                      <td>{formatearPesos(aCentavos(m.monto_centavos))}</td>
                      <td>{m.observaciones ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
