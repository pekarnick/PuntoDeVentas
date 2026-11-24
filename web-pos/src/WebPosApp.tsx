import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  calcularVentaMovilDesdeCatalogo,
  evaluarPagosCombinados,
  formatearFechaHoraAR,
  formatearMonedaARS,
  pesosACentavos,
  validarPagosVenta,
  type Centavos,
  type MedioPago,
  type PagoVentaInput,
  type ProductoCatalogoMovil,
} from '@pos/domain';
import {
  guardarConfigNubeMovilCliente,
  invocarPosApi,
  obtenerConfigNubeMovilCliente,
} from '../../src/db/cliente_pos_api.ts';
import { generarUuidV7 } from '../../src/domain/uuid.ts';
import type {
  EstadoCajaMovil,
  ResultadoCrearVentaMovil,
} from '../../src/db/venta_movil_repo.ts';

interface SesionMovilCliente {
  readonly sesion_id: string;
  readonly access_token?: string;
  readonly expira_at: string;
  readonly comercio_id: string;
  readonly comercio_nombre: string;
  readonly dispositivo_id: string;
  readonly usuario: {
    readonly id: string;
    readonly nombre: string;
    readonly usuario: string;
    readonly rol: string;
  };
}

interface ClienteMovilUI {
  readonly id: string;
  readonly nombre: string;
  readonly cuit_dni: string | null;
  readonly condicion_iva: string;
  readonly limite_credito: Centavos;
  readonly saldo_pendiente: Centavos;
}

interface ComboMovilItemUI {
  readonly producto_id: string;
  readonly producto_nombre: string;
  readonly cantidad: number;
  readonly precio_unitario_normal: Centavos;
  readonly stock_actual: number;
}

interface ComboMovilUI {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string | null;
  readonly codigo_barras: string | null;
  readonly precio_venta: Centavos;
  readonly precio_suma_normal: Centavos;
  readonly ahorro_centavos: Centavos;
  readonly porcentaje_descuento: number;
  readonly stock_combos_disponibles: number;
  readonly items: ReadonlyArray<ComboMovilItemUI>;
}

interface VentaPropiaDiaUI {
  readonly id: string;
  readonly fecha: string;
  readonly total: Centavos;
  readonly canal: 'escritorio' | 'web';
  readonly estado: 'completada' | 'anulada';
  readonly cliente_nombre: string | null;
  readonly items: ReadonlyArray<{
    readonly descripcion: string;
    readonly cantidad: number;
    readonly precio_unitario: Centavos;
    readonly subtotal: Centavos;
  }>;
  readonly pagos: ReadonlyArray<{
    readonly medio: MedioPago;
    readonly monto: Centavos;
  }>;
}

const CLAVE_SESION_STORAGE = 'pos_web_movil_sesion_v1';
const CLAVE_CATALOGO_CACHE = 'pos_web_movil_catalogo_cache_v1';
const CLAVE_COMBOS_CACHE = 'pos_web_movil_combos_cache_v1';
const CLAVE_DEVICE_ID = 'pos_web_movil_device_id_v1';

function obtenerDispositivoIdMovil(): string {
  if (typeof window === 'undefined') return 'movil-web-1';
  const guardado = window.localStorage.getItem(CLAVE_DEVICE_ID);
  if (guardado) return guardado;
  const nuevo = `celular-${generarUuidV7().slice(-8)}`;
  window.localStorage.setItem(CLAVE_DEVICE_ID, nuevo);
  return nuevo;
}

function parsearInputPesosACentavos(valor: string): Centavos {
  const limpio = valor.trim();
  if (!limpio) return 0;
  try {
    const c = pesosACentavos(limpio);
    return c > 0 ? c : 0;
  } catch {
    const num = Number(limpio.replace(',', '.'));
    return Number.isFinite(num) && num > 0 ? Math.round(num * 100) : 0;
  }
}

function centavosAInputPesosMovil(centavos: Centavos): string {
  const limpio = Math.max(0, Math.round(centavos));
  if (limpio === 0) return '0';
  return (limpio / 100).toFixed(2);
}

const ETIQUETAS_MEDIO_PAGO: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  mercado_pago: 'Mercado Pago',
  qr: 'QR Interoperable',
  debito: 'Tarjeta Débito',
  credito: 'Tarjeta Crédito',
  transferencia: 'Transferencia',
  cuenta_corriente: 'Cuenta Corriente',
  otro: 'Otro',
};

