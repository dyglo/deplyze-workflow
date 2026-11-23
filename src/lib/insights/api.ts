import type { EconomicEvent } from '../calendar/api';
import type { PlaybookEntry } from '../playbook/store';
import type { BiasDirection } from '../watchlist/store';
import { getApiBaseUrl } from '../workspace/storage';

export type MacroBias = 'tailwind' | 'headwind' | 'neutral';
export type AlignmentStatus = 'aligned' | 'conflict' | 'neutral';

export interface MacroMetric {
  id: string;
  label: string;
  value: string;
  delta: string;
  direction: 'up' | 'down' | 'flat';
  asOf?: string;
}

export interface SymbolMacroSummary {
  bias: MacroBias;
  reason: string;
}

export interface MacroRegimeResponse {
  riskMode: 'risk_on' | 'risk_off' | 'mixed';
  usdRegime: 'strong' | 'soft' | 'neutral';
  yieldsRegime: 'rising' | 'falling' | 'flat';
  summary: string;
  metrics: MacroMetric[];
  symbolBias: Record<string, SymbolMacroSummary>;
  updatedAt: string;
}

export interface SymbolDriver {
  label: string;
  value: string;
  delta: string;
  impact: 'bull' | 'bear' | 'neutral';
  note: string;
}

export interface InsightSource {
  title: string;
  url: string;
  publishedDate?: string;
}

export interface SymbolBriefResponse {
  symbol: string;
  shortName: string;
  fundamentalBias: MacroBias;
  alignment: AlignmentStatus;
  hasFreshCatalyst: boolean;
  headlineSummary: string;
  drivers: SymbolDriver[];
  primaryDriver: string;
  keyRisk: string;
  invalidationCatalyst: string;
  sources: InsightSource[];
  aiSynthesized: boolean;
  updatedAt: string;
}

export interface TransmissionMove {
  symbol: string;
  direction: 'up' | 'down';
}

export interface EventPlaybookResponse {
  title: string;
  country: string;
  category: string;
  consensusContext: string;
  recentTrend?: string;
  ifHot: TransmissionMove[];
  ifCold: TransmissionMove[];
  affectedSymbols: string[];
  watchNote: string;
  aiSynthesized: boolean;
  updatedAt: string;
}

export interface EdgeAuditResponse {
  trueEdge: {
    headline: string;
    detail: string;
  };
  primaryLeak: {
    headline: string;
    detail: string;
  };
  nextWeekRule: {
    rule: string;
    rationale: string;
  };
  analyzedCount: number;
  aiSynthesized: boolean;
  updatedAt: string;
}

export interface UpcomingEventRisk {
  event: EconomicEvent;
  minutesAway: number;
  level: 'danger' | 'caution' | 'watch';
  countdownLabel: string;
}

const REGIME_TTL_MS = 10 * 60 * 1000;
const SYMBOL_BRIEF_TTL_MS = 20 * 60 * 1000;
const EVENT_PLAYBOOK_TTL_MS = 60 * 60 * 1000;

let regimeCache: { data: MacroRegimeResponse; fetchedAt: number } | null = null;
let regimeInflight: Promise<MacroRegimeResponse> | null = null;
const symbolBriefCache = new Map<string, { data: SymbolBriefResponse; fetchedAt: number }>();
const eventPlaybookCache = new Map<string, { data: EventPlaybookResponse; fetchedAt: number }>();

export function normalizeShortSymbol(raw: string): string {
  const clean = (raw || '').trim().toUpperCase();
  const colon = clean.indexOf(':');
  const ticker = colon >= 0 ? clean.slice(colon + 1) : clean;
  if (ticker === 'GOLD') return 'XAUUSD';
  if (ticker === 'SILVER') return 'XAGUSD';
  if (ticker === 'NDX' || ticker === 'NAS100USD') return 'NAS100';
  if (ticker === 'US500') return 'SPX';
  if (ticker === 'DJI') return 'US30';
  if (ticker === 'WTI' || ticker === 'WTICOUSD' || ticker === 'OILUSD') return 'USOIL';
  return ticker || 'XAUUSD';
}

