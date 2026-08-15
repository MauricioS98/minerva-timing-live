import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, UPLOADS_BASE, formatOffsetInput, formatPenaltyInput, parseOffsetToMs } from "../api";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { canDeletePart, canDeleteTest } from "../lib/deleteGuards";
import { isEventUnlocked, markEventUnlocked } from "../lib/eventAuth";
import { matchesPilotSearch } from "../lib/search";
import type {
  CsvInputMode,
  Event,
  PartCsvSlot,
  ResultRow,
  StartOrderVsPair,
  Test,
  TestPart,
  TimingPoint,
} from "../types";
import { csvInputModeOf } from "../types";
import { MINERVA_COLORS, THEME_COLOR_LABELS, resolveThemeColors } from "../theme";
import { EventPilotsSection } from "./EventPilotsSection";
import { EventFusionPanel } from "./EventFusionPanel";
import { StartOrderVsEditor } from "../components/StartOrderVsEditor";

function msFromOffset(raw: string): number {
  let s = raw.trim().replace(",", ".");
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const parts = s.split(":");
  let ms = 0;
  if (parts.length === 4) {
    // hh:mm:ss:xxx
    ms =
      Number(parts[0]) * 3600000 +
      Number(parts[1]) * 60000 +
      Number(parts[2]) * 1000 +
      Number(parts[3]);
  } else if (parts.length === 3) {
    ms = Number(parts[0]) * 3600000 + Number(parts[1]) * 60000 + Number(parts[2]) * 1000;
  } else if (parts.length === 2) {
    ms = Number(parts[0]) * 60000 + Number(parts[1]) * 1000;
  }
  return neg ? -ms : ms;
}

