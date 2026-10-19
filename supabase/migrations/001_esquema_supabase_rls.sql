-- ============================================================================
-- Migración Supabase 001: Esquema espejo Postgres + RLS + Storage (Fase 2)
-- Reglas inviolables aplicadas (PLAN.md §3, §4, §5, §5.1, §6.1):
-- - IDs UUID (UUIDv7 generados en cliente/servidor)
-- - Importes monetarios en BIGINT (centavos)
-- - RLS estricto por comercio_id en todas las tablas
-- - Tabla auditoria append-only: solo INSERT y SELECT (solo superadmin lee),
--   prohibido UPDATE y DELETE para todos los roles
-- - Bucket privado 'productos' en Supabase Storage con RLS por comercio_id
-- - Vista segura vista_productos_venta sin costo_compra (Regla 20)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. Tablas de Configuración, Usuarios, Dispositivos y Auditoría
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.comercios (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL,
  nombre TEXT NOT NULL,
  razon_social TEXT,
  cuit TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'monotributo'
    CHECK (condicion_iva IN ('monotributo', 'responsable_inscripto', 'exento')),
  domicilio TEXT,
  rubro TEXT NOT NULL DEFAULT 'general',
  moneda TEXT NOT NULL DEFAULT 'ARS',
  precios_incluyen_iva BOOLEAN NOT NULL DEFAULT FALSE,
  venta_movil_habilitada BOOLEAN NOT NULL DEFAULT FALSE,
  arca_habilitada BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.usuarios (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  auth_user_id UUID UNIQUE, -- Vínculo opcional con auth.users de Supabase Auth
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL,
  clave_hash TEXT NOT NULL,
  pin_hash TEXT,
  rol TEXT NOT NULL
    CHECK (rol IN ('superadmin', 'encargado', 'cajero')),
  puede_vender_movil BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  debe_cambiar_clave BOOLEAN NOT NULL DEFAULT TRUE,
  intentos_fallidos INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TIMESTAMPTZ,
  ultimo_ingreso TIMESTAMPTZ,
  creado_por UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado',
  UNIQUE (comercio_id, usuario)
);

CREATE TABLE IF NOT EXISTS public.dispositivos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  ultima_sincronizacion TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.auditoria (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  fecha_hora TIMESTAMPTZ NOT NULL,
  usuario_id UUID,
  usuario_nombre TEXT NOT NULL,
  rol TEXT NOT NULL
    CHECK (rol IN ('superadmin', 'encargado', 'cajero')),
  device_id TEXT NOT NULL,
  accion TEXT NOT NULL,
  entidad TEXT NOT NULL,
  entidad_id TEXT,
  valores_antes TEXT,
  valores_despues TEXT,
  motivo TEXT,
  autorizado_por_id UUID,
  autorizado_por_nombre TEXT,
  hash_prev TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE INDEX IF NOT EXISTS idx_auditoria_comercio_fecha
  ON public.auditoria(comercio_id, fecha_hora);

-- ----------------------------------------------------------------------------
-- 2. Catálogo y Precios
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.categorias (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  padre_id UUID REFERENCES public.categorias(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.marcas (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.proveedores (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  cuit TEXT,
  contacto TEXT,
  condiciones_pago TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.productos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  codigo_interno TEXT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  categoria_id UUID REFERENCES public.categorias(id),
  marca_id UUID REFERENCES public.marcas(id),
  proveedor_principal_id UUID REFERENCES public.proveedores(id),
  unidad TEXT NOT NULL DEFAULT 'unidad'
    CHECK (unidad IN ('unidad', 'kg', 'm', 'l', 'caja')),
  permite_decimales BOOLEAN NOT NULL DEFAULT FALSE,
  costo_compra BIGINT NOT NULL DEFAULT 0
    CHECK (costo_compra >= 0),
  alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 21
    CHECK (alicuota_iva IN (0, 10.5, 21, 27)),
  exento_iva BOOLEAN NOT NULL DEFAULT FALSE,
  stock_minimo NUMERIC(12,3) NOT NULL DEFAULT 0,
  ubicacion TEXT,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  boton_rapido BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_ultimo_cambio_precio TIMESTAMPTZ,
  imagen_path TEXT,
  imagen_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.codigos_barras (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  codigo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_codigos_barras_unico_activo
  ON public.codigos_barras(comercio_id, codigo)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.listas_precio (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  es_predeterminada BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.precios (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  lista_precio_id UUID NOT NULL REFERENCES public.listas_precio(id),
  precio_venta BIGINT NOT NULL
    CHECK (precio_venta >= 0),
  margen_porcentaje NUMERIC(8,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado',
  UNIQUE (producto_id, lista_precio_id)
);

-- ----------------------------------------------------------------------------
-- 3. Stock (append-only, Regla 4)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.movimientos_stock (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  tipo TEXT NOT NULL
    CHECK (tipo IN ('compra', 'venta', 'anulacion_venta', 'ajuste', 'devolucion', 'merma')),
  cantidad NUMERIC(12,3) NOT NULL
    CHECK (cantidad != 0),
  costo_unitario BIGINT NOT NULL DEFAULT 0
    CHECK (costo_unitario >= 0),
  referencia_id TEXT,
  motivo TEXT,
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_producto
  ON public.movimientos_stock(comercio_id, producto_id);

-- ----------------------------------------------------------------------------
-- 4. Clientes, Caja, Ventas y Compras
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.clientes (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  cuit_dni TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'consumidor_final'
    CHECK (condicion_iva IN ('consumidor_final', 'monotributo', 'responsable_inscripto', 'exento')),
  telefono TEXT,
  email TEXT,
  domicilio TEXT,
  limite_credito BIGINT NOT NULL DEFAULT 0
    CHECK (limite_credito >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.cuenta_corriente_movimientos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  entidad_tipo TEXT NOT NULL
    CHECK (entidad_tipo IN ('cliente', 'proveedor')),
  entidad_id UUID NOT NULL,
  tipo TEXT NOT NULL
    CHECK (tipo IN ('cargo', 'pago')),
  monto BIGINT NOT NULL
    CHECK (monto > 0),
  referencia_id TEXT,
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.caja_sesiones (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  fecha_apertura TIMESTAMPTZ NOT NULL,
  monto_inicial BIGINT NOT NULL DEFAULT 0
    CHECK (monto_inicial >= 0),
  fecha_cierre TIMESTAMPTZ,
  usuario_cierre_id UUID REFERENCES public.usuarios(id),
  efectivo_esperado BIGINT,
  efectivo_contado BIGINT,
  diferencia BIGINT,
  estado TEXT NOT NULL DEFAULT 'abierta'
    CHECK (estado IN ('abierta', 'cerrada')),
  observaciones TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.caja_movimientos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  caja_sesion_id UUID NOT NULL REFERENCES public.caja_sesiones(id),
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  fecha TIMESTAMPTZ NOT NULL,
  tipo TEXT NOT NULL
    CHECK (tipo IN ('ingreso', 'egreso')),
  concepto TEXT NOT NULL,
  monto BIGINT NOT NULL
    CHECK (monto > 0),
  medio TEXT NOT NULL DEFAULT 'efectivo'
    CHECK (medio IN ('efectivo', 'transferencia', 'mercado_pago', 'qr', 'debito', 'credito', 'cuenta_corriente', 'otro')),
  referencia_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.ventas (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  fecha TIMESTAMPTZ NOT NULL,
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  cliente_id UUID REFERENCES public.clientes(id),
  subtotal BIGINT NOT NULL
    CHECK (subtotal >= 0),
  descuento BIGINT NOT NULL DEFAULT 0
    CHECK (descuento >= 0),
  total BIGINT NOT NULL
    CHECK (total >= 0),
  estado TEXT NOT NULL DEFAULT 'completada'
    CHECK (estado IN ('completada', 'anulada')),
  anulada_por_id UUID REFERENCES public.usuarios(id),
  autorizada_por_id UUID REFERENCES public.usuarios(id),
  fecha_anulacion TIMESTAMPTZ,
  motivo_anulacion TEXT,
  caja_sesion_id UUID REFERENCES public.caja_sesiones(id),
  tipo_comprobante TEXT NOT NULL DEFAULT 'ticket_no_fiscal'
    CHECK (tipo_comprobante IN ('ticket_no_fiscal', 'factura_a', 'factura_b', 'factura_c', 'nota_credito_a', 'nota_credito_b', 'nota_credito_c')),
  punto_venta INTEGER,
  numero_comprobante INTEGER,
  cae TEXT,
  cae_vencimiento TIMESTAMPTZ,
  canal TEXT NOT NULL DEFAULT 'escritorio'
    CHECK (canal IN ('escritorio', 'web')),
  dispositivo_id TEXT NOT NULL,
  estado_facturacion TEXT NOT NULL DEFAULT 'no_aplica'
    CHECK (estado_facturacion IN ('no_aplica', 'pendiente', 'emitida', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.ventas_items (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  venta_id UUID NOT NULL REFERENCES public.ventas(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(12,3) NOT NULL
    CHECK (cantidad > 0),
  precio_unitario BIGINT NOT NULL
    CHECK (precio_unitario >= 0),
  costo_unitario BIGINT NOT NULL
    CHECK (costo_unitario >= 0),
  descuento BIGINT NOT NULL DEFAULT 0
    CHECK (descuento >= 0),
  subtotal BIGINT NOT NULL
    CHECK (subtotal >= 0),
  alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 21,
  exento_iva BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.ventas_pagos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  venta_id UUID NOT NULL REFERENCES public.ventas(id),
  medio TEXT NOT NULL
    CHECK (medio IN ('efectivo', 'transferencia', 'mercado_pago', 'qr', 'debito', 'credito', 'cuenta_corriente', 'otro')),
  monto BIGINT NOT NULL
    CHECK (monto > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.compras (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  proveedor_id UUID NOT NULL REFERENCES public.proveedores(id),
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  fecha TIMESTAMPTZ NOT NULL,
  comprobante_proveedor TEXT,
  subtotal BIGINT NOT NULL
    CHECK (subtotal >= 0),
  iva BIGINT NOT NULL DEFAULT 0
    CHECK (iva >= 0),
  total BIGINT NOT NULL
    CHECK (total >= 0),
  estado TEXT NOT NULL DEFAULT 'registrada'
    CHECK (estado IN ('registrada', 'anulada')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE TABLE IF NOT EXISTS public.compras_items (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  compra_id UUID NOT NULL REFERENCES public.compras(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  cantidad NUMERIC(12,3) NOT NULL
    CHECK (cantidad > 0),
  costo_unitario BIGINT NOT NULL
    CHECK (costo_unitario >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

-- ----------------------------------------------------------------------------
-- 5. Triggers de Inmutabilidad en Postgres (Reglas 3, 4, 14, 15)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_prohibir_mutacion_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'TABLA_APPEND_ONLY: La tabla % no permite UPDATE ni DELETE.', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_pg_auditoria_inmutable ON public.auditoria;
CREATE TRIGGER trg_pg_auditoria_inmutable
BEFORE UPDATE OR DELETE ON public.auditoria
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

DROP TRIGGER IF EXISTS trg_pg_movimientos_stock_inmutable ON public.movimientos_stock;
CREATE TRIGGER trg_pg_movimientos_stock_inmutable
BEFORE UPDATE OR DELETE ON public.movimientos_stock
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

DROP TRIGGER IF EXISTS trg_pg_ventas_items_inmutable ON public.ventas_items;
CREATE TRIGGER trg_pg_ventas_items_inmutable
BEFORE UPDATE OR DELETE ON public.ventas_items
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

DROP TRIGGER IF EXISTS trg_pg_ventas_pagos_inmutable ON public.ventas_pagos;
CREATE TRIGGER trg_pg_ventas_pagos_inmutable
BEFORE UPDATE OR DELETE ON public.ventas_pagos
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

-- Revocar explícitamente UPDATE y DELETE sobre auditoria
REVOKE UPDATE, DELETE ON public.auditoria FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. Funciones Auxiliares y Políticas Row Level Security (RLS) por comercio_id
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mi_comercio_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT u.comercio_id
      FROM public.usuarios u
      WHERE u.auth_user_id = auth.uid()
        AND u.activo = TRUE
        AND u.deleted_at IS NULL
      LIMIT 1
    ),
    NULLIF(current_setting('request.headers', true)::json->>'x-comercio-id', '')::uuid
  );
$$;

CREATE OR REPLACE FUNCTION public.mi_rol()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT u.rol
      FROM public.usuarios u
      WHERE u.auth_user_id = auth.uid()
        AND u.activo = TRUE
        AND u.deleted_at IS NULL
      LIMIT 1
    ),
    NULLIF(current_setting('request.headers', true)::json->>'x-rol-usuario', '')
  );
$$;

-- Habilitar RLS en todas las tablas
ALTER TABLE public.comercios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispositivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marcas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.codigos_barras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listas_precio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cuenta_corriente_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caja_sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caja_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas_pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras_items ENABLE ROW LEVEL SECURITY;

-- Políticas de Auditoría (PLAN.md §6.1: solo INSERT para el comercio; SELECT solo superadmin; NUNCA UPDATE/DELETE)
CREATE POLICY rls_auditoria_insert ON public.auditoria
  FOR INSERT TO anon, authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_auditoria_select_superadmin ON public.auditoria
  FOR SELECT TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

-- Políticas de Usuarios (solo superadmin gestiona usuarios; todos los del comercio leen usuarios para trazabilidad)
CREATE POLICY rls_usuarios_select ON public.usuarios
  FOR SELECT TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_usuarios_write_superadmin ON public.usuarios
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin')
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

-- Políticas por comercio_id para tablas operativas de terminales
CREATE POLICY rls_comercios_all ON public.comercios
  FOR ALL TO anon, authenticated
  USING (id = public.mi_comercio_id())
  WITH CHECK (id = public.mi_comercio_id());

CREATE POLICY rls_dispositivos_all ON public.dispositivos
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_categorias_all ON public.categorias
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_marcas_all ON public.marcas
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_proveedores_all ON public.proveedores
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

-- Productos: solo superadmin y encargado pueden leer/escribir la tabla completa con costo_compra
CREATE POLICY rls_productos_admin_encargado ON public.productos
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

CREATE POLICY rls_codigos_barras_all ON public.codigos_barras
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_listas_precio_all ON public.listas_precio
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_precios_all ON public.precios
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_movimientos_stock_select ON public.movimientos_stock
  FOR SELECT TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_movimientos_stock_insert ON public.movimientos_stock
  FOR INSERT TO anon, authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_clientes_all ON public.clientes
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_cc_movimientos_all ON public.cuenta_corriente_movimientos
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_caja_sesiones_all ON public.caja_sesiones
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_caja_movimientos_all ON public.caja_movimientos
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_ventas_all ON public.ventas
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_ventas_items_select ON public.ventas_items
  FOR SELECT TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_ventas_items_insert ON public.ventas_items
  FOR INSERT TO anon, authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_ventas_pagos_select ON public.ventas_pagos
  FOR SELECT TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_ventas_pagos_insert ON public.ventas_pagos
  FOR INSERT TO anon, authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE POLICY rls_compras_admin_encargado ON public.compras
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

CREATE POLICY rls_compras_items_admin_encargado ON public.compras_items
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

-- ----------------------------------------------------------------------------
-- 7. Vistas Seguras en Servidor (Regla 20: vista_productos_venta sin costo_compra)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.productos_venta AS
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
FROM public.productos p
LEFT JOIN public.listas_precio lp
  ON lp.comercio_id = p.comercio_id
  AND lp.es_predeterminada = TRUE
  AND lp.deleted_at IS NULL
LEFT JOIN public.precios pr
  ON pr.producto_id = p.id
  AND pr.lista_precio_id = lp.id
  AND pr.deleted_at IS NULL
WHERE p.deleted_at IS NULL
  AND p.comercio_id = public.mi_comercio_id();

-- ----------------------------------------------------------------------------
-- 8. Bucket Privado en Supabase Storage para Imágenes de Productos (PLAN.md §5.1)
-- Ruta: <comercio_id>/<producto_id>.webp y <comercio_id>/<producto_id>_thumb.webp
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('productos', 'productos', FALSE, 204800, ARRAY['image/webp'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY storage_productos_select ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'productos'
    AND (storage.foldername(name))[1]::uuid = public.mi_comercio_id()
  );

CREATE POLICY storage_productos_insert ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'productos'
    AND (storage.foldername(name))[1]::uuid = public.mi_comercio_id()
    AND public.mi_rol() IN ('superadmin', 'encargado')
  );

CREATE POLICY storage_productos_update ON storage.objects
  FOR UPDATE TO anon, authenticated
  USING (
    bucket_id = 'productos'
    AND (storage.foldername(name))[1]::uuid = public.mi_comercio_id()
    AND public.mi_rol() IN ('superadmin', 'encargado')
  );
