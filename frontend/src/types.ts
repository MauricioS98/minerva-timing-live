export type TimingPointRole = "generic" | "start_finish" | "partial" | "start" | "finish";

export interface TimingPoint {
  id: string;
  name: string;
  offsetMs: number;
  order: number;
  offsetFormatted?: string;
  role?: TimingPointRole;
}

export type TestTimingMode = "point_to_point" | "start_finish_partial";

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
  lapsCount?: number | null;
  elapsedMs?: number | null;
  clase: string;
}

export type CombinedScoring = "time" | "laps";

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

export interface FlagEvent {
  type: string;
  tmPasosMs: number;
  tmPasosRaw: string;
  label: string;
}

export interface ParsedCsv {
  filename: string;
  passages: Passage[];
  flags: FlagEvent[];
  racePassages: Passage[];
}

export interface PartCsvSlot {
  timingPointId: string;
  filename: string;
  parsed: ParsedCsv;
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
  combinedMode: boolean;
  csvInputMode?: CsvInputMode;
  combinedScoring?: CombinedScoring;
  expectedLaps?: number | null;
  /** VS pairs for Orden de salida overlay */
  startOrderVs?: StartOrderVsPair[];
  csvs: PartCsvSlot[];
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
  showDescriptionInPdf: boolean;
  order: number;
  timingMode?: TestTimingMode;
  fromPointId?: string | null;
  toPointId?: string | null;
  startFinishPointId?: string | null;
  partialPointIds?: string[];
  parts: TestPart[];
  penalties: PilotPenalty[];
}

export interface SavedFusion {
  id: string;
  name: string;
  testIds: string[];
  tests: { id: string; name: string; segmentLabel: string }[];
  rows: FusionRow[];
  warning?: string | null;
  createdAt: string;
}

export interface ResultsBoardEntry {
  id: string;
  kind: "unified" | "fusion";
  refId: string;
  /** If set with kind=unified, publishes that salida instead of the unified result */
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
  /** Present only when the API intentionally includes it; normally stripped */
  password?: string;
  timingPoints: TimingPoint[];
  pilots: Pilot[];
  tests: Test[];
  fusions?: SavedFusion[];
  resultsBoard?: ResultsBoardEntry[];
  /** Segundos entre cambios de página en el tablero público (10 pilotos/página) */
  boardPageSeconds?: number;
  /** Overlay de transmisión: torre Minerva, paquete RedBull o Circuito Pony Malta */
  overlayVariant?: "classic" | "redbull" | "ponymalta";
  /** Overlay: 3 times (trayectos + total) or total only */
  overlayTiming?: "splits" | "total";
  /** true = overlays recargan datos cada 5s; false = se queda el último cuadro */
  overlayLiveRefresh?: boolean;
  overlayPagingMode?: "auto" | "manual";
  overlayPilotPage?: number;
  overlayLapPage?: number;
  /**
   * Lectura de CSV Orbits: auto (detecta Borrado), orbits5 (columna Borrado),
   * orbits4 (Vueltas sin incrementar = borrada).
   */
  csvSource?: "auto" | "orbits4" | "orbits5";
  /** Single published Orden de salida for the VS overlay */
  publishedStartOrder?: { testId: string; partId: string } | null;
  /** 4 colores del evento: [acento, resaltado, fondo paneles, texto]. null = paleta Minerva Timing */
  themeColors?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResultRow {
  position: number;
  number: string;
  name: string;
  category: string;
  league: string;
  rawTimeMs: number;
  rawTimeFormatted: string;
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
  incomplete?: boolean;
  incompleteReason?: "missing_start" | "missing_finish";
  statusLabel?: string;
  laps?: number;
  expectedLaps?: number | null;
  lapsIncomplete?: boolean;
  segments?: ResultSegment[];
  /** Last CSV "Tiempo de vuelta" for this pilot */
  lastLapMs?: number;
  lastLapFormatted?: string;
}
