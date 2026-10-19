/**
 * Cola y motor de sincronización de imágenes de productos (PLAN.md §5.1).
 * - Las imágenes se transfieren DESPUÉS de los datos y en su propia cola (`sync_imagenes_cola`).
 * - Conserva `ultimo_hash_sincronizado` para evitar re-subir archivos idénticos.
 * - Sube al bucket privado `productos` en `<comercio_id>/<producto_id>.webp` y `_thumb.webp`.
 * - Descarga en segundo plano a la caché local `imagenes/` cuando un producto remoto tiene imagen nueva.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  debeBajarImagenProducto,
  debeSubirImagenProducto,
} from '../domain/sync.ts';
import { generarUuidV7 } from '../domain/uuid.ts';

function obtenerRutasImagenProducto(
  directorioBaseDatos: string,
  productoId: string
): {
  absolutaPrincipal: string;
  absolutaMiniatura: string;
} {
  const carpetaImagenes = path.join(directorioBaseDatos, 'imagenes');
  return {
    absolutaPrincipal: path.join(carpetaImagenes, `${productoId}.webp`),
    absolutaMiniatura: path.join(carpetaImagenes, `${productoId}_thumb.webp`),
  };
}

export interface TransporteImagenesNube {
  estaDisponible(): Promise<boolean>;
  subirArchivoImagen(
    comercioId: string,
    nombreArchivo: string,
    contenido: Buffer
  ): Promise<void>;
  bajarArchivoImagen(
    comercioId: string,
    nombreArchivo: string
  ): Promise<Buffer | null>;
}

export interface ResultadoSyncImagenes {
  subidasExitosas: number;
  bajadasExitosas: number;
  omitidasPorHashIdentico: number;
  errores: number;
  detalleErrores: string[];
}

export interface EstadisticasEspacioImagenes {
  cantidadArchivos: number;
  bytesTotales: number;
  kbTotales: number;
  mbTotales: number;
  porcentajeCuotaGratuita: number; // Sobre 1 GB (1024 MB) de referencia en plan gratuito Supabase
}

function calcularSha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Escanea los productos locales con imagen y encola en `sync_imagenes_cola`
 * aquellos cuyo `imagen_hash` difiere de `ultimo_hash_sincronizado`.
 */
export function sincronizarColaLocalImagenesSubida(
  db: DatabaseSync,
  comercioId: string
): number {
  const ahora = new Date().toISOString();
  const productosConImagen = db
    .prepare(
      `SELECT id, imagen_path, imagen_hash
       FROM productos
       WHERE comercio_id = ?
         AND deleted_at IS NULL
         AND imagen_path IS NOT NULL
         AND imagen_hash IS NOT NULL`
    )
    .all(comercioId) as unknown as {
    id: string;
    imagen_path: string;
    imagen_hash: string;
  }[];

  let encoladas = 0;

  for (const prod of productosConImagen) {
    const existente = db
      .prepare(
        `SELECT id, imagen_hash, ultimo_hash_sincronizado, estado
         FROM sync_imagenes_cola
         WHERE producto_id = ? AND operacion = 'subir'`
      )
      .get(prod.id) as
      | {
          id: string;
          imagen_hash: string;
          ultimo_hash_sincronizado: string | null;
          estado: string;
        }
      | undefined;

    const requiereSubida = debeSubirImagenProducto({
      imagenPathLocal: prod.imagen_path,
      imagenHashLocal: prod.imagen_hash,
      ultimoHashSincronizado: existente?.ultimo_hash_sincronizado ?? null,
    });

    if (!requiereSubida) {
      continue;
    }

    if (!existente) {
      db.prepare(
        `INSERT INTO sync_imagenes_cola (
          id, comercio_id, producto_id, imagen_path, imagen_hash,
          ultimo_hash_sincronizado, operacion, estado, intentos, ultimo_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'subir', 'pendiente', 0, NULL, ?, ?)`
      ).run(
        generarUuidV7(),
        comercioId,
        prod.id,
        prod.imagen_path,
        prod.imagen_hash,
        ahora,
        ahora
      );
      encoladas++;
    } else if (
      existente.imagen_hash !== prod.imagen_hash ||
      existente.estado === 'error'
    ) {
      db.prepare(
        `UPDATE sync_imagenes_cola
         SET imagen_path = ?,
             imagen_hash = ?,
             estado = 'pendiente',
             updated_at = ?
         WHERE id = ?`
      ).run(prod.imagen_path, prod.imagen_hash, ahora, existente.id);
      encoladas++;
    }
  }

  return encoladas;
}

/**
 * Revisa si un producto recibido por pull tiene imagen remota que falta localmente
 * o cuyo hash cambió, y la encola para descarga en segundo plano (`operacion = 'bajar'`).
 */
