-- Preferencia de lectura CSV Orbits 4 / 5 / auto
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS csv_source TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_csv_source_check;

ALTER TABLE events
  ADD CONSTRAINT events_csv_source_check
  CHECK (csv_source IN ('auto', 'orbits4', 'orbits5'));
