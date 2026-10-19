/**
 * Repositorio de autenticación offline (Argon2id), gestión de usuarios, roles, PIN rápido y consulta de auditoría.
 * Cumple PLAN.md §3 (reglas 11, 13, 14, 15, 16) y §6.1.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { RegistroAuditoriaCompleto } from '../domain/auditoria.ts';
import {
  calcularFechaDesbloqueo,
  estaUsuarioBloqueado,
  generarClaveTemporal,
  hashearClaveArgon2id,
  MAX_INTENTOS_FALLIDOS,
  validarPoliticaClave,
  validarPoliticaPin,
  verificarClaveArgon2id,
  type OpcionesArgon2id,
} from '../domain/claves.ts';
import {
  exigirPermiso,
  puedeAutorizarAnulacion,
  type RolUsuario,
} from '../domain/permisos.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  ejecutarEnTransaccion,
  insertarRegistroAuditoria,
  type ActorContexto,
  type AutorizadorContexto,
} from './repositorios.ts';

export interface UsuarioPublico {
  readonly id: string;
  readonly comercio_id: string;
  readonly nombre: string;
  readonly usuario: string;
  readonly rol: RolUsuario;
  readonly puede_vender_movil: boolean;
  readonly activo: boolean;
  readonly debe_cambiar_clave: boolean;
  readonly tiene_pin: boolean;
  readonly intentos_fallidos: number;
  readonly bloqueado_hasta: string | null;
  readonly ultimo_ingreso: string | null;
}

export interface FiltrosAuditoria {
  readonly usuarioId?: string;
  readonly accion?: string;
  readonly entidad?: string;
  readonly fechaDesdeIso?: string;
  readonly fechaHastaIso?: string;
  readonly limite?: number;
}

function encolarSyncUsuario(
  db: DatabaseSync,
  tabla: string,
  registroId: string,
  operacion: 'insert' | 'update',
  timestamp: string
): void {
  db.prepare(
    `INSERT INTO sync_cola (id, tabla, registro_id, operacion, timestamp, estado, intentos)
     VALUES (?, ?, ?, ?, ?, 'pendiente', 0)`
  ).run(generarUuidV7(), tabla, registroId, operacion, timestamp);
}

interface FilaUsuarioAuth {
  id: string;
  comercio_id: string;
  nombre: string;
  usuario: string;
  clave_hash: string;
  pin_hash: string | null;
  rol: RolUsuario;
  puede_vender_movil: number;
  activo: number;
  debe_cambiar_clave: number;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  ultimo_ingreso: string | null;
}

function mapearUsuarioPublico(f: FilaUsuarioAuth): UsuarioPublico {
  return {
    id: f.id,
    comercio_id: f.comercio_id,
    nombre: f.nombre,
    usuario: f.usuario,
    rol: f.rol,
    puede_vender_movil: f.puede_vender_movil === 1,
    activo: f.activo === 1,
    debe_cambiar_clave: f.debe_cambiar_clave === 1,
    tiene_pin: Boolean(f.pin_hash),
    intentos_fallidos: f.intentos_fallidos,
    bloqueado_hasta: f.bloqueado_hasta,
    ultimo_ingreso: f.ultimo_ingreso,
  };
}

/**
 * Autentica un usuario localmente contra su hash Argon2id (PLAN.md §6.1).
 * Audita tanto los ingresos exitosos como cada intento fallido y aplica bloqueo temporal tras N fallos.
 */
