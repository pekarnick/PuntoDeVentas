/**
 * Hashing de claves con Argon2id (formato PHC estándar) y políticas de seguridad de usuarios (PLAN.md §3 regla 16 y §6.1).
 * Nunca se almacenan claves ni PINs en texto plano.
 */

import { argon2id } from '@noble/hashes/argon2.js';

export const LARGO_MINIMO_CLAVE = 8;
export const MAX_INTENTOS_FALLIDOS = 5;
export const MINUTOS_BLOQUEO_LOGIN = 15;

export interface OpcionesArgon2id {
  /** Costo de memoria en KiB (por defecto 16384 KiB = 16 MiB, ágil en terminales de caja y seguro) */
  readonly m?: number;
  /** Iteraciones / pasadas (por defecto 2) */
  readonly t?: number;
  /** Paralelismo (por defecto 1) */
  readonly p?: number;
  /** Salt de 16 bytes opcional (se genera con CSPRNG si no se provee) */
  readonly salt?: Uint8Array;
}

function bytesABase64SinPadding(bytes: Uint8Array): string {
  let binario = '';
  for (const b of bytes) {
    binario += String.fromCharCode(b);
  }
  return btoa(binario).replace(/=+$/, '');
}

function base64SinPaddingABytes(b64: string): Uint8Array {
  const padding = (4 - (b64.length % 4)) % 4;
  const normalizado = b64 + '='.repeat(padding);
  const binario = atob(normalizado);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) {
    bytes[i] = binario.charCodeAt(i);
  }
  return bytes;
}

function comparacionTiempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Valida que una clave cumpla la política mínima de seguridad (PLAN.md §6.1).
 */
export function validarPoliticaClave(clave: string): void {
  if (typeof clave !== 'string' || clave.trim().length < LARGO_MINIMO_CLAVE) {
    throw new Error(
      `CLAVE_DEBIL: La clave debe tener al menos ${LARGO_MINIMO_CLAVE} caracteres.`
    );
  }
}

/**
 * Valida que un PIN de cambio rápido de cajero tenga entre 4 y 6 dígitos numéricos (PLAN.md §6.1).
 */
export function validarPoliticaPin(pin: string): void {
  if (!/^\d{4,6}$/.test(pin)) {
    throw new Error('PIN_INVALIDO: El PIN debe tener entre 4 y 6 dígitos numéricos.');
  }
}

/**
 * Genera un hash Argon2id en formato PHC: $argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>
 */
export function hashearClaveArgon2id(
  clave: string,
  opciones: OpcionesArgon2id = {}
): string {
  if (!clave || clave.length === 0) {
    throw new Error('La clave a hashear no puede estar vacía.');
  }

  const m = opciones.m ?? 16384;
  const t = opciones.t ?? 2;
  const p = opciones.p ?? 1;

  const salt = opciones.salt ?? new Uint8Array(16);
  if (!opciones.salt) {
    crypto.getRandomValues(salt);
  }

  const hashBytes = argon2id(new TextEncoder().encode(clave), salt, {
    m,
    t,
    p,
    dkLen: 32,
  });

  const saltB64 = bytesABase64SinPadding(salt);
  const hashB64 = bytesABase64SinPadding(hashBytes);

  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${saltB64}$${hashB64}`;
}

/**
 * Verifica una clave o PIN contra su hash Argon2id almacenado en formato PHC.
 */
export function verificarClaveArgon2id(
  clave: string,
  hashAlmacenado: string
): boolean {
  if (!clave || !hashAlmacenado || !hashAlmacenado.startsWith('$argon2id$')) {
    return false;
  }

  const partes = hashAlmacenado.split('$');
  // ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', '<salt>', '<hash>']
  if (partes.length !== 6) {
    return false;
  }

  const paramsStr = partes[3]!;
  const saltB64 = partes[4]!;
  const hashB64 = partes[5]!;

  const paramsMap = new Map<string, number>();
  for (const par of paramsStr.split(',')) {
    const [k, v] = par.split('=');
    if (k && v) {
      paramsMap.set(k, parseInt(v, 10));
    }
  }

  const m = paramsMap.get('m');
  const t = paramsMap.get('t');
  const p = paramsMap.get('p');

  if (!m || !t || !p || Number.isNaN(m) || Number.isNaN(t) || Number.isNaN(p)) {
    return false;
  }

  try {
    const salt = base64SinPaddingABytes(saltB64);
    const esperado = base64SinPaddingABytes(hashB64);
    const calculado = argon2id(new TextEncoder().encode(clave), salt, {
      m,
      t,
      p,
      dkLen: esperado.length,
    });
    return comparacionTiempoConstante(calculado, esperado);
  } catch {
    return false;
  }
}

/**
 * Genera una clave temporal legible (sin caracteres ambiguos como 0/O, 1/l/I) de 10 caracteres.
 */
export function generarClaveTemporal(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let clave = '';
  for (const b of bytes) {
    clave += alfabeto[b % alfabeto.length];
  }
  return clave;
}

/**
 * Determina si una marca de tiempo de bloqueo temporal sigue vigente respecto a `ahora`.
 */
export function estaUsuarioBloqueado(
  bloqueadoHastaIso: string | null | undefined,
  ahora: Date = new Date()
): boolean {
  if (!bloqueadoHastaIso) return false;
  const hastaMs = new Date(bloqueadoHastaIso).getTime();
  if (Number.isNaN(hastaMs)) return false;
  return hastaMs > ahora.getTime();
}

/**
 * Calcula la fecha/hora UTC hasta la cual debe bloquearse un usuario tras alcanzar el límite de intentos fallidos.
 */
export function calcularFechaDesbloqueo(
  ahora: Date = new Date(),
  minutosBloqueo: number = MINUTOS_BLOQUEO_LOGIN
): string {
  return new Date(ahora.getTime() + minutosBloqueo * 60_000).toISOString();
}
