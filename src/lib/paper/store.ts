import { fetchMarketQuotes } from '../watchlist/store';
import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  playAlertChime,
  saveWorkspaceJson
} from '../workspace/storage';
import {
  computeBidAsk,
  computePnlUsd,
  computeTradeValueUsd,
  formatPaperPrice,
  formatQty,
  getPaperInstrumentSpec,
  normalizeShortTicker,
  normalizeSymbolKey,
  roundToTick
} from './instruments';
import type {
  AccountSummaryMetrics,
  ActivityCategory,
  BalanceHistoryKind,
  ClosedTrade,
  EquityPoint,
  OrderSide,
  OrderType,
  PaperAccount,
  PaperAccountSettings,
  PaperAnalytics,
  PaperBottomMode,
  PaperBottomTab,
  PaperLedgerState,
  PaperLiveQuote,
  PaperOrder,
  PaperOrderDraft,
  PaperPosition,
  PaperToast,
  PlaceOrderRequest,
  PositionLiveMetrics,
  PositionSide,
  TimeInForce,
  TradeCloseReason
} from './types';

const STORAGE_KEY = 'paper_ledger';
const POLL_INTERVAL_MS = 6_000;
const LIVE_FRESH_MS = 18_000;
const MAX_HISTORY_ITEMS = 400;
const MAX_ACTIVITY_ITEMS = 500;

export const DEFAULT_ACCOUNT_SETTINGS: PaperAccountSettings = {
  startingBalance: 100_000,
  leverage: 500,
  commissionPerOrder: 0,
  zeroSpread: false,
  oneClickTrading: false,
  showOnChart: true,
  confirmOrders: false,
  privacyMask: false
};

export function createPaperAccountRecord(
  name = 'Paper Ledger',
  startingBalance = 100_000,
  leverage = 500
): PaperAccount {
  const nowIso = new Date().toISOString();
  const safeBal = Math.max(100, Number.isFinite(startingBalance) ? startingBalance : 100_000);
  const safeLev = Math.max(1, Math.min(1000, Number.isFinite(leverage) ? leverage : 500));
  return {
    id: makeWorkspaceId('pa'),
    name: name.trim() || 'Paper Ledger',
    currency: 'USD',
    balance: safeBal,
    realizedPnl: 0,
    settings: {
      ...DEFAULT_ACCOUNT_SETTINGS,
      startingBalance: safeBal,
      leverage: safeLev
    },
    positions: [],
    orders: [],
    orderHistory: [],
    balanceHistory: [
      {
        id: makeWorkspaceId('bh'),
        ts: nowIso,
        kind: 'deposit',
        delta: safeBal,
        balanceAfter: safeBal,
        description: `Initial Paper Ledger deposit (${safeLev}:1 leverage)`
      }
    ],
    activityLog: [
      {
        id: makeWorkspaceId('act'),
        ts: nowIso,
        category: 'account',
        message: `Paper account "${name.trim() || 'Paper Ledger'}" initialized with ${safeBal.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`
      }
    ],
    tradeHistory: [],
    createdAt: nowIso,
    lastEvaluatedAt: Math.floor(Date.now() / 1000)
  };
}

function createDefaultState(): PaperLedgerState {
  const first = createPaperAccountRecord('Paper Ledger', 100_000, 500);
  return {
    connected: false,
    activeAccountId: first.id,
    accounts: [first],
    bottomMode: 'collapsed',
    bottomHeight: 300,
    activeBottomTab: 'positions',
    ticketOpen: false
  };
}

let state: PaperLedgerState = createDefaultState();
let hydrated = false;
let hydrationPromise: Promise<PaperLedgerState> | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let reconcileDone = false;
let draftSeq = 0;

// In-memory live Bid/Ask quotes keyed by normalized symbol key (e.g. XAUUSD) AND canonical symbol
const liveQuotesByKey = new Map<string, PaperLiveQuote>();
const liveQuotesSnapshot: Record<string, PaperLiveQuote> = {};
// Real live OANDA spreads synced from /api/quotes (2-minute freshness window)
const LIVE_SPREAD_TTL_MS = 120_000;
const liveOandaSpreadByKey = new Map<string, { spreadPx: number; updatedAtMs: number }>();

function getFreshLiveSpread(key: string): number | null {
  const entry = liveOandaSpreadByKey.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAtMs > LIVE_SPREAD_TTL_MS) return null;
  return entry.spreadPx;
}

export function feedPaperLiveSpread(symbol: string, spreadPx: number | null | undefined): void {
  if (typeof spreadPx !== 'number' || !Number.isFinite(spreadPx) || spreadPx <= 0) return;
  const key = normalizeSymbolKey(symbol);
  if (!key) return;
  liveOandaSpreadByKey.set(key, { spreadPx, updatedAtMs: Date.now() });
}

const stateListeners = new Set<(s: PaperLedgerState) => void>();
const quoteListeners = new Set<(q: Record<string, PaperLiveQuote>) => void>();
const toastListeners = new Set<(t: PaperToast) => void>();
const draftListeners = new Set<(d: PaperOrderDraft) => void>();

function emitState(): void {
  for (const fn of stateListeners) fn(state);
}

function emitQuotes(): void {
  const copy = { ...liveQuotesSnapshot };
  for (const fn of quoteListeners) fn(copy);
}

function emitToast(toast: Omit<PaperToast, 'id' | 'createdAt'>): void {
  const full: PaperToast = {
    ...toast,
    id: makeWorkspaceId('pt'),
    createdAt: new Date().toISOString()
  };
  for (const fn of toastListeners) fn(full);
}

let saveDebounce: ReturnType<typeof setTimeout> | null = null;
function persistState(immediate = false): void {
  if (immediate) {
    if (saveDebounce) {
      clearTimeout(saveDebounce);
      saveDebounce = null;
    }
    void saveWorkspaceJson(STORAGE_KEY, state);
    return;
  }
  if (saveDebounce) clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    saveDebounce = null;
    void saveWorkspaceJson(STORAGE_KEY, state);
  }, 120);
}

function commit(next: PaperLedgerState, immediatePersist = false): void {
  state = next;
  emitState();
  persistState(immediatePersist);
}

export function getActivePaperAccount(s: PaperLedgerState = state): PaperAccount {
  return s.accounts.find((a) => a.id === s.activeAccountId) ?? s.accounts[0];
}

export function getPaperSnapshot(): PaperLedgerState {
  return state;
}

export function getPaperLiveQuote(symbol: string): PaperLiveQuote | null {
  const key = normalizeSymbolKey(symbol);
  return liveQuotesByKey.get(key) ?? null;
}

function updateActiveAccount(
  updater: (acc: PaperAccount) => PaperAccount,
  immediatePersist = false
): PaperAccount {
  const active = getActivePaperAccount(state);
  const updated = updater(active);
  const nextAccounts = state.accounts.map((a) => (a.id === active.id ? updated : a));
  commit({ ...state, accounts: nextAccounts }, immediatePersist);
  return updated;
}

function normalizeLoadedAccount(raw: Partial<PaperAccount>): PaperAccount {
  const def = createPaperAccountRecord(
    typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Paper Ledger',
    raw.settings?.startingBalance ?? 100_000,
    raw.settings?.leverage ?? 500
  );
  return {
    ...def,
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : def.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : def.name,
    currency: 'USD',
    balance: typeof raw.balance === 'number' && Number.isFinite(raw.balance) ? raw.balance : def.balance,
    realizedPnl:
      typeof raw.realizedPnl === 'number' && Number.isFinite(raw.realizedPnl) ? raw.realizedPnl : 0,
    settings: { ...DEFAULT_ACCOUNT_SETTINGS, ...(raw.settings ?? {}) },
    positions: Array.isArray(raw.positions) ? raw.positions : [],
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    orderHistory: Array.isArray(raw.orderHistory) ? raw.orderHistory : [],
    balanceHistory:
      Array.isArray(raw.balanceHistory) && raw.balanceHistory.length > 0
        ? raw.balanceHistory
        : def.balanceHistory,
    activityLog: Array.isArray(raw.activityLog) ? raw.activityLog : def.activityLog,
    tradeHistory: Array.isArray(raw.tradeHistory) ? raw.tradeHistory : [],
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : def.createdAt,
    lastEvaluatedAt:
      typeof raw.lastEvaluatedAt === 'number' && Number.isFinite(raw.lastEvaluatedAt)
        ? raw.lastEvaluatedAt
        : Math.floor(Date.now() / 1000)
  };
}

export async function initPaperStore(): Promise<PaperLedgerState> {
  if (hydrated) return state;
  if (!hydrationPromise) {
    hydrationPromise = loadWorkspaceJson<Partial<PaperLedgerState> | null>(STORAGE_KEY, null)
      .then((loaded) => {
        if (loaded && Array.isArray(loaded.accounts) && loaded.accounts.length > 0) {
          const accounts = loaded.accounts.map((a) => normalizeLoadedAccount(a));
          const activeId = accounts.some((a) => a.id === loaded.activeAccountId)
            ? (loaded.activeAccountId as string)
            : accounts[0].id;
          state = {
            connected: Boolean(loaded.connected),
            activeAccountId: activeId,
            accounts,
            bottomMode:
              loaded.bottomMode === 'expanded' || loaded.bottomMode === 'fullscreen'
                ? loaded.bottomMode
                : 'collapsed',
            bottomHeight:
              typeof loaded.bottomHeight === 'number' &&
              loaded.bottomHeight >= 180 &&
              loaded.bottomHeight <= 720
                ? loaded.bottomHeight
                : 300,
            activeBottomTab: loaded.activeBottomTab ?? 'positions',
            ticketOpen: Boolean(loaded.ticketOpen) && Boolean(loaded.connected)
          };
        }
        hydrated = true;
        emitState();
        if (state.connected) {
          void reconcileOfflineBars();
        }
        return state;
      })
      .catch(() => {
        hydrated = true;
        return state;
      });
  }
  return hydrationPromise;
}

export function subscribePaper(fn: (s: PaperLedgerState) => void): () => void {
  stateListeners.add(fn);
  fn(state);
  if (!hydrated) void initPaperStore();
  return () => {
    stateListeners.delete(fn);
  };
}

export function subscribePaperQuotes(fn: (q: Record<string, PaperLiveQuote>) => void): () => void {
  quoteListeners.add(fn);
  fn({ ...liveQuotesSnapshot });
  return () => {
    quoteListeners.delete(fn);
  };
}

export function subscribePaperToasts(fn: (t: PaperToast) => void): () => void {
  toastListeners.add(fn);
  return () => {
    toastListeners.delete(fn);
  };
}

export function subscribeOrderDraft(fn: (d: PaperOrderDraft) => void): () => void {
  draftListeners.add(fn);
  return () => {
    draftListeners.delete(fn);
  };
}

export function pushOrderDraft(draft: Omit<PaperOrderDraft, 'seq'>): void {
  draftSeq += 1;
  const full: PaperOrderDraft = { ...draft, seq: draftSeq };
  if (!state.connected) {
    connectPaperLedger();
  }
  if (!state.ticketOpen) {
    commit({ ...state, ticketOpen: true });
  }
  for (const fn of draftListeners) fn(full);
}

// ── Connection & UI layout controls ──────────────────────────────────────────

function pushActivity(
  acc: PaperAccount,
  category: ActivityCategory,
  message: string,
  symbol?: string,
  details?: string,
  ts = new Date().toISOString()
): PaperAccount {
  const entry = {
    id: makeWorkspaceId('act'),
    ts,
    category,
    symbol,
    message,
    details
  };
  return {
    ...acc,
    activityLog: [entry, ...acc.activityLog].slice(0, MAX_ACTIVITY_ITEMS)
  };
}

