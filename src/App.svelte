<script lang="ts">
  import { onMount } from 'svelte';
  import type { ThemeMode } from './lib/AppMenu.svelte';
  import type { ChartQuote } from './lib/Chart.svelte';
  import ChartGrid from './lib/ChartGrid.svelte';
  import Rail from './lib/Rail.svelte';
  import TitleBar from './lib/TitleBar.svelte';
  import {
    evaluateAlertsWithPrice,
    startAlertMonitor,
    subscribeAlertToasts,
    type InAppAlertToast
  } from './lib/alerts/store';
  import { startCloudAutoSync } from './lib/cloud/api';
  import { getLayoutById, saveLayoutId, type LayoutId } from './lib/chart/layouts';
  import {
    loadNotes,
    purgeExpiredDeletedNotes,
    restoreMostRecentDeletedNote
  } from './lib/notes/api';
  import {
    loadChartSettings,
    saveChartSettings,
    type ChartSettings
  } from './lib/settings/chartSettings';
  import {
    DEFAULT_GROUP_ID,
    clonePanes,
    createTab,
    extractShortSymbol,
    getActiveGroup,
    getActiveTab,
    getPaneState,
    hydrateTabsStateFromWorkspace,
    loadTabsState,
    makeId,
    saveTabsState,
    seedTabPanes,
    type TabsState,
    type WorkspaceTab
  } from './lib/tabs/tabs';

  type ResolvedTheme = 'dark' | 'light';
  const storageKey = 'deplyzeworkflow-theme';

  let themeMode: ThemeMode = 'dark';
  let systemPrefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true;

  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'system' || saved === 'light' || saved === 'dark') {
      themeMode = saved;
    }
  }

  let chartSettings: ChartSettings = loadChartSettings();
  let tabsState: TabsState = loadTabsState();
  let settingsOpen = false;
  let closedTabs: WorkspaceTab[] = [];
  let alertToasts: InAppAlertToast[] = [];
  // Transient live quote cache per (tabId, paneIndex) — never persisted to disk
  const paneQuotesByTab: Record<string, Record<number, ChartQuote>> = {};

  $: theme = (
    themeMode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeMode
  ) as ResolvedTheme;
  $: activeGroup = getActiveGroup(tabsState);
  $: activeTab = getActiveTab(tabsState);

  onMount(() => {
    const stopAlerts = startAlertMonitor();
    const stopCloudSync = startCloudAutoSync();

    void hydrateTabsStateFromWorkspace(tabsState).then((restored) => {
      if (restored) {
        tabsState = restored;
      }
    });

    const unsubToasts = subscribeAlertToasts((toast) => {
      pushToast(toast);
    });

    // Purge any notes whose 3-minute undo window has expired
    const runExpiredNotePurge = () => {
      void loadNotes().then((loaded) => purgeExpiredDeletedNotes(loaded));
    };
    runExpiredNotePurge();
    const notePurgeTimer = window.setInterval(runExpiredNotePurge, 60_000);

    // Global Ctrl+Z undo for deleted notes within 3 minutes when Notes panel is closed
    let undoBusy = false;
    const handleGlobalUndoKey = (e: KeyboardEvent) => {
      const isUndo =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
      if (!isUndo || e.defaultPrevented || undoBusy) return;
      if (document.querySelector('[data-notes-panel="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      undoBusy = true;
      void restoreMostRecentDeletedNote()
        .then((restored) => {
          if (restored) {
            pushToast({
              id: `note-undo-${Date.now()}`,
              title: 'Note restored',
              message: `Restored “${restored.title.trim() || 'Untitled note'}” to Notes.`,
              symbol: restored.symbol,
              createdAt: new Date().toISOString()
            });
          }
        })
        .then(
          () => {
            undoBusy = false;
          },
          () => {
            undoBusy = false;
          }
        );
    };
    window.addEventListener('keydown', handleGlobalUndoKey);

    let cleanupMq: (() => void) | undefined;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      systemPrefersDark = mq.matches;
      const onChange = (e: MediaQueryListEvent) => {
        systemPrefersDark = e.matches;
      };
      mq.addEventListener('change', onChange);
      cleanupMq = () => mq.removeEventListener('change', onChange);
    }

    return () => {
      stopAlerts();
      stopCloudSync();
      unsubToasts();
      window.clearInterval(notePurgeTimer);
      window.removeEventListener('keydown', handleGlobalUndoKey);
      cleanupMq?.();
    };
  });

  function pushToast(toast: InAppAlertToast) {
    alertToasts = [toast, ...alertToasts].slice(0, 4);
    setTimeout(() => {
      alertToasts = alertToasts.filter((t) => t.id !== toast.id);
    }, 8000);
  }

  function commitTabs(next: TabsState) {
    tabsState = next;
    saveTabsState(next);
  }

  function selectThemeMode(mode: ThemeMode) {
    themeMode = mode;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, mode);
    }
  }

  function updateChartSettings(next: ChartSettings) {
    chartSettings = next;
    saveChartSettings(next);
  }

  function updateLayout(next: LayoutId) {
    saveLayoutId(next);
    const nextCount = getLayoutById(next).count;
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              tabs: g.tabs.map((t) => {
                if (t.id !== activeTab.id) return t;
                const seeded = seedTabPanes(t, next);
                const curActive = t.activePane ?? 0;
                const nextActivePane = curActive < nextCount ? curActive : 0;
                const activePaneState = seeded[nextActivePane] ?? getPaneState(t, nextActivePane);
                const cachedQuote = paneQuotesByTab[t.id]?.[nextActivePane];
                return {
                  ...t,
                  layoutId: next,
                  panes: seeded,
                  activePane: nextActivePane,
                  symbol: activePaneState.symbol,
                  title: activePaneState.shortName || extractShortSymbol(activePaneState.symbol),
                  quote: cachedQuote
                    ? { price: cachedQuote.price, changePercent: cachedQuote.changePercent }
                    : t.quote
                };
              })
            }
      )
    });
  }

  function selectGroup(groupId: string) {
    if (tabsState.activeGroupId === groupId) return;
    commitTabs({ ...tabsState, activeGroupId: groupId });
  }

  function createGroup(name: string) {
    const firstTab = createTab();
    const newGroup = {
      id: makeId('group'),
      name,
      tabs: [firstTab],
      activeTabId: firstTab.id
    };
    commitTabs({
      groups: [...tabsState.groups, newGroup],
      activeGroupId: newGroup.id
    });
  }

  function deleteGroup(groupId: string) {
    if (groupId === DEFAULT_GROUP_ID) return;
    const remaining = tabsState.groups.filter((g) => g.id !== groupId);
    if (remaining.length === 0) return;
    const nextActiveGroupId =
      tabsState.activeGroupId === groupId ? remaining[0].id : tabsState.activeGroupId;
    commitTabs({
      groups: remaining,
      activeGroupId: nextActiveGroupId
    });
  }

  function selectTab(tabId: string) {
    if (activeGroup.activeTabId === tabId) return;
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id === activeGroup.id ? { ...g, activeTabId: tabId } : g
      )
    });
  }

  function addTab() {
    const newTab = createTab();
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id === activeGroup.id
          ? { ...g, tabs: [...g.tabs, newTab], activeTabId: newTab.id }
          : g
      )
    });
  }

  function closeTab(tabId: string) {
    if (activeGroup.tabs.length <= 1) return;
    const idx = activeGroup.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const closing = activeGroup.tabs[idx];
    closedTabs = [...closedTabs.slice(-9), closing];
    const nextTabs = activeGroup.tabs.filter((t) => t.id !== tabId);
    const nextActive =
      activeGroup.activeTabId === tabId
        ? nextTabs[Math.min(idx, nextTabs.length - 1)].id
        : activeGroup.activeTabId;
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id === activeGroup.id ? { ...g, tabs: nextTabs, activeTabId: nextActive } : g
      )
    });
  }

  function reopenClosedTab() {
    if (closedTabs.length === 0) return;
    const last = closedTabs[closedTabs.length - 1];
    closedTabs = closedTabs.slice(0, -1);
    const restored = createTab({
      title: last.title,
      symbol: last.symbol,
      layoutId: last.layoutId,
      panes: clonePanes(last.panes),
      activePane: last.activePane ?? 0
    });
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id === activeGroup.id
          ? { ...g, tabs: [...g.tabs, restored], activeTabId: restored.id }
          : g
      )
    });
  }

  function renameTab(tabId: string, title: string) {
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id === activeGroup.id
          ? {
              ...g,
              tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, title } : t))
            }
          : g
      )
    });
  }

  function loadSymbolInActiveTab(symbol: string, shortName: string) {
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              tabs: g.tabs.map((t) => {
                if (t.id !== activeTab.id) return t;
                const paneIdx = t.activePane ?? 0;
                const seeded = seedTabPanes(t, t.layoutId);
                const prevPane = seeded[paneIdx];
                seeded[paneIdx] = {
                  symbol,
                  shortName,
                  interval: prevPane?.interval || 'D'
                };
                return {
                  ...t,
                  symbol,
                  title: shortName,
                  panes: seeded,
                  quote: undefined
                };
              })
            }
      )
    });
  }

  function openSymbolInNewTab(symbol: string, shortName: string) {
    const newTab = createTab({ title: shortName, symbol });
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id === activeGroup.id
          ? { ...g, tabs: [...g.tabs, newTab], activeTabId: newTab.id }
          : g
      )
    });
  }

  function focusOrOpenSymbolTab(symbol: string, shortName: string) {
    const targetFull = symbol.trim().toUpperCase();
    const targetShort = (shortName || extractShortSymbol(symbol)).trim().toUpperCase();
    const existing = activeGroup.tabs.find((t) => {
      const tabFull = (t.symbol || '').trim().toUpperCase();
      const tabShort = extractShortSymbol(t.symbol || t.title || '').trim().toUpperCase();
      return tabFull === targetFull || tabShort === targetShort;
    });
    if (existing) {
      selectTab(existing.id);
      return;
    }
    openSymbolInNewTab(symbol, shortName || targetShort);
  }

  function handleActivePaneChange(tabId: string, paneIdx: number) {
    let changed = false;
    const nextGroups = tabsState.groups.map((g) => {
      if (!g.tabs.some((t) => t.id === tabId)) return g;
      return {
        ...g,
        tabs: g.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const seeded = seedTabPanes(t, t.layoutId);
          const count = getLayoutById(t.layoutId).count;
          const clamped = paneIdx >= 0 && paneIdx < count ? paneIdx : 0;
          const paneState = seeded[clamped] ?? getPaneState(t, clamped);
          const nextTitle = paneState.shortName || extractShortSymbol(paneState.symbol);
          const cached = paneQuotesByTab[tabId]?.[clamped];
          if ((t.activePane ?? 0) === clamped && t.symbol === paneState.symbol && t.title === nextTitle) {
            return t;
          }
          changed = true;
          return {
            ...t,
            panes: seeded,
            activePane: clamped,
            symbol: paneState.symbol,
            title: nextTitle,
            quote: cached
              ? { price: cached.price, changePercent: cached.changePercent }
              : undefined
          };
        })
      };
    });

    if (!changed) return;
    commitTabs({ ...tabsState, groups: nextGroups });
  }

  function handlePaneInterval(tabId: string, paneIdx: number, interval: string) {
    let changed = false;
    const nextGroups = tabsState.groups.map((g) => {
      if (!g.tabs.some((t) => t.id === tabId)) return g;
      return {
        ...g,
        tabs: g.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const seeded = seedTabPanes(t, t.layoutId);
          const prev = seeded[paneIdx] ?? getPaneState(t, paneIdx);
          if (prev.interval === interval) return t;
          changed = true;
          seeded[paneIdx] = { ...prev, interval };
          return { ...t, panes: seeded };
        })
      };
    });
    if (!changed) return;
    commitTabs({ ...tabsState, groups: nextGroups });
  }

  function handlePaneQuote(tabId: string, paneIdx: number, quote: ChartQuote) {
    if (Number.isFinite(quote.price)) {
      evaluateAlertsWithPrice(quote.symbol, quote.shortName, quote.price, 'live');
    }

    if (!paneQuotesByTab[tabId]) paneQuotesByTab[tabId] = {};
    paneQuotesByTab[tabId][paneIdx] = quote;

    let changed = false;
    let persistedChanged = false;
    const nextGroups = tabsState.groups.map((g) => {
      if (!g.tabs.some((t) => t.id === tabId)) return g;
      return {
        ...g,
        tabs: g.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const activeIdx = t.activePane ?? 0;
          const existingPane = t.panes?.[paneIdx];
          const paneSymbolChanged =
            !existingPane ||
            existingPane.symbol !== quote.symbol ||
            existingPane.shortName !== quote.shortName ||
            (Boolean(quote.interval) && existingPane.interval !== quote.interval);

          const isActivePane = paneIdx === activeIdx;
          const headerQuoteChanged =
            isActivePane &&
            (t.quote?.price !== quote.price || t.quote?.changePercent !== quote.changePercent);
          const headerSymbolChanged =
            isActivePane && (t.symbol !== quote.symbol || t.title !== quote.shortName);

          if (!paneSymbolChanged && !headerQuoteChanged && !headerSymbolChanged) {
            return t;
          }

          changed = true;
          if (paneSymbolChanged || headerSymbolChanged) {
            persistedChanged = true;
          }

          let nextPanes = t.panes;
          if (paneSymbolChanged) {
            nextPanes = seedTabPanes(t, t.layoutId);
            const prev = nextPanes[paneIdx];
            nextPanes[paneIdx] = {
              symbol: quote.symbol,
              shortName: quote.shortName,
              interval: quote.interval || prev?.interval || 'D'
            };
          }

          if (!isActivePane) {
            return { ...t, panes: nextPanes };
          }

          return {
            ...t,
            title: quote.shortName,
            symbol: quote.symbol,
            panes: nextPanes,
            quote: {
              price: quote.price,
              changePercent: quote.changePercent
            }
          };
        })
      };
    });

    if (!changed) return;
    const nextState: TabsState = { ...tabsState, groups: nextGroups };
    tabsState = nextState;
    if (persistedChanged) {
      saveTabsState(nextState);
    }
  }
