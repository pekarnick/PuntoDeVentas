import React from 'react';

export interface PiePaginaInstitucionalProps {
  readonly subtitulo?: string;
}

export function PiePaginaInstitucional({
  subtitulo = 'Sistema Punto de Venta Offline-First · Base de Datos Local + Nube',
}: PiePaginaInstitucionalProps): React.ReactElement {
  return (
    <footer className="app-footer" role="contentinfo">
      <div className="app-footer-inner">
        <span className="app-footer-brand">
          <strong>GAR</strong> - Guillermo Adolfo Rohde
        </span>
        <span className="app-footer-meta">{subtitulo}</span>
      </div>
    </footer>
  );
}
