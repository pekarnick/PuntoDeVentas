/**
 * Motor de Sincronización Offline-First (Push / Pull / Conflictos / Cola de Imágenes)
 * Cumple PLAN.md §3 (Reglas 6, 7, 8, 12, 13, 14) y §5 / §5.1.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  ORDEN_TABLAS_SYNC,
  calcularIndicadorEstadoSync,
  resolverConflictoRegistro,
  validarConfiguracionSupabaseCliente,
  type RegistroSincronizableBase,
  type ResumenEstadoSyncUI,
  type TablaSincronizable,
} from '../domain/sync.ts';
import { exigirPermiso } from '../domain/permisos.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  ejecutarEnTransaccion,
  insertarRegistroAuditoria,
  type ActorContexto,
} from '../db/repositorios.ts';
import {
  evaluarYEncolarBajadaImagenProducto,
  procesarColaSincronizacionImagenes,
  sincronizarColaLocalImagenesSubida,
  type ResultadoSyncImagenes,
  type TransporteImagenesNube,
} from './imagenes_sync.ts';

/**
 * Tablas con triggers BEFORE UPDATE en SQLite que prohíben cualquier UPDATE directo
 * sobre la fila una vez insertada. Su estado de sincronización se lleva en `sync_cola` y `sync_estado`.
 */
const TABLAS_INMUTABLES_SIN_UPDATE_FILA: ReadonlySet<TablaSincronizable> =
  new Set([
    'auditoria',
    'movimientos_stock',
    'ventas_items',
    'ventas_pagos',
  ]);

export interface AdaptadorNubeSupabase extends TransporteImagenesNube {
  estaDisponible(): Promise<boolean>;
  subirRegistrosTabla(
    tabla: TablaSincronizable,
    registros: RegistroSincronizableBase[]
  ): Promise<void>;
  bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]>;
}

/**
 * Simulador de nube Supabase en memoria para sincronización multi-terminal en tests
 * y modo demostrativo local sin internet.
 */
export class NubeSimuladaEnMemoria implements AdaptadorNubeSupabase {
  private tablas = new Map<
    TablaSincronizable,
    Map<string, RegistroSincronizableBase>
  >();
  private storageImagenes = new Map<string, Buffer>();
  private online = true;

  constructor() {
    for (const t of ORDEN_TABLAS_SYNC) {
      this.tablas.set(t, new Map());
    }
  }

  public fijarEstadoOnline(online: boolean): void {
    this.online = online;
  }

  public async estaDisponible(): Promise<boolean> {
    return this.online;
  }

  public async subirRegistrosTabla(
    tabla: TablaSincronizable,
    registros: RegistroSincronizableBase[]
  ): Promise<void> {
    if (!this.online) {
      throw new Error('Sin conexión con el servidor de sincronización.');
    }
    const mapa = this.tablas.get(tabla)!;
    for (const reg of registros) {
      const existente = mapa.get(reg.id);
      if (!existente) {
        mapa.set(reg.id, structuredClone(reg));
      } else {
        const res = resolverConflictoRegistro(tabla, existente, reg, true);
        mapa.set(reg.id, structuredClone(res.registroResultante));
      }
    }
  }

  public async bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]> {
    if (!this.online) {
      throw new Error('Sin conexión con el servidor de sincronización.');
    }
    const mapa = this.tablas.get(tabla)!;
    const resultado: RegistroSincronizableBase[] = [];
    for (const reg of mapa.values()) {
      const coincideComercio =
        tabla === 'comercios'
          ? reg.id === comercioId || reg.comercio_id === comercioId
          : reg.comercio_id === comercioId;
      if (!coincideComercio) continue;
      if (!desdeUpdatedAt || reg.updated_at >= desdeUpdatedAt) {
        resultado.push(structuredClone(reg));
      }
    }
    resultado.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return resultado;
  }

  public async subirArchivoImagen(
    comercioId: string,
    nombreArchivo: string,
    contenido: Buffer
  ): Promise<void> {
    if (!this.online) {
      throw new Error('Sin conexión con Supabase Storage.');
    }
    const ruta = `${comercioId}/${nombreArchivo}`;
    this.storageImagenes.set(ruta, Buffer.from(contenido));
  }

  public async bajarArchivoImagen(
    comercioId: string,
    nombreArchivo: string
  ): Promise<Buffer | null> {
    if (!this.online) {
      throw new Error('Sin conexión con Supabase Storage.');
    }
    const ruta = `${comercioId}/${nombreArchivo}`;
    const bytes = this.storageImagenes.get(ruta);
    return bytes ? Buffer.from(bytes) : null;
  }

  public obtenerCantidadArchivosStorage(): number {
    return this.storageImagenes.size;
  }
}

