<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DEFAULT_SETUP_TYPES,
    getAllSetupTypes,
    savePaperTradeToPlaybook,
    subscribePlaybook,
    type PlaybookGrade,
    type PlaybookState
  } from '../playbook/store';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import { formatPaperPrice, formatQty, formatUsd } from './instruments';
  import {
    closePaperPosition,
    computePositionMetrics,
    getActivePaperAccount,
    markTradeSentToPlaybook,
    subscribePaper,
    subscribePaperQuotes
  } from './store';
  import type { PaperLedgerState, PaperLiveQuote, PaperPosition } from './types';

  interface Props {
    theme: 'dark' | 'light';
    position: PaperPosition;
    onClose: () => void;
  }

  let { theme, position, onClose }: Props = $props();

  let ledger = $state<PaperLedgerState | null>(null);
  let quotes = $state<Record<string, PaperLiveQuote>>({});
  let playbookState = $state<PlaybookState>({ entries: [], customSetupTypes: [] });

  let partialClose = $state(false);
  // svelte-ignore state_referenced_locally
  let partialQtyStr = $state(String(Number((position.quantity / 2).toFixed(4))));
  let sendToPlaybook = $state(false);
  let setupType = $state(DEFAULT_SETUP_TYPES[0]);
  let grade = $state<PlaybookGrade>('A+');
  let noteDraft = $state('');
  let errorMsg = $state<string | null>(null);

  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);
  const setupTypes = $derived(getAllSetupTypes(playbookState));
  const metrics = $derived(
    account
      ? computePositionMetrics(
          position,
          quotes,
          account.settings.leverage,
          account.settings.zeroSpread
        )
      : null
  );

  const effectiveCloseQty = $derived.by(() => {
    if (!partialClose) return position.quantity;
    const v = Number(partialQtyStr);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.min(position.quantity, v);
  });

  const remainingQty = $derived(Math.max(0, Number((position.quantity - effectiveCloseQty).toFixed(6))));

  const estClosePnl = $derived.by(() => {
    if (!metrics || position.quantity <= 0) return 0;
    return metrics.unrealizedPnl * (effectiveCloseQty / position.quantity);
  });

  const estCloseR = $derived.by(() => {
    if (!metrics || metrics.liveR === null) return null;
    return metrics.liveR;
  });

  onMount(() => {
    const unsub1 = subscribePaper((s) => {
      ledger = s;
    });
    const unsub2 = subscribePaperQuotes((q) => {
      quotes = q;
    });
    const unsub3 = subscribePlaybook((p) => {
      playbookState = p;
    });
    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  });

  function setPartialPercent(pct: number) {
    const raw = position.quantity * pct;
    partialQtyStr = String(raw >= 10 ? Math.round(raw) : Number(raw.toFixed(4)));
  }

  async function handleConfirm() {
    errorMsg = null;
    if (partialClose) {
      if (effectiveCloseQty <= 0 || effectiveCloseQty > position.quantity) {
        errorMsg = `Enter a quantity between 0 and ${formatQty(position.quantity)}.`;
        return;
      }
    }

    const res = closePaperPosition(position.id, partialClose ? effectiveCloseQty : null);
    if (!res.ok) {
      errorMsg = res.error ?? 'Failed to close position.';
      return;
    }

    if (sendToPlaybook && res.closedTrade) {
      const t = res.closedTrade;
      const pbEntry = await savePaperTradeToPlaybook({
        tradeId: t.id,
        symbol: t.shortName,
        fullSymbol: t.symbol,
        side: t.side,
        quantity: t.quantity,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        realizedPnl: t.realizedPnl,
        realizedR: t.realizedR,
        closeReason: t.closeReason,
        closedAt: t.closedAt,
        setupType,
        grade,
        notes: noteDraft
      });
      markTradeSentToPlaybook(t.id, pbEntry.id);
    }

    onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="close-backdrop"
  class:light={theme === 'light'}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="close-dialog" role="dialog" aria-modal="true" aria-label="Close position">
    <div class="cd-head">
      <h2>Close position</h2>
      <button class="cd-x" type="button" aria-label="Close" onclick={onClose}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3.5 3.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>

    <div class="cd-body">
      <div class="pos-row">
        <SymbolIcon symbol={position.shortName} size={32} />
        <div class="pos-meta">
          <div class="pos-title">
            {position.symbol} · {position.side === 'long' ? 'Long' : 'Short'} {formatQty(position.quantity)} @ {formatPaperPrice(position.avgFillPrice, position.symbol)}
          </div>
          <div class="pos-est">
            <span>Est. P&L:</span>
            <strong class:pos={estClosePnl > 0.004} class:neg={estClosePnl < -0.004}>
              {formatUsd(estClosePnl, true)} USD
            </strong>
            {#if estCloseR !== null}
              <span class="est-r" class:pos={estCloseR > 0} class:neg={estCloseR < 0}>
                ({estCloseR >= 0 ? '+' : ''}{estCloseR.toFixed(2)}R)
              </span>
            {/if}
          </div>
        </div>
      </div>

      <!-- Partial Close Checkbox (Exact TradingView Reference) -->
      <label class="chk-row">
        <input type="checkbox" bind:checked={partialClose} />
        <span>Partial close</span>
      </label>

      {#if partialClose}
        <div class="partial-box">
          <div class="pb-top">
            <input
              type="number"
              min="0"
              max={position.quantity}
              step="any"
              bind:value={partialQtyStr}
            />
            <div class="pct-chips">
              {#each [0.25, 0.5, 0.75] as pct (pct)}
                <button class="pct-btn" type="button" onclick={() => setPartialPercent(pct)}>
                  {Math.round(pct * 100)}%
                </button>
              {/each}
            </div>
          </div>
          <div class="pb-sub">
            Closing <strong>{formatQty(effectiveCloseQty)}</strong> · Leaving
            <strong>{formatQty(remainingQty)}</strong> open
          </div>
        </div>
      {/if}

      <!-- Send closed trade to Playbook (clearly tagged Simulated) -->
      <label class="chk-row">
        <input type="checkbox" bind:checked={sendToPlaybook} />
        <span>Send closed trade to Playbook <em class="sim-note">(tagged SIM)</em></span>
      </label>

      {#if sendToPlaybook}
        <div class="pb-log-box">
          <div class="pb-grid">
            <label class="mini-f">
              <span>Setup type</span>
              <select bind:value={setupType}>
                {#each setupTypes as st (st)}
                  <option value={st}>{st}</option>
                {/each}
              </select>
            </label>
            <label class="mini-f">
              <span>Grade</span>
              <select bind:value={grade}>
                <option value="A+">A+</option>
                <option value="B">B</option>
                <option value="Mistake">Mistake</option>
              </select>
            </label>
          </div>
          <input
            class="mini-note"
            type="text"
            placeholder="Optional execution note..."
            bind:value={noteDraft}
          />
        </div>
      {/if}

      {#if errorMsg}
        <div class="cd-err">{errorMsg}</div>
      {/if}
    </div>

    <div class="cd-foot">
      <button class="btn-discard" type="button" onclick={onClose}>Discard</button>
      <button class="btn-confirm" type="button" onclick={() => void handleConfirm()}>Confirm</button>
    </div>
  </div>
</div>

<style>
  .close-backdrop {
    position: fixed;
    inset: 0;
    z-index: 270;
    background: rgba(0, 0, 0, 0.52);
    display: grid;
    place-items: center;
    padding: 20px;
  }

  .close-backdrop.light {
    background: rgba(15, 23, 42, 0.3);
  }

  .close-dialog {
    width: 100%;
    max-width: 392px;
    padding: 20px 22px 18px;
    border-radius: 16px;
    background: var(--dark-bg-surface);
    color: var(--dark-text-strong);
    border: 1px solid var(--dark-border);
    box-shadow: var(--dark-shadow-modal);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .close-backdrop.light .close-dialog {
    background: #ffffff;
    color: #131722;
    border-color: #e0e3eb;
    box-shadow: 0 20px 56px rgba(15, 23, 42, 0.22);
  }

  .cd-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .cd-head h2 {
    margin: 0;
    font-size: 16.5px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .cd-x {
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

  .cd-x:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .close-backdrop.light .cd-x:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .cd-x svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .cd-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .pos-row {
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .pos-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .pos-title {
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .pos-est {
    font-size: 12px;
    color: var(--dark-text-secondary);
    display: flex;
    align-items: center;
    gap: 5px;
    font-variant-numeric: tabular-nums;
  }

  .pos-est .pos,
  .est-r.pos {
    color: #089981;
  }

  .pos-est .neg,
  .est-r.neg {
    color: #f23645;
  }

  .chk-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }

  .chk-row input[type='checkbox'] {
    width: 16px;
    height: 16px;
    accent-color: #2962ff;
    cursor: pointer;
  }

  .sim-note {
    font-style: normal;
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .partial-box,
  .pb-log-box {
    padding: 10px 11px;
    border-radius: 10px;
    background: var(--dark-bg-surface-alt);
    border: 1px solid var(--dark-border-subtle);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .close-backdrop.light .partial-box,
  .close-backdrop.light .pb-log-box {
    background: #f5f6f9;
    border-color: #e6e9ef;
  }

  .pb-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pb-top input,
  .mini-f select,
  .mini-note {
    height: 32px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    outline: none;
  }

  .pb-top input {
    flex: 1;
    min-width: 0;
  }

  .close-backdrop.light .pb-top input,
  .close-backdrop.light .mini-f select,
  .close-backdrop.light .mini-note {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .pct-chips {
    display: flex;
    gap: 4px;
  }

  .pct-btn {
    height: 32px;
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

  .close-backdrop.light .pct-btn {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .pb-sub {
    font-size: 11.5px;
    color: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .pb-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 8px;
  }

  .mini-f {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .mini-note {
    width: 100%;
  }

  .cd-err {
    font-size: 11.5px;
    color: #f23645;
  }

  .cd-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 2px;
  }

  .btn-discard,
  .btn-confirm {
    height: 36px;
    padding: 0 16px;
    border-radius: 9px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-discard {
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: var(--dark-text-primary);
  }

  .btn-discard:hover {
    background: var(--dark-hover-strong);
  }

  .close-backdrop.light .btn-discard {
    border-color: #d6dae1;
    color: #131722;
  }

  .btn-confirm {
    border: 0;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
  }

  .btn-confirm:hover {
    opacity: 0.9;
  }

  .close-backdrop.light .btn-confirm {
    background: #131722;
    color: #ffffff;
  }
</style>
