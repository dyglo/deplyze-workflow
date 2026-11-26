<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    computeScorecardStats,
    createPinnedSignal,
    fetchDislocation,
    fetchDislocationAudit,
    fetchDislocationScan,
    formatAgeCompact,
    formatCorrPlain,
    formatRadarPrice,
    formatSigned,
    formatStretchPlain,
    loadDislocationState,
    resolvePendingSignals,
    saveDislocationSnapshotToNotes,
    saveDislocationState,
    type DislocationPayload,
    type DislocationScanPayload,
    type DislocationTimeframe,
    type PinnedDislocationSignal,
    type SetupContextTag,
    type SystemAuditPayload,
    type VerdictKind
  } from '../dislocation/store';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onCreateAlertAtPrice: (symbol: string, shortName: string, price?: number) => void;
    onWatchChange?: (enabled: boolean) => void;
    onClose: () => void;
  }

  let {
    theme,
    activeSymbol,
    activeFullSymbol,
    onSelectSymbol,
    onCreateAlertAtPrice,
    onWatchChange,
    onClose
  }: Props = $props();

  type TabId = 'symbol' | 'scanner' | 'scorecard';
  type ScanFilter = 'all' | 'ready' | 'stretched' | 'smt';
  type ScorecardSubTab = 'mine' | 'system';

  const TIMEFRAMES: { id: DislocationTimeframe; label: string }[] = [
    { id: '15m', label: '15m' },
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' }
  ];

  const CONTEXT_TAGS: SetupContextTag[] = ['With Trend', 'Counter-Trend', 'Swept Pool', 'News'];

  let activeTab = $state<TabId>('symbol');
  let scorecardSub = $state<ScorecardSubTab>('mine');
  let timeframe = $state<DislocationTimeframe>('1h');
  let watchAlertsEnabled = $state(true);
  let scanFilter = $state<ScanFilter>('all');
  let showScoreFormula = $state(false);

  let payload = $state<DislocationPayload | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let scanPayload = $state<DislocationScanPayload | null>(null);
  let scanLoading = $state(false);
  let scanError = $state<string | null>(null);

  let auditPayload = $state<SystemAuditPayload | null>(null);
  let auditLoading = $state(false);
  let auditError = $state<string | null>(null);

  let signals = $state<PinnedDislocationSignal[]>([]);
  let resolving = $state(false);
  let feedbackNotice = $state<string | null>(null);
  let hoveredIdx = $state<number | null>(null);
  let stateReady = $state(false);

  let symbolAbort: AbortController | null = null;
  let scanAbort: AbortController | null = null;
  let auditAbort: AbortController | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const targetFullSymbol = $derived(activeFullSymbol || activeSymbol || 'OANDA:XAUUSD');
  const scorecard = $derived(computeScorecardStats(signals));

  const filteredScanRows = $derived.by(() => {
    const rows = scanPayload?.rows ?? [];
    if (scanFilter === 'ready') {
      return rows.filter(
        (r) =>
          r.convictionScore >= 60 &&
          !r.smtConflict &&
          r.eventRiskStatus !== 'locked' &&
          r.driverLinkStatus !== 'breaking'
      );
    }
    if (scanFilter === 'stretched') {
      return rows.filter((r) => Math.abs(r.zScore) >= 1.5 && r.driverFitLabel !== 'Weak');
    }
    if (scanFilter === 'smt') {
      return rows.filter((r) => r.topSmtLabel !== null);
    }
    return rows;
  });

  const scanReadyCount = $derived(
    (scanPayload?.rows ?? []).filter(
      (r) =>
        r.convictionScore >= 60 &&
        !r.smtConflict &&
        r.eventRiskStatus !== 'locked' &&
        r.driverLinkStatus !== 'breaking'
    ).length
  );
  const scanStretchedCount = $derived(
    (scanPayload?.rows ?? []).filter(
      (r) => Math.abs(r.zScore) >= 1.5 && r.driverFitLabel !== 'Weak'
    ).length
  );
  const scanSmtCount = $derived(
    (scanPayload?.rows ?? []).filter((r) => r.topSmtLabel !== null).length
  );

  // SVG Sparkline geometry (340 x 74 viewBox)
  const CHART_W = 340;
  const CHART_H = 74;
  const CHART_PAD_X = 4;
  const CHART_PAD_Y = 7;

  function zToY(z: number): number {
    const clamped = Math.max(-3.5, Math.min(3.5, z));
    const norm = (3.5 - clamped) / 7.0;
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

  function verdictTone(v: VerdictKind): 'bull' | 'bear' | 'warn' | 'neutral' {
    if (v === 'bullish_spring' || v === 'bullish_smt' || v === 'cheap') return 'bull';
    if (v === 'bearish_trap' || v === 'bearish_smt' || v === 'rich' || v === 'event_lock') return 'bear';
    if (v === 'mixed' || v === 'weak_fit') return 'warn';
    return 'neutral';
  }

  function tfBarLabel(tf: DislocationTimeframe): string {
    if (tf === '15m') return '15m';
    if (tf === '4h') return '4H';
    return '1H';
  }

  function horizonPlainLabel(tf: DislocationTimeframe): string {
    if (tf === '15m') return '2h';
    if (tf === '4h') return '32h';
    return '8h';
  }

  function flashNotice(text: string) {
    feedbackNotice = text;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedbackNotice = null;
    }, 2800);
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
      loadError = err instanceof Error ? err.message : 'Unable to load Intermarket Radar.';
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
      scanError = err instanceof Error ? err.message : 'Unable to scan related markets.';
    } finally {
      if (!controller.signal.aborted) scanLoading = false;
    }
  }

  async function loadAuditView(force = false) {
    auditAbort?.abort();
    const controller = new AbortController();
    auditAbort = controller;

    auditLoading = true;
    auditError = null;
    try {
      const data = await fetchDislocationAudit({ force, signal: controller.signal });
      if (controller.signal.aborted) return;
      auditPayload = data;
    } catch (err) {
      if (controller.signal.aborted) return;
      auditError = err instanceof Error ? err.message : 'Unable to load System Audit.';
    } finally {
      if (!controller.signal.aborted) auditLoading = false;
    }
  }

  async function runSignalResolution(showFeedback = false) {
    if (resolving || signals.length === 0) return;
    resolving = true;
    try {
      const res = await resolvePendingSignals(signals);
      if (res.updatedCount > 0) {
        signals = res.signals;
        await saveDislocationState({ timeframe, watchAlertsEnabled, signals });
        if (showFeedback) {
          flashNotice(
            `Updated ${res.updatedCount} tracked setup${res.updatedCount === 1 ? '' : 's'}.`
          );
        }
      } else if (showFeedback) {
        flashNotice('All open tracked setups are up to date.');
      }
    } finally {
      resolving = false;
    }
  }

  onMount(() => {
    void loadDislocationState().then((loaded) => {
      timeframe = loaded.timeframe;
      watchAlertsEnabled = loaded.watchAlertsEnabled;
      signals = loaded.signals;
      stateReady = true;
      onWatchChange?.(loaded.watchAlertsEnabled);
      if (loaded.signals.some((s) => s.status === 'pending')) {
        void runSignalResolution(false);
      }
    });

    return () => {
      symbolAbort?.abort();
      scanAbort?.abort();
      auditAbort?.abort();
      if (feedbackTimer) clearTimeout(feedbackTimer);
    };
  });

  $effect(() => {
    if (!stateReady) return;
    const sym = targetFullSymbol;
    const tf = timeframe;
    void loadSymbolView(sym, tf, false);
  });

  $effect(() => {
    if (!stateReady || activeTab !== 'scanner') return;
    const tf = timeframe;
    void loadScannerView(tf, false);
  });

  $effect(() => {
    if (!stateReady || activeTab !== 'scorecard' || scorecardSub !== 'system') return;
    void loadAuditView(false);
  });

  function selectTimeframe(nextTf: DislocationTimeframe) {
    if (timeframe === nextTf) return;
    timeframe = nextTf;
    void saveDislocationState({ timeframe: nextTf, watchAlertsEnabled, signals });
  }

  function toggleWatchAlerts() {
    watchAlertsEnabled = !watchAlertsEnabled;
    onWatchChange?.(watchAlertsEnabled);
    void saveDislocationState({ timeframe, watchAlertsEnabled, signals });
    flashNotice(
      watchAlertsEnabled
        ? 'Background Watch on — rail dot lights up when any market hits 65+.'
        : 'Background Watch paused.'
    );
  }

  function handleRefresh() {
    if (activeTab === 'symbol') {
      void loadSymbolView(targetFullSymbol, timeframe, true);
    } else if (activeTab === 'scanner') {
      void loadScannerView(timeframe, true);
    } else if (scorecardSub === 'system') {
      void loadAuditView(true);
    } else {
      void runSignalResolution(true);
    }
  }

  async function handlePinSignal() {
    if (!payload) return;
    const sig = createPinnedSignal(payload);
    signals = [sig, ...signals].slice(0, 160);
    await saveDislocationState({ timeframe, watchAlertsEnabled, signals });
    const spreadTxt = sig.spreadSource === 'oanda' ? 'real OANDA spread' : 'est. spread';
    flashNotice(
      `Tracking ${sig.shortName} ${sig.direction === 'long' ? 'Buy' : 'Sell'} (${horizonPlainLabel(sig.timeframe)} check · ${spreadTxt}).`
    );
  }

  async function handleToggleSignalTag(id: string, tag: SetupContextTag) {
    signals = signals.map((s) =>
      s.id === id ? { ...s, contextTag: s.contextTag === tag ? null : tag } : s
    );
    await saveDislocationState({ timeframe, watchAlertsEnabled, signals });
  }

  function handleAlertAtFairValue() {
    if (!payload || !Number.isFinite(payload.fairValuePrice)) return;
    onCreateAlertAtPrice(payload.symbol, payload.shortName, payload.fairValuePrice);
  }

  async function handleSaveNote() {
    if (!payload) return;
    try {
      await saveDislocationSnapshotToNotes(payload);
      flashNotice(`Saved ${payload.shortName} institutional brief to Notes.`);
    } catch {
      flashNotice('Could not save summary to Notes.');
    }
  }

  async function handleDeleteSignal(id: string) {
    signals = signals.filter((s) => s.id !== id);
    await saveDislocationState({ timeframe, watchAlertsEnabled, signals });
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

<!-- Default width 372px keeps TradingView left drawing toolbar visible on a 1200px window -->
<PanelShell {theme} title="Intermarket Radar" defaultWidth={372} minWidth={340} {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.75 13.5c2.4 0 3.6-4.75 6.25-4.75 2.5 0 3.6-4.25 8.25-4.25" />
      <path d="M2.75 6.5c2.4 0 3.6 4.75 6.25 4.75 2.5 0 3.6 4.25 8.25 4.25" />
      <circle cx="9" cy="10" r="1.5" />
    </svg>
  {/snippet}

  <div class="radar" class:light={theme === 'light'}>
    <!-- Top Pill Tabs (matching CalendarPanel) -->
    <div class="pill-bar" role="tablist" aria-label="Intermarket radar views">
      <button
        class="pill"
        class:active={activeTab === 'symbol'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'symbol'}
        onclick={() => (activeTab = 'symbol')}
      >
        Symbol
      </button>
      <button
        class="pill"
        class:active={activeTab === 'scanner'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'scanner'}
        onclick={() => (activeTab = 'scanner')}
      >
        Scanner
      </button>
      <button
        class="pill"
        class:active={activeTab === 'scorecard'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'scorecard'}
        onclick={() => (activeTab = 'scorecard')}
      >
        Scorecard{#if signals.length > 0}&nbsp;({signals.length}){/if}
      </button>
    </div>

    <!-- Flat Toolbar Row: Timeframe + Passive Watch Toggle + Refresh -->
    <div class="sub-toolbar">
      <div class="tf-row" role="group" aria-label="Chart timeframe">
        {#each TIMEFRAMES as tf (tf.id)}
          <button
            class="outline-btn"
            class:active={timeframe === tf.id}
            type="button"
            onclick={() => selectTimeframe(tf.id)}
          >
            {tf.label}
          </button>
        {/each}
      </div>

      <div class="tool-right">
        <button
          class="outline-btn watch-btn"
          class:active={watchAlertsEnabled}
          type="button"
          title={watchAlertsEnabled
            ? 'Background Watch ON — rail dot alerts when any market hits 65+ outside news lock'
            : 'Enable Background Watch alerts on rail icon'}
          onclick={toggleWatchAlerts}
        >
          <span class="watch-dot" class:on={watchAlertsEnabled}></span>
          Watch
        </button>

        <button
          class="square-btn"
          type="button"
          title="Refresh"
          aria-label="Refresh"
          disabled={loading || scanLoading || resolving || auditLoading}
          onclick={handleRefresh}
        >
          <svg
            viewBox="0 0 16 16"
            class:spinning={loading || scanLoading || resolving || auditLoading}
            aria-hidden="true"
          >
            <path d="M13 8a5 5 0 1 1-1.35-3.4M13 3.25v2.75h-2.75" />
          </svg>
        </button>
      </div>
    </div>

    {#if feedbackNotice}
      <div class="notice-strip" role="status">{feedbackNotice}</div>
    {/if}

    <div class="scroll-area">
      {#if activeTab === 'symbol'}
        {#if loading && !payload}
          <div class="flat-empty">Comparing {activeSymbol || 'XAUUSD'} on OANDA feed…</div>
        {:else if loadError && !payload}
          <div class="flat-empty err">
            <p>{loadError}</p>
            <button
              class="outline-btn"
              type="button"
              onclick={() => void loadSymbolView(targetFullSymbol, timeframe, true)}
            >
              Retry
            </button>
          </div>
        {:else if payload}
          {@const tone = verdictTone(payload.verdict)}
          {@const fitPct = Math.round(payload.rSquared * 100)}
          {@const feed = payload.feedInfo}
          {@const evRisk = payload.eventRisk}
          {@const htf = payload.htfContext}
          {@const dLink = payload.driverLink}
          {@const candle = payload.candleConfirm}
          {@const levels = payload.setupLevels}

          <!-- Slim Flat Live Feed & Event Risk Telemetry Strip -->
          <div class="telemetry-strip">
            <div class="tele-left">
              <span class="live-dot" class:oanda={feed?.source !== 'yahoo'}></span>
              <span class="tele-strong">{feed?.label ?? 'Live Feed'}</span>
              {#if feed?.liveSpreadPx !== null && feed?.liveSpreadPx !== undefined}
                <span class="tele-sep">·</span>
                <span class:txt-warn={feed.wideSpread}>
                  Spread {feed.liveSpreadPx}
                  {#if feed.wideSpread}(Wide){/if}
                </span>
              {/if}
            </div>
            <span
              class="tele-risk"
              class:txt-bear={evRisk?.status === 'locked'}
              class:txt-warn={evRisk?.status === 'caution'}
              class:txt-bull={evRisk?.status === 'clear'}
            >
              {#if evRisk?.status === 'locked'}
                News Lock
              {:else if evRisk?.status === 'caution'}
                {evRisk.country} News &lt;2h
              {:else}
                News Clear
              {/if}
            </span>
          </div>

          <!-- Full-Bleed Event Risk Alert Strip (only when locked or upcoming <2h) -->
          {#if evRisk && evRisk.status !== 'clear'}
            <div class="risk-banner" class:locked={evRisk.status === 'locked'}>
              <strong>{evRisk.status === 'locked' ? 'Event Risk Lock' : 'Upcoming Release'}:</strong>
              {evRisk.headline}
            </div>
          {/if}

          <!-- Regime Decoupling Warning (only when short-window correlation breaks) -->
          {#if dLink && dLink.status === 'breaking' && payload.driverFitLabel !== 'Weak'}
            <div class="risk-banner">
              <strong>Drivers Decoupling:</strong> {dLink.summary}
            </div>
          {/if}

          <!-- 1. Headline Verdict & Price vs. Drivers -->
          <div class="section-strip">
            <span class="strip-title">{payload.shortName} · Price vs. Drivers</span>
            <button
              class="score-toggle"
              type="button"
              title="Click to inspect the 0–100 Setup Strength formula"
              onclick={() => (showScoreFormula = !showScoreFormula)}
            >
              Strength <strong>{payload.convictionScore}/100</strong>
              <span class="chev" class:open={showScoreFormula}>▾</span>
            </button>
          </div>

          <div class="flat-block">
            <div class="verdict-row">
              <SymbolIcon symbol={payload.shortName} size={20} />
              <span
                class="verdict-tag"
                class:bull={tone === 'bull'}
                class:bear={tone === 'bear'}
                class:warn={tone === 'warn'}
              >
                {payload.verdictLabel}
              </span>
              <span class="fit-badge" class:weak={payload.driverFitLabel === 'Weak'}>
                {payload.driverFitLabel} fit ({fitPct}%)
              </span>
            </div>

            <p class="plain-copy">{payload.verdictDetail}</p>

            {#if showScoreFormula}
              <div class="formula-note">
                <div class="formula-line">
                  <strong>How 0–100 Strength works:</strong> {payload.scoreBreakdown.explanation}
                </div>
                <div class="formula-sub">
                  Why this headline: {payload.verdictReason}
                </div>
              </div>
            {/if}

            <!-- Flat 3-Column Price Strip -->
            <div class="metrics-strip">
              <div class="m-col">
                <span class="m-lbl">Live Price</span>
                <span class="m-val">{formatRadarPrice(payload.spotPrice, payload.shortName)}</span>
              </div>
              <div class="m-col">
                <span class="m-lbl">Expected Price</span>
                <span class="m-val">{formatRadarPrice(payload.fairValuePrice, payload.shortName)}</span>
              </div>
              <div class="m-col">
                <span class="m-lbl">Stretch</span>
                <span
                  class="m-val"
                  class:txt-bear={payload.driverFitLabel !== 'Weak' && payload.zScore >= 1.5}
                  class:txt-bull={payload.driverFitLabel !== 'Weak' && payload.zScore <= -1.5}
                >
                  {formatStretchPlain(payload.zScore)}
                </span>
                <span class="m-sub">
                  {formatSigned(payload.gapPoints, payload.spotPrice < 10 ? 4 : 2)} ({formatSigned(payload.gapPct, 2)}%)
                </span>
              </div>
            </div>

            <!-- Flat 3-Column Institutional Context Strip (HTF Trend · Driver Link · Candle/Vol) -->
            {#if htf && dLink && candle}
              <div class="context-strip">
                <div class="ctx-col" title={htf.summary}>
                  <span class="m-lbl">Higher Trend</span>
                  <span
                    class="ctx-val"
                    class:txt-bull={htf.bias === 'bull'}
                    class:txt-bear={htf.bias === 'bear'}
                  >
                    {htf.biasLabel}
                  </span>
                  <span
                    class="ctx-sub"
                    class:txt-bull={htf.alignment === 'with_trend'}
                    class:txt-warn={htf.alignment === 'counter_trend'}
                  >
                    {htf.alignmentLabel}
                  </span>
                </div>

                <div class="ctx-col" title={dLink.summary}>
                  <span class="m-lbl">Driver Link</span>
                  <span
                    class="ctx-val"
                    class:txt-bull={dLink.status === 'stable'}
                    class:txt-warn={dLink.status === 'shifting'}
                    class:txt-bear={dLink.status === 'breaking'}
                  >
                    {dLink.label}
                  </span>
                  <span class="ctx-sub">{dLink.recentFitPct}% vs {dLink.baselineFitPct}%</span>
                </div>

                <div class="ctx-col">
                  <span class="m-lbl">Turn &amp; Volume</span>
                  <span class="ctx-val" class:txt-bull={candle.turnConfirmed}>
                    {candle.label}
                  </span>
                  <span class="ctx-sub">{candle.volumeLabel}</span>
                </div>
              </div>
            {/if}

            <!-- Structural Reference Levels (shown when a directional extreme exists) -->
            {#if levels && levels.invalidationLevel !== null}
              <div class="ref-levels-row">
                <div class="ref-item">
                  <span class="m-lbl">Expected Magnet</span>
                  <span class="ref-val">
                    {formatRadarPrice(levels.expectedTarget, payload.shortName)}
                    <span class="ref-note">({levels.distanceInAvgMoves.toFixed(1)}× avg move)</span>
                  </span>
                </div>
                <div class="ref-item right">
                  <span class="m-lbl">{levels.invalidationLabel ?? 'Recent Extreme'}</span>
                  <span class="ref-val">
                    {formatRadarPrice(levels.invalidationLevel, payload.shortName)}
                  </span>
                </div>
              </div>
            {/if}

            <!-- Flat Equilibrium Stretch Bar -->
            <div class="stretch-bar-wrap">
              <div class="stretch-labels">
                <span>Lagging behind</span>
                <span>In line</span>
                <span>Stretched high</span>
              </div>
              <div class="stretch-track">
                <div class="st-zone st-low"></div>
                <div class="st-zone st-high"></div>
                <div class="st-tick" style:left="16.66%"></div>
                <div class="st-tick mid" style:left="50%"></div>
                <div class="st-tick" style:left="83.33%"></div>
                <div
                  class="st-pin"
                  class:bull={payload.driverFitLabel !== 'Weak' && payload.zScore <= -1.5}
                  class:bear={payload.driverFitLabel !== 'Weak' && payload.zScore >= 1.5}
                  style:left="{zMarkerLeftPct(payload.zScore)}%"
                ></div>
              </div>
              <div class="meta-foot">
                <span>
                  Avg {tfBarLabel(timeframe)} move: <strong>{formatRadarPrice(payload.atr, payload.shortName)}</strong> ({payload.atrPct.toFixed(2)}%)
                </span>
                <span>Last {payload.horizonBars} {tfBarLabel(timeframe)} bars</span>
              </div>
            </div>

            <!-- Flat Inline Stretch History Chart -->
            {#if sparklineCoords.length >= 2}
              <div class="spark-flat">
                <div class="spark-head">
                  <span class="spark-title">Stretch history ({tfBarLabel(timeframe)})</span>
                  {#if hoveredPoint}
                    <span class="spark-val">
                      {formatShortTime(hoveredPoint.ts)} · <strong>{formatStretchPlain(hoveredPoint.z)}</strong> · Exp {formatRadarPrice(hoveredPoint.fair, payload.shortName)}
                    </span>
                  {:else}
                    <span class="spark-val">Shaded = stretched zone</span>
                  {/if}
                </div>
                <svg
                  class="spark-svg"
                  viewBox="0 0 {CHART_W} {CHART_H}"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="Recent price stretch vs drivers"
                  onpointermove={handleSparklineMove}
                  onpointerleave={() => (hoveredIdx = null)}
                >
                  <rect
                    x={CHART_PAD_X}
                    y={CHART_PAD_Y}
                    width={CHART_W - CHART_PAD_X * 2}
                    height={Math.max(0, zToY(2) - CHART_PAD_Y)}
                    class="band-high"
                  />
                  <rect
                    x={CHART_PAD_X}
                    y={zToY(-2)}
                    width={CHART_W - CHART_PAD_X * 2}
                    height={Math.max(0, CHART_H - CHART_PAD_Y - zToY(-2))}
                    class="band-low"
                  />
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
                    <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="3" class="spark-dot" />
                  {:else}
                    {@const lastPt = sparklineCoords[sparklineCoords.length - 1]}
                    <circle cx={lastPt.x} cy={lastPt.y} r="2.6" class="spark-dot" />
                  {/if}
                </svg>
              </div>
            {/if}

            <div class="action-bar">
              <button class="cta-btn" type="button" onclick={() => void handlePinSignal()}>
                Track Setup
              </button>
              <button class="outline-btn flex1" type="button" onclick={handleAlertAtFairValue}>
                Alert at Expected
              </button>
              <button class="outline-btn flex1" type="button" onclick={() => void handleSaveNote()}>
                Save Note
              </button>
            </div>
          </div>

          <!-- 2. Peer Divergences (Strict OANDA SMT) -->
          <div class="section-strip">
            <span class="strip-title">Peer Divergences (SMT)</span>
            <span class="strip-meta">
              {payload.smtSignals.length > 0 ? `${payload.smtSignals.length} fresh` : 'None active'}
            </span>
          </div>

          {#if payload.smtSignals.length > 0}
            <div class="flat-list">
              {#each payload.smtSignals as sig (sig.id)}
                <div class="list-row smt-row">
                  <div class="row-top">
                    <div class="row-left">
                      <span
                        class="dir-pill"
                        class:bull={sig.direction === 'bullish'}
                        class:bear={sig.direction === 'bearish'}
                      >
                        {sig.direction === 'bullish' ? 'Bullish Sweep' : 'Bearish Sweep'}
                      </span>
                      <span class="row-strong">{sig.levelLabel}</span>
                    </div>
                    <div class="row-right">
                      <span class="row-muted">{formatAgeCompact(sig.minutesAgo)} ago</span>
                      <button
                        class="link-btn"
                        type="button"
                        onclick={() => onSelectSymbol(sig.peerSymbol, sig.peerShortName)}
                      >
                        {sig.peerShortName} ↗
                      </button>
                    </div>
                  </div>
                  <p class="row-desc">{sig.summary}</p>
                  {#if sig.contextNote}
                    <div
                      class="smt-ctx"
                      class:txt-bull={sig.alignedWithHtf === 'with_trend'}
                      class:txt-warn={sig.alignedWithHtf === 'counter_trend'}
                    >
                      {sig.contextNote}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <div class="flat-quiet">
              No clean peer divergence right now. Flags only fire on fresh OANDA sweeps that close back inside a major level while the peer stays far away.
            </div>
          {/if}

          <!-- 3. Key Session Levels (Exact OANDA Chart Levels) -->
          {#if payload.sessionPools.length > 0}
            <div class="section-strip">
              <span class="strip-title">Key Session Levels</span>
              <span class="strip-meta">
                Swept: {payload.shortName} / {payload.sessionPools[0].peerShortName}
              </span>
            </div>

            <div class="flat-list">
              {#each payload.sessionPools as pool (pool.id)}
                <div class="list-row pool-row">
                  <span class="pool-lbl">{pool.label}</span>
                  <span class="pool-px">{formatRadarPrice(pool.targetLevel, payload.shortName)}</span>
                  <span class="pool-dist">{formatSigned(pool.distancePct, 2)}%</span>
                  <span
                    class="pool-dots"
                    title="{payload.shortName} swept: {pool.targetSwept ? 'Yes' : 'No'} · {pool.peerShortName} swept: {pool.peerSwept ? 'Yes' : 'No'}"
                  >
                    <span class="dot" class:on={pool.targetSwept}></span>
                    <span class="dot" class:on={pool.peerSwept}></span>
                    {#if pool.smtState !== 'none'}
                      <span
                        class="smt-flag"
                        class:txt-bull={pool.smtState === 'bullish'}
                        class:txt-bear={pool.smtState === 'bearish'}
                      >
                        SMT
                      </span>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          <!-- 4. What's Driving Price -->
          <div class="section-strip">
            <span class="strip-title">What's Driving {payload.shortName}</span>
            <span class="strip-meta">{payload.drivers.filter((d) => d.active).length} live</span>
          </div>

          {#if payload.leadLag}
            {@const lead = payload.leadLag}
            <button
              class="list-row lead-row"
              type="button"
              onclick={() => onSelectSymbol(lead.leaderSymbol, lead.leaderShortName)}
            >
              <span class="lead-tag">Leads</span>
              <span class="lead-copy">{lead.summary}</span>
              <span class="row-muted">↗</span>
            </button>
          {/if}

          <div class="flat-list">
            {#each payload.drivers as drv (drv.shortName)}
              <button
                class="list-row drv-row"
                class:dim={!drv.active}
                type="button"
                onclick={() => onSelectSymbol(drv.symbol, drv.shortName)}
              >
                <div class="drv-top">
                  <span class="drv-sym">{drv.shortName}</span>
                  <span class="drv-px">{formatRadarPrice(drv.price, drv.shortName)}</span>
                  <span
                    class="drv-chg"
                    class:txt-bull={drv.windowChangePct > 0.05}
                    class:txt-bear={drv.windowChangePct < -0.05}
                  >
                    {formatSigned(drv.windowChangePct, 2)}%
                  </span>
                  <span
                    class="drv-pull"
                    class:txt-bull={drv.pull === 'up'}
                    class:txt-bear={drv.pull === 'down'}
                  >
                    {drv.pull === 'up' ? 'Pulling ↑' : drv.pull === 'down' ? 'Pulling ↓' : 'Flat'}
                  </span>
                </div>
                <div class="drv-sub">
                  <span>{drv.active ? formatCorrPlain(drv.correlation) : 'Market closed'}</span>
                  <span class="drv-wt">
                    {drv.active ? `Impact ${drv.weightPct}%` : ''}
                    {#if drv.feed === 'oanda'}· OANDA{/if}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      {:else if activeTab === 'scanner'}
        <!-- Flat Cross-Market Institutional Scanner -->
        <div class="filter-strip">
          <button
            class="mini-pill"
            class:active={scanFilter === 'all'}
            type="button"
            onclick={() => (scanFilter = 'all')}
          >
            All ({scanPayload?.rows.length ?? 0})
          </button>
          <button
            class="mini-pill"
            class:active={scanFilter === 'ready'}
            type="button"
            onclick={() => (scanFilter = 'ready')}
          >
            Ready ({scanReadyCount})
          </button>
          <button
            class="mini-pill"
            class:active={scanFilter === 'stretched'}
            type="button"
            onclick={() => (scanFilter = 'stretched')}
          >
            Stretched ({scanStretchedCount})
          </button>
          <button
            class="mini-pill"
            class:active={scanFilter === 'smt'}
            type="button"
            onclick={() => (scanFilter = 'smt')}
          >
            SMT ({scanSmtCount})
          </button>
        </div>

        <div class="section-strip">
          <span class="strip-title">Markets Ranked by Setup Strength</span>
          <span class="strip-meta">
            {scanPayload?.oandaActive ? 'OANDA Live · ' : ''}0–100 score
          </span>
        </div>

        {#if scanLoading && !scanPayload}
          <div class="flat-empty">Scanning 12 OANDA markets on {tfBarLabel(timeframe)}…</div>
        {:else if scanError && !scanPayload}
          <div class="flat-empty err">
            <p>{scanError}</p>
            <button
              class="outline-btn"
              type="button"
              onclick={() => void loadScannerView(timeframe, true)}
            >
              Retry
            </button>
          </div>
        {:else if filteredScanRows.length === 0}
          <div class="flat-quiet">
            No markets match this filter right now — prices are tracking their related markets cleanly.
          </div>
        {:else}
          <div class="flat-list">
            {#each filteredScanRows as row (row.symbol)}
              {@const rTone = verdictTone(row.verdict)}
              <button
                class="list-row scan-row"
                class:current={row.shortName.toUpperCase() === (activeSymbol || '').toUpperCase()}
                type="button"
                onclick={() => {
                  onSelectSymbol(row.symbol, row.shortName);
                  activeTab = 'symbol';
                }}
              >
                <div class="row-top">
                  <div class="row-left">
                    <SymbolIcon symbol={row.shortName} size={18} />
                    <strong class="scan-sym">{row.shortName}</strong>
                    <span
                      class="verdict-tag small"
                      class:bull={rTone === 'bull'}
                      class:bear={rTone === 'bear'}
                      class:warn={rTone === 'warn'}
                    >
                      {row.verdictLabel}
                    </span>
                  </div>
                  <span class="scan-strength">
                    Strength <strong>{row.convictionScore}</strong>/100
                  </span>
                </div>

                <div class="scan-mid">
                  <span>
                    {formatRadarPrice(row.spotPrice, row.shortName)} → Exp {formatRadarPrice(row.fairValuePrice, row.shortName)}
                  </span>
                  <span
                    class="scan-stretch"
                    class:txt-bear={row.driverFitLabel !== 'Weak' && row.zScore >= 1.5}
                    class:txt-bull={row.driverFitLabel !== 'Weak' && row.zScore <= -1.5}
                  >
                    {formatStretchPlain(row.zScore)}
                  </span>
                </div>

                <div class="scan-foot">
                  <span class="scan-badges">
                    <span>{row.driverFitLabel} ({Math.round(row.rSquared * 100)}%)</span>
                    {#if row.htfBias}
                      <span
                        class="tiny-chip"
                        class:txt-bull={row.htfBias === 'bull'}
                        class:txt-bear={row.htfBias === 'bear'}
                      >
                        4H {row.htfBias === 'bull' ? '↑' : row.htfBias === 'bear' ? '↓' : '—'}
                      </span>
                    {/if}
                    {#if row.driverLinkStatus === 'breaking'}
                      <span class="tiny-chip txt-bear">Decoupling</span>
                    {/if}
                  </span>

                  {#if row.eventRiskLabel}
                    <span
                      class:txt-bear={row.eventRiskStatus === 'locked'}
                      class:txt-warn={row.eventRiskStatus === 'caution'}
                    >
                      {row.eventRiskLabel}
                    </span>
                  {:else if row.smtConflict}
                    <span class="txt-warn">Opposing sweeps</span>
                  {:else if row.topSmtLabel}
                    <span
                      class:txt-bull={row.topSmtDirection === 'bullish'}
                      class:txt-bear={row.topSmtDirection === 'bearish'}
                    >
                      {row.topSmtDirection === 'bullish' ? 'Bull' : 'Bear'}: {row.topSmtLabel}
                    </span>
                  {:else if row.htfAlignment === 'with_trend'}
                    <span class="txt-bull">With 4H Trend</span>
                  {:else}
                    <span>No fresh SMT</span>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- Dual-Track Institutional Scorecard -->
        <div class="filter-strip">
          <button
            class="mini-pill"
            class:active={scorecardSub === 'mine'}
            type="button"
            onclick={() => (scorecardSub = 'mine')}
          >
            My Setups ({signals.length})
          </button>
          <button
            class="mini-pill"
            class:active={scorecardSub === 'system'}
            type="button"
            onclick={() => (scorecardSub = 'system')}
          >
            System Audit &amp; Proof
          </button>
        </div>

        {#if scorecardSub === 'mine'}
          <div class="section-strip">
            <span class="strip-title">Live Edge Verification</span>
            <button
              class="strip-action"
              type="button"
              disabled={resolving || scorecard.pending === 0}
              onclick={() => void runSignalResolution(true)}
            >
              {resolving ? 'Checking…' : `Check Open (${scorecard.pending})`}
            </button>
          </div>

          <div class="flat-block">
            <p class="plain-copy">
              Each tracked setup is graded 8 bars later on OANDA candles after deducting live spread. Keep only once <strong>{scorecard.minSampleSize} decided setups</strong> show a 95% low bound above <strong>{scorecard.breakEvenPct}%</strong> break-even and positive average net move.
            </p>

            <div class="sc-metrics">
              <div class="m-col">
                <span class="m-lbl">Win Rate (after spread)</span>
                <span
                  class="m-val"
                  class:txt-bull={scorecard.ciLowPct !== null && scorecard.ciLowPct > scorecard.breakEvenPct}
                  class:txt-bear={scorecard.ciHighPct !== null && scorecard.ciHighPct < scorecard.breakEvenPct}
                >
                  {scorecard.hitRatePct !== null ? `${scorecard.hitRatePct}%` : '—'}
                </span>
                <span class="m-sub">
                  {scorecard.ciLowPct !== null && scorecard.ciHighPct !== null
                    ? `95% range: ${scorecard.ciLowPct}%–${scorecard.ciHighPct}%`
                    : `Break-even: ${scorecard.breakEvenPct}%`}
                </span>
              </div>

              <div class="m-col">
                <span class="m-lbl">Avg Net Move</span>
                <span
                  class="m-val"
                  class:txt-bull={scorecard.avgNetAtr !== null && scorecard.avgNetAtr >= 0.1}
                  class:txt-bear={scorecard.avgNetAtr !== null && scorecard.avgNetAtr < 0}
                >
                  {scorecard.avgNetAtr !== null ? `${formatSigned(scorecard.avgNetAtr, 2)}× avg` : '—'}
                </span>
                <span class="m-sub">
                  {scorecard.hits}W · {scorecard.misses}L ({scorecard.flats} flat)
                </span>
              </div>
            </div>

            <div class="sc-bar-wrap">
              <div class="sc-track">
                <div
                  class="sc-fill"
                  style:width="{Math.min(100, Math.round(((scorecard.hits + scorecard.misses) / scorecard.minSampleSize) * 100))}%"
                ></div>
              </div>
              <span
                class="sc-status"
                class:txt-bull={scorecard.verdict === 'keep'}
                class:txt-bear={scorecard.verdict === 'drop'}
                class:txt-warn={scorecard.verdict === 'early_warning'}
              >
                {scorecard.statusLabel}
              </span>
            </div>
          </div>

          {#if scorecard.hits + scorecard.misses > 0}
            <div class="section-strip">
              <span class="strip-title">Edge Breakdown (Session &amp; Trend)</span>
              <span class="strip-meta">After spread</span>
            </div>
            <div class="flat-list">
              {#each [...scorecard.byAlign, ...scorecard.bySession].filter((r) => r.decided > 0) as slice (slice.label)}
                <div class="list-row slice-row">
                  <span class="slice-lbl">{slice.label}</span>
                  <span class="row-muted">{slice.decided} trades</span>
                  <span class="slice-wr">{slice.winRatePct ?? 0}% WR</span>
                  <strong
                    class="slice-net"
                    class:txt-bull={(slice.avgNetAtr ?? 0) > 0}
                    class:txt-bear={(slice.avgNetAtr ?? 0) < 0}
                  >
                    {slice.avgNetAtr !== null ? `${formatSigned(slice.avgNetAtr, 2)}×` : '—'}
                  </strong>
                </div>
              {/each}
            </div>
          {/if}

          <div class="section-strip">
            <span class="strip-title">Tracked Setups</span>
            <span class="strip-meta">{signals.length} total</span>
          </div>

          {#if signals.length === 0}
            <div class="flat-quiet">
              No tracked setups yet. Click <strong>Track Setup</strong> on the Symbol tab to log a live setup with real OANDA spread and check its 8-bar outcome automatically.
            </div>
          {:else}
            <div class="flat-list">
              {#each signals as sig (sig.id)}
                <div class="list-row sig-row">
                  <div class="row-top">
                    <button
                      class="sig-sym"
                      type="button"
                      onclick={() => {
                        onSelectSymbol(sig.symbol, sig.shortName);
                        activeTab = 'symbol';
                      }}
                    >
                      <strong>{sig.shortName}</strong>
                      <span
                        class="dir-pill"
                        class:bull={sig.direction === 'long'}
                        class:bear={sig.direction === 'short'}
                      >
                        {sig.direction === 'long' ? 'Buy' : 'Sell'}
                      </span>
                      <span class="row-muted">{tfBarLabel(sig.timeframe)}</span>
                      {#if sig.session}
                        <span class="row-muted">· {sig.session}</span>
                      {/if}
                    </button>

                    <div class="row-right">
                      <span
                        class="outcome-tag"
                        class:txt-bull={sig.status === 'hit'}
                        class:txt-bear={sig.status === 'miss'}
                      >
                        {sig.status === 'hit'
                          ? 'Win'
                          : sig.status === 'miss'
                            ? 'Loss'
                            : sig.status === 'flat'
                              ? 'Flat'
                              : 'Open'}
                      </span>
                      <button
                        class="del-x"
                        type="button"
                        aria-label="Remove tracked setup"
                        onclick={() => void handleDeleteSignal(sig.id)}
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div class="sig-sub">
                    <span>
                      Entry {formatRadarPrice(sig.entryPrice, sig.shortName)} → Exp {formatRadarPrice(sig.fairValuePrice, sig.shortName)}
                    </span>
                    <span>
                      {sig.spreadSource === 'oanda' ? 'OANDA' : 'Est'} spread {sig.spreadPct.toFixed(3)}%
                    </span>
                  </div>

                  <div class="sig-sub">
                    <span>Best +{sig.maxFavorableAtr.toFixed(1)}× · Heat -{sig.maxAdverseAtr.toFixed(1)}×</span>
                    {#if sig.netReturnAtr !== null}
                      <strong class:txt-bull={sig.netReturnAtr > 0} class:txt-bear={sig.netReturnAtr < 0}>
                        Net {formatSigned(sig.netReturnAtr, 2)}×
                      </strong>
                    {:else}
                      <span>{sig.smtLabel ?? sig.verdictLabel}</span>
                    {/if}
                  </div>

                  <!-- 1-click user context tags -->
                  <div class="tag-row">
                    {#each CONTEXT_TAGS as tag (tag)}
                      <button
                        class="ctx-tag"
                        class:on={sig.contextTag === tag}
                        type="button"
                        onclick={() => void handleToggleSignalTag(sig.id, tag)}
                      >
                        {tag}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <!-- System Live Audit + Verified OANDA 9-Month Walk-Forward Benchmark -->
          <div class="section-strip">
            <span class="strip-title">OANDA 9-Month Out-of-Sample Proof</span>
            <span class="strip-meta">Real spread</span>
          </div>

          {#if auditLoading && !auditPayload}
            <div class="flat-empty">Loading System Audit &amp; OANDA benchmark…</div>
          {:else if auditError && !auditPayload}
            <div class="flat-empty err">
              <p>{auditError}</p>
              <button class="outline-btn" type="button" onclick={() => void loadAuditView(true)}>
                Retry
              </button>
            </div>
          {:else if auditPayload}
            <div class="flat-block">
              <p class="plain-copy">
                {auditPayload.oandaBenchmark.windowLabel}. This is why Radar rewards <strong>with-trend pullbacks</strong> and warns against fading counter-trend sweeps blindly.
              </p>
            </div>

            <div class="flat-list">
              {#each auditPayload.oandaBenchmark.rows as row (row.label)}
                <div class="list-row bench-row">
                  <div class="row-top">
                    <span class="row-strong">{row.label}</span>
                    <strong
                      class="slice-net"
                      class:txt-bull={row.avgNetAtr > 0}
                      class:txt-bear={row.avgNetAtr < 0}
                    >
                      {formatSigned(row.avgNetAtr, 2)}× avg
                    </strong>
                  </div>
                  <div class="sig-sub">
                    <span>N = {row.sampleSize} · {row.winRatePct}% WR (95% range {row.ciRange})</span>
                  </div>
                  <div class="bench-note">{row.note}</div>
                </div>
              {/each}
            </div>

            <div class="section-strip">
              <span class="strip-title">Live Auto-Logged Setups (1H, 62+)</span>
              <span class="strip-meta">{auditPayload.summary.total} logged</span>
            </div>

            {#if auditPayload.entries.length === 0}
              <div class="flat-quiet">
                No 1H setups have cleared 62+ strength outside news lock since the server started. Clean high-conviction setups log here automatically and self-grade 8 hours later on OANDA candles.
              </div>
            {:else}
              <div class="flat-block">
                <div class="sc-metrics">
                  <div class="m-col">
                    <span class="m-lbl">System Win Rate</span>
                    <span class="m-val">
                      {auditPayload.summary.winRatePct !== null ? `${auditPayload.summary.winRatePct}%` : '—'}
                    </span>
                    <span class="m-sub">
                      {auditPayload.summary.hits}W · {auditPayload.summary.misses}L · {auditPayload.summary.pending} open
                    </span>
                  </div>
                  <div class="m-col">
                    <span class="m-lbl">System Avg Net</span>
                    <span
                      class="m-val"
                      class:txt-bull={(auditPayload.summary.avgNetAtr ?? 0) > 0}
                      class:txt-bear={(auditPayload.summary.avgNetAtr ?? 0) < 0}
                    >
                      {auditPayload.summary.avgNetAtr !== null
                        ? `${formatSigned(auditPayload.summary.avgNetAtr, 2)}× avg`
                        : '—'}
                    </span>
                    <span class="m-sub">
                      {auditPayload.summary.ciLowPct !== null
                        ? `95% range ${auditPayload.summary.ciLowPct}%–${auditPayload.summary.ciHighPct}%`
                        : 'Awaiting 8h closes'}
                    </span>
                  </div>
                </div>
              </div>

              <div class="flat-list">
                {#each auditPayload.entries.slice(0, 15) as item (item.id)}
                  <div class="list-row sig-row">
                    <div class="row-top">
                      <span class="row-left">
                        <strong>{item.shortName}</strong>
                        <span
                          class="dir-pill"
                          class:bull={item.direction === 'long'}
                          class:bear={item.direction === 'short'}
                        >
                          {item.direction === 'long' ? 'Buy' : 'Sell'}
                        </span>
                        <span class="row-muted">{item.convictionScore}/100 · {item.session}</span>
                      </span>
                      <span
                        class="outcome-tag"
                        class:txt-bull={item.status === 'hit'}
                        class:txt-bear={item.status === 'miss'}
                      >
                        {item.status === 'hit'
                          ? 'Win'
                          : item.status === 'miss'
                            ? 'Loss'
                            : item.status === 'flat'
                              ? 'Flat'
                              : 'Open'}
                      </span>
                    </div>
                    <div class="sig-sub">
                      <span>{item.setupKind}</span>
                      {#if item.netReturnAtr !== null}
                        <strong class:txt-bull={item.netReturnAtr > 0} class:txt-bear={item.netReturnAtr < 0}>
                          Net {formatSigned(item.netReturnAtr, 2)}×
                        </strong>
                      {:else}
                        <span>Entry {formatRadarPrice(item.entryPrice, item.shortName)}</span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        {/if}
      {/if}
    </div>
  </div>
</PanelShell>

<style>
  /* Pure Flat Design matching CalendarPanel.svelte — zero boxed cards, hairline dividers */
  .radar {
    --rd-bg: var(--dark-bg-panel);
    --rd-border: var(--dark-border);
    --rd-divider: var(--dark-border);
    --rd-strip-bg: var(--dark-bg-subtle);
    --rd-pill-bg: var(--dark-bg-surface-alt);
    --rd-pill-active-bg: var(--dark-cta-bg);
    --rd-pill-active-fg: var(--dark-cta-fg);
    --rd-text: var(--dark-text-primary);
    --rd-secondary: var(--dark-text-secondary);
    --rd-hover: var(--dark-hover);
    --rd-bull: #089981;
    --rd-bear: #f23645;
    --rd-warn: #e0a82e;

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--rd-text);
    background: var(--rd-bg);
  }

  .radar.light {
    --rd-bg: #ffffff;
    --rd-border: #e0e3eb;
    --rd-divider: #f0f2f5;
    --rd-strip-bg: #f9f9f9;
    --rd-pill-bg: #f2f2f2;
    --rd-pill-active-bg: #222222;
    --rd-pill-active-fg: #ffffff;
    --rd-text: #131722;
    --rd-secondary: #6a6d78;
    --rd-hover: rgba(0, 0, 0, 0.03);
    --rd-warn: #b57a00;
  }

  .pill-bar {
    padding: 0 16px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    user-select: none;
  }

  .pill {
    height: 30px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    background: var(--rd-pill-bg);
    color: var(--rd-text);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .pill.active {
    background: var(--rd-pill-active-bg);
    color: var(--rd-pill-active-fg);
    font-weight: 600;
  }

  .sub-toolbar {
    padding: 0 16px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
  }

  .tf-row,
  .tool-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .outline-btn {
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--rd-border);
    border-radius: 8px;
    background: transparent;
    color: var(--rd-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .outline-btn:hover {
    background: var(--rd-hover);
    color: var(--rd-text);
  }

  .outline-btn.active {
    border-color: var(--rd-text);
    color: var(--rd-text);
    font-weight: 600;
  }

  .outline-btn.flex1 {
    flex: 1;
    color: var(--rd-text);
  }

  .watch-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
  }

  .watch-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--rd-secondary);
    opacity: 0.45;
  }

  .watch-dot.on {
    background: var(--rd-bull);
    opacity: 1;
  }

  .square-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--rd-border);
    border-radius: 8px;
    background: transparent;
    color: var(--rd-text);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .square-btn:hover:not(:disabled) {
    background: var(--rd-hover);
  }

  .square-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .square-btn svg.spinning {
    animation: rd-spin 0.9s linear infinite;
  }

  @keyframes rd-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .notice-strip {
    padding: 8px 16px;
    border-top: 1px solid var(--rd-border);
    border-bottom: 1px solid var(--rd-border);
    background: rgba(8, 153, 129, 0.12);
    font-size: 12px;
    color: var(--rd-text);
    flex: 0 0 auto;
  }

  .scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
  }

  .scroll-area::-webkit-scrollbar {
    display: none;
  }

  /* Live OANDA & Event Risk Telemetry Strip */
  .telemetry-strip {
    padding: 7px 16px;
    border-top: 1px solid var(--rd-divider);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .tele-left {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--rd-secondary);
    flex-shrink: 0;
  }

  .live-dot.oanda {
    background: var(--rd-bull);
  }

  .tele-strong {
    color: var(--rd-text);
    font-weight: 600;
  }

  .tele-sep {
    opacity: 0.5;
  }

  .tele-risk {
    font-weight: 600;
    white-space: nowrap;
  }

  .risk-banner {
    padding: 8px 16px;
    border-top: 1px solid var(--rd-divider);
    border-left: 2px solid var(--rd-warn);
    background: rgba(224, 168, 46, 0.1);
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--rd-text);
  }

  .risk-banner.locked {
    border-left-color: var(--rd-bear);
    background: rgba(242, 54, 69, 0.12);
  }

  /* Full-bleed flat section heading matching CalendarPanel */
  .section-strip {
    min-height: 35px;
    padding: 0 16px 0 14px;
    background: var(--rd-strip-bg);
    border-top: 1px solid var(--rd-divider);
    border-bottom: 1px solid var(--rd-divider);
    border-left: 2px solid var(--rd-text);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    user-select: none;
  }

  .strip-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--rd-text);
  }

  .strip-meta {
    font-size: 11.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .score-toggle,
  .strip-action {
    border: 0;
    background: transparent;
    color: var(--rd-text);
    font: inherit;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 2px 0;
    font-variant-numeric: tabular-nums;
  }

  .score-toggle:hover,
  .strip-action:hover:not(:disabled) {
    text-decoration: underline;
  }

  .strip-action:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .chev {
    display: inline-block;
    font-size: 11px;
    color: var(--rd-secondary);
    transition: transform 140ms ease;
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .flat-block {
    padding: 13px 16px;
    display: flex;
    flex-direction: column;
    gap: 11px;
  }

  .verdict-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
  }

  .verdict-tag {
    font-size: 11.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--rd-pill-bg);
    color: var(--rd-text);
  }

  .verdict-tag.small {
    font-size: 10.5px;
    padding: 1px 7px;
  }

  .verdict-tag.bull {
    background: rgba(8, 153, 129, 0.16);
    color: var(--rd-bull);
  }

  .verdict-tag.bear {
    background: rgba(242, 54, 69, 0.16);
    color: var(--rd-bear);
  }

  .verdict-tag.warn {
    background: rgba(224, 168, 46, 0.18);
    color: var(--rd-warn);
  }

  .fit-badge {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .fit-badge.weak {
    color: var(--rd-warn);
    font-weight: 600;
  }

  .plain-copy {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--rd-secondary);
  }

  .formula-note {
    padding: 8px 0 8px 10px;
    border-left: 2px solid var(--rd-border);
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--rd-text);
  }

  .formula-sub {
    color: var(--rd-secondary);
  }

  /* Flat 3-column metrics strip */
  .metrics-strip,
  .context-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border-top: 1px solid var(--rd-divider);
    border-bottom: 1px solid var(--rd-divider);
  }

  .context-strip {
    border-top: 0;
    margin-top: -11px;
  }

  .sc-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-top: 1px solid var(--rd-divider);
    border-bottom: 1px solid var(--rd-divider);
  }

  .m-col,
  .ctx-col {
    padding: 9px 6px 9px 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .m-col + .m-col,
  .ctx-col + .ctx-col {
    padding-left: 10px;
    border-left: 1px solid var(--rd-divider);
  }

  .m-lbl {
    font-size: 10.5px;
    color: var(--rd-secondary);
  }

  .m-val {
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ctx-val {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-sub,
  .ctx-sub {
    font-size: 10.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ref-levels-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding-bottom: 9px;
    border-bottom: 1px solid var(--rd-divider);
    font-variant-numeric: tabular-nums;
  }

  .ref-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ref-item.right {
    text-align: right;
  }

  .ref-val {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--rd-text);
  }

  .ref-note {
    font-weight: 400;
    font-size: 11px;
    color: var(--rd-secondary);
  }

  /* Equilibrium stretch bar */
  .stretch-bar-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .stretch-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10.5px;
    color: var(--rd-secondary);
  }

  .stretch-track {
    position: relative;
    height: 7px;
    border-radius: 999px;
    background: var(--rd-pill-bg);
  }

  .st-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 16.66%;
  }

  .st-low {
    left: 0;
    background: rgba(8, 153, 129, 0.28);
    border-radius: 999px 0 0 999px;
  }

  .st-high {
    right: 0;
    background: rgba(242, 54, 69, 0.28);
    border-radius: 0 999px 999px 0;
  }

  .st-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--rd-border);
  }

  .st-tick.mid {
    background: var(--rd-secondary);
    opacity: 0.65;
  }

  .st-pin {
    position: absolute;
    top: 50%;
    width: 9px;
    height: 13px;
    border-radius: 3px;
    background: var(--rd-text);
    transform: translate(-50%, -50%);
    transition: left 180ms ease;
  }

  .st-pin.bull {
    background: var(--rd-bull);
  }

  .st-pin.bear {
    background: var(--rd-bear);
  }

  .meta-foot {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .meta-foot strong {
    color: var(--rd-text);
    font-weight: 600;
  }

  /* Flat sparkline */
  .spark-flat {
    padding-top: 8px;
    border-top: 1px solid var(--rd-divider);
  }

  .spark-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 5px;
  }

  .spark-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--rd-secondary);
  }

  .spark-val {
    font-size: 10.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .spark-val strong {
    color: var(--rd-text);
  }

  .spark-svg {
    width: 100%;
    height: 70px;
    display: block;
    cursor: crosshair;
  }

  .band-high {
    fill: rgba(242, 54, 69, 0.08);
  }

  .band-low {
    fill: rgba(8, 153, 129, 0.08);
  }

  .ref-line {
    stroke: var(--rd-border);
    stroke-width: 1;
  }

  .ref-line.dash {
    stroke-dasharray: 3 3;
  }

  .ref-line.mid {
    opacity: 0.7;
  }

  .spark-line {
    fill: none;
    stroke: var(--rd-text);
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .hover-guide {
    stroke: var(--rd-secondary);
    stroke-width: 1;
    stroke-dasharray: 2 2;
  }

  .spark-dot {
    fill: var(--rd-text);
  }

  .action-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
  }

  .cta-btn {
    flex: 1;
    height: 30px;
    padding: 0 11px;
    border: 0;
    border-radius: 8px;
    background: var(--rd-pill-active-bg);
    color: var(--rd-pill-active-fg);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .cta-btn:hover {
    opacity: 0.9;
  }

  /* Hairline-divided flat lists */
  .flat-list {
    display: flex;
    flex-direction: column;
  }

  .list-row {
    width: 100%;
    padding: 10px 16px;
    border: 0;
    border-bottom: 1px solid var(--rd-divider);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  button.list-row {
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  button.list-row:hover {
    background: var(--rd-hover);
  }

  .smt-row,
  .scan-row,
  .sig-row,
  .bench-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .row-left,
  .row-right {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .row-strong {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--rd-text);
  }

  .row-muted {
    font-size: 11px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .row-desc {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--rd-secondary);
  }

  .smt-ctx {
    font-size: 11px;
    font-weight: 500;
    color: var(--rd-secondary);
  }

  .dir-pill {
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 999px;
  }

  .dir-pill.bull {
    background: rgba(8, 153, 129, 0.16);
    color: var(--rd-bull);
  }

  .dir-pill.bear {
    background: rgba(242, 54, 69, 0.16);
    color: var(--rd-bear);
  }

  .link-btn {
    border: 0;
    background: transparent;
    color: var(--rd-text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    padding: 0;
    cursor: pointer;
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .pool-row {
    display: grid;
    grid-template-columns: 1.3fr 1fr 0.72fr auto;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .pool-lbl {
    color: var(--rd-secondary);
    font-weight: 500;
  }

  .pool-px {
    font-weight: 600;
    text-align: right;
  }

  .pool-dist {
    font-size: 11px;
    color: var(--rd-secondary);
    text-align: right;
  }

  .pool-dots {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 44px;
    justify-content: flex-end;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1px solid var(--rd-secondary);
    opacity: 0.45;
  }

  .dot.on {
    background: var(--rd-text);
    border-color: var(--rd-text);
    opacity: 1;
  }

  .smt-flag {
    font-size: 10px;
    font-weight: 700;
  }

  .lead-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
  }

  .lead-tag {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--rd-pill-bg);
    color: var(--rd-text);
    flex-shrink: 0;
  }

  .lead-copy {
    flex: 1;
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--rd-secondary);
  }

  .drv-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .drv-row.dim {
    opacity: 0.45;
  }

  .drv-top {
    display: grid;
    grid-template-columns: 1.05fr 0.95fr 0.72fr auto;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  .drv-sym {
    font-weight: 700;
  }

  .drv-px,
  .drv-chg {
    text-align: right;
  }

  .drv-pull {
    font-size: 11px;
    font-weight: 600;
    text-align: right;
    min-width: 62px;
  }

  .drv-sub {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--rd-secondary);
  }

  .drv-wt {
    font-variant-numeric: tabular-nums;
  }

  /* Scanner filters & rows */
  .filter-strip {
    padding: 0 16px 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .mini-pill {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--rd-border);
    border-radius: 999px;
    background: transparent;
    color: var(--rd-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }

  .mini-pill.active {
    background: var(--rd-pill-active-bg);
    border-color: var(--rd-pill-active-bg);
    color: var(--rd-pill-active-fg);
    font-weight: 600;
  }

  .scan-row.current {
    border-left: 2px solid var(--rd-text);
    padding-left: 14px;
  }

  .scan-sym {
    font-size: 13px;
    font-weight: 700;
  }

  .scan-strength {
    font-size: 11.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .scan-strength strong {
    color: var(--rd-text);
    font-weight: 700;
  }

  .scan-mid {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .scan-stretch {
    font-weight: 600;
    color: var(--rd-text);
  }

  .scan-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--rd-secondary);
  }

  .scan-badges {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }

  .tiny-chip {
    font-size: 10px;
    font-weight: 600;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--rd-pill-bg);
    color: var(--rd-text);
  }

  /* Scorecard & Audit */
  .sc-bar-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .sc-track {
    height: 6px;
    border-radius: 999px;
    background: var(--rd-pill-bg);
    overflow: hidden;
  }

  .sc-fill {
    height: 100%;
    background: var(--rd-text);
    transition: width 220ms ease;
  }

  .sc-status {
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--rd-secondary);
  }

  .slice-row {
    display: grid;
    grid-template-columns: 1.35fr 0.85fr 0.7fr auto;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .slice-lbl {
    font-weight: 600;
    color: var(--rd-text);
  }

  .slice-wr {
    text-align: right;
    color: var(--rd-secondary);
  }

  .slice-net {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .sig-sym {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .sig-sub {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    color: var(--rd-secondary);
    font-variant-numeric: tabular-nums;
  }

  .tag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    padding-top: 2px;
  }

  .ctx-tag {
    height: 20px;
    padding: 0 7px;
    border: 1px solid var(--rd-border);
    border-radius: 999px;
    background: transparent;
    color: var(--rd-secondary);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }

  .ctx-tag.on {
    border-color: var(--rd-text);
    background: var(--rd-pill-bg);
    color: var(--rd-text);
    font-weight: 600;
  }

  .bench-note {
    font-size: 11px;
    color: var(--rd-secondary);
    opacity: 0.9;
  }

  .outcome-tag {
    font-size: 11px;
    font-weight: 700;
  }

  .del-x {
    border: 0;
    background: transparent;
    color: var(--rd-secondary);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }

  .del-x:hover {
    color: var(--rd-text);
  }

  .flat-quiet {
    padding: 13px 16px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--rd-secondary);
    border-bottom: 1px solid var(--rd-divider);
  }

  .flat-empty {
    padding: 28px 16px;
    text-align: center;
    font-size: 12.5px;
    color: var(--rd-secondary);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  .flat-empty.err {
    color: var(--rd-bear);
  }

  .txt-bull {
    color: var(--rd-bull);
  }

  .txt-bear {
    color: var(--rd-bear);
  }

  .txt-warn {
    color: var(--rd-warn);
  }
</style>
