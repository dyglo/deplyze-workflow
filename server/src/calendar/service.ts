import { ensureArchiveLoaded, getArchivedEventsForUtcDays, recordShowMyTradesEvents } from './archive.js';
import { attachFomcRates, getFedFomcEvents } from './fed.js';
import { getFredSnapshot } from './fred.js';
import { getShowMyTradesSnapshot } from './showmytrades.js';
import { addDays, formatPartsInTz, getTodayInTz, getWeekStart, isIsoDate, resolveTimeZone } from './time.js';
import type {
  CalendarCategory,
  CalendarDaySummary,
  CalendarEventsPayload,
  CalendarWeekPayload,
  CountryCode,
  EconomicEvent,
  EventImpact,
  EventSource,
  RawEconomicEvent
} from './types.js';

const IMPACT_RANK: Record<EventImpact, number> = { high: 0, medium: 1, low: 2 };

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isDuplicateEvent(existing: RawEconomicEvent[], candidate: RawEconomicEvent): boolean {
  const candNorm = normalizeTitleKey(candidate.title);
  for (const ev of existing) {
    if (ev.country !== candidate.country) continue;
    // Same timestamp within 30 minutes
    if (Math.abs(ev.ts - candidate.ts) > 1800) continue;
    const evNorm = normalizeTitleKey(ev.title);
    if (evNorm === candNorm || evNorm.includes(candNorm) || candNorm.includes(evNorm)) {
      return true;
    }
    // Special match: Core CPI naming variation ("Consumer Price Index ex Food & Energy" vs "Core CPI")
    if (
      evNorm.includes('ex food') &&
      candNorm.includes('core cpi') &&
      ((evNorm.includes('yoy') && candNorm.includes('yoy')) ||
        (evNorm.includes('mom') && candNorm.includes('mom')))
    ) {
      return true;
    }
    // Special match: Fed Rate Decision / FOMC statement
    if (
      (evNorm.includes('fed interest rate') || evNorm.includes('fomc')) &&
      (candNorm.includes('fed interest rate') || candNorm.includes('fomc')) &&
      evNorm.includes('press conference') === candNorm.includes('press conference')
    ) {
      return true;
    }
  }
  return false;
}

function toClientEvent(raw: RawEconomicEvent, tz: string, nowSec: number): EconomicEvent {
  const { date, time } = formatPartsInTz(new Date(raw.ts * 1000), tz);
  const released = raw.ts <= nowSec + 300;
  const actual = released && raw.actual ? raw.actual : undefined;
  const flagged =
    raw.impact === 'high' && raw.ts >= nowSec - 15 * 60 && raw.ts <= nowSec + 60 * 60;

  return {
    id: raw.id,
    date,
    time,
    ts: raw.ts,
    isoTime: raw.isoTime,
    title: raw.title,
    country: raw.country,
    impact: raw.impact,
    flagged: flagged || undefined,
    prior: raw.prior,
    forecast: raw.forecast,
    actual,
    source: raw.source
  };
}

function bucketByTzDate(events: RawEconomicEvent[], tz: string): Map<string, RawEconomicEvent[]> {
  const map = new Map<string, RawEconomicEvent[]>();
  for (const ev of events) {
    const { date } = formatPartsInTz(new Date(ev.ts * 1000), tz);
    const list = map.get(date);
    if (list) list.push(ev);
    else map.set(date, [ev]);
  }
  return map;
}

function sortEvents(events: EconomicEvent[]): EconomicEvent[] {
  return events.sort(
    (a, b) =>
      a.ts - b.ts ||
      IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
      a.title.localeCompare(b.title)
  );
}

