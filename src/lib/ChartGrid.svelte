<script lang="ts">
  import Chart, { type ChartQuote } from './Chart.svelte';
  import { getLayoutById, type LayoutId } from './chart/layouts';
  import type { ChartSettings } from './settings/chartSettings';

  interface Props {
    theme: 'dark' | 'light';
    settings: ChartSettings;
    layoutId: LayoutId;
    tabId?: string;
    symbol?: string;
    onActiveQuote?: (quote: ChartQuote) => void;
  }

  let {
    theme,
    settings,
    layoutId,
    tabId = 'default',
    symbol = 'OANDA:XAUUSD',
    onActiveQuote
  }: Props = $props();

  const layout = $derived(getLayoutById(layoutId));
  let activePane = $state(0);
  let gridEl: HTMLDivElement | undefined = $state();
  const paneQuotes: Record<number, ChartQuote> = {};

  $effect(() => {
    if (activePane >= layout.count) {
      activePane = 0;
    }
  });

  function setActivePane(idx: number) {
    activePane = idx;
    const q = paneQuotes[idx];
    if (q) onActiveQuote?.(q);
  }

  function handlePaneQuote(idx: number, quote: ChartQuote) {
    paneQuotes[idx] = quote;
    if (idx === activePane) {
      onActiveQuote?.(quote);
    }
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
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="chart-pane"
      class:active={layout.count > 1 && activePane === idx}
      data-pane-index={idx}
      style:grid-column={placement.gridColumn}
      style:grid-row={placement.gridRow}
      onpointerdown={() => setActivePane(idx)}
    >
      <Chart
        {theme}
        {settings}
        {symbol}
        paneId="{tabId}-slot-{idx}"
        collapseSideToolbarByDefault={idx > 0}
        onQuote={(q) => handlePaneQuote(idx, q)}
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
    background: #1f1f1f;
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
    background: #000000;
    transition: background-color 150ms ease;
  }

  .chart-grid.light .chart-pane {
    background: #ffffff;
  }

  .chart-pane.active::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1.5px solid #50535e;
    pointer-events: none;
    z-index: 2;
  }

  .chart-grid.light .chart-pane.active::after {
    border-color: #131722;
  }
</style>
