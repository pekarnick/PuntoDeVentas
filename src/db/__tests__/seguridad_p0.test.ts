import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ARGON2_M_MAX,
  ARGON2_P_MAX,
  ARGON2_T_MAX,
  hashearClaveArgon2id,
  verificarClaveArgon2id,
} from '../../domain/claves.ts';
import {
  AdaptadorArcaHomologacionLocal,
  MAX_REINTENTOS_ARCA,
  emitirComprobanteArcaVenta,
  guardarConfiguracionArca,
  reintentarComprobantesArcaPendientes,
} from '../arca_fase4_repo.ts';
import { crearBaseDatos } from '../migrator.ts';
import {
  crearProducto,
  inicializarComercioYSuperadmin,
  registrarVenta,
  type ActorContexto,
} from '../repositorios.ts';
import {
  ejecutarAccionPosLocal,
  limpiarSesionesLocalesParaTest,
} from '../servidor_local_dev.ts';
import {
  REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS,
  deserializarFirestoreDocumentARegistro,
  serializarRegistroAFirestoreFields,
} from '../../sync/adaptador_firebase.ts';
import { serializarRegistroParaPostgres } from '../../sync/motor_sync.ts';
import { procesarSolicitudEmisionArcaEdge } from '../../../supabase/functions/emitir_comprobante_arca/index.ts';

const ARGON_TEST_OPTS = { m: 1024, t: 1, p: 1 } as const;

