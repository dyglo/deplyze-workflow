<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    computeScorecardStats,
    createPinnedSignal,
    fetchDislocation,
    fetchDislocationScan,
    formatAgeCompact,
    formatRadarPrice,
    formatSigned,
    loadDislocationState,
    resolvePendingSignals,
    saveDislocationSnapshotToNotes,
    saveDislocationState,
    type DislocationPayload,
    type DislocationScanPayload,
    type DislocationTimeframe,
    type PinnedDislocationSignal,
    type VerdictKind
  } from '../dislocation/store';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onCreateAlertAtPrice: (symbol: string, shortName: string, price?: number) => void;
    onClose: () => void;
  }

  let {
    theme,
    activeSymbol,
    activeFullSymbol,
    onSelectSymbol,
    onCreateAlertAtPrice,
    onClose
  }: Props = $props();

  type TabId = 'symbol' | 'scanner' | 'scorecard';
  type ScanFilter = 'all' | 'dislocated' | 'smt';

  const TIMEFRAMES: { id: DislocationTimeframe; label: string }[] = [
    { id: '15m', label: '15m' },
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' }
  ];

  let activeTab = $state<TabId>('symbol');
  let timeframe = $state<DislocationTimeframe>('1h');
  let scanFilter = $state<ScanFilter>('all');

  let payload = $state<DislocationPayload | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let scanPayload = $state<DislocationScanPayload | null>(null);
  let scanLoading = $state(false);
  let scanError = $state<string | null>(null);

  let signals = $state<PinnedDislocationSignal[]>([]);
  let resolving = $state(false);
  let feedbackNotice = $state<string | null>(null);
  let hoveredIdx = $state<number | null>(null);
  let stateReady = $state(false);

  let symbolAbort: AbortController | null = null;
  let scanAbort: AbortController | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const targetFullSymbol = $derived(activeFullSymbol || activeSymbol || 'OANDA:XAUUSD');
  const scorecard = $derived(computeScorecardStats(signals));

  const filteredScanRows = $derived.by(() => {
    const rows = scanPayload?.rows ?? [];
    if (scanFilter === 'dislocated') {
      return rows.filter((r) => Math.abs(r.zScore) >= 1.5);
    }
    if (scanFilter === 'smt') {
      return rows.filter((r) => r.topSmtLabel !== null);
    }
    return rows;
  });

  const scanDislocatedCount = $derived(
    (scanPayload?.rows ?? []).filter((r) => Math.abs(r.zScore) >= 1.5).length
  );
  const scanSmtCount = $derived(
    (scanPayload?.rows ?? []).filter((r) => r.topSmtLabel !== null).length
  );

  // SVG Sparkline geometry (360 x 84 viewBox)
  const CHART_W = 360;
  const CHART_H = 84;
  const CHART_PAD_X = 6;
  const CHART_PAD_Y = 8;

  function zToY(z: number): number {
    const clamped = Math.max(-3.5, Math.min(3.5, z));
    const norm = (3.5 - clamped) / 7.0; // +3.5 at top, -3.5 at bottom
    return CHART_PAD_Y + norm * (CHART_H - CHART_PAD_Y * 2);
  }

  const sparklineCoords = $derived.by(() => {
    const pts = payload?.residualSeries ?? [];
    if (pts.length < 2) return [];
    const usableW = CHART_W - CHART_PAD_X * 2;
    return pts.map((p, idx) => ({
      x: CHART_PAD_X + (idx / (pts.length - 1)) * usableW,
      y: zToY(p.z),
      ...p
    }));
  });

  const sparklinePath = $derived.by(() => {
    if (sparklineCoords.length < 2) return '';
    return sparklineCoords
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
      .join(' ');
  });

  const hoveredPoint = $derived(
    hoveredIdx !== null && sparklineCoords[hoveredIdx] ? sparklineCoords[hoveredIdx] : null
  );

  function zMarkerLeftPct(z: number): number {
    const clamped = Math.max(-3, Math.min(3, z));
    return ((clamped + 3) / 6) * 100;
  }

  function verdictTone(v: VerdictKind): 'bull' | 'bear' | 'neutral' {
    if (v === 'bullish_spring' || v === 'bullish_smt' || v === 'cheap') return 'bull';
    if (v === 'bearish_trap' || v === 'bearish_smt' || v === 'rich') return 'bear';
    return 'neutral';
  }

  function flashNotice(text: string) {
    feedbackNotice = text;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedbackNotice = null;
    }, 2600);
  }

  async function loadSymbolView(sym: string, tf: DislocationTimeframe, force = false) {
    symbolAbort?.abort();
    const controller = new AbortController();
    symbolAbort = controller;

    loading = true;
    loadError = null;
    try {
      const data = await fetchDislocation(sym, tf, { force, signal: controller.signal });
      if (controller.signal.aborted) return;
      payload = data;
      hoveredIdx = null;
    } catch (err) {
      if (controller.signal.aborted) return;
      loadError = err instanceof Error ? err.message : 'Unable to compute intermarket fair value.';
    } finally {
      if (!controller.signal.aborted) loading = false;
    }
  }

  async function loadScannerView(tf: DislocationTimeframe, force = false) {
    scanAbort?.abort();
    const controller = new AbortController();
    scanAbort = controller;

    scanLoading = true;
    scanError = null;
    try {
      const data = await fetchDislocationScan(tf, { force, signal: controller.signal });
      if (controller.signal.aborted) return;
      scanPayload = data;
    } catch (err) {
      if (controller.signal.aborted) return;
      scanError = err instanceof Error ? err.message : 'Unable to scan cross-market dislocations.';
    } finally {
      if (!controller.signal.aborted) scanLoading = false;
    }
  }

  async function runSignalResolution(showFeedback = false) {
    if (resolving || signals.length === 0) return;
    resolving = true;
    try {
      const res = await resolvePendingSignals(signals);
      if (res.updatedCount > 0) {
        signals = res.signals;
        await saveDislocationState({ timeframe, signals });
        if (showFeedback) flashNotice(`Updated ${res.updatedCount} signal outcome${res.updatedCount === 1 ? '' : 's'}.`);
      } else if (showFeedback) {
        flashNotice('All open signals are up to date.');
      }
    } finally {
      resolving = false;
    }
  }

  onMount(() => {
    void loadDislocationState().then((loaded) => {
      timeframe = loaded.timeframe;
      signals = loaded.signals;
      stateReady = true;
      if (loaded.signals.some((s) => s.status === 'pending')) {
        void runSignalResolution(false);
      }
    });

    return () => {
      symbolAbort?.abort();
      scanAbort?.abort();
      if (feedbackTimer) clearTimeout(feedbackTimer);
    };
  });

  // Fetch active symbol dislocation whenever symbol or timeframe changes
  $effect(() => {
    if (!stateReady) return;
    const sym = targetFullSymbol;
    const tf = timeframe;
    void loadSymbolView(sym, tf, false);
  });

  // Fetch scanner when switching to Scanner tab or changing timeframe while on Scanner tab
  $effect(() => {
    if (!stateReady || activeTab !== 'scanner') return;
    const tf = timeframe;
    void loadScannerView(tf, false);
  });

  function selectTimeframe(nextTf: DislocationTimeframe) {
    if (timeframe === nextTf) return;
    timeframe = nextTf;
    void saveDislocationState({ timeframe: nextTf, signals });
  }

  function handleRefresh() {
    if (activeTab === 'symbol') {
      void loadSymbolView(targetFullSymbol, timeframe, true);
    } else if (activeTab === 'scanner') {
      void loadScannerView(timeframe, true);
    } else {
      void runSignalResolution(true);
    }
  }

  async function handlePinSignal() {
    if (!payload) return;
    const sig = createPinnedSignal(payload);
    signals = [sig, ...signals].slice(0, 120);
    await saveDislocationState({ timeframe, signals });
    flashNotice(`Pinned ${sig.shortName} ${sig.direction.toUpperCase()} (${formatSigned(sig.zScore, 2)}σ) to Scorecard.`);
  }

  function handleAlertAtFairValue() {
    if (!payload || !Number.isFinite(payload.fairValuePrice)) return;
    onCreateAlertAtPrice(payload.symbol, payload.shortName, payload.fairValuePrice);
  }

  async function handleSaveNote() {
    if (!payload) return;
    try {
      await saveDislocationSnapshotToNotes(payload);
      flashNotice(`Saved ${payload.shortName} Intermarket snapshot to Notes.`);
    } catch {
      flashNotice('Could not save snapshot to Notes.');
    }
  }

  async function handleDeleteSignal(id: string) {
    signals = signals.filter((s) => s.id !== id);
    await saveDislocationState({ timeframe, signals });
  }

  function formatShortTime(tsSec: number): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(tsSec * 1000));
    } catch {
      return '';
    }
  }

  function handleSparklineMove(e: PointerEvent) {
    if (sparklineCoords.length === 0) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * CHART_W;
    let closest = 0;
    let bestDist = Infinity;
    for (let i = 0; i < sparklineCoords.length; i++) {
      const d = Math.abs(sparklineCoords[i].x - relX);
      if (d < bestDist) {
        bestDist = d;
        closest = i;
      }
    }
    hoveredIdx = closest;
  }
