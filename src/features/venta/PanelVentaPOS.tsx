import React, { useEffect, useRef, useState } from 'react';
import {
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from '../../domain/dinero.ts';
import {
  actualizarCantidadEnCarrito,
  agregarProductoAlCarrito,
  aplicarDescuentoItemEnCarrito,
  calcularResumenCarritoPOS,
  detectarEscaneoRafaga,
  resolverAtajoTecladoPOS,
  sanitizarProductoCatalogoParaPOS,
  type EventoTeclaLector,
  type ItemCarritoPOS,
  type ProductoCatalogoVenta,
} from '../../domain/escaner.ts';
import {
  requiereAutorizacionParaAnular,
  tienePermiso,
  type RolUsuario,
} from '../../domain/permisos.ts';
import {
  construirDatosTicketSeguro,
  formatearTicketNoFiscalTexto,
} from '../../domain/ticket.ts';
import { validarPagosVenta, type MedioPago } from '../../domain/totales.ts';

export interface PanelVentaPOSProps {
  readonly rolActivo: RolUsuario;
  readonly operadorNombre: string;
  readonly catalogoInicial?: readonly ProductoCatalogoVenta[];
}

const CATALOGO_DEMO_INICIAL: ProductoCatalogoVenta[] = [
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-yerba',
    nombre: 'Yerba Mate Selección 1kg',
    codigo_interno: 'YER-001',
    codigos_barras: ['7791234560012', '7791234560019'],
    unidad: 'unidad',
    permite_decimales: false,
    precio_venta: 420000, // $ 4.200,00
    costo_compra: 280000, // Eliminado automáticamente por sanitizarProductoCatalogoParaPOS (Regla 20)
    alicuota_iva: 21,
    exento_iva: false,
    boton_rapido: false,
  }),
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-alfajor',
    nombre: 'Alfajor Triple Chocolate',
    codigo_interno: 'ALF-003',
    codigos_barras: ['7790001112223'],
    unidad: 'unidad',
    permite_decimales: false,
    precio_venta: 150000, // $ 1.500,00
    costo_compra: 85000,
    alicuota_iva: 21,
    exento_iva: false,
    boton_rapido: true,
  }),
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-pan',
    nombre: 'Pan Francés Fresco (kg)',
    codigo_interno: 'PAN-KG',
    codigos_barras: ['200001'],
    unidad: 'kg',
    permite_decimales: true,
    precio_venta: 240000, // $ 2.400,00 / kg
    costo_compra: 130000,
    alicuota_iva: 10.5,
    exento_iva: false,
    boton_rapido: true,
  }),
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-bolsa',
    nombre: 'Bolsa Reutilizable Grande',
    codigo_interno: 'BOL-01',
    codigos_barras: [],
    unidad: 'unidad',
    permite_decimales: false,
    precio_venta: 60000, // $ 600,00
    costo_compra: 25000,
    alicuota_iva: 21,
    exento_iva: false,
    boton_rapido: true,
  }),
];

interface VentaRecienteUI {
  readonly id: string;
  readonly fechaIso: string;
  readonly total: Centavos;
  readonly estado: 'completada' | 'anulada';
  readonly ticketTexto: string;
  readonly motivoAnulacion?: string;
  readonly autorizadaPor?: string;
}

