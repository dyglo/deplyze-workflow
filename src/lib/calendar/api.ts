import type { CountryCode } from './flags';

export type CalendarCategory = 'economic' | 'earnings' | 'dividends' | 'ipo';
export type EventImpact = 'low' | 'medium' | 'high';
export type EventSource = 'showmytrades' | 'fred' | 'fed';

export interface DayCounts {
  economic: number;
  earnings: number;
  dividends: number;
  ipo: number;
}

export interface EconomicEvent {
  id: string;
  date: string; // YYYY-MM-DD in active timezone
  time: string; // HH:MM in active timezone
  ts: number;
  isoTime: string;
  title: string;
  country: CountryCode;
  impact: EventImpact;
  flagged?: boolean;
  prior?: string;
  forecast?: string;
  actual?: string;
  source: EventSource;
}

export interface CalendarDay {
  iso: string;
  shortLabel: string;
  fullHeading: string;
  counts: DayCounts;
}

export interface CalendarWeekResponse {
  timezone: string;
  weekStart: string;
  sources: EventSource[];
  fallbackActive: boolean;
  days: { iso: string; counts: DayCounts }[];
  eventsByDate: Record<string, EconomicEvent[]>;
}

const DEFAULT_API_BASE = 'https://deplyze-workflow-api.onrender.com';
const WEEK_CACHE_TTL_MS = 5 * 60 * 1000;
const LOCAL_ARCHIVE_KEY = 'deplyze.calendar.archive.v1';
const LOCAL_ARCHIVE_MAX_DAYS = 90;

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const FULL_DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const;
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const;
const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const;

const IMPACT_RANK: Record<EventImpact, number> = { high: 0, medium: 1, low: 2 };

interface WeekCacheEntry {
  data: CalendarWeekResponse;
  fetchedAt: number;
}

const weekCache = new Map<string, WeekCacheEntry>();

function getApiBaseUrl(): string {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configured = metaEnv?.VITE_API_BASE_URL?.trim();
  const base = configured && configured.length > 0 ? configured : DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

export function getLocalTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'Africa/Nairobi';
  } catch {
    return 'Africa/Nairobi';
  }
}

export function getTodayIso(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    let y = '2026';
    let m = '01';
    let d = '01';
    for (const p of parts) {
      if (p.type === 'year') y = p.value;
      else if (p.type === 'month') m = p.value;
      else if (p.type === 'day') d = p.value;
    }
    return `${y}-${m}-${d}`;
  } catch {
    const now = new Date();
    return formatIsoDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  }
}

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, delta: number): string {
  const dt = parseIsoDate(iso);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return formatIsoDate(dt);
}

/** Returns the Monday (ISO) of the week containing `iso`. */
export function getWeekStart(iso: string): string {
  const dt = parseIsoDate(iso);
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + offset);
  return formatIsoDate(dt);
}

