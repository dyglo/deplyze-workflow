<script lang="ts">
  import { onMount } from 'svelte';
  import type { PendingRangeAnalysisRequest } from './ai/types';
  import Chart, { type ChartQuote } from './Chart.svelte';
  import ChartRangeAnalysisOverlay from './chart/ChartRangeAnalysisOverlay.svelte';
  import { getLayoutById, type LayoutId } from './chart/layouts';
  import ChartTradeOverlay from './paper/ChartTradeOverlay.svelte';
  import type { PaperPosition } from './paper/types';
  import type { ChartSettings } from './settings/chartSettings';
  import { extractShortSymbol, type ChartPaneState } from './tabs/tabs';

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
    onRequestClosePosition?: (position: PaperPosition) => void;
    onRequestModifyPosition?: (position: PaperPosition, focusField?: 'tp' | 'sl' | null) => void;
    onAnalyzeRange?: (request: PendingRangeAnalysisRequest) => void;
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
    onPaneInterval,
    onRequestClosePosition,
    onRequestModifyPosition,
    onAnalyzeRange
  }: Props = $props();

  const layout = $derived(getLayoutById(layoutId));
  let gridEl: HTMLDivElement | undefined = $state();
  let paneLegendSlots = $state<Record<number, { top: number; left: number }>>({});
  // Plain Maps (NOT $state): updated from child $effect callbacks and never rendered in the
  // template, so mutating them must never feed back into ChartTradeOverlay's reactive graph.
  const paneDockOffsets = new Map<number, number>();
  const pendingDockTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const readyPanes = new Set<number>();

  function postDockOffsetToPane(idx: number, offsetPx: number) {
    if (!gridEl) return;
    const paneEl = gridEl.querySelector<HTMLElement>(`[data-pane-index="${idx}"]`);
    const iframe = paneEl?.querySelector<HTMLIFrameElement>('iframe');
    const win = iframe?.contentWindow;
    if (!win) return;
    try {
      win.postMessage({ type: 'deplyze:paper-dock', offsetPx }, '*');
    } catch {
      // ignore cross-origin teardown race
    }
  }

  function clearPendingDockTimer(idx: number) {
    const existing = pendingDockTimers.get(idx);
    if (existing !== undefined) {
      clearTimeout(existing);
      pendingDockTimers.delete(idx);
    }
  }

  function handlePaneDockOffset(idx: number, offsetPx: number) {
    if (paneDockOffsets.get(idx) === offsetPx && readyPanes.has(idx)) {
      return;
    }
    paneDockOffsets.set(idx, offsetPx);
    postDockOffsetToPane(idx, offsetPx);
    clearPendingDockTimer(idx);
    if (!readyPanes.has(idx)) {
      const timer = setTimeout(() => {
        pendingDockTimers.delete(idx);
        postDockOffsetToPane(idx, paneDockOffsets.get(idx) ?? 0);
      }, 500);
      pendingDockTimers.set(idx, timer);
    }
  }

  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (
        !d ||
        typeof d !== 'object' ||
        (d.type !== 'deplyze:legend-slot' && d.type !== 'deplyze:tv-ready')
      ) {
        return;
      }
      if (!gridEl) return;
      const top = typeof d.top === 'number' && Number.isFinite(d.top) ? d.top : null;
      const left = typeof d.left === 'number' && Number.isFinite(d.left) ? d.left : null;

      const panesList = gridEl.querySelectorAll<HTMLElement>('[data-pane-index]');
      panesList.forEach((paneEl) => {
        const iframe = paneEl.querySelector<HTMLIFrameElement>('iframe');
        if (iframe && iframe.contentWindow === e.source) {
          const idx = Number(paneEl.dataset.paneIndex);
          if (!Number.isFinite(idx)) return;
          if (top !== null && left !== null) {
            const cur = paneLegendSlots[idx];
            if (!cur || cur.top !== top || cur.left !== left) {
              paneLegendSlots = { ...paneLegendSlots, [idx]: { top, left } };
            }
          }
          if (d.type === 'deplyze:tv-ready') {
            readyPanes.add(idx);
            clearPendingDockTimer(idx);
            postDockOffsetToPane(idx, paneDockOffsets.get(idx) ?? 0);
          }
        }
      });
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      for (const timer of pendingDockTimers.values()) {
        clearTimeout(timer);
      }
      pendingDockTimers.clear();
    };
  });

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

      <ChartTradeOverlay
        {theme}
        symbol={paneSymbol}
        shortName={paneState?.shortName || extractShortSymbol(paneSymbol)}
        interval={paneInterval}
        leftToolbarCollapsed={idx > 0}
        legendSlot={paneLegendSlots[idx] ?? null}
        onDockOffsetChange={(px) => handlePaneDockOffset(idx, px)}
        onRequestClosePosition={(pos) => onRequestClosePosition?.(pos)}
        onRequestModifyPosition={(pos, field) => onRequestModifyPosition?.(pos, field)}
      />

      <ChartRangeAnalysisOverlay
        {theme}
        symbol={paneSymbol}
        shortName={paneState?.shortName || extractShortSymbol(paneSymbol)}
        interval={paneInterval}
        isActivePane={currentActivePane === idx}
        leftToolbarCollapsed={idx > 0}
        legendSlot={paneLegendSlots[idx] ?? null}
        onAnalyzeRange={(req) => {
          setActivePane(idx);
          onAnalyzeRange?.(req);
        }}
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
