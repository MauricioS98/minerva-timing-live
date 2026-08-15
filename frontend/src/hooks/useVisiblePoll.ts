import { useEffect } from "react";

/**
 * Polls `load` while this page is mounted, including background tabs.
 * Closed tabs do not run JS, so the API is not hit.
 */
export function useVisiblePoll(load: () => void | Promise<unknown>, intervalMs: number) {
  useEffect(() => {
    const tick = () => {
      void Promise.resolve(load()).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [load, intervalMs]);
}
