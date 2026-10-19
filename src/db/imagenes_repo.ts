/**
 * Procesamiento y almacenamiento local de imágenes de productos (PLAN.md §3 regla 12 y §5.1).
 * - Nunca guarda el archivo original ni bytes dentro de SQLite.
 * - Corrige orientación EXIF antes de redimensionar.
 * - Elimina todos los metadatos EXIF/GPS.
 * - Redimensiona a máx. 800 px (sin agrandar chicas) en WebP <= 150 KB.
 * - Genera miniatura de máx. 200 px (<producto_id>_thumb.webp).
 * - Calcula imagen_hash (SHA-256) sobre el archivo WebP ya procesado.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { exigirPermiso } from '../domain/permisos.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  ejecutarEnTransaccion,
  insertarRegistroAuditoria,
  type ActorContexto,
} from './repositorios.ts';

export const MAX_BYTES_IMAGEN_ENTRADA = 25 * 1024 * 1024; // 25 MB
export const MAX_BYTES_WEBP_PRINCIPAL = 150 * 1024; // 150 KB
export const MAX_BYTES_WEBP_MINIATURA = 25 * 1024; // 25 KB
export const LADO_MAXIMO_PRINCIPAL_PX = 800;
export const LADO_MAXIMO_MINIATURA_PX = 200;

const FORMATOS_PERMITIDOS = new Set(['jpeg', 'jpg', 'png', 'webp', 'heif']);

export interface ResultadoProcesamientoImagen {
  readonly principalWebp: Buffer;
  readonly miniaturaWebp: Buffer;
  readonly imagenHash: string;
  readonly anchoFinal: number;
  readonly altoFinal: number;
  readonly anchoMiniatura: number;
  readonly altoMiniatura: number;
  readonly calidadAplicada: number;
}

function esPosibleArchivoHeic(buffer: Buffer, nombreArchivo?: string): boolean {
  if (nombreArchivo && /\.(heic|heif)$/i.test(nombreArchivo)) {
    return true;
  }
  if (buffer.length >= 12) {
    const ftyp = buffer.subarray(4, 12).toString('ascii');
    if (
      ftyp.startsWith('ftypheic') ||
      ftyp.startsWith('ftypheix') ||
      ftyp.startsWith('ftypmif1') ||
      ftyp.startsWith('ftypmsf1')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Procesa un buffer de imagen (JPG, PNG, WebP, HEIC) cumpliendo todos los pasos de PLAN.md §5.1.
 */
