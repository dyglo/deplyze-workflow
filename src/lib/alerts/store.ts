import type { ScreenerRowData } from '../screener/types';
import {
  fetchMarketQuotes,
  formatQuotePrice,
  loadWatchlistState,
  type MarketQuote,
  type WatchlistGroup,
  type WatchlistItem
} from '../watchlist/store';
import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  playAlertChime,
  saveWorkspaceJson,
  sendDesktopNotification
} from '../workspace/storage';

export type AlertKind = 'price' | 'news';
export type AlertScope = 'symbol' | 'watchlist';
export type AlertLogic = 'and' | 'or';
export type WatchlistTriggerMode = 'once_per_symbol' | 'every_per_symbol' | 'once_first';

export type AlertOperator =
  | 'crossing'
  | 'crossing_up'
  | 'crossing_down'
  | 'greater_than'
  | 'less_than';

export type AlertConditionMetric =
  | 'price'
  | 'tech_rating'
  | 'change_pct'
  | 'rsi14'
  | 'range_pos';

export type AlertConditionOperator = AlertOperator | 'abs_gte' | 'is_rating';

export type TechRatingTarget =
  | 'strong_buy'
  | 'buy_or_strong'
  | 'neutral'
  | 'sell_or_strong'
  | 'strong_sell';

export interface AlertCondition {
  id: string;
  /** Optional cross-symbol override for single-symbol multi-condition alerts (e.g. TVC:DXY). */
  symbol?: string;
  shortName?: string;
  metric: AlertConditionMetric;
  operator: AlertConditionOperator;
  /** Numeric threshold for price, change_pct, rsi14, range_pos */
  value?: number;
  /** Rating target when metric === 'tech_rating' */
  ratingTarget?: TechRatingTarget;
}

export type AlertTrigger = 'once' | 'every';
export type AlertStatus = 'active' | 'paused' | 'triggered' | 'expired';
export type NotificationSchedule = '24/7' | 'weekdays' | 'sessions';

export interface AlertNotificationPrefs {
  notifyDesktop: boolean;
  showToast: boolean;
  playSound: boolean;
  webhookEnabled: boolean;
  webhookUrl: string;
  schedule: NotificationSchedule;
}

export interface TradingAlert {
  id: string;
  kind: AlertKind;
  /** 'symbol' (default, legacy compatible) or 'watchlist' (1 rule across a Watchlist Group) */
  scope?: AlertScope;
  /** Target symbol (or watchlist group id when scope === 'watchlist') */
  symbol: string;
  /** Display ticker (or watchlist group name when scope === 'watchlist') */
  shortName: string;
  /** Legacy single-condition price fields (still mirrored for 1-condition price alerts) */
  operator?: AlertOperator;
  targetPrice?: number;
  lastSeenPrice?: number;
  /** Multi-condition & watchlist-wide rule fields */
  watchlistGroupId?: string;
  watchlistGroupName?: string;
  watchlistTriggerMode?: WatchlistTriggerMode;
  logic?: AlertLogic;
  conditions?: AlertCondition[];
  /** Per-symbol last-fired ISO timestamps for watchlist-wide rules */
  triggeredSymbols?: Record<string, string>;
  // Calendar News alert fields
  eventId?: string;
  eventTitle?: string;
  eventCountry?: string;
  eventTs?: number; // Unix seconds UTC
  leadMinutes?: number; // default 15 min before release
  trigger: AlertTrigger;
  expiresAt: string | null; // ISO string or null (open-ended)
  message: string;
  status: AlertStatus;
  notifications: AlertNotificationPrefs;
  createdAt: string;
  lastTriggeredAt?: string;
}

export interface AlertLogEntry {
  id: string;
  alertId: string;
  kind: AlertKind;
  symbol: string;
  shortName: string;
  title: string;
  message: string;
  detail?: string;
  watchlistGroupName?: string;
  missedWhileClosed?: boolean;
  triggeredPrice?: number;
  triggeredAt: string;
}

export interface AlertsState {
  alerts: TradingAlert[];
  log: AlertLogEntry[];
  lastEvaluatedAt?: string;
}

export interface InAppAlertToast {
  id: string;
  title: string;
  message: string;
  symbol: string;
  fullSymbol?: string;
  missedWhileClosed?: boolean;
  createdAt: string;
}

export interface AlertLiveProgress {
  met: number;
  total: number;
  matchedCount?: number;
  memberCount?: number;
}

export const OPERATOR_LABELS: Record<AlertOperator, string> = {
  crossing: 'Crossing',
  crossing_up: 'Crossing Up',
  crossing_down: 'Crossing Down',
  greater_than: 'Greater Than',
  less_than: 'Less Than'
};

export const CONDITION_OPERATOR_LABELS: Record<AlertConditionOperator, string> = {
  ...OPERATOR_LABELS,
  abs_gte: 'Abs Move ≥',
  is_rating: 'Is'
};

export const METRIC_LABELS: Record<AlertConditionMetric, string> = {
  price: 'Price',
  tech_rating: 'Tech Rating',
  change_pct: 'Change % (1D)',
  rsi14: 'RSI (14)',
  range_pos: 'Day Range Pos'
};

export const RATING_TARGET_LABELS: Record<TechRatingTarget, string> = {
  strong_buy: 'Strong buy',
  buy_or_strong: 'Buy or stronger',
  neutral: 'Neutral',
  sell_or_strong: 'Sell or weaker',
  strong_sell: 'Strong sell'
};

export const WATCHLIST_TRIGGER_LABELS: Record<WatchlistTriggerMode, string> = {
  once_per_symbol: 'Once per symbol',
  every_per_symbol: 'Every time (per symbol)',
  once_first: 'Once only (first match)'
};

export const DEFAULT_NOTIFICATIONS: AlertNotificationPrefs = {
  notifyDesktop: true,
  showToast: true,
  playSound: true,
  webhookEnabled: false,
  webhookUrl: '',
  schedule: '24/7'
};

const STORAGE_KEY = 'alerts';
const LAST_EVAL_LS_KEY = 'deplyzeworkflow-alerts-last-eval';
const REPEAT_COOLDOWN_MS = 60_000;
const TECHNICAL_COOLDOWN_MS = 15 * 60_000;
const LIVE_FEED_FRESH_MS = 20_000;
const MIN_OFFLINE_CATCHUP_MS = 60_000;
const MAX_OFFLINE_CATCHUP_MS = 14 * 86_400_000;
const PERSIST_EVAL_INTERVAL_MS = 60_000;

interface HistoricalBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

let state: AlertsState = { alerts: [], log: [] };
let hydrated = false;
let hydrationPromise: Promise<AlertsState> | null = null;
const stateListeners = new Set<(s: AlertsState) => void>();
const toastListeners = new Set<(toast: InAppAlertToast) => void>();
const progressListeners = new Set<(p: Record<string, AlertLiveProgress>) => void>();

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let catchUpDone = false;
let lastPersistedEvalMs = 0;

// In-memory live caches (zero disk spam on 1s ticks)
const lastSeenPrices = new Map<string, number>(); // key -> price (legacy id or `${alertId}:${condId}:${bare}`)
const livePriceByKey = new Map<string, number>(); // upper symbol / bare -> latest price
const lastLiveTickAt = new Map<string, number>(); // upper symbol / bare -> timestamp ms
const screenerByKey = new Map<string, ScreenerRowData>(); // upper symbol / bare -> screener row
const prevRuleMetState = new Map<string, boolean>(); // `${alertId}:${bare}` -> whether rule was true on last pass
let liveProgress: Record<string, AlertLiveProgress> = {};

