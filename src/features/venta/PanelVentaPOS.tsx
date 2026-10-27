import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from '../../domain/dinero.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';
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
import {
  evaluarPagosCombinados,
  validarPagosVenta,
  type MedioPago,
} from '../../domain/totales.ts';
import {
  determinarTipoComprobanteArca,
  parsearCodigoBarrasBalanza,
} from '../../domain/arca_fase4.ts';
import type { ClienteConSaldoUI } from '../clientes/PanelClientesCuentaCorriente.tsx';
import type { EstadoConfiguracionArcaDTO } from '../configuracion/PanelConfiguracionSync.tsx';

export interface ListaPrecioUI {
  readonly id: string;
  readonly nombre: string;
  readonly es_predeterminada: boolean;
  readonly cantidad_productos_con_precio: number;
}

export interface ComboPromocionUI {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string | null;
  readonly codigo_barras: string | null;
  readonly precio_venta: Centavos;
  readonly precio_suma_normal: Centavos;
  readonly ahorro_centavos: Centavos;
  readonly porcentaje_descuento: number;
  readonly stock_combos_disponibles: number;
  readonly items: readonly {
    readonly producto_id: string;
    readonly producto_nombre: string;
    readonly cantidad: number;
    readonly precio_unitario_normal: Centavos;
    readonly stock_actual: number;
  }[];
}

export interface VentaRecienteResumenUI {
  readonly id: string;
  readonly fecha: string;
  readonly total: Centavos;
  readonly estado: 'completada' | 'anulada';
  readonly motivo_anulacion?: string | null;
  readonly autorizada_por_nombre?: string | null;
  readonly tipo_comprobante?: string;
  readonly punto_venta?: number | null;
  readonly numero_comprobante?: number | null;
  readonly cae?: string | null;
  readonly cae_vencimiento?: string | null;
  readonly estado_facturacion?: string;
  readonly nota_credito_tipo?: string | null;
  readonly nota_credito_cae?: string | null;
}

export interface PanelVentaPOSProps {
  readonly rolActivo: RolUsuario;
  readonly operadorNombre: string;
  readonly catalogoInicial?: readonly ProductoCatalogoVenta[];
  readonly ventasRecientesIniciales?: readonly VentaRecienteResumenUI[];
  readonly clientesDisponibles?: readonly ClienteConSaldoUI[];
  readonly configArca?: EstadoConfiguracionArcaDTO | null;
  readonly listasPrecioDisponibles?: readonly ListaPrecioUI[];
  readonly combosDisponibles?: readonly ComboPromocionUI[];
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
  configArca = null,
  listasPrecioDisponibles = [],
  combosDisponibles = [],
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
  const [listaPrecioId, setListaPrecioId] = useState<string>('');
  const [comprobanteFiscalActivo, setComprobanteFiscalActivo] = useState<{
    readonly numeroFormateado: string;
    readonly letra: string;
    readonly codigoNumerico: string;
    readonly urlQrOficial: string;
    readonly qrSvg: string;
    readonly textoTermico: string;
    readonly htmlImprimible: string;
  } | null>(null);

  useEffect(() => {
    setCatalogo(catalogoInicial.map((p) => sanitizarProductoCatalogoParaPOS(p)));
  }, [catalogoInicial]);

  // Pagos mixtos / combinados y cliente (Cuenta Corriente Fase 3)
  const [clienteSeleccionadoId, setClienteSeleccionadoId] =
    useState<string>('');
  const [medioPrincipal, setMedioPrincipal] = useState<MedioPago>('efectivo');
  const [modoPagoMixto, setModoPagoMixto] = useState(false);
  const [pagosCombinadosUI, setPagosCombinadosUI] = useState<
    Array<{ id: string; medio: MedioPago; montoInput: string }>
  >([
    { id: 'pago-1', medio: 'efectivo', montoInput: '' },
    { id: 'pago-2', medio: 'mercado_pago', montoInput: '' },
  ]);

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
  const [paginaVentasRecientes, setPaginaVentasRecientes] = useState(1);
  useEffect(() => {
    setVentasSesion([...ventasRecientesIniciales]);
  }, [ventasRecientesIniciales]);

  const paginacionVentasRecientes = paginarListado(
    ventasSesion,
    paginaVentasRecientes,
    TAMANIO_PAGINA_POR_DEFECTO
  );

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

