-- ============================================================================
-- Migración SQLite 009: Endurecimiento de Seguridad P1
-- (Retiro de netlify_token en texto plano y triggers append-only faltantes)
-- ============================================================================

UPDATE configuracion_sistema SET netlify_token = NULL;

CREATE TRIGGER IF NOT EXISTS trg_cc_movimientos_no_update
BEFORE UPDATE ON cuenta_corriente_movimientos
BEGIN
  SELECT RAISE(ABORT, 'TABLA_APPEND_ONLY: cuenta_corriente_movimientos no permite UPDATE.');
END;

CREATE TRIGGER IF NOT EXISTS trg_cc_movimientos_no_delete
BEFORE DELETE ON cuenta_corriente_movimientos
BEGIN
  SELECT RAISE(ABORT, 'TABLA_APPEND_ONLY: cuenta_corriente_movimientos no permite DELETE.');
END;

CREATE TRIGGER IF NOT EXISTS trg_compras_no_delete
BEFORE DELETE ON compras
BEGIN
  SELECT RAISE(ABORT, 'TABLA_APPEND_ONLY: compras no permite DELETE.');
END;

CREATE TRIGGER IF NOT EXISTS trg_compras_items_no_update
BEFORE UPDATE ON compras_items
BEGIN
  SELECT RAISE(ABORT, 'TABLA_APPEND_ONLY: compras_items no permite UPDATE.');
END;

CREATE TRIGGER IF NOT EXISTS trg_compras_items_no_delete
BEFORE DELETE ON compras_items
BEGIN
  SELECT RAISE(ABORT, 'TABLA_APPEND_ONLY: compras_items no permite DELETE.');
END;

CREATE TRIGGER IF NOT EXISTS trg_ventas_no_delete
BEFORE DELETE ON ventas
BEGIN
  SELECT RAISE(ABORT, 'TABLA_APPEND_ONLY: ventas no permite DELETE (Regla 3).');
END;
