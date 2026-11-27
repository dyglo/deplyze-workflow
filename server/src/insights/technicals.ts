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
  type OandaGranularity,
  type OandaPositionBookSummary,
  type OandaSeriesResult
} from '../quotes/oanda.js';
import {
  aggregateBars,
  computeAwesomeOscillator,
  computeBullBearPower,
  computeCci,
  computeEmaSeries,
  computeHullMa,
  computeIchimokuBaseLine,
  computeMacd,
  computeSma,
  computeStoch,
  computeVwma,
  computeWilderAdx,
  computeWilderAtr,
  computeWilderRsiSeries,
  computeWilliamsR,
  scoreTimeframeTechnicals
} from '../quotes/ta.js';

const TV_SCANNER_URL = 'https://scanner.tradingview.com/global/scan';
const FETCH_TIMEOUT_MS = 10_000;

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
  score: number; // -1 to +1
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
  crowdLongPct?: number | null;
  crowdShortPct?: number | null;
  trappedLongPct?: number | null;
  trappedShortPct?: number | null;
  crowdSkew?: OandaCrowdSkew | null;
  spreadAtrPct?: number | null;
  source: 'oanda' | 'tv' | 'yahoo-fallback';
  updatedAt: string;
}

const INTERVAL_SUFFIX: Record<TechnicalsInterval, string> = {
  '1m': '|1',
  '5m': '|5',
  '15m': '|15',
  '30m': '|30',
  '1h': '|60',
  '2h': '|120',
  '4h': '|240',
  '1D': '',
  '1W': '|1W',
  '1M': '|1M'
};

const MTF_INTERVALS: { interval: TechnicalsInterval; label: string }[] = [
  { interval: '15m', label: '15m' },
  { interval: '1h', label: '1H' },
  { interval: '4h', label: '4H' },
  { interval: '1D', label: '1D' },
  { interval: '1W', label: '1W' },
  { interval: '1M', label: '1M' }
];

const TV_TECHNICALS_OVERRIDES: Record<string, string[]> = {
  XAUUSD: ['OANDA:XAUUSD', 'TVC:GOLD'],
  GOLD: ['OANDA:XAUUSD', 'TVC:GOLD'],
  XAGUSD: ['OANDA:XAGUSD', 'TVC:SILVER'],
  SILVER: ['OANDA:XAGUSD', 'TVC:SILVER'],
  USOIL: ['FX:USOIL', 'NYMEX:CL1!', 'TVC:USOIL'],
  WTI: ['FX:USOIL', 'NYMEX:CL1!'],
  WTICOUSD: ['FX:USOIL', 'NYMEX:CL1!'],
  OILUSD: ['FX:USOIL', 'NYMEX:CL1!'],
  UKOIL: ['FX:UKOIL', 'TVC:UKOIL', 'ICEEUR:BRN1!'],
  BRENT: ['FX:UKOIL', 'TVC:UKOIL'],
  DXY: ['TVC:DXY'],
  VIX: ['TVC:VIX'],
  US10Y: ['TVC:US10Y'],
  SPX: ['TVC:SPX', 'SP:SPX'],
  US500: ['TVC:SPX', 'SP:SPX'],
  NAS100: ['NASDAQ:NDX', 'OANDA:NAS100USD'],
  NDX: ['NASDAQ:NDX'],
  US30: ['TVC:DJI', 'DJ:DJI'],
  DJI: ['TVC:DJI', 'DJ:DJI'],
  EURUSD: ['OANDA:EURUSD', 'FX:EURUSD'],
  GBPUSD: ['OANDA:GBPUSD', 'FX:GBPUSD'],
  USDJPY: ['OANDA:USDJPY', 'FX:USDJPY'],
  AUDUSD: ['OANDA:AUDUSD', 'FX:AUDUSD'],
  USDCAD: ['OANDA:USDCAD', 'FX:USDCAD'],
  USDCHF: ['OANDA:USDCHF', 'FX:USDCHF'],
  NZDUSD: ['OANDA:NZDUSD', 'FX:NZDUSD'],
  GBPJPY: ['OANDA:GBPJPY', 'FX:GBPJPY'],
  EURJPY: ['OANDA:EURJPY', 'FX:EURJPY'],
  EURGBP: ['OANDA:EURGBP', 'FX:EURGBP'],
  BTCUSD: ['BITSTAMP:BTCUSD', 'COINBASE:BTCUSD'],
  ETHUSD: ['BITSTAMP:ETHUSD', 'COINBASE:ETHUSD']
};

interface CacheItem {
  payload: SymbolTechnicalsPayload;
  fetchedAt: number;
}

const techCache = new Map<string, CacheItem>();

export function parseTechnicalsInterval(raw: string | null | undefined): TechnicalsInterval {
  const s = (raw ?? '1D').trim();
  const map: Record<string, TechnicalsInterval> = {
    '1': '1m',
    '1m': '1m',
    '5': '5m',
    '5m': '5m',
    '15': '15m',
    '15m': '15m',
    '30': '30m',
    '30m': '30m',
    '60': '1h',
    '1h': '1h',
    '1H': '1h',
    '120': '2h',
    '2h': '2h',
    '2H': '2h',
    '240': '4h',
    '4h': '4h',
    '4H': '4h',
    D: '1D',
    '1d': '1D',
    '1D': '1D',
    W: '1W',
    '1w': '1W',
    '1W': '1W',
    M: '1M',
    '1M': '1M'
  };
  return map[s] ?? '1D';
}

