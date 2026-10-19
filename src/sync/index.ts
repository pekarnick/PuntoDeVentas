/**
 * Tipos de estado de sincronización visible en la barra superior (PLAN.md §5).
 * En Fase 1 la cola local se registra en cada transacción; el motor push/pull se activa en Fase 2.
 */

export type EstadoSincronizacionUI =
  | { readonly estado: 'sincronizado'; readonly ultimaSyncAt: string | null }
  | { readonly estado: 'pendiente'; readonly cambiosPendientes: number }
  | { readonly estado: 'sin_conexion'; readonly cambiosPendientes: number }
  | { readonly estado: 'error'; readonly detalle: string; readonly cambiosPendientes: number };

export function formatearEstadoSync(info: EstadoSincronizacionUI): string {
  switch (info.estado) {
    case 'sincronizado':
      return 'Sincronizado';
    case 'pendiente':
      return `Pendiente (${info.cambiosPendientes} ${info.cambiosPendientes === 1 ? 'cambio' : 'cambios'})`;
    case 'sin_conexion':
      return 'Sin conexión';
    case 'error':
      return `Error (${info.detalle})`;
  }
}
