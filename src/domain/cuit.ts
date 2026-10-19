/**
 * Validación y formateo de CUIT / CUIL argentino con dígito verificador módulo 11 (PLAN.md §8).
 */

const PESOS_CUIT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

export function limpiarCuit(cuit: string): string {
  return cuit.replace(/[-\s.]/g, '');
}

export function esCuitValido(cuit: string): boolean {
  const limpio = limpiarCuit(cuit);
  if (!/^\d{11}$/.test(limpio)) {
    return false;
  }

  let suma = 0;
  for (let i = 0; i < 10; i++) {
    suma += parseInt(limpio[i]!, 10) * PESOS_CUIT[i]!;
  }

  const resto = suma % 11;
  const digitoEsperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  const digitoReal = parseInt(limpio[10]!, 10);

  return digitoEsperado === digitoReal;
}

export function formatearCuit(cuit: string): string {
  const limpio = limpiarCuit(cuit);
  if (!/^\d{11}$/.test(limpio)) {
    throw new Error(`CUIT inválido: "${cuit}".`);
  }
  return `${limpio.slice(0, 2)}-${limpio.slice(2, 10)}-${limpio.slice(10)}`;
}