</script>

<PanelShell {theme} title="Intermarket Radar" defaultWidth={430} {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.75 13.5c2.4 0 3.6-4.75 6.25-4.75 2.5 0 3.6-4.25 8.25-4.25" />
      <path d="M2.75 6.5c2.4 0 3.6 4.75 6.25 4.75 2.5 0 3.6 4.25 8.25 4.25" />
      <circle cx="9" cy="10" r="1.5" />
    </svg>
  {/snippet}

  <div class="radar-panel" class:light={theme === 'light'}>
    <!-- Top Control Strip: Tabs + Timeframe + Refresh -->
    <div class="radar-toolbar">
      <div class="seg-tabs" role="tablist" aria-label="Intermarket radar views">
        <button
          class="seg-tab"
          class:active={activeTab === 'symbol'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'symbol'}
          onclick={() => (activeTab = 'symbol')}
        >
          Symbol
        </button>
        <button
          class="seg-tab"
          class:active={activeTab === 'scanner'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'scanner'}
          onclick={() => (activeTab = 'scanner')}
        >
          Scanner
        </button>
        <button
          class="seg-tab"
          class:active={activeTab === 'scorecard'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'scorecard'}
          onclick={() => (activeTab = 'scorecard')}
        >
          Scorecard
          {#if signals.length > 0}
            <span class="tab-count">{signals.length}</span>
          {/if}
        </button>
      </div>

      <div class="toolbar-right">
        <div class="tf-group" role="group" aria-label="Regression timeframe">
          {#each TIMEFRAMES as tf (tf.id)}
            <button
              class="tf-btn"
              class:active={timeframe === tf.id}
              type="button"
              onclick={() => selectTimeframe(tf.id)}
            >
              {tf.label}
            </button>
          {/each}
        </div>
        <button
          class="icon-btn"
          type="button"
          title="Refresh data"
          aria-label="Refresh data"
          disabled={loading || scanLoading || resolving}
          onclick={handleRefresh}
        >
          <svg
            viewBox="0 0 16 16"
            class:spinning={loading || scanLoading || resolving}
            aria-hidden="true"
          >
            <path d="M13 8a5 5 0 1 1-1.35-3.4M13 3.25v2.75h-2.75" />
          </svg>
        </button>
      </div>
    </div>

    {#if feedbackNotice}
      <div class="feedback-bar" role="status">{feedbackNotice}</div>
    {/if}

    <div class="radar-scroll">
      {#if activeTab === 'symbol'}
        {#if loading && !payload}
          <div class="state-card">
            <span class="state-title">Fitting cross-asset fair-value model…</span>
            <span class="state-sub">Aligning intraday bars for {activeSymbol || 'XAUUSD'} and intermarket drivers.</span>
          </div>
        {:else if loadError && !payload}
          <div class="state-card err">
            <span class="state-title">Unable to load Intermarket Radar</span>
            <span class="state-sub">{loadError}</span>
            <button class="btn-outline" type="button" onclick={() => void loadSymbolView(targetFullSymbol, timeframe, true)}>
              Retry
            </button>
          </div>
        {:else if payload}
          {@const tone = verdictTone(payload.verdict)}

          <!-- 1. Fair-Value & Equilibrium Gauge Card -->
          <section class="r-card">
            <div class="card-head">
              <div class="sym-head">
                <SymbolIcon symbol={payload.shortName} size={20} />
                <span class="sym-name">{payload.shortName}</span>
                <span class="verdict-pill" class:bull={tone === 'bull'} class:bear={tone === 'bear'}>
                  {payload.verdictLabel}
                </span>
              </div>
              <span class="conv-pill" title="Conviction score combining |σ|, model R², and confirming SMT">
                {payload.convictionScore}/100
              </span>
            </div>

            <p class="verdict-copy">{payload.verdictDetail}</p>

            <div class="fv-grid">
              <div class="fv-cell">
                <span class="fv-k">Live Spot</span>
                <span class="fv-v">{formatRadarPrice(payload.spotPrice, payload.shortName)}</span>
              </div>
              <div class="fv-cell">
                <span class="fv-k">Fair Value</span>
                <span class="fv-v">{formatRadarPrice(payload.fairValuePrice, payload.shortName)}</span>
              </div>
              <div class="fv-cell">
                <span class="fv-k">Dislocation</span>
                <span
                  class="fv-v"
                  class:txt-bear={payload.zScore >= 1.5}
                  class:txt-bull={payload.zScore <= -1.5}
                >
                  {formatSigned(payload.zScore, 2)}σ
                </span>
                <span class="fv-sub">
                  {formatSigned(payload.gapPoints, payload.spotPrice < 10 ? 4 : 2)} ({formatSigned(payload.gapPct, 2)}%)
                </span>
              </div>
            </div>

            <!-- Horizontal -3σ .. 0 .. +3σ Equilibrium Rail -->
            <div class="z-rail-wrap" aria-label="Standard deviation from fair value">
              <div class="z-rail-labels">
                <span>-3σ Cheap</span>
                <span>0 Fair</span>
                <span>+3σ Rich</span>
              </div>
              <div class="z-rail-track">
                <div class="z-zone z-zone-cheap"></div>
                <div class="z-zone z-zone-rich"></div>
                <div class="z-tick" style:left="16.66%"></div>
                <div class="z-tick z-tick-mid" style:left="50%"></div>
                <div class="z-tick" style:left="83.33%"></div>
                <div
                  class="z-pin"
                  class:bull={payload.zScore <= -1.5}
                  class:bear={payload.zScore >= 1.5}
                  style:left="{zMarkerLeftPct(payload.zScore)}%"
                ></div>
              </div>
              <div class="model-meta">
                <span>Model R² <strong>{payload.rSquared.toFixed(2)}</strong></span>
                <span>ATR(14) <strong>{formatRadarPrice(payload.atr, payload.shortName)}</strong> ({payload.atrPct.toFixed(2)}%)</span>
                <span>{payload.windowBars} bars</span>
              </div>
            </div>

            <!-- 36-Bar Residual Z-Score Sparkline -->
            {#if sparklineCoords.length >= 2}
              <div class="spark-wrap">
                <div class="spark-head">
                  <span class="mini-label">Residual Z-Score ({timeframe.toUpperCase()})</span>
                  {#if hoveredPoint}
                    <span class="spark-readout">
                      {formatShortTime(hoveredPoint.ts)} · <strong>{formatSigned(hoveredPoint.z, 2)}σ</strong> (FV {formatRadarPrice(hoveredPoint.fair, payload.shortName)})
                    </span>
                  {:else}
                    <span class="spark-readout">±2σ mean-reversion bands</span>
                  {/if}
                </div>
                <svg
                  class="spark-svg"
                  viewBox="0 0 {CHART_W} {CHART_H}"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="Fair value residual Z-score history"
                  onpointermove={handleSparklineMove}
                  onpointerleave={() => (hoveredIdx = null)}
                >
                  <!-- Outer ±2σ shaded bands -->
                  <rect
                    x={CHART_PAD_X}
                    y={CHART_PAD_Y}
                    width={CHART_W - CHART_PAD_X * 2}
                    height={Math.max(0, zToY(2) - CHART_PAD_Y)}
                    class="band-rich"
                  />
                  <rect
                    x={CHART_PAD_X}
                    y={zToY(-2)}
                    width={CHART_W - CHART_PAD_X * 2}
                    height={Math.max(0, CHART_H - CHART_PAD_Y - zToY(-2))}
                    class="band-cheap"
                  />
                  <!-- Reference lines (+2σ, 0, -2σ) -->
                  <line x1={CHART_PAD_X} y1={zToY(2)} x2={CHART_W - CHART_PAD_X} y2={zToY(2)} class="ref-line dash" />
                  <line x1={CHART_PAD_X} y1={zToY(0)} x2={CHART_W - CHART_PAD_X} y2={zToY(0)} class="ref-line mid" />
                  <line x1={CHART_PAD_X} y1={zToY(-2)} x2={CHART_W - CHART_PAD_X} y2={zToY(-2)} class="ref-line dash" />

                  <path d={sparklinePath} class="spark-line" />

                  {#if hoveredPoint}
                    <line
                      x1={hoveredPoint.x}
                      y1={CHART_PAD_Y}
                      x2={hoveredPoint.x}
                      y2={CHART_H - CHART_PAD_Y}
                      class="hover-guide"
                    />
                    <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="3.2" class="spark-dot" />
                  {:else}
                    {@const lastPt = sparklineCoords[sparklineCoords.length - 1]}
                    <circle cx={lastPt.x} cy={lastPt.y} r="2.8" class="spark-dot" />
                  {/if}
                </svg>
              </div>
            {/if}

            <!-- Quick Actions -->
            <div class="action-row">
              <button class="btn-primary" type="button" onclick={() => void handlePinSignal()}>
                Pin Signal
              </button>
              <button class="btn-outline" type="button" onclick={handleAlertAtFairValue}>
                Alert @ FV
              </button>
              <button class="btn-outline" type="button" onclick={() => void handleSaveNote()}>
                Save Note
              </button>
            </div>
          </section>

          <!-- 2. Active SMT Divergences & Triad Liquidity Pools -->
          <section class="r-card">
            <div class="card-head">
              <span class="section-label">SMT Non-Confirmation</span>
              <span class="meta-count">
                {payload.smtSignals.length > 0
                  ? `${payload.smtSignals.length} active`
                  : 'No divergence'}
              </span>
            </div>

            {#if payload.smtSignals.length > 0}
              <div class="smt-list">
                {#each payload.smtSignals as sig (sig.id)}
                  <div class="smt-item">
                    <div class="smt-top">
                      <div class="smt-badges">
                        <span class="dir-tag" class:bull={sig.direction === 'bullish'} class:bear={sig.direction === 'bearish'}>
                          {sig.direction === 'bullish' ? 'Bullish SMT' : 'Bearish SMT'}
                        </span>
                        <span class="lvl-tag">{sig.levelLabel}</span>
                      </div>
                      <div class="smt-right">
                        <span class="age-pill" class:fresh={sig.freshness === 'fresh'}>
                          {formatAgeCompact(sig.minutesAgo)} ago
                        </span>
                        <button
                          class="peer-jump"
                          type="button"
                          title="Open {sig.peerShortName} on chart"
                          onclick={() => onSelectSymbol(sig.peerSymbol, sig.peerShortName)}
                        >
                          vs {sig.peerShortName} ↗
                        </button>
                      </div>
                    </div>
                    <p class="smt-summary">{sig.summary}</p>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="quiet-copy">
                Correlated triad peers are confirming structure across session highs and lows right now.
              </p>
            {/if}

            {#if payload.sessionPools.length > 0}
              <div class="pools-block">
                <div class="pools-head">
                  <span class="mini-label">Triad Pool Monitor</span>
                  <span class="mini-label">
                    {payload.shortName} / {payload.sessionPools[0].peerShortName}
                  </span>
                </div>
                <div class="pools-list">
                  {#each payload.sessionPools as pool (pool.id)}
                    <div class="pool-row">
                      <span class="pool-name">{pool.label}</span>
                      <span class="pool-lvl">{formatRadarPrice(pool.targetLevel, payload.shortName)}</span>
                      <span class="pool-dist">{formatSigned(pool.distancePct, 2)}%</span>
                      <span class="pool-dots" title="{payload.shortName} swept: {pool.targetSwept ? 'Yes' : 'No'} | {pool.peerShortName} swept: {pool.peerSwept ? 'Yes' : 'No'}">
                        <span class="s-dot" class:swept={pool.targetSwept}></span>
                        <span class="s-dot" class:swept={pool.peerSwept}></span>
                        {#if pool.smtState !== 'none'}
                          <span class="smt-micro" class:bull={pool.smtState === 'bullish'} class:bear={pool.smtState === 'bearish'}>
                            SMT
                          </span>
                        {/if}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </section>

          <!-- 3. Factor Drivers & Lead-Lag -->
          <section class="r-card">
            <div class="card-head">
              <span class="section-label">Factor Drivers & Lead-Lag</span>
              <span class="meta-count">{payload.drivers.filter((d) => d.active).length} active</span>
            </div>

            {#if payload.leadLag}
              {@const lead = payload.leadLag}
              <button
                class="lead-banner"
                type="button"
                onclick={() => onSelectSymbol(lead.leaderSymbol, lead.leaderShortName)}
              >
                <span class="lead-badge">LEAD</span>
                <span class="lead-text">{lead.summary}</span>
                <span class="lead-arrow">↗</span>
              </button>
            {/if}

            <div class="driver-list">
              {#each payload.drivers as drv (drv.shortName)}
                <button
                  class="driver-row"
                  class:inactive={!drv.active}
                  type="button"
                  onclick={() => onSelectSymbol(drv.symbol, drv.shortName)}
                >
                  <div class="drv-main">
                    <span class="drv-sym">{drv.shortName}</span>
                    <span class="drv-px">{formatRadarPrice(drv.price, drv.shortName)}</span>
                    <span
                      class="drv-chg"
                      class:txt-bull={drv.windowChangePct > 0.05}
                      class:txt-bear={drv.windowChangePct < -0.05}
                    >
                      {formatSigned(drv.windowChangePct, 2)}%
                    </span>
                    <span class="drv-r">r {formatSigned(drv.correlation, 2)}</span>
                    <span
                      class="drv-pull"
                      class:txt-bull={drv.pull === 'up'}
                      class:txt-bear={drv.pull === 'down'}
                      title="Recent implied pull on {payload.shortName}"
                    >
                      {drv.pull === 'up' ? '↑' : drv.pull === 'down' ? '↓' : '·'}
                    </span>
                  </div>
                  <div class="drv-bar-row">
                    <div class="drv-track">
                      <div class="drv-fill" style:width="{drv.active ? drv.weightPct : 0}%"></div>
                    </div>
                    <span class="drv-wt">{drv.active ? `${drv.weightPct}%` : 'Closed'}</span>
                  </div>
                </button>
              {/each}
            </div>
          </section>
        {/if}
      {:else if activeTab === 'scanner'}
        <!-- Cross-Market Dislocation Scanner -->
        <div class="filter-pills">
          <button
            class="f-pill"
            class:active={scanFilter === 'all'}
            type="button"
            onclick={() => (scanFilter = 'all')}
          >
            All ({scanPayload?.rows.length ?? 0})
          </button>
          <button
            class="f-pill"
            class:active={scanFilter === 'dislocated'}
            type="button"
            onclick={() => (scanFilter = 'dislocated')}
          >
            ≥1.5σ ({scanDislocatedCount})
          </button>
          <button
            class="f-pill"
            class:active={scanFilter === 'smt'}
            type="button"
            onclick={() => (scanFilter = 'smt')}
          >
            SMT Active ({scanSmtCount})
          </button>
        </div>

        {#if scanLoading && !scanPayload}
          <div class="state-card">
            <span class="state-title">Scanning 12 cross-asset markets…</span>
            <span class="state-sub">Computing OLS fair values and session SMT divergences ({timeframe.toUpperCase()}).</span>
          </div>
        {:else if scanError && !scanPayload}
          <div class="state-card err">
            <span class="state-title">Scanner unavailable</span>
            <span class="state-sub">{scanError}</span>
            <button class="btn-outline" type="button" onclick={() => void loadScannerView(timeframe, true)}>
              Retry
            </button>
          </div>
        {:else if filteredScanRows.length === 0}
          <div class="state-card">
            <span class="state-title">No instruments match this filter</span>
            <span class="state-sub">Markets are currently near intermarket fair value on {timeframe.toUpperCase()}.</span>
          </div>
        {:else}
          <div class="scan-list">
            {#each filteredScanRows as row (row.symbol)}
              {@const rTone = verdictTone(row.verdict)}
              <button
                class="scan-row"
                class:current={row.shortName.toUpperCase() === (activeSymbol || '').toUpperCase()}
                type="button"
                onclick={() => {
                  onSelectSymbol(row.symbol, row.shortName);
                  activeTab = 'symbol';
                }}
              >
                <div class="scan-top">
                  <div class="scan-sym">
                    <SymbolIcon symbol={row.shortName} size={18} />
                    <strong>{row.shortName}</strong>
                    <span class="verdict-mini" class:bull={rTone === 'bull'} class:bear={rTone === 'bear'}>
                      {row.verdictLabel}
                    </span>
                  </div>
                  <span
                    class="scan-z"
                    class:txt-bear={row.zScore >= 1.5}
                    class:txt-bull={row.zScore <= -1.5}
                  >
                    {formatSigned(row.zScore, 2)}σ
                  </span>
                </div>

                <div class="scan-mid">
                  <span>Spot {formatRadarPrice(row.spotPrice, row.shortName)}</span>
                  <span class="scan-sep">→</span>
                  <span>FV {formatRadarPrice(row.fairValuePrice, row.shortName)}</span>
                  <span class="scan-r2">R² {row.rSquared.toFixed(2)}</span>
                </div>

                <div class="scan-bar-wrap">
                  <div class="scan-bar-track">
                    <div class="scan-bar-mid"></div>
                    <div
                      class="scan-bar-pin"
                      class:bull={row.zScore <= -1.5}
                      class:bear={row.zScore >= 1.5}
                      style:left="{zMarkerLeftPct(row.zScore)}%"
                    ></div>
                  </div>
                  <span class="scan-conv">{row.convictionScore}</span>
                </div>

                {#if row.topSmtLabel}
                  <div class="scan-smt-line">
                    <span
                      class="smt-dot-lbl"
                      class:txt-bull={row.topSmtDirection === 'bullish'}
                      class:txt-bear={row.topSmtDirection === 'bearish'}
                    >
                      {row.topSmtDirection === 'bullish' ? 'Bull SMT' : 'Bear SMT'}
                    </span>
                    <span class="scan-smt-txt">{row.topSmtLabel}</span>
                    {#if row.topSmtMinutesAgo !== null}
                      <span class="scan-smt-age">{formatAgeCompact(row.topSmtMinutesAgo)}</span>
                    {/if}
                  </div>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- Market-Truth Signal Scorecard (Zero Paper-Trading Dependency) -->
        <section class="r-card">
          <div class="card-head">
            <span class="section-label">Market-Truth Scorecard</span>
            <button
              class="mini-action"
              type="button"
              disabled={resolving || scorecard.pending === 0}
              onclick={() => void runSignalResolution(true)}
            >
              {resolving ? 'Checking…' : `Resolve (${scorecard.pending})`}
            </button>
          </div>

          <p class="quiet-copy">
            Scores pinned dislocations against real OHLC bars (+1 ATR favorable before -1 ATR adverse). Keep target: ≥{scorecard.targetHitRatePct}% over {scorecard.targetSampleSize} signals.
          </p>

          <div class="sc-grid">
            <div class="sc-box">
              <span class="sc-val" class:txt-bull={scorecard.hitRatePct !== null && scorecard.hitRatePct >= 58} class:txt-bear={scorecard.hitRatePct !== null && scorecard.hitRatePct < 50}>
                {scorecard.hitRatePct !== null ? `${scorecard.hitRatePct}%` : '—'}
              </span>
              <span class="sc-lbl">+1 ATR Hit Rate</span>
            </div>
            <div class="sc-box">
              <span class="sc-val" class:txt-bull={scorecard.avgNetAtr !== null && scorecard.avgNetAtr > 0} class:txt-bear={scorecard.avgNetAtr !== null && scorecard.avgNetAtr < 0}>
                {scorecard.avgNetAtr !== null ? `${formatSigned(scorecard.avgNetAtr, 2)} ATR` : '—'}
              </span>
              <span class="sc-lbl">Avg Net Move</span>
            </div>
            <div class="sc-box">
              <span class="sc-val">{scorecard.resolved}/{scorecard.targetSampleSize}</span>
              <span class="sc-lbl">Resolved Sample</span>
            </div>
            <div class="sc-box">
              <span class="sc-val">{scorecard.hits}W · {scorecard.misses}L</span>
              <span class="sc-lbl">Decided ({scorecard.flats} flat)</span>
            </div>
          </div>

          <div class="sc-progress-wrap">
            <div class="sc-progress-track">
              <div
                class="sc-progress-fill"
                style:width="{Math.min(100, Math.round((scorecard.resolved / scorecard.targetSampleSize) * 100))}%"
              ></div>
            </div>
            <span class="sc-status">{scorecard.statusLabel}</span>
          </div>
        </section>

        {#if signals.length === 0}
          <div class="state-card">
            <span class="state-title">No pinned signals yet</span>
            <span class="state-sub">
              Click <strong>Pin Signal</strong> on any stretched ±σ or SMT setup to track whether it genuinely beats the market over 40 real samples.
            </span>
          </div>
        {:else}
          <div class="sig-list">
            {#each signals as sig (sig.id)}
              <div class="sig-card">
                <div class="sig-head">
                  <button
                    class="sig-sym-btn"
                    type="button"
                    onclick={() => {
                      onSelectSymbol(sig.symbol, sig.shortName);
                      activeTab = 'symbol';
                    }}
                  >
                    <strong>{sig.shortName}</strong>
                    <span class="dir-tag" class:bull={sig.direction === 'long'} class:bear={sig.direction === 'short'}>
                      {sig.direction.toUpperCase()}
                    </span>
                    <span class="sig-tf">{sig.timeframe.toUpperCase()}</span>
                  </button>
                  <div class="sig-head-right">
                    <span
                      class="status-pill"
                      class:hit={sig.status === 'hit'}
                      class:miss={sig.status === 'miss'}
                      class:pending={sig.status === 'pending'}
                    >
                      {sig.status.toUpperCase()}
                    </span>
                    <button
                      class="sig-del"
                      type="button"
                      aria-label="Delete pinned signal"
                      onclick={() => void handleDeleteSignal(sig.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>

                <div class="sig-meta">
                  <span>Entry {formatRadarPrice(sig.entryPrice, sig.shortName)} → FV {formatRadarPrice(sig.fairValuePrice, sig.shortName)}</span>
                  <span>{formatSigned(sig.zScore, 2)}σ</span>
                </div>

                <div class="sig-foot">
                  <span>MFE +{sig.maxFavorableAtr.toFixed(2)} · MAE -{sig.maxAdverseAtr.toFixed(2)} ATR</span>
                  {#if sig.netReturnAtr !== null}
                    <strong class:txt-bull={sig.netReturnAtr > 0} class:txt-bear={sig.netReturnAtr < 0}>
                      {formatSigned(sig.netReturnAtr, 2)} ATR
                    </strong>
                  {:else}
                    <span>{sig.smtLabel ?? sig.verdictLabel}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</PanelShell>

<style>
  .radar-panel {
    --rd-bg: var(--dark-bg-panel);
    --rd-surface: var(--dark-bg-surface);
    --rd-surface-alt: var(--dark-bg-surface-alt);
    --rd-border: var(--dark-border);
    --rd-border-soft: var(--dark-border-subtle);
    --rd-text: var(--dark-text-primary);
    --rd-secondary: var(--dark-text-secondary);
    --rd-hover: var(--dark-hover);
    --rd-cta-bg: var(--dark-cta-bg);
    --rd-cta-fg: var(--dark-cta-fg);
    --rd-bull: #089981;
    --rd-bear: #f23645;

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--rd-text);
    background: var(--rd-bg);
  }

  .radar-panel.light {
    --rd-bg: #ffffff;
    --rd-surface: #f7f8fa;
    --rd-surface-alt: #eff1f5;
    --rd-border: #dfe3eb;
    --rd-border-soft: #eef0f4;
    --rd-text: #131722;
    --rd-secondary: #6a6d78;
    --rd-hover: rgba(0, 0, 0, 0.04);
    --rd-cta-bg: #131722;
    --rd-cta-fg: #ffffff;
  }

  .radar-toolbar {
    padding: 0 14px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
  }

  .seg-tabs {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--rd-surface-alt);
    gap: 2px;
  }

  .seg-tab {
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .seg-tab.active {
    background: var(--rd-bg);
    color: var(--rd-text);
  }

  .tab-count {
    padding: 0 5px;
    border-radius: 999px;
    background: var(--rd-surface-alt);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tf-group {
    display: inline-flex;
    padding: 2px;
    border-radius: 7px;
    background: var(--rd-surface-alt);
    gap: 2px;
  }

  .tf-btn {
    height: 24px;
    padding: 0 7px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--rd-secondary);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .tf-btn.active {
    background: var(--rd-bg);
    color: var(--rd-text);
  }

  .icon-btn {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--rd-border-soft);
    border-radius: 7px;
    background: transparent;
    color: var(--rd-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--rd-text);
    background: var(--rd-hover);
  }

  .icon-btn svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon-btn svg.spinning {
    animation: radar-spin 0.9s linear infinite;
  }

  @keyframes radar-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .feedback-bar {
    margin: 0 14px 8px;
    padding: 7px 10px;
    border-radius: 8px;
    background: rgba(8, 153, 129, 0.14);
    border: 1px solid rgba(8, 153, 129, 0.3);
    font-size: 11.5px;
    color: var(--rd-text);
  }

  .radar-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 2px 14px 20px;
    display: flex;
    flex-direction: column;
    gap: 11px;
    scrollbar-width: none;
  }

  .radar-scroll::-webkit-scrollbar {
    display: none;
  }

  .r-card,
  .state-card {
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--rd-border-soft);
    background: var(--rd-surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .state-card {
    align-items: flex-start;
    gap: 6px;
    padding: 16px 14px;
  }

  .state-card.err {
    border-color: rgba(242, 54, 69, 0.3);
  }

  .state-title {
    font-size: 13px;
    font-weight: 600;
  }

  .state-sub {
    font-size: 12px;
    line-height: 1.45;
    color: var(--rd-secondary);
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .sym-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .sym-name {
    font-size: 13.5px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .verdict-pill,
  .verdict-mini {
    padding: 2px 7px;
    border-radius: 6px;
    background: var(--rd-surface-alt);
    color: var(--rd-secondary);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  .verdict-mini {
    font-size: 10px;
    padding: 1px 6px;
  }

  .verdict-pill.bull,
  .verdict-mini.bull {
    background: rgba(8, 153, 129, 0.16);
    color: var(--rd-bull);
  }

  .verdict-pill.bear,
  .verdict-mini.bear {
    background: rgba(242, 54, 69, 0.16);
    color: var(--rd-bear);
  }

  .conv-pill {
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--rd-surface-alt);
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .verdict-copy,
  .quiet-copy {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--rd-secondary);
  }

  .fv-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .fv-cell {
    padding: 8px 9px;
    border-radius: 8px;
    background: var(--rd-surface-alt);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .fv-k {
    font-size: 10.5px;
    color: var(--rd-secondary);
  }

  .fv-v {
    font-size: 13.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fv-sub {
    font-size: 10px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .txt-bull {
    color: var(--rd-bull);
  }

  .txt-bear {
    color: var(--rd-bear);
  }

  .z-rail-wrap {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .z-rail-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .z-rail-track {
    position: relative;
    height: 10px;
    border-radius: 999px;
    background: var(--rd-surface-alt);
    overflow: visible;
  }

  .z-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 16.66%;
  }

  .z-zone-cheap {
    left: 0;
    border-radius: 999px 0 0 999px;
    background: rgba(8, 153, 129, 0.22);
  }

  .z-zone-rich {
    right: 0;
    border-radius: 0 999px 999px 0;
    background: rgba(242, 54, 69, 0.22);
  }

  .z-tick {
    position: absolute;
    top: 1px;
    bottom: 1px;
    width: 1px;
    background: var(--rd-border);
  }

  .z-tick-mid {
    background: var(--rd-secondary);
    opacity: 0.65;
  }

  .z-pin {
    position: absolute;
    top: 50%;
    width: 10px;
    height: 14px;
    border-radius: 3px;
    background: var(--rd-text);
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 2px var(--rd-surface);
  }

  .z-pin.bull {
    background: var(--rd-bull);
  }

  .z-pin.bear {
    background: var(--rd-bear);
  }

  .model-meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .model-meta strong {
    color: var(--rd-text);
    font-weight: 600;
  }

  .spark-wrap {
    padding: 8px 9px;
    border-radius: 8px;
    background: var(--rd-bg);
    border: 1px solid var(--rd-border-soft);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .spark-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .mini-label {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--rd-secondary);
  }

  .spark-readout {
    font-size: 10.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .spark-readout strong {
    color: var(--rd-text);
  }

  .spark-svg {
    width: 100%;
    height: 82px;
    display: block;
    cursor: crosshair;
  }

  .band-rich {
    fill: rgba(242, 54, 69, 0.09);
  }

  .band-cheap {
    fill: rgba(8, 153, 129, 0.09);
  }

  .ref-line {
    stroke: var(--rd-border);
    stroke-width: 1;
  }

  .ref-line.dash {
    stroke-dasharray: 3 3;
    opacity: 0.8;
  }

  .ref-line.mid {
    stroke: var(--rd-secondary);
    opacity: 0.45;
  }

  .spark-line {
    fill: none;
    stroke: var(--rd-text);
    stroke-width: 1.65;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .hover-guide {
    stroke: var(--rd-secondary);
    stroke-width: 1;
    stroke-dasharray: 2 2;
  }

  .spark-dot {
    fill: var(--rd-text);
    stroke: var(--rd-bg);
    stroke-width: 1.5;
  }

  .action-row {
    display: flex;
    gap: 6px;
  }

  .btn-primary,
  .btn-outline {
    flex: 1;
    height: 30px;
    padding: 0 9px;
    border-radius: 7px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-primary {
    border: 0;
    background: var(--rd-cta-bg);
    color: var(--rd-cta-fg);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-outline {
    border: 1px solid var(--rd-border);
    background: transparent;
    color: var(--rd-text);
  }

  .btn-outline:hover {
    background: var(--rd-hover);
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--rd-secondary);
  }

  .meta-count {
    font-size: 11px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* SMT section */
  .smt-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .smt-item {
    padding: 9px 10px;
    border-radius: 8px;
    background: var(--rd-surface-alt);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .smt-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
  }

  .smt-badges,
  .smt-right {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .dir-tag {
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 700;
  }

  .dir-tag.bull {
    background: rgba(8, 153, 129, 0.16);
    color: var(--rd-bull);
  }

  .dir-tag.bear {
    background: rgba(242, 54, 69, 0.16);
    color: var(--rd-bear);
  }

  .lvl-tag {
    font-size: 11px;
    font-weight: 600;
  }

  .age-pill {
    font-size: 10.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .age-pill.fresh {
    color: var(--rd-text);
    font-weight: 600;
  }

  .peer-jump {
    border: 1px solid var(--rd-border);
    border-radius: 5px;
    background: transparent;
    color: var(--rd-text);
    padding: 1px 6px;
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .peer-jump:hover {
    background: var(--rd-hover);
  }

  .smt-summary {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--rd-secondary);
  }

  .pools-block {
    padding-top: 8px;
    border-top: 1px solid var(--rd-border-soft);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pools-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .pools-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pool-row {
    display: grid;
    grid-template-columns: 1fr auto 56px auto;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 6px;
    background: var(--rd-bg);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .pool-name {
    color: var(--rd-secondary);
  }

  .pool-lvl {
    font-weight: 600;
  }

  .pool-dist {
    text-align: right;
    color: var(--rd-secondary);
  }

  .pool-dots {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 44px;
    justify-content: flex-end;
  }

  .s-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.5px solid var(--rd-secondary);
    opacity: 0.45;
  }

  .s-dot.swept {
    background: var(--rd-text);
    border-color: var(--rd-text);
    opacity: 1;
  }

  .smt-micro {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .smt-micro.bull {
    color: var(--rd-bull);
  }

  .smt-micro.bear {
    color: var(--rd-bear);
  }

  /* Drivers & Lead-Lag */
  .lead-banner {
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--rd-border);
    background: var(--rd-surface-alt);
    color: var(--rd-text);
    display: flex;
    align-items: center;
    gap: 7px;
    font: inherit;
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }

  .lead-banner:hover {
    background: var(--rd-hover);
  }

  .lead-badge {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--rd-cta-bg);
    color: var(--rd-cta-fg);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .lead-text {
    flex: 1;
    min-width: 0;
  }

  .lead-arrow {
    color: var(--rd-secondary);
  }

  .driver-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .driver-row {
    width: 100%;
    padding: 8px 9px;
    border: 1px solid var(--rd-border-soft);
    border-radius: 8px;
    background: var(--rd-bg);
    color: var(--rd-text);
    font: inherit;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: pointer;
  }

  .driver-row:hover {
    background: var(--rd-hover);
  }

  .driver-row.inactive {
    opacity: 0.52;
  }

  .drv-main {
    display: grid;
    grid-template-columns: 64px 1fr auto auto 16px;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .drv-sym {
    font-weight: 700;
  }

  .drv-px,
  .drv-r {
    color: var(--rd-secondary);
    font-size: 11.5px;
  }

  .drv-chg {
    font-weight: 600;
    font-size: 11.5px;
  }

  .drv-pull {
    text-align: right;
    font-weight: 700;
  }

  .drv-bar-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .drv-track {
    flex: 1;
    height: 4px;
    border-radius: 999px;
    background: var(--rd-surface-alt);
    overflow: hidden;
  }

  .drv-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--rd-text);
    opacity: 0.72;
  }

  .drv-wt {
    width: 38px;
    text-align: right;
    font-size: 10.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* Scanner tab */
  .filter-pills {
    display: flex;
    gap: 5px;
  }

  .f-pill {
    height: 25px;
    padding: 0 9px;
    border: 1px solid var(--rd-border-soft);
    border-radius: 999px;
    background: var(--rd-surface);
    color: var(--rd-secondary);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .f-pill.active {
    background: var(--rd-cta-bg);
    color: var(--rd-cta-fg);
    border-color: transparent;
  }

  .scan-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .scan-row {
    width: 100%;
    padding: 10px 11px;
    border-radius: 10px;
    border: 1px solid var(--rd-border-soft);
    background: var(--rd-surface);
    color: var(--rd-text);
    font: inherit;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: pointer;
    transition: border-color 130ms ease, background-color 130ms ease;
  }

  .scan-row:hover {
    border-color: var(--rd-border);
    background: var(--rd-surface-alt);
  }

  .scan-row.current {
    border-color: color-mix(in srgb, var(--rd-text) 35%, transparent);
  }

  .scan-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .scan-sym {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }

  .scan-z {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .scan-mid {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .scan-sep {
    opacity: 0.55;
  }

  .scan-r2 {
    margin-left: auto;
  }

  .scan-bar-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .scan-bar-track {
    position: relative;
    flex: 1;
    height: 5px;
    border-radius: 999px;
    background: var(--rd-bg);
  }

  .scan-bar-mid {
    position: absolute;
    left: 50%;
    top: -1px;
    bottom: -1px;
    width: 1px;
    background: var(--rd-secondary);
    opacity: 0.5;
  }

  .scan-bar-pin {
    position: absolute;
    top: 50%;
    width: 7px;
    height: 9px;
    border-radius: 2px;
    background: var(--rd-text);
    transform: translate(-50%, -50%);
  }

  .scan-bar-pin.bull {
    background: var(--rd-bull);
  }

  .scan-bar-pin.bear {
    background: var(--rd-bear);
  }

  .scan-conv {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
    width: 22px;
    text-align: right;
  }

  .scan-smt-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    padding-top: 4px;
    border-top: 1px solid var(--rd-border-soft);
  }

  .smt-dot-lbl {
    font-weight: 700;
    white-space: nowrap;
  }

  .scan-smt-txt {
    color: var(--rd-secondary);
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .scan-smt-age {
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* Scorecard tab */
  .mini-action {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--rd-border);
    border-radius: 6px;
    background: transparent;
    color: var(--rd-text);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .mini-action:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .sc-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 7px;
  }

  .sc-box {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--rd-surface-alt);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sc-val {
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .sc-lbl {
    font-size: 11px;
    color: var(--rd-secondary);
  }

  .sc-progress-wrap {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .sc-progress-track {
    height: 6px;
    border-radius: 999px;
    background: var(--rd-surface-alt);
    overflow: hidden;
  }

  .sc-progress-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--rd-text);
  }

  .sc-status {
    font-size: 11.5px;
    color: var(--rd-secondary);
  }

  .sig-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .sig-card {
    padding: 9px 10px;
    border-radius: 9px;
    border: 1px solid var(--rd-border-soft);
    background: var(--rd-surface);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .sig-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .sig-sym-btn {
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--rd-text);
    font: inherit;
    font-size: 12.5px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .sig-tf {
    font-size: 10.5px;
    color: var(--rd-secondary);
  }

  .sig-head-right {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .status-pill {
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 700;
    background: var(--rd-surface-alt);
    color: var(--rd-secondary);
  }

  .status-pill.hit {
    background: rgba(8, 153, 129, 0.16);
    color: var(--rd-bull);
  }

  .status-pill.miss {
    background: rgba(242, 54, 69, 0.16);
    color: var(--rd-bear);
  }

  .sig-del {
    border: 0;
    background: transparent;
    color: var(--rd-secondary);
    font-size: 14px;
    line-height: 1;
    padding: 0 3px;
    cursor: pointer;
  }

  .sig-del:hover {
    color: var(--rd-text);
  }

  .sig-meta,
  .sig-foot {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }
</style>
