-- On/Off for overlay data polling (positions, lap-by-lap, start order).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overlay_live_refresh BOOLEAN NOT NULL DEFAULT TRUE;