function stripExchange(sym: string): string {
  const upper = (sym || '').trim().toUpperCase();
  const idx = upper.indexOf(':');
  return idx >= 0 ? upper.slice(idx + 1) : upper;
}

function recordEvalTimestamp(nowMs = Date.now(), forcePersist = false): void {
  const iso = new Date(nowMs).toISOString();
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LAST_EVAL_LS_KEY, iso);
    } catch {
      // ignore storage quota errors
    }
  }
  if (forcePersist || nowMs - lastPersistedEvalMs >= PERSIST_EVAL_INTERVAL_MS) {
    lastPersistedEvalMs = nowMs;
    state = { ...state, lastEvaluatedAt: iso };
    void saveWorkspaceJson(STORAGE_KEY, state);
  }
}

function readOfflineBaselineMs(): number | null {
  const candidates: number[] = [];
  if (state.lastEvaluatedAt) {
    const ms = Date.parse(state.lastEvaluatedAt);
    if (Number.isFinite(ms)) candidates.push(ms);
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LAST_EVAL_LS_KEY);
      if (raw) {
        const ms = Date.parse(raw);
        if (Number.isFinite(ms)) candidates.push(ms);
      }
    } catch {
      // ignore
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

export function isWatchlistAlert(alert: TradingAlert): boolean {
  return alert.kind === 'price' && alert.scope === 'watchlist';
}

export function getAlertConditions(alert: TradingAlert): AlertCondition[] {
  if (alert.kind === 'news') return [];
  if (Array.isArray(alert.conditions) && alert.conditions.length > 0) {
    return alert.conditions;
  }
  if (typeof alert.targetPrice === 'number' && Number.isFinite(alert.targetPrice)) {
    return [
      {
        id: 'c1',
        symbol: alert.symbol,
        shortName: alert.shortName,
        metric: 'price',
        operator: alert.operator ?? 'crossing',
        value: alert.targetPrice
      }
    ];
  }
  return [];
}

export function isMultiConditionAlert(alert: TradingAlert): boolean {
  return alert.kind === 'price' && getAlertConditions(alert).length > 1;
}

export function formatConditionSummary(
  cond: AlertCondition,
  fallbackShortName: string,
  includeSymbol = true
): string {
  const ticker = (cond.shortName || fallbackShortName || '').trim();
  const prefix = includeSymbol && ticker ? `${ticker} ` : '';

  if (cond.metric === 'price') {
    const op = OPERATOR_LABELS[(cond.operator as AlertOperator) ?? 'crossing'] ?? 'Crossing';
    const valStr =
      typeof cond.value === 'number' && Number.isFinite(cond.value)
        ? formatQuotePrice(cond.value, ticker)
        : '—';
    return `${prefix}${op} ${valStr}`;
  }

  if (cond.metric === 'tech_rating') {
    const target = RATING_TARGET_LABELS[cond.ratingTarget ?? 'strong_buy'] ?? 'Strong buy';
    return `${prefix}Tech Rating: ${target}`;
  }

  if (cond.metric === 'change_pct') {
    const num = typeof cond.value === 'number' && Number.isFinite(cond.value) ? cond.value : 0;
    if (cond.operator === 'abs_gte') return `${prefix}|Chg 1D| ≥ ${Math.abs(num)}%`;
    if (cond.operator === 'less_than') return `${prefix}Chg 1D < ${num}%`;
    return `${prefix}Chg 1D > ${num}%`;
  }

  if (cond.metric === 'rsi14') {
    const num = typeof cond.value === 'number' && Number.isFinite(cond.value) ? cond.value : 50;
    return `${prefix}RSI(14) ${cond.operator === 'less_than' ? '<' : '>'} ${num}`;
  }

  // range_pos
  const num = typeof cond.value === 'number' && Number.isFinite(cond.value) ? cond.value : 85;
  return `${prefix}Day Pos ${cond.operator === 'less_than' ? '≤' : '≥'} ${num}%`;
}

export function formatAlertAutoMessage(params: {
  scope: AlertScope;
  shortName: string;
  watchlistGroupName?: string;
  logic: AlertLogic;
  conditions: AlertCondition[];
}): string {
  const { scope, shortName, watchlistGroupName, logic, conditions } = params;
  if (conditions.length === 0) return shortName;

  const joiner = logic === 'or' ? ' OR ' : ' AND ';
  if (scope === 'watchlist') {
    const groupLabel = watchlistGroupName || shortName || 'Watchlist';
    const parts = conditions.map((c) => formatConditionSummary(c, '', false));
    return `${groupLabel}: ${parts.join(joiner)}`;
  }

  const parts = conditions.map((c, idx) => {
    const condShort = c.shortName || shortName;
    const showSym =
      idx === 0 || condShort.toUpperCase() !== shortName.toUpperCase() || c.metric === 'price';
    return formatConditionSummary(c, shortName, showSym);
  });
  return parts.join(joiner);
}

export function formatAlertDefaultMessage(
  shortName: string,
  operator: AlertOperator,
  targetPrice: number
): string {
  return `${shortName} ${OPERATOR_LABELS[operator]} ${formatQuotePrice(targetPrice, shortName)}`;
}

function normalizeLoadedAlert(raw: TradingAlert): TradingAlert {
  const scope: AlertScope = raw.scope === 'watchlist' ? 'watchlist' : 'symbol';
  return {
    ...raw,
    scope,
    logic: raw.logic === 'or' ? 'or' : 'and',
    watchlistTriggerMode: raw.watchlistTriggerMode ?? 'once_per_symbol',
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...(raw.notifications ?? {})
    }
  };
}

function emitState() {
  for (const fn of stateListeners) fn(state);
}

function emitToast(toast: InAppAlertToast) {
  for (const fn of toastListeners) fn(toast);
}

function emitProgress() {
  for (const fn of progressListeners) fn(liveProgress);
}

function updateLiveProgress(alertId: string, next: AlertLiveProgress | null) {
  const prev = liveProgress[alertId];
  if (next === null) {
    if (prev !== undefined) {
      const copy = { ...liveProgress };
      delete copy[alertId];
      liveProgress = copy;
      emitProgress();
    }
    return;
  }
  if (
    prev &&
    prev.met === next.met &&
    prev.total === next.total &&
    prev.matchedCount === next.matchedCount &&
    prev.memberCount === next.memberCount
  ) {
    return;
  }
  liveProgress = { ...liveProgress, [alertId]: next };
  emitProgress();
}

export async function initAlertsStore(): Promise<AlertsState> {
  if (hydrated) return state;
  if (!hydrationPromise) {
    hydrationPromise = loadWorkspaceJson<AlertsState>(STORAGE_KEY, { alerts: [], log: [] })
      .then((loaded) => {
        const diskAlerts = Array.isArray(loaded?.alerts)
          ? loaded.alerts.map(normalizeLoadedAlert)
          : [];
        const diskLog = Array.isArray(loaded?.log) ? loaded.log : [];

        const memAlertIds = new Set(state.alerts.map((a) => a.id));
        const mergedAlerts = [
          ...state.alerts,
          ...diskAlerts.filter((a) => !memAlertIds.has(a.id))
        ];

        const memLogIds = new Set(state.log.map((l) => l.id));
        const mergedLog = [
          ...state.log,
          ...diskLog.filter((l) => !memLogIds.has(l.id))
        ].slice(0, 150);

        for (const a of mergedAlerts) {
          if (
            typeof a.lastSeenPrice === 'number' &&
            Number.isFinite(a.lastSeenPrice) &&
            !lastSeenPrices.has(a.id)
          ) {
            lastSeenPrices.set(a.id, a.lastSeenPrice);
          }
        }

        state = {
          alerts: mergedAlerts,
          log: mergedLog,
          lastEvaluatedAt: loaded?.lastEvaluatedAt ?? state.lastEvaluatedAt
        };
        hydrated = true;
        emitState();
        return state;
      })
      .catch(() => {
        hydrated = true;
        return state;
      });
  }
  return hydrationPromise;
}

