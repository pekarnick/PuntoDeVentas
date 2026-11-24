-- ============================================================================
-- SCRIPT SQL UNIFICADO COMPLETO PARA SUPABASE (001 + 002 + 003 + 004)
-- Sistema POS Offline-First Argentino — Esquema Completo, RLS, Venta Móvil,
-- Facturación ARCA, Combos, Listas de Precio y Multi-Sucursal.
-- ============================================================================
-- INSTRUCCIONES:
-- 1. Abrí tu proyecto en https://supabase.com/dashboard -> SQL Editor -> New Query.
-- 2. Pegá este documento completo y presioná "Run" (Ctrl + Enter).
-- 3. Este script es 100% IDEMPOTENTE (usa IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS):
--    se puede ejecutar tanto en un proyecto nuevo desde cero como para actualizar
--    un proyecto existente SIN borrar ni perder ningún dato guardado.
-- ============================================================================

-- ============================================================================
-- PARTE 1 (001): ESQUEMA INICIAL POS, AUDITORÍA ENCADENADA, RLS Y STORAGE
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Entidades Base y Configuración del Comercio
CREATE TABLE IF NOT EXISTS public.comercios (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL,
  nombre TEXT NOT NULL,
  razon_social TEXT,
  nombre_fantasia TEXT,
  cuit TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'monotributo'
    CHECK (condicion_iva IN ('monotributo', 'responsable_inscripto', 'exento', 'consumidor_final')),
  ingresos_brutos TEXT,
  inicio_actividades TEXT,
  domicilio TEXT,
  domicilio_comercial TEXT,
  rubro TEXT NOT NULL DEFAULT 'general',
  moneda TEXT NOT NULL DEFAULT 'ARS',
  precios_incluyen_iva BOOLEAN NOT NULL DEFAULT TRUE,
  venta_movil_habilitada BOOLEAN NOT NULL DEFAULT FALSE,
  venta_movil_url TEXT,
  punto_venta_default INTEGER NOT NULL DEFAULT 1
    CHECK (punto_venta_default > 0),
  arca_habilitada BOOLEAN NOT NULL DEFAULT FALSE,
  arca_ambiente TEXT NOT NULL DEFAULT 'homologacion'
    CHECK (arca_ambiente IN ('homologacion', 'produccion')),
  arca_punto_venta INTEGER NOT NULL DEFAULT 1
    CHECK (arca_punto_venta >= 1 AND arca_punto_venta <= 99999),
  arca_proveedor TEXT NOT NULL DEFAULT 'afip_sdk'
    CHECK (arca_proveedor IN ('afip_sdk', 'tus_facturas', 'simulador_homologacion')),
  arca_tope_consumidor_final BIGINT NOT NULL DEFAULT 34448800
    CHECK (arca_tope_consumidor_final >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'conflicto', 'error'))
);

ALTER TABLE public.comercios
  ADD COLUMN IF NOT EXISTS comercio_id UUID,
  ADD COLUMN IF NOT EXISTS nombre TEXT,
  ADD COLUMN IF NOT EXISTS domicilio TEXT,
  ADD COLUMN IF NOT EXISTS rubro TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS moneda TEXT NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS precios_incluyen_iva BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS venta_movil_habilitada BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS venta_movil_url TEXT,
  ADD COLUMN IF NOT EXISTS arca_punto_venta INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS arca_proveedor TEXT NOT NULL DEFAULT 'afip_sdk',
  ADD COLUMN IF NOT EXISTS arca_tope_consumidor_final BIGINT NOT NULL DEFAULT 34448800;

CREATE TABLE IF NOT EXISTS public.usuarios (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  auth_user_id UUID UNIQUE,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL,
  clave_hash TEXT NOT NULL DEFAULT '',
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
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
    CHECK (sync_status IN ('pendiente', 'sincronizado', 'conflicto', 'error')),
  UNIQUE (comercio_id, usuario)
);

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS clave_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS puede_vender_movil BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS debe_cambiar_clave BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS intentos_fallidos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultimo_ingreso TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS creado_por UUID;

CREATE TABLE IF NOT EXISTS public.dispositivos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'escritorio'
    CHECK (tipo IN ('escritorio', 'web_movil')),
  ultima_sincronizacion TIMESTAMPTZ,
  ultimo_sync_at TIMESTAMPTZ,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.dispositivos
  ADD COLUMN IF NOT EXISTS ultima_sincronizacion TIMESTAMPTZ;

