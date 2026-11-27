import {
  timeframeToSeconds,
  type ConditionNode,
  type IndicatorDef,
  type PriceSource,
  type StrategyCandle,
  type StrategyTimeframe,
  type ValueRef
} from './types.js';

export type IndicatorEnv = Map<string, number[]>;

function getSourceSeries(bars: StrategyCandle[], source: PriceSource = 'close'): number[] {
  const n = bars.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    switch (source) {
      case 'open':
        out[i] = b.open;
        break;
      case 'high':
        out[i] = b.high;
        break;
      case 'low':
        out[i] = b.low;
        break;
      case 'hl2':
        out[i] = (b.high + b.low) / 2;
        break;
      case 'hlc3':
        out[i] = (b.high + b.low + b.close) / 3;
        break;
      case 'close':
      default:
        out[i] = b.close;
        break;
    }
  }
  return out;
}

function smaSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      valid++;
    }
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) {
        sum -= old;
        valid--;
      }
    }
    if (i >= period - 1 && valid === period) {
      out[i] = sum / period;
    }
  }
  return out;
}

function emaSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  const k = 2 / (period + 1);
  // Find first contiguous finite window of length `period`
  let start = -1;
  let count = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(values[i])) {
      sum += values[i];
      count++;
      if (count === period) {
        start = i;
        break;
      }
    } else {
      sum = 0;
      count = 0;
    }
  }
  if (start < 0) return out;
  let ema = sum / period;
  out[start] = ema;
  for (let i = start + 1; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = NaN;
      continue;
    }
    ema = v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function wmaSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let num = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      num += v * (j + 1);
    }
    if (ok) out[i] = num / denom;
  }
  return out;
}

function hmaSeries(values: number[], period: number): number[] {
  const half = Math.max(1, Math.floor(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  const wHalf = wmaSeries(values, half);
  const wFull = wmaSeries(values, period);
  const diff = new Array<number>(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(wHalf[i]) && Number.isFinite(wFull[i])) {
      diff[i] = 2 * wHalf[i] - wFull[i];
    }
  }
  return wmaSeries(diff, sqrtP);
}

function vwmaSeries(bars: StrategyCandle[], period: number): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const w = bars[i].volume > 0 ? bars[i].volume : 1;
    pv += bars[i].close * w;
    vol += w;
    if (i >= period) {
      const ow = bars[i - period].volume > 0 ? bars[i - period].volume : 1;
      pv -= bars[i - period].close * ow;
      vol -= ow;
    }
    if (i >= period - 1 && vol > 0) {
      out[i] = pv / vol;
    }
  }
  return out;
}

function rsiSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period + 2) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atrSeries(bars: StrategyCandle[], period: number): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period + 1) return out;
  const tr = new Array<number>(n).fill(0);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < n; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

function adxSeries(
  bars: StrategyCandle[],
  period: number
): { adx: number[]; plusDi: number[]; minusDi: number[] } {
  const n = bars.length;
  const adx = new Array<number>(n).fill(NaN);
  const plusDi = new Array<number>(n).fill(NaN);
  const minusDi = new Array<number>(n).fill(NaN);
  if (period <= 0 || n < period * 2 + 2) return { adx, plusDi, minusDi };

  const tr = new Array<number>(n).fill(0);
  const pdm = new Array<number>(n).fill(0);
  const mdm = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = bars[i];
    const p = bars[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high;
    const dn = p.low - c.low;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTr += tr[i];
    smPlus += pdm[i];
    smMinus += mdm[i];
  }

  const dx = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) {
      smTr = smTr - smTr / period + tr[i];
      smPlus = smPlus - smPlus / period + pdm[i];
      smMinus = smMinus - smMinus / period + mdm[i];
    }
    if (smTr > 0) {
      const pdi = (smPlus / smTr) * 100;
      const mdi = (smMinus / smTr) * 100;
      plusDi[i] = pdi;
      minusDi[i] = mdi;
      const den = pdi + mdi;
      dx[i] = den > 0 ? (Math.abs(pdi - mdi) / den) * 100 : 0;
    }
  }

  const adxStart = period * 2 - 1;
  if (adxStart < n) {
    let sumDx = 0;
    let cnt = 0;
    for (let i = period; i <= adxStart; i++) {
      if (Number.isFinite(dx[i])) {
        sumDx += dx[i];
        cnt++;
      }
    }
    if (cnt > 0) {
      let cur = sumDx / cnt;
      adx[adxStart] = cur;
      for (let i = adxStart + 1; i < n; i++) {
        if (Number.isFinite(dx[i])) {
          cur = (cur * (period - 1) + dx[i]) / period;
          adx[i] = cur;
        }
      }
    }
  }

  return { adx, plusDi, minusDi };
}