export async function procesarImagenProducto(
  entradaBuffer: Buffer | Uint8Array,
  nombreArchivo?: string
): Promise<ResultadoProcesamientoImagen> {
  const buffer = Buffer.isBuffer(entradaBuffer)
    ? entradaBuffer
    : Buffer.from(entradaBuffer);

  if (buffer.byteLength === 0) {
    throw new Error('IMAGEN_VACIA: El archivo de imagen está vacío.');
  }

  if (buffer.byteLength > MAX_BYTES_IMAGEN_ENTRADA) {
    throw new Error(
      'IMAGEN_DEMASIADO_GRANDE: El archivo supera el límite máximo permitido de 25 MB.'
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    if (esPosibleArchivoHeic(buffer, nombreArchivo)) {
      throw new Error(
        'HEIC_NO_SOPORTADO: No se pudo decodificar la foto HEIC de iPhone en este equipo. Convertila a JPG o PNG e intentá de nuevo.'
      );
    }
    throw new Error(
      'IMAGEN_CORRUPTA: El archivo seleccionado no es una imagen válida o está dañado.'
    );
  }

  const formato = (metadata.format ?? '').toLowerCase();
  if (!FORMATOS_PERMITIDOS.has(formato)) {
    throw new Error(
      `FORMATO_NO_SOPORTADO: Formato "${formato || 'desconocido'}" no admitido. Usá JPG, PNG, WebP o HEIC.`
    );
  }

  // Si es HEIF/HEIC, verificar que libvips pueda decodificar los píxeles
  try {
    // 1. Corregir orientación EXIF (.rotate() sin argumentos usa el tag EXIF Orientation y luego lo resetea)
    // 2. No llamar a .withMetadata() elimina todos los metadatos EXIF y ubicación GPS
    // 3. Redimensionar a máx 800 px de lado mayor sin agrandar imágenes más chicas
    const calidades = [80, 72, 64, 56, 48, 40, 32, 24, 16, 10];
    let principalWebp: Buffer | null = null;
    let infoPrincipal: OutputInfo | null = null;
    let calidadAplicada = 80;

    for (const q of calidades) {
      const resultado = await sharp(buffer)
        .rotate()
        .resize({
          width: LADO_MAXIMO_PRINCIPAL_PX,
          height: LADO_MAXIMO_PRINCIPAL_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: q, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      principalWebp = resultado.data;
      infoPrincipal = resultado.info;
      calidadAplicada = q;

      if (principalWebp.byteLength <= MAX_BYTES_WEBP_PRINCIPAL) {
        break;
      }
    }

    if (!principalWebp || !infoPrincipal) {
      throw new Error('No se pudo generar la imagen WebP.');
    }

    // Si aún con calidad 10 superara 150 KB (caso extremo de ruido puro), reducir levemente dimensión
    if (principalWebp.byteLength > MAX_BYTES_WEBP_PRINCIPAL) {
      const reducido = await sharp(buffer)
        .rotate()
        .resize({
          width: 600,
          height: 600,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 20 })
        .toBuffer({ resolveWithObject: true });
      principalWebp = reducido.data;
      infoPrincipal = reducido.info;
      calidadAplicada = 20;
    }

    // 4. Generar miniatura de ~200 px (WebP, ~10-20 KB)
    const calidadesThumb = [75, 60, 45, 30];
    let miniaturaWebp: Buffer | null = null;
    let infoMiniatura: OutputInfo | null = null;

    for (const qt of calidadesThumb) {
      const resThumb = await sharp(buffer)
        .rotate()
        .resize({
          width: LADO_MAXIMO_MINIATURA_PX,
          height: LADO_MAXIMO_MINIATURA_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: qt, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      miniaturaWebp = resThumb.data;
      infoMiniatura = resThumb.info;
      if (miniaturaWebp.byteLength <= MAX_BYTES_WEBP_MINIATURA) {
        break;
      }
    }

    if (!miniaturaWebp || !infoMiniatura) {
      throw new Error('No se pudo generar la miniatura WebP.');
    }

    // 5. Calcular imagen_hash SHA-256 sobre el archivo WebP principal ya procesado
    const imagenHash = crypto
      .createHash('sha256')
      .update(principalWebp)
      .digest('hex');

    return {
      principalWebp,
      miniaturaWebp,
      imagenHash,
      anchoFinal: infoPrincipal.width,
      altoFinal: infoPrincipal.height,
      anchoMiniatura: infoMiniatura.width,
      altoMiniatura: infoMiniatura.height,
      calidadAplicada,
    };
  } catch (err) {
    if (esPosibleArchivoHeic(buffer, nombreArchivo)) {
      throw new Error(
        'HEIC_NO_SOPORTADO: No se pudo decodificar la foto HEIC en este sistema. Convertila a JPG o PNG.'
      );
    }
    throw err instanceof Error
      ? err
      : new Error('IMAGEN_CORRUPTA: Error al procesar la imagen.');
  }
}

/**
 * Procesa la imagen, guarda `<producto_id>.webp` y `<producto_id>_thumb.webp` en `<directorioBase>/imagenes/`
 * y actualiza `imagen_path` e `imagen_hash` en SQLite con auditoría encadenada (Reglas 12 y 13).
 */
export async function guardarImagenProductoLocal(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    productoId: string;
    entradaBuffer: Buffer | Uint8Array;
    nombreArchivoOriginal?: string;
    directorioBase: string;
  }
): Promise<{
  imagenPathRelativo: string;
  miniaturaPathRelativo: string;
  imagenHash: string;
  bytesPrincipal: number;
  bytesMiniatura: number;
}> {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  const existente = db
    .prepare(
      `SELECT id, nombre, imagen_path, imagen_hash
       FROM productos
       WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
    )
    .get(params.productoId, actor.comercio_id) as
    | {
        id: string;
        nombre: string;
        imagen_path: string | null;
        imagen_hash: string | null;
      }
    | undefined;

  if (!existente) {
    throw new Error('Producto no encontrado.');
  }

  const procesada = await procesarImagenProducto(
    params.entradaBuffer,
    params.nombreArchivoOriginal
  );

  const carpetaImagenes = path.join(params.directorioBase, 'imagenes');
  fs.mkdirSync(carpetaImagenes, { recursive: true });

  const nombrePrincipal = `${params.productoId}.webp`;
  const nombreMiniatura = `${params.productoId}_thumb.webp`;

  const rutaAbsolutaPrincipal = path.join(carpetaImagenes, nombrePrincipal);
  const rutaAbsolutaMiniatura = path.join(carpetaImagenes, nombreMiniatura);

  fs.writeFileSync(rutaAbsolutaPrincipal, procesada.principalWebp);
  fs.writeFileSync(rutaAbsolutaMiniatura, procesada.miniaturaWebp);

  const imagenPathRelativo = `imagenes/${nombrePrincipal}`;
  const miniaturaPathRelativo = `imagenes/${nombreMiniatura}`;

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();

    db.prepare(
      `UPDATE productos
       SET imagen_path = ?,
           imagen_hash = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      imagenPathRelativo,
      procesada.imagenHash,
      ahora,
      actor.device_id,
      params.productoId,
      actor.comercio_id
    );

    db.prepare(
      `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
       VALUES (?, 'productos', ?, 'update', ?, 'pendiente', 0)`
    ).run(generarUuidV7(), params.productoId, ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'producto_actualizar_imagen',
      entidad: 'productos',
      entidad_id: params.productoId,
      valores_antes: {
        imagen_path: existente.imagen_path,
        imagen_hash: existente.imagen_hash,
      },
      valores_despues: {
        imagen_path: imagenPathRelativo,
        imagen_hash: procesada.imagenHash,
        bytes_webp: procesada.principalWebp.byteLength,
      },
      ahoraIso: ahora,
    });
  });

  return {
    imagenPathRelativo,
    miniaturaPathRelativo,
    imagenHash: procesada.imagenHash,
    bytesPrincipal: procesada.principalWebp.byteLength,
    bytesMiniatura: procesada.miniaturaWebp.byteLength,
  };
}
