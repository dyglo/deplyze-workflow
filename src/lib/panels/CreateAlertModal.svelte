<script lang="ts">
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
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
    normalizeSymbolInput
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

  type ExpiryPreset = 'open' | '1d' | '7d' | '30d' | '90d';
  type OpenMenu = 'symbol' | 'operator' | 'trigger' | 'expiry' | 'schedule' | null;

  const OPERATOR_OPTIONS: { id: AlertOperator; label: string }[] = [
    { id: 'crossing', label: 'Crossing' },
    { id: 'crossing_up', label: 'Crossing Up' },
    { id: 'crossing_down', label: 'Crossing Down' },
    { id: 'greater_than', label: 'Greater Than' },
    { id: 'less_than', label: 'Less Than' }
  ];

  const TRIGGER_OPTIONS: { id: AlertTrigger; label: string }[] = [
    { id: 'once', label: 'Once only' },
    { id: 'every', label: 'Every time' }
  ];

  const EXPIRY_OPTIONS: { id: ExpiryPreset; label: string; days: number | null }[] = [
    { id: '30d', label: 'In 30 days', days: 30 },
    { id: '7d', label: 'In 7 days', days: 7 },
    { id: '1d', label: 'In 24 hours', days: 1 },
    { id: '90d', label: 'In 90 days', days: 90 },
    { id: 'open', label: 'Open-ended', days: null }
  ];

  const SCHEDULE_OPTIONS: { id: NotificationSchedule; label: string }[] = [
    { id: '24/7', label: '24/7' },
    { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
    { id: 'sessions', label: 'Sessions (07:00–22:00)' }
  ];

  function parseTargetPrice(raw: unknown): number | null {
    const text = String(raw ?? '').replace(/,/g, '').trim();
    if (!text) return null;
    const num = Number(text);
    return Number.isFinite(num) ? num : null;
  }

  function formatExpiryDate(iso: string): string {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return 'Open-ended';
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(ms));
  }

  function isEditingCustomMessage(alert: TradingAlert | null): boolean {
    if (!alert || !alert.message.trim()) return false;
    if (typeof alert.targetPrice === 'number' && Number.isFinite(alert.targetPrice)) {
      const auto = formatAlertDefaultMessage(
        alert.shortName,
        alert.operator ?? 'crossing',
        alert.targetPrice
      );
      return alert.message.trim() !== auto.trim();
    }
    return true;
  }

  // svelte-ignore state_referenced_locally
  let symbol = $state(editingAlert?.symbol ?? initialSymbol ?? 'OANDA:XAUUSD');
  // svelte-ignore state_referenced_locally
  let shortName = $state(editingAlert?.shortName ?? initialShortName ?? 'XAUUSD');
  // svelte-ignore state_referenced_locally
  let operator = $state<AlertOperator>(editingAlert?.operator ?? 'crossing');
  // svelte-ignore state_referenced_locally
  let valueStr = $state<string>(
    editingAlert?.targetPrice !== undefined
      ? String(editingAlert.targetPrice)
      : typeof initialPrice === 'number' && Number.isFinite(initialPrice)
        ? formatQuotePrice(initialPrice, initialShortName).replace(/,/g, '')
        : ''
  );
  // svelte-ignore state_referenced_locally
  let trigger = $state<AlertTrigger>(editingAlert?.trigger ?? 'once');
  // svelte-ignore state_referenced_locally
  let expiryPreset = $state<ExpiryPreset>(
    editingAlert ? (editingAlert.expiresAt === null ? 'open' : '30d') : '30d'
  );
  // svelte-ignore state_referenced_locally
  let preservedExpiresAt = $state<string | null>(editingAlert?.expiresAt ?? null);
  let expiryChanged = $state(false);
  // svelte-ignore state_referenced_locally
  let customMessage = $state(editingAlert?.message ?? '');
  // svelte-ignore state_referenced_locally
  let messageEdited = $state(isEditingCustomMessage(editingAlert));

  // Committed notification prefs
  // svelte-ignore state_referenced_locally
  let notifyDesktop = $state(
    editingAlert?.notifications?.notifyDesktop ?? DEFAULT_NOTIFICATIONS.notifyDesktop
  );
  // svelte-ignore state_referenced_locally
  let showToast = $state(
    editingAlert?.notifications?.showToast ?? DEFAULT_NOTIFICATIONS.showToast
  );
  // svelte-ignore state_referenced_locally
  let playSound = $state(
    editingAlert?.notifications?.playSound ?? DEFAULT_NOTIFICATIONS.playSound
  );
  // svelte-ignore state_referenced_locally
  let webhookEnabled = $state(
    editingAlert?.notifications?.webhookEnabled ?? DEFAULT_NOTIFICATIONS.webhookEnabled
  );
  // svelte-ignore state_referenced_locally
  let webhookUrl = $state(
    editingAlert?.notifications?.webhookUrl ?? DEFAULT_NOTIFICATIONS.webhookUrl
  );
  // svelte-ignore state_referenced_locally
  let schedule = $state<NotificationSchedule>(
    editingAlert?.notifications?.schedule ?? DEFAULT_NOTIFICATIONS.schedule
  );

  // Draft values for Notifications sub-view (plain primitive $state)
  let draftDesktop = $state(true);
  let draftToast = $state(true);
  let draftSound = $state(true);
  let draftWebhookEnabled = $state(false);
  let draftWebhookUrl = $state('');
  let draftSchedule = $state<NotificationSchedule>('24/7');

  let view = $state<'main' | 'notifications'>('main');
  let openMenu = $state<OpenMenu>(null);
  let symbolQuery = $state('');
  let formError = $state<string | null>(null);
  let notifError = $state<string | null>(null);

  // Floating modal drag state (clamped cleanly inside window)
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
  let dragPointerId: number | null = null;
  let modalEl: HTMLDivElement | undefined = $state();
  let headerEl: HTMLElement | undefined = $state();

  const autoMessage = $derived.by(() => {
    const num = parseTargetPrice(valueStr);
    if (num !== null) {
      return formatAlertDefaultMessage(shortName, operator, num);
    }
    return `${shortName} ${OPERATOR_LABELS[operator]}`;
  });

  const displayedMessage = $derived(messageEdited ? customMessage : autoMessage);

  const expiryDisplayLabel = $derived.by(() => {
    if (!expiryChanged && preservedExpiresAt !== null) {
      return formatExpiryDate(preservedExpiresAt);
    }
    const opt = EXPIRY_OPTIONS.find((o) => o.id === expiryPreset);
    if (!opt || opt.days === null) return 'Open-ended';
    return formatExpiryDate(new Date(Date.now() + opt.days * 86_400_000).toISOString());
  });

  const notificationSummary = $derived.by(() => {
    const parts: string[] = [];
    if (notifyDesktop) parts.push('Desktop');
    if (showToast) parts.push('Toasts');
    if (playSound) parts.push('Sound');
    if (webhookEnabled && String(webhookUrl ?? '').trim()) parts.push('Webhook');
    return parts.length > 0 ? parts.join(', ') : 'Muted';
  });

  const filteredSymbols = $derived.by(() => {
    const q = String(symbolQuery ?? '').trim().toUpperCase();
    if (!q) return SYMBOL_CATALOG.slice(0, 10);
    return SYMBOL_CATALOG.filter(
      (s) =>
        s.shortName.toUpperCase().includes(q) ||
        s.symbol.toUpperCase().includes(q) ||
        s.description.toUpperCase().includes(q)
    ).slice(0, 10);
  });

  function clampPosition(x: number, y: number, ensureFullHeight = false): { x: number; y: number } {
    if (typeof window === 'undefined') return { x, y };
    const w = modalEl?.offsetWidth ?? MODAL_WIDTH;
    const h = modalEl?.offsetHeight ?? 420;
    const minVisible = 120;
    const minX = ensureFullHeight ? 12 : -w + minVisible;
    const maxX = ensureFullHeight
      ? Math.max(12, window.innerWidth - w - 12)
      : window.innerWidth - minVisible;
    const minY = TITLE_BAR_HEIGHT + 4;
    const maxY = ensureFullHeight
      ? Math.max(minY, window.innerHeight - h - 12)
      : Math.max(minY, window.innerHeight - 64);
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, x))),
      y: Math.round(Math.min(maxY, Math.max(minY, y)))
    };
  }

  function keepModalInViewport() {
    if (typeof window === 'undefined') return;
    requestAnimationFrame(() => {
      if (!modalEl) return;
      const h = modalEl.offsetHeight;
      if (posY + h > window.innerHeight - 12) {
        const next = clampPosition(posX, posY, true);
        posX = next.x;
        posY = next.y;
      }
    });
  }

  function endDrag() {
    if (dragPointerId !== null && headerEl) {
      try {
        if (headerEl.hasPointerCapture(dragPointerId)) {
          headerEl.releasePointerCapture(dragPointerId);
        }
      } catch {
        // ignore if already released
      }
    }
    dragPointerId = null;
    if (dragging) dragging = false;
  }

  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (target?.closest?.('button, input, textarea, select, [data-am-menu]')) return;
    openMenu = null;
    dragging = true;
    dragPointerId = e.pointerId;
    dragOffsetX = e.clientX - posX;
    dragOffsetY = e.clientY - posY;
    try {
      headerEl?.setPointerCapture(e.pointerId);
    } catch {
      // fallback to window listeners + drag-shield
    }
    e.preventDefault();
  }

  function onWindowPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const next = clampPosition(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
    posX = next.x;
    posY = next.y;
  }

  function onWindowPointerUp() {
    endDrag();
  }

  function onWindowBlur() {
    endDrag();
    openMenu = null;
  }

  function onWindowResize() {
    openMenu = null;
    const next = clampPosition(posX, posY, true);
    posX = next.x;
    posY = next.y;
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!openMenu) return;
    const target = e.target as Element | null;
    if (!target || !target.closest?.('[data-am-menu]')) {
      openMenu = null;
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (openMenu) {
        openMenu = null;
      } else if (view === 'notifications') {
        cancelNotifications();
      } else {
        endDrag();
        onClose();
      }
    }
  }

  function toggleMenu(name: Exclude<OpenMenu, null>) {
    openMenu = openMenu === name ? null : name;
  }

  function pickSymbol(raw: string) {
    const norm = normalizeSymbolInput(raw);
    symbol = norm.symbol;
    shortName = norm.shortName;
    openMenu = null;
    symbolQuery = '';
  }

  function openNotificationsSubView() {
    endDrag();
    openMenu = null;
    notifError = null;
    draftDesktop = notifyDesktop;
    draftToast = showToast;
    draftSound = playSound;
    draftWebhookEnabled = webhookEnabled;
    draftWebhookUrl = webhookUrl;
    draftSchedule = schedule;
    view = 'notifications';
    keepModalInViewport();
  }

  function cancelNotifications() {
    endDrag();
    openMenu = null;
    notifError = null;
    view = 'main';
  }

  function applyNotifications() {
    const trimmedUrl = String(draftWebhookUrl ?? '').trim();
    if (draftWebhookEnabled && trimmedUrl) {
      let validHttps = false;
      try {
        const parsed = new URL(trimmedUrl);
        validHttps = parsed.protocol === 'https:';
      } catch {
        validHttps = false;
      }
      if (!validHttps) {
        notifError = 'Webhook URL must be a valid https:// URL.';
        return;
      }
    }

    notifyDesktop = draftDesktop;
    showToast = draftToast;
    playSound = draftSound;
    webhookEnabled = draftWebhookEnabled;
    webhookUrl = trimmedUrl;
    schedule = draftSchedule;
    openMenu = null;
    notifError = null;
    view = 'main';
  }

  function submitAlert() {
    const num = parseTargetPrice(valueStr);
    if (num === null || num <= 0) {
      formError = 'Enter a valid target price.';
      return;
    }

    let expiresAt: string | null;
    if (!expiryChanged && editingAlert) {
      expiresAt = preservedExpiresAt;
    } else {
      const expOpt = EXPIRY_OPTIONS.find((o) => o.id === expiryPreset);
      expiresAt =
        expOpt && expOpt.days !== null
          ? new Date(Date.now() + expOpt.days * 86_400_000).toISOString()
          : null;
    }

    const notifPrefs: AlertNotificationPrefs = {
      notifyDesktop,
      showToast,
      playSound,
      webhookEnabled,
      webhookUrl: String(webhookUrl ?? '').trim(),
      schedule
    };

    const sameEditingSymbol =
      Boolean(editingAlert) &&
      (editingAlert?.symbol ?? '').toUpperCase() === symbol.toUpperCase();

    const conditionChanged =
      !sameEditingSymbol ||
      editingAlert?.operator !== operator ||
      editingAlert?.targetPrice !== num;

    const initialSeedPrice =
      typeof initialPrice === 'number' &&
      Number.isFinite(initialPrice) &&
      shortName.toUpperCase() === (initialShortName ?? '').toUpperCase()
        ? initialPrice
        : undefined;

    const nowIso = new Date().toISOString();
    const alert: TradingAlert = {
      id: editingAlert?.id ?? makeWorkspaceId('alert'),
      kind: 'price',
      symbol,
      shortName,
      operator,
      targetPrice: num,
      lastSeenPrice: sameEditingSymbol ? editingAlert?.lastSeenPrice : initialSeedPrice,
      trigger,
      expiresAt,
      message: (messageEdited ? String(customMessage ?? '').trim() : autoMessage) || autoMessage,
      status: editingAlert?.status === 'paused' ? 'paused' : 'active',
      notifications: notifPrefs,
      createdAt: editingAlert?.createdAt ?? nowIso,
      lastTriggeredAt:
        conditionChanged ||
        editingAlert?.status === 'triggered' ||
        editingAlert?.status === 'expired'
          ? undefined
          : editingAlert?.lastTriggeredAt
    };

    endDrag();
    onSave(alert);
    onClose();
  }