function pushBalanceHistory(
  acc: PaperAccount,
  kind: BalanceHistoryKind,
  delta: number,
  balanceAfter: number,
  description: string,
  symbol?: string,
  ts = new Date().toISOString()
): PaperAccount {
  const entry = {
    id: makeWorkspaceId('bh'),
    ts,
    kind,
    delta: Number(delta.toFixed(2)),
    balanceAfter: Number(balanceAfter.toFixed(2)),
    symbol,
    description
  };
  return {
    ...acc,
    balanceHistory: [entry, ...acc.balanceHistory].slice(0, MAX_HISTORY_ITEMS)
  };
}

export function connectPaperLedger(opts?: {
  startingBalance?: number;
  leverage?: number;
  openTicket?: boolean;
}): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const active = getActivePaperAccount(state);
  let nextAcc = active;

  // Apply starting balance/leverage if brand-new untouched account
  const isPristine =
    active.positions.length === 0 &&
    active.orders.length === 0 &&
    active.tradeHistory.length === 0 &&
    active.orderHistory.length === 0;

  if (opts && (opts.startingBalance || opts.leverage)) {
    const nextLev = opts.leverage ?? active.settings.leverage;
    const nextBal = isPristine && opts.startingBalance ? opts.startingBalance : active.balance;
    nextAcc = {
      ...nextAcc,
      balance: nextBal,
      settings: {
        ...nextAcc.settings,
        leverage: nextLev,
        startingBalance: isPristine && opts.startingBalance ? opts.startingBalance : nextAcc.settings.startingBalance
      }
    };
    if (isPristine && opts.startingBalance && opts.startingBalance !== active.balance) {
      nextAcc = {
        ...nextAcc,
        balanceHistory: [
          {
            id: makeWorkspaceId('bh'),
            ts: new Date().toISOString(),
            kind: 'deposit',
            delta: nextBal,
            balanceAfter: nextBal,
            description: `Initial Paper Ledger deposit (${nextLev}:1 leverage)`
          }
        ]
      };
    }
  }

  nextAcc = pushActivity(nextAcc, 'connection', 'Connected to Paper Ledger (Simulated)');
  nextAcc = { ...nextAcc, lastEvaluatedAt: nowSec };

  const accounts = state.accounts.map((a) => (a.id === active.id ? nextAcc : a));
  commit(
    {
      ...state,
      connected: true,
      accounts,
      bottomMode: 'collapsed',
      ticketOpen: opts?.openTicket ?? state.ticketOpen
    },
    true
  );

  void pollRequiredPaperSymbols();
  void reconcileOfflineBars();
}

export function disconnectPaperLedger(): void {
  const active = getActivePaperAccount(state);
  const nextAcc = pushActivity(active, 'connection', 'Disconnected Paper Ledger (history preserved)');
  const accounts = state.accounts.map((a) => (a.id === active.id ? nextAcc : a));
  commit(
    {
      ...state,
      connected: false,
      accounts,
      bottomMode: 'collapsed',
      ticketOpen: false
    },
    true
  );
}

export function setPaperBottomMode(mode: PaperBottomMode): void {
  if (!state.connected) return;
  commit({ ...state, bottomMode: mode });
}

export function setPaperBottomHeight(height: number): void {
  const clamped = Math.round(Math.max(190, Math.min(680, height)));
  commit({ ...state, bottomHeight: clamped });
}

export function setPaperBottomTab(tab: PaperBottomTab): void {
  commit({ ...state, activeBottomTab: tab });
}

export function setPaperTicketOpen(open: boolean): void {
  if (open && !state.connected) {
    connectPaperLedger({ openTicket: true });
    return;
  }
  commit({ ...state, ticketOpen: open });
}

export function togglePaperTicket(): void {
  setPaperTicketOpen(!state.ticketOpen);
}

export function updatePaperSettings(patch: Partial<PaperAccountSettings>): void {
  updateActiveAccount((acc) => {
    const nextSettings = { ...acc.settings, ...patch };
    let next = { ...acc, settings: nextSettings };
    if (patch.zeroSpread !== undefined && patch.zeroSpread !== acc.settings.zeroSpread) {
      // Recompute cached Bid/Ask with new spread preference
      for (const [key, q] of liveQuotesByKey.entries()) {
        const ba = computeBidAsk(q.last, q.symbol, nextSettings.zeroSpread, getFreshLiveSpread(key));
        const updatedQ = { ...q, ...ba };
        liveQuotesByKey.set(key, updatedQ);
        liveQuotesSnapshot[key] = updatedQ;
      }
      emitQuotes();
    }
    if (patch.leverage !== undefined && patch.leverage !== acc.settings.leverage) {
      next = pushActivity(next, 'account', `Account leverage updated to ${patch.leverage}:1`);
    }
    return next;
  }, true);
}

export function createNewPaperAccount(
  name: string,
  startingBalance: number,
  leverage: number
): PaperAccount {
  const acc = createPaperAccountRecord(name, startingBalance, leverage);
  commit(
    {
      ...state,
      activeAccountId: acc.id,
      accounts: [...state.accounts, acc]
    },
    true
  );
  return acc;
}

export function switchPaperAccount(accountId: string): void {
  if (!state.accounts.some((a) => a.id === accountId)) return;
  commit({ ...state, activeAccountId: accountId }, true);
  void pollRequiredPaperSymbols();
}

export function resetPaperAccount(newStartingBalance?: number, newLeverage?: number): void {
  updateActiveAccount((acc) => {
    const bal =
      typeof newStartingBalance === 'number' && Number.isFinite(newStartingBalance) && newStartingBalance >= 100
        ? newStartingBalance
        : acc.settings.startingBalance;
    const lev =
      typeof newLeverage === 'number' && Number.isFinite(newLeverage) && newLeverage >= 1
        ? newLeverage
        : acc.settings.leverage;
    const nowIso = new Date().toISOString();
    return {
      ...acc,
      balance: bal,
      realizedPnl: 0,
      settings: {
        ...acc.settings,
        startingBalance: bal,
        leverage: lev
      },
      positions: [],
      orders: [],
      orderHistory: [],
      tradeHistory: [],
      balanceHistory: [
        {
          id: makeWorkspaceId('bh'),
          ts: nowIso,
          kind: 'reset',
          delta: bal,
          balanceAfter: bal,
          description: `Account reset to ${bal.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD (${lev}:1)`
        }
      ],
      activityLog: [
        {
          id: makeWorkspaceId('act'),
          ts: nowIso,
          category: 'account',
          message: `Account "${acc.name}" reset to ${bal.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`
        }
      ],
      lastEvaluatedAt: Math.floor(Date.now() / 1000)
    };
  }, true);
}

// ── Time in Force Expiration ─────────────────────────────────────────────────

function computeOrderExpiry(tif: TimeInForce, fromMs = Date.now()): string | null {
  if (tif === 'GTC') return null;
  // Standard FX/Metals daily rollover = 17:00 America/New_York (~21:00 or 22:00 UTC)
  const now = new Date(fromMs);
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(now);

  const hourNy = Number(nyParts.find((p) => p.type === 'hour')?.value ?? '12');
  const weekday = nyParts.find((p) => p.type === 'weekday')?.value ?? 'Mon';

  if (tif === 'DAY') {
    const hoursUntilClose = hourNy < 17 ? 17 - hourNy : 24 - hourNy + 17;
    return new Date(fromMs + hoursUntilClose * 3600 * 1000).toISOString();
  }

  // WEEK -> Friday 17:00 NY
  const dayMap: Record<string, number> = {
    Sun: 5,
    Mon: 4,
    Tue: 3,
    Wed: 2,
    Thu: 1,
    Fri: hourNy < 17 ? 0 : 7,
    Sat: 6
  };
  const daysToFri = dayMap[weekday] ?? 5;
  const hoursToAdd = daysToFri * 24 + (17 - hourNy);
  return new Date(fromMs + Math.max(1, hoursToAdd) * 3600 * 1000).toISOString();
}

// ── Account & Position Valuation ─────────────────────────────────────────────

export function computePositionMetrics(
  pos: PaperPosition,
  quotes: Record<string, PaperLiveQuote>,
  leverage: number,
  zeroSpread: boolean
): PositionLiveMetrics {
  const key = normalizeSymbolKey(pos.symbol);
  const live = quotes[key];
  const lastPrice = live?.last ?? pos.lastKnownPrice ?? pos.avgFillPrice;
  const ba = live ?? computeBidAsk(lastPrice, pos.symbol, zeroSpread);
  // Long closes on Bid; Short closes on Ask
  const markPrice = pos.side === 'long' ? ba.bid || lastPrice : ba.ask || lastPrice;
  const unrealizedPnl = computePnlUsd(pos.symbol, pos.side, pos.quantity, pos.avgFillPrice, markPrice);
  const tradeValue = computeTradeValueUsd(pos.symbol, pos.quantity, pos.avgFillPrice);
  const usedMargin = leverage > 0 ? tradeValue / leverage : tradeValue;
  const unrealizedPnlPct = tradeValue > 0 ? (unrealizedPnl / tradeValue) * 100 : 0;

  let liveR: number | null = null;
  if (typeof pos.initialRiskUsd === 'number' && pos.initialRiskUsd > 0.01) {
    liveR = unrealizedPnl / pos.initialRiskUsd;
  } else if (pos.stopLoss !== null) {
    const slRisk = Math.abs(
      computePnlUsd(pos.symbol, pos.side, pos.quantity, pos.avgFillPrice, pos.stopLoss)
    );
    if (slRisk > 0.01) {
      liveR = unrealizedPnl / slRisk;
    }
  }

  return {
    lastPrice,
    markPrice,
    unrealizedPnl,
    unrealizedPnlPct,
    tradeValue,
    usedMargin,
    liveR
  };
}

export function computeAccountMetrics(
  acc: PaperAccount,
  quotes: Record<string, PaperLiveQuote>
): AccountSummaryMetrics {
  let unrealizedPnl = 0;
  let usedMargin = 0;
  for (const pos of acc.positions) {
    const m = computePositionMetrics(pos, quotes, acc.settings.leverage, acc.settings.zeroSpread);
    unrealizedPnl += m.unrealizedPnl;
    usedMargin += m.usedMargin;
  }
  const equity = acc.balance + unrealizedPnl;
  const availableFunds = equity - usedMargin;
  const marginBufferPct =
    equity > 0 ? Math.max(0, Math.min(100, (availableFunds / equity) * 100)) : 0;

  return {
    balance: acc.balance,
    unrealizedPnl,
    realizedPnl: acc.realizedPnl,
    equity,
    usedMargin,
    availableFunds,
    marginBufferPct
  };
}

// ── Core Fill & Position Netting Engine ──────────────────────────────────────

function computeInitialRiskUsd(
  symbol: string,
  side: PositionSide,
  quantity: number,
  entryPrice: number,
  stopLoss: number | null
): number | null {
  if (stopLoss === null || !Number.isFinite(stopLoss) || stopLoss <= 0) return null;
  const validSl = side === 'long' ? stopLoss < entryPrice : stopLoss > entryPrice;
  if (!validSl) return null;
  const risk = Math.abs(computePnlUsd(symbol, side, quantity, entryPrice, stopLoss));
  return risk > 0.01 ? Number(risk.toFixed(2)) : null;
}

interface ApplyFillResult {
  account: PaperAccount;
  closedTrades: ClosedTrade[];
  openedOrUpdatedPosition: PaperPosition | null;
}