function macdSeries(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: number[]; signal: number[]; hist: number[] } {
  const n = values.length;
  const eFast = emaSeries(values, fast);
  const eSlow = emaSeries(values, slow);
  const macd = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(eFast[i]) && Number.isFinite(eSlow[i])) {
      macd[i] = eFast[i] - eSlow[i];
    }
  }
  const sig = emaSeries(macd, signal);
  const hist = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(macd[i]) && Number.isFinite(sig[i])) {
      hist[i] = macd[i] - sig[i];
    }
  }
  return { macd, signal: sig, hist };
}

function stochSeries(
  bars: StrategyCandle[],
  kPeriod = 14,
  dPeriod = 3
): { k: number[]; d: number[] } {
  const n = bars.length;
  const k = new Array<number>(n).fill(NaN);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    const rng = hi - lo;
    k[i] = rng > 0 ? ((bars[i].close - lo) / rng) * 100 : 50;
  }
  const d = smaSeries(k, dPeriod);
  return { k, d };
}

function bbandsSeries(
  values: number[],
  period = 20,
  stdDev = 2
): { upper: number[]; mid: number[]; lower: number[]; widthPct: number[] } {
  const n = values.length;
  const mid = smaSeries(values, period);
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  const widthPct = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const m = mid[i];
    if (!Number.isFinite(m)) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - m;
      sumSq += diff * diff;
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = m + stdDev * sd;
    lower[i] = m - stdDev * sd;
    widthPct[i] = m > 0 ? ((upper[i] - lower[i]) / m) * 100 : NaN;
  }
  return { upper, mid, lower, widthPct };
}

function keltnerSeries(
  bars: StrategyCandle[],
  period = 20,
  mult = 1.5
): { upper: number[]; mid: number[]; lower: number[] } {
  const n = bars.length;
  const mid = emaSeries(getSourceSeries(bars, 'close'), period);
  const atr = atrSeries(bars, period);
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(mid[i]) && Number.isFinite(atr[i])) {
      upper[i] = mid[i] + mult * atr[i];
      lower[i] = mid[i] - mult * atr[i];
    }
  }
  return { upper, mid, lower };
}

/**
 * Shifted 1-bar Donchian channel (prior `period` bars excluding current bar)
 * so `close > donchian.upper` naturally tests breakouts without self-inclusion lookahead.
 */
function donchianSeries(
  bars: StrategyCandle[],
  period = 20
): { upper: number[]; mid: number[]; lower: number[] } {
  const n = bars.length;
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  const mid = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
    mid[i] = (hi + lo) / 2;
  }
  return { upper, mid, lower };
}

function cciSeries(bars: StrategyCandle[], period = 20): number[] {
  const n = bars.length;
  const tp = getSourceSeries(bars, 'hlc3');
  const ma = smaSeries(tp, period);
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const m = ma[i];
    if (!Number.isFinite(m)) continue;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) {
      md += Math.abs(tp[j] - m);
    }
    md /= period;
    out[i] = md > 0 ? (tp[i] - m) / (0.015 * md) : 0;
  }
  return out;
}

function willrSeries(bars: StrategyCandle[], period = 14): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    const rng = hi - lo;
    out[i] = rng > 0 ? ((hi - bars[i].close) / rng) * -100 : -50;
  }
  return out;
}

function sessionVwapSeries(bars: StrategyCandle[]): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  let curDay = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const day = Math.floor(bars[i].ts / 86400);
    if (day !== curDay) {
      curDay = day;
      pv = 0;
      vol = 0;
    }
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const w = bars[i].volume > 0 ? bars[i].volume : 1;
    pv += tp * w;
    vol += w;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

