import { fetchMarketQuotes, formatQuotePrice } from '../watchlist/store';
import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  playAlertChime,
  saveWorkspaceJson,
  sendDesktopNotification
} from '../workspace/storage';

export type AlertKind = 'price' | 'news';
export type AlertOperator =
  | 'crossing'
  | 'crossing_up'
  | 'crossing_down'
  | 'greater_than'
  | 'less_than';
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
  symbol: string; // e.g. OANDA:XAUUSD (or country/currency for news)
  shortName: string; // e.g. XAUUSD (or "US CPI" for news)
  operator?: AlertOperator;
  targetPrice?: number;
  lastSeenPrice?: number;
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
  triggeredPrice?: number;
  triggeredAt: string;
}

export interface AlertsState {
  alerts: TradingAlert[];
  log: AlertLogEntry[];
}

export interface InAppAlertToast {
  id: string;
  title: string;
  message: string;
  symbol: string;
  createdAt: string;
}

export const OPERATOR_LABELS: Record<AlertOperator, string> = {
  crossing: 'Crossing',
  crossing_up: 'Crossing Up',
  crossing_down: 'Crossing Down',
  greater_than: 'Greater Than',
  less_than: 'Less Than'
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
const REPEAT_COOLDOWN_MS = 60_000;

let state: AlertsState = { alerts: [], log: [] };
let hydrated = false;
const stateListeners = new Set<(s: AlertsState) => void>();
const toastListeners = new Set<(toast: InAppAlertToast) => void>();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

function emitState() {
  for (const fn of stateListeners) fn(state);
}

function emitToast(toast: InAppAlertToast) {
  for (const fn of toastListeners) fn(toast);
}

export async function initAlertsStore(): Promise<AlertsState> {
  if (!hydrated) {
    hydrated = true;
    const loaded = await loadWorkspaceJson<AlertsState>(STORAGE_KEY, { alerts: [], log: [] });
    state = {
      alerts: Array.isArray(loaded.alerts) ? loaded.alerts : [],
      log: Array.isArray(loaded.log) ? loaded.log : []
    };
    emitState();
  }
  return state;
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

function commitState(next: AlertsState) {
  state = {
    alerts: next.alerts,
    log: next.log.slice(0, 100)
  };
  emitState();
  void saveWorkspaceJson(STORAGE_KEY, state);
}

export function formatAlertDefaultMessage(
  shortName: string,
  operator: AlertOperator,
  targetPrice: number
): string {
  return `${shortName} ${OPERATOR_LABELS[operator]} ${formatQuotePrice(targetPrice, shortName)}`;
}

export function upsertAlert(alert: TradingAlert): void {
  const exists = state.alerts.some((a) => a.id === alert.id);
  const alerts = exists
    ? state.alerts.map((a) => (a.id === alert.id ? alert : a))
    : [alert, ...state.alerts];
  commitState({ ...state, alerts });
}

export function deleteAlertById(id: string): void {
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
      if (a.status === 'active') return { ...a, status: 'paused' };
      return { ...a, status: 'active' };
    })
  });
}

export function pauseAllAlerts(): void {
  commitState({
    ...state,
    alerts: state.alerts.map((a) => (a.status === 'active' ? { ...a, status: 'paused' } : a))
  });
}

export function resumeAllAlerts(): void {
  commitState({
    ...state,
    alerts: state.alerts.map((a) => (a.status === 'paused' ? { ...a, status: 'active' } : a))
  });
}

export function clearAlertLog(): void {
  commitState({ ...state, log: [] });
}

