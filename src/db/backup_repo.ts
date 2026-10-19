/**
 * Repositorio de Backups independientes de la sincronización, Restauración
 * y Exportación completa a Excel (.xlsx) (PLAN.md §5 y §6.1 — Fase 2).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { exigirPermiso } from '../domain/permisos.ts';
import { formatearMonedaARS } from '../domain/dinero.ts';
import type { Centavos } from '../domain/dinero.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import { generarLibroXlsx, type HojaXlsxInput } from '../domain/xlsx.ts';
import { ORDEN_TABLAS_SYNC } from '../domain/sync.ts';
import {
  ejecutarEnTransaccion,
  insertarRegistroAuditoria,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from './repositorios.ts';
import { obtenerConfiguracionSistema } from '../sync/motor_sync.ts';

const requireNode = createRequire(import.meta.url);

function abrirSqliteArchivo(rutaArchivo: string): DatabaseSync {
  const sqlite = requireNode('node:sqlite') as typeof import('node:sqlite');
  return new sqlite.DatabaseSync(rutaArchivo);
}

export interface RegistroHistorialBackup {
  id: string;
  comercio_id: string;
  fecha: string;
  ruta_archivo: string;
  tamano_bytes: number;
  tipo: 'automatico_diario' | 'manual' | 'previo_restauracion';
  usuario_id: string | null;
  created_at: string;
}

export function resolverRutaCarpetaBackups(
  directorioBaseDatos: string,
  carpetaConfigurada: string
): string {
  if (path.isAbsolute(carpetaConfigurada)) {
    return carpetaConfigurada;
  }
  return path.resolve(directorioBaseDatos, carpetaConfigurada);
}

/**
 * Crea una copia consistente y atómica de la base SQLite usando `VACUUM INTO`
 * y registra la operación en `backups_historial` y en `auditoria`.
 */