</script>

<svelte:head>
  <meta name="theme-color" content={theme === 'dark' ? '#000000' : '#ffffff'} />
</svelte:head>

<main class:light={theme === 'light'}>
  <TitleBar
    {theme}
    {themeMode}
    canReopenTab={closedTabs.length > 0}
    onSelectThemeMode={selectThemeMode}
    onOpenSettings={() => (settingsOpen = true)}
    groups={tabsState.groups}
    {activeGroup}
    onSelectGroup={selectGroup}
    onCreateGroup={createGroup}
    onDeleteGroup={deleteGroup}
    onSelectTab={selectTab}
    onAddTab={addTab}
    onCloseTab={closeTab}
    onReopenClosedTab={reopenClosedTab}
    onRenameTab={renameTab}
  />

  <div class="workspace">
    <div class="chart-slot">
      {#each activeGroup.tabs as tab (tab.id)}
        <div
          class="tab-viewport"
          class:active={tab.id === activeTab.id}
          aria-hidden={tab.id !== activeTab.id}
        >
          <ChartGrid
            {theme}
            settings={chartSettings}
            layoutId={tab.layoutId}
            tabId={tab.id}
            symbol={tab.symbol}
            panes={tab.panes}
            activePane={tab.activePane ?? 0}
            onActivePaneChange={(idx) => handleActivePaneChange(tab.id, idx)}
            onPaneQuote={(idx, q) => handlePaneQuote(tab.id, idx, q)}
            onPaneInterval={(idx, ivl) => handlePaneInterval(tab.id, idx, ivl)}
          />
        </div>
      {/each}
    </div>

    <Rail
      {theme}
      {chartSettings}
      layoutId={activeTab.layoutId}
      activeSymbol={activeTab.title}
      activeFullSymbol={activeTab.symbol}
      activePrice={activeTab.quote?.price}
      activeChangePercent={activeTab.quote?.changePercent}
      {settingsOpen}
      onToggleSettings={() => (settingsOpen = !settingsOpen)}
      onCloseSettings={() => (settingsOpen = false)}
      onSaveChartSettings={updateChartSettings}
      onSelectLayout={updateLayout}
      onSelectSymbol={loadSymbolInActiveTab}
      onOpenSymbolInNewTab={openSymbolInNewTab}
      onOpenOnChart={focusOrOpenSymbolTab}
    />
  </div>

  {#if alertToasts.length > 0}
    <div class="alert-toast-stack" aria-live="polite">
      {#each alertToasts as toast (toast.id)}
        <div class="alert-toast" class:light={theme === 'light'}>
          <div class="toast-head">
            <strong>{toast.title}</strong>
            <button
              type="button"
              aria-label="Dismiss alert"
              on:click={() => (alertToasts = alertToasts.filter((t) => t.id !== toast.id))}
            >
              ×
            </button>
          </div>
          <div class="toast-body">{toast.message}</div>
        </div>
      {/each}
    </div>
  {/if}
</main>

<style>
  main {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    color: var(--dark-text-strong);
    background: var(--dark-bg-base);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    transition: color 150ms ease, background-color 150ms ease;
  }

  main.light {
    color: #111111;
    background: #ffffff;
  }

  .workspace {
    width: 100%;
    height: calc(100vh - 34px);
    display: flex;
    gap: 4px;
    background: var(--dark-bg-gutter);
    transition: background-color 150ms ease;
  }

  main.light .workspace {
    background: #ebebeb;
  }

  .chart-slot {
    position: relative;
    flex: 1;
    min-width: 480px;
    height: 100%;
    overflow: hidden;
    background: var(--dark-bg-base);
    transition: background-color 150ms ease;
  }

  main.light .chart-slot {
    background: #ffffff;
  }

  .tab-viewport {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
    z-index: 0;
  }

  .tab-viewport.active {
    visibility: visible;
    pointer-events: auto;
    z-index: 1;
  }

  .chart-slot :global(.chart-shell) {
    width: 100%;
    height: 100%;
  }

  .alert-toast-stack {
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 150;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 340px;
  }

  .alert-toast {
    padding: 11px 13px;
    border-radius: 10px;
    color: var(--dark-text-strong);
    background: var(--dark-bg-toast);
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--dark-border-glass);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .alert-toast.light {
    color: #131722;
    background: #ffffff;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16), 0 0 0 1px #e0e3eb;
  }

  .toast-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12.5px;
  }

  .toast-head button {
    border: 0;
    background: transparent;
    color: inherit;
    opacity: 0.65;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }

  .toast-head button:hover {
    opacity: 1;
  }

  .toast-body {
    font-size: 12px;
    opacity: 0.85;
    line-height: 1.4;
  }
</style>
