import {
  computeIndicatorEnv,
  countLeafConditions,
  evaluateConditionAt,
  resolveValueAt,
  type IndicatorEnv
} from './indicators.js';
import {
  computeNotionalUsd,
  computePnlUsd,
  computeQtyForDollarRisk,
  getStrategyInstrumentSpec,
  normalizeShortTicker,
  roundQtyToStep,
  roundToTick
} from './instruments.js';
import {
  normalizeStrategyTimeframe,
  type BacktestReport,
  type BacktestTrade,
  type ConditionNode,
  type EquityCurvePoint,
  type ExcursionPoint,
  type HistoryFetchResult,
  type IndicatorDef,
  type IndicatorFn,
  type LiveStrategyEvaluation,
  type MonthlyReturnRow,
  type ReturnBucketRow,
  type SegmentMetrics,
  type StrategyCandle,
  type StrategyIterationStep,
  type StrategyRiskConfig,
  type StrategySpec,
  type StrategyVerdict,
  type StreakDistRow,
  type TimePatternRow,
  type TradeExitReason
} from './types.js';

const VALID_INDICATOR_FNS = new Set<IndicatorFn>([
  'ema',
  'sma',
  'wma',
  'hma',
  'vwma',
  'rsi',
  'atr',
  'adx',
  'macd',
  'stoch',
  'bbands',
  'keltner',
  'donchian',
  'cci',
  'willr',
  'session_vwap',
  'swing_high',
  'swing_low',
  'prev_day_high',
  'prev_day_low',
  'prev_day_close'
]);

const MAX_LEAVES_PER_SIDE = 5;
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

function trimConditionLeaves(node: ConditionNode | null | undefined, maxLeaves: number): ConditionNode | null {
  if (!node) return null;
  if (countLeafConditions(node) <= maxLeaves) return node;
  if (node.op === 'and' || node.op === 'or') {
    const kept: ConditionNode[] = [];
    let used = 0;
    for (const arg of node.args ?? []) {
      const c = countLeafConditions(arg);
      if (used + c <= maxLeaves) {
        kept.push(arg);
        used += c;
      } else if (used < maxLeaves) {
        const sub = trimConditionLeaves(arg, maxLeaves - used);
        if (sub) {
          kept.push(sub);
          used += countLeafConditions(sub);
        }
      }
      if (used >= maxLeaves) break;
    }
    return kept.length === 1 ? kept[0] : kept.length > 1 ? { op: node.op, args: kept } : null;
  }
  return node;
}

export function validateAndSanitizeStrategySpec(
  raw: Partial<StrategySpec>,
  fallback: { symbol: string; shortName: string; interval?: string }
): StrategySpec {
  const symbol = (raw.symbol || fallback.symbol || 'OANDA:XAUUSD').trim().toUpperCase();
  const shortName = normalizeShortTicker(raw.shortName || symbol || fallback.shortName);
  const interval = normalizeStrategyTimeframe(raw.interval || fallback.interval || '1h');
  const direction: 'long' | 'short' | 'both' =
    raw.direction === 'long' || raw.direction === 'short' ? raw.direction : 'both';

  const indicators: IndicatorDef[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(raw.indicators)) {
    for (const ind of raw.indicators.slice(0, 12)) {
      if (!ind || typeof ind.id !== 'string' || !VALID_INDICATOR_FNS.has(ind.fn)) continue;
      const cleanId = ind.id.trim().replace(/[^a-zA-Z0-9_]/g, '');
      if (!cleanId || seenIds.has(cleanId)) continue;
      seenIds.add(cleanId);
      indicators.push({
        id: cleanId,
        fn: ind.fn,
        period: ind.period !== undefined ? Math.round(clampNum(Number(ind.period), 2, 400, 14)) : undefined,
        fast: ind.fast !== undefined ? Math.round(clampNum(Number(ind.fast), 2, 100, 12)) : undefined,
        slow: ind.slow !== undefined ? Math.round(clampNum(Number(ind.slow), 4, 250, 26)) : undefined,
        signal: ind.signal !== undefined ? Math.round(clampNum(Number(ind.signal), 2, 60, 9)) : undefined,
        kPeriod: ind.kPeriod !== undefined ? Math.round(clampNum(Number(ind.kPeriod), 2, 100, 14)) : undefined,
        dPeriod: ind.dPeriod !== undefined ? Math.round(clampNum(Number(ind.dPeriod), 1, 30, 3)) : undefined,
        mult: ind.mult !== undefined ? clampNum(Number(ind.mult), 0.2, 8, 2) : undefined,
        stdDev: ind.stdDev !== undefined ? clampNum(Number(ind.stdDev), 0.2, 5, 2) : undefined,
        source: ind.source,
        tf: ind.tf ? normalizeStrategyTimeframe(ind.tf) : undefined
      });
    }
  }

  const rawRisk = raw.risk ?? ({} as Partial<StrategyRiskConfig>);
  const rawSl = rawRisk.stopLoss ?? { type: 'atr_mult', mult: 1.5 };
  const rawTp = rawRisk.takeProfit ?? { type: 'rr_multiple', rr: 2.0 };
  const rawTrail = rawRisk.trailingStop ?? { type: 'none' };

  const slType: StrategyRiskConfig['stopLoss']['type'] =
    rawSl.type === 'pct' || rawSl.type === 'pips' || rawSl.type === 'swing' ? rawSl.type : 'atr_mult';
  const tpType: StrategyRiskConfig['takeProfit']['type'] =
    rawTp.type === 'atr_mult' || rawTp.type === 'pct' || rawTp.type === 'pips' || rawTp.type === 'none'
      ? rawTp.type
      : 'rr_multiple';
  const trailType: NonNullable<StrategyRiskConfig['trailingStop']>['type'] =
    rawTrail.type === 'atr_mult' || rawTrail.type === 'breakeven_at_r' ? rawTrail.type : 'none';

  const risk: StrategyRiskConfig = {
    initialCapital: clampNum(Number(rawRisk.initialCapital ?? 10000), 100, 10_000_000, 10000),
    sizingMode:
      rawRisk.sizingMode === 'fixed_notional' || rawRisk.sizingMode === 'fixed_units'
        ? rawRisk.sizingMode
        : 'risk_pct',
    riskPct: clampNum(Number(rawRisk.riskPct ?? 1.0), 0.1, 10, 1.0),
    fixedNotionalUsd:
      rawRisk.fixedNotionalUsd !== undefined
        ? clampNum(Number(rawRisk.fixedNotionalUsd), 50, 5_000_000, 5000)
        : undefined,
    fixedUnits:
      rawRisk.fixedUnits !== undefined ? clampNum(Number(rawRisk.fixedUnits), 0.001, 1_000_000, 1) : undefined,
    stopLoss: {
      type: slType,
      atrId: rawSl.atrId,
      mult: clampNum(Number(rawSl.mult ?? 1.5), 0.3, 10, 1.5),
      pct: clampNum(Number(rawSl.pct ?? 0.75), 0.05, 15, 0.75),
      pips: clampNum(Number(rawSl.pips ?? 30), 2, 5000, 30),
      lookback: Math.round(clampNum(Number(rawSl.lookback ?? 10), 3, 60, 10))
    },
    takeProfit: {
      type: tpType,
      rr: clampNum(Number(rawTp.rr ?? 2.0), 0.4, 12, 2.0),
      atrId: rawTp.atrId,
      mult: clampNum(Number(rawTp.mult ?? 3.0), 0.4, 20, 3.0),
      pct: clampNum(Number(rawTp.pct ?? 1.5), 0.05, 40, 1.5),
      pips: clampNum(Number(rawTp.pips ?? 60), 2, 10000, 60)
    },
    trailingStop: {
      type: trailType,
      atrId: rawTrail.atrId,
      mult: clampNum(Number(rawTrail.mult ?? 2.0), 0.5, 10, 2.0),
      triggerR: clampNum(Number(rawTrail.triggerR ?? 1.0), 0.3, 5, 1.0)
    },
    maxBarsInTrade:
      typeof rawRisk.maxBarsInTrade === 'number' && Number.isFinite(rawRisk.maxBarsInTrade) && rawRisk.maxBarsInTrade > 0
        ? Math.round(clampNum(rawRisk.maxBarsInTrade, 2, 500, 48))
        : null,
    cooldownBars: Math.round(clampNum(Number(rawRisk.cooldownBars ?? 1), 0, 50, 1)),
    slippageTicks: clampNum(Number(rawRisk.slippageTicks ?? 0.5), 0, 50, 0.5),
    commissionPerLotUsd: clampNum(Number(rawRisk.commissionPerLotUsd ?? 0), 0, 50, 0),
    zeroCostDiagnostic: Boolean(rawRisk.zeroCostDiagnostic),
    oosFraction: clampNum(Number(rawRisk.oosFraction ?? 0.3), 0.15, 0.45, 0.3)
  };

  const entryLong = direction === 'short' ? null : trimConditionLeaves(raw.entryLong, MAX_LEAVES_PER_SIDE);
  const entryShort = direction === 'long' ? null : trimConditionLeaves(raw.entryShort, MAX_LEAVES_PER_SIDE);

  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : `strat_${shortName.toLowerCase()}_${Date.now().toString(36)}`;

  return {
    id,
    name: (raw.name || `${shortName} Strategy v${raw.version ?? 1}`).trim().slice(0, 64),
    description: (raw.description || '').trim().slice(0, 400),
    version: Math.max(1, Math.round(Number(raw.version ?? 1))),
    symbol,
    shortName,
    interval,
    direction,
    indicators,
    entryLong,
    entryShort,
    exitLong: raw.exitLong ? trimConditionLeaves(raw.exitLong, 4) : null,
    exitShort: raw.exitShort ? trimConditionLeaves(raw.exitShort, 4) : null,
    risk,
    ruleSummary: Array.isArray(raw.ruleSummary)
      ? raw.ruleSummary.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 10)
      : []
  };
}