export function PanelVentaPOS({
  rolActivo,
  operadorNombre,
  catalogoInicial = CATALOGO_DEMO_INICIAL,
}: PanelVentaPOSProps): React.ReactElement {
  const [catalogo, setCatalogo] = useState<ProductoCatalogoVenta[]>(() =>
    catalogoInicial.map((p) => sanitizarProductoCatalogoParaPOS(p))
  );
  const [carrito, setCarrito] = useState<ItemCarritoPOS[]>([]);
  const [entradaLector, setEntradaLector] = useState('');
  const [descuentoGlobalInput, setDescuentoGlobalInput] = useState('0,00');

  // Pagos mixtos
  const [medioPrincipal, setMedioPrincipal] = useState<MedioPago>('efectivo');
  const [modoPagoMixto, setModoPagoMixto] = useState(false);
  const [montoEfectivoMixtoInput, setMontoEfectivoMixtoInput] = useState('');
  const [medioSecundarioMixto, setMedioSecundarioMixto] =
    useState<MedioPago>('mercado_pago');

  // Alta rápida cuando un código escaneado no existe (PLAN.md §9)
  const [codigoInexistenteDetectado, setCodigoInexistenteDetectado] = useState<
    string | null
  >(null);
  const [altaRapidaNombre, setAltaRapidaNombre] = useState('');
  const [altaRapidaPrecioInput, setAltaRapidaPrecioInput] = useState('');
  const [altaRapidaCostoInput, setAltaRapidaCostoInput] = useState('');

  // Comprobante y anulaciones
  const [ultimoTicketTexto, setUltimoTicketTexto] = useState<string | null>(
    null
  );
  const [ventasSesion, setVentasSesion] = useState<VentaRecienteUI[]>([]);
  const [ventaAAnularId, setVentaAAnularId] = useState<string | null>(null);
  const [motivoAnulacion, setMotivoAnulacion] = useState('');
  const [autorizadorUsuario, setAutorizadorUsuario] = useState('');
  const [autorizadorClave, setAutorizadorClave] = useState('');

  const [mensajeEstado, setMensajeEstado] = useState<string | null>(null);
  const [mensajeError, setMensajeError] = useState<string | null>(null);

  const inputLectorRef = useRef<HTMLInputElement | null>(null);
  const bufferTeclasRef = useRef<EventoTeclaLector[]>([]);

  const puedeCrearProductoRapido = tienePermiso(
    rolActivo,
    'abm_productos_precios_stock_compras'
  );
  const cajeroRequiereAutorizacion = requiereAutorizacionParaAnular(rolActivo);

  let descuentoGlobalCentavos = 0;
  try {
    descuentoGlobalCentavos = descuentoGlobalInput.trim()
      ? pesosACentavos(descuentoGlobalInput)
      : 0;
  } catch {
    descuentoGlobalCentavos = 0;
  }

  const resumen = calcularResumenCarritoPOS(carrito, descuentoGlobalCentavos);
  const botonesRapidos = catalogo.filter((p) => p.boton_rapido);

  function enfocarEntradaLector() {
    inputLectorRef.current?.focus();
  }

  useEffect(() => {
    enfocarEntradaLector();
  }, []);

  function procesarEntradaCodigoOBusqueda(textoRaw: string, fueRafaga: boolean) {
    setMensajeError(null);
    setMensajeEstado(null);
    setCodigoInexistenteDetectado(null);

    const texto = textoRaw.trim();
    if (!texto) return;

    // 1. Buscar coincidencia exacta por código de barras o código interno
    const porCodigo = catalogo.find(
      (p) =>
        p.codigos_barras.includes(texto) ||
        (p.codigo_interno &&
          p.codigo_interno.toLowerCase() === texto.toLowerCase())
    );

    if (porCodigo) {
      setCarrito((prev) => agregarProductoAlCarrito(prev, porCodigo, 1));
      setEntradaLector('');
      setMensajeEstado(
        `${fueRafaga ? '[Escáner]' : '[Código]'} Agregado: ${porCodigo.nombre} (${formatearMonedaARS(porCodigo.precio_venta)})`
      );
      return;
    }

    // 2. Si no fue ráfaga pura de dígitos, buscar por coincidencia de nombre
    const porNombre = catalogo.filter((p) =>
      p.nombre.toLowerCase().includes(texto.toLowerCase())
    );

    if (porNombre.length === 1 && porNombre[0]) {
      setCarrito((prev) => agregarProductoAlCarrito(prev, porNombre[0]!, 1));
      setEntradaLector('');
      setMensajeEstado(`Agregado: ${porNombre[0].nombre}`);
      return;
    }

    // 3. Código inexistente: ofrecer crearlo sin salir de la venta si es superadmin o encargado (PLAN.md §9)
    setCodigoInexistenteDetectado(texto);
    setEntradaLector('');
  }

  function manejarKeyDownLector(e: React.KeyboardEvent<HTMLInputElement>) {
    const ahora = performance.now();
    if (e.key === 'Enter') {
      e.preventDefault();
      const infoRafaga = detectarEscaneoRafaga(bufferTeclasRef.current);
      bufferTeclasRef.current = [];
      procesarEntradaCodigoOBusqueda(entradaLector, infoRafaga.esEscaneo);
      return;
    }

    if (e.key.length === 1) {
      bufferTeclasRef.current.push({ tecla: e.key, timestampMs: ahora });
      if (bufferTeclasRef.current.length > 40) {
        bufferTeclasRef.current.shift();
      }
    }
  }

  function manejarAtajoGlobal(e: React.KeyboardEvent<HTMLDivElement>) {
    const accion = resolverAtajoTecladoPOS(e);
    if (!accion) return;

    switch (accion) {
      case 'ENFOCAR_ENTRADA_LECTOR':
        e.preventDefault();
        enfocarEntradaLector();
        break;
      case 'CONFIRMAR_COBRO_RAPIDO_EFECTIVO':
        e.preventDefault();
        if (carrito.length > 0) {
          confirmarCobroVenta();
        }
        break;
      case 'ABRIR_MODAL_PAGOS_MIXTOS':
        e.preventDefault();
        setModoPagoMixto((prev) => !prev);
        break;
      case 'INCREMENTAR_ULTIMO_ITEM':
        e.preventDefault();
        if (carrito.length > 0) {
          const ultimo = carrito[carrito.length - 1]!;
          setCarrito((prev) =>
            actualizarCantidadEnCarrito(
              prev,
              ultimo.producto_id,
              ultimo.cantidad + 1
            )
          );
        }
        break;
      case 'DECREMENTAR_ULTIMO_ITEM':
        e.preventDefault();
        if (carrito.length > 0) {
          const ultimo = carrito[carrito.length - 1]!;
          setCarrito((prev) =>
            actualizarCantidadEnCarrito(
              prev,
              ultimo.producto_id,
              ultimo.cantidad - 1
            )
          );
        }
        break;
      case 'VACIAR_O_CANCELAR':
        setCodigoInexistenteDetectado(null);
        setVentaAAnularId(null);
        enfocarEntradaLector();
        break;
      default:
        break;
    }
  }

  function manejarCrearProductoDesdeEscaneo(e: React.FormEvent) {
    e.preventDefault();
    if (!codigoInexistenteDetectado || !puedeCrearProductoRapido) return;
    setMensajeError(null);

    try {
      if (!altaRapidaNombre.trim()) {
        throw new Error('Ingresá el nombre del nuevo producto.');
      }
      const precioVenta = pesosACentavos(altaRapidaPrecioInput);
      const costoCompra = altaRapidaCostoInput.trim()
        ? pesosACentavos(altaRapidaCostoInput)
        : 0;

      if (precioVenta <= 0 || costoCompra < 0) {
        throw new Error('Verificá los importes ingresados.');
      }

      const nuevoProd = sanitizarProductoCatalogoParaPOS({
        id: `prod-${Date.now()}`,
        nombre: altaRapidaNombre.trim(),
        codigo_interno: null,
        codigos_barras: [codigoInexistenteDetectado],
        unidad: 'unidad',
        permite_decimales: false,
        precio_venta: precioVenta,
        costo_compra: costoCompra,
        alicuota_iva: 21,
        exento_iva: false,
        boton_rapido: false,
      });

      setCatalogo((prev) => [...prev, nuevoProd]);
      setCarrito((prev) => agregarProductoAlCarrito(prev, nuevoProd, 1));
      setCodigoInexistenteDetectado(null);
      setAltaRapidaNombre('');
      setAltaRapidaPrecioInput('');
      setAltaRapidaCostoInput('');
      setMensajeEstado(
        `Producto "${nuevoProd.nombre}" creado y agregado a la venta actual.`
      );
      enfocarEntradaLector();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo crear el producto.'
      );
    }
  }

  function confirmarCobroVenta() {
    setMensajeError(null);
    setMensajeEstado(null);

    try {
      if (carrito.length === 0) {
        throw new Error('Agregá al menos un producto al carrito antes de cobrar.');
      }

      let pagos: Array<{ medio: MedioPago; monto: Centavos }> = [
        { medio: medioPrincipal, monto: resumen.total },
      ];

      if (modoPagoMixto && montoEfectivoMixtoInput.trim()) {
        const montoEfectivo = pesosACentavos(montoEfectivoMixtoInput);
        const resto = resumen.total - montoEfectivo;
        pagos = [
          { medio: 'efectivo', monto: montoEfectivo },
          { medio: medioSecundarioMixto, monto: resto },
        ];
      }

      validarPagosVenta(pagos, resumen.total);

      const ventaId = `vta-${Date.now()}`;
      const fechaIso = new Date().toISOString();

      const datosTicket = construirDatosTicketSeguro({
        comercioNombre: 'Comercio Local POS',
        comercioCondicionIva: 'Monotributo',
        ventaId,
        fechaIso,
        cajeroNombre: operadorNombre,
        items: resumen.items,
        subtotal: resumen.subtotal,
        descuentoGlobal: resumen.descuento_global,
        total: resumen.total,
        pagos,
      });

      const ticketTexto = formatearTicketNoFiscalTexto(datosTicket);
      setUltimoTicketTexto(ticketTexto);
      setVentasSesion((prev) => [
        {
          id: ventaId,
          fechaIso,
          total: resumen.total,
          estado: 'completada',
          ticketTexto,
        },
        ...prev,
      ]);

      setCarrito([]);
      setDescuentoGlobalInput('0,00');
      setMontoEfectivoMixtoInput('');
      setModoPagoMixto(false);
      setMensajeEstado(
        `Venta registrada por ${formatearMonedaARS(resumen.total)}. Stock descontado y auditado.`
      );
      enfocarEntradaLector();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo completar el cobro.'
      );
    }
  }

  function manejarConfirmarAnulacion(e: React.FormEvent) {
    e.preventDefault();
    if (!ventaAAnularId) return;
    setMensajeError(null);

    if (!motivoAnulacion.trim()) {
      setMensajeError('El motivo de anulación es obligatorio (PLAN.md §6.1).');
      return;
    }

    if (cajeroRequiereAutorizacion) {
      if (!autorizadorUsuario.trim() || !autorizadorClave.trim()) {
        setMensajeError(
          'Como cajero necesitás el usuario y clave de un encargado o superadmin para autorizar la anulación.'
        );
        return;
      }
    }

    const autorizadorFinal = cajeroRequiereAutorizacion
      ? autorizadorUsuario.trim()
      : operadorNombre;

    setVentasSesion((prev) =>
      prev.map((v) =>
        v.id === ventaAAnularId
          ? {
              ...v,
              estado: 'anulada',
              motivoAnulacion: motivoAnulacion.trim(),
              autorizadaPor: autorizadorFinal,
            }
          : v
      )
    );

    setVentaAAnularId(null);
    setMotivoAnulacion('');
    setAutorizadorUsuario('');
    setAutorizadorClave('');
    setMensajeEstado(
      `Venta anulada con éxito. Stock devuelto y rastro registrado en auditoría (autorizó: ${autorizadorFinal}).`
    );
    enfocarEntradaLector();
  }

  return (
    <div
      className="pos-venta-wrapper"
      onKeyDown={manejarAtajoGlobal}
      tabIndex={-1}
    >
      <div className="shortcuts-bar" aria-label="Atajos de teclado de caja">
        <span>
          <kbd>F2</kbd> Enfocar lector/búsqueda
        </span>
        <span>
          <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>-</kbd> Cantidad
        </span>
        <span>
          <kbd>F9</kbd> Pago mixto
        </span>
        <span>
          <kbd>F4</kbd> Cobrar ahora
        </span>
        <span>
          <kbd>Esc</kbd> Cancelar/Limpiar
        </span>
      </div>

      {mensajeError && <div className="alert-error">{mensajeError}</div>}
      {mensajeEstado && <div className="alert-ok">{mensajeEstado}</div>}

      <div className="panel-grid">
        <div className="pos-card">
          <div className="scanner-box">
            <label htmlFor="input-lector-barras">
              Lector de códigos de barras o búsqueda por nombre (<kbd>F2</kbd>):
            </label>
            <div className="form-row">
              <input
                id="input-lector-barras"
                ref={inputLectorRef}
                type="text"
                className="scanner-input"
                value={entradaLector}
                onChange={(e) => setEntradaLector(e.target.value)}
                onKeyDown={manejarKeyDownLector}
                placeholder="Escaneá el código o escribí nombre y presioná Enter..."
                autoFocus
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  procesarEntradaCodigoOBusqueda(entradaLector, false)
                }
              >
                Agregar (Enter)
              </button>
            </div>
          </div>

          {codigoInexistenteDetectado && (
            <div className="alert-info">
              <p>
                <strong>
                  El código "{codigoInexistenteDetectado}" no está registrado.
                </strong>
              </p>
              {puedeCrearProductoRapido ? (
                <form
                  onSubmit={manejarCrearProductoDesdeEscaneo}
                  className="form-row"
                >
                  <label>
                    Nombre del producto:
                    <input
                      type="text"
                      value={altaRapidaNombre}
                      onChange={(e) => setAltaRapidaNombre(e.target.value)}
                      placeholder="Ej. Galletitas Dulces 150g"
                    />
                  </label>
                  <label>
                    Precio de venta ($):
                    <input
                      type="text"
                      value={altaRapidaPrecioInput}
                      onChange={(e) => setAltaRapidaPrecioInput(e.target.value)}
                      placeholder="1800,00"
                    />
                  </label>
                  <label>
                    Costo de compra ($):
                    <input
                      type="text"
                      value={altaRapidaCostoInput}
                      onChange={(e) => setAltaRapidaCostoInput(e.target.value)}
                      placeholder="1100,00"
                    />
                  </label>
                  <button type="submit" className="btn-primary">
                    Crear con este código y agregar al carrito
                  </button>
                </form>
              ) : (
                <p>
                  Solicitá a un encargado o superadmin que dé de alta este código.
                </p>
              )}
            </div>
          )}

          <div>
            <h3>Botones rápidos (productos sin código / pesables)</h3>
            <div className="quick-buttons-grid">
              {botonesRapidos.map((prod) => (
                <button
                  key={prod.id}
                  type="button"
                  className="btn-secondary quick-btn"
                  onClick={() => {
                    setCarrito((prev) =>
                      agregarProductoAlCarrito(
                        prev,
                        prod,
                        prod.permite_decimales ? 0.5 : 1
                      )
                    );
                    enfocarEntradaLector();
                  }}
                >
                  <span>{prod.nombre}</span>
                  <strong>{formatearMonedaARS(prod.precio_venta)}</strong>
                </button>
              ))}
            </div>
          </div>

          <h3>Carrito de Venta (Solo precios de venta al público)</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Cant.</th>
                <th className="num">Precio Unit.</th>
                <th className="num">Bonif. ($)</th>
                <th className="num">Subtotal</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {carrito.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    Escaneá un producto o elegí un botón rápido para comenzar.
                  </td>
                </tr>
              ) : (
                resumen.items.map((item) => (
                  <tr key={item.producto_id}>
                    <td>{item.descripcion}</td>
                    <td>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        className="qty-input"
                        value={item.cantidad}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isNaN(val)) {
                            setCarrito((prev) =>
                              actualizarCantidadEnCarrito(
                                prev,
                                item.producto_id,
                                val
                              )
                            );
                          }
                        }}
                      />
                    </td>
                    <td className="num">
                      {formatearMonedaARS(item.precio_unitario)}
                    </td>
                    <td className="num">
                      <input
                        type="text"
                        className="qty-input"
                        defaultValue="0,00"
                        aria-label={`Descuento ${item.descripcion}`}
                        onBlur={(e) => {
                          try {
                            const desc = pesosACentavos(e.target.value || '0');
                            setCarrito((prev) =>
                              aplicarDescuentoItemEnCarrito(
                                prev,
                                item.producto_id,
                                desc
                              )
                            );
                          } catch {
                            // Ignorar formato inválido hasta corregir
                          }
                        }}
                      />
                    </td>
                    <td className="num">
                      <strong>{formatearMonedaARS(item.subtotal)}</strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() =>
                          setCarrito((prev) =>
                            actualizarCantidadEnCarrito(
                              prev,
                              item.producto_id,
                              0
                            )
                          )
                        }
                      >
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="pos-card">
          <h2>Cobro y Emisión de Ticket</h2>

          <div className="arqueo-box">
            <div className="arqueo-line">
              <span>Subtotal ítems:</span>
              <strong>{formatearMonedaARS(resumen.subtotal)}</strong>
            </div>
            <div className="arqueo-line">
              <label htmlFor="descuento-global-input">
                Descuento global ($):
              </label>
              <input
                id="descuento-global-input"
                type="text"
                value={descuentoGlobalInput}
                onChange={(e) => setDescuentoGlobalInput(e.target.value)}
              />
            </div>
            <div className="arqueo-line destaque">
              <span>TOTAL A COBRAR:</span>
              <strong className="total-grande">
                {formatearMonedaARS(resumen.total)}
              </strong>
            </div>
          </div>

          <div className="form-stack">
            <div className="form-row">
              <label>
                Medio de pago principal:
                <select
                  value={medioPrincipal}
                  onChange={(e) =>
                    setMedioPrincipal(e.target.value as MedioPago)
                  }
                  disabled={modoPagoMixto}
                >
                  <option value="efectivo">Efectivo</option>
                  <option value="mercado_pago">Mercado Pago</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="debito">Tarjeta de Débito</option>
                  <option value="credito">Tarjeta de Crédito</option>
                  <option value="qr">QR</option>
                </select>
              </label>

              <button
                type="button"
                className="btn-secondary"
                onClick={() => setModoPagoMixto((prev) => !prev)}
              >
                {modoPagoMixto ? 'Usar pago único' : 'Combinar pagos (F9)'}
              </button>
            </div>

            {modoPagoMixto && (
              <div className="form-row">
                <label>
                  Parte en Efectivo ($):
                  <input
                    type="text"
                    value={montoEfectivoMixtoInput}
                    onChange={(e) => setMontoEfectivoMixtoInput(e.target.value)}
                    placeholder="2000,00"
                  />
                </label>
                <label>
                  Resto con segundo medio:
                  <select
                    value={medioSecundarioMixto}
                    onChange={(e) =>
                      setMedioSecundarioMixto(e.target.value as MedioPago)
                    }
                  >
                    <option value="mercado_pago">Mercado Pago</option>
                    <option value="transferencia">Transferencia</option>
                    <option value="debito">Tarjeta de Débito</option>
                    <option value="credito">Tarjeta de Crédito</option>
                  </select>
                </label>
              </div>
            )}

            <button
              type="button"
              className="btn-primary full-width"
              onClick={confirmarCobroVenta}
              disabled={carrito.length === 0}
            >
              Confirmar Venta y Emitir Ticket (F4)
            </button>
          </div>

          {ultimoTicketTexto && (
            <div className="ticket-preview" aria-label="Vista previa de ticket no fiscal">
              <h3>Ticket No Fiscal Emitido</h3>
              <pre>{ultimoTicketTexto}</pre>
            </div>
          )}

          {ventasSesion.length > 0 && (
            <div>
              <h3>Ventas recientes del turno (Anulación auditable)</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Operación</th>
                    <th className="num">Total</th>
                    <th>Estado</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {ventasSesion.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <code>#{v.id.slice(-6)}</code>
                      </td>
                      <td className="num">{formatearMonedaARS(v.total)}</td>
                      <td>
                        {v.estado === 'completada'
                          ? 'Completada'
                          : `Anulada (${v.motivoAnulacion})`}
                      </td>
                      <td>
                        {v.estado === 'completada' && (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setVentaAAnularId(v.id)}
                          >
                            Anular venta
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {ventaAAnularId && (
            <form onSubmit={manejarConfirmarAnulacion} className="form-stack">
              <h3>
                Anular venta #{ventaAAnularId.slice(-6)}{' '}
                {cajeroRequiereAutorizacion &&
                  '(Requiere autorización de Encargado/Superadmin)'}
              </h3>
              <label>
                Motivo obligatorio de anulación:
                <input
                  type="text"
                  value={motivoAnulacion}
                  onChange={(e) => setMotivoAnulacion(e.target.value)}
                  placeholder="Ej. Error al escanear producto"
                />
              </label>
              {cajeroRequiereAutorizacion && (
                <div className="form-row">
                  <label>
                    Usuario autorizador:
                    <input
                      type="text"
                      value={autorizadorUsuario}
                      onChange={(e) => setAutorizadorUsuario(e.target.value)}
                      placeholder="carlos"
                    />
                  </label>
                  <label>
                    Clave autorizador:
                    <input
                      type="password"
                      value={autorizadorClave}
                      onChange={(e) => setAutorizadorClave(e.target.value)}
                      placeholder="••••••••"
                    />
                  </label>
                </div>
              )}
              <div className="form-row">
                <button type="submit" className="btn-primary">
                  Confirmar Anulación y Devolver Stock
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setVentaAAnularId(null)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
