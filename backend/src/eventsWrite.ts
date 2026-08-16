import { randomUUID } from "crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import type { Event, PartCsvSlot, Passage, StartOrderVsPair } from "./types.js";

type Q = pg.PoolClient;

async function q(client: Q, text: string, params?: unknown[]) {
  return client.query(text, params);
}

function uuidList(ids: string[]): string[] {
  return ids;
}

/** Single-round-trip insert of all passages (UNNEST) — critical on Render latency. */
async function insertPassagesBatch(
  client: Q,
  uploadId: string,
  passages: Passage[],
  racePassages: Passage[]
) {
  if (!passages.length) return;

  const raceKeys = new Set<string>();
  const raceByRowNum = new Set<string>();
  for (const r of racePassages || []) {
    const row = r.rowIndex ?? 0;
    const num = String(r.number ?? "");
    raceKeys.add(`${row}|${num}|${r.tmPasosMs ?? 0}`);
    raceByRowNum.add(`${row}|${num}`);
  }

  const uploadIds: string[] = [];
  const numbers: string[] = [];
  const names: string[] = [];
  const tmPasosMs: number[] = [];
  const tmPasosRaw: string[] = [];
  const lapTimeMs: (number | null)[] = [];
  const lapTimeRaw: string[] = [];
  const lapsCount: (number | null)[] = [];
  const elapsedMs: (number | null)[] = [];
  const clases: string[] = [];
  const rowIndexes: number[] = [];
  const isRaceFlags: boolean[] = [];

  for (const pass of passages) {
    const row = pass.rowIndex ?? 0;
    const num = String(pass.number ?? "");
    const key = `${row}|${num}|${pass.tmPasosMs ?? 0}`;
    const isRace = raceKeys.has(key) || raceByRowNum.has(`${row}|${num}`);
    uploadIds.push(uploadId);
    numbers.push(pass.number || "");
    names.push(pass.name || "");
    tmPasosMs.push(pass.tmPasosMs || 0);
    tmPasosRaw.push(pass.tmPasosRaw || "");
    lapTimeMs.push(pass.lapTimeMs ?? null);
    lapTimeRaw.push(pass.lapTimeRaw || "");
    lapsCount.push(pass.lapsCount ?? null);
    elapsedMs.push(pass.elapsedMs ?? null);
    clases.push(pass.clase || "");
    rowIndexes.push(row);
    isRaceFlags.push(isRace);
  }

  await q(
    client,
    `INSERT INTO csv_passages (
      csv_upload_id, number, name, tm_pasos_ms, tm_pasos_raw,
      lap_time_ms, lap_time_raw, laps_count, elapsed_ms, clase, row_index, is_race
    )
    SELECT * FROM UNNEST(
      $1::uuid[], $2::text[], $3::text[], $4::bigint[], $5::text[],
      $6::bigint[], $7::text[], $8::int[], $9::bigint[], $10::text[], $11::int[], $12::boolean[]
    )`,
    [
      uploadIds,
      numbers,
      names,
      tmPasosMs,
      tmPasosRaw,
      lapTimeMs,
      lapTimeRaw,
      lapsCount,
      elapsedMs,
      clases,
      rowIndexes,
      isRaceFlags,
    ]
  );
}

async function insertFlagsBatch(
  client: Q,
  uploadId: string,
  flags: { type?: string; tmPasosMs?: number; tmPasosRaw?: string; label?: string; rowIndex?: number }[]
) {
  if (!flags.length) return;
  const uploadIds = flags.map(() => uploadId);
  const types = flags.map((f) => f.type || "other");
  const tms = flags.map((f) => f.tmPasosMs || 0);
  const raws = flags.map((f) => f.tmPasosRaw || "");
  const labels = flags.map((f) => f.label || "");
  const rows = flags.map((f) => f.rowIndex || 0);
  await q(
    client,
    `INSERT INTO csv_flags (
      csv_upload_id, flag_type, tm_pasos_ms, tm_pasos_raw, label, row_index
    )
    SELECT * FROM UNNEST(
      $1::uuid[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::int[]
    )`,
    [uploadIds, types, tms, raws, labels, rows]
  );
}

