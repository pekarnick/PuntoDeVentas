import React, { useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  aCentavos,
  formatearFechaAR,
  formatearPesos,
  pesosACentavos,
} from '../../domain/dinero.ts';
import { validarDocumentoArgentino } from '../../domain/cuit.ts';
import type { RolUsuario } from '../../domain/permisos.ts';
import type { AlicuotaIva } from '../../domain/totales.ts';
import type { ProductoAdminItemUI } from '../productos/PanelProductosStock.tsx';

export interface ProveedorConSaldoUI {
  readonly id: string;
  readonly razon_social: string;
  readonly cuit: string | null;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly total_cargos_centavos: number;
  readonly total_pagos_centavos: number;
  readonly saldo_pendiente_centavos: number;
}

export interface CompraResumenUI {
  readonly id: string;
  readonly fecha: string;
  readonly proveedor_id: string | null;
  readonly proveedor_nombre: string | null;
  readonly numero_comprobante: string | null;
  readonly total_centavos: number;
  readonly usuario_nombre: string;
  readonly cantidad_items: number;
}

export interface MovimientoCcUI {
  readonly id: string;
  readonly entidad_tipo: 'cliente' | 'proveedor';
  readonly entidad_id: string;
  readonly tipo: 'cargo' | 'pago';
  readonly monto_centavos: number;
  readonly referencia_id: string | null;
  readonly observaciones: string | null;
  readonly fecha: string;
}

interface ItemBorradorCompra {
  readonly productoId: string;
  readonly nombreProducto: string;
  readonly cantidad: number;
  readonly costoUnitarioCentavos: number;
  readonly alicuotaIva: AlicuotaIva;
  readonly actualizarCostoProducto: boolean;
}

export interface PanelComprasProveedoresProps {
  readonly rolActivo: RolUsuario;
  readonly proveedoresServidor?: readonly ProveedorConSaldoUI[];
  readonly comprasRecientesServidor?: readonly CompraResumenUI[];
  readonly catalogoProductos?: readonly ProductoAdminItemUI[];
  readonly onDatosModificados?: () => void | Promise<void>;
}