export function computeAlignment(
  fundamentalBias: MacroBias | undefined,
  techBias: BiasDirection | undefined
): AlignmentStatus {
  if (!fundamentalBias || fundamentalBias === 'neutral') return 'neutral';
  if (!techBias || techBias === 'none' || techBias === 'range') return 'neutral';
  if (techBias === 'bull') return fundamentalBias === 'tailwind' ? 'aligned' : 'conflict';
  if (techBias === 'bear') return fundamentalBias === 'headwind' ? 'aligned' : 'conflict';
  return 'neutral';
}

export function resolveMacroForSymbol(
  regime: MacroRegimeResponse | null,
  rawSymbol: string
): SymbolMacroSummary | null {
  if (!regime) return null;
  const sym = normalizeShortSymbol(rawSymbol);
  if (regime.symbolBias[sym]) return regime.symbolBias[sym];

  // Smart fallback by currency / asset class
  if (sym.startsWith('XAU') || sym.startsWith('XAG')) return regime.symbolBias.XAUUSD ?? null;
  if (sym.startsWith('BTC') || sym.startsWith('ETH') || sym.startsWith('SOL')) {
    return regime.symbolBias.BTCUSD ?? null;
  }
  if (sym.endsWith('JPY') && sym.length === 6) return regime.symbolBias.GBPJPY ?? null;
  if (sym.startsWith('USD') && sym.length === 6) return regime.symbolBias.USDJPY ?? null;
  if (sym.endsWith('USD') && sym.length === 6) return regime.symbolBias.EURUSD ?? null;
  if (sym.includes('OIL') || sym.includes('BRENT')) return regime.symbolBias.USOIL ?? null;
  return regime.symbolBias.SPX ?? null;
}

export function getCachedMacroRegime(): MacroRegimeResponse | null {
  if (regimeCache && Date.now() - regimeCache.fetchedAt < REGIME_TTL_MS) {
    return regimeCache.data;
  }
  return null;
}

export async function fetchMacroRegime(force = false): Promise<MacroRegimeResponse> {
  if (!force && regimeCache && Date.now() - regimeCache.fetchedAt < REGIME_TTL_MS) {
    return regimeCache.data;
  }
  if (!force && regimeInflight) {
    return regimeInflight;
  }

  const base = getApiBaseUrl();
  const url = `${base}/api/insights/regime${force ? '?force=1' : ''}`;
  const req = fetch(url, { headers: { Accept: 'application/json' } }).then(async (res) => {
    if (!res.ok) throw new Error(`Macro regime API returned HTTP ${res.status}`);
    const data = (await res.json()) as MacroRegimeResponse;
    regimeCache = { data, fetchedAt: Date.now() };
    regimeInflight = null;
    return data;
  });

  regimeInflight = req.catch((err) => {
    regimeInflight = null;
    throw err;
  });

  return regimeInflight;
}

export async function fetchSymbolBrief(
  symbol: string,
  techBias: BiasDirection,
  options?: { force?: boolean; signal?: AbortSignal }
): Promise<SymbolBriefResponse> {
  const shortName = normalizeShortSymbol(symbol);
  const cached = symbolBriefCache.get(shortName);
  if (!options?.force && cached && Date.now() - cached.fetchedAt < SYMBOL_BRIEF_TTL_MS) {
    return {
      ...cached.data,
      symbol,
      alignment: computeAlignment(cached.data.fundamentalBias, techBias)
    };
  }

  const base = getApiBaseUrl();
  const qs =
    `symbol=${encodeURIComponent(symbol)}` +
    `&bias=${encodeURIComponent(techBias)}` +
    (options?.force ? '&force=1' : '');
  const res = await fetch(`${base}/api/insights/symbol?${qs}`, {
    headers: { Accept: 'application/json' },
    signal: options?.signal
  });
  if (!res.ok) throw new Error(`Symbol brief API returned HTTP ${res.status}`);
  const data = (await res.json()) as SymbolBriefResponse;
  symbolBriefCache.set(shortName, { data, fetchedAt: Date.now() });
  return {
    ...data,
    alignment: computeAlignment(data.fundamentalBias, techBias)
  };
}

