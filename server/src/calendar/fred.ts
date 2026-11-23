import { easternTimeToUnixSeconds, formatUtcDate } from './time.js';
import type { EventImpact, RawEconomicEvent } from './types.js';
import type { FedFomcRatePoint } from './fed.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const OBSERVATIONS_TTL_MS = 60 * 60 * 1000; // 1 hour (catches newly released actuals promptly)
const FETCH_TIMEOUT_MS = 15_000;

type MetricKind =
  | 'deltaK'
  | 'levelPct'
  | 'momPct'
  | 'yoyPct'
  | 'levelKFromUnits'
  | 'levelMFromThousands';

type Periodicity = 'monthly' | 'weekly' | 'quarterly';

interface SeriesIndicatorSpec {
  idSuffix: string;
  title: string;
  seriesId: string;
  metric: MetricKind;
  impact: EventImpact;
}

interface FredReleaseSpec {
  releaseId: number;
  hourEt: number;
  minuteEt: number;
  periodicity: Periodicity;
  /** For monthly releases: how many months prior the reported period is (e.g. 1 for CPI/NFP, 2 for JOLTS). */
  lagMonths?: number;
  indicators: SeriesIndicatorSpec[];
}

const FRED_RELEASES: FredReleaseSpec[] = [
  {
    releaseId: 50, // Employment Situation
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'monthly',
    lagMonths: 1,
    indicators: [
      { idSuffix: 'nfp', title: 'Nonfarm Payrolls', seriesId: 'PAYEMS', metric: 'deltaK', impact: 'high' },
      { idSuffix: 'unrate', title: 'Unemployment Rate', seriesId: 'UNRATE', metric: 'levelPct', impact: 'high' },
      {
        idSuffix: 'ahe-mom',
        title: 'Average Hourly Earnings MoM',
        seriesId: 'CES0500000003',
        metric: 'momPct',
        impact: 'medium'
      }
    ]
  },
  {
    releaseId: 10, // Consumer Price Index
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'monthly',
    lagMonths: 1,
    indicators: [
      { idSuffix: 'cpi-yoy', title: 'Consumer Price Index YoY', seriesId: 'CPIAUCSL', metric: 'yoyPct', impact: 'high' },
      { idSuffix: 'cpi-mom', title: 'Consumer Price Index MoM', seriesId: 'CPIAUCSL', metric: 'momPct', impact: 'high' },
      { idSuffix: 'core-cpi-yoy', title: 'Core CPI YoY', seriesId: 'CPILFESL', metric: 'yoyPct', impact: 'high' },
      { idSuffix: 'core-cpi-mom', title: 'Core CPI MoM', seriesId: 'CPILFESL', metric: 'momPct', impact: 'high' }
    ]
  },
  {
    releaseId: 46, // Producer Price Index
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'monthly',
    lagMonths: 1,
    indicators: [
      { idSuffix: 'ppi-mom', title: 'Producer Price Index MoM', seriesId: 'PPIFIS', metric: 'momPct', impact: 'high' }
    ]
  },
  {
    releaseId: 54, // Personal Income and Outlays (PCE)
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'monthly',
    lagMonths: 1,
    indicators: [
      {
        idSuffix: 'core-pce-yoy',
        title: 'Core PCE Price Index YoY',
        seriesId: 'PCEPILFE',
        metric: 'yoyPct',
        impact: 'high'
      },
      { idSuffix: 'pce-yoy', title: 'PCE Price Index YoY', seriesId: 'PCEPI', metric: 'yoyPct', impact: 'medium' }
    ]
  },
  {
    releaseId: 9, // Advance Monthly Retail Sales
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'monthly',
    lagMonths: 1,
    indicators: [
      { idSuffix: 'retail-mom', title: 'Retail Sales MoM', seriesId: 'RSAFS', metric: 'momPct', impact: 'high' }
    ]
  },
  {
    releaseId: 53, // Gross Domestic Product
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'quarterly',
    indicators: [
      {
        idSuffix: 'gdp-qoq',
        title: 'GDP Growth Rate QoQ',
        seriesId: 'A191RL1Q225SBEA',
        metric: 'levelPct',
        impact: 'high'
      }
    ]
  },
  {
    releaseId: 180, // Unemployment Insurance Weekly Claims
    hourEt: 8,
    minuteEt: 30,
    periodicity: 'weekly',
    indicators: [
      {
        idSuffix: 'icsa',
        title: 'Initial Jobless Claims',
        seriesId: 'ICSA',
        metric: 'levelKFromUnits',
        impact: 'medium'
      }
    ]
  },
  {
    releaseId: 192, // JOLTS
    hourEt: 10,
    minuteEt: 0,
    periodicity: 'monthly',
    lagMonths: 2,
    indicators: [
      {
        idSuffix: 'jolts',
        title: 'JOLTS Job Openings',
        seriesId: 'JTSJOL',
        metric: 'levelMFromThousands',
        impact: 'high'
      }
    ]
  }
];

