# Base de datos — Minerva Timing Live

Persistencia PostgreSQL con reglas **ACID**, equivalente funcional a `data/events/*.json`.

| Nombre mostrado        | Identificador PostgreSQL |
|------------------------|--------------------------|
| Minerva Timing Live    | `minerva_timing_live`    |

(PostgreSQL no permite espacios cómodos en el nombre de la DB.)

## Archivos

| Archivo | Uso |
|---------|-----|
| `00_create_database.sql` | Crea (o recrea) la base `minerva_timing_live` |
| `01_schema.sql` | Tablas, FKs, CHECKs, índices, trigger `updated_at` |
| `08_overlay_variant_ponymalta.sql` | Overlay Circuito Pony Malta |
| `09_csv_input_mode.sql` | CSV por piloto + modo de carga de la salida |

Regenerar el seed tras cambiar JSON:

```bash
node scripts/generate-seed.mjs
```

## Cómo aplicar

```bash
# 1) Crear DB (conectado a "postgres")
psql -U postgres -f db/00_create_database.sql

# 2) Esquema
psql -U postgres -d minerva_timing_live -f db/01_schema.sql

# 3) Seed (eventos, pilotos, CSV parseados, penalizaciones, tablero)
psql -U postgres -d minerva_timing_live -f db/02_seed.sql
```

En Windows (PowerShell), si `psql` está en el PATH:

```powershell
psql -U postgres -f db/00_create_database.sql
psql -U postgres -d minerva_timing_live -f db/01_schema.sql
psql -U postgres -d minerva_timing_live -f db/02_seed.sql
```

## Modelo (resumen)

```
events
  ├── timing_points
  ├── pilots
  ├── tests
  │     ├── test_partial_points
  │     ├── test_penalties
  │     └── test_parts
  │           └── csv_uploads
  │                 ├── csv_passages   (is_race = pasada en ventana verde)
  │                 └── csv_flags
  ├── fusions (+ fusion_tests / fusion_rows / fusion_row_times)
  └── results_board
```

- **Cabeceras de imagen:** solo se guarda el nombre de archivo (`header_image`); el binario sigue en `data/uploads/headers/`.
- **Resultados publicados:** el tablero guarda la *referencia* (prueba/fusión); las filas se recalculan como hoy (no se cachean rankings).
- **CSV:** cada upload tiene sus pasadas y banderas normalizadas (consultables y transaccionales).

## ACID en la app

Express usa `pg` (`backend/src/db.ts` + `backend/src/eventsRepo.ts`):

1. Cada `saveEvent` = **una transacción** (DELETE cascada del evento + INSERT del árbol completo).
2. Borrados en cascada vía FK (`ON DELETE CASCADE`).
3. Credenciales en `.env` (raíz del repo). Health: `GET /api/health` → `database: minerva_timing_live`.

Probar carga:

```bash
npx tsx scripts/test-db.ts
```