async function resolveEconomicEventsForDates(
  targetDates: string[],
  tz: string
): Promise<{
  eventsByDate: Record<string, EconomicEvent[]>;
  sources: EventSource[];
  fallbackActive: boolean;
}> {
  await ensureArchiveLoaded();

  const nowSec = Math.floor(Date.now() / 1000);
  const todayTz = getTodayInTz(tz);
  const smtMaxDayTz = addDays(todayTz, 29);

  // Always check ShowMyTrades first (cached 15 min w/ ETag)
  const smt = await getShowMyTradesSnapshot();
  if (smt.ok && smt.events.length > 0) {
    await recordShowMyTradesEvents(smt.events);
  }

  const needsSupplemental =
    !smt.ok ||
    targetDates.some((d) => d < todayTz || d > smtMaxDayTz || d === todayTz);

  let supplementalEvents: RawEconomicEvent[] = [];
  if (needsSupplemental) {
    const [fred, fedRaw] = await Promise.all([getFredSnapshot(), getFedFomcEvents()]);
    const fedEnriched = attachFomcRates(fedRaw, fred.fomcRatesDesc, nowSec);
    supplementalEvents = [...fred.events, ...fedEnriched];
  }

  // Pull archived ShowMyTrades events spanning targetDates +/- 1 UTC day for timezone edges
  const utcDayCandidates = new Set<string>();
  for (const d of targetDates) {
    utcDayCandidates.add(addDays(d, -1));
    utcDayCandidates.add(d);
    utcDayCandidates.add(addDays(d, 1));
  }
  const archivedSmt = getArchivedEventsForUtcDays(Array.from(utcDayCandidates));

  const liveSmtByDate = bucketByTzDate(smt.events, tz);
  const archivedSmtByDate = bucketByTzDate(archivedSmt, tz);
  const supplementalByDate = bucketByTzDate(supplementalEvents, tz);

  const usedSources = new Set<EventSource>();
  const eventsByDate: Record<string, EconomicEvent[]> = {};

  for (const dayIso of targetDates) {
    const inSmtWindow = smt.ok && dayIso >= todayTz && dayIso <= smtMaxDayTz;
    const chosen: RawEconomicEvent[] = [];

    if (inSmtWindow) {
      // Primary: ShowMyTrades live + any earlier-today archived ShowMyTrades events that aged past -6h
      const byId = new Map<string, RawEconomicEvent>();
      for (const ev of archivedSmtByDate.get(dayIso) ?? []) byId.set(ev.id, ev);
      for (const ev of liveSmtByDate.get(dayIso) ?? []) {
        const prev = byId.get(ev.id);
        byId.set(ev.id, {
          ...ev,
          prior: ev.prior ?? prev?.prior,
          forecast: ev.forecast ?? prev?.forecast,
          actual: ev.actual ?? prev?.actual
        });
      }
      chosen.push(...byId.values());

      // On today's date, if Render restarted after a morning US release rolled off SMT's -6h window,
      // supplement any missing US/FOMC release from FRED + Fed without duplicating SMT rows
      if (dayIso === todayTz) {
        for (const sup of supplementalByDate.get(dayIso) ?? []) {
          if (sup.ts < smt.windowStartTs && !isDuplicateEvent(chosen, sup)) {
            chosen.push(sup);
          }
        }
      }
    } else if (dayIso < todayTz) {
      // Past date: start with persisted ShowMyTrades archive if available, then merge FRED + Fed
      // (FRED + Fed always survive cold restarts on ephemeral hosts and fill authoritative actuals)
      const archived = archivedSmtByDate.get(dayIso) ?? [];
      chosen.push(...archived);

      for (const sup of supplementalByDate.get(dayIso) ?? []) {
        if (!isDuplicateEvent(chosen, sup)) {
          chosen.push(sup);
        } else if (sup.actual) {
          // If archive had pre-release US event without actual, enrich actual from FRED/Fed
          const match = chosen.find((ev) => isDuplicateEvent([ev], sup));
          if (match && !match.actual) {
            match.actual = sup.actual;
          }
        }
      }
    } else {
      // >30 days ahead OR ShowMyTrades fallback: use FRED + Fed
      chosen.push(...(supplementalByDate.get(dayIso) ?? []));
    }

    for (const ev of chosen) usedSources.add(ev.source);
    eventsByDate[dayIso] = sortEvents(chosen.map((ev) => toClientEvent(ev, tz, nowSec)));
  }

  return {
    eventsByDate,
    sources: Array.from(usedSources),
    fallbackActive: !smt.ok
  };
}

