import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const hostEnv = process.env.TAURI_DEV_HOST?.trim();
const hostPermitido =
  hostEnv &&
  (hostEnv === '127.0.0.1' ||
    hostEnv === 'localhost' ||
    hostEnv === '::1' ||
    process.env.POS_ALLOW_REMOTE_DEV === '1')
    ? hostEnv
    : undefined;

const MAX_BYTES_GENERAL_API = 2 * 1024 * 1024;
const MAX_BYTES_IMAGEN_API = 26 * 1024 * 1024;
const ACCIONES_CON_IMAGEN = new Set([
  'crear_producto',
  'actualizar_producto',
  'subir_imagen_producto',
]);

function esOrigenLocalPermitido(
  originHeader: string | undefined,
  secFetchSite: string | undefined
): boolean {
  if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
    return false;
  }
  if (!originHeader) return true;
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

function sqlitePosLocalPlugin(): Plugin {
  return {
    name: 'sqlite-pos-local-middleware',
    configureServer(server) {
      server.middlewares.use('/api/pos-imagen', async (req, res) => {
        const secFetchSite =
          typeof req.headers['sec-fetch-site'] === 'string'
            ? req.headers['sec-fetch-site']
            : undefined;
        const origin =
          typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (!esOrigenLocalPermitido(origin, secFetchSite)) {
          res.statusCode = 403;
          res.end();
          return;
        }

        const rawUrl = req.url ?? '';
        const [urlSinQuery = '', queryStr = ''] = rawUrl.split('?');
        const paramsQuery = new URLSearchParams(queryStr);
        const sessionTokenHeader =
          typeof req.headers['x-pos-session'] === 'string'
            ? req.headers['x-pos-session'].trim()
            : '';
        const sessionToken =
          sessionTokenHeader || (paramsQuery.get('st') ?? '').trim();

        const mod = await import('./src/db/servidor_local_dev.ts');
        if (!mod.validarTokenSesionLocal(sessionToken)) {
          res.statusCode = 401;
          res.end();
          return;
        }

        const nombreSeguro = path.basename(decodeURIComponent(urlSinQuery));
        if (!/^[0-9a-f-]{36}(_thumb)?\.webp$/i.test(nombreSeguro)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const rutaImagen = path.resolve(
          process.cwd(),
          'data',
          'imagenes',
          nombreSeguro
        );
        if (!fs.existsSync(rutaImagen)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(rutaImagen));
      });

      server.middlewares.use('/api/pos', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        const secFetchSite =
          typeof req.headers['sec-fetch-site'] === 'string'
            ? req.headers['sec-fetch-site']
            : undefined;
        const origin =
          typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (!esOrigenLocalPermitido(origin, secFetchSite)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'Origen no permitido.' }));
          return;
        }

        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          res.statusCode = 415;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              ok: false,
              error: 'Content-Type debe ser application/json.',
            })
          );
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
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                ok: false,
                error: 'El cuerpo de la solicitud supera el límite permitido.',
              })
            );
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
              res.statusCode = 413;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'El payload supera el tamaño máximo permitido de 2 MB.',
                })
              );
              return;
            }

            const sessionToken =
              typeof req.headers['x-pos-session'] === 'string'
                ? req.headers['x-pos-session'].trim()
                : undefined;

            const mod = await import('./src/db/servidor_local_dev.ts');
            const resultado = await mod.ejecutarAccionPosLocal(
              parsed.accion,
              parsed.payload ?? {},
              undefined,
              { sessionToken }
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, data: resultado }));
          } catch (err) {
            const msg =
              err instanceof Error
                ? err.message
                : 'Error al procesar operación en SQLite local.';
            res.statusCode = msg.includes('SESION_NO_AUTENTICADA') ? 401 : 400;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                ok: false,
                error: msg,
              })
            );
          }
        });
      });
    },
    async closeBundle() {
      try {
        const distDir = path.resolve(process.cwd(), 'dist');
        const webPosDir = path.join(distDir, 'web-pos');
        if (!fs.existsSync(webPosDir)) return;

        const supabaseUrl = (process.env.VITE_SUPABASE_URL ?? '').trim();
        const supabaseAnonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
        const comercioId = (process.env.VITE_COMERCIO_ID ?? '').trim();
        const comercioNombre = (
          process.env.VITE_COMERCIO_NOMBRE ?? 'Comercio Local POS'
        ).trim();

        const configClienteJs = `// Configuración pública de sincronización del comercio (Regla 8: solo anon_key con RLS)
window.__POS_CONFIG__ = {
  supabaseUrl: ${JSON.stringify(supabaseUrl)},
  supabaseAnonKey: ${JSON.stringify(supabaseAnonKey)},
  comercioId: ${JSON.stringify(comercioId)},
  comercioNombre: ${JSON.stringify(comercioNombre)},
  desplegadoAt: ${JSON.stringify(new Date().toISOString())},
};
`;
        fs.writeFileSync(
          path.join(webPosDir, 'pos-config.js'),
          configClienteJs,
          'utf-8'
        );

        const webPosIndexPath = path.join(webPosDir, 'index.html');
        if (fs.existsSync(webPosIndexPath)) {
          let html = fs.readFileSync(webPosIndexPath, 'utf-8');
          if (!html.includes('pos-config.js')) {
            html = html.replace(
              '</head>',
              '    <script src="/web-pos/pos-config.js"></script>\n  </head>'
            );
          }
          fs.writeFileSync(webPosIndexPath, html, 'utf-8');
        }

        const modDom = await import('./packages/domain/src/index.ts');
        fs.writeFileSync(
          path.join(distDir, 'robots.txt'),
          modDom.generarRobotsTxtAntiIndexacion(),
          'utf-8'
        );
        fs.writeFileSync(
          path.join(distDir, '_headers'),
          modDom.generarNetlifyHeadersAntiIndexacion(),
          'utf-8'
        );
        fs.writeFileSync(
          path.join(distDir, '_redirects'),
          modDom.generarNetlifyRedirects(),
          'utf-8'
        );

        const modNetlify = await import('./src/sync/desplegador_netlify.ts');
        const zipBuffer = modNetlify.prepararPaqueteVentaMovilNetlify({
          supabaseUrl,
          supabaseAnonKey,
          comercioId,
          comercioNombre,
          directorioDist: distDir,
        });
        fs.writeFileSync(
          path.join(distDir, 'cajero-movil-netlify.zip'),
          zipBuffer
        );
      } catch {
        // Ignorar errores opcionales post-build
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), sqlitePosLocalPlugin()],
  resolve: {
    alias: {
      '@pos/domain': path.resolve(process.cwd(), 'packages/domain/src/index.ts'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: hostPermitido || '127.0.0.1',
    hmr: hostPermitido
      ? {
          protocol: 'ws',
          host: hostPermitido,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/data/**'],
    },
  },
  ssr: {
    external: ['node:sqlite', 'sharp'],
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(process.cwd(), 'index.html'),
        'web-pos': path.resolve(process.cwd(), 'web-pos/index.html'),
      },
      external: ['node:sqlite', 'sharp'],
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.agents'],
  },
});
