import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { hexToRgba, resolveThemeColors } from "../theme";
import { ClassicOverlay } from "../overlays/ClassicOverlay";
import { RedBullOverlay } from "../overlays/redbull/RedBullOverlay";
import { PonyMaltaOverlay } from "../overlays/ponymalta/PonyMaltaOverlay";

type BoardData = Awaited<ReturnType<typeof api.getBoard>>;
type Section = BoardData["sections"][number];

export function OverlayPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState("");

  const topParam = Number(params.get("top"));
  const refreshSec = Math.max(2, Number(params.get("refresh")) || 5);
  const showGap = params.get("gap") !== "0";
  const showHeader = params.get("header") !== "0";
  const sectionParam = (params.get("section") || "").trim();
  const variantParam = (params.get("variant") || "").trim().toLowerCase();
  const timingParam = (params.get("timing") || "").trim().toLowerCase();

  useEffect(() => {
    document.documentElement.classList.add("overlay-transparent");
    document.body.classList.add("overlay-transparent");
    return () => {
      document.documentElement.classList.remove("overlay-transparent");
      document.body.classList.remove("overlay-transparent");
    };
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const board = await api.getBoard(id);
      setData(board);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, [id]);

  useEffect(() => {
    load().catch(() => undefined);
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, refreshSec * 1000);
    return () => window.clearInterval(timer);
  }, [load, refreshSec]);

  const section: Section | null = useMemo(() => {
    if (!data || data.sections.length === 0) return null;
    if (sectionParam) {
      const byId = data.sections.find((s) => s.entry.id === sectionParam);
      if (byId) return byId;
      const idx = Number(sectionParam);
      if (Number.isInteger(idx) && idx >= 1 && idx <= data.sections.length) {
        return data.sections[idx - 1];
      }
      return null;
    }
    return data.sections[data.sections.length - 1];
  }, [data, sectionParam]);

  const [cAccent, cAccent2, cPanel, cText] = resolveThemeColors(data?.event.themeColors);
  const themeStyle = {
    "--ov-accent": cAccent,
    "--ov-accent2": cAccent2,
    "--ov-head-bg": hexToRgba(cPanel, 0.96),
    "--ov-row-bg": hexToRgba(cPanel, 0.88),
    "--ov-p1-bg": hexToRgba(cPanel, 0.96),
    "--ov-text": cText,
    "--ov-text-soft": hexToRgba(cText, 0.6),
  } as CSSProperties;

  const variant =
    variantParam === "redbull" ||
    variantParam === "classic" ||
    variantParam === "ponymalta"
      ? variantParam
      : data?.event.overlayVariant === "redbull" ||
          data?.event.overlayVariant === "ponymalta"
        ? data.event.overlayVariant
        : "classic";

  const showSplits =
    timingParam === "splits" || timingParam === "total"
      ? timingParam === "splits"
      : data?.event.overlayTiming !== "total";

  const pageHoldSeconds = Math.min(
    120,
    Math.max(3, Math.round(data?.event.boardPageSeconds ?? 10))
  );

  if (variant === "ponymalta") {
    return (
      <PonyMaltaOverlay
        error={error}
        section={section}
        showHeader={showHeader}
        showSplits={showSplits}
        pageHoldSeconds={pageHoldSeconds}
        top={Math.max(1, Number.isFinite(topParam) && topParam > 0 ? topParam : 40)}
      />
    );
  }

  if (variant === "redbull") {
    return (
      <RedBullOverlay
        error={error}
        section={section}
        showHeader={showHeader}
        showSplits={showSplits}
        pageHoldSeconds={pageHoldSeconds}
        top={Math.max(1, Number.isFinite(topParam) && topParam > 0 ? topParam : 40)}
      />
    );
  }

  return (
    <ClassicOverlay
      themeStyle={themeStyle}
      error={error}
      data={data}
      section={section}
      showHeader={showHeader}
      showGap={showGap}
      showSplits={showSplits}
      top={Math.max(1, Number.isFinite(topParam) && topParam > 0 ? topParam : 20)}
    />
  );
}
