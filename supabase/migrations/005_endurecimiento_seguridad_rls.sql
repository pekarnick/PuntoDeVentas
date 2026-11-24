-- ============================================================================
-- Migración Supabase 005: Endurecimiento de Seguridad RLS, Auth, RPCs y Storage
-- (PLAN.md §3 Reglas 3, 4, 8, 13, 14, 15, 16, 17, 19, 20; Auditoría P0)
-- ============================================================================

-- 1. Reescritura estricta de public.mi_comercio_id() y public.mi_rol()
--    SOLO desde auth.uid() y/o claims JWT firmados (app_metadata).
--    Se elimina por completo cualquier fallback a cabeceras HTTP falsificables
--    o al primer comercio activo global.
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

-- 2. Triggers de inmutabilidad en Postgres (sin DISABLE TRIGGER USER global)
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

DROP TRIGGER IF EXISTS trg_pg_transferencias_inmutable ON public.transferencias_sucursales;
CREATE TRIGGER trg_pg_transferencias_inmutable
BEFORE UPDATE OR DELETE ON public.transferencias_sucursales
FOR EACH ROW EXECUTE FUNCTION public.fn_prohibir_mutacion_append_only();

-- 3. Protección de columnas sensibles (Reglas 16 y 20)
REVOKE UPDATE, DELETE ON public.auditoria FROM PUBLIC, anon, authenticated;
REVOKE SELECT (clave_hash, pin_hash) ON public.usuarios FROM PUBLIC, anon, authenticated;
REVOKE SELECT (costo_unitario) ON public.ventas_items FROM PUBLIC, anon;
REVOKE SELECT (costo_unitario) ON public.movimientos_stock FROM PUBLIC, anon;

-- Vista segura de ítems de venta sin costo_unitario (Regla 20)
CREATE OR REPLACE VIEW public.ventas_items_venta
WITH (security_invoker = true) AS
SELECT
  id,
  comercio_id,
  venta_id,
  producto_id,
  descripcion,
  cantidad,
  precio_unitario,
  descuento,
  subtotal,
  alicuota_iva,
  exento_iva,
  variante_id,
  combo_id,
  created_at,
  updated_at,
  deleted_at,
  device_id
FROM public.ventas_items
WHERE comercio_id = public.mi_comercio_id()
  AND deleted_at IS NULL;

REVOKE ALL ON public.ventas_items_venta FROM PUBLIC, anon;
GRANT SELECT ON public.ventas_items_venta TO authenticated;

-- Vista segura productos_venta con security_invoker = true y sin costo_compra (Regla 20)
DROP VIEW IF EXISTS public.productos_venta;
CREATE VIEW public.productos_venta
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
      SELECT ROUND(COALESCE(SUM(ms.cantidad), 0)::numeric, 3)
      FROM public.movimientos_stock ms
      WHERE ms.producto_id = p.id
        AND ms.comercio_id = p.comercio_id
        AND ms.deleted_at IS NULL
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

-- Columna de backoff para reintentos ARCA
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS arca_proximo_reintento_at TIMESTAMPTZ;

-- 4. Reemplazar TODAS las políticas RLS eliminando TO anon y aplicando RBAC estricto

-- comercios
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

-- usuarios
DROP POLICY IF EXISTS rls_usuarios_select ON public.usuarios;
DROP POLICY IF EXISTS rls_usuarios_write_superadmin ON public.usuarios;
CREATE POLICY rls_usuarios_select ON public.usuarios
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_usuarios_write_superadmin ON public.usuarios
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin')
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

-- auditoria
DROP POLICY IF EXISTS rls_auditoria_insert ON public.auditoria;
DROP POLICY IF EXISTS rls_auditoria_select_superadmin ON public.auditoria;
CREATE POLICY rls_auditoria_insert ON public.auditoria
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_auditoria_select_superadmin ON public.auditoria
  FOR SELECT TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() = 'superadmin');

-- dispositivos
DROP POLICY IF EXISTS rls_dispositivos_all ON public.dispositivos;
CREATE POLICY rls_dispositivos_all ON public.dispositivos
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

-- categorias, marcas, codigos_barras, listas_precio, precios, variantes, combos, combos_items, sucursales
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

DROP POLICY IF EXISTS rls_variantes_all ON public.variantes;
CREATE POLICY rls_variantes_select ON public.variantes
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_variantes_write ON public.variantes
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_combos_all ON public.combos;
DROP POLICY IF EXISTS combos_aislamiento_comercio ON public.combos;
CREATE POLICY rls_combos_select ON public.combos
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_combos_write ON public.combos
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_combos_items_all ON public.combos_items;
DROP POLICY IF EXISTS combos_items_aislamiento_comercio ON public.combos_items;
CREATE POLICY rls_combos_items_select ON public.combos_items
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_combos_items_write ON public.combos_items
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

