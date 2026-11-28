import {
  DEFAULT_NOTIFICATIONS,
  deleteAlertById,
  formatAlertAutoMessage,
  formatConditionSummary,
  getAlertConditions,
  getAlertsSnapshot,
  isWatchlistAlert,
  upsertAlert,
  type AlertCondition,
  type TradingAlert
} from '../alerts/store';
import { CHART_LAYOUTS, type LayoutId } from '../chart/layouts';
import { loadNotes, saveNotes } from '../notes/api';
import { todayNairobiIso, type Note } from '../notes/types';
import {
  closePaperPosition,
  computeAccountMetrics,
  computePaperAnalytics,
  computePositionMetrics,
  getActivePaperAccount,
  getPaperLiveQuotesSnapshot,
  getPaperSnapshot,
  modifyPositionBrackets,
  placePaperOrder,
  pushOrderDraft
} from '../paper/store';
import { getPlaybookSnapshot } from '../playbook/store';
import { deployStrategyToPaper, getStrategySnapshot } from '../strategy/store';
import { appendPreTradeRule, loadTasksState, saveTasksState } from '../tasks/store';
import {
  createWatchlistItem,
  loadWatchlistState,
  normalizeSymbolInput,
  saveWatchlistState,
  type WatchlistGroup,
  type WatchlistState
} from '../watchlist/store';
import { makeWorkspaceId } from '../workspace/storage';
import type {
  AiApprovalCard,
  AiClientAction,
  AiExecutedActionRecord,
  AiWorkspacePaneSnapshot,
  AiWorkspaceSnapshot
} from './types';

export interface ChartDeskPatch {
  layoutId?: LayoutId;
  openInNewTab?: boolean;
  tabTitle?: string;
  panes: Array<{ paneIndex?: number; symbol: string; interval?: string }>;
}

export interface AgentHostCallbacks {
  getDeskSnapshot: () => {
    layoutId: LayoutId;
    activeTabTitle: string;
    panes: AiWorkspacePaneSnapshot[];
  };
  applyChartDesk: (patch: ChartDeskPatch) => () => void;
  openRailPanel: (
    panel: 'list' | 'calendar' | 'tasks' | 'note' | 'alerts' | 'screener' | 'news' | 'dislocation'
  ) => void;
}

const undoRegistry = new Map<string, () => Promise<void> | void>();

export function canUndoClientAction(actionId: string): boolean {
  return undoRegistry.has(actionId);
}

export async function undoClientAction(actionId: string): Promise<boolean> {
  const fn = undoRegistry.get(actionId);
  if (!fn) return false;
  undoRegistry.delete(actionId);
  await fn();
  return true;
}

function deepClone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

/**
 * Builds a compact, live snapshot of the user's entire DeplyzeWorkflow workstation
 * (tabs/panes, watchlists, active alerts, Paper Ledger positions & equity, Playbook edge stats,
 * unchecked pre-trade rules, and saved strategies) so the Agent can think & act with zero guesswork.
 */
