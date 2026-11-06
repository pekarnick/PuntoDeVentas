/**
 * Repositorio SQLite de Fase 4 — Facturación Electrónica ARCA (ex-AFIP, Opcional)
 * y Extras: Múltiples Listas de Precio, Variantes, Combos y Códigos de Balanza
 * (PLAN.md §3 Reglas 18, 19, 20; §4; §6.3; §7; §9; §10 y §14).
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  asegurarCentavos,
  calcularPrecioYStockCombo,
  construirUrlQrOficialArca,
  determinarNotaCreditoArca,
  formatearComprobanteFiscalImprimible,
  formatearNumeroComprobanteFiscal,
  parsearCodigoBarrasBalanza,
  validarConfiguracionArcaCliente,
  validarReceptorComprobanteArca,
  type AlicuotaIva,
  type AmbienteArca,
  type Centavos,
  type CondicionIva,
  type EstadoFacturacionArca,
  type MedioPago,
  type ProveedorArca,
  type TipoComprobanteFiscal,
} from '../../packages/domain/src/index.ts';
import {
  procesarSolicitudEmisionArcaEdge,
  type RespuestaEmisionArcaEdge,
  type SolicitudEmisionArcaEdge,
} from '../../supabase/functions/emitir_comprobante_arca/index.ts';
import { exigirPermiso } from '../domain/permisos.ts';
import { desglosarIvaPorItem } from '../domain/totales.ts';
import { generarUuidV7 } from '../domain/uuid.ts';
import {
  anularVenta,
  ejecutarEnTransaccion,
  encolarSync,
  insertarRegistroAuditoria,
  obtenerStockProducto,
  registrarVenta,
  type ActorContexto,
  type AutorizadorContexto,
} from './repositorios.ts';

export interface AdaptadorServicioArca {
  estaConectado(): Promise<boolean>;
  emitirComprobante(
    solicitud: SolicitudEmisionArcaEdge
  ): Promise<RespuestaEmisionArcaEdge>;
}

/**
 * Adaptador local para pruebas en ambiente de homologación o tests de integración,
 * capaz de simular desconexión de internet o errores de red sin bloquear jamás la caja.
 */
export class AdaptadorArcaHomologacionLocal implements AdaptadorServicioArca {
  private conectado = true;
  private forzarErrorMensaje: string | null = null;

  public fijarConectado(conectado: boolean): void {
    this.conectado = conectado;
  }

  public fijarErrorForzado(mensaje: string | null): void {
    this.forzarErrorMensaje = mensaje;
  }

  public async estaConectado(): Promise<boolean> {
    return this.conectado;
  }

  public async emitirComprobante(
    solicitud: SolicitudEmisionArcaEdge
  ): Promise<RespuestaEmisionArcaEdge> {
    if (!this.conectado) {
      throw new Error('SIN_CONEXION_ARCA: Sin conexión a internet para contactar la Edge Function de ARCA.');
    }
    if (this.forzarErrorMensaje) {
      return {
        ok: false,
        venta_id: solicitud.venta_id,
        ambiente: solicitud.ambiente,
        tipo_comprobante: solicitud.tipo_comprobante,
        punto_venta: solicitud.punto_venta,
        numero_comprobante: solicitud.numero_comprobante,
        cae: '',
        cae_vencimiento: '',
        error: this.forzarErrorMensaje,
      };
    }
    return procesarSolicitudEmisionArcaEdge(solicitud);
  }
}

/**
 * Adaptador HTTP que invoca la Edge Function `emitir_comprobante_arca` en Supabase
 * usando únicamente la sesión pública autenticada; las credenciales de ARCA residen
 * como secretos en la Edge Function (PLAN.md §6.3 y Regla 18).
 */
export class AdaptadorEdgeFunctionArcaHttp implements AdaptadorServicioArca {
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly accessToken: string;

