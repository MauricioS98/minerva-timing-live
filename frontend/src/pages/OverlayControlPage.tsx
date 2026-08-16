import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import {
  DEFAULT_OVERLAY_CONTROL,
  parseOverlayControl,
  type OverlayControlState,
} from "../hooks/useOverlayLivePoll";
import type { Event } from "../types";

const PM_PAGE_SIZE = 2;
const RB_PAGE_SIZE = 8;
const LAP_PILOT_SIZE = 2;
const LAPS_PER_PAGE = 8;
const TOP = 40;

type BoardData = Awaited<ReturnType<typeof api.getBoard>>;

function standingsPageSize(variant?: string): number {
  if (variant === "ponymalta") return PM_PAGE_SIZE;
  if (variant === "redbull") return RB_PAGE_SIZE;
  return 0;
}

function PageButtons({
  count,
  current,
  onSelect,
  labelFor,
}: {
  count: number;
  current: number;
  onSelect: (i: number) => void;
  labelFor?: (i: number) => string;
}) {
  if (count <= 0) return <p className="ov-ctrl-empty">Sin páginas todavía.</p>;
  return (
    <div className="ov-ctrl-pages">
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`ov-ctrl-page${i === current ? " is-on" : ""}`}
          onClick={() => onSelect(i)}
        >
          {labelFor ? labelFor(i) : String(i + 1)}
        </button>
      ))}
    </div>
  );
}

