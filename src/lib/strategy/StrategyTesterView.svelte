<script lang="ts">
  import { formatPaperPrice, formatQty, formatUsd } from '../paper/instruments';
  import type { PaperAccount } from '../paper/types';
  import {
    confirmPendingSignal,
    deployStrategyToPaper,
    dismissPendingSignal,
    exportStrategyTradesCsv,
    pauseForwardRunner,
    rerunStrategyBacktest,
    resumeForwardRunner,
    setRunnerExecutionMode,
    stopForwardRunner
  } from './store';
  import type {
    BacktestReport,
    BacktestTrade,
    ForwardExecutionMode,
    ForwardRunnerConfig,
    PendingStrategySignal,
    SavedStrategyRecord,
    SegmentMetrics,
    StrategySpec,
    StrategyTimeframe
  } from './types';

  interface Props {
    theme: 'dark' | 'light';
    record: SavedStrategyRecord;
    isRunning: boolean;
    runError: string | null;
    runner: ForwardRunnerConfig | null;
    pendingSignals: PendingStrategySignal[];
    paperAccounts: PaperAccount[];
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onSwitchToPaperAccount?: (accountId: string) => void;
  }

  let {
    theme,
    record,
    isRunning,
    runError,
    runner,
    pendingSignals,
    paperAccounts,
    onSelectSymbol,
    onSwitchToPaperAccount
  }: Props = $props();

  const report = $derived<BacktestReport>(record.report);
  const spec = $derived<StrategySpec>(report.spec);

  // View & section states
  let viewMode = $state<'report' | 'trades'>('report');
  let scope = $state<'all' | 'inSample' | 'outOfSample'>('all');
  let chartMode = $state<'performance' | 'drawdown'>('performance');
  let showBuyAndHold = $state(true);
  let perfSubTab = $state<'breakdown' | 'periodical' | 'benchmarking' | 'runup' | 'iterations'>(
    'breakdown'
  );
  let pnlBarMode = $state<'signals' | 'side'>('side');
  let tradesSubTab = $state<'distribution' | 'streaks' | 'time' | 'excursions'>('distribution');
  let tradesSortDesc = $state(true);
  let showColSegment = $state(true);
  let showColR = $state(true);

  // Popovers & Properties drawer
  let dateMenuOpen = $state(false);
  let capMenuOpen = $state(false);
  let costMenuOpen = $state(false);
  let propsOpen = $state(false);
  let forwardMenuOpen = $state(false);
  let colsMenuOpen = $state(false);

  // Hover states
  let hoverEqIdx = $state<number | null>(null);
  let hoverHistIdx = $state<number | null>(null);
  let hoverMonthIdx = $state<number | null>(null);

  // Forward deployment form state (defaults match confirmed recommendations)
  let fwdAccountMode = $state<'dedicated' | 'existing'>('dedicated');
  let fwdExistingAccountId = $state<string>('');
  let fwdExecMode = $state<ForwardExecutionMode>('auto');
  let fwdMaxDailyLoss = $state<number>(3.0);

  // Editable properties form (synced when opening Properties or switching strategy)
  let editInterval = $state<StrategyTimeframe>('1h');
  let editDirection = $state<'long' | 'short' | 'both'>('both');
  let editCapital = $state<number>(10000);
  let editRiskPct = $state<number>(1.0);
  let editSlType = $state<'atr_mult' | 'pct' | 'pips' | 'swing'>('atr_mult');
  let editSlVal = $state<number>(1.5);
  let editTpType = $state<'rr_multiple' | 'atr_mult' | 'pct' | 'pips' | 'none'>('rr_multiple');
  let editTpVal = $state<number>(2.0);
  let editMaxBars = $state<string>('48');
  let editSlippage = $state<number>(0.5);
  let editComm = $state<number>(0);
  let editOosPct = $state<number>(30);
  let editIndPeriods = $state<Record<string, number>>({});
  let selectedDatePreset = $state<'all' | '3m' | '6m' | '1y'>('all');

  function syncPropsFormFromSpec(s: StrategySpec) {
    editInterval = s.interval;
    editDirection = s.direction;
    editCapital = s.risk.initialCapital;
    editRiskPct = s.risk.riskPct;
    editSlType = s.risk.stopLoss.type;
    editSlVal =
      s.risk.stopLoss.type === 'pct'
        ? (s.risk.stopLoss.pct ?? 0.75)
        : s.risk.stopLoss.type === 'pips'
          ? (s.risk.stopLoss.pips ?? 30)
          : s.risk.stopLoss.type === 'swing'
            ? (s.risk.stopLoss.lookback ?? 10)
            : (s.risk.stopLoss.mult ?? 1.5);
    editTpType = s.risk.takeProfit.type;
    editTpVal =
      s.risk.takeProfit.type === 'atr_mult'
        ? (s.risk.takeProfit.mult ?? 3.0)
        : s.risk.takeProfit.type === 'pct'
          ? (s.risk.takeProfit.pct ?? 1.5)
          : s.risk.takeProfit.type === 'pips'
            ? (s.risk.takeProfit.pips ?? 60)
            : (s.risk.takeProfit.rr ?? 2.0);
    editMaxBars = s.risk.maxBarsInTrade ? String(s.risk.maxBarsInTrade) : '';
    editSlippage = s.risk.slippageTicks ?? 0.5;
    editComm = s.risk.commissionPerLotUsd ?? 0;
    editOosPct = Math.round((s.risk.oosFraction ?? 0.3) * 100);
    const periods: Record<string, number> = {};
    for (const ind of s.indicators) {
      if (typeof ind.period === 'number') periods[ind.id] = ind.period;
    }
    editIndPeriods = periods;
  }

  $effect(() => {
    syncPropsFormFromSpec(spec);
    if (!fwdExistingAccountId && paperAccounts.length > 0) {
      fwdExistingAccountId = paperAccounts[0].id;
    }
  });

  function closeAllMenus() {
    dateMenuOpen = false;
    capMenuOpen = false;
    costMenuOpen = false;
    forwardMenuOpen = false;
    colsMenuOpen = false;
  }

  const activeMetrics = $derived<SegmentMetrics>(
    scope === 'inSample'
      ? report.inSample
      : scope === 'outOfSample'
        ? report.outOfSample
        : report.all
  );

  const visibleTrades = $derived.by(() => {
    const base =
      scope === 'inSample'
        ? report.trades.filter((t) => t.segment === 'IS')
        : scope === 'outOfSample'
          ? report.trades.filter((t) => t.segment === 'OOS')
          : report.trades;
    return tradesSortDesc ? [...base].reverse() : base;
  });

  const stratPendingSignals = $derived(
    pendingSignals.filter((p) => p.strategyId === record.id)
  );

  // ── Date & number formatting helpers ───────────────────────────────────────

  function fmtDateShort(ts: number): string {
    if (!ts) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(ts * 1000));
  }

  function fmtTradeTs(ts: number): string {
    if (!ts) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC'
    }).format(new Date(ts * 1000));
  }

  function fmtCompactUsd(val: number): string {
    const abs = Math.abs(val);
    if (abs >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(val / 1_000).toFixed(abs >= 10_000 ? 0 : 2)}K`;
    return val.toFixed(0);
  }

  function fmtSignedPct(val: number): string {
    return `${val > 0.004 ? '+' : ''}${val.toFixed(2)}%`;
  }

  // ── Quick toolbar actions (deterministic backend re-run) ───────────────────

  async function applyCapitalPreset(capital: number) {
    capMenuOpen = false;
    const nextSpec: StrategySpec = {
      ...spec,
      risk: { ...spec.risk, initialCapital: capital }
    };
    await rerunStrategyBacktest(record.id, nextSpec);
  }

  async function applyCostMode(zeroCost: boolean, slipTicks = 0.5) {
    costMenuOpen = false;
    const nextSpec: StrategySpec = {
      ...spec,
      risk: { ...spec.risk, zeroCostDiagnostic: zeroCost, slippageTicks: slipTicks }
    };
    await rerunStrategyBacktest(record.id, nextSpec);
  }

  async function applyDatePreset(preset: 'all' | '3m' | '6m' | '1y') {
    dateMenuOpen = false;
    selectedDatePreset = preset;
    if (preset === 'all') {
      await rerunStrategyBacktest(record.id, spec, { fromTs: null, toTs: null });
      return;
    }
    const days = preset === '3m' ? 90 : preset === '6m' ? 180 : 365;
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTs = nowSec - days * 86400;
    await rerunStrategyBacktest(record.id, spec, { fromTs, toTs: null });
  }

  async function applyPropertiesRerun() {
    const nextInds = spec.indicators.map((ind) => {
      const editedP = editIndPeriods[ind.id];
      return typeof editedP === 'number' && Number.isFinite(editedP)
        ? { ...ind, period: Math.max(2, Math.min(400, Math.round(editedP))) }
        : ind;
    });

    const sl = { ...spec.risk.stopLoss, type: editSlType };
    if (editSlType === 'pct') sl.pct = editSlVal;
    else if (editSlType === 'pips') sl.pips = editSlVal;
    else if (editSlType === 'swing') sl.lookback = Math.round(editSlVal);
    else sl.mult = editSlVal;

    const tp = { ...spec.risk.takeProfit, type: editTpType };
    if (editTpType === 'atr_mult') tp.mult = editTpVal;
    else if (editTpType === 'pct') tp.pct = editTpVal;
    else if (editTpType === 'pips') tp.pips = editTpVal;
    else if (editTpType === 'rr_multiple') tp.rr = editTpVal;

    const maxBarsNum = Number(editMaxBars);
    const nextSpec: StrategySpec = {
      ...spec,
      interval: editInterval,
      direction: editDirection,
      indicators: nextInds,
      risk: {
        ...spec.risk,
        initialCapital: Math.max(100, Number(editCapital) || 10000),
        riskPct: Math.max(0.1, Math.min(10, Number(editRiskPct) || 1.0)),
        stopLoss: sl,
        takeProfit: tp,
        maxBarsInTrade:
          editMaxBars.trim() !== '' && Number.isFinite(maxBarsNum) && maxBarsNum >= 2
            ? Math.round(maxBarsNum)
            : null,
        slippageTicks: Math.max(0, Number(editSlippage) || 0),
        commissionPerLotUsd: Math.max(0, Number(editComm) || 0),
        oosFraction: Math.max(0.15, Math.min(0.45, (Number(editOosPct) || 30) / 100))
      }
    };

    const res = await rerunStrategyBacktest(record.id, nextSpec);
    if (res.ok) propsOpen = false;
  }

  function handleDeployForward() {
    deployStrategyToPaper(record.id, {
      accountMode: fwdAccountMode,
      existingAccountId: fwdAccountMode === 'existing' ? fwdExistingAccountId : undefined,
      executionMode: fwdExecMode,
      maxDailyLossPct: fwdMaxDailyLoss
    });
    forwardMenuOpen = false;
  }

  // ── SVG Performance & Drawdown Chart Geometry ──────────────────────────────

  const CH_W = 860;
  const CH_H = 205;
  const PAD_L = 14;
  const PAD_R = 66;
  const PAD_T = 14;
  const PAD_B = 26;

  const chartGeom = $derived.by(() => {
    const pts = activeMetrics.equityCurve;
    if (!pts || pts.length < 2) return null;

    const plotW = CH_W - PAD_L - PAD_R;
    const plotH = CH_H - PAD_T - PAD_B;
    const vals = pts.map((p) =>
      chartMode === 'drawdown' ? -p.drawdownUsd : p.cumulativePnlUsd
    );
    const bhVals =
      chartMode === 'performance' && showBuyAndHold
        ? pts.map((p) => p.buyAndHoldPnlUsd)
        : [];
    const allV = [...vals, ...bhVals, 0];
    const rawMin = Math.min(...allV);
    const rawMax = Math.max(...allV);
    const span = Math.max(10, rawMax - rawMin);
    const minY = rawMin - span * 0.08;
    const maxY = rawMax + span * 0.1;
    const ySpan = Math.max(1, maxY - minY);

    const toX = (idx: number) =>
      PAD_L + (pts.length <= 1 ? 0 : (idx / (pts.length - 1)) * plotW);
    const toY = (v: number) => PAD_T + ((maxY - v) / ySpan) * plotH;
    const zeroY = toY(0);

    const coords = pts.map((p, i) => {
      const val = vals[i];
      return {
        x: toX(i),
        y: toY(val),
        bhY: toY(p.buyAndHoldPnlUsd),
        val,
        point: p
      };
    });

    const linePath = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(' ');
    const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${coords[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;
    const bhPath = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.bhY.toFixed(1)}`)
      .join(' ');

    // 5 clean horizontal ticks
    const yTicks: { y: number; label: string }[] = [];
    for (let k = 0; k <= 4; k++) {
      const v = minY + (ySpan * k) / 4;
      yTicks.push({ y: toY(v), label: formatUsd(v) });
    }

    // 4 clean bottom date labels
    const xTicks: { x: number; label: string }[] = [];
    const tickIndices = [
      0,
      Math.floor((pts.length - 1) * 0.33),
      Math.floor((pts.length - 1) * 0.66),
      pts.length - 1
    ];
    const seenX = new Set<number>();
    for (const ti of tickIndices) {
      if (seenX.has(ti) || !pts[ti]) continue;
      seenX.add(ti);
      const dt = new Date(pts[ti].ts * 1000);
      const lbl = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: '2-digit',
        timeZone: 'UTC'
      }).format(dt);
      xTicks.push({ x: toX(ti), label: lbl });
    }

    // Locate OOS split boundary X coordinate (only in 'all' scope)
    let oosSplitX: number | null = null;
    if (scope === 'all' && report.oosSplitTs > 0) {
      const oosIdx = pts.findIndex((p, i) => i > 0 && p.ts >= report.oosSplitTs);
      if (oosIdx > 0) {
        oosSplitX = toX(oosIdx);
      }
    }

    const lastCoord = coords[coords.length - 1];
    const isUp = chartMode === 'performance' && lastCoord.val >= 0;

    return {
      coords,
      linePath,
      areaPath,
      bhPath,
      zeroY,
      yTicks,
      xTicks,
      oosSplitX,
      lastCoord,
      isUp,
      plotW,
      plotH
    };
  });

  const hoveredChartPoint = $derived(
    chartGeom && hoverEqIdx !== null && chartGeom.coords[hoverEqIdx]
      ? chartGeom.coords[hoverEqIdx]
      : null
  );

  // ── Profits and losses diverging bar geometry (matching Image 4) ───────────

  const pnlRows = $derived.by(() => {
    const m = activeMetrics;
    const rows =
      pnlBarMode === 'side'
        ? [
            {
              label: `All trades (${m.totalTrades})`,
              grossProfit: m.grossProfitUsd,
              grossLoss: m.grossLossUsd,
              net: m.totalPnlUsd
            },
            {
              label: `Long (${m.tradesLong})`,
              grossProfit: m.grossProfitLongUsd,
              grossLoss: m.grossLossLongUsd,
              net: m.netPnlLongUsd
            },
            {
              label: `Short (${m.tradesShort})`,
              grossProfit: m.grossProfitShortUsd,
              grossLoss: m.grossLossShortUsd,
              net: m.netPnlShortUsd
            }
          ]
        : [
            {
              label: 'All signals',
              grossProfit: m.grossProfitUsd,
              grossLoss: m.grossLossUsd,
              net: m.totalPnlUsd
            },
            {
              label: 'In-Sample (70%)',
              grossProfit: report.inSample.grossProfitUsd,
              grossLoss: report.inSample.grossLossUsd,
              net: report.inSample.totalPnlUsd
            },
            {
              label: 'Out-of-Sample (30%)',
              grossProfit: report.outOfSample.grossProfitUsd,
              grossLoss: report.outOfSample.grossLossUsd,
              net: report.outOfSample.totalPnlUsd
            }
          ];

    const maxBar = Math.max(1, ...rows.map((r) => r.grossProfit + r.grossLoss));
    return rows.map((r) => ({
      ...r,
      lossPctW: (r.grossLoss / maxBar) * 100,
      profitPctW: (r.grossProfit / maxBar) * 100
    }));
  });

  // ── SVG Donut Ring Geometry (Trades Distribution, matching Image 4) ────────

  const donutGeom = $derived.by(() => {
    const m = activeMetrics;
    const total = Math.max(1, m.totalTrades);
    const R = 52;
    const C = 2 * Math.PI * R;
    const winFrac = m.winningTrades / total;
    const lossFrac = m.losingTrades / total;
    const beFrac = m.breakevenTrades / total;

    const winLen = winFrac * C;
    const lossLen = lossFrac * C;
    const beLen = beFrac * C;

    return {
      R,
      C,
      winLen,
      lossLen,
      beLen,
      lossOffset: -winLen,
      beOffset: -(winLen + lossLen),
      winPct: m.totalTrades > 0 ? (m.winningTrades / m.totalTrades) * 100 : 0,
      lossPct: m.totalTrades > 0 ? (m.losingTrades / m.totalTrades) * 100 : 0,
      bePct: m.totalTrades > 0 ? (m.breakevenTrades / m.totalTrades) * 100 : 0
    };
  });

  // ── Returns Histogram Geometry (matching Image 4) ──────────────────────────

  const histGeom = $derived.by(() => {
    const buckets = activeMetrics.returnsHistogram;
    if (!buckets || buckets.length === 0) return null;
    const maxCnt = Math.max(1, ...buckets.map((b) => b.count));
    return { buckets, maxCnt };
  });

  function exitReasonLabel(reason: BacktestTrade['exitReason']): string {
    switch (reason) {
      case 'tp':
        return 'Take Profit';
      case 'sl':
        return 'Stop Loss';
      case 'trailing_sl':
        return 'Trailing SL';
      case 'time_stop':
        return 'Time Stop';
      case 'signal':
        return 'Signal Exit';
      case 'end_of_data':
        return 'End of Window';
    }
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.closest('[data-st-menu]')) closeAllMenus();
  }}