export function getAlertsSnapshot(): AlertsState {
  return state;
}

export function subscribeAlerts(fn: (s: AlertsState) => void): () => void {
  stateListeners.add(fn);
  fn(state);
  if (!hydrated) void initAlertsStore();
  return () => {
    stateListeners.delete(fn);
  };
}

export function subscribeAlertToasts(fn: (t: InAppAlertToast) => void): () => void {
  toastListeners.add(fn);
  return () => {
    toastListeners.delete(fn);
  };
}

export function subscribeAlertProgress(
  fn: (p: Record<string, AlertLiveProgress>) => void
): () => void {
  progressListeners.add(fn);
  fn(liveProgress);
  return () => {
    progressListeners.delete(fn);
  };
}

function commitState(next: AlertsState) {
  state = {
    alerts: next.alerts,
    log: next.log.slice(0, 150),
    lastEvaluatedAt: next.lastEvaluatedAt ?? state.lastEvaluatedAt
  };
  emitState();
  void saveWorkspaceJson(STORAGE_KEY, state);
}

function clearRuntimeCachesForAlert(alertId: string) {
  lastSeenPrices.delete(alertId);
  for (const key of Array.from(lastSeenPrices.keys())) {
    if (key.startsWith(`${alertId}:`)) lastSeenPrices.delete(key);
  }
  for (const key of Array.from(prevRuleMetState.keys())) {
    if (key.startsWith(`${alertId}:`)) prevRuleMetState.delete(key);
  }
  updateLiveProgress(alertId, null);
}

export function upsertAlert(alert: TradingAlert): void {
  const normalized = normalizeLoadedAlert(alert);
  clearRuntimeCachesForAlert(normalized.id);
  if (typeof normalized.lastSeenPrice === 'number' && Number.isFinite(normalized.lastSeenPrice)) {
    lastSeenPrices.set(normalized.id, normalized.lastSeenPrice);
  }

  const exists = state.alerts.some((a) => a.id === normalized.id);
  const alerts = exists
    ? state.alerts.map((a) => (a.id === normalized.id ? normalized : a))
    : [normalized, ...state.alerts];
  commitState({ ...state, alerts });

  // Trigger an immediate background poll if the new/edited alert uses watchlist or technical conditions
  if (normalized.status === 'active' && alertNeedsScreener(normalized)) {
    void pollBackgroundAlerts();
  }
}

export function deleteAlertById(id: string): void {
  clearRuntimeCachesForAlert(id);
  commitState({
    ...state,
    alerts: state.alerts.filter((a) => a.id !== id)
  });
}

export function togglePauseAlert(id: string): void {
  commitState({
    ...state,
    alerts: state.alerts.map((a) => {
      if (a.id !== id) return a;
      if (a.status === 'active') {
        updateLiveProgress(a.id, null);
        return { ...a, status: 'paused' };
      }
      clearRuntimeCachesForAlert(a.id);
      return {
        ...a,
        status: 'active',
        lastSeenPrice: undefined,
        triggeredSymbols: a.status === 'triggered' ? {} : a.triggeredSymbols,
        lastTriggeredAt: a.status === 'triggered' ? undefined : a.lastTriggeredAt
      };
    })
  });
  void pollBackgroundAlerts();
}

export function resetWatchlistAlertMatches(id: string): void {
  clearRuntimeCachesForAlert(id);
  commitState({
    ...state,
    alerts: state.alerts.map((a) =>
      a.id === id ? { ...a, triggeredSymbols: {}, status: 'active' } : a
    )
  });
  void pollBackgroundAlerts();
}

export function pauseAllAlerts(): void {
  for (const a of state.alerts) {
    if (a.status === 'active') updateLiveProgress(a.id, null);
  }
  commitState({
    ...state,
    alerts: state.alerts.map((a) => (a.status === 'active' ? { ...a, status: 'paused' } : a))
  });
}

export function resumeAllAlerts(): void {
  commitState({
    ...state,
    alerts: state.alerts.map((a) => {
      if (a.status !== 'paused') return a;
      clearRuntimeCachesForAlert(a.id);
      return { ...a, status: 'active', lastSeenPrice: undefined };
    })
  });
  void pollBackgroundAlerts();
}

export function clearAlertLog(): void {
  commitState({ ...state, log: [] });
}

export function countActiveAlertsForSymbol(symbol: string, shortName: string): number {
  const s1 = symbol.toUpperCase();
  const s2 = shortName.toUpperCase();
  const s2Bare = stripExchange(shortName);
  return state.alerts.filter((a) => {
    if (a.status !== 'active' || a.kind !== 'price' || isWatchlistAlert(a)) return false;
    if (
      a.symbol.toUpperCase() === s1 ||
      a.shortName.toUpperCase() === s2 ||
      stripExchange(a.symbol) === s2Bare
    ) {
      return true;
    }
    const conds = getAlertConditions(a);
    return conds.some((c) => {
      const cs = (c.symbol ?? '').toUpperCase();
      const csh = (c.shortName ?? '').toUpperCase();
      return cs === s1 || csh === s2 || (cs && stripExchange(cs) === s2Bare);
    });
  }).length;
}

export function hasNewsAlertForEvent(eventId: string): boolean {
  return state.alerts.some(
    (a) => a.kind === 'news' && a.eventId === eventId && a.status === 'active'
  );
}

export function toggleNewsAlertForEvent(params: {
  eventId: string;
  title: string;
  country: string;
  ts: number;
  leadMinutes?: number;
}): boolean {
  const existing = state.alerts.find((a) => a.kind === 'news' && a.eventId === params.eventId);
  if (existing) {
    if (existing.status === 'active') {
      deleteAlertById(existing.id);
      return false;
    }
    upsertAlert({
      ...existing,
      status: 'active',
      eventTs: params.ts,
      expiresAt: new Date((params.ts + 3600) * 1000).toISOString()
    });
    return true;
  }

  const lead = params.leadMinutes ?? 15;
  const nowIso = new Date().toISOString();
  const alert: TradingAlert = {
    id: makeWorkspaceId('alert'),
    kind: 'news',
    symbol: params.country,
    shortName: params.country,
    eventId: params.eventId,
    eventTitle: params.title,
    eventCountry: params.country,
    eventTs: params.ts,
    leadMinutes: lead,
    trigger: 'once',
    expiresAt: new Date((params.ts + 3600) * 1000).toISOString(),
    message: `${params.title} (${params.country}) releases in ${lead} min`,
    status: 'active',
    notifications: { ...DEFAULT_NOTIFICATIONS },
    createdAt: nowIso
  };
  upsertAlert(alert);
  return true;
}