export function crearBackupBaseDatosLocal(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    directorioBaseDatos: string;
    tipo?: 'automatico_diario' | 'manual' | 'previo_restauracion';
    nombreArchivoPersonalizado?: string;
  }
): RegistroHistorialBackup {
  exigirPermiso(actor.rol, 'configuracion_sensible');

  const config = obtenerConfiguracionSistema(db, actor.comercio_id);
  const carpetaDestino = resolverRutaCarpetaBackups(
    params.directorioBaseDatos,
    config.carpeta_backups
  );
  fs.mkdirSync(carpetaDestino, { recursive: true });

  const ahora = new Date();
  const ahoraIso = ahora.toISOString();
  const stamp = ahoraIso.replace(/[:.]/g, '-');
  const tipo = params.tipo ?? 'manual';

  const nombreArchivo =
    params.nombreArchivoPersonalizado ?? `pos_backup_${tipo}_${stamp}.db`;
  const rutaCompleta = path.join(carpetaDestino, nombreArchivo);

  if (fs.existsSync(rutaCompleta)) {
    fs.unlinkSync(rutaCompleta);
  }

  // VACUUM INTO genera un archivo SQLite completo, consistente y atómico sin bloquear lecturas
  const rutaEscapadaSql = rutaCompleta.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${rutaEscapadaSql}';`);

  const stat = fs.statSync(rutaCompleta);
  const backupId = generarUuidV7();

  ejecutarEnTransaccion(db, () => {
    db.prepare(
      `INSERT INTO backups_historial (
        id, comercio_id, fecha, ruta_archivo, tamano_bytes, tipo, usuario_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      backupId,
      actor.comercio_id,
      ahoraIso,
      rutaCompleta,
      stat.size,
      tipo,
      actor.usuario_id,
      ahoraIso
    );

    db.prepare(
      `UPDATE configuracion_sistema
       SET ultimo_backup_at = ?,
           ultimo_backup_archivo = ?,
           updated_at = ?
       WHERE comercio_id = ?`
    ).run(ahoraIso, rutaCompleta, ahoraIso, actor.comercio_id);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'backup_crear',
      entidad: 'backups_historial',
      entidad_id: backupId,
      valores_despues: {
        tipo,
        ruta_archivo: rutaCompleta,
        tamano_bytes: stat.size,
      },
      ahoraIso,
    });
  });

  return {
    id: backupId,
    comercio_id: actor.comercio_id,
    fecha: ahoraIso,
    ruta_archivo: rutaCompleta,
    tamano_bytes: stat.size,
    tipo,
    usuario_id: actor.usuario_id,
    created_at: ahoraIso,
  };
}

/**
 * Obtiene la fecha YYYY-MM-DD en huso horario de Argentina (`America/Argentina/Buenos_Aires`).
 */
export function obtenerFechaDiaArgentina(isoDate: string): string {
  const fecha = new Date(isoDate);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(fecha);

  const y = partes.find((p) => p.type === 'year')?.value ?? '1970';
  const m = partes.find((p) => p.type === 'month')?.value ?? '01';
  const d = partes.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/**
 * Ejecuta la copia diaria automática del archivo SQLite si está habilitada
 * y aún no se realizó un backup hoy (PLAN.md §5).
 */
export function ejecutarBackupDiarioAutomaticoSiCorresponde(
  db: DatabaseSync,
  actor: ActorContexto,
  directorioBaseDatos: string
): RegistroHistorialBackup | null {
  if (actor.rol !== 'superadmin') {
    return null;
  }

  const config = obtenerConfiguracionSistema(db, actor.comercio_id);
  if (!config.backup_diario_habilitado) {
    return null;
  }

  const hoyAr = obtenerFechaDiaArgentina(new Date().toISOString());
  if (config.ultimo_backup_at) {
    const ultimoDiaAr = obtenerFechaDiaArgentina(config.ultimo_backup_at);
    if (
      ultimoDiaAr === hoyAr &&
      config.ultimo_backup_archivo &&
      fs.existsSync(config.ultimo_backup_archivo)
    ) {
      return null;
    }
  }

  return crearBackupBaseDatosLocal(db, actor, {
    directorioBaseDatos,
    tipo: 'automatico_diario',
    nombreArchivoPersonalizado: `pos_backup_diario_${hoyAr}.db`,
  });
}

export function listarHistorialBackups(
  db: DatabaseSync,
  comercioId: string
): RegistroHistorialBackup[] {
  return db
    .prepare(
      `SELECT id, comercio_id, fecha, ruta_archivo, tamano_bytes, tipo, usuario_id, created_at
       FROM backups_historial
       WHERE comercio_id = ?
       ORDER BY fecha DESC
       LIMIT 30`
    )
    .all(comercioId) as unknown as RegistroHistorialBackup[];
}

/**
 * Restaura la base de datos local desde un archivo de backup SQLite tras verificar:
 * 1. Encabezado mágico SQLite 3 y `PRAGMA integrity_check`.
 * 2. Presencia de tablas maestras y cadena de hash de `auditoria` íntegra en el backup.
 * 3. Creación automática de un backup de resguardo previo (`previo_restauracion`).
 * 4. Registro obligatorio en `auditoria` (`accion: 'backup_restaurar'`).
 */
export function restaurarDesdeBackupLocal(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    rutaArchivoBackup: string;
    directorioBaseDatos: string;
  }
): {
  backupResguardoPrevio: RegistroHistorialBackup;
  registrosRestaurados: number;
} {
  exigirPermiso(actor.rol, 'configuracion_sensible');

  const rutaBackup = path.isAbsolute(params.rutaArchivoBackup)
    ? params.rutaArchivoBackup
    : path.resolve(params.directorioBaseDatos, params.rutaArchivoBackup);

  if (!fs.existsSync(rutaBackup)) {
    throw new Error(`No se encontró el archivo de backup en: ${rutaBackup}`);
  }

  // Verificar encabezado binario SQLite format 3
  const fd = fs.openSync(rutaBackup, 'r');
  const headerBuf = Buffer.alloc(16);
  fs.readSync(fd, headerBuf, 0, 16, 0);
  fs.closeSync(fd);
  if (!headerBuf.toString('utf-8').startsWith('SQLite format 3')) {
    throw new Error(
      'El archivo seleccionado no es una base de datos SQLite válida.'
    );
  }

  // Validar integridad estructural y de auditoría del backup antes de tocar la base activa
  const dbOrigen = abrirSqliteArchivo(rutaBackup);
  let registrosRestaurados = 0;

  try {
    const check = dbOrigen.prepare('PRAGMA integrity_check;').get() as {
      integrity_check: string;
    };
    if (check.integrity_check !== 'ok') {
      throw new Error(
        `El archivo de backup presenta errores de integridad SQLite: ${check.integrity_check}`
      );
    }

    const comercioBackup = dbOrigen
      .prepare('SELECT id FROM comercios LIMIT 1')
      .get() as { id: string } | undefined;
    if (!comercioBackup) {
      throw new Error('El backup no contiene datos de comercio válidos.');
    }

    const verificacionAuditoria = verificarIntegridadAuditoriaDb(
      dbOrigen,
      comercioBackup.id
    );
    if (!verificacionAuditoria.integra) {
      throw new Error(
        `El backup rechazado tiene la cadena de auditoría adulterada: ${verificacionAuditoria.motivoFallo}`
      );
    }

    // 1. Crear backup de resguardo del estado actual antes de restaurar
    const backupResguardoPrevio = crearBackupBaseDatosLocal(db, actor, {
      directorioBaseDatos: params.directorioBaseDatos,
      tipo: 'previo_restauracion',
    });

    // 2. Capturar definiciones SQL de todos los triggers actuales para recrearlos tras volcar los datos
    const triggersActuales = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`
      )
      .all() as unknown as { name: string; sql: string }[];

    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      ejecutarEnTransaccion(db, () => {
        for (const trg of triggersActuales) {
          db.exec(`DROP TRIGGER IF EXISTS "${trg.name}";`);
        }

        // Limpiar tablas en orden inverso e insertar datos desde el backup en orden topológico
        const tablasInverso = [...ORDEN_TABLAS_SYNC].reverse();
        for (const tabla of tablasInverso) {
          db.exec(`DELETE FROM ${tabla};`);
        }

        for (const tabla of ORDEN_TABLAS_SYNC) {
          const filasOrigen = dbOrigen
            .prepare(`SELECT * FROM ${tabla}`)
            .all() as Record<string, unknown>[];
          if (filasOrigen.length === 0) continue;

          const infoCols = db
            .prepare(`PRAGMA table_info(${tabla})`)
            .all() as unknown as { name: string }[];
          const nombresCols = infoCols.map((c) => c.name);
          const colsPresentes = nombresCols.filter(
            (c) => c in filasOrigen[0]!
          );
          const placeholders = colsPresentes.map(() => '?').join(', ');
          const stmtInsert = db.prepare(
            `INSERT INTO ${tabla} (${colsPresentes.join(', ')}) VALUES (${placeholders})`
          );

          for (const fila of filasOrigen) {
            const valores = colsPresentes.map(
              (c) => (fila[c] as string | number | null) ?? null
            );
            stmtInsert.run(...valores);
            registrosRestaurados++;
          }
        }

        // Volver a instalar todos los triggers de seguridad e inmutabilidad
        for (const trg of triggersActuales) {
          db.exec(trg.sql);
        }

        // Registrar la restauración en la auditoría encadenada (PLAN.md §6.1)
        insertarRegistroAuditoria(db, {
          actor,
          accion: 'backup_restaurar',
          entidad: 'backups_historial',
          entidad_id: backupResguardoPrevio.id,
          valores_despues: {
            archivo_restaurado: rutaBackup,
            backup_resguardo_previo: backupResguardoPrevio.ruta_archivo,
            registros_restaurados: registrosRestaurados,
          },
          motivo: `Restauración desde backup ${path.basename(rutaBackup)}`,
        });
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }

    return {
      backupResguardoPrevio,
      registrosRestaurados,
    };
  } finally {
    dbOrigen.close();
  }
}

/**
 * Botón "Exportar todo a Excel" (PLAN.md §5):
 * Exporta todas las tablas de gestión del comercio a un único libro `.xlsx`
 * y registra la exportación en `auditoria`.
 */
export function exportarTodoAExcel(
  db: DatabaseSync,
  actor: ActorContexto
): Uint8Array {
  exigirPermiso(actor.rol, 'ver_informes_gestion');

  const productos = db
    .prepare(
      `SELECT p.id, p.codigo_interno, p.nombre, p.unidad, p.costo_compra,
              pr.precio_venta, p.alicuota_iva, p.stock_minimo, p.activo
       FROM productos p
       LEFT JOIN listas_precio lp ON lp.comercio_id = p.comercio_id AND lp.es_predeterminada = 1
       LEFT JOIN precios pr ON pr.producto_id = p.id AND pr.lista_precio_id = lp.id AND pr.deleted_at IS NULL
       WHERE p.comercio_id = ? AND p.deleted_at IS NULL
       ORDER BY p.nombre ASC`
    )
    .all(actor.comercio_id) as unknown as {
    id: string;
    codigo_interno: string | null;
    nombre: string;
    unidad: string;
    costo_compra: Centavos;
    precio_venta: Centavos | null;
    alicuota_iva: number;
    stock_minimo: number;
    activo: number;
  }[];

  const stockActual = db
    .prepare(
      `SELECT producto_id, nombre, stock_minimo, stock_actual
       FROM vista_stock_actual
       WHERE comercio_id = ?
       ORDER BY nombre ASC`
    )
    .all(actor.comercio_id) as unknown as {
    producto_id: string;
    nombre: string;
    stock_minimo: number;
    stock_actual: number;
  }[];

  const ventas = db
    .prepare(
      `SELECT id, fecha, subtotal, descuento, total, estado, canal, tipo_comprobante
       FROM ventas
       WHERE comercio_id = ?
       ORDER BY fecha DESC`
    )
    .all(actor.comercio_id) as unknown as {
    id: string;
    fecha: string;
    subtotal: Centavos;
    descuento: Centavos;
    total: Centavos;
    estado: string;
    canal: string;
    tipo_comprobante: string;
  }[];

  const sesionesCaja = db
    .prepare(
      `SELECT id, fecha_apertura, monto_inicial, fecha_cierre, efectivo_esperado, efectivo_contado, diferencia, estado
       FROM caja_sesiones
       WHERE comercio_id = ?
       ORDER BY fecha_apertura DESC`
    )
    .all(actor.comercio_id) as unknown as {
    id: string;
    fecha_apertura: string;
    monto_inicial: Centavos;
    fecha_cierre: string | null;
    efectivo_esperado: Centavos | null;
    efectivo_contado: Centavos | null;
    diferencia: Centavos | null;
    estado: string;
  }[];

  const hojas: HojaXlsxInput[] = [
    {
      nombre: 'Productos y Precios',
      encabezados: [
        'ID',
        'Código Interno',
        'Nombre',
        'Unidad',
        'Costo ($)',
        'Precio Venta ($)',
        'IVA (%)',
        'Stock Mínimo',
        'Activo',
      ],
      filas: productos.map((p) => [
        p.id,
        p.codigo_interno ?? '',
        p.nombre,
        p.unidad,
        formatearMonedaARS(p.costo_compra),
        formatearMonedaARS((p.precio_venta ?? 0) as Centavos),
        p.alicuota_iva,
        p.stock_minimo,
        p.activo === 1 ? 'Sí' : 'No',
      ]),
    },
    {
      nombre: 'Stock Actual',
      encabezados: ['Producto ID', 'Producto', 'Stock Mínimo', 'Stock Actual'],
      filas: stockActual.map((s) => [
        s.producto_id,
        s.nombre,
        s.stock_minimo,
        s.stock_actual,
      ]),
    },
    {
      nombre: 'Ventas',
      encabezados: [
        'ID Venta',
        'Fecha',
        'Subtotal ($)',
        'Descuento ($)',
        'Total ($)',
        'Estado',
        'Canal',
        'Comprobante',
      ],
      filas: ventas.map((v) => [
        v.id,
        v.fecha,
        formatearMonedaARS(v.subtotal),
        formatearMonedaARS(v.descuento),
        formatearMonedaARS(v.total),
        v.estado,
        v.canal,
        v.tipo_comprobante,
      ]),
    },
    {
      nombre: 'Caja Sesiones',
      encabezados: [
        'ID Sesión',
        'Apertura',
        'Monto Inicial ($)',
        'Cierre',
        'Esperado ($)',
        'Contado ($)',
        'Diferencia ($)',
        'Estado',
      ],
      filas: sesionesCaja.map((c) => [
        c.id,
        c.fecha_apertura,
        formatearMonedaARS(c.monto_inicial),
        c.fecha_cierre ?? '',
        c.efectivo_esperado !== null
          ? formatearMonedaARS(c.efectivo_esperado)
          : '',
        c.efectivo_contado !== null ? formatearMonedaARS(c.efectivo_contado) : '',
        c.diferencia !== null ? formatearMonedaARS(c.diferencia) : '',
        c.estado,
      ]),
    },
  ];

  ejecutarEnTransaccion(db, () => {
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'backup_exportar_todo_excel',
      entidad: 'comercios',
      entidad_id: actor.comercio_id,
      valores_despues: {
        productos_exportados: productos.length,
        ventas_exportadas: ventas.length,
        sesiones_caja_exportadas: sesionesCaja.length,
      },
    });
  });

  return generarLibroXlsx(hojas);
}
