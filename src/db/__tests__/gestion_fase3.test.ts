import { describe, expect, it } from 'vitest';
import {
  calcularDigitoVerificadorCuit,
  validarCuitModulo11,
  validarDocumentoArgentino,
} from '../../domain/cuit.ts';
import { aCentavos } from '../../domain/dinero.ts';
import {
  aplicarRedondeoCentavos,
  calcularNuevoPrecioMasivo,
  parsearCsvImportacionCatalogo,
} from '../../domain/gestion_fase3.ts';
import {
  aplicarActualizacionMasivaPrecios,
  crearCategoria,
  crearCliente,
  crearMarca,
  crearProveedor,
  exportarLibroIvaAXlsx,
  generarTicketEscPosDeVentaDb,
  importarProductosDesdeCsv,
  listarClientesConSaldo,
  listarMovimientosCuentaCorriente,
  listarProveedoresConSaldo,
  registrarCompraProveedor,
  registrarMovimientoCuentaCorriente,
} from '../gestion_fase3_repo.ts';
import { crearBaseDatos } from '../migrator.ts';
import {
  anularVenta,
  crearProducto,
  inicializarComercioYSuperadmin,
  obtenerStockProducto,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../repositorios.ts';

function prepararEscenarioFase3() {
  const db = crearBaseDatos(':memory:');
  const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
    nombreComercio: 'Ferretería y Librería El Sol',
    cuit: '30-71234567-9',
    condicionIva: 'responsable_inscripto',
    nombreAdmin: 'María Superadmin',
    usuarioAdmin: 'maria',
    claveHashAdmin: '$argon2id$v=19$m=4096,t=2,p=1$salt$hash',
    deviceId: 'caja-fase3',
  });

  const actorSuperadmin: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: superadminId,
    usuario_nombre: 'María Superadmin',
    rol: 'superadmin',
    device_id: 'caja-fase3',
  };

  const actorCajero: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: superadminId,
    usuario_nombre: 'Lucas Cajero',
    rol: 'cajero',
    device_id: 'caja-fase3',
  };

  return { db, comercioId, actorSuperadmin, actorCajero };
}

describe('Fase 3 — Dominio puro (CUIT Módulo 11, Redondeo, CSV)', () => {
  it('valida CUITs argentinos reales mediante Módulo 11 y rechaza dígitos verificadores adulterados', () => {
    const base10 = '2012345678';
    const dv = calcularDigitoVerificadorCuit(base10);
    expect(dv).toBe(6);

    expect(validarCuitModulo11('20-12345678-6')).toBe(true);
    expect(validarCuitModulo11('20123456786')).toBe(true);
    expect(validarCuitModulo11('20-12345678-5')).toBe(false);

    const docCuit = validarDocumentoArgentino('20-12345678-6');
    expect(docCuit.valido).toBe(true);
    expect(docCuit.tipo).toBe('cuit_cuil');
    expect(docCuit.documentoFormateado).toBe('20-12345678-6');

    const docDni = validarDocumentoArgentino('30.112.233');
    expect(docDni.valido).toBe(true);
    expect(docDni.tipo).toBe('dni');
    expect(docDni.documentoFormateado).toBe('30112233');

    const docInvalido = validarDocumentoArgentino('20-12345678-0');
    expect(docInvalido.valido).toBe(false);
  });

  it('aplica aumento porcentual y reglas de redondeo comercial en centavos enteros', () => {
    // $ 1.234,00 (123400 centavos) + 15% = $ 1.419,10 (141910 centavos)
    expect(
      calcularNuevoPrecioMasivo(aCentavos(123400), 15, 'exacto')
    ).toBe(141910);
    expect(
      calcularNuevoPrecioMasivo(aCentavos(123400), 15, 'pesos_enteros')
    ).toBe(141900);
    expect(
      calcularNuevoPrecioMasivo(aCentavos(123400), 15, 'multiplo_10_pesos')
    ).toBe(142000);
    expect(
      calcularNuevoPrecioMasivo(aCentavos(123400), 15, 'multiplo_50_pesos')
    ).toBe(140000);
    expect(
      calcularNuevoPrecioMasivo(aCentavos(123400), 15, 'multiplo_100_pesos')
    ).toBe(140000);

    expect(aplicarRedondeoCentavos(14550, 'multiplo_10_pesos')).toBe(15000);
  });

  it('parsea CSV de importación de catálogo con encabezados y separador punto y coma', () => {
    const csv = [
      'codigo_interno;nombre;costo_compra;precio_venta;stock_inicial;codigo_barras;categoria;marca',
      'FER-01;Martillo Galponero;4500,50;8200,00;12;7790010020011;Herramientas;Stanley',
      'LIB-02;Cuaderno Universitario;1800;3200;25;7790010020028;Librería;Rivadavia',
    ].join('\n');

    const res = parsearCsvImportacionCatalogo(csv);
    expect(res.errores).toHaveLength(0);
    expect(res.filas).toHaveLength(2);
    expect(res.filas[0]).toMatchObject({
      codigoInterno: 'FER-01',
      nombre: 'Martillo Galponero',
      costoCompraCentavos: 450050,
      precioVentaCentavos: 820000,
      stockInicial: 12,
      codigoBarras: '7790010020011',
      categoriaNombre: 'Herramientas',
      marcaNombre: 'Stanley',
    });
  });
});

