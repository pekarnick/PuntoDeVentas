/**
 * Motor de Sincronización Offline-First (Push / Pull / Conflictos / Cola de Imágenes)
 * Cumple PLAN.md §3 (Reglas 6, 7, 8, 12, 13, 14) y §5 / §5.1.
 */

import fs from 'node:fs';
import path from 'node:path';
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
import {
  AdaptadorFirebaseFirestoreHttp,
  AdaptadorNubeMultiProveedor,
  validarConfiguracionFirebaseCliente,
  type ProveedorNubeSync,
} from './adaptador_firebase.ts';

export {
  AdaptadorFirebaseFirestoreHttp,
  AdaptadorNubeMultiProveedor,
  validarConfiguracionFirebaseCliente,
  type ProveedorNubeSync,
};

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

/**
 * Tablas agregadas en Fases 3b y 4 que pueden aún no estar creadas en un proyecto
 * Supabase que solo ejecutó la migración 001. Si devuelven PGRST205 (404), se omiten
 * sin bloquear la sincronización del catálogo y ventas.
 */
const TABLAS_OPCIONALES_ESQUEMA_REMOTO: ReadonlySet<TablaSincronizable> =
  new Set([
    'sesiones_moviles',
    'variantes',
    'combos',
    'combos_items',
  ]);

export const COMERCIO_ID_RESPALDO_CONOCIDO =
  '01a15523-8a7c-72f7-b1f4-e5da18b7be0a';

export interface IdentidadComercioPersistida {
  comercio_id: string;
  superadmin_id?: string;
  lista_precio_id?: string;
  supabase_url?: string | null;
  supabase_anon_key?: string | null;
  updated_at: string;
}

