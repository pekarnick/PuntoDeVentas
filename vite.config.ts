import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

function sqlitePosLocalPlugin(): Plugin {
  return {
    name: 'sqlite-pos-local-middleware',
    configureServer(server) {
      server.middlewares.use('/api/pos-imagen', (req, res) => {
        const urlSinQuery = (req.url ?? '').split('?')[0] ?? '';
        const nombreSeguro = path.basename(decodeURIComponent(urlSinQuery));
        if (!nombreSeguro || !nombreSeguro.endsWith('.webp')) {
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

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            const parsed = rawBody ? (JSON.parse(rawBody) as { accion: string; payload?: Record<string, unknown> }) : { accion: '' };
            const mod = await import('./src/db/servidor_local_dev.ts');
            const resultado = await mod.ejecutarAccionPosLocal(
              parsed.accion,
              parsed.payload ?? {}
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, data: resultado }));
          } catch (err) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  err instanceof Error
                    ? err.message
                    : 'Error al procesar operación en SQLite local.',
              })
            );
          }
        });
      });
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
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
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
});