function isWithinSchedule(schedule: NotificationSchedule, now: Date): boolean {
  if (schedule === '24/7') return true;
  const day = now.getDay();
  if (schedule === 'weekdays') return day >= 1 && day <= 5;
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 7 && hour < 22;
}

function isCrossingOperator(op: AlertConditionOperator): boolean {
  return op === 'crossing' || op === 'crossing_up' || op === 'crossing_down';
}

function matchesPriceCondition(
  operator: AlertOperator,
  target: number,
  current: number,
  previous: number | undefined
): boolean {
  switch (operator) {
    case 'greater_than':
      return current > target;
    case 'less_than':
      return current < target;
    case 'crossing_up':
      return typeof previous === 'number'
        ? previous < target && current >= target
        : current >= target;
    case 'crossing_down':
      return typeof previous === 'number'
        ? previous > target && current <= target
        : current <= target;
    case 'crossing':
    default:
      if (typeof previous !== 'number') return false;
      return (
        (previous < target && current >= target) ||
        (previous > target && current <= target)
      );
  }
}

function matchesRatingTarget(row: ScreenerRowData, target: TechRatingTarget): boolean {
  const r = row.rating;
  switch (target) {
    case 'strong_buy':
      return r === 'Strong buy';
    case 'buy_or_strong':
      return r === 'Strong buy' || r === 'Buy';
    case 'neutral':
      return r === 'Neutral';
    case 'sell_or_strong':
      return r === 'Sell' || r === 'Strong sell';
    case 'strong_sell':
      return r === 'Strong sell';
    default:
      return false;
  }
}

function getLatestPriceFor(symbol: string, shortName: string): number | undefined {
  const k1 = symbol.toUpperCase();
  const k2 = shortName.toUpperCase();
  const k3 = stripExchange(shortName || symbol);
  return (
    livePriceByKey.get(k1) ??
    livePriceByKey.get(k2) ??
    livePriceByKey.get(k3) ??
    screenerByKey.get(k1)?.price ??
    screenerByKey.get(k2)?.price ??
    screenerByKey.get(k3)?.price
  );
}

function getScreenerRowFor(symbol: string, shortName: string): ScreenerRowData | undefined {
  const k1 = symbol.toUpperCase();
  const k2 = shortName.toUpperCase();
  const k3 = stripExchange(shortName || symbol);
  return screenerByKey.get(k1) ?? screenerByKey.get(k2) ?? screenerByKey.get(k3);
}

interface ConditionEvalOutcome {
  evaluated: boolean;
  met: boolean;
  isCrossing: boolean;
  snapshot: string;
  currentPrice?: number;
}

function evaluateSingleCondition(
  alertId: string,
  cond: AlertCondition,
  targetSymbol: string,
  targetShort: string,
  seedPriceFallback?: number
): ConditionEvalOutcome {
  const bare = stripExchange(targetShort || targetSymbol);
  const baseKey = `${alertId}:${cond.id}:${bare}`;

  if (cond.metric === 'price') {
    const target = cond.value;
    if (typeof target !== 'number' || !Number.isFinite(target)) {
      return { evaluated: false, met: false, isCrossing: false, snapshot: '' };
    }
    const op = (cond.operator as AlertOperator) ?? 'crossing';
    const current = getLatestPriceFor(targetSymbol, targetShort);
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      return { evaluated: false, met: false, isCrossing: isCrossingOperator(op), snapshot: '' };
    }

    const prevPrice = lastSeenPrices.has(baseKey)
      ? lastSeenPrices.get(baseKey)
      : lastSeenPrices.has(alertId) && cond.id === 'c1'
        ? lastSeenPrices.get(alertId)
        : seedPriceFallback;

    const crossing = isCrossingOperator(op);
    if (prevPrice === undefined && crossing) {
      lastSeenPrices.set(baseKey, current);
      if (cond.id === 'c1') lastSeenPrices.set(alertId, current);
      return {
        evaluated: true,
        met: false,
        isCrossing: true,
        snapshot: `${targetShort} ${formatQuotePrice(current, targetShort)}`,
        currentPrice: current
      };
    }

    const met = matchesPriceCondition(op, target, current, prevPrice);
    lastSeenPrices.set(baseKey, current);
    if (cond.id === 'c1') lastSeenPrices.set(alertId, current);
    return {
      evaluated: true,
      met,
      isCrossing: crossing,
      snapshot: `${targetShort} ${formatQuotePrice(current, targetShort)}`,
      currentPrice: current
    };
  }

  const row = getScreenerRowFor(targetSymbol, targetShort);
  if (!row) {
    return { evaluated: false, met: false, isCrossing: false, snapshot: '' };
  }

  if (cond.metric === 'tech_rating') {
    const target = cond.ratingTarget ?? 'strong_buy';
    const met = matchesRatingTarget(row, target);
    return {
      evaluated: true,
      met,
      isCrossing: false,
      snapshot: `Tech: ${row.rating}`,
      currentPrice: row.price
    };
  }

  if (cond.metric === 'change_pct') {
    const val = cond.value;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { evaluated: false, met: false, isCrossing: false, snapshot: '' };
    }
    const chg = row.changePercent;
    const met =
      cond.operator === 'abs_gte'
        ? Math.abs(chg) >= Math.abs(val)
        : cond.operator === 'less_than'
          ? chg < val
          : chg > val;
    const sign = chg > 0 ? '+' : '';
    return {
      evaluated: true,
      met,
      isCrossing: false,
      snapshot: `Chg ${sign}${chg.toFixed(2)}%`,
      currentPrice: row.price
    };
  }

  if (cond.metric === 'rsi14') {
    const val = cond.value;
    if (typeof val !== 'number' || !Number.isFinite(val) || row.rsi14 === null) {
      return { evaluated: false, met: false, isCrossing: false, snapshot: '' };
    }
    const met = cond.operator === 'less_than' ? row.rsi14 < val : row.rsi14 > val;
    return {
      evaluated: true,
      met,
      isCrossing: false,
      snapshot: `RSI ${row.rsi14.toFixed(1)}`,
      currentPrice: row.price
    };
  }

  // range_pos
  const val = cond.value;
  if (typeof val !== 'number' || !Number.isFinite(val) || row.rangePosPct === null) {
    return { evaluated: false, met: false, isCrossing: false, snapshot: '' };
  }
  const met = cond.operator === 'less_than' ? row.rangePosPct <= val : row.rangePosPct >= val;
  return {
    evaluated: true,
    met,
    isCrossing: false,
    snapshot: `Day Pos ${row.rangePosPct}%`,
    currentPrice: row.price
  };
}

function alertNeedsScreener(alert: TradingAlert): boolean {
  if (alert.kind !== 'price') return false;
  if (isWatchlistAlert(alert)) return true;
  const conds = getAlertConditions(alert);
  return conds.some((c) => c.metric !== 'price');
}

function alertCooldownMs(alert: TradingAlert): number {
  const conds = getAlertConditions(alert);
  const hasTechnical = conds.some((c) => c.metric === 'tech_rating' || c.metric === 'rsi14');
  return hasTechnical ? TECHNICAL_COOLDOWN_MS : REPEAT_COOLDOWN_MS;
}

interface NotificationDispatch {
  alert: TradingAlert;
  title: string;
  body: string;
  matchedSymbol: string;
  matchedFullSymbol: string;
  currentPrice?: number;
  detail?: string;
  missedWhileClosed?: boolean;
}

