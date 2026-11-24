/**
 * Cliente HTTP unificado para comunicar la interfaz React con:
 * 1) El servidor local SQLite (`/api/pos`) cuando corre en la PC principal o entorno de desarrollo.
 * 2) Directamente con Supabase PostgREST / RPC (con RLS y `anon_key` pública, Regla 8 y §6.2)
 *    cuando el Cajero Móvil (`/web-pos`) está publicado en un hosting estático en la nube como Netlify.
 */

import {
  calcularArqueoCaja,
  formatearComprobanteMovilWhatsApp,
  proyectarProductoParaVenta,
  type AlicuotaIva,
  type Centavos,
  type ItemPedidoMovilInput,
  type MedioPago,
  type PagoVentaInput,
  type ProductoCatalogoMovil,
} from '../../packages/domain/src/index.ts';
import { calcularEstadoCuentaCorriente } from '../domain/gestion_fase3.ts';
import { generarUuidV7 } from '../domain/uuid.ts';

export interface ConfigNubeMovilPublica {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly comercioId: string;
  readonly comercioNombre: string;
}

declare global {
  interface Window {
    __POS_CONFIG__?: Partial<ConfigNubeMovilPublica>;
  }
}

const CLAVE_CONFIG_NUBE_MOVIL_STORAGE = 'pos_web_movil_supabase_config_v1';
const CLAVE_SESION_STORAGE = 'pos_web_movil_sesion_v1';
const CLAVE_SESION_TOKEN_LOCAL = 'pos_sesion_token_local_v1';

let sessionTokenLocalMemoria: string | null = null;

export function establecerTokenSesionLocal(token: string | null): void {
  const limpio = token && token.trim() ? token.trim() : null;
  sessionTokenLocalMemoria = limpio;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      if (limpio) {
        window.sessionStorage.setItem(CLAVE_SESION_TOKEN_LOCAL, limpio);
      } else {
        window.sessionStorage.removeItem(CLAVE_SESION_TOKEN_LOCAL);
      }
    } catch {
      // Ignorar errores de sessionStorage
    }
  }
}

export function obtenerTokenSesionLocal(): string | null {
  if (sessionTokenLocalMemoria) return sessionTokenLocalMemoria;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const guardado = window.sessionStorage.getItem(CLAVE_SESION_TOKEN_LOCAL);
      if (guardado && guardado.trim()) {
        sessionTokenLocalMemoria = guardado.trim();
        return sessionTokenLocalMemoria;
      }
    } catch {
      // Ignorar errores de sessionStorage
    }
  }
  return null;
}

export function limpiarTokenSesionLocal(): void {
  establecerTokenSesionLocal(null);
}

/**
 * Valores públicos por defecto del comercio (Regla 8: solo URL pública, UUID del comercio
 * y clave pública `anon` protegida por Row Level Security en Supabase).
 */
const CONFIG_PUBLICA_POR_DEFECTO: ConfigNubeMovilPublica = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  comercioId: '',
  comercioNombre: 'Comercio Local POS',
};

const ACCIONES_MOVILES_NUBE: ReadonlySet<string> = new Set([
  'login_movil',
  'iniciar_sesion_movil',
  'obtener_catalogo_movil',
  'estado_caja_movil',
  'abrir_caja_movil',
  'cerrar_caja_movil',
  'listar_ventas_movil_dia',
  'crear_venta_movil',
]);

let usuarioActivoIdMemoria: string | null = null;

export function establecerUsuarioActivoClientePos(
  usuarioId: string | null
): void {
  usuarioActivoIdMemoria =
    usuarioId && usuarioId.trim() ? usuarioId.trim() : null;
}

export function obtenerUsuarioActivoClientePos(): string | null {
  return usuarioActivoIdMemoria;
}

export function obtenerConfigNubeMovilCliente(): ConfigNubeMovilPublica {
  let desdeStorage: Partial<ConfigNubeMovilPublica> = {};
  let desdeWindow: Partial<ConfigNubeMovilPublica> = {};

  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(CLAVE_CONFIG_NUBE_MOVIL_STORAGE);
      if (raw) {
        desdeStorage = JSON.parse(raw) as Partial<ConfigNubeMovilPublica>;
      }
    } catch {
      // Ignorar errores de lectura de localStorage
    }
    if (window.__POS_CONFIG__) {
      desdeWindow = window.__POS_CONFIG__;
    }
  }

  return {
    supabaseUrl: (
      desdeWindow.supabaseUrl?.trim() ||
      desdeStorage.supabaseUrl?.trim() ||
      CONFIG_PUBLICA_POR_DEFECTO.supabaseUrl
    ).replace(/\/+$/, ''),
    supabaseAnonKey:
      desdeWindow.supabaseAnonKey?.trim() ||
      desdeStorage.supabaseAnonKey?.trim() ||
      CONFIG_PUBLICA_POR_DEFECTO.supabaseAnonKey,
    comercioId:
      desdeWindow.comercioId?.trim() ||
      desdeStorage.comercioId?.trim() ||
      CONFIG_PUBLICA_POR_DEFECTO.comercioId,
    comercioNombre:
      desdeWindow.comercioNombre?.trim() ||
      desdeStorage.comercioNombre?.trim() ||
      CONFIG_PUBLICA_POR_DEFECTO.comercioNombre,
  };
}