export function OverlayControlPage() {
  const { id } = useParams();
  const [event, setEvent] = useState<Event | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [control, setControl] = useState<OverlayControlState>(DEFAULT_OVERLAY_CONTROL);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testId, setTestId] = useState("");
  const [partId, setPartId] = useState("");
  const [lapMax, setLapMax] = useState(0);
  const [lapPilots, setLapPilots] = useState(0);

  const loadMeta = useCallback(async () => {
    if (!id) return;
    const [ev, bd] = await Promise.all([api.getEvent(id), api.getBoard(id)]);
    setEvent(ev);
    setBoard(bd);
    const firstTest = ev.tests[0];
    const boardEntry = bd.sections?.[bd.sections.length - 1]?.entry;
    const boardTest = boardEntry?.refId
      ? ev.tests.find((t) => t.id === boardEntry.refId)
      : firstTest;
    const boardPartId =
      boardEntry?.partId ||
      boardTest?.parts[boardTest.parts.length - 1]?.id ||
      firstTest?.parts[firstTest.parts.length - 1]?.id ||
      firstTest?.parts[0]?.id;
    setTestId((prev) => prev || boardTest?.id || firstTest?.id || "");
    setPartId((prev) => prev || boardPartId || "");
  }, [id]);

  useEffect(() => {
    void loadMeta().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, [loadMeta]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.getOverlayLive(id);
        if (!cancelled) setControl(parseOverlayControl(r));
      } catch {
        /* keep last */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    if (!id || !testId || !partId) {
      setLapMax(0);
      setLapPilots(0);
      return;
    }
    let cancelled = false;
    void api
      .getLapByLap(id, testId, { partId })
      .then((data) => {
        if (cancelled) return;
        setLapMax(data.maxLaps || 0);
        setLapPilots(data.rows?.length || 0);
      })
      .catch(() => {
        if (!cancelled) {
          setLapMax(0);
          setLapPilots(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, testId, partId, control.overlayLiveRefresh]);

  const patch = async (data: Parameters<typeof api.setOverlayLive>[1]) => {
    if (!id) return;
    setSaving(true);
    setError("");
    try {
      const r = await api.setOverlayLive(id, data);
      setControl(parseOverlayControl(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo actualizar");
    } finally {
      setSaving(false);
    }
  };

  const variant = event?.overlayVariant || board?.event.overlayVariant || "classic";
  const pageSize = standingsPageSize(variant);
  const section = board?.sections?.length
    ? board.sections[board.sections.length - 1]
    : null;
  const standingsCount = Math.max(1, Math.ceil(Math.min(section?.rows.length || 0, TOP) / Math.max(1, pageSize || 1)));
  const standingsPages = pageSize > 0 && (section?.rows.length || 0) > 0 ? standingsCount : 0;
  const lapPilotPages = Math.max(1, Math.ceil(lapPilots / LAP_PILOT_SIZE) || 1);
  const lapColPages = Math.max(1, Math.ceil(Math.max(1, lapMax) / LAPS_PER_PAGE));
  const selectedTest = event?.tests.find((t) => t.id === testId);
  const manual = control.overlayPagingMode === "manual";

  const goStandings = (i: number) =>
    void patch({ overlayPagingMode: "manual", overlayPilotPage: i });
  const goLapPilots = (i: number) =>
    void patch({ overlayPagingMode: "manual", overlayPilotPage: i });
  const goLapCols = (i: number) =>
    void patch({ overlayPagingMode: "manual", overlayLapPage: i });

  return (
    <div className="ov-ctrl">
      <header className="ov-ctrl-head">
        <p className="ov-ctrl-kicker">Control de overlays</p>
        <h1>{event?.name || "Cargando…"}</h1>
        <p className="ov-ctrl-links">
          <a href={`/overlay/${id}`} target="_blank" rel="noreferrer">
            Posiciones (OBS)
          </a>
          {testId && partId ? (
            <a
              href={`/overlay/${id}/vuelta-a-vuelta?test=${testId}&part=${partId}`}
              target="_blank"
              rel="noreferrer"
            >
              Vuelta a vuelta (OBS)
            </a>
          ) : null}
          <Link to={`/eventos/${id}`}>Volver al evento</Link>
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <section className="ov-ctrl-card">
        <h2>Actualización de datos</h2>
        <p>On recarga CSV cada 5 s. Off deja el último cuadro.</p>
        <button
          type="button"
          className={`btn btn-overlay-live ${control.overlayLiveRefresh ? "is-on" : "is-off"}`}
          disabled={saving}
          onClick={() => void patch({ overlayLiveRefresh: !control.overlayLiveRefresh })}
        >
          {control.overlayLiveRefresh ? "Actualización: On" : "Actualización: Off"}
        </button>
      </section>

      <section className="ov-ctrl-card">
        <h2>Paginación</h2>
        <p>Auto cambia solo. Manual se queda en la página que elijas. La página de pilotos es la misma en posiciones y vuelta a vuelta.</p>
        <div className="ov-ctrl-row">
          <button
            type="button"
            className={`ov-ctrl-mode${control.overlayPagingMode !== "manual" ? " is-on" : ""}`}
            disabled={saving}
            onClick={() => void patch({ overlayPagingMode: "auto" })}
          >
            Auto
          </button>
          <button
            type="button"
            className={`ov-ctrl-mode${manual ? " is-on" : ""}`}
            disabled={saving}
            onClick={() => void patch({ overlayPagingMode: "manual" })}
          >
            Manual
          </button>
        </div>
      </section>

      {pageSize > 0 ? (
        <section className="ov-ctrl-card">
          <h2>Posiciones — página de pilotos</h2>
          <p>
            {pageSize} por página
            {manual ? "" : " (pasa a Manual al elegir una)"}
          </p>
          <div className="ov-ctrl-row">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving || standingsPages <= 1}
              onClick={() =>
                goStandings(
                  (control.overlayPilotPage - 1 + Math.max(1, standingsPages)) %
                    Math.max(1, standingsPages)
                )
              }
            >
              Anterior
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving || standingsPages <= 1}
              onClick={() =>
                goStandings((control.overlayPilotPage + 1) % Math.max(1, standingsPages))
              }
            >
              Siguiente
            </button>
          </div>
          <PageButtons
            count={standingsPages}
            current={control.overlayPilotPage}
            onSelect={goStandings}
            labelFor={(i) => {
              const a = i * pageSize + 1;
              const b = Math.min((i + 1) * pageSize, section?.rows.length || 0);
              return `${a}–${b}`;
            }}
          />
        </section>
      ) : (
        <section className="ov-ctrl-card">
          <h2>Posiciones</h2>
          <p>El overlay classic no pagina. Usa Pony Malta o RedBull para elegir página.</p>
        </section>
      )}

      <section className="ov-ctrl-card">
        <h2>Vuelta a vuelta</h2>
        <div className="ov-ctrl-selects">
          <label>
            Prueba
            <select
              value={testId}
              onChange={(e) => {
                const next = e.target.value;
                setTestId(next);
                const part = event?.tests.find((t) => t.id === next)?.parts[0];
                setPartId(part?.id || "");
              }}
            >
              {(event?.tests || []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Salida
            <select value={partId} onChange={(e) => setPartId(e.target.value)}>
              {(selectedTest?.parts || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <h3>Pilotos (2 por página)</h3>
        <div className="ov-ctrl-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving || lapPilotPages <= 1}
            onClick={() =>
              goLapPilots((control.overlayPilotPage - 1 + lapPilotPages) % lapPilotPages)
            }
          >
            Anterior
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving || lapPilotPages <= 1}
            onClick={() => goLapPilots((control.overlayPilotPage + 1) % lapPilotPages)}
          >
            Siguiente
          </button>
        </div>
        <PageButtons
          count={lapPilots > 0 ? lapPilotPages : 0}
          current={control.overlayPilotPage}
          onSelect={goLapPilots}
          labelFor={(i) => {
            const a = i * LAP_PILOT_SIZE + 1;
            const b = Math.min((i + 1) * LAP_PILOT_SIZE, lapPilots);
            return `${a}–${b}`;
          }}
        />

        <h3>Vueltas (máx. 8 por página)</h3>
        <div className="ov-ctrl-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving || lapColPages <= 1}
            onClick={() =>
              goLapCols((control.overlayLapPage - 1 + lapColPages) % lapColPages)
            }
          >
            Anterior
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving || lapColPages <= 1}
            onClick={() => goLapCols((control.overlayLapPage + 1) % lapColPages)}
          >
            Siguiente
          </button>
        </div>
        <PageButtons
          count={lapMax > 0 ? lapColPages : 0}
          current={control.overlayLapPage}
          onSelect={goLapCols}
          labelFor={(i) => {
            const a = i * LAPS_PER_PAGE + 1;
            const b = Math.min((i + 1) * LAPS_PER_PAGE, Math.max(1, lapMax));
            return `${a}–${b}`;
          }}
        />
      </section>
    </div>
  );
}
