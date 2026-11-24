<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    theme: 'dark' | 'light';
    title: string;
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    onClose: () => void;
    icon?: Snippet;
    children: Snippet;
  }

  let {
    theme,
    title,
    defaultWidth = 420,
    minWidth = 360,
    maxWidth = 640,
    onClose,
    icon,
    children
  }: Props = $props();

  const CHART_MIN_WIDTH = 480;
  const RAIL_AND_GAPS = 56; // 48px rail + two 4px gutters

  // svelte-ignore state_referenced_locally
  let width = $state(defaultWidth);
  let dragging = $state(false);

  let dragStartX = 0;
  let dragStartWidth = 0;

  function clampWidth(next: number): number {
    const viewportCap =
      typeof window !== 'undefined'
        ? Math.max(minWidth, window.innerWidth - CHART_MIN_WIDTH - RAIL_AND_GAPS)
        : maxWidth;
    const upper = Math.min(maxWidth, viewportCap);
    return Math.round(Math.min(upper, Math.max(minWidth, next)));
  }

  function onHandlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartWidth = width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onHandlePointerMove(e: PointerEvent) {
    if (!dragging) return;
    const delta = dragStartX - e.clientX;
    width = clampWidth(dragStartWidth + delta);
  }

  function onHandlePointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
  }

  function onHandleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      width = clampWidth(width + 16);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      width = clampWidth(width - 16);
      e.preventDefault();
    }
  }

  function onWindowResize() {
    width = clampWidth(width);
  }
</script>

<svelte:window onresize={onWindowResize} />

<aside
  class="panel-shell"
  class:light={theme === 'light'}
  class:dragging
  style:width="{width}px"
  style:flex-basis="{width}px"
  aria-label={title}
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="resize-handle"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize panel"
    aria-valuemin={minWidth}
    aria-valuemax={maxWidth}
    aria-valuenow={width}
    tabindex="0"
    onpointerdown={onHandlePointerDown}
    onpointermove={onHandlePointerMove}
    onpointerup={onHandlePointerUp}
    onpointercancel={onHandlePointerUp}
    onkeydown={onHandleKeyDown}
  >
    <span class="resize-pill" aria-hidden="true"></span>
  </div>

  <div class="panel-inner">
    <header class="panel-header">
      <div class="panel-title-group">
        {#if icon}
          <span class="panel-icon" aria-hidden="true">
            {@render icon()}
          </span>
        {/if}
        <h2 class="panel-title">{title}</h2>
      </div>

      <div class="panel-actions">
        <button
          class="header-button"
          type="button"
          aria-label="Minimize {title}"
          title="Minimize"
          onclick={onClose}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 13.5h10" />
          </svg>
        </button>

        <button
          class="header-button"
          type="button"
          aria-label="Close {title}"
          title="Close"
          onclick={onClose}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5.5 5.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
    </header>

    <div class="panel-body">
      {@render children()}
    </div>
  </div>
</aside>

<style>
  .panel-shell {
    position: relative;
    flex-grow: 0;
    flex-shrink: 0;
    height: 100%;
    color: var(--dark-text-primary);
    background: var(--dark-bg-panel);
    border-left: 1px solid var(--dark-border);
    transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
  }

  .panel-shell.light {
    color: #131722;
    background: #ffffff;
    border-left-color: #e0e3eb;
  }

  .panel-shell.dragging {
    user-select: none;
  }

  .resize-handle {
    position: absolute;
    left: -5px;
    top: 0;
    bottom: 0;
    width: 12px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: ew-resize;
    touch-action: none;
  }

  .resize-handle:focus-visible {
    outline: none;
  }

  .resize-pill {
    width: 3px;
    height: 56px;
    border-radius: 999px;
    background: var(--dark-handle);
    transition: background-color 150ms ease;
  }

  .panel-shell.light .resize-pill {
    background: #9c9c9c;
  }

  .resize-handle:hover .resize-pill,
  .resize-handle:focus-visible .resize-pill,
  .panel-shell.dragging .resize-pill {
    background: var(--dark-handle-hover);
  }

  .panel-shell.light .resize-handle:hover .resize-pill,
  .panel-shell.light .resize-handle:focus-visible .resize-pill,
  .panel-shell.light.dragging .resize-pill {
    background: #6a6d78;
  }

  .panel-inner {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    height: 52px;
    flex: 0 0 52px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }

  .panel-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .panel-icon {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    color: inherit;
    flex: 0 0 18px;
  }

  .panel-icon :global(svg) {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .panel-title {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.2;
    color: inherit;
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-button {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: inherit;
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .header-button:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }

  .header-button:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -2px;
  }

  .header-button svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .panel-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
