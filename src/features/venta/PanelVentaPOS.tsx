import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
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
  filtrarSugerenciasCatalogoPOS,
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
  type DatosTicketNoFiscal,
} from '../../domain/ticket.ts';
import { validarPagosVenta, type MedioPago } from '../../domain/totales.ts';
import type { ClienteConSaldoUI } from '../clientes/PanelClientesCuentaCorriente.tsx';

export interface VentaRecienteResumenUI {
  readonly id: string;
  readonly fecha: string;
  readonly total: Centavos;
  readonly estado: 'completada' | 'anulada';
  readonly motivo_anulacion?: string | null;
  readonly autorizada_por_nombre?: string | null;
}

export interface PanelVentaPOSProps {
  readonly rolActivo: RolUsuario;
  readonly operadorNombre: string;
  readonly catalogoInicial?: readonly ProductoCatalogoVenta[];
  readonly ventasRecientesIniciales?: readonly VentaRecienteResumenUI[];
  readonly clientesDisponibles?: readonly ClienteConSaldoUI[];
  readonly onDatosActualizados?: () => void;
}

const CATALOGO_FALLBACK_TESTS: ProductoCatalogoVenta[] = [
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-yerba',
    nombre: 'Yerba Mate Selección 1kg',
    codigo_interno: 'YER-001',
    codigos_barras: ['7791234560012', '7791234560019'],
    unidad: 'unidad',
    permite_decimales: false,
    precio_venta: 420000,
    costo_compra: 280000,
    alicuota_iva: 21,
    exento_iva: false,
    boton_rapido: false,
    stock_actual: 25,
  }),
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-alfajor',
    nombre: 'Alfajor Triple Chocolate',
    codigo_interno: 'ALF-003',
    codigos_barras: ['7790001112223'],
    unidad: 'unidad',
    permite_decimales: false,
    precio_venta: 150000,
    costo_compra: 85000,
    alicuota_iva: 21,
    exento_iva: false,
    boton_rapido: true,
    stock_actual: 30,
  }),
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-pan',
    nombre: 'Pan Francés Fresco (kg)',
    codigo_interno: 'PAN-KG',
    codigos_barras: ['200001'],
    unidad: 'kg',
    permite_decimales: true,
    precio_venta: 240000,
    costo_compra: 130000,
    alicuota_iva: 10.5,
    exento_iva: false,
    boton_rapido: true,
    stock_actual: 18,
  }),
  sanitizarProductoCatalogoParaPOS({
    id: 'prod-bolsa',
    nombre: 'Bolsa Reutilizable Grande',
    codigo_interno: 'BOL-01',
    codigos_barras: [],
    unidad: 'unidad',
    permite_decimales: false,
    precio_venta: 60000,
    costo_compra: 25000,
    alicuota_iva: 21,
    exento_iva: false,
    boton_rapido: true,
    stock_actual: 50,
  }),
];