function prevDayLevels(bars: StrategyCandle[]): {
  high: number[];
  low: number[];
  close: number[];
} {
  const n = bars.length;
  const high = new Array<number>(n).fill(NaN);
  const low = new Array<number>(n).fill(NaN);
  const close = new Array<number>(n).fill(NaN);
  let curDay = -1;
  let dayHi = -Infinity;
  let dayLo = Infinity;
  let dayCl = NaN;
  let prevHi = NaN;
  let prevLo = NaN;
  let prevCl = NaN;

  for (let i = 0; i < n; i++) {
    const day = Math.floor(bars[i].ts / 86400);
    if (day !== curDay) {
      if (curDay !== -1) {
        prevHi = dayHi;
        prevLo = dayLo;
        prevCl = dayCl;
      }
      curDay = day;
      dayHi = bars[i].high;
      dayLo = bars[i].low;
      dayCl = bars[i].close;
    } else {
      if (bars[i].high > dayHi) dayHi = bars[i].high;
      if (bars[i].low < dayLo) dayLo = bars[i].low;
      dayCl = bars[i].close;
    }
    high[i] = prevHi;
    low[i] = prevLo;
    close[i] = prevCl;
  }
  return { high, low, close };
}

function aggregateBarsToHtf(bars: StrategyCandle[], targetSec: number): StrategyCandle[] {
  const out: StrategyCandle[] = [];
  let curBucket = -1;
  let cur: StrategyCandle | null = null;
  for (const b of bars) {
    const bucket = Math.floor(b.ts / targetSec) * targetSec;
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = {
        ...b,
        ts: bucket,
        closeTs: bucket + targetSec
      };
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.bidH = Math.max(cur.bidH, b.bidH);
      cur.bidL = Math.min(cur.bidL, b.bidL);
      cur.bidC = b.bidC;
      cur.askH = Math.max(cur.askH, b.askH);
      cur.askL = Math.min(cur.askL, b.askL);
      cur.askC = b.askC;
      cur.volume += b.volume;
      cur.spread = b.spread;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Maps an HTF indicator series onto execution bars with STRICT causal closed-bar alignment:
 * execution bar `i` only sees HTF candle `h` where `htfBars[h].closeTs <= bars[i].closeTs`.
 * Unfinished higher-timeframe candles are completely invisible (zero lookahead bias).
 */
function alignHtfSeriesCausally(
  execBars: StrategyCandle[],
  htfBars: StrategyCandle[],
  htfValues: number[]
): number[] {
  const n = execBars.length;
  const out = new Array<number>(n).fill(NaN);
  let hIdx = -1;
  for (let i = 0; i < n; i++) {
    const ct = execBars[i].closeTs;
    while (hIdx + 1 < htfBars.length && htfBars[hIdx + 1].closeTs <= ct) {
      hIdx++;
    }
    if (hIdx >= 0) {
      out[i] = htfValues[hIdx];
    }
  }
  return out;
}

function computeSingleIndicatorOnBars(
  def: IndicatorDef,
  bars: StrategyCandle[]
): Record<string, number[]> {
  const p = Math.max(1, Math.min(400, Math.round(def.period ?? 14)));
  const src = getSourceSeries(bars, def.source ?? 'close');

  switch (def.fn) {
    case 'ema':
      return { '': emaSeries(src, p) };
    case 'sma':
      return { '': smaSeries(src, p) };
    case 'wma':
      return { '': wmaSeries(src, p) };
    case 'hma':
      return { '': hmaSeries(src, p) };
    case 'vwma':
      return { '': vwmaSeries(bars, p) };
    case 'rsi':
      return { '': rsiSeries(src, p) };
    case 'atr':
      return { '': atrSeries(bars, p) };
    case 'adx': {
      const r = adxSeries(bars, p);
      return { '': r.adx, adx: r.adx, plusDi: r.plusDi, minusDi: r.minusDi };
    }
    case 'macd': {
      const r = macdSeries(src, def.fast ?? 12, def.slow ?? 26, def.signal ?? 9);
      return { '': r.macd, macd: r.macd, signal: r.signal, hist: r.hist };
    }
    case 'stoch': {
      const r = stochSeries(bars, def.kPeriod ?? def.period ?? 14, def.dPeriod ?? 3);
      return { '': r.k, k: r.k, d: r.d };
    }
    case 'bbands': {
      const r = bbandsSeries(src, def.period ?? 20, def.stdDev ?? def.mult ?? 2);
      return { '': r.mid, upper: r.upper, mid: r.mid, lower: r.lower, widthPct: r.widthPct };
    }
    case 'keltner': {
      const r = keltnerSeries(bars, def.period ?? 20, def.mult ?? 1.5);
      return { '': r.mid, upper: r.upper, mid: r.mid, lower: r.lower };
    }
    case 'donchian': {
      const r = donchianSeries(bars, def.period ?? 20);
      return { '': r.mid, upper: r.upper, mid: r.mid, lower: r.lower };
    }
    case 'cci':
      return { '': cciSeries(bars, def.period ?? 20) };
    case 'willr':
      return { '': willrSeries(bars, def.period ?? 14) };
    case 'session_vwap':
      return { '': sessionVwapSeries(bars) };
    case 'swing_high': {
      const r = donchianSeries(bars, def.period ?? 10);
      return { '': r.upper };
    }
    case 'swing_low': {
      const r = donchianSeries(bars, def.period ?? 10);
      return { '': r.lower };
    }
    case 'prev_day_high':
      return { '': prevDayLevels(bars).high };
    case 'prev_day_low':
      return { '': prevDayLevels(bars).low };
    case 'prev_day_close':
      return { '': prevDayLevels(bars).close };
    default:
      return { '': emaSeries(src, p) };
  }
}

export function computeIndicatorEnv(
  bars: StrategyCandle[],
  execTf: StrategyTimeframe,
  indicators: IndicatorDef[]
): IndicatorEnv {
  const env: IndicatorEnv = new Map();
  const execSec = timeframeToSeconds(execTf);
  const htfCache = new Map<StrategyTimeframe, StrategyCandle[]>();

  // Always attach a built-in default ATR(14) fallback for safety
  env.set('__atr14', atrSeries(bars, 14));

  for (const def of indicators) {
    if (!def.id || typeof def.id !== 'string') continue;
    const useHtf = def.tf && timeframeToSeconds(def.tf) > execSec;

    if (useHtf && def.tf) {
      let htfBars = htfCache.get(def.tf);
      if (!htfBars) {
        htfBars = aggregateBarsToHtf(bars, timeframeToSeconds(def.tf));
        htfCache.set(def.tf, htfBars);
      }
      const computed = computeSingleIndicatorOnBars(def, htfBars);
      for (const [subKey, series] of Object.entries(computed)) {
        const aligned = alignHtfSeriesCausally(bars, htfBars, series);
        const fullKey = subKey ? `${def.id}.${subKey}` : def.id;
        env.set(fullKey, aligned);
      }
    } else {
      const computed = computeSingleIndicatorOnBars(def, bars);
      for (const [subKey, series] of Object.entries(computed)) {
        const fullKey = subKey ? `${def.id}.${subKey}` : def.id;
        env.set(fullKey, series);
      }
    }
  }

  return env;
}

export function resolveValueAt(
  ref: ValueRef,
  barIndex: number,
  bars: StrategyCandle[],
  env: IndicatorEnv
): number {
  if (typeof ref === 'number') return Number.isFinite(ref) ? ref : NaN;
  if (typeof ref !== 'string') return NaN;

  const trimmed = ref.trim();
  // Numeric literal passed as string
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  // Parse optional positive-only lookback offset e.g. close[1], rsi14[2] (negative lookahead impossible!)
  let key = trimmed;
  let offset = 0;
  const m = trimmed.match(/^([a-zA-Z0-9_.-]+)\[(\d+)\]$/);
  if (m) {
    key = m[1];
    offset = Math.min(200, Math.max(0, Number(m[2])));
  }

  const idx = barIndex - offset;
  if (idx < 0 || idx >= bars.length) return NaN;

  const b = bars[idx];
  switch (key) {
    case 'open':
      return b.open;
    case 'high':
      return b.high;
    case 'low':
      return b.low;
    case 'close':
      return b.close;
    case 'volume':
      return b.volume;
    case 'spread':
      return b.spread;
    case 'hl2':
      return (b.high + b.low) / 2;
    case 'hlc3':
      return (b.high + b.low + b.close) / 3;
    default: {
      const series = env.get(key);
      if (!series || idx >= series.length) return NaN;
      return series[idx];
    }
  }
}

export function evaluateConditionAt(
  node: ConditionNode | null | undefined,
  barIndex: number,
  bars: StrategyCandle[],
  env: IndicatorEnv
): boolean {
  if (!node) return false;

  switch (node.op) {
    case 'and':
      return Array.isArray(node.args) && node.args.length > 0
        ? node.args.every((arg) => evaluateConditionAt(arg, barIndex, bars, env))
        : false;
    case 'or':
      return Array.isArray(node.args) && node.args.length > 0
        ? node.args.some((arg) => evaluateConditionAt(arg, barIndex, bars, env))
        : false;
    case 'not':
      return !evaluateConditionAt(node.arg, barIndex, bars, env);
    case 'gt': {
      const l = resolveValueAt(node.left, barIndex, bars, env);
      const r = resolveValueAt(node.right, barIndex, bars, env);
      return Number.isFinite(l) && Number.isFinite(r) && l > r;
    }
    case 'gte': {
      const l = resolveValueAt(node.left, barIndex, bars, env);
      const r = resolveValueAt(node.right, barIndex, bars, env);
      return Number.isFinite(l) && Number.isFinite(r) && l >= r;
    }
    case 'lt': {
      const l = resolveValueAt(node.left, barIndex, bars, env);
      const r = resolveValueAt(node.right, barIndex, bars, env);
      return Number.isFinite(l) && Number.isFinite(r) && l < r;
    }
    case 'lte': {
      const l = resolveValueAt(node.left, barIndex, bars, env);
      const r = resolveValueAt(node.right, barIndex, bars, env);
      return Number.isFinite(l) && Number.isFinite(r) && l <= r;
    }
    case 'crosses_above': {
      if (barIndex < 1) return false;
      const lNow = resolveValueAt(node.left, barIndex, bars, env);
      const rNow = resolveValueAt(node.right, barIndex, bars, env);
      const lPrev = resolveValueAt(node.left, barIndex - 1, bars, env);
      const rPrev = resolveValueAt(node.right, barIndex - 1, bars, env);
      return (
        Number.isFinite(lNow) &&
        Number.isFinite(rNow) &&
        Number.isFinite(lPrev) &&
        Number.isFinite(rPrev) &&
        lPrev <= rPrev &&
        lNow > rNow
      );
    }
    case 'crosses_below': {
      if (barIndex < 1) return false;
      const lNow = resolveValueAt(node.left, barIndex, bars, env);
      const rNow = resolveValueAt(node.right, barIndex, bars, env);
      const lPrev = resolveValueAt(node.left, barIndex - 1, bars, env);
      const rPrev = resolveValueAt(node.right, barIndex - 1, bars, env);
      return (
        Number.isFinite(lNow) &&
        Number.isFinite(rNow) &&
        Number.isFinite(lPrev) &&
        Number.isFinite(rPrev) &&
        lPrev >= rPrev &&
        lNow < rNow
      );
    }
    case 'between': {
      const v = resolveValueAt(node.value, barIndex, bars, env);
      return Number.isFinite(v) && v >= node.min && v <= node.max;
    }
    case 'rising': {
      const lookback = Math.max(1, Math.min(20, Math.round(node.bars ?? 1)));
      if (barIndex < lookback) return false;
      const nowV = resolveValueAt(node.value, barIndex, bars, env);
      const prevV = resolveValueAt(node.value, barIndex - lookback, bars, env);
      return Number.isFinite(nowV) && Number.isFinite(prevV) && nowV > prevV;
    }
    case 'falling': {
      const lookback = Math.max(1, Math.min(20, Math.round(node.bars ?? 1)));
      if (barIndex < lookback) return false;
      const nowV = resolveValueAt(node.value, barIndex, bars, env);
      const prevV = resolveValueAt(node.value, barIndex - lookback, bars, env);
      return Number.isFinite(nowV) && Number.isFinite(prevV) && nowV < prevV;
    }
    case 'session_utc': {
      const hr = new Date(bars[barIndex].ts * 1000).getUTCHours();
      const s = ((Math.floor(node.startHour) % 24) + 24) % 24;
      const e = ((Math.floor(node.endHour) % 24) + 24) % 24;
      if (s === e) return true;
      return s < e ? hr >= s && hr < e : hr >= s || hr < e;
    }
    case 'day_of_week': {
      const dow = new Date(bars[barIndex].ts * 1000).getUTCDay();
      return Array.isArray(node.days) && node.days.includes(dow);
    }
    case 'spread_below_atr': {
      const atr = resolveValueAt(node.atrId || '__atr14', barIndex, bars, env);
      if (!Number.isFinite(atr) || atr <= 0) return true;
      return bars[barIndex].spread <= atr * Math.max(0.01, node.maxRatio ?? 0.25);
    }
    default:
      return false;
  }
}

export function countLeafConditions(node: ConditionNode | null | undefined): number {
  if (!node) return 0;
  if (node.op === 'and' || node.op === 'or') {
    return (node.args ?? []).reduce((sum, a) => sum + countLeafConditions(a), 0);
  }
  if (node.op === 'not') {
    return countLeafConditions(node.arg);
  }
  return 1;
}
