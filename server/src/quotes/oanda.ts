export type OandaGranularity = 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D';

export interface OandaBar {
  ts: number; // Unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread: number; // Ask close - Bid close
}

export interface OandaSeriesResult {
  instrument: string;
  bars: OandaBar[];
  livePrice: number | null;
  liveSpreadPx: number | null;
  liveSpreadPct: number | null;
  source: 'oanda';
}

const OANDA_INSTRUMENT_MAP: Record<string, string> = {
  XAUUSD: 'XAU_USD',
  GOLD: 'XAU_USD',
  XAGUSD: 'XAG_USD',
  SILVER: 'XAG_USD',
  EURUSD: 'EUR_USD',
  GBPUSD: 'GBP_USD',
  USDJPY: 'USD_JPY',
  AUDUSD: 'AUD_USD',
  USDCAD: 'USD_CAD',
  NZDUSD: 'NZD_USD',
  USDCHF: 'USD_CHF',
  USDSEK: 'USD_SEK',
  GBPJPY: 'GBP_JPY',
  EURJPY: 'EUR_JPY',
  EURGBP: 'EUR_GBP',
  NAS100: 'NAS100_USD',
  NDX: 'NAS100_USD',
  SPX: 'SPX500_USD',
  US500: 'SPX500_USD',
  US30: 'US30_USD',
  DJI: 'US30_USD',
  USOIL: 'WTICO_USD',
  WTI: 'WTICO_USD',
  OILUSD: 'WTICO_USD',
  WTICOUSD: 'WTICO_USD',
  UKOIL: 'BCO_USD',
  BRENT: 'BCO_USD',
  BTCUSD: 'BTC_USD',
  ETHUSD: 'ETH_USD',
  UK100: 'UK100_GBP',
  USB10Y: 'USB10Y_USD'
};

const FETCH_TIMEOUT_MS = 10_000;
const SERIES_CACHE_TTL_MS = 45_000;

const seriesCache = new Map<string, { data: OandaSeriesResult; fetchedAt: number }>();
const seriesInflight = new Map<string, Promise<OandaSeriesResult | null>>();

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/\s+#.*$/, '').trim();
}

export function getOandaApiKey(): string {
  return cleanEnvValue(process.env.OANDA_API_KEY);
}

export function getOandaEnv(): 'live' | 'practice' {
  const v = cleanEnvValue(process.env.OANDA_ENV).toLowerCase();
  return v === 'live' || v === 'trade' || v === 'fxtrade' ? 'live' : 'practice';
}

export function isOandaConfigured(): boolean {
  return getOandaApiKey().length >= 16;
}

function getOandaBaseUrl(): string {
  return getOandaEnv() === 'live'
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}

export function resolveOandaInstrument(shortName: string): string | null {
  const clean = shortName.includes(':')
    ? shortName.slice(shortName.indexOf(':') + 1).trim().toUpperCase()
    : shortName.trim().toUpperCase();
  return OANDA_INSTRUMENT_MAP[clean] ?? null;
}

interface RawOandaCandle {
  complete?: boolean;
  volume?: number;
  time?: string;
  mid?: { o?: string; h?: string; l?: string; c?: string };
  bid?: { c?: string };
  ask?: { c?: string };
}

async function fetchJsonWithRetry(url: string, apiKey: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });
      if (res.ok) {
        return await res.json();
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return null;
      }
    } catch {
      if (attempt === 1) return null;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
  }
  return null;
}

export async function fetchOandaSeries(
  shortName: string,
  granularity: OandaGranularity,
  count: number,
  force = false
): Promise<OandaSeriesResult | null> {
  const apiKey = getOandaApiKey();
  if (!apiKey) return null;

  const instrument = resolveOandaInstrument(shortName);
  if (!instrument) return null;

  const clampedCount = Math.max(20, Math.min(500, Math.round(count)));
  const cacheKey = `${instrument}|${granularity}|${clampedCount}`;
  const now = Date.now();

  if (!force) {
    const cached = seriesCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < SERIES_CACHE_TTL_MS) {
      return cached.data;
    }
    const existing = seriesInflight.get(cacheKey);
    if (existing) return existing;
  }

  const task = (async (): Promise<OandaSeriesResult | null> => {
    try {
      const url = `${getOandaBaseUrl()}/v3/instruments/${encodeURIComponent(instrument)}/candles?granularity=${granularity}&count=${clampedCount}&price=MBA`;
      const json = (await fetchJsonWithRetry(url, apiKey)) as {
        candles?: RawOandaCandle[];
      } | null;
      if (!json || !Array.isArray(json.candles) || json.candles.length === 0) {
        const stale = seriesCache.get(cacheKey);
        return stale?.data ?? null;
      }

      const bars: OandaBar[] = [];
      let latestLivePrice: number | null = null;
      let latestSpreadPx: number | null = null;

      for (const c of json.candles) {
        const tsMs = c.time ? Date.parse(c.time) : NaN;
        const o = Number(c.mid?.o);
        const h = Number(c.mid?.h);
        const l = Number(c.mid?.l);
        const cl = Number(c.mid?.c);
        const bidC = Number(c.bid?.c);
        const askC = Number(c.ask?.c);
        if (
          !Number.isFinite(tsMs) ||
          !Number.isFinite(o) ||
          !Number.isFinite(h) ||
          !Number.isFinite(l) ||
          !Number.isFinite(cl) ||
          cl <= 0
        ) {
          continue;
        }
        const spread =
          Number.isFinite(bidC) && Number.isFinite(askC) && askC >= bidC ? askC - bidC : 0;

        bars.push({
          ts: Math.floor(tsMs / 1000),
          open: o,
          high: Math.max(h, o, cl),
          low: Math.min(l, o, cl),
          close: cl,
          volume: typeof c.volume === 'number' && Number.isFinite(c.volume) ? c.volume : 0,
          spread
        });

        latestLivePrice = cl;
        if (spread > 0) latestSpreadPx = spread;
      }

      if (bars.length === 0) return null;
      bars.sort((a, b) => a.ts - b.ts);

      const liveSpreadPct =
        latestLivePrice && latestLivePrice > 0 && latestSpreadPx !== null
          ? Number(((latestSpreadPx / latestLivePrice) * 100).toFixed(4))
          : null;

      const data: OandaSeriesResult = {
        instrument,
        bars,
        livePrice: latestLivePrice,
        liveSpreadPx: latestSpreadPx !== null ? Number(latestSpreadPx.toFixed(6)) : null,
        liveSpreadPct,
        source: 'oanda'
      };

      seriesCache.set(cacheKey, { data, fetchedAt: Date.now() });
      if (seriesCache.size > 160) {
        const oldest = seriesCache.keys().next().value;
        if (oldest) seriesCache.delete(oldest);
      }
      return data;
    } catch (err) {
      console.warn(`[oanda] ${instrument} (${granularity}) failed:`, (err as Error).message);
      const stale = seriesCache.get(cacheKey);
      return stale?.data ?? null;
    } finally {
      seriesInflight.delete(cacheKey);
    }
  })();

  seriesInflight.set(cacheKey, task);
  return task;
}

