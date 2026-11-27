export type StrategyTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W';

export type OandaBacktestGranularity = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D' | 'W';

export interface StrategyCandle {
  ts: number; // bar open time, Unix seconds UTC
  closeTs: number; // bar close time, Unix seconds UTC
  open: number; // mid open
  high: number; // mid high
  low: number; // mid low
  close: number; // mid close
  bidO: number;
  bidH: number;
  bidL: number;
  bidC: number;
  askO: number;
  askH: number;
  askL: number;
  askC: number;
  volume: number;
  spread: number; // askC - bidC
}

export interface HistoryFetchResult {
  symbol: string;
  shortName: string;
  instrument: string;
  timeframe: StrategyTimeframe;
  bars: StrategyCandle[];
  dataSource: 'oanda_mba' | 'yahoo_indicative';
  dataQualityNote: string;
  fromCache: boolean;
}

export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3';

export type IndicatorFn =
  | 'ema'
  | 'sma'
  | 'wma'
  | 'hma'
  | 'vwma'
  | 'rsi'
  | 'atr'
  | 'adx'
  | 'macd'
  | 'stoch'
  | 'bbands'
  | 'keltner'
  | 'donchian'
  | 'cci'
  | 'willr'
  | 'session_vwap'
  | 'swing_high'
  | 'swing_low'
  | 'prev_day_high'
  | 'prev_day_low'
  | 'prev_day_close';

export interface IndicatorDef {
  id: string;
  fn: IndicatorFn;
  period?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  kPeriod?: number;
  dPeriod?: number;
  mult?: number;
  stdDev?: number;
  source?: PriceSource;
  tf?: StrategyTimeframe; // optional higher timeframe (strictly causal closed-bar lookup)
}

/**
 * References either a numeric literal, candle field ('open'|'high'|'low'|'close'|'volume'|'spread'),
 * indicator output ('ema21', 'macd1.hist', 'bb.lower', 'adx14.adx', 'adx14.plusDi'),
 * or an optional 1-bar-ago suffix ('close[1]', 'rsi14[1]').
 */
export type ValueRef = number | string;

export type ConditionNode =
  | { op: 'and' | 'or'; args: ConditionNode[] }
  | { op: 'not'; arg: ConditionNode }
  | {
      op: 'gt' | 'gte' | 'lt' | 'lte' | 'crosses_above' | 'crosses_below';
      left: ValueRef;
      right: ValueRef;
    }
  | { op: 'between'; value: ValueRef; min: number; max: number }
  | { op: 'rising' | 'falling'; value: ValueRef; bars?: number }
  | { op: 'session_utc'; startHour: number; endHour: number }
  | { op: 'day_of_week'; days: number[] }
  | { op: 'spread_below_atr'; atrId: string; maxRatio: number };

export interface StopLossConfig {
  type: 'atr_mult' | 'pct' | 'pips' | 'swing';
  atrId?: string;
  mult?: number;
  pct?: number;
  pips?: number;
  lookback?: number;
}

export interface TakeProfitConfig {
  type: 'rr_multiple' | 'atr_mult' | 'pct' | 'pips' | 'none';
  rr?: number;
  atrId?: string;
  mult?: number;
  pct?: number;
  pips?: number;
}

export interface TrailingStopConfig {
  type: 'none' | 'atr_mult' | 'breakeven_at_r';
  atrId?: string;
  mult?: number;
  triggerR?: number;
}

export interface StrategyRiskConfig {
  initialCapital: number; // default 10000 USD
  sizingMode: 'risk_pct' | 'fixed_notional' | 'fixed_units';
  riskPct: number; // default 1.0 (%)
  fixedNotionalUsd?: number;
  fixedUnits?: number;
  stopLoss: StopLossConfig;
  takeProfit: TakeProfitConfig;
  trailingStop?: TrailingStopConfig;
  maxBarsInTrade?: number | null;
  cooldownBars?: number;
  slippageTicks?: number; // default 0.5
  commissionPerLotUsd?: number; // default 0
  zeroCostDiagnostic?: boolean; // default false
  oosFraction?: number; // default 0.30 (70% IS / 30% OOS)
}

