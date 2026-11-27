import {
  closeStrategyPositionOnAccount,
  computeAccountMetrics,
  ensureDedicatedStrategyAccount,
  executeStrategyOrderOnAccount,
  getPaperAccountById,
  getPaperLiveQuotesSnapshot,
  getPaperSnapshot,
  logStrategyActivityOnAccount,
  setPaperBottomHeight,
  setPaperBottomMode
} from '../paper/store';
import { normalizeSymbolKey } from '../paper/instruments';
import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  saveWorkspaceJson
} from '../workspace/storage';
import type {
  BacktestReport,
  ForwardExecutionMode,
  ForwardRunnerConfig,
  LiveStrategyEvaluation,
  PendingStrategySignal,
  SavedStrategyRecord,
  StrategySpec,
  StrategyTimeframe,
  StrategyWorkspaceState
} from './types';

const STORAGE_KEY = 'strategies';
const MAX_SAVED_STRATEGIES = 40;
const RUNNER_POLL_MS = 20_000;

function createDefaultState(): StrategyWorkspaceState {
  return {
    strategies: [],
    openStrategyId: null,
    activeDockTab: 'paper',
    dockMode: 'collapsed',
    dockHeight: 340,
    runners: [],
    pendingSignals: []
  };
}

let state: StrategyWorkspaceState = createDefaultState();
let hydrated = false;
let hydrationPromise: Promise<StrategyWorkspaceState> | null = null;
let runnerTimer: ReturnType<typeof setInterval> | null = null;
let runnerInFlight = false;
let rerunLoading = false;
let rerunError: string | null = null;

const listeners = new Set<(s: StrategyWorkspaceState) => void>();
const statusListeners = new Set<(st: { running: boolean; error: string | null }) => void>();

function emitState(): void {
  for (const fn of listeners) fn(state);
}

function emitStatus(): void {
  const payload = { running: rerunLoading, error: rerunError };
  for (const fn of statusListeners) fn(payload);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistState(immediate = false): void {
  if (immediate) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void saveWorkspaceJson(STORAGE_KEY, state);
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveWorkspaceJson(STORAGE_KEY, state);
  }, 150);
}

function commit(next: StrategyWorkspaceState, immediate = false): void {
  state = next;
  emitState();
  persistState(immediate);
}

export function getStrategySnapshot(): StrategyWorkspaceState {
  return state;
}

export async function initStrategyStore(): Promise<StrategyWorkspaceState> {
  if (hydrated) return state;
  if (!hydrationPromise) {
    hydrationPromise = loadWorkspaceJson<Partial<StrategyWorkspaceState> | null>(STORAGE_KEY, null)
      .then((loaded) => {
        if (loaded && typeof loaded === 'object') {
          const strategies = Array.isArray(loaded.strategies) ? loaded.strategies : [];
          const openId =
            typeof loaded.openStrategyId === 'string' &&
            strategies.some((s) => s.id === loaded.openStrategyId)
              ? loaded.openStrategyId
              : null;
          state = {
            strategies,
            openStrategyId: openId,
            activeDockTab: openId && loaded.activeDockTab === 'strategy' ? 'strategy' : 'paper',
            dockMode:
              loaded.dockMode === 'expanded' || loaded.dockMode === 'fullscreen'
                ? loaded.dockMode
                : 'collapsed',
            dockHeight:
              typeof loaded.dockHeight === 'number' && Number.isFinite(loaded.dockHeight)
                ? Math.max(200, Math.min(680, loaded.dockHeight))
                : 340,
            runners: Array.isArray(loaded.runners) ? loaded.runners : [],
            pendingSignals: Array.isArray(loaded.pendingSignals) ? loaded.pendingSignals : []
          };
        }
        hydrated = true;
        emitState();
        return state;
      })
      .catch(() => {
        hydrated = true;
        emitState();
        return state;
      });
  }
  return hydrationPromise;
}

export function subscribeStrategies(fn: (s: StrategyWorkspaceState) => void): () => void {
  listeners.add(fn);
  fn(state);
  void initStrategyStore();
  return () => {
    listeners.delete(fn);
  };
}

export function subscribeStrategyRunStatus(
  fn: (st: { running: boolean; error: string | null }) => void
): () => void {
  statusListeners.add(fn);
  fn({ running: rerunLoading, error: rerunError });
  return () => {
    statusListeners.delete(fn);
  };
}

