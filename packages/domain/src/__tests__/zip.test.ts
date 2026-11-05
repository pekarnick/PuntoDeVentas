import { describe, expect, it } from 'vitest';
import {
  generarIndexRaizRedireccion,
  generarNetlifyHeadersAntiIndexacion,
  generarNetlifyRedirects,
  generarRobotsTxtAntiIndexacion,
  validarTokenNetlify,
} from '../despliegue_web.ts';
import { crearArchivoZip } from '../../../../src/sync/zip_ligero.ts';

describe('Utilidades de despliegue web, anti-indexación y empaquetado ZIP', () => {
  it('valida tokens de Netlify correctamente', () => {
    expect(validarTokenNetlify(null).valido).toBe(false);
    expect(validarTokenNetlify('').valido).toBe(false);
    expect(validarTokenNetlify('12345').valido).toBe(false);
    expect(validarTokenNetlify('token con espacios 123456789012345').valido).toBe(false);

    const tokenValido = 'nfp_Test1234567890abcdefghijklmnopqrstuvwxyz';
    expect(validarTokenNetlify(tokenValido).valido).toBe(true);
  });

  it('genera robots.txt que bloquea a todos los motores de búsqueda', () => {
    const robots = generarRobotsTxtAntiIndexacion();
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow: /');
  });

  it('genera headers de Netlify con X-Robots-Tag noindex y directivas de seguridad', () => {
    const headers = generarNetlifyHeadersAntiIndexacion();
    expect(headers).toContain('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex, nocache');
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
  });

  it('genera reglas de redirección para la PWA de venta móvil', () => {
    const redirects = generarNetlifyRedirects();
    expect(redirects).toContain('/api/pos');
    expect(redirects).toContain('/web-pos/*');
    expect(redirects).toContain('/web-pos');
  });

  it('genera página raíz index.html con redirección y meta tags noindex', () => {
    const html = generarIndexRaizRedireccion();
    expect(html).toContain('meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex"');
    expect(html).toContain('http-equiv="refresh" content="0; url=/web-pos/"');
  });

  it('crea un archivo ZIP válido con compresión Deflate y sumas CRC-32', () => {
    const archivos = [
      {
        nombre: 'robots.txt',
        contenido: generarRobotsTxtAntiIndexacion(),
      },
      {
        nombre: 'web-pos/index.html',
        contenido: '<html><body>PWA Venta Movil</body></html>',
      },
      {
        nombre: '_headers',
        contenido: generarNetlifyHeadersAntiIndexacion(),
      },
    ];

    const zipBuffer = crearArchivoZip(archivos);
    expect(zipBuffer).toBeInstanceOf(Buffer);
    expect(zipBuffer.length).toBeGreaterThan(100);

    // Firma PKZip (0x04034b50)
    expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);

    // Fin de directorio central (EOCD signature 0x06054b50)
    const posEocd = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(posEocd).toBeGreaterThan(0);
    expect(zipBuffer.readUInt16LE(posEocd + 10)).toBe(3); // 3 archivos en el zip
  });
});
