import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generarComandosEscPosTicket,
  parsearCsvImportacionCatalogo,
  validarCargoCuentaCorrienteCliente,
} from '../../domain/gestion_fase3.ts';
import { generarLibroXlsx, neutralizarFormulaXlsx } from '../../domain/xlsx.ts';
import { generarUuidV7 } from '../../domain/uuid.ts';
import { resolverRutaSeguraImagen } from '../imagenes_repo.ts';
import {
  procesarColaSincronizacionImagenes,
  type TransporteImagenesNube,
} from '../../sync/imagenes_sync.ts';
import { aplicarMigraciones, crearBaseDatos } from '../migrator.ts';
import {
  crearProducto,
  inicializarComercioYSuperadmin,
  registrarMovimientoStock,
  type ActorContexto,
} from '../repositorios.ts';
import {
  actualizarProductoYPrecio,
  eliminarProductoLogico,
} from '../productos_repo.ts';
import {
  abrirSesionCaja,
  cerrarSesionCaja,
  registrarMovimientoManualCaja,
} from '../caja_repo.ts';
import {
  crearSucursalComercio,
  transferirProductosEntreSucursales,
} from '../sucursales_repo.ts';
import {
  crearCategoria,
  crearCliente,
  crearProveedor,
  importarProductosDesdeCsv,
  listarMovimientosCuentaCorriente,
  registrarCompraProveedor,
  registrarMovimientoCuentaCorriente,
} from '../gestion_fase3_repo.ts';
import {
  asignarPrecioProductoEnLista,
  crearComboPromocion,
  crearListaPrecio,
  crearVarianteProducto,
} from '../arca_fase4_repo.ts';

function prepararEntorno() {
  const db = crearBaseDatos(':memory:');
  aplicarMigraciones(db);
  const comercioId = generarUuidV7();
  const superadminId = generarUuidV7();
  const cajeroId = generarUuidV7();
  const listaPrecioId = generarUuidV7();

  inicializarComercioYSuperadmin(db, {
    comercioId,
    superadminId,
    listaPrecioId,
    nombreComercio: 'Comercio P3',
    nombreAdmin: 'Admin P3',
    usuarioAdmin: 'admin',
    claveHashAdmin: '$argon2id$v=19$m=65536,t=3,p=1$salt$hash',
    deviceId: 'term-p3',
  });

  const ahora = new Date().toISOString();
  db.prepare(
    `INSERT INTO usuarios (
      id, comercio_id, nombre, usuario, clave_hash, rol,
      puede_vender_movil, activo, debe_cambiar_clave,
      created_at, updated_at, device_id, sync_status
    ) VALUES (?, ?, 'Cajero P3', 'cajero', '$argon2id$v=19$m=65536,t=3,p=1$salt$hash', 'cajero', 0, 1, 0, ?, ?, 'term-p3', 'pendiente')`
  ).run(cajeroId, comercioId, ahora, ahora);

  const actorAdmin: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: superadminId,
    usuario_nombre: 'Admin P3',
    rol: 'superadmin',
    device_id: 'term-p3',
  };
  const actorCajero: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: cajeroId,
    usuario_nombre: 'Cajero P3',
    rol: 'cajero',
    device_id: 'term-p3',
  };

  return { db, comercioId, listaPrecioId, actorAdmin, actorCajero };
}

