<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import { loadNotes } from '../notes/api';
  import { subscribeAlerts, type AlertsState } from '../alerts/store';
  import {
    computeAlignment,
    fetchMacroRegime,
    fetchSymbolBrief,
    getCachedMacroRegime,
    normalizeShortSymbol,
    resolveMacroForSymbol,
    type MacroBias,
    type MacroRegimeResponse,
    type SymbolBriefResponse
  } from '../insights/api';
  import type { InsightsViewId } from '../insights/symbolInsightsApi';
  import { makeWorkspaceId } from '../workspace/storage';
  import { feedPaperLiveSpread } from '../paper/store';
  import {
    SYMBOL_CATALOG,
    createDefaultWatchlistState,
    createWatchlistItem,
    fetchMarketQuotes,
    formatQuoteChange,
    formatQuotePct,
    formatQuotePrice,
    loadWatchlistState,
    saveWatchlistState,
    type BiasDirection,
    type MarketQuote,
    type WatchlistItem,
    type WatchlistState
  } from '../watchlist/store';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    activePrice?: number;
    activeChangePercent?: number;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onOpenSymbolInNewTab: (symbol: string, shortName: string) => void;
    onOpenNotesForSymbol: () => void;
    onCreateAlertForSymbol: (symbol: string, shortName: string, price?: number) => void;
    onCreateWatchlistAlert?: (groupId: string) => void;
    insightsOpen?: boolean;
    onOpenSymbolInsights: (
      symbol: string,
      shortName: string,
      description: string,
      view: InsightsViewId
    ) => void;
    onSelectInsightsSymbol?: (symbol: string, shortName: string, description: string) => void;
    onClose: () => void;
  }

  let {
    theme,
    activeSymbol,
    activeFullSymbol,
    activePrice,
    activeChangePercent,
    onSelectSymbol,
    onOpenSymbolInNewTab,
    onOpenNotesForSymbol,
    onCreateAlertForSymbol,
    onCreateWatchlistAlert = undefined,
    insightsOpen = false,
    onOpenSymbolInsights,
    onSelectInsightsSymbol = undefined,
    onClose
  }: Props = $props();

  let wlState = $state<WatchlistState>(createDefaultWatchlistState());
  let quotes = $state<Record<string, MarketQuote>>({});
  let notesCountBySymbol = $state<Record<string, number>>({});
  let alertsState = $state<AlertsState>({ alerts: [], log: [] });
  let macroRegime = $state<MacroRegimeResponse | null>(getCachedMacroRegime());
  let briefOpen = $state(false);
  let briefLoading = $state(false);
  let briefError = $state<string | null>(null);
  let symbolBrief = $state<SymbolBriefResponse | null>(null);
  let briefRefreshTick = $state(0);
  let lastHandledRefreshTick = 0;
  let lastBriefShort = '';
  let briefAbort: AbortController | null = null;
  let analysisMenuPos = $state<{ top: number; left: number } | null>(null);

  function toggleAnalysisMenu(e: MouseEvent) {
    e.stopPropagation();
    if (analysisMenuPos) {
      analysisMenuPos = null;
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuW = 196;
    const menuH = 198;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 760;
    const left = Math.round(Math.max(12, Math.min(vw - menuW - 12, rect.right - menuW)));
    const top =
      rect.bottom + menuH + 12 <= vh
        ? Math.round(rect.bottom + 6)
        : Math.round(Math.max(12, rect.top - menuH - 6));
    analysisMenuPos = { top, left };
  }

  function launchInsightsView(view: InsightsViewId) {
    if (!selectedItem) return;
    const q = resolveQuote(selectedItem);
    analysisMenuPos = null;
    onOpenSymbolInsights(selectedItem.symbol, selectedItem.shortName, q.description, view);
  }

  const SHEET_HEIGHT_KEY = 'deplyzeworkflow-wl-sheet-h';
  const DEFAULT_SHEET_HEIGHT = 320;
  function loadSavedSheetHeight(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_SHEET_HEIGHT;
    try {
      const raw = Number(localStorage.getItem(SHEET_HEIGHT_KEY));
      if (Number.isFinite(raw) && raw >= 120 && raw <= 900) return Math.round(raw);
    } catch {
      // ignore
    }
    return DEFAULT_SHEET_HEIGHT;
  }

  let wlContainerEl: HTMLDivElement | undefined = $state();
  let sheetHeight = $state<number>(loadSavedSheetHeight());
  let resizingSheet = $state(false);
  let dragStartY = 0;
  let dragStartH = DEFAULT_SHEET_HEIGHT;

  function clampSheetHeight(nextH: number): number {
    const totalH = wlContainerEl?.clientHeight ?? 760;
    const maxH = Math.max(220, Math.round(totalH - 135));
    return Math.max(120, Math.min(maxH, Math.round(nextH)));
  }

  function onSheetResizeDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    resizingSheet = true;
    dragStartY = e.clientY;
    dragStartH = sheetHeight;

    const onMove = (ev: PointerEvent) => {
      const deltaY = dragStartY - ev.clientY;
      sheetHeight = clampSheetHeight(dragStartH + deltaY);
    };
    const onEnd = (ev: PointerEvent) => {
      resizingSheet = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      try {
        if (target.hasPointerCapture(ev.pointerId)) {
          target.releasePointerCapture(ev.pointerId);
        }
      } catch {
        // ignore
      }
      try {
        localStorage.setItem(SHEET_HEIGHT_KEY, String(sheetHeight));
      } catch {
        // ignore
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  function resetSheetHeight() {
    sheetHeight = clampSheetHeight(DEFAULT_SHEET_HEIGHT);
    try {
      localStorage.setItem(SHEET_HEIGHT_KEY, String(sheetHeight));
    } catch {
      // ignore
    }
  }

  let selectedItemId = $state<string | null>(null);
  let groupMenuOpen = $state(false);
  let moreMenuOpen = $state(false);
  let addSymbolOpen = $state(false);
  let addSymbolQuery = $state('');
  let addTargetSectionId = $state<string | null>(null);
  let addSectionOpen = $state(false);
  let newSectionName = $state('');
  let newGroupOpen = $state(false);
  let newGroupName = $state('');

  const activeGroup = $derived(
    wlState.groups.find((g) => g.id === wlState.activeGroupId) ?? wlState.groups[0]
  );

  const allItems = $derived.by(() => {
    const out: WatchlistItem[] = [];
    for (const sec of activeGroup.sections) {
      for (const item of sec.items) out.push(item);
    }
    return out;
  });

  const selectedItem = $derived.by(() => {
    if (selectedItemId) {
      const found = allItems.find((i) => i.id === selectedItemId);
      if (found) return found;
    }
    const matchActive = allItems.find(
      (i) =>
        i.shortName.toUpperCase() === activeSymbol.toUpperCase() ||
        i.symbol.toUpperCase() === activeFullSymbol.toUpperCase()
    );
    return matchActive ?? allItems[0] ?? null;
  });

  const filteredCatalog = $derived.by(() => {
    const q = addSymbolQuery.trim().toUpperCase();
    const existing = new Set(allItems.map((i) => i.shortName.toUpperCase()));
    const matches = SYMBOL_CATALOG.filter((entry) => {
      if (!q) return !existing.has(entry.shortName.toUpperCase());
      return (
        entry.shortName.toUpperCase().includes(q) ||
        entry.symbol.toUpperCase().includes(q) ||
        entry.description.toUpperCase().includes(q)
      );
    });
    return matches.slice(0, 8);
  });

  function resolveQuote(item: WatchlistItem): {
    price?: number;
    change?: number;
    changePercent?: number;
    perf?: MarketQuote['performance'];
    autoBias?: 'bull' | 'bear' | 'range';
    description: string;
  } {
    const q = quotes[item.symbol];
    const isCurrentChart =
      item.shortName.toUpperCase() === activeSymbol.toUpperCase() ||
      item.symbol.toUpperCase() === activeFullSymbol.toUpperCase();

    if (isCurrentChart && typeof activePrice === 'number' && Number.isFinite(activePrice)) {
      const chgPct =
        typeof activeChangePercent === 'number' && Number.isFinite(activeChangePercent)
          ? activeChangePercent
          : q?.changePercent;
      const chgAbs =
        typeof chgPct === 'number' && q?.price
          ? activePrice - q.price / (1 + (q.changePercent || 0) / 100)
          : q?.change;
      return {
        price: activePrice,
        change: chgAbs,
        changePercent: chgPct,
        perf: q?.performance,
        autoBias: q?.autoBias,
        description: q?.description || item.description
      };
    }

    return {
      price: q?.price,
      change: q?.change,
      changePercent: q?.changePercent,
      perf: q?.performance,
      autoBias: q?.autoBias,
      description: q?.description || item.description
    };
  }

  function effectiveBias(item: WatchlistItem, autoBias?: 'bull' | 'bear' | 'range'): {
    bias: BiasDirection;
    isAuto: boolean;
  } {
    if (item.bias !== 'none') {
      return { bias: item.bias, isAuto: false };
    }
    if (autoBias) {
      return { bias: autoBias, isAuto: true };
    }
    return { bias: 'none', isAuto: true };
  }

  function notesCountFor(shortName: string): number {
    return notesCountBySymbol[shortName.toUpperCase()] ?? 0;
  }

  function alertsCountFor(item: WatchlistItem): number {
    const s1 = item.symbol.toUpperCase();
    const s2 = item.shortName.toUpperCase();
    return alertsState.alerts.filter(
      (a) =>
        a.status === 'active' &&
        a.kind === 'price' &&
        (a.symbol.toUpperCase() === s1 || a.shortName.toUpperCase() === s2)
    ).length;
  }

  async function refreshQuotes() {
    const syms = allItems.map((i) => i.symbol);
    if (syms.length === 0) return;
    try {
      const next = await fetchMarketQuotes(syms);
      quotes = { ...quotes, ...next };
      for (const [sym, q] of Object.entries(next)) {
        if (q?.spreadPx && q.spreadPx > 0) {
          feedPaperLiveSpread(sym, q.spreadPx);
        }
      }
    } catch {
      // non-fatal
    }
  }

  async function refreshNotesCounts() {
    try {
      const notes = await loadNotes();
      const map: Record<string, number> = {};
      for (const n of notes) {
        if (n.deletedAt) continue;
        const key = (n.symbol || '').toUpperCase();
        if (!key) continue;
        map[key] = (map[key] ?? 0) + 1;
      }
      notesCountBySymbol = map;
    } catch {
      // ignore
    }
  }

  onMount(() => {
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const unsubAlerts = subscribeAlerts((s) => {
      alertsState = s;
    });

    void loadWatchlistState().then((loaded) => {
      wlState = loaded;
      void refreshQuotes();
    });
    void refreshNotesCounts();
    void fetchMacroRegime()
      .then((r) => {
        macroRegime = r;
      })
      .catch(() => {
        // non-fatal
      });

    pollTimer = setInterval(() => {
      void refreshQuotes();
    }, 15_000);

    const onDocDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (groupMenuOpen && !el.closest('[data-wl-group-menu]')) groupMenuOpen = false;
      if (moreMenuOpen && !el.closest('[data-wl-more-menu]')) moreMenuOpen = false;
      if (analysisMenuPos && !el.closest('[data-wl-analysis-menu]')) analysisMenuPos = null;
    };
    window.addEventListener('pointerdown', onDocDown);

    return () => {
      unsubAlerts();
      if (pollTimer) clearInterval(pollTimer);
      window.removeEventListener('pointerdown', onDocDown);
    };
  });

  function macroBiasLabel(bias: MacroBias): string {
    if (bias === 'tailwind') return 'Tailwind';
    if (bias === 'headwind') return 'Headwind';
    return 'Neutral';
  }

  function sourceHost(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return 'source';
    }
  }

  function shortDriverLabel(label: string): string {
    if (label.includes('Real 10Y')) return 'Real 10Y';
    if (label.includes('US 10Y')) return 'US 10Y';
    if (label.includes('US 2Y')) return 'US 2Y';
    if (label.includes('DXY')) return 'DXY';
    if (label.includes('VIX')) return 'VIX';
    if (label.includes('SPX')) return 'SPX';
    if (label.includes('WTI')) return 'WTI';
    return label.slice(0, 12);
  }

  const briefTargetKey = $derived.by(() => {
    if (!briefOpen || !selectedItem) return '';
    const autoBias = quotes[selectedItem.symbol]?.autoBias;
    const techBias = effectiveBias(selectedItem, autoBias).bias;
    return `${selectedItem.symbol}|${selectedItem.shortName}|${techBias}|${briefRefreshTick}`;
  });

  $effect(() => {
    const key = briefTargetKey;
    if (!key) {
      briefAbort?.abort();
      briefAbort = null;
      return;
    }
    const parts = key.split('|');
    const sym = parts[0];
    const shortName = parts[1];
    const techBias = (parts[2] || 'none') as BiasDirection;
    const tick = Number(parts[3]) || 0;
    const force = tick > lastHandledRefreshTick;
    lastHandledRefreshTick = tick;

    const targetShort = normalizeShortSymbol(shortName);
    const sameSymbolAsLoaded = lastBriefShort === targetShort;

    briefAbort?.abort();
    const controller = new AbortController();
    briefAbort = controller;

    if (!sameSymbolAsLoaded || force) {
      briefLoading = true;
    }
    briefError = null;

    fetchSymbolBrief(sym, techBias, { force, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        lastBriefShort = targetShort;
        symbolBrief = res;
        briefLoading = false;
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        briefError = err instanceof Error ? err.message : 'Unable to load macro brief';
        briefLoading = false;
      });

    return () => {
      controller.abort();
    };
  });

  function commit(next: WatchlistState) {
    wlState = next;
    void saveWatchlistState(next);
  }

  function toggleSection(sectionId: string) {
    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              sections: g.sections.map((s) =>
                s.id === sectionId ? { ...s, collapsed: !s.collapsed } : s
              )
            }
      )
    });
  }

  function handleRowClick(item: WatchlistItem) {
    selectedItemId = item.id;
    analysisMenuPos = null;
    if (insightsOpen && onSelectInsightsSymbol) {
      const q = resolveQuote(item);
      onSelectInsightsSymbol(item.symbol, item.shortName, q.description);
      return;
    }
    onSelectSymbol(item.symbol, item.shortName);
  }

  function setItemBias(itemId: string, bias: BiasDirection) {
    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              sections: g.sections.map((s) => ({
                ...s,
                items: s.items.map((it) => (it.id === itemId ? { ...it, bias } : it))
              }))
            }
      )
    });
  }

  function updateItemNote(itemId: string, poiNote: string) {
    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              sections: g.sections.map((s) => ({
                ...s,
                items: s.items.map((it) => (it.id === itemId ? { ...it, poiNote } : it))
              }))
            }
      )
    });
  }

  function removeItem(sectionId: string, itemId: string, e: MouseEvent) {
    e.stopPropagation();
    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              sections: g.sections.map((s) =>
                s.id !== sectionId ? s : { ...s, items: s.items.filter((i) => i.id !== itemId) }
              )
            }
      )
    });
  }

  function openAddSymbol(sectionId?: string) {
    addTargetSectionId = sectionId ?? activeGroup.sections[0]?.id ?? null;
    addSymbolQuery = '';
    addSymbolOpen = true;
    moreMenuOpen = false;
  }

  function addSymbolToSection(rawSymbol: string) {
    const cleaned = rawSymbol.trim();
    if (!cleaned) return;
    const item = createWatchlistItem(cleaned);
    const targetSecId = addTargetSectionId ?? activeGroup.sections[0]?.id;

    let nextSections = activeGroup.sections;
    if (!targetSecId) {
      nextSections = [
        {
          id: makeWorkspaceId('sec'),
          name: 'WATCHLIST',
          collapsed: false,
          items: [item]
        }
      ];
    } else {
      nextSections = activeGroup.sections.map((s) => {
        if (s.id !== targetSecId) return s;
        if (s.items.some((i) => i.shortName.toUpperCase() === item.shortName.toUpperCase())) {
          return s;
        }
        return { ...s, collapsed: false, items: [...s.items, item] };
      });
    }

    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id ? g : { ...g, sections: nextSections }
      )
    });
    selectedItemId = item.id;
    addSymbolQuery = '';
    addSymbolOpen = false;
    void refreshQuotes();
  }

  function createSection() {
    const name = newSectionName.trim().toUpperCase();
    if (!name) return;
    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              sections: [
                ...g.sections,
                { id: makeWorkspaceId('sec'), name, collapsed: false, items: [] }
              ]
            }
      )
    });
    newSectionName = '';
    addSectionOpen = false;
  }

  function removeSection(sectionId: string, e: MouseEvent) {
    e.stopPropagation();
    if (activeGroup.sections.length <= 1) return;
    commit({
      ...wlState,
      groups: wlState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : { ...g, sections: g.sections.filter((s) => s.id !== sectionId) }
      )
    });
  }

  function createListGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const newId = makeWorkspaceId('wl');
    commit({
      activeGroupId: newId,
      groups: [
        ...wlState.groups,
        {
          id: newId,
          name,
          sections: [
            {
              id: makeWorkspaceId('sec'),
              name: 'SYMBOLS',
              collapsed: false,
              items: []
            }
          ]
        }
      ]
    });
    newGroupName = '';
    newGroupOpen = false;
    groupMenuOpen = false;
  }

  function exchangeLabel(symbol: string): string {
    const idx = symbol.indexOf(':');
    return idx >= 0 ? symbol.slice(0, idx) : 'CFD';
  }
