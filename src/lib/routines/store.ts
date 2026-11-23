import { loadWorkspaceJson, makeWorkspaceId, saveWorkspaceJson } from '../workspace/storage';

export type RitualGroupId = 'pre' | 'session' | 'post';

export interface RitualItem {
  id: string;
  group: RitualGroupId;
  label: string;
  done: boolean;
}

export interface RoutineDayRecord {
  done: number;
  total: number;
}

export interface RoutinesState {
  activeDate: string; // YYYY-MM-DD in user's local timezone
  items: RitualItem[];
  history: Record<string, RoutineDayRecord>;
}

export type SessionId = 'tokyo' | 'london' | 'newyork';

export interface TimelineSegment {
  startPct: number; // 0..100
  widthPct: number; // 0..100
}

export interface SessionDisplay {
  id: SessionId;
  name: string;
  cityLabel: string;
  color: string;
  localRangeLabel: string; // e.g. "10:00–18:30"
  active: boolean;
  segments: TimelineSegment[];
}

export interface SessionsSnapshot {
  timeZone: string;
  localTimeLabel: string;
  localDateLabel: string;
  nowPct: number; // 0..100 across 24h local day
  isWeekendClosed: boolean;
  sessions: SessionDisplay[];
  overlapActive: boolean;
  overlapRangeLabel: string | null;
  overlapSegments: TimelineSegment[];
  activeNames: string[];
  nextEventLabel: string; // e.g. "London opens in 1h 42m" or "NY closes in 3h 10m"
}

export interface WeekDayConsistency {
  label: string;
  date: string;
  done: number;
  total: number;
  isToday: boolean;
  isFuture: boolean;
  status: 'full' | 'partial' | 'empty';
}

export const RITUAL_GROUPS: { id: RitualGroupId; title: string }[] = [
  { id: 'pre', title: 'Pre-Market' },
  { id: 'session', title: 'During Session' },
  { id: 'post', title: 'Post-Market' }
];

const STORAGE_KEY = 'routines';

interface SessionDef {
  id: SessionId;
  name: string;
  cityLabel: string;
  timeZone: string;
  color: string;
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

const SESSION_DEFS: SessionDef[] = [
  {
    id: 'tokyo',
    name: 'Tokyo',
    cityLabel: 'Asia/Tokyo',
    timeZone: 'Asia/Tokyo',
    color: '#9c7af2',
    startHour: 9,
    startMin: 0,
    endHour: 15,
    endMin: 0
  },
  {
    id: 'london',
    name: 'London',
    cityLabel: 'Europe/London',
    timeZone: 'Europe/London',
    color: '#2962ff',
    startHour: 8,
    startMin: 0,
    endHour: 16,
    endMin: 30
  },
  {
    id: 'newyork',
    name: 'New York',
    cityLabel: 'America/New_York',
    timeZone: 'America/New_York',
    color: '#089981',
    startHour: 8,
    startMin: 0,
    endHour: 17,
    endMin: 0
  }
];

export function getLocalTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.trim()) return tz;
  } catch {
    // fallback below
  }
  return 'Africa/Nairobi';
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun .. 6=Sat
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short'
    }).formatToParts(date);

    const getNum = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const wdStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const rawHour = getNum('hour');
    return {
      year: getNum('year'),
      month: getNum('month'),
      day: getNum('day'),
      hour: rawHour === 24 ? 0 : rawHour,
      minute: getNum('minute'),
      second: getNum('second'),
      weekday: WEEKDAY_MAP[wdStr] ?? 1
    };
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay()
    };
  }
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const rounded = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - rounded;
}

/** Converts a wall-clock date/time in `timeZone` into exact UTC epoch milliseconds (DST-accurate). */
function zonedWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = getTimeZoneOffsetMs(new Date(guess), timeZone);
  const t1 = guess - off1;
  const off2 = getTimeZoneOffsetMs(new Date(t1), timeZone);
  return guess - off2;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function getLocalDateIso(now = new Date(), timeZone = getLocalTimeZone()): string {
  const p = getZonedParts(now, timeZone);
  return formatIsoDate(p.year, p.month, p.day);
}

function addCalendarDays(year: number, month: number, day: number, delta: number): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
    weekday: dt.getUTCDay()
  };
}

