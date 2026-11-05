/**
 * Validaciones y directivas de despliegue web y anti-indexación
 * para hosting estático (Netlify / Cloudflare Pages).
 * Funciones puras independientes del entorno de ejecución.
 */

/**
 * Valida el formato del Personal Access Token de Netlify.
 * Los tokens oficiales de Netlify comienzan con el prefijo "nfp_" o son cadenas alfanuméricas de al menos 20 caracteres.
 */
export function validarTokenNetlify(token: string | null | undefined): {
  readonly valido: boolean;
  readonly motivo?: string;
} {
  if (!token || typeof token !== 'string') {
    return { valido: false, motivo: 'El token de Netlify es obligatorio.' };
  }
  const limpio = token.trim();
  if (limpio.length < 20) {
    return {
      valido: false,
      motivo: 'El token de Netlify es demasiado corto (mínimo 20 caracteres).',
    };
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(limpio)) {
    return {
      valido: false,
      motivo: 'El token de Netlify contiene caracteres inválidos.',
    };
  }
  return { valido: true };
}

/**
 * Genera el archivo robots.txt que bloquea a todos los rastreadores y motores de búsqueda.
 */
export function generarRobotsTxtAntiIndexacion(): string {
  return [
    '# Bloqueo total de indexación para el sistema de Venta Móvil',
    'User-agent: *',
    'Disallow: /',
    '',
  ].join('\n');
}

/**
 * Genera el archivo _headers de Netlify para inyectar cabeceras HTTP anti-indexación y seguridad.
 */
export function generarNetlifyHeadersAntiIndexacion(): string {
  return [
    '/*',
    '  X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex, nocache',
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(self), geolocation=(), microphone=()',
    '',
  ].join('\n');
}

/**
 * Genera las reglas de redirección de Netlify (_redirects) para Single Page Applications (PWA).
 */
export function generarNetlifyRedirects(): string {
  return [
    '# Redirección de API y Single Page App para PWA Venta Móvil',
    '/api/pos        /.netlify/functions/pos  200',
    '/web-pos/*      /web-pos/index.html      200',
    '/web-pos        /web-pos/index.html      200',
    '/*              /web-pos/index.html      200',
    '',
  ].join('\n');
}

/**
 * Genera el archivo index.html para la raíz del hosting que redirige inmediatamente a /web-pos/.
 */
export function generarIndexRaizRedireccion(): string {
  return `<!doctype html>
<html lang="es-AR">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex" />
    <meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex" />
    <meta http-equiv="refresh" content="0; url=/web-pos/" />
    <title>Venta Móvil</title>
  </head>
  <body style="font-family: system-ui, sans-serif; background:#0f172a; color:#f8fafc; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
    <p>Redirigiendo a <a href="/web-pos/" style="color:#38bdf8;">Venta Móvil</a>...</p>
  </body>
</html>
`;
}