</script>

<PanelShell {theme} title="Watchlist" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" />
      <path d="M7.25 5.5h9.25M7.25 10h9.25M7.25 14.5h9.25" />
    </svg>
  {/snippet}

  <div bind:this={wlContainerEl} class="watchlist" class:light={theme === 'light'} class:resizing={resizingSheet}>
    <!-- Top toolbar -->
    <div class="wl-toolbar">
      <div class="group-switcher" data-wl-group-menu>
        <button
          class="group-btn"
          type="button"
          onclick={() => (groupMenuOpen = !groupMenuOpen)}
        >
          <span>{activeGroup.name}</span>
          <svg class="chev" class:open={groupMenuOpen} viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
          </svg>
        </button>

        {#if groupMenuOpen}
          <div class="wl-popover">
            {#each wlState.groups as grp (grp.id)}
              <button
                class="pop-item"
                class:active={grp.id === activeGroup.id}
                type="button"
                onclick={() => {
                  commit({ ...wlState, activeGroupId: grp.id });
                  groupMenuOpen = false;
                }}
              >
                <span>{grp.name}</span>
              </button>
            {/each}
            <div class="pop-div"></div>
            {#if newGroupOpen}
              <div class="inline-create">
                <input
                  type="text"
                  placeholder="List name..."
                  bind:value={newGroupName}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') createListGroup();
                  }}
                />
                <button type="button" onclick={createListGroup}>Add</button>
              </div>
            {:else}
              <button class="pop-item" type="button" onclick={() => (newGroupOpen = true)}>
                <span>+ Create new list</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <div class="wl-actions">
        <button
          class="tool-btn"
          type="button"
          title="Add symbol"
          aria-label="Add symbol"
          onclick={() => openAddSymbol()}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 3.5v11M3.5 9h11" />
          </svg>
        </button>

        <div class="more-wrap" data-wl-more-menu>
          <button
            class="tool-btn"
            type="button"
            title="Watchlist options"
            aria-label="Watchlist options"
            onclick={() => (moreMenuOpen = !moreMenuOpen)}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="4.5" cy="9" r="1.15" fill="currentColor" stroke="none" />
              <circle cx="9" cy="9" r="1.15" fill="currentColor" stroke="none" />
              <circle cx="13.5" cy="9" r="1.15" fill="currentColor" stroke="none" />
            </svg>
          </button>

          {#if moreMenuOpen}
            <div class="wl-popover right">
              {#if onCreateWatchlistAlert}
                <button
                  class="pop-item"
                  type="button"
                  onclick={() => {
                    onCreateWatchlistAlert(activeGroup.id);
                    moreMenuOpen = false;
                  }}
                >
                  <span>Create watchlist alert</span>
                </button>
                <div class="pop-div"></div>
              {/if}
              <button
                class="pop-item"
                type="button"
                onclick={() => {
                  addSectionOpen = true;
                  moreMenuOpen = false;
                }}
              >
                <span>Add section</span>
              </button>
              <button
                class="pop-item"
                type="button"
                onclick={() => {
                  void refreshQuotes();
                  moreMenuOpen = false;
                }}
              >
                <span>Refresh quotes</span>
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Inline Add Symbol Drawer -->
    {#if addSymbolOpen}
      <div class="add-box">
        <div class="add-row">
          <input
            type="text"
            placeholder="Search symbol (e.g. XAUUSD, GBPJPY, NVDA)..."
            bind:value={addSymbolQuery}
            onkeydown={(e) => {
              if (e.key === 'Enter' && addSymbolQuery.trim()) {
                addSymbolToSection(addSymbolQuery);
              } else if (e.key === 'Escape') {
                addSymbolOpen = false;
              }
            }}
          />
          <button class="add-close" type="button" onclick={() => (addSymbolOpen = false)}>×</button>
        </div>

        <div class="add-results">
          {#each filteredCatalog as entry (entry.symbol)}
            <button
              class="catalog-row"
              type="button"
              onclick={() => addSymbolToSection(entry.symbol)}
            >
              <span class="cat-sym">{entry.shortName}</span>
              <span class="cat-desc">{entry.description}</span>
              <span class="cat-ex">{exchangeLabel(entry.symbol)}</span>
            </button>
          {/each}
          {#if addSymbolQuery.trim().length > 0 && filteredCatalog.length === 0}
            <button
              class="catalog-row"
              type="button"
              onclick={() => addSymbolToSection(addSymbolQuery)}
            >
              <span class="cat-sym">{addSymbolQuery.trim().toUpperCase()}</span>
              <span class="cat-desc">Add custom ticker</span>
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Inline Add Section Bar -->
    {#if addSectionOpen}
      <div class="add-box">
        <div class="add-row">
          <input
            type="text"
            placeholder="New section name (e.g. METALS)..."
            bind:value={newSectionName}
            onkeydown={(e) => {
              if (e.key === 'Enter') createSection();
              if (e.key === 'Escape') addSectionOpen = false;
            }}
          />
          <button class="mini-save" type="button" onclick={createSection}>Add</button>
          <button class="add-close" type="button" onclick={() => (addSectionOpen = false)}>×</button>
        </div>
      </div>
    {/if}

    <!-- Column headers -->
    <div class="col-head">
      <span class="col-sym">Symbol</span>
      <span class="col-num">Last</span>
      <span class="col-num">Chg</span>
      <span class="col-num">Chg%</span>
    </div>

    <!-- Scrollable Watchlist table -->
    <div class="wl-list">
      {#each activeGroup.sections as sec (sec.id)}
        <div class="sec-head" role="button" tabindex="0" onclick={() => toggleSection(sec.id)} onkeydown={(e) => { if (e.key === 'Enter') toggleSection(sec.id); }}>
          <svg class="sec-chev" class:collapsed={sec.collapsed} viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
          </svg>
          <span class="sec-name">{sec.name}</span>
          <div class="sec-tools">
            <button
              class="sec-mini-btn"
              type="button"
              title="Add symbol to {sec.name}"
              onclick={(e) => {
                e.stopPropagation();
                openAddSymbol(sec.id);
              }}
            >
              +
            </button>
            {#if activeGroup.sections.length > 1}
              <button
                class="sec-mini-btn"
                type="button"
                title="Remove section"
                onclick={(e) => removeSection(sec.id, e)}
              >
                ×
              </button>
            {/if}
          </div>
        </div>

        {#if !sec.collapsed}
          {#each sec.items as item (item.id)}
            {@const q = resolveQuote(item)}
            {@const eff = effectiveBias(item, q.autoBias)}
            {@const rowMacro = resolveMacroForSymbol(macroRegime, item.shortName)}
            {@const rowAlign = computeAlignment(rowMacro?.bias, eff.bias)}
            {@const isSelected = selectedItem?.id === item.id}
            {@const isUp = (q.changePercent ?? 0) > 0}
            {@const isDown = (q.changePercent ?? 0) < 0}
            <div
              class="sym-row"
              class:selected={isSelected}
              role="button"
              tabindex="0"
              onclick={() => handleRowClick(item)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleRowClick(item);
                }
              }}
            >
              <div class="sym-cell">
                <SymbolIcon symbol={item.shortName} size={20} />

                <span class="sym-name">{item.shortName}</span>

                {#if eff.bias !== 'none'}
                  <span
                    class="bias-dot"
                    class:bull={eff.bias === 'bull'}
                    class:bear={eff.bias === 'bear'}
                    class:range={eff.bias === 'range'}
                    title="{eff.isAuto ? 'Auto HTF Bias' : 'Manual HTF Bias'}: {eff.bias}"
                  ></span>
                {/if}

                {#if rowAlign === 'aligned' || rowAlign === 'conflict'}
                  <span
                    class="macro-pip"
                    class:aligned={rowAlign === 'aligned'}
                    class:conflict={rowAlign === 'conflict'}
                    title={rowAlign === 'aligned'
                      ? `TA + Macro Aligned · ${rowMacro?.reason ?? ''}`
                      : `TA vs Macro Conflict · ${rowMacro?.reason ?? ''}`}
                  >
                    M
                  </span>
                {/if}
              </div>

              <span class="num-cell last">{formatQuotePrice(q.price, item.shortName)}</span>
              <span class="num-cell" class:up={isUp} class:down={isDown}>
                {formatQuoteChange(q.change, item.shortName)}
              </span>
              <span class="num-cell" class:up={isUp} class:down={isDown}>
                {formatQuotePct(q.changePercent)}
              </span>

              <div class="row-hover-actions">
                <button
                  class="row-act-btn"
                  type="button"
                  title="Open {item.shortName} in new tab"
                  onclick={(e) => {
                    e.stopPropagation();
                    onOpenSymbolInNewTab(item.symbol, item.shortName);
                  }}
                >
                  ↗
                </button>
                <button
                  class="row-act-btn del"
                  type="button"
                  title="Remove from watchlist"
                  onclick={(e) => removeItem(sec.id, item.id, e)}
                >
                  ×
                </button>
              </div>
            </div>
          {/each}
        {/if}
      {/each}
    </div>

    <!-- Bottom detail sheet (TradingView-inspired + Auto/Manual HTF Bias, Notes/Alerts & Performance) -->
    {#if selectedItem}
      {@const sq = resolveQuote(selectedItem)}
      {@const seff = effectiveBias(selectedItem, sq.autoBias)}
      {@const isUp = (sq.changePercent ?? 0) > 0}
      {@const isDown = (sq.changePercent ?? 0) < 0}
      {@const noteCnt = notesCountFor(selectedItem.shortName)}
      {@const alertCnt = alertsCountFor(selectedItem)}
      {@const selMacro = resolveMacroForSymbol(macroRegime, selectedItem.shortName)}
      {@const activeBrief =
        symbolBrief &&
        normalizeShortSymbol(symbolBrief.shortName) === normalizeShortSymbol(selectedItem.shortName)
          ? symbolBrief
          : null}
      {@const selFundBias = activeBrief?.fundamentalBias ?? selMacro?.bias ?? 'neutral'}
      {@const selAlign = computeAlignment(selFundBias, seff.bias)}
      <!-- TradingView-style vertical drag splitter to reposition bottom detail sheet -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="sheet-resizer"
        class:dragging={resizingSheet}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize detail sheet"
        title="Drag to resize detail sheet (double-click to reset)"
        onpointerdown={onSheetResizeDown}
        ondblclick={resetSheetHeight}
      >
        <span class="sheet-grip" aria-hidden="true"></span>
      </div>
      {#if resizingSheet}
        <div class="sheet-drag-shield" aria-hidden="true"></div>
      {/if}
      <div class="detail-sheet" style:height="{sheetHeight}px">
        <div class="detail-header">
          <div class="detail-title-wrap">
            <SymbolIcon symbol={selectedItem.shortName} size={26} />
            <div class="detail-titles">
              <div class="detail-sym">{selectedItem.shortName}</div>
              <div class="detail-sub">
                {sq.description} · {exchangeLabel(selectedItem.symbol)}
              </div>
            </div>
          </div>

          <div class="detail-actions">
            <button
              class="detail-icon-btn"
              class:active-grid={Boolean(analysisMenuPos) || insightsOpen}
              type="button"
              data-wl-analysis-menu="true"
              aria-label="Symbol analysis and insights"
              aria-haspopup="menu"
              aria-expanded={Boolean(analysisMenuPos)}
              title="Analysis & Insights (Technicals, Seasonals, News, Volatility)"
              onclick={toggleAnalysisMenu}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <rect x="2.75" y="2.75" width="5" height="5" rx="1.25" />
                <rect x="10.25" y="2.75" width="5" height="5" rx="1.25" />
                <rect x="2.75" y="10.25" width="5" height="5" rx="1.25" />
                <rect x="10.25" y="10.25" width="5" height="5" rx="1.25" />
              </svg>
            </button>
            <button
              class="detail-icon-btn"
              type="button"
              title="Open in new tab"
              onclick={() => onOpenSymbolInNewTab(selectedItem.symbol, selectedItem.shortName)}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M10.5 3.5h4v4M14.5 3.5l-6 6M7.5 4.5H5A1.5 1.5 0 0 0 3.5 6v7A1.5 1.5 0 0 0 5 14.5h7a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
              </svg>
            </button>
            <button
              class="detail-icon-btn"
              type="button"
              title="Create alert on {selectedItem.shortName}"
              onclick={() =>
                onCreateAlertForSymbol(selectedItem.symbol, selectedItem.shortName, sq.price)
              }
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <circle cx="9" cy="9.75" r="5.25" />
                <path d="M9 7v2.75l1.75 1.25M4.25 3.25 2.5 5M13.75 3.25 15.5 5" />
              </svg>
            </button>
          </div>
        </div>

        <div class="price-hero">
          <span class="hero-last">{formatQuotePrice(sq.price, selectedItem.shortName)}</span>
          <span class="hero-chg" class:up={isUp} class:down={isDown}>
            {formatQuoteChange(sq.change, selectedItem.shortName)}
            {formatQuotePct(sq.changePercent)}
          </span>
        </div>

        <!-- Auto-detected HTF Bias (with 1-click manual override) + POI note + Notes/Alerts badges -->
        <div class="bias-block">
          <div class="bias-row">
            <span class="sheet-label">
              HTF Bias
              {#if seff.isAuto && seff.bias !== 'none'}
                <span class="auto-tag">Auto</span>
              {/if}
            </span>
            <div class="bias-pills">
              <button
                class="bias-pill bull"
                class:active={seff.bias === 'bull'}
                type="button"
                title={seff.isAuto && seff.bias === 'bull' ? 'Auto-detected Bullish (click to lock manually)' : 'Set Bullish bias (click again for Auto)'}
                onclick={() =>
                  setItemBias(selectedItem.id, selectedItem.bias === 'bull' ? 'none' : 'bull')
                }
              >
                Bull
              </button>
              <button
                class="bias-pill range"
                class:active={seff.bias === 'range'}
                type="button"
                title={seff.isAuto && seff.bias === 'range' ? 'Auto-detected Range (click to lock manually)' : 'Set Range bias (click again for Auto)'}
                onclick={() =>
                  setItemBias(selectedItem.id, selectedItem.bias === 'range' ? 'none' : 'range')
                }
              >
                Range
              </button>
              <button
                class="bias-pill bear"
                class:active={seff.bias === 'bear'}
                type="button"
                title={seff.isAuto && seff.bias === 'bear' ? 'Auto-detected Bearish (click to lock manually)' : 'Set Bearish bias (click again for Auto)'}
                onclick={() =>
                  setItemBias(selectedItem.id, selectedItem.bias === 'bear' ? 'none' : 'bear')
                }
              >
                Bear
              </button>
            </div>
          </div>

          <input
            class="poi-input"
            type="text"
            placeholder="Key POI / plan note (e.g. 1H Demand 3500–3530)..."
            value={selectedItem.poiNote}
            oninput={(e) =>
              updateItemNote(selectedItem.id, (e.currentTarget as HTMLInputElement).value)
            }
          />

          <div class="workspace-badges">
            <button class="ws-badge" type="button" onclick={onOpenNotesForSymbol}>
              <span>Notes</span>
              <strong>{noteCnt}</strong>
            </button>
            <button
              class="ws-badge"
              type="button"
              onclick={() =>
                onCreateAlertForSymbol(selectedItem.symbol, selectedItem.shortName, sq.price)
              }
            >
              <span>Active alerts</span>
              <strong>{alertCnt}</strong>
            </button>
          </div>
        </div>

        <!-- Quiet Macro & Fundamental Brief (non-TA yields, cross-asset & catalyst layer) -->
        <div class="macro-card" class:open={briefOpen}>
          <div class="macro-head-row">
            <button
              class="macro-toggle"
              type="button"
              aria-expanded={briefOpen}
              onclick={() => (briefOpen = !briefOpen)}
            >
              <span class="macro-title">Macro Brief</span>
              <span
                class="macro-pill"
                class:tailwind={selFundBias === 'tailwind'}
                class:headwind={selFundBias === 'headwind'}
              >
                {macroBiasLabel(selFundBias)}
              </span>
              {#if selAlign === 'aligned'}
                <span class="align-pill aligned" title="Technical HTF bias aligns with macro backdrop">
                  Aligned
                </span>
              {:else if selAlign === 'conflict'}
                <span class="align-pill conflict" title="Technical HTF bias conflicts with macro backdrop">
                  Conflict
                </span>
              {/if}
              <svg class="macro-chev" class:open={briefOpen} viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>

            {#if briefOpen}
              <button
                class="macro-refresh"
                type="button"
                title="Refresh macro brief"
                aria-label="Refresh macro brief"
                disabled={briefLoading}
                onclick={() => (briefRefreshTick += 1)}
              >
                <svg class:spin={briefLoading} viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13 8a5 5 0 1 1-1.3-3.36" />
                  <path d="M13 3.25v2.75h-2.75" />
                </svg>
              </button>
            {/if}
          </div>

          {#if briefOpen}
            <div class="macro-body">
              {#if briefLoading && !activeBrief}
                <div class="macro-status">Reading yields, cross-asset flows & catalysts...</div>
              {:else if briefError && !activeBrief}
                <div class="macro-status">
                  <span>Macro brief unavailable.</span>
                  <button
                    class="macro-retry"
                    type="button"
                    onclick={() => (briefRefreshTick += 1)}
                  >
                    Retry
                  </button>
                </div>
              {:else if activeBrief}
                <div class="macro-headline">{activeBrief.headlineSummary}</div>

                {#if activeBrief.drivers.length > 0}
                  <div class="driver-grid">
                    {#each activeBrief.drivers as d, dIdx (`${d.label}|${dIdx}`)}
                      <div
                        class="driver-tile"
                        class:bull={d.impact === 'bull'}
                        class:bear={d.impact === 'bear'}
                        title="{d.label}: {d.note}"
                      >
                        <span class="drv-lbl">{shortDriverLabel(d.label)}</span>
                        <span class="drv-val">{d.value}</span>
                        <span class="drv-delta">{d.delta}</span>
                      </div>
                    {/each}
                  </div>
                {/if}

                <div class="catalyst-list">
                  <div class="cat-line">
                    <span class="cat-k">Driver</span>
                    <span class="cat-v">{activeBrief.primaryDriver}</span>
                  </div>
                  <div class="cat-line">
                    <span class="cat-k">Risk</span>
                    <span class="cat-v">{activeBrief.keyRisk}</span>
                  </div>
                  <div class="cat-line">
                    <span class="cat-k">Invalidation</span>
                    <span class="cat-v">{activeBrief.invalidationCatalyst}</span>
                  </div>
                </div>

                {#if activeBrief.sources.length > 0}
                  <div class="macro-sources">
                    {#each activeBrief.sources as src, sIdx (`${src.url}|${sIdx}`)}
                      <span class="src-chip" title={src.title}>{sourceHost(src.url)}</span>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>

        <!-- Performance 6-tile grid (like TradingView bottom sheet) -->
        {#if sq.perf}
          <div class="perf-section">
            <div class="sheet-label">Performance</div>
            <div class="perf-grid">
              {#each [
                { label: '1W', val: sq.perf.w1 },
                { label: '1M', val: sq.perf.m1 },
                { label: '3M', val: sq.perf.m3 },
                { label: '6M', val: sq.perf.m6 },
                { label: 'YTD', val: sq.perf.ytd },
                { label: '1Y', val: sq.perf.y1 }
              ] as tile (tile.label)}
                {@const pos = typeof tile.val === 'number' && tile.val > 0}
                {@const neg = typeof tile.val === 'number' && tile.val < 0}
                <div class="perf-tile" class:pos class:neg>
                  <span class="perf-val">{formatQuotePct(tile.val)}</span>
                  <span class="perf-lbl">{tile.label}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</PanelShell>

{#if analysisMenuPos && selectedItem}
  <div
    class="analysis-popover"
    class:light={theme === 'light'}
    data-wl-analysis-menu="true"
    role="menu"
    aria-label="Symbol Analysis"
    style:top="{analysisMenuPos.top}px"
    style:left="{analysisMenuPos.left}px"
  >
    <div class="analysis-heading">ANALYSIS</div>
    <button
      class="analysis-item"
      type="button"
      role="menuitem"
      onclick={() => launchInsightsView('technicals')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3.25 14a6.75 6.75 0 1 1 13.5 0" />
        <path d="M10 14l3-4.5" />
        <circle cx="10" cy="14" r="1.15" />
      </svg>
      <span>Technicals</span>
    </button>

    <button
      class="analysis-item"
      type="button"
      role="menuitem"
      onclick={() => launchInsightsView('seasonals')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M9.5 6.5a3.25 3.25 0 0 0-3.25 3.25c0 1.25.7 2.35 1.75 2.9" />
        <path d="M9.5 3.25v1.35M4.8 5.05l.95.95M3.25 9.75h1.35" />
        <path d="M12.5 16.5v-3.25m0 0-3.1-.85 1.15-2.05-1.45-1.1 2.25-.45 1.15-2.1 1.15 2.1 2.25.45-1.45 1.1 1.15 2.05-3.1.85Z" />
      </svg>
      <span>Seasonals</span>
    </button>

    <button
      class="analysis-item"
      type="button"
      role="menuitem"
      onclick={() => launchInsightsView('news')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3.25" y="3.75" width="13.5" height="12.5" rx="2" />
        <rect x="5.75" y="6.25" width="3.75" height="3.5" rx="0.5" />
        <path d="M11.5 7h2.75M11.5 9.5h2.75M5.75 12.5h8.5" />
      </svg>
      <span>News</span>
    </button>

    <button
      class="analysis-item"
      type="button"
      role="menuitem"
      onclick={() => launchInsightsView('volatility')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.75 11.25h3l2-5.5 3.25 8.5 2-4.5h4.25" />
      </svg>
      <span>Volatility &amp; Levels</span>
    </button>
  </div>
{/if}

<style>
  .watchlist {
    --wl-bg: var(--dark-bg-panel);
    --wl-surface: var(--dark-bg-surface);
    --wl-border: var(--dark-border);
    --wl-border-soft: var(--dark-border-subtle);
    --wl-text: var(--dark-text-primary);
    --wl-secondary: var(--dark-text-secondary);
    --wl-hover: var(--dark-hover);
    --wl-active-ring: var(--dark-text-primary);
    --wl-popover-bg: var(--dark-bg-glass-strong);
    --wl-popover-shadow: var(--dark-shadow-popover);
    --wl-pos-bg: rgba(8, 153, 129, 0.14);
    --wl-neg-bg: rgba(242, 54, 69, 0.14);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--wl-text);
    background: var(--wl-bg);
  }

  .watchlist.light {
    --wl-bg: #ffffff;
    --wl-surface: #f8f9fb;
    --wl-border: #e0e3eb;
    --wl-border-soft: #f0f2f5;
    --wl-text: #131722;
    --wl-secondary: #6a6d78;
    --wl-hover: rgba(0, 0, 0, 0.03);
    --wl-active-ring: #131722;
    --wl-popover-bg: #ffffff;
    --wl-popover-shadow: 0 10px 26px rgba(19, 23, 34, 0.14);
    --wl-pos-bg: rgba(8, 153, 129, 0.11);
    --wl-neg-bg: rgba(242, 54, 69, 0.11);
  }

  .wl-toolbar {
    height: 36px;
    flex: 0 0 36px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }

  .group-switcher,
  .more-wrap {
    position: relative;
  }

  .group-btn {
    height: 28px;
    padding: 0 6px 0 2px;
    border: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--wl-text);
    background: transparent;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }

  .group-btn:hover,
  .tool-btn:hover {
    background: var(--wl-hover);
  }

  .chev {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    transition: transform 140ms ease;
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .wl-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .tool-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--wl-text);
    background: transparent;
    cursor: pointer;
  }

  .tool-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .wl-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 180px;
    padding: 5px;
    border-radius: 10px;
    border: 1px solid var(--wl-border);
    background: var(--wl-popover-bg);
    box-shadow: var(--wl-popover-shadow);
    backdrop-filter: blur(18px);
    z-index: 25;
  }

  .wl-popover.right {
    left: auto;
    right: 0;
  }

  .pop-item {
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    text-align: left;
    color: var(--wl-text);
    background: transparent;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .pop-item:hover,
  .pop-item.active {
    background: var(--wl-hover);
    font-weight: 600;
  }

  .pop-div {
    height: 1px;
    margin: 4px;
    background: var(--wl-border-soft);
  }

  .inline-create {
    display: flex;
    gap: 4px;
    padding: 3px;
  }

  .inline-create input {
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid var(--wl-border);
    background: transparent;
    color: var(--wl-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .inline-create button,
  .mini-save {
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: var(--wl-active-ring);
    color: var(--wl-bg);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .add-box {
    margin: 4px 12px 6px;
    padding: 8px;
    border-radius: 10px;
    border: 1px solid var(--wl-border);
    background: var(--wl-surface);
  }

  .add-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .add-row input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid var(--wl-border);
    background: var(--wl-bg);
    color: var(--wl-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .add-close {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--wl-secondary);
    font-size: 16px;
    cursor: pointer;
  }

  .add-results {
    margin-top: 6px;
    max-height: 170px;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .add-results::-webkit-scrollbar {
    display: none;
  }

  .catalog-row {
    width: 100%;
    padding: 6px 7px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--wl-text);
    display: flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }

  .catalog-row:hover {
    background: var(--wl-hover);
  }

  .cat-sym {
    font-weight: 600;
    min-width: 60px;
  }

  .cat-desc {
    flex: 1;
    min-width: 0;
    color: var(--wl-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cat-ex {
    font-size: 10.5px;
    color: var(--wl-secondary);
  }

  .col-head {
    display: grid;
    grid-template-columns: minmax(108px, 1.35fr) 1fr 0.85fr 0.78fr;
    padding: 6px 14px;
    font-size: 11px;
    color: var(--wl-secondary);
    border-bottom: 1px solid var(--wl-border-soft);
    user-select: none;
  }

  .col-num {
    text-align: right;
  }

  .wl-list {
    flex: 1 1 52%;
    min-height: 140px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 6px 8px;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .wl-list::-webkit-scrollbar {
    display: none;
  }

  .sec-head {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 7px 8px 4px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--wl-secondary);
    cursor: pointer;
    user-select: none;
  }

  .sec-chev {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    transition: transform 130ms ease;
  }

  .sec-chev.collapsed {
    transform: rotate(-90deg);
  }

  .sec-name {
    flex: 1;
  }

  .sec-tools {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .sec-head:hover .sec-tools {
    opacity: 1;
  }

  .sec-mini-btn {
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--wl-secondary);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .sec-mini-btn:hover {
    color: var(--wl-text);
    background: var(--wl-hover);
  }

  .sym-row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(108px, 1.35fr) 1fr 0.85fr 0.78fr;
    align-items: center;
    height: 34px;
    padding: 0 8px;
    border-radius: 8px;
    border: 1.5px solid transparent;
    cursor: pointer;
    user-select: none;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .sym-row:hover {
    background: var(--wl-hover);
  }

  .sym-row.selected {
    border-color: var(--wl-active-ring);
  }

  .sym-cell {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .sym-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--wl-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bias-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    border-radius: 50%;
  }

  .bias-dot.bull {
    background: #089981;
  }

  .bias-dot.bear {
    background: #f23645;
  }

  .bias-dot.range {
    background: #f59e0b;
  }

  .num-cell {
    text-align: right;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--wl-text);
    white-space: nowrap;
  }

  .num-cell.last {
    font-weight: 500;
  }

  .up {
    color: #089981 !important;
  }

  .down {
    color: #f23645 !important;
  }

  .row-hover-actions {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 2px;
    padding: 2px 3px;
    border-radius: 6px;
    background: var(--wl-bg);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .sym-row:hover .row-hover-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .row-act-btn {
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--wl-secondary);
    font-size: 12px;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .row-act-btn:hover {
    color: var(--wl-text);
    background: var(--wl-hover);
  }

  .row-act-btn.del:hover {
    color: #f23645;
  }

  .watchlist.resizing {
    user-select: none;
    cursor: ns-resize;
  }

  .sheet-drag-shield {
    position: fixed;
    inset: 0;
    z-index: 9999;
    cursor: ns-resize;
    background: transparent;
  }

  /* TradingView-style horizontal resize handle above bottom detail sheet */
  .sheet-resizer {
    flex: 0 0 8px;
    height: 8px;
    position: relative;
    cursor: ns-resize;
    display: grid;
    place-items: center;
    background: transparent;
    border-top: 1px solid var(--wl-border-soft);
    touch-action: none;
    user-select: none;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .sheet-resizer:hover,
  .sheet-resizer.dragging {
    background: var(--wl-hover);
    border-top-color: var(--wl-border);
  }

  .sheet-grip {
    width: 30px;
    height: 3px;
    border-radius: 99px;
    background: var(--wl-border);
    opacity: 0.65;
    transition: opacity 120ms ease, width 120ms ease;
  }

  .sheet-resizer:hover .sheet-grip,
  .sheet-resizer.dragging .sheet-grip {
    opacity: 1;
    width: 40px;
  }

  /* Bottom detail sheet */
  .detail-sheet {
    flex: 0 0 auto;
    min-height: 110px;
    max-height: 82%;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
    padding: 8px 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-sizing: border-box;
  }

  .detail-sheet > * {
    flex: 0 0 auto;
  }

  .detail-sheet::-webkit-scrollbar {
    display: none;
  }

  .detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .detail-title-wrap {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .detail-titles {
    min-width: 0;
  }

  .detail-sym {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.2;
  }

  .detail-sub {
    font-size: 11.5px;
    color: var(--wl-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail-actions {
    display: flex;
    gap: 4px;
    flex: 0 0 auto;
  }

  .detail-icon-btn {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--wl-secondary);
    background: transparent;
    cursor: pointer;
  }

  .detail-icon-btn:hover,
  .detail-icon-btn.active-grid {
    color: var(--wl-text);
    background: var(--wl-hover);
  }

  .analysis-popover {
    position: fixed;
    z-index: 95;
    width: 196px;
    padding: 6px;
    border-radius: 10px;
    background: var(--dark-bg-elevated);
    color: var(--dark-text-strong);
    border: 1px solid var(--dark-border-strong);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 2px;
    user-select: none;
  }

  .analysis-popover.light {
    background: #ffffff;
    color: #131722;
    border-color: #e0e3eb;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.14);
  }

  .analysis-heading {
    padding: 5px 10px 4px;
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.05em;
    color: var(--dark-text-muted);
  }

  .analysis-popover.light .analysis-heading {
    color: #868993;
  }

  .analysis-item {
    width: 100%;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    text-align: left;
    transition: background-color 120ms ease;
  }

  .analysis-item:hover {
    background: var(--dark-bg-hover);
  }

  .analysis-popover.light .analysis-item:hover {
    background: #f0f3fa;
  }

  .analysis-item svg {
    width: 17px;
    height: 17px;
    flex: 0 0 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.85;
  }

  .detail-icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .price-hero {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
  }

  .hero-last {
    font-size: 23px;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .hero-chg {
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--wl-secondary);
  }

  .bias-block {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .bias-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .sheet-label {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--wl-secondary);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .auto-tag {
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    background: var(--wl-surface);
    border: 1px solid var(--wl-border-soft);
    color: var(--wl-secondary);
  }

  .bias-pills {
    display: inline-flex;
    gap: 4px;
  }

  .bias-pill {
    height: 23px;
    padding: 0 9px;
    border: 1px solid var(--wl-border);
    border-radius: 6px;
    background: transparent;
    color: var(--wl-secondary);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 130ms ease;
  }

  .bias-pill.bull.active {
    border-color: rgba(8, 153, 129, 0.45);
    background: var(--wl-pos-bg);
    color: #089981;
  }

  .bias-pill.bear.active {
    border-color: rgba(242, 54, 69, 0.45);
    background: var(--wl-neg-bg);
    color: #f23645;
  }

  .bias-pill.range.active {
    border-color: rgba(245, 158, 11, 0.45);
    background: rgba(245, 158, 11, 0.14);
    color: #f59e0b;
  }

  .poi-input {
    width: 100%;
    box-sizing: border-box;
    height: 30px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--wl-border);
    background: var(--wl-surface);
    color: var(--wl-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .poi-input::placeholder {
    color: var(--wl-secondary);
  }

  .workspace-badges {
    display: flex;
    gap: 6px;
  }

  .ws-badge {
    flex: 1;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--wl-border-soft);
    border-radius: 7px;
    background: var(--wl-surface);
    color: var(--wl-secondary);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: border-color 120ms ease, color 120ms ease;
  }

  .ws-badge:hover {
    border-color: var(--wl-border);
    color: var(--wl-text);
  }

  .ws-badge strong {
    color: var(--wl-text);
    font-variant-numeric: tabular-nums;
  }

  .perf-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .perf-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .perf-tile {
    padding: 7px 6px;
    border-radius: 8px;
    background: var(--wl-surface);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .perf-tile.pos {
    background: var(--wl-pos-bg);
  }

  .perf-tile.neg {
    background: var(--wl-neg-bg);
  }

  .perf-val {
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--wl-text);
  }

  .perf-tile.pos .perf-val {
    color: #089981;
  }

  .perf-tile.neg .perf-val {
    color: #f23645;
  }

  .perf-lbl {
    font-size: 10.5px;
    color: var(--wl-secondary);
  }

  /* Row-level quiet Macro-TA alignment pip */
  .macro-pip {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    border-radius: 4px;
    display: grid;
    place-items: center;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
  }

  .macro-pip.aligned {
    background: var(--wl-pos-bg);
    color: #089981;
  }

  .macro-pip.conflict {
    background: rgba(245, 158, 11, 0.16);
    color: #f59e0b;
  }

  /* Bottom detail sheet Macro & Fundamental Brief card */
  .macro-card {
    flex: 0 0 auto;
    border-radius: 9px;
    border: 1px solid var(--wl-border);
    background: var(--wl-surface);
    overflow: hidden;
  }

  .macro-card.open {
    border-color: var(--wl-border);
  }

  .macro-head-row {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .macro-toggle {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 9px;
    border: 0;
    background: transparent;
    color: var(--wl-text);
    display: flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }

  .macro-toggle:hover {
    background: var(--wl-hover);
  }

  .macro-title {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--wl-text);
    white-space: nowrap;
  }

  .macro-pill,
  .align-pill {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.45;
    white-space: nowrap;
  }

  .macro-pill {
    background: var(--wl-hover);
    color: var(--wl-secondary);
  }

  .macro-pill.tailwind {
    background: var(--wl-pos-bg);
    color: #089981;
  }

  .macro-pill.headwind {
    background: var(--wl-neg-bg);
    color: #f23645;
  }

  .align-pill.aligned {
    background: var(--wl-pos-bg);
    color: #089981;
  }

  .align-pill.conflict {
    background: rgba(245, 158, 11, 0.16);
    color: #f59e0b;
  }

  .macro-chev {
    margin-left: auto;
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    fill: none;
    stroke: var(--wl-secondary);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .macro-chev.open {
    transform: rotate(180deg);
  }

  .macro-refresh {
    width: 26px;
    height: 26px;
    margin-right: 4px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--wl-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .macro-refresh:hover:not(:disabled) {
    color: var(--wl-text);
    background: var(--wl-hover);
  }

  .macro-refresh:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .macro-refresh svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .macro-refresh svg.spin {
    animation: wl-spin 0.9s linear infinite;
  }

  @keyframes wl-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .macro-body {
    padding: 0 9px 9px;
    border-top: 1px solid var(--wl-border-soft);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .macro-status {
    padding-top: 8px;
    font-size: 11.5px;
    color: var(--wl-secondary);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .macro-retry {
    border: 1px solid var(--wl-border);
    border-radius: 5px;
    background: transparent;
    color: var(--wl-text);
    padding: 2px 7px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .macro-headline {
    padding-top: 8px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--wl-text);
    font-weight: 500;
  }

  .driver-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 5px;
  }

  .driver-tile {
    padding: 6px 5px;
    border-radius: 7px;
    border: 1px solid var(--wl-border-soft);
    background: var(--wl-bg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 0;
  }

  .driver-tile.bull {
    border-color: rgba(8, 153, 129, 0.28);
  }

  .driver-tile.bear {
    border-color: rgba(242, 54, 69, 0.28);
  }

  .drv-lbl {
    font-size: 9.5px;
    color: var(--wl-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .drv-val {
    font-size: 11.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--wl-text);
  }

  .drv-delta {
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--wl-secondary);
  }

  .driver-tile.bull .drv-delta {
    color: #089981;
  }

  .driver-tile.bear .drv-delta {
    color: #f23645;
  }

  .catalyst-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .cat-line {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 11px;
    line-height: 1.38;
  }

  .cat-k {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--wl-secondary);
  }

  .cat-v {
    color: var(--wl-text);
  }

  .macro-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-top: 2px;
  }

  .src-chip {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 9.5px;
    color: var(--wl-secondary);
    background: var(--wl-bg);
    border: 1px solid var(--wl-border-soft);
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