export function getOpenStrategy(s: StrategyWorkspaceState = state): SavedStrategyRecord | null {
  if (!s.openStrategyId) return null;
  return s.strategies.find((item) => item.id === s.openStrategyId) ?? null;
}

/**
 * Called automatically when the AI Copilot emits a `strategy_result` SSE event.
 * Persists the strategy, opens the Strategy Tester bottom tab alongside Paper Ledger,
 * and expands the bottom dock cleanly so the user immediately sees the TradingView-style report.
 */
export function openStrategyFromAi(report: BacktestReport): SavedStrategyRecord {
  const nowIso = new Date().toISOString();
  const id = report.spec.id || makeWorkspaceId('strat');
  const normalizedReport: BacktestReport = {
    ...report,
    spec: { ...report.spec, id }
  };

  const existing = state.strategies.find((s) => s.id === id);
  const record: SavedStrategyRecord = existing
    ? { ...existing, updatedAt: nowIso, report: normalizedReport }
    : { id, savedAt: nowIso, updatedAt: nowIso, pinned: false, report: normalizedReport };

  const others = state.strategies.filter((s) => s.id !== id);
  const nextList = [record, ...others].slice(0, MAX_SAVED_STRATEGIES);

  const nextHeight = Math.max(360, state.dockHeight);
  commit(
    {
      ...state,
      strategies: nextList,
      openStrategyId: id,
      activeDockTab: 'strategy',
      dockMode: state.dockMode === 'fullscreen' ? 'fullscreen' : 'expanded',
      dockHeight: nextHeight
    },
    true
  );

  // Sync Paper bottom dock height/expansion if Paper is also connected
  if (getPaperSnapshot().connected) {
    setPaperBottomHeight(nextHeight);
    if (getPaperSnapshot().bottomMode === 'collapsed') {
      setPaperBottomMode('expanded');
    }
  }
  return record;
}

export function openSavedStrategy(strategyId: string): void {
  if (!state.strategies.some((s) => s.id === strategyId)) return;
  const nextHeight = Math.max(360, state.dockHeight);
  commit(
    {
      ...state,
      openStrategyId: strategyId,
      activeDockTab: 'strategy',
      dockMode: state.dockMode === 'fullscreen' ? 'fullscreen' : 'expanded',
      dockHeight: nextHeight
    },
    true
  );
  if (getPaperSnapshot().connected && getPaperSnapshot().bottomMode === 'collapsed') {
    setPaperBottomMode('expanded');
  }
}

export function closeStrategyTab(): void {
  commit(
    {
      ...state,
      openStrategyId: null,
      activeDockTab: 'paper'
    },
    true
  );
}

export function setActiveDockTab(tab: 'strategy' | 'paper'): void {
  if (tab === 'strategy' && !state.openStrategyId) return;
  const nextMode = state.dockMode === 'collapsed' ? 'expanded' : state.dockMode;
  commit({ ...state, activeDockTab: tab, dockMode: nextMode });
  if (getPaperSnapshot().connected && getPaperSnapshot().bottomMode === 'collapsed') {
    setPaperBottomMode('expanded');
  }
}

export function setStrategyDockMode(mode: 'collapsed' | 'expanded' | 'fullscreen'): void {
  commit({ ...state, dockMode: mode });
  if (getPaperSnapshot().connected) {
    setPaperBottomMode(mode);
  }
}

export function setStrategyDockHeight(height: number): void {
  const clamped = Math.round(Math.max(200, Math.min(680, height)));
  commit({ ...state, dockHeight: clamped });
  if (getPaperSnapshot().connected) {
    setPaperBottomHeight(clamped);
  }
}

export function togglePinStrategy(strategyId: string): void {
  commit(
    {
      ...state,
      strategies: state.strategies.map((s) =>
        s.id === strategyId ? { ...s, pinned: !s.pinned } : s
      )
    },
    true
  );
}