export function autenticarUsuarioOffline(
  db: DatabaseSync,
  params: {
    comercioId: string;
    usuario: string;
    clave: string;
    deviceId: string;
    ahora?: Date;
  }
): {
  usuario: UsuarioPublico;
  actor: ActorContexto;
} {
  const ahoraDate = params.ahora ?? new Date();
  const ahoraIso = ahoraDate.toISOString();
  const usuarioLimpio = params.usuario.trim();

  const fila = db
    .prepare(
      `SELECT
        id, comercio_id, nombre, usuario, clave_hash, pin_hash, rol,
        puede_vender_movil, activo, debe_cambiar_clave,
        intentos_fallidos, bloqueado_hasta, ultimo_ingreso
       FROM usuarios
       WHERE comercio_id = ? AND lower(usuario) = lower(?) AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(params.comercioId, usuarioLimpio) as FilaUsuarioAuth | undefined;

  if (!fila) {
    ejecutarEnTransaccion(db, () => {
      insertarRegistroAuditoria(db, {
        actor: {
          comercio_id: params.comercioId,
          usuario_id: '',
          usuario_nombre: usuarioLimpio || 'desconocido',
          rol: 'cajero',
          device_id: params.deviceId,
        },
        accion: 'login_fallido',
        entidad: 'usuarios',
        entidad_id: null,
        motivo: 'Usuario inexistente',
        ahoraIso,
      });
    });
    throw new Error('CREDENTIALES_INVALIDAS: Usuario o clave incorrectos.');
  }

  const actorUsuario: ActorContexto = {
    comercio_id: fila.comercio_id,
    usuario_id: fila.id,
    usuario_nombre: fila.nombre,
    rol: fila.rol,
    device_id: params.deviceId,
  };

  if (fila.activo === 0) {
    ejecutarEnTransaccion(db, () => {
      insertarRegistroAuditoria(db, {
        actor: actorUsuario,
        accion: 'login_fallido',
        entidad: 'usuarios',
        entidad_id: fila.id,
        motivo: 'Usuario desactivado',
        ahoraIso,
      });
    });
    throw new Error('USUARIO_INACTIVO: Este usuario se encuentra desactivado.');
  }

  if (estaUsuarioBloqueado(fila.bloqueado_hasta, ahoraDate)) {
    ejecutarEnTransaccion(db, () => {
      insertarRegistroAuditoria(db, {
        actor: actorUsuario,
        accion: 'login_fallido',
        entidad: 'usuarios',
        entidad_id: fila.id,
        motivo: 'Usuario bloqueado temporalmente por intentos fallidos',
        valores_despues: { bloqueado_hasta: fila.bloqueado_hasta },
        ahoraIso,
      });
    });
    throw new Error(
      'USUARIO_BLOQUEADO: La cuenta está bloqueada temporalmente por demasiados intentos fallidos.'
    );
  }

  const claveValida = verificarClaveArgon2id(params.clave, fila.clave_hash);

  if (!claveValida) {
    const nuevosIntentos = fila.intentos_fallidos + 1;
    const bloqueadoHasta =
      nuevosIntentos >= MAX_INTENTOS_FALLIDOS
        ? calcularFechaDesbloqueo(ahoraDate)
        : null;

    ejecutarEnTransaccion(db, () => {
      db.prepare(
        `UPDATE usuarios
         SET intentos_fallidos = ?,
             bloqueado_hasta = ?,
             updated_at = ?,
             device_id = ?,
             sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(
        nuevosIntentos,
        bloqueadoHasta,
        ahoraIso,
        params.deviceId,
        fila.id,
        fila.comercio_id
      );

      encolarSyncUsuario(db, 'usuarios', fila.id, 'update', ahoraIso);

      insertarRegistroAuditoria(db, {
        actor: actorUsuario,
        accion: 'login_fallido',
        entidad: 'usuarios',
        entidad_id: fila.id,
        valores_antes: { intentos_fallidos: fila.intentos_fallidos },
        valores_despues: {
          intentos_fallidos: nuevosIntentos,
          bloqueado_hasta: bloqueadoHasta,
        },
        motivo: 'Clave incorrecta',
        ahoraIso,
      });
    });

    if (bloqueadoHasta) {
      throw new Error(
        'USUARIO_BLOQUEADO: Se alcanzó el máximo de intentos fallidos. Cuenta bloqueada temporalmente.'
      );
    }
    throw new Error('CREDENTIALES_INVALIDAS: Usuario o clave incorrectos.');
  }

  // Login exitoso: resetear contador de intentos fallidos y registrar último ingreso
  ejecutarEnTransaccion(db, () => {
    db.prepare(
      `UPDATE usuarios
       SET intentos_fallidos = 0,
           bloqueado_hasta = NULL,
           ultimo_ingreso = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(ahoraIso, ahoraIso, params.deviceId, fila.id, fila.comercio_id);

    encolarSyncUsuario(db, 'usuarios', fila.id, 'update', ahoraIso);

    insertarRegistroAuditoria(db, {
      actor: actorUsuario,
      accion: 'login_exitoso',
      entidad: 'usuarios',
      entidad_id: fila.id,
      valores_despues: { ultimo_ingreso: ahoraIso },
      ahoraIso,
    });
  });

  return {
    usuario: mapearUsuarioPublico({
      ...fila,
      intentos_fallidos: 0,
      bloqueado_hasta: null,
      ultimo_ingreso: ahoraIso,
    }),
    actor: actorUsuario,
  };
}

/**
 * Registra el cierre de sesión de un usuario en la auditoría (PLAN.md §6.1).
 */
export function registrarLogoutUsuario(
  db: DatabaseSync,
  actor: ActorContexto
): void {
  ejecutarEnTransaccion(db, () => {
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'logout',
      entidad: 'usuarios',
      entidad_id: actor.usuario_id,
    });
  });
}

/**
 * Permite al usuario cambiar su propia clave (obligatorio cuando debe_cambiar_clave = 1).
 * Nunca guarda la clave ni su hash en la auditoría (Regla 16).
 */
export function cambiarClavePropia(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    claveActual: string;
    claveNueva: string;
    opcionesArgon?: OpcionesArgon2id;
  }
): void {
  validarPoliticaClave(params.claveNueva);
  if (params.claveActual === params.claveNueva) {
    throw new Error('La nueva clave debe ser distinta a la clave actual.');
  }

  const fila = db
    .prepare(
      `SELECT id, clave_hash, debe_cambiar_clave
       FROM usuarios
       WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
    )
    .get(actor.usuario_id, actor.comercio_id) as
    | { id: string; clave_hash: string; debe_cambiar_clave: number }
    | undefined;

  if (!fila) {
    throw new Error('Usuario no encontrado.');
  }

  if (!verificarClaveArgon2id(params.claveActual, fila.clave_hash)) {
    throw new Error('CLAVE_ACTUAL_INCORRECTA: La clave actual ingresada no es correcta.');
  }

  const nuevoHash = hashearClaveArgon2id(params.claveNueva, params.opcionesArgon);

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    db.prepare(
      `UPDATE usuarios
       SET clave_hash = ?,
           debe_cambiar_clave = 0,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(nuevoHash, ahora, actor.device_id, actor.usuario_id, actor.comercio_id);

    encolarSyncUsuario(db, 'usuarios', actor.usuario_id, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'usuario_cambiar_clave',
      entidad: 'usuarios',
      entidad_id: actor.usuario_id,
      valores_antes: { debe_cambiar_clave: fila.debe_cambiar_clave },
      valores_despues: { debe_cambiar_clave: 0 },
      ahoraIso: ahora,
    });
  });
}

/**
 * Configura un PIN numérico personal (Argon2id) para cambio rápido de usuario en terminal de caja (PLAN.md §6.1).
 */
export function configurarPinUsuario(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    claveActual: string;
    pinNuevo: string;
    opcionesArgon?: OpcionesArgon2id;
  }
): void {
  validarPoliticaPin(params.pinNuevo);

  const fila = db
    .prepare(
      `SELECT id, clave_hash FROM usuarios
       WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
    )
    .get(actor.usuario_id, actor.comercio_id) as
    | { id: string; clave_hash: string }
    | undefined;

  if (!fila || !verificarClaveArgon2id(params.claveActual, fila.clave_hash)) {
    throw new Error('CLAVE_ACTUAL_INCORRECTA: Clave actual inválida para configurar el PIN.');
  }

  const pinHash = hashearClaveArgon2id(params.pinNuevo, params.opcionesArgon);

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    db.prepare(
      `UPDATE usuarios
       SET pin_hash = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(pinHash, ahora, actor.device_id, actor.usuario_id, actor.comercio_id);

    encolarSyncUsuario(db, 'usuarios', actor.usuario_id, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'usuario_configurar_pin',
      entidad: 'usuarios',
      entidad_id: actor.usuario_id,
      valores_despues: { tiene_pin: true },
      ahoraIso: ahora,
    });
  });
}

/**
 * Cambio rápido de usuario en mostrador mediante usuario individual + PIN (PLAN.md §6.1).
 */
export function cambiarUsuarioConPin(
  db: DatabaseSync,
  params: {
    comercioId: string;
    usuario: string;
    pin: string;
    deviceId: string;
    ahora?: Date;
  }
): {
  usuario: UsuarioPublico;
  actor: ActorContexto;
} {
  const ahoraDate = params.ahora ?? new Date();
  const ahoraIso = ahoraDate.toISOString();

  const fila = db
    .prepare(
      `SELECT
        id, comercio_id, nombre, usuario, clave_hash, pin_hash, rol,
        puede_vender_movil, activo, debe_cambiar_clave,
        intentos_fallidos, bloqueado_hasta, ultimo_ingreso
       FROM usuarios
       WHERE comercio_id = ? AND lower(usuario) = lower(?) AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(params.comercioId, params.usuario.trim()) as FilaUsuarioAuth | undefined;

  if (!fila || fila.activo === 0 || !fila.pin_hash) {
    throw new Error('PIN_INVALIDO: Usuario sin PIN activo o credenciales inválidas.');
  }

  if (estaUsuarioBloqueado(fila.bloqueado_hasta, ahoraDate)) {
    throw new Error('USUARIO_BLOQUEADO: Usuario bloqueado temporalmente.');
  }

  const actorUsuario: ActorContexto = {
    comercio_id: fila.comercio_id,
    usuario_id: fila.id,
    usuario_nombre: fila.nombre,
    rol: fila.rol,
    device_id: params.deviceId,
  };

  if (!verificarClaveArgon2id(params.pin, fila.pin_hash)) {
    const nuevosIntentos = fila.intentos_fallidos + 1;
    const bloqueadoHasta =
      nuevosIntentos >= MAX_INTENTOS_FALLIDOS
        ? calcularFechaDesbloqueo(ahoraDate)
        : null;

    ejecutarEnTransaccion(db, () => {
      db.prepare(
        `UPDATE usuarios
         SET intentos_fallidos = ?, bloqueado_hasta = ?, updated_at = ?, sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(nuevosIntentos, bloqueadoHasta, ahoraIso, fila.id, fila.comercio_id);

      encolarSyncUsuario(db, 'usuarios', fila.id, 'update', ahoraIso);

      insertarRegistroAuditoria(db, {
        actor: actorUsuario,
        accion: 'cambio_rapido_pin_fallido',
        entidad: 'usuarios',
        entidad_id: fila.id,
        valores_despues: {
          intentos_fallidos: nuevosIntentos,
          bloqueado_hasta: bloqueadoHasta,
        },
        motivo: 'PIN incorrecto',
        ahoraIso,
      });
    });

    throw new Error('PIN_INVALIDO: El PIN ingresado es incorrecto.');
  }

  ejecutarEnTransaccion(db, () => {
    db.prepare(
      `UPDATE usuarios
       SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_ingreso = ?, updated_at = ?, sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(ahoraIso, ahoraIso, fila.id, fila.comercio_id);

    encolarSyncUsuario(db, 'usuarios', fila.id, 'update', ahoraIso);

    insertarRegistroAuditoria(db, {
      actor: actorUsuario,
      accion: 'cambio_rapido_pin_exitoso',
      entidad: 'usuarios',
      entidad_id: fila.id,
      ahoraIso,
    });
  });

  return {
    usuario: mapearUsuarioPublico({
      ...fila,
      intentos_fallidos: 0,
      bloqueado_hasta: null,
      ultimo_ingreso: ahoraIso,
    }),
    actor: actorUsuario,
  };
}

/**
 * Resetea la clave de un usuario generando una clave temporal y forzando debe_cambiar_clave = 1 (solo superadmin, PLAN.md §6.1).
 */
export function resetearClaveUsuario(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    usuarioObjetivoId: string;
    claveTemporalManual?: string;
    motivo?: string;
    opcionesArgon?: OpcionesArgon2id;
  }
): { claveTemporal: string } {
  exigirPermiso(actor.rol, 'gestionar_usuarios');

  const claveTemporal = params.claveTemporalManual ?? generarClaveTemporal();
  validarPoliticaClave(claveTemporal);
  const nuevoHash = hashearClaveArgon2id(claveTemporal, params.opcionesArgon);

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const existe = db
      .prepare(
        `SELECT id, usuario FROM usuarios
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.usuarioObjetivoId, actor.comercio_id) as
      | { id: string; usuario: string }
      | undefined;

    if (!existe) {
      throw new Error('Usuario no encontrado.');
    }

    db.prepare(
      `UPDATE usuarios
       SET clave_hash = ?,
           debe_cambiar_clave = 1,
           intentos_fallidos = 0,
           bloqueado_hasta = NULL,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      nuevoHash,
      ahora,
      actor.device_id,
      params.usuarioObjetivoId,
      actor.comercio_id
    );

    encolarSyncUsuario(db, 'usuarios', params.usuarioObjetivoId, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'usuario_resetear_clave',
      entidad: 'usuarios',
      entidad_id: params.usuarioObjetivoId,
      valores_despues: {
        usuario: existe.usuario,
        debe_cambiar_clave: 1,
        intentos_fallidos: 0,
      },
      motivo: params.motivo ?? 'Reseteo de clave por superadmin',
      ahoraIso: ahora,
    });
  });

  return { claveTemporal };
}

