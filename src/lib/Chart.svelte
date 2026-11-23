<script module lang="ts">
  let nextId = 0;

  export interface ChartQuote {
    symbol: string; // full symbol e.g. EASYMARKETS:OILUSD
    shortName: string; // e.g. OILUSD
    price: number;
    changePercent: number;
    description?: string;
  }
</script>

<script lang="ts">
  import { loadTradingView } from './chart/tvLoader';
  import { toRgba, type ChartSettings } from './settings/chartSettings';

  interface Props {
    theme: 'dark' | 'light';
    settings: ChartSettings;
    paneId?: string;
    symbol?: string;
    interval?: string;
    collapseSideToolbarByDefault?: boolean;
    onQuote?: (quote: ChartQuote) => void;
  }

  let {
    theme,
    settings,
    paneId = `pane-${++nextId}`,
    symbol = 'OANDA:XAUUSD',
    interval = 'D',
    collapseSideToolbarByDefault = false,
    onQuote
  }: Props = $props();

  let hostEl: HTMLDivElement | undefined = $state();
  const containerId = $derived(`tv-chart-${paneId}`);

  // Track the latest symbol reported by this chart so updating parent state
  // does NOT cause this chart instance to unnecessarily remount.
  // svelte-ignore state_referenced_locally
  let mountedSymbol = symbol;
  let lastReportedSymbol: string | null = null;

  $effect(() => {
    // Only change mountedSymbol if parent switched to a genuinely external symbol
    // (not the one we just reported back from inside this iframe).
    if (symbol !== lastReportedSymbol) {
      mountedSymbol = symbol;
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
      doNotStoreSettings: true,
      overrides
    };

    if (collapseSide) {
      options.enabled_features = ['hide_left_toolbar_by_default'];
    }

    if (!s.verticalGrid && !s.horizontalGrid) {
      options.gridColor = transparent;
    } else if (s.verticalGrid && s.horizontalGrid) {
      options.gridColor = visibleGrid;
    }

    return options;
  }

  // Re-mount ONLY when theme, settings, containerId, interval, or collapseSide changes.
  // `mountedSymbol` is read non-reactively inside the effect so live symbol switches
  // inside the iframe never trigger a reload, while theme toggles / restarts preserve it.
  const optionsKey = $derived(
    JSON.stringify({
      containerId,
      theme,
      settings,
      interval,
      collapseSideToolbarByDefault
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
      interval,
      collapseSideToolbarByDefault
    );

    let cancelled = false;
    let subscribed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
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
        sendQuoteSubscribe();
        return;
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
        mountedSymbol = fullSymbol;
        lastReportedSymbol = fullSymbol;

        onQuote?.({
          symbol: fullSymbol,
          shortName,
          price,
          changePercent,
          description
        });
      }
    }

    window.addEventListener('message', handleMessage);

    void loadTradingView()
      .then((tv) => {
        if (cancelled || !hostEl) return;
        new tv.widget(currentOptions);

        // Subscribe once the iframe loads (and retry briefly in case widgetReady fired early)
        const iframe = root.querySelector<HTMLIFrameElement>('iframe');
        const kickSubscribe = () => {
          if (cancelled) return;
          sendQuoteSubscribe();
          // One gentle retry after widget model initializes
          pollTimer = setTimeout(() => {
            if (!cancelled) sendQuoteSubscribe();
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
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener('message', handleMessage);
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
