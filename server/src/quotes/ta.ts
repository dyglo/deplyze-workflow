import type { OandaBar } from './oanda.js';

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function roundNum(v: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

export function computeEmaSeries(values: number[], period: number): number[] {
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

export function computeSma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  const v = sum / period;
  return Number.isFinite(v) ? v : null;
}

export function computeWma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let num = 0;
  let den = 0;
  const start = values.length - period;
  for (let i = 0; i < period; i++) {
    const w = i + 1;
    num += values[start + i] * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

export function computeHullMa(values: number[], period = 9): number | null {
  const half = Math.max(1, Math.floor(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  if (values.length < period + sqrtP) return null;
  const rawSeries: number[] = [];
  for (let end = period; end <= values.length; end++) {
    const slice = values.slice(0, end);
    const wHalf = computeWma(slice, half);
    const wFull = computeWma(slice, period);
    if (wHalf != null && wFull != null) {
      rawSeries.push(2 * wHalf - wFull);
    }
  }
  return computeWma(rawSeries, sqrtP);
}

export function computeVwma(bars: OandaBar[], period = 20): number | null {
  if (bars.length < period) return null;
  let pv = 0;
  let vol = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const w = bars[i].volume > 0 ? bars[i].volume : 1;
    pv += bars[i].close * w;
    vol += w;
  }
  return vol > 0 ? pv / vol : null;
}

export function computeIchimokuBaseLine(bars: OandaBar[], period = 26): number | null {
  if (bars.length < period) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = bars.length - period; i < bars.length; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low < lo) lo = bars[i].low;
  }
  return Number.isFinite(hi) && Number.isFinite(lo) ? (hi + lo) / 2 : null;
}

export function computeWilderRsiSeries(closes: number[], period = 14): number[] {
  if (closes.length < period + 2) return [];
  const out = new Array<number>(closes.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function computeWilderRsi(closes: number[], period = 14): number | null {
  const s = computeWilderRsiSeries(closes, period);
  if (s.length === 0) return null;
  const last = s[s.length - 1];
  return Number.isFinite(last) ? roundNum(last, 2) : null;
}

export function computeWilderAtr(bars: OandaBar[], period = 14): number | null {
  if (bars.length < period + 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prevClose),
        Math.abs(cur.low - prevClose)
      )
    );
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

export function computeWilderAdx(
  bars: OandaBar[],
  period = 14
): {
  adx: number;
  plusDi: number;
  minusDi: number;
  prevPlusDi: number | null;
  prevMinusDi: number | null;
} | null {
  if (bars.length < period * 2 + 2) return null;
  const trs: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    trs.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      )
    );
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDms.push(downMove > upMove && downMove > 0 ? downMove : 0);
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
  let prevPlusDi: number | null = null;
  let prevMinusDi: number | null = null;

  for (let i = period; i < trs.length; i++) {
    smTr = smTr - smTr / period + trs[i];
    smPlus = smPlus - smPlus / period + plusDms[i];
    smMinus = smMinus - smMinus / period + minusDms[i];
    if (smTr <= 0) continue;
    prevPlusDi = lastPlusDi;
    prevMinusDi = lastMinusDi;
    lastPlusDi = (smPlus / smTr) * 100;
    lastMinusDi = (smMinus / smTr) * 100;
    const denom = lastPlusDi + lastMinusDi;
    dxList.push(denom > 0 ? (Math.abs(lastPlusDi - lastMinusDi) / denom) * 100 : 0);
  }

  if (dxList.length < period) return null;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxList[i];
  adx /= period;
  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }

  return {
    adx: roundNum(adx, 2),
    plusDi: roundNum(lastPlusDi, 2),
    minusDi: roundNum(lastMinusDi, 2),
    prevPlusDi: prevPlusDi != null ? roundNum(prevPlusDi, 2) : null,
    prevMinusDi: prevMinusDi != null ? roundNum(prevMinusDi, 2) : null
  };
}

