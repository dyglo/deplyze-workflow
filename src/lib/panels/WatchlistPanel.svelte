<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import { loadNotes } from '../notes/api';
  import { subscribeAlerts, type AlertsState } from '../alerts/store';
  import { makeWorkspaceId } from '../workspace/storage';
  import {
    SYMBOL_CATALOG,
    createDefaultWatchlistState,
    createWatchlistItem,
    fetchMarketQuotes,
    formatQuoteChange,
    formatQuotePct,
    formatQuotePrice,
    getSymbolBadgeKind,
    loadWatchlistState,
    saveWatchlistState,
    symbolBadgeBg,
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
    onClose
  }: Props = $props();

  let wlState = $state<WatchlistState>(createDefaultWatchlistState());
  let quotes = $state<Record<string, MarketQuote>>({});
  let notesCountBySymbol = $state<Record<string, number>>({});
  let alertsState = $state<AlertsState>({ alerts: [], log: [] });

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
        description: q?.description || item.description
      };
    }

    return {
      price: q?.price,
      change: q?.change,
      changePercent: q?.changePercent,
      perf: q?.performance,
      description: q?.description || item.description
    };
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

    pollTimer = setInterval(() => {
      void refreshQuotes();
    }, 15_000);

    const onDocDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (groupMenuOpen && !el.closest('[data-wl-group-menu]')) groupMenuOpen = false;
      if (moreMenuOpen && !el.closest('[data-wl-more-menu]')) moreMenuOpen = false;
    };
    window.addEventListener('pointerdown', onDocDown);

    return () => {
      unsubAlerts();
      if (pollTimer) clearInterval(pollTimer);
      window.removeEventListener('pointerdown', onDocDown);
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

  <div class="watchlist" class:light={theme === 'light'}>
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
            {@const isSelected = selectedItem?.id === item.id}
            {@const isUp = (q.changePercent ?? 0) > 0}
            {@const isDown = (q.changePercent ?? 0) < 0}
            {@const badgeKind = getSymbolBadgeKind(item.shortName)}
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
                <span class="emblem" style:background={symbolBadgeBg(item.shortName)}>
                  {#if badgeKind === 'gold'}
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M5.5 6.5h5l.8 2H4.7l.8-2ZM3 9.5h4.2l.6 2H2.4l.6-2Zm5.8 0H13l.6 2H8.2l.6-2Z" fill="#fff" />
                    </svg>
                  {:else if badgeKind === 'oil'}
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2.6C8 2.6 4.2 7 4.2 9.6a3.8 3.8 0 0 0 7.6 0C11.8 7 8 2.6 8 2.6Z" fill="#fff" />
                    </svg>
                  {:else if badgeKind === 'dxy'}
                    <span>$</span>
                  {:else if badgeKind === 'btc'}
                    <span>₿</span>
                  {:else if badgeKind === 'eth'}
                    <span>Ξ</span>
                  {:else if badgeKind === 'nas'}
                    <span class="emblem-tiny">100</span>
                  {:else}
                    <span>{item.shortName.slice(0, 2)}</span>
                  {/if}
                </span>

                <span class="sym-name">{item.shortName}</span>

                {#if item.bias !== 'none'}
                  <span
                    class="bias-dot"
                    class:bull={item.bias === 'bull'}
                    class:bear={item.bias === 'bear'}
                    class:range={item.bias === 'range'}
                    title="HTF Bias: {item.bias}"
                  ></span>
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

    <!-- Bottom detail sheet (TradingView-inspired + our HTF Bias, Notes/Alerts counts & Performance) -->
    {#if selectedItem}
      {@const sq = resolveQuote(selectedItem)}
      {@const isUp = (sq.changePercent ?? 0) > 0}
      {@const isDown = (sq.changePercent ?? 0) < 0}
      {@const noteCnt = notesCountFor(selectedItem.shortName)}
      {@const alertCnt = alertsCountFor(selectedItem)}
      <div class="detail-sheet">
        <div class="detail-header">
          <div class="detail-title-wrap">
            <span class="emblem lg" style:background={symbolBadgeBg(selectedItem.shortName)}>
              {selectedItem.shortName.slice(0, 2)}
            </span>
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

        <!-- Our trader-first upgrades: HTF Bias + POI note + Notes/Alerts badges -->
        <div class="bias-block">
          <div class="bias-row">
            <span class="sheet-label">HTF Bias</span>
            <div class="bias-pills">
              <button
                class="bias-pill bull"
                class:active={selectedItem.bias === 'bull'}
                type="button"
                onclick={() =>
                  setItemBias(selectedItem.id, selectedItem.bias === 'bull' ? 'none' : 'bull')
                }
              >
                Bull
              </button>
              <button
                class="bias-pill range"
                class:active={selectedItem.bias === 'range'}
                type="button"
                onclick={() =>
                  setItemBias(selectedItem.id, selectedItem.bias === 'range' ? 'none' : 'range')
                }
              >
                Range
              </button>
              <button
                class="bias-pill bear"
                class:active={selectedItem.bias === 'bear'}
                type="button"
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

<style>
  .watchlist {
    --wl-bg: #000000;
    --wl-surface: #0c0e14;
    --wl-border: #262a36;
    --wl-border-soft: rgba(255, 255, 255, 0.08);
    --wl-text: #e6e9f0;
    --wl-secondary: #868993;
    --wl-hover: rgba(255, 255, 255, 0.04);
    --wl-active-ring: #d1d4dc;
    --wl-popover-bg: rgba(20, 23, 31, 0.96);
    --wl-popover-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
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

  .emblem {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #ffffff;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    overflow: hidden;
  }

  .emblem.lg {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
    font-size: 10px;
  }

  .emblem svg {
    width: 12px;
    height: 12px;
  }

  .emblem-tiny {
    font-size: 7.5px;
    letter-spacing: -0.03em;
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

  /* Bottom detail sheet */
  .detail-sheet {
    flex: 0 1 auto;
    max-height: 48%;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    padding: 12px 14px 14px;
    border-top: 3px solid var(--wl-border-soft);
    display: flex;
    flex-direction: column;
    gap: 10px;
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

  .detail-icon-btn:hover {
    color: var(--wl-text);
    background: var(--wl-hover);
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
</style>
