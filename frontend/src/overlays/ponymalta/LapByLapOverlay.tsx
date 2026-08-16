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
const LAPS_PER_PAGE = 8;
const PAGE_EXIT_MS = 280;
const PANEL_EASE_MS = 600;

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
    if (!id || !testId || !partId) {
      setError("Falta la prueba o la salida en la URL.");
      return;
    }
    try {
      const data = await api.getLapByLap(id, testId, { partId });
      setTitle(data.title || "");
      setMaxLaps(data.maxLaps || 0);
      setPageHoldSeconds(data.event.boardPageSeconds ?? 10);
      setAllRows(
        data.rows.slice(0, top).map((r) => ({
          key: String(r.number || `p${r.position}`),
          position: r.position,
          name: r.name || "—",
          laps: r.lapTimesFormatted || [],
        }))
      );
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
      error={!id || !testId || !partId ? "Falta la prueba o la salida en la URL." : error}
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
  remoteLapPage = 0,
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
  const lapsShown = Math.min(LAPS_PER_PAGE, totalLaps);
  const lapCol = Math.max(118, Math.min(148, Math.floor((1620 - 76 - 280) / lapsShown)));

  const pilotPageCount = Math.max(1, Math.ceil(allRows.length / PILOT_PAGE_SIZE) || 1);
  const lapPageCount = Math.max(1, Math.ceil(totalLaps / LAPS_PER_PAGE));
  const screenCount = pilotPageCount * lapPageCount;
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

  const { screen: safePage, pilotPage: safePilotPage, lapPage: safeLapPage } = decodeScreen(
    page,
    lapPageCount,
    pilotPageCount
  );
  const lapOffset = safeLapPage * LAPS_PER_PAGE;
  const livePageRows = useMemo(
    () =>
      allRows.slice(
        safePilotPage * PILOT_PAGE_SIZE,
        safePilotPage * PILOT_PAGE_SIZE + PILOT_PAGE_SIZE
      ),
    [allRows, safePilotPage]
  );
  const liveMemberKey = useMemo(
    () => membershipKey(livePageRows, safeLapPage),
    [livePageRows, safeLapPage]
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
    if (pagingMode === "manual" || !rowsReady || screenCount <= 1 || displayRows.length === 0) return;
    const buildMs = displayRows.length * LL_ROW_STAGGER_MS + 350;
    let swapTimer: number | null = null;
    const hold = window.setTimeout(() => {
      setExiting(true);
      swapTimer = window.setTimeout(() => {
        const count = Math.max(1, screenCountRef.current);
        const next = (pageRef.current + 1) % count;
        pageRef.current = next;
        const decoded = decodeScreen(
          next,
          lapPageCountRef.current,
          pilotPageCountRef.current
        );
        const nextRows = allRowsRef.current.slice(
          decoded.pilotPage * PILOT_PAGE_SIZE,
          decoded.pilotPage * PILOT_PAGE_SIZE + PILOT_PAGE_SIZE
        );
        membershipRef.current = membershipKey(nextRows, decoded.lapPage);
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
  }, [screenCount, safePage, animGen, displayRows.length, rowsReady, pageHoldMs, pagingMode]);

  useEffect(() => {
    if (pagingMode !== "manual" || !rowsReady) return;
    const lp = Math.max(1, lapPageCount);
    const pp = Math.max(1, pilotPageCount);
    const pilot = Math.max(0, Math.min(pp - 1, Math.floor(Number(remotePilotPage) || 0)));
    const lap = Math.max(0, Math.min(lp - 1, Math.floor(Number(remoteLapPage) || 0)));
    const next = decodeScreen(pilot * lp + lap, lp, pp).screen;
    if (next === pageRef.current) return;
    setExiting(true);
    const swapTimer = window.setTimeout(() => {
      pageRef.current = next;
      const decoded = decodeScreen(next, lapPageCountRef.current, pilotPageCountRef.current);
      const nextRows = allRowsRef.current.slice(
        decoded.pilotPage * PILOT_PAGE_SIZE,
        decoded.pilotPage * PILOT_PAGE_SIZE + PILOT_PAGE_SIZE
      );
      membershipRef.current = membershipKey(nextRows, decoded.lapPage);
      setDisplayRows(nextRows);
      setPage(next);
      setAnimGen((g) => g + 1);
      setExiting(false);
    }, PAGE_EXIT_MS);
    return () => window.clearTimeout(swapTimer);
  }, [pagingMode, remotePilotPage, remoteLapPage, lapPageCount, pilotPageCount, rowsReady]);

  useEffect(() => {
    if (pagingMode === "manual") return;
    if (page >= screenCount) {
      pageRef.current = 0;
      setPage(0);
    }
  }, [page, screenCount, pagingMode]);

  const gridTemplate = `76px 280px repeat(${lapsShown}, ${lapCol}px)`;
  const boardWidth = 76 + 280 + lapsShown * lapCol;
  const leaderLaps = allRows[0]?.laps.filter(Boolean).length || maxLaps || "";

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