export async function buildWorkspaceSnapshot(
  host?: AgentHostCallbacks
): Promise<AiWorkspaceSnapshot> {
  const desk = host?.getDeskSnapshot();
  const [wlState, tasksState] = await Promise.all([
    loadWatchlistState().catch(() => null),
    loadTasksState().catch(() => null)
  ]);

  const alertsState = getAlertsSnapshot();
  const paperState = getPaperSnapshot();
  const paperAcc = getActivePaperAccount(paperState);
  const paperQuotes = getPaperLiveQuotesSnapshot();
  const playbookState = getPlaybookSnapshot();
  const stratState = getStrategySnapshot();

  const watchlists = (wlState?.groups ?? []).slice(0, 8).map((g) => {
    const syms: string[] = [];
    for (const s of g.sections) {
      for (const it of s.items) {
        if (syms.length < 24) syms.push(it.shortName);
      }
    }
    return {
      id: g.id,
      name: g.name,
      symbols: syms
    };
  });

  const activeAlerts = alertsState.alerts
    .filter((a) => a.status === 'active' || a.status === 'paused')
    .slice(0, 20)
    .map((a) => {
      const conds = getAlertConditions(a);
      const summary =
        conds.length > 0
          ? conds.map((c) => formatConditionSummary(c, a.shortName, true)).join(` ${(a.logic ?? 'and').toUpperCase()} `)
          : a.message || `${a.shortName} alert`;
      return {
        id: a.id,
        symbol: a.symbol,
        shortName: a.shortName,
        scope: (isWatchlistAlert(a) ? 'watchlist' : 'symbol') as 'symbol' | 'watchlist',
        summary: summary.slice(0, 100),
        status: a.status
      };
    });

  const accMetrics = computeAccountMetrics(paperAcc, paperQuotes);
  const paperAnalytics =
    paperAcc.tradeHistory.length > 0 ? computePaperAnalytics(paperAcc) : null;
  const openPositions = paperAcc.positions.slice(0, 12).map((pos) => {
    const pm = computePositionMetrics(
      pos,
      paperQuotes,
      paperAcc.settings.leverage,
      paperAcc.settings.zeroSpread
    );
    return {
      id: pos.id,
      symbol: pos.symbol,
      shortName: pos.shortName,
      side: pos.side,
      quantity: pos.quantity,
      avgFillPrice: pos.avgFillPrice,
      takeProfit: pos.takeProfit,
      stopLoss: pos.stopLoss,
      unrealizedPnlUsd: Number(pm.unrealizedPnl.toFixed(2)),
      rMultiple: pm.liveR !== null ? Number(pm.liveR.toFixed(2)) : null
    };
  });

  // Compact Playbook edge breakdown
  const pbEntries = playbookState.entries;
  const resolved = pbEntries.filter((e) => e.outcome === 'Win' || e.outcome === 'Loss');
  const wins = resolved.filter((e) => e.outcome === 'Win').length;
  const rVals = pbEntries
    .map((e) => e.rMultiple)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const bySetupMap = new Map<string, { trades: number; wins: number; totalR: number }>();
  for (const e of pbEntries) {
    const key = e.setupType.trim() || 'General';
    const cur = bySetupMap.get(key) ?? { trades: 0, wins: 0, totalR: 0 };
    cur.trades += 1;
    if (e.outcome === 'Win') cur.wins += 1;
    if (typeof e.rMultiple === 'number' && Number.isFinite(e.rMultiple)) cur.totalR += e.rMultiple;
    bySetupMap.set(key, cur);
  }
  const bySetup = Array.from(bySetupMap.entries())
    .map(([setupType, s]) => ({
      setupType,
      trades: s.trades,
      winRatePct: s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0,
      totalR: Number(s.totalR.toFixed(2))
    }))
    .sort((a, b) => b.totalR - a.totalR)
    .slice(0, 5);

  const uncheckedPreTradeRules = (tasksState?.rules ?? [])
    .filter((r) => !r.checked)
    .map((r) => r.label)
    .slice(0, 8);

  const savedStrategies = stratState.strategies.slice(0, 8).map((s) => ({
    id: s.id,
    name: s.report.spec.name,
    symbol: s.report.spec.symbol,
    interval: s.report.spec.interval,
    verdictLabel: s.report.verdict.label
  }));

  return {
    layoutId: desk?.layoutId,
    activeTabTitle: desk?.activeTabTitle,
    panes: desk?.panes,
    watchlists,
    activeAlerts,
    paper: {
      connected: paperState.connected,
      accountName: paperAcc.name,
      balance: Number(paperAcc.balance.toFixed(2)),
      equity: Number(accMetrics.equity.toFixed(2)),
      freeMargin: Number(accMetrics.availableFunds.toFixed(2)),
      leverage: paperAcc.settings.leverage,
      openPositions,
      workingOrdersCount: paperAcc.orders.length,
      recentWinRatePct:
        paperAnalytics && paperAnalytics.totalTrades > 0 && paperAnalytics.winRatePct !== null
          ? Number(paperAnalytics.winRatePct.toFixed(1))
          : null,
      recentTradesCount: paperAcc.tradeHistory.length
    },
    playbookSummary:
      pbEntries.length > 0
        ? {
            totalEntries: pbEntries.length,
            winRatePct: resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : null,
            totalR: rVals.length > 0 ? Number(rVals.reduce((a, b) => a + b, 0).toFixed(2)) : null,
            bestSetup: bySetup[0]?.setupType ?? null,
            bySetup
          }
        : undefined,
    uncheckedPreTradeRules,
    savedStrategies
  };
}

/**
 * Executes a Tier-1 reversible workspace action and registers a 1-click Undo handler.
 */
