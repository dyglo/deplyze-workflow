<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    calibrateRangeTimeAxis,
    captureElementRegion,
    fetchRangeBarsPreview,
    makeAiId,
    type CalibratedAxisAnchor,
    type RangeBarPreviewItem
  } from '../ai/api';
  import type { AiRangeMode, PendingRangeAnalysisRequest } from '../ai/types';
  import { getLocalTimeZone } from '../calendar/api';

  interface Props {
    theme: 'dark' | 'light';
    symbol: string;
    shortName: string;
    interval: string;
    isActivePane?: boolean;
    leftToolbarCollapsed?: boolean;
    legendSlot?: { top: number; left: number } | null;
    onAnalyzeRange: (request: PendingRangeAnalysisRequest) => void;
    onRangeActiveChange?: (active: boolean) => void;
  }

  let {
    theme,
    symbol,
    shortName,
    interval,
    isActivePane = true,
    leftToolbarCollapsed = false,
    legendSlot = null,
    onAnalyzeRange,
    onRangeActiveChange
  }: Props = $props();

  type SelectionPhase = 'idle' | 'selecting-start' | 'selecting-end' | 'selected';

  const PLOT_TOP_PX = 38;
  const TIME_AXIS_HEIGHT_PX = 28;
  const BOTTOM_BAR_HEIGHT_PX = 36;
  const PLOT_BOTTOM_INSET_PX = TIME_AXIS_HEIGHT_PX + BOTTOM_BAR_HEIGHT_PX; // 64px
  const PRICE_AXIS_WIDTH_PX = 58;
  const POPOVER_W = 284;
  const POPOVER_H = 198;
  const TIME_PILL_EST_W = 136;

  const SUGGESTIONS: { mode: AiRangeMode; label: string }[] = [
    { mode: 'explain', label: 'Explain this price move' },
    { mode: 'events', label: 'Find events behind this move' },
    { mode: 'technicals', label: 'Analyze technicals in this area' }
  ];

  const timeZone = getLocalTimeZone();

  let overlayRootEl: HTMLDivElement | undefined = $state();
  let askInputEl: HTMLInputElement | undefined = $state();
  let paneWidth = $state(960);
  let paneHeight = $state(600);

  let phase = $state<SelectionPhase>('idle');
  let anchorX = $state<number | null>(null);
  let hoverX = $state<number | null>(null);
  let startX = $state<number>(0);
  let endX = $state<number>(0);

  let dragHandle = $state<'start' | 'end' | null>(null);
  let isPointerDraggingNew = $state(false);
  let pointerDownX = 0;

  let popoverCollapsed = $state(false);
  let capturingForAi = $state(false);
  let customQuestion = $state('');

  // Bar-index & axis calibration state
  let bars = $state<RangeBarPreviewItem[]>([]);
  let barSec = $state(900);
  let calibratedAnchors = $state<CalibratedAxisAnchor[]>([]);
  let isCalibrated = $state(false);
  let activeAbort: AbortController | null = null;

  const plotLeft = $derived.by(() => {
    if (legendSlot && legendSlot.left > 12 && legendSlot.left < 120) {
      return Math.max(0, Math.round(legendSlot.left - 10));
    }
    return leftToolbarCollapsed ? 2 : 52;
  });

  const plotRight = $derived(Math.max(plotLeft + 120, paneWidth - PRICE_AXIS_WIDTH_PX));
  const plotWidth = $derived(Math.max(120, plotRight - plotLeft));
  const plotBottom = $derived(Math.max(PLOT_TOP_PX + 100, paneHeight - PLOT_BOTTOM_INSET_PX));
  const plotHeight = $derived(Math.max(100, plotBottom - PLOT_TOP_PX));
  const handleMidY = $derived(Math.round(PLOT_TOP_PX + plotHeight * 0.5));

  const isIntraday = $derived.by(() => {
    const iv = (interval || '15').trim().toUpperCase();
    return !(iv === 'D' || iv === '1D' || iv === 'W' || iv === '1W' || iv === 'M' || iv === '1M');
  });

  // Active preview coordinates during selecting-end or final selected coordinates
  const activeStartX = $derived.by(() => {
    if (phase === 'selected') return Math.min(startX, endX);
    if (phase === 'selecting-end' && anchorX !== null) {
      return hoverX !== null ? Math.min(anchorX, hoverX) : anchorX;
    }
    return 0;
  });

  const activeEndX = $derived.by(() => {
    if (phase === 'selected') return Math.max(startX, endX);
    if (phase === 'selecting-end' && anchorX !== null) {
      return hoverX !== null ? Math.max(anchorX, hoverX) : anchorX;
    }
    return 0;
  });

  const hasVisibleBand = $derived(
    phase === 'selected' || (phase === 'selecting-end' && anchorX !== null)
  );
  const bandWidth = $derived(Math.max(0, activeEndX - activeStartX));

  function intervalToFallbackSec(raw: string): number {
    const iv = (raw || '15').trim().toUpperCase();
    if (iv === '1' || iv === '1M') return 60;
    if (iv === '3' || iv === '3M') return 180;
    if (iv === '5' || iv === '5M') return 300;
    if (iv === '15' || iv === '15M') return 900;
    if (iv === '30' || iv === '30M') return 1800;
    if (iv === '60' || iv === '1H') return 3600;
    if (iv === '120' || iv === '2H') return 7200;
    if (iv === '240' || iv === '4H') return 14400;
    if (iv === 'W' || iv === '1W') return 604800;
    if (iv === 'M') return 2592000;
    return 86400;
  }

  function findNearestBarIndex(list: RangeBarPreviewItem[], targetTs: number): number {
    if (list.length === 0) return 0;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ts < targetTs) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(list[lo - 1].ts - targetTs) < Math.abs(list[lo].ts - targetTs)) {
      return lo - 1;
    }
    return lo;
  }

  // Build linear bar-index scale from calibrated anchors (or default TV density)
  const barScale = $derived.by(() => {
    const list = bars;
    const defaultVisible = Math.max(45, Math.min(180, Math.round(plotWidth / 7.5)));
    if (list.length < 2) {
      return {
        hasBars: false,
        leftIdx: 0,
        barsSpan: defaultVisible
      };
    }

    if (calibratedAnchors.length >= 2) {
      const a0 = calibratedAnchors[0];
      const a1 = calibratedAnchors[calibratedAnchors.length - 1];
      const idx0 = findNearestBarIndex(list, a0.ts);
      const idx1 = findNearestBarIndex(list, a1.ts);
      const dRatio = a1.xRatio - a0.xRatio;
      const dIdx = idx1 - idx0;
      if (dRatio > 0.08 && dIdx >= 2) {
        const barsPerRatio = dIdx / dRatio;
        const leftIdx = idx0 - a0.xRatio * barsPerRatio;
        return {
          hasBars: true,
          leftIdx,
          barsSpan: barsPerRatio
        };
      }
    }

    // Default TradingView viewport: ~7 bars right margin + defaultVisible bars across plotWidth
    const rightMarginBars = Math.round(defaultVisible * 0.075);
    const rightIdx = list.length - 1 + rightMarginBars;
    const leftIdx = rightIdx - defaultVisible;
    return {
      hasBars: true,
      leftIdx,
      barsSpan: defaultVisible
    };
  });

  function xToBarIndex(xPx: number): number {
    const ratio = Math.max(0, Math.min(1, (xPx - plotLeft) / plotWidth));
    if (!barScale.hasBars || bars.length === 0) return -1;
    const rawIdx = Math.round(barScale.leftIdx + ratio * barScale.barsSpan);
    return Math.max(0, Math.min(bars.length - 1, rawIdx));
  }

  function xToTimestamp(xPx: number): number {
    const ratio = Math.max(0, Math.min(1, (xPx - plotLeft) / plotWidth));
    if (barScale.hasBars && bars.length > 0) {
      const idx = xToBarIndex(xPx);
      return bars[idx].ts;
    }
    const step = barSec || intervalToFallbackSec(interval);
    const nowSec = Math.floor(Date.now() / 1000);
    const alignedNow = Math.floor(nowSec / step) * step;
    const totalSpanSec = barScale.barsSpan * step;
    const rawTs = alignedNow - (1 - ratio) * totalSpanSec;
    return Math.round(rawTs / step) * step;
  }

  function formatTvAxisPill(ts: number): string {
    try {
      const date = new Date(ts * 1000);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(date);

      let wk = '';
      let dd = '';
      let mon = '';
      let yy = '';
      let hh = '00';
      let mm = '00';
      for (const p of parts) {
        if (p.type === 'weekday') wk = p.value;
        else if (p.type === 'day') dd = p.value;
        else if (p.type === 'month') mon = p.value;
        else if (p.type === 'year') yy = p.value;
        else if (p.type === 'hour') hh = p.value === '24' ? '00' : p.value;
        else if (p.type === 'minute') mm = p.value;
      }
      const datePart = `${wk} ${dd} ${mon} '${yy}`;
      return isIntraday ? `${datePart}  ${hh}:${mm}` : datePart;
    } catch {
      return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  const startTs = $derived(hasVisibleBand ? xToTimestamp(activeStartX) : 0);
  const endTs = $derived(hasVisibleBand ? xToTimestamp(activeEndX) : 0);
  const startLabel = $derived(hasVisibleBand ? formatTvAxisPill(startTs) : '');
  const endLabel = $derived(hasVisibleBand ? formatTvAxisPill(endTs) : '');

  // Compute non-overlapping horizontal centers for the two blue time pills
  const pillCenters = $derived.by(() => {
    const half = TIME_PILL_EST_W / 2;
    const minC = plotLeft + half;
    const maxC = plotRight - half;
    let c1 = Math.max(minC, Math.min(maxC, activeStartX));
    let c2 = Math.max(minC, Math.min(maxC, activeEndX));
    const minSep = TIME_PILL_EST_W + 8;
    if (c2 - c1 < minSep) {
      const mid = (c1 + c2) / 2;
      c1 = Math.max(minC, mid - minSep / 2);
      c2 = Math.min(maxC, c1 + minSep);
      if (c2 - c1 < minSep) {
        c1 = Math.max(minC, c2 - minSep);
      }
    }
    return { startCenter: Math.round(c1), endCenter: Math.round(c2) };
  });

  // Range metrics preview (barCount + netChangePct) from OANDA bars
  const rangeMetrics = $derived.by(() => {
    if (!hasVisibleBand || bars.length === 0) {
      return { barCount: undefined as number | undefined, netChangePct: null as number | null };
    }
    const i1 = xToBarIndex(activeStartX);
    const i2 = xToBarIndex(activeEndX);
    const lo = Math.min(i1, i2);
    const hi = Math.max(i1, i2);
    if (lo < 0 || hi < lo) return { barCount: undefined, netChangePct: null };
    const first = bars[lo];
    const last = bars[hi];
    const pct = first.o > 0 ? Number((((last.c - first.o) / first.o) * 100).toFixed(2)) : null;
    return { barCount: hi - lo + 1, netChangePct: pct };
  });

  // Adaptive inside / outside popover coordinates (exact TradingView behavior from screenshots 3 & 4)
  const popoverPos = $derived.by(() => {
    const gap = 12;
    const insideThreshold = POPOVER_W + 40;
    let left: number;
    let top: number;
    let placement: 'inside' | 'outside-right' | 'outside-left' | 'clamped';

    if (bandWidth >= insideThreshold) {
      // Wide range: center INSIDE upper portion of the shaded zone (Screenshot 3)
      left = activeStartX + (bandWidth - POPOVER_W) / 2;
      top = PLOT_TOP_PX + Math.max(24, Math.min(92, Math.round(plotHeight * 0.16)));
      placement = 'inside';
    } else if (activeEndX + gap + POPOVER_W <= plotRight - 6) {
      // Narrow range with space on right: OUTSIDE right of end line (Screenshot 4)
      left = activeEndX + gap;
      top = PLOT_TOP_PX + Math.max(24, Math.min(plotHeight - POPOVER_H - 16, Math.round(plotHeight * 0.28)));
      placement = 'outside-right';
    } else if (activeStartX - gap - POPOVER_W >= plotLeft + 6) {
      // Narrow range near right edge: flip OUTSIDE left of start line
      left = activeStartX - gap - POPOVER_W;
      top = PLOT_TOP_PX + Math.max(24, Math.min(plotHeight - POPOVER_H - 16, Math.round(plotHeight * 0.28)));
      placement = 'outside-left';
    } else {
      // Small multi-pane fallback: center inside plot bounds
      left = plotLeft + (plotWidth - POPOVER_W) / 2;
      top = PLOT_TOP_PX + Math.max(16, Math.min(plotHeight - POPOVER_H - 16, Math.round(plotHeight * 0.2)));
      placement = 'clamped';
    }

    const clampedLeft = Math.round(
      Math.max(plotLeft + 6, Math.min(plotRight - POPOVER_W - 6, left))
    );
    const clampedTop = Math.round(
      Math.max(PLOT_TOP_PX + 10, Math.min(plotBottom - POPOVER_H - 10, top))
    );

    return { left: clampedLeft, top: clampedTop, placement };
  });

  // Notify parent when range mode opens/closes
  $effect(() => {
    onRangeActiveChange?.(phase !== 'idle');
  });

  // Auto-clear range when symbol or timeframe changes on this pane
  let trackedSymKey = '';
  $effect(() => {
    const key = `${symbol}|${interval}`;
    if (trackedSymKey && key !== trackedSymKey) {
      resetSelection();
      bars = [];
      calibratedAnchors = [];
      isCalibrated = false;
    }
    trackedSymKey = key;
  });

  onMount(() => {
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && overlayRootEl) {
      ro = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (cr && cr.width > 80 && cr.height > 80) {
          paneWidth = Math.round(cr.width);
          paneHeight = Math.round(cr.height);
        }
      });
      ro.observe(overlayRootEl);
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'idle') {
        e.preventDefault();
        resetSelection();
        return;
      }
      if (
        isActivePane &&
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        e.key.toLowerCase() === 'r'
      ) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        toggleRangeMode();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      activeAbort?.abort();
      ro?.disconnect();
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  function clampPlotX(rawX: number): number {
    return Math.round(Math.max(plotLeft + 2, Math.min(plotRight - 2, rawX)));
  }

  function resetSelection() {
    activeAbort?.abort();
    activeAbort = null;
    phase = 'idle';
    anchorX = null;
    hoverX = null;
    dragHandle = null;
    isPointerDraggingNew = false;
    popoverCollapsed = false;
    capturingForAi = false;
    customQuestion = '';
  }

  function toggleRangeMode() {
    if (phase !== 'idle') {
      resetSelection();
      return;
    }
    startRangeMode();
  }

  function startRangeMode() {
    if (overlayRootEl) {
      paneWidth = Math.round(overlayRootEl.clientWidth || paneWidth);
      paneHeight = Math.round(overlayRootEl.clientHeight || paneHeight);
    }
    phase = 'selecting-start';
    anchorX = null;
    hoverX = null;
    popoverCollapsed = false;
    customQuestion = '';
    calibratedAnchors = [];
    isCalibrated = false;
    barSec = intervalToFallbackSec(interval);

    activeAbort?.abort();
    const controller = new AbortController();
    activeAbort = controller;

    // 1. Preload real OANDA bars for exact bar-index mapping
    void fetchRangeBarsPreview(symbol, interval, 1200, controller.signal).then((payload) => {
      if (controller.signal.aborted || !payload) return;
      bars = payload.bars;
      if (payload.barSec > 0) barSec = payload.barSec;
    });

    // 2. Background time-axis calibration from TradingView's visible bottom axis strip
    const host = overlayRootEl;
    if (host) {
      const stripX = plotLeft;
      const stripY = Math.max(PLOT_TOP_PX, plotBottom - 4);
      const stripW = plotWidth;
      const stripH = Math.min(46, Math.max(26, paneHeight - stripY - 22));
      void captureElementRegion(host, {
        x: stripX,
        y: stripY,
        width: stripW,
        height: stripH
      }).then((snap) => {
        if (controller.signal.aborted || !snap?.dataUrl) return;
        return calibrateRangeTimeAxis(
          {
            image: snap.dataUrl,
            symbol,
            interval,
            timezone: timeZone
          },
          controller.signal
        ).then((anchors) => {
          if (controller.signal.aborted || anchors.length < 2) return;
          calibratedAnchors = anchors;
          isCalibrated = true;
        });
      });
    }
  }

  function getLocalX(e: PointerEvent): number {
    if (!overlayRootEl) return plotLeft;
    const rect = overlayRootEl.getBoundingClientRect();
    return clampPlotX(e.clientX - rect.left);
  }

  function handleCanvasPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (phase === 'idle') return;

    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-range-ui]')) return;

    const lx = getLocalX(e);

    if (phase === 'selected') {
      // Clicking outside the highlighted range dismisses it (just like TradingView)
      if (lx < activeStartX - 6 || lx > activeEndX + 6) {
        resetSelection();
      }
      return;
    }

    if (phase === 'selecting-start') {
      e.preventDefault();
      e.stopPropagation();
      anchorX = lx;
      hoverX = lx;
      pointerDownX = lx;
      isPointerDraggingNew = true;
      phase = 'selecting-end';
      return;
    }

    if (phase === 'selecting-end' && anchorX !== null) {
      e.preventDefault();
      e.stopPropagation();
      finalizeRange(anchorX, lx);
    }
  }

  function handleCanvasPointerMove(e: PointerEvent) {
    if (dragHandle) {
      const lx = getLocalX(e);
      if (dragHandle === 'start') {
        startX = lx;
      } else {
        endX = lx;
      }
      return;
    }

    if (phase === 'selecting-start' || phase === 'selecting-end') {
      hoverX = getLocalX(e);
    }
  }

  function handleCanvasPointerUp(e: PointerEvent) {
    if (dragHandle) {
      const lo = Math.min(startX, endX);
      const hi = Math.max(startX, endX);
      if (hi - lo < 12) {
        startX = lo;
        endX = clampPlotX(lo + 16);
      } else {
        startX = lo;
        endX = hi;
      }
      dragHandle = null;
      return;
    }

    if (isPointerDraggingNew && phase === 'selecting-end' && anchorX !== null) {
      isPointerDraggingNew = false;
      const lx = getLocalX(e);
      // If user clicked-and-dragged > 14px, finalize immediately on release; otherwise stay in 2-click mode
      if (Math.abs(lx - pointerDownX) > 14) {
        finalizeRange(anchorX, lx);
      }
    }
  }

  function finalizeRange(x1: number, x2: number) {
    let lo = Math.min(x1, x2);
    let hi = Math.max(x1, x2);
    if (hi - lo < 14) {
      hi = clampPlotX(lo + 28);
      if (hi - lo < 14) lo = clampPlotX(hi - 28);
    }
    startX = lo;
    endX = hi;
    phase = 'selected';
    popoverCollapsed = false;
    isPointerDraggingNew = false;
  }

  function startHandleResize(which: 'start' | 'end', e: PointerEvent) {
    if (e.button !== 0 || phase !== 'selected') return;
    e.preventDefault();
    e.stopPropagation();
    // Normalize startX <= endX before dragging
    const lo = Math.min(startX, endX);
    const hi = Math.max(startX, endX);
    startX = lo;
    endX = hi;
    dragHandle = which;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function endHandleResize(e: PointerEvent) {
    if (!dragHandle) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const lo = Math.min(startX, endX);
    const hi = Math.max(startX, endX);
    if (hi - lo < 12) {
      startX = lo;
      endX = clampPlotX(lo + 16);
    } else {
      startX = lo;
      endX = hi;
    }
    dragHandle = null;
  }

  async function submitRangePrompt(promptText: string, mode: AiRangeMode) {
    const cleanPrompt = promptText.trim();
    if (!cleanPrompt || phase !== 'selected' || capturingForAi) return;

    const capturedStartTs = Math.min(startTs, endTs);
    const capturedEndTs = Math.max(startTs, endTs);
    const capturedStartLabel = startLabel;
    const capturedEndLabel = endLabel;
    const capturedBarCount = rangeMetrics.barCount;
    const capturedNetPct = rangeMetrics.netChangePct;
    const capturedCalibrated = isCalibrated;

    // Hide ONLY the floating popover for 1 animation frame so the captured screenshot shows
    // the full purple/blue range highlight & unobstructed candlesticks inside the range!
    capturingForAi = true;
    await tick();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

    let chartDataUrl: string | null = null;
    if (overlayRootEl) {
      const snap = await captureElementRegion(overlayRootEl);
      chartDataUrl = snap?.dataUrl ?? null;
    }

    capturingForAi = false;
    popoverCollapsed = true;
    customQuestion = '';

    onAnalyzeRange({
      id: makeAiId('rng'),
      symbol: shortName || symbol,
      fullSymbol: symbol,
      interval: interval || '15',
      prompt: cleanPrompt,
      range: {
        startTs: capturedStartTs,
        endTs: capturedEndTs,
        startLabel: capturedStartLabel,
        endLabel: capturedEndLabel,
        barCount: capturedBarCount,
        netChangePct: capturedNetPct,
        interval: interval || '15',
        mode,
        calibrated: capturedCalibrated
      },
      chartDataUrl
    });
  }

  function handleCustomSubmit(e: Event) {
    e.preventDefault();
    if (!customQuestion.trim()) return;
    void submitRangePrompt(customQuestion, 'custom');
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={overlayRootEl}
  class="range-overlay-root"
  class:light={theme === 'light'}
  class:active={phase !== 'idle'}
  class:selecting={phase === 'selecting-start' || phase === 'selecting-end'}
  onpointerdown={handleCanvasPointerDown}
  onpointermove={handleCanvasPointerMove}
  onpointerup={handleCanvasPointerUp}
>
  <!-- |✦| Range Analysis Trigger Button (Top-Right of Plot Canvas, Unobstructed) -->
  <button
    class="range-trigger-btn"
    class:active={phase !== 'idle'}
    type="button"
    data-range-ui="true"
    aria-label="AI Chart Range Analysis"
    aria-pressed={phase !== 'idle'}
    title={phase !== 'idle'
      ? 'Exit AI Range Analysis (Esc)'
      : 'AI Chart Range Analysis (Alt+R)'}
    onclick={(e) => {
      e.stopPropagation();
      toggleRangeMode();
    }}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <line x1="3.75" y1="4.25" x2="3.75" y2="15.75" />
      <line x1="16.25" y1="4.25" x2="16.25" y2="15.75" />
      <path
        d="M10 6c.42 2.25 1.75 3.58 4 4-2.25.42-3.58 1.75-4 4-.42-2.25-1.75-3.58-4-4 2.25-.42 3.58-1.75 4-4Z"
        class="sparkle-fill"
      />
    </svg>
  </button>

  <!-- Live Hover Vertical Guide Line while picking Start Point -->
  {#if phase === 'selecting-start' && hoverX !== null}
    <div
      class="hover-guide-line"
      style:left="{hoverX}px"
      style:top="{PLOT_TOP_PX}px"
      style:height="{plotHeight}px"
    ></div>
  {/if}

  <!-- Highlighted Range Band, Gradient Vertical Lines, Midpoint □ Handles & Time Axis Pills -->
  {#if hasVisibleBand}
    <div
      class="range-band"
      style:left="{activeStartX}px"
      style:top="{PLOT_TOP_PX}px"
      style:width="{bandWidth}px"
      style:height="{plotHeight}px"
    ></div>

    <!-- Start Vertical Gradient Line -->
    <div
      class="range-edge-line"
      style:left="{activeStartX}px"
      style:top="{PLOT_TOP_PX}px"
      style:height="{plotHeight}px"
    ></div>

    <!-- End Vertical Gradient Line -->
    <div
      class="range-edge-line"
      style:left="{activeEndX}px"
      style:top="{PLOT_TOP_PX}px"
      style:height="{plotHeight}px"
    ></div>

    <!-- Midpoint Draggable □ Resize Handles (Screenshots 3 & 4) -->
    {#if phase === 'selected'}
      <div
        class="edge-handle-hit"
        data-range-ui="true"
        role="slider"
        tabindex="0"
        aria-label="Adjust range start"
        aria-valuenow={startTs}
        style:left="{activeStartX}px"
        style:top="{handleMidY}px"
        onpointerdown={(e) => startHandleResize('start', e)}
        onpointerup={endHandleResize}
        onpointercancel={endHandleResize}
      >
        <span class="edge-handle-box"></span>
      </div>

      <div
        class="edge-handle-hit"
        data-range-ui="true"
        role="slider"
        tabindex="0"
        aria-label="Adjust range end"
        aria-valuenow={endTs}
        style:left="{activeEndX}px"
        style:top="{handleMidY}px"
        onpointerdown={(e) => startHandleResize('end', e)}
        onpointerup={endHandleResize}
        onpointercancel={endHandleResize}
      >
        <span class="edge-handle-box"></span>
      </div>
    {/if}

    <!-- Time Axis Connector Tint & Blue Timestamp Pills -->
    <div
      class="axis-connector-strip"
      style:left="{activeStartX}px"
      style:top="{plotBottom}px"
      style:width="{bandWidth}px"
      style:height="{TIME_AXIS_HEIGHT_PX}px"
    ></div>

    <div
      class="axis-time-pill"
      style:left="{pillCenters.startCenter}px"
      style:top="{plotBottom + 3}px"
    >
      {startLabel}
    </div>

    {#if bandWidth > 2}
      <div
        class="axis-time-pill"
        style:left="{pillCenters.endCenter}px"
        style:top="{plotBottom + 3}px"
      >
        {endLabel}
      </div>
    {/if}
  {/if}

  <!-- Bottom Floating Guide Tooltip (Screenshot 2) -->
  {#if phase === 'selecting-start' || phase === 'selecting-end'}
    <div
      class="guide-tooltip"
      role="status"
      aria-live="polite"
      style:left="{Math.round(plotLeft + plotWidth / 2)}px"
      style:top="{plotBottom - 44}px"
    >
      Click to set the start and the end of the range
    </div>
  {/if}

  <!-- Compact Reopen / Dismiss Pill while Streaming in AI Copilot -->
  {#if phase === 'selected' && popoverCollapsed && !capturingForAi}
    <div
      class="collapsed-range-bar"
      data-range-ui="true"
      style:left="{Math.round(
        Math.max(plotLeft + 8, Math.min(plotRight - 144, (activeStartX + activeEndX) / 2 - 64))
      )}px"
      style:top="{PLOT_TOP_PX + 10}px"
    >
      <button
        class="crb-btn"
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          popoverCollapsed = false;
          void tick().then(() => askInputEl?.focus());
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.8 2c.35 2.15 1.55 3.35 3.7 3.7-2.15.35-3.35 1.55-3.7 3.7-.35-2.15-1.55-3.35-3.7-3.7 2.15-.35 3.35-1.55 3.7-3.7Z" />
          <path d="M12.2 8.8c.2 1.15.8 1.75 1.95 1.95-1.15.2-1.75.8-1.95 1.95-.2-1.15-.8-1.75-1.95-1.95 1.15-.2 1.75-.8 1.95-1.95Z" />
        </svg>
        <span>Ask range</span>
      </button>
      <button
        class="crb-close"
        type="button"
        aria-label="Clear selected range"
        title="Clear range (Esc)"
        onclick={(e) => {
          e.stopPropagation();
          resetSelection();
        }}
      >
        ×
      </button>
    </div>
  {/if}

  <!-- Range Action Popover (Inside or Outside as in Screenshots 3 & 4) -->
  {#if phase === 'selected' && !popoverCollapsed && !capturingForAi}
    <div
      class="range-popover"
      class:dragging={dragHandle !== null}
      data-range-ui="true"
      role="dialog"
      aria-label="AI range analysis actions"
      style:left="{popoverPos.left}px"
      style:top="{popoverPos.top}px"
    >
      <div class="suggestion-stack">
        {#each SUGGESTIONS as item (item.mode)}
          <button
            class="range-pill-btn"
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              void submitRangePrompt(item.label, item.mode);
            }}
          >
            <svg class="twin-sparkle" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M7.5 3.2c.42 2.4 1.78 3.76 4.18 4.18-2.4.42-3.76 1.78-4.18 4.18-.42-2.4-1.78-3.76-4.18-4.18 2.4-.42 3.76-1.78 4.18-4.18Z" />
              <path d="M13.2 2.2c.22 1.1.82 1.7 1.92 1.92-1.1.22-1.7.82-1.92 1.92-.22-1.1-.82-1.7-1.92-1.92 1.1-.22 1.7-.82 1.92-1.92Z" />
            </svg>
            <span>{item.label}</span>
          </button>
        {/each}
      </div>

      <form class="ask-row" onsubmit={handleCustomSubmit}>
        <input
          bind:this={askInputEl}
          class="ask-input"
          type="text"
          placeholder="Ask about this range..."
          bind:value={customQuestion}
          onclick={(e) => e.stopPropagation()}
        />
        <button
          class="ask-send-btn"
          class:ready={customQuestion.trim().length > 0}
          type="submit"
          disabled={customQuestion.trim().length === 0}
          aria-label="Ask AI about this range"
          title="Ask AI (Enter)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8h9M8.75 4.25 12.5 8l-3.75 3.75" />
          </svg>
        </button>
      </form>
    </div>
  {/if}
</div>

<style>
  .range-overlay-root {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 9;
    overflow: hidden;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  /* While selecting or displaying a range, lock canvas pan/zoom so highlight stays pinned to candles */
  .range-overlay-root.active {
    pointer-events: auto;
  }

  .range-overlay-root.selecting {
    cursor: crosshair;
  }

  /* |✦| Trigger Button */
  .range-trigger-btn {
    position: absolute;
    top: 46px;
    right: 66px;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 7px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(20, 20, 20, 0.84);
    color: #e5e5e5;
    display: grid;
    place-items: center;
    cursor: pointer;
    pointer-events: auto;
    backdrop-filter: blur(8px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 100ms ease;
    z-index: 12;
  }

  .range-trigger-btn:hover {
    background: rgba(38, 38, 38, 0.94);
    border-color: rgba(255, 255, 255, 0.24);
    color: #ffffff;
  }

  .range-trigger-btn.active {
    background: #2c2c2c;
    border-color: #7c5cff;
    color: #ffffff;
    box-shadow: 0 0 0 1px rgba(124, 92, 255, 0.4), 0 3px 10px rgba(0, 0, 0, 0.42);
  }

  .range-overlay-root.light .range-trigger-btn {
    background: rgba(255, 255, 255, 0.92);
    border-color: rgba(19, 23, 34, 0.13);
    color: #131722;
    box-shadow: 0 2px 8px rgba(19, 23, 34, 0.1);
  }

  .range-overlay-root.light .range-trigger-btn:hover {
    background: #f2f3f6;
    border-color: rgba(19, 23, 34, 0.22);
  }

  .range-overlay-root.light .range-trigger-btn.active {
    background: #e5e8ef;
    border-color: #2962ff;
    color: #131722;
    box-shadow: 0 0 0 1px rgba(41, 98, 255, 0.22), 0 2px 8px rgba(19, 23, 34, 0.12);
  }

  .range-trigger-btn svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .range-trigger-btn .sparkle-fill {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.35;
  }

  /* Subtle hover crosshair before first click */
  .hover-guide-line {
    position: absolute;
    width: 1px;
    background: linear-gradient(180deg, rgba(184, 51, 245, 0.55), rgba(41, 98, 255, 0.55));
    pointer-events: none;
    transform: translateX(-0.5px);
  }

  /* Shaded Range Area (Purple-to-Blue Vertical Gradient) */
  .range-band {
    position: absolute;
    pointer-events: none;
    background: linear-gradient(
      180deg,
      rgba(184, 51, 245, 0.16) 0%,
      rgba(124, 92, 255, 0.12) 48%,
      rgba(41, 98, 255, 0.14) 100%
    );
  }

  .range-overlay-root.light .range-band {
    background: linear-gradient(
      180deg,
      rgba(184, 51, 245, 0.105) 0%,
      rgba(124, 92, 255, 0.085) 48%,
      rgba(41, 98, 255, 0.105) 100%
    );
  }

  /* Left & Right Vertical Boundary Lines */
  .range-edge-line {
    position: absolute;
    width: 1.5px;
    transform: translateX(-0.75px);
    pointer-events: none;
    background: linear-gradient(180deg, #b833f5 0%, #7c5cff 45%, #2962ff 100%);
  }

  /* Midpoint Square Resize Handles (□) */
  .edge-handle-hit {
    position: absolute;
    width: 22px;
    height: 30px;
    transform: translate(-50%, -50%);
    display: grid;
    place-items: center;
    cursor: ew-resize;
    pointer-events: auto;
    z-index: 10;
  }

  .edge-handle-box {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: #ffffff;
    border: 1.5px solid #2962ff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
    transition: transform 100ms ease;
  }

  .edge-handle-hit:hover .edge-handle-box {
    transform: scale(1.18);
  }

  /* Time Axis Highlight Strip + Royal-Blue Timestamp Pills */
  .axis-connector-strip {
    position: absolute;
    pointer-events: none;
    background: rgba(41, 98, 255, 0.24);
  }

  .range-overlay-root.light .axis-connector-strip {
    background: rgba(41, 98, 255, 0.17);
  }

  .axis-time-pill {
    position: absolute;
    transform: translateX(-50%);
    height: 22px;
    padding: 0 8px;
    border-radius: 3px;
    background: #2962ff;
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    line-height: 22px;
    letter-spacing: 0.01em;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    z-index: 11;
  }

  /* Bottom Floating Guide Tooltip */
  .guide-tooltip {
    position: absolute;
    transform: translateX(-50%);
    padding: 9px 16px;
    border-radius: 8px;
    background: #2a2a2a;
    color: #f2f2f2;
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    z-index: 12;
  }

  .range-overlay-root.light .guide-tooltip {
    background: #2a2e39;
    color: #ffffff;
    border-color: rgba(0, 0, 0, 0.08);
    box-shadow: 0 6px 18px rgba(19, 23, 34, 0.24);
  }

  /* Compact Reopen / Dismiss Pill while Streaming */
  .collapsed-range-bar {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: rgba(24, 24, 24, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    pointer-events: auto;
    z-index: 13;
  }

  .range-overlay-root.light .collapsed-range-bar {
    background: rgba(255, 255, 255, 0.96);
    border-color: rgba(19, 23, 34, 0.12);
    box-shadow: 0 6px 18px rgba(19, 23, 34, 0.16);
  }

  .crb-btn {
    height: 24px;
    padding: 0 9px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: #f2f2f2;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }

  .crb-btn:hover {
    background: rgba(255, 255, 255, 0.09);
  }

  .range-overlay-root.light .crb-btn {
    color: #131722;
  }

  .range-overlay-root.light .crb-btn:hover {
    background: rgba(19, 23, 34, 0.06);
  }

  .crb-btn svg {
    width: 13px;
    height: 13px;
    fill: currentColor;
  }

  .crb-close {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #a1a1a1;
    font-size: 14px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .crb-close:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.12);
  }

  .range-overlay-root.light .crb-close {
    color: #6a6d78;
  }

  .range-overlay-root.light .crb-close:hover {
    color: #131722;
    background: rgba(19, 23, 34, 0.08);
  }

  /* Floating Action Popover Card */
  .range-popover {
    position: absolute;
    width: 284px;
    padding: 10px;
    border-radius: 12px;
    background: var(--dark-bg-elevated, #1f1f1f);
    border: 1px solid var(--dark-border-glass, rgba(255, 255, 255, 0.12));
    box-shadow: var(--dark-shadow-popover, 0 12px 32px rgba(0, 0, 0, 0.6));
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: auto;
    z-index: 14;
    transition: opacity 120ms ease;
  }

  .range-popover.dragging {
    opacity: 0.35;
    pointer-events: none;
  }

  .range-overlay-root.light .range-popover {
    background: #ffffff;
    border-color: rgba(19, 23, 34, 0.09);
    box-shadow: 0 10px 28px rgba(19, 23, 34, 0.15), 0 2px 6px rgba(19, 23, 34, 0.06);
  }

  .suggestion-stack {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .range-pill-btn {
    width: 100%;
    height: 36px;
    padding: 0 11px;
    border: 0;
    border-radius: 8px;
    background: #2a2a2a;
    color: var(--dark-text-strong, #f2f2f2);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .range-pill-btn:hover {
    background: #353535;
  }

  .range-overlay-root.light .range-pill-btn {
    background: #f2f3f5;
    color: #131722;
  }

  .range-overlay-root.light .range-pill-btn:hover {
    background: #e6e8ed;
  }

  .twin-sparkle {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    fill: currentColor;
    opacity: 0.9;
  }

  /* Free-text Input Row */
  .ask-row {
    height: 38px;
    padding: 0 6px 0 11px;
    border-radius: 8px;
    border: 1px solid var(--dark-border-strong, #3a3a3a);
    background: var(--dark-bg-input, #141414);
    display: flex;
    align-items: center;
    gap: 6px;
    transition: border-color 140ms ease;
  }

  .ask-row:focus-within {
    border-color: #7c5cff;
  }

  .range-overlay-root.light .ask-row {
    background: #ffffff;
    border-color: #e0e3eb;
  }

  .range-overlay-root.light .ask-row:focus-within {
    border-color: #2962ff;
  }

  .ask-input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--dark-text-strong, #f2f2f2);
    font: inherit;
    font-size: 13px;
    user-select: text;
  }

  .ask-input::placeholder {
    color: var(--dark-text-muted, #6e6e6e);
  }

  .range-overlay-root.light .ask-input {
    color: #131722;
  }

  .range-overlay-root.light .ask-input::placeholder {
    color: #868993;
  }

  .ask-send-btn {
    width: 26px;
    height: 26px;
    flex: 0 0 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: #2a2a2a;
    color: #6e6e6e;
    display: grid;
    place-items: center;
    cursor: default;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .ask-send-btn.ready {
    background: var(--dark-cta-bg, #ebebeb);
    color: var(--dark-cta-fg, #0d0d0d);
    cursor: pointer;
  }

  .range-overlay-root.light .ask-send-btn {
    background: #f0f3fa;
    color: #b2b5be;
  }

  .range-overlay-root.light .ask-send-btn.ready {
    background: #131722;
    color: #ffffff;
    cursor: pointer;
  }

  .ask-send-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
