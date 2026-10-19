import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  actualizarCantidadEnCarrito,
  agregarProductoAlCarrito,
  calcularResumenCarritoPOS,
  detectarEscaneoRafaga,
  filtrarSugerenciasCatalogoPOS,
  formatearTicketNoFiscalTexto,
  resolverAtajoTecladoPOS,
  sanitizarProductoCatalogoParaPOS,
} from '../../domain/index.ts';
import { ejecutarAccionPosLocal } from '../servidor_local_dev.ts';
import { PanelProductosStock } from '../../features/productos/PanelProductosStock.tsx';
import { PanelVentaPOS } from '../../features/venta/PanelVentaPOS.tsx';
import {
  actualizarProductoYPrecio,
  agregarCodigoBarrasProducto,
  buscarProductoPorCodigoParaVenta,
  buscarProductosParaMostrador,
  crearBaseDatos,
  crearProducto,
  crearUsuario,
  eliminarProductoLogico,
  guardarImagenProductoLocal,
  inicializarComercioYSuperadmin,
  MAX_BYTES_WEBP_MINIATURA,
  MAX_BYTES_WEBP_PRINCIPAL,
  obtenerDatosTicketDeVentaDb,
  obtenerStockProducto,
  procesarImagenProducto,
  registrarVenta,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../index.ts';

describe('Tarea 3 — Imágenes WebP sin EXIF, Escáner, Venta por Teclado y Regla 20 de Costos (PLAN.md §5.1, §9, §13)', () => {
  function prepararBase() {
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Librería y Kiosco Belgrano',
      cuit: '20-12345678-6',
      condicionIva: 'monotributo',
      nombreAdmin: 'María Superadmin',
      usuarioAdmin: 'maria',
      claveHashAdmin: '$argon2id$v=19$m=1024,t=1,p=1$hash',
      deviceId: 'caja-1',
    });

    const actorSuperadmin: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'María Superadmin',
      rol: 'superadmin',
      device_id: 'caja-1',
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
      device_id: 'caja-1',
    };

    const actorCajero: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: cajeroId,
      usuario_nombre: 'Lucas Cajero',
      rol: 'cajero',
      device_id: 'caja-1',
    };

    return {
      db,
      comercioId,
      actorSuperadmin,
      actorEncargado,
      actorCajero,
    };
  }

  it('procesa una imagen grande con orientación EXIF y metadatos, corrigiendo orientación, eliminando EXIF y comprimiendo a WebP <= 150 KB (PLAN.md §5.1)', async () => {
    const { db, comercioId, actorEncargado } = prepararBase();

    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Termo Acero Inoxidable 1L',
      costoCompraCentavos: 1800000,
      precioVentaCentavos: 2950000,
      codigosBarras: ['7795555000018'],
      stockInicial: 8,
    });

    // Generar una imagen grande horizontal (2400 x 1600 px) pero con EXIF Orientation = 6 (rotada 90° horario -> vertical)
    // y con metadatos EXIF de cámara/software simulando foto de celular
    const imagenGrandeConExif = await sharp({
      create: {
        width: 2400,
        height: 1600,
        channels: 3,
        background: { r: 30, g: 120, b: 210 },
      },
    })
      .withMetadata({
        orientation: 6,
        exif: {
          IFD0: {
            Make: 'SamsungCelular',
            Model: 'GalaxyTest',
            Software: 'GPS-Private-Metadata',
          },
        },
      })
      .jpeg({ quality: 95 })
      .toBuffer();

    // Verificar que el buffer de entrada efectivamente trae EXIF y orientation = 6
    const metaEntrada = await sharp(imagenGrandeConExif).metadata();
    expect(metaEntrada.orientation).toBe(6);
    expect(metaEntrada.exif).toBeDefined();

    // Guardar y procesar en carpeta temporal
    const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-img-test-'));
    try {
      const resultadoGuardado = await guardarImagenProductoLocal(
        db,
        actorEncargado,
        {
          productoId: prodId,
          entradaBuffer: imagenGrandeConExif,
          nombreArchivoOriginal: 'foto_celular.jpg',
          directorioBase: dirTemp,
        }
      );

      // 1. Tamaño final <= 150 KB y miniatura <= 25 KB
      expect(resultadoGuardado.bytesPrincipal).toBeLessThanOrEqual(
        MAX_BYTES_WEBP_PRINCIPAL
      );
      expect(resultadoGuardado.bytesMiniatura).toBeLessThanOrEqual(
        MAX_BYTES_WEBP_MINIATURA
      );
      expect(resultadoGuardado.imagenHash).toMatch(/^[0-9a-f]{64}$/);

      // 2. Verificar el archivo WebP principal en disco: orientación aplicada (queda vertical: ancho < alto, alto = 800) y SIN EXIF
      const rutaWebp = path.join(
        dirTemp,
        resultadoGuardado.imagenPathRelativo
      );
      const rutaThumb = path.join(
        dirTemp,
        resultadoGuardado.miniaturaPathRelativo
      );
      expect(fs.existsSync(rutaWebp)).toBe(true);
      expect(fs.existsSync(rutaThumb)).toBe(true);

      const metaSalida = await sharp(fs.readFileSync(rutaWebp)).metadata();
      expect(metaSalida.format).toBe('webp');
      expect(metaSalida.height).toBe(800);
      expect(metaSalida.width).toBe(533); // 1600/2400 * 800 = 533 (rotada de horizontal a vertical por EXIF 6)
      expect(metaSalida.exif).toBeUndefined();
      expect(metaSalida.orientation).toBeUndefined();

      const metaThumb = await sharp(fs.readFileSync(rutaThumb)).metadata();
      expect(metaThumb.format).toBe('webp');
      expect(metaThumb.height).toBe(200);
      expect(metaThumb.width).toBe(133);
      expect(metaThumb.exif).toBeUndefined();

      // 3. No agranda imágenes más chicas que 800 px
      const imagenChica = await sharp({
        create: {
          width: 320,
          height: 240,
          channels: 3,
          background: { r: 100, g: 200, b: 100 },
        },
      })
        .png()
        .toBuffer();

      const resChica = await procesarImagenProducto(imagenChica, 'chica.png');
      expect(resChica.anchoFinal).toBe(320);
      expect(resChica.altoFinal).toBe(240);

      // 4. Al borrar lógicamente el producto, el archivo de imagen local no se elimina (PLAN.md §5.1)
      eliminarProductoLogico(db, actorEncargado, {
        productoId: prodId,
        motivo: 'Discontinuado',
      });
      expect(fs.existsSync(rutaWebp)).toBe(true);

      // 5. Rechaza imágenes corruptas y archivos HEIC inválidos con mensajes claros
      await expect(
        procesarImagenProducto(Buffer.from('no-es-una-imagen'), 'rota.jpg')
      ).rejects.toThrow(/IMAGEN_CORRUPTA/);

      await expect(
        procesarImagenProducto(
          Buffer.from('00000018667479706865696300000000', 'hex'),
          'foto_iphone.heic'
        )
      ).rejects.toThrow(/HEIC_NO_SOPORTADO/);

      expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  it('permite cargar un producto con múltiples códigos, escanearlo y completar la venta por teclado en < 3 segundos (§9 y §13)', () => {
    const { db, comercioId, actorEncargado, actorCajero } = prepararBase();

    const inicioMs = performance.now();

    // 1. Cargar producto con código de barras y agregar un segundo código de barras
    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Gaseosa Cola 2.25L',
      codigoInterno: 'GAS-225',
      costoCompraCentavos: 190000,
      precioVentaCentavos: 310000,
      codigosBarras: ['7790895000997'],
      stockInicial: 15,
    });

    agregarCodigoBarrasProducto(db, actorEncargado, {
      productoId: prodId,
      codigo: '7790895000998',
    });

    // Actualizar precio de venta y verificar auditoría de cambio de precio
    actualizarProductoYPrecio(db, actorEncargado, {
      productoId: prodId,
      precioVentaCentavos: 330000,
      motivo: 'Actualización lista proveedor',
    });

    // 2. Simular ráfaga de lector de códigos de barras (13 dígitos a 8 ms por tecla)
    const codigoEscaneado = '7790895000998';
    const eventosTeclas = codigoEscaneado.split('').map((tecla, idx) => ({
      tecla,
      timestampMs: 1000 + idx * 8,
    }));

    const deteccion = detectarEscaneoRafaga(eventosTeclas);
    expect(deteccion.esEscaneo).toBe(true);
    expect(deteccion.codigo).toBe('7790895000998');

    // 3. Buscar producto por el código escaneado y operar el carrito con atajos de teclado sin mouse
    const encontrado = buscarProductoPorCodigoParaVenta(
      db,
      comercioId,
      deteccion.codigo
    );
    expect(encontrado).not.toBeNull();
    expect(encontrado?.precio_venta).toBe(330000);

    let carrito = agregarProductoAlCarrito(
      [],
      sanitizarProductoCatalogoParaPOS({
        id: encontrado!.id,
        nombre: encontrado!.nombre,
        codigos_barras: [deteccion.codigo],
        unidad: 'unidad',
        permite_decimales: false,
        precio_venta: encontrado!.precio_venta,
        alicuota_iva: encontrado!.alicuota_iva,
        exento_iva: encontrado!.exento_iva === 1,
      }),
      1
    );

    // Atajo Ctrl + '+' incrementa cantidad del último ítem
    expect(resolverAtajoTecladoPOS({ key: '+', ctrlKey: true })).toBe(
      'INCREMENTAR_ULTIMO_ITEM'
    );
    carrito = actualizarCantidadEnCarrito(carrito, prodId, 2);

    // Atajo F4 confirma cobro rápido
    expect(resolverAtajoTecladoPOS({ key: 'F4' })).toBe(
      'CONFIRMAR_COBRO_RAPIDO_EFECTIVO'
    );

    const resumenCarrito = calcularResumenCarritoPOS(carrito);
    expect(resumenCarrito.total).toBe(660000);

    const venta = registrarVenta(db, actorCajero, {
      items: carrito.map((it) => ({
        productoId: it.producto_id,
        cantidad: it.cantidad,
        descuentoCentavos: it.descuento,
      })),
      pagos: [{ medio: 'efectivo', monto: resumenCarrito.total }],
    });

    const duracionMs = performance.now() - inicioMs;
    expect(duracionMs).toBeLessThan(3000); // Criterio de aceptación §13: < 3 segundos
    expect(obtenerStockProducto(db, comercioId, prodId)).toBe(13);
    expect(venta.totalCentavos).toBe(660000);
  });

  it('verifica en plantillas, pantallas y tickets que jamás aparece costo_compra para el cliente ni para el cajero (Regla 20 y §13)', () => {
    const { db, comercioId, actorEncargado, actorCajero } = prepararBase();

    // Costo de compra único y distinguible: 287.654 centavos ($ 2.876,54)
    // Precio de venta: 450.000 centavos ($ 4.500,00)
    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Marcador Permanente Negro',
      costoCompraCentavos: 287654,
      precioVentaCentavos: 450000,
      codigosBarras: ['7791111222233'],
      botonRapido: false,
      stockInicial: 50,
    });

    // 1. Consulta de mostrador no contiene costo_compra
    const mostrador = buscarProductosParaMostrador(db, comercioId, {
      textoBusqueda: 'Marcador',
    });
    expect(mostrador).toHaveLength(1);
    expect(JSON.stringify(mostrador)).not.toContain('costo_compra');
    expect(JSON.stringify(mostrador)).not.toContain('287654');

    // 2. Registrar venta y generar datos y texto de ticket
    const { ventaId } = registrarVenta(db, actorCajero, {
      items: [{ productoId: prodId, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 900000 }],
    });

    const datosTicket = obtenerDatosTicketDeVentaDb(db, comercioId, ventaId);
    const textoTicket = formatearTicketNoFiscalTexto(datosTicket);

    expect(JSON.stringify(datosTicket)).not.toContain('costo');
    expect(JSON.stringify(datosTicket)).not.toContain('287654');
    expect(textoTicket).toContain('$ 4.500,00');
    expect(textoTicket).toContain('$ 9.000,00');
    expect(textoTicket).not.toContain('2.876,54');
    expect(textoTicket.toLowerCase()).not.toContain('costo');
    expect(textoTicket.toLowerCase()).not.toContain('ganancia');

    // 3. Renderizar Pantalla de Venta (PanelVentaPOS): nunca muestra costos ni siquiera si el operador es superadmin (Regla 20)
    const htmlVentaSuperadmin = renderToStaticMarkup(
      React.createElement(PanelVentaPOS, {
        rolActivo: 'superadmin',
        operadorNombre: 'María Superadmin',
      })
    );
    expect(htmlVentaSuperadmin).toContain('$ 1.500,00'); // Precio de venta del Alfajor en botón rápido
    expect(htmlVentaSuperadmin).not.toContain('850,00'); // Costo de compra del Alfajor (85000) jamás aparece
    expect(htmlVentaSuperadmin).not.toContain('2.800,00'); // Costo de compra de la Yerba (280000) jamás aparece
    expect(htmlVentaSuperadmin).not.toContain('Costo Compra');

    // 4. Renderizar PanelProductosStock:
    // - Para cajero: NO aparece la columna Costo Compra ni el importe $ 2.800,00 ni Margen
    const htmlProductosCajero = renderToStaticMarkup(
      React.createElement(PanelProductosStock, { rolActivo: 'cajero' })
    );
    expect(htmlProductosCajero).toContain('$ 4.200,00');
    expect(htmlProductosCajero).not.toContain('$ 2.800,00');
    expect(htmlProductosCajero).not.toContain('Costo Compra');

    // - Para encargado/superadmin: SÍ aparece Costo Compra ($ 2.800,00) y Margen en la administración de productos
    const htmlProductosEncargado = renderToStaticMarkup(
      React.createElement(PanelProductosStock, { rolActivo: 'encargado' })
    );
    expect(htmlProductosEncargado).toContain('Costo Compra');
    expect(htmlProductosEncargado).toContain('$ 2.800,00');
  });

  it('filtra sugerencias del desplegable por nombre o código y persiste cambios reales en archivo SQLite en disco', () => {
    const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-db-disco-'));
    const rutaDbPrueba = path.join(dirTemp, 'pos_local_test.db');

    try {
      const estadoInicial = ejecutarAccionPosLocal(
        'obtener_estado_inicial',
        { rolActivo: 'superadmin' },
        rutaDbPrueba
      ) as {
        rutaBaseDatos: string;
        catalogoVenta: Array<{
          id: string;
          nombre: string;
          codigos_barras: string[];
          unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
          permite_decimales: boolean;
          precio_venta: number;
          alicuota_iva: 0 | 10.5 | 21 | 27;
          exento_iva: boolean;
          stock_actual: number;
        }>;
      };

      expect(fs.existsSync(rutaDbPrueba)).toBe(true);
      expect(estadoInicial.catalogoVenta).toHaveLength(0);

      // Crear un producto nuevo mediante el servicio persistente y verificar que queda guardado en el archivo
      const creado = ejecutarAccionPosLocal(
        'crear_producto',
        {
          rolActivo: 'encargado',
          nombre: 'Pila Alcalina AA x2',
          codigoInterno: 'PIL-AA',
          costoCompraCentavos: 120000,
          precioVentaCentavos: 210000,
          codigosBarras: ['7798888777766'],
          stockInicial: 40,
        },
        rutaDbPrueba
      ) as { productoId: string };

      const estadoPosterior = ejecutarAccionPosLocal(
        'obtener_estado_inicial',
        { rolActivo: 'cajero' },
        rutaDbPrueba
      ) as {
        catalogoVenta: Array<{
          id: string;
          nombre: string;
          codigos_barras: string[];
          unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
          permite_decimales: boolean;
          precio_venta: number;
          alicuota_iva: 0 | 10.5 | 21 | 27;
          exento_iva: boolean;
          stock_actual: number;
        }>;
      };

      const pilaEnCatalogo = estadoPosterior.catalogoVenta.find(
        (p) => p.id === creado.productoId
      );
      expect(pilaEnCatalogo?.nombre).toBe('Pila Alcalina AA x2');
      expect(pilaEnCatalogo?.stock_actual).toBe(40);

      // Probar el filtro del desplegable de sugerencias buscando por palabras parciales del nombre
      const sugerenciasPila = filtrarSugerenciasCatalogoPOS(
        estadoPosterior.catalogoVenta,
        'pila alc'
      );
      expect(sugerenciasPila).toHaveLength(1);
      expect(sugerenciasPila[0]?.nombre).toBe('Pila Alcalina AA x2');
    } finally {
      // No borramos la conexión abierta en Windows, o ignoramos EBUSY al limpiar temp
      try {
        fs.rmSync(dirTemp, { recursive: true, force: true });
      } catch {
        // En Windows el archivo .db abierto puede seguir bloqueado hasta cerrar el proceso
      }
    }
  });
});
