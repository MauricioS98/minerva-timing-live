import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import {
  deleteEvent,
  getEvent,
  getPartUploadContext,
  HEADERS_DIR,
  listEvents,
  publicEvent,
  saveEvent,
  savePartCsvSlot,
  savePartStartOrderVs,
  savePublishedStartOrder,
  verifyEventPassword,
  DEFAULT_EVENT_PASSWORD,
} from "./storage.js";
import type {
  Event,
  FusionRow,
  FusionTestMeta,
  Pilot,
  ResultRow,
  ResultsBoardEntry,
  StartOrderVsPair,
  Test,
  TestPart,
  TestTimingMode,
  TimingPoint,
} from "./types.js";

function sanitizeStartOrderVs(raw: unknown): StartOrderVsPair[] {
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
import { parseOffsetToMs, formatOffset } from "./timeUtils.js";
import { parseTimingCsv } from "./csvParser.js";
import {
  assertCanDeleteEvent,
  assertCanDeletePart,
  assertCanDeleteTest,
} from "./guards.js";
import { computeFusionResults } from "./fusion.js";
import {
  computeLapByLapResults,
  computePartResults,
  computeTestResults,
  filterNewPilotsVsEarlier,
  getPart,
  getTest,
  isLapScoringPart,
  resolveTestTimingPoints,
  upsertPenalty,
} from "./results.js";
import { fusionToCsv, fusionToExcel, fusionToPdf, lapByLapToPdf, lapByLapWithHoursToPdf, resultsToCsv, resultsToExcel, resultsToPdf } from "./export.js";
import { importPilotsFromCsv, previewPilotsCsv, type ColumnMapping } from "./pilotsCsv.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = Router();

/** Valida 4 colores hex (#rrggbb); si no son válidos devuelve null (paleta Minerva por defecto) */
function sanitizeThemeColors(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const colors = value.map((c) => String(c).trim().toLowerCase());
  if (!colors.every((c) => /^#[0-9a-f]{6}$/.test(c))) return null;
  return colors;
}

function emptyEvent(body: Partial<Event> & { password?: string }): Event {
  const now = new Date().toISOString();
  const password = String(body.password || "").trim();
  if (!password) {
    throw new Error("La contraseña del evento es obligatoria");
  }
  if (!/^[a-zA-Z0-9]+$/.test(password)) {
    throw new Error("La contraseña solo puede contener letras y números");
  }
  return {
    id: uuid(),
    name: body.name || "Nuevo evento",
    date: body.date || "",
    location: body.location || "",
    headerImage: null,
    footerText: body.footerText || "Minerva Timing",
    password,
    themeColors: sanitizeThemeColors(body.themeColors),
    timingPoints: [
      { id: uuid(), name: "PC A", offsetMs: 0, order: 0, role: "start_finish" },
      { id: uuid(), name: "PC B", offsetMs: 0, order: 1, role: "partial" },
    ],
    pilots: [],
    tests: [],
    fusions: [],
    resultsBoard: [],
    boardPageSeconds: 10,
    overlayVariant: "classic",
    overlayTiming: "splits",
    csvSource: "auto",
    publishedStartOrder: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeOverlayVariant(value: unknown): "classic" | "redbull" | "ponymalta" {
  if (value === "redbull" || value === "ponymalta") return value;
  return "classic";
}

function sanitizeOverlayTiming(value: unknown): "splits" | "total" {
  return value === "total" ? "total" : "splits";
}

function sanitizeCsvSource(value: unknown): "auto" | "orbits4" | "orbits5" {
  if (value === "orbits4" || value === "orbits5") return value;
  return "auto";
}

// ─── Events ───────────────────────────────────────────────
router.get("/events", async (_req, res) => {
  res.json((await listEvents()).map(publicEvent));
});

router.get("/events/:id", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  res.json(publicEvent(event));
});

router.post("/events", async (req, res) => {
  try {
    const event = emptyEvent(req.body || {});
    await saveEvent(event);
    res.status(201).json(publicEvent(event));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Error al crear evento" });
  }
});

router.post("/events/:id/auth", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const password = String(req.body?.password ?? "");
  if (!verifyEventPassword(event, password)) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  res.json({ ok: true });
});

router.put("/events/:id", async (req, res) => {
  const existing = await getEvent(req.params.id);
  if (!existing) return res.status(404).json({ error: "Evento no encontrado" });

  let nextPassword = existing.password || DEFAULT_EVENT_PASSWORD;
  if (req.body.password != null && String(req.body.password).trim() !== "") {
    const candidate = String(req.body.password).trim();
    if (!/^[a-zA-Z0-9]+$/.test(candidate)) {
      return res.status(400).json({ error: "La contraseña solo puede contener letras y números" });
    }
    nextPassword = candidate;
  }

  const updated: Event = {
    ...existing,
    name: req.body.name ?? existing.name,
    date: req.body.date ?? existing.date,
    location: req.body.location ?? existing.location,
    footerText: req.body.footerText ?? existing.footerText,
    password: nextPassword,
    boardPageSeconds:
      req.body.boardPageSeconds != null
        ? Math.min(120, Math.max(3, Math.round(Number(req.body.boardPageSeconds)) || 10))
        : existing.boardPageSeconds ?? 10,
    overlayVariant:
      req.body.overlayVariant !== undefined
        ? sanitizeOverlayVariant(req.body.overlayVariant)
        : existing.overlayVariant === "redbull" || existing.overlayVariant === "ponymalta"
          ? existing.overlayVariant
          : "classic",
    overlayTiming:
      req.body.overlayTiming !== undefined
        ? sanitizeOverlayTiming(req.body.overlayTiming)
        : existing.overlayTiming === "total"
          ? "total"
          : "splits",
    csvSource:
      req.body.csvSource !== undefined
        ? sanitizeCsvSource(req.body.csvSource)
        : existing.csvSource === "orbits4" || existing.csvSource === "orbits5"
          ? existing.csvSource
          : "auto",
    themeColors:
      req.body.themeColors === undefined
        ? existing.themeColors ?? null
        : sanitizeThemeColors(req.body.themeColors),
  };
  await saveEvent(updated);
  res.json(publicEvent(updated));
});

router.delete("/events/:id", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const block = assertCanDeleteEvent(event);
  if (block) return res.status(409).json({ error: block });
  if (!await deleteEvent(req.params.id)) return res.status(404).json({ error: "Evento no encontrado" });
  res.json({ ok: true });
});

router.post("/events/:id/header", upload.single("image"), async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  if (!req.file) return res.status(400).json({ error: "Imagen requerida" });

  const ext = path.extname(req.file.originalname).toLowerCase() || ".png";
  const filename = `${event.id}${ext}`;
  const dest = path.join(HEADERS_DIR, filename);
  fs.writeFileSync(dest, req.file.buffer);
  event.headerImage = filename;
  await saveEvent(event);
  res.json(publicEvent(event));
});

// ─── Timing points ────────────────────────────────────────
router.put("/events/:id/timing-points", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const points: TimingPoint[] = (req.body.timingPoints || []).map(
    (p: Partial<TimingPoint> & { offset?: string }, i: number) => ({
      id: p.id || uuid(),
      name: p.name || `PC ${String.fromCharCode(65 + i)}`,
      offsetMs:
        typeof p.offsetMs === "number"
          ? p.offsetMs
          : parseOffsetToMs(p.offset || "0"),
      order: typeof p.order === "number" ? p.order : i,
      role: p.role || "generic",
    })
  );

  // First point is always reference (offset 0)
  if (points.length > 0) {
    points.sort((a, b) => a.order - b.order);
    points[0].offsetMs = 0;
  }

  event.timingPoints = points;
  await saveEvent(event);
  res.json({
    ...publicEvent(event),
    timingPoints: event.timingPoints.map((p) => ({
      ...p,
      offsetFormatted: formatOffset(p.offsetMs),
    })),
  });
});

