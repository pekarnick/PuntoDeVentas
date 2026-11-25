/**
 * Servicio local de persistencia SQLite en disco (<raiz>/data/pos_local.db).
 * Conecta la interfaz React con los repositorios transaccionales reales de /src/db.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  generarClaveTemporal,
  hashearClaveArgon2id,
  validarPoliticaClave,
} from '../domain/claves.ts';
import { exigirPermiso, type RolUsuario } from '../domain/permisos.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import type { TipoMovimientoStock } from '../domain/stock.ts';
import type { AlicuotaIva, MedioPago } from '../domain/totales.ts';
import {
  abrirSesionCaja,
  calcularEstadoSesionCaja,
  cerrarSesionCaja,
  obtenerSesionCajaAbierta,
  registrarMovimientoManualCaja,
} from './caja_repo.ts';
import {
  exportarAuditoriaAXlsx,
  exportarInformeGestionFase1AXlsx,
  exportarPedidoReposicionBajoStockAPdf,
  exportarPedidoReposicionBajoStockAXlsx,
  obtenerInformeGestionFase1,
} from './informes_repo.ts';
import {
  actualizarSucursalComercio,
  crearSucursalComercio,
  listarSucursalesComercio,
  listarTransferenciasSucursales,
  obtenerMapaStockPorSucursalDb,
  obtenerSucursalActivaTerminal,
  seleccionarSucursalActivaTerminal,
  transferirProductosEntreSucursales,
} from './sucursales_repo.ts';
import type { CriterioAgrupacionPedido } from '../domain/pedidos_reposicion.ts';
import { aplicarMigraciones, crearBaseDatos } from './migrator.ts';
import {
  actualizarProductoYPrecio,
  agregarCodigoBarrasProducto,
  eliminarProductoLogico,
  obtenerDatosTicketDeVentaDb,
} from './productos_repo.ts';
import {
  actualizarRolOEstadoUsuario,
  crearProducto,
  crearUsuario,
  inicializarComercioYSuperadmin,
  registrarMovimientoStock,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from './repositorios.ts';
import {
  autenticarUsuarioOffline,
  cambiarClavePropia,
  consultarRegistrosAuditoria,
  establecerClaveUsuarioDirecta,
  listarUsuariosComercio,
  registrarLogoutUsuario,
  resetearClaveUsuario,
  verificarAutorizadorEnVivo,
} from './usuarios_auth_repo.ts';
import {
  AdaptadorFirebaseFirestoreHttp,
  AdaptadorNubeMultiProveedor,
  AdaptadorSupabaseHttp,
  NubeSinConfigurar,
  autenticarSupabaseEmailClave,
  copiarBaseCompletaAFirebaseSinDuplicados,
  ejecutarCicloSincronizacionCompleto,
  ejecutarPullDatos,
  ejecutarPushDatos,
  guardarConfiguracionSistema,
  guardarIdentidadComercioPersistida,
  leerIdentidadComercioPersistida,
  obtenerConfiguracionSistema,
  obtenerODefinirDeviceIdTerminal,
  obtenerResumenEstadoSyncDb,
  type AdaptadorNubeSupabase,
  type ProveedorNubeSync,
} from '../sync/motor_sync.ts';
import { autenticarFirebaseEmailClave } from '../sync/adaptador_firebase.ts';
import {
  calcularEspacioImagenesLocal,
  procesarColaSincronizacionImagenes,
  sincronizarColaLocalImagenesSubida,
} from '../sync/imagenes_sync.ts';
import { guardarImagenProductoLocal } from './imagenes_repo.ts';
import {
  crearBackupBaseDatosLocal,
  ejecutarBackupDiarioAutomaticoSiCorresponde,
  exportarTodoAExcel,
  listarHistorialBackups,
  resetearBaseDatosAFabrica,
  restaurarDesdeBackupLocal,
} from './backup_repo.ts';
import {
  aplicarActualizacionMasivaPrecios,
  crearCategoria,
  crearCliente,
  crearMarca,
  crearProveedor,
  exportarLibroIvaAXlsx,
  generarTicketEscPosDeVentaDb,
  importarProductosDesdeCsv,
  listarCategorias,
  listarClientesConSaldo,
  listarComprasRecientes,
  listarMarcas,
  listarMovimientosCuentaCorriente,
  listarProveedoresConSaldo,
  obtenerLibroIvaPeriodo,
  registrarCompraProveedor,
  registrarMovimientoCuentaCorriente,
} from './gestion_fase3_repo.ts';
import type { ReglaRedondeoPrecio } from '../domain/gestion_fase3.ts';
import type { CondicionIvaReceptor } from '../domain/cuit.ts';
import {
  abrirCajaMovilUsuario,
  actualizarPermisoVentaMovilUsuario,
  cerrarCajaMovilUsuario,
  configurarVentaMovilComercio,
  crearVentaMovilServidor,
  iniciarSesionMovil,
  listarVentasPropiasDelDiaMovil,
  obtenerCatalogoVentaMovil,
  obtenerConfigVentaMovil,
  obtenerConfiguracionNetlify,
  guardarConfiguracionNetlify,
  registrarDespliegueNetlifyExitoso,
  obtenerEstadoCajaMovilUsuario,
  revocarSesionMovil,
  validarYRenovarSesionMovil,
} from './venta_movil_repo.ts';
import {
  desplegarSitioNetlify,
  prepararPaqueteVentaMovilNetlify,
  verificarTokenNetlifyApi,
} from '../sync/desplegador_netlify.ts';
import {
  AdaptadorArcaHomologacionLocal,
  AdaptadorEdgeFunctionArcaHttp,
  anularVentaConNotaCreditoArca,
  asignarPrecioProductoEnLista,
  crearComboPromocion,
  crearListaPrecio,
  crearVarianteProducto,
  eliminarComboPromocion,
  emitirComprobanteArcaVenta,
  guardarConfiguracionArca,
  listarCombosComercio,
  listarListasPrecio,
  listarVariantesComercio,
  obtenerComprobanteFiscalImprimibleDb,
  obtenerConfiguracionArca,
  obtenerInformeComprobantesArca,
  reintentarComprobantesArcaPendientes,
  resolverEscaneoBalanzaEnCatalogo,
  venderComboPromocion,
  type AdaptadorServicioArca,
} from './arca_fase4_repo.ts';
import type {
  AmbienteArca,
  CondicionIva,
  EstadoFacturacionArca,
  ItemPedidoMovilInput,
  PagoVentaInput,
  ProveedorArca,
} from '../../packages/domain/src/index.ts';

export const RUTA_DB_POR_DEFECTO = process.env.POS_DATA_DIR?.trim()
  ? path.resolve(process.env.POS_DATA_DIR.trim(), 'pos_local.db')
  : path.resolve(process.cwd(), 'data', 'pos_local.db');

let instanciaDb: DatabaseSync | null = null;
let rutaActivaDb: string = RUTA_DB_POR_DEFECTO;
const nubeSinConfigurar = new NubeSinConfigurar();

interface SesionOperadorLocal {
  readonly token: string;
  readonly comercioId: string;
  readonly usuarioId: string;
  readonly expiraAtMs: number;
}

const DURACION_SESION_LOCAL_MS = 8 * 60 * 60 * 1000;
const sesionesOperadoresLocales = new Map<string, SesionOperadorLocal>();

const sesionesNubeMemoria: {
  supabaseAccessToken: string | null;
  supabaseEmail: string | null;
  firebaseIdToken: string | null;
  firebaseEmail: string | null;
} = {
  supabaseAccessToken: null,
  supabaseEmail: null,
  firebaseIdToken: null,
  firebaseEmail: null,
};

export function validarTokenSesionLocal(
  token: string | undefined | null
): SesionOperadorLocal | null {
  if (!token || !token.trim()) return null;
  const s = sesionesOperadoresLocales.get(token.trim());
  if (!s) return null;
  if (Date.now() > s.expiraAtMs) {
    sesionesOperadoresLocales.delete(s.token);
    return null;
  }
  return s;
}

export function limpiarSesionesLocalesParaTest(): void {
  sesionesOperadoresLocales.clear();
  sesionesNubeMemoria.supabaseAccessToken = null;
  sesionesNubeMemoria.supabaseEmail = null;
  sesionesNubeMemoria.firebaseIdToken = null;
  sesionesNubeMemoria.firebaseEmail = null;
}

export function cerrarConexionLocalDisco(): void {
  if (instanciaDb) {
    try {
      instanciaDb.close();
    } catch {
      // Ignorar si ya estaba cerrada
    }
    instanciaDb = null;
    rutaActivaDb = RUTA_DB_POR_DEFECTO;
  }
}

function crearSesionOperadorLocal(
  comercioId: string,
  usuarioId: string
): SesionOperadorLocal {
  const token = crypto.randomBytes(32).toString('hex');
  const sesion: SesionOperadorLocal = {
    token,
    comercioId,
    usuarioId,
    expiraAtMs: Date.now() + DURACION_SESION_LOCAL_MS,
  };
  sesionesOperadoresLocales.set(token, sesion);
  return sesion;
}

function sincronizarWalADisco(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // Si hay una lectura simultánea, el próximo ciclo volcará el WAL
  }
}

function resolverAdaptadorSync(
  db: DatabaseSync,
  comercioId: string
): AdaptadorNubeSupabase {
  const cfg = obtenerConfiguracionSistema(db, comercioId);
  const tieneSupabase = Boolean(cfg.supabase_url && cfg.supabase_anon_key);
  const tieneFirebase = Boolean(cfg.firebase_project_id && cfg.firebase_api_key);

  const adaptadorSupabase = tieneSupabase
    ? new AdaptadorSupabaseHttp({
        supabaseUrl: cfg.supabase_url!,
        supabaseAnonKey: cfg.supabase_anon_key!,
        accessToken: sesionesNubeMemoria.supabaseAccessToken ?? undefined,
        comercioId,
      })
    : null;

  const adaptadorFirebase = tieneFirebase
    ? new AdaptadorFirebaseFirestoreHttp(
        cfg.firebase_project_id!,
        cfg.firebase_api_key!,
        sesionesNubeMemoria.firebaseIdToken ?? undefined
      )
    : null;

  if (cfg.proveedor_nube === 'firebase') {
    return adaptadorFirebase ?? adaptadorSupabase ?? nubeSinConfigurar;
  }
  if (cfg.proveedor_nube === 'ambos') {
    if (adaptadorSupabase && adaptadorFirebase) {
      return new AdaptadorNubeMultiProveedor(
        adaptadorSupabase,
        adaptadorFirebase
      );
    }
    return adaptadorSupabase ?? adaptadorFirebase ?? nubeSinConfigurar;
  }
  return adaptadorSupabase ?? adaptadorFirebase ?? nubeSinConfigurar;
}

function resolverAdaptadorArca(
  db: DatabaseSync,
  comercioId: string,
  sinConexion: boolean
): AdaptadorServicioArca {
  const cfgArca = obtenerConfiguracionArca(db, comercioId);
  if (cfgArca.arca_ambiente === 'produccion') {
    const cfgSync = obtenerConfiguracionSistema(db, comercioId);
    if (!cfgSync.supabase_url || !cfgSync.supabase_anon_key) {
      throw new Error(
        'ARCA_CONFIG_INCOMPLETA: Para emitir en producción configurá la URL y Anon Key de Supabase e iniciá sesión en la nube.'
      );
    }
    if (!sesionesNubeMemoria.supabaseAccessToken) {
      throw new Error(
        'ARCA_SESION_NUBE_REQUERIDA: Para emitir comprobantes ARCA en producción debés iniciar sesión en Supabase Auth desde Configuración.'
      );
    }
    return new AdaptadorEdgeFunctionArcaHttp({
      supabaseUrl: cfgSync.supabase_url,
      supabaseAnonKey: cfgSync.supabase_anon_key,
      accessToken: sesionesNubeMemoria.supabaseAccessToken,
    });
  }
  const adaptadorLocal = new AdaptadorArcaHomologacionLocal();
  if (sinConexion) {
    adaptadorLocal.fijarConectado(false);
  }
  return adaptadorLocal;
}

export function obtenerConexionLocalDisco(
  rutaPersonalizada: string = RUTA_DB_POR_DEFECTO
): DatabaseSync {
  if (instanciaDb && rutaActivaDb === rutaPersonalizada) {
    aplicarMigraciones(instanciaDb);
    limpiarProductosDemoResiduales(instanciaDb);
    sincronizarWalADisco(instanciaDb);
    return instanciaDb;
  }

  const directorio = path.dirname(rutaPersonalizada);
  fs.mkdirSync(directorio, { recursive: true });

  const db = crearBaseDatos(rutaPersonalizada);
  asegurarDatosInicialesSiVacia(db, directorio);
  limpiarProductosDemoResiduales(db);
  sincronizarWalADisco(db);

  instanciaDb = db;
  rutaActivaDb = rutaPersonalizada;
  return db;
}

const CODIGOS_DEMO_SEMILLA = [
  'YER-001',
  'ALF-003',
  'PAN-KG',
  'GAS-225',
  'BOL-01',
] as const;

function limpiarProductosDemoResiduales(db: DatabaseSync): void {
  const placeholders = CODIGOS_DEMO_SEMILLA.map(() => '?').join(', ');
  const existentes = db
    .prepare(
      `SELECT id FROM productos
       WHERE codigo_interno IN (${placeholders}) AND deleted_at IS NULL`
    )
    .all(...CODIGOS_DEMO_SEMILLA) as unknown as { id: string }[];

  if (existentes.length === 0) return;

  const ahora = new Date().toISOString();
  for (const prod of existentes) {
    db.prepare(
      `UPDATE productos
       SET activo = 0, deleted_at = ?, updated_at = ?, sync_status = 'pendiente'
       WHERE id = ?`
    ).run(ahora, ahora, prod.id);
    db.prepare(
      `UPDATE codigos_barras
       SET deleted_at = ?, updated_at = ?, sync_status = 'pendiente'
       WHERE producto_id = ? AND deleted_at IS NULL`
    ).run(ahora, ahora, prod.id);
  }
}

function asegurarDatosInicialesSiVacia(
  _db: DatabaseSync,
  _directorioBaseDatos: string = path.dirname(RUTA_DB_POR_DEFECTO)
): void {
  // No se crean usuarios ni contraseñas por defecto hardcodeadas (Auditoría P0).
  // El primer superadmin se crea mediante el Asistente de Primer Uso (`inicializar_primer_superadmin`).
}

function obtenerComercioActivoId(db: DatabaseSync): string | null {
  const comercio = db
    .prepare('SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1')
    .get() as { id: string } | undefined;
  return comercio?.id ?? null;
}

function tieneSuperadminActivo(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM usuarios
       WHERE rol = 'superadmin' AND activo = 1 AND deleted_at IS NULL`
    )
    .get() as { total: number } | undefined;
  return Number(row?.total ?? 0) > 0;
}

function resolverActorDesdeSesion(
  db: DatabaseSync,
  sesion: SesionOperadorLocal,
  rolDemoSolicitado?: RolUsuario
): { actor: ActorContexto; rolReal: RolUsuario } {
  const usuario = db
    .prepare(
      `SELECT id, comercio_id, nombre, rol, activo
       FROM usuarios
       WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(sesion.usuarioId, sesion.comercioId) as
    | {
        id: string;
        comercio_id: string;
        nombre: string;
        rol: RolUsuario;
        activo: number;
      }
    | undefined;

  if (!usuario || usuario.activo !== 1) {
    sesionesOperadoresLocales.delete(sesion.token);
    throw new Error(
      'SESION_NO_AUTENTICADA: La cuenta fue desactivada o ya no existe.'
    );
  }

  // Solo un superadmin real puede previsualizar un rol inferior (encargado/cajero)
  const rolEfectivo: RolUsuario =
    usuario.rol === 'superadmin' &&
    (rolDemoSolicitado === 'encargado' || rolDemoSolicitado === 'cajero')
      ? rolDemoSolicitado
      : usuario.rol;

  return {
    rolReal: usuario.rol,
    actor: {
      comercio_id: usuario.comercio_id,
      usuario_id: usuario.id,
      usuario_nombre: usuario.nombre,
      rol: rolEfectivo,
      device_id: obtenerODefinirDeviceIdTerminal(path.dirname(rutaActivaDb)),
    },
  };
}

function obtenerCatalogoCompleto(db: DatabaseSync, actor: ActorContexto) {
  const incluirCostos = actor.rol === 'superadmin' || actor.rol === 'encargado';

  const filas = db
    .prepare(
      `SELECT
        p.id,
        p.nombre,
        p.codigo_interno,
        p.categoria_id,
        p.marca_id,
        p.proveedor_principal_id AS proveedor_id,
        c.nombre AS categoria_nombre,
        m.nombre AS marca_nombre,
        pr.nombre AS proveedor_nombre,
        p.unidad,
        p.permite_decimales,
        p.costo_compra,
        p.alicuota_iva,
        p.exento_iva,
        p.stock_minimo,
        p.boton_rapido,
        p.imagen_path,
        p.imagen_hash,
        COALESCE(v.precio_venta, 0) AS precio_venta,
        COALESCE(s.stock_actual, 0) AS stock_actual
       FROM productos p
       LEFT JOIN categorias c ON c.id = p.categoria_id AND c.deleted_at IS NULL
       LEFT JOIN marcas m ON m.id = p.marca_id AND m.deleted_at IS NULL
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_principal_id AND pr.deleted_at IS NULL
       LEFT JOIN vista_productos_venta v
         ON v.id = p.id AND v.comercio_id = p.comercio_id
       LEFT JOIN vista_stock_actual s
         ON s.producto_id = p.id AND s.comercio_id = p.comercio_id
       WHERE p.comercio_id = ? AND p.deleted_at IS NULL AND p.activo = 1
       ORDER BY p.nombre ASC`
    )
    .all(actor.comercio_id) as unknown as Array<{
    id: string;
    nombre: string;
    codigo_interno: string | null;
    categoria_id: string | null;
    marca_id: string | null;
    proveedor_id: string | null;
    categoria_nombre: string | null;
    marca_nombre: string | null;
    proveedor_nombre: string | null;
    unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
    permite_decimales: number;
    costo_compra: number;
    alicuota_iva: AlicuotaIva;
    exento_iva: number;
    stock_minimo: number;
    boton_rapido: number;
    imagen_path: string | null;
    imagen_hash: string | null;
    precio_venta: number;
    stock_actual: number;
  }>;

  const codigosRows = db
    .prepare(
      `SELECT producto_id, codigo
       FROM codigos_barras
       WHERE comercio_id = ? AND deleted_at IS NULL`
    )
    .all(actor.comercio_id) as unknown as Array<{
    producto_id: string;
    codigo: string;
  }>;

  const mapaCodigos = new Map<string, string[]>();
  for (const r of codigosRows) {
    const arr = mapaCodigos.get(r.producto_id) ?? [];
    arr.push(r.codigo);
    mapaCodigos.set(r.producto_id, arr);
  }

  // Mapa de stock detallado por sucursal (Regla 4)
  const { mapaPorProducto } = obtenerMapaStockPorSucursalDb(
    db,
    actor.comercio_id,
    actor.device_id
  );
  const sucursalActiva = obtenerSucursalActivaTerminal(
    db,
    actor.comercio_id,
    actor.device_id
  );

  // Catálogo para pantalla de venta: NUNCA incluye costo_compra (Regla 20)
  const catalogoVenta = filas.map((f) => ({
    id: f.id,
    nombre: f.nombre,
    codigo_interno: f.codigo_interno,
    codigos_barras: mapaCodigos.get(f.id) ?? [],
    unidad: f.unidad,
    permite_decimales: f.permite_decimales === 1,
    precio_venta: f.precio_venta,
    alicuota_iva: f.alicuota_iva,
    exento_iva: f.exento_iva === 1,
    boton_rapido: f.boton_rapido === 1,
    imagen_path: f.imagen_path,
    stock_actual: f.stock_actual,
    stock_minimo: f.stock_minimo,
  }));

  // Catálogo de administración: incluye costo_compra solo si el rol tiene permiso
  const catalogoAdmin = filas.map((f) => {
    const resSuc = mapaPorProducto.get(f.id);
    return {
      id: f.id,
      nombre: f.nombre,
      codigo_interno: f.codigo_interno ?? '',
      categoria_id: f.categoria_id,
      marca_id: f.marca_id,
      proveedor_id: f.proveedor_id,
      categoria_nombre: f.categoria_nombre,
      marca_nombre: f.marca_nombre,
      proveedor_nombre: f.proveedor_nombre,
      codigos_barras: mapaCodigos.get(f.id) ?? [],
      unidad: f.unidad,
      permite_decimales: f.permite_decimales === 1,
      ...(incluirCostos ? { costo_compra: f.costo_compra } : {}),
      precio_venta: f.precio_venta,
      stock_minimo: f.stock_minimo,
      stock_actual: f.stock_actual,
      stock_por_sucursal: resSuc?.por_sucursal ?? {},
      stock_sucursal_activa:
        resSuc?.por_sucursal[sucursalActiva.id] ?? f.stock_actual,
      boton_rapido: f.boton_rapido === 1,
      imagen_path: f.imagen_path,
      imagen_hash: f.imagen_hash,
    };
  });

  return { catalogoVenta, catalogoAdmin };
}

function extraerBufferDesdeBase64(imagenBase64: string): Buffer {
  const limpio = imagenBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').trim();
  return Buffer.from(limpio, 'base64');
}

export interface ContextoHttpLocal {
  readonly sessionToken?: string;
}

const ACCIONES_PUBLICAS_SIN_SESION_ESCRITORIO = new Set([
  'obtener_estado_arranque',
  'inicializar_primer_superadmin',
  'iniciar_sesion_operador',
  'login_movil',
  'obtener_catalogo_movil',
  'crear_venta_movil',
  'estado_caja_movil',
  'abrir_caja_movil',
  'cerrar_caja_movil',
  'listar_ventas_movil_dia',
]);

/**
 * Ejecuta una acción RPC solicitada por el frontend contra la base SQLite local en disco.
 */