function applyExecutionToAccount(
  acc: PaperAccount,
  params: {
    symbol: string;
    shortName: string;
    side: OrderSide;
    orderType?: OrderType;
    quantity: number;
    fillPrice: number;
    takeProfit: number | null;
    stopLoss: number | null;
    ts: string;
    closeReason?: TradeCloseReason;
    sourceLabel: string;
  }
): ApplyFillResult {
  const { symbol, shortName, side, quantity, fillPrice, takeProfit, stopLoss, ts, sourceLabel } =
    params;
  const fillOrderType: OrderType = params.orderType ?? 'market';
  const targetKey = normalizeSymbolKey(symbol);
  const existingIdx = acc.positions.findIndex((p) => normalizeSymbolKey(p.symbol) === targetKey);
  const incomingPosSide: PositionSide = side === 'buy' ? 'long' : 'short';
  const commission = Math.max(0, acc.settings.commissionPerOrder || 0);

  let nextAcc = acc;
  const closedTrades: ClosedTrade[] = [];
  let openedOrUpdated: PaperPosition | null = null;

  if (commission > 0) {
    nextAcc = {
      ...nextAcc,
      balance: Number((nextAcc.balance - commission).toFixed(2)),
      realizedPnl: Number((nextAcc.realizedPnl - commission).toFixed(2))
    };
    nextAcc = pushBalanceHistory(
      nextAcc,
      'commission',
      -commission,
      nextAcc.balance,
      `Commission on ${shortName} (${side.toUpperCase()} ${formatQty(quantity)})`,
      symbol,
      ts
    );
  }

  if (existingIdx === -1) {
    // Open brand-new position
    const newPos: PaperPosition = {
      id: makeWorkspaceId('pos'),
      symbol,
      shortName,
      side: incomingPosSide,
      quantity,
      avgFillPrice: fillPrice,
      takeProfit,
      stopLoss,
      initialRiskUsd: computeInitialRiskUsd(symbol, incomingPosSide, quantity, fillPrice, stopLoss),
      openedAt: ts,
      updatedAt: ts,
      lastKnownPrice: fillPrice,
      fills: [
        {
          id: makeWorkspaceId('leg'),
          side,
          quantity,
          fillPrice,
          orderType: fillOrderType,
          filledAt: ts
        }
      ]
    };
    openedOrUpdated = newPos;
    nextAcc = {
      ...nextAcc,
      positions: [newPos, ...nextAcc.positions]
    };
    nextAcc = pushActivity(
      nextAcc,
      'fill',
      `${sourceLabel}: ${side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(quantity)} ${shortName} @ ${formatPaperPrice(fillPrice, symbol)}`,
      symbol,
      undefined,
      ts
    );
    return { account: nextAcc, closedTrades, openedOrUpdatedPosition: openedOrUpdated };
  }

  const existing = nextAcc.positions[existingIdx];

  // Case 1: Scaling in (same direction)
  if (existing.side === incomingPosSide) {
    const newQty = Number((existing.quantity + quantity).toFixed(6));
    const weightedAvg = roundToTick(
      (existing.avgFillPrice * existing.quantity + fillPrice * quantity) / newQty,
      symbol
    );
    const mergedTp = takeProfit ?? existing.takeProfit;
    const mergedSl = stopLoss ?? existing.stopLoss;
    const prevFills =
      Array.isArray(existing.fills) && existing.fills.length > 0
        ? existing.fills
        : [
            {
              id: makeWorkspaceId('leg'),
              side: existing.side === 'long' ? ('buy' as OrderSide) : ('sell' as OrderSide),
              quantity: existing.quantity,
              fillPrice: existing.avgFillPrice,
              orderType: 'market' as OrderType,
              filledAt: existing.openedAt
            }
          ];
    const updatedPos: PaperPosition = {
      ...existing,
      quantity: newQty,
      avgFillPrice: weightedAvg,
      takeProfit: mergedTp,
      stopLoss: mergedSl,
      initialRiskUsd:
        computeInitialRiskUsd(symbol, existing.side, newQty, weightedAvg, mergedSl) ??
        existing.initialRiskUsd,
      updatedAt: ts,
      lastKnownPrice: fillPrice,
      fills: [
        ...prevFills,
        {
          id: makeWorkspaceId('leg'),
          side,
          quantity,
          fillPrice,
          orderType: fillOrderType,
          filledAt: ts
        }
      ]
    };
    openedOrUpdated = updatedPos;
    const nextPositions = nextAcc.positions.map((p, i) => (i === existingIdx ? updatedPos : p));
    nextAcc = { ...nextAcc, positions: nextPositions };
    nextAcc = pushActivity(
      nextAcc,
      'fill',
      `${sourceLabel} (scale in): ${side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(quantity)} ${shortName} @ ${formatPaperPrice(fillPrice, symbol)} (Avg ${formatPaperPrice(weightedAvg, symbol)})`,
      symbol,
      undefined,
      ts
    );
    return { account: nextAcc, closedTrades, openedOrUpdatedPosition: openedOrUpdated };
  }

  // Case 2: Opposite direction — reduce, fully close, or reverse
  const closeQty = Math.min(existing.quantity, quantity);
  const remainExisting = Number((existing.quantity - closeQty).toFixed(6));
  const flipQty = Number((quantity - closeQty).toFixed(6));

  const realized = computePnlUsd(symbol, existing.side, closeQty, existing.avgFillPrice, fillPrice);
  const tradeVal = computeTradeValueUsd(symbol, closeQty, existing.avgFillPrice);
  const realizedPct = tradeVal > 0 ? (realized / tradeVal) * 100 : 0;

  // Proportional initial risk for partial/full close R-multiple
  const ratioClosed = existing.quantity > 0 ? closeQty / existing.quantity : 1;
  const portionRisk =
    typeof existing.initialRiskUsd === 'number' && existing.initialRiskUsd > 0.01
      ? Number((existing.initialRiskUsd * ratioClosed).toFixed(2))
      : computeInitialRiskUsd(symbol, existing.side, closeQty, existing.avgFillPrice, existing.stopLoss);
  const realizedR =
    portionRisk !== null && portionRisk > 0.01 ? Number((realized / portionRisk).toFixed(2)) : null;

  const reason: TradeCloseReason =
    params.closeReason ??
    (flipQty > 0 ? 'reverse' : remainExisting > 0 ? 'partial' : 'manual');

  const closed: ClosedTrade = {
    id: makeWorkspaceId('tr'),
    symbol: existing.symbol,
    shortName: existing.shortName,
    side: existing.side,
    quantity: closeQty,
    entryPrice: existing.avgFillPrice,
    exitPrice: fillPrice,
    openedAt: existing.openedAt,
    closedAt: ts,
    realizedPnl: Number(realized.toFixed(2)),
    realizedPnlPct: Number(realizedPct.toFixed(2)),
    commission,
    initialRiskUsd: portionRisk,
    realizedR,
    closeReason: reason
  };
  closedTrades.push(closed);

  const nextBalance = Number((nextAcc.balance + realized).toFixed(2));
  const nextRealizedTotal = Number((nextAcc.realizedPnl + realized).toFixed(2));
  nextAcc = {
    ...nextAcc,
    balance: nextBalance,
    realizedPnl: nextRealizedTotal,
    tradeHistory: [closed, ...nextAcc.tradeHistory].slice(0, MAX_HISTORY_ITEMS)
  };
  nextAcc = pushBalanceHistory(
    nextAcc,
    'realized_pnl',
    realized,
    nextBalance,
    `${reason === 'tp' || reason === 'offline_tp' ? 'Take profit' : reason === 'sl' || reason === 'offline_sl' ? 'Stop loss' : remainExisting > 0 ? 'Partial close' : 'Closed'} ${existing.side.toUpperCase()} ${formatQty(closeQty)} ${shortName} @ ${formatPaperPrice(fillPrice, symbol)}`,
    symbol,
    ts
  );

  let nextPositions = nextAcc.positions.filter((_, i) => i !== existingIdx);

  if (remainExisting > 0.000001) {
    const remainingRisk =
      typeof existing.initialRiskUsd === 'number' && existing.initialRiskUsd > 0.01
        ? Number((existing.initialRiskUsd * (1 - ratioClosed)).toFixed(2))
        : computeInitialRiskUsd(symbol, existing.side, remainExisting, existing.avgFillPrice, existing.stopLoss);
    const reducedPos: PaperPosition = {
      ...existing,
      quantity: remainExisting,
      initialRiskUsd: remainingRisk,
      updatedAt: ts,
      lastKnownPrice: fillPrice
    };
    openedOrUpdated = reducedPos;
    nextPositions = [reducedPos, ...nextPositions];
  } else if (flipQty > 0.000001) {
    const flippedPos: PaperPosition = {
      id: makeWorkspaceId('pos'),
      symbol,
      shortName,
      side: incomingPosSide,
      quantity: flipQty,
      avgFillPrice: fillPrice,
      takeProfit,
      stopLoss,
      initialRiskUsd: computeInitialRiskUsd(symbol, incomingPosSide, flipQty, fillPrice, stopLoss),
      openedAt: ts,
      updatedAt: ts,
      lastKnownPrice: fillPrice
    };
    openedOrUpdated = flippedPos;
    nextPositions = [flippedPos, ...nextPositions];
  }

  nextAcc = { ...nextAcc, positions: nextPositions };
  nextAcc = pushActivity(
    nextAcc,
    reason === 'tp' || reason === 'sl' || reason === 'offline_tp' || reason === 'offline_sl'
      ? 'bracket'
      : 'fill',
    `${sourceLabel}: ${side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(quantity)} ${shortName} @ ${formatPaperPrice(fillPrice, symbol)} (Realized ${realized >= 0 ? '+' : ''}${realized.toFixed(2)} USD)`,
    symbol,
    undefined,
    ts
  );

  return { account: nextAcc, closedTrades, openedOrUpdatedPosition: openedOrUpdated };
}

// ── Public Order Placement & Management ──────────────────────────────────────

