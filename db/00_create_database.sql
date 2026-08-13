-- =============================================================================
-- Minerva Timing Live — crear base de datos
-- Nombre lógico: "Minerva Timing Live"
-- Identificador PostgreSQL: minerva_timing_live
--
-- Ejecutar conectado a la DB `postgres` (o cualquier DB de mantenimiento):
--   psql -U postgres -f db/00_create_database.sql
-- =============================================================================

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'minerva_timing_live'
  AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS minerva_timing_live;

CREATE DATABASE minerva_timing_live
  WITH
    OWNER = CURRENT_USER
    ENCODING = 'UTF8'
    TEMPLATE = template0;

COMMENT ON DATABASE minerva_timing_live IS 'Minerva Timing Live — persistencia ACID del cronometraje';
