/** Role of a timing point within a test circuit */
export type TimingPointRole = "generic" | "start_finish" | "partial" | "start" | "finish";

export interface TimingPoint {
  id: string;
  name: string;
  /** Offset in milliseconds relative to the first timing point (reference) */
  offsetMs: number;
  order: number;
  /** Optional default role hint for UI (tests can override) */
  role?: TimingPointRole;
}

/** How a test measures times across timing points */
export type TestTimingMode = "point_to_point" | "start_finish_partial";

/** One measured sector inside a start/finish + partial result */
export interface ResultSegment {
  from: string;
  to: string;
  timeMs: number;
  timeFormatted: string;
}

export interface Pilot {
  id: string;
  number: string;
  name: string;
  category: string;
  league: string;
  notes?: string;
}

export interface Passage {
  number: string;
  name: string;
  tmPasosMs: number;
  tmPasosRaw: string;
  lapTimeMs: number | null;
  lapTimeRaw: string;
  /** Lap counter from Vueltas column */
  lapsCount: number | null;
  /** Elapsed race time from T° Transcurrido column */
  elapsedMs: number | null;
  clase: string;
  rowIndex: number;
}

export type CombinedScoring = "time" | "laps";

/** How CSVs are attached to a salida */
export type CsvInputMode = "points" | "combined" | "pilots";

export function csvInputModeOf(part: {
  csvInputMode?: CsvInputMode;
  combinedMode?: boolean;
}): CsvInputMode {
  if (
    part.csvInputMode === "pilots" ||
    part.csvInputMode === "combined" ||
    part.csvInputMode === "points"
  ) {
    return part.csvInputMode;
  }
  return part.combinedMode ? "combined" : "points";
}

export type FlagType =
  | "warmup"
  | "green"
  | "checkered"
  | "stopped"
  | "manual"
  | "other";

export interface FlagEvent {
  type: FlagType;
  tmPasosMs: number;
  tmPasosRaw: string;
  label: string;
  rowIndex: number;
}

export interface ParsedCsv {
  filename: string;
  passages: Passage[];
  flags: FlagEvent[];
  /** Passages inside green → stopped/checkered windows */
  racePassages: Passage[];
  /** Detected or forced Orbits reader used when parsing */
  sourceFormat?: "orbits4" | "orbits5";
  /** Soft-deleted hits skipped (Borrado=Yes or Vueltas sin incrementar) */
  deletedSkipped?: number;
}

export interface PartCsvSlot {
  timingPointId: string;
  filename: string;
  parsed: ParsedCsv;
  /** When the salida uses CSV por piloto */
  pilotNumber?: string;
}

/** One VS matchup in the start-order overlay (pilot numbers). */
export interface StartOrderVsPair {
  a: string;
  b: string;
}

export interface TestPart {
  id: string;
  name: string;
  order: number;
  /** When true, a single CSV already contains both times via Tiempo de vuelta */
  combinedMode: boolean;
  /** points = CSV por punto; combined = CSV único; pilots = un CSV por piloto */
  csvInputMode?: CsvInputMode;
  /** How to rank combined CSV results (default: time) */
  combinedScoring?: CombinedScoring;
  /** Expected laps when combinedScoring is laps; null = indeterminate */
  expectedLaps?: number | null;
  /** VS pairs for Orden de salida overlay */
  startOrderVs?: StartOrderVsPair[];
  csvs: PartCsvSlot[];
}

/** Penalty applied to a pilot within a test (shared across all salidas and unified results) */
export interface PilotPenalty {
  number: string;
  /** Kept for compatibility; penalties are shared per pilot in the test */
  scope: string;
  timePenaltyMs: number;
  positionPenalty: number;
  comment: string;
}

export interface Test {
  id: string;
  name: string;
  description: string;
  /** Include description in PDF export */
  showDescriptionInPdf: boolean;
  order: number;
  /**
   * point_to_point: single Desde→Hasta (default).
   * start_finish_partial: start/finish point + intermediate partial(s) → sectors + total.
   */
  timingMode?: TestTimingMode;
  /** Timing segment for unified results / fusion (point ids) — point_to_point mode */
  fromPointId?: string | null;
  toPointId?: string | null;
  /** Start/finish point id when timingMode is start_finish_partial */
  startFinishPointId?: string | null;
  /** Intermediate partial point ids when timingMode is start_finish_partial */
  partialPointIds?: string[];
  parts: TestPart[];
  penalties: PilotPenalty[];
}

