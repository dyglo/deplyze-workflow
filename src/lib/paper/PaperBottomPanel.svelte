<script lang="ts">
  import { onMount } from 'svelte';
  import { savePaperTradeToPlaybook } from '../playbook/store';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    computePnlUsd,
    formatPaperPrice,
    formatQty,
    formatSplitPrice,
    formatUsd,
    normalizeSymbolKey
  } from './instruments';
  import {
    cancelWorkingOrder,
    computeAccountMetrics,
    computePaperAnalytics,
    computePositionMetrics,
    disconnectPaperLedger,
    exportPaperTabToCsv,
    getActivePaperAccount,
    markTradeSentToPlaybook,
    removePositionBracket,
    setPaperBottomHeight,
    setPaperBottomMode,
    setPaperBottomTab,
    subscribePaper,
    subscribePaperQuotes,
    switchPaperAccount,
    updatePaperSettings
  } from './store';
  import type {
    ActivityCategory,
    ClosedTrade,
    OrderSide,
    OrderStatus,
    PaperBottomTab,
    PaperLedgerState,
    PaperLiveQuote,
    PaperOrder,
    PaperPosition
  } from './types';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onOpenSettings: () => void;
    onRequestClosePosition: (position: PaperPosition) => void;
    onRequestModifyPosition: (position: PaperPosition, focusField?: 'tp' | 'sl' | null) => void;
  }

  let {
    theme,
    activeSymbol,
    onSelectSymbol,
    onOpenSettings,
    onRequestClosePosition,
    onRequestModifyPosition
  }: Props = $props();

  let ledger = $state<PaperLedgerState | null>(null);
  let quotes = $state<Record<string, PaperLiveQuote>>({});

  let brokerMenuOpen = $state(false);
  let accountMenuOpen = $state(false);
  let columnsMenuOpen = $state(false);

  // Expanded position fill legs (when a position was built from 2+ orders)
  let expandedPosIds = $state<Record<string, boolean>>({});

  // Sub-tab filters
  let ordersFilter = $state<'all' | 'entry' | 'brackets'>('all');
  let orderHistFilter = $state<'all' | OrderStatus>('all');
  let activityFilter = $state<'all' | ActivityCategory>('all');

  // Visible columns toggle
  let showColTradeValue = $state(true);
  let showColLiveR = $state(true);

  // Vertical resize dragging
  let dragging = $state(false);
  let dragStartY = 0;
  let dragStartH = 300;
  let localHeight = $state(300);

  // Analytics hover points
  let hoverIdx = $state<number | null>(null);
  let hoverBarIdx = $state<number | null>(null);

  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);
  const metrics = $derived(account ? computeAccountMetrics(account, quotes) : null);
  const analytics = $derived(account ? computePaperAnalytics(account) : null);
  const activeSymKey = $derived(normalizeSymbolKey(activeSymbol || ''));
  const privacy = $derived(Boolean(account?.settings.privacyMask));

  const mode = $derived(ledger?.bottomMode ?? 'collapsed');
  const activeTab = $derived(ledger?.activeBottomTab ?? 'positions');

  interface UnifiedWorkingOrder {
    id: string;
    rowKind: 'entry' | 'tp' | 'sl';
    symbol: string;
    shortName: string;
    side: OrderSide;
    typeLabel: string;
    quantity: number;
    orderPrice: number | null;
    takeProfit: number | null;
    stopLoss: number | null;
    estPnl: number | null;
    tif: string;
    placedAt: string;
    entryOrder?: PaperOrder;
    parentPosition?: PaperPosition;
  }

  // Combine pending Limit/Stop entry orders + distinct active TP & SL bracket orders
  const unifiedOrders = $derived.by((): UnifiedWorkingOrder[] => {
    if (!account) return [];
    const list: UnifiedWorkingOrder[] = [];

    for (const ord of account.orders) {
      list.push({
        id: ord.id,
        rowKind: 'entry',
        symbol: ord.symbol,
        shortName: ord.shortName,
        side: ord.side,
        typeLabel: ord.type === 'limit' ? 'Limit' : 'Stop',
        quantity: ord.quantity,
        orderPrice: ord.orderPrice,
        takeProfit: ord.takeProfit,
        stopLoss: ord.stopLoss,
        estPnl: null,
        tif: ord.tif,
        placedAt: ord.placedAt,
        entryOrder: ord
      });
    }

    for (const pos of account.positions) {
      const closeSide: OrderSide = pos.side === 'long' ? 'sell' : 'buy';
      if (pos.takeProfit !== null) {
        list.push({
          id: `${pos.id}-tp`,
          rowKind: 'tp',
          symbol: pos.symbol,
          shortName: pos.shortName,
          side: closeSide,
          typeLabel: 'Take Profit (Limit)',
          quantity: pos.quantity,
          orderPrice: pos.takeProfit,
          takeProfit: null,
          stopLoss: null,
          estPnl: computePnlUsd(pos.symbol, pos.side, pos.quantity, pos.avgFillPrice, pos.takeProfit),
          tif: 'OCO',
          placedAt: pos.updatedAt,
          parentPosition: pos
        });
      }
      if (pos.stopLoss !== null) {
        list.push({
          id: `${pos.id}-sl`,
          rowKind: 'sl',
          symbol: pos.symbol,
          shortName: pos.shortName,
          side: closeSide,
          typeLabel: 'Stop Loss (Stop)',
          quantity: pos.quantity,
          orderPrice: pos.stopLoss,
          takeProfit: null,
          stopLoss: null,
          estPnl: computePnlUsd(pos.symbol, pos.side, pos.quantity, pos.avgFillPrice, pos.stopLoss),
          tif: 'OCO',
          placedAt: pos.updatedAt,
          parentPosition: pos
        });
      }
    }

    return list;
  });

  const filteredUnifiedOrders = $derived.by(() => {
    if (ordersFilter === 'entry') return unifiedOrders.filter((o) => o.rowKind === 'entry');
    if (ordersFilter === 'brackets') return unifiedOrders.filter((o) => o.rowKind !== 'entry');
    return unifiedOrders;
  });

  const filteredOrderHistory = $derived.by(() => {
    if (!account) return [];
    if (orderHistFilter === 'all') return account.orderHistory;
    return account.orderHistory.filter((o) => o.status === orderHistFilter);
  });

  const filteredActivity = $derived.by(() => {
    if (!account) return [];
    if (activityFilter === 'all') return account.activityLog;
    return account.activityLog.filter((a) => a.category === activityFilter);
  });

  const totalCommissions = $derived.by(() => {
    if (!account) return 0;
    return account.balanceHistory
      .filter((b) => b.kind === 'commission')
      .reduce((sum, b) => sum + Math.abs(b.delta), 0);
  });

  const TABS: { id: PaperBottomTab; label: string }[] = [
    { id: 'positions', label: 'Positions' },
    { id: 'orders', label: 'Orders' },
    { id: 'order_history', label: 'Order history' },
    { id: 'balance_history', label: 'Balance history' },
    { id: 'activity_log', label: 'Activity log' },
    { id: 'trade_history', label: 'Trade history' },
    { id: 'analytics', label: 'Analytics' }
  ];

  onMount(() => {
    const unsub1 = subscribePaper((s) => {
      ledger = s;
      if (!dragging) localHeight = s.bottomHeight;
    });
    const unsub2 = subscribePaperQuotes((q) => {
      quotes = q;
    });
    const onDocDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (brokerMenuOpen && !target?.closest('[data-pl-broker-menu]')) brokerMenuOpen = false;
      if (accountMenuOpen && !target?.closest('[data-pl-acct-menu]')) accountMenuOpen = false;
      if (columnsMenuOpen && !target?.closest('[data-pl-cols-menu]')) columnsMenuOpen = false;
    };
    window.addEventListener('pointerdown', onDocDown);
    return () => {
      unsub1();
      unsub2();
      window.removeEventListener('pointerdown', onDocDown);
    };
  });

  function mask(val: string): string {
    return privacy ? '•••••' : val;
  }

  function formatTs(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-US', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    } catch {
      return iso;
    }
  }

  function formatHoldDuration(openedAt: string, closedAt: string): string {
    const ms = Date.parse(closedAt) - Date.parse(openedAt);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMin = mins % 60;
    if (hrs < 24) return `${hrs}h ${remMin}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
  }

  function formatAvgMinutes(mins: number | null): string {
    if (mins === null || !Number.isFinite(mins)) return '—';
    if (mins < 1) return `${Math.round(mins * 60)}s`;
    if (mins < 60) return `${Math.round(mins)}m`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${h}h ${m}m`;
  }

  function toggleExpandFills(posId: string) {
    expandedPosIds = { ...expandedPosIds, [posId]: !expandedPosIds[posId] };
  }

  async function handleSendTradeToPlaybook(trade: ClosedTrade) {
    if (trade.sentToPlaybook) return;
    const entry = await savePaperTradeToPlaybook({
      tradeId: trade.id,
      symbol: trade.shortName,
      fullSymbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      realizedPnl: trade.realizedPnl,
      realizedR: trade.realizedR,
      closeReason: trade.closeReason,
      closedAt: trade.closedAt
    });
    markTradeSentToPlaybook(trade.id, entry.id);
  }

  function onResizeDown(e: PointerEvent) {
    if (e.button !== 0 || mode !== 'expanded') return;
    dragging = true;
    dragStartY = e.clientY;
    dragStartH = localHeight;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onResizeMove(e: PointerEvent) {
    if (!dragging) return;
    const maxH = typeof window !== 'undefined' ? Math.round(window.innerHeight * 0.75) : 660;
    localHeight = Math.round(Math.max(200, Math.min(maxH, dragStartH + (dragStartY - e.clientY))));
  }

  function onResizeUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    setPaperBottomHeight(localHeight);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  // ── SVG Equity & Drawdown Chart Helpers ────────────────────────────────────
  const EQ_W = 680;
  const EQ_H = 140;
  const DD_H = 66;
  const PAD_L = 60;
  const PAD_R = 14;
  const PAD_T = 12;
  const PAD_B = 18;

  const eqGeometry = $derived.by(() => {
    const pts = analytics?.equitySeries ?? [];
    if (pts.length === 0) return null;
    const equities = pts.map((p) => p.equity);
    let minE = Math.min(...equities);
    let maxE = Math.max(...equities);
    if (Math.abs(maxE - minE) < 1) {
      minE -= 50;
      maxE += 50;
    } else {
      const pad = (maxE - minE) * 0.1;
      minE -= pad;
      maxE += pad;
    }
    const maxDd = Math.max(0.5, ...pts.map((p) => p.drawdownPct));
    const plotW = EQ_W - PAD_L - PAD_R;
    const plotH = EQ_H - PAD_T - PAD_B;
    const ddPlotH = DD_H - 18;

    const coords = pts.map((p, i) => {
      const x = pts.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (pts.length - 1)) * plotW;
      const y = PAD_T + ((maxE - p.equity) / (maxE - minE)) * plotH;
      const ddY = 6 + (p.drawdownPct / maxDd) * ddPlotH;
      return { x, y, ddY, point: p };
    });

    const linePath = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(' ');
    const areaPath =
      coords.length > 0
        ? `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${coords[0].x.toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`
        : '';

    const ddLine = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.ddY.toFixed(1)}`)
      .join(' ');
    const ddArea =
      coords.length > 0
        ? `M${coords[0].x.toFixed(1)},6 ${coords.map((c) => `L${c.x.toFixed(1)},${c.ddY.toFixed(1)}`).join(' ')} L${coords[coords.length - 1].x.toFixed(1)},6 Z`
        : '';

    const startBal = account?.settings.startingBalance ?? 100000;
    const baselineY = PAD_T + ((maxE - startBal) / (maxE - minE)) * plotH;
    const isUp = (pts[pts.length - 1]?.equity ?? startBal) >= startBal;

    return { coords, linePath, areaPath, ddLine, ddArea, minE, maxE, maxDd, baselineY, isUp };
  });

  // Per-trade PnL histogram geometry
  const tradeBars = $derived.by(() => {
    const pts = (analytics?.equitySeries ?? []).slice(1);
    if (pts.length === 0) return null;
    const maxAbs = Math.max(1, ...pts.map((p) => Math.abs(p.tradePnl ?? 0)));
    const W = 420;
    const H = 120;
    const midY = H / 2;
    const barGap = 4;
    const barW = Math.max(6, Math.min(28, (W - 20 - barGap * pts.length) / pts.length));
    const startX = 10;

    const bars = pts.map((p, i) => {
      const val = p.tradePnl ?? 0;
      const h = Math.max(2, (Math.abs(val) / maxAbs) * (midY - 12));
      const x = startX + i * (barW + barGap);
      const y = val >= 0 ? midY - h : midY;
      return { x, y, w: barW, h, val, point: p };
    });

    return { W, H, midY, bars };
  });

  const hoveredCoord = $derived(
    eqGeometry && hoverIdx !== null && eqGeometry.coords[hoverIdx]
      ? eqGeometry.coords[hoverIdx]
      : null
  );

  const hoveredBar = $derived(
    tradeBars && hoverBarIdx !== null && tradeBars.bars[hoverBarIdx]
      ? tradeBars.bars[hoverBarIdx]
      : null
  );
</script>

{#if ledger?.connected && account && metrics}
  <section
    class="paper-bottom"
    class:light={theme === 'light'}
    class:collapsed={mode === 'collapsed'}
    class:expanded={mode === 'expanded'}
    class:fullscreen={mode === 'fullscreen'}
    class:dragging
    style:height={mode === 'expanded' ? `${localHeight}px` : undefined}
    aria-label="Paper Ledger panel"
  >
    {#if mode === 'expanded'}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="top-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Paper Ledger panel"
        onpointerdown={onResizeDown}
        onpointermove={onResizeMove}
        onpointerup={onResizeUp}
        onpointercancel={onResizeUp}
      ></div>
    {/if}

    <!-- Top Panel Chrome Bar (36px) -->
    <div class="pb-bar">
      <div class="bar-left">
        <div class="broker-anchor" data-pl-broker-menu>
          <button
            class="broker-trigger"
            type="button"
            onclick={() => (brokerMenuOpen = !brokerMenuOpen)}
          >
            <span class="pl-ico" aria-hidden="true">
              <span class="pl-txt">PL</span>
              <span class="pl-dot"></span>
            </span>
            <span class="broker-title">Paper Ledger</span>
            <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" />
            </svg>
          </button>

          {#if brokerMenuOpen}
            <div class="drop-menu" class:up={mode === 'collapsed'}>
              <button
                class="dm-item"
                type="button"
                onclick={() => {
                  brokerMenuOpen = false;
                  onOpenSettings();
                }}
              >
                Account settings & reset
              </button>
              <button
                class="dm-item"
                type="button"
                onclick={() => {
                  brokerMenuOpen = false;
                  exportPaperTabToCsv(account, activeTab);
                }}
              >
                Export active tab CSV
              </button>
              <div class="dm-div"></div>
              <button
                class="dm-item danger"
                type="button"
                onclick={() => {
                  brokerMenuOpen = false;
                  disconnectPaperLedger();
                }}
              >
                Disconnect Paper Ledger
              </button>
            </div>
          {/if}
        </div>

        {#if mode === 'collapsed'}
          <button
            class="collapsed-summary"
            type="button"
            title="Expand Paper Ledger"
            onclick={() => setPaperBottomMode('expanded')}
          >
            <span class="cs-item">
              <span class="cs-k">Equity</span>
              <span class="cs-v">{mask(formatUsd(metrics.equity))}</span>
            </span>
            <span class="cs-sep">·</span>
            <span class="cs-item">
              <span class="cs-k">Open P&L</span>
              <span
                class="cs-v"
                class:pos={metrics.unrealizedPnl > 0.004}
                class:neg={metrics.unrealizedPnl < -0.004}
              >
                {mask(formatUsd(metrics.unrealizedPnl, true))}
              </span>
            </span>
            {#if account.positions.length > 0}
              <span class="cs-badge">{account.positions.length} open</span>
            {/if}
            {#if unifiedOrders.length > 0}
              <span class="cs-badge">{unifiedOrders.length} orders</span>
            {/if}
          </button>
        {/if}
      </div>

      <div class="bar-right">
        {#if mode === 'collapsed'}
          <button
            class="bar-icon"
            type="button"
            title="Expand Paper Ledger"
            aria-label="Expand Paper Ledger"
            onclick={() => setPaperBottomMode('expanded')}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 10 8 6l4 4" />
            </svg>
          </button>
        {:else}
          <button
            class="bar-icon"
            type="button"
            title="Minimize to bar"
            aria-label="Minimize to bar"
            onclick={() => setPaperBottomMode('collapsed')}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 10.5h9" />
            </svg>
          </button>
        {/if}

        <button
          class="bar-icon"
          type="button"
          title={mode === 'fullscreen' ? 'Restore panel height' : 'Maximize to fullscreen'}
          aria-label={mode === 'fullscreen' ? 'Restore panel height' : 'Maximize to fullscreen'}
          onclick={() => setPaperBottomMode(mode === 'fullscreen' ? 'expanded' : 'fullscreen')}
        >
          {#if mode === 'fullscreen'}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
            </svg>
          {/if}
        </button>
      </div>
    </div>

    {#if mode !== 'collapsed'}
      <!-- Account Summary Pill Bar -->
      <div class="summary-strip-wrap">
        <div class="summary-strip">
          <div class="acct-menu-anchor" data-pl-acct-menu>
            <button
              class="acct-pill-btn"
              type="button"
              onclick={() => (accountMenuOpen = !accountMenuOpen)}
            >
              <span class="ap-name">{account.name}</span>
              <span class="ap-bal">{mask(formatUsd(metrics.balance))} <small>USD</small></span>
              <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4.5 6 7.5 9 4.5" />
              </svg>
            </button>

            {#if accountMenuOpen}
              <div class="drop-menu">
                {#each ledger.accounts as a (a.id)}
                  <button
                    class="dm-item"
                    class:active={a.id === account.id}
                    type="button"
                    onclick={() => {
                      switchPaperAccount(a.id);
                      accountMenuOpen = false;
                    }}
                  >
                    <span>{a.name}</span>
                    <span class="dm-sub">{formatUsd(a.balance)} USD</span>
                  </button>
                {/each}
                <div class="dm-div"></div>
                <button
                  class="dm-item"
                  type="button"
                  onclick={() => {
                    accountMenuOpen = false;
                    onOpenSettings();
                  }}
                >
                  Manage / Reset accounts...
                </button>
              </div>
            {/if}
          </div>

          <div class="metrics-scroll">
            <div class="m-item">
              <span class="m-k">Unrealized PnL</span>
              <span
                class="m-v"
                class:pos={metrics.unrealizedPnl > 0.004}
                class:neg={metrics.unrealizedPnl < -0.004}
              >
                {mask(formatUsd(metrics.unrealizedPnl, true))}
              </span>
            </div>

            <div class="m-item">
              <span class="m-k">Realized PnL</span>
              <span
                class="m-v"
                class:pos={metrics.realizedPnl > 0.004}
                class:neg={metrics.realizedPnl < -0.004}
              >
                {mask(formatUsd(metrics.realizedPnl, true))}
              </span>
            </div>

            <div class="m-item">
              <span class="m-k">Equity</span>
              <span class="m-v">{mask(formatUsd(metrics.equity))}</span>
            </div>

            <div
              class="m-item"
              title="Margin locked by open positions at {account.settings.leverage}:1 leverage"
            >
              <span class="m-k dashed">Account margin</span>
              <span class="m-v">{mask(formatUsd(metrics.usedMargin))}</span>
            </div>

            <div class="m-item" title="Equity minus Account margin available for new orders">
              <span class="m-k dashed">Available funds</span>
              <span class="m-v">{mask(formatUsd(metrics.availableFunds))}</span>
            </div>

            <div class="m-item" title="Percentage of equity remaining above required margin">
              <span class="m-k dashed">Margin buffer</span>
              <span class="m-v">{mask(`${metrics.marginBufferPct.toFixed(1)}%`)}</span>
            </div>
          </div>

          <button
            class="eye-btn"
            type="button"
            title={privacy ? 'Show dollar amounts' : 'Hide dollar amounts'}
            aria-label={privacy ? 'Show dollar amounts' : 'Hide dollar amounts'}
            onclick={() => updatePaperSettings({ privacyMask: !privacy })}
          >
            {#if privacy}
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M2.5 2.5 15.5 15.5" />
                <path d="M7.6 4.7A6.7 6.7 0 0 1 9 4.5c3.8 0 6.5 3 7.3 4.5a11.7 11.7 0 0 1-2.2 2.7" />
                <path d="M4.6 6.2A11.4 11.4 0 0 0 1.7 9c.8 1.5 3.5 4.5 7.3 4.5 1.1 0 2.1-.2 3-.6" />
              </svg>
            {:else}
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M1.7 9C2.5 7.5 5.2 4.5 9 4.5s6.5 3 7.3 4.5c-.8 1.5-3.5 4.5-7.3 4.5S2.5 10.5 1.7 9Z" />
                <circle cx="9" cy="9" r="2.2" />
              </svg>
            {/if}
          </button>
        </div>
      </div>

      <!-- 7 Sub-Tab Pills + CSV Export -->
      <div class="tabs-bar">
        <div class="pill-tabs" role="tablist">
          {#each TABS as t (t.id)}
            {@const badgeCount =
              t.id === 'positions'
                ? account.positions.length
                : t.id === 'orders'
                  ? unifiedOrders.length
                  : t.id === 'trade_history'
                    ? account.tradeHistory.length
                    : 0}
            <button
              class="ptab"
              class:active={activeTab === t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              onclick={() => setPaperBottomTab(t.id)}
            >
              <span>{t.label}</span>
              {#if badgeCount > 0}
                <span class="ptab-cnt">{badgeCount}</span>
              {/if}
            </button>
          {/each}
        </div>

        <button
          class="export-btn"
          type="button"
          title="Export {activeTab.replace('_', ' ')} as CSV"
          aria-label="Export CSV"
          onclick={() => exportPaperTabToCsv(account, activeTab)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.75v7.5M5 7.5l3 3 3-3M3 13.25h10" />
          </svg>
        </button>
      </div>

      <!-- Tab Content Area -->
      <div class="tab-content">
        {#if activeTab === 'positions'}
          {#if account.positions.length === 0}
            <div class="empty-tab">
              No open positions. Use the chart <strong>SELL / BUY</strong> pills or the Order Panel to place a simulated trade.
            </div>
          {:else}
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Quantity</th>
                    <th class="num">Avg fill price</th>
                    <th class="num">Take profit</th>
                    <th class="num">Stop loss</th>
                    <th class="num">Last price</th>
                    <th class="num">Unrealized PnL</th>
                    <th class="num">Unrealized PnL %</th>
                    {#if showColLiveR}
                      <th class="num">Live R</th>
                    {/if}
                    {#if showColTradeValue}
                      <th class="num">Trade value</th>
                    {/if}
                    <th class="act-col">
                      <div class="cols-anchor" data-pl-cols-menu>
                        <button
                          class="cols-btn"
                          type="button"
                          title="Columns"
                          aria-label="Columns"
                          onclick={() => (columnsMenuOpen = !columnsMenuOpen)}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <rect x="2.25" y="3" width="2.5" height="10" rx="0.6" />
                            <rect x="6.75" y="3" width="2.5" height="10" rx="0.6" />
                            <rect x="11.25" y="3" width="2.5" height="10" rx="0.6" />
                          </svg>
                        </button>
                        {#if columnsMenuOpen}
                          <div class="drop-menu right">
                            <label class="col-chk">
                              <input type="checkbox" bind:checked={showColLiveR} />
                              <span>Live R</span>
                            </label>
                            <label class="col-chk">
                              <input type="checkbox" bind:checked={showColTradeValue} />
                              <span>Trade value</span>
                            </label>
                          </div>
                        {/if}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {#each account.positions as pos (pos.id)}
                    {@const pm = computePositionMetrics(
                      pos,
                      quotes,
                      account.settings.leverage,
                      account.settings.zeroSpread
                    )}
                    {@const lastParts = formatSplitPrice(pm.lastPrice, pos.symbol)}
                    {@const isChartSym = normalizeSymbolKey(pos.symbol) === activeSymKey}
                    {@const fillsCount = pos.fills?.length ?? 0}
                    <tr>
                      <td>
                        <div class="sym-wrap">
                          <button
                            class="sym-cell"
                            type="button"
                            onclick={() => onSelectSymbol(pos.symbol, pos.shortName)}
                          >
                            <SymbolIcon symbol={pos.shortName} size={20} />
                            <span class="sym-chip" class:active={isChartSym}>{pos.symbol}</span>
                          </button>
                          {#if fillsCount > 1}
                            <button
                              class="legs-btn"
                              type="button"
                              title="Show individual executed orders in this position"
                              onclick={() => toggleExpandFills(pos.id)}
                            >
                              {fillsCount} fills {expandedPosIds[pos.id] ? '▴' : '▾'}
                            </button>
                          {/if}
                        </div>
                      </td>
                      <td>
                        <span class="side-txt" class:long={pos.side === 'long'} class:short={pos.side === 'short'}>
                          {pos.side === 'long' ? 'Long' : 'Short'}
                        </span>
                      </td>
                      <td class="num">{formatQty(pos.quantity)}</td>
                      <td class="num">{formatPaperPrice(pos.avgFillPrice, pos.symbol)}</td>
                      <td class="num">
                        <button
                          class="bracket-cell-btn"
                          class:set-tp={pos.takeProfit !== null}
                          type="button"
                          title="Click to add or modify Take Profit"
                          onclick={() => onRequestModifyPosition(pos, 'tp')}
                        >
                          {#if pos.takeProfit !== null}
                            {formatPaperPrice(pos.takeProfit, pos.symbol)}
                          {:else}
                            <span class="add-bracket-lbl">+ Add TP</span>
                          {/if}
                        </button>
                      </td>
                      <td class="num">
                        <button
                          class="bracket-cell-btn"
                          class:set-sl={pos.stopLoss !== null}
                          type="button"
                          title="Click to add or modify Stop Loss"
                          onclick={() => onRequestModifyPosition(pos, 'sl')}
                        >
                          {#if pos.stopLoss !== null}
                            {formatPaperPrice(pos.stopLoss, pos.symbol)}
                          {:else}
                            <span class="add-bracket-lbl">+ Add SL</span>
                          {/if}
                        </button>
                      </td>
                      <td class="num">
                        {lastParts.main}{#if lastParts.pipette}<sup>{lastParts.pipette}</sup>{/if}
                      </td>
                      <td
                        class="num bold"
                        class:pos={pm.unrealizedPnl > 0.004}
                        class:neg={pm.unrealizedPnl < -0.004}
                      >
                        {mask(formatUsd(pm.unrealizedPnl, true))} <small>USD</small>
                      </td>
                      <td
                        class="num"
                        class:pos={pm.unrealizedPnlPct > 0.004}
                        class:neg={pm.unrealizedPnlPct < -0.004}
                      >
                        {pm.unrealizedPnlPct >= 0 ? '+' : ''}{pm.unrealizedPnlPct.toFixed(2)}%
                      </td>
                      {#if showColLiveR}
                        <td
                          class="num bold"
                          class:pos={pm.liveR !== null && pm.liveR > 0}
                          class:neg={pm.liveR !== null && pm.liveR < 0}
                        >
                          {#if pm.liveR !== null}
                            {pm.liveR >= 0 ? '+' : ''}{pm.liveR.toFixed(2)}R
                          {:else}
                            <span class="muted">—</span>
                          {/if}
                        </td>
                      {/if}
                      {#if showColTradeValue}
                        <td class="num">
                          {mask(formatUsd(pm.tradeValue))} <small>USD</small>
                        </td>
                      {/if}
                      <td class="act-col">
                        <div class="row-acts">
                          <button
                            class="row-ic"
                            type="button"
                            title="Modify Take Profit / Stop Loss"
                            aria-label="Modify position"
                            onclick={() => onRequestModifyPosition(pos, null)}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M11.3 2.7a1.5 1.5 0 0 1 2.1 2.1L5.8 12.4 2.7 13.3l.9-3.1Z" />
                            </svg>
                          </button>
                          <button
                            class="row-ic close"
                            type="button"
                            title="Close position"
                            aria-label="Close position"
                            onclick={() => onRequestClosePosition(pos)}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="m4 4 8 8m0-8-8 8" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>

                    {#if expandedPosIds[pos.id] && pos.fills && pos.fills.length > 1}
                      {#each pos.fills as leg, idx (leg.id)}
                        <tr class="leg-subrow">
                          <td class="leg-indent">Order fill #{idx + 1} ({leg.orderType})</td>
                          <td>
                            <span class="side-txt" class:long={leg.side === 'buy'} class:short={leg.side === 'sell'}>
                              {leg.side === 'buy' ? 'Buy' : 'Sell'}
                            </span>
                          </td>
                          <td class="num">{formatQty(leg.quantity)}</td>
                          <td class="num">{formatPaperPrice(leg.fillPrice, pos.symbol)}</td>
                          <td colspan="8" class="muted">{formatTs(leg.filledAt)}</td>
                        </tr>
                      {/each}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {:else if activeTab === 'orders'}
          <!-- Orders Tab: Shows BOTH Pending Entry Orders AND Individual Active TP / SL Bracket Orders -->
          <div class="subfilter-bar">
            <div class="sf-chips">
              {#each [
                { id: 'all', label: `All (${unifiedOrders.length})` },
                { id: 'entry', label: `Pending entries (${account.orders.length})` },
                { id: 'brackets', label: `Active TP / SL (${unifiedOrders.length - account.orders.length})` }
              ] as opt (opt.id)}
                <button
                  class="sf-chip"
                  class:active={ordersFilter === opt.id}
                  type="button"
                  onclick={() => (ordersFilter = opt.id as typeof ordersFilter)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          {#if filteredUnifiedOrders.length === 0}
            <div class="empty-tab">
              No active working orders or TP/SL brackets. Place a Limit/Stop order or attach TP/SL to an open position.
            </div>
          {:else}
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Order Type</th>
                    <th class="num">Quantity</th>
                    <th class="num">Order price</th>
                    <th class="num">Last price</th>
                    <th class="num">Est. P&L / Exits</th>
                    <th>TIF</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th class="act-col"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each filteredUnifiedOrders as ord (ord.id)}
                    {@const q = quotes[normalizeSymbolKey(ord.symbol)]}
                    <tr>
                      <td>
                        <button
                          class="sym-cell"
                          type="button"
                          onclick={() => onSelectSymbol(ord.symbol, ord.shortName)}
                        >
                          <SymbolIcon symbol={ord.shortName} size={18} />
                          <span class="sym-chip">{ord.symbol}</span>
                        </button>
                      </td>
                      <td>
                        <span class="side-txt" class:long={ord.side === 'buy'} class:short={ord.side === 'sell'}>
                          {ord.side === 'buy' ? 'Buy' : 'Sell'}
                        </span>
                      </td>
                      <td>
                        <span
                          class="ord-kind-pill"
                          class:tp={ord.rowKind === 'tp'}
                          class:sl={ord.rowKind === 'sl'}
                        >
                          {ord.typeLabel}
                        </span>
                      </td>
                      <td class="num">{formatQty(ord.quantity)}</td>
                      <td class="num bold">{formatPaperPrice(ord.orderPrice, ord.symbol)}</td>
                      <td class="num">{q ? formatPaperPrice(q.last, ord.symbol) : '—'}</td>
                      <td class="num">
                        {#if ord.estPnl !== null}
                          <span class:pos={ord.estPnl > 0} class:neg={ord.estPnl < 0} class="bold">
                            {mask(formatUsd(ord.estPnl, true))} <small>USD</small>
                          </span>
                        {:else if ord.takeProfit !== null || ord.stopLoss !== null}
                          <span class="muted">
                            {ord.takeProfit !== null ? `TP ${formatPaperPrice(ord.takeProfit, ord.symbol)}` : ''}
                            {ord.takeProfit !== null && ord.stopLoss !== null ? ' · ' : ''}
                            {ord.stopLoss !== null ? `SL ${formatPaperPrice(ord.stopLoss, ord.symbol)}` : ''}
                          </span>
                        {:else}
                          <span class="muted">—</span>
                        {/if}
                      </td>
                      <td>{ord.tif}</td>
                      <td><span class="st-pill working">Working</span></td>
                      <td class="muted">{formatTs(ord.placedAt)}</td>
                      <td class="act-col">
                        <div class="row-acts">
                          {#if ord.parentPosition && (ord.rowKind === 'tp' || ord.rowKind === 'sl')}
                            <button
                              class="row-ic"
                              type="button"
                              title="Modify {ord.rowKind.toUpperCase()} price"
                              aria-label="Modify bracket order"
                              onclick={() =>
                                ord.parentPosition &&
                                onRequestModifyPosition(
                                  ord.parentPosition,
                                  ord.rowKind === 'tp' ? 'tp' : 'sl'
                                )}
                            >
                              <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M11.3 2.7a1.5 1.5 0 0 1 2.1 2.1L5.8 12.4 2.7 13.3l.9-3.1Z" />
                              </svg>
                            </button>
                            <button
                              class="row-ic close"
                              type="button"
                              title="Cancel {ord.rowKind.toUpperCase()} order"
                              aria-label="Cancel bracket order"
                              onclick={() =>
                                ord.parentPosition &&
                                removePositionBracket(
                                  ord.parentPosition.id,
                                  ord.rowKind === 'tp' ? 'tp' : 'sl'
                                )}
                            >
                              <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="m4 4 8 8m0-8-8 8" />
                              </svg>
                            </button>
                          {:else}
                            <button
                              class="row-ic close"
                              type="button"
                              title="Cancel working order"
                              aria-label="Cancel order"
                              onclick={() => cancelWorkingOrder(ord.id)}
                            >
                              <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="m4 4 8 8m0-8-8 8" />
                              </svg>
                            </button>
                          {/if}
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {:else if activeTab === 'order_history'}
          <div class="subfilter-bar">
            <div class="sf-chips">
              {#each [
                { id: 'all', label: `All (${account.orderHistory.length})` },
                { id: 'filled', label: 'Filled' },
                { id: 'cancelled', label: 'Cancelled' },
                { id: 'expired', label: 'Expired' },
                { id: 'rejected', label: 'Rejected' }
              ] as opt (opt.id)}
                <button
                  class="sf-chip"
                  class:active={orderHistFilter === opt.id}
                  type="button"
                  onclick={() => (orderHistFilter = opt.id as typeof orderHistFilter)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          {#if filteredOrderHistory.length === 0}
            <div class="empty-tab">No orders match this filter yet.</div>
          {:else}
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th class="num">Qty</th>
                    <th class="num">Order price</th>
                    <th class="num">Fill price</th>
                    <th>Status</th>
                    <th>Details</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {#each filteredOrderHistory as ord (ord.id)}
                    <tr>
                      <td class="muted mono">{ord.id.slice(-7)}</td>
                      <td>
                        <span class="sym-plain">
                          <SymbolIcon symbol={ord.shortName} size={16} />
                          {ord.symbol}
                        </span>
                      </td>
                      <td>
                        <span class="side-txt" class:long={ord.side === 'buy'} class:short={ord.side === 'sell'}>
                          {ord.side === 'buy' ? 'Buy' : 'Sell'}
                        </span>
                      </td>
                      <td class="cap">{ord.type}</td>
                      <td class="num">{formatQty(ord.quantity)}</td>
                      <td class="num">{ord.orderPrice !== null ? formatPaperPrice(ord.orderPrice, ord.symbol) : 'MKT'}</td>
                      <td class="num bold">{ord.fillPrice !== null ? formatPaperPrice(ord.fillPrice, ord.symbol) : '—'}</td>
                      <td>
                        <span class="st-pill {ord.status}">{ord.status}</span>
                      </td>
                      <td class="muted">{ord.rejectReason || ord.note || '—'}</td>
                      <td class="muted">{formatTs(ord.filledAt || ord.updatedAt)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {:else if activeTab === 'balance_history'}
          <div class="subfilter-bar stats-row">
            <span>Starting: <strong>{mask(formatUsd(account.settings.startingBalance))} USD</strong></span>
            <span>·</span>
            <span>
              Net Realized:
              <strong class:pos={account.realizedPnl > 0} class:neg={account.realizedPnl < 0}>
                {mask(formatUsd(account.realizedPnl, true))} USD
              </strong>
            </span>
            <span>·</span>
            <span>Commissions: <strong>{mask(formatUsd(totalCommissions))} USD</strong></span>
            <span>·</span>
            <span>Current Balance: <strong>{mask(formatUsd(account.balance))} USD</strong></span>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Symbol</th>
                  <th class="num">Change</th>
                  <th class="num">Balance after</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {#each account.balanceHistory as row (row.id)}
                  <tr>
                    <td class="muted">{formatTs(row.ts)}</td>
                    <td><span class="cat-chip">{row.kind.replace('_', ' ')}</span></td>
                    <td>{row.symbol || '—'}</td>
                    <td class="num bold" class:pos={row.delta > 0.004} class:neg={row.delta < -0.004}>
                      {mask(formatUsd(row.delta, true))} <small>USD</small>
                    </td>
                    <td class="num">{mask(formatUsd(row.balanceAfter))} <small>USD</small></td>
                    <td class="muted">{row.description}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if activeTab === 'activity_log'}
          <div class="subfilter-bar">
            <div class="sf-chips">
              {#each [
                { id: 'all', label: `All (${account.activityLog.length})` },
                { id: 'fill', label: 'Fills' },
                { id: 'order', label: 'Orders' },
                { id: 'bracket', label: 'TP / SL' },
                { id: 'offline', label: 'Offline' },
                { id: 'account', label: 'Account' }
              ] as opt (opt.id)}
                <button
                  class="sf-chip"
                  class:active={activityFilter === opt.id}
                  type="button"
                  onclick={() => (activityFilter = opt.id as typeof activityFilter)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Category</th>
                  <th>Symbol</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {#each filteredActivity as item (item.id)}
                  <tr>
                    <td class="muted">{formatTs(item.ts)}</td>
                    <td><span class="cat-chip {item.category}">{item.category}</span></td>
                    <td>{item.symbol || '—'}</td>
                    <td>{item.message}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if activeTab === 'trade_history'}
          {#if account.tradeHistory.length === 0}
            <div class="empty-tab">No closed trades yet. Close a position (or hit TP/SL) to log a completed trade.</div>
          {:else}
            {#if analytics}
              <div class="subfilter-bar stats-row">
                <span>Closed: <strong>{analytics.totalTrades}</strong></span>
                <span>·</span>
                <span>W/L: <strong>{analytics.wins}W / {analytics.losses}L</strong></span>
                <span>·</span>
                <span>
                  Net P&L:
                  <strong class:pos={analytics.netRealizedPnl > 0} class:neg={analytics.netRealizedPnl < 0}>
                    {mask(formatUsd(analytics.netRealizedPnl, true))} USD
                  </strong>
                </span>
                {#if analytics.totalR !== null}
                  <span>·</span>
                  <span>
                    Total R:
                    <strong class:pos={analytics.totalR > 0} class:neg={analytics.totalR < 0}>
                      {analytics.totalR >= 0 ? '+' : ''}{analytics.totalR.toFixed(2)}R
                    </strong>
                  </span>
                {/if}
                <span>·</span>
                <span>Avg Hold: <strong>{formatAvgMinutes(analytics.avgHoldMinutes)}</strong></span>
              </div>
            {/if}

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Qty</th>
                    <th class="num">Entry</th>
                    <th class="num">Exit</th>
                    <th class="num">Duration</th>
                    <th class="num">Realized PnL</th>
                    <th class="num">PnL %</th>
                    <th class="num">Realized R</th>
                    <th>Exit</th>
                    <th>Closed</th>
                    <th class="act-col">Playbook</th>
                  </tr>
                </thead>
                <tbody>
                  {#each account.tradeHistory as tr (tr.id)}
                    <tr>
                      <td>
                        <button
                          class="sym-cell"
                          type="button"
                          onclick={() => onSelectSymbol(tr.symbol, tr.shortName)}
                        >
                          <SymbolIcon symbol={tr.shortName} size={18} />
                          <span class="sym-chip">{tr.symbol}</span>
                        </button>
                      </td>
                      <td>
                        <span class="side-txt" class:long={tr.side === 'long'} class:short={tr.side === 'short'}>
                          {tr.side === 'long' ? 'Long' : 'Short'}
                        </span>
                      </td>
                      <td class="num">{formatQty(tr.quantity)}</td>
                      <td class="num">{formatPaperPrice(tr.entryPrice, tr.symbol)}</td>
                      <td class="num">{formatPaperPrice(tr.exitPrice, tr.symbol)}</td>
                      <td class="num muted">{formatHoldDuration(tr.openedAt, tr.closedAt)}</td>
                      <td class="num bold" class:pos={tr.realizedPnl > 0.004} class:neg={tr.realizedPnl < -0.004}>
                        {mask(formatUsd(tr.realizedPnl, true))} <small>USD</small>
                      </td>
                      <td class="num" class:pos={tr.realizedPnlPct > 0.004} class:neg={tr.realizedPnlPct < -0.004}>
                        {tr.realizedPnlPct >= 0 ? '+' : ''}{tr.realizedPnlPct.toFixed(2)}%
                      </td>
                      <td
                        class="num bold"
                        class:pos={tr.realizedR !== null && tr.realizedR > 0}
                        class:neg={tr.realizedR !== null && tr.realizedR < 0}
                      >
                        {#if tr.realizedR !== null}
                          {tr.realizedR >= 0 ? '+' : ''}{tr.realizedR.toFixed(2)}R
                        {:else}
                          <span class="muted">—</span>
                        {/if}
                      </td>
                      <td><span class="reason-chip">{tr.closeReason.replace('_', ' ')}</span></td>
                      <td class="muted">{formatTs(tr.closedAt)}</td>
                      <td class="act-col">
                        <button
                          class="pb-send-btn"
                          class:sent={Boolean(tr.sentToPlaybook)}
                          type="button"
                          disabled={Boolean(tr.sentToPlaybook)}
                          onclick={() => void handleSendTradeToPlaybook(tr)}
                        >
                          {tr.sentToPlaybook ? 'Saved (SIM)' : '+ Playbook'}
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {:else if activeTab === 'analytics' && analytics}
          <div class="analytics-body">
            <!-- 6 KPI Summary Cards -->
            <div class="kpi-grid">
              <div class="kpi-card">
                <div class="kk-row">
                  <span class="kk">Net Realized Profit</span>
                  <span class="sim-mini">SIM</span>
                </div>
                <span
                  class="kv"
                  class:pos={analytics.netRealizedPnl > 0.004}
                  class:neg={analytics.netRealizedPnl < -0.004}
                >
                  {mask(formatUsd(analytics.netRealizedPnl, true))} <small>USD</small>
                </span>
                <span class="ks">
                  Return {analytics.returnPct >= 0 ? '+' : ''}{analytics.returnPct.toFixed(2)}% · {analytics.totalTrades} trades
                </span>
              </div>

              <div class="kpi-card">
                <span class="kk">Win Rate</span>
                <span class="kv">
                  {analytics.winRatePct !== null ? `${analytics.winRatePct.toFixed(1)}%` : '—'}
                </span>
                {#if analytics.totalTrades > 0}
                  <div class="wl-bar" aria-hidden="true">
                    <span class="wl-w" style:width="{(analytics.wins / analytics.totalTrades) * 100}%"></span>
                    <span class="wl-b" style:width="{(analytics.breakevens / analytics.totalTrades) * 100}%"></span>
                    <span class="wl-l" style:width="{(analytics.losses / analytics.totalTrades) * 100}%"></span>
                  </div>
                {/if}
                <span class="ks">{analytics.wins}W · {analytics.losses}L · {analytics.breakevens}BE</span>
              </div>

              <div class="kpi-card">
                <span class="kk">Profit Factor</span>
                <span class="kv">
                  {#if analytics.profitFactor === null}
                    —
                  {:else if !Number.isFinite(analytics.profitFactor)}
                    ∞
                  {:else}
                    {analytics.profitFactor.toFixed(2)}
                  {/if}
                </span>
                <span class="ks">
                  Gross +{mask(formatUsd(analytics.grossProfit))} / −{mask(formatUsd(analytics.grossLoss))}
                </span>
              </div>

              <div class="kpi-card">
                <span class="kk">Expectancy & R</span>
                <span
                  class="kv"
                  class:pos={(analytics.expectancyUsd ?? 0) > 0}
                  class:neg={(analytics.expectancyUsd ?? 0) < 0}
                >
                  {analytics.expectancyUsd !== null ? mask(formatUsd(analytics.expectancyUsd, true)) : '—'}
                  {#if analytics.expectancyR !== null}
                    <small>({analytics.expectancyR >= 0 ? '+' : ''}{analytics.expectancyR.toFixed(2)}R)</small>
                  {/if}
                </span>
                <span class="ks">
                  Total R: {analytics.totalR !== null ? `${analytics.totalR >= 0 ? '+' : ''}${analytics.totalR.toFixed(2)}R` : '—'} · Hold {formatAvgMinutes(analytics.avgHoldMinutes)}
                </span>
              </div>

              <div class="kpi-card">
                <span class="kk">Avg Win / Avg Loss</span>
                <span class="kv">
                  {analytics.payoffRatio !== null ? `${analytics.payoffRatio.toFixed(2)}x` : '—'}
                </span>
                <span class="ks">
                  W {analytics.avgWin !== null ? mask(formatUsd(analytics.avgWin, true)) : '—'} · L {analytics.avgLoss !== null ? mask(formatUsd(analytics.avgLoss, true)) : '—'}
                </span>
              </div>

              <div class="kpi-card">
                <span class="kk">Max Drawdown</span>
                <span class="kv neg">
                  {analytics.maxDrawdownPct > 0 ? `-${analytics.maxDrawdownPct.toFixed(2)}%` : '0.00%'}
                </span>
                <span class="ks">
                  {analytics.maxDrawdownUsd > 0 ? `-${mask(formatUsd(analytics.maxDrawdownUsd))} USD` : 'Peak equity'} · Streaks {analytics.longestWinStreak}W/{analytics.longestLossStreak}L
                </span>
              </div>
            </div>

            {#if analytics.totalTrades === 0}
              <div class="empty-analytics">
                Close your first simulated trade (or hit TP/SL) to unlock your equity curve, drawdown profile, per-trade P&L histogram, and symbol/direction breakdowns.
              </div>
            {:else}
              <div class="analytics-grid">
                <!-- Left: Equity Curve & Drawdown -->
                {#if eqGeometry}
                  <div class="charts-card">
                    <div class="cc-head">
                      <span class="cc-title">Equity Curve & Underwater Drawdown</span>
                      {#if hoveredCoord}
                        <span class="cc-hover">
                          {hoveredCoord.point.label} · Equity <strong>{mask(formatUsd(hoveredCoord.point.equity))} USD</strong>
                          {#if hoveredCoord.point.tradePnl !== undefined}
                            · <strong class:pos={hoveredCoord.point.tradePnl > 0} class:neg={hoveredCoord.point.tradePnl < 0}>
                              {mask(formatUsd(hoveredCoord.point.tradePnl, true))}
                            </strong>
                          {/if}
                          {#if hoveredCoord.point.drawdownPct > 0}
                            · DD <strong class="neg">-{hoveredCoord.point.drawdownPct.toFixed(2)}%</strong>
                          {/if}
                        </span>
                      {:else}
                        <span class="cc-hover muted">Hover points to inspect trade-by-trade equity</span>
                      {/if}
                    </div>

                    <svg
                      class="eq-svg"
                      viewBox="0 0 {EQ_W} {EQ_H}"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label="Simulated equity curve"
                      onmouseleave={() => (hoverIdx = null)}
                    >
                      <line
                        x1={PAD_L}
                        x2={EQ_W - PAD_R}
                        y1={eqGeometry.baselineY}
                        y2={eqGeometry.baselineY}
                        class="base-line"
                      />
                      <text x={PAD_L - 6} y={PAD_T + 8} class="ax-txt" text-anchor="end">
                        {privacy ? '•••' : formatUsd(eqGeometry.maxE)}
                      </text>
                      <text x={PAD_L - 6} y={EQ_H - PAD_B} class="ax-txt" text-anchor="end">
                        {privacy ? '•••' : formatUsd(eqGeometry.minE)}
                      </text>
                      <path
                        d={eqGeometry.areaPath}
                        class="eq-area"
                        class:up={eqGeometry.isUp}
                        class:down={!eqGeometry.isUp}
                      />
                      <path
                        d={eqGeometry.linePath}
                        class="eq-line"
                        class:up={eqGeometry.isUp}
                        class:down={!eqGeometry.isUp}
                      />
                      {#each eqGeometry.coords as c, i (i)}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <circle
                          cx={c.x}
                          cy={c.y}
                          r={hoverIdx === i ? 4.5 : eqGeometry.coords.length <= 28 ? 3 : 0.1}
                          class="eq-dot"
                          class:up={eqGeometry.isUp}
                          class:down={!eqGeometry.isUp}
                          onmouseenter={() => (hoverIdx = i)}
                        />
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <rect
                          x={c.x - 14}
                          y={0}
                          width={28}
                          height={EQ_H}
                          fill="transparent"
                          onmouseenter={() => (hoverIdx = i)}
                        />
                      {/each}
                    </svg>

                    <svg
                      class="dd-svg"
                      viewBox="0 0 {EQ_W} {DD_H}"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label="Underwater drawdown chart"
                      onmouseleave={() => (hoverIdx = null)}
                    >
                      <line x1={PAD_L} x2={EQ_W - PAD_R} y1="6" y2="6" class="base-line" />
                      <text x={PAD_L - 6} y="10" class="ax-txt" text-anchor="end">0%</text>
                      <text x={PAD_L - 6} y={DD_H - 10} class="ax-txt" text-anchor="end">
                        -{eqGeometry.maxDd.toFixed(1)}%
                      </text>
                      <path d={eqGeometry.ddArea} class="dd-area" />
                      <path d={eqGeometry.ddLine} class="dd-line" />
                    </svg>
                  </div>
                {/if}

                <!-- Right: Per-Trade P&L Bars -->
                {#if tradeBars}
                  <div class="charts-card">
                    <div class="cc-head">
                      <span class="cc-title">Per-Trade P&L Distribution</span>
                      {#if hoveredBar}
                        <span class="cc-hover">
                          {hoveredBar.point.label}:
                          <strong class:pos={hoveredBar.val > 0} class:neg={hoveredBar.val < 0}>
                            {mask(formatUsd(hoveredBar.val, true))} USD
                          </strong>
                        </span>
                      {:else}
                        <span class="cc-hover muted">
                          Best {analytics.bestTradeUsd !== null ? mask(formatUsd(analytics.bestTradeUsd, true)) : '—'} · Worst {analytics.worstTradeUsd !== null ? mask(formatUsd(analytics.worstTradeUsd, true)) : '—'}
                        </span>
                      {/if}
                    </div>

                    <svg
                      class="bars-svg"
                      viewBox="0 0 {tradeBars.W} {tradeBars.H}"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label="Per-trade PnL bars"
                      onmouseleave={() => (hoverBarIdx = null)}
                    >
                      <line x1="0" x2={tradeBars.W} y1={tradeBars.midY} y2={tradeBars.midY} class="base-line" />
                      {#each tradeBars.bars as b, i (i)}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <rect
                          x={b.x}
                          y={b.y}
                          width={b.w}
                          height={b.h}
                          rx="2"
                          class="pnl-bar"
                          class:win={b.val >= 0}
                          class:loss={b.val < 0}
                          class:hovered={hoverBarIdx === i}
                          onmouseenter={() => (hoverBarIdx = i)}
                        />
                      {/each}
                    </svg>

                    <!-- Long vs Short + Exit Reasons Compact Row -->
                    <div class="split-mini-grid">
                      <div class="mini-panel">
                        <div class="mp-title">Long vs Short</div>
                        {#each analytics.bySide as s (s.side)}
                          <div class="mp-row">
                            <span class="side-txt" class:long={s.side === 'long'} class:short={s.side === 'short'}>
                              {s.side === 'long' ? 'Long' : 'Short'} ({s.trades})
                            </span>
                            <span class="muted">{s.winRatePct !== null ? `${s.winRatePct}%` : '—'}</span>
                            <span class="bold" class:pos={s.netPnl > 0} class:neg={s.netPnl < 0}>
                              {mask(formatUsd(s.netPnl, true))}
                            </span>
                          </div>
                        {/each}
                      </div>

                      <div class="mini-panel">
                        <div class="mp-title">Exit Breakdown</div>
                        {#each analytics.byCloseReason as r (r.reason)}
                          <div class="mp-row">
                            <span>{r.reason}</span>
                            <span class="muted">{r.count}×</span>
                            <span class="bold" class:pos={r.netPnl > 0} class:neg={r.netPnl < 0}>
                              {mask(formatUsd(r.netPnl, true))}
                            </span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  </div>
                {/if}
              </div>

              <!-- Performance by Symbol Table -->
              {#if analytics.bySymbol.length > 0}
                <div class="charts-card">
                  <div class="cc-head">
                    <span class="cc-title">Performance by Symbol</span>
                  </div>
                  <div class="sym-breakdown-wrap">
                    <table class="mini-table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th class="num">Trades</th>
                          <th class="num">W / L</th>
                          <th class="num">Win Rate</th>
                          <th class="num">Total R</th>
                          <th class="num">Net P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each analytics.bySymbol as row (row.symbol)}
                          <tr>
                            <td>
                              <span class="sym-plain">
                                <SymbolIcon symbol={row.shortName} size={15} />
                                {row.symbol}
                              </span>
                            </td>
                            <td class="num">{row.trades}</td>
                            <td class="num muted">{row.wins}W / {row.losses}L</td>
                            <td class="num">{row.winRatePct !== null ? `${row.winRatePct}%` : '—'}</td>
                            <td
                              class="num bold"
                              class:pos={row.totalR !== null && row.totalR > 0}
                              class:neg={row.totalR !== null && row.totalR < 0}
                            >
                              {row.totalR !== null ? `${row.totalR >= 0 ? '+' : ''}${row.totalR.toFixed(2)}R` : '—'}
                            </td>
                            <td class="num bold" class:pos={row.netPnl > 0} class:neg={row.netPnl < 0}>
                              {mask(formatUsd(row.netPnl, true))} <small>USD</small>
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .paper-bottom {
    position: relative;
    width: 100%;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
    border-top: 1px solid var(--dark-border);
    z-index: 12;
    user-select: none;
  }

  .paper-bottom.light {
    background: #ffffff;
    color: #131722;
    border-top-color: #e0e3eb;
  }

  .paper-bottom.collapsed {
    height: 36px;
  }

  .paper-bottom.fullscreen {
    position: absolute;
    inset: 0;
    height: 100%;
    z-index: 40;
    border-top: 0;
  }

  .top-resize-handle {
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: ns-resize;
    z-index: 5;
  }

  .top-resize-handle:hover,
  .paper-bottom.dragging .top-resize-handle {
    background: rgba(255, 255, 255, 0.14);
  }

  .paper-bottom.light .top-resize-handle:hover {
    background: rgba(19, 23, 34, 0.12);
  }

  .pb-bar {
    height: 36px;
    flex: 0 0 36px;
    padding: 0 10px 0 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .bar-left,
  .bar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .broker-anchor,
  .acct-menu-anchor,
  .cols-anchor {
    position: relative;
  }

  .broker-trigger {
    height: 28px;
    padding: 0 8px 0 6px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
  }

  .broker-trigger:hover {
    background: var(--dark-hover-strong);
  }

  .paper-bottom.light .broker-trigger:hover {
    background: #f0f2f6;
  }

  .pl-ico {
    position: relative;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    background: #ebebeb;
    color: #0d0d0d;
    display: grid;
    place-items: center;
  }

  .paper-bottom.light .pl-ico {
    background: #131722;
    color: #ffffff;
  }

  .pl-txt {
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: -0.04em;
  }

  .pl-dot {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #089981;
    border: 1.5px solid var(--dark-bg-base);
  }

  .paper-bottom.light .pl-dot {
    border-color: #ffffff;
  }

  .chev {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.68;
  }

  .collapsed-summary {
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }

  .collapsed-summary:hover {
    background: var(--dark-hover);
  }

  .paper-bottom.light .collapsed-summary:hover {
    background: #f5f6f9;
  }

  .cs-k {
    color: var(--dark-text-secondary);
    margin-right: 4px;
  }

  .paper-bottom.light .cs-k {
    color: #6a7282;
  }

  .cs-v {
    font-weight: 600;
  }

  .cs-sep {
    opacity: 0.4;
  }

  .cs-badge {
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-soft);
  }

  .paper-bottom.light .cs-badge {
    background: #eef0f5;
    color: #4a5160;
  }

  .bar-icon {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .bar-icon:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .paper-bottom.light .bar-icon {
    color: #5d6473;
  }

  .paper-bottom.light .bar-icon:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .bar-icon svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .drop-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 210px;
    padding: 5px;
    border-radius: 10px;
    background: var(--dark-bg-glass-strong);
    border: 1px solid var(--dark-border-glass);
    box-shadow: var(--dark-shadow-popover);
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .drop-menu.up {
    top: auto;
    bottom: calc(100% + 4px);
  }

  .drop-menu.right {
    left: auto;
    right: 0;
    min-width: 150px;
  }

  .paper-bottom.light .drop-menu {
    background: #ffffff;
    border-color: #e0e3eb;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
  }

  .dm-item {
    width: 100%;
    min-height: 30px;
    padding: 5px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    text-align: left;
    cursor: pointer;
  }

  .dm-item:hover {
    background: var(--dark-hover-strong);
  }

  .dm-item.active {
    background: var(--dark-bg-active);
    font-weight: 600;
  }

  .paper-bottom.light .dm-item:hover {
    background: #f2f4f8;
  }

  .paper-bottom.light .dm-item.active {
    background: #e9ecf3;
  }

  .dm-item.danger {
    color: #f23645;
  }

  .dm-sub {
    font-size: 11px;
    opacity: 0.72;
    font-variant-numeric: tabular-nums;
  }

  .dm-div {
    height: 1px;
    margin: 3px 6px;
    background: var(--dark-border-subtle);
  }

  /* ── Account Summary Strip ─────────────────────────────────────────────── */
  .summary-strip-wrap {
    padding: 4px 12px 6px;
    flex: 0 0 auto;
  }

  .summary-strip {
    min-height: 42px;
    padding: 4px 10px 4px 5px;
    border-radius: 999px;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border-subtle);
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .paper-bottom.light .summary-strip {
    background: #f5f6f9;
    border-color: #eceff4;
  }

  .acct-pill-btn {
    height: 32px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid var(--dark-border);
    background: var(--dark-bg-elevated);
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    white-space: nowrap;
  }

  .paper-bottom.light .acct-pill-btn {
    background: #ffffff;
    border-color: #e0e3eb;
  }

  .ap-name {
    font-weight: 600;
  }

  .ap-bal {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .ap-bal small {
    font-size: 10px;
    font-weight: 500;
    opacity: 0.72;
  }

  .metrics-scroll {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 18px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .metrics-scroll::-webkit-scrollbar {
    display: none;
  }

  .m-item {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
  }

  .m-k {
    font-size: 12px;
    color: var(--dark-text-secondary);
  }

  .paper-bottom.light .m-k {
    color: #5d6473;
  }

  .m-k.dashed {
    text-decoration: underline dashed;
    text-underline-offset: 3px;
    text-decoration-color: var(--dark-border-strong);
  }

  .m-v {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .eye-btn {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: 0 0 28px;
  }

  .eye-btn:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .eye-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ── Sub-Tab Pills Row ─────────────────────────────────────────────────── */
  .tabs-bar {
    padding: 4px 12px 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex: 0 0 auto;
  }

  .pill-tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .pill-tabs::-webkit-scrollbar {
    display: none;
  }

  .ptab {
    height: 30px;
    padding: 0 12px;
    border: 0;
    border-radius: 999px;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-soft);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .ptab:hover {
    background: var(--dark-bg-elevated);
    color: var(--dark-text-strong);
  }

  .ptab.active {
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    font-weight: 600;
  }

  .paper-bottom.light .ptab {
    background: #f0f2f6;
    color: #4a5160;
  }

  .paper-bottom.light .ptab:hover {
    background: #e5e8f0;
    color: #131722;
  }

  .paper-bottom.light .ptab.active {
    background: #131722;
    color: #ffffff;
  }

  .ptab-cnt {
    font-size: 11px;
    opacity: 0.78;
    font-variant-numeric: tabular-nums;
  }

  .export-btn {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid var(--dark-border);
    background: transparent;
    color: var(--dark-text-soft);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: 0 0 30px;
  }

  .export-btn:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .paper-bottom.light .export-btn {
    border-color: #e0e3eb;
    color: #4a5160;
  }

  .export-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ── Sub-filter & Summary Bars ─────────────────────────────────────────── */
  .subfilter-bar {
    padding: 0 12px 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    font-size: 11.5px;
  }

  .subfilter-bar.stats-row {
    color: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
    flex-wrap: wrap;
  }

  .subfilter-bar.stats-row strong {
    color: var(--dark-text-strong);
  }

  .paper-bottom.light .subfilter-bar.stats-row strong {
    color: #131722;
  }

  .sf-chips {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }

  .sf-chip {
    height: 23px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-subtle);
    background: transparent;
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }

  .sf-chip.active {
    background: var(--dark-bg-elevated);
    border-color: var(--dark-border-strong);
    color: var(--dark-text-strong);
    font-weight: 600;
  }

  .paper-bottom.light .sf-chip {
    border-color: #e6e9ef;
    color: #5d6473;
  }

  .paper-bottom.light .sf-chip.active {
    background: #eef0f5;
    border-color: #cfd4de;
    color: #131722;
  }

  /* ── Tables ────────────────────────────────────────────────────────────── */
  .tab-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .empty-tab,
  .empty-analytics {
    padding: 26px 18px;
    text-align: center;
    font-size: 12.5px;
    color: var(--dark-text-secondary);
    border-radius: 10px;
    background: var(--dark-bg-surface);
    border: 1px dashed var(--dark-border);
    margin: 4px 12px;
  }

  .paper-bottom.light .empty-tab,
  .paper-bottom.light .empty-analytics {
    background: #f8f9fc;
    border-color: #dce0e8;
    color: #5d6473;
  }

  .table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 12px 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    height: 30px;
    padding: 0 8px;
    text-align: left;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--dark-text-secondary);
    background: var(--dark-bg-base);
    border-bottom: 1px solid var(--dark-border-subtle);
    white-space: nowrap;
  }

  .paper-bottom.light thead th {
    background: #ffffff;
    color: #6a7282;
    border-bottom-color: #eceff4;
  }

  tbody tr {
    height: 38px;
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  tbody tr:hover {
    background: var(--dark-hover);
  }

  .paper-bottom.light tbody tr {
    border-bottom-color: #f0f2f6;
  }

  .paper-bottom.light tbody tr:hover {
    background: #f8f9fc;
  }

  tr.leg-subrow {
    height: 30px;
    font-size: 11.5px;
    background: var(--dark-bg-subtle);
  }

  .paper-bottom.light tr.leg-subrow {
    background: #fafbfc;
  }

  .leg-indent {
    padding-left: 34px;
    color: var(--dark-text-secondary);
  }

  td {
    padding: 0 8px;
    white-space: nowrap;
  }

  th.num,
  td.num {
    text-align: right;
  }

  td.bold,
  .bold {
    font-weight: 600;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  }

  td small {
    font-size: 10px;
    opacity: 0.72;
  }

  td sup {
    font-size: 9px;
    margin-left: 0.5px;
  }

  .cap {
    text-transform: capitalize;
  }

  .muted {
    color: var(--dark-text-secondary);
  }

  .paper-bottom.light .muted {
    color: #6a7282;
  }

  .pos {
    color: #089981;
  }

  .neg {
    color: #f23645;
  }

  .sym-wrap {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .sym-cell {
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .legs-btn {
    height: 20px;
    padding: 0 6px;
    border-radius: 5px;
    border: 1px solid var(--dark-border);
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .paper-bottom.light .legs-btn {
    background: #f0f2f6;
    border-color: #dce0e8;
    color: #5d6473;
  }

  .sym-plain {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
  }

  .sym-chip {
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-strong);
  }

  .sym-chip.active {
    background: #2962ff;
    color: #ffffff;
  }

  .paper-bottom.light .sym-chip {
    background: #f0f2f6;
    color: #131722;
  }

  .paper-bottom.light .sym-chip.active {
    background: #2962ff;
    color: #ffffff;
  }

  .side-txt {
    font-weight: 600;
  }

  .side-txt.long {
    color: #2962ff;
  }

  .side-txt.short {
    color: #f23645;
  }

  .bracket-cell-btn {
    border: 0;
    padding: 3px 6px;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .bracket-cell-btn:hover {
    background: var(--dark-hover-strong);
  }

  .paper-bottom.light .bracket-cell-btn:hover {
    background: #eef0f5;
  }

  .bracket-cell-btn.set-tp {
    color: #089981;
    font-weight: 600;
  }

  .bracket-cell-btn.set-sl {
    color: #f59e0b;
    font-weight: 600;
  }

  .add-bracket-lbl {
    font-size: 11px;
    font-weight: 600;
    color: var(--dark-text-secondary);
    opacity: 0.78;
  }

  .bracket-cell-btn:hover .add-bracket-lbl {
    color: var(--dark-text-strong);
    opacity: 1;
  }

  .paper-bottom.light .bracket-cell-btn:hover .add-bracket-lbl {
    color: #131722;
  }

  .ord-kind-pill {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-primary);
  }

  .ord-kind-pill.tp {
    background: rgba(8, 153, 129, 0.16);
    color: #089981;
  }

  .ord-kind-pill.sl {
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
  }

  .paper-bottom.light .ord-kind-pill {
    background: #f0f2f6;
    color: #131722;
  }

  .paper-bottom.light .ord-kind-pill.tp {
    background: rgba(8, 153, 129, 0.13);
    color: #067a67;
  }

  .paper-bottom.light .ord-kind-pill.sl {
    background: rgba(245, 158, 11, 0.15);
    color: #b45309;
  }

  .act-col {
    text-align: right;
    width: 86px;
  }

  .cols-btn {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }

  .cols-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }

  .col-chk {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    font-size: 12px;
    cursor: pointer;
  }

  .row-acts {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }

  .row-ic {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .row-ic:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .row-ic.close:hover {
    background: rgba(242, 54, 69, 0.16);
    color: #f23645;
  }

  .row-ic svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .st-pill,
  .cat-chip,
  .reason-chip {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    text-transform: capitalize;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-soft);
  }

  .paper-bottom.light .st-pill,
  .paper-bottom.light .cat-chip,
  .paper-bottom.light .reason-chip {
    background: #f0f2f6;
    color: #4a5160;
  }

  .st-pill.working {
    background: rgba(41, 98, 255, 0.16);
    color: #6b96ff;
  }

  .paper-bottom.light .st-pill.working {
    color: #2962ff;
  }

  .st-pill.filled {
    background: rgba(8, 153, 129, 0.16);
    color: #089981;
  }

  .st-pill.rejected {
    background: rgba(242, 54, 69, 0.16);
    color: #f23645;
  }

  .pb-send-btn {
    height: 24px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: var(--dark-text-primary);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .pb-send-btn:hover:not(:disabled) {
    background: var(--dark-hover-strong);
  }

  .pb-send-btn.sent {
    border-color: rgba(8, 153, 129, 0.4);
    color: #089981;
    cursor: default;
  }

  .paper-bottom.light .pb-send-btn {
    border-color: #d6dae1;
    color: #131722;
  }

  /* ── Analytics Dashboard ───────────────────────────────────────────────── */
  .analytics-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }

  .kpi-card {
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border-subtle);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .paper-bottom.light .kpi-card {
    background: #f5f6f9;
    border-color: #eceff4;
  }

  .kk-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sim-mini {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-secondary);
  }

  .kk {
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .kv {
    font-size: 15.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .kv small {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.78;
  }

  .ks {
    font-size: 11px;
    color: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .wl-bar {
    height: 4px;
    border-radius: 99px;
    overflow: hidden;
    display: flex;
    background: var(--dark-border);
  }

  .wl-w {
    background: #089981;
  }

  .wl-b {
    background: #8c8c8c;
  }

  .wl-l {
    background: #f23645;
  }

  .analytics-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
    gap: 10px;
  }

  @media (max-width: 980px) {
    .analytics-grid {
      grid-template-columns: 1fr;
    }
  }

  .charts-card {
    padding: 11px 12px;
    border-radius: 10px;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border-subtle);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .paper-bottom.light .charts-card {
    background: #f8f9fc;
    border-color: #e6e9ef;
  }

  .cc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }

  .cc-title {
    font-size: 12px;
    font-weight: 600;
  }

  .cc-hover {
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .eq-svg {
    width: 100%;
    height: 140px;
    display: block;
  }

  .dd-svg {
    width: 100%;
    height: 66px;
    display: block;
  }

  .bars-svg {
    width: 100%;
    height: 112px;
    display: block;
  }

  .base-line {
    stroke: var(--dark-border-strong);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  .paper-bottom.light .base-line {
    stroke: #d6dae1;
  }

  .ax-txt {
    font-size: 9.5px;
    fill: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .eq-line {
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .eq-line.up {
    stroke: #089981;
  }

  .eq-line.down {
    stroke: #f23645;
  }

  .eq-area.up {
    fill: rgba(8, 153, 129, 0.16);
  }

  .eq-area.down {
    fill: rgba(242, 54, 69, 0.16);
  }

  .eq-dot.up {
    fill: #089981;
  }

  .eq-dot.down {
    fill: #f23645;
  }

  .dd-line {
    fill: none;
    stroke: #f23645;
    stroke-width: 1.5;
  }

  .dd-area {
    fill: rgba(242, 54, 69, 0.18);
  }

  .pnl-bar.win {
    fill: rgba(8, 153, 129, 0.8);
  }

  .pnl-bar.loss {
    fill: rgba(242, 54, 69, 0.8);
  }

  .pnl-bar.hovered {
    opacity: 1;
    stroke: var(--dark-text-strong);
    stroke-width: 1;
  }

  .split-mini-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--dark-border-subtle);
  }

  .mini-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .mp-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--dark-text-secondary);
    margin-bottom: 2px;
  }

  .mp-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .sym-breakdown-wrap {
    overflow-x: auto;
  }

  .mini-table tbody tr {
    height: 32px;
  }

  .mini-table thead th {
    background: transparent;
  }
</style>
