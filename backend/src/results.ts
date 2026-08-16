import { normalizeNumber } from "./storage.js";
import { formatMs, parseTimeToMs } from "./timeUtils.js";
import { isolatePilotCsv } from "./csvParser.js";
import type {
  Event,
  ParsedCsv,
  Passage as CsvPassage,
  Pilot,
  PilotPenalty,
  ResultRow,
  ResultSegment,
  Test,
  TestPart,
  TimingPoint,
} from "./types.js";
import { csvInputModeOf } from "./types.js";

export const UNIFIED_SCOPE = "unified";
/** Single shared penalty per pilot within a test (salida ↔ unificado) */
export const SHARED_PENALTY_SCOPE = "shared";

/** Resolve Desde/Hasta for a test (stored config, then query override, then defaults) */
export function resolveTestTimingPoints(
  event: Event,
  test: Test,
  fromOverride?: string,
  toOverride?: string
): { fromId: string | undefined; toId: string | undefined } {
  const points = [...event.timingPoints].sort((a, b) => a.order - b.order);
  return {
    fromId: fromOverride || test.fromPointId || points[0]?.id,
    toId: toOverride || test.toPointId || points[1]?.id,
  };
}

export function segmentLabelForTest(
  event: Event,
  test: Test,
  fromOverride?: string,
  toOverride?: string
): string {
  if (test.timingMode === "start_finish_partial") {
    const points = event.timingPoints;
    const sfId = test.startFinishPointId || test.fromPointId || points[0]?.id;
    const sfName = points.find((p) => p.id === sfId)?.name ?? "Start/Finish";
    const partialIds =
      test.partialPointIds && test.partialPointIds.length > 0
        ? test.partialPointIds
        : test.toPointId
          ? [test.toPointId]
          : [];
    const partialNames = partialIds
      .map((id) => points.find((p) => p.id === id)?.name)
      .filter(Boolean);
    if (partialNames.length === 0) return `${sfName} → parcial → ${sfName}`;
    return `${sfName} → ${partialNames.join(" → ")} → ${sfName}`;
  }
  const { fromId, toId } = resolveTestTimingPoints(event, test, fromOverride, toOverride);
  const points = event.timingPoints;
  const fromName = points.find((p) => p.id === fromId)?.name ?? "Desde";
  const toName = points.find((p) => p.id === toId)?.name ?? "Hasta";
  return `${fromName} → ${toName}`;
}

function pickName(...names: (string | undefined)[]): string {
  for (const n of names) {
    if (n && String(n).trim()) return n;
  }
  return "";
}

function firstRacePassageByPilot(
  parsed: ParsedCsv
): Map<string, { number: string; name: string; tm: number; lap: number | null }> {
  const map = new Map<string, { number: string; name: string; tm: number; lap: number | null }>();
  for (const p of parsed.racePassages) {
    const key = normalizeNumber(p.number);
    if (!map.has(key)) {
      map.set(key, {
        number: p.number,
        name: p.name,
        tm: p.tmPasosMs,
        lap: p.lapTimeMs,
      });
    }
  }
  return map;
}

/** All race passages per pilot, in chronological order (by Tm de pasos) */
function racePassagesByPilot(
  parsed: ParsedCsv
): Map<string, { number: string; name: string; tm: number; lap: number | null }[]> {
  const map = new Map<string, { number: string; name: string; tm: number; lap: number | null }[]>();
  for (const p of parsed.racePassages) {
    const key = normalizeNumber(p.number);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({
      number: p.number,
      name: p.name,
      tm: p.tmPasosMs,
      lap: p.lapTimeMs,
    });
  }
  for (const [, list] of map) {
    list.sort((a, b) => a.tm - b.tm);
  }
  return map;
}

/**
 * Align a decoder reading to the reference timeline (PC A).
 * Positive offset = that clock is ahead / “corrido hacia arriba” → subtract.
 * Negative offset = that clock is behind / atrasado → add (via negative subtract).
 * Formula: tiempo = (Tm_hasta − desfase_hasta) − (Tm_desde − desfase_desde)
 * Example: B start ahead by 3:27 → desfase B = +00:03:27, Desde=B, Hasta=A.
 */
function correctedTime(rawMs: number, point: TimingPoint | undefined): number {
  return rawMs - (point?.offsetMs ?? 0);
}

/**
 * CSV único por tiempo: Start y Finish viven en el mismo archivo.
 * Preferencia: 1ª pasada = salida, 2ª = llegada (Tm de pasos).
 * Fallback legacy: columna "Tiempo de vuelta" > 0 si solo hay una pasada.
 */
function combinedStartFinishByPilot(
  parsed: ParsedCsv
): {
  complete: { number: string; name: string; timeMs: number; via: "passages" | "lap" }[];
  incomplete: { number: string; name: string; reason: "missing_finish" }[];
  nonPositive: number;
} {
  const byPilot = racePassagesByPilot(parsed);
  const complete: { number: string; name: string; timeMs: number; via: "passages" | "lap" }[] = [];
  const incomplete: { number: string; name: string; reason: "missing_finish" }[] = [];
  let nonPositive = 0;

  for (const [, list] of byPilot) {
    const start = list[0];
    const finish = list[1];
    if (start && finish) {
      const delta = finish.tm - start.tm;
      if (delta <= 0) {
        nonPositive++;
        continue;
      }
      complete.push({
        number: start.number,
        name: pickName(start.name, finish.name),
        timeMs: delta,
        via: "passages",
      });
      continue;
    }

    const lapHit = list.find((p) => p.lap != null && p.lap > 0);
    if (lapHit && lapHit.lap != null) {
      complete.push({
        number: lapHit.number,
        name: lapHit.name,
        timeMs: lapHit.lap,
        via: "lap",
      });
      continue;
    }

    if (start && !finish) {
      incomplete.push({
        number: start.number,
        name: start.name,
        reason: "missing_finish",
      });
    }
  }

  return { complete, incomplete, nonPositive };
}

interface LapPilotResult {
  number: string;
  name: string;
  laps: number;
  totalTimeMs: number;
}