export function PanelComprasProveedores({
  rolActivo,
  proveedoresServidor = [],
  comprasRecientesServidor = [],
  catalogoProductos = [],
  onDatosModificados,
}: PanelComprasProveedoresProps): React.ReactElement {
  const tienePermisoCompras =
    rolActivo === 'superadmin' || rolActivo === 'encargado';

  // Estado ABM Proveedor
  const [razonSocial, setRazonSocial] = useState('');
  const [cuitProveedor, setCuitProveedor] = useState('');
  const [telefonoProveedor, setTelefonoProveedor] = useState('');
  const [emailProveedor, setEmailProveedor] = useState('');

  // Estado Nueva Compra
  const [proveedorCompraId, setProveedorCompraId] = useState<string>('');
  const [numeroComprobante, setNumeroComprobante] = useState('');
  const [productoSeleccionadoId, setProductoSeleccionadoId] = useState<string>(
    catalogoProductos[0]?.id ?? ''
  );
  const [cantidadItemInput, setCantidadItemInput] = useState('1');
  const [costoUnitarioInput, setCostoUnitarioInput] = useState('');
  const [alicuotaItem, setAlicuotaItem] = useState<AlicuotaIva>(21);
  const [actualizarCostoCheck, setActualizarCostoCheck] = useState(true);
  const [itemsCompra, setItemsCompra] = useState<ItemBorradorCompra[]>([]);
  const [cargarEnCuentaCorriente, setCargarEnCuentaCorriente] = useState(true);
  const [montoPagadoActoInput, setMontoPagadoActoInput] = useState('0');

  // Estado Cuenta Corriente Proveedor
  const [proveedorDetalleCcId, setProveedorDetalleCcId] = useState<string>('');
  const [movimientosCc, setMovimientosCc] = useState<readonly MovimientoCcUI[]>(
    []
  );
  const [montoPagoProveedorInput, setMontoPagoProveedorInput] = useState('');
  const [obsPagoProveedor, setObsPagoProveedor] = useState('');

  const [mensajeExito, setMensajeExito] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!tienePermisoCompras) {
    return (
      <div className="card">
        <h2>Acceso restringido</h2>
        <p className="text-muted">
          Solo el encargado y el superadmin pueden gestionar proveedores,
          compras y costos de reposición (PLAN.md §6.1 y Regla 20).
        </p>
      </div>
    );
  }

  async function manejarCrearProveedor(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (!razonSocial.trim()) {
        throw new Error('La razón social del proveedor es obligatoria.');
      }
      if (cuitProveedor.trim()) {
        const val = validarDocumentoArgentino(cuitProveedor);
        if (!val.valido) {
          throw new Error(val.error ?? 'CUIT inválido.');
        }
      }

      await invocarPosApi('crear_proveedor', {
        rolActivo,
        razonSocial: razonSocial.trim(),
        cuit: cuitProveedor.trim() || null,
        telefono: telefonoProveedor.trim() || null,
        email: emailProveedor.trim() || null,
      });

      setRazonSocial('');
      setCuitProveedor('');
      setTelefonoProveedor('');
      setEmailProveedor('');
      setMensajeExito('Proveedor registrado correctamente.');
      await onDatosModificados?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error al crear proveedor.'
      );
    }
  }

  function agregarItemBorradorCompra() {
    setErrorMsg(null);
    const idEfectivo = productoSeleccionadoId || catalogoProductos[0]?.id || '';
    const prod = catalogoProductos.find((p) => p.id === idEfectivo);
    if (!prod) {
      setErrorMsg('Seleccioná un producto del catálogo para agregar a la compra.');
      return;
    }

    const cantidad = Number(cantidadItemInput.replace(',', '.'));
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setErrorMsg('La cantidad comprada debe ser mayor a cero.');
      return;
    }

    let costoCentavos = 0;
    try {
      costoCentavos = costoUnitarioInput.trim()
        ? pesosACentavos(costoUnitarioInput)
        : (prod.costo_compra ?? 0);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Costo unitario inválido.'
      );
      return;
    }

    setItemsCompra((prev) => [
      ...prev,
      {
        productoId: prod.id,
        nombreProducto: prod.nombre,
        cantidad,
        costoUnitarioCentavos: costoCentavos,
        alicuotaIva: alicuotaItem,
        actualizarCostoProducto: actualizarCostoCheck,
      },
    ]);
    setCantidadItemInput('1');
    setCostoUnitarioInput('');
  }

  function quitarItemCompra(index: number) {
    setItemsCompra((prev) => prev.filter((_, idx) => idx !== index));
  }

  const totalBorradorCompraCentavos = itemsCompra.reduce(
    (acc, it) => acc + Math.round(it.cantidad * it.costoUnitarioCentavos),
    0
  );

  async function confirmarCompraProveedor(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (itemsCompra.length === 0) {
        throw new Error('Agregá al menos un ítem a la factura de compra.');
      }

      const montoPagadoCentavos = montoPagadoActoInput.trim()
        ? pesosACentavos(montoPagadoActoInput)
        : aCentavos(0);

      await invocarPosApi('registrar_compra_proveedor', {
        rolActivo,
        proveedorId: proveedorCompraId || null,
        numeroComprobante: numeroComprobante.trim() || null,
        items: itemsCompra.map((it) => ({
          productoId: it.productoId,
          cantidad: it.cantidad,
          costoUnitarioCentavos: it.costoUnitarioCentavos,
          alicuotaIva: it.alicuotaIva,
          actualizarCostoProducto: it.actualizarCostoProducto,
        })),
        registrarCargoCuentaCorriente:
          Boolean(proveedorCompraId) && cargarEnCuentaCorriente,
        montoPagadoEnElActoCentavos: montoPagadoCentavos,
      });

      setItemsCompra([]);
      setNumeroComprobante('');
      setMontoPagadoActoInput('0');
      setMensajeExito(
        'Compra registrada: stock incrementado, costos actualizados y auditoría encadenada grabada.'
      );
      await onDatosModificados?.();
      if (proveedorDetalleCcId && proveedorDetalleCcId === proveedorCompraId) {
        await cargarMovimientosProveedor(proveedorDetalleCcId);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error al registrar la compra.'
      );
    }
  }

  async function cargarMovimientosProveedor(provId: string) {
    setProveedorDetalleCcId(provId);
    if (!provId) {
      setMovimientosCc([]);
      return;
    }
    try {
      const res = await invocarPosApi<{
        movimientos: readonly MovimientoCcUI[];
      }>('listar_movimientos_cc', {
        rolActivo,
        entidadTipo: 'proveedor',
        entidadId: provId,
      });
      setMovimientosCc(res.movimientos);
    } catch {
      setMovimientosCc([]);
    }
  }

  async function registrarPagoAProveedor(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (!proveedorDetalleCcId) {
        throw new Error('Seleccioná un proveedor para registrar el pago.');
      }
      const montoCentavos = pesosACentavos(montoPagoProveedorInput);
      if (montoCentavos <= 0) {
        throw new Error('El monto del pago debe ser mayor a cero.');
      }

      await invocarPosApi('registrar_movimiento_cc', {
        rolActivo,
        entidadTipo: 'proveedor',
        entidadId: proveedorDetalleCcId,
        tipo: 'pago',
        montoCentavos,
        observaciones:
          obsPagoProveedor.trim() || 'Pago a proveedor en cuenta corriente',
      });

      setMontoPagoProveedorInput('');
      setObsPagoProveedor('');
      setMensajeExito('Pago a proveedor asentado en cuenta corriente.');
      await onDatosModificados?.();
      await cargarMovimientosProveedor(proveedorDetalleCcId);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Error al registrar pago a proveedor.'
      );
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
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

      <div className="pos-grid">
        {/* Columna izquierda: Registro de Compra + Ingreso de mercadería */}
        <section className="card">
          <h2>Registrar Compra a Proveedor (Ingreso de Stock)</h2>
          <p className="text-muted">
            Cada ítem genera un movimiento de stock{' '}
            <code>tipo = &apos;compra&apos;</code> y actualiza opcionalmente el{' '}
            <code>costo_compra</code> de reposición.
          </p>

          <form onSubmit={confirmarCompraProveedor}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="select-proveedor-compra">Proveedor</label>
                <select
                  id="select-proveedor-compra"
                  value={proveedorCompraId}
                  onChange={(e) => setProveedorCompraId(e.target.value)}
                >
                  <option value="">(Compra sin proveedor asignado)</option>
                  {proveedoresServidor.map((prov) => (
                    <option key={prov.id} value={prov.id}>
                      {prov.razon_social}{' '}
                      {prov.cuit ? `(${prov.cuit})` : ''} — Saldo:{' '}
                      {formatearPesos(aCentavos(prov.saldo_pendiente_centavos))}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="input-comprobante-compra">
                  Nº Factura / Remito
                </label>
                <input
                  id="input-comprobante-compra"
                  type="text"
                  value={numeroComprobante}
                  onChange={(e) => setNumeroComprobante(e.target.value)}
                  placeholder="Ej: FC-A 0001-00045812"
                />
              </div>
            </div>

            <div
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: '0.65rem',
                padding: '0.85rem',
                background: '#f8fafc',
                marginBottom: '0.85rem',
              }}
            >
              <strong style={{ display: 'block', marginBottom: '0.55rem' }}>
                Agregar producto al comprobante
              </strong>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="select-prod-compra">Producto</label>
                  <select
                    id="select-prod-compra"
                    value={
                      productoSeleccionadoId || catalogoProductos[0]?.id || ''
                    }
                    onChange={(e) => setProductoSeleccionadoId(e.target.value)}
                  >
                    {catalogoProductos.length === 0 && (
                      <option value="">Sin productos cargados</option>
                    )}
                    {catalogoProductos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre} ({p.codigo_interno || 'S/C'}) — Costo actual:{' '}
                        {formatearPesos(aCentavos(p.costo_compra ?? 0))}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="input-cant-compra">Cantidad</label>
                  <input
                    id="input-cant-compra"
                    type="text"
                    value={cantidadItemInput}
                    onChange={(e) => setCantidadItemInput(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="input-costo-compra-item">
                    Costo unitario ($)
                  </label>
                  <input
                    id="input-costo-compra-item"
                    type="text"
                    value={costoUnitarioInput}
                    onChange={(e) => setCostoUnitarioInput(e.target.value)}
                    placeholder="Vacío = usar costo actual"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="select-iva-compra">Alícuota IVA</label>
                  <select
                    id="select-iva-compra"
                    value={alicuotaItem}
                    onChange={(e) =>
                      setAlicuotaItem(Number(e.target.value) as AlicuotaIva)
                    }
                  >
                    <option value={21}>21%</option>
                    <option value={10.5}>10,5%</option>
                    <option value={27}>27%</option>
                    <option value={0}>0% / Exento</option>
                  </select>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                }}
              >
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={actualizarCostoCheck}
                    onChange={(e) => setActualizarCostoCheck(e.target.checked)}
                  />
                  Actualizar costo_compra de ficha del producto
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={agregarItemBorradorCompra}
                >
                  + Agregar ítem a compra
                </button>
              </div>
            </div>

            {itemsCompra.length > 0 && (
              <div style={{ marginBottom: '0.9rem' }}>
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>Cant.</th>
                      <th>Costo Unit.</th>
                      <th>IVA</th>
                      <th>Subtotal</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemsCompra.map((item, idx) => (
                      <tr key={`${item.productoId}-${idx}`}>
                        <td>{item.nombreProducto}</td>
                        <td>{item.cantidad}</td>
                        <td>{formatearPesos(aCentavos(item.costoUnitarioCentavos))}</td>
                        <td>{item.alicuotaIva}%</td>
                        <td>
                          {formatearPesos(
                            aCentavos(
                              Math.round(
                                item.cantidad * item.costoUnitarioCentavos
                              )
                            )
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-danger-outline"
                            onClick={() => quitarItemCompra(idx)}
                          >
                            Quitar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div
                  style={{
                    marginTop: '0.5rem',
                    fontWeight: 700,
                    textAlign: 'right',
                  }}
                >
                  Total Compra:{' '}
                  {formatearPesos(aCentavos(totalBorradorCompraCentavos))}
                </div>
              </div>
            )}

            {proveedorCompraId && (
              <div className="form-row">
                <div className="form-group">
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={cargarEnCuentaCorriente}
                      onChange={(e) =>
                        setCargarEnCuentaCorriente(e.target.checked)
                      }
                    />
                    Asentar deuda en Cuenta Corriente del proveedor
                  </label>
                </div>
                {cargarEnCuentaCorriente && (
                  <div className="form-group">
                    <label htmlFor="input-pagado-acto">
                      Monto abonado en el acto ($)
                    </label>
                    <input
                      id="input-pagado-acto"
                      type="text"
                      value={montoPagadoActoInput}
                      onChange={(e) => setMontoPagadoActoInput(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary btn-block"
              disabled={itemsCompra.length === 0}
            >
              Confirmar Compra e Ingresar Stock
            </button>
          </form>
        </section>

        {/* Columna derecha: Alta de Proveedores + Cuenta Corriente */}
        <section className="card">
          <h2>Nuevo Proveedor</h2>
          <form onSubmit={manejarCrearProveedor}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="input-razon-prov">Razón Social / Nombre</label>
                <input
                  id="input-razon-prov"
                  type="text"
                  value={razonSocial}
                  onChange={(e) => setRazonSocial(e.target.value)}
                  placeholder="Ej: Distribuidora Mayorista Sur S.R.L."
                />
              </div>
              <div className="form-group">
                <label htmlFor="input-cuit-prov">CUIT (con Módulo 11)</label>
                <input
                  id="input-cuit-prov"
                  type="text"
                  value={cuitProveedor}
                  onChange={(e) => setCuitProveedor(e.target.value)}
                  placeholder="Ej: 30-71234567-9"
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="input-tel-prov">Teléfono</label>
                <input
                  id="input-tel-prov"
                  type="text"
                  value={telefonoProveedor}
                  onChange={(e) => setTelefonoProveedor(e.target.value)}
                  placeholder="Ej: 11 4555-9900"
                />
              </div>
              <div className="form-group">
                <label htmlFor="input-email-prov">Email</label>
                <input
                  id="input-email-prov"
                  type="email"
                  value={emailProveedor}
                  onChange={(e) => setEmailProveedor(e.target.value)}
                  placeholder="ventas@proveedor.com.ar"
                />
              </div>
            </div>
            <button type="submit" className="btn-primary">
              Guardar Proveedor
            </button>
          </form>

          <hr style={{ margin: '1.25rem 0', borderColor: '#e2e8f0' }} />

          <h3>Proveedores y Cuenta Corriente</h3>
          <table className="pos-table">
            <thead>
              <tr>
                <th>Razón Social</th>
                <th>CUIT</th>
                <th>Cargos</th>
                <th>Pagos</th>
                <th>Saldo Deudor</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {proveedoresServidor.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    No hay proveedores registrados todavía.
                  </td>
                </tr>
              ) : (
                proveedoresServidor.map((prov) => (
                  <tr key={prov.id}>
                    <td>
                      <strong>{prov.razon_social}</strong>
                      {prov.telefono && (
                        <div className="text-muted">{prov.telefono}</div>
                      )}
                    </td>
                    <td>{prov.cuit ?? '—'}</td>
                    <td>{formatearPesos(aCentavos(prov.total_cargos_centavos))}</td>
                    <td>{formatearPesos(aCentavos(prov.total_pagos_centavos))}</td>
                    <td>
                      <strong>
                        {formatearPesos(
                          aCentavos(prov.saldo_pendiente_centavos)
                        )}
                      </strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void cargarMovimientosProveedor(prov.id)}
                      >
                        Ver / Pagar
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {proveedorDetalleCcId && (
            <div
              style={{
                marginTop: '1rem',
                padding: '0.85rem',
                background: '#f8fafc',
                borderRadius: '0.65rem',
                border: '1px solid #cbd5e1',
              }}
            >
              <h4>Registrar Pago a Proveedor Seleccionado</h4>
              <form onSubmit={registrarPagoAProveedor}>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="input-monto-pago-prov">
                      Monto a pagar ($)
                    </label>
                    <input
                      id="input-monto-pago-prov"
                      type="text"
                      value={montoPagoProveedorInput}
                      onChange={(e) =>
                        setMontoPagoProveedorInput(e.target.value)
                      }
                      placeholder="Ej: 25000"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="input-obs-pago-prov">Observaciones</label>
                    <input
                      id="input-obs-pago-prov"
                      type="text"
                      value={obsPagoProveedor}
                      onChange={(e) => setObsPagoProveedor(e.target.value)}
                      placeholder="Ej: Transferencia recibo #402"
                    />
                  </div>
                </div>
                <button type="submit" className="btn-primary">
                  Registrar Pago en Cuenta Corriente
                </button>
              </form>

              {movimientosCc.length > 0 && (
                <table className="pos-table" style={{ marginTop: '0.75rem' }}>
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
                              m.tipo === 'cargo'
                                ? 'rol-encargado'
                                : 'rol-cajero'
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

      {/* Historial de compras recientes */}
      <section className="card">
        <h2>Últimas Compras Registradas</h2>
        <table className="pos-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Comprobante</th>
              <th>Proveedor</th>
              <th>Ítems</th>
              <th>Total</th>
              <th>Operador</th>
            </tr>
          </thead>
          <tbody>
            {comprasRecientesServidor.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  Sin compras registradas aún.
                </td>
              </tr>
            ) : (
              comprasRecientesServidor.map((c) => (
                <tr key={c.id}>
                  <td>{formatearFechaAR(new Date(c.fecha))}</td>
                  <td>{c.numero_comprobante ?? 'S/N'}</td>
                  <td>{c.proveedor_nombre ?? 'Compra directa'}</td>
                  <td>{c.cantidad_items}</td>
                  <td>
                    <strong>{formatearPesos(aCentavos(c.total_centavos))}</strong>
                  </td>
                  <td>{c.usuario_nombre}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
