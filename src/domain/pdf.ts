/**
 * Generador puro de documentos PDF (ISO 32000-1 / PDF 1.4) sin dependencias externas.
 * Funciona 100% offline tanto en Node/Tauri como en el navegador devolviendo un `Uint8Array`
 * binario válido con soporte completo de caracteres en español rioplatense (WinAnsiEncoding: áéíóúñÁÉÍÓÚÑ$°).
 */

export interface ColumnaTablaPdf {
  readonly encabezado: string;
  readonly anchoPuntos: number;
  readonly alineacion?: 'left' | 'right' | 'center';
}

export interface SeccionTablaPdf {
  readonly tituloSeccion: string;
  readonly subtituloSeccion?: string;
  readonly columnas: readonly ColumnaTablaPdf[];
  readonly filas: ReadonlyArray<ReadonlyArray<string | number>>;
  readonly pieSeccion?: string;
}

export interface DocumentoPdfInput {
  readonly titulo: string;
  readonly subtitulo?: string;
  readonly metadatosLineas?: readonly string[];
  readonly secciones: readonly SeccionTablaPdf[];
  readonly pieDocumento?: string;
}

/**
 * Convierte un carácter Unicode a su byte correspondiente en WinAnsiEncoding (CP1252 / Latin-1)
 * y escapa los caracteres especiales de literales de texto PDF `(`, `)`, `\`.
 */
function escaparTextoPdfWinAnsi(texto: string): string {
  let salida = '';
  for (let i = 0; i < texto.length; i++) {
    const code = texto.charCodeAt(i);
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      // '(', ')', '\'
      salida += '\\' + String.fromCharCode(code);
    } else if (code >= 0x20 && code <= 0x7e) {
      salida += String.fromCharCode(code);
    } else if (code >= 0xa0 && code <= 0xff) {
      // Caracteres Latin-1 / WinAnsi (á, é, í, ó, ú, ñ, Ñ, °, etc.) en octal PDF \ddd
      salida += '\\' + code.toString(8).padStart(3, '0');
    } else if (code === 0x2013 || code === 0x2014) {
      // En-dash / Em-dash -> '-'
      salida += '-';
    } else if (code === 0x2022) {
      // Bullet -> '*'
      salida += '*';
    } else {
      salida += ' ';
    }
  }
  return salida;
}

function truncarTextoPorAncho(
  texto: string,
  anchoPuntos: number,
  tamanoFuente: number
): string {
  const limpio = String(texto ?? '').replace(/\r?\n/g, ' ').trim();
  const anchoPromedioChar = tamanoFuente * 0.52;
  const maxChars = Math.max(4, Math.floor((anchoPuntos - 6) / anchoPromedioChar));
  if (limpio.length <= maxChars) {
    return limpio;
  }
  return limpio.slice(0, Math.max(1, maxChars - 1)) + '.';
}

function calcularOffsetTextoAlineado(
  texto: string,
  xColumna: number,
  anchoColumna: number,
  tamanoFuente: number,
  alineacion: 'left' | 'right' | 'center' = 'left'
): number {
  if (alineacion === 'left') {
    return xColumna + 3;
  }
  const anchoEstimado = texto.length * tamanoFuente * 0.5;
  if (alineacion === 'right') {
    return Math.max(xColumna + 2, xColumna + anchoColumna - anchoEstimado - 4);
  }
  return Math.max(
    xColumna + 2,
    xColumna + (anchoColumna - anchoEstimado) / 2
  );
}

/**
 * Genera un archivo PDF 1.4 multipágina en formato A4 vertical (595 x 842 pt)
 * con encabezados, tablas por sección y numeración de páginas.
 */
