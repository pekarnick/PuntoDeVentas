/**
 * Servidor HTTP local standalone para el ejecutable de escritorio Tauri.
 * Expone `/api/pos`, `/api/pos-imagen/*` y `/api/pos-health` exclusivamente en 127.0.0.1,
 * protegido por validación de origen local, `X-POS-Boot-Token` y `X-POS-Session`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ejecutarAccionPosLocal,
  validarTokenSesionLocal,
} from './servidor_local_dev.ts';

const MAX_BYTES_GENERAL_API = 2 * 1024 * 1024;
const MAX_BYTES_IMAGEN_API = 26 * 1024 * 1024;
const ACCIONES_CON_IMAGEN = new Set([
  'crear_producto',
  'actualizar_producto',
  'subir_imagen_producto',
]);

export function esOrigenLocalPermitido(
  originHeader: string | undefined,
  secFetchSite: string | undefined,
  tieneBootTokenConfigurado: boolean = false
): boolean {
  if (originHeader) {
    try {
      const u = new URL(originHeader);
      const h = u.hostname.toLowerCase();
      return (
        h === 'localhost' ||
        h === '127.0.0.1' ||
        h === '::1' ||
        h === 'tauri.localhost' ||
        u.protocol === 'tauri:'
      );
    } catch {
      return false;
    }
  }

  // Sin cabecera Origin (ej. etiquetas <img> desde tauri.localhost -> 127.0.0.1 o cliente IPC Rust):
  // Si el servidor exige bootToken criptográfico en cada endpoint, se permite avanzar a la validación del token.
  if (tieneBootTokenConfigurado) {
    return true;
  }

  if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
    return false;
  }
  return true;
}

function verificarBootToken(
  tokenRecibido: string | undefined,
  bootTokenEsperado: string | null
): boolean {
  if (!bootTokenEsperado) return true;
  if (!tokenRecibido) return false;
  const a = Buffer.from(tokenRecibido.trim(), 'utf-8');
  const b = Buffer.from(bootTokenEsperado, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function aplicarCabecerasCors(
  res: ServerResponse,
  originHeader: string | undefined
): void {
  if (!originHeader) return;
  res.setHeader('Access-Control-Allow-Origin', originHeader);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-POS-Session, X-POS-Boot-Token'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
}

function enviarJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(payload.length));
  res.setHeader('Connection', 'close');
  res.end(payload);
}

export interface OpcionesServidorHttpPosLocal {
  readonly dataDir?: string;
  readonly port?: number;
  readonly bootToken?: string | null;
}

export interface ServidorHttpPosLocalInstancia {
  readonly server: Server;
  readonly port: number;
  readonly dataDir: string;
  readonly rutaDb: string;
  readonly cerrar: () => Promise<void>;
}

export async function iniciarServidorHttpPosLocal(
  opciones: OpcionesServidorHttpPosLocal = {}
): Promise<ServidorHttpPosLocalInstancia> {
  const dataDir = path.resolve(
    opciones.dataDir?.trim() ||
      process.env.POS_DATA_DIR?.trim() ||
      path.resolve(process.cwd(), 'data')
  );
  fs.mkdirSync(dataDir, { recursive: true });
  const rutaDb = path.join(dataDir, 'pos_local.db');

  const puertoSolicitado =
    opciones.port !== undefined
      ? opciones.port
      : Number(process.env.POS_PORT ?? 0);

  const bootToken =
    opciones.bootToken !== undefined
      ? opciones.bootToken?.trim() || null
      : process.env.POS_BOOT_TOKEN?.trim() || null;

  const tieneBootToken = Boolean(bootToken);

  const server = http.createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const origin =
        typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const secFetchSite =
        typeof req.headers['sec-fetch-site'] === 'string'
          ? req.headers['sec-fetch-site']
          : undefined;

      if (!esOrigenLocalPermitido(origin, secFetchSite, tieneBootToken)) {
        enviarJson(res, 403, { ok: false, error: 'Origen no permitido.' });
        return;
      }

      aplicarCabecerasCors(res, origin);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }

      const rawUrl = req.url ?? '/';
      const [pathname = '/', queryStr = ''] = rawUrl.split('?');

      if (req.method === 'GET' && pathname === '/api/pos-health') {
        enviarJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/api/pos-imagen/')) {
        const paramsQuery = new URLSearchParams(queryStr);
        const bootHeader =
          typeof req.headers['x-pos-boot-token'] === 'string'
            ? req.headers['x-pos-boot-token']
            : undefined;
        const bootRecibido = bootHeader ?? paramsQuery.get('bt') ?? undefined;
        if (!verificarBootToken(bootRecibido, bootToken)) {
          res.statusCode = 401;
          res.end();
          return;
        }

        const sessionHeader =
          typeof req.headers['x-pos-session'] === 'string'
            ? req.headers['x-pos-session'].trim()
            : '';
        const sessionToken =
          sessionHeader || (paramsQuery.get('st') ?? '').trim();
        if (!validarTokenSesionLocal(sessionToken)) {
          res.statusCode = 401;
          res.end();
          return;
        }

        const segmento = pathname.slice('/api/pos-imagen/'.length);
        let nombreSeguro = '';
        try {
          nombreSeguro = path.basename(decodeURIComponent(segmento));
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }

        if (!/^[0-9a-f-]{36}(_thumb)?\.webp$/i.test(nombreSeguro)) {
          res.statusCode = 404;
          res.end();
          return;
        }

        const rutaImagen = path.resolve(dataDir, 'imagenes', nombreSeguro);
        if (!fs.existsSync(rutaImagen)) {
          res.statusCode = 404;
          res.end();
          return;
        }

        const imgBytes = fs.readFileSync(rutaImagen);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Content-Length', String(imgBytes.length));
        res.setHeader('Cache-Control', 'no-cache');
        res.end(imgBytes);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pos') {
        const bootHeader =
          typeof req.headers['x-pos-boot-token'] === 'string'
            ? req.headers['x-pos-boot-token']
            : undefined;
        if (!verificarBootToken(bootHeader, bootToken)) {
          enviarJson(res, 401, {
            ok: false,
            error: 'BOOT_TOKEN_INVALIDO: Token de arranque local inválido.',
          });
          return;
        }

        const contentType = String(
          req.headers['content-type'] ?? ''
        ).toLowerCase();
        if (!contentType.startsWith('application/json')) {
          enviarJson(res, 415, {
            ok: false,
            error: 'Content-Type debe ser application/json.',
          });
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let excedido = false;

        req.on('data', (chunk: Buffer) => {
          if (excedido) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_BYTES_IMAGEN_API) {
            excedido = true;
            enviarJson(res, 413, {
              ok: false,
              error: 'El cuerpo de la solicitud supera el límite permitido.',
            });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        req.on('end', async () => {
          if (excedido) return;
          try {
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            const parsed = rawBody
              ? (JSON.parse(rawBody) as {
                  accion: string;
                  payload?: Record<string, unknown>;
                })
              : { accion: '' };

            if (
              totalBytes > MAX_BYTES_GENERAL_API &&
              !ACCIONES_CON_IMAGEN.has(parsed.accion)
            ) {
              enviarJson(res, 413, {
                ok: false,
                error:
                  'El payload supera el tamaño máximo permitido de 2 MB.',
              });
              return;
            }

            const sessionToken =
              typeof req.headers['x-pos-session'] === 'string'
                ? req.headers['x-pos-session'].trim()
                : undefined;

            const resultado = await ejecutarAccionPosLocal(
              parsed.accion,
              parsed.payload ?? {},
              rutaDb,
              { sessionToken }
            );
            enviarJson(res, 200, { ok: true, data: resultado });
          } catch (err) {
            const msg =
              err instanceof Error
                ? err.message
                : 'Error al procesar operación en SQLite local.';
            enviarJson(
              res,
              msg.includes('SESION_NO_AUTENTICADA') ? 401 : 400,
              { ok: false, error: msg }
            );
          }
        });
        return;
      }

      enviarJson(res, 404, { ok: false, error: 'Ruta no encontrada.' });
    }
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      Number.isFinite(puertoSolicitado) ? puertoSolicitado : 0,
      '127.0.0.1',
      () => {
        server.off('error', reject);
        resolve();
      }
    );
  });

  const direccion = server.address();
  const port =
    direccion && typeof direccion === 'object' ? direccion.port : 0;

  return {
    server,
    port,
    dataDir,
    rutaDb,
    cerrar: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function ejecutarComoProcesoPrincipal(): Promise<void> {
  const instancia = await iniciarServidorHttpPosLocal();
  process.stdout.write(
    `${JSON.stringify({ posBackendReady: true, port: instancia.port })}\n`
  );

  let cerrando = false;
  const apagar = () => {
    if (cerrando) return;
    cerrando = true;
    void instancia.cerrar().finally(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.stdin.resume();
  process.stdin.on('end', apagar);
  process.stdin.on('close', apagar);
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);
}

const scriptPrincipal = process.argv[1];
const esMain =
  typeof scriptPrincipal === 'string' &&
  scriptPrincipal.length > 0 &&
  path.resolve(scriptPrincipal) ===
    path.resolve(fileURLToPath(import.meta.url));

if (esMain) {
  ejecutarComoProcesoPrincipal().catch((err) => {
    const mensaje = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error iniciando backend POS: ${mensaje}\n`);
    process.exit(1);
  });
}
