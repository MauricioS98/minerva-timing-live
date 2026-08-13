import type { CSSProperties } from "react";
import type { FusionRow, ResultRow } from "../types";

type BoardData = {
  event: { name: string };
  sections: {
    entry: { id: string };
    title: string;
    rows: (ResultRow | FusionRow)[];
  }[];
};

type Section = BoardData["sections"][number];

function isFusionRow(r: ResultRow | FusionRow): r is FusionRow {
  return "totalTimeFormatted" in r;
}

function rowTimeMs(r: ResultRow | FusionRow): number {
  return isFusionRow(r) ? r.totalTimeMs : r.timeMs;
}

function rowTimeFormatted(r: ResultRow | FusionRow): string {
  return isFusionRow(r) ? r.totalTimeFormatted : r.timeFormatted;
}

function formatGap(ms: number): string {
  if (ms <= 0) return "—";
  const totalSec = ms / 1000;
  if (totalSec < 60) return `+${totalSec.toFixed(3)}`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `+${min}:${sec.toFixed(3).padStart(6, "0")}`;
}

export type ClassicOverlayProps = {
  themeStyle: CSSProperties;
  error: string;
  data: BoardData | null;
  section: Section | null;
  showHeader: boolean;
  showGap: boolean;
  showSplits: boolean;
  top: number;
};

export function ClassicOverlay({
  themeStyle,
  error,
  data,
  section,
  showHeader,
  showGap,
  showSplits,
  top,
}: ClassicOverlayProps) {
  if (error) {
    return (
      <div className="overlay-root" style={themeStyle}>
        <div className="overlay-tower">
          <div className="overlay-head">
            <span className="overlay-head-title">Sin conexión con el cronometraje</span>
          </div>
        </div>
      </div>
    );
  }

  if (!data || !section) {
    return <div className="overlay-root" style={themeStyle} />;
  }

  const rows = section.rows.slice(0, top);
  const leaderMs = rows.length > 0 ? rowTimeMs(rows[0]) : 0;

  return (
    <div className="overlay-root" style={themeStyle}>
      <div className="overlay-tower">
        {showHeader && (
          <div className="overlay-head">
            <span className="overlay-head-event">{data.event.name}</span>
            <span className="overlay-head-title">{section.title}</span>
          </div>
        )}
        <div className="overlay-rows">
          {rows.map((r) => {
            const ms = rowTimeMs(r);
            const league = "league" in r ? r.league : "";
            const gapText =
              showGap && r.position > 1 && leaderMs && ms ? formatGap(ms - leaderMs) : "";
            const segments =
              showSplits && "segments" in r && Array.isArray(r.segments)
                ? r.segments
                : [];
            const hasSegments = segments.length > 0;
            return (
              <div
                key={`${r.position}-${r.number}`}
                className={`overlay-row${hasSegments ? " overlay-row-segs" : ""}${r.position <= 3 ? ` overlay-p${r.position}` : ""}`}
              >
                <span className="overlay-pos">{r.position}</span>
                <span className="overlay-num">{r.number}</span>
                <span className="overlay-driver">
                  <span className="overlay-name">{r.name || "—"}</span>
                  {league && <span className="overlay-league">{league}</span>}
                  {hasSegments && (
                    <span className="overlay-segs">
                      {segments.map((s) => `${s.from}→${s.to} ${s.timeFormatted}`).join(" · ")}
                    </span>
                  )}
                </span>
                <span className="overlay-timing">
                  <span className="overlay-time">{rowTimeFormatted(r)}</span>
                  {gapText && <span className="overlay-gap">{gapText}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