export async function getCalendarWeekPayload(
  startParam: string | null,
  tzParam: string | null
): Promise<CalendarWeekPayload> {
  const tz = resolveTimeZone(tzParam);
  const weekStart = isIsoDate(startParam) ? startParam : getWeekStart(getTodayInTz(tz));
  const targetDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const { eventsByDate, sources, fallbackActive } = await resolveEconomicEventsForDates(
    targetDates,
    tz
  );

  const days: CalendarDaySummary[] = targetDates.map((iso) => ({
    iso,
    counts: {
      economic: eventsByDate[iso]?.length ?? 0,
      earnings: 0,
      dividends: 0,
      ipo: 0
    }
  }));

  return {
    timezone: tz,
    weekStart,
    sources,
    fallbackActive,
    days,
    eventsByDate
  };
}

export async function getCalendarEventsPayload(
  dateParam: string | null,
  categoryParam: string | null,
  tzParam: string | null
): Promise<CalendarEventsPayload> {
  const tz = resolveTimeZone(tzParam);
  const date = isIsoDate(dateParam) ? dateParam : getTodayInTz(tz);
  const category = (
    categoryParam === 'earnings' ||
    categoryParam === 'dividends' ||
    categoryParam === 'ipo'
      ? categoryParam
      : 'economic'
  ) as CalendarCategory;

  if (category !== 'economic') {
    return {
      timezone: tz,
      date,
      category,
      sources: [],
      fallbackActive: false,
      events: []
    };
  }

  const { eventsByDate, sources, fallbackActive } = await resolveEconomicEventsForDates([date], tz);
  return {
    timezone: tz,
    date,
    category,
    sources,
    fallbackActive,
    events: eventsByDate[date] ?? []
  };
}

/**
 * Resolves all economic calendar events (past archived ShowMyTrades + FRED + Fed FOMC + live)
 * falling within [startTs - padBeforeSec, endTs + padAfterSec] in the requested timezone.
 */
export async function getCalendarEventsInWindow(
  startTs: number,
  endTs: number,
  tzParam: string | null | undefined,
  options?: {
    padBeforeSec?: number;
    padAfterSec?: number;
    countries?: CountryCode[];
  }
): Promise<{
  timezone: string;
  events: EconomicEvent[];
  sources: EventSource[];
}> {
  const tz = resolveTimeZone(tzParam);
  const lo = Math.min(startTs, endTs);
  const hi = Math.max(startTs, endTs);
  const padBefore = options?.padBeforeSec ?? 7_200; // 2 hours prior
  const padAfter = options?.padAfterSec ?? 3_600; // 1 hour after
  const winStart = lo - padBefore;
  const winEnd = hi + padAfter;

  const startDateIso = formatPartsInTz(new Date(winStart * 1000), tz).date;
  const endDateIso = formatPartsInTz(new Date(winEnd * 1000), tz).date;

  // Build unique list of local dates spanning the window (capped at 14 days for wide HTF ranges)
  const targetDates: string[] = [];
  let cursor = startDateIso;
  let guard = 0;
  while (cursor <= endDateIso && guard < 14) {
    targetDates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  // If range exceeded 14 days, ensure the end date and day prior are also covered
  if (endDateIso > (targetDates[targetDates.length - 1] ?? '')) {
    const prevEnd = addDays(endDateIso, -1);
    if (!targetDates.includes(prevEnd)) targetDates.push(prevEnd);
    if (!targetDates.includes(endDateIso)) targetDates.push(endDateIso);
  }

  const { eventsByDate, sources } = await resolveEconomicEventsForDates(targetDates, tz);
  const countrySet = options?.countries && options.countries.length > 0 ? new Set(options.countries) : null;

  const seen = new Set<string>();
  const matched: EconomicEvent[] = [];
  for (const day of targetDates) {
    for (const ev of eventsByDate[day] ?? []) {
      if (seen.has(ev.id)) continue;
      if (ev.ts < winStart || ev.ts > winEnd) continue;
      if (countrySet && !countrySet.has(ev.country)) continue;
      seen.add(ev.id);
      matched.push(ev);
    }
  }

  return {
    timezone: tz,
    events: sortEvents(matched),
    sources
  };
}
