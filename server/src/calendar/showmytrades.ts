import type { CountryCode, EventImpact, RawEconomicEvent } from './types.js';

const SHOWMYTRADES_URL =
  'https://showmytrades.com/api/public/calendar/v1?days=30&impact=low,medium,high';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes (matches upstream Cache-Control: max-age=900)
const STALE_FALLBACK_MAX_MS = 2 * 60 * 60 * 1000; // 2 hours
const FETCH_TIMEOUT_MS = 12_000;

interface ShowMyTradesApiEvent {
  id?: string;
  ts?: number;
  time?: string;
  currency?: string;
  impact?: string;
  title?: string;
  forecast?: string | null;
  previous?: string | null;
  actual?: string | null;
}

interface ShowMyTradesApiResponse {
  from?: string;
  to?: string;
  events?: ShowMyTradesApiEvent[];
}

export interface ShowMyTradesSnapshot {
  ok: boolean;
  events: RawEconomicEvent[];
  fetchedAt: number;
  windowStartTs: number;
  windowEndTs: number;
}

let cachedEvents: RawEconomicEvent[] = [];
let cachedEtag: string | null = null;
let cachedAt = 0;
let cachedWindowStartTs = 0;
let cachedWindowEndTs = 0;
let inflight: Promise<ShowMyTradesSnapshot> | null = null;

function mapCurrencyToCountry(currency: string, title: string): CountryCode | null {
  switch (currency.toUpperCase()) {
    case 'USD':
      return 'US';
    case 'GBP':
      return 'GB';
    case 'JPY':
      return 'JP';
    case 'AUD':
      return 'AU';
    case 'NZD':
      return 'NZ';
    case 'CAD':
      return 'CA';
    case 'CHF':
      return 'CH';
    case 'CNY':
      return 'CN';
    case 'EUR':
      return /\(DE\)|\bGerman(?:y)?\b/i.test(title) ? 'DE' : 'EU';
    default:
      return null;
  }
}

function normalizeImpact(impact: string | undefined): EventImpact | null {
  const lower = (impact ?? '').toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') {
    return lower;
  }
  return null;
}

function cleanValue(val: string | null | undefined): string | undefined {
  if (val == null) return undefined;
  const trimmed = String(val).replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEvents(raw: ShowMyTradesApiEvent[], nowSec: number): RawEconomicEvent[] {
  const out: RawEconomicEvent[] = [];
  for (const item of raw) {
    const impact = normalizeImpact(item.impact);
    const title = cleanValue(item.title);
    const currency = cleanValue(item.currency)?.toUpperCase();
    if (!impact || !title || !currency) continue;

    const country = mapCurrencyToCountry(currency, title);
    if (!country) continue;

    let ts = typeof item.ts === 'number' && Number.isFinite(item.ts) ? Math.floor(item.ts) : 0;
    if (!ts && item.time) {
      const parsed = Date.parse(item.time);
      if (Number.isFinite(parsed)) ts = Math.floor(parsed / 1000);
    }
    if (!ts) continue;

    const isoTime = new Date(ts * 1000).toISOString();
    const rawActual = cleanValue(item.actual);
    // Show Actual only once released (allow 5-min clock tolerance)
    const actual = rawActual && ts <= nowSec + 300 ? rawActual : undefined;

    out.push({
      id: item.id ? `smt-${item.id}` : `smt-${ts}-${currency}-${title.slice(0, 24)}`,
      ts,
      isoTime,
      title,
      country,
      currency,
      impact,
      prior: cleanValue(item.previous),
      forecast: cleanValue(item.forecast),
      actual,
      source: 'showmytrades'
    });
  }
  return out;
}

async function fetchShowMyTradesFresh(): Promise<ShowMyTradesSnapshot> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const headers: Record<string, string> = {
    'User-Agent': 'DeplyzeWorkflow-API/0.1 (+https://deplyze-workflow-api.onrender.com)',
    Accept: 'application/json'
  };
  if (cachedEtag && cachedEvents.length > 0) {
    headers['If-None-Match'] = cachedEtag;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(SHOWMYTRADES_URL, { headers, signal: controller.signal });

    if (res.status === 304 && cachedEvents.length > 0) {
      cachedAt = nowMs;
      return {
        ok: true,
        events: cachedEvents,
        fetchedAt: cachedAt,
        windowStartTs: cachedWindowStartTs,
        windowEndTs: cachedWindowEndTs
      };
    }

    if (!res.ok) {
      throw new Error(`ShowMyTrades HTTP ${res.status}`);
    }

    const body = (await res.json()) as ShowMyTradesApiResponse;
    const events = parseEvents(Array.isArray(body.events) ? body.events : [], nowSec);

    const etag = res.headers.get('etag');
    if (etag) cachedEtag = etag;

    const fromTs = body.from ? Math.floor(Date.parse(body.from) / 1000) : nowSec - 6 * 3600;
    const toTs = body.to ? Math.floor(Date.parse(body.to) / 1000) : nowSec + 30 * 86400;

    cachedEvents = events;
    cachedAt = nowMs;
    cachedWindowStartTs = Number.isFinite(fromTs) ? fromTs : nowSec - 6 * 3600;
    cachedWindowEndTs = Number.isFinite(toTs) ? toTs : nowSec + 30 * 86400;

    return {
      ok: true,
      events: cachedEvents,
      fetchedAt: cachedAt,
      windowStartTs: cachedWindowStartTs,
      windowEndTs: cachedWindowEndTs
    };
  } catch (err) {
    console.warn('[calendar:showmytrades] fetch failed:', (err as Error).message);
    if (cachedEvents.length > 0 && nowMs - cachedAt <= STALE_FALLBACK_MAX_MS) {
      return {
        ok: true,
        events: cachedEvents,
        fetchedAt: cachedAt,
        windowStartTs: cachedWindowStartTs,
        windowEndTs: cachedWindowEndTs
      };
    }
    return {
      ok: false,
      events: [],
      fetchedAt: 0,
      windowStartTs: 0,
      windowEndTs: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getShowMyTradesSnapshot(): Promise<ShowMyTradesSnapshot> {
  const nowMs = Date.now();
  if (cachedEvents.length > 0 && nowMs - cachedAt < CACHE_TTL_MS) {
    return {
      ok: true,
      events: cachedEvents,
      fetchedAt: cachedAt,
      windowStartTs: cachedWindowStartTs,
      windowEndTs: cachedWindowEndTs
    };
  }

  if (!inflight) {
    inflight = fetchShowMyTradesFresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