-- 2. Auditoría Inmutable y Encadenada (Reglas 13, 14, 15, 16)
-- Importante: usuario_id es nullable para auditar intentos de login fallidos con usuario inexistente
CREATE TABLE IF NOT EXISTS public.auditoria (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  fecha_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  usuario_id UUID,
  usuario_nombre TEXT NOT NULL DEFAULT 'sistema',
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

ALTER TABLE public.auditoria
  ALTER COLUMN usuario_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_auditoria_comercio_fecha
  ON public.auditoria(comercio_id, fecha_hora DESC);

-- 3. Catálogo, Precios en Centavos (BIGINT) y Movimientos de Stock (Reglas 2, 4, 20)
CREATE TABLE IF NOT EXISTS public.categorias (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  padre_id UUID REFERENCES public.categorias(id),
  descripcion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS padre_id UUID REFERENCES public.categorias(id);

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
  razon_social TEXT,
  cuit TEXT,
  contacto TEXT,
  condiciones_pago TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'responsable_inscripto'
    CHECK (condicion_iva IN ('monotributo', 'responsable_inscripto', 'exento', 'consumidor_final')),
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.proveedores
  ADD COLUMN IF NOT EXISTS nombre TEXT,
  ADD COLUMN IF NOT EXISTS contacto TEXT,
  ADD COLUMN IF NOT EXISTS condiciones_pago TEXT;

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
  margen_bp INTEGER NOT NULL DEFAULT 0,
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

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS fecha_ultimo_cambio_precio TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.codigos_barras (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  codigo TEXT NOT NULL,
  descripcion TEXT,
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
  descuento_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 0,
  recargo_descuento_bp INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.listas_precio
  ADD COLUMN IF NOT EXISTS descuento_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 0;

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

ALTER TABLE public.precios
  ADD COLUMN IF NOT EXISTS margen_porcentaje NUMERIC(8,2);

CREATE TABLE IF NOT EXISTS public.movimientos_stock (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  tipo TEXT NOT NULL
    CHECK (tipo IN ('compra', 'venta', 'anulacion_venta', 'anulacion', 'ajuste', 'merma', 'devolucion', 'inicial', 'transferencia_salida', 'transferencia_entrada')),
  cantidad NUMERIC(12,3) NOT NULL
    CHECK (cantidad <> 0),
  costo_unitario BIGINT NOT NULL DEFAULT 0
    CHECK (costo_unitario >= 0),
  referencia_tipo TEXT,
  referencia_id TEXT,
  motivo TEXT,
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  dispositivo_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.movimientos_stock
  ADD COLUMN IF NOT EXISTS referencia_tipo TEXT,
  ADD COLUMN IF NOT EXISTS costo_unitario BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS device_id TEXT;

-- 4. Clientes, Cuenta Corriente, Caja, Ventas y Compras
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
  proveedor_id UUID REFERENCES public.proveedores(id),
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

ALTER TABLE public.compras
  ALTER COLUMN proveedor_id DROP NOT NULL;

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

-- 5. Triggers de Inmutabilidad en Postgres (Reglas 3, 4, 14, 15)
CREATE OR REPLACE FUNCTION public.fn_prohibir_mutacion_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.reset_fabrica_autorizado', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TABLA_APPEND_ONLY: La tabla % no permite %.', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_proteger_ventas_inmutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.reset_fabrica_autorizado', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'TABLA_APPEND_ONLY: Las ventas no pueden eliminarse (Regla 3).';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.comercio_id IS DISTINCT FROM OLD.comercio_id
       OR NEW.fecha IS DISTINCT FROM OLD.fecha
       OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
       OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.descuento IS DISTINCT FROM OLD.descuento
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.canal IS DISTINCT FROM OLD.canal THEN
      RAISE EXCEPTION 'VENTA_INMUTABLE: No se pueden modificar importes ni cabecera histórica de una venta (Regla 3).';
    END IF;

    IF OLD.estado = 'anulada' AND NEW.estado IS DISTINCT FROM 'anulada' THEN
      RAISE EXCEPTION 'VENTA_INMUTABLE: Una venta anulada no puede reactivarse.';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
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

DROP TRIGGER IF EXISTS trg_pg_ventas_inmutable ON public.ventas;
CREATE TRIGGER trg_pg_ventas_inmutable
BEFORE UPDATE OR DELETE ON public.ventas
FOR EACH ROW EXECUTE FUNCTION public.fn_proteger_ventas_inmutable();

DROP TRIGGER IF EXISTS trg_pg_cc_movimientos_inmutable ON public.cuenta_corriente_movimientos;
CREATE TRIGGER trg_pg_cc_movimientos_inmutable
BEFORE UPDATE OR DELETE ON public.cuenta_corriente_movimientos
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

DROP TRIGGER IF EXISTS trg_pg_compras_inmutable ON public.compras;
CREATE TRIGGER trg_pg_compras_inmutable
BEFORE UPDATE OR DELETE ON public.compras
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

DROP TRIGGER IF EXISTS trg_pg_compras_items_inmutable ON public.compras_items;
CREATE TRIGGER trg_pg_compras_items_inmutable
BEFORE UPDATE OR DELETE ON public.compras_items
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

REVOKE UPDATE, DELETE ON public.auditoria FROM PUBLIC, anon, authenticated;
REVOKE SELECT (clave_hash, pin_hash) ON public.usuarios FROM PUBLIC, anon, authenticated;
REVOKE SELECT (costo_unitario) ON public.ventas_items FROM PUBLIC, anon;
REVOKE SELECT (costo_unitario) ON public.movimientos_stock FROM PUBLIC, anon;

-- 6. Funciones Auxiliares y Políticas Row Level Security (RLS) por comercio_id
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
      WHERE (u.auth_user_id = auth.uid() OR u.id = auth.uid())
        AND u.activo = TRUE
        AND u.deleted_at IS NULL
      LIMIT 1
    ),
    NULLIF(auth.jwt()->'app_metadata'->>'comercio_id', '')::uuid
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
      WHERE (u.auth_user_id = auth.uid() OR u.id = auth.uid())
        AND u.activo = TRUE
        AND u.deleted_at IS NULL
      LIMIT 1
    ),
    NULLIF(auth.jwt()->'app_metadata'->>'rol', '')
  );
$$;

CREATE OR REPLACE FUNCTION public.mi_usuario_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id
  FROM public.usuarios u
  WHERE (u.auth_user_id = auth.uid() OR u.id = auth.uid())
    AND u.activo = TRUE
    AND u.deleted_at IS NULL
  LIMIT 1;
$$;

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

DROP POLICY IF EXISTS rls_auditoria_insert ON public.auditoria;
CREATE POLICY rls_auditoria_insert ON public.auditoria
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_auditoria_select_superadmin ON public.auditoria;
CREATE POLICY rls_auditoria_select_superadmin ON public.auditoria
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

DROP POLICY IF EXISTS rls_usuarios_select ON public.usuarios;
CREATE POLICY rls_usuarios_select ON public.usuarios
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_usuarios_write_superadmin ON public.usuarios;
CREATE POLICY rls_usuarios_write_superadmin ON public.usuarios
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin')
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

DROP POLICY IF EXISTS rls_comercios_all ON public.comercios;
DROP POLICY IF EXISTS rls_comercios_select ON public.comercios;
DROP POLICY IF EXISTS rls_comercios_write_superadmin ON public.comercios;
CREATE POLICY rls_comercios_select ON public.comercios
  FOR SELECT TO authenticated
  USING (id = public.mi_comercio_id());
CREATE POLICY rls_comercios_write_superadmin ON public.comercios
  FOR ALL TO authenticated
  USING (id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin')
  WITH CHECK (id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

DROP POLICY IF EXISTS rls_dispositivos_all ON public.dispositivos;
CREATE POLICY rls_dispositivos_all ON public.dispositivos
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_categorias_all ON public.categorias;
CREATE POLICY rls_categorias_select ON public.categorias
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_categorias_write ON public.categorias
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_marcas_all ON public.marcas;
CREATE POLICY rls_marcas_select ON public.marcas
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_marcas_write ON public.marcas
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_proveedores_all ON public.proveedores;
CREATE POLICY rls_proveedores_all ON public.proveedores
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_productos_admin_encargado ON public.productos;
CREATE POLICY rls_productos_admin_encargado ON public.productos
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_codigos_barras_all ON public.codigos_barras;
CREATE POLICY rls_codigos_barras_select ON public.codigos_barras
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_codigos_barras_write ON public.codigos_barras
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_listas_precio_all ON public.listas_precio;
CREATE POLICY rls_listas_precio_select ON public.listas_precio
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_listas_precio_write ON public.listas_precio
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_precios_all ON public.precios;
CREATE POLICY rls_precios_select ON public.precios
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_precios_write ON public.precios
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_movimientos_stock_select ON public.movimientos_stock;
CREATE POLICY rls_movimientos_stock_select ON public.movimientos_stock
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_movimientos_stock_insert ON public.movimientos_stock;
CREATE POLICY rls_movimientos_stock_insert ON public.movimientos_stock
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_clientes_all ON public.clientes;
CREATE POLICY rls_clientes_all ON public.clientes
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_cc_movimientos_all ON public.cuenta_corriente_movimientos;
CREATE POLICY rls_cc_movimientos_select ON public.cuenta_corriente_movimientos
  FOR SELECT TO authenticated
  USING (
    comercio_id = public.mi_comercio_id()
    AND (entidad_tipo = 'cliente' OR public.mi_rol() IN ('superadmin', 'encargado'))
  );
CREATE POLICY rls_cc_movimientos_insert ON public.cuenta_corriente_movimientos
  FOR INSERT TO authenticated
  WITH CHECK (
    comercio_id = public.mi_comercio_id()
    AND (entidad_tipo = 'cliente' OR public.mi_rol() IN ('superadmin', 'encargado'))
  );

DROP POLICY IF EXISTS rls_caja_sesiones_all ON public.caja_sesiones;
CREATE POLICY rls_caja_sesiones_all ON public.caja_sesiones
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_caja_movimientos_all ON public.caja_movimientos;
CREATE POLICY rls_caja_movimientos_all ON public.caja_movimientos
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_all ON public.ventas;
CREATE POLICY rls_ventas_select ON public.ventas
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_ventas_insert ON public.ventas
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_ventas_update ON public.ventas
  FOR UPDATE TO authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_items_select ON public.ventas_items;
CREATE POLICY rls_ventas_items_select ON public.ventas_items
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_items_insert ON public.ventas_items;
CREATE POLICY rls_ventas_items_insert ON public.ventas_items
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_pagos_select ON public.ventas_pagos;
CREATE POLICY rls_ventas_pagos_select ON public.ventas_pagos
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_pagos_insert ON public.ventas_pagos;
CREATE POLICY rls_ventas_pagos_insert ON public.ventas_pagos
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_compras_admin_encargado ON public.compras;
CREATE POLICY rls_compras_admin_encargado ON public.compras
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_compras_items_admin_encargado ON public.compras_items;
CREATE POLICY rls_compras_items_admin_encargado ON public.compras_items
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

-- 7. Bucket Privado en Supabase Storage para Imágenes de Productos (PLAN.md §5.1)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('productos', 'productos', FALSE, 204800, ARRAY['image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS storage_productos_select ON storage.objects;
CREATE POLICY storage_productos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'productos'
    AND auth.uid() IS NOT NULL
    AND name ~ ('^' || public.mi_comercio_id()::text || '/[0-9a-f-]{36}(_thumb)?\.webp$')
  );

DROP POLICY IF EXISTS storage_productos_insert ON storage.objects;
CREATE POLICY storage_productos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'productos'
    AND auth.uid() IS NOT NULL
    AND public.mi_rol() IN ('superadmin', 'encargado')
    AND name ~ ('^' || public.mi_comercio_id()::text || '/[0-9a-f-]{36}(_thumb)?\.webp$')
  );

DROP POLICY IF EXISTS storage_productos_update ON storage.objects;
CREATE POLICY storage_productos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'productos'
    AND auth.uid() IS NOT NULL
    AND public.mi_rol() IN ('superadmin', 'encargado')
    AND name ~ ('^' || public.mi_comercio_id()::text || '/[0-9a-f-]{36}(_thumb)?\.webp$')
  );

-- ============================================================================
-- PARTE 2 (002): CANAL DE VENTA MÓVIL WEB (/web-pos) — SESIONES, VISTA Y RPC
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sesiones_moviles (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  dispositivo_id TEXT NOT NULL,
  dispositivo_nombre TEXT NOT NULL,
  user_agent TEXT,
  iniciada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_actividad_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_at TIMESTAMPTZ NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activa'
    CHECK (estado IN ('activa', 'revocada', 'expirada', 'cerrada')),
  revocada_at TIMESTAMPTZ,
  revocada_por_id UUID REFERENCES public.usuarios(id),
  motivo_revocacion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

CREATE INDEX IF NOT EXISTS idx_sesiones_moviles_comercio_estado
  ON public.sesiones_moviles(comercio_id, estado, ultima_actividad_at DESC);

ALTER TABLE public.sesiones_moviles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_sesiones_moviles_all ON public.sesiones_moviles;
CREATE POLICY rls_sesiones_moviles_select ON public.sesiones_moviles
  FOR SELECT TO authenticated
  USING (
    comercio_id = public.mi_comercio_id()
    AND (usuario_id = public.mi_usuario_id() OR public.mi_rol() = 'superadmin')
  );
CREATE POLICY rls_sesiones_moviles_insert ON public.sesiones_moviles
  FOR INSERT TO authenticated
  WITH CHECK (
    comercio_id = public.mi_comercio_id()
    AND (usuario_id = public.mi_usuario_id() OR public.mi_rol() = 'superadmin')
  );
CREATE POLICY rls_sesiones_moviles_update ON public.sesiones_moviles
  FOR UPDATE TO authenticated
  USING (
    comercio_id = public.mi_comercio_id()
    AND (usuario_id = public.mi_usuario_id() OR public.mi_rol() = 'superadmin')
  )
  WITH CHECK (
    comercio_id = public.mi_comercio_id()
    AND (usuario_id = public.mi_usuario_id() OR public.mi_rol() = 'superadmin')
  );

CREATE OR REPLACE VIEW public.productos_venta
WITH (security_invoker = true) AS
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
  lp.id AS lista_precio_id,
  COALESCE(pr.precio_venta, 0)::BIGINT AS precio_venta,
  COALESCE(
    (
      SELECT jsonb_agg(cb.codigo ORDER BY cb.codigo)
      FROM public.codigos_barras cb
      WHERE cb.producto_id = p.id
        AND cb.comercio_id = p.comercio_id
        AND cb.deleted_at IS NULL
    ),
    '[]'::jsonb
  ) AS codigos_barras,
  COALESCE(
    (
      SELECT SUM(ms.cantidad)::NUMERIC(12,3)
      FROM public.movimientos_stock ms
      WHERE ms.producto_id = p.id
        AND ms.comercio_id = p.comercio_id
    ),
    0
  ) AS stock_actual
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
  AND p.activo = TRUE
  AND p.comercio_id = public.mi_comercio_id();

REVOKE ALL ON public.productos_venta FROM PUBLIC, anon;
GRANT SELECT ON public.productos_venta TO authenticated;

CREATE OR REPLACE VIEW public.ventas_items_venta
WITH (security_invoker = true) AS
SELECT
  id, comercio_id, venta_id, producto_id, descripcion,
  cantidad, precio_unitario, descuento, subtotal,
  alicuota_iva, exento_iva, created_at, updated_at, deleted_at, device_id
FROM public.ventas_items
WHERE comercio_id = public.mi_comercio_id()
  AND deleted_at IS NULL;

REVOKE ALL ON public.ventas_items_venta FROM PUBLIC, anon;
GRANT SELECT ON public.ventas_items_venta TO authenticated;

CREATE OR REPLACE FUNCTION public.obtener_catalogo_venta_movil()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comercio_id UUID := public.mi_comercio_id();
  v_comercio RECORD;
  v_productos JSONB;
BEGIN
  IF v_comercio_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El usuario no tiene un comercio activo asociado.';
  END IF;

  SELECT
    c.id,
    c.razon_social,
    c.nombre_fantasia,
    c.cuit,
    c.condicion_iva,
    c.domicilio_comercial
  INTO v_comercio
  FROM public.comercios c
  WHERE c.id = v_comercio_id
    AND c.deleted_at IS NULL;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pv.id,
        'nombre', pv.nombre,
        'codigo_interno', pv.codigo_interno,
        'codigos_barras', pv.codigos_barras,
        'unidad', pv.unidad,
        'permite_decimales', pv.permite_decimales,
        'precio_venta', pv.precio_venta,
        'alicuota_iva', pv.alicuota_iva,
        'exento_iva', pv.exento_iva,
        'boton_rapido', pv.boton_rapido,
        'imagen_path', pv.imagen_path,
        'stock_actual', pv.stock_actual
      )
      ORDER BY pv.nombre
    ),
    '[]'::jsonb
  )
  INTO v_productos
  FROM public.productos_venta pv;

  RETURN jsonb_build_object(
    'comercio', to_jsonb(v_comercio),
    'productos', v_productos
  );
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_catalogo_venta_movil() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_catalogo_venta_movil() TO authenticated;