export interface StrategySpec {
  id: string;
  name: string;
  description: string;
  version: number;
  symbol: string; // e.g. OANDA:XAUUSD
  shortName: string; // e.g. XAUUSD
  interval: StrategyTimeframe;
  direction: 'long' | 'short' | 'both';
  indicators: IndicatorDef[];
  entryLong: ConditionNode | null;
  entryShort: ConditionNode | null;
  exitLong?: ConditionNode | null;
  exitShort?: ConditionNode | null;
  risk: StrategyRiskConfig;
  ruleSummary: string[];
}

export type TradeExitReason =
  | 'tp'
  | 'sl'
  | 'trailing_sl'
  | 'signal'
  | 'time_stop'
  | 'end_of_data';

export interface BacktestTrade {
  tradeNumber: number;
  side: 'long' | 'short';
  segment: 'IS' | 'OOS';
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  quantity: number;
  notionalUsd: number;
  grossPnlUsd: number;
  spreadCostUsd: number;
  slippageCostUsd: number;
  commissionUsd: number;
  netPnlUsd: number;
  returnPct: number; // on account equity at entry
  realizedR: number | null;
  barsHeld: number;
  mfePct: number; // max favorable excursion (% price move)
  maePct: number; // max adverse excursion (% price move, negative or 0)
  mfeR: number | null;
  maeR: number | null;
  exitReason: TradeExitReason;
  entrySignal: string;
  exitSignal: string;
}

export interface EquityCurvePoint {
  ts: number;
  tradeNumber: number;
  segment: 'IS' | 'OOS';
  cumulativePnlUsd: number;
  cumulativePnlPct: number;
  equityUsd: number;
  drawdownUsd: number;
  drawdownPct: number;
  buyAndHoldPnlUsd: number;
  buyAndHoldPct: number;
  tradePnlUsd: number;
}

export interface MonthlyReturnRow {
  ym: string; // YYYY-MM
  pnlUsd: number;
  pnlPct: number;
  trades: number;
  wins: number;
  winRatePct: number;
}

export interface ReturnBucketRow {
  label: string;
  minPct: number;
  maxPct: number;
  count: number;
  isPositive: boolean;
}

export interface TimePatternRow {
  key: number;
  label: string;
  trades: number;
  wins: number;
  winRatePct: number;
  pnlUsd: number;
}

export interface StreakDistRow {
  length: number;
  winStreaks: number;
  lossStreaks: number;
}

export interface ExcursionPoint {
  tradeNumber: number;
  side: 'long' | 'short';
  segment: 'IS' | 'OOS';
  mfePct: number;
  maePct: number;
  returnPct: number;
  netPnlUsd: number;
}

export interface SegmentMetrics {
  // Key stats
  totalPnlUsd: number;
  totalPnlPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRatePct: number;
  profitFactor: number | null;

  // Performance breakdown
  grossProfitUsd: number;
  grossProfitPct: number;
  grossLossUsd: number;
  grossLossPct: number;
  totalSpreadCostUsd: number;
  totalSlippageCostUsd: number;
  totalCommissionUsd: number;
  totalCostUsd: number;
  costPctOfGrossProfit: number | null;

  // Long vs Short breakdown
  tradesLong: number;
  tradesShort: number;
  winsLong: number;
  winsShort: number;
  winRateLongPct: number;
  winRateShortPct: number;
  netPnlLongUsd: number;
  netPnlShortUsd: number;
  grossProfitLongUsd: number;
  grossLossLongUsd: number;
  grossProfitShortUsd: number;
  grossLossShortUsd: number;

  // Benchmarking & Risk Ratios
  buyAndHoldPnlUsd: number;
  buyAndHoldPct: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  recoveryFactor: number | null;
  maxRunupUsd: number;
  maxRunupPct: number;
  avgRunupUsd: number;
  avgDrawdownUsd: number;

