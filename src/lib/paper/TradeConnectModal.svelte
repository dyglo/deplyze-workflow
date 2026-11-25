<script lang="ts">
  import { onMount } from 'svelte';
  import {
    connectPaperLedger,
    createNewPaperAccount,
    getActivePaperAccount,
    resetPaperAccount,
    subscribePaper,
    switchPaperAccount,
    updatePaperSettings
  } from './store';
  import type { PaperLedgerState } from './types';

  interface Props {
    theme: 'dark' | 'light';
    mode: 'connect' | 'settings';
    onClose: () => void;
  }

  let { theme, mode, onClose }: Props = $props();

  const LEVERAGE_OPTIONS = [1, 10, 20, 50, 100, 200, 500];

  let ledger = $state<PaperLedgerState | null>(null);
  let step = $state<'choose' | 'confirm'>('choose');

  let balanceDraft = $state(100000);
  let leverageDraft = $state(500);
  let commissionDraft = $state(0);
  let zeroSpreadDraft = $state(false);
  let oneClickDraft = $state(false);
  let showOnChartDraft = $state(true);

  let creatingNew = $state(false);
  let newAcctName = $state('');
  let newAcctBal = $state(100000);
  let newAcctLev = $state(500);
  let confirmReset = $state(false);

  const account = $derived(ledger ? getActivePaperAccount(ledger) : null);

  onMount(() => {
    const unsub = subscribePaper((s) => {
      ledger = s;
      const acc = getActivePaperAccount(s);
      if (acc) {
        balanceDraft = acc.settings.startingBalance;
        leverageDraft = acc.settings.leverage;
        commissionDraft = acc.settings.commissionPerOrder;
        zeroSpreadDraft = acc.settings.zeroSpread;
        oneClickDraft = acc.settings.oneClickTrading;
        showOnChartDraft = acc.settings.showOnChart;
      }
    });
    return unsub;
  });

  function handleConnect() {
    connectPaperLedger({
      startingBalance: balanceDraft,
      leverage: leverageDraft,
      openTicket: true
    });
    onClose();
  }

  function handleSaveSettings() {
    updatePaperSettings({
      leverage: leverageDraft,
      commissionPerOrder: Math.max(0, Number(commissionDraft) || 0),
      zeroSpread: zeroSpreadDraft,
      oneClickTrading: oneClickDraft,
      showOnChart: showOnChartDraft
    });
    onClose();
  }

  function handleResetConfirm() {
    resetPaperAccount(balanceDraft, leverageDraft);
    confirmReset = false;
    onClose();
  }

  function handleCreateAccount() {
    const clean = newAcctName.trim();
    if (!clean) return;
    createNewPaperAccount(clean, newAcctBal, newAcctLev);
    creatingNew = false;
    newAcctName = '';
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-backdrop"
  class:light={theme === 'light'}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="modal-card" role="dialog" aria-modal="true" aria-label="Paper Ledger">
    {#if mode === 'connect' && step === 'choose'}
      <div class="modal-head">
        <h2>Practice risk-free</h2>
        <button class="close-x" type="button" aria-label="Close" onclick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>

      <button class="provider-card" type="button" onclick={() => (step = 'confirm')}>
        <span class="provider-logo" aria-hidden="true">PL</span>
        <div class="provider-copy">
          <div class="provider-name">Paper Ledger</div>
          <div class="provider-sub">Simulated trading engine · Local workspace</div>
        </div>
        <svg class="provider-arrow" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </button>

      <p class="hint-foot">
        Simulated trades are saved locally to your workspace and isolated from live Playbook stats.
      </p>
    {:else if mode === 'connect' && step === 'confirm'}
      <div class="modal-head">
        <div class="confirm-title-wrap">
          <span class="provider-logo sm" aria-hidden="true">PL</span>
          <h2>Paper Ledger</h2>
        </div>
        <button class="close-x" type="button" aria-label="Close" onclick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>

      {#if account && account.positions.length === 0 && account.tradeHistory.length === 0 && account.orderHistory.length === 0}
        <div class="quick-setup-row">
          <label class="q-field">
            <span>Starting balance (USD)</span>
            <input type="number" min="100" step="1000" bind:value={balanceDraft} />
          </label>
          <label class="q-field">
            <span>Leverage</span>
            <select bind:value={leverageDraft}>
              {#each LEVERAGE_OPTIONS as lev (lev)}
                <option value={lev}>{lev}:1</option>
              {/each}
            </select>
          </label>
        </div>
      {/if}

      <button class="connect-cta" type="button" onclick={handleConnect}>Connect</button>

      <div class="connect-desc">
        <p>
          Paper Ledger (simulated trading) lets you practice buying and selling instruments using
          live quotes from your charts and watchlist—with no real money at risk.
        </p>
        <p>
          Track positions, working orders, live R-multiples, equity curve, and drawdown locally.
          Any trade sent to Playbook is tagged <strong>SIM</strong> so it never mixes with live results.
        </p>
      </div>
    {:else if account}
      <!-- Settings & Account Management -->
      <div class="modal-head">
        <div class="confirm-title-wrap">
          <span class="provider-logo sm" aria-hidden="true">PL</span>
          <h2>Paper Ledger Settings</h2>
        </div>
        <button class="close-x" type="button" aria-label="Close" onclick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>

      {#if ledger && ledger.accounts.length > 0}
        <div class="acct-switcher">
          <div class="sw-head">
            <span class="sw-label">Active account</span>
            <button
              class="link-btn"
              type="button"
              onclick={() => (creatingNew = !creatingNew)}
            >
              {creatingNew ? 'Cancel' : '+ New account'}
            </button>
          </div>

          {#if creatingNew}
            <div class="new-acct-box">
              <input
                type="text"
                placeholder="Account name (e.g. Gold 10k Challenge)"
                bind:value={newAcctName}
              />
              <div class="quick-setup-row">
                <label class="q-field">
                  <span>Balance (USD)</span>
                  <input type="number" min="100" step="1000" bind:value={newAcctBal} />
                </label>
                <label class="q-field">
                  <span>Leverage</span>
                  <select bind:value={newAcctLev}>
                    {#each LEVERAGE_OPTIONS as lev (lev)}
                      <option value={lev}>{lev}:1</option>
                    {/each}
                  </select>
                </label>
              </div>
              <button
                class="secondary-cta"
                type="button"
                disabled={!newAcctName.trim()}
                onclick={handleCreateAccount}
              >
                Create & Switch
              </button>
            </div>
          {:else}
            <div class="acct-pills">
              {#each ledger.accounts as a (a.id)}
                <button
                  class="acct-pill"
                  class:active={a.id === account.id}
                  type="button"
                  onclick={() => switchPaperAccount(a.id)}
                >
                  <span>{a.name}</span>
                  <span class="acct-bal">{a.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="quick-setup-row">
        <label class="q-field">
          <span>Leverage</span>
          <select bind:value={leverageDraft}>
            {#each LEVERAGE_OPTIONS as lev (lev)}
              <option value={lev}>{lev}:1</option>
            {/each}
          </select>
        </label>
        <label class="q-field">
          <span>Commission / order ($)</span>
          <input type="number" min="0" step="0.5" bind:value={commissionDraft} />
        </label>
      </div>

      <div class="toggle-list">
        <label class="toggle-row">
          <div>
            <div class="t-title">Show Buy/Sell & position markers on chart</div>
            <div class="t-sub">Top-left Bid/Ask pills and active trade badges</div>
          </div>
          <input type="checkbox" bind:checked={showOnChartDraft} />
        </label>

        <label class="toggle-row">
          <div>
            <div class="t-title">Zero-spread (mid-price) fills</div>
            <div class="t-sub">Fill orders at exact chart last price without synthetic spread</div>
          </div>
          <input type="checkbox" bind:checked={zeroSpreadDraft} />
        </label>

        <label class="toggle-row">
          <div>
            <div class="t-title">Instant 1-click chart execution</div>
            <div class="t-sub">Clicking chart SELL/BUY pills fires a market order immediately</div>
          </div>
          <input type="checkbox" bind:checked={oneClickDraft} />
        </label>
      </div>

      <div class="reset-box">
        {#if confirmReset}
          <div class="reset-confirm">
            <label class="q-field">
              <span>Reset balance to (USD)</span>
              <input type="number" min="100" step="1000" bind:value={balanceDraft} />
            </label>
            <div class="reset-actions">
              <button class="ghost-btn" type="button" onclick={() => (confirmReset = false)}>
                Cancel
              </button>
              <button class="danger-btn" type="button" onclick={handleResetConfirm}>
                Confirm Reset
              </button>
            </div>
          </div>
        {:else}
          <button class="reset-trigger" type="button" onclick={() => (confirmReset = true)}>
            Reset account balance & history...
          </button>
        {/if}
      </div>

      <div class="modal-foot">
        <button class="ghost-btn" type="button" onclick={onClose}>Cancel</button>
        <button class="save-cta" type="button" onclick={handleSaveSettings}>Save changes</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 260;
    background: rgba(0, 0, 0, 0.56);
    display: grid;
    place-items: center;
    padding: 20px;
  }

  .modal-backdrop.light {
    background: rgba(15, 23, 42, 0.34);
  }

  .modal-card {
    width: 100%;
    max-width: 420px;
    padding: 22px 24px 20px;
    border-radius: 16px;
    background: var(--dark-bg-surface);
    color: var(--dark-text-strong);
    border: 1px solid var(--dark-border);
    box-shadow: var(--dark-shadow-modal);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .modal-backdrop.light .modal-card {
    background: #ffffff;
    color: #131722;
    border-color: #e0e3eb;
    box-shadow: 0 20px 56px rgba(15, 23, 42, 0.22);
  }

  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .modal-head h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .confirm-title-wrap {
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .close-x {
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

  .close-x:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .modal-backdrop.light .close-x {
    color: #6a7282;
  }

  .modal-backdrop.light .close-x:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .close-x svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .provider-card {
    width: 100%;
    padding: 18px 16px;
    border-radius: 12px;
    border: 1px solid var(--dark-border-strong);
    background: var(--dark-bg-surface-alt);
    color: inherit;
    font-family: inherit;
    display: flex;
    align-items: center;
    gap: 14px;
    cursor: pointer;
    text-align: left;
    transition: border-color 140ms ease, background-color 140ms ease;
  }

  .provider-card:hover {
    border-color: var(--dark-handle);
    background: var(--dark-bg-elevated);
  }

  .modal-backdrop.light .provider-card {
    background: #ffffff;
    border-color: #e0e3eb;
  }

  .modal-backdrop.light .provider-card:hover {
    background: #f8f9fc;
    border-color: #c3c8d4;
  }

  .provider-logo {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: #ebebeb;
    color: #0d0d0d;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.04em;
    display: grid;
    place-items: center;
    flex: 0 0 44px;
  }

  .provider-logo.sm {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    font-size: 13px;
    flex-basis: 34px;
  }

  .modal-backdrop.light .provider-logo {
    background: #131722;
    color: #ffffff;
  }

  .provider-copy {
    flex: 1;
    min-width: 0;
  }

  .provider-name {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 3px;
  }

  .provider-sub {
    font-size: 12.5px;
    color: var(--dark-text-secondary);
  }

  .modal-backdrop.light .provider-sub {
    color: #6a7282;
  }

  .provider-arrow {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--dark-text-secondary);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .hint-foot {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--dark-text-secondary);
  }

  .modal-backdrop.light .hint-foot {
    color: #6a7282;
  }

  .quick-setup-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .q-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11.5px;
    color: var(--dark-text-secondary);
  }

  .modal-backdrop.light .q-field {
    color: #6a7282;
  }

  .q-field input,
  .q-field select,
  .new-acct-box input {
    height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--dark-border-control);
    background: var(--dark-bg-input);
    color: var(--dark-text-strong);
    font-family: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    outline: none;
  }

  .q-field input:focus,
  .q-field select:focus,
  .new-acct-box input:focus {
    border-color: var(--dark-handle-hover);
  }

  .modal-backdrop.light .q-field input,
  .modal-backdrop.light .q-field select,
  .modal-backdrop.light .new-acct-box input {
    background: #ffffff;
    border-color: #d6dae1;
    color: #131722;
  }

  .connect-cta {
    width: 100%;
    height: 42px;
    border: 0;
    border-radius: 10px;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 130ms ease;
  }

  .connect-cta:hover {
    opacity: 0.9;
  }

  .modal-backdrop.light .connect-cta {
    background: #131722;
    color: #ffffff;
  }

  .connect-desc {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .connect-desc p {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--dark-text-secondary);
  }

  .modal-backdrop.light .connect-desc p {
    color: #5d6473;
  }

  .acct-switcher {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .sw-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sw-label {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--dark-text-secondary);
  }

  .link-btn {
    border: 0;
    background: transparent;
    color: #2962ff;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
  }

  .acct-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .acct-pill {
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--dark-border-strong);
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-primary);
    font-family: inherit;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .acct-pill.active {
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    border-color: transparent;
    font-weight: 600;
  }

  .modal-backdrop.light .acct-pill {
    background: #f5f6f9;
    border-color: #e0e3eb;
    color: #131722;
  }

  .modal-backdrop.light .acct-pill.active {
    background: #131722;
    color: #ffffff;
  }

  .acct-bal {
    opacity: 0.72;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }

  .new-acct-box {
    padding: 10px;
    border-radius: 10px;
    background: var(--dark-bg-surface-alt);
    border: 1px solid var(--dark-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .modal-backdrop.light .new-acct-box {
    background: #f8f9fc;
    border-color: #e0e3eb;
  }

  .secondary-cta {
    height: 34px;
    border-radius: 8px;
    border: 0;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .secondary-cta:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .toggle-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--dark-bg-surface-alt);
    border: 1px solid var(--dark-border-subtle);
  }

  .modal-backdrop.light .toggle-list {
    background: #f8f9fc;
    border-color: #eceff4;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
  }

  .t-title {
    font-size: 12.5px;
    font-weight: 500;
  }

  .t-sub {
    font-size: 11px;
    color: var(--dark-text-secondary);
    margin-top: 1px;
  }

  .modal-backdrop.light .t-sub {
    color: #6a7282;
  }

  .toggle-row input[type='checkbox'] {
    width: 16px;
    height: 16px;
    accent-color: #2962ff;
    cursor: pointer;
    flex: 0 0 16px;
  }

  .reset-box {
    padding-top: 2px;
  }

  .reset-trigger {
    border: 0;
    background: transparent;
    color: #f23645;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
  }

  .reset-confirm {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(242, 54, 69, 0.35);
    background: rgba(242, 54, 69, 0.08);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .reset-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
  }

  .ghost-btn,
  .save-cta,
  .danger-btn {
    height: 34px;
    padding: 0 14px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .ghost-btn {
    border: 1px solid var(--dark-border-control);
    background: transparent;
    color: var(--dark-text-primary);
  }

  .modal-backdrop.light .ghost-btn {
    border-color: #d6dae1;
    color: #131722;
  }

  .save-cta {
    border: 0;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
  }

  .modal-backdrop.light .save-cta {
    background: #131722;
    color: #ffffff;
  }

  .danger-btn {
    border: 0;
    background: #f23645;
    color: #ffffff;
  }
</style>
