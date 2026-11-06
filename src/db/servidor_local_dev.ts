/**
 * Servicio local de persistencia SQLite en disco (<raiz>/data/pos_local.db).
 * Conecta la interfaz React con los repositorios transaccionales reales de /src/db.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hashearClaveArgon2id } from '../domain/claves.ts';
import type { RolUsuario } from '../domain/permisos.ts';
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
  obtenerInformeGestionFase1,
} from './informes_repo.ts';
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
  consultarRegistrosAuditoria,
  listarUsuariosComercio,
  resetearClaveUsuario,
} from './usuarios_auth_repo.ts';
import {
  AdaptadorFirebaseFirestoreHttp,
  AdaptadorNubeMultiProveedor,
  AdaptadorSupabaseHttp,
  COMERCIO_ID_RESPALDO_CONOCIDO,
  NubeSinConfigurar,
  ejecutarCicloSincronizacionCompleto,
  ejecutarPullDatos,
  ejecutarPushDatos,
  guardarConfiguracionSistema,
  guardarIdentidadComercioPersistida,
  leerIdentidadComercioPersistida,
  obtenerConfiguracionSistema,
  obtenerResumenEstadoSyncDb,
  type AdaptadorNubeSupabase,
  type ProveedorNubeSync,
} from '../sync/motor_sync.ts';
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
} from './arca_fase4_repo.ts';
import type {
  AmbienteArca,
  CondicionIva,
  EstadoFacturacionArca,
  ItemPedidoMovilInput,
  PagoVentaInput,
  ProveedorArca,
} from '../../packages/domain/src/index.ts';

export const RUTA_DB_POR_DEFECTO = path.resolve(
  process.cwd(),
  'data',
  'pos_local.db'
);

let instanciaDb: DatabaseSync | null = null;
let rutaActivaDb: string = RUTA_DB_POR_DEFECTO;
const nubeSinConfigurar = new NubeSinConfigurar();

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
        comercioId,
        rolUsuario: 'superadmin',
      })
    : null;

  const adaptadorFirebase = tieneFirebase
    ? new AdaptadorFirebaseFirestoreHttp(
        cfg.firebase_project_id!,
        cfg.firebase_api_key!
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
  db: DatabaseSync,
  directorioBaseDatos: string = path.dirname(RUTA_DB_POR_DEFECTO)
): void {
  const comercioExistente = db
    .prepare('SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1')
    .get() as { id: string } | undefined;

  if (comercioExistente) {
    return;
  }

  const persistida = leerIdentidadComercioPersistida(directorioBaseDatos);
  const optsArgon = { m: 4096, t: 2, p: 1 } as const;
  const creado = inicializarComercioYSuperadmin(db, {
    comercioId: persistida?.comercio_id ?? COMERCIO_ID_RESPALDO_CONOCIDO,
    superadminId:
      persistida?.superadmin_id ?? '01a15523-8a7c-72f8-b204-e9024dcdecd1',
    listaPrecioId:
      persistida?.lista_precio_id ?? '01a15523-8a7c-72f9-bee7-fffea53d4571',
    nombreComercio: 'Comercio Local POS',
    cuit: '20-12345678-6',
    condicionIva: 'monotributo',
    nombreAdmin: 'María Superadmin',
    usuarioAdmin: 'maria',
    claveHashAdmin: hashearClaveArgon2id('Admin1234', optsArgon),
    deviceId: 'terminal-local-1',
  });

  if (persistida?.supabase_url && persistida?.supabase_anon_key) {
    const ahora = new Date().toISOString();
    db.prepare(
      `INSERT INTO configuracion_sistema (
        comercio_id, supabase_url, supabase_anon_key,
        sync_automatico_habilitado, sync_intervalo_minutos,
        carpeta_backups, backup_diario_habilitado,
        ultimo_backup_at, ultimo_backup_archivo, updated_at
      ) VALUES (?, ?, ?, 1, 5, 'backups', 1, NULL, NULL, ?)
      ON CONFLICT(comercio_id) DO UPDATE SET
        supabase_url = excluded.supabase_url,
        supabase_anon_key = excluded.supabase_anon_key,
        updated_at = excluded.updated_at`
    ).run(
      creado.comercioId,
      persistida.supabase_url,
      persistida.supabase_anon_key,
      ahora
    );
  }
}

function obtenerActorPorRol(db: DatabaseSync, rol: RolUsuario): ActorContexto {
  const comercio = db
    .prepare('SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1')
    .get() as { id: string } | undefined;
  if (!comercio) {
    throw new Error('Comercio no inicializado.');
  }

  const usuario = db
    .prepare(
      `SELECT id, nombre, rol FROM usuarios
       WHERE comercio_id = ? AND rol = ? AND activo = 1 AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(comercio.id, rol) as
    | { id: string; nombre: string; rol: RolUsuario }
    | undefined;

  if (!usuario) {
    const fallback = db
      .prepare(
        `SELECT id, nombre, rol FROM usuarios
         WHERE comercio_id = ? AND activo = 1 AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(comercio.id) as { id: string; nombre: string; rol: RolUsuario };

    return {
      comercio_id: comercio.id,
      usuario_id: fallback.id,
      usuario_nombre: fallback.nombre,
      rol,
      device_id: 'terminal-local-1',
    };
  }

  return {
    comercio_id: comercio.id,
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    rol: usuario.rol,
    device_id: 'terminal-local-1',
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
  const catalogoAdmin = filas.map((f) => ({
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
    boton_rapido: f.boton_rapido === 1,
    imagen_path: f.imagen_path,
    imagen_hash: f.imagen_hash,
  }));

  return { catalogoVenta, catalogoAdmin };
}

function extraerBufferDesdeBase64(imagenBase64: string): Buffer {
  const limpio = imagenBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').trim();
  return Buffer.from(limpio, 'base64');
}

/**
 * Ejecuta una acción RPC solicitada por el frontend contra la base SQLite local en disco.
 */