function computeStopAndTargetPrices(
  spec: StrategySpec,
  side: 'long' | 'short',
  entryPrice: number,
  signalBarIdx: number,
  bars: StrategyCandle[],
  env: IndicatorEnv
): { stopLoss: number | null; takeProfit: number | null; riskDist: number } {
  const inst = getStrategyInstrumentSpec(spec.symbol);
  const slCfg = spec.risk.stopLoss;
  const tpCfg = spec.risk.takeProfit;
  const atrVal = resolveValueAt(slCfg.atrId || '__atr14', signalBarIdx, bars, env);
  const fallbackAtr = Number.isFinite(atrVal) && atrVal > 0 ? atrVal : entryPrice * 0.004;

  let stopDist = fallbackAtr * (slCfg.mult ?? 1.5);
  if (slCfg.type === 'pct') {
    stopDist = entryPrice * ((slCfg.pct ?? 0.75) / 100);
  } else if (slCfg.type === 'pips') {
    stopDist = (slCfg.pips ?? 30) * inst.pipSize;
  } else if (slCfg.type === 'swing') {
    const lb = Math.max(3, slCfg.lookback ?? 10);
    const start = Math.max(0, signalBarIdx - lb + 1);
    if (side === 'long') {
      let lo = Infinity;
      for (let j = start; j <= signalBarIdx; j++) lo = Math.min(lo, bars[j].low);
      if (Number.isFinite(lo) && lo < entryPrice) {
        stopDist = entryPrice - lo + fallbackAtr * 0.15;
      }
    } else {
      let hi = -Infinity;
      for (let j = start; j <= signalBarIdx; j++) hi = Math.max(hi, bars[j].high);
      if (Number.isFinite(hi) && hi > entryPrice) {
        stopDist = hi - entryPrice + fallbackAtr * 0.15;
      }
    }
  }

  // Enforce reasonable non-zero stop distance floor (at least 2x spread or 4 ticks)
  const minDist = Math.max(inst.tickSize * 4, bars[signalBarIdx].spread * 2);
  stopDist = Math.max(minDist, stopDist);
  const stopLoss = roundToTick(side === 'long' ? entryPrice - stopDist : entryPrice + stopDist, spec.symbol);

  let takeProfit: number | null = null;
  if (tpCfg.type === 'rr_multiple') {
    const tpDist = stopDist * (tpCfg.rr ?? 2.0);
    takeProfit = roundToTick(side === 'long' ? entryPrice + tpDist : entryPrice - tpDist, spec.symbol);
  } else if (tpCfg.type === 'atr_mult') {
    const tpAtr = resolveValueAt(tpCfg.atrId || '__atr14', signalBarIdx, bars, env);
    const baseAtr = Number.isFinite(tpAtr) && tpAtr > 0 ? tpAtr : fallbackAtr;
    const tpDist = baseAtr * (tpCfg.mult ?? 3.0);
    takeProfit = roundToTick(side === 'long' ? entryPrice + tpDist : entryPrice - tpDist, spec.symbol);
  } else if (tpCfg.type === 'pct') {
    const tpDist = entryPrice * ((tpCfg.pct ?? 1.5) / 100);
    takeProfit = roundToTick(side === 'long' ? entryPrice + tpDist : entryPrice - tpDist, spec.symbol);
  } else if (tpCfg.type === 'pips') {
    const tpDist = (tpCfg.pips ?? 60) * inst.pipSize;
    takeProfit = roundToTick(side === 'long' ? entryPrice + tpDist : entryPrice - tpDist, spec.symbol);
  }

  return { stopLoss, takeProfit, riskDist: stopDist };
}

function computePositionQty(
  spec: StrategySpec,
  equityUsd: number,
  entryPrice: number,
  stopLoss: number | null
): number {
  const inst = getStrategyInstrumentSpec(spec.symbol);
  const maxNotional = equityUsd * 20; // cap effective leverage at 20x for realistic margin discipline

  if (spec.risk.sizingMode === 'fixed_units' && spec.risk.fixedUnits) {
    return roundQtyToStep(spec.risk.fixedUnits, inst);
  }
  if (spec.risk.sizingMode === 'fixed_notional' && spec.risk.fixedNotionalUsd) {
    const target = Math.min(spec.risk.fixedNotionalUsd, maxNotional);
    const raw = inst.isUsdBaseFx ? target : target / entryPrice;
    return roundQtyToStep(raw, inst);
  }

  // Default: risk_pct of current equity
  const riskUsd = Math.max(1, equityUsd * (spec.risk.riskPct / 100));
  const sl = stopLoss ?? entryPrice * 0.99;
  return computeQtyForDollarRisk(spec.symbol, entryPrice, sl, riskUsd, maxNotional);
}

interface OpenSimPos {
  tradeNumber: number;
  side: 'long' | 'short';
  segment: 'IS' | 'OOS';
  entryBarIdx: number;
  entryTs: number;
  entryMid: number;
  entryPrice: number;
  entrySpreadCostPerUnit: number;
  entrySlippagePerUnit: number;
  stopLoss: number | null;
  initialStopLoss: number | null;
  takeProfit: number | null;
  quantity: number;
  notionalUsd: number;
  equityAtEntry: number;
  initialRiskUsd: number | null;
  mfePriceMove: number; // favorable price excursion (>= 0)
  maePriceMove: number; // adverse price excursion (<= 0)
  entrySignal: string;
}

