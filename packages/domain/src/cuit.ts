/**
 * Validación pura de CUIT / CUIL y DNI para comercios argentinos (PLAN.md §8).
 * Algoritmo oficial de dígito verificador Módulo 11 (pesos 5, 4, 3, 2, 7, 6, 5, 4, 3, 2).
 */

const PESOS_MODULO_11 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

export type CondicionIvaReceptor =
  | 'consumidor_final'
  | 'monotributo'
  | 'responsable_inscripto'
  | 'exento';

export interface ResultadoValidacionCuit {
  readonly valido: boolean;
  readonly cuitSoloDigitos: string;
  readonly cuitFormateado: string;
  readonly motivo?: string;
}

export function calcularDigitoVerificadorCuit(primerosDiezDigitos: string): number {
  const limpio = primerosDiezDigitos.replace(/\D/g, '');
  if (limpio.length !== 10) {
    throw new Error('Se requieren exactamente 10 dígitos para calcular el verificador.');
  }
  let suma = 0;
  for (let i = 0; i < 10; i++) {
    suma += Number(limpio[i]) * PESOS_MODULO_11[i]!;
  }
  const resto = suma % 11;
  return resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
}

export function validarCuitArgentino(input: string): ResultadoValidacionCuit {
  const limpio = input.replace(/[\s.-]/g, '');

  if (!/^\d{11}$/.test(limpio)) {
    return {
      valido: false,
      cuitSoloDigitos: limpio,
      cuitFormateado: input.trim(),
      motivo: 'El CUIT/CUIL debe contener exactamente 11 dígitos numéricos.',
    };
  }

  const digitoCalculado = calcularDigitoVerificadorCuit(limpio.slice(0, 10));
  const digitoRecibido = Number(limpio[10]);

  const formateado = `${limpio.slice(0, 2)}-${limpio.slice(2, 10)}-${limpio.slice(10)}`;

  if (digitoCalculado !== digitoRecibido) {
    return {
      valido: false,
      cuitSoloDigitos: limpio,
      cuitFormateado: formateado,
      motivo: `El dígito verificador del CUIT (${formateado}) es inválido (se esperaba ${digitoCalculado}).`,
    };
  }

  return {
    valido: true,
    cuitSoloDigitos: limpio,
    cuitFormateado: formateado,
  };
}

export function validarCuitModulo11(input: string): boolean {
  return validarCuitArgentino(input).valido;
}

export function esCuitValido(input: string): boolean {
  return validarCuitArgentino(input).valido;
}

export function formatearCuit(input: string): string {
  const res = validarCuitArgentino(input);
  if (!res.valido) {
    throw new Error(res.motivo ?? 'CUIT inválido.');
  }
  return res.cuitFormateado;
}

export function validarCuitODniCliente(input: string): {
  readonly valido: boolean;
  readonly tipo: 'cuit' | 'cuit_cuil' | 'dni' | 'vacio';
  readonly valorFormateado: string;
  readonly documentoFormateado: string;
  readonly motivo?: string;
  readonly error?: string;
} {
  const texto = input.trim();
  if (!texto) {
    return {
      valido: true,
      tipo: 'vacio',
      valorFormateado: '',
      documentoFormateado: '',
    };
  }

  const soloDigitos = texto.replace(/[\s.-]/g, '');

  if (soloDigitos.length === 11) {
    const resCuit = validarCuitArgentino(soloDigitos);
    return {
      valido: resCuit.valido,
      tipo: 'cuit_cuil',
      valorFormateado: resCuit.cuitFormateado,
      documentoFormateado: resCuit.cuitFormateado,
      motivo: resCuit.motivo,
      error: resCuit.motivo,
    };
  }

  if (/^\d{7,8}$/.test(soloDigitos)) {
    return {
      valido: true,
      tipo: 'dni',
      valorFormateado: soloDigitos,
      documentoFormateado: soloDigitos,
    };
  }

  const msg =
    'Ingresá un DNI válido (7 u 8 dígitos) o un CUIT/CUIL válido (11 dígitos con verificador).';
  return {
    valido: false,
    tipo: 'dni',
    valorFormateado: texto,
    documentoFormateado: texto,
    motivo: msg,
    error: msg,
  };
}

export const validarDocumentoArgentino = validarCuitODniCliente;
