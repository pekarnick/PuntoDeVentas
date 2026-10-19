/**
 * Generador puro de archivos Excel (.xlsx — ECMA-376 OpenXML SpreadsheetML) sin dependencias externas.
 * Funciona tanto en Node/Tauri como en el navegador devolviendo un Uint8Array válido para Excel, LibreOffice y Google Sheets.
 */

export type ValorCeldaXlsx = string | number | boolean | null | undefined;

export interface HojaXlsxInput {
  readonly nombre: string;
  readonly encabezados: readonly string[];
  readonly filas: ReadonlyArray<ReadonlyArray<ValorCeldaXlsx>>;
}

function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function indiceAColumnaExcel(indiceCero: number): string {
  let n = indiceCero + 1;
  let col = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    col = String.fromCharCode(65 + resto) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
}

function sanitizarNombreHoja(nombre: string, indice: number): string {
  const limpio = nombre.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (limpio || `Hoja${indice + 1}`).slice(0, 31);
}

function generarXmlHoja(hoja: HojaXlsxInput): string {
  const todasLasFilas: ReadonlyArray<ReadonlyArray<ValorCeldaXlsx>> = [
    hoja.encabezados,
    ...hoja.filas,
  ];

  const filasXml: string[] = [];

  for (let r = 0; r < todasLasFilas.length; r++) {
    const fila = todasLasFilas[r]!;
    const numFila = r + 1;
    const esEncabezado = r === 0;
    const celdasXml: string[] = [];

    for (let c = 0; c < fila.length; c++) {
      const valor = fila[c];
      if (valor === null || valor === undefined || valor === '') {
        continue;
      }
      const refCelda = `${indiceAColumnaExcel(c)}${numFila}`;
      const atributoEstilo = esEncabezado ? ' s="1"' : '';

      if (typeof valor === 'number' && Number.isFinite(valor)) {
        celdasXml.push(`<c r="${refCelda}"${atributoEstilo}><v>${valor}</v></c>`);
      } else if (typeof valor === 'boolean') {
        celdasXml.push(
          `<c r="${refCelda}" t="b"${atributoEstilo}><v>${valor ? 1 : 0}</v></c>`
        );
      } else {
        celdasXml.push(
          `<c r="${refCelda}" t="inlineStr"${atributoEstilo}><is><t>${escaparXml(String(valor))}</t></is></c>`
        );
      }
    }

    filasXml.push(`<row r="${numFila}">${celdasXml.join('')}</row>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<sheetData>${filasXml.join('')}</sheetData>`,
    '</worksheet>',
  ].join('');
}

// Tabla precalculada para CRC-32 estándar (IEEE 802.3) usado en contenedores ZIP
const TABLA_CRC32 = (() => {
  const tabla = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabla[i] = c >>> 0;
  }
  return tabla;
})();