  function parsearMontoInputCentavos(valor: string): Centavos {
    const limpio = valor.trim();
    if (!limpio) return 0;
    try {
      const c = pesosACentavos(limpio);
      return c > 0 ? c : 0;
    } catch {
      return 0;
    }
  }

  function centavosAInputPesos(centavos: Centavos): string {
    return (Math.max(0, centavos) / 100).toFixed(2).replace('.', ',');
  }

  const pagosCombinadosCalculados = useMemo(
    () =>
      pagosCombinadosUI.map((fila) => ({
        id: fila.id,
        medio: fila.medio,
        montoInput: fila.montoInput,
        monto: parsearMontoInputCentavos(fila.montoInput),
      })),
    [pagosCombinadosUI]
  );

  const estadoPagosCombinados = useMemo(
    () =>
      evaluarPagosCombinados(
        pagosCombinadosCalculados.map((p) => ({
          medio: p.medio,
          monto: p.monto,
        })),
        resumen.total
      ),
    [pagosCombinadosCalculados, resumen.total]
  );

  function actualizarFilaPagoCombinado(
    id: string,
    cambios: Partial<{ medio: MedioPago; montoInput: string }>
  ) {
    setPagosCombinadosUI((prev) =>
      prev.map((fila) => (fila.id === id ? { ...fila, ...cambios } : fila))
    );
  }

  function completarRestoEnFilaPago(id: string) {
    const sumaOtras = pagosCombinadosCalculados
      .filter((f) => f.id !== id)
      .reduce((acc, f) => acc + f.monto, 0);
    const resto = Math.max(0, resumen.total - sumaOtras);
    actualizarFilaPagoCombinado(id, {
      montoInput: centavosAInputPesos(resto),
    });
  }

  function agregarFilaPagoCombinado() {
    const ordenMedios: MedioPago[] = [
      'efectivo',
      'mercado_pago',
      'transferencia',
      'debito',
      'credito',
      'qr',
      'cuenta_corriente',
      'otro',
    ];
    const usados = new Set(pagosCombinadosUI.map((f) => f.medio));
    const siguienteMedio =
      ordenMedios.find((m) => !usados.has(m)) ?? 'transferencia';
    const restoActual = estadoPagosCombinados.faltaCubrirCentavos;

    setPagosCombinadosUI((prev) => [
      ...prev,
      {
        id: `pago-${Date.now()}-${prev.length + 1}`,
        medio: siguienteMedio,
        montoInput: restoActual > 0 ? centavosAInputPesos(restoActual) : '',
      },
    ]);
  }

  function quitarFilaPagoCombinado(id: string) {
    setPagosCombinadosUI((prev) =>
      prev.length <= 2 ? prev : prev.filter((fila) => fila.id !== id)
    );
  }

  function enfocarEntradaLector() {
    inputLectorRef.current?.focus();
  }

  useEffect(() => {
    enfocarEntradaLector();
  }, []);

  function seleccionarProductoParaCarrito(
    prod: ProductoCatalogoVenta,
    etiquetaOrigen: string,
    cantidadPersonalizada?: number
  ) {
    setMensajeError(null);
    setCodigoInexistenteDetectado(null);
    const cantAgregar =
      cantidadPersonalizada ?? (prod.permite_decimales ? 0.5 : 1);
    setCarrito((prev) => agregarProductoAlCarrito(prev, prod, cantAgregar));
    setEntradaLector('');
    setIndiceSugerenciaActiva(0);
    setDesplegableAbierto(false);
    setMensajeEstado(
      `${etiquetaOrigen} Agregado: ${prod.nombre} x ${cantAgregar} ${prod.unidad} (${formatearMonedaARS(prod.precio_venta)})`
    );
    enfocarEntradaLector();
  }