CREATE OR REPLACE FUNCTION public.crear_venta_movil(
  p_venta_id UUID,
  p_comercio_id UUID,
  p_usuario_id UUID,
  p_dispositivo_id TEXT,
  p_items JSONB,
  p_pagos JSONB,
  p_descuento_global BIGINT DEFAULT 0,
  p_cliente_id UUID DEFAULT NULL,
  p_caja_sesion_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth_uid UUID := auth.uid();
  v_comercio_auth UUID := public.mi_comercio_id();
  v_usuario_auth UUID := public.mi_usuario_id();
  v_venta_existente RECORD;
  v_comercio RECORD;
  v_usuario RECORD;
  v_cliente RECORD;
  v_caja RECORD;
  v_sesion_movil_activa RECORD;
  v_item JSONB;
  v_pago JSONB;
  v_prod RECORD;
  v_cantidad NUMERIC;
  v_bruto BIGINT;
  v_descuento_item BIGINT;
  v_subtotal_item BIGINT;
  v_subtotal_acumulado BIGINT := 0;
  v_total_venta BIGINT := 0;
  v_suma_pagos BIGINT := 0;
  v_monto_pago BIGINT;
  v_ahora TIMESTAMPTZ := NOW();
  v_hash_prev TEXT;
  v_hash_nuevo TEXT;
  v_items_respuesta JSONB := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL OR v_comercio_auth IS NULL OR v_usuario_auth IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Se requiere sesión autenticada en Supabase Auth.';
  END IF;

  IF p_comercio_id IS DISTINCT FROM v_comercio_auth OR p_usuario_id IS DISTINCT FROM v_usuario_auth THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO: El comercio o usuario indicado no coincide con la sesión autenticada.';
  END IF;

  -- 1. Idempotencia por UUID de venta generado en el celular
  SELECT id, fecha, subtotal, descuento, total, estado
    INTO v_venta_existente
    FROM public.ventas
   WHERE id = p_venta_id
     AND comercio_id = p_comercio_id
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'idempotente', TRUE,
      'venta_id', v_venta_existente.id,
      'fecha', v_venta_existente.fecha,
      'subtotal', v_venta_existente.subtotal,
      'descuento', v_venta_existente.descuento,
      'total', v_venta_existente.total,
      'canal', 'web'
    );
  END IF;

  -- 2. Validar comercio y permiso de venta móvil
  SELECT id, nombre, venta_movil_habilitada, precios_incluyen_iva
    INTO v_comercio
    FROM public.comercios
   WHERE id = p_comercio_id
     AND deleted_at IS NULL
   LIMIT 1;

  IF NOT FOUND OR NOT v_comercio.venta_movil_habilitada THEN
    RAISE EXCEPTION 'VENTA_MOVIL_DESHABILITADA: La venta móvil no está habilitada en este comercio.';
  END IF;

  -- 3. Validar usuario activo con permiso puede_vender_movil
  SELECT id, nombre, rol, activo, puede_vender_movil
    INTO v_usuario
    FROM public.usuarios
   WHERE id = p_usuario_id
     AND comercio_id = p_comercio_id
     AND deleted_at IS NULL
   LIMIT 1;

  IF NOT FOUND OR NOT v_usuario.activo OR NOT v_usuario.puede_vender_movil THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO: El usuario no tiene permiso para operar en Venta Móvil.';
  END IF;

  -- 4. Recorrer ítems y recalcular importes desde precios del servidor
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'VENTA_VACIA: La venta móvil debe contener al menos un producto.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT
      p.id,
      p.nombre,
      p.costo_compra,
      p.alicuota_iva,
      p.exento_iva,
      p.permite_decimales,
      COALESCE(pr.precio_venta, 0) AS precio_venta
    INTO v_prod
    FROM public.productos p
    LEFT JOIN public.listas_precio lp
      ON lp.comercio_id = p.comercio_id
     AND lp.es_predeterminada = TRUE
     AND lp.deleted_at IS NULL
    LEFT JOIN public.precios pr
      ON pr.producto_id = p.id
     AND pr.lista_precio_id = lp.id
     AND pr.deleted_at IS NULL
    WHERE p.id = (v_item->>'producto_id')::uuid
      AND p.comercio_id = p_comercio_id
      AND p.deleted_at IS NULL
      AND p.activo = TRUE
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCTO_NO_ENCONTRADO: Producto no disponible para la venta.';
    END IF;

    v_cantidad := (v_item->>'cantidad')::numeric;
    IF v_cantidad <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA: La cantidad debe ser mayor a cero.';
    END IF;

    v_descuento_item := COALESCE((v_item->>'descuento')::bigint, 0);
    v_bruto := ROUND(v_cantidad * v_prod.precio_venta)::bigint;
    v_subtotal_item := v_bruto - v_descuento_item;
    v_subtotal_acumulado := v_subtotal_acumulado + v_subtotal_item;
  END LOOP;

  IF p_descuento_global < 0 OR p_descuento_global > v_subtotal_acumulado THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: El descuento global es inválido.';
  END IF;

  v_total_venta := v_subtotal_acumulado - p_descuento_global;

  -- 5. Validar pagos mixtos contra total recalculado en el servidor
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos)
  LOOP
    v_suma_pagos := v_suma_pagos + (v_pago->>'monto')::bigint;
  END LOOP;

  IF v_suma_pagos <> v_total_venta THEN
    RAISE EXCEPTION 'PAGOS_NO_COINCIDEN: La suma de pagos (%) no coincide con el total calculado en el servidor (%).', v_suma_pagos, v_total_venta;
  END IF;

  -- 6. Insertar cabecera de venta (canal = 'web')
  INSERT INTO public.ventas (
    id, comercio_id, fecha, usuario_id, cliente_id,
    subtotal, descuento, total, estado, caja_sesion_id,
    tipo_comprobante, canal, dispositivo_id, estado_facturacion,
    created_at, updated_at, device_id
  ) VALUES (
    p_venta_id, p_comercio_id, v_ahora, p_usuario_id, p_cliente_id,
    v_subtotal_acumulado, p_descuento_global, v_total_venta, 'completada', p_caja_sesion_id,
    'ticket_no_fiscal', 'web', p_dispositivo_id, 'no_aplica',
    v_ahora, v_ahora, p_dispositivo_id
  );

  -- 7. Insertar ítems y movimientos de stock (append-only)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT
      p.id,
      p.nombre,
      p.costo_compra,
      p.alicuota_iva,
      p.exento_iva,
      COALESCE(pr.precio_venta, 0) AS precio_venta
    INTO v_prod
    FROM public.productos p
    LEFT JOIN public.listas_precio lp
      ON lp.comercio_id = p.comercio_id
     AND lp.es_predeterminada = TRUE
     AND lp.deleted_at IS NULL
    LEFT JOIN public.precios pr
      ON pr.producto_id = p.id
     AND pr.lista_precio_id = lp.id
     AND pr.deleted_at IS NULL
    WHERE p.id = (v_item->>'producto_id')::uuid
      AND p.comercio_id = p_comercio_id
    LIMIT 1;

    v_cantidad := (v_item->>'cantidad')::numeric;
    v_descuento_item := COALESCE((v_item->>'descuento')::bigint, 0);
    v_bruto := ROUND(v_cantidad * v_prod.precio_venta)::bigint;
    v_subtotal_item := v_bruto - v_descuento_item;

    INSERT INTO public.ventas_items (
      id, comercio_id, venta_id, producto_id, descripcion,
      cantidad, precio_unitario, costo_unitario, descuento, subtotal,
      alicuota_iva, exento_iva, created_at, updated_at, device_id
    ) VALUES (
      gen_random_uuid(), p_comercio_id, p_venta_id, v_prod.id, v_prod.nombre,
      v_cantidad, v_prod.precio_venta, v_prod.costo_compra, v_descuento_item, v_subtotal_item,
      v_prod.alicuota_iva, v_prod.exento_iva, v_ahora, v_ahora, p_dispositivo_id
    );

    INSERT INTO public.movimientos_stock (
      id, comercio_id, producto_id, tipo, cantidad,
      costo_unitario, referencia_id, motivo, usuario_id,
      created_at, updated_at, device_id, sync_status
    ) VALUES (
      gen_random_uuid(), p_comercio_id, v_prod.id, 'venta', -ABS(v_cantidad),
      v_prod.costo_compra, p_venta_id::text, 'Venta móvil web', p_usuario_id,
      v_ahora, v_ahora, p_dispositivo_id, 'sincronizado'
    );

    -- Respuesta proyectada sin costo_unitario (Regla 20)
    v_items_respuesta := v_items_respuesta || jsonb_build_array(
      jsonb_build_object(
        'producto_id', v_prod.id,
        'descripcion', v_prod.nombre,
        'cantidad', v_cantidad,
        'precio_unitario', v_prod.precio_venta,
        'descuento', v_descuento_item,
        'subtotal', v_subtotal_item
      )
    );
  END LOOP;

  -- 8. Insertar pagos
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos)
  LOOP
    INSERT INTO public.ventas_pagos (
      id, comercio_id, venta_id, medio, monto,
      created_at, updated_at, device_id
    ) VALUES (
      gen_random_uuid(), p_comercio_id, p_venta_id,
      v_pago->>'medio', (v_pago->>'monto')::bigint,
      v_ahora, v_ahora, p_dispositivo_id
    );
  END LOOP;

  -- 9. Registrar en auditoría encadenada (Regla 13 y 14)
  SELECT COALESCE(a.hash, 'GENESIS')
    INTO v_hash_prev
    FROM public.auditoria a
   WHERE a.comercio_id = p_comercio_id
   ORDER BY a.fecha_hora DESC, a.created_at DESC
   LIMIT 1;

  IF v_hash_prev IS NULL THEN
    v_hash_prev := 'GENESIS';
  END IF;

  v_hash_nuevo := encode(
    digest(v_hash_prev || '|' || p_venta_id::text || '|' || v_total_venta::text, 'sha256'),
    'hex'
  );

  INSERT INTO public.auditoria (
    id, comercio_id, fecha_hora, usuario_id, usuario_nombre, rol,
    device_id, accion, entidad, entidad_id,
    valores_antes, valores_despues, motivo,
    hash_prev, hash, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), p_comercio_id, v_ahora, p_usuario_id, v_usuario.nombre, v_usuario.rol,
    p_dispositivo_id, 'crear_venta_movil', 'ventas', p_venta_id::text,
    NULL,
    jsonb_build_object('total', v_total_venta, 'canal', 'web')::text,
    'Venta emitida desde aplicación móvil /web-pos',
    v_hash_prev, v_hash_nuevo, v_ahora, v_ahora
  );

  RETURN jsonb_build_object(
    'idempotente', FALSE,
    'venta_id', p_venta_id,
    'fecha', v_ahora,
    'subtotal', v_subtotal_acumulado,
    'descuento', p_descuento_global,
    'total', v_total_venta,
    'canal', 'web',
    'cajero_nombre', v_usuario.nombre,
    'items', v_items_respuesta
  );
