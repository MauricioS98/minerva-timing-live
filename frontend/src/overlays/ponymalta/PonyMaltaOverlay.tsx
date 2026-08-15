import { useEffect, useMemo, useRef, useState } from "react";
import type { FusionRow, ResultRow } from "../../types";
import { PonyMaltaRow, ROW_STAGGER_MS } from "./PonyMaltaRow";
import "./ponymalta.css";

const PAGE_SIZE = 8;
const PAGE_EXIT_MS = 280;
const PANEL_EASE_MS = 600;

type Section = {
  title: string;
  rows: (ResultRow | FusionRow)[];
  lapScoring?: boolean;
};

export type PonyMaltaOverlayProps = {
  error: string;
  section: Section | null;
  showHeader: boolean;
  top: number;
  showSplits: boolean;
  pageHoldSeconds: number;
};

type ViewRow = {
  key: string;
  position: number;
  name: string;
  time: string;
  gap: string;
};

function isFusionRow(r: ResultRow | FusionRow): r is FusionRow {
  return "totalTimeFormatted" in r;
}

function lastLapDisplay(r: ResultRow | FusionRow): string {
  if (isFusionRow(r)) return r.totalTimeFormatted;
  if (r.lastLapFormatted) return r.lastLapFormatted;
  const segs = (r.segments || []).filter((s) => s.timeFormatted);
  if (segs.length > 0) return segs[segs.length - 1].timeFormatted;
  return r.timeFormatted || "—";
}