export async function executeClientAction(
  action: AiClientAction,
  host?: AgentHostCallbacks
): Promise<AiExecutedActionRecord> {
  try {
    if (action.kind === 'configure_chart_desk') {
      if (!host) {
        return {
          id: action.id,
          kind: action.kind,
          label: action.label,
          detail: 'Chart desk host unavailable',
          status: 'failed',
          canUndo: false
        };
      }
      const validLayout =
        action.layoutId && CHART_LAYOUTS.some((l) => l.id === action.layoutId)
          ? (action.layoutId as LayoutId)
          : undefined;
      const undo = host.applyChartDesk({
        layoutId: validLayout,
        openInNewTab: action.openInNewTab,
        tabTitle: action.tabTitle,
        panes: action.panes
      });
      undoRegistry.set(action.id, undo);
      const paneList = action.panes
        .map((p) => `${normalizeSymbolInput(p.symbol).shortName}${p.interval ? ` ${p.interval}` : ''}`)
        .join(' · ');
      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: `${validLayout ? `${validLayout} · ` : ''}${paneList}`,
        status: 'executed',
        canUndo: true
      };
    }

    if (action.kind === 'manage_watchlist') {
      const prev = await loadWatchlistState();
      const prevSnapshot = deepClone(prev);
      const next: WatchlistState = deepClone(prev);

      let targetGroup: WatchlistGroup | undefined = next.groups.find(
        (g) => g.name.trim().toLowerCase() === action.groupName.trim().toLowerCase()
      );

      if (!targetGroup || action.mode === 'create_group') {
        if (!targetGroup) {
          targetGroup = {
            id: makeWorkspaceId('wl'),
            name: action.groupName.trim() || 'AI Focus',
            sections: [
              {
                id: makeWorkspaceId('sec'),
                name: action.sectionName || 'SETUPS',
                collapsed: false,
                items: []
              }
            ]
          };
          next.groups.push(targetGroup);
        }
        next.activeGroupId = targetGroup.id;
      }

      const secName = (action.sectionName || targetGroup.sections[0]?.name || 'SETUPS').toUpperCase();
      let targetSec = targetGroup.sections.find(
        (s) => s.name.trim().toUpperCase() === secName
      );
      if (!targetSec) {
        targetSec = {
          id: makeWorkspaceId('sec'),
          name: secName,
          collapsed: false,
          items: []
        };
        targetGroup.sections.unshift(targetSec);
      }

      let addedOrUpdated = 0;
      for (const reqItem of action.items) {
        const norm = normalizeSymbolInput(reqItem.symbol);
        let existingItem = undefined;
        for (const s of targetGroup.sections) {
          const hit = s.items.find((it) => it.shortName.toUpperCase() === norm.shortName.toUpperCase());
          if (hit) {
            existingItem = hit;
            break;
          }
        }

        if (existingItem) {
          if (reqItem.bias) existingItem.bias = reqItem.bias;
          if (reqItem.poiNote !== undefined) existingItem.poiNote = reqItem.poiNote;
          addedOrUpdated += 1;
        } else {
          const created = createWatchlistItem(norm.symbol);
          if (reqItem.bias) created.bias = reqItem.bias;
          if (reqItem.poiNote) created.poiNote = reqItem.poiNote;
          targetSec.items.push(created);
          addedOrUpdated += 1;
        }
      }

      await saveWatchlistState(next);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deplyze:watchlist-updated'));
      }
      undoRegistry.set(action.id, async () => {
        await saveWatchlistState(prevSnapshot);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('deplyze:watchlist-updated'));
        }
      });

      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: `${targetGroup.name} · ${addedOrUpdated} symbol${addedOrUpdated === 1 ? '' : 's'} updated`,
        status: 'executed',
        canUndo: true
      };
    }

    if (action.kind === 'create_alert') {
      const norm = normalizeSymbolInput(action.symbol);
      const alertId = makeWorkspaceId('al');
      const nowIso = new Date().toISOString();

      let watchlistGroupId: string | undefined;
      let watchlistGroupName: string | undefined;
      if (action.scope === 'watchlist') {
        const wl = await loadWatchlistState();
        const grp =
          wl.groups.find(
            (g) =>
              action.watchlistGroupName &&
              g.name.toLowerCase() === action.watchlistGroupName.toLowerCase()
          ) ?? wl.groups[0];
        if (grp) {
          watchlistGroupId = grp.id;
          watchlistGroupName = grp.name;
        }
      }

      const conditions: AlertCondition[] = action.conditions.map((c) => {
        const cNorm = c.symbol ? normalizeSymbolInput(c.symbol) : null;
        return {
          id: makeWorkspaceId('cond'),
          symbol: cNorm?.symbol,
          shortName: cNorm?.shortName,
          metric: c.metric,
          operator: c.operator,
          value: c.value,
          ratingTarget: c.ratingTarget
        };
      });

      const firstPriceCond = conditions.find((c) => c.metric === 'price' && typeof c.value === 'number');
      const autoMsg =
        action.message ||
        formatAlertAutoMessage({
          scope: watchlistGroupId ? 'watchlist' : 'symbol',
          shortName: watchlistGroupName || norm.shortName,
          watchlistGroupName,
          logic: action.logic ?? 'and',
          conditions
        });

      const alert: TradingAlert = {
        id: alertId,
        kind: 'price',
        scope: watchlistGroupId ? 'watchlist' : 'symbol',
        symbol: watchlistGroupId ?? norm.symbol,
        shortName: watchlistGroupName ?? norm.shortName,
        operator:
          firstPriceCond &&
          firstPriceCond.operator !== 'abs_gte' &&
          firstPriceCond.operator !== 'is_rating'
            ? firstPriceCond.operator
            : undefined,
        targetPrice: firstPriceCond?.value,
        watchlistGroupId,
        watchlistGroupName,
        watchlistTriggerMode: watchlistGroupId ? 'once_per_symbol' : undefined,
        logic: action.logic ?? 'and',
        conditions,
        trigger: action.trigger ?? 'once',
        expiresAt: null,
        message: autoMsg,
        status: 'active',
        notifications: { ...DEFAULT_NOTIFICATIONS },
        createdAt: nowIso
      };

      upsertAlert(alert);
      undoRegistry.set(action.id, () => deleteAlertById(alertId));

      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: autoMsg.slice(0, 90),
        status: 'executed',
        canUndo: true
      };
    }

    if (action.kind === 'update_alert') {
      const snap = getAlertsSnapshot();
      const target = snap.alerts.find((a) => a.id === action.alertId);
      if (!target) {
        return {
          id: action.id,
          kind: action.kind,
          label: action.label,
          detail: 'Alert no longer exists',
          status: 'failed',
          canUndo: false
        };
      }
      const prevCopy = deepClone(target);
      if (action.operation === 'delete') {
        deleteAlertById(target.id);
      } else if (action.operation === 'pause') {
        upsertAlert({ ...target, status: 'paused' });
      } else if (action.operation === 'resume') {
        upsertAlert({ ...target, status: 'active' });
      } else if (action.operation === 'update_price' && typeof action.newPrice === 'number') {
        const nextConds = getAlertConditions(target).map((c, i) =>
          i === 0 && c.metric === 'price' ? { ...c, value: action.newPrice } : c
        );
        upsertAlert({
          ...target,
          targetPrice: action.newPrice,
          conditions: nextConds,
          status: 'active'
        });
      }

      undoRegistry.set(action.id, () => upsertAlert(prevCopy));
      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: `${target.shortName} alert ${action.operation.replace('_', ' ')}`,
        status: 'executed',
        canUndo: true
      };
    }

    if (action.kind === 'create_note') {
      const notes = await loadNotes();
      const nowIso = new Date().toISOString();
      const noteId = makeWorkspaceId('note');
      const norm = action.symbol ? normalizeSymbolInput(action.symbol) : null;
      const newNote: Note = {
        id: noteId,
        title: action.title,
        body: action.body,
        date: todayNairobiIso(),
        symbol: norm?.shortName || '',
        fullSymbol: norm?.symbol || '',
        pinned: false,
        attachments: [],
        createdAt: nowIso,
        updatedAt: nowIso
      };
      await saveNotes([newNote, ...notes]);
      undoRegistry.set(action.id, async () => {
        const cur = await loadNotes();
        await saveNotes(cur.filter((n) => n.id !== noteId));
      });
      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: `Saved to Notes (${newNote.date})`,
        status: 'executed',
        canUndo: true
      };
    }

    if (action.kind === 'add_tasks') {
      const prev = await loadTasksState();
      const prevCopy = deepClone(prev);
      const nowIso = new Date().toISOString();
      const newTodos = action.tasks.map((t) => ({
        id: makeWorkspaceId('todo'),
        title: t.title,
        symbol: t.symbol,
        done: false,
        createdAt: nowIso
      }));
      await saveTasksState({
        ...prev,
        todos: [...newTodos, ...prev.todos]
      });
      if (action.preTradeRules && action.preTradeRules.length > 0) {
        for (const r of action.preTradeRules) {
          await appendPreTradeRule(r);
        }
      }
      undoRegistry.set(action.id, async () => {
        await saveTasksState(prevCopy);
      });
      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: `Added ${newTodos.length} task${newTodos.length === 1 ? '' : 's'}`,
        status: 'executed',
        canUndo: true
      };
    }

    if (action.kind === 'open_panel') {
      host?.openRailPanel(action.panel);
      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        detail: `Opened ${action.panel}`,
        status: 'executed',
        canUndo: false
      };
    }

    return {
      id: (action as { id: string }).id,
      kind: (action as { kind: AiClientAction['kind'] }).kind,
      label: 'Unknown action',
      detail: 'Unsupported action kind',
      status: 'failed',
      canUndo: false
    };
  } catch (err) {
    return {
      id: action.id,
      kind: action.kind,
      label: action.label,
      detail: err instanceof Error ? err.message : 'Action execution failed',
      status: 'failed',
      canUndo: false
    };
  }
}