export function evaluarYEncolarBajadaImagenProducto(
  db: DatabaseSync,
  params: {
    comercioId: string;
    productoId: string;
    imagenPathRemoto: string | null;
    imagenHashRemoto: string | null;
    directorioBaseDatos: string;
  }
): boolean {
  if (!params.imagenPathRemoto || !params.imagenHashRemoto) {
    return false;
  }

  const rutas = obtenerRutasImagenProducto(
    params.directorioBaseDatos,
    params.productoId
  );
  const existeLocal = fs.existsSync(rutas.absolutaPrincipal);

  let hashArchivoLocal: string | null = null;
  if (existeLocal) {
    try {
      const bytes = fs.readFileSync(rutas.absolutaPrincipal);
      hashArchivoLocal = calcularSha256Buffer(bytes);
    } catch {
      hashArchivoLocal = null;
    }
  }

  const requiereBajada = debeBajarImagenProducto({
    imagenPathRemoto: params.imagenPathRemoto,
    imagenHashRemoto: params.imagenHashRemoto,
    existeArchivoLocal: existeLocal,
    imagenHashLocal: hashArchivoLocal,
  });

  if (!requiereBajada) {
    return false;
  }

  const ahora = new Date().toISOString();
  const existente = db
    .prepare(
      `SELECT id FROM sync_imagenes_cola
       WHERE producto_id = ? AND operacion = 'bajar'`
    )
    .get(params.productoId) as { id: string } | undefined;

  if (!existente) {
    db.prepare(
      `INSERT INTO sync_imagenes_cola (
        id, comercio_id, producto_id, imagen_path, imagen_hash,
        ultimo_hash_sincronizado, operacion, estado, intentos, ultimo_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'bajar', 'pendiente', 0, NULL, ?, ?)`
    ).run(
      generarUuidV7(),
      params.comercioId,
      params.productoId,
      params.imagenPathRemoto,
      params.imagenHashRemoto,
      ahora,
      ahora
    );
  } else {
    db.prepare(
      `UPDATE sync_imagenes_cola
       SET imagen_path = ?,
           imagen_hash = ?,
           estado = 'pendiente',
           ultimo_error = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(
      params.imagenPathRemoto,
      params.imagenHashRemoto,
      ahora,
      existente.id
    );
  }

  return true;
}

/**
 * Procesa la cola de imágenes (`sync_imagenes_cola`) en segundo plano.
 * Siempre se ejecuta DESPUÉS de la sincronización de datos (PLAN.md §5.1).
 */
export async function procesarColaSincronizacionImagenes(
  db: DatabaseSync,
  transporte: TransporteImagenesNube,
  params: {
    comercioId: string;
    directorioBaseDatos: string;
  }
): Promise<ResultadoSyncImagenes> {
  sincronizarColaLocalImagenesSubida(db, params.comercioId);

  const disponible = await transporte.estaDisponible();
  if (!disponible) {
    return {
      subidasExitosas: 0,
      bajadasExitosas: 0,
      omitidasPorHashIdentico: 0,
      errores: 0,
      detalleErrores: [],
    };
  }

  const pendientes = db
    .prepare(
      `SELECT id, producto_id, imagen_path, imagen_hash, ultimo_hash_sincronizado, operacion, intentos
       FROM sync_imagenes_cola
       WHERE comercio_id = ? AND estado = 'pendiente'
       ORDER BY updated_at ASC`
    )
    .all(params.comercioId) as unknown as {
    id: string;
    producto_id: string;
    imagen_path: string;
    imagen_hash: string;
    ultimo_hash_sincronizado: string | null;
    operacion: 'subir' | 'bajar';
    intentos: number;
  }[];

  let subidasExitosas = 0;
  let bajadasExitosas = 0;
  let omitidasPorHashIdentico = 0;
  let errores = 0;
  const detalleErrores: string[] = [];

  for (const item of pendientes) {
    const ahora = new Date().toISOString();
    const rutas = obtenerRutasImagenProducto(
      params.directorioBaseDatos,
      item.producto_id
    );
    const nombrePrincipal = `${item.producto_id}.webp`;
    const nombreMiniatura = `${item.producto_id}_thumb.webp`;

    try {
      if (item.operacion === 'subir') {
        if (
          !debeSubirImagenProducto({
            imagenPathLocal: item.imagen_path,
            imagenHashLocal: item.imagen_hash,
            ultimoHashSincronizado: item.ultimo_hash_sincronizado,
          })
        ) {
          db.prepare(
            `UPDATE sync_imagenes_cola
             SET estado = 'sincronizado', updated_at = ?
             WHERE id = ?`
          ).run(ahora, item.id);
          omitidasPorHashIdentico++;
          continue;
        }

        if (!fs.existsSync(rutas.absolutaPrincipal)) {
          // Regla 12: la falta de una imagen nunca debe romper una pantalla ni operación
          db.prepare(
            `UPDATE sync_imagenes_cola
             SET estado = 'sincronizado',
                 ultimo_error = 'Archivo local no encontrado; omitido sin bloquear.',
                 updated_at = ?
             WHERE id = ?`
          ).run(ahora, item.id);
          continue;
        }

        const bytesPrincipal = fs.readFileSync(rutas.absolutaPrincipal);
        await transporte.subirArchivoImagen(
          params.comercioId,
          nombrePrincipal,
          bytesPrincipal
        );

        if (fs.existsSync(rutas.absolutaMiniatura)) {
          const bytesThumb = fs.readFileSync(rutas.absolutaMiniatura);
          await transporte.subirArchivoImagen(
            params.comercioId,
            nombreMiniatura,
            bytesThumb
          );
        }

        db.prepare(
          `UPDATE sync_imagenes_cola
           SET estado = 'sincronizado',
               ultimo_hash_sincronizado = ?,
               ultimo_error = NULL,
               updated_at = ?
           WHERE id = ?`
        ).run(item.imagen_hash, ahora, item.id);

        subidasExitosas++;
      } else {
        // Operación: bajar a caché local imagenes/
        const bytesRemotos = await transporte.bajarArchivoImagen(
          params.comercioId,
          nombrePrincipal
        );
        if (bytesRemotos) {
          const dirImagenes = path.dirname(rutas.absolutaPrincipal);
          fs.mkdirSync(dirImagenes, { recursive: true });
          fs.writeFileSync(rutas.absolutaPrincipal, bytesRemotos);

          const bytesThumbRemotos = await transporte.bajarArchivoImagen(
            params.comercioId,
            nombreMiniatura
          );
          if (bytesThumbRemotos) {
            fs.writeFileSync(rutas.absolutaMiniatura, bytesThumbRemotos);
          }

          db.prepare(
            `UPDATE sync_imagenes_cola
             SET estado = 'sincronizado',
                 ultimo_hash_sincronizado = ?,
                 ultimo_error = NULL,
                 updated_at = ?
             WHERE id = ?`
          ).run(item.imagen_hash, ahora, item.id);

          bajadasExitosas++;
        } else {
          db.prepare(
            `UPDATE sync_imagenes_cola
             SET estado = 'sincronizado',
                 ultimo_error = 'Imagen aún no disponible en Storage remoto.',
                 updated_at = ?
             WHERE id = ?`
          ).run(ahora, item.id);
        }
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Error desconocido al transferir imagen.';
      errores++;
      detalleErrores.push(`Producto ${item.producto_id}: ${msg}`);
      db.prepare(
        `UPDATE sync_imagenes_cola
         SET estado = 'error',
             intentos = intentos + 1,
             ultimo_error = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(msg, ahora, item.id);
    }
  }

  return {
    subidasExitosas,
    bajadasExitosas,
    omitidasPorHashIdentico,
    errores,
    detalleErrores,
  };
}

