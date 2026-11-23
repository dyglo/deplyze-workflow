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
  import { saveLayoutId, type LayoutId } from './lib/chart/layouts';
  import {
    loadChartSettings,
    saveChartSettings,
    type ChartSettings
  } from './lib/settings/chartSettings';
  import {
    DEFAULT_GROUP_ID,
    createTab,
    getActiveGroup,
    getActiveTab,
    loadTabsState,
    makeId,
    saveTabsState,
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

  $: theme = (
    themeMode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeMode
  ) as ResolvedTheme;
  $: activeGroup = getActiveGroup(tabsState);
  $: activeTab = getActiveTab(tabsState);

  onMount(() => {
    const stopAlerts = startAlertMonitor();
    const unsubToasts = subscribeAlertToasts((toast) => {
      alertToasts = [toast, ...alertToasts].slice(0, 4);
      setTimeout(() => {
        alertToasts = alertToasts.filter((t) => t.id !== toast.id);
      }, 8000);
    });

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
      unsubToasts();
      cleanupMq?.();
    };
  });

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
    commitTabs({
      ...tabsState,
      groups: tabsState.groups.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              tabs: g.tabs.map((t) => (t.id === activeTab.id ? { ...t, layoutId: next } : t))
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
      layoutId: last.layoutId
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
              tabs: g.tabs.map((t) =>
                t.id !== activeTab.id
                  ? t
                  : { ...t, symbol, title: shortName, quote: undefined }
              )
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

  function handleTabQuote(tabId: string, quote: ChartQuote) {
    if (Number.isFinite(quote.price)) {
      evaluateAlertsWithPrice(quote.symbol, quote.shortName, quote.price);
    }
    let symbolChanged = false;
    const nextGroups = tabsState.groups.map((g) => {
      if (!g.tabs.some((t) => t.id === tabId)) return g;
      return {
        ...g,
        tabs: g.tabs.map((t) => {
          if (t.id !== tabId) return t;
          if (t.symbol !== quote.symbol || t.title !== quote.shortName) {
            symbolChanged = true;
          }
          return {
            ...t,
            title: quote.shortName,
            symbol: quote.symbol,
            quote: {
              price: quote.price,
              changePercent: quote.changePercent
            }
          };
        })
      };
    });

    const nextState: TabsState = { ...tabsState, groups: nextGroups };
    tabsState = nextState;
    if (symbolChanged) {
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
            onActiveQuote={(q) => handleTabQuote(tab.id, q)}
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
    color: #f5f5f5;
    background: #000000;
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
    background: #1f1f1f;
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
    background: #000000;
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
    color: #f0f0f0;
    background: rgba(18, 18, 18, 0.9);
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12);
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