/** Lap count + total elapsed time per pilot from combined CSV */
function lapResultsByPilot(parsed: ParsedCsv): Map<string, LapPilotResult> {
  const byPilot = new Map<string, { number: string; name: string; passages: typeof parsed.racePassages }>();
  for (const p of parsed.racePassages) {
    const key = normalizeNumber(p.number);
    if (!byPilot.has(key)) {
      byPilot.set(key, { number: p.number, name: p.name, passages: [] });
    }
    byPilot.get(key)!.passages.push(p);
  }

  const result = new Map<string, LapPilotResult>();
  for (const [key, data] of byPilot) {
    const completed = data.passages.filter((p) => p.lapTimeMs != null && p.lapTimeMs > 0);
    if (completed.length === 0) continue;

    const lapCounts = completed
      .map((p) => p.lapsCount)
      .filter((n): n is number => n != null && n > 0);
    const laps = lapCounts.length > 0 ? Math.max(...lapCounts) : completed.length;

    const latest = (list: typeof completed) =>
      list.reduce((best, p) =>
        !best ||
        p.tmPasosMs > best.tmPasosMs ||
        (p.tmPasosMs === best.tmPasosMs && p.rowIndex > best.rowIndex)
          ? p
          : best
      );
    const earliest = (list: typeof completed) =>
      list.reduce((best, p) =>
        !best ||
        p.tmPasosMs < best.tmPasosMs ||
        (p.tmPasosMs === best.tmPasosMs && p.rowIndex < best.rowIndex)
          ? p
          : best
      );

    const last = latest(completed);
    const atMaxLaps = completed.filter((p) => (p.lapsCount ?? 0) === laps);
    const lastAtMax = atMaxLaps.length > 0 ? latest(atMaxLaps) : last;

    // Total race time: elapsed clock, never the last lap alone.
    let totalTimeMs = lastAtMax.elapsedMs ?? 0;
    if (totalTimeMs <= 0 && completed.length >= 2) {
      totalTimeMs = last.tmPasosMs - earliest(completed).tmPasosMs;
    }
    if (totalTimeMs <= 0) {
      totalTimeMs = completed.reduce((sum, p) => sum + (p.lapTimeMs || 0), 0);
    }

    result.set(key, {
      number: data.number,
      name: data.name,
      laps,
      totalTimeMs: Math.max(0, totalTimeMs),
    });
  }
  return result;
}

function enrichLap(
  pilots: Pilot[],
  number: string,
  name: string,
  laps: number,
  totalTimeMs: number,
  part: TestPart
): ResultRow {
  const expected = part.expectedLaps ?? null;
  const row = enrich(
    pilots,
    number,
    name,
    totalTimeMs,
    `Vueltas (${laps}${expected != null ? ` / ${expected}` : ""})`,
    part
  );
  return {
    ...row,
    laps,
    expectedLaps: expected,
    lapsIncomplete: expected != null && laps < expected,
    lastLapMs: row.lastLapMs,
    lastLapFormatted: row.lastLapFormatted,
  };
}

/** More laps first; equal laps → shorter total time. Never last-lap time. */
function compareLapStandings(
  a: { laps?: number; timeMs?: number; rawTimeMs?: number },
  b: { laps?: number; timeMs?: number; rawTimeMs?: number }
): number {
  const lapsA = a.laps ?? 0;
  const lapsB = b.laps ?? 0;
  if (lapsB !== lapsA) return lapsB - lapsA;
  const timeA = a.timeMs ?? a.rawTimeMs ?? 0;
  const timeB = b.timeMs ?? b.rawTimeMs ?? 0;
  return timeA - timeB;
}

function rankLapRaw(rows: ResultRow[]): ResultRow[] {
  const sorted = [...rows].sort((a, b) => compareLapStandings(a, b));
  return sorted.map((r, i) => ({ ...r, position: i + 1 }));
}

function isLapScoring(part: TestPart): boolean {
  const mode = csvInputModeOf(part);
  return (mode === "combined" || mode === "pilots") && part.combinedScoring === "laps";
}

export function isLapScoringPart(part: TestPart): boolean {
  return isLapScoring(part);
}

export interface LapByLapRow {
  position: number;
  number: string;
  name: string;
  category: string;
  league: string;
  lapTimesFormatted: string[];
  lapClockTimesFormatted: string[];
  lapsCompleted: number;
  expectedLaps: number | null;
  totalTimeFormatted: string;
  totalTimeMs: number;
}

function lapDetailsByPilot(
  parsed: ParsedCsv
): Map<string, { lapTimeFormatted: string; clockFormatted: string }[]> {
  const map = new Map<string, ({ lapTimeFormatted: string; clockFormatted: string } | undefined)[]>();
  for (const p of parsed.racePassages) {
    if (p.lapTimeMs == null || p.lapTimeMs <= 0) continue;
    const key = normalizeNumber(p.number);
    if (!map.has(key)) map.set(key, []);
    const item = {
      lapTimeFormatted: formatMs(p.lapTimeMs),
      clockFormatted: p.tmPasosRaw?.trim() || formatMs(p.tmPasosMs, true),
    };
    const arr = map.get(key)!;
    const lapNo = p.lapsCount;
    if (lapNo != null && lapNo > 0) arr[lapNo - 1] = item;
    else arr.push(item);
  }
  const dense = new Map<string, { lapTimeFormatted: string; clockFormatted: string }[]>();
  for (const [key, arr] of map) {
    dense.set(
      key,
      Array.from({ length: arr.length }, (_, i) => {
        const d = arr[i];
        return {
          lapTimeFormatted: d?.lapTimeFormatted || "",
          clockFormatted: d?.clockFormatted || "",
        };
      })
    );
  }
  return dense;
}

function lapHitCount(parsed: ParsedCsv | undefined | null): number {
  return (parsed?.racePassages || []).filter((p) => p.lapTimeMs != null && p.lapTimeMs > 0).length;
}

/** CSV único: never blindly use csvs[0] (leftover por-punto slots). */
function combinedCsvSlot(part: TestPart): TestPart["csvs"][number] | undefined {
  const slots = (part.csvs || []).filter((s) => s.parsed && !String(s.pilotNumber || "").trim());
  const pool = slots.length > 0 ? slots : (part.csvs || []).filter((s) => s.parsed);
  if (pool.length === 0) return undefined;
  let best = pool[0];
  let bestScore = -1;
  for (const slot of pool) {
    const score = lapHitCount(slot.parsed) * 1000 + (slot.parsed.racePassages || []).length;
    if (score > bestScore) {
      bestScore = score;
      best = slot;
    }
  }
  return best;
}

type LapDetail = { lapTimeFormatted: string; clockFormatted: string };

function parsedListFromPart(
  part: TestPart,
  event: Event
): ParsedCsv[] {
  const out: ParsedCsv[] = [];
  if (csvInputModeOf(part) === "pilots") {
    const merged = mergedPilotParsed(part, event.pilots || []);
    if (merged) out.push(merged);
    for (const s of part.csvs || []) {
      if (s.parsed && !String(s.pilotNumber || "").trim()) out.push(s.parsed);
    }
    return out;
  }
  for (const s of part.csvs || []) {
    if (!s.parsed) continue;
    const n = String(s.pilotNumber || "").trim();
    out.push(n ? isolatePilotCsv(s.parsed, n) : s.parsed);
  }
  return out;
}

