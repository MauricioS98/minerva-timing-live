/**
 * Genera db/02_seed.sql a partir de data/events/*.json
 * Uso: node scripts/generate-seed.mjs
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const eventsDir = path.join(root, "data", "events");
const outFile = path.join(root, "db", "02_seed.sql");

function sqlStr(v) {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlUuid(v) {
  if (v == null || v === "") return "NULL";
  return sqlStr(v);
}

function sqlBool(v) {
  return v ? "TRUE" : "FALSE";
}

function sqlInt(v, fallback = 0) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return String(fallback);
  return String(Math.trunc(Number(v)));
}

function sqlBig(v, fallback = 0) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return String(fallback);
  return String(Math.trunc(Number(v)));
}

function sqlTextArray(arr) {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return "NULL";
  return `ARRAY[${arr.map((c) => sqlStr(c)).join(", ")}]::TEXT[]`;
}

function sqlTs(iso) {
  if (!iso) return "now()";
  return sqlStr(iso);
}

const lines = [];
function w(s = "") {
  lines.push(s);
}

w("-- =============================================================================");
w("-- Minerva Timing Live — seed desde data/events/*.json");
w(`-- Generado: ${new Date().toISOString()}`);
w("--   psql -U postgres -d minerva_timing_live -f db/02_seed.sql");
w("-- =============================================================================");
w("");
w("BEGIN;");
w("");
w("-- Limpieza (orden por FKs; CASCADE cubre hijos)");
w("TRUNCATE TABLE");
w("  results_board,");
w("  fusion_row_times,");
w("  fusion_rows,");
w("  fusion_tests,");
w("  fusions,");
w("  test_penalties,");
w("  csv_flags,");
w("  csv_passages,");
w("  csv_uploads,");
w("  test_parts,");
w("  test_partial_points,");
w("  tests,");
w("  pilots,");
w("  timing_points,");
w("  events");
w("RESTART IDENTITY CASCADE;");
w("");

const files = fs
  .readdirSync(eventsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

for (const file of files) {
  const event = JSON.parse(fs.readFileSync(path.join(eventsDir, file), "utf8"));
  w(`-- ── Evento: ${event.name} (${event.id}) ──────────────────────────────`);
  w(
    `INSERT INTO events (id, name, event_date, location, header_image, footer_text, password, theme_colors, board_page_seconds, created_at, updated_at) VALUES (`
  );
  w(
    `  ${sqlUuid(event.id)}, ${sqlStr(event.name)}, ${sqlStr(event.date || "")}, ${sqlStr(event.location || "")}, ${sqlStr(event.headerImage)}, ${sqlStr(event.footerText || "Minerva Timing")}, ${sqlStr(event.password || "00000")}, ${sqlTextArray(event.themeColors)}, ${sqlInt(event.boardPageSeconds ?? 10, 10)}, ${sqlTs(event.createdAt)}, ${sqlTs(event.updatedAt)}`
  );
  w(`);`);
  w("");

  for (const p of event.timingPoints || []) {
    w(
      `INSERT INTO timing_points (id, event_id, name, offset_ms, sort_order, role) VALUES (${sqlUuid(p.id)}, ${sqlUuid(event.id)}, ${sqlStr(p.name)}, ${sqlBig(p.offsetMs)}, ${sqlInt(p.order)}, ${sqlStr(p.role ?? null)});`
    );
  }
  w("");

  for (const p of event.pilots || []) {
    w(
      `INSERT INTO pilots (id, event_id, number, name, category, league, notes) VALUES (${sqlUuid(p.id)}, ${sqlUuid(event.id)}, ${sqlStr(p.number)}, ${sqlStr(p.name || "")}, ${sqlStr(p.category || "")}, ${sqlStr(p.league || "")}, ${sqlStr(p.notes || "")});`
    );
  }
  if ((event.pilots || []).length) w("");

  for (const t of event.tests || []) {
    w(
      `INSERT INTO tests (id, event_id, name, description, show_description_in_pdf, sort_order, timing_mode, from_point_id, to_point_id, start_finish_point_id) VALUES (`
    );
    w(
      `  ${sqlUuid(t.id)}, ${sqlUuid(event.id)}, ${sqlStr(t.name)}, ${sqlStr(t.description || "")}, ${sqlBool(t.showDescriptionInPdf)}, ${sqlInt(t.order)}, ${sqlStr(t.timingMode || "point_to_point")}, ${sqlUuid(t.fromPointId)}, ${sqlUuid(t.toPointId)}, ${sqlUuid(t.startFinishPointId || t.fromPointId)}`
    );
    w(`);`);

    const partials = Array.isArray(t.partialPointIds)
      ? t.partialPointIds
      : t.toPointId
        ? [t.toPointId]
        : [];
    partials.forEach((pid, i) => {
      w(
        `INSERT INTO test_partial_points (test_id, event_id, timing_point_id, sort_order) VALUES (${sqlUuid(t.id)}, ${sqlUuid(event.id)}, ${sqlUuid(pid)}, ${i});`
      );
    });

    for (const part of t.parts || []) {
      const scoring =
        part.combinedMode || part.csvInputMode === "pilots" || part.csvInputMode === "combined"
          ? part.combinedScoring || "time"
          : part.combinedScoring || null;
      const csvMode =
        part.csvInputMode === "pilots" ||
        part.csvInputMode === "combined" ||
        part.csvInputMode === "points"
          ? part.csvInputMode
          : part.combinedMode
            ? "combined"
            : "points";
      w(
        `INSERT INTO test_parts (id, test_id, event_id, name, sort_order, combined_mode, csv_input_mode, combined_scoring, expected_laps) VALUES (${sqlUuid(part.id)}, ${sqlUuid(t.id)}, ${sqlUuid(event.id)}, ${sqlStr(part.name)}, ${sqlInt(part.order)}, ${sqlBool(part.combinedMode)}, ${sqlStr(csvMode)}, ${sqlStr(scoring)}, ${part.expectedLaps == null ? "NULL" : sqlInt(part.expectedLaps)});`
      );

      for (const slot of part.csvs || []) {
        const uploadId = randomUUID();
        w(
          `INSERT INTO csv_uploads (id, part_id, timing_point_id, pilot_number, filename, uploaded_at) VALUES (${sqlUuid(uploadId)}, ${sqlUuid(part.id)}, ${sqlUuid(slot.timingPointId)}, ${slot.pilotNumber ? sqlStr(slot.pilotNumber) : "NULL"}, ${sqlStr(slot.filename)}, now());`
        );

        const parsed = slot.parsed || { passages: [], racePassages: [], flags: [] };
        const raceRows = new Set(
          (parsed.racePassages || []).map((r) => `${r.rowIndex}|${r.number}|${r.tmPasosMs}`)
        );

        for (const pass of parsed.passages || []) {
          const key = `${pass.rowIndex}|${pass.number}|${pass.tmPasosMs}`;
          const isRace =
            raceRows.has(key) ||
            (parsed.racePassages || []).some(
              (r) => r.rowIndex === pass.rowIndex && String(r.number) === String(pass.number)
            );
          w(
            `INSERT INTO csv_passages (csv_upload_id, number, name, tm_pasos_ms, tm_pasos_raw, lap_time_ms, lap_time_raw, laps_count, elapsed_ms, clase, row_index, is_race) VALUES (${sqlUuid(uploadId)}, ${sqlStr(pass.number || "")}, ${sqlStr(pass.name || "")}, ${sqlBig(pass.tmPasosMs)}, ${sqlStr(pass.tmPasosRaw || "")}, ${pass.lapTimeMs == null ? "NULL" : sqlBig(pass.lapTimeMs)}, ${sqlStr(pass.lapTimeRaw || "")}, ${pass.lapsCount == null ? "NULL" : sqlInt(pass.lapsCount)}, ${pass.elapsedMs == null ? "NULL" : sqlBig(pass.elapsedMs)}, ${sqlStr(pass.clase || "")}, ${sqlInt(pass.rowIndex)}, ${sqlBool(isRace)});`
          );
        }

        for (const fl of parsed.flags || []) {
          w(
            `INSERT INTO csv_flags (csv_upload_id, flag_type, tm_pasos_ms, tm_pasos_raw, label, row_index) VALUES (${sqlUuid(uploadId)}, ${sqlStr(fl.type || "other")}, ${sqlBig(fl.tmPasosMs)}, ${sqlStr(fl.tmPasosRaw || "")}, ${sqlStr(fl.label || "")}, ${sqlInt(fl.rowIndex)});`
          );
        }
      }
    }

    for (const pen of t.penalties || []) {
      w(
        `INSERT INTO test_penalties (test_id, pilot_number, scope, time_penalty_ms, position_penalty, comment) VALUES (${sqlUuid(t.id)}, ${sqlStr(pen.number)}, ${sqlStr(pen.scope || "shared")}, ${sqlBig(pen.timePenaltyMs || 0)}, ${sqlInt(pen.positionPenalty || 0)}, ${sqlStr(pen.comment || "")});`
      );
    }
    w("");
  }

  for (const fus of event.fusions || []) {
    w(
      `INSERT INTO fusions (id, event_id, name, warning, created_at) VALUES (${sqlUuid(fus.id)}, ${sqlUuid(event.id)}, ${sqlStr(fus.name)}, ${sqlStr(fus.warning ?? null)}, ${sqlTs(fus.createdAt)});`
    );
    (fus.tests || []).forEach((ft, i) => {
      w(
        `INSERT INTO fusion_tests (fusion_id, test_id, test_name, segment_label, sort_order) VALUES (${sqlUuid(fus.id)}, ${sqlUuid(ft.id)}, ${sqlStr(ft.name)}, ${sqlStr(ft.segmentLabel || "")}, ${i});`
      );
    });
    for (const row of fus.rows || []) {
      const rowId = randomUUID();
      w(
        `INSERT INTO fusion_rows (id, fusion_id, position, number, name, category, league, total_time_ms, total_time_formatted, tests_count) VALUES (${sqlUuid(rowId)}, ${sqlUuid(fus.id)}, ${sqlInt(row.position)}, ${sqlStr(row.number)}, ${sqlStr(row.name || "")}, ${sqlStr(row.category || "")}, ${sqlStr(row.league || "")}, ${sqlBig(row.totalTimeMs)}, ${sqlStr(row.totalTimeFormatted)}, ${sqlInt(row.testsCount || 0)});`
      );
      for (const bt of row.byTest || []) {
        w(
          `INSERT INTO fusion_row_times (fusion_row_id, test_id, test_name, segment_label, time_ms, time_formatted, laps) VALUES (${sqlUuid(rowId)}, ${sqlUuid(bt.testId)}, ${sqlStr(bt.testName || "")}, ${sqlStr(bt.segmentLabel || "")}, ${bt.timeMs == null ? "NULL" : sqlBig(bt.timeMs)}, ${sqlStr(bt.timeFormatted || "—")}, ${bt.laps == null ? "NULL" : sqlInt(bt.laps)});`
        );
      }
    }
  }

  for (const b of event.resultsBoard || []) {
    w(
      `INSERT INTO results_board (id, event_id, kind, ref_id, part_id, title, published_at, sort_order) VALUES (${sqlUuid(b.id)}, ${sqlUuid(event.id)}, ${sqlStr(b.kind)}, ${sqlUuid(b.refId)}, ${sqlUuid(b.partId ?? null)}, ${sqlStr(b.title)}, ${sqlTs(b.publishedAt)}, ${sqlInt(b.order)});`
    );
  }
  w("");
}

w("COMMIT;");
w("");
w("-- Verificación rápida");
w("SELECT 'events' AS tabla, COUNT(*) FROM events");
w("UNION ALL SELECT 'pilots', COUNT(*) FROM pilots");
w("UNION ALL SELECT 'tests', COUNT(*) FROM tests");
w("UNION ALL SELECT 'test_parts', COUNT(*) FROM test_parts");
w("UNION ALL SELECT 'csv_uploads', COUNT(*) FROM csv_uploads");
w("UNION ALL SELECT 'csv_passages', COUNT(*) FROM csv_passages");
w("UNION ALL SELECT 'csv_flags', COUNT(*) FROM csv_flags");
w("UNION ALL SELECT 'test_penalties', COUNT(*) FROM test_penalties");
w("UNION ALL SELECT 'results_board', COUNT(*) FROM results_board;");

fs.writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(`Wrote ${outFile} (${lines.length} lines, ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
