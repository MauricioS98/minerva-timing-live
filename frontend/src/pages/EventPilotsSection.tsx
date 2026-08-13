import { useMemo, useState } from "react";
import { api } from "../api";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { matchesPilotSearch } from "../lib/search";
import type { Pilot } from "../types";

const empty: Omit<Pilot, "id"> = { number: "", name: "", category: "", league: "", notes: "" };

const MAP_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "number", label: "Nº", required: true },
  { key: "firstName", label: "Nombre" },
  { key: "lastName", label: "Apellido/s" },
  { key: "category", label: "Clase" },
  { key: "league", label: "Liga" },
  { key: "moto", label: "Moto" },
  { key: "club", label: "Club" },
  { key: "doc", label: "Doc/EPS" },
  { key: "phone", label: "Cel/Email" },
];

type Preview = {
  filename: string;
  columns: { index: number; label: string; header: string }[];
  headerOrder: string;
  sampleRows: string[][];
  suggestedMapping: Record<string, number>;
  totalDataRows: number;
};

type Props = {
  eventId: string;
  pilots: Pilot[];
  onChange: () => void;
};

export function EventPilotsSection({ eventId, pilots, onChange }: Props) {
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [drag, setDrag] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  const [skipFirstRow, setSkipFirstRow] = useState(true);
  const [sectionOpen, setSectionOpen] = useState(true);
  const [expandedPilots, setExpandedPilots] = useState<Record<string, boolean>>({});
  const [filterCategory, setFilterCategory] = useState("");
  const [filterLeague, setFilterLeague] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const [dialog, setDialog] = useState<ConfirmDialogState | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);

  const togglePilot = (id: string) => {
    setExpandedPilots((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const categories = useMemo(
    () =>
      [...new Set(pilots.map((p) => p.category).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "es")
      ),
    [pilots]
  );

  const leagues = useMemo(
    () =>
      [...new Set(pilots.map((p) => p.league).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "es")
      ),
    [pilots]
  );

  const filteredPilots = useMemo(
    () =>
      pilots.filter((p) => {
        if (filterCategory && p.category !== filterCategory) return false;
        if (filterLeague && p.league !== filterLeague) return false;
        if (!matchesPilotSearch(searchQuery, p.number, p.name)) return false;
        return true;
      }),
    [pilots, filterCategory, filterLeague, searchQuery]
  );

  const totalPages = Math.max(1, Math.ceil(filteredPilots.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const pagedPilots = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredPilots.slice(start, start + PAGE_SIZE);
  }, [filteredPilots, currentPage]);

  const setFilterCategorySafe = (value: string) => {
    setFilterCategory(value);
    setPage(1);
  };

  const setFilterLeagueSafe = (value: string) => {
    setFilterLeague(value);
    setPage(1);
  };

  const setSearchQuerySafe = (value: string) => {
    setSearchQuery(value);
    setPage(1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      if (editing) {
        await api.updatePilot(eventId, editing, form);
      } else {
        await api.createPilot(eventId, form);
      }
      setForm(empty);
      setEditing(null);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    }
  };

  const edit = (p: Pilot) => {
    setEditing(p.id);
    setForm({ number: p.number, name: p.name, category: p.category, league: p.league, notes: p.notes || "" });
  };

  const requestRemove = (pilot: Pilot) => {
    setDialog({
      title: "Eliminar piloto",
      message: `¿Eliminar al piloto N° ${pilot.number}${pilot.name ? ` — ${pilot.name}` : ""}?`,
      variant: "danger",
      onConfirm: async () => {
        setDialogLoading(true);
        try {
          await api.deletePilot(eventId, pilot.id);
          onChange();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Error al eliminar");
        } finally {
          setDialogLoading(false);
        }
      },
    });
  };

  const openImportAssistant = async (file: File) => {
    setError("");
    setMsg("");
    setLoadingPreview(true);
    try {
      const data = await api.previewPilotsImport(eventId, file);
      setPendingFile(file);
      setPreview(data);
      setMapping({ ...data.suggestedMapping });
      setSkipFirstRow(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al leer CSV");
    } finally {
      setLoadingPreview(false);
    }
  };

  const closeAssistant = () => {
    setPendingFile(null);
    setPreview(null);
    setMapping({});
  };

  const confirmImport = async () => {
    if (!pendingFile) return;
    if (mapping.number == null) {
      setError("Debes seleccionar la columna para Nº");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const res = await api.importPilots(eventId, pendingFile, mapping, skipFirstRow);
      setMsg(
        `Importado ${res.summary.filename}: ${res.summary.added} nuevos, ${res.summary.updated} actualizados` +
          (res.summary.skipped ? `, ${res.summary.skipped} omitidos` : "")
      );
      closeAssistant();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al importar");
    } finally {
      setImporting(false);
    }
  };

  const mappedPreview = useMemo(() => {
    if (!preview) return [];
    return preview.sampleRows.slice(0, 4).map((row) => {
      const first = mapping.firstName != null ? row[mapping.firstName] || "" : "";
      const last = mapping.lastName != null ? row[mapping.lastName] || "" : "";
      return {
        number: mapping.number != null ? row[mapping.number] || "" : "",
        name: [first, last].filter(Boolean).join(" "),
        category: mapping.category != null ? row[mapping.category] || "" : "",
        league: mapping.league != null ? row[mapping.league] || "" : "",
      };
    });
  }, [preview, mapping]);

  return (
    <div className="pilots-section">
      <div className={`accordion-item pilots-shell ${sectionOpen ? "open" : ""}`}>
        <button
          type="button"
          className="accordion-trigger"
          onClick={() => setSectionOpen((o) => !o)}
        >
          <div className="accordion-trigger-main">
            <strong>Base de pilotos</strong>
            <span className="muted">
              {pilots.length} registrados
              {!sectionOpen
                ? " · Expandir para importar, alta y lista"
                : " · Solo aplica a este evento"}
            </span>
          </div>
          <span className="row-inline" style={{ flexShrink: 0 }}>
            <span className="chip">{pilots.length}</span>
            <span className="accordion-chevron" aria-hidden>
              ▾
            </span>
          </span>
        </button>

        {sectionOpen && (
          <div className="accordion-body">
            {error && (
              <div className="alert alert-error" style={{ marginBottom: "1rem" }}>
                {error}
              </div>
            )}
            {msg && (
              <div className="alert" style={{ marginBottom: "1rem" }}>
                {msg}
              </div>
            )}

            <div className="card" style={{ marginBottom: "1rem", padding: "0.85rem" }}>
              <label
                className={`dropzone ${drag ? "drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) openImportAssistant(f);
                }}
              >
                <strong>{loadingPreview ? "Leyendo archivo…" : "Importar CSV de pilotos"}</strong>
                <div style={{ marginTop: "0.35rem" }}>
                  Al cargar el archivo podrás indicar qué columna corresponde a cada campo.
                </div>
                <input
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  disabled={loadingPreview || importing}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) openImportAssistant(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>

            <div className="pilots-layout">
              <form className="card form pilots-form" onSubmit={submit}>
                <h3>{editing ? "Editar piloto" : "Agregar piloto"}</h3>
                <div className="field">
                  <label>N°</label>
                  <input
                    value={form.number}
                    onChange={(e) => setForm({ ...form, number: e.target.value })}
                    placeholder="#111"
                    required
                  />
                </div>
                <div className="field">
                  <label>Nombre</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                  />
                </div>
                <div className="field">
                  <label>Categoría</label>
                  <input
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder="125cc Junior"
                  />
                </div>
                <div className="field">
                  <label>Liga</label>
                  <input
                    value={form.league}
                    onChange={(e) => setForm({ ...form, league: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Notas</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                  />
                </div>
                <div className="actions">
                  <button className="btn btn-primary">{editing ? "Guardar" : "Agregar"}</button>
                  {editing && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditing(null);
                        setForm(empty);
                      }}
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </form>

              <div className="stack pilots-list-panel">
                <div className="row-inline" style={{ justifyContent: "space-between" }}>
                  <h3 style={{ margin: 0 }}>
                    Lista{" "}
                    <span className="muted" style={{ fontWeight: 400, fontSize: "0.9rem" }}>
                      ({filteredPilots.length}
                      {filteredPilots.length !== pilots.length ? ` de ${pilots.length}` : ""})
                    </span>
                  </h3>
                  {(filterCategory || filterLeague || searchQuery) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setFilterCategorySafe("");
                        setFilterLeagueSafe("");
                        setSearchQuerySafe("");
                      }}
                    >
                      Limpiar filtros
                    </button>
                  )}
                </div>

                <div className="pilots-filters">
                  <div className="field pilots-search-field">
                    <label>Buscar</label>
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuerySafe(e.target.value)}
                      placeholder="Nº o nombre…"
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label>Categoría</label>
                    <select
                      value={filterCategory}
                      onChange={(e) => setFilterCategorySafe(e.target.value)}
                    >
                      <option value="">Todas</option>
                      {categories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Liga</label>
                    <select
                      value={filterLeague}
                      onChange={(e) => setFilterLeagueSafe(e.target.value)}
                    >
                      <option value="">Todas</option>
                      {leagues.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {pilots.length === 0 ? (
                  <div className="empty">Sin pilotos en este evento</div>
                ) : filteredPilots.length === 0 ? (
                  <div className="empty">Ningún piloto coincide con los filtros</div>
                ) : (
                  <>
                    <div className="accordion">
                      {pagedPilots.map((p) => {
                        const open = Boolean(expandedPilots[p.id]);
                        return (
                          <div key={p.id} className={`accordion-item ${open ? "open" : ""}`}>
                            <button
                              type="button"
                              className="accordion-trigger"
                              onClick={() => togglePilot(p.id)}
                            >
                              <div className="accordion-trigger-main">
                                <strong>
                                  #{p.number} · {p.name || "Sin nombre"}
                                </strong>
                                {!open && (
                                  <span className="muted">
                                    {[p.category, p.league].filter(Boolean).join(" · ") ||
                                      "Sin categoría / liga"}
                                  </span>
                                )}
                              </div>
                              <span className="accordion-chevron" aria-hidden>
                                ▾
                              </span>
                            </button>
                            {open && (
                              <div className="accordion-body">
                                <div className="accordion-meta">
                                  <span>
                                    <strong>Categoría:</strong> {p.category || "—"}
                                  </span>
                                  <span>
                                    <strong>Liga:</strong> {p.league || "—"}
                                  </span>
                                  {p.notes && (
                                    <span>
                                      <strong>Notas:</strong> {p.notes}
                                    </span>
                                  )}
                                </div>
                                <div className="row-inline">
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => edit(p)}
                                  >
                                    Editar
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-danger btn-sm"
                                    onClick={() => requestRemove(p)}
                                  >
                                    Eliminar
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {totalPages > 1 && (
                      <div className="pagination">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={currentPage <= 1}
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                        >
                          ← Anterior
                        </button>
                        <span className="muted">
                          Página {currentPage} de {totalPages}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={currentPage >= totalPages}
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        >
                          Siguiente →
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {preview && pendingFile && (
        <div className="modal-backdrop" onClick={closeAssistant}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Asistente de importación</h2>
            <p className="muted" style={{ margin: 0 }}>
              {preview.filename} · {preview.totalDataRows} filas de datos detectadas
            </p>

            <p style={{ margin: "1rem 0 0.35rem", fontSize: "0.85rem", fontWeight: 600 }}>
              Orden de columnas en el archivo:
            </p>
            <div className="header-order">{preview.headerOrder}</div>

            <p style={{ margin: "1.1rem 0 0", fontWeight: 600 }}>Seleccionar ajuste de columna:</p>
            <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              El nombre del encabezado no importa: elige qué columna del documento va en cada campo.
            </p>

            <div className="map-grid">
              {MAP_FIELDS.map((field) => (
                <div className="map-field" key={field.key}>
                  <label>
                    {field.label}
                    {field.required ? " *" : ""}
                  </label>
                  <select
                    value={mapping[field.key] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMapping((m) => ({
                        ...m,
                        [field.key]: v === "" ? undefined : Number(v),
                      }));
                    }}
                  >
                    <option value="">Ninguno</option>
                    {preview.columns.map((col) => (
                      <option key={col.index} value={col.index}>
                        {col.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <label className="check-row">
              <input
                type="checkbox"
                checked={skipFirstRow}
                onChange={(e) => setSkipFirstRow(e.target.checked)}
              />
              Saltar primera fila (encabezados)
            </label>

            {mappedPreview.length > 0 && (
              <>
                <p style={{ margin: "1rem 0 0.4rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Vista previa con el mapeo actual:
                </p>
                <div className="preview-mini">
                  <table>
                    <thead>
                      <tr>
                        <th>Nº</th>
                        <th>Nombre</th>
                        <th>Clase</th>
                        <th>Liga</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappedPreview.map((r, i) => (
                        <tr key={i}>
                          <td>{r.number || "—"}</td>
                          <td>{r.name || "—"}</td>
                          <td>{r.category || "—"}</td>
                          <td>{r.league || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeAssistant} disabled={importing}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmImport} disabled={importing}>
                {importing ? "Importando…" : "Importar pilotos"}
              </button>
            </div>
          </div>
        </div>
      )}

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