function estimateWarmupBars(spec: StrategySpec, totalBars: number): number {
  let maxPeriod = 20;
  for (const ind of spec.indicators) {
    const p = Math.max(ind.period ?? 14, ind.slow ?? 0, ind.kPeriod ?? 0);
    if (p > maxPeriod) maxPeriod = p;
  }
  const desired = Math.max(50, Math.min(250, maxPeriod * 2));
  return Math.min(desired, Math.floor(totalBars * 0.2));
}

function buildSegmentMetrics(
  trades: BacktestTrade[],
  segmentBars: StrategyCandle[],
  initialCapital: number
): SegmentMetrics {
  const startCap = Math.max(100, initialCapital);
  const firstClose = segmentBars[0]?.close ?? 1;
  const lastClose = segmentBars[segmentBars.length - 1]?.close ?? firstClose;
  const buyAndHoldPct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  const buyAndHoldPnlUsd = startCap * (buyAndHoldPct / 100);

  // Build lookup of bar close price near trade timestamps for synchronized Buy & Hold curve
  const findCloseAtTs = (ts: number): number => {
    if (segmentBars.length === 0) return firstClose;
    let lo = 0;
    let hi = segmentBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segmentBars[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return segmentBars[lo]?.close ?? lastClose;
  };

  let equity = startCap;
  let peakEquity = startCap;
  let troughEquity = startCap;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  let maxRunupUsd = 0;
  let maxRunupPct = 0;
  let ddSum = 0;
  let ddSamples = 0;
  let runupSum = 0;
  let runupSamples = 0;

  const equityCurve: EquityCurvePoint[] = [];
  if (segmentBars.length > 0) {
    equityCurve.push({
      ts: segmentBars[0].ts,
      tradeNumber: 0,
      segment: trades[0]?.segment ?? 'IS',
      cumulativePnlUsd: 0,
      cumulativePnlPct: 0,
      equityUsd: round2(startCap),
      drawdownUsd: 0,
      drawdownPct: 0,
      buyAndHoldPnlUsd: 0,
      buyAndHoldPct: 0,
      tradePnlUsd: 0
    });
  }

  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let totalSpreadCostUsd = 0;
  let totalSlippageCostUsd = 0;
  let totalCommissionUsd = 0;

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let tradesLong = 0;
  let tradesShort = 0;
  let winsLong = 0;
  let winsShort = 0;
  let netPnlLongUsd = 0;
  let netPnlShortUsd = 0;
  let grossProfitLongUsd = 0;
  let grossLossLongUsd = 0;
  let grossProfitShortUsd = 0;
  let grossLossShortUsd = 0;

  let largestWinUsd = 0;
  let largestWinPct = 0;
  let largestLossUsd = 0;
  let largestLossPct = 0;
  let sumWinUsd = 0;
  let sumWinPct = 0;
  let sumLossUsd = 0;
  let sumLossPct = 0;
  let sumR = 0;
  let rCount = 0;
  let sumBars = 0;
  let sumBarsWin = 0;
  let sumBarsLoss = 0;
  let sumMfePct = 0;
  let sumMaePct = 0;
  let sumMfeR = 0;
  let sumMaeR = 0;
  let rExcursionCount = 0;

  let curWinStreak = 0;
  let curLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  const winStreaks: number[] = [];
  const lossStreaks: number[] = [];

  const monthlyMap = new Map<string, { pnlUsd: number; trades: number; wins: number }>();
  const hourMap = new Map<number, { trades: number; wins: number; pnlUsd: number }>();
  const dowMap = new Map<number, { trades: number; wins: number; pnlUsd: number }>();
  for (let h = 0; h < 24; h++) hourMap.set(h, { trades: 0, wins: 0, pnlUsd: 0 });
  for (let d = 0; d < 7; d++) dowMap.set(d, { trades: 0, wins: 0, pnlUsd: 0 });

  const tradeReturnsPct: number[] = [];
  const excursions: ExcursionPoint[] = [];

  for (const t of trades) {
    equity += t.netPnlUsd;
    const cumPnl = equity - startCap;
    const cumPct = (cumPnl / startCap) * 100;

    if (equity > peakEquity) peakEquity = equity;
    if (equity < troughEquity) troughEquity = equity;

    const ddUsd = Math.max(0, peakEquity - equity);
    const ddPct = peakEquity > 0 ? (ddUsd / peakEquity) * 100 : 0;
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    if (ddUsd > 0) {
      ddSum += ddUsd;
      ddSamples++;
    }

    const runupUsd = Math.max(0, equity - troughEquity);
    const runupPct = troughEquity > 0 ? (runupUsd / troughEquity) * 100 : 0;
    if (runupUsd > maxRunupUsd) maxRunupUsd = runupUsd;
    if (runupPct > maxRunupPct) maxRunupPct = runupPct;
    if (runupUsd > 0) {
      runupSum += runupUsd;
      runupSamples++;
    }

    const bhClose = findCloseAtTs(t.exitTs);
    const bhPct = firstClose > 0 ? ((bhClose - firstClose) / firstClose) * 100 : 0;
    const bhUsd = startCap * (bhPct / 100);

    equityCurve.push({
      ts: t.exitTs,
      tradeNumber: t.tradeNumber,
      segment: t.segment,
      cumulativePnlUsd: round2(cumPnl),
      cumulativePnlPct: round2(cumPct),
      equityUsd: round2(equity),
      drawdownUsd: round2(ddUsd),
      drawdownPct: round2(ddPct),
      buyAndHoldPnlUsd: round2(bhUsd),
      buyAndHoldPct: round2(bhPct),
      tradePnlUsd: round2(t.netPnlUsd)
    });

    totalSpreadCostUsd += t.spreadCostUsd;
    totalSlippageCostUsd += t.slippageCostUsd;
    totalCommissionUsd += t.commissionUsd;
    sumBars += t.barsHeld;
    sumMfePct += t.mfePct;
    sumMaePct += t.maePct;
    if (t.mfeR !== null && t.maeR !== null) {
      sumMfeR += t.mfeR;
      sumMaeR += t.maeR;
      rExcursionCount++;
    }
    if (t.realizedR !== null) {
      sumR += t.realizedR;
      rCount++;
    }

    tradeReturnsPct.push(t.returnPct);
    excursions.push({
      tradeNumber: t.tradeNumber,
      side: t.side,
      segment: t.segment,
      mfePct: round2(t.mfePct),
      maePct: round2(t.maePct),
      returnPct: round2(t.returnPct),
      netPnlUsd: round2(t.netPnlUsd)
    });

    if (t.side === 'long') {
      tradesLong++;
      netPnlLongUsd += t.netPnlUsd;
      if (t.netPnlUsd > 0.005) {
        winsLong++;
        grossProfitLongUsd += t.netPnlUsd;
      } else if (t.netPnlUsd < -0.005) {
        grossLossLongUsd += Math.abs(t.netPnlUsd);
      }
    } else {
      tradesShort++;
      netPnlShortUsd += t.netPnlUsd;
      if (t.netPnlUsd > 0.005) {
        winsShort++;
        grossProfitShortUsd += t.netPnlUsd;
      } else if (t.netPnlUsd < -0.005) {
        grossLossShortUsd += Math.abs(t.netPnlUsd);
      }
    }

    if (t.netPnlUsd > 0.005) {
      wins++;
      grossProfitUsd += t.netPnlUsd;
      sumWinUsd += t.netPnlUsd;
      sumWinPct += t.returnPct;
      sumBarsWin += t.barsHeld;
      if (t.netPnlUsd > largestWinUsd) {
        largestWinUsd = t.netPnlUsd;
        largestWinPct = t.returnPct;
      }
      curWinStreak++;
      if (curLossStreak > 0) {
        lossStreaks.push(curLossStreak);
        curLossStreak = 0;
      }
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else if (t.netPnlUsd < -0.005) {
      losses++;
      grossLossUsd += Math.abs(t.netPnlUsd);
      sumLossUsd += t.netPnlUsd;
      sumLossPct += t.returnPct;
      sumBarsLoss += t.barsHeld;
      if (t.netPnlUsd < largestLossUsd) {
        largestLossUsd = t.netPnlUsd;
        largestLossPct = t.returnPct;
      }
      curLossStreak++;
      if (curWinStreak > 0) {
        winStreaks.push(curWinStreak);
        curWinStreak = 0;
      }
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    } else {
      breakevens++;
    }

    // Monthly & Time patterns (indexed by entry timestamp UTC)
    const dt = new Date(t.entryTs * 1000);
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    const mRow = monthlyMap.get(ym) ?? { pnlUsd: 0, trades: 0, wins: 0 };
    mRow.pnlUsd += t.netPnlUsd;
    mRow.trades += 1;
    if (t.netPnlUsd > 0.005) mRow.wins += 1;
    monthlyMap.set(ym, mRow);

    const hr = dt.getUTCHours();
    const hRow = hourMap.get(hr)!;
    hRow.trades += 1;
    hRow.pnlUsd += t.netPnlUsd;
    if (t.netPnlUsd > 0.005) hRow.wins += 1;

    const dow = dt.getUTCDay();
    const dRow = dowMap.get(dow)!;
    dRow.trades += 1;
    dRow.pnlUsd += t.netPnlUsd;
    if (t.netPnlUsd > 0.005) dRow.wins += 1;
  }

  if (curWinStreak > 0) winStreaks.push(curWinStreak);
  if (curLossStreak > 0) lossStreaks.push(curLossStreak);

  const totalTrades = trades.length;
  const totalPnlUsd = equity - startCap;
  const totalPnlPct = (totalPnlUsd / startCap) * 100;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const profitFactor =
    grossLossUsd > 0.005 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0.005 ? 99.99 : 0;
  const totalCostUsd = totalSpreadCostUsd + totalSlippageCostUsd + totalCommissionUsd;
  const grossMidProfit = grossProfitUsd + totalCostUsd;
  const costPctOfGrossProfit =
    grossMidProfit > 0.01 ? round2((totalCostUsd / grossMidProfit) * 100) : null;

  const avgWinUsd = wins > 0 ? sumWinUsd / wins : 0;
  const avgWinPct = wins > 0 ? sumWinPct / wins : 0;
  const avgLossUsd = losses > 0 ? sumLossUsd / losses : 0;
  const avgLossPct = losses > 0 ? sumLossPct / losses : 0;
  const payoffRatio =
    losses > 0 && Math.abs(avgLossUsd) > 0.001 ? avgWinUsd / Math.abs(avgLossUsd) : null;

  const expectancyUsd = totalTrades > 0 ? totalPnlUsd / totalTrades : 0;
  const expectancyPct =
    totalTrades > 0
      ? tradeReturnsPct.reduce((s, r) => s + r, 0) / totalTrades
      : 0;
  const expectancyR = rCount > 0 ? sumR / rCount : null;

  // Outliers PnL (trades beyond mean +/- 2 std dev)
  let outliersPnlUsd = 0;
  if (totalTrades >= 6) {
    const meanPnl = totalPnlUsd / totalTrades;
    const variance =
      trades.reduce((s, t) => s + Math.pow(t.netPnlUsd - meanPnl, 2), 0) / totalTrades;
    const sd = Math.sqrt(variance);
    if (sd > 0) {
      for (const t of trades) {
        if (Math.abs(t.netPnlUsd - meanPnl) > 2 * sd) outliersPnlUsd += t.netPnlUsd;
      }
    }
  }

  // Sharpe & Sortino (trade-return annualized approximation scaled by trade frequency)
  let sharpeRatio: number | null = null;
  let sortinoRatio: number | null = null;
  if (totalTrades >= 4) {
    const meanR = expectancyPct;
    const variance =
      tradeReturnsPct.reduce((s, r) => s + Math.pow(r - meanR, 2), 0) / (totalTrades - 1);
    const std = Math.sqrt(variance);
    const spanYears =
      segmentBars.length > 1
        ? Math.max(0.05, (segmentBars[segmentBars.length - 1].ts - segmentBars[0].ts) / (365.25 * 86400))
        : 1;
    const tradesPerYear = Math.min(500, totalTrades / spanYears);
    const annScale = Math.sqrt(tradesPerYear);
    if (std > 1e-6) {
      sharpeRatio = round2((meanR / std) * annScale);
    }
    const negR = tradeReturnsPct.filter((r) => r < 0);
    if (negR.length >= 2) {
      const downVar = negR.reduce((s, r) => s + r * r, 0) / negR.length;
      const downStd = Math.sqrt(downVar);
      if (downStd > 1e-6) {
        sortinoRatio = round2((meanR / downStd) * annScale);
      }
    }
  }

  const recoveryFactor = maxDdUsd > 0.01 ? round2(totalPnlUsd / maxDdUsd) : null;
  const spanYears =
    segmentBars.length > 1
      ? Math.max(0.08, (segmentBars[segmentBars.length - 1].ts - segmentBars[0].ts) / (365.25 * 86400))
      : 1;
  const cagrPct = (totalPnlPct / spanYears);
  const calmarRatio = maxDdPct > 0.01 ? round2(cagrPct / maxDdPct) : null;

  // Monthly returns sorted chronologically
  const monthlyReturns: MonthlyReturnRow[] = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, v]) => ({
      ym,
      pnlUsd: round2(v.pnlUsd),
      pnlPct: round2((v.pnlUsd / startCap) * 100),
      trades: v.trades,
      wins: v.wins,
      winRatePct: v.trades > 0 ? round2((v.wins / v.trades) * 100) : 0
    }));

  // Returns histogram (symmetric 0.5% or dynamic buckets around 0%, matching TradingView Image 4)
  const returnsHistogram = buildReturnsHistogram(tradeReturnsPct);

  const byHourUtc: TimePatternRow[] = Array.from(hourMap.entries()).map(([h, v]) => ({
    key: h,
    label: `${String(h).padStart(2, '0')}:00`,
    trades: v.trades,
    wins: v.wins,
    winRatePct: v.trades > 0 ? round2((v.wins / v.trades) * 100) : 0,
    pnlUsd: round2(v.pnlUsd)
  }));

  const byDayOfWeek: TimePatternRow[] = Array.from(dowMap.entries()).map(([d, v]) => ({
    key: d,
    label: DOW_LABELS[d],
    trades: v.trades,
    wins: v.wins,
    winRatePct: v.trades > 0 ? round2((v.wins / v.trades) * 100) : 0,
    pnlUsd: round2(v.pnlUsd)
  }));

  // Streak distribution
  const maxS = Math.max(1, maxWinStreak, maxLossStreak);
  const streakDist: StreakDistRow[] = [];
  for (let len = 1; len <= Math.min(maxS, 12); len++) {
    streakDist.push({
      length: len,
      winStreaks: winStreaks.filter((s) => s === len).length,
      lossStreaks: lossStreaks.filter((s) => s === len).length
    });
  }

  return {
    totalPnlUsd: round2(totalPnlUsd),
    totalPnlPct: round2(totalPnlPct),
    maxDrawdownUsd: round2(maxDdUsd),
    maxDrawdownPct: round2(maxDdPct),
    totalTrades,
    winningTrades: wins,
    losingTrades: losses,
    breakevenTrades: breakevens,
    winRatePct: round2(winRatePct),
    profitFactor: totalTrades > 0 ? round3(profitFactor) : null,

    grossProfitUsd: round2(grossProfitUsd),
    grossProfitPct: round2((grossProfitUsd / startCap) * 100),
    grossLossUsd: round2(grossLossUsd),
    grossLossPct: round2((grossLossUsd / startCap) * 100),
    totalSpreadCostUsd: round2(totalSpreadCostUsd),
    totalSlippageCostUsd: round2(totalSlippageCostUsd),
    totalCommissionUsd: round2(totalCommissionUsd),
    totalCostUsd: round2(totalCostUsd),
    costPctOfGrossProfit,

    tradesLong,
    tradesShort,
    winsLong,
    winsShort,
    winRateLongPct: tradesLong > 0 ? round2((winsLong / tradesLong) * 100) : 0,
    winRateShortPct: tradesShort > 0 ? round2((winsShort / tradesShort) * 100) : 0,
    netPnlLongUsd: round2(netPnlLongUsd),
    netPnlShortUsd: round2(netPnlShortUsd),
    grossProfitLongUsd: round2(grossProfitLongUsd),
    grossLossLongUsd: round2(grossLossLongUsd),
    grossProfitShortUsd: round2(grossProfitShortUsd),
    grossLossShortUsd: round2(grossLossShortUsd),

    buyAndHoldPnlUsd: round2(buyAndHoldPnlUsd),
    buyAndHoldPct: round2(buyAndHoldPct),
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    recoveryFactor,
    maxRunupUsd: round2(maxRunupUsd),
    maxRunupPct: round2(maxRunupPct),
    avgRunupUsd: runupSamples > 0 ? round2(runupSum / runupSamples) : 0,
    avgDrawdownUsd: ddSamples > 0 ? round2(ddSum / ddSamples) : 0,

    expectancyUsd: round2(expectancyUsd),
    expectancyPct: round2(expectancyPct),
    expectancyR: expectancyR !== null ? round2(expectancyR) : null,
    avgWinUsd: round2(avgWinUsd),
    avgWinPct: round2(avgWinPct),
    avgLossUsd: round2(avgLossUsd),
    avgLossPct: round2(avgLossPct),
    payoffRatio: payoffRatio !== null ? round2(payoffRatio) : null,
    largestWinUsd: round2(largestWinUsd),
    largestWinPct: round2(largestWinPct),
    largestLossUsd: round2(largestLossUsd),
    largestLossPct: round2(largestLossPct),
    outliersPnlUsd: round2(outliersPnlUsd),
    outliersPnlPct: round2((outliersPnlUsd / startCap) * 100),
    avgBarsHeld: totalTrades > 0 ? round2(sumBars / totalTrades) : 0,
    avgBarsWin: wins > 0 ? round2(sumBarsWin / wins) : 0,
    avgBarsLoss: losses > 0 ? round2(sumBarsLoss / losses) : 0,
    maxWinStreak,
    maxLossStreak,
    avgWinStreak:
      winStreaks.length > 0
        ? round2(winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length)
        : 0,
    avgLossStreak:
      lossStreaks.length > 0
        ? round2(lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length)
        : 0,
    avgMfePct: totalTrades > 0 ? round2(sumMfePct / totalTrades) : 0,
    avgMaePct: totalTrades > 0 ? round2(sumMaePct / totalTrades) : 0,
    avgMfeR: rExcursionCount > 0 ? round2(sumMfeR / rExcursionCount) : null,
    avgMaeR: rExcursionCount > 0 ? round2(sumMaeR / rExcursionCount) : null,

    equityCurve,
    monthlyReturns,
    returnsHistogram,
    byHourUtc,
    byDayOfWeek,
    streakDist,
    excursions
  };
}