export interface FusionTestMeta {
  id: string;
  name: string;
  segmentLabel: string;
}

export interface FusionTestTime {
  testId: string;
  testName: string;
  segmentLabel: string;
  timeMs: number | null;
  timeFormatted: string;
  laps?: number;
}

export interface FusionRow {
  position: number;
  number: string;
  name: string;
  category: string;
  league: string;
  totalTimeMs: number;
  totalTimeFormatted: string;
  testsCount: number;
  byTest: FusionTestTime[];
}

export interface SavedFusion {
  id: string;
  name: string;
  testIds: string[];
  tests: FusionTestMeta[];
  rows: FusionRow[];
  warning?: string | null;
  createdAt: string;
}

/** Entry on the public results board (publication order) */
export interface ResultsBoardEntry {
  id: string;
  /** Unified test result or saved fusion */
  kind: "unified" | "fusion";
  /** testId or fusionId */
  refId: string;
  /**
   * When kind is unified and partId is set, the board shows that salida
   * (useful for start/finish + parcial) instead of the unified best time.
   */
  partId?: string | null;
  title: string;
  publishedAt: string;
  order: number;
}

export interface Event {
  id: string;
  name: string;
  date: string;
  location: string;
  headerImage: string | null;
  footerText: string;
  /**
   * Password required to open the management panel.
   * Never returned by public/list APIs. Existing events without one get "00000".
   */
  password: string;
  /** 4 colores del evento: [acento, resaltado, fondo paneles, texto]. null = paleta Minerva Timing */
  themeColors?: string[] | null;
  timingPoints: TimingPoint[];
  /** Pilots registered for this event only */
  pilots: Pilot[];
  tests: Test[];
  fusions?: SavedFusion[];
  /** Public board: unified results + fusions in publish order */
  resultsBoard?: ResultsBoardEntry[];
  /**
   * Seconds between auto page changes on the public board (10 pilots per page).
   * Default 10. Overlay is unaffected.
   */
  boardPageSeconds?: number;
  /** Broadcast overlay style: classic Minerva tower, RedBull, or Pony Malta */
  overlayVariant?: "classic" | "redbull" | "ponymalta";
  /** Overlay times: sector traps + total, or total only */
  overlayTiming?: "splits" | "total";
  /**
   * CSV reader for Orbits exports.
   * auto = detect from headers (Borrado → Orbits 5; sin Borrado → Orbits 4).
   */
  csvSource?: "auto" | "orbits4" | "orbits5";
  /** Single published Orden de salida for the VS overlay (null = none) */
  publishedStartOrder?: { testId: string; partId: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResultRow {
  position: number;
  number: string;
  name: string;
  category: string;
  league: string;
  /** Time before penalties */
  rawTimeMs: number;
  rawTimeFormatted: string;
  /** Time after time penalty */
  timeMs: number;
  timeFormatted: string;
  timePenaltyMs: number;
  positionPenalty: number;
  comment: string;
  hasPenalty: boolean;
  partId?: string;
  partName?: string;
  missingPilot: boolean;
  segmentLabel: string;
  /** True when only one timing point is present (not exportable to PDF) */
  incomplete?: boolean;
  incompleteReason?: "missing_start" | "missing_finish";
  /** Human-readable status for incomplete rows */
  statusLabel?: string;
  /** Completed laps (combined lap mode) */
  laps?: number;
  /** Expected laps for this heat (null = indeterminate) */
  expectedLaps?: number | null;
  /** True when laps < expected in lap mode */
  lapsIncomplete?: boolean;
  /**
   * Sector times when timingMode is start_finish_partial
   * (e.g. A→B, B→A). Ranking still uses timeMs (= total).
   */
  segments?: ResultSegment[];
  /** Last completed lap time from CSV "Tiempo de vuelta" */
  lastLapMs?: number;
  lastLapFormatted?: string;
}