export function countActiveAlertsForSymbol(symbol: string, shortName: string): number {
  const s1 = symbol.toUpperCase();
  const s2 = shortName.toUpperCase();
  return state.alerts.filter(
    (a) =>
      a.status === 'active' &&
      a.kind === 'price' &&
      (a.symbol.toUpperCase() === s1 || a.shortName.toUpperCase() === s2)
  ).length;
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
    deleteAlertById(existing.id);
    return false;
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
  const day = now.getDay(); // 0 Sun .. 6 Sat
  if (schedule === 'weekdays') return day >= 1 && day <= 5;
  // sessions: Mon-Fri 07:00 - 22:00 local time
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 7 && hour < 22;
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

async function fireAlertNotification(alert: TradingAlert, currentPrice?: number): Promise<void> {
  const now = new Date();
  const title =
    alert.kind === 'news'
      ? `Calendar Alert · ${alert.eventCountry ?? 'News'}`
      : `Price Alert · ${alert.shortName}`;
  const body =
    alert.message ||
    (alert.kind === 'news'
      ? `${alert.eventTitle ?? 'Economic event'} releasing soon`
      : `${alert.shortName} reached ${formatQuotePrice(currentPrice ?? alert.targetPrice, alert.shortName)}`);

  const prefs = alert.notifications ?? DEFAULT_NOTIFICATIONS;
  if (!isWithinSchedule(prefs.schedule, now)) return;

  if (prefs.showToast) {
    emitToast({
      id: makeWorkspaceId('toast'),
      title,
      message: body,
      symbol: alert.shortName,
      createdAt: now.toISOString()
    });
  }

  if (prefs.playSound) {
    playAlertChime();
  }

  if (prefs.notifyDesktop) {
    void sendDesktopNotification(title, body);
  }

  if (prefs.webhookEnabled && prefs.webhookUrl.trim()) {
    void fetch(`${getApiBaseUrl()}/api/alerts/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: prefs.webhookUrl.trim(),
        payload: {
          source: 'DeplyzeWorkflow',
          title,
          message: body,
          symbol: alert.symbol,
          shortName: alert.shortName,
          price: currentPrice ?? null,
          targetPrice: alert.targetPrice ?? null,
          triggeredAt: now.toISOString()
        }
      })
    }).catch(() => {
      // non-fatal
    });
  }
}

/** Feed live price updates (from active chart or backend polling) into active price alerts. */
export function evaluateAlertsWithPrice(
  symbol: string,
  shortName: string,
  price: number
): void {
  if (!Number.isFinite(price) || state.alerts.length === 0) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sFull = symbol.toUpperCase();
  const sShort = shortName.toUpperCase();

  let changed = false;
  const nextLogs: AlertLogEntry[] = [];
  const toFire: TradingAlert[] = [];

  const nextAlerts = state.alerts.map((alert) => {
    if (alert.kind !== 'price' || alert.status !== 'active') return alert;
    if (
      alert.symbol.toUpperCase() !== sFull &&
      alert.shortName.toUpperCase() !== sShort
    ) {
      return alert;
    }

    if (alert.expiresAt && Date.parse(alert.expiresAt) <= nowMs) {
      changed = true;
      return { ...alert, status: 'expired' as AlertStatus };
    }

    const target = alert.targetPrice;
    const op = alert.operator ?? 'crossing';
    if (typeof target !== 'number' || !Number.isFinite(target)) return alert;

    const prevPrice = alert.lastSeenPrice;
    // Seed initial baseline price cleanly on first tick for Crossing alerts so they don't misfire
    if (prevPrice === undefined && (op === 'crossing' || op === 'crossing_up' || op === 'crossing_down')) {
      changed = true;
      return { ...alert, lastSeenPrice: price };
    }

    const cooldownOk =
      !alert.lastTriggeredAt || nowMs - Date.parse(alert.lastTriggeredAt) >= REPEAT_COOLDOWN_MS;

    if (cooldownOk && matchesPriceCondition(op, target, price, prevPrice)) {
      changed = true;
      toFire.push(alert);
      nextLogs.push({
        id: makeWorkspaceId('log'),
        alertId: alert.id,
        kind: 'price',
        symbol: alert.symbol,
        shortName: alert.shortName,
        title: `${alert.shortName} ${OPERATOR_LABELS[op]} ${formatQuotePrice(target, alert.shortName)}`,
        message: alert.message,
        triggeredPrice: price,
        triggeredAt: nowIso
      });
      return {
        ...alert,
        lastSeenPrice: price,
        lastTriggeredAt: nowIso,
        status: alert.trigger === 'once' ? ('triggered' as AlertStatus) : ('active' as AlertStatus)
      };
    }

    if (prevPrice !== price) {
      changed = true;
      return { ...alert, lastSeenPrice: price };
    }
    return alert;
  });

  if (changed) {
    commitState({
      alerts: nextAlerts,
      log: nextLogs.length > 0 ? [...nextLogs, ...state.log] : state.log
    });
  }

  for (const a of toFire) {
    void fireAlertNotification(a, price);
  }
}

function evaluateNewsAlerts(): void {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const nowIso = new Date(nowMs).toISOString();

  let changed = false;
  const nextLogs: AlertLogEntry[] = [];
  const toFire: TradingAlert[] = [];

  const nextAlerts = state.alerts.map((alert) => {
    if (alert.kind !== 'news' || alert.status !== 'active') return alert;
    if (typeof alert.eventTs !== 'number') return alert;

    const leadSec = (alert.leadMinutes ?? 15) * 60;
    const fireAtSec = alert.eventTs - leadSec;

    // Expired well after the release already passed (>15m ago)
    if (nowSec > alert.eventTs + 900) {
      changed = true;
      return { ...alert, status: 'expired' as AlertStatus };
    }

    if (nowSec >= fireAtSec) {
      changed = true;
      toFire.push(alert);
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

  for (const a of toFire) {
    void fireAlertNotification(a);
  }
}

async function pollBackgroundPriceAlerts(): Promise<void> {
  const activePriceSymbols = Array.from(
    new Set(
      state.alerts
        .filter((a) => a.kind === 'price' && a.status === 'active')
        .map((a) => a.symbol)
    )
  );
  if (activePriceSymbols.length === 0) return;

  try {
    const quotes = await fetchMarketQuotes(activePriceSymbols);
    for (const q of Object.values(quotes)) {
      evaluateAlertsWithPrice(q.symbol, q.shortName, q.price);
    }
  } catch {
    // Non-fatal offline tick
  }
}

/** Starts background polling for price alerts (non-active symbols) and calendar news alerts. */
export function startAlertMonitor(): () => void {
  void initAlertsStore().then(() => {
    evaluateNewsAlerts();
    void pollBackgroundPriceAlerts();
  });

  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(() => {
    evaluateNewsAlerts();
    void pollBackgroundPriceAlerts();
  }, 15_000);

  return () => {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
  };
}