export function computeMacd(
  closes: number[]
): { macd: number; signal: number; hist: number } | null {
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

export function computeStoch(
  bars: OandaBar[],
  kPeriod = 14,
  dPeriod = 3
): { k: number; d: number; prevK: number | null; prevD: number | null } | null {
  if (bars.length < kPeriod + dPeriod + 1) return null;
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
  if (kVals.length < dPeriod + 1) return null;
  const avgTail = (endIdx: number) => {
    let s = 0;
    for (let i = endIdx - dPeriod + 1; i <= endIdx; i++) s += kVals[i];
    return s / dPeriod;
  };
  const lastIdx = kVals.length - 1;
  return {
    k: kVals[lastIdx],
    d: avgTail(lastIdx),
    prevK: kVals[lastIdx - 1],
    prevD: avgTail(lastIdx - 1)
  };
}

export function computeCci(
  bars: OandaBar[],
  period = 20
): { value: number; prev: number | null } | null {
  if (bars.length < period + 2) return null;
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const calcAt = (endIdx: number): number | null => {
    const slice = tp.slice(endIdx - period + 1, endIdx + 1);
    const mean = slice.reduce((s, x) => s + x, 0) / period;
    const meanDev = slice.reduce((s, x) => s + Math.abs(x - mean), 0) / period;
    if (meanDev === 0) return 0;
    return (tp[endIdx] - mean) / (0.015 * meanDev);
  };
  const val = calcAt(tp.length - 1);
  if (val === null) return null;
  return { value: val, prev: calcAt(tp.length - 2) };
}

export function computeAwesomeOscillator(
  bars: OandaBar[]
): { ao: number; ao1: number | null; ao2: number | null } | null {
  if (bars.length < 38) return null;
  const med = bars.map((b) => (b.high + b.low) / 2);
  const aoAt = (end: number): number | null => {
    const s5 = computeSma(med.slice(0, end), 5);
    const s34 = computeSma(med.slice(0, end), 34);
    return s5 != null && s34 != null ? s5 - s34 : null;
  };
  const ao = aoAt(med.length);
  if (ao === null) return null;
  return { ao, ao1: aoAt(med.length - 1), ao2: aoAt(med.length - 2) };
}

export function computeWilliamsR(bars: OandaBar[], period = 14): number | null {
  if (bars.length < period) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = bars.length - period; i < bars.length; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low < lo) lo = bars[i].low;
  }
  const span = hi - lo;
  return span > 0 ? ((hi - bars[bars.length - 1].close) / span) * -100 : -50;
}

export function computeBullBearPower(bars: OandaBar[], period = 13): number | null {
  if (bars.length < period + 2) return null;
  const ema13 = computeEmaSeries(
    bars.map((b) => b.close),
    period
  );
  const e = ema13[ema13.length - 1];
  if (!Number.isFinite(e)) return null;
  const last = bars[bars.length - 1];
  return last.high - e + (last.low - e);
}

export function aggregateBars(bars: OandaBar[], bucketSec: number): OandaBar[] {
  if (bars.length === 0) return [];
  const buckets = new Map<number, OandaBar>();
  for (const b of bars) {
    const key = Math.floor(b.ts / bucketSec) * bucketSec;
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

export function scoreTimeframeTechnicals(
  bars: OandaBar[]
): { maScore: number; oscScore: number; allScore: number } | null {
  if (bars.length < 22) return null;
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];

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
    maScore: roundNum(maScore, 3),
    oscScore: roundNum(oscScore, 3),
    allScore: roundNum(allScore, 3)
  };
}

/**
 * Multi-timeframe institutional score matching Screener v0.1.21:
 * 1D (45%) + 4H (35%) + 1H (20%).
 */
export function computeMtfInstitutionalScore(
  dailyBars: OandaBar[],
  h1Bars: OandaBar[]
): { maScore: number | null; oscScore: number | null; allScore: number | null } {
  const h4Bars = h1Bars.length >= 20 ? aggregateBars(h1Bars, 14_400) : [];
  const ta1D = scoreTimeframeTechnicals(dailyBars);
  const ta4H = scoreTimeframeTechnicals(h4Bars);
  const ta1H = scoreTimeframeTechnicals(h1Bars);

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

  if (wSum <= 0) {
    return { maScore: null, oscScore: null, allScore: null };
  }
  const maScore = roundNum(maAccum / wSum, 3);
  const oscScore = roundNum(oscAccum / wSum, 3);
  const allScore = roundNum(clamp(maScore * 0.58 + oscScore * 0.42, -1, 1), 3);
  return { maScore, oscScore, allScore };
}
