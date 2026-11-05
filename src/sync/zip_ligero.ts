/**
 * Generador nativo de archivos ZIP (formato PKZip) usando node:zlib.
 * Corre en el entorno Node / Tauri de la terminal de escritorio.
 */

import zlib from 'node:zlib';

export interface ArchivoAComprimir {
  readonly nombre: string;
  readonly contenido: Buffer | Uint8Array | string;
}

/**
 * Crea un archivo .zip estándar en memoria a partir de una lista de archivos.
 * Formato PKZip estándar con compresión Deflate (método 8) y sumas CRC32.
 */
export function crearArchivoZip(archivos: readonly ArchivoAComprimir[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDirs: Buffer[] = [];
  let offset = 0;

  for (const item of archivos) {
    const nombreNormalizado = item.nombre
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

    const nombreBuf = Buffer.from(nombreNormalizado, 'utf8');
    const dataBuf = Buffer.isBuffer(item.contenido)
      ? item.contenido
      : typeof item.contenido === 'string'
      ? Buffer.from(item.contenido, 'utf8')
      : Buffer.from(item.contenido);

    const crc = zlib.crc32(dataBuf);
    const deflated = zlib.deflateRawSync(dataBuf);

    // Cabecera local (Local File Header) — 30 bytes + nombre
    const lh = Buffer.alloc(30 + nombreBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Firma 0x04034b50
    lh.writeUInt16LE(20, 4); // Versión necesaria: 2.0
    lh.writeUInt16LE(0, 6); // Flags
    lh.writeUInt16LE(8, 8); // Método de compresión: 8 (Deflate)
    lh.writeUInt16LE(0, 10); // Hora mod DOS (00:00:00)
    lh.writeUInt16LE(0x21, 12); // Fecha mod DOS (1980-01-01)
    lh.writeUInt32LE(crc, 14); // CRC-32
    lh.writeUInt32LE(deflated.length, 18); // Tamaño comprimido
    lh.writeUInt32LE(dataBuf.length, 22); // Tamaño descomprimido
    lh.writeUInt16LE(nombreBuf.length, 26); // Longitud nombre
    lh.writeUInt16LE(0, 28); // Extra field length
    nombreBuf.copy(lh, 30);

    // Entrada del directorio central (Central Directory File Header) — 46 bytes + nombre
    const cd = Buffer.alloc(46 + nombreBuf.length);
    cd.writeUInt32LE(0x02014b50, 0); // Firma 0x02014b50
    cd.writeUInt16LE(20, 4); // Versión creada por
    cd.writeUInt16LE(20, 6); // Versión requerida
    cd.writeUInt16LE(0, 8); // Flags
    cd.writeUInt16LE(8, 10); // Método de compresión
    cd.writeUInt16LE(0, 12); // Hora DOS
    cd.writeUInt16LE(0x21, 14); // Fecha DOS
    cd.writeUInt32LE(crc, 16); // CRC-32
    cd.writeUInt32LE(deflated.length, 20); // Tamaño comprimido
    cd.writeUInt32LE(dataBuf.length, 24); // Tamaño descomprimido
    cd.writeUInt16LE(nombreBuf.length, 28); // Longitud nombre
    cd.writeUInt16LE(0, 30); // Extra field length
    cd.writeUInt16LE(0, 32); // File comment length
    cd.writeUInt16LE(0, 34); // Disk number start
    cd.writeUInt16LE(0, 36); // Internal file attributes
    cd.writeUInt32LE(0, 38); // External file attributes
    cd.writeUInt32LE(offset, 42); // Offset relativo del local header
    nombreBuf.copy(cd, 46);

    localHeaders.push(lh, deflated);
    centralDirs.push(cd);
    offset += lh.length + deflated.length;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(centralDirs);
  const cdLength = cdBuf.length;

  // Fin del registro de directorio central (EOCD) — 22 bytes
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // Firma 0x06054b50
  eocd.writeUInt16LE(0, 4); // Número de este disco
  eocd.writeUInt16LE(0, 6); // Disco donde comienza el Central Directory
  eocd.writeUInt16LE(archivos.length, 8); // Registros en este disco
  eocd.writeUInt16LE(archivos.length, 10); // Total de registros
  eocd.writeUInt32LE(cdLength, 12); // Tamaño del Central Directory
  eocd.writeUInt32LE(cdOffset, 16); // Offset de inicio del Central Directory
  eocd.writeUInt16LE(0, 20); // Longitud del comentario (0)

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}
