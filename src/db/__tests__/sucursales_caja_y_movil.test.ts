import { describe, expect, it } from 'vitest';
import {
  asegurarSucursalPrincipalComercio,
  crearBaseDatos,
  crearProducto,
  crearSucursalComercio,
  inicializarComercioYSuperadmin,
  listarSucursalesComercio,
  listarTransferenciasSucursales,
  obtenerInformeGestionFase1,
  obtenerMapaStockPorSucursalDb,
  obtenerStockProducto,
  obtenerSucursalActivaTerminal,
  registrarMovimientoStock,
  registrarVenta,
  seleccionarSucursalActivaTerminal,
  transferirProductosEntreSucursales,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../index.ts';

describe('Administración de Sucursales, Ubicación de Stock, Migración entre Locales e Informes por Sucursal', () => {
  it('crea sucursales, desglosa el stock por ubicación, migra productos entre sucursales de forma atómica y filtra informes por sucursal', () => {
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Ferretería MultiSucursal',
      cuit: '30-71234567-1',
      condicionIva: 'responsable_inscripto',
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

    const casaCentral = asegurarSucursalPrincipalComercio(
      db,
      comercioId,
      actorSuperadmin.device_id
    );
    expect(casaCentral.es_principal).toBe(true);
    expect(casaCentral.nombre).toBe('Casa Central');

    // Crear segunda sucursal
    const sucursalNorteId = crearSucursalComercio(db, actorSuperadmin, {
      nombre: 'Sucursal Norte',
      codigo: 'SUC-02',
      direccion: 'Av. Cabildo 2100',
      telefono: '11-4788-0011',
    });

    // Crear producto con 30 unidades iniciales en Casa Central
    const prodId = crearProducto(db, actorSuperadmin, {
      nombre: 'Taladro Percutor 750W',
      codigoInterno: 'TAL-750',
      costoCompraCentavos: 4500000,
      precioVentaCentavos: 6800000,
      alicuotaIva: 21,
      stockMinimo: 5,
      stockInicial: 30,
      sucursalId: casaCentral.id,
    });

    expect(obtenerStockProducto(db, comercioId, prodId)).toBe(30);
    expect(obtenerStockProducto(db, comercioId, prodId, casaCentral.id)).toBe(30);
    expect(obtenerStockProducto(db, comercioId, prodId, sucursalNorteId)).toBe(0);

    // Migrar 12 unidades de Casa Central -> Sucursal Norte
    const transf = transferirProductosEntreSucursales(db, actorSuperadmin, {
      sucursalOrigenId: casaCentral.id,
      sucursalDestinoId: sucursalNorteId,
      motivo: 'Abastecimiento inicial Sucursal Norte',
      items: [{ productoId: prodId, cantidad: 12 }],
    });

    expect(transf.cantidadItems).toBe(1);
    expect(transf.totalUnidades).toBe(12);

    // El stock total del comercio sigue siendo 30 (18 en Casa Central + 12 en Sucursal Norte)
    expect(obtenerStockProducto(db, comercioId, prodId)).toBe(30);
    expect(obtenerStockProducto(db, comercioId, prodId, casaCentral.id)).toBe(18);
    expect(obtenerStockProducto(db, comercioId, prodId, sucursalNorteId)).toBe(12);

    const { mapaPorProducto } = obtenerMapaStockPorSucursalDb(db, comercioId);
    expect(mapaPorProducto.get(prodId)?.por_sucursal[casaCentral.id]).toBe(18);
    expect(mapaPorProducto.get(prodId)?.por_sucursal[sucursalNorteId]).toBe(12);

    // Cambiar sucursal activa de la terminal a Sucursal Norte y registrar una venta de 2 unidades allí
    seleccionarSucursalActivaTerminal(db, actorSuperadmin, sucursalNorteId);
    expect(obtenerSucursalActivaTerminal(db, comercioId).id).toBe(
      sucursalNorteId
    );

    registrarVenta(db, actorSuperadmin, {
      sucursalId: sucursalNorteId,
      items: [{ productoId: prodId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 13600000 }],
    });

    // Ahora Sucursal Norte tiene 10 unidades y Casa Central sigue con 18
    expect(obtenerStockProducto(db, comercioId, prodId, sucursalNorteId)).toBe(10);
    expect(obtenerStockProducto(db, comercioId, prodId, casaCentral.id)).toBe(18);
    expect(obtenerStockProducto(db, comercioId, prodId)).toBe(28);

    // Registrar ingreso por compra de 5 unidades en Casa Central
    registrarMovimientoStock(db, actorSuperadmin, {
      productoId: prodId,
      sucursalId: casaCentral.id,
      tipo: 'compra',
      cantidad: 5,
      motivo: 'Reposición Casa Central',
    });
    expect(obtenerStockProducto(db, comercioId, prodId, casaCentral.id)).toBe(23);

    // Verificar informes filtrados por sucursal vs consolidados
    const desde = '2020-01-01T00:00:00.000Z';
    const hasta = '2099-12-31T23:59:59.999Z';

    const informeNorte = obtenerInformeGestionFase1(db, actorSuperadmin, {
      fechaDesdeIso: desde,
      fechaHastaIso: hasta,
      sucursalId: sucursalNorteId,
    });
    expect(informeNorte.metricasClave.totalVentasCentavos).toBe(13600000);
    const itemTaladroNorte = informeNorte.stockValorizado.items.find(
      (i) => i.producto_id === prodId
    );
    expect(itemTaladroNorte?.stock_actual).toBe(10);

    const informeCentral = obtenerInformeGestionFase1(db, actorSuperadmin, {
      fechaDesdeIso: desde,
      fechaHastaIso: hasta,
      sucursalId: casaCentral.id,
    });
    const itemTaladroCentral = informeCentral.stockValorizado.items.find(
      (i) => i.producto_id === prodId
    );
    expect(itemTaladroCentral?.stock_actual).toBe(23);

    // Listados de sucursales y transferencias
    const sucursales = listarSucursalesComercio(db, comercioId);
    expect(sucursales.length).toBe(2);
    const transferencias = listarTransferenciasSucursales(db, comercioId);
    expect(transferencias.length).toBe(1);
    expect(transferencias[0]?.sucursal_origen_nombre).toBe('Casa Central');
    expect(transferencias[0]?.sucursal_destino_nombre).toBe('Sucursal Norte');

    // Cadena de auditoría SHA-256 íntegra
    const verificacionAuditoria = verificarIntegridadAuditoriaDb(db, comercioId);
    expect(verificacionAuditoria.integra).toBe(true);
  });
});