function formatLocalHm(utcMs: number, localTz: string): string {
  const p = getZonedParts(new Date(utcMs), localTz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function minutesToSegments(startMin: number, endMin: number): TimelineSegment[] {
  const s = ((startMin % 1440) + 1440) % 1440;
  const e = ((endMin % 1440) + 1440) % 1440;
  if (endMin - startMin >= 1440) {
    return [{ startPct: 0, widthPct: 100 }];
  }
  if (e > s) {
    return [{ startPct: (s / 1440) * 100, widthPct: ((e - s) / 1440) * 100 }];
  }
  // Spans local midnight — split into two clean segments
  const out: TimelineSegment[] = [];
  if (s < 1440) {
    out.push({ startPct: (s / 1440) * 100, widthPct: ((1440 - s) / 1440) * 100 });
  }
  if (e > 0) {
    out.push({ startPct: 0, widthPct: (e / 1440) * 100 });
  }
  return out;
}

function formatDurationCompact(ms: number): string {
  const totalMins = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

interface SessionWindow {
  def: SessionDef;
  openMs: number;
  closeMs: number;
}

function getSessionWindowsAround(def: SessionDef, now: Date): SessionWindow[] {
  const p = getZonedParts(now, def.timeZone);
  const out: SessionWindow[] = [];
  for (let d = -1; d <= 4; d++) {
    const dayInfo = addCalendarDays(p.year, p.month, p.day, d);
    if (dayInfo.weekday === 0 || dayInfo.weekday === 6) continue;
    const openMs = zonedWallClockToUtcMs(
      dayInfo.year,
      dayInfo.month,
      dayInfo.day,
      def.startHour,
      def.startMin,
      def.timeZone
    );
    const closeMs = zonedWallClockToUtcMs(
      dayInfo.year,
      dayInfo.month,
      dayInfo.day,
      def.endHour,
      def.endMin,
      def.timeZone
    );
    out.push({ def, openMs, closeMs });
  }
  return out;
}

export function computeSessionsSnapshot(
  now = new Date(),
  localTz = getLocalTimeZone()
): SessionsSnapshot {
  const nowMs = now.getTime();
  const localParts = getZonedParts(now, localTz);
  const localNowMinutes = localParts.hour * 60 + localParts.minute + localParts.second / 60;
  const nowPct = Math.min(100, Math.max(0, (localNowMinutes / 1440) * 100));

  const localTimeLabel = `${pad2(localParts.hour)}:${pad2(localParts.minute)}`;
  let localDateLabel = '';
  try {
    localDateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: localTz,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(now);
  } catch {
    localDateLabel = getLocalDateIso(now, localTz);
  }

  // Build exact DST-adjusted windows for all 3 major sessions
  const allWindows: SessionWindow[] = [];
  const primaryWindows = new Map<SessionId, SessionWindow>();

  for (const def of SESSION_DEFS) {
    const wins = getSessionWindowsAround(def, now);
    for (const w of wins) allWindows.push(w);

    // Choose active window, else nearest upcoming window, else most recent window for timeline projection
    const activeWin = wins.find((w) => nowMs >= w.openMs && nowMs < w.closeMs);
    const upcomingWin = wins.find((w) => w.openMs > nowMs);
    const chosen = activeWin ?? upcomingWin ?? wins[0];
    if (chosen) {
      primaryWindows.set(def.id, chosen);
    }
  }

  // Weekend market-closed detection: Friday >= 17:00 NY until Monday 09:00 Tokyo (when no session is active & next open > 12h away or NY day is Sat/Sun/late Fri)
  const nyParts = getZonedParts(now, 'America/New_York');
  const tokyoParts = getZonedParts(now, 'Asia/Tokyo');
  const nyAfterFridayClose = nyParts.weekday === 5 && (nyParts.hour > 17 || (nyParts.hour === 17 && nyParts.minute >= 0));
  const isNySaturday = nyParts.weekday === 6;
  const isBeforeMondayTokyo =
    nyParts.weekday === 0 && (tokyoParts.weekday === 0 || (tokyoParts.weekday === 1 && tokyoParts.hour < 9));
  const anyActive = allWindows.some((w) => nowMs >= w.openMs && nowMs < w.closeMs);
  const isWeekendClosed = !anyActive && (nyAfterFridayClose || isNySaturday || isBeforeMondayTokyo);

  const sessions: SessionDisplay[] = SESSION_DEFS.map((def) => {
    const win = primaryWindows.get(def.id);
    const active = allWindows.some(
      (w) => w.def.id === def.id && nowMs >= w.openMs && nowMs < w.closeMs
    );

    if (!win) {
      return {
        id: def.id,
        name: def.name,
        cityLabel: def.cityLabel,
        color: def.color,
        localRangeLabel: '--:--',
        active,
        segments: []
      };
    }

    const openLocal = getZonedParts(new Date(win.openMs), localTz);
    const closeLocal = getZonedParts(new Date(win.closeMs), localTz);
    const startMin = openLocal.hour * 60 + openLocal.minute;
    const durationMin = Math.max(30, Math.round((win.closeMs - win.openMs) / 60_000));
    const segments = minutesToSegments(startMin, startMin + durationMin);

    return {
      id: def.id,
      name: def.name,
      cityLabel: def.cityLabel,
      color: def.color,
      localRangeLabel: `${pad2(openLocal.hour)}:${pad2(openLocal.minute)}–${pad2(closeLocal.hour)}:${pad2(closeLocal.minute)}`,
      active,
      segments
    };
  });

  // Compute London–NY overlap from matched weekday pair
  let overlapActive = false;
  let overlapRangeLabel: string | null = null;
  let overlapSegments: TimelineSegment[] = [];

  const londonWins = allWindows.filter((w) => w.def.id === 'london');
  const nyWins = allWindows.filter((w) => w.def.id === 'newyork');

  let bestOverlap: { startMs: number; endMs: number } | null = null;
  for (const lw of londonWins) {
    for (const nw of nyWins) {
      const startMs = Math.max(lw.openMs, nw.openMs);
      const endMs = Math.min(lw.closeMs, nw.closeMs);
      if (endMs > startMs) {
        if (nowMs >= startMs && nowMs < endMs) {
          overlapActive = true;
          bestOverlap = { startMs, endMs };
        } else if (!bestOverlap && endMs > nowMs) {
          bestOverlap = { startMs, endMs };
        }
      }
    }
  }

  if (bestOverlap) {
    const sLocal = getZonedParts(new Date(bestOverlap.startMs), localTz);
    const startMin = sLocal.hour * 60 + sLocal.minute;
    const durMin = Math.round((bestOverlap.endMs - bestOverlap.startMs) / 60_000);
    overlapSegments = minutesToSegments(startMin, startMin + durMin);
    overlapRangeLabel = `${formatLocalHm(bestOverlap.startMs, localTz)}–${formatLocalHm(bestOverlap.endMs, localTz)}`;
  }

  const activeNames = sessions.filter((s) => s.active).map((s) => s.name);

  // Next open/close countdown
  interface BoundaryEvent {
    ms: number;
    label: string;
  }
  const upcomingEvents: BoundaryEvent[] = [];
  for (const w of allWindows) {
    if (w.openMs > nowMs) {
      upcomingEvents.push({ ms: w.openMs, label: `${w.def.name} opens` });
    }
    if (w.closeMs > nowMs && nowMs >= w.openMs) {
      upcomingEvents.push({ ms: w.closeMs, label: `${w.def.name} closes` });
    }
  }
  upcomingEvents.sort((a, b) => a.ms - b.ms);
  const nextEvent = upcomingEvents[0];
  const nextEventLabel = nextEvent
    ? `${nextEvent.label} in ${formatDurationCompact(nextEvent.ms - nowMs)}`
    : 'Markets closed';

  return {
    timeZone: localTz,
    localTimeLabel,
    localDateLabel,
    nowPct,
    isWeekendClosed,
    sessions,
    overlapActive,
    overlapRangeLabel,
    overlapSegments,
    activeNames,
    nextEventLabel
  };
}

export function createDefaultRoutinesState(todayIso = getLocalDateIso()): RoutinesState {
  return {
    activeDate: todayIso,
    items: [
      {
        id: 'rit-cal',
        group: 'pre',
        label: 'Check Economic Calendar for red-folder events',
        done: false
      },
      {
        id: 'rit-bias',
        group: 'pre',
        label: 'Review Watchlist HTF bias & key levels',
        done: false
      },
      {
        id: 'rit-alerts',
        group: 'pre',
        label: 'Set key price alerts at POI zones',
        done: false
      },
      {
        id: 'rit-gate',
        group: 'session',
        label: 'Follow Pre-Trade Gate before every entry',
        done: false
      },
      {
        id: 'rit-risk',
        group: 'session',
        label: 'Respect max daily risk & invalidation',
        done: false
      },
      {
        id: 'rit-notes',
        group: 'post',
        label: 'Log setups & screenshots to Notes',
        done: false
      },
      {
        id: 'rit-playbook',
        group: 'post',
        label: 'Tag A+ trades & mistakes in Playbook',
        done: false
      },
      {
        id: 'rit-close',
        group: 'post',
        label: 'Close charts & step away cleanly',
        done: false
      }
    ],
    history: {}
  };
}

function pruneHistory(history: Record<string, RoutineDayRecord>): Record<string, RoutineDayRecord> {
  const keys = Object.keys(history).sort();
  if (keys.length <= 120) return history;
  const keep = keys.slice(keys.length - 120);
  const next: Record<string, RoutineDayRecord> = {};
  for (const k of keep) {
    next[k] = history[k];
  }
  return next;
}

export function syncTodayHistory(state: RoutinesState): RoutinesState {
  const done = state.items.filter((i) => i.done).length;
  const total = state.items.length;
  const nextHistory: Record<string, RoutineDayRecord> = {
    ...state.history,
    [state.activeDate]: { done, total }
  };
  return {
    ...state,
    history: pruneHistory(nextHistory)
  };
}

/** Auto-resets rituals when the local calendar date rolls over, archiving the previous day's ratio. */
export function reconcileRoutinesDay(
  raw: RoutinesState,
  todayIso = getLocalDateIso()
): { state: RoutinesState; rolledOver: boolean } {
  const validItems = Array.isArray(raw.items) && raw.items.length > 0
    ? raw.items
    : createDefaultRoutinesState(todayIso).items;
  const history: Record<string, RoutineDayRecord> =
    raw.history && typeof raw.history === 'object' ? { ...raw.history } : {};

  if (!raw.activeDate || raw.activeDate === todayIso) {
    const done = validItems.filter((i) => i.done).length;
    history[todayIso] = { done, total: validItems.length };
    return {
      state: {
        activeDate: todayIso,
        items: validItems,
        history: pruneHistory(history)
      },
      rolledOver: false
    };
  }

  // Archive the completed previous day before resetting for the new trading day
  const prevDone = validItems.filter((i) => i.done).length;
  if (prevDone > 0 || history[raw.activeDate]) {
    history[raw.activeDate] = { done: prevDone, total: validItems.length };
  }

  const resetItems = validItems.map((item) => ({ ...item, done: false }));
  history[todayIso] = { done: 0, total: resetItems.length };

  return {
    state: {
      activeDate: todayIso,
      items: resetItems,
      history: pruneHistory(history)
    },
    rolledOver: true
  };
}

export async function loadRoutinesState(): Promise<RoutinesState> {
  const todayIso = getLocalDateIso();
  const fallback = createDefaultRoutinesState(todayIso);
  const loaded = await loadWorkspaceJson<RoutinesState>(STORAGE_KEY, fallback);
  const { state, rolledOver } = reconcileRoutinesDay(loaded ?? fallback, todayIso);
  if (rolledOver) {
    void saveWorkspaceJson(STORAGE_KEY, state);
  }
  return state;
}

export async function saveRoutinesState(next: RoutinesState): Promise<void> {
  await saveWorkspaceJson(STORAGE_KEY, syncTodayHistory(next));
}

export function createRitualItem(group: RitualGroupId, label: string): RitualItem {
  return {
    id: makeWorkspaceId('rit'),
    group,
    label: label.trim(),
    done: false
  };
}

/** Builds the Mon–Fri weekly consistency row for the current local week. */
export function computeWeeklyConsistency(
  state: RoutinesState,
  now = new Date(),
  localTz = getLocalTimeZone()
): { days: WeekDayConsistency[]; completedDays: number } {
  const p = getZonedParts(now, localTz);
  const todayIso = formatIsoDate(p.year, p.month, p.day);
  // Distance from Monday (Mon=0, Tue=1, ..., Sat=5, Sun=6)
  const diffFromMon = p.weekday === 0 ? 6 : p.weekday - 1;
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  const days: WeekDayConsistency[] = [];
  let completedDays = 0;

  for (let i = 0; i < 5; i++) {
    const info = addCalendarDays(p.year, p.month, p.day, i - diffFromMon);
    const iso = formatIsoDate(info.year, info.month, info.day);
    const isToday = iso === todayIso;
    const isFuture = iso > todayIso;

    let done = 0;
    let total = state.items.length;

    if (isToday && state.activeDate === todayIso) {
      done = state.items.filter((it) => it.done).length;
      total = state.items.length;
    } else if (state.history[iso]) {
      done = state.history[iso].done;
      total = state.history[iso].total;
    }

    let status: 'full' | 'partial' | 'empty' = 'empty';
    if (!isFuture && total > 0 && done >= total) {
      status = 'full';
      completedDays += 1;
    } else if (!isFuture && done > 0) {
      status = 'partial';
    }

    days.push({
      label: labels[i],
      date: iso,
      done,
      total,
      isToday,
      isFuture,
      status
    });
  }

  return { days, completedDays };
}