interface ObsPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface FredSnapshot {
  ok: boolean;
  events: RawEconomicEvent[];
  fomcRatesDesc: FedFomcRatePoint[];
}

const releaseDatesCache = new Map<number, string[]>();
const seriesObsCache = new Map<string, ObsPoint[]>();
let scheduleCachedAt = 0;
let obsCachedAt = 0;
let inflight: Promise<FredSnapshot> | null = null;

function getApiKey(): string {
  return (process.env.FRED_API_KEY ?? '').trim();
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'DeplyzeWorkflow-API/0.1 (+https://deplyze-workflow-api.onrender.com)',
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`FRED HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
}

async function refreshSchedules(apiKey: string): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() - 210 * 86_400_000);
  const end = new Date(now.getTime() + 210 * 86_400_000);
  const startIso = formatUtcDate(start);
  const endIso = formatUtcDate(end);

  await runPool(FRED_RELEASES, 4, async (spec) => {
    const url =
      `${FRED_BASE}/release/dates?release_id=${spec.releaseId}` +
      `&realtime_start=${startIso}&realtime_end=${endIso}` +
      `&include_release_dates_with_no_data=true&sort_order=asc` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    try {
      const data = await fetchJson<{ release_dates?: { date?: string }[] }>(url);
      const dates = Array.from(
        new Set(
          (data.release_dates ?? [])
            .map((d) => d.date)
            .filter((d): d is string => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d)))
        )
      ).sort();
      if (dates.length > 0) {
        releaseDatesCache.set(spec.releaseId, dates);
      }
    } catch (err) {
      console.warn(`[calendar:fred] release ${spec.releaseId} dates failed:`, (err as Error).message);
    }
  });

  scheduleCachedAt = Date.now();
}

async function refreshObservations(apiKey: string): Promise<void> {
  const uniqueSeries = new Set<string>(['DFEDTARU']);
  for (const spec of FRED_RELEASES) {
    for (const ind of spec.indicators) {
      uniqueSeries.add(ind.seriesId);
    }
  }

  await runPool(Array.from(uniqueSeries), 4, async (seriesId) => {
    const limit = seriesId === 'DFEDTARU' ? 400 : seriesId === 'ICSA' ? 60 : 36;
    const url =
      `${FRED_BASE}/series/observations?series_id=${encodeURIComponent(seriesId)}` +
      `&sort_order=desc&limit=${limit}` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    try {
      const data = await fetchJson<{ observations?: { date?: string; value?: string }[] }>(url);
      const parsed: ObsPoint[] = [];
      for (const o of data.observations ?? []) {
        if (!o.date || !o.value || o.value === '.') continue;
        const num = Number(o.value);
        if (!Number.isFinite(num)) continue;
        parsed.push({ date: o.date, value: num });
      }
      if (parsed.length > 0) {
        seriesObsCache.set(seriesId, parsed);
      }
    } catch (err) {
      console.warn(`[calendar:fred] series ${seriesId} failed:`, (err as Error).message);
    }
  });

  obsCachedAt = Date.now();
}

function formatPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  return `${safe.toFixed(1)}%`;
}

function computeMetricAt(obsDesc: ObsPoint[], idx: number, metric: MetricKind): string | undefined {
  if (idx < 0 || idx >= obsDesc.length) return undefined;
  const curr = obsDesc[idx];

  switch (metric) {
    case 'levelPct':
      return formatPct(curr.value);
    case 'levelKFromUnits':
      return `${Math.round(curr.value / 1000)}K`;
    case 'levelMFromThousands':
      return `${(curr.value / 1000).toFixed(2)}M`;
    case 'deltaK': {
      const prev = obsDesc[idx + 1];
      if (!prev) return undefined;
      return `${Math.round(curr.value - prev.value)}K`;
    }
    case 'momPct': {
      const prev = obsDesc[idx + 1];
      if (!prev || prev.value === 0) return undefined;
      return formatPct(((curr.value - prev.value) / prev.value) * 100);
    }
    case 'yoyPct': {
      const [y, m, d] = curr.date.split('-').map(Number);
      const targetYearAgo = `${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const yearAgo = obsDesc.find((p) => p.date === targetYearAgo) ?? obsDesc[idx + 12];
      if (!yearAgo || yearAgo.value === 0) return undefined;
      return formatPct(((curr.value - yearAgo.value) / yearAgo.value) * 100);
    }
  }
}

