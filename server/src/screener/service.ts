import {
  fetchOandaBatchPricing,
  fetchOandaPositionBook,
  fetchOandaSeries,
  fetchOandaSyntheticDxy,
  hasOandaPositionBook,
  isOandaConfigured,
  resolveOandaInstrument,
  type OandaBar,
  type OandaCrowdSkew,
  type OandaLivePricing,
  type OandaPositionBookSummary,
  type OandaSeriesResult
} from '../quotes/oanda.js';
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
  spreadPct?: number | null;
  spreadAtrPct?: number | null;
  spreadRatio?: number | null;
  wideSpread?: boolean;
  crowdLongPct?: number | null;
  crowdShortPct?: number | null;
  trappedLongPct?: number | null;
  trappedShortPct?: number | null;
  crowdSkew?: OandaCrowdSkew | null;
  type: string;
  source: 'oanda' | 'tv' | 'yahoo';
  updatedAt: string;
}

export interface ScreenerPayload {
  rows: ScreenerRowData[];
  oandaActive: boolean;
  updatedAt: string;
}

const TV_SCANNER_URL = 'https://scanner.tradingview.com/global/scan';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15_000;
const OANDA_CONCURRENCY = 6;

interface CacheEntry {
  row: ScreenerRowData;
  fetchedAt: number;
}

const rowCache = new Map<string, CacheEntry>();

// Fixed TradingView Scanner tickers so 0 universe symbols drop to empty rows
const TV_TICKER_MAP: Record<string, string> = {
  XAUUSD: 'OANDA:XAUUSD',
  GOLD: 'OANDA:XAUUSD',
  XAGUSD: 'TVC:SILVER',
  SILVER: 'TVC:SILVER',
  USOIL: 'FX:USOIL',
  WTI: 'FX:USOIL',
  UKOIL: 'FX:UKOIL',
  BRENT: 'FX:UKOIL',
  NATGAS: 'NYMEX:NG1!',
  COPPER: 'OANDA:XCUUSD',
  XCUUSD: 'OANDA:XCUUSD',
  DXY: 'TVC:DXY',
  VIX: 'TVC:VIX',
  US10Y: 'TVC:US10Y',
  NAS100: 'NASDAQ:NDX',
  NDX: 'NASDAQ:NDX',
  SPX: 'SP:SPX',
  US500: 'SP:SPX',
  US30: 'DJ:DJI',
  DJI: 'DJ:DJI',
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

// Map canonical/requested TradingView prefixes whose global/scan symbols differ
const TV_FULL_SYMBOL_OVERRIDES: Record<string, string> = {
  'OANDA:XAGUSD': 'TVC:SILVER',
  'TVC:USOIL': 'FX:USOIL',
  'TVC:UKOIL': 'FX:UKOIL',
  'FX:NATGAS': 'NYMEX:NG1!',
  'TVC:SPX': 'SP:SPX',
  'TVC:DJI': 'DJ:DJI'
};

function shortTicker(raw: string): string {
  const idx = raw.indexOf(':');
  return (idx >= 0 ? raw.slice(idx + 1) : raw).toUpperCase().trim();
}

function resolveTvTicker(raw: string): string {
  const upper = raw.toUpperCase().trim();
  if (TV_FULL_SYMBOL_OVERRIDES[upper]) return TV_FULL_SYMBOL_OVERRIDES[upper];
  if (TV_TICKER_MAP[upper]) return TV_TICKER_MAP[upper];
  if (upper.includes(':')) return upper;
  return TV_TICKER_MAP[shortTicker(upper)] ?? upper;
}

function isOandaEligible(sym: string): boolean {
  const short = shortTicker(sym);
  if (short === 'DXY') return true;
  return resolveOandaInstrument(short) !== null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function scoreToRating(score: number | null): TechRatingLabel {
  if (score === null) return 'Neutral';
  if (score >= 0.5) return 'Strong buy';
  if (score >= 0.1) return 'Buy';
  if (score <= -0.5) return 'Strong sell';
  if (score <= -0.1) return 'Sell';
  return 'Neutral';
}

// ── Quantitative Technical Indicator Engine (Pure, Deterministic, Wilder-Standard) ──

function computeEmaSeries(values: number[], period: number): number[] {
  if (values.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  const out = new Array<number>(values.length).fill(NaN);
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeWilderRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 2) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs), 2);
}

