import { useEffect, useRef, useState } from "react";

export const LL_ROW_STAGGER_MS = 100;

export type LapByLapRowProps = {
  position: number;
  name: string;
  laps: string[];
  maxLaps: number;
  enterIndex: number;
  visible: boolean;
  exiting?: boolean;
};

export function LapByLapRow({
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
  const [flashKey, setFlashKey] = useState("");
  const prevSignature = useRef(laps.join("|"));

  useEffect(() => {
    if (!visible || exiting) {
      setEntered(false);
      setTimesIn(false);
      return;
    }
    const rowDelay = enterIndex * LL_ROW_STAGGER_MS;
    const enterTimer = window.setTimeout(() => setEntered(true), rowDelay);
    const timeTimer = window.setTimeout(() => setTimesIn(true), rowDelay + 150);
    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(timeTimer);
    };
  }, [visible, exiting, enterIndex]);

  useEffect(() => {
    const signature = laps.join("|");
    if (prevSignature.current === signature) return;
    const hadValue = Boolean(prevSignature.current);
    prevSignature.current = signature;
    if (!hadValue || !entered) return;
    const last = laps.filter(Boolean).at(-1) || "";
    if (!last) return;
    setFlashKey(last + ":" + laps.length);
    const t = window.setTimeout(() => setFlashKey(""), 220);
    return () => window.clearTimeout(t);
  }, [laps, entered]);

  const lastIdx = laps.reduce((acc, t, i) => (t ? i : acc), -1);

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
    >
      <span className="pm-row-pos">
        <span className="pm-txt">{position}</span>
      </span>
      <span className="pm-row-name">
        <span className="pm-txt pm-row-name-wipe">{(name || "—").toUpperCase()}</span>
      </span>
      {Array.from({ length: maxLaps }, (_, i) => {
        const time = laps[i] || "";
        const flash = Boolean(flashKey) && i === lastIdx;
        return (
          <span
            key={i}
            className={`pm-row-time pm-ll-lap${timesIn ? " pm-row-time--in" : ""}${
              flash ? " pm-row-time--flash" : ""
            }`}
          >
            {time ? <span className="pm-txt">{time}</span> : null}
          </span>
        );
      })}
    </div>
  );
}
