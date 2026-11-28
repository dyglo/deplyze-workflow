<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
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
    toggleSeq?: number;
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
    toggleSeq = 0,
    onAnalyzeRange,
    onRangeActiveChange
  }: Props = $props();

  type SelectionPhase = 'idle' | 'selecting-start' | 'selecting-end' | 'selected';

  const PLOT_TOP_PX = 38;
  // TradingView widgetembed renders ONLY the 28px time axis at the bottom (no extra 36px preset bar)
  const TIME_AXIS_HEIGHT_PX = 28;
  const PLOT_BOTTOM_INSET_PX = TIME_AXIS_HEIGHT_PX;
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
  // Store coordinates relative to plotRight (`distFromRight = plotRight - x`) so when
  // AI Copilot opens/closes and TradingView keeps the right edge anchored, the highlighted
  // range stays glued to the exact same candles!
  let anchorDistR = $state<number | null>(null);
  let hoverDistR = $state<number | null>(null);
  let startDistR = $state<number>(0);
  let endDistR = $state<number>(0);

  let dragHandle = $state<'start' | 'end' | null>(null);
  let isPointerDraggingNew = $state(false);
  let pointerDownX = 0;

  let popoverCollapsed = $state(false);
  let capturingForAi = $state(false);
  let customQuestion = $state('');

  // Bar-index & right-edge-anchored axis calibration state
  let bars = $state<RangeBarPreviewItem[]>([]);
  let barSec = $state(900);
  // Anchors stored as pixel distance from plotRight so they stay valid across pane resizes!
  let calibratedAnchors = $state<{ distR: number; ts: number; label: string }[]>([]);
  let isCalibrated = $state(false);
  // Snapshot of the plotWidth at the moment Range Mode opened (preserves default pxPerBar on resize)
  let initialCalibrationPlotWidth = $state(850);
  let activeAbort: AbortController | null = null;

  // Respond cleanly to Rail |✦| button clicks without triggering on initial mount
  let lastHandledToggleSeq = untrack(() => toggleSeq);
  $effect(() => {
    const seq = toggleSeq;
    if (seq > lastHandledToggleSeq) {
      lastHandledToggleSeq = seq;
      untrack(() => toggleRangeMode());
    }
  });

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

  // Logical distance-from-right bounds (larger distR = further left = earlier in time)
  const activeStartDistR = $derived.by(() => {
    if (phase === 'selected') return Math.max(startDistR, endDistR);
    if (phase === 'selecting-end' && anchorDistR !== null) {
      return hoverDistR !== null ? Math.max(anchorDistR, hoverDistR) : anchorDistR;
    }
    return 0;
  });

  const activeEndDistR = $derived.by(() => {
    if (phase === 'selected') return Math.min(startDistR, endDistR);
    if (phase === 'selecting-end' && anchorDistR !== null) {
      return hoverDistR !== null ? Math.min(anchorDistR, hoverDistR) : anchorDistR;
    }
    return 0;
  });

  // Clamped visual X coordinates within current plot bounds
  const rawStartX = $derived(Math.round(plotRight - activeStartDistR));
  const rawEndX = $derived(Math.round(plotRight - activeEndDistR));
  const activeStartX = $derived(Math.max(plotLeft, Math.min(plotRight, rawStartX)));
  const activeEndX = $derived(Math.max(plotLeft, Math.min(plotRight, rawEndX)));
  const startClippedLeft = $derived(rawStartX < plotLeft + 1);
  const hoverX = $derived(
    hoverDistR !== null ? Math.max(plotLeft, Math.min(plotRight, Math.round(plotRight - hoverDistR))) : null
  );

  const hasVisibleBand = $derived(
    phase === 'selected' || (phase === 'selecting-end' && anchorDistR !== null)
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

  // Right-edge-anchored linear bar-index scale: `idx = rightEdgeIdx - distR * barsPerPx`
  // Invariant across pane horizontal resizes (e.g. when AI Copilot slides open/closed)!
  const barScale = $derived.by(() => {
    const list = bars;
    const refWidth = Math.max(240, initialCalibrationPlotWidth || plotWidth);
    const defaultBarsPerPx = 1 / 6.8;

    if (list.length < 2) {
      return {
        hasBars: false,
        rightEdgeIdx: 0,
        barsPerPx: defaultBarsPerPx
      };
    }

    if (calibratedAnchors.length >= 2) {
      // calibratedAnchors are sorted left-to-right (distR descending, ts ascending)
      const leftA = calibratedAnchors[0];
      const rightA = calibratedAnchors[calibratedAnchors.length - 1];
      const idxLeft = findNearestBarIndex(list, leftA.ts);
      const idxRight = findNearestBarIndex(list, rightA.ts);
      const dDistR = leftA.distR - rightA.distR; // positive pixels between leftA and rightA
      const dIdx = idxRight - idxLeft;
      if (dDistR > 60 && dIdx >= 2) {
        const barsPerPx = dIdx / dDistR;
        const rightEdgeIdx = idxRight + rightA.distR * barsPerPx;
        return {
          hasBars: true,
          rightEdgeIdx,
          barsPerPx
        };
      }
    }

    // Default TradingView viewport before calibration resolves
    const defaultVisible = Math.max(45, Math.min(200, Math.round(refWidth * defaultBarsPerPx)));
    const rightMarginBars = Math.round(defaultVisible * 0.075);
    return {
      hasBars: true,
      rightEdgeIdx: list.length - 1 + rightMarginBars,
      barsPerPx: defaultBarsPerPx
    };
  });

  function distRToBarIndex(distR: number): number {
    if (!barScale.hasBars || bars.length === 0) return -1;
    const rawIdx = Math.round(barScale.rightEdgeIdx - distR * barScale.barsPerPx);
    return Math.max(0, Math.min(bars.length - 1, rawIdx));
  }

  function distRToTimestamp(distR: number): number {
    if (barScale.hasBars && bars.length > 0) {
      const idx = distRToBarIndex(distR);
      return bars[idx].ts;
    }
    const step = barSec || intervalToFallbackSec(interval);
    const nowSec = Math.floor(Date.now() / 1000);
    const alignedNow = Math.floor(nowSec / step) * step;
    const barsBack = Math.max(0, Math.round(distR * barScale.barsPerPx));
    return alignedNow - barsBack * step;
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

  const startTs = $derived(hasVisibleBand ? distRToTimestamp(activeStartDistR) : 0);
  const endTs = $derived(hasVisibleBand ? distRToTimestamp(activeEndDistR) : 0);
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
    const i1 = distRToBarIndex(activeStartDistR);
    const i2 = distRToBarIndex(activeEndDistR);
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

    if (bandWidth >= insideThreshold) {
      left = activeStartX + (bandWidth - POPOVER_W) / 2;
      top = PLOT_TOP_PX + Math.max(24, Math.min(92, Math.round(plotHeight * 0.16)));
    } else if (activeEndX + gap + POPOVER_W <= plotRight - 6) {
      left = activeEndX + gap;
      top = PLOT_TOP_PX + Math.max(24, Math.min(plotHeight - POPOVER_H - 16, Math.round(plotHeight * 0.28)));
    } else if (activeStartX - gap - POPOVER_W >= plotLeft + 6) {
      left = activeStartX - gap - POPOVER_W;
      top = PLOT_TOP_PX + Math.max(24, Math.min(plotHeight - POPOVER_H - 16, Math.round(plotHeight * 0.28)));
    } else {
      left = plotLeft + (plotWidth - POPOVER_W) / 2;
      top = PLOT_TOP_PX + Math.max(16, Math.min(plotHeight - POPOVER_H - 16, Math.round(plotHeight * 0.2)));
    }

    return {
      left: Math.round(Math.max(plotLeft + 6, Math.min(plotRight - POPOVER_W - 6, left))),
      top: Math.round(Math.max(PLOT_TOP_PX + 10, Math.min(plotBottom - POPOVER_H - 10, top)))
    };
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

  function xToDistR(xPx: number): number {
    return Math.max(0, plotRight - xPx);
  }

  function resetSelection() {
    activeAbort?.abort();
    activeAbort = null;
    phase = 'idle';
    anchorDistR = null;
    hoverDistR = null;
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
    const curW = overlayRootEl ? Math.round(overlayRootEl.clientWidth || paneWidth) : paneWidth;
    const curH = overlayRootEl ? Math.round(overlayRootEl.clientHeight || paneHeight) : paneHeight;
    paneWidth = curW;
    paneHeight = curH;

    const curPlotLeft =
      legendSlot && legendSlot.left > 12 && legendSlot.left < 120
        ? Math.max(0, Math.round(legendSlot.left - 10))
        : leftToolbarCollapsed
          ? 2
          : 52;
    const curPlotRight = Math.max(curPlotLeft + 120, curW - PRICE_AXIS_WIDTH_PX);
    const curPlotWidth = Math.max(120, curPlotRight - curPlotLeft);
    const curPlotBottom = Math.max(PLOT_TOP_PX + 100, curH - PLOT_BOTTOM_INSET_PX);
    initialCalibrationPlotWidth = curPlotWidth;

    phase = 'selecting-start';
    anchorDistR = null;
    hoverDistR = null;
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

    // 2. Background time-axis calibration from TradingView's actual bottom 28px X-axis strip!
    const host = overlayRootEl;
    if (host) {
      const stripY = Math.max(PLOT_TOP_PX, curPlotBottom - 2);
      const stripH = Math.max(24, curH - stripY);
      void captureElementRegion(host, {
        x: curPlotLeft,
        y: stripY,
        width: curPlotWidth,
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
        ).then((anchors: CalibratedAxisAnchor[]) => {
          if (controller.signal.aborted || anchors.length < 2) return;
          // Convert each xRatio into pixel distance from plotRight at capture time!
          calibratedAnchors = anchors.map((a) => ({
            distR: (1 - a.xRatio) * curPlotWidth,
            ts: a.ts,
            label: a.label
          }));
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
    const dr = xToDistR(lx);

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
      anchorDistR = dr;
      hoverDistR = dr;
      pointerDownX = lx;
      isPointerDraggingNew = true;
      phase = 'selecting-end';
      return;
    }

    if (phase === 'selecting-end' && anchorDistR !== null) {
      e.preventDefault();
      e.stopPropagation();
      finalizeRange(anchorDistR, dr);
    }
  }

  function handleCanvasPointerMove(e: PointerEvent) {
    if (dragHandle) {
      const dr = xToDistR(getLocalX(e));
      if (dragHandle === 'start') {
        startDistR = dr;
      } else {
        endDistR = dr;
      }
      return;
    }

    if (phase === 'selecting-start' || phase === 'selecting-end') {
      hoverDistR = xToDistR(getLocalX(e));
    }
  }

  function handleCanvasPointerUp(e: PointerEvent) {
    if (dragHandle) {
      const loD = Math.max(startDistR, endDistR); // left/start
      const hiD = Math.min(startDistR, endDistR); // right/end
      if (loD - hiD < 12) {
        startDistR = loD;
        endDistR = Math.max(0, loD - 16);
      } else {
        startDistR = loD;
        endDistR = hiD;
      }
      dragHandle = null;
      return;
    }

    if (isPointerDraggingNew && phase === 'selecting-end' && anchorDistR !== null) {
      isPointerDraggingNew = false;
      const lx = getLocalX(e);
      if (Math.abs(lx - pointerDownX) > 14) {
        finalizeRange(anchorDistR, xToDistR(lx));
      }
    }
  }

  function finalizeRange(d1: number, d2: number) {
    let leftD = Math.max(d1, d2);
    let rightD = Math.min(d1, d2);
    if (leftD - rightD < 14) {
      rightD = Math.max(2, leftD - 28);
      if (leftD - rightD < 14) leftD = Math.min(plotWidth - 2, rightD + 28);
    }
    startDistR = leftD;
    endDistR = rightD;
    phase = 'selected';
    popoverCollapsed = false;
    isPointerDraggingNew = false;
  }

  function startHandleResize(which: 'start' | 'end', e: PointerEvent) {
    if (e.button !== 0 || phase !== 'selected') return;
    e.preventDefault();
    e.stopPropagation();
    const leftD = Math.max(startDistR, endDistR);
    const rightD = Math.min(startDistR, endDistR);
    startDistR = leftD;
    endDistR = rightD;
    dragHandle = which;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function endHandleResize(e: PointerEvent) {
    if (!dragHandle) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const leftD = Math.max(startDistR, endDistR);
    const rightD = Math.min(startDistR, endDistR);
    if (leftD - rightD < 12) {
      startDistR = leftD;
      endDistR = Math.max(2, leftD - 16);
    } else {
      startDistR = leftD;
      endDistR = rightD;
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
    // the full purple/blue range highlight & unobstructed candlesticks inside the range
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
  <!-- Live Hover Vertical Guide Line while picking Start Point -->
  {#if phase === 'selecting-start' && hoverX !== null}
    <div
      class="hover-guide-line"
      style:left="{hoverX}px"
      style:top="{PLOT_TOP_PX}px"
      style:height="{plotHeight}px"
    ></div>
  {/if}

  <!-- Highlighted Range Band, Gradient Vertical Lines, Midpoint □ Handles & Flush Time Axis Pills -->
  {#if hasVisibleBand}
    <div
      class="range-band"
      style:left="{activeStartX}px"
      style:top="{PLOT_TOP_PX}px"
      style:width="{bandWidth}px"
      style:height="{plotHeight}px"
    ></div>

    <!-- Start Vertical Gradient Line (hidden only if scrolled past left viewport edge) -->
    {#if !startClippedLeft}
      <div
        class="range-edge-line"
        style:left="{activeStartX}px"
        style:top="{PLOT_TOP_PX}px"
        style:height="{plotHeight}px"
      ></div>
    {/if}

    <!-- End Vertical Gradient Line -->
    <div
      class="range-edge-line"
      style:left="{activeEndX}px"
      style:top="{PLOT_TOP_PX}px"
      style:height="{plotHeight}px"
    ></div>

    <!-- Midpoint Draggable □ Resize Handles -->
    {#if phase === 'selected'}
      {#if !startClippedLeft}
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
      {/if}

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

    <!-- Time Axis Connector Tint & Flush Blue Timestamp Pills -->
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

  <!-- Bottom Floating Guide Tooltip -->
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
        Math.max(plotLeft + 8, Math.min(plotRight - 134, (activeStartX + activeEndX) / 2 - 58))
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

  <!-- Range Action Popover (Inside or Outside as in TradingView Reference) -->
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

  /* Time Axis Highlight Strip + Flush Royal-Blue Timestamp Pills */
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
