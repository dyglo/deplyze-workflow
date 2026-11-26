import { fetchOandaSeries, isOandaConfigured, type OandaGranularity } from './oanda.js';

export interface QuotePerformance {
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
}

export type AutoBias = 'bull' | 'bear' | 'range';

export interface MarketQuote {
  symbol: string; // canonical requested symbol e.g. OANDA:XAUUSD
  shortName: string; // e.g. XAUUSD
  description: string;
  price: number;
  change: number;
  changePercent: number;
  type: string;
  performance: QuotePerformance;
  autoBias: AutoBias;
  biasScore: number | null; // -1 (strong bear) to +1 (strong bull)
  source: 'tv' | 'yahoo';
  updatedAt: string;
}

const TV_SCANNER_URL = 'https://scanner.tradingview.com/global/scan';
const QUOTE_TTL_MS = 10_000; // 10s live quote cache
const YAHOO_PERF_TTL_MS = 30 * 60 * 1000; // 30m historical perf cache
const FETCH_TIMEOUT_MS = 9_000;

interface CacheEntry {
  quote: MarketQuote;
  fetchedAt: number;
}

const quoteCache = new Map<string, CacheEntry>();
const yahooPerfCache = new Map<
  string,
  { perf: QuotePerformance; autoBias: AutoBias; biasScore: number; fetchedAt: number }
>();

function classifyBias(score: number | null): AutoBias {
  if (score == null || !Number.isFinite(score)) return 'range';
  if (score >= 0.15) return 'bull';
  if (score <= -0.15) return 'bear';
  return 'range';
}

function computeEma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeYahooBias(price: number, closes: number[]): { autoBias: AutoBias; biasScore: number } {
  const ema20 = computeEma(closes, 20);
  const ema50 = computeEma(closes, 50);
  if (ema20 == null || ema50 == null) {
    return { autoBias: 'range', biasScore: 0 };
  }
  let score = 0;
  if (price > ema20) score += 0.35;
  else if (price < ema20) score -= 0.35;
  if (price > ema50) score += 0.35;
  else if (price < ema50) score -= 0.35;
  if (ema20 > ema50) score += 0.3;
  else if (ema20 < ema50) score -= 0.3;
  return { autoBias: classifyBias(score), biasScore: Number(score.toFixed(2)) };
}

const TV_TICKER_OVERRIDES: Record<string, string> = {
  XAUUSD: 'OANDA:XAUUSD',
  GOLD: 'OANDA:XAUUSD',
  DXY: 'TVC:DXY',
  EURUSD: 'OANDA:EURUSD',
  GBPUSD: 'OANDA:GBPUSD',
  USDJPY: 'OANDA:USDJPY',
  AUDUSD: 'OANDA:AUDUSD',
  USDCAD: 'OANDA:USDCAD',
  USDCHF: 'OANDA:USDCHF',
  NZDUSD: 'OANDA:NZDUSD',
  GBPJPY: 'OANDA:GBPJPY',
  EURJPY: 'OANDA:EURJPY',
  EURGBP: 'OANDA:EURGBP',
  NAS100: 'NASDAQ:NDX',
  NDX: 'NASDAQ:NDX',
  VIX: 'TVC:VIX',
  US10Y: 'TVC:US10Y',
  BTCUSD: 'BITSTAMP:BTCUSD',
  ETHUSD: 'BITSTAMP:ETHUSD',
  'OANDA:NAS100USD': 'NASDAQ:NDX',
  'PEPPERSTONE:NAS100': 'NASDAQ:NDX'
};