function buildReturnsHistogram(returnsPct: number[]): ReturnBucketRow[] {
  if (returnsPct.length === 0) return [];
  const maxAbs = Math.max(1.5, ...returnsPct.map((r) => Math.abs(r)));
  const step = maxAbs <= 2.5 ? 0.5 : maxAbs <= 6 ? 1.0 : maxAbs <= 15 ? 2.0 : 5.0;
  const halfBuckets = Math.min(6, Math.max(3, Math.ceil(maxAbs / step)));

  const buckets: ReturnBucketRow[] = [];
  for (let k = -halfBuckets; k < halfBuckets; k++) {
    const minPct = round2(k * step);
    const maxPct = round2((k + 1) * step);
    const label = `${minPct >= 0 ? '' : ''}${minPct}%`;
    buckets.push({
      label,
      minPct,
      maxPct,
      count: 0,
      isPositive: minPct >= 0
    });
  }

  for (const r of returnsPct) {
    const idx = Math.floor(r / step) + halfBuckets;
    const clamped = Math.max(0, Math.min(buckets.length - 1, idx));
    buckets[clamped].count += 1;
  }

  return buckets;
}

export function classifyStrategyVerdict(
  all: SegmentMetrics,
  isSeg: SegmentMetrics,
  oosSeg: SegmentMetrics
): StrategyVerdict {
  const reasons: string[] = [];

  if (all.totalTrades === 0) {
    return {
      status: 'no_edge',
      label: 'No Trades Triggered',
      summary: 'The entry rules never fired on this history window.',
      reasons: ['0 trades executed after indicator warmup.']
    };
  }

  if (all.totalTrades < 20 || oosSeg.totalTrades < 6) {
    reasons.push(
      `Low sample size: ${all.totalTrades} total trades (${isSeg.totalTrades} IS / ${oosSeg.totalTrades} OOS; minimum 30 total / 10 OOS recommended).`
    );
  }
  if (all.costPctOfGrossProfit !== null && all.costPctOfGrossProfit > 45) {
    reasons.push(`Spread + slippage consumed ${all.costPctOfGrossProfit.toFixed(1)}% of gross mid-price profit.`);
  }

  const oosPf = oosSeg.profitFactor ?? 0;
  const isPf = isSeg.profitFactor ?? 0;

  // Classic Overfit detection: strong IS, collapsing OOS
  if (isSeg.totalTrades >= 10 && oosSeg.totalTrades >= 6 && isPf >= 1.25 && (oosPf < 0.95 || oosSeg.totalPnlUsd <= 0)) {
    reasons.push(
      `In-Sample showed PF ${isPf.toFixed(2)} (${isSeg.totalPnlPct >= 0 ? '+' : ''}${isSeg.totalPnlPct.toFixed(2)}%), but unseen Out-of-Sample dropped to PF ${oosPf.toFixed(2)} (${oosSeg.totalPnlPct >= 0 ? '+' : ''}${oosSeg.totalPnlPct.toFixed(2)}%).`
    );
    return {
      status: 'overfit',
      label: 'Overfit (Failed OOS)',
      summary: 'Profitable In-Sample, but failed to hold up on unseen Out-of-Sample data.',
      reasons
    };
  }

  // No statistical edge
  if (oosSeg.totalTrades >= 6 && (oosSeg.totalPnlUsd <= 0 || oosPf < 1.0)) {
    reasons.push(
      `Unseen Out-of-Sample finished negative (${oosSeg.totalPnlPct.toFixed(2)}%, PF ${oosPf.toFixed(2)} across ${oosSeg.totalTrades} trades).`
    );
    return {
      status: 'no_edge',
      label: 'No Viable Edge',
      summary: 'After real OANDA Bid/Ask spread and slippage, this strategy lost money Out-of-Sample.',
      reasons
    };
  }

  if (all.totalTrades < 20 || oosSeg.totalTrades < 6) {
    return {
      status: 'low_sample',
      label: `Low Sample (N=${all.totalTrades})`,
      summary: `Too few trades (${all.totalTrades} total, ${oosSeg.totalTrades} OOS) to claim a statistically reliable edge.`,
      reasons
    };
  }

  // Strong OOS + IS pass
  if (oosPf >= 1.2 && oosSeg.totalPnlUsd > 0 && all.totalPnlUsd > 0 && oosSeg.maxDrawdownPct < 20) {
    reasons.push(
      `Held positive Out-of-Sample edge: PF ${oosPf.toFixed(2)}, ${oosSeg.totalPnlPct >= 0 ? '+' : ''}${oosSeg.totalPnlPct.toFixed(2)}% across ${oosSeg.totalTrades} unseen trades (Max DD ${oosSeg.maxDrawdownPct.toFixed(2)}%).`
    );
    if (all.totalTrades < 30 || oosSeg.totalTrades < 10) {
      return {
        status: 'marginal',
        label: 'Promising (Moderate Sample)',
        summary: 'Positive OOS edge after spread, though sample size is still modest — forward-test in Paper Ledger.',
        reasons
      };
    }
    return {
      status: 'pass',
      label: 'Viable Candidate (OOS Pass)',
      summary: 'Maintained positive expectancy on unseen Out-of-Sample bars after real Bid/Ask spreads.',
      reasons
    };
  }

  reasons.push(
    `Marginal OOS edge: PF ${oosPf.toFixed(2)} (${oosSeg.totalPnlPct >= 0 ? '+' : ''}${oosSeg.totalPnlPct.toFixed(2)}% across ${oosSeg.totalTrades} OOS trades).`
  );
  return {
    status: 'marginal',
    label: 'Marginal Edge',
    summary: 'Thin positive edge after spread — fragile to regime shifts or wider spreads.',
    reasons
  };
}

