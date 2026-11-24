<script lang="ts">
  import Chart, { type ChartQuote } from './Chart.svelte';
  import { getLayoutById, type LayoutId } from './chart/layouts';
  import type { ChartSettings } from './settings/chartSettings';
  import type { ChartPaneState } from './tabs/tabs';

  interface Props {
    theme: 'dark' | 'light';
    settings: ChartSettings;
    layoutId: LayoutId;
    tabId?: string;
    symbol?: string;
    panes?: Record<number, ChartPaneState>;
    activePane?: number;
    onActivePaneChange?: (paneIndex: number) => void;
    onPaneQuote?: (paneIndex: number, quote: ChartQuote) => void;
    onPaneInterval?: (paneIndex: number, interval: string) => void;
  }

  let {
    theme,
    settings,
    layoutId,
    tabId = 'default',
    symbol = 'OANDA:XAUUSD',
    panes = {},
    activePane = 0,
    onActivePaneChange,
    onPaneQuote,
    onPaneInterval
  }: Props = $props();

  const layout = $derived(getLayoutById(layoutId));
  let gridEl: HTMLDivElement | undefined = $state();

  const currentActivePane = $derived(
    activePane >= 0 && activePane < layout.count ? activePane : 0
  );

  $effect(() => {
    if (activePane >= layout.count) {
      onActivePaneChange?.(0);
    }
  });

  function setActivePane(idx: number) {
    if (idx < 0 || idx >= layout.count) return;
    if (idx !== currentActivePane) {
      onActivePaneChange?.(idx);
    }
  }

  function handlePaneQuote(idx: number, quote: ChartQuote) {
    onPaneQuote?.(idx, quote);
  }

  function handlePaneInterval(idx: number, interval: string) {
    onPaneInterval?.(idx, interval);
  }

  function syncActiveFromIframe() {
    if (!gridEl || layout.count <= 1) return;
    const active = document.activeElement;
    if (!active || active.tagName !== 'IFRAME') return;
    const pane = active.closest<HTMLElement>('[data-pane-index]');
    if (!pane || !gridEl.contains(pane)) return;
    const idx = Number(pane.dataset.paneIndex);
    if (!Number.isNaN(idx)) {
      setActivePane(idx);
    }
  }
</script>

<svelte:window onblur={syncActiveFromIframe} />

<div
  bind:this={gridEl}
  class="chart-grid"
  class:light={theme === 'light'}
  class:multi={layout.count > 1}
  style:grid-template-columns={layout.columns}
  style:grid-template-rows={layout.rows}
>
  {#each layout.panes as placement, idx (idx)}
    {@const paneState = panes?.[idx]}
    {@const paneSymbol = paneState?.symbol || symbol}
    {@const paneInterval = paneState?.interval || 'D'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="chart-pane"
      class:active={layout.count > 1 && currentActivePane === idx}
      data-pane-index={idx}
      style:grid-column={placement.gridColumn}
      style:grid-row={placement.gridRow}
      onpointerdown={() => setActivePane(idx)}
    >
      <Chart
        {theme}
        {settings}
        symbol={paneSymbol}
        interval={paneInterval}
        paneId="{tabId}-slot-{idx}"
        collapseSideToolbarByDefault={idx > 0}
        onQuote={(q) => handlePaneQuote(idx, q)}
        onInterval={(ivl) => handlePaneInterval(idx, ivl)}
      />
    </div>
  {/each}
</div>

<style>
  .chart-grid {
    width: 100%;
    height: 100%;
    display: grid;
    gap: 0;
    background: var(--dark-bg-gutter);
    overflow: hidden;
    transition: background-color 150ms ease;
  }

  .chart-grid.multi {
    gap: 3px;
  }

  .chart-grid.light {
    background: #ebebeb;
  }

  .chart-pane {
    position: relative;
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--dark-bg-base);
    transition: background-color 150ms ease;
  }

  .chart-grid.light .chart-pane {
    background: #ffffff;
  }

  .chart-pane.active::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1.5px solid var(--dark-handle);
    pointer-events: none;
    z-index: 2;
  }

  .chart-grid.light .chart-pane.active::after {
    border-color: #131722;
  }
</style>
