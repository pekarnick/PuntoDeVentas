import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  AdaptadorArcaHomologacionLocal,
  anularVentaConNotaCreditoArca,
  asignarPrecioProductoEnLista,
  crearComboPromocion,
  crearListaPrecio,
  crearVarianteProducto,
  emitirComprobanteArcaVenta,
  guardarConfiguracionArca,
  listarCombosComercio,
  obtenerComprobanteFiscalImprimibleDb,
  obtenerConfiguracionArca,
  obtenerInformeComprobantesArca,
  reintentarComprobantesArcaPendientes,
  resolverEscaneoBalanzaEnCatalogo,
  venderComboPromocion,
} from '../arca_fase4_repo.ts';
import { crearCliente } from '../gestion_fase3_repo.ts';
import { crearBaseDatos } from '../migrator.ts';
import {
  crearProducto,
  inicializarComercioYSuperadmin,
  obtenerStockProducto,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../repositorios.ts';
import {
  construirCodigoBarrasBalanzaEan13,
  determinarNotaCreditoArca,
  determinarTipoComprobanteArca,
  parsearCodigoBarrasBalanza,
  validarConfiguracionArcaCliente,
} from '../../domain/arca_fase4.ts';
import { PanelVentaPOS } from '../../features/venta/PanelVentaPOS.tsx';

function crearContextoFase4() {
  const db = crearBaseDatos(':memory:');
  const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
    nombreComercio: 'Ferretería y Almacén El Sol',
    cuit: '20-11111111-2',
    condicionIva: 'monotributo',
    nombreAdmin: 'María Superadmin',
    usuarioAdmin: 'maria',
    claveHashAdmin: 'argon2id$v=19$m=65536,t=3,p=1$hashdemo',
    deviceId: 'terminal-test-fase4',
  });

  const actorSuperadmin: ActorContexto = {
    comercio_id: comercioId,
    usuario_id: superadminId,
    usuario_nombre: 'María Superadmin',
    rol: 'superadmin',
    device_id: 'terminal-test-fase4',
  };

  const prodTaladroId = crearProducto(db, actorSuperadmin, {
    nombre: 'Taladro Percutor 750W',
    codigoInterno: 'TAL-750',
    costoCompraCentavos: 4500000, // $ 45.000,00 (NUNCA visible en factura ni ticket)
    precioVentaCentavos: 7200000, // $ 72.000,00
    alicuotaIva: 21,
    codigosBarras: ['7799000000015'],
    stockInicial: 20,
  });

  const prodMechaId = crearProducto(db, actorSuperadmin, {
    nombre: 'Set de Mechas Acero Rápido',
    codigoInterno: 'MEC-10',
    costoCompraCentavos: 800000, // $ 8.000,00
    precioVentaCentavos: 1500000, // $ 15.000,00
    alicuotaIva: 21,
    codigosBarras: ['7799000000022'],
    stockInicial: 30,
  });

  const prodQuesoBalanzaId = crearProducto(db, actorSuperadmin, {
    nombre: 'Queso Tybo por Kg',
    codigoInterno: '00105',
    unidad: 'kg',
    permiteDecimales: true,
    costoCompraCentavos: 520000, // $ 5.200,00 / kg
    precioVentaCentavos: 800000, // $ 8.000,00 / kg
    alicuotaIva: 21,
    codigosBarras: ['00105'],
    stockInicial: 15,
  });

  return {
    db,
    comercioId,
    actorSuperadmin,
    prodTaladroId,
    prodMechaId,
    prodQuesoBalanzaId,
  };
}

