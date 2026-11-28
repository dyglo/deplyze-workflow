<script lang="ts">
  import { onMount } from 'svelte';
  import type { PendingRangeAnalysisRequest } from './ai/types';
  import AiPanel from './panels/AiPanel.svelte';
  import AlertsPanel from './panels/AlertsPanel.svelte';
  import CalendarPanel from './panels/CalendarPanel.svelte';
  import CreateAlertModal from './panels/CreateAlertModal.svelte';
  import DislocationPanel from './panels/DislocationPanel.svelte';
  import FavoritesPanel from './panels/FavoritesPanel.svelte';
  import LayoutPopover from './panels/LayoutPopover.svelte';
  import NewsFlowPanel from './panels/NewsFlowPanel.svelte';
  import NotesPanel from './panels/NotesPanel.svelte';
  import ScreenerPanel from './panels/ScreenerPanel.svelte';
  import SettingsModal from './panels/SettingsModal.svelte';
  import TasksPanel from './panels/TasksPanel.svelte';
  import WatchlistPanel from './panels/WatchlistPanel.svelte';
  import { upsertAlert, type TradingAlert } from './alerts/store';
  import { getLayoutById, type LayoutId } from './chart/layouts';
  import {
    fetchDislocationScan,
    loadDislocationState
  } from './dislocation/store';
  import type { InsightsViewId } from './insights/symbolInsightsApi';
  import type { ChartSettings } from './settings/chartSettings';
  import { loadWorkspaceJson, saveWorkspaceJson } from './workspace/storage';

  interface Props {
    theme: 'dark' | 'light';
    chartSettings: ChartSettings;
    layoutId: LayoutId;
    activeSymbol: string;
    activeFullSymbol: string;
    activeInterval?: string;
    activePrice?: number;
    activeChangePercent?: number;
    settingsOpen: boolean;
    onToggleSettings: () => void;
    onCloseSettings: () => void;
    onSaveChartSettings: (next: ChartSettings) => void;
    onSelectLayout: (next: LayoutId) => void;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onOpenSymbolInNewTab: (symbol: string, shortName: string) => void;
    onOpenOnChart: (symbol: string, shortName: string) => void;
    insightsOpen?: boolean;
    onOpenSymbolInsights: (
      symbol: string,
      shortName: string,
      description: string,
      view: InsightsViewId
    ) => void;
    onSelectInsightsSymbol: (symbol: string, shortName: string, description: string) => void;
    screenerFullscreen?: boolean;
    onToggleScreenerFullscreen?: () => void;
    onCloseScreenerFullscreen?: () => void;
    pendingRangeAnalysis?: PendingRangeAnalysisRequest | null;
    onConsumePendingRangeAnalysis?: () => void;
  }

  let {
    theme,
    chartSettings,
    layoutId,
    activeSymbol,
    activeFullSymbol,
    activeInterval = 'D',
    activePrice = undefined,
    activeChangePercent = undefined,
    settingsOpen,
    onToggleSettings,
    onCloseSettings,
    onSaveChartSettings,
    onSelectLayout,
    onSelectSymbol,
    onOpenSymbolInNewTab,
    onOpenOnChart,
    insightsOpen = false,
    onOpenSymbolInsights,
    onSelectInsightsSymbol,
    screenerFullscreen = false,
    onToggleScreenerFullscreen,
    onCloseScreenerFullscreen,
    pendingRangeAnalysis = null,
    onConsumePendingRangeAnalysis
  }: Props = $props();

  type RailId =
    | 'list'
    | 'calendar'
    | 'tasks'
    | 'note'
    | 'ai'
    | 'alerts'
    | 'screener'
    | 'favorites'
    | 'news'
    | 'dislocation';

  const VALID_RAIL_IDS: readonly RailId[] = [
    'list',
    'calendar',
    'tasks',
    'note',
    'ai',
    'alerts',
    'screener',
    'favorites',
    'news',
    'dislocation'
  ];
  const RAIL_STORAGE_KEY = 'deplyzeworkflow-rail';

  function parseRailId(raw: unknown): RailId | null {
    if (typeof raw !== 'string') return null;
    if (raw === 'routines') return 'screener';
    if (raw === 'cloud') return 'dislocation';
    return VALID_RAIL_IDS.includes(raw as RailId) ? (raw as RailId) : null;
  }

  function loadInitialRail(): RailId | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return parseRailId(localStorage.getItem(RAIL_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  let active = $state<RailId | null>(loadInitialRail());
  let layoutAnchor = $state<DOMRect | null>(null);
  let alertModalSeq = 0;
  let alertModalState = $state<{
    key: number;
    symbol: string;
    shortName: string;
    price?: number;
    watchlistGroupId?: string | null;
    editing: TradingAlert | null;
  } | null>(null);
  let screenerInitialWlGroupId = $state<string | null>(null);
  let radarWatchEnabled = $state(true);
  let radarReadyCount = $state(0);
  let radarTopSetupLabel = $state<string | null>(null);

  const activeLayoutDef = $derived(getLayoutById(layoutId));

  // Auto-open AI Copilot side-by-side whenever a chart range analysis request arrives
  $effect(() => {
    if (pendingRangeAnalysis) {
      layoutAnchor = null;
      onCloseScreenerFullscreen?.();
      if (active !== 'ai') {
        active = 'ai';
        persistRail('ai');
      }
    }
  });

  function persistRail(next: RailId | null) {
    if (typeof localStorage !== 'undefined') {
      try {
        if (next) {
          localStorage.setItem(RAIL_STORAGE_KEY, next);
        } else {
          localStorage.removeItem(RAIL_STORAGE_KEY);
        }
      } catch {
        // ignore
      }
    }
    void saveWorkspaceJson('rail', { active: next, updatedAt: Date.now() });
  }

  onMount(() => {
    const hasLocal =
      typeof localStorage !== 'undefined' && localStorage.getItem(RAIL_STORAGE_KEY) !== null;
    if (!hasLocal) {
      void loadWorkspaceJson<{ active?: string | null } | null>('rail', null).then((disk) => {
        if (!disk) return;
        const restored = parseRailId(disk.active);
        if (restored && active === null) {
          active = restored;
          try {
            localStorage.setItem(RAIL_STORAGE_KEY, restored);
          } catch {
            // ignore
          }
        }
      });
    }
    void loadDislocationState().then((st) => {
      radarWatchEnabled = st.watchAlertsEnabled;
    });
  });

  $effect(() => {
    if (!radarWatchEnabled) {
      radarReadyCount = 0;
      radarTopSetupLabel = null;
      return;
    }

    let cancelled = false;
    async function pollRadar() {
      try {
        const scan = await fetchDislocationScan('1h', { force: false });
        if (cancelled) return;
        const ready = scan.rows.filter(
          (r) =>
            r.convictionScore >= 65 &&
            !r.smtConflict &&
            r.eventRiskStatus !== 'locked' &&
            r.driverLinkStatus !== 'breaking'
        );
        radarReadyCount = ready.length;
        radarTopSetupLabel =
          ready.length > 0
            ? `${ready[0].shortName} (${ready[0].convictionScore}/100 · ${ready[0].verdictLabel})`
            : null;
      } catch {
        // silent background poll
      }
    }

    void pollRadar();
    const timer = setInterval(() => void pollRadar(), 120_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  });

  function openCreateAlertModal(
    symbol = activeFullSymbol || 'OANDA:XAUUSD',
    shortName = activeSymbol || 'XAUUSD',
    price = activePrice,
    editing: TradingAlert | null = null,
    watchlistGroupId: string | null = null
  ) {
    alertModalSeq += 1;
    alertModalState = { key: alertModalSeq, symbol, shortName, price, watchlistGroupId, editing };
  }

  function openWatchlistInScreener(groupId: string) {
    screenerInitialWlGroupId = groupId;
    active = 'screener';
    persistRail('screener');
  }

  function handleSaveAlert(saved: TradingAlert) {
    upsertAlert(saved);
  }

  function closeAlertModal() {
    alertModalState = null;
  }

  function select(id: RailId) {
    layoutAnchor = null;
    if (id !== 'screener') onCloseScreenerFullscreen?.();
    active = active === id ? null : id;
    if (active === null) onCloseScreenerFullscreen?.();
    persistRail(active);
  }

  function closePanel() {
    onCloseScreenerFullscreen?.();
    active = null;
    persistRail(null);
  }

  function toggleLayoutPopover(e: MouseEvent) {
    if (layoutAnchor) {
      layoutAnchor = null;
      return;
    }
    layoutAnchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
  }

  function toggleSettings() {
    layoutAnchor = null;
    onToggleSettings();
  }
</script>

{#if active === 'list'}
  <WatchlistPanel
    {theme}
    {activeSymbol}
    {activeFullSymbol}
    {activePrice}
    {activeChangePercent}
    {onSelectSymbol}
    {onOpenSymbolInNewTab}
    onOpenNotesForSymbol={() => {
      active = 'note';
      persistRail('note');
    }}
    onCreateAlertForSymbol={(sym, short, price) => openCreateAlertModal(sym, short, price, null)}
    onCreateWatchlistAlert={(groupId) =>
      openCreateAlertModal(activeFullSymbol, activeSymbol, activePrice, null, groupId)
    }
    {insightsOpen}
    {onOpenSymbolInsights}
    {onSelectInsightsSymbol}
    onClose={closePanel}
  />
{:else if active === 'calendar'}
  <CalendarPanel {theme} onClose={closePanel} />
{:else if active === 'tasks'}
  <TasksPanel
    {theme}
    {activeSymbol}
    {activeFullSymbol}
    {activePrice}
    onClose={closePanel}
  />
{:else if active === 'note'}
  <NotesPanel {theme} {activeSymbol} {activeFullSymbol} onClose={closePanel} />
{:else if active === 'ai'}
  <AiPanel
    {theme}
    {activeSymbol}
    {activeFullSymbol}
    {activeInterval}
    {activePrice}
    {activeChangePercent}
    {pendingRangeAnalysis}
    {onConsumePendingRangeAnalysis}
    onClose={closePanel}
  />
{:else if active === 'alerts'}
  <AlertsPanel
    {theme}
    onOpenCreateAlert={(editing) =>
      openCreateAlertModal(
        editing?.symbol ?? activeFullSymbol,
        editing?.shortName ?? activeSymbol,
        editing?.targetPrice ?? activePrice,
        editing ?? null
      )
    }
    {onSelectSymbol}
    onOpenWatchlistInScreener={openWatchlistInScreener}
    onClose={closePanel}
  />
{:else if active === 'screener' && !screenerFullscreen}
  <ScreenerPanel
    {theme}
    fullscreen={false}
    initialWatchlistGroupId={screenerInitialWlGroupId}
    onToggleFullscreen={() => onToggleScreenerFullscreen?.()}
    {onSelectSymbol}
    {onOpenSymbolInsights}
    onClose={closePanel}
  />
{:else if active === 'favorites'}
  <FavoritesPanel
    {theme}
    {activeSymbol}
    {activeFullSymbol}
    {onSelectSymbol}
    onClose={closePanel}
  />
{:else if active === 'news'}
  <NewsFlowPanel
    {theme}
    {activeSymbol}
    {activeFullSymbol}
    {activePrice}
    {activeChangePercent}
    {onOpenOnChart}
    onClose={closePanel}
  />
{:else if active === 'dislocation'}
  <DislocationPanel
    {theme}
    {activeSymbol}
    {activeFullSymbol}
    {onSelectSymbol}
    onCreateAlertAtPrice={(sym, short, price) => openCreateAlertModal(sym, short, price, null)}
    onWatchChange={(enabled) => (radarWatchEnabled = enabled)}
    onClose={closePanel}
  />
{/if}

{#if alertModalState}
  {#key alertModalState.key}
    <CreateAlertModal
      {theme}
      initialSymbol={alertModalState.symbol}
      initialShortName={alertModalState.shortName}
      initialPrice={alertModalState.price}
      initialWatchlistGroupId={alertModalState.watchlistGroupId ?? null}
      editingAlert={alertModalState.editing}
      onSave={handleSaveAlert}
      onClose={closeAlertModal}
    />
  {/key}
{/if}

{#if layoutAnchor}
  <LayoutPopover
    {theme}
    activeLayout={layoutId}
    anchorRect={layoutAnchor}
    onSelect={onSelectLayout}
    onClose={() => (layoutAnchor = null)}
  />
{/if}

{#if settingsOpen}
  <SettingsModal
    {theme}
    settings={chartSettings}
    onSave={onSaveChartSettings}
    onClose={onCloseSettings}
  />
{/if}

<nav class="rail" class:light={theme === 'light'} aria-label="Workspace rail">
  <button
    class="rail-button"
    class:active={active === 'list'}
    type="button"
    aria-label="Lists"
    title="Lists"
    aria-pressed={active === 'list'}
    onclick={() => select('list')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" />
      <path d="M7.25 5.5h9.25M7.25 10h9.25M7.25 14.5h9.25" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'calendar'}
    type="button"
    aria-label="Calendar"
    title="Calendar"
    aria-pressed={active === 'calendar'}
    onclick={() => select('calendar')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3.75" />
      <path d="M2.75 7.25h14.5" />
      <path d="M8.75 10.75h.01M11.25 10.75h.01M13.75 10.75h.01M6.25 13.75h.01M8.75 13.75h.01" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'tasks'}
    type="button"
    aria-label="Tasks"
    title="Tasks"
    aria-pressed={active === 'tasks'}
    onclick={() => select('tasks')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3.75" />
      <path d="M6.75 10.35 9 12.6l4.25-4.85" />
    </svg>
  </button>

  <div class="rail-spacer" aria-hidden="true"></div>

  <button
    class="rail-button"
    class:active={active === 'note'}
    type="button"
    aria-label="Note"
    title="Note"
    aria-pressed={active === 'note'}
    onclick={() => select('note')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.75 6h5.5M4.25 9.25h2.75" />
      <path d="M13.7 4.6a2 2 0 0 1 2.8 2.8l-7.1 7.1-3.75.95.95-3.75Z" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'ai'}
    type="button"
    aria-label="AI"
    title="AI"
    aria-pressed={active === 'ai'}
    onclick={() => select('ai')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.75c.65 4.2 3.05 6.6 7.25 7.25-4.2.65-6.6 3.05-7.25 7.25-.65-4.2-3.05-6.6-7.25-7.25 4.2-.65 6.6-3.05 7.25-7.25Z" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'alerts'}
    type="button"
    aria-label="Alerts"
    title="Alerts"
    aria-pressed={active === 'alerts'}
    onclick={() => select('alerts')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="15" cy="5" r="2.25" />
      <path d="M10.25 3.75h-4a3.5 3.5 0 0 0-3.5 3.5v6.5a3.5 3.5 0 0 0 3.5 3.5h6.5a3.5 3.5 0 0 0 3.5-3.5v-4" />
      <path d="M6.5 13.5h5.5" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'screener'}
    type="button"
    aria-label="Screener & Heatmap"
    title="Screener & Heatmap"
    aria-pressed={active === 'screener'}
    onclick={() => select('screener')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.75" />
      <path d="M6.25 7.5h4.5M6.25 10.5h7.5M6.25 13.5h5.5" />
      <circle cx="13.5" cy="7.5" r="1.25" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'favorites'}
    type="button"
    aria-label="Favorites"
    title="Favorites"
    aria-pressed={active === 'favorites'}
    onclick={() => select('favorites')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.75 15.25s-5-3.1-5-6.6a3 3 0 0 1 5-2.2 3 3 0 0 1 5 2.2c0 3.5-5 6.6-5 6.6Z" />
      <path d="M15.85 7.5h.01" />
      <path d="M15.85 11.15 17.1 12.4l-1.25 1.25-1.25-1.25Z" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={active === 'news'}
    type="button"
    aria-label="News Flow"
    title="News Flow"
    aria-pressed={active === 'news'}
    onclick={() => select('news')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M9.9 17.25H4.5a1.5 1.5 0 0 1-1.5-1.5V4.25a1.5 1.5 0 0 1 1.5-1.5h9.75a1.5 1.5 0 0 1 1.5 1.5V9.2" />
      <rect x="5.5" y="5.5" width="3.5" height="3.5" rx="0.5" />
      <path d="M11.25 6.75h2.25" />
      <path d="M5.5 12h3.75" />
      <circle cx="14.25" cy="14.25" r="3.4" />
      <path d="M14.25 14.25 15.7 12.8" />
    </svg>
  </button>

  <button
    class="rail-button"
    class:active={Boolean(layoutAnchor)}
    type="button"
    data-layout-trigger="true"
    aria-label="Chart layout"
    title="Chart layout"
    aria-haspopup="dialog"
    aria-expanded={Boolean(layoutAnchor)}
    onclick={toggleLayoutPopover}
  >
    <svg viewBox="0 0 20 16" aria-hidden="true">
      <rect x="2" y="2" width="16" height="12" rx="2.5" />
      {#if activeLayoutDef.iconDividers}
        <path d={activeLayoutDef.iconDividers} />
      {/if}
    </svg>
  </button>

  <button
    class="rail-button radar-rail-btn"
    class:active={active === 'dislocation'}
    type="button"
    aria-label="Intermarket Radar"
    title={radarReadyCount > 0 && radarTopSetupLabel
      ? `Intermarket Radar — ${radarReadyCount} setup${radarReadyCount === 1 ? '' : 's'} ready: ${radarTopSetupLabel}`
      : 'Intermarket Radar'}
    aria-pressed={active === 'dislocation'}
    onclick={() => select('dislocation')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.75 13.5c2.4 0 3.6-4.75 6.25-4.75 2.5 0 3.6-4.25 8.25-4.25" />
      <path d="M2.75 6.5c2.4 0 3.6 4.75 6.25 4.75 2.5 0 3.6 4.25 8.25 4.25" />
      <circle cx="9" cy="10" r="1.5" />
    </svg>
    {#if radarReadyCount > 0}
      <span class="radar-alert-dot" aria-hidden="true"></span>
    {/if}
  </button>

  <button
    class="rail-button"
    class:active={settingsOpen}
    type="button"
    aria-label="Settings"
    title="Settings"
    aria-pressed={settingsOpen}
    onclick={toggleSettings}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.2 4h5.6a1.5 1.5 0 0 1 1.3.75l2.8 4.5a1.5 1.5 0 0 1 0 1.5l-2.8 4.5a1.5 1.5 0 0 1-1.3.75H7.2a1.5 1.5 0 0 1-1.3-.75l-2.8-4.5a1.5 1.5 0 0 1 0-1.5l2.8-4.5A1.5 1.5 0 0 1 7.2 4Z" />
      <circle cx="10" cy="10" r="2.6" />
    </svg>
  </button>
</nav>

<style>
  .rail {
    width: 48px;
    flex: 0 0 48px;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    overflow-y: auto;
    scrollbar-width: none;
    color: var(--dark-text-strong);
    background: var(--dark-bg-base);
    border-left: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    user-select: none;
    transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
  }

  .rail::-webkit-scrollbar {
    display: none;
  }

  .rail.light {
    color: #111111;
    background: #ffffff;
  }

  .rail-spacer {
    flex: 1 0 16px;
  }

  .rail-button {
    width: 40px;
    height: 40px;
    flex: 0 0 40px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 10px;
    color: inherit;
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .rail-button.active {
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  .rail.light .rail-button.active {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  .rail-button:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -3px;
  }

  .rail-button svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.5;
    transition: opacity 150ms ease;
  }

  .rail-button:hover svg {
    opacity: 0.8;
  }

  .rail-button.active svg {
    opacity: 1;
  }

  .radar-rail-btn {
    position: relative;
  }

  .radar-alert-dot {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #089981;
    box-shadow: 0 0 0 2px var(--dark-bg-base);
  }

  .rail.light .radar-alert-dot {
    box-shadow: 0 0 0 2px #ffffff;
  }
</style>