function computeWilderAtr(bars: OandaBar[], period = 14): number | null {
  if (bars.length < period + 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function computeWilderAdx(
  bars: OandaBar[],
  period = 14
): { adx: number; plusDi: number; minusDi: number } | null {
  if (bars.length < period * 2 + 2) return null;

  const trs: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    trs.push(tr);
    plusDms.push(plusDm);
    minusDms.push(minusDm);
  }

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 0; i < period; i++) {
    smTr += trs[i];
    smPlus += plusDms[i];
    smMinus += minusDms[i];
  }

  const dxList: number[] = [];
  let lastPlusDi = 0;
  let lastMinusDi = 0;

  for (let i = period; i < trs.length; i++) {
    smTr = smTr - smTr / period + trs[i];
    smPlus = smPlus - smPlus / period + plusDms[i];
    smMinus = smMinus - smMinus / period + minusDms[i];
    if (smTr <= 0) continue;
    const pdi = (smPlus / smTr) * 100;
    const mdi = (smMinus / smTr) * 100;
    lastPlusDi = pdi;
    lastMinusDi = mdi;
    const denom = pdi + mdi;
    dxList.push(denom > 0 ? (Math.abs(pdi - mdi) / denom) * 100 : 0);
  }

  if (dxList.length < period) return null;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxList[i];
  adx /= period;
  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }

  return {
    adx: round(adx, 2),
    plusDi: round(lastPlusDi, 2),
    minusDi: round(lastMinusDi, 2)
  };
}

function computeMacd(closes: number[]): { macd: number; signal: number; hist: number } | null {
  if (closes.length < 36) return null;
  const ema12 = computeEmaSeries(closes, 12);
  const ema26 = computeEmaSeries(closes, 26);
  const macdSeries: number[] = [];
  for (let i = 25; i < closes.length; i++) {
    if (Number.isFinite(ema12[i]) && Number.isFinite(ema26[i])) {
      macdSeries.push(ema12[i] - ema26[i]);
    }
  }
  if (macdSeries.length < 10) return null;
  const sigSeries = computeEmaSeries(macdSeries, 9);
  const macd = macdSeries[macdSeries.length - 1];
  const signal = sigSeries[sigSeries.length - 1];
  if (!Number.isFinite(macd) || !Number.isFinite(signal)) return null;
  return { macd, signal, hist: macd - signal };
}

function computeStoch(
  bars: OandaBar[],
  kPeriod = 14,
  dPeriod = 3
): { k: number; d: number } | null {
  if (bars.length < kPeriod + dPeriod) return null;
  const kVals: number[] = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    const span = hi - lo;
    kVals.push(span > 0 ? ((bars[i].close - lo) / span) * 100 : 50);
  }
  if (kVals.length < dPeriod) return null;
  const k = kVals[kVals.length - 1];
  let d = 0;
  for (let i = kVals.length - dPeriod; i < kVals.length; i++) d += kVals[i];
  d /= dPeriod;
  return { k, d };
}