function fastestLapRows(
  part: TestPart,
  event: Event,
  pilots: Pilot[],
  label: string
): ResultRow[] {
  const best = new Map<string, { number: string; name: string; timeMs: number }>();
  for (const parsed of parsedListFromPart(part, event)) {
    for (const p of parsed.racePassages || []) {
      if (p.lapTimeMs == null || p.lapTimeMs <= 0) continue;
      const key = normalizeNumber(p.number);
      const prev = best.get(key);
      if (!prev || p.lapTimeMs < prev.timeMs) {
        best.set(key, {
          number: p.number,
          name: pickName(p.name, prev?.name),
          timeMs: p.lapTimeMs,
        });
      }
    }
  }
  return [...best.values()].map((p) => {
    const row = enrich(pilots, p.number, p.name, p.timeMs, label, part);
    return {
      ...row,
      lastLapMs: p.timeMs,
      lastLapFormatted: formatMs(p.timeMs),
    };
  });
}

function isTimePrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((t, i) => t === long[i]);
}

/** Later dump of the same race replaces; a new heat is appended. */
function mergeLapDetailLists(a: LapDetail[], b: LapDetail[]): LapDetail[] {
  const aTimes = a.map((d) => d.lapTimeFormatted).filter(Boolean);
  const bTimes = b.map((d) => d.lapTimeFormatted).filter(Boolean);
  if (bTimes.length === 0) return a;
  if (aTimes.length === 0) return b;
  if (isTimePrefix(aTimes, bTimes)) return b;
  if (isTimePrefix(bTimes, aTimes)) return a;
  return [...a, ...b];
}

function lapDetailsForParsed(parsed: ParsedCsv): Map<string, LapDetail[]> {
  const lapDetails = lapDetailsByPilot(parsed);
  const successive = lapDetailsFromSuccessiveHits(parsed);
  for (const [key, succ] of successive) {
    const timed = lapDetails.get(key) || [];
    const timedFilled = timed.filter((d) => d.lapTimeFormatted).length;
    if (succ.length > timedFilled) {
      const len = Math.max(timed.length, succ.length);
      lapDetails.set(
        key,
        Array.from({ length: len }, (_, i) =>
          timed[i]?.lapTimeFormatted
            ? timed[i]
            : succ[i] || { lapTimeFormatted: "", clockFormatted: "" }
        )
      );
    } else if (!lapDetails.has(key) && succ.length > 0) {
      lapDetails.set(key, succ);
    }
  }
  return lapDetails;
}

/** If Orbits didn't fill Tiempo de vuelta, build laps from successive hits. */
function lapDetailsFromSuccessiveHits(
  parsed: ParsedCsv
): Map<string, { lapTimeFormatted: string; clockFormatted: string }[]> {
  const map = new Map<string, { lapTimeFormatted: string; clockFormatted: string }[]>();
  const byPilot = new Map<string, typeof parsed.racePassages>();
  for (const p of parsed.racePassages || []) {
    const key = normalizeNumber(p.number);
    if (!byPilot.has(key)) byPilot.set(key, []);
    byPilot.get(key)!.push(p);
  }
  for (const [key, list] of byPilot) {
    const ordered = [...list].sort(
      (a, b) => a.rowIndex - b.rowIndex || a.tmPasosMs - b.tmPasosMs
    );
    const details: { lapTimeFormatted: string; clockFormatted: string }[] = [];
    for (let i = 1; i < ordered.length; i++) {
      const ms = ordered[i].tmPasosMs - ordered[i - 1].tmPasosMs;
      if (ms <= 0) continue;
      details.push({
        lapTimeFormatted: formatMs(ms),
        clockFormatted: ordered[i].tmPasosRaw?.trim() || formatMs(ordered[i].tmPasosMs, true),
      });
    }
    if (details.length > 0) map.set(key, details);
  }
  return map;
}