export interface RunBacktestOptions {
  iterations?: StrategyIterationStep[];
  /** When true (during AI In-Sample refinement), skips OOS splitting because only IS bars were passed */
  inSampleOnly?: boolean;
}

/**
 * Deterministic event-driven backtester with:
 * 1. Closed-bar signal -> Next-bar open fill (zero lookahead)
 * 2. Strict causal HTF indicator alignment
 * 3. Worst-case intrabar SL-before-TP ambiguity resolution
 * 4. Side-accurate OANDA Bid/Ask fills and bracket triggers
 * 5. Warmup period lockout before any trade is allowed
 */
export function runStrategyBacktest(
  rawSpec: StrategySpec,
  history: HistoryFetchResult,
  opts: RunBacktestOptions = {}
): BacktestReport {
  const spec = validateAndSanitizeStrategySpec(rawSpec, {
    symbol: history.symbol,
    shortName: history.shortName,
    interval: history.timeframe
  });
  const bars = history.bars;
  const n = bars.length;
  const inst = getStrategyInstrumentSpec(spec.symbol);
  const env = computeIndicatorEnv(bars, spec.interval, spec.indicators);
  const warmupBars = estimateWarmupBars(spec, n);

  const oosFraction = opts.inSampleOnly ? 0 : spec.risk.oosFraction ?? 0.3;
  const tradableCount = Math.max(1, n - warmupBars);
  const oosSplitIndex = opts.inSampleOnly
    ? n
    : Math.min(n - 1, warmupBars + Math.floor(tradableCount * (1 - oosFraction)));
  const oosSplitTs = bars[Math.min(oosSplitIndex, n - 1)]?.ts ?? bars[n - 1]?.ts ?? 0;

  const zeroCost = Boolean(spec.risk.zeroCostDiagnostic);
  const slippagePx = zeroCost ? 0 : (spec.risk.slippageTicks ?? 0.5) * inst.tickSize;
  const commPerUnit = zeroCost
    ? 0
    : (spec.risk.commissionPerLotUsd ?? 0) / Math.max(1, inst.lotUnits);
  const cooldownBars = Math.max(0, spec.risk.cooldownBars ?? 1);

  let equity = spec.risk.initialCapital;
  let openPos: OpenSimPos | null = null;
  let pendingEntry: {
    side: 'long' | 'short';
    signalBarIdx: number;
    signalLabel: string;
  } | null = null;
  let pendingExit: { reason: TradeExitReason; signalLabel: string } | null = null;
  let lastExitBarIdx = -999;
  let tradeSeq = 0;

  const trades: BacktestTrade[] = [];

  const closePosition = (
    pos: OpenSimPos,
    exitBarIdx: number,
    exitTs: number,
    exitFillPrice: number,
    exitMidPrice: number,
    exitReason: TradeExitReason,
    exitSignal: string,
    exitSlippagePerUnit: number
  ) => {
    const grossPnlUsd = computePnlUsd(spec.symbol, pos.side, pos.quantity, pos.entryMid, exitMidPrice);
    const netBeforeComm = computePnlUsd(spec.symbol, pos.side, pos.quantity, pos.entryPrice, exitFillPrice);
    const commissionUsd = Math.abs(pos.quantity) * commPerUnit * 2;
    const netPnlUsd = netBeforeComm - commissionUsd;

    // Decompose spread vs slippage cost in USD
    const exitSpreadPerUnit = Math.abs(exitMidPrice - (pos.side === 'long' ? exitFillPrice + exitSlippagePerUnit : exitFillPrice - exitSlippagePerUnit));
    const totalSlippageUnit = pos.entrySlippagePerUnit + exitSlippagePerUnit;
    const slippageCostUsd = zeroCost
      ? 0
      : Math.abs(computePnlUsd(spec.symbol, 'long', pos.quantity, exitFillPrice, exitFillPrice + totalSlippageUnit));
    const rawSpreadCost = zeroCost ? 0 : Math.max(0, grossPnlUsd - netBeforeComm - slippageCostUsd);
    const spreadCostUsd =
      rawSpreadCost > 0
        ? rawSpreadCost
        : zeroCost
          ? 0
          : Math.abs(
              computePnlUsd(
                spec.symbol,
                'long',
                pos.quantity,
                exitMidPrice,
                exitMidPrice + pos.entrySpreadCostPerUnit + exitSpreadPerUnit
              )
            );

    equity += netPnlUsd;
    const returnPct = pos.equityAtEntry > 0 ? (netPnlUsd / pos.equityAtEntry) * 100 : 0;
    const realizedR =
      pos.initialRiskUsd && pos.initialRiskUsd > 0.01 ? netPnlUsd / pos.initialRiskUsd : null;

    const mfePct = pos.entryPrice > 0 ? (pos.mfePriceMove / pos.entryPrice) * 100 : 0;
    const maePct = pos.entryPrice > 0 ? (pos.maePriceMove / pos.entryPrice) * 100 : 0;
    const initRiskDist =
      pos.initialStopLoss !== null ? Math.abs(pos.entryPrice - pos.initialStopLoss) : 0;
    const mfeR = initRiskDist > 0 ? pos.mfePriceMove / initRiskDist : null;
    const maeR = initRiskDist > 0 ? pos.maePriceMove / initRiskDist : null;

    trades.push({
      tradeNumber: pos.tradeNumber,
      side: pos.side,
      segment: pos.segment,
      entryTs: pos.entryTs,
      exitTs,
      entryPrice: roundToTick(pos.entryPrice, spec.symbol),
      exitPrice: roundToTick(exitFillPrice, spec.symbol),
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      quantity: pos.quantity,
      notionalUsd: round2(pos.notionalUsd),
      grossPnlUsd: round2(grossPnlUsd),
      spreadCostUsd: round2(spreadCostUsd),
      slippageCostUsd: round2(slippageCostUsd),
      commissionUsd: round2(commissionUsd),
      netPnlUsd: round2(netPnlUsd),
      returnPct: round2(returnPct),
      realizedR: realizedR !== null ? round2(realizedR) : null,
      barsHeld: Math.max(1, exitBarIdx - pos.entryBarIdx),
      mfePct: round2(mfePct),
      maePct: round2(maePct),
      mfeR: mfeR !== null ? round2(mfeR) : null,
      maeR: maeR !== null ? round2(maeR) : null,
      exitReason,
      entrySignal: pos.entrySignal,
      exitSignal
    });
    lastExitBarIdx = exitBarIdx;
  };

  for (let i = warmupBars; i < n; i++) {
    const bar = bars[i];
    const segment: 'IS' | 'OOS' = !opts.inSampleOnly && i >= oosSplitIndex ? 'OOS' : 'IS';

    // Step 1: Execute any pending next-bar-open exit FIRST
    if (openPos && pendingExit) {
      const exitBase = zeroCost ? bar.open : openPos.side === 'long' ? bar.bidO : bar.askO;
      const exitFill =
        openPos.side === 'long'
          ? Math.max(inst.tickSize, exitBase - slippagePx)
          : exitBase + slippagePx;
      closePosition(
        openPos,
        i,
        bar.ts,
        exitFill,
        bar.open,
        pendingExit.reason,
        pendingExit.signalLabel,
        slippagePx
      );
      openPos = null;
      pendingExit = null;
    }

    // Step 2: Execute any pending next-bar-open entry
    if (!openPos && pendingEntry && equity > 10) {
      const side = pendingEntry.side;
      const entryBase = zeroCost ? bar.open : side === 'long' ? bar.askO : bar.bidO;
      const entryFill =
        side === 'long'
          ? entryBase + slippagePx
          : Math.max(inst.tickSize, entryBase - slippagePx);
      const { stopLoss, takeProfit } = computeStopAndTargetPrices(
        spec,
        side,
        entryFill,
        pendingEntry.signalBarIdx,
        bars,
        env
      );
      const qty = computePositionQty(spec, equity, entryFill, stopLoss);
      const notional = computeNotionalUsd(spec.symbol, qty, entryFill);
      const initialRiskUsd =
        stopLoss !== null
          ? Math.abs(computePnlUsd(spec.symbol, side, qty, entryFill, stopLoss))
          : null;

      tradeSeq += 1;
      openPos = {
        tradeNumber: tradeSeq,
        side,
        segment,
        entryBarIdx: i,
        entryTs: bar.ts,
        entryMid: bar.open,
        entryPrice: entryFill,
        entrySpreadCostPerUnit: zeroCost ? 0 : Math.abs(entryBase - bar.open),
        entrySlippagePerUnit: slippagePx,
        stopLoss,
        initialStopLoss: stopLoss,
        takeProfit,
        quantity: qty,
        notionalUsd: notional,
        equityAtEntry: equity,
        initialRiskUsd,
        mfePriceMove: 0,
        maePriceMove: 0,
        entrySignal: pendingEntry.signalLabel
      };
      pendingEntry = null;
    }

    // Step 3: Manage active position intrabar brackets (SL-before-TP pessimistic rule!)
    if (openPos) {
      const checkHigh = zeroCost ? bar.high : openPos.side === 'long' ? bar.bidH : bar.askH;
      const checkLow = zeroCost ? bar.low : openPos.side === 'long' ? bar.bidL : bar.askL;
      const checkOpen = zeroCost ? bar.open : openPos.side === 'long' ? bar.bidO : bar.askO;

      // Track MFE / MAE
      if (openPos.side === 'long') {
        openPos.mfePriceMove = Math.max(openPos.mfePriceMove, checkHigh - openPos.entryPrice);
        openPos.maePriceMove = Math.min(openPos.maePriceMove, checkLow - openPos.entryPrice);
      } else {
        openPos.mfePriceMove = Math.max(openPos.mfePriceMove, openPos.entryPrice - checkLow);
        openPos.maePriceMove = Math.min(openPos.maePriceMove, openPos.entryPrice - checkHigh);
      }

      const slHit =
        openPos.stopLoss !== null &&
        (openPos.side === 'long' ? checkLow <= openPos.stopLoss : checkHigh >= openPos.stopLoss);
      const tpHit =
        openPos.takeProfit !== null &&
        (openPos.side === 'long' ? checkHigh >= openPos.takeProfit : checkLow <= openPos.takeProfit);

      // Pessimistic Rule #3: if both SL and TP hit within the same bar, SL ALWAYS wins!
      if (slHit) {
        const isTrailing =
          openPos.initialStopLoss !== null && openPos.stopLoss !== openPos.initialStopLoss;
        // Gap-through protection: if bar opened beyond SL, fill at open price
        const slTrigger = openPos.stopLoss!;
        const gapFill =
          openPos.side === 'long' ? Math.min(checkOpen, slTrigger) : Math.max(checkOpen, slTrigger);
        const exitFill =
          openPos.side === 'long'
            ? Math.max(inst.tickSize, gapFill - slippagePx)
            : gapFill + slippagePx;
        const exitMid =
          openPos.side === 'long'
            ? exitFill + (zeroCost ? 0 : bar.spread / 2) + slippagePx
            : exitFill - (zeroCost ? 0 : bar.spread / 2) - slippagePx;
        closePosition(
          openPos,
          i,
          bar.closeTs,
          exitFill,
          exitMid,
          isTrailing ? 'trailing_sl' : 'sl',
          isTrailing ? 'Trailing Stop' : 'Stop Loss',
          slippagePx
        );
        openPos = null;
      } else if (tpHit) {
        // Limit take-profit fills at exact TP (or better if gapped favorably) with zero extra slippage
        const tpTrigger = openPos.takeProfit!;
        const exitFill = tpTrigger;
        const exitMid =
          openPos.side === 'long'
            ? exitFill + (zeroCost ? 0 : bar.spread / 2)
            : exitFill - (zeroCost ? 0 : bar.spread / 2);
        closePosition(openPos, i, bar.closeTs, exitFill, exitMid, 'tp', 'Take Profit', 0);
        openPos = null;
      } else {
        // Update trailing stop strictly AFTER bar close (applies from bar i+1 forward)
        const trail = spec.risk.trailingStop;
        if (trail && trail.type !== 'none' && openPos.stopLoss !== null) {
          if (trail.type === 'breakeven_at_r' && openPos.initialStopLoss !== null) {
            const initDist = Math.abs(openPos.entryPrice - openPos.initialStopLoss);
            const trigDist = initDist * (trail.triggerR ?? 1.0);
            if (openPos.mfePriceMove >= trigDist) {
              if (openPos.side === 'long' && openPos.stopLoss < openPos.entryPrice) {
                openPos.stopLoss = roundToTick(openPos.entryPrice, spec.symbol);
              } else if (openPos.side === 'short' && openPos.stopLoss > openPos.entryPrice) {
                openPos.stopLoss = roundToTick(openPos.entryPrice, spec.symbol);
              }
            }
          } else if (trail.type === 'atr_mult') {
            const atr = resolveValueAt(trail.atrId || '__atr14', i, bars, env);
            if (Number.isFinite(atr) && atr > 0) {
              const dist = atr * (trail.mult ?? 2.0);
              if (openPos.side === 'long') {
                const candidate = roundToTick(bar.close - dist, spec.symbol);
                if (candidate > openPos.stopLoss) openPos.stopLoss = candidate;
              } else {
                const candidate = roundToTick(bar.close + dist, spec.symbol);
                if (candidate < openPos.stopLoss) openPos.stopLoss = candidate;
              }
            }
          }
        }

        // Check bar-close exit rules (executed at next bar open!)
        const barsHeld = i - openPos.entryBarIdx + 1;
        if (spec.risk.maxBarsInTrade && barsHeld >= spec.risk.maxBarsInTrade) {
          pendingExit = { reason: 'time_stop', signalLabel: `Time Stop (${barsHeld} bars)` };
        } else if (
          openPos.side === 'long' &&
          spec.exitLong &&
          evaluateConditionAt(spec.exitLong, i, bars, env)
        ) {
          pendingExit = { reason: 'signal', signalLabel: 'Exit Long Signal' };
        } else if (
          openPos.side === 'short' &&
          spec.exitShort &&
          evaluateConditionAt(spec.exitShort, i, bars, env)
        ) {
          pendingExit = { reason: 'signal', signalLabel: 'Exit Short Signal' };
        }
      }
    }

    // Step 4: Evaluate bar-close entry signals ONLY when flat and past cooldown (and not on final bar)
    if (!openPos && !pendingEntry && i < n - 1 && i - lastExitBarIdx >= cooldownBars) {
      const longFired =
        spec.direction !== 'short' &&
        spec.entryLong !== null &&
        evaluateConditionAt(spec.entryLong, i, bars, env);
      const shortFired =
        spec.direction !== 'long' &&
        spec.entryShort !== null &&
        evaluateConditionAt(spec.entryShort, i, bars, env);

      if (longFired && !shortFired) {
        pendingEntry = { side: 'long', signalBarIdx: i, signalLabel: 'Long Entry' };
      } else if (shortFired && !longFired) {
        pendingEntry = { side: 'short', signalBarIdx: i, signalLabel: 'Short Entry' };
      }
    }
  }

  // Mark-to-market close any position still open at the very end of the test window
  if (openPos && n > 0) {
    const lastBar = bars[n - 1];
    const exitBase = zeroCost ? lastBar.close : openPos.side === 'long' ? lastBar.bidC : lastBar.askC;
    closePosition(openPos, n - 1, lastBar.closeTs, exitBase, lastBar.close, 'end_of_data', 'End of Period', 0);
  }

  const tradableBars = bars.slice(warmupBars);
  const isBars = opts.inSampleOnly ? tradableBars : bars.slice(warmupBars, oosSplitIndex);
  const oosBars = opts.inSampleOnly ? [] : bars.slice(oosSplitIndex);

  const isTrades = trades.filter((t) => t.segment === 'IS');
  const oosTrades = trades.filter((t) => t.segment === 'OOS');

  const allMetrics = buildSegmentMetrics(trades, tradableBars, spec.risk.initialCapital);
  const isMetrics = buildSegmentMetrics(isTrades, isBars, spec.risk.initialCapital);
  const oosMetrics = buildSegmentMetrics(oosTrades, oosBars, spec.risk.initialCapital);

  const verdict = opts.inSampleOnly
    ? {
        status: 'marginal' as const,
        label: 'In-Sample Draft',
        summary: 'In-Sample evaluation only (Out-of-Sample vault untouched).',
        reasons: []
      }
    : classifyStrategyVerdict(allMetrics, isMetrics, oosMetrics);

  return {
    spec,
    dataSource: history.dataSource,
    dataQualityNote: history.dataQualityNote,
    barsTotal: n,
    warmupBars,
    fromTs: tradableBars[0]?.ts ?? bars[0]?.ts ?? 0,
    toTs: bars[n - 1]?.closeTs ?? 0,
    oosSplitTs,
    oosFraction,
    all: allMetrics,
    inSample: isMetrics,
    outOfSample: oosMetrics,
    trades,
    verdict,
    iterations: opts.iterations ?? [],
    computedAt: new Date().toISOString()
  };
}

