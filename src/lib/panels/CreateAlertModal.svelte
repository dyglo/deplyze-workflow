<script lang="ts">
  import {
    DEFAULT_NOTIFICATIONS,
    OPERATOR_LABELS,
    formatAlertDefaultMessage,
    type AlertNotificationPrefs,
    type AlertOperator,
    type AlertTrigger,
    type NotificationSchedule,
    type TradingAlert
  } from '../alerts/store';
  import {
    SYMBOL_CATALOG,
    formatQuotePrice,
    normalizeSymbolInput,
    symbolBadgeBg
  } from '../watchlist/store';
  import { makeWorkspaceId, playAlertChime } from '../workspace/storage';

  interface Props {
    theme: 'dark' | 'light';
    initialSymbol: string;
    initialShortName: string;
    initialPrice?: number;
    editingAlert?: TradingAlert | null;
    onSave: (alert: TradingAlert) => void;
    onClose: () => void;
  }

  let {
    theme,
    initialSymbol,
    initialShortName,
    initialPrice,
    editingAlert = null,
    onSave,
    onClose
  }: Props = $props();

  const MODAL_WIDTH = 440;
  const TITLE_BAR_HEIGHT = 34;

  function toLocalDateTimeInput(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function defaultExpiryInput(): string {
    const d = new Date(Date.now() + 30 * 86_400_000);
    return toLocalDateTimeInput(d.toISOString());
  }

  // svelte-ignore state_referenced_locally
  let symbol = $state(editingAlert?.symbol ?? initialSymbol ?? 'OANDA:XAUUSD');
  // svelte-ignore state_referenced_locally
  let shortName = $state(editingAlert?.shortName ?? initialShortName ?? 'XAUUSD');
  // svelte-ignore state_referenced_locally
  let operator = $state<AlertOperator>(editingAlert?.operator ?? 'crossing');
  // svelte-ignore state_referenced_locally
  let valueStr = $state(
    editingAlert?.targetPrice !== undefined
      ? String(editingAlert.targetPrice)
      : typeof initialPrice === 'number' && Number.isFinite(initialPrice)
        ? formatQuotePrice(initialPrice, initialShortName).replace(/,/g, '')
        : ''
  );
  // svelte-ignore state_referenced_locally
  let trigger = $state<AlertTrigger>(editingAlert?.trigger ?? 'once');
  // svelte-ignore state_referenced_locally
  let openEnded = $state(editingAlert ? editingAlert.expiresAt === null : false);
  // svelte-ignore state_referenced_locally
  let expiresInput = $state(
    editingAlert?.expiresAt ? toLocalDateTimeInput(editingAlert.expiresAt) : defaultExpiryInput()
  );
  // svelte-ignore state_referenced_locally
  let customMessage = $state(editingAlert?.message ?? '');
  // svelte-ignore state_referenced_locally
  let messageEdited = $state(Boolean(editingAlert));

  // svelte-ignore state_referenced_locally
  let notifications = $state<AlertNotificationPrefs>({
    ...DEFAULT_NOTIFICATIONS,
    ...(editingAlert?.notifications ?? {})
  });
  let draftNotifications = $state<AlertNotificationPrefs>({ ...DEFAULT_NOTIFICATIONS });

  let view = $state<'main' | 'notifications'>('main');
  let symbolMenuOpen = $state(false);
  let symbolQuery = $state('');
  let formError = $state<string | null>(null);

  // Draggable modal state (same crisp feel as SettingsModal)
  let posX = $state(
    typeof window !== 'undefined'
      ? Math.max(16, Math.round((window.innerWidth - MODAL_WIDTH) / 2))
      : 260
  );
  let posY = $state(
    typeof window !== 'undefined' ? Math.max(TITLE_BAR_HEIGHT + 24, 96) : 96
  );
  let dragging = $state(false);
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let modalEl: HTMLDivElement | undefined = $state();

  const autoMessage = $derived.by(() => {
    const num = Number(valueStr);
    if (Number.isFinite(num) && valueStr.trim() !== '') {
      return formatAlertDefaultMessage(shortName, operator, num);
    }
    return `${shortName} ${OPERATOR_LABELS[operator]}`;
  });

  const displayedMessage = $derived(messageEdited ? customMessage : autoMessage);

  const notificationSummary = $derived.by(() => {
    const parts: string[] = [];
    if (notifications.notifyDesktop) parts.push('Desktop');
    if (notifications.showToast) parts.push('Toasts');
    if (notifications.playSound) parts.push('Sound');
    if (notifications.webhookEnabled && notifications.webhookUrl.trim()) parts.push('Webhook');
    return parts.length > 0 ? parts.join(', ') : 'Muted';
  });

  const filteredSymbols = $derived.by(() => {
    const q = symbolQuery.trim().toUpperCase();
    if (!q) return SYMBOL_CATALOG.slice(0, 10);
    return SYMBOL_CATALOG.filter(
      (s) =>
        s.shortName.toUpperCase().includes(q) ||
        s.symbol.toUpperCase().includes(q) ||
        s.description.toUpperCase().includes(q)
    ).slice(0, 10);
  });

  function clampPosition(x: number, y: number): { x: number; y: number } {
    if (typeof window === 'undefined') return { x, y };
    const w = modalEl?.offsetWidth ?? MODAL_WIDTH;
    const minVisible = 120;
    const minX = -w + minVisible;
    const maxX = window.innerWidth - minVisible;
    const minY = TITLE_BAR_HEIGHT + 4;
    const maxY = Math.max(minY, window.innerHeight - 64);
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, x))),
      y: Math.round(Math.min(maxY, Math.max(minY, y)))
    };
  }

  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    dragging = true;
    dragOffsetX = e.clientX - posX;
    dragOffsetY = e.clientY - posY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const next = clampPosition(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
    posX = next.x;
    posY = next.y;
  }

  function onHeaderPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (symbolMenuOpen) {
        symbolMenuOpen = false;
      } else if (view === 'notifications') {
        view = 'main';
      } else {
        onClose();
      }
    }
  }

  function pickSymbol(raw: string) {
    const norm = normalizeSymbolInput(raw);
    symbol = norm.symbol;
    shortName = norm.shortName;
    symbolMenuOpen = false;
    symbolQuery = '';
  }

  function openNotificationsSubView() {
    draftNotifications = { ...notifications };
    view = 'notifications';
  }

  function applyNotifications() {
    notifications = { ...draftNotifications };
    view = 'main';
  }

  function submitAlert() {
    const num = Number(valueStr);
    if (!Number.isFinite(num) || valueStr.trim() === '' || num <= 0) {
      formError = 'Enter a valid target price.';
      return;
    }

    let expiresAt: string | null = null;
    if (!openEnded && expiresInput) {
      const parsed = Date.parse(expiresInput);
      if (Number.isFinite(parsed)) {
        expiresAt = new Date(parsed).toISOString();
      }
    }

    const nowIso = new Date().toISOString();
    const alert: TradingAlert = {
      id: editingAlert?.id ?? makeWorkspaceId('alert'),
      kind: 'price',
      symbol,
      shortName,
      operator,
      targetPrice: num,
      lastSeenPrice:
        editingAlert?.lastSeenPrice ??
        (typeof initialPrice === 'number' &&
        Number.isFinite(initialPrice) &&
        shortName.toUpperCase() === initialShortName.toUpperCase()
          ? initialPrice
          : undefined),
      trigger,
      expiresAt,
      message: (messageEdited ? customMessage.trim() : autoMessage) || autoMessage,
      status: editingAlert?.status === 'paused' ? 'paused' : 'active',
      notifications: { ...notifications },
      createdAt: editingAlert?.createdAt ?? nowIso,
      lastTriggeredAt: editingAlert?.lastTriggeredAt
    };

    onSave(alert);
    onClose();
  }
