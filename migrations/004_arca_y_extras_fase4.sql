-- ============================================================================
-- Migración 004: Facturación Electrónica ARCA (ex-AFIP, Opcional) y Extras de
-- Fase 4: Múltiples Listas de Precio en Ventas, Variantes y Combos
-- (PLAN.md §3 Reglas 18, 19, 20; §4; §6.3 y §10 — Fase 4)
-- ============================================================================

-- 1. Configuración pública de ARCA en comercios (Regla 18 y 19: nunca se guardan
--    certificados ni claves privadas en el cliente; viven en la Edge Function)
ALTER TABLE comercios
  ADD COLUMN arca_ambiente TEXT NOT NULL DEFAULT 'homologacion'
    CHECK (arca_ambiente IN ('homologacion', 'produccion'));

ALTER TABLE comercios
  ADD COLUMN arca_punto_venta INTEGER NOT NULL DEFAULT 1
    CHECK (arca_punto_venta >= 1 AND arca_punto_venta <= 99999);

ALTER TABLE comercios
  ADD COLUMN arca_proveedor TEXT NOT NULL DEFAULT 'afip_sdk'
    CHECK (arca_proveedor IN ('afip_sdk', 'tus_facturas', 'simulador_homologacion'));

ALTER TABLE comercios
  ADD COLUMN arca_tope_consumidor_final INTEGER NOT NULL DEFAULT 34448800
    CHECK (arca_tope_consumidor_final >= 0);

-- 2. Campos adicionales en ventas para lista de precios aplicada, cola de
--    reintentos ARCA y Nota de Crédito por anulación de venta facturada (§6.3)
ALTER TABLE ventas
  ADD COLUMN lista_precio_id TEXT REFERENCES listas_precio(id);

ALTER TABLE ventas
  ADD COLUMN arca_ultimo_error TEXT;

ALTER TABLE ventas
  ADD COLUMN arca_intentos INTEGER NOT NULL DEFAULT 0
    CHECK (arca_intentos >= 0);

ALTER TABLE ventas
  ADD COLUMN nota_credito_tipo TEXT
    CHECK (
      nota_credito_tipo IS NULL
      OR nota_credito_tipo IN ('nota_credito_a', 'nota_credito_b', 'nota_credito_c')
    );

ALTER TABLE ventas
  ADD COLUMN nota_credito_numero INTEGER;

ALTER TABLE ventas
  ADD COLUMN nota_credito_cae TEXT;

ALTER TABLE ventas
  ADD COLUMN nota_credito_cae_vencimiento TEXT;

CREATE INDEX IF NOT EXISTS idx_ventas_estado_facturacion
  ON ventas(comercio_id, estado_facturacion, fecha DESC);

-- 3. Tabla de Variantes de Producto (talle, color, medida, etc. — PLAN.md §4 y §10)
CREATE TABLE IF NOT EXISTS variantes (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  nombre TEXT NOT NULL,
  atributo_1 TEXT,
  atributo_2 TEXT,
  sku_variante TEXT,
  codigo_barras TEXT,
  precio_adicional INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
    CHECK (activo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_variantes_producto
  ON variantes(comercio_id, producto_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_variantes_codigo_barras
  ON variantes(comercio_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL AND deleted_at IS NULL;

-- 4. Tablas de Combos y Promociones (PLAN.md §10)
CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  descripcion TEXT,
  codigo_barras TEXT,
  precio_venta INTEGER NOT NULL
    CHECK (precio_venta > 0),
  alicuota_iva REAL NOT NULL DEFAULT 21
    CHECK (alicuota_iva IN (0, 10.5, 21, 27)),
  exento_iva INTEGER NOT NULL DEFAULT 0
    CHECK (exento_iva IN (0, 1)),
  activo INTEGER NOT NULL DEFAULT 1
    CHECK (activo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_combos_codigo_barras
  ON combos(comercio_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS combos_items (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  combo_id TEXT NOT NULL REFERENCES combos(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  cantidad REAL NOT NULL
    CHECK (cantidad > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_combos_items_combo
  ON combos_items(comercio_id, combo_id)
  WHERE deleted_at IS NULL;
