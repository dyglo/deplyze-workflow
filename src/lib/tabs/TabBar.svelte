<script lang="ts">
  import CreateGroupModal from './CreateGroupModal.svelte';
  import { getLayoutById } from '../chart/layouts';
  import type { TabGroup, WorkspaceTab } from './tabs';

  interface Props {
    theme: 'dark' | 'light';
    groups: TabGroup[];
    activeGroup: TabGroup;
    onSelectGroup: (groupId: string) => void;
    onCreateGroup: (name: string) => void;
    onDeleteGroup: (groupId: string) => void;
    onSelectTab: (tabId: string) => void;
    onAddTab: () => void;
    onCloseTab: (tabId: string) => void;
    onRenameTab: (tabId: string, title: string) => void;
  }

  let {
    theme,
    groups,
    activeGroup,
    onSelectGroup,
    onCreateGroup,
    onDeleteGroup,
    onSelectTab,
    onAddTab,
    onCloseTab,
    onRenameTab
  }: Props = $props();

  let dropdownAnchor = $state<DOMRect | null>(null);
  let createModalOpen = $state(false);
  let editingTabId = $state<string | null>(null);
  let editingValue = $state('');

  let dropdownEl: HTMLDivElement | undefined = $state();
  let renameInputEl: HTMLInputElement | undefined = $state();

  const dropdownOpen = $derived(Boolean(dropdownAnchor));

  $effect(() => {
    if (editingTabId && renameInputEl) {
      renameInputEl.focus();
      renameInputEl.select();
    }
  });

  function toggleDropdown(e: MouseEvent) {
    if (dropdownAnchor) {
      dropdownAnchor = null;
      return;
    }
    dropdownAnchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
  }

  function handleSelectGroup(groupId: string) {
    dropdownAnchor = null;
    onSelectGroup(groupId);
  }

  function openCreateGroupModal() {
    dropdownAnchor = null;
    createModalOpen = true;
  }

  function startRename(tab: WorkspaceTab) {
    editingTabId = tab.id;
    editingValue = tab.title;
  }

  function commitRename() {
    if (!editingTabId) return;
    const next = editingValue.trim();
    if (next) {
      onRenameTab(editingTabId, next);
    }
    editingTabId = null;
  }

  function cancelRename() {
    editingTabId = null;
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!dropdownAnchor) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (dropdownEl?.contains(target)) return;
    if (target.closest('[data-group-trigger="true"]')) return;
    dropdownAnchor = null;
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && dropdownAnchor) {
      dropdownAnchor = null;
    }
  }

  type EmblemKind = 'gold' | 'oil' | 'btc' | 'monogram';

  function getEmblemKind(tab: WorkspaceTab): EmblemKind {
    const key = `${tab.title} ${tab.symbol}`.toUpperCase();
    if (key.includes('XAU') || key.includes('GOLD')) return 'gold';
    if (
      key.includes('OIL') ||
      key.includes('WTI') ||
      key.includes('BRENT') ||
      key.includes('CRUDE') ||
      key.includes('UKOIL')
    ) {
      return 'oil';
    }
    if (key.includes('BTC')) return 'btc';
    return 'monogram';
  }

  function badgeColor(title: string): string {
    const palette = ['#2962ff', '#089981', '#f23645', '#ff9800', '#9c27b0', '#00bcd4'];
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
    }
    return palette[hash % palette.length];
  }

  function formatPrice(price: number): string {
    if (!Number.isFinite(price)) return '';
    const abs = Math.abs(price);
    const maxFrac = abs >= 1000 ? 3 : abs >= 10 ? 2 : abs >= 1 ? 4 : 5;
    return price.toLocaleString('en-US', {
      minimumFractionDigits: Math.min(2, maxFrac),
      maximumFractionDigits: maxFrac
    });
  }

  function formatPercent(pct: number): string {
    if (!Number.isFinite(pct)) return '';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
  }

  function layoutSuffix(tab: WorkspaceTab): string {
    const def = getLayoutById(tab.layoutId);
    return def.count > 1 ? `/ ${def.count}x` : '';
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<div class="tab-bar" class:light={theme === 'light'}>
  <!-- Group trigger button -->
  <button
    class="group-button"
    class:open={dropdownOpen}
    class:named={!activeGroup.isDefault}
    type="button"
    data-group-trigger="true"
    aria-label="Tab groups"
    title={activeGroup.name}
    aria-haspopup="menu"
    aria-expanded={dropdownOpen}
    onclick={toggleDropdown}
  >
    {#if activeGroup.isDefault}
      <svg class="tabs-stack-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.25 2.5h7.5" />
        <rect x="2.25" y="4.75" width="11.5" height="8.75" rx="1.75" />
        <path d="M2.25 7.5h11.5" />
      </svg>
    {:else}
      <span class="group-name">{activeGroup.name}</span>
    {/if}

    <svg class="chevron-icon" class:flipped={dropdownOpen} viewBox="0 0 12 12" aria-hidden="true">
      <path d="m2.75 4.5 3.25 3.25L9.25 4.5" />
    </svg>
  </button>

  <!-- Tabs strip -->
  <div class="tabs-strip" role="tablist" aria-label="Workspace tabs">
    {#each activeGroup.tabs as tab, index (tab.id)}
      {@const isActive = tab.id === activeGroup.activeTabId}
      {@const nextIsActive = activeGroup.tabs[index + 1]?.id === activeGroup.activeTabId}
      {@const showClose = activeGroup.tabs.length > 1}
      {@const emblem = getEmblemKind(tab)}
      {@const suffix = layoutSuffix(tab)}
      {@const q = tab.quote}
      {@const isUp = q ? q.changePercent >= 0 : true}

      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div
        class="tab"
        class:active={isActive}
        class:hide-sep={isActive || nextIsActive || index === activeGroup.tabs.length - 1}
        role="tab"
        aria-selected={isActive}
        tabindex={isActive ? 0 : -1}
        title="{tab.title} (double-click to rename)"
        onclick={() => onSelectTab(tab.id)}
        ondblclick={() => startRename(tab)}
        onauxclick={(e) => {
          if (e.button === 1 && showClose) {
            e.preventDefault();
            onCloseTab(tab.id);
          }
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectTab(tab.id);
          }
        }}
      >
        {#if emblem === 'gold'}
          <svg class="tab-emblem" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="8.5" fill="#e5a900" />
            <path
              d="M7.2 6h3.6l.5 1.9H6.7L7.2 6ZM4.8 9.1h3.65l.5 1.95H4.3l.5-1.95Zm4.7 0h3.65l.5 1.95H9l.5-1.95Z"
              fill="#ffffff"
            />
          </svg>
        {:else if emblem === 'oil'}
          <svg class="tab-emblem" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="8.5" fill="#181c26" />
            <path
              d="M9 4.25c1.75 2.45 3.25 4.4 3.25 6.1a3.25 3.25 0 1 1-6.5 0c0-1.7 1.5-3.65 3.25-6.1Z"
              fill="#ffffff"
            />
          </svg>
        {:else if emblem === 'btc'}
          <svg class="tab-emblem" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="8.5" fill="#f7931a" />
            <text
              x="9"
              y="12.6"
              text-anchor="middle"
              fill="#ffffff"
              font-size="10.5"
              font-weight="700"
              font-family="Inter, system-ui, sans-serif"
            >
              ₿
            </text>
          </svg>
        {:else}
          <span
            class="tab-emblem monogram"
            style:background={badgeColor(tab.title)}
            aria-hidden="true"
          >
            {tab.title.slice(0, 1).toUpperCase()}
          </span>
        {/if}

        {#if editingTabId === tab.id}
          <input
            bind:this={renameInputEl}
            class="rename-input"
            type="text"
            maxlength={28}
            bind:value={editingValue}
            onclick={(e) => e.stopPropagation()}
            ondblclick={(e) => e.stopPropagation()}
            onblur={commitRename}
            onkeydown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
          />
        {:else}
          <span class="tab-label">
            <span class="tab-title">{tab.title}</span>
            {#if q && Number.isFinite(q.price)}
              <span class="quote-arrow" class:up={isUp} class:down={!isUp} aria-hidden="true">
                {isUp ? '▲' : '▼'}
              </span>
              <span class="quote-price">{formatPrice(q.price)}</span>
              <span class="quote-pct" class:up={isUp} class:down={!isUp}>
                {formatPercent(q.changePercent)}
              </span>
            {/if}
            {#if suffix}
              <span class="tab-meta">{suffix}</span>
            {/if}
          </span>
        {/if}

        {#if showClose}
          <button
            class="tab-close"
            type="button"
            aria-label="Close {tab.title}"
            onclick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 3 6 6m0-6-6 6" />
            </svg>
          </button>
        {/if}
      </div>
    {/each}
  </div>

  <!-- New tab "+" button -->
  <button
    class="add-tab-button"
    type="button"
    aria-label="New tab"
    title="New tab"
    onclick={onAddTab}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  </button>
</div>

<!-- Group dropdown -->
{#if dropdownAnchor}
  <div
    bind:this={dropdownEl}
    class="group-dropdown"
    class:light={theme === 'light'}
    style:left="{Math.round(dropdownAnchor.left)}px"
    style:top="{Math.round(dropdownAnchor.bottom + 4)}px"
    role="menu"
    aria-label="Tab groups"
  >
    {#each groups as group (group.id)}
      {@const isCurrent = group.id === activeGroup.id}
      <div class="group-item-row" class:active={isCurrent}>
        <button
          class="group-item"
          class:active={isCurrent}
          type="button"
          role="menuitemradio"
          aria-checked={isCurrent}
          onclick={() => handleSelectGroup(group.id)}
        >
          <svg class="tabs-stack-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.25 2.5h7.5" />
            <rect x="2.25" y="4.75" width="11.5" height="8.75" rx="1.75" />
            <path d="M2.25 7.5h11.5" />
          </svg>
          <span class="group-item-label">{group.name}</span>
        </button>

        {#if !group.isDefault}
          <button
            class="group-delete"
            class:on-active={isCurrent}
            type="button"
            aria-label="Delete group {group.name}"
            title="Delete group"
            onclick={(e) => {
              e.stopPropagation();
              onDeleteGroup(group.id);
            }}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 3 6 6m0-6-6 6" />
            </svg>
          </button>
        {/if}
      </div>
    {/each}

    <div class="dropdown-divider" aria-hidden="true"></div>

    <button
      class="create-group-item"
      type="button"
      role="menuitem"
      onclick={openCreateGroupModal}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.25v9.5M3.25 8h9.5" />
      </svg>
      <span>Create new group</span>
    </button>
  </div>
{/if}

{#if createModalOpen}
  <CreateGroupModal
    {theme}
    onCreate={onCreateGroup}
    onClose={() => (createModalOpen = false)}
  />
{/if}

<style>
  .tab-bar {
    --tb-strip-bg: #2f2f2f;
    --tb-active-bg: #000000;
    --tb-text: #f2f2f2;
    --tb-muted: rgba(255, 255, 255, 0.72);
    --tb-subtle: rgba(255, 255, 255, 0.45);
    --tb-hover: rgba(255, 255, 255, 0.09);
    --tb-open-bg: #4f4f4f;
    --tb-sep: rgba(255, 255, 255, 0.16);

    height: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    padding-left: 8px;
    gap: 4px;
    user-select: none;
  }

  .tab-bar.light {
    --tb-strip-bg: #e7e9ee;
    --tb-active-bg: #ffffff;
    --tb-text: #131722;
    --tb-muted: #5d606b;
    --tb-subtle: #787b86;
    --tb-hover: rgba(0, 0, 0, 0.06);
    --tb-open-bg: #d4d7df;
    --tb-sep: rgba(0, 0, 0, 0.14);
  }

  /* Group button */
  .group-button {
    height: 26px;
    flex: 0 0 auto;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--tb-text);
    background: transparent;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .group-button:hover {
    background: var(--tb-hover);
  }

  .group-button.open {
    background: var(--tb-open-bg);
  }

  .group-name {
    max-width: 148px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tabs-stack-icon {
    width: 15px;
    height: 15px;
    flex: 0 0 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.35;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .chevron-icon {
    width: 11px;
    height: 11px;
    flex: 0 0 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.85;
  }

  .chevron-icon.flipped {
    transform: rotate(180deg);
  }

  /* Tabs strip */
  .tabs-strip {
    height: 100%;
    min-width: 0;
    display: flex;
    align-items: flex-end;
    padding: 0 7px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tabs-strip::-webkit-scrollbar {
    display: none;
  }

  .tab {
    position: relative;
    width: 236px;
    min-width: 148px;
    max-width: 236px;
    flex: 0 1 236px;
    height: 100%;
    padding: 0 8px 0 10px;
    border-radius: 8px 8px 0 0;
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--tb-muted);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  /* Subtle divider between inactive tabs */
  .tab::after {
    content: '';
    position: absolute;
    right: 0;
    top: 10px;
    width: 1px;
    height: 14px;
    background: var(--tb-sep);
    pointer-events: none;
  }

  .tab.hide-sep::after,
  .tab:hover::after {
    display: none;
  }

  .tab:hover:not(.active) {
    color: var(--tb-text);
    background: var(--tb-hover);
  }

  .tab.active {
    z-index: 2;
    color: var(--tb-text);
    background: var(--tb-active-bg);
  }

  /* TradingView Desktop subtle inverted bottom fillets on active tab */
  .tab.active::before,
  .tab.active::after {
    content: '';
    display: block;
    position: absolute;
    bottom: 0;
    top: auto;
    width: 7px;
    height: 7px;
    pointer-events: none;
  }

  .tab.active::before {
    left: -7px;
    background: radial-gradient(circle at 0 0, transparent 7px, var(--tb-active-bg) 7.5px);
  }

  .tab.active::after {
    right: -7px;
    background: radial-gradient(circle at 100% 0, transparent 7px, var(--tb-active-bg) 7.5px);
  }

  .tab-emblem {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }

  .tab-emblem.monogram {
    font-size: 10px;
    font-weight: 700;
    color: #ffffff;
    line-height: 1;
  }

  .tab-label {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to right, #000 86%, transparent 100%);
    mask-image: linear-gradient(to right, #000 86%, transparent 100%);
  }

  .tab-title {
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1;
  }

  .quote-arrow {
    font-size: 8px;
    line-height: 1;
  }

  .quote-price {
    font-size: 12.5px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .quote-pct {
    font-size: 12.5px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .quote-arrow.up,
  .quote-pct.up {
    color: #089981;
  }

  .quote-arrow.down,
  .quote-pct.down {
    color: #f23645;
  }

  .tab-meta {
    font-size: 11.5px;
    font-weight: 400;
    color: var(--tb-subtle);
    line-height: 1;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    height: 20px;
    padding: 0 4px;
    border: 1px solid #2962ff;
    border-radius: 4px;
    color: var(--tb-text);
    background: var(--tb-active-bg);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    outline: none;
  }

  .tab-close {
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    display: grid;
    place-items: center;
    color: var(--tb-subtle);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .tab-close:hover {
    color: var(--tb-text);
    background: var(--tb-hover);
  }

  .tab-close svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  /* "+" New tab button */
  .add-tab-button {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    margin-left: 2px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--tb-muted);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .add-tab-button:hover {
    color: var(--tb-text);
    background: var(--tb-hover);
  }

  .add-tab-button svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  /* Group dropdown */
  .group-dropdown {
    --gd-bg: #1f1f1f;
    --gd-border: #333333;
    --gd-divider: #333333;
    --gd-text: #f0f0f0;
    --gd-hover: #303030;
    --gd-active-bg: #f2f2f2;
    --gd-active-fg: #111111;
    --gd-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);

    position: fixed;
    z-index: 160;
    min-width: 212px;
    max-width: 268px;
    padding: 6px;
    border: 1px solid var(--gd-border);
    border-radius: 10px;
    color: var(--gd-text);
    background: var(--gd-bg);
    box-shadow: var(--gd-shadow);
    user-select: none;
  }

  .group-dropdown.light {
    --gd-bg: #ffffff;
    --gd-border: #e0e3eb;
    --gd-divider: #ebebeb;
    --gd-text: #131722;
    --gd-hover: #f2f2f2;
    --gd-active-bg: #131722;
    --gd-active-fg: #ffffff;
    --gd-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  }

  .group-item-row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 6px;
  }

  .group-item-row + .group-item-row {
    margin-top: 2px;
  }

  .group-item {
    flex: 1;
    min-width: 0;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--gd-text);
    background: transparent;
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .group-item:hover:not(.active) {
    background: var(--gd-hover);
  }

  .group-item.active {
    color: var(--gd-active-fg);
    background: var(--gd-active-bg);
    font-weight: 500;
  }

  .group-item-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .group-delete {
    position: absolute;
    right: 6px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    display: grid;
    place-items: center;
    color: var(--gd-text);
    background: transparent;
    opacity: 0;
    cursor: pointer;
    transition: opacity 150ms ease, background-color 150ms ease;
  }

  .group-item-row:hover .group-delete,
  .group-delete:focus-visible {
    opacity: 0.65;
  }

  .group-delete:hover {
    opacity: 1 !important;
    background: rgba(128, 128, 128, 0.22);
  }

  .group-delete.on-active {
    color: var(--gd-active-fg);
  }

  .group-delete svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  .dropdown-divider {
    height: 1px;
    margin: 6px 0;
    background: var(--gd-divider);
  }

  .create-group-item {
    width: 100%;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--gd-text);
    background: transparent;
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .create-group-item:hover {
    background: var(--gd-hover);
  }

  .create-group-item svg {
    width: 15px;
    height: 15px;
    flex: 0 0 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  button:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -2px;
  }
</style>
