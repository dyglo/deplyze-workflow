<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchMacroRegime,
    getCachedMacroRegime,
    type MacroRegimeResponse
  } from '../insights/api';
  import type { InsightsViewId } from '../insights/symbolInsightsApi';
  import { fetchScreenerRows } from '../screener/api';
  import HeatmapView from '../screener/HeatmapView.svelte';
  import type {
    EnrichedScreenerRow,
    ScreenerColumnPreset,
    ScreenerQuickFilter,
    ScreenerScopeId
  } from '../screener/types';
  import {
    SCREENER_SCOPES,
    buildPersonalUniverse,
    filterUniverseByScope
  } from '../screener/universe';
  import {
    createWatchlistItem,
    formatQuotePrice,
    loadWatchlistState,
    saveWatchlistState,
    type WatchlistState
  } from '../watchlist/store';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';

  interface Props {
    theme: 'dark' | 'light';
    fullscreen?: boolean;
    initialWatchlistGroupId?: string | null;
    onToggleFullscreen: () => void;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onOpenSymbolInsights: (
      symbol: string,
      shortName: string,
      description: string,
      view: InsightsViewId
    ) => void;
    onClose: () => void;
  }

  let {
    theme,
    fullscreen = false,
    initialWatchlistGroupId = null,
    onToggleFullscreen,
    onSelectSymbol,
    onOpenSymbolInsights,
    onClose
  }: Props = $props();

  const MIN_W = 420;
  const MAX_W = 780;

  let width = $state(540);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartW = 540;

  let viewMode = $state<'table' | 'heatmap'>('table');
  // svelte-ignore state_referenced_locally
  let scope = $state<ScreenerScopeId>(initialWatchlistGroupId ? 'watchlists' : 'all');
  // svelte-ignore state_referenced_locally
  let selectedWlGroupId = $state<string | null>(initialWatchlistGroupId ?? null);
  let columnPreset = $state<ScreenerColumnPreset>('overview');
  let quickFilter = $state<ScreenerQuickFilter>('all');

  // Advanced filter strip
  let filtersOpen = $state(false);
  let minChgStr = $state('');
  let maxChgStr = $state('');
  let ratingFilter = $state<'all' | 'buy' | 'strong_buy' | 'sell' | 'strong_sell'>('all');
  let rsiFilter = $state<'all' | 'overbought' | 'oversold'>('all');
  let macroFilter = $state<'all' | 'tailwind' | 'headwind'>('all');

  let searchQuery = $state('');
  let searchOpen = $state(false);
  let sortCol = $state<string>('changePercent');
  let sortDir = $state<'desc' | 'asc'>('desc');

  let openMenu = $state<'scope' | 'subscope' | 'preset' | null>(null);

  let watchlistState = $state<WatchlistState | null>(null);
  let macroRegime = $state<MacroRegimeResponse | null>(getCachedMacroRegime());
  let allRows = $state<EnrichedScreenerRow[]>([]);
  let loading = $state(true);
  let errorMsg = $state<string | null>(null);
  let updatedAt = $state<string | null>(null);

  let activeAbort: AbortController | null = null;

  const fullUniverse = $derived(buildPersonalUniverse(watchlistState));
  const scopedUniverse = $derived(
    filterUniverseByScope(fullUniverse, scope, scope === 'watchlists' ? selectedWlGroupId : null)
  );

  const activeFilterCount = $derived.by(() => {
    let n = 0;
    if (quickFilter !== 'all') n++;
    if (minChgStr.trim() !== '') n++;
    if (maxChgStr.trim() !== '') n++;
    if (ratingFilter !== 'all') n++;
    if (rsiFilter !== 'all') n++;
    if (macroFilter !== 'all') n++;
    return n;
  });

  const watchlistShortSet = $derived.by(() => {
    const s = new Set<string>();
    if (!watchlistState) return s;
    for (const g of watchlistState.groups) {
      for (const sec of g.sections) {
        for (const it of sec.items) s.add(it.shortName.toUpperCase());
      }
    }
    return s;
  });

  const scopedRows = $derived.by(() => {
    const allowed = new Set(scopedUniverse.map((u) => u.shortName.toUpperCase()));
    return allRows.filter((r) => allowed.has(r.shortName.toUpperCase()));
  });

  const filteredRows = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const minChg = minChgStr.trim() !== '' ? Number(minChgStr) : null;
    const maxChg = maxChgStr.trim() !== '' ? Number(maxChgStr) : null;

    const list = scopedRows.filter((r) => {
      if (q) {
        const hit =
          r.shortName.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q);
        if (!hit) return false;
      }

      if (quickFilter === 'bullish' && r.changePercent <= 0) return false;
      if (quickFilter === 'bearish' && r.changePercent >= 0) return false;
      if (
        quickFilter === 'strong_tech' &&
        r.rating !== 'Strong buy' &&
        r.rating !== 'Strong sell'
      ) {
        return false;
      }
      if (
        quickFilter === 'high_vol' &&
        (r.volatilityD ?? 0) < 1.0 &&
        Math.abs(r.changePercent) < 1.0 &&
        (r.relVolume ?? 0) < 1.5
      ) {
        return false;
      }
      if (quickFilter === 'near_high' && (r.rangePosPct === null || r.rangePosPct < 78)) return false;
      if (quickFilter === 'near_low' && (r.rangePosPct === null || r.rangePosPct > 22)) return false;
      if (quickFilter === 'macro_tailwind' && r.macroBias !== 'tailwind') return false;

      if (minChg !== null && Number.isFinite(minChg) && r.changePercent < minChg) return false;
      if (maxChg !== null && Number.isFinite(maxChg) && r.changePercent > maxChg) return false;

      if (ratingFilter === 'strong_buy' && r.rating !== 'Strong buy') return false;
      if (ratingFilter === 'buy' && r.rating !== 'Buy' && r.rating !== 'Strong buy') return false;
      if (ratingFilter === 'strong_sell' && r.rating !== 'Strong sell') return false;
      if (ratingFilter === 'sell' && r.rating !== 'Sell' && r.rating !== 'Strong sell') return false;

      if (rsiFilter === 'overbought' && (r.rsi14 === null || r.rsi14 < 70)) return false;
      if (rsiFilter === 'oversold' && (r.rsi14 === null || r.rsi14 > 30)) return false;

      if (macroFilter !== 'all' && r.macroBias !== macroFilter) return false;

      return true;
    });

    const dir = sortDir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      if (sortCol === 'shortName') {
        return a.shortName.localeCompare(b.shortName) * dir;
      }
      const va = (a as unknown as Record<string, unknown>)[sortCol];
      const vb = (b as unknown as Record<string, unknown>)[sortCol];
      const aValid = typeof va === 'number' && Number.isFinite(va);
      const bValid = typeof vb === 'number' && Number.isFinite(vb);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return ((va as number) - (vb as number)) * dir;
    });
  });

  async function refreshData(force = false) {
    activeAbort?.abort();
    const ctrl = new AbortController();
    activeAbort = ctrl;
    if (allRows.length === 0) loading = true;
    errorMsg = null;
    try {
      const res = await fetchScreenerRows(fullUniverse, macroRegime, force, ctrl.signal);
      allRows = res.rows;
      updatedAt = res.updatedAt;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      errorMsg = (err as Error)?.message || 'Unable to load screener data.';
    }
    loading = false;
  }

  onMount(() => {
    void Promise.all([
      loadWatchlistState()
        .then((wl) => {
          watchlistState = wl;
        })
        .catch(() => {
          // ignore
        }),
      fetchMacroRegime()
        .then((mr) => {
          macroRegime = mr;
        })
        .catch(() => {
          // ignore
        })
    ]).then(() => {
      void refreshData(false);
    });

    const refreshTimer = setInterval(() => {
      void refreshData(false);
    }, 30_000);

    const onDocDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (openMenu && !target?.closest('[data-scr-menu]')) {
        openMenu = null;
      }
    };
    window.addEventListener('pointerdown', onDocDown);

    return () => {
      activeAbort?.abort();
      clearInterval(refreshTimer);
      window.removeEventListener('pointerdown', onDocDown);
    };
  });

  function toggleSort(col: string) {
    if (sortCol === col) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortCol = col;
      sortDir = col === 'shortName' ? 'asc' : 'desc';
    }
  }

  function resetAllFilters() {
    quickFilter = 'all';
    minChgStr = '';
    maxChgStr = '';
    ratingFilter = 'all';
    rsiFilter = 'all';
    macroFilter = 'all';
    searchQuery = '';
  }

  async function addToActiveWatchlist(row: EnrichedScreenerRow, e: MouseEvent) {
    e.stopPropagation();
    if (!watchlistState || watchlistShortSet.has(row.shortName.toUpperCase())) return;
    const activeGrp =
      watchlistState.groups.find((g) => g.id === watchlistState?.activeGroupId) ??
      watchlistState.groups[0];
    if (!activeGrp || activeGrp.sections.length === 0) return;

    const baseItem = createWatchlistItem(row.symbol);
    const newItem = {
      ...baseItem,
      shortName: row.shortName || baseItem.shortName,
      description: row.description || baseItem.description
    };
    const nextGroups = watchlistState.groups.map((g) => {
      if (g.id !== activeGrp.id) return g;
      return {
        ...g,
        sections: g.sections.map((sec, idx) =>
          idx === 0 ? { ...sec, items: [...sec.items, newItem] } : sec
        )
      };
    });
    const nextState: WatchlistState = { ...watchlistState, groups: nextGroups };
    watchlistState = nextState;
    await saveWatchlistState(nextState);
  }

  function formatPct(val: number | null): string {
    if (val === null || !Number.isFinite(val)) return '—';
    return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
  }

  function formatNum(val: number | null, dec = 2): string {
    if (val === null || !Number.isFinite(val)) return '—';
    return val.toFixed(dec);
  }

  function ratingTone(rating: string): 'strong-buy' | 'buy' | 'sell' | 'strong-sell' | 'neutral' {
    if (rating === 'Strong buy') return 'strong-buy';
    if (rating === 'Buy') return 'buy';
    if (rating === 'Strong sell') return 'strong-sell';
    if (rating === 'Sell') return 'sell';
    return 'neutral';
  }

  function buildTechTooltip(row: EnrichedScreenerRow): string {
    const parts: string[] = [
      row.source === 'oanda'
        ? `OANDA MTF (1H/4H/1D): ${row.rating} (MA: ${row.maRating}, Osc: ${row.oscRating})`
        : `${row.rating} (MA: ${row.maRating}, Osc: ${row.oscRating})`
    ];
    if (typeof row.crowdLongPct === 'number' && Number.isFinite(row.crowdLongPct)) {
      const skewNote =
        row.crowdSkew === 'crowded_long'
          ? 'Contrarian Bearish'
          : row.crowdSkew === 'crowded_short'
            ? 'Contrarian Bullish'
            : 'Balanced';
      const trapped =
        row.crowdSkew === 'crowded_long' && typeof row.trappedLongPct === 'number'
          ? ` · ${row.trappedLongPct}% longs trapped`
          : row.crowdSkew === 'crowded_short' && typeof row.trappedShortPct === 'number'
            ? ` · ${row.trappedShortPct}% shorts trapped`
            : '';
      parts.push(`OANDA Crowd: ${row.crowdLongPct.toFixed(0)}% Long (${skewNote}${trapped})`);
    }
    return parts.join('\n');
  }

  function buildVolTooltip(row: EnrichedScreenerRow): string {
    const parts: string[] = [];
    if (row.volatilityD !== null) parts.push(`Daily Range Volatility: ${row.volatilityD.toFixed(2)}%`);
    if (row.relVolume !== null) parts.push(`Session Tick RVOL: ${row.relVolume.toFixed(2)}x`);
    if (typeof row.spreadAtrPct === 'number' && Number.isFinite(row.spreadAtrPct)) {
      const state = row.wideSpread ? 'Wide Spread' : 'Normal Spread';
      const ratioStr =
        typeof row.spreadRatio === 'number' && Number.isFinite(row.spreadRatio)
          ? ` (${row.spreadRatio.toFixed(1)}x median)`
          : '';
      parts.push(`OANDA Spread: ${row.spreadAtrPct.toFixed(2)}% of ATR · ${state}${ratioStr}`);
    }
    return parts.join('\n');
  }

  function onResizeDown(e: PointerEvent) {
    if (e.button !== 0 || fullscreen) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartW = width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onResizeMove(e: PointerEvent) {
    if (!dragging) return;
    const maxCap = typeof window !== 'undefined' ? Math.min(MAX_W, window.innerWidth - 460) : MAX_W;
    width = Math.round(Math.max(MIN_W, Math.min(maxCap, dragStartW + (dragStartX - e.clientX))));
  }

  function onResizeUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  const QUICK_CHIPS: { id: ScreenerQuickFilter; code: string; label: string }[] = [
    { id: 'all', code: 'A', label: 'All' },
    { id: 'bullish', code: '↑', label: 'Bullish' },
    { id: 'bearish', code: '↓', label: 'Bearish' },
    { id: 'strong_tech', code: 'T', label: 'Strong Tech' },
    { id: 'high_vol', code: 'V', label: 'High Vol' },
    { id: 'near_high', code: 'H', label: 'Near High' },
    { id: 'near_low', code: 'L', label: 'Near Low' },
    { id: 'macro_tailwind', code: 'M', label: 'Macro Tailwind' }
  ];

  const PRESETS: { id: ScreenerColumnPreset; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'performance', label: 'Performance' },
    { id: 'technicals', label: 'Technicals' },
    { id: 'volatility', label: 'Volatility' }
  ];

  const activeScopeObj = $derived(
    SCREENER_SCOPES.find((s) => s.id === scope) ?? SCREENER_SCOPES[0]
  );
  const activePresetLabel = $derived(
    PRESETS.find((p) => p.id === columnPreset)?.label ?? 'Overview'
  );