  constructor(params: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    accessToken?: string;
  }) {
    this.supabaseUrl = params.supabaseUrl.replace(/\/+$/, '');
    this.anonKey = params.supabaseAnonKey.trim();
    this.accessToken = (params.accessToken ?? params.supabaseAnonKey).trim();
  }

  public async estaConectado(): Promise<boolean> {
    if (!this.supabaseUrl || !this.anonKey) return false;
    try {
      const resp = await fetch(`${this.supabaseUrl}/rest/v1/`, {
        method: 'HEAD',
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${this.accessToken}`,
        },
        signal: AbortSignal.timeout(3500),
      });
      return resp.ok || resp.status === 401 || resp.status === 404;
    } catch {
      return false;
    }
  }

  public async emitirComprobante(
    solicitud: SolicitudEmisionArcaEdge
  ): Promise<RespuestaEmisionArcaEdge> {
    const url = `${this.supabaseUrl}/functions/v1/emitir_comprobante_arca`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(solicitud),
      signal: AbortSignal.timeout(10000),
    });

    const data = (await resp.json()) as RespuestaEmisionArcaEdge;
    return data;
  }
}

export interface EstadoConfiguracionArca {
  readonly comercio_id: string;
  readonly nombre_comercio: string;
  readonly razon_social: string | null;
  readonly cuit: string | null;
  readonly condicion_iva: CondicionIva;
  readonly domicilio: string | null;
  readonly arca_habilitada: boolean;
  readonly arca_ambiente: AmbienteArca;
  readonly arca_punto_venta: number;
  readonly arca_proveedor: ProveedorArca;
  readonly arca_tope_consumidor_final: Centavos;
  readonly resumen_comprobantes: {
    readonly emitidos: number;
    readonly pendientes: number;
    readonly con_error: number;
  };
}

/**
 * Obtiene la configuración actual de ARCA del comercio y el resumen de comprobantes.
 */
export function obtenerConfiguracionArca(
  db: DatabaseSync,
  comercioId: string
): EstadoConfiguracionArca {
  const row = db
    .prepare(
      `SELECT
        id,
        nombre,
        razon_social,
        cuit,
        condicion_iva,
        domicilio,
        arca_habilitada,
        arca_ambiente,
        arca_punto_venta,
        arca_proveedor,
        arca_tope_consumidor_final
       FROM comercios
       WHERE id = ? AND deleted_at IS NULL`
    )
    .get(comercioId) as
    | {
        id: string;
        nombre: string;
        razon_social: string | null;
        cuit: string | null;
        condicion_iva: CondicionIva;
        domicilio: string | null;
        arca_habilitada: number;
        arca_ambiente: AmbienteArca;
        arca_punto_venta: number;
        arca_proveedor: ProveedorArca;
        arca_tope_consumidor_final: Centavos;
      }
    | undefined;

  if (!row) {
    throw new Error('Comercio no encontrado.');
  }

  const conteos = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN estado_facturacion = 'emitida' THEN 1 ELSE 0 END), 0) AS emitidos,
        COALESCE(SUM(CASE WHEN estado_facturacion = 'pendiente' THEN 1 ELSE 0 END), 0) AS pendientes,
        COALESCE(SUM(CASE WHEN estado_facturacion = 'error' THEN 1 ELSE 0 END), 0) AS con_error
       FROM ventas
       WHERE comercio_id = ? AND deleted_at IS NULL`
    )
    .get(comercioId) as {
    emitidos: number;
    pendientes: number;
    con_error: number;
  };

  return {
    comercio_id: row.id,
    nombre_comercio: row.nombre,
    razon_social: row.razon_social,
    cuit: row.cuit,
    condicion_iva: row.condicion_iva,
    domicilio: row.domicilio,
    arca_habilitada: row.arca_habilitada === 1,
    arca_ambiente: row.arca_ambiente ?? 'homologacion',
    arca_punto_venta: row.arca_punto_venta ?? 1,
    arca_proveedor: row.arca_proveedor ?? 'afip_sdk',
    arca_tope_consumidor_final: row.arca_tope_consumidor_final ?? 34448800,
    resumen_comprobantes: {
      emitidos: conteos?.emitidos ?? 0,
      pendientes: conteos?.pendientes ?? 0,
      con_error: conteos?.con_error ?? 0,
    },
  };
}

/**
 * Actualiza la configuración de Facturación Electrónica ARCA (solo superadmin, PLAN.md §6.1 y §6.3).
 * Verifica la Regla 18 y 19: nunca guarda certificados ni claves privadas en el cliente.
 */
export function guardarConfiguracionArca(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly arcaHabilitada: boolean;
    readonly razonSocial?: string | null;
    readonly cuit?: string | null;
    readonly condicionIva?: CondicionIva;
    readonly domicilio?: string | null;
    readonly puntoVenta?: number;
    readonly ambiente?: AmbienteArca;
    readonly proveedor?: ProveedorArca;
    readonly topeConsumidorFinalCentavos?: Centavos;
    readonly camposExtra?: Record<string, unknown>;
  }
): EstadoConfiguracionArca {
  exigirPermiso(actor.rol, 'configurar_venta_movil_y_arca');

  const actual = obtenerConfiguracionArca(db, actor.comercio_id);
  const cuitFinal =
    params.cuit !== undefined ? params.cuit?.trim() || null : actual.cuit;
  const puntoVentaFinal = params.puntoVenta ?? actual.arca_punto_venta;
  const ambienteFinal = params.ambiente ?? actual.arca_ambiente;
  const proveedorFinal = params.proveedor ?? actual.arca_proveedor;
  const condicionIvaFinal = params.condicionIva ?? actual.condicion_iva;
  const razonSocialFinal =
    params.razonSocial !== undefined
      ? params.razonSocial?.trim() || null
      : actual.razon_social;
  const domicilioFinal =
    params.domicilio !== undefined
      ? params.domicilio?.trim() || null
      : actual.domicilio;
  const topeFinal =
    params.topeConsumidorFinalCentavos ?? actual.arca_tope_consumidor_final;

  const validacion = validarConfiguracionArcaCliente({
    arcaHabilitada: params.arcaHabilitada,
    cuitEmisor: cuitFinal,
    puntoVenta: puntoVentaFinal,
    ambiente: ambienteFinal,
    proveedor: proveedorFinal,
    camposExtra: params.camposExtra,
  });

  if (!validacion.valido) {
    throw new Error(
      validacion.motivo ?? 'Configuración de facturación ARCA inválida.'
    );
  }

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    db.prepare(
      `UPDATE comercios
       SET razon_social = ?,
           cuit = ?,
           condicion_iva = ?,
           domicilio = ?,
           arca_habilitada = ?,
           arca_ambiente = ?,
           arca_punto_venta = ?,
           arca_proveedor = ?,
           arca_tope_consumidor_final = ?,
           updated_at = ?,
           device_id = ?,
           sync_status = 'pendiente'
       WHERE id = ?`
    ).run(
      razonSocialFinal,
      cuitFinal,
      condicionIvaFinal,
      domicilioFinal,
      params.arcaHabilitada ? 1 : 0,
      ambienteFinal,
      puntoVentaFinal,
      proveedorFinal,
      topeFinal,
      ahora,
      actor.device_id,
      actor.comercio_id
    );

    encolarSync(db, 'comercios', actor.comercio_id, 'update', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'arca_configurar',
      entidad: 'comercios',
      entidad_id: actor.comercio_id,
      valores_antes: {
        arca_habilitada: actual.arca_habilitada ? 1 : 0,
        cuit: actual.cuit,
        condicion_iva: actual.condicion_iva,
        arca_ambiente: actual.arca_ambiente,
        arca_punto_venta: actual.arca_punto_venta,
        arca_proveedor: actual.arca_proveedor,
      },
      valores_despues: {
        arca_habilitada: params.arcaHabilitada ? 1 : 0,
        cuit: cuitFinal,
        condicion_iva: condicionIvaFinal,
        arca_ambiente: ambienteFinal,
        arca_punto_venta: puntoVentaFinal,
        arca_proveedor: proveedorFinal,
      },
      motivo: params.arcaHabilitada
        ? `Activación/actualización de facturación ARCA (${ambienteFinal})`
        : 'Desactivación de facturación ARCA (modo ticket no fiscal)',
      ahoraIso: ahora,
    });
  });

  return obtenerConfiguracionArca(db, actor.comercio_id);
}

export interface ResultadoEmisionArcaVenta {
  readonly venta_id: string;
  readonly estado_facturacion: EstadoFacturacionArca;
  readonly tipo_comprobante: TipoComprobanteFiscal;
  readonly punto_venta: number | null;
  readonly numero_comprobante: number | null;
  readonly cae: string | null;
  readonly cae_vencimiento: string | null;
  readonly qr_url: string | null;
  readonly error_detalle: string | null;
}

/**
 * Solicita a la Edge Function de ARCA la emisión del CAE para una venta específica.
 * Si no hay conexión a internet o el servicio falla, NUNCA bloquea ni revierte la venta:
 * la deja en estado `'pendiente'` (o `'error'`) para su reintento automático (PLAN.md §6.3 y §14).
 */
