-- Overlay timing display: splits (trayectos + total) or total only.
BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overlay_timing TEXT NOT NULL DEFAULT 'splits';

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_overlay_timing_check;

ALTER TABLE events
  ADD CONSTRAINT events_overlay_timing_check
  CHECK (overlay_timing IN ('splits', 'total'));

COMMIT;
