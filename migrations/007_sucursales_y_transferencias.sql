-- ============================================================================
-- Migración 007: Administración de Sucursales, Stock por Ubicación y
-- Transferencias / Migración de Mercadería entre Sucursales (PLAN.md §3 Regla 4, §4 y §5)
-- ============================================================================

-- 1. Tabla de Sucursales del Comercio (sincronizable LWW)
CREATE TABLE IF NOT EXISTS sucursales (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  codigo TEXT,
  direccion TEXT,
  telefono TEXT,
  es_principal INTEGER NOT NULL DEFAULT 0
    CHECK (es_principal IN (0, 1)),
  activo INTEGER NOT NULL DEFAULT 1
    CHECK (activo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_sucursales_comercio
  ON sucursales(comercio_id, es_principal DESC, nombre ASC)
  WHERE deleted_at IS NULL;

-- 2. Tabla append-only de Transferencias / Migraciones de Stock entre Sucursales
CREATE TABLE IF NOT EXISTS transferencias_sucursales (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  sucursal_origen_id TEXT NOT NULL REFERENCES sucursales(id),
  sucursal_destino_id TEXT NOT NULL REFERENCES sucursales(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  motivo TEXT NOT NULL,
  fecha TEXT NOT NULL,
  cantidad_items INTEGER NOT NULL DEFAULT 1
    CHECK (cantidad_items >= 1),
  total_unidades REAL NOT NULL DEFAULT 0
    CHECK (total_unidades > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_transferencias_sucursales_fecha
  ON transferencias_sucursales(comercio_id, fecha DESC);

CREATE TRIGGER IF NOT EXISTS trg_transferencias_sucursales_no_delete
BEFORE DELETE ON transferencias_sucursales
BEGIN
  SELECT RAISE(ABORT, 'TRANSFERENCIA_INMUTABLE: Las transferencias entre sucursales son append-only y no pueden borrarse.');
END;

-- 3. Columna sucursal_id en movimientos_stock, ventas, compras, caja_sesiones y configuracion_sistema
ALTER TABLE movimientos_stock
  ADD COLUMN sucursal_id TEXT REFERENCES sucursales(id);

ALTER TABLE ventas
  ADD COLUMN sucursal_id TEXT REFERENCES sucursales(id);

ALTER TABLE compras
  ADD COLUMN sucursal_id TEXT REFERENCES sucursales(id);

ALTER TABLE caja_sesiones
  ADD COLUMN sucursal_id TEXT REFERENCES sucursales(id);

ALTER TABLE configuracion_sistema
  ADD COLUMN sucursal_activa_id TEXT;

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_sucursal
  ON movimientos_stock(comercio_id, sucursal_id, producto_id);

CREATE INDEX IF NOT EXISTS idx_ventas_sucursal_fecha
  ON ventas(comercio_id, sucursal_id, fecha);

CREATE INDEX IF NOT EXISTS idx_compras_sucursal_fecha
  ON compras(comercio_id, sucursal_id, fecha);

CREATE INDEX IF NOT EXISTS idx_caja_sesiones_sucursal
  ON caja_sesiones(comercio_id, sucursal_id, estado);
