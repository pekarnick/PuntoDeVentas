/**
 * Repositorio transaccional de Caja: apertura, ingresos/egresos manuales, arqueo y cierre con diferencia.
 * Cumple PLAN.md §3 (reglas 1, 2, 13), §4, §6.5 y §13.
 */

import type { DatabaseSync } from 'node:sqlite';
import { asegurarCentavos, type Centavos } from '../domain/dinero.ts';
import { exigirPermiso } from '../domain/permisos.ts';
import {
  calcularArqueoCaja,
  type MedioPago,
  type PagoVentaInput,
} from '../domain/totales.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  ejecutarEnTransaccion,
  insertarRegistroAuditoria,
  type ActorContexto,
} from './repositorios.ts';

export interface SesionCajaRegistro {
  readonly id: string;
  readonly comercio_id: string;
  readonly usuario_id: string;
  readonly fecha_apertura: string;
  readonly monto_inicial: Centavos;
  readonly fecha_cierre: string | null;
  readonly usuario_cierre_id: string | null;
  readonly efectivo_esperado: Centavos | null;
  readonly efectivo_contado: Centavos | null;
  readonly diferencia: Centavos | null;
  readonly estado: 'abierta' | 'cerrada';
  readonly observaciones: string | null;
}

export interface MovimientoCajaRegistro {
  readonly id: string;
  readonly comercio_id: string;
  readonly caja_sesion_id: string;
  readonly usuario_id: string;
  readonly fecha: string;
  readonly tipo: 'ingreso' | 'egreso';
  readonly concepto: string;
  readonly monto: Centavos;
  readonly medio: MedioPago;
  readonly referencia_id: string | null;
}

export interface ResultadoCierreCaja {
  readonly sesionId: string;
  readonly montoInicial: Centavos;
  readonly totalesPorMedio: Record<MedioPago, Centavos>;
  readonly efectivoEsperado: Centavos;
  readonly efectivoContado: Centavos;
  readonly diferenciaEfectivo: Centavos;
  readonly fechaCierre: string;
}