async function fireNotification(d: NotificationDispatch): Promise<void> {
  const now = new Date();
  const prefs = d.alert.notifications ?? DEFAULT_NOTIFICATIONS;
  if (!isWithinSchedule(prefs.schedule, now)) return;

  if (prefs.showToast) {
    emitToast({
      id: makeWorkspaceId('toast'),
      title: d.title,
      message: d.body,
      symbol: d.matchedSymbol,
      fullSymbol: d.matchedFullSymbol,
      missedWhileClosed: d.missedWhileClosed,
      createdAt: now.toISOString()
    });
  }

  if (prefs.playSound) {
    playAlertChime();
  }

  if (prefs.notifyDesktop) {
    void sendDesktopNotification(d.title, d.body);
  }

  if (prefs.webhookEnabled && prefs.webhookUrl.trim()) {
    const summaryText = `${d.title} — ${d.body}`;
    void fetch(`${getApiBaseUrl()}/api/alerts/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: prefs.webhookUrl.trim(),
        payload: {
          content: summaryText,
          text: summaryText,
          source: 'DeplyzeWorkflow',
          title: d.title,
          message: d.body,
          symbol: d.matchedFullSymbol,
          shortName: d.matchedSymbol,
          watchlistGroup: d.alert.watchlistGroupName ?? null,
          conditionSummary: d.detail ?? null,
          missedWhileClosed: Boolean(d.missedWhileClosed),
          price: d.currentPrice ?? null,
          targetPrice: d.alert.targetPrice ?? null,
          triggeredAt: now.toISOString()
        }
      })
    }).catch(() => {
      // non-fatal
    });
  }
}

function symbolAlertReferencesTicker(
  alert: TradingAlert,
  sFull: string,
  sShort: string,
  sBare: string
): boolean {
  const check = (sym: string, short: string) => {
    const aFull = (sym || '').toUpperCase();
    const aShort = (short || '').toUpperCase();
    return (
      aFull === sFull ||
      aShort === sShort ||
      stripExchange(aFull) === sBare ||
      stripExchange(aShort) === sBare
    );
  };
  if (check(alert.symbol, alert.shortName)) return true;
  for (const c of getAlertConditions(alert)) {
    if (c.symbol && check(c.symbol, c.shortName ?? c.symbol)) return true;
  }
  return false;
}

function evaluateSymbolAlertsPass(
  filterToTicker?: { sFull: string; sShort: string; sBare: string }
): void {
  if (state.alerts.length === 0) return;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let stateChanged = false;
  const nextLogs: AlertLogEntry[] = [];
  const toFire: NotificationDispatch[] = [];

  const nextAlerts = state.alerts.map((alert) => {
    if (alert.kind !== 'price' || alert.status !== 'active' || isWatchlistAlert(alert)) {
      return alert;
    }
    if (
      filterToTicker &&
      !symbolAlertReferencesTicker(
        alert,
        filterToTicker.sFull,
        filterToTicker.sShort,
        filterToTicker.sBare
      )
    ) {
      return alert;
    }

    if (alert.expiresAt && Date.parse(alert.expiresAt) <= nowMs) {
      stateChanged = true;
      clearRuntimeCachesForAlert(alert.id);
      return { ...alert, status: 'expired' as AlertStatus };
    }

    const conds = getAlertConditions(alert);
    if (conds.length === 0) return alert;

    const logic: AlertLogic = alert.logic === 'or' ? 'or' : 'and';
    const outcomes = conds.map((c, idx) => {
      const cSym = c.symbol || alert.symbol;
      const cShort = c.shortName || (c.symbol ? stripExchange(c.symbol) : alert.shortName);
      return {
        cond: c,
        sym: cSym,
        short: cShort,
        res: evaluateSingleCondition(
          alert.id,
          c,
          cSym,
          cShort,
          idx === 0 ? alert.lastSeenPrice : undefined
        )
      };
    });

    const metCount = outcomes.filter((o) => o.res.evaluated && o.res.met).length;
    if (conds.length > 1) {
      updateLiveProgress(alert.id, { met: metCount, total: conds.length });
    }

    const hasCrossingLeg = outcomes.some((o) => o.res.isCrossing);
    let ruleMetNow = false;
    if (logic === 'and') {
      ruleMetNow = outcomes.every((o) => o.res.evaluated && o.res.met);
    } else {
      ruleMetNow = outcomes.some((o) => o.res.evaluated && o.res.met);
    }

    const edgeKey = `${alert.id}:${stripExchange(alert.shortName || alert.symbol)}`;
    const wasMet = prevRuleMetState.get(edgeKey) ?? false;
    prevRuleMetState.set(edgeKey, ruleMetNow);

    // For multi-condition or non-crossing rules, fire on false -> true transition (or on a crossing leg)
    const isLegacySinglePrice = conds.length === 1 && conds[0].metric === 'price';
    const shouldCheckFire = isLegacySinglePrice
      ? ruleMetNow
      : hasCrossingLeg
        ? ruleMetNow
        : ruleMetNow && !wasMet;

    const cooldownOk =
      !alert.lastTriggeredAt || nowMs - Date.parse(alert.lastTriggeredAt) >= alertCooldownMs(alert);

    if (shouldCheckFire && cooldownOk) {
      stateChanged = true;
      const triggeredParts = outcomes
        .filter((o) => (logic === 'or' ? o.res.met : true))
        .map((o) => o.res.snapshot)
        .filter(Boolean);
      const detail = triggeredParts.join(' · ');
      const primaryPrice =
        getLatestPriceFor(alert.symbol, alert.shortName) ?? outcomes[0]?.res.currentPrice;

      const title =
        conds.length > 1
          ? `Multi-Condition Alert · ${alert.shortName}`
          : `Price Alert · ${alert.shortName}`;
      const body = alert.message || detail || `${alert.shortName} alert triggered`;

      toFire.push({
        alert,
        title,
        body: detail && body !== detail ? `${body} (${detail})` : body,
        matchedSymbol: alert.shortName,
        matchedFullSymbol: alert.symbol,
        currentPrice: primaryPrice,
        detail
      });

      nextLogs.push({
        id: makeWorkspaceId('log'),
        alertId: alert.id,
        kind: 'price',
        symbol: alert.symbol,
        shortName: alert.shortName,
        title:
          conds.length > 1
            ? `${alert.shortName} · ${conds.length} conditions (${logic.toUpperCase()})`
            : formatConditionSummary(conds[0], alert.shortName, true),
        message: alert.message || body,
        detail,
        triggeredPrice: primaryPrice,
        triggeredAt: nowIso
      });

      const nextStatus: AlertStatus = alert.trigger === 'once' ? 'triggered' : 'active';
      if (nextStatus === 'triggered') {
        updateLiveProgress(alert.id, null);
      }
      return {
        ...alert,
        lastSeenPrice: primaryPrice ?? alert.lastSeenPrice,
        lastTriggeredAt: nowIso,
        status: nextStatus
      };
    }

    return alert;
  });

  if (stateChanged) {
    commitState({
      alerts: nextAlerts,
      log: nextLogs.length > 0 ? [...nextLogs, ...state.log] : state.log
    });
  }

  for (const d of toFire) {
    void fireNotification(d);
  }
}

function evaluateWatchlistAlertsPass(groups: WatchlistGroup[]): void {
  const activeWatchlistAlerts = state.alerts.filter(
    (a) => a.status === 'active' && isWatchlistAlert(a)
  );
  if (activeWatchlistAlerts.length === 0) return;

  const groupMap = new Map<string, WatchlistGroup>();
  for (const g of groups) groupMap.set(g.id, g);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let stateChanged = false;
  const nextLogs: AlertLogEntry[] = [];
  const toFire: NotificationDispatch[] = [];

  const nextAlerts = state.alerts.map((alert) => {
    if (alert.status !== 'active' || !isWatchlistAlert(alert)) return alert;

    if (alert.expiresAt && Date.parse(alert.expiresAt) <= nowMs) {
      stateChanged = true;
      clearRuntimeCachesForAlert(alert.id);
      return { ...alert, status: 'expired' as AlertStatus };
    }

    const grp = alert.watchlistGroupId ? groupMap.get(alert.watchlistGroupId) : undefined;
    if (!grp) return alert;

    const members: WatchlistItem[] = [];
    for (const sec of grp.sections) {
      members.push(...sec.items);
    }
    const conds = getAlertConditions(alert);
    if (members.length === 0 || conds.length === 0) {
      updateLiveProgress(alert.id, {
        met: 0,
        total: conds.length,
        matchedCount: Object.keys(alert.triggeredSymbols ?? {}).length,
        memberCount: members.length
      });
      return alert;
    }

    const logic: AlertLogic = alert.logic === 'or' ? 'or' : 'and';
    const mode: WatchlistTriggerMode = alert.watchlistTriggerMode ?? 'once_per_symbol';
    const cooldownMs = alertCooldownMs(alert);
    const triggeredMap: Record<string, string> = { ...(alert.triggeredSymbols ?? {}) };

    interface MatchedMember {
      symbol: string;
      shortName: string;
      price?: number;
      detail: string;
    }
    const newlyMatched: MatchedMember[] = [];

    for (const item of members) {
      const bare = stripExchange(item.shortName || item.symbol);
      const prevFiredIso = triggeredMap[bare];
      if (mode === 'once_per_symbol' && prevFiredIso) continue;
      if (
        mode === 'every_per_symbol' &&
        prevFiredIso &&
        nowMs - Date.parse(prevFiredIso) < cooldownMs
      ) {
        continue;
      }

      const outcomes = conds.map((c) =>
        evaluateSingleCondition(alert.id, c, item.symbol, item.shortName)
      );

      const metNow =
        logic === 'and'
          ? outcomes.every((o) => o.evaluated && o.met)
          : outcomes.some((o) => o.evaluated && o.met);

      const edgeKey = `${alert.id}:${bare}`;
      const wasMet = prevRuleMetState.get(edgeKey) ?? false;
      prevRuleMetState.set(edgeKey, metNow);

      // Fire on first-pass true (if never fired before) or on false -> true transition for repeat mode
      const shouldFire =
        mode === 'every_per_symbol'
          ? metNow && (!prevFiredIso || !wasMet || nowMs - Date.parse(prevFiredIso) >= cooldownMs)
          : metNow;

      if (shouldFire) {
        const detail = outcomes
          .filter((o) => (logic === 'or' ? o.met : true))
          .map((o) => o.snapshot)
          .filter(Boolean)
          .join(' · ');
        const price = getLatestPriceFor(item.symbol, item.shortName) ?? outcomes[0]?.currentPrice;

        newlyMatched.push({
          symbol: item.symbol,
          shortName: item.shortName,
          price,
          detail
        });
        triggeredMap[bare] = nowIso;

        if (mode === 'once_first') break;
      }
    }

    const totalMatchedCount = Object.keys(triggeredMap).length;
    updateLiveProgress(alert.id, {
      met: totalMatchedCount,
      total: members.length,
      matchedCount: totalMatchedCount,
      memberCount: members.length
    });

    if (newlyMatched.length > 0) {
      stateChanged = true;
      const groupName = grp.name || alert.watchlistGroupName || 'Watchlist';

      for (const m of newlyMatched) {
        nextLogs.push({
          id: makeWorkspaceId('log'),
          alertId: alert.id,
          kind: 'price',
          symbol: m.symbol,
          shortName: m.shortName,
          watchlistGroupName: groupName,
          title: `${m.shortName} · ${groupName}`,
          message: alert.message,
          detail: m.detail,
          triggeredPrice: m.price,
          triggeredAt: nowIso
        });
      }

      // Burst coalescing: 1 symbol -> individual toast; 2+ symbols in same poll -> grouped toast + single chime
      if (newlyMatched.length === 1) {
        const m = newlyMatched[0];
        toFire.push({
          alert,
          title: `Watchlist Alert · ${m.shortName}`,
          body: `${groupName}: ${m.detail || alert.message}`,
          matchedSymbol: m.shortName,
          matchedFullSymbol: m.symbol,
          currentPrice: m.price,
          detail: m.detail
        });
      } else {
        const names = newlyMatched.map((m) => m.shortName);
        const preview =
          names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} +${names.length - 4}`;
        toFire.push({
          alert,
          title: `Watchlist Alert · ${newlyMatched.length} matched (${groupName})`,
          body: `${preview} — ${alert.message}`,
          matchedSymbol: newlyMatched[0].shortName,
          matchedFullSymbol: newlyMatched[0].symbol,
          currentPrice: newlyMatched[0].price,
          detail: newlyMatched.map((m) => `${m.shortName} (${m.detail})`).join('; ')
        });
      }

      const nextStatus: AlertStatus = mode === 'once_first' ? 'triggered' : 'active';
      if (nextStatus === 'triggered') updateLiveProgress(alert.id, null);

      return {
        ...alert,
        watchlistGroupName: groupName,
        shortName: groupName,
        triggeredSymbols: triggeredMap,
        lastTriggeredAt: nowIso,
        status: nextStatus
      };
    }

    // Keep displayed group name synced if renamed in Watchlist
    if (grp.name !== alert.watchlistGroupName) {
      stateChanged = true;
      return { ...alert, watchlistGroupName: grp.name, shortName: grp.name };
    }

    return alert;
  });

  if (stateChanged) {
    commitState({
      alerts: nextAlerts,
      log: nextLogs.length > 0 ? [...nextLogs, ...state.log] : state.log
    });
  }

  for (const d of toFire) {
    void fireNotification(d);
  }
}

