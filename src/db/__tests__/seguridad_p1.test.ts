import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { hashearClaveArgon2id } from '../../domain/claves.ts';
import {
  crearBackupBaseDatosLocal,
  restaurarDesdeBackupLocal,
} from '../backup_repo.ts';
import { crearBaseDatos } from '../migrator.ts';
import {
  inicializarComercioYSuperadmin,
  type ActorContexto,
} from '../repositorios.ts';
import {
  guardarConfiguracionNetlify,
  iniciarSesionMovil,
} from '../venta_movil_repo.ts';
import {
  desplegarSitioNetlify,
  prepararPaqueteVentaMovilNetlify,
} from '../../sync/desplegador_netlify.ts';
import { crearArchivoZip } from '../../sync/zip_ligero.ts';

const requireNode = createRequire(import.meta.url);
const ARGON_TEST_OPTS = { m: 1024, t: 1, p: 1 } as const;

describe('Auditoría de Seguridad — Lote P1', () => {
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-p1-test-'));

  afterAll(() => {
    try {
      fs.rmSync(dirTmp, { recursive: true, force: true });
    } catch {
      // Ignorar si Windows mantiene handle abierto al cerrar Vitest
    }
  });

  it('1. Migración 009 instala triggers append-only y guardarConfiguracionNetlify no persiste netlify_token en SQLite', () => {
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Comercio P1',
      cuit: '20-12345678-6',
      condicionIva: 'monotributo',
      nombreAdmin: 'Admin P1',
      usuarioAdmin: 'adminp1',
      claveHashAdmin: hashearClaveArgon2id('ClaveP1Seguro!', ARGON_TEST_OPTS),
      deviceId: 'term-p1',
    });

    const actor: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'Admin P1',
      rol: 'superadmin',
      device_id: 'term-p1',
    };

    // Triggers append-only de migración 009 presentes
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .all() as unknown as Array<{ name: string }>;
    const nombres = triggers.map((t) => t.name);
    expect(nombres).toContain('trg_cc_movimientos_no_update');
    expect(nombres).toContain('trg_cc_movimientos_no_delete');
    expect(nombres).toContain('trg_compras_no_delete');
    expect(nombres).toContain('trg_compras_items_no_update');
    expect(nombres).toContain('trg_ventas_no_delete');

    // netlify_token nunca se persiste en texto plano en SQLite
    const cfg = guardarConfiguracionNetlify(db, {
      actor,
      netlifyToken: 'nfp_secreto_no_persistir_123456',
      netlifySiteName: 'comercio-p1',
    });
    expect(cfg.netlify_token).toBe('nfp_secreto_no_persistir_123456');

    const row = db
      .prepare('SELECT netlify_token FROM configuracion_sistema WHERE comercio_id = ?')
      .get(comercioId) as { netlify_token: string | null } | undefined;
    expect(row?.netlify_token).toBeNull();
  });

  it('2. crearBackupBaseDatosLocal sanitiza secretos y restaurarDesdeBackupLocal valida tenant, auditoría y formato', () => {
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Comercio Backup P1',
      cuit: '20-12345678-6',
      condicionIva: 'monotributo',
      nombreAdmin: 'Admin Backup',
      usuarioAdmin: 'adminbk',
      claveHashAdmin: hashearClaveArgon2id('ClaveBkSeguro!', ARGON_TEST_OPTS),
      deviceId: 'term-bk',
    });

    const actor: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'Admin Backup',
      rol: 'superadmin',
      device_id: 'term-bk',
    };

    // Habilitar venta móvil e iniciar una sesión móvil para comprobar que se limpia en el backup
    db.prepare('UPDATE comercios SET venta_movil_habilitada = 1 WHERE id = ?').run(comercioId);
    db.prepare('UPDATE usuarios SET puede_vender_movil = 1 WHERE id = ?').run(superadminId);
    iniciarSesionMovil(db, {
      comercioId,
      usuario: 'adminbk',
      clave: 'ClaveBkSeguro!',
      dispositivoId: 'cel-bk-1',
    });

    const backup = crearBackupBaseDatosLocal(db, actor, {
      directorioBaseDatos: dirTmp,
      tipo: 'manual',
    });

    const sqlite = requireNode('node:sqlite') as typeof import('node:sqlite');
    const dbBk = new sqlite.DatabaseSync(backup.ruta_archivo, { readOnly: true });
    try {
      const sesionesBk = dbBk
        .prepare('SELECT COUNT(*) AS total FROM sesiones_moviles')
        .get() as { total: number };
      expect(Number(sesionesBk.total)).toBe(0);
    } finally {
      dbBk.close();
    }

    // Rechazar archivo no-SQLite
    const rutaNoSqlite = path.join(dirTmp, 'falso.db');
    fs.writeFileSync(rutaNoSqlite, 'NO_ES_SQLITE', 'utf-8');
    expect(() =>
      restaurarDesdeBackupLocal(db, actor, {
        rutaArchivoBackup: rutaNoSqlite,
        directorioBaseDatos: dirTmp,
      })
    ).toThrow(/SQLite válida/);

    // Rechazar backup de otro comercio
    const dbOtro = crearBaseDatos(':memory:');
    const otro = inicializarComercioYSuperadmin(dbOtro, {
      nombreComercio: 'Otro Comercio',
      cuit: '20-99999999-9',
      condicionIva: 'monotributo',
      nombreAdmin: 'Otro Admin',
      usuarioAdmin: 'otroadm',
      claveHashAdmin: hashearClaveArgon2id('OtroAdmin1234!', ARGON_TEST_OPTS),
      deviceId: 'term-otro',
    });
    const bkOtro = crearBackupBaseDatosLocal(
      dbOtro,
      {
        comercio_id: otro.comercioId,
        usuario_id: otro.superadminId,
        usuario_nombre: 'Otro Admin',
        rol: 'superadmin',
        device_id: 'term-otro',
      },
      {
        directorioBaseDatos: dirTmp,
        tipo: 'manual',
        nombreArchivoPersonalizado: 'otro_comercio.db',
      }
    );

    expect(() =>
      restaurarDesdeBackupLocal(db, actor, {
        rutaArchivoBackup: bkOtro.ruta_archivo,
        directorioBaseDatos: dirTmp,
      })
    ).toThrow(/BACKUP_OTRO_COMERCIO/);
  });

  it('3. Netlify Function no contiene mock usr-movil-1 ni x-rol-usuario, y desplegarSitioNetlify valida siteId', async () => {
    const zipBuf = prepararPaqueteVentaMovilNetlify({
      supabaseUrl: 'https://ejemplo.supabase.co',
      supabaseAnonKey: 'anon_public_key_test',
      comercioId: '01950000-0000-7000-8000-000000000001',
      comercioNombre: 'Comercio Netlify',
    });
    const contenidoZip = zipBuf.toString('utf-8');
    expect(contenidoZip).not.toContain('usr-movil-1');
    expect(contenidoZip).not.toContain('x-rol-usuario');

    const zipValidoMinimo = crearArchivoZip([
      { nombre: 'robots.txt', contenido: 'User-agent: *\nDisallow: /\n' },
    ]);
    const resTraversal = await desplegarSitioNetlify({
      token: 'nfp_12345678901234567890',
      zipBuffer: zipValidoMinimo,
      siteId: '../evil',
    });
    expect(resTraversal.ok).toBe(false);
    expect(resTraversal.error).toMatch(/SITE_ID_INVALIDO/);
  });

  it('4. Verificación estática de CSP en Tauri, ausencia de document.write y eliminación de defaults hardcodeados', () => {
    const tauriConf = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf-8')
    ) as { app?: { security?: { csp?: string | null } } };
    expect(typeof tauriConf.app?.security?.csp).toBe('string');
    expect(tauriConf.app?.security?.csp).toContain("default-src 'self'");

    const panelConfig = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/configuracion/PanelConfiguracionSync.tsx'),
      'utf-8'
    );
    expect(panelConfig).not.toContain('document.write');

    const viteCfg = fs.readFileSync(
      path.resolve(process.cwd(), 'vite.config.ts'),
      'utf-8'
    );
    expect(viteCfg).not.toContain('sb_publishable_');
    expect(viteCfg).not.toContain('dspvjhnqmgjzpjzxvmhg');

    const clienteApi = fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/cliente_pos_api.ts'),
      'utf-8'
    );
    expect(clienteApi).not.toContain('sb_publishable_');
    expect(clienteApi).not.toContain('dspvjhnqmgjzpjzxvmhg');
  });
});
