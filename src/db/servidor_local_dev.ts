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
  obtenerInformeGestionFase1,
} from './informes_repo.ts';
import { aplicarMigraciones, crearBaseDatos } from './migrator.ts';
import {
  actualizarProductoYPrecio,
  agregarCodigoBarrasProducto,
  eliminarProductoLogico,
  obtenerDatosTicketDeVentaDb,
} from './productos_repo.ts';
import {
  actualizarRolOEstadoUsuario,
  anularVenta,
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
  AdaptadorSupabaseHttp,
  NubeSimuladaEnMemoria,
  ejecutarCicloSincronizacionCompleto,
  ejecutarPullDatos,
  ejecutarPushDatos,
  guardarConfiguracionSistema,
  obtenerConfiguracionSistema,
  obtenerResumenEstadoSyncDb,
  type AdaptadorNubeSupabase,
} from '../sync/motor_sync.ts';
import {
  calcularEspacioImagenesLocal,
  procesarColaSincronizacionImagenes,
} from '../sync/imagenes_sync.ts';
import {
  crearBackupBaseDatosLocal,
  ejecutarBackupDiarioAutomaticoSiCorresponde,
  exportarTodoAExcel,
  listarHistorialBackups,
  restaurarDesdeBackupLocal,
} from './backup_repo.ts';

export const RUTA_DB_POR_DEFECTO = path.resolve(
  process.cwd(),
  'data',
  'pos_local.db'
);

let instanciaDb: DatabaseSync | null = null;
let rutaActivaDb: string = RUTA_DB_POR_DEFECTO;
const nubeDemoPersistente = new NubeSimuladaEnMemoria();

function resolverAdaptadorSync(
  db: DatabaseSync,
  comercioId: string
): AdaptadorNubeSupabase {
  const cfg = obtenerConfiguracionSistema(db, comercioId);
  if (cfg.supabase_url && cfg.supabase_anon_key) {
    return new AdaptadorSupabaseHttp({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
    });
  }
  return nubeDemoPersistente;
}

export function obtenerConexionLocalDisco(
  rutaPersonalizada: string = RUTA_DB_POR_DEFECTO
): DatabaseSync {
  if (instanciaDb && rutaActivaDb === rutaPersonalizada) {
    aplicarMigraciones(instanciaDb);
    return instanciaDb;
  }

  const directorio = path.dirname(rutaPersonalizada);
  fs.mkdirSync(directorio, { recursive: true });

  const db = crearBaseDatos(rutaPersonalizada);
  asegurarDatosInicialesSiVacia(db);

  instanciaDb = db;
  rutaActivaDb = rutaPersonalizada;
  return db;
}