END;
$$;

REVOKE ALL ON FUNCTION public.crear_venta_movil(UUID, UUID, UUID, TEXT, JSONB, JSONB, BIGINT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_venta_movil(UUID, UUID, UUID, TEXT, JSONB, JSONB, BIGINT, UUID, UUID) TO authenticated;

-- ============================================================================
-- PARTE 3 (003): FASE 4 — FACTURACIÓN ARCA (WSAA/WSFEv1), VARIANTES, COMBOS Y EXTRAS
-- ============================================================================

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS lista_precio_id UUID REFERENCES public.listas_precio(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS factura_arca_error TEXT,
  ADD COLUMN IF NOT EXISTS arca_ultimo_error TEXT,
  ADD COLUMN IF NOT EXISTS arca_intentos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arca_proximo_reintento_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nota_credito_tipo TEXT
    CHECK (
      nota_credito_tipo IS NULL
      OR nota_credito_tipo IN ('nota_credito_a', 'nota_credito_b', 'nota_credito_c')
    ),
  ADD COLUMN IF NOT EXISTS nota_credito_numero INTEGER,
  ADD COLUMN IF NOT EXISTS nota_credito_cae TEXT,
  ADD COLUMN IF NOT EXISTS nota_credito_cae_vencimiento TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.variantes (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  nombre TEXT NOT NULL,
  atributo_1 TEXT,
  atributo_2 TEXT,
  sku_variante TEXT,
  codigo_barras TEXT,
  precio_adicional BIGINT NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.variantes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_variantes_all ON public.variantes;
CREATE POLICY rls_variantes_select ON public.variantes
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_variantes_write ON public.variantes
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

CREATE TABLE IF NOT EXISTS public.arca_tokens_wsaa (
  comercio_id UUID NOT NULL REFERENCES public.comercios(id) ON DELETE CASCADE,
  ambiente TEXT NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  servicio TEXT NOT NULL DEFAULT 'wsfe',
  token TEXT NOT NULL,
  sign TEXT NOT NULL,
  generado_at TIMESTAMPTZ NOT NULL,
  expira_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (comercio_id, ambiente, servicio)
);

ALTER TABLE public.arca_tokens_wsaa ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.combos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  codigo_barras TEXT,
  precio_venta BIGINT NOT NULL CHECK (precio_venta >= 0),
  alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 21,
  exento_iva BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.combos
  ADD COLUMN IF NOT EXISTS descripcion TEXT,
  ADD COLUMN IF NOT EXISTS alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS exento_iva BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.combos_items (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id) ON DELETE CASCADE,
  combo_id UUID NOT NULL REFERENCES public.combos(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES public.productos(id) ON DELETE RESTRICT,
  cantidad NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.combos_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS combos_aislamiento_comercio ON public.combos;
CREATE POLICY rls_combos_select ON public.combos
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_combos_write ON public.combos
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS combos_items_aislamiento_comercio ON public.combos_items;
CREATE POLICY rls_combos_items_select ON public.combos_items
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_combos_items_write ON public.combos_items
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

-- ============================================================================
-- PARTE 4 (004): MULTI-SUCURSAL Y TRANSFERENCIAS DE STOCK ENTRE SUCURSALES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sucursales (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  codigo TEXT NOT NULL,
  direccion TEXT,
  telefono TEXT,
  es_principal BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado',
  UNIQUE (comercio_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_pg_sucursales_comercio
  ON public.sucursales(comercio_id) WHERE deleted_at IS NULL;

ALTER TABLE public.dispositivos
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

ALTER TABLE public.movimientos_stock
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

CREATE INDEX IF NOT EXISTS idx_pg_movimientos_stock_sucursal_prod
  ON public.movimientos_stock(comercio_id, sucursal_id, producto_id);

ALTER TABLE public.caja_sesiones
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

CREATE TABLE IF NOT EXISTS public.transferencias_sucursales (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id) ON DELETE CASCADE,
  sucursal_origen_id UUID NOT NULL REFERENCES public.sucursales(id),
  sucursal_destino_id UUID NOT NULL REFERENCES public.sucursales(id),
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  motivo TEXT NOT NULL,
  cantidad_items INTEGER NOT NULL DEFAULT 1,
  total_unidades NUMERIC(12,3) NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'completada'
    CHECK (estado IN ('completada', 'anulada')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado',
  CHECK (sucursal_origen_id <> sucursal_destino_id)
);

ALTER TABLE public.transferencias_sucursales
  ADD COLUMN IF NOT EXISTS cantidad_items INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS total_unidades NUMERIC(12,3) NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.transferencias_sucursales_items (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id) ON DELETE CASCADE,
  transferencia_id UUID NOT NULL REFERENCES public.transferencias_sucursales(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  cantidad NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'sincronizado'
);

ALTER TABLE public.sucursales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transferencias_sucursales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transferencias_sucursales_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_sucursales_all ON public.sucursales;
CREATE POLICY rls_sucursales_select ON public.sucursales
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_sucursales_write ON public.sucursales
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_transferencias_sucursales_all ON public.transferencias_sucursales;
CREATE POLICY rls_transferencias_sucursales_select ON public.transferencias_sucursales
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_transferencias_sucursales_insert ON public.transferencias_sucursales
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_transferencias_sucursales_items_all ON public.transferencias_sucursales_items;
CREATE POLICY rls_transferencias_sucursales_items_select ON public.transferencias_sucursales_items
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_transferencias_sucursales_items_insert ON public.transferencias_sucursales_items
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP TRIGGER IF EXISTS trg_pg_transferencias_inmutable ON public.transferencias_sucursales;
CREATE TRIGGER trg_pg_transferencias_inmutable
BEFORE UPDATE OR DELETE ON public.transferencias_sucursales
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

CREATE OR REPLACE FUNCTION public.resetear_comercio_a_fabrica(
  p_comercio_id UUID,
  p_superadmin_id UUID,
  p_lista_precio_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR public.mi_rol() IS DISTINCT FROM 'superadmin'
     OR p_comercio_id IS DISTINCT FROM public.mi_comercio_id() THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO: Solo un superadmin autenticado del comercio puede reiniciar el comercio a estado de fábrica.';
  END IF;

  PERFORM set_config('app.reset_fabrica_autorizado', 'true', true);

  DELETE FROM public.ventas_pagos WHERE comercio_id = p_comercio_id;
  DELETE FROM public.ventas_items WHERE comercio_id = p_comercio_id;
  DELETE FROM public.ventas WHERE comercio_id = p_comercio_id;
  DELETE FROM public.caja_movimientos WHERE comercio_id = p_comercio_id;
  DELETE FROM public.caja_sesiones WHERE comercio_id = p_comercio_id;
  DELETE FROM public.cuenta_corriente_movimientos WHERE comercio_id = p_comercio_id;
  DELETE FROM public.clientes WHERE comercio_id = p_comercio_id;
  DELETE FROM public.compras_items WHERE comercio_id = p_comercio_id;
  DELETE FROM public.compras WHERE comercio_id = p_comercio_id;
  DELETE FROM public.movimientos_stock WHERE comercio_id = p_comercio_id;
  DELETE FROM public.combos_items WHERE comercio_id = p_comercio_id;
  DELETE FROM public.combos WHERE comercio_id = p_comercio_id;
  DELETE FROM public.variantes WHERE comercio_id = p_comercio_id;
  DELETE FROM public.precios WHERE comercio_id = p_comercio_id;
  DELETE FROM public.codigos_barras WHERE comercio_id = p_comercio_id;
  DELETE FROM public.productos WHERE comercio_id = p_comercio_id;
  DELETE FROM public.proveedores WHERE comercio_id = p_comercio_id;
  DELETE FROM public.marcas WHERE comercio_id = p_comercio_id;
  DELETE FROM public.categorias WHERE comercio_id = p_comercio_id;
  DELETE FROM public.sesiones_moviles WHERE comercio_id = p_comercio_id;
  DELETE FROM public.dispositivos WHERE comercio_id = p_comercio_id;
  DELETE FROM public.auditoria WHERE comercio_id = p_comercio_id;
  DELETE FROM public.usuarios WHERE comercio_id = p_comercio_id AND id != p_superadmin_id;
  DELETE FROM public.listas_precio WHERE comercio_id = p_comercio_id AND id != p_lista_precio_id;

  RETURN jsonb_build_object('ok', TRUE, 'comercio_id', p_comercio_id);
END;
$$;

REVOKE ALL ON FUNCTION public.resetear_comercio_a_fabrica(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resetear_comercio_a_fabrica(UUID, UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
