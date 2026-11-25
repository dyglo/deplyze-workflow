<script lang="ts">
  import { onMount } from 'svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    computePnlUsd,
    formatPaperPrice,
    formatQty,
    formatUsd,
    getPaperInstrumentSpec,
    normalizeSymbolKey,
    roundToTick
  } from './instruments';
  import {
    computeAccountMetrics,
    getActivePaperAccount,
    modifyPositionBrackets,
    subscribePaper,
    subscribePaperQuotes
  } from './store';
  import type { PaperLedgerState, PaperLiveQuote, PaperPosition } from './types';

  interface Props {
    theme: 'dark' | 'light';
    position: PaperPosition;
    focusField?: 'tp' | 'sl' | null;
    onClose: () => void;
  }

  let { theme, position, focusField = null, onClose }: Props = $props();

  let ledger = $state<PaperLedgerState | null>(null);
  let quotes = $state<Record<string, PaperLiveQuote>>({});

  const spec = $derived(getPaperInstrumentSpec(position.symbol));
  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);
  const liveQuote = $derived(quotes[normalizeSymbolKey(position.symbol)] ?? null);
  const currentRef = $derived(liveQuote?.last ?? position.lastKnownPrice ?? position.avgFillPrice);
  const accountMetrics = $derived(account ? computeAccountMetrics(account, quotes) : null);

  function toRawPrice(val: number | null): string {
    if (val === null || !Number.isFinite(val)) return '';
    return val.toFixed(getPaperInstrumentSpec(position.symbol).decimals);
  }

  // svelte-ignore state_referenced_locally
  let tpEnabled = $state(position.takeProfit !== null || focusField === 'tp');
  // svelte-ignore state_referenced_locally
  let slEnabled = $state(position.stopLoss !== null || focusField === 'sl');
  // svelte-ignore state_referenced_locally
  let tpPriceStr = $state(toRawPrice(position.takeProfit));
  // svelte-ignore state_referenced_locally
  let slPriceStr = $state(toRawPrice(position.stopLoss));
  let errorMsg = $state<string | null>(null);

  let tpInputEl: HTMLInputElement | undefined = $state();
  let slInputEl: HTMLInputElement | undefined = $state();

  function parseNumeric(val: string | number | null | undefined): number | null {
    if (val === null || val === undefined) return null;
    const cleaned = String(val).replace(/,/g, '').trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function defaultSuggestedPrice(kind: 'tp' | 'sl'): string {
    const sp = getPaperInstrumentSpec(position.symbol);
    const dir = position.side === 'long' ? 1 : -1;
    const dist = Math.max(sp.pipSize * (kind === 'tp' ? 50 : 25), currentRef * (kind === 'tp' ? 0.006 : 0.003));
    const px =
      kind === 'tp'
        ? roundToTick(currentRef + dir * dist, position.symbol)
        : roundToTick(Math.max(sp.tickSize, currentRef - dir * dist), position.symbol);
    return px.toFixed(sp.decimals);
  }

  onMount(() => {
    const unsub1 = subscribePaper((s) => {
      ledger = s;
    });
    const unsub2 = subscribePaperQuotes((q) => {
      quotes = q;
    });

    if (tpEnabled && !tpPriceStr) {
      tpPriceStr = defaultSuggestedPrice('tp');
    }
    if (slEnabled && !slPriceStr) {
      slPriceStr = defaultSuggestedPrice('sl');
    }

    queueMicrotask(() => {
      if (focusField === 'tp') {
        tpInputEl?.focus();
        tpInputEl?.select();
      } else if (focusField === 'sl') {
        slInputEl?.focus();
        slInputEl?.select();
      }
    });

    return () => {
      unsub1();
      unsub2();
    };
  });

  const parsedTp = $derived(tpEnabled ? parseNumeric(tpPriceStr) : null);
  const parsedSl = $derived(slEnabled ? parseNumeric(slPriceStr) : null);

  const estTpUsd = $derived(
    parsedTp !== null
      ? computePnlUsd(position.symbol, position.side, position.quantity, position.avgFillPrice, parsedTp)
      : null
  );

  const estSlUsd = $derived(
    parsedSl !== null
      ? computePnlUsd(position.symbol, position.side, position.quantity, position.avgFillPrice, parsedSl)
      : null
  );

  const estRR = $derived.by(() => {
    if (estTpUsd === null || estSlUsd === null || estTpUsd <= 0 || estSlUsd >= 0) return null;
    return estTpUsd / Math.abs(estSlUsd);
  });

  function toggleTp() {
    tpEnabled = !tpEnabled;
    errorMsg = null;
    if (tpEnabled && !parseNumeric(tpPriceStr)) {
      tpPriceStr = defaultSuggestedPrice('tp');
    }
  }

  function toggleSl() {
    slEnabled = !slEnabled;
    errorMsg = null;
    if (slEnabled && !parseNumeric(slPriceStr)) {
      slPriceStr = defaultSuggestedPrice('sl');
    }
  }

  function applySlBreakeven() {
    slEnabled = true;
    slPriceStr = position.avgFillPrice.toFixed(spec.decimals);
    errorMsg = null;
  }

  function applyTpMultiple(mult: number) {
    const sl = parsedSl;
    if (sl === null) return;
    const riskDist = Math.abs(position.avgFillPrice - sl);
    if (riskDist <= 0) return;
    const dir = position.side === 'long' ? 1 : -1;
    tpEnabled = true;
    tpPriceStr = roundToTick(position.avgFillPrice + dir * riskDist * mult, position.symbol).toFixed(
      spec.decimals
    );
    errorMsg = null;
  }

  function handleSave() {
    errorMsg = null;
    const tp = tpEnabled ? parseNumeric(tpPriceStr) : null;
    const sl = slEnabled ? parseNumeric(slPriceStr) : null;

    if (tpEnabled && tp === null) {
      errorMsg = 'Enter a valid Take profit price or turn off Take profit.';
      return;
    }
    if (slEnabled && sl === null) {
      errorMsg = 'Enter a valid Stop loss price or turn off Stop loss.';
      return;
    }

    const res = modifyPositionBrackets(position.id, tp, sl);
    if (!res.ok) {
      errorMsg = res.error ?? 'Unable to update TP/SL.';
      return;
    }
    onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter') handleSave();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="mod-backdrop"
  class:light={theme === 'light'}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="mod-dialog" role="dialog" aria-modal="true" aria-label="Modify position TP and SL">
    <div class="md-head">
      <h2>Modify position</h2>
      <button class="md-x" type="button" aria-label="Close" onclick={onClose}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3.5 3.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>

    <div class="pos-banner">
      <SymbolIcon symbol={position.shortName} size={28} />
      <div class="pb-info">
        <div class="pb-sym">
          <span>{position.symbol}</span>
          <span class="side-tag" class:long={position.side === 'long'} class:short={position.side === 'short'}>
            {position.side === 'long' ? 'Long' : 'Short'} {formatQty(position.quantity)}
          </span>
        </div>
        <div class="pb-prices">
          <span>Entry {formatPaperPrice(position.avgFillPrice, position.symbol)}</span>
          <span>·</span>
          <span>Last {formatPaperPrice(currentRef, position.symbol)}</span>
        </div>
      </div>
    </div>

    <!-- Take Profit Block -->
    <div class="bracket-box tp" class:active={tpEnabled}>
      <div class="bb-head">
        <span class="bb-title">Take profit (Limit)</span>
        <button
          class="switch"
          class:on={tpEnabled}
          type="button"
          role="switch"
          aria-checked={tpEnabled}
          aria-label="Toggle take profit"
          onclick={toggleTp}
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="bb-input-row">
        <input
          bind:this={tpInputEl}
          type="text"
          inputmode="decimal"
          disabled={!tpEnabled}
          placeholder="Take profit price"
          bind:value={tpPriceStr}
        />
        {#if tpEnabled && parsedSl !== null}
          <div class="quick-chips">
            {#each [1, 2, 3] as r (r)}
              <button class="qchip" type="button" onclick={() => applyTpMultiple(r)}>{r}R</button>
            {/each}
          </div>
        {/if}
      </div>

      {#if tpEnabled && estTpUsd !== null}
        <div class="bb-est" class:pos={estTpUsd > 0} class:neg={estTpUsd < 0}>
          Est. Profit: <strong>{formatUsd(estTpUsd, true)} USD</strong>
          {#if estRR !== null}· <strong>1 : {estRR.toFixed(2)} R:R</strong>{/if}
        </div>
      {/if}
    </div>

    <!-- Stop Loss Block -->
    <div class="bracket-box sl" class:active={slEnabled}>
      <div class="bb-head">
        <span class="bb-title">Stop loss (Stop)</span>
        <button
          class="switch sl-sw"
          class:on={slEnabled}
          type="button"
          role="switch"
          aria-checked={slEnabled}
          aria-label="Toggle stop loss"
          onclick={toggleSl}
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="bb-input-row">
        <input
          bind:this={slInputEl}
          type="text"
          inputmode="decimal"
          disabled={!slEnabled}
          placeholder="Stop loss price"
          bind:value={slPriceStr}
        />
        {#if slEnabled}
          <button
            class="qchip"
            type="button"
            title="Set Stop Loss to Entry (Breakeven)"
            onclick={applySlBreakeven}
          >
            BE
          </button>
        {/if}
      </div>

      {#if slEnabled && estSlUsd !== null}
        <div class="bb-est" class:neg={estSlUsd < 0} class:pos={estSlUsd > 0}>
          Est. Risk: <strong>{formatUsd(estSlUsd, true)} USD</strong>
          {#if accountMetrics && accountMetrics.equity > 0}
            ({((Math.abs(estSlUsd) / accountMetrics.equity) * 100).toFixed(2)}% equity)
          {/if}
        </div>
      {/if}
    </div>

    {#if errorMsg}
      <div class="md-err">{errorMsg}</div>
    {/if}

    <div class="md-foot">
      <button class="btn-cancel" type="button" onclick={onClose}>Cancel</button>
      <button class="btn-apply" type="button" onclick={handleSave}>Apply TP / SL</button>
    </div>
  </div>
</div>

<style>
  .mod-backdrop {
    position: fixed;
    inset: 0;
    z-index: 275;
    background: rgba(0, 0, 0, 0.54);
    display: grid;
    place-items: center;
    padding: 20px;
  }

  .mod-backdrop.light {
    background: rgba(15, 23, 42, 0.32);
  }

  .mod-dialog {
    width: 100%;
    max-width: 400px;
    padding: 20px 22px 18px;
    border-radius: 16px;
    background: var(--dark-bg-surface);
    color: var(--dark-text-strong);
    border: 1px solid var(--dark-border);
    box-shadow: var(--dark-shadow-modal);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .mod-backdrop.light .mod-dialog {
    background: #ffffff;
    color: #131722;
    border-color: #e0e3eb;
    box-shadow: 0 20px 56px rgba(15, 23, 42, 0.22);
  }

  .md-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .md-head h2 {
    margin: 0;
    font-size: 16.5px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .md-x {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 0;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .md-x:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .mod-backdrop.light .md-x:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .md-x svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .pos-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
    border-radius: 10px;
    background: var(--dark-bg-surface-alt);
    border: 1px solid var(--dark-border-subtle);
  }

  .mod-backdrop.light .pos-banner {
    background: #f5f6f9;
    border-color: #eceff4;
  }

  .pb-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .pb-sym {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    font-weight: 700;
  }

  .side-tag {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
  }

  .side-tag.long {
    background: rgba(41, 98, 255, 0.16);
    color: #6b96ff;
  }

  .side-tag.short {
    background: rgba(242, 54, 69, 0.16);
    color: #ff6b76;
  }

  .mod-backdrop.light .side-tag.long {
    color: #2962ff;
  }

  .mod-backdrop.light .side-tag.short {
    color: #e02938;
  }

  .pb-prices {
    font-size: 11.5px;
    color: var(--dark-text-secondary);
    display: flex;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }

  .bracket-box {
    padding: 11px 12px;
    border-radius: 10px;
    background: var(--dark-bg-surface-alt);
    border: 1px solid var(--dark-border-subtle);
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 140ms ease;
  }

  .bracket-box.tp.active {
    border-color: rgba(8, 153, 129, 0.55);
  }

  .bracket-box.sl.active {
    border-color: rgba(255, 152, 0, 0.55);
  }

  .mod-backdrop.light .bracket-box {
    background: #f8f9fc;
    border-color: #e6e9ef;
  }

  .bb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .bb-title {
    font-size: 12.5px;
    font-weight: 600;
  }

  .switch {
    width: 34px;
    height: 18px;
    padding: 2px;
    border-radius: 999px;
    border: 0;
    background: var(--dark-border-strong);
    display: flex;
    align-items: center;
    cursor: pointer;
    transition: background-color 140ms ease;
  }

  .mod-backdrop.light .switch {
    background: #cfd4de;
  }

  .switch.on {
    background: #089981;
  }

  .switch.sl-sw.on {
    background: #f59e0b;
  }

  .switch .knob {
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: #ffffff;
    transform: translateX(0);
    transition: transform 140ms ease;
  }

  .switch.on .knob {
    transform: translateX(16px);
  }

  .bb-input-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .bb-input-row input {
    flex: 1;
    min-width: 0;
    height: 34px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    outline: none;
  }

  .bb-input-row input:disabled {
    opacity: 0.42;
  }

  .mod-backdrop.light .bb-input-row input {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .quick-chips {
    display: flex;
    gap: 4px;
  }

  .qchip {
    height: 34px;
    padding: 0 8px;
    border-radius: 7px;
    border: 1px solid var(--dark-border);
    background: var(--dark-bg-elevated);
    color: var(--dark-text-primary);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .mod-backdrop.light .qchip {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .bb-est {
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--dark-text-secondary);
  }

  .bb-est.pos {
    color: #089981;
  }

  .bb-est.neg {
    color: #f23645;
  }

  .md-err {
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(242, 54, 69, 0.14);
    border: 1px solid rgba(242, 54, 69, 0.35);
    color: #ff7a84;
    font-size: 11.5px;
  }

  .mod-backdrop.light .md-err {
    color: #d92635;
  }

  .md-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 2px;
  }

  .btn-cancel,
  .btn-apply {
    height: 36px;
    padding: 0 16px;
    border-radius: 9px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-cancel {
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: var(--dark-text-primary);
  }

  .mod-backdrop.light .btn-cancel {
    border-color: #d6dae1;
    color: #131722;
  }

  .btn-apply {
    border: 0;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
  }

  .mod-backdrop.light .btn-apply {
    background: #131722;
    color: #ffffff;
  }
</style>
