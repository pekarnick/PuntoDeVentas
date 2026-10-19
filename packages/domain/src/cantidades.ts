/**
 * Aritmética exacta de cantidades usando miliunidades enteras (escala 1/1000).
 * Evita errores de punto flotante IEEE 754 (ej. 0.1 + 0.2 = 0.30000000000000004).
 */

const ESCALA_MILI = 1000;

export function aMiliunidades(cantidad: number): number {
  if (!Number.isFinite(cantidad)) {
    throw new Error(`Cantidad inválida: ${cantidad}`);
  }
  return Math.round(cantidad * ESCALA_MILI);
}

export function desdeMiliunidades(miliunidades: number): number {
  return Math.round(miliunidades) / ESCALA_MILI;
}

export function sumarCantidades(cantidades: readonly number[]): number {
  let totalMili = 0;
  for (const c of cantidades) {
    totalMili += aMiliunidades(c);
  }
  return desdeMiliunidades(totalMili);
}

export function validarCantidadProducto(
  cantidad: number,
  permiteDecimales: boolean
): void {
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new Error('La cantidad debe ser mayor a cero.');
  }
  const mili = aMiliunidades(cantidad);
  if (!permiteDecimales && mili % ESCALA_MILI !== 0) {
    throw new Error('Este producto no permite cantidades con decimales.');
  }
}
