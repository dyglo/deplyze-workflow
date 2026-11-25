<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    clearAlertLog,
    deleteAlertById,
    formatAlertAutoMessage,
    getAlertConditions,
    isMultiConditionAlert,
    isWatchlistAlert,
    pauseAllAlerts,
    resetWatchlistAlertMatches,
    resumeAllAlerts,
    subscribeAlertProgress,
    subscribeAlerts,
    togglePauseAlert,
    type AlertLiveProgress,
    type AlertsState,
    type TradingAlert
  } from '../alerts/store';

  interface Props {
    theme: 'dark' | 'light';
    onOpenCreateAlert: (editing?: TradingAlert | null) => void;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onOpenWatchlistInScreener?: (watchlistGroupId: string) => void;
    onClose: () => void;
  }

  let {
    theme,
    onOpenCreateAlert,
    onSelectSymbol,
    onOpenWatchlistInScreener,
    onClose
  }: Props = $props();

  type TabId = 'alerts' | 'log';

  let activeTab = $state<TabId>('alerts');
  let alertsState = $state<AlertsState>({ alerts: [], log: [] });
  let progressMap = $state<Record<string, AlertLiveProgress>>({});
  let searchOpen = $state(false);
  let searchQuery = $state('');
  let sortMode = $state<'status' | 'newest'>('status');
  let moreMenuOpen = $state(false);
  let pendingDelete = $state<TradingAlert | null>(null);

  const visibleAlerts = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = alertsState.alerts.slice();
    if (q) {
      list = list.filter(
        (a) =>
          a.shortName.toLowerCase().includes(q) ||
          (a.watchlistGroupName ?? '').toLowerCase().includes(q) ||
          a.message.toLowerCase().includes(q) ||
          (a.eventTitle ?? '').toLowerCase().includes(q)
      );
    }
    if (sortMode === 'status') {
      const rank: Record<string, number> = { active: 0, paused: 1, triggered: 2, expired: 3 };
      list.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    } else {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  });

  const visibleLog = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return alertsState.log;
    return alertsState.log.filter(
      (l) =>
        l.shortName.toLowerCase().includes(q) ||
        l.title.toLowerCase().includes(q) ||
        l.message.toLowerCase().includes(q) ||
        (l.detail ?? '').toLowerCase().includes(q)
    );
  });

  onMount(() => {
    const unsub = subscribeAlerts((s) => {
      alertsState = s;
    });
    const unsubProg = subscribeAlertProgress((p) => {
      progressMap = p;
    });
    const onDocDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (moreMenuOpen && (!el || !el.closest?.('[data-al-more]'))) {
        moreMenuOpen = false;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pendingDelete) {
          pendingDelete = null;
        } else if (moreMenuOpen) {
          moreMenuOpen = false;
        }
      }
    };
    window.addEventListener('pointerdown', onDocDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unsub();
      unsubProg();
      window.removeEventListener('pointerdown', onDocDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  function alertHeadline(a: TradingAlert): string {
    if (a.kind === 'news') {
      return a.eventTitle || a.message;
    }
    if (a.message) return a.message;
    return formatAlertAutoMessage({
      scope: isWatchlistAlert(a) ? 'watchlist' : 'symbol',
      shortName: a.shortName,
      watchlistGroupName: a.watchlistGroupName,
      logic: a.logic === 'or' ? 'or' : 'and',
      conditions: getAlertConditions(a)
    });
  }

  function statusLabel(status: TradingAlert['status']): string {
    if (status === 'active') return 'Active';
    if (status === 'paused') return 'Paused';
    if (status === 'triggered') return 'Triggered';
    return 'Expired';
  }

  function formatStamp(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(iso));
    } catch {
      return '';
    }
  }

  function handleAlertRowClick(alert: TradingAlert) {
    if (alert.kind === 'news') return;
    if (isWatchlistAlert(alert)) {
      if (alert.watchlistGroupId && onOpenWatchlistInScreener) {
        onOpenWatchlistInScreener(alert.watchlistGroupId);
      }
      return;
    }
    onSelectSymbol(alert.symbol, alert.shortName);
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    deleteAlertById(pendingDelete.id);
    pendingDelete = null;
  }
</script>