export function duplicateSavedStrategy(strategyId: string): SavedStrategyRecord | null {
  const src = state.strategies.find((s) => s.id === strategyId);
  if (!src) return null;
  const nowIso = new Date().toISOString();
  const newId = makeWorkspaceId('strat');
  const copyReport: BacktestReport = {
    ...src.report,
    spec: {
      ...src.report.spec,
      id: newId,
      name: `${src.report.spec.name} (Copy)`
    }
  };
  const copy: SavedStrategyRecord = {
    id: newId,
    savedAt: nowIso,
    updatedAt: nowIso,
    pinned: false,
    report: copyReport
  };
  commit(
    {
      ...state,
      strategies: [copy, ...state.strategies].slice(0, MAX_SAVED_STRATEGIES),
      openStrategyId: newId,
      activeDockTab: 'strategy'
    },
    true
  );
  return copy;
}

export function deleteSavedStrategy(strategyId: string): void {
  const remaining = state.strategies.filter((s) => s.id !== strategyId);
  const nextOpen =
    state.openStrategyId === strategyId ? (remaining[0]?.id ?? null) : state.openStrategyId;
  commit(
    {
      ...state,
      strategies: remaining,
      openStrategyId: nextOpen,
      activeDockTab: nextOpen ? state.activeDockTab : 'paper',
      runners: state.runners.filter((r) => r.strategyId !== strategyId),
      pendingSignals: state.pendingSignals.filter((p) => p.strategyId !== strategyId)
    },
    true
  );
}

/**
 * Deterministic backend re-run for Properties edits, capital changes, cost toggles,
 * or date-range filters. Runs in <40ms from server candle cache without calling the LLM.
 */
export async function rerunStrategyBacktest(
  strategyId: string,
  nextSpec: StrategySpec,
  opts?: { fromTs?: number | null; toTs?: number | null; forceRefresh?: boolean }
): Promise<{ ok: boolean; error?: string; report?: BacktestReport }> {
  rerunLoading = true;
  rerunError = null;
  emitStatus();

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/strategy/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: nextSpec,
        fromTs: opts?.fromTs ?? null,
        toTs: opts?.toTs ?? null,
        forceRefresh: Boolean(opts?.forceRefresh)
      })
    });

    const json = (await res.json()) as { report?: BacktestReport; error?: string };
    if (!res.ok || !json.report) {
      const msg = json.error || `Backtest server returned HTTP ${res.status}`;
      rerunError = msg;
      return { ok: false, error: msg };
    }

    const existing = state.strategies.find((s) => s.id === strategyId);
    const preservedIterations = existing?.report.iterations ?? [];
    const updatedReport: BacktestReport = {
      ...json.report,
      spec: { ...json.report.spec, id: strategyId },
      iterations: json.report.iterations.length > 0 ? json.report.iterations : preservedIterations
    };

    const nowIso = new Date().toISOString();
    commit(
      {
        ...state,
        strategies: state.strategies.map((s) =>
          s.id === strategyId ? { ...s, updatedAt: nowIso, report: updatedReport } : s
        )
      },
      true
    );
    return { ok: true, report: updatedReport };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to reach strategy backtest server.';
    rerunError = msg;
    return { ok: false, error: msg };
  } finally {
    rerunLoading = false;
    emitStatus();
  }
}

