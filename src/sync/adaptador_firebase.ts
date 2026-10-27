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

export function serializarRegistroAFirestoreFields(
  registro: RegistroSincronizableBase
): Record<string, FirestoreFieldValue> {
  const fields: Record<string, FirestoreFieldValue> = {};
  for (const [clave, valor] of Object.entries(registro)) {
    if (clave === 'sync_status') continue;
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
  doc: FirestoreDocument
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
  if (typeof obj.comercio_id !== 'string' && obj.id) {
    obj.comercio_id = obj.id;
  }
  return obj as RegistroSincronizableBase;
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
  private readonly baseDocsUrl: string;

  constructor(projectId: string, apiKey: string) {
    const validacion = validarConfiguracionFirebaseCliente(projectId, apiKey);
    if (!validacion.valida) {
      throw new Error(validacion.motivo);
    }
    this.projectId = projectId.trim();
    this.apiKey = apiKey.trim();
    this.baseDocsUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents`;
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
        { method: 'GET' }
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

    // Firestore commit soporta hasta 500 writes por lote; usamos lotes de 200
    const TAMANO_LOTE = 200;
    for (let i = 0; i < registros.length; i += TAMANO_LOTE) {
      const lote = registros.slice(i, i + TAMANO_LOTE);
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
          headers: { 'Content-Type': 'application/json' },
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
        { method: 'GET' }
      );
      if (resp.status === 404) return [];
      if (!resp.ok) {
        const detalle = await resp.text();
        throw new Error(
          `Error HTTP ${resp.status} en Firebase Firestore al bajar comercios: ${detalle}`
        );
      }
      const doc = (await resp.json()) as FirestoreDocument;
      const reg = deserializarFirestoreDocumentARegistro(doc);
      if (!reg) return [];
      if (desdeUpdatedAt && reg.updated_at <= desdeUpdatedAt) {
        return [];
      }
      return [reg];
    }

    const acumulado: RegistroSincronizableBase[] = [];
    let pageToken = '';

    while (true) {
      const tokenParam = pageToken
        ? `&pageToken=${encodeURIComponent(pageToken)}`
        : '';
      const url = `${this.baseDocsUrl}/comercios/${encodeURIComponent(comercioId)}/${tabla}?pageSize=300${tokenParam}&key=${encodeURIComponent(this.apiKey)}`;
      const resp = await fetch(url, { method: 'GET' });
      if (resp.status === 404) return [];
      if (!resp.ok) {
        const detalle = await resp.text();
        throw new Error(
          `Error HTTP ${resp.status} en Firebase Firestore al bajar ${tabla}: ${detalle}`
        );
      }

      const body = (await resp.json()) as {
        documents?: FirestoreDocument[];
        nextPageToken?: string;
      };
      const docs = body.documents ?? [];
      for (const doc of docs) {
        const reg = deserializarFirestoreDocumentARegistro(doc);
        if (!reg) continue;
        if (!desdeUpdatedAt || reg.updated_at > desdeUpdatedAt) {
          acumulado.push(reg);
        }
      }

      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
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
        { method: 'GET' }
      );
      if (resp.ok) {
        const body = (await resp.json()) as { documents?: FirestoreDocument[] };
        for (const doc of body.documents ?? []) {
          const reg = deserializarFirestoreDocumentARegistro(doc);
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
              headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'image/webp' },
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
    const resp = await fetch(url, { method: 'GET' });
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
    await this.primario.subirRegistrosTabla(tabla, registros);
    try {
      await this.secundario.subirRegistrosTabla(tabla, registros);
    } catch {
      // El espejo secundario no bloquea al primario si falla temporalmente
    }
  }

  async bajarRegistrosTabla(
    tabla: TablaSincronizable,
    comercioId: string,
    desdeUpdatedAt: string | null
  ): Promise<RegistroSincronizableBase[]> {
    const delPrimario = await this.primario.bajarRegistrosTabla(
      tabla,
      comercioId,
      desdeUpdatedAt
    );
    if (delPrimario.length > 0) {
      return delPrimario;
    }
    try {
      return await this.secundario.bajarRegistrosTabla(
        tabla,
        comercioId,
        desdeUpdatedAt
      );
    } catch {
      return delPrimario;
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
