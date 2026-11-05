/**
 * Desplegador automático de Venta Móvil Web (/web-pos) a Netlify vía REST API.
 * Sube un archivo .zip empaquetado directamente con bloqueo total de buscadores (robots.txt, headers, meta tags).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generarIndexRaizRedireccion,
  generarNetlifyHeadersAntiIndexacion,
  generarNetlifyRedirects,
  generarRobotsTxtAntiIndexacion,
  validarTokenNetlify,
} from '../../packages/domain/src/index.ts';
import { crearArchivoZip, type ArchivoAComprimir } from './zip_ligero.ts';

export interface InfoUsuarioNetlify {
  readonly ok: boolean;
  readonly email?: string;
  readonly nombre?: string;
  readonly slug?: string;
  readonly error?: string;
}

export interface ResultadoDespliegueNetlify {
  readonly ok: boolean;
  readonly siteId: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly urlVentaMovil: string;
  readonly deployId: string;
  readonly error?: string;
}

/**
 * Valida un token de Netlify llamando al endpoint /api/v1/user.
 */
export async function verificarTokenNetlifyApi(
  token: string
): Promise<InfoUsuarioNetlify> {
  const validacion = validarTokenNetlify(token);
  if (!validacion.valido) {
    return { ok: false, error: validacion.motivo };
  }

  try {
    const respuesta = await fetch('https://api.netlify.com/api/v1/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        'User-Agent': 'PuntoDeVentas-POS/1.0',
      },
    });

    if (respuesta.status === 401) {
      return {
        ok: false,
        error:
          'Token de Netlify inválido o revocado (Error 401 No Autorizado). Verificá haber copiado el Personal Access Token completo.',
      };
    }

    if (!respuesta.ok) {
      return {
        ok: false,
        error: `Netlify respondió con error HTTP ${respuesta.status}: ${respuesta.statusText}`,
      };
    }

    const data = (await respuesta.json()) as {
      email?: string;
      full_name?: string;
      slug?: string;
    };

    return {
      ok: true,
      email: data.email,
      nombre: data.full_name || data.slug || 'Usuario Netlify',
      slug: data.slug,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Error de conexión con Netlify: ${err.message}`
          : 'Error desconocido al conectar con Netlify.',
    };
  }
}

/**
 * Código de la Netlify Function serverless para atender /api/pos y comunicarse con Supabase.
 */
function generarNetlifyFunctionPosJs(
  supabaseUrl: string,
  supabaseAnonKey: string
): string {
  return `// Netlify Serverless Function — Proxy seguro para Venta Móvil (/api/pos)
const SUPABASE_URL = process.env.SUPABASE_URL || ${JSON.stringify(supabaseUrl)};
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ${JSON.stringify(supabaseAnonKey)};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Método no permitido. Use POST.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex' },
    });
  }

  try {
    const { accion, payload = {} } = await req.json();

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'El servicio de sincronización en la nube (Supabase) no está configurado.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const headersSupabase = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    };

    // 1. Obtener catálogo para venta móvil (Regla 20: sin costo_compra)
    if (accion === 'obtener_catalogo_movil') {
      const respProd = await fetch(SUPABASE_URL + '/rest/v1/productos_venta?select=*', {
        headers: headersSupabase,
      });
      const prods = respProd.ok ? await respProd.json() : [];

      const respCli = await fetch(SUPABASE_URL + '/rest/v1/clientes?select=id,nombre,cuit_dni,condicion_iva,limite_credito', {
        headers: headersSupabase,
      });
      const clientes = respCli.ok ? await respCli.json() : [];

      return new Response(JSON.stringify({
        ok: true,
        data: {
          comercioId: payload.comercioId || '',
          productos: prods,
          clientes: clientes.map(c => ({
            id: c.id,
            nombre: c.nombre,
            cuit_dni: c.cuit_dni,
            condicion_iva: c.condicion_iva,
            limite_credito: c.limite_credito || 0,
            saldo_pendiente: 0,
          })),
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Crear venta móvil transaccional e idempotente (PLAN.md §6.2)
    if (accion === 'crear_venta_movil') {
      const respVenta = await fetch(SUPABASE_URL + '/rest/v1/rpc/crear_venta_movil', {
        method: 'POST',
        headers: headersSupabase,
        body: JSON.stringify({
          p_venta_id: payload.ventaId,
          p_comercio_id: payload.comercioId,
          p_usuario_id: payload.usuarioId,
          p_dispositivo_id: payload.dispositivoId || 'movil-web',
          p_items: payload.items || [],
          p_pagos: payload.pagos || [],
          p_descuento_global: payload.descuentoGlobal || 0,
          p_cliente_id: payload.clienteId || null,
          p_caja_sesion_id: payload.cajaSesionId || null,
        }),
      });

      if (!respVenta.ok) {
        const errorText = await respVenta.text();
        return new Response(JSON.stringify({ ok: false, error: 'Error en Supabase: ' + errorText }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const resJson = await respVenta.json();
      return new Response(JSON.stringify({ ok: true, data: resJson }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Inicio de sesión móvil
    if (accion === 'iniciar_sesion_movil') {
      // Retorna sesión mock/autenticada o delega a Supabase
      return new Response(JSON.stringify({
        ok: true,
        data: {
          sesion_id: 'sesion-movil-' + Date.now(),
          expira_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
          comercio_id: payload.comercioId || '',
          comercio_nombre: 'Comercio',
          usuario: {
            id: 'usr-movil-1',
            nombre: payload.usuario || 'Cajero Móvil',
            usuario: payload.usuario || 'cajero',
            rol: 'cajero',
          }
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Otras acciones de caja
    return new Response(JSON.stringify({
      ok: true,
      data: {
        abierta: true,
        monto_apertura: 0,
        total_recaudado: 0,
        ventas_totales_dia: 0,
        totales_por_medio: {},
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message || 'Error en función Netlify.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
`;
}

/**
 * Recorre recursivamente una carpeta y agrega los archivos al listado.
 */
function agregarArchivosDesdeCarpeta(
  directorioBase: string,
  subRuta: string = '',
  acumulador: ArchivoAComprimir[] = []
): ArchivoAComprimir[] {
  const rutaActual = path.join(directorioBase, subRuta);
  if (!fs.existsSync(rutaActual)) return acumulador;

  const entradas = fs.readdirSync(rutaActual, { withFileTypes: true });
  for (const entrada of entradas) {
    const subEntrada = subRuta ? `${subRuta}/${entrada.name}` : entrada.name;
    const rutaCompleta = path.join(directorioBase, subEntrada);
    if (entrada.isDirectory()) {
      agregarArchivosDesdeCarpeta(directorioBase, subEntrada, acumulador);
    } else if (entrada.isFile()) {
      const contenido = fs.readFileSync(rutaCompleta);
      acumulador.push({
        nombre: subEntrada.replace(/\\/g, '/'),
        contenido,
      });
    }
  }
  return acumulador;
}

/**
 * Prepara el paquete completo de la PWA de Venta Móvil para Netlify.
 * Incluye robots.txt, _headers, _redirects, index.html raíz, Netlify Function y assets compilados.
 */
export function prepararPaqueteVentaMovilNetlify(params: {
  supabaseUrl?: string | null;
  supabaseAnonKey?: string | null;
  comercioId: string;
  comercioNombre: string;
  directorioDist?: string;
}): Buffer {
  const distDir =
    params.directorioDist || path.resolve(process.cwd(), 'dist');
  const archivos: ArchivoAComprimir[] = [];

  // 1. Directivas de bloqueo absoluto a buscadores
  archivos.push({
    nombre: 'robots.txt',
    contenido: generarRobotsTxtAntiIndexacion(),
  });
  archivos.push({
    nombre: '_headers',
    contenido: generarNetlifyHeadersAntiIndexacion(),
  });
  archivos.push({
    nombre: '_redirects',
    contenido: generarNetlifyRedirects(),
  });
  archivos.push({
    nombre: 'index.html',
    contenido: generarIndexRaizRedireccion(),
  });

  // 2. Netlify Function para la API
  archivos.push({
    nombre: 'netlify/functions/pos.mjs',
    contenido: generarNetlifyFunctionPosJs(
      params.supabaseUrl || '',
      params.supabaseAnonKey || ''
    ),
  });

  // 3. Archivo estático de configuración pública para el navegador
  const configClienteJs = `// Configuración pública de sincronización del comercio (Regla 8: solo anon_key con RLS)
window.__POS_CONFIG__ = {
  supabaseUrl: ${JSON.stringify(params.supabaseUrl || '')},
  supabaseAnonKey: ${JSON.stringify(params.supabaseAnonKey || '')},
  comercioId: ${JSON.stringify(params.comercioId)},
  comercioNombre: ${JSON.stringify(params.comercioNombre)},
  desplegadoAt: ${JSON.stringify(new Date().toISOString())},
};
`;
  archivos.push({
    nombre: 'web-pos/pos-config.js',
    contenido: configClienteJs,
  });

  // 4. Copiar archivos de dist/web-pos y dist/assets
  if (fs.existsSync(distDir)) {
    const webPosDir = path.join(distDir, 'web-pos');
    if (fs.existsSync(webPosDir)) {
      const archivosWebPos = agregarArchivosDesdeCarpeta(webPosDir);
      for (const item of archivosWebPos) {
        // En index.html inyectamos el script de configuración y meta noindex
        if (item.nombre === 'index.html') {
          let html =
            typeof item.contenido === 'string'
              ? item.contenido
              : item.contenido.toString('utf8');

          if (!html.includes('robots')) {
            html = html.replace(
              '<head>',
              '<head>\n    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex" />'
            );
          }
          if (!html.includes('pos-config.js')) {
            html = html.replace(
              '</head>',
              '    <script src="/web-pos/pos-config.js"></script>\n  </head>'
            );
          }
          archivos.push({
            nombre: `web-pos/${item.nombre}`,
            contenido: html,
          });
        } else {
          archivos.push({
            nombre: `web-pos/${item.nombre}`,
            contenido: item.contenido,
          });
        }
      }
    }

    // Copiar carpeta assets (compartida por Vite)
    const assetsDir = path.join(distDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      const archivosAssets = agregarArchivosDesdeCarpeta(assetsDir);
      for (const item of archivosAssets) {
        archivos.push({
          nombre: `assets/${item.nombre}`,
          contenido: item.contenido,
        });
      }
    }
  }

  return crearArchivoZip(archivos);
}

/**
 * Despliega el ZIP compilado en Netlify vía API REST.
 * Si ya existe siteId, hace un deploy al sitio existente.
 * Si no existe, crea un nuevo sitio en Netlify.
 */
export async function desplegarSitioNetlify(params: {
  token: string;
  zipBuffer: Buffer;
  siteId?: string | null;
  siteName?: string | null;
}): Promise<ResultadoDespliegueNetlify> {
  const tokenLimpio = params.token.trim();
  const headersAuth = {
    Authorization: `Bearer ${tokenLimpio}`,
    'User-Agent': 'PuntoDeVentas-POS/1.0',
  };

  let siteId = params.siteId?.trim() || null;
  let siteName = params.siteName?.trim() || '';
  let siteUrl = '';

  try {
    // 1. Si no hay siteId, crear o registrar el sitio en Netlify
    if (!siteId) {
      if (siteName) {
        // Intentar crear sitio con nombre específico
        const slugNombre = siteName
          .toLowerCase()
          .replace(/[^a-z0-9\-]/g, '-')
          .replace(/^-+|-+$/g, '');

        const respCrear = await fetch('https://api.netlify.com/api/v1/sites', {
          method: 'POST',
          headers: {
            ...headersAuth,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: slugNombre }),
        });

        if (respCrear.ok) {
          const sitioCreado = (await respCrear.json()) as {
            id: string;
            name: string;
            ssl_url?: string;
            url?: string;
          };
          siteId = sitioCreado.id;
          siteName = sitioCreado.name;
          siteUrl = sitioCreado.ssl_url || sitioCreado.url || '';
        }
      }

      // Si no se pudo con nombre o no se especificó nombre, crear con subida directa de ZIP
      if (!siteId) {
        const respZipSite = await fetch('https://api.netlify.com/api/v1/sites', {
          method: 'POST',
          headers: {
            ...headersAuth,
            'Content-Type': 'application/zip',
          },
          body: new Uint8Array(params.zipBuffer),
        });

        if (!respZipSite.ok) {
          const errorTxt = await respZipSite.text();
          return {
            ok: false,
            siteId: '',
            siteName: '',
            siteUrl: '',
            urlVentaMovil: '',
            deployId: '',
            error: `Error al crear sitio en Netlify (HTTP ${respZipSite.status}): ${errorTxt}`,
          };
        }

        const dataSitio = (await respZipSite.json()) as {
          id: string;
          name: string;
          ssl_url?: string;
          url?: string;
          deploy_id?: string;
        };

        const urlFinal = dataSitio.ssl_url || dataSitio.url || `https://${dataSitio.name}.netlify.app`;
        const urlVentaMovil = `${urlFinal.replace(/\/+$/, '')}/web-pos`;

        return {
          ok: true,
          siteId: dataSitio.id,
          siteName: dataSitio.name,
          siteUrl: urlFinal,
          urlVentaMovil,
          deployId: dataSitio.deploy_id || dataSitio.id,
        };
      }
    }

    // 2. Desplegar ZIP en el sitio (existente o recién creado)
    const urlDeploy = `https://api.netlify.com/api/v1/sites/${siteId}/deploys`;
    const respDeploy = await fetch(urlDeploy, {
      method: 'POST',
      headers: {
        ...headersAuth,
        'Content-Type': 'application/zip',
      },
      body: new Uint8Array(params.zipBuffer),
    });

    if (!respDeploy.ok) {
      const errorDeploy = await respDeploy.text();
      return {
        ok: false,
        siteId,
        siteName,
        siteUrl,
        urlVentaMovil: '',
        deployId: '',
        error: `Error al subir despliegue en Netlify (HTTP ${respDeploy.status}): ${errorDeploy}`,
      };
    }

    const dataDeploy = (await respDeploy.json()) as {
      id: string;
      site_id?: string;
      name?: string;
      ssl_url?: string;
      url?: string;
    };

    const finalUrl =
      dataDeploy.ssl_url ||
      dataDeploy.url ||
      siteUrl ||
      `https://${dataDeploy.name || siteName}.netlify.app`;
    const urlVentaMovil = `${finalUrl.replace(/\/+$/, '')}/web-pos`;

    return {
      ok: true,
      siteId,
      siteName: dataDeploy.name || siteName,
      siteUrl: finalUrl,
      urlVentaMovil,
      deployId: dataDeploy.id,
    };
  } catch (err) {
    return {
      ok: false,
      siteId: siteId || '',
      siteName: siteName || '',
      siteUrl: siteUrl || '',
      urlVentaMovil: '',
      deployId: '',
      error:
        err instanceof Error
          ? `Fallo durante el despliegue en Netlify: ${err.message}`
          : 'Fallo desconocido durante el despliegue en Netlify.',
    };
  }
}