function aggregateH4Bars(h1Bars: OandaBar[]): OandaBar[] {
  if (h1Bars.length === 0) return [];
  const buckets = new Map<number, OandaBar>();
  for (const b of h1Bars) {
    const key = Math.floor(b.ts / 14_400) * 14_400;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ...b, ts: key });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close;
      existing.volume += b.volume;
      if (b.spread > 0) existing.spread = b.spread;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function scoreTimeframeTechnicals(
  bars: OandaBar[]
): { maScore: number; oscScore: number; allScore: number } | null {
  if (bars.length < 22) return null;
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];

  // 1. Moving-Average Structure Score (-1..+1)
  const maSignals: number[] = [];
  const ema9 = computeEmaSeries(closes, 9);
  const ema21 = computeEmaSeries(closes, 21);
  const ema50 = closes.length >= 52 ? computeEmaSeries(closes, 50) : [];
  const ema200 = closes.length >= 202 ? computeEmaSeries(closes, 200) : [];

  const lastEma = (arr: number[]) => (arr.length > 0 ? arr[arr.length - 1] : NaN);
  const e9 = lastEma(ema9);
  const e21 = lastEma(ema21);
  const e50 = lastEma(ema50);
  const e200 = lastEma(ema200);

  if (Number.isFinite(e9)) maSignals.push(last > e9 ? 1 : last < e9 ? -1 : 0);
  if (Number.isFinite(e21)) maSignals.push(last > e21 ? 1 : last < e21 ? -1 : 0);
  if (Number.isFinite(e9) && Number.isFinite(e21)) {
    maSignals.push(e9 > e21 ? 1 : e9 < e21 ? -1 : 0);
  }
  if (Number.isFinite(e50)) {
    maSignals.push(last > e50 ? 1 : last < e50 ? -1 : 0);
    if (Number.isFinite(e21)) maSignals.push(e21 > e50 ? 1 : e21 < e50 ? -1 : 0);
  }
  if (Number.isFinite(e200)) {
    maSignals.push(last > e200 ? 1 : last < e200 ? -1 : 0);
  }

  const maScore =
    maSignals.length > 0 ? maSignals.reduce((s, v) => s + v, 0) / maSignals.length : 0;

  // 2. Oscillator & Directional Momentum Score (-1..+1)
  const oscSignals: number[] = [];
  const rsi = computeWilderRsi(closes, 14);
  if (rsi !== null) {
    if (rsi >= 55 && rsi <= 78) oscSignals.push(1);
    else if (rsi > 78) oscSignals.push(0.45);
    else if (rsi <= 45 && rsi >= 22) oscSignals.push(-1);
    else if (rsi < 22) oscSignals.push(-0.45);
    else oscSignals.push(0);
  }

  const macd = computeMacd(closes);
  if (macd) {
    if (macd.macd > macd.signal && macd.hist > 0) oscSignals.push(1);
    else if (macd.macd < macd.signal && macd.hist < 0) oscSignals.push(-1);
    else oscSignals.push(macd.hist >= 0 ? 0.35 : -0.35);
  }

  const stoch = computeStoch(bars, 14, 3);
  if (stoch) {
    if (stoch.k > stoch.d && stoch.k > 50) oscSignals.push(0.8);
    else if (stoch.k < stoch.d && stoch.k < 50) oscSignals.push(-0.8);
    else if (stoch.k > stoch.d) oscSignals.push(0.35);
    else if (stoch.k < stoch.d) oscSignals.push(-0.35);
    else oscSignals.push(0);
  }

  const adxObj = computeWilderAdx(bars, 14);
  if (adxObj) {
    const strength = adxObj.adx >= 20 ? 1 : 0.4;
    if (adxObj.plusDi > adxObj.minusDi + 2) oscSignals.push(strength);
    else if (adxObj.minusDi > adxObj.plusDi + 2) oscSignals.push(-strength);
    else oscSignals.push(0);
  }

  const oscScore =
    oscSignals.length > 0 ? oscSignals.reduce((s, v) => s + v, 0) / oscSignals.length : 0;

  const allScore = clamp(maScore * 0.58 + oscScore * 0.42, -1, 1);
  return {
    maScore: round(maScore, 3),
    oscScore: round(oscScore, 3),
    allScore: round(allScore, 3)
  };
}

/**
 * Time-of-day normalized tick RVOL using H1 candles: compares the recent 4-hour tick
 * participation against the same UTC hours across prior trading days in the H1 window.
 */
