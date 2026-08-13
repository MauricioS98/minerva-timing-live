import type pg from "pg";
import { pool } from "./db.js";
import type {
  Event,
  FlagEvent,
  FlagType,
  FusionRow,
  Passage,
  Pilot,
  PilotPenalty,
  ResultsBoardEntry,
  SavedFusion,
  StartOrderVsPair,
  Test,
  TestPart,
  TestTimingMode,
  TimingPoint,
  TimingPointRole,
} from "./types.js";

function parseStartOrderVs(raw: unknown): StartOrderVsPair[] {
  if (!Array.isArray(raw)) return [];
  const out: StartOrderVsPair[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = String((item as { a?: unknown }).a ?? "").trim();
    const b = String((item as { b?: unknown }).b ?? "").trim();
    if (!a && !b) continue;
    out.push({ a, b });
  }
  return out;
}

type Q = pg.PoolClient | typeof pool;

async function q<T extends pg.QueryResultRow>(
  client: Q,
  text: string,
  params?: unknown[]
) {
  return client.query<T>(text, params);
}

function mapEventRow(row: Record<string, unknown>): Omit<
  Event,
  "timingPoints" | "pilots" | "tests" | "fusions" | "resultsBoard"
> {
  return {
    id: String(row.id),
    name: String(row.name),
    date: String(row.event_date ?? ""),
    location: String(row.location ?? ""),
    headerImage: (row.header_image as string | null) ?? null,
    footerText: String(row.footer_text ?? "Minerva Timing"),
    password: String(row.password),
    themeColors: (row.theme_colors as string[] | null) ?? null,
    boardPageSeconds: Number(row.board_page_seconds ?? 10),
    overlayVariant:
      String(row.overlay_variant || "classic") === "redbull" ? "redbull" : "classic",
    overlayTiming:
      String(row.overlay_timing || "splits") === "total" ? "total" : "splits",
    csvSource:
      row.csv_source === "orbits4" || row.csv_source === "orbits5"
        ? (row.csv_source as "orbits4" | "orbits5")
        : "auto",
    publishedStartOrder:
      row.published_start_order_test_id && row.published_start_order_part_id
        ? {
            testId: String(row.published_start_order_test_id),
            partId: String(row.published_start_order_part_id),
          }
        : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapPassage(row: Record<string, unknown>): Passage & { is_race?: boolean } {
  return {
    number: String(row.number ?? ""),
    name: String(row.name ?? ""),
    tmPasosMs: Number(row.tm_pasos_ms ?? 0),
    tmPasosRaw: String(row.tm_pasos_raw ?? ""),
    lapTimeMs: row.lap_time_ms == null ? null : Number(row.lap_time_ms),
    lapTimeRaw: String(row.lap_time_raw ?? ""),
    lapsCount: row.laps_count == null ? null : Number(row.laps_count),
    elapsedMs: row.elapsed_ms == null ? null : Number(row.elapsed_ms),
    clase: String(row.clase ?? ""),
    rowIndex: Number(row.row_index ?? 0),
    is_race: Boolean(row.is_race),
  };
}

export async function loadEvent(id: string): Promise<Event | null> {
  const evRes = await q(pool, `SELECT * FROM events WHERE id = $1`, [id]);
  if (!evRes.rows[0]) return null;
  const base = mapEventRow(evRes.rows[0] as Record<string, unknown>);

  const [pointsRes, pilotsRes, testsRes, boardRes, fusionsRes] = await Promise.all([
    q(pool, `SELECT * FROM timing_points WHERE event_id = $1 ORDER BY sort_order`, [id]),
    q(pool, `SELECT * FROM pilots WHERE event_id = $1 ORDER BY number`, [id]),
    q(pool, `SELECT * FROM tests WHERE event_id = $1 ORDER BY sort_order`, [id]),
    q(pool, `SELECT * FROM results_board WHERE event_id = $1 ORDER BY sort_order`, [id]),
    q(pool, `SELECT * FROM fusions WHERE event_id = $1 ORDER BY created_at`, [id]),
  ]);

  const timingPoints: TimingPoint[] = pointsRes.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    offsetMs: Number(r.offset_ms ?? 0),
    order: Number(r.sort_order ?? 0),
    role: (r.role as TimingPointRole | null) || undefined,
  }));

  const pilots: Pilot[] = pilotsRes.rows.map((r) => ({
    id: String(r.id),
    number: String(r.number),
    name: String(r.name ?? ""),
    category: String(r.category ?? ""),
    league: String(r.league ?? ""),
    notes: String(r.notes ?? ""),
  }));

  const testIds = testsRes.rows.map((r) => String(r.id));
  const partialsByTest = new Map<string, string[]>();
  const penaltiesByTest = new Map<string, PilotPenalty[]>();
  const partsByTest = new Map<string, TestPart[]>();

  if (testIds.length > 0) {
    const [partialsRes, penaltiesRes, partsRes] = await Promise.all([
      q(
        pool,
        `SELECT * FROM test_partial_points WHERE event_id = $1 ORDER BY sort_order`,
        [id]
      ),
      q(
        pool,
        `SELECT p.* FROM test_penalties p
         INNER JOIN tests t ON t.id = p.test_id
         WHERE t.event_id = $1`,
        [id]
      ),
      q(
        pool,
        `SELECT * FROM test_parts WHERE event_id = $1 ORDER BY sort_order`,
        [id]
      ),
    ]);

    for (const r of partialsRes.rows) {
      const tid = String(r.test_id);
      if (!partialsByTest.has(tid)) partialsByTest.set(tid, []);
      partialsByTest.get(tid)!.push(String(r.timing_point_id));
    }

    for (const r of penaltiesRes.rows) {
      const tid = String(r.test_id);
      if (!penaltiesByTest.has(tid)) penaltiesByTest.set(tid, []);
      penaltiesByTest.get(tid)!.push({
        number: String(r.pilot_number),
        scope: String(r.scope || "shared"),
        timePenaltyMs: Number(r.time_penalty_ms || 0),
        positionPenalty: Number(r.position_penalty || 0),
        comment: String(r.comment || ""),
      });
    }

    const partIds = partsRes.rows.map((r) => String(r.id));
    const csvsByPart = new Map<
      string,
      { timingPointId: string; filename: string; uploadId: string }[]
    >();

    if (partIds.length > 0) {
      const uploadsRes = await q(
        pool,
        `SELECT * FROM csv_uploads WHERE part_id = ANY($1::uuid[])`,
        [partIds]
      );
      const uploadIds = uploadsRes.rows.map((r) => String(r.id));

      for (const r of uploadsRes.rows) {
        const pid = String(r.part_id);
        if (!csvsByPart.has(pid)) csvsByPart.set(pid, []);
        csvsByPart.get(pid)!.push({
          uploadId: String(r.id),
          timingPointId: String(r.timing_point_id),
          filename: String(r.filename),
        });
      }

      const passagesByUpload = new Map<string, Passage[]>();
      const raceByUpload = new Map<string, Passage[]>();
      const flagsByUpload = new Map<string, FlagEvent[]>();

      if (uploadIds.length > 0) {
        const [passRes, flagRes] = await Promise.all([
          q(
            pool,
            `SELECT * FROM csv_passages WHERE csv_upload_id = ANY($1::uuid[]) ORDER BY row_index, id`,
            [uploadIds]
          ),
          q(
            pool,
            `SELECT * FROM csv_flags WHERE csv_upload_id = ANY($1::uuid[]) ORDER BY row_index, id`,
            [uploadIds]
          ),
        ]);

        for (const r of passRes.rows) {
          const uid = String(r.csv_upload_id);
          const p = mapPassage(r as Record<string, unknown>);
          const { is_race, ...passage } = p;
          if (!passagesByUpload.has(uid)) passagesByUpload.set(uid, []);
          passagesByUpload.get(uid)!.push(passage);
          if (is_race) {
            if (!raceByUpload.has(uid)) raceByUpload.set(uid, []);
            raceByUpload.get(uid)!.push(passage);
          }
        }

        for (const r of flagRes.rows) {
          const uid = String(r.csv_upload_id);
          if (!flagsByUpload.has(uid)) flagsByUpload.set(uid, []);
          flagsByUpload.get(uid)!.push({
            type: String(r.flag_type) as FlagType,
            tmPasosMs: Number(r.tm_pasos_ms || 0),
            tmPasosRaw: String(r.tm_pasos_raw || ""),
            label: String(r.label || ""),
            rowIndex: Number(r.row_index || 0),
          });
        }
      }

      for (const r of partsRes.rows) {
        const partId = String(r.id);
        const testId = String(r.test_id);
        const slots = csvsByPart.get(partId) || [];
        const part: TestPart = {
          id: partId,
          name: String(r.name),
          order: Number(r.sort_order || 0),
          combinedMode: Boolean(r.combined_mode),
          combinedScoring: r.combined_scoring
            ? (String(r.combined_scoring) as "time" | "laps")
            : undefined,
          expectedLaps: r.expected_laps == null ? null : Number(r.expected_laps),
          startOrderVs: parseStartOrderVs(r.start_order_vs),
          csvs: slots.map((s) => {
            const passages = passagesByUpload.get(s.uploadId) || [];
            const racePassages = raceByUpload.get(s.uploadId) || [];
            return {
              timingPointId: s.timingPointId,
              filename: s.filename,
              parsed: {
                filename: s.filename,
                passages,
                racePassages,
                flags: flagsByUpload.get(s.uploadId) || [],
              },
            };
          }),
        };
        // If is_race flags missing, fall back: racePassages = all passages (legacy dumps)
        for (const slot of part.csvs) {
          if (slot.parsed.racePassages.length === 0 && slot.parsed.passages.length > 0) {
            slot.parsed.racePassages = [...slot.parsed.passages];
          }
        }
        if (!partsByTest.has(testId)) partsByTest.set(testId, []);
        partsByTest.get(testId)!.push(part);
      }
    } else {
      for (const r of partsRes.rows) {
        const testId = String(r.test_id);
        if (!partsByTest.has(testId)) partsByTest.set(testId, []);
        partsByTest.get(testId)!.push({
          id: String(r.id),
          name: String(r.name),
          order: Number(r.sort_order || 0),
          combinedMode: Boolean(r.combined_mode),
          combinedScoring: r.combined_scoring
            ? (String(r.combined_scoring) as "time" | "laps")
            : undefined,
          expectedLaps: r.expected_laps == null ? null : Number(r.expected_laps),
          startOrderVs: parseStartOrderVs(r.start_order_vs),
          csvs: [],
        });
      }
    }
  }

  const tests: Test[] = testsRes.rows.map((r) => {
    const tid = String(r.id);
    return {
      id: tid,
      name: String(r.name),
      description: String(r.description ?? ""),
      showDescriptionInPdf: Boolean(r.show_description_in_pdf),
      order: Number(r.sort_order || 0),
      timingMode: (String(r.timing_mode || "point_to_point") as TestTimingMode),
      fromPointId: r.from_point_id ? String(r.from_point_id) : null,
      toPointId: r.to_point_id ? String(r.to_point_id) : null,
      startFinishPointId: r.start_finish_point_id
        ? String(r.start_finish_point_id)
        : null,
      partialPointIds: partialsByTest.get(tid) || [],
      parts: partsByTest.get(tid) || [],
      penalties: penaltiesByTest.get(tid) || [],
    };
  });

  const fusions: SavedFusion[] = [];
  for (const fr of fusionsRes.rows) {
    const fid = String(fr.id);
    const [ftRes, rowRes] = await Promise.all([
      q(
        pool,
        `SELECT * FROM fusion_tests WHERE fusion_id = $1 ORDER BY sort_order`,
        [fid]
      ),
      q(
        pool,
        `SELECT * FROM fusion_rows WHERE fusion_id = $1 ORDER BY position`,
        [fid]
      ),
    ]);
    const rowIds = rowRes.rows.map((r) => String(r.id));
    const timesByRow = new Map<string, FusionRow["byTest"]>();
    if (rowIds.length > 0) {
      const timesRes = await q(
        pool,
        `SELECT * FROM fusion_row_times WHERE fusion_row_id = ANY($1::uuid[])`,
        [rowIds]
      );
      for (const t of timesRes.rows) {
        const rid = String(t.fusion_row_id);
        if (!timesByRow.has(rid)) timesByRow.set(rid, []);
        timesByRow.get(rid)!.push({
          testId: String(t.test_id),
          testName: String(t.test_name || ""),
          segmentLabel: String(t.segment_label || ""),
          timeMs: t.time_ms == null ? null : Number(t.time_ms),
          timeFormatted: String(t.time_formatted || "—"),
          laps: t.laps == null ? undefined : Number(t.laps),
        });
      }
    }

    fusions.push({
      id: fid,
      name: String(fr.name),
      testIds: ftRes.rows.map((t) => String(t.test_id)),
      tests: ftRes.rows.map((t) => ({
        id: String(t.test_id),
        name: String(t.test_name),
        segmentLabel: String(t.segment_label || ""),
      })),
      rows: rowRes.rows.map((r) => ({
        position: Number(r.position),
        number: String(r.number),
        name: String(r.name || ""),
        category: String(r.category || ""),
        league: String(r.league || ""),
        totalTimeMs: Number(r.total_time_ms),
        totalTimeFormatted: String(r.total_time_formatted),
        testsCount: Number(r.tests_count || 0),
        byTest: timesByRow.get(String(r.id)) || [],
      })),
      warning: fr.warning == null ? null : String(fr.warning),
      createdAt: new Date(String(fr.created_at)).toISOString(),
    });
  }

  const resultsBoard: ResultsBoardEntry[] = boardRes.rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind) as "unified" | "fusion",
    refId: String(r.ref_id),
    partId: r.part_id ? String(r.part_id) : null,
    title: String(r.title),
    publishedAt: new Date(String(r.published_at)).toISOString(),
    order: Number(r.sort_order || 0),
  }));

  return {
    ...base,
    timingPoints,
    pilots,
    tests,
    fusions,
    resultsBoard,
  };
}

