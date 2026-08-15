import { useEffect, useRef } from "react";
import { api } from "../api";

const FLAG_POLL_MS = 1500;

/**
 * Loads overlay data once, then on the configured interval only while the
 * event's "overlay live" switch is On. When the switch turns On again, data
 * is fetched immediately. The last loaded frame is kept while Off.
 */
export function useOverlayLivePoll(
  eventId: string | undefined,
  load: () => void | Promise<unknown>,
  intervalMs: number
) {
  const loadRef = useRef(load);
  loadRef.current = load;

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
        const next = r.overlayLiveRefresh !== false;
        const was = liveRef.current;
        liveRef.current = next;
        if (next && !was) runLoad();
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
}
