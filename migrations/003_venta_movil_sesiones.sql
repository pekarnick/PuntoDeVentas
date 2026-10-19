-- ============================================================================
-- Migración 003: Sesiones móviles y configuración de Venta Móvil Web (PLAN.md §6.2 — Fase 3b)
-- ============================================================================

-- 1. Dirección web pública para el código QR de Venta Móvil (Regla 19: solo URL pública)
ALTER TABLE configuracion_sistema
  ADD COLUMN venta_movil_url TEXT NOT NULL DEFAULT 'https://pos-movil.ejemplo.com/web-pos';

-- 2. Sesiones activas de Venta Móvil (con soporte de vencimiento por inactividad y revocación desde escritorio)
CREATE TABLE IF NOT EXISTS sesiones_moviles (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  dispositivo_id TEXT NOT NULL,
  dispositivo_nombre TEXT NOT NULL,
  user_agent TEXT,
  iniciada_at TEXT NOT NULL,
  ultima_actividad_at TEXT NOT NULL,
  expira_at TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activa'
    CHECK (estado IN ('activa', 'revocada', 'expirada', 'cerrada')),
  revocada_at TEXT,
  revocada_por_id TEXT REFERENCES usuarios(id),
  motivo_revocacion TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_sesiones_moviles_comercio_estado
  ON sesiones_moviles(comercio_id, estado, ultima_actividad_at DESC);

CREATE INDEX IF NOT EXISTS idx_sesiones_moviles_usuario
  ON sesiones_moviles(comercio_id, usuario_id);
