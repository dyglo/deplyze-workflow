<script lang="ts">
  export type ThemeMode = 'system' | 'dark' | 'light';

  interface Props {
    theme: 'dark' | 'light';
    themeMode: ThemeMode;
    canReopenTab: boolean;
    onSelectThemeMode: (mode: ThemeMode) => void;
    onOpenSettings: () => void;
    onAddTab: () => void;
    onReopenClosedTab: () => void;
    onExit: () => void;
  }

  let {
    theme,
    themeMode,
    canReopenTab,
    onSelectThemeMode,
    onOpenSettings,
    onAddTab,
    onReopenClosedTab,
    onExit
  }: Props = $props();

  let menuOpen = $state(false);
  let zoom = $state(100);
  let menuEl: HTMLDivElement | undefined = $state();
  let triggerEl: HTMLButtonElement | undefined = $state();

  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  function closeMenu() {
    menuOpen = false;
  }

  function stepZoom(delta: number) {
    zoom = Math.min(130, Math.max(80, zoom + delta));
  }

  function handleAction(fn: () => void) {
    closeMenu();
    fn();
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!menuOpen) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (menuEl?.contains(target) || triggerEl?.contains(target)) return;
    closeMenu();
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && menuOpen) {
      closeMenu();
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;

    const key = e.key.toLowerCase();
    if (key === ',' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      closeMenu();
      onOpenSettings();
    } else if (key === 't' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      closeMenu();
      onAddTab();
    } else if (key === 't' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (canReopenTab) {
        closeMenu();
        onReopenClosedTab();
      }
    } else if (key === 'q' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      closeMenu();
      onExit();
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<button
  bind:this={triggerEl}
  class="menu-trigger"
  class:light={theme === 'light'}
  class:open={menuOpen}
  type="button"
  aria-label="Application menu"
  title="Menu"
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  onclick={toggleMenu}
>
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="5" cy="10" r="1.45" />
    <circle cx="10" cy="10" r="1.45" />
    <circle cx="15" cy="10" r="1.45" />
  </svg>
</button>

{#if menuOpen}
  <div
    bind:this={menuEl}
    class="app-menu"
    class:light={theme === 'light'}
    role="menu"
    aria-label="Application menu"
  >
    <div class="menu-section">
      <button
        class="menu-row"
        type="button"
        role="menuitem"
        onclick={() => handleAction(onOpenSettings)}
      >
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7.2 4h5.6a1.5 1.5 0 0 1 1.3.75l2.8 4.5a1.5 1.5 0 0 1 0 1.5l-2.8 4.5a1.5 1.5 0 0 1-1.3.75H7.2a1.5 1.5 0 0 1-1.3-.75l-2.8-4.5a1.5 1.5 0 0 1 0-1.5l2.8-4.5A1.5 1.5 0 0 1 7.2 4Z" />
          <circle cx="10" cy="10" r="2.5" />
        </svg>
        <span class="row-label">Settings</span>
        <span class="row-shortcut">Ctrl + ,</span>
      </button>

      <button
        class="menu-row"
        type="button"
        role="menuitem"
        onclick={() => handleAction(onAddTab)}
      >
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 3.75v12.5M3.75 10h12.5" />
        </svg>
        <span class="row-label">New tab</span>
        <span class="row-shortcut">Ctrl + T</span>
      </button>

      <button
        class="menu-row"
        type="button"
        role="menuitem"
        disabled
      >
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.5" y="4" width="15" height="9.25" rx="1.75" />
          <path d="M10 4v9.25M10 13.25v3M7.25 16.25h5.5" />
        </svg>
        <span class="row-label">New window</span>
        <span class="row-shortcut">Ctrl + N</span>
      </button>

      <button
        class="menu-row"
        type="button"
        role="menuitem"
        disabled={!canReopenTab}
        onclick={() => handleAction(onReopenClosedTab)}
      >
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5.25 7.25A5.75 5.75 0 1 1 4.4 11.5" />
          <path d="M5.25 3.75v3.5h3.5" />
        </svg>
        <span class="row-label">Reopen closed tab</span>
        <span class="row-shortcut">Ctrl + Shift + T</span>
      </button>

      <button
        class="menu-row"
        type="button"
        role="menuitem"
        disabled
      >
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8.5 11.5 11.5 8.5M7.25 14.5l-1.5 1.5a2.65 2.65 0 0 1-3.75-3.75l2.5-2.5a2.65 2.65 0 0 1 3.75 0M12.75 5.5l1.5-1.5a2.65 2.65 0 0 1 3.75 3.75l-2.5 2.5a2.65 2.65 0 0 1-3.75 0" />
        </svg>
        <span class="row-label">Open link from clipboard</span>
      </button>
    </div>

    <div class="menu-divider" aria-hidden="true"></div>

    <div class="zoom-row">
      <div class="zoom-left">
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.75 7.25V5a1.25 1.25 0 0 1 1.25-1.25h2.25M12.75 3.75H15A1.25 1.25 0 0 1 16.25 5v2.25M16.25 12.75V15a1.25 1.25 0 0 1-1.25 1.25h-2.25M7.25 16.25H5A1.25 1.25 0 0 1 3.75 15v-2.25" />
        </svg>
        <span class="row-label">Zoom</span>
      </div>

      <div class="zoom-controls">
        <button
          class="zoom-button"
          type="button"
          aria-label="Zoom out"
          disabled={zoom <= 80}
          onclick={() => stepZoom(-10)}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 7h8" />
          </svg>
        </button>

        <button
          class="zoom-value"
          type="button"
          title="Reset zoom"
          onclick={() => (zoom = 100)}
        >
          {zoom}%
        </button>

        <button
          class="zoom-button"
          type="button"
          aria-label="Zoom in"
          disabled={zoom >= 130}
          onclick={() => stepZoom(10)}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 3v8M3 7h8" />
          </svg>
        </button>
      </div>
    </div>

    <div class="menu-divider" aria-hidden="true"></div>

    <div class="theme-grid" role="radiogroup" aria-label="Color theme">
      <button
        class="theme-card-option"
        class:selected={themeMode === 'system'}
        type="button"
        role="radio"
        aria-checked={themeMode === 'system'}
        onclick={() => onSelectThemeMode('system')}
      >
        <span class="theme-preview system" aria-hidden="true">
          <span class="half-dark">
            <span class="mini-frame dark">
              <span class="mini-col dark"></span>
            </span>
          </span>
          <span class="half-light">
            <span class="mini-frame light">
              <span class="mini-col light"></span>
            </span>
          </span>
        </span>
        <span class="theme-name">System</span>
      </button>

      <button
        class="theme-card-option"
        class:selected={themeMode === 'dark'}
        type="button"
        role="radio"
        aria-checked={themeMode === 'dark'}
        onclick={() => onSelectThemeMode('dark')}
      >
        <span class="theme-preview dark" aria-hidden="true">
          <span class="mini-window dark">
            <span class="mini-col dark"></span>
            <span class="mini-col dark"></span>
            <span class="mini-col dark"></span>
          </span>
        </span>
        <span class="theme-name">Dark</span>
      </button>

      <button
        class="theme-card-option"
        class:selected={themeMode === 'light'}
        type="button"
        role="radio"
        aria-checked={themeMode === 'light'}
        onclick={() => onSelectThemeMode('light')}
      >
        <span class="theme-preview light" aria-hidden="true">
          <span class="mini-window light">
            <span class="mini-col light"></span>
            <span class="mini-col light"></span>
            <span class="mini-col light"></span>
          </span>
        </span>
        <span class="theme-name">Light</span>
      </button>
    </div>

    <div class="menu-divider" aria-hidden="true"></div>

    <div class="menu-section exit-section">
      <button
        class="menu-row"
        type="button"
        role="menuitem"
        onclick={() => handleAction(onExit)}
      >
        <svg class="row-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M11.5 6.25V5a1.75 1.75 0 0 0-1.75-1.75h-4.5A1.75 1.75 0 0 0 3.5 5v10a1.75 1.75 0 0 0 1.75 1.75h4.5A1.75 1.75 0 0 0 11.5 15v-1.25" />
          <path d="M8.5 10h8m-2.75-2.75L16.5 10l-2.75 2.75" />
        </svg>
        <span class="row-label">Exit</span>
        <span class="row-shortcut">Ctrl + Shift + Q</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .menu-trigger {
    width: 44px;
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

  .menu-trigger:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }

  .menu-trigger.open {
    background: color-mix(in srgb, currentColor 14%, transparent);
  }

  .menu-trigger:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -4px;
  }

  .menu-trigger svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.25;
  }

  /* Popover */
  .app-menu {
    --am-bg: var(--dark-bg-elevated);
    --am-border: var(--dark-border-strong);
    --am-divider: var(--dark-border-strong);
    --am-text: var(--dark-text-strong);
    --am-secondary: var(--dark-text-secondary);
    --am-hover: var(--dark-bg-elevated-hover);
    --am-btn-bg: var(--dark-bg-elevated-hover);
    --am-btn-hover: var(--dark-border-strong);
    --am-ring: var(--dark-text-strong);
    --am-card-border: #404040;
    --am-shadow: 0 14px 40px rgba(0, 0, 0, 0.65);

    position: fixed;
    top: 36px;
    right: 6px;
    z-index: 180;
    width: 274px;
    padding: 8px 0;
    border: 1px solid var(--am-border);
    border-radius: 10px;
    color: var(--am-text);
    background: var(--am-bg);
    box-shadow: var(--am-shadow);
    user-select: none;
    transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
  }

  .app-menu.light {
    --am-bg: #ffffff;
    --am-border: #e0e3eb;
    --am-divider: #ebebeb;
    --am-text: #131722;
    --am-secondary: #787b86;
    --am-hover: #f2f2f2;
    --am-btn-bg: #f0f2f5;
    --am-btn-hover: #e4e7ec;
    --am-ring: #131722;
    --am-card-border: #d8dbe2;
    --am-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
  }

  .menu-section {
    display: flex;
    flex-direction: column;
    padding: 0 6px;
  }

  .exit-section {
    padding-top: 2px;
  }

  .menu-row {
    width: 100%;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--am-text);
    background: transparent;
    font: inherit;
    font-size: 13.5px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .menu-row:hover:not(:disabled) {
    background: var(--am-hover);
  }

  .menu-row:disabled {
    opacity: 0.42;
    cursor: default;
  }

  .row-icon {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .row-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }

  .row-shortcut {
    font-size: 12px;
    color: var(--am-secondary);
    white-space: nowrap;
  }

  .menu-divider {
    height: 1px;
    margin: 7px 14px;
    background: var(--am-divider);
  }

  /* Zoom row */
  .zoom-row {
    height: 40px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .zoom-left {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13.5px;
  }

  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .zoom-button {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--am-text);
    background: var(--am-btn-bg);
    cursor: pointer;
    transition: background-color 150ms ease, opacity 150ms ease;
  }

  .zoom-button:hover:not(:disabled) {
    background: var(--am-btn-hover);
  }

  .zoom-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .zoom-button svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .zoom-value {
    min-width: 42px;
    height: 28px;
    padding: 0 4px;
    border: 0;
    border-radius: 6px;
    color: var(--am-text);
    background: transparent;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .zoom-value:hover {
    background: var(--am-hover);
  }

  /* Theme cards */
  .theme-grid {
    padding: 8px 16px 6px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }

  .theme-card-option {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--am-text);
    font: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    cursor: pointer;
  }

  .theme-preview {
    width: 100%;
    height: 46px;
    border-radius: 8px;
    border: 1px solid var(--am-card-border);
    overflow: hidden;
    display: flex;
    transition: box-shadow 150ms ease, border-color 150ms ease;
  }

  .theme-card-option.selected .theme-preview {
    border-color: transparent;
    box-shadow:
      0 0 0 2px var(--am-bg),
      0 0 0 3.5px var(--am-ring);
  }

  /* System split preview */
  .theme-preview.system .half-dark,
  .theme-preview.system .half-light {
    width: 50%;
    height: 100%;
    display: flex;
    align-items: flex-end;
  }

  .theme-preview.system .half-dark {
    background: #2e2e2e;
    padding: 7px 0 0 6px;
  }

  .theme-preview.system .half-light {
    background: #ebebeb;
    padding: 7px 6px 0 0;
  }

  .mini-frame {
    width: 100%;
    height: 100%;
    display: flex;
  }

  .mini-frame.dark {
    background: #171717;
    border-top-left-radius: 5px;
    padding: 5px 0 0 5px;
  }

  .mini-frame.light {
    background: #ffffff;
    border-top-right-radius: 5px;
    padding: 5px 5px 0 0;
  }

  /* Dark & Light full previews */
  .theme-preview.dark {
    background: #2e2e2e;
    padding: 7px 6px 0;
  }

  .theme-preview.light {
    background: #ebebeb;
    padding: 7px 6px 0;
  }

  .mini-window {
    width: 100%;
    height: 100%;
    border-radius: 5px 5px 0 0;
    padding: 5px 4px 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
  }

  .mini-window.dark {
    background: #171717;
  }

  .mini-window.light {
    background: #ffffff;
  }

  .mini-col {
    width: 100%;
    height: 100%;
    border-radius: 3px 3px 0 0;
  }

  .mini-col.dark {
    background: #2e2e2e;
  }

  .mini-col.light {
    background: #e6e8ed;
  }

  .theme-name {
    font-size: 12.5px;
    font-weight: 400;
    color: var(--am-text);
  }

  .theme-card-option.selected .theme-name {
    font-weight: 500;
  }

  button:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -2px;
  }
</style>
