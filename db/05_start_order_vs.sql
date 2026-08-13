-- VS start-order pairs per salida (test_part)
BEGIN;

ALTER TABLE test_parts
  ADD COLUMN IF NOT EXISTS start_order_vs JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
