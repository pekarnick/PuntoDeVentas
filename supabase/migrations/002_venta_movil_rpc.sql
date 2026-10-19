-- ============================================================================
-- Migración Supabase 002: Venta Móvil Web (/web-pos) — Sesiones, Vista sin costos
-- y RPC transaccional e idempotente crear_venta_movil (PLAN.md §6.2 — Fase 3b)
-- ============================================================================

-- 1. Tabla de sesiones móviles sincronizable con revocación y expiración
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
  device_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sesiones_moviles_comercio_estado
  ON public.sesiones_moviles(comercio_id, estado, ultima_actividad_at DESC);

ALTER TABLE public.sesiones_moviles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_sesiones_moviles_all ON public.sesiones_moviles;
CREATE POLICY rls_sesiones_moviles_all ON public.sesiones_moviles
  FOR ALL TO anon, authenticated
  USING (comercio_id = public.mi_comercio_id())
  WITH CHECK (comercio_id = public.mi_comercio_id());

-- 2. Vista de catálogo para Venta Móvil (Regla 20: NUNCA incluye costo_compra)
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
  COALESCE(pr.precio_venta, 0) AS precio_venta,
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

-- 3. Función RPC transaccional e idempotente crear_venta_movil (PLAN.md §6.2)
-- - Verifica venta_movil_habilitada en el comercio y puede_vender_movil en el usuario
-- - Verifica idempotencia por p_venta_id (UUID generado en el celular)
-- - Recalcula precios y totales desde la tabla precios en el servidor
-- - Inserta venta (canal = 'web'), items, pagos, movimientos_stock y auditoria en una sola transacción
-- - Devuelve el comprobante sin costo_compra ni costo_unitario (Regla 20)
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
SET search_path = public
AS $$
DECLARE
  v_venta_existente RECORD;
  v_comercio RECORD;
  v_usuario RECORD;
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
  v_ahora TIMESTAMPTZ := NOW();
  v_hash_prev TEXT;
  v_hash_nuevo TEXT;
  v_items_respuesta JSONB := '[]'::jsonb;
BEGIN
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
      referencia_tipo, referencia_id, motivo, usuario_id,
      created_at, updated_at, device_id
    ) VALUES (
      gen_random_uuid(), p_comercio_id, v_prod.id, 'venta', -ABS(v_cantidad),
      'venta_movil', p_venta_id::text, 'Venta móvil web', p_usuario_id,
      v_ahora, v_ahora, p_dispositivo_id
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
    'items', v_items_respuesta
  );
END;
$$;
