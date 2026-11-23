const TV_SCRIPT_SRC = 'https://s3.tradingview.com/tv.js';

export interface TvSymbolInfo {
  name?: string;
  exchange?: string;
  description?: string;
  type?: string;
  interval?: string;
}

export interface TvWidgetInstance {
  ready?: (cb: () => void) => void;
  postMessage?: {
    get: (name: string, data: Record<string, unknown>, cb: (res: TvSymbolInfo) => void) => void;
    post?: (name: string, data?: unknown) => void;
  };
}

export interface TradingViewGlobal {
  widget: new (options: Record<string, unknown>) => TvWidgetInstance;
}

declare global {
  interface Window {
    TradingView?: TradingViewGlobal;
  }
}

let loadPromise: Promise<TradingViewGlobal> | null = null;

export function loadTradingView(): Promise<TradingViewGlobal> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('TradingView requires a browser environment'));
  }

  if (window.TradingView?.widget) {
    return Promise.resolve(window.TradingView);
  }

  if (loadPromise) return loadPromise;

  loadPromise = new Promise<TradingViewGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TV_SCRIPT_SRC}"]`);

    const onLoad = () => {
      if (window.TradingView?.widget) {
        resolve(window.TradingView);
      } else {
        loadPromise = null;
        reject(new Error('TradingView global unavailable after script load'));
      }
    };

    const onError = () => {
      loadPromise = null;
      reject(new Error('Failed to load TradingView tv.js'));
    };

    if (existing) {
      existing.addEventListener('load', onLoad, { once: true });
      existing.addEventListener('error', onError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = TV_SCRIPT_SRC;
    script.async = true;
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    document.head.appendChild(script);
  });

  return loadPromise;
}
