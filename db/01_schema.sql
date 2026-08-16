-- =============================================================================
-- Minerva Timing Live — esquema (ACID)
-- Conectar a la DB:  psql -U postgres -d minerva_timing_live -f db/01_schema.sql
--
-- Principios:
--   Atomicity  → operaciones de evento/CSV en una sola transacción (app + FKs)
--   Consistency → CHECK, UNIQUE, NOT NULL, FKs
--   Isolation   → transacciones READ COMMITTED (default) / SERIALIZABLE en app
--   Durability  → WAL de PostgreSQL; cabeceras de imagen siguen en disco
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Eventos
-- -----------------------------------------------------------------------------
CREATE TABLE events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  event_date          TEXT NOT NULL DEFAULT '',
  location            TEXT NOT NULL DEFAULT '',
  header_image        TEXT NULL,                 -- nombre de archivo en data/uploads/headers
  footer_text         TEXT NOT NULL DEFAULT 'Minerva Timing',
  password            TEXT NOT NULL,
  theme_colors        TEXT[] NULL,                 -- 4 hex o NULL = paleta Minerva
  board_page_seconds  INTEGER NOT NULL DEFAULT 10
                        CHECK (board_page_seconds BETWEEN 3 AND 120),
  overlay_variant     TEXT NOT NULL DEFAULT 'classic'
                        CHECK (overlay_variant IN ('classic', 'redbull', 'ponymalta')),
  overlay_timing      TEXT NOT NULL DEFAULT 'splits'
                        CHECK (overlay_timing IN ('splits', 'total')),
  csv_source          TEXT NOT NULL DEFAULT 'auto'
                        CHECK (csv_source IN ('auto', 'orbits4', 'orbits5')),
  overlay_live_refresh BOOLEAN NOT NULL DEFAULT TRUE,
  overlay_paging_mode TEXT NOT NULL DEFAULT 'auto'
                        CHECK (overlay_paging_mode IN ('auto', 'manual')),
  overlay_pilot_page  INTEGER NOT NULL DEFAULT 0,
  overlay_lap_page    INTEGER NOT NULL DEFAULT 0,
  -- Single active Orden de salida for /overlay/:id/orden-salida
  published_start_order_test_id UUID NULL,
  published_start_order_part_id UUID NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_updated_at ON events (updated_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- -----------------------------------------------------------------------------
-- Puntos de cronometraje
-- -----------------------------------------------------------------------------
CREATE TABLE timing_points (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  offset_ms   BIGINT NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  role        TEXT NULL
                CHECK (role IS NULL OR role IN (
                  'generic', 'start_finish', 'partial', 'start', 'finish'
                )),
  UNIQUE (event_id, id),
  UNIQUE (event_id, sort_order)
);

CREATE INDEX idx_timing_points_event ON timing_points (event_id, sort_order);

-- -----------------------------------------------------------------------------
-- Pilotos (por evento)
-- -----------------------------------------------------------------------------
CREATE TABLE pilots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  league      TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  UNIQUE (event_id, number)
);

CREATE INDEX idx_pilots_event_name ON pilots (event_id, name);

-- -----------------------------------------------------------------------------
-- Pruebas
-- -----------------------------------------------------------------------------
CREATE TABLE tests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  show_description_in_pdf BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  timing_mode             TEXT NOT NULL DEFAULT 'point_to_point'
                            CHECK (timing_mode IN ('point_to_point', 'start_finish_partial')),
  from_point_id           UUID NULL,
  to_point_id             UUID NULL,
  start_finish_point_id   UUID NULL,
  CONSTRAINT fk_tests_from_point
    FOREIGN KEY (event_id, from_point_id)
    REFERENCES timing_points (event_id, id)
    ON DELETE SET NULL,
  CONSTRAINT fk_tests_to_point
    FOREIGN KEY (event_id, to_point_id)
    REFERENCES timing_points (event_id, id)
    ON DELETE SET NULL,
  CONSTRAINT fk_tests_sf_point
    FOREIGN KEY (event_id, start_finish_point_id)
    REFERENCES timing_points (event_id, id)
    ON DELETE SET NULL,
  UNIQUE (event_id, id),
  UNIQUE (event_id, sort_order)
);

CREATE INDEX idx_tests_event ON tests (event_id, sort_order);

