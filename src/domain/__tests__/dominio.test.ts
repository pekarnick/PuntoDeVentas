import { describe, expect, it } from 'vitest';
import {
  asegurarCentavos,
  calcularArqueoCaja,
  calcularHashAuditoria,
  calcularStockActual,
  calcularTotalesVenta,
  esCuitValido,
  estaBajoStockMinimo,
  esUuidValido,
  evaluarPagosCombinados,
  formatearCuit,
  formatearFechaAR,
  formatearMonedaARS,
  generarUuidV7,
  HASH_GENESIS_AUDITORIA,
  normalizarMovimientoStock,
  pesosACentavos,
  proyectarItemParaTicket,
  proyectarProductoParaVenta,
  puedeVerCostos,
  requiereAutorizacionParaAnular,
  sanitizarValoresAuditoria,
  sumarCantidades,
  tienePermiso,
  validarPagosVenta,
  validarProteccionUltimoSuperadmin,
  verificarCadenaAuditoria,
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../index.ts';

describe('Dominio — Reglas inviolables y cálculos puros', () => {
  it('genera UUIDv7 válidos y ordenables cronológicamente (Regla 1)', () => {
    const id1 = generarUuidV7(1700000000000);
    const id2 = generarUuidV7(1700000000000);
    const id3 = generarUuidV7(1700000001000);

    expect(esUuidValido(id1)).toBe(true);
    expect(esUuidValido(id2)).toBe(true);
    expect(esUuidValido(id3)).toBe(true);
    expect(id1 < id2).toBe(true);
    expect(id2 < id3).toBe(true);
  });

  it('opera dinero siempre en centavos enteros y formatea $ 1.234,56 (Regla 2)', () => {
    expect(pesosACentavos('1.234,56')).toBe(123456);
    expect(pesosACentavos('$ 1500,50')).toBe(150050);
    expect(pesosACentavos(99.95)).toBe(9995);

    expect(formatearMonedaARS(123456)).toBe('$ 1.234,56');
    expect(formatearMonedaARS(0)).toBe('$ 0,00');
    expect(formatearMonedaARS(-50000)).toBe('-$ 500,00');

    expect(() => asegurarCentavos(12.34)).toThrow(/entero de centavos/);
  });

  it('formatea fechas UTC en zona horaria America/Argentina/Buenos_Aires dd/mm/aaaa (Regla 9)', () => {
    // 2026-10-19T01:30:00Z son las 22:30 del 18/10/2026 en Buenos Aires (UTC-3)
    expect(formatearFechaAR('2026-10-19T01:30:00.000Z')).toBe('18/10/2026');
  });

  it('suma cantidades decimales sin error de punto flotante y calcula stock desde movimientos (Regla 4)', () => {
    expect(sumarCantidades([0.1, 0.2])).toBe(0.3);

    const movimientos = [
      {
        producto_id: 'prod-1',
        tipo: 'compra' as const,
        cantidad: normalizarMovimientoStock({ tipo: 'compra', cantidad: 10 }),
      },
      {
        producto_id: 'prod-1',
        tipo: 'venta' as const,
        cantidad: normalizarMovimientoStock({ tipo: 'venta', cantidad: 2.5 }),
      },
      {
        producto_id: 'prod-1',
        tipo: 'anulacion_venta' as const,
        cantidad: normalizarMovimientoStock({
          tipo: 'anulacion_venta',
          cantidad: 1,
        }),
      },
      {
        producto_id: 'prod-1',
        tipo: 'merma' as const,
        cantidad: normalizarMovimientoStock({
          tipo: 'merma',
          cantidad: 0.5,
          motivo: 'Envase roto',
        }),
      },
      {
        producto_id: 'prod-1',
        tipo: 'ajuste' as const,
        cantidad: normalizarMovimientoStock({
          tipo: 'ajuste',
          cantidad: -1,
          motivo: 'Diferencia de inventario',
        }),
      },
    ];

    expect(calcularStockActual(movimientos)).toBe(7);
    expect(estaBajoStockMinimo(7, 10)).toBe(true);
    expect(estaBajoStockMinimo(7, 5)).toBe(false);

    expect(() =>
      normalizarMovimientoStock({ tipo: 'ajuste', cantidad: 3, motivo: '' })
    ).toThrow(/motivo obligatorio/);
  });

  it('calcula totales de venta, IVA, ganancia histórica, pagos mixtos y oculta costos al cliente (Regla 20)', () => {
    const resumen = calcularTotalesVenta(
      [
        {
          producto_id: 'p1',
          descripcion: 'Yerba Mate 1kg',
          cantidad: 2,
          precio_unitario: 350000, // $ 3.500,00
          costo_unitario: 220000, // $ 2.200,00
          descuento: 20000, // $ 200,00
          alicuota_iva: 21,
        },
        {
          producto_id: 'p2',
          descripcion: 'Pan Francés (kg)',
          cantidad: 0.5,
          precio_unitario: 200000, // $ 2.000,00 / kg -> $ 1.000,00 por 0.5kg
          costo_unitario: 120000, // $ 1.200,00 / kg -> $ 600,00 por 0.5kg
          alicuota_iva: 10.5,
        },
      ],
      30000 // $ 300,00 descuento global
    );

    // Subtotal: (2 * 350000 - 20000) + (0.5 * 200000) = 680000 + 100000 = 780000 ($ 7.800,00)
    expect(resumen.subtotal).toBe(780000);
    // Total con descuento global: 780000 - 30000 = 750000 ($ 7.500,00)
    expect(resumen.total).toBe(750000);
    // Costo total: (2 * 220000) + (0.5 * 120000) = 440000 + 60000 = 500000 ($ 5.000,00)
    expect(resumen.costo_total).toBe(500000);
    // Ganancia bruta: 750000 - 500000 = 250000 ($ 2.500,00)
    expect(resumen.ganancia_bruta).toBe(250000);

    // Pagos mixtos válidos (2 y 3+ medios de pago combinados)
    expect(() =>
      validarPagosVenta(
        [
          { medio: 'efectivo', monto: 500000 },
          { medio: 'mercado_pago', monto: 250000 },
        ],
        resumen.total
      )
    ).not.toThrow();

    const evaluacionTresMedios = evaluarPagosCombinados(
      [
        { medio: 'efectivo', monto: 300000 },
        { medio: 'transferencia', monto: 250000 },
        { medio: 'debito', monto: 200000 },
      ],
      resumen.total
    );
    expect(evaluacionTresMedios.sumaPagos).toBe(750000);
    expect(evaluacionTresMedios.coincideConTotal).toBe(true);
    expect(evaluacionTresMedios.esValidoParaCobrar).toBe(true);
    expect(evaluacionTresMedios.faltaCubrirCentavos).toBe(0);
    expect(evaluacionTresMedios.excedenteCentavos).toBe(0);

    const evaluacionFaltante = evaluarPagosCombinados(
      [
        { medio: 'efectivo', monto: 300000 },
        { medio: 'mercado_pago', monto: 200000 },
      ],
      resumen.total
    );
    expect(evaluacionFaltante.sumaPagos).toBe(500000);
    expect(evaluacionFaltante.faltaCubrirCentavos).toBe(250000);
    expect(evaluacionFaltante.esValidoParaCobrar).toBe(false);

    // Pagos mixtos que no suman el total deben fallar
    expect(() =>
      validarPagosVenta([{ medio: 'efectivo', monto: 700000 }], resumen.total)
    ).toThrow(/no coincide con el total/);

    // Regla 20: las proyecciones para venta/ticket nunca contienen costos ni ganancias
    const productoParaVenta = proyectarProductoParaVenta({
      id: 'p1',
      nombre: 'Yerba Mate 1kg',
      precio_venta: 350000,
      costo_compra: 220000,
      margen_bp: 5909,
    });
    expect('costo_compra' in productoParaVenta).toBe(false);
    expect('margen_bp' in productoParaVenta).toBe(false);

    const itemTicket = proyectarItemParaTicket(resumen.items[0]!);
    expect('costo_unitario' in itemTicket).toBe(false);
    expect('costo_total' in itemTicket).toBe(false);
    expect('ganancia_bruta' in itemTicket).toBe(false);
  });

  it('calcula arqueo de caja con desglose por medio de pago y diferencia de efectivo (§13)', () => {
    const arqueo = calcularArqueoCaja({
      montoInicial: 1000000, // $ 10.000,00
      pagosVentasCompletadas: [
        { medio: 'efectivo', monto: 500000 },
        { medio: 'mercado_pago', monto: 350000 },
        { medio: 'debito', monto: 200000 },
      ],
      movimientosManuales: [
        { tipo: 'egreso', medio: 'efectivo', monto: 100000 }, // Retiro de $ 1.000,00
      ],
      efectivoContado: 1380000, // Contó $ 13.800,00 en vez de $ 14.000,00
    });

    expect(arqueo.efectivoEsperado).toBe(1400000);
    expect(arqueo.diferenciaEfectivo).toBe(-20000); // Faltante de $ 200,00
    expect(arqueo.totalesPorMedio.mercado_pago).toBe(350000);
    expect(arqueo.totalesPorMedio.debito).toBe(200000);
  });

  it('aplica permisos por rol y protege al último superadmin activo (§6.1 y §13)', () => {
    expect(puedeVerCostos('superadmin')).toBe(true);
    expect(puedeVerCostos('encargado')).toBe(true);
    expect(puedeVerCostos('cajero')).toBe(false);

    expect(tienePermiso('cajero', 'gestionar_usuarios')).toBe(false);
    expect(tienePermiso('encargado', 'gestionar_usuarios')).toBe(false);
    expect(tienePermiso('superadmin', 'gestionar_usuarios')).toBe(true);

    expect(requiereAutorizacionParaAnular('cajero')).toBe(true);
    expect(requiereAutorizacionParaAnular('encargado')).toBe(false);

    expect(() =>
      validarProteccionUltimoSuperadmin({
        usuarioObjetivo: { id: 'u1', rol: 'superadmin', activo: true },
        nuevoRol: 'encargado',
        nuevoActivo: true,
        superadminsActivosIds: ['u1'],
      })
    ).toThrow(/ULTIMO_SUPERADMIN/);
  });

  it('sanitiza claves en auditoría y detecta adulteraciones en la cadena SHA-256 (Reglas 14 y 16)', () => {
    const limpioJson = sanitizarValoresAuditoria({
      usuario: 'juan',
      rol: 'cajero',
      clave_hash: '$argon2id$v=19$m=65536...',
      pin: '1234',
    });
    expect(limpioJson).not.toContain('argon2id');
    expect(limpioJson).not.toContain('clave_hash');
    expect(limpioJson).not.toContain('pin');

    const baseReg1 = {
      id: generarUuidV7(),
      comercio_id: 'com-1',
      fecha_hora: '2026-10-19T12:00:00.000Z',
      usuario_id: 'u-1',
      usuario_nombre: 'Admin',
      rol: 'superadmin' as const,
      device_id: 'dev-1',
      accion: 'producto_crear',
      entidad: 'productos',
      entidad_id: 'p-1',
      valores_antes: null,
      valores_despues: '{"nombre":"Gaseosa"}',
      motivo: null,
    };
    const hash1 = calcularHashAuditoria(baseReg1, HASH_GENESIS_AUDITORIA);
    const reg1 = { ...baseReg1, hash_prev: HASH_GENESIS_AUDITORIA, hash: hash1 };

    const baseReg2 = {
      ...baseReg1,
      id: generarUuidV7(),
      fecha_hora: '2026-10-19T12:05:00.000Z',
      accion: 'precio_cambiar',
      valores_despues: '{"precio_venta":250000}',
    };
    const hash2 = calcularHashAuditoria(baseReg2, reg1.hash);
    const reg2 = { ...baseReg2, hash_prev: reg1.hash, hash: hash2 };

    expect(verificarCadenaAuditoria([reg1, reg2]).integra).toBe(true);

    // Simular alteración manual de un registro
    const reg1Adulterado = {
      ...reg1,
      valores_despues: '{"nombre":"Gaseosa Adulterada"}',
    };
    const verificacion = verificarCadenaAuditoria([reg1Adulterado, reg2]);
    expect(verificacion.integra).toBe(false);
    expect(verificacion.indiceAlterado).toBe(0);
    expect(verificacion.registroAlteradoId).toBe(reg1.id);
  });

  it('valida CUIT argentino con dígito verificador módulo 11 (§8)', () => {
    expect(esCuitValido('20-12345678-6')).toBe(true);
    expect(esCuitValido('20-12345678-0')).toBe(false);
    expect(formatearCuit('20123456786')).toBe('20-12345678-6');
  });

  it('pagina listados mostrando 10 registros por página y acotando páginas fuera de rango', () => {
    expect(TAMANIO_PAGINA_POR_DEFECTO).toBe(10);
    const elementos = Array.from({ length: 25 }, (_, idx) => `item-${idx + 1}`);

    const pag1 = paginarListado(elementos, 1);
    expect(pag1.itemsPagina).toHaveLength(10);
    expect(pag1.itemsPagina[0]).toBe('item-1');
    expect(pag1.itemsPagina[9]).toBe('item-10');
    expect(pag1.paginaActual).toBe(1);
    expect(pag1.totalPaginas).toBe(3);
    expect(pag1.desdeRegistro).toBe(1);
    expect(pag1.hastaRegistro).toBe(10);
    expect(pag1.tieneAnterior).toBe(false);
    expect(pag1.tieneSiguiente).toBe(true);

    const pag3 = paginarListado(elementos, 99);
    expect(pag3.paginaActual).toBe(3);
    expect(pag3.itemsPagina).toHaveLength(5);
    expect(pag3.desdeRegistro).toBe(21);
    expect(pag3.hastaRegistro).toBe(25);
    expect(pag3.tieneAnterior).toBe(true);
    expect(pag3.tieneSiguiente).toBe(false);

    const vacia = paginarListado([], 1);
    expect(vacia.itemsPagina).toHaveLength(0);
    expect(vacia.paginaActual).toBe(1);
    expect(vacia.totalPaginas).toBe(1);
    expect(vacia.desdeRegistro).toBe(0);
    expect(vacia.hastaRegistro).toBe(0);
  });
});