export function guardarConfigNubeMovilCliente(
  parcial: Partial<ConfigNubeMovilPublica>
): ConfigNubeMovilPublica {
  if (typeof window !== 'undefined') {
    const actual = obtenerConfigNubeMovilCliente();
    const nueva: ConfigNubeMovilPublica = {
      supabaseUrl: (parcial.supabaseUrl ?? actual.supabaseUrl)
        .trim()
        .replace(/\/+$/, ''),
      supabaseAnonKey: (
        parcial.supabaseAnonKey ?? actual.supabaseAnonKey
      ).trim(),
      comercioId: (parcial.comercioId ?? actual.comercioId).trim(),
      comercioNombre: (parcial.comercioNombre ?? actual.comercioNombre).trim(),
    };
    window.localStorage.setItem(
      CLAVE_CONFIG_NUBE_MOVIL_STORAGE,
      JSON.stringify(nueva)
    );
    return nueva;
  }
  return obtenerConfigNubeMovilCliente();
}

function obtenerContextoSesionGuardada(): {
  sesionId?: string;
  accessToken?: string;
  comercioId?: string;
  comercioNombre?: string;
  usuarioId?: string;
  usuarioNombre?: string;
  rol?: string;
} {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(CLAVE_SESION_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as {
      sesion_id?: string;
      access_token?: string;
      comercio_id?: string;
      comercio_nombre?: string;
      usuario?: { id?: string; nombre?: string; rol?: string };
    };
    return {
      sesionId: parsed.sesion_id,
      accessToken: parsed.access_token,
      comercioId: parsed.comercio_id,
      comercioNombre: parsed.comercio_nombre,
      usuarioId: parsed.usuario?.id,
      usuarioNombre: parsed.usuario?.nombre,
      rol: parsed.usuario?.rol,
    };
  } catch {
    return {};
  }
}

function esHostEstaticoNube(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const host = window.location.hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return false;
  }
  return true;
}

function construirCabecerasSupabase(
  cfg: ConfigNubeMovilPublica,
  opciones: {
    accessToken?: string;
    prefer?: string;
  } = {}
): Record<string, string> {
  const ctxSesion = obtenerContextoSesionGuardada();
  const token = (opciones.accessToken || ctxSesion.accessToken || '').trim();
  if (!token) {
    throw new Error(
      'SESION_NO_AUTENTICADA: Debés iniciar sesión en /web-pos para operar con Supabase.'
    );
  }

  return {
    apikey: cfg.supabaseAnonKey,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(opciones.prefer ? { Prefer: opciones.prefer } : {}),
  };
}

async function extraerMensajeErrorSupabase(resp: Response): Promise<string> {
  const texto = await resp.text();
  try {
    const parsed = JSON.parse(texto) as {
      message?: string;
      error?: string;
      details?: string;
    };
    if (parsed.message) return parsed.message;
    if (parsed.error) return parsed.error;
  } catch {
    // No era JSON
  }
  return texto || `Error HTTP ${resp.status} al comunicarse con Supabase.`;
}

