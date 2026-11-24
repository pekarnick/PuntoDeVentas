-- ============================================================================
-- Migración Supabase 004: Administración de Sucursales, Stock por Sucursal
-- y Transferencias de Mercadería entre Sucursales (PLAN.md §3 Regla 4, §4 y §5)
-- ============================================================================

-- 1. Tabla de Sucursales con RLS por comercio_id
CREATE TABLE IF NOT EXISTS public.sucursales (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  nombre TEXT NOT NULL,
  codigo TEXT,
  direccion TEXT,
  telefono TEXT,
  es_principal BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sucursales_comercio
  ON public.sucursales(comercio_id, es_principal DESC, nombre ASC)
  WHERE deleted_at IS NULL;

ALTER TABLE public.sucursales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_sucursales_all ON public.sucursales;
CREATE POLICY rls_sucursales_all ON public.sucursales
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

-- 2. Tabla append-only de Transferencias entre Sucursales con RLS
CREATE TABLE IF NOT EXISTS public.transferencias_sucursales (
  id UUID PRIMARY KEY,
  comercio_id UUID NOT NULL REFERENCES public.comercios(id),
  sucursal_origen_id UUID NOT NULL REFERENCES public.sucursales(id),
  sucursal_destino_id UUID NOT NULL REFERENCES public.sucursales(id),
  usuario_id UUID NOT NULL REFERENCES public.usuarios(id),
  motivo TEXT NOT NULL,
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cantidad_items INTEGER NOT NULL DEFAULT 1 CHECK (cantidad_items >= 1),
  total_unidades NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (total_unidades > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  device_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transferencias_sucursales_fecha
  ON public.transferencias_sucursales(comercio_id, fecha DESC);

ALTER TABLE public.transferencias_sucursales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_transferencias_sucursales_select ON public.transferencias_sucursales;
CREATE POLICY rls_transferencias_sucursales_select ON public.transferencias_sucursales
  FOR SELECT TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_transferencias_sucursales_insert ON public.transferencias_sucursales;
CREATE POLICY rls_transferencias_sucursales_insert ON public.transferencias_sucursales
  FOR INSERT TO anon, authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());

-- 3. Columnas sucursal_id en movimientos_stock, ventas, compras y caja_sesiones
ALTER TABLE public.movimientos_stock
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

ALTER TABLE public.caja_sesiones
  ADD COLUMN IF NOT EXISTS sucursal_id UUID REFERENCES public.sucursales(id);

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_sucursal
  ON public.movimientos_stock(comercio_id, sucursal_id, producto_id);

CREATE INDEX IF NOT EXISTS idx_ventas_sucursal_fecha
  ON public.ventas(comercio_id, sucursal_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_compras_sucursal_fecha
  ON public.compras(comercio_id, sucursal_id, fecha DESC);
