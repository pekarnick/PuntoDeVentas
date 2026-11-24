-- ============================================================================
-- Migración SQLite 008: Endurecimiento de Seguridad P0 (Backoff ARCA)
-- ============================================================================

ALTER TABLE ventas ADD COLUMN arca_proximo_reintento_at TEXT;
