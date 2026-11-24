/**
 * Adaptador opcional de sincronización en la nube con Firebase (Cloud Firestore REST + Firebase Storage)
 * y Adaptador Multinube (Supabase + Firebase en paralelo o seleccionable).
 * Cumple PLAN.md §3 Regla 8 (nunca guardar claves privadas / service_account en el cliente).
 */

import {
  ORDEN_TABLAS_SYNC,
  type RegistroSincronizableBase,
  type TablaSincronizable,
} from '../domain/sync.ts';
import type { AdaptadorNubeSupabase } from './motor_sync.ts';

export type ProveedorNubeSync = 'supabase' | 'firebase' | 'ambos';

export function validarConfiguracionFirebaseCliente(
  projectId: string | null | undefined,
  apiKey: string | null | undefined
): { valida: boolean; motivo?: string } {
  const pid = (projectId ?? '').trim();
  const key = (apiKey ?? '').trim();

  if (!pid && !key) {
    return { valida: true };
  }
  if (!pid || !key) {
    return {
      valida: false,
      motivo:
        'Para configurar Firebase debés completar tanto el Project ID como la Web API Key pública.',
    };
  }
  if (!/^[a-z0-9-]{4,48}$/.test(pid)) {
    return {
      valida: false,
      motivo:
        'El Project ID de Firebase solo puede contener letras minúsculas, números y guiones (ej: mi-pos-comercio).',
    };
  }
  // Regla 8: prohibido guardar credenciales de cuenta de servicio (Admin SDK / private_key) en el cliente
  if (
    key.includes('BEGIN PRIVATE KEY') ||
    key.includes('service_account') ||
    key.includes('"private_key"') ||
    key.startsWith('{')
  ) {
    return {
      valida: false,
      motivo:
        'PROHIBIDO (Regla 8): No se permite guardar credenciales de Service Account ni claves privadas de Firebase Admin en el cliente. Usá únicamente la Web API Key pública (AIza...).',
    };
  }
  if (key.length < 16) {
    return {
      valida: false,
      motivo: 'La Web API Key de Firebase ingresada es demasiado corta.',
    };
  }
  return { valida: true };
}

interface FirestoreFieldValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
}

interface FirestoreDocument {
  name?: string;
  fields?: Record<string, FirestoreFieldValue>;
}

