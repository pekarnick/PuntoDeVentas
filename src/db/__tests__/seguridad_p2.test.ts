import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolverConflictoRegistro,
  TABLAS_APPEND_ONLY,
  type RegistroSincronizableBase,
  type TablaSincronizable,
} from '../../domain/sync.ts';
import {
  ejecutarPullDatos,
  ejecutarPushDatos,
  MAX_INTENTOS_SYNC_COLA,
  obtenerODefinirDeviceIdTerminal,
  type AdaptadorNubeSupabase,
} from '../../sync/motor_sync.ts';
import { generarUuidV7 } from '../../domain/uuid.ts';
import { aplicarMigraciones, crearBaseDatos } from '../migrator.ts';
import { inicializarComercioYSuperadmin, type ActorContexto } from '../repositorios.ts';

function crearBaseYActor() {
  const db = crearBaseDatos(':memory:');
  aplicarMigraciones(db);
  const comercioId = generarUuidV7();
  const superadminId = generarUuidV7();
  const listaPrecioId = generarUuidV7();
  inicializarComercioYSuperadmin(db, {
    comercioId,
    superadminId,
    listaPrecioId,
    nombreComercio: 'Kiosco P2',
    nombreAdmin: 'Admin P2',
    usuarioAdmin: 'admin',
    claveHashAdmin: '$argon2id$v=19$m=65536,t=3,p=1$salt$hashlocal',
    deviceId: 'terminal-p2-test',
  });
  const actor: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: superadminId,
    usuario_nombre: 'Admin P2',
    rol: 'superadmin',
    device_id: 'terminal-p2-test',
  };
  return { db, actor, comercioId, superadminId, listaPrecioId };
}