<PanelShell {theme} title="Alerts" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="15" cy="5" r="2.25" />
      <path d="M10.25 3.75h-4a3.5 3.5 0 0 0-3.5 3.5v6.5a3.5 3.5 0 0 0 3.5 3.5h6.5a3.5 3.5 0 0 0 3.5-3.5v-4" />
      <path d="M6.5 13.5h5.5" />
    </svg>
  {/snippet}

  <div class="alerts-panel" class:light={theme === 'light'}>
    <div class="tab-bar" role="tablist">
      <button
        class="seg-tab"
        class:active={activeTab === 'alerts'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'alerts'}
        onclick={() => (activeTab = 'alerts')}
      >
        Alerts
      </button>
      <button
        class="seg-tab"
        class:active={activeTab === 'log'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'log'}
        onclick={() => (activeTab = 'log')}
      >
        Log
      </button>
    </div>

    <div class="al-toolbar">
      <button
        class="tool-btn"
        type="button"
        title="Create alert"
        aria-label="Create alert"
        onclick={() => onOpenCreateAlert(null)}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M9 3.5v11M3.5 9h11" />
        </svg>
      </button>

      <div class="toolbar-right">
        <button
          class="tool-btn"
          class:active={searchOpen}
          type="button"
          title="Search alerts"
          aria-label="Search alerts"
          onclick={() => {
            searchOpen = !searchOpen;
            if (!searchOpen) searchQuery = '';
          }}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="8" cy="8" r="4.75" />
            <path d="m11.6 11.6 3.15 3.15" />
          </svg>
        </button>

        <button
          class="tool-btn"
          type="button"
          title={sortMode === 'status' ? 'Sorted by status (click for newest)' : 'Sorted by newest (click for status)'}
          aria-label="Sort alerts"
          onclick={() => (sortMode = sortMode === 'status' ? 'newest' : 'status')}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M5.5 4v10m0 0-2-2m2 2 2-2M10.5 5.5h4.5M10.5 9h3.5M10.5 12.5h2.25" />
          </svg>
        </button>

        <div class="more-wrap" data-al-more>
          <button
            class="tool-btn"
            type="button"
            title="More options"
            aria-label="More options"
            onclick={() => (moreMenuOpen = !moreMenuOpen)}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="4.5" cy="9" r="1.15" fill="currentColor" stroke="none" />
              <circle cx="9" cy="9" r="1.15" fill="currentColor" stroke="none" />
              <circle cx="13.5" cy="9" r="1.15" fill="currentColor" stroke="none" />
            </svg>
          </button>

          {#if moreMenuOpen}
            <div class="al-popover">
              <button
                class="pop-item"
                type="button"
                onclick={() => {
                  pauseAllAlerts();
                  moreMenuOpen = false;
                }}
              >
                Pause all alerts
              </button>
              <button
                class="pop-item"
                type="button"
                onclick={() => {
                  resumeAllAlerts();
                  moreMenuOpen = false;
                }}
              >
                Resume paused alerts
              </button>
              <div class="pop-div"></div>
              <button
                class="pop-item"
                type="button"
                onclick={() => {
                  clearAlertLog();
                  moreMenuOpen = false;
                }}
              >
                Clear log
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>

    {#if searchOpen}
      <div class="search-bar">
        <input
          type="text"
          placeholder="Filter by symbol, watchlist, or message..."
          bind:value={searchQuery}
        />
      </div>
    {/if}

    <div class="al-body">
      {#if activeTab === 'alerts'}
        {#if visibleAlerts.length === 0}
          <div class="empty-stage">
            <svg class="empty-clock" viewBox="0 0 48 48" aria-hidden="true">
              <path d="M12.5 9.5 8 14M35.5 9.5 40 14" />
              <path d="M35.6 25A13 13 0 1 0 24 38" />
              <path d="M24 18v7l4.5 2.5" />
              <path d="M35 30v10M30 35h10" />
            </svg>
            <p class="empty-copy">
              Alerts notify you on price levels, multi-condition setups, or across an entire watchlist.
            </p>
            <button class="empty-cta" type="button" onclick={() => onOpenCreateAlert(null)}>
              Create alert
            </button>
          </div>
        {:else}
          <div class="alert-list">
            {#each visibleAlerts as alert (alert.id)}
              {@const wlRule = isWatchlistAlert(alert)}
              {@const multiRule = isMultiConditionAlert(alert)}
              {@const conds = getAlertConditions(alert)}
              {@const prog = progressMap[alert.id]}
              {@const matchedCount = Object.keys(alert.triggeredSymbols ?? {}).length}
              <div
                class="alert-row"
                role="button"
                tabindex="0"
                title={wlRule
                  ? `Watchlist rule on ${alert.watchlistGroupName ?? alert.shortName} · Click to view in Screener`
                  : alert.kind === 'price'
                    ? `${alert.symbol} · Created ${formatStamp(alert.createdAt)}`
                    : `Calendar alert · ${alert.leadMinutes ?? 15}m before release`}
                onclick={() => handleAlertRowClick(alert)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') handleAlertRowClick(alert);
                }}
              >
                <div class="alert-main">
                  <div class="alert-title">{alertHeadline(alert)}</div>
                  <div class="alert-meta">
                    {#if alert.kind === 'news'}
                      <span class="al-badge news">N</span>
                    {:else if wlRule}
                      <span class="al-badge wl" aria-hidden="true">
                        <svg viewBox="0 0 16 16">
                          <path d="M3 4.5h10M3 8h10M3 11.5h6.5" />
                        </svg>
                      </span>
                    {:else}
                      <SymbolIcon symbol={alert.shortName} size={16} />
                    {/if}

                    <span class="al-sym">
                      {#if alert.kind === 'news'}
                        {alert.eventCountry ?? 'News'} · {alert.leadMinutes ?? 15}m before
                      {:else if wlRule}
                        {alert.watchlistGroupName ?? alert.shortName}{prog?.memberCount ? ` (${prog.memberCount})` : ''}
                      {:else}
                        {alert.shortName}
                      {/if}
                    </span>

                    {#if wlRule && matchedCount > 0}
                      <span class="dot">·</span>
                      <span class="meta-pill armed">{matchedCount} matched</span>
                    {:else if multiRule && alert.status === 'active' && prog && alert.logic !== 'or'}
                      <span class="dot">·</span>
                      <span class="meta-pill" class:armed={prog.met > 0}>
                        {prog.met}/{prog.total} met
                      </span>
                    {:else if multiRule}
                      <span class="dot">·</span>
                      <span class="meta-pill">{conds.length} {alert.logic === 'or' ? 'OR' : 'AND'}</span>
                    {/if}

                    <span class="dot">·</span>
                    <span
                      class="al-status"
                      class:active={alert.status === 'active'}
                      class:triggered={alert.status === 'triggered'}
                    >
                      {statusLabel(alert.status)}
                    </span>
                  </div>
                </div>

                <div class="alert-actions">
                  {#if wlRule && matchedCount > 0}
                    <button
                      class="row-icon"
                      type="button"
                      title="Reset matched symbols"
                      onclick={(e) => {
                        e.stopPropagation();
                        resetWatchlistAlertMatches(alert.id);
                      }}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M13 8a5 5 0 1 1-1.35-3.4" />
                        <path d="M13 3.2v2.6h-2.6" />
                      </svg>
                    </button>
                  {/if}

                  {#if alert.status === 'active' || alert.status === 'paused' || (alert.kind === 'price' && alert.status === 'triggered')}
                    <button
                      class="row-icon"
                      type="button"
                      title={alert.status === 'active'
                        ? 'Pause alert'
                        : alert.status === 'triggered'
                          ? 'Restart alert'
                          : 'Resume alert'}
                      onclick={(e) => {
                        e.stopPropagation();
                        togglePauseAlert(alert.id);
                      }}
                    >
                      {#if alert.status === 'active'}
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="6" />
                          <path d="M6.5 5.75v4.5M9.5 5.75v4.5" />
                        </svg>
                      {:else}
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="6" />
                          <path d="m6.75 5.5 4 2.5-4 2.5v-5Z" fill="currentColor" stroke="none" />
                        </svg>
                      {/if}
                    </button>
                  {/if}

                  {#if alert.kind === 'price'}
                    <button
                      class="row-icon"
                      type="button"
                      title="Edit alert"
                      onclick={(e) => {
                        e.stopPropagation();
                        onOpenCreateAlert(alert);
                      }}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M6 3.5h4a1.2 1.2 0 0 1 1 .6l2 3.3a1.2 1.2 0 0 1 0 1.2l-2 3.3a1.2 1.2 0 0 1-1 .6H6a1.2 1.2 0 0 1-1-.6L3 8.6a1.2 1.2 0 0 1 0-1.2l2-3.3a1.2 1.2 0 0 1 1-.6Z" />
                        <circle cx="8" cy="8" r="2" />
                      </svg>
                    </button>
                  {/if}

                  <button
                    class="row-icon del"
                    type="button"
                    title="Delete alert"
                    onclick={(e) => {
                      e.stopPropagation();
                      pendingDelete = alert;
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 4.5h9M6 4.5V3.25h4V4.5M5 4.5l.5 8h5l.5-8" />
                    </svg>
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        {#if visibleLog.length === 0}
          <div class="empty-log">No triggered alerts yet</div>
        {:else}
          <div class="alert-list">
            {#each visibleLog as entry (entry.id)}
              <div
                class="log-row"
                class:clickable={entry.kind === 'price'}
                role="button"
                tabindex="0"
                title={entry.kind === 'price' ? `Click to load ${entry.shortName} on chart` : ''}
                onclick={() => {
                  if (entry.kind === 'price') {
                    onSelectSymbol(entry.symbol, entry.shortName);
                  }
                }}
                onkeydown={(e) => {
                  if (e.key === 'Enter' && entry.kind === 'price') {
                    onSelectSymbol(entry.symbol, entry.shortName);
                  }
                }}
              >
                <div class="log-top">
                  <span class="log-title">
                    {entry.title}
                    {#if entry.missedWhileClosed}
                      <span class="closed-tag">While closed</span>
                    {/if}
                  </span>
                  <span class="log-time">{formatStamp(entry.triggeredAt)}</span>
                </div>
                <div class="log-msg">{entry.detail || entry.message}</div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</PanelShell>

{#if pendingDelete}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="confirm-backdrop"
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) pendingDelete = null;
    }}
  >
    <div class="confirm-modal" class:light={theme === 'light'} role="alertdialog" aria-modal="true">
      <div class="confirm-head">
        <h3>Delete this alert?</h3>
        <button class="close-x" type="button" onclick={() => (pendingDelete = null)}>×</button>
      </div>
      <p class="confirm-copy">
        Doing this will permanently delete your "{alertHeadline(pendingDelete)}" alert.
      </p>
      <div class="confirm-foot">
        <button class="btn-cancel" type="button" onclick={() => (pendingDelete = null)}>
          Cancel
        </button>
        <button class="btn-danger" type="button" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .alerts-panel {
    --al-bg: var(--dark-bg-panel);
    --al-surface: var(--dark-bg-surface-alt);
    --al-border: var(--dark-border);
    --al-border-soft: var(--dark-border-subtle);
    --al-text: var(--dark-text-primary);
    --al-secondary: var(--dark-text-secondary);
    --al-hover: var(--dark-hover);
    --al-tab-bg: var(--dark-bg-surface-alt);
    --al-tab-active: var(--dark-bg-active);
    --al-cta-bg: var(--dark-cta-bg);
    --al-cta-fg: var(--dark-cta-fg);
    --al-popover-bg: var(--dark-bg-glass);
    --al-popover-shadow: var(--dark-shadow-popover);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--al-text);
    background: var(--al-bg);
  }

  .alerts-panel.light {
    --al-bg: #ffffff;
    --al-surface: #f5f6f8;
    --al-border: #e0e3eb;
    --al-border-soft: #f0f2f5;
    --al-text: #131722;
    --al-secondary: #6a6d78;
    --al-hover: rgba(0, 0, 0, 0.03);
    --al-tab-bg: #f2f3f5;
    --al-tab-active: #ffffff;
    --al-cta-bg: #131722;
    --al-cta-fg: #ffffff;
    --al-popover-bg: #ffffff;
    --al-popover-shadow: 0 10px 26px rgba(19, 23, 34, 0.14);
  }

  .tab-bar {
    margin: 4px 14px 8px;
    padding: 3px;
    border-radius: 9px;
    background: var(--al-tab-bg);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
    flex: 0 0 auto;
    user-select: none;
  }

  .seg-tab {
    height: 30px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--al-secondary);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .seg-tab.active {
    background: var(--al-tab-active);
    color: var(--al-text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  .al-toolbar {
    height: 34px;
    padding: 0 12px;
    border-bottom: 1px solid var(--al-border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 34px;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .tool-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--al-text);
    background: transparent;
    cursor: pointer;
  }

  .tool-btn:hover,
  .tool-btn.active {
    background: var(--al-hover);
  }

  .tool-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.55;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .more-wrap {
    position: relative;
  }

  .al-popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 170px;
    padding: 5px;
    border-radius: 10px;
    border: 1px solid var(--al-border);
    background: var(--al-popover-bg);
    box-shadow: var(--al-popover-shadow);
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
    z-index: 25;
  }

  .pop-item {
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    text-align: left;
    color: var(--al-text);
    background: transparent;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .pop-item:hover {
    background: var(--al-hover);
  }

  .pop-div {
    height: 1px;
    margin: 4px;
    background: var(--al-border-soft);
  }

  .search-bar {
    padding: 8px 14px 6px;
    border-bottom: 1px solid var(--al-border-soft);
  }

  .search-bar input {
    width: 100%;
    box-sizing: border-box;
    height: 30px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--al-border);
    background: var(--al-surface);
    color: var(--al-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .al-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .al-body::-webkit-scrollbar {
    display: none;
  }

  .empty-stage {
    height: 100%;
    min-height: 300px;
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 14px;
  }

  .empty-clock {
    width: 52px;
    height: 52px;
    fill: none;
    stroke: var(--al-text);
    stroke-width: 2.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .empty-copy {
    margin: 0;
    max-width: 250px;
    font-size: 13px;
    line-height: 1.48;
    color: var(--al-text);
  }

  .empty-cta {
    height: 36px;
    padding: 0 18px;
    border: 0;
    border-radius: 8px;
    background: var(--al-cta-bg);
    color: var(--al-cta-fg);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .empty-log {
    padding: 56px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--al-secondary);
  }

  .alert-list {
    display: flex;
    flex-direction: column;
  }

  .alert-row {
    padding: 11px 14px;
    border-bottom: 1px solid var(--al-border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .alert-row:hover {
    background: var(--al-hover);
  }

  .alert-main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .alert-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--al-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .alert-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--al-secondary);
    flex-wrap: nowrap;
    min-width: 0;
  }

  .al-badge {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    color: #fff;
    background: #2962ff;
    font-size: 8px;
    font-weight: 700;
    display: grid;
    place-items: center;
    flex: 0 0 16px;
  }

  .al-badge.wl {
    border-radius: 4px;
    background: rgba(41, 98, 255, 0.16);
    color: #2962ff;
  }

  .al-badge.wl svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }

  .al-sym {
    font-weight: 600;
    color: var(--al-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta-pill {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--al-secondary);
    white-space: nowrap;
  }

  .meta-pill.armed {
    color: #089981;
  }

  .al-status {
    white-space: nowrap;
  }

  .al-status.active {
    color: #089981;
    font-weight: 500;
  }

  .al-status.triggered {
    color: #f59e0b;
    font-weight: 500;
  }

  .alert-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 120ms ease;
    flex: 0 0 auto;
  }

  .alert-row:hover .alert-actions,
  .alert-row:focus-within .alert-actions {
    opacity: 1;
  }

  .row-icon {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--al-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .row-icon:hover {
    color: var(--al-text);
    background: var(--al-hover);
  }

  .row-icon.del:hover {
    color: #f23645;
  }

  .row-icon svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Log rows */
  .log-row {
    padding: 10px 14px;
    border-bottom: 1px solid var(--al-border-soft);
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: background-color 110ms ease;
  }

  .log-row.clickable {
    cursor: pointer;
  }

  .log-row.clickable:hover {
    background: var(--al-hover);
  }

  .log-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .log-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--al-text);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .closed-tag {
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.16);
    color: #f59e0b;
    font-size: 10px;
    font-weight: 600;
  }

  .log-time {
    font-size: 11px;
    color: var(--al-secondary);
    white-space: nowrap;
  }

  .log-msg {
    font-size: 12px;
    color: var(--al-secondary);
    line-height: 1.35;
  }

  /* Delete confirmation modal */
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 120;
    background: rgba(0, 0, 0, 0.35);
    display: grid;
    place-items: center;
  }

  .confirm-modal {
    width: 390px;
    max-width: calc(100vw - 32px);
    padding: 20px;
    border-radius: 12px;
    color: var(--dark-text-strong);
    background: var(--dark-bg-glass);
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
    box-shadow: var(--dark-shadow-modal);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .confirm-modal.light {
    color: #131722;
    background: #ffffff;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.18);
  }

  .confirm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .confirm-head h3 {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
  }

  .close-x {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
  }

  .confirm-copy {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.45;
    opacity: 0.85;
  }

  .confirm-foot {
    margin-top: 4px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-cancel {
    height: 34px;
    padding: 0 15px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .confirm-modal.light .btn-cancel {
    border-color: #d8dce6;
  }

  .btn-danger {
    height: 34px;
    padding: 0 16px;
    border: 0;
    border-radius: 8px;
    background: #f23645;
    color: #ffffff;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
</style>
