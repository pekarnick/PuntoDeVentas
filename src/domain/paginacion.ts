/**
 * Lógica pura de paginación de listados (10 ítems por página por defecto).
 * Garantiza índices seguros incluso cuando los filtros reducen el total de elementos.
 */

export const TAMANIO_PAGINA_POR_DEFECTO = 10;

export interface ResultadoPaginacion<T> {
  readonly itemsPagina: readonly T[];
  readonly paginaActual: number;
  readonly totalPaginas: number;
  readonly totalItems: number;
  readonly tamanioPagina: number;
  readonly desdeRegistro: number;
  readonly hastaRegistro: number;
  readonly tieneAnterior: boolean;
  readonly tieneSiguiente: boolean;
}

export function paginarListado<T>(
  items: readonly T[],
  paginaSolicitada: number,
  tamanioPagina: number = TAMANIO_PAGINA_POR_DEFECTO
): ResultadoPaginacion<T> {
  const tamSeguro =
    Number.isFinite(tamanioPagina) && tamanioPagina > 0
      ? Math.floor(tamanioPagina)
      : TAMANIO_PAGINA_POR_DEFECTO;

  const totalItems = items.length;
  const totalPaginas = Math.max(1, Math.ceil(totalItems / tamSeguro));

  const pagNormalizada = Number.isFinite(paginaSolicitada)
    ? Math.floor(paginaSolicitada)
    : 1;
  const paginaActual = Math.min(Math.max(1, pagNormalizada), totalPaginas);

  const offset = (paginaActual - 1) * tamSeguro;
  const itemsPagina = items.slice(offset, offset + tamSeguro);

  const desdeRegistro = totalItems === 0 ? 0 : offset + 1;
  const hastaRegistro =
    totalItems === 0 ? 0 : Math.min(offset + itemsPagina.length, totalItems);

  return {
    itemsPagina,
    paginaActual,
    totalPaginas,
    totalItems,
    tamanioPagina: tamSeguro,
    desdeRegistro,
    hastaRegistro,
    tieneAnterior: paginaActual > 1,
    tieneSiguiente: paginaActual < totalPaginas,
  };
}
