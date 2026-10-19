-- =============================================================================
-- Migración 001: Esquema inicial completo (PLAN.md §3, §4, §6.1)
-- Reglas aplicadas:
-- - Todos los IDs son TEXT (UUIDv7)
-- - Importes monetarios en INTEGER (centavos)
-- - Tablas sincronizables con created_at, updated_at, deleted_at, device_id, sync_status
-- - Triggers de inmutabilidad en auditoria, movimientos_stock, ventas_items, ventas_pagos y ventas
-- - Protección del último superadmin activo en usuarios
-- =============================================================================

-- 1. Configuración y usuarios
CREATE TABLE IF NOT EXISTS comercios (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  razon_social TEXT,
  cuit TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'monotributo'
    CHECK (condicion_iva IN ('monotributo', 'responsable_inscripto', 'exento', 'consumidor_final')),
  precios_incluyen_iva INTEGER NOT NULL DEFAULT 1
    CHECK (precios_incluyen_iva IN (0, 1)),
  domicilio TEXT,
  rubro TEXT,
  moneda TEXT NOT NULL DEFAULT 'ARS',
  venta_movil_habilitada INTEGER NOT NULL DEFAULT 0
    CHECK (venta_movil_habilitada IN (0, 1)),
  arca_habilitada INTEGER NOT NULL DEFAULT 0
    CHECK (arca_habilitada IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL,
  clave_hash TEXT NOT NULL,
  pin_hash TEXT,
  rol TEXT NOT NULL
    CHECK (rol IN ('superadmin', 'encargado', 'cajero')),
  puede_vender_movil INTEGER NOT NULL DEFAULT 0
    CHECK (puede_vender_movil IN (0, 1)),
  activo INTEGER NOT NULL DEFAULT 1
    CHECK (activo IN (0, 1)),
  debe_cambiar_clave INTEGER NOT NULL DEFAULT 1
    CHECK (debe_cambiar_clave IN (0, 1)),
  intentos_fallidos INTEGER NOT NULL DEFAULT 0
    CHECK (intentos_fallidos >= 0),
  bloqueado_hasta TEXT,
  ultimo_ingreso TEXT,
  creado_por TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_comercio_usuario
  ON usuarios(comercio_id, lower(usuario))
  WHERE deleted_at IS NULL;

-- Prohibir borrado físico de usuarios (Regla 15: los usuarios no se borran, se desactivan)
CREATE TRIGGER IF NOT EXISTS trg_usuarios_no_delete
BEFORE DELETE ON usuarios
BEGIN
  SELECT RAISE(ABORT, 'USUARIO_NO_ELIMINABLE: Los usuarios no se borran fisicamente; se desactivan.');
END;

-- Prohibir desactivar, borrar lógicamente o degradar al último superadmin activo (PLAN.md §6.1 / §13)
CREATE TRIGGER IF NOT EXISTS trg_usuarios_proteger_ultimo_superadmin
BEFORE UPDATE ON usuarios
WHEN OLD.rol = 'superadmin'
  AND OLD.activo = 1
  AND OLD.deleted_at IS NULL
  AND (NEW.rol != 'superadmin' OR NEW.activo = 0 OR NEW.deleted_at IS NOT NULL)
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM usuarios
      WHERE comercio_id = OLD.comercio_id
        AND rol = 'superadmin'
        AND activo = 1
        AND deleted_at IS NULL
        AND id != OLD.id
    ) = 0
    THEN RAISE(ABORT, 'ULTIMO_SUPERADMIN: No se puede desactivar ni degradar al ultimo superadmin activo.')
  END;
END;

CREATE TABLE IF NOT EXISTS dispositivos (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  ultima_sincronizacion TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

-- Auditoría (append-only con cadena SHA-256, Reglas 13 y 14)
CREATE TABLE IF NOT EXISTS auditoria (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  fecha_hora TEXT NOT NULL,
  usuario_id TEXT,
  usuario_nombre TEXT NOT NULL,
  rol TEXT NOT NULL,
  device_id TEXT NOT NULL,
  accion TEXT NOT NULL,
  entidad TEXT NOT NULL,
  entidad_id TEXT,
  valores_antes TEXT,
  valores_despues TEXT,
  motivo TEXT,
  autorizado_por_id TEXT,
  autorizado_por_nombre TEXT,
  hash_prev TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_auditoria_comercio_fecha
  ON auditoria(comercio_id, fecha_hora);

CREATE INDEX IF NOT EXISTS idx_auditoria_entidad
  ON auditoria(comercio_id, entidad, entidad_id);

CREATE TRIGGER IF NOT EXISTS trg_auditoria_no_update
BEFORE UPDATE ON auditoria
BEGIN
  SELECT RAISE(ABORT, 'AUDITORIA_INMUTABLE: La tabla auditoria es append-only y no permite modificaciones.');
END;

CREATE TRIGGER IF NOT EXISTS trg_auditoria_no_delete
BEFORE DELETE ON auditoria
BEGIN
  SELECT RAISE(ABORT, 'AUDITORIA_INMUTABLE: La tabla auditoria es append-only y no permite eliminaciones.');
END;

-- 2. Catálogo
CREATE TABLE IF NOT EXISTS categorias (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  padre_id TEXT REFERENCES categorias(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS marcas (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS proveedores (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  cuit TEXT,
  contacto TEXT,
  condiciones_pago TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  codigo_interno TEXT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  categoria_id TEXT REFERENCES categorias(id),
  marca_id TEXT REFERENCES marcas(id),
  proveedor_principal_id TEXT REFERENCES proveedores(id),
  unidad TEXT NOT NULL DEFAULT 'unidad'
    CHECK (unidad IN ('unidad', 'kg', 'm', 'l', 'caja')),
  permite_decimales INTEGER NOT NULL DEFAULT 0
    CHECK (permite_decimales IN (0, 1)),
  costo_compra INTEGER NOT NULL DEFAULT 0
    CHECK (costo_compra >= 0),
  alicuota_iva REAL NOT NULL DEFAULT 21
    CHECK (alicuota_iva IN (0, 10.5, 21, 27)),
  exento_iva INTEGER NOT NULL DEFAULT 0
    CHECK (exento_iva IN (0, 1)),
  stock_minimo REAL NOT NULL DEFAULT 0
    CHECK (stock_minimo >= 0),
  ubicacion TEXT,
  activo INTEGER NOT NULL DEFAULT 1
    CHECK (activo IN (0, 1)),
  boton_rapido INTEGER NOT NULL DEFAULT 0
    CHECK (boton_rapido IN (0, 1)),
  fecha_ultimo_cambio_precio TEXT,
  imagen_path TEXT,
  imagen_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_productos_comercio_nombre
  ON productos(comercio_id, nombre)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS codigos_barras (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  codigo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_codigos_barras_unico
  ON codigos_barras(comercio_id, codigo)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS listas_precio (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  es_predeterminada INTEGER NOT NULL DEFAULT 0
    CHECK (es_predeterminada IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS precios (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  lista_precio_id TEXT NOT NULL REFERENCES listas_precio(id),
  precio_venta INTEGER NOT NULL
    CHECK (precio_venta >= 0),
  margen_bp INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_precios_producto_lista
  ON precios(comercio_id, producto_id, lista_precio_id)
  WHERE deleted_at IS NULL;

-- 3. Stock (append-only, Regla 4)
CREATE TABLE IF NOT EXISTS movimientos_stock (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  tipo TEXT NOT NULL
    CHECK (tipo IN ('compra', 'venta', 'anulacion_venta', 'ajuste', 'devolucion', 'merma')),
  cantidad REAL NOT NULL
    CHECK (cantidad != 0),
  costo_unitario INTEGER NOT NULL DEFAULT 0
    CHECK (costo_unitario >= 0),
  referencia_id TEXT,
  motivo TEXT,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_producto
  ON movimientos_stock(comercio_id, producto_id);

CREATE TRIGGER IF NOT EXISTS trg_movimientos_stock_no_update
BEFORE UPDATE ON movimientos_stock
BEGIN
  SELECT RAISE(ABORT, 'STOCK_INMUTABLE: Los movimientos de stock son append-only y no pueden editarse.');
END;

CREATE TRIGGER IF NOT EXISTS trg_movimientos_stock_no_delete
BEFORE DELETE ON movimientos_stock
BEGIN
  SELECT RAISE(ABORT, 'STOCK_INMUTABLE: Los movimientos de stock son append-only y no pueden borrarse.');
END;

-- 4. Clientes y cuenta corriente
CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  nombre TEXT NOT NULL,
  cuit_dni TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'consumidor_final'
    CHECK (condicion_iva IN ('consumidor_final', 'monotributo', 'responsable_inscripto', 'exento')),
  telefono TEXT,
  email TEXT,
  domicilio TEXT,
  limite_credito INTEGER NOT NULL DEFAULT 0
    CHECK (limite_credito >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS cuenta_corriente_movimientos (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  entidad_tipo TEXT NOT NULL
    CHECK (entidad_tipo IN ('cliente', 'proveedor')),
  entidad_id TEXT NOT NULL,
  tipo TEXT NOT NULL
    CHECK (tipo IN ('cargo', 'pago')),
  monto INTEGER NOT NULL
    CHECK (monto > 0),
  referencia_id TEXT,
  observaciones TEXT,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

-- 5. Caja
CREATE TABLE IF NOT EXISTS caja_sesiones (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  fecha_apertura TEXT NOT NULL,
  monto_inicial INTEGER NOT NULL DEFAULT 0
    CHECK (monto_inicial >= 0),
  fecha_cierre TEXT,
  usuario_cierre_id TEXT REFERENCES usuarios(id),
  efectivo_esperado INTEGER,
  efectivo_contado INTEGER,
  diferencia INTEGER,
  estado TEXT NOT NULL DEFAULT 'abierta'
    CHECK (estado IN ('abierta', 'cerrada')),
  observaciones TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS caja_movimientos (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  caja_sesion_id TEXT NOT NULL REFERENCES caja_sesiones(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL
    CHECK (tipo IN ('ingreso', 'egreso')),
  concepto TEXT NOT NULL,
  monto INTEGER NOT NULL
    CHECK (monto > 0),
  medio TEXT NOT NULL DEFAULT 'efectivo'
    CHECK (medio IN ('efectivo', 'transferencia', 'mercado_pago', 'qr', 'debito', 'credito', 'cuenta_corriente', 'otro')),
  referencia_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

-- 6. Ventas (append-only; nunca se borran, solo se anulan, Regla 3)
CREATE TABLE IF NOT EXISTS ventas (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  fecha TEXT NOT NULL,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  cliente_id TEXT REFERENCES clientes(id),
  subtotal INTEGER NOT NULL
    CHECK (subtotal >= 0),
  descuento INTEGER NOT NULL DEFAULT 0
    CHECK (descuento >= 0),
  total INTEGER NOT NULL
    CHECK (total >= 0),
  estado TEXT NOT NULL DEFAULT 'completada'
    CHECK (estado IN ('completada', 'anulada')),
  anulada_por_id TEXT REFERENCES usuarios(id),
  autorizada_por_id TEXT REFERENCES usuarios(id),
  fecha_anulacion TEXT,
  motivo_anulacion TEXT,
  caja_sesion_id TEXT REFERENCES caja_sesiones(id),
  tipo_comprobante TEXT NOT NULL DEFAULT 'ticket_no_fiscal'
    CHECK (tipo_comprobante IN ('ticket_no_fiscal', 'factura_a', 'factura_b', 'factura_c', 'nota_credito_a', 'nota_credito_b', 'nota_credito_c')),
  punto_venta INTEGER,
  numero_comprobante INTEGER,
  cae TEXT,
  cae_vencimiento TEXT,
  canal TEXT NOT NULL DEFAULT 'escritorio'
    CHECK (canal IN ('escritorio', 'web')),
  dispositivo_id TEXT NOT NULL,
  estado_facturacion TEXT NOT NULL DEFAULT 'no_aplica'
    CHECK (estado_facturacion IN ('no_aplica', 'pendiente', 'emitida', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_ventas_comercio_fecha
  ON ventas(comercio_id, fecha);

CREATE TRIGGER IF NOT EXISTS trg_ventas_no_delete
BEFORE DELETE ON ventas
BEGIN
  SELECT RAISE(ABORT, 'VENTA_INMUTABLE: Las ventas no se borran; deben anularse.');
END;

-- Prohibir editar importes, usuario o fecha de una venta existente
CREATE TRIGGER IF NOT EXISTS trg_ventas_proteger_importes
BEFORE UPDATE ON ventas
WHEN OLD.subtotal != NEW.subtotal
  OR OLD.descuento != NEW.descuento
  OR OLD.total != NEW.total
  OR OLD.usuario_id != NEW.usuario_id
  OR OLD.fecha != NEW.fecha
  OR (OLD.estado = 'anulada' AND NEW.estado != 'anulada')
BEGIN
  SELECT RAISE(ABORT, 'VENTA_INMUTABLE: No se pueden modificar los importes ni revertir una venta anulada.');
END;

CREATE TABLE IF NOT EXISTS ventas_items (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL
    CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL
    CHECK (precio_unitario >= 0),
  costo_unitario INTEGER NOT NULL
    CHECK (costo_unitario >= 0),
  descuento INTEGER NOT NULL DEFAULT 0
    CHECK (descuento >= 0),
  subtotal INTEGER NOT NULL
    CHECK (subtotal >= 0),
  alicuota_iva REAL NOT NULL DEFAULT 21,
  exento_iva INTEGER NOT NULL DEFAULT 0
    CHECK (exento_iva IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_ventas_items_venta
  ON ventas_items(venta_id);

CREATE TRIGGER IF NOT EXISTS trg_ventas_items_no_update
BEFORE UPDATE ON ventas_items
BEGIN
  SELECT RAISE(ABORT, 'VENTA_ITEM_INMUTABLE: Los items de venta no pueden editarse.');
END;

CREATE TRIGGER IF NOT EXISTS trg_ventas_items_no_delete
BEFORE DELETE ON ventas_items
BEGIN
  SELECT RAISE(ABORT, 'VENTA_ITEM_INMUTABLE: Los items de venta no pueden borrarse.');
END;

CREATE TABLE IF NOT EXISTS ventas_pagos (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  medio TEXT NOT NULL
    CHECK (medio IN ('efectivo', 'transferencia', 'mercado_pago', 'qr', 'debito', 'credito', 'cuenta_corriente', 'otro')),
  monto INTEGER NOT NULL
    CHECK (monto > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_ventas_pagos_venta
  ON ventas_pagos(venta_id);

CREATE TRIGGER IF NOT EXISTS trg_ventas_pagos_no_update
BEFORE UPDATE ON ventas_pagos
BEGIN
  SELECT RAISE(ABORT, 'VENTA_PAGO_INMUTABLE: Los pagos de venta no pueden editarse.');
END;

CREATE TRIGGER IF NOT EXISTS trg_ventas_pagos_no_delete
BEFORE DELETE ON ventas_pagos
BEGIN
  SELECT RAISE(ABORT, 'VENTA_PAGO_INMUTABLE: Los pagos de venta no pueden borrarse.');
END;

-- 7. Compras
CREATE TABLE IF NOT EXISTS compras (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  proveedor_id TEXT NOT NULL REFERENCES proveedores(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  fecha TEXT NOT NULL,
  comprobante_proveedor TEXT,
  subtotal INTEGER NOT NULL
    CHECK (subtotal >= 0),
  iva INTEGER NOT NULL DEFAULT 0
    CHECK (iva >= 0),
  total INTEGER NOT NULL
    CHECK (total >= 0),
  estado TEXT NOT NULL DEFAULT 'registrada'
    CHECK (estado IN ('registrada', 'anulada')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

CREATE TABLE IF NOT EXISTS compras_items (
  id TEXT PRIMARY KEY NOT NULL,
  comercio_id TEXT NOT NULL REFERENCES comercios(id),
  compra_id TEXT NOT NULL REFERENCES compras(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  cantidad REAL NOT NULL
    CHECK (cantidad > 0),
  costo_unitario INTEGER NOT NULL
    CHECK (costo_unitario >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'error'))
);

-- 8. Sincronización (solo local, PLAN.md §4 y §5)
CREATE TABLE IF NOT EXISTS sync_cola (
  id TEXT PRIMARY KEY NOT NULL,
  tabla TEXT NOT NULL,
  registro_id TEXT NOT NULL,
  operacion TEXT NOT NULL
    CHECK (operacion IN ('insert', 'update', 'delete_logico')),
  timestamp TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'procesando', 'sincronizado', 'error')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_cola_estado
  ON sync_cola(estado, timestamp);

CREATE TABLE IF NOT EXISTS sync_estado (
  tabla TEXT PRIMARY KEY NOT NULL,
  ultima_bajada_at TEXT,
  ultima_subida_at TEXT
);

-- 9. Vistas de consulta segura (Regla 20: sin costo_compra para venta/cajero/cliente)
CREATE VIEW IF NOT EXISTS vista_productos_venta AS
SELECT
  p.id,
  p.comercio_id,
  p.codigo_interno,
  p.nombre,
  p.descripcion,
  p.categoria_id,
  p.marca_id,
  p.unidad,
  p.permite_decimales,
  p.alicuota_iva,
  p.exento_iva,
  p.ubicacion,
  p.activo,
  p.boton_rapido,
  p.imagen_path,
  p.imagen_hash,
  pr.lista_precio_id,
  pr.precio_venta
FROM productos p
LEFT JOIN listas_precio lp
  ON lp.comercio_id = p.comercio_id
  AND lp.es_predeterminada = 1
  AND lp.deleted_at IS NULL
LEFT JOIN precios pr
  ON pr.producto_id = p.id
  AND pr.lista_precio_id = lp.id
  AND pr.deleted_at IS NULL
WHERE p.deleted_at IS NULL;

-- Vista de stock actual calculado desde movimientos (Regla 4)
CREATE VIEW IF NOT EXISTS vista_stock_actual AS
SELECT
  p.comercio_id,
  p.id AS producto_id,
  p.nombre,
  p.stock_minimo,
  ROUND(COALESCE(SUM(m.cantidad), 0), 3) AS stock_actual
FROM productos p
LEFT JOIN movimientos_stock m
  ON m.producto_id = p.id
  AND m.comercio_id = p.comercio_id
  AND m.deleted_at IS NULL
WHERE p.deleted_at IS NULL
GROUP BY p.comercio_id, p.id, p.nombre, p.stock_minimo;