DROP POLICY IF EXISTS rls_sucursales_all ON public.sucursales;
CREATE POLICY rls_sucursales_select ON public.sucursales
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_sucursales_write ON public.sucursales
  FOR ALL TO authenticated
  USING (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'))
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

-- movimientos_stock, transferencias_sucursales
DROP POLICY IF EXISTS rls_movimientos_stock_select ON public.movimientos_stock;
DROP POLICY IF EXISTS rls_movimientos_stock_insert ON public.movimientos_stock;
CREATE POLICY rls_movimientos_stock_select ON public.movimientos_stock
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_movimientos_stock_insert ON public.movimientos_stock
  FOR INSERT TO authenticated WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_transferencias_sucursales_select ON public.transferencias_sucursales;
DROP POLICY IF EXISTS rls_transferencias_sucursales_insert ON public.transferencias_sucursales;
DROP POLICY IF EXISTS rls_transferencias_sucursales_all ON public.transferencias_sucursales;
CREATE POLICY rls_transferencias_sucursales_select ON public.transferencias_sucursales
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_transferencias_sucursales_insert ON public.transferencias_sucursales
  FOR INSERT TO authenticated
  WITH CHECK (comercio_id = public.mi_comercio_id() AND public.mi_rol() IN ('superadmin', 'encargado'));

-- clientes y cuenta corriente
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

-- caja
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

-- ventas, ventas_items, ventas_pagos
DROP POLICY IF EXISTS rls_ventas_all ON public.ventas;
CREATE POLICY rls_ventas_select ON public.ventas
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_ventas_insert ON public.ventas
  FOR INSERT TO authenticated WITH CHECK (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_ventas_update ON public.ventas
  FOR UPDATE TO authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_items_select ON public.ventas_items;
DROP POLICY IF EXISTS rls_ventas_items_insert ON public.ventas_items;
CREATE POLICY rls_ventas_items_select ON public.ventas_items
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_ventas_items_insert ON public.ventas_items
  FOR INSERT TO authenticated WITH CHECK (comercio_id = public.mi_comercio_id());

DROP POLICY IF EXISTS rls_ventas_pagos_select ON public.ventas_pagos;
DROP POLICY IF EXISTS rls_ventas_pagos_insert ON public.ventas_pagos;
CREATE POLICY rls_ventas_pagos_select ON public.ventas_pagos
  FOR SELECT TO authenticated USING (comercio_id = public.mi_comercio_id());
CREATE POLICY rls_ventas_pagos_insert ON public.ventas_pagos
  FOR INSERT TO authenticated WITH CHECK (comercio_id = public.mi_comercio_id());

-- compras y compras_items
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

-- sesiones_moviles
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

-- 5. Endurecer Storage (bucket privado productos, solo authenticated)
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

-- 6. Endurecer RPC resetear_comercio_a_fabrica (3VL IS DISTINCT FROM + sin DISABLE TRIGGER USER global)
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

-- 7. Endurecer obtener_catalogo_venta_movil y crear_venta_movil (solo authenticated + validaciones)
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
  v_monto_cc BIGINT := 0;
  v_saldo_actual_cc BIGINT := 0;
  v_ahora TIMESTAMPTZ := NOW();
  v_hash_prev TEXT;
  v_hash_nuevo TEXT;
  v_items_respuesta JSONB := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL OR v_comercio_auth IS NULL OR v_usuario_auth IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Se requiere sesión autenticada en Supabase Auth.';
  END IF;

  IF p_comercio_id IS DISTINCT FROM v_comercio_auth THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO: El comercio indicado no coincide con la sesión autenticada.';
  END IF;

  IF p_usuario_id IS DISTINCT FROM v_usuario_auth THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO: El usuario indicado no coincide con el usuario autenticado.';
  END IF;

  -- Idempotencia por UUID de venta generado en el celular
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

  -- Validar comercio y habilitación de venta móvil
  SELECT id, nombre, venta_movil_habilitada, precios_incluyen_iva
    INTO v_comercio
    FROM public.comercios
   WHERE id = p_comercio_id
     AND deleted_at IS NULL
   LIMIT 1;

  IF NOT FOUND OR NOT v_comercio.venta_movil_habilitada THEN
    RAISE EXCEPTION 'VENTA_MOVIL_DESHABILITADA: La venta móvil no está habilitada en este comercio.';
  END IF;

  -- Validar usuario activo con permiso puede_vender_movil
  SELECT id, nombre, rol, activo, puede_vender_movil
    INTO v_usuario
    FROM public.usuarios
   WHERE id = v_usuario_auth
     AND comercio_id = p_comercio_id
     AND deleted_at IS NULL
   LIMIT 1;

  IF NOT FOUND OR NOT v_usuario.activo OR NOT v_usuario.puede_vender_movil THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO: El usuario no tiene permiso para operar en Venta Móvil.';
  END IF;

  -- Exigir sesión móvil activa y vigente (revocación inmediata)
  SELECT id
    INTO v_sesion_movil_activa
    FROM public.sesiones_moviles
   WHERE comercio_id = p_comercio_id
     AND usuario_id = v_usuario_auth
     AND estado = 'activa'
     AND expira_at > v_ahora
     AND deleted_at IS NULL
   ORDER BY ultima_actividad_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESION_REVOCADA: No hay una sesión móvil activa y vigente para este usuario.';
  END IF;

  -- Validar caja abierta si se indica p_caja_sesion_id
  IF p_caja_sesion_id IS NOT NULL THEN
    SELECT id, estado
      INTO v_caja
      FROM public.caja_sesiones
     WHERE id = p_caja_sesion_id
       AND comercio_id = p_comercio_id
       AND usuario_id = v_usuario_auth
       AND estado = 'abierta'
       AND deleted_at IS NULL
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAJA_CERRADA: La sesión de caja indicada no existe o está cerrada.';
    END IF;
  END IF;

  -- Validar cliente si se indica p_cliente_id
  IF p_cliente_id IS NOT NULL THEN
    SELECT id, limite_credito
      INTO v_cliente
      FROM public.clientes
     WHERE id = p_cliente_id
       AND comercio_id = p_comercio_id
       AND deleted_at IS NULL
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CLIENTE_NO_ENCONTRADO: El cliente seleccionado no pertenece a este comercio.';
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
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
    IF NOT v_prod.permite_decimales AND v_cantidad <> FLOOR(v_cantidad) THEN
      RAISE EXCEPTION 'CANTIDAD_DECIMALES_NO_PERMITIDA: El producto % no admite cantidades decimales.', v_prod.nombre;
    END IF;

    v_bruto := ROUND(v_cantidad * v_prod.precio_venta)::bigint;
    v_descuento_item := COALESCE((v_item->>'descuento')::bigint, 0);
    IF v_descuento_item < 0 OR v_descuento_item > v_bruto THEN
      RAISE EXCEPTION 'DESCUENTO_INVALIDO: El descuento del ítem es inválido.';
    END IF;

    v_subtotal_item := v_bruto - v_descuento_item;
    v_subtotal_acumulado := v_subtotal_acumulado + v_subtotal_item;
  END LOOP;

  IF p_descuento_global < 0 OR p_descuento_global > v_subtotal_acumulado THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: El descuento global es inválido.';
  END IF;

  v_total_venta := v_subtotal_acumulado - p_descuento_global;

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos)
  LOOP
    v_monto_pago := (v_pago->>'monto')::bigint;
    IF v_monto_pago <= 0 THEN
      RAISE EXCEPTION 'PAGO_INVALIDO: Cada monto de pago debe ser positivo.';
    END IF;
    IF (v_pago->>'medio') = 'cuenta_corriente' THEN
      v_monto_cc := v_monto_cc + v_monto_pago;
    END IF;
    v_suma_pagos := v_suma_pagos + v_monto_pago;
  END LOOP;

  IF v_suma_pagos <> v_total_venta THEN
    RAISE EXCEPTION 'PAGOS_NO_COINCIDEN: La suma de pagos (%) no coincide con el total calculado en el servidor (%).', v_suma_pagos, v_total_venta;
  END IF;

  IF v_monto_cc > 0 THEN
    IF p_cliente_id IS NULL THEN
      RAISE EXCEPTION 'CLIENTE_REQUERIDO_CC: Para cobrar en cuenta corriente debés seleccionar un cliente.';
    END IF;
    SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE -monto END), 0)::bigint
      INTO v_saldo_actual_cc
      FROM public.cuenta_corriente_movimientos
     WHERE comercio_id = p_comercio_id
       AND entidad_tipo = 'cliente'
       AND entidad_id = p_cliente_id
       AND deleted_at IS NULL;
    IF (v_saldo_actual_cc + v_monto_cc) > COALESCE(v_cliente.limite_credito, 0) THEN
      RAISE EXCEPTION 'LIMITE_CREDITO_EXCEDIDO: El saldo supera el límite de crédito del cliente.';
    END IF;
  END IF;

  INSERT INTO public.ventas (
    id, comercio_id, fecha, usuario_id, cliente_id,
    subtotal, descuento, total, estado, caja_sesion_id,
    tipo_comprobante, canal, dispositivo_id, estado_facturacion,
    created_at, updated_at, device_id
  ) VALUES (
    p_venta_id, p_comercio_id, v_ahora, v_usuario_auth, p_cliente_id,
    v_subtotal_acumulado, p_descuento_global, v_total_venta, 'completada', p_caja_sesion_id,
    'ticket_no_fiscal', 'web', p_dispositivo_id, 'no_aplica',
    v_ahora, v_ahora, p_dispositivo_id
  );

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
      v_prod.costo_compra, p_venta_id::text, 'Venta móvil web', v_usuario_auth,
      v_ahora, v_ahora, p_dispositivo_id, 'sincronizado'
    );

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

  IF v_monto_cc > 0 THEN
    INSERT INTO public.cuenta_corriente_movimientos (
      id, comercio_id, entidad_tipo, entidad_id, tipo, monto,
      referencia_id, created_at, updated_at, device_id, sync_status
    ) VALUES (
      gen_random_uuid(), p_comercio_id, 'cliente', p_cliente_id, 'cargo', v_monto_cc,
      p_venta_id::text, v_ahora, v_ahora, p_dispositivo_id, 'sincronizado'
    );
  END IF;

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
    gen_random_uuid(), p_comercio_id, v_ahora, v_usuario_auth, v_usuario.nombre, v_usuario.rol,
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

NOTIFY pgrst, 'reload schema';
