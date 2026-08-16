-- Overlay director: auto/manual paging + selected pages.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overlay_paging_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_overlay_paging_mode_check;

ALTER TABLE events
  ADD CONSTRAINT events_overlay_paging_mode_check
  CHECK (overlay_paging_mode IN ('auto', 'manual'));

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overlay_pilot_page INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overlay_lap_page INTEGER NOT NULL DEFAULT 0;