export function ejecutarAccionPosLocal(
  accion: string,
  payload: Record<string, unknown> = {},
  rutaDb: string = RUTA_DB_POR_DEFECTO
): unknown {
  const db = obtenerConexionLocalDisco(rutaDb);
  const rol = (payload.rolActivo as RolUsuario | undefined) ?? 'superadmin';
  const actor = obtenerActorPorRol(db, rol);

  switch (accion) {
    case 'obtener_estado_inicial': {
      const dirBase = path.dirname(rutaActivaDb);
      const actorSuperadmin = obtenerActorPorRol(db, 'superadmin');
      try {
        ejecutarBackupDiarioAutomaticoSiCorresponde(
          db,
          actorSuperadmin,
          dirBase
        );
      } catch {
        // Un fallo de permisos en la carpeta de backups no debe bloquear nunca la caja
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

      return {
        rutaBaseDatos: rutaActivaDb,
        comercioId: actor.comercio_id,
        operadorActual: {
          id: actor.usuario_id,
          nombre: actor.usuario_nombre,
          rol: actor.rol,
        },
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

      const adaptadorArca = new AdaptadorArcaHomologacionLocal();
      if (payload.sinConexion) {
        adaptadorArca.fijarConectado(false);
      }
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
        const filaAut = db
          .prepare(
            `SELECT id, nombre, rol FROM usuarios
             WHERE comercio_id = ? AND lower(usuario) = lower(?) AND activo = 1 AND deleted_at IS NULL
             LIMIT 1`
          )
          .get(actor.comercio_id, autUsuario) as
          | { id: string; nombre: string; rol: RolUsuario }
          | undefined;

        if (!filaAut || filaAut.rol === 'cajero') {
          throw new Error(
            'AUTORIZACION_INVALIDA: Ingresá un usuario válido con rol encargado o superadmin.'
          );
        }
        autorizador = {
          usuario_id: filaAut.id,
          usuario_nombre: filaAut.nombre,
          rol: filaAut.rol,
        };
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
      const claveTemporal = hashearClaveArgon2id('Temporal2026!', {
        m: 2048,
        t: 1,
        p: 1,
      });
      const id = crearUsuario(db, actor, {
        nombre: String(payload.nombre ?? ''),
        usuario: String(payload.usuario ?? ''),
        claveHash: claveTemporal,
        rol: payload.rol as RolUsuario,
      });
      return { id };
    }

    case 'actualizar_usuario': {
      actualizarRolOEstadoUsuario(db, actor, {
        usuarioObjetivoId: String(payload.usuarioObjetivoId),
        nuevoRol: payload.nuevoRol as RolUsuario,
        nuevoActivo: Boolean(payload.nuevoActivo),
        motivo: payload.motivo ? String(payload.motivo) : undefined,
      });
      return { ok: true };
    }

    case 'resetear_clave_usuario': {
      return resetearClaveUsuario(db, actor, {
        usuarioObjetivoId: String(payload.usuarioObjetivoId),
        opcionesArgon: { m: 2048, t: 1, p: 1 },
      });
    }

    case 'consultar_auditoria': {
      const registros = consultarRegistrosAuditoria(db, actor, {
        accion: payload.accion ? String(payload.accion) : undefined,
        entidad: payload.entidad ? String(payload.entidad) : undefined,
      });
      return { registros };
    }

    case 'verificar_integridad_auditoria': {
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
        }
      );
      return {
        xlsxBase64: Buffer.from(xlsxBytes).toString('base64'),
        bytesLength: xlsxBytes.byteLength,
        informe,
      };
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
      const dirMig = path.resolve(process.cwd(), 'supabase', 'migrations');
      const m002 = fs.existsSync(path.join(dirMig, '002_venta_movil_rpc.sql'))
        ? fs.readFileSync(path.join(dirMig, '002_venta_movil_rpc.sql'), 'utf-8')
        : '';
      const m003 = fs.existsSync(
        path.join(dirMig, '003_arca_y_extras_fase4.sql')
      )
        ? fs.readFileSync(
            path.join(dirMig, '003_arca_y_extras_fase4.sql'),
            'utf-8'
          )
        : '';
      return {
        sql: `${m002}\n\n${m003}`.trim(),
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
      return {
        movimientos: listarMovimientosCuentaCorriente(
          db,
          actor.comercio_id,
          payload.entidadTipo as 'cliente' | 'proveedor',
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
      return obtenerConfigVentaMovil(db, actor.comercio_id);
    }

    case 'obtener_configuracion_netlify': {
      return obtenerConfiguracionNetlify(db, actor.comercio_id);
    }

    case 'verificar_token_netlify': {
      const token = String(payload.token ?? '');
      return verificarTokenNetlifyApi(token);
    }

    case 'guardar_configuracion_netlify': {
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
          siteName: payload.siteName
            ? String(payload.siteName)
            : configNetlify.netlify_site_name,
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
      const res = iniciarSesionMovil(db, {
        comercioId: payload.comercioId
          ? String(payload.comercioId)
          : actor.comercio_id,
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
      const comercioId = payload.comercioId
        ? String(payload.comercioId)
        : actor.comercio_id;
      if (payload.sesionMovilId) {
        validarYRenovarSesionMovil(db, {
          sesionId: String(payload.sesionMovilId),
          comercioId,
        });
      }
      const productos = obtenerCatalogoVentaMovil(db, comercioId);
      const clientes = listarClientesConSaldo(db, comercioId).map((c) => ({
        id: c.id,
        nombre: c.nombre,
        cuit_dni: c.cuit_dni,
        condicion_iva: c.condicion_iva,
        limite_credito: c.limite_credito,
        saldo_pendiente: c.saldo_pendiente_centavos,
      }));
      return {
        comercioId,
        productos,
        clientes,
      };
    }

    case 'crear_venta_movil': {
      const comercioId = payload.comercioId
        ? String(payload.comercioId)
        : actor.comercio_id;
      const res = crearVentaMovilServidor(db, {
        ventaId: String(payload.ventaId ?? ''),
        comercioId,
        usuarioId: String(payload.usuarioId ?? actor.usuario_id),
        dispositivoId: String(payload.dispositivoId || 'movil-web-1'),
        sesionMovilId: payload.sesionMovilId
          ? String(payload.sesionMovilId)
          : undefined,
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
      const comercioId = payload.comercioId
        ? String(payload.comercioId)
        : actor.comercio_id;
      const usuarioId = String(payload.usuarioId ?? actor.usuario_id);
      if (payload.sesionMovilId) {
        validarYRenovarSesionMovil(db, {
          sesionId: String(payload.sesionMovilId),
          comercioId,
        });
      }
      return obtenerEstadoCajaMovilUsuario(db, comercioId, usuarioId);
    }

    case 'abrir_caja_movil': {
      const comercioId = payload.comercioId
        ? String(payload.comercioId)
        : actor.comercio_id;
      const usuarioId = String(payload.usuarioId ?? actor.usuario_id);
      if (payload.sesionMovilId) {
        validarYRenovarSesionMovil(db, {
          sesionId: String(payload.sesionMovilId),
          comercioId,
        });
      }
      const res = abrirCajaMovilUsuario(db, {
        comercioId,
        usuarioId,
        dispositivoId: String(payload.dispositivoId || 'movil-web-1'),
        montoInicialCentavos: Number(payload.montoInicialCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'cerrar_caja_movil': {
      const comercioId = payload.comercioId
        ? String(payload.comercioId)
        : actor.comercio_id;
      const usuarioId = String(payload.usuarioId ?? actor.usuario_id);
      if (payload.sesionMovilId) {
        validarYRenovarSesionMovil(db, {
          sesionId: String(payload.sesionMovilId),
          comercioId,
        });
      }
      const res = cerrarCajaMovilUsuario(db, {
        comercioId,
        usuarioId,
        dispositivoId: String(payload.dispositivoId || 'movil-web-1'),
        efectivoContadoCentavos: Number(payload.efectivoContadoCentavos ?? 0),
        observaciones: payload.observaciones
          ? String(payload.observaciones)
          : undefined,
      });
      sincronizarWalADisco(db);
      return res;
    }

    case 'listar_ventas_movil_dia': {
      const comercioId = payload.comercioId
        ? String(payload.comercioId)
        : actor.comercio_id;
      const usuarioId = String(payload.usuarioId ?? actor.usuario_id);
      if (payload.sesionMovilId) {
        validarYRenovarSesionMovil(db, {
          sesionId: String(payload.sesionMovilId),
          comercioId,
        });
      }
      return {
        ventas: listarVentasPropiasDelDiaMovil(db, comercioId, usuarioId),
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
      const adaptador = new AdaptadorArcaHomologacionLocal();
      if (payload.sinConexion) {
        adaptador.fijarConectado(false);
      }
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
      const adaptador = new AdaptadorArcaHomologacionLocal();
      if (payload.sinConexion) {
        adaptador.fijarConectado(false);
      }
      return reintentarComprobantesArcaPendientes(db, actor, adaptador).then(
        (r) => {
          sincronizarWalADisco(db);
          return r;
        }
      );
    }

    case 'obtener_comprobante_fiscal_imprimible': {
      return obtenerComprobanteFiscalImprimibleDb(
        db,
        actor.comercio_id,
        String(payload.ventaId)
      );
    }

    case 'obtener_informe_comprobantes_arca': {
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
