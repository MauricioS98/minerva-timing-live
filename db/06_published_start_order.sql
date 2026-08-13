-- Single published "Orden de salida" for the overlay (one active at a time).
BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS published_start_order_test_id UUID NULL
    REFERENCES tests (id) ON DELETE SET NULL;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS published_start_order_part_id UUID NULL
    REFERENCES test_parts (id) ON DELETE SET NULL;

COMMIT;