const YAHOO_SYMBOL_MAP: Record<string, { yahoo: string; desc: string; type: string }> = {
  USOIL: { yahoo: 'CL=F', desc: 'WTI Crude Oil', type: 'commodity' },
  OILUSD: { yahoo: 'CL=F', desc: 'WTI Crude Oil / USD', type: 'commodity' },
  WTI: { yahoo: 'CL=F', desc: 'WTI Crude Oil', type: 'commodity' },
  WTICOUSD: { yahoo: 'CL=F', desc: 'WTI Crude Oil', type: 'commodity' },
  UKOIL: { yahoo: 'BZ=F', desc: 'Brent Crude Oil', type: 'commodity' },
  XAUUSD: { yahoo: 'GC=F', desc: 'Gold Spot / U.S. Dollar', type: 'commodity' },
  XAGUSD: { yahoo: 'SI=F', desc: 'Silver Spot / U.S. Dollar', type: 'commodity' },
  DXY: { yahoo: 'DX-Y.NYB', desc: 'U.S. Dollar Currency Index', type: 'index' },
  VIX: { yahoo: '^VIX', desc: 'CBOE Volatility Index', type: 'index' },
  US10Y: { yahoo: '^TNX', desc: 'US 10-Year Treasury Yield', type: 'bond' },
  SPX: { yahoo: '^GSPC', desc: 'S&P 500 Index', type: 'index' },
  US500: { yahoo: '^GSPC', desc: 'S&P 500 Index', type: 'index' },
  NAS100: { yahoo: '^NDX', desc: 'NASDAQ 100 Index', type: 'index' },
  NDX: { yahoo: '^NDX', desc: 'NASDAQ 100 Index', type: 'index' },
  US30: { yahoo: '^DJI', desc: 'Dow Jones Industrial Average', type: 'index' },
  EURUSD: { yahoo: 'EURUSD=X', desc: 'Euro / U.S. Dollar', type: 'forex' },
  GBPUSD: { yahoo: 'GBPUSD=X', desc: 'British Pound / U.S. Dollar', type: 'forex' },
  USDJPY: { yahoo: 'JPY=X', desc: 'U.S. Dollar / Japanese Yen', type: 'forex' },
  AUDUSD: { yahoo: 'AUDUSD=X', desc: 'Australian Dollar / U.S. Dollar', type: 'forex' },
  USDCAD: { yahoo: 'CAD=X', desc: 'U.S. Dollar / Canadian Dollar', type: 'forex' },
  USDCHF: { yahoo: 'CHF=X', desc: 'U.S. Dollar / Swiss Franc', type: 'forex' },
  NZDUSD: { yahoo: 'NZDUSD=X', desc: 'New Zealand Dollar / U.S. Dollar', type: 'forex' },
  GBPJPY: { yahoo: 'GBPJPY=X', desc: 'British Pound / Japanese Yen', type: 'forex' },
  EURJPY: { yahoo: 'EURJPY=X', desc: 'Euro / Japanese Yen', type: 'forex' },
  EURGBP: { yahoo: 'EURGBP=X', desc: 'Euro / British Pound', type: 'forex' },
  BTCUSD: { yahoo: 'BTC-USD', desc: 'Bitcoin / U.S. Dollar', type: 'crypto' },
  ETHUSD: { yahoo: 'ETH-USD', desc: 'Ethereum / U.S. Dollar', type: 'crypto' }
};

function shortTicker(full: string): string {
  const idx = full.indexOf(':');
  return (idx >= 0 ? full.slice(idx + 1) : full).toUpperCase().trim();
}