/**
 * Evaluates strictly the latest COMPLETED candle for Paper Ledger forward-running.
 * Never repaints on live forming ticks.
 */
export function evaluateLiveStrategySignal(
  rawSpec: StrategySpec,
  history: HistoryFetchResult,
  accountEquityUsd: number,
  currentPositionSide: 'long' | 'short' | null
): LiveStrategyEvaluation {
  const spec = validateAndSanitizeStrategySpec(rawSpec, {
    symbol: history.symbol,
    shortName: history.shortName,
    interval: history.timeframe
  });
  const bars = history.bars;
  const idx = bars.length - 1;
  const bar = bars[idx];
  const env = computeIndicatorEnv(bars, spec.interval, spec.indicators);

  let signal: LiveStrategyEvaluation['signal'] = 'none';
  let reason = 'No signal on latest closed candle.';
  let suggestedStopLoss: number | null = null;
  let suggestedTakeProfit: number | null = null;
  let suggestedQty: number | null = null;

  if (currentPositionSide === 'long') {
    if (spec.exitLong && evaluateConditionAt(spec.exitLong, idx, bars, env)) {
      signal = 'exit_long';
      reason = `${spec.name}: Exit Long condition triggered on closed ${spec.interval} candle.`;
    }
  } else if (currentPositionSide === 'short') {
    if (spec.exitShort && evaluateConditionAt(spec.exitShort, idx, bars, env)) {
      signal = 'exit_short';
      reason = `${spec.name}: Exit Short condition triggered on closed ${spec.interval} candle.`;
    }
  } else {
    const longFired =
      spec.direction !== 'short' &&
      spec.entryLong !== null &&
      evaluateConditionAt(spec.entryLong, idx, bars, env);
    const shortFired =
      spec.direction !== 'long' &&
      spec.entryShort !== null &&
      evaluateConditionAt(spec.entryShort, idx, bars, env);

    if (longFired && !shortFired) {
      signal = 'enter_long';
      const entryRef = bar.askC;
      const levels = computeStopAndTargetPrices(spec, 'long', entryRef, idx, bars, env);
      suggestedStopLoss = levels.stopLoss;
      suggestedTakeProfit = levels.takeProfit;
      suggestedQty = computePositionQty(spec, accountEquityUsd, entryRef, levels.stopLoss);
      reason = `${spec.name}: Long entry triggered on closed ${spec.interval} candle.`;
    } else if (shortFired && !longFired) {
      signal = 'enter_short';
      const entryRef = bar.bidC;
      const levels = computeStopAndTargetPrices(spec, 'short', entryRef, idx, bars, env);
      suggestedStopLoss = levels.stopLoss;
      suggestedTakeProfit = levels.takeProfit;
      suggestedQty = computePositionQty(spec, accountEquityUsd, entryRef, levels.stopLoss);
      reason = `${spec.name}: Short entry triggered on closed ${spec.interval} candle.`;
    }
  }

  return {
    symbol: spec.symbol,
    shortName: spec.shortName,
    interval: spec.interval,
    barTs: bar.ts,
    barCloseTs: bar.closeTs,
    closePrice: bar.close,
    bidPrice: bar.bidC,
    askPrice: bar.askC,
    spreadPx: bar.spread,
    signal,
    suggestedStopLoss,
    suggestedTakeProfit,
    suggestedQty,
    reason,
    dataSource: history.dataSource
  };
}
