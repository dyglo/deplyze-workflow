<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { getApiBaseUrl } from '../workspace/storage';
  import {
    computePnlUsd,
    formatPaperPrice,
    formatQty,
    formatSplitPrice,
    formatUsd,
    getPaperInstrumentSpec,
    normalizeSymbolKey,
    roundToTick
  } from './instruments';
  import {
    cancelWorkingOrder,
    computePositionMetrics,
    getActivePaperAccount,
    modifyPositionBrackets,
    placePaperOrder,
    pushOrderDraft,
    removePositionBracket,
    reversePaperPosition,
    subscribePaper,
    subscribePaperQuotes
  } from './store';
  import type { PaperLedgerState, PaperLiveQuote, PaperPosition } from './types';

  interface Props {
    theme: 'dark' | 'light';
    symbol: string;
    shortName: string;
    interval?: string;
    leftToolbarCollapsed?: boolean;
    legendSlot?: { top: number; left: number } | null;
    onDockOffsetChange?: (offsetPx: number) => void;
    onRequestClosePosition: (position: PaperPosition) => void;
    onRequestModifyPosition: (position: PaperPosition, focusField?: 'tp' | 'sl' | null) => void;
  }

  let {
    theme,
    symbol,
    shortName,
    interval = '1H',
    leftToolbarCollapsed = false,
    legendSlot = null,
    onDockOffsetChange,
    onRequestClosePosition,
    onRequestModifyPosition
  }: Props = $props();

  // TradingView iframe top toolbar = 38px, bottom timeframe/date axis = 64px
  const PLOT_TOP_PX = 44;
  const PLOT_BOTTOM_PX = 68;

  let ledger = $state<PaperLedgerState | null>(null);
  let quotes = $state<Record<string, PaperLiveQuote>>({});
  let pillsCollapsed = $state(false);
  let showVisualOverlay = $state(true);

  let paneHostEl: HTMLDivElement | undefined = $state();
  let paneHeight = $state(540);

  // Visible Y-axis price scale calibration:
  // 1. visibleBarHigh & visibleBarLow from the pane's active (symbol, interval) OHLC bars
  // 2. detectedLastPriceY from scanning TradingView's green/red current-price pill on the right price axis
  // 3. manualOffsetY if the user manually drags the entry pill vertically
  let visibleBarHigh = $state<number | null>(null);
  let visibleBarLow = $state<number | null>(null);
  let detectedLastPriceY = $state<number | null>(null);
  let detectedAtPrice = $state<number | null>(null);
  let manualOffsetY = $state(0);

  // Staged TP / SL confirmation state (TradingView ✓ / ↩ workflow)
  let stagedTp = $state<number | null | undefined>(undefined); // undefined = untouched
  let stagedSl = $state<number | null | undefined>(undefined); // undefined = untouched
  let activeDragKind = $state<'tp' | 'sl' | 'move' | null>(null);
  let dragStartY = 0;
  let dragStartOffsetY = 0;
  let dragMoved = false;
  let stageError = $state<string | null>(null);

  const symKey = $derived(normalizeSymbolKey(symbol || shortName));
  const spec = $derived(getPaperInstrumentSpec(symbol));
  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);
  const liveQuote = $derived(quotes[symKey] ?? null);

  const visible = $derived(
    Boolean(ledger?.connected && account?.settings.showOnChart && liveQuote && liveQuote.last > 0)
  );

  const panePosition = $derived.by(() => {
    if (!account) return null;
    return account.positions.find((p) => normalizeSymbolKey(p.symbol) === symKey) ?? null;
  });

  const panePosMetrics = $derived(
    panePosition && account
      ? computePositionMetrics(
          panePosition,
          quotes,
          account.settings.leverage,
          account.settings.zeroSpread
        )
      : null
  );

  const paneOrders = $derived.by(() => {
    if (!account) return [];
    return account.orders.filter((o) => normalizeSymbolKey(o.symbol) === symKey);
  });

  const bidParts = $derived(formatSplitPrice(liveQuote?.bid, symbol));
  const askParts = $derived(formatSplitPrice(liveQuote?.ask, symbol));

  // Compute exact vertical space to reserve beneath TradingView's symbol title row so
  // indicator rows (e.g. EMA 50) and the collapse chevron flow cleanly below Sell/Buy!
  const dockReservePx = $derived.by(() => {
    if (!visible || !liveQuote || pillsCollapsed) return 0;
    const baseRow = 44;
    const ordersExtra = paneOrders.length > 0 ? paneOrders.length * 27 + 4 : 0;
    return baseRow + ordersExtra;
  });

  const dockTopPx = $derived(legendSlot ? legendSlot.top : 70);
  const dockLeftPx = $derived(legendSlot ? legendSlot.left : leftToolbarCollapsed ? 14 : 61);

  let lastReportedDockPx = -1;
  $effect(() => {
    const next = dockReservePx;
    if (next === lastReportedDockPx) return;
    lastReportedDockPx = next;
    untrack(() => {
      onDockOffsetChange?.(next);
    });
  });

  onDestroy(() => {
    if (lastReportedDockPx !== 0) {
      lastReportedDockPx = 0;
      onDockOffsetChange?.(0);
    }
  });

  // Clear staged edits if position changes or closes
  let lastTrackedPosId = '';
  $effect(() => {
    const pid = panePosition?.id ?? '';
    if (pid !== lastTrackedPosId) {
      lastTrackedPosId = pid;
      stagedTp = undefined;
      stagedSl = undefined;
      stageError = null;
      manualOffsetY = 0;
    }
  });

  // Fetch visible OHLC range whenever (symbol, interval) changes
  let lastScaleFetchKey = '';
  $effect(() => {
    const key = `${symKey}:${interval}`;
    if (!symKey || key === lastScaleFetchKey) return;
    lastScaleFetchKey = key;
    detectedLastPriceY = null;
    detectedAtPrice = null;
    manualOffsetY = 0;
    void fetchVisibleBarRange(symbol, interval);
  });

  async function fetchVisibleBarRange(sym: string, ivl: string) {
    try {
      const base = getApiBaseUrl();
      const url = `${base}/api/quotes/bars?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(ivl)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as {
        bars?: { high: number; low: number; close: number }[];
      };
      const bars = json.bars ?? [];
      if (bars.length < 3) return;
      let hi = -Infinity;
      let lo = Infinity;
      for (const b of bars) {
        if (Number.isFinite(b.high) && b.high > hi) hi = b.high;
        if (Number.isFinite(b.low) && b.low < lo) lo = b.low;
      }
      if (hi > lo && Number.isFinite(hi) && Number.isFinite(lo)) {
        visibleBarHigh = hi;
        visibleBarLow = lo;
      }
    } catch {
      // fallback to price-percentage range
    }
  }

  /**
   * Native Windows WebView2 price-axis detector:
   * Captures the rightmost 58px price-axis column of this chart pane and locates
   * TradingView's solid green (#089981) or solid red (#f23645) current-price tag.
   */
  let detectInFlight = false;
  async function detectLivePriceYOnAxis() {
    if (!isTauri() || detectInFlight || !paneHostEl || !liveQuote || !panePosition) return;
    const rect = paneHostEl.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 160) return;

    detectInFlight = true;
    const snapPrice = liveQuote.last;
    try {
      const stripW = 56;
      const captured = await invoke<{
        dataUrl: string;
        width: number;
        height: number;
      }>('capture_chart_region', {
        region: {
          x: Math.max(0, rect.right - stripW - 2),
          y: Math.max(0, rect.top),
          width: stripW,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        }
      });

      if (!captured?.dataUrl) return;

      const img = new Image();
      const loaded = await new Promise<boolean>((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = captured.dataUrl;
      });
      if (!loaded || img.width < 8 || img.height < 60) return;

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const { data, width: cw, height: ch } = ctx.getImageData(0, 0, img.width, img.height);

      const minY = Math.round(ch * 0.09);
      const maxY = Math.round(ch * 0.88);
      let bestRow = -1;
      let bestScore = 0;

      // Scan rows for a solid green or red price-axis badge
      for (let y = minY; y < maxY; y++) {
        let coloredCount = 0;
        for (let x = 2; x < cw - 2; x++) {
          const idx = (y * cw + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          // TradingView green badge (#089981) or red badge (#f23645)
          const isTvGreen = g > 115 && g > r + 40 && b > 80 && r < 75;
          const isTvRed = r > 180 && r > g + 70 && r > b + 65 && g < 95;
          if (isTvGreen || isTvRed) {
            coloredCount += 1;
          }
        }
        if (coloredCount >= cw * 0.32 && coloredCount > bestScore) {
          bestScore = coloredCount;
          bestRow = y;
        }
      }

      if (bestRow >= minY) {
        // Find contiguous vertical center of the badge (~19px tall)
        let topR = bestRow;
        let botR = bestRow;
        while (topR > minY && topR > bestRow - 14) {
          let cnt = 0;
          for (let x = 2; x < cw - 2; x++) {
            const idx = ((topR - 1) * cw + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            if ((g > 115 && g > r + 40 && r < 75) || (r > 180 && r > g + 70 && g < 95)) cnt++;
          }
          if (cnt >= cw * 0.25) topR--;
          else break;
        }
        while (botR < maxY && botR < bestRow + 14) {
          let cnt = 0;
          for (let x = 2; x < cw - 2; x++) {
            const idx = ((botR + 1) * cw + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            if ((g > 115 && g > r + 40 && r < 75) || (r > 180 && r > g + 70 && g < 95)) cnt++;
          }
          if (cnt >= cw * 0.25) botR++;
          else break;
        }
        const centerRatio = (topR + botR) / 2 / ch;
        detectedLastPriceY = Math.round(centerRatio * rect.height);
        detectedAtPrice = snapPrice;
      }
    } catch {
      // fallback to OHLC scale
    } finally {
      detectInFlight = false;
    }
  }

  // Trigger axis detection when position opens or symbol/interval changes
  $effect(() => {
    if (visible && panePosition && paneHostEl) {
      paneHeight = paneHostEl.clientHeight || 540;
      const t = setTimeout(() => {
        void detectLivePriceYOnAxis();
      }, 180);
      return () => clearTimeout(t);
    }
  });

  onMount(() => {
    const unsub1 = subscribePaper((s) => {
      ledger = s;
    });
    const unsub2 = subscribePaperQuotes((q) => {
      quotes = q;
    });

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (cr && cr.height > 100) {
          paneHeight = cr.height;
        }
      });
    }

    const pollAxisTimer = setInterval(() => {
      if (visible && panePosition && activeDragKind === null) {
        void detectLivePriceYOnAxis();
      }
    }, 3500);

    return () => {
      unsub1();
      unsub2();
      ro?.disconnect();
      clearInterval(pollAxisTimer);
    };
  });

  $effect(() => {
    if (paneHostEl) {
      paneHeight = paneHostEl.clientHeight || 540;
    }
  });

  // ── Real Y-Axis Coordinate Mapper (Price <-> Y Pixel) ──────────────────────
  const axisScale = $derived.by(() => {
    const curPrice = liveQuote?.last ?? panePosition?.avgFillPrice ?? 100;
    const entryPrice = panePosition?.avgFillPrice ?? curPrice;
    const plotH = Math.max(140, paneHeight - PLOT_TOP_PX - PLOT_BOTTOM_PX);

    let hi =
      visibleBarHigh !== null && Number.isFinite(visibleBarHigh)
        ? Math.max(visibleBarHigh, curPrice, entryPrice)
        : Math.max(curPrice, entryPrice) * 1.008;
    let lo =
      visibleBarLow !== null && Number.isFinite(visibleBarLow)
        ? Math.min(visibleBarLow, curPrice, entryPrice)
        : Math.min(curPrice, entryPrice) * 0.992;

    const rawSpan = Math.max(spec.pipSize * 40, hi - lo);
    // TradingView default 8% vertical padding above high and below low
    const topPrice = hi + rawSpan * 0.085;
    const bottomPrice = lo - rawSpan * 0.085;
    const fullSpan = Math.max(spec.pipSize * 50, topPrice - bottomPrice);
    const pxPerPrice = plotH / fullSpan;

    // Base Y for curPrice from OHLC scale
    const ohlcCurY = PLOT_TOP_PX + ((topPrice - curPrice) / fullSpan) * plotH;

    // If native price-axis detector locked onto TradingView's green/red price badge, anchor to it!
    const anchorPrice = detectedAtPrice ?? curPrice;
    const anchorY =
      detectedLastPriceY !== null
        ? detectedLastPriceY
        : ohlcCurY;

    return {
      plotH,
      pxPerPrice,
      anchorPrice,
      anchorY
    };
  });

  function priceToY(price: number): number {
    const { pxPerPrice, anchorPrice, anchorY } = axisScale;
    const rawY = anchorY + (anchorPrice - price) * pxPerPrice + manualOffsetY;
    const minY = PLOT_TOP_PX + 10;
    const maxY = Math.max(minY + 40, paneHeight - PLOT_BOTTOM_PX - 10);
    return Math.round(Math.max(minY, Math.min(maxY, rawY)));
  }

  function yToPrice(yPx: number): number {
    const { pxPerPrice, anchorPrice, anchorY } = axisScale;
    const rawPrice = anchorPrice + (anchorY + manualOffsetY - yPx) / pxPerPrice;
    return roundToTick(Math.max(spec.tickSize, rawPrice), symbol);
  }

  // Has user staged an unconfirmed TP or SL change?
  const hasStagedChanges = $derived(stagedTp !== undefined || stagedSl !== undefined);

  // Effective displayed TP & SL (staged value takes precedence over saved position value)
  const displayTp = $derived(
    stagedTp !== undefined ? stagedTp : (panePosition?.takeProfit ?? null)
  );
  const displaySl = $derived(
    stagedSl !== undefined ? stagedSl : (panePosition?.stopLoss ?? null)
  );

  // Compute exact Y pixel coordinates for Entry, TP, and SL
  const entryY = $derived(panePosition ? priceToY(panePosition.avgFillPrice) : 260);

  const tpY = $derived.by(() => {
    if (!panePosition) return 220;
    if (displayTp !== null) return priceToY(displayTp);
    // When unset, park the [⋮⋮ TP] handle 32px on the profit side of the entry line
    return panePosition.side === 'long' ? Math.max(PLOT_TOP_PX + 4, entryY - 32) : Math.min(paneHeight - PLOT_BOTTOM_PX - 4, entryY + 32);
  });

  const slY = $derived.by(() => {
    if (!panePosition) return 300;
    if (displaySl !== null) return priceToY(displaySl);
    // When unset, park the [⋮⋮ SL] handle 32px on the loss side of the entry line
    return panePosition.side === 'long' ? Math.min(paneHeight - PLOT_BOTTOM_PX - 4, entryY + 32) : Math.max(PLOT_TOP_PX + 4, entryY - 32);
  });

  const tpProjectedUsd = $derived(
    panePosition && displayTp !== null
      ? computePnlUsd(
          panePosition.symbol,
          panePosition.side,
          panePosition.quantity,
          panePosition.avgFillPrice,
          displayTp
        )
      : null
  );

  const slProjectedUsd = $derived(
    panePosition && displaySl !== null
      ? computePnlUsd(
          panePosition.symbol,
          panePosition.side,
          panePosition.quantity,
          panePosition.avgFillPrice,
          displaySl
        )
      : null
  );

  function handleQuickSide(side: 'buy' | 'sell') {
    if (!account || !liveQuote) return;
    if (account.settings.oneClickTrading) {
      placePaperOrder({
        symbol,
        shortName,
        side,
        type: 'market',
        quantity: spec.qtyStep
      });
      return;
    }
    pushOrderDraft({
      symbol,
      shortName,
      side,
      type: 'market',
      source: 'chart'
    });
  }

  // ── Dragging TP / SL & Staged ✓ Confirmation Flow ──────────────────────────
  function startBracketDrag(kind: 'tp' | 'sl', e: PointerEvent) {
    if (e.button !== 0 || !panePosition || !liveQuote) return;
    e.stopPropagation();
    e.preventDefault();

    activeDragKind = kind;
    dragStartY = e.clientY;
    dragMoved = false;
    stageError = null;

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moveBracketDrag(e: PointerEvent) {
    if (!activeDragKind || !panePosition || !liveQuote || !paneHostEl) return;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dy) > 3) dragMoved = true;

    if (activeDragKind === 'move') {
      manualOffsetY = Math.round(dragStartOffsetY + dy);
      return;
    }

    if (!dragMoved) return;

    const rect = paneHostEl.getBoundingClientRect();
    const localY = Math.max(
      PLOT_TOP_PX + 8,
      Math.min(paneHeight - PLOT_BOTTOM_PX - 8, e.clientY - rect.top)
    );
    let candidatePrice = yToPrice(localY);

    // Clamp to valid profit/loss side of current price
    const curRef = liveQuote.last;
    const minBuf = Math.max(spec.pipSize, spec.tickSize * 5);
    const isLong = panePosition.side === 'long';

    if (activeDragKind === 'tp') {
      candidatePrice = isLong
        ? Math.max(curRef + minBuf, candidatePrice)
        : Math.min(curRef - minBuf, candidatePrice);
      stagedTp = roundToTick(Math.max(spec.tickSize, candidatePrice), panePosition.symbol);
    } else {
      candidatePrice = isLong
        ? Math.min(curRef - minBuf, candidatePrice)
        : Math.max(curRef + minBuf, candidatePrice);
      stagedSl = roundToTick(Math.max(spec.tickSize, candidatePrice), panePosition.symbol);
    }
  }

  function endBracketDrag(e: PointerEvent) {
    if (!activeDragKind || !panePosition) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

    const kind = activeDragKind;
    const moved = dragMoved;
    activeDragKind = null;

    if (kind === 'move') return;

    if (!moved) {
      // Single click without drag -> open Modify Position modal focused on TP or SL
      onRequestModifyPosition(panePosition, kind);
    }
    // When dragged, stagedTp / stagedSl remains set so the user sees the ✓ Confirm and ↩ Undo buttons!
  }

  function startMoveEntryLine(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    activeDragKind = 'move';
    dragStartY = e.clientY;
    dragStartOffsetY = manualOffsetY;
    dragMoved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function confirmStagedBrackets() {
    if (!panePosition) return;
    stageError = null;
    const nextTp = stagedTp !== undefined ? stagedTp : panePosition.takeProfit;
    const nextSl = stagedSl !== undefined ? stagedSl : panePosition.stopLoss;
    const res = modifyPositionBrackets(panePosition.id, nextTp, nextSl);
    if (!res.ok) {
      stageError = res.error ?? 'Invalid TP/SL level';
      return;
    }
    stagedTp = undefined;
    stagedSl = undefined;
  }

  function discardStagedBrackets() {
    stagedTp = undefined;
    stagedSl = undefined;
    stageError = null;
  }

  function removeOrUnstageBracket(which: 'tp' | 'sl') {
    if (!panePosition) return;
    if (which === 'tp') {
      if (panePosition.takeProfit === null) {
        stagedTp = undefined;
      } else {
        removePositionBracket(panePosition.id, 'tp');
        stagedTp = undefined;
      }
    } else {
      if (panePosition.stopLoss === null) {
        stagedSl = undefined;
      } else {
        removePositionBracket(panePosition.id, 'sl');
        stagedSl = undefined;
      }
    }
  }
</script>

{#if visible && liveQuote}
  <div
    bind:this={paneHostEl}
    class="pane-overlay-root"
    class:light={theme === 'light'}
    class:compact-left={leftToolbarCollapsed}
  >
    <!-- Top-Left Buy/Sell Pills + Working Entry Orders -->
    <div
      class="top-left-dock"
      class:collapsed={pillsCollapsed}
      style:top="{dockTopPx}px"
      style:left="{dockLeftPx}px"
    >
      <div class="bs-row">
        {#if !pillsCollapsed}
          <button
            class="bs-pill sell"
            type="button"
            title={account?.settings.oneClickTrading
              ? 'Instant Market Sell (1-click enabled)'
              : 'Open Sell order ticket'}
            onclick={() => handleQuickSide('sell')}
          >
            <span class="bs-price">
              {bidParts.main}{#if bidParts.pipette}<sup>{bidParts.pipette}</sup>{/if}
            </span>
            <span class="bs-lbl">SELL</span>
          </button>

          <span class="bs-spread" title="Current Bid/Ask spread">{liveQuote.spreadDisplay}</span>

          <button
            class="bs-pill buy"
            type="button"
            title={account?.settings.oneClickTrading
              ? 'Instant Market Buy (1-click enabled)'
              : 'Open Buy order ticket'}
            onclick={() => handleQuickSide('buy')}
          >
            <span class="bs-price">
              {askParts.main}{#if askParts.pipette}<sup>{askParts.pipette}</sup>{/if}
            </span>
            <span class="bs-lbl">BUY</span>
          </button>
        {/if}

        <div class="dock-controls" class:always-visible={pillsCollapsed || !showVisualOverlay}>
          <button
            class="mini-ctrl"
            type="button"
            title={pillsCollapsed ? 'Show Buy/Sell buttons' : 'Hide Buy/Sell buttons'}
            aria-label={pillsCollapsed ? 'Show Buy/Sell buttons' : 'Hide Buy/Sell buttons'}
            onclick={() => (pillsCollapsed = !pillsCollapsed)}
          >
            <svg class:flipped={pillsCollapsed} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 7.5 6 4.5 9 7.5" />
            </svg>
          </button>

          {#if panePosition}
            <button
              class="mini-ctrl text-ctrl"
              class:off={!showVisualOverlay}
              type="button"
              title={showVisualOverlay
                ? 'Hide on-chart position & TP/SL overlay'
                : 'Show on-chart position & TP/SL overlay'}
              onclick={() => (showVisualOverlay = !showVisualOverlay)}
            >
              {showVisualOverlay ? 'Hide Overlay' : 'Show Position'}
            </button>
          {/if}
        </div>
      </div>

      {#if !pillsCollapsed && paneOrders.length > 0}
        <div class="working-orders-stack">
          {#each paneOrders as ord (ord.id)}
            <div class="ord-badge" class:buy={ord.side === 'buy'} class:sell={ord.side === 'sell'}>
              <span class="seg side-pill">{ord.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span class="seg ord-info">
                {formatQty(ord.quantity)} {ord.type === 'limit' ? 'Limit' : 'Stop'} @ {formatPaperPrice(ord.orderPrice, symbol)}
              </span>
              {#if ord.takeProfit !== null}
                <span class="seg mini-tag tp">TP</span>
              {/if}
              {#if ord.stopLoss !== null}
                <span class="seg mini-tag sl">SL</span>
              {/if}
              <button
                class="seg-btn close"
                type="button"
                title="Cancel working order"
                aria-label="Cancel order"
                onclick={() => cancelWorkingOrder(ord.id)}
              >
                ×
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Y-Axis Aligned TradingView Position + Staged Draggable TP/SL Overlay -->
    {#if panePosition && panePosMetrics && showVisualOverlay}
      {@const isLong = panePosition.side === 'long'}
      {@const tpBoxTop = Math.min(entryY, tpY)}
      {@const tpBoxHeight = Math.abs(tpY - entryY)}
      {@const slBoxTop = Math.min(entryY, slY)}
      {@const slBoxHeight = Math.abs(slY - entryY)}

      <div class="y-canvas-layer" class:long={isLong} class:short={!isLong}>
        <!-- Shaded Green Take Profit Zone (between Entry Y and TP Y) -->
        {#if displayTp !== null && tpBoxHeight > 2}
          <div
            class="shaded-zone tp-zone"
            style:top="{tpBoxTop}px"
            style:height="{tpBoxHeight}px"
          ></div>
        {/if}

        <!-- Shaded Amber Stop Loss Zone (between Entry Y and SL Y) -->
        {#if displaySl !== null && slBoxHeight > 2}
          <div
            class="shaded-zone sl-zone"
            style:top="{slBoxTop}px"
            style:height="{slBoxHeight}px"
          ></div>
        {/if}

        <!-- TAKE PROFIT LINE & DRAG HANDLE -->
        <div
          class="level-row tp-row"
          class:active={displayTp !== null}
          class:staged={stagedTp !== undefined}
          style:top="{tpY}px"
        >
          {#if displayTp !== null}
            <div class="level-line tp-line"></div>
            <div class="level-price-tag tp-tag">
              {formatPaperPrice(displayTp, symbol)}
            </div>
          {/if}

          <div class="handle-cluster">
            {#if displayTp !== null}
              <button
                class="circle-rm tp"
                type="button"
                title="Remove Take Profit"
                aria-label="Remove Take Profit"
                onclick={(e) => {
                  e.stopPropagation();
                  removeOrUnstageBracket('tp');
                }}
              >
                −
              </button>
            {/if}

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="bracket-pill tp"
              class:set={displayTp !== null}
              class:dragging={activeDragKind === 'tp'}
              onpointerdown={(e) => startBracketDrag('tp', e)}
              onpointermove={moveBracketDrag}
              onpointerup={endBracketDrag}
              onpointercancel={endBracketDrag}
            >
              <span class="grip-dots" aria-hidden="true">⋮⋮</span>
              {#if displayTp !== null}
                <span class="bp-qty">{formatQty(panePosition.quantity)}</span>
                <span class="bp-val">
                  {tpProjectedUsd !== null ? `${formatUsd(tpProjectedUsd, true)} USD` : 'TP'}
                </span>
              {:else}
                <span class="bp-empty-lbl">TP</span>
                <span class="drag-tip">Drag to add take profit</span>
              {/if}
            </div>

            {#if stagedTp !== undefined}
              <button
                class="circle-confirm-inline tp"
                type="button"
                title="Confirm Take Profit"
                aria-label="Confirm Take Profit"
                onclick={(e) => {
                  e.stopPropagation();
                  confirmStagedBrackets();
                }}
              >
                ✓
              </button>
            {/if}
          </div>
        </div>

        <!-- STOP LOSS LINE & DRAG HANDLE -->
        <div
          class="level-row sl-row"
          class:active={displaySl !== null}
          class:staged={stagedSl !== undefined}
          style:top="{slY}px"
        >
          {#if displaySl !== null}
            <div class="level-line sl-line"></div>
            <div class="level-price-tag sl-tag">
              {formatPaperPrice(displaySl, symbol)}
            </div>
          {/if}

          <div class="handle-cluster">
            {#if displaySl !== null}
              <button
                class="circle-rm sl"
                type="button"
                title="Remove Stop Loss"
                aria-label="Remove Stop Loss"
                onclick={(e) => {
                  e.stopPropagation();
                  removeOrUnstageBracket('sl');
                }}
              >
                −
              </button>
            {/if}

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="bracket-pill sl"
              class:set={displaySl !== null}
              class:dragging={activeDragKind === 'sl'}
              onpointerdown={(e) => startBracketDrag('sl', e)}
              onpointermove={moveBracketDrag}
              onpointerup={endBracketDrag}
              onpointercancel={endBracketDrag}
            >
              <span class="grip-dots" aria-hidden="true">⋮⋮</span>
              {#if displaySl !== null}
                <span class="bp-qty">{formatQty(panePosition.quantity)}</span>
                <span class="bp-val">
                  {slProjectedUsd !== null ? `${formatUsd(slProjectedUsd, true)} USD` : 'SL'}
                </span>
              {:else}
                <span class="bp-empty-lbl">SL</span>
                <span class="drag-tip">Drag to add stop loss</span>
              {/if}
            </div>

            {#if stagedSl !== undefined}
              <button
                class="circle-confirm-inline sl"
                type="button"
                title="Confirm Stop Loss"
                aria-label="Confirm Stop Loss"
                onclick={(e) => {
                  e.stopPropagation();
                  confirmStagedBrackets();
                }}
              >
                ✓
              </button>
            {/if}
          </div>
        </div>

        <!-- ENTRY LINE & POSITION WIN/LOSS PILL (with ↩ Undo & ✓ Confirm when TP/SL dragged!) -->
        <div class="level-row entry-row" style:top="{entryY}px">
          <div class="level-line entry-line"></div>

          <div class="handle-cluster entry-cluster">
            {#if hasStagedChanges}
              <!-- TradingView Staged Bracket Confirmation Buttons (Screenshots 6 & 8) -->
              <button
                class="circle-act undo-stage"
                type="button"
                title="Discard dragged TP/SL changes"
                aria-label="Discard dragged TP/SL changes"
                onclick={discardStagedBrackets}
              >
                ↩
              </button>

              <button
                class="circle-act confirm-stage"
                type="button"
                title="Confirm TP/SL order"
                aria-label="Confirm TP/SL order"
                onclick={confirmStagedBrackets}
              >
                ✓
              </button>
            {:else}
              <button
                class="circle-act close-pos"
                type="button"
                title="Close position"
                aria-label="Close position"
                onclick={() => onRequestClosePosition(panePosition)}
              >
                ×
              </button>

              <button
                class="circle-act rev-pos"
                type="button"
                title="Reverse position"
                aria-label="Reverse position"
                onclick={() => reversePaperPosition(panePosition.id)}
              >
                ⇅
              </button>
            {/if}

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="tv-pos-pill"
              class:long={isLong}
              class:short={!isLong}
              title="Drag vertically to fine-tune chart alignment · Double-click to open TP/SL dialog"
              onpointerdown={startMoveEntryLine}
              onpointermove={moveBracketDrag}
              onpointerup={endBracketDrag}
              onpointercancel={endBracketDrag}
              ondblclick={() => onRequestModifyPosition(panePosition, null)}
            >
              <span class="pos-qty-cap">
                {isLong ? '+' : '−'}{formatQty(panePosition.quantity)}
              </span>
              <span
                class="pos-pnl-body"
                class:win={panePosMetrics.unrealizedPnl > 0.004}
                class:loss={panePosMetrics.unrealizedPnl < -0.004}
              >
                {formatUsd(panePosMetrics.unrealizedPnl, true)} USD
                {#if panePosMetrics.liveR !== null}
                  <span class="pos-r">
                    ({panePosMetrics.liveR >= 0 ? '+' : ''}{panePosMetrics.liveR.toFixed(1)}R)
                  </span>
                {/if}
              </span>
            </div>
          </div>

          <button
            class="level-price-tag entry-tag"
            class:long={isLong}
            class:short={!isLong}
            type="button"
            title="Avg fill price · Click to edit TP/SL"
            onclick={() => onRequestModifyPosition(panePosition, null)}
          >
            {formatPaperPrice(panePosition.avgFillPrice, symbol)}
          </button>

          {#if stageError}
            <div class="stage-err-toast">{stageError}</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .pane-overlay-root {
    position: absolute;
    inset: 0;
    z-index: 6;
    pointer-events: none;
    user-select: none;
    overflow: hidden;
  }

  /* ── Top-Left Buy / Sell Pills ─────────────────────────────────────────── */
  .top-left-dock {
    position: absolute;
    top: 70px;
    left: 61px;
    z-index: 8;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    pointer-events: none;
  }

  .bs-row,
  .working-orders-stack,
  .dock-controls {
    pointer-events: auto;
  }

  .bs-row {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .bs-pill {
    min-width: 78px;
    height: 36px;
    padding: 3px 10px;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    font-family: inherit;
    cursor: pointer;
    transition: background-color 110ms ease, color 110ms ease, border-color 110ms ease;
  }

  .bs-pill.sell {
    background: #000000;
    border: 1px solid #f23645;
    color: #f23645;
  }

  .bs-pill.sell:hover {
    background: #f23645;
    border-color: #f23645;
    color: #ffffff;
  }

  .bs-pill.buy {
    background: #000000;
    border: 1px solid #2962ff;
    color: #2962ff;
  }

  .bs-pill.buy:hover {
    background: #2962ff;
    border-color: #2962ff;
    color: #ffffff;
  }

  .pane-overlay-root.light .bs-pill.sell {
    background: #ffffff;
    border-color: #f23645;
    color: #f23645;
  }

  .pane-overlay-root.light .bs-pill.sell:hover {
    background: #f23645;
    color: #ffffff;
  }

  .pane-overlay-root.light .bs-pill.buy {
    background: #ffffff;
    border-color: #2962ff;
    color: #2962ff;
  }

  .pane-overlay-root.light .bs-pill.buy:hover {
    background: #2962ff;
    color: #ffffff;
  }

  .bs-price {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }

  .bs-price sup {
    font-size: 8.5px;
    font-weight: 600;
    margin-left: 0.5px;
  }

  .bs-lbl {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .bs-spread {
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    padding: 0 2px;
    color: var(--dark-text-soft);
  }

  .pane-overlay-root.light .bs-spread {
    color: #131722;
  }

  .working-orders-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ord-badge {
    display: inline-flex;
    align-items: center;
    height: 23px;
    border-radius: 5px;
    overflow: hidden;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    background: rgba(18, 18, 18, 0.92);
    color: var(--dark-text-strong);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .ord-badge.buy {
    border: 1px dashed #2962ff;
  }

  .ord-badge.sell {
    border: 1px dashed #f23645;
  }

  .pane-overlay-root.light .ord-badge {
    background: rgba(255, 255, 255, 0.96);
    color: #131722;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.14);
  }

  .seg {
    height: 100%;
    padding: 0 7px;
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }

  .ord-badge.buy .seg.side-pill {
    background: #2962ff;
    color: #ffffff;
    font-weight: 700;
  }

  .ord-badge.sell .seg.side-pill {
    background: #f23645;
    color: #ffffff;
    font-weight: 700;
  }

  .seg.ord-info {
    color: var(--dark-text-soft);
    border-right: 1px solid var(--dark-border-subtle);
  }

  .pane-overlay-root.light .seg.ord-info {
    color: #4a5160;
    border-right-color: #e6e9ef;
  }

  .seg.mini-tag {
    font-size: 9.5px;
    font-weight: 700;
    padding: 0 5px;
    border-right: 1px solid var(--dark-border-subtle);
  }

  .seg.mini-tag.tp {
    color: #089981;
  }

  .seg.mini-tag.sl {
    color: #f59e0b;
  }

  .seg-btn.close {
    height: 100%;
    padding: 0 7px;
    border: 0;
    background: transparent;
    color: var(--dark-text-soft);
    font-size: 14px;
    cursor: pointer;
  }

  .seg-btn.close:hover {
    background: #f23645;
    color: #ffffff;
  }

  .dock-controls {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .bs-row:hover .dock-controls,
  .dock-controls.always-visible {
    opacity: 1;
  }

  .mini-ctrl {
    height: 18px;
    min-width: 22px;
    padding: 0 5px;
    border-radius: 4px;
    border: 1px solid var(--dark-border-glass);
    background: rgba(18, 18, 18, 0.84);
    color: var(--dark-text-soft);
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .mini-ctrl:hover {
    background: var(--dark-bg-elevated);
    color: var(--dark-text-strong);
  }

  .pane-overlay-root.light .mini-ctrl {
    background: rgba(255, 255, 255, 0.92);
    border-color: #d6dae1;
    color: #5d6473;
  }

  .mini-ctrl.text-ctrl.off {
    color: #2962ff;
    border-color: rgba(41, 98, 255, 0.45);
  }

  .mini-ctrl svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .mini-ctrl svg.flipped {
    transform: rotate(180deg);
  }

  /* ── Y-Axis Aligned Position & TP/SL Canvas Layer ──────────────────────── */
  .y-canvas-layer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 56px;
    right: 66px;
    pointer-events: none;
  }

  .pane-overlay-root.compact-left .y-canvas-layer {
    left: 12px;
  }

  .shaded-zone {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
  }

  .shaded-zone.tp-zone {
    background: rgba(8, 153, 129, 0.13);
  }

  .shaded-zone.sl-zone {
    background: rgba(255, 152, 0, 0.13);
  }

  .level-row {
    position: absolute;
    left: 0;
    right: 0;
    height: 0;
    display: flex;
    align-items: center;
    pointer-events: none;
  }

  .level-row.entry-row {
    z-index: 6;
  }

  .level-row.tp-row,
  .level-row.sl-row {
    z-index: 5;
  }

  .level-line {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 0;
    pointer-events: none;
  }

  .y-canvas-layer.short .entry-line {
    border-top: 1.5px solid #f23645;
  }

  .y-canvas-layer.long .entry-line {
    border-top: 1.5px solid #2962ff;
  }

  .tp-line {
    border-top: 1.5px dashed #089981;
  }

  .sl-line {
    border-top: 1.5px dashed #f59e0b;
  }

  .level-price-tag {
    position: absolute;
    right: 0;
    transform: translateY(-50%);
    height: 19px;
    padding: 0 6px;
    border: 0;
    border-radius: 3px;
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    color: #ffffff;
    pointer-events: auto;
    cursor: pointer;
  }

  .entry-tag.short {
    background: #f23645;
  }

  .entry-tag.long {
    background: #2962ff;
  }

  .tp-tag {
    background: #089981;
  }

  .sl-tag {
    background: #f59e0b;
    color: #111111;
  }

  .handle-cluster {
    position: absolute;
    left: 52%;
    transform: translate(-50%, -50%);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    pointer-events: auto;
  }

  .handle-cluster.entry-cluster {
    transform: translate(-58%, -50%);
  }

  .circle-rm,
  .circle-confirm-inline {
    width: 22px;
    height: 22px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .circle-rm {
    border: 1.5px solid currentColor;
    background: var(--dark-bg-surface);
  }

  .pane-overlay-root.light .circle-rm {
    background: #ffffff;
  }

  .circle-rm.tp {
    color: #089981;
  }

  .circle-rm.tp:hover {
    background: #089981;
    color: #ffffff;
  }

  .circle-rm.sl {
    color: #f59e0b;
  }

  .circle-rm.sl:hover {
    background: #f59e0b;
    color: #111111;
  }

  .circle-confirm-inline {
    border: 0;
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }

  .circle-confirm-inline.tp {
    background: #089981;
  }

  .circle-confirm-inline.sl {
    background: #f59e0b;
    color: #111111;
  }

  .bracket-pill {
    position: relative;
    height: 23px;
    padding: 0 9px 0 6px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-strong);
    background: rgba(24, 24, 24, 0.94);
    color: var(--dark-text-soft);
    font-size: 11.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: ns-resize;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
  }

  .pane-overlay-root.light .bracket-pill {
    background: rgba(255, 255, 255, 0.96);
    border-color: #cfd4de;
    color: #6a7282;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
  }

  .bracket-pill.tp:hover,
  .bracket-pill.tp.set,
  .bracket-pill.tp.dragging {
    border-color: #089981;
    color: #089981;
  }

  .bracket-pill.sl:hover,
  .bracket-pill.sl.set,
  .bracket-pill.sl.dragging {
    border-color: #f59e0b;
    color: #f59e0b;
  }

  .bracket-pill.set {
    padding-left: 0;
    overflow: hidden;
  }

  .bracket-pill.tp.set .grip-dots,
  .bracket-pill.tp.set .bp-qty {
    background: #089981;
    color: #ffffff;
    height: 100%;
    display: inline-flex;
    align-items: center;
  }

  .bracket-pill.sl.set .grip-dots,
  .bracket-pill.sl.set .bp-qty {
    background: #f59e0b;
    color: #111111;
    height: 100%;
    display: inline-flex;
    align-items: center;
  }

  .bracket-pill.set .grip-dots {
    padding: 0 3px 0 5px;
    margin-right: -6px;
  }

  .bracket-pill.set .bp-qty {
    padding: 0 7px 0 4px;
    font-weight: 700;
  }

  .bp-val {
    padding-left: 2px;
    font-weight: 700;
    white-space: nowrap;
  }

  .grip-dots {
    font-size: 11px;
    letter-spacing: -1px;
    opacity: 0.72;
  }

  .drag-tip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    border-radius: 5px;
    background: #1b1b1b;
    color: #ffffff;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  }

  .bracket-pill:hover .drag-tip {
    display: block;
  }

  .bracket-pill.dragging .drag-tip {
    display: none;
  }

  /* ── Entry Pill & Circular Action Buttons (× / ⇅ / ↩ / ✓) ──────────────── */
  .circle-act {
    width: 24px;
    height: 24px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }

  .circle-act.close-pos,
  .circle-act.confirm-stage {
    border: 0;
    background: #f23645;
    color: #ffffff;
    font-size: 14px;
  }

  .y-canvas-layer.long .circle-act.close-pos,
  .y-canvas-layer.long .circle-act.confirm-stage {
    background: #2962ff;
  }

  .circle-act.rev-pos,
  .circle-act.undo-stage {
    border: 1.5px solid #f23645;
    background: var(--dark-bg-surface);
    color: #f23645;
  }

  .y-canvas-layer.long .circle-act.rev-pos,
  .y-canvas-layer.long .circle-act.undo-stage {
    border-color: #2962ff;
    color: #2962ff;
  }

  .pane-overlay-root.light .circle-act.rev-pos,
  .pane-overlay-root.light .circle-act.undo-stage {
    background: #ffffff;
  }

  .circle-act.rev-pos:hover,
  .circle-act.undo-stage:hover {
    background: #f23645;
    color: #ffffff;
  }

  .y-canvas-layer.long .circle-act.rev-pos:hover,
  .y-canvas-layer.long .circle-act.undo-stage:hover {
    background: #2962ff;
    color: #ffffff;
  }

  .tv-pos-pill {
    height: 25px;
    border-radius: 6px;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    background: var(--dark-bg-surface);
    cursor: grab;
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.38);
  }

  .tv-pos-pill:active {
    cursor: grabbing;
  }

  .tv-pos-pill.short {
    border: 1.5px solid #f23645;
  }

  .tv-pos-pill.long {
    border: 1.5px solid #2962ff;
  }

  .pane-overlay-root.light .tv-pos-pill {
    background: #ffffff;
    box-shadow: 0 3px 12px rgba(15, 23, 42, 0.16);
  }

  .pos-qty-cap {
    height: 100%;
    padding: 0 9px;
    display: inline-flex;
    align-items: center;
    color: #ffffff;
    font-weight: 700;
  }

  .tv-pos-pill.short .pos-qty-cap {
    background: #f23645;
  }

  .tv-pos-pill.long .pos-qty-cap {
    background: #2962ff;
  }

  .pos-pnl-body {
    height: 100%;
    padding: 0 10px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 700;
    color: var(--dark-text-strong);
    white-space: nowrap;
  }

  .pane-overlay-root.light .pos-pnl-body {
    color: #131722;
  }

  .pos-pnl-body.win {
    color: #089981;
  }

  .pos-pnl-body.loss {
    color: #f23645;
  }

  .pos-r {
    font-size: 10.5px;
    font-weight: 600;
    opacity: 0.85;
  }

  .stage-err-toast {
    position: absolute;
    top: 18px;
    left: 52%;
    transform: translateX(-50%);
    padding: 4px 9px;
    border-radius: 5px;
    background: #f23645;
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    pointer-events: none;
  }
</style>