export function PanelVentaPOS({
  rolActivo,
  operadorNombre,
  catalogoInicial = CATALOGO_FALLBACK_TESTS,
  ventasRecientesIniciales = [],
  clientesDisponibles = [],
  onDatosActualizados,
}: PanelVentaPOSProps): React.ReactElement {
  const [catalogo, setCatalogo] = useState<ProductoCatalogoVenta[]>(() =>
    catalogoInicial.map((p) => sanitizarProductoCatalogoParaPOS(p))
  );
  const [carrito, setCarrito] = useState<ItemCarritoPOS[]>([]);
  const [entradaLector, setEntradaLector] = useState('');
  const [indiceSugerenciaActiva, setIndiceSugerenciaActiva] = useState(0);
  const [desplegableAbierto, setDesplegableAbierto] = useState(true);
  const [descuentoGlobalInput, setDescuentoGlobalInput] = useState('0,00');

  useEffect(() => {
    setCatalogo(catalogoInicial.map((p) => sanitizarProductoCatalogoParaPOS(p)));
  }, [catalogoInicial]);

  // Pagos mixtos y cliente (Cuenta Corriente Fase 3)
  const [clienteSeleccionadoId, setClienteSeleccionadoId] =
    useState<string>('');
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

  // Comprobante, impresión ESC/POS y anulaciones
  const [ultimaVentaId, setUltimaVentaId] = useState<string | null>(null);
  const [ultimoTicketTexto, setUltimoTicketTexto] = useState<string | null>(
    null
  );
  const [anchoEscPosMm, setAnchoEscPosMm] = useState<58 | 80>(80);
  const [ventasSesion, setVentasSesion] = useState<VentaRecienteResumenUI[]>(
    () => [...ventasRecientesIniciales]
  );
  useEffect(() => {
    setVentasSesion([...ventasRecientesIniciales]);
  }, [ventasRecientesIniciales]);

  const [ventaAAnularId, setVentaAAnularId] = useState<string | null>(null);
  const [motivoAnulacion, setMotivoAnulacion] = useState('');
  const [autorizadorUsuario, setAutorizadorUsuario] = useState('carlos');
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

  // Sugerencias en vivo a medida que el vendedor escribe nombre o código
  const sugerencias = useMemo(
    () => filtrarSugerenciasCatalogoPOS(catalogo, entradaLector, 8),
    [catalogo, entradaLector]
  );

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

  function seleccionarProductoParaCarrito(
    prod: ProductoCatalogoVenta,
    etiquetaOrigen: string
  ) {
    setMensajeError(null);
    setCodigoInexistenteDetectado(null);
    setCarrito((prev) =>
      agregarProductoAlCarrito(prev, prod, prod.permite_decimales ? 0.5 : 1)
    );
    setEntradaLector('');
    setIndiceSugerenciaActiva(0);
    setDesplegableAbierto(false);
    setMensajeEstado(
      `${etiquetaOrigen} Agregado: ${prod.nombre} (${formatearMonedaARS(prod.precio_venta)})`
    );
    enfocarEntradaLector();
  }

  function procesarEntradaCodigoOBusqueda(textoRaw: string, fueRafaga: boolean) {
    setMensajeError(null);
    setMensajeEstado(null);
    setCodigoInexistenteDetectado(null);

    const texto = textoRaw.trim();
    if (!texto) return;

    // 1. Buscar coincidencia exacta por código de barras o código interno
    const porCodigo = catalogo.find(
      (p) =>
        p.codigos_barras.some(
          (cb) => cb.toLowerCase() === texto.toLowerCase()
        ) ||
        (p.codigo_interno &&
          p.codigo_interno.toLowerCase() === texto.toLowerCase())
    );

    if (porCodigo) {
      seleccionarProductoParaCarrito(
        porCodigo,
        fueRafaga ? '[Escáner]' : '[Código]'
      );
      return;
    }

    // 2. Si hay sugerencias en el desplegable, Enter selecciona la opción resaltada actualmente
    if (sugerencias.length > 0) {
      const indiceSeguro = Math.min(
        Math.max(0, indiceSugerenciaActiva),
        sugerencias.length - 1
      );
      const prodElegido = sugerencias[indiceSeguro];
      if (prodElegido) {
        seleccionarProductoParaCarrito(prodElegido, '[Buscador]');
        return;
      }
    }

    // 3. Código o producto inexistente: ofrecer crearlo sin salir de la venta si es superadmin o encargado (PLAN.md §9)
    setCodigoInexistenteDetectado(texto);
    setEntradaLector('');
  }

  function manejarKeyDownLector(e: React.KeyboardEvent<HTMLInputElement>) {
    const ahora = performance.now();

    if (e.key === 'ArrowDown' && sugerencias.length > 0) {
      e.preventDefault();
      setDesplegableAbierto(true);
      setIndiceSugerenciaActiva((prev) => (prev + 1) % sugerencias.length);
      return;
    }

    if (e.key === 'ArrowUp' && sugerencias.length > 0) {
      e.preventDefault();
      setDesplegableAbierto(true);
      setIndiceSugerenciaActiva(
        (prev) => (prev - 1 + sugerencias.length) % sugerencias.length
      );
      return;
    }

    if (e.key === 'Escape') {
      if (desplegableAbierto && sugerencias.length > 0) {
        e.preventDefault();
        setDesplegableAbierto(false);
        return;
      }
    }

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
          void confirmarCobroVenta();
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
        setDesplegableAbierto(false);
        enfocarEntradaLector();
        break;
      default:
        break;
    }
  }

  async function manejarCrearProductoDesdeEscaneo(e: React.FormEvent) {
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

      const res = await invocarPosApi<{ productoId: string }>('crear_producto', {
        rolActivo,
        nombre: altaRapidaNombre.trim(),
        costoCompraCentavos: costoCompra,
        precioVentaCentavos: precioVenta,
        codigosBarras: [codigoInexistenteDetectado],
        stockInicial: 10,
      });

      const nuevoProd = sanitizarProductoCatalogoParaPOS({
        id: res.productoId,
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
        stock_actual: 10,
      });

      setCatalogo((prev) => [...prev, nuevoProd]);
      setCarrito((prev) => agregarProductoAlCarrito(prev, nuevoProd, 1));
      setCodigoInexistenteDetectado(null);
      setAltaRapidaNombre('');
      setAltaRapidaPrecioInput('');
      setAltaRapidaCostoInput('');
      setMensajeEstado(
        `Producto "${nuevoProd.nombre}" guardado en SQLite y agregado al carrito.`
      );
      onDatosActualizados?.();
      enfocarEntradaLector();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo crear el producto.'
      );
    }
  }

  async function confirmarCobroVenta() {
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

      const usaCuentaCorriente = pagos.some(
        (p) => p.medio === 'cuenta_corriente' && p.monto > 0
      );
      if (usaCuentaCorriente && !clienteSeleccionadoId) {
        throw new Error(
          'Seleccioná un cliente registrado para cobrar en Cuenta Corriente.'
        );
      }

      validarPagosVenta(pagos, resumen.total);

      const respuesta = await invocarPosApi<{
        ventaId: string;
        totalCentavos: Centavos;
        datosTicket: DatosTicketNoFiscal;
      }>('registrar_venta', {
        rolActivo,
        clienteId: clienteSeleccionadoId || undefined,
        items: carrito.map((it) => ({
          productoId: it.producto_id,
          cantidad: it.cantidad,
          descuentoCentavos: it.descuento,
        })),
        descuentoGlobalCentavos: resumen.descuento_global,
        pagos,
      });

      const datosTicketSeguro = construirDatosTicketSeguro({
        comercioNombre: respuesta.datosTicket.comercioNombre,
        comercioCuit: respuesta.datosTicket.comercioCuit,
        comercioDomicilio: respuesta.datosTicket.comercioDomicilio,
        comercioCondicionIva: respuesta.datosTicket.comercioCondicionIva,
        ventaId: respuesta.datosTicket.ventaId,
        fechaIso: respuesta.datosTicket.fechaIso,
        cajeroNombre: respuesta.datosTicket.cajeroNombre,
        clienteNombre: respuesta.datosTicket.clienteNombre,
        items: respuesta.datosTicket.items.map((it) => ({
          producto_id: '',
          descripcion: it.descripcion,
          cantidad: it.cantidad,
          precio_unitario: it.precio_unitario,
          descuento: it.descuento,
          subtotal: it.subtotal,
          alicuota_iva: 21,
        })),
        subtotal: respuesta.datosTicket.subtotal,
        descuentoGlobal: respuesta.datosTicket.descuentoGlobal,
        total: respuesta.datosTicket.total,
        pagos: respuesta.datosTicket.pagos,
      });

      const ticketTexto = formatearTicketNoFiscalTexto(datosTicketSeguro);
      setUltimaVentaId(respuesta.ventaId);
      setUltimoTicketTexto(ticketTexto);

      setCarrito([]);
      setDescuentoGlobalInput('0,00');
      setMontoEfectivoMixtoInput('');
      setModoPagoMixto(false);
      setMensajeEstado(
        `Venta #${respuesta.ventaId.slice(-6)} guardada en SQLite por ${formatearMonedaARS(respuesta.totalCentavos)}. Stock descontado y auditado.`
      );
      onDatosActualizados?.();
      enfocarEntradaLector();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo completar el cobro.'
      );
    }
  }

  async function manejarImprimirODescargarEscPos(
    ventaId: string,
    anchoMm: 58 | 80
  ) {
    setMensajeError(null);
    try {
      const res = await invocarPosApi<{
        textoPlano: string;
        comandosEscPosBase64: string;
        anchoCaracteres: number;
      }>('generar_ticket_escpos', {
        rolActivo,
        ventaId,
        anchoMm,
      });

      setUltimoTicketTexto(res.textoPlano);

      if (
        typeof window !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        const binario = atob(res.comandosEscPosBase64);
        const bytes = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) {
          bytes[i] = binario.charCodeAt(i);
        }
        const blob = new Blob([bytes.buffer], {
          type: 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ticket-escpos-${anchoMm}mm-${ventaId.slice(0, 8)}.bin`;
        a.click();
        URL.revokeObjectURL(url);
      }

      setMensajeEstado(
        `Ticket térmico ESC/POS (${anchoMm}mm, ${res.anchoCaracteres} cols) generado sin costos internos.`
      );
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Error al generar ticket térmico ESC/POS.'
      );
    }
  }

  async function manejarConfirmarAnulacion(e: React.FormEvent) {
    e.preventDefault();
    if (!ventaAAnularId) return;
    setMensajeError(null);

    if (!motivoAnulacion.trim()) {
      setMensajeError('El motivo de anulación es obligatorio (PLAN.md §6.1).');
      return;
    }

    if (cajeroRequiereAutorizacion && !autorizadorUsuario.trim()) {
      setMensajeError(
        'Como cajero necesitás indicar el usuario de un encargado o superadmin para autorizar la anulación.'
      );
      return;
    }

    try {
      await invocarPosApi('anular_venta', {
        rolActivo,
        ventaId: ventaAAnularId,
        motivo: motivoAnulacion.trim(),
        autorizadorUsuario: autorizadorUsuario.trim(),
        autorizadorClave,
      });

      setVentaAAnularId(null);
      setMotivoAnulacion('');
      setAutorizadorClave('');
      setMensajeEstado(
        'Venta anulada en SQLite. Stock devuelto y rastro registrado en auditoría.'
      );
      onDatosActualizados?.();
      enfocarEntradaLector();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo anular la venta.'
      );
    }
  }

  return (
    <div
      className="pos-venta-wrapper"
      onKeyDown={manejarAtajoGlobal}
      tabIndex={-1}
    >
      <div className="shortcuts-bar" aria-label="Atajos de teclado de caja">
        <span>
          <strong>Operador:</strong> {operadorNombre}
        </span>
        <span>
          <kbd>F2</kbd> Enfocar lector/búsqueda
        </span>
        <span>
          <kbd>↑</kbd>/<kbd>↓</kbd> + <kbd>Enter</kbd> Elegir del desplegable
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
          <kbd>Esc</kbd> Cerrar/Limpiar
        </span>
      </div>

      {mensajeError && <div className="alert-error">{mensajeError}</div>}
      {mensajeEstado && <div className="alert-ok">{mensajeEstado}</div>}

      <div className="panel-grid">
        <div className="pos-card">
          <div className="scanner-box">
            <label htmlFor="input-lector-barras">
              Lector de códigos de barras o buscador por nombre (<kbd>F2</kbd>):
            </label>
            <div className="autocomplete-container">
              <div className="form-row">
                <input
                  id="input-lector-barras"
                  ref={inputLectorRef}
                  type="text"
                  className="scanner-input"
                  value={entradaLector}
                  onChange={(e) => {
                    setEntradaLector(e.target.value);
                    setIndiceSugerenciaActiva(0);
                    setDesplegableAbierto(true);
                  }}
                  onFocus={() => setDesplegableAbierto(true)}
                  onKeyDown={manejarKeyDownLector}
                  placeholder="Escaneá un código o escribí el nombre del producto (ej. yerba, alfajor, pan)..."
                  autoComplete="off"
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

              {desplegableAbierto &&
                entradaLector.trim().length > 0 &&
                sugerencias.length > 0 && (
                  <ul
                    className="autocomplete-dropdown"
                    role="listbox"
                    aria-label="Productos coincidentes"
                  >
                    {sugerencias.map((prod, idx) => {
                      const esActiva = idx === indiceSugerenciaActiva;
                      return (
                        <li
                          key={prod.id}
                          role="option"
                          aria-selected={esActiva}
                          className={
                            esActiva
                              ? 'autocomplete-item active'
                              : 'autocomplete-item'
                          }
                          onMouseEnter={() => setIndiceSugerenciaActiva(idx)}
                          onMouseDown={(e) => {
                            // onMouseDown evita que el input pierda foco antes de agregar el producto
                            e.preventDefault();
                            seleccionarProductoParaCarrito(prod, '[Desplegable]');
                          }}
                        >
                          <div className="autocomplete-main">
                            <strong>{prod.nombre}</strong>
                            <span className="autocomplete-codes">
                              {prod.codigo_interno
                                ? `${prod.codigo_interno} · `
                                : ''}
                              {prod.codigos_barras.length > 0
                                ? prod.codigos_barras.join(', ')
                                : 'Sin código EAN'}
                            </span>
                          </div>
                          <div className="autocomplete-meta">
                            {prod.stock_actual !== undefined && (
                              <span className="badge-rol">
                                Stock: {prod.stock_actual} {prod.unidad}
                              </span>
                            )}
                            <strong className="autocomplete-price">
                              {formatearMonedaARS(prod.precio_venta)}
                            </strong>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

              {desplegableAbierto &&
                entradaLector.trim().length > 0 &&
                sugerencias.length === 0 && (
                  <div className="autocomplete-empty">
                    No hay productos cargados que coincidan con "
                    <strong>{entradaLector.trim()}</strong>". Presioná{' '}
                    <kbd>Enter</kbd> para darlo de alta rápido.
                  </div>
                )}
            </div>
          </div>

          {codigoInexistenteDetectado && (
            <div className="alert-info">
              <p>
                <strong>
                  El código o producto "{codigoInexistenteDetectado}" no está
                  registrado.
                </strong>
              </p>
              {puedeCrearProductoRapido ? (
                <form
                  onSubmit={(e) => void manejarCrearProductoDesdeEscaneo(e)}
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
                    Crear en SQLite y agregar al carrito
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
                  onClick={() =>
                    seleccionarProductoParaCarrito(prod, '[Botón rápido]')
                  }
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
                    Escaneá un producto, buscalo por nombre en el desplegable o elegí un botón rápido.
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
                            // Ignorar formato inválido
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
                Cliente (opcional o requerido en Cta. Cte.):
                <select
                  value={clienteSeleccionadoId}
                  onChange={(e) => setClienteSeleccionadoId(e.target.value)}
                >
                  <option value="">Consumidor Final (Anónimo)</option>
                  {clientesDisponibles.map((cli) => (
                    <option key={cli.id} value={cli.id}>
                      {cli.nombre}
                      {cli.documento ? ` (${cli.documento})` : ''} — Disp.:{' '}
                      {cli.limite_credito_centavos > 0
                        ? formatearMonedaARS(
                            cli.credito_disponible_centavos as Centavos
                          )
                        : 'Sin tope'}
                    </option>
                  ))}
                </select>
              </label>
            </div>

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
                  <option value="cuenta_corriente">
                    Cuenta Corriente (Fiado)
                  </option>
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
                    <option value="cuenta_corriente">
                      Cuenta Corriente (Fiado)
                    </option>
                  </select>
                </label>
              </div>
            )}

            <button
              type="button"
              className="btn-primary full-width"
              onClick={() => void confirmarCobroVenta()}
              disabled={carrito.length === 0}
            >
              Confirmar Venta y Guardar en SQLite (F4)
            </button>
          </div>

          {ultimoTicketTexto && (
            <div
              className="ticket-preview"
              aria-label="Vista previa de ticket no fiscal"
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <h3>Ticket Térmico No Fiscal Emitido</h3>
                {ultimaVentaId && (
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <select
                      aria-label="Ancho de papel térmico"
                      value={anchoEscPosMm}
                      onChange={(e) =>
                        setAnchoEscPosMm(Number(e.target.value) as 58 | 80)
                      }
                    >
                      <option value={80}>Papel 80mm (48 cols)</option>
                      <option value={58}>Papel 58mm (32 cols)</option>
                    </select>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() =>
                        void manejarImprimirODescargarEscPos(
                          ultimaVentaId,
                          anchoEscPosMm
                        )
                      }
                    >
                      Imprimir / ESC-POS ({anchoEscPosMm}mm)
                    </button>
                  </div>
                )}
              </div>
              <pre>{ultimoTicketTexto}</pre>
            </div>
          )}

          {ventasSesion.length > 0 && (
            <div>
              <h3>Ventas guardadas en base local (Anulación auditable)</h3>
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
                          : `Anulada (${v.motivo_anulacion ?? 'Sin motivo'})`}
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
            <form
              onSubmit={(e) => void manejarConfirmarAnulacion(e)}
              className="form-stack"
            >
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
                    Usuario autorizador (ej. carlos o maria):
                    <input
                      type="text"
                      value={autorizadorUsuario}
                      onChange={(e) => setAutorizadorUsuario(e.target.value)}
                      placeholder="carlos"
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
