-- CSV único: varios archivos por salida (NULL timing_point_id).
-- El índice (part_id, timing_point_id) no debe tratar dos NULL como el mismo slot.
-- Aplicar también en Supabase: SQL Editor → New query → Run.

BEGIN;

DROP INDEX IF EXISTS csv_uploads_part_point_uq;
CREATE UNIQUE INDEX csv_uploads_part_point_uq
  ON csv_uploads (part_id, timing_point_id)
  WHERE pilot_number IS NULL AND timing_point_id IS NOT NULL;

DROP INDEX IF EXISTS csv_uploads_part_combined_file_uq;
CREATE UNIQUE INDEX csv_uploads_part_combined_file_uq
  ON csv_uploads (part_id, filename)
  WHERE pilot_number IS NULL AND timing_point_id IS NULL;

COMMIT;