export function ejecutarAccionPosLocal(
  accion: string,
  payload: Record<string, unknown> = {},
  rutaDb: string = RUTA_DB_POR_DEFECTO,
  contextoHttp?: ContextoHttpLocal
): unknown {
  const db = obtenerConexionLocalDisco(rutaDb);

  if (accion === 'obtener_estado_arranque') {
    const comercio = db
      .prepare('SELECT id, nombre FROM comercios WHERE deleted_at IS NULL LIMIT 1')
      .get() as { id: string; nombre: string } | undefined;
    return {
      requiereConfiguracionInicial: !comercio || !tieneSuperadminActivo(db),
      rutaBaseDatos: rutaActivaDb,
      comercioNombre: comercio?.nombre ?? null,
    };
  }

  if (accion === 'inicializar_primer_superadmin') {
    if (tieneSuperadminActivo(db)) {
      throw new Error(
        'SISTEMA_YA_INICIALIZADO: Ya existe un administrador activo en la base de datos.'
      );
    }

    const nombreComercio = String(payload.nombreComercio ?? '').trim();
    const cuit = String(payload.cuit ?? '').trim() || null;
    const condicionIvaRaw = String(payload.condicionIva ?? 'monotributo');
    const condicionIva: 'monotributo' | 'responsable_inscripto' | 'exento' =
      condicionIvaRaw === 'responsable_inscripto' || condicionIvaRaw === 'exento'
        ? condicionIvaRaw
        : 'monotributo';
    const nombreAdmin = String(payload.nombreAdmin ?? '').trim();
    const usuarioAdmin = String(payload.usuarioAdmin ?? '').trim();
    const claveAdmin = String(payload.claveAdmin ?? '');

    if (!nombreComercio || !nombreAdmin || !usuarioAdmin) {
      throw new Error(
        'Completá el nombre del comercio, tu nombre y el usuario administrador.'
      );
    }
    validarPoliticaClave(claveAdmin);

    const dirBase = path.dirname(rutaActivaDb);
    const persistida = leerIdentidadComercioPersistida(dirBase);
    const comercioExistente = obtenerComercioActivoId(db);
    const claveHash = hashearClaveArgon2id(claveAdmin);

    let comercioIdFinal: string;
    let superadminIdFinal: string;

    if (comercioExistente) {
      comercioIdFinal = comercioExistente;
      superadminIdFinal = generarUuidV7();
      const ahoraIso = new Date().toISOString();
      const deviceIdTerminal = obtenerODefinirDeviceIdTerminal(
        path.dirname(rutaActivaDb)
      );
      db.prepare(
        `INSERT INTO usuarios (
          id, comercio_id, nombre, usuario, clave_hash, rol,
          puede_vender_movil, activo, debe_cambiar_clave,
          created_at, updated_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, 'superadmin', 1, 1, 0, ?, ?, ?, 'pendiente')`
      ).run(
        superadminIdFinal,
        comercioIdFinal,
        nombreAdmin,
        usuarioAdmin,
        claveHash,
        ahoraIso,
        ahoraIso,
        deviceIdTerminal
      );
    } else {
      const creado = inicializarComercioYSuperadmin(db, {
        comercioId: persistida?.comercio_id ?? generarUuidV7(),
        superadminId: generarUuidV7(),
        listaPrecioId: persistida?.lista_precio_id ?? generarUuidV7(),
        nombreComercio,
        cuit: cuit ?? undefined,
        condicionIva,
        nombreAdmin,
        usuarioAdmin,
        claveHashAdmin: claveHash,
        deviceId: obtenerODefinirDeviceIdTerminal(path.dirname(rutaActivaDb)),
      });
      comercioIdFinal = creado.comercioId;
      superadminIdFinal = creado.superadminId;
      db.prepare(
        `UPDATE usuarios SET debe_cambiar_clave = 0 WHERE id = ? AND comercio_id = ?`
      ).run(superadminIdFinal, comercioIdFinal);
    }

    sincronizarWalADisco(db);
    const sesion = crearSesionOperadorLocal(comercioIdFinal, superadminIdFinal);
    return {
      sessionToken: sesion.token,
      operadorActual: {
        id: superadminIdFinal,
        nombre: nombreAdmin,
        usuario: usuarioAdmin,
        rol: 'superadmin' as RolUsuario,
        debe_cambiar_clave: false,
      },
    };
  }

  let actor!: ActorContexto;
  let rolReal: RolUsuario = 'cajero';

  if (!ACCIONES_PUBLICAS_SIN_SESION_ESCRITORIO.has(accion)) {
    const sesion = validarTokenSesionLocal(contextoHttp?.sessionToken);
    if (!sesion) {
      throw new Error(
        'SESION_NO_AUTENTICADA: Debés iniciar sesión para realizar esta operación.'
      );
    }
    const rolDemo = payload.rolDemo as RolUsuario | undefined;
    const resuelto = resolverActorDesdeSesion(db, sesion, rolDemo);
    actor = resuelto.actor;
    rolReal = resuelto.rolReal;
  }

  switch (accion) {
    case 'obtener_estado_inicial': {
      const dirBase = path.dirname(rutaActivaDb);
      if (actor.rol === 'superadmin') {
        try {
          ejecutarBackupDiarioAutomaticoSiCorresponde(
            db,
            actor,
            dirBase
          );
        } catch {
          // Un fallo de permisos en la carpeta de backups no debe bloquear nunca la caja
        }
      }

      const { catalogoVenta, catalogoAdmin } = obtenerCatalogoCompleto(db, actor);
      const estadoSync = obtenerResumenEstadoSyncDb(
        db,
        actor.comercio_id,
        Boolean(payload.sinConexion)
      );

      const ventasRecientes = db
        .prepare(
          `SELECT
            v.id, v.fecha, v.total, v.estado, v.motivo_anulacion,
            v.tipo_comprobante, v.punto_venta, v.numero_comprobante,
            v.cae, v.cae_vencimiento, v.estado_facturacion,
            v.nota_credito_tipo, v.nota_credito_cae,
            u.nombre AS cajero_nombre,
            au.nombre AS autorizada_por_nombre
           FROM ventas v
           INNER JOIN usuarios u ON u.id = v.usuario_id
           LEFT JOIN usuarios au ON au.id = v.autorizada_por_id
           WHERE v.comercio_id = ? AND v.deleted_at IS NULL
           ORDER BY v.fecha DESC
           LIMIT 200`
        )
        .all(actor.comercio_id) as unknown as Array<{
        id: string;
        fecha: string;
        total: number;
        estado: 'completada' | 'anulada';
        motivo_anulacion: string | null;
        tipo_comprobante: string;
        punto_venta: number | null;
        numero_comprobante: number | null;
        cae: string | null;
        cae_vencimiento: string | null;
        estado_facturacion: string;
        nota_credito_tipo: string | null;
        nota_credito_cae: string | null;
        cajero_nombre: string;
        autorizada_por_nombre: string | null;
      }>;

      // Buscar cualquier sesión de caja abierta en el comercio (o la última cerrada)
      const sesionAbierta = db
        .prepare(
          `SELECT id FROM caja_sesiones
           WHERE comercio_id = ? AND estado = 'abierta' AND deleted_at IS NULL
           ORDER BY fecha_apertura DESC LIMIT 1`
        )
        .get(actor.comercio_id) as { id: string } | undefined;

      const ultimaSesion =
        sesionAbierta ??
        (db
          .prepare(
            `SELECT id FROM caja_sesiones
             WHERE comercio_id = ? AND deleted_at IS NULL
             ORDER BY fecha_apertura DESC LIMIT 1`
          )
          .get(actor.comercio_id) as { id: string } | undefined);

      const estadoCaja = ultimaSesion
        ? calcularEstadoSesionCaja(db, actor.comercio_id, ultimaSesion.id, 0)
        : null;

      const esEncargadoOSuper =
        actor.rol === 'superadmin' || actor.rol === 'encargado';

      const usuariosOperadores = db
        .prepare(
          `SELECT id, nombre, usuario, rol
           FROM usuarios
           WHERE comercio_id = ? AND activo = 1 AND deleted_at IS NULL
           ORDER BY CASE rol WHEN 'superadmin' THEN 1 WHEN 'encargado' THEN 2 ELSE 3 END, nombre ASC`
        )
        .all(actor.comercio_id) as unknown as Array<{
        id: string;
        nombre: string;
        usuario: string;
        rol: RolUsuario;
      }>;

      return {
        rutaBaseDatos: rutaActivaDb,
        comercioId: actor.comercio_id,
        operadorActual: {
          id: actor.usuario_id,
          nombre: actor.usuario_nombre,
          rol: actor.rol,
        },
        usuariosOperadores,
        cambiosPendientesSync: estadoSync.totalPendientes,
        estadoSync,
        configuracionSistema:
          actor.rol === 'superadmin'
            ? obtenerConfiguracionSistema(db, actor.comercio_id)
            : null,
        configVentaMovil:
          actor.rol === 'superadmin'
            ? obtenerConfigVentaMovil(db, actor.comercio_id)
            : null,
        configArca: obtenerConfiguracionArca(db, actor.comercio_id),
        listasPrecio: listarListasPrecio(db, actor.comercio_id),
        variantes: listarVariantesComercio(db, actor.comercio_id),
        combos: listarCombosComercio(db, actor.comercio_id),
        historialBackups:
          actor.rol === 'superadmin'
            ? listarHistorialBackups(db, actor.comercio_id)
            : [],
        espacioImagenes: calcularEspacioImagenesLocal(dirBase),
        catalogoVenta,
        catalogoAdmin,
        ventasRecientes,
        estadoCaja,
        sucursales: listarSucursalesComercio(
          db,
          actor.comercio_id,
          actor.device_id
        ),
        sucursalActiva: obtenerSucursalActivaTerminal(
          db,
          actor.comercio_id,
          actor.device_id
        ),
        transferenciasSucursales: listarTransferenciasSucursales(
          db,
          actor.comercio_id
        ),
        categorias: listarCategorias(db, actor.comercio_id),
        marcas: listarMarcas(db, actor.comercio_id),
        proveedores: esEncargadoOSuper
          ? listarProveedoresConSaldo(db, actor.comercio_id)
          : [],
        comprasRecientes: esEncargadoOSuper
          ? listarComprasRecientes(db, actor)
          : [],
        clientes: listarClientesConSaldo(db, actor.comercio_id),
      };
    }

    case 'crear_producto': {
      const productoId = crearProducto(db, actor, {
        nombre: String(payload.nombre ?? ''),
        codigoInterno: payload.codigoInterno
          ? String(payload.codigoInterno)
          : undefined,
        categoriaId: payload.categoriaId ? String(payload.categoriaId) : null,
        marcaId: payload.marcaId ? String(payload.marcaId) : null,
        proveedorId: payload.proveedorId ? String(payload.proveedorId) : null,
        unidad:
          (payload.unidad as 'unidad' | 'kg' | 'm' | 'l' | 'caja' | undefined) ??
          'unidad',
        permiteDecimales: Boolean(payload.permiteDecimales),
        costoCompraCentavos: Number(payload.costoCompraCentavos ?? 0),
        precioVentaCentavos: Number(payload.precioVentaCentavos ?? 0),
        alicuotaIva: (payload.alicuotaIva as AlicuotaIva | undefined) ?? 21,
        stockMinimo: Number(payload.stockMinimo ?? 0),
        botonRapido: Boolean(payload.botonRapido),
        codigosBarras: Array.isArray(payload.codigosBarras)
          ? (payload.codigosBarras as string[])
          : [],
        stockInicial: Number(payload.stockInicial ?? 0),
      });

      if (
        typeof payload.imagenBase64 === 'string' &&
        payload.imagenBase64.trim().length > 0
      ) {
        const dirBase = path.dirname(rutaActivaDb);
        const entradaBuffer = extraerBufferDesdeBase64(payload.imagenBase64);
        return guardarImagenProductoLocal(db, actor, {
          productoId,
          entradaBuffer,
          nombreArchivoOriginal: payload.nombreArchivoImagen
            ? String(payload.nombreArchivoImagen)
            : undefined,
          directorioBase: dirBase,
        }).then((resImg) => {
          sincronizarColaLocalImagenesSubida(db, actor.comercio_id);
          return { productoId, imagen: resImg };
        });
      }

      return { productoId };
    }

    case 'actualizar_producto': {
      const productoId = String(payload.productoId);
      actualizarProductoYPrecio(db, actor, {
        productoId,
        nombre: payload.nombre !== undefined ? String(payload.nombre) : undefined,
        costoCompraCentavos:
          payload.costoCompraCentavos !== undefined
            ? Number(payload.costoCompraCentavos)
            : undefined,
        precioVentaCentavos:
          payload.precioVentaCentavos !== undefined
            ? Number(payload.precioVentaCentavos)
            : undefined,
        stockMinimo:
          payload.stockMinimo !== undefined
            ? Number(payload.stockMinimo)
            : undefined,
        botonRapido:
          payload.botonRapido !== undefined
            ? Boolean(payload.botonRapido)
            : undefined,
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });

      if (
        typeof payload.imagenBase64 === 'string' &&
        payload.imagenBase64.trim().length > 0
      ) {
        const dirBase = path.dirname(rutaActivaDb);
        const entradaBuffer = extraerBufferDesdeBase64(payload.imagenBase64);
        return guardarImagenProductoLocal(db, actor, {
          productoId,
          entradaBuffer,
          nombreArchivoOriginal: payload.nombreArchivoImagen
            ? String(payload.nombreArchivoImagen)
            : undefined,
          directorioBase: dirBase,
        }).then((resImg) => {
          sincronizarColaLocalImagenesSubida(db, actor.comercio_id);
          return { ok: true, imagen: resImg };
        });
      }

      return { ok: true };
    }

    case 'subir_imagen_producto': {
      const productoId = String(payload.productoId ?? '').trim();
      const imagenBase64 = String(payload.imagenBase64 ?? '').trim();
      if (!productoId || !imagenBase64) {
        throw new Error('Se requiere el producto y el archivo de imagen.');
      }
      const dirBase = path.dirname(rutaActivaDb);
      const entradaBuffer = extraerBufferDesdeBase64(imagenBase64);
      return guardarImagenProductoLocal(db, actor, {
        productoId,
        entradaBuffer,
        nombreArchivoOriginal: payload.nombreArchivoImagen
          ? String(payload.nombreArchivoImagen)
          : undefined,
        directorioBase: dirBase,
      }).then((resImg) => {
        sincronizarColaLocalImagenesSubida(db, actor.comercio_id);
        return resImg;
      });
    }

    case 'agregar_codigo_barras': {
      const id = agregarCodigoBarrasProducto(db, actor, {
        productoId: String(payload.productoId),
        codigo: String(payload.codigo),
      });
      return { id };
    }

    case 'eliminar_producto_logico': {
      eliminarProductoLogico(db, actor, {
        productoId: String(payload.productoId),
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      return { ok: true };
    }

    case 'registrar_movimiento_stock': {
      const movId = registrarMovimientoStock(db, actor, {
        productoId: String(payload.productoId),
        tipo: payload.tipo as TipoMovimientoStock,
        cantidad: Number(payload.cantidad),
        costoUnitarioCentavos:
          payload.costoUnitarioCentavos !== undefined
            ? Number(payload.costoUnitarioCentavos)
            : undefined,
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      return { movId };
    }

    case 'registrar_venta': {
      const sesionAbierta = db
        .prepare(
          `SELECT id FROM caja_sesiones
           WHERE comercio_id = ? AND estado = 'abierta' AND deleted_at IS NULL
           ORDER BY fecha_apertura DESC LIMIT 1`
        )
        .get(actor.comercio_id) as { id: string } | undefined;

      const items = (
        payload.items as Array<{
          productoId: string;
          cantidad: number;
          descuentoCentavos?: number;
          varianteId?: string;
        }>
      ).map((it) => ({
        productoId: String(it.productoId),
        cantidad: Number(it.cantidad),
        descuentoCentavos: Number(it.descuentoCentavos ?? 0),
        varianteId: it.varianteId ? String(it.varianteId) : undefined,
      }));

      const pagos = (
        payload.pagos as Array<{ medio: MedioPago; monto: number }>
      ).map((p) => ({
        medio: p.medio,
        monto: Number(p.monto),
      }));

      const resultado = registrarVenta(db, actor, {
        items,
        descuentoGlobalCentavos: Number(payload.descuentoGlobalCentavos ?? 0),
        pagos,
        clienteId: payload.clienteId ? String(payload.clienteId) : undefined,
        cajaSesionId: sesionAbierta?.id,
        listaPrecioId: payload.listaPrecioId
          ? String(payload.listaPrecioId)
          : undefined,
      });

      const adaptadorArca = resolverAdaptadorArca(
        db,
        actor.comercio_id,
        Boolean(payload.sinConexion)
      );
      if (resultado.estadoFacturacion === 'pendiente' && !payload.diferirEmisionArca) {
        void emitirComprobanteArcaVenta(
          db,
          actor,
          resultado.ventaId,
          adaptadorArca
        );
      }

      const datosTicket = obtenerDatosTicketDeVentaDb(
        db,
        actor.comercio_id,
        resultado.ventaId
      );

      return {
        ...resultado,
        datosTicket,
      };
    }

    case 'anular_venta': {
      let autorizador:
        | { usuario_id: string; usuario_nombre: string; rol: RolUsuario }
        | undefined;

      if (actor.rol === 'cajero') {
        const autUsuario = String(payload.autorizadorUsuario ?? '').trim();
        const autClave = String(payload.autorizadorClave ?? '');
        if (!autUsuario || !autClave) {
          throw new Error(
            'AUTORIZACION_INVALIDA: Para anular una venta como cajero debés ingresar el usuario y la clave de un encargado o superadmin.'
          );
        }
        const verificado = verificarAutorizadorEnVivo(db, {
          comercioId: actor.comercio_id,
          usuarioAutorizador: autUsuario,
          claveAutorizador: autClave,
          deviceId: actor.device_id,
        });
        if (verificado.usuario_id === actor.usuario_id) {
          throw new Error(
            'AUTORIZACION_INVALIDA: Un cajero no puede auto-autorizarse una anulación.'
          );
        }
        autorizador = verificado;
      }

      void anularVentaConNotaCreditoArca(db, actor, {
        ventaId: String(payload.ventaId),
        motivo: String(payload.motivo ?? ''),
        autorizador,
      });

      return { ok: true };
    }

    case 'abrir_caja': {
      // Cerrar cualquier sesión previa abierta del mismo usuario si existiera
      const abierta = obtenerSesionCajaAbierta(
        db,
        actor.comercio_id,
        actor.usuario_id
      );
      if (abierta) {
        return { sesionId: abierta.id };
      }
      const sesionId = abrirSesionCaja(db, actor, {
        montoInicialCentavos: Number(payload.montoInicialCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : undefined,
      });
      return { sesionId };
    }

    case 'movimiento_manual_caja': {
      const movId = registrarMovimientoManualCaja(db, actor, {
        cajaSesionId: String(payload.cajaSesionId),
        tipo: payload.tipo as 'ingreso' | 'egreso',
        concepto: String(payload.concepto ?? ''),
        montoCentavos: Number(payload.montoCentavos ?? 0),
        medio: (payload.medio as MedioPago | undefined) ?? 'efectivo',
      });
      return { movId };
    }

    case 'cerrar_caja': {
      return cerrarSesionCaja(db, actor, {
        cajaSesionId: String(payload.cajaSesionId),
        efectivoContadoCentavos: Number(payload.efectivoContadoCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : undefined,
      });
    }

    case 'listar_usuarios': {
      return listarUsuariosComercio(db, actor);
    }

    case 'crear_usuario': {
      const clavePersonalizada =
        typeof payload.claveNueva === 'string' && payload.claveNueva.trim().length > 0
          ? payload.claveNueva.trim()
          : null;
      const claveAHashear = clavePersonalizada ?? generarClaveTemporal();
      validarPoliticaClave(claveAHashear);
      const claveHash = hashearClaveArgon2id(claveAHashear);
      const id = crearUsuario(db, actor, {
        nombre: String(payload.nombre ?? ''),
        usuario: String(payload.usuario ?? ''),
        claveHash,
        rol: payload.rol as RolUsuario,
      });
      if (clavePersonalizada) {
        db.prepare(
          `UPDATE usuarios SET debe_cambiar_clave = 0 WHERE id = ? AND comercio_id = ?`
        ).run(id, actor.comercio_id);
      }
      sincronizarWalADisco(db);
      return { id, claveAsignada: claveAHashear, esTemporal: !clavePersonalizada };
    }

    case 'actualizar_usuario': {
      actualizarRolOEstadoUsuario(db, actor, {
        usuarioObjetivoId: String(payload.usuarioObjetivoId),
        nuevoRol: payload.nuevoRol as RolUsuario,
        nuevoActivo: Boolean(payload.nuevoActivo),
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      sincronizarWalADisco(db);
      return { ok: true };
    }

    case 'cambiar_clave_usuario': {
      const usuarioObjetivoId = String(payload.usuarioObjetivoId ?? '').trim();
      const claveNueva = String(payload.claveNueva ?? '');
      if (usuarioObjetivoId === actor.usuario_id) {
        const claveActual = String(payload.claveActual ?? '');
        if (!claveActual) {
          throw new Error(
            'CLAVE_ACTUAL_REQUERIDA: Debés ingresar tu contraseña actual para cambiarla.'
          );
        }
        cambiarClavePropia(db, actor, {
          claveActual,
          claveNueva,
        });
      } else {
        establecerClaveUsuarioDirecta(db, actor, {
          usuarioObjetivoId,
          claveNueva,
          debeCambiarAlIngresar: Boolean(payload.debeCambiarAlIngresar ?? false),
          motivo: payload.motivo ? String(payload.motivo) : undefined,
        });
      }
      sincronizarWalADisco(db);
      return { ok: true };
    }

    case 'resetear_clave_usuario': {
      const res = resetearClaveUsuario(db, actor, {
        usuarioObjetivoId: String(payload.usuarioObjetivoId),
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'consultar_auditoria': {
      const registros = consultarRegistrosAuditoria(db, actor, {
        accion: payload.accion ? String(payload.accion) : undefined,
        entidad: payload.entidad ? String(payload.entidad) : undefined,
      });
      return { registros };
    }

    case 'verificar_integridad_auditoria': {
      exigirPermiso(actor.rol, 'ver_exportar_auditoria');
      return verificarIntegridadAuditoriaDb(db, actor.comercio_id);
    }

    case 'obtener_informes_fase1': {
      return obtenerInformeGestionFase1(db, actor, {
        fechaDesdeIso: payload.fechaDesdeIso
          ? String(payload.fechaDesdeIso)
          : undefined,
        fechaHastaIso: payload.fechaHastaIso
          ? String(payload.fechaHastaIso)
          : undefined,
        sucursalId: payload.sucursalId ? String(payload.sucursalId) : undefined,
      });
    }

    case 'exportar_informes_xlsx': {
      const { xlsxBytes, informe } = exportarInformeGestionFase1AXlsx(
        db,
        actor,
        {
          fechaDesdeIso: payload.fechaDesdeIso
            ? String(payload.fechaDesdeIso)
            : undefined,
          fechaHastaIso: payload.fechaHastaIso
            ? String(payload.fechaHastaIso)
            : undefined,
          sucursalId: payload.sucursalId
            ? String(payload.sucursalId)
            : undefined,
        }
      );
      return {
        xlsxBase64: Buffer.from(xlsxBytes).toString('base64'),
        bytesLength: xlsxBytes.byteLength,
        informe,
      };
    }

    case 'crear_sucursal': {
      const id = crearSucursalComercio(db, actor, {
        nombre: String(payload.nombre ?? ''),
        codigo: payload.codigo ? String(payload.codigo) : null,
        direccion: payload.direccion ? String(payload.direccion) : null,
        telefono: payload.telefono ? String(payload.telefono) : null,
        esPrincipal: Boolean(payload.esPrincipal),
      });
      sincronizarWalADisco(db);
      return { id };
    }

    case 'actualizar_sucursal': {
      actualizarSucursalComercio(db, actor, {
        sucursalId: String(payload.sucursalId ?? ''),
        nombre: String(payload.nombre ?? ''),
        codigo: payload.codigo ? String(payload.codigo) : null,
        direccion: payload.direccion ? String(payload.direccion) : null,
        telefono: payload.telefono ? String(payload.telefono) : null,
        activo:
          payload.activo !== undefined ? Boolean(payload.activo) : undefined,
      });
      sincronizarWalADisco(db);
      return { ok: true };
    }

    case 'seleccionar_sucursal_activa': {
      exigirPermiso(actor.rol, 'vender_y_caja');
      const sucursalActiva = seleccionarSucursalActivaTerminal(
        db,
        actor,
        String(payload.sucursalId ?? '')
      );
      sincronizarWalADisco(db);
      return { sucursalActiva };
    }

    case 'transferir_stock_sucursales': {
      const items = (
        (payload.items as Array<{
          productoId: string;
          cantidad: number;
        }>) ?? []
      ).map((it) => ({
        productoId: String(it.productoId ?? ''),
        cantidad: Number(it.cantidad ?? 0),
      }));
      const res = transferirProductosEntreSucursales(db, actor, {
        sucursalOrigenId: String(payload.sucursalOrigenId ?? ''),
        sucursalDestinoId: String(payload.sucursalDestinoId ?? ''),
        motivo: String(payload.motivo ?? ''),
        items,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'exportar_auditoria_xlsx': {
      const xlsxBytes = exportarAuditoriaAXlsx(db, actor);
      return {
        xlsxBase64: Buffer.from(xlsxBytes).toString('base64'),
        bytesLength: xlsxBytes.byteLength,
      };
    }

    case 'exportar_pedido_reposicion_pdf': {
      const criterio =
        (payload.criterio as CriterioAgrupacionPedido | undefined) ??
        'proveedor';
      const filtroGrupoId = payload.filtroGrupoId
        ? String(payload.filtroGrupoId)
        : null;
      const cantidadesPersonalizadas =
        (payload.cantidadesPersonalizadasPorProducto as
          | Record<string, number>
          | undefined) ?? undefined;
      const { pdfBytes, resumen } = exportarPedidoReposicionBajoStockAPdf(
        db,
        actor,
        {
          criterio,
          filtroGrupoId,
          cantidadesPersonalizadasPorProducto: cantidadesPersonalizadas,
        }
      );
      sincronizarWalADisco(db);
      return {
        pdfBase64: Buffer.from(pdfBytes).toString('base64'),
        bytesLength: pdfBytes.byteLength,
        resumen,
      };
    }

    case 'exportar_pedido_reposicion_xlsx': {
      const criterio =
        (payload.criterio as CriterioAgrupacionPedido | undefined) ??
        'proveedor';
      const filtroGrupoId = payload.filtroGrupoId
        ? String(payload.filtroGrupoId)
        : null;
      const cantidadesPersonalizadas =
        (payload.cantidadesPersonalizadasPorProducto as
          | Record<string, number>
          | undefined) ?? undefined;
      const { xlsxBytes, resumen } = exportarPedidoReposicionBajoStockAXlsx(
        db,
        actor,
        {
          criterio,
          filtroGrupoId,
          cantidadesPersonalizadasPorProducto: cantidadesPersonalizadas,
        }
      );
      sincronizarWalADisco(db);
      return {
        xlsxBase64: Buffer.from(xlsxBytes).toString('base64'),
        bytesLength: xlsxBytes.byteLength,
        resumen,
      };
    }

    case 'guardar_configuracion_sistema': {
      const dirBase = path.dirname(rutaActivaDb);
      const cfgGuardada = guardarConfiguracionSistema(db, actor, {
        proveedorNube:
          payload.proveedorNube !== undefined
            ? (payload.proveedorNube as ProveedorNubeSync)
            : undefined,
        supabaseUrl:
          payload.supabaseUrl !== undefined
            ? (payload.supabaseUrl as string | null)
            : undefined,
        supabaseAnonKey:
          payload.supabaseAnonKey !== undefined
            ? (payload.supabaseAnonKey as string | null)
            : undefined,
        firebaseProjectId:
          payload.firebaseProjectId !== undefined
            ? (payload.firebaseProjectId as string | null)
            : undefined,
        firebaseApiKey:
          payload.firebaseApiKey !== undefined
            ? (payload.firebaseApiKey as string | null)
            : undefined,
        syncAutomaticoHabilitado:
          payload.syncAutomaticoHabilitado !== undefined
            ? Boolean(payload.syncAutomaticoHabilitado)
            : undefined,
        syncIntervaloMinutos:
          payload.syncIntervaloMinutos !== undefined
            ? Number(payload.syncIntervaloMinutos)
            : undefined,
        carpetaBackups:
          payload.carpetaBackups !== undefined
            ? String(payload.carpetaBackups)
            : undefined,
        backupDiarioHabilitado:
          payload.backupDiarioHabilitado !== undefined
            ? Boolean(payload.backupDiarioHabilitado)
            : undefined,
      });
      guardarIdentidadComercioPersistida(dirBase, {
        comercio_id: cfgGuardada.comercio_id,
        supabase_url: cfgGuardada.supabase_url,
        supabase_anon_key: cfgGuardada.supabase_anon_key,
      });
      sincronizarWalADisco(db);
      return cfgGuardada;
    }

    case 'crear_backup_manual': {
      const dirBase = path.dirname(rutaActivaDb);
      return crearBackupBaseDatosLocal(db, actor, {
        directorioBaseDatos: dirBase,
        tipo: 'manual',
      });
    }

    case 'restaurar_desde_backup': {
      const dirBase = path.dirname(rutaActivaDb);
      const res = restaurarDesdeBackupLocal(db, actor, {
        rutaArchivoBackup: String(payload.rutaArchivoBackup ?? ''),
        directorioBaseDatos: dirBase,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'resetear_base_datos': {
      const dirBase = path.dirname(rutaActivaDb);
      const vaciarNube =
        payload.vaciarSupabaseTambien !== undefined
          ? Boolean(payload.vaciarSupabaseTambien)
          : true;
      const res = resetearBaseDatosAFabrica(db, actor, dirBase);
      const cfg = obtenerConfiguracionSistema(db, actor.comercio_id);
      guardarIdentidadComercioPersistida(dirBase, {
        comercio_id: actor.comercio_id,
        superadmin_id: res.superadminId,
        lista_precio_id: res.listaPrecioId,
        supabase_url: cfg.supabase_url,
        supabase_anon_key: cfg.supabase_anon_key,
      });
      sincronizarWalADisco(db);

      if (!vaciarNube) {
        return { ...res, nubeVaciada: false, tablasRemotasVaciadas: 0 };
      }

      const adaptador = resolverAdaptadorSync(db, actor.comercio_id);
      return (async () => {
        let tablasRemotasVaciadas = 0;
        let nubeVaciada = false;
        const disponible = await adaptador.estaDisponible();
        if (disponible && adaptador.vaciarDatosComercioRemoto) {
          const resRemoto = await adaptador.vaciarDatosComercioRemoto({
            comercioId: actor.comercio_id,
            superadminIdConservar: res.superadminId,
            listaPrecioIdConservar: res.listaPrecioId,
          });
          tablasRemotasVaciadas = resRemoto.tablasVaciadas;
          nubeVaciada = true;
          await ejecutarPushDatos(db, adaptador, actor);
        }
        sincronizarWalADisco(db);
        return {
          ...res,
          nubeVaciada,
          tablasRemotasVaciadas,
        };
      })();
    }

    case 'exportar_todo_excel': {
      const xlsxBytes = exportarTodoAExcel(db, actor);
      sincronizarWalADisco(db);
      return {
        xlsxBase64: Buffer.from(xlsxBytes).toString('base64'),
        bytesLength: xlsxBytes.byteLength,
      };
    }

    case 'sync_subir_ahora': {
      const dirBase = path.dirname(rutaActivaDb);
      const adaptador = resolverAdaptadorSync(db, actor.comercio_id);
      return (async () => {
        const push = await ejecutarPushDatos(db, adaptador, actor);
        const imagenes = await procesarColaSincronizacionImagenes(db, adaptador, {
          comercioId: actor.comercio_id,
          directorioBaseDatos: dirBase,
        });
        const online = await adaptador.estaDisponible();
        const estadoUI = obtenerResumenEstadoSyncDb(
          db,
          actor.comercio_id,
          !online
        );
        sincronizarWalADisco(db);
        return { push, imagenes, estadoUI };
      })();
    }

    case 'sync_bajar_ahora': {
      const dirBase = path.dirname(rutaActivaDb);
      const adaptador = resolverAdaptadorSync(db, actor.comercio_id);
      return (async () => {
        const pull = await ejecutarPullDatos(db, adaptador, actor, dirBase, {
          forzarBajadaCompleta: true,
        });
        const comercioIdFinal =
          (
            db
              .prepare(`SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1`)
              .get() as { id: string } | undefined
          )?.id ?? actor.comercio_id;
        const imagenes = await procesarColaSincronizacionImagenes(db, adaptador, {
          comercioId: comercioIdFinal,
          directorioBaseDatos: dirBase,
        });
        const online = await adaptador.estaDisponible();
        const estadoUI = obtenerResumenEstadoSyncDb(
          db,
          comercioIdFinal,
          !online
        );
        sincronizarWalADisco(db);
        return { pull, imagenes, estadoUI };
      })();
    }

    case 'sync_ciclo_completo': {
      const dirBase = path.dirname(rutaActivaDb);
      const adaptador = resolverAdaptadorSync(db, actor.comercio_id);
      return (async () => {
        const res = await ejecutarCicloSincronizacionCompleto(
          db,
          adaptador,
          actor,
          dirBase
        );
        sincronizarWalADisco(db);
        return res;
      })();
    }

    case 'obtener_sql_migracion_supabase': {
      exigirPermiso(actor.rol, 'configuracion_sensible');
      const baseRecursos = process.env.POS_RESOURCES_DIR?.trim()
        ? path.resolve(process.env.POS_RESOURCES_DIR.trim())
        : process.cwd();
      const rutaUnificadoRes = path.resolve(
        baseRecursos,
        'supabase',
        'esquema_completo_unificado.sql'
      );
      const rutaUnificado = fs.existsSync(rutaUnificadoRes)
        ? rutaUnificadoRes
        : path.resolve(
            process.cwd(),
            'supabase',
            'esquema_completo_unificado.sql'
          );
      if (fs.existsSync(rutaUnificado)) {
        return {
          sql: fs.readFileSync(rutaUnificado, 'utf-8').trim(),
          esUnificado: true,
          migracionesIncluidas: ['001', '002', '003', '004', '005'],
        };
      }

      const dirMigRes = path.resolve(baseRecursos, 'supabase', 'migrations');
      const dirMig = fs.existsSync(dirMigRes)
        ? dirMigRes
        : path.resolve(process.cwd(), 'supabase', 'migrations');
      const leerMig = (nombre: string) =>
        fs.existsSync(path.join(dirMig, nombre))
          ? fs.readFileSync(path.join(dirMig, nombre), 'utf-8')
          : '';
      const m001 = leerMig('001_esquema_supabase_rls.sql');
      const m002 = leerMig('002_venta_movil_rpc.sql');
      const m003 = leerMig('003_arca_y_extras_fase4.sql');
      const m004 = leerMig('004_sucursales_y_transferencias.sql');
      const m005 = leerMig('005_endurecimiento_seguridad_rls.sql');
      return {
        sql: `${m001}\n\n${m002}\n\n${m003}\n\n${m004}\n\n${m005}`.trim(),
        esUnificado: true,
        migracionesIncluidas: ['001', '002', '003', '004', '005'],
      };
    }

    case 'obtener_estado_sesion_nube': {
      exigirPermiso(actor.rol, 'configuracion_sensible');
      return {
        supabaseAutenticado: Boolean(sesionesNubeMemoria.supabaseAccessToken),
        supabaseEmail: sesionesNubeMemoria.supabaseEmail,
        firebaseAutenticado: Boolean(sesionesNubeMemoria.firebaseIdToken),
        firebaseEmail: sesionesNubeMemoria.firebaseEmail,
      };
    }

    case 'autenticar_nube_supabase': {
      exigirPermiso(actor.rol, 'configuracion_sensible');
      const cfg = obtenerConfiguracionSistema(db, actor.comercio_id);
      if (!cfg.supabase_url || !cfg.supabase_anon_key) {
        throw new Error(
          'Primero guardá la URL y Anon Key de Supabase en Configuración.'
        );
      }
      const email = String(payload.email ?? '').trim();
      const password = String(payload.password ?? '');
      if (!email || !password) {
        throw new Error('Ingresá tu email y contraseña de Supabase Auth.');
      }
      return autenticarSupabaseEmailClave({
        supabaseUrl: cfg.supabase_url,
        supabaseAnonKey: cfg.supabase_anon_key,
        email,
        password,
      }).then((sesion) => {
        sesionesNubeMemoria.supabaseAccessToken = sesion.accessToken;
        sesionesNubeMemoria.supabaseEmail = sesion.email;
        return {
          supabaseAutenticado: true,
          supabaseEmail: sesion.email,
        };
      });
    }

    case 'autenticar_nube_firebase': {
      exigirPermiso(actor.rol, 'configuracion_sensible');
      const cfg = obtenerConfiguracionSistema(db, actor.comercio_id);
      if (!cfg.firebase_api_key) {
        throw new Error(
          'Primero guardá la Web API Key de Firebase en Configuración.'
        );
      }
      const email = String(payload.email ?? '').trim();
      const password = String(payload.password ?? '');
      if (!email || !password) {
        throw new Error('Ingresá tu email y contraseña de Firebase Auth.');
      }
      return autenticarFirebaseEmailClave({
        apiKey: cfg.firebase_api_key,
        email,
        password,
      }).then((sesion) => {
        sesionesNubeMemoria.firebaseIdToken = sesion.idToken;
        sesionesNubeMemoria.firebaseEmail = sesion.email;
        return {
          firebaseAutenticado: true,
          firebaseEmail: sesion.email,
        };
      });
    }

    case 'cerrar_sesion_nube': {
      exigirPermiso(actor.rol, 'configuracion_sensible');
      const proveedor = String(payload.proveedor ?? 'ambos');
      if (proveedor === 'supabase' || proveedor === 'ambos') {
        sesionesNubeMemoria.supabaseAccessToken = null;
        sesionesNubeMemoria.supabaseEmail = null;
      }
      if (proveedor === 'firebase' || proveedor === 'ambos') {
        sesionesNubeMemoria.firebaseIdToken = null;
        sesionesNubeMemoria.firebaseEmail = null;
      }
      return { ok: true };
    }

    case 'copiar_todo_firebase': {
      exigirPermiso(actor.rol, 'configuracion_sensible');
      const adaptadorFb = resolverAdaptadorSync(db, actor.comercio_id);
      return (async () => {
        const res = await copiarBaseCompletaAFirebaseSinDuplicados(
          db,
          actor,
          adaptadorFb instanceof AdaptadorFirebaseFirestoreHttp
            ? adaptadorFb
            : undefined
        );
        sincronizarWalADisco(db);
        return res;
      })();
    }

    case 'iniciar_sesion_operador': {
      const comercioId = obtenerComercioActivoId(db);
      if (!comercioId || !tieneSuperadminActivo(db)) {
        throw new Error(
          'CONFIGURACION_INICIAL_REQUERIDA: Primero creá el comercio y el administrador inicial.'
        );
      }
      const usuarioInput =
        typeof payload.usuario === 'string' ? payload.usuario.trim() : '';
      const claveInput =
        typeof payload.clave === 'string' ? payload.clave : '';

      if (!usuarioInput || !claveInput) {
        throw new Error('Ingresá tu usuario y contraseña para iniciar sesión.');
      }

      const resAuth = autenticarUsuarioOffline(db, {
        comercioId,
        usuario: usuarioInput,
        clave: claveInput,
        deviceId: obtenerODefinirDeviceIdTerminal(path.dirname(rutaActivaDb)),
      });
      const sesion = crearSesionOperadorLocal(
        resAuth.actor.comercio_id,
        resAuth.usuario.id
      );
      sincronizarWalADisco(db);
      return {
        sessionToken: sesion.token,
        operadorActual: {
          id: resAuth.usuario.id,
          nombre: resAuth.usuario.nombre,
          usuario: resAuth.usuario.usuario,
          rol: resAuth.usuario.rol,
          debe_cambiar_clave: resAuth.usuario.debe_cambiar_clave,
        },
      };
    }

    case 'cerrar_sesion_operador': {
      if (contextoHttp?.sessionToken) {
        sesionesOperadoresLocales.delete(contextoHttp.sessionToken);
      }
      registrarLogoutUsuario(db, actor);
      sincronizarWalADisco(db);
      return { ok: true, rolReal };
    }

    case 'obtener_estado_actualizaciones': {
      const migracionesAplicadas = db
        .prepare(
          `SELECT id, nombre, aplicada_en FROM _migraciones ORDER BY id ASC`
        )
        .all() as unknown as Array<{
        id: number;
        nombre: string;
        aplicada_en: string;
      }>;
      const cfg = obtenerConfiguracionSistema(db, actor.comercio_id);
      const resumenSync = obtenerResumenEstadoSyncDb(
        db,
        actor.comercio_id,
        false
      );
      let tamanoDbBytes = 0;
      try {
        if (rutaActivaDb !== ':memory:' && fs.existsSync(rutaActivaDb)) {
          tamanoDbBytes = fs.statSync(rutaActivaDb).size;
        }
      } catch {
        tamanoDbBytes = 0;
      }
      return {
        versionApp: '0.1.0',
        rutaBaseDatos: rutaActivaDb,
        tamanoDbBytes,
        migracionesAplicadas,
        ultimoBackupAt: cfg.ultimo_backup_at,
        ultimoBackupArchivo: cfg.ultimo_backup_archivo,
        pendientesSync: resumenSync.totalPendientes,
        proveedorNube: cfg.proveedor_nube,
      };
    }

    case 'crear_categoria': {
      const id = crearCategoria(db, actor, {
        nombre: String(payload.nombre ?? ''),
      });
      sincronizarWalADisco(db);
      return { id };
    }

    case 'crear_marca': {
      const id = crearMarca(db, actor, {
        nombre: String(payload.nombre ?? ''),
      });
      sincronizarWalADisco(db);
      return { id };
    }

    case 'crear_proveedor': {
      const id = crearProveedor(db, actor, {
        razonSocial: String(payload.razonSocial ?? ''),
        cuit: payload.cuit ? String(payload.cuit) : null,
        telefono: payload.telefono ? String(payload.telefono) : null,
        email: payload.email ? String(payload.email) : null,
      });
      sincronizarWalADisco(db);
      return { id };
    }

    case 'registrar_compra_proveedor': {
      const items = (
        (payload.items as Array<{
          productoId: string;
          cantidad: number;
          costoUnitarioCentavos: number;
          alicuotaIva?: AlicuotaIva;
          actualizarCostoProducto?: boolean;
        }>) ?? []
      ).map((it) => ({
        productoId: String(it.productoId),
        cantidad: Number(it.cantidad),
        costoUnitarioCentavos: Number(it.costoUnitarioCentavos),
        alicuotaIva: it.alicuotaIva ?? 21,
        actualizarCostoProducto:
          it.actualizarCostoProducto !== undefined
            ? Boolean(it.actualizarCostoProducto)
            : true,
      }));

      const res = registrarCompraProveedor(db, actor, {
        proveedorId: payload.proveedorId ? String(payload.proveedorId) : null,
        numeroComprobante: payload.numeroComprobante
          ? String(payload.numeroComprobante)
          : null,
        items,
        registrarCargoCuentaCorriente: Boolean(
          payload.registrarCargoCuentaCorriente
        ),
        montoPagadoEnElActoCentavos: Number(
          payload.montoPagadoEnElActoCentavos ?? 0
        ),
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'crear_cliente': {
      const id = crearCliente(db, actor, {
        nombre: String(payload.nombre ?? ''),
        documento: payload.documento ? String(payload.documento) : null,
        condicionIva:
          (payload.condicionIva as CondicionIvaReceptor | undefined) ??
          'consumidor_final',
        telefono: payload.telefono ? String(payload.telefono) : null,
        domicilio: payload.domicilio ? String(payload.domicilio) : null,
        limiteCreditoCentavos: Number(payload.limiteCreditoCentavos ?? 0),
      });
      sincronizarWalADisco(db);
      return { id };
    }

    case 'registrar_movimiento_cc': {
      const id = registrarMovimientoCuentaCorriente(db, actor, {
        entidadTipo: payload.entidadTipo as 'cliente' | 'proveedor',
        entidadId: String(payload.entidadId ?? ''),
        tipo: payload.tipo as 'cargo' | 'pago',
        montoCentavos: Number(payload.montoCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : null,
      });
      sincronizarWalADisco(db);
      return { id };
    }

    case 'listar_movimientos_cc': {
      const entidadTipo = payload.entidadTipo as 'cliente' | 'proveedor';
      if (entidadTipo === 'proveedor') {
        exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
      }
      return {
        movimientos: listarMovimientosCuentaCorriente(
          db,
          actor.comercio_id,
          entidadTipo,
          String(payload.entidadId ?? '')
        ),
      };
    }

    case 'actualizar_precios_masivo': {
      const res = aplicarActualizacionMasivaPrecios(db, actor, {
        porcentaje: Number(payload.porcentaje ?? 0),
        reglaRedondeo:
          (payload.reglaRedondeo as ReglaRedondeoPrecio | undefined) ??
          'exacto',
        categoriaId: payload.categoriaId ? String(payload.categoriaId) : null,
        marcaId: payload.marcaId ? String(payload.marcaId) : null,
        proveedorId: payload.proveedorId ? String(payload.proveedorId) : null,
        actualizarCostoCompraTambien: Boolean(
          payload.actualizarCostoCompraTambien
        ),
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'importar_productos_csv': {
      const res = importarProductosDesdeCsv(db, actor, {
        contenidoCsv: String(payload.contenidoCsv ?? ''),
        actualizarSiExisteCodigo:
          payload.actualizarSiExisteCodigo !== undefined
            ? Boolean(payload.actualizarSiExisteCodigo)
            : true,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'obtener_libro_iva': {
      return obtenerLibroIvaPeriodo(db, actor, {
        fechaDesdeIso: payload.fechaDesdeIso
          ? String(payload.fechaDesdeIso)
          : undefined,
        fechaHastaIso: payload.fechaHastaIso
          ? String(payload.fechaHastaIso)
          : undefined,
      });
    }

    case 'exportar_libro_iva_xlsx': {
      const { xlsxBytes, libro } = exportarLibroIvaAXlsx(db, actor, {
        fechaDesdeIso: payload.fechaDesdeIso
          ? String(payload.fechaDesdeIso)
          : undefined,
        fechaHastaIso: payload.fechaHastaIso
          ? String(payload.fechaHastaIso)
          : undefined,
      });
      return {
        xlsxBase64: Buffer.from(xlsxBytes).toString('base64'),
        bytesLength: xlsxBytes.byteLength,
        libro,
      };
    }

    case 'generar_ticket_escpos': {
      return generarTicketEscPosDeVentaDb(db, actor.comercio_id, {
        ventaId: String(payload.ventaId ?? ''),
        anchoMm: (payload.anchoMm as 58 | 80 | undefined) ?? 80,
      });
    }

    case 'obtener_config_venta_movil': {
      exigirPermiso(actor.rol, 'configurar_venta_movil_y_arca');
      return obtenerConfigVentaMovil(db, actor.comercio_id);
    }

    case 'obtener_configuracion_netlify': {
      exigirPermiso(actor.rol, 'configurar_venta_movil_y_arca');
      return obtenerConfiguracionNetlify(db, actor.comercio_id);
    }

    case 'verificar_token_netlify': {
      exigirPermiso(actor.rol, 'configurar_venta_movil_y_arca');
      const token = String(payload.token ?? '');
      return verificarTokenNetlifyApi(token);
    }

    case 'guardar_configuracion_netlify': {
      exigirPermiso(actor.rol, 'configurar_venta_movil_y_arca');
      const res = guardarConfiguracionNetlify(db, {
        actor,
        netlifyToken:
          payload.netlifyToken !== undefined
            ? String(payload.netlifyToken)
            : undefined,
        netlifySiteName:
          payload.netlifySiteName !== undefined
            ? String(payload.netlifySiteName)
            : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'desplegar_cajero_movil_netlify': {
      exigirPermiso(actor.rol, 'configurar_venta_movil_y_arca');
      return (async () => {
        const configSistema = obtenerConfiguracionSistema(db, actor.comercio_id);
        const configNetlify = obtenerConfiguracionNetlify(db, actor.comercio_id);
        const token = String(payload.token ?? configNetlify.netlify_token ?? '');
        if (!token) {
          throw new Error('Debe proporcionar un Personal Access Token de Netlify.');
        }

        const comercio = db
          .prepare('SELECT nombre FROM comercios WHERE id = ?')
          .get(actor.comercio_id) as { nombre: string } | undefined;

        const matchSubdominioUrl = configNetlify.venta_movil_url
          ? configNetlify.venta_movil_url.match(
              /https?:\/\/([a-z0-9\-]+)\.netlify\.app/i
            )
          : null;
        const nombreSitioEfectivo = payload.siteName
          ? String(payload.siteName)
          : configNetlify.netlify_site_name ||
            (matchSubdominioUrl ? matchSubdominioUrl[1] : null);

        guardarConfiguracionNetlify(db, {
          actor,
          netlifyToken: token,
          netlifySiteName: nombreSitioEfectivo ?? undefined,
        });
        sincronizarWalADisco(db);

        const zipBuffer = prepararPaqueteVentaMovilNetlify({
          supabaseUrl: configSistema.supabase_url,
          supabaseAnonKey: configSistema.supabase_anon_key,
          comercioId: actor.comercio_id,
          comercioNombre: comercio?.nombre || 'Comercio',
        });

        const resDeploy = await desplegarSitioNetlify({
          token,
          zipBuffer,
          siteId: payload.siteId
            ? String(payload.siteId)
            : configNetlify.netlify_site_id,
          siteName: nombreSitioEfectivo,
        });

        if (!resDeploy.ok) {
          throw new Error(
            resDeploy.error || 'Fallo durante el despliegue en Netlify.'
          );
        }

        const estadoMovil = registrarDespliegueNetlifyExitoso(db, {
          actor,
          siteId: resDeploy.siteId,
          siteName: resDeploy.siteName,
          siteUrl: resDeploy.siteUrl,
          urlVentaMovil: resDeploy.urlVentaMovil,
          token,
        });

        sincronizarWalADisco(db);
        return {
          despliegue: resDeploy,
          configMovil: estadoMovil,
        };
      })();
    }

    case 'configurar_venta_movil': {
      const res = configurarVentaMovilComercio(db, {
        actor,
        habilitada: Boolean(payload.habilitada),
        urlPublica: String(payload.urlPublica ?? ''),
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'actualizar_permiso_venta_movil': {
      actualizarPermisoVentaMovilUsuario(db, {
        actor,
        usuarioObjetivoId: String(payload.usuarioObjetivoId ?? ''),
        puedeVenderMovil: Boolean(payload.puedeVenderMovil),
      });
      sincronizarWalADisco(db);
      return obtenerConfigVentaMovil(db, actor.comercio_id);
    }

    case 'revocar_sesion_movil': {
      revocarSesionMovil(db, {
        actor,
        sesionId: String(payload.sesionId ?? ''),
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      sincronizarWalADisco(db);
      return obtenerConfigVentaMovil(db, actor.comercio_id);
    }

    case 'login_movil': {
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      if (!comercioIdMovil) {
        throw new Error('Comercio no inicializado.');
      }
      const res = iniciarSesionMovil(db, {
        comercioId: comercioIdMovil,
        usuario: String(payload.usuario ?? ''),
        clave: String(payload.clave ?? ''),
        dispositivoId: String(payload.dispositivoId || 'movil-web-1'),
        dispositivoNombre: payload.dispositivoNombre
          ? String(payload.dispositivoNombre)
          : undefined,
        userAgent: payload.userAgent ? String(payload.userAgent) : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'obtener_catalogo_movil': {
      const sesionMovilId = String(payload.sesionMovilId ?? '').trim();
      if (!sesionMovilId) {
        throw new Error('SESION_INVALIDA: Se requiere una sesión móvil activa.');
      }
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      validarYRenovarSesionMovil(db, {
        sesionId: sesionMovilId,
        comercioId: comercioIdMovil,
      });
      const productos = obtenerCatalogoVentaMovil(db, comercioIdMovil);
      const combos = listarCombosComercio(db, comercioIdMovil);
      const clientes = listarClientesConSaldo(db, comercioIdMovil).map((c) => ({
        id: c.id,
        nombre: c.nombre,
        cuit_dni: c.cuit_dni,
        condicion_iva: c.condicion_iva,
        limite_credito: c.limite_credito,
        saldo_pendiente: c.saldo_pendiente_centavos,
      }));
      return {
        comercioId: comercioIdMovil,
        productos,
        combos,
        clientes,
      };
    }

    case 'crear_venta_movil': {
      const sesionMovilId = String(payload.sesionMovilId ?? '').trim();
      if (!sesionMovilId) {
        throw new Error('SESION_INVALIDA: Se requiere una sesión móvil activa.');
      }
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      const sesionMovil = validarYRenovarSesionMovil(db, {
        sesionId: sesionMovilId,
        comercioId: comercioIdMovil,
      });
      const res = crearVentaMovilServidor(db, {
        ventaId: String(payload.ventaId ?? ''),
        comercioId: comercioIdMovil,
        usuarioId: sesionMovil.usuario_id,
        dispositivoId: String(payload.dispositivoId || sesionMovil.dispositivo_id || 'movil-web-1'),
        sesionMovilId,
        items: (payload.items as ItemPedidoMovilInput[]) ?? [],
        pagos: (payload.pagos as PagoVentaInput[]) ?? [],
        descuentoGlobal: Number(payload.descuentoGlobal ?? 0),
        clienteId: payload.clienteId ? String(payload.clienteId) : null,
        cajaSesionId: payload.cajaSesionId ? String(payload.cajaSesionId) : null,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'estado_caja_movil': {
      const sesionMovilId = String(payload.sesionMovilId ?? '').trim();
      if (!sesionMovilId) {
        throw new Error('SESION_INVALIDA: Se requiere una sesión móvil activa.');
      }
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      const sesionMovil = validarYRenovarSesionMovil(db, {
        sesionId: sesionMovilId,
        comercioId: comercioIdMovil,
      });
      return obtenerEstadoCajaMovilUsuario(
        db,
        comercioIdMovil,
        sesionMovil.usuario_id
      );
    }

    case 'abrir_caja_movil': {
      const sesionMovilId = String(payload.sesionMovilId ?? '').trim();
      if (!sesionMovilId) {
        throw new Error('SESION_INVALIDA: Se requiere una sesión móvil activa.');
      }
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      const sesionMovil = validarYRenovarSesionMovil(db, {
        sesionId: sesionMovilId,
        comercioId: comercioIdMovil,
      });
      const res = abrirCajaMovilUsuario(db, {
        comercioId: comercioIdMovil,
        usuarioId: sesionMovil.usuario_id,
        dispositivoId: String(payload.dispositivoId || sesionMovil.dispositivo_id || 'movil-web-1'),
        montoInicialCentavos: Number(payload.montoInicialCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'cerrar_caja_movil': {
      const sesionMovilId = String(payload.sesionMovilId ?? '').trim();
      if (!sesionMovilId) {
        throw new Error('SESION_INVALIDA: Se requiere una sesión móvil activa.');
      }
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      const sesionMovil = validarYRenovarSesionMovil(db, {
        sesionId: sesionMovilId,
        comercioId: comercioIdMovil,
      });
      const res = cerrarCajaMovilUsuario(db, {
        comercioId: comercioIdMovil,
        usuarioId: sesionMovil.usuario_id,
        dispositivoId: String(payload.dispositivoId || sesionMovil.dispositivo_id || 'movil-web-1'),
        efectivoContadoCentavos: Number(payload.efectivoContadoCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'listar_ventas_movil_dia': {
      const sesionMovilId = String(payload.sesionMovilId ?? '').trim();
      if (!sesionMovilId) {
        throw new Error('SESION_INVALIDA: Se requiere una sesión móvil activa.');
      }
      const comercioIdMovil =
        (payload.comercioId ? String(payload.comercioId).trim() : '') ||
        obtenerComercioActivoId(db) ||
        '';
      const sesionMovil = validarYRenovarSesionMovil(db, {
        sesionId: sesionMovilId,
        comercioId: comercioIdMovil,
      });
      return {
        ventas: listarVentasPropiasDelDiaMovil(
          db,
          comercioIdMovil,
          sesionMovil.usuario_id
        ),
      };
    }

    // =========================================================================
    // Fase 4: Facturación Electrónica ARCA y Extras (Listas, Variantes, Combos, Balanzas)
    // =========================================================================

    case 'obtener_config_arca': {
      return obtenerConfiguracionArca(db, actor.comercio_id);
    }

    case 'guardar_configuracion_arca': {
      const res = guardarConfiguracionArca(db, actor, {
        arcaHabilitada: Boolean(payload.arcaHabilitada),
        razonSocial:
          payload.razonSocial !== undefined
            ? String(payload.razonSocial)
            : undefined,
        cuit: payload.cuit !== undefined ? String(payload.cuit) : undefined,
        condicionIva: payload.condicionIva as CondicionIva | undefined,
        domicilio:
          payload.domicilio !== undefined
            ? String(payload.domicilio)
            : undefined,
        puntoVenta:
          payload.puntoVenta !== undefined
            ? Number(payload.puntoVenta)
            : undefined,
        ambiente: payload.ambiente as AmbienteArca | undefined,
        proveedor: payload.proveedor as ProveedorArca | undefined,
        topeConsumidorFinalCentavos:
          payload.topeConsumidorFinalCentavos !== undefined
            ? Number(payload.topeConsumidorFinalCentavos)
            : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'emitir_comprobante_arca_venta': {
      exigirPermiso(actor.rol, 'vender_y_caja');
      const adaptador = resolverAdaptadorArca(
        db,
        actor.comercio_id,
        Boolean(payload.sinConexion)
      );
      return emitirComprobanteArcaVenta(
        db,
        actor,
        String(payload.ventaId),
        adaptador
      ).then((r) => {
        sincronizarWalADisco(db);
        return r;
      });
    }

    case 'reintentar_pendientes_arca': {
      exigirPermiso(actor.rol, 'vender_y_caja');
      const adaptador = resolverAdaptadorArca(
        db,
        actor.comercio_id,
        Boolean(payload.sinConexion)
      );
      return reintentarComprobantesArcaPendientes(db, actor, adaptador, {
        respetarBackoff: true,
      }).then((r) => {
        sincronizarWalADisco(db);
        return r;
      });
    }

    case 'obtener_comprobante_fiscal_imprimible': {
      return obtenerComprobanteFiscalImprimibleDb(
        db,
        actor.comercio_id,
        String(payload.ventaId)
      );
    }

    case 'obtener_informe_comprobantes_arca': {
      exigirPermiso(actor.rol, 'ver_informes_gestion');
      return obtenerInformeComprobantesArca(db, actor.comercio_id, {
        estadoFacturacion: payload.estadoFacturacion as
          | EstadoFacturacionArca
          | 'todos'
          | undefined,
        desdeIso: payload.desdeIso ? String(payload.desdeIso) : undefined,
        hastaIso: payload.hastaIso ? String(payload.hastaIso) : undefined,
      });
    }

    case 'crear_lista_precio': {
      const id = crearListaPrecio(db, actor, {
        nombre: String(payload.nombre ?? ''),
        porcentajeSobreMostrador:
          payload.porcentajeSobreMostrador !== undefined
            ? Number(payload.porcentajeSobreMostrador)
            : undefined,
      });
      sincronizarWalADisco(db);
      return { id, listasPrecio: listarListasPrecio(db, actor.comercio_id) };
    }

    case 'asignar_precio_en_lista': {
      asignarPrecioProductoEnLista(db, actor, {
        productoId: String(payload.productoId),
        listaPrecioId: String(payload.listaPrecioId),
        precioVentaCentavos: Number(payload.precioVentaCentavos ?? 0),
      });
      sincronizarWalADisco(db);
      return { ok: true, listasPrecio: listarListasPrecio(db, actor.comercio_id) };
    }

    case 'crear_variante_producto': {
      const id = crearVarianteProducto(db, actor, {
        productoId: String(payload.productoId),
        nombre: String(payload.nombre ?? ''),
        atributo1: payload.atributo1 ? String(payload.atributo1) : null,
        atributo2: payload.atributo2 ? String(payload.atributo2) : null,
        skuVariante: payload.skuVariante ? String(payload.skuVariante) : null,
        codigoBarras: payload.codigoBarras
          ? String(payload.codigoBarras)
          : null,
        precioAdicionalCentavos: Number(payload.precioAdicionalCentavos ?? 0),
      });
      sincronizarWalADisco(db);
      return { id, variantes: listarVariantesComercio(db, actor.comercio_id) };
    }

    case 'crear_combo_promocion': {
      const id = crearComboPromocion(db, actor, {
        nombre: String(payload.nombre ?? ''),
        descripcion: payload.descripcion ? String(payload.descripcion) : null,
        codigoBarras: payload.codigoBarras
          ? String(payload.codigoBarras)
          : null,
        precioVentaCentavos: Number(payload.precioVentaCentavos ?? 0),
        componentes: (
          (payload.componentes as Array<{
            productoId: string;
            cantidad: number;
          }>) ?? []
        ).map((c) => ({
          productoId: String(c.productoId),
          cantidad: Number(c.cantidad),
        })),
      });
      sincronizarWalADisco(db);
      return { id, combos: listarCombosComercio(db, actor.comercio_id) };
    }

    case 'eliminar_combo_promocion': {
      eliminarComboPromocion(db, actor, {
        comboId: String(payload.comboId ?? ''),
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      sincronizarWalADisco(db);
      return { ok: true, combos: listarCombosComercio(db, actor.comercio_id) };
    }

    case 'vender_combo_promocion': {
      const sesionAbierta = db
        .prepare(
          `SELECT id FROM caja_sesiones
           WHERE comercio_id = ? AND estado = 'abierta' AND deleted_at IS NULL
           ORDER BY fecha_apertura DESC LIMIT 1`
        )
        .get(actor.comercio_id) as { id: string } | undefined;

      const pagos = (
        payload.pagos as Array<{ medio: MedioPago; monto: number }>
      ).map((p) => ({
        medio: p.medio,
        monto: Number(p.monto),
      }));

      const res = venderComboPromocion(db, actor, {
        comboId: String(payload.comboId),
        cantidadCombos: Number(payload.cantidadCombos ?? 1),
        pagos,
        clienteId: payload.clienteId ? String(payload.clienteId) : undefined,
        cajaSesionId: sesionAbierta?.id,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'resolver_escaneo_balanza': {
      return resolverEscaneoBalanzaEnCatalogo(
        db,
        actor.comercio_id,
        String(payload.codigoBarras ?? '')
      );
    }

    default:
      throw new Error(`Acción desconocida: ${accion}`);
  }
}