/**
 * Calcula el espacio total usado por la carpeta local `imagenes/` (PLAN.md §5.1).
 */
export function calcularEspacioImagenesLocal(
  directorioBaseDatos: string
): EstadisticasEspacioImagenes {
  const dirImagenes = path.join(directorioBaseDatos, 'imagenes');
  if (!fs.existsSync(dirImagenes)) {
    return {
      cantidadArchivos: 0,
      bytesTotales: 0,
      kbTotales: 0,
      mbTotales: 0,
      porcentajeCuotaGratuita: 0,
    };
  }

  const archivos = fs
    .readdirSync(dirImagenes)
    .filter((f) => f.endsWith('.webp'));
  let bytesTotales = 0;

  for (const nombre of archivos) {
    try {
      const stat = fs.statSync(path.join(dirImagenes, nombre));
      bytesTotales += stat.size;
    } catch {
      // Ignorar si un archivo desapareció durante la lectura
    }
  }

  const kbTotales = Math.round((bytesTotales / 1024) * 100) / 100;
  const mbTotales = Math.round((bytesTotales / (1024 * 1024)) * 100) / 100;
  const cuotaGratuitaBytes = 1024 * 1024 * 1024; // 1 GB Supabase Free Tier Storage
  const porcentajeCuotaGratuita =
    Math.round((bytesTotales / cuotaGratuitaBytes) * 10000) / 100;

  return {
    cantidadArchivos: archivos.length,
    bytesTotales,
    kbTotales,
    mbTotales,
    porcentajeCuotaGratuita,
  };
}