</script>

<aside
  class="screener-shell"
  class:light={theme === 'light'}
  class:fullscreen
  class:dragging
  style:width={fullscreen ? undefined : `${width}px`}
  style:flex-basis={fullscreen ? undefined : `${width}px`}
  aria-label="Personal Screener and Heatmap"
>
  {#if !fullscreen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Screener panel"
      onpointerdown={onResizeDown}
      onpointermove={onResizeMove}
      onpointerup={onResizeUp}
      onpointercancel={onResizeUp}
    >
      <span class="resize-pill" aria-hidden="true"></span>
    </div>
  {/if}

  <div class="scr-inner">
    <!-- Top Bar (Exact TradingView Screener Header — Screenshot 1 & 2) -->
    <header class="scr-top-bar">
      <div class="menu-anchor" data-scr-menu>
        <button
          class="screener-switcher"
          type="button"
          onclick={() => (openMenu = openMenu === 'scope' ? null : 'scope')}
        >
          <svg class="sw-ic" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2.5" y="3" width="13" height="12" rx="2" />
            <path d="M6.5 9h5M9.5 6.5 12 9l-2.5 2.5" />
          </svg>
          <span>{viewMode === 'heatmap' ? 'Market Heatmap' : activeScopeObj.label}</span>
          <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if openMenu === 'scope'}
          <div class="tv-dropdown">
            {#each SCREENER_SCOPES as sc (sc.id)}
              <button
                class="tv-opt"
                class:active={scope === sc.id}
                type="button"
                onclick={() => {
                  scope = sc.id;
                  if (sc.id !== 'watchlists') selectedWlGroupId = null;
                  openMenu = null;
                }}
              >
                {sc.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="top-right-acts">
        <button
          class="hdr-ic"
          type="button"
          title={fullscreen ? 'Dock to right side' : 'Expand fullscreen'}
          aria-label={fullscreen ? 'Dock to right side' : 'Expand fullscreen'}
          onclick={onToggleFullscreen}
        >
          {#if fullscreen}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
            </svg>
          {/if}
        </button>

        <button
          class="hdr-ic"
          type="button"
          title="Close Screener"
          aria-label="Close Screener"
          onclick={onClose}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
    </header>

    {#if viewMode === 'heatmap'}
      <HeatmapView
        {theme}
        rows={filteredRows}
        {scope}
        {fullscreen}
        onChangeScope={(next) => (scope = next)}
        {onSelectSymbol}
        onSwitchToTable={() => (viewMode = 'table')}
        {onToggleFullscreen}
      />
    {:else}
      <!-- Sub-header: Universe Title + Reset Filters -->
      <div class="scr-subhead">
        <div class="menu-anchor" data-scr-menu>
          <button
            class="title-trigger"
            type="button"
            onclick={() => (openMenu = openMenu === 'subscope' ? null : 'subscope')}
          >
            <span>
              {#if scope === 'watchlists' && selectedWlGroupId && watchlistState}
                {watchlistState.groups.find((g) => g.id === selectedWlGroupId)?.name ?? 'My watchlists'}
              {:else}
                {activeScopeObj.shortLabel}
              {/if}
            </span>
            <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" />
            </svg>
          </button>

          {#if openMenu === 'subscope'}
            <div class="tv-dropdown">
              {#if scope === 'watchlists' && watchlistState}
                <button
                  class="tv-opt"
                  class:active={selectedWlGroupId === null}
                  type="button"
                  onclick={() => {
                    selectedWlGroupId = null;
                    openMenu = null;
                  }}
                >
                  All watchlist groups
                </button>
                {#each watchlistState.groups as g (g.id)}
                  <button
                    class="tv-opt"
                    class:active={selectedWlGroupId === g.id}
                    type="button"
                    onclick={() => {
                      selectedWlGroupId = g.id;
                      openMenu = null;
                    }}
                  >
                    {g.name}
                  </button>
                {/each}
              {:else}
                {#each SCREENER_SCOPES as sc (sc.id)}
                  <button
                    class="tv-opt"
                    class:active={scope === sc.id}
                    type="button"
                    onclick={() => {
                      scope = sc.id;
                      openMenu = null;
                    }}
                  >
                    {sc.shortLabel}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>

        <div class="subhead-right">
          {#if activeFilterCount > 0 || searchQuery}
            <button
              class="hdr-ic"
              type="button"
              title="Reset all filters"
              aria-label="Reset all filters"
              onclick={resetAllFilters}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5.5 6.5H2.75V3.75M3 6.5A5.5 5.5 0 1 1 4.2 12" />
              </svg>
            </button>
          {/if}
          {#if updatedAt}
            <span class="upd-stamp" title="Last refreshed">
              {new Date(updatedAt).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
              })}
            </span>
          {/if}
        </div>
      </div>

      <!-- Quick-Filter Chip Strip (TradingView Reference Row) -->
      <div class="quick-strip">
        {#each QUICK_CHIPS as chip (chip.id)}
          <button
            class="q-pill"
            class:active={quickFilter === chip.id}
            type="button"
            title={chip.label}
            onclick={() => (quickFilter = quickFilter === chip.id ? 'all' : chip.id)}
          >
            {chip.label}
          </button>
        {/each}
      </div>

      <!-- Action Toolbar (Filters | Heatmap Toggle | Overview ⌄ | Refresh | Fullscreen) -->
      <div class="scr-toolbar">
        <div class="tb-left">
          <button
            class="tb-outlined"
            class:active={filtersOpen || activeFilterCount > 0}
            type="button"
            onclick={() => (filtersOpen = !filtersOpen)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 4.5h11M5 4.5v-1.5m0 1.5v1.5M2.5 8h11M11 8V6.5M11 8v1.5M2.5 11.5h11M7 11.5V10m0 1.5V13" />
            </svg>
            <span>Filters</span>
            {#if activeFilterCount > 0}
              <span class="f-cnt">{activeFilterCount}</span>
            {/if}
          </button>

          <button
            class="tb-icon-sq"
            type="button"
            title="Switch to Market Heatmap"
            aria-label="Switch to Market Heatmap"
            onclick={() => (viewMode = 'heatmap')}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="2" width="6.5" height="6.5" rx="1" />
              <rect x="10" y="2" width="4" height="4.5" rx="0.8" />
              <rect x="10" y="8" width="4" height="6" rx="0.8" />
              <rect x="2" y="10" width="6.5" height="4" rx="0.8" />
            </svg>
          </button>

          <span class="v-sep" aria-hidden="true"></span>

          <div class="menu-anchor" data-scr-menu>
            <button
              class="tb-ghost"
              type="button"
              onclick={() => (openMenu = openMenu === 'preset' ? null : 'preset')}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2.25" y="3" width="2.4" height="10" rx="0.6" />
                <rect x="6.8" y="3" width="2.4" height="10" rx="0.6" />
                <rect x="11.35" y="3" width="2.4" height="10" rx="0.6" />
              </svg>
              <span>{activePresetLabel}</span>
              <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4.5 6 7.5 9 4.5" />
              </svg>
            </button>

            {#if openMenu === 'preset'}
              <div class="tv-dropdown">
                {#each PRESETS as p (p.id)}
                  <button
                    class="tv-opt"
                    class:active={columnPreset === p.id}
                    type="button"
                    onclick={() => {
                      columnPreset = p.id;
                      openMenu = null;
                    }}
                  >
                    {p.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div class="tb-right">
          <button
            class="tb-icon-sq"
            type="button"
            title="Refresh live scanner"
            aria-label="Refresh live scanner"
            onclick={() => void refreshData(true)}
          >
            <svg class:spin={loading} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.5" />
              <path d="M13.2 3v2.8h-2.8" />
            </svg>
          </button>

          <button
            class="tb-icon-sq"
            type="button"
            title={fullscreen ? 'Dock to right side' : 'Expand fullscreen'}
            aria-label={fullscreen ? 'Dock to right side' : 'Expand fullscreen'}
            onclick={onToggleFullscreen}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Flat Hairline Advanced Filters Drawer -->
      {#if filtersOpen}
        <div class="filters-bar">
          <label class="fl-item">
            <span>Chg % min</span>
            <input type="text" inputmode="decimal" placeholder="-5" bind:value={minChgStr} />
          </label>
          <label class="fl-item">
            <span>Chg % max</span>
            <input type="text" inputmode="decimal" placeholder="+5" bind:value={maxChgStr} />
          </label>
          <label class="fl-item">
            <span>Tech Rating</span>
            <select bind:value={ratingFilter}>
              <option value="all">Any</option>
              <option value="strong_buy">Strong buy</option>
              <option value="buy">Buy & Strong buy</option>
              <option value="sell">Sell & Strong sell</option>
              <option value="strong_sell">Strong sell</option>
            </select>
          </label>
          <label class="fl-item">
            <span>RSI (14)</span>
            <select bind:value={rsiFilter}>
              <option value="all">Any</option>
              <option value="overbought">Overbought (&gt;70)</option>
              <option value="oversold">Oversold (&lt;30)</option>
            </select>
          </label>
          <label class="fl-item">
            <span>Macro</span>
            <select bind:value={macroFilter}>
              <option value="all">Any</option>
              <option value="tailwind">Tailwind</option>
              <option value="headwind">Headwind</option>
            </select>
          </label>
        </div>
      {/if}

      <!-- Flat TradingView Data Table -->
      <div class="table-scroll">
        {#if loading && allRows.length === 0}
          <div class="scr-status">Scanning personal universe...</div>
        {:else if errorMsg && allRows.length === 0}
          <div class="scr-status err">{errorMsg}</div>
        {:else if filteredRows.length === 0}
          <div class="scr-status">
            No instruments match your filters.
            <button class="link-reset" type="button" onclick={resetAllFilters}>Reset filters</button>
          </div>
        {:else}
          <table class="scr-table">
            <thead>
              <tr>
                <th class="col-sym">
                  <div class="sym-th">
                    {#if searchOpen}
                      <input
                        class="sym-search"
                        type="text"
                        placeholder="Search ticker..."
                        bind:value={searchQuery}
                        onkeydown={(e) => {
                          if (e.key === 'Escape') {
                            searchQuery = '';
                            searchOpen = false;
                          }
                        }}
                      />
                    {:else}
                      <button
                        class="search-ic-btn"
                        type="button"
                        title="Search symbols"
                        aria-label="Search symbols"
                        onclick={() => (searchOpen = true)}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="7" cy="7" r="4.5" />
                          <path d="m10.5 10.5 3 3" />
                        </svg>
                      </button>
                      <button class="th-sort" type="button" onclick={() => toggleSort('shortName')}>
                        <span>Symbol</span>
                        <span class="sym-cnt">{filteredRows.length}</span>
                        {#if sortCol === 'shortName'}
                          <span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>
                        {/if}
                      </button>
                    {/if}
                  </div>
                </th>

                <th class="num">
                  <button class="th-sort num" type="button" onclick={() => toggleSort('price')}>
                    {#if sortCol === 'price'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                    Price
                  </button>
                </th>

                {#if columnPreset === 'overview'}
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('changePercent')}>
                      {#if sortCol === 'changePercent'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      Chg %
                    </button>
                  </th>
                  <th>
                    <button class="th-sort" type="button" onclick={() => toggleSort('recommendAll')}>
                      Tech Rating
                      {#if sortCol === 'recommendAll'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('volatilityD')}>
                      {#if sortCol === 'volatilityD'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      Vol 1D
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('rangePosPct')}>
                      {#if sortCol === 'rangePosPct'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      Day Pos
                    </button>
                  </th>
                  <th>Macro</th>
                {:else if columnPreset === 'performance'}
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('change1h')}>
                      {#if sortCol === 'change1h'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      1H %
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('change4h')}>
                      {#if sortCol === 'change4h'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      4H %
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('changePercent')}>
                      {#if sortCol === 'changePercent'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      1D %
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('perfW')}>
                      {#if sortCol === 'perfW'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      1W %
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('perf1M')}>
                      {#if sortCol === 'perf1M'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      1M %
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('perfYTD')}>
                      {#if sortCol === 'perfYTD'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      YTD %
                    </button>
                  </th>
                {:else if columnPreset === 'technicals'}
                  <th>
                    <button class="th-sort" type="button" onclick={() => toggleSort('recommendAll')}>
                      Summary
                      {#if sortCol === 'recommendAll'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                    </button>
                  </th>
                  <th>
                    <button class="th-sort" type="button" onclick={() => toggleSort('recommendMA')}>
                      MAs
                    </button>
                  </th>
                  <th>
                    <button class="th-sort" type="button" onclick={() => toggleSort('recommendOsc')}>
                      Osc
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('rsi14')}>
                      {#if sortCol === 'rsi14'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      RSI 14
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('adx14')}>
                      {#if sortCol === 'adx14'}<span class="sort-arr">{sortDir === 'desc' ? '↓' : '↑'}</span>{/if}
                      ADX 14
                    </button>
                  </th>
                {:else}
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('changePercent')}>
                      Chg %
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('atr14')}>
                      ATR 14
                    </button>
                  </th>
                  <th class="num">
                    <button class="th-sort num" type="button" onclick={() => toggleSort('volatilityD')}>
                      Vol 1D %
                    </button>
                  </th>
                  <th class="num">High</th>
                  <th class="num">Low</th>
                  <th class="num">Range %</th>
                {/if}
                <th class="act-th"></th>
              </tr>
            </thead>
            <tbody>
              {#each filteredRows as row (row.symbol)}
                {@const inWl = watchlistShortSet.has(row.shortName.toUpperCase())}
                <tr
                  onclick={() => onSelectSymbol(row.symbol, row.shortName)}
                  title="Click to load {row.shortName} on chart"
                >
                  <td class="col-sym">
                    <div class="sym-row">
                      <SymbolIcon symbol={row.shortName} size={22} />
                      <span class="ticker-pill">{row.shortName}</span>
                    </div>
                  </td>

                  <td class="num px-cell">
                    {formatQuotePrice(row.price, row.shortName)}
                  </td>

                  {#if columnPreset === 'overview'}
                    <td class="num" class:pos={row.changePercent > 0} class:neg={row.changePercent < 0}>
                      {formatPct(row.changePercent)}
                    </td>
                    <td title={buildTechTooltip(row)}>
                      <span class="rating-txt {ratingTone(row.rating)}">
                        {#if row.rating === 'Strong buy'}▲▲{:else if row.rating === 'Buy'}▲{:else if row.rating === 'Strong sell'}▼▼{:else if row.rating === 'Sell'}▼{:else}—{/if}
                        {row.rating}
                      </span>
                    </td>
                    <td class="num muted" title={buildVolTooltip(row)}>
                      {row.volatilityD !== null ? `${row.volatilityD.toFixed(2)}%` : '—'}
                    </td>
                    <td class="num">
                      {#if row.rangePosPct !== null}
                        <div class="rng-cell" title="Position inside today's Low–High range: {row.rangePosPct}%">
                          <span class="rng-track">
                            <span class="rng-dot" style:left="{row.rangePosPct}%"></span>
                          </span>
                          <span class="rng-num">{row.rangePosPct}%</span>
                        </div>
                      {:else}
                        <span class="muted">—</span>
                      {/if}
                    </td>
                    <td>
                      <span class="macro-tag {row.macroBias}" title={row.macroReason}>
                        {row.macroBias === 'tailwind' ? 'Tailwind' : row.macroBias === 'headwind' ? 'Headwind' : 'Neutral'}
                      </span>
                    </td>
                  {:else if columnPreset === 'performance'}
                    <td class="num" class:pos={(row.change1h ?? 0) > 0} class:neg={(row.change1h ?? 0) < 0}>{formatPct(row.change1h)}</td>
                    <td class="num" class:pos={(row.change4h ?? 0) > 0} class:neg={(row.change4h ?? 0) < 0}>{formatPct(row.change4h)}</td>
                    <td class="num" class:pos={row.changePercent > 0} class:neg={row.changePercent < 0}>{formatPct(row.changePercent)}</td>
                    <td class="num" class:pos={(row.perfW ?? 0) > 0} class:neg={(row.perfW ?? 0) < 0}>{formatPct(row.perfW)}</td>
                    <td class="num" class:pos={(row.perf1M ?? 0) > 0} class:neg={(row.perf1M ?? 0) < 0}>{formatPct(row.perf1M)}</td>
                    <td class="num" class:pos={(row.perfYTD ?? 0) > 0} class:neg={(row.perfYTD ?? 0) < 0}>{formatPct(row.perfYTD)}</td>
                  {:else if columnPreset === 'technicals'}
                    <td><span class="rating-txt {ratingTone(row.rating)}">{row.rating}</span></td>
                    <td><span class="rating-txt {ratingTone(row.maRating)}">{row.maRating}</span></td>
                    <td><span class="rating-txt {ratingTone(row.oscRating)}">{row.oscRating}</span></td>
                    <td
                      class="num"
                      class:neg={row.rsi14 !== null && row.rsi14 >= 70}
                      class:pos={row.rsi14 !== null && row.rsi14 <= 30}
                    >
                      {formatNum(row.rsi14, 1)}
                    </td>
                    <td class="num muted">{formatNum(row.adx14, 1)}</td>
                  {:else}
                    <td class="num" class:pos={row.changePercent > 0} class:neg={row.changePercent < 0}>
                      {formatPct(row.changePercent)}
                    </td>
                    <td class="num muted">{row.atr14 !== null ? formatQuotePrice(row.atr14, row.shortName) : '—'}</td>
                    <td class="num">{row.volatilityD !== null ? `${row.volatilityD.toFixed(2)}%` : '—'}</td>
                    <td class="num muted">{row.high !== null ? formatQuotePrice(row.high, row.shortName) : '—'}</td>
                    <td class="num muted">{row.low !== null ? formatQuotePrice(row.low, row.shortName) : '—'}</td>
                    <td class="num">{row.rangePosPct !== null ? `${row.rangePosPct}%` : '—'}</td>
                  {/if}

                  <td class="act-td">
                    <div class="row-actions">
                      <button
                        class="ra-btn"
                        type="button"
                        title="Open Symbol Insights (Technicals & Seasonals)"
                        aria-label="Open Symbol Insights"
                        onclick={(e) => {
                          e.stopPropagation();
                          onOpenSymbolInsights(row.symbol, row.shortName, row.description, 'technicals');
                        }}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 11.5 6.5 8l2.5 2.2L13 5.5" />
                          <path d="M10.2 5.5H13v2.8" />
                        </svg>
                      </button>

                      <button
                        class="ra-btn"
                        class:in-wl={inWl}
                        type="button"
                        title={inWl ? 'In your Watchlist' : 'Add to active Watchlist'}
                        aria-label={inWl ? 'In Watchlist' : 'Add to Watchlist'}
                        onclick={(e) => void addToActiveWatchlist(row, e)}
                      >
                        {inWl ? '✓' : '+'}
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .screener-shell {
    position: relative;
    height: 100%;
    flex-shrink: 0;
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
    border-left: 1px solid var(--dark-border-subtle);
    display: flex;
    overflow: hidden;
    user-select: none;
  }

  .screener-shell.light {
    background: #ffffff;
    color: #131722;
    border-left-color: #e6e9ef;
  }

  .screener-shell.fullscreen {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 45;
    border-left: 0;
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
  }

  .resize-handle:hover .resize-pill,
  .screener-shell.dragging .resize-pill {
    background: var(--dark-handle);
  }

  .scr-inner {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* ── Top Bar ───────────────────────────────────────────────────────────── */
  .scr-top-bar {
    height: 40px;
    flex: 0 0 40px;
    padding: 0 10px 0 12px;
    border-bottom: 1px solid var(--dark-border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .screener-shell.light .scr-top-bar {
    border-bottom-color: #eceff4;
  }

  .menu-anchor {
    position: relative;
  }

  .screener-switcher {
    height: 30px;
    padding: 0 8px 0 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .screener-switcher:hover {
    background: var(--dark-hover-strong);
  }

  .screener-shell.light .screener-switcher:hover {
    background: #f0f2f6;
  }

  .sw-ic {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.78;
  }

  .caret {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.65;
  }

  .top-right-acts {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .hdr-ic {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .hdr-ic:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .screener-shell.light .hdr-ic {
    color: #5d6473;
  }

  .screener-shell.light .hdr-ic:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .hdr-ic svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ── Sub-Header ────────────────────────────────────────────────────────── */
  .scr-subhead {
    padding: 10px 14px 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
  }

  .title-trigger {
    border: 0;
    padding: 2px 4px 2px 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.02em;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .subhead-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .upd-stamp {
    font-size: 11px;
    color: var(--dark-text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* ── Quick-Filter Strip ────────────────────────────────────────────────── */
  .quick-strip {
    padding: 2px 14px 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    scroll-behavior: smooth;
    flex: 0 0 auto;
  }

  .quick-strip::-webkit-scrollbar {
    display: none;
  }

  .q-pill {
    height: 26px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid var(--dark-border);
    background: transparent;
    color: var(--dark-text-soft);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .q-pill:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .q-pill.active {
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    border-color: transparent;
    font-weight: 600;
  }

  .screener-shell.light .q-pill {
    border-color: #e0e3eb;
    color: #4a5160;
  }

  .screener-shell.light .q-pill:hover {
    background: #f2f4f8;
    color: #131722;
  }

  .screener-shell.light .q-pill.active {
    background: #131722;
    color: #ffffff;
  }

  /* ── Action Toolbar ────────────────────────────────────────────────────── */
  .scr-toolbar {
    padding: 2px 14px 10px;
    border-bottom: 1px solid var(--dark-border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
  }

  .screener-shell.light .scr-toolbar {
    border-bottom-color: #eceff4;
  }

  .tb-left,
  .tb-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tb-outlined {
    height: 30px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .tb-outlined:hover,
  .tb-outlined.active {
    background: var(--dark-hover-strong);
    border-color: var(--dark-handle);
  }

  .screener-shell.light .tb-outlined {
    border-color: #d6dae1;
  }

  .screener-shell.light .tb-outlined:hover,
  .screener-shell.light .tb-outlined.active {
    background: #f2f4f8;
    border-color: #b8becb;
  }

  .tb-outlined svg,
  .tb-ghost svg,
  .tb-icon-sq svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .f-cnt {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    font-size: 10px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }

  .screener-shell.light .f-cnt {
    background: #131722;
    color: #ffffff;
  }

  .tb-icon-sq {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    border: 1px solid var(--dark-border);
    background: transparent;
    color: var(--dark-text-soft);
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .tb-icon-sq:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .screener-shell.light .tb-icon-sq {
    border-color: #e0e3eb;
    color: #4a5160;
  }

  .screener-shell.light .tb-icon-sq:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .v-sep {
    width: 1px;
    height: 18px;
    background: var(--dark-border-subtle);
    margin: 0 2px;
  }

  .screener-shell.light .v-sep {
    background: #e0e3eb;
  }

  .tb-ghost {
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .tb-ghost:hover {
    background: var(--dark-hover-strong);
  }

  .screener-shell.light .tb-ghost:hover {
    background: #f0f2f6;
  }

  .spin {
    animation: scr-spin 0.85s linear infinite;
  }

  @keyframes scr-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ── TradingView Dropdowns ─────────────────────────────────────────────── */
  .tv-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 188px;
    padding: 5px;
    border-radius: 8px;
    background: var(--dark-bg-glass-strong);
    border: 1px solid var(--dark-border-glass);
    box-shadow: var(--dark-shadow-popover);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .screener-shell.light .tv-dropdown {
    background: #ffffff;
    border-color: #e0e3eb;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
  }

  .tv-opt {
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .tv-opt:hover {
    background: var(--dark-hover-strong);
  }

  .tv-opt.active {
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    font-weight: 600;
  }

  .screener-shell.light .tv-opt:hover {
    background: #f2f4f8;
  }

  .screener-shell.light .tv-opt.active {
    background: #131722;
    color: #ffffff;
  }

  /* ── Flat Filter Strip ─────────────────────────────────────────────────── */
  .filters-bar {
    padding: 8px 14px;
    border-bottom: 1px solid var(--dark-border-subtle);
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    flex: 0 0 auto;
    background: var(--dark-bg-subtle);
  }

  .screener-shell.light .filters-bar {
    background: #fafbfc;
    border-bottom-color: #eceff4;
  }

  .fl-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 10.5px;
    color: var(--dark-text-secondary);
  }

  .fl-item input,
  .fl-item select {
    height: 28px;
    padding: 0 7px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }

  .fl-item input {
    width: 72px;
  }

  .screener-shell.light .fl-item input,
  .screener-shell.light .fl-item select {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  /* ── Flat Dense Screener Table ─────────────────────────────────────────── */
  .table-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    scroll-behavior: smooth;
  }

  .table-scroll::-webkit-scrollbar {
    display: none;
  }

  .scr-status {
    padding: 36px 18px;
    text-align: center;
    font-size: 13px;
    color: var(--dark-text-secondary);
  }

  .scr-status.err {
    color: #f23645;
  }

  .link-reset {
    border: 0;
    background: transparent;
    color: #2962ff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    margin-left: 6px;
  }

  .scr-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  .scr-table thead th {
    position: sticky;
    top: 0;
    z-index: 3;
    height: 36px;
    padding: 0 10px;
    text-align: left;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--dark-text-secondary);
    background: var(--dark-bg-base);
    border-bottom: 1px solid var(--dark-border-subtle);
    white-space: nowrap;
  }

  .screener-shell.light .scr-table thead th {
    background: #ffffff;
    color: #6a7282;
    border-bottom-color: #eceff4;
  }

  .scr-table tbody tr {
    height: 42px;
    border-bottom: 1px solid var(--dark-border-subtle);
    cursor: pointer;
    transition: background-color 80ms ease;
  }

  .scr-table tbody tr:hover {
    background: var(--dark-hover);
  }

  .screener-shell.light .scr-table tbody tr {
    border-bottom-color: #f0f2f6;
  }

  .screener-shell.light .scr-table tbody tr:hover {
    background: #f8f9fc;
  }

  .scr-table td {
    padding: 0 10px;
    white-space: nowrap;
  }

  .scr-table th.num,
  .scr-table td.num {
    text-align: right;
  }

  .sym-th {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .search-ic-btn {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .search-ic-btn:hover {
    background: var(--dark-hover-strong);
  }

  .search-ic-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .sym-search {
    width: 126px;
    height: 24px;
    padding: 0 7px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }

  .screener-shell.light .sym-search {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .th-sort {
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    font-weight: inherit;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  .th-sort.num {
    justify-content: flex-end;
    width: 100%;
  }

  .sym-cnt {
    font-size: 11px;
    opacity: 0.65;
  }

  .sort-arr {
    color: var(--dark-text-strong);
    font-weight: 700;
  }

  .screener-shell.light .sort-arr {
    color: #131722;
  }

  .sym-row {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .ticker-pill {
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-strong);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .screener-shell.light .ticker-pill {
    background: #f0f2f6;
    color: #131722;
  }

  .px-cell {
    font-weight: 500;
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

  .screener-shell.light .muted {
    color: #6a7282;
  }

  .rating-txt {
    font-size: 12px;
    font-weight: 600;
  }

  .rating-txt.strong-buy {
    color: #2962ff;
  }

  .rating-txt.buy {
    color: #089981;
  }

  .rating-txt.sell {
    color: #f59e0b;
  }

  .rating-txt.strong-sell {
    color: #f23645;
  }

  .rating-txt.neutral {
    color: var(--dark-text-secondary);
  }

  .rng-cell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .rng-track {
    position: relative;
    width: 34px;
    height: 3px;
    border-radius: 99px;
    background: var(--dark-border-strong);
    display: inline-block;
  }

  .screener-shell.light .rng-track {
    background: #dce0e8;
  }

  .rng-dot {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--dark-text-strong);
  }

  .screener-shell.light .rng-dot {
    background: #131722;
  }

  .rng-num {
    font-size: 11px;
    color: var(--dark-text-secondary);
    width: 28px;
    text-align: right;
  }

  .macro-tag {
    font-size: 11px;
    font-weight: 600;
  }

  .macro-tag.tailwind {
    color: #089981;
  }

  .macro-tag.headwind {
    color: #f23645;
  }

  .macro-tag.neutral {
    color: var(--dark-text-secondary);
  }

  .act-th,
  .act-td {
    width: 58px;
    text-align: right;
    padding-right: 10px;
  }

  .row-actions {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    opacity: 0.45;
    transition: opacity 100ms ease;
  }

  .scr-table tbody tr:hover .row-actions {
    opacity: 1;
  }

  .ra-btn {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .ra-btn:hover {
    background: var(--dark-hover-strong);
  }

  .screener-shell.light .ra-btn:hover {
    background: #e9ecf3;
  }

  .ra-btn.in-wl {
    color: #089981;
    font-size: 12px;
  }

  .ra-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