  // Trades analysis
  expectancyUsd: number;
  expectancyPct: number;
  expectancyR: number | null;
  avgWinUsd: number;
  avgWinPct: number;
  avgLossUsd: number;
  avgLossPct: number;
  payoffRatio: number | null;
  largestWinUsd: number;
  largestWinPct: number;
  largestLossUsd: number;
  largestLossPct: number;
  outliersPnlUsd: number;
  outliersPnlPct: number;
  avgBarsHeld: number;
  avgBarsWin: number;
  avgBarsLoss: number;
  maxWinStreak: number;
  maxLossStreak: number;
  avgWinStreak: number;
  avgLossStreak: number;
  avgMfePct: number;
  avgMaePct: number;
  avgMfeR: number | null;
  avgMaeR: number | null;

  // Series & distributions
  equityCurve: EquityCurvePoint[];
  monthlyReturns: MonthlyReturnRow[];
  returnsHistogram: ReturnBucketRow[];
  byHourUtc: TimePatternRow[];
  byDayOfWeek: TimePatternRow[];
  streakDist: StreakDistRow[];
  excursions: ExcursionPoint[];
}

export interface StrategyIterationStep {
  version: number;
  name: string;
  rationale: string;
  isTrades: number;
  isWinRatePct: number;
  isNetPnlUsd: number;
  isNetPnlPct: number;
  isProfitFactor: number | null;
  isMaxDdPct: number;
  isCostPctGross: number | null;
  kept: boolean;
}

export type StrategyVerdictStatus = 'pass' | 'marginal' | 'low_sample' | 'no_edge' | 'overfit';

export interface StrategyVerdict {
  status: StrategyVerdictStatus;
  label: string;
  summary: string;
  reasons: string[];
}

export interface BacktestReport {
  spec: StrategySpec;
  dataSource: 'oanda_mba' | 'yahoo_indicative';
  dataQualityNote: string;
  barsTotal: number;
  warmupBars: number;
  fromTs: number;
  toTs: number;
  oosSplitTs: number;
  oosFraction: number;
  all: SegmentMetrics;
  inSample: SegmentMetrics;
  outOfSample: SegmentMetrics;
  trades: BacktestTrade[];
  verdict: StrategyVerdict;
  iterations: StrategyIterationStep[];
  computedAt: string;
}

export interface LiveStrategyEvaluation {
  symbol: string;
  shortName: string;
  interval: StrategyTimeframe;
  barTs: number;
  barCloseTs: number;
  closePrice: number;
  bidPrice: number;
  askPrice: number;
  spreadPx: number;
  signal: 'enter_long' | 'enter_short' | 'exit_long' | 'exit_short' | 'none';
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
  suggestedQty: number | null;
  reason: string;
  dataSource: 'oanda_mba' | 'yahoo_indicative';
}

export function normalizeStrategyTimeframe(raw: string | null | undefined): StrategyTimeframe {
  const s = (raw ?? '').trim().toUpperCase();
  if (s === '1' || s === '1M' || s === 'M1') return '1m';
  if (s === '5' || s === '5M' || s === 'M5') return '5m';
  if (s === '15' || s === '15M' || s === 'M15') return '15m';
  if (s === '30' || s === '30M' || s === 'M30') return '30m';
  if (s === '60' || s === '1H' || s === 'H1') return '1h';
  if (s === '240' || s === '4H' || s === 'H4') return '4h';
  if (s === 'W' || s === '1W' || s === 'WEEKLY') return '1W';
  if (s === 'D' || s === '1D' || s === 'DAILY') return '1D';
  return '1h';
}

export function timeframeToSeconds(tf: StrategyTimeframe): number {
  switch (tf) {
    case '1m':
      return 60;
    case '5m':
      return 300;
    case '15m':
      return 900;
    case '30m':
      return 1800;
    case '1h':
      return 3600;
    case '4h':
      return 14400;
    case '1D':
      return 86400;
    case '1W':
      return 604800;
  }
}

export function timeframeToOandaGranularity(tf: StrategyTimeframe): OandaBacktestGranularity {
  switch (tf) {
    case '1m':
      return 'M1';
    case '5m':
      return 'M5';
    case '15m':
      return 'M15';
    case '30m':
      return 'M30';
    case '1h':
      return 'H1';
    case '4h':
      return 'H4';
    case '1D':
      return 'D';
    case '1W':
      return 'W';
  }
}
