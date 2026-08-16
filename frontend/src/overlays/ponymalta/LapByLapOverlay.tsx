import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useOverlayLivePoll } from "../../hooks/useOverlayLivePoll";
import { LapByLapRow, LL_ROW_STAGGER_MS } from "./LapByLapRow";
import { FlipValue } from "./FlipValue";
import { useRowFlip } from "./useRowFlip";
import { PonyMaltaSponsors } from "./PonyMaltaSponsors";
import "./ponymalta.css";

const PILOT_PAGE_SIZE = 2;
const PAGE_EXIT_MS = 280;
const PANEL_EASE_MS = 600;
const PM_POS_COL = 76;
const PM_NAME_COL = 428;
const PM_LAP_COL = 188;
const PM_BOARD_MAX = 1620;
const PM_LAP_AREA = PM_BOARD_MAX - PM_POS_COL - PM_NAME_COL;
const MIN_LAP_COL = 88;

type LapViewRow = {
  key: string;
  position: number;
  name: string;
  laps: string[];
};

function membershipKey(rows: LapViewRow[], lapPage: number): string {
  return `${lapPage}:${rows.map((r) => r.key).join("|")}`;
}

function decodeScreen(screen: number, lapPages: number, pilotPages: number) {
  const lp = Math.max(1, lapPages);
  const pp = Math.max(1, pilotPages);
  const count = lp * pp;
  const s = ((screen % count) + count) % count;
  return {
    screen: s,
    pilotPage: Math.floor(s / lp) % pp,
    lapPage: s % lp,
  };
}

