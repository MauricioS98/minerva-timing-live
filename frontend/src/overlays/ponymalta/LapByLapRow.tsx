import { useEffect, useRef, useState } from "react";
import { FlipValue } from "./FlipValue";

export const LL_ROW_STAGGER_MS = 100;

export type LapByLapRowProps = {
  flipKey: string;
  position: number;
  name: string;
  laps: string[];
  maxLaps: number;
  enterIndex: number;
  visible: boolean;
  exiting?: boolean;
};

export function LapByLapRow({
  flipKey,
  position,
  name,
  laps,
  maxLaps,
  enterIndex,
  visible,
  exiting = false,
}: LapByLapRowProps) {
  const [entered, setEntered] = useState(false);
  const [timesIn, setTimesIn] = useState(false);
  const enterIndexRef = useRef(enterIndex);
  if (!entered) enterIndexRef.current = enterIndex;

  useEffect(() => {
    if (!visible || exiting) {
      setEntered(false);
      setTimesIn(false);
      return;
    }
    const rowDelay = enterIndexRef.current * LL_ROW_STAGGER_MS;
    const enterTimer = window.setTimeout(() => setEntered(true), rowDelay);
    const timeTimer = window.setTimeout(() => setTimesIn(true), rowDelay + 150);
    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(timeTimer);
    };
  }, [visible, exiting]);

  const live = entered && !exiting;

  return (
    <div
      className={[
        "pm-row pm-ll-row",
        entered && !exiting ? "pm-row--in" : "",
        exiting ? "pm-row--out" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-pos={position}
      data-flip-key={flipKey}
    >
      <span className="pm-row-pos">
        <FlipValue value={String(position)} animate={live} />
      </span>
      <span className="pm-row-name">
        <span className="pm-txt pm-row-name-wipe">{(name || "—").toUpperCase()}</span>
      </span>
      {Array.from({ length: maxLaps }, (_, i) => {
        const time = laps[i] || "";
        return (
          <span
            key={i}
            className={`pm-row-time pm-ll-lap${timesIn ? " pm-row-time--in" : ""}`}
          >
            <FlipValue value={time} animate={live && timesIn} />
          </span>
        );
      })}
    </div>
  );
}