describe('Auditoría de Seguridad — Lote P0', () => {
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-p0-test-'));
  const rutaDbTmp = path.join(dirTmp, 'pos_p0.db');

  afterAll(() => {
    limpiarSesionesLocalesParaTest();
    try {
      fs.rmSync(dirTmp, { recursive: true, force: true });
    } catch {
      // Ignorar si Windows mantiene handle abierto al cerrar Vitest
    }
  });

  it('1. Argon2id rechaza parámetros PHC fuera de rango y claves > 256 bytes', () => {
    const hashValido = hashearClaveArgon2id('ClaveSegura2026!', ARGON_TEST_OPTS);
    expect(verificarClaveArgon2id('ClaveSegura2026!', hashValido)).toBe(true);

    const claveLarga = 'A'.repeat(260);
    expect(verificarClaveArgon2id(claveLarga, hashValido)).toBe(false);

    const hashMemExcesiva = `$argon2id$v=19$m=${ARGON2_M_MAX + 1},t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g`;
    expect(verificarClaveArgon2id('ClaveSegura2026!', hashMemExcesiva)).toBe(false);

    const hashTExcesivo = `$argon2id$v=19$m=16384,t=${ARGON2_T_MAX + 1},p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g`;
    expect(verificarClaveArgon2id('ClaveSegura2026!', hashTExcesivo)).toBe(false);

    const hashPExcesivo = `$argon2id$v=19$m=16384,t=2,p=${ARGON2_P_MAX + 1}$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g`;
    expect(verificarClaveArgon2id('ClaveSegura2026!', hashPExcesivo)).toBe(false);
  });

  it('2. Servidor local exige Asistente de Primer Uso, rechaza llamadas sin sessionToken y aplica RBAC + autorización en vivo', () => {
    limpiarSesionesLocalesParaTest();

    // Base vacía requiere configuración inicial (sin credenciales hardcodeadas)
    const arranqueInicial = ejecutarAccionPosLocal(
      'obtener_estado_arranque',
      {},
      rutaDbTmp
    ) as { requiereConfiguracionInicial: boolean };
    expect(arranqueInicial.requiereConfiguracionInicial).toBe(true);

    // Rechaza acciones de escritorio sin sessionToken
    expect(() =>
      ejecutarAccionPosLocal('obtener_estado_inicial', {}, rutaDbTmp)
    ).toThrow(/SESION_NO_AUTENTICADA/);

    // Inicializar primer superadmin
    const resInit = ejecutarAccionPosLocal(
      'inicializar_primer_superadmin',
      {
        nombreComercio: 'Comercio Seguro P0',
        cuit: '20-12345678-6',
        condicionIva: 'monotributo',
        nombreAdmin: 'Dueña Admin',
        usuarioAdmin: 'duena',
        claveAdmin: 'MiClaveAdmin2026!',
      },
      rutaDbTmp
    ) as { sessionToken: string; operadorActual: { id: string; rol: string } };

    expect(resInit.sessionToken).toBeTruthy();
    expect(resInit.operadorActual.rol).toBe('superadmin');

    // No permite reinicializar si ya existe superadmin
    expect(() =>
      ejecutarAccionPosLocal(
        'inicializar_primer_superadmin',
        {
          nombreComercio: 'Otro',
          nombreAdmin: 'Atacante',
          usuarioAdmin: 'atacante',
          claveAdmin: 'Atacante1234!',
        },
        rutaDbTmp
      )
    ).toThrow(/SISTEMA_YA_INICIALIZADO/);

    // Rechaza login sin contraseña (usuarioId solo)
    expect(() =>
      ejecutarAccionPosLocal(
        'iniciar_sesion_operador',
        { usuarioId: resInit.operadorActual.id },
        rutaDbTmp
      )
    ).toThrow(/Ingresá tu usuario y contraseña/);

    // Superadmin crea un cajero con clave conocida
    const resCajero = ejecutarAccionPosLocal(
      'crear_usuario',
      {
        nombre: 'Cajero Prueba',
        usuario: 'cajerop0',
        claveNueva: 'ClaveCajero2026!',
        rol: 'cajero',
      },
      rutaDbTmp,
      { sessionToken: resInit.sessionToken }
    ) as { id: string };

    // Habilitar venta móvil y permiso al cajero para probar revocación al cambiar clave
    ejecutarAccionPosLocal(
      'configurar_venta_movil',
      { habilitada: true, urlPublica: 'https://pos-movil.ejemplo.com/web-pos' },
      rutaDbTmp,
      { sessionToken: resInit.sessionToken }
    );
    ejecutarAccionPosLocal(
      'actualizar_permiso_venta_movil',
      { usuarioObjetivoId: resCajero.id, puedeVenderMovil: true },
      rutaDbTmp,
      { sessionToken: resInit.sessionToken }
    );

    const loginMovilCajero = ejecutarAccionPosLocal(
      'login_movil',
      {
        usuario: 'cajerop0',
        clave: 'ClaveCajero2026!',
        dispositivoId: 'cel-p0-1',
      },
      rutaDbTmp
    ) as { sesion_id: string };
    expect(loginMovilCajero.sesion_id).toBeTruthy();

    // Acciones móviles rechazan llamadas sin sesionMovilId
    expect(() =>
      ejecutarAccionPosLocal('obtener_catalogo_movil', {}, rutaDbTmp)
    ).toThrow(/SESION_INVALIDA/);
    expect(() =>
      ejecutarAccionPosLocal('estado_caja_movil', {}, rutaDbTmp)
    ).toThrow(/SESION_INVALIDA/);

    // Login como cajero en escritorio
    const loginCajero = ejecutarAccionPosLocal(
      'iniciar_sesion_operador',
      { usuario: 'cajerop0', clave: 'ClaveCajero2026!' },
      rutaDbTmp
    ) as { sessionToken: string };

    // RBAC en handlers protegidos para cajero
    for (const accionRestringida of [
      'obtener_configuracion_netlify',
      'obtener_config_venta_movil',
      'verificar_integridad_auditoria',
    ]) {
      expect(() =>
        ejecutarAccionPosLocal(
          accionRestringida,
          {},
          rutaDbTmp,
          { sessionToken: loginCajero.sessionToken }
        )
      ).toThrow(/PERMISO_DENEGADO/);
    }

    expect(() =>
      ejecutarAccionPosLocal(
        'listar_movimientos_cc',
        { entidadTipo: 'proveedor', entidadId: '00000000-0000-0000-0000-000000000001' },
        rutaDbTmp,
        { sessionToken: loginCajero.sessionToken }
      )
    ).toThrow(/PERMISO_DENEGADO/);

    // Producto + venta para probar anulación por cajero con autorización en vivo
    const prod = ejecutarAccionPosLocal(
      'crear_producto',
      {
        nombre: 'Lapicera Azul',
        costoCompraCentavos: 5000,
        precioVentaCentavos: 10000,
        stockInicial: 10,
      },
      rutaDbTmp,
      { sessionToken: resInit.sessionToken }
    ) as { productoId: string };

    const venta = ejecutarAccionPosLocal(
      'registrar_venta',
      {
        items: [{ productoId: prod.productoId, cantidad: 1 }],
        pagos: [{ medio: 'efectivo', monto: 10000 }],
      },
      rutaDbTmp,
      { sessionToken: loginCajero.sessionToken }
    ) as { ventaId: string };

    // Cajero no puede anular sin clave de autorizador o con clave incorrecta
    expect(() =>
      ejecutarAccionPosLocal(
        'anular_venta',
        {
          ventaId: venta.ventaId,
          motivo: 'Error',
          autorizadorUsuario: 'duena',
          autorizadorClave: 'ClaveIncorrecta!',
        },
        rutaDbTmp,
        { sessionToken: loginCajero.sessionToken }
      )
    ).toThrow(/CREDENTIALES_INVALIDAS/);

    // Cajero sí puede anular con clave válida de superadmin
    const resAnular = ejecutarAccionPosLocal(
      'anular_venta',
      {
        ventaId: venta.ventaId,
        motivo: 'Error de cobro',
        autorizadorUsuario: 'duena',
        autorizadorClave: 'MiClaveAdmin2026!',
      },
      rutaDbTmp,
      { sessionToken: loginCajero.sessionToken }
    ) as { ok: boolean };
    expect(resAnular.ok).toBe(true);

    // Cambiar clave propia exige claveActual correcta
    expect(() =>
      ejecutarAccionPosLocal(
        'cambiar_clave_usuario',
        {
          usuarioObjetivoId: resCajero.id,
          claveActual: 'ClaveMala!',
          claveNueva: 'NuevaClaveCajero2026!',
        },
        rutaDbTmp,
        { sessionToken: loginCajero.sessionToken }
      )
    ).toThrow(/CLAVE_ACTUAL_INCORRECTA/);

    ejecutarAccionPosLocal(
      'cambiar_clave_usuario',
      {
        usuarioObjetivoId: resCajero.id,
        claveActual: 'ClaveCajero2026!',
        claveNueva: 'NuevaClaveCajero2026!',
      },
      rutaDbTmp,
      { sessionToken: loginCajero.sessionToken }
    );

    // La sesión móvil previa del cajero debe haber quedado revocada automáticamente
    expect(() =>
      ejecutarAccionPosLocal(
        'obtener_catalogo_movil',
        { sesionMovilId: loginMovilCajero.sesion_id },
        rutaDbTmp
      )
    ).toThrow(/SESION_REVOCADA/);
  });

  it('3. Edge Function ARCA rechaza producción sin credenciales o con simulador_homologacion, y repo respeta backoff', async () => {
    const resSim = await procesarSolicitudEmisionArcaEdge(
      {
        venta_id: '01950000-0000-7000-8000-000000000001',
        comercio_id: '01950000-0000-7000-8000-000000000002',
        cuit_emisor: '20111111112',
        condicion_iva_emisor: 'responsable_inscripto',
        punto_venta: 1,
        tipo_comprobante: 'factura_b',
        numero_comprobante: 1,
        ambiente: 'produccion',
        proveedor: 'simulador_homologacion',
        total_centavos: 10000,
        neto_centavos: 8264,
        iva_centavos: 1736,
        receptor_tipo_doc: 99,
        receptor_nro_doc: 0,
      },
      () => undefined
    );
    expect(resSim.ok).toBe(false);
    expect(resSim.cae).toBe('');
    expect(resSim.error).toMatch(/ARCA_PROVEEDOR_INVALIDO/);

    const resSinSecretos = await procesarSolicitudEmisionArcaEdge(
      {
        venta_id: '01950000-0000-7000-8000-000000000001',
        comercio_id: '01950000-0000-7000-8000-000000000002',
        cuit_emisor: '20111111112',
        condicion_iva_emisor: 'responsable_inscripto',
        punto_venta: 1,
        tipo_comprobante: 'factura_b',
        numero_comprobante: 1,
        ambiente: 'produccion',
        proveedor: 'afip_sdk',
        total_centavos: 10000,
        neto_centavos: 8264,
        iva_centavos: 1736,
        receptor_tipo_doc: 99,
        receptor_nro_doc: 0,
      },
      () => undefined
    );
    expect(resSinSecretos.ok).toBe(false);
    expect(resSinSecretos.cae).toBe('');

    // Verificar tope de reintentos y backoff en SQLite
    const db = crearBaseDatos(':memory:');
    const { comercioId, superadminId } = inicializarComercioYSuperadmin(db, {
      nombreComercio: 'Test ARCA Backoff',
      cuit: '20-11111111-2',
      condicionIva: 'responsable_inscripto',
      nombreAdmin: 'Admin',
      usuarioAdmin: 'admin',
      claveHashAdmin: hashearClaveArgon2id('AdminClave2026!', ARGON_TEST_OPTS),
      deviceId: 'term-arca',
    });
    const actor: ActorContexto = {
      comercio_id: comercioId,
      usuario_id: superadminId,
      usuario_nombre: 'Admin',
      rol: 'superadmin',
      device_id: 'term-arca',
    };
    guardarConfiguracionArca(db, actor, {
      arcaHabilitada: true,
      cuit: '20-11111111-2',
      condicionIva: 'responsable_inscripto',
      puntoVenta: 1,
      ambiente: 'homologacion',
      proveedor: 'simulador_homologacion',
    });
    const prodId = crearProducto(db, actor, {
      nombre: 'Prod ARCA',
      costoCompraCentavos: 1000,
      precioVentaCentavos: 2000,
      stockInicial: 10,
    });
    const v = registrarVenta(db, actor, {
      items: [{ productoId: prodId, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: 2000 }],
    });

    const adaptadorOffline = new AdaptadorArcaHomologacionLocal();
    adaptadorOffline.fijarConectado(false);

    for (let i = 0; i < MAX_REINTENTOS_ARCA; i++) {
      await emitirComprobanteArcaVenta(db, actor, v.ventaId, adaptadorOffline);
    }

    const adaptadorOnline = new AdaptadorArcaHomologacionLocal();
    const resReintento = await reintentarComprobantesArcaPendientes(
      db,
      actor,
      adaptadorOnline,
      { respetarBackoff: true }
    );
    expect(resReintento.procesados).toBe(0);
  });

  it('4. Sync y reglas cloud nunca filtran clave_hash/pin_hash ni permiten acceso anónimo', () => {
    const regUsuario = {
      id: '01950000-0000-7000-8000-000000000010',
      comercio_id: '01950000-0000-7000-8000-000000000002',
      nombre: 'User',
      usuario: 'user',
      clave_hash: '$argon2id$secreto',
      pin_hash: '$argon2id$pinsecreto',
      rol: 'cajero',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
      device_id: 'term-1',
    };

    const pg = serializarRegistroParaPostgres('usuarios', regUsuario);
    expect(pg.clave_hash).toBeUndefined();
    expect(pg.pin_hash).toBeUndefined();

    const fsFields = serializarRegistroAFirestoreFields(regUsuario);
    expect(fsFields.clave_hash).toBeUndefined();
    expect(fsFields.pin_hash).toBeUndefined();

    // deserializarFirestoreDocumentARegistro rechaza subcolecciones sin comercio_id o con comercio_id distinto
    const docSinComercio = {
      fields: {
        id: { stringValue: '01950000-0000-7000-8000-000000000099' },
        updated_at: { stringValue: '2026-01-01T00:00:00.000Z' },
      },
    };
    expect(
      deserializarFirestoreDocumentARegistro(
        docSinComercio,
        '01950000-0000-7000-8000-000000000002',
        false
      )
    ).toBeNull();

    expect(REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS).toContain('request.auth != null');
    expect(REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS).not.toContain('comercioId.size() >= 20');

    // Verificación estática de artefactos de seguridad P0
    const archivosCriticos = [
      'supabase/migrations/005_endurecimiento_seguridad_rls.sql',
      'supabase/esquema_completo_unificado.sql',
      'firestore.rules',
      'storage.rules',
      'supabase/config.toml',
    ];
    for (const rel of archivosCriticos) {
      const abs = path.resolve(process.cwd(), rel);
      expect(fs.existsSync(abs)).toBe(true);
      const contenido = fs.readFileSync(abs, 'utf-8');
      expect(contenido).not.toMatch(/CREATE\s+POLICY[\s\S]{0,200}\bTO\s+anon\b/i);
      expect(contenido).not.toMatch(/GRANT\s+[\s\S]{0,200}\bTO\s+anon\b/i);
      expect(contenido).not.toContain('x-rol-usuario');
      expect(contenido).not.toContain('comercioId.size() >= 20');
    }
  });
});