export function LapByLapOverlayPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const testId = (params.get("test") || "").trim();
  const partId = (params.get("part") || "").trim();
  const refreshSec = Math.max(2, Number(params.get("refresh")) || 5);
  const topParam = Number(params.get("top"));
  const top = Math.max(1, Number.isFinite(topParam) && topParam > 0 ? topParam : 40);

  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [maxLaps, setMaxLaps] = useState(0);
  const [allRows, setAllRows] = useState<LapViewRow[]>([]);
  const [pageHoldSeconds, setPageHoldSeconds] = useState(10);

  const load = useCallback(async () => {
    if (!id || !testId) {
      setError("Falta la prueba en la URL.");
      return;
    }
    try {
      const data = await api.getLapByLap(id, testId, partId ? { partId } : {});
      setTitle(data.title || "");
      setPageHoldSeconds(data.event.boardPageSeconds ?? 10);
      const rows = data.rows.slice(0, top).map((r) => ({
        key: String(r.number || `p${r.position}`),
        position: r.position,
        name: r.name || "—",
        laps: (r.lapTimesFormatted || []).filter(Boolean),
      }));
      setMaxLaps(
        Math.max(
          data.maxLaps || 0,
          ...rows.map((r) => r.laps.length)
        )
      );
      setAllRows(rows);
      setError(data.warning || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, [id, testId, partId, top]);

  useEffect(() => {
    document.documentElement.classList.add("overlay-transparent");
    document.body.classList.add("overlay-transparent");
    return () => {
      document.documentElement.classList.remove("overlay-transparent");
      document.body.classList.remove("overlay-transparent");
    };
  }, []);

  const control = useOverlayLivePoll(id, load, refreshSec * 1000);

  return (
    <LapByLapOverlay
      error={!id || !testId ? "Falta la prueba en la URL." : error}
      title={title}
      maxLaps={maxLaps}
      allRows={allRows}
      pageHoldSeconds={pageHoldSeconds}
      pagingMode={control.overlayPagingMode}
      remotePilotPage={control.overlayPilotPage}
      remoteLapPage={control.overlayLapPage}
    />
  );
}

function LapByLapOverlay({
  error,
  title,
  maxLaps,
  allRows,
  pageHoldSeconds,
  pagingMode = "auto",
  remotePilotPage = 0,
}: {
  error: string;
  title: string;
  maxLaps: number;
  allRows: LapViewRow[];
  pageHoldSeconds: number;
  pagingMode?: "auto" | "manual";
  remotePilotPage?: number;
  remoteLapPage?: number;
}) {
  const pageHoldMs = Math.min(120, Math.max(3, Math.round(pageHoldSeconds || 10))) * 1000;
  const totalLaps = Math.max(1, maxLaps);
  const lapsShown = totalLaps;
  const lapOffset = 0;
  const lapCol = Math.min(
    PM_LAP_COL,
    Math.max(MIN_LAP_COL, Math.floor(PM_LAP_AREA / Math.max(1, lapsShown)))
  );
  const lapPageCount = 1;
  const pilotPageCount = Math.max(1, Math.ceil(allRows.length / PILOT_PAGE_SIZE) || 1);
  const screenCount = pilotPageCount;
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
  const screenCountRef = useRef(screenCount);
  const lapPageCountRef = useRef(lapPageCount);
  const pilotPageCountRef = useRef(pilotPageCount);
  allRowsRef.current = allRows;
  screenCountRef.current = screenCount;
  lapPageCountRef.current = lapPageCount;
  pilotPageCountRef.current = pilotPageCount;

  const { screen: safePage, pilotPage: safePilotPage } = decodeScreen(
    page,
    lapPageCount,
    pilotPageCount
  );
  const livePageRows = useMemo(
    () =>
      allRows.slice(
        safePilotPage * PILOT_PAGE_SIZE,
        safePilotPage * PILOT_PAGE_SIZE + PILOT_PAGE_SIZE
      ),
    [allRows, safePilotPage]
  );
  const liveMemberKey = useMemo(
    () => membershipKey(livePageRows, 0),
    [livePageRows]
  );
  const [displayRows, setDisplayRows] = useState<LapViewRow[]>([]);
  const membershipRef = useRef("");
  const bodyRef = useRowFlip(liveMemberKey, rowsReady && !exiting);

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
    const timers = [
      window.setTimeout(() => setHeaderIn(true), 150),
      window.setTimeout(() => setTableHeadIn(true), 700),
      window.setTimeout(() => {
        setRowsReady(true);
        setAnimGen((g) => g + 1);
      }, 850),
    ];
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);

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
    if (pagingMode === "manual" || !rowsReady || displayRows.length === 0) return;
    const count = Math.max(1, screenCountRef.current);
    if (count <= 1) return;
    const buildMs = displayRows.length * LL_ROW_STAGGER_MS + 350;
    let swapTimer: number | null = null;
    const hold = window.setTimeout(() => {
      setExiting(true);
      swapTimer = window.setTimeout(() => {
        const lp = Math.max(1, lapPageCountRef.current);
        const pilots = Math.max(1, pilotPageCountRef.current);
        const next = decodeScreen(pageRef.current + 1, lp, pilots).screen;
        pageRef.current = next;
        const decoded = decodeScreen(next, lp, pilots);
        const nextRows = allRowsRef.current.slice(
          decoded.pilotPage * PILOT_PAGE_SIZE,
          decoded.pilotPage * PILOT_PAGE_SIZE + PILOT_PAGE_SIZE
        );
        membershipRef.current = membershipKey(nextRows, 0);
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
  }, [safePage, animGen, displayRows.length, rowsReady, pageHoldMs, pagingMode]);

  useEffect(() => {
    if (pagingMode !== "manual" || !rowsReady) return;
    const pp = Math.max(1, pilotPageCount);
    const pilot = Math.max(0, Math.min(pp - 1, Math.floor(Number(remotePilotPage) || 0)));
    const next = decodeScreen(pilot, 1, pp).screen;
    if (next === pageRef.current) return;
    setExiting(true);
    const swapTimer = window.setTimeout(() => {
      pageRef.current = next;
      const decoded = decodeScreen(next, lapPageCountRef.current, pilotPageCountRef.current);
      const nextRows = allRowsRef.current.slice(
        decoded.pilotPage * PILOT_PAGE_SIZE,
        decoded.pilotPage * PILOT_PAGE_SIZE + PILOT_PAGE_SIZE
      );
      membershipRef.current = membershipKey(nextRows, 0);
      setDisplayRows(nextRows);
      setPage(next);
      setAnimGen((g) => g + 1);
      setExiting(false);
    }, PAGE_EXIT_MS);
    return () => window.clearTimeout(swapTimer);
  }, [pagingMode, remotePilotPage, pilotPageCount, rowsReady]);

  useEffect(() => {
    if (pagingMode === "manual") return;
    if (page >= screenCount) {
      pageRef.current = 0;
      setPage(0);
    }
  }, [page, screenCount, pagingMode]);

  const gridTemplate = `${PM_POS_COL}px ${PM_NAME_COL}px repeat(${lapsShown}, ${lapCol}px)`;
  const boardWidth = PM_POS_COL + PM_NAME_COL + lapsShown * lapCol;
  const leaderLaps = Math.max(
    maxLaps,
    ...allRows.map((r) => r.laps.filter(Boolean).length)
  );

  if (error && allRows.length === 0) {
    return (
      <div className="pm-stage">
        <div className="pm-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="pm-stage">
      <div
        className={`pm-panel${panelIn ? " pm-panel--in" : ""}`}
        style={{
          ["--pm-scale" as string]: String(scale),
          transitionDuration: `${PANEL_EASE_MS}ms`,
        }}
      >
        <div
          className={`pm-board pm-ll-board${headerIn ? " pm-board--in" : ""}${
            tableHeadIn ? " pm-board--table" : ""
          }`}
          style={{
            width: boardWidth,
            ["--pm-pos-col" as string]: `${PM_POS_COL}px`,
            ["--pm-name-col" as string]: `${PM_NAME_COL}px`,
            ["--pm-lap-col" as string]: `${lapCol}px`,
            ["--pm-ll-cols" as string]: gridTemplate,
          }}
        >
          <header className="pm-head">
            <div className="pm-brand-stack">
              <div className="pm-brand">
                <img
                  className="pm-brand-logo"
                  src="/overlays/ponymalta/brand-circuito-horizontal.png"
                  alt=""
                  draggable={false}
                />
              </div>
              <PonyMaltaSponsors />
            </div>
            <div className="pm-laps">
              <span className="pm-txt pm-laps-label">VUELTAS</span>
              <span className="pm-laps-value">
                <FlipValue value={String(leaderLaps)} animate={headerIn} />
              </span>
            </div>
          </header>

          <div className="pm-table-head pm-ll-grid">
            <span>
              <span className="pm-txt">POS.</span>
            </span>
            <span>
              <span className="pm-txt">NOMBRE</span>
            </span>
            {Array.from({ length: lapsShown }, (_, i) => {
              const lapNum = lapOffset + i + 1;
              return (
                <span key={lapNum}>
                  <span className="pm-txt">{lapNum <= totalLaps ? String(lapNum) : ""}</span>
                </span>
              );
            })}
          </div>
          <div className="pm-table-body" ref={bodyRef} aria-label={title || "Tiempos vuelta a vuelta"}>
            {rowsReady &&
              displayRows.map((r, i) => (
                <LapByLapRow
                  key={r.key}
                  flipKey={r.key}
                  position={r.position}
                  name={r.name}
                  laps={r.laps.slice(lapOffset, lapOffset + lapsShown)}
                  maxLaps={lapsShown}
                  enterIndex={i}
                  visible={rowsReady}
                  exiting={exiting}
                />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
