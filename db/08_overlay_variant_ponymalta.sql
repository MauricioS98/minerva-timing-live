-- Allow Pony Malta overlay variant alongside classic and RedBull.
BEGIN;

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_overlay_variant_check;

ALTER TABLE events
  ADD CONSTRAINT events_overlay_variant_check
  CHECK (overlay_variant IN ('classic', 'redbull', 'ponymalta'));

COMMIT;
