<script lang="ts">
  import type { RgbaColor } from '../settings/chartSettings';

  interface Props {
    theme: 'dark' | 'light';
    value: RgbaColor;
    anchorRect: DOMRect;
    onChange: (next: RgbaColor) => void;
    onClose: () => void;
  }

  let { theme, value, anchorRect, onChange, onClose }: Props = $props();

  // Exact TradingView 7x10 color matrix (1 grayscale + 1 vivid + 5 shade rows)
  const PALETTE: string[][] = [
    ['#FFFFFF', '#D1D4DC', '#B2B5BE', '#9598A1', '#787B86', '#5D606B', '#434651', '#2A2E39', '#131722', '#000000'],
    ['#F23645', '#FF9800', '#FFEB3B', '#4CAF50', '#089981', '#00BCD4', '#2962FF', '#673AB7', '#9C27B0', '#E91E63'],
    ['#FCCBCD', '#FFE0B2', '#FFF9C4', '#C8E6C9', '#ACE5DC', '#B2EBF2', '#BBD9FB', '#D1C4E9', '#E1BEE7', '#F8BBD0'],
    ['#FAA1A4', '#FFCC80', '#FFF59D', '#A5D6A7', '#70CCBD', '#80DEEA', '#90BFF9', '#B39DDB', '#CE93D8', '#F48FB1'],
    ['#F77C80', '#FFB74D', '#FFF176', '#81C784', '#42BDA8', '#4DD0E1', '#5B9CF6', '#9575CD', '#BA68C8', '#F06292'],
    ['#B22833', '#F57C00', '#FBC02D', '#388E3C', '#056656', '#0097A7', '#1848CC', '#512DA8', '#7B1FA2', '#C2185B'],
    ['#801922', '#E65100', '#F57F17', '#1B5E20', '#00332A', '#006064', '#0C3299', '#311B92', '#4A148C', '#880E4F']
  ];

  const POPOVER_W = 244;
  const POPOVER_H = 304;

  let popoverEl: HTMLDivElement | undefined = $state();
  let customColorInput: HTMLInputElement | undefined = $state();
  let trackEl: HTMLDivElement | undefined = $state();
  let draggingOpacity = $state(false);

  const pos = $derived.by(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    const left = Math.round(Math.min(vw - POPOVER_W - 12, Math.max(12, anchorRect.left)));
    const belowTop = anchorRect.bottom + 6;
    const top =
      belowTop + POPOVER_H <= vh - 12
        ? Math.round(belowTop)
        : Math.round(Math.max(40, vh - POPOVER_H - 12));
    return { left, top };
  });

  function selectHex(hex: string) {
    onChange({ hex: hex.toUpperCase(), opacity: value.opacity });
  }

  function updateOpacityFromClientX(clientX: number) {
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange({ hex: value.hex, opacity: Math.round(ratio * 100) });
  }

  function onSliderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    draggingOpacity = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updateOpacityFromClientX(e.clientX);
    e.preventDefault();
  }

  function onSliderPointerMove(e: PointerEvent) {
    if (!draggingOpacity) return;
    updateOpacityFromClientX(e.clientX);
  }

  function onSliderPointerUp(e: PointerEvent) {
    if (!draggingOpacity) return;
    draggingOpacity = false;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
  }

  function onWindowPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (popoverEl?.contains(target)) return;
    if (target.closest('[data-color-swatch-trigger="true"]')) return;
    onClose();
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<div
  bind:this={popoverEl}
  class="color-popover"
  class:light={theme === 'light'}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  role="dialog"
  aria-label="Color picker"