/** Feed live price updates (from active chart or backend polling) into active price & multi-condition alerts. */
export function evaluateAlertsWithPrice(
  symbol: string,
  shortName: string,
  price: number,
  source: 'live' | 'poll' = 'poll'
): void {
  if (!Number.isFinite(price)) return;
  const nowMs = Date.now();
  const sFull = symbol.toUpperCase();
  const sShort = shortName.toUpperCase();
  const sBare = stripExchange(shortName || symbol);

  livePriceByKey.set(sFull, price);
  livePriceByKey.set(sShort, price);
  livePriceByKey.set(sBare, price);

  if (source === 'live') {
    lastLiveTickAt.set(sFull, nowMs);
    lastLiveTickAt.set(sShort, nowMs);
    lastLiveTickAt.set(sBare, nowMs);
  }

  if (state.alerts.length === 0) return;
  evaluateSymbolAlertsPass({ sFull, sShort, sBare });
}

function expireStalePriceAlerts(): void {
  if (state.alerts.length === 0) return;
  const nowMs = Date.now();
  let changed = false;
  const nextAlerts = state.alerts.map((alert) => {
    if (
      alert.kind === 'price' &&
      alert.status === 'active' &&
      alert.expiresAt &&
      Date.parse(alert.expiresAt) <= nowMs
    ) {
      changed = true;
      clearRuntimeCachesForAlert(alert.id);
      return { ...alert, status: 'expired' as AlertStatus };
    }
    return alert;
  });
  if (changed) {
    commitState({ ...state, alerts: nextAlerts });
  }
}