/**
 * Executes a Tier-2 Human-Approved Risk/Capital/Bot Card ONLY after explicit user click.
 */
export function executeApprovalCard(
  card: AiApprovalCard,
  mode: 'stage' | 'execute'
): { ok: boolean; status: 'staged' | 'executed'; note: string } {
  if (card.kind === 'stage_paper_order') {
    const paper = getPaperSnapshot();
    if (!paper.connected) {
      return {
        ok: false,
        status: 'staged',
        note: 'Connect Paper Ledger first (top-right Trade pill) to stage or place orders.'
      };
    }

    if (mode === 'stage') {
      pushOrderDraft({
        symbol: card.symbol,
        shortName: card.shortName,
        side: card.side,
        type: card.orderType,
        price: card.orderType === 'market' ? null : card.entryPrice,
        quantity: card.suggestedQuantity,
        stopLoss: card.stopLoss,
        takeProfit: card.takeProfit,
        source: 'chart'
      });
      return {
        ok: true,
        status: 'staged',
        note: `Order Ticket staged for ${card.side.toUpperCase()} ${card.suggestedQuantity} ${card.shortName}`
      };
    }

    const res = placePaperOrder({
      symbol: card.symbol,
      shortName: card.shortName,
      side: card.side,
      type: card.orderType,
      quantity: card.suggestedQuantity,
      orderPrice: card.orderType === 'market' ? null : card.entryPrice,
      stopLoss: card.stopLoss,
      takeProfit: card.takeProfit,
      note: `AI Copilot: ${card.rationale}`
    });
    if (!res.ok) {
      return { ok: false, status: 'executed', note: res.error || 'Order rejected by Paper Ledger' };
    }
    return {
      ok: true,
      status: 'executed',
      note: `${card.orderType.toUpperCase()} ${card.side.toUpperCase()} ${card.suggestedQuantity} ${card.shortName} submitted`
    };
  }

  if (card.kind === 'protect_position') {
    const acc = getActivePaperAccount(getPaperSnapshot());
    const pos = acc.positions.find((p) => p.id === card.positionId);
    if (!pos) {
      return { ok: false, status: 'executed', note: 'Position is no longer open.' };
    }

    if (card.operation === 'modify_brackets') {
      const nextTp = card.newTakeProfit !== undefined ? card.newTakeProfit : pos.takeProfit;
      const nextSl = card.newStopLoss !== undefined ? card.newStopLoss : pos.stopLoss;
      const res = modifyPositionBrackets(pos.id, nextTp, nextSl);
      if (!res.ok) {
        return { ok: false, status: 'executed', note: res.error || 'Could not modify brackets' };
      }
      return {
        ok: true,
        status: 'executed',
        note: `Updated ${pos.shortName} brackets (SL: ${nextSl ?? '—'}, TP: ${nextTp ?? '—'})`
      };
    }

    const partialQty =
      card.operation === 'close_partial'
        ? Number((pos.quantity * (card.closeFraction ?? 0.5)).toFixed(4))
        : null;
    const res = closePaperPosition(pos.id, partialQty);
    if (!res.ok) {
      return { ok: false, status: 'executed', note: res.error || 'Could not close position' };
    }
    return {
      ok: true,
      status: 'executed',
      note:
        card.operation === 'close_partial'
          ? `Closed ${Math.round((card.closeFraction ?? 0.5) * 100)}% of ${pos.shortName}`
          : `Closed ${pos.shortName} position`
    };
  }

  if (card.kind === 'deploy_strategy_bot') {
    const res = deployStrategyToPaper(card.strategyId, {
      accountMode: 'dedicated',
      executionMode: card.executionMode === 'auto_sim' ? 'auto' : 'confirm',
      maxDailyLossPct: card.maxDailyLossPct
    });
    if (!res.ok) {
      return { ok: false, status: 'executed', note: res.error || 'Could not deploy strategy bot' };
    }
    return {
      ok: true,
      status: 'executed',
      note: `Deployed ${card.strategyName} (${card.executionMode === 'auto_sim' ? 'Auto SIM' : 'Notify'})`
    };
  }

  return { ok: false, status: 'executed', note: 'Unsupported approval card' };
}