/**
 * Verifica en el acto las credenciales de un encargado o superadmin para autorizar una acción restringida
 * (ej. anulación de venta por un cajero, PLAN.md §6.1 y §13).
 */
export function verificarAutorizadorEnVivo(
  db: DatabaseSync,
  params: {
    comercioId: string;
    usuarioAutorizador: string;
    claveAutorizador: string;
    deviceId: string;
  }
): AutorizadorContexto {
  const { usuario } = autenticarUsuarioOffline(db, {
    comercioId: params.comercioId,
    usuario: params.usuarioAutorizador,
    clave: params.claveAutorizador,
    deviceId: params.deviceId,
  });

  if (!puedeAutorizarAnulacion(usuario.rol)) {
    throw new Error(
      `PERMISO_DENEGADO: El usuario "${usuario.nombre}" (${usuario.rol}) no tiene rango para autorizar esta operación.`
    );
  }

  return {
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    rol: usuario.rol,
  };
}

/**
 * Lista los usuarios del comercio sin incluir hashes de claves ni PINs (solo superadmin, PLAN.md §6.1).
 */
export function listarUsuariosComercio(
  db: DatabaseSync,
  actor: ActorContexto
): UsuarioPublico[] {
  exigirPermiso(actor.rol, 'gestionar_usuarios');

  const filas = db
    .prepare(
      `SELECT
        id, comercio_id, nombre, usuario, clave_hash, pin_hash, rol,
        puede_vender_movil, activo, debe_cambiar_clave,
        intentos_fallidos, bloqueado_hasta, ultimo_ingreso
       FROM usuarios
       WHERE comercio_id = ? AND deleted_at IS NULL
       ORDER BY nombre ASC`
    )
    .all(actor.comercio_id) as unknown as FilaUsuarioAuth[];

  return filas.map(mapearUsuarioPublico);
}