function toTvScannerTicker(raw: string): string {
  const upper = raw.toUpperCase().trim();
  if (TV_TICKER_OVERRIDES[upper]) return TV_TICKER_OVERRIDES[upper];
  const short = shortTicker(upper);
  if (upper.includes(':')) return upper;
  return TV_TICKER_OVERRIDES[short] ?? upper;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function fetchFromTvScanner(
  requests: { requested: string; tvTicker: string }[]
): Promise<Map<string, MarketQuote>> {
  const out = new Map<string, MarketQuote>();
  if (requests.length === 0) return out;

  const uniqueTvTickers = Array.from(new Set(requests.map((r) => r.tvTicker)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(TV_SCANNER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeplyzeWorkflow-API/0.1.4'
      },
      body: JSON.stringify({
        symbols: { tickers: uniqueTvTickers },
        columns: [
          'name',
          'description',
          'close',
          'change',
          'change_abs',
          'Perf.W',
          'Perf.1M',
          'Perf.3M',
          'Perf.6M',
          'Perf.YTD',
          'Perf.Y',
          'type',
          'Recommend.All',
          'Recommend.MA'
        ]
      }),
      signal: controller.signal
    });

    if (!res.ok) return out;

    const json = (await res.json()) as { data?: { s?: string; d?: unknown[] }[] };
    const byTvTicker = new Map<string, unknown[]>();
    for (const row of json.data ?? []) {
      if (row.s && Array.isArray(row.d)) {
        byTvTicker.set(row.s.toUpperCase(), row.d);
      }
    }

    const nowIso = new Date().toISOString();
    for (const reqItem of requests) {
      const cols = byTvTicker.get(reqItem.tvTicker.toUpperCase());
      if (!cols) continue;
      const price = numOrNull(cols[2]);
      if (price == null) continue;

      const changePercent = numOrNull(cols[3]) ?? 0;
      const change = numOrNull(cols[4]) ?? 0;
      const desc = typeof cols[1] === 'string' && cols[1].trim() ? cols[1].trim() : shortTicker(reqItem.requested);
      const type = typeof cols[11] === 'string' ? cols[11] : 'cfd';
      const recAll = numOrNull(cols[12]);
      const recMa = numOrNull(cols[13]);
      // Blend overall rating with HTF moving-average alignment
      const biasScore =
        recAll != null && recMa != null
          ? Number((recAll * 0.55 + recMa * 0.45).toFixed(2))
          : (recMa ?? recAll);

      out.set(reqItem.requested, {
        symbol: reqItem.requested,
        shortName: shortTicker(reqItem.requested),
        description: desc,
        price,
        change,
        changePercent,
        type,
        performance: {
          w1: numOrNull(cols[5]),
          m1: numOrNull(cols[6]),
          m3: numOrNull(cols[7]),
          m6: numOrNull(cols[8]),
          ytd: numOrNull(cols[9]),
          y1: numOrNull(cols[10])
        },
        autoBias: classifyBias(biasScore),
        biasScore,
        source: 'tv',
        updatedAt: nowIso
      });
    }
  } catch (err) {
    console.warn('[quotes:tv] scanner error:', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }

  return out;
}

function pctFrom(current: number, base: number | undefined): number | null {
  if (typeof base !== 'number' || !Number.isFinite(base) || base === 0) return null;
  return ((current - base) / base) * 100;
}

function findCloseOnOrBefore(
  timestamps: number[],
  closes: (number | null)[],
  targetSec: number
): number | undefined {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const val = closes[i];
    if (timestamps[i] <= targetSec && typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return undefined;
}

async function fetchFromYahoo(requested: string): Promise<MarketQuote | null> {
  const short = shortTicker(requested);
  const mapped = YAHOO_SYMBOL_MAP[short];
  const yahooSym = mapped?.yahoo ?? short;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const cachedPerf = yahooPerfCache.get(yahooSym);
    const needFullYear = !cachedPerf || Date.now() - cachedPerf.fetchedAt > YAHOO_PERF_TTL_MS;
    const range = needFullYear ? '1y' : '5d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=1d`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 DeplyzeWorkflow/0.1.4' },
      signal: controller.signal
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      chart?: {
        result?: {
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            longName?: string;
            shortName?: string;
          };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };

    const result = json.chart?.result?.[0];
    const meta = result?.meta;
    const price = numOrNull(meta?.regularMarketPrice);
    if (price == null) return null;

    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    // Previous trading day close
    const prevClose =
      numOrNull(meta?.previousClose) ??
      (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : numOrNull(meta?.chartPreviousClose)) ??
      price;

    const change = price - prevClose;
    const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    let perf: QuotePerformance = cachedPerf?.perf ?? {
      w1: null,
      m1: null,
      m3: null,
      m6: null,
      ytd: null,
      y1: null
    };
    let autoBias: AutoBias = cachedPerf?.autoBias ?? 'range';
    let biasScore: number | null = cachedPerf?.biasScore ?? null;

    if (needFullYear && timestamps.length > 5) {
      const nowSec = Math.floor(Date.now() / 1000);
      const yearStartSec = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
      perf = {
        w1: pctFrom(price, findCloseOnOrBefore(timestamps, closes, nowSec - 7 * 86400)),
        m1: pctFrom(price, findCloseOnOrBefore(timestamps, closes, nowSec - 30 * 86400)),
        m3: pctFrom(price, findCloseOnOrBefore(timestamps, closes, nowSec - 90 * 86400)),
        m6: pctFrom(price, findCloseOnOrBefore(timestamps, closes, nowSec - 180 * 86400)),
        ytd: pctFrom(price, findCloseOnOrBefore(timestamps, closes, yearStartSec)),
        y1: pctFrom(price, validCloses[0])
      };
      const computed = computeYahooBias(price, validCloses);
      autoBias = computed.autoBias;
      biasScore = computed.biasScore;
      yahooPerfCache.set(yahooSym, { perf, autoBias, biasScore, fetchedAt: Date.now() });
    }

    return {
      symbol: requested,
      shortName: short,
      description: mapped?.desc ?? meta?.shortName ?? meta?.longName ?? short,
      price,
      change,
      changePercent,
      type: mapped?.type ?? 'cfd',
      performance: perf,
      autoBias,
      biasScore,
      source: 'yahoo',
      updatedAt: new Date().toISOString()
    };
  } catch (err) {
    console.warn(`[quotes:yahoo] ${yahooSym} failed:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getQuotesPayload(rawSymbols: string[]): Promise<{
  quotes: Record<string, MarketQuote>;
  updatedAt: string;
}> {
  const cleaned = Array.from(
    new Set(
      rawSymbols
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 40)
    )
  ).slice(0, 40);

  const nowMs = Date.now();
  const quotes: Record<string, MarketQuote> = {};
  const stale: string[] = [];

  for (const sym of cleaned) {
    const cached = quoteCache.get(sym);
    if (cached && nowMs - cached.fetchedAt < QUOTE_TTL_MS) {
      quotes[sym] = cached.quote;
    } else {
      stale.push(sym);
    }
  }

  if (stale.length > 0) {
    const tvRequests = stale.map((sym) => ({
      requested: sym,
      tvTicker: toTvScannerTicker(sym)
    }));
    const tvResults = await fetchFromTvScanner(tvRequests);

    const missing: string[] = [];
    for (const sym of stale) {
      const q = tvResults.get(sym);
      if (q) {
        quoteCache.set(sym, { quote: q, fetchedAt: nowMs });
        quotes[sym] = q;
      } else {
        missing.push(sym);
      }
    }

    if (missing.length > 0) {
      const yahooResults = await Promise.all(missing.map((sym) => fetchFromYahoo(sym)));
      for (let i = 0; i < missing.length; i++) {
        const sym = missing[i];
        const q = yahooResults[i];
        if (q) {
          quoteCache.set(sym, { quote: q, fetchedAt: nowMs });
          quotes[sym] = q;
        } else {
          // Serve slightly stale cache if upstream temporarily failed
          const fallback = quoteCache.get(sym);
          if (fallback) quotes[sym] = fallback.quote;
        }
      }
    }
  }

  return { quotes, updatedAt: new Date().toISOString() };
}

export interface SymbolSparkline {
  symbol: string;
  shortName: string;
  description: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  points: number[];
  periodLabel: string;
  updatedAt: string;
}

const SPARKLINE_TTL_MS = 5 * 60 * 1000; // 5m intraday sparkline cache
const sparklineCache = new Map<string, { data: SymbolSparkline; fetchedAt: number }>();

function guessCurrency(short: string): string {
  const s = short.toUpperCase();
  if (s === 'DXY' || s === 'VIX' || s === 'US10Y') return '';
  if (s.length === 6 && /^[A-Z]{6}$/.test(s) && !s.startsWith('XAU') && !s.startsWith('XAG')) {
    return s.slice(3, 6);
  }
  return 'USD';
}

export async function getSparklinePayload(rawSymbol: string): Promise<SymbolSparkline> {
  const requested = rawSymbol.trim() || 'OANDA:XAUUSD';
  const short = shortTicker(requested);
  const nowMs = Date.now();

  const cached = sparklineCache.get(short);
  if (cached && nowMs - cached.fetchedAt < SPARKLINE_TTL_MS) {
    return { ...cached.data, symbol: requested };
  }

  const mapped = YAHOO_SYMBOL_MAP[short];
  const yahooSym = mapped?.yahoo ?? short;

  const [quoteRes, chartPoints] = await Promise.all([
    getQuotesPayload([requested]),
    (async (): Promise<{ points: number[]; periodLabel: string; currency?: string }> => {
      const tryFetch = async (range: string, interval: string): Promise<{ points: number[]; currency?: string } | null> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 DeplyzeWorkflow/0.1.12' },
            signal: controller.signal
          });
          if (!res.ok) return null;
          const json = (await res.json()) as {
            chart?: {
              result?: {
                meta?: { currency?: string };
                indicators?: { quote?: { close?: (number | null)[] }[] };
              }[];
            };
          };
          const r = json.chart?.result?.[0];
          const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter(
            (v): v is number => typeof v === 'number' && Number.isFinite(v)
          );
          if (closes.length < 4) return null;
          // Downsample to ~48 points max for crisp lightweight SVG rendering
          const maxPts = 48;
          const sampled: number[] = [];
          if (closes.length <= maxPts) {
            sampled.push(...closes);
          } else {
            for (let i = 0; i < maxPts; i++) {
              const idx = Math.round((i / (maxPts - 1)) * (closes.length - 1));
              sampled.push(closes[idx]);
            }
          }
          return { points: sampled, currency: r?.meta?.currency };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };

      const d1 = await tryFetch('1d', '15m');
      if (d1) return { points: d1.points, periodLabel: '1 day', currency: d1.currency };
      const d5 = await tryFetch('5d', '1h');
      if (d5) return { points: d5.points, periodLabel: '5 days', currency: d5.currency };
      return { points: [], periodLabel: '1 day' };
    })()
  ]);

  const quote = quoteRes.quotes[requested];
  const data: SymbolSparkline = {
    symbol: requested,
    shortName: quote?.shortName ?? short,
    description: quote?.description ?? mapped?.desc ?? short,
    price: quote?.price ?? (chartPoints.points.length > 0 ? chartPoints.points[chartPoints.points.length - 1] : null),
    change: quote?.change ?? null,
    changePercent: quote?.changePercent ?? null,
    currency: chartPoints.currency || guessCurrency(short),
    points: chartPoints.points,
    periodLabel: chartPoints.periodLabel,
    updatedAt: new Date(nowMs).toISOString()
  };

  sparklineCache.set(short, { data, fetchedAt: nowMs });
  if (sparklineCache.size > 60) {
    const oldest = sparklineCache.keys().next().value;
    if (oldest) sparklineCache.delete(oldest);
  }

  return data;
}

export interface HistoricalBar {
  ts: number; // Unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface HistoricalBarsPayload {
  symbol: string;
  shortName: string;
  interval: string;
  bars: HistoricalBar[];
  source: 'oanda' | 'yahoo';
  updatedAt: string;
}

const BARS_TTL_MS = 60_000;
const barsCache = new Map<string, { data: HistoricalBarsPayload; fetchedAt: number }>();

export async function getHistoricalBarsPayload(
  rawSymbol: string,
  fromSecRaw?: number | null,
  chartIntervalRaw?: string | null
): Promise<HistoricalBarsPayload> {
  const requested = rawSymbol.trim() || 'OANDA:XAUUSD';
  const short = shortTicker(requested);
  const nowSec = Math.floor(Date.now() / 1000);
  const maxLookbackSec = 30 * 86_400;

  // When chartIntervalRaw is provided (for chart Y-axis visible range alignment),
  // map the active TradingView timeframe to the matching Yahoo interval & window.
  let plan: { range: string; interval: string; padSec: number; maxBars?: number };
  let fromSec: number;

  if (chartIntervalRaw && chartIntervalRaw.trim()) {
    const iv = chartIntervalRaw.trim().toUpperCase();
    if (iv === '1' || iv === '1M') {
      plan = { range: '1d', interval: '1m', padSec: 60, maxBars: 115 };
    } else if (iv === '3' || iv === '3M' || iv === '5' || iv === '5M') {
      plan = { range: '5d', interval: '5m', padSec: 300, maxBars: 115 };
    } else if (iv === '15' || iv === '15M') {
      plan = { range: '5d', interval: '15m', padSec: 900, maxBars: 115 };
    } else if (iv === '30' || iv === '30M') {
      plan = { range: '5d', interval: '30m', padSec: 1800, maxBars: 115 };
    } else if (iv === '60' || iv === '1H' || iv === '120' || iv === '2H') {
      plan = { range: '1mo', interval: '1h', padSec: 3600, maxBars: 115 };
    } else if (iv === '240' || iv === '4H') {
      plan = { range: '3mo', interval: '1h', padSec: 3600, maxBars: 440 };
    } else if (iv === 'W' || iv === '1W' || iv === 'M') {
      plan = { range: '2y', interval: '1wk', padSec: 86_400 * 7, maxBars: 115 };
    } else {
      plan = { range: '6mo', interval: '1d', padSec: 86_400, maxBars: 115 };
    }
    fromSec = 0;
  } else {
    fromSec =
      typeof fromSecRaw === 'number' && Number.isFinite(fromSecRaw) && fromSecRaw > 0
        ? Math.max(nowSec - maxLookbackSec, Math.min(nowSec, Math.floor(fromSecRaw)))
        : nowSec - 86_400;

    const spanSec = Math.max(60, nowSec - fromSec);
    plan =
      spanSec <= 20 * 3600
        ? { range: '1d', interval: '5m', padSec: 300 }
        : spanSec <= 5 * 86_400
          ? { range: '5d', interval: '15m', padSec: 900 }
          : { range: '1mo', interval: '1h', padSec: 3600 };
  }

  const cacheKey = `${short}:${plan.range}:${plan.interval}:${plan.maxBars ?? Math.floor(fromSec / 300)}`;
  const cached = barsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < BARS_TTL_MS) {
    return { ...cached.data, symbol: requested };
  }

  const mapped = YAHOO_SYMBOL_MAP[short];
  const yahooSym = mapped?.yahoo ?? short;

  const fetchBars = async (range: string, interval: string): Promise<HistoricalBar[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}&includePrePost=true`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 DeplyzeWorkflow/0.1.14' },
        signal: controller.signal
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        chart?: {
          result?: {
            timestamp?: number[];
            indicators?: {
              quote?: {
                open?: (number | null)[];
                high?: (number | null)[];
                low?: (number | null)[];
                close?: (number | null)[];
              }[];
            };
          }[];
        };
      };
      const r = json.chart?.result?.[0];
      const tsArr = r?.timestamp ?? [];
      const q = r?.indicators?.quote?.[0];
      const opens = q?.open ?? [];
      const highs = q?.high ?? [];
      const lows = q?.low ?? [];
      const closes = q?.close ?? [];

      const out: HistoricalBar[] = [];
      for (let i = 0; i < tsArr.length; i++) {
        const ts = tsArr[i];
        const o = opens[i];
        const h = highs[i];
        const l = lows[i];
        const c = closes[i];
        if (
          typeof ts !== 'number' ||
          typeof o !== 'number' ||
          typeof h !== 'number' ||
          typeof l !== 'number' ||
          typeof c !== 'number' ||
          !Number.isFinite(o) ||
          !Number.isFinite(h) ||
          !Number.isFinite(l) ||
          !Number.isFinite(c)
        ) {
          continue;
        }
        if (ts >= fromSec - plan.padSec) {
          out.push({
            ts,
            open: o,
            high: Math.max(h, o, c),
            low: Math.min(l, o, c),
            close: c
          });
        }
      }
      out.sort((a, b) => a.ts - b.ts);
      if (plan.maxBars && out.length > plan.maxBars) {
        return out.slice(out.length - plan.maxBars);
      }
      return out;
    } catch (err) {
      console.warn(`[quotes:bars] ${yahooSym} failed:`, (err as Error).message);
      return [];
    } finally {
      clearTimeout(timer);
    }
  };

  // Prefer native OANDA v20 candles when configured so chart overlays & Scorecard grading match OANDA wicks
  if (isOandaConfigured()) {
    const oandaGran: OandaGranularity | null =
      plan.interval === '5m'
        ? 'M5'
        : plan.interval === '15m'
          ? 'M15'
          : plan.interval === '30m'
            ? 'M30'
            : plan.interval === '1h'
              ? 'H1'
              : plan.interval === '1d'
                ? 'D'
                : null;
    if (oandaGran) {
      const wantCount = plan.maxBars ? Math.min(440, plan.maxBars + 10) : 260;
      const oandaRes = await fetchOandaSeries(short, oandaGran, wantCount, false);
      if (oandaRes && oandaRes.bars.length > 0) {
        let filtered: HistoricalBar[] = oandaRes.bars
          .filter((b) => b.ts >= fromSec - plan.padSec)
          .map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
        if (plan.maxBars && filtered.length > plan.maxBars) {
          filtered = filtered.slice(filtered.length - plan.maxBars);
        }
        if (filtered.length > 0) {
          const data: HistoricalBarsPayload = {
            symbol: requested,
            shortName: short,
            interval: plan.interval,
            bars: filtered,
            source: 'oanda',
            updatedAt: new Date().toISOString()
          };
          barsCache.set(cacheKey, { data, fetchedAt: Date.now() });
          return data;
        }
      }
    }
  }

  let bars = await fetchBars(plan.range, plan.interval);
  let usedInterval = plan.interval;
  if (bars.length === 0 && plan.range === '1d') {
    bars = await fetchBars('5d', '15m');
    usedInterval = '15m';
  }

  const data: HistoricalBarsPayload = {
    symbol: requested,
    shortName: short,
    interval: usedInterval,
    bars,
    source: 'yahoo',
    updatedAt: new Date().toISOString()
  };

  barsCache.set(cacheKey, { data, fetchedAt: Date.now() });
  if (barsCache.size > 60) {
    const oldest = barsCache.keys().next().value;
    if (oldest) barsCache.delete(oldest);
  }
  return data;
}

export async function dispatchAlertWebhook(
  urlStr: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status?: number; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: 'Invalid webhook URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Webhook URL must use https://' };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host.endsWith('.local')
  ) {
    return { ok: false, error: 'Private network webhook targets are not permitted' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(parsed.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeplyzeWorkflow-Alerts/0.1.4'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
