import { useLayoutEffect, useRef } from "react";

const FLIP_MS = 480;

/** Slides existing rows to their new slot instead of snapping like a photo cut. */
export function useRowFlip(orderKey: string, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const prevTops = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const nextTops = new Map<string, number>();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const el of nodes) {
      const key = el.dataset.flipKey || "";
      if (!key) continue;
      const top = el.getBoundingClientRect().top;
      nextTops.set(key, top);
      if (!enabled || reduce) continue;
      const prev = prevTops.current.get(key);
      if (prev == null) continue;
      const dy = prev - top;
      if (Math.abs(dy) < 1) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      el.style.zIndex = "2";
      void el.offsetHeight;
      el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      el.style.transform = "";
      const onEnd = (ev: TransitionEvent) => {
        if (ev.propertyName !== "transform") return;
        el.style.transition = "";
        el.style.zIndex = "";
        el.removeEventListener("transitionend", onEnd);
      };
      el.addEventListener("transitionend", onEnd);
    }
    prevTops.current = nextTops;
  }, [orderKey, enabled]);

  return ref;
}
