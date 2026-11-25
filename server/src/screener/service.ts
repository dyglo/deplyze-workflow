import { getQuotesPayload } from '../quotes/service.js';

export type TechRatingLabel = 'Strong buy' | 'Buy' | 'Neutral' | 'Sell' | 'Strong sell';

export interface ScreenerRowData {
  symbol: string;
  shortName: string;
  description: string;
  price: number;
  change: number;
  changePercent: number; // 1D %
  change1h: number | null;
  change4h: number | null;
  perfW: number | null;
  perf1M: number | null;
  perf3M: number | null;
  perf6M: number | null;
  perfYTD: number | null;
  perf1Y: number | null;
  recommendAll: number | null; // -1..+1
  recommendMA: number | null;
  recommendOsc: number | null;
  rating: TechRatingLabel;
  maRating: TechRatingLabel;
  oscRating: TechRatingLabel;
  rsi14: number | null;
  adx14: number | null;
  atr14: number | null;
  volatilityD: number | null; // %
  high: number | null;
  low: number | null;
  rangePosPct: number | null; // 0..100 inside today's low..high
  relVolume: number | null;
  volume: number | null;
  type: string;
  source: 'tv' | 'yahoo';
  updatedAt: string;
}

export interface ScreenerPayload {
  rows: ScreenerRowData[];
  updatedAt: string;
}

const TV_SCANNER_URL = 'https://scanner.tradingview.com/global/scan';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  row: ScreenerRowData;
  fetchedAt: number;
}

const rowCache = new Map<string, CacheEntry>();

const TV_TICKER_MAP: Record<string, string> = {
  XAUUSD: 'OANDA:XAUUSD',
  GOLD: 'OANDA:XAUUSD',
  XAGUSD: 'OANDA:XAGUSD',
  USOIL: 'TVC:USOIL',
  UKOIL: 'TVC:UKOIL',
  NATGAS: 'FX:NATGAS',
  COPPER: 'OANDA:XCUUSD',
  DXY: 'TVC:DXY',
  VIX: 'TVC:VIX',
  US10Y: 'TVC:US10Y',
  NAS100: 'NASDAQ:NDX',
  NDX: 'NASDAQ:NDX',
  SPX: 'TVC:SPX',
  US30: 'TVC:DJI',
  GER40: 'TVC:DEU40',
  UK100: 'TVC:UKX',
  JP225: 'TVC:NI225',
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
  AUDJPY: 'OANDA:AUDJPY',
  CADJPY: 'OANDA:CADJPY',
  EURAUD: 'OANDA:EURAUD',
  GBPAUD: 'OANDA:GBPAUD',
  BTCUSD: 'BITSTAMP:BTCUSD',
  ETHUSD: 'BITSTAMP:ETHUSD',
  SOLUSD: 'BINANCE:SOLUSDT',
  XRPUSD: 'BITSTAMP:XRPUSD',
  BNBUSD: 'BINANCE:BNBUSDT',
  DOGEUSD: 'BINANCE:DOGEUSDT',
  LINKUSD: 'BINANCE:LINKUSDT',
  AVAXUSD: 'BINANCE:AVAXUSDT'
};

function shortTicker(raw: string): string {
  const idx = raw.indexOf(':');
  return (idx >= 0 ? raw.slice(idx + 1) : raw).toUpperCase().trim();
}