function computeSessionTickRvol(h1Bars: OandaBar[]): number | null {
  if (h1Bars.length < 30) return null;
  // Use last 4 completed/active H1 bars (excluding an incomplete bar with tiny volume if <5m old)
  const recent = h1Bars.slice(-4);
  const recentVol = recent.reduce((s, b) => s + (b.volume > 0 ? b.volume : 0), 0);
  if (recentVol <= 0) return null;

  const targetHours = new Set(recent.map((b) => new Date(b.ts * 1000).getUTCHours()));
  const prior = h1Bars.slice(0, -4);

  const byDay = new Map<string, { sum: number; count: number }>();
  for (const b of prior) {
    if (b.volume <= 0) continue;
    const dt = new Date(b.ts * 1000);
    if (!targetHours.has(dt.getUTCHours())) continue;
    const dayKey = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}-${dt.getUTCDate()}`;
    const entry = byDay.get(dayKey) ?? { sum: 0, count: 0 };
    entry.sum += b.volume;
    entry.count += 1;
    byDay.set(dayKey, entry);
  }

  const fullDaySums: number[] = [];
  for (const v of byDay.values()) {
    if (v.count >= Math.max(2, targetHours.size - 1) && v.sum > 0) {
      // Scale proportionally if 1 hour was missing
      fullDaySums.push((v.sum / v.count) * recent.length);
    }
  }

  let baseline: number | null = null;
  if (fullDaySums.length >= 2) {
    baseline = fullDaySums.reduce((s, x) => s + x, 0) / fullDaySums.length;
  } else {
    const nonZeroPrior = prior.filter((b) => b.volume > 0);
    if (nonZeroPrior.length >= 12) {
      const avgHour = nonZeroPrior.reduce((s, b) => s + b.volume, 0) / nonZeroPrior.length;
      baseline = avgHour * recent.length;
    }
  }

  if (!baseline || baseline <= 0) return null;
  return round(clamp(recentVol / baseline, 0.1, 9.9), 2);
}

function computeMedian(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
}

function pctFromBarsAgo(bars: OandaBar[], currentPrice: number, offset: number): number | null {
  if (bars.length <= offset) return null;
  const ref = bars[bars.length - 1 - offset]?.close;
  if (!ref || !Number.isFinite(ref) || ref <= 0) return null;
  return round(((currentPrice - ref) / ref) * 100, 2);
}

function pctFromYearStart(bars: OandaBar[], currentPrice: number): number | null {
  if (bars.length < 5) return null;
  const yearStartSec = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
  let refClose: number | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].ts <= yearStartSec) {
      refClose = bars[i].close;
      break;
    }
  }
  if (!refClose || refClose <= 0) return null;
  return round(((currentPrice - refClose) / refClose) * 100, 2);
}

function inferTypeForShort(short: string): string {
  if (short === 'XAUUSD' || short === 'XAGUSD' || short === 'USOIL' || short === 'UKOIL' || short === 'NATGAS' || short === 'COPPER') {
    return 'commodity';
  }
  if (short === 'DXY' || short === 'NAS100' || short === 'SPX' || short === 'US30' || short === 'GER40' || short === 'UK100' || short === 'JP225') {
    return 'index';
  }
  if (short === 'BTCUSD' || short === 'ETHUSD') return 'crypto';
  if (short.length === 6) return 'forex';
  return 'cfd';
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
        'User-Agent': 'DeplyzeWorkflow-Screener/0.1.21'
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
        rangePosPct = Math.round(clamp(((price - low) / (high - low)) * 100, 0, 100));
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

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runLane() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx]);
    }
  }

  const lanes = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: lanes }, () => runLane()));
  return results;
}

async function fetchOandaQuantitativeRow(
  requestedSymbol: string,
  baseRow: ScreenerRowData | undefined,
  livePricingMap: Map<string, OandaLivePricing>,
  force: boolean
): Promise<ScreenerRowData | null> {
  const short = shortTicker(requestedSymbol);
  const isDxy = short === 'DXY';
  const inst = isDxy ? 'ICE_DXY_OANDA' : resolveOandaInstrument(short);
  if (!inst) return null;

  const [dailyRes, h1Res, posBook]: [
    OandaSeriesResult | null,
    OandaSeriesResult | null,
    OandaPositionBookSummary | null
  ] = await Promise.all([
    isDxy
      ? fetchOandaSyntheticDxy('D', 260, force)
      : fetchOandaSeries(short, 'D', 260, force),
    isDxy
      ? fetchOandaSyntheticDxy('H1', 140, force)
      : fetchOandaSeries(short, 'H1', 140, force),
    !isDxy && hasOandaPositionBook(short)
      ? fetchOandaPositionBook(short, force)
      : Promise.resolve(null)
  ]);

  if (!dailyRes || dailyRes.bars.length < 2) return null;

  const dBars = dailyRes.bars;
  const h1Bars = h1Res?.bars ?? [];
  const lastDay = dBars[dBars.length - 1];
  const prevDay = dBars[dBars.length - 2];

  const livePx = !isDxy ? livePricingMap.get(inst) : undefined;
  const price = livePx?.mid ?? (h1Bars.length > 0 ? h1Bars[h1Bars.length - 1].close : lastDay.close);
  if (!Number.isFinite(price) || price <= 0) return null;

  const high = Math.max(lastDay.high, price);
  const low = Math.min(lastDay.low, price);
  const change = price - prevDay.close;
  const changePercent = prevDay.close > 0 ? round((change / prevDay.close) * 100, 2) : 0;
  const volatilityD = low > 0 ? round(((high - low) / low) * 100, 2) : null;
  const rangePosPct =
    high > low ? Math.round(clamp(((price - low) / (high - low)) * 100, 0, 100)) : 50;

  const change1h = h1Bars.length >= 2 ? pctFromBarsAgo(h1Bars, price, 1) : (baseRow?.change1h ?? null);
  const change4h = h1Bars.length >= 5 ? pctFromBarsAgo(h1Bars, price, 4) : (baseRow?.change4h ?? null);

  // Sync latest bar close with live pricing for exact indicator calculation
  const dailyForTa =
    dBars.length > 0
      ? [...dBars.slice(0, -1), { ...lastDay, high, low, close: price }]
      : dBars;
  const h1ForTa =
    h1Bars.length > 0
      ? [
          ...h1Bars.slice(0, -1),
          {
            ...h1Bars[h1Bars.length - 1],
            high: Math.max(h1Bars[h1Bars.length - 1].high, price),
            low: Math.min(h1Bars[h1Bars.length - 1].low, price),
            close: price
          }
        ]
      : [];
  const h4ForTa = h1ForTa.length >= 20 ? aggregateH4Bars(h1ForTa) : [];

  const dailyCloses = dailyForTa.map((b) => b.close);
  const rsi14 = computeWilderRsi(dailyCloses, 14) ?? baseRow?.rsi14 ?? null;
  const atr14 = computeWilderAtr(dailyForTa, 14) ?? baseRow?.atr14 ?? null;
  const adxObj = computeWilderAdx(dailyForTa, 14);
  const adx14 = adxObj?.adx ?? baseRow?.adx14 ?? null;

  // Multi-Timeframe Institutional Tech Rating: 1D (45%) + 4H (35%) + 1H (20%)
  const ta1D = scoreTimeframeTechnicals(dailyForTa);
  const ta4H = scoreTimeframeTechnicals(h4ForTa);
  const ta1H = scoreTimeframeTechnicals(h1ForTa);

  let wSum = 0;
  let maAccum = 0;
  let oscAccum = 0;
  const blend = (ta: { maScore: number; oscScore: number } | null, weight: number) => {
    if (!ta) return;
    wSum += weight;
    maAccum += ta.maScore * weight;
    oscAccum += ta.oscScore * weight;
  };
  blend(ta1D, 0.45);
  blend(ta4H, 0.35);
  blend(ta1H, 0.2);

  const recommendMA = wSum > 0 ? round(maAccum / wSum, 3) : (baseRow?.recommendMA ?? null);
  const recommendOsc = wSum > 0 ? round(oscAccum / wSum, 3) : (baseRow?.recommendOsc ?? null);
  const recommendAll =
    recommendMA !== null && recommendOsc !== null
      ? round(clamp(recommendMA * 0.58 + recommendOsc * 0.42, -1, 1), 3)
      : (baseRow?.recommendAll ?? null);

  // Time-of-day normalized tick RVOL from OANDA H1 bars
  const relVolume = computeSessionTickRvol(h1Bars) ?? baseRow?.relVolume ?? null;
  const volume = lastDay.volume > 0 ? lastDay.volume : (baseRow?.volume ?? null);

  // Live institutional Bid-Ask spread regime
  const liveSpreadPx = livePx?.spreadPx ?? h1Res?.liveSpreadPx ?? dailyRes.liveSpreadPx ?? null;
  const spreadPct =
    livePx?.spreadPct ??
    (liveSpreadPx !== null && price > 0 ? round((liveSpreadPx / price) * 100, 4) : null);
  const medianSpread = computeMedian(
    (h1Bars.length >= 20 ? h1Bars.slice(-24) : dBars.slice(-20)).map((b) => b.spread)
  );
  const spreadRatio =
    liveSpreadPx !== null && medianSpread && medianSpread > 0
      ? round(liveSpreadPx / medianSpread, 2)
      : null;
  const spreadAtrPct =
    liveSpreadPx !== null && atr14 && atr14 > 0 ? round((liveSpreadPx / atr14) * 100, 2) : null;
  const wideSpread = Boolean(
    (spreadRatio !== null && spreadRatio >= 2.1) || (spreadAtrPct !== null && spreadAtrPct >= 2.5)
  );

  // Fill any missing performance horizons from OANDA's 260-day history
  const perfW = baseRow?.perfW ?? pctFromBarsAgo(dailyForTa, price, 5);
  const perf1M = baseRow?.perf1M ?? pctFromBarsAgo(dailyForTa, price, 21);
  const perf3M = baseRow?.perf3M ?? pctFromBarsAgo(dailyForTa, price, 63);
  const perf6M = baseRow?.perf6M ?? pctFromBarsAgo(dailyForTa, price, 126);
  const perfYTD = baseRow?.perfYTD ?? pctFromYearStart(dailyForTa, price);
  const perf1Y = baseRow?.perf1Y ?? pctFromBarsAgo(dailyForTa, price, 250);

  return {
    symbol: requestedSymbol,
    shortName: short,
    description: baseRow?.description || short,
    price,
    change,
    changePercent,
    change1h,
    change4h,
    perfW,
    perf1M,
    perf3M,
    perf6M,
    perfYTD,
    perf1Y,
    recommendAll,
    recommendMA,
    recommendOsc,
    rating: scoreToRating(recommendAll),
    maRating: scoreToRating(recommendMA),
    oscRating: scoreToRating(recommendOsc),
    rsi14,
    adx14,
    atr14,
    volatilityD,
    high,
    low,
    rangePosPct,
    relVolume,
    volume,
    spreadPct,
    spreadAtrPct,
    spreadRatio,
    wideSpread,
    crowdLongPct: posBook?.longPct ?? null,
    crowdShortPct: posBook?.shortPct ?? null,
    trappedLongPct: posBook?.trappedLongPct ?? null,
    trappedShortPct: posBook?.trappedShortPct ?? null,
    crowdSkew: posBook?.skew ?? null,
    type: baseRow?.type ?? inferTypeForShort(short),
    source: 'oanda',
    updatedAt: new Date().toISOString()
  };
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

  const oandaActive = isOandaConfigured();

  if (stale.length > 0) {
    const reqs = stale.map((sym) => ({
      requested: sym,
      tvTicker: resolveTvTicker(sym)
    }));

    const oandaSymbols = oandaActive ? stale.filter(isOandaEligible) : [];

    // Fetch TV Scanner batch (all symbols for stocks/altcoins + multi-month perf horizons)
    // in parallel with OANDA live batch pricing.
    const [tvRows, livePricingMap] = await Promise.all([
      fetchBatchFromTv(reqs),
      oandaSymbols.length > 0
        ? fetchOandaBatchPricing(
            oandaSymbols.map((s) => shortTicker(s)),
            force
          )
        : Promise.resolve(new Map<string, OandaLivePricing>())
    ]);

    // Overlay authoritative OANDA v20 candles + MTF technicals + RVOL + spread + position book
    const oandaRows = new Map<string, ScreenerRowData>();
    if (oandaSymbols.length > 0) {
      const built = await runWithConcurrency(oandaSymbols, OANDA_CONCURRENCY, async (sym) => {
        const row = await fetchOandaQuantitativeRow(sym, tvRows.get(sym), livePricingMap, force);
        return { sym, row };
      });
      for (const item of built) {
        if (item.row) oandaRows.set(item.sym, item.row);
      }
    }

    const missing: string[] = [];
    const fetchedAt = Date.now();
    for (const sym of stale) {
      const row = oandaRows.get(sym) ?? tvRows.get(sym);
      if (row) {
        rowCache.set(sym, { row, fetchedAt });
        resultMap.set(sym, row);
      } else {
        missing.push(sym);
      }
    }

    // Fallback to quotes service (Yahoo) only for any unmapped custom watchlist tickers
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
          rowCache.set(sym, { row, fetchedAt });
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
    oandaActive,
    updatedAt: new Date().toISOString()
  };
}