export function placePaperOrder(
  req: PlaceOrderRequest
): { ok: boolean; order?: PaperOrder; error?: string } {
  if (!state.connected) {
    return { ok: false, error: 'Paper Ledger is not connected.' };
  }

  const symbol = req.symbol.trim();
  const shortName = req.shortName.trim() || normalizeShortTicker(symbol);
  const qty = Number(req.quantity);
  if (!symbol || !Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: 'Quantity must be greater than zero.' };
  }

  const acc = getActivePaperAccount(state);
  const liveQ = getPaperLiveQuote(symbol);
  if (!liveQ || !Number.isFinite(liveQ.last) || liveQ.last <= 0) {
    const err = `Waiting for live quote on ${shortName}. Try again in a moment.`;
    emitToast({ kind: 'rejected', title: 'Order rejected', symbol, shortName, detail: err });
    return { ok: false, error: err };
  }

  const side = req.side;
  const type = req.type;
  const tif: TimeInForce = req.tif ?? 'GTC';
  const nowIso = new Date().toISOString();

  const refExecPrice =
    type === 'market'
      ? side === 'buy'
        ? liveQ.ask
        : liveQ.bid
      : roundToTick(Number(req.orderPrice ?? 0), symbol);

  if (type !== 'market' && (!Number.isFinite(refExecPrice) || refExecPrice <= 0)) {
    return { ok: false, error: 'Enter a valid order price.' };
  }

  // Stop order side validation (standard exchange rule)
  if (type === 'stop') {
    if (side === 'buy' && refExecPrice <= liveQ.ask) {
      const err = `Buy Stop price must be above current Ask (${formatPaperPrice(liveQ.ask, symbol)}).`;
      emitToast({ kind: 'rejected', title: 'Stop order rejected', symbol, shortName, detail: err });
      return { ok: false, error: err };
    }
    if (side === 'sell' && refExecPrice >= liveQ.bid) {
      const err = `Sell Stop price must be below current Bid (${formatPaperPrice(liveQ.bid, symbol)}).`;
      emitToast({ kind: 'rejected', title: 'Stop order rejected', symbol, shortName, detail: err });
      return { ok: false, error: err };
    }
  }

  // Validate TP/SL direction against expected entry price
  const tp =
    typeof req.takeProfit === 'number' && Number.isFinite(req.takeProfit) && req.takeProfit > 0
      ? roundToTick(req.takeProfit, symbol)
      : null;
  const sl =
    typeof req.stopLoss === 'number' && Number.isFinite(req.stopLoss) && req.stopLoss > 0
      ? roundToTick(req.stopLoss, symbol)
      : null;

  if (tp !== null) {
    const validTp = side === 'buy' ? tp > refExecPrice : tp < refExecPrice;
    if (!validTp) {
      const err =
        side === 'buy'
          ? 'Take profit for a Buy order must be above entry price.'
          : 'Take profit for a Sell order must be below entry price.';
      return { ok: false, error: err };
    }
  }
  if (sl !== null) {
    const validSl = side === 'buy' ? sl < refExecPrice : sl > refExecPrice;
    if (!validSl) {
      const err =
        side === 'buy'
          ? 'Stop loss for a Buy order must be below entry price.'
          : 'Stop loss for a Sell order must be above entry price.';
      return { ok: false, error: err };
    }
  }

  // Margin sufficiency check (only required if order opens or increases net exposure)
  const existingPos = acc.positions.find(
    (p) => normalizeSymbolKey(p.symbol) === normalizeSymbolKey(symbol)
  );
  const incomingPosSide: PositionSide = side === 'buy' ? 'long' : 'short';
  const netIncreasingQty =
    existingPos && existingPos.side !== incomingPosSide
      ? Math.max(0, qty - existingPos.quantity)
      : qty;

  if (netIncreasingQty > 0) {
    const requiredMargin =
      computeTradeValueUsd(symbol, netIncreasingQty, refExecPrice) / Math.max(1, acc.settings.leverage);
    const metrics = computeAccountMetrics(acc, liveQuotesSnapshot);
    if (requiredMargin > metrics.availableFunds) {
      const err = `Insufficient margin: needs ${requiredMargin.toFixed(2)} USD, available ${metrics.availableFunds.toFixed(2)} USD.`;
      const rejectedOrder: PaperOrder = {
        id: makeWorkspaceId('ord'),
        symbol,
        shortName,
        side,
        type,
        quantity: qty,
        orderPrice: type === 'market' ? null : refExecPrice,
        fillPrice: null,
        takeProfit: tp,
        stopLoss: sl,
        tif,
        expiresAt: null,
        status: 'rejected',
        rejectReason: err,
        placedAt: nowIso,
        updatedAt: nowIso
      };
      updateActiveAccount(
        (cur) =>
          pushActivity(
            {
              ...cur,
              orderHistory: [rejectedOrder, ...cur.orderHistory].slice(0, MAX_HISTORY_ITEMS)
            },
            'order',
            `Rejected ${side.toUpperCase()} ${formatQty(qty)} ${shortName}: ${err}`,
            symbol
          ),
        true
      );
      emitToast({ kind: 'rejected', title: 'Order rejected', symbol, shortName, side, quantity: qty, detail: err });
      return { ok: false, order: rejectedOrder, error: err };
    }
  }

  // Determine immediate fill vs working order
  const isMarketableLimit =
    type === 'limit' &&
    ((side === 'buy' && refExecPrice >= liveQ.ask) || (side === 'sell' && refExecPrice <= liveQ.bid));

  if (type === 'market' || isMarketableLimit) {
    const fillPrice = side === 'buy' ? liveQ.ask : liveQ.bid;
    const filledOrder: PaperOrder = {
      id: makeWorkspaceId('ord'),
      symbol,
      shortName,
      side,
      type,
      quantity: qty,
      orderPrice: type === 'market' ? null : refExecPrice,
      fillPrice,
      takeProfit: tp,
      stopLoss: sl,
      tif,
      expiresAt: null,
      status: 'filled',
      note: req.note,
      placedAt: nowIso,
      updatedAt: nowIso,
      filledAt: nowIso
    };

    updateActiveAccount((cur) => {
      const applied = applyExecutionToAccount(cur, {
        symbol,
        shortName,
        side,
        orderType: type,
        quantity: qty,
        fillPrice,
        takeProfit: tp,
        stopLoss: sl,
        ts: nowIso,
        sourceLabel: type === 'market' ? 'Market order executed' : 'Limit order executed'
      });
      return {
        ...applied.account,
        orderHistory: [filledOrder, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS),
        lastEvaluatedAt: Math.floor(Date.now() / 1000)
      };
    }, true);

    playAlertChime();
    emitToast({
      kind: 'executed',
      title: type === 'market' ? 'Market order executed on' : 'Limit order executed on',
      symbol,
      shortName,
      side,
      quantity: qty,
      price: fillPrice
    });
    return { ok: true, order: filledOrder };
  }

  // Place working Limit or Stop order
  const workingOrder: PaperOrder = {
    id: makeWorkspaceId('ord'),
    symbol,
    shortName,
    side,
    type,
    quantity: qty,
    orderPrice: refExecPrice,
    fillPrice: null,
    takeProfit: tp,
    stopLoss: sl,
    tif,
    expiresAt: computeOrderExpiry(tif),
    status: 'working',
    note: req.note,
    placedAt: nowIso,
    updatedAt: nowIso
  };

  updateActiveAccount(
    (cur) =>
      pushActivity(
        {
          ...cur,
          orders: [workingOrder, ...cur.orders],
          lastEvaluatedAt: Math.floor(Date.now() / 1000)
        },
        'order',
        `${type === 'limit' ? 'Limit' : 'Stop'} order placed: ${side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(qty)} ${shortName} @ ${formatPaperPrice(refExecPrice, symbol)} (${tif})`,
        symbol
      ),
    true
  );

  emitToast({
    kind: 'placed',
    title: `${type === 'limit' ? 'Limit' : 'Stop'} order placed on`,
    symbol,
    shortName,
    side,
    quantity: qty,
    price: refExecPrice
  });
  return { ok: true, order: workingOrder };
}

export function modifyPositionBrackets(
  positionId: string,
  takeProfit: number | null,
  stopLoss: number | null
): { ok: boolean; error?: string } {
  const acc = getActivePaperAccount(state);
  const pos = acc.positions.find((p) => p.id === positionId);
  if (!pos) return { ok: false, error: 'Position not found' };

  const liveQ = getPaperLiveQuote(pos.symbol);
  const refPrice = liveQ?.last ?? pos.lastKnownPrice ?? pos.avgFillPrice;
  const cleanTp =
    typeof takeProfit === 'number' && Number.isFinite(takeProfit) && takeProfit > 0
      ? roundToTick(takeProfit, pos.symbol)
      : null;
  const cleanSl =
    typeof stopLoss === 'number' && Number.isFinite(stopLoss) && stopLoss > 0
      ? roundToTick(stopLoss, pos.symbol)
      : null;

  if (cleanTp !== null) {
    const ok = pos.side === 'long' ? cleanTp > refPrice : cleanTp < refPrice;
    if (!ok) {
      return {
        ok: false,
        error:
          pos.side === 'long'
            ? `Take profit must be above current price (${formatPaperPrice(refPrice, pos.symbol)}).`
            : `Take profit must be below current price (${formatPaperPrice(refPrice, pos.symbol)}).`
      };
    }
  }
  if (cleanSl !== null) {
    const ok = pos.side === 'long' ? cleanSl < refPrice : cleanSl > refPrice;
    if (!ok) {
      return {
        ok: false,
        error:
          pos.side === 'long'
            ? `Stop loss must be below current price (${formatPaperPrice(refPrice, pos.symbol)}).`
            : `Stop loss must be above current price (${formatPaperPrice(refPrice, pos.symbol)}).`
      };
    }
  }

  const nowIso = new Date().toISOString();
  updateActiveAccount((cur) => {
    const nextPositions = cur.positions.map((p) => {
      if (p.id !== positionId) return p;
      const nextInitialRisk =
        p.initialRiskUsd ??
        computeInitialRiskUsd(p.symbol, p.side, p.quantity, p.avgFillPrice, cleanSl);
      return {
        ...p,
        takeProfit: cleanTp,
        stopLoss: cleanSl,
        initialRiskUsd: nextInitialRisk,
        updatedAt: nowIso
      };
    });
    return pushActivity(
      { ...cur, positions: nextPositions },
      'bracket',
      `Updated ${pos.shortName} exits: TP ${cleanTp !== null ? formatPaperPrice(cleanTp, pos.symbol) : '—'} · SL ${cleanSl !== null ? formatPaperPrice(cleanSl, pos.symbol) : '—'}`,
      pos.symbol
    );
  }, true);

  const parts: string[] = [];
  if (cleanTp !== null) parts.push(`TP ${formatPaperPrice(cleanTp, pos.symbol)}`);
  if (cleanSl !== null) parts.push(`SL ${formatPaperPrice(cleanSl, pos.symbol)}`);
  emitToast({
    kind: 'placed',
    title: parts.length > 0 ? 'Position brackets updated on' : 'Position brackets cleared on',
    symbol: pos.symbol,
    shortName: pos.shortName,
    detail: parts.length > 0 ? parts.join(' · ') : 'No active TP or SL'
  });

  return { ok: true };
}

export function removePositionBracket(positionId: string, which: 'tp' | 'sl'): void {
  const acc = getActivePaperAccount(state);
  const pos = acc.positions.find((p) => p.id === positionId);
  if (!pos) return;
  const nextTp = which === 'tp' ? null : pos.takeProfit;
  const nextSl = which === 'sl' ? null : pos.stopLoss;
  const nowIso = new Date().toISOString();
  const removedPrice = which === 'tp' ? pos.takeProfit : pos.stopLoss;

  updateActiveAccount((cur) => {
    const nextPositions = cur.positions.map((p) =>
      p.id === positionId ? { ...p, takeProfit: nextTp, stopLoss: nextSl, updatedAt: nowIso } : p
    );
    return pushActivity(
      { ...cur, positions: nextPositions },
      'bracket',
      `Cancelled ${which === 'tp' ? 'Take Profit' : 'Stop Loss'} bracket on ${pos.shortName}${removedPrice !== null ? ` (@ ${formatPaperPrice(removedPrice, pos.symbol)})` : ''}`,
      pos.symbol
    );
  }, true);

  emitToast({
    kind: 'cancelled',
    title: `${which === 'tp' ? 'Take profit' : 'Stop loss'} cancelled on`,
    symbol: pos.symbol,
    shortName: pos.shortName,
    price: removedPrice ?? undefined
  });
}