function calcularCrc32(datos: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < datos.length; i++) {
    crc = TABLA_CRC32[(crc ^ datos[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ArchivoZipEntrada {
  readonly ruta: string;
  readonly contenido: Uint8Array;
}

/**
 * Empaqueta múltiples archivos en un contenedor ZIP estándar (método STORE = 0, sin compresión,
 * compatible universalmente con lectores OpenXML).
 */
function empaquetarZipStore(archivos: readonly ArchivoZipEntrada[]): Uint8Array {
  const encoder = new TextEncoder();
  const partesLocales: Uint8Array[] = [];
  const partesCentrales: Uint8Array[] = [];
  let offsetActual = 0;

  for (const arch of archivos) {
    const nombreBytes = encoder.encode(arch.ruta);
    const datos = arch.contenido;
    const crc = calcularCrc32(datos);
    const tam = datos.byteLength;

    // Local file header (30 bytes + nombre)
    const headerLocal = new Uint8Array(30 + nombreBytes.length);
    const viewLocal = new DataView(headerLocal.buffer);
    viewLocal.setUint32(0, 0x04034b50, true); // Signature PK\x03\x04
    viewLocal.setUint16(4, 20, true); // Version needed (2.0)
    viewLocal.setUint16(6, 0x0800, true); // UTF-8 flag
    viewLocal.setUint16(8, 0, true); // Compression method 0 (STORE)
    viewLocal.setUint16(10, 0, true); // Mod time
    viewLocal.setUint16(12, 0x21, true); // Mod date
    viewLocal.setUint32(14, crc, true);
    viewLocal.setUint32(18, tam, true);
    viewLocal.setUint32(22, tam, true);
    viewLocal.setUint16(26, nombreBytes.length, true);
    viewLocal.setUint16(28, 0, true);
    headerLocal.set(nombreBytes, 30);

    partesLocales.push(headerLocal, datos);

    // Central directory file header (46 bytes + nombre)
    const headerCentral = new Uint8Array(46 + nombreBytes.length);
    const viewCentral = new DataView(headerCentral.buffer);
    viewCentral.setUint32(0, 0x02014b50, true); // Signature PK\x01\x02
    viewCentral.setUint16(4, 20, true); // Version made by
    viewCentral.setUint16(6, 20, true); // Version needed
    viewCentral.setUint16(8, 0x0800, true); // UTF-8 flag
    viewCentral.setUint16(10, 0, true); // Method STORE
    viewCentral.setUint16(12, 0, true);
    viewCentral.setUint16(14, 0x21, true);
    viewCentral.setUint32(16, crc, true);
    viewCentral.setUint32(20, tam, true);
    viewCentral.setUint32(24, tam, true);
    viewCentral.setUint16(28, nombreBytes.length, true);
    viewCentral.setUint16(30, 0, true);
    viewCentral.setUint16(32, 0, true);
    viewCentral.setUint16(34, 0, true);
    viewCentral.setUint16(36, 0, true);
    viewCentral.setUint32(38, 0, true);
    viewCentral.setUint32(42, offsetActual, true);
    headerCentral.set(nombreBytes, 46);

    partesCentrales.push(headerCentral);
    offsetActual += headerLocal.byteLength + tam;
  }

  const tamDirectorioCentral = partesCentrales.reduce(
    (acc, p) => acc + p.byteLength,
    0
  );

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const viewEocd = new DataView(eocd.buffer);
  viewEocd.setUint32(0, 0x06054b50, true); // Signature PK\x05\x06
  viewEocd.setUint16(4, 0, true);
  viewEocd.setUint16(6, 0, true);
  viewEocd.setUint16(8, archivos.length, true);
  viewEocd.setUint16(10, archivos.length, true);
  viewEocd.setUint32(12, tamDirectorioCentral, true);
  viewEocd.setUint32(16, offsetActual, true);
  viewEocd.setUint16(20, 0, true);

  const totalBytes = offsetActual + tamDirectorioCentral + eocd.byteLength;
  const salida = new Uint8Array(totalBytes);
  let cursor = 0;

  for (const parte of partesLocales) {
    salida.set(parte, cursor);
    cursor += parte.byteLength;
  }
  for (const parte of partesCentrales) {
    salida.set(parte, cursor);
    cursor += parte.byteLength;
  }
  salida.set(eocd, cursor);

  return salida;
}

/**
 * Genera un libro de Excel (.xlsx) válido con una o más hojas de datos.
 */
export function generarLibroXlsx(hojas: readonly HojaXlsxInput[]): Uint8Array {
  if (hojas.length === 0) {
    throw new Error('El libro Excel debe contener al menos una hoja.');
  }

  const encoder = new TextEncoder();
  const archivos: ArchivoZipEntrada[] = [];

  const overridesSheets = hojas
    .map(
      (_, idx) =>
        `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');

  const contentTypesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    overridesSheets,
    '</Types>',
  ].join('');

  const relsRaizXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>',
  ].join('');

  const sheetsTag = hojas
    .map(
      (h, idx) =>
        `<sheet name="${escaparXml(sanitizarNombreHoja(h.nombre, idx))}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
    )
    .join('');

  const workbookXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetsTag}</sheets>`,
    '</workbook>',
  ].join('');

  const relsSheets = hojas
    .map(
      (_, idx) =>
        `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
    )
    .join('');

  const workbookRelsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relsSheets,
    `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    '</Relationships>',
  ].join('');

  const stylesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>',
    '</styleSheet>',
  ].join('');

  archivos.push(
    { ruta: '[Content_Types].xml', contenido: encoder.encode(contentTypesXml) },
    { ruta: '_rels/.rels', contenido: encoder.encode(relsRaizXml) },
    { ruta: 'xl/workbook.xml', contenido: encoder.encode(workbookXml) },
    {
      ruta: 'xl/_rels/workbook.xml.rels',
      contenido: encoder.encode(workbookRelsXml),
    },
    { ruta: 'xl/styles.xml', contenido: encoder.encode(stylesXml) }
  );

  for (let i = 0; i < hojas.length; i++) {
    archivos.push({
      ruta: `xl/worksheets/sheet${i + 1}.xml`,
      contenido: encoder.encode(generarXmlHoja(hojas[i]!)),
    });
  }

  return empaquetarZipStore(archivos);
}

/**
 * Extrae las entradas de un archivo .xlsx generado con empaquetarZipStore para verificación en tests.
 */
export function inspeccionarEntradasXlsx(
  xlsxBytes: Uint8Array
): Record<string, string> {
  const decoder = new TextDecoder();
  const view = new DataView(
    xlsxBytes.buffer,
    xlsxBytes.byteOffset,
    xlsxBytes.byteLength
  );
  const resultado: Record<string, string> = {};

  let offset = 0;
  while (offset + 30 <= xlsxBytes.byteLength) {
    const firma = view.getUint32(offset, true);
    if (firma !== 0x04034b50) {
      break;
    }
    const tamComprimido = view.getUint32(offset + 18, true);
    const largoNombre = view.getUint16(offset + 26, true);
    const largoExtra = view.getUint16(offset + 28, true);

    const inicioNombre = offset + 30;
    const finNombre = inicioNombre + largoNombre;
    const nombre = decoder.decode(xlsxBytes.subarray(inicioNombre, finNombre));

    const inicioDatos = finNombre + largoExtra;
    const finDatos = inicioDatos + tamComprimido;
    resultado[nombre] = decoder.decode(xlsxBytes.subarray(inicioDatos, finDatos));

    offset = finDatos;
  }

  return resultado;
}
