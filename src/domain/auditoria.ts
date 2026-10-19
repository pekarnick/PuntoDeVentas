/**
 * Lógica pura de auditoría con hash encadenado SHA-256 y sanitización de secretos (PLAN.md §3 reglas 13, 14, 16 y §6.1).
 */

import type { RolUsuario } from './permisos.ts';

export const HASH_GENESIS_AUDITORIA = 'GENESIS';

const CAMPOS_PROHIBIDOS_AUDITORIA = new Set([
  'clave',
  'clave_hash',
  'password',
  'password_hash',
  'pin',
  'pin_hash',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'service_role_key',
  'certificado',
  'clave_privada',
]);

export interface DatosContenidoAuditoria {
  readonly id: string;
  readonly comercio_id: string;
  readonly fecha_hora: string;
  readonly usuario_id: string | null;
  readonly usuario_nombre: string;
  readonly rol: RolUsuario | string;
  readonly device_id: string;
  readonly accion: string;
  readonly entidad: string;
  readonly entidad_id: string | null;
  readonly valores_antes: string | null;
  readonly valores_despues: string | null;
  readonly motivo: string | null;
  readonly autorizado_por_id?: string | null;
  readonly autorizado_por_nombre?: string | null;
}

export interface RegistroAuditoriaCompleto extends DatosContenidoAuditoria {
  readonly hash_prev: string;
  readonly hash: string;
}

export interface ResultadoVerificacionAuditoria {
  readonly integra: boolean;
  readonly totalRegistros: number;
  readonly indiceAlterado: number | null;
  readonly registroAlteradoId: string | null;
  readonly motivoFallo: string | null;
}

/**
 * Elimina recursivamente cualquier clave o hash de clave de un objeto antes de serializarlo a JSON (Regla 16).
 */
export function sanitizarValoresAuditoria(
  valores: Record<string, unknown> | null | undefined
): string | null {
  if (valores === null || valores === undefined) {
    return null;
  }

  const limpiar = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map(limpiar);
    }
    if (typeof obj === 'object') {
      const resultado: Record<string, unknown> = {};
      const clavesOrdenadas = Object.keys(obj as Record<string, unknown>).sort();
      for (const k of clavesOrdenadas) {
        if (CAMPOS_PROHIBIDOS_AUDITORIA.has(k.toLowerCase())) {
          continue;
        }
        resultado[k] = limpiar((obj as Record<string, unknown>)[k]);
      }
      return resultado;
    }
    return obj;
  };

  return JSON.stringify(limpiar(valores));
}

/**
 * Implementación pura y sincrónica de SHA-256 (FIPS 180-4) para ejecutar dentro de transacciones SQLite
 * tanto en escritorio como en navegador sin depender de APIs asíncronas.
 */
const K_SHA256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(mensaje: string): string {
  const bytes = new TextEncoder().encode(mensaje);
  const bitLen = bytes.length * 8;

  const totalLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const bloque = new Uint8Array(totalLen);
  bloque.set(bytes);
  bloque[bytes.length] = 0x80;

  const view = new DataView(bloque.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(7, w[i - 15]!) ^ rotr(18, w[i - 15]!) ^ (w[i - 15]! >>> 3);
      const s1 =
        rotr(17, w[i - 2]!) ^ rotr(19, w[i - 2]!) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K_SHA256[i]! + w[i]!) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Construye la representación canónica determinística del contenido de un registro de auditoría.
 */
export function serializarContenidoAuditoria(
  datos: DatosContenidoAuditoria
): string {
  return JSON.stringify({
    id: datos.id,
    comercio_id: datos.comercio_id,
    fecha_hora: datos.fecha_hora,
    usuario_id: datos.usuario_id ?? null,
    usuario_nombre: datos.usuario_nombre,
    rol: datos.rol,
    device_id: datos.device_id,
    accion: datos.accion,
    entidad: datos.entidad,
    entidad_id: datos.entidad_id ?? null,
    valores_antes: datos.valores_antes ?? null,
    valores_despues: datos.valores_despues ?? null,
    motivo: datos.motivo ?? null,
    autorizado_por_id: datos.autorizado_por_id ?? null,
    autorizado_por_nombre: datos.autorizado_por_nombre ?? null,
  });
}

/**
 * Calcula el hash encadenado: SHA-256(hash_prev + contenido_serializado).
 */
export function calcularHashAuditoria(
  datos: DatosContenidoAuditoria,
  hashPrev: string
): string {
  const contenido = serializarContenidoAuditoria(datos);
  return sha256Hex(`${hashPrev}|${contenido}`);
}

/**
 * Recorre la secuencia de registros de auditoría y verifica que ni el contenido ni los eslabones
 * hayan sido alterados ni eliminados (PLAN.md §6.1 y §13).
 */
export function verificarCadenaAuditoria(
  registros: readonly RegistroAuditoriaCompleto[]
): ResultadoVerificacionAuditoria {
  let hashEsperadoPrev = HASH_GENESIS_AUDITORIA;

  for (let i = 0; i < registros.length; i++) {
    const reg = registros[i]!;
    if (reg.hash_prev !== hashEsperadoPrev) {
      return {
        integra: false,
        totalRegistros: registros.length,
        indiceAlterado: i,
        registroAlteradoId: reg.id,
        motivoFallo: `Eslabón roto en registro ${reg.id}: hash_prev esperado "${hashEsperadoPrev}", encontrado "${reg.hash_prev}".`,
      };
    }

    const hashCalculado = calcularHashAuditoria(reg, reg.hash_prev);
    if (reg.hash !== hashCalculado) {
      return {
        integra: false,
        totalRegistros: registros.length,
        indiceAlterado: i,
        registroAlteradoId: reg.id,
        motivoFallo: `Contenido adulterado en registro ${reg.id}: hash esperado "${hashCalculado}", encontrado "${reg.hash}".`,
      };
    }

    hashEsperadoPrev = reg.hash;
  }

  return {
    integra: true,
    totalRegistros: registros.length,
    indiceAlterado: null,
    registroAlteradoId: null,
    motivoFallo: null,
  };
}
