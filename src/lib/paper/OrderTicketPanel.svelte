<script lang="ts">
  import { onMount } from 'svelte';
  import {
    calculatePositionSize,
    loadTasksState,
    type TasksState
  } from '../tasks/store';
  import {
    computePnlUsd,
    computeTickValueUsd,
    computeTradeValueUsd,
    formatPaperPrice,
    formatQty,
    formatUsd,
    getPaperInstrumentSpec,
    normalizeSymbolKey,
    roundToTick
  } from './instruments';
  import {
    closePaperPosition,
    computeAccountMetrics,
    getActivePaperAccount,
    placePaperOrder,
    reversePaperPosition,
    setPaperTicketOpen,
    subscribeOrderDraft,
    subscribePaper,
    subscribePaperQuotes,
    updatePaperSettings
  } from './store';
  import type {
    OrderSide,
    OrderType,
    PaperLedgerState,
    PaperLiveQuote,
    TimeInForce
  } from './types';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    onOpenSettings: () => void;
  }

  let { theme, activeSymbol, activeFullSymbol, onOpenSettings }: Props = $props();

  const MIN_W = 310;
  const MAX_W = 420;

  let width = $state(340);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartW = 340;

  let ledger = $state<PaperLedgerState | null>(null);
  let quotes = $state<Record<string, PaperLiveQuote>>({});

  let panelTab = $state<'order' | 'dom'>('order');
  let side = $state<OrderSide>('buy');
  let orderType = $state<OrderType>('market');
  let qtyMode = $state<'units' | 'lots' | 'risk_usd' | 'risk_pct'>('units');

  let priceInput = $state('');
  let qtyInput = $state('1');
  let riskInput = $state('100');
  let tpEnabled = $state(false);
  let tpPriceInput = $state('');
  let slEnabled = $state(false);
  let slPriceInput = $state('');
  let exitsExpanded = $state(true);
  let extraExpanded = $state(false);
  let tif = $state<TimeInForce>('GTC');

  let moreMenuOpen = $state(false);
  let qtyMenuOpen = $state(false);
  let sizerFeedback = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let domQty = $state(1);

  let lastSymbolKey = '';

  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);
  const symbol = $derived(activeFullSymbol || activeSymbol || 'OANDA:XAUUSD');
  const shortName = $derived(activeSymbol || 'XAUUSD');
  const symKey = $derived(normalizeSymbolKey(symbol));
  const spec = $derived(getPaperInstrumentSpec(symbol));
  const liveQuote = $derived(quotes[symKey] ?? null);
  const accountMetrics = $derived(account ? computeAccountMetrics(account, quotes) : null);

  const activePosition = $derived.by(() => {
    if (!account) return null;
    return account.positions.find((p) => normalizeSymbolKey(p.symbol) === symKey) ?? null;
  });

  const activeOrders = $derived.by(() => {
    if (!account) return [];
    return account.orders.filter((o) => normalizeSymbolKey(o.symbol) === symKey);
  });

  // Reset sensible default price/qty when active chart symbol changes
  $effect(() => {
    const key = symKey;
    const sp = spec;
    const q = liveQuote;
    if (key !== lastSymbolKey) {
      lastSymbolKey = key;
      qtyInput = String(sp.qtyStep);
      domQty = sp.qtyStep;
      tpEnabled = false;
      slEnabled = false;
      tpPriceInput = '';
      slPriceInput = '';
      submitError = null;
      if (q && q.last > 0) {
        priceInput = formatRawPrice(side === 'buy' ? q.ask : q.bid, symbol);
      } else {
        priceInput = '';
      }
    } else if (!priceInput && q && q.last > 0) {
      priceInput = formatRawPrice(side === 'buy' ? q.ask : q.bid, symbol);
    }
  });

  function formatRawPrice(val: number, sym: string): string {
    const sp = getPaperInstrumentSpec(sym);
    return Number.isFinite(val) ? val.toFixed(sp.decimals) : '';
  }

  onMount(() => {
    const unsub1 = subscribePaper((s) => {
      ledger = s;
    });
    const unsub2 = subscribePaperQuotes((q) => {
      quotes = q;
    });
    const unsubDraft = subscribeOrderDraft((draft) => {
      panelTab = 'order';
      side = draft.side;
      if (draft.type) orderType = draft.type;
      if (typeof draft.price === 'number' && Number.isFinite(draft.price) && draft.price > 0) {
        priceInput = formatRawPrice(draft.price, draft.symbol || symbol);
      }
      if (typeof draft.quantity === 'number' && Number.isFinite(draft.quantity) && draft.quantity > 0) {
        qtyMode = 'units';
        qtyInput = String(Number(draft.quantity.toFixed(4)));
        domQty = Number(draft.quantity.toFixed(4));
      }
      if (typeof draft.takeProfit === 'number' && Number.isFinite(draft.takeProfit) && draft.takeProfit > 0) {
        tpEnabled = true;
        tpPriceInput = formatRawPrice(draft.takeProfit, draft.symbol || symbol);
      } else if (draft.source === 'sizer') {
        tpEnabled = false;
        tpPriceInput = '';
      }
      if (typeof draft.stopLoss === 'number' && Number.isFinite(draft.stopLoss) && draft.stopLoss > 0) {
        slEnabled = true;
        slPriceInput = formatRawPrice(draft.stopLoss, draft.symbol || symbol);
      } else if (draft.source === 'sizer') {
        slEnabled = false;
        slPriceInput = '';
      }
      if (draft.source === 'sizer') {
        sizerFeedback = 'Loaded from Tasks Position Sizer';
        setTimeout(() => {
          sizerFeedback = null;
        }, 2600);
      }
      submitError = null;
    });

    const onDocDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (moreMenuOpen && !target?.closest('[data-ticket-more]')) moreMenuOpen = false;
      if (qtyMenuOpen && !target?.closest('[data-qty-mode]')) qtyMenuOpen = false;
    };
    window.addEventListener('pointerdown', onDocDown);

    return () => {
      unsub1();
      unsub2();
      unsubDraft();
      window.removeEventListener('pointerdown', onDocDown);
    };
  });

  // Reference entry price for calculations
  const effectiveEntryPrice = $derived.by(() => {
    if (orderType === 'market') {
      if (!liveQuote) return 0;
      return side === 'buy' ? liveQuote.ask : liveQuote.bid;
    }
    const parsed = Number(priceInput);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    if (liveQuote) return side === 'buy' ? liveQuote.ask : liveQuote.bid;
    return 0;
  });

  const parsedTp = $derived.by(() => {
    if (!tpEnabled) return null;
    const v = Number(tpPriceInput);
    return Number.isFinite(v) && v > 0 ? v : null;
  });

  const parsedSl = $derived.by(() => {
    if (!slEnabled) return null;
    const v = Number(slPriceInput);
    return Number.isFinite(v) && v > 0 ? v : null;
  });

  // Compute resolved units quantity from qtyMode
  const resolvedUnits = $derived.by(() => {
    if (qtyMode === 'units') {
      const v = Number(qtyInput);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }
    if (qtyMode === 'lots') {
      const lots = Number(qtyInput);
      return Number.isFinite(lots) && lots > 0 ? Number((lots * spec.lotUnits).toFixed(4)) : 0;
    }
    // Risk USD or Risk % requires valid SL distance
    const eq = accountMetrics?.equity ?? account?.balance ?? 100000;
    const rawRisk = Number(riskInput);
    const riskUsd =
      qtyMode === 'risk_pct'
        ? (eq * (Number.isFinite(rawRisk) ? rawRisk : 0)) / 100
        : Number.isFinite(rawRisk)
          ? rawRisk
          : 0;
    if (riskUsd <= 0 || effectiveEntryPrice <= 0 || parsedSl === null) return 0;
    const slLossPerUnit = Math.abs(
      computePnlUsd(symbol, side === 'buy' ? 'long' : 'short', 1, effectiveEntryPrice, parsedSl)
    );
    if (slLossPerUnit <= 0) return 0;
    const rawUnits = riskUsd / slLossPerUnit;
    return rawUnits >= 10 ? Math.round(rawUnits) : Number(rawUnits.toFixed(4));
  });

  const tradeValueUsd = $derived(
    computeTradeValueUsd(symbol, resolvedUnits, effectiveEntryPrice)
  );
  const leverage = $derived(account?.settings.leverage ?? 500);
  const requiredMarginUsd = $derived(leverage > 0 ? tradeValueUsd / leverage : tradeValueUsd);
  const tickValueUsd = $derived(
    computeTickValueUsd(symbol, resolvedUnits || 1, effectiveEntryPrice)
  );

  const priceOffsetTicks = $derived.by(() => {
    if (!liveQuote || orderType === 'market') return 0;
    const ref = side === 'buy' ? liveQuote.ask : liveQuote.bid;
    const p = Number(priceInput);
    if (!Number.isFinite(p) || p <= 0) return 0;
    return Math.round((p - ref) / spec.tickSize);
  });

  const tpTicks = $derived.by(() => {
    if (effectiveEntryPrice <= 0 || parsedTp === null) return null;
    const dir = side === 'buy' ? 1 : -1;
    return Math.round(((parsedTp - effectiveEntryPrice) * dir) / spec.tickSize);
  });

  const slTicks = $derived.by(() => {
    if (effectiveEntryPrice <= 0 || parsedSl === null) return null;
    const dir = side === 'buy' ? 1 : -1;
    return Math.round(((effectiveEntryPrice - parsedSl) * dir) / spec.tickSize);
  });

  const estTpUsd = $derived.by(() => {
    if (effectiveEntryPrice <= 0 || parsedTp === null || resolvedUnits <= 0) return null;
    return computePnlUsd(symbol, side === 'buy' ? 'long' : 'short', resolvedUnits, effectiveEntryPrice, parsedTp);
  });

  const estSlUsd = $derived.by(() => {
    if (effectiveEntryPrice <= 0 || parsedSl === null || resolvedUnits <= 0) return null;
    return computePnlUsd(symbol, side === 'buy' ? 'long' : 'short', resolvedUnits, effectiveEntryPrice, parsedSl);
  });

  const plannedRR = $derived.by(() => {
    if (estTpUsd === null || estSlUsd === null || estTpUsd <= 0 || estSlUsd >= 0) return null;
    return estTpUsd / Math.abs(estSlUsd);
  });

  function selectSide(next: OrderSide) {
    side = next;
    submitError = null;
    if (orderType !== 'market' && liveQuote) {
      const ref = next === 'buy' ? liveQuote.ask : liveQuote.bid;
      const offset =
        orderType === 'stop'
          ? (next === 'buy' ? 1 : -1) * spec.pipSize * 10
          : (next === 'buy' ? -1 : 1) * spec.pipSize * 10;
      priceInput = formatRawPrice(roundToTick(ref + offset, symbol), symbol);
    }
  }

  function selectOrderType(next: OrderType) {
    orderType = next;
    submitError = null;
    if (next !== 'market' && liveQuote) {
      const ref = side === 'buy' ? liveQuote.ask : liveQuote.bid;
      const offset =
        next === 'stop'
          ? (side === 'buy' ? 1 : -1) * spec.pipSize * 10
          : (side === 'buy' ? -1 : 1) * spec.pipSize * 10;
      priceInput = formatRawPrice(roundToTick(ref + offset, symbol), symbol);
    }
  }

  function toggleTp() {
    tpEnabled = !tpEnabled;
    if (tpEnabled && !tpPriceInput && effectiveEntryPrice > 0) {
      const dir = side === 'buy' ? 1 : -1;
      const defDist = spec.pipSize * 50;
      tpPriceInput = formatRawPrice(roundToTick(effectiveEntryPrice + dir * defDist, symbol), symbol);
    }
  }

  function toggleSl() {
    slEnabled = !slEnabled;
    if (slEnabled && !slPriceInput && effectiveEntryPrice > 0) {
      const dir = side === 'buy' ? 1 : -1;
      const defDist = spec.pipSize * 25;
      slPriceInput = formatRawPrice(roundToTick(effectiveEntryPrice - dir * defDist, symbol), symbol);
    }
  }

  function adjustPriceByTicks(ticks: number) {
    if (!liveQuote) return;
    const ref = side === 'buy' ? liveQuote.ask : liveQuote.bid;
    priceInput = formatRawPrice(roundToTick(ref + ticks * spec.tickSize, symbol), symbol);
  }

  function adjustTpByTicks(ticks: number) {
    if (effectiveEntryPrice <= 0) return;
    const dir = side === 'buy' ? 1 : -1;
    tpPriceInput = formatRawPrice(
      roundToTick(effectiveEntryPrice + dir * Math.abs(ticks) * spec.tickSize, symbol),
      symbol
    );
  }

  function adjustSlByTicks(ticks: number) {
    if (effectiveEntryPrice <= 0) return;
    const dir = side === 'buy' ? 1 : -1;
    slPriceInput = formatRawPrice(
      roundToTick(effectiveEntryPrice - dir * Math.abs(ticks) * spec.tickSize, symbol),
      symbol
    );
  }

  async function pullFromTasksSizer() {
    try {
      const tasks: TasksState = await loadTasksState();
      const calc = calculatePositionSize(shortName, tasks.risk);
      if (!calc.valid || !calc.direction) {
        sizerFeedback = 'Set Entry & Stop Loss in Tasks Position Sizer first';
        setTimeout(() => {
          sizerFeedback = null;
        }, 2800);
        return;
      }

      const nextSide: OrderSide = calc.direction === 'LONG' ? 'buy' : 'sell';
      const entry = Number(tasks.risk.entry);
      const sl = Number(tasks.risk.stopLoss);
      const tp = Number(tasks.risk.takeProfit);
      const units = Number((calc.lotSize * spec.lotUnits).toFixed(4));

      side = nextSide;
      qtyMode = 'units';
      qtyInput = String(units >= 10 ? Math.round(units) : units);

      if (liveQuote && Math.abs(entry - liveQuote.last) <= spec.pipSize * 5) {
        orderType = 'market';
      } else if (liveQuote) {
        const isStop =
          (nextSide === 'buy' && entry > liveQuote.ask) ||
          (nextSide === 'sell' && entry < liveQuote.bid);
        orderType = isStop ? 'stop' : 'limit';
        priceInput = formatRawPrice(entry, symbol);
      } else {
        orderType = 'limit';
        priceInput = formatRawPrice(entry, symbol);
      }

      if (Number.isFinite(sl) && sl > 0) {
        slEnabled = true;
        slPriceInput = formatRawPrice(sl, symbol);
      }
      if (Number.isFinite(tp) && tp > 0) {
        tpEnabled = true;
        tpPriceInput = formatRawPrice(tp, symbol);
      } else {
        tpEnabled = false;
        tpPriceInput = '';
      }

      panelTab = 'order';
      submitError = null;
      sizerFeedback = `Synced ${calc.lotSize.toFixed(2)} lots (${formatQty(Number(qtyInput))} units)`;
      setTimeout(() => {
        sizerFeedback = null;
      }, 2800);
    } catch {
      sizerFeedback = 'Unable to read Tasks Position Sizer';
    }
  }

  function handleSubmit() {
    submitError = null;
    if (resolvedUnits <= 0) {
      submitError =
        qtyMode === 'risk_usd' || qtyMode === 'risk_pct'
          ? 'Enable a valid Stop Loss to size by risk.'
          : 'Enter a valid quantity.';
      return;
    }

    const res = placePaperOrder({
      symbol,
      shortName,
      side,
      type: orderType,
      quantity: resolvedUnits,
      orderPrice: orderType === 'market' ? null : Number(priceInput),
      takeProfit: parsedTp,
      stopLoss: parsedSl,
      tif
    });
    if (!res.ok) {
      submitError = res.error ?? 'Order rejected';
    }
  }

  // ── L1 DOM Price Ladder ────────────────────────────────────────────────────
  const domStep = $derived(spec.pipSize >= 1 ? spec.pipSize : spec.pipSize * 2);

  const domRows = $derived.by(() => {
    if (!liveQuote || liveQuote.last <= 0) return [];
    const step = domStep;
    const center = Math.round(liveQuote.last / step) * step;
    const rows: {
      price: number;
      isAsk: boolean;
      isBid: boolean;
      isPosEntry: boolean;
      isPosTp: boolean;
      isPosSl: boolean;
      buyOrders: number;
      sellOrders: number;
    }[] = [];

    for (let i = 10; i >= -10; i--) {
      const p = roundToTick(center + i * step, symbol);
      if (p <= 0) continue;
      const near = (target: number | null | undefined) =>
        typeof target === 'number' && Math.abs(target - p) < step * 0.55;

      let buyOrders = 0;
      let sellOrders = 0;
      for (const ord of activeOrders) {
        if (near(ord.orderPrice)) {
          if (ord.side === 'buy') buyOrders += ord.quantity;
          else sellOrders += ord.quantity;
        }
      }

      rows.push({
        price: p,
        isAsk: Math.abs(liveQuote.ask - p) < step * 0.55,
        isBid: Math.abs(liveQuote.bid - p) < step * 0.55,
        isPosEntry: activePosition ? near(activePosition.avgFillPrice) : false,
        isPosTp: activePosition ? near(activePosition.takeProfit) : false,
        isPosSl: activePosition ? near(activePosition.stopLoss) : false,
        buyOrders,
        sellOrders
      });
    }
    return rows;
  });

  function placeDomOrder(domSide: OrderSide, price: number) {
    if (!liveQuote || domQty <= 0) return;
    const type: OrderType =
      domSide === 'buy'
        ? price > liveQuote.ask
          ? 'stop'
          : 'limit'
        : price < liveQuote.bid
          ? 'stop'
          : 'limit';
    placePaperOrder({
      symbol,
      shortName,
      side: domSide,
      type,
      quantity: domQty,
      orderPrice: price,
      tif: 'GTC'
    });
  }

  // Resize handle
  function onResizeDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartW = width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onResizeMove(e: PointerEvent) {
    if (!dragging) return;
    const next = dragStartW + (dragStartX - e.clientX);
    width = Math.round(Math.max(MIN_W, Math.min(MAX_W, next)));
  }

  function onResizeUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }
</script>

<aside
  class="order-ticket"
  class:light={theme === 'light'}
  class:dragging
  style:width="{width}px"
  style:flex-basis="{width}px"
  aria-label="Paper Ledger Order Panel"
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="resize-handle"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize order panel"
    onpointerdown={onResizeDown}
    onpointermove={onResizeMove}
    onpointerup={onResizeUp}
    onpointercancel={onResizeUp}
  >
    <span class="resize-pill" aria-hidden="true"></span>
  </div>

  <div class="ticket-inner">
    <!-- Top Header -->
    <header class="ticket-header">
      <div class="th-left">
        <span class="pl-mark" aria-hidden="true">PL</span>
        <span class="th-sym">{shortName}</span>
      </div>

      <div class="th-actions">
        <button
          class="icon-btn"
          type="button"
          title="Pull size, Entry, SL & TP from Tasks Position Sizer"
          aria-label="Pull from Position Sizer"
          onclick={() => void pullFromTasksSizer()}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2.75" y="2.75" width="5" height="5" rx="1.2" />
            <rect x="10.25" y="2.75" width="5" height="5" rx="1.2" />
            <rect x="2.75" y="10.25" width="5" height="5" rx="1.2" />
            <path d="M12.75 10.5v4.5M10.5 12.75h4.5" />
          </svg>
        </button>

        <div class="more-anchor" data-ticket-more>
          <button
            class="icon-btn"
            class:active={moreMenuOpen}
            type="button"
            title="Order panel options"
            aria-label="Order panel options"
            onclick={() => (moreMenuOpen = !moreMenuOpen)}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="4.25" cy="9" r="1.2" fill="currentColor" stroke="none" />
              <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
              <circle cx="13.75" cy="9" r="1.2" fill="currentColor" stroke="none" />
            </svg>
          </button>

          {#if moreMenuOpen && account}
            <div class="mini-menu">
              <button
                class="mm-row"
                type="button"
                onclick={() => {
                  updatePaperSettings({ zeroSpread: !account.settings.zeroSpread });
                  moreMenuOpen = false;
                }}
              >
                <span>Zero-spread (Mid-price)</span>
                <span class="mm-val">{account.settings.zeroSpread ? 'On' : 'Off'}</span>
              </button>
              <button
                class="mm-row"
                type="button"
                onclick={() => {
                  updatePaperSettings({ oneClickTrading: !account.settings.oneClickTrading });
                  moreMenuOpen = false;
                }}
              >
                <span>1-click chart orders</span>
                <span class="mm-val">{account.settings.oneClickTrading ? 'On' : 'Off'}</span>
              </button>
              <button
                class="mm-row"
                type="button"
                onclick={() => {
                  updatePaperSettings({ showOnChart: !account.settings.showOnChart });
                  moreMenuOpen = false;
                }}
              >
                <span>Show chart pills</span>
                <span class="mm-val">{account.settings.showOnChart ? 'On' : 'Off'}</span>
              </button>
              <div class="mm-div"></div>
              <button
                class="mm-row"
                type="button"
                onclick={() => {
                  moreMenuOpen = false;
                  onOpenSettings();
                }}
              >
                <span>Account settings...</span>
              </button>
            </div>
          {/if}
        </div>

        <button
          class="icon-btn"
          type="button"
          title="Close Order Panel"
          aria-label="Close Order Panel"
          onclick={() => setPaperTicketOpen(false)}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="m4.5 4.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Order / DOM Segmented Switch -->
    <div class="seg-wrap">
      <div class="seg-track" role="tablist">
        <button
          class="seg-btn"
          class:active={panelTab === 'order'}
          type="button"
          role="tab"
          aria-selected={panelTab === 'order'}
          onclick={() => (panelTab = 'order')}
        >
          Order
        </button>
        <button
          class="seg-btn"
          class:active={panelTab === 'dom'}
          type="button"
          role="tab"
          aria-selected={panelTab === 'dom'}
          onclick={() => (panelTab = 'dom')}
        >
          DOM
        </button>
      </div>
    </div>

    {#if sizerFeedback}
      <div class="sizer-banner">{sizerFeedback}</div>
    {/if}

    {#if panelTab === 'order'}
      <div class="ticket-scroll">
        <!-- Split Sell / Spread / Buy Box -->
        <div class="side-box">
          <button
            class="side-half sell"
            class:selected={side === 'sell'}
            type="button"
            onclick={() => selectSide('sell')}
          >
            <span class="side-lbl">Sell</span>
            <span class="side-px">
              {liveQuote ? formatPaperPrice(liveQuote.bid, symbol) : '—'}
            </span>
          </button>

          <span class="spread-badge" title="Bid-Ask spread">
            {liveQuote ? liveQuote.spreadDisplay : '—'}
          </span>

          <button
            class="side-half buy"
            class:selected={side === 'buy'}
            type="button"
            onclick={() => selectSide('buy')}
          >
            <span class="side-lbl">Buy</span>
            <span class="side-px">
              {liveQuote ? formatPaperPrice(liveQuote.ask, symbol) : '—'}
            </span>
          </button>
        </div>

        <!-- Market | Limit | Stop Underline Tabs -->
        <div class="type-tabs" role="tablist">
          {#each [
            { id: 'market', label: 'Market' },
            { id: 'limit', label: 'Limit' },
            { id: 'stop', label: 'Stop' }
          ] as tab (tab.id)}
            <button
              class="type-tab"
              class:active={orderType === tab.id}
              type="button"
              role="tab"
              aria-selected={orderType === tab.id}
              onclick={() => selectOrderType(tab.id as OrderType)}
            >
              {tab.label}
            </button>
          {/each}
        </div>

        <!-- Price Input (Limit & Stop) -->
        {#if orderType !== 'market'}
          <div class="field-block">
            <label class="f-label" for="pt-price">Price</label>
            <div class="dual-input">
              <input
                id="pt-price"
                type="number"
                step={spec.tickSize}
                bind:value={priceInput}
              />
              <span class="swap-ic" aria-hidden="true">⇄</span>
              <input
                class="rhs-input"
                type="text"
                aria-label="Offset from quote in ticks"
                value="{side === 'buy' ? 'Ask' : 'Bid'} {priceOffsetTicks >= 0 ? '+' : ''}{priceOffsetTicks}"
                onchange={(e) => {
                  const m = (e.currentTarget as HTMLInputElement).value.match(/-?\d+/);
                  if (m) adjustPriceByTicks(Number(m[0]));
                }}
              />
            </div>
          </div>
        {/if}

        <!-- Units / Lots / Risk Sizing -->
        <div class="field-block">
          <div class="f-label-row" data-qty-mode>
            <button
              class="mode-trigger"
              type="button"
              onclick={() => (qtyMenuOpen = !qtyMenuOpen)}
            >
              <span>
                {qtyMode === 'units'
                  ? 'Units'
                  : qtyMode === 'lots'
                    ? 'Lots'
                    : qtyMode === 'risk_usd'
                      ? 'Risk USD'
                      : 'Risk %'}
              </span>
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4.5 6 7.5 9 4.5" />
              </svg>
            </button>

            <button
              class="sizer-pull-chip"
              type="button"
              onclick={() => void pullFromTasksSizer()}
            >
              Pull from Sizer
            </button>

            {#if qtyMenuOpen}
              <div class="qty-popover">
                {#each [
                  { id: 'units', label: `Units (${spec.unitLabel})` },
                  { id: 'lots', label: `Lots (${formatQty(spec.lotUnits)} units/lot)` },
                  { id: 'risk_usd', label: 'Risk USD (from SL)' },
                  { id: 'risk_pct', label: 'Risk % of Equity (from SL)' }
                ] as opt (opt.id)}
                  <button
                    class="qp-opt"
                    class:active={qtyMode === opt.id}
                    type="button"
                    onclick={() => {
                      qtyMode = opt.id as typeof qtyMode;
                      qtyMenuOpen = false;
                      if (opt.id === 'lots') {
                        qtyInput = String(
                          Math.max(0.01, Number((resolvedUnits / spec.lotUnits).toFixed(2)))
                        );
                      } else if (opt.id === 'units') {
                        qtyInput = String(resolvedUnits || spec.qtyStep);
                      } else if (opt.id === 'risk_pct') {
                        riskInput = '1';
                        if (!slEnabled) toggleSl();
                      } else if (opt.id === 'risk_usd') {
                        riskInput = '100';
                        if (!slEnabled) toggleSl();
                      }
                    }}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="dual-input">
            {#if qtyMode === 'units' || qtyMode === 'lots'}
              <input
                type="number"
                min="0"
                step={qtyMode === 'lots' ? 0.01 : spec.qtyStep}
                bind:value={qtyInput}
              />
            {:else}
              <input
                type="number"
                min="0"
                step={qtyMode === 'risk_pct' ? 0.1 : 10}
                bind:value={riskInput}
              />
            {/if}
            <span class="swap-ic" aria-hidden="true">⇄</span>
            <div class="rhs-readout">
              {#if qtyMode === 'units' || qtyMode === 'lots'}
                {formatUsd(requiredMarginUsd)} <span class="unit-sm">USD</span>
              {:else}
                {formatQty(resolvedUnits)} <span class="unit-sm">{spec.unitLabel}</span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Order Info Card -->
        <div class="info-card">
          <div class="info-row">
            <span class="ik">Trade value ({leverage}x)</span>
            <span class="iv">{formatUsd(tradeValueUsd)} <small>USD</small></span>
          </div>
          <div class="info-row">
            <span class="ik">Available margin</span>
            <span class="iv">
              {account?.settings.privacyMask
                ? '•••••'
                : formatUsd(accountMetrics?.availableFunds ?? 0)}
              <small>USD</small>
            </span>
          </div>
          <div class="info-row">
            <span class="ik">Tick value</span>
            <span class="iv">
              {tickValueUsd < 0.01 ? tickValueUsd.toFixed(4) : tickValueUsd.toFixed(3)}
              <small>USD</small>
            </span>
          </div>
          {#if estSlUsd !== null}
            <div class="info-row risk-row">
              <span class="ik">Planned risk</span>
              <span class="iv neg">
                {formatUsd(estSlUsd, true)} <small>USD</small>
                {#if plannedRR !== null}
                  <span class="rr-chip">1:{plannedRR.toFixed(1)}</span>
                {/if}
              </span>
            </div>
          {/if}
        </div>

        <!-- Exits Accordion -->
        <div class="accordion">
          <button
            class="acc-head"
            type="button"
            onclick={() => (exitsExpanded = !exitsExpanded)}
          >
            <span>Exits</span>
            <svg class:open={exitsExpanded} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" />
            </svg>
          </button>

          {#if exitsExpanded}
            <div class="acc-body">
              <!-- Take Profit -->
              <div class="exit-row">
                <div class="exit-top">
                  <span class="exit-lbl">Take profit price</span>
                  <button
                    class="switch"
                    class:on={tpEnabled}
                    type="button"
                    role="switch"
                    aria-checked={tpEnabled}
                    aria-label="Toggle take profit"
                    onclick={toggleTp}
                  >
                    <span class="knob"></span>
                  </button>
                </div>
                <div class="dual-input" class:disabled={!tpEnabled}>
                  <input
                    type="number"
                    step={spec.tickSize}
                    disabled={!tpEnabled}
                    placeholder={effectiveEntryPrice > 0
                      ? formatRawPrice(effectiveEntryPrice + (side === 'buy' ? 1 : -1) * spec.pipSize * 50, symbol)
                      : 'Price'}
                    bind:value={tpPriceInput}
                  />
                  <span class="swap-ic" aria-hidden="true">⇄</span>
                  <input
                    class="rhs-input"
                    type="text"
                    disabled={!tpEnabled}
                    value={tpTicks !== null ? `${tpTicks} ticks` : '500 ticks'}
                    onchange={(e) => {
                      const m = (e.currentTarget as HTMLInputElement).value.match(/\d+/);
                      if (m) adjustTpByTicks(Number(m[0]));
                    }}
                  />
                </div>
                {#if tpEnabled && estTpUsd !== null}
                  <div class="exit-hint pos">
                    Est. profit {formatUsd(estTpUsd, true)} USD
                    {#if plannedRR !== null}· +{plannedRR.toFixed(2)}R{/if}
                  </div>
                {/if}
              </div>

              <!-- Stop Loss -->
              <div class="exit-row">
                <div class="exit-top">
                  <span class="exit-lbl">Stop loss price</span>
                  <button
                    class="switch"
                    class:on={slEnabled}
                    type="button"
                    role="switch"
                    aria-checked={slEnabled}
                    aria-label="Toggle stop loss"
                    onclick={toggleSl}
                  >
                    <span class="knob"></span>
                  </button>
                </div>
                <div class="dual-input" class:disabled={!slEnabled}>
                  <input
                    type="number"
                    step={spec.tickSize}
                    disabled={!slEnabled}
                    placeholder={effectiveEntryPrice > 0
                      ? formatRawPrice(effectiveEntryPrice - (side === 'buy' ? 1 : -1) * spec.pipSize * 25, symbol)
                      : 'Price'}
                    bind:value={slPriceInput}
                  />
                  <span class="swap-ic" aria-hidden="true">⇄</span>
                  <input
                    class="rhs-input"
                    type="text"
                    disabled={!slEnabled}
                    value={slTicks !== null ? `${slTicks} ticks` : '250 ticks'}
                    onchange={(e) => {
                      const m = (e.currentTarget as HTMLInputElement).value.match(/\d+/);
                      if (m) adjustSlByTicks(Number(m[0]));
                    }}
                  />
                </div>
                {#if slEnabled && estSlUsd !== null}
                  <div class="exit-hint neg">
                    Est. loss {formatUsd(estSlUsd, true)} USD
                    {#if accountMetrics && accountMetrics.equity > 0}
                      ({((Math.abs(estSlUsd) / accountMetrics.equity) * 100).toFixed(2)}%)
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- Extra Settings Accordion -->
        <div class="accordion">
          <button
            class="acc-head"
            type="button"
            onclick={() => (extraExpanded = !extraExpanded)}
          >
            <span>Extra settings</span>
            <svg class:open={extraExpanded} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" />
            </svg>
          </button>

          {#if extraExpanded}
            <div class="acc-body">
              <label class="tif-field">
                <span>Time in force</span>
                <select bind:value={tif}>
                  <option value="GTC">Good 'Til Cancelled (GTC)</option>
                  <option value="DAY">Day (17:00 NY)</option>
                  <option value="WEEK">Week (Fri 17:00 NY)</option>
                </select>
              </label>
            </div>
          {/if}
        </div>

        {#if submitError}
          <div class="err-box">{submitError}</div>
        {/if}
      </div>

      <!-- Docked Submit CTA -->
      <div class="ticket-foot">
        <button
          class="submit-btn"
          class:buy={side === 'buy' && Boolean(liveQuote)}
          class:sell={side === 'sell' && Boolean(liveQuote)}
          type="button"
          disabled={!liveQuote || resolvedUnits <= 0}
          onclick={handleSubmit}
        >
          {#if !liveQuote}
            <span class="sb-main">Waiting for live quote...</span>
          {:else}
            <span class="sb-main">{side === 'buy' ? 'Buy' : 'Sell'}</span>
            <span class="sb-sub">
              {formatQty(resolvedUnits)} {shortName} @
              {orderType === 'market'
                ? 'MKT'
                : `${formatPaperPrice(Number(priceInput), symbol)} ${orderType.toUpperCase()}`}
            </span>
          {/if}
        </button>
      </div>
    {:else}
      <!-- Honest Level-1 Tick Price Ladder (DOM) -->
      <div class="dom-shell">
        <div class="dom-notice">
          <span>L1 Price Ladder</span>
          <span class="dom-sub">Click Buy/Sell rung for Limit/Stop</span>
        </div>

        <div class="dom-qty-bar">
          <span class="dq-lbl">Qty</span>
          <input type="number" min="0" step={spec.qtyStep} bind:value={domQty} />
          <div class="dq-presets">
            {#each [1, 2, 5, 10] as mult (mult)}
              {@const val = Number((spec.qtyStep * mult).toFixed(4))}
              <button
                class="dq-chip"
                class:active={domQty === val}
                type="button"
                onclick={() => (domQty = val)}
              >
                {formatQty(val)}
              </button>
            {/each}
          </div>
        </div>

        <div class="dom-head-row">
          <span>Buy</span>
          <span>Price</span>
          <span>Sell</span>
        </div>

        <div class="dom-ladder">
          {#if domRows.length === 0}
            <div class="dom-empty">Waiting for live quote on {shortName}...</div>
          {:else}
            {#each domRows as row (row.price)}
              <div
                class="dom-row"
                class:ask={row.isAsk}
                class:bid={row.isBid}
                class:entry={row.isPosEntry}
              >
                <button
                  class="dom-cell buy-col"
                  type="button"
                  title="Place Buy {row.price > (liveQuote?.ask ?? 0) ? 'Stop' : 'Limit'} @ {formatPaperPrice(row.price, symbol)}"
                  onclick={() => placeDomOrder('buy', row.price)}
                >
                  {#if row.buyOrders > 0}
                    <span class="dom-ord buy">{formatQty(row.buyOrders)}</span>
                  {:else}
                    <span class="dom-hover-hint">
                      {row.price > (liveQuote?.ask ?? 0) ? 'B Stp' : 'B Lmt'}
                    </span>
                  {/if}
                </button>

                <div class="dom-px">
                  <span>{formatPaperPrice(row.price, symbol)}</span>
                  {#if row.isPosEntry}
                    <span class="rung-tag pos">AVG</span>
                  {:else if row.isPosTp}
                    <span class="rung-tag tp">TP</span>
                  {:else if row.isPosSl}
                    <span class="rung-tag sl">SL</span>
                  {/if}
                </div>

                <button
                  class="dom-cell sell-col"
                  type="button"
                  title="Place Sell {row.price < (liveQuote?.bid ?? 0) ? 'Stop' : 'Limit'} @ {formatPaperPrice(row.price, symbol)}"
                  onclick={() => placeDomOrder('sell', row.price)}
                >
                  {#if row.sellOrders > 0}
                    <span class="dom-ord sell">{formatQty(row.sellOrders)}</span>
                  {:else}
                    <span class="dom-hover-hint">
                      {row.price < (liveQuote?.bid ?? 0) ? 'S Stp' : 'S Lmt'}
                    </span>
                  {/if}
                </button>
              </div>
            {/each}
          {/if}
        </div>

        <div class="dom-foot">
          <button
            class="dom-act sell"
            type="button"
            disabled={!liveQuote || domQty <= 0}
            onclick={() =>
              placePaperOrder({
                symbol,
                shortName,
                side: 'sell',
                type: 'market',
                quantity: domQty
              })}
          >
            Sell Mkt
          </button>
          <button
            class="dom-act neutral"
            type="button"
            disabled={!activePosition}
            onclick={() => activePosition && reversePaperPosition(activePosition.id)}
          >
            Rev
          </button>
          <button
            class="dom-act neutral"
            type="button"
            disabled={!activePosition}
            onclick={() => activePosition && closePaperPosition(activePosition.id)}
          >
            Flat
          </button>
          <button
            class="dom-act buy"
            type="button"
            disabled={!liveQuote || domQty <= 0}
            onclick={() =>
              placePaperOrder({
                symbol,
                shortName,
                side: 'buy',
                type: 'market',
                quantity: domQty
              })}
          >
            Buy Mkt
          </button>
        </div>
      </div>
    {/if}
  </div>
</aside>

<style>
  .order-ticket {
    position: relative;
    height: 100%;
    flex-shrink: 0;
    background: var(--dark-bg-panel);
    color: var(--dark-text-strong);
    border-left: 1px solid var(--dark-border-subtle);
    display: flex;
    overflow: hidden;
    user-select: none;
  }

  .order-ticket.light {
    background: #ffffff;
    color: #131722;
    border-left-color: #e6e9ef;
  }

  .resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    z-index: 5;
    display: grid;
    place-items: center;
  }

  .resize-pill {
    width: 2px;
    height: 28px;
    border-radius: 99px;
    background: transparent;
    transition: background-color 140ms ease;
  }

  .resize-handle:hover .resize-pill,
  .order-ticket.dragging .resize-pill {
    background: var(--dark-handle);
  }

  .ticket-inner {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .ticket-header {
    height: 44px;
    flex: 0 0 44px;
    padding: 0 12px 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  .order-ticket.light .ticket-header {
    border-bottom-color: #eceff4;
  }

  .th-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .pl-mark {
    width: 20px;
    height: 20px;
    border-radius: 5px;
    background: #ebebeb;
    color: #0d0d0d;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: -0.04em;
    display: grid;
    place-items: center;
    flex: 0 0 20px;
  }

  .order-ticket.light .pl-mark {
    background: #131722;
    color: #ffffff;
  }

  .th-sym {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .th-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .more-anchor {
    position: relative;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    border: 0;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .icon-btn:hover,
  .icon-btn.active {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .order-ticket.light .icon-btn {
    color: #6a7282;
  }

  .order-ticket.light .icon-btn:hover,
  .order-ticket.light .icon-btn.active {
    background: #f0f2f6;
    color: #131722;
  }

  .icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mini-menu {
    position: absolute;
    top: 32px;
    right: 0;
    width: 210px;
    padding: 5px;
    border-radius: 10px;
    background: var(--dark-bg-glass-strong);
    border: 1px solid var(--dark-border-glass);
    box-shadow: var(--dark-shadow-popover);
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .order-ticket.light .mini-menu {
    background: #ffffff;
    border-color: #e0e3eb;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
  }

  .mm-row {
    width: 100%;
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    text-align: left;
  }

  .mm-row:hover {
    background: var(--dark-hover-strong);
  }

  .order-ticket.light .mm-row:hover {
    background: #f2f4f8;
  }

  .mm-val {
    font-size: 11px;
    font-weight: 600;
    color: var(--dark-text-secondary);
  }

  .mm-div {
    height: 1px;
    margin: 3px 6px;
    background: var(--dark-border-subtle);
  }

  .seg-wrap {
    padding: 10px 14px 8px;
    flex: 0 0 auto;
  }

  .seg-track {
    height: 32px;
    padding: 3px;
    border-radius: 8px;
    background: var(--dark-bg-surface-alt);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
  }

  .order-ticket.light .seg-track {
    background: #f0f2f6;
  }

  .seg-btn {
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .seg-btn.active {
    background: var(--dark-bg-elevated-hover);
    color: var(--dark-text-strong);
    font-weight: 600;
  }

  .order-ticket.light .seg-btn {
    color: #5d6473;
  }

  .order-ticket.light .seg-btn.active {
    background: #ffffff;
    color: #131722;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
  }

  .sizer-banner {
    margin: 0 14px 8px;
    padding: 6px 10px;
    border-radius: 7px;
    font-size: 11.5px;
    font-weight: 500;
    background: rgba(8, 153, 129, 0.14);
    color: #20c9ad;
    border: 1px solid rgba(8, 153, 129, 0.3);
  }

  .order-ticket.light .sizer-banner {
    color: #067a67;
  }

  .ticket-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .side-box {
    position: relative;
    height: 54px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-radius: 8px;
    overflow: hidden;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border);
  }

  .order-ticket.light .side-box {
    background: #f5f6f9;
    border-color: #e0e3eb;
  }

  .side-half {
    border: 0;
    padding: 7px 11px;
    background: transparent;
    color: var(--dark-text-soft);
    font-family: inherit;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .side-half.sell {
    align-items: flex-start;
    text-align: left;
  }

  .side-half.buy {
    align-items: flex-end;
    text-align: right;
  }

  .side-half.sell.selected {
    background: rgba(242, 54, 69, 0.16);
    color: #ff6b76;
  }

  .side-half.buy.selected {
    background: rgba(41, 98, 255, 0.18);
    color: #6b96ff;
  }

  .order-ticket.light .side-half {
    color: #4a5160;
  }

  .order-ticket.light .side-half.sell.selected {
    background: rgba(242, 54, 69, 0.14);
    color: #e02938;
  }

  .order-ticket.light .side-half.buy.selected {
    background: rgba(41, 98, 255, 0.14);
    color: #2962ff;
  }

  .side-lbl {
    font-size: 11px;
    font-weight: 600;
  }

  .side-px {
    font-size: 14.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .spread-badge {
    position: absolute;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    height: 18px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-soft);
    border: 1px solid var(--dark-border-strong);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .order-ticket.light .spread-badge {
    background: #ffffff;
    border-color: #e0e3eb;
    color: #5d6473;
  }

  .type-tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  .order-ticket.light .type-tabs {
    border-bottom-color: #e6e9ef;
  }

  .type-tab {
    height: 32px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    margin-bottom: -1px;
  }

  .type-tab.active {
    color: var(--dark-text-strong);
    font-weight: 600;
    border-bottom-color: var(--dark-text-strong);
  }

  .order-ticket.light .type-tab {
    color: #6a7282;
  }

  .order-ticket.light .type-tab.active {
    color: #131722;
    border-bottom-color: #131722;
  }

  .field-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .f-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--dark-text-secondary);
  }

  .order-ticket.light .f-label {
    color: #5d6473;
  }

  .f-label-row {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .mode-trigger {
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--dark-text-primary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  .mode-trigger svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.7;
  }

  .sizer-pull-chip {
    border: 0;
    padding: 2px 7px;
    border-radius: 5px;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-soft);
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 500;
    cursor: pointer;
  }

  .sizer-pull-chip:hover {
    background: var(--dark-bg-elevated-hover);
    color: var(--dark-text-strong);
  }

  .order-ticket.light .sizer-pull-chip {
    background: #f0f2f6;
    color: #4a5160;
  }

  .qty-popover {
    position: absolute;
    top: 22px;
    left: 0;
    width: 215px;
    padding: 4px;
    border-radius: 9px;
    background: var(--dark-bg-glass-strong);
    border: 1px solid var(--dark-border-glass);
    box-shadow: var(--dark-shadow-popover);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .order-ticket.light .qty-popover {
    background: #ffffff;
    border-color: #e0e3eb;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.14);
  }

  .qp-opt {
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .qp-opt:hover {
    background: var(--dark-hover-strong);
  }

  .qp-opt.active {
    background: var(--dark-bg-active);
    font-weight: 600;
  }

  .order-ticket.light .qp-opt:hover {
    background: #f2f4f8;
  }

  .order-ticket.light .qp-opt.active {
    background: #e9ecf3;
  }

  .dual-input {
    height: 36px;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    border-radius: 7px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    padding: 0 8px;
    gap: 6px;
  }

  .dual-input:focus-within {
    border-color: var(--dark-handle-hover);
  }

  .dual-input.disabled {
    opacity: 0.45;
  }

  .order-ticket.light .dual-input {
    background: #ffffff;
    border-color: #d6dae1;
  }

  .dual-input input {
    width: 100%;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    outline: none;
  }

  .order-ticket.light .dual-input input {
    color: #131722;
  }

  .dual-input input.rhs-input {
    text-align: right;
    color: var(--dark-text-soft);
    font-size: 12px;
  }

  .order-ticket.light .dual-input input.rhs-input {
    color: #5d6473;
  }

  .swap-ic {
    font-size: 11px;
    color: var(--dark-text-muted);
    user-select: none;
  }

  .rhs-readout {
    text-align: right;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    color: var(--dark-text-soft);
    white-space: nowrap;
  }

  .order-ticket.light .rhs-readout {
    color: #4a5160;
  }

  .unit-sm {
    font-size: 10.5px;
    color: var(--dark-text-secondary);
  }

  .info-card {
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border-subtle);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .order-ticket.light .info-card {
    background: #f5f6f9;
    border-color: #eceff4;
  }

  .info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }

  .ik {
    color: var(--dark-text-secondary);
  }

  .order-ticket.light .ik {
    color: #6a7282;
  }

  .iv {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .iv small {
    font-size: 10px;
    font-weight: 500;
    opacity: 0.72;
  }

  .iv.neg {
    color: #f23645;
  }

  .rr-chip {
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(8, 153, 129, 0.16);
    color: #20c9ad;
    font-size: 10.5px;
  }

  .order-ticket.light .rr-chip {
    color: #067a67;
  }

  .accordion {
    border-top: 1px solid var(--dark-border-subtle);
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .order-ticket.light .accordion {
    border-top-color: #eceff4;
  }

  .acc-head {
    width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
  }

  .acc-head svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.65;
    transition: transform 140ms ease;
  }

  .acc-head svg.open {
    transform: rotate(180deg);
  }

  .acc-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .exit-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .exit-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .exit-lbl {
    font-size: 12px;
    color: var(--dark-text-secondary);
  }

  .order-ticket.light .exit-lbl {
    color: #5d6473;
  }

  .switch {
    width: 34px;
    height: 18px;
    padding: 2px;
    border-radius: 999px;
    border: 0;
    background: var(--dark-border-strong);
    display: flex;
    align-items: center;
    cursor: pointer;
    transition: background-color 140ms ease;
  }

  .order-ticket.light .switch {
    background: #cfd4de;
  }

  .switch.on {
    background: #2962ff;
  }

  .switch .knob {
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: #ffffff;
    transform: translateX(0);
    transition: transform 140ms ease;
  }

  .switch.on .knob {
    transform: translateX(16px);
  }

  .exit-hint {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .exit-hint.pos {
    color: #089981;
  }

  .exit-hint.neg {
    color: #f23645;
  }

  .tif-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: var(--dark-text-secondary);
  }

  .tif-field select {
    height: 34px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12.5px;
    outline: none;
  }

  .order-ticket.light .tif-field select {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .err-box {
    padding: 8px 10px;
    border-radius: 7px;
    background: rgba(242, 54, 69, 0.14);
    border: 1px solid rgba(242, 54, 69, 0.35);
    color: #ff7a84;
    font-size: 11.5px;
    line-height: 1.4;
  }

  .order-ticket.light .err-box {
    color: #d92635;
  }

  .ticket-foot {
    padding: 10px 14px 12px;
    border-top: 1px solid var(--dark-border-subtle);
    flex: 0 0 auto;
  }

  .order-ticket.light .ticket-foot {
    border-top-color: #eceff4;
  }

  .submit-btn {
    width: 100%;
    height: 44px;
    border: 0;
    border-radius: 8px;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-soft);
    font-family: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    cursor: pointer;
    transition: opacity 130ms ease, background-color 130ms ease;
  }

  .submit-btn.buy {
    background: #2962ff;
    color: #ffffff;
  }

  .submit-btn.sell {
    background: #f23645;
    color: #ffffff;
  }

  .submit-btn:hover:not(:disabled) {
    opacity: 0.92;
  }

  .submit-btn:disabled {
    opacity: 0.48;
    cursor: not-allowed;
  }

  .sb-main {
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.15;
  }

  .sb-sub {
    font-size: 10.5px;
    font-weight: 500;
    opacity: 0.88;
    font-variant-numeric: tabular-nums;
  }

  /* ── DOM Price Ladder ─────────────────────────────────────────────────── */
  .dom-shell {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0 12px 12px;
    gap: 8px;
  }

  .dom-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border-subtle);
    font-size: 11px;
    font-weight: 600;
  }

  .order-ticket.light .dom-notice {
    background: #f5f6f9;
    border-color: #eceff4;
  }

  .dom-sub {
    font-weight: 400;
    color: var(--dark-text-secondary);
    font-size: 10.5px;
  }

  .dom-qty-bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dq-lbl {
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .dom-qty-bar input {
    width: 68px;
    height: 28px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .order-ticket.light .dom-qty-bar input {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .dq-presets {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }

  .dq-chip {
    height: 26px;
    padding: 0 7px;
    border-radius: 5px;
    border: 1px solid var(--dark-border);
    background: var(--dark-bg-surface);
    color: var(--dark-text-soft);
    font-family: inherit;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .dq-chip.active {
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    border-color: transparent;
    font-weight: 600;
  }

  .order-ticket.light .dq-chip {
    background: #f5f6f9;
    border-color: #e0e3eb;
    color: #4a5160;
  }

  .order-ticket.light .dq-chip.active {
    background: #131722;
    color: #ffffff;
  }

  .dom-head-row {
    display: grid;
    grid-template-columns: 1fr 1.25fr 1fr;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--dark-text-secondary);
    text-align: center;
    padding: 0 2px;
  }

  .dom-ladder {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-radius: 8px;
    border: 1px solid var(--dark-border-subtle);
    background: var(--dark-bg-surface);
  }

  .order-ticket.light .dom-ladder {
    background: #f8f9fc;
    border-color: #e6e9ef;
  }

  .dom-empty {
    padding: 24px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--dark-text-secondary);
  }

  .dom-row {
    height: 26px;
    display: grid;
    grid-template-columns: 1fr 1.25fr 1fr;
    border-bottom: 1px solid var(--dark-border-subtle);
    align-items: center;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .order-ticket.light .dom-row {
    border-bottom-color: #eceff4;
  }

  .dom-row.ask {
    background: rgba(41, 98, 255, 0.14);
  }

  .dom-row.bid {
    background: rgba(242, 54, 69, 0.14);
  }

  .dom-row.entry {
    background: rgba(255, 255, 255, 0.09);
  }

  .dom-cell {
    height: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }

  .dom-cell.buy-col:hover {
    background: rgba(41, 98, 255, 0.25);
    color: #ffffff;
  }

  .dom-cell.sell-col:hover {
    background: rgba(242, 54, 69, 0.25);
    color: #ffffff;
  }

  .dom-hover-hint {
    opacity: 0;
    font-size: 10px;
    font-weight: 600;
  }

  .dom-cell:hover .dom-hover-hint {
    opacity: 1;
  }

  .dom-ord {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 700;
  }

  .dom-ord.buy {
    background: #2962ff;
    color: #ffffff;
  }

  .dom-ord.sell {
    background: #f23645;
    color: #ffffff;
  }

  .dom-px {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-weight: 600;
  }

  .rung-tag {
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
  }

  .rung-tag.pos {
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
  }

  .rung-tag.tp {
    background: #089981;
    color: #ffffff;
  }

  .rung-tag.sl {
    background: #f23645;
    color: #ffffff;
  }

  .dom-foot {
    display: grid;
    grid-template-columns: 1.2fr 0.8fr 0.8fr 1.2fr;
    gap: 5px;
    flex: 0 0 auto;
  }

  .dom-act {
    height: 34px;
    border: 0;
    border-radius: 7px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .dom-act.sell {
    background: #f23645;
    color: #ffffff;
  }

  .dom-act.buy {
    background: #2962ff;
    color: #ffffff;
  }

  .dom-act.neutral {
    background: var(--dark-bg-elevated);
    color: var(--dark-text-primary);
    border: 1px solid var(--dark-border);
  }

  .order-ticket.light .dom-act.neutral {
    background: #f0f2f6;
    color: #131722;
    border-color: #d6dae1;
  }

  .dom-act:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
