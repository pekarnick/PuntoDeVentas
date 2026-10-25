import { describe, expect, it } from 'vitest';
import {
  generarQrSvgUrlPublica,
  validarUrlPublicaVentaMovil,
} from '../../domain/index.ts';
import { hashearClaveArgon2id } from '../../domain/claves.ts';
import { aCentavos } from '../../domain/dinero.ts';
import { generarUuidV7 } from '../../domain/uuid.ts';
import { crearCliente } from '../gestion_fase3_repo.ts';
import {
  abrirCajaMovilUsuario,
  actualizarPermisoVentaMovilUsuario,
  cerrarCajaMovilUsuario,
  configurarVentaMovilComercio,
  consultarRegistrosAuditoria,
  crearBaseDatos,
  crearProducto,
  crearUsuario,
  crearVentaMovilServidor,
  iniciarSesionMovil,
  inicializarComercioYSuperadmin,
  listarVentasPropiasDelDiaMovil,
  obtenerCatalogoVentaMovil,
  obtenerConfigVentaMovil,
  obtenerEstadoCajaMovilUsuario,
  obtenerInformeGestionFase1,
  obtenerStockProducto,
  revocarSesionMovil,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../index.ts';

const ARGON_TEST_OPTS = { m: 1024, t: 1, p: 1 } as const;

describe('Fase 3b — Venta Móvil Web (/web-pos, PLAN.md §6.2, §10 y §14)', () => {
  function crearEntornoFase3b() {
    const db = crearBaseDatos(':memory:');
    const hashAdmin = hashearClaveArgon2id('AdminClave2026!', ARGON_TEST_OPTS);

    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Kiosco y Librería Belgrano',
      cuit: '30-71234567-9',
      condicionIva: 'monotributo',
      nombreAdmin: 'María Superadmin',
      usuarioAdmin: 'maria',
      claveHashAdmin: hashAdmin,
      deviceId: 'pc-central-01',
    });

    const actorSuperadmin: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'María Superadmin',
      rol: 'superadmin',
      device_id: 'pc-central-01',
    };

    const cajeroConMovilId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Lucas Vendedor Móvil',
      usuario: 'lucas',
      claveHash: hashearClaveArgon2id('VendedorMovil1!', ARGON_TEST_OPTS),
      rol: 'cajero',
      puedeVenderMovil: true,
    });

    const cajeroSinMovilId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Pedro Solo Escritorio',
      usuario: 'pedro',
      claveHash: hashearClaveArgon2id('SoloEscritorio1!', ARGON_TEST_OPTS),
      rol: 'cajero',
      puedeVenderMovil: false,
    });

    const prodAlfajorId = crearProducto(db, actorSuperadmin, {
      nombre: 'Alfajor Triple Dulce de Leche',
      codigoInterno: 'ALF-001',
      codigosBarras: ['7790001112223'],
      unidad: 'unidad',
      precioVentaCentavos: aCentavos(150000), // $ 1.500,00
      costoCompraCentavos: aCentavos(85000), // $ 850,00 (Secreta para cajero y venta móvil — Regla 20)
      alicuotaIva: 21,
      stockInicial: 40,
      stockMinimo: 5,
    });

    const prodCuadernoId = crearProducto(db, actorSuperadmin, {
      nombre: 'Cuaderno Tapa Dura 84 Hojas',
      codigoInterno: 'LIB-102',
      codigosBarras: ['7790009998887'],
      unidad: 'unidad',
      precioVentaCentavos: aCentavos(420000), // $ 4.200,00
      costoCompraCentavos: aCentavos(230000), // $ 2.300,00
      alicuotaIva: 21,
      stockInicial: 15,
      stockMinimo: 3,
    });

    return {
      db,
      comercioId,
      superadminId,
      actorSuperadmin,
      cajeroConMovilId,
      cajeroSinMovilId,
      prodAlfajorId,
      prodCuadernoId,
    };
  }

  it('1. Regla 19: Valida que el QR contenga únicamente la URL pública (HTTPS o localhost) y rechaza tokens o claves en la URL', () => {
    const urlValida = validarUrlPublicaVentaMovil(
      'https://mi-comercio.pos.ar/web-pos'
    );
    expect(urlValida).toBe('https://mi-comercio.pos.ar/web-pos');

    const urlLocalValida = validarUrlPublicaVentaMovil(
      'http://localhost:1420/web-pos/'
    );
    expect(urlLocalValida).toBe('http://localhost:1420/web-pos/');

    const qr = generarQrSvgUrlPublica(urlValida, 240);
    expect(qr.urlValidada).toBe(urlValida);
    expect(qr.svg).toContain('<svg');
    expect(qr.svg).toContain('viewBox=');
    expect(qr.matriz.length).toBeGreaterThanOrEqual(21);

    // Rechazar HTTP en dominios públicos
    expect(() =>
      validarUrlPublicaVentaMovil('http://mi-comercio.pos.ar/web-pos')
    ).toThrow(/HTTPS/i);

    // Rechazar credenciales embebidas en la URL
    expect(() =>
      validarUrlPublicaVentaMovil('https://admin:secreto@mi-comercio.pos.ar/web-pos')
    ).toThrow(/Regla 19/i);

    // Rechazar tokens o claves en query params
    expect(() =>
      validarUrlPublicaVentaMovil(
        'https://mi-comercio.pos.ar/web-pos?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
      )
    ).toThrow(/Regla 19/i);

    expect(() =>
      validarUrlPublicaVentaMovil(
        'https://mi-comercio.pos.ar/web-pos?service_role=secret'
      )
    ).toThrow(/Regla 19/i);
  });

  it('2. Configuración de Venta Móvil, permisos puede_vender_movil y bloqueo si el canal no está habilitado', () => {
    const {
      db,
      comercioId,
      actorSuperadmin,
      cajeroConMovilId,
      cajeroSinMovilId,
    } = crearEntornoFase3b();

    // Por defecto la venta móvil viene deshabilitada
    const configInicial = obtenerConfigVentaMovil(db, comercioId);
    expect(configInicial.venta_movil_habilitada).toBe(false);

    // Intentar iniciar sesión móvil con el canal apagado debe fallar
    expect(() =>
      iniciarSesionMovil(db, {
        comercioId,
        usuario: 'lucas',
        clave: 'VendedorMovil1!',
        dispositivoId: 'celular-lucas-01',
      })
    ).toThrow(/VENTA_MOVIL_DESHABILITADA/);

    // El superadmin activa la Venta Móvil desde Configuración -> Venta Móvil
    const configActiva = configurarVentaMovilComercio(db, {
      actor: actorSuperadmin,
      habilitada: true,
      urlPublica: 'https://belgrano.pos.ar/web-pos',
    });

    expect(configActiva.venta_movil_habilitada).toBe(true);
    expect(configActiva.venta_movil_url).toBe('https://belgrano.pos.ar/web-pos');
    expect(configActiva.qr_svg).toContain('<svg');

    // Un cajero sin permiso `puede_vender_movil` NO puede iniciar sesión en /web-pos
    expect(() =>
      iniciarSesionMovil(db, {
        comercioId,
        usuario: 'pedro',
        clave: 'SoloEscritorio1!',
        dispositivoId: 'celular-pedro-01',
      })
    ).toThrow(/PERMISO_DENEGADO/);

    // El superadmin habilita `puede_vender_movil` a Pedro y luego puede iniciar sesión
    actualizarPermisoVentaMovilUsuario(db, {
      actor: actorSuperadmin,
      usuarioObjetivoId: cajeroSinMovilId,
      puedeVenderMovil: true,
    });

    const sesionPedro = iniciarSesionMovil(db, {
      comercioId,
      usuario: 'pedro',
      clave: 'SoloEscritorio1!',
      dispositivoId: 'celular-pedro-01',
      dispositivoNombre: 'Motorola G54 Pedro',
    });
    expect(sesionPedro.usuario.id).toBe(cajeroSinMovilId);

    // También Lucas (que nació con puede_vender_movil = true) inicia sesión
    const sesionLucas = iniciarSesionMovil(db, {
      comercioId,
      usuario: 'lucas',
      clave: 'VendedorMovil1!',
      dispositivoId: 'celular-lucas-01',
      dispositivoNombre: 'Samsung A34 Mostrador',
    });
    expect(sesionLucas.usuario.id).toBe(cajeroConMovilId);

    const estadoFinal = obtenerConfigVentaMovil(db, comercioId);
    expect(estadoFinal.sesiones.length).toBe(2);
  });

  it('3. Regla 20 + crear_venta_movil: Catálogo sin costo_compra, recálculo de precios en servidor, descuento de stock, canal="web" e idempotencia por UUID', () => {
    const {
      db,
      comercioId,
      actorSuperadmin,
      cajeroConMovilId,
      prodAlfajorId,
      prodCuadernoId,
    } = crearEntornoFase3b();

    configurarVentaMovilComercio(db, {
      actor: actorSuperadmin,
      habilitada: true,
      urlPublica: 'https://belgrano.pos.ar/web-pos',
    });

    const sesion = iniciarSesionMovil(db, {
      comercioId,
      usuario: 'lucas',
      clave: 'VendedorMovil1!',
      dispositivoId: 'celular-lucas-01',
      dispositivoNombre: 'Samsung A34 Mostrador',
    });

    // 1. Verificar que el catálogo móvil viene de vista_productos_venta y NUNCA expone costo_compra (Regla 20)
    const catalogo = obtenerCatalogoVentaMovil(db, comercioId);
    expect(catalogo.length).toBe(2);
    for (const prod of catalogo) {
      expect('costo_compra' in prod).toBe(false);
      expect(JSON.stringify(prod)).not.toContain('costo_compra');
      expect(JSON.stringify(prod)).not.toContain('85000');
      expect(JSON.stringify(prod)).not.toContain('230000');
    }

    // 2. Abrir caja móvil para Lucas
    const cajaAbierta = abrirCajaMovilUsuario(db, {
      comercioId,
      usuarioId: cajeroConMovilId,
      dispositivoId: 'celular-lucas-01',
      montoInicialCentavos: 1000000, // $ 10.000,00
    });
    expect(cajaAbierta.sesion?.estado).toBe('abierta');

    // 3. Crear cliente para asociar a la venta móvil
    const clienteId = crearCliente(db, actorSuperadmin, {
      nombre: 'Escuela Primaria Nº 12',
      cuitDni: '30-71234567-1',
      condicionIva: 'exento',
      domicilio: 'Av. Belgrano 450',
      telefono: '1144556677',
      email: 'escuela12@edu.ar',
      limiteCreditoCentavos: aCentavos(5000000), // $ 50.000,00
    });

    // 4. Registrar venta desde el celular con UUID generado en el cliente e intentando inyectar un precio falso (Regla de seguridad §6.2)
    const ventaUuidCelular = generarUuidV7();
    // 2 alfajores ($ 1.500 c/u = $ 3.000) + 1 cuaderno ($ 4.200) = $ 7.200 (720000 centavos)
    // Descuento global $ 200 (20000 centavos) => Total oficial = $ 7.000 (700000 centavos)
    const itemConPrecioManipulado = {
      producto_id: prodAlfajorId,
      cantidad: 2,
      precio_unitario: 100, // Intento malicioso de pagar $ 1,00 que el servidor debe ignorar
    };

    const resultado1 = crearVentaMovilServidor(db, {
      ventaId: ventaUuidCelular,
      comercioId,
      usuarioId: cajeroConMovilId,
      dispositivoId: 'celular-lucas-01',
      sesionMovilId: sesion.sesion_id,
      items: [
        itemConPrecioManipulado,
        { producto_id: prodCuadernoId, cantidad: 1 },
      ],
      descuentoGlobal: 20000,
      clienteId,
      cajaSesionId: cajaAbierta.sesion?.id ?? null,
      pagos: [
        { medio: 'efectivo', monto: 400000 }, // $ 4.000,00
        { medio: 'mercado_pago', monto: 300000 }, // $ 3.000,00
      ],
    });

    expect(resultado1.idempotente).toBe(false);
    expect(resultado1.venta_id).toBe(ventaUuidCelular);
    expect(resultado1.canal).toBe('web');
    // El servidor ignoró el precio falso de 100 y usó 150000 ($ 1.500,00)
    expect(resultado1.subtotal).toBe(720000);
    expect(resultado1.descuento).toBe(20000);
    expect(resultado1.total).toBe(700000);
    expect(resultado1.whatsapp_url).toContain('https://wa.me/?text=');
    // Regla 20: La respuesta y el comprobante WhatsApp no contienen costos
    expect(JSON.stringify(resultado1)).not.toContain('costo_compra');
    expect(JSON.stringify(resultado1)).not.toContain('costo_unitario');

    // 5. Verificar descuento de stock en movimientos_stock (40 - 2 = 38; 15 - 1 = 14)
    expect(obtenerStockProducto(db, comercioId, prodAlfajorId)).toBe(38);
    expect(obtenerStockProducto(db, comercioId, prodCuadernoId)).toBe(14);

    // 6. Idempotencia: reintentar la MISMA venta con el mismo UUID (p. ej. microcorte de señal) NO duplica venta ni stock
    const resultadoIdempotente = crearVentaMovilServidor(db, {
      ventaId: ventaUuidCelular,
      comercioId,
      usuarioId: cajeroConMovilId,
      dispositivoId: 'celular-lucas-01',
      sesionMovilId: sesion.sesion_id,
      items: [
        { producto_id: prodAlfajorId, cantidad: 2 },
        { producto_id: prodCuadernoId, cantidad: 1 },
      ],
      descuentoGlobal: 20000,
      clienteId,
      cajaSesionId: cajaAbierta.sesion?.id ?? null,
      pagos: [
        { medio: 'efectivo', monto: 400000 },
        { medio: 'mercado_pago', monto: 300000 },
      ],
    });

    expect(resultadoIdempotente.idempotente).toBe(true);
    expect(resultadoIdempotente.venta_id).toBe(ventaUuidCelular);
    expect(resultadoIdempotente.total).toBe(700000);
    // El stock sigue exactamente en 38 y 14 (no volvió a descontar)
    expect(obtenerStockProducto(db, comercioId, prodAlfajorId)).toBe(38);
    expect(obtenerStockProducto(db, comercioId, prodCuadernoId)).toBe(14);

    // 7. Verificar que la venta aparece en los informes centrales y en la caja móvil
    const informe = obtenerInformeGestionFase1(db, actorSuperadmin);
    expect(informe.balancePeriodo.ventasNetasCentavos).toBe(700000);

    const ventasPropias = listarVentasPropiasDelDiaMovil(
      db,
      comercioId,
      cajeroConMovilId
    );
    expect(ventasPropias.length).toBe(1);
    expect(ventasPropias[0]?.id).toBe(ventaUuidCelular);
    expect(ventasPropias[0]?.canal).toBe('web');

    // 8. Cerrar la caja móvil y verificar arqueo ($ 10.000 inicial + $ 4.000 efectivo = $ 14.000 esperado)
    const cierreCaja = cerrarCajaMovilUsuario(db, {
      comercioId,
      usuarioId: cajeroConMovilId,
      dispositivoId: 'celular-lucas-01',
      efectivoContadoCentavos: 1400000,
      observaciones: 'Cierre turno móvil sin diferencias',
    });
    expect(cierreCaja.efectivo_esperado).toBe(1400000);
    expect(cierreCaja.diferencia).toBe(0);
    expect(cierreCaja.totales_por_medio.efectivo).toBe(400000);
    expect(cierreCaja.totales_por_medio.mercado_pago).toBe(300000);

    const estadoPostCierre = obtenerEstadoCajaMovilUsuario(
      db,
      comercioId,
      cajeroConMovilId
    );
    expect(estadoPostCierre.sesion).toBeNull();
  });

  it('4. Revocación inmediata de sesión móvil y expiración por inactividad bloquean nuevas ventas y auditan en cadena SHA-256', () => {
    const {
      db,
      comercioId,
      actorSuperadmin,
      cajeroConMovilId,
      prodAlfajorId,
    } = crearEntornoFase3b();

    configurarVentaMovilComercio(db, {
      actor: actorSuperadmin,
      habilitada: true,
      urlPublica: 'https://belgrano.pos.ar/web-pos',
    });

    const sesion = iniciarSesionMovil(db, {
      comercioId,
      usuario: 'lucas',
      clave: 'VendedorMovil1!',
      dispositivoId: 'celular-lucas-01',
      dispositivoNombre: 'Celular Mostrador 1',
    });

    // El superadmin revoca la sesión desde Configuración -> Venta Móvil
    revocarSesionMovil(db, {
      actor: actorSuperadmin,
      sesionId: sesion.sesion_id,
      motivo: 'Fin de turno del vendedor',
    });

    // El celular intenta registrar una venta con la sesión revocada y es rechazado inmediatamente
    expect(() =>
      crearVentaMovilServidor(db, {
        ventaId: generarUuidV7(),
        comercioId,
        usuarioId: cajeroConMovilId,
        dispositivoId: 'celular-lucas-01',
        sesionMovilId: sesion.sesion_id,
        items: [{ producto_id: prodAlfajorId, cantidad: 1 }],
        pagos: [{ medio: 'efectivo', monto: 150000 }],
      })
    ).toThrow(/SESION_REVOCADA/);

    // Probar expiración por inactividad: sesión creada con duracionMinutos = -5 (ya vencida)
    const sesionCorta = iniciarSesionMovil(db, {
      comercioId,
      usuario: 'lucas',
      clave: 'VendedorMovil1!',
      dispositivoId: 'celular-lucas-02',
      duracionMinutos: -5,
    });

    expect(() =>
      crearVentaMovilServidor(db, {
        ventaId: generarUuidV7(),
        comercioId,
        usuarioId: cajeroConMovilId,
        dispositivoId: 'celular-lucas-02',
        sesionMovilId: sesionCorta.sesion_id,
        items: [{ producto_id: prodAlfajorId, cantidad: 1 }],
        pagos: [{ medio: 'efectivo', monto: 150000 }],
      })
    ).toThrow(/SESION_EXPIRADA/);

    // Verificar que toda la cadena de auditoría SHA-256 sigue íntegra y contiene los eventos móviles
    const integridad = verificarIntegridadAuditoriaDb(db, comercioId);
    expect(integridad.integra).toBe(true);

    const eventosAuditoria = consultarRegistrosAuditoria(db, actorSuperadmin);
    const accionesRegistradas = new Set(eventosAuditoria.map((e) => e.accion));
    expect(accionesRegistradas.has('activar_venta_movil')).toBe(true);
    expect(accionesRegistradas.has('login_movil_exitoso')).toBe(true);
    expect(accionesRegistradas.has('revocar_sesion_movil')).toBe(true);
  });
});
