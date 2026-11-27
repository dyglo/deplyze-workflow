<script lang="ts">
  import { onMount } from 'svelte';
  import { formatQuotePrice } from '../watchlist/store';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    computeSquarifiedTreemap,
    getHeatmapBuckets,
    getHeatmapThresholds,
    valueToBucketIndex
  } from './treemap';
  import type {
    EnrichedScreenerRow,
    HeatmapColorBy,
    HeatmapColorScheme,
    HeatmapDisplaySettings,
    HeatmapGroupBy,
    HeatmapSizeBy,
    ScreenerScopeId
  } from './types';
  import { SCREENER_SCOPES } from './universe';

  interface Props {
    theme: 'dark' | 'light';
    rows: EnrichedScreenerRow[];
    scope: ScreenerScopeId;
    fullscreen: boolean;
    onChangeScope: (next: ScreenerScopeId) => void;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onSwitchToTable: () => void;
    onToggleFullscreen: () => void;
  }

  let {
    theme,
    rows,
    scope,
    fullscreen,
    onChangeScope,
    onSelectSymbol,
    onSwitchToTable,
    onToggleFullscreen
  }: Props = $props();

  let sizeBy = $state<HeatmapSizeBy>('mono');
  let colorBy = $state<HeatmapColorBy>('change_1d');
  let groupBy = $state<HeatmapGroupBy>('category');
  let display = $state<HeatmapDisplaySettings>({
    showLogo: true,
    titleMode: 'symbol',
    valueMode: 'color_metric',
    colorScheme: 'classic'
  });

  let openMenu = $state<'source' | 'size' | 'color' | 'group' | 'settings' | null>(null);
  let hiddenBuckets = $state<Record<number, boolean>>({});
  let hoveredRow = $state<EnrichedScreenerRow | null>(null);
  let hoveredGroup = $state<string | null>(null);
  let drilledGroup = $state<string | null>(null);

  let canvasWrapEl: HTMLDivElement | undefined = $state();
  let canvasW = $state(640);
  let canvasH = $state(420);

  const SIZE_OPTIONS: { id: HeatmapSizeBy; label: string }[] = [
    { id: 'mono', label: 'Mono size' },
    { id: 'volatility', label: 'Volatility 1D, %' },
    { id: 'abs_change', label: 'Abs Change, %' }
  ];

  const COLOR_OPTIONS: { id: HeatmapColorBy; label: string }[] = [
    { id: 'change_1d', label: 'Change 1D, %' },
    { id: 'change_4h', label: 'Change 4H, %' },
    { id: 'change_1h', label: 'Change 1H, %' },
    { id: 'perf_w', label: 'Perf 1W, %' },
    { id: 'perf_1m', label: 'Perf 1M, %' },
    { id: 'perf_ytd', label: 'Perf YTD, %' },
    { id: 'tech_rating', label: 'Technical Rating' }
  ];

  const GROUP_OPTIONS: { id: HeatmapGroupBy; label: string }[] = [
    { id: 'category', label: 'Asset class' },
    { id: 'watchlist_section', label: 'Watchlist section' },
    { id: 'none', label: 'No group' }
  ];

  const isWideMarket = $derived(
    scope === 'crypto' ||
      scope === 'stocks' ||
      colorBy === 'perf_w' ||
      colorBy === 'perf_1m' ||
      colorBy === 'perf_ytd'
  );
  const isTechRating = $derived(colorBy === 'tech_rating');
  const thresholds = $derived(getHeatmapThresholds(isWideMarket, isTechRating));
  const buckets = $derived(
    getHeatmapBuckets(display.colorScheme, theme, isWideMarket, isTechRating)
  );

  function getColorMetric(row: EnrichedScreenerRow): number | null {
    if (colorBy === 'change_1d') return row.changePercent;
    if (colorBy === 'change_4h') return row.change4h;
    if (colorBy === 'change_1h') return row.change1h;
    if (colorBy === 'perf_w') return row.perfW;
    if (colorBy === 'perf_1m') return row.perf1M;
    if (colorBy === 'perf_ytd') return row.perfYTD;
    return row.recommendAll;
  }

  function getSizeWeight(row: EnrichedScreenerRow): number {
    if (sizeBy === 'volatility') {
      return Math.max(0.25, row.volatilityD ?? Math.abs(row.changePercent) + 0.5);
    }
    if (sizeBy === 'abs_change') {
      return Math.max(0.15, Math.abs(getColorMetric(row) ?? row.changePercent) + 0.2);
    }
    return 1;
  }

  function formatMetricValue(row: EnrichedScreenerRow): string {
    if (display.valueMode === 'price') {
      return formatQuotePrice(row.price, row.shortName);
    }
    if (colorBy === 'tech_rating') {
      return row.rating;
    }
    const v = getColorMetric(row);
    if (v === null || !Number.isFinite(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  }

  function formatSizeReadout(row: EnrichedScreenerRow): string {
    if (sizeBy === 'volatility') {
      return row.volatilityD !== null ? `${row.volatilityD.toFixed(2)}%` : '—';
    }
    if (sizeBy === 'abs_change') {
      const v = Math.abs(getColorMetric(row) ?? row.changePercent);
      return `${v.toFixed(2)}%`;
    }
    return 'Equal';
  }

  function getGroupName(row: EnrichedScreenerRow): string {
    if (groupBy === 'watchlist_section') {
      return row.watchlistSection || row.category;
    }
    return row.category;
  }

  const activeRows = $derived.by(() => {
    return rows.filter((r) => {
      if (drilledGroup && getGroupName(r) !== drilledGroup) return false;
      const bIdx = valueToBucketIndex(getColorMetric(r), thresholds);
      return !hiddenBuckets[bIdx];
    });
  });

  interface TileLayout {
    row: EnrichedScreenerRow;
    group: string;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    textColor: string;
    bucketIdx: number;
  }

  interface GroupLayout {
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    tiles: TileLayout[];
  }

  const layout = $derived.by((): { groups: GroupLayout[]; flatTiles: TileLayout[] } => {
    const W = Math.max(120, canvasW);
    const H = Math.max(120, canvasH);

    if (activeRows.length === 0) return { groups: [], flatTiles: [] };

    const makeTile = (r: EnrichedScreenerRow, group: string, rect: { x: number; y: number; w: number; h: number }): TileLayout => {
      const bIdx = valueToBucketIndex(getColorMetric(r), thresholds);
      const b = buckets[bIdx] ?? buckets[3];
      return {
        row: r,
        group,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        color: b.color,
        textColor: b.textColor,
        bucketIdx: bIdx
      };
    };

    if (groupBy === 'none' || drilledGroup) {
      const rects = computeSquarifiedTreemap(
        activeRows.map((r) => ({ id: r.symbol, weight: getSizeWeight(r), data: r })),
        0,
        0,
        W,
        H
      );
      return {
        groups: [],
        flatTiles: rects.map((rc) => makeTile(rc.data, getGroupName(rc.data), rc))
      };
    }

    // Group rows by Asset Class or Watchlist Section
    const byGrp = new Map<string, EnrichedScreenerRow[]>();
    for (const r of activeRows) {
      const g = getGroupName(r);
      const list = byGrp.get(g) ?? [];
      list.push(r);
      byGrp.set(g, list);
    }

    const groupInputs = Array.from(byGrp.entries()).map(([name, items]) => ({
      id: name,
      weight: items.reduce((s, i) => s + getSizeWeight(i), 0),
      data: { name, items }
    }));

    const outerRects = computeSquarifiedTreemap(groupInputs, 0, 0, W, H);
    const HEADER_H = 20;
    const GAP = 3;

    const groups: GroupLayout[] = outerRects.map((gr) => {
      const gx = gr.x + GAP / 2;
      const gy = gr.y + GAP / 2;
      const gw = Math.max(20, gr.w - GAP);
      const gh = Math.max(26, gr.h - GAP);
      const innerH = Math.max(10, gh - HEADER_H);
      const innerRects = computeSquarifiedTreemap(
        gr.data.items.map((r) => ({ id: r.symbol, weight: getSizeWeight(r), data: r })),
        0,
        0,
        gw,
        innerH
      );
      return {
        name: gr.data.name,
        x: gx,
        y: gy,
        w: gw,
        h: gh,
        tiles: innerRects.map((rc) => makeTile(rc.data, gr.data.name, rc))
      };
    });

    return { groups, flatTiles: [] };
  });

  function toggleBucket(idx: number) {
    hiddenBuckets = { ...hiddenBuckets, [idx]: !hiddenBuckets[idx] };
  }

  onMount(() => {
    const onDocDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (openMenu && !target?.closest('[data-hm-menu]')) {
        openMenu = null;
      }
    };
    window.addEventListener('pointerdown', onDocDown);

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (cr && cr.width > 60 && cr.height > 60) {
          canvasW = Math.floor(cr.width);
          canvasH = Math.floor(cr.height);
        }
      });
      if (canvasWrapEl) ro.observe(canvasWrapEl);
    }

    return () => {
      window.removeEventListener('pointerdown', onDocDown);
      ro?.disconnect();
    };
  });

  $effect(() => {
    if (canvasWrapEl) {
      canvasW = Math.floor(canvasWrapEl.clientWidth) || 640;
      canvasH = Math.floor(canvasWrapEl.clientHeight) || 420;
    }
  });

  const activeScopeLabel = $derived(
    SCREENER_SCOPES.find((s) => s.id === scope)?.shortLabel ?? 'All markets'
  );
  const activeSizeLabel = $derived(
    SIZE_OPTIONS.find((s) => s.id === sizeBy)?.label ?? 'Mono size'
  );
  const activeColorLabel = $derived(
    COLOR_OPTIONS.find((c) => c.id === colorBy)?.label ?? 'Change 1D, %'
  );
  const activeGroupLabel = $derived(
    GROUP_OPTIONS.find((g) => g.id === groupBy)?.label ?? 'Asset class'
  );
