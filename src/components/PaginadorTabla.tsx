import React from 'react';
import { TAMANIO_PAGINA_POR_DEFECTO } from '../domain/paginacion.ts';

export interface PaginadorTablaProps {
  readonly paginaActual: number;
  readonly totalPaginas: number;
  readonly totalItems: number;
  readonly desdeRegistro: number;
  readonly hastaRegistro: number;
  readonly tamanioPagina?: number;
  readonly onCambiarPagina: (nuevaPagina: number) => void;
  readonly etiquetaItems?: string;
}

export function PaginadorTabla({
  paginaActual,
  totalPaginas,
  totalItems,
  desdeRegistro,
  hastaRegistro,
  tamanioPagina = TAMANIO_PAGINA_POR_DEFECTO,
  onCambiarPagina,
  etiquetaItems = 'registros',
}: PaginadorTablaProps): React.ReactElement {
  return (
    <div
      className="pagination-bar"
      role="navigation"
      aria-label={`Paginación de ${etiquetaItems}`}
    >
      <div className="pagination-info">
        {totalItems === 0 ? (
          <span>Sin {etiquetaItems} para mostrar ({tamanioPagina} por página)</span>
        ) : (
          <span>
            Mostrando{' '}
            <strong>
              {desdeRegistro}–{hastaRegistro}
            </strong>{' '}
            de <strong>{totalItems}</strong> {etiquetaItems} ({tamanioPagina} por
            página)
          </span>
        )}
      </div>

      <div className="pagination-controls">
        <button
          type="button"
          className="btn-secondary pagination-btn"
          disabled={paginaActual <= 1}
          onClick={() => onCambiarPagina(1)}
          title="Primera página"
        >
          « Primera
        </button>
        <button
          type="button"
          className="btn-secondary pagination-btn"
          disabled={paginaActual <= 1}
          onClick={() => onCambiarPagina(paginaActual - 1)}
          title="Página anterior"
        >
          ‹ Anterior
        </button>
        <span className="pagination-page-indicator">
          Página <strong>{paginaActual}</strong> de{' '}
          <strong>{totalPaginas}</strong>
        </span>
        <button
          type="button"
          className="btn-secondary pagination-btn"
          disabled={paginaActual >= totalPaginas}
          onClick={() => onCambiarPagina(paginaActual + 1)}
          title="Página siguiente"
        >
          Siguiente ›
        </button>
        <button
          type="button"
          className="btn-secondary pagination-btn"
          disabled={paginaActual >= totalPaginas}
          onClick={() => onCambiarPagina(totalPaginas)}
          title="Última página"
        >
          Última »
        </button>
      </div>
    </div>
  );
}
