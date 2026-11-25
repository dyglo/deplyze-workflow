<script lang="ts">
  import { onMount } from 'svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    CONDITION_OPERATOR_LABELS,
    DEFAULT_NOTIFICATIONS,
    METRIC_LABELS,
    RATING_TARGET_LABELS,
    WATCHLIST_TRIGGER_LABELS,
    formatAlertAutoMessage,
    getAlertConditions,
    isWatchlistAlert,
    type AlertCondition,
    type AlertConditionMetric,
    type AlertConditionOperator,
    type AlertLogic,
    type AlertNotificationPrefs,
    type AlertOperator,
    type AlertScope,
    type AlertTrigger,
    type NotificationSchedule,
    type TechRatingTarget,
    type TradingAlert,
    type WatchlistTriggerMode
  } from '../alerts/store';
  import {
    SYMBOL_CATALOG,
    formatQuotePrice,
    loadWatchlistState,
    normalizeSymbolInput,
    type WatchlistGroup
  } from '../watchlist/store';
  import { makeWorkspaceId, playAlertChime } from '../workspace/storage';

  interface Props {
    theme: 'dark' | 'light';
    initialSymbol: string;
    initialShortName: string;
    initialPrice?: number;
    initialWatchlistGroupId?: string | null;
    editingAlert?: TradingAlert | null;
    onSave: (alert: TradingAlert) => void;
    onClose: () => void;
  }

  let {
    theme,
    initialSymbol,
    initialShortName,
    initialPrice,
    initialWatchlistGroupId = null,
    editingAlert = null,
    onSave,
    onClose
  }: Props = $props();

  const MODAL_WIDTH = 460;
  const TITLE_BAR_HEIGHT = 34;

  type ExpiryPreset = 'open' | '1d' | '7d' | '30d' | '90d';

  interface DraftCondition {
    id: string;
    symbol: string;
    shortName: string;
    metric: AlertConditionMetric;
    operator: AlertConditionOperator;
    valueStr: string;
    ratingTarget: TechRatingTarget;
  }

  const SYMBOL_METRICS: AlertConditionMetric[] = [
    'price',
    'tech_rating',
    'change_pct',
    'rsi14',
    'range_pos'
  ];

  const WATCHLIST_METRICS: AlertConditionMetric[] = [
    'change_pct',
    'tech_rating',
    'rsi14',
    'range_pos'
  ];

  const PRICE_OPERATORS: { id: AlertOperator; label: string }[] = [
    { id: 'crossing', label: 'Crossing' },
    { id: 'crossing_up', label: 'Crossing Up' },
    { id: 'crossing_down', label: 'Crossing Down' },
    { id: 'greater_than', label: 'Greater Than' },
    { id: 'less_than', label: 'Less Than' }
  ];

  const CHANGE_OPERATORS: { id: AlertConditionOperator; label: string }[] = [
    { id: 'abs_gte', label: 'Abs Move ≥' },
    { id: 'greater_than', label: 'Greater Than' },
    { id: 'less_than', label: 'Less Than' }
  ];

  const COMPARE_OPERATORS: { id: AlertConditionOperator; label: string }[] = [
    { id: 'greater_than', label: 'Greater Than' },
    { id: 'less_than', label: 'Less Than' }
  ];

  const RANGE_OPERATORS: { id: AlertConditionOperator; label: string }[] = [
    { id: 'greater_than', label: 'Near High (≥ %)' },
    { id: 'less_than', label: 'Near Low (≤ %)' }
  ];

  const RATING_OPTIONS: { id: TechRatingTarget; label: string }[] = [
    { id: 'strong_buy', label: 'Strong buy' },
    { id: 'buy_or_strong', label: 'Buy or stronger' },
    { id: 'neutral', label: 'Neutral' },
    { id: 'sell_or_strong', label: 'Sell or weaker' },
    { id: 'strong_sell', label: 'Strong sell' }
  ];

  const TRIGGER_OPTIONS: { id: AlertTrigger; label: string }[] = [
    { id: 'once', label: 'Once only' },
    { id: 'every', label: 'Every time' }
  ];

  const WATCHLIST_TRIGGER_OPTIONS: { id: WatchlistTriggerMode; label: string }[] = [
    { id: 'once_per_symbol', label: 'Once per symbol' },
    { id: 'every_per_symbol', label: 'Every time (per symbol)' },
    { id: 'once_first', label: 'Once only (first match)' }
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

  function parseNumeric(raw: unknown): number | null {
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

  function defaultConditionFor(
    metric: AlertConditionMetric,
    sym: string,
    short: string,
    seedPrice?: number
  ): DraftCondition {
    if (metric === 'price') {
      return {
        id: makeWorkspaceId('c'),
        symbol: sym,
        shortName: short,
        metric: 'price',
        operator: 'crossing',
        valueStr:
          typeof seedPrice === 'number' && Number.isFinite(seedPrice)
            ? formatQuotePrice(seedPrice, short).replace(/,/g, '')
            : '',
        ratingTarget: 'strong_buy'
      };
    }
    if (metric === 'tech_rating') {
      return {
        id: makeWorkspaceId('c'),
        symbol: sym,
        shortName: short,
        metric: 'tech_rating',
        operator: 'is_rating',
        valueStr: '',
        ratingTarget: 'strong_buy'
      };
    }
    if (metric === 'change_pct') {
      return {
        id: makeWorkspaceId('c'),
        symbol: sym,
        shortName: short,
        metric: 'change_pct',
        operator: 'abs_gte',
        valueStr: '1.5',
        ratingTarget: 'strong_buy'
      };
    }
    if (metric === 'rsi14') {
      return {
        id: makeWorkspaceId('c'),
        symbol: sym,
        shortName: short,
        metric: 'rsi14',
        operator: 'greater_than',
        valueStr: '70',
        ratingTarget: 'strong_buy'
      };
    }
    return {
      id: makeWorkspaceId('c'),
      symbol: sym,
      shortName: short,
      metric: 'range_pos',
      operator: 'greater_than',
      valueStr: '90',
      ratingTarget: 'strong_buy'
    };
  }

  function buildInitialDrafts(): DraftCondition[] {
    if (editingAlert) {
      const existing = getAlertConditions(editingAlert);
      if (existing.length > 0) {
        return existing.slice(0, 3).map((c) => ({
          id: c.id || makeWorkspaceId('c'),
          symbol: c.symbol || editingAlert.symbol,
          shortName: c.shortName || editingAlert.shortName,
          metric: c.metric,
          operator: c.operator,
          valueStr:
            typeof c.value === 'number' && Number.isFinite(c.value) ? String(c.value) : '',
          ratingTarget: c.ratingTarget ?? 'strong_buy'
        }));
      }
    }
    if (initialWatchlistGroupId) {
      return [defaultConditionFor('change_pct', '', '')];
    }
    const baseSym = initialSymbol || 'OANDA:XAUUSD';
    const baseShort = initialShortName || 'XAUUSD';
    return [defaultConditionFor('price', baseSym, baseShort, initialPrice)];
  }

  function buildConditionsFromDrafts(
    drafts: DraftCondition[],
    curScope: AlertScope,
    primarySym: string,
    primaryShort: string
  ): AlertCondition[] {
    return drafts.map((d, idx) => {
      const num = parseNumeric(d.valueStr);
      const isPrimary =
        curScope === 'watchlist' ||
        idx === 0 ||
        (d.symbol || primarySym).toUpperCase() === primarySym.toUpperCase();
      return {
        id: d.id || `c${idx + 1}`,
        ...(curScope === 'symbol'
          ? {
              symbol: isPrimary ? primarySym : d.symbol,
              shortName: isPrimary ? primaryShort : d.shortName
            }
          : {}),
        metric: d.metric,
        operator: d.metric === 'tech_rating' ? 'is_rating' : d.operator,
        ...(d.metric === 'tech_rating'
          ? { ratingTarget: d.ratingTarget }
          : num !== null
            ? { value: num }
            : {})
      };
    });
  }

  // svelte-ignore state_referenced_locally
  let scope = $state<AlertScope>(
    editingAlert
      ? isWatchlistAlert(editingAlert)
        ? 'watchlist'
        : 'symbol'
      : initialWatchlistGroupId
        ? 'watchlist'
        : 'symbol'
  );
  // svelte-ignore state_referenced_locally
  let symbol = $state(editingAlert && !isWatchlistAlert(editingAlert) ? editingAlert.symbol : initialSymbol || 'OANDA:XAUUSD');
  // svelte-ignore state_referenced_locally
  let shortName = $state(editingAlert && !isWatchlistAlert(editingAlert) ? editingAlert.shortName : initialShortName || 'XAUUSD');
  // svelte-ignore state_referenced_locally
  let watchlistGroupId = $state<string>(
    editingAlert?.watchlistGroupId ?? initialWatchlistGroupId ?? ''
  );
  // svelte-ignore state_referenced_locally
  let watchlistGroupName = $state<string>(editingAlert?.watchlistGroupName ?? 'Watchlist');

  let watchlistGroups = $state<WatchlistGroup[]>([]);

  // svelte-ignore state_referenced_locally
  let logic = $state<AlertLogic>(editingAlert?.logic === 'or' ? 'or' : 'and');
  // svelte-ignore state_referenced_locally
  let drafts = $state<DraftCondition[]>(buildInitialDrafts());

  // svelte-ignore state_referenced_locally
  let trigger = $state<AlertTrigger>(editingAlert?.trigger ?? 'once');
  // svelte-ignore state_referenced_locally
  let watchlistTriggerMode = $state<WatchlistTriggerMode>(
    editingAlert?.watchlistTriggerMode ?? 'once_per_symbol'
  );
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
  let messageEdited = $state(Boolean(editingAlert && editingAlert.message.trim()));

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

  let draftDesktop = $state(true);
  let draftToast = $state(true);
  let draftSound = $state(true);
  let draftWebhookEnabled = $state(false);
  let draftWebhookUrl = $state('');
  let draftSchedule = $state<NotificationSchedule>('24/7');

  let view = $state<'main' | 'notifications'>('main');
  let openMenu = $state<string | null>(null);
  let symbolQuery = $state('');
  let condSymQuery = $state('');
  let formError = $state<string | null>(null);
  let notifError = $state<string | null>(null);

  let posX = $state(
    typeof window !== 'undefined'
      ? Math.max(16, Math.round((window.innerWidth - MODAL_WIDTH) / 2))
      : 260
  );
  let posY = $state(
    typeof window !== 'undefined' ? Math.max(TITLE_BAR_HEIGHT + 20, 72) : 72
  );
  let dragging = $state(false);
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragPointerId: number | null = null;
  let modalEl: HTMLDivElement | undefined = $state();
  let headerEl: HTMLElement | undefined = $state();

  onMount(() => {
    void loadWatchlistState().then((wl) => {
      watchlistGroups = wl.groups;
      if (scope === 'watchlist') {
        const match =
          wl.groups.find((g) => g.id === watchlistGroupId) ??
          wl.groups.find((g) => g.id === wl.activeGroupId) ??
          wl.groups[0];
        if (match) {
          watchlistGroupId = match.id;
          watchlistGroupName = match.name;
        }
      }
    });
  });

  const allKnownSymbols = $derived.by(() => {
    const map = new Map<string, { symbol: string; shortName: string; description: string }>();
    for (const c of SYMBOL_CATALOG) {
      map.set(c.shortName.toUpperCase(), {
        symbol: c.symbol,
        shortName: c.shortName,
        description: c.description
      });
    }
    for (const g of watchlistGroups) {
      for (const sec of g.sections) {
        for (const it of sec.items) {
          if (!map.has(it.shortName.toUpperCase())) {
            map.set(it.shortName.toUpperCase(), {
              symbol: it.symbol,
              shortName: it.shortName,
              description: it.description || it.shortName
            });
          }
        }
      }
    }
    return Array.from(map.values());
  });

  function filterCatalog(query: string) {
    const q = String(query ?? '').trim().toUpperCase();
    if (!q) return allKnownSymbols.slice(0, 12);
    return allKnownSymbols
      .filter(
        (s) =>
          s.shortName.toUpperCase().includes(q) ||
          s.symbol.toUpperCase().includes(q) ||
          s.description.toUpperCase().includes(q)
      )
      .slice(0, 12);
  }

  const filteredHeaderSymbols = $derived(filterCatalog(symbolQuery));
  const filteredCondSymbols = $derived(filterCatalog(condSymQuery));

  function groupMemberCount(g: WatchlistGroup): number {
    return g.sections.reduce((acc, s) => acc + s.items.length, 0);
  }

  const activeWatchlistGroup = $derived(
    watchlistGroups.find((g) => g.id === watchlistGroupId) ?? null
  );

  const autoMessage = $derived.by(() => {
    const built = buildConditionsFromDrafts(drafts, scope, symbol, shortName);
    return formatAlertAutoMessage({
      scope,
      shortName,
      watchlistGroupName: activeWatchlistGroup?.name ?? watchlistGroupName,
      logic,
      conditions: built
    });
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

  function operatorsForMetric(metric: AlertConditionMetric) {
    if (metric === 'price') return PRICE_OPERATORS;
    if (metric === 'change_pct') return CHANGE_OPERATORS;
    if (metric === 'range_pos') return RANGE_OPERATORS;
    return COMPARE_OPERATORS;
  }

  function operatorLabelFor(metric: AlertConditionMetric, op: AlertConditionOperator): string {
    if (metric === 'range_pos') {
      return op === 'less_than' ? 'Near Low (≤ %)' : 'Near High (≥ %)';
    }
    return CONDITION_OPERATOR_LABELS[op] ?? 'Crossing';
  }

  function valuePlaceholderFor(metric: AlertConditionMetric): string {
    if (metric === 'price') return 'Target price';
    if (metric === 'change_pct') return 'e.g. 1.5 (%)';
    if (metric === 'rsi14') return '0–100 (e.g. 70)';
    return '0–100 (e.g. 90%)';
  }

  function valueUnitFor(metric: AlertConditionMetric): string {
    if (metric === 'price') return 'Value';
    if (metric === 'change_pct') return 'Chg %';
    if (metric === 'rsi14') return 'RSI';
    return 'Pos %';
  }

  function clampPosition(x: number, y: number, ensureFullHeight = false): { x: number; y: number } {
    if (typeof window === 'undefined') return { x, y };
    const w = modalEl?.offsetWidth ?? MODAL_WIDTH;
    const h = modalEl?.offsetHeight ?? 440;
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
        // ignore
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
      // fallback to window listeners
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

  function toggleMenu(name: string) {
    openMenu = openMenu === name ? null : name;
  }

  function pickTargetSymbol(raw: string) {
    const norm = normalizeSymbolInput(raw);
    const prevPrimary = symbol.toUpperCase();
    scope = 'symbol';
    symbol = norm.symbol;
    shortName = norm.shortName;
    // Update Condition 1 (and any condition that matched the old primary) to the new symbol
    drafts = drafts.map((d, idx) =>
      idx === 0 || d.symbol.toUpperCase() === prevPrimary
        ? { ...d, symbol: norm.symbol, shortName: norm.shortName }
        : d
    );
    openMenu = null;
    symbolQuery = '';
    formError = null;
  }

  function pickTargetWatchlist(g: WatchlistGroup) {
    scope = 'watchlist';
    watchlistGroupId = g.id;
    watchlistGroupName = g.name;
    // Watchlist rules cannot use absolute price levels; convert any 'price' leg to change_pct
    drafts = drafts.map((d) =>
      d.metric === 'price'
        ? {
            ...d,
            metric: 'change_pct',
            operator: 'abs_gte',
            valueStr: '1.5'
          }
        : d
    );
    openMenu = null;
    symbolQuery = '';
    formError = null;
  }

  function setConditionMetric(idx: number, metric: AlertConditionMetric) {
    const cur = drafts[idx];
    const next = defaultConditionFor(
      metric,
      cur.symbol || symbol,
      cur.shortName || shortName,
      idx === 0 && cur.shortName.toUpperCase() === (initialShortName ?? '').toUpperCase()
        ? initialPrice
        : undefined
    );
    next.id = cur.id;
    drafts = drafts.map((d, i) => (i === idx ? next : d));
    openMenu = null;
    formError = null;
  }

  function setConditionOperator(idx: number, op: AlertConditionOperator) {
    drafts = drafts.map((d, i) => (i === idx ? { ...d, operator: op } : d));
    openMenu = null;
    formError = null;
  }

  function setConditionRating(idx: number, target: TechRatingTarget) {
    drafts = drafts.map((d, i) => (i === idx ? { ...d, ratingTarget: target } : d));
    openMenu = null;
    formError = null;
  }

  function setConditionSymbol(idx: number, raw: string) {
    const norm = normalizeSymbolInput(raw);
    drafts = drafts.map((d, i) =>
      i === idx ? { ...d, symbol: norm.symbol, shortName: norm.shortName } : d
    );
    openMenu = null;
    condSymQuery = '';
    formError = null;
  }

  function addCondition() {
    if (drafts.length >= 3) return;
    const nextMetric: AlertConditionMetric =
      drafts.some((d) => d.metric === 'tech_rating') ? 'rsi14' : 'tech_rating';
    const next = defaultConditionFor(nextMetric, symbol, shortName);
    drafts = [...drafts, next];
    formError = null;
    keepModalInViewport();
  }

  function removeCondition(idx: number) {
    if (drafts.length <= 1) return;
    drafts = drafts.filter((_, i) => i !== idx);
    openMenu = null;
    formError = null;
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
    if (scope === 'watchlist' && !watchlistGroupId) {
      formError = 'Select a Watchlist group to monitor.';
      return;
    }

    // Validate all 1–3 conditions
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      if (d.metric === 'tech_rating') continue;
      const num = parseNumeric(d.valueStr);
      if (num === null) {
        formError = `Condition ${i + 1}: enter a valid numeric value.`;
        return;
      }
      if (d.metric === 'price' && num <= 0) {
        formError = `Condition ${i + 1}: enter a positive target price.`;
        return;
      }
      if (d.metric === 'rsi14' && (num < 0 || num > 100)) {
        formError = `Condition ${i + 1}: RSI must be between 0 and 100.`;
        return;
      }
      if (d.metric === 'range_pos' && (num < 0 || num > 100)) {
        formError = `Condition ${i + 1}: Day Range Position must be between 0 and 100%.`;
        return;
      }
      if (d.metric === 'change_pct' && d.operator === 'abs_gte' && num <= 0) {
        formError = `Condition ${i + 1}: enter a positive % move (e.g. 1.5).`;
        return;
      }
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

    const builtConditions = buildConditionsFromDrafts(drafts, scope, symbol, shortName);
    const first = builtConditions[0];
    const resolvedWlName = activeWatchlistGroup?.name ?? watchlistGroupName;

    const sameEditingTarget =
      Boolean(editingAlert) &&
      (scope === 'watchlist'
        ? editingAlert?.watchlistGroupId === watchlistGroupId
        : (editingAlert?.symbol ?? '').toUpperCase() === symbol.toUpperCase());

    const initialSeedPrice =
      scope === 'symbol' &&
      typeof initialPrice === 'number' &&
      Number.isFinite(initialPrice) &&
      shortName.toUpperCase() === (initialShortName ?? '').toUpperCase()
        ? initialPrice
        : undefined;

    const nowIso = new Date().toISOString();
    const alert: TradingAlert = {
      id: editingAlert?.id ?? makeWorkspaceId('alert'),
      kind: 'price',
      scope,
      symbol: scope === 'watchlist' ? watchlistGroupId : symbol,
      shortName: scope === 'watchlist' ? resolvedWlName : shortName,
      ...(scope === 'watchlist'
        ? {
            watchlistGroupId,
            watchlistGroupName: resolvedWlName,
            watchlistTriggerMode,
            triggeredSymbols: sameEditingTarget ? editingAlert?.triggeredSymbols ?? {} : {}
          }
        : {}),
      logic,
      conditions: builtConditions,
      // Mirror Condition 1 into legacy fields when it's a single-symbol price condition
      operator:
        scope === 'symbol' && first?.metric === 'price'
          ? (first.operator as AlertOperator)
          : undefined,
      targetPrice:
        scope === 'symbol' && first?.metric === 'price' ? first.value : undefined,
      lastSeenPrice:
        scope === 'symbol'
          ? sameEditingTarget
            ? editingAlert?.lastSeenPrice
            : initialSeedPrice
          : undefined,
      trigger: scope === 'watchlist' ? (watchlistTriggerMode === 'once_first' ? 'once' : 'every') : trigger,
      expiresAt,
      message: (messageEdited ? String(customMessage ?? '').trim() : autoMessage) || autoMessage,
      status: editingAlert?.status === 'paused' ? 'paused' : 'active',
      notifications: notifPrefs,
      createdAt: editingAlert?.createdAt ?? nowIso,
      lastTriggeredAt:
        editingAlert?.status === 'triggered' || editingAlert?.status === 'expired'
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
            onclick={() => toggleMenu('target')}
          >
            {#if scope === 'watchlist'}
              <span class="wl-chip-ic" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7.5" />
                </svg>
              </span>
              <span class="target-lbl">{activeWatchlistGroup?.name ?? watchlistGroupName}</span>
            {:else}
              <SymbolIcon symbol={shortName} size={18} />
              <span class="target-lbl">{shortName}</span>
            {/if}
            <svg class="chev-ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
            </svg>
          </button>

          {#if openMenu === 'target'}
            <div class="custom-menu sym-dropdown">
              {#if watchlistGroups.length > 0}
                <div class="menu-sec-lbl">Watchlist Groups</div>
                {#each watchlistGroups as grp (grp.id)}
                  <button
                    class="menu-opt sym-opt"
                    class:active={scope === 'watchlist' && watchlistGroupId === grp.id}
                    type="button"
                    onclick={() => pickTargetWatchlist(grp)}
                  >
                    <span class="wl-chip-ic sm" aria-hidden="true">
                      <svg viewBox="0 0 16 16">
                        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7.5" />
                      </svg>
                    </span>
                    <strong>{grp.name}</strong>
                    <span class="wl-cnt">{groupMemberCount(grp)} symbols</span>
                  </button>
                {/each}
                <div class="menu-div"></div>
              {/if}

              <div class="menu-sec-lbl">Symbols</div>
              <input
                type="text"
                placeholder="Type symbol (e.g. XAUUSD, DXY)..."
                bind:value={symbolQuery}
                onkeydown={(e) => {
                  if (e.key === 'Enter' && symbolQuery.trim()) pickTargetSymbol(symbolQuery);
                }}
              />
              <div class="menu-scroll">
                {#each filteredHeaderSymbols as entry (entry.symbol)}
                  <button
                    class="menu-opt sym-opt"
                    class:active={scope === 'symbol' && shortName.toUpperCase() === entry.shortName.toUpperCase()}
                    type="button"
                    onclick={() => pickTargetSymbol(entry.symbol)}
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
      <!-- Conditions (1 to 3 stacked flat blocks) -->
      <div class="form-row top-align">
        <span class="row-label">{drafts.length > 1 ? 'Conditions' : 'Condition'}</span>
        <div class="row-controls stack">
          {#each drafts as cond, idx (cond.id)}
            {#if idx > 0}
              <div class="logic-sep">
                <div class="logic-line"></div>
                {#if idx === 1}
                  <div class="logic-seg" role="group" aria-label="Combine logic">
                    <button
                      type="button"
                      class:active={logic === 'and'}
                      onclick={() => (logic = 'and')}
                    >
                      AND
                    </button>
                    <button
                      type="button"
                      class:active={logic === 'or'}
                      onclick={() => (logic = 'or')}
                    >
                      OR
                    </button>
                  </div>
                {:else}
                  <span class="logic-echo">{logic.toUpperCase()}</span>
                {/if}
                <div class="logic-line"></div>
                <button
                  class="cond-rm"
                  type="button"
                  title="Remove condition"
                  aria-label="Remove condition {idx + 1}"
                  onclick={() => removeCondition(idx)}
                >
                  ×
                </button>
              </div>
            {/if}

            <div class="cond-block">
              {#if scope === 'symbol' && idx > 0}
                <!-- Cross-symbol selector for Conditions 2 & 3 -->
                <div class="cond-sym-row">
                  <span class="cond-sym-lbl">Symbol</span>
                  <div class="menu-anchor" data-am-menu>
                    <button
                      class="mini-sym-btn"
                      type="button"
                      onclick={() => {
                        condSymQuery = '';
                        toggleMenu(`csym-${idx}`);
                      }}
                    >
                      <SymbolIcon symbol={cond.shortName} size={14} />
                      <span>{cond.shortName}</span>
                      {#if cond.shortName.toUpperCase() !== shortName.toUpperCase()}
                        <span class="cross-tag">cross</span>
                      {/if}
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                      </svg>
                    </button>

                    {#if openMenu === `csym-${idx}`}
                      <div class="custom-menu sym-dropdown">
                        <input
                          type="text"
                          placeholder="Cross-symbol (e.g. DXY, SPX)..."
                          bind:value={condSymQuery}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' && condSymQuery.trim()) {
                              setConditionSymbol(idx, condSymQuery);
                            }
                          }}
                        />
                        <div class="menu-scroll">
                          {#each filteredCondSymbols as entry (entry.symbol)}
                            <button
                              class="menu-opt sym-opt"
                              class:active={cond.shortName.toUpperCase() === entry.shortName.toUpperCase()}
                              type="button"
                              onclick={() => setConditionSymbol(idx, entry.symbol)}
                            >
                              <SymbolIcon symbol={entry.shortName} size={15} />
                              <strong>{entry.shortName}</strong>
                              <span>{entry.description}</span>
                            </button>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}

              <!-- Metric + Operator row -->
              <div class="cond-pair" class:single={cond.metric === 'tech_rating'}>
                <div class="menu-anchor" data-am-menu>
                  <button
                    class="custom-select"
                    type="button"
                    onclick={() => toggleMenu(`metric-${idx}`)}
                  >
                    <span>{METRIC_LABELS[cond.metric]}</span>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                    </svg>
                  </button>
                  {#if openMenu === `metric-${idx}`}
                    <div class="custom-menu full">
                      {#each scope === 'watchlist' ? WATCHLIST_METRICS : SYMBOL_METRICS as m (m)}
                        <button
                          class="menu-opt"
                          class:active={cond.metric === m}
                          type="button"
                          onclick={() => setConditionMetric(idx, m)}
                        >
                          {METRIC_LABELS[m]}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

                {#if cond.metric === 'tech_rating'}
                  <div class="menu-anchor" data-am-menu>
                    <button
                      class="custom-select"
                      type="button"
                      onclick={() => toggleMenu(`rating-${idx}`)}
                    >
                      <span>{RATING_TARGET_LABELS[cond.ratingTarget]}</span>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                      </svg>
                    </button>
                    {#if openMenu === `rating-${idx}`}
                      <div class="custom-menu full">
                        {#each RATING_OPTIONS as opt (opt.id)}
                          <button
                            class="menu-opt"
                            class:active={cond.ratingTarget === opt.id}
                            type="button"
                            onclick={() => setConditionRating(idx, opt.id)}
                          >
                            {opt.label}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {:else}
                  <div class="menu-anchor" data-am-menu>
                    <button
                      class="custom-select"
                      type="button"
                      onclick={() => toggleMenu(`op-${idx}`)}
                    >
                      <span>{operatorLabelFor(cond.metric, cond.operator)}</span>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                      </svg>
                    </button>
                    {#if openMenu === `op-${idx}`}
                      <div class="custom-menu full">
                        {#each operatorsForMetric(cond.metric) as opt (opt.id)}
                          <button
                            class="menu-opt"
                            class:active={cond.operator === opt.id}
                            type="button"
                            onclick={() => setConditionOperator(idx, opt.id)}
                          >
                            {opt.label}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>

              {#if cond.metric !== 'tech_rating'}
                <div class="value-split">
                  <div class="value-kind">{valueUnitFor(cond.metric)}</div>
                  <input
                    class="tv-input num"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder={valuePlaceholderFor(cond.metric)}
                    value={cond.valueStr}
                    oninput={(e) => {
                      const nextVal = (e.currentTarget as HTMLInputElement).value;
                      drafts = drafts.map((d, i) => (i === idx ? { ...d, valueStr: nextVal } : d));
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
              {/if}
            </div>
          {/each}

          {#if drafts.length < 3}
            <button class="add-cond-btn" type="button" onclick={addCondition}>
              + Add condition ({drafts.length}/3)
            </button>
          {/if}
        </div>
      </div>

      <div class="row-divider"></div>

      <!-- Trigger -->
      <div class="form-row">
        <span class="row-label">Trigger</span>
        <div class="row-controls">
          {#if scope === 'watchlist'}
            <div class="menu-anchor inline-anchor" data-am-menu>
              <button
                class="inline-select"
                type="button"
                onclick={() => toggleMenu('wl-trigger')}
              >
                <span>{WATCHLIST_TRIGGER_LABELS[watchlistTriggerMode]}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </button>
              {#if openMenu === 'wl-trigger'}
                <div class="custom-menu">
                  {#each WATCHLIST_TRIGGER_OPTIONS as opt (opt.id)}
                    <button
                      class="menu-opt"
                      class:active={watchlistTriggerMode === opt.id}
                      type="button"
                      onclick={() => {
                        watchlistTriggerMode = opt.id;
                        openMenu = null;
                      }}
                    >
                      {opt.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
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
          {/if}
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
              <div class="custom-menu up">
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
            placeholder="Custom note (e.g. Demand tap + DXY breakdown)"
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
      <span class="closed-hint">Live while open · Checks missed price levels on reopen</span>
      <div class="footer-acts">
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
    </div>
  {:else}
    <!-- Notifications sub-view -->
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
          <span class="check-desc">Displays a clickable corner notification to jump straight to chart.</span>
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

    <div class="modal-footer end">
      <div class="footer-acts">
        <button class="btn-cancel" type="button" onclick={cancelNotifications}>Cancel</button>
        <button class="btn-primary" type="button" onclick={applyNotifications}>Apply</button>
      </div>
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

  .alert-modal {
    --am-bg: var(--dark-bg-glass);
    --am-menu-bg: var(--dark-bg-glass-strong);
    --am-border: var(--dark-border-glass);
    --am-divider: var(--dark-border-subtle);
    --am-text: var(--dark-text-strong);
    --am-secondary: var(--dark-text-secondary);
    --am-control-bg: var(--dark-bg-input-glass);
    --am-control-border: var(--dark-border-control);
    --am-hover: rgba(255, 255, 255, 0.06);
    --am-check-bg: var(--dark-cta-bg);
    --am-check-fg: var(--dark-cta-fg);
    --am-check-border: rgba(255, 255, 255, 0.42);
    --am-btn-bg: var(--dark-cta-bg);
    --am-btn-fg: var(--dark-cta-fg);
    --am-shadow: var(--dark-shadow-modal);

    position: fixed;
    z-index: 110;
    width: 460px;
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
    height: 52px;
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
    min-width: 0;
  }

  .modal-title {
    font-size: 15.5px;
    font-weight: 700;
    letter-spacing: -0.015em;
    white-space: nowrap;
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
    flex: 0 0 30px;
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
    padding: 0 8px 0 6px;
    border: 0;
    border-radius: 7px;
    background: var(--am-hover);
    color: var(--am-text);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    max-width: 210px;
  }

  .target-lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wl-chip-ic {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: rgba(41, 98, 255, 0.16);
    color: #2962ff;
    display: grid;
    place-items: center;
    flex: 0 0 18px;
  }

  .wl-chip-ic.sm {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
  }

  .wl-chip-ic svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
  }

  .chev-ic,
  .custom-select svg,
  .inline-select svg,
  .mini-sym-btn svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--am-secondary);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: 0 0 13px;
  }

  .custom-menu {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    min-width: 174px;
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
    width: 256px;
  }

  .menu-sec-lbl {
    padding: 4px 8px 2px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--am-secondary);
  }

  .menu-div {
    height: 1px;
    margin: 4px 4px 2px;
    background: var(--am-divider);
  }

  .sym-dropdown input {
    width: 100%;
    box-sizing: border-box;
    height: 28px;
    padding: 0 8px;
    margin: 2px 0 4px;
    border-radius: 6px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    color: var(--am-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .menu-scroll {
    max-height: 175px;
    overflow-y: auto;
    scrollbar-width: none;
    scroll-behavior: smooth;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .menu-scroll::-webkit-scrollbar {
    display: none;
  }

  .menu-opt {
    width: 100%;
    padding: 6px 9px;
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

  .wl-cnt {
    margin-left: auto;
    font-size: 11px;
  }

  .modal-body {
    padding: 15px 18px;
    display: flex;
    flex-direction: column;
    gap: 11px;
    max-height: calc(100vh - 170px);
    overflow-y: auto;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .modal-body::-webkit-scrollbar {
    display: none;
  }

  .form-row {
    display: grid;
    grid-template-columns: 90px 1fr;
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

  /* Multi-condition compact hairline layout (no card boxes) */
  .cond-block {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .cond-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
  }

  .cond-sym-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .cond-sym-lbl {
    font-size: 11px;
    color: var(--am-secondary);
  }

  .mini-sym-btn {
    height: 24px;
    padding: 0 7px 0 5px;
    border-radius: 6px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    color: var(--am-text);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .mini-sym-btn:hover {
    background: var(--am-hover);
  }

  .cross-tag {
    font-size: 9.5px;
    font-weight: 600;
    color: #2962ff;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .logic-sep {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 2px 0;
  }

  .logic-line {
    flex: 1;
    height: 1px;
    background: var(--am-divider);
  }

  .logic-seg {
    display: inline-flex;
    border: 1px solid var(--am-control-border);
    border-radius: 5px;
    overflow: hidden;
  }

  .logic-seg button {
    height: 20px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--am-secondary);
    font: inherit;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .logic-seg button.active {
    background: var(--am-btn-bg);
    color: var(--am-btn-fg);
  }

  .logic-echo {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--am-secondary);
  }

  .cond-rm {
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--am-secondary);
    font-size: 15px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .cond-rm:hover {
    color: #f23645;
    background: var(--am-hover);
  }

  .add-cond-btn {
    align-self: flex-start;
    height: 26px;
    padding: 0 8px;
    border: 1px dashed var(--am-control-border);
    border-radius: 6px;
    background: transparent;
    color: var(--am-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease;
  }

  .add-cond-btn:hover {
    color: var(--am-text);
    border-color: var(--am-text);
    background: var(--am-hover);
  }

  .custom-select,
  .tv-input {
    width: 100%;
    box-sizing: border-box;
    height: 34px;
    padding: 0 9px;
    border-radius: 8px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    color: var(--am-text);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }

  .custom-select {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    cursor: pointer;
    text-align: left;
  }

  .custom-select span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    grid-template-columns: 82px 1fr;
    gap: 7px;
  }

  .value-kind {
    height: 34px;
    padding: 0 9px;
    border-radius: 8px;
    border: 1px solid var(--am-control-border);
    background: var(--am-control-bg);
    display: flex;
    align-items: center;
    font-size: 12px;
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
    padding: 11px 18px 14px;
    border-top: 1px solid var(--am-divider);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .modal-footer.end {
    justify-content: flex-end;
  }

  .closed-hint {
    font-size: 10.5px;
    color: var(--am-secondary);
    line-height: 1.3;
  }

  .footer-acts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .btn-cancel,
  .btn-primary {
    height: 34px;
    padding: 0 15px;
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