/>

<div class="st-root" class:light={theme === 'light'}>
  <!-- ── TradingView-Style Flat Sub-Toolbar ────────────────────────────────── -->
  <div class="st-toolbar">
    <div class="tb-left">
      <!-- Report vs List of trades icon switch -->
      <div class="view-switch" role="tablist" aria-label="Strategy Tester view">
        <button
          class="vs-btn"
          class:active={viewMode === 'report'}
          type="button"
          title="Strategy Report"
          aria-label="Strategy Report"
          onclick={() => (viewMode = 'report')}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 11.2 5.4 7.8l2.7 2.5L13.8 4.6" />
          </svg>
        </button>
        <button
          class="vs-btn"
          class:active={viewMode === 'trades'}
          type="button"
          title="List of trades"
          aria-label="List of trades"
          onclick={() => (viewMode = 'trades')}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
            <path d="M2.2 6.4h11.6M2.2 9.7h11.6M5.8 3v10" />
          </svg>
        </button>
      </div>

      <!-- Date Range Pill -->
      <div class="tb-anchor" data-st-menu>
        <button
          class="tb-pill"
          type="button"
          onclick={() => {
            const next = !dateMenuOpen;
            closeAllMenus();
            dateMenuOpen = next;
          }}
        >
          <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.2" y="3.2" width="11.6" height="10.4" rx="1.4" />
            <path d="M5 1.8v2.6M11 1.8v2.6M2.2 6.4h11.6" />
          </svg>
          <span>{fmtDateShort(report.fromTs)} — {fmtDateShort(report.toTs)}</span>
          <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if dateMenuOpen}
          <div class="st-menu">
            <div class="st-menu-lbl">Backtest Date Window</div>
            {#each [
              { id: 'all', label: 'Full OANDA History (Recommended)' },
              { id: '1y', label: 'Last 1 Year' },
              { id: '6m', label: 'Last 6 Months' },
              { id: '3m', label: 'Last 3 Months' }
            ] as p (p.id)}
              <button
                class="st-menu-item"
                class:active={selectedDatePreset === p.id}
                type="button"
                onclick={() => void applyDatePreset(p.id as 'all' | '3m' | '6m' | '1y')}
              >
                {p.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Initial Capital Pill -->
      <div class="tb-anchor" data-st-menu>
        <button
          class="tb-pill"
          type="button"
          onclick={() => {
            const next = !capMenuOpen;
            closeAllMenus();
            capMenuOpen = next;
          }}
        >
          <span class="cap-circle">$</span>
          <span>{fmtCompactUsd(spec.risk.initialCapital)} <small>USD</small></span>
          <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if capMenuOpen}
          <div class="st-menu">
            <div class="st-menu-lbl">Initial Capital</div>
            {#each [1000, 5000, 10000, 25000, 50000, 100000] as cap (cap)}
              <button
                class="st-menu-item"
                class:active={spec.risk.initialCapital === cap}
                type="button"
                onclick={() => void applyCapitalPreset(cap)}
              >
                <span>${cap.toLocaleString('en-US')} USD</span>
                <span class="m-sub">{spec.risk.riskPct}% risk</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Execution & Spread Cost Pill -->
      <div class="tb-anchor" data-st-menu>
        <button
          class="tb-pill"
          type="button"
          title={report.dataQualityNote}
          onclick={() => {
            const next = !costMenuOpen;
            closeAllMenus();
            costMenuOpen = next;
          }}
        >
          <span class="data-dot" class:oanda={report.dataSource === 'oanda_mba'}></span>
          <span>
            {spec.risk.zeroCostDiagnostic
              ? 'Zero-Cost Diagnostic'
              : report.dataSource === 'oanda_mba'
                ? `OANDA Bid/Ask + ${spec.risk.slippageTicks ?? 0.5}t`
                : `Indicative + ${spec.risk.slippageTicks ?? 0.5}t`}
          </span>
          <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if costMenuOpen}
          <div class="st-menu wide">
            <div class="st-menu-lbl">Cost & Fill Model</div>
            <button
              class="st-menu-item"
              class:active={!spec.risk.zeroCostDiagnostic && (spec.risk.slippageTicks ?? 0.5) === 0.5}
              type="button"
              onclick={() => void applyCostMode(false, 0.5)}
            >
              <span>Realistic: OANDA Bid/Ask + 0.5t Slippage</span>
            </button>
            <button
              class="st-menu-item"
              class:active={!spec.risk.zeroCostDiagnostic && (spec.risk.slippageTicks ?? 0.5) === 1.5}
              type="button"
              onclick={() => void applyCostMode(false, 1.5)}
            >
              <span>Stress Test: OANDA Bid/Ask + 1.5t Slippage</span>
            </button>
            <button
              class="st-menu-item"
              class:active={Boolean(spec.risk.zeroCostDiagnostic)}
              type="button"
              onclick={() => void applyCostMode(true, 0)}
            >
              <span>Zero-Cost Diagnostic (Gross Mid Only)</span>
            </button>
            <div class="st-menu-note">{report.dataQualityNote}</div>
          </div>
        {/if}
      </div>

      <span class="tb-sep"></span>

      <!-- Properties Gear -->
      <button
        class="tb-icon-btn"
        class:active={propsOpen}
        type="button"
        title="Strategy Properties & Re-run"
        aria-label="Strategy Properties"
        onclick={() => {
          closeAllMenus();
          propsOpen = !propsOpen;
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2.1v1.4M8 12.5v1.4M2.1 8h1.4M12.5 8h1.4M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1" />
        </svg>
      </button>

      <!-- Forward in Paper Ledger Deployment Control -->
      <div class="tb-anchor" data-st-menu>
        <button
          class="tb-fwd-btn"
          class:live={runner?.status === 'running'}
          class:paused={runner?.status === 'paused'}
          type="button"
          title="Run strategy forward on live OANDA prices in Paper Ledger (SIM)"
          onclick={() => {
            const next = !forwardMenuOpen;
            closeAllMenus();
            forwardMenuOpen = next;
          }}
        >
          {#if runner?.status === 'running'}
            <span class="fwd-pulse"></span>
            <span>Running in Paper</span>
          {:else if runner?.status === 'paused'}
            <span class="fwd-dot paused"></span>
            <span>Paused (Paper)</span>
          {:else}
            <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 3.2 12.6 8l-8.1 4.8V3.2Z" />
            </svg>
            <span>Forward in Paper</span>
          {/if}
        </button>

        {#if forwardMenuOpen}
          <div class="st-menu fwd-pop">
            {#if runner}
              <div class="st-menu-lbl">Active Paper Forward Runner</div>
              <div class="fwd-status-box">
                <div class="fs-line">
                  <span class="muted">Account</span>
                  <button
                    class="link-btn"
                    type="button"
                    onclick={() => {
                      forwardMenuOpen = false;
                      onSwitchToPaperAccount?.(runner.accountId);
                    }}
                  >
                    {runner.accountName} →
                  </button>
                </div>
                <div class="fs-line">
                  <span class="muted">Mode</span>
                  <div class="mini-seg">
                    <button
                      type="button"
                      class:active={runner.executionMode === 'auto'}
                      onclick={() => setRunnerExecutionMode(runner.id, 'auto')}
                    >
                      Auto SIM
                    </button>
                    <button
                      type="button"
                      class:active={runner.executionMode === 'confirm'}
                      onclick={() => setRunnerExecutionMode(runner.id, 'confirm')}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
                <div class="fs-line">
                  <span class="muted">Signals fired</span>
                  <span>{runner.signalsFired} · Max DD {runner.maxDailyLossPct}%/day</span>
                </div>
                {#if runner.pauseReason}
                  <div class="fs-warn">{runner.pauseReason}</div>
                {/if}
              </div>
              <div class="fwd-actions">
                {#if runner.status === 'running'}
                  <button
                    class="fwd-act"
                    type="button"
                    onclick={() => pauseForwardRunner(runner.id, 'Paused manually')}
                  >
                    Pause
                  </button>
                {:else}
                  <button
                    class="fwd-act primary"
                    type="button"
                    onclick={() => resumeForwardRunner(runner.id)}
                  >
                    Resume
                  </button>
                {/if}
                <button
                  class="fwd-act danger"
                  type="button"
                  onclick={() => {
                    stopForwardRunner(runner.id);
                    forwardMenuOpen = false;
                  }}
                >
                  Stop Runner
                </button>
              </div>
            {:else}
              <div class="st-menu-lbl">Forward-Test Live in Paper Ledger (SIM)</div>
              <p class="fwd-desc">
                Evaluates strictly closed {spec.interval} OANDA candles for <strong>{spec.shortName}</strong>. Never places real-money orders.
              </p>

              <label class="fwd-field">
                <span>Target SIM Account</span>
                <select bind:value={fwdAccountMode}>
                  <option value="dedicated">
                    Dedicated Sub-Account (BOT · {spec.name.slice(0, 18)}) — Recommended
                  </option>
                  {#if paperAccounts.length > 0}
                    <option value="existing">Use Existing Paper Account</option>
                  {/if}
                </select>
              </label>

              {#if fwdAccountMode === 'existing' && paperAccounts.length > 0}
                <label class="fwd-field">
                  <span>Paper Account</span>
                  <select bind:value={fwdExistingAccountId}>
                    {#each paperAccounts as acc (acc.id)}
                      <option value={acc.id}>{acc.name} (${formatUsd(acc.balance)})</option>
                    {/each}
                  </select>
                </label>
              {/if}

              <label class="fwd-field">
                <span>Execution Mode</span>
                <select bind:value={fwdExecMode}>
                  <option value="auto">Auto-Execute SIM (Recommended)</option>
                  <option value="confirm">Signal Confirm Banner (Manual Approval)</option>
                </select>
              </label>

              <label class="fwd-field">
                <span>Daily Loss Circuit Breaker (%)</span>
                <input type="number" min="0.5" max="20" step="0.5" bind:value={fwdMaxDailyLoss} />
              </label>

              <button class="fwd-start-btn" type="button" onclick={handleDeployForward}>
                Start Forward Runner (SIM)
              </button>
            {/if}
          </div>
        {/if}
      </div>

      {#if isRunning}
        <span class="running-chip">Re-running...</span>
      {/if}
    </div>

    <div class="tb-right">
      <!-- Scope Switcher: All | In-Sample | Out-of-Sample -->
      <div class="scope-pills" role="tablist" aria-label="Dataset segment">
        <button
          class="sc-btn"
          class:active={scope === 'all'}
          type="button"
          onclick={() => (scope = 'all')}
        >
          All ({report.all.totalTrades})
        </button>
        <button
          class="sc-btn"
          class:active={scope === 'inSample'}
          type="button"
          onclick={() => (scope = 'inSample')}
        >
          IS 70% ({report.inSample.totalTrades})
        </button>
        <button
          class="sc-btn"
          class:active={scope === 'outOfSample'}
          type="button"
          onclick={() => (scope = 'outOfSample')}
        >
          OOS 30% ({report.outOfSample.totalTrades})
        </button>
      </div>

      <span
        class="verdict-pill"
        class:pass={report.verdict.status === 'pass'}
        class:marginal={report.verdict.status === 'marginal' || report.verdict.status === 'low_sample'}
        class:fail={report.verdict.status === 'no_edge' || report.verdict.status === 'overfit'}
        title={report.verdict.summary}
      >
        {report.verdict.label}
      </span>
    </div>
  </div>

  {#if runError}
    <div class="st-error-bar">{runError}</div>
  {/if}

  <!-- Pending Manual Confirm Signals Banner -->
  {#if stratPendingSignals.length > 0}
    {#each stratPendingSignals as sig (sig.id)}
      <div class="signal-banner">
        <div class="sig-left">
          <span class="sig-tag" class:buy={sig.signal === 'enter_long'} class:sell={sig.signal === 'enter_short'}>
            {sig.signal.replace('_', ' ').toUpperCase()}
          </span>
          <span>
            <strong>{sig.shortName}</strong> @ {formatPaperPrice(sig.price, sig.symbol)} · Qty {formatQty(sig.quantity)}
            {#if sig.stopLoss} · SL {formatPaperPrice(sig.stopLoss, sig.symbol)}{/if}
            {#if sig.takeProfit} · TP {formatPaperPrice(sig.takeProfit, sig.symbol)}{/if}
          </span>
        </div>
        <div class="sig-acts">
          <button class="sig-btn ok" type="button" onclick={() => confirmPendingSignal(sig.id)}>
            Execute SIM
          </button>
          <button class="sig-btn" type="button" onclick={() => dismissPendingSignal(sig.id)}>
            Skip
          </button>
        </div>
      </div>
    {/each}
  {/if}

  <!-- ── Collapsible Inline Properties Editor ──────────────────────────────── -->
  {#if propsOpen}
    <div class="props-drawer">
      <div class="props-head">
        <div>
          <span class="props-title">Properties — {spec.name}</span>
          <span class="props-sub">
            {spec.symbol} · {spec.interval} · {report.barsTotal.toLocaleString('en-US')} bars ({report.warmupBars} warmup)
          </span>
        </div>
        <button class="props-close" type="button" onclick={() => (propsOpen = false)}>×</button>
      </div>

      {#if spec.ruleSummary.length > 0}
        <div class="rules-list">
          {#each spec.ruleSummary as rule, i (i)}
            <div class="rule-item">• {rule}</div>
          {/each}
        </div>
      {/if}

      <div class="props-grid">
        <label class="pf">
          <span>Timeframe</span>
          <select bind:value={editInterval}>
            {#each ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W'] as tf (tf)}
              <option value={tf}>{tf}</option>
            {/each}
          </select>
        </label>
        <label class="pf">
          <span>Direction</span>
          <select bind:value={editDirection}>
            <option value="both">Long & Short</option>
            <option value="long">Long Only</option>
            <option value="short">Short Only</option>
          </select>
        </label>
        <label class="pf">
          <span>Initial Capital (USD)</span>
          <input type="number" min="100" step="500" bind:value={editCapital} />
        </label>
        <label class="pf">
          <span>Risk per Trade (%)</span>
          <input type="number" min="0.1" max="10" step="0.1" bind:value={editRiskPct} />
        </label>
        <label class="pf">
          <span>Stop Loss Type</span>
          <select bind:value={editSlType}>
            <option value="atr_mult">ATR Multiple</option>
            <option value="pct">Percent (%)</option>
            <option value="pips">Fixed Pips</option>
            <option value="swing">Swing Lookback</option>
          </select>
        </label>
        <label class="pf">
          <span>SL Value</span>
          <input type="number" min="0.1" step="0.1" bind:value={editSlVal} />
        </label>
        <label class="pf">
          <span>Take Profit Type</span>
          <select bind:value={editTpType}>
            <option value="rr_multiple">R-Multiple</option>
            <option value="atr_mult">ATR Multiple</option>
            <option value="pct">Percent (%)</option>
            <option value="pips">Fixed Pips</option>
            <option value="none">None (Signal/Trail)</option>
          </select>
        </label>
        {#if editTpType !== 'none'}
          <label class="pf">
            <span>TP Value</span>
            <input type="number" min="0.2" step="0.1" bind:value={editTpVal} />
          </label>
        {/if}
        <label class="pf">
          <span>Max Bars Hold</span>
          <input type="text" placeholder="Unlimited" bind:value={editMaxBars} />
        </label>
        <label class="pf">
          <span>Slippage (ticks)</span>
          <input type="number" min="0" max="20" step="0.5" bind:value={editSlippage} />
        </label>
        <label class="pf">
          <span>Commission ($/lot)</span>
          <input type="number" min="0" max="50" step="0.5" bind:value={editComm} />
        </label>
        <label class="pf">
          <span>OOS Holdout (%)</span>
          <input type="number" min="15" max="45" step="5" bind:value={editOosPct} />
        </label>

        {#each spec.indicators.filter((i) => typeof i.period === 'number') as ind (ind.id)}
          <label class="pf">
            <span>{ind.id} ({ind.fn.toUpperCase()} period)</span>
            <input
              type="number"
              min="2"
              max="400"
              value={editIndPeriods[ind.id] ?? ind.period}
              oninput={(e) => {
                editIndPeriods = {
                  ...editIndPeriods,
                  [ind.id]: Number((e.currentTarget as HTMLInputElement).value)
                };
              }}
            />
          </label>
        {/each}
      </div>

      <div class="props-foot">
        <span class="muted">
          Deterministic engine · No LLM call · Uses cached OANDA Bid/Ask candles
        </span>
        <div class="props-acts">
          <button class="pf-btn" type="button" onclick={() => syncPropsFormFromSpec(spec)}>
            Reset
          </button>
          <button
            class="pf-btn primary"
            type="button"
            disabled={isRunning}
            onclick={() => void applyPropertiesRerun()}
          >
            {isRunning ? 'Re-running...' : 'Apply & Re-run'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ── MAIN BODY: REPORT VIEW OR LIST OF TRADES ──────────────────────────── -->
  <div class="st-body">
    {#if viewMode === 'report'}
      <!-- SECTION 1: KEY STATS (100% Flat TradingView Strip) -->
      <div class="flat-section">
        <div class="sec-head-row">
          <h3 class="sec-title">Key stats</h3>
          <span class="sec-meta">
            {spec.shortName} · {spec.interval} · {scope === 'all' ? 'All (70% IS + 30% OOS)' : scope === 'inSample' ? 'In-Sample (70%)' : 'Out-of-Sample Vault (30%)'}
          </span>
        </div>

        <div class="key-stats-row">
          <div class="ks-col">
            <span class="ks-lbl">Total PnL</span>
            <div
              class="ks-val"
              class:pos={activeMetrics.totalPnlUsd > 0.004}
              class:neg={activeMetrics.totalPnlUsd < -0.004}
            >
              <span>{formatUsd(activeMetrics.totalPnlUsd, true)}<small>USD</small></span>
              <span class="ks-pct">{fmtSignedPct(activeMetrics.totalPnlPct)}</span>
            </div>
          </div>

          <div class="ks-col">
            <span class="ks-lbl">Max drawdown</span>
            <div class="ks-val">
              <span>{formatUsd(activeMetrics.maxDrawdownUsd)}<small>USD</small></span>
              <span class="ks-pct muted">{activeMetrics.maxDrawdownPct.toFixed(2)}%</span>
            </div>
          </div>

          <div class="ks-col">
            <span class="ks-lbl">Profitable trades</span>
            <div class="ks-val">
              <span>{activeMetrics.winRatePct.toFixed(2)}%</span>
              <span class="ks-count">
                {activeMetrics.winningTrades}/{activeMetrics.totalTrades}
              </span>
            </div>
          </div>

          <div class="ks-col">
            <span class="ks-lbl">Profit factor</span>
            <div class="ks-val">
              <span>
                {activeMetrics.profitFactor !== null ? activeMetrics.profitFactor.toFixed(3) : '—'}
              </span>
              {#if scope === 'all' && report.outOfSample.totalTrades > 0}
                <span
                  class="ks-oos-tag"
                  class:pos={(report.outOfSample.profitFactor ?? 0) >= 1.15}
                  class:neg={(report.outOfSample.profitFactor ?? 0) < 1.0}
                >
                  OOS {(report.outOfSample.profitFactor ?? 0).toFixed(2)} ({report.outOfSample.totalTrades}t)
                </span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Performance / Drawdown Segmented Chart -->
        <div class="chart-controls">
          <div class="seg-tabs">
            <button
              class="seg-btn"
              class:active={chartMode === 'performance'}
              type="button"
              onclick={() => (chartMode = 'performance')}
            >
              Performance
            </button>
            <button
              class="seg-btn"
              class:active={chartMode === 'drawdown'}
              type="button"
              onclick={() => (chartMode = 'drawdown')}
            >
              Drawdown
            </button>
          </div>

          {#if hoveredChartPoint}
            <div class="chart-hover-bar">
              <span>{fmtTradeTs(hoveredChartPoint.point.ts)}</span>
              <span class="seg-chip">{hoveredChartPoint.point.segment}</span>
              {#if hoveredChartPoint.point.tradeNumber > 0}
                <span>Trade #{hoveredChartPoint.point.tradeNumber}</span>
              {/if}
              <strong
                class:pos={hoveredChartPoint.val > 0.004}
                class:neg={hoveredChartPoint.val < -0.004}
              >
                {chartMode === 'drawdown' ? 'DD ' : 'Cum PnL '}
                {formatUsd(hoveredChartPoint.val, chartMode === 'performance')} USD
              </strong>
              {#if hoveredChartPoint.point.tradeNumber > 0}
                <span
                  class:pos={hoveredChartPoint.point.tradePnlUsd > 0}
                  class:neg={hoveredChartPoint.point.tradePnlUsd < 0}
                >
                  ({formatUsd(hoveredChartPoint.point.tradePnlUsd, true)})
                </span>
              {/if}
            </div>
          {/if}
        </div>

        <div class="chart-legend">
          <span class="leg-item">
            <span
              class="leg-dot"
              class:pos={chartMode === 'performance' && activeMetrics.totalPnlUsd >= 0}
              class:neg={chartMode === 'drawdown' || activeMetrics.totalPnlUsd < 0}
            ></span>
            <span>{chartMode === 'drawdown' ? 'Drawdown' : 'Cumulative PnL'}</span>
            <strong
              class:pos={chartMode === 'performance' && activeMetrics.totalPnlUsd > 0.004}
              class:neg={chartMode === 'drawdown' || activeMetrics.totalPnlUsd < -0.004}
            >
              {chartMode === 'drawdown'
                ? `-${formatUsd(activeMetrics.maxDrawdownUsd)}`
                : formatUsd(activeMetrics.totalPnlUsd, true)}
            </strong>
          </span>

          {#if chartMode === 'performance'}
            <button
              class="leg-toggle"
              class:off={!showBuyAndHold}
              type="button"
              onclick={() => (showBuyAndHold = !showBuyAndHold)}
            >
              <span class="leg-dot bh"></span>
              <span>Buy and hold</span>
              <span>{formatUsd(activeMetrics.buyAndHoldPnlUsd, true)}</span>
            </button>
          {/if}

          {#if scope === 'all' && chartGeom?.oosSplitX}
            <span class="leg-item muted">
              <span class="oos-dash-ico"></span>
              <span>Out-of-Sample vault ({fmtDateShort(report.oosSplitTs)})</span>
            </span>
          {/if}
        </div>

        {#if chartGeom}
          <div class="chart-wrap">
            <svg
              class="tv-chart-svg"
              viewBox="0 0 {CH_W} {CH_H}"
              preserveAspectRatio="none"
              role="img"
              aria-label="Strategy equity performance chart"
              onmouseleave={() => (hoverEqIdx = null)}
            >
              <!-- Gridlines & Right Y-Axis -->
              {#each chartGeom.yTicks as t (t.label)}
                <line x1={PAD_L} x2={CH_W - PAD_R} y1={t.y} y2={t.y} class="grid-line" />
                <text x={CH_W - PAD_R + 6} y={t.y + 3} class="ax-lbl">{t.label}</text>
              {/each}

              <!-- Zero line -->
              <line
                x1={PAD_L}
                x2={CH_W - PAD_R}
                y1={chartGeom.zeroY}
                y2={chartGeom.zeroY}
                class="zero-line"
              />

              <!-- Out-of-Sample Shaded Holdout Region + Split Line -->
              {#if chartGeom.oosSplitX !== null}
                <rect
                  x={chartGeom.oosSplitX}
                  y={PAD_T}
                  width={Math.max(0, CH_W - PAD_R - chartGeom.oosSplitX)}
                  height={chartGeom.plotH}
                  class="oos-shade"
                />
                <line
                  x1={chartGeom.oosSplitX}
                  x2={chartGeom.oosSplitX}
                  y1={PAD_T}
                  y2={PAD_T + chartGeom.plotH}
                  class="oos-line"
                />
                <text x={chartGeom.oosSplitX + 5} y={PAD_T + 10} class="oos-lbl">OOS 30%</text>
              {/if}

              <!-- Buy and Hold Overlay -->
              {#if chartMode === 'performance' && showBuyAndHold}
                <path d={chartGeom.bhPath} class="bh-line" />
              {/if}

              <!-- Strategy Cumulative PnL / Drawdown Area & Line -->
              <path
                d={chartGeom.areaPath}
                class="eq-area"
                class:up={chartGeom.isUp}
                class:down={!chartGeom.isUp}
              />
              <path
                d={chartGeom.linePath}
                class="eq-line"
                class:up={chartGeom.isUp}
                class:down={!chartGeom.isUp}
              />

              <!-- Hover Crosshair -->
              {#if hoveredChartPoint}
                <line
                  x1={hoveredChartPoint.x}
                  x2={hoveredChartPoint.x}
                  y1={PAD_T}
                  y2={PAD_T + chartGeom.plotH}
                  class="crosshair-line"
                />
                <circle
                  cx={hoveredChartPoint.x}
                  cy={hoveredChartPoint.y}
                  r="4"
                  class="eq-dot"
                  class:up={chartGeom.isUp}
                  class:down={!chartGeom.isUp}
                />
              {/if}

              <!-- Right-Axis Highlight Pill (TradingView Signature) -->
              <rect
                x={CH_W - PAD_R + 2}
                y={Math.max(PAD_T, Math.min(CH_H - PAD_B - 16, chartGeom.lastCoord.y - 8))}
                width={PAD_R - 4}
                height="16"
                rx="3"
                class="last-tag-bg"
                class:up={chartGeom.isUp}
                class:down={!chartGeom.isUp}
              />
              <text
                x={CH_W - PAD_R + 6}
                y={Math.max(PAD_T + 11, Math.min(CH_H - PAD_B - 5, chartGeom.lastCoord.y + 3))}
                class="last-tag-txt"
              >
                {formatUsd(chartGeom.lastCoord.val)}
              </text>

              <!-- X-Axis Date Labels -->
              {#each chartGeom.xTicks as xt, i (i)}
                <text x={xt.x} y={CH_H - 6} class="ax-lbl">{xt.label}</text>
              {/each}

              <!-- Interactive Hover Hit Strips -->
              {#each chartGeom.coords as c, i (i)}
                {@const stripW = Math.max(8, chartGeom.plotW / Math.max(1, chartGeom.coords.length))}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <rect
                  x={c.x - stripW / 2}
                  y={PAD_T}
                  width={stripW}
                  height={chartGeom.plotH}
                  fill="transparent"
                  onmouseenter={() => (hoverEqIdx = i)}
                />
              {/each}
            </svg>
          </div>
        {:else}
          <div class="empty-flat">No closed trades in this segment to plot equity curve.</div>
        {/if}
      </div>

      <!-- SECTION 2: PERFORMANCE ANALYSIS (100% Flat) -->
      <div class="flat-section bordered-top">
        <h3 class="sec-title">Performance analysis</h3>

        <div class="pill-bar">
          {#each [
            { id: 'breakdown', label: 'Breakdown' },
            { id: 'periodical', label: 'Periodical' },
            { id: 'benchmarking', label: 'Benchmarking' },
            { id: 'runup', label: 'Runup & Drawdown' },
            { id: 'iterations', label: `AI Iterations (${report.iterations.length || 1})` }
          ] as tab (tab.id)}
            <button
              class="tv-pill-tab"
              class:active={perfSubTab === tab.id}
              type="button"
              onclick={() => (perfSubTab = tab.id as typeof perfSubTab)}
            >
              {tab.label}
            </button>
          {/each}
        </div>

        {#if perfSubTab === 'breakdown'}
          <div class="flat-metrics-4">
            <div class="fm-col">
              <span class="fm-lbl">Gross profit</span>
              <span class="fm-val">
                {formatUsd(activeMetrics.grossProfitUsd)}<small>USD</small>
                <span class="fm-sub">{activeMetrics.grossProfitPct.toFixed(2)}%</span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Gross loss</span>
              <span class="fm-val">
                {formatUsd(activeMetrics.grossLossUsd)}<small>USD</small>
                <span class="fm-sub">{activeMetrics.grossLossPct.toFixed(2)}%</span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Profit factor</span>
              <span class="fm-val">
                {activeMetrics.profitFactor !== null ? activeMetrics.profitFactor.toFixed(3) : '—'}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Spread & slippage load</span>
              <span class="fm-val">
                {formatUsd(activeMetrics.totalCostUsd)}<small>USD</small>
                {#if activeMetrics.costPctOfGrossProfit !== null}
                  <span class="fm-sub" class:neg={activeMetrics.costPctOfGrossProfit > 40}>
                    {activeMetrics.costPctOfGrossProfit.toFixed(1)}% of gross
                  </span>
                {/if}
              </span>
            </div>
          </div>

          <!-- Profits and losses horizontal bars (matching Image 4) -->
          <div class="pl-head-row">
            <span class="sub-sec-title">Profits and losses</span>
            <div class="seg-tabs small">
              <button
                class="seg-btn"
                class:active={pnlBarMode === 'signals'}
                type="button"
                onclick={() => (pnlBarMode = 'signals')}
              >
                By split
              </button>
              <button
                class="seg-btn"
                class:active={pnlBarMode === 'side'}
                type="button"
                onclick={() => (pnlBarMode = 'side')}
              >
                By side
              </button>
            </div>
          </div>

          <div class="pl-bars-list">
            {#each pnlRows as row (row.label)}
              <div class="pl-bar-row">
                <span class="pl-lbl">{row.label}</span>
                <div class="pl-track">
                  <div class="pl-loss" style:width="{row.lossPctW.toFixed(1)}%"></div>
                  <div class="pl-prof" style:width="{row.profitPctW.toFixed(1)}%"></div>
                </div>
                <span
                  class="pl-net"
                  class:pos={row.net > 0.004}
                  class:neg={row.net < -0.004}
                >
                  {formatUsd(row.net, true)} <small>USD</small>
                </span>
              </div>
            {/each}
          </div>
        {:else if perfSubTab === 'periodical'}
          {#if activeMetrics.monthlyReturns.length === 0}
            <div class="empty-flat">No monthly return buckets in this segment.</div>
          {:else}
            {@const maxAbsM = Math.max(1, ...activeMetrics.monthlyReturns.map((m) => Math.abs(m.pnlUsd)))}
            <div class="periodical-bars">
              {#each activeMetrics.monthlyReturns as m, idx (m.ym)}
                {@const hPct = Math.max(6, (Math.abs(m.pnlUsd) / maxAbsM) * 100)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="pm-col"
                  class:hovered={hoverMonthIdx === idx}
                  onmouseenter={() => (hoverMonthIdx = idx)}
                  onmouseleave={() => (hoverMonthIdx = null)}
                >
                  <span class="pm-val" class:pos={m.pnlUsd >= 0} class:neg={m.pnlUsd < 0}>
                    {m.pnlPct >= 0 ? '+' : ''}{m.pnlPct.toFixed(1)}%
                  </span>
                  <div class="pm-bar-zone">
                    <div
                      class="pm-bar"
                      class:pos={m.pnlUsd >= 0}
                      class:neg={m.pnlUsd < 0}
                      style:height="{hPct.toFixed(0)}%"
                    ></div>
                  </div>
                  <span class="pm-ym">{m.ym}</span>
                  <span class="pm-cnt">{m.trades}t · {m.winRatePct.toFixed(0)}%</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else if perfSubTab === 'benchmarking'}
          {@const alpha = activeMetrics.totalPnlPct - activeMetrics.buyAndHoldPct}
          <div class="flat-metrics-4">
            <div class="fm-col">
              <span class="fm-lbl">Strategy return</span>
              <span
                class="fm-val"
                class:pos={activeMetrics.totalPnlPct > 0}
                class:neg={activeMetrics.totalPnlPct < 0}
              >
                {fmtSignedPct(activeMetrics.totalPnlPct)}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Buy & hold return</span>
              <span class="fm-val">{fmtSignedPct(activeMetrics.buyAndHoldPct)}</span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Alpha vs Buy & hold</span>
              <span class="fm-val" class:pos={alpha > 0} class:neg={alpha < 0}>
                {fmtSignedPct(alpha)}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Recovery factor</span>
              <span class="fm-val">
                {activeMetrics.recoveryFactor !== null ? activeMetrics.recoveryFactor.toFixed(2) : '—'}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Sharpe ratio</span>
              <span class="fm-val">
                {activeMetrics.sharpeRatio !== null ? activeMetrics.sharpeRatio.toFixed(2) : '—'}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Sortino ratio</span>
              <span class="fm-val">
                {activeMetrics.sortinoRatio !== null ? activeMetrics.sortinoRatio.toFixed(2) : '—'}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Calmar ratio</span>
              <span class="fm-val">
                {activeMetrics.calmarRatio !== null ? activeMetrics.calmarRatio.toFixed(2) : '—'}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Spread / Slippage / Comm</span>
              <span class="fm-val fm-tight">
                ${activeMetrics.totalSpreadCostUsd.toFixed(2)} / ${activeMetrics.totalSlippageCostUsd.toFixed(2)} / ${activeMetrics.totalCommissionUsd.toFixed(2)}
              </span>
            </div>
          </div>
        {:else if perfSubTab === 'runup'}
          <div class="flat-metrics-4">
            <div class="fm-col">
              <span class="fm-lbl">Max equity runup</span>
              <span class="fm-val pos">
                {formatUsd(activeMetrics.maxRunupUsd)}<small>USD</small>
                <span class="fm-sub">{activeMetrics.maxRunupPct.toFixed(2)}%</span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg runup</span>
              <span class="fm-val">{formatUsd(activeMetrics.avgRunupUsd)}<small>USD</small></span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Max equity drawdown</span>
              <span class="fm-val neg">
                {formatUsd(activeMetrics.maxDrawdownUsd)}<small>USD</small>
                <span class="fm-sub">{activeMetrics.maxDrawdownPct.toFixed(2)}%</span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg drawdown</span>
              <span class="fm-val">{formatUsd(activeMetrics.avgDrawdownUsd)}<small>USD</small></span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg bars in trade</span>
              <span class="fm-val">{activeMetrics.avgBarsHeld.toFixed(1)}</span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg bars (winners)</span>
              <span class="fm-val pos">{activeMetrics.avgBarsWin.toFixed(1)}</span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg bars (losers)</span>
              <span class="fm-val neg">{activeMetrics.avgBarsLoss.toFixed(1)}</span>
            </div>
          </div>
        {:else if perfSubTab === 'iterations'}
          <div class="iter-wrap">
            <table class="flat-table">
              <thead>
                <tr>
                  <th>Version / Split</th>
                  <th>Hypothesis / Rationale</th>
                  <th class="num">Trades</th>
                  <th class="num">Win Rate</th>
                  <th class="num">Net PnL</th>
                  <th class="num">PF</th>
                  <th class="num">Max DD</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {#each report.iterations as it (it.version)}
                  <tr>
                    <td class="bold">v{it.version} (In-Sample)</td>
                    <td class="muted">{it.rationale}</td>
                    <td class="num">{it.isTrades}</td>
                    <td class="num">{it.isWinRatePct.toFixed(1)}%</td>
                    <td class="num" class:pos={it.isNetPnlUsd > 0} class:neg={it.isNetPnlUsd < 0}>
                      {formatUsd(it.isNetPnlUsd, true)} ({fmtSignedPct(it.isNetPnlPct)})
                    </td>
                    <td class="num">{it.isProfitFactor !== null ? it.isProfitFactor.toFixed(2) : '—'}</td>
                    <td class="num">{it.isMaxDdPct.toFixed(2)}%</td>
                    <td>
                      <span class="iter-badge" class:kept={it.kept}>
                        {it.kept ? 'Selected' : 'Superseded'}
                      </span>
                    </td>
                  </tr>
                {/each}
                <tr class="oos-row">
                  <td class="bold">Out-of-Sample (30% Vault)</td>
                  <td class="muted">Single locked validation on unseen candles after freeze</td>
                  <td class="num">{report.outOfSample.totalTrades}</td>
                  <td class="num">{report.outOfSample.winRatePct.toFixed(1)}%</td>
                  <td
                    class="num bold"
                    class:pos={report.outOfSample.totalPnlUsd > 0}
                    class:neg={report.outOfSample.totalPnlUsd < 0}
                  >
                    {formatUsd(report.outOfSample.totalPnlUsd, true)} ({fmtSignedPct(report.outOfSample.totalPnlPct)})
                  </td>
                  <td class="num bold">
                    {report.outOfSample.profitFactor !== null
                      ? report.outOfSample.profitFactor.toFixed(2)
                      : '—'}
                  </td>
                  <td class="num">{report.outOfSample.maxDrawdownPct.toFixed(2)}%</td>
                  <td>
                    <span
                      class="iter-badge"
                      class:kept={report.verdict.status === 'pass'}
                      class:bad={report.verdict.status === 'overfit' || report.verdict.status === 'no_edge'}
                    >
                      {report.verdict.label}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        {/if}
      </div>

      <!-- SECTION 3: TRADES ANALYSIS (100% Flat — Matching Image 4) -->
      <div class="flat-section bordered-top">
        <h3 class="sec-title">Trades analysis</h3>

        <div class="pill-bar">
          {#each [
            { id: 'distribution', label: 'Distribution' },
            { id: 'streaks', label: 'Streaks' },
            { id: 'time', label: 'Time patterns' },
            { id: 'excursions', label: 'Trades excursions' }
          ] as tab (tab.id)}
            <button
              class="tv-pill-tab"
              class:active={tradesSubTab === tab.id}
              type="button"
              onclick={() => (tradesSubTab = tab.id as typeof tradesSubTab)}
            >
              {tab.label}
            </button>
          {/each}
        </div>

        {#if tradesSubTab === 'distribution'}
          <div class="flat-metrics-4">
            <div class="fm-col">
              <span class="fm-lbl">Expectancy</span>
              <span
                class="fm-val"
                class:pos={activeMetrics.expectancyUsd > 0.004}
                class:neg={activeMetrics.expectancyUsd < -0.004}
              >
                {formatUsd(activeMetrics.expectancyUsd, true)}<small>USD</small>
                <span class="fm-sub">
                  {fmtSignedPct(activeMetrics.expectancyPct)}
                  {#if activeMetrics.expectancyR !== null}
                    · {activeMetrics.expectancyR >= 0 ? '+' : ''}{activeMetrics.expectancyR.toFixed(2)}R
                  {/if}
                </span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Outliers PnL</span>
              <span class="fm-val">
                {formatUsd(activeMetrics.outliersPnlUsd, true)}<small>USD</small>
                <span class="fm-sub">{activeMetrics.outliersPnlPct.toFixed(2)}%</span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Largest profit</span>
              <span class="fm-val pos">
                {formatUsd(activeMetrics.largestWinUsd, true)}<small>USD</small>
                <span class="fm-sub">{fmtSignedPct(activeMetrics.largestWinPct)}</span>
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Largest loss</span>
              <span class="fm-val neg">
                {formatUsd(activeMetrics.largestLossUsd, true)}<small>USD</small>
                <span class="fm-sub">{fmtSignedPct(activeMetrics.largestLossPct)}</span>
              </span>
            </div>
          </div>

          <!-- Side-by-side Returns Distribution Histogram + Trades Distribution Donut -->
          <div class="dist-two-col">
            <div class="dist-left">
              <div class="sub-sec-title">Returns distribution</div>
              {#if histGeom}
                <div class="hist-box">
                  <div class="hist-bars">
                    {#each histGeom.buckets as b, i (b.label)}
                      {@const hPct = b.count > 0 ? Math.max(8, (b.count / histGeom.maxCnt) * 100) : 0}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div
                        class="hb-col"
                        onmouseenter={() => (hoverHistIdx = i)}
                        onmouseleave={() => (hoverHistIdx = null)}
                      >
                        <div class="hb-track">
                          {#if b.count > 0}
                            <div
                              class="hb-fill"
                              class:pos={b.isPositive}
                              class:neg={!b.isPositive}
                              class:hovered={hoverHistIdx === i}
                              style:height="{hPct.toFixed(0)}%"
                              title="{b.minPct}% to {b.maxPct}%: {b.count} trades"
                            ></div>
                          {/if}
                        </div>
                        <span class="hb-lbl">{b.label}</span>
                      </div>
                    {/each}
                  </div>
                  <div class="hist-foot">
                    <span class="hf-leg"><span class="dot-sm neg"></span> Losers</span>
                    <span class="hf-leg"><span class="dot-sm pos"></span> Winners</span>
                    <span class="hf-avg neg">
                      ⋯ Avg loss {activeMetrics.avgLossPct.toFixed(2)}%
                    </span>
                    <span class="hf-avg pos">
                      ⋯ Avg profit +{activeMetrics.avgWinPct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              {:else}
                <div class="empty-flat">No trade returns to chart.</div>
              {/if}
            </div>

            <div class="dist-right">
              <div class="sub-sec-title">Trades distribution</div>
              <div class="donut-row">
                <svg class="donut-svg" viewBox="0 0 132 132" aria-label="Win/Loss donut chart">
                  <circle cx="66" cy="66" r={donutGeom.R} class="donut-track" />
                  {#if activeMetrics.totalTrades > 0}
                    <circle
                      cx="66"
                      cy="66"
                      r={donutGeom.R}
                      class="donut-seg win"
                      stroke-dasharray="{donutGeom.winLen} {donutGeom.C}"
                      stroke-dashoffset="0"
                    />
                    <circle
                      cx="66"
                      cy="66"
                      r={donutGeom.R}
                      class="donut-seg loss"
                      stroke-dasharray="{donutGeom.lossLen} {donutGeom.C}"
                      stroke-dashoffset={donutGeom.lossOffset}
                    />
                    {#if activeMetrics.breakevenTrades > 0}
                      <circle
                        cx="66"
                        cy="66"
                        r={donutGeom.R}
                        class="donut-seg be"
                        stroke-dasharray="{donutGeom.beLen} {donutGeom.C}"
                        stroke-dashoffset={donutGeom.beOffset}
                      />
                    {/if}
                  {/if}
                  <text x="66" y="63" text-anchor="middle" class="donut-num">
                    {activeMetrics.totalTrades}
                  </text>
                  <text x="66" y="79" text-anchor="middle" class="donut-sub">Total trades</text>
                </svg>

                <div class="donut-legend">
                  <div class="dl-row">
                    <span class="dl-name"><span class="dot-sm pos"></span> Winners</span>
                    <span class="dl-cnt">{activeMetrics.winningTrades} trades</span>
                    <span class="dl-pct">{donutGeom.winPct.toFixed(2)}%</span>
                  </div>
                  <div class="dl-row">
                    <span class="dl-name"><span class="dot-sm neg"></span> Losers</span>
                    <span class="dl-cnt">{activeMetrics.losingTrades} trades</span>
                    <span class="dl-pct">{donutGeom.lossPct.toFixed(2)}%</span>
                  </div>
                  <div class="dl-row">
                    <span class="dl-name"><span class="dot-sm be"></span> Breakevens</span>
                    <span class="dl-cnt">{activeMetrics.breakevenTrades} trades</span>
                    <span class="dl-pct">{donutGeom.bePct.toFixed(2)}%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        {:else if tradesSubTab === 'streaks'}
          <div class="flat-metrics-4">
            <div class="fm-col">
              <span class="fm-lbl">Max winning streak</span>
              <span class="fm-val pos">{activeMetrics.maxWinStreak}</span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Max losing streak</span>
              <span class="fm-val neg">{activeMetrics.maxLossStreak}</span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg winning streak</span>
              <span class="fm-val">{activeMetrics.avgWinStreak.toFixed(2)}</span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg losing streak</span>
              <span class="fm-val">{activeMetrics.avgLossStreak.toFixed(2)}</span>
            </div>
          </div>
          {#if activeMetrics.streakDist.length > 0}
            {@const maxS = Math.max(1, ...activeMetrics.streakDist.map((s) => Math.max(s.winStreaks, s.lossStreaks)))}
            <div class="streak-list">
              {#each activeMetrics.streakDist as sd (sd.length)}
                <div class="streak-row">
                  <span class="sk-lbl">{sd.length} in a row</span>
                  <div class="sk-bars">
                    <div class="sk-bar pos" style:width="{(sd.winStreaks / maxS) * 100}%">
                      {#if sd.winStreaks > 0}<span>{sd.winStreaks}W</span>{/if}
                    </div>
                    <div class="sk-bar neg" style:width="{(sd.lossStreaks / maxS) * 100}%">
                      {#if sd.lossStreaks > 0}<span>{sd.lossStreaks}L</span>{/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {:else if tradesSubTab === 'time'}
          <div class="sub-sec-title">Performance by Entry Hour (UTC)</div>
          {@const maxHr = Math.max(1, ...activeMetrics.byHourUtc.map((h) => Math.abs(h.pnlUsd)))}
          <div class="hour-grid">
            {#each activeMetrics.byHourUtc as h (h.key)}
              {@const hPct = h.trades > 0 ? Math.max(8, (Math.abs(h.pnlUsd) / maxHr) * 100) : 0}
              <div
                class="hr-col"
                title="{h.label} UTC · {h.trades} trades · WR {h.winRatePct}% · {formatUsd(h.pnlUsd, true)} USD"
              >
                <div class="hr-track">
                  {#if h.trades > 0}
                    <div
                      class="hr-bar"
                      class:pos={h.pnlUsd >= 0}
                      class:neg={h.pnlUsd < 0}
                      style:height="{hPct.toFixed(0)}%"
                    ></div>
                  {/if}
                </div>
                <span class="hr-lbl">{String(h.key).padStart(2, '0')}</span>
              </div>
            {/each}
          </div>

          <div class="sub-sec-title" style="margin-top:16px">Performance by Day of Week (UTC)</div>
          <div class="dow-strip">
            {#each activeMetrics.byDayOfWeek.filter((d) => d.trades > 0) as d (d.key)}
              <div class="dow-col">
                <span class="dow-name">{d.label}</span>
                <span class="dow-pnl" class:pos={d.pnlUsd > 0} class:neg={d.pnlUsd < 0}>
                  {formatUsd(d.pnlUsd, true)}
                </span>
                <span class="dow-sub">{d.trades}t · {d.winRatePct.toFixed(0)}% WR</span>
              </div>
            {/each}
          </div>
        {:else if tradesSubTab === 'excursions'}
          <div class="flat-metrics-4">
            <div class="fm-col">
              <span class="fm-lbl">Avg MFE (Max Favorable)</span>
              <span class="fm-val pos">
                +{activeMetrics.avgMfePct.toFixed(2)}%
                {#if activeMetrics.avgMfeR !== null}
                  <span class="fm-sub">+{activeMetrics.avgMfeR.toFixed(2)}R</span>
                {/if}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Avg MAE (Max Adverse)</span>
              <span class="fm-val neg">
                {activeMetrics.avgMaePct.toFixed(2)}%
                {#if activeMetrics.avgMaeR !== null}
                  <span class="fm-sub">{activeMetrics.avgMaeR.toFixed(2)}R</span>
                {/if}
              </span>
            </div>
            <div class="fm-col">
              <span class="fm-lbl">Payoff Ratio (Avg W / Avg L)</span>
              <span class="fm-val">
                {activeMetrics.payoffRatio !== null ? `${activeMetrics.payoffRatio.toFixed(2)}x` : '—'}
              </span>
            </div>
          </div>

          {#if activeMetrics.excursions.length > 0}
            {@const maxEx = Math.max(0.5, ...activeMetrics.excursions.map((e) => Math.max(Math.abs(e.mfePct), Math.abs(e.maePct))))}
            <div class="exc-list">
              {#each activeMetrics.excursions.slice(-45) as ex (ex.tradeNumber)}
                <div
                  class="exc-col"
                  title="Trade #{ex.tradeNumber} ({ex.side}) · MFE +{ex.mfePct}% · MAE {ex.maePct}% · Realized {formatUsd(ex.netPnlUsd, true)} USD"
                >
                  <div class="exc-up">
                    <div class="exc-mfe" style:height="{(Math.max(0, ex.mfePct) / maxEx) * 100}%"></div>
                  </div>
                  <div class="exc-dn">
                    <div class="exc-mae" style:height="{(Math.abs(Math.min(0, ex.maePct)) / maxEx) * 100}%"></div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {:else}
      <!-- ── LIST OF TRADES VIEW (Exact 2-Row TradingView Table — Image 5) ─── -->
      <div class="trades-view">
        <div class="tv-trades-head">
          <h3 class="sec-title">List of trades</h3>
          <div class="tv-trades-acts">
            <button
              class="tb-icon-btn"
              type="button"
              title="Export trades as CSV"
              aria-label="Export CSV"
              onclick={() => exportStrategyTradesCsv(report)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.6v7.4M5.2 7.3 8 10.1l2.8-2.8M3 13.2h10" />
              </svg>
            </button>

            <div class="tb-anchor" data-st-menu>
              <button
                class="tb-icon-btn"
                type="button"
                title="Columns"
                aria-label="Columns"
                onclick={() => {
                  const next = !colsMenuOpen;
                  closeAllMenus();
                  colsMenuOpen = next;
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2.2" y="3" width="2.4" height="10" rx="0.5" />
                  <rect x="6.8" y="3" width="2.4" height="10" rx="0.5" />
                  <rect x="11.4" y="3" width="2.4" height="10" rx="0.5" />
                </svg>
              </button>
              {#if colsMenuOpen}
                <div class="st-menu right">
                  <label class="col-chk">
                    <input type="checkbox" bind:checked={showColSegment} />
                    <span>IS / OOS Badge</span>
                  </label>
                  <label class="col-chk">
                    <input type="checkbox" bind:checked={showColR} />
                    <span>R-Multiple</span>
                  </label>
                </div>
              {/if}
            </div>
          </div>
        </div>

        {#if visibleTrades.length === 0}
          <div class="empty-flat">No trades recorded in this view.</div>
        {:else}
          <div class="trades-table-wrap">
            <table class="tv-trades-table">
              <thead>
                <tr>
                  <th>
                    <button
                      class="sort-btn"
                      type="button"
                      onclick={() => (tradesSortDesc = !tradesSortDesc)}
                    >
                      Trade number {tradesSortDesc ? '↓' : '↑'}
                    </button>
                  </th>
                  <th>Type</th>
                  <th>Date and time</th>
                  <th class="num">Price</th>
                  <th class="num">Size</th>
                  <th class="num">Net PnL</th>
                  <th class="num">Return</th>
                </tr>
              </thead>
              <tbody>
                {#each visibleTrades as tr (tr.tradeNumber)}
                  <!-- Top Row: Exit -->
                  <tr class="tr-exit">
                    <td rowspan="2" class="td-num">
                      <div class="tn-wrap">
                        <span class="tn-idx">{tr.tradeNumber}</span>
                        <span
                          class="tn-side"
                          class:long={tr.side === 'long'}
                          class:short={tr.side === 'short'}
                        >
                          {tr.side === 'long' ? 'Long' : 'Short'}
                        </span>
                        {#if showColSegment}
                          <span class="tn-seg" class:oos={tr.segment === 'OOS'}>{tr.segment}</span>
                        {/if}
                        <button
                          class="tn-focus"
                          type="button"
                          title="Focus {spec.shortName} on chart"
                          onclick={() => onSelectSymbol(spec.symbol, spec.shortName)}
                        >
                          ⌖
                        </button>
                      </div>
                    </td>
                    <td>
                      <span class="type-main">Exit</span>
                      <span class="type-sub">{exitReasonLabel(tr.exitReason)}</span>
                    </td>
                    <td class="ts-cell">{fmtTradeTs(tr.exitTs)}</td>
                    <td class="num">
                      {formatPaperPrice(tr.exitPrice, spec.symbol)} <small>USD</small>
                    </td>
                    <td rowspan="2" class="num td-size">
                      <div class="sz-qty">{formatQty(tr.quantity)}</div>
                      <div class="sz-notional">{fmtCompactUsd(tr.notionalUsd)} <small>USD</small></div>
                    </td>
                    <td
                      rowspan="2"
                      class="num bold td-pnl"
                      class:pos={tr.netPnlUsd > 0.004}
                      class:neg={tr.netPnlUsd < -0.004}
                    >
                      <div>{formatUsd(tr.netPnlUsd, true)} <small>USD</small></div>
                      <div class="cost-sub">
                        cost -${(tr.spreadCostUsd + tr.slippageCostUsd + tr.commissionUsd).toFixed(2)}
                      </div>
                    </td>
                    <td
                      rowspan="2"
                      class="num td-ret"
                      class:pos={tr.returnPct > 0.004}
                      class:neg={tr.returnPct < -0.004}
                    >
                      <div>{fmtSignedPct(tr.returnPct)}</div>
                      {#if showColR && tr.realizedR !== null}
                        <div class="r-sub">{tr.realizedR >= 0 ? '+' : ''}{tr.realizedR.toFixed(2)}R</div>
                      {/if}
                    </td>
                  </tr>
                  <!-- Bottom Row: Entry -->
                  <tr class="tr-entry">
                    <td><span class="type-main muted">Entry</span></td>
                    <td class="ts-cell muted">{fmtTradeTs(tr.entryTs)}</td>
                    <td class="num muted">
                      {formatPaperPrice(tr.entryPrice, spec.symbol)} <small>USD</small>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .st-root {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
    font-size: 12.5px;
    overflow: hidden;
  }

  .st-root.light {
    background: #ffffff;
    color: #131722;
  }

  /* ── Sub-Toolbar ────────────────────────────────────────────────────────── */
  .st-toolbar {
    flex: 0 0 auto;
    min-height: 40px;
    padding: 5px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  .st-root.light .st-toolbar {
    border-bottom-color: #eceff4;
  }

  .tb-left,
  .tb-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .view-switch {
    display: inline-flex;
    padding: 2px;
    border-radius: 7px;
    background: var(--dark-bg-surface-alt);
    gap: 2px;
  }

  .st-root.light .view-switch {
    background: #f0f3fa;
  }

  .vs-btn {
    width: 26px;
    height: 24px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .vs-btn.active {
    background: var(--dark-bg-elevated);
    color: var(--dark-text-strong);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }

  .st-root.light .vs-btn.active {
    background: #ffffff;
    color: #131722;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .vs-btn svg,
  .tb-ico,
  .tb-icon-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .tb-anchor {
    position: relative;
  }

  .tb-pill {
    height: 28px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }

  .tb-pill:hover {
    background: var(--dark-hover-strong);
  }

  .st-root.light .tb-pill:hover {
    background: #f0f3fa;
  }

  .tb-pill small {
    font-size: 10px;
    opacity: 0.7;
  }

  .cap-circle {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1.3px solid currentColor;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
  }

  .data-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #f59e0b;
  }

  .data-dot.oanda {
    background: #089981;
  }

  .chev {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    opacity: 0.65;
  }

  .tb-sep {
    width: 1px;
    height: 16px;
    background: var(--dark-border);
    margin: 0 2px;
  }

  .st-root.light .tb-sep {
    background: #e0e3eb;
  }

  .tb-icon-btn {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .tb-icon-btn:hover,
  .tb-icon-btn.active {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .st-root.light .tb-icon-btn:hover,
  .st-root.light .tb-icon-btn.active {
    background: #f0f3fa;
    color: #131722;
  }

  .tb-fwd-btn {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--dark-border-control);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }

  .tb-fwd-btn:hover {
    background: var(--dark-hover-strong);
  }

  .st-root.light .tb-fwd-btn {
    border-color: #d6dae1;
  }

  .st-root.light .tb-fwd-btn:hover {
    background: #f0f3fa;
  }

  .tb-fwd-btn.live {
    border-color: rgba(8, 153, 129, 0.55);
    color: #089981;
  }

  .tb-fwd-btn.paused {
    border-color: rgba(245, 158, 11, 0.55);
    color: #f59e0b;
  }

  .fwd-pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #089981;
    box-shadow: 0 0 0 3px rgba(8, 153, 129, 0.22);
  }

  .fwd-dot.paused {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
  }

  .running-chip {
    font-size: 11px;
    color: var(--dark-text-secondary);
    padding: 2px 7px;
    border-radius: 99px;
    background: var(--dark-bg-surface-alt);
  }

  .scope-pills {
    display: inline-flex;
    padding: 2px;
    border-radius: 6px;
    background: var(--dark-bg-surface-alt);
    gap: 2px;
  }

  .st-root.light .scope-pills {
    background: #f0f3fa;
  }

  .sc-btn {
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .sc-btn.active {
    background: var(--dark-bg-elevated);
    color: var(--dark-text-strong);
    font-weight: 600;
  }

  .st-root.light .sc-btn.active {
    background: #ffffff;
    color: #131722;
  }

  .verdict-pill {
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
  }

  .verdict-pill.pass {
    background: rgba(8, 153, 129, 0.16);
    color: #089981;
  }

  .verdict-pill.marginal {
    background: rgba(245, 158, 11, 0.16);
    color: #f59e0b;
  }

  .verdict-pill.fail {
    background: rgba(242, 54, 69, 0.16);
    color: #f23645;
  }

  /* Dropdown Menus */
  .st-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 210px;
    padding: 6px;
    border-radius: 8px;
    background: var(--dark-bg-elevated);
    border: 1px solid var(--dark-border-control);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .st-menu.right {
    left: auto;
    right: 0;
    min-width: 170px;
  }

  .st-menu.wide {
    min-width: 280px;
  }

  .st-menu.fwd-pop {
    min-width: 300px;
    padding: 10px;
    gap: 8px;
  }

  .st-root.light .st-menu {
    background: #ffffff;
    border-color: #d6dae1;
    box-shadow: 0 10px 26px rgba(19, 23, 34, 0.14);
  }

  .st-menu-lbl {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--dark-text-secondary);
    padding: 4px 7px;
  }

  .st-menu-item {
    border: 0;
    border-radius: 5px;
    padding: 6px 8px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    text-align: left;
    cursor: pointer;
  }

  .st-menu-item:hover {
    background: var(--dark-hover-strong);
  }

  .st-root.light .st-menu-item:hover {
    background: #f0f3fa;
  }

  .st-menu-item.active {
    font-weight: 600;
    color: #089981;
  }

  .m-sub {
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .st-menu-note {
    font-size: 10.5px;
    color: var(--dark-text-secondary);
    padding: 6px 8px 2px;
    border-top: 1px solid var(--dark-border-subtle);
    line-height: 1.4;
  }

  .fwd-desc {
    margin: 0;
    font-size: 11.5px;
    color: var(--dark-text-secondary);
    line-height: 1.45;
  }

  .fwd-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .fwd-field select,
  .fwd-field input {
    height: 28px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12px;
  }

  .st-root.light .fwd-field select,
  .st-root.light .fwd-field input {
    background: #f8f9fc;
    border-color: #d6dae1;
    color: #131722;
  }

  .fwd-start-btn {
    height: 30px;
    border: 0;
    border-radius: 6px;
    background: #089981;
    color: #ffffff;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .fwd-start-btn:hover {
    filter: brightness(1.08);
  }

  .fwd-status-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 0;
  }

  .fs-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    gap: 8px;
  }

  .fs-warn {
    font-size: 11px;
    color: #f59e0b;
    padding: 4px 6px;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.12);
  }

  .link-btn {
    border: 0;
    background: transparent;
    color: #2962ff;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .mini-seg {
    display: inline-flex;
    border-radius: 5px;
    background: var(--dark-bg-base);
    padding: 2px;
  }

  .mini-seg button {
    border: 0;
    border-radius: 4px;
    padding: 2px 7px;
    background: transparent;
    color: var(--dark-text-secondary);
    font-size: 11px;
    cursor: pointer;
  }

  .mini-seg button.active {
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-strong);
    font-weight: 600;
  }

  .fwd-actions {
    display: flex;
    gap: 6px;
  }

  .fwd-act {
    flex: 1;
    height: 28px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .fwd-act.primary {
    background: #089981;
    border-color: #089981;
    color: #fff;
  }

  .fwd-act.danger {
    border-color: rgba(242, 54, 69, 0.4);
    color: #f23645;
  }

  /* ── Error & Signal Bars ────────────────────────────────────────────────── */
  .st-error-bar {
    padding: 7px 14px;
    background: rgba(242, 54, 69, 0.14);
    color: #f23645;
    font-size: 12px;
  }

  .signal-banner {
    padding: 7px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: rgba(41, 98, 255, 0.12);
    border-bottom: 1px solid rgba(41, 98, 255, 0.25);
    font-size: 12px;
  }

  .sig-left,
  .sig-acts {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .sig-tag {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 700;
    background: var(--dark-bg-elevated);
  }

  .sig-tag.buy {
    background: rgba(8, 153, 129, 0.2);
    color: #089981;
  }

  .sig-tag.sell {
    background: rgba(242, 54, 69, 0.2);
    color: #f23645;
  }

  .sig-btn {
    height: 24px;
    padding: 0 9px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .sig-btn.ok {
    background: #089981;
    border-color: #089981;
    color: #fff;
  }

  /* ── Inline Properties Drawer ───────────────────────────────────────────── */
  .props-drawer {
    flex: 0 0 auto;
    padding: 12px 18px;
    border-bottom: 1px solid var(--dark-border);
    background: var(--dark-bg-surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .st-root.light .props-drawer {
    background: #f8f9fc;
    border-bottom-color: #e0e3eb;
  }

  .props-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .props-title {
    font-size: 13px;
    font-weight: 700;
    margin-right: 10px;
  }

  .props-sub {
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .props-close {
    width: 24px;
    height: 24px;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
  }

  .rules-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .props-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(135px, 1fr));
    gap: 8px 12px;
  }

  .pf {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .pf input,
  .pf select {
    height: 27px;
    padding: 0 7px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12px;
  }

  .st-root.light .pf input,
  .st-root.light .pf select {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .props-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 4px;
  }

  .props-acts {
    display: flex;
    gap: 8px;
  }

  .pf-btn {
    height: 28px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .pf-btn.primary {
    background: var(--dark-text-strong);
    color: var(--dark-bg-base);
    border-color: transparent;
  }

  .st-root.light .pf-btn.primary {
    background: #131722;
    color: #ffffff;
  }

  /* ── MAIN SCROLL BODY (100% FLAT TRADINGVIEW AESTHETIC — NO CARDS!) ─────── */
  .st-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 22px 28px;
    display: flex;
    flex-direction: column;
    gap: 26px;
  }

  .flat-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .flat-section.bordered-top {
    padding-top: 22px;
    border-top: 1px solid var(--dark-border-subtle);
  }

  .st-root.light .flat-section.bordered-top {
    border-top-color: #eceff4;
  }

  .sec-head-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .sec-title {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .sec-meta {
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .sub-sec-title {
    font-size: 13px;
    font-weight: 600;
  }

  /* Key stats — clean borderless 4-column TradingView layout */
  .key-stats-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(140px, 1fr));
    gap: 14px 22px;
  }

  @media (max-width: 820px) {
    .key-stats-row {
      grid-template-columns: repeat(2, minmax(140px, 1fr));
    }
  }

  .ks-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ks-lbl {
    font-size: 12px;
    color: var(--dark-text-secondary);
  }

  .ks-val {
    display: flex;
    align-items: baseline;
    gap: 7px;
    flex-wrap: wrap;
    font-size: 15.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .ks-val small {
    font-size: 10.5px;
    font-weight: 500;
    margin-left: 2px;
    opacity: 0.78;
  }

  .ks-pct,
  .ks-count {
    font-size: 13.5px;
    font-weight: 500;
  }

  .ks-count {
    color: var(--dark-text-secondary);
  }

  .ks-oos-tag {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
  }

  .st-root.light .ks-oos-tag {
    background: #f0f3fa;
  }

  /* Performance / Drawdown Chart */
  .chart-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .seg-tabs {
    display: inline-flex;
    padding: 2px;
    border-radius: 7px;
    background: var(--dark-bg-surface-alt);
    gap: 2px;
  }

  .st-root.light .seg-tabs {
    background: #f0f3fa;
  }

  .seg-btn {
    height: 26px;
    padding: 0 12px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .seg-tabs.small .seg-btn {
    height: 24px;
    padding: 0 10px;
    font-size: 11.5px;
  }

  .seg-btn.active {
    background: var(--dark-bg-elevated);
    color: var(--dark-text-strong);
    font-weight: 600;
  }

  .st-root.light .seg-btn.active {
    background: #ffffff;
    color: #131722;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .chart-hover-bar {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .seg-chip {
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    background: var(--dark-bg-surface-alt);
  }

  .chart-legend {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .leg-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .leg-toggle {
    border: 0;
    background: transparent;
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 11.5px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 0;
  }

  .leg-toggle.off {
    opacity: 0.45;
    text-decoration: line-through;
  }

  .leg-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #089981;
  }

  .leg-dot.neg {
    background: #f23645;
  }

  .leg-dot.bh {
    background: #8c8c8c;
  }

  .oos-dash-ico {
    width: 12px;
    height: 0;
    border-top: 1.5px dashed #787b86;
  }

  .chart-wrap {
    width: 100%;
  }

  .tv-chart-svg {
    width: 100%;
    height: 205px;
    display: block;
  }

  .grid-line {
    stroke: var(--dark-border-subtle);
    stroke-width: 0.8;
  }

  .st-root.light .grid-line {
    stroke: #f0f3fa;
  }

  .zero-line {
    stroke: var(--dark-border-strong);
    stroke-width: 1;
  }

  .st-root.light .zero-line {
    stroke: #cfd4de;
  }

  .oos-shade {
    fill: rgba(255, 255, 255, 0.025);
  }

  .st-root.light .oos-shade {
    fill: rgba(19, 23, 34, 0.03);
  }

  .oos-line {
    stroke: #787b86;
    stroke-width: 1;
    stroke-dasharray: 4 3;
  }

  .oos-lbl {
    font-size: 9.5px;
    font-weight: 600;
    fill: #787b86;
  }

  .bh-line {
    fill: none;
    stroke: #8c8c8c;
    stroke-width: 1.25;
    stroke-dasharray: 4 3;
    opacity: 0.72;
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
    fill: rgba(8, 153, 129, 0.14);
  }

  .eq-area.down {
    fill: rgba(242, 54, 69, 0.14);
  }

  .eq-dot.up {
    fill: #089981;
  }

  .eq-dot.down {
    fill: #f23645;
  }

  .crosshair-line {
    stroke: var(--dark-text-secondary);
    stroke-width: 1;
    stroke-dasharray: 2 2;
    opacity: 0.6;
  }

  .last-tag-bg.up {
    fill: #089981;
  }

  .last-tag-bg.down {
    fill: #f23645;
  }

  .last-tag-txt {
    font-size: 10px;
    font-weight: 600;
    fill: #ffffff;
    font-variant-numeric: tabular-nums;
  }

  .ax-lbl {
    font-size: 10px;
    fill: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* Pill Tab Bars (Performance analysis & Trades analysis — matching Image 4) */
  .pill-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .tv-pill-tab {
    height: 28px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .st-root.light .tv-pill-tab {
    background: #f0f3fa;
    color: #434651;
  }

  .tv-pill-tab.active {
    background: var(--dark-text-strong);
    color: var(--dark-bg-base);
    font-weight: 600;
  }

  .st-root.light .tv-pill-tab.active {
    background: #131722;
    color: #ffffff;
  }

  .flat-metrics-4 {
    display: grid;
    grid-template-columns: repeat(4, minmax(135px, 1fr));
    gap: 14px 20px;
  }

  @media (max-width: 820px) {
    .flat-metrics-4 {
      grid-template-columns: repeat(2, minmax(135px, 1fr));
    }
  }

  .fm-col {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .fm-lbl {
    font-size: 12px;
    color: var(--dark-text-secondary);
  }

  .fm-val {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .fm-val.fm-tight {
    font-size: 12.5px;
  }

  .fm-val small {
    font-size: 10px;
    font-weight: 500;
    margin-left: 2px;
    opacity: 0.72;
  }

  .fm-sub {
    font-size: 12px;
    font-weight: 500;
    color: var(--dark-text-secondary);
    margin-left: 5px;
  }

  /* Profits and losses flat bars */
  .pl-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
  }

  .pl-bars-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pl-bar-row {
    display: grid;
    grid-template-columns: 150px 1fr 110px;
    align-items: center;
    gap: 14px;
    font-size: 12px;
  }

  .pl-lbl {
    color: var(--dark-text-secondary);
  }

  .pl-track {
    height: 7px;
    border-radius: 99px;
    background: var(--dark-bg-surface-alt);
    display: flex;
    overflow: hidden;
  }

  .st-root.light .pl-track {
    background: #f0f3fa;
  }

  .pl-loss {
    background: rgba(242, 54, 69, 0.72);
    height: 100%;
  }

  .pl-prof {
    background: #089981;
    height: 100%;
  }

  .pl-net {
    text-align: right;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .pl-net small {
    font-size: 10px;
    font-weight: 500;
    opacity: 0.72;
  }

  /* Periodical monthly bars */
  .periodical-bars {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    overflow-x: auto;
    padding: 8px 0 4px;
  }

  .pm-col {
    min-width: 58px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }

  .pm-val {
    font-size: 11px;
    font-weight: 600;
  }

  .pm-bar-zone {
    width: 28px;
    height: 82px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .pm-bar {
    width: 100%;
    border-radius: 3px 3px 0 0;
  }

  .pm-bar.pos {
    background: #089981;
  }

  .pm-bar.neg {
    background: #f23645;
  }

  .pm-ym {
    font-size: 11px;
    color: var(--dark-text-strong);
  }

  .pm-cnt {
    font-size: 10px;
    color: var(--dark-text-secondary);
  }

  /* Trades Analysis: Distribution (Histogram + Donut Ring) */
  .dist-two-col {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
    gap: 28px;
    align-items: start;
    padding-top: 6px;
  }

  @media (max-width: 860px) {
    .dist-two-col {
      grid-template-columns: 1fr;
    }
  }

  .dist-left,
  .dist-right {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .hist-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .hist-bars {
    height: 116px;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    border-bottom: 1px solid var(--dark-border-subtle);
    padding-bottom: 4px;
  }

  .hb-col {
    flex: 1;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .hb-track {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
  }

  .hb-fill {
    width: 100%;
    border-radius: 2px 2px 0 0;
    transition: opacity 0.12s;
  }

  .hb-fill.pos {
    background: #089981;
  }

  .hb-fill.neg {
    background: #f23645;
  }

  .hb-fill.hovered {
    filter: brightness(1.15);
  }

  .hb-lbl {
    font-size: 9.5px;
    color: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .hist-foot {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .hf-leg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .hf-avg {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .dot-sm {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }

  .dot-sm.pos {
    background: #089981;
  }

  .dot-sm.neg {
    background: #f23645;
  }

  .dot-sm.be {
    background: #f59e0b;
  }

  /* Donut Ring */
  .donut-row {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }

  .donut-svg {
    width: 132px;
    height: 132px;
    flex: 0 0 132px;
  }

  .donut-track {
    fill: none;
    stroke: var(--dark-bg-surface-alt);
    stroke-width: 18;
  }

  .st-root.light .donut-track {
    stroke: #f0f3fa;
  }

  .donut-seg {
    fill: none;
    stroke-width: 18;
    transform: rotate(-90deg);
    transform-origin: 66px 66px;
  }

  .donut-seg.win {
    stroke: #089981;
  }

  .donut-seg.loss {
    stroke: #f23645;
  }

  .donut-seg.be {
    stroke: #f59e0b;
  }

  .donut-num {
    font-size: 18px;
    font-weight: 700;
    fill: var(--dark-text-strong);
    font-variant-numeric: tabular-nums;
  }

  .st-root.light .donut-num {
    fill: #131722;
  }

  .donut-sub {
    font-size: 10.5px;
    fill: var(--dark-text-secondary);
  }

  .donut-legend {
    flex: 1;
    min-width: 175px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .dl-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    align-items: center;
  }

  .dl-name {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .dl-cnt {
    color: var(--dark-text-secondary);
  }

  .dl-pct {
    font-weight: 600;
    min-width: 52px;
    text-align: right;
  }

  /* Streaks, Time Patterns & Excursions */
  .streak-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .streak-row {
    display: grid;
    grid-template-columns: 90px 1fr;
    align-items: center;
    gap: 10px;
    font-size: 11.5px;
  }

  .sk-lbl {
    color: var(--dark-text-secondary);
  }

  .sk-bars {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .sk-bar {
    height: 16px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    min-width: 2px;
  }

  .sk-bar.pos {
    background: #089981;
  }

  .sk-bar.neg {
    background: #f23645;
  }

  .hour-grid {
    display: grid;
    grid-template-columns: repeat(24, minmax(12px, 1fr));
    gap: 3px;
    height: 92px;
    align-items: end;
  }

  .hr-col {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .hr-track {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
  }

  .hr-bar {
    width: 100%;
    border-radius: 2px 2px 0 0;
  }

  .hr-bar.pos {
    background: #089981;
  }

  .hr-bar.neg {
    background: #f23645;
  }

  .hr-lbl {
    font-size: 9px;
    color: var(--dark-text-secondary);
  }

  .dow-strip {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
  }

  .dow-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-variant-numeric: tabular-nums;
  }

  .dow-name {
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .dow-pnl {
    font-size: 13.5px;
    font-weight: 600;
  }

  .dow-sub {
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .exc-list {
    height: 110px;
    display: flex;
    align-items: stretch;
    gap: 3px;
    padding: 6px 0;
  }

  .exc-col {
    flex: 1;
    max-width: 16px;
    display: flex;
    flex-direction: column;
  }

  .exc-up,
  .exc-dn {
    flex: 1;
    display: flex;
  }

  .exc-up {
    align-items: flex-end;
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  .exc-dn {
    align-items: flex-start;
  }

  .exc-mfe {
    width: 100%;
    background: rgba(8, 153, 129, 0.8);
    border-radius: 2px 2px 0 0;
  }

  .exc-mae {
    width: 100%;
    background: rgba(242, 54, 69, 0.8);
    border-radius: 0 0 2px 2px;
  }

  /* Flat Tables (Iterations + List of trades — Image 5) */
  .iter-wrap,
  .trades-table-wrap {
    overflow-x: auto;
  }

  .flat-table,
  .tv-trades-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .flat-table th,
  .tv-trades-table th {
    text-align: left;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--dark-text-secondary);
    padding: 7px 10px;
    border-bottom: 1px solid var(--dark-border-subtle);
    white-space: nowrap;
  }

  .st-root.light .flat-table th,
  .st-root.light .tv-trades-table th {
    border-bottom-color: #eceff4;
  }

  .flat-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--dark-border-subtle);
    font-size: 12px;
  }

  .oos-row td {
    background: rgba(255, 255, 255, 0.025);
  }

  .st-root.light .oos-row td {
    background: #f8f9fc;
  }

  .iter-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
  }

  .iter-badge.kept {
    background: rgba(8, 153, 129, 0.16);
    color: #089981;
  }

  .iter-badge.bad {
    background: rgba(242, 54, 69, 0.16);
    color: #f23645;
  }

  /* List of Trades (2-Row Stacked Exit/Entry — Image 5) */
  .trades-view {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tv-trades-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .tv-trades-acts {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .sort-btn {
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
  }

  .tv-trades-table td {
    padding: 6px 10px;
    font-size: 12.5px;
    vertical-align: middle;
  }

  .tr-exit td {
    padding-top: 10px;
    padding-bottom: 3px;
  }

  .tr-entry td {
    padding-top: 3px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  .st-root.light .tr-entry td {
    border-bottom-color: #eceff4;
  }

  .td-num,
  .td-size,
  .td-pnl,
  .td-ret {
    border-bottom: 1px solid var(--dark-border-subtle);
  }

  .st-root.light .td-num,
  .st-root.light .td-size,
  .st-root.light .td-pnl,
  .st-root.light .td-ret {
    border-bottom-color: #eceff4;
  }

  .tn-wrap {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .tn-idx {
    font-weight: 600;
    min-width: 18px;
  }

  .tn-side {
    font-weight: 600;
  }

  .tn-side.long {
    color: #089981;
  }

  .tn-side.short {
    color: #f23645;
  }

  .tn-seg {
    font-size: 9.5px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
  }

  .tn-seg.oos {
    background: rgba(41, 98, 255, 0.16);
    color: #5b8eff;
  }

  .tn-focus {
    border: 0;
    background: transparent;
    color: var(--dark-text-secondary);
    cursor: pointer;
    font-size: 13px;
    opacity: 0.55;
    padding: 0 2px;
  }

  .tn-focus:hover {
    opacity: 1;
    color: var(--dark-text-strong);
  }

  .type-main {
    font-weight: 500;
  }

  .type-sub {
    font-size: 11px;
    color: var(--dark-text-secondary);
    margin-left: 6px;
  }

  .ts-cell {
    white-space: nowrap;
  }

  .sz-notional,
  .cost-sub,
  .r-sub {
    font-size: 11px;
    font-weight: 500;
    color: var(--dark-text-secondary);
    margin-top: 2px;
  }

  .num {
    text-align: right;
  }

  .bold {
    font-weight: 600;
  }

  .pos {
    color: #089981;
  }

  .neg {
    color: #f23645;
  }

  .muted {
    color: var(--dark-text-secondary);
  }

  .empty-flat {
    padding: 18px 0;
    font-size: 12.5px;
    color: var(--dark-text-secondary);
  }

  .col-chk {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    font-size: 12px;
    cursor: pointer;
  }
</style>