// ─── Tests & parts ────────────────────────────────────────
router.post("/events/:id/tests", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const test: Test = {
    id: uuid(),
    name: req.body.name || `Prueba ${event.tests.length + 1}`,
    description: req.body.description || "",
    showDescriptionInPdf: Boolean(req.body.showDescriptionInPdf),
    order: event.tests.length,
    timingMode: "point_to_point",
    fromPointId: event.timingPoints[0]?.id ?? null,
    toPointId: event.timingPoints[1]?.id ?? null,
    startFinishPointId: event.timingPoints[0]?.id ?? null,
    partialPointIds: event.timingPoints[1]?.id ? [event.timingPoints[1].id] : [],
    parts: [],
    penalties: [],
  };
  event.tests.push(test);
  await saveEvent(event);
  res.status(201).json(test);
});

router.put("/events/:id/tests/:testId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });
  if (req.body.name != null) test.name = req.body.name;
  if (req.body.description != null) test.description = String(req.body.description);
  if (req.body.showDescriptionInPdf != null) {
    test.showDescriptionInPdf = Boolean(req.body.showDescriptionInPdf);
  }
  if (req.body.fromPointId !== undefined) {
    test.fromPointId = req.body.fromPointId || null;
  }
  if (req.body.toPointId !== undefined) {
    test.toPointId = req.body.toPointId || null;
  }
  if (req.body.timingMode !== undefined) {
    const mode: TestTimingMode =
      req.body.timingMode === "start_finish_partial" ? "start_finish_partial" : "point_to_point";
    test.timingMode = mode;
  }
  if (req.body.startFinishPointId !== undefined) {
    test.startFinishPointId = req.body.startFinishPointId || null;
  }
  if (req.body.partialPointIds !== undefined) {
    test.partialPointIds = Array.isArray(req.body.partialPointIds)
      ? req.body.partialPointIds.map(String).filter(Boolean)
      : [];
  }
  // Backfill for older events
  if (test.description == null) test.description = "";
  if (test.showDescriptionInPdf == null) test.showDescriptionInPdf = false;
  if (!test.timingMode) test.timingMode = "point_to_point";
  await saveEvent(event);
  res.json(test);
});

router.delete("/events/:id/tests/:testId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });
  const block = assertCanDeleteTest(event, test);
  if (block) return res.status(409).json({ error: block });
  event.tests = event.tests.filter((t) => t.id !== req.params.testId);
  event.resultsBoard = (event.resultsBoard || []).filter(
    (e) => !(e.kind === "unified" && e.refId === req.params.testId)
  );
  await saveEvent(event);
  res.json({ ok: true });
});

router.post("/events/:id/tests/:testId/parts", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });

  const part: TestPart = {
    id: uuid(),
    name: req.body.name || `Salida ${test.parts.length + 1}`,
    order: test.parts.length,
    combinedMode: Boolean(req.body.combinedMode),
    combinedScoring: req.body.combinedMode ? req.body.combinedScoring || "time" : undefined,
    expectedLaps:
      req.body.combinedMode && req.body.combinedScoring === "laps"
        ? req.body.expectedLaps === undefined || req.body.expectedLaps === ""
          ? null
          : Number(req.body.expectedLaps)
        : null,
    startOrderVs: [],
    csvs: [],
  };
  test.parts.push(part);
  await saveEvent(event);
  res.status(201).json(part);
});