>
  <div class="palette">
    {#each PALETTE as row, rowIndex (rowIndex)}
      <div class="palette-row" class:row-gap={rowIndex === 0 || rowIndex === 1}>
        {#each row as swatch (swatch)}
          <button
            class="swatch-cell"
            class:selected={value.hex.toUpperCase() === swatch}
            class:is-white={swatch === '#FFFFFF'}
            type="button"
            style:background={swatch}
            aria-label={swatch}
            onclick={() => selectHex(swatch)}
          ></button>
        {/each}
      </div>
    {/each}
  </div>

  <div class="popover-divider" aria-hidden="true"></div>

  <div class="custom-row">
    <button
      class="add-color-button"
      type="button"
      aria-label="Custom color"
      title="Custom color"
      onclick={() => customColorInput?.click()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.25v9.5M3.25 8h9.5" />
      </svg>
    </button>
    <input
      bind:this={customColorInput}
      class="native-color-input"
      type="color"
      value={value.hex}
      tabindex="-1"
      aria-hidden="true"
      oninput={(e) => selectHex((e.currentTarget as HTMLInputElement).value)}
    />
  </div>

  <div class="opacity-section">
    <span class="opacity-label">Opacity</span>
    <div class="opacity-controls">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={trackEl}
        class="opacity-track"
        role="slider"
        aria-label="Opacity"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value.opacity}
        tabindex="0"
        onpointerdown={onSliderPointerDown}
        onpointermove={onSliderPointerMove}
        onpointerup={onSliderPointerUp}
        onpointercancel={onSliderPointerUp}
        onkeydown={(e) => {
          if (e.key === 'ArrowLeft') {
            onChange({ hex: value.hex, opacity: Math.max(0, value.opacity - 5) });
            e.preventDefault();
          } else if (e.key === 'ArrowRight') {
            onChange({ hex: value.hex, opacity: Math.min(100, value.opacity + 5) });
            e.preventDefault();
          }
        }}
      >
        <div
          class="opacity-gradient"
          style:background="linear-gradient(to right, transparent, {value.hex})"
        ></div>
        <span class="opacity-thumb" style:left="{value.opacity}%"></span>
      </div>

      <span class="opacity-readout">{value.opacity}%</span>
    </div>
  </div>
</div>

<style>
  .color-popover {
    --cp-bg: #1e222d;
    --cp-border: #2a2e39;
    --cp-divider: #2a2e39;
    --cp-text: #d1d4dc;
    --cp-secondary: #787b86;
    --cp-ring: #d1d4dc;
    --cp-checker-a: #363a45;
    --cp-checker-b: #1e222d;
    --cp-shadow: 0 12px 32px rgba(0, 0, 0, 0.65), 0 0 0 1px #2a2e39;

    position: fixed;
    z-index: 200;
    width: 244px;
    padding: 12px;
    border-radius: 10px;
    color: var(--cp-text);
    background: var(--cp-bg);
    box-shadow: var(--cp-shadow);
    user-select: none;
  }

  .color-popover.light {
    --cp-bg: #ffffff;
    --cp-border: #e0e3eb;
    --cp-divider: #ebebeb;
    --cp-text: #131722;
    --cp-secondary: #787b86;
    --cp-ring: #131722;
    --cp-checker-a: #d5d8de;
    --cp-checker-b: #ffffff;
    --cp-shadow: 0 8px 28px rgba(0, 0, 0, 0.16), 0 1px 4px rgba(0, 0, 0, 0.08);
  }

  .palette {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .palette-row {
    display: grid;
    grid-template-columns: repeat(10, 18px);
    gap: 4px;
  }

  .palette-row.row-gap {
    margin-bottom: 4px;
  }

  .swatch-cell {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    cursor: pointer;
    position: relative;
  }

  .swatch-cell.is-white {
    box-shadow: inset 0 0 0 1px var(--cp-border);
  }

  .swatch-cell.selected {
    box-shadow:
      0 0 0 1.5px var(--cp-bg),
      0 0 0 3px var(--cp-ring);
    z-index: 1;
  }

  .popover-divider {
    height: 1px;
    margin: 10px 0 8px;
    background: var(--cp-divider);
  }

  .custom-row {
    position: relative;
    display: flex;
    align-items: center;
    margin-bottom: 8px;
  }

  .add-color-button {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--cp-text);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .add-color-button:hover {
    background: color-mix(in srgb, var(--cp-text) 8%, transparent);
  }

  .add-color-button svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .native-color-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .opacity-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .opacity-label {
    font-size: 12px;
    color: var(--cp-secondary);
  }

  .opacity-controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .opacity-track {
    position: relative;
    flex: 1;
    height: 10px;
    border-radius: 5px;
    cursor: pointer;
    touch-action: none;
    background-color: var(--cp-checker-b);
    background-image:
      linear-gradient(45deg, var(--cp-checker-a) 25%, transparent 25%),
      linear-gradient(-45deg, var(--cp-checker-a) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--cp-checker-a) 75%),
      linear-gradient(-45deg, transparent 75%, var(--cp-checker-a) 75%);
    background-size: 6px 6px;
    background-position: 0 0, 0 3px, 3px -3px, -3px 0;
  }

  .opacity-gradient {
    position: absolute;
    inset: 0;
    border-radius: 5px;
  }

  .opacity-thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--cp-bg);
    border: 2px solid var(--cp-ring);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .opacity-readout {
    width: 46px;
    height: 26px;
    flex: 0 0 46px;
    border: 1px solid var(--cp-border);
    border-radius: 6px;
    display: grid;
    place-items: center;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--cp-text);
  }
</style>