function shortTicker(raw: string): string {
  const upper = (raw || '').trim().toUpperCase();
  const idx = upper.indexOf(':');
  return idx >= 0 ? upper.slice(idx + 1) : upper;
}

function candidateTvTickers(raw: string): string[] {
  const upper = (raw || '').trim().toUpperCase();
  const short = shortTicker(upper);
  const list: string[] = [];
  if (TV_TECHNICALS_OVERRIDES[short]) {
    for (const t of TV_TECHNICALS_OVERRIDES[short]) {
      if (!list.includes(t)) list.push(t);
    }
  }
  if (upper.includes(':') && !list.includes(upper)) {
    list.unshift(upper);
    // For USOIL, prioritize FX:USOIL / NYMEX:CL1! ahead of TVC:USOIL since TVC:USOIL lacks scanner data
    if (short === 'USOIL' || short === 'WTI' || short === 'WTICOUSD') {
      return ['FX:USOIL', 'NYMEX:CL1!', upper];
    }
  }
  if (!list.includes(short)) list.push(short);
  return list;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function roundVal(v: number | null, digits = 4): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(v * factor) / factor;
}

export function scoreToRating(score: number | null): RatingLabel {
  if (score == null || !Number.isFinite(score)) return 'Neutral';
  if (score < -0.5) return 'Strong sell';
  if (score < -0.1) return 'Sell';
  if (score <= 0.1) return 'Neutral';
  if (score <= 0.5) return 'Buy';
  return 'Strong buy';
}

function recNumToAction(rec: number | null): SignalAction {
  if (rec == null || !Number.isFinite(rec)) return 'Neutral';
  if (rec > 0) return 'Buy';
  if (rec < 0) return 'Sell';
  return 'Neutral';
}

// TradingView documented oscillator signal rules
function computeRsiAction(rsi: number | null, rsiPrev: number | null): SignalAction {
  if (rsi == null) return 'Neutral';
  if (rsi < 30 && (rsiPrev == null || rsi > rsiPrev)) return 'Buy';
  if (rsi > 70 && (rsiPrev == null || rsi < rsiPrev)) return 'Sell';
  return 'Neutral';
}

function computeStochAction(
  k: number | null,
  d: number | null,
  kPrev: number | null,
  dPrev: number | null
): SignalAction {
  if (k == null || d == null) return 'Neutral';
  if (k < 20 && d < 20 && k > d && (kPrev == null || dPrev == null || kPrev < dPrev)) return 'Buy';
  if (k > 80 && d > 80 && k < d && (kPrev == null || dPrev == null || kPrev > dPrev)) return 'Sell';
  return 'Neutral';
}

function computeCciAction(cci: number | null, cciPrev: number | null): SignalAction {
  if (cci == null) return 'Neutral';
  if (cci < -100 && (cciPrev == null || cci > cciPrev)) return 'Buy';
  if (cci > 100 && (cciPrev == null || cci < cciPrev)) return 'Sell';
  return 'Neutral';
}

function computeAdxAction(
  adx: number | null,
  diPlus: number | null,
  diMinus: number | null,
  diPlusPrev: number | null,
  diMinusPrev: number | null
): SignalAction {
  if (adx == null || diPlus == null || diMinus == null) return 'Neutral';
  if (adx > 20) {
    if (diPlus > diMinus && (diPlusPrev == null || diMinusPrev == null || diPlusPrev < diMinusPrev)) {
      return 'Buy';
    }
    if (diMinus > diPlus && (diPlusPrev == null || diMinusPrev == null || diMinusPrev < diPlusPrev)) {
      return 'Sell';
    }
  }
  return 'Neutral';
}

function computeAoAction(ao: number | null, ao1: number | null, ao2: number | null): SignalAction {
  if (ao == null || ao1 == null) return 'Neutral';
  // Zero line crossover or saucer pattern
  if (ao > 0 && ao1 < 0) return 'Buy';
  if (ao < 0 && ao1 > 0) return 'Sell';
  if (ao2 != null) {
    if (ao > 0 && ao > ao1 && ao1 < ao2) return 'Buy';
    if (ao < 0 && ao < ao1 && ao1 > ao2) return 'Sell';
  }
  return 'Neutral';
}

function computeMomAction(mom: number | null, momPrev: number | null): SignalAction {
  if (mom == null || momPrev == null) return 'Neutral';
  if (mom > momPrev) return 'Buy';
  if (mom < momPrev) return 'Sell';
  return 'Neutral';
}

function computeMacdAction(macd: number | null, signal: number | null): SignalAction {
  if (macd == null || signal == null) return 'Neutral';
  if (macd > signal) return 'Buy';
  if (macd < signal) return 'Sell';
  return 'Neutral';
}

function computeMaAction(maVal: number | null, close: number | null): SignalAction {
  if (maVal == null || close == null) return 'Neutral';
  if (maVal < close) return 'Buy';
  if (maVal > close) return 'Sell';
  return 'Neutral';
}

function tallyRows(rows: IndicatorRow[], tvScore: number | null): GaugeSummary {
  let buy = 0;
  let neutral = 0;
  let sell = 0;
  for (const r of rows) {
    if (r.action === 'Buy') buy += 1;
    else if (r.action === 'Sell') sell += 1;
    else neutral += 1;
  }
  const total = buy + neutral + sell;
  const computed = total > 0 ? (buy - sell) / total : 0;
  const score = tvScore != null && Number.isFinite(tvScore) ? tvScore : computed;
  return {
    score: Number(score.toFixed(4)),
    rating: scoreToRating(score),
    sell,
    neutral,
    buy
  };
}