async function writeCsvSlot(client: Q, partId: string, slot: PartCsvSlot): Promise<void> {
  const uploadId = randomUUID();
  const pilotNumber = String(slot.pilotNumber || "").trim() || null;
  const timingPointId =
    slot.timingPointId && /^[0-9a-f-]{36}$/i.test(slot.timingPointId)
      ? slot.timingPointId
      : null;
  await q(
    client,
    `INSERT INTO csv_uploads (id, part_id, timing_point_id, pilot_number, filename, uploaded_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [uploadId, partId, timingPointId, pilotNumber, slot.filename]
  );
  const parsed = slot.parsed || {
    filename: slot.filename,
    passages: [],
    racePassages: [],
    flags: [],
  };
  await insertPassagesBatch(
    client,
    uploadId,
    parsed.passages || [],
    parsed.racePassages || []
  );
  await insertFlagsBatch(client, uploadId, parsed.flags || []);
}

/**
 * Replace a single CSV slot (timing point) for a part.
 * Does NOT rewrite sibling slots — important when ARCO + CAJONES are uploaded separately.
 */
export async function upsertPartCsvSlot(partId: string, slot: PartCsvSlot): Promise<void> {
  const pilotNumber = String(slot.pilotNumber || "").trim();
  await withTransaction(async (client) => {
    if (pilotNumber) {
      await q(
        client,
        `DELETE FROM csv_uploads
         WHERE part_id = $1 AND lower(btrim(pilot_number)) = lower(btrim($2))`,
        [partId, pilotNumber]
      );
    } else {
      await q(
        client,
        `DELETE FROM csv_uploads
         WHERE part_id = $1
           AND timing_point_id IS NOT DISTINCT FROM $2
           AND pilot_number IS NULL`,
        [partId, slot.timingPointId]
      );
    }
    await writeCsvSlot(client, partId, slot);
  });
}

/** Persist VS start-order pairs without a full event rewrite. */
export async function updatePartStartOrderVs(
  partId: string,
  pairs: StartOrderVsPair[]
): Promise<void> {
  await pool.query(
    `UPDATE test_parts SET start_order_vs = $1::jsonb WHERE id = $2`,
    [JSON.stringify(pairs || []), partId]
  );
}

/** On/Off for overlay data polling without rewriting the whole event. */
export async function updateOverlayControl(
  eventId: string,
  patch: {
    overlayLiveRefresh?: boolean;
    overlayPagingMode?: "auto" | "manual";
    overlayPilotPage?: number;
    overlayLapPage?: number;
  }
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [eventId];
  let i = 2;
  if (patch.overlayLiveRefresh !== undefined) {
    sets.push(`overlay_live_refresh = $${i++}`);
    params.push(Boolean(patch.overlayLiveRefresh));
  }
  if (patch.overlayPagingMode !== undefined) {
    sets.push(`overlay_paging_mode = $${i++}`);
    params.push(patch.overlayPagingMode === "manual" ? "manual" : "auto");
  }
  if (patch.overlayPilotPage !== undefined) {
    sets.push(`overlay_pilot_page = $${i++}`);
    params.push(Math.max(0, Math.floor(Number(patch.overlayPilotPage) || 0)));
  }
  if (patch.overlayLapPage !== undefined) {
    sets.push(`overlay_lap_page = $${i++}`);
    params.push(Math.max(0, Math.floor(Number(patch.overlayLapPage) || 0)));
  }
  if (sets.length === 1) return;
  await pool.query(`UPDATE events SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function updateOverlayLiveRefresh(
  eventId: string,
  live: boolean
): Promise<void> {
  await updateOverlayControl(eventId, { overlayLiveRefresh: live });
}

export async function updatePublishedStartOrder(
  eventId: string,
  published: { testId: string; partId: string } | null
): Promise<void> {
  await pool.query(
    `UPDATE events
     SET published_start_order_test_id = $2,
         published_start_order_part_id = $3,
         updated_at = now()
     WHERE id = $1`,
    [eventId, published?.testId ?? null, published?.partId ?? null]
  );
}

/** Update combined-mode flags without a full event persist. */
export async function updatePartCsvMeta(
  partId: string,
  meta: {
    combinedMode?: boolean;
    csvInputMode?: string | null;
    combinedScoring?: string | null;
    expectedLaps?: number | null;
  }
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (meta.combinedMode !== undefined) {
    sets.push(`combined_mode = $${i++}`);
    params.push(Boolean(meta.combinedMode));
  }
  if (meta.csvInputMode !== undefined) {
    sets.push(`csv_input_mode = $${i++}`);
    params.push(meta.csvInputMode);
  }
  if (meta.combinedScoring !== undefined) {
    sets.push(`combined_scoring = $${i++}`);
    params.push(meta.combinedScoring);
  }
  if (meta.expectedLaps !== undefined) {
    sets.push(`expected_laps = $${i++}`);
    params.push(meta.expectedLaps);
  }
  if (!sets.length) return;
  params.push(partId);
  await pool.query(
    `UPDATE test_parts SET ${sets.join(", ")} WHERE id = $${i}`,
    params
  );
}

/**
 * Replace all CSV slots for one part (used when clearing/rebuilding a part).
 */
export async function replacePartCsvs(partId: string, csvs: PartCsvSlot[]): Promise<void> {
  await withTransaction(async (client) => {
    await q(client, `DELETE FROM csv_uploads WHERE part_id = $1`, [partId]);
    for (const slot of csvs || []) {
      await writeCsvSlot(client, partId, slot);
    }
  });
}

/**
 * Upsert event structure WITHOUT rewriting CSV passages.
 * This is the hot path (penalties, meta, pilots, board, etc.).
 */
export async function persistEvent(event: Event): Promise<Event> {
  event.updatedAt = new Date().toISOString();
  if (!event.createdAt) event.createdAt = event.updatedAt;
  const theme = event.themeColors?.length ? event.themeColors : null;

  await withTransaction(async (client) => {
    await q(
      client,
      `INSERT INTO events (
        id, name, event_date, location, header_image, footer_text, password,
        theme_colors, board_page_seconds, overlay_variant, overlay_timing, csv_source,
        overlay_live_refresh,
        published_start_order_test_id, published_start_order_part_id,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        event_date = EXCLUDED.event_date,
        location = EXCLUDED.location,
        header_image = EXCLUDED.header_image,
        footer_text = EXCLUDED.footer_text,
        password = EXCLUDED.password,
        theme_colors = EXCLUDED.theme_colors,
        board_page_seconds = EXCLUDED.board_page_seconds,
        overlay_variant = EXCLUDED.overlay_variant,
        overlay_timing = EXCLUDED.overlay_timing,
        csv_source = EXCLUDED.csv_source,
        overlay_live_refresh = EXCLUDED.overlay_live_refresh,
        published_start_order_test_id = EXCLUDED.published_start_order_test_id,
        published_start_order_part_id = EXCLUDED.published_start_order_part_id,
        updated_at = EXCLUDED.updated_at`,
      [
        event.id,
        event.name,
        event.date || "",
        event.location || "",
        event.headerImage,
        event.footerText || "Minerva Timing",
        event.password,
        theme,
        Math.min(120, Math.max(3, Math.round(event.boardPageSeconds ?? 10))),
        event.overlayVariant === "redbull" || event.overlayVariant === "ponymalta"
          ? event.overlayVariant
          : "classic",
        event.overlayTiming === "total" ? "total" : "splits",
        event.csvSource === "orbits4" || event.csvSource === "orbits5"
          ? event.csvSource
          : "auto",
        event.overlayLiveRefresh !== false,
        event.publishedStartOrder?.testId ?? null,
        event.publishedStartOrder?.partId ?? null,
        event.createdAt,
        event.updatedAt,
      ]
    );

    // Avoid UNIQUE(event_id, sort_order) clashes while reordering
    await q(
      client,
      `UPDATE timing_points SET sort_order = sort_order - 100000 WHERE event_id = $1 AND sort_order >= 0`,
      [event.id]
    );

    for (let i = 0; i < (event.timingPoints || []).length; i++) {
      const p = event.timingPoints[i];
      p.order = i;
      await q(
        client,
        `INSERT INTO timing_points (id, event_id, name, offset_ms, sort_order, role)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           offset_ms = EXCLUDED.offset_ms,
           sort_order = EXCLUDED.sort_order,
           role = EXCLUDED.role`,
        [p.id, event.id, p.name, p.offsetMs || 0, i, p.role ?? null]
      );
    }
    const pointIds = uuidList((event.timingPoints || []).map((p) => p.id));
    await q(
      client,
      `DELETE FROM timing_points WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [event.id, pointIds]
    );

    for (const p of event.pilots || []) {
      await q(
        client,
        `INSERT INTO pilots (id, event_id, number, name, category, league, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           number = EXCLUDED.number,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           league = EXCLUDED.league,
           notes = EXCLUDED.notes`,
        [
          p.id,
          event.id,
          p.number,
          p.name || "",
          p.category || "",
          p.league || "",
          p.notes || "",
        ]
      );
    }
    await q(
      client,
      `DELETE FROM pilots WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [event.id, uuidList((event.pilots || []).map((p) => p.id))]
    );

    await q(
      client,
      `UPDATE tests SET sort_order = sort_order - 100000 WHERE event_id = $1 AND sort_order >= 0`,
      [event.id]
    );

    for (let ti = 0; ti < (event.tests || []).length; ti++) {
      const t = event.tests[ti];
      t.order = ti;
      await q(
        client,
        `INSERT INTO tests (
          id, event_id, name, description, show_description_in_pdf, sort_order,
          timing_mode, from_point_id, to_point_id, start_finish_point_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          show_description_in_pdf = EXCLUDED.show_description_in_pdf,
          sort_order = EXCLUDED.sort_order,
          timing_mode = EXCLUDED.timing_mode,
          from_point_id = EXCLUDED.from_point_id,
          to_point_id = EXCLUDED.to_point_id,
          start_finish_point_id = EXCLUDED.start_finish_point_id`,
        [
          t.id,
          event.id,
          t.name,
          t.description || "",
          Boolean(t.showDescriptionInPdf),
          ti,
          t.timingMode || "point_to_point",
          t.fromPointId || null,
          t.toPointId || null,
          t.startFinishPointId || t.fromPointId || null,
        ]
      );

      await q(client, `DELETE FROM test_partial_points WHERE test_id = $1`, [t.id]);
      const partials =
        t.partialPointIds && t.partialPointIds.length
          ? t.partialPointIds
          : t.toPointId
            ? [t.toPointId]
            : [];
      for (let i = 0; i < partials.length; i++) {
        await q(
          client,
          `INSERT INTO test_partial_points (test_id, event_id, timing_point_id, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [t.id, event.id, partials[i], i]
        );
      }

      await q(
        client,
        `UPDATE test_parts SET sort_order = sort_order - 100000
         WHERE test_id = $1 AND sort_order >= 0`,
        [t.id]
      );

      for (let pi = 0; pi < (t.parts || []).length; pi++) {
        const part = t.parts[pi];
        part.order = pi;
        const scoring =
          part.csvInputMode === "combined" || part.combinedMode
            ? part.combinedScoring || "time"
            : part.csvInputMode === "pilots"
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
        await q(
          client,
          `INSERT INTO test_parts (
            id, test_id, event_id, name, sort_order, combined_mode, csv_input_mode, combined_scoring,
            expected_laps, start_order_vs
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            sort_order = EXCLUDED.sort_order,
            combined_mode = EXCLUDED.combined_mode,
            csv_input_mode = EXCLUDED.csv_input_mode,
            combined_scoring = EXCLUDED.combined_scoring,
            expected_laps = EXCLUDED.expected_laps,
            start_order_vs = EXCLUDED.start_order_vs`,
          [
            part.id,
            t.id,
            event.id,
            part.name,
            pi,
            Boolean(part.combinedMode),
            csvMode,
            scoring,
            part.expectedLaps ?? null,
            JSON.stringify(part.startOrderVs || []),
          ]
        );
      }
      await q(
        client,
        `DELETE FROM test_parts WHERE test_id = $1 AND NOT (id = ANY($2::uuid[]))`,
        [t.id, uuidList((t.parts || []).map((p) => p.id))]
      );

      await q(client, `DELETE FROM test_penalties WHERE test_id = $1`, [t.id]);
      for (const pen of t.penalties || []) {
        await q(
          client,
          `INSERT INTO test_penalties (
            test_id, pilot_number, scope, time_penalty_ms, position_penalty, comment
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            t.id,
            pen.number,
            pen.scope || "shared",
            pen.timePenaltyMs || 0,
            pen.positionPenalty || 0,
            pen.comment || "",
          ]
        );
      }
    }

    await q(
      client,
      `DELETE FROM tests WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [event.id, uuidList((event.tests || []).map((t) => t.id))]
    );

    await q(client, `DELETE FROM fusions WHERE event_id = $1`, [event.id]);
    for (const fus of event.fusions || []) {
      await q(
        client,
        `INSERT INTO fusions (id, event_id, name, warning, created_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz)`,
        [
          fus.id,
          event.id,
          fus.name,
          fus.warning ?? null,
          fus.createdAt || new Date().toISOString(),
        ]
      );
      for (let i = 0; i < (fus.tests || []).length; i++) {
        const ft = fus.tests[i];
        await q(
          client,
          `INSERT INTO fusion_tests (fusion_id, test_id, test_name, segment_label, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [fus.id, ft.id, ft.name, ft.segmentLabel || "", i]
        );
      }
      for (const row of fus.rows || []) {
        const rowId = randomUUID();
        await q(
          client,
          `INSERT INTO fusion_rows (
            id, fusion_id, position, number, name, category, league,
            total_time_ms, total_time_formatted, tests_count
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            rowId,
            fus.id,
            row.position,
            row.number,
            row.name || "",
            row.category || "",
            row.league || "",
            row.totalTimeMs,
            row.totalTimeFormatted,
            row.testsCount || 0,
          ]
        );
        for (const bt of row.byTest || []) {
          await q(
            client,
            `INSERT INTO fusion_row_times (
              fusion_row_id, test_id, test_name, segment_label, time_ms, time_formatted, laps
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              rowId,
              bt.testId,
              bt.testName || "",
              bt.segmentLabel || "",
              bt.timeMs,
              bt.timeFormatted || "—",
              bt.laps ?? null,
            ]
          );
        }
      }
    }

    await q(client, `DELETE FROM results_board WHERE event_id = $1`, [event.id]);
    for (let i = 0; i < (event.resultsBoard || []).length; i++) {
      const b = event.resultsBoard[i];
      b.order = i;
      await q(
        client,
        `INSERT INTO results_board (
          id, event_id, kind, ref_id, part_id, title, published_at, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8)`,
        [
          b.id,
          event.id,
          b.kind,
          b.refId,
          b.partId ?? null,
          b.title,
          b.publishedAt || new Date().toISOString(),
          i,
        ]
      );
    }
  });

  return event;
}

export async function removeEvent(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM events WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
