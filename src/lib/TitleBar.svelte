<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import AppMenu, { type ThemeMode } from './AppMenu.svelte';
  import TabBar from './tabs/TabBar.svelte';
  import type { TabGroup } from './tabs/tabs';

  export let theme: 'dark' | 'light';
  export let themeMode: ThemeMode;
  export let canReopenTab: boolean;
  export let onSelectThemeMode: (mode: ThemeMode) => void;
  export let onOpenSettings: () => void;
  export let groups: TabGroup[];
  export let activeGroup: TabGroup;
  export let onSelectGroup: (groupId: string) => void;
  export let onCreateGroup: (name: string) => void;
  export let onDeleteGroup: (groupId: string) => void;
  export let onSelectTab: (tabId: string) => void;
  export let onAddTab: () => void;
  export let onCloseTab: (tabId: string) => void;
  export let onReopenClosedTab: () => void;
  export let onRenameTab: (tabId: string, title: string) => void;

  const window = getCurrentWindow();

  function minimize() {
    void window.minimize();
  }

  function toggleMaximize() {
    void window.toggleMaximize();
  }

  function close() {
    void window.close();
  }
</script>

<header class="title-bar" class:light={theme === 'light'}>
  <div class="tabs-slot">
    <TabBar
      {theme}
      {groups}
      {activeGroup}
      {onSelectGroup}
      {onCreateGroup}
      {onDeleteGroup}
      {onSelectTab}
      {onAddTab}
      {onCloseTab}
      {onRenameTab}
    />
  </div>

  <div
    class="drag-region"
    data-tauri-drag-region
    role="presentation"
    on:dblclick={toggleMaximize}
  ></div>

  <div class="window-controls">
    <AppMenu
      {theme}
      {themeMode}
      {canReopenTab}
      {onSelectThemeMode}
      {onOpenSettings}
      {onAddTab}
      {onReopenClosedTab}
      onExit={close}
    />

    <button class="window-button" type="button" aria-label="Minimize window" on:click={minimize}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 6h8" />
      </svg>
    </button>

    <button class="window-button" type="button" aria-label="Toggle maximize" on:click={toggleMaximize}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <rect x="2.25" y="2.25" width="7.5" height="7.5" />
      </svg>
    </button>

    <button class="window-button close-button" type="button" aria-label="Close window" on:click={close}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="m2.25 2.25 7.5 7.5M9.75 2.25l-7.5 7.5" />
      </svg>
    </button>
  </div>
</header>

<style>
  .title-bar {
    width: 100vw;
    height: 34px;
    flex: 0 0 34px;
    display: flex;
    align-items: center;
    color: var(--dark-text-strong);
    background: var(--dark-bg-chrome);
    user-select: none;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .title-bar.light {
    color: #131722;
    background: #e7e9ee;
  }

  .tabs-slot {
    height: 100%;
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .drag-region {
    height: 100%;
    flex: 1 0 36px;
    cursor: default;
  }

  .window-controls {
    height: 100%;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .window-button {
    width: 46px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .window-button:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }

  .window-button:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -4px;
  }

  .window-button.close-button:hover {
    color: #ffffff;
    background: #c42b2b;
  }

  .window-button svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: square;
    vector-effect: non-scaling-stroke;
  }
</style>