// ── Forward-Running in Paper Ledger ──────────────────────────────────────────

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function timeframeSeconds(tf: StrategyTimeframe): number {
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

export function deployStrategyToPaper(
  strategyId: string,
  opts: {
    accountMode: 'dedicated' | 'existing';
    existingAccountId?: string;
    executionMode: ForwardExecutionMode;
    maxDailyLossPct?: number;
  }
): { ok: boolean; runner?: ForwardRunnerConfig; error?: string } {
  const strat = state.strategies.find((s) => s.id === strategyId);
  if (!strat) return { ok: false, error: 'Strategy not found.' };
  const spec = strat.report.spec;

  // Ensure Paper account target exists (default: dedicated isolated BOT sub-account!)
  let targetAcc =
    opts.accountMode === 'existing' && opts.existingAccountId
      ? getPaperAccountById(opts.existingAccountId)
      : null;

  if (!targetAcc) {
    const dedicatedName = `BOT · ${spec.name.slice(0, 28)}`;
    targetAcc = ensureDedicatedStrategyAccount(
      dedicatedName,
      spec.risk.initialCapital || 10000,
      100
    );
  }

  const metrics = computeAccountMetrics(targetAcc, getPaperLiveQuotesSnapshot());
  const nowIso = new Date().toISOString();
  const existingRunner = state.runners.find((r) => r.strategyId === strategyId);

  const runner: ForwardRunnerConfig = {
    id: existingRunner?.id ?? makeWorkspaceId('run'),
    strategyId,
    strategyName: spec.name,
    symbol: spec.symbol,
    shortName: spec.shortName,
    interval: spec.interval,
    accountId: targetAcc.id,
    accountName: targetAcc.name,
    executionMode: opts.executionMode,
    status: 'running',
    pauseReason: undefined,
    maxDailyLossPct: Math.max(0.5, Math.min(25, opts.maxDailyLossPct ?? 3.0)),
    dayAnchorDate: todayUtcDate(),
    dayStartEquityUsd: metrics.equity,
    // Set watermark to current bar so we do not retroactively fire on an old candle the moment user clicks Start
    lastEvaluatedBarTs:
      Math.floor(Date.now() / 1000 / timeframeSeconds(spec.interval)) *
        timeframeSeconds(spec.interval) -
      timeframeSeconds(spec.interval),
    lastCheckedAt: nowIso,
    signalsFired: existingRunner?.signalsFired ?? 0,
    createdAt: existingRunner?.createdAt ?? nowIso
  };

  logStrategyActivityOnAccount(
    targetAcc.id,
    spec.symbol,
    `[BOT: ${spec.name}] Forward runner started (${opts.executionMode === 'auto' ? 'Auto-Execute SIM' : 'Signal Confirm'} · ${spec.interval} closed bars · Max Daily Loss ${runner.maxDailyLossPct}%).`
  );

  commit(
    {
      ...state,
      runners: [runner, ...state.runners.filter((r) => r.id !== runner.id)]
    },
    true
  );

  return { ok: true, runner };
}

export function pauseForwardRunner(runnerId: string, reason?: string): void {
  const r = state.runners.find((x) => x.id === runnerId);
  if (!r) return;
  logStrategyActivityOnAccount(
    r.accountId,
    r.symbol,
    `[BOT: ${r.strategyName}] Forward runner paused${reason ? ` (${reason})` : ''}.`
  );
  commit(
    {
      ...state,
      runners: state.runners.map((x) =>
        x.id === runnerId ? { ...x, status: 'paused', pauseReason: reason } : x
      )
    },
    true
  );
}

export function resumeForwardRunner(runnerId: string): void {
  const r = state.runners.find((x) => x.id === runnerId);
  if (!r) return;
  const acc = getPaperAccountById(r.accountId);
  const eq = acc ? computeAccountMetrics(acc, getPaperLiveQuotesSnapshot()).equity : r.dayStartEquityUsd;
  logStrategyActivityOnAccount(
    r.accountId,
    r.symbol,
    `[BOT: ${r.strategyName}] Forward runner resumed.`
  );
  commit(
    {
      ...state,
      runners: state.runners.map((x) =>
        x.id === runnerId
          ? {
              ...x,
              status: 'running',
              pauseReason: undefined,
              dayAnchorDate: todayUtcDate(),
              dayStartEquityUsd: eq
            }
          : x
      )
    },
    true
  );
}

export function stopForwardRunner(runnerId: string): void {
  const r = state.runners.find((x) => x.id === runnerId);
  if (r) {
    logStrategyActivityOnAccount(
      r.accountId,
      r.symbol,
      `[BOT: ${r.strategyName}] Forward runner stopped.`
    );
  }
  commit(
    {
      ...state,
      runners: state.runners.filter((x) => x.id !== runnerId),
      pendingSignals: state.pendingSignals.filter((p) => p.runnerId !== runnerId)
    },
    true
  );
}

export function setRunnerExecutionMode(runnerId: string, mode: ForwardExecutionMode): void {
  commit(
    {
      ...state,
      runners: state.runners.map((r) => (r.id === runnerId ? { ...r, executionMode: mode } : r))
    },
    true
  );
}

export function confirmPendingSignal(signalId: string): void {
  const sig = state.pendingSignals.find((p) => p.id === signalId);
  if (!sig) return;

  if (sig.signal === 'enter_long' || sig.signal === 'enter_short') {
    executeStrategyOrderOnAccount(sig.accountId, {
      symbol: sig.symbol,
      shortName: sig.shortName,
      side: sig.signal === 'enter_long' ? 'buy' : 'sell',
      quantity: sig.quantity,
      fillPrice: sig.price,
      takeProfit: sig.takeProfit,
      stopLoss: sig.stopLoss,
      strategyName: sig.strategyName
    });
  } else {
    closeStrategyPositionOnAccount(sig.accountId, sig.symbol, sig.price, sig.strategyName);
  }

  commit(
    {
      ...state,
      pendingSignals: state.pendingSignals.filter((p) => p.id !== signalId)
    },
    true
  );
}

export function dismissPendingSignal(signalId: string): void {
  commit(
    {
      ...state,
      pendingSignals: state.pendingSignals.filter((p) => p.id !== signalId)
    },
    true
  );
}

async function tickForwardRunners(): Promise<void> {
  if (runnerInFlight) return;
  const activeRunners = state.runners.filter((r) => r.status === 'running');
  if (activeRunners.length === 0) return;

  runnerInFlight = true;
  try {
    const today = todayUtcDate();
    for (const runner of activeRunners) {
      const strat = state.strategies.find((s) => s.id === runner.strategyId);
      const acc = getPaperAccountById(runner.accountId);
      if (!strat || !acc) continue;

      const metrics = computeAccountMetrics(acc, getPaperLiveQuotesSnapshot());
      let dayStartEq = runner.dayStartEquityUsd;
      let dayAnchor = runner.dayAnchorDate;
      if (dayAnchor !== today) {
        dayAnchor = today;
        dayStartEq = metrics.equity;
      }

      // Hard Daily Loss Circuit Breaker
      const dailyLossPct =
        dayStartEq > 0 ? Math.max(0, ((dayStartEq - metrics.equity) / dayStartEq) * 100) : 0;
      if (dailyLossPct >= runner.maxDailyLossPct) {
        pauseForwardRunner(
          runner.id,
          `Daily loss limit reached (-${dailyLossPct.toFixed(2)}% >= ${runner.maxDailyLossPct}%)`
        );
        continue;
      }

      const openPos = acc.positions.find(
        (p) => normalizeSymbolKey(p.symbol) === normalizeSymbolKey(runner.symbol)
      );

      let evalRes: LiveStrategyEvaluation | null = null;
      try {
        const resp = await fetch(`${getApiBaseUrl()}/api/strategy/evaluate-live`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            spec: strat.report.spec,
            accountEquityUsd: metrics.equity,
            currentPositionSide: openPos ? openPos.side : null
          })
        });
        if (!resp.ok) continue;
        const json = (await resp.json()) as { evaluation?: LiveStrategyEvaluation };
        evalRes = json.evaluation ?? null;
      } catch {
        continue;
      }

      if (!evalRes) continue;
      const nowIso = new Date().toISOString();

      // Strictly evaluate each closed bar AT MOST ONCE
      if (evalRes.barTs <= runner.lastEvaluatedBarTs) {
        commit({
          ...state,
          runners: state.runners.map((x) =>
            x.id === runner.id
              ? { ...x, dayAnchorDate: dayAnchor, dayStartEquityUsd: dayStartEq, lastCheckedAt: nowIso }
              : x
          )
        });
        continue;
      }

      // Guard against stale offline signals (> 1.5 bars late)
      const nowSec = Math.floor(Date.now() / 1000);
      const tfSec = timeframeSeconds(runner.interval);
      const isStale = nowSec - evalRes.barCloseTs > Math.max(300, tfSec * 1.5);

      let firedIncrement = 0;
      let nextPending = state.pendingSignals;

      if (evalRes.signal !== 'none') {
        if (isStale) {
          logStrategyActivityOnAccount(
            runner.accountId,
            runner.symbol,
            `[BOT: ${runner.strategyName}] Skipped stale offline ${evalRes.signal} signal from closed candle.`
          );
        } else if (runner.executionMode === 'auto') {
          firedIncrement = 1;
          if (evalRes.signal === 'enter_long' || evalRes.signal === 'enter_short') {
            if (!openPos && evalRes.suggestedQty && evalRes.suggestedQty > 0) {
              executeStrategyOrderOnAccount(runner.accountId, {
                symbol: runner.symbol,
                shortName: runner.shortName,
                side: evalRes.signal === 'enter_long' ? 'buy' : 'sell',
                quantity: evalRes.suggestedQty,
                fillPrice: evalRes.signal === 'enter_long' ? evalRes.askPrice : evalRes.bidPrice,
                takeProfit: evalRes.suggestedTakeProfit,
                stopLoss: evalRes.suggestedStopLoss,
                strategyName: runner.strategyName
              });
            }
          } else if (openPos) {
            closeStrategyPositionOnAccount(
              runner.accountId,
              runner.symbol,
              openPos.side === 'long' ? evalRes.bidPrice : evalRes.askPrice,
              runner.strategyName
            );
          }
        } else {
          // Signal Confirm mode -> queue actionable confirmation banner
          firedIncrement = 1;
          const pending: PendingStrategySignal = {
            id: makeWorkspaceId('sig'),
            runnerId: runner.id,
            strategyId: runner.strategyId,
            strategyName: runner.strategyName,
            accountId: runner.accountId,
            accountName: runner.accountName,
            symbol: runner.symbol,
            shortName: runner.shortName,
            interval: runner.interval,
            barTs: evalRes.barTs,
            signal: evalRes.signal,
            price:
              evalRes.signal === 'enter_long' || evalRes.signal === 'exit_short'
                ? evalRes.askPrice
                : evalRes.bidPrice,
            stopLoss: evalRes.suggestedStopLoss,
            takeProfit: evalRes.suggestedTakeProfit,
            quantity: evalRes.suggestedQty ?? openPos?.quantity ?? 1,
            reason: evalRes.reason,
            createdAt: nowIso
          };
          nextPending = [pending, ...nextPending].slice(0, 12);
        }
      }

      commit(
        {
          ...state,
          pendingSignals: nextPending,
          runners: state.runners.map((x) =>
            x.id === runner.id
              ? {
                  ...x,
                  dayAnchorDate: dayAnchor,
                  dayStartEquityUsd: dayStartEq,
                  lastEvaluatedBarTs: evalRes!.barTs,
                  lastCheckedAt: nowIso,
                  signalsFired: x.signalsFired + firedIncrement
                }
              : x
          )
        },
        true
      );
    }
  } finally {
    runnerInFlight = false;
  }
}