</script>

<div class="hm-root" class:light={theme === 'light'}>
  <!-- TradingView Heatmap Control Bar (34px controls, hairline divider) -->
  <div class="hm-toolbar">
    <div class="hm-left-controls">
      <!-- Source Outlined Pill -->
      <div class="menu-anchor" data-hm-menu>
        <button
          class="tv-pill-select"
          type="button"
          onclick={() => (openMenu = openMenu === 'source' ? null : 'source')}
        >
          <span>{activeScopeLabel}</span>
          <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if openMenu === 'source'}
          <div class="tv-dropdown">
            {#each SCREENER_SCOPES as sc (sc.id)}
              <button
                class="tv-opt"
                class:active={scope === sc.id}
                type="button"
                onclick={() => {
                  drilledGroup = null;
                  onChangeScope(sc.id);
                  openMenu = null;
                }}
              >
                {sc.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <span class="v-divider" aria-hidden="true"></span>

      <!-- Size by Ghost Selector -->
      <div class="menu-anchor" data-hm-menu>
        <button
          class="tv-ghost-select"
          type="button"
          title="Size by"
          onclick={() => (openMenu = openMenu === 'size' ? null : 'size')}
        >
          <svg class="ctl-ic" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1" />
            <rect x="11.5" y="2.5" width="4" height="5" rx="0.8" />
            <rect x="11.5" y="9" width="4" height="6.5" rx="0.8" />
            <rect x="2.5" y="11.5" width="7.5" height="4" rx="0.8" />
          </svg>
          <span class="ctl-txt">{activeSizeLabel}</span>
          <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if openMenu === 'size'}
          <div class="tv-dropdown">
            <div class="dd-head">SIZE BY</div>
            {#each SIZE_OPTIONS as opt (opt.id)}
              <button
                class="tv-opt"
                class:active={sizeBy === opt.id}
                type="button"
                onclick={() => {
                  sizeBy = opt.id;
                  openMenu = null;
                }}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Color by Ghost Selector -->
      <div class="menu-anchor" data-hm-menu>
        <button
          class="tv-ghost-select"
          type="button"
          title="Color by"
          onclick={() => (openMenu = openMenu === 'color' ? null : 'color')}
        >
          <svg class="ctl-ic color-grid" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2" width="5.5" height="5.5" rx="1" fill="#F23645" stroke="none" />
            <rect x="8.5" y="2" width="5.5" height="5.5" rx="1" fill="#991F29" stroke="none" />
            <rect x="2" y="8.5" width="5.5" height="5.5" rx="1" fill="#42BD7F" stroke="none" />
            <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" fill="#089950" stroke="none" />
          </svg>
          <span class="ctl-txt">{activeColorLabel}</span>
          <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if openMenu === 'color'}
          <div class="tv-dropdown">
            <div class="dd-head">COLOR BY</div>
            {#each COLOR_OPTIONS as opt (opt.id)}
              <button
                class="tv-opt"
                class:active={colorBy === opt.id}
                type="button"
                onclick={() => {
                  colorBy = opt.id;
                  openMenu = null;
                }}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Group by Ghost Selector -->
      <div class="menu-anchor" data-hm-menu>
        <button
          class="tv-ghost-select"
          type="button"
          title="Group by"
          onclick={() => (openMenu = openMenu === 'group' ? null : 'group')}
        >
          <svg class="ctl-ic" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="6.25" />
            <path d="M9 2.75V9l4.5 4.25" />
          </svg>
          <span class="ctl-txt">{activeGroupLabel}</span>
          <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {#if openMenu === 'group'}
          <div class="tv-dropdown">
            <div class="dd-head">GROUP BY</div>
            {#each GROUP_OPTIONS as opt (opt.id)}
              <button
                class="tv-opt"
                class:active={groupBy === opt.id}
                type="button"
                onclick={() => {
                  drilledGroup = null;
                  groupBy = opt.id;
                  openMenu = null;
                }}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if drilledGroup}
        <button class="drill-back" type="button" onclick={() => (drilledGroup = null)}>
          ← All groups ({drilledGroup})
        </button>
      {/if}
    </div>

    <div class="hm-right-controls">
      <button class="tv-ghost-select" type="button" onclick={onSwitchToTable}>
        <svg class="ctl-ic" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M3 4.5h12M3 9h12M3 13.5h12" />
        </svg>
        <span class="ctl-txt">Open in Screener</span>
      </button>

      <!-- Display Settings Popover -->
      <div class="menu-anchor" data-hm-menu>
        <button
          class="tv-icon-btn"
          class:active={openMenu === 'settings'}
          type="button"
          title="Display settings"
          aria-label="Display settings"
          onclick={() => (openMenu = openMenu === 'settings' ? null : 'settings')}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7.2 4h5.6a1.5 1.5 0 0 1 1.3.75l2.8 4.5a1.5 1.5 0 0 1 0 1.5l-2.8 4.5a1.5 1.5 0 0 1-1.3.75H7.2a1.5 1.5 0 0 1-1.3-.75l-2.8-4.5a1.5 1.5 0 0 1 0-1.5l2.8-4.5A1.5 1.5 0 0 1 7.2 4Z" />
            <circle cx="10" cy="10" r="2.5" />
          </svg>
        </button>

        {#if openMenu === 'settings'}
          <div class="tv-dropdown right settings-pop">
            <div class="dd-head">DISPLAY SETTINGS</div>

            <label class="set-chk">
              <span>Logo</span>
              <input type="checkbox" bind:checked={display.showLogo} />
            </label>

            <div class="set-row">
              <span>Title</span>
              <select bind:value={display.titleMode}>
                <option value="symbol">Symbol</option>
                <option value="name">Name</option>
                <option value="none">None</option>
              </select>
            </div>

            <div class="set-row">
              <span>Display value</span>
              <select bind:value={display.valueMode}>
                <option value="color_metric">Color metric</option>
                <option value="price">Price</option>
                <option value="none">None</option>
              </select>
            </div>

            <div class="set-row">
              <span>Color scheme</span>
              <select bind:value={display.colorScheme}>
                <option value="classic">Classic</option>
                <option value="colorblind">Color blind</option>
                <option value="monochrome">Monochrome</option>
              </select>
            </div>
          </div>
        {/if}
      </div>

      <button
        class="tv-icon-btn"
        type="button"
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen mode'}
        aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen mode'}
        onclick={onToggleFullscreen}
      >
        {#if fullscreen}
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M6.5 3.5v3h-3M11.5 3.5v3h3M6.5 14.5v-3h-3M11.5 14.5v-3h3" />
          </svg>
        {:else}
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M3.5 6.5v-3h3M14.5 6.5v-3h-3M3.5 11.5v3h3M14.5 11.5v3h-3" />
          </svg>
        {/if}
      </button>
    </div>
  </div>

  <!-- Full-Bleed Squarified Treemap Canvas -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={canvasWrapEl}
    class="hm-canvas"
    onmouseleave={() => {
      hoveredRow = null;
      hoveredGroup = null;
    }}
  >
    {#if activeRows.length === 0}
      <div class="hm-empty">No instruments match the active heatmap filters.</div>
    {:else if layout.groups.length > 0}
      {#each layout.groups as grp (grp.name)}
        {@const isGrpHovered = hoveredGroup === grp.name}
        <div
          class="hm-group"
          class:hovered={isGrpHovered}
          style:left="{grp.x}px"
          style:top="{grp.y}px"
          style:width="{grp.w}px"
          style:height="{grp.h}px"
        >
          <button
            class="hm-group-head"
            type="button"
            title="Click to zoom into {grp.name}"
            onclick={() => (drilledGroup = grp.name)}
          >
            <span class="gh-name">{grp.name}</span>
            <span class="gh-chev">›</span>
          </button>

          <div class="hm-group-body">
            {#each grp.tiles as tile (tile.row.symbol)}
              {@const tier =
                tile.w >= 94 && tile.h >= 68
                  ? 'large'
                  : tile.w >= 56 && tile.h >= 40
                    ? 'medium'
                    : tile.w >= 32 && tile.h >= 22
                      ? 'small'
                      : 'tiny'}
              <button
                class="hm-tile {tier}"
                class:hovered={hoveredRow?.symbol === tile.row.symbol}
                type="button"
                style:left="{tile.x}px"
                style:top="{tile.y}px"
                style:width="{tile.w}px"
                style:height="{tile.h}px"
                style:background={tile.color}
                style:color={tile.textColor}
                onmouseenter={() => {
                  hoveredRow = tile.row;
                  hoveredGroup = grp.name;
                }}
                onclick={() => onSelectSymbol(tile.row.symbol, tile.row.shortName)}
              >
                {#if tier === 'large'}
                  {#if display.showLogo}
                    <span class="tile-logo">
                      <SymbolIcon symbol={tile.row.shortName} size={Math.min(34, Math.max(22, Math.floor(tile.h * 0.28)))} />
                    </span>
                  {/if}
                  {#if display.titleMode !== 'none'}
                    <span class="tile-title">
                      {display.titleMode === 'name' ? tile.row.description : tile.row.shortName}
                    </span>
                  {/if}
                  {#if display.valueMode !== 'none'}
                    <span class="tile-val">{formatMetricValue(tile.row)}</span>
                  {/if}
                {:else if tier === 'medium'}
                  {#if display.titleMode !== 'none'}
                    <span class="tile-title sm">
                      {tile.row.shortName}
                    </span>
                  {/if}
                  {#if display.valueMode !== 'none'}
                    <span class="tile-val sm">{formatMetricValue(tile.row)}</span>
                  {/if}
                {:else if tier === 'small'}
                  <span class="tile-title xs">{tile.row.shortName}</span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      <!-- Flat ungrouped treemap -->
      {#each layout.flatTiles as tile (tile.row.symbol)}
        {@const tier =
          tile.w >= 96 && tile.h >= 70
            ? 'large'
            : tile.w >= 58 && tile.h >= 40
              ? 'medium'
              : tile.w >= 32 && tile.h >= 22
                ? 'small'
                : 'tiny'}
        <button
          class="hm-tile {tier}"
          class:hovered={hoveredRow?.symbol === tile.row.symbol}
          type="button"
          style:left="{tile.x}px"
          style:top="{tile.y}px"
          style:width="{tile.w}px"
          style:height="{tile.h}px"
          style:background={tile.color}
          style:color={tile.textColor}
          onmouseenter={() => {
            hoveredRow = tile.row;
            hoveredGroup = null;
          }}
          onclick={() => onSelectSymbol(tile.row.symbol, tile.row.shortName)}
        >
          {#if tier === 'large'}
            {#if display.showLogo}
              <span class="tile-logo">
                <SymbolIcon symbol={tile.row.shortName} size={Math.min(36, Math.max(22, Math.floor(tile.h * 0.28)))} />
              </span>
            {/if}
            {#if display.titleMode !== 'none'}
              <span class="tile-title">
                {display.titleMode === 'name' ? tile.row.description : tile.row.shortName}
              </span>
            {/if}
            {#if display.valueMode !== 'none'}
              <span class="tile-val">{formatMetricValue(tile.row)}</span>
            {/if}
          {:else if tier === 'medium'}
            {#if display.titleMode !== 'none'}
              <span class="tile-title sm">{tile.row.shortName}</span>
            {/if}
            {#if display.valueMode !== 'none'}
              <span class="tile-val sm">{formatMetricValue(tile.row)}</span>
            {/if}
          {:else if tier === 'small'}
            <span class="tile-title xs">{tile.row.shortName}</span>
          {/if}
        </button>
      {/each}
    {/if}

    <!-- TradingView Fixed Bottom-Centered Hover Tooltip Bar -->
    {#if hoveredRow}
      <div class="hm-tooltip" aria-live="polite">
        <div class="tt-asset">
          <SymbolIcon symbol={hoveredRow.shortName} size={26} />
          <div class="tt-asset-txt">
            <span class="tt-sym">{hoveredRow.shortName}</span>
            <span class="tt-cat">{hoveredRow.category}</span>
          </div>
        </div>

        <div class="tt-col">
          <span class="tt-val">{formatQuotePrice(hoveredRow.price, hoveredRow.shortName)}</span>
          <span class="tt-lbl">PRICE</span>
        </div>

        <div class="tt-col">
          <span class="tt-val">{formatSizeReadout(hoveredRow)}</span>
          <span class="tt-lbl">{activeSizeLabel.toUpperCase()}</span>
        </div>

        <div class="tt-col">
          <span
            class="tt-val"
            class:pos={(getColorMetric(hoveredRow) ?? 0) > 0}
            class:neg={(getColorMetric(hoveredRow) ?? 0) < 0}
          >
            {formatMetricValue(hoveredRow)}
          </span>
          <span class="tt-lbl">{activeColorLabel.toUpperCase()}</span>
        </div>

        <div class="tt-col">
          <span class="tt-val">{hoveredRow.rating}</span>
          <span class="tt-lbl">
            {#if typeof hoveredRow.crowdLongPct === 'number' && Number.isFinite(hoveredRow.crowdLongPct)}
              CROWD {hoveredRow.crowdLongPct.toFixed(0)}% L
            {:else if hoveredRow.relVolume !== null}
              RVOL {hoveredRow.relVolume.toFixed(1)}X
            {:else}
              TECH RATING
            {/if}
          </span>
        </div>
      </div>
    {/if}
  </div>

  <!-- TradingView 7-Bucket Interactive Bottom Legend Bar -->
  <div class="hm-footer" aria-label="Heatmap legend">
    <div class="legend-strip">
      {#each buckets as b (b.index)}
        {@const hidden = Boolean(hiddenBuckets[b.index])}
        <button
          class="leg-btn"
          class:dimmed={hidden}
          type="button"
          aria-pressed={!hidden}
          title={hidden ? `Show ${b.label} tiles` : `Filter out ${b.label} tiles`}
          onclick={() => toggleBucket(b.index)}
        >
          <span class="leg-lbl">{b.label}</span>
          <span class="leg-bar" style:background={b.color}></span>
        </button>
      {/each}
    </div>

    <div class="hm-meta-right">
      <span>{activeRows.length} instruments</span>
      {#if Object.values(hiddenBuckets).some(Boolean)}
        <button class="reset-leg" type="button" onclick={() => (hiddenBuckets = {})}>
          Show all
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .hm-root {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
  }

  .hm-root.light {
    background: #ffffff;
    color: #131722;
  }

  /* ── TradingView Heatmap Control Row ───────────────────────────────────── */
  .hm-toolbar {
    min-height: 44px;
    padding: 5px 12px;
    border-bottom: 1px solid var(--dark-border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    flex: 0 0 auto;
  }

  .hm-root.light .hm-toolbar {
    border-bottom-color: #e6e9ef;
  }

  .hm-left-controls,
  .hm-right-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .menu-anchor {
    position: relative;
  }

  .tv-pill-select {
    height: 32px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
  }

  .tv-pill-select:hover {
    background: var(--dark-hover-strong);
  }

  .hm-root.light .tv-pill-select {
    border-color: #d6dae1;
  }

  .hm-root.light .tv-pill-select:hover {
    background: #f2f4f8;
  }

  .v-divider {
    width: 1px;
    height: 18px;
    background: var(--dark-border-subtle);
    margin: 0 3px;
  }

  .hm-root.light .v-divider {
    background: #e0e3eb;
  }

  .tv-ghost-select {
    height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--dark-text-primary);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
  }

  .tv-ghost-select:hover {
    background: var(--dark-hover-strong);
  }

  .hm-root.light .tv-ghost-select {
    color: #131722;
  }

  .hm-root.light .tv-ghost-select:hover {
    background: #f0f2f6;
  }

  .ctl-ic {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.78;
    flex: 0 0 16px;
  }

  .ctl-ic.color-grid {
    opacity: 1;
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

  .tv-icon-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: 1px solid var(--dark-border);
    background: transparent;
    color: var(--dark-text-soft);
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .tv-icon-btn:hover,
  .tv-icon-btn.active {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .hm-root.light .tv-icon-btn {
    border-color: #d6dae1;
    color: #4a5160;
  }

  .hm-root.light .tv-icon-btn:hover,
  .hm-root.light .tv-icon-btn.active {
    background: #f0f2f6;
    color: #131722;
  }

  .tv-icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .drill-back {
    height: 26px;
    padding: 0 9px;
    border-radius: 5px;
    border: 1px solid rgba(41, 98, 255, 0.45);
    background: rgba(41, 98, 255, 0.14);
    color: #6b96ff;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .hm-root.light .drill-back {
    color: #2962ff;
  }

  .tv-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 186px;
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

  .tv-dropdown.right {
    left: auto;
    right: 0;
  }

  .tv-dropdown.settings-pop {
    min-width: 224px;
    padding: 8px 10px;
    gap: 8px;
  }

  .hm-root.light .tv-dropdown {
    background: #ffffff;
    border-color: #e0e3eb;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
  }

  .dd-head {
    padding: 3px 8px 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--dark-text-secondary);
  }

  .tv-opt {
    height: 30px;
    padding: 0 9px;
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

  .hm-root.light .tv-opt:hover {
    background: #f2f4f8;
  }

  .hm-root.light .tv-opt.active {
    background: #131722;
    color: #ffffff;
  }

  .set-chk,
  .set-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
  }

  .set-row select {
    height: 26px;
    padding: 0 6px;
    border-radius: 5px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 11.5px;
  }

  .hm-root.light .set-row select {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  /* ── Squarified Treemap Canvas (Zero border-radius, crisp 1.5px gaps) ──── */
  .hm-canvas {
    position: relative;
    flex: 1;
    min-height: 220px;
    margin: 4px 6px 0;
    overflow: hidden;
    background: var(--dark-bg-base);
  }

  .hm-root.light .hm-canvas {
    background: #ffffff;
  }

  .hm-empty {
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 13px;
    color: var(--dark-text-secondary);
  }

  .hm-group {
    position: absolute;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid transparent;
    transition: border-color 80ms ease;
  }

  .hm-group.hovered {
    border-color: #2962ff;
    z-index: 4;
  }

  .hm-group-head {
    height: 20px;
    flex: 0 0 20px;
    padding: 0 6px;
    border: 0;
    background: var(--dark-bg-base);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 3px;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }

  .hm-root.light .hm-group-head {
    background: #ffffff;
    color: #131722;
  }

  .hm-group.hovered .hm-group-head {
    background: #2962ff;
    color: #ffffff;
  }

  .gh-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gh-chev {
    opacity: 0.72;
    font-size: 12px;
    line-height: 1;
  }

  .hm-group-body {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .hm-tile {
    position: absolute;
    border: 0;
    padding: 4px;
    border-radius: 0;
    outline: 1.5px solid var(--dark-bg-base);
    outline-offset: -0.75px;
    font-family: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    overflow: hidden;
    cursor: pointer;
    text-align: center;
    transition: filter 90ms ease;
  }

  .hm-root.light .hm-tile {
    outline-color: #ffffff;
  }

  .hm-tile.hovered {
    outline: 2px solid #2962ff;
    outline-offset: -1px;
    z-index: 5;
    filter: brightness(1.06);
  }

  .tile-logo {
    display: grid;
    place-items: center;
    margin-bottom: 2px;
  }

  .tile-title {
    font-size: 14px;
    font-weight: 700;
    line-height: 1.1;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: -0.01em;
  }

  .tile-title.sm {
    font-size: 11.5px;
  }

  .tile-title.xs {
    font-size: 9.5px;
    font-weight: 600;
  }

  .tile-val {
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .tile-val.sm {
    font-size: 10.5px;
  }

  /* ── Fixed Bottom-Centered TradingView Hover Tooltip ───────────────────── */
  .hm-tooltip {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 20;
    height: 58px;
    padding: 0 16px;
    border-radius: 8px;
    background: #181818;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    gap: 20px;
    pointer-events: none;
    white-space: nowrap;
  }

  .tt-asset {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .tt-asset-txt {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .tt-sym {
    font-size: 13.5px;
    font-weight: 700;
  }

  .tt-cat {
    font-size: 10px;
    color: #9e9e9e;
  }

  .tt-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tt-val {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .tt-val.pos {
    color: #42bd7f;
  }

  .tt-val.neg {
    color: #f77c80;
  }

  .tt-lbl {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #9e9e9e;
  }

  /* ── Bottom 7-Bucket Interactive Legend Bar ────────────────────────────── */
  .hm-footer {
    height: 40px;
    flex: 0 0 40px;
    padding: 4px 10px 4px 8px;
    border-top: 1px solid var(--dark-border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .hm-root.light .hm-footer {
    border-top-color: #eceff4;
  }

  .legend-strip {
    display: flex;
    align-items: stretch;
    gap: 2px;
    width: min(392px, 72%);
    height: 30px;
  }

  .leg-btn {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--dark-text-soft);
    font-family: inherit;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    transition: opacity 120ms ease;
  }

  .hm-root.light .leg-btn {
    color: #4a5160;
  }

  .leg-btn.dimmed {
    opacity: 0.3;
  }

  .leg-lbl {
    font-size: 10px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .leg-bar {
    width: 100%;
    height: 8px;
    display: block;
  }

  .hm-meta-right {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--dark-text-secondary);
    white-space: nowrap;
  }

  .reset-leg {
    border: 0;
    background: transparent;
    color: #2962ff;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }
</style>
