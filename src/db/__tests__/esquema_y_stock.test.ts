import { describe, expect, it } from 'vitest';
import {
  actualizarRolOEstadoUsuario,
  anularVenta,
  buscarProductoPorCodigoParaVenta,
  crearBaseDatos,
  crearProducto,
  crearUsuario,
  ejecutarEnTransaccion,
  inicializarComercioYSuperadmin,
  listarProductosAdministracion,
  obtenerStockProducto,
  registrarMovimientoStock,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../index.ts';

describe('SQLite + Migraciones + Criterios de Aceptación Fase 1 (PLAN.md §13)', () => {
  function prepararEntornoPrueba() {
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Kiosco El Sol',
      cuit: '20-12345678-6',
      condicionIva: 'monotributo',
      nombreAdmin: 'María Superadmin',
      usuarioAdmin: 'maria',
      claveHashAdmin: '$argon2id$v=19$m=65536,t=3,p=4$hash_admin',
      deviceId: 'terminal-caja-1',
    });

    const actorSuperadmin: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'María Superadmin',
      rol: 'superadmin',
      device_id: 'terminal-caja-1',
    };

    const encargadoId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Carlos Encargado',
      usuario: 'carlos',
      claveHash: '$argon2id$v=19$m=65536,t=3,p=4$hash_encargado',
      rol: 'encargado',
    });

    const cajeroId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Lucas Cajero',
      usuario: 'lucas',
      claveHash: '$argon2id$v=19$m=65536,t=3,p=4$hash_cajero',
      rol: 'cajero',
    });

    const actorEncargado: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: encargadoId,
      usuario_nombre: 'Carlos Encargado',
      rol: 'encargado',
      device_id: 'terminal-caja-1',
    };

    const actorCajero: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: cajeroId,
      usuario_nombre: 'Lucas Cajero',
      rol: 'cajero',
      device_id: 'terminal-caja-1',
    };

    return {
      db,
      comercioId,
      superadminId,
      encargadoId,
      cajeroId,
      actorSuperadmin,
      actorEncargado,
      actorCajero,
    };
  }

  it('el stock siempre coincide exactamente con la suma de movimientos tras compras, ventas, ajustes y anulaciones (§13)', () => {
    const { db, comercioId, actorEncargado, actorCajero } = prepararEntornoPrueba();

    // 1. Crear producto con stock inicial = 20 unidades
    const productoId = crearProducto(db, actorEncargado, {
      nombre: 'Alfajor Triple Chocolate',
      codigoInterno: 'ALF-001',
      costoCompraCentavos: 80000, // $ 800,00
      precioVentaCentavos: 150000, // $ 1.500,00
      alicuotaIva: 21,
      stockMinimo: 5,
      codigosBarras: ['7791234567890'],
      stockInicial: 20,
    });

    expect(obtenerStockProducto(db, comercioId, productoId)).toBe(20);

    // 2. Ingreso por compra (+15 unidades) -> Stock esperado: 35
    registrarMovimientoStock(db, actorEncargado, {
      productoId,
      tipo: 'compra',
      cantidad: 15,
      costoUnitarioCentavos: 85000,
      motivo: 'Compra proveedor mayorista',
    });
    expect(obtenerStockProducto(db, comercioId, productoId)).toBe(35);

    // 3. Ajuste negativo por merma (-2 unidades) -> Stock esperado: 33
    registrarMovimientoStock(db, actorEncargado, {
      productoId,
      tipo: 'merma',
      cantidad: 2,
      motivo: 'Envases aplastados',
    });
    expect(obtenerStockProducto(db, comercioId, productoId)).toBe(33);

    // 4. Venta por cajero (-3 unidades) -> Stock esperado: 30
    const { ventaId, totalCentavos } = registrarVenta(db, actorCajero, {
      items: [{ productoId, cantidad: 3 }],
      pagos: [
        { medio: 'efectivo', monto: 300000 },
        { medio: 'mercado_pago', monto: 150000 },
      ],
    });
    expect(totalCentavos).toBe(450000);
    expect(obtenerStockProducto(db, comercioId, productoId)).toBe(30);

    // 5. Anular la venta como cajero: exige autorización de encargado o superadmin y devuelve stock (+3) -> 33
    expect(() =>
      anularVenta(db, actorCajero, {
        ventaId,
        motivo: 'Cliente se arrepintió',
      })
    ).toThrow(/AUTORIZACION_REQUERIDA/);

    anularVenta(db, actorCajero, {
      ventaId,
      motivo: 'Cliente se arrepintió',
      autorizador: {
        usuario_id: actorEncargado.usuario_id,
        usuario_nombre: actorEncargado.usuario_nombre,
        rol: actorEncargado.rol,
      },
    });

    expect(obtenerStockProducto(db, comercioId, productoId)).toBe(33);

    // Verificar que la suma directa en SQL y la vista_stock_actual coinciden exactamente con obtenerStockProducto
    const sumaSql = db
      .prepare(
        'SELECT ROUND(SUM(cantidad), 3) AS total FROM movimientos_stock WHERE comercio_id = ? AND producto_id = ?'
      )
      .get(comercioId, productoId) as { total: number };
    const vistaSql = db
      .prepare(
        'SELECT stock_actual FROM vista_stock_actual WHERE comercio_id = ? AND producto_id = ?'
      )
      .get(comercioId, productoId) as { stock_actual: number };

    expect(sumaSql.total).toBe(33);
    expect(vistaSql.stock_actual).toBe(33);

    // Verificar que movimientos_stock no permite UPDATE ni DELETE
    expect(() =>
      db.prepare('UPDATE movimientos_stock SET cantidad = 999').run()
    ).toThrow(/STOCK_INMUTABLE/);
    expect(() => db.prepare('DELETE FROM movimientos_stock').run()).toThrow(
      /STOCK_INMUTABLE/
    );
  });

  it('el cajero no puede ver costos ni gestionar usuarios, y la vista de venta nunca incluye costo_compra (Reglas 11 y 20)', () => {
    const { db, comercioId, actorEncargado, actorCajero } = prepararEntornoPrueba();

    crearProducto(db, actorEncargado, {
      nombre: 'Cuaderno Tapa Dura 84h',
      costoCompraCentavos: 320000,
      precioVentaCentavos: 550000,
      codigosBarras: ['7799876543210'],
    });

    // Búsqueda para pantalla de venta: devuelve precio_venta pero NUNCA costo_compra
    const prodVenta = buscarProductoPorCodigoParaVenta(
      db,
      comercioId,
      '7799876543210'
    );
    expect(prodVenta).not.toBeNull();
    expect(prodVenta?.precio_venta).toBe(550000);
    expect('costo_compra' in (prodVenta ?? {})).toBe(false);

    // Listado de administración con costos: permitido a encargado, bloqueado a cajero
    const listaEncargado = listarProductosAdministracion(db, actorEncargado);
    expect(listaEncargado).toHaveLength(1);
    expect(listaEncargado[0]?.costo_compra).toBe(320000);

    expect(() => listarProductosAdministracion(db, actorCajero)).toThrow(
      /PERMISO_DENEGADO/
    );

    // Cajero y encargado no pueden crear usuarios
    expect(() =>
      crearUsuario(db, actorCajero, {
        nombre: 'Otro',
        usuario: 'otro1',
        claveHash: 'hash',
        rol: 'cajero',
      })
    ).toThrow(/PERMISO_DENEGADO/);

    expect(() =>
      crearUsuario(db, actorEncargado, {
        nombre: 'Otro',
        usuario: 'otro2',
        claveHash: 'hash',
        rol: 'cajero',
      })
    ).toThrow(/PERMISO_DENEGADO/);
  });

  it('impide desactivar, degradar o borrar al último superadmin activo (§6.1 y §13)', () => {
    const { db, superadminId, actorSuperadmin } = prepararEntornoPrueba();

    expect(() =>
      actualizarRolOEstadoUsuario(db, actorSuperadmin, {
        usuarioObjetivoId: superadminId,
        nuevoRol: 'encargado',
        nuevoActivo: true,
      })
    ).toThrow(/ULTIMO_SUPERADMIN/);

    expect(() =>
      actualizarRolOEstadoUsuario(db, actorSuperadmin, {
        usuarioObjetivoId: superadminId,
        nuevoRol: 'superadmin',
        nuevoActivo: false,
      })
    ).toThrow(/ULTIMO_SUPERADMIN/);

    expect(() =>
      db.prepare('DELETE FROM usuarios WHERE id = ?').run(superadminId)
    ).toThrow(/USUARIO_NO_ELIMINABLE/);
  });

  it('revierte el cambio si falla la escritura de auditoría y detecta adulteraciones en la cadena de hash (§13)', () => {
    const { db, comercioId, actorEncargado } = prepararEntornoPrueba();

    // Si falla la auditoría dentro de la transacción, el producto no debe quedar guardado (Regla 13)
    expect(() =>
      ejecutarEnTransaccion(db, () => {
        db.prepare(
          `INSERT INTO productos (
            id, comercio_id, nombre, unidad, permite_decimales, costo_compra,
            alicuota_iva, exento_iva, stock_minimo, activo,
            created_at, updated_at, deleted_at, device_id, sync_status
          ) VALUES ('prod-fallido', ?, 'Producto Fantasma', 'unidad', 0, 1000, 21, 0, 0, 1, '2026-10-19', '2026-10-19', NULL, 'dev-1', 'pendiente')`
        ).run(comercioId);

        // Simular fallo al escribir en auditoría (ej. violación de NOT NULL en hash)
        db.prepare(
          `INSERT INTO auditoria (id, comercio_id, fecha_hora, usuario_nombre, rol, device_id, accion, entidad, hash_prev, hash, created_at, updated_at, sync_status)
           VALUES ('aud-fallida', ?, '2026-10-19', ?, 'encargado', 'dev-1', 'test', 'productos', NULL, NULL, '2026-10-19', '2026-10-19', 'pendiente')`
        ).run(comercioId, actorEncargado.usuario_nombre);
      })
    ).toThrow();

    const fantasma = db
      .prepare('SELECT id FROM productos WHERE id = ?')
      .get('prod-fallido');
    expect(fantasma).toBeUndefined();

    // Verificar que los triggers impiden UPDATE y DELETE en auditoria
    expect(() =>
      db.prepare("UPDATE auditoria SET accion = 'hackeado'").run()
    ).toThrow(/AUDITORIA_INMUTABLE/);
    expect(() => db.prepare('DELETE FROM auditoria').run()).toThrow(
      /AUDITORIA_INMUTABLE/
    );

    // La cadena actual es íntegra
    const verifInicial = verificarIntegridadAuditoriaDb(db, comercioId);
    expect(verifInicial.integra).toBe(true);
    expect(verifInicial.totalRegistros).toBeGreaterThanOrEqual(3);

    // Simular que un atacante con acceso al archivo SQLite desactiva el trigger y edita un registro a mano
    db.exec('DROP TRIGGER trg_auditoria_no_update;');
    db.prepare(
      "UPDATE auditoria SET valores_despues = '{\"adulterado\":true}' WHERE rowid = 2"
    ).run();

    const verifPosterior = verificarIntegridadAuditoriaDb(db, comercioId);
    expect(verifPosterior.integra).toBe(false);
    expect(verifPosterior.indiceAlterado).toBe(1);
  });
});
