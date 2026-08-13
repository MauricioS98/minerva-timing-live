import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Event, PartCsvSlot, Pilot, StartOrderVsPair } from "./types.js";
import { getPartUploadContext, loadAllEvents, loadEvent } from "./eventsRepo.js";
import {
  persistEvent,
  removeEvent,
  replacePartCsvs,
  updatePartCsvMeta,
  updatePartStartOrderVs,
  updatePublishedStartOrder,
  upsertPartCsvSlot,
} from "./eventsWrite.js";

export { getPartUploadContext };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_ROOT = path.resolve(__dirname, "../../data");
export const EVENTS_DIR = path.join(DATA_ROOT, "events");
export const HEADERS_DIR = path.join(DATA_ROOT, "uploads", "headers");

/** Default password for events created before passwords existed */
export const DEFAULT_EVENT_PASSWORD = "00000";

const eventCache = new Map<string, { event: Event; at: number }>();
const CACHE_TTL_MS = 3000;

function ensureDirs() {
  for (const dir of [EVENTS_DIR, HEADERS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirs();

function invalidateEventCache(id?: string) {
  if (id) eventCache.delete(id);
  else eventCache.clear();
}

/** Strip secrets before sending event data to the client */
export function publicEvent(event: Event): Omit<Event, "password"> & { hasPassword: boolean } {
  const { password: _pw, ...rest } = event;
  return { ...rest, hasPassword: Boolean(event.password) };
}

function normalizeLoaded(event: Event): Event {
  event.pilots = event.pilots || [];
  event.fusions = event.fusions || [];
  event.resultsBoard = event.resultsBoard || [];
  if (
    event.boardPageSeconds == null ||
    !Number.isFinite(Number(event.boardPageSeconds))
  ) {
    event.boardPageSeconds = 10;
  } else {
    event.boardPageSeconds = Math.min(
      120,
      Math.max(3, Math.round(Number(event.boardPageSeconds)))
    );
  }
  event.overlayVariant =
    event.overlayVariant === "redbull" || event.overlayVariant === "ponymalta"
      ? event.overlayVariant
      : "classic";
  event.overlayTiming =
    event.overlayTiming === "total" ? "total" : "splits";
  event.csvSource =
    event.csvSource === "orbits4" || event.csvSource === "orbits5"
      ? event.csvSource
      : "auto";
  event.publishedStartOrder =
    event.publishedStartOrder?.testId && event.publishedStartOrder?.partId
      ? {
          testId: event.publishedStartOrder.testId,
          partId: event.publishedStartOrder.partId,
        }
      : null;
  event.tests = (event.tests || []).map((t) => ({
    ...t,
    description: t.description ?? "",
    showDescriptionInPdf: Boolean(t.showDescriptionInPdf),
    penalties: t.penalties || [],
    parts: (t.parts || []).map((p) => ({
      ...p,
      combinedScoring: p.combinedScoring ?? (p.combinedMode ? "time" : undefined),
      expectedLaps: p.expectedLaps ?? null,
      startOrderVs: Array.isArray(p.startOrderVs) ? p.startOrderVs : [],
    })),
    fromPointId: t.fromPointId ?? null,
    toPointId: t.toPointId ?? null,
    timingMode: t.timingMode === "start_finish_partial" ? "start_finish_partial" : "point_to_point",
    startFinishPointId: t.startFinishPointId ?? t.fromPointId ?? null,
    partialPointIds: Array.isArray(t.partialPointIds)
      ? t.partialPointIds
      : t.toPointId
        ? [t.toPointId]
        : [],
  }));
  if (!event.password || String(event.password).trim() === "") {
    event.password = DEFAULT_EVENT_PASSWORD;
  }
  return event;
}

export async function listEvents(): Promise<Event[]> {
  const events = await loadAllEvents();
  return events.map((e) => {
    const n = normalizeLoaded(e);
    eventCache.set(n.id, { event: structuredClone(n), at: Date.now() });
    return n;
  });
}

export async function getEvent(id: string): Promise<Event | null> {
  const hit = eventCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return structuredClone(hit.event);
  }
  const event = await loadEvent(id);
  if (!event) return null;
  const n = normalizeLoaded(event);
  eventCache.set(id, { event: structuredClone(n), at: Date.now() });
  return n;
}

export async function saveEvent(event: Event): Promise<Event> {
  ensureDirs();
  if (!event.pilots) event.pilots = [];
  if (!event.password || String(event.password).trim() === "") {
    event.password = DEFAULT_EVENT_PASSWORD;
  }
  event.updatedAt = new Date().toISOString();
  if (!event.createdAt) event.createdAt = event.updatedAt;
  await persistEvent(event);
  invalidateEventCache(event.id);
  eventCache.set(event.id, { event: structuredClone(event), at: Date.now() });
  return event;
}

/** Persist CSV slots for a part after upload (does not rewrite the whole event). */
export async function savePartCsvs(partId: string, csvs: PartCsvSlot[]): Promise<void> {
  await replacePartCsvs(partId, csvs);
  invalidateEventCache();
}

/** Patch cached event with one CSV slot instead of forcing a full DB reload. */
function patchEventCacheCsvSlot(
  eventId: string,
  partId: string,
  slot: PartCsvSlot,
  partMeta?: {
    combinedMode?: boolean;
    combinedScoring?: string | null;
    expectedLaps?: number | null;
  }
): void {
  const hit = eventCache.get(eventId);
  if (!hit) return;
  for (const test of hit.event.tests || []) {
    const part = (test.parts || []).find((p) => p.id === partId);
    if (!part) continue;
    const idx = part.csvs.findIndex((c) => c.timingPointId === slot.timingPointId);
    if (idx >= 0) part.csvs[idx] = slot;
    else part.csvs.push(slot);
    if (partMeta) {
      if (partMeta.combinedMode !== undefined) part.combinedMode = Boolean(partMeta.combinedMode);
      if (partMeta.combinedScoring !== undefined) {
        part.combinedScoring =
          partMeta.combinedScoring === "laps" || partMeta.combinedScoring === "time"
            ? partMeta.combinedScoring
            : part.combinedScoring;
      }
      if (partMeta.expectedLaps !== undefined) part.expectedLaps = partMeta.expectedLaps;
    }
    hit.event.updatedAt = new Date().toISOString();
    hit.at = Date.now();
    return;
  }
}

/** Persist a single CSV slot (fast path for uploads on Render). */
export async function savePartCsvSlot(
  eventId: string,
  partId: string,
  slot: PartCsvSlot,
  partMeta?: {
    combinedMode?: boolean;
    combinedScoring?: string | null;
    expectedLaps?: number | null;
  }
): Promise<void> {
  if (partMeta) {
    await updatePartCsvMeta(partId, partMeta);
  }
  await upsertPartCsvSlot(partId, slot);
  // Prefer in-place cache patch — invalidating forces a multi-MB reload of all CSVs.
  if (eventCache.has(eventId)) {
    patchEventCacheCsvSlot(eventId, partId, slot, partMeta);
  }
}

/** Persist VS start-order for a salida (fast path). */
export async function savePartStartOrderVs(
  eventId: string,
  partId: string,
  pairs: StartOrderVsPair[]
): Promise<void> {
  await updatePartStartOrderVs(partId, pairs);
  const hit = eventCache.get(eventId);
  if (hit) {
    for (const test of hit.event.tests || []) {
      const part = (test.parts || []).find((p) => p.id === partId);
      if (part) {
        part.startOrderVs = pairs;
        hit.event.updatedAt = new Date().toISOString();
        hit.at = Date.now();
        break;
      }
    }
  } else {
    invalidateEventCache(eventId);
  }
}

/** Publish / clear the single active Orden de salida for the overlay. */
export async function savePublishedStartOrder(
  eventId: string,
  published: { testId: string; partId: string } | null
): Promise<void> {
  await updatePublishedStartOrder(eventId, published);
  const hit = eventCache.get(eventId);
  if (hit) {
    hit.event.publishedStartOrder = published;
    hit.event.updatedAt = new Date().toISOString();
    hit.at = Date.now();
  } else {
    invalidateEventCache(eventId);
  }
}

export async function deleteEvent(id: string): Promise<boolean> {
  const ok = await removeEvent(id);
  invalidateEventCache(id);
  if (!ok) return false;
  const header = path.join(HEADERS_DIR, `${id}`);
  for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
    const p = header + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return true;
}

export function findPilotByNumber(pilots: Pilot[], number: string): Pilot | undefined {
  const normalized = normalizeNumber(number);
  return pilots.find((p) => normalizeNumber(p.number) === normalized);
}

export function normalizeNumber(n: string): string {
  return n.replace(/^#/, "").trim().toUpperCase();
}

export function verifyEventPassword(event: Event, password: string): boolean {
  return String(password) === String(event.password ?? DEFAULT_EVENT_PASSWORD);
}