function asegurarDatosInicialesSiVacia(db: DatabaseSync): void {
  const comercioExistente = db
    .prepare('SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1')
    .get() as { id: string } | undefined;

  if (comercioExistente) {
    return;
  }

  const optsArgon = { m: 4096, t: 2, p: 1 } as const;
  const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
    nombreComercio: 'Comercio Local POS',
    cuit: '20-12345678-6',
    condicionIva: 'monotributo',
    nombreAdmin: 'María Superadmin',
    usuarioAdmin: 'maria',
    claveHashAdmin: hashearClaveArgon2id('Admin1234', optsArgon),
    deviceId: 'terminal-local-1',
  });

  const actorSuperadmin: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: superadminId,
    usuario_nombre: 'María Superadmin',
    rol: 'superadmin',
    device_id: 'terminal-local-1',
  };

  const encargadoId = crearUsuario(db, actorSuperadmin, {
    nombre: 'Carlos Encargado',
    usuario: 'carlos',
    claveHash: hashearClaveArgon2id('Encargado1234', optsArgon),
    rol: 'encargado',
  });

  const cajeroId = crearUsuario(db, actorSuperadmin, {
    nombre: 'Lucas Cajero',
    usuario: 'lucas',
    claveHash: hashearClaveArgon2id('Cajero1234', optsArgon),
    rol: 'cajero',
  });

  const actorEncargado: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: encargadoId,
    usuario_nombre: 'Carlos Encargado',
    rol: 'encargado',
    device_id: 'terminal-local-1',
  };

  const actorCajero: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: cajeroId,
    usuario_nombre: 'Lucas Cajero',
    rol: 'cajero',
    device_id: 'terminal-local-1',
  };

  // Productos iniciales reales en SQLite
  crearProducto(db, actorEncargado, {
    nombre: 'Yerba Mate Selección 1kg',
    codigoInterno: 'YER-001',
    costoCompraCentavos: 280000,
    precioVentaCentavos: 420000,
    alicuotaIva: 21,
    stockMinimo: 10,
    botonRapido: false,
    codigosBarras: ['7791234560012', '7791234560019'],
    stockInicial: 25,
  });

  crearProducto(db, actorEncargado, {
    nombre: 'Alfajor Triple Chocolate',
    codigoInterno: 'ALF-003',
    costoCompraCentavos: 85000,
    precioVentaCentavos: 150000,
    alicuotaIva: 21,
    stockMinimo: 15,
    botonRapido: true,
    codigosBarras: ['7790001112223'],
    stockInicial: 30,
  });

  crearProducto(db, actorEncargado, {
    nombre: 'Pan Francés Fresco (kg)',
    codigoInterno: 'PAN-KG',
    unidad: 'kg',
    permiteDecimales: true,
    costoCompraCentavos: 130000,
    precioVentaCentavos: 240000,
    alicuotaIva: 10.5,
    stockMinimo: 5,
    botonRapido: true,
    codigosBarras: ['200001'],
    stockInicial: 18,
  });

  crearProducto(db, actorEncargado, {
    nombre: 'Gaseosa Cola 2.25L',
    codigoInterno: 'GAS-225',
    costoCompraCentavos: 190000,
    precioVentaCentavos: 310000,
    alicuotaIva: 21,
    stockMinimo: 8,
    botonRapido: true,
    codigosBarras: ['7790895000997'],
    stockInicial: 20,
  });

  crearProducto(db, actorEncargado, {
    nombre: 'Bolsa Reutilizable Grande',
    codigoInterno: 'BOL-01',
    costoCompraCentavos: 25000,
    precioVentaCentavos: 60000,
    alicuotaIva: 21,
    stockMinimo: 20,
    botonRapido: true,
    codigosBarras: [],
    stockInicial: 50,
  });

  abrirSesionCaja(db, actorCajero, {
    montoInicialCentavos: 1500000, // $ 15.000,00
    observaciones: 'Apertura inicial de caja local',
  });
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
            u.nombre AS cajero_nombre,
            au.nombre AS autorizada_por_nombre
           FROM ventas v
           INNER JOIN usuarios u ON u.id = v.usuario_id
           LEFT JOIN usuarios au ON au.id = v.autorizada_por_id
           WHERE v.comercio_id = ? AND v.deleted_at IS NULL
           ORDER BY v.fecha DESC
           LIMIT 20`
        )
        .all(actor.comercio_id) as unknown as Array<{
        id: string;
        fecha: string;
        total: number;
        estado: 'completada' | 'anulada';
        motivo_anulacion: string | null;
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
        historialBackups:
          actor.rol === 'superadmin'
            ? listarHistorialBackups(db, actor.comercio_id)
            : [],
        espacioImagenes: calcularEspacioImagenesLocal(dirBase),
        catalogoVenta,
        catalogoAdmin,
        ventasRecientes,
        estadoCaja,
      };
    }

    case 'crear_producto': {
      const productoId = crearProducto(db, actor, {
        nombre: String(payload.nombre ?? ''),
        codigoInterno: payload.codigoInterno
          ? String(payload.codigoInterno)
          : undefined,
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
      return { productoId };
    }

    case 'actualizar_producto': {
      actualizarProductoYPrecio(db, actor, {
        productoId: String(payload.productoId),
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
      return { ok: true };
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
        }>
      ).map((it) => ({
        productoId: String(it.productoId),
        cantidad: Number(it.cantidad),
        descuentoCentavos: Number(it.descuentoCentavos ?? 0),
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
        cajaSesionId: sesionAbierta?.id,
      });

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

      anularVenta(db, actor, {
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

    case 'guardar_configuracion_sistema': {
      return guardarConfiguracionSistema(db, actor, {
        supabaseUrl:
          payload.supabaseUrl !== undefined
            ? (payload.supabaseUrl as string | null)
            : undefined,
        supabaseAnonKey:
          payload.supabaseAnonKey !== undefined
            ? (payload.supabaseAnonKey as string | null)
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
      return restaurarDesdeBackupLocal(db, actor, {
        rutaArchivoBackup: String(payload.rutaArchivoBackup ?? ''),
        directorioBaseDatos: dirBase,
      });
    }

    case 'exportar_todo_excel': {
      const xlsxBytes = exportarTodoAExcel(db, actor);
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
        return { push, imagenes, estadoUI };
      })();
    }

    case 'sync_bajar_ahora': {
      const dirBase = path.dirname(rutaActivaDb);
      const adaptador = resolverAdaptadorSync(db, actor.comercio_id);
      return (async () => {
        const pull = await ejecutarPullDatos(db, adaptador, actor, dirBase);
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
        return { pull, imagenes, estadoUI };
      })();
    }

    case 'sync_ciclo_completo': {
      const dirBase = path.dirname(rutaActivaDb);
      const adaptador = resolverAdaptadorSync(db, actor.comercio_id);
      return ejecutarCicloSincronizacionCompleto(db, adaptador, actor, dirBase);
    }

    default:
      throw new Error(`Acción desconocida: ${accion}`);
  }
}