function computePivotsFromPrevBar(prev: OandaBar): PivotRow[] {
  const h = prev.high;
  const l = prev.low;
  const c = prev.close;
  const o = prev.open;
  const rng = Math.max(0, h - l);

  const pClassic = (h + l + c) / 3;
  const pWoodie = (h + l + 2 * c) / 4;
  const xDm = c < o ? h + 2 * l + c : c > o ? 2 * h + l + c : h + l + 2 * c;

  return [
    {
      method: 'Classic',
      s3: roundVal(l - 2 * (h - pClassic), 4),
      s2: roundVal(pClassic - rng, 4),
      s1: roundVal(2 * pClassic - h, 4),
      p: roundVal(pClassic, 4),
      r1: roundVal(2 * pClassic - l, 4),
      r2: roundVal(pClassic + rng, 4),
      r3: roundVal(h + 2 * (pClassic - l), 4)
    },
    {
      method: 'Fibonacci',
      s3: roundVal(pClassic - rng, 4),
      s2: roundVal(pClassic - 0.618 * rng, 4),
      s1: roundVal(pClassic - 0.382 * rng, 4),
      p: roundVal(pClassic, 4),
      r1: roundVal(pClassic + 0.382 * rng, 4),
      r2: roundVal(pClassic + 0.618 * rng, 4),
      r3: roundVal(pClassic + rng, 4)
    },
    {
      method: 'Camarilla',
      s3: roundVal(c - (rng * 1.1) / 4, 4),
      s2: roundVal(c - (rng * 1.1) / 6, 4),
      s1: roundVal(c - (rng * 1.1) / 12, 4),
      p: roundVal(pClassic, 4),
      r1: roundVal(c + (rng * 1.1) / 12, 4),
      r2: roundVal(c + (rng * 1.1) / 6, 4),
      r3: roundVal(c + (rng * 1.1) / 4, 4)
    },
    {
      method: 'Woodie',
      s3: roundVal(l - 2 * (h - pWoodie), 4),
      s2: roundVal(pWoodie - rng, 4),
      s1: roundVal(2 * pWoodie - h, 4),
      p: roundVal(pWoodie, 4),
      r1: roundVal(2 * pWoodie - l, 4),
      r2: roundVal(pWoodie + rng, 4),
      r3: roundVal(h + 2 * (pWoodie - l), 4)
    },
    {
      method: 'DM',
      s3: null,
      s2: null,
      s1: roundVal(xDm / 2 - h, 4),
      p: roundVal(xDm / 4, 4),
      r1: roundVal(xDm / 2 - l, 4),
      r2: null,
      r3: null
    }
  ];
}

function mapIntervalToOanda(interval: TechnicalsInterval): { gran: OandaGranularity; aggSec?: number } {
  switch (interval) {
    case '1m':
    case '5m':
      return { gran: 'M5' };
    case '15m':
      return { gran: 'M15' };
    case '30m':
      return { gran: 'M30' };
    case '1h':
      return { gran: 'H1' };
    case '2h':
      return { gran: 'H1', aggSec: 7200 };
    case '4h':
      return { gran: 'H4' };
    case '1W':
      return { gran: 'D', aggSec: 7 * 86_400 };
    case '1M':
      return { gran: 'D', aggSec: 30 * 86_400 };
    case '1D':
    default:
      return { gran: 'D' };
  }
}