function evaluateNewsAlerts(): void {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const nowIso = new Date(nowMs).toISOString();

  let changed = false;
  const nextLogs: AlertLogEntry[] = [];
  const toFire: NotificationDispatch[] = [];

  const nextAlerts = state.alerts.map((alert) => {
    if (alert.kind !== 'news' || alert.status !== 'active') return alert;
    if (typeof alert.eventTs !== 'number') return alert;

    const leadSec = (alert.leadMinutes ?? 15) * 60;
    const fireAtSec = alert.eventTs - leadSec;

    if (nowSec > alert.eventTs + 900) {
      changed = true;
      return { ...alert, status: 'expired' as AlertStatus };
    }

    if (nowSec >= fireAtSec) {
      changed = true;
      toFire.push({
        alert,
        title: `Calendar Alert · ${alert.eventCountry ?? 'News'}`,
        body: alert.message || `${alert.eventTitle ?? 'Economic event'} releasing soon`,
        matchedSymbol: alert.eventCountry ?? 'USD',
        matchedFullSymbol: alert.eventCountry ?? 'USD'
      });
      nextLogs.push({
        id: makeWorkspaceId('log'),
        alertId: alert.id,
        kind: 'news',
        symbol: alert.eventCountry ?? 'USD',
        shortName: alert.eventCountry ?? 'USD',
        title: alert.eventTitle ?? 'Economic Event',
        message: alert.message,
        triggeredAt: nowIso
      });
      return {
        ...alert,
        lastTriggeredAt: nowIso,
        status: 'triggered' as AlertStatus
      };
    }
    return alert;
  });

  if (changed) {
    commitState({
      alerts: nextAlerts,
      log: nextLogs.length > 0 ? [...nextLogs, ...state.log] : state.log
    });
  }

  for (const d of toFire) {
    void fireNotification(d);
  }
}

function hasFreshLiveFeedForSymbol(symbol: string, nowMs: number): boolean {
  const keys = [symbol.toUpperCase(), stripExchange(symbol)];
  for (const key of keys) {
    const ts = lastLiveTickAt.get(key);
    if (ts !== undefined && nowMs - ts < LIVE_FEED_FRESH_MS) return true;
  }
  return false;
}

async function fetchScreenerBatch(symbols: string[]): Promise<ScreenerRowData[]> {
  if (symbols.length === 0) return [];
  const unique = Array.from(new Set(symbols));
  const res = await fetch(`${getApiBaseUrl()}/api/screener`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: unique })
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { rows?: ScreenerRowData[] };
  return Array.isArray(json.rows) ? json.rows : [];
}

async function fetchOfflineBars(symbol: string, fromSec: number): Promise<HistoricalBar[]> {
  try {
    const url = `${getApiBaseUrl()}/api/quotes/bars?symbol=${encodeURIComponent(symbol)}&from=${Math.floor(fromSec)}`;
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = (await res.json()) as { bars?: HistoricalBar[] };
    return Array.isArray(json.bars) ? json.bars : [];
  } catch {
    return [];
  }
}

function barSatisfiesPriceCond(
  cond: AlertCondition,
  bar: HistoricalBar,
  prevClose: number | undefined
): boolean {
  const target = cond.value;
  if (typeof target !== 'number' || !Number.isFinite(target)) return false;
  const op = (cond.operator as AlertOperator) ?? 'crossing';
  switch (op) {
    case 'greater_than':
      return bar.high > target;
    case 'less_than':
      return bar.low < target;
    case 'crossing_up':
      return (
        (typeof prevClose === 'number' && prevClose < target && bar.high >= target) ||
        (bar.open < target && bar.high >= target)
      );
    case 'crossing_down':
      return (
        (typeof prevClose === 'number' && prevClose > target && bar.low <= target) ||
        (bar.open > target && bar.low <= target)
      );
    case 'crossing':
    default:
      if (bar.low <= target && bar.high >= target) return true;
      if (typeof prevClose === 'number') {
        return (
          (prevClose < target && bar.high >= target) ||
          (prevClose > target && bar.low <= target)
        );
      }
      return false;
  }
}

/**
 * Closed-app catch-up: checks historical OHLC bars over the offline window for active
 * price alerts (single or multi-price) so levels crossed while the app was closed are
 * never silently missed.
 */
