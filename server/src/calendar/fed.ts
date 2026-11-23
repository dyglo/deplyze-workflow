import { easternTimeToUnixSeconds } from './time.js';
import type { RawEconomicEvent } from './types.js';

const FED_CALENDAR_URL = 'https://www.federalreserve.gov/json/calendar.json';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const FETCH_TIMEOUT_MS = 15_000;

interface FedCalendarItem {
  title?: string;
  type?: string;
  month?: string; // "YYYY-MM"
  days?: string; // "9", "18", "8 - 9"
  time?: string; // "2:00 p.m.", "2:30 p.m."
}

interface FedCalendarJson {
  events?: FedCalendarItem[];
}

export interface FedFomcRatePoint {
  date: string; // YYYY-MM-DD
  rate: number;
}

let cachedEvents: RawEconomicEvent[] = [];
let cachedAt = 0;
let inflight: Promise<RawEconomicEvent[]> | null = null;

function parseTimeEt(timeStr: string | undefined, fallbackHour: number, fallbackMinute: number): { hour: number; minute: number } {
  if (!timeStr) return { hour: fallbackHour, minute: fallbackMinute };
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = (match[3] ?? '').toLowerCase();

  if (meridiem.startsWith('p') && hour < 12) hour += 12;
  else if (meridiem.startsWith('a') && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }
  return { hour, minute };
}

function parseDecisionDay(daysStr: string | undefined): number | null {
  if (!daysStr) return null;
  const nums = daysStr.match(/\d{1,2}/g);
  if (!nums || nums.length === 0) return null;
  // For multi-day meetings ("8 - 9"), the FOMC statement is on the final day
  const day = Number(nums[nums.length - 1]);
  return day >= 1 && day <= 31 ? day : null;
}

async function fetchFedCalendarFresh(): Promise<RawEconomicEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(FED_CALENDAR_URL, {
      headers: {
        'User-Agent': 'DeplyzeWorkflow-API/0.1 (+https://deplyze-workflow-api.onrender.com)',
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Federal Reserve calendar HTTP ${res.status}`);
    }

    const rawText = await res.text();
    const cleanText = rawText.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(cleanText) as FedCalendarJson;
    const items = Array.isArray(parsed.events) ? parsed.events : [];

    const seen = new Set<string>();
    const out: RawEconomicEvent[] = [];

    for (const item of items) {
      if ((item.type ?? '').toUpperCase() !== 'FOMC') continue;
      const month = (item.month ?? '').trim();
      if (!/^\d{4}-\d{2}$/.test(month)) continue;

      const day = parseDecisionDay(item.days);
      if (!day) continue;

      const rawTitle = (item.title ?? '').trim();
      const lowerTitle = rawTitle.toLowerCase();
      if (!lowerTitle.includes('fomc')) continue;

      // Skip minutes/other entries if not meeting or press conference
      const isPressConf = lowerTitle.includes('press conference');
      const isMeeting = lowerTitle.includes('meeting');
      if (!isPressConf && !isMeeting) continue;

      const dateIso = `${month}-${String(day).padStart(2, '0')}`;
      const { hour, minute } = parseTimeEt(item.time, isPressConf ? 14 : 14, isPressConf ? 30 : 0);
      const ts = easternTimeToUnixSeconds(dateIso, hour, minute);
      const title = isPressConf ? 'FOMC Press Conference' : 'Fed Interest Rate Decision';
      const dedupeKey = `${dateIso}|${title}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push({
        id: `fed-fomc-${dateIso}-${isPressConf ? 'pc' : 'rate'}`,
        ts,
        isoTime: new Date(ts * 1000).toISOString(),
        title,
        country: 'US',
        currency: 'USD',
        impact: 'high',
        source: 'fed'
      });
    }

    // Ensure every FOMC decision meeting also has its 2:30 p.m. ET Press Conference if Fed JSON omitted it
    for (const ev of [...out]) {
      if (ev.title !== 'Fed Interest Rate Decision') continue;
      const dateIso = ev.id.slice('fed-fomc-'.length, 'fed-fomc-'.length + 10);
      const pcKey = `${dateIso}|FOMC Press Conference`;
      if (seen.has(pcKey)) continue;
      seen.add(pcKey);
      const pcTs = ev.ts + 30 * 60;
      out.push({
        id: `fed-fomc-${dateIso}-pc`,
        ts: pcTs,
        isoTime: new Date(pcTs * 1000).toISOString(),
        title: 'FOMC Press Conference',
        country: 'US',
        currency: 'USD',
        impact: 'high',
        source: 'fed'
      });
    }

    out.sort((a, b) => a.ts - b.ts);
    cachedEvents = out;
    cachedAt = Date.now();
    return out;
  } catch (err) {
    console.warn('[calendar:fed] fetch failed:', (err as Error).message);
    return cachedEvents;
  } finally {
    clearTimeout(timer);
  }
}

export async function getFedFomcEvents(): Promise<RawEconomicEvent[]> {
  if (cachedEvents.length > 0 && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedEvents;
  }
  if (!inflight) {
    inflight = fetchFedCalendarFresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Enriches FOMC Rate Decision events with prior/actual Fed Funds upper target rate
 * using DFEDTARU observations (sorted descending by date).
 */
export function attachFomcRates(
  fomcEvents: RawEconomicEvent[],
  rateObsDesc: FedFomcRatePoint[],
  nowSec: number
): RawEconomicEvent[] {
  if (rateObsDesc.length === 0) return fomcEvents;

  const formatRate = (r: number) => `${r.toFixed(2).replace(/\.00$/, '')}%`;

  return fomcEvents.map((ev) => {
    if (ev.title !== 'Fed Interest Rate Decision') return ev;
    const dateIso = ev.id.slice('fed-fomc-'.length, 'fed-fomc-'.length + 10);

    if (ev.ts > nowSec) {
      // Upcoming: show latest target rate as Prior
      return { ...ev, prior: formatRate(rateObsDesc[0].rate) };
    }

    // Past FOMC meeting: DFEDTARU updates the day after the meeting (effective next business day)
    // Find rate effective <= dateIso (prior) and rate effective <= dateIso + 3 days (actual)
    const afterLimit = shiftIsoDays(dateIso, 4);
    const priorPoint = rateObsDesc.find((p) => p.date <= dateIso);
    const actualPoint = rateObsDesc.find((p) => p.date <= afterLimit);

    return {
      ...ev,
      prior: priorPoint ? formatRate(priorPoint.rate) : undefined,
      actual: actualPoint ? formatRate(actualPoint.rate) : undefined
    };
  });
}

function shiftIsoDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