export function formatWeekRange(weekStartIso: string): string {
  const start = parseIsoDate(weekStartIso);
  const end = parseIsoDate(addDays(weekStartIso, 6));
  const startMonth = SHORT_MONTHS[start.getUTCMonth()];
  const endMonth = SHORT_MONTHS[end.getUTCMonth()];
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();

  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${startMonth} ${startDay} — ${endDay}`;
  }
  return `${startMonth} ${startDay} — ${endMonth} ${endDay}`;
}

export function buildWeekDays(
  weekStartIso: string,
  countsByDate: Record<string, DayCounts>
): CalendarDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(weekStartIso, i);
    const dt = parseIsoDate(iso);
    const dow = dt.getUTCDay();
    const dayNum = dt.getUTCDate();
    const monthName = FULL_MONTHS[dt.getUTCMonth()];
    return {
      iso,
      shortLabel: `${SHORT_DAYS[dow]} ${dayNum}`,
      fullHeading: `${FULL_DAYS[dow]}, ${monthName} ${dayNum}`,
      counts: countsByDate[iso] ?? { economic: 0, earnings: 0, dividends: 0, ipo: 0 }
    };
  });
}

// --- Client-side rolling archive of backend responses (preserves past 9-currency days across Render restarts) ---

interface LocalArchiveStore {
  version: 1;
  days: Record<string, EconomicEvent[]>; // keyed by `${tz}|${YYYY-MM-DD}`
}

function readLocalArchive(): LocalArchiveStore {
  try {
    const raw = localStorage.getItem(LOCAL_ARCHIVE_KEY);
    if (!raw) return { version: 1, days: {} };
    const parsed = JSON.parse(raw) as LocalArchiveStore;
    if (parsed && parsed.version === 1 && parsed.days && typeof parsed.days === 'object') {
      return parsed;
    }
  } catch {
    // Ignore storage read errors
  }
  return { version: 1, days: {} };
}

function writeLocalArchive(store: LocalArchiveStore): void {
  try {
    localStorage.setItem(LOCAL_ARCHIVE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota errors
  }
}

function persistWeekToLocalArchive(tz: string, eventsByDate: Record<string, EconomicEvent[]>): void {
  const store = readLocalArchive();
  const todayIso = getTodayIso(tz);
  const cutoffIso = addDays(todayIso, -LOCAL_ARCHIVE_MAX_DAYS);
  let dirty = false;

  for (const [dateIso, events] of Object.entries(eventsByDate)) {
    const smtEvents = events.filter((e) => e.source === 'showmytrades');
    if (smtEvents.length === 0) continue;

    const key = `${tz}|${dateIso}`;
    const existing = store.days[key] ?? [];
    const byId = new Map<string, EconomicEvent>();
    for (const ev of existing) byId.set(ev.id, ev);
    for (const ev of smtEvents) {
      const prev = byId.get(ev.id);
      byId.set(ev.id, {
        ...ev,
        prior: ev.prior ?? prev?.prior,
        forecast: ev.forecast ?? prev?.forecast,
        actual: ev.actual ?? prev?.actual
      });
    }
    store.days[key] = Array.from(byId.values());
    dirty = true;
  }

  for (const key of Object.keys(store.days)) {
    const sep = key.lastIndexOf('|');
    const dateIso = sep >= 0 ? key.slice(sep + 1) : '';
    if (dateIso && dateIso < cutoffIso) {
      delete store.days[key];
      dirty = true;
    }
  }

  if (dirty) {
    writeLocalArchive(store);
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameEvent(a: EconomicEvent, b: EconomicEvent): boolean {
  if (a.id === b.id) return true;
  if (a.country !== b.country) return false;
  if (Math.abs(a.ts - b.ts) > 1800) return false;
  const na = normalizeTitle(a.title);
  const nb = normalizeTitle(b.title);
  return na === nb || na.includes(nb) || nb.includes(na);
}

function mergeLocalArchiveForPastDays(
  payload: CalendarWeekResponse,
  tz: string
): CalendarWeekResponse {
  const store = readLocalArchive();
  const todayIso = getTodayIso(tz);
  const mergedEventsByDate: Record<string, EconomicEvent[]> = {};
  const mergedDays: { iso: string; counts: DayCounts }[] = [];

  for (const day of payload.days) {
    const backendEvents = payload.eventsByDate[day.iso] ?? [];
    const key = `${tz}|${day.iso}`;
    const archivedSmt = store.days[key] ?? [];

    // Only merge archived SMT events when the backend didn't already serve SMT for this day (e.g. past day after Render restart)
    const backendHasSmt = backendEvents.some((e) => e.source === 'showmytrades');
    let combined = backendEvents.slice();

    if (!backendHasSmt && archivedSmt.length > 0 && day.iso <= todayIso) {
      const merged: EconomicEvent[] = archivedSmt.map((e) => ({ ...e }));
      for (const bEv of backendEvents) {
        const match = merged.find((aEv) => sameEvent(aEv, bEv));
        if (match) {
          if (!match.actual && bEv.actual) match.actual = bEv.actual;
          if (!match.prior && bEv.prior) match.prior = bEv.prior;
        } else {
          merged.push(bEv);
        }
      }
      merged.sort(
        (a, b) =>
          a.ts - b.ts ||
          IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
          a.title.localeCompare(b.title)
      );
      combined = merged;
    }

    mergedEventsByDate[day.iso] = combined;
    mergedDays.push({
      iso: day.iso,
      counts: {
        ...day.counts,
        economic: combined.length
      }
    });
  }

  return {
    ...payload,
    days: mergedDays,
    eventsByDate: mergedEventsByDate
  };
}

export async function fetchCalendarWeek(
  weekStartIso: string,
  tz: string,
  options?: { force?: boolean; signal?: AbortSignal }
): Promise<CalendarWeekResponse> {
  const cacheKey = `${tz}|${weekStartIso}`;
  const cached = weekCache.get(cacheKey);
  if (!options?.force && cached && Date.now() - cached.fetchedAt < WEEK_CACHE_TTL_MS) {
    return cached.data;
  }

  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}/api/calendar/week?start=${encodeURIComponent(weekStartIso)}&tz=${encodeURIComponent(tz)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options?.signal
  });

  if (!res.ok) {
    throw new Error(`Calendar API returned HTTP ${res.status}`);
  }

  const raw = (await res.json()) as CalendarWeekResponse;
  persistWeekToLocalArchive(tz, raw.eventsByDate ?? {});
  const merged = mergeLocalArchiveForPastDays(raw, tz);

  weekCache.set(cacheKey, { data: merged, fetchedAt: Date.now() });
  return merged;
}