export function EventDetailPage() {
  const { id } = useParams();
  const [event, setEvent] = useState<Event | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [expandedTests, setExpandedTests] = useState<Record<string, boolean>>({});
  const [partByTest, setPartByTest] = useState<Record<string, string | null>>({});
  const [resultsByTest, setResultsByTest] = useState<
    Record<
      string,
      {
        rows: ResultRow[];
        title: string;
        warning: string;
        diffNote?: string;
        partId?: string;
        scope: string;
      }
    >
  >({});
  const [offsetDrafts, setOffsetDrafts] = useState<Record<string, string>>({});
  const [penaltyDrafts, setPenaltyDrafts] = useState<
    Record<string, { timePenalty: string; positionPenalty: string; comment: string }>
  >({});
  const [savingPenalty, setSavingPenalty] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ConfirmDialogState | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const [themeColors, setThemeColors] = useState<string[]>([...MINERVA_COLORS]);
  const [resultsSearchByTest, setResultsSearchByTest] = useState<Record<string, string>>({});
  const [unlocked, setUnlocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [overlayLiveSaving, setOverlayLiveSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const ev = await api.getEvent(id);
    setEvent(ev);
    setThemeColors(resolveThemeColors(ev.themeColors));
    setOffsetDrafts(
      Object.fromEntries(ev.timingPoints.map((p) => [p.id, formatOffsetInput(p.offsetMs)]))
    );
    setPartByTest((prev) => {
      const next = { ...prev };
      for (const t of ev.tests) {
        if (next[t.id] == null && t.parts[0]) next[t.id] = t.parts[0].id;
      }
      return next;
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setUnlocked(isEventUnlocked(id));
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const tryUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setUnlocking(true);
    setUnlockError("");
    try {
      await api.unlockEvent(id, unlockPassword);
      markEventUnlocked(id);
      setUnlocked(true);
      setUnlockPassword("");
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Contraseña incorrecta");
    } finally {
      setUnlocking(false);
    }
  };

  const toggleTest = (testId: string) => {
    setExpandedTests((prev) => ({ ...prev, [testId]: !prev[testId] }));
  };

  const refreshResults = async (testId: string, partId?: string | null) => {
    if (!event) return;
    const test = event.tests.find((t) => t.id === testId);
    if (!test) return;
    const pts = [...event.timingPoints].sort((a, b) => a.order - b.order);
    const from = test.fromPointId || pts[0]?.id || "";
    const to = test.toPointId || pts[1]?.id || "";
    const pid = partId || undefined;
    setError("");
    try {
      const data = await api.getResults(event.id, testId, {
        from,
        to,
        partId: pid,
      });
      setResultsByTest((prev) => ({
        ...prev,
        [testId]: {
          rows: data.rows,
          title: data.title,
          warning: data.warning || "",
          diffNote: data.diffNote || "",
          partId: pid,
          scope: data.scope,
        },
      }));
      const drafts: Record<string, { timePenalty: string; positionPenalty: string; comment: string }> =
        {};
      for (const r of data.rows) {
        const key = `${testId}:${r.number}`;
        drafts[key] = {
          timePenalty: formatPenaltyInput(r.timePenaltyMs),
          positionPenalty: r.positionPenalty ? String(r.positionPenalty) : "",
          comment: r.comment || "",
        };
      }
      setPenaltyDrafts((prev) => ({ ...prev, ...drafts }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al calcular resultados");
    }
  };

  const saveRowPenalty = async (testId: string, scope: string, number: string) => {
    if (!event) return;
    const key = `${testId}:${number}`;
    const draft = penaltyDrafts[key] || { timePenalty: "", positionPenalty: "", comment: "" };
    setSavingPenalty(key);
    setError("");
    try {
      await api.savePenalty(event.id, testId, {
        number,
        scope,
        timePenalty: draft.timePenalty || "0",
        positionPenalty: Number(draft.positionPenalty || 0),
        comment: draft.comment,
      });
      await load();
      const current = resultsByTest[testId];
      await refreshResults(testId, current?.partId ?? null);
      setMsg(`Penalización guardada para #${number}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar penalización");
    } finally {
      setSavingPenalty(null);
    }
  };

  if (!event) {
    return <div className="empty">{error || "Cargando evento…"}</div>;
  }

  if (!unlocked) {
    return (
      <div className="event-lock">
        <div className="card event-lock-card">
          <Link to="/" className="event-manage-back">
            ← Eventos
          </Link>
          <p className="manage-section-kicker">Acceso restringido</p>
          <h2>{event.name}</h2>
          <p className="muted">
            Ingresa la contraseña del evento para abrir el panel de gestión.
            {event.date || event.location
              ? ` · ${[event.date, event.location].filter(Boolean).join(" · ")}`
              : ""}
          </p>
          <form className="form" onSubmit={tryUnlock}>
            <div className="field">
              <label>Contraseña</label>
              <input
                type="password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
            </div>
            {unlockError && <div className="alert alert-error">{unlockError}</div>}
            <button className="btn btn-primary" disabled={unlocking}>
              {unlocking ? "Verificando…" : "Entrar al panel"}
            </button>
          </form>
          <div className="event-lock-footer">
            <a className="btn btn-ghost btn-sm" href={`/tablero/${event.id}`} target="_blank" rel="noreferrer">
              Tablero público
            </a>
          </div>
        </div>
      </div>
    );
  }

  const points = [...event.timingPoints].sort((a, b) => a.order - b.order);

  const saveMeta = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const isDefault =
      themeColors.length === 4 &&
      themeColors.every((c, i) => c.toLowerCase() === MINERVA_COLORS[i].toLowerCase());

    const payload: Parameters<typeof api.updateEvent>[1] = {
      name: String(fd.get("name") || ""),
      date: String(fd.get("date") || ""),
      location: String(fd.get("location") || ""),
      footerText: String(fd.get("footerText") || ""),
      boardPageSeconds: Math.min(
        120,
        Math.max(3, Math.round(Number(fd.get("boardPageSeconds")) || 10))
      ),
      overlayVariant:
        fd.get("overlayVariant") === "redbull"
          ? "redbull"
          : fd.get("overlayVariant") === "ponymalta"
            ? "ponymalta"
            : "classic",
      overlayTiming: fd.get("overlayTiming") === "total" ? "total" : "splits",
      csvSource:
        fd.get("csvSource") === "orbits4" || fd.get("csvSource") === "orbits5"
          ? (fd.get("csvSource") as "orbits4" | "orbits5")
          : "auto",
      themeColors: isDefault ? null : themeColors,
    };

    const pw = newPassword.trim();
    if (pw) {
      if (!/^[a-zA-Z0-9]+$/.test(pw)) {
        setError("La nueva contraseña solo puede contener letras y números");
        return;
      }
      if (pw !== newPassword2.trim()) {
        setError("Las contraseñas nuevas no coinciden");
        return;
      }
      payload.password = pw;
    }

    await api.updateEvent(event.id, payload);
    setNewPassword("");
    setNewPassword2("");
    setMsg(pw ? "Evento actualizado (contraseña cambiada)" : "Evento actualizado");
    load();
  };

  const overlayLiveOn = event.overlayLiveRefresh !== false;

  const toggleOverlayLive = async () => {
    setOverlayLiveSaving(true);
    setError("");
    try {
      const next = !overlayLiveOn;
      const r = await api.setOverlayLive(event.id, next);
      setEvent((prev) =>
        prev ? { ...prev, overlayLiveRefresh: r.overlayLiveRefresh } : prev
      );
      setMsg(
        r.overlayLiveRefresh
          ? "Overlays en vivo: se actualizan cada 5 segundos."
          : "Overlays pausados: se queda el último cuadro. Al reactivar se recargan al instante."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar la actualización del overlay");
    } finally {
      setOverlayLiveSaving(false);
    }
  };

  const saveTimingPoints = async () => {
    const payload = points.map((p, i) => ({
      ...p,
      order: i,
      offsetMs: i === 0 ? 0 : msFromOffset(offsetDrafts[p.id] || "0"),
    }));
    await api.updateTimingPoints(event.id, payload);
    setMsg("Puntos de cronometraje guardados (desfases relativos a PC A)");
    await load();
  };

  const addPoint = async () => {
    const next = String.fromCharCode(65 + points.length);
    const payload: TimingPoint[] = [
      ...points,
      { id: crypto.randomUUID(), name: `PC ${next}`, offsetMs: 0, order: points.length },
    ];
    await api.updateTimingPoints(event.id, payload);
    await load();
  };

  const removePoint = async (pointId: string) => {
    if (points.length <= 2) {
      setError("Se necesitan al menos 2 puntos (A y B)");
      return;
    }
    if (points[0]?.id === pointId) {
      setError("No se puede eliminar el punto de referencia (PC A)");
      return;
    }
    await api.updateTimingPoints(
      event.id,
      points.filter((p) => p.id !== pointId).map((p, i) => ({ ...p, order: i }))
    );
    await load();
  };

  const onHeader = async (file: File | null) => {
    if (!file) return;
    await api.uploadHeader(event.id, file);
    setMsg("Imagen de cabecera actualizada");
    load();
  };

  const addTest = async () => {
    const name = prompt("Nombre de la prueba", `Prueba ${event.tests.length + 1}`);
    if (!name) return;
    const t = (await api.createTest(event.id, name)) as Test;
    await load();
    setExpandedTests((prev) => ({ ...prev, [t.id]: true }));
  };

  const requestDeleteTest = (test: Test) => {
    if (!event) return;
    const block = canDeleteTest(event, test);
    if (block) {
      setDialog({
        title: "No se puede eliminar",
        message: block,
        variant: "alert",
        onConfirm: () => {},
      });
      return;
    }
    setDialog({
      title: "Eliminar prueba",
      message: `¿Eliminar «${test.name}»? Esta acción no se puede deshacer.`,
      variant: "danger",
      onConfirm: async () => {
        setDialogLoading(true);
        try {
          await api.deleteTest(event.id, test.id);
          setExpandedTests((prev) => {
            const next = { ...prev };
            delete next[test.id];
            return next;
          });
          await load();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Error al eliminar prueba");
        } finally {
          setDialogLoading(false);
        }
      },
    });
  };

  const publishUnified = async (test: Test, title: string, partId?: string | null) => {
    const key = partId ? `part:${test.id}:${partId}` : `unified:${test.id}`;
    setPublishingKey(key);
    setError("");
    try {
      await api.publishToBoard(event.id, {
        kind: "unified",
        refId: test.id,
        title,
        partId: partId || null,
      });
      await load();
      setMsg(`«${title}» publicado en el tablero`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al publicar");
    } finally {
      setPublishingKey(null);
    }
  };

  const unpublishEntry = async (entryId: string, label: string) => {
    setPublishingKey(entryId);
    setError("");
    try {
      await api.unpublishFromBoard(event.id, entryId);
      await load();
      setMsg(`«${label}» quitado del tablero`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al despublicar");
    } finally {
      setPublishingKey(null);
    }
  };

  const requestDeletePart = async (test: Test, part: TestPart) => {
    if (!event) return;
    let freshEvent = event;
    let freshTest = test;
    let freshPart = part;
    try {
      freshEvent = await api.getEvent(event.id);
      setEvent(freshEvent);
      freshTest = freshEvent.tests.find((t) => t.id === test.id) ?? test;
      freshPart = freshTest.parts.find((p) => p.id === part.id) ?? part;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al verificar la salida");
      return;
    }

    const block = canDeletePart(freshEvent, freshTest, freshPart);
    if (block) {
      setDialog({
        title: "No se puede eliminar",
        message: block,
        variant: "alert",
        onConfirm: () => {},
      });
      return;
    }
    setDialog({
      title: "Eliminar salida",
      message: `¿Eliminar «${freshPart.name}»? Se perderán los CSV cargados en esta salida.`,
      variant: "danger",
      onConfirm: async () => {
        setDialogLoading(true);
        try {
          await api.deletePart(event.id, freshTest.id, freshPart.id);
          setPartByTest((prev) => ({ ...prev, [freshTest.id]: null }));
          await load();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Error al eliminar salida");
        } finally {
          setDialogLoading(false);
        }
      },
    });
  };

  const addPart = async (testId: string) => {
    const test = event.tests.find((t) => t.id === testId);
    const name = prompt("Nombre de la parte / salida", `Salida ${(test?.parts.length || 0) + 1}`);
    if (!name) return;
    const p = (await api.createPart(event.id, testId, { name, csvInputMode: "points" })) as TestPart;
    await load();
    setPartByTest((prev) => ({ ...prev, [testId]: p.id }));
    setExpandedTests((prev) => ({ ...prev, [testId]: true }));
  };

  const setPartCsvMode = async (testId: string, part: TestPart, mode: CsvInputMode) => {
    await api.updatePart(event.id, testId, part.id, { csvInputMode: mode });
    await load();
  };

  const uploadCsv = async (
    testId: string,
    part: TestPart,
    timingPointId: string,
    file: File,
    pilotNumber?: string
  ) => {
    setError("");
    try {
      const res = await api.uploadCsv(event.id, testId, part.id, file, timingPointId, {
        combinedMode: csvInputModeOf(part) === "combined",
        pilotNumber,
      });
      const summary = res.summary as {
        uniquePilots: number;
        flags: { type: string; label: string }[];
        sourceFormat?: "orbits4" | "orbits5";
        deletedSkipped?: number;
      };
      const slot = res.slot as PartCsvSlot;
      const meta = res.partMeta;
      // Merge only the uploaded slot — never replace sibling CSVs or reload the event.
      setEvent((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tests: prev.tests.map((t) =>
            t.id !== testId
              ? t
              : {
                  ...t,
                  parts: t.parts.map((p) => {
                    if (p.id !== part.id) return p;
                    const csvs = [...(p.csvs || [])];
                    const slotPilot = String(slot.pilotNumber || "").trim().toUpperCase();
                    const idx = slotPilot
                      ? csvs.findIndex(
                          (c) => String(c.pilotNumber || "").trim().toUpperCase() === slotPilot
                        )
                      : csvs.findIndex((c) => c.timingPointId === slot.timingPointId);
                    if (idx >= 0) csvs[idx] = slot;
                    else csvs.push(slot);
                    return {
                      ...p,
                      combinedMode: meta.combinedMode,
                      csvInputMode: meta.csvInputMode ?? p.csvInputMode,
                      combinedScoring: meta.combinedScoring ?? p.combinedScoring,
                      expectedLaps: meta.expectedLaps ?? p.expectedLaps,
                      csvs,
                    };
                  }),
                }
          ),
        };
      });
      const fmtLabel = summary.sourceFormat === "orbits4" ? "Orbits 4" : "Orbits 5";
      const skipped =
        summary.deletedSkipped && summary.deletedSkipped > 0
          ? ` · ${summary.deletedSkipped} pasada(s) borrada(s) omitida(s)`
          : "";
      setMsg(
        `CSV cargado (${fmtLabel}): ${summary.uniquePilots} pilotos en carrera` +
          skipped +
          (summary.flags?.length
            ? ` · Banderas: ${summary.flags.map((f) => f.label).join(", ")}`
            : "")
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al subir CSV");
    }
  };

  return (
    <div className="event-manage">
      <div className="event-manage-hero">
        <div className="event-manage-hero-main">
          <Link to="/" className="event-manage-back">
            ← Eventos
          </Link>
          <h1>{event.name}</h1>
          <p className="event-manage-meta">
            {[event.date, event.location].filter(Boolean).join(" · ") ||
              "Configura fecha y lugar en datos del evento"}
          </p>
          <div className="event-manage-stats">
            <span className="chip">{event.tests.length} pruebas</span>
            <span className="chip">{(event.pilots || []).length} pilotos</span>
            <span className="chip">{event.timingPoints.length} puntos</span>
            <span className="chip">
              {(event.resultsBoard || []).length} en tablero
            </span>
          </div>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className={`btn btn-overlay-live ${overlayLiveOn ? "is-on" : "is-off"}`}
            disabled={overlayLiveSaving}
            onClick={() => void toggleOverlayLive()}
            title={
              overlayLiveOn
                ? "Los overlays recargan datos cada 5 segundos. Clic para pausar."
                : "Overlays congelados en el último cuadro. Clic para reactivar."
            }
          >
            {overlayLiveOn ? "Actualización overlay: On" : "Actualización overlay: Off"}
          </button>
          <a
            className="btn btn-secondary"
            href={`/tablero/${event.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Tablero público
          </a>
          <a
            className="btn btn-ghost"
            href={`/overlay/${event.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Overlay
          </a>
          <a
            className="btn btn-ghost"
            href={`/overlay/${event.id}/orden-salida`}
            target="_blank"
            rel="noreferrer"
          >
            Orden de salida
          </a>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {msg && <div className="alert alert-ok">{msg}</div>}

      <section className="manage-section">
        <header className="manage-section-head">
          <span className="manage-section-kicker">01 · Configuración</span>
          <h2>Identidad y cronometraje</h2>
          <p>Datos del evento, colores de transmisión y puntos de control.</p>
        </header>

      <div className="setup-layout">
        <form className="setup-panel form" onSubmit={saveMeta}>
          <header className="setup-panel-head">
            <div>
              <h3>Datos del evento</h3>
              <p>Identidad, seguridad e imagen para exportaciones PDF.</p>
            </div>
          </header>

          <div className="field">
            <label>Nombre</label>
            <input name="name" defaultValue={event.name} required />
          </div>
          <div className="setup-inline-2">
            <div className="field">
              <label>Fecha</label>
              <input name="date" type="date" defaultValue={event.date} />
            </div>
            <div className="field">
              <label>Lugar</label>
              <input name="location" defaultValue={event.location} />
            </div>
          </div>
          <div className="field">
            <label>Texto pie de página (PDF)</label>
            <input name="footerText" defaultValue={event.footerText} />
          </div>
          <div className="field">
            <label>Cambio de página — tablero y overlay (segundos)</label>
            <input
              name="boardPageSeconds"
              type="number"
              min={3}
              max={120}
              step={1}
              defaultValue={event.boardPageSeconds ?? 10}
            />
            <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
              Tablero: 10 pilotos por página. Overlays RedBull y Pony Malta: tiempo que permanece
              la página completa tras aparecer todos los pilotos.
            </p>
          </div>
          <fieldset
            className="field overlay-variant-field"
            key={`ov-${event.id}-${event.updatedAt}`}
          >
            <legend>Overlay de transmisión</legend>
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.55rem" }}>
              Elige qué gráfico usa la URL <code>/overlay/{event.id}</code> (OBS / vMix).
              La recarga cada 5 segundos se enciende o apaga con el botón del encabezado
              (Actualización overlay On/Off); no hace falta guardar este formulario.
            </p>
            <div className="overlay-variant-options">
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="overlayVariant"
                  value="classic"
                  defaultChecked={
                    event.overlayVariant !== "redbull" &&
                    event.overlayVariant !== "ponymalta"
                  }
                />
                <span>
                  <strong>Overlay actual</strong>
                  <small>Torre Minerva (classic)</small>
                </span>
              </label>
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="overlayVariant"
                  value="redbull"
                  defaultChecked={event.overlayVariant === "redbull"}
                />
                <span>
                  <strong>Overlay RedBull</strong>
                  <small>Pieza gráfica + animación de filas</small>
                </span>
              </label>
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="overlayVariant"
                  value="ponymalta"
                  defaultChecked={event.overlayVariant === "ponymalta"}
                />
                <span>
                  <strong>Overlay Pony Malta</strong>
                  <small>Circuito Pony Malta · tabla angular top-left</small>
                </span>
              </label>
            </div>
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0.85rem 0 0.55rem" }}>
              ¿Qué tiempos muestra el overlay?
            </p>
            <div className="overlay-variant-options">
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="overlayTiming"
                  value="splits"
                  defaultChecked={event.overlayTiming !== "total"}
                />
                <span>
                  <strong>3 tiempos</strong>
                  <small>1er / 2do trayecto + total (si hay parciales)</small>
                </span>
              </label>
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="overlayTiming"
                  value="total"
                  defaultChecked={event.overlayTiming === "total"}
                />
                <span>
                  <strong>Solo total</strong>
                  <small>Una sola casilla de tiempo por piloto</small>
                </span>
              </label>
            </div>
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0.85rem 0 0.55rem" }}>
              Formato de CSV de cronometraje (Orbits)
            </p>
            <div className="overlay-variant-options">
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="csvSource"
                  value="auto"
                  defaultChecked={
                    event.csvSource !== "orbits4" && event.csvSource !== "orbits5"
                  }
                />
                <span>
                  <strong>Auto</strong>
                  <small>Detecta Orbits 5 si hay columna Borrado; si no, Orbits 4</small>
                </span>
              </label>
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="csvSource"
                  value="orbits5"
                  defaultChecked={event.csvSource === "orbits5"}
                />
                <span>
                  <strong>Orbits 5</strong>
                  <small>Ignora filas con Borrado = Yes</small>
                </span>
              </label>
              <label className="overlay-variant-option">
                <input
                  type="radio"
                  name="csvSource"
                  value="orbits4"
                  defaultChecked={event.csvSource === "orbits4"}
                />
                <span>
                  <strong>Orbits 4</strong>
                  <small>Sin Borrado: descarta pasadas donde Vueltas no aumente</small>
                </span>
              </label>
            </div>
          </fieldset>

          <div className="field">
            <label>Cambiar contraseña del panel</label>
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.4rem" }}>
              Déjalo vacío para no cambiarla. Solo letras y números.
            </p>
            <div className="setup-inline-2">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Nueva contraseña"
                autoComplete="new-password"
              />
              <input
                type="password"
                value={newPassword2}
                onChange={(e) => setNewPassword2(e.target.value)}
                placeholder="Confirmar"
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="field">
            <label>Colores del evento</label>
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.4rem" }}>
              Se usan en el tablero público y sobre todo en el overlay de transmisión. Si no
              los cambias, se usa la paleta de Minerva Timing.
            </p>
            <div className="theme-colors-grid">
              {themeColors.map((color, i) => (
                <label key={i} className="theme-color-item">
                  <input
                    type="color"
                    value={color}
                    onChange={(e) =>
                      setThemeColors((prev) => prev.map((c, j) => (j === i ? e.target.value : c)))
                    }
                  />
                  <span>{THEME_COLOR_LABELS[i]}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: "0.4rem" }}
              onClick={() => setThemeColors([...MINERVA_COLORS])}
            >
              Restablecer paleta Minerva
            </button>
          </div>

          <div className="field">
            <label>Imagen de cabecera</label>
            <label className="header-upload">
              <span className="header-upload-btn">Seleccionar imagen</span>
              <span className="muted">PNG, JPG o WebP · se usa en todo el evento</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => onHeader(e.target.files?.[0] || null)}
              />
            </label>
            {event.headerImage && (
              <div className="header-preview-wrap">
                <img
                  className="header-preview"
                  src={`${UPLOADS_BASE}/headers/${event.headerImage}?t=${event.updatedAt}`}
                  alt="Cabecera"
                />
              </div>
            )}
          </div>

          <button className="btn btn-primary">Guardar datos</button>
        </form>

        <div className="setup-panel">
          <header className="setup-panel-head">
            <h3>Puntos de cronometraje</h3>
            <button className="btn btn-secondary btn-sm" type="button" onClick={addPoint}>
              + Punto
            </button>
          </header>
          <p className="setup-panel-hint">
            PC A es la referencia (desfase 0). Si otro punto va{" "}
            <strong>adelantado</strong> respecto a A, pon desfase <strong>positivo</strong> (se resta a
            sus Tm). Si va atrasado, usa negativo. Formato <code>hh:mm:ss.xxx</code>.
          </p>

          <div className="timing-list">
            {points.map((p, i) => (
              <div key={p.id} className={`timing-card ${i === 0 ? "is-ref" : ""}`}>
                <div className="timing-card-badge">{i === 0 ? "Ref" : String.fromCharCode(65 + i)}</div>
                <div className="timing-point-row">
                  <div className="field">
                    <label>Nombre</label>
                    <input
                      value={p.name}
                      onChange={(e) => {
                        const name = e.target.value;
                        setEvent({
                          ...event,
                          timingPoints: event.timingPoints.map((tp) =>
                            tp.id === p.id ? { ...tp, name } : tp
                          ),
                        });
                      }}
                    />
                  </div>
                  <div className="field timing-offset-field">
                    <label>Desfase</label>
                    <input
                      value={i === 0 ? "00:00:00.000" : offsetDrafts[p.id] || "00:00:00.000"}
                      disabled={i === 0}
                      onChange={(e) => setOffsetDrafts({ ...offsetDrafts, [p.id]: e.target.value })}
                      placeholder="00:02:36.245"
                    />
                  </div>
                  <div className="timing-point-actions">
                    {i > 0 ? (
                      <button
                        className="btn btn-danger btn-sm row-action"
                        type="button"
                        onClick={() => removePoint(p.id)}
                        aria-label={`Eliminar ${p.name}`}
                      >
                        ×
                      </button>
                    ) : (
                      <span className="row-action-spacer" aria-hidden="true" />
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button className="btn btn-primary" type="button" onClick={saveTimingPoints}>
            Guardar puntos y desfases
          </button>
        </div>
      </div>
      </section>

      <section className="manage-section">
        <header className="manage-section-head">
          <span className="manage-section-kicker">02 · Inscripciones</span>
          <h2>Pilotos</h2>
          <p>Importa CSV o da de alta manualmente. La lista solo aplica a este evento.</p>
        </header>
        <EventPilotsSection eventId={event.id} pilots={event.pilots || []} onChange={load} />
      </section>

      <section className="manage-section">
        <header className="manage-section-head manage-section-head-row">
          <div>
            <span className="manage-section-kicker">03 · Cronometraje</span>
            <h2>Pruebas</h2>
            <p>Mangas, salidas, CSV único / por punto / por piloto y publicación al tablero.</p>
          </div>
          <button className="btn btn-secondary" onClick={addTest}>
            + Nueva prueba
          </button>
        </header>

        {event.tests.length === 0 ? (
          <div className="empty empty-panel">
            <strong>Sin pruebas aún</strong>
            <span>Crea una manga o categoría para cargar CSV y calcular tiempos.</span>
          </div>
        ) : (
          <div className="accordion">
            {event.tests.map((test) => {
              const open = Boolean(expandedTests[test.id]);
              const selectedPartId = partByTest[test.id] ?? test.parts[0]?.id ?? null;
              const selectedPart = test.parts.find((p) => p.id === selectedPartId);
              const csvMode = selectedPart ? csvInputModeOf(selectedPart) : "points";
              const testResults = resultsByTest[test.id];
              const showLapsCol =
                testResults?.rows.some((r) => r.laps != null && r.laps > 0) ?? false;
              const segmentLabels: string[] = [];
              if (testResults?.rows) {
                const seen = new Set<string>();
                for (const r of testResults.rows) {
                  for (const s of r.segments || []) {
                    const key = `${s.from}→${s.to}`;
                    if (!seen.has(key)) {
                      seen.add(key);
                      segmentLabels.push(key);
                    }
                  }
                }
              }
              const resultPart = testResults?.partId
                ? test.parts.find((p) => p.id === testResults.partId)
                : undefined;
              const lapScoringPart = (p: TestPart | undefined) =>
                Boolean(
                  p &&
                    (csvInputModeOf(p) === "combined" || csvInputModeOf(p) === "pilots") &&
                    p.combinedScoring === "laps"
                );
              const lapExportPartId = lapScoringPart(resultPart)
                ? resultPart!.id
                : lapScoringPart(selectedPart)
                  ? selectedPartId
                  : undefined;
              const showLapByLapExport = Boolean(
                lapExportPartId && testResults && testResults.rows.length > 0
              );
              const resultsSearch = resultsSearchByTest[test.id] || "";
              const filteredResultRows =
                testResults?.rows.filter((r) =>
                  matchesPilotSearch(resultsSearch, r.number, r.name)
                ) ?? [];
              const showCategoryCol =
                testResults?.rows.some((r) => Boolean(r.category?.trim())) ?? false;

              return (
                <div key={test.id} className={`accordion-item ${open ? "open" : ""}`}>
                  <button
                    type="button"
                    className="accordion-trigger"
                    onClick={() => toggleTest(test.id)}
                  >
                    <div className="accordion-trigger-main">
                      <strong>{test.name}</strong>
                      <span className="muted">
                        {test.parts.length} parte(s)
                        {!open && test.description
                          ? ` · ${test.description.slice(0, 60)}${test.description.length > 60 ? "…" : ""}`
                          : ""}
                      </span>
                    </div>
                    <span className="accordion-chevron" aria-hidden>
                      ▾
                    </span>
                  </button>

                  {open && (
                    <div className="accordion-body test-detail">
                      <div className="test-toolbar">
                        <button className="btn btn-secondary btn-sm" onClick={() => addPart(test.id)}>
                          + Parte / salida
                        </button>
                        {lapScoringPart(selectedPart) && selectedPart && (
                          <a
                            className="btn btn-ghost btn-sm"
                            href={`/overlay/${event.id}/vuelta-a-vuelta?test=${test.id}&part=${selectedPart.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Ver overlay vuelta a vuelta
                          </a>
                        )}
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => requestDeleteTest(test)}
                        >
                          Eliminar prueba
                        </button>
                      </div>

                      <section className="test-block">
                        <header className="test-block-head">
                          <h4>Descripción</h4>
                        </header>
                        <div className="field">
                          <textarea
                            rows={2}
                            value={test.description || ""}
                            placeholder="Notas de la prueba, condiciones, observaciones…"
                            onChange={(e) => {
                              const description = e.target.value;
                              setEvent({
                                ...event,
                                tests: event.tests.map((t) =>
                                  t.id === test.id ? { ...t, description } : t
                                ),
                              });
                            }}
                          />
                        </div>
                        <div className="test-block-footer">
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={Boolean(test.showDescriptionInPdf)}
                              onChange={(e) => {
                                const showDescriptionInPdf = e.target.checked;
                                setEvent({
                                  ...event,
                                  tests: event.tests.map((t) =>
                                    t.id === test.id ? { ...t, showDescriptionInPdf } : t
                                  ),
                                });
                              }}
                            />
                            Mostrar en el PDF
                          </label>
                          <button
                            className="btn btn-secondary btn-sm"
                            type="button"
                            onClick={async () => {
                              await api.updateTest(event.id, test.id, {
                                description: test.description || "",
                                showDescriptionInPdf: Boolean(test.showDescriptionInPdf),
                              });
                              setMsg("Datos de la prueba guardados");
                              load();
                            }}
                          >
                            Guardar
                          </button>
                        </div>
                      </section>

                      <section className="test-block">
                        <header className="test-block-head">
                          <h4>Salidas / CSV</h4>
                          {selectedPart && (
                            <span className="chip">
                              {csvMode === "pilots"
                                ? selectedPart.combinedScoring === "laps"
                                  ? "CSV por piloto · vueltas"
                                  : "CSV por piloto · tiempo"
                                : csvMode === "combined"
                                  ? selectedPart.combinedScoring === "laps"
                                    ? "CSV único · vueltas"
                                    : "CSV único · tiempo"
                                  : "CSV por punto"}
                            </span>
                          )}
                        </header>

                        {test.parts.length === 0 ? (
                          <div className="empty empty-sm">Agrega una parte (salida) para cargar CSV.</div>
                        ) : (
                          <>
                            <div className="part-tabs">
                              {test.parts.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  className={`part-tab ${selectedPartId === p.id ? "active" : ""}`}
                                  onClick={() =>
                                    setPartByTest((prev) => ({ ...prev, [test.id]: p.id }))
                                  }
                                >
                                  {p.name}
                                  {csvInputModeOf(p) === "pilots"
                                    ? p.combinedScoring === "laps"
                                      ? " · piloto · vueltas"
                                      : " · piloto"
                                    : csvInputModeOf(p) === "combined"
                                      ? p.combinedScoring === "laps"
                                        ? " · vueltas"
                                        : " · tiempo"
                                      : ""}
                                </button>
                              ))}
                            </div>

                            {selectedPart && (
                              <div className="stack" style={{ gap: "0.85rem" }}>
                                <div className="test-toolbar test-toolbar-subtle">
                                  <div className="csv-mode-switch">
                                    {(
                                      [
                                        ["combined", "CSV único"],
                                        ["points", "CSV por punto"],
                                        ["pilots", "CSV por piloto"],
                                      ] as const
                                    ).map(([mode, label]) => (
                                      <button
                                        key={mode}
                                        type="button"
                                        className={`btn btn-sm ${csvMode === mode ? "btn-primary" : "btn-ghost"}`}
                                        onClick={async () => {
                                          if (csvMode === mode) return;
                                          await setPartCsvMode(test.id, selectedPart, mode);
                                        }}
                                      >
                                        {label}
                                      </button>
                                    ))}
                                  </div>
                                  <button
                                    className="btn btn-danger btn-sm"
                                    onClick={() => requestDeletePart(test, selectedPart)}
                                  >
                                    Eliminar parte
                                  </button>
                                </div>

                                {(csvMode === "combined" || csvMode === "pilots") && (
                                  <div className="combined-settings">
                                    <p className="combined-settings-title">
                                      {csvMode === "pilots"
                                        ? "Puntuación CSV por piloto"
                                        : "Puntuación CSV único"}
                                    </p>
                                    <div className="combined-settings-row">
                                      <label className="combined-option">
                                        <input
                                          type="radio"
                                          name={`scoring-${selectedPart.id}`}
                                          checked={selectedPart.combinedScoring !== "laps"}
                                          onChange={async () => {
                                            await api.updatePart(event.id, test.id, selectedPart.id, {
                                              combinedScoring: "time",
                                              expectedLaps: null,
                                            });
                                            load();
                                          }}
                                        />
                                        Por tiempo
                                      </label>
                                      <label className="combined-option">
                                        <input
                                          type="radio"
                                          name={`scoring-${selectedPart.id}`}
                                          checked={selectedPart.combinedScoring === "laps"}
                                          onChange={async () => {
                                            await api.updatePart(event.id, test.id, selectedPart.id, {
                                              combinedScoring: "laps",
                                              expectedLaps: selectedPart.expectedLaps ?? null,
                                            });
                                            load();
                                          }}
                                        />
                                        Por vueltas
                                      </label>
                                    </div>
                                    {selectedPart.combinedScoring === "laps" && (
                                      <div className="combined-laps-config">
                                        <label className="combined-option">
                                          <input
                                            type="checkbox"
                                            checked={selectedPart.expectedLaps == null}
                                            onChange={async (e) => {
                                              await api.updatePart(event.id, test.id, selectedPart.id, {
                                                expectedLaps: e.target.checked ? null : 10,
                                              });
                                              load();
                                            }}
                                          />
                                          Vueltas indeterminadas
                                        </label>
                                        {selectedPart.expectedLaps != null && (
                                          <div className="field field-inline">
                                            <label>Vueltas esperadas</label>
                                            <input
                                              type="number"
                                              min={1}
                                              step={1}
                                              value={selectedPart.expectedLaps}
                                              onChange={async (e) => {
                                                const n = Number(e.target.value);
                                                if (n > 0) {
                                                  await api.updatePart(
                                                    event.id,
                                                    test.id,
                                                    selectedPart.id,
                                                    { expectedLaps: n }
                                                  );
                                                  load();
                                                }
                                              }}
                                            />
                                          </div>
                                        )}
                                        <p className="muted" style={{ fontSize: "0.78rem", margin: 0 }}>
                                          Gana quien complete más vueltas en menor tiempo.
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                )}

                                <StartOrderVsEditor
                                  eventId={event.id}
                                  testId={test.id}
                                  testName={test.name}
                                  part={selectedPart}
                                  pilots={event.pilots || []}
                                  publishedStartOrder={event.publishedStartOrder ?? null}
                                  save={async (pairs) => {
                                    await api.updatePart(event.id, test.id, selectedPart.id, {
                                      startOrderVs: pairs,
                                    });
                                  }}
                                  onSaved={(pairs: StartOrderVsPair[]) => {
                                    setEvent((prev) => {
                                      if (!prev) return prev;
                                      return {
                                        ...prev,
                                        tests: prev.tests.map((t) =>
                                          t.id !== test.id
                                            ? t
                                            : {
                                                ...t,
                                                parts: t.parts.map((p) =>
                                                  p.id === selectedPart.id
                                                    ? { ...p, startOrderVs: pairs }
                                                    : p
                                                ),
                                              }
                                        ),
                                      };
                                    });
                                  }}
                                  onPublishedChange={(published) => {
                                    setEvent((prev) =>
                                      prev ? { ...prev, publishedStartOrder: published } : prev
                                    );
                                    setMsg(
                                      published
                                        ? "Orden de salida publicado en el overlay"
                                        : "Orden de salida despublicado"
                                    );
                                  }}
                                />

                                {csvMode === "combined" ? (
                                  <CsvDrop
                                    label="CSV único"
                                    hint={
                                      selectedPart.combinedScoring === "laps"
                                        ? "Usa columnas Vueltas y T° Transcurrido"
                                        : "1ª pasada = Start, 2ª = Finish (mismo archivo)"
                                    }
                                    filename={selectedPart.csvs[0]?.filename}
                                    onFile={(f) =>
                                      uploadCsv(
                                        test.id,
                                        selectedPart,
                                        points[0]?.id || "combined",
                                        f
                                      )
                                    }
                                  />
                                ) : csvMode === "pilots" ? (
                                  (event.pilots || []).length === 0 ? (
                                    <div className="empty empty-sm">
                                      Inscribe pilotos en el evento para cargar un CSV por cada uno.
                                    </div>
                                  ) : (
                                    <div className="csv-grid">
                                      {[...(event.pilots || [])]
                                        .sort((a, b) =>
                                          String(a.number).localeCompare(String(b.number), "es", {
                                            numeric: true,
                                          })
                                        )
                                        .map((pilot) => {
                                          const key = String(pilot.number || "")
                                            .replace(/^#/, "")
                                            .trim()
                                            .toUpperCase();
                                          const slot = selectedPart.csvs.find(
                                            (c) =>
                                              String(c.pilotNumber || "")
                                                .replace(/^#/, "")
                                                .trim()
                                                .toUpperCase() === key
                                          );
                                          return (
                                            <CsvDrop
                                              key={pilot.id || pilot.number}
                                              label={`${pilot.number} · ${pilot.name || "Sin nombre"}`}
                                              hint="CSV solo con los tiempos de este piloto"
                                              filename={slot?.filename}
                                              onFile={(f) =>
                                                uploadCsv(
                                                  test.id,
                                                  selectedPart,
                                                  points[0]?.id || "combined",
                                                  f,
                                                  pilot.number
                                                )
                                              }
                                            />
                                          );
                                        })}
                                    </div>
                                  )
                                ) : (
                                  <div className="csv-grid">
                                    {points.map((p) => {
                                      const slot = selectedPart.csvs.find(
                                        (c) => c.timingPointId === p.id
                                      );
                                      return (
                                        <CsvDrop
                                          key={p.id}
                                          label={p.name}
                                          hint="Arrastra un CSV o haz clic"
                                          filename={slot?.filename}
                                          onFile={(f) =>
                                            uploadCsv(test.id, selectedPart, p.id, f)
                                          }
                                        />
                                      );
                                    })}
                                  </div>
                                )}

                                <button
                                  className="btn btn-secondary"
                                  onClick={() => refreshResults(test.id, selectedPart.id)}
                                >
                                  Calcular resultado parcial
                                </button>
                                {lapScoringPart(selectedPart) && (
                                  <a
                                    className="btn btn-ghost"
                                    href={`/overlay/${event.id}/vuelta-a-vuelta?test=${test.id}&part=${selectedPart.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ marginLeft: "0.5rem" }}
                                  >
                                    Ver overlay vuelta a vuelta
                                  </a>
                                )}
                                <p className="muted" style={{ fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
                                  {csvMode === "combined" && selectedPart.combinedScoring !== "laps"
                                    ? "Start y Finish salen del mismo CSV (1ª y 2ª pasada). Si el CSV es acumulativo entre salidas, solo se listan pilotos nuevos."
                                    : csvMode === "pilots"
                                      ? "Cada archivo corresponde a un piloto. Por tiempo: 1ª pasada = Start y 2ª = Finish. Por vueltas: más vueltas en menor tiempo total."
                                      : "Si el CSV es acumulativo, solo se listan pilotos nuevos respecto a salidas anteriores."}
                                </p>
                              </div>
                            )}
                          </>
                        )}
                      </section>

                      <section className="test-block test-block-results">
                        <header className="test-block-head">
                          <h4>Resultados</h4>
                        </header>

                        <p className="muted" style={{ fontSize: "0.78rem", margin: "0 0 0.5rem" }}>
                          {csvMode === "combined"
                            ? "Esta salida usa CSV único: Start y Finish se leen del mismo archivo."
                            : csvMode === "pilots"
                              ? "Esta salida usa un CSV por piloto. El ranking une todos los archivos cargados."
                              : "Configura cómo se miden los tiempos en esta prueba. La fusión usa esta configuración de cada prueba por separado."}
                        </p>

                        <div className="results-controls">
                          {csvMode === "combined" || csvMode === "pilots" ? (
                            <div className="combined-results-note">
                              {selectedPart.combinedScoring === "laps" ? (
                                <p>
                                  Clasificación por <strong>vueltas</strong>
                                  {csvMode === "pilots"
                                    ? " de los CSV por piloto"
                                    : " del CSV único"}{" "}
                                  (columnas de vueltas / tiempo transcurrido).
                                </p>
                              ) : (
                                <p>
                                  Por tiempo: la <strong>1ª pasada</strong> es la salida y la{" "}
                                  <strong>2ª</strong> la llegada
                                  {csvMode === "pilots" ? " (un CSV por piloto)" : " (mismo CSV)"}. Si
                                  solo hay una pasada con Tiempo de vuelta &gt; 0, se usa ese valor.
                                </p>
                              )}
                            </div>
                          ) : (
                            <>
                          <div className="field" style={{ minWidth: "220px" }}>
                            <label>Tipo de cronometraje</label>
                            <select
                              value={test.timingMode || "point_to_point"}
                              onChange={async (e) => {
                                const timingMode =
                                  e.target.value === "start_finish_partial"
                                    ? "start_finish_partial"
                                    : "point_to_point";
                                await api.updateTest(event.id, test.id, {
                                  timingMode,
                                  startFinishPointId:
                                    test.startFinishPointId || points[0]?.id || null,
                                  partialPointIds:
                                    test.partialPointIds && test.partialPointIds.length > 0
                                      ? test.partialPointIds
                                      : points[1]?.id
                                        ? [points[1].id]
                                        : [],
                                });
                                load();
                              }}
                            >
                              <option value="point_to_point">Punto a punto (Desde → Hasta)</option>
                              <option value="start_finish_partial">
                                Start/Finish + parcial (sectores + total)
                              </option>
                            </select>
                          </div>

                          {(test.timingMode || "point_to_point") === "point_to_point" ? (
                            <>
                              <div className="field">
                                <label>Desde</label>
                                <select
                                  value={test.fromPointId || points[0]?.id || ""}
                                  onChange={async (e) => {
                                    await api.updateTest(event.id, test.id, {
                                      fromPointId: e.target.value,
                                    });
                                    load();
                                  }}
                                >
                                  {points.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label>Hasta</label>
                                <select
                                  value={test.toPointId || points[1]?.id || ""}
                                  onChange={async (e) => {
                                    await api.updateTest(event.id, test.id, {
                                      toPointId: e.target.value,
                                    });
                                    load();
                                  }}
                                >
                                  {points.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="field">
                                <label>Start / Finish</label>
                                <select
                                  value={
                                    test.startFinishPointId ||
                                    test.fromPointId ||
                                    points[0]?.id ||
                                    ""
                                  }
                                  onChange={async (e) => {
                                    await api.updateTest(event.id, test.id, {
                                      startFinishPointId: e.target.value,
                                    });
                                    load();
                                  }}
                                >
                                  {points.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label>Punto parcial</label>
                                <select
                                  value={
                                    (test.partialPointIds && test.partialPointIds[0]) ||
                                    test.toPointId ||
                                    points[1]?.id ||
                                    ""
                                  }
                                  onChange={async (e) => {
                                    await api.updateTest(event.id, test.id, {
                                      partialPointIds: e.target.value ? [e.target.value] : [],
                                    });
                                    load();
                                  }}
                                >
                                  {points
                                    .filter(
                                      (p) =>
                                        p.id !==
                                        (test.startFinishPointId ||
                                          test.fromPointId ||
                                          points[0]?.id)
                                    )
                                    .map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                </select>
                              </div>
                            </>
                          )}
                            </>
                          )}

                          <button
                            className="btn btn-primary results-run-btn"
                            onClick={() => refreshResults(test.id, null)}
                          >
                            Unificado (mejor tiempo)
                          </button>
                        </div>

                        {csvMode === "points" &&
                          (test.timingMode || "point_to_point") === "start_finish_partial" && (
                          <p className="muted" style={{ fontSize: "0.78rem", margin: "0 0 0.75rem" }}>
                            En este modo cada piloto debe tener <strong>2 pasadas</strong> en Start/Finish
                            (salida y llegada) y <strong>1 pasada</strong> en el parcial entre ambas.
                            El resultado muestra el tiempo Start→Parcial, Parcial→Finish y el total.
                          </p>
                        )}

                        {testResults?.title && (
                          <p className="results-title">{testResults.title}</p>
                        )}
                        {testResults?.warning && (
                          <div className="alert alert-error">{testResults.warning}</div>
                        )}
                        {testResults?.diffNote && (
                          <div className="alert alert-info">{testResults.diffNote}</div>
                        )}

                        {testResults?.title &&
                          testResults.rows.length === 0 &&
                          !testResults.warning && (
                            <div className="empty empty-sm">
                              {testResults.diffNote || "Sin resultados para mostrar."}
                            </div>
                          )}

                        {testResults && testResults.rows.length > 0 && (
                          <>
                            <div className="export-row">
                              {(["csv", "xlsx", "pdf"] as const).map((fmt) => (
                                <a
                                  key={fmt}
                                  className="btn btn-ghost btn-sm"
                                  href={api.exportUrl(event.id, test.id, fmt, {
                                    from: test.fromPointId || points[0]?.id,
                                    to: test.toPointId || points[1]?.id,
                                    partId: testResults.partId,
                                  })}
                                >
                                  {fmt.toUpperCase()}
                                </a>
                              ))}
                              {showLapByLapExport && (
                                <>
                                  <a
                                    className="btn btn-ghost btn-sm"
                                    href={`/overlay/${event.id}/vuelta-a-vuelta?test=${test.id}&part=${lapExportPartId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Ver overlay vuelta a vuelta
                                  </a>
                                  <a
                                    className="btn btn-ghost btn-sm"
                                    href={api.exportUrl(event.id, test.id, "pdf-vueltas", {
                                      from: test.fromPointId || points[0]?.id,
                                      to: test.toPointId || points[1]?.id,
                                      partId: lapExportPartId,
                                    })}
                                    title="PDF con el tiempo de cada vuelta por piloto"
                                  >
                                    Vuelta a vuelta
                                  </a>
                                  <a
                                    className="btn btn-ghost btn-sm"
                                    href={api.exportUrl(event.id, test.id, "pdf-vueltas-horas", {
                                      from: test.fromPointId || points[0]?.id,
                                      to: test.toPointId || points[1]?.id,
                                      partId: lapExportPartId,
                                    })}
                                    title="PDF con tiempo de vuelta y hora de paso (Tm de pasos)"
                                  >
                                    Vuelta a vuelta con horas
                                  </a>
                                </>
                              )}
                              {!testResults.partId && (
                                (() => {
                                  const boardEntry = (event.resultsBoard || []).find(
                                    (e) =>
                                      e.kind === "unified" &&
                                      e.refId === test.id &&
                                      !e.partId
                                  );
                                  if (boardEntry) {
                                    return (
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        disabled={publishingKey === boardEntry.id}
                                        onClick={() =>
                                          unpublishEntry(boardEntry.id, boardEntry.title)
                                        }
                                      >
                                        Quitar del tablero
                                      </button>
                                    );
                                  }
                                  return (
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      disabled={publishingKey === `unified:${test.id}`}
                                      onClick={() =>
                                        publishUnified(
                                          test,
                                          testResults.title || `${test.name} — Resultado unificado`
                                        )
                                      }
                                    >
                                      Publicar en tablero
                                    </button>
                                  );
                                })()
                              )}
                              {testResults.partId && (
                                (() => {
                                  const boardEntry = (event.resultsBoard || []).find(
                                    (e) =>
                                      e.kind === "unified" &&
                                      e.refId === test.id &&
                                      e.partId === testResults.partId
                                  );
                                  if (boardEntry) {
                                    return (
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        disabled={publishingKey === boardEntry.id}
                                        onClick={() =>
                                          unpublishEntry(boardEntry.id, boardEntry.title)
                                        }
                                      >
                                        Quitar del tablero
                                      </button>
                                    );
                                  }
                                  return (
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      disabled={
                                        publishingKey ===
                                        `part:${test.id}:${testResults.partId}`
                                      }
                                      onClick={() =>
                                        publishUnified(
                                          test,
                                          testResults.title ||
                                            `${test.name} — resultado parcial`,
                                          testResults.partId
                                        )
                                      }
                                    >
                                      Publicar en tablero
                                    </button>
                                  );
                                })()
                              )}
                            </div>
                            <div className="results-toolbar">
                              <div className="field results-search-field">
                                <label>Buscar piloto</label>
                                <input
                                  type="search"
                                  value={resultsSearch}
                                  onChange={(e) =>
                                    setResultsSearchByTest((prev) => ({
                                      ...prev,
                                      [test.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="Nº o nombre…"
                                  autoComplete="off"
                                />
                              </div>
                              {resultsSearch.trim() && (
                                <span className="muted results-search-count">
                                  {filteredResultRows.length} de {testResults.rows.length}
                                </span>
                              )}
                            </div>
                            {filteredResultRows.length === 0 ? (
                              <div className="empty empty-sm">
                                Ningún piloto coincide con «{resultsSearch.trim()}».
                              </div>
                            ) : (
                            <div className="table-wrap results-table-wrap">
                              <table className="results-table">
                                <thead>
                                  <tr>
                                    <th>Pos</th>
                                    <th>N°</th>
                                    <th>Nombre</th>
                                    {showCategoryCol && <th>Categoría</th>}
                                    <th>Liga</th>
                                    {showLapsCol && <th>Vueltas</th>}
                                    {segmentLabels.map((label) => (
                                      <th key={label}>{label}</th>
                                    ))}
                                    <th>{segmentLabels.length > 0 ? "Total" : "Tiempo"}</th>
                                    <th>Salida</th>
                                    <th>Pen. tiempo</th>
                                    <th>Pen. pos</th>
                                    <th>Comentario</th>
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {filteredResultRows.map((r) => {
                                    const pKey = `${test.id}:${r.number}`;
                                    const draft = penaltyDrafts[pKey] || {
                                      timePenalty: "",
                                      positionPenalty: "",
                                      comment: "",
                                    };
                                    return (
                                      <tr
                                        key={`${r.number}-${r.partId || "u"}-${r.incomplete ? "inc" : "ok"}`}
                                        className={[
                                          r.hasPenalty ? "row-penalty" : "",
                                          r.incomplete ? "row-incomplete" : "",
                                        ]
                                          .filter(Boolean)
                                          .join(" ")}
                                      >
                                        <td
                                          className={
                                            !r.incomplete && r.position <= 3 ? `pos-${r.position}` : ""
                                          }
                                        >
                                          {r.incomplete ? "—" : r.position}
                                        </td>
                                        <td>{r.number}</td>
                                        <td>
                                          {r.name || "—"}
                                          {r.missingPilot && (
                                            <span className="badge-warn"> · sin ficha</span>
                                          )}
                                        </td>
                                        {showCategoryCol && <td>{r.category || "—"}</td>}
                                        <td>{r.league || "—"}</td>
                                        {showLapsCol && (
                                          <td>
                                            {r.laps != null ? (
                                              <>
                                                {r.expectedLaps != null
                                                  ? `${r.laps} / ${r.expectedLaps}`
                                                  : r.laps}
                                                {r.lapsIncomplete && (
                                                  <span className="badge-warn"> · incompleto</span>
                                                )}
                                              </>
                                            ) : (
                                              "—"
                                            )}
                                          </td>
                                        )}
                                        {segmentLabels.map((label) => {
                                          const seg = (r.segments || []).find(
                                            (s) => `${s.from}→${s.to}` === label
                                          );
                                          return (
                                            <td key={label} className="time">
                                              {r.incomplete ? "—" : seg?.timeFormatted || "—"}
                                            </td>
                                          );
                                        })}
                                        <td className="time">
                                          {r.incomplete ? (
                                            <span className="badge-incomplete" title={r.statusLabel}>
                                              {r.statusLabel || "Incompleto"}
                                            </span>
                                          ) : (
                                            <>
                                              {r.timeFormatted}
                                              {r.statusLabel === "En curso" && (
                                                <div className="muted" style={{ fontSize: "0.72rem" }}>
                                                  En curso
                                                </div>
                                              )}
                                              {r.timePenaltyMs > 0 && (
                                                <div className="muted" style={{ fontSize: "0.75rem" }}>
                                                  base {r.rawTimeFormatted}
                                                </div>
                                              )}
                                            </>
                                          )}
                                          {!r.incomplete && r.segmentLabel?.includes("(") && (
                                            <div className="muted" style={{ fontSize: "0.72rem" }}>
                                              {r.segmentLabel}
                                            </div>
                                          )}
                                        </td>
                                        <td>{r.partName || "—"}</td>
                                        <td>
                                          <div className="penalty-time-cell">
                                            <input
                                              className="penalty-input"
                                              placeholder="0:05.000"
                                              value={draft.timePenalty}
                                              onChange={(e) =>
                                                setPenaltyDrafts((prev) => ({
                                                  ...prev,
                                                  [pKey]: { ...draft, timePenalty: e.target.value },
                                                }))
                                              }
                                            />
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm penalty-adj"
                                              title="Restar 5 segundos"
                                              onClick={() => {
                                                const current = parseOffsetToMs(draft.timePenalty || "0");
                                                const next = Math.max(0, current - 5000);
                                                setPenaltyDrafts((prev) => ({
                                                  ...prev,
                                                  [pKey]: {
                                                    ...draft,
                                                    timePenalty: formatPenaltyInput(next),
                                                  },
                                                }));
                                              }}
                                            >
                                              −5
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm penalty-adj"
                                              title="Sumar 5 segundos"
                                              onClick={() => {
                                                const current = parseOffsetToMs(draft.timePenalty || "0");
                                                const next = Math.max(0, current) + 5000;
                                                setPenaltyDrafts((prev) => ({
                                                  ...prev,
                                                  [pKey]: {
                                                    ...draft,
                                                    timePenalty: formatPenaltyInput(next),
                                                  },
                                                }));
                                              }}
                                            >
                                              +5
                                            </button>
                                          </div>
                                        </td>
                                        <td>
                                          <input
                                            className="penalty-input penalty-input-sm"
                                            type="number"
                                            min={0}
                                            step={1}
                                            placeholder="0"
                                            value={draft.positionPenalty}
                                            onChange={(e) =>
                                              setPenaltyDrafts((prev) => ({
                                                ...prev,
                                                [pKey]: {
                                                  ...draft,
                                                  positionPenalty: e.target.value,
                                                },
                                              }))
                                            }
                                          />
                                        </td>
                                        <td>
                                          <input
                                            className="penalty-input penalty-input-wide"
                                            placeholder="Motivo…"
                                            value={draft.comment}
                                            onChange={(e) =>
                                              setPenaltyDrafts((prev) => ({
                                                ...prev,
                                                [pKey]: { ...draft, comment: e.target.value },
                                              }))
                                            }
                                          />
                                        </td>
                                        <td>
                                          <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            disabled={savingPenalty === pKey}
                                            onClick={() =>
                                              saveRowPenalty(test.id, testResults.scope, r.number)
                                            }
                                          >
                                            {savingPenalty === pKey ? "…" : "OK"}
                                          </button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            )}
                            <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
                              Pen. tiempo: formato <code>m:ss.xxx</code> o <code>hh:mm:ss.xxx</code>{" "}
                              (atajos <strong>−5</strong> / <strong>+5</strong>). Pen. pos: posiciones a
                              sumar (+). Guarda con OK; el ranking se recalcula. Los tiempos incompletos
                              (solo salida o solo llegada) aparecen marcados aquí y no salen en el PDF
                              hasta tener ambos puntos.
                            </p>
                          </>
                        )}
                      </section>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <EventFusionPanel
        eventId={event.id}
        tests={event.tests}
        points={points}
        fusions={event.fusions || []}
        resultsBoard={event.resultsBoard || []}
        onReload={load}
      />

      <ConfirmDialog
        state={dialog}
        loading={dialogLoading}
        onClose={() => {
          if (!dialogLoading) setDialog(null);
        }}
      />
    </div>
  );
}

function CsvDrop({
  label,
  hint,
  filename,
  onFile,
}: {
  label: string;
  hint?: string;
  filename?: string;
  onFile: (f: File) => void;
}) {
  const [drag, setDrag] = useState(false);
  const loaded = Boolean(filename);
  return (
    <label
      className={`csv-slot ${loaded ? "loaded" : ""} ${drag ? "drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <span className="csv-slot-label">{label}</span>
      {loaded ? (
        <span className="csv-slot-file" title={filename}>
          {filename}
        </span>
      ) : (
        <span className="csv-slot-hint">{hint || "Arrastra un CSV o haz clic"}</span>
      )}
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}