export function leerIdentidadComercioPersistida(
  directorioBaseDatos: string
): IdentidadComercioPersistida | null {
  try {
    const ruta = path.join(directorioBaseDatos, 'comercio_identidad.json');
    if (!fs.existsSync(ruta)) return null;
    const raw = fs.readFileSync(ruta, 'utf-8');
    const parsed = JSON.parse(raw) as IdentidadComercioPersistida;
    if (parsed && typeof parsed.comercio_id === 'string' && parsed.comercio_id) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function guardarIdentidadComercioPersistida(
  directorioBaseDatos: string,
  datos: Omit<IdentidadComercioPersistida, 'updated_at'>
): void {
  try {
    if (!directorioBaseDatos || directorioBaseDatos === ':memory:') return;
    fs.mkdirSync(directorioBaseDatos, { recursive: true });
    const previo = leerIdentidadComercioPersistida(directorioBaseDatos);
    const ruta = path.join(directorioBaseDatos, 'comercio_identidad.json');
    const fusionado: IdentidadComercioPersistida = {
      comercio_id: datos.comercio_id,
      superadmin_id: datos.superadmin_id ?? previo?.superadmin_id,
      lista_precio_id: datos.lista_precio_id ?? previo?.lista_precio_id,
      supabase_url:
        datos.supabase_url !== undefined
          ? datos.supabase_url
          : previo?.supabase_url,
      supabase_anon_key:
        datos.supabase_anon_key !== undefined
          ? datos.supabase_anon_key
          : previo?.supabase_anon_key,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(ruta, JSON.stringify(fusionado, null, 2), 'utf-8');
  } catch {
    // Ignorar en entornos de solo lectura o memoria
  }
}

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
  descubrirComercioRemoto?(
    candidatosComercioId?: readonly string[]
  ): Promise<RegistroSincronizableBase | null>;
  vaciarDatosComercioRemoto?(params: {
    comercioId: string;
    superadminIdConservar: string;
    listaPrecioIdConservar: string;
  }): Promise<{ tablasVaciadas: number; advertencias: string[] }>;
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

  public async descubrirComercioRemoto(): Promise<RegistroSincronizableBase | null> {
    if (!this.online) return null;
    const mapa = this.tablas.get('comercios')!;
    for (const reg of mapa.values()) {
      if (!reg.deleted_at) {
        return structuredClone(reg);
      }
    }
    return null;
  }

  public async vaciarDatosComercioRemoto(params: {
    comercioId: string;
    superadminIdConservar: string;
    listaPrecioIdConservar: string;
  }): Promise<{ tablasVaciadas: number; advertencias: string[] }> {
    if (!this.online) {
      throw new Error('Sin conexión con el servidor de sincronización.');
    }
    let tablasVaciadas = 0;
    for (const tabla of ORDEN_TABLAS_SYNC) {
      if (tabla === 'comercios') continue;
      const mapa = this.tablas.get(tabla)!;
      for (const [id, reg] of [...mapa.entries()]) {
        if (reg.comercio_id !== params.comercioId) continue;
        if (tabla === 'usuarios' && id === params.superadminIdConservar) {
          continue;
        }
        if (tabla === 'listas_precio' && id === params.listaPrecioIdConservar) {
          continue;
        }
        mapa.delete(id);
      }
      tablasVaciadas++;
    }
    for (const k of [...this.storageImagenes.keys()]) {
      if (k.startsWith(`${params.comercioId}/`)) {
        this.storageImagenes.delete(k);
      }
    }
    return { tablasVaciadas, advertencias: [] };
  }
}

const CAMPOS_BOOLEANOS_POSTGRES: ReadonlySet<string> = new Set([
  'precios_incluyen_iva',
  'venta_movil_habilitada',
  'arca_habilitada',
  'puede_vender_movil',
  'activo',
  'debe_cambiar_clave',
  'permite_decimales',
  'exento_iva',
  'boton_rapido',
  'es_predeterminada',
]);

function serializarRegistroParaPostgres(
  tabla: TablaSincronizable,
  reg: RegistroSincronizableBase
): Record<string, unknown> {
  const copia: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(reg)) {
    if (tabla === 'precios' && k === 'margen_bp') {
      copia.margen_porcentaje =
        typeof v === 'number' ? Number((v / 100).toFixed(2)) : null;
      continue;
    }
    if (tabla === 'cuenta_corriente_movimientos' && k === 'observaciones') {
      continue;
    }
    if (CAMPOS_BOOLEANOS_POSTGRES.has(k) && (v === 0 || v === 1)) {
      copia[k] = v === 1;
    } else if (k === 'rubro' && (v === null || v === undefined || v === '')) {
      copia[k] = 'general';
    } else {
      copia[k] = v;
    }
  }
  return copia;
}

function normalizarRegistroDesdePostgres(
  tabla: TablaSincronizable,
  reg: Record<string, unknown>
): RegistroSincronizableBase {
  const copia: Record<string, unknown> = { ...reg };
  if (
    tabla === 'precios' &&
    'margen_porcentaje' in copia &&
    !('margen_bp' in copia)
  ) {
    const mp = copia.margen_porcentaje;
    copia.margen_bp =
      mp !== null && mp !== undefined && !Number.isNaN(Number(mp))
        ? Math.round(Number(mp) * 100)
        : null;
  }
  return copia as RegistroSincronizableBase;
}

/**
 * Adaptador inactivo cuando aún no se configuró la URL y Anon Key de Supabase.
 * Mantiene todos los cambios en `sync_cola` como `pendiente` sin marcarlos falsamente como sincronizados.
 */
export class NubeSinConfigurar implements AdaptadorNubeSupabase {
  public async estaDisponible(): Promise<boolean> {
    return false;
  }

  public async subirRegistrosTabla(): Promise<void> {
    throw new Error('Supabase no está configurado todavía.');
  }

  public async bajarRegistrosTabla(): Promise<RegistroSincronizableBase[]> {
    throw new Error('Supabase no está configurado todavía.');
  }

  public async subirArchivoImagen(): Promise<void> {
    throw new Error('Supabase Storage no está configurado todavía.');
  }

  public async bajarArchivoImagen(): Promise<Buffer | null> {
    throw new Error('Supabase Storage no está configurado todavía.');
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
  private comercioId: string;
  private readonly rolUsuario: string;
  private readonly columnasNoExistentesPorTabla = new Map<
    TablaSincronizable,
    Set<string>
  >();

  constructor(params: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    accessToken?: string;
    comercioId?: string;
    rolUsuario?: string;
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
    this.comercioId = params.comercioId ?? '';
    this.rolUsuario = params.rolUsuario ?? 'superadmin';
  }

  private cabecerasAuth(
    extra?: Record<string, string>,
    comercioIdOverride?: string
  ): Record<string, string> {
    const cid = comercioIdOverride ?? this.comercioId;
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.accessToken}`,
      ...(cid ? { 'x-comercio-id': cid } : {}),
      ...(this.rolUsuario ? { 'x-rol-usuario': this.rolUsuario } : {}),
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

    const cidEfectivo =
      tabla === 'comercios'
        ? String(registros[0]?.id ?? this.comercioId)
        : String(registros[0]?.comercio_id ?? this.comercioId);
    if (cidEfectivo) {
      this.comercioId = cidEfectivo;
    }

    const url = `${this.baseUrl}/rest/v1/${tabla}?on_conflict=id`;
    const resolucion = TABLAS_INMUTABLES_SIN_UPDATE_FILA.has(tabla)
      ? 'resolution=ignore-duplicates,return=minimal'
      : 'resolution=merge-duplicates,return=minimal';

    const tamanoLote = 250;
    for (let offset = 0; offset < registros.length; offset += tamanoLote) {
      const lote = registros.slice(offset, offset + tamanoLote);
      await this.subirLoteConToleranciaEsquema(
        tabla,
        url,
        resolucion,
        lote,
        cidEfectivo
      );
    }
  }

  private async subirLoteConToleranciaEsquema(
    tabla: TablaSincronizable,
    url: string,
    resolucion: string,
    lote: RegistroSincronizableBase[],
    comercioIdHeader: string
  ): Promise<void> {
    let columnasOmitidas = this.columnasNoExistentesPorTabla.get(tabla);
    if (!columnasOmitidas) {
      columnasOmitidas = new Set<string>();
      this.columnasNoExistentesPorTabla.set(tabla, columnasOmitidas);
    }

    for (let intento = 0; intento < 12; intento++) {
      const payloadPostgres = lote.map((r) => {
        const serializado = serializarRegistroParaPostgres(tabla, r);
        for (const colOmitir of columnasOmitidas!) {
          delete serializado[colOmitir];
        }
        return serializado;
      });

      const resp = await fetch(url, {
        method: 'POST',
        headers: this.cabecerasAuth(
          {
            'Content-Type': 'application/json',
            Prefer: resolucion,
          },
          comercioIdHeader
        ),
        body: JSON.stringify(payloadPostgres),
        signal: AbortSignal.timeout(15000),
      });

      if (resp.ok) {
        return;
      }

      const texto = await resp.text();

      // Si es una tabla opcional de Fases 3b/4 aún no creada en Supabase (PGRST205 / 404), no bloquear
      if (
        (resp.status === 404 || texto.includes('PGRST205')) &&
        TABLAS_OPCIONALES_ESQUEMA_REMOTO.has(tabla)
      ) {
        return;
      }

      // Si falta una columna nueva en el esquema remoto de Supabase (PGRST204), omitirla y reintentar
      if (resp.status === 400 && texto.includes('PGRST204')) {
        const matchCol = texto.match(
          /Could not find the '([^']+)' column of '([^']+)'/i
        );
        if (matchCol && matchCol[1] && !columnasOmitidas.has(matchCol[1])) {
          columnasOmitidas.add(matchCol[1]);
          continue;
        }
      }

      throw new Error(`Error HTTP ${resp.status} al subir ${tabla}: ${texto}`);
    }
  }

  public async bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]> {
    if (comercioId) {
      this.comercioId = comercioId;
    }
    const filtroComercio =
      tabla === 'comercios'
        ? `id=eq.${encodeURIComponent(comercioId)}`
        : `comercio_id=eq.${encodeURIComponent(comercioId)}`;
    const filtroFecha = desdeUpdatedAt
      ? `&updated_at=gte.${encodeURIComponent(desdeUpdatedAt)}`
      : '';

    const acumulado: RegistroSincronizableBase[] = [];
    const limitePagina = 1000;
    let offset = 0;

    while (true) {
      const url = `${this.baseUrl}/rest/v1/${tabla}?${filtroComercio}${filtroFecha}&order=updated_at.asc&limit=${limitePagina}&offset=${offset}`;

      const resp = await fetch(url, {
        method: 'GET',
        headers: this.cabecerasAuth(
          {
            Accept: 'application/json',
          },
          comercioId
        ),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const texto = await resp.text();
        if (
          (resp.status === 404 || texto.includes('PGRST205')) &&
          TABLAS_OPCIONALES_ESQUEMA_REMOTO.has(tabla)
        ) {
          return [];
        }
        throw new Error(`Error HTTP ${resp.status} al bajar ${tabla}: ${texto}`);
      }

      const filas = (await resp.json()) as Record<string, unknown>[];
      for (const f of filas) {
        acumulado.push(normalizarRegistroDesdePostgres(tabla, f));
      }

      if (filas.length < limitePagina) {
        break;
      }
      offset += limitePagina;
    }

    return acumulado;
  }

  public async descubrirComercioRemoto(
    candidatosComercioId: readonly string[] = []
  ): Promise<RegistroSincronizableBase | null> {
    const candidatos = Array.from(
      new Set(
        [
          ...candidatosComercioId,
          COMERCIO_ID_RESPALDO_CONOCIDO,
          this.comercioId,
        ].filter((id): id is string => Boolean(id && id.trim()))
      )
    );

    let comercioRespaldo: RegistroSincronizableBase | null = null;

    for (const cid of candidatos) {
      try {
        const resp = await fetch(
          `${this.baseUrl}/rest/v1/comercios?deleted_at=is.null&order=created_at.asc&limit=1`,
          {
            method: 'GET',
            headers: this.cabecerasAuth(
              { Accept: 'application/json' },
              cid
            ),
            signal: AbortSignal.timeout(8000),
          }
        );
        if (resp.ok) {
          const filas = (await resp.json()) as Record<string, unknown>[];
          if (filas.length > 0 && filas[0]) {
            const encontrado = normalizarRegistroDesdePostgres(
              'comercios',
              filas[0]
            );
            if (!comercioRespaldo) {
              comercioRespaldo = encontrado;
            }
            // Verificar si este comercio tiene catálogo en la nube
            const respProds = await fetch(
              `${this.baseUrl}/rest/v1/productos?comercio_id=eq.${encodeURIComponent(encontrado.id)}&select=id&limit=1`,
              {
                method: 'GET',
                headers: this.cabecerasAuth(
                  { Accept: 'application/json' },
                  encontrado.id
                ),
                signal: AbortSignal.timeout(6000),
              }
            );
            if (respProds.ok) {
              const prods = (await respProds.json()) as unknown[];
              if (prods.length > 0) {
                this.comercioId = encontrado.id;
                return encontrado;
              }
            }
          }
        }
      } catch {
        // Continuar probando siguiente candidato
      }
    }

    if (comercioRespaldo) {
      this.comercioId = comercioRespaldo.id;
    }
    return comercioRespaldo;
  }

  public async vaciarDatosComercioRemoto(params: {
    comercioId: string;
    superadminIdConservar: string;
    listaPrecioIdConservar: string;
  }): Promise<{ tablasVaciadas: number; advertencias: string[] }> {
    const cid = params.comercioId;
    this.comercioId = cid;
    const advertencias: string[] = [];
    let tablasVaciadas = 0;

    // 1. Intentar primero el RPC transaccional en servidor si la migración fue aplicada
    try {
      const respRpc = await fetch(
        `${this.baseUrl}/rest/v1/rpc/resetear_comercio_a_fabrica`,
        {
          method: 'POST',
          headers: this.cabecerasAuth(
            { 'Content-Type': 'application/json' },
            cid
          ),
          body: JSON.stringify({
            p_comercio_id: cid,
            p_superadmin_id: params.superadminIdConservar,
            p_lista_precio_id: params.listaPrecioIdConservar,
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (respRpc.ok) {
        return { tablasVaciadas: ORDEN_TABLAS_SYNC.length - 1, advertencias };
      }
    } catch {
      // Si el RPC no está creado aún en Supabase, vaciar tabla por tabla vía REST
    }

    // 2. Vaciado directo tabla por tabla en orden inverso de dependencias
    const ordenBorrado: TablaSincronizable[] = [
      'ventas_pagos',
      'ventas_items',
      'ventas',
      'caja_movimientos',
      'caja_sesiones',
      'cuenta_corriente_movimientos',
      'clientes',
      'compras_items',
      'compras',
      'movimientos_stock',
      'combos_items',
      'combos',
      'variantes',
      'precios',
      'codigos_barras',
      'productos',
      'proveedores',
      'marcas',
      'categorias',
      'sesiones_moviles',
      'dispositivos',
      'auditoria',
    ];

    const ahoraIso = new Date().toISOString();

    for (const tabla of ordenBorrado) {
      try {
        const respDel = await fetch(
          `${this.baseUrl}/rest/v1/${tabla}?comercio_id=eq.${encodeURIComponent(cid)}`,
          {
            method: 'DELETE',
            headers: this.cabecerasAuth(undefined, cid),
            signal: AbortSignal.timeout(12000),
          }
        );

        if (respDel.ok) {
          tablasVaciadas++;
          continue;
        }

        const txt = await respDel.text();
        if (respDel.status === 404 || txt.includes('PGRST205')) {
          continue;
        }

        // Si un trigger append-only o FK impide el DELETE físico sin el RPC instalado,
        // aplicar borrado lógico (deleted_at) en las tablas de catálogo/entidades
        if (!TABLAS_INMUTABLES_SIN_UPDATE_FILA.has(tabla)) {
          const bodySoftDelete: Record<string, unknown> = {
            deleted_at: ahoraIso,
            updated_at: ahoraIso,
            ...(tabla === 'productos' ? { activo: false } : {}),
          };
          const respPatch = await fetch(
            `${this.baseUrl}/rest/v1/${tabla}?comercio_id=eq.${encodeURIComponent(cid)}&deleted_at=is.null`,
            {
              method: 'PATCH',
              headers: this.cabecerasAuth(
                { 'Content-Type': 'application/json' },
                cid
              ),
              body: JSON.stringify(bodySoftDelete),
              signal: AbortSignal.timeout(12000),
            }
          );
          if (respPatch.ok) {
            tablasVaciadas++;
          }
        }
      } catch (err) {
        advertencias.push(
          err instanceof Error ? err.message : `No se pudo vaciar ${tabla}`
        );
      }
    }

    // 3. Limpiar usuarios secundarios y listas de precios no predeterminadas en Supabase
    try {
      await fetch(
        `${this.baseUrl}/rest/v1/usuarios?comercio_id=eq.${encodeURIComponent(cid)}&id=neq.${encodeURIComponent(params.superadminIdConservar)}`,
        {
          method: 'DELETE',
          headers: this.cabecerasAuth(undefined, cid),
          signal: AbortSignal.timeout(10000),
        }
      );
      await fetch(
        `${this.baseUrl}/rest/v1/listas_precio?comercio_id=eq.${encodeURIComponent(cid)}&id=neq.${encodeURIComponent(params.listaPrecioIdConservar)}`,
        {
          method: 'DELETE',
          headers: this.cabecerasAuth(undefined, cid),
          signal: AbortSignal.timeout(10000),
        }
      );
    } catch {
      // Ignorar si están referenciados
    }

    return { tablasVaciadas, advertencias };
  }

  public async subirArchivoImagen(
    comercioId: string,
    nombreArchivo: string,
    contenido: Buffer
  ): Promise<void> {
    const url = `${this.baseUrl}/storage/v1/object/productos/${encodeURIComponent(comercioId)}/${encodeURIComponent(nombreArchivo)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.cabecerasAuth(
        {
          'Content-Type': 'image/webp',
          'x-upsert': 'true',
        },
        comercioId
      ),
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
      headers: this.cabecerasAuth(undefined, comercioId),
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

/**
 * Re-encola todos los registros locales del comercio en `sync_cola` respetando el orden topológico.
 * Se utiliza cuando se configura por primera vez la URL de Supabase o cuando el servidor remoto
 * reporta que una tabla padre (ej. `comercios`) aún no fue cargada (`23503`).
 */
export function reencolarComercioCompletoParaSync(
  db: DatabaseSync,
  comercioId: string
): void {
  ejecutarEnTransaccion(db, () => {
    for (const tabla of ORDEN_TABLAS_SYNC) {
      const colComercio = tabla === 'comercios' ? 'id' : 'comercio_id';
      if (!TABLAS_INMUTABLES_SIN_UPDATE_FILA.has(tabla)) {
        db.prepare(
          `UPDATE ${tabla} SET sync_status = 'pendiente' WHERE ${colComercio} = ?`
        ).run(comercioId);
      }
    }

    db.prepare(
      `UPDATE sync_cola SET estado = 'pendiente', ultimo_error = NULL WHERE estado IN ('sincronizado', 'error')`
    ).run();
    db.prepare(`DELETE FROM sync_estado`).run();
  });

  recolectarPendientesLocalesEnCola(db, comercioId);
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
  actor: ActorContexto,
  reintentoPadresAplicado = false
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
        `UPDATE sync_cola SET estado = 'sincronizado', ultimo_error = NULL WHERE tabla = ? AND estado IN ('pendiente', 'error')`
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

      // Si una tabla hija falla por 23503 (clave foránea faltante en Supabase porque las tablas padres
      // se habían marcado como sincronizadas antes de conectar Supabase), re-encolar todo el comercio
      // en orden topológico y reintentar una única vez de forma transparente.
      if (!reintentoPadresAplicado && msg.includes('23503')) {
        reencolarComercioCompletoParaSync(db, actor.comercio_id);
        return ejecutarPushDatos(db, adaptador, actor, true);
      }

      errores.push(msg);
      db.prepare(
        `UPDATE sync_cola
         SET estado = 'error',
             intentos = intentos + 1,
             ultimo_error = ?
         WHERE tabla = ? AND estado IN ('pendiente', 'error')`
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
  // Evitar colisiones por índices únicos de negocio al bajar desde la nube a una base inicializada
  if (tabla === 'usuarios' && typeof registro.usuario === 'string') {
    const dupUsuario = db
      .prepare(
        `SELECT id FROM usuarios
         WHERE comercio_id = ? AND lower(usuario) = lower(?) AND id != ?
         LIMIT 1`
      )
      .get(registro.comercio_id, registro.usuario, registro.id) as
      | { id: string }
      | undefined;

    if (dupUsuario) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        db.prepare(`UPDATE auditoria SET usuario_id = ? WHERE usuario_id = ?`).run(
          registro.id,
          dupUsuario.id
        );
        db.prepare(
          `UPDATE movimientos_stock SET usuario_id = ? WHERE usuario_id = ?`
        ).run(registro.id, dupUsuario.id);
        db.prepare(
          `UPDATE caja_sesiones SET usuario_apertura_id = ? WHERE usuario_apertura_id = ?`
        ).run(registro.id, dupUsuario.id);
        db.prepare(`UPDATE ventas SET usuario_id = ? WHERE usuario_id = ?`).run(
          registro.id,
          dupUsuario.id
        );
        db.prepare(`UPDATE usuarios SET id = ? WHERE id = ?`).run(
          registro.id,
          dupUsuario.id
        );
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
      actualizarFilaRemotaEnSQLite(db, tabla, columnasTabla, registro);
      return;
    }
  } else if (tabla === 'listas_precio') {
    const esPred =
      registro.es_predeterminada === 1 || registro.es_predeterminada === true;
    const dupLista = db
      .prepare(
        `SELECT id FROM listas_precio
         WHERE comercio_id = ?
           AND id != ?
           AND (lower(nombre) = lower(?) OR (? = 1 AND es_predeterminada = 1))
         LIMIT 1`
      )
      .get(
        registro.comercio_id,
        registro.id,
        String(registro.nombre ?? ''),
        esPred ? 1 : 0
      ) as { id: string } | undefined;

    if (dupLista) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        db.prepare(
          `UPDATE precios SET lista_precio_id = ? WHERE lista_precio_id = ?`
        ).run(registro.id, dupLista.id);
        db.prepare(`UPDATE listas_precio SET id = ? WHERE id = ?`).run(
          registro.id,
          dupLista.id
        );
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
      actualizarFilaRemotaEnSQLite(db, tabla, columnasTabla, registro);
      return;
    }
  } else if (
    tabla === 'codigos_barras' &&
    typeof registro.codigo === 'string' &&
    !registro.deleted_at
  ) {
    const dupCodigo = db
      .prepare(
        `SELECT id FROM codigos_barras
         WHERE comercio_id = ? AND codigo = ? AND deleted_at IS NULL AND id != ?
         LIMIT 1`
      )
      .get(registro.comercio_id, registro.codigo, registro.id) as
      | { id: string }
      | undefined;

    if (dupCodigo) {
      db.prepare(`DELETE FROM codigos_barras WHERE id = ?`).run(dupCodigo.id);
    }
  } else if (
    tabla === 'precios' &&
    typeof registro.producto_id === 'string' &&
    typeof registro.lista_precio_id === 'string' &&
    !registro.deleted_at
  ) {
    const dupPrecio = db
      .prepare(
        `SELECT id FROM precios
         WHERE comercio_id = ? AND producto_id = ? AND lista_precio_id = ?
           AND deleted_at IS NULL AND id != ?
         LIMIT 1`
      )
      .get(
        registro.comercio_id,
        registro.producto_id,
        registro.lista_precio_id,
        registro.id
      ) as { id: string } | undefined;

    if (dupPrecio) {
      db.prepare(`DELETE FROM precios WHERE id = ?`).run(dupPrecio.id);
    }
  }

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
      'lista_precio_id',
      'tipo_comprobante',
      'punto_venta',
      'numero_comprobante',
      'cae',
      'cae_vencimiento',
      'estado_facturacion',
      'arca_ultimo_error',
      'arca_intentos',
      'nota_credito_tipo',
      'nota_credito_numero',
      'nota_credito_cae',
      'nota_credito_cae_vencimiento',
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
 * Cuando la base local fue recreada de cero (distinto `comercio_id`) y en Supabase
 * ya existe el comercio con su catálogo, adopta el `comercio_id` remoto antes de
 * descargar todas las tablas.
 */
function adoptarComercioRemotoEnSQLite(
  db: DatabaseSync,
  comercioRemoto: RegistroSincronizableBase,
  directorioBaseDatos: string
): void {
  const nuevoComercioId = comercioRemoto.id;
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

      db.prepare(`UPDATE configuracion_sistema SET comercio_id = ?`).run(
        nuevoComercioId
      );
      db.prepare(`UPDATE backups_historial SET comercio_id = ?`).run(
        nuevoComercioId
      );
      try {
        db.prepare(`DELETE FROM configuracion_arca`).run();
      } catch {
        // Tabla opcional
      }

      const tablasLimpiarSemilla = [
        'sync_cola',
        'sync_estado',
        'sync_imagenes_cola',
        'auditoria',
        'precios',
        'codigos_barras',
        'productos',
        'listas_precio',
        'usuarios',
        'comercios',
      ];
      for (const t of tablasLimpiarSemilla) {
        db.exec(`DELETE FROM ${t};`);
      }

      const colsComercio = obtenerColumnasTabla(db, 'comercios');
      insertarFilaRemotaEnSQLite(db, 'comercios', colsComercio, comercioRemoto);

      for (const trg of triggersActuales) {
        db.exec(trg.sql);
      }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  guardarIdentidadComercioPersistida(directorioBaseDatos, {
    comercio_id: nuevoComercioId,
  });
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
  directorioBaseDatos: string,
  opciones: { forzarBajadaCompleta?: boolean } = {}
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

  let comercioIdActivo = actor.comercio_id;

  // Si la base local no tiene productos ni ventas, verificar si en Supabase existe un comercio previo para adoptarlo
  const cantProductosLocales =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM productos WHERE comercio_id = ? AND deleted_at IS NULL`
        )
        .get(comercioIdActivo) as { c: number } | undefined
    )?.c ?? 0;
  const cantVentasLocales =
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ventas WHERE comercio_id = ?`)
        .get(comercioIdActivo) as { c: number } | undefined
    )?.c ?? 0;

  if (
    cantProductosLocales === 0 &&
    cantVentasLocales === 0 &&
    adaptador.descubrirComercioRemoto
  ) {
    const prodsConIdActual = await adaptador.bajarRegistrosTabla(
      'productos',
      comercioIdActivo,
      null
    );
    if (prodsConIdActual.length === 0) {
      const persistida = leerIdentidadComercioPersistida(directorioBaseDatos);
      const candidatos = [
        persistida?.comercio_id ?? '',
        COMERCIO_ID_RESPALDO_CONOCIDO,
      ].filter(Boolean);
      const remotoDescubierto =
        await adaptador.descubrirComercioRemoto(candidatos);
      if (remotoDescubierto && remotoDescubierto.id !== comercioIdActivo) {
        adoptarComercioRemotoEnSQLite(
          db,
          remotoDescubierto,
          directorioBaseDatos
        );
        comercioIdActivo = remotoDescubierto.id;
      }
    }
  }

  const actorEfectivo: ActorContexto =
    comercioIdActivo === actor.comercio_id
      ? actor
      : { ...actor, comercio_id: comercioIdActivo };

  const forzarCompleta =
    Boolean(opciones.forzarBajadaCompleta) || cantProductosLocales === 0;

  let registrosBajados = 0;
  let conflictosResueltos = 0;
  let imagenesEncoladasBajada = 0;
  const errores: string[] = [];

  for (const tabla of ORDEN_TABLAS_SYNC) {
    try {
      const estadoRow = db
        .prepare(`SELECT ultima_bajada_at FROM sync_estado WHERE tabla = ?`)
        .get(tabla) as { ultima_bajada_at: string | null } | undefined;

      const cursorBajada = forzarCompleta
        ? null
        : (estadoRow?.ultima_bajada_at ?? null);

      const remotos = await adaptador.bajarRegistrosTabla(
        tabla,
        comercioIdActivo,
        cursorBajada
      );

      if (remotos.length === 0) {
        if (estadoRow?.ultima_bajada_at) {
          const ahoraVacio = new Date().toISOString();
          db.prepare(
            `UPDATE sync_estado SET ultima_bajada_at = ? WHERE tabla = ?`
          ).run(ahoraVacio, tabla);
        }
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
                actor: actorEfectivo,
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
              comercioId: comercioIdActivo,
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

  // Persistir la identidad sincronizada del comercio para futuras reinstalaciones
  const superadminRow = db
    .prepare(
      `SELECT id FROM usuarios WHERE comercio_id = ? AND rol = 'superadmin' AND activo = 1 AND deleted_at IS NULL LIMIT 1`
    )
    .get(comercioIdActivo) as { id: string } | undefined;
  const listaRow = db
    .prepare(
      `SELECT id FROM listas_precio WHERE comercio_id = ? AND es_predeterminada = 1 AND deleted_at IS NULL LIMIT 1`
    )
    .get(comercioIdActivo) as { id: string } | undefined;

  guardarIdentidadComercioPersistida(directorioBaseDatos, {
    comercio_id: comercioIdActivo,
    superadmin_id: superadminRow?.id,
    lista_precio_id: listaRow?.id,
  });

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
 * 1. Si la base local está vacía de catálogo, ejecuta primero Pull para adoptar el comercio remoto si existiera.
 * 2. Push de datos pendientes.
 * 3. Pull de datos remotos y resolución de conflictos.
 * 4. Sincronización de imágenes en segundo plano (después de los datos).
 */
export async function ejecutarCicloSincronizacionCompleto(
  db: DatabaseSync,
  adaptador: AdaptadorNubeSupabase,
  actor: ActorContexto,
  directorioBaseDatos: string
): Promise<ResultadoCicloSyncCompleto> {
  const cantProds =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM productos WHERE comercio_id = ? AND deleted_at IS NULL`
        )
        .get(actor.comercio_id) as { c: number } | undefined
    )?.c ?? 0;

  let pull: ResultadoPullSync;
  let push: ResultadoPushSync;

  if (cantProds === 0) {
    pull = await ejecutarPullDatos(db, adaptador, actor, directorioBaseDatos, {
      forzarBajadaCompleta: true,
    });
    const comercioActual =
      (
        db
          .prepare(`SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1`)
          .get() as { id: string } | undefined
      )?.id ?? actor.comercio_id;
    push = await ejecutarPushDatos(
      db,
      adaptador,
      comercioActual === actor.comercio_id
        ? actor
        : { ...actor, comercio_id: comercioActual }
    );
  } else {
    push = await ejecutarPushDatos(db, adaptador, actor);
    pull = await ejecutarPullDatos(db, adaptador, actor, directorioBaseDatos);
  }

  const comercioFinal =
    (
      db
        .prepare(`SELECT id FROM comercios WHERE deleted_at IS NULL LIMIT 1`)
        .get() as { id: string } | undefined
    )?.id ?? actor.comercio_id;
  const actorFinal =
    comercioFinal === actor.comercio_id
      ? actor
      : { ...actor, comercio_id: comercioFinal };

  // Si un conflicto resuelto dejó cambios locales o fusionados por subir, hacer un push adicional rápido
  if (pull.conflictosResueltos > 0) {
    await ejecutarPushDatos(db, adaptador, actorFinal);
  }

  // PLAN.md §5.1: Primero sincronizan los datos; las imágenes se transfieren después con su propia cola
  const imagenes = await procesarColaSincronizacionImagenes(db, adaptador, {
    comercioId: actorFinal.comercio_id,
    directorioBaseDatos,
  });

  const online = await adaptador.estaDisponible();
  const estadoUI = obtenerResumenEstadoSyncDb(
    db,
    actorFinal.comercio_id,
    !online
  );

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
  proveedor_nube: ProveedorNubeSync;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  firebase_project_id: string | null;
  firebase_api_key: string | null;
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
        proveedor_nube?: ProveedorNubeSync;
        supabase_url: string | null;
        supabase_anon_key: string | null;
        firebase_project_id?: string | null;
        firebase_api_key?: string | null;
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
        comercio_id, proveedor_nube, supabase_url, supabase_anon_key,
        firebase_project_id, firebase_api_key,
        sync_automatico_habilitado, sync_intervalo_minutos,
        carpeta_backups, backup_diario_habilitado,
        ultimo_backup_at, ultimo_backup_archivo, updated_at
      ) VALUES (?, 'supabase', NULL, NULL, NULL, NULL, 1, 5, 'backups', 1, NULL, NULL, ?)`
    ).run(comercioId, ahora);

    return {
      comercio_id: comercioId,
      proveedor_nube: 'supabase',
      supabase_url: null,
      supabase_anon_key: null,
      firebase_project_id: null,
      firebase_api_key: null,
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
    proveedor_nube: fila.proveedor_nube ?? 'supabase',
    supabase_url: fila.supabase_url,
    supabase_anon_key: fila.supabase_anon_key,
    firebase_project_id: fila.firebase_project_id ?? null,
    firebase_api_key: fila.firebase_api_key ?? null,
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
 * Valida la Regla 8 (prohibido guardar claves de servicio / secretas de Supabase o Firebase) y audita el cambio.
 */
export function guardarConfiguracionSistema(
  db: DatabaseSync,
  actor: ActorContexto,
  input: {
    proveedorNube?: ProveedorNubeSync;
    supabaseUrl?: string | null;
    supabaseAnonKey?: string | null;
    firebaseProjectId?: string | null;
    firebaseApiKey?: string | null;
    syncAutomaticoHabilitado?: boolean;
    syncIntervaloMinutos?: number;
    carpetaBackups?: string;
    backupDiarioHabilitado?: boolean;
  }
): ConfiguracionSistemaLocal {
  exigirPermiso(actor.rol, 'configuracion_sensible');

  const actual = obtenerConfiguracionSistema(db, actor.comercio_id);
  const nuevoProveedor: ProveedorNubeSync =
    input.proveedorNube ?? actual.proveedor_nube ?? 'supabase';
  const nuevaUrl =
    input.supabaseUrl !== undefined
      ? input.supabaseUrl?.trim() || null
      : actual.supabase_url;
  const nuevaAnonKey =
    input.supabaseAnonKey !== undefined
      ? input.supabaseAnonKey?.trim() || null
      : actual.supabase_anon_key;
  const nuevoFirebasePid =
    input.firebaseProjectId !== undefined
      ? input.firebaseProjectId?.trim() || null
      : actual.firebase_project_id;
  const nuevaFirebaseKey =
    input.firebaseApiKey !== undefined
      ? input.firebaseApiKey?.trim() || null
      : actual.firebase_api_key;

  const validacion = validarConfiguracionSupabaseCliente(
    nuevaUrl,
    nuevaAnonKey
  );
  if (!validacion.valida) {
    throw new Error(validacion.motivo);
  }

  const validacionFb = validarConfiguracionFirebaseCliente(
    nuevoFirebasePid,
    nuevaFirebaseKey
  );
  if (!validacionFb.valida) {
    throw new Error(validacionFb.motivo);
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

  const cambioDestinoNube =
    nuevaUrl !== actual.supabase_url ||
    nuevaAnonKey !== actual.supabase_anon_key ||
    nuevoFirebasePid !== actual.firebase_project_id ||
    nuevaFirebaseKey !== actual.firebase_api_key ||
    nuevoProveedor !== actual.proveedor_nube;

  const resultado = ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();

    db.prepare(
      `UPDATE configuracion_sistema
       SET proveedor_nube = ?,
           supabase_url = ?,
           supabase_anon_key = ?,
           firebase_project_id = ?,
           firebase_api_key = ?,
           sync_automatico_habilitado = ?,
           sync_intervalo_minutos = ?,
           carpeta_backups = ?,
           backup_diario_habilitado = ?,
           updated_at = ?
       WHERE comercio_id = ?`
    ).run(
      nuevoProveedor,
      nuevaUrl,
      nuevaAnonKey,
      nuevoFirebasePid,
      nuevaFirebaseKey,
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
        proveedor_nube: actual.proveedor_nube,
        supabase_url: actual.supabase_url,
        firebase_project_id: actual.firebase_project_id,
        sync_automatico_habilitado: actual.sync_automatico_habilitado,
        sync_intervalo_minutos: actual.sync_intervalo_minutos,
        carpeta_backups: actual.carpeta_backups,
        backup_diario_habilitado: actual.backup_diario_habilitado,
      },
      valores_despues: {
        proveedor_nube: nuevoProveedor,
        supabase_url: nuevaUrl,
        firebase_project_id: nuevoFirebasePid,
        sync_automatico_habilitado: syncAuto,
        sync_intervalo_minutos: intervalo,
        carpeta_backups: carpetaBackups,
        backup_diario_habilitado: backupDiario,
      },
    });

    return obtenerConfiguracionSistema(db, actor.comercio_id);
  });

  if (
    cambioDestinoNube &&
    ((nuevaUrl && nuevaAnonKey) || (nuevoFirebasePid && nuevaFirebaseKey))
  ) {
    reencolarComercioCompletoParaSync(db, actor.comercio_id);
  }

  return resultado;
}
