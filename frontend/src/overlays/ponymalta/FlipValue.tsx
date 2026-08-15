import { useEffect, useRef, useState } from "react";

const FLIP_MS = 480;

export function FlipValue({
  value,
  animate = true,
}: {
  value: string;
  animate?: boolean;
}) {
  const [current, setCurrent] = useState(value);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    const from = prev.current;
    prev.current = value;
    setCurrent(value);
    if (!animate) {
      setOutgoing(null);
      return;
    }
    setOutgoing(from);
    setTick((n) => n + 1);
    const t = window.setTimeout(() => setOutgoing(null), FLIP_MS);
    return () => window.clearTimeout(t);
  }, [value, animate]);

  return (
    <span className="pm-flip">
      {outgoing != null && outgoing !== "" && (
        <span className="pm-txt pm-flip-out" aria-hidden>
          {outgoing}
        </span>
      )}
      <span key={tick} className={`pm-txt${outgoing != null ? " pm-flip-in" : ""}`}>
        {current}
      </span>
    </span>
  );
}
