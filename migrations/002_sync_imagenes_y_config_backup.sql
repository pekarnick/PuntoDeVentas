-- ============================================================================
-- Migración 002: Cola separada de sincronización de imágenes y configuración
-- de sincronización / backups locales (PLAN.md §5 y §5.1 — Fase 2)
-- ============================================================================

-- 1. Cola separada para sincronización de imágenes de productos (PLAN.md §5.1)
-- Primero sincronizan los datos; las imágenes se transfieren después en segundo
-- plano con su propia cola. Conservar el último hash sincronizado evita
-- volver a transferir archivos idénticos.
CREATE TABLE IF NOT EXISTS sync_imagenes_cola (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  imagen_path TEXT NOT NULL,
  imagen_hash TEXT NOT NULL,
  ultimo_hash_sincronizado TEXT,
  operacion TEXT NOT NULL
    CHECK (operacion IN ('subir', 'bajar')),
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'procesando', 'sincronizado', 'error')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (producto_id, operacion)
);

CREATE INDEX IF NOT EXISTS idx_sync_imagenes_cola_estado
  ON sync_imagenes_cola(estado, updated_at);

-- 2. Configuración local de sincronización y backups automáticos (solo local)
-- Regla 8: Nunca pedir ni guardar claves de servicio (service_role / sb_secret_) en el cliente.
CREATE TABLE IF NOT EXISTS configuracion_sistema (
  comercio_id TEXT PRIMARY KEY NOT NULL REFERENCES comercios(id),
  supabase_url TEXT,
  supabase_anon_key TEXT,
  sync_automatico_habilitado INTEGER NOT NULL DEFAULT 1
    CHECK (sync_automatico_habilitado IN (0, 1)),
  sync_intervalo_minutos INTEGER NOT NULL DEFAULT 5
    CHECK (sync_intervalo_minutos >= 1 AND sync_intervalo_minutos <= 1440),
  carpeta_backups TEXT NOT NULL DEFAULT 'backups',
  backup_diario_habilitado INTEGER NOT NULL DEFAULT 1
    CHECK (backup_diario_habilitado IN (0, 1)),
  ultimo_backup_at TEXT,
  ultimo_backup_archivo TEXT,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_config_prohibir_clave_secreta_insert
BEFORE INSERT ON configuracion_sistema
WHEN NEW.supabase_anon_key IS NOT NULL
  AND (
    NEW.supabase_anon_key LIKE 'sb_secret_%'
    OR NEW.supabase_anon_key LIKE '%service_role%'
  )
BEGIN
  SELECT RAISE(ABORT, 'SEGURIDAD_SUPABASE: Nunca se permite guardar una clave secreta o service_role en el cliente (Regla 8).');
END;

CREATE TRIGGER IF NOT EXISTS trg_config_prohibir_clave_secreta_update
BEFORE UPDATE ON configuracion_sistema
WHEN NEW.supabase_anon_key IS NOT NULL
  AND (
    NEW.supabase_anon_key LIKE 'sb_secret_%'
    OR NEW.supabase_anon_key LIKE '%service_role%'
  )
BEGIN
  SELECT RAISE(ABORT, 'SEGURIDAD_SUPABASE: Nunca se permite guardar una clave secreta o service_role en el cliente (Regla 8).');
END;

-- 3. Historial local de backups realizados (copia diaria / manual / previo a restaurar)
CREATE TABLE IF NOT EXISTS backups_historial (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  fecha TEXT NOT NULL,
  ruta_archivo TEXT NOT NULL,
  tamano_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (tamano_bytes >= 0),
  tipo TEXT NOT NULL
    CHECK (tipo IN ('automatico_diario', 'manual', 'previo_restauracion')),
  usuario_id TEXT REFERENCES usuarios(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backups_historial_fecha
  ON backups_historial(comercio_id, fecha DESC);