/**
 * Computes the official ICE U.S. Dollar Index (DXY) synchronized to OANDA's exact candle clock
 * using OANDA's 6 basket pairs: EUR/USD, USD/JPY, GBP/USD, USD/CAD, USD/SEK, USD/CHF.
 */
export async function fetchOandaSyntheticDxy(
  granularity: OandaGranularity,
  count: number,
  force = false
): Promise<OandaSeriesResult | null> {
  if (!isOandaConfigured()) return null;

  const cacheKey = `SYNTH_DXY|${granularity}|${count}`;
  const now = Date.now();
  if (!force) {
    const cached = seriesCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < SERIES_CACHE_TTL_MS) {
      return cached.data;
    }
    const existing = seriesInflight.get(cacheKey);
    if (existing) return existing;
  }

  const task = (async (): Promise<OandaSeriesResult | null> => {
    try {
      // Gentle two-wave batch (3 + 3) so we stay well below OANDA connection burst limits
      const [eur, jpy, gbp] = await Promise.all([
        fetchOandaSeries('EURUSD', granularity, count, force),
        fetchOandaSeries('USDJPY', granularity, count, force),
        fetchOandaSeries('GBPUSD', granularity, count, force)
      ]);
      const [cad, sek, chf] = await Promise.all([
        fetchOandaSeries('USDCAD', granularity, count, force),
        fetchOandaSeries('USDSEK', granularity, count, force),
        fetchOandaSeries('USDCHF', granularity, count, force)
      ]);

      if (!eur || !jpy || !gbp || !cad || !sek || !chf) return null;

      const toMap = (arr: OandaBar[]) => new Map(arr.map((b) => [b.ts, b]));
      const jpyMap = toMap(jpy.bars);
      const gbpMap = toMap(gbp.bars);
      const cadMap = toMap(cad.bars);
      const sekMap = toMap(sek.bars);
      const chfMap = toMap(chf.bars);

      const iceDxy = (e: number, j: number, g: number, c: number, s: number, f: number) =>
        50.14348112 *
        Math.pow(e, -0.576) *
        Math.pow(j, 0.136) *
        Math.pow(g, -0.119) *
        Math.pow(c, 0.091) *
        Math.pow(s, 0.042) *
        Math.pow(f, 0.036);

      const bars: OandaBar[] = [];
      for (const eb of eur.bars) {
        const jb = jpyMap.get(eb.ts);
        const gb = gbpMap.get(eb.ts);
        const cb = cadMap.get(eb.ts);
        const sb = sekMap.get(eb.ts);
        const fb = chfMap.get(eb.ts);
        if (!jb || !gb || !cb || !sb || !fb) continue;

        const o = iceDxy(eb.open, jb.open, gb.open, cb.open, sb.open, fb.open);
        const cl = iceDxy(eb.close, jb.close, gb.close, cb.close, sb.close, fb.close);
        const h = Math.max(o, cl, iceDxy(eb.low, jb.high, gb.low, cb.high, sb.high, fb.high));
        const l = Math.min(o, cl, iceDxy(eb.high, jb.low, gb.high, cb.low, sb.low, fb.low));
        if (!Number.isFinite(cl) || cl <= 0) continue;

        bars.push({
          ts: eb.ts,
          open: o,
          high: h,
          low: l,
          close: cl,
          volume: eb.volume,
          spread: 0.015
        });
      }

      if (bars.length < 20) return null;
      const last = bars[bars.length - 1];
      const data: OandaSeriesResult = {
        instrument: 'ICE_DXY_OANDA',
        bars,
        livePrice: Number(last.close.toFixed(3)),
        liveSpreadPx: 0.015,
        liveSpreadPct: Number(((0.015 / last.close) * 100).toFixed(4)),
        source: 'oanda'
      };
      seriesCache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      console.warn('[oanda] synthetic DXY failed:', (err as Error).message);
      return null;
    } finally {
      seriesInflight.delete(cacheKey);
    }
  })();

  seriesInflight.set(cacheKey, task);
  return task;
}
