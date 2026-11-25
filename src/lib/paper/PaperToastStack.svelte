<script lang="ts">
  import { onMount } from 'svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import { formatPaperPrice, formatQty } from './instruments';
  import { subscribePaperToasts } from './store';
  import type { PaperToast } from './types';

  interface Props {
    theme: 'dark' | 'light';
    bottomOffsetPx?: number;
  }

  let { theme, bottomOffsetPx = 48 }: Props = $props();

  let toasts = $state<PaperToast[]>([]);
  let expanded = $state(false);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  onMount(() => {
    const unsub = subscribePaperToasts((toast) => {
      toasts = [toast, ...toasts].slice(0, 8);
      const t = setTimeout(() => {
        dismiss(toast.id);
      }, 9000);
      timers.set(toast.id, t);
    });
    return () => {
      unsub();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  });

  function dismiss(id: string) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    toasts = toasts.filter((item) => item.id !== id);
    if (toasts.length <= 1) expanded = false;
  }

  function dismissAll() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    toasts = [];
    expanded = false;
  }

  const visibleToasts = $derived(expanded ? toasts : toasts.slice(0, 1));
  const hiddenCount = $derived(Math.max(0, toasts.length - 1));
</script>

{#if toasts.length > 0}
  <div
    class="paper-toast-wrap"
    class:light={theme === 'light'}
    style:bottom="{bottomOffsetPx}px"
    aria-live="polite"
  >
    {#if hiddenCount > 0}
      <div class="stack-bar">
        <button class="show-more-pill" type="button" onclick={() => (expanded = !expanded)}>
          <span>{expanded ? 'Show less' : 'Show more'}</span>
          <span class="cnt-dot">{expanded ? toasts.length : hiddenCount}</span>
        </button>
        <button
          class="clear-all-btn"
          type="button"
          title="Dismiss all notifications"
          aria-label="Dismiss all notifications"
          onclick={dismissAll}
        >
          ×
        </button>
      </div>
    {/if}

    {#each visibleToasts as t (t.id)}
      <div class="exec-toast" class:rejected={t.kind === 'rejected'}>
        <div
          class="status-icon"
          class:ok={t.kind === 'executed'}
          class:placed={t.kind === 'placed' || t.kind === 'info'}
          class:warn={t.kind === 'cancelled' || t.kind === 'rejected'}
          aria-hidden="true"
        >
          {#if t.kind === 'executed'}
            <svg viewBox="0 0 14 14">
              <path d="M3 7.2 5.7 9.9 11 4.2" />
            </svg>
          {:else if t.kind === 'rejected'}
            <svg viewBox="0 0 14 14">
              <path d="m4 4 6 6m0-6-6 6" />
            </svg>
          {:else}
            <svg viewBox="0 0 14 14">
              <path d="M7 4v3.5M7 10h.01" />
            </svg>
          {/if}
        </div>

        <div class="toast-content">
          <div class="toast-title">{t.title}</div>
          {#if t.symbol !== 'PAPER'}
            <div class="toast-sym-row">
              <SymbolIcon symbol={t.shortName} size={14} />
              <span class="toast-sym">{t.symbol}</span>
            </div>
          {/if}
          {#if t.side && typeof t.quantity === 'number'}
            <div class="toast-fill-row">
              <span class="side-chip" class:buy={t.side === 'buy'} class:sell={t.side === 'sell'}>
                {t.side === 'buy' ? 'Buy' : 'Sell'} {formatQty(t.quantity)}
              </span>
              {#if typeof t.price === 'number'}
                <span class="at-price">at {formatPaperPrice(t.price, t.symbol)}</span>
              {/if}
            </div>
          {/if}
          {#if t.detail}
            <div class="toast-detail">{t.detail}</div>
          {/if}
        </div>

        <button
          class="toast-close"
          type="button"
          aria-label="Dismiss notification"
          onclick={() => dismiss(t.id)}
        >
          ×
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .paper-toast-wrap {
    position: fixed;
    left: 16px;
    z-index: 160;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 296px;
    pointer-events: none;
  }

  .stack-bar,
  .exec-toast {
    pointer-events: auto;
  }

  .stack-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }

  .show-more-pill {
    height: 26px;
    padding: 0 8px 0 11px;
    border-radius: 999px;
    border: 1px solid var(--dark-border-glass);
    background: var(--dark-bg-toast);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }

  .paper-toast-wrap.light .show-more-pill {
    background: #ffffff;
    border-color: #e0e3eb;
    color: #131722;
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
  }

  .cnt-dot {
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    font-size: 10.5px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }

  .paper-toast-wrap.light .cnt-dot {
    background: #131722;
    color: #ffffff;
  }

  .clear-all-btn {
    width: 26px;
    height: 26px;
    border-radius: 999px;
    border: 1px solid var(--dark-border-glass);
    background: var(--dark-bg-toast);
    color: var(--dark-text-soft);
    font-size: 15px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }

  .paper-toast-wrap.light .clear-all-btn {
    background: #ffffff;
    border-color: #e0e3eb;
    color: #5d6473;
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
  }

  .exec-toast {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 12px 12px 12px 13px;
    border-radius: 12px;
    background: var(--dark-bg-toast);
    color: var(--dark-text-strong);
    border: 1px solid var(--dark-border-glass);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.52);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }

  .paper-toast-wrap.light .exec-toast {
    background: #ffffff;
    color: #131722;
    border-color: #e0e3eb;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.15);
  }

  .status-icon {
    width: 22px;
    height: 22px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    flex: 0 0 22px;
    margin-top: 2px;
  }

  .status-icon.ok {
    background: #089981;
    color: #ffffff;
  }

  .status-icon.placed {
    background: #2962ff;
    color: #ffffff;
  }

  .status-icon.warn {
    background: #f23645;
    color: #ffffff;
  }

  .status-icon svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .toast-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .toast-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--dark-text-strong);
    line-height: 1.25;
  }

  .paper-toast-wrap.light .toast-title {
    color: #131722;
  }

  .toast-sym-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toast-sym {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .toast-fill-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 1px;
  }

  .side-chip {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .side-chip.buy {
    background: rgba(41, 98, 255, 0.16);
    color: #6b96ff;
  }

  .side-chip.sell {
    background: rgba(242, 54, 69, 0.16);
    color: #ff6b76;
  }

  .paper-toast-wrap.light .side-chip.buy {
    background: rgba(41, 98, 255, 0.12);
    color: #2962ff;
  }

  .paper-toast-wrap.light .side-chip.sell {
    background: rgba(242, 54, 69, 0.12);
    color: #e02938;
  }

  .at-price {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--dark-text-soft);
  }

  .paper-toast-wrap.light .at-price {
    color: #4a5160;
  }

  .toast-detail {
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--dark-text-secondary);
  }

  .paper-toast-wrap.light .toast-detail {
    color: #6a7282;
  }

  .toast-close {
    border: 0;
    background: transparent;
    color: var(--dark-text-secondary);
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .toast-close:hover {
    color: var(--dark-text-strong);
  }

  .paper-toast-wrap.light .toast-close:hover {
    color: #131722;
  }
</style>