async function ejecutarAccionMovilDirectoSupabase<T>(
  accion: string,
  payload: Record<string, unknown>
): Promise<T> {
  const cfg = obtenerConfigNubeMovilCliente();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error(
      'Falta configurar la conexión con Supabase (URL y Anon Key) para el Cajero Móvil.'
    );
  }

  const ctxSesion = obtenerContextoSesionGuardada();
  const comercioId = String(
    payload.comercioId || ctxSesion.comercioId || cfg.comercioId
  ).trim();

  // ---------------------------------------------------------------------------
  // 1. LOGIN MÓVIL (`login_movil` / `iniciar_sesion_movil`)
  // ---------------------------------------------------------------------------
  if (accion === 'login_movil' || accion === 'iniciar_sesion_movil') {
    const usuarioInput = String(payload.usuario ?? '').trim();
    const claveInput = String(payload.clave ?? '');
    const dispositivoId = String(payload.dispositivoId || 'movil-web-1').trim();
    const dispositivoNombre = String(
      payload.dispositivoNombre || 'Celular Web POS'
    ).trim();

    if (!usuarioInput || !claveInput) {
      throw new Error('Ingresá tu email/usuario y clave para iniciar sesión.');
    }

    // Autenticar contra Supabase Auth (sin consultar tablas ni descargar hashes pre-auth)
    const respAuth = await fetch(
      `${cfg.supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          apikey: cfg.supabaseAnonKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email: usuarioInput,
          password: claveInput,
        }),
      }
    );
    if (!respAuth.ok) {
      throw new Error(
        'CREDENCIALES_INVALIDAS: Email o contraseña incorrectos en Supabase Auth.'
      );
    }
    const authJson = (await respAuth.json()) as {
      access_token?: string;
      user?: { id?: string };
    };
    const accessToken = authJson.access_token?.trim();
    const authUid = authJson.user?.id?.trim();
    if (!accessToken || !authUid) {
      throw new Error('CREDENCIALES_INVALIDAS: No se recibió token de Supabase Auth.');
    }

    const headersAuth = construirCabecerasSupabase(cfg, { accessToken });

    // Consultar únicamente el perfil propio del usuario autenticado (sin clave_hash/pin_hash)
    const respPerfil = await fetch(
      `${cfg.supabaseUrl}/rest/v1/usuarios?or=(id.eq.${encodeURIComponent(authUid)},auth_user_id.eq.${encodeURIComponent(authUid)})&deleted_at=is.null&select=id,comercio_id,nombre,usuario,rol,puede_vender_movil,activo&limit=1`,
      { headers: headersAuth }
    );
    if (!respPerfil.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respPerfil));
    }
    const perfiles = (await respPerfil.json()) as Array<{
      id: string;
      comercio_id: string;
      nombre: string;
      usuario: string;
      rol: 'superadmin' | 'encargado' | 'cajero';
      puede_vender_movil?: boolean | number | null;
      activo?: boolean | number | null;
    }>;
    const u = perfiles[0];
    if (!u || u.activo === false || u.activo === 0) {
      throw new Error(
        'USUARIO_INACTIVO: El usuario autenticado no existe o está desactivado en el comercio.'
      );
    }

    const tienePermisoMovil =
      u.puede_vender_movil === true || u.puede_vender_movil === 1;
    if (!tienePermisoMovil) {
      throw new Error(
        `PERMISO_DENEGADO: El usuario "${u.nombre}" no tiene habilitado el permiso de Venta Móvil.`
      );
    }

    const comercioRealId = u.comercio_id;
    const respComercio = await fetch(
      `${cfg.supabaseUrl}/rest/v1/comercios?id=eq.${encodeURIComponent(comercioRealId)}&deleted_at=is.null&select=id,nombre,nombre_fantasia,razon_social,venta_movil_habilitada`,
      { headers: headersAuth }
    );
    if (!respComercio.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respComercio));
    }
    const comerciosRows = (await respComercio.json()) as Array<{
      id: string;
      nombre?: string | null;
      nombre_fantasia?: string | null;
      razon_social?: string | null;
      venta_movil_habilitada?: boolean | number | null;
    }>;
    const comercio = comerciosRows[0];
    if (
      !comercio ||
      comercio.venta_movil_habilitada === false ||
      comercio.venta_movil_habilitada === 0
    ) {
      throw new Error(
        'VENTA_MOVIL_DESHABILITADA: La Venta Móvil se encuentra deshabilitada en este comercio.'
      );
    }

    const ahora = new Date();
    const ahoraIso = ahora.toISOString();
    const expiraIso = new Date(ahora.getTime() + 120 * 60_000).toISOString();
    const sesionId = generarUuidV7();

    usuarioActivoIdMemoria = u.id;

    const respSesionMovil = await fetch(
      `${cfg.supabaseUrl}/rest/v1/sesiones_moviles?on_conflict=id`,
      {
        method: 'POST',
        headers: construirCabecerasSupabase(cfg, {
          accessToken,
          prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify([
          {
            id: sesionId,
            comercio_id: comercioRealId,
            usuario_id: u.id,
            dispositivo_id: dispositivoId,
            dispositivo_nombre: dispositivoNombre,
            user_agent:
              typeof payload.userAgent === 'string'
                ? payload.userAgent
                : null,
            iniciada_at: ahoraIso,
            ultima_actividad_at: ahoraIso,
            expira_at: expiraIso,
            estado: 'activa',
            created_at: ahoraIso,
            updated_at: ahoraIso,
            device_id: dispositivoId,
            sync_status: 'sincronizado',
          },
        ]),
      }
    );
    if (!respSesionMovil.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respSesionMovil));
    }

    const nombreComercioFinal =
      comercio?.nombre ||
      comercio?.nombre_fantasia ||
      comercio?.razon_social ||
      cfg.comercioNombre ||
      'Comercio Local POS';

    return {
      sesion_id: sesionId,
      access_token: accessToken,
      expira_at: expiraIso,
      comercio_id: comercioRealId,
      comercio_nombre: nombreComercioFinal,
      usuario: {
        id: u.id,
        nombre: u.nombre,
        usuario: u.usuario,
        rol: u.rol,
      },
    } as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // 2. OBTENER CATÁLOGO MÓVIL (`obtener_catalogo_movil`) — Regla 20: sin costos
  // ---------------------------------------------------------------------------
  if (accion === 'obtener_catalogo_movil') {
    const headersCat = construirCabecerasSupabase(cfg);

    const [
      respProd,
      respCodigos,
      respCombos,
      respCombosItems,
      respClientes,
      respMovsCc,
    ] = await Promise.all([
      fetch(
        `${cfg.supabaseUrl}/rest/v1/productos_venta?select=*&order=nombre.asc`,
        { headers: headersCat }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/codigos_barras?comercio_id=eq.${encodeURIComponent(comercioId)}&deleted_at=is.null&select=producto_id,codigo`,
        { headers: headersCat }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/combos?comercio_id=eq.${encodeURIComponent(comercioId)}&activo=eq.true&deleted_at=is.null&select=*`,
        { headers: headersCat }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/combos_items?comercio_id=eq.${encodeURIComponent(comercioId)}&deleted_at=is.null&select=*`,
        { headers: headersCat }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/clientes?comercio_id=eq.${encodeURIComponent(comercioId)}&deleted_at=is.null&select=id,nombre,cuit_dni,condicion_iva,limite_credito&order=nombre.asc`,
        { headers: headersCat }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/cuenta_corriente_movimientos?comercio_id=eq.${encodeURIComponent(comercioId)}&entidad_tipo=eq.cliente&deleted_at=is.null&select=id,entidad_id,tipo,monto,deleted_at`,
        { headers: headersCat }
      ),
    ]);

    if (!respProd.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respProd));
    }

    const prodsRaw = (await respProd.json()) as Array<{
      id: string;
      codigo_interno: string | null;
      nombre: string;
      unidad: ProductoCatalogoMovil['unidad'];
      permite_decimales: boolean | number;
      precio_venta: number;
      alicuota_iva: number;
      exento_iva: boolean | number;
      boton_rapido: boolean | number;
      imagen_path: string | null;
      stock_actual: number;
      codigos_barras?: string[];
    }>;

    const codigosRaw = respCodigos.ok
      ? ((await respCodigos.json()) as Array<{
          producto_id: string;
          codigo: string;
        }>)
      : [];

    const codigosPorProducto = new Map<string, string[]>();
    for (const c of codigosRaw) {
      const arr = codigosPorProducto.get(c.producto_id) ?? [];
      arr.push(c.codigo);
      codigosPorProducto.set(c.producto_id, arr);
    }

    const productos: ProductoCatalogoMovil[] = prodsRaw.map((f) =>
      proyectarProductoParaVenta({
        id: f.id,
        codigo_interno: f.codigo_interno ?? null,
        nombre: f.nombre,
        unidad: f.unidad ?? 'unidad',
        permite_decimales:
          f.permite_decimales === true || f.permite_decimales === 1,
        precio_venta: Number(f.precio_venta ?? 0),
        alicuota_iva: (Number(f.alicuota_iva ?? 21) as AlicuotaIva) || 21,
        exento_iva: f.exento_iva === true || f.exento_iva === 1,
        boton_rapido: f.boton_rapido === true || f.boton_rapido === 1,
        imagen_path: f.imagen_path ?? null,
        codigos_barras: Array.isArray(f.codigos_barras)
          ? f.codigos_barras
          : (codigosPorProducto.get(f.id) ?? []),
        stock_actual: Number(f.stock_actual ?? 0),
      })
    );

    const prodMap = new Map(productos.map((p) => [p.id, p]));

    const combosRaw = respCombos.ok
      ? ((await respCombos.json()) as Array<{
          id: string;
          nombre: string;
          descripcion?: string | null;
          codigo_barras?: string | null;
          precio_venta: number;
        }>)
      : [];

    const combosItemsRaw = respCombosItems.ok
      ? ((await respCombosItems.json()) as Array<{
          combo_id: string;
          producto_id: string;
          cantidad: number;
        }>)
      : [];

    const combos = combosRaw.map((c) => {
      const items = combosItemsRaw
        .filter((ci) => ci.combo_id === c.id)
        .map((ci) => {
          const prod = prodMap.get(ci.producto_id);
          return {
            producto_id: ci.producto_id,
            producto_nombre: prod ? prod.nombre : 'Producto',
            cantidad: Number(ci.cantidad) || 1,
            precio_unitario_normal: prod ? Number(prod.precio_venta) || 0 : 0,
            stock_actual: prod ? Number(prod.stock_actual) || 0 : 0,
          };
        });

      const precioSumaNormal = items.reduce(
        (acc, it) => acc + Math.round(it.precio_unitario_normal * it.cantidad),
        0
      );
      const precioCombo = Number(c.precio_venta) || 0;
      const ahorro = Math.max(0, precioSumaNormal - precioCombo);
      const pct =
        precioSumaNormal > 0
          ? Math.round((ahorro / precioSumaNormal) * 10000) / 100
          : 0;
      const stockCombos =
        items.length > 0
          ? Math.max(
              0,
              Math.min(
                ...items.map((it) =>
                  it.cantidad > 0
                    ? Math.floor(it.stock_actual / it.cantidad)
                    : 0
                )
              )
            )
          : 0;

      return {
        id: c.id,
        nombre: c.nombre,
        descripcion: c.descripcion ?? null,
        codigo_barras: c.codigo_barras ?? null,
        precio_venta: precioCombo,
        precio_suma_normal: precioSumaNormal,
        ahorro_centavos: ahorro,
        porcentaje_descuento: pct,
        stock_combos_disponibles: stockCombos,
        items,
      };
    });

    const clientesRaw = respClientes.ok
      ? ((await respClientes.json()) as Array<{
          id: string;
          nombre: string;
          cuit_dni: string | null;
          condicion_iva: string;
          limite_credito: number;
        }>)
      : [];

    const movsCcRaw = respMovsCc.ok
      ? ((await respMovsCc.json()) as Array<{
          id: string;
          entidad_id: string;
          tipo: 'cargo' | 'pago';
          monto: number;
          deleted_at: string | null;
        }>)
      : [];

    const clientes = clientesRaw.map((c) => {
      const movsCliente = movsCcRaw.filter((m) => m.entidad_id === c.id);
      const estadoCc = calcularEstadoCuentaCorriente(movsCliente);
      return {
        id: c.id,
        nombre: c.nombre,
        cuit_dni: c.cuit_dni,
        condicion_iva: c.condicion_iva,
        limite_credito: Number(c.limite_credito ?? 0),
        saldo_pendiente: estadoCc.saldoPendienteCentavos,
      };
    });

    return {
      comercioId,
      productos,
      combos,
      clientes,
    } as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // 3. ESTADO DE CAJA MÓVIL (`estado_caja_movil`)
  // ---------------------------------------------------------------------------
  if (accion === 'estado_caja_movil') {
    const usuarioId = String(
      payload.usuarioId || ctxSesion.usuarioId || usuarioActivoIdMemoria || ''
    ).trim();
    const headersCaja = construirCabecerasSupabase(cfg);

    const respSesion = await fetch(
      `${cfg.supabaseUrl}/rest/v1/caja_sesiones?comercio_id=eq.${encodeURIComponent(comercioId)}&usuario_id=eq.${encodeURIComponent(usuarioId)}&estado=eq.abierta&deleted_at=is.null&select=id,usuario_id,fecha_apertura,monto_inicial,estado,observaciones&order=fecha_apertura.desc&limit=1`,
      { headers: headersCaja }
    );

    const sesionesRows = respSesion.ok
      ? ((await respSesion.json()) as Array<{
          id: string;
          usuario_id: string;
          fecha_apertura: string;
          monto_inicial: number;
          estado: 'abierta' | 'cerrada';
          observaciones: string | null;
        }>)
      : [];

    const sesion = sesionesRows[0] ?? null;

    if (!sesion) {
      return {
        sesion: null,
        totales_por_medio: {
          efectivo: 0,
          transferencia: 0,
          mercado_pago: 0,
          qr: 0,
          debito: 0,
          credito: 0,
          cuenta_corriente: 0,
          otro: 0,
        },
        efectivo_esperado: 0,
        cantidad_ventas: 0,
      } as unknown as T;
    }

    const respVentas = await fetch(
      `${cfg.supabaseUrl}/rest/v1/ventas?comercio_id=eq.${encodeURIComponent(comercioId)}&usuario_id=eq.${encodeURIComponent(usuarioId)}&estado=eq.completada&deleted_at=is.null&fecha=gte.${encodeURIComponent(sesion.fecha_apertura)}&select=id,caja_sesion_id`,
      { headers: headersCaja }
    );
    const ventasSesion = respVentas.ok
      ? ((await respVentas.json()) as Array<{
          id: string;
          caja_sesion_id: string | null;
        }>)
      : [];

    const idsVentas = ventasSesion
      .filter((v) => !v.caja_sesion_id || v.caja_sesion_id === sesion.id)
      .map((v) => v.id);

    let pagos: PagoVentaInput[] = [];
    if (idsVentas.length > 0) {
      const filtroIn = idsVentas.map((id) => `"${id}"`).join(',');
      const respPagos = await fetch(
        `${cfg.supabaseUrl}/rest/v1/ventas_pagos?comercio_id=eq.${encodeURIComponent(comercioId)}&venta_id=in.(${encodeURIComponent(filtroIn)})&select=medio,monto`,
        { headers: headersCaja }
      );
      if (respPagos.ok) {
        const pagosRaw = (await respPagos.json()) as Array<{
          medio: MedioPago;
          monto: number;
        }>;
        pagos = pagosRaw.map((p) => ({
          medio: p.medio,
          monto: Number(p.monto ?? 0),
        }));
      }
    }

    const montoInicial = Number(sesion.monto_inicial ?? 0);
    const arqueo = calcularArqueoCaja({
      montoInicial,
      pagosVentasCompletadas: pagos,
      movimientosManuales: [],
      efectivoContado: montoInicial,
    });

    return {
      sesion: {
        ...sesion,
        monto_inicial: montoInicial,
      },
      totales_por_medio: arqueo.totalesPorMedio,
      efectivo_esperado: arqueo.efectivoEsperado,
      cantidad_ventas: idsVentas.length,
    } as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // 4. ABRIR CAJA MÓVIL (`abrir_caja_movil`)
  // ---------------------------------------------------------------------------
  if (accion === 'abrir_caja_movil') {
    const usuarioId = String(
      payload.usuarioId || ctxSesion.usuarioId || usuarioActivoIdMemoria || ''
    ).trim();
    const dispositivoId = String(payload.dispositivoId || 'movil-web-1').trim();
    const montoInicialCentavos = Math.max(
      0,
      Math.round(Number(payload.montoInicialCentavos ?? 0))
    );
    const observaciones =
      typeof payload.observaciones === 'string' && payload.observaciones.trim()
        ? payload.observaciones.trim()
        : 'Caja móvil (/web-pos)';

    const estadoPrevio = (await ejecutarAccionMovilDirectoSupabase<{
      sesion: { id: string } | null;
    }>('estado_caja_movil', { comercioId, usuarioId })) as {
      sesion: { id: string } | null;
    };

    if (estadoPrevio.sesion) {
      return estadoPrevio as unknown as T;
    }

    const ahoraIso = new Date().toISOString();
    const cajaId = generarUuidV7();

    const respInsert = await fetch(`${cfg.supabaseUrl}/rest/v1/caja_sesiones`, {
      method: 'POST',
      headers: construirCabecerasSupabase(cfg, {
        prefer: 'return=minimal',
      }),
      body: JSON.stringify({
        id: cajaId,
        comercio_id: comercioId,
        usuario_id: usuarioId,
        fecha_apertura: ahoraIso,
        monto_inicial: montoInicialCentavos,
        estado: 'abierta',
        observaciones,
        created_at: ahoraIso,
        updated_at: ahoraIso,
        device_id: dispositivoId,
        sync_status: 'sincronizado',
      }),
    });

    if (!respInsert.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respInsert));
    }

    return ejecutarAccionMovilDirectoSupabase<T>('estado_caja_movil', {
      comercioId,
      usuarioId,
    });
  }

  // ---------------------------------------------------------------------------
  // 5. CERRAR CAJA MÓVIL (`cerrar_caja_movil`)
  // ---------------------------------------------------------------------------
  if (accion === 'cerrar_caja_movil') {
    const usuarioId = String(
      payload.usuarioId || ctxSesion.usuarioId || usuarioActivoIdMemoria || ''
    ).trim();
    const dispositivoId = String(payload.dispositivoId || 'movil-web-1').trim();
    const efectivoContadoCentavos = Math.max(
      0,
      Math.round(Number(payload.efectivoContadoCentavos ?? 0))
    );

    const estadoActual = await ejecutarAccionMovilDirectoSupabase<{
      sesion: { id: string } | null;
      efectivo_esperado: Centavos;
      totales_por_medio: Record<MedioPago, Centavos>;
    }>('estado_caja_movil', { comercioId, usuarioId });

    if (!estadoActual.sesion) {
      throw new Error('No tenés una caja móvil abierta.');
    }

    const diferencia = efectivoContadoCentavos - estadoActual.efectivo_esperado;
    const ahoraIso = new Date().toISOString();

    const respUpdate = await fetch(
      `${cfg.supabaseUrl}/rest/v1/caja_sesiones?id=eq.${encodeURIComponent(estadoActual.sesion.id)}&comercio_id=eq.${encodeURIComponent(comercioId)}`,
      {
        method: 'PATCH',
        headers: construirCabecerasSupabase(cfg, {
          prefer: 'return=minimal',
        }),
        body: JSON.stringify({
          fecha_cierre: ahoraIso,
          usuario_cierre_id: usuarioId,
          efectivo_esperado: estadoActual.efectivo_esperado,
          efectivo_contado: efectivoContadoCentavos,
          diferencia,
          estado: 'cerrada',
          updated_at: ahoraIso,
          device_id: dispositivoId,
          sync_status: 'sincronizado',
        }),
      }
    );

    if (!respUpdate.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respUpdate));
    }

    return {
      caja_sesion_id: estadoActual.sesion.id,
      efectivo_esperado: estadoActual.efectivo_esperado,
      efectivo_contado: efectivoContadoCentavos,
      diferencia,
      totales_por_medio: estadoActual.totales_por_medio,
    } as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // 6. LISTAR VENTAS PROPIAS DEL DÍA (`listar_ventas_movil_dia`) — Regla 20
  // ---------------------------------------------------------------------------
  if (accion === 'listar_ventas_movil_dia') {
    const usuarioId = String(
      payload.usuarioId || ctxSesion.usuarioId || usuarioActivoIdMemoria || ''
    ).trim();
    const hoyPrefijo = new Date().toISOString().slice(0, 10);
    const desdeIso = `${hoyPrefijo}T00:00:00.000Z`;
    const headersVentas = construirCabecerasSupabase(cfg);

    const respVentas = await fetch(
      `${cfg.supabaseUrl}/rest/v1/ventas?comercio_id=eq.${encodeURIComponent(comercioId)}&usuario_id=eq.${encodeURIComponent(usuarioId)}&fecha=gte.${encodeURIComponent(desdeIso)}&deleted_at=is.null&select=id,fecha,total,canal,estado,cliente_id&order=fecha.desc&limit=100`,
      { headers: headersVentas }
    );

    if (!respVentas.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respVentas));
    }

    const ventasRows = (await respVentas.json()) as Array<{
      id: string;
      fecha: string;
      total: number;
      canal: 'escritorio' | 'web';
      estado: 'completada' | 'anulada';
      cliente_id: string | null;
    }>;

    if (ventasRows.length === 0) {
      return { ventas: [] } as unknown as T;
    }

    const idsVentas = ventasRows.map((v) => `"${v.id}"`).join(',');
    const [respItems, respPagos, respClientes] = await Promise.all([
      fetch(
        `${cfg.supabaseUrl}/rest/v1/ventas_items?comercio_id=eq.${encodeURIComponent(comercioId)}&venta_id=in.(${encodeURIComponent(idsVentas)})&select=venta_id,descripcion,cantidad,precio_unitario,subtotal`,
        { headers: headersVentas }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/ventas_pagos?comercio_id=eq.${encodeURIComponent(comercioId)}&venta_id=in.(${encodeURIComponent(idsVentas)})&select=venta_id,medio,monto`,
        { headers: headersVentas }
      ),
      fetch(
        `${cfg.supabaseUrl}/rest/v1/clientes?comercio_id=eq.${encodeURIComponent(comercioId)}&deleted_at=is.null&select=id,nombre`,
        { headers: headersVentas }
      ),
    ]);

    const itemsRaw = respItems.ok
      ? ((await respItems.json()) as Array<{
          venta_id: string;
          descripcion: string;
          cantidad: number;
          precio_unitario: number;
          subtotal: number;
        }>)
      : [];

    const pagosRaw = respPagos.ok
      ? ((await respPagos.json()) as Array<{
          venta_id: string;
          medio: MedioPago;
          monto: number;
        }>)
      : [];

    const clientesRaw = respClientes.ok
      ? ((await respClientes.json()) as Array<{ id: string; nombre: string }>)
      : [];
    const mapaClientes = new Map(clientesRaw.map((c) => [c.id, c.nombre]));

    const ventas = ventasRows.map((v) => ({
      id: v.id,
      fecha: v.fecha,
      total: Number(v.total ?? 0),
      canal: v.canal,
      estado: v.estado,
      cliente_nombre: v.cliente_id
        ? (mapaClientes.get(v.cliente_id) ?? null)
        : null,
      items: itemsRaw
        .filter((it) => it.venta_id === v.id)
        .map((it) => ({
          descripcion: it.descripcion,
          cantidad: Number(it.cantidad ?? 1),
          precio_unitario: Number(it.precio_unitario ?? 0),
          subtotal: Number(it.subtotal ?? 0),
        })),
      pagos: pagosRaw
        .filter((p) => p.venta_id === v.id)
        .map((p) => ({
          medio: p.medio,
          monto: Number(p.monto ?? 0),
        })),
    }));

    return { ventas } as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // 7. CREAR VENTA MÓVIL (`crear_venta_movil`) — RPC transaccional e idempotente
  // ---------------------------------------------------------------------------
  if (accion === 'crear_venta_movil') {
    const ventaId = String(payload.ventaId ?? '').trim();
    const usuarioId = String(
      payload.usuarioId || ctxSesion.usuarioId || usuarioActivoIdMemoria || ''
    ).trim();
    const dispositivoId = String(payload.dispositivoId || 'movil-web-1').trim();
    const items = (payload.items as ItemPedidoMovilInput[]) ?? [];
    const pagos = (payload.pagos as PagoVentaInput[]) ?? [];
    const descuentoGlobal = Math.max(
      0,
      Math.round(Number(payload.descuentoGlobal ?? 0))
    );
    const clienteId = payload.clienteId ? String(payload.clienteId) : null;
    const cajaSesionId = payload.cajaSesionId
      ? String(payload.cajaSesionId)
      : null;

    const headersRpc = construirCabecerasSupabase(cfg);

    // Intento 1: Firma extendida de 9 parámetros
    let respRpc = await fetch(
      `${cfg.supabaseUrl}/rest/v1/rpc/crear_venta_movil`,
      {
        method: 'POST',
        headers: headersRpc,
        body: JSON.stringify({
          p_venta_id: ventaId,
          p_comercio_id: comercioId,
          p_usuario_id: usuarioId,
          p_dispositivo_id: dispositivoId,
          p_items: items,
          p_pagos: pagos,
          p_descuento_global: descuentoGlobal,
          p_cliente_id: clienteId,
          p_caja_sesion_id: cajaSesionId,
        }),
      }
    );

    // Intento 2: Si el esquema tiene la firma de 6 parámetros (PGRST202), usar 6 parámetros
    if (respRpc.status === 404) {
      const clonTexto = await respRpc.clone().text();
      if (clonTexto.includes('PGRST202')) {
        respRpc = await fetch(
          `${cfg.supabaseUrl}/rest/v1/rpc/crear_venta_movil`,
          {
            method: 'POST',
            headers: headersRpc,
            body: JSON.stringify({
              p_venta_id: ventaId,
              p_dispositivo_id: dispositivoId,
              p_items: items,
              p_pagos: pagos,
              p_descuento_global: descuentoGlobal,
              p_cliente_id: clienteId,
            }),
          }
        );
      }
    }

    if (!respRpc.ok) {
      throw new Error(await extraerMensajeErrorSupabase(respRpc));
    }

    const rpcData = (await respRpc.json()) as {
      idempotente?: boolean;
      venta_id?: string;
      fecha?: string;
      subtotal?: number;
      descuento?: number;
      total?: number;
      cajero_nombre?: string;
      comprobante_texto?: string;
      whatsapp_url?: string;
      items?: Array<{
        producto_id?: string;
        descripcion: string;
        cantidad: number;
        precio_unitario: number;
        descuento?: number;
        subtotal: number;
      }>;
    };

    const fechaFinal = rpcData.fecha || new Date().toISOString();
    const subtotalFinal = Number(rpcData.subtotal ?? 0);
    const descuentoFinal = Number(rpcData.descuento ?? descuentoGlobal);
    const totalFinal = Number(
      rpcData.total ?? Math.max(0, subtotalFinal - descuentoFinal)
    );

    let itemsComprobante = Array.isArray(rpcData.items)
      ? rpcData.items.map((it) => ({
          producto_id: it.producto_id ?? '',
          descripcion: it.descripcion,
          cantidad: Number(it.cantidad ?? 1),
          precio_unitario: Number(it.precio_unitario ?? 0),
          descuento: Number(it.descuento ?? 0),
          subtotal: Number(it.subtotal ?? 0),
        }))
      : [];

    if (itemsComprobante.length === 0) {
      const respItems = await fetch(
        `${cfg.supabaseUrl}/rest/v1/ventas_items?comercio_id=eq.${encodeURIComponent(comercioId)}&venta_id=eq.${encodeURIComponent(ventaId)}&select=producto_id,descripcion,cantidad,precio_unitario,descuento,subtotal`,
        { headers: headersRpc }
      );
      if (respItems.ok) {
        const rows = (await respItems.json()) as Array<{
          producto_id: string;
          descripcion: string;
          cantidad: number;
          precio_unitario: number;
          descuento: number;
          subtotal: number;
        }>;
        itemsComprobante = rows.map((r) => ({
          producto_id: r.producto_id,
          descripcion: r.descripcion,
          cantidad: Number(r.cantidad ?? 1),
          precio_unitario: Number(r.precio_unitario ?? 0),
          descuento: Number(r.descuento ?? 0),
          subtotal: Number(r.subtotal ?? 0),
        }));
      }
    }

    const comp = formatearComprobanteMovilWhatsApp({
      venta_id: ventaId,
      fecha_iso: fechaFinal,
      comercio_nombre:
        ctxSesion.comercioNombre || cfg.comercioNombre || 'Comercio POS',
      vendedor_nombre:
        rpcData.cajero_nombre || ctxSesion.usuarioNombre || 'Vendedor Móvil',
      items: itemsComprobante,
      subtotal: subtotalFinal,
      descuento: descuentoFinal,
      total: totalFinal,
      pagos,
    });

    return {
      idempotente: Boolean(rpcData.idempotente),
      venta_id: ventaId,
      fecha: fechaFinal,
      canal: 'web',
      subtotal: subtotalFinal,
      descuento: descuentoFinal,
      total: totalFinal,
      items: itemsComprobante,
      pagos,
      comprobante_texto: rpcData.comprobante_texto || comp.textoPlano,
      whatsapp_url: rpcData.whatsapp_url || comp.urlWhatsApp,
    } as unknown as T;
  }

  throw new Error(`Acción móvil no soportada en la nube: ${accion}`);
}

export async function invocarPosApi<T>(
  accion: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const payloadEfectivo =
    usuarioActivoIdMemoria && payload.usuarioActivoId === undefined
      ? { ...payload, usuarioActivoId: usuarioActivoIdMemoria }
      : payload;

  const esAccionMovil = ACCIONES_MOVILES_NUBE.has(accion);

  // Si estamos en un dominio estático en la nube (ej. *.netlify.app) y es una acción del Cajero Móvil,
  // hablar directamente con Supabase evitando el round-trip al fallback HTML de la SPA.
  if (esAccionMovil && esHostEstaticoNube()) {
    return ejecutarAccionMovilDirectoSupabase<T>(accion, payloadEfectivo);
  }

  let respuesta: Response;
  try {
    const tokenLocal = obtenerTokenSesionLocal();
    respuesta = await fetch('/api/pos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tokenLocal ? { 'X-POS-Session': tokenLocal } : {}),
      },
      body: JSON.stringify({ accion, payload: payloadEfectivo }),
    });
  } catch (err) {
    if (esAccionMovil) {
      return ejecutarAccionMovilDirectoSupabase<T>(accion, payloadEfectivo);
    }
    throw err;
  }

  const contentType = (
    respuesta.headers?.get?.('content-type') ?? ''
  ).toLowerCase();

  let json: { ok: true; data: T } | { ok: false; error: string } | null = null;

  if (typeof respuesta.text === 'function') {
    const textoRespuesta = (await respuesta.text()).trim();
    const pareceHtml =
      contentType.includes('text/html') ||
      textoRespuesta.startsWith('<!DOCTYPE') ||
      textoRespuesta.startsWith('<html');

    if (
      pareceHtml ||
      respuesta.status === 404 ||
      respuesta.status === 405 ||
      !textoRespuesta
    ) {
      if (esAccionMovil) {
        return ejecutarAccionMovilDirectoSupabase<T>(accion, payloadEfectivo);
      }
      throw new Error(
        'El servidor local (/api/pos) no está disponible en este entorno web estático.'
      );
    }

    try {
      json = JSON.parse(textoRespuesta) as
        | { ok: true; data: T }
        | { ok: false; error: string };
    } catch {
      if (esAccionMovil) {
        return ejecutarAccionMovilDirectoSupabase<T>(accion, payloadEfectivo);
      }
      throw new Error('Respuesta inválida del servidor local (/api/pos).');
    }
  } else if (typeof respuesta.json === 'function') {
    // Compatibilidad con mocks de tests unitarios que definen solo `json()` en el objeto Response simulado
    json = (await respuesta.json()) as
      | { ok: true; data: T }
      | { ok: false; error: string };
  }

  if (!json) {
    throw new Error('No se recibió respuesta del servidor.');
  }

  if (!json.ok) {
    throw new Error(json.error);
  }
  return json.data;
}
