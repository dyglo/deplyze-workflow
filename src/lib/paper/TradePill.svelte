<script lang="ts">
  import { onMount } from 'svelte';
  import AppLogoIcon from '../AppLogoIcon.svelte';
  import { formatUsd } from './instruments';
  import {
    computeAccountMetrics,
    disconnectPaperLedger,
    getActivePaperAccount,
    setPaperBottomMode,
    subscribePaper,
    subscribePaperQuotes,
    togglePaperTicket
  } from './store';
  import type { PaperLedgerState, PaperLiveQuote } from './types';

  interface Props {
    theme: 'dark' | 'light';
    onOpenConnectModal: (mode: 'connect' | 'settings') => void;
  }

  let { theme, onOpenConnectModal }: Props = $props();

  let ledger = $state<PaperLedgerState | null>(null);
  let quotes = $state<Record<string, PaperLiveQuote>>({});
  let menuOpen = $state(false);
  let triggerEl: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLDivElement | undefined = $state();

  const connected = $derived(Boolean(ledger?.connected));
  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);
  const metrics = $derived(account ? computeAccountMetrics(account, quotes) : null);

  onMount(() => {
    const unsub1 = subscribePaper((s) => {
      ledger = s;
      if (!s.connected) menuOpen = false;
    });
    const unsub2 = subscribePaperQuotes((q) => {
      quotes = q;
    });
    return () => {
      unsub1();
      unsub2();
    };
  });

  function handlePillClick() {
    if (!connected) {
      onOpenConnectModal('connect');
      return;
    }
    menuOpen = !menuOpen;
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!menuOpen) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (menuEl?.contains(target) || triggerEl?.contains(target)) return;
    menuOpen = false;
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && menuOpen) {
      menuOpen = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<div class="trade-pill-wrap" class:light={theme === 'light'}>
  <button
    bind:this={triggerEl}
    class="trade-pill"
    class:connected
    class:open={menuOpen}
    type="button"
    aria-haspopup={connected ? 'menu' : 'dialog'}
    aria-expanded={connected ? menuOpen : undefined}
    title={connected ? 'Paper Ledger connected — Trade menu' : 'Connect Paper Ledger'}
    onclick={handlePillClick}
  >
    {#if connected}
      <span class="badge-circle" aria-hidden="true">
        <AppLogoIcon size={11} />
        <span class="conn-dot"></span>
      </span>
      <span class="pill-label">Trade</span>
      <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5" />
      </svg>
    {:else}
      <span class="pill-label">Trade</span>
    {/if}
  </button>

  {#if connected && menuOpen && account && metrics}
    <div
      bind:this={menuEl}
      class="trade-popover"
      class:light={theme === 'light'}
      role="menu"
      aria-label="Paper Ledger menu"
    >
      <div class="pop-header">
        <div class="pop-acct-row">
          <span class="pop-badge" aria-hidden="true"><AppLogoIcon size={18} /></span>
          <div class="pop-acct-info">
            <div class="pop-acct-name">
              <span>{account.name}</span>
              <span class="sim-chip">SIM</span>
            </div>
            <div class="pop-acct-sub">
              <span class="live-dot"></span>
              <span>Connected · {account.settings.leverage}:1</span>
            </div>
          </div>
        </div>

        <div class="pop-equity-strip">
          <div class="eq-col">
            <span class="eq-k">Equity</span>
            <span class="eq-v">
              {account.settings.privacyMask ? '•••••' : `${formatUsd(metrics.equity)} USD`}
            </span>
          </div>
          <div class="eq-col right">
            <span class="eq-k">Open P&L</span>
            <span
              class="eq-v"
              class:pos={metrics.unrealizedPnl > 0.004}
              class:neg={metrics.unrealizedPnl < -0.004}
            >
              {account.settings.privacyMask ? '••••' : formatUsd(metrics.unrealizedPnl, true)}
            </span>
          </div>
        </div>
      </div>

      <div class="pop-divider"></div>

      <button
        class="pop-item"
        type="button"
        role="menuitem"
        onclick={() => {
          menuOpen = false;
          togglePaperTicket();
        }}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" />
          <path d="M6 6.5h6M6 9.5h6M6 12.5h3.5" />
        </svg>
        <span>{ledger?.ticketOpen ? 'Hide Order Panel' : 'Open Order Panel'}</span>
      </button>

      <button
        class="pop-item"
        type="button"
        role="menuitem"
        onclick={() => {
          menuOpen = false;
          setPaperBottomMode(ledger?.bottomMode === 'collapsed' ? 'expanded' : 'collapsed');
        }}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <rect x="2.5" y="3" width="13" height="12" rx="2" />
          <path d="M2.5 10.5h13" />
        </svg>
        <span>{ledger?.bottomMode === 'collapsed' ? 'Expand Paper Ledger' : 'Collapse Paper Ledger'}</span>
      </button>

      <button
        class="pop-item"
        type="button"
        role="menuitem"
        onclick={() => {
          menuOpen = false;
          onOpenConnectModal('settings');
        }}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M6.6 3.25h4.8a1.3 1.3 0 0 1 1.1.65l2.35 4.05a1.3 1.3 0 0 1 0 1.3l-2.35 4.05a1.3 1.3 0 0 1-1.1.65H6.6a1.3 1.3 0 0 1-1.1-.65L3.15 9.25a1.3 1.3 0 0 1 0-1.3L5.5 3.9a1.3 1.3 0 0 1 1.1-.65Z" />
          <circle cx="9" cy="8.6" r="2.1" />
        </svg>
        <span>Account settings & reset</span>
      </button>

      <div class="pop-divider"></div>

      <button
        class="pop-item danger"
        type="button"
        role="menuitem"
        onclick={() => {
          menuOpen = false;
          disconnectPaperLedger();
        }}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M7 3.5H4.25A1.75 1.75 0 0 0 2.5 5.25v7.5A1.75 1.75 0 0 0 4.25 14.5H7" />
          <path d="M11.5 6 14.75 9l-3.25 3M14.5 9H7" />
        </svg>
        <span>Disconnect Paper Ledger</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .trade-pill-wrap {
    position: relative;
    display: flex;
    align-items: center;
    height: 100%;
    margin-right: 6px;
  }

  .trade-pill {
    height: 24px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .trade-pill:hover {
    background: var(--dark-hover-strong);
    border-color: var(--dark-handle);
  }

  .trade-pill.connected {
    padding: 0 8px 0 4px;
    background: var(--dark-bg-elevated);
    border-color: var(--dark-border-strong);
  }

  .trade-pill.connected:hover,
  .trade-pill.connected.open {
    background: var(--dark-bg-elevated-hover);
    border-color: var(--dark-handle);
  }

  .trade-pill-wrap.light .trade-pill {
    color: #131722;
    border-color: #cfd4de;
    background: #ffffff;
  }

  .trade-pill-wrap.light .trade-pill:hover {
    background: #f5f6f9;
    border-color: #b8becb;
  }

  .trade-pill-wrap.light .trade-pill.connected {
    background: #ffffff;
    border-color: #cfd4de;
  }

  .trade-pill-wrap.light .trade-pill.connected:hover,
  .trade-pill-wrap.light .trade-pill.connected.open {
    background: #f0f2f6;
  }

  .badge-circle {
    position: relative;
    width: 17px;
    height: 17px;
    border-radius: 999px;
    background: #ebebeb;
    color: #0d0d0d;
    display: grid;
    place-items: center;
    flex: 0 0 17px;
  }

  .trade-pill-wrap.light .badge-circle {
    background: #131722;
    color: #ffffff;
  }

  .conn-dot {
    position: absolute;
    top: -1px;
    right: -1px;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #089981;
    border: 1.5px solid var(--dark-bg-elevated);
  }

  .trade-pill-wrap.light .conn-dot {
    border-color: #ffffff;
  }

  .pill-label {
    letter-spacing: -0.01em;
  }

  .chev {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.72;
    transition: transform 140ms ease;
  }

  .trade-pill.open .chev {
    transform: rotate(180deg);
  }

  .trade-popover {
    position: fixed;
    top: 38px;
    right: 146px;
    width: 262px;
    padding: 6px;
    border-radius: 12px;
    background: var(--dark-bg-glass-strong);
    color: var(--dark-text-primary);
    border: 1px solid var(--dark-border-glass);
    box-shadow: var(--dark-shadow-popover);
    z-index: 240;
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }

  .trade-popover.light {
    background: #ffffff;
    color: #131722;
    border-color: #e0e3eb;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.14);
  }

  .pop-header {
    padding: 8px 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .pop-acct-row {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .pop-badge {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: #ebebeb;
    color: #0d0d0d;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: -0.03em;
    display: grid;
    place-items: center;
    flex: 0 0 30px;
  }

  .trade-popover.light .pop-badge {
    background: #131722;
    color: #ffffff;
  }

  .pop-acct-info {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .pop-acct-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }

  .sim-chip {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: var(--dark-text-soft);
  }

  .trade-popover.light .sim-chip {
    background: #eef0f5;
    color: #5d6473;
  }

  .pop-acct-sub {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .trade-popover.light .pop-acct-sub {
    color: #6a7282;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #089981;
  }

  .pop-equity-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 9px;
    border-radius: 8px;
    background: var(--dark-bg-surface);
    border: 1px solid var(--dark-border-subtle);
  }

  .trade-popover.light .pop-equity-strip {
    background: #f5f6f9;
    border-color: #eceff4;
  }

  .eq-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .eq-col.right {
    text-align: right;
  }

  .eq-k {
    font-size: 10.5px;
    color: var(--dark-text-secondary);
  }

  .trade-popover.light .eq-k {
    color: #6a7282;
  }

  .eq-v {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .eq-v.pos {
    color: #089981;
  }

  .eq-v.neg {
    color: #f23645;
  }

  .pop-divider {
    height: 1px;
    margin: 4px 6px;
    background: var(--dark-border-subtle);
  }

  .trade-popover.light .pop-divider {
    background: #eceff4;
  }

  .pop-item {
    width: 100%;
    height: 34px;
    padding: 0 9px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 450;
    display: flex;
    align-items: center;
    gap: 9px;
    cursor: pointer;
    text-align: left;
    transition: background-color 120ms ease;
  }

  .pop-item:hover {
    background: var(--dark-hover-strong);
  }

  .trade-popover.light .pop-item:hover {
    background: #f2f4f8;
  }

  .pop-item.danger {
    color: #f23645;
  }

  .pop-item svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.78;
    flex: 0 0 16px;
  }
</style>