/** Por vueltas: más vueltas, luego menor tiempo total. Nunca por última vuelta. */
function isLapScoringRow(r: ResultRow | FusionRow): boolean {
  if (isFusionRow(r)) return false;
  return Boolean(r.segmentLabel && /^Vueltas\s*\(/i.test(r.segmentLabel || ""));
}

function rankStandings(
  rows: (ResultRow | FusionRow)[],
  lapScoring: boolean
): (ResultRow | FusionRow)[] {
  const copy = [...rows];
  if (lapScoring) {
    copy.sort((a, b) => {
      if (isFusionRow(a) || isFusionRow(b)) return a.position - b.position;
      const lapsA = a.laps ?? 0;
      const lapsB = b.laps ?? 0;
      if (lapsB !== lapsA) return lapsB - lapsA;
      if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      return a.position - b.position;
    });
    return copy.map((r, i) => ({ ...r, position: i + 1 }));
  }
  return copy.sort((a, b) => a.position - b.position);
}

function rowLaps(r: ResultRow | FusionRow): number {
  if (isFusionRow(r)) return 0;
  const n = r.laps;
  return n == null || Number.isNaN(Number(n)) ? 0 : Number(n);
}

function rowTotalMs(r: ResultRow | FusionRow): number {
  return isFusionRow(r) ? r.totalTimeMs : r.timeMs;
}

/** Gap to leader: +x v, +xx.xxx s, or +xx:xx.xxx m. Empty for P1. */
function formatDelta(row: ResultRow | FusionRow, leader: ResultRow | FusionRow): string {
  if (row === leader) return "";
  const leaderLaps = rowLaps(leader);
  const laps = rowLaps(row);
  if (leaderLaps > 0 && laps < leaderLaps) {
    return `+${leaderLaps - laps} v`;
  }
  const gapMs = rowTotalMs(row) - rowTotalMs(leader);
  if (!Number.isFinite(gapMs) || gapMs <= 0) return "";
  if (gapMs < 60_000) {
    const sec = gapMs / 1000;
    const [int, frac] = sec.toFixed(3).split(".");
    return `+${int.padStart(2, "0")}.${frac} s`;
  }
  const min = Math.floor(gapMs / 60_000);
  const rem = gapMs % 60_000;
  const [int, frac] = (rem / 1000).toFixed(3).split(".");
  return `+${String(min).padStart(2, "0")}:${int.padStart(2, "0")}.${frac} m`;
}

function toViewRows(rows: (ResultRow | FusionRow)[]): ViewRow[] {
  const leader = rows[0];
  return rows.map((r) => ({
    key: String(r.number || `p${r.position}`),
    position: r.position,
    name: r.name || "—",
    time: lastLapDisplay(r),
    gap: leader ? formatDelta(r, leader) : "",
  }));
}

function membershipKey(rows: ViewRow[]): string {
  return rows.map((r) => r.key).join("|");
}

/** Vueltas del líder: la cifra más alta de la columna Vueltas (último paso válido). */
function lapsLabel(rows: (ResultRow | FusionRow)[]): string {
  let leaderLaps: number | null = null;
  for (const r of rows) {
    if (isFusionRow(r)) continue;
    if (r.laps == null || Number.isNaN(Number(r.laps))) continue;
    const n = Number(r.laps);
    if (leaderLaps == null || n > leaderLaps) leaderLaps = n;
  }
  return leaderLaps == null ? "" : String(leaderLaps);
}

export function PonyMaltaOverlay({
  error,
  section,
  showHeader,
  top,
  pageHoldSeconds,
}: PonyMaltaOverlayProps) {
  const pageHoldMs = Math.min(120, Math.max(3, Math.round(pageHoldSeconds || 10))) * 1000;
  const allRows = useMemo(() => {
    if (!section) return [] as ViewRow[];
    const lapScoring =
      section.lapScoring === true ||
      (section.lapScoring !== false && section.rows.some(isLapScoringRow));
    const ranked = rankStandings(section.rows, lapScoring);
    return toViewRows(ranked.slice(0, top));
  }, [section, top]);

  const laps = useMemo(
    () => (section ? lapsLabel(section.rows) : ""),
    [section]
  );

  const pageCount = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE) || 1);
  const [page, setPage] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [panelIn, setPanelIn] = useState(false);
  const [headerIn, setHeaderIn] = useState(false);
  const [tableHeadIn, setTableHeadIn] = useState(false);
  const [rowsReady, setRowsReady] = useState(false);
  const [animGen, setAnimGen] = useState(0);
  const [scale, setScale] = useState(1);
  const pageRef = useRef(0);
  const allRowsRef = useRef(allRows);
  const pageCountRef = useRef(pageCount);
  allRowsRef.current = allRows;
  pageCountRef.current = pageCount;

  const safePage = ((page % pageCount) + pageCount) % pageCount;
  const livePageRows = useMemo(
    () => allRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [allRows, safePage]
  );
  const liveMemberKey = useMemo(() => membershipKey(livePageRows), [livePageRows]);
  const [displayRows, setDisplayRows] = useState<ViewRow[]>([]);
  const membershipRef = useRef("");

  useEffect(() => {
    const apply = () => {
      setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setPanelIn(true), 80);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const timers: number[] = [];
    if (showHeader) {
      timers.push(window.setTimeout(() => setHeaderIn(true), 150));
    } else {
      setHeaderIn(true);
    }
    timers.push(window.setTimeout(() => setTableHeadIn(true), 700));
    timers.push(
      window.setTimeout(() => {
        setRowsReady(true);
        setAnimGen((g) => g + 1);
      }, 850)
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [showHeader]);

  useEffect(() => {
    if (exiting) return;
    if (!membershipRef.current) {
      membershipRef.current = liveMemberKey;
      setDisplayRows(livePageRows);
      return;
    }
    if (liveMemberKey === membershipRef.current) {
      setDisplayRows(livePageRows);
      return;
    }
    membershipRef.current = liveMemberKey;
    setDisplayRows(livePageRows);
    setAnimGen((g) => g + 1);
  }, [liveMemberKey, livePageRows, exiting]);

  useEffect(() => {
    if (!rowsReady || pageCount <= 1 || displayRows.length === 0) return;
    const buildMs = displayRows.length * ROW_STAGGER_MS + 350;
    let swapTimer: number | null = null;
    const hold = window.setTimeout(() => {
      setExiting(true);
      swapTimer = window.setTimeout(() => {
        const count = Math.max(1, pageCountRef.current);
        const next = (pageRef.current + 1) % count;
        pageRef.current = next;
        const nextRows = allRowsRef.current.slice(
          next * PAGE_SIZE,
          next * PAGE_SIZE + PAGE_SIZE
        );
        membershipRef.current = membershipKey(nextRows);
        setDisplayRows(nextRows);
        setPage(next);
        setAnimGen((g) => g + 1);
        setExiting(false);
      }, PAGE_EXIT_MS);
    }, buildMs + pageHoldMs);
    return () => {
      window.clearTimeout(hold);
      if (swapTimer != null) window.clearTimeout(swapTimer);
    };
  }, [pageCount, safePage, animGen, displayRows.length, rowsReady, pageHoldMs]);

  useEffect(() => {
    if (page >= pageCount) {
      pageRef.current = 0;
      setPage(0);
    }
  }, [page, pageCount]);

  if (error) {
    return (
      <div className="pm-stage">
        <div className="pm-error">Sin conexión con el cronometraje</div>
      </div>
    );
  }

  if (!section) return <div className="pm-stage" />;

  return (
    <div className="pm-stage">
      <div
        className={`pm-panel${panelIn ? " pm-panel--in" : ""}`}
        style={{
          ["--pm-scale" as string]: String(scale),
          transitionDuration: `${PANEL_EASE_MS}ms`,
        }}
      >
        {showHeader && (
          <div className={`pm-board${headerIn ? " pm-board--in" : ""}${tableHeadIn ? " pm-board--table" : ""}`}>
            <header className="pm-head">
              <div className="pm-brand-stack">
                <div className="pm-brand">
                  <img
                    className="pm-brand-logo"
                    src="/overlays/ponymalta/header-logo.png"
                    alt=""
                    draggable={false}
                  />
                </div>
                <div className="pm-category">
                  <img
                    className="pm-category-art"
                    src="/overlays/ponymalta/montoya-vs-montoya.png"
                    alt=""
                    draggable={false}
                  />
                </div>
              </div>
              <div className="pm-laps">
                <span className="pm-txt pm-laps-label">VUELTA</span>
                <span className="pm-txt pm-laps-value">{laps}</span>
              </div>
            </header>

            <div className="pm-table-head">
              <span><span className="pm-txt">POS.</span></span>
              <span><span className="pm-txt">NOMBRE</span></span>
              <span><span className="pm-txt">ÚLTIMA VUELTA</span></span>
              <span><span className="pm-txt">DIFERENCIA</span></span>
            </div>
            <div className="pm-table-body" aria-label="Tabla de posiciones">
              {rowsReady &&
                displayRows.map((r, i) => (
                  <PonyMaltaRow
                    key={r.key}
                    position={r.position}
                    name={r.name}
                    time={r.time}
                    gap={r.gap}
                    enterIndex={i}
                    visible={rowsReady}
                    exiting={exiting}
                  />
                ))}
            </div>
          </div>
        )}

        {!showHeader && (
          <div className={`pm-board pm-board--in${tableHeadIn ? " pm-board--table" : ""}`}>
            <div className="pm-table-head">
              <span><span className="pm-txt">POS.</span></span>
              <span><span className="pm-txt">NOMBRE</span></span>
              <span><span className="pm-txt">ÚLTIMA VUELTA</span></span>
              <span><span className="pm-txt">DIFERENCIA</span></span>
            </div>
            <div className="pm-table-body" aria-label="Tabla de posiciones">
              {rowsReady &&
                displayRows.map((r, i) => (
                  <PonyMaltaRow
                    key={r.key}
                    position={r.position}
                    name={r.name}
                    time={r.time}
                    gap={r.gap}
                    enterIndex={i}
                    visible={rowsReady}
                    exiting={exiting}
                  />
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