/** Lightweight part lookup for CSV upload — skips loading passages. */
export async function getPartUploadContext(
  eventId: string,
  testId: string,
  partId: string
): Promise<{
  eventId: string;
  testId: string;
  partId: string;
  partName: string;
  partOrder: number;
  combinedMode: boolean;
  combinedScoring: "time" | "laps" | undefined;
  expectedLaps: number | null;
  firstTimingPointId: string | null;
  csvSource: "auto" | "orbits4" | "orbits5";
} | null> {
  const r = await q(
    pool,
    `SELECT
       e.id AS event_id,
       e.csv_source,
       t.id AS test_id,
       p.id AS part_id,
       p.name AS part_name,
       p.sort_order AS part_order,
       p.combined_mode,
       p.combined_scoring,
       p.expected_laps,
       (
         SELECT tp.id
         FROM timing_points tp
         WHERE tp.event_id = e.id
         ORDER BY tp.sort_order
         LIMIT 1
       ) AS first_timing_point_id
     FROM test_parts p
     INNER JOIN tests t ON t.id = p.test_id
     INNER JOIN events e ON e.id = t.event_id
     WHERE e.id = $1 AND t.id = $2 AND p.id = $3`,
    [eventId, testId, partId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    eventId: String(row.event_id),
    testId: String(row.test_id),
    partId: String(row.part_id),
    partName: String(row.part_name || ""),
    partOrder: Number(row.part_order || 0),
    combinedMode: Boolean(row.combined_mode),
    combinedScoring: row.combined_scoring
      ? (String(row.combined_scoring) as "time" | "laps")
      : undefined,
    expectedLaps: row.expected_laps == null ? null : Number(row.expected_laps),
    firstTimingPointId: row.first_timing_point_id
      ? String(row.first_timing_point_id)
      : null,
    csvSource:
      row.csv_source === "orbits4" || row.csv_source === "orbits5"
        ? (row.csv_source as "orbits4" | "orbits5")
        : "auto",
  };
}

export async function listEventIds(): Promise<string[]> {
  const r = await q<{ id: string }>(
    pool,
    `SELECT id FROM events ORDER BY updated_at DESC`
  );
  return r.rows.map((row) => String(row.id));
}

export async function loadAllEvents(): Promise<Event[]> {
  const ids = await listEventIds();
  const events: Event[] = [];
  for (const id of ids) {
    const e = await loadEvent(id);
    if (e) events.push(e);
  }
  return events;
}