function shiftMonthsFirstDay(dateIso: string, deltaMonths: number): string {
  const [y, m] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function shiftIsoDays(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Matches a past release date to the observation index published on that date.
 */
function findPublishedObsIndex(
  spec: FredReleaseSpec,
  releaseDate: string,
  obsDesc: ObsPoint[]
): number {
  if (obsDesc.length === 0) return -1;

  if (spec.periodicity === 'monthly') {
    const targetMonth = shiftMonthsFirstDay(releaseDate, -(spec.lagMonths ?? 1));
    return obsDesc.findIndex((p) => p.date === targetMonth);
  }

  if (spec.periodicity === 'weekly') {
    // Weekly claims published Thursday cover the week ending the prior Saturday (~5 days earlier)
    const maxObsDate = shiftIsoDays(releaseDate, -3);
    const minObsDate = shiftIsoDays(releaseDate, -9);
    return obsDesc.findIndex((p) => p.date <= maxObsDate && p.date >= minObsDate);
  }

  // Quarterly GDP: match the most recent quarter whose period start is before the release date
  // (e.g., releases in Oct/Nov/Dec 2026 report Q3 2026 = 2026-07-01)
  const [y, m] = releaseDate.split('-').map(Number);
  const quarterIndex = Math.floor((m - 1) / 3); // 0=Q1, 1=Q2, 2=Q3, 3=Q4
  const prevQuarterStartMonth = ((quarterIndex + 3) % 4) * 3 + 1;
  const prevQuarterYear = quarterIndex === 0 ? y - 1 : y;
  const targetQuarter = `${prevQuarterYear}-${String(prevQuarterStartMonth).padStart(2, '0')}-01`;
  return obsDesc.findIndex((p) => p.date === targetQuarter);
}

function buildFredEvents(nowSec: number): RawEconomicEvent[] {
  const events: RawEconomicEvent[] = [];

  for (const spec of FRED_RELEASES) {
    const dates = releaseDatesCache.get(spec.releaseId) ?? [];
    for (const dateIso of dates) {
      const ts = easternTimeToUnixSeconds(dateIso, spec.hourEt, spec.minuteEt);
      const isoTime = new Date(ts * 1000).toISOString();
      const isReleased = ts <= nowSec;

      for (const ind of spec.indicators) {
        const obsDesc = seriesObsCache.get(ind.seriesId) ?? [];
        let prior: string | undefined;
        let actual: string | undefined;

        if (!isReleased) {
          // Upcoming release: latest available observation is Prior; no Actual yet
          prior = computeMetricAt(obsDesc, 0, ind.metric);
        } else {
          const publishedIdx = findPublishedObsIndex(spec, dateIso, obsDesc);
          if (publishedIdx >= 0) {
            actual = computeMetricAt(obsDesc, publishedIdx, ind.metric);
            prior = computeMetricAt(obsDesc, publishedIdx + 1, ind.metric);
          } else {
            // Release happened very recently and FRED hasn't posted the new observation yet
            prior = computeMetricAt(obsDesc, 0, ind.metric);
          }
        }

        events.push({
          id: `fred-${spec.releaseId}-${ind.idSuffix}-${dateIso}`,
          ts,
          isoTime,
          title: ind.title,
          country: 'US',
          currency: 'USD',
          impact: ind.impact,
          prior,
          actual,
          source: 'fred'
        });
      }
    }
  }

  events.sort((a, b) => a.ts - b.ts || a.title.localeCompare(b.title));
  return events;
}

export async function getFredSnapshot(): Promise<FredSnapshot> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, events: [], fomcRatesDesc: [] };
  }

  const nowMs = Date.now();
  const needSchedule = releaseDatesCache.size === 0 || nowMs - scheduleCachedAt >= SCHEDULE_TTL_MS;
  const needObs = seriesObsCache.size === 0 || nowMs - obsCachedAt >= OBSERVATIONS_TTL_MS;

  if (needSchedule || needObs) {
    if (!inflight) {
      inflight = (async () => {
        if (needSchedule) await refreshSchedules(apiKey);
        if (needObs) await refreshObservations(apiKey);
        const nowSec = Math.floor(Date.now() / 1000);
        const fomcRatesDesc: FedFomcRatePoint[] = (seriesObsCache.get('DFEDTARU') ?? []).map((p) => ({
          date: p.date,
          rate: p.value
        }));
        return {
          ok: releaseDatesCache.size > 0,
          events: buildFredEvents(nowSec),
          fomcRatesDesc
        };
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const nowSec = Math.floor(nowMs / 1000);
  const fomcRatesDesc: FedFomcRatePoint[] = (seriesObsCache.get('DFEDTARU') ?? []).map((p) => ({
    date: p.date,
    rate: p.value
  }));
  return {
    ok: releaseDatesCache.size > 0,
    events: buildFredEvents(nowSec),
    fomcRatesDesc
  };
}