function resolveTvTicker(raw: string): string {
  const upper = raw.toUpperCase().trim();
  if (TV_TICKER_MAP[upper]) return TV_TICKER_MAP[upper];
  if (upper.includes(':')) return upper;
  return TV_TICKER_MAP[shortTicker(upper)] ?? upper;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function scoreToRating(score: number | null): TechRatingLabel {
  if (score === null) return 'Neutral';
  if (score >= 0.5) return 'Strong buy';
  if (score >= 0.1) return 'Buy';
  if (score <= -0.5) return 'Strong sell';
  if (score <= -0.1) return 'Sell';
  return 'Neutral';
}

const SCANNER_COLUMNS = [
  'name', // 0
  'description', // 1
  'close', // 2
  'change', // 3 (1D %)
  'change_abs', // 4
  'change|60', // 5 (1H %)
  'change|240', // 6 (4H %)
  'Perf.W', // 7
  'Perf.1M', // 8
  'Perf.3M', // 9
  'Perf.6M', // 10
  'Perf.YTD', // 11
  'Perf.Y', // 12
  'Recommend.All', // 13
  'Recommend.MA', // 14
  'Recommend.Other', // 15
  'RSI', // 16
  'ADX', // 17
  'ATR', // 18
  'Volatility.D', // 19
  'high', // 20
  'low', // 21
  'relative_volume_10d_calc', // 22
  'volume', // 23
  'type' // 24
];

async function fetchBatchFromTv(
  requests: { requested: string; tvTicker: string }[]
): Promise<Map<string, ScreenerRowData>> {
  const out = new Map<string, ScreenerRowData>();
  if (requests.length === 0) return out;

  const tickers = Array.from(new Set(requests.map((r) => r.tvTicker)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(TV_SCANNER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeplyzeWorkflow-Screener/0.1.16'
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: SCANNER_COLUMNS
      }),
      signal: controller.signal
    });

    if (!res.ok) return out;

    const json = (await res.json()) as { data?: { s?: string; d?: unknown[] }[] };
    const byTicker = new Map<string, unknown[]>();
    for (const item of json.data ?? []) {
      if (item.s && Array.isArray(item.d)) {
        byTicker.set(item.s.toUpperCase(), item.d);
      }
    }

    const nowIso = new Date().toISOString();
    for (const reqItem of requests) {
      const d = byTicker.get(reqItem.tvTicker.toUpperCase());
      if (!d) continue;
      const price = numOrNull(d[2]);
      if (price === null) continue;

      const changePercent = numOrNull(d[3]) ?? 0;
      const change = numOrNull(d[4]) ?? 0;
      const high = numOrNull(d[20]);
      const low = numOrNull(d[21]);
      let rangePosPct: number | null = null;
      if (high !== null && low !== null && high > low) {
        rangePosPct = Math.round(Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100)));
      }

      const recAll = numOrNull(d[13]);
      const recMa = numOrNull(d[14]);
      const recOsc = numOrNull(d[15]);
      const desc =
        typeof d[1] === 'string' && d[1].trim()
          ? d[1].trim()
          : shortTicker(reqItem.requested);

      out.set(reqItem.requested, {
        symbol: reqItem.requested,
        shortName: shortTicker(reqItem.requested),
        description: desc,
        price,
        change,
        changePercent,
        change1h: numOrNull(d[5]),
        change4h: numOrNull(d[6]),
        perfW: numOrNull(d[7]),
        perf1M: numOrNull(d[8]),
        perf3M: numOrNull(d[9]),
        perf6M: numOrNull(d[10]),
        perfYTD: numOrNull(d[11]),
        perf1Y: numOrNull(d[12]),
        recommendAll: recAll,
        recommendMA: recMa,
        recommendOsc: recOsc,
        rating: scoreToRating(recAll),
        maRating: scoreToRating(recMa),
        oscRating: scoreToRating(recOsc),
        rsi14: numOrNull(d[16]),
        adx14: numOrNull(d[17]),
        atr14: numOrNull(d[18]),
        volatilityD: numOrNull(d[19]),
        high,
        low,
        rangePosPct,
        relVolume: numOrNull(d[22]),
        volume: numOrNull(d[23]),
        type: typeof d[24] === 'string' ? d[24] : 'cfd',
        source: 'tv',
        updatedAt: nowIso
      });
    }
  } catch (err) {
    console.warn('[screener:tv] batch scan error:', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }

  return out;
}

export async function getScreenerPayload(
  rawSymbols: string[],
  force = false
): Promise<ScreenerPayload> {
  const cleaned = Array.from(
    new Set(
      rawSymbols
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 44)
    )
  ).slice(0, 80);

  const nowMs = Date.now();
  const resultMap = new Map<string, ScreenerRowData>();
  const stale: string[] = [];

  for (const sym of cleaned) {
    const cached = rowCache.get(sym);
    if (!force && cached && nowMs - cached.fetchedAt < CACHE_TTL_MS) {
      resultMap.set(sym, cached.row);
    } else {
      stale.push(sym);
    }
  }

  if (stale.length > 0) {
    const reqs = stale.map((sym) => ({
      requested: sym,
      tvTicker: resolveTvTicker(sym)
    }));
    const tvRows = await fetchBatchFromTv(reqs);

    const missing: string[] = [];
    for (const sym of stale) {
      const row = tvRows.get(sym);
      if (row) {
        rowCache.set(sym, { row, fetchedAt: nowMs });
        resultMap.set(sym, row);
      } else {
        missing.push(sym);
      }
    }

    // Fallback to existing quotes service (Yahoo) for any unmapped symbols
    if (missing.length > 0) {
      try {
        const fallback = await getQuotesPayload(missing);
        for (const sym of missing) {
          const q = fallback.quotes[sym];
          if (!q) continue;
          const row: ScreenerRowData = {
            symbol: sym,
            shortName: q.shortName,
            description: q.description,
            price: q.price,
            change: q.change,
            changePercent: q.changePercent,
            change1h: null,
            change4h: null,
            perfW: q.performance.w1,
            perf1M: q.performance.m1,
            perf3M: q.performance.m3,
            perf6M: q.performance.m6,
            perfYTD: q.performance.ytd,
            perf1Y: q.performance.y1,
            recommendAll: q.biasScore,
            recommendMA: q.biasScore,
            recommendOsc: null,
            rating: scoreToRating(q.biasScore),
            maRating: scoreToRating(q.biasScore),
            oscRating: 'Neutral',
            rsi14: null,
            adx14: null,
            atr14: null,
            volatilityD: null,
            high: null,
            low: null,
            rangePosPct: null,
            relVolume: null,
            volume: null,
            type: q.type,
            source: 'yahoo',
            updatedAt: q.updatedAt
          };
          rowCache.set(sym, { row, fetchedAt: nowMs });
          resultMap.set(sym, row);
        }
      } catch {
        // non-fatal
      }
    }
  }

  const rows: ScreenerRowData[] = [];
  for (const sym of cleaned) {
    const row = resultMap.get(sym) ?? rowCache.get(sym)?.row;
    if (row) rows.push(row);
  }

  return {
    rows,
    updatedAt: new Date().toISOString()
  };
}
