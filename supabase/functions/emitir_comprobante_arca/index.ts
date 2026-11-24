/**
 * Supabase Edge Function: `emitir_comprobante_arca` (PLAN.md §3 Reglas 18 y 19, §6.3 y §11).
 *
 * - Las credenciales y certificados digitales de ARCA / proveedor de terceros (Afip SDK / TusFacturas)
 *   viven EXCLUSIVAMENTE como secretos del servidor en Supabase (`Deno.env.get(...)`), jamás en el
 *   cliente de escritorio, ni en `/web-pos`, ni en el repositorio.
 * - Tanto el POS de escritorio como la PWA móvil invocan esta función con su sesión autenticada.
 * - Soporta los ambientes `homologacion` (pruebas, por defecto) y `produccion`.
 */

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

export interface SolicitudEmisionArcaEdge {
  readonly venta_id: string;
  readonly comercio_id: string;
  readonly cuit_emisor: string;
  readonly condicion_iva_emisor:
    | 'monotributo'
    | 'responsable_inscripto'
    | 'exento'
    | 'consumidor_final';
  readonly punto_venta: number;
  readonly tipo_comprobante:
    | 'factura_a'
    | 'factura_b'
    | 'factura_c'
    | 'nota_credito_a'
    | 'nota_credito_b'
    | 'nota_credito_c';
  readonly numero_comprobante: number;
  readonly ambiente: 'homologacion' | 'produccion';
  readonly proveedor: 'afip_sdk' | 'tus_facturas' | 'simulador_homologacion';
  readonly total_centavos: number;
  readonly neto_centavos: number;
  readonly iva_centavos: number;
  readonly receptor_tipo_doc: 80 | 96 | 99;
  readonly receptor_nro_doc: number;
  readonly comprobante_asociado_nro?: number | null;
}

export interface RespuestaEmisionArcaEdge {
  readonly ok: boolean;
  readonly venta_id: string;
  readonly ambiente: 'homologacion' | 'produccion';
  readonly tipo_comprobante: string;
  readonly punto_venta: number;
  readonly numero_comprobante: number;
  readonly cae: string;
  readonly cae_vencimiento: string;
  readonly error?: string;
}

const CABECERAS_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function calcularCaeDeterministicoHomologacion(
  ventaId: string,
  puntoVenta: number,
  numeroComprobante: number
): string {
  let acc = 74000000000000n;
  for (let i = 0; i < ventaId.length; i++) {
    acc += BigInt(ventaId.charCodeAt(i) * (i + 17));
  }
  acc += BigInt(puntoVenta * 100000 + numeroComprobante);
  return String(acc).slice(0, 14).padEnd(14, '0');
}

function calcularVencimientoCaeDiezDias(desde = new Date()): string {
  const vto = new Date(desde.getTime() + 10 * 24 * 60 * 60 * 1000);
  return vto.toISOString().slice(0, 10);
}

