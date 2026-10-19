import { describe, expect, it } from 'vitest';
import {
  hashearClaveArgon2id,
  validarPoliticaClave,
  validarPoliticaPin,
  verificarClaveArgon2id,
} from '../../domain/claves.ts';
import {
  abrirSesionCaja,
  anularVenta,
  auditarExportacionInforme,
  autenticarUsuarioOffline,
  cambiarClavePropia,
  cambiarUsuarioConPin,
  cerrarSesionCaja,
  configurarPinUsuario,
  consultarRegistrosAuditoria,
  crearBaseDatos,
  crearProducto,
  crearUsuario,
  inicializarComercioYSuperadmin,
  listarUsuariosComercio,
  obtenerSesionCajaAbierta,
  registrarLogoutUsuario,
  registrarMovimientoManualCaja,
  registrarVenta,
  resetearClaveUsuario,
  verificarAutorizadorEnVivo,
  verificarIntegridadAuditoriaDb,
  type ActorContexto,
} from '../index.ts';

// Parámetros livianos de Argon2id para que los tests corran en pocos milisegundos manteniendo el algoritmo real
const ARGON_TEST_OPTS = { m: 1024, t: 1, p: 1 } as const;

describe('Tarea 2 — Usuarios, Autenticación Argon2id, Auditoría y Caja (PLAN.md §6.1, §6.5, §13)', () => {
  function crearEntornoConClavesReales() {
    const db = crearBaseDatos(':memory:');
    const hashAdmin = hashearClaveArgon2id('AdminClave2026!', ARGON_TEST_OPTS);

    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Ferretería San Martín',
      cuit: '20-12345678-6',
      condicionIva: 'responsable_inscripto',
      nombreAdmin: 'María Superadmin',
      usuarioAdmin: 'maria',
      claveHashAdmin: hashAdmin,
      deviceId: 'caja-principal',
    });

    const actorSuperadmin: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'María Superadmin',
      rol: 'superadmin',
      device_id: 'caja-principal',
    };

    const encargadoId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Carlos Encargado',
      usuario: 'carlos',
      claveHash: hashearClaveArgon2id('Encargado2026!', ARGON_TEST_OPTS),
      rol: 'encargado',
    });

    const cajeroId = crearUsuario(db, actorSuperadmin, {
      nombre: 'Lucas Cajero',
      usuario: 'lucas',
      claveHash: hashearClaveArgon2id('CajeroTemporal1', ARGON_TEST_OPTS),
      rol: 'cajero',
    });

    const actorEncargado: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: encargadoId,
      usuario_nombre: 'Carlos Encargado',
      rol: 'encargado',
      device_id: 'caja-principal',
    };

    const actorCajero: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: cajeroId,
      usuario_nombre: 'Lucas Cajero',
      rol: 'cajero',
      device_id: 'caja-principal',
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

  it('hashea y verifica claves con Argon2id real y valida políticas de clave y PIN (Regla 16)', () => {
    const hash = hashearClaveArgon2id('MiClaveSegura123', ARGON_TEST_OPTS);
    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(verificarClaveArgon2id('MiClaveSegura123', hash)).toBe(true);
    expect(verificarClaveArgon2id('OtraClave999', hash)).toBe(false);

    expect(() => validarPoliticaClave('corta')).toThrow(/CLAVE_DEBIL/);
    expect(() => validarPoliticaPin('12a4')).toThrow(/PIN_INVALIDO/);
    expect(() => validarPoliticaPin('1234')).not.toThrow();
  });

  it('autentica offline con Argon2id, audita cada intento fallido y bloquea tras 5 fallos (§6.1)', () => {
    const { db, comercioId, actorSuperadmin } = crearEntornoConClavesReales();

    // 1. Login exitoso
    const sesion = autenticarUsuarioOffline(db, {
      comercioId,
      usuario: 'carlos',
      clave: 'Encargado2026!',
      deviceId: 'caja-principal',
    });
    expect(sesion.usuario.usuario).toBe('carlos');
    expect(sesion.usuario.rol).toBe('encargado');

    // 2. Cinco intentos fallidos consecutivos para 'lucas' -> bloqueo temporal
    const instanteBase = new Date('2026-10-19T14:00:00.000Z');
    for (let i = 1; i <= 4; i++) {
      expect(() =>
        autenticarUsuarioOffline(db, {
          comercioId,
          usuario: 'lucas',
          clave: 'ClaveErronea',
          deviceId: 'caja-principal',
          ahora: instanteBase,
        })
      ).toThrow(/CREDENTIALES_INVALIDAS/);
    }

    // El 5to intento fallido dispara el bloqueo temporal
    expect(() =>
      autenticarUsuarioOffline(db, {
        comercioId,
        usuario: 'lucas',
        clave: 'ClaveErronea',
        deviceId: 'caja-principal',
        ahora: instanteBase,
      })
    ).toThrow(/USUARIO_BLOQUEADO/);

    // Incluso con la clave correcta, mientras dure el bloqueo no puede entrar
    expect(() =>
      autenticarUsuarioOffline(db, {
        comercioId,
        usuario: 'lucas',
        clave: 'CajeroTemporal1',
        deviceId: 'caja-principal',
        ahora: new Date('2026-10-19T14:05:00.000Z'), // 5 minutos después (< 15 min)
      })
    ).toThrow(/USUARIO_BLOQUEADO/);

    // Pasados los 15 minutos de bloqueo, puede iniciar sesión con la clave correcta
    const sesionDesbloqueada = autenticarUsuarioOffline(db, {
      comercioId,
      usuario: 'lucas',
      clave: 'CajeroTemporal1',
      deviceId: 'caja-principal',
      ahora: new Date('2026-10-19T14:16:00.000Z'),
    });
    expect(sesionDesbloqueada.usuario.intentos_fallidos).toBe(0);

    // Todos los intentos fallidos quedaron registrados en la auditoría y la cadena es íntegra
    const fallidos = consultarRegistrosAuditoria(db, actorSuperadmin, {
      accion: 'login_fallido',
    });
    expect(fallidos.length).toBe(6); // 5 de clave errónea + 1 intento durante bloqueo
    expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);
  });

  it('permite cambio de clave propia, reseteo con clave temporal, PIN rápido y autorización en vivo (§6.1 y §13)', () => {
    const {
      db,
      comercioId,
      cajeroId,
      actorSuperadmin,
      actorEncargado,
      actorCajero,
    } = crearEntornoConClavesReales();

    // 1. El cajero cambia su clave temporal por una definitiva
    cambiarClavePropia(db, actorCajero, {
      claveActual: 'CajeroTemporal1',
      claveNueva: 'LucasDefinitiva99',
      opcionesArgon: ARGON_TEST_OPTS,
    });

    const loginNuevo = autenticarUsuarioOffline(db, {
      comercioId,
      usuario: 'lucas',
      clave: 'LucasDefinitiva99',
      deviceId: 'caja-principal',
    });
    expect(loginNuevo.usuario.debe_cambiar_clave).toBe(false);

    // 2. El cajero configura su PIN rápido y cambia de usuario con PIN
    configurarPinUsuario(db, actorCajero, {
      claveActual: 'LucasDefinitiva99',
      pinNuevo: '4826',
      opcionesArgon: ARGON_TEST_OPTS,
    });

    const cambioPin = cambiarUsuarioConPin(db, {
      comercioId,
      usuario: 'lucas',
      pin: '4826',
      deviceId: 'caja-principal',
    });
    expect(cambioPin.usuario.id).toBe(cajeroId);

    // 3. Autorización en vivo: un encargado autoriza con su clave real la anulación de una venta del cajero
    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Destornillador Phillips',
      costoCompraCentavos: 250000,
      precioVentaCentavos: 420000,
      stockInicial: 10,
    });

    const { ventaId } = registrarVenta(db, actorCajero, {
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: 420000 }],
    });

    // Otro cajero NO puede autorizar la anulación
    expect(() =>
      verificarAutorizadorEnVivo(db, {
        comercioId,
        usuarioAutorizador: 'lucas',
        claveAutorizador: 'LucasDefinitiva99',
        deviceId: 'caja-principal',
      })
    ).toThrow(/PERMISO_DENEGADO/);

    // El encargado autoriza con sus credenciales reales
    const autorizadorVerificado = verificarAutorizadorEnVivo(db, {
      comercioId,
      usuarioAutorizador: 'carlos',
      claveAutorizador: 'Encargado2026!',
      deviceId: 'caja-principal',
    });

    anularVenta(db, actorCajero, {
      ventaId,
      motivo: 'Error de cobro',
      autorizador: autorizadorVerificado,
    });

    // 4. Superadmin resetea la clave del cajero -> genera clave temporal y debe_cambiar_clave = true
    const { claveTemporal } = resetearClaveUsuario(db, actorSuperadmin, {
      usuarioObjetivoId: cajeroId,
      opcionesArgon: ARGON_TEST_OPTS,
    });
    expect(claveTemporal.length).toBeGreaterThanOrEqual(8);

    const loginConTemporal = autenticarUsuarioOffline(db, {
      comercioId,
      usuario: 'lucas',
      clave: claveTemporal,
      deviceId: 'caja-principal',
    });
    expect(loginConTemporal.usuario.debe_cambiar_clave).toBe(true);

    registrarLogoutUsuario(db, actorCajero);

    // 5. Ni cajero ni encargado pueden consultar la auditoría ni listar usuarios
    expect(() => consultarRegistrosAuditoria(db, actorCajero)).toThrow(
      /PERMISO_DENEGADO/
    );
    expect(() => consultarRegistrosAuditoria(db, actorEncargado)).toThrow(
      /PERMISO_DENEGADO/
    );
    expect(() => listarUsuariosComercio(db, actorEncargado)).toThrow(
      /PERMISO_DENEGADO/
    );

    const usuariosLista = listarUsuariosComercio(db, actorSuperadmin);
    expect(usuariosLista).toHaveLength(3);
    expect('clave_hash' in (usuariosLista[0] ?? {})).toBe(false);

    // Auditar exportación de informe
    auditarExportacionInforme(db, actorSuperadmin, {
      nombreInforme: 'auditoria_general',
      formato: 'xlsx',
    });

    // Verificar que ningún registro de auditoría contiene claves ni hashes y la cadena es íntegra
    const todosRegistros = consultarRegistrosAuditoria(db, actorSuperadmin);
    const jsonCompleto = JSON.stringify(todosRegistros);
    expect(jsonCompleto).not.toContain('$argon2id$');
    expect(jsonCompleto).not.toContain('LucasDefinitiva99');
    expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);
  });

  it('abre caja, registra ingresos/egresos manuales, excluye ventas anuladas y cierra caja con arqueo exacto (§6.5 y §13)', () => {
    const { db, comercioId, actorEncargado, actorCajero } =
      crearEntornoConClavesReales();

    const prodId = crearProducto(db, actorEncargado, {
      nombre: 'Cinta Métrica 5m',
      costoCompraCentavos: 300000,
      precioVentaCentavos: 500000, // $ 5.000,00
      stockInicial: 20,
    });

    // 1. El cajero abre su sesión de caja con $ 10.000,00 (1.000.000 centavos)
    const sesionId = abrirSesionCaja(db, actorCajero, {
      montoInicialCentavos: 1000000,
      observaciones: 'Apertura turno mañana',
    });

    // No puede abrir otra caja mientras tenga una abierta
    expect(() =>
      abrirSesionCaja(db, actorCajero, {
        montoInicialCentavos: 500000,
      })
    ).toThrow(/CAJA_YA_ABIERTA/);

    expect(
      obtenerSesionCajaAbierta(db, comercioId, actorCajero.usuario_id)?.id
    ).toBe(sesionId);

    // 2. Venta 1 (completada): 2 unidades = $ 10.000,00 ($ 6.000,00 efectivo + $ 4.000,00 Mercado Pago)
    registrarVenta(db, actorCajero, {
      cajaSesionId: sesionId,
      items: [{ productoId: prodId, cantidad: 2 }],
      pagos: [
        { medio: 'efectivo', monto: 600000 },
        { medio: 'mercado_pago', monto: 400000 },
      ],
    });

    // 3. Venta 2 (luego anulada): 1 unidad = $ 5.000,00 en efectivo -> NO debe sumar al arqueo final
    const { ventaId: ventaAnuladaId } = registrarVenta(db, actorCajero, {
      cajaSesionId: sesionId,
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: 500000 }],
    });
    anularVenta(db, actorCajero, {
      ventaId: ventaAnuladaId,
      motivo: 'Cobro duplicado',
      autorizador: {
        usuario_id: actorEncargado.usuario_id,
        usuario_nombre: actorEncargado.usuario_nombre,
        rol: actorEncargado.rol,
      },
    });

    // 4. Movimientos manuales: egreso de $ 1.500,00 (150.000 centavos) e ingreso de $ 500,00 (50.000 centavos)
    registrarMovimientoManualCaja(db, actorCajero, {
      cajaSesionId: sesionId,
      tipo: 'egreso',
      concepto: 'Compra artículos limpieza',
      montoCentavos: 150000,
    });
    registrarMovimientoManualCaja(db, actorCajero, {
      cajaSesionId: sesionId,
      tipo: 'ingreso',
      concepto: 'Refuerzo de cambio chico',
      montoCentavos: 50000,
    });

    // Efectivo esperado: 1.000.000 (inicial) + 600.000 (venta 1) - 150.000 (egreso) + 50.000 (ingreso) = 1.500.000 ($ 15.000,00)
    // Si cuenta $ 14.900,00 (1.490.000 centavos), la diferencia es -10.000 (-$ 100,00)
    const cierre = cerrarSesionCaja(db, actorCajero, {
      cajaSesionId: sesionId,
      efectivoContadoCentavos: 1490000,
      observaciones: 'Cierre turno mañana',
    });

    expect(cierre.efectivoEsperado).toBe(1500000);
    expect(cierre.efectivoContado).toBe(1490000);
    expect(cierre.diferenciaEfectivo).toBe(-10000);
    expect(cierre.totalesPorMedio.efectivo).toBe(600000);
    expect(cierre.totalesPorMedio.mercado_pago).toBe(400000);

    // No se puede volver a cerrar ni agregar movimientos a una caja cerrada
    expect(() =>
      cerrarSesionCaja(db, actorCajero, {
        cajaSesionId: sesionId,
        efectivoContadoCentavos: 1500000,
      })
    ).toThrow(/CAJA_YA_CERRADA/);

    expect(() =>
      registrarMovimientoManualCaja(db, actorCajero, {
        cajaSesionId: sesionId,
        tipo: 'egreso',
        concepto: 'Retiro tardío',
        montoCentavos: 10000,
      })
    ).toThrow(/CAJA_CERRADA/);

    expect(verificarIntegridadAuditoriaDb(db, comercioId).integra).toBe(true);
  });
});