describe('Auditoría de Seguridad — Lote P3', () => {
  it('resolverRutaSeguraImagen rechaza path traversal y UUID inválido', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-img-p3-'));
    try {
      expect(() => resolverRutaSeguraImagen(tmpDir, '../secreto')).toThrow(
        /ID_PRODUCTO_INVALIDO/
      );
      expect(() => resolverRutaSeguraImagen(tmpDir, 'no-es-uuid')).toThrow(
        /ID_PRODUCTO_INVALIDO/
      );
      const validId = generarUuidV7();
      const res = resolverRutaSeguraImagen(tmpDir, validId);
      expect(res.absolutaPrincipal.startsWith(res.carpetaImagenes)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('procesarColaSincronizacionImagenes rechaza imagen descargada cuyo SHA-256 no coincide con imagen_hash', async () => {
    const { db, comercioId, actorAdmin } = prepararEntorno();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-img-sync-p3-'));
    try {
      const prodId = crearProducto(db, actorAdmin, {
        nombre: 'Gaseosa',
        costoCompraCentavos: 50000,
        precioVentaCentavos: 100000,
      });
      const ahora = new Date().toISOString();
      db.prepare(
        `INSERT INTO sync_imagenes_cola (
          id, comercio_id, producto_id, imagen_path, imagen_hash,
          ultimo_hash_sincronizado, operacion, estado, intentos, ultimo_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'bajar', 'pendiente', 0, NULL, ?, ?)`
      ).run(
        generarUuidV7(),
        comercioId,
        prodId,
        `imagenes/${prodId}.webp`,
        '0'.repeat(64),
        ahora,
        ahora
      );

      const transporte: TransporteImagenesNube = {
        async estaDisponible() {
          return true;
        },
        async subirArchivoImagen() {},
        async bajarArchivoImagen() {
          return Buffer.from('contenido-corrupto-o-alterado');
        },
      };

      const res = await procesarColaSincronizacionImagenes(db, transporte, {
        comercioId,
        directorioBaseDatos: tmpDir,
      });
      expect(res.errores).toBe(1);
      expect(res.bajadasExitosas).toBe(0);
      expect(res.detalleErrores[0]).toMatch(/HASH_IMAGEN_INVALIDO/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generarComandosEscPosTicket elimina caracteres de control ASCII inyectados', () => {
    const res = generarComandosEscPosTicket({
      ventaId: '01950000-0000-7000-8000-000000000001',
      fechaIso: '2026-12-01T10:00:00.000Z',
      comercioNombre: 'Kiosco\x1b@\x00Seguro',
      cajeroNombre: 'Juan\x1dV\nCajero',
      items: [
        {
          descripcion: 'Alfajor\x1b!\x07Triple',
          cantidad: 1,
          precio_unitario: 150000,
          descuento: 0,
          subtotal: 150000,
        },
      ],
      subtotal: 150000,
      descuentoGlobal: 0,
      total: 150000,
      pagos: [{ medio: 'efectivo', monto: 150000 }],
    });

    expect(res.textoImpresora).not.toContain('\x1b');
    expect(res.textoImpresora).not.toContain('\x1d');
    expect(res.textoImpresora).not.toContain('\x00');
    expect(res.textoImpresora).not.toContain('\x07');
  });

  it('neutralizarFormulaXlsx y generarLibroXlsx neutralizan fórmulas peligrosas', () => {
    expect(neutralizarFormulaXlsx('=cmd|"/C calc"!A0')).toBe("'=cmd|\"/C calc\"!A0");
    expect(neutralizarFormulaXlsx('+1+1')).toBe("'+1+1");
    expect(neutralizarFormulaXlsx('-1+1')).toBe("'-1+1");
    expect(neutralizarFormulaXlsx('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
    expect(neutralizarFormulaXlsx('Coca Cola 500ml')).toBe('Coca Cola 500ml');

    const bytes = generarLibroXlsx([
      {
        nombre: 'Test',
        encabezados: ['Nombre'],
        filas: [['=HYPERLINK("http://evil.example")']],
      },
    ]);
    const textoZip = Buffer.from(bytes).toString('utf-8');
    expect(textoZip).toContain('&apos;=HYPERLINK');
  });

  it('parsearCsvImportacionCatalogo rechaza valores negativos y importarProductosDesdeCsv no reactiva bajas sin permiso', () => {
    const parseNeg = parsearCsvImportacionCatalogo(
      'nombre;precio_venta;costo_compra;stock_inicial\nProd Neg;-10;5;1'
    );
    expect(parseNeg.filasValidas).toHaveLength(0);
    expect(parseNeg.errores.length).toBeGreaterThan(0);

    const { db, actorAdmin } = prepararEntorno();
    const prodId = crearProducto(db, actorAdmin, {
      nombre: 'Producto Baja',
      codigoInterno: 'COD-BAJA',
      costoCompraCentavos: 10000,
      precioVentaCentavos: 20000,
    });
    eliminarProductoLogico(db, actorAdmin, { productoId: prodId });

    const resImp = importarProductosDesdeCsv(db, actorAdmin, {
      contenidoCsv: 'nombre;codigo_interno;precio_venta\nReactivado;COD-BAJA;300',
      actualizarSiExisteCodigo: false,
    });
    expect(resImp.actualizados).toBe(0);
    expect(resImp.creados).toBe(0);
    expect(resImp.errores.some((e) => e.includes('dado de baja'))).toBe(true);
  });

  it('registrarCompraProveedor no duplica ivaCentavos en totalCentavos', () => {
    const { db, actorAdmin } = prepararEntorno();
    const prodId = crearProducto(db, actorAdmin, {
      nombre: 'Harina 1kg',
      costoCompraCentavos: 100000,
      precioVentaCentavos: 150000,
    });
    const provId = crearProveedor(db, actorAdmin, { nombre: 'Molino SA' });

    const compra = registrarCompraProveedor(db, actorAdmin, {
      proveedorId: provId,
      ivaCentavos: 21000,
      items: [
        {
          productoId: prodId,
          cantidad: 1,
          costoUnitarioCentavos: 121000,
          alicuotaIva: 21,
        },
      ],
    });

    expect(compra.totalCentavos).toBe(compra.subtotalCentavos + 21000);
  });

  it('cuenta corriente separa limite 0 ($0), exige RBAC para credito/proveedor y bloquea sobrepagos', () => {
    const valCero = validarCargoCuentaCorrienteCliente({
      saldoActualCentavos: 0,
      nuevoCargoCentavos: 1000,
      limiteCreditoCentavos: 0,
    });
    expect(valCero.permitido).toBe(false);

    const { db, comercioId, actorAdmin, actorCajero } = prepararEntorno();

    // Cajero no puede crear cliente con limite de crédito > 0
    expect(() =>
      crearCliente(db, actorCajero, {
        nombre: 'Cliente Fiado',
        limiteCreditoCentavos: 50000,
      })
    ).toThrow(/permiso|autorización/i);

    const clienteId = crearCliente(db, actorAdmin, {
      nombre: 'Cliente Autorizado',
      limiteCreditoCentavos: 100000,
    });
    const provId = crearProveedor(db, actorAdmin, { nombre: 'Prov P3' });

    // Cajero no puede operar cuenta corriente de proveedor
    expect(() =>
      registrarMovimientoCuentaCorriente(db, actorCajero, {
        entidadTipo: 'proveedor',
        entidadId: provId,
        tipo: 'pago',
        montoCentavos: 1000,
      })
    ).toThrow(/permiso|autorización/i);

    registrarMovimientoCuentaCorriente(db, actorAdmin, {
      entidadTipo: 'cliente',
      entidadId: clienteId,
      tipo: 'cargo',
      montoCentavos: 50000,
    });

    // Impide sobrepago
    expect(() =>
      registrarMovimientoCuentaCorriente(db, actorCajero, {
        entidadTipo: 'cliente',
        entidadId: clienteId,
        tipo: 'pago',
        montoCentavos: 60000,
      })
    ).toThrow(/SOBREPAGO_CUENTA_CORRIENTE/);

    // Cliente borrado lógicamente no lista movimientos
    db.prepare(`UPDATE clientes SET deleted_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      clienteId
    );
    expect(
      listarMovimientosCuentaCorriente(db, comercioId, 'cliente', clienteId)
    ).toEqual([]);
  });

  it('caja_repo impide que un cajero opere o cierre la caja de otro operador', () => {
    const { db, actorAdmin, actorCajero } = prepararEntorno();
    const sesionAdmin = abrirSesionCaja(db, actorAdmin, {
      montoInicialCentavos: 100000,
    });

    expect(() =>
      registrarMovimientoManualCaja(db, actorCajero, {
        cajaSesionId: sesionAdmin,
        tipo: 'egreso',
        concepto: 'Retiro',
        montoCentavos: 10000,
      })
    ).toThrow(/CAJA_OTRO_OPERADOR/);

    expect(() =>
      cerrarSesionCaja(db, actorCajero, {
        cajaSesionId: sesionAdmin,
        efectivoContadoCentavos: 100000,
      })
    ).toThrow(/CAJA_OTRO_OPERADOR/);
  });

  it('transferirProductosEntreSucursales agrega cantidades repetidas del mismo producto antes de validar stock', () => {
    const { db, actorAdmin } = prepararEntorno();
    const sucDestinoId = crearSucursalComercio(db, actorAdmin, {
      nombre: 'Sucursal Norte',
    });
    const sucOrigen = db
      .prepare(`SELECT id FROM sucursales WHERE es_principal = 1 LIMIT 1`)
      .get() as { id: string };

    const prodId = crearProducto(db, actorAdmin, {
      nombre: 'Yerba 1kg',
      costoCompraCentavos: 200000,
      precioVentaCentavos: 300000,
      stockInicial: 5,
      sucursalId: sucOrigen.id,
    });

    expect(() =>
      transferirProductosEntreSucursales(db, actorAdmin, {
        sucursalOrigenId: sucOrigen.id,
        sucursalDestinoId: sucDestinoId,
        motivo: 'Intento de bypass con líneas duplicadas',
        items: [
          { productoId: prodId, cantidad: 4 },
          { productoId: prodId, cantidad: 4 },
        ],
      })
    ).toThrow(/stock|disponible|insuficiente/i);
  });

  it('integridad referencial, cascada de tombstone, precio faltante y validación de decimales', () => {
    const { db, actorAdmin } = prepararEntorno();
    const prodId = crearProducto(db, actorAdmin, {
      nombre: 'Lata Gaseosa',
      permiteDecimales: false,
      costoCompraCentavos: 50000,
      precioVentaCentavos: 100000,
      codigosBarras: ['7790001112223'],
    });

    // No admite decimales en movimiento de stock
    expect(() =>
      registrarMovimientoStock(db, actorAdmin, {
        productoId: prodId,
        tipo: 'ajuste',
        cantidad: 1.5,
      })
    ).toThrow(/CANTIDAD_ENTERA_REQUERIDA/);

    // Crear variante y borrar precio predeterminado para probar creación de precio faltante
    crearVarianteProducto(db, actorAdmin, {
      productoId: prodId,
      nombre: 'Fría',
      precioAdicionalCentavos: 10000,
    });
    db.prepare(`DELETE FROM precios WHERE producto_id = ?`).run(prodId);

    actualizarProductoYPrecio(db, actorAdmin, {
      productoId: prodId,
      precioVentaCentavos: 120000,
    });
    const precioCreado = db
      .prepare(
        `SELECT precio_venta FROM precios WHERE producto_id = ? AND deleted_at IS NULL`
      )
      .get(prodId) as { precio_venta: number } | undefined;
    expect(precioCreado?.precio_venta).toBe(120000);

    // Baja lógica cascadea a precios, codigos_barras y variantes
    eliminarProductoLogico(db, actorAdmin, { productoId: prodId });
    const preciosActivos = db
      .prepare(
        `SELECT COUNT(*) AS c FROM precios WHERE producto_id = ? AND deleted_at IS NULL`
      )
      .get(prodId) as { c: number };
    const codigosActivos = db
      .prepare(
        `SELECT COUNT(*) AS c FROM codigos_barras WHERE producto_id = ? AND deleted_at IS NULL`
      )
      .get(prodId) as { c: number };
    const variantesActivas = db
      .prepare(
        `SELECT COUNT(*) AS c FROM variantes WHERE producto_id = ? AND deleted_at IS NULL`
      )
      .get(prodId) as { c: number };
    expect(preciosActivos.c).toBe(0);
    expect(codigosActivos.c).toBe(0);
    expect(variantesActivas.c).toBe(0);

    // Referencias cruzadas/inexistentes rechazadas
    const otroId = generarUuidV7();
    expect(() =>
      crearCategoria(db, actorAdmin, { nombre: 'Sub', padreId: otroId })
    ).toThrow();
    expect(() =>
      crearComboPromocion(db, actorAdmin, {
        nombre: 'Combo Inválido',
        precioVentaCentavos: 10000,
        componentes: [{ productoId: prodId, cantidad: 1 }],
      })
    ).toThrow();
    const listaId = crearListaPrecio(db, actorAdmin, { nombre: 'Mayorista' });
    expect(() =>
      asignarPrecioProductoEnLista(db, actorAdmin, {
        productoId: prodId,
        listaPrecioId: listaId,
        precioVentaCentavos: 90000,
      })
    ).toThrow();
  });
});