</script>

<svelte:window
  onkeydown={onWindowKeyDown}
  onpointerdown={onWindowPointerDown}
  onpointermove={onWindowPointerMove}
  onpointerup={onWindowPointerUp}
  onpointercancel={onWindowPointerUp}
  onblur={onWindowBlur}
  onresize={onWindowResize}
/>

{#if dragging}
  <!-- Prevents cross-origin TradingView iframe from stealing pointer events while dragging -->
  <div class="drag-shield" aria-hidden="true"></div>
{/if}

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
  <!-- Single persistent draggable header (never unmounted on view switch) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    bind:this={headerEl}
    class="modal-header"
    onpointerdown={onHeaderPointerDown}
    onlostpointercapture={endDrag}
  >
    {#if view === 'main'}
      <div class="header-left">
        <span class="modal-title">{editingAlert ? 'Edit alert on' : 'Create alert on'}</span>
        <div class="menu-anchor" data-am-menu>
          <button
            class="sym-trigger"
            type="button"
            onclick={() => toggleMenu('symbol')}
          >
            <SymbolIcon symbol={shortName} size={18} />
            <span>{shortName}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
            </svg>
          </button>

          {#if openMenu === 'symbol'}
            <div class="custom-menu sym-dropdown">
              <input
                type="text"
                placeholder="Type symbol..."
                bind:value={symbolQuery}
                onkeydown={(e) => {
                  if (e.key === 'Enter' && symbolQuery.trim()) pickSymbol(symbolQuery);
                }}
              />
              <div class="menu-scroll">
                {#each filteredSymbols as entry (entry.symbol)}
                  <button
                    class="menu-opt sym-opt"
                    type="button"
                    onclick={() => pickSymbol(entry.symbol)}
                  >
                    <SymbolIcon symbol={entry.shortName} size={16} />
                    <strong>{entry.shortName}</strong>
                    <span>{entry.description}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="header-left">
        <button class="back-btn" type="button" aria-label="Back" onclick={cancelNotifications}>
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="m11 4.5-4.5 4.5L11 13.5" />
          </svg>
        </button>
        <span class="modal-title">Notifications</span>
      </div>
    {/if}

    <button
      class="close-btn"
      type="button"
      aria-label="Close"
      onclick={() => {
        endDrag();
        onClose();
      }}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <path d="m4.5 4.5 9 9m0-9-9 9" />
      </svg>
    </button>
  </header>

  {#if view === 'main'}
    <div class="modal-body">
      <!-- Condition -->
      <div class="form-row top-align">
        <span class="row-label">Condition</span>
        <div class="row-controls stack">
          <div class="static-select">Price</div>

          <!-- Custom operator dropdown (WebView2-safe) -->
          <div class="menu-anchor" data-am-menu>
            <button
              class="custom-select"
              type="button"
              onclick={() => toggleMenu('operator')}
            >
              <span>{OPERATOR_LABELS[operator]}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
            {#if openMenu === 'operator'}
              <div class="custom-menu full">
                {#each OPERATOR_OPTIONS as opt (opt.id)}
                  <button
                    class="menu-opt"
                    class:active={operator === opt.id}
                    type="button"
                    onclick={() => {
                      operator = opt.id;
                      openMenu = null;
                    }}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="value-split">
            <div class="value-kind">Value</div>
            <input
              class="tv-input num"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="Target price"
              value={valueStr}
              oninput={(e) => {
                valueStr = (e.currentTarget as HTMLInputElement).value;
                formError = null;
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter' && !openMenu) {
                  e.preventDefault();
                  submitAlert();
                }
              }}
            />
          </div>
        </div>
      </div>

      <div class="row-divider"></div>

      <!-- Trigger -->
      <div class="form-row">
        <span class="row-label">Trigger</span>
        <div class="row-controls">
          <div class="menu-anchor inline-anchor" data-am-menu>
            <button
              class="inline-select"
              type="button"
              onclick={() => toggleMenu('trigger')}
            >
              <span>{TRIGGER_OPTIONS.find((t) => t.id === trigger)?.label ?? 'Once only'}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
            {#if openMenu === 'trigger'}
              <div class="custom-menu">
                {#each TRIGGER_OPTIONS as opt (opt.id)}
                  <button
                    class="menu-opt"
                    class:active={trigger === opt.id}
                    type="button"
                    onclick={() => {
                      trigger = opt.id;
                      openMenu = null;
                    }}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Expiration -->
      <div class="form-row">
        <span class="row-label">Expiration</span>
        <div class="row-controls">
          <div class="menu-anchor inline-anchor" data-am-menu>
            <button
              class="inline-select"
              type="button"
              onclick={() => toggleMenu('expiry')}
            >
              <span>{expiryDisplayLabel}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
            {#if openMenu === 'expiry'}
              <div class="custom-menu">
                {#each EXPIRY_OPTIONS as opt (opt.id)}
                  <button
                    class="menu-opt"
                    class:active={expiryChanged && expiryPreset === opt.id}
                    type="button"
                    onclick={() => {
                      expiryPreset = opt.id;
                      expiryChanged = true;
                      openMenu = null;
                    }}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
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
      <button
        class="btn-cancel"
        type="button"
        onclick={() => {
          endDrag();
          onClose();
        }}
      >
        Cancel
      </button>
      <button class="btn-primary" type="button" onclick={submitAlert}>
        {editingAlert ? 'Save' : 'Create'}
      </button>
    </div>
  {:else}
    <!-- Notifications sub-view (100% custom checkboxes & dropdowns — zero WebView2 OS popup freezes) -->
    <div class="modal-body notif-body">
      <button
        class="check-item"
        type="button"
        role="checkbox"
        aria-checked={draftDesktop}
        onclick={() => (draftDesktop = !draftDesktop)}
      >
        <span class="cb-box" class:checked={draftDesktop}>
          {#if draftDesktop}
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6.2 5 8.7 9.5 3.5" />
            </svg>
          {/if}
        </span>
        <span class="check-copy">
          <span class="check-title">Notify on desktop</span>
          <span class="check-desc">Sends a native Windows notification even when minimized.</span>
        </span>
      </button>

      <button
        class="check-item"
        type="button"
        role="checkbox"
        aria-checked={draftToast}
        onclick={() => (draftToast = !draftToast)}
      >
        <span class="cb-box" class:checked={draftToast}>
          {#if draftToast}
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6.2 5 8.7 9.5 3.5" />
            </svg>
          {/if}
        </span>
        <span class="check-copy">
          <span class="check-title">Show toast notification</span>
          <span class="check-desc">Displays an onsite notification in the window corner.</span>
        </span>
      </button>

      <div class="check-item-row">
        <button
          class="check-item"
          type="button"
          role="checkbox"
          aria-checked={draftSound}
          onclick={() => (draftSound = !draftSound)}
        >
          <span class="cb-box" class:checked={draftSound}>
            {#if draftSound}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 6.2 5 8.7 9.5 3.5" />
              </svg>
            {/if}
          </span>
          <span class="check-copy">
            <span class="check-title">Play sound</span>
            <span class="check-desc">Plays an audio cue when your alert triggers.</span>
          </span>
        </button>
        <button class="test-sound" type="button" onclick={() => playAlertChime()}>Test</button>
      </div>

      <div class="webhook-block">
        <button
          class="check-item"
          type="button"
          role="checkbox"
          aria-checked={draftWebhookEnabled}
          onclick={() => {
            draftWebhookEnabled = !draftWebhookEnabled;
            notifError = null;
            if (draftWebhookEnabled) keepModalInViewport();
          }}
        >
          <span class="cb-box" class:checked={draftWebhookEnabled}>
            {#if draftWebhookEnabled}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 6.2 5 8.7 9.5 3.5" />
              </svg>
            {/if}
          </span>
          <span class="check-copy">
            <span class="check-title">Webhook URL</span>
            <span class="check-desc">Sends a POST JSON request to your URL when triggered.</span>
          </span>
        </button>
        {#if draftWebhookEnabled}
          <input
            class="tv-input webhook-input"
            type="url"
            placeholder="https://discord.com/api/webhooks/..."
            value={draftWebhookUrl}
            oninput={(e) => {
              draftWebhookUrl = (e.currentTarget as HTMLInputElement).value;
              notifError = null;
            }}
          />
        {/if}
      </div>

      <div class="row-divider"></div>

      <div class="schedule-block">
        <div class="schedule-row">
          <span class="check-title">Notification schedule</span>
          <div class="menu-anchor schedule-anchor" data-am-menu>
            <button
              class="custom-select"
              type="button"
              onclick={() => toggleMenu('schedule')}
            >
              <span>{SCHEDULE_OPTIONS.find((s) => s.id === draftSchedule)?.label ?? '24/7'}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
            {#if openMenu === 'schedule'}
              <div class="custom-menu up full">
                {#each SCHEDULE_OPTIONS as opt (opt.id)}
                  <button
                    class="menu-opt"
                    class:active={draftSchedule === opt.id}
                    type="button"
                    onclick={() => {
                      draftSchedule = opt.id;
                      openMenu = null;
                    }}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
        <span class="check-desc">Notifications are muted outside this schedule.</span>
      </div>

      {#if notifError}
        <div class="form-err">{notifError}</div>
      {/if}
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick={cancelNotifications}>Cancel</button>
      <button class="btn-primary" type="button" onclick={applyNotifications}>Apply</button>
    </div>
  {/if}
</div>

<style>
  .drag-shield {
    position: fixed;
    inset: 0;
    z-index: 109;
    cursor: grabbing;
  }

  /* Exact dark glass tokens matching SettingsModal.svelte */
  .alert-modal {
    --am-bg: rgba(18, 18, 18, 0.86);
    --am-menu-bg: rgba(24, 24, 28, 0.96);
    --am-border: rgba(255, 255, 255, 0.12);
    --am-divider: rgba(255, 255, 255, 0.09);
    --am-text: #f0f0f0;
    --am-secondary: #8c8c92;
    --am-control-bg: rgba(16, 16, 16, 0.65);
    --am-control-border: rgba(255, 255, 255, 0.16);
    --am-hover: rgba(255, 255, 255, 0.06);
    --am-check-bg: #f0f0f0;
    --am-check-fg: #0d0d0d;
    --am-check-border: rgba(255, 255, 255, 0.42);
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
    --am-menu-bg: #ffffff;
    --am-border: #e0e3eb;
    --am-divider: #eceef2;
    --am-text: #131722;
    --am-secondary: #6a6d78;
    --am-control-bg: #ffffff;
    --am-control-border: #d8dce6;
    --am-hover: rgba(0, 0, 0, 0.04);
    --am-check-bg: #131722;
    --am-check-fg: #ffffff;
    --am-check-border: #8c919e;
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

  .menu-anchor {
    position: relative;
  }

  .inline-anchor {
    display: inline-block;
  }

  .schedule-anchor {
    width: 185px;
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

  .sym-trigger svg,
  .custom-select svg,
  .inline-select svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--am-secondary);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .custom-menu {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    min-width: 168px;
    padding: 5px;
    border-radius: 10px;
    border: 1px solid var(--am-border);
    background: var(--am-menu-bg);
    box-shadow: var(--am-shadow);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .custom-menu.full {
    width: 100%;
    box-sizing: border-box;
  }

  .custom-menu.up {
    top: auto;
    bottom: calc(100% + 5px);
  }

  .sym-dropdown {
    width: 248px;
  }

  .sym-dropdown input {
    width: 100%;
    box-sizing: border-box;
    height: 28px;
    padding: 0 8px;
    margin-bottom: 4px;
    border-radius: 6px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    color: var(--am-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .menu-scroll {
    max-height: 185px;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .menu-scroll::-webkit-scrollbar {
    display: none;
  }

  .menu-opt {
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--am-text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background-color 110ms ease;
  }

  .menu-opt:hover,
  .menu-opt.active {
    background: var(--am-hover);
  }

  .menu-opt.active {
    font-weight: 600;
  }

  .sym-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
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
  .custom-select,
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

  .static-select {
    display: flex;
    align-items: center;
  }

  .custom-select {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    text-align: left;
  }

  .custom-select:hover {
    border-color: color-mix(in srgb, var(--am-text) 30%, transparent);
  }

  .inline-select {
    height: 30px;
    padding: 0 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--am-text);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .inline-select:hover {
    background: var(--am-hover);
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
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--am-text);
    display: flex;
    align-items: flex-start;
    gap: 10px;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .cb-box {
    width: 17px;
    height: 17px;
    margin-top: 1px;
    flex: 0 0 17px;
    border-radius: 4px;
    border: 1.5px solid var(--am-check-border);
    background: transparent;
    display: grid;
    place-items: center;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .cb-box.checked {
    border-color: var(--am-check-bg);
    background: var(--am-check-bg);
    color: var(--am-check-fg);
  }

  .cb-box svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.1;
    stroke-linecap: round;
    stroke-linejoin: round;
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
    flex: 0 0 auto;
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
    margin-left: 27px;
    width: calc(100% - 27px);
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
