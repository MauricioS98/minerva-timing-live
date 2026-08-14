-- CSV por piloto: modo de carga + un slot por N° dentro de la salida.

ALTER TABLE test_parts
  ADD COLUMN IF NOT EXISTS csv_input_mode TEXT NULL;

ALTER TABLE test_parts
  DROP CONSTRAINT IF EXISTS test_parts_csv_input_mode_check;

ALTER TABLE test_parts
  ADD CONSTRAINT test_parts_csv_input_mode_check
  CHECK (csv_input_mode IS NULL OR csv_input_mode IN ('points', 'combined', 'pilots'));

UPDATE test_parts
SET csv_input_mode = CASE WHEN combined_mode THEN 'combined' ELSE 'points' END
WHERE csv_input_mode IS NULL;

ALTER TABLE csv_uploads
  ADD COLUMN IF NOT EXISTS pilot_number TEXT NULL;

ALTER TABLE csv_uploads
  DROP CONSTRAINT IF EXISTS csv_uploads_part_id_timing_point_id_key;

DROP INDEX IF EXISTS csv_uploads_part_point_uq;
CREATE UNIQUE INDEX csv_uploads_part_point_uq
  ON csv_uploads (part_id, timing_point_id)
  WHERE pilot_number IS NULL;

DROP INDEX IF EXISTS csv_uploads_part_pilot_uq;
CREATE UNIQUE INDEX csv_uploads_part_pilot_uq
  ON csv_uploads (part_id, lower(btrim(pilot_number)))
  WHERE pilot_number IS NOT NULL AND btrim(pilot_number) <> '';