export function modifyWorkingOrder(
  orderId: string,
  patch: {
    orderPrice?: number;
    quantity?: number;
    takeProfit?: number | null;
    stopLoss?: number | null;
    tif?: TimeInForce;
  }
): { ok: boolean; error?: string } {
  const acc = getActivePaperAccount(state);
  const ord = acc.orders.find((o) => o.id === orderId);
  if (!ord) return { ok: false, error: 'Order not found' };

  const nextPrice =
    typeof patch.orderPrice === 'number' && Number.isFinite(patch.orderPrice) && patch.orderPrice > 0
      ? roundToTick(patch.orderPrice, ord.symbol)
      : ord.orderPrice;
  const nextQty =
    typeof patch.quantity === 'number' && Number.isFinite(patch.quantity) && patch.quantity > 0
      ? patch.quantity
      : ord.quantity;
  const nextTp =
    patch.takeProfit === undefined
      ? ord.takeProfit
      : patch.takeProfit !== null && Number.isFinite(patch.takeProfit) && patch.takeProfit > 0
        ? roundToTick(patch.takeProfit, ord.symbol)
        : null;
  const nextSl =
    patch.stopLoss === undefined
      ? ord.stopLoss
      : patch.stopLoss !== null && Number.isFinite(patch.stopLoss) && patch.stopLoss > 0
        ? roundToTick(patch.stopLoss, ord.symbol)
        : null;
  const nextTif = patch.tif ?? ord.tif;

  const nowIso = new Date().toISOString();
  updateActiveAccount((cur) => {
    const nextOrders = cur.orders.map((o) =>
      o.id === orderId
        ? {
            ...o,
            orderPrice: nextPrice,
            quantity: nextQty,
            takeProfit: nextTp,
            stopLoss: nextSl,
            tif: nextTif,
            expiresAt: computeOrderExpiry(nextTif),
            updatedAt: nowIso
          }
        : o
    );
    return pushActivity(
      { ...cur, orders: nextOrders },
      'order',
      `Modified ${ord.type} order on ${ord.shortName} -> ${formatQty(nextQty)} @ ${formatPaperPrice(nextPrice, ord.symbol)}`,
      ord.symbol
    );
  }, true);

  return { ok: true };
}

export function cancelWorkingOrder(orderId: string): void {
  const acc = getActivePaperAccount(state);
  const ord = acc.orders.find((o) => o.id === orderId);
  if (!ord) return;
  const nowIso = new Date().toISOString();
  const cancelled: PaperOrder = { ...ord, status: 'cancelled', updatedAt: nowIso };
  updateActiveAccount(
    (cur) =>
      pushActivity(
        {
          ...cur,
          orders: cur.orders.filter((o) => o.id !== orderId),
          orderHistory: [cancelled, ...cur.orderHistory].slice(0, MAX_HISTORY_ITEMS)
        },
        'order',
        `Cancelled ${ord.type} order: ${ord.side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(ord.quantity)} ${ord.shortName}`,
        ord.symbol
      ),
    true
  );
  emitToast({
    kind: 'cancelled',
    title: 'Order cancelled on',
    symbol: ord.symbol,
    shortName: ord.shortName,
    side: ord.side,
    quantity: ord.quantity,
    price: ord.orderPrice ?? undefined
  });
}

export function closePaperPosition(
  positionId: string,
  partialQuantity?: number | null
): { ok: boolean; closedTrade?: ClosedTrade; error?: string } {
  const acc = getActivePaperAccount(state);
  const pos = acc.positions.find((p) => p.id === positionId);
  if (!pos) return { ok: false, error: 'Position not found' };

  const liveQ = getPaperLiveQuote(pos.symbol);
  const lastPrice = liveQ?.last ?? pos.lastKnownPrice ?? pos.avgFillPrice;
  const ba = liveQ ?? computeBidAsk(lastPrice, pos.symbol, acc.settings.zeroSpread);
  const closeSide: OrderSide = pos.side === 'long' ? 'sell' : 'buy';
  const closePrice = closeSide === 'sell' ? ba.bid || lastPrice : ba.ask || lastPrice;

  const qty =
    typeof partialQuantity === 'number' && Number.isFinite(partialQuantity) && partialQuantity > 0
      ? Math.min(pos.quantity, partialQuantity)
      : pos.quantity;
  const isPartial = qty < pos.quantity - 0.000001;
  const nowIso = new Date().toISOString();

  const closeOrder: PaperOrder = {
    id: makeWorkspaceId('ord'),
    symbol: pos.symbol,
    shortName: pos.shortName,
    side: closeSide,
    type: 'market',
    quantity: qty,
    orderPrice: null,
    fillPrice: closePrice,
    takeProfit: null,
    stopLoss: null,
    tif: 'GTC',
    expiresAt: null,
    status: 'filled',
    note: isPartial ? 'Partial close' : 'Close position',
    placedAt: nowIso,
    updatedAt: nowIso,
    filledAt: nowIso
  };

  let createdTrade: ClosedTrade | undefined;
  updateActiveAccount((cur) => {
    const applied = applyExecutionToAccount(cur, {
      symbol: pos.symbol,
      shortName: pos.shortName,
      side: closeSide,
      quantity: qty,
      fillPrice: closePrice,
      takeProfit: null,
      stopLoss: null,
      ts: nowIso,
      closeReason: isPartial ? 'partial' : 'manual',
      sourceLabel: isPartial ? 'Partial close executed' : 'Position closed'
    });
    createdTrade = applied.closedTrades[0];
    return {
      ...applied.account,
      orderHistory: [closeOrder, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS),
      lastEvaluatedAt: Math.floor(Date.now() / 1000)
    };
  }, true);

  playAlertChime();
  emitToast({
    kind: 'executed',
    title: isPartial ? 'Partial close executed on' : 'Position closed on',
    symbol: pos.symbol,
    shortName: pos.shortName,
    side: closeSide,
    quantity: qty,
    price: closePrice
  });

  return { ok: true, closedTrade: createdTrade };
}

export function reversePaperPosition(positionId: string): { ok: boolean; error?: string } {
  const acc = getActivePaperAccount(state);
  const pos = acc.positions.find((p) => p.id === positionId);
  if (!pos) return { ok: false, error: 'Position not found' };
  const reverseSide: OrderSide = pos.side === 'long' ? 'sell' : 'buy';
  const res = placePaperOrder({
    symbol: pos.symbol,
    shortName: pos.shortName,
    side: reverseSide,
    type: 'market',
    quantity: Number((pos.quantity * 2).toFixed(6)),
    note: 'Reverse position'
  });
  return { ok: res.ok, error: res.error };
}

export function markTradeSentToPlaybook(tradeId: string, playbookEntryId: string): void {
  updateActiveAccount((cur) => ({
    ...cur,
    tradeHistory: cur.tradeHistory.map((t) =>
      t.id === tradeId ? { ...t, sentToPlaybook: true, playbookEntryId } : t
    )
  }), true);
}

// ── Real-Time Evaluation (Ticks + Brackets + Expiries) ───────────────────────

function evaluateAccountWithTick(
  acc: PaperAccount,
  symbolKey: string,
  liveQ: PaperLiveQuote
): { account: PaperAccount; mutated: boolean; toasts: Omit<PaperToast, 'id' | 'createdAt'>[] } {
  let nextAcc = acc;
  let mutated = false;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const toasts: Omit<PaperToast, 'id' | 'createdAt'>[] = [];

  // 1. Check working order expiries and Limit/Stop triggers
  const remainingOrders: PaperOrder[] = [];
  for (const ord of nextAcc.orders) {
    if (ord.expiresAt && Date.parse(ord.expiresAt) <= nowMs) {
      mutated = true;
      const expired: PaperOrder = { ...ord, status: 'expired', updatedAt: nowIso };
      nextAcc = pushActivity(
        {
          ...nextAcc,
          orderHistory: [expired, ...nextAcc.orderHistory].slice(0, MAX_HISTORY_ITEMS)
        },
        'order',
        `${ord.type} order expired (${ord.tif}): ${ord.side.toUpperCase()} ${formatQty(ord.quantity)} ${ord.shortName}`,
        ord.symbol,
        undefined,
        nowIso
      );
      continue;
    }

    if (normalizeSymbolKey(ord.symbol) !== symbolKey || ord.orderPrice === null) {
      remainingOrders.push(ord);
      continue;
    }

    let triggered = false;
    let fillPrice = ord.orderPrice;

    if (ord.type === 'limit') {
      if (ord.side === 'buy' && liveQ.ask <= ord.orderPrice) {
        triggered = true;
        fillPrice = Math.min(liveQ.ask, ord.orderPrice);
      } else if (ord.side === 'sell' && liveQ.bid >= ord.orderPrice) {
        triggered = true;
        fillPrice = Math.max(liveQ.bid, ord.orderPrice);
      }
    } else if (ord.type === 'stop') {
      if (ord.side === 'buy' && liveQ.ask >= ord.orderPrice) {
        triggered = true;
        fillPrice = liveQ.ask;
      } else if (ord.side === 'sell' && liveQ.bid <= ord.orderPrice) {
        triggered = true;
        fillPrice = liveQ.bid;
      }
    }

    if (!triggered) {
      remainingOrders.push(ord);
      continue;
    }

    // Re-check margin before filling working order
    const existingPos = nextAcc.positions.find(
      (p) => normalizeSymbolKey(p.symbol) === symbolKey
    );
    const incomingPosSide: PositionSide = ord.side === 'buy' ? 'long' : 'short';
    const netInc =
      existingPos && existingPos.side !== incomingPosSide
        ? Math.max(0, ord.quantity - existingPos.quantity)
        : ord.quantity;
    if (netInc > 0) {
      const reqMargin =
        computeTradeValueUsd(ord.symbol, netInc, fillPrice) / Math.max(1, nextAcc.settings.leverage);
      const metrics = computeAccountMetrics(nextAcc, liveQuotesSnapshot);
      if (reqMargin > metrics.availableFunds) {
        mutated = true;
        const rej: PaperOrder = {
          ...ord,
          status: 'rejected',
          rejectReason: 'Insufficient margin at trigger time',
          updatedAt: nowIso
        };
        nextAcc = pushActivity(
          {
            ...nextAcc,
            orderHistory: [rej, ...nextAcc.orderHistory].slice(0, MAX_HISTORY_ITEMS)
          },
          'order',
          `Pending ${ord.type} order rejected on ${ord.shortName}: insufficient margin`,
          ord.symbol,
          undefined,
          nowIso
        );
        toasts.push({
          kind: 'rejected',
          title: `${ord.type === 'limit' ? 'Limit' : 'Stop'} order rejected on`,
          symbol: ord.symbol,
          shortName: ord.shortName,
          side: ord.side,
          quantity: ord.quantity,
          detail: 'Insufficient margin at trigger time'
        });
        continue;
      }
    }

    mutated = true;
    const filledOrd: PaperOrder = {
      ...ord,
      status: 'filled',
      fillPrice,
      filledAt: nowIso,
      updatedAt: nowIso
    };
    const applied = applyExecutionToAccount(nextAcc, {
      symbol: ord.symbol,
      shortName: ord.shortName,
      side: ord.side,
      quantity: ord.quantity,
      fillPrice,
      takeProfit: ord.takeProfit,
      stopLoss: ord.stopLoss,
      ts: nowIso,
      sourceLabel: ord.type === 'limit' ? 'Limit order executed' : 'Stop order executed'
    });
    nextAcc = {
      ...applied.account,
      orderHistory: [filledOrd, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS)
    };
    toasts.push({
      kind: 'executed',
      title: `${ord.type === 'limit' ? 'Limit' : 'Stop'} order executed on`,
      symbol: ord.symbol,
      shortName: ord.shortName,
      side: ord.side,
      quantity: ord.quantity,
      price: fillPrice
    });
  }

  if (mutated) {
    nextAcc = { ...nextAcc, orders: remainingOrders };
  }

  // 2. Check open position TP / SL OCO brackets
  const matchingPos = nextAcc.positions.find(
    (p) => normalizeSymbolKey(p.symbol) === symbolKey
  );
  if (matchingPos) {
    // Update in-memory lastKnownPrice silently
    matchingPos.lastKnownPrice = liveQ.last;

    let hitKind: 'tp' | 'sl' | null = null;
    let exitPrice = liveQ.last;

    if (matchingPos.side === 'long') {
      if (matchingPos.stopLoss !== null && liveQ.bid <= matchingPos.stopLoss) {
        hitKind = 'sl';
        exitPrice = liveQ.bid;
      } else if (matchingPos.takeProfit !== null && liveQ.bid >= matchingPos.takeProfit) {
        hitKind = 'tp';
        exitPrice = Math.max(liveQ.bid, matchingPos.takeProfit);
      }
    } else {
      if (matchingPos.stopLoss !== null && liveQ.ask >= matchingPos.stopLoss) {
        hitKind = 'sl';
        exitPrice = liveQ.ask;
      } else if (matchingPos.takeProfit !== null && liveQ.ask <= matchingPos.takeProfit) {
        hitKind = 'tp';
        exitPrice = Math.min(liveQ.ask, matchingPos.takeProfit);
      }
    }

    if (hitKind) {
      mutated = true;
      const closeSide: OrderSide = matchingPos.side === 'long' ? 'sell' : 'buy';
      const bracketOrd: PaperOrder = {
        id: makeWorkspaceId('ord'),
        symbol: matchingPos.symbol,
        shortName: matchingPos.shortName,
        side: closeSide,
        type: hitKind === 'tp' ? 'limit' : 'stop',
        quantity: matchingPos.quantity,
        orderPrice: hitKind === 'tp' ? matchingPos.takeProfit : matchingPos.stopLoss,
        fillPrice: exitPrice,
        takeProfit: null,
        stopLoss: null,
        tif: 'GTC',
        expiresAt: null,
        status: 'filled',
        note: hitKind === 'tp' ? 'Take profit OCO' : 'Stop loss OCO',
        placedAt: nowIso,
        updatedAt: nowIso,
        filledAt: nowIso
      };
      const applied = applyExecutionToAccount(nextAcc, {
        symbol: matchingPos.symbol,
        shortName: matchingPos.shortName,
        side: closeSide,
        quantity: matchingPos.quantity,
        fillPrice: exitPrice,
        takeProfit: null,
        stopLoss: null,
        ts: nowIso,
        closeReason: hitKind,
        sourceLabel: hitKind === 'tp' ? 'Take profit executed' : 'Stop loss executed'
      });
      nextAcc = {
        ...applied.account,
        orderHistory: [bracketOrd, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS)
      };
      toasts.push({
        kind: 'executed',
        title: hitKind === 'tp' ? 'Take profit executed on' : 'Stop loss executed on',
        symbol: matchingPos.symbol,
        shortName: matchingPos.shortName,
        side: closeSide,
        quantity: matchingPos.quantity,
        price: exitPrice
      });
    }
  }

  return { account: nextAcc, mutated, toasts };
}