export async function procesarSolicitudEmisionArcaEdge(
  body: SolicitudEmisionArcaEdge,
  envGetter: (k: string) => string | undefined = (k) =>
    typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined
): Promise<RespuestaEmisionArcaEdge> {
  if (!body.venta_id || !body.cuit_emisor || !body.tipo_comprobante) {
    return {
      ok: false,
      venta_id: body.venta_id ?? '',
      ambiente: body.ambiente ?? 'homologacion',
      tipo_comprobante: body.tipo_comprobante ?? 'factura_c',
      punto_venta: body.punto_venta ?? 1,
      numero_comprobante: body.numero_comprobante ?? 1,
      cae: '',
      cae_vencimiento: '',
      error: 'Faltan datos obligatorios del comprobante para emitir en ARCA.',
    };
  }

  // En producción, nunca devolver CAE simulado ni permitir simulador_homologacion
  if (body.ambiente === 'produccion') {
    if (body.proveedor === 'simulador_homologacion') {
      return {
        ok: false,
        venta_id: body.venta_id,
        ambiente: body.ambiente,
        tipo_comprobante: body.tipo_comprobante,
        punto_venta: body.punto_venta,
        numero_comprobante: body.numero_comprobante,
        cae: '',
        cae_vencimiento: '',
        error:
          'ARCA_PROVEEDOR_INVALIDO: El simulador de homologación está prohibido en ambiente de producción.',
      };
    }

    const apiTokenSecreto = envGetter('ARCA_PROVIDER_API_TOKEN');
    const certPemSecreto = envGetter('ARCA_CERT_PEM');
    const keyPemSecreto = envGetter('ARCA_KEY_PEM');
    const providerEndpoint = envGetter('ARCA_PROVIDER_ENDPOINT');

    if (
      (!apiTokenSecreto && (!certPemSecreto || !keyPemSecreto)) ||
      !providerEndpoint
    ) {
      return {
        ok: false,
        venta_id: body.venta_id,
        ambiente: body.ambiente,
        tipo_comprobante: body.tipo_comprobante,
        punto_venta: body.punto_venta,
        numero_comprobante: body.numero_comprobante,
        cae: '',
        cae_vencimiento: '',
        error:
          'ARCA_SECRETOS_FALTANTES: Los secretos de producción (ARCA_PROVIDER_ENDPOINT y ARCA_PROVIDER_API_TOKEN / ARCA_CERT_PEM + ARCA_KEY_PEM) no están configurados en la Edge Function.',
      };
    }

    try {
      const respProveedor = await fetch(providerEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiTokenSecreto
            ? { Authorization: `Bearer ${apiTokenSecreto}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      const dataProv = (await respProveedor.json()) as Partial<RespuestaEmisionArcaEdge>;
      if (!respProveedor.ok || !dataProv.ok || !dataProv.cae) {
        return {
          ok: false,
          venta_id: body.venta_id,
          ambiente: body.ambiente,
          tipo_comprobante: body.tipo_comprobante,
          punto_venta: body.punto_venta,
          numero_comprobante: body.numero_comprobante,
          cae: '',
          cae_vencimiento: '',
          error:
            dataProv.error ||
            `ARCA_PROVEEDOR_ERROR: El proveedor devolvió HTTP ${respProveedor.status}.`,
        };
      }
      return {
        ok: true,
        venta_id: body.venta_id,
        ambiente: body.ambiente,
        tipo_comprobante: body.tipo_comprobante,
        punto_venta: dataProv.punto_venta ?? body.punto_venta,
        numero_comprobante: dataProv.numero_comprobante ?? body.numero_comprobante,
        cae: dataProv.cae,
        cae_vencimiento:
          dataProv.cae_vencimiento ?? calcularVencimientoCaeDiezDias(),
      };
    } catch (err) {
      return {
        ok: false,
        venta_id: body.venta_id,
        ambiente: body.ambiente,
        tipo_comprobante: body.tipo_comprobante,
        punto_venta: body.punto_venta,
        numero_comprobante: body.numero_comprobante,
        cae: '',
        cae_vencimiento: '',
        error:
          err instanceof Error
            ? `ARCA_RED_ERROR: ${err.message}`
            : 'ARCA_RED_ERROR: No se pudo contactar al proveedor fiscal de producción.',
      };
    }
  }

  // Solo en ambiente de homologación se permite CAE determinístico de pruebas
  const cae = calcularCaeDeterministicoHomologacion(
    body.venta_id,
    body.punto_venta,
    body.numero_comprobante
  );
  const caeVencimiento = calcularVencimientoCaeDiezDias();

  return {
    ok: true,
    venta_id: body.venta_id,
    ambiente: body.ambiente,
    tipo_comprobante: body.tipo_comprobante,
    punto_venta: body.punto_venta,
    numero_comprobante: body.numero_comprobante,
    cae,
    cae_vencimiento: caeVencimiento,
  };
}

async function verificarUsuarioJwtSupabase(
  authHeader: string,
  comercioId: string
): Promise<{ ok: boolean; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/+$/, '');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      ok: false,
      error: 'Configuración incompleta de SUPABASE_URL / SUPABASE_ANON_KEY en Edge Function.',
    };
  }

  const respUser = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: authHeader,
    },
  });
  if (!respUser.ok) {
    return { ok: false, error: 'JWT inválido o expirado en Supabase Auth.' };
  }
  const userJson = (await respUser.json()) as { id?: string };
  if (!userJson.id) {
    return { ok: false, error: 'Usuario autenticado sin identificador.' };
  }

  const respPerfil = await fetch(
    `${supabaseUrl}/rest/v1/usuarios?comercio_id=eq.${encodeURIComponent(comercioId)}&or=(id.eq.${encodeURIComponent(userJson.id)},auth_user_id.eq.${encodeURIComponent(userJson.id)})&activo=eq.true&deleted_at=is.null&select=id,rol&limit=1`,
    {
      method: 'GET',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: authHeader,
      },
    }
  );
  if (!respPerfil.ok) {
    return { ok: false, error: 'No se pudo verificar la pertenencia al comercio.' };
  }
  const filas = (await respPerfil.json()) as Array<{ id: string; rol: string }>;
  if (!Array.isArray(filas) || filas.length === 0) {
    return {
      ok: false,
      error: 'ACCESO_DENEGADO: El usuario no pertenece al comercio indicado o está inactivo.',
    };
  }
  return { ok: true };
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: CABECERAS_CORS });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'No autorizado: se requiere sesión autenticada (Bearer JWT).',
        }),
        { status: 401, headers: CABECERAS_CORS }
      );
    }

    try {
      const payload = (await req.json()) as SolicitudEmisionArcaEdge;
      const verif = await verificarUsuarioJwtSupabase(authHeader, payload.comercio_id);
      if (!verif.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: verif.error ?? 'No autorizado.' }),
          { status: 403, headers: CABECERAS_CORS }
        );
      }
      const resultado = await procesarSolicitudEmisionArcaEdge(payload);
      return new Response(JSON.stringify(resultado), {
        status: resultado.ok ? 200 : 422,
        headers: CABECERAS_CORS,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Error interno en Edge Function emitir_comprobante_arca',
        }),
        { status: 500, headers: CABECERAS_CORS }
      );
    }
  });
}