export async function fetchEventPlaybook(
  event: Pick<EconomicEvent, 'title' | 'country' | 'forecast' | 'prior' | 'actual'>,
  options?: { signal?: AbortSignal }
): Promise<EventPlaybookResponse> {
  const key = `${event.country}|${event.title.toLowerCase()}|${event.forecast ?? ''}|${event.prior ?? ''}|${event.actual ?? ''}`;
  const cached = eventPlaybookCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < EVENT_PLAYBOOK_TTL_MS) {
    return cached.data;
  }

  const base = getApiBaseUrl();
  const params = new URLSearchParams();
  params.set('title', event.title);
  params.set('country', event.country);
  if (event.forecast) params.set('forecast', event.forecast);
  if (event.prior) params.set('prior', event.prior);
  if (event.actual) params.set('actual', event.actual);

  const res = await fetch(`${base}/api/insights/event?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: options?.signal
  });
  if (!res.ok) throw new Error(`Event playbook API returned HTTP ${res.status}`);
  const data = (await res.json()) as EventPlaybookResponse;
  eventPlaybookCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

export async function fetchEdgeAudit(entries: PlaybookEntry[]): Promise<EdgeAuditResponse> {
  const base = getApiBaseUrl();
  const compact = entries.slice(0, 60).map((e) => ({
    symbol: e.symbol,
    setupType: e.setupType,
    grade: e.grade,
    outcome: e.outcome,
    rMultiple: e.rMultiple,
    date: e.date,
    title: e.title.slice(0, 80),
    notes: e.notes.slice(0, 260)
  }));

  const res = await fetch(`${base}/api/insights/edge-audit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ entries: compact })
  });

  if (!res.ok) {
    let msg = `Edge audit API returned HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) msg = errBody.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  return (await res.json()) as EdgeAuditResponse;
}

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  US: 'USD',
  EU: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  GB: 'GBP',
  UK: 'GBP',
  JP: 'JPY',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  CH: 'CHF',
  CN: 'CNY'
};

export function isSymbolExposedToCountry(rawSymbol: string, countryCode: string): boolean {
  const sym = normalizeShortSymbol(rawSymbol);
  const cc = (countryCode || '').toUpperCase();
  const ccy = COUNTRY_TO_CURRENCY[cc];
  if (!ccy) return false;

  if (ccy === 'USD') {
    return (
      sym === 'DXY' ||
      sym.includes('USD') ||
      sym === 'NAS100' ||
      sym === 'SPX' ||
      sym === 'US30' ||
      sym === 'USOIL' ||
      sym === 'NVDA' ||
      sym === 'AAPL' ||
      sym === 'TSLA'
    );
  }
  if (ccy === 'CNY') {
    return sym === 'AUDUSD' || sym === 'NZDUSD' || sym === 'USOIL' || sym === 'XAUUSD';
  }
  return sym.includes(ccy);
}

export function matchWatchlistExposure(
  affectedSymbols: string[],
  countryCode: string,
  watchlistShortNames: string[]
): string[] {
  const affectedSet = new Set(affectedSymbols.map((s) => normalizeShortSymbol(s)));
  const matched: string[] = [];
  const seen = new Set<string>();

  for (const raw of watchlistShortNames) {
    const norm = normalizeShortSymbol(raw);
    if (seen.has(norm)) continue;
    if (affectedSet.has(norm) || isSymbolExposedToCountry(norm, countryCode)) {
      seen.add(norm);
      matched.push(raw.toUpperCase());
    }
  }
  return matched;
}

export function formatMinutesCountdown(minutes: number): string {
  const mins = Math.max(1, Math.round(minutes));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function findNearestHighImpactForSymbol(
  eventsByDate: Record<string, EconomicEvent[]>,
  rawSymbol: string,
  horizonHours = 12
): UpcomingEventRisk | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const horizonSec = nowSec + horizonHours * 3600;
  let best: EconomicEvent | null = null;

  for (const list of Object.values(eventsByDate)) {
    for (const ev of list) {
      if (ev.impact !== 'high') continue;
      if (ev.ts < nowSec - 60 || ev.ts > horizonSec) continue;
      if (!isSymbolExposedToCountry(rawSymbol, ev.country)) continue;
      if (!best || ev.ts < best.ts) {
        best = ev;
      }
    }
  }

  if (!best) return null;
  const minutesAway = Math.max(1, Math.round((best.ts - nowSec) / 60));
  const level: 'danger' | 'caution' | 'watch' =
    minutesAway <= 30 ? 'danger' : minutesAway <= 90 ? 'caution' : 'watch';

  return {
    event: best,
    minutesAway,
    level,
    countdownLabel: formatMinutesCountdown(minutesAway)
  };
}
