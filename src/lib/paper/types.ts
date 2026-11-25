export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'working' | 'filled' | 'cancelled' | 'expired' | 'rejected';
export type TimeInForce = 'GTC' | 'DAY' | 'WEEK';
export type PositionSide = 'long' | 'short';

export type PaperBottomMode = 'collapsed' | 'expanded' | 'fullscreen';

export type PaperBottomTab =
  | 'positions'
  | 'orders'
  | 'order_history'
  | 'balance_history'
  | 'activity_log'
  | 'trade_history'
  | 'analytics';

export interface PaperAccountSettings {
  startingBalance: number;
  leverage: number;
  commissionPerOrder: number;
  zeroSpread: boolean;
  oneClickTrading: boolean;
  showOnChart: boolean;
  confirmOrders: boolean;
  privacyMask: boolean;
}

export interface PositionFillLeg {
  id: string;
  side: OrderSide;
  quantity: number;
  fillPrice: number;
  orderType: OrderType;
  filledAt: string;
}

export interface PaperPosition {
  id: string;
  symbol: string; // e.g. OANDA:XAUUSD
  shortName: string; // e.g. XAUUSD
  side: PositionSide;
  quantity: number; // units
  avgFillPrice: number;
  takeProfit: number | null;
  stopLoss: number | null;
  initialRiskUsd: number | null;
  openedAt: string;
  updatedAt: string;
  lastKnownPrice: number;
  fills?: PositionFillLeg[];
}

export interface PaperOrder {
  id: string;
  symbol: string;
  shortName: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  orderPrice: number | null;
  fillPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  tif: TimeInForce;
  expiresAt: string | null;
  status: OrderStatus;
  rejectReason?: string;
  note?: string;
  placedAt: string;
  updatedAt: string;
  filledAt?: string;
}

export type BalanceHistoryKind =
  | 'deposit'
  | 'realized_pnl'
  | 'commission'
  | 'reset'
  | 'adjustment';

export interface BalanceHistoryEntry {
  id: string;
  ts: string;
  kind: BalanceHistoryKind;
  delta: number;
  balanceAfter: number;
  symbol?: string;
  description: string;
}

export type ActivityCategory =
  | 'connection'
  | 'order'
  | 'fill'
  | 'position'
  | 'bracket'
  | 'offline'
  | 'account';

export interface ActivityLogEntry {
  id: string;
  ts: string;
  category: ActivityCategory;
  symbol?: string;
  message: string;
  details?: string;
}

export type TradeCloseReason =
  | 'manual'
  | 'partial'
  | 'tp'
  | 'sl'
  | 'reverse'
  | 'offline_tp'
  | 'offline_sl';

export interface ClosedTrade {
  id: string;
  symbol: string;
  shortName: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
  realizedPnl: number;
  realizedPnlPct: number;
  commission: number;
  initialRiskUsd: number | null;
  realizedR: number | null;
  closeReason: TradeCloseReason;
  sentToPlaybook?: boolean;
  playbookEntryId?: string;
}

export interface PaperAccount {
  id: string;
  name: string;
  currency: 'USD';
  balance: number;
  realizedPnl: number;
  settings: PaperAccountSettings;
  positions: PaperPosition[];
  orders: PaperOrder[]; // active working orders
  orderHistory: PaperOrder[];
  balanceHistory: BalanceHistoryEntry[];
  activityLog: ActivityLogEntry[];
  tradeHistory: ClosedTrade[];
  createdAt: string;
  lastEvaluatedAt: number; // Unix seconds UTC
}

export interface PaperLedgerState {
  connected: boolean;
  activeAccountId: string;
  accounts: PaperAccount[];
  bottomMode: PaperBottomMode;
  bottomHeight: number;
  activeBottomTab: PaperBottomTab;
  ticketOpen: boolean;
}

export interface PaperLiveQuote {
  symbol: string;
  shortName: string;
  last: number;
  bid: number;
  ask: number;
  spreadDisplay: string;
  updatedAtMs: number;
  source: 'live' | 'poll';
}

export interface PlaceOrderRequest {
  symbol: string;
  shortName: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  orderPrice?: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
  tif?: TimeInForce;
  note?: string;
}

export interface PaperOrderDraft {
  seq: number;
  symbol: string;
  shortName: string;
  side: OrderSide;
  type?: OrderType;
  price?: number | null;
  quantity?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
  source: 'sizer' | 'chart' | 'dom' | 'manual';
}

export interface PaperToast {
  id: string;
  kind: 'executed' | 'placed' | 'cancelled' | 'rejected' | 'info';
  title: string;
  symbol: string;
  shortName: string;
  side?: OrderSide;
  quantity?: number;
  price?: number;
  detail?: string;
  createdAt: string;
}

export interface AccountSummaryMetrics {
  balance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  equity: number;
  usedMargin: number;
  availableFunds: number;
  marginBufferPct: number;
}

export interface PositionLiveMetrics {
  lastPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  tradeValue: number;
  usedMargin: number;
  liveR: number | null;
}

export interface EquityPoint {
  index: number;
  ts: string;
  label: string;
  equity: number;
  drawdownPct: number;
  drawdownUsd: number;
  tradePnl?: number;
  symbol?: string;
}

export interface SymbolAnalyticsRow {
  symbol: string;
  shortName: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnl: number;
  totalR: number | null;
}

export interface SideAnalyticsRow {
  side: PositionSide;
  trades: number;
  wins: number;
  winRatePct: number | null;
  netPnl: number;
}

export interface PaperAnalytics {
  netRealizedPnl: number;
  returnPct: number;
  grossProfit: number;
  grossLoss: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number | null;
  profitFactor: number | null;
  payoffRatio: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancyUsd: number | null;
  expectancyR: number | null;
  totalR: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  bestTradeUsd: number | null;
  worstTradeUsd: number | null;
  avgHoldMinutes: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
  equitySeries: EquityPoint[];
  bySymbol: SymbolAnalyticsRow[];
  bySide: SideAnalyticsRow[];
  byCloseReason: { reason: string; count: number; netPnl: number }[];
}
