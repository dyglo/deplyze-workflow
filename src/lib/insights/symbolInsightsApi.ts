import { getApiBaseUrl } from '../workspace/storage';

export type InsightsViewId = 'technicals' | 'seasonals' | 'news' | 'volatility';

export type TechnicalsInterval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '1D'
  | '1W'
  | '1M';

export type SignalAction = 'Buy' | 'Neutral' | 'Sell';
export type RatingLabel = 'Strong sell' | 'Sell' | 'Neutral' | 'Buy' | 'Strong buy';

export interface GaugeSummary {
  score: number;
  rating: RatingLabel;
  sell: number;
  neutral: number;
  buy: number;
}

export interface IndicatorRow {
  name: string;
  value: number | null;
  action: SignalAction;
}

export interface PivotRow {
  method: 'Classic' | 'Fibonacci' | 'Camarilla' | 'Woodie' | 'DM';
  s3: number | null;
  s2: number | null;
  s1: number | null;
  p: number | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
}

export interface MtfOverviewRow {
  interval: TechnicalsInterval;
  label: string;
  summaryScore: number | null;
  summaryRating: RatingLabel;
  oscillatorsRating: RatingLabel;
  movingAveragesRating: RatingLabel;
}

export interface SymbolTechnicalsPayload {
  symbol: string;
  shortName: string;
  description: string;
  resolvedTicker: string;
  interval: TechnicalsInterval;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  atr: number | null;
  summary: GaugeSummary;
  oscillatorsGauge: GaugeSummary;
  movingAveragesGauge: GaugeSummary;
  oscillators: IndicatorRow[];
  movingAverages: IndicatorRow[];
  pivots: PivotRow[];
  mtfOverview: MtfOverviewRow[];
  source: 'tv' | 'yahoo-fallback';
  updatedAt: string;
}

export interface SeasonalDayPoint {
  doy: number;
  pct: number;
  abs: number;
  idx: number;
  close: number;
}

export interface SeasonalYearSeries {
  year: number;
  startPrice: number;
  endPrice: number;
  totalPct: number;
  totalAbs: number;
  points: SeasonalDayPoint[];
  months: (number | null)[];
}

export interface DayOfWeekStat {
  day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri';
  avgReturnPct: number;
  winRatePct: number;
  avgRangePct: number;
  samples: number;
}

export interface SwingLevel {
  label: string;
  price: number;
  distancePct: number;
  kind: 'resistance' | 'support' | 'reference';
}

export interface VolatilityProfile {
  lastPrice: number;
  atr14: number | null;
  atr14Pct: number | null;
  adr20: number | null;
  adr20Pct: number | null;
  todayRange: number | null;
  todayRangePctOfAdr: number | null;
  week52High: number | null;
  week52Low: number | null;
  week52PositionPct: number | null;
  dayOfWeek1Y: DayOfWeekStat[];
  dayOfWeek5Y: DayOfWeekStat[];
  swingLevels: SwingLevel[];
}

export interface SymbolSeasonalsPayload {
  symbol: string;
  shortName: string;
  description: string;
  currency: string;
  minYear: number;
  maxYear: number;
  currentYear: number;
  years: SeasonalYearSeries[];
  volatility: VolatilityProfile | null;
  updatedAt: string;
}

export const PRIMARY_TIMEFRAMES: { id: TechnicalsInterval; label: string }[] = [
  { id: '1m', label: '1 minute' },
  { id: '5m', label: '5 minutes' },
  { id: '15m', label: '15 minutes' },
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: '2h', label: '2 hours' },
  { id: '4h', label: '4 hours' },
  { id: '1D', label: '1 day' }
];

export const MORE_TIMEFRAMES: { id: TechnicalsInterval; label: string }[] = [
  { id: '1W', label: '1 week' },
  { id: '1M', label: '1 month' }
];

const TECH_CLIENT_TTL_MS = 20_000;
const SEASONALS_CLIENT_TTL_MS = 30 * 60 * 1000;

const techClientCache = new Map<string, { data: SymbolTechnicalsPayload; fetchedAt: number }>();
const seasonalsClientCache = new Map<string, { data: SymbolSeasonalsPayload; fetchedAt: number }>();

export async function fetchSymbolTechnicals(
  symbol: string,
  interval: TechnicalsInterval,
  signal?: AbortSignal,
  force = false
): Promise<SymbolTechnicalsPayload> {
  const key = `${symbol.trim().toUpperCase()}|${interval}`;
  const cached = techClientCache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < TECH_CLIENT_TTL_MS) {
    return cached.data;
  }

  const url = `${getApiBaseUrl()}/api/insights/technicals?symbol=${encodeURIComponent(
    symbol
  )}&interval=${encodeURIComponent(interval)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!res.ok) {
    throw new Error(`Technicals API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as SymbolTechnicalsPayload;
  techClientCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

export async function fetchSymbolSeasonals(
  symbol: string,
  signal?: AbortSignal,
  force = false
): Promise<SymbolSeasonalsPayload> {
  const key = symbol.trim().toUpperCase();
  const cached = seasonalsClientCache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < SEASONALS_CLIENT_TTL_MS) {
    return cached.data;
  }

  const url = `${getApiBaseUrl()}/api/insights/seasonals?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!res.ok) {
    throw new Error(`Seasonals API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as SymbolSeasonalsPayload;
  seasonalsClientCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

export function formatIndicatorNumber(value: number | null, shortName = ''): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const upper = shortName.toUpperCase();
  let digits = 2;
  if (
    abs > 0 &&
    abs < 5 &&
    /^(EUR|GBP|AUD|NZD|USD)(USD|CAD|CHF|GBP|AUD|NZD)$/.test(upper) &&
    !upper.includes('JPY')
  ) {
    digits = 5;
  } else if (abs > 0 && abs < 10) {
    digits = 4;
  } else if (upper.includes('XAU') || upper.includes('JPY') || upper.includes('DXY')) {
    digits = abs > 100 ? 2 : 3;
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}
