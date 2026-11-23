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
  NAS100: 'NASDAQ:NDX',
  NDX: 'NASDAQ:NDX',
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