let lastEvalStampSaveMs = 0;

export function feedPaperQuote(
  symbol: string,
  shortName: string,
  price: number,
  source: 'live' | 'poll' = 'live',
  liveSpreadPx?: number | null
): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const key = normalizeSymbolKey(symbol);
  if (!key) return;

  const nowMs = Date.now();
  if (typeof liveSpreadPx === 'number' && Number.isFinite(liveSpreadPx) && liveSpreadPx > 0) {
    liveOandaSpreadByKey.set(key, { spreadPx: liveSpreadPx, updatedAtMs: nowMs });
  }

  const existing = liveQuotesByKey.get(key);
  // Never overwrite a fresh live chart tick with a slower poll quote
  if (
    source === 'poll' &&
    existing &&
    existing.source === 'live' &&
    nowMs - existing.updatedAtMs < LIVE_FRESH_MS
  ) {
    return;
  }

  const acc = getActivePaperAccount(state);
  const effectiveLiveSpread =
    typeof liveSpreadPx === 'number' && Number.isFinite(liveSpreadPx) && liveSpreadPx > 0
      ? liveSpreadPx
      : getFreshLiveSpread(key);
  const ba = computeBidAsk(price, symbol, acc.settings.zeroSpread, effectiveLiveSpread);
  const nextQuote: PaperLiveQuote = {
    symbol,
    shortName: shortName || normalizeShortTicker(symbol),
    last: roundToTick(price, symbol),
    bid: ba.bid,
    ask: ba.ask,
    spreadDisplay: ba.spreadDisplay,
    updatedAtMs: nowMs,
    source
  };

  liveQuotesByKey.set(key, nextQuote);
  liveQuotesSnapshot[key] = nextQuote;
  emitQuotes();

  if (!state.connected) return;

  let anyMutated = false;
  const allToasts: Omit<PaperToast, 'id' | 'createdAt'>[] = [];
  const nextAccounts = state.accounts.map((candidate) => {
    if (candidate.positions.length === 0 && candidate.orders.length === 0) return candidate;
    const evalRes = evaluateAccountWithTick(candidate, key, nextQuote);
    if (evalRes.mutated) {
      anyMutated = true;
      allToasts.push(...evalRes.toasts);
      return {
        ...evalRes.account,
        lastEvaluatedAt: Math.floor(nowMs / 1000)
      };
    }
    return candidate;
  });

  if (anyMutated) {
    commit({ ...state, accounts: nextAccounts }, true);
    playAlertChime();
    for (const t of allToasts) emitToast(t);
  } else if (
    state.accounts.some((a) => a.positions.length > 0 || a.orders.length > 0) &&
    nowMs - lastEvalStampSaveMs > 45_000
  ) {
    // Quietly checkpoint lastEvaluatedAt every ~45s for accurate offline bar reconciliation
    lastEvalStampSaveMs = nowMs;
    const nowSec = Math.floor(nowMs / 1000);
    for (const a of state.accounts) {
      if (a.positions.length > 0 || a.orders.length > 0) a.lastEvaluatedAt = nowSec;
    }
    persistState(false);
  }
}

// ── Background Poller & Offline Historical OHLC Reconciliation ───────────────

async function pollRequiredPaperSymbols(): Promise<void> {
  if (pollInFlight || !state.connected) return;
  const needed = new Map<string, { symbol: string; shortName: string }>();

  for (const candidate of state.accounts) {
    for (const pos of candidate.positions) {
      needed.set(normalizeSymbolKey(pos.symbol), { symbol: pos.symbol, shortName: pos.shortName });
    }
    for (const ord of candidate.orders) {
      needed.set(normalizeSymbolKey(ord.symbol), { symbol: ord.symbol, shortName: ord.shortName });
    }
  }
  // Also keep active chart symbols synced with real live OANDA Bid/Ask spreads
  for (const [k, q] of liveQuotesByKey.entries()) {
    if (!needed.has(k) && getFreshLiveSpread(k) === null) {
      needed.set(k, { symbol: q.symbol, shortName: q.shortName });
    }
  }
  if (needed.size === 0) return;

  const nowMs = Date.now();
  const toFetch: { symbol: string; shortName: string }[] = [];
  for (const [key, item] of needed.entries()) {
    const existing = liveQuotesByKey.get(key);
    const needsPrice =
      !existing || existing.source !== 'live' || nowMs - existing.updatedAtMs >= LIVE_FRESH_MS;
    const needsSpread = getFreshLiveSpread(key) === null;
    if (needsPrice || needsSpread) {
      toFetch.push(item);
    }
  }
  if (toFetch.length === 0) return;

  pollInFlight = true;
  try {
    const quotes = await fetchMarketQuotes(toFetch.map((t) => t.symbol));
    for (const item of toFetch) {
      const q = quotes[item.symbol];
      if (q && Number.isFinite(q.price) && q.price > 0) {
        feedPaperQuote(item.symbol, item.shortName, q.price, 'poll', q.spreadPx);
      }
    }
  } catch {
    // Non-fatal offline/transient network error
  } finally {
    pollInFlight = false;
  }
}

