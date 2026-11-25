import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { iniciarServidorHttpPosLocal } from '../servidor_http_standalone.ts';
import {
  cerrarConexionLocalDisco,
  limpiarSesionesLocalesParaTest,
} from '../servidor_local_dev.ts';

describe('Servidor HTTP standalone para Tauri', () => {
  const dirsTemporales: string[] = [];

  afterEach(() => {
    cerrarConexionLocalDisco();
    limpiarSesionesLocalesParaTest();
    for (const dir of dirsTemporales.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rechaza peticiones sin X-POS-Boot-Token y ejecuta el asistente de primer uso en carpeta limpia', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-standalone-'));
    dirsTemporales.push(tempDir);

    const bootToken = 'token-prueba-segura-123456';
    const servidor = await iniciarServidorHttpPosLocal({
      dataDir: tempDir,
      port: 0,
      bootToken,
    });

    try {
      const baseUrl = `http://127.0.0.1:${servidor.port}`;

      // 1. Healthcheck responde OK
      const respHealth = await fetch(`${baseUrl}/api/pos-health`);
      expect(respHealth.status).toBe(200);

      // 2. Sin bootToken debe rechazar con 401
      const respSinToken = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: 'obtener_estado_arranque', payload: {} }),
      });
      expect(respSinToken.status).toBe(401);

      // 3. Con bootToken en base vacía debe pedir Configuración Inicial
      const respArranque1 = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POS-Boot-Token': bootToken,
        },
        body: JSON.stringify({ accion: 'obtener_estado_arranque', payload: {} }),
      });
      expect(respArranque1.status).toBe(200);
      const json1 = (await respArranque1.json()) as {
        ok: boolean;
        data: { requiereConfiguracionInicial: boolean; rutaBaseDatos: string };
      };
      expect(json1.ok).toBe(true);
      expect(json1.data.requiereConfiguracionInicial).toBe(true);
      expect(json1.data.rutaBaseDatos).toContain(tempDir);

      // 4. Inicializar primer superadmin desde el asistente
      const respInit = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POS-Boot-Token': bootToken,
        },
        body: JSON.stringify({
          accion: 'inicializar_primer_superadmin',
          payload: {
            nombreComercio: 'Kiosco Prueba',
            cuit: '',
            condicionIva: 'monotributo',
            nombreAdmin: 'Admin Prueba',
            usuarioAdmin: 'admin',
            claveAdmin: 'ClaveSegura123',
          },
        }),
      });
      expect(respInit.status).toBe(200);
      const jsonInit = (await respInit.json()) as {
        ok: boolean;
        data: { sessionToken: string; operadorActual: { rol: string } };
      };
      expect(jsonInit.ok).toBe(true);
      expect(jsonInit.data.sessionToken).toBeTruthy();
      expect(jsonInit.data.operadorActual.rol).toBe('superadmin');

      // 5. Al consultar nuevamente, ya no requiere configuración inicial
      const respArranque2 = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POS-Boot-Token': bootToken,
        },
        body: JSON.stringify({ accion: 'obtener_estado_arranque', payload: {} }),
      });
      const json2 = (await respArranque2.json()) as {
        ok: boolean;
        data: { requiereConfiguracionInicial: boolean };
      };
      expect(json2.ok).toBe(true);
      expect(json2.data.requiereConfiguracionInicial).toBe(false);

      // 6. Simulación exacta de WebView2 Tauri (Origin: http://tauri.localhost + Sec-Fetch-Site: cross-site)
      const respPreflightTauri = await fetch(`${baseUrl}/api/pos`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://tauri.localhost',
          'Sec-Fetch-Site': 'cross-site',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'content-type, x-pos-boot-token, x-pos-session',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(respPreflightTauri.status).toBe(204);
      expect(
        respPreflightTauri.headers.get('access-control-allow-origin')
      ).toBe('http://tauri.localhost');
      expect(
        respPreflightTauri.headers.get('access-control-allow-private-network')
      ).toBe('true');

      const respPostTauri = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: {
          Origin: 'http://tauri.localhost',
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
          'X-POS-Boot-Token': bootToken,
        },
        body: JSON.stringify({ accion: 'obtener_estado_arranque', payload: {} }),
      });
      expect(respPostTauri.status).toBe(200);

      // 7. Etiqueta <img> en WebView2 (sin Origin, con Sec-Fetch-Site: cross-site y ?bt= + ?st=)
      const respImgTauri = await fetch(
        `${baseUrl}/api/pos-imagen/01900000-0000-7000-8000-000000000001_thumb.webp?bt=${encodeURIComponent(bootToken)}&st=${encodeURIComponent(jsonInit.data.sessionToken)}`,
        {
          headers: {
            'Sec-Fetch-Site': 'cross-site',
          },
        }
      );
      // Debe pasar los filtros 403/401 y devolver 404 (imagen no existe en disco)
      expect(respImgTauri.status).toBe(404);
    } finally {
      await servidor.cerrar();
    }
  });
});
