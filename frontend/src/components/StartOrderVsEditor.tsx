import { useEffect, useState } from "react";
import type { Pilot, StartOrderVsPair, TestPart } from "../types";
import { pilotArtCandidates } from "../overlays/redbull/pilotArt";
import { api } from "../api";

type Props = {
  eventId: string;
  testId: string;
  testName: string;
  part: TestPart;
  pilots: Pilot[];
  /** Currently published Orden de salida for the event (only one allowed) */
  publishedStartOrder?: { testId: string; partId: string } | null;
  onSaved: (pairs: StartOrderVsPair[]) => void;
  onPublishedChange: (published: { testId: string; partId: string } | null) => void;
  save: (pairs: StartOrderVsPair[]) => Promise<void>;
};

function normalizeNum(n: string): string {
  return String(n || "")
    .replace(/^#/, "")
    .trim();
}

function MiniPilot({
  number,
  pilots,
}: {
  number: string;
  pilots: Pilot[];
}) {
  const n = normalizeNum(number);
  const pilot = pilots.find(
    (p) => normalizeNum(p.number).toUpperCase() === n.toUpperCase()
  );
  const name = pilot?.name || "";
  const candidates = pilotArtCandidates(n, name);
  const [idx, setIdx] = useState(0);
  const src = n && idx < candidates.length ? candidates[idx] : null;

  useEffect(() => {
    setIdx(0);
  }, [n, name]);

  if (!n) {
    return <span className="so-edit-preview muted">—</span>;
  }

  return (
    <span className="so-edit-preview">
      {src ? (
        <img src={src} alt={name || n} onError={() => setIdx((i) => i + 1)} />
      ) : (
        <span className="so-edit-preview-text">
          #{n} {name ? `· ${name}` : "· sin ficha / sin PNG"}
        </span>
      )}
    </span>
  );
}

export function StartOrderVsEditor({
  eventId,
  testId,
  testName,
  part,
  pilots,
  publishedStartOrder,
  onSaved,
  onPublishedChange,
  save,
}: Props) {
  const [pairs, setPairs] = useState<StartOrderVsPair[]>(
    () => part.startOrderVs || []
  );
  const [draftA, setDraftA] = useState("");
  const [draftB, setDraftB] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isPublished =
    publishedStartOrder?.testId === testId && publishedStartOrder?.partId === part.id;

  useEffect(() => {
    setPairs(part.startOrderVs || []);
  }, [part.id, part.startOrderVs]);

  const persist = async (next: StartOrderVsPair[]) => {
    setBusy(true);
    setErr("");
    try {
      await save(next);
      setPairs(next);
      onSaved(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  };

  const addPair = async () => {
    const a = normalizeNum(draftA);
    const b = normalizeNum(draftB);
    if (!a || !b) {
      setErr("Escribe el número de ambos pilotos");
      return;
    }
    const next = [...pairs, { a, b }];
    setDraftA("");
    setDraftB("");
    await persist(next);
  };

  const removeAt = async (index: number) => {
    const next = pairs.filter((_, i) => i !== index);
    await persist(next);
  };

  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= pairs.length) return;
    const next = [...pairs];
    const tmp = next[index];
    next[index] = next[j];
    next[j] = tmp;
    await persist(next);
  };

  const togglePublish = async () => {
    setBusy(true);
    setErr("");
    try {
      if (isPublished) {
        await api.unpublishOrdenSalida(eventId);
        onPublishedChange(null);
      } else {
        if (pairs.length === 0) {
          setErr("Agrega al menos un VS antes de publicar");
          return;
        }
        const res = await api.publishOrdenSalida(eventId, testId, part.id);
        onPublishedChange(res.publishedStartOrder);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo publicar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="so-editor">
      <div className="so-editor-head">
        <div>
          <p className="so-editor-title">
            Orden de salida (VS)
            {isPublished && <span className="so-editor-live"> · En overlay</span>}
          </p>
          <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
            Enfrentamientos 1 vs 1 para {testName} — {part.name}. Solo puede haber un orden
            publicado a la vez; al publicar este se quita el anterior.
          </p>
        </div>
        <div className="so-editor-head-actions">
          <button
            type="button"
            className={isPublished ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
            disabled={busy || (!isPublished && pairs.length === 0)}
            onClick={togglePublish}
          >
            {isPublished ? "Despublicar orden" : "Publicar orden de salida"}
          </button>
          <a
            className="btn btn-ghost btn-sm"
            href={`/overlay/${eventId}/orden-salida`}
            target="_blank"
            rel="noreferrer"
          >
            Ver overlay
          </a>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="so-editor-add">
        <input
          inputMode="numeric"
          placeholder="N° piloto A"
          value={draftA}
          onChange={(e) => setDraftA(e.target.value)}
          disabled={busy}
        />
        <span className="so-editor-vs">VS</span>
        <input
          inputMode="numeric"
          placeholder="N° piloto B"
          value={draftB}
          onChange={(e) => setDraftB(e.target.value)}
          disabled={busy}
        />
        <button className="btn btn-primary btn-sm" type="button" onClick={addPair} disabled={busy}>
          Agregar VS
        </button>
      </div>

      <div className="so-editor-draft-preview">
        <MiniPilot number={draftA} pilots={pilots} />
        <span className="muted">vs</span>
        <MiniPilot number={draftB} pilots={pilots} />
      </div>

      {pairs.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Aún no hay enfrentamientos en esta salida.
        </p>
      ) : (
        <ul className="so-editor-list">
          {pairs.map((p, i) => (
            <li key={`${p.a}-${p.b}-${i}`} className="so-editor-item">
              <span className="so-editor-order">{i + 1}</span>
              <MiniPilot number={p.a} pilots={pilots} />
              <span className="so-editor-vs">VS</span>
              <MiniPilot number={p.b} pilots={pilots} />
              <div className="so-editor-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || i === pairs.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => removeAt(i)}
                >
                  Quitar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