export async function emitirComprobanteArcaVenta(
  db: DatabaseSync,
  actor: ActorContexto,
  ventaId: string,
  adaptador: AdaptadorServicioArca = new AdaptadorArcaHomologacionLocal()
): Promise<ResultadoEmisionArcaVenta> {
  const venta = db
    .prepare(
      `SELECT
        v.id,
        v.comercio_id,
        v.fecha,
        v.cliente_id,
        v.total,
        v.tipo_comprobante,
        v.punto_venta,
        v.numero_comprobante,
        v.cae,
        v.cae_vencimiento,
        v.estado_facturacion,
        v.arca_ultimo_error
       FROM ventas v
       WHERE v.id = ? AND v.comercio_id = ? AND v.deleted_at IS NULL`
    )
    .get(ventaId, actor.comercio_id) as
    | {
        id: string;
        comercio_id: string;
        fecha: string;
        cliente_id: string | null;
        total: Centavos;
        tipo_comprobante: TipoComprobanteFiscal;
        punto_venta: number | null;
        numero_comprobante: number | null;
        cae: string | null;
        cae_vencimiento: string | null;
        estado_facturacion: EstadoFacturacionArca;
        arca_ultimo_error: string | null;
      }
    | undefined;

  if (!venta) {
    throw new Error('Venta no encontrada para emitir comprobante ARCA.');
  }

  const configArca = obtenerConfiguracionArca(db, actor.comercio_id);

  if (
    !configArca.arca_habilitada ||
    venta.tipo_comprobante === 'ticket_no_fiscal'
  ) {
    return {
      venta_id: venta.id,
      estado_facturacion: 'no_aplica',
      tipo_comprobante: 'ticket_no_fiscal',
      punto_venta: null,
      numero_comprobante: null,
      cae: null,
      cae_vencimiento: null,
      qr_url: null,
      error_detalle: null,
    };
  }

  if (venta.estado_facturacion === 'emitida' && venta.cae) {
    const { urlQrOficial } = construirUrlQrOficialArca({
      fechaIso: venta.fecha,
      cuitEmisor: configArca.cuit ?? '20111111112',
      puntoVenta: venta.punto_venta ?? configArca.arca_punto_venta,
      tipoComprobante: venta.tipo_comprobante,
      numeroComprobante: venta.numero_comprobante ?? 1,
      totalCentavos: venta.total,
      cae: venta.cae,
    });
    return {
      venta_id: venta.id,
      estado_facturacion: 'emitida',
      tipo_comprobante: venta.tipo_comprobante,
      punto_venta: venta.punto_venta,
      numero_comprobante: venta.numero_comprobante,
      cae: venta.cae,
      cae_vencimiento: venta.cae_vencimiento,
      qr_url: urlQrOficial,
      error_detalle: null,
    };
  }

  const itemsRows = db
    .prepare(
      `SELECT subtotal, alicuota_iva, exento_iva
       FROM ventas_items
       WHERE venta_id = ? AND comercio_id = ?`
    )
    .all(venta.id, actor.comercio_id) as unknown as {
    subtotal: Centavos;
    alicuota_iva: AlicuotaIva;
    exento_iva: number;
  }[];

  let netoTotal = 0;
  let ivaTotal = 0;
  for (const it of itemsRows) {
    const d = desglosarIvaPorItem(
      it.subtotal,
      it.alicuota_iva,
      it.exento_iva === 1,
      true
    );
    netoTotal += d.neto;
    ivaTotal += d.iva;
  }

  let clienteRow:
    | { cuit_dni: string | null; condicion_iva: CondicionIva; nombre: string }
    | undefined;
  if (venta.cliente_id) {
    clienteRow = db
      .prepare(
        `SELECT cuit_dni, condicion_iva, nombre
         FROM clientes
         WHERE id = ? AND comercio_id = ?`
      )
      .get(venta.cliente_id, actor.comercio_id) as
      | { cuit_dni: string | null; condicion_iva: CondicionIva; nombre: string }
      | undefined;
  }

  const valRec = validarReceptorComprobanteArca({
    tipoComprobante: venta.tipo_comprobante,
    totalCentavos: venta.total,
    condicionIvaReceptor: clienteRow?.condicion_iva ?? 'consumidor_final',
    cuitDniReceptor: clienteRow?.cuit_dni ?? null,
    nombreReceptor: clienteRow?.nombre ?? null,
    topeConsumidorFinalCentavos: configArca.arca_tope_consumidor_final,
  });

  const puntoVenta = venta.punto_venta ?? configArca.arca_punto_venta;
  const maxNroRow = db
    .prepare(
      `SELECT COALESCE(MAX(numero_comprobante), 0) AS max_nro
       FROM ventas
       WHERE comercio_id = ? AND punto_venta = ? AND tipo_comprobante = ?`
    )
    .get(actor.comercio_id, puntoVenta, venta.tipo_comprobante) as {
    max_nro: number;
  };
  const proximoNumero =
    venta.numero_comprobante ?? (maxNroRow?.max_nro ?? 0) + 1;

  try {
    const conectado = await adaptador.estaConectado();
    if (!conectado) {
      throw new Error(
        'SIN_CONEXION_ARCA: Sin conexión a internet; la factura queda pendiente y se reintentará automáticamente.'
      );
    }

    const respuesta = await adaptador.emitirComprobante({
      venta_id: venta.id,
      comercio_id: actor.comercio_id,
      cuit_emisor: configArca.cuit ?? '',
      condicion_iva_emisor: configArca.condicion_iva,
      punto_venta: puntoVenta,
      tipo_comprobante: venta.tipo_comprobante,
      numero_comprobante: proximoNumero,
      ambiente: configArca.arca_ambiente,
      proveedor: configArca.arca_proveedor,
      total_centavos: venta.total,
      neto_centavos: netoTotal,
      iva_centavos: ivaTotal,
      receptor_tipo_doc: valRec.tipoDocArca,
      receptor_nro_doc: valRec.nroDocArca,
    });

    if (!respuesta.ok) {
      const ahoraErr = new Date().toISOString();
      const detalleErr =
        respuesta.error ?? 'Error reportado por el servicio de facturación ARCA.';
      ejecutarEnTransaccion(db, () => {
        db.prepare(
          `UPDATE ventas
           SET estado_facturacion = 'error',
               arca_ultimo_error = ?,
               arca_intentos = arca_intentos + 1,
               updated_at = ?,
               device_id = ?,
               sync_status = 'pendiente'
           WHERE id = ? AND comercio_id = ?`
        ).run(
          detalleErr,
          ahoraErr,
          actor.device_id,
          venta.id,
          actor.comercio_id
        );
        encolarSync(db, 'ventas', venta.id, 'update', ahoraErr);
        insertarRegistroAuditoria(db, {
          actor,
          accion: 'arca_emision_error',
          entidad: 'ventas',
          entidad_id: venta.id,
          valores_despues: {
            estado_facturacion: 'error',
            error: detalleErr,
          },
          ahoraIso: ahoraErr,
        });
      });

      return {
        venta_id: venta.id,
        estado_facturacion: 'error',
        tipo_comprobante: venta.tipo_comprobante,
        punto_venta: puntoVenta,
        numero_comprobante: null,
        cae: null,
        cae_vencimiento: null,
        qr_url: null,
        error_detalle: detalleErr,
      };
    }

    const ahoraOk = new Date().toISOString();
    ejecutarEnTransaccion(db, () => {
      db.prepare(
        `UPDATE ventas
         SET punto_venta = ?,
             numero_comprobante = ?,
             cae = ?,
             cae_vencimiento = ?,
             estado_facturacion = 'emitida',
             arca_ultimo_error = NULL,
             arca_intentos = arca_intentos + 1,
             updated_at = ?,
             device_id = ?,
             sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(
        respuesta.punto_venta,
        respuesta.numero_comprobante,
        respuesta.cae,
        respuesta.cae_vencimiento,
        ahoraOk,
        actor.device_id,
        venta.id,
        actor.comercio_id
      );
      encolarSync(db, 'ventas', venta.id, 'update', ahoraOk);

      insertarRegistroAuditoria(db, {
        actor,
        accion: 'arca_emitir_comprobante',
        entidad: 'ventas',
        entidad_id: venta.id,
        valores_antes: {
          estado_facturacion: venta.estado_facturacion,
        },
        valores_despues: {
          estado_facturacion: 'emitida',
          tipo_comprobante: venta.tipo_comprobante,
          punto_venta: respuesta.punto_venta,
          numero_comprobante: respuesta.numero_comprobante,
          cae: respuesta.cae,
          cae_vencimiento: respuesta.cae_vencimiento,
          ambiente: configArca.arca_ambiente,
        },
        ahoraIso: ahoraOk,
      });
    });

    const { urlQrOficial } = construirUrlQrOficialArca({
      fechaIso: venta.fecha,
      cuitEmisor: configArca.cuit ?? '',
      puntoVenta: respuesta.punto_venta,
      tipoComprobante: venta.tipo_comprobante,
      numeroComprobante: respuesta.numero_comprobante,
      totalCentavos: venta.total,
      cuitDniReceptor: clienteRow?.cuit_dni ?? null,
      cae: respuesta.cae,
    });

    return {
      venta_id: venta.id,
      estado_facturacion: 'emitida',
      tipo_comprobante: venta.tipo_comprobante,
      punto_venta: respuesta.punto_venta,
      numero_comprobante: respuesta.numero_comprobante,
      cae: respuesta.cae,
      cae_vencimiento: respuesta.cae_vencimiento,
      qr_url: urlQrOficial,
      error_detalle: null,
    };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : 'Sin conexión con el servicio de facturación ARCA.';
    const ahoraPend = new Date().toISOString();

    ejecutarEnTransaccion(db, () => {
      db.prepare(
        `UPDATE ventas
         SET estado_facturacion = 'pendiente',
             arca_ultimo_error = ?,
             arca_intentos = arca_intentos + 1,
             updated_at = ?,
             device_id = ?,
             sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(msg, ahoraPend, actor.device_id, venta.id, actor.comercio_id);
      encolarSync(db, 'ventas', venta.id, 'update', ahoraPend);
    });

    return {
      venta_id: venta.id,
      estado_facturacion: 'pendiente',
      tipo_comprobante: venta.tipo_comprobante,
      punto_venta: puntoVenta,
      numero_comprobante: null,
      cae: null,
      cae_vencimiento: null,
      qr_url: null,
      error_detalle: msg,
    };
  }
}

/**
 * Reintenta automáticamente todas las ventas con `estado_facturacion IN ('pendiente', 'error')`
 * cuando vuelve la conexión a internet o cuando el operador lo solicita (PLAN.md §6.3 y §14).
 */
export async function reintentarComprobantesArcaPendientes(
  db: DatabaseSync,
  actor: ActorContexto,
  adaptador: AdaptadorServicioArca = new AdaptadorArcaHomologacionLocal()
): Promise<{
  readonly procesados: number;
  readonly emitidos: number;
  readonly siguenPendientes: number;
  readonly conError: number;
}> {
  const pendientes = db
    .prepare(
      `SELECT id
       FROM ventas
       WHERE comercio_id = ?
         AND deleted_at IS NULL
         AND estado_facturacion IN ('pendiente', 'error')
       ORDER BY fecha ASC`
    )
    .all(actor.comercio_id) as unknown as { id: string }[];

  let emitidos = 0;
  let siguenPendientes = 0;
  let conError = 0;

  for (const fila of pendientes) {
    const res = await emitirComprobanteArcaVenta(
      db,
      actor,
      fila.id,
      adaptador
    );
    if (res.estado_facturacion === 'emitida') {
      emitidos++;
    } else if (res.estado_facturacion === 'error') {
      conError++;
    } else {
      siguenPendientes++;
    }
  }

  return {
    procesados: pendientes.length,
    emitidos,
    siguenPendientes,
    conError,
  };
}

/**
 * Anula una venta y, si estaba facturada en ARCA, emite su Nota de Crédito electrónica A/B/C
 * registrando todo en `auditoria` (PLAN.md §6.3).
 */
export async function anularVentaConNotaCreditoArca(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly ventaId: string;
    readonly motivo: string;
    readonly autorizador?: AutorizadorContexto;
    readonly adaptador?: AdaptadorServicioArca;
  }
): Promise<{
  readonly notaCreditoEmitida: boolean;
  readonly notaCreditoTipo: 'nota_credito_a' | 'nota_credito_b' | 'nota_credito_c' | null;
  readonly notaCreditoNumero: number | null;
  readonly notaCreditoCae: string | null;
  readonly notaCreditoVencimiento: string | null;
}> {
  anularVenta(db, actor, {
    ventaId: params.ventaId,
    motivo: params.motivo,
    autorizador: params.autorizador,
  });

  const venta = db
    .prepare(
      `SELECT
        id,
        total,
        tipo_comprobante,
        punto_venta,
        numero_comprobante,
        cae,
        estado_facturacion,
        nota_credito_tipo
       FROM ventas
       WHERE id = ? AND comercio_id = ?`
    )
    .get(params.ventaId, actor.comercio_id) as
    | {
        id: string;
        total: Centavos;
        tipo_comprobante: TipoComprobanteFiscal;
        punto_venta: number | null;
        numero_comprobante: number | null;
        cae: string | null;
        estado_facturacion: EstadoFacturacionArca;
        nota_credito_tipo:
          | 'nota_credito_a'
          | 'nota_credito_b'
          | 'nota_credito_c'
          | null;
      }
    | undefined;

  const ncTipo =
    venta?.nota_credito_tipo ??
    (venta ? determinarNotaCreditoArca(venta.tipo_comprobante) : null);

  if (!venta || !ncTipo || venta.estado_facturacion !== 'emitida') {
    return {
      notaCreditoEmitida: false,
      notaCreditoTipo: ncTipo,
      notaCreditoNumero: null,
      notaCreditoCae: null,
      notaCreditoVencimiento: null,
    };
  }

  const configArca = obtenerConfiguracionArca(db, actor.comercio_id);
  const adaptador = params.adaptador ?? new AdaptadorArcaHomologacionLocal();
  const puntoVenta = venta.punto_venta ?? configArca.arca_punto_venta;

  const maxNcRow = db
    .prepare(
      `SELECT COALESCE(MAX(nota_credito_numero), 0) AS max_nc
       FROM ventas
       WHERE comercio_id = ? AND punto_venta = ? AND nota_credito_tipo = ?`
    )
    .get(actor.comercio_id, puntoVenta, ncTipo) as { max_nc: number };
  const proximoNroNc = (maxNcRow?.max_nc ?? 0) + 1;

  try {
    const conectado = await adaptador.estaConectado();
    if (!conectado) {
      return {
        notaCreditoEmitida: false,
        notaCreditoTipo: ncTipo,
        notaCreditoNumero: null,
        notaCreditoCae: null,
        notaCreditoVencimiento: null,
      };
    }

    const resp = await adaptador.emitirComprobante({
      venta_id: `${venta.id}_nc`,
      comercio_id: actor.comercio_id,
      cuit_emisor: configArca.cuit ?? '',
      condicion_iva_emisor: configArca.condicion_iva,
      punto_venta: puntoVenta,
      tipo_comprobante: ncTipo,
      numero_comprobante: proximoNroNc,
      ambiente: configArca.arca_ambiente,
      proveedor: configArca.arca_proveedor,
      total_centavos: venta.total,
      neto_centavos: venta.total,
      iva_centavos: 0,
      receptor_tipo_doc: 99,
      receptor_nro_doc: 0,
      comprobante_asociado_nro: venta.numero_comprobante,
    });

    if (!resp.ok) {
      return {
        notaCreditoEmitida: false,
        notaCreditoTipo: ncTipo,
        notaCreditoNumero: null,
        notaCreditoCae: null,
        notaCreditoVencimiento: null,
      };
    }

    const ahoraNc = new Date().toISOString();
    ejecutarEnTransaccion(db, () => {
      db.prepare(
        `UPDATE ventas
         SET nota_credito_tipo = ?,
             nota_credito_numero = ?,
             nota_credito_cae = ?,
             nota_credito_cae_vencimiento = ?,
             updated_at = ?,
             device_id = ?,
             sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(
        ncTipo,
        resp.numero_comprobante,
        resp.cae,
        resp.cae_vencimiento,
        ahoraNc,
        actor.device_id,
        venta.id,
        actor.comercio_id
      );
      encolarSync(db, 'ventas', venta.id, 'update', ahoraNc);

      insertarRegistroAuditoria(db, {
        actor,
        accion: 'arca_emitir_nota_credito',
        entidad: 'ventas',
        entidad_id: venta.id,
        valores_despues: {
          nota_credito_tipo: ncTipo,
          nota_credito_numero: resp.numero_comprobante,
          nota_credito_cae: resp.cae,
          nota_credito_cae_vencimiento: resp.cae_vencimiento,
        },
        motivo: params.motivo,
        ahoraIso: ahoraNc,
      });
    });

    return {
      notaCreditoEmitida: true,
      notaCreditoTipo: ncTipo,
      notaCreditoNumero: resp.numero_comprobante,
      notaCreditoCae: resp.cae,
      notaCreditoVencimiento: resp.cae_vencimiento,
    };
  } catch {
    return {
      notaCreditoEmitida: false,
      notaCreditoTipo: ncTipo,
      notaCreditoNumero: null,
      notaCreditoCae: null,
      notaCreditoVencimiento: null,
    };
  }
}

/**
 * Obtiene el comprobante fiscal electrónico imprimible (con QR oficial de ARCA, CAE y vencimiento)
 * garantizando por diseño la Regla 20 (nunca expone `costo_compra`, `costo_unitario` ni ganancias).
 */
export function obtenerComprobanteFiscalImprimibleDb(
  db: DatabaseSync,
  comercioId: string,
  ventaId: string
): ReturnType<typeof formatearComprobanteFiscalImprimible> {
  const venta = db
    .prepare(
      `SELECT
        v.id,
        v.fecha,
        v.subtotal,
        v.descuento,
        v.total,
        v.tipo_comprobante,
        v.punto_venta,
        v.numero_comprobante,
        v.cae,
        v.cae_vencimiento,
        v.cliente_id
       FROM ventas v
       WHERE v.id = ? AND v.comercio_id = ? AND v.deleted_at IS NULL`
    )
    .get(ventaId, comercioId) as
    | {
        id: string;
        fecha: string;
        subtotal: Centavos;
        descuento: Centavos;
        total: Centavos;
        tipo_comprobante: TipoComprobanteFiscal;
        punto_venta: number | null;
        numero_comprobante: number | null;
        cae: string | null;
        cae_vencimiento: string | null;
        cliente_id: string | null;
      }
    | undefined;

  if (!venta || !venta.cae) {
    throw new Error(
      'La venta indicada aún no cuenta con un CAE emitido por ARCA.'
    );
  }

  const comercio = obtenerConfiguracionArca(db, comercioId);

  let cliente:
    | {
        nombre: string;
        cuit_dni: string | null;
        condicion_iva: CondicionIva;
      }
    | undefined;
  if (venta.cliente_id) {
    cliente = db
      .prepare(
        `SELECT nombre, cuit_dni, condicion_iva
         FROM clientes
         WHERE id = ? AND comercio_id = ?`
      )
      .get(venta.cliente_id, comercioId) as
      | {
          nombre: string;
          cuit_dni: string | null;
          condicion_iva: CondicionIva;
        }
      | undefined;
  }

  // Regla 20: proyectamos exclusivamente descripcion, cantidad, precio_unitario, descuento, subtotal, alicuota_iva y exento_iva
  const items = db
    .prepare(
      `SELECT
        descripcion,
        cantidad,
        precio_unitario,
        descuento,
        subtotal,
        alicuota_iva,
        exento_iva
       FROM ventas_items
       WHERE venta_id = ? AND comercio_id = ?`
    )
    .all(ventaId, comercioId) as unknown as Array<{
    descripcion: string;
    cantidad: number;
    precio_unitario: Centavos;
    descuento: Centavos;
    subtotal: Centavos;
    alicuota_iva: AlicuotaIva;
    exento_iva: number;
  }>;

  return formatearComprobanteFiscalImprimible({
    comercioNombre: comercio.nombre_comercio,
    comercioRazonSocial: comercio.razon_social,
    comercioCuit: comercio.cuit ?? '20111111112',
    comercioCondicionIva: comercio.condicion_iva,
    comercioDomicilio: comercio.domicilio,
    tipoComprobante: venta.tipo_comprobante,
    puntoVenta: venta.punto_venta ?? comercio.arca_punto_venta,
    numeroComprobante: venta.numero_comprobante ?? 1,
    fechaIso: venta.fecha,
    cae: venta.cae,
    caeVencimientoIso: venta.cae_vencimiento ?? venta.fecha.slice(0, 10),
    ambiente: comercio.arca_ambiente,
    clienteNombre: cliente?.nombre ?? 'Consumidor Final',
    clienteCuitDni: cliente?.cuit_dni ?? null,
    clienteCondicionIva: cliente?.condicion_iva ?? 'consumidor_final',
    items: items.map((it) => ({
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precioUnitarioCentavos: it.precio_unitario,
      descuentoCentavos: it.descuento,
      subtotalCentavos: it.subtotal,
      alicuotaIva: it.alicuota_iva,
      exentoIva: it.exento_iva === 1,
    })),
    subtotalCentavos: venta.subtotal,
    descuentoGlobalCentavos: venta.descuento,
    totalCentavos: venta.total,
  });
}

export interface FilaInformeComprobanteArca {
  readonly venta_id: string;
  readonly fecha: string;
  readonly tipo_comprobante: TipoComprobanteFiscal;
  readonly numero_formateado: string | null;
  readonly cliente_nombre: string;
  readonly cliente_documento: string | null;
  readonly total_centavos: Centavos;
  readonly estado_facturacion: EstadoFacturacionArca;
  readonly cae: string | null;
  readonly cae_vencimiento: string | null;
  readonly arca_ultimo_error: string | null;
  readonly arca_intentos: number;
  readonly estado_venta: 'completada' | 'anulada';
  readonly nota_credito_tipo: string | null;
  readonly nota_credito_cae: string | null;
}

/**
 * Informe de gestión de comprobantes ARCA: emitidos, pendientes y con error (PLAN.md §6.3 y §7).
 */
export function obtenerInformeComprobantesArca(
  db: DatabaseSync,
  comercioId: string,
  filtros?: {
    readonly estadoFacturacion?: EstadoFacturacionArca | 'todos';
    readonly desdeIso?: string;
    readonly hastaIso?: string;
  }
): {
  readonly comprobantes: readonly FilaInformeComprobanteArca[];
  readonly totales: {
    readonly emitidosCount: number;
    readonly pendientesCount: number;
    readonly conErrorCount: number;
    readonly montoTotalEmitidoCentavos: Centavos;
    readonly montoTotalPendienteCentavos: Centavos;
  };
} {
  const filas = db
    .prepare(
      `SELECT
        v.id AS venta_id,
        v.fecha,
        v.tipo_comprobante,
        v.punto_venta,
        v.numero_comprobante,
        COALESCE(c.nombre, 'Consumidor Final') AS cliente_nombre,
        c.cuit_dni AS cliente_documento,
        v.total AS total_centavos,
        v.estado_facturacion,
        v.cae,
        v.cae_vencimiento,
        v.arca_ultimo_error,
        v.arca_intentos,
        v.estado AS estado_venta,
        v.nota_credito_tipo,
        v.nota_credito_cae
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.comercio_id = ?
         AND v.deleted_at IS NULL
         AND v.estado_facturacion != 'no_aplica'
       ORDER BY v.fecha DESC`
    )
    .all(comercioId) as unknown as Array<{
    venta_id: string;
    fecha: string;
    tipo_comprobante: TipoComprobanteFiscal;
    punto_venta: number | null;
    numero_comprobante: number | null;
    cliente_nombre: string;
    cliente_documento: string | null;
    total_centavos: Centavos;
    estado_facturacion: EstadoFacturacionArca;
    cae: string | null;
    cae_vencimiento: string | null;
    arca_ultimo_error: string | null;
    arca_intentos: number;
    estado_venta: 'completada' | 'anulada';
    nota_credito_tipo: string | null;
    nota_credito_cae: string | null;
  }>;

  let emitidosCount = 0;
  let pendientesCount = 0;
  let conErrorCount = 0;
  let montoTotalEmitidoCentavos = 0;
  let montoTotalPendienteCentavos = 0;

  const filtradas: FilaInformeComprobanteArca[] = [];

  for (const r of filas) {
    if (filtros?.desdeIso && r.fecha < filtros.desdeIso) continue;
    if (filtros?.hastaIso && r.fecha > filtros.hastaIso) continue;

    if (r.estado_facturacion === 'emitida') {
      emitidosCount++;
      montoTotalEmitidoCentavos += r.total_centavos;
    } else if (r.estado_facturacion === 'pendiente') {
      pendientesCount++;
      montoTotalPendienteCentavos += r.total_centavos;
    } else if (r.estado_facturacion === 'error') {
      conErrorCount++;
    }

    if (
      filtros?.estadoFacturacion &&
      filtros.estadoFacturacion !== 'todos' &&
      r.estado_facturacion !== filtros.estadoFacturacion
    ) {
      continue;
    }

    filtradas.push({
      venta_id: r.venta_id,
      fecha: r.fecha,
      tipo_comprobante: r.tipo_comprobante,
      numero_formateado:
        r.punto_venta && r.numero_comprobante
          ? formatearNumeroComprobanteFiscal(
              r.punto_venta,
              r.numero_comprobante
            )
          : null,
      cliente_nombre: r.cliente_nombre,
      cliente_documento: r.cliente_documento,
      total_centavos: r.total_centavos,
      estado_facturacion: r.estado_facturacion,
      cae: r.cae,
      cae_vencimiento: r.cae_vencimiento,
      arca_ultimo_error: r.arca_ultimo_error,
      arca_intentos: r.arca_intentos,
      estado_venta: r.estado_venta,
      nota_credito_tipo: r.nota_credito_tipo,
      nota_credito_cae: r.nota_credito_cae,
    });
  }

  return {
    comprobantes: filtradas,
    totales: {
      emitidosCount,
      pendientesCount,
      conErrorCount,
      montoTotalEmitidoCentavos,
      montoTotalPendienteCentavos,
    },
  };
}

// ============================================================================
// Extras de Fase 4: Múltiples Listas de Precio, Variantes, Combos y Balanzas
// ============================================================================

export interface ListaPrecioResumen {
  readonly id: string;
  readonly nombre: string;
  readonly es_predeterminada: boolean;
  readonly cantidad_productos_con_precio: number;
}

export function listarListasPrecio(
  db: DatabaseSync,
  comercioId: string
): ListaPrecioResumen[] {
  const filas = db
    .prepare(
      `SELECT
        lp.id,
        lp.nombre,
        lp.es_predeterminada,
        COUNT(pr.id) AS cantidad_productos_con_precio
       FROM listas_precio lp
       LEFT JOIN precios pr
         ON pr.lista_precio_id = lp.id
        AND pr.comercio_id = lp.comercio_id
        AND pr.deleted_at IS NULL
       WHERE lp.comercio_id = ? AND lp.deleted_at IS NULL
       GROUP BY lp.id, lp.nombre, lp.es_predeterminada
       ORDER BY lp.es_predeterminada DESC, lp.nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    nombre: string;
    es_predeterminada: number;
    cantidad_productos_con_precio: number;
  }>;

  return filas.map((f) => ({
    id: f.id,
    nombre: f.nombre,
    es_predeterminada: f.es_predeterminada === 1,
    cantidad_productos_con_precio: f.cantidad_productos_con_precio,
  }));
}

export function crearListaPrecio(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly nombre: string;
    readonly porcentajeSobreMostrador?: number;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const nombreLimpio = params.nombre.trim();
  if (!nombreLimpio) {
    throw new Error('El nombre de la lista de precios es obligatorio.');
  }

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const listaId = generarUuidV7();

    db.prepare(
      `INSERT INTO listas_precio (
        id, comercio_id, nombre, es_predeterminada,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?, 'pendiente')`
    ).run(listaId, actor.comercio_id, nombreLimpio, ahora, ahora, actor.device_id);
    encolarSync(db, 'listas_precio', listaId, 'insert', ahora);

    // Si se indica porcentajeSobreMostrador, copiar precios de la lista predeterminada aplicando el ajuste
    if (params.porcentajeSobreMostrador !== undefined) {
      const factorBp = 10000 + Math.round(params.porcentajeSobreMostrador * 100);
      const baseRows = db
        .prepare(
          `SELECT pr.producto_id, pr.precio_venta
           FROM precios pr
           INNER JOIN listas_precio lp
             ON lp.id = pr.lista_precio_id
            AND lp.comercio_id = pr.comercio_id
            AND lp.es_predeterminada = 1
           WHERE pr.comercio_id = ? AND pr.deleted_at IS NULL`
        )
        .all(actor.comercio_id) as unknown as Array<{
        producto_id: string;
        precio_venta: Centavos;
      }>;

      for (const r of baseRows) {
        const precioId = generarUuidV7();
        const nuevoPrecio = Math.max(
          0,
          Math.round((r.precio_venta * factorBp) / 10000)
        );
        db.prepare(
          `INSERT INTO precios (
            id, comercio_id, producto_id, lista_precio_id, precio_venta,
            created_at, updated_at, deleted_at, device_id, sync_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
        ).run(
          precioId,
          actor.comercio_id,
          r.producto_id,
          listaId,
          nuevoPrecio,
          ahora,
          ahora,
          actor.device_id
        );
        encolarSync(db, 'precios', precioId, 'insert', ahora);
      }
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'lista_precio_crear',
      entidad: 'listas_precio',
      entidad_id: listaId,
      valores_despues: {
        id: listaId,
        nombre: nombreLimpio,
        porcentaje_sobre_mostrador: params.porcentajeSobreMostrador ?? null,
      },
      ahoraIso: ahora,
    });

    return listaId;
  });
}

export function asignarPrecioProductoEnLista(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly productoId: string;
    readonly listaPrecioId: string;
    readonly precioVentaCentavos: Centavos;
  }
): void {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  asegurarCentavos(params.precioVentaCentavos, 'precioVentaCentavos');

  ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const existente = db
      .prepare(
        `SELECT id, precio_venta
         FROM precios
         WHERE comercio_id = ? AND producto_id = ? AND lista_precio_id = ? AND deleted_at IS NULL`
      )
      .get(actor.comercio_id, params.productoId, params.listaPrecioId) as
      | { id: string; precio_venta: Centavos }
      | undefined;

    if (existente) {
      db.prepare(
        `UPDATE precios
         SET precio_venta = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
         WHERE id = ?`
      ).run(params.precioVentaCentavos, ahora, actor.device_id, existente.id);
      encolarSync(db, 'precios', existente.id, 'update', ahora);

      insertarRegistroAuditoria(db, {
        actor,
        accion: 'precio_lista_actualizar',
        entidad: 'precios',
        entidad_id: existente.id,
        valores_antes: { precio_venta: existente.precio_venta },
        valores_despues: {
          lista_precio_id: params.listaPrecioId,
          precio_venta: params.precioVentaCentavos,
        },
        ahoraIso: ahora,
      });
    } else {
      const nuevoId = generarUuidV7();
      db.prepare(
        `INSERT INTO precios (
          id, comercio_id, producto_id, lista_precio_id, precio_venta,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        nuevoId,
        actor.comercio_id,
        params.productoId,
        params.listaPrecioId,
        params.precioVentaCentavos,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'precios', nuevoId, 'insert', ahora);

      insertarRegistroAuditoria(db, {
        actor,
        accion: 'precio_lista_crear',
        entidad: 'precios',
        entidad_id: nuevoId,
        valores_despues: {
          producto_id: params.productoId,
          lista_precio_id: params.listaPrecioId,
          precio_venta: params.precioVentaCentavos,
        },
        ahoraIso: ahora,
      });
    }
  });
}

export interface VarianteProductoResumen {
  readonly id: string;
  readonly producto_id: string;
  readonly producto_nombre: string;
  readonly nombre: string;
  readonly atributo_1: string | null;
  readonly atributo_2: string | null;
  readonly sku_variante: string | null;
  readonly codigo_barras: string | null;
  readonly precio_adicional: Centavos;
  readonly activo: boolean;
}

export function crearVarianteProducto(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly productoId: string;
    readonly nombre: string;
    readonly atributo1?: string | null;
    readonly atributo2?: string | null;
    readonly skuVariante?: string | null;
    readonly codigoBarras?: string | null;
    readonly precioAdicionalCentavos?: Centavos;
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  const precioAdicional = params.precioAdicionalCentavos ?? 0;
  asegurarCentavos(precioAdicional, 'precioAdicionalCentavos');

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const id = generarUuidV7();

    db.prepare(
      `INSERT INTO variantes (
        id, comercio_id, producto_id, nombre, atributo_1, atributo_2,
        sku_variante, codigo_barras, precio_adicional, activo,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      id,
      actor.comercio_id,
      params.productoId,
      params.nombre.trim(),
      params.atributo1?.trim() || null,
      params.atributo2?.trim() || null,
      params.skuVariante?.trim() || null,
      params.codigoBarras?.trim() || null,
      precioAdicional,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'variantes', id, 'insert', ahora);

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'variante_crear',
      entidad: 'variantes',
      entidad_id: id,
      valores_despues: {
        id,
        producto_id: params.productoId,
        nombre: params.nombre.trim(),
        precio_adicional: precioAdicional,
        codigo_barras: params.codigoBarras ?? null,
      },
      ahoraIso: ahora,
    });

    return id;
  });
}

export function listarVariantesComercio(
  db: DatabaseSync,
  comercioId: string,
  productoId?: string
): VarianteProductoResumen[] {
  const filtroProd = productoId ? 'AND v.producto_id = ?' : '';
  const args = productoId ? [comercioId, productoId] : [comercioId];

  const filas = db
    .prepare(
      `SELECT
        v.id,
        v.producto_id,
        p.nombre AS producto_nombre,
        v.nombre,
        v.atributo_1,
        v.atributo_2,
        v.sku_variante,
        v.codigo_barras,
        v.precio_adicional,
        v.activo
       FROM variantes v
       INNER JOIN productos p ON p.id = v.producto_id
       WHERE v.comercio_id = ? AND v.deleted_at IS NULL ${filtroProd}
       ORDER BY p.nombre ASC, v.nombre ASC`
    )
    .all(...args) as unknown as Array<{
    id: string;
    producto_id: string;
    producto_nombre: string;
    nombre: string;
    atributo_1: string | null;
    atributo_2: string | null;
    sku_variante: string | null;
    codigo_barras: string | null;
    precio_adicional: Centavos;
    activo: number;
  }>;

  return filas.map((f) => ({
    ...f,
    activo: f.activo === 1,
  }));
}

export interface ComboPromocionResumen {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string | null;
  readonly codigo_barras: string | null;
  readonly precio_venta: Centavos;
  readonly precio_suma_normal: Centavos;
  readonly ahorro_centavos: Centavos;
  readonly porcentaje_descuento: number;
  readonly stock_combos_disponibles: number;
  readonly items: readonly {
    readonly producto_id: string;
    readonly producto_nombre: string;
    readonly cantidad: number;
    readonly precio_unitario_normal: Centavos;
    readonly stock_actual: number;
  }[];
}

export function crearComboPromocion(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly nombre: string;
    readonly descripcion?: string | null;
    readonly codigoBarras?: string | null;
    readonly precioVentaCentavos: Centavos;
    readonly alicuotaIva?: AlicuotaIva;
    readonly exentoIva?: boolean;
    readonly componentes: readonly {
      readonly productoId: string;
      readonly cantidad: number;
    }[];
  }
): string {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');
  asegurarCentavos(params.precioVentaCentavos, 'precioVentaCentavos');
  if (params.componentes.length === 0) {
    throw new Error('Un combo debe incluir al menos un producto componente.');
  }

  return ejecutarEnTransaccion(db, () => {
    const ahora = new Date().toISOString();
    const comboId = generarUuidV7();

    db.prepare(
      `INSERT INTO combos (
        id, comercio_id, nombre, descripcion, codigo_barras,
        precio_venta, alicuota_iva, exento_iva, activo,
        created_at, updated_at, deleted_at, device_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, 'pendiente')`
    ).run(
      comboId,
      actor.comercio_id,
      params.nombre.trim(),
      params.descripcion?.trim() || null,
      params.codigoBarras?.trim() || null,
      params.precioVentaCentavos,
      params.alicuotaIva ?? 21,
      params.exentoIva ? 1 : 0,
      ahora,
      ahora,
      actor.device_id
    );
    encolarSync(db, 'combos', comboId, 'insert', ahora);

    for (const comp of params.componentes) {
      if (comp.cantidad <= 0) {
        throw new Error('La cantidad de cada componente del combo debe ser > 0.');
      }
      const itemId = generarUuidV7();
      db.prepare(
        `INSERT INTO combos_items (
          id, comercio_id, combo_id, producto_id, cantidad,
          created_at, updated_at, deleted_at, device_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pendiente')`
      ).run(
        itemId,
        actor.comercio_id,
        comboId,
        comp.productoId,
        comp.cantidad,
        ahora,
        ahora,
        actor.device_id
      );
      encolarSync(db, 'combos_items', itemId, 'insert', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'combo_crear',
      entidad: 'combos',
      entidad_id: comboId,
      valores_despues: {
        id: comboId,
        nombre: params.nombre.trim(),
        precio_venta: params.precioVentaCentavos,
        componentes: params.componentes,
      },
      ahoraIso: ahora,
    });

    return comboId;
  });
}

export function eliminarComboPromocion(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly comboId: string;
    readonly motivo?: string;
  }
): void {
  exigirPermiso(actor.rol, 'abm_productos_precios_stock_compras');

  ejecutarEnTransaccion(db, () => {
    const existente = db
      .prepare(
        `SELECT id, nombre, precio_venta
         FROM combos
         WHERE id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .get(params.comboId, actor.comercio_id) as
      | { id: string; nombre: string; precio_venta: Centavos }
      | undefined;

    if (!existente) {
      throw new Error('Combo no encontrado o ya eliminado.');
    }

    const ahora = new Date().toISOString();
    db.prepare(
      `UPDATE combos
       SET activo = 0, deleted_at = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
       WHERE id = ? AND comercio_id = ?`
    ).run(ahora, ahora, actor.device_id, params.comboId, actor.comercio_id);
    encolarSync(db, 'combos', params.comboId, 'delete_logico', ahora);

    const itemsCombo = db
      .prepare(
        `SELECT id FROM combos_items
         WHERE combo_id = ? AND comercio_id = ? AND deleted_at IS NULL`
      )
      .all(params.comboId, actor.comercio_id) as unknown as { id: string }[];

    for (const item of itemsCombo) {
      db.prepare(
        `UPDATE combos_items
         SET deleted_at = ?, updated_at = ?, device_id = ?, sync_status = 'pendiente'
         WHERE id = ? AND comercio_id = ?`
      ).run(ahora, ahora, actor.device_id, item.id, actor.comercio_id);
      encolarSync(db, 'combos_items', item.id, 'delete_logico', ahora);
    }

    insertarRegistroAuditoria(db, {
      actor,
      accion: 'combo_eliminar',
      entidad: 'combos',
      entidad_id: params.comboId,
      valores_antes: {
        nombre: existente.nombre,
        precio_venta: existente.precio_venta,
        activo: 1,
      },
      valores_despues: {
        activo: 0,
        deleted_at: ahora,
      },
      motivo: params.motivo ?? 'Baja lógica de combo promocional',
      ahoraIso: ahora,
    });
  });
}

export function listarCombosComercio(
  db: DatabaseSync,
  comercioId: string
): ComboPromocionResumen[] {
  const combosRows = db
    .prepare(
      `SELECT id, nombre, descripcion, codigo_barras, precio_venta
       FROM combos
       WHERE comercio_id = ? AND deleted_at IS NULL AND activo = 1
       ORDER BY nombre ASC`
    )
    .all(comercioId) as unknown as Array<{
    id: string;
    nombre: string;
    descripcion: string | null;
    codigo_barras: string | null;
    precio_venta: Centavos;
  }>;

  return combosRows.map((c) => {
    const itemsRows = db
      .prepare(
        `SELECT
          ci.producto_id,
          p.nombre AS producto_nombre,
          ci.cantidad,
          COALESCE(v.precio_venta, 0) AS precio_unitario_normal
         FROM combos_items ci
         INNER JOIN productos p ON p.id = ci.producto_id
         LEFT JOIN vista_productos_venta v
           ON v.id = ci.producto_id AND v.comercio_id = ci.comercio_id
         WHERE ci.comercio_id = ? AND ci.combo_id = ? AND ci.deleted_at IS NULL`
      )
      .all(comercioId, c.id) as unknown as Array<{
      producto_id: string;
      producto_nombre: string;
      cantidad: number;
      precio_unitario_normal: Centavos;
    }>;

    const itemsConStock = itemsRows.map((it) => {
      const stockActual = obtenerStockProducto(db, comercioId, it.producto_id);
      return {
        ...it,
        stock_actual: stockActual,
      };
    });

    const calculo = calcularPrecioYStockCombo({
      precioComboCentavos: c.precio_venta,
      componentes: itemsConStock.map((it) => ({
        productoId: it.producto_id,
        nombreProducto: it.producto_nombre,
        cantidadPorCombo: it.cantidad,
        precioUnitarioNormalCentavos: it.precio_unitario_normal,
        stockActualComponente: it.stock_actual,
      })),
    });

    return {
      id: c.id,
      nombre: c.nombre,
      descripcion: c.descripcion,
      codigo_barras: c.codigo_barras,
      precio_venta: c.precio_venta,
      precio_suma_normal: calculo.precioSumaNormalCentavos,
      ahorro_centavos: calculo.ahorroCentavos,
      porcentaje_descuento: calculo.porcentajeDescuento,
      stock_combos_disponibles: calculo.stockCombosDisponibles,
      items: itemsConStock,
    };
  });
}

/**
 * Registra la venta de un Combo descontando automáticamente el stock de todos sus
 * productos componentes mediante movimientos de stock `venta` y aplicando la bonificación
 * del combo como descuento global exacto en centavos.
 */
export function venderComboPromocion(
  db: DatabaseSync,
  actor: ActorContexto,
  params: {
    readonly comboId: string;
    readonly cantidadCombos: number;
    readonly pagos: readonly { medio: MedioPago; monto: Centavos }[];
    readonly clienteId?: string;
    readonly cajaSesionId?: string;
  }
): ReturnType<typeof registrarVenta> {
  if (!Number.isInteger(params.cantidadCombos) || params.cantidadCombos <= 0) {
    throw new Error('La cantidad de combos a vender debe ser un entero positivo.');
  }

  const combos = listarCombosComercio(db, actor.comercio_id);
  const combo = combos.find((c) => c.id === params.comboId);
  if (!combo) {
    throw new Error('Combo no encontrado o inactivo.');
  }

  const itemsExpandidos = combo.items.map((it) => ({
    productoId: it.producto_id,
    cantidad: it.cantidad * params.cantidadCombos,
  }));

  const descuentoGlobalCombo = combo.ahorro_centavos * params.cantidadCombos;

  return registrarVenta(db, actor, {
    items: itemsExpandidos,
    descuentoGlobalCentavos: descuentoGlobalCombo,
    pagos: params.pagos,
    clienteId: params.clienteId,
    cajaSesionId: params.cajaSesionId,
  });
}

/**
 * Resuelve un código de barras escaneado verificando si corresponde a una etiqueta
 * EAN-13 de balanza (prefijo `20` con peso en gramos o `21` con importe) y devuelve
 * el producto proyectado sin costos (Regla 20) junto con la cantidad exacta a cargar en el carrito.
 */
export function resolverEscaneoBalanzaEnCatalogo(
  db: DatabaseSync,
  comercioId: string,
  codigoBarras: string
): {
  readonly encontrado: boolean;
  readonly esBalanza: boolean;
  readonly producto?: {
    readonly id: string;
    readonly nombre: string;
    readonly unidad: string;
    readonly permite_decimales: boolean;
    readonly precio_venta: Centavos;
    readonly alicuota_iva: AlicuotaIva;
    readonly exento_iva: boolean;
  };
  readonly cantidadDetectada?: number;
} {
  const balanza = parsearCodigoBarrasBalanza(codigoBarras);
  if (!balanza.esCodigoBalanza || !balanza.codigoPlu) {
    return { encontrado: false, esBalanza: false };
  }

  const pluSinCeros = String(Number(balanza.codigoPlu));
  const fila = db
    .prepare(
      `SELECT
        v.id,
        v.nombre,
        v.unidad,
        v.permite_decimales,
        v.precio_venta,
        v.alicuota_iva,
        v.exento_iva
       FROM vista_productos_venta v
       WHERE v.comercio_id = ?
         AND v.activo = 1
         AND (
           v.codigo_interno = ?
           OR v.codigo_interno = ?
           OR EXISTS (
             SELECT 1 FROM codigos_barras cb
             WHERE cb.comercio_id = v.comercio_id
               AND cb.producto_id = v.id
               AND cb.deleted_at IS NULL
               AND (cb.codigo = ? OR cb.codigo = ?)
           )
         )
       LIMIT 1`
    )
    .get(
      comercioId,
      balanza.codigoPlu,
      pluSinCeros,
      balanza.codigoPlu,
      pluSinCeros
    ) as
    | {
        id: string;
        nombre: string;
        unidad: string;
        permite_decimales: number;
        precio_venta: Centavos;
        alicuota_iva: AlicuotaIva;
        exento_iva: number;
      }
    | undefined;

  if (!fila) {
    return { encontrado: false, esBalanza: true };
  }

  let cantidadDetectada = 1;
  if (balanza.modo === 'peso' && balanza.cantidadKg) {
    cantidadDetectada = balanza.cantidadKg;
  } else if (
    balanza.modo === 'importe' &&
    balanza.importeCentavos &&
    fila.precio_venta > 0
  ) {
    cantidadDetectada = Number(
      (balanza.importeCentavos / fila.precio_venta).toFixed(3)
    );
  }

  return {
    encontrado: true,
    esBalanza: true,
    producto: {
      id: fila.id,
      nombre: fila.nombre,
      unidad: fila.unidad,
      permite_decimales: fila.permite_decimales === 1,
      precio_venta: fila.precio_venta,
      alicuota_iva: fila.alicuota_iva,
      exento_iva: fila.exento_iva === 1,
    },
    cantidadDetectada,
  };
}
