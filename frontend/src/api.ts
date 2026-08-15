import type { Event, FusionRow, Pilot, ResultRow, ResultsBoardEntry, SavedFusion } from "./types";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Base de la API (`/api` en local; URL absoluta en producción). */
export const API_BASE = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL || "/api"
);

/** Base de uploads (`/uploads` en local; URL absoluta en producción). */
export const UPLOADS_BASE = trimTrailingSlash(
  import.meta.env.VITE_UPLOADS_BASE_URL || "/uploads"
);

/**
 * Origen del backend para enlaces absolutos (feeds, etc.).
 * En local suele ser http://localhost:4000; en nube, la URL del servicio API.
 */
export const BACKEND_ORIGIN = trimTrailingSlash(
  import.meta.env.VITE_BACKEND_ORIGIN ||
    (API_BASE.startsWith("http")
      ? (() => {
          try {
            return new URL(API_BASE).origin;
          } catch {
            return "";
          }
        })()
      : typeof window !== "undefined"
        ? window.location.origin
        : "")
);

const BASE = API_BASE;

/** Absolute API URL for links shown to the user (feeds, exports opened in a new tab). */
export function absoluteApiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (API_BASE.startsWith("http")) return `${API_BASE}${p}`;
  const origin =
    BACKEND_ORIGIN ||
    (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}${API_BASE}${p}`;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Error de red");
  }
  return res.json();
}

export const api = {
  listEvents: () => request<Event[]>("/events"),
  getEvent: (id: string) => request<Event>(`/events/${id}`),
  createEvent: (data: Partial<Event>) =>
    request<Event>("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updateEvent: (id: string, data: Partial<Event>) =>
    request<Event>(`/events/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deleteEvent: (id: string) => request<{ ok: boolean }>(`/events/${id}`, { method: "DELETE" }),

  unlockEvent: (id: string, password: string) =>
    request<{ ok: boolean }>(`/events/${id}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),

  updateTimingPoints: (id: string, timingPoints: unknown[]) =>
    request<Event>(`/events/${id}/timing-points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timingPoints }),
    }),

  uploadHeader: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append("image", file);
    return request<Event>(`/events/${id}/header`, { method: "POST", body: fd });
  },

  createTest: (eventId: string, name: string) =>
    request(`/events/${eventId}/tests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "", showDescriptionInPdf: false }),
    }),
  updateTest: (
    eventId: string,
    testId: string,
    data: {
      name?: string;
      description?: string;
      showDescriptionInPdf?: boolean;
      fromPointId?: string | null;
      toPointId?: string | null;
      timingMode?: "point_to_point" | "start_finish_partial";
      startFinishPointId?: string | null;
      partialPointIds?: string[];
    }
  ) =>
    request(`/events/${eventId}/tests/${testId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deleteTest: (eventId: string, testId: string) =>
    request(`/events/${eventId}/tests/${testId}`, { method: "DELETE" }),

  createPart: (
    eventId: string,
    testId: string,
    data: {
      name?: string;
      combinedMode?: boolean;
      csvInputMode?: "points" | "combined" | "pilots";
      combinedScoring?: "time" | "laps";
      expectedLaps?: number | null;
    }
  ) =>
    request(`/events/${eventId}/tests/${testId}/parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updatePart: (
    eventId: string,
    testId: string,
    partId: string,
    data: {
      name?: string;
      combinedMode?: boolean;
      csvInputMode?: "points" | "combined" | "pilots";
      combinedScoring?: "time" | "laps";
      expectedLaps?: number | null;
      startOrderVs?: { a: string; b: string }[];
    }
  ) =>
    request(`/events/${eventId}/tests/${testId}/parts/${partId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  getOrdenSalida: (eventId: string) =>
    request<{
      event: {
        id: string;
        name: string;
        overlayVariant?: "classic" | "redbull" | "ponymalta";
        boardPageSeconds?: number;
        publishedStartOrder?: { testId: string; partId: string } | null;
      };
      pilots: { number: string; name: string }[];
      tests: {
        id: string;
        name: string;
        parts: {
          id: string;
          name: string;
          order: number;
          startOrderVs: { a: string; b: string }[];
        }[];
      }[];
    }>(`/events/${eventId}/orden-salida`),

  publishOrdenSalida: (eventId: string, testId: string, partId: string) =>
    request<{ publishedStartOrder: { testId: string; partId: string } }>(
      `/events/${eventId}/orden-salida/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId, partId }),
      }
    ),

  unpublishOrdenSalida: (eventId: string) =>
    request<{ publishedStartOrder: null }>(`/events/${eventId}/orden-salida/publish`, {
      method: "DELETE",
    }),
  deletePart: (eventId: string, testId: string, partId: string) =>
    request(`/events/${eventId}/tests/${testId}/parts/${partId}`, { method: "DELETE" }),

  uploadCsv: async (
    eventId: string,
    testId: string,
    partId: string,
    file: File,
    timingPointId: string,
    opts?: { combinedMode?: boolean; pilotNumber?: string }
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("timingPointId", timingPointId);
    if (opts?.combinedMode) fd.append("combinedMode", "true");
    if (opts?.pilotNumber) fd.append("pilotNumber", opts.pilotNumber);
    return request<{
      slot: {
        timingPointId: string;
        filename: string;
        pilotNumber?: string;
        parsed: unknown;
      };
      partMeta: {
        id: string;
        name: string;
        order: number;
        combinedMode: boolean;
        csvInputMode?: "points" | "combined" | "pilots";
        combinedScoring?: "time" | "laps";
        expectedLaps: number | null;
      };
      summary: unknown;
    }>(`/events/${eventId}/tests/${testId}/parts/${partId}/csv`, {
      method: "POST",
      body: fd,
    });
  },

  getResults: (eventId: string, testId: string, params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) q.set(k, v);
    });
    return request<{
      title: string;
      rows: ResultRow[];
      warning?: string | null;
      diffNote?: string | null;
      scope: string;
      eventName: string;
    }>(`/events/${eventId}/tests/${testId}/results?${q}`);
  },

  getLapByLap: (eventId: string, testId: string, params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) q.set(k, v);
    });
    return request<{
      title: string;
      maxLaps: number;
      warning?: string | null;
      eventName: string;
      event: { id: string; name: string; boardPageSeconds?: number };
      rows: {
        position: number;
        number: string;
        name: string;
        lapTimesFormatted: string[];
        lapsCompleted: number;
        totalTimeFormatted: string;
      }[];
    }>(`/events/${eventId}/tests/${testId}/laps?${q}`);
  },

  getFusion: (eventId: string, testIds: string[]) => {
    const q = new URLSearchParams();
    q.set("tests", testIds.join(","));
    return request<{
      title: string;
      tests: { id: string; name: string; segmentLabel: string }[];
      rows: FusionRow[];
      warning?: string | null;
      eventName: string;
    }>(`/events/${eventId}/fusion?${q}`);
  },

  saveFusion: (eventId: string, name: string, testIds: string[]) =>
    request<SavedFusion>(`/events/${eventId}/fusions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, testIds }),
    }),

  deleteFusion: (eventId: string, fusionId: string) =>
    request<{ ok: boolean }>(`/events/${eventId}/fusions/${fusionId}`, { method: "DELETE" }),

  fusionExportUrl: (eventId: string, fusionId: string, format: string) =>
    `${BASE}/events/${eventId}/fusions/${fusionId}/export/${format}`,

  fusionLiveExportUrl: (
    eventId: string,
    format: string,
    testIds: string[],
    name?: string
  ) => {
    const q = new URLSearchParams();
    q.set("tests", testIds.join(","));
    if (name) q.set("name", name);
    return `${BASE}/events/${eventId}/fusion/export/${format}?${q}`;
  },

  getBoard: (eventId: string) =>
    request<{
      event: {
        id: string;
        themeColors: string[] | null;
        name: string;
        date: string;
        location: string;
        headerImage: string | null;
        footerText: string;
        boardPageSeconds?: number;
        overlayVariant?: "classic" | "redbull" | "ponymalta";
        overlayTiming?: "splits" | "total";
        csvSource?: "auto" | "orbits4" | "orbits5";
      };
      board: ResultsBoardEntry[];
      sections: {
        entry: ResultsBoardEntry;
        kind: "unified" | "fusion";
        title: string;
        rows: ResultRow[] | FusionRow[];
        warning: string | null;
        tests: { id: string; name: string; segmentLabel: string }[] | null;
        lapScoring?: boolean;
      }[];
    }>(`/events/${eventId}/board`),

  publishToBoard: (
    eventId: string,
    data: { kind: "unified" | "fusion"; refId: string; title?: string; partId?: string | null }
  ) =>
    request<ResultsBoardEntry>(`/events/${eventId}/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  unpublishFromBoard: (eventId: string, entryId: string) =>
    request<{ ok: boolean; resultsBoard: ResultsBoardEntry[] }>(
      `/events/${eventId}/board/${entryId}`,
      { method: "DELETE" }
    ),

  savePenalty: (
    eventId: string,
    testId: string,
    data: {
      number: string;
      scope: string;
      timePenalty?: string;
      timePenaltyMs?: number;
      positionPenalty?: number;
      comment?: string;
    }
  ) =>
    request<{ ok: boolean }>(`/events/${eventId}/tests/${testId}/penalties`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  exportUrl: (eventId: string, testId: string, format: string, params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) q.set(k, v);
    });
    return `${BASE}/events/${eventId}/tests/${testId}/export/${format}?${q}`;
  },

  listPilots: (eventId: string) => request<Pilot[]>(`/events/${eventId}/pilots`),
  previewPilotsImport: async (eventId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{
      filename: string;
      columns: { index: number; label: string; header: string }[];
      headerOrder: string;
      sampleRows: string[][];
      suggestedMapping: Record<string, number>;
      totalDataRows: number;
    }>(`/events/${eventId}/pilots/import/preview`, { method: "POST", body: fd });
  },
  importPilots: async (
    eventId: string,
    file: File,
    mapping: Record<string, number | undefined>,
    skipFirstRow = true
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mapping", JSON.stringify(mapping));
    fd.append("skipFirstRow", String(skipFirstRow));
    return request<{
      pilots: Pilot[];
      summary: { total: number; added: number; updated: number; skipped: number; filename: string };
    }>(`/events/${eventId}/pilots/import`, { method: "POST", body: fd });
  },
  createPilot: (eventId: string, data: Partial<Pilot>) =>
    request<Pilot>(`/events/${eventId}/pilots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updatePilot: (eventId: string, pilotId: string, data: Partial<Pilot>) =>
    request<Pilot>(`/events/${eventId}/pilots/${pilotId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deletePilot: (eventId: string, pilotId: string) =>
    request(`/events/${eventId}/pilots/${pilotId}`, { method: "DELETE" }),
};

export function formatOffsetInput(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(Math.round(ms));
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const milli = abs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(milli, 3)}`;
}

/** Parse m:ss.xxx / hh:mm:ss.xxx (same rules as backend offsets) */
export function parseOffsetToMs(raw: string): number {
  if (!raw || !raw.trim()) return 0;
  let s = raw.trim().replace(",", ".");
  const colonParts = s.split(":");
  if (colonParts.length === 4) {
    s = `${colonParts[0]}:${colonParts[1]}:${colonParts[2]}.${colonParts[3]}`;
  }
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  const parts = s.split(":");
  let ms: number | null = null;
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const sec = Number(parts[2]);
    if (![h, m, sec].some((x) => Number.isNaN(x))) {
      ms = Math.round(h * 3600000 + m * 60000 + sec * 1000);
    }
  } else if (parts.length === 2) {
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (![m, sec].some((x) => Number.isNaN(x))) {
      ms = Math.round(m * 60000 + sec * 1000);
    }
  } else {
    const sec = Number(s);
    if (!Number.isNaN(sec)) ms = Math.round(sec * 1000);
  }
  if (ms === null) return 0;
  return negative ? -ms : ms;
}

/** Format penalty for the results inputs (omit leading 00: hours when possible) */
export function formatPenaltyInput(ms: number): string {
  if (!ms) return "";
  return formatOffsetInput(ms).replace(/^00:/, "");
}