describe('Fase 3 — Repositorios SQLite (Compras, Proveedores, Clientes Cta Cte, Precios Masivos, Libro IVA, ESC/POS)', () => {
  it('registra compras a proveedor actualizando stock por movimientos, costo_compra y cuenta corriente del proveedor', () => {
    const { db, comercioId, actorSuperadmin, actorCajero } =
      prepararEscenarioFase3();

    // Cajero no puede crear proveedores ni registrar compras
    expect(() =>
      crearProveedor(db, actorCajero, { razonSocial: 'No Autorizado' })
    ).toThrow(/PERMISO_DENEGADO/);

    const provId = crearProveedor(db, actorSuperadmin, {
      razonSocial: 'Distribuidora Sur S.R.L.',
      cuit: '20-12345678-6',
      telefono: '11 4000-1111',
    });

    const prodId = crearProducto(db, actorSuperadmin, {
      nombre: 'Destornillador Imantado',
      codigoInterno: 'DES-001',
      proveedorId: provId,
      costoCompraCentavos: aCentavos(200000), // $ 2.000
      precioVentaCentavos: aCentavos(380000), // $ 3.800
      stockInicial: 5,
    });

    expect(obtenerStockProducto(db, comercioId, prodId)).toBe(5);

    // Registrar compra de 10 unidades a nuevo costo $ 2.500 c/u (total $ 25.000), pagando $ 10.000 en el acto
    const compra = registrarCompraProveedor(db, actorSuperadmin, {
      proveedorId: provId,
      numeroComprobante: 'FC-A 0001-00001234',
      items: [
        {
          productoId: prodId,
          cantidad: 10,
          costoUnitarioCentavos: aCentavos(250000),
          alicuotaIva: 21,
          actualizarCostoProducto: true,
        },
      ],
      registrarCargoCuentaCorriente: true,
      montoPagadoEnElActoCentavos: aCentavos(1000000), // $ 10.000
    });

    expect(compra.totalCentavos).toBe(2500000);
    // Stock = 5 (inicial) + 10 (movimiento 'compra') = 15
    expect(obtenerStockProducto(db, comercioId, prodId)).toBe(15);

    // Costo actualizado a $ 2.500 (250000 centavos)
    const prodRow = db
      .prepare('SELECT costo_compra FROM productos WHERE id = ?')
      .get(prodId) as { costo_compra: number };
    expect(prodRow.costo_compra).toBe(250000);

    // Saldo cuenta corriente proveedor = $ 25.000 cargo - $ 10.000 pago = $ 15.000 (1500000 centavos)
    const proveedores = listarProveedoresConSaldo(db, comercioId);
    expect(proveedores).toHaveLength(1);
    expect(proveedores[0]!.saldo_pendiente_centavos).toBe(1500000);

    // Registrar pago posterior de $ 5.000 al proveedor
    registrarMovimientoCuentaCorriente(db, actorSuperadmin, {
      entidadTipo: 'proveedor',
      entidadId: provId,
      tipo: 'pago',
      montoCentavos: aCentavos(500000),
      observaciones: 'Pago transferencia parcial',
    });

    const proveedoresDespues = listarProveedoresConSaldo(db, comercioId);
    expect(proveedoresDespues[0]!.saldo_pendiente_centavos).toBe(1000000);
  });

  it('controla el límite de crédito en ventas con cuenta_corriente y revierte la deuda al anular la venta', () => {
    const { db, comercioId, actorSuperadmin } = prepararEscenarioFase3();

    const prodId = crearProducto(db, actorSuperadmin, {
      nombre: 'Resma A4 75g',
      codigoInterno: 'RES-A4',
      costoCompraCentavos: aCentavos(400000),
      precioVentaCentavos: aCentavos(600000), // $ 6.000
      stockInicial: 20,
    });

    // Cliente con límite de crédito de $ 10.000 (1.000.000 centavos)
    const clienteId = crearCliente(db, actorSuperadmin, {
      nombre: 'Estudio Contable Gómez',
      documento: '20-12345678-6',
      condicionIva: 'responsable_inscripto',
      limiteCreditoCentavos: aCentavos(1000000),
    });

    // 1) Intentar vender en cuenta_corriente sin indicar cliente -> debe fallar
    expect(() =>
      registrarVenta(db, actorSuperadmin, {
        items: [{ productoId: prodId, cantidad: 1 }],
        pagos: [{ medio: 'cuenta_corriente', monto: aCentavos(600000) }],
      })
    ).toThrow(/Debe seleccionar un cliente/);

    // 2) Venta de 1 unidad ($ 6.000) en cuenta corriente -> dentro del límite ($ 10.000)
    const venta1 = registrarVenta(db, actorSuperadmin, {
      clienteId,
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'cuenta_corriente', monto: aCentavos(600000) }],
    });

    let estadoCli = listarClientesConSaldo(db, comercioId)[0]!;
    expect(estadoCli.saldo_pendiente_centavos).toBe(600000);
    expect(estadoCli.credito_disponible_centavos).toBe(400000);

    // 3) Intentar otra venta de 1 unidad ($ 6.000) en cuenta corriente -> supera límite ($ 6.000 + $ 6.000 = $ 12.000 > $ 10.000)
    expect(() =>
      registrarVenta(db, actorSuperadmin, {
        clienteId,
        items: [{ productoId: prodId, cantidad: 1 }],
        pagos: [{ medio: 'cuenta_corriente', monto: aCentavos(600000) }],
      })
    ).toThrow(/LIMITE_CREDITO_EXCEDIDO/);

    // 4) Anular la venta1 -> debe devolver el stock y asentar reversión en cuenta corriente dejando saldo 0
    anularVenta(db, actorSuperadmin, {
      ventaId: venta1.ventaId,
      motivo: 'Error en facturación de cuenta corriente',
    });

    estadoCli = listarClientesConSaldo(db, comercioId)[0]!;
    expect(estadoCli.saldo_pendiente_centavos).toBe(0);
    expect(estadoCli.credito_disponible_centavos).toBe(1000000);

    const movs = listarMovimientosCuentaCorriente(
      db,
      comercioId,
      'cliente',
      clienteId
    );
    expect(movs).toHaveLength(2); // 1 cargo + 1 pago por reversión de anulación
  });

  it('aplica actualización masiva de precios filtrada por categoría e importa catálogo desde CSV', () => {
    const { db, comercioId, actorSuperadmin } = prepararEscenarioFase3();

    const catLibreria = crearCategoria(db, actorSuperadmin, {
      nombre: 'Librería',
    });
    const catKiosco = crearCategoria(db, actorSuperadmin, {
      nombre: 'Kiosco',
    });
    const marcaBic = crearMarca(db, actorSuperadmin, { nombre: 'BIC' });

    const prodLapicera = crearProducto(db, actorSuperadmin, {
      nombre: 'Bolígrafo Azul',
      codigoInterno: 'BOL-AZ',
      categoriaId: catLibreria,
      marcaId: marcaBic,
      costoCompraCentavos: aCentavos(50000),
      precioVentaCentavos: aCentavos(100000), // $ 1.000
      stockInicial: 10,
    });

    const prodCaramelo = crearProducto(db, actorSuperadmin, {
      nombre: 'Caramelos Menta',
      codigoInterno: 'CAR-01',
      categoriaId: catKiosco,
      costoCompraCentavos: aCentavos(20000),
      precioVentaCentavos: aCentavos(50000), // $ 500
      stockInicial: 20,
    });

    // Aumentar un 25% solo la categoría Librería
    const resMasivo = aplicarActualizacionMasivaPrecios(db, actorSuperadmin, {
      porcentaje: 25,
      reglaRedondeo: 'pesos_enteros',
      categoriaId: catLibreria,
      actualizarCostoCompraTambien: true,
    });

    expect(resMasivo.productosActualizados).toBe(1);

    const precioLapicera = db
      .prepare('SELECT precio_venta FROM vista_productos_venta WHERE id = ?')
      .get(prodLapicera) as { precio_venta: number };
    const precioCaramelo = db
      .prepare('SELECT precio_venta FROM vista_productos_venta WHERE id = ?')
      .get(prodCaramelo) as { precio_venta: number };

    expect(precioLapicera.precio_venta).toBe(125000); // $ 1.250
    expect(precioCaramelo.precio_venta).toBe(50000); // Sin cambios ($ 500)

    // Importar CSV con 1 producto nuevo y 1 actualización de BOL-AZ
    const csv = [
      'codigo_interno;nombre;costo_compra;precio_venta;stock_inicial;codigo_barras;categoria;marca',
      'BOL-AZ;Bolígrafo Azul;700;1500;0;7791112223334;Librería;BIC',
      ' CUA-99 ;Cuaderno Tapa Dura;2100;3900;8;7799998887776;Librería;Éxito',
    ].join('\n');

    const resImport = importarProductosDesdeCsv(db, actorSuperadmin, {
      contenidoCsv: csv,
      actualizarSiExisteCodigo: true,
    });

    expect(resImport.creados).toBe(1);
    expect(resImport.actualizados).toBe(1);
    expect(resImport.errores).toHaveLength(0);

    const precioLapiceraNuevo = db
      .prepare('SELECT precio_venta FROM vista_productos_venta WHERE id = ?')
      .get(prodLapicera) as { precio_venta: number };
    expect(precioLapiceraNuevo.precio_venta).toBe(150000); // $ 1.500

    const cuadernoRow = db
      .prepare(
        'SELECT id FROM productos WHERE comercio_id = ? AND codigo_interno = ?'
      )
      .get(comercioId, 'CUA-99') as { id: string };
    expect(obtenerStockProducto(db, comercioId, cuadernoRow.id)).toBe(8);
  });

  it('genera Libro IVA Ventas/Compras en Excel (.xlsx) y ticket térmico ESC/POS sin exponer costo_compra (Regla 20)', () => {
    const { db, comercioId, actorSuperadmin } = prepararEscenarioFase3();

    const prodId = crearProducto(db, actorSuperadmin, {
      nombre: 'Taladro Percutor 650W',
      codigoInterno: 'TAL-650',
      costoCompraCentavos: aCentavos(4891230), // $ 48.912,30 (valor único para verificar Regla 20)
      precioVentaCentavos: aCentavos(12100000), // $ 121.000,00 IVA 21% incluido (Neto $ 100.000, IVA $ 21.000)
      alicuotaIva: 21,
      stockInicial: 3,
    });

    // Registrar una compra con IVA 21%
    registrarCompraProveedor(db, actorSuperadmin, {
      numeroComprobante: 'FC-A 0005-00009999',
      items: [
        {
          productoId: prodId,
          cantidad: 2,
          costoUnitarioCentavos: aCentavos(6050000), // Total $ 121.000
          alicuotaIva: 21,
          actualizarCostoProducto: false,
        },
      ],
    });

    // Registrar una venta completada y otra que luego se anula
    const ventaValida = registrarVenta(db, actorSuperadmin, {
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'debito', monto: aCentavos(12100000) }],
    });

    const ventaAnulada = registrarVenta(db, actorSuperadmin, {
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: aCentavos(12100000) }],
    });
    anularVenta(db, actorSuperadmin, {
      ventaId: ventaAnulada.ventaId,
      motivo: 'Anulación de prueba IVA',
    });

    // Verificar Libro IVA (la venta anulada NO debe sumar en el total del Libro IVA)
    const { xlsxBytes, libro } = exportarLibroIvaAXlsx(db, actorSuperadmin, {});
    expect(libro.ivaVentas.filas).toHaveLength(2);
    expect(libro.ivaVentas.total_general_centavos).toBe(12100000);
    expect(libro.ivaVentas.total_neto_gravado_centavos).toBe(10000000);
    expect(libro.ivaVentas.total_iva_21_centavos).toBe(2100000);

    expect(libro.ivaCompras.filas).toHaveLength(1);
    expect(libro.ivaCompras.total_general_centavos).toBe(12100000);

    // El archivo .xlsx empieza con la firma ZIP PK\x03\x04
    expect(xlsxBytes[0]).toBe(0x50);
    expect(xlsxBytes[1]).toBe(0x4b);

    // Generar Ticket ESC/POS en 80mm y 58mm y verificar Regla 20 (nunca aparece costo_compra $ 48.912,30)
    const esc80 = generarTicketEscPosDeVentaDb(db, comercioId, {
      ventaId: ventaValida.ventaId,
      anchoMm: 80,
    });
    const esc58 = generarTicketEscPosDeVentaDb(db, comercioId, {
      ventaId: ventaValida.ventaId,
      anchoMm: 58,
    });

    expect(esc80.anchoCaracteres).toBe(48);
    expect(esc58.anchoCaracteres).toBe(32);
    expect(esc80.textoPlano).toContain('Taladro Percutor 650W');
    expect(esc80.textoPlano).toContain('121.000,00');
    expect(esc80.textoPlano).not.toContain('48.912,30');
    expect(esc80.textoPlano).not.toContain('4891230');
    expect(esc58.textoPlano).not.toContain('48.912,30');

    // Verificar que toda la cadena de auditoría SHA-256 sigue 100% íntegra
    const verificacion = verificarIntegridadAuditoriaDb(db, comercioId);
    expect(verificacion.integra).toBe(true);
  });
});