router.put("/events/:id/tests/:testId/parts/:partId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });
  const part = getPart(test, req.params.partId);
  if (!part) return res.status(404).json({ error: "Parte no encontrada" });

  if (req.body.name != null) part.name = req.body.name;
  if (req.body.combinedMode != null) {
    part.combinedMode = Boolean(req.body.combinedMode);
    if (!part.combinedMode) {
      part.combinedScoring = undefined;
      part.expectedLaps = null;
    }
  }
  if (req.body.combinedScoring != null) {
    part.combinedScoring = req.body.combinedScoring === "laps" ? "laps" : "time";
    if (part.combinedScoring !== "laps") part.expectedLaps = null;
  }
  if (req.body.expectedLaps !== undefined) {
    const raw = req.body.expectedLaps;
    part.expectedLaps =
      raw === null || raw === "" || raw === "indeterminate" ? null : Number(raw);
  }

  // VS start-order: light persist (no full event rewrite / CSV reload)
  if (req.body.startOrderVs !== undefined) {
    part.startOrderVs = sanitizeStartOrderVs(req.body.startOrderVs);
    await savePartStartOrderVs(event.id, part.id, part.startOrderVs);
    // If only startOrderVs changed, skip heavy saveEvent
    const onlyVs =
      req.body.name == null &&
      req.body.combinedMode == null &&
      req.body.combinedScoring == null &&
      req.body.expectedLaps === undefined;
    if (onlyVs) return res.json(part);
  }

  await saveEvent(event);
  res.json(part);
});

/** Light payload for Orden de salida overlay (no CSV passages). */
router.get("/events/:id/orden-salida", async (req, res) => {
  const event = await getEvent(String(req.params.id));
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  res.json({
    event: {
      id: event.id,
      name: event.name,
      overlayVariant:
        event.overlayVariant === "redbull" || event.overlayVariant === "ponymalta"
          ? event.overlayVariant
          : "classic",
      boardPageSeconds: event.boardPageSeconds ?? 10,
      publishedStartOrder: event.publishedStartOrder ?? null,
    },
    pilots: (event.pilots || []).map((p) => ({
      number: p.number,
      name: p.name || "",
    })),
    tests: (event.tests || [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        id: t.id,
        name: t.name,
        parts: (t.parts || [])
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((p) => ({
            id: p.id,
            name: p.name,
            order: p.order,
            startOrderVs: p.startOrderVs || [],
          })),
      })),
  });
});

/** Publish one Orden de salida (replaces any previously published). */
router.post("/events/:id/orden-salida/publish", async (req, res) => {
  const event = await getEvent(String(req.params.id));
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const testId = String(req.body?.testId || "");
  const partId = String(req.body?.partId || "");
  const test = getTest(event, testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });
  const part = getPart(test, partId);
  if (!part) return res.status(404).json({ error: "Parte no encontrada" });
  if (!(part.startOrderVs || []).length) {
    return res.status(400).json({ error: "Esta salida no tiene enfrentamientos VS" });
  }
  await savePublishedStartOrder(event.id, { testId, partId });
  res.json({ publishedStartOrder: { testId, partId } });
});

/** Clear the published Orden de salida. */
router.delete("/events/:id/orden-salida/publish", async (req, res) => {
  const event = await getEvent(String(req.params.id));
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  await savePublishedStartOrder(event.id, null);
  res.json({ publishedStartOrder: null });
});

router.delete("/events/:id/tests/:testId/parts/:partId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });
  const part = getPart(test, req.params.partId);
  if (!part) return res.status(404).json({ error: "Parte no encontrada" });
  const block = assertCanDeletePart(event, test, part);
  if (block) return res.status(409).json({ error: block });
  test.parts = test.parts.filter((p) => p.id !== req.params.partId);
  await saveEvent(event);
  res.json({ ok: true });
});

// ─── CSV upload ───────────────────────────────────────────
router.post(
  "/events/:id/tests/:testId/parts/:partId/csv",
  upload.single("file"),
  async (req, res) => {
    // Light lookup only — full getEvent() reloads every CSV passage and was the bottleneck.
    const ctx = await getPartUploadContext(
      String(req.params.id),
      String(req.params.testId),
      String(req.params.partId)
    );
    if (!ctx) return res.status(404).json({ error: "Parte no encontrada" });
    if (!req.file) return res.status(400).json({ error: "Archivo CSV requerido" });

    const timingPointId = String(req.body.timingPointId || "");
    if (!timingPointId && !ctx.combinedMode) {
      return res.status(400).json({ error: "timingPointId requerido" });
    }

    const content = req.file.buffer;
    const preference =
      req.body.csvSource === "orbits4" ||
      req.body.csvSource === "orbits5" ||
      req.body.csvSource === "auto"
        ? req.body.csvSource
        : ctx.csvSource;
    const parsed = parseTimingCsv(content, req.file.originalname, preference);

    const slotId = ctx.combinedMode
      ? ctx.firstTimingPointId || timingPointId || "combined"
      : timingPointId;

    const slot = {
      timingPointId: slotId,
      filename: req.file.originalname,
      parsed,
    };

    let combinedMode = ctx.combinedMode;
    let combinedScoring = ctx.combinedScoring;
    let metaChanged = false;
    const hasLaps = parsed.racePassages.some((p) => p.lapTimeMs != null && p.lapTimeMs > 0);
    if (hasLaps && req.body.combinedMode === "true" && !combinedMode) {
      combinedMode = true;
      combinedScoring = combinedScoring ?? "time";
      metaChanged = true;
    }

    await savePartCsvSlot(
      ctx.eventId,
      ctx.partId,
      slot,
      metaChanged
        ? {
            combinedMode,
            combinedScoring: combinedScoring ?? null,
            expectedLaps: ctx.expectedLaps ?? null,
          }
        : undefined
    );

    // Slim slot for the client: race rows + flags are enough for UI/guards.
    // Full passages stay in DB (and in server cache via savePartCsvSlot).
    res.json({
      slot: {
        timingPointId: slot.timingPointId,
        filename: slot.filename,
        parsed: {
          filename: parsed.filename,
          passages: parsed.racePassages,
          racePassages: parsed.racePassages,
          flags: parsed.flags,
          sourceFormat: parsed.sourceFormat,
          deletedSkipped: parsed.deletedSkipped,
        },
      },
      partMeta: {
        id: ctx.partId,
        name: ctx.partName,
        order: ctx.partOrder,
        combinedMode,
        combinedScoring,
        expectedLaps: ctx.expectedLaps,
      },
      summary: {
        filename: parsed.filename,
        pilots: parsed.racePassages.length,
        uniquePilots: new Set(parsed.racePassages.map((p) => p.number)).size,
        sourceFormat: parsed.sourceFormat,
        deletedSkipped: parsed.deletedSkipped || 0,
        flags: parsed.flags.map((f) => ({ type: f.type, label: f.label, time: f.tmPasosRaw })),
      },
    });
  }
);

