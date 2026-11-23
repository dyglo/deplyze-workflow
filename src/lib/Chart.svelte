<script module lang="ts">
  export interface ChartQuote {
    symbol: string; // full symbol e.g. OANDA:XAUUSD
    shortName: string; // e.g. XAUUSD
    price: number;
    changePercent: number;
    description?: string;
    interval?: string;
  }

  const TV_INTERVAL_RE = /^(\d+[SMHDW]?|[DWMY])$/i;

  function normalizeInterval(raw: unknown): string | null {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return String(Math.round(raw));
    }
    if (typeof raw === 'string') {
      const cleaned = raw.trim().toUpperCase();
      if (cleaned && TV_INTERVAL_RE.test(cleaned)) {
        return cleaned;
      }
    }
    return null;
  }

  function extractIntervalFromRecord(data: Record<string, unknown> | undefined): string | null {
    if (!data) return null;
    return normalizeInterval(data.interval ?? data.resolution ?? data.timeframe);
  }
</script>

<script lang="ts">
  import { loadTradingView, type TvWidgetInstance } from './chart/tvLoader';
  import { toRgba, type ChartSettings } from './settings/chartSettings';

  interface Props {
    theme: 'dark' | 'light';
    settings: ChartSettings;
    paneId: string;
    symbol?: string;
    interval?: string;
    collapseSideToolbarByDefault?: boolean;
    onQuote?: (quote: ChartQuote) => void;
    onInterval?: (interval: string) => void;
  }

  let {
    theme,
    settings,
    paneId,
    symbol = 'OANDA:XAUUSD',
    interval = 'D',
    collapseSideToolbarByDefault = false,
    onQuote,
    onInterval
  }: Props = $props();

  let hostEl: HTMLDivElement | undefined = $state();
  const containerId = $derived(`tv-chart-${paneId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);

  // Track the latest symbol & interval reported by this chart so updating parent state
  // does NOT cause this chart instance to unnecessarily remount, while explicit
  // external switches (e.g. clicking a Watchlist symbol or workspace restore) DO load immediately.
  // svelte-ignore state_referenced_locally
  let mountedSymbol = symbol;
  let lastReportedSymbol: string | null = null;
  let externalSymbolVersion = $state(0);

  // svelte-ignore state_referenced_locally
  let mountedInterval = interval;
  let lastReportedInterval: string | null = null;
  let externalIntervalVersion = $state(0);

  let widgetIsReady = false;
  let pendingExternalSwitch: { prev: string; until: number } | null = null;

  function getActiveIframeWindow(): Window | null {
    const iframe = hostEl?.querySelector<HTMLIFrameElement>('iframe');
    return iframe?.contentWindow ?? null;
  }

  $effect(() => {
    if (symbol !== lastReportedSymbol && symbol !== mountedSymbol) {
      const prev = mountedSymbol;
      mountedSymbol = symbol;
      const win = widgetIsReady ? getActiveIframeWindow() : null;
      if (win) {
        try {
          pendingExternalSwitch = { prev, until: Date.now() + 2500 };
          win.postMessage({ name: 'set-symbol', data: { symbol } }, '*');
          return;
        } catch {
          pendingExternalSwitch = null;
          // fall back to remount below
        }
      }
      externalSymbolVersion += 1;
    }
  });

  $effect(() => {
    if (interval !== lastReportedInterval && interval !== mountedInterval) {
      mountedInterval = interval;
      const win = widgetIsReady ? getActiveIframeWindow() : null;
      if (win) {
        try {
          win.postMessage({ name: 'set-interval', data: { interval } }, '*');
          return;
        } catch {
          // fall back to remount below
        }
      }
      externalIntervalVersion += 1;
    }
  });

  function buildWidgetOptions(
    id: string,
    currentTheme: 'dark' | 'light',
    s: ChartSettings,
    sym: string,
    ivl: string,
    collapseSide: boolean
  ): Record<string, unknown> {
    const bg = currentTheme === 'dark' ? '#000000' : '#ffffff';
    const transparent = 'rgba(0, 0, 0, 0)';
    const visibleGrid =
      currentTheme === 'dark' ? 'rgba(242, 242, 242, 0.08)' : 'rgba(42, 46, 57, 0.06)';

    const vertGridColor = s.verticalGrid ? visibleGrid : transparent;
    const horzGridColor = s.horizontalGrid ? visibleGrid : transparent;

    const c = s.candles;
    const overrides: Record<string, string | number | boolean> = {
      'paneProperties.backgroundType': 'solid',
      'paneProperties.background': bg,
      'paneProperties.vertGridProperties.color': vertGridColor,
      'paneProperties.horzGridProperties.color': horzGridColor,
      'mainSeriesProperties.style': 1,
      'mainSeriesProperties.candleStyle.barColorsOnPrevClose': c.colorBarsOnPrevClose,
      'mainSeriesProperties.candleStyle.drawBody': c.drawBody,
      'mainSeriesProperties.candleStyle.upColor': c.drawBody ? toRgba(c.bodyUp) : transparent,
      'mainSeriesProperties.candleStyle.downColor': c.drawBody ? toRgba(c.bodyDown) : transparent,
      'mainSeriesProperties.candleStyle.drawBorder': c.drawBorder,
      'mainSeriesProperties.candleStyle.borderUpColor': c.drawBorder
        ? toRgba(c.borderUp)
        : transparent,
      'mainSeriesProperties.candleStyle.borderDownColor': c.drawBorder
        ? toRgba(c.borderDown)
        : transparent,
      'mainSeriesProperties.candleStyle.drawWick': c.drawWick,
      'mainSeriesProperties.candleStyle.wickUpColor': c.drawWick ? toRgba(c.wickUp) : transparent,
      'mainSeriesProperties.candleStyle.wickDownColor': c.drawWick
        ? toRgba(c.wickDown)
        : transparent
    };

    const enabledFeatures: string[] = ['use_localstorage_for_settings'];
    if (collapseSide) {
      enabledFeatures.push('hide_left_toolbar_by_default');
    }

    const options: Record<string, unknown> = {
      container_id: id,
      autosize: true,
      symbol: sym,
      interval: ivl,
      timezone: 'Africa/Nairobi',
      theme: currentTheme,
      style: '1',
      locale: 'en',
      backgroundColor: bg,
      allow_symbol_change: true,
      hide_volume: true,
      hide_side_toolbar: false,
      save_image: true,
      enabled_features: enabledFeatures,
      overrides
    };

    if (!s.verticalGrid && !s.horizontalGrid) {
      options.gridColor = transparent;
    } else if (s.verticalGrid && s.horizontalGrid) {
      options.gridColor = visibleGrid;
    }

    return options;
  }

  // Re-mount ONLY when theme, settings, containerId, collapseSide, or an explicit external
  // symbol/interval change before iframe readiness occurs. Live changes inside the iframe update
  // mountedSymbol / mountedInterval without touching optionsKey so the iframe stays intact.
  const optionsKey = $derived(
    JSON.stringify({
      containerId,
      theme,
      settings,
      collapseSideToolbarByDefault,
      externalSymbolVersion,
      externalIntervalVersion
    })
  );

  $effect(() => {
    const root = hostEl;
    void optionsKey;
    if (!root) return;

    const currentOptions = buildWidgetOptions(
      containerId,
      theme,
      settings,
      mountedSymbol,
      mountedInterval,
      collapseSideToolbarByDefault
    );

    let cancelled = false;
    let subscribed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let infoTimer: ReturnType<typeof setInterval> | undefined;
    let widgetInstance: TvWidgetInstance | null = null;
    widgetIsReady = false;
    root.innerHTML = '';

    function getIframeWindow(): Window | null {
      const iframe = root?.querySelector<HTMLIFrameElement>('iframe');
      return iframe?.contentWindow ?? null;
    }

    function sendQuoteSubscribe() {
      const win = getIframeWindow();
      if (!win) return;
      try {
        win.postMessage(
          JSON.stringify({
            id: Math.floor(Math.random() * 1e9),
            type: 'post',
            name: 'quoteSubscribe',
            data: undefined,
            provider: 'TradingView'
          }),
          '*'
        );
      } catch {
        // Ignore cross-origin post errors during teardown
      }
    }

    function reportIntervalIfChanged(nextInterval: string | null) {
      if (!nextInterval || nextInterval === mountedInterval) return;
      mountedInterval = nextInterval;
      lastReportedInterval = nextInterval;
      onInterval?.(nextInterval);
    }

    function querySymbolInfo() {
      if (cancelled || !widgetInstance?.postMessage) return;
      try {
        widgetInstance.postMessage.get('symbolInfo', {}, (info) => {
          if (cancelled || !info || typeof info !== 'object') return;
          const ivl = normalizeInterval(info.interval);
          if (ivl) {
            reportIntervalIfChanged(ivl);
          }
        });
      } catch {
        // Ignore transient cross-origin errors
      }
    }

    function handleMessage(e: MessageEvent) {
      const win = getIframeWindow();
      if (!win || e.source !== win) return;
      if (typeof e.data !== 'string') return;

      let msg: { provider?: string; name?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg?.provider !== 'TradingView') return;

      if (msg.name === 'widgetReady' && !subscribed) {
        subscribed = true;
        widgetIsReady = true;
        sendQuoteSubscribe();
        querySymbolInfo();
        return;
      }

      const detectedInterval = extractIntervalFromRecord(
        msg.data && typeof msg.data === 'object' ? msg.data : undefined
      );
      if (detectedInterval) {
        reportIntervalIfChanged(detectedInterval);
      }

      if (msg.name === 'quoteUpdate' && msg.data && typeof msg.data === 'object') {
        const d = msg.data;
        const shortName = typeof d.short_name === 'string' ? d.short_name : '';
        const originalName = typeof d.original_name === 'string' ? d.original_name : '';
        const price = typeof d.last_price === 'number' ? d.last_price : NaN;
        const changePercent = typeof d.change_percent === 'number' ? d.change_percent : 0;
        const description = typeof d.description === 'string' ? d.description : undefined;

        if (!shortName) return;

        const fullSymbol = originalName || shortName;

        // Ignore stale in-flight quote ticks from the previous symbol right after an external set-symbol
        if (pendingExternalSwitch) {
          if (Date.now() < pendingExternalSwitch.until && fullSymbol === pendingExternalSwitch.prev) {
            return;
          }
          pendingExternalSwitch = null;
        }

        mountedSymbol = fullSymbol;
        lastReportedSymbol = fullSymbol;

        onQuote?.({
          symbol: fullSymbol,
          shortName,
          price,
          changePercent,
          description,
          interval: detectedInterval ?? undefined
        });
      }
    }

    const handleQuickSync = () => {
      if (widgetIsReady) querySymbolInfo();
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('blur', handleQuickSync);
    window.addEventListener('beforeunload', handleQuickSync);

    void loadTradingView()
      .then((tv) => {
        if (cancelled || !hostEl) return;
        const instance = new tv.widget(currentOptions);
        widgetInstance = instance;

        if (typeof instance.ready === 'function') {
          instance.ready(() => {
            if (cancelled) return;
            widgetIsReady = true;
            if (!subscribed) {
              subscribed = true;
              sendQuoteSubscribe();
            }
            querySymbolInfo();
          });
        }

        // Poll symbolInfo quietly so timeframe/interval changes persist across restarts
        infoTimer = setInterval(() => {
          if (!cancelled && widgetIsReady) {
            querySymbolInfo();
          }
        }, 2500);

        // Subscribe once the iframe loads (and retry briefly in case widgetReady fired early)
        const iframe = root.querySelector<HTMLIFrameElement>('iframe');
        const kickSubscribe = () => {
          if (cancelled) return;
          sendQuoteSubscribe();
          // One gentle retry after widget model initializes
          pollTimer = setTimeout(() => {
            if (!cancelled) {
              sendQuoteSubscribe();
              querySymbolInfo();
            }
          }, 1800);
        };

        if (iframe) {
          iframe.addEventListener('load', kickSubscribe, { once: true });
        } else {
          pollTimer = setTimeout(kickSubscribe, 1500);
        }
      })
      .catch(() => {
        // Ignore transient offline/unload errors
      });

    return () => {
      cancelled = true;
      widgetIsReady = false;
      widgetInstance = null;
      if (pollTimer) clearTimeout(pollTimer);
      if (infoTimer) clearInterval(infoTimer);
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('blur', handleQuickSync);
      window.removeEventListener('beforeunload', handleQuickSync);
      root.innerHTML = '';
    };
  });
</script>

<div class="chart-shell" aria-label="TradingView chart">
  <div bind:this={hostEl} id={containerId} class="tv-host"></div>
</div>

<style>
  .chart-shell {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .tv-host {
    width: 100%;
    height: 100%;
  }

  .tv-host :global(iframe) {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }
</style>