function encolarSyncCaja(
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

/**
 * Abre una nueva sesión de caja para el usuario activo.
 * Impide abrir una segunda sesión si el usuario ya tiene una caja abierta en el mismo comercio.
 */
export function abrirSesionCaja(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    montoInicialCentavos: Centavos;
    observaciones?: string;
  }
): string {
  exigirPermiso(actor.rol, 'vender_y_caja');
  asegurarCentavos(params.montoInicialCentavos, 'montoInicialCentavos');
  if (params.montoInicialCentavos < 0) {
    throw new Error('El monto inicial de caja no puede ser negativo.');
  }

  return ejecutarEnTransaccion(db, () => {
    const abiertaExistente = db
      .prepare(
        `SELECT id FROM caja_sesiones
         WHERE comercio_id = ? AND usuario_id = ? AND estado = 'abierta' AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(actor.comercio_id, actor.usuario_id) as { id: string } | undefined;

    if (abiertaExistente) {
      throw new Error(
        'CAJA_YA_ABIERTA: El usuario ya tiene una sesión de caja abierta.'
      );
    }

    const ahora = new Date().toISOString();
    const sesionId = generarUuidV7();

    db.prepare(
      `INSERT INTO caja_sesiones (
        id, comercio_id, usuario_id, fecha_apertura, monto_inicial,
        estado, observaciones,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, 'abierta', ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      sesionId,
      actor.comercio_id,
      actor.usuario_id,
      ahora,
      params.montoInicialCentavos,
      params.observaciones?.trim() ?? null,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSyncCaja(db, 'caja_sesiones', sesionId, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'caja_abrir',
      entidad: 'caja_sesiones',
      entidad_id: sesionId,
      valores_despues: {
        id: sesionId,
        monto_inicial: params.montoInicialCentavos,
        estado: 'abierta',
      },
      ahoraIso: ahora,
    });

    return sesionId;
  });
}

/**
 * Obtiene la sesión de caja abierta actualmente por un usuario (si existe).
 */
export function obtenerSesionCajaAbierta(
  db: DatabaseSync,
  comercioId: string,
  usuarioId: string
): SesionCajaRegistro | null {
  const fila = db
    .prepare(
      `SELECT
        id, comercio_id, usuario_id, fecha_apertura, monto_inicial,
        fecha_cierre, usuario_cierre_id, efectivo_esperado, efectivo_contado,
        diferencia, estado, observaciones
       FROM caja_sesiones
       WHERE comercio_id = ? AND usuario_id = ? AND estado = 'abierta' AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(comercioId, usuarioId) as SesionCajaRegistro | undefined;

  return fila ?? null;
}

/**
 * Registra un ingreso o egreso manual de caja en una sesión abierta (PLAN.md §6.5).
 */
export function registrarMovimientoManualCaja(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    cajaSesionId: string;
    tipo: 'ingreso' | 'egreso';
    concepto: string;
    montoCentavos: Centavos;
    medio?: MedioPago;
    referenciaId?: string;
  }
): string {
  exigirPermiso(actor.rol, 'vender_y_caja');
  asegurarCentavos(params.montoCentavos, 'montoCentavos');
  if (params.montoCentavos <= 0) {
    throw new Error('El monto del movimiento de caja debe ser mayor a cero.');
  }
  if (!params.concepto || params.concepto.trim().length === 0) {
    throw new Error('El concepto del movimiento de caja es obligatorio.');
  }

  return ejecutarEnTransaccion(db, () => {
    const sesion = db
      .prepare(
        `SELECT id, estado FROM caja_sesiones
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.cajaSesionId, actor.comercio_id) as
      | { id: string; estado: 'abierta' | 'cerrada' }
      | undefined;

    if (!sesion) {
      throw new Error('Sesión de caja no encontrada.');
    }
    if (sesion.estado !== 'abierta') {
      throw new Error(
        'CAJA_CERRADA: No se pueden registrar movimientos en una sesión de caja cerrada.'
      );
    }

    const ahora = new Date().toISOString();
    const movId = generarUuidV7();
    const medio: MedioPago = params.medio ?? 'efectivo';
    const conceptoLimpio = params.concepto.trim();

    db.prepare(
      `INSERT INTO caja_movimientos (
        id, comercio_id, caja_sesion_id, usuario_id, fecha,
        tipo, concepto, monto, medio, referencia_id,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      movId,
      actor.comercio_id,
      params.cajaSesionId,
      actor.usuario_id,
      ahora,
      params.tipo,
      conceptoLimpio,
      params.montoCentavos,
      medio,
      params.referenciaId ?? null,
      ahora,
      ahora,
      actor.device_id
    );

    encolarSyncCaja(db, 'caja_movimientos', movId, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: params.tipo === 'ingreso' ? 'caja_ingreso' : 'caja_egreso',
      entidad: 'caja_movimientos',
      entidad_id: movId,
      valores_despues: {
        caja_sesion_id: params.cajaSesionId,
        tipo: params.tipo,
        concepto: conceptoLimpio,
        monto: params.montoCentavos,
        medio,
      },
      motivo: conceptoLimpio,
      ahoraIso: ahora,
    });

    return movId;
  });
}

/**
 * Calcula el estado actual o previo al cierre de una sesión de caja (desglose por medio de pago
 * de ventas completadas + movimientos manuales).
 */
export function calcularEstadoSesionCaja(
  db: DatabaseSync,
  comercioId: string,
  cajaSesionId: string,
  efectivoContadoCentavos: Centavos = 0
): {
  sesion: SesionCajaRegistro;
  totalesPorMedio: Record<MedioPago, Centavos>;
  efectivoEsperado: Centavos;
  efectivoContado: Centavos;
  diferenciaEfectivo: Centavos;
  movimientosManuales: MovimientoCajaRegistro[];
} {
  asegurarCentavos(efectivoContadoCentavos, 'efectivoContadoCentavos');

  const sesion = db
    .prepare(
      `SELECT
        id, comercio_id, usuario_id, fecha_apertura, monto_inicial,
        fecha_cierre, usuario_cierre_id, efectivo_esperado, efectivo_contado,
        diferencia, estado, observaciones
       FROM caja_sesiones
       WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
    )
    .get(cajaSesionId, comercioId) as SesionCajaRegistro | undefined;

  if (!sesion) {
    throw new Error('Sesión de caja no encontrada.');
  }

  // Solo las ventas completadas (no las anuladas) suman a la recaudación de la sesión
  const pagosVentas = db
    .prepare(
      `SELECT vp.medio, vp.monto
       FROM ventas_pagos vp
       INNER JOIN ventas v
         ON v.id = vp.venta_id
         AND v.comercio_id = vp.comercio_id
       WHERE v.comercio_id = ?
         AND v.caja_sesion_id = ?
         AND v.estado = 'completada'
         AND v.deleted_at IS NULL
         AND vp.deleted_at IS NULL`
    )
    .all(comercioId, cajaSesionId) as unknown as PagoVentaInput[];

  const movimientosManuales = db
    .prepare(
      `SELECT
        id, comercio_id, caja_sesion_id, usuario_id, fecha,
        tipo, concepto, monto, medio, referencia_id
       FROM caja_movimientos
       WHERE comercio_id = ? AND caja_sesion_id = ? AND deleted_at IS NULL
       ORDER BY fecha ASC`
    )
    .all(comercioId, cajaSesionId) as unknown as MovimientoCajaRegistro[];

  const arqueo = calcularArqueoCaja({
    montoInicial: sesion.monto_inicial,
    pagosVentasCompletadas: pagosVentas,
    movimientosManuales,
    efectivoContado: efectivoContadoCentavos,
  });

  return {
    sesion,
    totalesPorMedio: arqueo.totalesPorMedio,
    efectivoEsperado: arqueo.efectivoEsperado,
    efectivoContado: arqueo.efectivoContado,
    diferenciaEfectivo: arqueo.diferenciaEfectivo,
    movimientosManuales,
  };
}

/**
 * Cierra una sesión de caja abierta guardando el arqueo, el desglose por medio de pago
 * y la diferencia de efectivo, todo en una transacción auditada (PLAN.md §13).
 */
export function cerrarSesionCaja(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    cajaSesionId: string;
    efectivoContadoCentavos: Centavos;
    observaciones?: string;
  }
): ResultadoCierreCaja {
  exigirPermiso(actor.rol, 'vender_y_caja');
  asegurarCentavos(params.efectivoContadoCentavos, 'efectivoContadoCentavos');
  if (params.efectivoContadoCentavos < 0) {
    throw new Error('El efectivo contado no puede ser negativo.');
  }

  return ejecutarEnTransaccion(db, () => {
    const estadoCalculado = calcularEstadoSesionCaja(
      db,
      actor.comercio_id,
      params.cajaSesionId,
      params.efectivoContadoCentavos
    );

    if (estadoCalculado.sesion.estado === 'cerrada') {
      throw new Error('CAJA_YA_CERRADA: Esta sesión de caja ya se encuentra cerrada.');
    }

    const ahora = new Date().toISOString();

    db.prepare(
      `UPDATE caja_sesiones
       SET fecha_cierre = ?,
           usuario_cierre_id = ?,
           efectivo_esperado = ?,
           efectivo_contado = ?,
           diferencia = ?,
           estado = 'cerrada',
           observaciones = COALESCE(?, observaciones),
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(
      ahora,
      actor.usuario_id,
      estadoCalculado.efectivoEsperado,
      estadoCalculado.efectivoContado,
      estadoCalculado.diferenciaEfectivo,
      params.observaciones?.trim() ?? null,
      ahora,
      actor.device_id,
      params.cajaSesionId,
      actor.comercio_id
    );

    encolarSyncCaja(db, 'caja_sesiones', params.cajaSesionId, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'caja_cerrar',
      entidad: 'caja_sesiones',
      entidad_id: params.cajaSesionId,
      valores_antes: { estado: 'abierta' },
      valores_despues: {
        estado: 'cerrada',
        monto_inicial: estadoCalculado.sesion.monto_inicial,
        totales_por_medio: estadoCalculado.totalesPorMedio,
        efectivo_esperado: estadoCalculado.efectivoEsperado,
        efectivo_contado: estadoCalculado.efectivoContado,
        diferencia_efectivo: estadoCalculado.diferenciaEfectivo,
      },
      motivo: params.observaciones?.trim() ?? null,
      ahoraIso: ahora,
    });

    return {
      sesionId: params.cajaSesionId,
      montoInicial: estadoCalculado.sesion.monto_inicial,
      totalesPorMedio: estadoCalculado.totalesPorMedio,
      efectivoEsperado: estadoCalculado.efectivoEsperado,
      efectivoContado: estadoCalculado.efectivoContado,
      diferenciaEfectivo: estadoCalculado.diferenciaEfectivo,
      fechaCierre: ahora,
    };
  });
}