async function runReopenCatchUp(): Promise<void> {
  if (catchUpDone) return;
  catchUpDone = true;

  const nowMs = Date.now();
  const offlineFromMs = readOfflineBaselineMs();
  if (!offlineFromMs) {
    recordEvalTimestamp(nowMs, false);
    return;
  }

  const gapMs = nowMs - offlineFromMs;
  if (gapMs < MIN_OFFLINE_CATCHUP_MS) return;

  const clampedFromMs = Math.max(offlineFromMs, nowMs - MAX_OFFLINE_CATCHUP_MS);
  const fromSec = Math.floor(clampedFromMs / 1000);

  // Eligible alerts: active single-symbol alerts whose conditions are all price conditions
  // (pure price single-condition or cross-symbol multi-price alerts).
  const candidates = state.alerts.filter((a) => {
    if (a.kind !== 'price' || a.status !== 'active' || isWatchlistAlert(a)) return false;
    const conds = getAlertConditions(a);
    return conds.length > 0 && conds.every((c) => c.metric === 'price');
  });

  if (candidates.length === 0) return;

  const symbolsToFetch = new Set<string>();
  for (const a of candidates) {
    for (const c of getAlertConditions(a)) {
      symbolsToFetch.add(c.symbol || a.symbol);
    }
  }

  const limitedSymbols = Array.from(symbolsToFetch).slice(0, 14);
  const barsBySym = new Map<string, HistoricalBar[]>();
  await Promise.all(
    limitedSymbols.map(async (sym) => {
      const bars = await fetchOfflineBars(sym, fromSec);
      if (bars.length > 0) barsBySym.set(sym.toUpperCase(), bars);
    })
  );

  if (barsBySym.size === 0) return;

  const nowIso = new Date(nowMs).toISOString();
  let stateChanged = false;
  const nextLogs: AlertLogEntry[] = [];
  const missedHits: { alert: TradingAlert; price: number; atIso: string }[] = [];

  const nextAlerts = state.alerts.map((alert) => {
    if (alert.kind !== 'price' || alert.status !== 'active' || isWatchlistAlert(alert)) return alert;
    const conds = getAlertConditions(alert);
    if (conds.length === 0 || !conds.every((c) => c.metric === 'price')) return alert;

    const createdMs = Date.parse(alert.createdAt);
    const effectiveFromSec = Number.isFinite(createdMs)
      ? Math.max(fromSec, Math.floor(createdMs / 1000))
      : fromSec;

    const logic: AlertLogic = alert.logic === 'or' ? 'or' : 'and';
    const primarySym = (conds[0].symbol || alert.symbol).toUpperCase();
    const primaryBars = (barsBySym.get(primarySym) ?? []).filter((b) => b.ts >= effectiveFromSec);
    if (primaryBars.length === 0) return alert;

    let hitBar: HistoricalBar | null = null;
    let prevPrimaryClose = alert.lastSeenPrice;

    for (const bar of primaryBars) {
      if (conds.length === 1) {
        if (barSatisfiesPriceCond(conds[0], bar, prevPrimaryClose)) {
          hitBar = bar;
          break;
        }
      } else {
        const legHits = conds.map((c, idx) => {
          if (idx === 0) return barSatisfiesPriceCond(c, bar, prevPrimaryClose);
          const legSym = (c.symbol || alert.symbol).toUpperCase();
          const legBars = barsBySym.get(legSym) ?? [];
          // Find nearest bar within 1 hour of primary bar timestamp
          let bestIdx = -1;
          let bestDiff = 3600;
          for (let i = 0; i < legBars.length; i++) {
            const diff = Math.abs(legBars[i].ts - bar.ts);
            if (diff <= bestDiff) {
              bestDiff = diff;
              bestIdx = i;
            }
          }
          if (bestIdx < 0) return false;
          const prevLegClose = bestIdx > 0 ? legBars[bestIdx - 1].close : undefined;
          return barSatisfiesPriceCond(c, legBars[bestIdx], prevLegClose);
        });

        const matched = logic === 'and' ? legHits.every(Boolean) : legHits.some(Boolean);
        if (matched) {
          hitBar = bar;
          break;
        }
      }
      prevPrimaryClose = bar.close;
    }

    if (!hitBar) return alert;

    stateChanged = true;
    const hitIso = new Date(hitBar.ts * 1000).toISOString();
    const hitPrice = conds[0].value ?? hitBar.close;
    missedHits.push({ alert, price: hitPrice, atIso: hitIso });

    nextLogs.push({
      id: makeWorkspaceId('log'),
      alertId: alert.id,
      kind: 'price',
      symbol: alert.symbol,
      shortName: alert.shortName,
      title: `${alert.shortName} · Hit while closed`,
      message: alert.message || formatConditionSummary(conds[0], alert.shortName, true),
      detail: `Level touched around ${formatQuotePrice(hitPrice, alert.shortName)} while app was closed`,
      missedWhileClosed: true,
      triggeredPrice: hitPrice,
      triggeredAt: hitIso
    });

    const latestClose = primaryBars[primaryBars.length - 1]?.close ?? hitPrice;
    lastSeenPrices.set(alert.id, latestClose);

    return {
      ...alert,
      lastSeenPrice: latestClose,
      lastTriggeredAt: nowIso,
      status: alert.trigger === 'once' ? ('triggered' as AlertStatus) : ('active' as AlertStatus)
    };
  });

  if (stateChanged) {
    commitState({
      alerts: nextAlerts,
      log: nextLogs.length > 0 ? [...nextLogs, ...state.log] : state.log
    });
  }

  // Emit one clean catch-up summary toast so startup is informative without popup spam
  if (missedHits.length === 1) {
    const h = missedHits[0];
    emitToast({
      id: makeWorkspaceId('toast'),
      title: `While closed · ${h.alert.shortName}`,
      message: h.alert.message || `Touched ${formatQuotePrice(h.price, h.alert.shortName)}`,
      symbol: h.alert.shortName,
      fullSymbol: h.alert.symbol,
      missedWhileClosed: true,
      createdAt: nowIso
    });
  } else if (missedHits.length > 1) {
    const names = Array.from(new Set(missedHits.map((h) => h.alert.shortName)));
    const preview =
      names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} +${names.length - 4}`;
    emitToast({
      id: makeWorkspaceId('toast'),
      title: `${missedHits.length} price alerts hit while closed`,
      message: `${preview} — check Alert Log for details.`,
      symbol: missedHits[0].alert.shortName,
      fullSymbol: missedHits[0].alert.symbol,
      missedWhileClosed: true,
      createdAt: nowIso
    });
  }
}

async function pollBackgroundAlerts(): Promise<void> {
  if (pollInFlight) return;
  const activeAlerts = state.alerts.filter((a) => a.kind === 'price' && a.status === 'active');
  if (activeAlerts.length === 0) {
    recordEvalTimestamp(Date.now(), false);
    return;
  }

  pollInFlight = true;
  try {
    const nowMs = Date.now();
    const hasWatchlistRules = activeAlerts.some((a) => isWatchlistAlert(a));
    const wlState = hasWatchlistRules ? await loadWatchlistState() : null;
    const groups = wlState?.groups ?? [];

    const screenerSymbols = new Set<string>();
    const priceOnlySymbols = new Set<string>();

    for (const alert of activeAlerts) {
      if (isWatchlistAlert(alert)) {
        const grp = groups.find((g) => g.id === alert.watchlistGroupId);
        if (grp) {
          for (const sec of grp.sections) {
            for (const item of sec.items) screenerSymbols.add(item.symbol);
          }
        }
        continue;
      }

      const conds = getAlertConditions(alert);
      for (const c of conds) {
        const sym = c.symbol || alert.symbol;
        if (c.metric === 'price') {
          if (!hasFreshLiveFeedForSymbol(sym, nowMs)) {
            priceOnlySymbols.add(sym);
          }
        } else {
          screenerSymbols.add(sym);
        }
      }
    }

    // Any symbol already in screenerSymbols gets fresh price from /api/screener too
    for (const sym of screenerSymbols) priceOnlySymbols.delete(sym);

    const [screenerRows, quotes] = await Promise.all([
      screenerSymbols.size > 0
        ? fetchScreenerBatch(Array.from(screenerSymbols))
        : Promise.resolve([] as ScreenerRowData[]),
      priceOnlySymbols.size > 0
        ? fetchMarketQuotes(Array.from(priceOnlySymbols))
        : Promise.resolve({} as Record<string, MarketQuote>)
    ]);

    for (const row of screenerRows) {
      const kFull = row.symbol.toUpperCase();
      const kShort = row.shortName.toUpperCase();
      const kBare = stripExchange(row.shortName || row.symbol);
      screenerByKey.set(kFull, row);
      screenerByKey.set(kShort, row);
      screenerByKey.set(kBare, row);
      if (!hasFreshLiveFeedForSymbol(row.symbol, nowMs)) {
        livePriceByKey.set(kFull, row.price);
        livePriceByKey.set(kShort, row.price);
        livePriceByKey.set(kBare, row.price);
      }
    }

    for (const q of Object.values(quotes)) {
      const kFull = q.symbol.toUpperCase();
      const kShort = q.shortName.toUpperCase();
      const kBare = stripExchange(q.shortName || q.symbol);
      livePriceByKey.set(kFull, q.price);
      livePriceByKey.set(kShort, q.price);
      livePriceByKey.set(kBare, q.price);
    }

    evaluateSymbolAlertsPass();
    if (hasWatchlistRules) {
      evaluateWatchlistAlertsPass(groups);
    }
    recordEvalTimestamp(Date.now(), false);
  } catch {
    // Non-fatal offline tick
  } finally {
    pollInFlight = false;
  }
}

/** Starts background polling for price, multi-condition, watchlist-wide, and calendar news alerts. */
export function startAlertMonitor(): () => void {
  const onBeforeUnload = () => {
    recordEvalTimestamp(Date.now(), false);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  void initAlertsStore().then(async () => {
    expireStalePriceAlerts();
    await runReopenCatchUp();
    evaluateNewsAlerts();
    await pollBackgroundAlerts();
    recordEvalTimestamp(Date.now(), true);
  });

  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(() => {
    expireStalePriceAlerts();
    evaluateNewsAlerts();
    void pollBackgroundAlerts();
  }, 15_000);

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onBeforeUnload);
    }
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
  };
}
