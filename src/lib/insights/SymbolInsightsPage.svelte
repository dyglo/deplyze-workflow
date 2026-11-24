<script lang="ts">
  import { untrack } from 'svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import RatingGauge from './RatingGauge.svelte';
  import SeasonalsView from './SeasonalsView.svelte';
  import {
    MORE_TIMEFRAMES,
    PRIMARY_TIMEFRAMES,
    fetchSymbolSeasonals,
    fetchSymbolTechnicals,
    formatIndicatorNumber,
    type InsightsViewId,
    type PivotRow,
    type RatingLabel,
    type SymbolSeasonalsPayload,
    type SymbolTechnicalsPayload,
    type TechnicalsInterval
  } from './symbolInsightsApi';
  import {
    fetchNewsArticle,
    fetchNewsFlow,
    formatArticleMetaDate,
    formatReadTime,
    formatTimeAgo,
    type NewsArticlePayload,
    type NewsFlowItem
  } from '../news/api';
  import { saveNewsItemToNotes } from '../notes/api';
  import { formatQuotePct, formatQuotePrice } from '../watchlist/store';

  interface Props {
    theme: 'dark' | 'light';
    symbol: string;
    shortName: string;
    description: string;
    view: InsightsViewId;
    livePrice?: number;
    liveChangePercent?: number;
    onChangeView: (next: InsightsViewId) => void;
    onClose: () => void;
  }

  let {
    theme,
    symbol,
    shortName,
    description,
    view,
    livePrice = undefined,
    liveChangePercent = undefined,
    onChangeView,
    onClose
  }: Props = $props();

  const VIEW_LABELS: Record<InsightsViewId, string> = {
    technicals: 'Technicals',
    seasonals: 'Seasonals',
    news: 'News',
    volatility: 'Volatility & Levels'
  };

  // Technicals state
  let interval = $state<TechnicalsInterval>('1D');
  let moreMenuOpen = $state(false);
  let techData = $state<SymbolTechnicalsPayload | null>(null);
  let techLoading = $state(false);
  let techError = $state<string | null>(null);
  let selectedPivotMethod = $state<PivotRow['method']>('Classic');

  // Seasonals & Volatility state
  let seasonalsData = $state<SymbolSeasonalsPayload | null>(null);
  let seasonalsLoading = $state(false);
  let seasonalsError = $state<string | null>(null);
  let dowHorizon = $state<'1Y' | '5Y'>('1Y');

  // Symbol News state
  let newsItems = $state<NewsFlowItem[]>([]);
  let newsLoading = $state(false);
  let newsError = $state<string | null>(null);
  let selectedNewsId = $state<string | null>(null);
  let selectedArticle = $state<NewsArticlePayload | null>(null);
  let selectedArticleLoading = $state(false);

  // Quick Save to Notes feedback
  let savedSnapshot = $state(false);

  let techAbort: AbortController | undefined;
  let seasonalsAbort: AbortController | undefined;
  let newsAbort: AbortController | undefined;
  let techSeq = 0;
  let seasonalsSeq = 0;
  let newsSeq = 0;
  let lastTechKey = '';
  let lastSeasonalsSym = '';
  let lastNewsSym = '';

  async function loadTechnicals(sym: string, ivl: TechnicalsInterval, force = false) {
    techAbort?.abort();
    const controller = new AbortController();
    techAbort = controller;
    const seq = ++techSeq;
    const reqKey = `${sym}|${ivl}`;
    const changed = reqKey !== lastTechKey;
    lastTechKey = reqKey;

    if (changed || !untrack(() => techData)) {
      techLoading = true;
    }
    techError = null;
    try {
      const payload = await fetchSymbolTechnicals(sym, ivl, controller.signal, force);
      if (seq !== techSeq) return;
      techData = payload;
    } catch (err) {
      if (seq !== techSeq || (err as Error)?.name === 'AbortError') return;
      techError = (err as Error)?.message || 'Failed to load technical ratings.';
    }
    if (seq === techSeq) {
      techLoading = false;
    }
  }

  async function loadSeasonals(sym: string, force = false) {
    seasonalsAbort?.abort();
    const controller = new AbortController();
    seasonalsAbort = controller;
    const seq = ++seasonalsSeq;
    const changed = sym !== lastSeasonalsSym;
    lastSeasonalsSym = sym;

    if (changed) {
      seasonalsData = null;
    }
    seasonalsLoading = true;
    seasonalsError = null;
    try {
      const payload = await fetchSymbolSeasonals(sym, controller.signal, force);
      if (seq !== seasonalsSeq) return;
      seasonalsData = payload;
    } catch (err) {
      if (seq !== seasonalsSeq || (err as Error)?.name === 'AbortError') return;
      seasonalsError = (err as Error)?.message || 'Failed to load seasonal history.';
    }
    if (seq === seasonalsSeq) {
      seasonalsLoading = false;
    }
  }

  async function loadSymbolNews(sym: string, force = false) {
    newsAbort?.abort();
    const controller = new AbortController();
    newsAbort = controller;
    const seq = ++newsSeq;
    const changed = sym !== lastNewsSym;
    lastNewsSym = sym;

    if (changed) {
      newsItems = [];
      selectedNewsId = null;
      selectedArticle = null;
    }
    newsLoading = true;
    newsError = null;
    try {
      const res = await fetchNewsFlow({ mode: 'symbol', symbol: sym, force }, controller.signal);
      if (seq !== newsSeq) return;
      newsItems = res.items;
    } catch (err) {
      if (seq !== newsSeq || (err as Error)?.name === 'AbortError') return;
      newsError = (err as Error)?.message || 'Failed to load symbol news.';
    }
    if (seq === newsSeq) {
      newsLoading = false;
    }
  }

  // Fetch Technicals when Technicals or Volatility view is active (or symbol/interval changes)
  $effect(() => {
    const sym = symbol;
    const ivl = interval;
    const activeView = view;
    if (!sym || (activeView !== 'technicals' && activeView !== 'volatility')) return;
    untrack(() => {
      void loadTechnicals(sym, ivl, false);
    });
  });

  // Fetch Seasonals when Seasonals or Volatility view is active (or symbol changes)
  $effect(() => {
    const sym = symbol;
    const activeView = view;
    if (!sym || (activeView !== 'seasonals' && activeView !== 'volatility')) return;
    untrack(() => {
      if (sym !== lastSeasonalsSym || !seasonalsData) {
        void loadSeasonals(sym, false);
      }
    });
  });

  // Fetch Symbol News when News view is active (uses existing 15m backend + 5m client cache)
  $effect(() => {
    const sym = symbol;
    const activeView = view;
    if (!sym || activeView !== 'news') return;
    untrack(() => {
      if (sym !== lastNewsSym || newsItems.length === 0) {
        void loadSymbolNews(sym, false);
      }
    });
  });

  // Cleanup active fetches on unmount
  $effect(() => {
    return () => {
      techAbort?.abort();
      seasonalsAbort?.abort();
      newsAbort?.abort();
    };
  });

  const resolvedTitle = $derived(
    techData?.description || seasonalsData?.description || description || shortName
  );
  const displayPrice = $derived(
    techData?.price ?? livePrice ?? seasonalsData?.volatility?.lastPrice ?? null
  );
  const displayPct = $derived(techData?.changePercent ?? liveChangePercent ?? null);

  const activeMoreLabel = $derived(
    MORE_TIMEFRAMES.find((t) => t.id === interval)?.label ?? null
  );

  const selectedPivotRow = $derived(
    techData?.pivots.find((p) => p.method === selectedPivotMethod) ?? techData?.pivots[0] ?? null
  );

  const selectedNewsItem = $derived(
    selectedNewsId ? (newsItems.find((n) => n.id === selectedNewsId) ?? null) : null
  );

  // Load permitted full article text when reading a public-domain item in News view
  $effect(() => {
    const item = selectedNewsItem;
    return untrack(() => {
      if (!item || item.displayMode !== 'full') {
        selectedArticle = null;
        selectedArticleLoading = false;
        return;
      }
      let cancelled = false;
      const controller = new AbortController();
      selectedArticleLoading = true;
      selectedArticle = null;
      void fetchNewsArticle(item.url, controller.signal)
        .then((res) => {
          if (!cancelled) {
            selectedArticle = res;
            selectedArticleLoading = false;
          }
        })
        .catch(() => {
          if (!cancelled) {
            selectedArticle = null;
            selectedArticleLoading = false;
          }
        });
      return () => {
        cancelled = true;
        controller.abort();
      };
    });
  });

  function ratingClass(rating: RatingLabel): string {
    if (rating === 'Strong sell' || rating === 'Sell') return 'sell';
    if (rating === 'Strong buy' || rating === 'Buy') return 'buy';
    return 'neutral';
  }

  async function saveInsightsSnapshotToNotes() {
    const lines: string[] = [];
    if (displayPrice != null) {
      lines.push(
        `Price: ${formatQuotePrice(displayPrice, shortName)} (${formatQuotePct(displayPct)})`
      );
    }
    if (techData) {
      lines.push(
        `Technicals (${techData.interval}): Summary ${techData.summary.rating} (Sell ${techData.summary.sell} / Neutral ${techData.summary.neutral} / Buy ${techData.summary.buy})`
      );
      lines.push(
        `• Oscillators: ${techData.oscillatorsGauge.rating} (${techData.oscillatorsGauge.sell}/${techData.oscillatorsGauge.neutral}/${techData.oscillatorsGauge.buy})`
      );
      lines.push(
        `• Moving Averages: ${techData.movingAveragesGauge.rating} (${techData.movingAveragesGauge.sell}/${techData.movingAveragesGauge.neutral}/${techData.movingAveragesGauge.buy})`
      );
      if (techData.mtfOverview.length > 0) {
        lines.push(
          `MTF Bias: ${techData.mtfOverview.map((m) => `${m.label} ${m.summaryRating}`).join(' · ')}`
        );
      }
    }
    if (seasonalsData?.volatility) {
      const v = seasonalsData.volatility;
      lines.push('');
      if (v.atr14 != null && v.adr20 != null) {
        lines.push(
          `Volatility: ATR(14) ${formatIndicatorNumber(v.atr14, shortName)} (${v.atr14Pct}%) · 20D ADR ${formatIndicatorNumber(v.adr20, shortName)} (${v.adr20Pct}%) · Today ${v.todayRangePctOfAdr ?? 0}% of ADR`
        );
      }
      if (v.week52High != null && v.week52Low != null) {
        lines.push(
          `52W Range: ${formatIndicatorNumber(v.week52Low, shortName)} – ${formatIndicatorNumber(v.week52High, shortName)} (at ${v.week52PositionPct ?? 0}%)`
        );
      }
    }
    if (seasonalsData && seasonalsData.years.length > 0) {
      const cur = seasonalsData.years[seasonalsData.years.length - 1];
      lines.push(`Seasonals YTD (${cur.year}): ${cur.totalPct > 0 ? '+' : ''}${cur.totalPct.toFixed(2)}%`);
    }

    try {
      await saveNewsItemToNotes({
        title: `${shortName} Insights Snapshot (${VIEW_LABELS[view]})`,
        body: lines.join('\n') || `${shortName} (${resolvedTitle}) insights review.`,
        symbol: shortName,
        fullSymbol: symbol
      });
      savedSnapshot = true;
      setTimeout(() => {
        savedSnapshot = false;
      }, 2000);
    } catch {
      // ignore
    }
  }

  function onWindowPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (moreMenuOpen && target && !target.closest('[data-tf-more]')) {
      moreMenuOpen = false;
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (moreMenuOpen) {
        moreMenuOpen = false;
      } else if (selectedNewsId) {
        selectedNewsId = null;
      } else {
        onClose();
      }
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<section
  class="insights-overlay"
  class:light={theme === 'light'}
  aria-label="{resolvedTitle} {VIEW_LABELS[view]}"
>
  <!-- Top Header matching TradingView Screenshots 6–9 -->
  <header class="ins-header">
    <div class="ins-title-cluster">
      <SymbolIcon symbol={shortName} size={22} />
      <h1 class="ins-sym-title">{resolvedTitle}</h1>
      <span class="ins-dot" aria-hidden="true">•</span>
      <span class="ins-view-name">{VIEW_LABELS[view]}</span>
    </div>

    <div class="ins-header-center">
      <div class="view-tabs" role="tablist" aria-label="Symbol insights views">
        {#each [
          { id: 'technicals' as InsightsViewId, label: 'Technicals' },
          { id: 'seasonals' as InsightsViewId, label: 'Seasonals' },
          { id: 'news' as InsightsViewId, label: 'News' },
          { id: 'volatility' as InsightsViewId, label: 'Volatility & Levels' }
        ] as tab (tab.id)}
          <button
            class="view-tab"
            class:active={view === tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            onclick={() => onChangeView(tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="ins-header-right">
      {#if displayPrice != null}
        <div class="ins-price-pill">
          <span class="ins-price">{formatQuotePrice(displayPrice, shortName)}</span>
          {#if displayPct != null}
            <span class="ins-pct" class:up={displayPct > 0} class:down={displayPct < 0}>
              {formatQuotePct(displayPct)}
            </span>
          {/if}
        </div>
      {/if}

      <button
        class="ins-note-btn"
        class:done={savedSnapshot}
        type="button"
        title="Save technical & volatility snapshot to Notes"
        onclick={() => void saveInsightsSnapshotToNotes()}
      >
        {#if savedSnapshot}
          Saved to Notes
        {:else}
          Save to Notes
        {/if}
      </button>

      <button
        class="ins-close-btn"
        type="button"
        aria-label="Close Symbol Insights and return to chart"
        title="Close (Esc)"
        onclick={onClose}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="m4.5 4.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>
  </header>

  <!-- ==================== VIEW 1: TECHNICALS ==================== -->
  {#if view === 'technicals'}
    <div class="tech-tf-bar">
      <div class="tf-pills" role="tablist" aria-label="Technicals timeframe">
        {#each PRIMARY_TIMEFRAMES as tf (tf.id)}
          <button
            class="tf-btn"
            class:active={interval === tf.id}
            type="button"
            role="tab"
            aria-selected={interval === tf.id}
            onclick={() => {
              interval = tf.id;
              moreMenuOpen = false;
            }}
          >
            {tf.label}
          </button>
        {/each}

        <div class="tf-more-anchor" data-tf-more="true">
          <button
            class="tf-btn more-btn"
            class:active={Boolean(activeMoreLabel)}
            type="button"
            aria-expanded={moreMenuOpen}
            onclick={() => (moreMenuOpen = !moreMenuOpen)}
          >
            <span>{activeMoreLabel ?? 'More'}</span>
            <svg class="tf-chev" class:open={moreMenuOpen} viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" />
            </svg>
          </button>

          {#if moreMenuOpen}
            <div class="tf-more-menu">
              {#each MORE_TIMEFRAMES as tf (tf.id)}
                <button
                  class="tf-more-item"
                  class:active={interval === tf.id}
                  type="button"
                  onclick={() => {
                    interval = tf.id;
                    moreMenuOpen = false;
                  }}
                >
                  {tf.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <button
        class="tech-refresh-btn"
        type="button"
        title="Refresh live technicals"
        disabled={techLoading}
        onclick={() => void loadTechnicals(symbol, interval, true)}
      >
        <svg class:spin={techLoading} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.35-3.42M13 3.25v2.5h-2.5" />
        </svg>
      </button>
    </div>

    <div class="ins-scroll">
      {#if techLoading && !techData}
        <div class="ins-state">
          <div class="ins-spinner"></div>
          <span>Calculating live {shortName} technical ratings…</span>
        </div>
      {:else if techError && !techData}
        <div class="ins-state">
          <p class="ins-err">{techError}</p>
          <button
            class="ins-retry-btn"
            type="button"
            onclick={() => void loadTechnicals(symbol, interval, true)}
          >
            Try again
          </button>
        </div>
      {:else if techData}
        <div class="tech-content">
          <!-- Hero Summary Gauge + Oscillators & Moving Averages Gauges (Screenshots 6 & 9) -->
          <div class="gauges-hero">
            <RatingGauge {theme} title="Summary" gauge={techData.summary} size="hero" />
          </div>

          <div class="gauges-pair">
            <RatingGauge {theme} title="Oscillators" gauge={techData.oscillatorsGauge} size="compact" />
            <RatingGauge
              {theme}
              title="Moving Averages"
              gauge={techData.movingAveragesGauge}
              size="compact"
            />
          </div>

          <!-- Scrollable TradingView Indicator Breakdown Tables -->
          {#if techData.oscillators.length > 0 || techData.movingAverages.length > 0}
            <div class="tables-grid">
              <div class="ind-card">
                <div class="ind-card-head">
                  <h2>Oscillators</h2>
                  <span class="ind-rating-badge {ratingClass(techData.oscillatorsGauge.rating)}">
                    {techData.oscillatorsGauge.rating}
                  </span>
                </div>
                <table class="ind-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th class="num">Value</th>
                      <th class="act">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each techData.oscillators as row (row.name)}
                      <tr>
                        <td class="ind-name">{row.name}</td>
                        <td class="num">{formatIndicatorNumber(row.value, shortName)}</td>
                        <td class="act">
                          <span class="act-txt {row.action.toLowerCase()}">{row.action}</span>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <div class="ind-card">
                <div class="ind-card-head">
                  <h2>Moving Averages</h2>
                  <span class="ind-rating-badge {ratingClass(techData.movingAveragesGauge.rating)}">
                    {techData.movingAveragesGauge.rating}
                  </span>
                </div>
                <table class="ind-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th class="num">Value</th>
                      <th class="act">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each techData.movingAverages as row (row.name)}
                      <tr>
                        <td class="ind-name">{row.name}</td>
                        <td class="num">{formatIndicatorNumber(row.value, shortName)}</td>
                        <td class="act">
                          <span class="act-txt {row.action.toLowerCase()}">{row.action}</span>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}

          <!-- Pivots Section (Classic, Fibonacci, Camarilla, Woodie, DM) -->
          {#if techData.pivots.length > 0 && selectedPivotRow}
            <div class="pivots-card">
              <div class="pivots-head">
                <h2>Pivots</h2>
                <div class="pivot-tabs">
                  {#each techData.pivots as p (p.method)}
                    <button
                      class="pivot-tab"
                      class:active={selectedPivotMethod === p.method}
                      type="button"
                      onclick={() => (selectedPivotMethod = p.method)}
                    >
                      {p.method}
                    </button>
                  {/each}
                </div>
              </div>

              <div class="pivot-grid">
                {#each [
                  { k: 'S3', v: selectedPivotRow.s3, tone: 'sup' },
                  { k: 'S2', v: selectedPivotRow.s2, tone: 'sup' },
                  { k: 'S1', v: selectedPivotRow.s1, tone: 'sup' },
                  { k: 'P', v: selectedPivotRow.p, tone: 'mid' },
                  { k: 'R1', v: selectedPivotRow.r1, tone: 'res' },
                  { k: 'R2', v: selectedPivotRow.r2, tone: 'res' },
                  { k: 'R3', v: selectedPivotRow.r3, tone: 'res' }
                ] as cell (cell.k)}
                  <div class="pivot-cell {cell.tone}">
                    <span class="pivot-k">{cell.k}</span>
                    <span class="pivot-v">{formatIndicatorNumber(cell.v, shortName)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

  <!-- ==================== VIEW 2: SEASONALS ==================== -->
  {:else if view === 'seasonals'}
    <SeasonalsView
      {theme}
      data={seasonalsData}
      loading={seasonalsLoading}
      error={seasonalsError}
      onRetry={() => void loadSeasonals(symbol, true)}
    />

  <!-- ==================== VIEW 3: SYMBOL NEWS ==================== -->
  {:else if view === 'news'}
    <div class="ins-scroll">
      <div class="news-view-wrap">
        {#if selectedNewsItem}
          <div class="ins-reader">
            <button
              class="ins-back-btn"
              type="button"
              onclick={() => (selectedNewsId = null)}
            >
              ‹ Back to {shortName} News
            </button>

            <div class="ins-reader-prov" style:color={selectedNewsItem.brandColor}>
              {selectedNewsItem.providerName}
            </div>
            <h2 class="ins-reader-title">{selectedNewsItem.title}</h2>
            <div class="ins-reader-meta">
              <span>{formatArticleMetaDate(selectedNewsItem.publishedAt)}</span>
              <span>·</span>
              <span>{selectedNewsItem.providerName}</span>
              <span>·</span>
              <span>
                {formatReadTime(
                  selectedArticle?.fullTextAvailable
                    ? selectedArticle.readTimeMinutes
                    : selectedNewsItem.readTimeMinutes
                )}
              </span>
            </div>

            <div class="ins-reader-body">
              {#if selectedNewsItem.displayMode === 'full' && selectedArticleLoading}
                <p class="muted-note">Loading full official release…</p>
              {:else if selectedArticle?.fullTextAvailable && selectedArticle.paragraphs.length > 0}
                {#each selectedArticle.paragraphs as para, i (i)}
                  <p>{para}</p>
                {/each}
              {:else}
                <p>{selectedNewsItem.snippet}</p>
              {/if}
            </div>

            <div class="ins-reader-footer">
              <span class="terms-txt">{selectedNewsItem.termsNote}</span>
              <a
                class="ext-link-btn"
                href={selectedNewsItem.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read on {selectedNewsItem.providerName} ↗
              </a>
            </div>
          </div>
        {:else if newsLoading && newsItems.length === 0}
          <div class="ins-state">
            <div class="ins-spinner"></div>
            <span>Loading {shortName} news…</span>
          </div>
        {:else if newsError && newsItems.length === 0}
          <div class="ins-state">
            <p class="ins-err">{newsError}</p>
            <button
              class="ins-retry-btn"
              type="button"
              onclick={() => void loadSymbolNews(symbol, true)}
            >
              Try again
            </button>
          </div>
        {:else if newsItems.length === 0}
          <div class="ins-state">
            <span>No recent headlines found for {shortName}.</span>
          </div>
        {:else}
          <div class="news-cards-grid">
            {#each newsItems as item (item.id)}
              <div
                class="news-card"
                role="button"
                tabindex="0"
                onclick={() => (selectedNewsId = item.id)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectedNewsId = item.id;
                  }
                }}
              >
                <div class="nc-meta">
                  <span class="nc-dot" style:background={item.brandColor}></span>
                  <span class="nc-prov">{item.providerName}</span>
                  <span>·</span>
                  <span>{formatTimeAgo(item.publishedAt)}</span>
                  {#if item.displayMode === 'full'}
                    <span class="nc-full">Full release</span>
                  {/if}
                </div>
                <h3 class="nc-title">{item.title}</h3>
                {#if item.snippet}
                  <p class="nc-snip">{item.snippet}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

  <!-- ==================== VIEW 4: VOLATILITY & LEVELS ==================== -->
  {:else if view === 'volatility'}
    <div class="ins-scroll">
      <div class="vol-wrap">
        <!-- Multi-Timeframe Technical Consensus Strip -->
        {#if techData && techData.mtfOverview.length > 0}
          <div class="vol-card">
            <div class="vol-card-head">
              <h2>Multi-Timeframe Consensus</h2>
              <span class="vol-hint">Click any timeframe to inspect its full Technicals breakdown</span>
            </div>
            <div class="mtf-grid">
              {#each techData.mtfOverview as row (row.interval)}
                <button
                  class="mtf-tile"
                  type="button"
                  onclick={() => {
                    interval = row.interval;
                    onChangeView('technicals');
                  }}
                >
                  <span class="mtf-tf">{row.label}</span>
                  <span class="mtf-main {ratingClass(row.summaryRating)}">{row.summaryRating}</span>
                  <div class="mtf-sub">
                    <span>Osc: <strong class={ratingClass(row.oscillatorsRating)}>{row.oscillatorsRating}</strong></span>
                    <span>MA: <strong class={ratingClass(row.movingAveragesRating)}>{row.movingAveragesRating}</strong></span>
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        {#if seasonalsLoading && !seasonalsData}
          <div class="ins-state compact">
            <div class="ins-spinner"></div>
            <span>Computing volatility, ADR exhaustion & key levels…</span>
          </div>
        {:else if seasonalsData?.volatility}
          {@const vol = seasonalsData.volatility}
          {@const dowRows = dowHorizon === '1Y' ? vol.dayOfWeek1Y : vol.dayOfWeek5Y}

          <!-- Volatility Metrics & Range Bars -->
          <div class="vol-kpi-grid">
            <div class="vol-kpi">
              <span class="kpi-lbl">ATR (14 Daily)</span>
              <strong class="kpi-val">{formatIndicatorNumber(vol.atr14, shortName)}</strong>
              <span class="kpi-sub">
                {vol.atr14Pct != null ? `${vol.atr14Pct.toFixed(2)}% of spot` : '—'}
              </span>
            </div>

            <div class="vol-kpi">
              <span class="kpi-lbl">20-Day Avg Daily Range</span>
              <strong class="kpi-val">{formatIndicatorNumber(vol.adr20, shortName)}</strong>
              <span class="kpi-sub">
                {vol.adr20Pct != null ? `${vol.adr20Pct.toFixed(2)}% avg daily swing` : '—'}
              </span>
            </div>

            <div class="vol-kpi">
              <span class="kpi-lbl">Today Range Exhaustion</span>
              <strong class="kpi-val">
                {vol.todayRangePctOfAdr != null ? `${vol.todayRangePctOfAdr.toFixed(0)}% of ADR` : '—'}
              </strong>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  class:hot={(vol.todayRangePctOfAdr ?? 0) >= 85}
                  style:width="{Math.min(100, vol.todayRangePctOfAdr ?? 0)}%"
                ></div>
              </div>
              <span class="kpi-sub">
                Today: {formatIndicatorNumber(vol.todayRange, shortName)}
              </span>
            </div>

            <div class="vol-kpi">
              <span class="kpi-lbl">52-Week Range Position</span>
              <strong class="kpi-val">
                {vol.week52PositionPct != null ? `${vol.week52PositionPct.toFixed(1)}%` : '—'}
              </strong>
              <div class="bar-track range52">
                <span
                  class="range-dot"
                  style:left="{Math.max(2, Math.min(98, vol.week52PositionPct ?? 50))}%"
                ></span>
              </div>
              <span class="kpi-sub range-ends">
                <span>L {formatIndicatorNumber(vol.week52Low, shortName)}</span>
                <span>H {formatIndicatorNumber(vol.week52High, shortName)}</span>
              </span>
            </div>
          </div>

          <div class="vol-two-col">
            <!-- Day-of-Week Statistical Edge -->
            <div class="vol-card">
              <div class="vol-card-head">
                <h2>Day-of-Week Edge</h2>
                <div class="dow-toggle">
                  <button
                    class:active={dowHorizon === '1Y'}
                    type="button"
                    onclick={() => (dowHorizon = '1Y')}
                  >
                    1Y
                  </button>
                  <button
                    class:active={dowHorizon === '5Y'}
                    type="button"
                    onclick={() => (dowHorizon = '5Y')}
                  >
                    5Y
                  </button>
                </div>
              </div>

              <table class="ind-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th class="num">Avg Return</th>
                    <th class="num">Win Rate</th>
                    <th class="num">Avg Range</th>
                  </tr>
                </thead>
                <tbody>
                  {#each dowRows as d (d.day)}
                    <tr>
                      <td class="ind-name">{d.day}</td>
                      <td class="num">
                        <span class:up={d.avgReturnPct > 0} class:down={d.avgReturnPct < 0}>
                          {d.avgReturnPct > 0 ? '+' : ''}{d.avgReturnPct.toFixed(3)}%
                        </span>
                      </td>
                      <td class="num">{d.winRatePct.toFixed(1)}%</td>
                      <td class="num">{d.avgRangePct.toFixed(2)}%</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <!-- Key Swing Support & Resistance Reference Levels -->
            <div class="vol-card">
              <div class="vol-card-head">
                <h2>Key Reference Levels</h2>
                <span class="vol-hint">Ranked vs current spot</span>
              </div>

              <table class="ind-table">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th class="num">Price</th>
                    <th class="act">Distance</th>
                  </tr>
                </thead>
                <tbody>
                  {#each vol.swingLevels as lv (lv.label)}
                    <tr>
                      <td class="ind-name">{lv.label}</td>
                      <td class="num">{formatIndicatorNumber(lv.price, shortName)}</td>
                      <td class="act">
                        <span
                          class="dist-badge"
                          class:res={lv.kind === 'resistance'}
                          class:sup={lv.kind === 'support'}
                        >
                          {lv.distancePct > 0 ? '+' : ''}{lv.distancePct.toFixed(2)}%
                        </span>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {:else}
          <div class="ins-state compact">
            <span>Volatility history is unavailable for this symbol.</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .insights-overlay {
    --in-bg: var(--dark-bg-base);
    --in-panel: var(--dark-bg-panel);
    --in-surface: var(--dark-bg-surface);
    --in-elevated: var(--dark-bg-elevated);
    --in-hover: var(--dark-bg-hover);
    --in-border: var(--dark-border-subtle);
    --in-border-strong: var(--dark-border-strong);
    --in-text: var(--dark-text-strong);
    --in-secondary: var(--dark-text-secondary);
    --in-muted: var(--dark-text-muted);

    position: absolute;
    inset: 0;
    z-index: 20;
    background: var(--in-bg);
    color: var(--in-text);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .insights-overlay.light {
    --in-bg: #ffffff;
    --in-panel: #ffffff;
    --in-surface: #f4f5f7;
    --in-elevated: #ffffff;
    --in-hover: #f0f3fa;
    --in-border: #e5e7eb;
    --in-border-strong: #d1d4dc;
    --in-text: #131722;
    --in-secondary: #6a6d78;
    --in-muted: #868993;
  }

  /* Header */
  .ins-header {
    height: 48px;
    flex: 0 0 48px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--in-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--in-panel);
    user-select: none;
  }

  .ins-title-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 0 1 auto;
  }

  .ins-sym-title {
    margin: 0;
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--in-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ins-dot {
    color: var(--in-muted);
    font-size: 14px;
  }

  .ins-view-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--in-secondary);
    white-space: nowrap;
  }

  .ins-header-center {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }

  .view-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border-radius: 8px;
    background: var(--in-surface);
    border: 1px solid var(--in-border);
  }

  .view-tab {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--in-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .view-tab:hover {
    color: var(--in-text);
  }

  .view-tab.active {
    background: var(--in-elevated);
    color: var(--in-text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14);
  }

  .ins-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .ins-price-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 7px;
    background: var(--in-surface);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .ins-price {
    font-weight: 650;
    color: var(--in-text);
  }

  .ins-pct {
    font-weight: 600;
    color: var(--in-secondary);
  }

  .ins-pct.up,
  .up {
    color: #089981;
  }

  .ins-pct.down,
  .down {
    color: #f23645;
  }

  .ins-note-btn {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--in-border);
    border-radius: 7px;
    background: transparent;
    color: var(--in-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 130ms ease, color 130ms ease, border-color 130ms ease;
  }

  .ins-note-btn:hover {
    color: var(--in-text);
    background: var(--in-hover);
  }

  .ins-note-btn.done {
    color: #089981;
    border-color: rgba(8, 153, 129, 0.5);
    background: rgba(8, 153, 129, 0.1);
  }

  .ins-close-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--in-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .ins-close-btn:hover {
    background: var(--in-hover);
    color: var(--in-text);
  }

  .ins-close-btn svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
  }

  /* Technicals Timeframe Bar (Screenshots 6 & 9) */
  .tech-tf-bar {
    flex: 0 0 auto;
    padding: 10px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--in-border);
  }

  .tf-pills {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .tf-btn {
    height: 30px;
    padding: 0 11px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--in-secondary);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .tf-btn:hover {
    color: var(--in-text);
    background: var(--in-hover);
  }

  .tf-btn.active {
    background: var(--in-surface);
    color: var(--in-text);
    font-weight: 650;
  }

  .tf-chev {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .tf-chev.open {
    transform: rotate(180deg);
  }

  .tf-more-anchor {
    position: relative;
  }

  .tf-more-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 35;
    min-width: 128px;
    padding: 4px;
    border-radius: 9px;
    background: var(--in-elevated);
    border: 1px solid var(--in-border-strong);
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.28);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tf-more-item {
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--in-text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .tf-more-item:hover {
    background: var(--in-hover);
  }

  .tf-more-item.active {
    background: rgba(41, 98, 255, 0.12);
    color: #2962ff;
    font-weight: 600;
  }

  .tech-refresh-btn {
    width: 30px;
    height: 30px;
    border: 1px solid var(--in-border);
    border-radius: 7px;
    background: transparent;
    color: var(--in-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: 0 0 30px;
  }

  .tech-refresh-btn:hover {
    background: var(--in-hover);
    color: var(--in-text);
  }

  .tech-refresh-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .spin {
    animation: ins-spin 0.8s linear infinite;
  }

  @keyframes ins-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Scroll container */
  .ins-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 24px 36px;
  }

  /* Technicals Content */
  .tech-content {
    max-width: 940px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .gauges-hero {
    display: flex;
    justify-content: center;
    padding-top: 4px;
  }

  .gauges-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(220px, 1fr));
    gap: 24px;
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
  }

  /* Indicator Tables */
  .tables-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    margin-top: 8px;
  }

  @media (max-width: 820px) {
    .tables-grid,
    .vol-two-col {
      grid-template-columns: 1fr;
    }
  }

  .ind-card,
  .pivots-card,
  .vol-card {
    border: 1px solid var(--in-border);
    border-radius: 12px;
    background: var(--in-panel);
    overflow: hidden;
  }

  .ind-card-head,
  .pivots-head,
  .vol-card-head {
    padding: 12px 15px;
    border-bottom: 1px solid var(--in-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .ind-card-head h2,
  .pivots-head h2,
  .vol-card-head h2 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 650;
    color: var(--in-text);
  }

  .ind-rating-badge {
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
  }

  .ind-rating-badge.buy {
    color: #2962ff;
    background: rgba(41, 98, 255, 0.12);
  }

  .ind-rating-badge.sell {
    color: #f23645;
    background: rgba(242, 54, 69, 0.12);
  }

  .ind-rating-badge.neutral {
    color: var(--in-secondary);
    background: var(--in-surface);
  }

  .ind-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .ind-table th {
    padding: 8px 14px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--in-muted);
    text-align: left;
    border-bottom: 1px solid var(--in-border);
  }

  .ind-table th.num,
  .ind-table td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .ind-table th.act,
  .ind-table td.act {
    text-align: right;
  }

  .ind-table td {
    padding: 8px 14px;
    border-bottom: 1px solid var(--in-border);
    color: var(--in-text);
  }

  .ind-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .ind-name {
    color: var(--in-secondary);
  }

  .act-txt {
    font-weight: 600;
    font-size: 12px;
  }

  .act-txt.buy {
    color: #2962ff;
  }

  .act-txt.sell {
    color: #f23645;
  }

  .act-txt.neutral {
    color: var(--in-muted);
  }

  /* Pivots */
  .pivot-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .pivot-tab {
    height: 26px;
    padding: 0 9px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--in-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .pivot-tab:hover {
    background: var(--in-hover);
    color: var(--in-text);
  }

  .pivot-tab.active {
    background: var(--in-surface);
    border-color: var(--in-border);
    color: var(--in-text);
    font-weight: 600;
  }

  .pivot-grid {
    padding: 14px 15px;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 8px;
  }

  .pivot-cell {
    padding: 9px 8px;
    border-radius: 8px;
    background: var(--in-surface);
    border: 1px solid var(--in-border);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .pivot-cell.mid {
    border-color: #2962ff;
  }

  .pivot-k {
    font-size: 11px;
    font-weight: 650;
    color: var(--in-muted);
  }

  .pivot-cell.sup .pivot-k {
    color: #089981;
  }

  .pivot-cell.res .pivot-k {
    color: #f23645;
  }

  .pivot-cell.mid .pivot-k {
    color: #2962ff;
  }

  .pivot-v {
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--in-text);
  }

  /* Symbol News View */
  .news-view-wrap {
    max-width: 920px;
    margin: 0 auto;
  }

  .news-cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }

  .news-card {
    padding: 14px 16px;
    border-radius: 11px;
    border: 1px solid var(--in-border);
    background: var(--in-panel);
    display: flex;
    flex-direction: column;
    gap: 7px;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease;
  }

  .news-card:hover {
    background: var(--in-hover);
    border-color: var(--in-border-strong);
  }

  .nc-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--in-secondary);
  }

  .nc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 7px;
  }

  .nc-prov {
    font-weight: 600;
    color: var(--in-text);
  }

  .nc-full {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    color: #089981;
    background: rgba(8, 153, 129, 0.12);
  }

  .nc-title {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
    line-height: 1.38;
    color: var(--in-text);
  }

  .nc-snip {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--in-secondary);
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ins-reader {
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ins-back-btn {
    align-self: flex-start;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--in-border);
    border-radius: 7px;
    background: transparent;
    color: var(--in-text);
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
  }

  .ins-back-btn:hover {
    background: var(--in-hover);
  }

  .ins-reader-prov {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .ins-reader-title {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    line-height: 1.28;
    color: var(--in-text);
  }

  .ins-reader-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--in-secondary);
  }

  .ins-reader-body {
    margin-top: 6px;
    font-size: 14.5px;
    line-height: 1.68;
    color: var(--in-text);
  }

  .ins-reader-body p {
    margin: 0 0 12px;
  }

  .ins-reader-footer {
    margin-top: 10px;
    padding: 14px 16px;
    border-radius: 10px;
    border: 1px solid var(--in-border);
    background: var(--in-surface);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .terms-txt {
    font-size: 12px;
    color: var(--in-secondary);
    flex: 1;
    min-width: 220px;
  }

  .ext-link-btn {
    height: 34px;
    padding: 0 14px;
    border-radius: 8px;
    background: #2962ff;
    color: #ffffff;
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }

  /* Volatility & Levels View */
  .vol-wrap {
    max-width: 960px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .vol-hint {
    font-size: 11.5px;
    color: var(--in-muted);
  }

  .mtf-grid {
    padding: 14px;
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 10px;
  }

  @media (max-width: 900px) {
    .mtf-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .mtf-tile {
    padding: 11px 10px;
    border-radius: 9px;
    border: 1px solid var(--in-border);
    background: var(--in-surface);
    color: var(--in-text);
    font: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    transition: border-color 140ms ease, background-color 140ms ease;
  }

  .mtf-tile:hover {
    border-color: #2962ff;
    background: var(--in-hover);
  }

  .mtf-tf {
    font-size: 11.5px;
    font-weight: 700;
    color: var(--in-secondary);
  }

  .mtf-main {
    font-size: 13px;
    font-weight: 700;
  }

  .mtf-main.buy,
  .mtf-sub strong.buy {
    color: #2962ff;
  }

  .mtf-main.sell,
  .mtf-sub strong.sell {
    color: #f23645;
  }

  .mtf-main.neutral,
  .mtf-sub strong.neutral {
    color: var(--in-secondary);
  }

  .mtf-sub {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    font-size: 10.5px;
    color: var(--in-muted);
  }

  .vol-kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  @media (max-width: 920px) {
    .vol-kpi-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .vol-kpi {
    padding: 14px 15px;
    border-radius: 12px;
    border: 1px solid var(--in-border);
    background: var(--in-panel);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .kpi-lbl {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--in-secondary);
  }

  .kpi-val {
    font-size: 19px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--in-text);
  }

  .kpi-sub {
    font-size: 11.5px;
    color: var(--in-muted);
    font-variant-numeric: tabular-nums;
  }

  .bar-track {
    position: relative;
    height: 6px;
    border-radius: 999px;
    background: var(--in-surface);
    overflow: hidden;
    margin: 2px 0;
  }

  .bar-track.range52 {
    overflow: visible;
  }

  .bar-fill {
    height: 100%;
    border-radius: 999px;
    background: #2962ff;
  }

  .bar-fill.hot {
    background: #f59e0b;
  }

  .range-dot {
    position: absolute;
    top: 50%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: -5px;
    border-radius: 50%;
    background: #2962ff;
    border: 2px solid var(--in-panel);
  }

  .range-ends {
    display: flex;
    justify-content: space-between;
  }

  .vol-two-col {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .dow-toggle {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: 6px;
    background: var(--in-surface);
    border: 1px solid var(--in-border);
  }

  .dow-toggle button {
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--in-secondary);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .dow-toggle button.active {
    background: var(--in-elevated);
    color: var(--in-text);
  }

  .dist-badge {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--in-secondary);
  }

  .dist-badge.res {
    color: #f23645;
  }

  .dist-badge.sup {
    color: #089981;
  }

  /* States */
  .ins-state {
    min-height: 280px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--in-secondary);
    font-size: 13px;
  }

  .ins-state.compact {
    min-height: 140px;
  }

  .ins-spinner {
    width: 22px;
    height: 22px;
    border: 2px solid var(--in-border-strong);
    border-top-color: #2962ff;
    border-radius: 50%;
    animation: ins-spin 0.8s linear infinite;
  }

  .ins-err {
    margin: 0;
    color: #f23645;
  }

  .ins-retry-btn {
    height: 30px;
    padding: 0 14px;
    border: 1px solid var(--in-border-strong);
    border-radius: 7px;
    background: var(--in-surface);
    color: var(--in-text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .muted-note {
    color: var(--in-secondary);
  }
</style>