  function procesarEntradaCodigoOBusqueda(textoRaw: string, fueRafaga: boolean) {
    setMensajeError(null);
    setMensajeEstado(null);
    setCodigoInexistenteDetectado(null);

    const texto = textoRaw.trim();
    if (!texto) return;

    // 0. Verificar si es un código EAN-13 de balanza con peso/importe embebido (PLAN.md §9 y §10)
    const balanza = parsearCodigoBarrasBalanza(texto);
    if (balanza.esCodigoBalanza && balanza.codigoPlu) {
      const pluNum = String(Number(balanza.codigoPlu));
      const prodBalanza = catalogo.find(
        (p) =>
          p.codigo_interno === balanza.codigoPlu ||
          p.codigo_interno === pluNum ||
          p.codigos_barras.some(
            (cb) =>
              cb === balanza.codigoPlu ||
              cb === pluNum ||
              cb.endsWith(pluNum)
          )
      );
      if (prodBalanza) {
        const cantKg =
          balanza.modo === 'peso' && balanza.cantidadKg
            ? balanza.cantidadKg
            : balanza.modo === 'importe' &&
                balanza.importeCentavos &&
                prodBalanza.precio_venta > 0
              ? Number(
                  (balanza.importeCentavos / prodBalanza.precio_venta).toFixed(
                    3
                  )
                )
              : 1;
        seleccionarProductoParaCarrito(
          prodBalanza,
          '[Balanza EAN-13]',
          cantKg
        );
        return;
      }
    }

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

      if (modoPagoMixto) {
        pagos = pagosCombinadosCalculados.map((fila) => ({
          medio: fila.medio,
          monto: fila.monto,
        }));

        if (pagos.some((p) => p.monto <= 0)) {
          throw new Error(
            'Ingresá un monto mayor a $ 0,00 en cada medio de pago combinado (o quitá los medios que no uses).'
          );
        }
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
        listaPrecioId: listaPrecioId || undefined,
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
      setPagosCombinadosUI([
        { id: 'pago-1', medio: 'efectivo', montoInput: '' },
        { id: 'pago-2', medio: 'mercado_pago', montoInput: '' },
      ]);
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

  async function manejarVerComprobanteFiscalArca(ventaId: string) {
    setMensajeError(null);
    try {
      const comp = await invocarPosApi<{
        numeroFormateado: string;
        letra: string;
        codigoNumerico: string;
        urlQrOficial: string;
        qrSvg: string;
        textoTermico: string;
        htmlImprimible: string;
      }>('obtener_comprobante_fiscal_imprimible', {
        rolActivo,
        ventaId,
      });
      setComprobanteFiscalActivo(comp);
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo obtener el comprobante fiscal ARCA.'
      );
    }
  }

  function manejarAgregarComboAlCarrito(combo: ComboPromocionUI) {
    setMensajeError(null);
    let nuevoCarrito = [...carrito];
    for (const item of combo.items) {
      const prod = catalogo.find((p) => p.id === item.producto_id);
      if (prod) {
        nuevoCarrito = agregarProductoAlCarrito(
          nuevoCarrito,
          prod,
          item.cantidad
        );
      }
    }
    setCarrito(nuevoCarrito);
    if (combo.ahorro_centavos > 0) {
      const descuentoNuevo = descuentoGlobalCentavos + combo.ahorro_centavos;
      setDescuentoGlobalInput(
        (descuentoNuevo / 100).toFixed(2).replace('.', ',')
      );
    }
    setMensajeEstado(
      `[Combo] Agregado "${combo.nombre}" por ${formatearMonedaARS(combo.precio_venta)} (Ahorro: ${formatearMonedaARS(combo.ahorro_centavos)})`
    );
    enfocarEntradaLector();
  }

  const clienteActualObj = clientesDisponibles.find(
    (c) => c.id === clienteSeleccionadoId
  );
  const infoFiscalPrevia = configArca?.arca_habilitada
    ? determinarTipoComprobanteArca({
        arcaHabilitada: true,
        condicionIvaEmisor: configArca.condicion_iva,
        condicionIvaReceptor:
          (clienteActualObj?.condicion_iva as
            | 'monotributo'
            | 'responsable_inscripto'
            | 'exento'
            | 'consumidor_final'
            | undefined) ?? 'consumidor_final',
      })
    : null;

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
                  {prod.imagen_path && (
                    <img
                      src={`/api/pos-imagen/${prod.id}_thumb.webp`}
                      alt={prod.nombre}
                      style={{
                        width: '36px',
                        height: '36px',
                        objectFit: 'cover',
                        borderRadius: '0.35rem',
                        marginBottom: '0.2rem',
                      }}
                      onError={(ev) => {
                        (ev.currentTarget as HTMLImageElement).style.display =
                          'none';
                      }}
                    />
                  )}
                  <span>{prod.nombre}</span>
                  <strong>{formatearMonedaARS(prod.precio_venta)}</strong>
                </button>
              ))}
              {combosDisponibles.map((combo) => (
                <button
                  key={combo.id}
                  type="button"
                  className="btn-secondary quick-btn"
                  onClick={() => manejarAgregarComboAlCarrito(combo)}
                >
                  <span>[Combo] {combo.nombre}</span>
                  <strong>{formatearMonedaARS(combo.precio_venta)}</strong>
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
            {listasPrecioDisponibles.length > 1 && (
              <div className="form-row">
                <label>
                  Lista de Precios Aplicada:
                  <select
                    value={listaPrecioId}
                    onChange={(e) => setListaPrecioId(e.target.value)}
                  >
                    <option value="">Mostrador (Predeterminada)</option>
                    {listasPrecioDisponibles.map((lp) => (
                      <option key={lp.id} value={lp.id}>
                        {lp.nombre}
                        {lp.es_predeterminada ? ' (Predeterminada)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {configArca?.arca_habilitada && infoFiscalPrevia && (
              <div
                className="alert-info"
                aria-label="Indicador de facturación electrónica ARCA activa"
              >
                <strong>
                  Facturación ARCA Activa ({configArca.arca_ambiente.toUpperCase()}):
                </strong>{' '}
                Se emitirá automáticamente{' '}
                <strong>
                  {infoFiscalPrevia.tipoComprobante
                    .replace(/_/g, ' ')
                    .toUpperCase()}{' '}
                  [{infoFiscalPrevia.letra}]
                </strong>{' '}
                (Pto. Vta. {String(configArca.arca_punto_venta).padStart(4, '0')}
                ). Si no hay internet, queda <code>pendiente</code> sin bloquear
                la caja.
              </div>
            )}

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
              <div
                className="arqueo-box"
                aria-label="Combinación de medios de pago"
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    marginBottom: '0.6rem',
                  }}
                >
                  <strong>
                    Medios de pago combinados ({pagosCombinadosUI.length})
                  </strong>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={agregarFilaPagoCombinado}
                  >
                    + Agregar medio de pago
                  </button>
                </div>

                <div className="form-stack">
                  {pagosCombinadosUI.map((fila, idx) => (
                    <div
                      key={fila.id}
                      className="form-row"
                      style={{ alignItems: 'flex-end' }}
                    >
                      <label style={{ flex: 1 }}>
                        Medio de pago #{idx + 1}:
                        <select
                          aria-label={`Medio de pago combinado ${idx + 1}`}
                          value={fila.medio}
                          onChange={(e) =>
                            actualizarFilaPagoCombinado(fila.id, {
                              medio: e.target.value as MedioPago,
                            })
                          }
                        >
                          <option value="efectivo">Efectivo</option>
                          <option value="mercado_pago">Mercado Pago</option>
                          <option value="transferencia">Transferencia</option>
                          <option value="debito">Tarjeta de Débito</option>
                          <option value="credito">Tarjeta de Crédito</option>
                          <option value="qr">QR Interoperable</option>
                          <option value="cuenta_corriente">
                            Cuenta Corriente (Fiado)
                          </option>
                          <option value="otro">Otro</option>
                        </select>
                      </label>

                      <label style={{ flex: 1 }}>
                        Monto #{idx + 1} ($):
                        <input
                          type="text"
                          aria-label={`Monto medio de pago ${idx + 1}`}
                          value={fila.montoInput}
                          onChange={(e) =>
                            actualizarFilaPagoCombinado(fila.id, {
                              montoInput: e.target.value,
                            })
                          }
                          placeholder="0,00"
                        />
                      </label>

                      <button
                        type="button"
                        className="btn-secondary"
                        title="Completar automáticamente con el saldo restante a cobrar"
                        onClick={() => completarRestoEnFilaPago(fila.id)}
                      >
                        Completar resto
                      </button>

                      {pagosCombinadosUI.length > 2 && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => quitarFilaPagoCombinado(fila.id)}
                        >
                          Quitar
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    marginTop: '0.65rem',
                    paddingTop: '0.6rem',
                    borderTop: '1px solid #cbd5e1',
                  }}
                >
                  <div className="arqueo-line">
                    <span>Suma de pagos ingresados:</span>
                    <strong>
                      {formatearMonedaARS(estadoPagosCombinados.sumaPagos)}
                    </strong>
                  </div>
                  <div className="arqueo-line">
                    <span>Monto total a cobrar:</span>
                    <strong>
                      {formatearMonedaARS(estadoPagosCombinados.totalACobrar)}
                    </strong>
                  </div>
                  {resumen.total > 0 && (
                    <div
                      className={
                        estadoPagosCombinados.esValidoParaCobrar
                          ? 'alert-ok'
                          : 'alert-error'
                      }
                      style={{ marginTop: '0.45rem', marginBottom: 0 }}
                    >
                      {estadoPagosCombinados.esValidoParaCobrar ? (
                        <span>
                          ✓ Suma verificada: coincide con el monto a cobrar (
                          {formatearMonedaARS(resumen.total)}).
                        </span>
                      ) : estadoPagosCombinados.faltaCubrirCentavos > 0 ? (
                        <span>
                          Faltan cubrir{' '}
                          <strong>
                            {formatearMonedaARS(
                              estadoPagosCombinados.faltaCubrirCentavos
                            )}
                          </strong>{' '}
                          para alcanzar el monto a cobrar.
                        </span>
                      ) : estadoPagosCombinados.excedenteCentavos > 0 ? (
                        <span>
                          La suma excede el monto a cobrar por{' '}
                          <strong>
                            {formatearMonedaARS(
                              estadoPagosCombinados.excedenteCentavos
                            )}
                          </strong>
                          .
                        </span>
                      ) : (
                        <span>
                          Todos los medios de pago combinados deben tener un
                          monto mayor a $ 0,00.
                        </span>
                      )}
                    </div>
                  )}
                </div>
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
                  {paginacionVentasRecientes.itemsPagina.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <code>#{v.id.slice(-6)}</code>
                      </td>
                      <td className="num">{formatearMonedaARS(v.total)}</td>
                      <td>
                        {v.estado === 'completada'
                          ? 'Completada'
                          : `Anulada (${v.motivo_anulacion ?? 'Sin motivo'})`}
                        {configArca?.arca_habilitada &&
                          v.estado_facturacion &&
                          v.estado_facturacion !== 'no_aplica' && (
                            <div style={{ fontSize: '0.78rem', marginTop: '2px' }}>
                              ARCA: <strong>{v.estado_facturacion}</strong>
                              {v.cae ? ` (CAE ${v.cae})` : ''}
                              {v.nota_credito_cae
                                ? ` · NC CAE ${v.nota_credito_cae}`
                                : ''}
                            </div>
                          )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          {configArca?.arca_habilitada && v.cae && (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() =>
                                void manejarVerComprobanteFiscalArca(v.id)
                              }
                            >
                              Factura / QR ARCA
                            </button>
                          )}
                          {v.estado === 'completada' && (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => setVentaAAnularId(v.id)}
                            >
                              Anular venta
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <PaginadorTabla
                paginaActual={paginacionVentasRecientes.paginaActual}
                totalPaginas={paginacionVentasRecientes.totalPaginas}
                totalItems={paginacionVentasRecientes.totalItems}
                desdeRegistro={paginacionVentasRecientes.desdeRegistro}
                hastaRegistro={paginacionVentasRecientes.hastaRegistro}
                tamanioPagina={paginacionVentasRecientes.tamanioPagina}
                onCambiarPagina={setPaginaVentasRecientes}
                etiquetaItems="ventas"
              />
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

          {configArca?.arca_habilitada && comprobanteFiscalActivo && (
            <div
              className="ticket-preview"
              aria-label="Comprobante Fiscal Electrónico ARCA"
              style={{ marginTop: '1rem' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  marginBottom: '0.5rem',
                }}
              >
                <h3>
                  Comprobante Fiscal [{comprobanteFiscalActivo.letra}]{' '}
                  {comprobanteFiscalActivo.numeroFormateado} (
                  {comprobanteFiscalActivo.codigoNumerico})
                </h3>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setComprobanteFiscalActivo(null)}
                >
                  Cerrar vista fiscal
                </button>
              </div>
              <pre>{comprobanteFiscalActivo.textoTermico}</pre>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  marginTop: '0.5rem',
                }}
              >
                <div
                  dangerouslySetInnerHTML={{
                    __html: comprobanteFiscalActivo.qrSvg,
                  }}
                />
                <div style={{ fontSize: '0.82rem' }}>
                  <strong>QR Oficial RG 4892/2020 (ARCA)</strong>
                  <div style={{ wordBreak: 'break-all' }}>
                    <code>{comprobanteFiscalActivo.urlQrOficial}</code>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