export function generarDocumentoPdf(doc: DocumentoPdfInput): Uint8Array {
  const ANCHO_PAGINA = 595;
  const ALTO_PAGINA = 842;
  const MARGEN_IZQ = 36;
  const MARGEN_DER = 36;
  const ANCHO_UTIL = ANCHO_PAGINA - MARGEN_IZQ - MARGEN_DER;
  const Y_INICIO = ALTO_PAGINA - 42;
  const Y_MINIMO = 54;

  const paginasComandos: string[][] = [];
  let comandosActuales: string[] = [];
  let yActual = Y_INICIO;

  function abrirNuevaPagina(esPrimera: boolean): void {
    if (comandosActuales.length > 0) {
      paginasComandos.push(comandosActuales);
    }
    comandosActuales = [];
    yActual = Y_INICIO;

    // Encabezado institucional superior
    comandosActuales.push(
      '0.09 0.14 0.23 rg',
      `BT /F2 14 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(doc.titulo)}) Tj ET`
    );
    yActual -= 16;

    if (doc.subtitulo) {
      comandosActuales.push(
        '0.35 0.42 0.52 rg',
        `BT /F1 9.5 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(doc.subtitulo)}) Tj ET`
      );
      yActual -= 14;
    }

    if (esPrimera && doc.metadatosLineas && doc.metadatosLineas.length > 0) {
      for (const lineaMeta of doc.metadatosLineas) {
        comandosActuales.push(
          '0.25 0.31 0.40 rg',
          `BT /F1 8.5 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(lineaMeta)}) Tj ET`
        );
        yActual -= 12;
      }
    }

    // Línea divisoria del encabezado
    comandosActuales.push(
      '0.75 0.80 0.86 RG',
      '1 w',
      `${MARGEN_IZQ} ${yActual} m ${ANCHO_PAGINA - MARGEN_DER} ${yActual} l S`
    );
    yActual -= 16;
  }

  function asegurarEspacioVertical(altoRequerido: number): void {
    if (yActual - altoRequerido < Y_MINIMO) {
      abrirNuevaPagina(false);
    }
  }

  function dibujarCabeceraTabla(columnas: readonly ColumnaTablaPdf[]): void {
    const altoCabecera = 18;
    asegurarEspacioVertical(altoCabecera + 14);

    const yBase = yActual - altoCabecera + 4;
    comandosActuales.push(
      '0.91 0.94 0.98 rg',
      `${MARGEN_IZQ} ${yBase} ${ANCHO_UTIL} ${altoCabecera} re f`,
      '0.09 0.14 0.23 rg'
    );

    let xCursor = MARGEN_IZQ;
    for (const col of columnas) {
      const txt = truncarTextoPorAncho(col.encabezado, col.anchoPuntos, 8.5);
      const xTexto = calcularOffsetTextoAlineado(
        txt,
        xCursor,
        col.anchoPuntos,
        8.5,
        col.alineacion ?? 'left'
      );
      comandosActuales.push(
        `BT /F2 8.5 Tf ${xTexto.toFixed(1)} ${(yBase + 5).toFixed(1)} Td (${escaparTextoPdfWinAnsi(txt)}) Tj ET`
      );
      xCursor += col.anchoPuntos;
    }

    yActual -= altoCabecera + 2;
  }

  abrirNuevaPagina(true);

  if (doc.secciones.length === 0) {
    comandosActuales.push(
      '0.35 0.42 0.52 rg',
      `BT /F1 10 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi('No hay registros para mostrar en este listado.')}) Tj ET`
    );
    yActual -= 18;
  }

  for (const seccion of doc.secciones) {
    asegurarEspacioVertical(48);

    // Título de sección (ej: Proveedor / Marca / Categoría)
    comandosActuales.push(
      '0.12 0.23 0.37 rg',
      `BT /F2 11 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(seccion.tituloSeccion)}) Tj ET`
    );
    yActual -= 13;

    if (seccion.subtituloSeccion) {
      comandosActuales.push(
        '0.38 0.45 0.55 rg',
        `BT /F1 8.5 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(seccion.subtituloSeccion)}) Tj ET`
      );
      yActual -= 12;
    }

    dibujarCabeceraTabla(seccion.columnas);

    for (let idxFila = 0; idxFila < seccion.filas.length; idxFila++) {
      const fila = seccion.filas[idxFila]!;
      const altoFila = 15;

      if (yActual - altoFila < Y_MINIMO) {
        abrirNuevaPagina(false);
        comandosActuales.push(
          '0.12 0.23 0.37 rg',
          `BT /F2 10 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(seccion.tituloSeccion + ' (continuación)')}) Tj ET`
        );
        yActual -= 14;
        dibujarCabeceraTabla(seccion.columnas);
      }

      const yFilaBase = yActual - altoFila + 4;
      if (idxFila % 2 === 1) {
        comandosActuales.push(
          '0.97 0.98 0.99 rg',
          `${MARGEN_IZQ} ${yFilaBase} ${ANCHO_UTIL} ${altoFila} re f`
        );
      }

      comandosActuales.push('0.10 0.15 0.22 rg');
      let xCursor = MARGEN_IZQ;

      for (let c = 0; c < seccion.columnas.length; c++) {
        const col = seccion.columnas[c]!;
        const valorRaw = fila[c] ?? '';
        const txt = truncarTextoPorAncho(String(valorRaw), col.anchoPuntos, 8);
        const xTexto = calcularOffsetTextoAlineado(
          txt,
          xCursor,
          col.anchoPuntos,
          8,
          col.alineacion ?? 'left'
        );
        comandosActuales.push(
          `BT /F1 8 Tf ${xTexto.toFixed(1)} ${(yFilaBase + 4).toFixed(1)} Td (${escaparTextoPdfWinAnsi(txt)}) Tj ET`
        );
        xCursor += col.anchoPuntos;
      }

      // Línea sutil inferior de cada fila
      comandosActuales.push(
        '0.90 0.92 0.95 RG',
        '0.5 w',
        `${MARGEN_IZQ} ${yFilaBase} m ${ANCHO_PAGINA - MARGEN_DER} ${yFilaBase} l S`
      );

      yActual -= altoFila;
    }

    if (seccion.pieSeccion) {
      asegurarEspacioVertical(18);
      yActual -= 4;
      comandosActuales.push(
        '0.09 0.14 0.23 rg',
        `BT /F2 9 Tf ${MARGEN_IZQ} ${yActual} Td (${escaparTextoPdfWinAnsi(seccion.pieSeccion)}) Tj ET`
      );
      yActual -= 14;
    }

    yActual -= 10;
  }

  if (doc.pieDocumento) {
    asegurarEspacioVertical(22);
    comandosActuales.push(
      '0.75 0.80 0.86 RG',
      '0.8 w',
      `${MARGEN_IZQ} ${yActual + 6} m ${ANCHO_PAGINA - MARGEN_DER} ${yActual + 6} l S`,
      '0.09 0.14 0.23 rg',
      `BT /F2 10 Tf ${MARGEN_IZQ} ${yActual - 6} Td (${escaparTextoPdfWinAnsi(doc.pieDocumento)}) Tj ET`
    );
    yActual -= 18;
  }

  if (comandosActuales.length > 0) {
    paginasComandos.push(comandosActuales);
  }

  const totalPaginas = paginasComandos.length;

  // Construcción de objetos PDF 1.4:
  // Obj 1: Catalog
  // Obj 2: Pages
  // Obj 3: Font F1 (Helvetica WinAnsiEncoding)
  // Obj 4: Font F2 (Helvetica-Bold WinAnsiEncoding)
  // Por cada página i (0..totalPaginas-1):
  //   Obj (5 + i * 2): Page
  //   Obj (6 + i * 2): Content Stream
  const objetosPdf: string[] = [];
  const kidsRefs: string[] = [];

  for (let i = 0; i < totalPaginas; i++) {
    const pageObjNum = 5 + i * 2;
    kidsRefs.push(`${pageObjNum} 0 R`);
  }

  objetosPdf.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  objetosPdf.push(
    `2 0 obj\n<< /Type /Pages /Kids [ ${kidsRefs.join(' ')} ] /Count ${totalPaginas} >>\nendobj`
  );
  objetosPdf.push(
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj'
  );
  objetosPdf.push(
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj'
  );

  for (let i = 0; i < totalPaginas; i++) {
    const pageObjNum = 5 + i * 2;
    const streamObjNum = 6 + i * 2;
    const piePaginaTexto = `Página ${i + 1} de ${totalPaginas} · GAR - Punto de Ventas`;

    const comandosConPie = [
      ...paginasComandos[i]!,
      '0.45 0.52 0.60 rg',
      `BT /F1 8 Tf ${MARGEN_IZQ} 28 Td (${escaparTextoPdfWinAnsi(piePaginaTexto)}) Tj ET`,
    ].join('\n');

    objetosPdf.push(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO_PAGINA} ${ALTO_PAGINA}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObjNum} 0 R >>\nendobj`
    );
    objetosPdf.push(
      `${streamObjNum} 0 obj\n<< /Length ${comandosConPie.length} >>\nstream\n${comandosConPie}\nendstream\nendobj`
    );
  }

  let pdfString = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (const obj of objetosPdf) {
    offsets.push(pdfString.length);
    pdfString += obj + '\n';
  }

  const xrefOffset = pdfString.length;
  pdfString += `xref\n0 ${objetosPdf.length + 1}\n`;
  pdfString += '0000000000 65535 f \n';
  for (let i = 1; i <= objetosPdf.length; i++) {
    pdfString += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`;
  }

  pdfString += `trailer\n<< /Size ${objetosPdf.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  // Codificar en Latin-1 byte a byte (1 carácter = 1 byte)
  const bytes = new Uint8Array(pdfString.length);
  for (let i = 0; i < pdfString.length; i++) {
    bytes[i] = pdfString.charCodeAt(i) & 0xff;
  }
  return bytes;
}
