import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawEconomicEvent } from './types.js';

const MAX_ARCHIVE_DAYS = 90;

interface ArchiveDiskFormat {
  version: 1;
  updatedAt: string;
  days: Record<string, RawEconomicEvent[]>; // keyed by UTC date YYYY-MM-DD
}

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARCHIVE_PATH =
  process.env.CALENDAR_ARCHIVE_PATH ||
  path.join(SERVER_ROOT, 'data', 'calendar-archive.json');

const memoryArchive = new Map<string, RawEconomicEvent[]>();
let loadedFromDisk = false;
let writeQueue: Promise<void> = Promise.resolve();

function utcDayKey(ts: number): string {
  const dt = new Date(ts * 1000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function cutoffDayKey(nowMs: number): string {
  const dt = new Date(nowMs - MAX_ARCHIVE_DAYS * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export async function ensureArchiveLoaded(): Promise<void> {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const raw = await readFile(ARCHIVE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ArchiveDiskFormat;
    if (parsed && parsed.days && typeof parsed.days === 'object') {
      const cutoff = cutoffDayKey(Date.now());
      for (const [dayKey, events] of Object.entries(parsed.days)) {
        if (dayKey >= cutoff && Array.isArray(events)) {
          memoryArchive.set(dayKey, events);
        }
      }
    }
  } catch {
    // Missing or unreadable archive on fresh start / ephemeral disk is expected
  }
}

/**
 * Merges freshly fetched ShowMyTrades events into the rolling UTC-day archive
 * (preserving earlier events on the same day that rolled past ShowMyTrades' -6h cutoff)
 * and persists atomically to disk when writable.
 */
export async function recordShowMyTradesEvents(events: RawEconomicEvent[]): Promise<void> {
  await ensureArchiveLoaded();
  if (events.length === 0) return;

  const grouped = new Map<string, RawEconomicEvent[]>();
  for (const ev of events) {
    const key = utcDayKey(ev.ts);
    const list = grouped.get(key);
    if (list) list.push(ev);
    else grouped.set(key, [ev]);
  }

  let dirty = false;
  for (const [dayKey, incoming] of grouped) {
    const existing = memoryArchive.get(dayKey) ?? [];
    const byId = new Map<string, RawEconomicEvent>();
    for (const ev of existing) byId.set(ev.id, ev);
    for (const ev of incoming) {
      const prev = byId.get(ev.id);
      // Preserve forecast/prior if a later snapshot dropped them; always take latest actual
      if (prev) {
        byId.set(ev.id, {
          ...ev,
          prior: ev.prior ?? prev.prior,
          forecast: ev.forecast ?? prev.forecast,
          actual: ev.actual ?? prev.actual
        });
      } else {
        byId.set(ev.id, ev);
      }
    }
    const merged = Array.from(byId.values()).sort((a, b) => a.ts - b.ts || a.title.localeCompare(b.title));
    memoryArchive.set(dayKey, merged);
    dirty = true;
  }

  // Prune days older than MAX_ARCHIVE_DAYS
  const cutoff = cutoffDayKey(Date.now());
  for (const dayKey of memoryArchive.keys()) {
    if (dayKey < cutoff) {
      memoryArchive.delete(dayKey);
      dirty = true;
    }
  }

  if (dirty) {
    schedulePersist();
  }
}

export function getArchivedEventsForUtcDays(utcDays: string[]): RawEconomicEvent[] {
  const out: RawEconomicEvent[] = [];
  for (const dayKey of utcDays) {
    const list = memoryArchive.get(dayKey);
    if (list) out.push(...list);
  }
  return out;
}

function schedulePersist(): void {
  writeQueue = writeQueue
    .then(async () => {
      const days: Record<string, RawEconomicEvent[]> = {};
      for (const [k, v] of memoryArchive.entries()) {
        days[k] = v;
      }
      const payload: ArchiveDiskFormat = {
        version: 1,
        updatedAt: new Date().toISOString(),
        days
      };
      const dir = path.dirname(ARCHIVE_PATH);
      await mkdir(dir, { recursive: true });
      const tmpPath = `${ARCHIVE_PATH}.tmp`;
      await writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
      await rename(tmpPath, ARCHIVE_PATH);
    })
    .catch((err) => {
      console.warn('[calendar:archive] disk persist skipped:', (err as Error).message);
    });
}
