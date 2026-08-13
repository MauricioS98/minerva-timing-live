import { useEffect, useRef, useState } from "react";

export const ROW_STAGGER_MS = 100;

export type PonyMaltaRowProps = {
  position: number;
  name: string;
  time: string;
  enterIndex: number;
  visible: boolean;
  exiting?: boolean;
};

export function PonyMaltaRow({
  position,
  name,
  time,
  enterIndex,
  visible,
  exiting = false,
}: PonyMaltaRowProps) {
  const [entered, setEntered] = useState(false);
  const [timeIn, setTimeIn] = useState(false);
  const [flash, setFlash] = useState(false);
  const prevTime = useRef(time);

  useEffect(() => {
    if (!visible || exiting) {
      setEntered(false);
      setTimeIn(false);
      return;
    }
    const rowDelay = enterIndex * ROW_STAGGER_MS;
    const enterTimer = window.setTimeout(() => setEntered(true), rowDelay);
    const timeTimer = window.setTimeout(() => setTimeIn(true), rowDelay + 150);
    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(timeTimer);
    };
  }, [visible, exiting, enterIndex]);

  useEffect(() => {
    if (prevTime.current === time) return;
    const hadValue = Boolean(prevTime.current);
    prevTime.current = time;
    if (!hadValue || !entered) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 220);
    return () => window.clearTimeout(t);
  }, [time, entered]);

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
    >
      <span className="pm-row-pos">
        <span className="pm-txt">{position}</span>
      </span>
      <span className="pm-row-name">
        <span className="pm-txt pm-row-name-wipe">{(name || "—").toUpperCase()}</span>
      </span>
      <span className={`pm-row-time${timeIn ? " pm-row-time--in" : ""}${flash ? " pm-row-time--flash" : ""}`}>
        <span className="pm-txt">{time}</span>
      </span>
    </div>
  );
}