// ─── Results ──────────────────────────────────────────────
router.get("/events/:id/tests/:testId/results", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });

  const fromPointId = req.query.from as string | undefined;
  const toPointId = req.query.to as string | undefined;
  const partId = req.query.partId as string | undefined;
  const { fromId, toId } = resolveTestTimingPoints(event, test, fromPointId, toPointId);

  let rows;
  let warning: string | undefined;
  let scope: string;
  let title: string;
  let diffNote: string | undefined;
  if (partId) {
    const part = getPart(test, partId);
    if (!part) return res.status(404).json({ error: "Parte no encontrada" });
    ({ rows, warning, scope } = computePartResults(event, test, part, fromId, toId));
    const diff = filterNewPilotsVsEarlier(event, test, part, rows, fromId, toId);
    rows = diff.rows;
    diffNote = diff.diffNote;
    title = `${test.name} — ${part.name}`;
  } else {
    ({ rows, warning, scope } = computeTestResults(event, test, fromId, toId));
    title = `${test.name} — Resultado unificado`;
  }

  res.json({
    title,
    rows,
    warning: warning || null,
    diffNote: diffNote || null,
    scope,
    eventName: event.name,
  });
});

router.get("/events/:id/fusion", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const raw = req.query.tests;
  const testIds = Array.isArray(raw)
    ? raw.flatMap((v) => String(v).split(","))
    : String(raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const result = computeFusionResults(event, testIds);
  res.json({
    ...result,
    warning: result.warning || null,
    eventName: event.name,
  });
});

function parseFusionTestIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendFusionExport(
  res: import("express").Response,
  event: Event,
  fusionName: string,
  tests: { id: string; name: string; segmentLabel: string }[],
  rows: import("./types.js").FusionRow[],
  format: string
) {
  const title = fusionName;
  const safeName = title.replace(/[^\w\-]+/g, "_");

  if (format === "csv") {
    const csv = fusionToCsv(rows, tests, title);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.csv"`);
    return res.send("\uFEFF" + csv);
  }
  if (format === "xlsx" || format === "excel") {
    const buf = await fusionToExcel(rows, tests, title, event.name);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
    return res.send(buf);
  }
  if (format === "pdf") {
    const buf = await fusionToPdf(rows, tests, title, event);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    return res.send(buf);
  }
  return res.status(400).json({ error: "Formato no soportado (csv|xlsx|pdf)" });
}

router.get("/events/:id/fusion/export/:format", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const testIds = parseFusionTestIds(req.query.tests);
  const result = computeFusionResults(event, testIds);
  if (result.rows.length === 0) {
    return res.status(400).json({ error: result.warning || "Sin resultados para exportar" });
  }

  const name = String(req.query.name || result.title).trim() || result.title;

  try {
    return await sendFusionExport(res, event, name, result.tests, result.rows, req.params.format);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error al exportar" });
  }
});

router.post("/events/:id/fusions", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Indica un nombre para la fusión" });

  const testIds = parseFusionTestIds(req.body.testIds);
  const result = computeFusionResults(event, testIds);
  if (result.rows.length === 0) {
    return res.status(400).json({ error: result.warning || "Sin resultados para guardar" });
  }

  if (!event.fusions) event.fusions = [];
  const saved = {
    id: uuid(),
    name,
    testIds: result.tests.map((t) => t.id),
    tests: result.tests,
    rows: result.rows,
    warning: result.warning || null,
    createdAt: new Date().toISOString(),
  };
  event.fusions.push(saved);
  await saveEvent(event);
  res.status(201).json(saved);
});

router.delete("/events/:id/fusions/:fusionId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const before = event.fusions?.length || 0;
  event.fusions = (event.fusions || []).filter((f) => f.id !== req.params.fusionId);
  if (event.fusions.length === before) {
    return res.status(404).json({ error: "Fusión no encontrada" });
  }
  event.resultsBoard = (event.resultsBoard || []).filter(
    (e) => !(e.kind === "fusion" && e.refId === req.params.fusionId)
  );
  await saveEvent(event);
  res.json({ ok: true });
});

// ─── Public results board ─────────────────────────────────
type BoardSection = {
  entry: ResultsBoardEntry;
  kind: "unified" | "fusion";
  title: string;
  rows: ReturnType<typeof computeTestResults>["rows"] | FusionRow[];
  warning: string | null;
  tests: FusionTestMeta[] | null;
  /** True when this section is classified by laps then total time (not last lap). */
  lapScoring: boolean;
};