interface BarRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchOfflineBars(symbol: string, fromSec: number): Promise<BarRow[]> {
  try {
    const base = getApiBaseUrl();
    const url = `${base}/api/quotes/bars?symbol=${encodeURIComponent(symbol)}&from=${Math.floor(fromSec)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as { bars?: BarRow[] };
    return Array.isArray(json.bars) ? json.bars : [];
  } catch {
    return [];
  }
}

async function reconcileOfflineBars(): Promise<void> {
  if (reconcileDone || !state.connected) return;
  reconcileDone = true;

  const acc = getActivePaperAccount(state);
  const nowSec = Math.floor(Date.now() / 1000);
  const gapSec = nowSec - (acc.lastEvaluatedAt || nowSec);

  // Only replay historical candles if app was closed for at least 2 minutes and has active orders/brackets
  const hasBrackets = acc.positions.some((p) => p.takeProfit !== null || p.stopLoss !== null);
  const hasWorking = acc.orders.length > 0;
  if (gapSec < 120 || (!hasBrackets && !hasWorking)) return;

  const symbolsMap = new Map<string, string>();
  for (const p of acc.positions) {
    if (p.takeProfit !== null || p.stopLoss !== null) {
      symbolsMap.set(normalizeSymbolKey(p.symbol), p.symbol);
    }
  }
  for (const o of acc.orders) {
    symbolsMap.set(normalizeSymbolKey(o.symbol), o.symbol);
  }
  if (symbolsMap.size === 0) return;

  const entries = Array.from(symbolsMap.entries());
  const barsByKey = new Map<string, BarRow[]>();
  await Promise.all(
    entries.map(async ([key, sym]) => {
      const bars = await fetchOfflineBars(sym, acc.lastEvaluatedAt);
      if (bars.length > 0) barsByKey.set(key, bars);
    })
  );

  if (barsByKey.size === 0) return;

  let workingAcc = getActivePaperAccount(state);
  let offlineEventsCount = 0;
  const zeroSpread = workingAcc.settings.zeroSpread;

  for (const [key, bars] of barsByKey.entries()) {
    const spec = getPaperInstrumentSpec(symbolsMap.get(key) ?? key);
    const halfSpread = zeroSpread ? 0 : spec.defaultSpreadPrice / 2;

    for (const bar of bars) {
      if (bar.ts < acc.lastEvaluatedAt) continue;
      const barTsIso = new Date(bar.ts * 1000).toISOString();

      // 1. Working orders for this symbol
      const nextOrders: PaperOrder[] = [];
      for (const ord of workingAcc.orders) {
        if (normalizeSymbolKey(ord.symbol) !== key || ord.orderPrice === null) {
          nextOrders.push(ord);
          continue;
        }
        if (ord.expiresAt && Date.parse(ord.expiresAt) <= bar.ts * 1000) {
          offlineEventsCount += 1;
          const expired: PaperOrder = { ...ord, status: 'expired', updatedAt: barTsIso };
          workingAcc = pushActivity(
            {
              ...workingAcc,
              orderHistory: [expired, ...workingAcc.orderHistory].slice(0, MAX_HISTORY_ITEMS)
            },
            'offline',
            `Expired while closed (${ord.tif}): ${ord.side.toUpperCase()} ${formatQty(ord.quantity)} ${ord.shortName}`,
            ord.symbol,
            undefined,
            barTsIso
          );
          continue;
        }

        let fillPrice: number | null = null;
        const barAskOpen = roundToTick(bar.open + halfSpread, ord.symbol);
        const barBidOpen = roundToTick(Math.max(spec.tickSize, bar.open - halfSpread), ord.symbol);
        const barAskLow = roundToTick(bar.low + halfSpread, ord.symbol);
        const barAskHigh = roundToTick(bar.high + halfSpread, ord.symbol);
        const barBidLow = roundToTick(Math.max(spec.tickSize, bar.low - halfSpread), ord.symbol);
        const barBidHigh = roundToTick(Math.max(spec.tickSize, bar.high - halfSpread), ord.symbol);

        if (ord.type === 'limit') {
          if (ord.side === 'buy' && barAskLow <= ord.orderPrice) {
            fillPrice = barAskOpen <= ord.orderPrice ? barAskOpen : ord.orderPrice;
          } else if (ord.side === 'sell' && barBidHigh >= ord.orderPrice) {
            fillPrice = barBidOpen >= ord.orderPrice ? barBidOpen : ord.orderPrice;
          }
        } else if (ord.type === 'stop') {
          if (ord.side === 'buy' && barAskHigh >= ord.orderPrice) {
            fillPrice = barAskOpen >= ord.orderPrice ? barAskOpen : ord.orderPrice;
          } else if (ord.side === 'sell' && barBidLow <= ord.orderPrice) {
            fillPrice = barBidOpen <= ord.orderPrice ? barBidOpen : ord.orderPrice;
          }
        }

        if (fillPrice === null) {
          nextOrders.push(ord);
          continue;
        }

        offlineEventsCount += 1;
        const filled: PaperOrder = {
          ...ord,
          status: 'filled',
          fillPrice,
          filledAt: barTsIso,
          updatedAt: barTsIso,
          note: 'Filled while app closed (OHLC replay)'
        };
        const applied = applyExecutionToAccount(workingAcc, {
          symbol: ord.symbol,
          shortName: ord.shortName,
          side: ord.side,
          quantity: ord.quantity,
          fillPrice,
          takeProfit: ord.takeProfit,
          stopLoss: ord.stopLoss,
          ts: barTsIso,
          sourceLabel: `${ord.type === 'limit' ? 'Limit' : 'Stop'} filled while closed`
        });
        workingAcc = {
          ...applied.account,
          orderHistory: [filled, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS)
        };
      }
      workingAcc = { ...workingAcc, orders: nextOrders };

      // 2. Open position TP/SL on this bar
      const pos = workingAcc.positions.find((p) => normalizeSymbolKey(p.symbol) === key);
      if (pos && (pos.takeProfit !== null || pos.stopLoss !== null)) {
        const bidLow = roundToTick(Math.max(spec.tickSize, bar.low - halfSpread), pos.symbol);
        const bidHigh = roundToTick(Math.max(spec.tickSize, bar.high - halfSpread), pos.symbol);
        const bidOpen = roundToTick(Math.max(spec.tickSize, bar.open - halfSpread), pos.symbol);
        const askLow = roundToTick(bar.low + halfSpread, pos.symbol);
        const askHigh = roundToTick(bar.high + halfSpread, pos.symbol);
        const askOpen = roundToTick(bar.open + halfSpread, pos.symbol);

        const slHit =
          pos.stopLoss !== null &&
          (pos.side === 'long' ? bidLow <= pos.stopLoss : askHigh >= pos.stopLoss);
        const tpHit =
          pos.takeProfit !== null &&
          (pos.side === 'long' ? bidHigh >= pos.takeProfit : askLow <= pos.takeProfit);

        let chosen: 'tp' | 'sl' | null = null;
        if (slHit && tpHit && pos.stopLoss !== null && pos.takeProfit !== null) {
          // Conservative tie-breaker: closer to open wins, ties go to SL
          const openRef = pos.side === 'long' ? bidOpen : askOpen;
          const distSl = Math.abs(openRef - pos.stopLoss);
          const distTp = Math.abs(openRef - pos.takeProfit);
          chosen = distTp < distSl ? 'tp' : 'sl';
        } else if (slHit) {
          chosen = 'sl';
        } else if (tpHit) {
          chosen = 'tp';
        }

        if (chosen) {
          offlineEventsCount += 1;
          const closeSide: OrderSide = pos.side === 'long' ? 'sell' : 'buy';
          const level = chosen === 'tp' ? (pos.takeProfit as number) : (pos.stopLoss as number);
          const openRef = pos.side === 'long' ? bidOpen : askOpen;
          const exitPrice =
            chosen === 'sl'
              ? pos.side === 'long'
                ? Math.min(openRef, level)
                : Math.max(openRef, level)
              : pos.side === 'long'
                ? Math.max(openRef, level)
                : Math.min(openRef, level);

          const ord: PaperOrder = {
            id: makeWorkspaceId('ord'),
            symbol: pos.symbol,
            shortName: pos.shortName,
            side: closeSide,
            type: chosen === 'tp' ? 'limit' : 'stop',
            quantity: pos.quantity,
            orderPrice: level,
            fillPrice: exitPrice,
            takeProfit: null,
            stopLoss: null,
            tif: 'GTC',
            expiresAt: null,
            status: 'filled',
            note: `${chosen === 'tp' ? 'Take profit' : 'Stop loss'} while app closed (OHLC replay)`,
            placedAt: barTsIso,
            updatedAt: barTsIso,
            filledAt: barTsIso
          };
          const applied = applyExecutionToAccount(workingAcc, {
            symbol: pos.symbol,
            shortName: pos.shortName,
            side: closeSide,
            quantity: pos.quantity,
            fillPrice: exitPrice,
            takeProfit: null,
            stopLoss: null,
            ts: barTsIso,
            closeReason: chosen === 'tp' ? 'offline_tp' : 'offline_sl',
            sourceLabel:
              chosen === 'tp'
                ? 'Take profit filled while closed'
                : 'Stop loss filled while closed'
          });
          workingAcc = {
            ...applied.account,
            orderHistory: [ord, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS)
          };
        }
      }
    }
  }

  workingAcc = { ...workingAcc, lastEvaluatedAt: nowSec };
  const nextAccounts = state.accounts.map((a) => (a.id === workingAcc.id ? workingAcc : a));
  commit({ ...state, accounts: nextAccounts }, true);

  if (offlineEventsCount > 0) {
    emitToast({
      kind: 'info',
      title: `Reconciled ${offlineEventsCount} offline ${offlineEventsCount === 1 ? 'event' : 'events'}`,
      symbol: 'PAPER',
      shortName: 'Paper Ledger',
      detail: 'Historical OHLC bars triggered orders/brackets while the app was closed. Check Activity log.'
    });
  }
}

export function startPaperMonitor(): () => void {
  void initPaperStore().then(() => {
    void pollRequiredPaperSymbols();
  });
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    void pollRequiredPaperSymbols();
  }, POLL_INTERVAL_MS);

  return () => {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  };
}

// ── Analytics (Equity Curve + Drawdown + KPIs) ───────────────────────────────

export function computePaperAnalytics(acc: PaperAccount): PaperAnalytics {
  const trades = [...acc.tradeHistory].reverse(); // chronological oldest -> newest
  const startBal = acc.settings.startingBalance;

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netRealizedPnl = 0;
  let rSum = 0;
  let rCount = 0;
  let bestTradeUsd: number | null = null;
  let worstTradeUsd: number | null = null;
  let holdMinSum = 0;
  let holdMinCount = 0;

  let curWinStreak = 0;
  let curLossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;

  let runningEquity = startBal;
  let peakEquity = startBal;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;

  const symMap = new Map<
    string,
    { symbol: string; shortName: string; trades: number; wins: number; losses: number; netPnl: number; rSum: number; rCount: number }
  >();
  const sideMap: Record<PositionSide, { trades: number; wins: number; losses: number; netPnl: number }> = {
    long: { trades: 0, wins: 0, losses: 0, netPnl: 0 },
    short: { trades: 0, wins: 0, losses: 0, netPnl: 0 }
  };
  const reasonMap = new Map<string, { count: number; netPnl: number }>();

  const equitySeries: EquityPoint[] = [
    {
      index: 0,
      ts: acc.createdAt,
      label: 'Start',
      equity: startBal,
      drawdownPct: 0,
      drawdownUsd: 0
    }
  ];

  for (let idx = 0; idx < trades.length; idx++) {
    const t = trades[idx];
    const net = t.realizedPnl - (t.commission || 0);
    netRealizedPnl += net;
    runningEquity = Number((runningEquity + net).toFixed(2));

    const isWin = net > 0.005;
    const isLoss = net < -0.005;

    if (isWin) {
      wins += 1;
      grossProfit += net;
      curWinStreak += 1;
      curLossStreak = 0;
      if (curWinStreak > longestWinStreak) longestWinStreak = curWinStreak;
    } else if (isLoss) {
      losses += 1;
      grossLoss += Math.abs(net);
      curLossStreak += 1;
      curWinStreak = 0;
      if (curLossStreak > longestLossStreak) longestLossStreak = curLossStreak;
    } else {
      breakevens += 1;
      curWinStreak = 0;
      curLossStreak = 0;
    }

    if (typeof t.realizedR === 'number' && Number.isFinite(t.realizedR)) {
      rSum += t.realizedR;
      rCount += 1;
    }

    const openMs = Date.parse(t.openedAt);
    const closeMs = Date.parse(t.closedAt);
    if (Number.isFinite(openMs) && Number.isFinite(closeMs) && closeMs >= openMs) {
      holdMinSum += (closeMs - openMs) / 60_000;
      holdMinCount += 1;
    }

    if (bestTradeUsd === null || net > bestTradeUsd) bestTradeUsd = net;
    if (worstTradeUsd === null || net < worstTradeUsd) worstTradeUsd = net;

    if (runningEquity > peakEquity) peakEquity = runningEquity;
    const ddUsd = Math.max(0, peakEquity - runningEquity);
    const ddPct = peakEquity > 0 ? (ddUsd / peakEquity) * 100 : 0;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    // Symbol breakdown
    const symKey = normalizeSymbolKey(t.symbol);
    const symCur = symMap.get(symKey) ?? {
      symbol: t.symbol,
      shortName: t.shortName,
      trades: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
      rSum: 0,
      rCount: 0
    };
    symCur.trades += 1;
    if (isWin) symCur.wins += 1;
    if (isLoss) symCur.losses += 1;
    symCur.netPnl += net;
    if (typeof t.realizedR === 'number' && Number.isFinite(t.realizedR)) {
      symCur.rSum += t.realizedR;
      symCur.rCount += 1;
    }
    symMap.set(symKey, symCur);

    // Side breakdown
    const sd = sideMap[t.side];
    sd.trades += 1;
    if (isWin) sd.wins += 1;
    if (isLoss) sd.losses += 1;
    sd.netPnl += net;

    // Exit reason breakdown
    const rLabel =
      t.closeReason === 'tp' || t.closeReason === 'offline_tp'
        ? 'Take Profit'
        : t.closeReason === 'sl' || t.closeReason === 'offline_sl'
          ? 'Stop Loss'
          : t.closeReason === 'partial'
            ? 'Partial Close'
            : t.closeReason === 'reverse'
              ? 'Reverse'
              : 'Manual Close';
    const rCur = reasonMap.get(rLabel) ?? { count: 0, netPnl: 0 };
    rCur.count += 1;
    rCur.netPnl += net;
    reasonMap.set(rLabel, rCur);

    equitySeries.push({
      index: idx + 1,
      ts: t.closedAt,
      label: `#${idx + 1} ${t.shortName}`,
      equity: runningEquity,
      drawdownPct: Number(ddPct.toFixed(2)),
      drawdownUsd: Number(ddUsd.toFixed(2)),
      tradePnl: Number(net.toFixed(2)),
      symbol: t.shortName
    });
  }

  const decided = wins + losses;
  const totalTrades = trades.length;
  const avgWinVal = wins > 0 ? grossProfit / wins : null;
  const avgLossVal = losses > 0 ? grossLoss / losses : null;
  const currentDdPct =
    peakEquity > 0 ? Number(((Math.max(0, peakEquity - runningEquity) / peakEquity) * 100).toFixed(2)) : 0;

  const bySymbol = Array.from(symMap.values())
    .map((s) => {
      const dec = s.wins + s.losses;
      return {
        symbol: s.symbol,
        shortName: s.shortName,
        trades: s.trades,
        wins: s.wins,
        losses: s.losses,
        winRatePct: dec > 0 ? Number(((s.wins / dec) * 100).toFixed(1)) : null,
        netPnl: Number(s.netPnl.toFixed(2)),
        totalR: s.rCount > 0 ? Number(s.rSum.toFixed(2)) : null
      };
    })
    .sort((a, b) => b.netPnl - a.netPnl);

  const bySide = (['long', 'short'] as PositionSide[]).map((s) => {
    const d = sideMap[s];
    const dec = d.wins + d.losses;
    return {
      side: s,
      trades: d.trades,
      wins: d.wins,
      winRatePct: dec > 0 ? Number(((d.wins / dec) * 100).toFixed(1)) : null,
      netPnl: Number(d.netPnl.toFixed(2))
    };
  });

  const byCloseReason = Array.from(reasonMap.entries())
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      netPnl: Number(v.netPnl.toFixed(2))
    }))
    .sort((a, b) => b.count - a.count);

  return {
    netRealizedPnl: Number(netRealizedPnl.toFixed(2)),
    returnPct: startBal > 0 ? Number(((netRealizedPnl / startBal) * 100).toFixed(2)) : 0,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    totalTrades,
    wins,
    losses,
    breakevens,
    winRatePct: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : null,
    profitFactor:
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? Infinity : null,
    payoffRatio:
      avgWinVal !== null && avgLossVal !== null && avgLossVal > 0
        ? Number((avgWinVal / avgLossVal).toFixed(2))
        : null,
    avgWin: avgWinVal !== null ? Number(avgWinVal.toFixed(2)) : null,
    avgLoss: avgLossVal !== null ? Number((-avgLossVal).toFixed(2)) : null,
    expectancyUsd: totalTrades > 0 ? Number((netRealizedPnl / totalTrades).toFixed(2)) : null,
    expectancyR: rCount > 0 ? Number((rSum / rCount).toFixed(2)) : null,
    totalR: rCount > 0 ? Number(rSum.toFixed(2)) : null,
    maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    currentDrawdownPct: currentDdPct,
    bestTradeUsd: bestTradeUsd !== null ? Number(bestTradeUsd.toFixed(2)) : null,
    worstTradeUsd: worstTradeUsd !== null ? Number(worstTradeUsd.toFixed(2)) : null,
    avgHoldMinutes: holdMinCount > 0 ? Number((holdMinSum / holdMinCount).toFixed(1)) : null,
    longestWinStreak,
    longestLossStreak,
    equitySeries,
    bySymbol,
    bySide,
    byCloseReason
  };
}