export function computeLapByLapResults(
  event: Event,
  test: Test,
  _part: TestPart,
  _fromPointId?: string,
  _toPointId?: string
): { rows: LapByLapRow[]; maxLaps: number; warning?: string } {
  const sources = [...(test.parts || [])].sort((a, b) => a.order - b.order);
  if (sources.length === 0) sources.push(_part);
  const lapDetails = new Map<string, LapDetail[]>();
  const meta = new Map<string, { number: string; name: string }>();
  let anyCsv = false;

  for (const src of sources) {
    for (const parsed of parsedListFromPart(src, event)) {
      anyCsv = true;
      for (const p of parsed.racePassages || []) {
        const key = normalizeNumber(p.number);
        if (!meta.has(key)) meta.set(key, { number: p.number, name: p.name });
      }
      const details = lapDetailsForParsed(parsed);
      for (const [key, list] of details) {
        lapDetails.set(key, mergeLapDetailLists(lapDetails.get(key) || [], list));
      }
    }
  }

  if (!anyCsv) {
    return { rows: [], maxLaps: 0, warning: "No hay CSV cargado en esta parte." };
  }

  const pilots = event.pilots || [];
  const expected = sources.reduce<number | null>((max, p) => {
    const n = p.expectedLaps;
    if (n == null) return max;
    return max == null ? n : Math.max(max, n);
  }, null);

  const rows: LapByLapRow[] = [];
  for (const [key, details] of lapDetails) {
    const filled = details.filter((d) => d.lapTimeFormatted);
    if (filled.length === 0) continue;
    const info = meta.get(key);
    const pilot = pilots.find((p) => normalizeNumber(p.number) === key);
    const totalTimeMs = filled.reduce(
      (sum, d) => sum + (parseTimeToMs(d.lapTimeFormatted) || 0),
      0
    );
    rows.push({
      position: 0,
      number: info?.number || key,
      name: (pilot?.name || info?.name || info?.number || key).trim() || key,
      category: pilot?.category || "",
      league: pilot?.league || "",
      lapTimesFormatted: details.map((d) => d.lapTimeFormatted),
      lapClockTimesFormatted: details.map((d) => d.clockFormatted),
      lapsCompleted: filled.length,
      expectedLaps: expected,
      totalTimeFormatted: formatMs(totalTimeMs),
      totalTimeMs,
    });
  }

  rows.sort((a, b) => {
    if (b.lapsCompleted !== a.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
    return a.totalTimeMs - b.totalTimeMs;
  });
  rows.forEach((r, i) => {
    r.position = i + 1;
  });

  const maxLaps = Math.max(expected ?? 0, ...rows.map((r) => r.lapTimesFormatted.length), 0);

  if (rows.length === 0) {
    return { rows: [], maxLaps: 0, warning: "No se encontraron vueltas completadas en el CSV." };
  }

  return { rows, maxLaps };
}

function compareLapResultRows(a: ResultRow, b: ResultRow): number {
  return compareLapStandings(a, b);
}

/**
 * Penalties are shared per pilot within a test (any salida + unified).
 * Legacy data may have multiple scopes; we merge them.
 */
function findPenalty(
  penalties: PilotPenalty[] | undefined,
  number: string
): PilotPenalty | undefined {
  const key = normalizeNumber(number);
  const matches = (penalties || []).filter((p) => normalizeNumber(p.number) === key);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return {
    number: matches[0].number,
    scope: SHARED_PENALTY_SCOPE,
    timePenaltyMs: Math.max(...matches.map((m) => m.timePenaltyMs || 0)),
    positionPenalty: Math.max(...matches.map((m) => m.positionPenalty || 0)),
    comment: matches.map((m) => m.comment || "").find((c) => c.trim()) || "",
  };
}

function lastValidPassageFromPart(
  part: TestPart | undefined,
  number: string
): CsvPassage | null {
  if (!part) return null;
  const key = normalizeNumber(number);
  let best: CsvPassage | null = null;
  for (const slot of part.csvs || []) {
    const slotPilot = slot.pilotNumber ? normalizeNumber(slot.pilotNumber) : "";
    for (const p of slot.parsed?.racePassages || []) {
      if (normalizeNumber(p.number) !== key && slotPilot !== key) continue;
      if (
        !best ||
        p.tmPasosMs > best.tmPasosMs ||
        (p.tmPasosMs === best.tmPasosMs && p.rowIndex > best.rowIndex)
      ) {
        best = p;
      }
    }
  }
  return best;
}

function lastLapFromPart(
  part: TestPart | undefined,
  number: string
): { lastLapMs: number; lastLapFormatted: string; laps: number | null } | null {
  const lastValid = lastValidPassageFromPart(part, number);
  if (!lastValid) return null;

  let lastWithLap: CsvPassage | null = null;
  const key = normalizeNumber(number);
  for (const slot of part?.csvs || []) {
    const slotPilot = slot.pilotNumber ? normalizeNumber(slot.pilotNumber) : "";
    for (const p of slot.parsed?.racePassages || []) {
      if (normalizeNumber(p.number) !== key && slotPilot !== key) continue;
      if (p.lapTimeMs == null || p.lapTimeMs <= 0) continue;
      if (
        !lastWithLap ||
        p.tmPasosMs > lastWithLap.tmPasosMs ||
        (p.tmPasosMs === lastWithLap.tmPasosMs && p.rowIndex > lastWithLap.rowIndex)
      ) {
        lastWithLap = p;
      }
    }
  }

  const laps = lastValid.lapsCount;
  if (!lastWithLap || lastWithLap.lapTimeMs == null) {
    return laps != null ? { lastLapMs: 0, lastLapFormatted: "", laps } : null;
  }
  return {
    lastLapMs: lastWithLap.lapTimeMs,
    lastLapFormatted: formatMs(lastWithLap.lapTimeMs),
    laps: laps ?? lastWithLap.lapsCount ?? null,
  };
}

function enrich(
  pilots: Pilot[],
  number: string,
  name: string,
  timeMs: number,
  segmentLabel: string,
  part?: TestPart,
  segments?: ResultSegment[]
): ResultRow {
  const pilot = pilots.find((p) => normalizeNumber(p.number) === normalizeNumber(number));
  const lastLap = lastLapFromPart(part, number);
  return {
    position: 0,
    number,
    name: pilot?.name || name,
    category: pilot?.category || "",
    league: pilot?.league || "",
    rawTimeMs: timeMs,
    rawTimeFormatted: formatMs(timeMs),
    timeMs,
    timeFormatted: formatMs(timeMs),
    timePenaltyMs: 0,
    positionPenalty: 0,
    comment: "",
    hasPenalty: false,
    partId: part?.id,
    partName: part?.name,
    missingPilot: !pilot,
    segmentLabel,
    incomplete: false,
    segments: segments && segments.length > 0 ? segments : undefined,
    lastLapMs: lastLap?.lastLapMs || undefined,
    lastLapFormatted: lastLap?.lastLapFormatted || undefined,
    laps: lastLap?.laps != null ? lastLap.laps : undefined,
  };
}

function enrichIncomplete(
  pilots: Pilot[],
  number: string,
  name: string,
  reason: "missing_start" | "missing_finish",
  fromLabel: string,
  toLabel: string,
  part?: TestPart
): ResultRow {
  const statusLabel =
    reason === "missing_finish"
      ? `Incompleto: sin llegada (${toLabel})`
      : `Incompleto: sin salida (${fromLabel})`;
  const row = enrich(pilots, number, name, 0, statusLabel, part);
  return {
    ...row,
    rawTimeFormatted: "—",
    timeFormatted: "—",
    incomplete: true,
    incompleteReason: reason,
    statusLabel,
  };
}

function partsInOrder(test: Test): TestPart[] {
  return [...test.parts].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function earlierParts(test: Test, part: TestPart): TestPart[] {
  const ordered = partsInOrder(test);
  const idx = ordered.findIndex((p) => p.id === part.id);
  if (idx <= 0) return [];
  return ordered.slice(0, idx);
}

type LookbackPassage = { number: string; name: string; tm: number; lap: number | null };

/** Look for start (Desde) in earlier salidas when current only has finish */
function findEarlierFromPassage(
  event: Event,
  test: Test,
  currentPart: TestPart,
  fromId: string,
  pilotKey: string
): { passage: LookbackPassage; part: TestPart; point: TimingPoint | undefined } | null {
  const points = event.timingPoints;
  // Most recent earlier salida first (still closing the previous wave)
  for (const prev of [...earlierParts(test, currentPart)].reverse()) {
    const slot = prev.csvs.find((c) => c.timingPointId === fromId);
    if (!slot) continue;
    const map = firstRacePassageByPilot(slot.parsed);
    const passage = map.get(pilotKey);
    if (passage) {
      return {
        passage,
        part: prev,
        point: points.find((p) => p.id === fromId),
      };
    }
  }
  return null;
}

function mergeCompleteAndIncomplete(
  complete: ResultRow[],
  incomplete: ResultRow[],
  penalties: PilotPenalty[] | undefined,
  scope: string
): ResultRow[] {
  const ranked = applyPenalties(rankRaw(complete), penalties, scope);
  const incompleteOut = incomplete.map((r) => {
    const pen = findPenalty(penalties, r.number);
    return {
      ...r,
      position: 0,
      timePenaltyMs: pen?.timePenaltyMs || 0,
      positionPenalty: pen?.positionPenalty || 0,
      comment: pen?.comment || "",
      hasPenalty: Boolean(
        (pen?.timePenaltyMs || 0) > 0 ||
          (pen?.positionPenalty || 0) > 0 ||
          (pen?.comment || "").trim()
      ),
    };
  });
  return [...ranked, ...incompleteOut];
}

/** Apply time + position penalties and re-rank */
export function applyPenalties(
  rows: ResultRow[],
  penalties: PilotPenalty[] | undefined,
  _scope?: string,
  lapMode = false
): ResultRow[] {
  const withTime = rows.map((r) => {
    const pen = findPenalty(penalties, r.number);
    const timePenaltyMs = pen?.timePenaltyMs || 0;
    const positionPenalty = pen?.positionPenalty || 0;
    const comment = pen?.comment || "";
    const timeMs = r.rawTimeMs + timePenaltyMs;
    const hasPenalty = timePenaltyMs !== 0 || positionPenalty !== 0 || Boolean(comment.trim());
    return {
      ...r,
      timePenaltyMs,
      positionPenalty,
      comment,
      hasPenalty,
      timeMs,
      timeFormatted: formatMs(timeMs),
    };
  });

  const byScore = [...withTime].sort((a, b) =>
    lapMode ? compareLapStandings(a, b) : a.timeMs - b.timeMs
  );

  const provisional = byScore.map((r, i) => ({
    ...r,
    _sort: i + 1 + (r.positionPenalty || 0),
  }));

  provisional.sort((a, b) => {
    if (lapMode) {
      const lapsA = a.laps ?? 0;
      const lapsB = b.laps ?? 0;
      if (lapsB !== lapsA) return lapsB - lapsA;
    }
    return a._sort - b._sort || a.timeMs - b.timeMs;
  });

  return provisional.map(({ _sort, ...r }, i) => ({
    ...r,
    position: i + 1,
  }));
}

function rankRaw(rows: ResultRow[]): ResultRow[] {
  const sorted = [...rows].sort((a, b) => a.rawTimeMs - b.rawTimeMs);
  return sorted.map((r, i) => ({ ...r, position: i + 1 }));
}

export interface ResultsComputation {
  rows: ResultRow[];
  warning?: string;
  scope: string;
  /** Present when partial results exclude pilots already seen in earlier salidas */
  diffNote?: string;
}

/**
 * For cumulative CSV dumps (salida N includes all of N-1 + new pilots),
 * keep only pilots that did not appear with a complete time in any earlier salida.
 * Incomplete (solo A o solo B) do not count as "already listed".
 */
export function filterNewPilotsVsEarlier(
  event: Event,
  test: Test,
  part: TestPart,
  rows: ResultRow[],
  fromPointId?: string,
  toPointId?: string
): { rows: ResultRow[]; diffNote?: string } {
  const earlier = earlierParts(test, part);
  if (earlier.length === 0 || rows.length === 0) {
    return { rows };
  }

  const seen = new Set<string>();
  const comparedNames: string[] = [];
  for (const prev of earlier) {
    const raw = computePartResultsRaw(event, test, prev, fromPointId, toPointId);
    const completePrev = raw.rows.filter((r) => !r.incomplete);
    if (completePrev.length === 0) continue;
    comparedNames.push(prev.name);
    for (const r of completePrev) seen.add(normalizeNumber(r.number));
  }

  if (seen.size === 0) {
    return { rows };
  }

  const onlyNew = rows.filter((r) => !seen.has(normalizeNumber(r.number)));
  const excluded = rows.length - onlyNew.length;
  const complete = onlyNew.filter((r) => !r.incomplete);
  const incomplete = onlyNew.filter((r) => r.incomplete);
  const reranked = [
    ...complete.map((r, i) => ({ ...r, position: i + 1 })),
    ...incomplete.map((r) => ({ ...r, position: 0 })),
  ];

  const vs =
    comparedNames.length === 1
      ? comparedNames[0]
      : comparedNames.length > 1
        ? `salidas anteriores (${comparedNames.join(", ")})`
        : "salidas anteriores";

  return {
    rows: reranked,
    diffNote:
      excluded > 0
        ? `Solo diferencia vs ${vs}: ${reranked.length} piloto(s) nuevo(s)/pendiente(s), ${excluded} ya con tiempo completo antes.`
        : `Sin pilotos nuevos vs ${vs} (todos ya tenían tiempo completo en salidas anteriores).`,
  };
}

function stampPassagesToPilot(
  parsed: ParsedCsv,
  number: string,
  name: string
): ParsedCsv {
  const stamp = (p: CsvPassage): CsvPassage => ({
    ...p,
    number,
    name: name || p.name,
  });
  return {
    ...parsed,
    passages: (parsed.passages || []).map(stamp),
    racePassages: (parsed.racePassages || []).map(stamp),
  };
}

function mergedPilotParsed(part: TestPart, pilots: Pilot[]): ParsedCsv | null {
  const passages: CsvPassage[] = [];
  const racePassages: CsvPassage[] = [];
  const flags: ParsedCsv["flags"] = [];
  for (const slot of part.csvs || []) {
    const number = String(slot.pilotNumber || "").trim();
    if (!number) continue;
    const name = pilots.find((p) => normalizeNumber(p.number) === normalizeNumber(number))?.name || "";
    const isolated = isolatePilotCsv(slot.parsed, number);
    const stamped = stampPassagesToPilot(isolated, number, name);
    passages.push(...(stamped.passages || []));
    racePassages.push(...(stamped.racePassages || []));
    flags.push(...(stamped.flags || []));
  }
  if (passages.length === 0 && racePassages.length === 0) return null;
  return { filename: "pilotos", passages, racePassages, flags };
}

function computePilotCsvResults(
  event: Event,
  test: Test,
  part: TestPart,
  pilots: Pilot[],
  scope: string
): ResultsComputation {
  const slots = (part.csvs || []).filter((s) => String(s.pilotNumber || "").trim());
  if (slots.length === 0) {
    return { rows: [], warning: "No hay CSV por piloto cargados en esta salida.", scope };
  }

  const workPart: TestPart = {
    ...part,
    csvs: slots.map((slot) => {
      const number = String(slot.pilotNumber || "").trim();
      const name =
        pilots.find((p) => normalizeNumber(p.number) === normalizeNumber(number))?.name || "";
      return {
        ...slot,
        parsed: stampPassagesToPilot(isolatePilotCsv(slot.parsed, number), number, name),
      };
    }),
  };

  if (isLapScoring(part)) {
    const rows: ResultRow[] = [];
    for (const slot of workPart.csvs) {
      const byPilot = lapResultsByPilot(slot.parsed);
      const p = [...byPilot.values()][0];
      if (!p) continue;
      rows.push(enrichLap(pilots, p.number, p.name, p.laps, p.totalTimeMs, workPart));
    }
    if (rows.length === 0) {
      return {
        rows: [],
        warning: "No se encontraron vueltas completadas en los CSV por piloto.",
        scope,
      };
    }
    return { rows: applyPenalties(rankLapRaw(rows), test.penalties, scope, true), scope };
  }

  const fastest = fastestLapRows(workPart, event, pilots, "CSV por piloto (mejor vuelta)");
  if (fastest.length > 0) {
    return {
      rows: mergeCompleteAndIncomplete(fastest, [], test.penalties, scope),
      scope,
    };
  }

  const complete: ResultRow[] = [];
  const incomplete: ResultRow[] = [];
  let nonPositive = 0;
  for (const slot of workPart.csvs) {
    const byPilot = combinedStartFinishByPilot(slot.parsed);
    nonPositive += byPilot.nonPositive;
    for (const p of byPilot.complete) {
      complete.push(
        enrich(
          pilots,
          p.number,
          p.name,
          p.timeMs,
          p.via === "passages"
            ? "CSV por piloto (Start → Finish)"
            : "CSV por piloto (Tiempo de vuelta)",
          workPart
        )
      );
    }
    for (const p of byPilot.incomplete) {
      incomplete.push(
        enrichIncomplete(
          pilots,
          p.number,
          p.name,
          "missing_finish",
          "Start",
          "Finish (2ª pasada)",
          workPart
        )
      );
    }
  }
  if (complete.length === 0 && incomplete.length === 0) {
    return {
      rows: [],
      warning:
        nonPositive > 0
          ? "Hay pasadas, pero el tiempo Start→Finish salió ≤ 0. Revisa el CSV de cada piloto."
          : "No se encontraron 2 pasadas (Start/Finish) ni tiempos de vuelta (> 0) en los CSV por piloto.",
      scope,
    };
  }
  return {
    rows: mergeCompleteAndIncomplete(complete, incomplete, test.penalties, scope),
    warning:
      nonPositive > 0
        ? `${nonPositive} piloto(s) con tiempo ≤ 0 entre 1ª y 2ª pasada.`
        : undefined,
    scope,
  };
}

export function computePartResults(
  event: Event,
  test: Test,
  part: TestPart,
  fromPointId?: string,
  toPointId?: string
): ResultsComputation {
  const points = [...event.timingPoints].sort((a, b) => a.order - b.order);
  const pilots = event.pilots || [];
  const scope = part.id;

  if (csvInputModeOf(part) === "pilots") {
    return computePilotCsvResults(event, test, part, pilots, scope);
  }

  if (part.combinedMode || csvInputModeOf(part) === "combined") {
    const slot = combinedCsvSlot(part);
    if (!slot) return { rows: [], warning: "No hay CSV cargado en esta parte.", scope };

    if (isLapScoring(part)) {
      const byPilot = lapResultsByPilot(slot.parsed);
      const rows: ResultRow[] = [];
      for (const [, p] of byPilot) {
        rows.push(enrichLap(pilots, p.number, p.name, p.laps, p.totalTimeMs, part));
      }
      if (rows.length === 0) {
        return {
          rows: [],
          warning:
            "No se encontraron vueltas completadas (Tiempo de vuelta > 0) en el CSV.",
          scope,
        };
      }
      return { rows: applyPenalties(rankLapRaw(rows), test.penalties, scope, true), scope };
    }

    const fastest = fastestLapRows(part, event, pilots, "CSV único (mejor vuelta)");
    if (fastest.length > 0) {
      return {
        rows: mergeCompleteAndIncomplete(fastest, [], test.penalties, scope),
        scope,
      };
    }

    const byPilot = combinedStartFinishByPilot(slot.parsed);
    const complete: ResultRow[] = byPilot.complete.map((p) =>
      enrich(
        pilots,
        p.number,
        p.name,
        p.timeMs,
        p.via === "passages"
          ? "CSV único (Start → Finish, mismo archivo)"
          : "CSV único (Tiempo de vuelta)",
        part
      )
    );
    const incomplete: ResultRow[] = byPilot.incomplete.map((p) =>
      enrichIncomplete(
        pilots,
        p.number,
        p.name,
        "missing_finish",
        "Start",
        "Finish (2ª pasada)",
        part
      )
    );
    if (complete.length === 0 && incomplete.length === 0) {
      return {
        rows: [],
        warning:
          byPilot.nonPositive > 0
            ? "Hay pasadas, pero el tiempo Start→Finish salió ≤ 0. Revisa el orden de Tm de pasos en el CSV."
            : "No se encontraron 2 pasadas (Start/Finish) ni tiempos de vuelta (> 0) en el CSV único.",
        scope,
      };
    }
    return {
      rows: mergeCompleteAndIncomplete(complete, incomplete, test.penalties, scope),
      warning:
        byPilot.nonPositive > 0
          ? `${byPilot.nonPositive} piloto(s) con tiempo ≤ 0 entre 1ª y 2ª pasada.`
          : undefined,
      scope,
    };
  }

  // Start/Finish + parcial(es): A sale, B parcial, A llega → sectores + total
  if (test.timingMode === "start_finish_partial") {
    return computeStartFinishPartial(event, test, part, pilots, scope);
  }

  const fromId = fromPointId ?? points[0]?.id;
  const toId = toPointId ?? points[1]?.id;
  if (!fromId || !toId) {
    return { rows: [], warning: "Selecciona puntos de cronometraje Desde y Hasta.", scope };
  }
  if (fromId === toId) {
    return { rows: [], warning: "Los puntos Desde y Hasta deben ser diferentes.", scope };
  }

  const fromSlot = part.csvs.find((c) => c.timingPointId === fromId);
  const toSlot = part.csvs.find((c) => c.timingPointId === toId);
  const fromPoint = points.find((p) => p.id === fromId);
  const toPoint = points.find((p) => p.id === toId);
  const fromLabel = fromPoint?.name ?? "Desde";
  const toLabel = toPoint?.name ?? "Hasta";

  if (!fromSlot && !toSlot) {
    return { rows: [], warning: `Falta cargar los CSV de ${fromLabel} y ${toLabel}.`, scope };
  }

  const fromByPilot = fromSlot
    ? racePassagesByPilot(fromSlot.parsed)
    : new Map<string, PassageHit[]>();
  const toByPilot = toSlot ? racePassagesByPilot(toSlot.parsed) : new Map<string, PassageHit[]>();

  if (fromByPilot.size === 0 && toByPilot.size === 0) {
    return {
      rows: [],
      warning:
        "Uno o ambos CSV no tienen pasadas de carrera válidas (N° + Tm de pasos dentro de bandera verde).",
      scope,
    };
  }

  const complete: ResultRow[] = [];
  const incomplete: ResultRow[] = [];
  let nonPositive = 0;
  const allKeys = new Set<string>([...fromByPilot.keys(), ...toByPilot.keys()]);

  for (const key of allKeys) {
    const fromList = fromByPilot.get(key) || [];
    const toList = toByPilot.get(key) || [];
    // First race hit at each point (Tm de pasos). Works for A→B and B→A once offsets sync clocks.
    const from0 = fromList[0];
    const to0 = toList[0];

    if (from0 && to0) {
      const tFrom = correctedTime(from0.tm, fromPoint);
      const tTo = correctedTime(to0.tm, toPoint);
      const delta = tTo - tFrom;
      if (delta <= 0) {
        nonPositive++;
        continue;
      }
      complete.push(
        enrich(
          pilots,
          from0.number,
          pickName(from0.name, to0.name),
          delta,
          `${fromLabel} → ${toLabel}`,
          part
        )
      );
      continue;
    }

    if (from0 && !to0) {
      incomplete.push(
        enrichIncomplete(
          pilots,
          from0.number,
          from0.name,
          "missing_finish",
          fromLabel,
          toLabel,
          part
        )
      );
      continue;
    }

    if (!from0 && to0) {
      const earlierFrom = findEarlierFromPassage(event, test, part, fromId, key);
      if (earlierFrom) {
        const tFrom = correctedTime(earlierFrom.passage.tm, earlierFrom.point);
        const tTo = correctedTime(to0.tm, toPoint);
        const delta = tTo - tFrom;
        if (delta <= 0) {
          nonPositive++;
        } else {
          complete.push(
            enrich(
              pilots,
              to0.number,
              pickName(to0.name, earlierFrom.passage.name),
              delta,
              `${fromLabel} (${earlierFrom.part.name}) → ${toLabel} (${part.name})`,
              part
            )
          );
        }
      } else {
        incomplete.push(
          enrichIncomplete(pilots, to0.number, to0.name, "missing_start", fromLabel, toLabel, part)
        );
      }
    }
  }

  if (complete.length === 0 && incomplete.length === 0) {
    if (nonPositive > 0) {
      return {
        rows: [],
        warning: `Se emparejaron piloto(s), pero todos los tiempos salieron ≤ 0 tras aplicar desfases. Si el inicio (p. ej. B) va adelantado respecto a A, su desfase debe ser positivo (se resta a Tm de pasos).`,
        scope,
      };
    }
    return {
      rows: [],
      warning: "No hay pasadas válidas para emparejar entre los CSV.",
      scope,
    };
  }

  const warning =
    nonPositive > 0
      ? `${nonPositive} piloto(s) quedaron sin tiempo (≤ 0 tras desfase). Revisa el desfase del punto de inicio.`
      : undefined;

  return {
    rows: mergeCompleteAndIncomplete(complete, incomplete, test.penalties, scope),
    warning,
    scope,
  };
}

type PassageHit = { number: string; name: string; tm: number; lap: number | null };

type PartialPointMeta = {
  id: string;
  point: TimingPoint | undefined;
  label: string;
  byPilot: Map<string, PassageHit[]>;
  hasCsv: boolean;
};

/**
 * Pick one hit per configured partial.
 * - With finish: prefer hits strictly between start/finish; fall back to first after start
 *   so live/clock-skew cases can still publish trayecto A.
 * - Without finish (race still running): first hit after start is enough.
 * Stops at the first missing partial so we can publish the prefix (e.g. only 1er trayecto).
 */
function collectPartialWaypoints(
  partialMeta: PartialPointMeta[],
  key: string,
  tStart: number,
  tFinish: number | null
): { label: string; t: number; name: string; number: string }[] {
  const waypoints: { label: string; t: number; name: string; number: string }[] = [];

  for (const pm of partialMeta) {
    if (!pm.hasCsv) break;
    const list = pm.byPilot.get(key) || [];
    let hit: PassageHit | undefined;

    if (tFinish != null) {
      hit = list.find((h) => {
        const t = correctedTime(h.tm, pm.point);
        return t > tStart && t < tFinish;
      });
    }
    if (!hit) {
      // Live / unfinished: first hit after start is enough for trayecto A
      hit = list.find((h) => correctedTime(h.tm, pm.point) > tStart);
    }

    if (!hit) break;

    const t = correctedTime(hit.tm, pm.point);
    waypoints.push({
      label: pm.label,
      t,
      name: hit.name,
      number: hit.number,
    });
  }

  waypoints.sort((a, b) => a.t - b.t);
  return waypoints;
}

function buildSectorSegments(
  path: { label: string; t: number }[]
): ResultSegment[] | null {
  const segments: ResultSegment[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const delta = path[i + 1].t - path[i].t;
    if (delta <= 0) return null;
    segments.push({
      from: path[i].label,
      to: path[i + 1].label,
      timeMs: delta,
      timeFormatted: formatMs(delta),
    });
  }
  return segments.length > 0 ? segments : null;
}

/**
 * Start/Finish + parcial: prefer full SF→parcial(es)→SF when data exists.
 * If the race is still running (no 2ª pasada en SF), still publish available
 * sectors (e.g. trayecto A = SF→parcial) so they can go to the board live.
 */
function computeStartFinishPartial(
  event: Event,
  test: Test,
  part: TestPart,
  pilots: Pilot[],
  scope: string
): ResultsComputation {
  const points = [...event.timingPoints].sort((a, b) => a.order - b.order);
  const sfId = test.startFinishPointId || test.fromPointId || points[0]?.id;
  const partialIds =
    test.partialPointIds && test.partialPointIds.length > 0
      ? test.partialPointIds
      : test.toPointId
        ? [test.toPointId]
        : points.filter((p) => p.id !== sfId).map((p) => p.id);

  if (!sfId) {
    return { rows: [], warning: "Configura el punto Start/Finish de la prueba.", scope };
  }
  if (partialIds.length === 0) {
    return { rows: [], warning: "Configura al menos un punto parcial.", scope };
  }
  if (partialIds.includes(sfId)) {
    return {
      rows: [],
      warning: "El punto Start/Finish no puede ser también un parcial.",
      scope,
    };
  }

  const sfPoint = points.find((p) => p.id === sfId);
  const sfLabel = sfPoint?.name ?? "Start/Finish";
  const sfSlot = part.csvs.find((c) => c.timingPointId === sfId);
  if (!sfSlot) {
    return { rows: [], warning: `Falta cargar el CSV de ${sfLabel} (Start/Finish).`, scope };
  }

  const partialMeta: PartialPointMeta[] = partialIds.map((id) => {
    const point = points.find((p) => p.id === id);
    const slot = part.csvs.find((c) => c.timingPointId === id);
    return {
      id,
      point,
      label: point?.name ?? "Parcial",
      byPilot: slot ? racePassagesByPilot(slot.parsed) : new Map<string, PassageHit[]>(),
      hasCsv: Boolean(slot),
    };
  });

  // Need at least the first partial CSV to publish trayecto A live.
  if (!partialMeta[0]?.hasCsv) {
    return {
      rows: [],
      warning: `Falta cargar el CSV de: ${partialMeta[0]?.label || "parcial"}.`,
      scope,
    };
  }

  const sfByPilot = racePassagesByPilot(sfSlot.parsed);
  const complete: ResultRow[] = [];
  const incomplete: ResultRow[] = [];
  let nonPositive = 0;
  let inProgressCount = 0;

  const allKeys = new Set<string>([
    ...sfByPilot.keys(),
    ...partialMeta.flatMap((p) => [...p.byPilot.keys()]),
  ]);

  for (const key of allKeys) {
    const sfList = sfByPilot.get(key) || [];
    const start = sfList[0];
    const finish = sfList[1];

    if (!start) {
      const anyPartial = partialMeta.find((p) => (p.byPilot.get(key) || []).length > 0);
      const hit = anyPartial?.byPilot.get(key)?.[0];
      if (hit) {
        incomplete.push(
          enrichIncomplete(
            pilots,
            hit.number,
            hit.name,
            "missing_start",
            sfLabel,
            anyPartial!.label,
            part
          )
        );
      }
      continue;
    }

    const tStart = correctedTime(start.tm, sfPoint);
    const tFinish = finish ? correctedTime(finish.tm, sfPoint) : null;
    if (tFinish != null && tFinish - tStart <= 0) {
      nonPositive++;
      continue;
    }

    const waypoints = collectPartialWaypoints(partialMeta, key, tStart, tFinish);
    const raceComplete =
      tFinish != null && waypoints.length === partialMeta.filter((p) => p.hasCsv).length;

    if (waypoints.length === 0) {
      incomplete.push(
        enrichIncomplete(
          pilots,
          start.number,
          start.name,
          "missing_finish",
          sfLabel,
          partialMeta[0]?.label || "parcial",
          part
        )
      );
      continue;
    }

    const path = [
      { label: sfLabel, t: tStart },
      ...waypoints.map((w) => ({ label: w.label, t: w.t })),
      ...(raceComplete && tFinish != null ? [{ label: sfLabel, t: tFinish }] : []),
    ];

    const segments = buildSectorSegments(path);
    if (!segments) {
      // e.g. partial corrected before start — still try SF→first waypoint if times allow later
      nonPositive++;
      continue;
    }

    const totalMs = raceComplete && tFinish != null
      ? tFinish - tStart
      : segments.reduce((sum, s) => sum + s.timeMs, 0);
    const label = segments.map((s) => `${s.from}→${s.to}`).join(" + ");
    const row = enrich(
      pilots,
      start.number,
      pickName(start.name, finish?.name, waypoints[0]?.name),
      totalMs,
      raceComplete
        ? `${label} · Total ${sfLabel}→${sfLabel}`
        : `${label} · En curso`,
      part,
      segments
    );
    if (!raceComplete) {
      inProgressCount++;
      row.statusLabel = "En curso";
    }
    complete.push(row);
  }

  if (complete.length === 0 && incomplete.length === 0) {
    return {
      rows: [],
      warning:
        nonPositive > 0
          ? "Los tiempos parciales salieron ≤ 0. Revisa desfases y el orden de pasadas."
          : "No hay pasadas válidas para el modo Start/Finish + parcial.",
      scope,
    };
  }

  const warnings: string[] = [];
  if (inProgressCount > 0) {
    warnings.push(
      `${inProgressCount} piloto(s) con parcial en curso (publicable; falta llegada a ${sfLabel}).`
    );
  }
  if (nonPositive > 0) {
    warnings.push(
      `${nonPositive} piloto(s) sin tiempo válido (≤ 0). Revisa desfases / orden de pasadas.`
    );
  }

  return {
    rows: mergeCompleteAndIncomplete(complete, incomplete, test.penalties, scope),
    warning: warnings.length ? warnings.join(" ") : undefined,
    scope,
  };
}

export function computeTestResults(
  event: Event,
  test: Test,
  fromPointId?: string,
  toPointId?: string
): ResultsComputation {
  const best = new Map<string, ResultRow>();
  const warnings: string[] = [];
  const scope = UNIFIED_SCOPE;

  if (test.parts.length === 0) {
    return { rows: [], warning: "La prueba no tiene partes/salidas.", scope };
  }

  for (const part of test.parts) {
    // Best raw time across salidas; shared penalties applied after selection
    const raw = computePartResultsRaw(event, test, part, fromPointId, toPointId);
    if (raw.warning) warnings.push(`${part.name}: ${raw.warning}`);
    for (const row of raw.rows) {
      if (row.incomplete) continue;
      const key = normalizeNumber(row.number);
      const prev = best.get(key);
      if (!prev) {
        best.set(key, { ...row, partId: part.id, partName: part.name });
        continue;
      }
      const better =
        isLapScoring(part) || (prev.laps != null && row.laps != null)
          ? compareLapResultRows(row, prev) < 0
          : row.rawTimeMs < prev.rawTimeMs;
      if (better) {
        best.set(key, { ...row, partId: part.id, partName: part.name });
      }
    }
  }

  const values = [...best.values()];
  const useLapRank = test.parts.some((p) => isLapScoring(p));
  const rows = applyPenalties(
    useLapRank ? rankLapRaw(values) : rankRaw(values),
    test.penalties,
    scope,
    useLapRank
  );
  if (rows.length === 0) {
    return {
      rows: [],
      warning: warnings[0] || "No hay resultados unificados para esta prueba.",
      scope,
    };
  }
  return { rows, scope };
}

/** Part results without applying penalties (for unified / diff). Keeps lookback across salidas. */
function computePartResultsRaw(
  event: Event,
  test: Test,
  part: TestPart,
  fromPointId?: string,
  toPointId?: string
): { rows: ResultRow[]; warning?: string } {
  const noPenalties: Test = { ...test, penalties: [] };
  const { rows, warning } = computePartResults(event, noPenalties, part, fromPointId, toPointId);
  return { rows, warning };
}

export function upsertPenalty(
  test: Test,
  input: {
    number: string;
    scope?: string;
    timePenaltyMs?: number;
    positionPenalty?: number;
    comment?: string;
  }
): Test {
  const number = String(input.number || "").trim();
  if (!number) throw new Error("N° de piloto requerido");

  const timePenaltyMs = Math.max(0, Math.round(input.timePenaltyMs || 0));
  const positionPenalty = Math.max(0, Math.round(input.positionPenalty || 0));
  const comment = (input.comment || "").trim();

  // One penalty per pilot for the whole test (shared across salidas + unificado)
  const penalties = (test.penalties || []).filter(
    (p) => normalizeNumber(p.number) !== normalizeNumber(number)
  );

  const empty = timePenaltyMs === 0 && positionPenalty === 0 && !comment;
  if (!empty) {
    penalties.push({
      number,
      scope: SHARED_PENALTY_SCOPE,
      timePenaltyMs,
      positionPenalty,
      comment,
    });
  }

  test.penalties = penalties;
  return test;
}

export function getTest(event: Event, testId: string): Test | undefined {
  return event.tests.find((t) => t.id === testId);
}

export function getPart(test: Test, partId: string): TestPart | undefined {
  return test.parts.find((p) => p.id === partId);
}