function sectionLapScoring(test: Test, part?: TestPart | null): boolean {
  if (part) return isLapScoringPart(part);
  return test.parts.some((p) => isLapScoringPart(p));
}

function buildBoardSections(event: Event): BoardSection[] {
  const board = [...(event.resultsBoard || [])].sort((a, b) => a.order - b.order);
  const sections: BoardSection[] = [];

  for (const entry of board) {
    if (entry.kind === "unified") {
      const test = getTest(event, entry.refId);
      if (!test) continue;
      const { fromId, toId } = resolveTestTimingPoints(event, test);
      if (entry.partId) {
        const part = getPart(test, entry.partId);
        if (!part) continue;
        const { rows, warning } = computePartResults(event, test, part, fromId, toId);
        sections.push({
          entry,
          kind: "unified",
          title: entry.title || `${test.name} — ${part.name}`,
          rows: rows.filter((r) => !r.incomplete),
          warning: warning || null,
          tests: null,
          lapScoring: sectionLapScoring(test, part),
        });
      } else {
        const { rows, warning } = computeTestResults(event, test, fromId, toId);
        sections.push({
          entry,
          kind: "unified",
          title: entry.title || `${test.name} — Resultado unificado`,
          rows: rows.filter((r) => !r.incomplete),
          warning: warning || null,
          tests: null,
          lapScoring: sectionLapScoring(test),
        });
      }
    } else if (entry.kind === "fusion") {
      const fusion = (event.fusions || []).find((f) => f.id === entry.refId);
      if (!fusion) continue;
      sections.push({
        entry,
        kind: "fusion",
        title: entry.title || fusion.name,
        rows: fusion.rows,
        warning: fusion.warning || null,
        tests: fusion.tests,
        lapScoring: false,
      });
    }
  }
  return sections;
}

function boardEventMeta(event: Event) {
  return {
    id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
    headerImage: event.headerImage,
    footerText: event.footerText,
    themeColors: event.themeColors ?? null,
    boardPageSeconds: event.boardPageSeconds ?? 10,
    overlayVariant:
      event.overlayVariant === "redbull" || event.overlayVariant === "ponymalta"
        ? event.overlayVariant
        : "classic",
    overlayTiming: event.overlayTiming === "total" ? "total" : "splits",
  };
}

router.get("/events/:id/board", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const board = [...(event.resultsBoard || [])].sort((a, b) => a.order - b.order);
  const sections = buildBoardSections(event);

  res.json({
    event: boardEventMeta(event),
    board,
    sections,
  });
});

// ─── Public data feeds (broadcast: vMix, OBS, graphics systems) ───
function isFusionRows(section: BoardSection): section is BoardSection & { rows: FusionRow[] } {
  return section.kind === "fusion";
}

/** Flatten a board section into simple rows shared by all feed formats */
function feedRows(section: BoardSection) {
  if (isFusionRows(section)) {
    return section.rows.map((r) => ({
      position: r.position,
      number: r.number,
      name: r.name || "",
      category: r.category || "",
      league: r.league || "",
      laps: "",
      time: r.totalTimeFormatted,
      timeMs: r.totalTimeMs,
      rawTime: "",
      rawTimeMs: 0,
      hasPenalty: false,
      penalty: "",
      timePenaltyMs: 0,
      positionPenalty: 0,
      comment: "",
      part: "",
      detail: r.byTest.map((t) => `${t.testName || t.testId}=${t.timeFormatted}`).join(" | "),
      segments: [] as ResultRow["segments"],
    }));
  }
  return (section.rows as ResultRow[]).map((r) => ({
    position: r.position,
    number: r.number,
    name: r.name || "",
    category: r.category || "",
    league: r.league || "",
    laps:
      r.laps == null ? "" : r.expectedLaps != null ? `${r.laps}/${r.expectedLaps}` : String(r.laps),
    time: r.timeFormatted,
    timeMs: r.timeMs,
    rawTime: r.rawTimeFormatted,
    rawTimeMs: r.rawTimeMs,
    hasPenalty: Boolean(r.hasPenalty),
    penalty: r.timePenaltyMs > 0 ? formatOffset(r.timePenaltyMs) : "",
    timePenaltyMs: r.timePenaltyMs || 0,
    positionPenalty: r.positionPenalty || 0,
    comment: r.comment || "",
    part: r.partName || "",
    detail: (r.segments || []).map((s) => `${s.from}→${s.to}=${s.timeFormatted}`).join(" | "),
    segments: r.segments || [],
  }));
}

function selectFeedSections(event: Event, sectionQuery: unknown): BoardSection[] {
  const sections = buildBoardSections(event);
  const wanted = String(sectionQuery || "").trim();
  if (!wanted) return sections;
  return sections.filter(
    (s, i) => s.entry.id === wanted || String(i + 1) === wanted
  );
}

function setFeedHeaders(res: import("express").Response, contentType: string) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Content-Type", contentType);
}

function xmlEsc(v: string | number): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Live HTML when ?live=1 or a browser navigates with Accept: text/html. Use ?raw=1 for plain feed. */
function wantsLiveHtml(req: import("express").Request): boolean {
  const q = req.query;
  if (q.raw === "1" || q.raw === "true") return false;
  if (q.live === "1" || q.live === "true" || (typeof q.live === "string" && /^\d+$/.test(q.live))) {
    return true;
  }
  const accept = String(req.headers.accept || "");
  if (!accept || accept === "*/*") return false;
  const htmlIdx = accept.indexOf("text/html");
  if (htmlIdx < 0) return false;
  const prefs = ["application/json", "application/xml", "text/xml", "text/csv"]
    .map((t) => accept.indexOf(t))
    .filter((i) => i >= 0);
  const otherIdx = prefs.length ? Math.min(...prefs) : Number.POSITIVE_INFINITY;
  return htmlIdx < otherIdx;
}

