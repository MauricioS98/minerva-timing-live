import { useEffect, useRef, useState } from "react";
import { FlipValue } from "./FlipValue";

export const ROW_STAGGER_MS = 100;

export type PonyMaltaRowProps = {
  flipKey: string;
  position: number;
  name: string;
  time: string;
  gap: string;
  enterIndex: number;
  visible: boolean;
  exiting?: boolean;
};

export function PonyMaltaRow({
  flipKey,
  position,
  name,
  time,
  gap,
  enterIndex,
  visible,
  exiting = false,
}: PonyMaltaRowProps) {
  const [entered, setEntered] = useState(false);
  const [timeIn, setTimeIn] = useState(false);
  const enterIndexRef = useRef(enterIndex);
  if (!entered) enterIndexRef.current = enterIndex;

  useEffect(() => {
    if (!visible || exiting) {
      setEntered(false);
      setTimeIn(false);
      return;
    }
    const rowDelay = enterIndexRef.current * ROW_STAGGER_MS;
    const enterTimer = window.setTimeout(() => setEntered(true), rowDelay);
    const timeTimer = window.setTimeout(() => setTimeIn(true), rowDelay + 150);
    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(timeTimer);
    };
  }, [visible, exiting]);

  const live = entered && !exiting;

  return (
    <div
      className={[
        "pm-row",
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
      <span className={`pm-row-time${timeIn ? " pm-row-time--in" : ""}`}>
        <FlipValue value={time} animate={live && timeIn} />
      </span>
      <span className={`pm-row-gap${timeIn ? " pm-row-gap--in" : ""}`}>
        <FlipValue value={gap} animate={live && timeIn} />
      </span>
    </div>
  );
}
