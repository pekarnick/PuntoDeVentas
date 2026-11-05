import { describe, expect, it } from 'vitest';
import { crearBaseDatos } from '../migrator.ts';
import {
  guardarConfiguracionNetlify,
  obtenerConfiguracionNetlify,
  registrarDespliegueNetlifyExitoso,
} from '../venta_movil_repo.ts';
import { prepararPaqueteVentaMovilNetlify } from '../../sync/desplegador_netlify.ts';
import type { ActorContexto } from '../repositorios.ts';

describe('Despliegue en Netlify y Bloqueo de Buscadores', () => {
  it('inicializa y guarda la configuración de Netlify en SQLite de forma auditada', () => {
    const db = crearBaseDatos(':memory:');
    const comercioId = '11111111-1111-1111-1111-111111111111';
    const usuarioId = '22222222-2222-2222-2222-222222222222';

    // Insertar comercio base
    db.prepare(
      `INSERT INTO comercios (id, comercio_id, nombre, cuit, condicion_iva, venta_movil_habilitada, created_at, updated_at, device_id)
       VALUES (?, ?, 'Kiosco Central', '20123456789', 'monotributo', 0, datetime('now'), datetime('now'), 'test-dev')`
    ).run(comercioId, comercioId);

    const actor: ActorContexto = {
      usuario_id: usuarioId,
      usuario_nombre: 'Super Administrador',
      rol: 'superadmin',
      comercio_id: comercioId,
      device_id: 'test-dev',
    };

    // 1. Obtener inicial (todo nulo)
    const inicial = obtenerConfiguracionNetlify(db, comercioId);
    expect(inicial.netlify_token).toBeNull();
    expect(inicial.netlify_site_id).toBeNull();
    expect(inicial.venta_movil_habilitada).toBe(false);

    // 2. Guardar credenciales de Netlify
    const guardado = guardarConfiguracionNetlify(db, {
      actor,
      netlifyToken: 'nfp_PruebaToken1234567890abcdef',
      netlifySiteName: 'kiosco-central-pos',
    });

    expect(guardado.netlify_token).toBe('nfp_PruebaToken1234567890abcdef');
    expect(guardado.netlify_site_name).toBe('kiosco-central-pos');

    // 3. Registrar despliegue exitoso
    const estadoFinal = registrarDespliegueNetlifyExitoso(db, {
      actor,
      siteId: 'site-netlify-12345',
      siteName: 'kiosco-central-pos',
      siteUrl: 'https://kiosco-central-pos.netlify.app',
      urlVentaMovil: 'https://kiosco-central-pos.netlify.app/web-pos',
      token: 'nfp_PruebaToken1234567890abcdef',
    });

    expect(estadoFinal.venta_movil_habilitada).toBe(true);
    expect(estadoFinal.venta_movil_url).toBe(
      'https://kiosco-central-pos.netlify.app/web-pos'
    );
    expect(estadoFinal.qr_svg).toContain('<svg');

    // 4. Verificar auditoría encadenada
    const auditoria = db
      .prepare(
        `SELECT accion, entidad, motivo, hash FROM auditoria WHERE accion = 'desplegar_cajero_movil_netlify'`
      )
      .get() as { accion: string; entidad: string; motivo: string; hash: string };

    expect(auditoria).toBeDefined();
    expect(auditoria.accion).toBe('desplegar_cajero_movil_netlify');
    expect(auditoria.entidad).toBe('configuracion_sistema');
    expect(auditoria.hash.length).toBe(64); // SHA-256
  });

  it('prepara el paquete ZIP con directivas anti-indexación y Netlify Function', () => {
    const comercioId = '11111111-1111-1111-1111-111111111111';
    const zipBuffer = prepararPaqueteVentaMovilNetlify({
      supabaseUrl: 'https://xyzcompany.supabase.co',
      supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      comercioId,
      comercioNombre: 'Kiosco Central',
    });

    expect(zipBuffer).toBeInstanceOf(Buffer);
    expect(zipBuffer.length).toBeGreaterThan(500);

    // Debe tener firma PKZip
    expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);
  });
});