// ── CSV Export ───────────────────────────────────────────────────────────────

function csvEscape(val: unknown): string {
  const s = val == null ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportPaperTabToCsv(acc: PaperAccount, tab: PaperBottomTab): void {
  let headers: string[] = [];
  let rows: unknown[][] = [];

  if (tab === 'positions') {
    headers = ['Symbol', 'Side', 'Quantity', 'Avg Fill Price', 'Take Profit', 'Stop Loss', 'Opened At'];
    rows = acc.positions.map((p) => [
      p.symbol,
      p.side,
      p.quantity,
      p.avgFillPrice,
      p.takeProfit ?? '',
      p.stopLoss ?? '',
      p.openedAt
    ]);
  } else if (tab === 'orders') {
    headers = ['Symbol', 'Side', 'Type', 'Quantity', 'Order Price', 'TP', 'SL', 'TIF', 'Placed At'];
    rows = acc.orders.map((o) => [
      o.symbol,
      o.side,
      o.type,
      o.quantity,
      o.orderPrice ?? '',
      o.takeProfit ?? '',
      o.stopLoss ?? '',
      o.tif,
      o.placedAt
    ]);
  } else if (tab === 'order_history') {
    headers = ['Symbol', 'Side', 'Type', 'Qty', 'Order Price', 'Fill Price', 'Status', 'Placed At', 'Filled At'];
    rows = acc.orderHistory.map((o) => [
      o.symbol,
      o.side,
      o.type,
      o.quantity,
      o.orderPrice ?? '',
      o.fillPrice ?? '',
      o.status,
      o.placedAt,
      o.filledAt ?? ''
    ]);
  } else if (tab === 'balance_history') {
    headers = ['Timestamp', 'Kind', 'Symbol', 'Delta USD', 'Balance After USD', 'Description'];
    rows = acc.balanceHistory.map((b) => [
      b.ts,
      b.kind,
      b.symbol ?? '',
      b.delta,
      b.balanceAfter,
      b.description
    ]);
  } else if (tab === 'activity_log') {
    headers = ['Timestamp', 'Category', 'Symbol', 'Message'];
    rows = acc.activityLog.map((a) => [a.ts, a.category, a.symbol ?? '', a.message]);
  } else {
    headers = [
      'Symbol',
      'Side',
      'Qty',
      'Entry Price',
      'Exit Price',
      'Realized PnL USD',
      'Realized PnL %',
      'Realized R',
      'Reason',
      'Opened At',
      'Closed At'
    ];
    rows = acc.tradeHistory.map((t) => [
      t.symbol,
      t.side,
      t.quantity,
      t.entryPrice,
      t.exitPrice,
      t.realizedPnl,
      t.realizedPnlPct,
      t.realizedR ?? '',
      t.closeReason,
      t.openedAt,
      t.closedAt
    ]);
  }

  const csv = [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join(
    '\n'
  );
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `paper-ledger-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Strategy Forward-Runner Account Helpers ──────────────────────────────────

export function getPaperAccountById(accountId: string): PaperAccount | null {
  return state.accounts.find((a) => a.id === accountId) ?? null;
}

export function getPaperLiveQuotesSnapshot(): Record<string, PaperLiveQuote> {
  return { ...liveQuotesSnapshot };
}

/**
 * Ensures Paper Ledger is connected and returns (or creates) a dedicated isolated
 * SIM sub-account for a strategy runner without replacing the user's manual account.
 */
export function ensureDedicatedStrategyAccount(
  accountName: string,
  startingBalance = 10_000,
  leverage = 100
): PaperAccount {
  const existing = state.accounts.find((a) => a.name === accountName);
  if (existing) {
    if (!state.connected) {
      commit({ ...state, connected: true }, true);
      void pollRequiredPaperSymbols();
    }
    return existing;
  }

  const created = createPaperAccountRecord(accountName, startingBalance, leverage);
  const nextAccounts = [...state.accounts, created];
  commit(
    {
      ...state,
      connected: true,
      accounts: nextAccounts
    },
    true
  );
  void pollRequiredPaperSymbols();
  return created;
}

export function logStrategyActivityOnAccount(
  accountId: string,
  symbol: string,
  message: string
): void {
  const exists = state.accounts.some((a) => a.id === accountId);
  if (!exists) return;
  const nextAccounts = state.accounts.map((a) =>
    a.id === accountId ? pushActivity(a, 'order', message, symbol) : a
  );
  commit({ ...state, accounts: nextAccounts }, false);
}

export function executeStrategyOrderOnAccount(
  accountId: string,
  params: {
    symbol: string;
    shortName: string;
    side: OrderSide;
    quantity: number;
    fillPrice: number;
    takeProfit: number | null;
    stopLoss: number | null;
    strategyName: string;
  }
): { ok: boolean; error?: string } {
  const target = state.accounts.find((a) => a.id === accountId);
  if (!target) return { ok: false, error: 'Target Paper account not found.' };
  const qty = Number(params.quantity);
  const px = roundToTick(params.fillPrice, params.symbol);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0) {
    return { ok: false, error: 'Invalid strategy order quantity or price.' };
  }

  const tp =
    typeof params.takeProfit === 'number' && Number.isFinite(params.takeProfit) && params.takeProfit > 0
      ? roundToTick(params.takeProfit, params.symbol)
      : null;
  const sl =
    typeof params.stopLoss === 'number' && Number.isFinite(params.stopLoss) && params.stopLoss > 0
      ? roundToTick(params.stopLoss, params.symbol)
      : null;

  const nowIso = new Date().toISOString();
  const filledOrder: PaperOrder = {
    id: makeWorkspaceId('ord'),
    symbol: params.symbol,
    shortName: params.shortName,
    side: params.side,
    type: 'market',
    quantity: qty,
    orderPrice: null,
    fillPrice: px,
    takeProfit: tp,
    stopLoss: sl,
    tif: 'GTC',
    expiresAt: null,
    status: 'filled',
    note: `[BOT: ${params.strategyName}]`,
    placedAt: nowIso,
    updatedAt: nowIso,
    filledAt: nowIso
  };

  const nextAccounts = state.accounts.map((cur) => {
    if (cur.id !== accountId) return cur;
    const applied = applyExecutionToAccount(cur, {
      symbol: params.symbol,
      shortName: params.shortName,
      side: params.side,
      orderType: 'market',
      quantity: qty,
      fillPrice: px,
      takeProfit: tp,
      stopLoss: sl,
      ts: nowIso,
      sourceLabel: `[BOT: ${params.strategyName}] Market entry`
    });
    return {
      ...applied.account,
      orderHistory: [filledOrder, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS),
      lastEvaluatedAt: Math.floor(Date.now() / 1000)
    };
  });

  commit({ ...state, connected: true, accounts: nextAccounts }, true);
  void pollRequiredPaperSymbols();
  playAlertChime();
  emitToast({
    kind: 'executed',
    title: `[BOT] ${params.strategyName} filled on`,
    symbol: params.symbol,
    shortName: params.shortName,
    side: params.side,
    quantity: qty,
    price: px,
    detail: `${target.name}${sl ? ` · SL ${formatPaperPrice(sl, params.symbol)}` : ''}${tp ? ` · TP ${formatPaperPrice(tp, params.symbol)}` : ''}`
  });
  return { ok: true };
}

export function closeStrategyPositionOnAccount(
  accountId: string,
  symbol: string,
  exitPrice: number,
  strategyName: string
): { ok: boolean } {
  const target = state.accounts.find((a) => a.id === accountId);
  if (!target) return { ok: false };
  const symKey = normalizeSymbolKey(symbol);
  const pos = target.positions.find((p) => normalizeSymbolKey(p.symbol) === symKey);
  if (!pos) return { ok: false };

  const closeSide: OrderSide = pos.side === 'long' ? 'sell' : 'buy';
  const fillPx = roundToTick(exitPrice > 0 ? exitPrice : pos.lastKnownPrice, pos.symbol);
  const nowIso = new Date().toISOString();

  const closeOrder: PaperOrder = {
    id: makeWorkspaceId('ord'),
    symbol: pos.symbol,
    shortName: pos.shortName,
    side: closeSide,
    type: 'market',
    quantity: pos.quantity,
    orderPrice: null,
    fillPrice: fillPx,
    takeProfit: null,
    stopLoss: null,
    tif: 'GTC',
    expiresAt: null,
    status: 'filled',
    note: `[BOT: ${strategyName}] Exit signal`,
    placedAt: nowIso,
    updatedAt: nowIso,
    filledAt: nowIso
  };

  const nextAccounts = state.accounts.map((cur) => {
    if (cur.id !== accountId) return cur;
    const applied = applyExecutionToAccount(cur, {
      symbol: pos.symbol,
      shortName: pos.shortName,
      side: closeSide,
      quantity: pos.quantity,
      fillPrice: fillPx,
      takeProfit: null,
      stopLoss: null,
      ts: nowIso,
      closeReason: 'manual',
      sourceLabel: `[BOT: ${strategyName}] Signal exit`
    });
    return {
      ...applied.account,
      orderHistory: [closeOrder, ...applied.account.orderHistory].slice(0, MAX_HISTORY_ITEMS),
      lastEvaluatedAt: Math.floor(Date.now() / 1000)
    };
  });

  commit({ ...state, accounts: nextAccounts }, true);
  playAlertChime();
  emitToast({
    kind: 'executed',
    title: `[BOT] ${strategyName} closed on`,
    symbol: pos.symbol,
    shortName: pos.shortName,
    side: closeSide,
    quantity: pos.quantity,
    price: fillPx,
    detail: target.name
  });
  return { ok: true };
}
