import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useOverlayLivePoll } from "../../hooks/useOverlayLivePoll";
import { pilotArtCandidates, RB_ASSETS } from "./pilotArt";
import "./redbull.css";
import "./start-order.css";

type PilotLite = { number: string; name: string };
type Pair = { a: string; b: string };

function normalizeNum(n: string): string {
  return String(n || "")
    .replace(/^#/, "")
    .trim()
    .replace(/^0+(\d)/, "$1")
    .toUpperCase();
}

function resolvePilot(pilots: PilotLite[], number: string): PilotLite | null {
  const key = normalizeNum(number);
  if (!key) return null;
  const hit = pilots.find((p) => normalizeNum(p.number) === key);
  return hit || { number: key, name: "" };
}

function PilotSlot({ number, name }: { number: string; name: string }) {
  const candidates = pilotArtCandidates(number, name);
  const [idx, setIdx] = useState(0);
  const src = idx < candidates.length ? candidates[idx] : null;

  useEffect(() => {
    setIdx(0);
  }, [number, name]);

  return (
    <div className="so-pilot">
      <img
        className="so-pilot-trap"
        src="/overlays/redbull/row-name-only.png"
        alt=""
        draggable={false}
      />
      <div className="so-pilot-inner">
        {src ? (
          <img
            className="so-pilot-art"
            src={src}
            alt={name || number}
            draggable={false}
            onError={() => setIdx((i) => i + 1)}
          />
        ) : (
          <span className="so-pilot-name-fallback">
            {(name || `#${number || "—"}`).toUpperCase()}
          </span>
        )}
      </div>
    </div>
  );
}

export function StartOrderOverlayPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getOrdenSalida>> | null>(null);
  const [panelIn, setPanelIn] = useState(false);
  const [headersIn, setHeadersIn] = useState(false);
  const [logoPhase, setLogoPhase] = useState<"idle" | "phase1" | "phase2" | "phase3" | "done">(
    "idle"
  );

  const refreshSec = Math.max(2, Number(params.get("refresh")) || 5);
  const testParam = (params.get("test") || "").trim();
  const partParam = (params.get("part") || "").trim();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const payload = await api.getOrdenSalida(id);
      setData(payload);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, [id]);

  useEffect(() => {
    document.documentElement.classList.add("overlay-transparent");
    document.body.classList.add("overlay-transparent");
    return () => {
      document.documentElement.classList.remove("overlay-transparent");
      document.body.classList.remove("overlay-transparent");
    };
  }, []);

  useOverlayLivePoll(id, load, refreshSec * 1000);

  // Same header entrance as Tabla de posiciones
  useEffect(() => {
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setPanelIn(true), 40));
    timers.push(window.setTimeout(() => setLogoPhase("phase1"), 80));
    timers.push(window.setTimeout(() => setLogoPhase("phase2"), 80 + 300));
    timers.push(window.setTimeout(() => setLogoPhase("phase3"), 80 + 300 + 80));
    timers.push(
      window.setTimeout(() => {
        setLogoPhase("done");
        setHeadersIn(true);
      }, 80 + 300 + 420)
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);

  const selection = useMemo(() => {
    if (!data) return null;
    const tests = data.tests || [];
    const published = data.event.publishedStartOrder;

    // Preview override via URL (optional); otherwise only the published order.
    let test = testParam ? tests.find((t) => t.id === testParam) : null;
    let part = test && partParam ? test.parts.find((p) => p.id === partParam) : null;

    if (!test || !part) {
      if (!published) return null;
      test = tests.find((t) => t.id === published.testId) || null;
      part = test?.parts.find((p) => p.id === published.partId) || null;
    }
    if (!test || !part) return null;
    return { test, part, pairs: (part.startOrderVs || []) as Pair[] };
  }, [data, testParam, partParam]);

  if (error) {
    return (
      <div className="rb-stage">
        <div className="rb-error">Sin conexión con el cronometraje</div>
      </div>
    );
  }

  if (!data) {
    return <div className="rb-stage" />;
  }

  if (!selection) {
    return (
      <div className="rb-stage">
        <div className="rb-panel rb-panel--in so-panel">
          <img className="rb-layer rb-fondo" src={RB_ASSETS.fondo} alt="" draggable={false} />
          <p className="so-empty so-empty--center">
            No hay un orden de salida publicado
          </p>
        </div>
      </div>
    );
  }

  const { test, part, pairs } = selection;
  const pilots = data.pilots || [];
  const testName = test.name || "";

  const logoClasses = [
    "rb-logo-stack",
    logoPhase !== "idle" ? "rb-logo--phase1" : "",
    logoPhase === "phase2" || logoPhase === "phase3" || logoPhase === "done"
      ? "rb-logo--phase2"
      : "",
    logoPhase === "phase3" || logoPhase === "done" ? "rb-logo--phase3" : "",
    logoPhase === "done" ? "rb-logo--done" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rb-stage">
      <div
        className={[
          "rb-panel",
          panelIn ? "rb-panel--in" : "",
          headersIn ? "rb-panel--headers-in" : "",
          "so-panel",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <img className="rb-layer rb-fondo" src={RB_ASSETS.fondo} alt="" draggable={false} />

        {/* Same logo stack + placement as Tabla de posiciones */}
        <div className={logoClasses}>
          <img
            className="rb-logo-layer rb-logo-base"
            src={RB_ASSETS.logoBase}
            alt=""
            draggable={false}
          />
          <div className="rb-logo-urbano-mask">
            <img className="rb-logo-layer" src={RB_ASSETS.logoUrbano} alt="" draggable={false} />
          </div>
          <img
            className="rb-logo-layer rb-logo-moto"
            src={RB_ASSETS.logoMoto}
            alt=""
            draggable={false}
          />
          <img
            className="rb-logo-layer rb-logo-redbull"
            src={RB_ASSETS.logoRedbull}
            alt=""
            draggable={false}
          />
        </div>

        {/* Same title slot as title.png — text for Orden de salida */}
        <div className="rb-layer so-title-slot" aria-hidden={false}>
          <h1 className="so-title-text">ORDEN DE SALIDA</h1>
        </div>

        {testName ? <div className="rb-section-label">{testName}</div> : null}

        <div className="so-list" aria-label={`Enfrentamientos ${part.name || ""}`.trim()}>
          {pairs.length === 0 ? (
            <p className="so-empty">Sin enfrentamientos configurados</p>
          ) : (
            pairs.map((pair, i) => {
              const left = resolvePilot(pilots, pair.a);
              const right = resolvePilot(pilots, pair.b);
              return (
                <div key={`${pair.a}-${pair.b}-${i}`} className="so-vs-row">
                  <PilotSlot number={left?.number || pair.a} name={left?.name || ""} />
                  <span className="so-vs-mark">VS</span>
                  <PilotSlot number={right?.number || pair.b} name={right?.name || ""} />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
