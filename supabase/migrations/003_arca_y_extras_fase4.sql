-- ============================================================================
-- Migración Supabase 003: Facturación Electrónica ARCA (ex-AFIP, Opcional)
-- y Extras de Fase 4 (Variantes, Combos y Listas de Precio en Ventas)
-- (PLAN.md §3 Reglas 18, 19, 20; §4; §6.3 y §10 — Fase 4)
-- ============================================================================

-- 1. Columnas públicas de configuración ARCA y Venta Móvil en comercios (sin secretos ni certificados)
ALTER TABLE public.comercios
  ADD COLUMN IF NOT EXISTS venta_movil_url TEXT,
  ADD COLUMN IF NOT EXISTS arca_ambiente TEXT NOT NULL DEFAULT 'homologacion'
    CHECK (arca_ambiente IN ('homologacion', 'produccion')),
  ADD COLUMN IF NOT EXISTS arca_punto_venta INTEGER NOT NULL DEFAULT 1
    CHECK (arca_punto_venta >= 1 AND arca_punto_venta <= 99999),
  ADD COLUMN IF NOT EXISTS arca_proveedor TEXT NOT NULL DEFAULT 'afip_sdk'
    CHECK (arca_proveedor IN ('afip_sdk', 'tus_facturas', 'simulador_homologacion')),
  ADD COLUMN IF NOT EXISTS arca_tope_consumidor_final BIGINT NOT NULL DEFAULT 34448800
    CHECK (arca_tope_consumidor_final >= 0);

ALTER TABLE public.listas_precio
  ADD COLUMN IF NOT EXISTS descuento_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 0;

-- 2. Columnas en ventas para lista de precios, reintentos ARCA y Nota de Crédito
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS lista_precio_id UUID REFERENCES public.listas_precio(id),
  ADD COLUMN IF NOT EXISTS arca_ultimo_error TEXT,
  ADD COLUMN IF NOT EXISTS arca_intentos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nota_credito_tipo TEXT
    CHECK (
      nota_credito_tipo IS NULL
      OR nota_credito_tipo IN ('nota_credito_a', 'nota_credito_b', 'nota_credito_c')
    ),
  ADD COLUMN IF NOT EXISTS nota_credito_numero INTEGER,
  ADD COLUMN IF NOT EXISTS nota_credito_cae TEXT,
  ADD COLUMN IF NOT EXISTS nota_credito_cae_vencimiento TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ventas_estado_facturacion
  ON public.ventas(comercio_id, estado_facturacion, fecha DESC);

-- 3. Tabla de Variantes con RLS por comercio_id
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
  device_id TEXT NOT NULL
);

ALTER TABLE public.variantes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_variantes_all ON public.variantes;
CREATE POLICY rls_variantes_all ON public.variantes
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

-- 4. Tablas de Combos y Combos Items con RLS por comercio_id
CREATE TABLE IF NOT EXISTS public.combos (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  descripcion TEXT,
  codigo_barras TEXT,
  precio_venta BIGINT NOT NULL CHECK (precio_venta > 0),
  alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 21,
  exento_iva BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL
);

ALTER TABLE public.combos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_combos_all ON public.combos;
CREATE POLICY rls_combos_all ON public.combos
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

CREATE TABLE IF NOT EXISTS public.combos_items (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  combo_id UUID NOT NULL REFERENCES public.combos(id),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  cantidad NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL
);

ALTER TABLE public.combos_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_combos_items_all ON public.combos_items;
CREATE POLICY rls_combos_items_all ON public.combos_items
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

ALTER TABLE public.ventas_items
  ADD COLUMN IF NOT EXISTS variante_id UUID REFERENCES public.variantes(id),
  ADD COLUMN IF NOT EXISTS combo_id UUID REFERENCES public.combos(id);

-- 5. Función mi_comercio_id() con autodescubrimiento seguro cuando una terminal se reinstala de cero
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
    (
      SELECT c.id
      FROM public.comercios c
      WHERE c.id = NULLIF(current_setting('request.headers', true)::json->>'x-comercio-id', '')::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    ),
    (
      SELECT c.id
      FROM public.comercios c
      WHERE c.deleted_at IS NULL
      ORDER BY c.created_at ASC
      LIMIT 1
    ),
    NULLIF(current_setting('request.headers', true)::json->>'x-comercio-id', '')::uuid
  );
$$;

-- 6. RPC de mantenimiento para vaciar el comercio en Supabase al reiniciar la base local a fábrica (solo superadmin)
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
  IF public.mi_rol() != 'superadmin' THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO: Solo superadmin puede reiniciar el comercio a estado de fábrica.';
  END IF;

  ALTER TABLE public.auditoria DISABLE TRIGGER USER;
  ALTER TABLE public.movimientos_stock DISABLE TRIGGER USER;
  ALTER TABLE public.ventas_items DISABLE TRIGGER USER;
  ALTER TABLE public.ventas_pagos DISABLE TRIGGER USER;

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

  ALTER TABLE public.auditoria ENABLE TRIGGER USER;
  ALTER TABLE public.movimientos_stock ENABLE TRIGGER USER;
  ALTER TABLE public.ventas_items ENABLE TRIGGER USER;
  ALTER TABLE public.ventas_pagos ENABLE TRIGGER USER;

  RETURN jsonb_build_object('ok', TRUE, 'comercio_id', p_comercio_id);
END;
$$;

NOTIFY pgrst, 'reload schema';
