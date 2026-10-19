/**
 * Generador y validador de identificadores UUIDv7 (RFC 9562).
 * Regla inviolable 1 (PLAN.md §3): Todos los IDs son UUID, nunca autoincrementales.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let ultimoTimestampMs = 0;
let contadorMonotonico = 0;

/**
 * Genera un UUIDv7 ordenable por tiempo (48 bits timestamp ms + 12 bits secuencia/random + 62 bits random).
 */
export function generarUuidV7(ahoraMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  if (ahoraMs === ultimoTimestampMs) {
    contadorMonotonico = (contadorMonotonico + 1) & 0x0fff;
  } else {
    ultimoTimestampMs = ahoraMs;
    contadorMonotonico = ((bytes[6]! << 8) | bytes[7]!) & 0x0fff;
  }

  // 48-bit big-endian timestamp
  const ts = BigInt(ahoraMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Version 7 (0111xxxx) + 12-bit monotonic counter
  bytes[6] = 0x70 | ((contadorMonotonico >> 8) & 0x0f);
  bytes[7] = contadorMonotonico & 0xff;

  // Variant RFC 9562 (10xxxxxx)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Verifica que una cadena tenga formato UUID válido.
 */
export function esUuidValido(valor: string): boolean {
  return UUID_REGEX.test(valor);
}
