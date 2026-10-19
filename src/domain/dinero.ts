/**
 * Manejo de dinero en centavos (enteros) y formatos para Argentina (PLAN.md §3 reglas 2, 9 y 10).
 * Nunca usar float para almacenar ni operar importes monetarios.
 */

export type Centavos = number;

/**
 * Valida que un importe esté expresado en centavos enteros seguros.
 */
export function asegurarCentavos(valor: number, nombreCampo = 'importe'): Centavos {
  if (!Number.isSafeInteger(valor)) {
    throw new Error(
      `El campo "${nombreCampo}" debe ser un número entero de centavos (recibido: ${valor}).`
    );
  }
  return valor;
}

export const aCentavos = asegurarCentavos;
export const exigirEnteroCentavos = asegurarCentavos;

/**
 * Convierte un valor en pesos (ej. "1234,56", "1.234,56", "1234.56" o número) a centavos enteros.
 */
export function pesosACentavos(entrada: string | number): Centavos {
  if (typeof entrada === 'number') {
    if (!Number.isFinite(entrada)) {
      throw new Error('Importe inválido.');
    }
    return Math.round(entrada * 100);
  }

  const limpio = entrada.trim().replace(/\$/g, '').replace(/\s+/g, '');
  if (!limpio) {
    throw new Error('Importe vacío.');
  }

  let normalizado = limpio;
  if (limpio.includes(',')) {
    // Formato argentino: puntos de miles y coma decimal ("1.234,56" -> "1234.56")
    normalizado = limpio.replace(/\./g, '').replace(',', '.');
  }

  if (!/^-?\d+(\.\d{1,2})?$/.test(normalizado)) {
    throw new Error(`Formato de importe inválido: "${entrada}".`);
  }

  const negativo = normalizado.startsWith('-');
  const sinSigno = negativo ? normalizado.slice(1) : normalizado;
  const [parteEntera = '0', parteDecimal = ''] = sinSigno.split('.');
  const centavosAbs =
    parseInt(parteEntera, 10) * 100 + parseInt(parteDecimal.padEnd(2, '0'), 10);

  return negativo ? -centavosAbs : centavosAbs;
}

/**
 * Formatea un importe en centavos al estándar argentino: "$ 1.234,56" (o "-$ 1.234,56").
 */
export function formatearMonedaARS(centavos: Centavos): string {
  asegurarCentavos(centavos);
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const enteros = Math.floor(abs / 100);
  const decimales = (abs % 100).toString().padStart(2, '0');
  const enterosConPuntos = enteros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return `${negativo ? '-' : ''}$ ${enterosConPuntos},${decimales}`;
}

export const formatearPesos = formatearMonedaARS;

const formaterFechaAR = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const formaterFechaHoraAR = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Convierte una fecha ISO UTC a formato "dd/mm/aaaa" en zona horaria de Buenos Aires (Regla 9).
 */
export function formatearFechaAR(isoUtc: string | Date): string {
  const fecha = typeof isoUtc === 'string' ? new Date(isoUtc) : isoUtc;
  if (Number.isNaN(fecha.getTime())) {
    throw new Error(`Fecha inválida: "${String(isoUtc)}".`);
  }
  return formaterFechaAR.format(fecha);
}

/**
 * Convierte una fecha ISO UTC a formato "dd/mm/aaaa HH:mm" en zona horaria de Buenos Aires (Regla 9).
 */
export function formatearFechaHoraAR(isoUtc: string | Date): string {
  const fecha = typeof isoUtc === 'string' ? new Date(isoUtc) : isoUtc;
  if (Number.isNaN(fecha.getTime())) {
    throw new Error(`Fecha inválida: "${String(isoUtc)}".`);
  }
  return formaterFechaHoraAR.format(fecha).replace(',', '');
}
