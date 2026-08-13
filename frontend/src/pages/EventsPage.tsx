import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { canDeleteEvent } from "../lib/deleteGuards";
import { markEventUnlocked } from "../lib/eventAuth";
import type { Event } from "../types";

export function EventsPage() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<Event[]>([]);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<ConfirmDialogState | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);

  const load = async () => {
    try {
      setEvents(await api.listEvents());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const pw = password.trim();
    if (!pw) {
      setError("La contraseña del evento es obligatoria");
      return;
    }
    if (!/^[a-zA-Z0-9]+$/.test(pw)) {
      setError("La contraseña solo puede contener letras y números");
      return;
    }
    if (pw !== password2.trim()) {
      setError("Las contraseñas no coinciden");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const ev = await api.createEvent({ name, date, location, password: pw });
      setName("");
      setDate("");
      setLocation("");
      setPassword("");
      setPassword2("");
      markEventUnlocked(ev.id);
      navigate(`/eventos/${ev.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setCreating(false);
    }
  };

  const requestRemove = (ev: Event) => {
    const block = canDeleteEvent(ev);
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
      title: "Eliminar evento",
      message: `¿Eliminar «${ev.name}»? Se borrarán todos los datos del evento. Esta acción no se puede deshacer.`,
      variant: "danger",
      onConfirm: async () => {
        setDialogLoading(true);
        try {
          await api.deleteEvent(ev.id);
          await load();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Error al eliminar");
        } finally {
          setDialogLoading(false);
        }
      },
    });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Eventos</h1>
          <p>Crea un evento y gestiona sus pruebas de cronometraje con Minerva Timing.</p>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: "1rem" }}>{error}</div>}

      <div className="grid grid-2">
        <form className="card form" onSubmit={create}>
          <h3>Nuevo evento</h3>
          <div className="field">
            <label>Nombre</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del evento" required />
          </div>
          <div className="field">
            <label>Fecha</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Lugar</label>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Autódromo..." />
          </div>
          <div className="field">
            <label>Contraseña del panel</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Letras y números"
              autoComplete="new-password"
              required
            />
            <p className="muted" style={{ fontSize: "0.75rem", margin: "0.25rem 0 0" }}>
              Se pedirá para entrar al panel de gestión de este evento.
            </p>
          </div>
          <div className="field">
            <label>Confirmar contraseña</label>
            <input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="Repite la contraseña"
              autoComplete="new-password"
              required
            />
          </div>
          <button className="btn btn-primary" disabled={creating}>
            {creating ? "Creando…" : "Crear evento"}
          </button>
        </form>

        <div className="stack">
          {events.length === 0 && <div className="empty">Aún no hay eventos. Crea el primero.</div>}
          {events.map((ev) => (
            <div key={ev.id} className="card" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
              <Link to={`/eventos/${ev.id}`} className="card-link" style={{ flex: 1, border: "none", boxShadow: "none", padding: 0, background: "none" }}>
                <h3>{ev.name}</h3>
                <div className="meta">
                  {ev.date && <span>{ev.date}</span>}
                  {ev.location && <span>{ev.location}</span>}
                  <span className="chip">{ev.tests.length} pruebas</span>
                  <span className="chip">{ev.timingPoints.length} puntos</span>
                </div>
              </Link>
              <button className="btn btn-danger btn-sm" onClick={() => requestRemove(ev)}>
                Eliminar
              </button>
            </div>
          ))}
        </div>
      </div>

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
