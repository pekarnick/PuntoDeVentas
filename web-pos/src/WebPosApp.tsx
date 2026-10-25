import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  aCentavos,
  calcularVentaMovilDesdeCatalogo,
  formatearFechaHoraAR,
  formatearMonedaARS,
  type Centavos,
  type MedioPago,
  type PagoVentaInput,
  type ProductoCatalogoMovil,
} from '@pos/domain';
import { invocarPosApi } from '../../src/db/cliente_pos_api.ts';
import { generarUuidV7 } from '../../src/domain/uuid.ts';
import type {
  EstadoCajaMovil,
  ResultadoCrearVentaMovil,
} from '../../src/db/venta_movil_repo.ts';

interface SesionMovilCliente {
  readonly sesion_id: string;
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
const CLAVE_DEVICE_ID = 'pos_web_movil_device_id_v1';

function obtenerDispositivoIdMovil(): string {
  if (typeof window === 'undefined') return 'movil-web-1';
  const guardado = window.localStorage.getItem(CLAVE_DEVICE_ID);
  if (guardado) return guardado;
  const nuevo = `celular-${generarUuidV7().slice(-8)}`;
  window.localStorage.setItem(CLAVE_DEVICE_ID, nuevo);
  return nuevo;
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
      return raw ? (JSON.parse(raw) as SesionMovilCliente) : null;
    } catch {
      return null;
    }
  });

  const [pestania, setPestania] = useState<'vender' | 'caja' | 'ventas'>('vender');

  // Login form
  const [loginUsuario, setLoginUsuario] = useState('maria');
  const [loginClave, setLoginClave] = useState('Admin1234');
  const [loginDispositivoNombre, setLoginDispositivoNombre] = useState(
    'Celular Mostrador 1'
  );

  // Catálogo y clientes (Regla 20: nunca incluye costo_compra)
  const [catalogo, setCatalogo] = useState<ProductoCatalogoMovil[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(CLAVE_CATALOGO_CACHE);
      return raw ? (JSON.parse(raw) as ProductoCatalogoMovil[]) : [];
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
  const [descuentoPesosInput, setDescuentoPesosInput] = useState('0');
  const [clienteIdSeleccionado, setClienteIdSeleccionado] = useState('');
  const [medioPrincipal, setMedioPrincipal] = useState<MedioPago>('efectivo');
  const [usarPagoMixto, setUsarPagoMixto] = useState(false);
  const [medioSecundario, setMedioSecundario] =
    useState<MedioPago>('mercado_pago');
  const [montoPrincipalPesosInput, setMontoPrincipalPesosInput] = useState('');
  const [ventaUuidPendiente, setVentaUuidPendiente] = useState<string>(() =>
    generarUuidV7()
  );

  // Comprobante emitido
  const [ultimoComprobante, setUltimoComprobante] =
    useState<ResultadoCrearVentaMovil | null>(null);

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
    }
    setSesion(null);
    setCarrito([]);
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
        setClientes(catRes.clientes);
        setEstadoCaja(cajaRes);
        setVentasDia(ventasRes.ventas);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(
            CLAVE_CATALOGO_CACHE,
            JSON.stringify(catRes.productos)
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

  const buscarYAgregarPorCodigo = useCallback(
    (codigo: string) => {
      const limpio = codigo.trim();
      if (!limpio) return;
      const encontrado = catalogo.find(
        (p) =>
          p.codigos_barras.includes(limpio) ||
          (p.codigo_interno &&
            p.codigo_interno.toLowerCase() === limpio.toLowerCase())
      );
      if (!encontrado) {
        setMensajeError(`No se encontró ningún producto con el código "${limpio}".`);
        return;
      }
      agregarAlCarrito(encontrado);
      setMensajeOk(`Agregado: ${encontrado.nombre}`);
      setCodigoManual('');
    },
    [catalogo, agregarAlCarrito]
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

  const descuentoCentavos = useMemo(() => {
    const num = Number(descuentoPesosInput.replace(',', '.'));
    return Number.isFinite(num) && num > 0 ? aCentavos(num) : 0;
  }, [descuentoPesosInput]);

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

  async function manejarLoginMovil(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeOk(null);
    setCargando(true);
    try {
      const dispositivoId = obtenerDispositivoIdMovil();
      const res = await invocarPosApi<{
        sesion_id: string;
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

  function cambiarCantidadItem(productoId: string, delta: number) {
    setCarrito((prev) =>
      prev
        .map((it) =>
          it.producto_id === productoId
            ? { ...it, cantidad: Math.max(0, Number((it.cantidad + delta).toFixed(3))) }
            : it
        )
        .filter((it) => it.cantidad > 0)
    );
  }

  async function manejarConfirmarVentaMovil() {
    if (!sesion || !resumenCarrito) return;
    setMensajeError(null);
    setMensajeOk(null);

    let pagos: PagoVentaInput[];
    if (!usarPagoMixto) {
      pagos = [{ medio: medioPrincipal, monto: resumenCarrito.total }];
    } else {
      const monto1 = aCentavos(
        Number(montoPrincipalPesosInput.replace(',', '.')) || 0
      );
      const monto2 = resumenCarrito.total - monto1;
      if (monto1 <= 0 || monto2 <= 0) {
        setMensajeError(
          'En pago mixto, ambos importes deben ser mayores a $ 0,00.'
        );
        return;
      }
      pagos = [
        { medio: medioPrincipal, monto: monto1 },
        { medio: medioSecundario, monto: monto2 },
      ];
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
          descuentoGlobal: descuentoCentavos,
          clienteId: clienteIdSeleccionado || null,
          cajaSesionId: estadoCaja?.sesion?.id ?? null,
        }
      );

      setUltimoComprobante(resultado);
      setCarrito([]);
      setDescuentoPesosInput('0');
      setClienteIdSeleccionado('');
      setUsarPagoMixto(false);
      // Generar un nuevo UUID para la próxima venta
      setVentaUuidPendiente(generarUuidV7());
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
      const montoCentavos = aCentavos(
        Number(montoAperturaPesos.replace(',', '.')) || 0
      );
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
      const contadoCentavos = aCentavos(
        Number(efectivoContadoCierrePesos.replace(',', '.')) || 0
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
          <section className="movil-card" aria-label="Comprobante de venta móvil">
            <h2>
              ✓ Venta registrada ({formatearMonedaARS(ultimoComprobante.total)})
            </h2>
            <pre
              style={{
                background: '#f8fafc',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid #cbd5e1',
                fontSize: '0.82rem',
                whiteSpace: 'pre-wrap',
                margin: '0.5rem 0 0.85rem',
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
                style={{ flex: 1, textDecoration: 'none' }}
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
                onClick={() => setUltimoComprobante(null)}
              >
                Nueva venta
              </button>
            </div>
          </section>
        ) : null}

        {pestania === 'vender' && (
          <>
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
                Catálogo de Venta ({productosFiltrados.length} productos — sin costos)
              </h2>
              {productosFiltrados.length === 0 ? (
                <p style={{ color: '#64748b', fontSize: '0.88rem' }}>
                  No hay productos que coincidan con la búsqueda.
                </p>
              ) : (
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
              )}
            </section>

            <section className="movil-card" aria-label="Carrito móvil">
              <h2>
                Carrito Actual ({carrito.length}{' '}
                {carrito.length === 1 ? 'ítem' : 'ítems'})
              </h2>
              {carrito.length === 0 || !resumenCarrito ? (
                <p style={{ color: '#64748b', fontSize: '0.88rem', margin: 0 }}>
                  Tocá un producto o escaneá un código de barras para empezar.
                </p>
              ) : (
                <>
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
                      Medio de pago
                    </label>
                    <select
                      className="movil-select"
                      value={medioPrincipal}
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
                      <span>Combinar con un segundo medio de pago (Pago mixto)</span>
                    </label>
                  </div>

                  {usarPagoMixto ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '0.6rem',
                        marginTop: '0.5rem',
                      }}
                    >
                      <div>
                        <label style={{ fontSize: '0.78rem', display: 'block' }}>
                          Monto 1 ({ETIQUETAS_MEDIO_PAGO[medioPrincipal]}) $
                        </label>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="movil-input"
                          value={montoPrincipalPesosInput}
                          onChange={(e) =>
                            setMontoPrincipalPesosInput(e.target.value)
                          }
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: '0.78rem', display: 'block' }}>
                          Segundo medio
                        </label>
                        <select
                          className="movil-select"
                          value={medioSecundario}
                          onChange={(e) =>
                            setMedioSecundario(e.target.value as MedioPago)
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
                    </div>
                  ) : null}

                  <div
                    style={{
                      marginTop: '0.9rem',
                      padding: '0.75rem',
                      background: '#eff6ff',
                      borderRadius: '0.6rem',
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
