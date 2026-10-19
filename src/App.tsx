import React from 'react';
import { formatearMonedaARS, formatearFechaAR } from './domain/dinero.ts';
import { formatearEstadoSync } from './sync/index.ts';

export function App(): React.ReactElement {
  const estadoSync = formatearEstadoSync({
    estado: 'pendiente',
    cambiosPendientes: 0,
  });

  const hoy = formatearFechaAR(new Date());

  return (
    <div className="app-layout">
      <header className="topbar">
        <div className="topbar-brand">
          <strong>Punto de Ventas</strong>
          <span className="badge-fase">Fase 1 · Local Offline-First</span>
        </div>
        <div className="topbar-status">
          <span>Fecha: {hoy}</span>
          <span className="sync-pill" title="Estado de sincronización">
            {estadoSync}
          </span>
        </div>
      </header>

      <main className="main-content">
        <section className="pos-card">
          <h1>Caja lista para operar sin conexión</h1>
          <p>
            Base local SQLite configurada con migraciones versionadas, importes en centavos (ej.{' '}
            <strong>{formatearMonedaARS(123456)}</strong>), stock por suma de movimientos y auditoría
            encadenada SHA-256.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