describe('Auditoría de Seguridad — Lote P2', () => {
  it('TABLAS_APPEND_ONLY incluye cuenta_corriente_movimientos, compras y compras_items', () => {
    expect(TABLAS_APPEND_ONLY.has('cuenta_corriente_movimientos')).toBe(true);
    expect(TABLAS_APPEND_ONLY.has('compras')).toBe(true);
    expect(TABLAS_APPEND_ONLY.has('compras_items')).toBe(true);
  });

  it('resolverConflictoRegistro aplica reglas restrictivas de usuarios incluso con localEstabaPendiente = false', () => {
    const id = generarUuidV7();
    const comercioId = generarUuidV7();
    const local: RegistroSincronizableBase & Record<string, unknown> = {
      id,
      comercio_id: comercioId,
      nombre: 'Operador',
      rol: 'cajero',
      activo: 1,
      debe_cambiar_clave: 0,
      puede_vender_movil: 1,
      clave_hash: '$argon2id$hash_local_seguro',
      pin_hash: '$argon2id$pin_local',
      intentos_fallidos: 4,
      bloqueado_hasta: '2026-12-01T12:00:00.000Z',
      created_at: '2026-12-01T08:00:00.000Z',
      updated_at: '2026-12-01T10:00:00.000Z',
      deleted_at: null,
      device_id: 'term-a',
    };
    const remoto: RegistroSincronizableBase & Record<string, unknown> = {
      id,
      comercio_id: comercioId,
      nombre: 'Operador Remoto',
      rol: 'superadmin',
      activo: 1,
      debe_cambiar_clave: 0,
      puede_vender_movil: 1,
      clave_hash: null,
      pin_hash: null,
      intentos_fallidos: 1,
      bloqueado_hasta: '2026-12-01T10:30:00.000Z',
      created_at: '2026-12-01T08:00:00.000Z',
      updated_at: '2026-12-01T11:00:00.000Z',
      deleted_at: null,
      device_id: 'term-b',
    };

    const res = resolverConflictoRegistro('usuarios', local, remoto, false);
    expect(res.registroResultante.rol).toBe('cajero');
    expect(res.registroResultante.clave_hash).toBe('$argon2id$hash_local_seguro');
    expect(res.registroResultante.pin_hash).toBeNull();
    expect(res.registroResultante.intentos_fallidos).toBe(4);
    expect(res.registroResultante.bloqueado_hasta).toBe('2026-12-01T12:00:00.000Z');
  });

  it('resolverConflictoRegistro da precedencia monótona a sesiones_moviles revocada y deleted_at en maestros', () => {
    const comercioId = generarUuidV7();
    const sesionLocal: RegistroSincronizableBase & Record<string, unknown> = {
      id: generarUuidV7(),
      comercio_id: comercioId,
      estado: 'revocada',
      created_at: '2026-12-01T08:00:00.000Z',
      updated_at: '2026-12-01T09:00:00.000Z',
      deleted_at: null,
      device_id: 'term-a',
    };
    const sesionRemota: RegistroSincronizableBase & Record<string, unknown> = {
      ...sesionLocal,
      estado: 'activa',
      updated_at: '2026-12-01T12:00:00.000Z',
      device_id: 'term-b',
    };
    const resSesion = resolverConflictoRegistro(
      'sesiones_moviles',
      sesionLocal,
      sesionRemota,
      false
    );
    expect(resSesion.registroResultante.estado).toBe('revocada');

    const prodLocal: RegistroSincronizableBase & Record<string, unknown> = {
      id: generarUuidV7(),
      comercio_id: comercioId,
      nombre: 'Alfajor',
      created_at: '2026-12-01T08:00:00.000Z',
      updated_at: '2026-12-01T09:00:00.000Z',
      deleted_at: '2026-12-01T09:00:00.000Z',
      device_id: 'term-a',
    };
    const prodRemoto: RegistroSincronizableBase & Record<string, unknown> = {
      ...prodLocal,
      nombre: 'Alfajor Editado',
      updated_at: '2026-12-01T11:00:00.000Z',
      deleted_at: null,
      device_id: 'term-b',
    };
    const resProd = resolverConflictoRegistro('productos', prodLocal, prodRemoto, true);
    expect(resProd.registroResultante.deleted_at).toBe('2026-12-01T09:00:00.000Z');
  });

  it('resolverConflictoRegistro fusiona no destructivamente venta anulada con CAE emitido', () => {
    const comercioId = generarUuidV7();
    const ventaLocal: RegistroSincronizableBase & Record<string, unknown> = {
      id: generarUuidV7(),
      comercio_id: comercioId,
      estado: 'anulada',
      anulada_at: '2026-12-01T11:00:00.000Z',
      motivo_anulacion: 'Error de cajero',
      estado_facturacion: 'no_aplica',
      cae: null,
      created_at: '2026-12-01T08:00:00.000Z',
      updated_at: '2026-12-01T11:00:00.000Z',
      deleted_at: null,
      device_id: 'term-a',
    };
    const ventaRemota: RegistroSincronizableBase & Record<string, unknown> = {
      ...ventaLocal,
      estado: 'completada',
      anulada_at: null,
      motivo_anulacion: null,
      estado_facturacion: 'emitida',
      cae: '74123456789012',
      arca_cbte_nro: 15,
      updated_at: '2026-12-01T10:30:00.000Z',
      device_id: 'term-b',
    };

    const res = resolverConflictoRegistro('ventas', ventaLocal, ventaRemota, true);
    expect(res.registroResultante.estado).toBe('anulada');
    expect(res.registroResultante.estado_facturacion).toBe('emitida');
    expect(res.registroResultante.cae).toBe('74123456789012');
    expect(res.registroResultante.arca_cbte_nro).toBe(15);
    expect(res.registroResultante.motivo_anulacion).toBe('Error de cajero');
  });

  it('ejecutarPullDatos descarta registros de otro comercio, no adopta sin permiso y aisla filas con SAVEPOINT', async () => {
    const { db, actor, comercioId } = crearBaseYActor();
    const otroComercioId = generarUuidV7();
    const prodValidoId = generarUuidV7();
    const prodOtroComercioId = generarUuidV7();
    const prodInvalidoId = generarUuidV7();
    const ahora = new Date().toISOString();

    let adopcionLlamada = false;
    const adaptadorFake: AdaptadorNubeSupabase = {
      async estaDisponible() {
        return true;
      },
      async subirRegistrosTabla() {},
      async bajarArchivoImagen() {
        return null;
      },
      async subirArchivoImagen() {},
      async descubrirComercioRemoto() {
        adopcionLlamada = true;
        return {
          id: otroComercioId,
          comercio_id: otroComercioId,
          nombre: 'Comercio Ajeno',
          created_at: ahora,
          updated_at: ahora,
          deleted_at: null,
          device_id: 'term-ajeno',
        };
      },
      async bajarRegistrosTabla(tabla: TablaSincronizable) {
        if (tabla === 'productos') {
          return [
            {
              id: prodOtroComercioId,
              comercio_id: otroComercioId,
              nombre: 'Prod Ajeno',
              precio_venta_centavos: 500,
              costo_compra_centavos: 200,
              alicuota_iva: 21,
              unidad_medida: 'unidad',
              stock_minimo: 0,
              activo: 1,
              created_at: ahora,
              updated_at: ahora,
              deleted_at: null,
              device_id: 'term-ajeno',
            },
            {
              id: prodInvalidoId,
              comercio_id: comercioId,
              nombre: null,
              precio_venta_centavos: 500,
              costo_compra_centavos: 200,
              alicuota_iva: 21,
              unidad_medida: 'unidad',
              stock_minimo: 0,
              activo: 1,
              created_at: ahora,
              updated_at: ahora,
              deleted_at: null,
              device_id: 'term-remoto',
            },
            {
              id: prodValidoId,
              comercio_id: comercioId,
              nombre: 'Prod Valido P2',
              precio_venta_centavos: 1200,
              costo_compra_centavos: 600,
              alicuota_iva: 21,
              unidad_medida: 'unidad',
              stock_minimo: 0,
              activo: 1,
              created_at: ahora,
              updated_at: ahora,
              deleted_at: null,
              device_id: 'term-remoto',
            },
          ];
        }
        return [];
      },
    };

    const res = await ejecutarPullDatos(db, adaptadorFake, actor, ':memory:');
    expect(adopcionLlamada).toBe(false);
    expect(res.registrosBajados).toBe(1);
    expect(res.errores.length).toBeGreaterThanOrEqual(2);

    const prodOk = db
      .prepare(`SELECT nombre FROM productos WHERE id = ?`)
      .get(prodValidoId) as { nombre: string } | undefined;
    expect(prodOk?.nombre).toBe('Prod Valido P2');

    const prodAjeno = db
      .prepare(`SELECT id FROM productos WHERE id = ?`)
      .get(prodOtroComercioId);
    expect(prodAjeno).toBeUndefined();
  });

  it('ejecutarPushDatos aisla registros envenenados fila a fila y los pone en cuarentena tras MAX_INTENTOS_SYNC_COLA', async () => {
    const { db, actor, comercioId } = crearBaseYActor();
    const ahora = new Date().toISOString();

    db.prepare(
      `INSERT INTO sync_estado (tabla, ultima_bajada_at, ultima_subida_at) VALUES ('comercios', NULL, ?)`
    ).run(ahora);
    db.prepare(`UPDATE comercios SET sync_status = 'sincronizado' WHERE id = ?`).run(
      comercioId
    );
    db.prepare(`UPDATE usuarios SET sync_status = 'sincronizado' WHERE comercio_id = ?`).run(
      comercioId
    );
    db.prepare(`UPDATE listas_precio SET sync_status = 'sincronizado' WHERE comercio_id = ?`).run(
      comercioId
    );

    const catSanaId = generarUuidV7();
    const catPoisonId = generarUuidV7();

    db.prepare(
      `INSERT INTO categorias (id, comercio_id, nombre, created_at, updated_at, device_id, sync_status)
       VALUES (?, ?, 'Bebidas', ?, ?, 'term-1', 'pendiente')`
    ).run(catSanaId, comercioId, ahora, ahora);
    db.prepare(
      `INSERT INTO categorias (id, comercio_id, nombre, created_at, updated_at, device_id, sync_status)
       VALUES (?, ?, 'Veneno', ?, ?, 'term-1', 'pendiente')`
    ).run(catPoisonId, comercioId, ahora, ahora);

    db.prepare(
      `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
       VALUES (?, 'categorias', ?, 'insert', ?, 'pendiente', 0)`
    ).run(generarUuidV7(), catSanaId, ahora);
    db.prepare(
      `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
       VALUES (?, 'categorias', ?, 'insert', ?, 'pendiente', ?)`
    ).run(generarUuidV7(), catPoisonId, ahora, MAX_INTENTOS_SYNC_COLA - 1);

    let llamadasConVeneno = 0;
    const adaptadorPoison: AdaptadorNubeSupabase = {
      async estaDisponible() {
        return true;
      },
      async bajarRegistrosTabla() {
        return [];
      },
      async bajarArchivoImagen() {
        return null;
      },
      async subirArchivoImagen() {},
      async subirRegistrosTabla(_tabla, registros) {
        if (registros.some((r) => r.id === catPoisonId)) {
          llamadasConVeneno++;
          throw new Error('Registro envenenado rechazado');
        }
      },
    };

    const res1 = await ejecutarPushDatos(db, adaptadorPoison, actor);
    expect(res1.registrosSubidos).toBeGreaterThanOrEqual(1);
    expect(res1.errores).toHaveLength(1);

    const colaSana = db
      .prepare(`SELECT estado FROM sync_cola WHERE registro_id = ?`)
      .get(catSanaId) as { estado: string };
    expect(colaSana.estado).toBe('sincronizado');

    const colaPoison = db
      .prepare(`SELECT estado, intentos FROM sync_cola WHERE registro_id = ?`)
      .get(catPoisonId) as { estado: string; intentos: number };
    expect(colaPoison.estado).toBe('error');
    expect(colaPoison.intentos).toBe(MAX_INTENTOS_SYNC_COLA);

    const llamadasAntes = llamadasConVeneno;
    const res2 = await ejecutarPushDatos(db, adaptadorPoison, actor);
    expect(res2.errores).toHaveLength(0);
    expect(llamadasConVeneno).toBe(llamadasAntes);
  });

  it('obtenerODefinirDeviceIdTerminal persiste un ID único por directorio', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-device-id-'));
    try {
      const id1 = obtenerODefinirDeviceIdTerminal(tmpDir);
      const id2 = obtenerODefinirDeviceIdTerminal(tmpDir);
      expect(id1.startsWith('terminal-')).toBe(true);
      expect(id1).not.toBe('terminal-local-1');
      expect(id1).toBe(id2);
      const json = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'comercio_identidad.json'), 'utf-8')
      ) as { device_id?: string };
      expect(json.device_id).toBe(id1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
