import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { crearBaseDatos } from '../migrator.ts';
import {
  crearProducto,
  inicializarComercioYSuperadmin,
  obtenerStockProducto,
  registrarMovimientoStock,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../repositorios.ts';
import { guardarImagenProductoLocal } from '../imagenes_repo.ts';
import {
  calcularIndicadorEstadoSync,
  resolverConflictoRegistro,
  validarConfiguracionSupabaseCliente,
} from '../../domain/sync.ts';
import {
  NubeSimuladaEnMemoria,
  ejecutarCicloSincronizacionCompleto,
  ejecutarPullDatos,
  ejecutarPushDatos,
  guardarConfiguracionSistema,
  obtenerResumenEstadoSyncDb,
} from '../../sync/motor_sync.ts';
import {
  crearBackupBaseDatosLocal,
  ejecutarBackupDiarioAutomaticoSiCorresponde,
  exportarTodoAExcel,
  resetearBaseDatosAFabrica,
  restaurarDesdeBackupLocal,
} from '../backup_repo.ts';

describe('Fase 2: Sincronización multi-terminal, cola de imágenes, resolución de conflictos y backups', () => {
  it('resuelve conflictos según PLAN.md §5: LWW por updated_at, desempate por device_id menor y prioridad restrictiva en usuarios', () => {
    // 1. LWW por updated_at en productos
    const prodLocal = {
      id: 'prod-1',
      comercio_id: 'com-1',
      nombre: 'Yerba Local',
      created_at: '2026-10-19T10:00:00.000Z',
      updated_at: '2026-10-19T10:05:00.000Z',
      deleted_at: null,
      device_id: 'terminal-b',
    };
    const prodRemotoMasNuevo = {
      ...prodLocal,
      nombre: 'Yerba Remota',
      updated_at: '2026-10-19T10:06:00.000Z',
      device_id: 'terminal-z',
    };

    const resLww = resolverConflictoRegistro(
      'productos',
      prodLocal,
      prodRemotoMasNuevo,
      true
    );
    expect(resLww.ganador).toBe('remoto');
    expect(resLww.reglaAplicada).toBe('lww_updated_at');
    expect(resLww.registroResultante.nombre).toBe('Yerba Remota');

    // 2. Empate exacto de updated_at: gana el device_id lexicográficamente menor
    const prodEmpateA = {
      ...prodLocal,
      nombre: 'Precio Terminal A',
      updated_at: '2026-10-19T12:00:00.000Z',
      device_id: 'terminal-a',
    };
    const prodEmpateB = {
      ...prodLocal,
      nombre: 'Precio Terminal B',
      updated_at: '2026-10-19T12:00:00.000Z',
      device_id: 'terminal-b',
    };

    const resDesempate = resolverConflictoRegistro(
      'productos',
      prodEmpateB,
      prodEmpateA,
      true
    );
    expect(resDesempate.ganador).toBe('remoto');
    expect(resDesempate.reglaAplicada).toBe('lww_desempate_device_id');
    expect(resDesempate.registroResultante.device_id).toBe('terminal-a');

    // 3. Usuarios: cambios de rol, desactivación y reseteo de clave tienen prioridad (gana el más restrictivo)
    const usuarioEnCaja = {
      id: 'usr-1',
      comercio_id: 'com-1',
      nombre: 'Juan Pérez Editado',
      rol: 'encargado',
      activo: 1,
      debe_cambiar_clave: 0,
      puede_vender_movil: 1,
      clave_hash: 'hash-viejo',
      created_at: '2026-10-19T10:00:00.000Z',
      updated_at: '2026-10-19T14:00:00.000Z', // Más reciente en timestamp
      deleted_at: null,
      device_id: 'terminal-caja',
    };
    const usuarioDesactivadoEnAdmin = {
      ...usuarioEnCaja,
      nombre: 'Juan Pérez',
      rol: 'cajero', // Más restrictivo que encargado
      activo: 0, // Desactivado
      debe_cambiar_clave: 1, // Reseteo forzado
      puede_vender_movil: 0,
      clave_hash: 'hash-temporal-nuevo',
      updated_at: '2026-10-19T13:50:00.000Z', // Aunque tenga timestamp anterior, sus restricciones ganan
      device_id: 'terminal-admin',
    };

    const resUsuario = resolverConflictoRegistro(
      'usuarios',
      usuarioEnCaja,
      usuarioDesactivadoEnAdmin,
      true
    );
    expect(resUsuario.ganador).toBe('fusionado_restrictivo');
    expect(resUsuario.reglaAplicada).toBe('usuarios_cambio_mas_restrictivo');
    expect(resUsuario.registroResultante.rol).toBe('cajero');
    expect(resUsuario.registroResultante.activo).toBe(0);
    expect(resUsuario.registroResultante.debe_cambiar_clave).toBe(1);
    expect(resUsuario.registroResultante.clave_hash).toBe('hash-temporal-nuevo');
  });

  it('impide guardar claves secretas o service_role de Supabase en el cliente (Regla 8)', () => {
    expect(
      validarConfiguracionSupabaseCliente(
        'https://xyz.supabase.co',
        'sb_secret_123456789'
      ).valida
    ).toBe(false);

    // Simular JWT con payload {"role":"service_role"}
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadService = Buffer.from(
      JSON.stringify({ role: 'service_role', iss: 'supabase' })
    ).toString('base64url');
    const jwtServiceRole = `${header}.${payloadService}.firma`;

    const validacionJwt = validarConfiguracionSupabaseCliente(
      'https://xyz.supabase.co',
      jwtServiceRole
    );
    expect(validacionJwt.valida).toBe(false);
    expect(validacionJwt.motivo).toContain('Regla 8');

    // Simular JWT con payload {"role":"anon"} -> permitido
    const payloadAnon = Buffer.from(
      JSON.stringify({ role: 'anon', iss: 'supabase' })
    ).toString('base64url');
    const jwtAnon = `${header}.${payloadAnon}.firma`;
    expect(
      validarConfiguracionSupabaseCliente('https://xyz.supabase.co', jwtAnon)
        .valida
    ).toBe(true);
  });

  it('sincroniza datos e imágenes entre 2 terminales (push/pull), conserva último hash de imagen y sigue funcionando sin conexión', async () => {
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-sync-t1-'));
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-sync-t2-'));

    const dbT1 = crearBaseDatos(path.join(tmpDir1, 't1.db'));
    const dbT2 = crearBaseDatos(path.join(tmpDir2, 't2.db'));

    try {
      const init = inicializarComercioYSuperadmin(dbT1, {
        nombreComercio: 'Ferretería El Tornillo',
        cuit: '20-12345678-6',
        nombreAdmin: 'Admin T1',
        usuarioAdmin: 'admin',
        claveHashAdmin: 'argon2id$hash',
        deviceId: 'terminal-01',
      });

      const actorT1: ActorContexto = {
        comercio_id: init.comercioId,
        usuario_id: init.superadminId,
        usuario_nombre: 'Admin T1',
        rol: 'superadmin',
        device_id: 'terminal-01',
      };

      const prodId = crearProducto(dbT1, actorT1, {
        nombre: 'Martillo Galponero',
        codigoInterno: 'MAR-01',
        codigosBarras: ['7790001112223'],
        costoCompraCentavos: 450000,
        precioVentaCentavos: 790000,
        stockInicial: 15,
      });

      // Procesar y asociar una imagen WebP en Terminal 1
      const imgBuffer = await sharp({
        create: {
          width: 600,
          height: 400,
          channels: 3,
          background: { r: 30, g: 120, b: 200 },
        },
      })
        .jpeg()
        .toBuffer();

      await guardarImagenProductoLocal(dbT1, actorT1, {
        productoId: prodId,
        entradaBuffer: imgBuffer,
        nombreArchivoOriginal: 'martillo.jpg',
        directorioBase: tmpDir1,
      });

      // Registrar una venta en Terminal 1
      registrarVenta(dbT1, actorT1, {
        items: [
          {
            productoId: prodId,
            cantidad: 3,
          },
        ],
        pagos: [{ medio: 'efectivo', monto: 2370000 }],
      });

      // Antes de sincronizar debe figurar Pendiente (N cambios)
      const estadoAntes = obtenerResumenEstadoSyncDb(
        dbT1,
        init.comercioId,
        false
      );
      expect(estadoAntes.tipoBadge).toBe('pendiente');
      expect(estadoAntes.etiqueta).toContain('Pendiente (');
      expect(estadoAntes.imagenesPendientes).toBe(1);

      const nubeCompartida = new NubeSimuladaEnMemoria();

      // 1. Terminal 1 ejecuta ciclo completo (Push datos -> Pull datos -> Subida imágenes)
      const syncT1 = await ejecutarCicloSincronizacionCompleto(
        dbT1,
        nubeCompartida,
        actorT1,
        tmpDir1
      );
      expect(syncT1.push.registrosSubidos).toBeGreaterThan(0);
      expect(syncT1.imagenes.subidasExitosas).toBe(1);
      expect(syncT1.estadoUI.etiqueta).toBe('Sincronizado');
      expect(nubeCompartida.obtenerCantidadArchivosStorage()).toBe(2); // .webp + _thumb.webp

      // Si volvemos a sincronizar sin tocar la imagen, no se vuelve a transferir (PLAN.md §5.1)
      const syncT1Repetido = await ejecutarCicloSincronizacionCompleto(
        dbT1,
        nubeCompartida,
        actorT1,
        tmpDir1
      );
      expect(syncT1Repetido.imagenes.subidasExitosas).toBe(0);

      // 2. Terminal 2 se conecta al mismo comercio y hace Pull + descarga de imágenes en segundo plano
      const actorT2: ActorContexto = {
        comercio_id: init.comercioId,
        usuario_id: init.superadminId,
        usuario_nombre: 'Admin T1 (en Terminal 2)',
        rol: 'superadmin',
        device_id: 'terminal-02',
      };

      const syncT2 = await ejecutarCicloSincronizacionCompleto(
        dbT2,
        nubeCompartida,
        actorT2,
        tmpDir2
      );
      expect(syncT2.pull.registrosBajados).toBeGreaterThan(0);
      expect(syncT2.imagenes.bajadasExitosas).toBe(1);

      // El stock en Terminal 2 debe ser exactamente 12 (15 iniciales - 3 vendidos en T1)
      expect(obtenerStockProducto(dbT2, init.comercioId, prodId)).toBe(12);

      // Los archivos de imagen WebP deben haberse descargado a la caché local de Terminal 2
      expect(
        fs.existsSync(path.join(tmpDir2, 'imagenes', `${prodId}.webp`))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir2, 'imagenes', `${prodId}_thumb.webp`))
      ).toBe(true);

      // La cadena de auditoría en Terminal 2 debe ser 100% íntegra
      expect(verificarIntegridadAuditoriaDb(dbT2, init.comercioId).integra).toBe(
        true
      );

      // 3. Simular corte de internet en Terminal 2: la venta offline funciona sin bloquearse (Regla 7)
      nubeCompartida.fijarEstadoOnline(false);

      registrarMovimientoStock(dbT2, actorT2, {
        productoId: prodId,
        tipo: 'compra',
        cantidad: 5,
        costoUnitarioCentavos: 460000,
        motivo: 'Ingreso de mercadería sin internet',
      });

      const syncOffline = await ejecutarCicloSincronizacionCompleto(
        dbT2,
        nubeCompartida,
        actorT2,
        tmpDir2
      );
      expect(syncOffline.estadoUI.etiqueta).toBe('Sin conexión');
      expect(syncOffline.estadoUI.datosPendientes).toBeGreaterThan(0);

      // Vuelve internet: Terminal 2 sube y Terminal 1 baja -> ambas quedan en stock 17
      nubeCompartida.fijarEstadoOnline(true);
      await ejecutarPushDatos(dbT2, nubeCompartida, actorT2);
      await ejecutarPullDatos(dbT1, nubeCompartida, actorT1, tmpDir1);

      expect(obtenerStockProducto(dbT1, init.comercioId, prodId)).toBe(17);
      expect(verificarIntegridadAuditoriaDb(dbT1, init.comercioId).integra).toBe(
        true
      );
    } finally {
      dbT1.close();
      dbT2.close();
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('crea backup diario automático, exporta todo a Excel y restaura desde backup auditando todo', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-backup-test-'));
    const db = crearBaseDatos(path.join(tmpDir, 'pos.db'));

    try {
      const init = inicializarComercioYSuperadmin(db, {
        nombreComercio: 'Librería San Martín',
        nombreAdmin: 'Laura',
        usuarioAdmin: 'laura',
        claveHashAdmin: 'argon2id$laura',
        deviceId: 'pc-principal',
      });

      const actor: ActorContexto = {
        comercio_id: init.comercioId,
        usuario_id: init.superadminId,
        usuario_nombre: 'Laura',
        rol: 'superadmin',
        device_id: 'pc-principal',
      };

      guardarConfiguracionSistema(db, actor, {
        carpetaBackups: path.join(tmpDir, 'mis_backups'),
        backupDiarioHabilitado: true,
      });

      const prodOriginalId = crearProducto(db, actor, {
        nombre: 'Cuaderno Tapa Dura 84h',
        codigoInterno: 'CUA-84',
        costoCompraCentavos: 210000,
        precioVentaCentavos: 390000,
        stockInicial: 25,
      });

      // 1. Copia diaria automática (se ejecuta la primera vez del día y no se duplica en el mismo día)
      const backupDiario1 = ejecutarBackupDiarioAutomaticoSiCorresponde(
        db,
        actor,
        tmpDir
      );
      expect(backupDiario1).not.toBeNull();
      expect(fs.existsSync(backupDiario1!.ruta_archivo)).toBe(true);

      const backupDiario2 = ejecutarBackupDiarioAutomaticoSiCorresponde(
        db,
        actor,
        tmpDir
      );
      expect(backupDiario2).toBeNull();

      // 2. Crear un backup manual en este punto (con 1 producto y stock 25)
      const backupPuntoControl = crearBackupBaseDatosLocal(db, actor, {
        directorioBaseDatos: tmpDir,
        tipo: 'manual',
      });

      // 3. Agregar otro producto y vender después del backup
      const prodNuevoId = crearProducto(db, actor, {
        nombre: 'Producto Posterior al Backup',
        codigoInterno: 'POST-01',
        costoCompraCentavos: 10000,
        precioVentaCentavos: 20000,
        stockInicial: 10,
      });
      expect(obtenerStockProducto(db, init.comercioId, prodNuevoId)).toBe(10);

      // 4. Exportar todo a Excel (.xlsx con firma ZIP PK\x03\x04)
      const bytesXlsx = exportarTodoAExcel(db, actor);
      expect(bytesXlsx[0]).toBe(0x50);
      expect(bytesXlsx[1]).toBe(0x4b);

      // 5. Restaurar desde el backup de punto de control
      const resultadoRestauracion = restaurarDesdeBackupLocal(db, actor, {
        rutaArchivoBackup: backupPuntoControl.ruta_archivo,
        directorioBaseDatos: tmpDir,
      });

      expect(
        fs.existsSync(
          resultadoRestauracion.backupResguardoPrevio.ruta_archivo
        )
      ).toBe(true);
      expect(obtenerStockProducto(db, init.comercioId, prodOriginalId)).toBe(25);
      // El producto creado después del backup ya no debe existir tras restaurar
      const prodPostRow = db
        .prepare('SELECT id FROM productos WHERE id = ?')
        .get(prodNuevoId);
      expect(prodPostRow).toBeUndefined();

      // La cadena de auditoría tras la restauración (incluido el evento backup_restaurar) sigue íntegra
      const verif = verificarIntegridadAuditoriaDb(db, init.comercioId);
      expect(verif.integra).toBe(true);

      // Verificar también los 4 estados del indicador de la barra superior
      expect(
        calcularIndicadorEstadoSync({
          sinConexion: false,
          datosPendientes: 0,
          imagenesPendientes: 0,
          erroresCount: 0,
        }).etiqueta
      ).toBe('Sincronizado');
      expect(
        calcularIndicadorEstadoSync({
          sinConexion: false,
          datosPendientes: 3,
          imagenesPendientes: 1,
          erroresCount: 0,
        }).etiqueta
      ).toBe('Pendiente (4 cambios)');
      expect(
        calcularIndicadorEstadoSync({
          sinConexion: true,
          datosPendientes: 2,
          imagenesPendientes: 0,
          erroresCount: 0,
        }).etiqueta
      ).toBe('Sin conexión');
      expect(
        calcularIndicadorEstadoSync({
          sinConexion: false,
          datosPendientes: 1,
          imagenesPendientes: 0,
          erroresCount: 1,
        }).etiqueta
      ).toBe('Error (ver detalle)');

      // 6. Probar reinicio a fábrica (deja solo el comercio, el único superadmin, la lista General y las credenciales de configuración)
      const resReset = resetearBaseDatosAFabrica(db, actor, tmpDir);
      expect(resReset.superadminConservado).toContain('laura');
      expect(
        fs.existsSync(resReset.backupResguardoPrevio.ruta_archivo)
      ).toBe(true);

      const totalProductosPostReset = (
        db.prepare('SELECT COUNT(*) as c FROM productos').get() as { c: number }
      ).c;
      const totalUsuariosPostReset = (
        db.prepare('SELECT COUNT(*) as c FROM usuarios').get() as { c: number }
      ).c;
      const totalListasPostReset = (
        db.prepare('SELECT COUNT(*) as c FROM listas_precio').get() as {
          c: number;
        }
      ).c;
      expect(totalProductosPostReset).toBe(0);
      expect(totalUsuariosPostReset).toBe(1);
      expect(totalListasPostReset).toBe(1);
      expect(verificarIntegridadAuditoriaDb(db, init.comercioId).integra).toBe(
        true
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
