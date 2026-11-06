import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { inspeccionarEntradasXlsx } from '../../domain/index.ts';
import {
  crearCategoria,
  crearMarca,
  crearProveedor,
} from '../gestion_fase3_repo.ts';
import {
  abrirSesionCaja,
  actualizarProductoYPrecio,
  anularVenta,
  consultarRegistrosAuditoria,
  crearBaseDatos,
  crearProducto,
  crearUsuario,
  exportarAuditoriaAXlsx,
  exportarInformeGestionFase1AXlsx,
  exportarPedidoReposicionBajoStockAPdf,
  inicializarComercioYSuperadmin,
  obtenerInformeGestionFase1,
  registrarMovimientoManualCaja,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../index.ts';
import { PanelComprasProveedores } from '../../features/compras/PanelComprasProveedores.tsx';
import { PanelInformes } from '../../features/informes/PanelInformes.tsx';

describe('Tarea 4 — Informes de Fase 1, Ganancia Histórica, Stock Valorizado y Exportación a Excel .xlsx (PLAN.md §7, §10, §13)', () => {
  function prepararEscenarioInformes() {
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Ferretería y Pinturería Mitre',
      cuit: '20-12345678-6',
      condicionIva: 'responsable_inscripto',
      nombreAdmin: 'María Superadmin',
      usuarioAdmin: 'maria',
      claveHashAdmin: '$argon2id$v=19$m=1024,t=1,p=1$hash',
      deviceId: 'caja-central',
    });

    const actorSuperadmin: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'María Superadmin',
      rol: 'superadmin',
      device_id: 'caja-central',
    };

    const encargadoId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Carlos Encargado',
      usuario: 'carlos',
      claveHash: '$argon2id$v=19$m=1024,t=1,p=1$hash',
      rol: 'encargado',
    });

    const cajeroId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Lucas Cajero',
      usuario: 'lucas',
      claveHash: '$argon2id$v=19$m=1024,t=1,p=1$hash',
      rol: 'cajero',
    });

    const actorEncargado: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: encargadoId,
      usuario_nombre: 'Carlos Encargado',
      rol: 'encargado',
      device_id: 'caja-central',
    };

    const actorCajero: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: cajeroId,
      usuario_nombre: 'Lucas Cajero',
      rol: 'cajero',
      device_id: 'caja-central',
    };

    return {
      db,
      comercioId,
      actorSuperadmin,
      actorEncargado,
      actorCajero,
    };
  }

  it('calcula la ganancia bruta histórica usando costo_unitario copiado en cada venta y valoriza el stock actual (§7 y §13)', () => {
    const { db, actorEncargado, actorCajero } = prepararEscenarioInformes();

    // 1. Crear producto con costo = $ 1.000,00 (100.000 centavos) y precio = $ 1.800,00 (180.000 centavos), stock inicial = 10
    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Lija al Agua Nº 180',
      costoCompraCentavos: 100000,
      precioVentaCentavos: 180000,
      stockMinimo: 8,
      stockInicial: 10,
    });

    const sesionCajaId = abrirSesionCaja(db, actorCajero, {
      montoInicialCentavos: 500000,
    });

    // 2. Venta 1 (con el primer costo de $ 1.000,00): 2 unidades -> Venta = $ 3.600,00 (360.000), Costo histórico = $ 2.000,00 (200.000)
    registrarVenta(db, actorCajero, {
      cajaSesionId: sesionCajaId,
      items: [{ productoId: prodId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 360000 }],
    });

    // 3. Subir el costo a $ 1.400,00 (140.000 centavos) y el precio a $ 2.200,00 (220.000 centavos)
    actualizarProductoYPrecio(db, actorEncargado, {
      productoId: prodId,
      costoCompraCentavos: 140000,
      precioVentaCentavos: 220000,
      motivo: 'Aumento lista proveedor',
    });

    // 4. Venta 2 (con el nuevo costo de $ 1.400,00): 1 unidad -> Venta = $ 2.200,00 (220.000), Costo histórico = $ 1.400,00 (140.000)
    registrarVenta(db, actorCajero, {
      cajaSesionId: sesionCajaId,
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'mercado_pago', monto: 220000 }],
    });

    // 5. Venta 3 anulada (no debe sumar ni a ventas completadas ni a ganancia)
    const { ventaId: anuladaId } = registrarVenta(db, actorCajero, {
      cajaSesionId: sesionCajaId,
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: 220000 }],
    });
    anularVenta(db, actorCajero, {
      ventaId: anuladaId,
      motivo: 'Error de tipeo',
      autorizador: {
        usuario_id: actorEncargado.usuario_id,
        usuario_nombre: actorEncargado.usuario_nombre,
        rol: actorEncargado.rol,
      },
    });

    // 6. Egreso manual de caja de $ 300,00 (30.000 centavos)
    registrarMovimientoManualCaja(db, actorCajero, {
      cajaSesionId: sesionCajaId,
      tipo: 'egreso',
      concepto: 'Envío cadetería',
      montoCentavos: 30000,
    });

    // El cajero NO puede consultar informes de gestión (Reglas 11 y 20)
    expect(() => obtenerInformeGestionFase1(db, actorCajero)).toThrow(
      /PERMISO_DENEGADO/
    );

    const informe = obtenerInformeGestionFase1(db, actorEncargado);

    // Ventas totales completadas: 360.000 + 220.000 = 580.000 ($ 5.800,00)
    expect(informe.rentabilidad.ventasTotalesCentavos).toBe(580000);
    // Costo histórico total (CMV): 200.000 + 140.000 = 340.000 ($ 3.400,00)
    expect(informe.rentabilidad.costoMercaderiaVendidaCentavos).toBe(340000);
    // Ganancia bruta histórica: 580.000 - 340.000 = 240.000 ($ 2.400,00)
    expect(informe.rentabilidad.gananciaBrutaTotalCentavos).toBe(240000);

    // Stock actual restante: 10 - 2 - 1 = 7 unidades (bajo el mínimo de 8)
    expect(informe.stockValorizado.items[0]?.stock_actual).toBe(7);
    expect(informe.stockValorizado.items[0]?.bajo_stock_minimo).toBe(true);
    // Stock valorizado a costo vigente (7 * 140.000 = 980.000) y a venta vigente (7 * 220.000 = 1.540.000)
    expect(informe.stockValorizado.totalValorizadoCostoCentavos).toBe(980000);
    expect(informe.stockValorizado.totalValorizadoVentaCentavos).toBe(1540000);

    // Balance simple del período: ganancia bruta (240.000) - egresos caja (30.000) = 210.000
    expect(informe.balancePeriodo.resultadoNetoOperativoCentavos).toBe(210000);

    // Ventas por usuario: 2 completadas y 1 anulada para Lucas Cajero
    expect(informe.ventasPorUsuario[0]?.ventas_completadas).toBe(2);
    expect(informe.ventasPorUsuario[0]?.ventas_anuladas).toBe(1);
  });

  it('exporta los informes de Fase 1 y la auditoría a archivos Excel (.xlsx OpenXML) válidos y audita cada exportación (§6.1, §7, §13)', () => {
    const { db, comercioId, actorSuperadmin, actorEncargado, actorCajero } =
      prepararEscenarioInformes();

    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Rodillo Lana 22cm',
      costoCompraCentavos: 350000,
      precioVentaCentavos: 600000,
      stockInicial: 12,
    });

    registrarVenta(db, actorCajero, {
      items: [{ productoId: prodId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 1200000 }],
    });

    // El cajero no puede exportar informes
    expect(() => exportarInformeGestionFase1AXlsx(db, actorCajero)).toThrow(
      /PERMISO_DENEGADO/
    );

    // El encargado exporta los informes de Fase 1 a .xlsx
    const { xlsxBytes } = exportarInformeGestionFase1AXlsx(db, actorEncargado);

    // Verificar firma ZIP PK\x03\x04 de OpenXML (.xlsx)
    expect(xlsxBytes[0]).toBe(0x50); // 'P'
    expect(xlsxBytes[1]).toBe(0x4b); // 'K'
    expect(xlsxBytes[2]).toBe(0x03);
    expect(xlsxBytes[3]).toBe(0x04);

    const entradas = inspeccionarEntradasXlsx(xlsxBytes);
    expect(entradas['xl/workbook.xml']).toContain('Balance del Periodo');
    expect(entradas['xl/workbook.xml']).toContain('Ganancia y Ranking');
    expect(entradas['xl/workbook.xml']).toContain('Stock Valorizado');
    expect(entradas['xl/workbook.xml']).toContain('Ventas por Usuario y Medio');
    expect(entradas['xl/worksheets/sheet2.xml']).toContain('Rodillo Lana 22cm');
    expect(entradas['xl/worksheets/sheet2.xml']).toContain('$ 12.000,00');

    // Solo el superadmin puede exportar la auditoría a .xlsx
    expect(() => exportarAuditoriaAXlsx(db, actorEncargado)).toThrow(
      /PERMISO_DENEGADO/
    );

    const auditoriaXlsx = exportarAuditoriaAXlsx(db, actorSuperadmin);
    const entradasAud = inspeccionarEntradasXlsx(auditoriaXlsx);
    expect(entradasAud['xl/workbook.xml']).toContain('Auditoria SHA256');
    expect(entradasAud['xl/worksheets/sheet1.xml']).toContain(
      'informe_exportar'
    );

    // Verificar que ambas exportaciones quedaron registradas en la tabla auditoria y la cadena sigue íntegra
    const registrosExportacion = consultarRegistrosAuditoria(
      db,
      actorSuperadmin,
      {
        accion: 'informe_exportar',
      }
    );
    expect(registrosExportacion.length).toBe(2);
    expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);
  });

  it('calcula todas las métricas clave de docs/manual/08_informes_y_fiscal.md (Margen sobre costo/venta, Ticket Promedio, Ganancia Proyectada) y renderiza PanelInformes completo', () => {
    const { db, actorEncargado, actorCajero } = prepararEscenarioInformes();

    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Pintura Látex Interior 20L',
      costoCompraCentavos: 2000000, // $ 20.000,00
      precioVentaCentavos: 3000000, // $ 30.000,00
      stockMinimo: 2,
      stockInicial: 5,
    });

    registrarVenta(db, actorCajero, {
      items: [{ productoId: prodId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 6000000 }],
    });

    const informe = obtenerInformeGestionFase1(db, actorEncargado);

    // Métricas clave del período (§1 de 08_informes_y_fiscal.md)
    expect(informe.metricasClave.totalVentasCentavos).toBe(6000000);
    expect(informe.metricasClave.costoHistoricoTotalCentavos).toBe(4000000);
    expect(informe.metricasClave.gananciaBrutaCentavos).toBe(2000000);
    // Margen sobre costo: (20.000 / 40.000) * 100 = 50%
    expect(informe.metricasClave.margenSobreCostoPorcentaje).toBe(50);
    // Margen sobre venta: (20.000 / 60.000) * 100 = 33.33%
    expect(informe.metricasClave.margenRentabilidadVentaPorcentaje).toBe(33.33);
    expect(informe.metricasClave.cantidadOperaciones).toBe(1);
    expect(informe.metricasClave.ticketPromedioCentavos).toBe(6000000);

    // Stock valorizado (§3 de 08_informes_y_fiscal.md): quedan 3 unidades
    // Costo reposición: 3 * $20.000 = $60.000 (6.000.000 centavos)
    // Precio venta: 3 * $30.000 = $90.000 (9.000.000 centavos)
    // Ganancia proyectada: $90.000 - $60.000 = $30.000 (3.000.000 centavos)
    expect(informe.stockValorizado.totalValorizadoCostoCentavos).toBe(6000000);
    expect(informe.stockValorizado.totalValorizadoVentaCentavos).toBe(9000000);
    expect(informe.stockValorizado.gananciaProyectadaTotalCentavos).toBe(
      3000000
    );

    const htmlInformes = renderToStaticMarkup(
      React.createElement(PanelInformes, {
        rolActivo: 'superadmin',
        informeInicial: informe,
      })
    );

    expect(htmlInformes).toContain(
      '1. Informes de Gestión en Tiempo Real (Superadmin y Encargado)'
    );
    expect(htmlInformes).toContain('Total de Ventas ($)');
    expect(htmlInformes).toContain('Ganancia Bruta Real ($)');
    expect(htmlInformes).toContain('Margen de Rentabilidad (%)');
    expect(htmlInformes).toContain('Cantidad de Operaciones');
    expect(htmlInformes).toContain('Ticket Promedio');
    expect(htmlInformes).toContain('Desglose de Medios de Pago');
    expect(htmlInformes).toContain('Ganancia Proyectada');
    expect(htmlInformes).toContain(
      '4. Libro IVA Ventas y Libro IVA Compras (Excel Oficial)'
    );
  });

  it('arma automáticamente listas de pedido de productos con stock bajo por proveedor, por marca y por categoría y exporta el PDF auditado', () => {
    const { db, comercioId, actorSuperadmin, actorEncargado, actorCajero } =
      prepararEscenarioInformes();

    const provNorteId = crearProveedor(db, actorEncargado, {
      razonSocial: 'Distribuidora Norte S.A.',
      cuit: '30-71234567-1',
    });
    const provSurId = crearProveedor(db, actorEncargado, {
      razonSocial: 'Mayorista Ferretero Sur',
    });

    const marcaStanleyId = crearMarca(db, actorEncargado, {
      nombre: 'Stanley',
    });
    const marcaAlbaId = crearMarca(db, actorEncargado, {
      nombre: 'Alba',
    });

    const catHerramientasId = crearCategoria(db, actorEncargado, {
      nombre: 'Herramientas Manuales',
    });
    const catPinturasId = crearCategoria(db, actorEncargado, {
      nombre: 'Pinturería',
    });

    // Producto 1: Bajo stock (stock actual 2 <= mínimo 6)
    crearProducto(db, actorEncargado, {
      nombre: 'Destornillador Phillips PH2',
      codigoInterno: 'DES-002',
      proveedorId: provNorteId,
      marcaId: marcaStanleyId,
      categoriaId: catHerramientasId,
      costoCompraCentavos: 450000,
      precioVentaCentavos: 790000,
      stockMinimo: 6,
      stockInicial: 2,
    });

    // Producto 2: Bajo stock en el límite (stock actual 4 <= mínimo 4)
    crearProducto(db, actorEncargado, {
      nombre: 'Esmalte Sintético Blanco 4L',
      codigoInterno: 'ESM-004',
      proveedorId: provSurId,
      marcaId: marcaAlbaId,
      categoriaId: catPinturasId,
      costoCompraCentavos: 1800000,
      precioVentaCentavos: 2900000,
      stockMinimo: 4,
      stockInicial: 4,
    });

    // Producto 3: Stock holgado (stock actual 20 > mínimo 5) -> NO debe entrar al pedido
    crearProducto(db, actorEncargado, {
      nombre: 'Cinta Enmascarar 24mm',
      codigoInterno: 'CIN-024',
      proveedorId: provNorteId,
      marcaId: marcaAlbaId,
      categoriaId: catPinturasId,
      costoCompraCentavos: 150000,
      precioVentaCentavos: 280000,
      stockMinimo: 5,
      stockInicial: 20,
    });

    // El cajero NO puede exportar pedidos con costos a PDF (Regla 20)
    expect(() =>
      exportarPedidoReposicionBajoStockAPdf(db, actorCajero, {
        criterio: 'proveedor',
      })
    ).toThrow(/PERMISO_DENEGADO/);

    // 1. Exportar PDF agrupado por Proveedor
    const pdfPorProveedor = exportarPedidoReposicionBajoStockAPdf(
      db,
      actorEncargado,
      {
        criterio: 'proveedor',
      }
    );
    expect(pdfPorProveedor.resumen.total_productos_bajo_stock).toBe(2);
    expect(pdfPorProveedor.resumen.total_grupos).toBe(2);
    const cabeceraPdfProv = new TextDecoder('latin1').decode(
      pdfPorProveedor.pdfBytes.subarray(0, 8)
    );
    expect(cabeceraPdfProv).toBe('%PDF-1.4');
    const textoPdfProv = new TextDecoder('latin1').decode(
      pdfPorProveedor.pdfBytes
    );
    expect(textoPdfProv).toContain('Distribuidora Norte S.A.');
    expect(textoPdfProv).toContain('Mayorista Ferretero Sur');
    expect(textoPdfProv).toContain('Destornillador Phillips PH2');

    // 2. Exportar PDF agrupado por Marca
    const pdfPorMarca = exportarPedidoReposicionBajoStockAPdf(
      db,
      actorEncargado,
      {
        criterio: 'marca',
      }
    );
    expect(pdfPorMarca.resumen.total_grupos).toBe(2);
    expect(
      pdfPorMarca.resumen.grupos.map((g) => g.grupo_nombre)
    ).toEqual(['Alba', 'Stanley']);

    // 3. Exportar PDF agrupado por Categoría (filtrado solo por Herramientas Manuales)
    const pdfPorCategoria = exportarPedidoReposicionBajoStockAPdf(
      db,
      actorEncargado,
      {
        criterio: 'categoria',
        filtroGrupoId: catHerramientasId,
      }
    );
    expect(pdfPorCategoria.resumen.total_grupos).toBe(1);
    expect(pdfPorCategoria.resumen.grupos[0]?.grupo_nombre).toBe(
      'Herramientas Manuales'
    );
    expect(pdfPorCategoria.resumen.total_productos_bajo_stock).toBe(1);

    // Verificar que las 3 exportaciones a PDF quedaron auditadas con SHA-256 íntegro
    const auditoriasPdf = consultarRegistrosAuditoria(db, actorSuperadmin, {
      accion: 'informe_exportar',
    });
    expect(auditoriasPdf.length).toBe(3);
    expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);

    // Verificar renderizado en PanelComprasProveedores
    const htmlCompras = renderToStaticMarkup(
      React.createElement(PanelComprasProveedores, {
        rolActivo: 'encargado',
        catalogoProductos: [
          {
            id: 'prod-1',
            nombre: 'Destornillador Phillips PH2',
            codigo_interno: 'DES-002',
            codigos_barras: [],
            unidad: 'unidad',
            permite_decimales: false,
            costo_compra: 450000,
            precio_venta: 790000,
            stock_minimo: 6,
            stock_actual: 2,
            boton_rapido: false,
            imagen_path: null,
            imagen_hash: null,
            proveedor_id: provNorteId,
            proveedor_nombre: 'Distribuidora Norte S.A.',
            marca_id: marcaStanleyId,
            marca_nombre: 'Stanley',
            categoria_id: catHerramientasId,
            categoria_nombre: 'Herramientas Manuales',
          },
        ],
      })
    );
    expect(htmlCompras).toContain(
      'Lista Automática de Productos con Stock Bajo (Pedidos de Reposición)'
    );
    expect(htmlCompras).toContain('Por Proveedor');
    expect(htmlCompras).toContain('Por Marca');
    expect(htmlCompras).toContain('Por Categoría');
    expect(htmlCompras).toContain('Exportar PDF');
    expect(htmlCompras).toContain('Distribuidora Norte S.A.');
  });
});
