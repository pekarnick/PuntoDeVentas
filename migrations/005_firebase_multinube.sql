-- ============================================================================
-- Migración 005: Soporte Opcional Multinube (Supabase + Firebase Firestore/Storage)
-- ============================================================================

ALTER TABLE configuracion_sistema
  ADD COLUMN proveedor_nube TEXT NOT NULL DEFAULT 'supabase'
    CHECK (proveedor_nube IN ('supabase', 'firebase', 'ambos'));

ALTER TABLE configuracion_sistema
  ADD COLUMN firebase_project_id TEXT;

ALTER TABLE configuracion_sistema
  ADD COLUMN firebase_api_key TEXT;