export function WebPosApp(): React.ReactElement {
  const [sesion, setSesion] = useState<SesionMovilCliente | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.sessionStorage.getItem(CLAVE_SESION_STORAGE);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SesionMovilCliente;
      const expiraMs = parsed?.expira_at
        ? new Date(parsed.expira_at).getTime()
        : NaN;
      if (!Number.isFinite(expiraMs) || expiraMs <= Date.now()) {
        window.sessionStorage.removeItem(CLAVE_SESION_STORAGE);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  });

  const [pestania, setPestania] = useState<'vender' | 'caja' | 'ventas'>('vender');

  // Login form
  const [loginUsuario, setLoginUsuario] = useState('');
  const [loginClave, setLoginClave] = useState('');
  const [loginDispositivoNombre, setLoginDispositivoNombre] = useState(
    'Celular Mostrador 1'
  );
  const [configNubeMovil, setConfigNubeMovil] = useState(() =>
    obtenerConfigNubeMovilCliente()
  );

  // Catálogo, combos y clientes (Regla 20: nunca incluye costo_compra)
  const [catalogo, setCatalogo] = useState<ProductoCatalogoMovil[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(CLAVE_CATALOGO_CACHE);
      return raw ? (JSON.parse(raw) as ProductoCatalogoMovil[]) : [];
    } catch {
      return [];
    }
  });
  const [combos, setCombos] = useState<ComboMovilUI[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(CLAVE_COMBOS_CACHE);
      return raw ? (JSON.parse(raw) as ComboMovilUI[]) : [];
    } catch {
      return [];
    }
  });
  const [clientes, setClientes] = useState<ClienteMovilUI[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [codigoManual, setCodigoManual] = useState('');

  // Escáner de cámara
  const [camaraActiva, setCamaraActiva] = useState(false);
  const [linternaActiva, setLinternaActiva] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Carrito e idempotencia UUID (PLAN.md §6.2)
  const [carrito, setCarrito] = useState<
    Array<{ producto_id: string; cantidad: number }>
  >([]);
  const [combosEnCarritoMovil, setCombosEnCarritoMovil] = useState<
    Array<{ combo: ComboMovilUI; cantidad: number }>
  >([]);
  const [descuentoPesosInput, setDescuentoPesosInput] = useState('0');
  const [clienteIdSeleccionado, setClienteIdSeleccionado] = useState('');
  const [medioPrincipal, setMedioPrincipal] = useState<MedioPago>('efectivo');
  const [usarPagoMixto, setUsarPagoMixto] = useState(false);
  const [pagosCombinadosMovil, setPagosCombinadosMovil] = useState<
    Array<{ id: string; medio: MedioPago; montoPesosInput: string }>
  >([
    { id: 'movil-pago-1', medio: 'efectivo', montoPesosInput: '' },
    { id: 'movil-pago-2', medio: 'mercado_pago', montoPesosInput: '' },
  ]);
  const [ventaUuidPendiente, setVentaUuidPendiente] = useState<string>(() =>
    generarUuidV7()
  );

  // Comprobante emitido
  const [ultimoComprobante, setUltimoComprobante] =
    useState<ResultadoCrearVentaMovil | null>(null);
  const comprobanteRef = useRef<HTMLElement | null>(null);
  const carritoRef = useRef<HTMLElement | null>(null);

  // Caja móvil y mis ventas
  const [estadoCaja, setEstadoCaja] = useState<EstadoCajaMovil | null>(null);
  const [montoAperturaPesos, setMontoAperturaPesos] = useState('10000');
  const [efectivoContadoCierrePesos, setEfectivoContadoCierrePesos] =
    useState('');
  const [ventasDia, setVentasDia] = useState<VentaPropiaDiaUI[]>([]);

  // Mensajes de estado
  const [cargando, setCargando] = useState(false);
  const [mensajeError, setMensajeError] = useState<string | null>(null);
  const [mensajeOk, setMensajeOk] = useState<string | null>(null);

  const cerrarSesionLocal = useCallback((motivo?: string) => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(CLAVE_SESION_STORAGE);
      window.localStorage.removeItem(CLAVE_CATALOGO_CACHE);
      window.localStorage.removeItem(CLAVE_COMBOS_CACHE);
    }
    setSesion(null);
    setCatalogo([]);
    setCombos([]);
    setClientes([]);
    setEstadoCaja(null);
    setVentasDia([]);
    setUltimoComprobante(null);
    setCarrito([]);
    setCombosEnCarritoMovil([]);
    if (motivo) {
      setMensajeError(motivo);
    }
  }, []);

  const manejarErrorApiMovil = useCallback(
    (err: unknown) => {
      const msg =
        err instanceof Error
          ? err.message
          : 'Error de comunicación con el servidor.';
      if (
        msg.includes('SESION_REVOCADA') ||
        msg.includes('SESION_EXPIRADA') ||
        msg.includes('SESION_INVALIDA') ||
        msg.includes('PERMISO_REVOCADO') ||
        msg.includes('VENTA_MOVIL_DESHABILITADA')
      ) {
        cerrarSesionLocal(msg);
      } else {
        setMensajeError(msg);
      }
    },
    [cerrarSesionLocal]
  );

  const cargarDatosMovil = useCallback(
    async (sesionActiva: SesionMovilCliente) => {
      try {
        const [catRes, cajaRes, ventasRes] = await Promise.all([
          invocarPosApi<{
            comercioId: string;
            productos: ProductoCatalogoMovil[];
            combos?: ComboMovilUI[];
            clientes: ClienteMovilUI[];
          }>('obtener_catalogo_movil', {
            comercioId: sesionActiva.comercio_id,
            sesionMovilId: sesionActiva.sesion_id,
          }),
          invocarPosApi<EstadoCajaMovil>('estado_caja_movil', {
            comercioId: sesionActiva.comercio_id,
            usuarioId: sesionActiva.usuario.id,
            sesionMovilId: sesionActiva.sesion_id,
          }),
          invocarPosApi<{ ventas: VentaPropiaDiaUI[] }>(
            'listar_ventas_movil_dia',
            {
              comercioId: sesionActiva.comercio_id,
              usuarioId: sesionActiva.usuario.id,
              sesionMovilId: sesionActiva.sesion_id,
            }
          ),
        ]);

        setCatalogo(catRes.productos);
        const combosRecibidos = Array.isArray(catRes.combos)
          ? catRes.combos
          : [];
        setCombos(combosRecibidos);
        setClientes(catRes.clientes);
        setEstadoCaja(cajaRes);
        setVentasDia(ventasRes.ventas);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(
            CLAVE_CATALOGO_CACHE,
            JSON.stringify(catRes.productos)
          );
          window.localStorage.setItem(
            CLAVE_COMBOS_CACHE,
            JSON.stringify(combosRecibidos)
          );
        }
      } catch (err) {
        manejarErrorApiMovil(err);
      }
    },
    [manejarErrorApiMovil]
  );

  useEffect(() => {
    if (sesion) {
      void cargarDatosMovil(sesion);
    }
  }, [sesion, cargarDatosMovil]);

  // Limpiar cámara al desmontar o apagar
  const detenerCamara = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setCamaraActiva(false);
    setLinternaActiva(false);
  }, []);

  useEffect(() => {
    return () => {
      detenerCamara();
    };
  }, [detenerCamara]);

  const catalogoPorId = useMemo(
    () => new Map(catalogo.map((p) => [p.id, p])),
    [catalogo]
  );

  const agregarAlCarrito = useCallback(
    (producto: ProductoCatalogoMovil) => {
      setMensajeError(null);
      setCarrito((prev) => {
        const existe = prev.find((i) => i.producto_id === producto.id);
        if (existe) {
          return prev.map((i) =>
            i.producto_id === producto.id
              ? { ...i, cantidad: i.cantidad + 1 }
              : i
          );
        }
        return [...prev, { producto_id: producto.id, cantidad: 1 }];
      });
    },
    []
  );

  const calcularAhorroEfectivoComboMovil = useCallback(
    (combo: ComboMovilUI): Centavos => {
      const sumaEnCatalogo = combo.items.reduce((acc, comp) => {
        const prod = catalogoPorId.get(comp.producto_id);
        const precioUnit = prod
          ? prod.precio_venta
          : comp.precio_unitario_normal;
        return acc + Math.round(precioUnit * comp.cantidad);
      }, 0);
      return Math.max(0, sumaEnCatalogo - combo.precio_venta);
    },
    [catalogoPorId]
  );

  const agregarComboAlCarritoMovil = useCallback(
    (combo: ComboMovilUI) => {
      setMensajeError(null);
      if (combo.items.length === 0) {
        setMensajeError(`El combo "${combo.nombre}" no tiene componentes.`);
        return;
      }
      const faltantes = combo.items.filter(
        (it) => !catalogoPorId.has(it.producto_id)
      );
      if (faltantes.length > 0) {
        setMensajeError(
          `No se encontraron en el catálogo móvil todos los productos del combo "${combo.nombre}".`
        );
        return;
      }

      const ahorroEfectivo = calcularAhorroEfectivoComboMovil(combo);

      setCarrito((prev) => {
        let proximo = [...prev];
        for (const comp of combo.items) {
          const idx = proximo.findIndex(
            (i) => i.producto_id === comp.producto_id
          );
          if (idx >= 0) {
            const actual = proximo[idx]!;
            proximo[idx] = {
              ...actual,
              cantidad: Number((actual.cantidad + comp.cantidad).toFixed(3)),
            };
          } else {
            proximo.push({
              producto_id: comp.producto_id,
              cantidad: comp.cantidad,
            });
          }
        }
        return proximo;
      });

      if (ahorroEfectivo > 0) {
        setDescuentoPesosInput((prev) => {
          const centavosActuales = parsearInputPesosACentavos(prev);
          const nuevoDescuento = centavosActuales + ahorroEfectivo;
          return centavosAInputPesosMovil(nuevoDescuento);
        });
      }

      setCombosEnCarritoMovil((prev) => {
        const existe = prev.find((c) => c.combo.id === combo.id);
        if (existe) {
          return prev.map((c) =>
            c.combo.id === combo.id ? { ...c, cantidad: c.cantidad + 1 } : c
          );
        }
        return [...prev, { combo, cantidad: 1 }];
      });

      setMensajeOk(
        `🎁 Combo "${combo.nombre}" agregado por ${formatearMonedaARS(combo.precio_venta)} (Bonificación aplicada: ${formatearMonedaARS(ahorroEfectivo)}).`
      );
    },
    [catalogoPorId, calcularAhorroEfectivoComboMovil]
  );

  const quitarComboDelCarritoMovil = useCallback(
    (comboId: string) => {
      const entrada = combosEnCarritoMovil.find((c) => c.combo.id === comboId);
      if (!entrada) return;
      const { combo } = entrada;
      const ahorroEfectivo = calcularAhorroEfectivoComboMovil(combo);

      setCarrito((prev) => {
        let proximo = [...prev];
        for (const comp of combo.items) {
          const idx = proximo.findIndex(
            (i) => i.producto_id === comp.producto_id
          );
          if (idx >= 0) {
            const actual = proximo[idx]!;
            const nuevaCant = Number(
              (actual.cantidad - comp.cantidad).toFixed(3)
            );
            if (nuevaCant <= 0) {
              proximo.splice(idx, 1);
            } else {
              proximo[idx] = { ...actual, cantidad: nuevaCant };
            }
          }
        }
        return proximo;
      });

      if (ahorroEfectivo > 0) {
        setDescuentoPesosInput((prev) => {
          const centavosActuales = parsearInputPesosACentavos(prev);
          const nuevoDescuento = Math.max(0, centavosActuales - ahorroEfectivo);
          return centavosAInputPesosMovil(nuevoDescuento);
        });
      }

      setCombosEnCarritoMovil((prev) =>
        prev
          .map((c) =>
            c.combo.id === comboId ? { ...c, cantidad: c.cantidad - 1 } : c
          )
          .filter((c) => c.cantidad > 0)
      );

      setMensajeOk(`Combo "${combo.nombre}" quitado del carrito.`);
    },
    [combosEnCarritoMovil, calcularAhorroEfectivoComboMovil]
  );

  const buscarYAgregarPorCodigo = useCallback(
    (codigo: string) => {
      const limpio = codigo.trim();
      if (!limpio) return;
      const comboEncontrado = combos.find(
        (c) =>
          c.codigo_barras &&
          c.codigo_barras.toLowerCase() === limpio.toLowerCase()
      );
      if (comboEncontrado) {
        agregarComboAlCarritoMovil(comboEncontrado);
        setCodigoManual('');
        return;
      }
      const encontrado = catalogo.find(
        (p) =>
          p.codigos_barras.includes(limpio) ||
          (p.codigo_interno &&
            p.codigo_interno.toLowerCase() === limpio.toLowerCase())
      );
      if (!encontrado) {
        setMensajeError(`No se encontró ningún producto ni combo con el código "${limpio}".`);
        return;
      }
      agregarAlCarrito(encontrado);
      setMensajeOk(`Agregado: ${encontrado.nombre}`);
      setCodigoManual('');
    },
    [combos, catalogo, agregarComboAlCarritoMovil, agregarAlCarrito]
  );

  async function alternarCamaraEscaner() {
    if (camaraActiva) {
      detenerCamara();
      return;
    }
    setMensajeError(null);
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setMensajeError(
        'Este navegador no permite acceder a la cámara. Usá el campo de código manual.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCamaraActiva(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Si el navegador soporta BarcodeDetector nativo, escanear en bucle
      const BarcodeDetectorCtor = (
        window as unknown as {
          BarcodeDetector?: new (opts: { formats: string[] }) => {
            detect: (
              video: HTMLVideoElement
            ) => Promise<Array<{ rawValue: string }>>;
          };
        }
      ).BarcodeDetector;

      if (BarcodeDetectorCtor) {
        const detector = new BarcodeDetectorCtor({
          formats: ['ean_13', 'ean_8', 'code_128', 'upc_a', 'qr_code'],
        });
        const loop = async () => {
          if (!streamRef.current || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && codes[0]?.rawValue) {
              buscarYAgregarPorCodigo(codes[0].rawValue);
              detenerCamara();
              return;
            }
          } catch {
            // Ignorar frames intermedios
          }
          if (streamRef.current) {
            window.setTimeout(() => void loop(), 350);
          }
        };
        void loop();
      }
    } catch {
      setMensajeError(
        'No se pudo abrir la cámara del celular. Verificá los permisos o ingresá el código manualmente.'
      );
    }
  }

  async function alternarLinterna() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const nuevoEstado = !linternaActiva;
      await track.applyConstraints({
        advanced: [{ torch: nuevoEstado } as MediaTrackConstraintSet],
      });
      setLinternaActiva(nuevoEstado);
    } catch {
      setMensajeError('La linterna no está soportada en este dispositivo.');
    }
  }

  const descuentoCentavos = useMemo(
    () => parsearInputPesosACentavos(descuentoPesosInput),
    [descuentoPesosInput]
  );

  const resumenCarrito = useMemo(() => {
    if (carrito.length === 0) return null;
    try {
      return calcularVentaMovilDesdeCatalogo({
        itemsPedido: carrito,
        catalogoPorId,
        descuentoGlobal: descuentoCentavos,
      });
    } catch {
      return null;
    }
  }, [carrito, catalogoPorId, descuentoCentavos]);

  const productosFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) {
      return catalogo.slice(0, 30);
    }
    return catalogo
      .filter(
        (p) =>
          p.nombre.toLowerCase().includes(q) ||
          (p.codigo_interno && p.codigo_interno.toLowerCase().includes(q)) ||
          p.codigos_barras.some((c) => c.includes(q))
      )
      .slice(0, 30);
  }, [catalogo, busqueda]);

  const combosFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) {
      return combos;
    }
    return combos.filter(
      (c) =>
        c.nombre.toLowerCase().includes(q) ||
        (c.descripcion && c.descripcion.toLowerCase().includes(q)) ||
        (c.codigo_barras && c.codigo_barras.toLowerCase().includes(q)) ||
        c.items.some((it) => it.producto_nombre.toLowerCase().includes(q))
    );
  }, [combos, busqueda]);

  async function manejarLoginMovil(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeOk(null);
    setCargando(true);
    try {
      const dispositivoId = obtenerDispositivoIdMovil();
      const res = await invocarPosApi<{
        sesion_id: string;
        access_token?: string;
        expira_at: string;
        comercio_id: string;
        comercio_nombre: string;
        usuario: {
          id: string;
          nombre: string;
          usuario: string;
          rol: string;
        };
      }>('login_movil', {
        usuario: loginUsuario.trim(),
        clave: loginClave,
        dispositivoId,
        dispositivoNombre: loginDispositivoNombre.trim() || 'Celular Web POS',
        userAgent:
          typeof navigator !== 'undefined' ? navigator.userAgent : 'web-pos',
      });

      const nuevaSesion: SesionMovilCliente = {
        ...res,
        dispositivo_id: dispositivoId,
      };
      setLoginClave('');
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(
          CLAVE_SESION_STORAGE,
          JSON.stringify(nuevaSesion)
        );
      }
      setSesion(nuevaSesion);
      setVentaUuidPendiente(generarUuidV7());
    } catch (err) {
      manejarErrorApiMovil(err);
    } finally {
      setCargando(false);
    }
  }

  const pagosCombinadosMovilCalculados = useMemo(
    () =>
      pagosCombinadosMovil.map((f) => {
        const monto = parsearInputPesosACentavos(f.montoPesosInput);
        return {
          ...f,
          monto,
        };
      }),
    [pagosCombinadosMovil]
  );

  const estadoPagosCombinadosMovil = useMemo(
    () =>
      evaluarPagosCombinados(
        pagosCombinadosMovilCalculados.map((p) => ({
          medio: p.medio,
          monto: p.monto,
        })),
        resumenCarrito?.total ?? 0
      ),
    [pagosCombinadosMovilCalculados, resumenCarrito]
  );

  function actualizarFilaPagoMovil(
    id: string,
    cambios: Partial<{ medio: MedioPago; montoPesosInput: string }>
  ) {
    setPagosCombinadosMovil((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...cambios } : f))
    );
  }

  function completarRestoFilaPagoMovil(id: string) {
    const total = resumenCarrito?.total ?? 0;
    const sumaOtras = pagosCombinadosMovilCalculados
      .filter((f) => f.id !== id)
      .reduce((acc, f) => acc + f.monto, 0);
    const resto = Math.max(0, total - sumaOtras);
    actualizarFilaPagoMovil(id, {
      montoPesosInput: (resto / 100).toFixed(2),
    });
  }

  function agregarFilaPagoMovil() {
    const medios = Object.keys(ETIQUETAS_MEDIO_PAGO) as MedioPago[];
    const usados = new Set(pagosCombinadosMovil.map((f) => f.medio));
    const siguiente = medios.find((m) => !usados.has(m)) ?? 'transferencia';
    const resto = estadoPagosCombinadosMovil.faltaCubrirCentavos;

    setPagosCombinadosMovil((prev) => [
      ...prev,
      {
        id: `movil-pago-${Date.now()}-${prev.length + 1}`,
        medio: siguiente,
        montoPesosInput: resto > 0 ? (resto / 100).toFixed(2) : '',
      },
    ]);
  }

  function quitarFilaPagoMovil(id: string) {
    setPagosCombinadosMovil((prev) =>
      prev.length <= 2 ? prev : prev.filter((f) => f.id !== id)
    );
  }

  function cambiarCantidadItem(productoId: string, delta: number) {
    const siguiente = carrito
      .map((it) =>
        it.producto_id === productoId
          ? { ...it, cantidad: Math.max(0, Number((it.cantidad + delta).toFixed(3))) }
          : it
      )
      .filter((it) => it.cantidad > 0);

    setCarrito(siguiente);

    if (siguiente.length === 0) {
      setCombosEnCarritoMovil([]);
      setDescuentoPesosInput('0');
      return;
    }

    if (delta < 0 && combosEnCarritoMovil.length > 0) {
      const disponiblePorProd = new Map<string, number>();
      for (const it of siguiente) {
        disponiblePorProd.set(
          it.producto_id,
          (disponiblePorProd.get(it.producto_id) ?? 0) + it.cantidad
        );
      }

      const combosVigentes: Array<{ combo: ComboMovilUI; cantidad: number }> = [];
      let ahorroQuitadoCentavos = 0;

      for (const entrada of combosEnCarritoMovil) {
        let cantVigente = 0;
        for (let k = 0; k < entrada.cantidad; k++) {
          const alcanza = entrada.combo.items.every(
            (comp) =>
              (disponiblePorProd.get(comp.producto_id) ?? 0) + 1e-6 >=
              comp.cantidad
          );
          if (alcanza) {
            for (const comp of entrada.combo.items) {
              disponiblePorProd.set(
                comp.producto_id,
                (disponiblePorProd.get(comp.producto_id) ?? 0) - comp.cantidad
              );
            }
            cantVigente++;
          } else {
            ahorroQuitadoCentavos += calcularAhorroEfectivoComboMovil(
              entrada.combo
            );
          }
        }
        if (cantVigente > 0) {
          combosVigentes.push({ combo: entrada.combo, cantidad: cantVigente });
        }
      }

      setCombosEnCarritoMovil(combosVigentes);
      if (ahorroQuitadoCentavos > 0) {
        setDescuentoPesosInput((prev) => {
          const actual = parsearInputPesosACentavos(prev);
          return centavosAInputPesosMovil(
            Math.max(0, actual - ahorroQuitadoCentavos)
          );
        });
      }
    }
  }

  async function manejarConfirmarVentaMovil() {
    if (!sesion || !resumenCarrito) return;
    setMensajeError(null);
    setMensajeOk(null);

    let pagos: PagoVentaInput[];
    if (!usarPagoMixto) {
      pagos = [{ medio: medioPrincipal, monto: resumenCarrito.total }];
    } else {
      pagos = pagosCombinadosMovilCalculados.map((f) => ({
        medio: f.medio,
        monto: f.monto,
      }));
      if (pagos.some((p) => p.monto <= 0)) {
        setMensajeError(
          'Ingresá un monto mayor a $ 0,00 en cada medio de pago combinado (o quitá los que no uses).'
        );
        return;
      }
      try {
        validarPagosVenta(pagos, resumenCarrito.total);
      } catch (err) {
        setMensajeError(
          err instanceof Error
            ? err.message
            : 'La suma de los pagos no coincide con el monto a cobrar.'
        );
        return;
      }
    }

    setCargando(true);
    try {
      const resultado = await invocarPosApi<ResultadoCrearVentaMovil>(
        'crear_venta_movil',
        {
          ventaId: ventaUuidPendiente,
          comercioId: sesion.comercio_id,
          usuarioId: sesion.usuario.id,
          dispositivoId: sesion.dispositivo_id,
          sesionMovilId: sesion.sesion_id,
          items: carrito,
          pagos,
          descuentoGlobal: resumenCarrito.descuento_global,
          clienteId: clienteIdSeleccionado || null,
          cajaSesionId: estadoCaja?.sesion?.id ?? null,
        }
      );

      setUltimoComprobante(resultado);
      setCarrito([]);
      setCombosEnCarritoMovil([]);
      setDescuentoPesosInput('0');
      setClienteIdSeleccionado('');
      setUsarPagoMixto(false);
      // Generar un nuevo UUID para la próxima venta
      setVentaUuidPendiente(generarUuidV7());
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        try {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch {
          window.scrollTo(0, 0);
        }
      }
      setTimeout(() => {
        if (
          comprobanteRef.current &&
          typeof comprobanteRef.current.scrollIntoView === 'function'
        ) {
          comprobanteRef.current.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          });
        }
      }, 40);
      await cargarDatosMovil(sesion);
    } catch (err) {
      // Si hubo fallo de red, conservamos el mismo ventaUuidPendiente para garantizar idempotencia al reintentar
      manejarErrorApiMovil(err);
    } finally {
      setCargando(false);
    }
  }

  async function manejarAbrirCajaMovil(e: React.FormEvent) {
    e.preventDefault();
    if (!sesion) return;
    setMensajeError(null);
    setCargando(true);
    try {
      const montoCentavos = parsearInputPesosACentavos(montoAperturaPesos);
      const nuevoEstado = await invocarPosApi<EstadoCajaMovil>(
        'abrir_caja_movil',
        {
          comercioId: sesion.comercio_id,
          usuarioId: sesion.usuario.id,
          dispositivoId: sesion.dispositivo_id,
          sesionMovilId: sesion.sesion_id,
          montoInicialCentavos: montoCentavos,
          observaciones: `Caja móvil abierta desde ${sesion.dispositivo_id}`,
        }
      );
      setEstadoCaja(nuevoEstado);
      setMensajeOk('Caja móvil abierta correctamente.');
    } catch (err) {
      manejarErrorApiMovil(err);
    } finally {
      setCargando(false);
    }
  }

  async function manejarCerrarCajaMovil(e: React.FormEvent) {
    e.preventDefault();
    if (!sesion) return;
    setMensajeError(null);
    setCargando(true);
    try {
      const contadoCentavos = parsearInputPesosACentavos(
        efectivoContadoCierrePesos
      );
      const res = await invocarPosApi<{
        diferencia: Centavos;
        efectivo_esperado: Centavos;
        efectivo_contado: Centavos;
      }>('cerrar_caja_movil', {
        comercioId: sesion.comercio_id,
        usuarioId: sesion.usuario.id,
        dispositivoId: sesion.dispositivo_id,
        sesionMovilId: sesion.sesion_id,
        efectivoContadoCentavos: contadoCentavos,
      });
      setMensajeOk(
        `Caja móvil cerrada. Esperado: ${formatearMonedaARS(
          res.efectivo_esperado
        )} | Contado: ${formatearMonedaARS(
          res.efectivo_contado
        )} | Diferencia: ${formatearMonedaARS(res.diferencia)}`
      );
      setEfectivoContadoCierrePesos('');
      await cargarDatosMovil(sesion);
    } catch (err) {
      manejarErrorApiMovil(err);
    } finally {
      setCargando(false);
    }
  }

  if (!sesion) {
    return (
      <div className="movil-shell">
        <header className="movil-header">
          <div>
            <h1>Punto de Venta — Venta Móvil</h1>
            <div className="movil-header-sub">
              Canal web en la nube (/web-pos) — Sin costos ni administración
            </div>
          </div>
        </header>

        <main className="movil-main">
          {mensajeError ? (
            <div className="movil-alert-error" role="alert">
              {mensajeError}
            </div>
          ) : null}

          <section className="movil-card">
            <h2>Ingreso de Vendedor Autorizado</h2>
            <p style={{ fontSize: '0.85rem', color: '#475569', marginTop: 0 }}>
              Ingresá con tu usuario individual habilitado con{' '}
              <code>puede_vender_movil</code>.
            </p>
            <form onSubmit={(e) => void manejarLoginMovil(e)}>
              <div style={{ marginBottom: '0.75rem' }}>
                <label
                  htmlFor="movil-user"
                  style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
                >
                  Usuario
                </label>
                <input
                  id="movil-user"
                  className="movil-input"
                  type="text"
                  autoComplete="username"
                  value={loginUsuario}
                  onChange={(e) => setLoginUsuario(e.target.value)}
                  required
                />
              </div>

              <div style={{ marginBottom: '0.75rem' }}>
                <label
                  htmlFor="movil-pass"
                  style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
                >
                  Clave
                </label>
                <input
                  id="movil-pass"
                  className="movil-input"
                  type="password"
                  autoComplete="current-password"
                  value={loginClave}
                  onChange={(e) => setLoginClave(e.target.value)}
                  required
                />
              </div>

              <div style={{ marginBottom: '0.9rem' }}>
                <label
                  htmlFor="movil-disp"
                  style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
                >
                  Nombre de este celular (visible en Sesiones Activas)
                </label>
                <input
                  id="movil-disp"
                  className="movil-input"
                  type="text"
                  value={loginDispositivoNombre}
                  onChange={(e) => setLoginDispositivoNombre(e.target.value)}
                />
              </div>

              <button
                type="submit"
                className="movil-btn movil-btn-primary"
                style={{ width: '100%' }}
                disabled={cargando}
              >
                {cargando ? 'Ingresando...' : 'Ingresar a Venta Móvil'}
              </button>
            </form>

            {typeof window !== 'undefined' && window.__POS_CONFIG__?.supabaseUrl ? (
              <p className="movil-help" style={{ marginTop: '1rem' }}>
                Conectado al comercio oficial: <strong>{configNubeMovil.comercioNombre}</strong>
              </p>
            ) : (
            <details style={{ marginTop: '1rem', fontSize: '0.8rem', color: '#475569' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                ⚙️ Conexión en la Nube (Supabase)
              </summary>
              <div style={{ marginTop: '0.6rem', display: 'grid', gap: '0.5rem' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.2rem' }}>
                    Supabase URL
                  </label>
                  <input
                    className="movil-input"
                    type="url"
                    value={configNubeMovil.supabaseUrl}
                    onChange={(e) =>
                      setConfigNubeMovil((prev) => ({
                        ...prev,
                        supabaseUrl: e.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.2rem' }}>
                    Anon / Publishable Key (RLS)
                  </label>
                  <input
                    className="movil-input"
                    type="text"
                    value={configNubeMovil.supabaseAnonKey}
                    onChange={(e) =>
                      setConfigNubeMovil((prev) => ({
                        ...prev,
                        supabaseAnonKey: e.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.2rem' }}>
                    UUID del Comercio
                  </label>
                  <input
                    className="movil-input"
                    type="text"
                    value={configNubeMovil.comercioId}
                    onChange={(e) =>
                      setConfigNubeMovil((prev) => ({
                        ...prev,
                        comercioId: e.target.value,
                      }))
                    }
                  />
                </div>
                <button
                  type="button"
                  className="movil-btn movil-btn-secondary"
                  onClick={() => {
                    const guardada = guardarConfigNubeMovilCliente(configNubeMovil);
                    setConfigNubeMovil(guardada);
                    setMensajeError(null);
                    setMensajeOk('Parámetros de conexión con Supabase guardados en este celular.');
                  }}
                >
                  Guardar Parámetros de Nube
                </button>
              </div>
            </details>
            )}
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="movil-shell">
      <header className="movil-header">
        <div>
          <h1>{sesion.comercio_nombre}</h1>
          <div className="movil-header-sub">
            Vendedor: {sesion.usuario.nombre} ({sesion.usuario.rol})
          </div>
        </div>
        <button
          type="button"
          className="movil-btn movil-btn-secondary"
          style={{ padding: '0.35rem 0.65rem', minHeight: '34px', fontSize: '0.78rem' }}
          onClick={() => cerrarSesionLocal()}
        >
          Salir
        </button>
      </header>

      <main className="movil-main">
        {mensajeError ? (
          <div className="movil-alert-error" role="alert">
            {mensajeError}
          </div>
        ) : null}
        {mensajeOk ? (
          <div className="movil-alert-ok" role="status">
            {mensajeOk}
          </div>
        ) : null}

        {ultimoComprobante ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ticket de venta confirmada"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              background: 'rgba(15, 23, 42, 0.75)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1rem',
              overflowY: 'auto',
            }}
          >
            <section
              ref={comprobanteRef}
              className="movil-card"
              aria-label="Comprobante de venta móvil"
              style={{
                width: '100%',
                maxWidth: '460px',
                maxHeight: '90vh',
                overflowY: 'auto',
                margin: 0,
                boxShadow: '0 20px 35px rgba(0, 0, 0, 0.35)',
                border: '2px solid #16a34a',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <h2 style={{ color: '#15803d', margin: 0 }}>
                  ✓ Venta registrada ({formatearMonedaARS(ultimoComprobante.total)})
                </h2>
              </div>
              <pre
                style={{
                  background: '#f8fafc',
                  padding: '0.75rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.82rem',
                  whiteSpace: 'pre-wrap',
                  margin: '0.65rem 0 0.85rem',
                }}
              >
                {ultimoComprobante.comprobante_texto}
              </pre>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <a
                  href={ultimoComprobante.whatsapp_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="movil-btn movil-btn-success"
                  style={{ flex: 1, textDecoration: 'none', textAlign: 'center' }}
                >
                  Compartir por WhatsApp
                </a>
                <button
                  type="button"
                  className="movil-btn movil-btn-secondary"
                  onClick={() => window.print()}
                >
                  Imprimir
                </button>
                <button
                  type="button"
                  className="movil-btn movil-btn-primary"
                  style={{ width: '100%' }}
                  onClick={() => {
                    setUltimoComprobante(null);
                    if (
                      typeof window !== 'undefined' &&
                      typeof window.scrollTo === 'function'
                    ) {
                      try {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      } catch {
                        window.scrollTo(0, 0);
                      }
                    }
                  }}
                >
                  Nueva venta
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {pestania === 'vender' && (
          <>
            {carrito.length > 0 && resumenCarrito && (
              <div
                style={{
                  position: 'sticky',
                  top: '0.35rem',
                  zIndex: 50,
                  background: '#1e40af',
                  color: '#ffffff',
                  padding: '0.6rem 0.85rem',
                  borderRadius: '0.65rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                  boxShadow: '0 6px 16px rgba(30, 64, 175, 0.28)',
                }}
              >
                <div>
                  <strong style={{ fontSize: '0.92rem' }}>
                    🛒 {carrito.length} {carrito.length === 1 ? 'ítem' : 'ítems'} ·{' '}
                    {formatearMonedaARS(resumenCarrito.total)}
                  </strong>
                </div>
                <button
                  type="button"
                  className="movil-btn movil-btn-success"
                  style={{ minHeight: '34px', padding: '0.3rem 0.75rem', fontSize: '0.82rem' }}
                  onClick={() => {
                    if (
                      carritoRef.current &&
                      typeof carritoRef.current.scrollIntoView === 'function'
                    ) {
                      carritoRef.current.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start',
                      });
                    }
                  }}
                >
                  Ir a Cobrar ↓
                </button>
              </div>
            )}

            <section className="movil-card">
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  marginBottom: '0.6rem',
                }}
              >
                <input
                  type="search"
                  className="movil-input"
                  placeholder="Buscar por nombre o código..."
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                />
                <button
                  type="button"
                  className="movil-btn movil-btn-secondary"
                  onClick={() => void alternarCamaraEscaner()}
                >
                  {camaraActiva ? 'Cerrar cámara' : '📷 Escanear'}
                </button>
              </div>

              {camaraActiva ? (
                <div className="movil-video-box">
                  <video ref={videoRef} playsInline muted />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '0.45rem',
                      background: '#0f172a',
                    }}
                  >
                    <button
                      type="button"
                      className="movil-btn movil-btn-secondary"
                      style={{ minHeight: '34px', padding: '0.3rem 0.6rem' }}
                      onClick={() => void alternarLinterna()}
                    >
                      {linternaActiva ? '🔦 Apagar linterna' : '🔦 Linterna'}
                    </button>
                    <span style={{ color: '#cbd5e1', fontSize: '0.78rem', alignSelf: 'center' }}>
                      Apuntá al código EAN-13 / QR
                    </span>
                  </div>
                </div>
              ) : null}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  buscarYAgregarPorCodigo(codigoManual);
                }}
                style={{ display: 'flex', gap: '0.45rem', marginTop: '0.5rem' }}
              >
                <input
                  type="text"
                  className="movil-input"
                  placeholder="Ingresar código de barras manual..."
                  value={codigoManual}
                  onChange={(e) => setCodigoManual(e.target.value)}
                />
                <button type="submit" className="movil-btn movil-btn-secondary">
                  + Código
                </button>
              </form>
            </section>

            <section className="movil-card">
              <h2>
                Catálogo de Venta ({productosFiltrados.length} productos
                {combosFiltrados.length > 0
                  ? ` + ${combosFiltrados.length} ${combosFiltrados.length === 1 ? 'combo' : 'combos'}`
                  : ''}{' '}
                — sin costos)
              </h2>
              {combosFiltrados.length > 0 && (
                <div style={{ marginBottom: '0.85rem' }}>
                  <div
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: '#6b21a8',
                      marginBottom: '0.45rem',
                    }}
                  >
                    🎁 Combos y Promociones
                  </div>
                  <div className="movil-grid-productos">
                    {combosFiltrados.map((c) => (
                      <button
                        key={`combo-${c.id}`}
                        type="button"
                        className="movil-prod-item"
                        style={{
                          background: '#faf5ff',
                          borderColor: '#c084fc',
                        }}
                        onClick={() => agregarComboAlCarritoMovil(c)}
                      >
                        <span
                          className="movil-prod-nombre"
                          style={{ color: '#581c87' }}
                        >
                          🎁 [Combo] {c.nombre}
                        </span>
                        <span
                          className="movil-prod-precio"
                          style={{ color: '#7e22ce' }}
                        >
                          {formatearMonedaARS(c.precio_venta)}
                        </span>
                        <span
                          className="movil-prod-meta"
                          style={{ color: '#6b21a8' }}
                        >
                          {c.items
                            .map((it) => `${it.cantidad}x ${it.producto_nombre}`)
                            .join(' + ')}
                        </span>
                        <span className="movil-prod-meta">
                          Disp: {c.stock_combos_disponibles} combos
                          {c.ahorro_centavos > 0
                            ? ` · Ahorra ${formatearMonedaARS(c.ahorro_centavos)}`
                            : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {productosFiltrados.length === 0 && combosFiltrados.length === 0 ? (
                <p style={{ color: '#64748b', fontSize: '0.88rem' }}>
                  No hay productos ni combos que coincidan con la búsqueda.
                </p>
              ) : productosFiltrados.length > 0 ? (
                <div className="movil-grid-productos">
                  {productosFiltrados.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="movil-prod-item"
                      onClick={() => agregarAlCarrito(p)}
                    >
                      <span className="movil-prod-nombre">{p.nombre}</span>
                      <span className="movil-prod-precio">
                        {formatearMonedaARS(p.precio_venta)}
                      </span>
                      <span className="movil-prod-meta">
                        Stock: {p.stock_actual} {p.unidad}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            <section
              ref={carritoRef}
              className="movil-card"
              aria-label="Carrito móvil"
            >
              <h2>
                Carrito Actual ({carrito.length}{' '}
                {carrito.length === 1 ? 'ítem' : 'ítems'})
              </h2>
              {carrito.length === 0 || !resumenCarrito ? (
                <p style={{ color: '#64748b', fontSize: '0.88rem', margin: 0 }}>
                  Tocá un producto o combo, o escaneá un código de barras para empezar.
                </p>
              ) : (
                <>
                  {combosEnCarritoMovil.length > 0 && (
                    <div
                      style={{
                        background: '#faf5ff',
                        border: '1px solid #d8b4fe',
                        borderRadius: '0.5rem',
                        padding: '0.5rem 0.65rem',
                        marginBottom: '0.55rem',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          color: '#6b21a8',
                          marginBottom: '0.35rem',
                        }}
                      >
                        🎁 Combos aplicados en esta venta:
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                        {combosEnCarritoMovil.map((entry) => {
                          const ahorroUnitario = calcularAhorroEfectivoComboMovil(
                            entry.combo
                          );
                          return (
                            <div
                              key={entry.combo.id}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                                background: '#ffffff',
                                border: '1px solid #c084fc',
                                borderRadius: '0.4rem',
                                padding: '0.25rem 0.5rem',
                                fontSize: '0.78rem',
                              }}
                            >
                              <span>
                                <strong>
                                  {entry.cantidad}x {entry.combo.nombre}
                                </strong>{' '}
                                — Precio Combo:{' '}
                                <strong style={{ color: '#6b21a8' }}>
                                  {formatearMonedaARS(
                                    entry.combo.precio_venta * entry.cantidad
                                  )}
                                </strong>
                                {ahorroUnitario > 0
                                  ? ` (Bonif.: -${formatearMonedaARS(ahorroUnitario * entry.cantidad)})`
                                  : ''}
                              </span>
                              <button
                                type="button"
                                className="movil-btn movil-btn-secondary"
                                style={{
                                  minHeight: '26px',
                                  padding: '0.1rem 0.4rem',
                                  fontSize: '0.72rem',
                                }}
                                onClick={() =>
                                  quitarComboDelCarritoMovil(entry.combo.id)
                                }
                              >
                                ✕ Quitar combo
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {resumenCarrito.items.map((it) => (
                    <div
                      key={it.producto_id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.5rem 0',
                        borderBottom: '1px solid #e2e8f0',
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                          {it.descripcion}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#475569' }}>
                          {it.cantidad} x {formatearMonedaARS(it.precio_unitario)} ={' '}
                          <strong>{formatearMonedaARS(it.subtotal)}</strong>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.35rem' }}>
                        <button
                          type="button"
                          className="movil-btn movil-btn-secondary"
                          style={{ minHeight: '36px', padding: '0.3rem 0.65rem' }}
                          onClick={() => cambiarCantidadItem(it.producto_id, -1)}
                        >
                          -
                        </button>
                        <button
                          type="button"
                          className="movil-btn movil-btn-secondary"
                          style={{ minHeight: '36px', padding: '0.3rem 0.65rem' }}
                          onClick={() => cambiarCantidadItem(it.producto_id, 1)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '0.6rem',
                      marginTop: '0.75rem',
                    }}
                  >
                    <div>
                      <label
                        style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}
                      >
                        Descuento global ($)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className="movil-input"
                        value={descuentoPesosInput}
                        onChange={(e) => setDescuentoPesosInput(e.target.value)}
                      />
                    </div>
                    <div>
                      <label
                        style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}
                      >
                        Cliente (opcional)
                      </label>
                      <select
                        className="movil-select"
                        value={clienteIdSeleccionado}
                        onChange={(e) => setClienteIdSeleccionado(e.target.value)}
                      >
                        <option value="">Consumidor Final</option>
                        {clientes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nombre}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginTop: '0.75rem' }}>
                    <label
                      style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}
                    >
                      Medio de pago principal
                    </label>
                    <select
                      className="movil-select"
                      value={medioPrincipal}
                      disabled={usarPagoMixto}
                      onChange={(e) =>
                        setMedioPrincipal(e.target.value as MedioPago)
                      }
                    >
                      {Object.entries(ETIQUETAS_MEDIO_PAGO).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ marginTop: '0.5rem' }}>
                    <label style={{ fontSize: '0.85rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={usarPagoMixto}
                        onChange={(e) => setUsarPagoMixto(e.target.checked)}
                      />
                      <span>Combinar varios medios de pago</span>
                    </label>
                  </div>

                  {usarPagoMixto ? (
                    <div
                      style={{
                        marginTop: '0.6rem',
                        padding: '0.65rem',
                        background: '#f8fafc',
                        borderRadius: '0.55rem',
                        border: '1px solid #cbd5e1',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '0.5rem',
                        }}
                      >
                        <strong style={{ fontSize: '0.82rem' }}>
                          Medios combinados ({pagosCombinadosMovil.length})
                        </strong>
                        <button
                          type="button"
                          className="movil-btn movil-btn-secondary"
                          style={{ minHeight: '30px', padding: '0.25rem 0.55rem', fontSize: '0.76rem' }}
                          onClick={agregarFilaPagoMovil}
                        >
                          + Agregar medio
                        </button>
                      </div>

                      {pagosCombinadosMovil.map((fila, idx) => (
                        <div
                          key={fila.id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr auto',
                            gap: '0.4rem',
                            alignItems: 'end',
                            marginBottom: '0.5rem',
                          }}
                        >
                          <div>
                            <label style={{ fontSize: '0.75rem', display: 'block' }}>
                              Medio #{idx + 1}
                            </label>
                            <select
                              className="movil-select"
                              value={fila.medio}
                              onChange={(e) =>
                                actualizarFilaPagoMovil(fila.id, {
                                  medio: e.target.value as MedioPago,
                                })
                              }
                            >
                              {Object.entries(ETIQUETAS_MEDIO_PAGO).map(
                                ([k, label]) => (
                                  <option key={k} value={k}>
                                    {label}
                                  </option>
                                )
                              )}
                            </select>
                          </div>
                          <div>
                            <label style={{ fontSize: '0.75rem', display: 'block' }}>
                              Monto #{idx + 1} ($)
                            </label>
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              className="movil-input"
                              placeholder="0.00"
                              value={fila.montoPesosInput}
                              onChange={(e) =>
                                actualizarFilaPagoMovil(fila.id, {
                                  montoPesosInput: e.target.value,
                                })
                              }
                            />
                          </div>
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <button
                              type="button"
                              className="movil-btn movil-btn-secondary"
                              style={{ minHeight: '36px', padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                              onClick={() => completarRestoFilaPagoMovil(fila.id)}
                            >
                              Resto
                            </button>
                            {pagosCombinadosMovil.length > 2 && (
                              <button
                                type="button"
                                className="movil-btn movil-btn-secondary"
                                style={{ minHeight: '36px', padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                onClick={() => quitarFilaPagoMovil(fila.id)}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                      ))}

                      <div
                        style={{
                          fontSize: '0.8rem',
                          marginTop: '0.45rem',
                          paddingTop: '0.45rem',
                          borderTop: '1px solid #e2e8f0',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Suma ingresada:</span>
                          <strong>
                            {formatearMonedaARS(estadoPagosCombinadosMovil.sumaPagos)}
                          </strong>
                        </div>
                        <div style={{ marginTop: '0.25rem' }}>
                          {estadoPagosCombinadosMovil.esValidoParaCobrar ? (
                            <span style={{ color: '#15803d', fontWeight: 600 }}>
                              ✓ Suma verificada igual al monto a cobrar.
                            </span>
                          ) : estadoPagosCombinadosMovil.faltaCubrirCentavos > 0 ? (
                            <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                              Faltan cubrir{' '}
                              {formatearMonedaARS(
                                estadoPagosCombinadosMovil.faltaCubrirCentavos
                              )}
                            </span>
                          ) : estadoPagosCombinadosMovil.excedenteCentavos > 0 ? (
                            <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                              Excede por{' '}
                              {formatearMonedaARS(
                                estadoPagosCombinadosMovil.excedenteCentavos
                              )}
                            </span>
                          ) : (
                            <span style={{ color: '#b45309' }}>
                              Cada medio debe tener un monto mayor a $ 0,00.
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div
                    style={{
                      marginTop: '0.9rem',
                      padding: '0.75rem',
                      background: '#eff6ff',
                      borderRadius: '0.6rem',
                    }}
                  >
                    {resumenCarrito.descuento_global > 0 && (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: '0.84rem',
                            color: '#475569',
                            marginBottom: '0.25rem',
                          }}
                        >
                          <span>Subtotal artículos (precio individual):</span>
                          <span>{formatearMonedaARS(resumenCarrito.subtotal)}</span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: '0.84rem',
                            color: '#15803d',
                            fontWeight: 600,
                            marginBottom: '0.45rem',
                            paddingBottom: '0.45rem',
                            borderBottom: '1px solid #bfdbfe',
                          }}
                        >
                          <span>Bonificación combo / descuento:</span>
                          <span>
                            -{formatearMonedaARS(resumenCarrito.descuento_global)}
                          </span>
                        </div>
                      </>
                    )}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>TOTAL A COBRAR</span>
                      <span
                        style={{
                          fontSize: '1.35rem',
                          fontWeight: 800,
                          color: '#1e40af',
                        }}
                      >
                        {formatearMonedaARS(resumenCarrito.total)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="movil-btn movil-btn-success"
                    style={{ width: '100%', marginTop: '0.75rem' }}
                    disabled={cargando}
                    onClick={() => void manejarConfirmarVentaMovil()}
                  >
                    {cargando
                      ? 'Procesando venta...'
                      : `Cobrar ${formatearMonedaARS(resumenCarrito.total)}`}
                  </button>
                </>
              )}
            </section>
          </>
        )}

        {pestania === 'caja' && (
          <section className="movil-card">
            <h2>Mi Caja Móvil</h2>
            {!estadoCaja?.sesion ? (
              <form onSubmit={(e) => void manejarAbrirCajaMovil(e)}>
                <p style={{ fontSize: '0.88rem', color: '#475569' }}>
                  No tenés una caja móvil abierta en este momento. Podés abrir tu
                  propia sesión de caja móvil o vender directamente.
                </p>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                    Monto inicial de cambio ($)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="movil-input"
                    value={montoAperturaPesos}
                    onChange={(e) => setMontoAperturaPesos(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="movil-btn movil-btn-primary"
                  style={{ width: '100%' }}
                  disabled={cargando}
                >
                  Abrir Caja Móvil
                </button>
              </form>
            ) : (
              <div>
                <p style={{ fontSize: '0.85rem', color: '#475569' }}>
                  Apertura:{' '}
                  <strong>
                    {formatearFechaHoraAR(estadoCaja.sesion.fecha_apertura)}
                  </strong>
                </p>
                <div
                  style={{
                    background: '#f8fafc',
                    padding: '0.75rem',
                    borderRadius: '0.55rem',
                    border: '1px solid #cbd5e1',
                    marginBottom: '0.85rem',
                  }}
                >
                  <div>
                    Monto inicial:{' '}
                    <strong>
                      {formatearMonedaARS(estadoCaja.sesion.monto_inicial)}
                    </strong>
                  </div>
                  <div>
                    Ventas en esta sesión:{' '}
                    <strong>{estadoCaja.cantidad_ventas}</strong>
                  </div>
                  <div>
                    Efectivo esperado en mano:{' '}
                    <strong>
                      {formatearMonedaARS(estadoCaja.efectivo_esperado)}
                    </strong>
                  </div>
                </div>

                <form onSubmit={(e) => void manejarCerrarCajaMovil(e)}>
                  <div style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                      Efectivo físico contado al cerrar ($)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      className="movil-input"
                      placeholder="Ej. 15000"
                      value={efectivoContadoCierrePesos}
                      onChange={(e) =>
                        setEfectivoContadoCierrePesos(e.target.value)
                      }
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    className="movil-btn movil-btn-danger"
                    style={{ width: '100%' }}
                    disabled={cargando}
                  >
                    Cerrar Caja Móvil
                  </button>
                </form>
              </div>
            )}
          </section>
        )}

        {pestania === 'ventas' && (
          <section className="movil-card">
            <h2>Mis Ventas de Hoy ({ventasDia.length})</h2>
            {ventasDia.length === 0 ? (
              <p style={{ color: '#64748b', fontSize: '0.88rem' }}>
                Todavía no registraste ventas hoy con tu usuario.
              </p>
            ) : (
              ventasDia.map((v) => (
                <div
                  key={v.id}
                  style={{
                    padding: '0.65rem 0',
                    borderBottom: '1px solid #e2e8f0',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontWeight: 600,
                    }}
                  >
                    <span>#{v.id.slice(-8).toUpperCase()}</span>
                    <span>{formatearMonedaARS(v.total)}</span>
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#475569' }}>
                    {formatearFechaHoraAR(v.fecha)} — Canal: {v.canal}
                    {v.cliente_nombre ? ` — Cliente: ${v.cliente_nombre}` : ''}
                  </div>
                  <div style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    {v.items
                      .map((it) => `${it.cantidad}x ${it.descripcion}`)
                      .join(', ')}
                  </div>
                </div>
              ))
            )}
          </section>
        )}

        <footer
          style={{
            textAlign: 'center',
            padding: '0.75rem 0 0.25rem',
            fontSize: '0.76rem',
            color: '#64748b',
          }}
        >
          <strong>GAR</strong> - Guillermo Adolfo Rohde
        </footer>
      </main>

      <nav className="movil-nav-bottom" aria-label="Navegación móvil">
        <button
          type="button"
          className={`movil-nav-tab ${pestania === 'vender' ? 'activo' : ''}`}
          onClick={() => setPestania('vender')}
        >
          🛒 Vender ({carrito.length})
        </button>
        <button
          type="button"
          className={`movil-nav-tab ${pestania === 'caja' ? 'activo' : ''}`}
          onClick={() => setPestania('caja')}
        >
          💵 Caja Móvil
        </button>
        <button
          type="button"
          className={`movil-nav-tab ${pestania === 'ventas' ? 'activo' : ''}`}
          onClick={() => setPestania('ventas')}
        >
          📋 Mis Ventas ({ventasDia.length})
        </button>
      </nav>
    </div>
  );
}
