<script lang="ts">
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    COUNTRY_OPTIONS,
    MARKET_OPTIONS,
    PROVIDER_OPTIONS,
    TOPIC_OPTIONS,
    createSavedFeedId,
    fetchNewsArticle,
    fetchNewsFlow,
    fetchSymbolSparkline,
    formatArticleMetaDate,
    formatReadTime,
    formatTimeAgo,
    loadNewsFlowWorkspace,
    saveNewsFlowWorkspace,
    type NewsArticlePayload,
    type NewsFilterOption,
    type NewsFlowItem,
    type NewsFlowQuery,
    type NewsFlowResponse,
    type NewsRelatedSymbol,
    type SavedNewsFeed,
    type SymbolSparkline
  } from '../news/api';
  import { saveNewsItemToNotes } from '../notes/api';
  import {
    SYMBOL_CATALOG,
    createWatchlistItem,
    fetchMarketQuotes,
    formatQuotePct,
    formatQuotePrice,
    loadWatchlistState,
    normalizeSymbolInput,
    saveWatchlistState,
    type MarketQuote,
    type WatchlistGroup,
    type WatchlistState
  } from '../watchlist/store';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    activePrice?: number;
    activeChangePercent?: number;
    onOpenOnChart: (symbol: string, shortName: string) => void;
    onClose: () => void;
  }

  let {
    theme,
    activeSymbol,
    activeFullSymbol,
    activePrice = undefined,
    activeChangePercent = undefined,
    onOpenOnChart,
    onClose
  }: Props = $props();

  type OpenPopover = 'feeds' | 'save' | 'watchlist' | 'instrument' | 'addFilter' | 'more' | null;
  type FilterCategory = 'watchlist' | 'instrument' | 'market' | 'topic' | 'country' | 'provider';

  // Filter state — defaults to "Same as chart" following the active chart tab
  let followChart = $state(true);
  let selectedInstrument = $state<string | null>(null);
  let selectedWatchlistId = $state<string | null>(null);
  let selectedMarket = $state<string | null>(null);
  let selectedTopic = $state<string | null>(null);
  let selectedCountry = $state<string | null>(null);
  let selectedProvider = $state<string | null>(null);
  let filtersExpanded = $state(true);

  // Saved feeds & read history (persisted to workspace)
  let savedFeeds = $state<SavedNewsFeed[]>([]);
  let activeSavedFeedId = $state<string | null>(null);
  let readIds = $state<string[]>([]);
  let workspaceLoaded = $state(false);

  // Watchlist state (for Watchlist filter CRUD)
  let watchlistData = $state<WatchlistState | null>(null);
  let newWatchlistSymbol = $state('');
  let creatingWatchlist = $state(false);
  let newWatchlistName = $state('');

  // Feed data & loading
  let items = $state<NewsFlowItem[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);
  let feedNotice = $state<string | null>(null);
  let feedCached = $state(false);
  let lastUpdatedAt = $state<string | null>(null);
  let nowTickMs = $state(Date.now());

  // Reading mode state
  let readingId = $state<string | null>(null);
  let articlePayload = $state<NewsArticlePayload | null>(null);
  let articleLoading = $state(false);
  let copiedLink = $state(false);
  let savedToNotes = $state(false);
  let chipQuotes = $state<Record<string, MarketQuote>>({});

  // Symbol chip hover card state
  let hoverCard = $state<{
    symbol: string;
    shortName: string;
    left: number;
    top: number;
    above: boolean;
  } | null>(null);
  let hoverSparkline = $state<SymbolSparkline | null>(null);
  let hoverLoading = $state(false);
  let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverAbort: AbortController | undefined;

  // Popover & CRUD UI state
  let openPopover = $state<OpenPopover>(null);
  let addFilterStep = $state<FilterCategory | null>(null);
  let popoverSearch = $state('');
  let saveFeedName = $state('');
  let renamingFeedId = $state<string | null>(null);
  let renameFeedDraft = $state('');

  let panelEl: HTMLDivElement | undefined = $state();
  let readerScrollEl: HTMLDivElement | undefined = $state();
  let saveInputEl: HTMLInputElement | undefined = $state();

  const readIdSet = $derived(new Set(readIds));

  const watchlists = $derived<WatchlistGroup[]>(watchlistData?.groups ?? []);

  const selectedWatchlist = $derived(
    selectedWatchlistId ? (watchlists.find((g) => g.id === selectedWatchlistId) ?? null) : null
  );

  function extractWatchlistSymbols(group: WatchlistGroup): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const sec of group.sections) {
      for (const item of sec.items) {
        const key = item.shortName.toUpperCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item.shortName);
        }
      }
    }
    return out;
  }

  const activeWatchlistSymbols = $derived(
    selectedWatchlist ? extractWatchlistSymbols(selectedWatchlist) : []
  );

  const hasAnyFilter = $derived(
    Boolean(
      followChart ||
        selectedInstrument ||
        selectedWatchlistId ||
        selectedMarket ||
        selectedTopic ||
        selectedCountry ||
        selectedProvider
    )
  );

  const activeSavedFeed = $derived(
    activeSavedFeedId ? (savedFeeds.find((f) => f.id === activeSavedFeedId) ?? null) : null
  );

  const isSavedFeedDirty = $derived.by(() => {
    if (!activeSavedFeed) return true;
    return (
      activeSavedFeed.followChart !== followChart ||
      activeSavedFeed.instrument !== selectedInstrument ||
      activeSavedFeed.watchlistId !== selectedWatchlistId ||
      activeSavedFeed.market !== selectedMarket ||
      activeSavedFeed.topic !== selectedTopic ||
      activeSavedFeed.country !== selectedCountry ||
      activeSavedFeed.provider !== selectedProvider
    );
  });

  const headerTitle = $derived.by(() => {
    if (activeSavedFeed && !isSavedFeedDirty) return activeSavedFeed.name;
    if (followChart) return activeSymbol || 'XAUUSD';
    if (selectedInstrument) return selectedInstrument;
    if (selectedWatchlist) return selectedWatchlist.name;
    if (selectedProvider) {
      return PROVIDER_OPTIONS.find((p) => p.id === selectedProvider)?.label ?? selectedProvider;
    }
    if (selectedMarket) {
      return MARKET_OPTIONS.find((m) => m.id === selectedMarket)?.label ?? selectedMarket;
    }
    if (selectedTopic) {
      return TOPIC_OPTIONS.find((t) => t.id === selectedTopic)?.label ?? selectedTopic;
    }
    if (selectedCountry) {
      return COUNTRY_OPTIONS.find((c) => c.id === selectedCountry)?.label ?? selectedCountry;
    }
    return 'Full feed';
  });

  const currentQuery = $derived.by<NewsFlowQuery>(() => {
    if (selectedWatchlist && activeWatchlistSymbols.length > 0 && !followChart && !selectedInstrument) {
      return {
        mode: 'watchlist',
        symbols: activeWatchlistSymbols,
        market: selectedMarket ?? undefined,
        topic: selectedTopic ?? undefined,
        country: selectedCountry ?? undefined,
        provider: selectedProvider ?? undefined
      };
    }
    if (followChart) {
      return {
        mode: 'symbol',
        symbol: activeFullSymbol || activeSymbol || 'OANDA:XAUUSD',
        market: selectedMarket ?? undefined,
        topic: selectedTopic ?? undefined,
        country: selectedCountry ?? undefined,
        provider: selectedProvider ?? undefined
      };
    }
    if (selectedInstrument) {
      const norm = normalizeSymbolInput(selectedInstrument);
      return {
        mode: 'symbol',
        symbol: norm.symbol,
        market: selectedMarket ?? undefined,
        topic: selectedTopic ?? undefined,
        country: selectedCountry ?? undefined,
        provider: selectedProvider ?? undefined
      };
    }
    if (selectedWatchlist && activeWatchlistSymbols.length > 0) {
      return {
        mode: 'watchlist',
        symbols: activeWatchlistSymbols,
        market: selectedMarket ?? undefined,
        topic: selectedTopic ?? undefined,
        country: selectedCountry ?? undefined,
        provider: selectedProvider ?? undefined
      };
    }
    return {
      mode: 'full',
      market: selectedMarket ?? undefined,
      topic: selectedTopic ?? undefined,
      country: selectedCountry ?? undefined,
      provider: selectedProvider ?? undefined
    };
  });

  const queryKey = $derived(JSON.stringify(currentQuery));

  const readingIndex = $derived(
    readingId ? items.findIndex((item) => item.id === readingId) : -1
  );
  const readingItem = $derived(readingIndex >= 0 ? items[readingIndex] : null);

  function optionLabel(list: NewsFilterOption[], id: string | null): string {
    if (!id) return '';
    return list.find((o) => o.id === id)?.label ?? id;
  }

  function persistWorkspace() {
    void saveNewsFlowWorkspace({
      savedFeeds: $state.snapshot(savedFeeds),
      readIds: $state.snapshot(readIds)
    });
  }

  function markAsRead(id: string) {
    if (readIdSet.has(id)) return;
    readIds = [...readIds.slice(-249), id];
    persistWorkspace();
  }

  let fetchSeq = 0;
  let activeFetchController: AbortController | undefined;
  let lastLoadedQueryKey = '';

  async function loadFeed(force = false) {
    if (activeFetchController) activeFetchController.abort();
    const controller = new AbortController();
    activeFetchController = controller;
    const seq = ++fetchSeq;
    const reqKey = queryKey;
    const queryChanged = reqKey !== lastLoadedQueryKey;

    if (items.length === 0 || queryChanged) {
      if (queryChanged) items = [];
      loading = true;
    } else {
      refreshing = true;
    }
    loadError = null;

    try {
      const res: NewsFlowResponse = await fetchNewsFlow(
        { ...currentQuery, force },
        controller.signal
      );
      if (seq !== fetchSeq) return;
      items = res.items;
      lastLoadedQueryKey = reqKey;
      feedCached = res.cached;
      feedNotice = res.notice ?? null;
      lastUpdatedAt = res.updatedAt;
      nowTickMs = Date.now();
    } catch (err) {
      if (seq !== fetchSeq || (err as Error)?.name === 'AbortError') return;
      loadError = (err as Error)?.message || 'Failed to load news feed.';
    }
    if (seq === fetchSeq) {
      loading = false;
      refreshing = false;
    }
  }

  // Load workspace & watchlists once on mount
  $effect(() => {
    let cancelled = false;
    void Promise.all([loadNewsFlowWorkspace(), loadWatchlistState()])
      .then(([ws, wl]) => {
        if (cancelled) return;
        savedFeeds = ws.savedFeeds;
        readIds = ws.readIds;
        watchlistData = wl;
        workspaceLoaded = true;
      })
      .catch(() => {
        if (!cancelled) workspaceLoaded = true;
      });

    const tickTimer = setInterval(() => {
      nowTickMs = Date.now();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(tickTimer);
      activeFetchController?.abort();
      hoverAbort?.abort();
      if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
    };
  });

  // Automatically re-fetch whenever active chart symbol or filters change
  $effect(() => {
    void queryKey;
    if (!workspaceLoaded) return;
    // If user switches chart tab while in list mode (or reading mode when following chart), refresh feed cleanly
    void loadFeed(false);
  });

  // Load full article text (only for permitted public-domain / CC BY 4.0 sources) + live symbol chip quotes
  $effect(() => {
    const item = readingItem;
    if (!item) {
      articlePayload = null;
      articleLoading = false;
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    copiedLink = false;
    savedToNotes = false;

    // Fetch live quotes for every related symbol chip on this article
    const syms = item.symbols.map((s) => s.symbol);
    if (syms.length > 0) {
      void fetchMarketQuotes(syms, controller.signal)
        .then((quotes) => {
          if (!cancelled) {
            chipQuotes = { ...chipQuotes, ...quotes };
          }
        })
        .catch(() => {
          // ignore
        });
    }

    if (item.displayMode === 'full') {
      articleLoading = true;
      articlePayload = null;
      void fetchNewsArticle(item.url, controller.signal)
        .then((payload) => {
          if (!cancelled) {
            articlePayload = payload;
            articleLoading = false;
          }
        })
        .catch(() => {
          if (!cancelled) {
            articlePayload = null;
            articleLoading = false;
          }
        });
    } else {
      articlePayload = null;
      articleLoading = false;
    }

    queueMicrotask(() => {
      if (readerScrollEl) readerScrollEl.scrollTop = 0;
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  });

  function openArticle(item: NewsFlowItem) {
    openPopover = null;
    closeHoverCardImmediate();
    readingId = item.id;
    markAsRead(item.id);
  }

  function closeReader() {
    closeHoverCardImmediate();
    readingId = null;
  }

  function stepArticle(delta: number) {
    if (readingIndex < 0) return;
    const nextIdx = readingIndex + delta;
    if (nextIdx < 0 || nextIdx >= items.length) return;
    openArticle(items[nextIdx]);
  }

  function clearFollowChartToFullFeed() {
    followChart = false;
    selectedInstrument = null;
    activeSavedFeedId = null;
  }

  function resetAllFiltersToFullFeed() {
    followChart = false;
    selectedInstrument = null;
    selectedWatchlistId = null;
    selectedMarket = null;
    selectedTopic = null;
    selectedCountry = null;
    selectedProvider = null;
    activeSavedFeedId = null;
    openPopover = null;
  }

  function restoreFollowChart() {
    followChart = true;
    selectedInstrument = null;
    selectedWatchlistId = null;
    selectedMarket = null;
    selectedTopic = null;
    selectedCountry = null;
    selectedProvider = null;
    activeSavedFeedId = null;
    openPopover = null;
  }

  function selectWatchlistFilter(groupId: string | null) {
    selectedWatchlistId = groupId;
    if (groupId) {
      followChart = false;
      selectedInstrument = null;
    }
    openPopover = null;
    addFilterStep = null;
    popoverSearch = '';
  }

  function selectInstrumentFilter(shortName: string) {
    const norm = normalizeSymbolInput(shortName);
    followChart = false;
    selectedInstrument = norm.shortName;
    selectedWatchlistId = null;
    openPopover = null;
    addFilterStep = null;
    popoverSearch = '';
  }

  async function quickAddSymbolToWatchlist(groupId: string) {
    const raw = newWatchlistSymbol.trim();
    if (!raw || !watchlistData) return;
    const group = watchlistData.groups.find((g) => g.id === groupId);
    if (!group) return;
    const norm = normalizeSymbolInput(raw);
    const existing = extractWatchlistSymbols(group);
    if (existing.includes(norm.shortName.toUpperCase())) {
      newWatchlistSymbol = '';
      return;
    }
    const nextItem = createWatchlistItem(norm.symbol);
    const nextGroups = watchlistData.groups.map((g) => {
      if (g.id !== groupId) return g;
      const sections = g.sections.length > 0
        ? g.sections.map((s, idx) =>
            idx === 0 ? { ...s, items: [nextItem, ...s.items] } : s
          )
        : [{ id: 'sec-custom', name: 'SYMBOLS', collapsed: false, items: [nextItem] }];
      return { ...g, sections };
    });
    const nextState: WatchlistState = { ...watchlistData, groups: nextGroups };
    watchlistData = nextState;
    newWatchlistSymbol = '';
    await saveWatchlistState(nextState);
  }

  async function removeSymbolFromWatchlist(groupId: string, shortName: string) {
    if (!watchlistData) return;
    const target = shortName.trim().toUpperCase();
    const nextGroups = watchlistData.groups.map((g) => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        sections: g.sections.map((s) => ({
          ...s,
          items: s.items.filter((it) => it.shortName.trim().toUpperCase() !== target)
        }))
      };
    });
    const nextState: WatchlistState = { ...watchlistData, groups: nextGroups };
    watchlistData = nextState;
    await saveWatchlistState(nextState);
  }

  async function createNewsWatchlist() {
    const clean = newWatchlistName.trim();
    if (!clean || !watchlistData) return;
    const id = `wl-news-${Date.now().toString(36)}`;
    const seedSymbol = activeFullSymbol || activeSymbol || 'OANDA:XAUUSD';
    const newGroup: WatchlistGroup = {
      id,
      name: clean,
      sections: [
        {
          id: `sec-${Date.now().toString(36)}`,
          name: 'TRACKED',
          collapsed: false,
          items: [createWatchlistItem(seedSymbol)]
        }
      ]
    };
    const nextState: WatchlistState = {
      ...watchlistData,
      groups: [...watchlistData.groups, newGroup]
    };
    watchlistData = nextState;
    newWatchlistName = '';
    creatingWatchlist = false;
    await saveWatchlistState(nextState);
    selectWatchlistFilter(id);
  }

  async function deleteNewsWatchlist(groupId: string) {
    if (!watchlistData || watchlistData.groups.length <= 1) return;
    const remaining = watchlistData.groups.filter((g) => g.id !== groupId);
    const nextActive =
      watchlistData.activeGroupId === groupId ? remaining[0].id : watchlistData.activeGroupId;
    const nextState: WatchlistState = {
      activeGroupId: nextActive,
      groups: remaining
    };
    watchlistData = nextState;
    if (selectedWatchlistId === groupId) {
      selectedWatchlistId = null;
    }
    await saveWatchlistState(nextState);
  }

  // Saved feeds CRUD
  function openSavePopover() {
    if (openPopover === 'save') {
      openPopover = null;
      return;
    }
    saveFeedName = activeSavedFeed ? activeSavedFeed.name : headerTitle;
    openPopover = 'save';
    queueMicrotask(() => {
      saveInputEl?.focus();
      saveInputEl?.select();
    });
  }

  function commitSaveFeed() {
    const cleanName = saveFeedName.trim();
    if (!cleanName) return;

    if (activeSavedFeed && activeSavedFeed.name.toLowerCase() === cleanName.toLowerCase()) {
      savedFeeds = savedFeeds.map((f) =>
        f.id === activeSavedFeed.id
          ? {
              ...f,
              name: cleanName,
              followChart,
              instrument: selectedInstrument,
              watchlistId: selectedWatchlistId,
              market: selectedMarket,
              topic: selectedTopic,
              country: selectedCountry,
              provider: selectedProvider
            }
          : f
      );
    } else {
      const created: SavedNewsFeed = {
        id: createSavedFeedId(),
        name: cleanName,
        followChart,
        instrument: selectedInstrument,
        watchlistId: selectedWatchlistId,
        market: selectedMarket,
        topic: selectedTopic,
        country: selectedCountry,
        provider: selectedProvider,
        createdAt: new Date().toISOString()
      };
      savedFeeds = [created, ...savedFeeds];
      activeSavedFeedId = created.id;
    }
    persistWorkspace();
    openPopover = null;
  }

  function applySavedFeed(feed: SavedNewsFeed) {
    followChart = feed.followChart;
    selectedInstrument = feed.instrument;
    selectedWatchlistId = feed.watchlistId;
    selectedMarket = feed.market;
    selectedTopic = feed.topic;
    selectedCountry = feed.country;
    selectedProvider = feed.provider;
    activeSavedFeedId = feed.id;
    openPopover = null;
  }

  function commitRenameFeed(feedId: string) {
    const clean = renameFeedDraft.trim();
    if (clean) {
      savedFeeds = savedFeeds.map((f) => (f.id === feedId ? { ...f, name: clean } : f));
      persistWorkspace();
    }
    renamingFeedId = null;
  }

  function deleteSavedFeed(feedId: string) {
    savedFeeds = savedFeeds.filter((f) => f.id !== feedId);
    if (activeSavedFeedId === feedId) activeSavedFeedId = null;
    persistWorkspace();
  }

  function togglePopover(next: Exclude<OpenPopover, null>) {
    if (openPopover === next) {
      openPopover = null;
      addFilterStep = null;
      return;
    }
    openPopover = next;
    addFilterStep = null;
    popoverSearch = '';
  }

  // Reading mode actions
  async function copyArticleLink(item: NewsFlowItem) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(item.url);
      }
      copiedLink = true;
      setTimeout(() => {
        copiedLink = false;
      }, 1800);
    } catch {
      // ignore
    }
  }

  async function saveArticleToNotes(item: NewsFlowItem) {
    const primary = item.symbols[0];
    const bodyParts = [
      `Source: ${item.providerName} (${formatArticleMetaDate(item.publishedAt)})`,
      '',
      articlePayload?.fullTextAvailable && articlePayload.paragraphs.length > 0
        ? articlePayload.paragraphs.slice(0, 4).join('\n\n')
        : item.snippet,
      '',
      `Link: ${item.url}`
    ];
    try {
      await saveNewsItemToNotes({
        title: item.title,
        body: bodyParts.join('\n'),
        symbol: primary?.shortName ?? (activeSymbol || 'XAUUSD'),
        fullSymbol: primary?.symbol ?? (activeFullSymbol || 'OANDA:XAUUSD')
      });
      savedToNotes = true;
      setTimeout(() => {
        savedToNotes = false;
      }, 2000);
    } catch {
      // ignore
    }
  }

  // Symbol chip hover card logic
  function getChipChangePct(sym: NewsRelatedSymbol): number | null {
    const q = chipQuotes[sym.symbol];
    if (q && Number.isFinite(q.changePercent)) return q.changePercent;
    if (
      sym.shortName.toUpperCase() === (activeSymbol || '').toUpperCase() &&
      typeof activeChangePercent === 'number' &&
      Number.isFinite(activeChangePercent)
    ) {
      return activeChangePercent;
    }
    return null;
  }

  function openHoverCardForChip(sym: NewsRelatedSymbol, targetEl: HTMLElement) {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }

    const rect = targetEl.getBoundingClientRect();
    const cardW = 292;
    const cardH = 228;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 760;

    const left = Math.round(Math.min(vw - cardW - 14, Math.max(14, rect.left - 12)));
    const spaceAbove = rect.top - 48;
    const above = spaceAbove >= cardH + 10;
    const top = above
      ? Math.round(rect.top - cardH - 10)
      : Math.round(Math.min(vh - cardH - 12, rect.bottom + 10));

    const sameSymbol = hoverCard?.symbol === sym.symbol;
    hoverCard = { symbol: sym.symbol, shortName: sym.shortName, left, top, above };

    if (sameSymbol && hoverSparkline?.symbol === sym.symbol) return;

    hoverAbort?.abort();
    const controller = new AbortController();
    hoverAbort = controller;
    hoverLoading = true;

    // Seed immediate preview from live quote cache if available
    const existingQuote = chipQuotes[sym.symbol];
    const isActiveSym = sym.shortName.toUpperCase() === (activeSymbol || '').toUpperCase();
    const knownMeta = SYMBOL_CATALOG.find((c) => c.shortName === sym.shortName);
    hoverSparkline = {
      symbol: sym.symbol,
      shortName: sym.shortName,
      description: existingQuote?.description ?? knownMeta?.description ?? sym.shortName,
      price: existingQuote?.price ?? (isActiveSym && activePrice !== undefined ? activePrice : null),
      change: existingQuote?.change ?? null,
      changePercent:
        existingQuote?.changePercent ??
        (isActiveSym && activeChangePercent !== undefined ? activeChangePercent : null),
      currency: sym.shortName.length === 6 && !sym.shortName.startsWith('XA') ? sym.shortName.slice(3) : 'USD',
      points: [],
      periodLabel: '1 day',
      updatedAt: ''
    };

    void fetchSymbolSparkline(sym.symbol, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        hoverSparkline = data;
        hoverLoading = false;
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          hoverLoading = false;
        }
      });
  }

  function scheduleCloseHoverCard() {
    if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      hoverCard = null;
      hoverCloseTimer = undefined;
    }, 180);
  }

  function cancelCloseHoverCard() {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
  }

  function closeHoverCardImmediate() {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
    hoverAbort?.abort();
    hoverCard = null;
  }

  function buildSparklineGeometry(points: number[]): { line: string; area: string; lastX: number; lastY: number } | null {
    if (points.length < 2) return null;
    const w = 252;
    const h = 64;
    const padY = 6;
    let min = points[0];
    let max = points[0];
    for (let i = 1; i < points.length; i++) {
      if (points[i] < min) min = points[i];
      if (points[i] > max) max = points[i];
    }
    const span = max - min || 1;
    const coords: [number, number][] = points.map((val, idx) => {
      const x = (idx / (points.length - 1)) * w;
      const y = h - padY - ((val - min) / span) * (h - padY * 2);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });
    const line = coords.map(([x, y]) => `${x},${y}`).join(' ');
    const area = `0,${h} ${line} ${w},${h}`;
    const last = coords[coords.length - 1];
    return { line, area, lastX: last[0], lastY: last[1] };
  }

  const sparkGeom = $derived(
    hoverSparkline ? buildSparklineGeometry(hoverSparkline.points) : null
  );
  const sparkIsUp = $derived((hoverSparkline?.changePercent ?? 0) >= 0);

  // Filtered options inside Add Filter / Watchlist / Instrument popovers
  const filterCategories: { id: FilterCategory; label: string }[] = [
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'instrument', label: 'Instrument' },
    { id: 'market', label: 'Market' },
    { id: 'topic', label: 'Topic & Corporate' },
    { id: 'country', label: 'Country' },
    { id: 'provider', label: 'Provider' }
  ];

  const filteredCategories = $derived.by(() => {
    const q = popoverSearch.trim().toLowerCase();
    if (!q) return filterCategories;
    return filterCategories.filter((c) => c.label.toLowerCase().includes(q));
  });

  const filteredWatchlists = $derived.by(() => {
    const q = popoverSearch.trim().toLowerCase();
    if (!q) return watchlists;
    return watchlists.filter((g) => g.name.toLowerCase().includes(q));
  });

  const filteredInstruments = $derived.by(() => {
    const q = popoverSearch.trim().toLowerCase();
    if (!q) return SYMBOL_CATALOG.slice(0, 14);
    return SYMBOL_CATALOG.filter(
      (s) =>
        s.shortName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q)
    ).slice(0, 14);
  });

  function getFilteredCategoryOptions(cat: FilterCategory): NewsFilterOption[] {
    const list =
      cat === 'market'
        ? MARKET_OPTIONS
        : cat === 'topic'
          ? TOPIC_OPTIONS
          : cat === 'country'
            ? COUNTRY_OPTIONS
            : cat === 'provider'
              ? PROVIDER_OPTIONS
              : [];
    const q = popoverSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.meta ?? '').toLowerCase().includes(q) ||
        o.id.toLowerCase().includes(q)
    );
  }

  function applyCategoryOption(cat: FilterCategory, id: string) {
    if (cat === 'market') selectedMarket = id;
    else if (cat === 'topic') selectedTopic = id;
    else if (cat === 'country') selectedCountry = id;
    else if (cat === 'provider') selectedProvider = id;
    openPopover = null;
    addFilterStep = null;
    popoverSearch = '';
  }

  function onWindowPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (openPopover && !target.closest('[data-nf-popover]')) {
      openPopover = null;
      addFilterStep = null;
    }
    if (hoverCard && !target.closest('[data-nf-hover-card]') && !target.closest('[data-nf-chip]')) {
      closeHoverCardImmediate();
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (readingItem) closeReader();
      filtersExpanded = true;
      togglePopover('addFilter');
      return;
    }
    if (e.key === 'Escape') {
      if (openPopover) {
        openPopover = null;
        addFilterStep = null;
      } else if (hoverCard) {
        closeHoverCardImmediate();
      } else if (readingItem) {
        closeReader();
      }
      return;
    }
    if (readingItem) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepArticle(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepArticle(1);
      }
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<PanelShell {theme} title="News Flow" defaultWidth={430} minWidth={360} maxWidth={680} {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" />
      <path d="M6.25 10h6.5M10.25 7.25 13 10l-2.75 2.75" />
    </svg>
  {/snippet}

  <div bind:this={panelEl} class="news-panel" class:light={theme === 'light'}>
    {#if readingItem}
      <!-- ==================== READING MODE ==================== -->
      <div class="reader-topbar">
        <button class="back-btn" type="button" onclick={closeReader}>
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="m11.25 4.25-4.75 4.75 4.75 4.75" />
          </svg>
          <span>Back</span>
        </button>

        {#if readingItem.displayMode === 'full'}
          <span class="policy-pill full">Full release</span>
        {/if}
      </div>

      <div bind:this={readerScrollEl} class="reader-scroll">
        <!-- Branded source masthead -->
        <div class="masthead" style:--brand-color={readingItem.brandColor}>
          {#if readingItem.badgeStyle === 'reuters'}
            <svg class="reuters-mark" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="3.2" r="1.45" fill="#ff8000" />
              <circle cx="17.8" cy="5.5" r="1.4" fill="#ff8000" />
              <circle cx="20.8" cy="11.2" r="1.45" fill="#ff8000" />
              <circle cx="18.6" cy="17.2" r="1.35" fill="#ff8000" />
              <circle cx="13" cy="20.6" r="1.4" fill="#ff8000" />
              <circle cx="6.8" cy="18.8" r="1.35" fill="#ff8000" />
              <circle cx="3.4" cy="13.2" r="1.4" fill="#ff8000" />
              <circle cx="5.4" cy="6.8" r="1.35" fill="#ff8000" />
              <circle cx="12" cy="7.2" r="1.05" fill="#ff8000" />
              <circle cx="16.2" cy="9.8" r="1.05" fill="#ff8000" />
              <circle cx="15.8" cy="14.8" r="1.05" fill="#ff8000" />
              <circle cx="11.2" cy="16.8" r="1.05" fill="#ff8000" />
              <circle cx="7.4" cy="13.6" r="1.05" fill="#ff8000" />
              <circle cx="8.2" cy="8.8" r="1.05" fill="#ff8000" />
            </svg>
            <span class="masthead-wordmark reuters">REUTERS</span>
          {:else}
            <span class="masthead-dot" style:background={readingItem.brandColor}></span>
            <span class="masthead-wordmark">{readingItem.providerName}</span>
          {/if}
        </div>

        <h1 class="reader-title">{readingItem.title}</h1>

        <div class="reader-meta-row">
          <div class="reader-meta">
            <span>{formatArticleMetaDate(readingItem.publishedAt)}</span>
            <span class="meta-dot">·</span>
            <span>{readingItem.providerName}</span>
            <span class="meta-dot">·</span>
            <span>
              {formatReadTime(
                articlePayload?.fullTextAvailable
                  ? articlePayload.readTimeMinutes
                  : readingItem.readTimeMinutes
              )}
            </span>
          </div>

          <div class="reader-actions">
            <button
              class="reader-icon-btn"
              class:done={savedToNotes}
              type="button"
              aria-label="Save article summary to Notes"
              title={savedToNotes ? 'Saved to Notes' : 'Save to Notes'}
              onclick={() => void saveArticleToNotes(readingItem)}
            >
              {#if savedToNotes}
                <svg viewBox="0 0 18 18" aria-hidden="true">
                  <path d="m4.25 9.25 3.1 3.1 6.4-6.7" />
                </svg>
              {:else}
                <svg viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M3.5 4.25h11a1.25 1.25 0 0 1 1.25 1.25v7a1.25 1.25 0 0 1-1.25 1.25H7.25L4 16v-2.25h-.5A1.25 1.25 0 0 1 2.25 12.5v-7A1.25 1.25 0 0 1 3.5 4.25Z" />
                  <path d="M9 7v2.75M9 11.75h.01" />
                </svg>
              {/if}
            </button>

            <button
              class="reader-icon-btn"
              class:done={copiedLink}
              type="button"
              aria-label="Copy article link"
              title={copiedLink ? 'Link copied' : 'Copy link'}
              onclick={() => void copyArticleLink(readingItem)}
            >
              {#if copiedLink}
                <svg viewBox="0 0 18 18" aria-hidden="true">
                  <path d="m4.25 9.25 3.1 3.1 6.4-6.7" />
                </svg>
              {:else}
                <svg viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M7.6 10.4 10.4 7.6M6.5 13l-1.35 1.35a2.4 2.4 0 0 1-3.4-3.4L4 8.7a2.4 2.4 0 0 1 3.4 0M11.5 5l1.35-1.35a2.4 2.4 0 0 1 3.4 3.4L14 9.3a2.4 2.4 0 0 1-3.4 0" />
                </svg>
              {/if}
            </button>
          </div>
        </div>

        <!-- Interactive Symbol Chips with Hover Mini-Chart Card -->
        {#if readingItem.symbols.length > 0}
          <div class="reader-chips">
            {#each readingItem.symbols as sym (sym.symbol)}
              {@const pct = getChipChangePct(sym)}
              <button
                class="sym-chip"
                type="button"
                data-nf-chip="true"
                onmouseenter={(e) => openHoverCardForChip(sym, e.currentTarget as HTMLElement)}
                onmouseleave={scheduleCloseHoverCard}
                onfocus={(e) => openHoverCardForChip(sym, e.currentTarget as HTMLElement)}
                onclick={(e) => openHoverCardForChip(sym, e.currentTarget as HTMLElement)}
              >
                <SymbolIcon symbol={sym.shortName} size={16} />
                <span class="sym-chip-name">{sym.shortName}</span>
                {#if pct !== null}
                  <span class="sym-chip-pct" class:up={pct > 0} class:down={pct < 0}>
                    {formatQuotePct(pct)}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}

        <!-- Article Body (Full text for permitted public-domain / CC BY 4.0 sources; Snippet + Source Link for restricted publishers) -->
        <div class="reader-body">
          {#if readingItem.displayMode === 'full'}
            {#if articleLoading}
              <div class="body-skeleton">
                <span class="sk-line w92"></span>
                <span class="sk-line w100"></span>
                <span class="sk-line w84"></span>
                <span class="sk-line w96"></span>
                <span class="sk-line w72"></span>
              </div>
            {:else if articlePayload?.fullTextAvailable && articlePayload.paragraphs.length > 0}
              {#each articlePayload.paragraphs as para, idx (idx)}
                <p>{para}</p>
              {/each}
            {:else if readingItem.snippet}
              <p>{readingItem.snippet}</p>
            {/if}

            <div class="source-footer-card">
              <p class="source-terms-note">{readingItem.termsNote}</p>
              <a
                class="source-link-btn"
                href={readingItem.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>Open official release on {readingItem.providerName}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6.25 3.75h6v6M12.25 3.75 4 12" />
                </svg>
              </a>
            </div>
          {:else}
            {#if readingItem.snippet}
              <p class="snippet-lead">{readingItem.snippet}</p>
            {:else}
              <p class="snippet-lead">Summary preview unavailable for this headline.</p>
            {/if}

            <div class="source-footer-card">
              <p class="source-terms-note">{readingItem.termsNote}</p>
              <a
                class="source-link-btn primary"
                href={readingItem.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>Read full article on {readingItem.providerName}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6.25 3.75h6v6M12.25 3.75 4 12" />
                </svg>
              </a>
            </div>
          {/if}
        </div>
      </div>

      <!-- Sticky Previous / Next Footer -->
      <div class="reader-footer">
        <div class="reader-nav-group">
          <button
            class="reader-nav-btn"
            type="button"
            disabled={readingIndex <= 0}
            onclick={() => stepArticle(-1)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m10 3.75-4.25 4.25L10 12.25" />
            </svg>
            <span>Previous</span>
          </button>

          <button
            class="reader-nav-btn"
            type="button"
            disabled={readingIndex < 0 || readingIndex >= items.length - 1}
            onclick={() => stepArticle(1)}
          >
            <span>Next</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m6 3.75 4.25 4.25L6 12.25" />
            </svg>
          </button>
        </div>
      </div>
    {:else}
      <!-- ==================== LIST VIEW ==================== -->
      <div class="feed-header">
        <div class="feed-header-left">
          <!-- Feed / Symbol selector dropdown -->
          <div class="pop-anchor" data-nf-popover="true">
            <button
              class="feed-title-btn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={openPopover === 'feeds'}
              onclick={() => togglePopover('feeds')}
            >
              <span class="feed-title-text">{headerTitle}</span>
              <svg class="chev" class:open={openPopover === 'feeds'} viewBox="0 0 14 14" aria-hidden="true">
                <path d="m3.5 5.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>

            {#if openPopover === 'feeds'}
              <div class="nf-popover feeds-pop" role="menu">
                <div class="pop-section-lbl">Feeds</div>
                <button
                  class="pop-row"
                  class:active={followChart && !activeSavedFeedId}
                  type="button"
                  onclick={restoreFollowChart}
                >
                  <SymbolIcon symbol={activeSymbol || 'XAUUSD'} size={16} />
                  <span class="pop-row-main">Same as chart ({activeSymbol || 'XAUUSD'})</span>
                </button>
                <button
                  class="pop-row"
                  class:active={!hasAnyFilter}
                  type="button"
                  onclick={resetAllFiltersToFullFeed}
                >
                  <span class="pop-globe-dot" aria-hidden="true"></span>
                  <span class="pop-row-main">Full feed</span>
                  <span class="pop-row-meta">All markets</span>
                </button>

                {#if savedFeeds.length > 0}
                  <div class="pop-div"></div>
                  <div class="pop-section-lbl">Saved feeds</div>
                  {#each savedFeeds as feed (feed.id)}
                    <div class="saved-feed-row" class:active={activeSavedFeedId === feed.id}>
                      {#if renamingFeedId === feed.id}
                        <input
                          class="inline-rename"
                          type="text"
                          bind:value={renameFeedDraft}
                          onblur={() => commitRenameFeed(feed.id)}
                          onkeydown={(e) => {
                            if (e.key === 'Enter') commitRenameFeed(feed.id);
                            if (e.key === 'Escape') renamingFeedId = null;
                          }}
                        />
                      {:else}
                        <button
                          class="saved-feed-btn"
                          type="button"
                          onclick={() => applySavedFeed(feed)}
                        >
                          {feed.name}
                        </button>
                        <button
                          class="saved-act"
                          type="button"
                          title="Rename feed"
                          aria-label="Rename {feed.name}"
                          onclick={(e) => {
                            e.stopPropagation();
                            renamingFeedId = feed.id;
                            renameFeedDraft = feed.name;
                          }}
                        >
                          <svg viewBox="0 0 14 14" aria-hidden="true">
                            <path d="M9.6 2.6a1.2 1.2 0 0 1 1.7 1.7l-5.7 5.7-2.4.6.6-2.4 5.8-5.6Z" />
                          </svg>
                        </button>
                        <button
                          class="saved-act del"
                          type="button"
                          title="Delete saved feed"
                          aria-label="Delete {feed.name}"
                          onclick={(e) => {
                            e.stopPropagation();
                            deleteSavedFeed(feed.id);
                          }}
                        >
                          ×
                        </button>
                      {/if}
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>

          <!-- Save feed button (matching TradingView blue cloud Save) -->
          <div class="pop-anchor" data-nf-popover="true">
            <button
              class="save-feed-btn"
              class:saved={Boolean(activeSavedFeed && !isSavedFeedDirty)}
              type="button"
              onclick={openSavePopover}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M5.75 13.75h7.25a2.75 2.75 0 0 0 .45-5.45 4 4 0 0 0-7.7-.6 3.1 3.1 0 0 0 0 6.05Z" />
                <path d="M9 12.25V8.5m0 0-1.6 1.6M9 8.5l1.6 1.6" />
              </svg>
              <span>{activeSavedFeed && !isSavedFeedDirty ? 'Saved' : 'Save'}</span>
            </button>

            {#if openPopover === 'save'}
              <div class="nf-popover save-pop">
                <div class="pop-title">Save News Flow preset</div>
                <input
                  bind:this={saveInputEl}
                  class="pop-search"
                  type="text"
                  maxlength={32}
                  placeholder="Preset name (e.g. Gold & Oil)"
                  bind:value={saveFeedName}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitSaveFeed();
                    if (e.key === 'Escape') openPopover = null;
                  }}
                />
                <div class="save-pop-actions">
                  <button class="pop-btn-ghost" type="button" onclick={() => (openPopover = null)}>
                    Cancel
                  </button>
                  <button
                    class="pop-btn-primary"
                    type="button"
                    disabled={!saveFeedName.trim()}
                    onclick={commitSaveFeed}
                  >
                    Save
                  </button>
                </div>
              </div>
            {/if}
          </div>
        </div>

        <div class="feed-header-right">
          <button
            class="hdr-square-btn"
            type="button"
            aria-label="Refresh news"
            title={feedCached ? 'Refresh news (cached 15m · 60s cooldown)' : 'Refresh news'}
            disabled={loading || refreshing}
            onclick={() => void loadFeed(true)}
          >
            <svg class:spin={refreshing} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.35-3.42M13 3.25v2.5h-2.5" />
            </svg>
          </button>

          <button
            class="hdr-square-btn"
            type="button"
            aria-label={filtersExpanded ? 'Collapse filters' : 'Expand filters'}
            title={filtersExpanded ? 'Hide filters' : 'Show filters'}
            onclick={() => (filtersExpanded = !filtersExpanded)}
          >
            <svg class="collapse-chev" class:collapsed={!filtersExpanded} viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 9.75 3.5-3.5 3.5 3.5" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Filter Chips Bar -->
      {#if filtersExpanded}
        <div class="filter-bar">
          <!-- Watchlist Filter -->
          <div class="pop-anchor" data-nf-popover="true">
            {#if selectedWatchlist}
              <div class="active-chip">
                <button
                  class="active-chip-main"
                  type="button"
                  onclick={() => togglePopover('watchlist')}
                >
                  <svg class="chip-list-ico" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 4.5h10M3 8h10M3 11.5h7" />
                  </svg>
                  <span>{selectedWatchlist.name}</span>
                </button>
                <span class="chip-sep" aria-hidden="true"></span>
                <button
                  class="active-chip-x"
                  type="button"
                  aria-label="Remove watchlist filter"
                  onclick={() => selectWatchlistFilter(null)}
                >
                  ×
                </button>
              </div>
            {:else}
              <button
                class="filter-pill"
                class:open={openPopover === 'watchlist'}
                type="button"
                onclick={() => togglePopover('watchlist')}
              >
                <span>Watchlist</span>
                <svg class="pill-chev" class:open={openPopover === 'watchlist'} viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" />
                </svg>
              </button>
            {/if}

            {#if openPopover === 'watchlist'}
              {@const editTarget = selectedWatchlist ?? watchlists[0] ?? null}
              {@const editSymbols = editTarget ? extractWatchlistSymbols(editTarget) : []}
              <div class="nf-popover wl-pop">
                <div class="pop-title-row">
                  <span class="pop-title-label">Watchlist</span>
                  <button
                    class="wl-new-toggle"
                    type="button"
                    onclick={() => {
                      creatingWatchlist = !creatingWatchlist;
                      newWatchlistName = '';
                    }}
                  >
                    {creatingWatchlist ? 'Cancel' : '+ New list'}
                  </button>
                </div>
                {#if creatingWatchlist}
                  <div class="wl-quick-add">
                    <input
                      class="pop-search compact"
                      type="text"
                      placeholder="New watchlist name…"
                      bind:value={newWatchlistName}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') void createNewsWatchlist();
                      }}
                    />
                    <button
                      class="pop-btn-primary compact"
                      type="button"
                      disabled={!newWatchlistName.trim()}
                      onclick={() => void createNewsWatchlist()}
                    >
                      Create
                    </button>
                  </div>
                {:else}
                  <input
                    class="pop-search"
                    type="text"
                    placeholder="Search"
                    bind:value={popoverSearch}
                  />
                {/if}
                <div class="pop-list">
                  {#each filteredWatchlists as group (group.id)}
                    {@const syms = extractWatchlistSymbols(group)}
                    <div class="pop-row-wrap">
                      <button
                        class="pop-row"
                        class:active={selectedWatchlistId === group.id}
                        type="button"
                        onclick={() => selectWatchlistFilter(group.id)}
                      >
                        <span class="pop-row-main">{group.name}</span>
                        <span class="pop-row-meta">{syms.length} symbols</span>
                      </button>
                      {#if watchlists.length > 1}
                        <button
                          class="pop-row-del"
                          type="button"
                          aria-label="Delete watchlist"
                          title="Delete watchlist"
                          onclick={() => void deleteNewsWatchlist(group.id)}
                        >
                          ×
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
                {#if editTarget}
                  <div class="pop-div"></div>
                  {#if editSymbols.length > 0}
                    <div class="wl-sym-chips">
                      {#each editSymbols.slice(0, 8) as sym (sym)}
                        <span class="wl-sym-chip">
                          <span>{sym}</span>
                          <button
                            type="button"
                            aria-label="Remove {sym} from {editTarget.name}"
                            onclick={() => void removeSymbolFromWatchlist(editTarget.id, sym)}
                          >
                            ×
                          </button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                  <div class="wl-quick-add">
                    <input
                      class="pop-search compact"
                      type="text"
                      placeholder="Add symbol to {editTarget.name}…"
                      bind:value={newWatchlistSymbol}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') void quickAddSymbolToWatchlist(editTarget.id);
                      }}
                    />
                    <button
                      class="pop-btn-primary compact"
                      type="button"
                      disabled={!newWatchlistSymbol.trim()}
                      onclick={() => void quickAddSymbolToWatchlist(editTarget.id)}
                    >
                      Add
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Same as chart OR Instrument pill -->
          <div class="pop-anchor" data-nf-popover="true">
            {#if followChart}
              <div class="active-chip">
                <button
                  class="active-chip-main"
                  type="button"
                  onclick={() => togglePopover('instrument')}
                >
                  <SymbolIcon symbol={activeSymbol || 'XAUUSD'} size={16} />
                  <span>Same as chart</span>
                </button>
                <span class="chip-sep" aria-hidden="true"></span>
                <button
                  class="active-chip-x"
                  type="button"
                  aria-label="Remove Same as chart filter"
                  title="Switch to Full feed"
                  onclick={clearFollowChartToFullFeed}
                >
                  ×
                </button>
              </div>
            {:else if selectedInstrument}
              <div class="active-chip">
                <button
                  class="active-chip-main"
                  type="button"
                  onclick={() => togglePopover('instrument')}
                >
                  <SymbolIcon symbol={selectedInstrument} size={16} />
                  <span>{selectedInstrument}</span>
                </button>
                <span class="chip-sep" aria-hidden="true"></span>
                <button
                  class="active-chip-x"
                  type="button"
                  aria-label="Remove instrument filter"
                  onclick={() => (selectedInstrument = null)}
                >
                  ×
                </button>
              </div>
            {:else}
              <button
                class="filter-pill"
                class:open={openPopover === 'instrument'}
                type="button"
                onclick={() => togglePopover('instrument')}
              >
                <span>Instrument</span>
                <svg class="pill-chev" class:open={openPopover === 'instrument'} viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" />
                </svg>
              </button>
            {/if}

            {#if openPopover === 'instrument'}
              <div class="nf-popover inst-pop">
                <div class="pop-title">Instrument</div>
                <input
                  class="pop-search"
                  type="text"
                  placeholder="Search symbol (e.g. XAUUSD, USOIL)…"
                  bind:value={popoverSearch}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' && popoverSearch.trim()) {
                      selectInstrumentFilter(popoverSearch.trim());
                    }
                  }}
                />
                <div class="pop-list">
                  <button
                    class="pop-row"
                    class:active={followChart}
                    type="button"
                    onclick={() => {
                      followChart = true;
                      selectedInstrument = null;
                      selectedWatchlistId = null;
                      openPopover = null;
                    }}
                  >
                    <SymbolIcon symbol={activeSymbol || 'XAUUSD'} size={16} />
                    <span class="pop-row-main">Same as chart ({activeSymbol || 'XAUUSD'})</span>
                  </button>
                  <div class="pop-div"></div>
                  {#each filteredInstruments as entry (entry.symbol)}
                    <button
                      class="pop-row"
                      class:active={!followChart && selectedInstrument === entry.shortName}
                      type="button"
                      onclick={() => selectInstrumentFilter(entry.shortName)}
                    >
                      <SymbolIcon symbol={entry.shortName} size={16} />
                      <span class="pop-row-main">{entry.shortName}</span>
                      <span class="pop-row-meta">{entry.description}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>

          <!-- Active extra filter chips -->
          {#if selectedMarket}
            <div class="active-chip">
              <span class="active-chip-static">{optionLabel(MARKET_OPTIONS, selectedMarket)}</span>
              <span class="chip-sep" aria-hidden="true"></span>
              <button
                class="active-chip-x"
                type="button"
                aria-label="Remove market filter"
                onclick={() => (selectedMarket = null)}
              >
                ×
              </button>
            </div>
          {/if}

          {#if selectedTopic}
            <div class="active-chip">
              <span class="active-chip-static">{optionLabel(TOPIC_OPTIONS, selectedTopic)}</span>
              <span class="chip-sep" aria-hidden="true"></span>
              <button
                class="active-chip-x"
                type="button"
                aria-label="Remove topic filter"
                onclick={() => (selectedTopic = null)}
              >
                ×
              </button>
            </div>
          {/if}

          {#if selectedCountry}
            <div class="active-chip">
              <span class="active-chip-static">{optionLabel(COUNTRY_OPTIONS, selectedCountry)}</span>
              <span class="chip-sep" aria-hidden="true"></span>
              <button
                class="active-chip-x"
                type="button"
                aria-label="Remove country filter"
                onclick={() => (selectedCountry = null)}
              >
                ×
              </button>
            </div>
          {/if}

          {#if selectedProvider}
            <div class="active-chip">
              <span class="active-chip-static">{optionLabel(PROVIDER_OPTIONS, selectedProvider)}</span>
              <span class="chip-sep" aria-hidden="true"></span>
              <button
                class="active-chip-x"
                type="button"
                aria-label="Remove provider filter"
                onclick={() => (selectedProvider = null)}
              >
                ×
              </button>
            </div>
          {/if}

          <!-- + Add filter -->
          <div class="pop-anchor" data-nf-popover="true">
            <button
              class="filter-pill add-filter-pill"
              class:open={openPopover === 'addFilter'}
              type="button"
              title="Add new filter (Alt+Shift+F)"
              onclick={() => togglePopover('addFilter')}
            >
              <svg class="plus-ico" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 2.5v9M2.5 7h9" />
              </svg>
              <span>Add filter</span>
            </button>

            {#if openPopover === 'addFilter'}
              <div class="nf-popover filters-pop">
                {#if addFilterStep === null}
                  <div class="pop-head-row">
                    <span class="pop-title">Filters</span>
                    <span class="pop-shortcut">Alt ⇧ F</span>
                  </div>
                  <input
                    class="pop-search"
                    type="text"
                    placeholder="Search"
                    bind:value={popoverSearch}
                  />
                  <div class="pop-list">
                    {#each filteredCategories as cat (cat.id)}
                      <button
                        class="pop-row"
                        type="button"
                        onclick={() => {
                          if (cat.id === 'watchlist') {
                            openPopover = 'watchlist';
                            popoverSearch = '';
                          } else if (cat.id === 'instrument') {
                            openPopover = 'instrument';
                            popoverSearch = '';
                          } else {
                            addFilterStep = cat.id;
                            popoverSearch = '';
                          }
                        }}
                      >
                        <span class="pop-row-main">{cat.label}</span>
                      </button>
                    {/each}
                  </div>
                {:else}
                  <div class="pop-head-row">
                    <button
                      class="pop-back-btn"
                      type="button"
                      onclick={() => {
                        addFilterStep = null;
                        popoverSearch = '';
                      }}
                    >
                      ‹ {filterCategories.find((c) => c.id === addFilterStep)?.label}
                    </button>
                  </div>
                  <input
                    class="pop-search"
                    type="text"
                    placeholder="Search"
                    bind:value={popoverSearch}
                  />
                  <div class="pop-list">
                    {#each getFilteredCategoryOptions(addFilterStep) as opt (opt.id)}
                      {@const isSelected =
                        (addFilterStep === 'market' && selectedMarket === opt.id) ||
                        (addFilterStep === 'topic' && selectedTopic === opt.id) ||
                        (addFilterStep === 'country' && selectedCountry === opt.id) ||
                        (addFilterStep === 'provider' && selectedProvider === opt.id)}
                      <button
                        class="pop-row"
                        class:active={isSelected}
                        type="button"
                        onclick={() => addFilterStep && applyCategoryOption(addFilterStep, opt.id)}
                      >
                        <span class="pop-row-main">{opt.label}</span>
                        {#if opt.meta}
                          <span class="pop-row-meta">{opt.meta}</span>
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- ••• More menu -->
          <div class="pop-anchor" data-nf-popover="true">
            <button
              class="more-pill"
              class:open={openPopover === 'more'}
              type="button"
              aria-label="Filter options"
              title="More filter options"
              onclick={() => togglePopover('more')}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <circle cx="4.5" cy="9" r="1.25" />
                <circle cx="9" cy="9" r="1.25" />
                <circle cx="13.5" cy="9" r="1.25" />
              </svg>
            </button>

            {#if openPopover === 'more'}
              <div class="nf-popover more-pop">
                <button
                  class="pop-row"
                  type="button"
                  onclick={resetAllFiltersToFullFeed}
                >
                  <span class="pop-row-main">Reset all filters</span>
                </button>
                <button
                  class="pop-row"
                  type="button"
                  disabled={!hasAnyFilter}
                  onclick={resetAllFiltersToFullFeed}
                >
                  <span class="pop-row-main">Remove all filters</span>
                </button>
                <div class="pop-div"></div>
                <button
                  class="pop-row"
                  type="button"
                  disabled={followChart && !selectedMarket && !selectedTopic && !selectedCountry && !selectedProvider}
                  onclick={restoreFollowChart}
                >
                  <span class="pop-row-main">Same as chart ({activeSymbol || 'XAUUSD'})</span>
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if feedNotice}
        <div class="notice-strip">{feedNotice}</div>
      {/if}

      <!-- News Rows List -->
      <div class="news-list">
        {#if loading && items.length === 0}
          {#each [1, 2, 3, 4, 5, 6] as idx (idx)}
            <div class="news-row skeleton-row" aria-hidden="true">
              <div class="sk-meta">
                <span class="sk-dot"></span>
                <span class="sk-bar w45"></span>
              </div>
              <span class="sk-bar w92"></span>
              <span class="sk-bar w68"></span>
            </div>
          {/each}
        {:else if loadError && items.length === 0}
          <div class="empty-state">
            <p class="empty-title">Could not load news</p>
            <p class="empty-sub">{loadError}</p>
            <button class="empty-btn" type="button" onclick={() => void loadFeed(true)}>
              Try again
            </button>
          </div>
        {:else if items.length === 0}
          <div class="empty-state">
            <p class="empty-title">No recent stories match these filters</p>
            <p class="empty-sub">Switch to Full feed or adjust your active filters.</p>
            <button class="empty-btn" type="button" onclick={resetAllFiltersToFullFeed}>
              Show Full feed
            </button>
          </div>
        {:else}
          {#each items as item, idx (item.id)}
            {@const isUnread = !readIdSet.has(item.id) && idx < 3}
            <!-- svelte-ignore a11y_interactive_supports_focus -->
            <div
              class="news-row"
              class:unread={isUnread}
              role="button"
              tabindex="0"
              onclick={() => openArticle(item)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openArticle(item);
                }
              }}
            >
              <div class="row-meta-line">
                {#if item.symbols.length > 0}
                  <div class="badge-stack" aria-hidden="true">
                    {#each item.symbols.slice(0, 4) as sym (sym.symbol)}
                      <span class="badge-ring">
                        <SymbolIcon symbol={sym.shortName} size={17} />
                      </span>
                    {/each}
                  </div>
                {/if}
                <span class="row-meta-text">
                  {formatTimeAgo(item.publishedAt, nowTickMs)} · {item.providerName}
                </span>
                {#if item.displayMode === 'full'}
                  <span class="row-full-tag" title="Full official release available in reader">Full</span>
                {/if}
              </div>

              <div class="row-headline">
                {#if isUnread}
                  <span class="unread-dot" aria-hidden="true"></span>
                {/if}
                <span>{item.title}</span>
              </div>
            </div>
          {/each}

          {#if lastUpdatedAt}
            <div class="feed-footnote">
              Updated {formatTimeAgo(lastUpdatedAt, nowTickMs)}
              {#if feedCached}
                · Cached
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</PanelShell>

<!-- Symbol Chip Hover Card (TradingView-faithful mini chart + See on Supercharts) -->
{#if hoverCard}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="symbol-hover-card"
    class:light={theme === 'light'}
    data-nf-hover-card="true"
    style:left="{hoverCard.left}px"
    style:top="{hoverCard.top}px"
    onmouseenter={cancelCloseHoverCard}
    onmouseleave={scheduleCloseHoverCard}
  >
    <div class="hc-head">
      <SymbolIcon symbol={hoverCard.shortName} size={22} />
      <span class="hc-desc">
        {hoverSparkline?.description || hoverCard.shortName}
      </span>
    </div>

    <div class="hc-price-row">
      <span class="hc-price">
        {hoverSparkline?.price !== null && hoverSparkline?.price !== undefined
          ? formatQuotePrice(hoverSparkline.price, hoverCard.shortName)
          : '—'}
      </span>
      {#if hoverSparkline?.currency}
        <span class="hc-ccy">{hoverSparkline.currency}</span>
      {/if}
      {#if hoverSparkline?.changePercent !== null && hoverSparkline?.changePercent !== undefined}
        <span class="hc-pct" class:up={sparkIsUp} class:down={!sparkIsUp}>
          {formatQuotePct(hoverSparkline.changePercent)}
        </span>
      {/if}
    </div>

    <div class="hc-chart-wrap">
      {#if sparkGeom}
        <svg class="hc-svg" viewBox="0 0 252 64" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="nf-spark-grad-{hoverCard.shortName}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={sparkIsUp ? '#089981' : '#f23645'} stop-opacity="0.28" />
              <stop offset="100%" stop-color={sparkIsUp ? '#089981' : '#f23645'} stop-opacity="0.0" />
            </linearGradient>
          </defs>
          <polygon points={sparkGeom.area} fill="url(#nf-spark-grad-{hoverCard.shortName})" />
          <polyline
            points={sparkGeom.line}
            fill="none"
            stroke={sparkIsUp ? '#089981' : '#f23645'}
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle
            cx={sparkGeom.lastX}
            cy={sparkGeom.lastY}
            r="2.4"
            fill={sparkIsUp ? '#089981' : '#f23645'}
          />
        </svg>
      {:else}
        <div class="hc-chart-placeholder">
          {hoverLoading ? 'Loading chart…' : 'Intraday curve unavailable'}
        </div>
      {/if}
      <div class="hc-period">{hoverSparkline?.periodLabel ?? '1 day'}</div>
    </div>

    <button
      class="hc-supercharts-btn"
      type="button"
      onclick={() => {
        if (!hoverCard) return;
        const targetSym = hoverCard.symbol;
        const targetShort = hoverCard.shortName;
        closeHoverCardImmediate();
        onOpenOnChart(targetSym, targetShort);
      }}
    >
      See on Supercharts
    </button>
  </div>
{/if}

<style>
  .news-panel {
    --nf-bg: var(--dark-bg-panel);
    --nf-surface: var(--dark-bg-surface);
    --nf-surface-alt: var(--dark-bg-surface-alt);
    --nf-elevated: var(--dark-bg-elevated);
    --nf-popover-bg: var(--dark-bg-glass-strong);
    --nf-border: var(--dark-border);
    --nf-border-soft: var(--dark-border-subtle);
    --nf-border-strong: var(--dark-border-strong);
    --nf-text: var(--dark-text-primary);
    --nf-text-strong: var(--dark-text-strong);
    --nf-secondary: var(--dark-text-secondary);
    --nf-hover: var(--dark-hover);
    --nf-hover-strong: var(--dark-hover-strong);
    --nf-chip-active-bg: var(--dark-cta-bg);
    --nf-chip-active-fg: var(--dark-cta-fg);
    --nf-chip-active-sep: rgba(0, 0, 0, 0.22);
    --nf-shadow: var(--dark-shadow-popover);

    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--nf-text);
    background: var(--nf-bg);
    transition: color 150ms ease, background-color 150ms ease;
  }

  .news-panel.light {
    --nf-bg: #ffffff;
    --nf-surface: #f7f8fa;
    --nf-surface-alt: #f2f2f2;
    --nf-elevated: #ffffff;
    --nf-popover-bg: #ffffff;
    --nf-border: #e0e3eb;
    --nf-border-soft: #f0f2f5;
    --nf-border-strong: #d1d4dc;
    --nf-text: #131722;
    --nf-text-strong: #131722;
    --nf-secondary: #6a6d78;
    --nf-hover: rgba(0, 0, 0, 0.035);
    --nf-hover-strong: rgba(0, 0, 0, 0.06);
    --nf-chip-active-bg: #131722;
    --nf-chip-active-fg: #ffffff;
    --nf-chip-active-sep: rgba(255, 255, 255, 0.24);
    --nf-shadow: 0 10px 30px rgba(19, 23, 34, 0.14), 0 1px 4px rgba(19, 23, 34, 0.06);
  }

  /* ==================== FEED HEADER ==================== */
  .feed-header {
    padding: 2px 14px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
    user-select: none;
  }

  .feed-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .feed-header-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .pop-anchor {
    position: relative;
  }

  .feed-title-btn {
    height: 30px;
    padding: 0 4px 0 2px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--nf-text-strong);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 16.5px;
    font-weight: 700;
    letter-spacing: -0.015em;
    cursor: pointer;
    transition: background-color 130ms ease;
  }

  .feed-title-btn:hover {
    background: var(--nf-hover);
  }

  .feed-title-text {
    max-width: 170px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chev {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .save-feed-btn {
    height: 26px;
    padding: 0 7px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #2962ff;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 130ms ease, opacity 130ms ease;
  }

  .save-feed-btn:hover {
    background: rgba(41, 98, 255, 0.1);
  }

  .save-feed-btn.saved {
    color: var(--nf-secondary);
  }

  .save-feed-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .hdr-square-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--nf-border);
    border-radius: 7px;
    background: transparent;
    color: var(--nf-text);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 130ms ease, border-color 130ms ease;
  }

  .hdr-square-btn:hover:not(:disabled) {
    background: var(--nf-hover);
  }

  .hdr-square-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .hdr-square-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .collapse-chev {
    transition: transform 150ms ease;
  }

  .collapse-chev.collapsed {
    transform: rotate(180deg);
  }

  .spin {
    animation: nf-spin 0.85s linear infinite;
  }

  @keyframes nf-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ==================== FILTER BAR ==================== */
  .filter-bar {
    padding: 0 14px 10px;
    border-bottom: 1px solid var(--nf-border-soft);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
    flex: 0 0 auto;
    user-select: none;
  }

  .filter-pill {
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--nf-border);
    border-radius: 8px;
    background: transparent;
    color: var(--nf-secondary);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease, border-color 130ms ease;
  }

  .filter-pill:hover,
  .filter-pill.open {
    color: var(--nf-text);
    background: var(--nf-hover-strong);
  }

  .add-filter-pill {
    color: var(--nf-text);
  }

  .pill-chev {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .pill-chev.open {
    transform: rotate(180deg);
  }

  .plus-ico {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.65;
    stroke-linecap: round;
  }

  .active-chip {
    height: 30px;
    border-radius: 8px;
    background: var(--nf-chip-active-bg);
    color: var(--nf-chip-active-fg);
    display: inline-flex;
    align-items: center;
    overflow: hidden;
  }

  .active-chip-main,
  .active-chip-static {
    height: 100%;
    padding: 0 9px 0 8px;
    border: 0;
    background: transparent;
    color: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
  }

  .active-chip-main {
    cursor: pointer;
  }

  .active-chip-main:hover {
    opacity: 0.88;
  }

  .chip-list-ico {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .chip-sep {
    width: 1px;
    height: 16px;
    background: var(--nf-chip-active-sep);
  }

  .active-chip-x {
    width: 26px;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 15px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    opacity: 0.82;
  }

  .active-chip-x:hover {
    opacity: 1;
  }

  .more-pill {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--nf-text);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 130ms ease;
  }

  .more-pill:hover,
  .more-pill.open {
    background: var(--nf-hover-strong);
  }

  .more-pill svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  /* ==================== POPOVERS ==================== */
  .nf-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    min-width: 204px;
    max-width: 268px;
    padding: 8px;
    border-radius: 11px;
    border: 1px solid var(--nf-border);
    background: var(--nf-popover-bg);
    box-shadow: var(--nf-shadow);
    -webkit-backdrop-filter: blur(20px) saturate(135%);
    backdrop-filter: blur(20px) saturate(135%);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .more-pop,
  .filters-pop {
    left: auto;
    right: 0;
  }

  .filters-pop {
    width: 236px;
  }

  .wl-pop,
  .inst-pop {
    width: 244px;
  }

  .feeds-pop,
  .save-pop {
    width: 246px;
  }

  .pop-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 2px 0;
  }

  .pop-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--nf-text-strong);
    padding: 2px 2px 0;
  }

  .pop-shortcut {
    font-size: 11px;
    color: var(--nf-secondary);
  }

  .pop-section-lbl {
    padding: 2px 6px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--nf-secondary);
  }

  .pop-back-btn {
    border: 0;
    padding: 2px 4px;
    border-radius: 5px;
    background: transparent;
    color: var(--nf-text-strong);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }

  .pop-back-btn:hover {
    background: var(--nf-hover);
  }

  .pop-search {
    width: 100%;
    height: 31px;
    padding: 0 9px;
    border: 1px solid var(--nf-border);
    border-radius: 7px;
    background: var(--nf-bg);
    color: var(--nf-text);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }

  .pop-search:focus {
    border-color: #2962ff;
  }

  .pop-search.compact {
    height: 27px;
    font-size: 12px;
  }

  .pop-list {
    max-height: 224px;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .pop-list::-webkit-scrollbar {
    display: none;
  }

  .pop-row {
    width: 100%;
    min-height: 32px;
    padding: 5px 8px;
    border: 1.5px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--nf-text);
    display: flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background-color 110ms ease, border-color 110ms ease;
  }

  .pop-row:hover:not(:disabled) {
    background: var(--nf-hover-strong);
  }

  .pop-row.active {
    border-color: #2962ff;
    background: var(--nf-hover);
    font-weight: 600;
  }

  .pop-row:disabled {
    opacity: 0.42;
    cursor: default;
  }

  .pop-row-main {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pop-row-meta {
    font-size: 11px;
    color: var(--nf-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 108px;
  }

  .pop-globe-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1.5px solid var(--nf-secondary);
    display: inline-block;
    flex: 0 0 16px;
  }

  .pop-div {
    height: 1px;
    margin: 2px 0;
    background: var(--nf-border-soft);
  }

  .saved-feed-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    border-radius: 7px;
  }

  .saved-feed-row:hover,
  .saved-feed-row.active {
    background: var(--nf-hover);
  }

  .saved-feed-btn {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--nf-text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .saved-feed-row.active .saved-feed-btn {
    font-weight: 600;
  }

  .saved-act {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--nf-secondary);
    display: grid;
    place-items: center;
    font-size: 14px;
    cursor: pointer;
  }

  .saved-act:hover {
    color: var(--nf-text);
    background: var(--nf-hover-strong);
  }

  .saved-act.del:hover {
    color: #f23645;
  }

  .saved-act svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .inline-rename {
    flex: 1;
    height: 26px;
    padding: 0 6px;
    border: 1px solid #2962ff;
    border-radius: 5px;
    background: var(--nf-bg);
    color: var(--nf-text);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }

  .pop-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 2px;
  }

  .pop-title-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nf-text-muted);
  }

  .wl-new-toggle {
    border: 0;
    background: transparent;
    color: #2962ff;
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    padding: 1px 4px;
    border-radius: 4px;
  }

  .wl-new-toggle:hover {
    background: rgba(41, 98, 255, 0.1);
  }

  .pop-row-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .pop-row-wrap .pop-row {
    flex: 1;
    min-width: 0;
  }

  .pop-row-del {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--nf-text-muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: grid;
    place-items: center;
  }

  .pop-row-del:hover {
    color: #f23645;
    background: var(--nf-hover);
  }

  .wl-sym-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 0;
  }

  .wl-sym-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--nf-surface);
    border: 1px solid var(--nf-border);
    font-size: 11px;
    font-weight: 600;
    color: var(--nf-text-primary);
  }

  .wl-sym-chip button {
    border: 0;
    background: transparent;
    color: var(--nf-text-muted);
    font-size: 12px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }

  .wl-sym-chip button:hover {
    color: #f23645;
  }

  .wl-quick-add {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .save-pop-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }

  .pop-btn-ghost,
  .pop-btn-primary {
    height: 28px;
    padding: 0 11px;
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .pop-btn-primary.compact {
    height: 27px;
    padding: 0 9px;
  }

  .pop-btn-ghost {
    border: 1px solid var(--nf-border);
    background: transparent;
    color: var(--nf-text);
  }

  .pop-btn-ghost:hover {
    background: var(--nf-hover);
  }

  .pop-btn-primary {
    border: 0;
    background: #2962ff;
    color: #ffffff;
  }

  .pop-btn-primary:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* ==================== NEWS LIST ==================== */
  .notice-strip {
    margin: 8px 14px 0;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid var(--nf-border);
    background: var(--nf-surface);
    font-size: 11.5px;
    color: var(--nf-secondary);
    line-height: 1.4;
  }

  .news-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .news-list::-webkit-scrollbar {
    display: none;
  }

  .news-row {
    padding: 12px 16px;
    border-bottom: 1px solid var(--nf-border-soft);
    display: flex;
    flex-direction: column;
    gap: 7px;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .news-row:hover {
    background: var(--nf-hover);
  }

  .news-row.skeleton-row {
    cursor: default;
  }

  .row-meta-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .badge-stack {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
  }

  .badge-ring {
    display: inline-flex;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px var(--nf-bg);
  }

  .badge-ring + .badge-ring {
    margin-left: -5px;
  }

  .row-meta-text {
    font-size: 12px;
    color: var(--nf-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-full-tag {
    margin-left: auto;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--nf-secondary);
    background: var(--nf-surface-alt);
    flex: 0 0 auto;
  }

  .row-headline {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    font-size: 13.5px;
    font-weight: 400;
    line-height: 1.4;
    color: var(--nf-text-strong);
  }

  .unread-dot {
    width: 5px;
    height: 5px;
    margin-top: 7px;
    border-radius: 50%;
    background: var(--nf-secondary);
    flex: 0 0 5px;
  }

  .feed-footnote {
    padding: 14px 16px 22px;
    text-align: center;
    font-size: 11px;
    color: var(--nf-secondary);
  }

  /* Skeleton loading */
  .sk-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .sk-dot {
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--nf-surface-alt);
  }

  .sk-bar,
  .sk-line {
    display: block;
    height: 11px;
    border-radius: 5px;
    background: var(--nf-surface-alt);
  }

  .w45 {
    width: 45%;
  }

  .w68 {
    width: 68%;
  }

  .w72 {
    width: 72%;
  }

  .w84 {
    width: 84%;
  }

  .w92 {
    width: 92%;
  }

  .w96 {
    width: 96%;
  }

  .w100 {
    width: 100%;
  }

  /* Empty / error */
  .empty-state {
    padding: 56px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .empty-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--nf-text-strong);
  }

  .empty-sub {
    margin: 0;
    max-width: 260px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--nf-secondary);
  }

  .empty-btn {
    margin-top: 6px;
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--nf-border);
    border-radius: 8px;
    background: transparent;
    color: var(--nf-text);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .empty-btn:hover {
    background: var(--nf-hover-strong);
  }

  /* ==================== READING MODE ==================== */
  .reader-topbar {
    height: 34px;
    flex: 0 0 34px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }

  .back-btn {
    height: 28px;
    padding: 0 8px 0 2px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--nf-text);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .back-btn:hover {
    background: var(--nf-hover);
  }

  .back-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .policy-pill.full {
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    background: rgba(8, 153, 129, 0.14);
    color: #089981;
  }

  .reader-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    padding: 12px 18px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .reader-scroll::-webkit-scrollbar {
    display: none;
  }

  .masthead {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .reuters-mark {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
  }

  .masthead-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: 0 0 9px;
  }

  .masthead-wordmark {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.01em;
    color: var(--brand-color, var(--nf-text-strong));
  }

  .masthead-wordmark.reuters {
    font-size: 15px;
    letter-spacing: 0.06em;
    color: var(--nf-text-strong);
  }

  .reader-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    line-height: 1.28;
    letter-spacing: -0.018em;
    color: var(--nf-text-strong);
  }

  .reader-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .reader-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    font-size: 12px;
    color: var(--nf-secondary);
    line-height: 1.4;
  }

  .meta-dot {
    opacity: 0.7;
  }

  .reader-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .reader-icon-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--nf-border);
    border-radius: 8px;
    background: transparent;
    color: var(--nf-text);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
  }

  .reader-icon-btn:hover {
    background: var(--nf-hover-strong);
  }

  .reader-icon-btn.done {
    border-color: rgba(8, 153, 129, 0.5);
    color: #089981;
  }

  .reader-icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Symbol chips row in Reading Mode */
  .reader-chips {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .sym-chip {
    height: 30px;
    padding: 0 10px 0 7px;
    border: 1px solid var(--nf-border-soft);
    border-radius: 999px;
    background: var(--nf-surface-alt);
    color: var(--nf-text-strong);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 130ms ease, background-color 130ms ease;
  }

  .sym-chip:hover {
    border-color: var(--nf-border-strong);
  }

  .sym-chip-name {
    letter-spacing: 0.01em;
  }

  .sym-chip-pct {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--nf-secondary);
  }

  .sym-chip-pct.up {
    color: #089981;
  }

  .sym-chip-pct.down {
    color: #f23645;
  }

  /* Article body */
  .reader-body {
    display: flex;
    flex-direction: column;
    gap: 13px;
    font-size: 14px;
    line-height: 1.62;
    color: var(--nf-text);
  }

  .reader-body p {
    margin: 0;
  }

  .snippet-lead {
    font-size: 14px;
    line-height: 1.64;
  }

  .body-skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 6px 0;
  }

  .source-footer-card {
    margin-top: 6px;
    padding: 13px 14px;
    border-radius: 10px;
    border: 1px solid var(--nf-border);
    background: var(--nf-surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .source-terms-note {
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--nf-secondary);
  }

  .source-link-btn {
    height: 36px;
    padding: 0 13px;
    border-radius: 8px;
    border: 1px solid var(--nf-border-strong);
    background: transparent;
    color: var(--nf-text-strong);
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: background-color 130ms ease, border-color 130ms ease, opacity 130ms ease;
  }

  .source-link-btn:hover {
    background: var(--nf-hover-strong);
  }

  .source-link-btn.primary {
    border-color: transparent;
    background: var(--nf-chip-active-bg);
    color: var(--nf-chip-active-fg);
  }

  .source-link-btn.primary:hover {
    opacity: 0.9;
    background: var(--nf-chip-active-bg);
  }

  .source-link-btn svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Sticky Reader Footer */
  .reader-footer {
    height: 44px;
    flex: 0 0 44px;
    padding: 0 16px;
    border-top: 1px solid var(--nf-border-soft);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    user-select: none;
  }

  .reader-nav-group {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }

  .reader-nav-btn {
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--nf-text);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 130ms ease, opacity 130ms ease;
  }

  .reader-nav-btn:hover:not(:disabled) {
    background: var(--nf-hover-strong);
  }

  .reader-nav-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .reader-nav-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.65;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ==================== SYMBOL CHIP HOVER CARD ==================== */
  .symbol-hover-card {
    --hc-bg: var(--dark-bg-elevated);
    --hc-border: var(--dark-border-strong);
    --hc-text: var(--dark-text-strong);
    --hc-secondary: var(--dark-text-secondary);
    --hc-hover: var(--dark-hover-strong);
    --hc-btn-border: var(--dark-border-strong);
    --hc-shadow: var(--dark-shadow-modal);

    position: fixed;
    z-index: 190;
    width: 292px;
    padding: 14px 16px 16px;
    border-radius: 12px;
    border: 1px solid var(--hc-border);
    color: var(--hc-text);
    background: var(--hc-bg);
    box-shadow: var(--hc-shadow);
    display: flex;
    flex-direction: column;
    gap: 10px;
    user-select: none;
  }

  .symbol-hover-card.light {
    --hc-bg: #ffffff;
    --hc-border: #e0e3eb;
    --hc-text: #131722;
    --hc-secondary: #6a6d78;
    --hc-hover: rgba(0, 0, 0, 0.04);
    --hc-btn-border: #131722;
    --hc-shadow: 0 12px 36px rgba(19, 23, 34, 0.16), 0 2px 8px rgba(19, 23, 34, 0.08);
  }

  .hc-head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .hc-desc {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--hc-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hc-price-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }

  .hc-price {
    font-size: 15px;
    font-weight: 700;
    color: var(--hc-text);
  }

  .hc-ccy {
    font-size: 11px;
    font-weight: 500;
    color: var(--hc-secondary);
  }

  .hc-pct {
    margin-left: 2px;
    font-size: 13px;
    font-weight: 600;
  }

  .hc-pct.up {
    color: #089981;
  }

  .hc-pct.down {
    color: #f23645;
  }

  .hc-chart-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .hc-svg {
    width: 100%;
    height: 64px;
    display: block;
    overflow: visible;
  }

  .hc-chart-placeholder {
    height: 64px;
    display: grid;
    place-items: center;
    font-size: 11.5px;
    color: var(--hc-secondary);
  }

  .hc-period {
    text-align: right;
    font-size: 11px;
    color: var(--hc-secondary);
  }

  .hc-supercharts-btn {
    width: 100%;
    height: 36px;
    border: 1px solid var(--hc-btn-border);
    border-radius: 8px;
    background: transparent;
    color: var(--hc-text);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 130ms ease;
  }

  .hc-supercharts-btn:hover {
    background: var(--hc-hover);
  }
</style>
