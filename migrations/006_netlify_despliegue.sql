-- ============================================================================
-- Migración 006: Configuración para Despliegue Automático en Netlify (/web-pos)
-- ============================================================================

ALTER TABLE configuracion_sistema
  ADD COLUMN netlify_token TEXT;

ALTER TABLE configuracion_sistema
  ADD COLUMN netlify_site_id TEXT;

ALTER TABLE configuracion_sistema
  ADD COLUMN netlify_site_name TEXT;

ALTER TABLE configuracion_sistema
  ADD COLUMN netlify_site_url TEXT;

ALTER TABLE configuracion_sistema
  ADD COLUMN netlify_ultimo_despliegue_at TEXT;