/**
 * Adaptador HTTP real contra Supabase PostgREST y Supabase Storage (bucket privado `productos`).
 * Regla 8: Exige clave pública `anon` y rechaza cualquier clave `service_role` o `sb_secret_`.
 */
export class AdaptadorSupabaseHttp implements AdaptadorNubeSupabase {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly accessToken: string;

  constructor(params: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    accessToken?: string;
  }) {
    const validacion = validarConfiguracionSupabaseCliente(
      params.supabaseUrl,
      params.supabaseAnonKey
    );
    if (!validacion.valida) {
      throw new Error(validacion.motivo ?? 'Configuración de Supabase inválida.');
    }
    this.baseUrl = params.supabaseUrl.replace(/\/+$/, '');
    this.anonKey = params.supabaseAnonKey.trim();
    this.accessToken = (params.accessToken ?? params.supabaseAnonKey).trim();
  }

  private cabecerasAuth(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.accessToken}`,
      ...extra,
    };
  }

  public async estaDisponible(): Promise<boolean> {
    if (!this.baseUrl || !this.anonKey) return false;
    try {
      const resp = await fetch(`${this.baseUrl}/rest/v1/`, {
        method: 'HEAD',
        headers: this.cabecerasAuth(),
        signal: AbortSignal.timeout(4000),
      });
      return resp.ok || resp.status === 401 || resp.status === 404;
    } catch {
      return false;
    }
  }

  public async subirRegistrosTabla(
    tabla: TablaSincronizable,
    registros: RegistroSincronizableBase[]
  ): Promise<void> {
    if (registros.length === 0) return;
    const url = `${this.baseUrl}/rest/v1/${tabla}?on_conflict=id`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.cabecerasAuth({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(registros),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(`Error HTTP ${resp.status} al subir ${tabla}: ${texto}`);
    }
  }

  public async bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]> {
    const filtroComercio =
      tabla === 'comercios'
        ? `id=eq.${encodeURIComponent(comercioId)}`
        : `comercio_id=eq.${encodeURIComponent(comercioId)}`;
    const filtroFecha = desdeUpdatedAt
      ? `&updated_at=gte.${encodeURIComponent(desdeUpdatedAt)}`
      : '';
    const url = `${this.baseUrl}/rest/v1/${tabla}?${filtroComercio}${filtroFecha}&order=updated_at.asc`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: this.cabecerasAuth({
        Accept: 'application/json',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(`Error HTTP ${resp.status} al bajar ${tabla}: ${texto}`);
    }

    return (await resp.json()) as RegistroSincronizableBase[];
  }

  public async subirArchivoImagen(
    comercioId: string,
    nombreArchivo: string,
    contenido: Buffer
  ): Promise<void> {
    const url = `${this.baseUrl}/storage/v1/object/productos/${encodeURIComponent(comercioId)}/${encodeURIComponent(nombreArchivo)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.cabecerasAuth({
        'Content-Type': 'image/webp',
        'x-upsert': 'true',
      }),
      body: new Uint8Array(contenido),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(
        `Error HTTP ${resp.status} al subir imagen ${nombreArchivo}: ${texto}`
      );
    }
  }

  public async bajarArchivoImagen(
    comercioId: string,
    nombreArchivo: string
  ): Promise<Buffer | null> {
    const url = `${this.baseUrl}/storage/v1/object/productos/${encodeURIComponent(comercioId)}/${encodeURIComponent(nombreArchivo)}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: this.cabecerasAuth(),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 404 || resp.status === 400) {
      return null;
    }
    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(
        `Error HTTP ${resp.status} al bajar imagen ${nombreArchivo}: ${texto}`
      );
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

/**
 * Escanea todas las tablas sincronizables buscando registros con `sync_status = 'pendiente'`
 * que aún no tengan una entrada activa en `sync_cola`, y los encola.
 */
export function recolectarPendientesLocalesEnCola(
  db: DatabaseSync,
  comercioId: string
): number {
  const ahora = new Date().toISOString();
  let nuevosEncolados = 0;

  for (const tabla of ORDEN_TABLAS_SYNC) {
    const colComercio = tabla === 'comercios' ? 'id' : 'comercio_id';

    if (TABLAS_INMUTABLES_SIN_UPDATE_FILA.has(tabla)) {
      // Para tablas estrictamente inmutables, verificamos si existe algún registro sin entrada en sync_cola
      const faltantes = db
        .prepare(
          `SELECT t.id, t.updated_at
           FROM ${tabla} t
           WHERE t.${colComercio} = ?
             AND t.sync_status = 'pendiente'
             AND NOT EXISTS (
               SELECT 1 FROM sync_cola sc
               WHERE sc.tabla = ? AND sc.registro_id = t.id
             )`
        )
        .all(comercioId, tabla) as unknown as {
        id: string;
        updated_at: string;
      }[];

      for (const f of faltantes) {
        db.prepare(
          `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
           VALUES (?, ?, ?, 'insert', ?, 'pendiente', 0)`
        ).run(generarUuidV7(), tabla, f.id, f.updated_at ?? ahora);
        nuevosEncolados++;
      }
      continue;
    }

    const pendientesTabla = db
      .prepare(
        `SELECT t.id, t.updated_at, t.deleted_at
         FROM ${tabla} t
         WHERE t.${colComercio} = ?
           AND t.sync_status = 'pendiente'
           AND NOT EXISTS (
             SELECT 1 FROM sync_cola sc
             WHERE sc.tabla = ?
               AND sc.registro_id = t.id
               AND sc.estado = 'pendiente'
           )`
      )
      .all(comercioId, tabla) as unknown as {
      id: string;
      updated_at: string;
      deleted_at: string | null;
    }[];

    for (const fila of pendientesTabla) {
      const op = fila.deleted_at ? 'delete_logico' : 'update';
      db.prepare(
        `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
         VALUES (?, ?, ?, ?, ?, 'pendiente', 0)`
      ).run(generarUuidV7(), tabla, fila.id, op, fila.updated_at ?? ahora);
      nuevosEncolados++;
    }
  }

  sincronizarColaLocalImagenesSubida(db, comercioId);
  return nuevosEncolados;
}

export interface ResultadoPushSync {
  registrosSubidos: number;
  tablasActualizadas: TablaSincronizable[];
  errores: string[];
}

/**
 * Sube (push) todos los registros pendientes en `sync_cola` hacia Supabase
 * respetando el orden topológico de integridad referencial.
 */
export async function ejecutarPushDatos(
  db: DatabaseSync,
  adaptador: AdaptadorNubeSupabase,
  actor: ActorContexto
): Promise<ResultadoPushSync> {
  recolectarPendientesLocalesEnCola(db, actor.comercio_id);

  const disponible = await adaptador.estaDisponible();
  if (!disponible) {
    return {
      registrosSubidos: 0,
      tablasActualizadas: [],
      errores: ['Sin conexión con el servidor de sincronización.'],
    };
  }

  let registrosSubidos = 0;
  const tablasActualizadas: TablaSincronizable[] = [];
  const errores: string[] = [];

  for (const tabla of ORDEN_TABLAS_SYNC) {
    const itemsCola = db
      .prepare(
        `SELECT DISTINCT registro_id
         FROM sync_cola
         WHERE tabla = ? AND estado IN ('pendiente', 'error')`
      )
      .all(tabla) as unknown as { registro_id: string }[];

    if (itemsCola.length === 0) continue;

    const registrosAEnviar: RegistroSincronizableBase[] = [];
    for (const item of itemsCola) {
      const fila = db
        .prepare(`SELECT * FROM ${tabla} WHERE id = ?`)
        .get(item.registro_id) as RegistroSincronizableBase | undefined;
      if (fila) {
        registrosAEnviar.push({
          ...fila,
          sync_status: 'sincronizado',
        });
      }
    }

    if (registrosAEnviar.length === 0) {
      db.prepare(
        `UPDATE sync_cola SET estado = 'sincronizado' WHERE tabla = ? AND estado IN ('pendiente', 'error')`
      ).run(tabla);
      continue;
    }

    try {
      await adaptador.subirRegistrosTabla(tabla, registrosAEnviar);
      const ahora = new Date().toISOString();

      ejecutarEnTransaccion(db, () => {
        for (const reg of registrosAEnviar) {
          if (!TABLAS_INMUTABLES_SIN_UPDATE_FILA.has(tabla)) {
            db.prepare(
              `UPDATE ${tabla} SET sync_status = 'sincronizado' WHERE id = ?`
            ).run(reg.id);
          }
          db.prepare(
            `UPDATE sync_cola
             SET estado = 'sincronizado', ultimo_error = NULL
             WHERE tabla = ? AND registro_id = ? AND estado IN ('pendiente', 'error')`
          ).run(tabla, reg.id);
        }

        db.prepare(
          `INSERT INTO sync_estado (tabla, ultima_bajada_at, ultima_subida_at)
           VALUES (?, NULL, ?)
           ON CONFLICT(tabla) DO UPDATE SET ultima_subida_at = excluded.ultima_subida_at`
        ).run(tabla, ahora);
      });

      registrosSubidos += registrosAEnviar.length;
      tablasActualizadas.push(tabla);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : `Error al subir tabla ${tabla}`;
      errores.push(msg);
      db.prepare(
        `UPDATE sync_cola
         SET estado = 'error',
             intentos = intentos + 1,
             ultimo_error = ?
         WHERE tabla = ? AND estado = 'pendiente'`
      ).run(msg, tabla);
    }
  }

  return {
    registrosSubidos,
    tablasActualizadas,
    errores,
  };
}

export interface ResultadoPullSync {
  registrosBajados: number;
  conflictosResueltos: number;
  imagenesEncoladasBajada: number;
  errores: string[];
}

function obtenerColumnasTabla(db: DatabaseSync, tabla: string): string[] {
  const info = db.prepare(`PRAGMA table_info(${tabla})`).all() as unknown as {
    name: string;
  }[];
  return info.map((c) => c.name);
}

function insertarFilaRemotaEnSQLite(
  db: DatabaseSync,
  tabla: TablaSincronizable,
  columnasTabla: string[],
  registro: RegistroSincronizableBase
): void {
  const registroGuardar: Record<string, unknown> = {
    ...registro,
    sync_status: 'sincronizado',
  };
  const colsPresentes = columnasTabla.filter((c) => c in registroGuardar);
  const placeholders = colsPresentes.map(() => '?').join(', ');
  const valores = colsPresentes.map((c) => {
    const v = registroGuardar[c];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v ?? null;
  });

  db.prepare(
    `INSERT INTO ${tabla} (${colsPresentes.join(', ')}) VALUES (${placeholders})`
  ).run(...(valores as (string | number | null)[]));
}

function actualizarFilaRemotaEnSQLite(
  db: DatabaseSync,
  tabla: TablaSincronizable,
  columnasTabla: string[],
  registro: RegistroSincronizableBase
): void {
  if (TABLAS_INMUTABLES_SIN_UPDATE_FILA.has(tabla)) {
    return;
  }

  const registroGuardar: Record<string, unknown> = {
    ...registro,
    sync_status: 'sincronizado',
  };

  let colsActualizar = columnasTabla.filter(
    (c) => c !== 'id' && c in registroGuardar
  );

  // En `ventas`, el trigger trg_ventas_proteger_importes protege subtotal, descuento, total, usuario_id y fecha
  if (tabla === 'ventas') {
    const permitidasVentas = new Set([
      'estado',
      'anulada_por_id',
      'autorizada_por_id',
      'fecha_anulacion',
      'motivo_anulacion',
      'punto_venta',
      'numero_comprobante',
      'cae',
      'cae_vencimiento',
      'estado_facturacion',
      'updated_at',
      'device_id',
      'sync_status',
    ]);
    colsActualizar = colsActualizar.filter((c) => permitidasVentas.has(c));
  }

  const asignaciones = colsActualizar.map((c) => `${c} = ?`).join(', ');
  const valores = colsActualizar.map((c) => {
    const v = registroGuardar[c];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v ?? null;
  });

  db.prepare(`UPDATE ${tabla} SET ${asignaciones} WHERE id = ?`).run(
    ...(valores as (string | number | null)[]),
    registro.id
  );
}

/**
 * Baja (pull) desde Supabase todos los registros con `updated_at` posterior
 * a la última sincronización, aplica las reglas de conflicto de PLAN.md §5
 * y registra cualquier conflicto resuelto en `auditoria`.
 */
export async function ejecutarPullDatos(
  db: DatabaseSync,
  adaptador: AdaptadorNubeSupabase,
  actor: ActorContexto,
  directorioBaseDatos: string
): Promise<ResultadoPullSync> {
  const disponible = await adaptador.estaDisponible();
  if (!disponible) {
    return {
      registrosBajados: 0,
      conflictosResueltos: 0,
      imagenesEncoladasBajada: 0,
      errores: ['Sin conexión con el servidor de sincronización.'],
    };
  }

  let registrosBajados = 0;
  let conflictosResueltos = 0;
  let imagenesEncoladasBajada = 0;
  const errores: string[] = [];

  for (const tabla of ORDEN_TABLAS_SYNC) {
    try {
      const estadoRow = db
        .prepare(`SELECT ultima_bajada_at FROM sync_estado WHERE tabla = ?`)
        .get(tabla) as { ultima_bajada_at: string | null } | undefined;

      const remotos = await adaptador.bajarRegistrosTabla(
        tabla,
        actor.comercio_id,
        estadoRow?.ultima_bajada_at ?? null
      );

      if (remotos.length === 0) {
        const ahoraVacio = new Date().toISOString();
        db.prepare(
          `INSERT INTO sync_estado (tabla, ultima_bajada_at, ultima_subida_at)
           VALUES (?, ?, NULL)
           ON CONFLICT(tabla) DO UPDATE SET ultima_bajada_at = excluded.ultima_bajada_at`
        ).run(tabla, ahoraVacio);
        continue;
      }

      const columnas = obtenerColumnasTabla(db, tabla);
      let maxUpdatedAt = estadoRow?.ultima_bajada_at ?? '';

      ejecutarEnTransaccion(db, () => {
        for (const remoto of remotos) {
          if (remoto.updated_at > maxUpdatedAt) {
            maxUpdatedAt = remoto.updated_at;
          }

          const local = db
            .prepare(`SELECT * FROM ${tabla} WHERE id = ?`)
            .get(remoto.id) as RegistroSincronizableBase | undefined;

          if (!local) {
            insertarFilaRemotaEnSQLite(db, tabla, columnas, remoto);
            registrosBajados++;
          } else {
            const tieneCambioPendienteLocal =
              local.sync_status === 'pendiente' ||
              Boolean(
                db
                  .prepare(
                    `SELECT 1 FROM sync_cola WHERE tabla = ? AND registro_id = ? AND estado = 'pendiente'`
                  )
                  .get(tabla, local.id)
              );

            const resolucion = resolverConflictoRegistro(
              tabla,
              local,
              remoto,
              tieneCambioPendienteLocal
            );

            if (resolucion.ganador !== 'sin_cambio') {
              actualizarFilaRemotaEnSQLite(
                db,
                tabla,
                columnas,
                resolucion.registroResultante
              );

              if (resolucion.ganador === 'remoto') {
                db.prepare(
                  `UPDATE sync_cola SET estado = 'sincronizado' WHERE tabla = ? AND registro_id = ? AND estado = 'pendiente'`
                ).run(tabla, local.id);
              } else if (
                resolucion.huboConflicto &&
                (resolucion.ganador === 'local' ||
                  resolucion.ganador === 'fusionado_restrictivo')
              ) {
                // El ganador local o fusionado tras un conflicto debe subirse en el próximo push para alinear la nube
                db.prepare(
                  `UPDATE ${tabla} SET sync_status = 'pendiente' WHERE id = ?`
                ).run(local.id);
              }
            }

            if (resolucion.huboConflicto) {
              conflictosResueltos++;
              insertarRegistroAuditoria(db, {
                actor,
                accion: 'sync_conflicto_resuelto',
                entidad: tabla,
                entidad_id: local.id,
                valores_antes: {
                  local_updated_at: local.updated_at,
                  local_device_id: local.device_id,
                  remoto_updated_at: remoto.updated_at,
                  remoto_device_id: remoto.device_id,
                },
                valores_despues: {
                  ganador: resolucion.ganador,
                  regla: resolucion.reglaAplicada,
                },
                motivo: resolucion.detalleAuditoria,
              });
            }
          }

          // Si es un producto, evaluar si su imagen remota debe descargarse en la cola de imágenes (PLAN.md §5.1)
          if (tabla === 'productos') {
            const encolada = evaluarYEncolarBajadaImagenProducto(db, {
              comercioId: actor.comercio_id,
              productoId: remoto.id,
              imagenPathRemoto: (remoto.imagen_path as string | null) ?? null,
              imagenHashRemoto: (remoto.imagen_hash as string | null) ?? null,
              directorioBaseDatos,
            });
            if (encolada) {
              imagenesEncoladasBajada++;
            }
          }
        }

        const tsBajada = maxUpdatedAt || new Date().toISOString();
        db.prepare(
          `INSERT INTO sync_estado (tabla, ultima_bajada_at, ultima_subida_at)
           VALUES (?, ?, NULL)
           ON CONFLICT(tabla) DO UPDATE SET ultima_bajada_at = excluded.ultima_bajada_at`
        ).run(tabla, tsBajada);
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : `Error al bajar tabla ${tabla}`;
      errores.push(msg);
    }
  }

  return {
    registrosBajados,
    conflictosResueltos,
    imagenesEncoladasBajada,
    errores,
  };
}

export interface ResultadoCicloSyncCompleto {
  push: ResultadoPushSync;
  pull: ResultadoPullSync;
  imagenes: ResultadoSyncImagenes;
  estadoUI: ResumenEstadoSyncUI;
}

/**
 * Ejecuta el ciclo completo de sincronización (PLAN.md §5 y §5.1):
 * 1. Push de datos pendientes.
 * 2. Pull de datos remotos y resolución de conflictos.
 * 3. Sincronización de imágenes en segundo plano (después de los datos).
 */
export async function ejecutarCicloSincronizacionCompleto(
  db: DatabaseSync,
  adaptador: AdaptadorNubeSupabase,
  actor: ActorContexto,
  directorioBaseDatos: string
): Promise<ResultadoCicloSyncCompleto> {
  const push = await ejecutarPushDatos(db, adaptador, actor);
  const pull = await ejecutarPullDatos(
    db,
    adaptador,
    actor,
    directorioBaseDatos
  );

  // Si un conflicto resuelto dejó cambios locales o fusionados por subir, hacer un push adicional rápido
  if (pull.conflictosResueltos > 0) {
    await ejecutarPushDatos(db, adaptador, actor);
  }

  // PLAN.md §5.1: Primero sincronizan los datos; las imágenes se transfieren después con su propia cola
  const imagenes = await procesarColaSincronizacionImagenes(db, adaptador, {
    comercioId: actor.comercio_id,
    directorioBaseDatos,
  });

  const online = await adaptador.estaDisponible();
  const estadoUI = obtenerResumenEstadoSyncDb(db, actor.comercio_id, !online);

  return {
    push,
    pull,
    imagenes,
    estadoUI,
  };
}

/**
 * Consulta en SQLite los contadores reales de `sync_cola`, `sync_imagenes_cola` y `sync_estado`
 * y devuelve el indicador de estado oficial para la barra superior (PLAN.md §5).
 */
export function obtenerResumenEstadoSyncDb(
  db: DatabaseSync,
  comercioId: string,
  sinConexion = false
): ResumenEstadoSyncUI {
  recolectarPendientesLocalesEnCola(db, comercioId);

  const datosPendRow = db
    .prepare(
      `SELECT COUNT(DISTINCT tabla || ':' || registro_id) AS cant
       FROM sync_cola
       WHERE estado = 'pendiente'`
    )
    .get() as { cant: number };

  const imgsPendRow = db
    .prepare(
      `SELECT COUNT(*) AS cant
       FROM sync_imagenes_cola
       WHERE comercio_id = ? AND estado = 'pendiente'`
    )
    .get(comercioId) as { cant: number };

  const erroresDatosRow = db
    .prepare(
      `SELECT COUNT(*) AS cant, MAX(ultimo_error) AS ultimo_error
       FROM sync_cola
       WHERE estado = 'error'`
    )
    .get() as { cant: number; ultimo_error: string | null };

  const erroresImgsRow = db
    .prepare(
      `SELECT COUNT(*) AS cant, MAX(ultimo_error) AS ultimo_error
       FROM sync_imagenes_cola
       WHERE comercio_id = ? AND estado = 'error'`
    )
    .get(comercioId) as { cant: number; ultimo_error: string | null };

  const tiemposRow = db
    .prepare(
      `SELECT MAX(ultima_subida_at) AS max_subida, MAX(ultima_bajada_at) AS max_bajada
       FROM sync_estado`
    )
    .get() as { max_subida: string | null; max_bajada: string | null };

  return calcularIndicadorEstadoSync({
    sinConexion,
    datosPendientes: datosPendRow.cant ?? 0,
    imagenesPendientes: imgsPendRow.cant ?? 0,
    erroresCount: (erroresDatosRow.cant ?? 0) + (erroresImgsRow.cant ?? 0),
    ultimoErrorDetalle:
      erroresDatosRow.ultimo_error ?? erroresImgsRow.ultimo_error ?? null,
    ultimaSubidaAt: tiemposRow.max_subida ?? null,
    ultimaBajadaAt: tiemposRow.max_bajada ?? null,
  });
}

export interface ConfiguracionSistemaLocal {
  comercio_id: string;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  sync_automatico_habilitado: boolean;
  sync_intervalo_minutos: number;
  carpeta_backups: string;
  backup_diario_habilitado: boolean;
  ultimo_backup_at: string | null;
  ultimo_backup_archivo: string | null;
  updated_at: string;
}

export function obtenerConfiguracionSistema(
  db: DatabaseSync,
  comercioId: string
): ConfiguracionSistemaLocal {
  const fila = db
    .prepare(`SELECT * FROM configuracion_sistema WHERE comercio_id = ?`)
    .get(comercioId) as
    | {
        comercio_id: string;
        supabase_url: string | null;
        supabase_anon_key: string | null;
        sync_automatico_habilitado: number;
        sync_intervalo_minutos: number;
        carpeta_backups: string;
        backup_diario_habilitado: number;
        ultimo_backup_at: string | null;
        ultimo_backup_archivo: string | null;
        updated_at: string;
      }
    | undefined;

  if (!fila) {
    const ahora = new Date().toISOString();
    db.prepare(
      `INSERT INTO configuracion_sistema (
        comercio_id, supabase_url, supabase_anon_key,
        sync_automatico_habilitado, sync_intervalo_minutos,
        carpeta_backups, backup_diario_habilitado,
        ultimo_backup_at, ultimo_backup_archivo, updated_at
      ) VALUES (?, NULL, NULL, 1, 5, 'backups', 1, NULL, NULL, ?)`
    ).run(comercioId, ahora);

    return {
      comercio_id: comercioId,
      supabase_url: null,
      supabase_anon_key: null,
      sync_automatico_habilitado: true,
      sync_intervalo_minutos: 5,
      carpeta_backups: 'backups',
      backup_diario_habilitado: true,
      ultimo_backup_at: null,
      ultimo_backup_archivo: null,
      updated_at: ahora,
    };
  }

  return {
    comercio_id: fila.comercio_id,
    supabase_url: fila.supabase_url,
    supabase_anon_key: fila.supabase_anon_key,
    sync_automatico_habilitado: fila.sync_automatico_habilitado === 1,
    sync_intervalo_minutos: fila.sync_intervalo_minutos,
    carpeta_backups: fila.carpeta_backups,
    backup_diario_habilitado: fila.backup_diario_habilitado === 1,
    ultimo_backup_at: fila.ultimo_backup_at,
    ultimo_backup_archivo: fila.ultimo_backup_archivo,
    updated_at: fila.updated_at,
  };
}

/**
 * Guarda la configuración de sincronización y backups (PLAN.md §6.1: solo `superadmin`).
 * Valida la Regla 8 (prohibido guardar claves de servicio / secretas de Supabase) y audita el cambio.
 */
export function guardarConfiguracionSistema(
  db: DatabaseSync,
  actor: ActorContexto,
  input: {
    supabaseUrl?: string | null;
    supabaseAnonKey?: string | null;
    syncAutomaticoHabilitado?: boolean;
    syncIntervaloMinutos?: number;
    carpetaBackups?: string;
    backupDiarioHabilitado?: boolean;
  }
): ConfiguracionSistemaLocal {
  exigirPermiso(actor.rol, 'configuracion_sensible');

  const actual = obtenerConfiguracionSistema(db, actor.comercio_id);
  const nuevaUrl =
    input.supabaseUrl !== undefined
      ? input.supabaseUrl?.trim() || null
      : actual.supabase_url;
  const nuevaAnonKey =
    input.supabaseAnonKey !== undefined
      ? input.supabaseAnonKey?.trim() || null
      : actual.supabase_anon_key;

  const validacion = validarConfiguracionSupabaseCliente(
    nuevaUrl,
    nuevaAnonKey
  );
  if (!validacion.valida) {
    throw new Error(validacion.motivo);
  }

  const syncAuto =
    input.syncAutomaticoHabilitado ?? actual.sync_automatico_habilitado;
  const intervalo = Math.max(
    1,
    Math.min(1440, Math.trunc(input.syncIntervaloMinutos ?? actual.sync_intervalo_minutos))
  );
  const carpetaBackups =
    (input.carpetaBackups ?? actual.carpeta_backups).trim() || 'backups';
  const backupDiario =
    input.backupDiarioHabilitado ?? actual.backup_diario_habilitado;

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();

    db.prepare(
      `UPDATE configuracion_sistema
       SET supabase_url = ?,
           supabase_anon_key = ?,
           sync_automatico_habilitado = ?,
           sync_intervalo_minutos = ?,
           carpeta_backups = ?,
           backup_diario_habilitado = ?,
           updated_at = ?
       WHERE comercio_id = ?`
    ).run(
      nuevaUrl,
      nuevaAnonKey,
      syncAuto ? 1 : 0,
      intervalo,
      carpetaBackups,
      backupDiario ? 1 : 0,
      ahora,
      actor.comercio_id
    );

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'configuracion_actualizar',
      entidad: 'configuracion_sistema',
      entidad_id: actor.comercio_id,
      valores_antes: {
        supabase_url: actual.supabase_url,
        sync_automatico_habilitado: actual.sync_automatico_habilitado,
        sync_intervalo_minutos: actual.sync_intervalo_minutos,
        carpeta_backups: actual.carpeta_backups,
        backup_diario_habilitado: actual.backup_diario_habilitado,
      },
      valores_despues: {
        supabase_url: nuevaUrl,
        sync_automatico_habilitado: syncAuto,
        sync_intervalo_minutos: intervalo,
        carpeta_backups: carpetaBackups,
        backup_diario_habilitado: backupDiario,
      },
    });

    return obtenerConfiguracionSistema(db, actor.comercio_id);
  });
}