export const REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function estaAutenticado() {
      return request.auth != null && request.auth.token.comercio_id != null;
    }
    function esMismoComercio(comercioId) {
      return estaAutenticado() && request.auth.token.comercio_id == comercioId;
    }
    function esAdminOEncargado() {
      return request.auth.token.rol in ['superadmin', 'encargado'];
    }
    function esSuperadmin() {
      return request.auth.token.rol == 'superadmin';
    }

    match /{document=**} {
      allow read, write: if false;
    }

    match /comercios/{comercioId} {
      allow read: if esMismoComercio(comercioId);
      allow create, update: if esMismoComercio(comercioId) && esSuperadmin();
      allow delete: if false;

      match /{coleccionAppend}/{docId} {
        allow read: if esMismoComercio(comercioId)
          && coleccionAppend in ['ventas', 'ventas_items', 'ventas_pagos', 'movimientos_stock', 'cuenta_corriente_movimientos', 'transferencias_sucursales', 'auditoria']
          && (coleccionAppend != 'auditoria' || esSuperadmin());
        allow create: if esMismoComercio(comercioId)
          && coleccionAppend in ['ventas', 'ventas_items', 'ventas_pagos', 'movimientos_stock', 'cuenta_corriente_movimientos', 'transferencias_sucursales', 'auditoria']
          && request.resource.data.comercio_id == comercioId;
        allow update, delete: if false;
      }

      match /usuarios/{usuarioId} {
        allow read: if esMismoComercio(comercioId) && esSuperadmin();
        allow create, update: if esMismoComercio(comercioId) && esSuperadmin()
          && !('clave_hash' in request.resource.data)
          && !('pin_hash' in request.resource.data);
        allow delete: if false;
      }

      match /{coleccion}/{docId} {
        allow read: if esMismoComercio(comercioId)
          && coleccion in ['productos', 'precios', 'listas_precio', 'codigos_barras', 'categorias', 'marcas', 'proveedores', 'clientes', 'caja_sesiones', 'caja_movimientos', 'sucursales', 'variantes', 'combos', 'combos_items'];
        allow create, update: if esMismoComercio(comercioId)
          && coleccion in ['productos', 'precios', 'listas_precio', 'codigos_barras', 'categorias', 'marcas', 'proveedores', 'clientes', 'caja_sesiones', 'caja_movimientos', 'sucursales', 'variantes', 'combos', 'combos_items']
          && (coleccion in ['clientes', 'caja_sesiones', 'caja_movimientos'] || esAdminOEncargado())
          && request.resource.data.comercio_id == comercioId;
        allow delete: if false;
      }
    }
  }
}`;

export function serializarRegistroAFirestoreFields(
  registro: RegistroSincronizableBase
): Record<string, FirestoreFieldValue> {
  const fields: Record<string, FirestoreFieldValue> = {};
  for (const [clave, valor] of Object.entries(registro)) {
    // Regla 16: nunca subir clave_hash, pin_hash ni metadato local sync_status
    if (clave === 'sync_status' || clave === 'clave_hash' || clave === 'pin_hash') continue;
    if (valor === null || valor === undefined) {
      fields[clave] = { nullValue: null };
    } else if (typeof valor === 'boolean') {
      fields[clave] = { booleanValue: valor };
    } else if (typeof valor === 'number') {
      if (Number.isInteger(valor)) {
        fields[clave] = { integerValue: String(valor) };
      } else {
        fields[clave] = { doubleValue: valor };
      }
    } else {
      fields[clave] = { stringValue: String(valor) };
    }
  }
  return fields;
}

export function deserializarFirestoreDocumentARegistro(
  doc: FirestoreDocument,
  comercioIdEsperado?: string,
  esTablaComercios = false
): RegistroSincronizableBase | null {
  if (!doc.fields) return null;
  const obj: Record<string, unknown> = {};
  for (const [clave, val] of Object.entries(doc.fields)) {
    if ('nullValue' in val) {
      obj[clave] = null;
    } else if (typeof val.booleanValue === 'boolean') {
      obj[clave] = val.booleanValue;
    } else if (typeof val.integerValue === 'string') {
      obj[clave] = Number.parseInt(val.integerValue, 10);
    } else if (typeof val.doubleValue === 'number') {
      obj[clave] = val.doubleValue;
    } else if (typeof val.stringValue === 'string') {
      obj[clave] = val.stringValue;
    } else {
      obj[clave] = null;
    }
  }
  if (typeof obj.id !== 'string' || !obj.id) {
    return null;
  }
  if (esTablaComercios) {
    if (typeof obj.comercio_id !== 'string' || !obj.comercio_id) {
      obj.comercio_id = obj.id;
    }
    if (comercioIdEsperado && obj.id !== comercioIdEsperado) {
      return null;
    }
  } else {
    if (typeof obj.comercio_id !== 'string' || !obj.comercio_id) {
      return null;
    }
    if (comercioIdEsperado && obj.comercio_id !== comercioIdEsperado) {
      return null;
    }
  }
  return obj as RegistroSincronizableBase;
}

export interface SesionFirebaseAuth {
  readonly idToken: string;
  readonly refreshToken: string | null;
  readonly localId: string;
  readonly email: string;
  readonly expiresIn: number;
}

export async function autenticarFirebaseEmailClave(params: {
  apiKey: string;
  email: string;
  password: string;
}): Promise<SesionFirebaseAuth> {
  const key = params.apiKey.trim();
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: params.email.trim(),
        password: params.password,
        returnSecureToken: true,
      }),
      signal: AbortSignal.timeout(10000),
    }
  );
  const txt = await resp.text();
  if (!resp.ok) {
    throw new Error(`Error al autenticar con Firebase Auth (HTTP ${resp.status}): ${txt}`);
  }
  const data = JSON.parse(txt) as {
    idToken?: string;
    refreshToken?: string;
    localId?: string;
    email?: string;
    expiresIn?: string;
  };
  if (!data.idToken || !data.localId) {
    throw new Error('Firebase Auth no devolvió un idToken válido.');
  }
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken ?? null,
    localId: data.localId,
    email: data.email ?? params.email.trim(),
    expiresIn: Number(data.expiresIn ?? 3600),
  };
}

/**
 * Adaptador HTTP nativo para Firebase Cloud Firestore REST v1 y Firebase Storage REST.
 * Estructura de documentos en Firestore:
 * - Comercios: `projects/{projectId}/databases/(default)/documents/comercios/{comercioId}`
 * - Tablas por comercio: `projects/{projectId}/databases/(default)/documents/comercios/{comercioId}/{tabla}/{id}`
 */
export class AdaptadorFirebaseFirestoreHttp implements AdaptadorNubeSupabase {
  private readonly projectId: string;
  private readonly apiKey: string;
  private readonly idToken: string | null;
  private readonly baseDocsUrl: string;

  constructor(projectId: string, apiKey: string, idToken?: string | null) {
    const validacion = validarConfiguracionFirebaseCliente(projectId, apiKey);
    if (!validacion.valida) {
      throw new Error(validacion.motivo);
    }
    this.projectId = projectId.trim();
    this.apiKey = apiKey.trim();
    this.idToken = idToken && idToken.trim() ? idToken.trim() : null;
    this.baseDocsUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents`;
  }

  private construirCabeceras(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.idToken ? { Authorization: `Bearer ${this.idToken}` } : {}),
      ...extra,
    };
  }

  private construirNombreDocumento(
    tabla: TablaSincronizable,
    comercioId: string,
    registroId: string
  ): string {
    const prefijo = `projects/${this.projectId}/databases/(default)/documents`;
    if (tabla === 'comercios') {
      return `${prefijo}/comercios/${registroId}`;
    }
    return `${prefijo}/comercios/${comercioId}/${tabla}/${registroId}`;
  }

  async estaDisponible(): Promise<boolean> {
    try {
      const resp = await fetch(
        `${this.baseDocsUrl}/comercios?pageSize=1&key=${encodeURIComponent(this.apiKey)}`,
        { method: 'GET', headers: this.construirCabeceras() }
      );
      return resp.status < 500;
    } catch {
      return false;
    }
  }

  async subirRegistrosTabla(
    tabla: TablaSincronizable,
    registros: RegistroSincronizableBase[]
  ): Promise<void> {
    if (registros.length === 0) return;

    // Deduplicar por UUID (id) dentro de la misma tanda para garantizar idempotencia
    // y evitar que Firestore rechace un commit con dos writes al mismo document path.
    const mapaUnicos = new Map<string, RegistroSincronizableBase>();
    for (const reg of registros) {
      if (reg && typeof reg.id === 'string' && reg.id.trim()) {
        mapaUnicos.set(reg.id, reg);
      }
    }
    const registrosUnicos = Array.from(mapaUnicos.values());
    if (registrosUnicos.length === 0) return;

    // Firestore commit soporta hasta 500 writes por lote; usamos lotes de 200
    const TAMANO_LOTE = 200;
    for (let i = 0; i < registrosUnicos.length; i += TAMANO_LOTE) {
      const lote = registrosUnicos.slice(i, i + TAMANO_LOTE);
      const writes = lote.map((reg) => {
        const comercioId =
          tabla === 'comercios' ? reg.id : (reg.comercio_id ?? reg.id);
        return {
          update: {
            name: this.construirNombreDocumento(tabla, comercioId, reg.id),
            fields: serializarRegistroAFirestoreFields(reg),
          },
        };
      });

      const resp = await fetch(
        `${this.baseDocsUrl}:commit?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: this.construirCabeceras({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ writes }),
        }
      );

      if (!resp.ok) {
        const detalle = await resp.text();
        throw new Error(
          `Error HTTP ${resp.status} en Firebase Firestore al subir ${tabla}: ${detalle}`
        );
      }
    }
  }

  async bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]> {
    if (tabla === 'comercios') {
      const resp = await fetch(
        `${this.baseDocsUrl}/comercios/${encodeURIComponent(comercioId)}?key=${encodeURIComponent(this.apiKey)}`,
        { method: 'GET', headers: this.construirCabeceras() }
      );
      if (resp.status === 404) return [];
      if (!resp.ok) {
        const detalle = await resp.text();
        throw new Error(
          `Error HTTP ${resp.status} en Firebase Firestore al bajar comercios: ${detalle}`
        );
      }
      const doc = (await resp.json()) as FirestoreDocument;
      const reg = deserializarFirestoreDocumentARegistro(doc, comercioId, true);
      if (!reg) return [];
      if (desdeUpdatedAt && reg.updated_at <= desdeUpdatedAt) {
        return [];
      }
      return [reg];
    }

    const acumulado: RegistroSincronizableBase[] = [];
    const LIMITE_PAGINA = 300;
    const MAX_PAGINAS = 50;
    let offset = 0;

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const filtros: Array<Record<string, unknown>> = [
        {
          fieldFilter: {
            field: { fieldPath: 'comercio_id' },
            op: 'EQUAL',
            value: { stringValue: comercioId },
          },
        },
      ];
      if (desdeUpdatedAt) {
        filtros.push({
          fieldFilter: {
            field: { fieldPath: 'updated_at' },
            op: 'GREATER_THAN_OR_EQUAL',
            value: { stringValue: desdeUpdatedAt },
          },
        });
      }

      const structuredQuery: Record<string, unknown> = {
        from: [{ collectionId: tabla }],
        where:
          filtros.length === 1
            ? filtros[0]
            : { compositeFilter: { op: 'AND', filters: filtros } },
        orderBy: [{ field: { fieldPath: 'updated_at' }, direction: 'ASCENDING' }],
        limit: LIMITE_PAGINA,
        offset,
      };

      const url = `${this.baseDocsUrl}/comercios/${encodeURIComponent(comercioId)}:runQuery?key=${encodeURIComponent(this.apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: this.construirCabeceras({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ structuredQuery }),
      });

      if (resp.status === 404) return [];
      if (!resp.ok) {
        const detalle = await resp.text();
        throw new Error(
          `Error HTTP ${resp.status} en Firebase Firestore al bajar ${tabla}: ${detalle}`
        );
      }

      const filas = (await resp.json()) as Array<{ document?: FirestoreDocument }>;
      let countDocs = 0;
      for (const item of filas) {
        if (!item.document) continue;
        countDocs++;
        const reg = deserializarFirestoreDocumentARegistro(item.document, comercioId, false);
        if (!reg) continue;
        if (!desdeUpdatedAt || reg.updated_at >= desdeUpdatedAt) {
          acumulado.push(reg);
        }
      }

      if (countDocs < LIMITE_PAGINA) break;
      offset += countDocs;
    }

    acumulado.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return acumulado;
  }

  async descubrirComercioRemoto(
    candidatosComercioId: readonly string[] = []
  ): Promise<RegistroSincronizableBase | null> {
    for (const idCandidato of candidatosComercioId) {
      if (!idCandidato) continue;
      try {
        const filas = await this.bajarRegistrosTabla(
          'comercios',
          idCandidato,
          null
        );
        if (filas.length > 0 && filas[0]) {
          return filas[0];
        }
      } catch {
        // Continuar
      }
    }

    try {
      const resp = await fetch(
        `${this.baseDocsUrl}/comercios?pageSize=5&key=${encodeURIComponent(this.apiKey)}`,
        { method: 'GET', headers: this.construirCabeceras() }
      );
      if (resp.ok) {
        const body = (await resp.json()) as { documents?: FirestoreDocument[] };
        for (const doc of body.documents ?? []) {
          const reg = deserializarFirestoreDocumentARegistro(doc, undefined, true);
          if (reg && !reg.deleted_at) {
            return reg;
          }
        }
      }
    } catch {
      // Ignorar errores de red en descubrimiento
    }

    return null;
  }

  async vaciarDatosComercioRemoto(params: {
    comercioId: string;
    superadminIdConservar: string;
    listaPrecioIdConservar: string;
  }): Promise<{ tablasVaciadas: number; advertencias: string[] }> {
    const advertencias: string[] = [];
    let tablasVaciadas = 0;
    const tablasEnOrdenInverso = [...ORDEN_TABLAS_SYNC]
      .reverse()
      .filter((t) => t !== 'comercios');

    for (const tabla of tablasEnOrdenInverso) {
      try {
        const existentes = await this.bajarRegistrosTabla(
          tabla,
          params.comercioId,
          null
        );
        const aBorrar = existentes.filter((reg) => {
          if (tabla === 'usuarios' && reg.id === params.superadminIdConservar) {
            return false;
          }
          if (
            tabla === 'listas_precio' &&
            reg.id === params.listaPrecioIdConservar
          ) {
            return false;
          }
          return true;
        });

        if (aBorrar.length > 0) {
          const writes = aBorrar.map((reg) => ({
            delete: this.construirNombreDocumento(
              tabla,
              params.comercioId,
              reg.id
            ),
          }));
          const resp = await fetch(
            `${this.baseDocsUrl}:commit?key=${encodeURIComponent(this.apiKey)}`,
            {
              method: 'POST',
              headers: this.construirCabeceras({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ writes }),
            }
          );
          if (resp.ok) {
            tablasVaciadas++;
          } else {
            advertencias.push(
              `No se pudo limpiar colección Firebase ${tabla} (HTTP ${resp.status}).`
            );
          }
        } else {
          tablasVaciadas++;
        }
      } catch (err) {
        advertencias.push(
          err instanceof Error
            ? err.message
            : `Error al vaciar colección Firebase ${tabla}.`
        );
      }
    }

    return { tablasVaciadas, advertencias };
  }

  async subirArchivoImagen(
    comercioId: string,
    nombreArchivo: string,
    contenido: Buffer
  ): Promise<void> {
    const objectName = encodeURIComponent(
      `productos/${comercioId}/${nombreArchivo}`
    );
    const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(this.projectId)}.appspot.com/o?uploadType=media&name=${objectName}&key=${encodeURIComponent(this.apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.construirCabeceras({ 'Content-Type': 'image/webp' }),
      body: new Uint8Array(contenido),
    });
    if (!resp.ok) {
      throw new Error(
        `Error HTTP ${resp.status} al subir imagen a Firebase Storage.`
      );
    }
  }

  async bajarArchivoImagen(
    comercioId: string,
    nombreArchivo: string
  ): Promise<Buffer | null> {
    const objectName = encodeURIComponent(
      `productos/${comercioId}/${nombreArchivo}`
    );
    const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(this.projectId)}.appspot.com/o/${objectName}?alt=media&key=${encodeURIComponent(this.apiKey)}`;
    const resp = await fetch(url, { method: 'GET', headers: this.construirCabeceras() });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(
        `Error HTTP ${resp.status} al bajar imagen de Firebase Storage.`
      );
    }
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

/**
 * Adaptador compuesto que permite sincronizar simultáneamente contra Supabase y Firebase
 * cuando el comercio elige el modo `'ambos'` (espejo redundante en dos nubes).
 */
export class AdaptadorNubeMultiProveedor implements AdaptadorNubeSupabase {
  private readonly primario: AdaptadorNubeSupabase;
  private readonly secundario: AdaptadorNubeSupabase;

  constructor(
    primario: AdaptadorNubeSupabase,
    secundario: AdaptadorNubeSupabase
  ) {
    this.primario = primario;
    this.secundario = secundario;
  }

  async estaDisponible(): Promise<boolean> {
    const [disp1, disp2] = await Promise.all([
      this.primario.estaDisponible(),
      this.secundario.estaDisponible(),
    ]);
    return disp1 || disp2;
  }

  async subirRegistrosTabla(
    tabla: TablaSincronizable,
    registros: RegistroSincronizableBase[]
  ): Promise<void> {
    const [resPrimario, resSecundario] = await Promise.allSettled([
      this.primario.subirRegistrosTabla(tabla, registros),
      this.secundario.subirRegistrosTabla(tabla, registros),
    ]);

    const errores: string[] = [];
    if (resPrimario.status === 'rejected') {
      errores.push(
        resPrimario.reason instanceof Error
          ? resPrimario.reason.message
          : String(resPrimario.reason)
      );
    }
    if (resSecundario.status === 'rejected') {
      errores.push(
        resSecundario.reason instanceof Error
          ? resSecundario.reason.message
          : String(resSecundario.reason)
      );
    }
    if (errores.length > 0) {
      throw new Error(errores.join(' | '));
    }
  }

  async bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]> {
    try {
      const delPrimario = await this.primario.bajarRegistrosTabla(
        tabla,
        comercioId,
        desdeUpdatedAt
      );
      if (delPrimario.length > 0) {
        return delPrimario;
      }
    } catch {
      // Si el primario falla, intentar desde el secundario (Firebase)
    }
    try {
      return await this.secundario.bajarRegistrosTabla(
        tabla,
        comercioId,
        desdeUpdatedAt
      );
    } catch {
      return [];
    }
  }

  async descubrirComercioRemoto(
    candidatosComercioId?: readonly string[]
  ): Promise<RegistroSincronizableBase | null> {
    const c1 = await this.primario.descubrirComercioRemoto?.(
      candidatosComercioId
    );
    if (c1) return c1;
    return (
      (await this.secundario.descubrirComercioRemoto?.(candidatosComercioId)) ??
      null
    );
  }

  async vaciarDatosComercioRemoto(params: {
    comercioId: string;
    superadminIdConservar: string;
    listaPrecioIdConservar: string;
  }): Promise<{ tablasVaciadas: number; advertencias: string[] }> {
    const r1 = (await this.primario.vaciarDatosComercioRemoto?.(params)) ?? {
      tablasVaciadas: 0,
      advertencias: [],
    };
    const r2 = (await this.secundario.vaciarDatosComercioRemoto?.(params)) ?? {
      tablasVaciadas: 0,
      advertencias: [],
    };
    return {
      tablasVaciadas: r1.tablasVaciadas + r2.tablasVaciadas,
      advertencias: [...r1.advertencias, ...r2.advertencias],
    };
  }

  async subirArchivoImagen(
    comercioId: string,
    nombreArchivo: string,
    contenido: Buffer
  ): Promise<void> {
    await this.primario.subirArchivoImagen(
      comercioId,
      nombreArchivo,
      contenido
    );
    try {
      await this.secundario.subirArchivoImagen(
        comercioId,
        nombreArchivo,
        contenido
      );
    } catch {
      // No bloquear si el secundario falla
    }
  }

  async bajarArchivoImagen(
    comercioId: string,
    nombreArchivo: string
  ): Promise<Buffer | null> {
    const img1 = await this.primario.bajarArchivoImagen(
      comercioId,
      nombreArchivo
    );
    if (img1) return img1;
    try {
      return await this.secundario.bajarArchivoImagen(
        comercioId,
        nombreArchivo
      );
    } catch {
      return null;
    }
  }
}