function liveRefreshSeconds(req: import("express").Request): number {
  const fromLive = Number(req.query.live);
  const fromRefresh = Number(req.query.refresh);
  const n = Number.isFinite(fromRefresh) && fromRefresh > 0 ? fromRefresh : fromLive;
  if (Number.isFinite(n) && n >= 2 && n <= 120) return Math.floor(n);
  return 5;
}

function sendLiveFeedHtml(
  req: import("express").Request,
  res: import("express").Response,
  event: Event,
  sections: BoardSection[],
  format: "json" | "csv" | "xml",
  rawBody: string
) {
  const refresh = liveRefreshSeconds(req);
  const generated = new Date().toISOString();
  const rawQs = new URLSearchParams();
  rawQs.set("raw", "1");
  if (typeof req.query.section === "string" && req.query.section.trim()) {
    rawQs.set("section", req.query.section.trim());
  }
  const rawHref = `?${rawQs.toString()}`;

  const tableBlocks = sections
    .map((s) => {
      const rows = feedRows(s)
        .map(
          (r) =>
            `<tr><td>${r.position}</td><td>${xmlEsc(r.number)}</td><td>${xmlEsc(r.name)}</td><td>${xmlEsc(r.league)}</td><td>${xmlEsc(r.time)}</td><td>${xmlEsc(r.rawTime)}</td><td>${xmlEsc(r.penalty)}</td><td>${xmlEsc(r.comment)}</td><td>${xmlEsc(r.part)}</td></tr>`
        )
        .join("");
      return `<section><h2>${xmlEsc(s.title)}</h2><table><thead><tr><th>Pos</th><th>#</th><th>Piloto</th><th>Liga</th><th>Tiempo</th><th>Sin pen.</th><th>Pen.</th><th>Comentario</th><th>Salida</th></tr></thead><tbody>${rows || `<tr><td colspan="9">Sin resultados</td></tr>`}</tbody></table></section>`;
    })
    .join("");

  setFeedHeaders(res, "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="${refresh}"/>
  <meta http-equiv="Cache-Control" content="no-store"/>
  <title>Feed ${format.toUpperCase()} · ${xmlEsc(event.name)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d10; --panel:#14181f; --line:#2a3140; --text:#e8edf5; --muted:#9aa6b8; --accent:#e10600; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 system-ui,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
    header { position:sticky; top:0; z-index:2; display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(11,13,16,.94); border-bottom:1px solid var(--line); backdrop-filter:blur(8px); }
    h1 { margin:0; font-size:1.05rem; }
    .meta { color:var(--muted); font-size:.85rem; }
    .badge { display:inline-block; padding:2px 8px; border-radius:999px; background:var(--accent); color:#fff; font-size:.75rem; font-weight:700; }
    a { color:#9ecbff; }
    main { padding:16px; display:grid; gap:18px; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:auto; }
    h2 { margin:0; padding:12px 14px; font-size:.95rem; border-bottom:1px solid var(--line); }
    table { width:100%; border-collapse:collapse; min-width:720px; }
    th, td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
    th { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
    details { margin-top:8px; }
    pre { margin:0; padding:12px; overflow:auto; font:12px/1.4 ui-monospace,Consolas,monospace; color:#c9d4e4; max-height:280px; }
  </style>
</head>
<body>
  <header>
    <div>
      <span class="badge">LIVE ${format.toUpperCase()}</span>
      <h1>${xmlEsc(event.name)}</h1>
      <div class="meta">Actualiza cada ${refresh}s · generado ${xmlEsc(generated)}</div>
    </div>
    <div class="meta"><a href="${xmlEsc(rawHref)}">Ver ${format.toUpperCase()} crudo</a> (para vMix / sistemas)</div>
  </header>
  <main>
    ${tableBlocks || "<p>Sin secciones en el tablero.</p>"}
    <details>
      <summary>Fuente ${format.toUpperCase()}</summary>
      <pre>${xmlEsc(rawBody)}</pre>
    </details>
  </main>
</body>
</html>`);
}

function buildFeedJsonPayload(event: Event, sections: BoardSection[]) {
  return {
    event: boardEventMeta(event),
    generatedAt: new Date().toISOString(),
    boardPageSeconds: event.boardPageSeconds ?? 10,
    pageSize: 10,
    sections: sections.map((s, i) => ({
      id: s.entry.id,
      index: i + 1,
      title: s.title,
      kind: s.kind,
      publishedAt: s.entry.publishedAt,
      rows: feedRows(s),
    })),
  };
}

function buildFeedCsv(sections: BoardSection[]): string {
  const escCsv = (v: string | number) => {
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "Seccion", "Pos", "Numero", "Nombre", "Categoria", "Liga",
    "Vueltas", "Tiempo", "TiempoSinPen", "Penalizacion", "PenPos", "Comentario", "Salida", "Detalle",
  ];
  const lines = [header.join(",")];
  for (const s of sections) {
    for (const r of feedRows(s)) {
      lines.push(
        [
          s.title, r.position, r.number, r.name, r.category, r.league,
          r.laps, r.time, r.rawTime, r.penalty, r.positionPenalty, r.comment, r.part, r.detail,
        ]
          .map(escCsv)
          .join(",")
      );
    }
  }
  return "\uFEFF" + lines.join("\r\n");
}

function buildFeedXml(event: Event, sections: BoardSection[]): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push(
    `<tablero evento="${xmlEsc(event.name)}" fecha="${xmlEsc(event.date || "")}" generado="${xmlEsc(new Date().toISOString())}">`
  );
  sections.forEach((s, i) => {
    parts.push(
      `  <seccion id="${xmlEsc(s.entry.id)}" indice="${i + 1}" titulo="${xmlEsc(s.title)}" tipo="${s.kind}">`
    );
    for (const r of feedRows(s)) {
      parts.push(
        `    <fila pos="${r.position}" numero="${xmlEsc(r.number)}" nombre="${xmlEsc(r.name)}" categoria="${xmlEsc(r.category)}" liga="${xmlEsc(r.league)}" vueltas="${xmlEsc(r.laps)}" tiempo="${xmlEsc(r.time)}" tiempoSinPen="${xmlEsc(r.rawTime)}" penalizacion="${xmlEsc(r.penalty)}" penPos="${xmlEsc(r.positionPenalty)}" comentario="${xmlEsc(r.comment)}" salida="${xmlEsc(r.part)}" detalle="${xmlEsc(r.detail)}"/>`
      );
    }
    parts.push("  </seccion>");
  });
  parts.push("</tablero>");
  return parts.join("\n");
}

router.get("/events/:id/board/feed.json", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const sections = selectFeedSections(event, req.query.section);
  const payload = buildFeedJsonPayload(event, sections);
  if (wantsLiveHtml(req)) {
    return sendLiveFeedHtml(req, res, event, sections, "json", JSON.stringify(payload, null, 2));
  }
  setFeedHeaders(res, "application/json; charset=utf-8");
  res.json(payload);
});

router.get("/events/:id/board/feed.csv", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const sections = selectFeedSections(event, req.query.section);
  const body = buildFeedCsv(sections);
  if (wantsLiveHtml(req)) {
    return sendLiveFeedHtml(req, res, event, sections, "csv", body.replace(/^\uFEFF/, ""));
  }
  setFeedHeaders(res, "text/csv; charset=utf-8");
  res.send(body);
});

router.get("/events/:id/board/feed.xml", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const sections = selectFeedSections(event, req.query.section);
  const body = buildFeedXml(event, sections);
  if (wantsLiveHtml(req)) {
    return sendLiveFeedHtml(req, res, event, sections, "xml", body);
  }
  setFeedHeaders(res, "application/xml; charset=utf-8");
  res.send(body);
});

router.post("/events/:id/board", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const kind = req.body.kind === "fusion" ? "fusion" : "unified";
  const refId = String(req.body.refId || "").trim();
  if (!refId) return res.status(400).json({ error: "refId requerido" });
  const partId =
    kind === "unified" && req.body.partId ? String(req.body.partId).trim() || null : null;

  let title = String(req.body.title || "").trim();
  if (kind === "unified") {
    const test = getTest(event, refId);
    if (!test) return res.status(404).json({ error: "Prueba no encontrada" });
    if (partId) {
      const part = getPart(test, partId);
      if (!part) return res.status(404).json({ error: "Salida no encontrada" });
      if (!title) title = `${test.name} — ${part.name}`;
    } else if (!title) {
      title = `${test.name} — Resultado unificado`;
    }
  } else {
    const fusion = (event.fusions || []).find((f) => f.id === refId);
    if (!fusion) return res.status(404).json({ error: "Fusión no encontrada" });
    if (!title) title = fusion.name;
  }

  if (!event.resultsBoard) event.resultsBoard = [];
  const existing = event.resultsBoard.find(
    (e) =>
      e.kind === kind &&
      e.refId === refId &&
      (e.partId || null) === (partId || null)
  );
  if (existing) {
    // Already published: bump to end of board (re-publish order)
    const maxOrder = event.resultsBoard.reduce((m, e) => Math.max(m, e.order), -1);
    existing.title = title;
    existing.partId = partId;
    existing.publishedAt = new Date().toISOString();
    existing.order = maxOrder + 1;
    // Normalize order sequence
    event.resultsBoard.sort((a, b) => a.order - b.order);
    event.resultsBoard.forEach((e, i) => {
      e.order = i;
    });
    await saveEvent(event);
    return res.json(existing);
  }

  const entry: ResultsBoardEntry = {
    id: uuid(),
    kind,
    refId,
    partId,
    title,
    publishedAt: new Date().toISOString(),
    order: event.resultsBoard.length,
  };
  event.resultsBoard.push(entry);
  await saveEvent(event);
  res.status(201).json(entry);
});

router.delete("/events/:id/board/:entryId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const before = event.resultsBoard?.length || 0;
  event.resultsBoard = (event.resultsBoard || []).filter((e) => e.id !== req.params.entryId);
  if ((event.resultsBoard?.length || 0) === before) {
    return res.status(404).json({ error: "Entrada no encontrada en el tablero" });
  }
  event.resultsBoard.forEach((e, i) => {
    e.order = i;
  });
  await saveEvent(event);
  res.json({ ok: true, resultsBoard: event.resultsBoard });
});

router.get("/events/:id/fusions/:fusionId/export/:format", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const fusion = (event.fusions || []).find((f) => f.id === req.params.fusionId);
  if (!fusion) return res.status(404).json({ error: "Fusión no encontrada" });

  try {
    return await sendFusionExport(res, event, fusion.name, fusion.tests, fusion.rows, req.params.format);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error al exportar" });
  }
});

router.put("/events/:id/tests/:testId/penalties", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });

  try {
    let timePenaltyMs = Number(req.body.timePenaltyMs);
    if (Number.isNaN(timePenaltyMs)) {
      timePenaltyMs = parseOffsetToMs(String(req.body.timePenalty || "0"));
    }
    upsertPenalty(test, {
      number: String(req.body.number || ""),
      scope: String(req.body.scope || "unified"),
      timePenaltyMs,
      positionPenalty: Number(req.body.positionPenalty || 0),
      comment: String(req.body.comment || ""),
    });
    if (!test.penalties) test.penalties = [];
    await saveEvent(event);
    res.json({ ok: true, penalties: test.penalties });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Error al guardar penalización" });
  }
});

router.get("/events/:id/tests/:testId/export/:format", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const test = getTest(event, req.params.testId);
  if (!test) return res.status(404).json({ error: "Prueba no encontrada" });

  const fromPointId = req.query.from as string | undefined;
  const toPointId = req.query.to as string | undefined;
  const partId = req.query.partId as string | undefined;
  const { fromId, toId } = resolveTestTimingPoints(event, test, fromPointId, toPointId);

  let rows;
  let title: string;
  if (partId) {
    const part = getPart(test, partId);
    if (!part) return res.status(404).json({ error: "Parte no encontrada" });
    ({ rows } = computePartResults(event, test, part, fromId, toId));
    rows = filterNewPilotsVsEarlier(event, test, part, rows, fromId, toId).rows;
    title = `${test.name} — ${part.name}`;
  } else {
    ({ rows } = computeTestResults(event, test, fromId, toId));
    title = `${test.name} — Resultado unificado`;
  }

  const format = req.params.format;
  const safeName = title.replace(/[^\w\-]+/g, "_");

  try {
    if (format === "pdf-vueltas" || format === "pdf-vueltas-horas") {
      if (!partId) {
        return res.status(400).json({
          error: "Indica la salida (calcula resultado parcial) para exportar vuelta a vuelta.",
        });
      }
      const part = getPart(test, partId);
      if (!part) return res.status(404).json({ error: "Parte no encontrada" });
      if (!isLapScoringPart(part)) {
        return res.status(400).json({
          error: "La exportación vuelta a vuelta solo está disponible con CSV único por vueltas.",
        });
      }
      const lapSuffix =
        format === "pdf-vueltas-horas" ? "Vuelta a vuelta con horas" : "Vuelta a vuelta";
      const lapTitle = `${title} — ${lapSuffix}`;
      const { rows: lapRows, maxLaps, warning } = computeLapByLapResults(
        event,
        test,
        part,
        fromId,
        toId
      );
      if (lapRows.length === 0) {
        return res.status(400).json({ error: warning || "Sin vueltas para exportar" });
      }
      const buf =
        format === "pdf-vueltas-horas"
          ? await lapByLapWithHoursToPdf(lapRows, maxLaps, lapTitle, event, test)
          : await lapByLapToPdf(lapRows, maxLaps, lapTitle, event, test);
      const fileSuffix =
        format === "pdf-vueltas-horas" ? "vuelta_a_vuelta_horas" : "vuelta_a_vuelta";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}_${fileSuffix}.pdf"`
      );
      return res.send(buf);
    }
    if (format === "csv") {
      const csv = resultsToCsv(rows, title);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.csv"`);
      return res.send("\uFEFF" + csv);
    }
    if (format === "xlsx" || format === "excel") {
      const buf = await resultsToExcel(rows, title, event.name);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
      return res.send(buf);
    }
    if (format === "pdf") {
      const buf = await resultsToPdf(rows, title, event, test);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
      return res.send(buf);
    }
    return res.status(400).json({
      error: "Formato no soportado (csv|xlsx|pdf|pdf-vueltas|pdf-vueltas-horas)",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error al exportar" });
  }
});

// ─── Event pilots ─────────────────────────────────────────
router.get("/events/:id/pilots", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  res.json(event.pilots);
});

router.post("/events/:id/pilots/import/preview", upload.single("file"), async (req, res) => {
  if (!await getEvent(req.params.id)) return res.status(404).json({ error: "Evento no encontrado" });
  if (!req.file) return res.status(400).json({ error: "Archivo CSV requerido" });
  try {
    const content = req.file.buffer.toString("utf-8");
    res.json(previewPilotsCsv(content, req.file.originalname));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Error al leer CSV" });
  }
});

router.post("/events/:id/pilots/import", upload.single("file"), async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  if (!req.file) return res.status(400).json({ error: "Archivo CSV requerido" });
  try {
    const content = req.file.buffer.toString("utf-8");
    let mapping: ColumnMapping = {};
    if (req.body.mapping) {
      mapping = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
    } else {
      mapping = previewPilotsCsv(content).suggestedMapping;
    }
    const skipFirstRow = req.body.skipFirstRow !== "false" && req.body.skipFirstRow !== false;
    const result = importPilotsFromCsv(content, event.pilots || [], mapping, { skipFirstRow });
    event.pilots = result.pilots;
    await saveEvent(event);
    res.json({
      pilots: result.pilots,
      summary: {
        total: result.pilots.length,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        filename: req.file.originalname,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Error al importar CSV" });
  }
});

router.post("/events/:id/pilots", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const pilot: Pilot = {
    id: uuid(),
    number: req.body.number || "",
    name: req.body.name || "",
    category: req.body.category || "",
    league: req.body.league || "",
    notes: req.body.notes || "",
  };
  event.pilots = event.pilots || [];
  event.pilots.push(pilot);
  await saveEvent(event);
  res.status(201).json(pilot);
});

router.put("/events/:id/pilots/:pilotId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  const idx = (event.pilots || []).findIndex((p) => p.id === req.params.pilotId);
  if (idx < 0) return res.status(404).json({ error: "Piloto no encontrado" });
  event.pilots[idx] = { ...event.pilots[idx], ...req.body, id: event.pilots[idx].id };
  await saveEvent(event);
  res.json(event.pilots[idx]);
});

router.delete("/events/:id/pilots/:pilotId", async (req, res) => {
  const event = await getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  event.pilots = (event.pilots || []).filter((p) => p.id !== req.params.pilotId);
  await saveEvent(event);
  res.json({ ok: true });
});

export default router;