-- Parciales (modo start_finish_partial)
CREATE TABLE test_partial_points (
  test_id          UUID NOT NULL,
  event_id         UUID NOT NULL,
  timing_point_id  UUID NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (test_id, timing_point_id),
  FOREIGN KEY (event_id, test_id)
    REFERENCES tests (event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, timing_point_id)
    REFERENCES timing_points (event_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Partes / salidas
-- -----------------------------------------------------------------------------
CREATE TABLE test_parts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id            UUID NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  event_id           UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  combined_mode      BOOLEAN NOT NULL DEFAULT FALSE,
  csv_input_mode     TEXT NULL
                       CHECK (csv_input_mode IS NULL OR csv_input_mode IN ('points', 'combined', 'pilots')),
  combined_scoring   TEXT NULL
                       CHECK (combined_scoring IS NULL OR combined_scoring IN ('time', 'laps')),
  expected_laps      INTEGER NULL CHECK (expected_laps IS NULL OR expected_laps > 0),
  -- VS pairs for "Orden de salida" overlay: [{ "a": "1", "b": "2" }, ...]
  start_order_vs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (test_id, id),
  UNIQUE (test_id, sort_order)
);

CREATE INDEX idx_test_parts_test ON test_parts (test_id, sort_order);

-- -----------------------------------------------------------------------------
-- CSV cargados (metadatos) + pasadas + banderas  [persistencia del parseo]
-- -----------------------------------------------------------------------------
CREATE TABLE csv_uploads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id           UUID NOT NULL REFERENCES test_parts (id) ON DELETE CASCADE,
  timing_point_id   UUID NULL REFERENCES timing_points (id) ON DELETE SET NULL,
  -- CSV por piloto: un archivo por N° (NULL en CSV único / por punto)
  pilot_number      TEXT NULL,
  filename          TEXT NOT NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX csv_uploads_part_point_uq
  ON csv_uploads (part_id, timing_point_id)
  WHERE pilot_number IS NULL;

CREATE UNIQUE INDEX csv_uploads_part_pilot_uq
  ON csv_uploads (part_id, lower(btrim(pilot_number)))
  WHERE pilot_number IS NOT NULL AND btrim(pilot_number) <> '';

CREATE INDEX idx_csv_uploads_part ON csv_uploads (part_id);

CREATE TABLE csv_passages (
  id              BIGSERIAL PRIMARY KEY,
  csv_upload_id   UUID NOT NULL REFERENCES csv_uploads (id) ON DELETE CASCADE,
  number          TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  tm_pasos_ms     BIGINT NOT NULL DEFAULT 0,
  tm_pasos_raw    TEXT NOT NULL DEFAULT '',
  lap_time_ms     BIGINT NULL,
  lap_time_raw    TEXT NOT NULL DEFAULT '',
  laps_count      INTEGER NULL,
  elapsed_ms      BIGINT NULL,
  clase           TEXT NOT NULL DEFAULT '',
  row_index       INTEGER NOT NULL DEFAULT 0,
  is_race         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_csv_passages_upload ON csv_passages (csv_upload_id);
CREATE INDEX idx_csv_passages_number ON csv_passages (csv_upload_id, number);
CREATE INDEX idx_csv_passages_race ON csv_passages (csv_upload_id) WHERE is_race;

CREATE TABLE csv_flags (
  id              BIGSERIAL PRIMARY KEY,
  csv_upload_id   UUID NOT NULL REFERENCES csv_uploads (id) ON DELETE CASCADE,
  flag_type       TEXT NOT NULL
                    CHECK (flag_type IN (
                      'warmup', 'green', 'checkered', 'stopped', 'manual', 'other'
                    )),
  tm_pasos_ms     BIGINT NOT NULL DEFAULT 0,
  tm_pasos_raw    TEXT NOT NULL DEFAULT '',
  label           TEXT NOT NULL DEFAULT '',
  row_index       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_csv_flags_upload ON csv_flags (csv_upload_id);

-- -----------------------------------------------------------------------------
-- Penalizaciones (una por piloto dentro de la prueba)
-- -----------------------------------------------------------------------------
CREATE TABLE test_penalties (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id             UUID NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  pilot_number        TEXT NOT NULL,
  scope               TEXT NOT NULL DEFAULT 'shared',
  time_penalty_ms     BIGINT NOT NULL DEFAULT 0 CHECK (time_penalty_ms >= 0),
  position_penalty    INTEGER NOT NULL DEFAULT 0 CHECK (position_penalty >= 0),
  comment             TEXT NOT NULL DEFAULT '',
  UNIQUE (test_id, pilot_number)
);

CREATE INDEX idx_test_penalties_test ON test_penalties (test_id);

-- -----------------------------------------------------------------------------
-- Fusiones guardadas (snapshot reproducible)
-- -----------------------------------------------------------------------------
CREATE TABLE fusions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  warning      TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, id)
);

CREATE TABLE fusion_tests (
  fusion_id       UUID NOT NULL REFERENCES fusions (id) ON DELETE CASCADE,
  test_id         UUID NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  test_name       TEXT NOT NULL,
  segment_label   TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fusion_id, test_id)
);

CREATE TABLE fusion_rows (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fusion_id             UUID NOT NULL REFERENCES fusions (id) ON DELETE CASCADE,
  position              INTEGER NOT NULL,
  number                TEXT NOT NULL,
  name                  TEXT NOT NULL DEFAULT '',
  category              TEXT NOT NULL DEFAULT '',
  league                TEXT NOT NULL DEFAULT '',
  total_time_ms         BIGINT NOT NULL,
  total_time_formatted  TEXT NOT NULL,
  tests_count           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (fusion_id, number)
);

CREATE TABLE fusion_row_times (
  fusion_row_id    UUID NOT NULL REFERENCES fusion_rows (id) ON DELETE CASCADE,
  test_id          UUID NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  test_name        TEXT NOT NULL DEFAULT '',
  segment_label    TEXT NOT NULL DEFAULT '',
  time_ms          BIGINT NULL,
  time_formatted   TEXT NOT NULL DEFAULT '—',
  laps             INTEGER NULL,
  PRIMARY KEY (fusion_row_id, test_id)
);

-- -----------------------------------------------------------------------------
-- Tablero público (orden de publicación)
-- -----------------------------------------------------------------------------
CREATE TABLE results_board (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('unified', 'fusion')),
  ref_id         UUID NOT NULL,           -- test_id o fusion_id
  part_id        UUID NULL,               -- salida concreta si kind=unified
  title          TEXT NOT NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, sort_order),
  CONSTRAINT chk_board_part
    CHECK (kind = 'fusion' AND part_id IS NULL OR kind = 'unified')
);

CREATE INDEX idx_results_board_event ON results_board (event_id, sort_order);

COMMENT ON TABLE events IS 'Evento de cronometraje (panel protegido por password)';
COMMENT ON TABLE csv_uploads IS 'Archivo CSV asociado a una salida + punto (parsed en csv_passages/csv_flags)';
COMMENT ON TABLE csv_passages IS 'Filas de pasada del CSV; is_race = dentro de ventana verde';
COMMENT ON TABLE results_board IS 'Entradas publicadas en /tablero (no cachea filas: se recalculan)';

COMMIT;
