<script lang="ts">
  import { LAYOUT_GROUPS, type LayoutId } from '../chart/layouts';

  interface Props {
    theme: 'dark' | 'light';
    activeLayout: LayoutId;
    anchorRect: DOMRect;
    onSelect: (id: LayoutId) => void;
    onClose: () => void;
  }

  let { theme, activeLayout, anchorRect, onSelect, onClose }: Props = $props();

  const POPOVER_W = 432;
  const POPOVER_H = 224;

  let popoverEl: HTMLDivElement | undefined = $state();

  const pos = $derived.by(() => {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    const left = Math.round(Math.max(12, anchorRect.left - POPOVER_W - 10));
    const centeredTop = anchorRect.top + anchorRect.height / 2 - POPOVER_H / 2;
    const top = Math.round(Math.min(vh - POPOVER_H - 12, Math.max(40, centeredTop)));
    return { left, top };
  });

  function onWindowPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (popoverEl?.contains(target)) return;
    if (target.closest('[data-layout-trigger="true"]')) return;
    onClose();
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    }
  }

  function handleSelect(id: LayoutId) {
    onSelect(id);
    onClose();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<div
  bind:this={popoverEl}
  class="layout-popover"
  class:light={theme === 'light'}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  role="dialog"
  aria-label="Select chart layout"
>
  {#each LAYOUT_GROUPS as group, idx (group.count)}
    <div class="layout-row" class:with-divider={idx > 0}>
      <span class="row-number" aria-hidden="true">{group.count}</span>

      <div class="row-items">
        {#each group.items as item (item.id)}
          <button
            class="layout-option"
            class:selected={activeLayout === item.id}
            type="button"
            aria-label={item.label}
            title={item.label}
            aria-pressed={activeLayout === item.id}
            onclick={() => handleSelect(item.id)}
          >
            <svg viewBox="0 0 20 16" aria-hidden="true">
              <rect x="2" y="2" width="16" height="12" rx="2" />
              {#if item.iconDividers}
                <path d={item.iconDividers} />
              {/if}
            </svg>
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .layout-popover {
    --lp-bg: rgba(18, 18, 18, 0.84);
    --lp-divider: rgba(255, 255, 255, 0.09);
    --lp-text: #f0f0f0;
    --lp-number: #8c8c92;
    --lp-hover: rgba(255, 255, 255, 0.09);
    --lp-selected-bg: #f0f0f0;
    --lp-selected-fg: #0d0d0d;
    --lp-shadow: 0 16px 44px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.1);

    position: fixed;
    z-index: 150;
    width: 432px;
    max-width: calc(100vw - 68px);
    padding: 6px 14px;
    border-radius: 10px;
    color: var(--lp-text);
    background: var(--lp-bg);
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
    box-shadow: var(--lp-shadow);
    user-select: none;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .layout-popover.light {
    --lp-bg: #ffffff;
    --lp-divider: #ebebeb;
    --lp-text: #131722;
    --lp-number: #787b86;
    --lp-hover: rgba(0, 0, 0, 0.05);
    --lp-selected-bg: #1e222d;
    --lp-selected-fg: #ffffff;
    --lp-shadow: 0 10px 32px rgba(0, 0, 0, 0.16), 0 1px 4px rgba(0, 0, 0, 0.08);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .layout-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
  }

  .layout-row.with-divider {
    border-top: 1px solid var(--lp-divider);
  }

  .row-number {
    width: 16px;
    flex: 0 0 16px;
    font-size: 13px;
    font-weight: 400;
    color: var(--lp-number);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .row-items {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: nowrap;
  }

  .layout-option {
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--lp-text);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .layout-option:hover:not(.selected) {
    background: var(--lp-hover);
  }

  .layout-option.selected {
    color: var(--lp-selected-fg);
    background: var(--lp-selected-bg);
  }

  .layout-option:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -2px;
  }

  .layout-option svg {
    width: 22px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
