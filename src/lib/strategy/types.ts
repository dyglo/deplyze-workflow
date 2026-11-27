export type StrategyTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W';
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
  tf?: StrategyTimeframe;
}

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
  initialCapital: number;
  sizingMode: 'risk_pct' | 'fixed_notional' | 'fixed_units';
  riskPct: number;
  fixedNotionalUsd?: number;
  fixedUnits?: number;
  stopLoss: StopLossConfig;
  takeProfit: TakeProfitConfig;
  trailingStop?: TrailingStopConfig;
  maxBarsInTrade?: number | null;
  cooldownBars?: number;
  slippageTicks?: number;
  commissionPerLotUsd?: number;
  zeroCostDiagnostic?: boolean;
  oosFraction?: number;
}

export interface StrategySpec {
  id: string;
  name: string;
  description: string;
  version: number;
  symbol: string;
  shortName: string;
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
  returnPct: number;
  realizedR: number | null;
  barsHeld: number;
  mfePct: number;
  maePct: number;
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
  ym: string;
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

  grossProfitUsd: number;
  grossProfitPct: number;
  grossLossUsd: number;
  grossLossPct: number;
  totalSpreadCostUsd: number;
  totalSlippageCostUsd: number;
  totalCommissionUsd: number;
  totalCostUsd: number;
  costPctOfGrossProfit: number | null;

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

export interface WalkForwardFold {
  fold: number;
  label: string;
  fromTs: number;
  toTs: number;
  trades: number;
  wins: number;
  winRatePct: number;
  netPnlUsd: number;
  netPnlPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  buyAndHoldPct: number;
  passed: boolean;
}

export interface WalkForwardSummary {
  folds: WalkForwardFold[];
  passingFolds: number;
  totalFolds: number;
  avgProfitFactor: number | null;
  combinedPnlUsd: number;
  combinedPnlPct: number;
  consistencyPct: number;
  label: string;
}

export interface BacktestReport {
  spec: StrategySpec;
  executedRules?: string[];
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
  walkForward?: WalkForwardSummary;
  trades: BacktestTrade[];
  verdict: StrategyVerdict;
  iterations: StrategyIterationStep[];
  computedAt: string;
}

export interface SavedStrategyRecord {
  id: string;
  savedAt: string;
  updatedAt: string;
  pinned?: boolean;
  report: BacktestReport;
}

export type ForwardExecutionMode = 'auto' | 'confirm';

export interface RuleCheckItem {
  label: string;
  passed: boolean;
  detail: string;
}

export interface BotEvalLogEntry {
  ts: string;
  barTs: number;
  closePrice: number;
  spreadPx: number;
  signal: string;
  summary: string;
}

export interface ForwardRunnerConfig {
  id: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  shortName: string;
  interval: StrategyTimeframe;
  accountId: string;
  accountName: string;
  executionMode: ForwardExecutionMode;
  status: 'running' | 'paused';
  pauseReason?: string;
  maxDailyLossPct: number; // default 3.0
  dayAnchorDate: string; // YYYY-MM-DD UTC
  dayStartEquityUsd: number;
  lastEvaluatedBarTs: number;
  lastCheckedAt: string | null;
  signalsFired: number;
  createdAt: string;
  lastEvaluation?: LiveStrategyEvaluation;
  evalLog?: BotEvalLogEntry[];
}

export interface PendingStrategySignal {
  id: string;
  runnerId: string;
  strategyId: string;
  strategyName: string;
  accountId: string;
  accountName: string;
  symbol: string;
  shortName: string;
  interval: StrategyTimeframe;
  barTs: number;
  signal: 'enter_long' | 'enter_short' | 'exit_long' | 'exit_short';
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  quantity: number;
  reason: string;
  createdAt: string;
}

export interface LiveStrategyEvaluation {
  symbol: string;
  shortName: string;
  interval: StrategyTimeframe;
  barTs: number;
  barCloseTs: number;
  nextBarCloseTs?: number;
  closePrice: number;
  bidPrice: number;
  askPrice: number;
  spreadPx: number;
  signal: 'enter_long' | 'enter_short' | 'exit_long' | 'exit_short' | 'none';
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
  suggestedQty: number | null;
  reason: string;
  longRules?: RuleCheckItem[];
  shortRules?: RuleCheckItem[];
  longMetCount?: number;
  longTotalCount?: number;
  shortMetCount?: number;
  shortTotalCount?: number;
  dataSource: 'oanda_mba' | 'yahoo_indicative';
}

export interface StrategyWorkspaceState {
  strategies: SavedStrategyRecord[];
  openStrategyId: string | null; // non-null => Strategy Tester tab is visible beside Paper Ledger
  activeDockTab: 'strategy' | 'paper';
  dockMode: 'collapsed' | 'expanded' | 'fullscreen';
  dockHeight: number;
  preferredViewMode?: 'report' | 'trades' | 'live';
  runners: ForwardRunnerConfig[];
  pendingSignals: PendingStrategySignal[];
}
