/**
 * Empaqueta el backend local SQLite + runtime Node.js + Sharp + migraciones
 * en `src-tauri/backend-bundle/` para que el instalador Tauri (.msi / .exe)
 * funcione 100% standalone sin depender de Vite ni de Node preinstalado.
 */

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const raiz = process.cwd();
const bundleDir = path.resolve(raiz, 'src-tauri', 'backend-bundle');

function copiarSiExiste(origen, destino) {
  if (!fs.existsSync(origen)) return;
  fs.cpSync(origen, destino, { recursive: true });
}

async function main() {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  // 1. Bundle ESM del servidor HTTP standalone (mantiene sharp y node:sqlite externos)
  await build({
    entryPoints: [path.resolve(raiz, 'src', 'db', 'servidor_http_standalone.ts')],
    outfile: path.resolve(bundleDir, 'server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['sharp', 'node:sqlite'],
    banner: {
      js: `import { createRequire as __posCreateRequire } from 'node:module';\nconst require = __posCreateRequire(import.meta.url);\n`,
    },
    logLevel: 'info',
  });

  // 2. Copiar runtime de Node.js (el mismo binario que está ejecutando este script)
  const nombreNode = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(bundleDir, nombreNode));

  // 3. Copiar subconjunto mínimo de node_modules necesario para Sharp en runtime
  const nodeModulesSrc = path.resolve(raiz, 'node_modules');
  const nodeModulesDest = path.join(bundleDir, 'node_modules');
  fs.mkdirSync(nodeModulesDest, { recursive: true });

  const sharpSrc = path.join(nodeModulesSrc, 'sharp');
  const sharpDest = path.join(nodeModulesDest, 'sharp');
  fs.mkdirSync(sharpDest, { recursive: true });
  copiarSiExiste(
    path.join(sharpSrc, 'package.json'),
    path.join(sharpDest, 'package.json')
  );
  copiarSiExiste(path.join(sharpSrc, 'dist'), path.join(sharpDest, 'dist'));
  copiarSiExiste(path.join(sharpSrc, 'lib'), path.join(sharpDest, 'lib'));

  const paquetePlataformaImg = `sharp-${process.platform}-${process.arch}`;
  const paquetesImg = ['colour', paquetePlataformaImg];
  for (const pkg of paquetesImg) {
    const src = path.join(nodeModulesSrc, '@img', pkg);
    const dest = path.join(nodeModulesDest, '@img', pkg);
    copiarSiExiste(src, dest);
  }

  for (const dep of ['detect-libc', 'semver']) {
    copiarSiExiste(
      path.join(nodeModulesSrc, dep),
      path.join(nodeModulesDest, dep)
    );
  }

  // 4. Copiar migraciones SQLite
  const migrationsDest = path.join(bundleDir, 'migrations');
  fs.mkdirSync(migrationsDest, { recursive: true });
  const migrationsSrc = path.resolve(raiz, 'migrations');
  for (const archivo of fs.readdirSync(migrationsSrc)) {
    if (archivo.endsWith('.sql')) {
      fs.copyFileSync(
        path.join(migrationsSrc, archivo),
        path.join(migrationsDest, archivo)
      );
    }
  }

  // 5. Copiar scripts SQL de Supabase
  const supabaseDest = path.join(bundleDir, 'supabase');
  fs.mkdirSync(supabaseDest, { recursive: true });
  copiarSiExiste(
    path.resolve(raiz, 'supabase', 'esquema_completo_unificado.sql'),
    path.join(supabaseDest, 'esquema_completo_unificado.sql')
  );
  copiarSiExiste(
    path.resolve(raiz, 'supabase', 'migrations'),
    path.join(supabaseDest, 'migrations')
  );

  console.log(`[build:backend] Bundle generado en ${bundleDir}`);
}

main().catch((err) => {
  console.error('[build:backend] Error al empaquetar backend Tauri:', err);
  process.exit(1);
});