async function buildOandaTechnicalsPayload(
  symbol: string,
  short: string,
  interval: TechnicalsInterval,
  tvFallback: SymbolTechnicalsPayload | null
): Promise<SymbolTechnicalsPayload | null> {
  if (!isOandaConfigured()) return null;
  const isDxy = short === 'DXY';
  const inst = isDxy ? 'ICE_DXY_OANDA' : resolveOandaInstrument(short);
  if (!inst) return null;

  const targetSpec = mapIntervalToOanda(interval);
  const fetchSeries = (gran: OandaGranularity, count: number): Promise<OandaSeriesResult | null> =>
    isDxy ? fetchOandaSyntheticDxy(gran, count, false) : fetchOandaSeries(short, gran, count, false);

  const [targetRes, dailyRes, h1Res, m15Res, pricingMap, posBook]: [
    OandaSeriesResult | null,
    OandaSeriesResult | null,
    OandaSeriesResult | null,
    OandaSeriesResult | null,
    Map<string, { mid: number; spreadPx: number }>,
    OandaPositionBookSummary | null
  ] = await Promise.all([
    fetchSeries(targetSpec.gran, targetSpec.gran === 'D' ? 360 : 260),
    targetSpec.gran === 'D' ? Promise.resolve(null) : fetchSeries('D', 260),
    targetSpec.gran === 'H1' ? Promise.resolve(null) : fetchSeries('H1', 140),
    targetSpec.gran === 'M15' ? Promise.resolve(null) : fetchSeries('M15', 140),
    isDxy ? Promise.resolve(new Map()) : fetchOandaBatchPricing([short], false),
    !isDxy && hasOandaPositionBook(short) ? fetchOandaPositionBook(short, false) : Promise.resolve(null)
  ]);

  const effectiveDaily = targetSpec.gran === 'D' ? targetRes : dailyRes;
  const effectiveH1 = targetSpec.gran === 'H1' ? targetRes : h1Res;
  const effectiveM15 = targetSpec.gran === 'M15' ? targetRes : m15Res;

  if (!targetRes || targetRes.bars.length < 22) return null;

  let activeBars = targetSpec.aggSec ? aggregateBars(targetRes.bars, targetSpec.aggSec) : targetRes.bars;
  if (activeBars.length < 22) return null;

  const livePx = !isDxy ? pricingMap.get(inst) : undefined;
  const latestClose =
    livePx?.mid ??
    effectiveM15?.bars[effectiveM15.bars.length - 1]?.close ??
    effectiveH1?.bars[effectiveH1.bars.length - 1]?.close ??
    activeBars[activeBars.length - 1].close;

  if (!Number.isFinite(latestClose) || latestClose <= 0) return null;

  // Sync final bar with live OANDA spot
  const lastActive = activeBars[activeBars.length - 1];
  activeBars = [
    ...activeBars.slice(0, -1),
    {
      ...lastActive,
      high: Math.max(lastActive.high, latestClose),
      low: Math.min(lastActive.low, latestClose),
      close: latestClose
    }
  ];

  const closes = activeBars.map((b) => b.close);
  const lastIdx = closes.length - 1;
  const atr = computeWilderAtr(activeBars, 14);

  const rsiSeries = computeWilderRsiSeries(closes, 14);
  const rsiCur = rsiSeries.length > 0 && Number.isFinite(rsiSeries[lastIdx]) ? rsiSeries[lastIdx] : null;
  const rsiPrev =
    rsiSeries.length > 1 && Number.isFinite(rsiSeries[lastIdx - 1]) ? rsiSeries[lastIdx - 1] : null;

  const stoch = computeStoch(activeBars, 14, 3);
  const cci = computeCci(activeBars, 20);
  const adx = computeWilderAdx(activeBars, 14);
  const ao = computeAwesomeOscillator(activeBars);
  const momCur = closes.length >= 12 ? closes[lastIdx] - closes[lastIdx - 10] : null;
  const momPrev = closes.length >= 13 ? closes[lastIdx - 1] - closes[lastIdx - 11] : null;
  const macd = computeMacd(closes);
  const willR = computeWilliamsR(activeBars, 14);
  const bbp = computeBullBearPower(activeBars, 13);

  const oscillators: IndicatorRow[] = [
    {
      name: 'Relative Strength Index (14)',
      value: roundVal(rsiCur, 2),
      action: computeRsiAction(rsiCur, rsiPrev)
    },
    {
      name: 'Stochastic %K (14, 3, 3)',
      value: roundVal(stoch?.k ?? null, 2),
      action: computeStochAction(stoch?.k ?? null, stoch?.d ?? null, stoch?.prevK ?? null, stoch?.prevD ?? null)
    },
    {
      name: 'Commodity Channel Index (20)',
      value: roundVal(cci?.value ?? null, 2),
      action: computeCciAction(cci?.value ?? null, cci?.prev ?? null)
    },
    {
      name: 'Average Directional Index (14)',
      value: roundVal(adx?.adx ?? null, 2),
      action: computeAdxAction(
        adx?.adx ?? null,
        adx?.plusDi ?? null,
        adx?.minusDi ?? null,
        adx?.prevPlusDi ?? null,
        adx?.prevMinusDi ?? null
      )
    },
    {
      name: 'Awesome Oscillator',
      value: roundVal(ao?.ao ?? null, 4),
      action: computeAoAction(ao?.ao ?? null, ao?.ao1 ?? null, ao?.ao2 ?? null)
    },
    {
      name: 'Momentum (10)',
      value: roundVal(momCur, 4),
      action: computeMomAction(momCur, momPrev)
    },
    {
      name: 'MACD Level (12, 26)',
      value: roundVal(macd?.macd ?? null, 4),
      action: computeMacdAction(macd?.macd ?? null, macd?.signal ?? null)
    },
    {
      name: 'Williams Percent Range (14)',
      value: roundVal(willR, 2),
      action: willR == null ? 'Neutral' : willR < -80 ? 'Buy' : willR > -20 ? 'Sell' : 'Neutral'
    },
    {
      name: 'Bull Bear Power',
      value: roundVal(bbp, 4),
      action: bbp == null ? 'Neutral' : bbp > 0 ? 'Buy' : bbp < 0 ? 'Sell' : 'Neutral'
    }
  ];

  const emaVal = (period: number): number | null => {
    const arr = computeEmaSeries(closes, period);
    const v = arr.length > 0 ? arr[arr.length - 1] : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const ichimoku = computeIchimokuBaseLine(activeBars, 26);
  const vwma20 = computeVwma(activeBars, 20);
  const hull9 = computeHullMa(closes, 9);

  const movingAverages: IndicatorRow[] = [
    { name: 'Exponential Moving Average (10)', value: roundVal(emaVal(10), 4), action: computeMaAction(emaVal(10), latestClose) },
    { name: 'Simple Moving Average (10)', value: roundVal(computeSma(closes, 10), 4), action: computeMaAction(computeSma(closes, 10), latestClose) },
    { name: 'Exponential Moving Average (20)', value: roundVal(emaVal(20), 4), action: computeMaAction(emaVal(20), latestClose) },
    { name: 'Simple Moving Average (20)', value: roundVal(computeSma(closes, 20), 4), action: computeMaAction(computeSma(closes, 20), latestClose) },
    { name: 'Exponential Moving Average (30)', value: roundVal(emaVal(30), 4), action: computeMaAction(emaVal(30), latestClose) },
    { name: 'Simple Moving Average (30)', value: roundVal(computeSma(closes, 30), 4), action: computeMaAction(computeSma(closes, 30), latestClose) },
    { name: 'Exponential Moving Average (50)', value: roundVal(emaVal(50), 4), action: computeMaAction(emaVal(50), latestClose) },
    { name: 'Simple Moving Average (50)', value: roundVal(computeSma(closes, 50), 4), action: computeMaAction(computeSma(closes, 50), latestClose) },
    { name: 'Exponential Moving Average (100)', value: roundVal(emaVal(100), 4), action: computeMaAction(emaVal(100), latestClose) },
    { name: 'Simple Moving Average (100)', value: roundVal(computeSma(closes, 100), 4), action: computeMaAction(computeSma(closes, 100), latestClose) },
    { name: 'Exponential Moving Average (200)', value: roundVal(emaVal(200), 4), action: computeMaAction(emaVal(200), latestClose) },
    { name: 'Simple Moving Average (200)', value: roundVal(computeSma(closes, 200), 4), action: computeMaAction(computeSma(closes, 200), latestClose) },
    { name: 'Ichimoku Base Line (9, 26, 52, 26)', value: roundVal(ichimoku, 4), action: computeMaAction(ichimoku, latestClose) },
    { name: 'Volume Weighted Moving Average (20)', value: roundVal(vwma20, 4), action: computeMaAction(vwma20, latestClose) },
    { name: 'Hull Moving Average (9)', value: roundVal(hull9, 4), action: computeMaAction(hull9, latestClose) }
  ];

  const oscillatorsGauge = tallyRows(oscillators, null);
  const movingAveragesGauge = tallyRows(movingAverages, null);
  const summary = tallyRows([...oscillators, ...movingAverages], null);

  // Pivots from previous completed daily candle (or previous active candle for weekly/monthly)
  const pivotBars = effectiveDaily && effectiveDaily.bars.length >= 2 ? effectiveDaily.bars : activeBars;
  const pivots =
    pivotBars.length >= 2 ? computePivotsFromPrevBar(pivotBars[pivotBars.length - 2]) : (tvFallback?.pivots ?? []);

  // Build MTF overview: 15m, 1H, 4H, 1D live from OANDA; 1W, 1M from OANDA aggregated or TV fallback
  const h4Bars = effectiveH1 && effectiveH1.bars.length >= 20 ? aggregateBars(effectiveH1.bars, 14_400) : [];
  const weeklyBars = effectiveDaily && effectiveDaily.bars.length >= 110 ? aggregateBars(effectiveDaily.bars, 7 * 86_400) : [];

  const oandaScores: Partial<Record<TechnicalsInterval, { maScore: number; oscScore: number; allScore: number } | null>> = {
    '15m': effectiveM15 ? scoreTimeframeTechnicals(effectiveM15.bars) : null,
    '1h': effectiveH1 ? scoreTimeframeTechnicals(effectiveH1.bars) : null,
    '4h': h4Bars.length >= 22 ? scoreTimeframeTechnicals(h4Bars) : null,
    '1D': effectiveDaily ? scoreTimeframeTechnicals(effectiveDaily.bars) : null,
    '1W': weeklyBars.length >= 22 ? scoreTimeframeTechnicals(weeklyBars) : null
  };

  const mtfOverview: MtfOverviewRow[] = MTF_INTERVALS.map((entry) => {
    const sc = oandaScores[entry.interval];
    if (sc) {
      return {
        interval: entry.interval,
        label: entry.label,
        summaryScore: sc.allScore,
        summaryRating: scoreToRating(sc.allScore),
        oscillatorsRating: scoreToRating(sc.oscScore),
        movingAveragesRating: scoreToRating(sc.maScore)
      };
    }
    const tvMatch = tvFallback?.mtfOverview.find((r) => r.interval === entry.interval);
    return (
      tvMatch ?? {
        interval: entry.interval,
        label: entry.label,
        summaryScore: null,
        summaryRating: 'Neutral',
        oscillatorsRating: 'Neutral',
        movingAveragesRating: 'Neutral'
      }
    );
  });

  const dBars = effectiveDaily?.bars ?? [];
  const prevDailyClose = dBars.length >= 2 ? dBars[dBars.length - 2].close : null;
  const change = prevDailyClose != null ? roundVal(latestClose - prevDailyClose, 5) : (tvFallback?.change ?? null);
  const changePercent =
    prevDailyClose != null && prevDailyClose > 0
      ? roundVal(((latestClose - prevDailyClose) / prevDailyClose) * 100, 2)
      : (tvFallback?.changePercent ?? null);

  const liveSpreadPx = livePx?.spreadPx ?? targetRes.liveSpreadPx ?? effectiveH1?.liveSpreadPx ?? null;
  const dailyAtr = effectiveDaily ? computeWilderAtr(effectiveDaily.bars, 14) : atr;
  const spreadAtrPct =
    liveSpreadPx != null && dailyAtr != null && dailyAtr > 0
      ? roundVal((liveSpreadPx / dailyAtr) * 100, 2)
      : null;

  return {
    symbol,
    shortName: short,
    description: tvFallback?.description || short,
    resolvedTicker: `OANDA:${inst}`,
    interval,
    price: latestClose,
    change,
    changePercent,
    atr: roundVal(atr, 4),
    summary,
    oscillatorsGauge,
    movingAveragesGauge,
    oscillators,
    movingAverages,
    pivots,
    mtfOverview,
    crowdLongPct: posBook?.longPct ?? null,
    crowdShortPct: posBook?.shortPct ?? null,
    trappedLongPct: posBook?.trappedLongPct ?? null,
    trappedShortPct: posBook?.trappedShortPct ?? null,
    crowdSkew: posBook?.skew ?? null,
    spreadAtrPct,
    source: 'oanda',
    updatedAt: new Date().toISOString()
  };
}

export async function getSymbolTechnicalsPayload(
  rawSymbol: string,
  rawInterval?: string | null
): Promise<SymbolTechnicalsPayload> {
  const symbol = rawSymbol.trim().toUpperCase();
  const short = shortTicker(symbol);
  const interval = parseTechnicalsInterval(rawInterval);
  const cacheKey = `${symbol}|${interval}`;
  const ttlMs = interval === '1D' || interval === '1W' || interval === '1M' ? 45_000 : 20_000;

  const cached = techCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.payload;
  }

  const oandaEligible = isOandaConfigured() && (short === 'DXY' || resolveOandaInstrument(short) !== null);

  // For OANDA-covered intraday/daily timeframes, compute directly from live OANDA candles
  // (fetching TV only if needed for 1M/1W metadata or description).
  if (oandaEligible && interval !== '1M') {
    const oandaPayload = await buildOandaTechnicalsPayload(symbol, short, interval, null);
    if (oandaPayload) {
      techCache.set(cacheKey, { payload: oandaPayload, fetchedAt: Date.now() });
      if (techCache.size > 120) {
        const oldest = techCache.keys().next().value;
        if (oldest) techCache.delete(oldest);
      }
      return oandaPayload;
    }
  }

  const s = INTERVAL_SUFFIX[interval];
  const cols: string[] = [
    'close',
    'description',
    'change',
    'change_abs',
    `Recommend.All${s}`,
    `Recommend.Other${s}`,
    `Recommend.MA${s}`,
    `RSI${s}`,
    `RSI[1]${s}`,
    `Stoch.K${s}`,
    `Stoch.D${s}`,
    `Stoch.K[1]${s}`,
    `Stoch.D[1]${s}`,
    `CCI20${s}`,
    `CCI20[1]${s}`,
    `ADX${s}`,
    `ADX+DI${s}`,
    `ADX-DI${s}`,
    `ADX+DI[1]${s}`,
    `ADX-DI[1]${s}`,
    `AO${s}`,
    `AO[1]${s}`,
    `AO[2]${s}`,
    `Mom${s}`,
    `Mom[1]${s}`,
    `MACD.macd${s}`,
    `MACD.signal${s}`,
    `Stoch.RSI.K${s}`,
    `Rec.Stoch.RSI${s}`,
    `W.R${s}`,
    `Rec.WR${s}`,
    `BBPower${s}`,
    `Rec.BBPower${s}`,
    `UO${s}`,
    `Rec.UO${s}`,
    `EMA10${s}`,
    `SMA10${s}`,
    `EMA20${s}`,
    `SMA20${s}`,
    `EMA30${s}`,
    `SMA30${s}`,
    `EMA50${s}`,
    `SMA50${s}`,
    `EMA100${s}`,
    `SMA100${s}`,
    `EMA200${s}`,
    `SMA200${s}`,
    `Ichimoku.BLine${s}`,
    `Rec.Ichimoku${s}`,
    `VWMA${s}`,
    `Rec.VWMA${s}`,
    `HullMA9${s}`,
    `Rec.HullMA9${s}`,
    `Pivot.M.Classic.S3${s}`,
    `Pivot.M.Classic.S2${s}`,
    `Pivot.M.Classic.S1${s}`,
    `Pivot.M.Classic.Middle${s}`,
    `Pivot.M.Classic.R1${s}`,
    `Pivot.M.Classic.R2${s}`,
    `Pivot.M.Classic.R3${s}`,
    `Pivot.M.Fibonacci.S3${s}`,
    `Pivot.M.Fibonacci.S2${s}`,
    `Pivot.M.Fibonacci.S1${s}`,
    `Pivot.M.Fibonacci.Middle${s}`,
    `Pivot.M.Fibonacci.R1${s}`,
    `Pivot.M.Fibonacci.R2${s}`,
    `Pivot.M.Fibonacci.R3${s}`,
    `Pivot.M.Camarilla.S3${s}`,
    `Pivot.M.Camarilla.S2${s}`,
    `Pivot.M.Camarilla.S1${s}`,
    `Pivot.M.Camarilla.Middle${s}`,
    `Pivot.M.Camarilla.R1${s}`,
    `Pivot.M.Camarilla.R2${s}`,
    `Pivot.M.Camarilla.R3${s}`,
    `Pivot.M.Woodie.S3${s}`,
    `Pivot.M.Woodie.S2${s}`,
    `Pivot.M.Woodie.S1${s}`,
    `Pivot.M.Woodie.Middle${s}`,
    `Pivot.M.Woodie.R1${s}`,
    `Pivot.M.Woodie.R2${s}`,
    `Pivot.M.Woodie.R3${s}`,
    `Pivot.M.Demark.S1${s}`,
    `Pivot.M.Demark.Middle${s}`,
    `Pivot.M.Demark.R1${s}`,
    `ATR${s}`
  ];

  // Append multi-timeframe overview columns in the same single scan call
  for (const mtf of MTF_INTERVALS) {
    const ms = INTERVAL_SUFFIX[mtf.interval];
    cols.push(`Recommend.All${ms}`, `Recommend.Other${ms}`, `Recommend.MA${ms}`);
  }

  const tickers = candidateTvTickers(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(TV_SCANNER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeplyzeWorkflow-API/0.1.14'
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: cols
      }),
      signal: controller.signal
    });

    if (res.ok) {
      const json = (await res.json()) as { data?: { s?: string; d?: unknown[] }[] };
      const rowsByTicker = new Map<string, unknown[]>();
      for (const item of json.data ?? []) {
        if (item.s && Array.isArray(item.d)) {
          rowsByTicker.set(item.s.toUpperCase(), item.d);
        }
      }

      let chosenTicker = '';
      let chosenData: unknown[] | null = null;
      for (const t of tickers) {
        const d = rowsByTicker.get(t.toUpperCase());
        if (d && num(d[0]) != null) {
          chosenTicker = t;
          chosenData = d;
          break;
        }
      }
      if (!chosenData && json.data && json.data.length > 0 && Array.isArray(json.data[0].d)) {
        chosenTicker = json.data[0].s ?? tickers[0];
        chosenData = json.data[0].d;
      }

      if (chosenData) {
        const m = new Map<string, unknown>();
        for (let i = 0; i < cols.length; i++) {
          m.set(cols[i], chosenData[i]);
        }

        const close = num(m.get('close'));
        const descRaw = m.get('description');
        const description =
          typeof descRaw === 'string' && descRaw.trim() ? descRaw.trim() : short;
        const changePercent = num(m.get('change'));
        const change = num(m.get('change_abs'));
        const recAll = num(m.get(`Recommend.All${s}`));
        const recOsc = num(m.get(`Recommend.Other${s}`));
        const recMa = num(m.get(`Recommend.MA${s}`));
        const atr = num(m.get(`ATR${s}`));

        const oscillators: IndicatorRow[] = [
          {
            name: 'Relative Strength Index (14)',
            value: roundVal(num(m.get(`RSI${s}`)), 2),
            action: computeRsiAction(num(m.get(`RSI${s}`)), num(m.get(`RSI[1]${s}`)))
          },
          {
            name: 'Stochastic %K (14, 3, 3)',
            value: roundVal(num(m.get(`Stoch.K${s}`)), 2),
            action: computeStochAction(
              num(m.get(`Stoch.K${s}`)),
              num(m.get(`Stoch.D${s}`)),
              num(m.get(`Stoch.K[1]${s}`)),
              num(m.get(`Stoch.D[1]${s}`))
            )
          },
          {
            name: 'Commodity Channel Index (20)',
            value: roundVal(num(m.get(`CCI20${s}`)), 2),
            action: computeCciAction(num(m.get(`CCI20${s}`)), num(m.get(`CCI20[1]${s}`)))
          },
          {
            name: 'Average Directional Index (14)',
            value: roundVal(num(m.get(`ADX${s}`)), 2),
            action: computeAdxAction(
              num(m.get(`ADX${s}`)),
              num(m.get(`ADX+DI${s}`)),
              num(m.get(`ADX-DI${s}`)),
              num(m.get(`ADX+DI[1]${s}`)),
              num(m.get(`ADX-DI[1]${s}`))
            )
          },
          {
            name: 'Awesome Oscillator',
            value: roundVal(num(m.get(`AO${s}`)), 4),
            action: computeAoAction(
              num(m.get(`AO${s}`)),
              num(m.get(`AO[1]${s}`)),
              num(m.get(`AO[2]${s}`))
            )
          },
          {
            name: 'Momentum (10)',
            value: roundVal(num(m.get(`Mom${s}`)), 4),
            action: computeMomAction(num(m.get(`Mom${s}`)), num(m.get(`Mom[1]${s}`)))
          },
          {
            name: 'MACD Level (12, 26)',
            value: roundVal(num(m.get(`MACD.macd${s}`)), 4),
            action: computeMacdAction(
              num(m.get(`MACD.macd${s}`)),
              num(m.get(`MACD.signal${s}`))
            )
          },
          {
            name: 'Stochastic RSI Fast (3, 3, 14, 14)',
            value: roundVal(num(m.get(`Stoch.RSI.K${s}`)), 2),
            action: recNumToAction(num(m.get(`Rec.Stoch.RSI${s}`)))
          },
          {
            name: 'Williams Percent Range (14)',
            value: roundVal(num(m.get(`W.R${s}`)), 2),
            action: recNumToAction(num(m.get(`Rec.WR${s}`)))
          },
          {
            name: 'Bull Bear Power',
            value: roundVal(num(m.get(`BBPower${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.BBPower${s}`)))
          },
          {
            name: 'Ultimate Oscillator (7, 14, 28)',
            value: roundVal(num(m.get(`UO${s}`)), 2),
            action: recNumToAction(num(m.get(`Rec.UO${s}`)))
          }
        ];

        const movingAverages: IndicatorRow[] = [
          {
            name: 'Exponential Moving Average (10)',
            value: roundVal(num(m.get(`EMA10${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA10${s}`)), close)
          },
          {
            name: 'Simple Moving Average (10)',
            value: roundVal(num(m.get(`SMA10${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA10${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (20)',
            value: roundVal(num(m.get(`EMA20${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA20${s}`)), close)
          },
          {
            name: 'Simple Moving Average (20)',
            value: roundVal(num(m.get(`SMA20${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA20${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (30)',
            value: roundVal(num(m.get(`EMA30${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA30${s}`)), close)
          },
          {
            name: 'Simple Moving Average (30)',
            value: roundVal(num(m.get(`SMA30${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA30${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (50)',
            value: roundVal(num(m.get(`EMA50${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA50${s}`)), close)
          },
          {
            name: 'Simple Moving Average (50)',
            value: roundVal(num(m.get(`SMA50${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA50${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (100)',
            value: roundVal(num(m.get(`EMA100${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA100${s}`)), close)
          },
          {
            name: 'Simple Moving Average (100)',
            value: roundVal(num(m.get(`SMA100${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA100${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (200)',
            value: roundVal(num(m.get(`EMA200${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA200${s}`)), close)
          },
          {
            name: 'Simple Moving Average (200)',
            value: roundVal(num(m.get(`SMA200${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA200${s}`)), close)
          },
          {
            name: 'Ichimoku Base Line (9, 26, 52, 26)',
            value: roundVal(num(m.get(`Ichimoku.BLine${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.Ichimoku${s}`)))
          },
          {
            name: 'Volume Weighted Moving Average (20)',
            value: roundVal(num(m.get(`VWMA${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.VWMA${s}`)))
          },
          {
            name: 'Hull Moving Average (9)',
            value: roundVal(num(m.get(`HullMA9${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.HullMA9${s}`)))
          }
        ];

        const oscillatorsGauge = tallyRows(oscillators, recOsc);
        const movingAveragesGauge = tallyRows(movingAverages, recMa);
        const summary = tallyRows([...oscillators, ...movingAverages], recAll);

        const pivots: PivotRow[] = [
          {
            method: 'Classic',
            s3: roundVal(num(m.get(`Pivot.M.Classic.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Classic.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Classic.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Classic.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Classic.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Classic.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Classic.R3${s}`)), 4)
          },
          {
            method: 'Fibonacci',
            s3: roundVal(num(m.get(`Pivot.M.Fibonacci.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Fibonacci.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Fibonacci.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Fibonacci.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Fibonacci.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Fibonacci.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Fibonacci.R3${s}`)), 4)
          },
          {
            method: 'Camarilla',
            s3: roundVal(num(m.get(`Pivot.M.Camarilla.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Camarilla.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Camarilla.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Camarilla.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Camarilla.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Camarilla.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Camarilla.R3${s}`)), 4)
          },
          {
            method: 'Woodie',
            s3: roundVal(num(m.get(`Pivot.M.Woodie.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Woodie.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Woodie.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Woodie.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Woodie.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Woodie.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Woodie.R3${s}`)), 4)
          },
          {
            method: 'DM',
            s3: null,
            s2: null,
            s1: roundVal(num(m.get(`Pivot.M.Demark.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Demark.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Demark.R1${s}`)), 4),
            r2: null,
            r3: null
          }
        ];

        const mtfOverview: MtfOverviewRow[] = MTF_INTERVALS.map((entry) => {
          const ms = INTERVAL_SUFFIX[entry.interval];
          const mAll = num(m.get(`Recommend.All${ms}`));
          const mOsc = num(m.get(`Recommend.Other${ms}`));
          const mMa = num(m.get(`Recommend.MA${ms}`));
          return {
            interval: entry.interval,
            label: entry.label,
            summaryScore: mAll != null ? Number(mAll.toFixed(3)) : null,
            summaryRating: scoreToRating(mAll),
            oscillatorsRating: scoreToRating(mOsc),
            movingAveragesRating: scoreToRating(mMa)
          };
        });

        const payload: SymbolTechnicalsPayload = {
          symbol,
          shortName: short,
          description,
          resolvedTicker: chosenTicker,
          interval,
          price: close,
          change,
          changePercent,
          atr: roundVal(atr, 4),
          summary,
          oscillatorsGauge,
          movingAveragesGauge,
          oscillators,
          movingAverages,
          pivots,
          mtfOverview,
          source: 'tv',
          updatedAt: new Date().toISOString()
        };

        techCache.set(cacheKey, { payload, fetchedAt: Date.now() });
        if (techCache.size > 120) {
          const oldest = techCache.keys().next().value;
          if (oldest) techCache.delete(oldest);
        }
        return payload;
      }
    }
  } catch (err) {
    console.warn('[insights:technicals] TV scan error:', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }

  // Graceful neutral fallback if symbol is unrecognized upstream
  const emptyGauge: GaugeSummary = { score: 0, rating: 'Neutral', sell: 0, neutral: 0, buy: 0 };
  return {
    symbol,
    shortName: short,
    description: short,
    resolvedTicker: tickers[0] ?? symbol,
    interval,
    price: null,
    change: null,
    changePercent: null,
    atr: null,
    summary: emptyGauge,
    oscillatorsGauge: emptyGauge,
    movingAveragesGauge: emptyGauge,
    oscillators: [],
    movingAverages: [],
    pivots: [],
    mtfOverview: [],
    source: 'yahoo-fallback',
    updatedAt: new Date().toISOString()
  };
}
