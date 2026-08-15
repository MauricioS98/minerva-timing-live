import type { FlagEvent, FlagType, ParsedCsv, Passage } from "./types.js";
import { parseTimeToMs } from "./timeUtils.js";

/** How the CSV was produced / how deletions should be detected */
export type CsvSourceFormat = "orbits4" | "orbits5";
/** Preference: force a reader or auto-detect from headers */
export type CsvSourcePreference = "auto" | CsvSourceFormat;

function classifyFlag(nombre: string, numero: string): FlagType | null {
  const n = nombre.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const num = numero.trim();

  if (/manual\s*no\s*asignado/i.test(n) || num === "??") return "manual";
  if (/bandera\s*de\s*calentamiento|bandera\s*morada|calentamiento/i.test(n)) return "warmup";
  if (/bandera\s*verde/i.test(n)) return "green";
  if (/bandera\s*de\s*finalizacion|bandera\s*a\s*cuadros|cuadros|checkered|finalizaci/i.test(n)) {
    return "checkered";
  }
  if (/carrera\s*parada/i.test(n)) return "stopped";
  if (!num && n) return "other";
  return null;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Some exports wrap each row as a single CSV field:
 *   `"#,""N°"",""Nombre"",..."`
 * After one unwrap pass that becomes a normal CSV line:
 *   `#,\"N°\",\"Nombre\",...`
 */
function unwrapCsvLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"') || !trimmed.includes('""')) return trimmed;
  const once = parseCsvLine(trimmed);
  if (once.length === 1 && /,(?:"|N|Tm|#)/i.test(once[0])) {
    return once[0];
  }
  return trimmed;
}

function parseCsvRow(line: string): string[] {
  return parseCsvLine(unwrapCsvLine(line)).map((h) => h.trim());
}

function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .replace(/\uFFFD/g, "") // mojibake from latin1 read as utf8
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function findCol(headers: string[], ...names: string[]): number {
  const normalized = headers.map(normalizeHeader);
  // Prefer exact header match first (avoids "Nombre" matching "no", etc.)
  for (const name of names) {
    const target = normalizeHeader(name);
    const exact = normalized.findIndex((h) => h === target);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    const target = normalizeHeader(name);
    // Only allow includes for longer targets to avoid false positives
    if (target.length < 4) continue;
    const idx = normalized.findIndex((h) => h.includes(target));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Orbits "N°" column — never the leading "#" row index. */
function findPilotNumberCol(headers: string[]): number {
  const byName = findCol(headers, "n°", "nº", "numero", "n");
  if (byName >= 0) return byName;
  // Plain "N" / "No" after stripping accents/mojibake (not "Nombre")
  const normalized = headers.map(normalizeHeader);
  const idx = normalized.findIndex((h) => h === "n" || h === "no");
  return idx;
}

/**
 * Orbits often exports Windows-1252. If UTF-8 decode produces , re-read as latin1.
 */
export function decodeCsvContent(content: string | Buffer): string {
  if (typeof content === "string") {
    if (!content.includes("\uFFFD")) return content.replace(/^\uFEFF/, "");
    // Already a string with replacement chars — best-effort strip for headers
    return content.replace(/^\uFEFF/, "");
  }
  const asUtf8 = content.toString("utf8");
  if (!asUtf8.includes("\uFFFD")) return asUtf8.replace(/^\uFEFF/, "");
  return content.toString("latin1").replace(/^\uFEFF/, "");
}

function normalizePilotKey(n: string): string {
  return String(n || "")
    .replace(/^#/, "")
    .trim()
    .toLowerCase();
}

function isDeletedBorrado(raw: string): boolean {
  const v = raw.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return v === "yes" || v === "si" || v === "true" || v === "1" || v === "y";
}

/**
 * Orbits 5 exports include a "Borrado" column; Orbits 4 does not.
 */
export function detectCsvSourceFormat(headers: string[]): CsvSourceFormat {
  return findCol(headers, "borrado") >= 0 ? "orbits5" : "orbits4";
}

export function resolveCsvSourceFormat(
  headers: string[],
  preference: CsvSourcePreference = "auto"
): CsvSourceFormat {
  if (preference === "orbits4" || preference === "orbits5") return preference;
  return detectCsvSourceFormat(headers);
}

/**
 * Orbits 4 has no "Borrado" flag. Soft-deleted hits keep the same "Vueltas"
 * count as the previous valid hit for that pilot (and usually the same
 * T° Transcurrido). Drop those rows so they never enter timing.
 */
export function filterOrbits4DeletedPassages(passages: Passage[]): {
  passages: Passage[];
  skipped: number;
} {
  const ordered = [...passages].sort(
    (a, b) => a.rowIndex - b.rowIndex || a.tmPasosMs - b.tmPasosMs
  );
  const lastLaps = new Map<string, number>();
  const lastElapsed = new Map<string, number>();
  const kept: Passage[] = [];
  let skipped = 0;

  for (const p of ordered) {
    const key = normalizePilotKey(p.number);
    const laps = p.lapsCount;
    const elapsed = p.elapsedMs;

    if (laps != null) {
      const prev = lastLaps.get(key);
      if (prev == null) {
        lastLaps.set(key, laps);
        if (elapsed != null) lastElapsed.set(key, elapsed);
        kept.push(p);
        continue;
      }
      if (laps > prev) {
        lastLaps.set(key, laps);
        if (elapsed != null) lastElapsed.set(key, elapsed);
        kept.push(p);
        continue;
      }
      // Same or lower Vueltas than last accepted hit → deleted in Orbits 4
      skipped++;
      continue;
    }

    // No Vueltas column / empty: fall back to elapsed not advancing
    if (elapsed != null) {
      const prevEl = lastElapsed.get(key);
      if (prevEl != null && elapsed <= prevEl && p.lapTimeMs != null && p.lapTimeMs > 0) {
        skipped++;
        continue;
      }
      lastElapsed.set(key, elapsed);
    }

    kept.push(p);
  }

  kept.sort((a, b) => a.rowIndex - b.rowIndex);
  return { passages: kept, skipped };
}

/**
 * Extract race windows: from each Bandera Verde until Carrera parada / end,
 * including checkered (last pass at finish still counts).
 */
export function extractRacePassages(passages: Passage[], flags: FlagEvent[]): Passage[] {
  if (flags.length === 0) {
    // No flags → use all pilot passages
    return [...passages];
  }

  const timeline = [
    ...passages.map((p) => ({
      kind: "passage" as const,
      order: p.rowIndex,
      ms: p.tmPasosMs,
      passage: p,
    })),
    ...flags.map((f) => ({
      kind: "flag" as const,
      order: f.rowIndex,
      ms: f.tmPasosMs,
      flag: f,
    })),
  ].sort((a, b) => a.order - b.order || a.ms - b.ms || (a.kind === "flag" ? -1 : 1));

  const racePassages: Passage[] = [];
  let inRace = false;
  let sawGreen = false;

  for (const item of timeline) {
    if (item.kind === "flag") {
      if (item.flag.type === "green") {
        inRace = true;
        sawGreen = true;
      } else if (item.flag.type === "stopped") {
        inRace = false;
      } else if (item.flag.type === "checkered") {
        // Checkered marks last finish pass window; keep collecting until stopped or end
        inRace = true;
        sawGreen = true;
      }
      // warmup / other / manual: do not start race
      continue;
    }
    if (inRace) {
      racePassages.push(item.passage);
    }
  }

  // If there was never a green flag, fall back to all passages
  if (!sawGreen) return [...passages];
  return racePassages;
}

export function parseTimingCsv(
  content: string | Buffer,
  filename: string,
  preference: CsvSourcePreference = "auto"
): ParsedCsv {
  const lines = decodeCsvContent(content)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return {
      filename,
      passages: [],
      flags: [],
      racePassages: [],
      sourceFormat: "orbits5",
      deletedSkipped: 0,
    };
  }

  const headers = parseCsvRow(lines[0]);
  const sourceFormat = resolveCsvSourceFormat(headers, preference);
  const colNumero = findPilotNumberCol(headers);
  const colNombre = findCol(headers, "nombre");
  const colTm = findCol(headers, "tm de pasos", "tm pasos");
  const colLap = findCol(headers, "tiempo de vuelta");
  const colClase = findCol(headers, "clase");
  const colLaps = findCol(headers, "vueltas");
  const colElapsed = findCol(
    headers,
    "t° transcurrido",
    "t transcurrido",
    "tiempo transcurrido",
    "tempo transcurrido"
  );
  const colBorrado = findCol(headers, "borrado");

  if (colNumero < 0 || colTm < 0) {
    throw new Error('El CSV debe contener las columnas "N°" y "Tm de pasos"');
  }

  let passages: Passage[] = [];
  const flags: FlagEvent[] = [];
  let deletedSkipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const numero = (cols[colNumero] ?? "").trim();
    const nombre = colNombre >= 0 ? (cols[colNombre] ?? "").trim() : "";
    const tmRaw = (cols[colTm] ?? "").trim();
    const lapRaw = colLap >= 0 ? (cols[colLap] ?? "").trim() : "";
    const lapsRaw = colLaps >= 0 ? (cols[colLaps] ?? "").trim() : "";
    const elapsedRaw = colElapsed >= 0 ? (cols[colElapsed] ?? "").trim() : "";
    const clase = colClase >= 0 ? (cols[colClase] ?? "").trim() : "";
    const borradoRaw = colBorrado >= 0 ? (cols[colBorrado] ?? "").trim() : "";
    const tmMs = parseTimeToMs(tmRaw);
    if (tmMs === null) continue;

    // Orbits 5: soft-deleted hits marked in "Borrado"
    if (sourceFormat === "orbits5" && colBorrado >= 0 && isDeletedBorrado(borradoRaw)) {
      deletedSkipped++;
      continue;
    }

    const flagType = classifyFlag(nombre, numero);
    if (flagType === "manual") continue;

    if (flagType && flagType !== "other") {
      flags.push({
        type: flagType,
        tmPasosMs: tmMs,
        tmPasosRaw: tmRaw,
        label: nombre,
        rowIndex: i,
      });
      continue;
    }

    // Rows without a number are event markers, not pilots. Pilot names are optional.
    if (!numero) {
      if (flagType === "other") {
        flags.push({
          type: "other",
          tmPasosMs: tmMs,
          tmPasosRaw: tmRaw,
          label: nombre,
          rowIndex: i,
        });
      }
      continue;
    }

    const lapMs = parseTimeToMs(lapRaw);
    const hasLap =
      lapRaw !== "" &&
      lapRaw !== "0" &&
      lapRaw !== "0.0" &&
      lapRaw !== "0,0" &&
      lapMs !== null &&
      lapMs > 0;
    const lapsCount = lapsRaw !== "" ? Number(lapsRaw) : null;
    const elapsedMs = elapsedRaw ? parseTimeToMs(elapsedRaw) : null;

    passages.push({
      number: numero,
      name: nombre,
      tmPasosMs: tmMs,
      tmPasosRaw: tmRaw,
      lapTimeMs: hasLap ? lapMs : null,
      lapTimeRaw: lapRaw,
      lapsCount: lapsCount != null && !Number.isNaN(lapsCount) ? Math.floor(lapsCount) : null,
      elapsedMs: elapsedMs ?? null,
      clase,
      rowIndex: i,
    });
  }

  // Orbits 4: no Borrado column — drop hits where Vueltas did not increase
  if (sourceFormat === "orbits4") {
    const filtered = filterOrbits4DeletedPassages(passages);
    passages = filtered.passages;
    deletedSkipped += filtered.skipped;
  }

  const racePassages = extractRacePassages(passages, flags);

  return {
    filename,
    passages,
    flags,
    racePassages,
    sourceFormat,
    deletedSkipped,
  };
}
