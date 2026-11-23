<script lang="ts">
  import AiPanel from './panels/AiPanel.svelte';
  import AlertsPanel from './panels/AlertsPanel.svelte';
  import CalendarPanel from './panels/CalendarPanel.svelte';
  import CreateAlertModal from './panels/CreateAlertModal.svelte';
  import LayoutPopover from './panels/LayoutPopover.svelte';
  import NotesPanel from './panels/NotesPanel.svelte';
  import SettingsModal from './panels/SettingsModal.svelte';
  import TasksPanel from './panels/TasksPanel.svelte';
  import TrashPanel from './panels/TrashPanel.svelte';
  import WatchlistPanel from './panels/WatchlistPanel.svelte';
  import { upsertAlert, type TradingAlert } from './alerts/store';
  import { getLayoutById, type LayoutId } from './chart/layouts';
  import type { ChartSettings } from './settings/chartSettings';

  interface Props {
    theme: 'dark' | 'light';
    chartSettings: ChartSettings;
    layoutId: LayoutId;
    activeSymbol: string;
    activeFullSymbol: string;
    activePrice?: number;
    activeChangePercent?: number;
    settingsOpen: boolean;
    onToggleSettings: () => void;
    onCloseSettings: () => void;
    onSaveChartSettings: (next: ChartSettings) => void;
    onSelectLayout: (next: LayoutId) => void;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onOpenSymbolInNewTab: (symbol: string, shortName: string) => void;
  }

  let {
    theme,
    chartSettings,
    layoutId,
    activeSymbol,
    activeFullSymbol,
    activePrice = undefined,
    activeChangePercent = undefined,
    settingsOpen,
    onToggleSettings,
    onCloseSettings,
    onSaveChartSettings,
    onSelectLayout,
    onSelectSymbol,
    onOpenSymbolInNewTab
  }: Props = $props();

  type RailId =
    | 'list'
    | 'calendar'
    | 'tasks'
    | 'note'
    | 'ai'
    | 'alerts'
    | 'routines'
    | 'favorites'
    | 'trash'
    | 'cloud';

  let active = $state<RailId | null>(null);
  let layoutAnchor = $state<DOMRect | null>(null);
  let alertModalSeq = 0;
  let alertModalState = $state<{
    key: number;
    symbol: string;
    shortName: string;
    price?: number;
    editing: TradingAlert | null;
  } | null>(null);

  const activeLayoutDef = $derived(getLayoutById(layoutId));

  function openCreateAlertModal(
    symbol = activeFullSymbol || 'OANDA:XAUUSD',
    shortName = activeSymbol || 'XAUUSD',
    price = activePrice,
    editing: TradingAlert | null = null
  ) {
    alertModalSeq += 1;
    alertModalState = { key: alertModalSeq, symbol, shortName, price, editing };
  }

  function handleSaveAlert(saved: TradingAlert) {
    upsertAlert(saved);
  }

  function closeAlertModal() {
    alertModalState = null;
  }

  function select(id: RailId) {
    layoutAnchor = null;
    active = active === id ? null : id;
  }

  function closePanel() {
    active = null;
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
    onOpenNotesForSymbol={() => (active = 'note')}
    onCreateAlertForSymbol={(sym, short, price) => openCreateAlertModal(sym, short, price, null)}
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
    {activePrice}
    {activeChangePercent}
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
    onClose={closePanel}
  />
{:else if active === 'trash'}
  <TrashPanel {theme} onClose={closePanel} />
{/if}

{#if alertModalState}
  {#key alertModalState.key}
    <CreateAlertModal
      {theme}
      initialSymbol={alertModalState.symbol}
      initialShortName={alertModalState.shortName}
      initialPrice={alertModalState.price}
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
    class:active={active === 'routines'}
    type="button"
    aria-label="Routines"
    title="Routines"
    aria-pressed={active === 'routines'}
    onclick={() => select('routines')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11 6.25h2.5a3.75 3.75 0 0 1 0 7.5h-7a3.75 3.75 0 0 1 0-7.5" />
      <circle cx="7.25" cy="6.25" r="1.15" />
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
    class:active={active === 'trash'}
    type="button"
    aria-label="Trash"
    title="Trash"
    aria-pressed={active === 'trash'}
    onclick={() => select('trash')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <ellipse cx="10" cy="5.25" rx="4.75" ry="1.75" />
      <path d="M5.25 5.25l.9 9.4a2.35 2.35 0 0 0 2.35 2.1h3a2.35 2.35 0 0 0 2.35-2.1l.9-9.4" />
      <path d="m8.6 10.35 2.8 2.8m0-2.8-2.8 2.8" />
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
    class="rail-button"
    class:active={active === 'cloud'}
    type="button"
    aria-label="Cloud"
    title="Cloud"
    aria-pressed={active === 'cloud'}
    onclick={() => select('cloud')}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 15.25h7.75a3 3 0 0 0 .5-5.95 4.25 4.25 0 0 0-8.15-.65 3.35 3.35 0 0 0-.1 6.6Z" />
    </svg>
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
    color: #f5f5f5;
    background: #000000;
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
</style>
