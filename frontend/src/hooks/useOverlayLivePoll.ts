import { useEffect, useRef, useState } from "react";
import { api } from "../api";

const FLAG_POLL_MS = 1500;

export type OverlayControlState = {
  overlayLiveRefresh: boolean;
  overlayPagingMode: "auto" | "manual";
  overlayPilotPage: number;
  overlayLapPage: number;
};

export const DEFAULT_OVERLAY_CONTROL: OverlayControlState = {
  overlayLiveRefresh: true,
  overlayPagingMode: "auto",
  overlayPilotPage: 0,
  overlayLapPage: 0,
};

export function parseOverlayControl(
  r: Partial<OverlayControlState> | null | undefined
): OverlayControlState {
  return {
    overlayLiveRefresh: r?.overlayLiveRefresh !== false,
    overlayPagingMode: r?.overlayPagingMode === "manual" ? "manual" : "auto",
    overlayPilotPage: Math.max(0, Math.floor(Number(r?.overlayPilotPage) || 0)),
    overlayLapPage: Math.max(0, Math.floor(Number(r?.overlayLapPage) || 0)),
  };
}

/**
 * Loads overlay data once, then on the configured interval only while the
 * event's "overlay live" switch is On. Also returns paging (auto/manual).
 */
export function useOverlayLivePoll(
  eventId: string | undefined,
  load: () => void | Promise<unknown>,
  intervalMs: number
): OverlayControlState {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [control, setControl] = useState<OverlayControlState>(DEFAULT_OVERLAY_CONTROL);

  useEffect(() => {
    if (!eventId) return;

    const runLoad = () => void Promise.resolve(loadRef.current()).catch(() => undefined);
    const liveRef = { current: true };

    runLoad();

    const dataTimer = window.setInterval(() => {
      if (liveRef.current) runLoad();
    }, intervalMs);

    const readFlag = async () => {
      try {
        const r = await api.getOverlayLive(eventId);
        const next = parseOverlayControl(r);
        const was = liveRef.current;
        liveRef.current = next.overlayLiveRefresh;
        setControl(next);
        if (next.overlayLiveRefresh && !was) runLoad();
      } catch {
        /* keep last known flag */
      }
    };

    void readFlag();
    const flagTimer = window.setInterval(() => void readFlag(), FLAG_POLL_MS);

    return () => {
      window.clearInterval(dataTimer);
      window.clearInterval(flagTimer);
    };
  }, [eventId, intervalMs]);

  return control;
}