export function startStrategyRunnerMonitor(): () => void {
  void initStrategyStore().then(() => {
    void tickForwardRunners();
  });
  if (!runnerTimer) {
    runnerTimer = setInterval(() => {
      void tickForwardRunners();
    }, RUNNER_POLL_MS);
  }
  return () => {
    if (runnerTimer) {
      clearInterval(runnerTimer);
      runnerTimer = null;
    }
  };
}

// ── CSV Export for Strategy List of Trades ───────────────────────────────────

function csvEsc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportStrategyTradesCsv(report: BacktestReport): void {
  const headers = [
    'Trade #',
    'Segment',
    'Side',
    'Entry Time (UTC)',
    'Exit Time (UTC)',
    'Entry Price',
    'Exit Price',
    'Stop Loss',
    'Take Profit',
    'Size',
    'Notional USD',
    'Gross PnL USD',
    'Spread Cost USD',
    'Slippage Cost USD',
    'Commission USD',
    'Net PnL USD',
    'Return %',
    'Realized R',
    'MFE %',
    'MAE %',
    'Bars Held',
    'Exit Reason'
  ];

  const rows = report.trades.map((t) => [
    t.tradeNumber,
    t.segment,
    t.side,
    new Date(t.entryTs * 1000).toISOString(),
    new Date(t.exitTs * 1000).toISOString(),
    t.entryPrice,
    t.exitPrice,
    t.stopLoss ?? '',
    t.takeProfit ?? '',
    t.quantity,
    t.notionalUsd,
    t.grossPnlUsd,
    t.spreadCostUsd,
    t.slippageCostUsd,
    t.commissionUsd,
    t.netPnlUsd,
    t.returnPct,
    t.realizedR ?? '',
    t.mfePct,
    t.maePct,
    t.barsHeld,
    t.exitReason
  ]);

  const csv = [headers.map(csvEsc).join(','), ...rows.map((r) => r.map(csvEsc).join(','))].join(
    '\n'
  );
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = report.spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  a.download = `strategy-${slug}-trades.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