</script>

<svelte:window onkeydown={onWindowKeyDown} />

<div
  bind:this={modalEl}
  class="alert-modal"
  class:light={theme === 'light'}
  class:dragging
  style:left="{posX}px"
  style:top="{posY}px"
  role="dialog"
  aria-label={view === 'notifications' ? 'Alert notifications' : 'Create alert'}
>
  {#if view === 'main'}
    <!-- Draggable header matching TradingView screenshot -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="modal-header"
      onpointerdown={onHeaderPointerDown}
      onpointermove={onHeaderPointerMove}
      onpointerup={onHeaderPointerUp}
      onpointercancel={onHeaderPointerUp}
    >
      <div class="header-left">
        <span class="modal-title">{editingAlert ? 'Edit alert on' : 'Create alert on'}</span>
        <div class="sym-picker">
          <button
            class="sym-trigger"
            type="button"
            onclick={() => (symbolMenuOpen = !symbolMenuOpen)}
          >
            <span class="sym-dot" style:background={symbolBadgeBg(shortName)}>
              {shortName.slice(0, 2)}
            </span>
            <span>{shortName}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
            </svg>
          </button>

          {#if symbolMenuOpen}
            <div class="sym-dropdown">
              <input
                type="text"
                placeholder="Type symbol..."
                bind:value={symbolQuery}
                onkeydown={(e) => {
                  if (e.key === 'Enter' && symbolQuery.trim()) pickSymbol(symbolQuery);
                }}
              />
              <div class="sym-list">
                {#each filteredSymbols as entry (entry.symbol)}
                  <button
                    class="sym-opt"
                    type="button"
                    onclick={() => pickSymbol(entry.symbol)}
                  >
                    <strong>{entry.shortName}</strong>
                    <span>{entry.description}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>

      <button class="close-btn" type="button" aria-label="Close" onclick={onClose}>
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="m4.5 4.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>

    <div class="modal-body">
      <!-- Condition -->
      <div class="form-row top-align">
        <span class="row-label">Condition</span>
        <div class="row-controls stack">
          <div class="static-select">Price</div>
          <select class="tv-select" bind:value={operator}>
            <option value="crossing">Crossing</option>
            <option value="crossing_up">Crossing Up</option>
            <option value="crossing_down">Crossing Down</option>
            <option value="greater_than">Greater Than</option>
            <option value="less_than">Less Than</option>
          </select>
          <div class="value-split">
            <div class="value-kind">Value</div>
            <input
              class="tv-input num"
              type="number"
              step="any"
              placeholder="Target price"
              bind:value={valueStr}
              oninput={() => (formError = null)}
            />
          </div>
        </div>
      </div>

      <div class="row-divider"></div>

      <!-- Trigger -->
      <div class="form-row">
        <span class="row-label">Trigger</span>
        <div class="row-controls">
          <select class="tv-select compact" bind:value={trigger}>
            <option value="once">Once only</option>
            <option value="every">Every time</option>
          </select>
        </div>
      </div>

      <!-- Expiration -->
      <div class="form-row">
        <span class="row-label">Expiration</span>
        <div class="row-controls exp-row">
          {#if openEnded}
            <span class="open-ended-lbl">Open-ended</span>
          {:else}
            <input class="tv-input date-in" type="datetime-local" bind:value={expiresInput} />
          {/if}
          <button
            class="mini-link"
            type="button"
            onclick={() => (openEnded = !openEnded)}
          >
            {openEnded ? 'Set date' : 'Open-ended'}
          </button>
        </div>
      </div>

      <!-- Message -->
      <div class="form-row">
        <span class="row-label">Message</span>
        <div class="row-controls">
          <input
            class="tv-input"
            type="text"
            placeholder="Custom note (e.g. Demand tap — watch 5m CHoCH)"
            value={displayedMessage}
            oninput={(e) => {
              messageEdited = true;
              customMessage = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </div>
      </div>

      <!-- Notifications summary row -->
      <div class="form-row">
        <span class="row-label">Notifications</span>
        <div class="row-controls">
          <button class="nav-row-btn" type="button" onclick={openNotificationsSubView}>
            <span>{notificationSummary}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m6 4 4 4-4 4" />
            </svg>
          </button>
        </div>
      </div>

      {#if formError}
        <div class="form-err">{formError}</div>
      {/if}
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick={onClose}>Cancel</button>
      <button class="btn-primary" type="button" onclick={submitAlert}>
        {editingAlert ? 'Save' : 'Create'}
      </button>
    </div>
  {:else}
    <!-- Notifications sub-view matching Screenshot 5 -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="modal-header"
      onpointerdown={onHeaderPointerDown}
      onpointermove={onHeaderPointerMove}
      onpointerup={onHeaderPointerUp}
      onpointercancel={onHeaderPointerUp}
    >
      <div class="header-left">
        <button class="back-btn" type="button" aria-label="Back" onclick={() => (view = 'main')}>
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="m11 4.5-4.5 4.5L11 13.5" />
          </svg>
        </button>
        <span class="modal-title">Notifications</span>
      </div>

      <button class="close-btn" type="button" aria-label="Close" onclick={onClose}>
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="m4.5 4.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>

    <div class="modal-body notif-body">
      <label class="check-item">
        <input type="checkbox" bind:checked={draftNotifications.notifyDesktop} />
        <span class="check-copy">
          <span class="check-title">Notify on desktop</span>
          <span class="check-desc">Sends a native Windows notification even when minimized.</span>
        </span>
      </label>

      <label class="check-item">
        <input type="checkbox" bind:checked={draftNotifications.showToast} />
        <span class="check-copy">
          <span class="check-title">Show toast notification</span>
          <span class="check-desc">Displays an onsite notification in the window corner.</span>
        </span>
      </label>

      <div class="check-item-row">
        <label class="check-item">
          <input type="checkbox" bind:checked={draftNotifications.playSound} />
          <span class="check-copy">
            <span class="check-title">Play sound</span>
            <span class="check-desc">Plays an audio cue when your alert triggers.</span>
          </span>
        </label>
        <button class="test-sound" type="button" onclick={playAlertChime}>Test</button>
      </div>

      <div class="webhook-block">
        <label class="check-item">
          <input type="checkbox" bind:checked={draftNotifications.webhookEnabled} />
          <span class="check-copy">
            <span class="check-title">Webhook URL</span>
            <span class="check-desc">Sends a POST JSON request to your URL when triggered.</span>
          </span>
        </label>
        {#if draftNotifications.webhookEnabled}
          <input
            class="tv-input webhook-input"
            type="url"
            placeholder="https://discord.com/api/webhooks/..."
            bind:value={draftNotifications.webhookUrl}
          />
        {/if}
      </div>

      <div class="row-divider"></div>

      <div class="schedule-block">
        <div class="schedule-row">
          <span class="check-title">Notification schedule</span>
          <select
            class="tv-select schedule-select"
            value={draftNotifications.schedule}
            onchange={(e) =>
              (draftNotifications.schedule = (e.currentTarget as HTMLSelectElement)
                .value as NotificationSchedule)
            }
          >
            <option value="24/7">24/7</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="sessions">Sessions (07:00–22:00)</option>
          </select>
        </div>
        <span class="check-desc">Notifications are muted outside this schedule.</span>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick={() => (view = 'main')}>Cancel</button>
      <button class="btn-primary" type="button" onclick={applyNotifications}>Apply</button>
    </div>
  {/if}
</div>

<style>
  /* Exact dark glass tokens matching SettingsModal.svelte */
  .alert-modal {
    --am-bg: rgba(18, 18, 18, 0.86);
    --am-border: rgba(255, 255, 255, 0.12);
    --am-divider: rgba(255, 255, 255, 0.09);
    --am-text: #f0f0f0;
    --am-secondary: #8c8c92;
    --am-control-bg: rgba(16, 16, 16, 0.65);
    --am-control-border: rgba(255, 255, 255, 0.16);
    --am-hover: rgba(255, 255, 255, 0.06);
    --am-btn-bg: #f0f0f0;
    --am-btn-fg: #0d0d0d;
    --am-shadow: 0 20px 56px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.1);

    position: fixed;
    z-index: 110;
    width: 440px;
    max-width: calc(100vw - 32px);
    border-radius: 12px;
    color: var(--am-text);
    background: var(--am-bg);
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
    box-shadow: var(--am-shadow);
    display: flex;
    flex-direction: column;
    user-select: none;
  }

  .alert-modal.light {
    --am-bg: #ffffff;
    --am-border: #e0e3eb;
    --am-divider: #eceef2;
    --am-text: #131722;
    --am-secondary: #6a6d78;
    --am-control-bg: #ffffff;
    --am-control-border: #d8dce6;
    --am-hover: rgba(0, 0, 0, 0.04);
    --am-btn-bg: #131722;
    --am-btn-fg: #ffffff;
    --am-shadow: 0 14px 40px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .modal-header {
    height: 54px;
    padding: 0 18px;
    border-bottom: 1px solid var(--am-divider);
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
    touch-action: none;
  }

  .alert-modal.dragging .modal-header {
    cursor: grabbing;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .modal-title {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }

  .back-btn,
  .close-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--am-text);
    background: transparent;
    cursor: pointer;
  }

  .back-btn:hover,
  .close-btn:hover {
    background: var(--am-hover);
  }

  .back-btn svg,
  .close-btn svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.65;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .sym-picker {
    position: relative;
  }

  .sym-trigger {
    height: 28px;
    padding: 0 8px 0 5px;
    border: 0;
    border-radius: 7px;
    background: var(--am-hover);
    color: var(--am-text);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 13.5px;
    font-weight: 700;
    cursor: pointer;
  }

  .sym-trigger svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
  }

  .sym-dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: #fff;
    font-size: 8.5px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }

  .sym-dropdown {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    width: 240px;
    padding: 6px;
    border-radius: 10px;
    border: 1px solid var(--am-border);
    background: var(--am-bg);
    backdrop-filter: blur(22px);
    box-shadow: var(--am-shadow);
    z-index: 20;
  }

  .sym-dropdown input {
    width: 100%;
    box-sizing: border-box;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    color: var(--am-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .sym-list {
    margin-top: 5px;
    max-height: 180px;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sym-list::-webkit-scrollbar {
    display: none;
  }

  .sym-opt {
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--am-text);
    display: flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }

  .sym-opt:hover {
    background: var(--am-hover);
  }

  .sym-opt span {
    color: var(--am-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .modal-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .form-row {
    display: grid;
    grid-template-columns: 96px 1fr;
    align-items: center;
    gap: 12px;
  }

  .form-row.top-align {
    align-items: start;
  }

  .form-row.top-align .row-label {
    padding-top: 8px;
  }

  .row-label {
    font-size: 12.5px;
    color: var(--am-secondary);
  }

  .row-controls {
    min-width: 0;
  }

  .row-controls.stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .static-select,
  .tv-select,
  .tv-input {
    width: 100%;
    box-sizing: border-box;
    height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    color: var(--am-text);
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .tv-select option {
    background: #181a22;
    color: #f0f0f0;
  }

  .alert-modal.light .tv-select option {
    background: #ffffff;
    color: #131722;
  }

  .static-select {
    display: flex;
    align-items: center;
  }

  .value-split {
    display: grid;
    grid-template-columns: 92px 1fr;
    gap: 8px;
  }

  .value-kind {
    height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    display: flex;
    align-items: center;
    font-size: 13px;
    color: var(--am-secondary);
  }

  .tv-input.num {
    font-variant-numeric: tabular-nums;
  }

  .tv-select.compact {
    width: auto;
    min-width: 140px;
  }

  .exp-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .date-in {
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }

  .open-ended-lbl {
    font-size: 13px;
    font-weight: 500;
  }

  .mini-link {
    border: 0;
    background: transparent;
    color: #2962ff;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    padding: 2px 4px;
  }

  .nav-row-btn {
    width: 100%;
    height: 32px;
    padding: 0 6px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--am-text);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .nav-row-btn:hover {
    background: var(--am-hover);
  }

  .nav-row-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: var(--am-secondary);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .row-divider {
    height: 1px;
    background: var(--am-divider);
  }

  .form-err {
    font-size: 12px;
    color: #f23645;
  }

  /* Notifications sub-view */
  .notif-body {
    gap: 14px;
  }

  .check-item-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .check-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
  }

  .check-item input[type='checkbox'] {
    margin-top: 2px;
    width: 16px;
    height: 16px;
    accent-color: #131722;
    cursor: pointer;
  }

  .alert-modal:not(.light) .check-item input[type='checkbox'] {
    accent-color: #f0f0f0;
  }

  .check-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .check-title {
    font-size: 13px;
    font-weight: 600;
  }

  .check-desc {
    font-size: 11.5px;
    color: var(--am-secondary);
    line-height: 1.35;
  }

  .test-sound {
    height: 24px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid var(--am-control-border);
    background: transparent;
    color: var(--am-text);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .test-sound:hover {
    background: var(--am-hover);
  }

  .webhook-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .webhook-input {
    margin-left: 26px;
    width: calc(100% - 26px);
  }

  .schedule-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .schedule-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .schedule-select {
    width: 185px;
  }

  .modal-footer {
    padding: 12px 18px 16px;
    border-top: 1px solid var(--am-divider);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-cancel,
  .btn-primary {
    height: 34px;
    padding: 0 16px;
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-cancel {
    border: 1px solid var(--am-control-border);
    background: transparent;
    color: var(--am-text);
  }

  .btn-cancel:hover {
    background: var(--am-hover);
  }

  .btn-primary {
    border: 0;
    background: var(--am-btn-bg);
    color: var(--am-btn-fg);
  }
</style>