describe('Fase 4 — Facturación Electrónica ARCA (Opcional) y Extras (PLAN.md §6.3, §10 y §14)', () => {
  it('1. Con ARCA apagada por defecto no aparece ninguna opción fiscal en la UI y las ventas son ticket_no_fiscal', () => {
    const { db, comercioId, actorSuperadmin, prodTaladroId } =
      crearContextoFase4();

    const cfgInicial = obtenerConfiguracionArca(db, comercioId);
    expect(cfgInicial.arca_habilitada).toBe(false);

    const venta = registrarVenta(db, actorSuperadmin, {
      items: [{ productoId: prodTaladroId, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: 7200000 }],
    });

    expect(venta.tipoComprobante).toBe('ticket_no_fiscal');
    expect(venta.estadoFacturacion).toBe('no_aplica');

    // Renderizar PanelVentaPOS con ARCA apagada: no debe aparecer ningún texto ni indicador de ARCA o CAE
    const htmlVentaConArcaApagada = renderToStaticMarkup(
      React.createElement(PanelVentaPOS, {
        rolActivo: 'cajero',
        operadorNombre: 'Lucas Cajero',
        configArca: cfgInicial,
      })
    );
    expect(htmlVentaConArcaApagada).not.toContain('Facturación ARCA Activa');
    expect(htmlVentaConArcaApagada).not.toContain('Factura / QR ARCA');
  });

  it('2. Determina correctamente Factura A, B y C según condición IVA del emisor y del cliente, y Notas de Crédito', () => {
    // Emisor Monotributo -> siempre Factura C
    expect(
      determinarTipoComprobanteArca({
        arcaHabilitada: true,
        condicionIvaEmisor: 'monotributo',
        condicionIvaReceptor: 'responsable_inscripto',
      }).tipoComprobante
    ).toBe('factura_c');

    // Emisor Responsable Inscripto -> Receptor Responsable Inscripto o Monotributo -> Factura A
    expect(
      determinarTipoComprobanteArca({
        arcaHabilitada: true,
        condicionIvaEmisor: 'responsable_inscripto',
        condicionIvaReceptor: 'responsable_inscripto',
      }).tipoComprobante
    ).toBe('factura_a');

    expect(
      determinarTipoComprobanteArca({
        arcaHabilitada: true,
        condicionIvaEmisor: 'responsable_inscripto',
        condicionIvaReceptor: 'monotributo',
      }).tipoComprobante
    ).toBe('factura_a');

    // Emisor Responsable Inscripto -> Receptor Consumidor Final o Exento -> Factura B
    expect(
      determinarTipoComprobanteArca({
        arcaHabilitada: true,
        condicionIvaEmisor: 'responsable_inscripto',
        condicionIvaReceptor: 'consumidor_final',
      }).tipoComprobante
    ).toBe('factura_b');

    // Notas de crédito asociadas
    expect(determinarNotaCreditoArca('factura_a')).toBe('nota_credito_a');
    expect(determinarNotaCreditoArca('factura_b')).toBe('nota_credito_b');
    expect(determinarNotaCreditoArca('factura_c')).toBe('nota_credito_c');
    expect(determinarNotaCreditoArca('ticket_no_fiscal')).toBeNull();
  });

  it('3. Con ARCA encendida en homologación obtiene CAE, genera QR oficial RG 4892/2020 sin costos (Regla 20) y emite Nota de Crédito al anular', async () => {
    const { db, comercioId, actorSuperadmin, prodTaladroId } =
      crearContextoFase4();

    // Habilitar ARCA como Responsable Inscripto en ambiente de homologación
    const cfgActiva = guardarConfiguracionArca(db, actorSuperadmin, {
      arcaHabilitada: true,
      razonSocial: 'Ferretería El Sol S.R.L.',
      cuit: '20-11111111-2',
      condicionIva: 'responsable_inscripto',
      domicilio: 'Av. Rivadavia 4500, CABA',
      puntoVenta: 3,
      ambiente: 'homologacion',
      proveedor: 'afip_sdk',
    });

    expect(cfgActiva.arca_habilitada).toBe(true);
    expect(cfgActiva.arca_ambiente).toBe('homologacion');
    expect(cfgActiva.arca_punto_venta).toBe(3);

    // Crear un cliente Responsable Inscripto con CUIT válido módulo 11 (20-11111111-2)
    const clienteRiId = crearCliente(db, actorSuperadmin, {
      nombre: 'Constructora Del Sur S.A.',
      cuitDni: '20-11111111-2',
      condicionIva: 'responsable_inscripto',
      limiteCreditoCentavos: 50000000,
    });

    // Registrar venta -> debe determinarse como factura_a y quedar inicialmente 'pendiente'
    const venta = registrarVenta(db, actorSuperadmin, {
      items: [{ productoId: prodTaladroId, cantidad: 1 }],
      pagos: [{ medio: 'transferencia', monto: 7200000 }],
      clienteId: clienteRiId,
    });

    expect(venta.tipoComprobante).toBe('factura_a');
    expect(venta.estadoFacturacion).toBe('pendiente');

    // Emitir CAE en homologación vía Edge Function
    const adaptador = new AdaptadorArcaHomologacionLocal();
    const emision = await emitirComprobanteArcaVenta(
      db,
      actorSuperadmin,
      venta.ventaId,
      adaptador
    );

    expect(emision.estado_facturacion).toBe('emitida');
    expect(emision.tipo_comprobante).toBe('factura_a');
    expect(emision.punto_venta).toBe(3);
    expect(emision.numero_comprobante).toBe(1);
    expect(emision.cae).toMatch(/^\d{14}$/);
    expect(emision.cae_vencimiento).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(emision.qr_url).toContain('https://www.afip.gob.ar/fe/qr/?p=');

    // Verificar comprobante imprimible / PDF con QR oficial y Regla 20 (nunca muestra costo_compra: 4500000 / 45.000,00)
    const comprobante = obtenerComprobanteFiscalImprimibleDb(
      db,
      comercioId,
      venta.ventaId
    );
    expect(comprobante.letra).toBe('A');
    expect(comprobante.numeroFormateado).toBe('0003-00000001');
    expect(comprobante.qrSvg).toContain('<svg');
    expect(comprobante.htmlImprimible).toContain(emision.cae!);
    expect(comprobante.htmlImprimible).not.toContain('45.000,00');
    expect(comprobante.htmlImprimible).not.toContain('costo_compra');
    expect(comprobante.textoTermico).not.toContain('45.000,00');

    // Decodificar el payload Base64 del QR oficial y verificar estructura RG 4892/2020
    const base64Param = comprobante.urlQrOficial.split('?p=')[1]!;
    const jsonQr = JSON.parse(
      Buffer.from(base64Param, 'base64').toString('utf-8')
    ) as Record<string, unknown>;
    expect(jsonQr.ver).toBe(1);
    expect(jsonQr.cuit).toBe(20111111112);
    expect(jsonQr.ptoVta).toBe(3);
    expect(jsonQr.tipoCmp).toBe(1); // 1 = Factura A
    expect(jsonQr.nroCmp).toBe(1);
    expect(jsonQr.importe).toBe(72000);
    expect(jsonQr.moneda).toBe('PES');
    expect(jsonQr.tipoCodAut).toBe('E');

    // Anular la venta facturada -> debe emitir Nota de Crédito A y devolver el stock
    const anulacion = await anularVentaConNotaCreditoArca(db, actorSuperadmin, {
      ventaId: venta.ventaId,
      motivo: 'Devolución de mercadería fallada',
      adaptador,
    });

    expect(anulacion.notaCreditoEmitida).toBe(true);
    expect(anulacion.notaCreditoTipo).toBe('nota_credito_a');
    expect(anulacion.notaCreditoNumero).toBe(1);
    expect(anulacion.notaCreditoCae).toMatch(/^\d{14}$/);
    expect(obtenerStockProducto(db, comercioId, prodTaladroId)).toBe(20);
    expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);
  });

  it('4. Si falla la emisión por falta de internet, la venta queda pendiente, visible en informes y se reintenta sola al volver la conexión', async () => {
    const { db, comercioId, actorSuperadmin, prodMechaId } =
      crearContextoFase4();

    guardarConfiguracionArca(db, actorSuperadmin, {
      arcaHabilitada: true,
      cuit: '20-11111111-2',
      condicionIva: 'monotributo',
      puntoVenta: 1,
      ambiente: 'homologacion',
    });

    const ventaOffline = registrarVenta(db, actorSuperadmin, {
      items: [{ productoId: prodMechaId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 3000000 }],
    });

    const adaptador = new AdaptadorArcaHomologacionLocal();
    adaptador.fijarConectado(false); // Simulamos corte de internet

    const intentoOffline = await emitirComprobanteArcaVenta(
      db,
      actorSuperadmin,
      ventaOffline.ventaId,
      adaptador
    );

    expect(intentoOffline.estado_facturacion).toBe('pendiente');
    expect(intentoOffline.cae).toBeNull();

    // Debe aparecer visible en el informe de pendientes
    const informePendientes = obtenerInformeComprobantesArca(db, comercioId, {
      estadoFacturacion: 'pendiente',
    });
    expect(informePendientes.totales.pendientesCount).toBe(1);
    expect(informePendientes.comprobantes[0]?.venta_id).toBe(
      ventaOffline.ventaId
    );

    // Vuelve internet -> reintento automático emite el CAE
    adaptador.fijarConectado(true);
    const reintento = await reintentarComprobantesArcaPendientes(
      db,
      actorSuperadmin,
      adaptador
    );
    expect(reintento.procesados).toBe(1);
    expect(reintento.emitidos).toBe(1);
    expect(reintento.siguenPendientes).toBe(0);

    const informeEmitidos = obtenerInformeComprobantesArca(db, comercioId, {
      estadoFacturacion: 'emitida',
    });
    expect(informeEmitidos.totales.emitidosCount).toBe(1);
    expect(informeEmitidos.comprobantes[0]?.cae).toMatch(/^\d{14}$/);
  });

  it('5. Revisión explícita de seguridad: rechaza guardar certificados o claves privadas en el cliente y verifica ausencia en el código', () => {
    const validacionInsegura = validarConfiguracionArcaCliente({
      arcaHabilitada: true,
      cuitEmisor: '20-11111111-2',
      puntoVenta: 1,
      ambiente: 'homologacion',
      camposExtra: {
        cert_pem: '-----BEGIN CERTIFICATE-----MIIB...',
        private_key: '-----BEGIN RSA PRIVATE KEY-----MIIE...',
      },
    });
    expect(validacionInsegura.valido).toBe(false);
    expect(validacionInsegura.motivo).toContain('SEGURIDAD_ARCA');

    // Verificar explícitamente que ni el cliente de escritorio ni web-pos contienen claves privadas RSA/EC
    const archivosRevisar = [
      path.resolve(process.cwd(), 'src/App.tsx'),
      path.resolve(
        process.cwd(),
        'src/features/configuracion/PanelConfiguracionSync.tsx'
      ),
      path.resolve(process.cwd(), 'src/features/venta/PanelVentaPOS.tsx'),
      path.resolve(process.cwd(), 'web-pos/src/WebPosApp.tsx'),
    ];
    for (const ruta of archivosRevisar) {
      const contenido = fs.readFileSync(ruta, 'utf-8');
      expect(contenido).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(contenido).not.toContain('ARCA_PROVIDER_API_TOKEN');
    }
  });

  it('6. Extras de Fase 4: Múltiples listas de precio, Variantes, Combos y lectura de Códigos de Balanza EAN-13', () => {
    const {
      db,
      comercioId,
      actorSuperadmin,
      prodTaladroId,
      prodMechaId,
      prodQuesoBalanzaId,
    } = crearContextoFase4();

    // 6.1 Múltiples Listas de Precio (Lista Mayorista con -10% sobre Mostrador)
    const listaMayoristaId = crearListaPrecio(db, actorSuperadmin, {
      nombre: 'Mayorista Gremio',
      porcentajeSobreMostrador: -10,
    });

    // Asignar un precio puntual para las mechas en la lista Mayorista ($ 12.000,00 = 1200000 centavos)
    asignarPrecioProductoEnLista(db, actorSuperadmin, {
      productoId: prodMechaId,
      listaPrecioId: listaMayoristaId,
      precioVentaCentavos: 1200000,
    });

    const ventaMayorista = registrarVenta(db, actorSuperadmin, {
      listaPrecioId: listaMayoristaId,
      items: [{ productoId: prodMechaId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 2400000 }],
    });
    expect(ventaMayorista.totalCentavos).toBe(2400000);

    // 6.2 Variantes de Producto (Maletín Aluminio +$ 5.000,00 = 500000 centavos)
    const varianteMaletinId = crearVarianteProducto(db, actorSuperadmin, {
      productoId: prodTaladroId,
      nombre: 'Con Maletín de Aluminio',
      atributo1: 'Presentación: Maletín',
      precioAdicionalCentavos: 500000,
    });

    const ventaConVariante = registrarVenta(db, actorSuperadmin, {
      items: [
        {
          productoId: prodTaladroId,
          varianteId: varianteMaletinId,
          cantidad: 1,
        },
      ],
      pagos: [{ medio: 'efectivo', monto: 7700000 }], // $ 72.000 + $ 5.000 = $ 77.000
    });
    expect(ventaConVariante.totalCentavos).toBe(7700000);

    // 6.3 Combos / Promociones (1 Taladro $72.000 + 2 Sets Mechas $30.000 = $102.000 normal -> Precio Combo $90.000)
    const comboId = crearComboPromocion(db, actorSuperadmin, {
      nombre: 'Kit Profesional Taladro + 2 Mechas',
      precioVentaCentavos: 9000000,
      componentes: [
        { productoId: prodTaladroId, cantidad: 1 },
        { productoId: prodMechaId, cantidad: 2 },
      ],
    });

    const combos = listarCombosComercio(db, comercioId);
    expect(combos).toHaveLength(1);
    expect(combos[0]?.precio_suma_normal).toBe(10200000);
    expect(combos[0]?.ahorro_centavos).toBe(1200000);
    // Stock actual: Taladro = 19, Mechas = 28 (28 / 2 = 14) -> min(19, 14) = 14 combos disponibles
    expect(combos[0]?.stock_combos_disponibles).toBe(14);

    const ventaCombo = venderComboPromocion(db, actorSuperadmin, {
      comboId,
      cantidadCombos: 1,
      pagos: [{ medio: 'efectivo', monto: 9000000 }],
    });
    expect(ventaCombo.totalCentavos).toBe(9000000);
    // El stock de ambos componentes se descontó mediante movimientos_stock (Regla 4)
    expect(obtenerStockProducto(db, comercioId, prodTaladroId)).toBe(18);
    expect(obtenerStockProducto(db, comercioId, prodMechaId)).toBe(26);

    // 6.4 Lector de Códigos de Barras de Balanza EAN-13 (Prefijo 20 + PLU 00105 + 01250 gramos = 1,250 kg)
    const etiquetaBalanzaPeso = construirCodigoBarrasBalanzaEan13({
      prefijo: '20',
      codigoPlu: '00105',
      valorCincoDigitos: 1250, // 1,250 kg
    });
    expect(etiquetaBalanzaPeso).toHaveLength(13);

    const parseado = parsearCodigoBarrasBalanza(etiquetaBalanzaPeso);
    expect(parseado.esCodigoBalanza).toBe(true);
    expect(parseado.modo).toBe('peso');
    expect(parseado.codigoPlu).toBe('00105');
    expect(parseado.cantidadKg).toBe(1.25);

    const resueltoEnDb = resolverEscaneoBalanzaEnCatalogo(
      db,
      comercioId,
      etiquetaBalanzaPeso
    );
    expect(resueltoEnDb.encontrado).toBe(true);
    expect(resueltoEnDb.producto?.id).toBe(prodQuesoBalanzaId);
    expect(resueltoEnDb.cantidadDetectada).toBe(1.25);
    expect('costo_compra' in (resueltoEnDb.producto ?? {})).toBe(false);
  });
});