/**
 * Consulta los registros de auditoría con filtros opcionales (solo superadmin, PLAN.md §6.1 y §13).
 */
export function consultarRegistrosAuditoria(
  db: DatabaseSync,
  actor: ActorContexto,
  filtros: FiltrosAuditoria = {}
): RegistroAuditoriaCompleto[] {
  exigirPermiso(actor.rol, 'ver_exportar_auditoria');

  const condiciones: string[] = ['comercio_id = ?'];
  const parametros: Array<string | number> = [actor.comercio_id];

  if (filtros.usuarioId) {
    condiciones.push('usuario_id = ?');
    parametros.push(filtros.usuarioId);
  }
  if (filtros.accion) {
    condiciones.push('accion = ?');
    parametros.push(filtros.accion);
  }
  if (filtros.entidad) {
    condiciones.push('entidad = ?');
    parametros.push(filtros.entidad);
  }
  if (filtros.fechaDesdeIso) {
    condiciones.push('fecha_hora >= ?');
    parametros.push(filtros.fechaDesdeIso);
  }
  if (filtros.fechaHastaIso) {
    condiciones.push('fecha_hora <= ?');
    parametros.push(filtros.fechaHastaIso);
  }

  const limite = filtros.limite ?? 500;
  parametros.push(limite);

  const sql = `
    SELECT
      id, comercio_id, fecha_hora, usuario_id, usuario_nombre, rol, device_id,
      accion, entidad, entidad_id, valores_antes, valores_despues, motivo,
      autorizado_por_id, autorizado_por_nombre, hash_prev, hash
    FROM auditoria
    WHERE ${condiciones.join(' AND ')}
    ORDER BY rowid DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...parametros) as unknown as RegistroAuditoriaCompleto[];
}

/**
 * Registra en la auditoría el hecho de haber exportado informes o registros de auditoría (PLAN.md §6.1).
 */
export function auditarExportacionInforme(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    nombreInforme: string;
    formato: 'xlsx' | 'pdf' | 'csv';
    filtrosAplicados?: Record<string, unknown>;
  }
): void {
  ejecutarEnTransaccion(db, () => {
    insertarRegistroAuditoria(db, {
      actor,
      accion: 'informe_exportar',
      entidad: 'informes',
      entidad_id: params.nombreInforme,
      valores_despues: {
        informe: params.nombreInforme,
        formato: params.formato,
        filtros: params.filtrosAplicados ?? {},
      },
    });
  });
}
