-- Add overlay variant selector (classic | redbull) for existing databases.
BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overlay_variant TEXT NOT NULL DEFAULT 'classic';

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_overlay_variant_check;

ALTER TABLE events
  ADD CONSTRAINT events_overlay_variant_check
  CHECK (overlay_variant IN ('classic', 'redbull', 'ponymalta'));

COMMIT;
