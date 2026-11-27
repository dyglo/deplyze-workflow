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
  COPPER: 'XCU_USD',
  XCUUSD: 'XCU_USD',
  NATGAS: 'NATGAS_USD',
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
  AUDJPY: 'AUD_JPY',
  CADJPY: 'CAD_JPY',
  EURAUD: 'EUR_AUD',
  GBPAUD: 'GBP_AUD',
  NAS100: 'NAS100_USD',
  NDX: 'NAS100_USD',
  SPX: 'SPX500_USD',
  US500: 'SPX500_USD',
  US30: 'US30_USD',
  DJI: 'US30_USD',
  GER40: 'DE30_EUR',
  DEU40: 'DE30_EUR',
  DAX: 'DE30_EUR',
  JP225: 'JP225_USD',
  NI225: 'JP225_USD',
  USOIL: 'WTICO_USD',
  WTI: 'WTICO_USD',
  OILUSD: 'WTICO_USD',
  WTICOUSD: 'WTICO_USD',
  UKOIL: 'BCO_USD',
  BRENT: 'BCO_USD',
  BTCUSD: 'BTC_USD',
  ETHUSD: 'ETH_USD',
  UK100: 'UK100_GBP',
  UKX: 'UK100_GBP',
  USB10Y: 'USB10Y_USD'
};

export interface OandaLivePricing {
  instrument: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPx: number;
  spreadPct: number;
  tradeable: boolean;
  time: string;
}

export type OandaCrowdSkew = 'crowded_long' | 'crowded_short' | 'balanced';

export interface OandaPositionBookSummary {
  instrument: string;
  price: number;
  longPct: number;
  shortPct: number;
  trappedLongPct: number;
  trappedShortPct: number;
  skew: OandaCrowdSkew;
  updatedAt: string;
}

const POSITION_BOOK_INSTRUMENTS = new Set<string>([
  'XAU_USD',
  'XAG_USD',
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'AUD_USD',
  'USD_CAD',
  'USD_CHF',
  'NZD_USD',
  'GBP_JPY',
  'EUR_JPY',
  'EUR_GBP',
  'AUD_JPY',
  'EUR_AUD'
]);

const FETCH_TIMEOUT_MS = 10_000;
const SERIES_CACHE_TTL_MS = 45_000;
const PRICING_CACHE_TTL_MS = 10_000;
const ACCOUNT_META_TTL_MS = 30 * 60 * 1000;
const POSITION_BOOK_TTL_MS = 5 * 60 * 1000;

const seriesCache = new Map<string, { data: OandaSeriesResult; fetchedAt: number }>();
const seriesInflight = new Map<string, Promise<OandaSeriesResult | null>>();

let accountMetaCache: {
  accountId: string;
  pricingInstruments: Set<string>;
  fetchedAt: number;
} | null = null;
let accountMetaInflight: Promise<{ accountId: string; pricingInstruments: Set<string> } | null> | null =
  null;

const pricingCache = new Map<string, { data: OandaLivePricing; fetchedAt: number }>();
const positionBookCache = new Map<string, { data: OandaPositionBookSummary; fetchedAt: number }>();
const positionBookInflight = new Map<string, Promise<OandaPositionBookSummary | null>>();

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

async function resolveOandaAccountMeta(
  apiKey: string
): Promise<{ accountId: string; pricingInstruments: Set<string> } | null> {
  const now = Date.now();
  if (accountMetaCache && now - accountMetaCache.fetchedAt < ACCOUNT_META_TTL_MS) {
    return {
      accountId: accountMetaCache.accountId,
      pricingInstruments: accountMetaCache.pricingInstruments
    };
  }
  if (accountMetaInflight) return accountMetaInflight;

  accountMetaInflight = (async () => {
    try {
      let accountId = cleanEnvValue(process.env.OANDA_ACCOUNT_ID);
      if (!accountId) {
        const accJson = (await fetchJsonWithRetry(`${getOandaBaseUrl()}/v3/accounts`, apiKey)) as {
          accounts?: { id?: string }[];
        } | null;
        accountId = accJson?.accounts?.[0]?.id?.trim() ?? '';
      }
      if (!accountId) return null;

      const instJson = (await fetchJsonWithRetry(
        `${getOandaBaseUrl()}/v3/accounts/${encodeURIComponent(accountId)}/instruments`,
        apiKey
      )) as { instruments?: { name?: string }[] } | null;

      const pricingInstruments = new Set<string>();
      for (const item of instJson?.instruments ?? []) {
        if (typeof item.name === 'string' && item.name.trim()) {
          pricingInstruments.add(item.name.trim().toUpperCase());
        }
      }

      const meta = { accountId, pricingInstruments };
      accountMetaCache = { ...meta, fetchedAt: Date.now() };
      return meta;
    } catch {
      return null;
    } finally {
      accountMetaInflight = null;
    }
  })();

  return accountMetaInflight;
}

/**
 * Fetches live institutional Bid/Ask/Mid/Spread quotes in a single batch HTTP call
 * for all requested symbols permitted on the configured OANDA account.
 */
export async function fetchOandaBatchPricing(
  shortNames: string[],
  force = false
): Promise<Map<string, OandaLivePricing>> {
  const out = new Map<string, OandaLivePricing>();
  const apiKey = getOandaApiKey();
  if (!apiKey || shortNames.length === 0) return out;

  const meta = await resolveOandaAccountMeta(apiKey);
  if (!meta || meta.pricingInstruments.size === 0) return out;

  const now = Date.now();
  const toFetch: string[] = [];

  for (const raw of shortNames) {
    const inst = resolveOandaInstrument(raw);
    if (!inst || !meta.pricingInstruments.has(inst)) continue;
    const cached = pricingCache.get(inst);
    if (!force && cached && now - cached.fetchedAt < PRICING_CACHE_TTL_MS) {
      out.set(inst, cached.data);
    } else if (!toFetch.includes(inst)) {
      toFetch.push(inst);
    }
  }

  if (toFetch.length === 0) return out;

  try {
    const url = `${getOandaBaseUrl()}/v3/accounts/${encodeURIComponent(meta.accountId)}/pricing?instruments=${encodeURIComponent(toFetch.join(','))}`;
    const json = (await fetchJsonWithRetry(url, apiKey)) as {
      prices?: {
        instrument?: string;
        status?: string;
        time?: string;
        bids?: { price?: string }[];
        asks?: { price?: string }[];
      }[];
    } | null;

    const fetchedAt = Date.now();
    for (const p of json?.prices ?? []) {
      const inst = p.instrument?.toUpperCase();
      if (!inst) continue;
      const bid = Number(p.bids?.[0]?.price);
      const ask = Number(p.asks?.[0]?.price);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
      const mid = (bid + ask) / 2;
      const spreadPx = Math.max(0, ask - bid);
      const spreadPct = mid > 0 ? Number(((spreadPx / mid) * 100).toFixed(4)) : 0;

      const entry: OandaLivePricing = {
        instrument: inst,
        bid,
        ask,
        mid,
        spreadPx: Number(spreadPx.toFixed(6)),
        spreadPct,
        tradeable: p.status === 'tradeable',
        time: p.time || new Date(fetchedAt).toISOString()
      };
      pricingCache.set(inst, { data: entry, fetchedAt });
      out.set(inst, entry);
    }
  } catch (err) {
    console.warn('[oanda] batch pricing failed:', (err as Error).message);
  }

  return out;
}

export function hasOandaPositionBook(shortName: string): boolean {
  const inst = resolveOandaInstrument(shortName);
  return inst !== null && POSITION_BOOK_INSTRUMENTS.has(inst);
}

/**
 * Fetches OANDA's institutional open client Position Book for supported FX & Metals
 * instruments (cached 5m) and computes net crowd skew + trapped underwater percentages.
 */
export async function fetchOandaPositionBook(
  shortName: string,
  force = false
): Promise<OandaPositionBookSummary | null> {
  const apiKey = getOandaApiKey();
  if (!apiKey) return null;

  const inst = resolveOandaInstrument(shortName);
  if (!inst || !POSITION_BOOK_INSTRUMENTS.has(inst)) return null;

  const now = Date.now();
  if (!force) {
    const cached = positionBookCache.get(inst);
    if (cached && now - cached.fetchedAt < POSITION_BOOK_TTL_MS) {
      return cached.data;
    }
    const existing = positionBookInflight.get(inst);
    if (existing) return existing;
  }

  const task = (async (): Promise<OandaPositionBookSummary | null> => {
    try {
      const url = `${getOandaBaseUrl()}/v3/instruments/${encodeURIComponent(inst)}/positionBook`;
      const json = (await fetchJsonWithRetry(url, apiKey)) as {
        positionBook?: {
          price?: string;
          time?: string;
          buckets?: {
            price?: string;
            longCountPercent?: string;
            shortCountPercent?: string;
          }[];
        };
      } | null;

      const pb = json?.positionBook;
      const spot = Number(pb?.price);
      if (!pb || !Number.isFinite(spot) || spot <= 0 || !Array.isArray(pb.buckets) || pb.buckets.length === 0) {
        return positionBookCache.get(inst)?.data ?? null;
      }

      let totalLong = 0;
      let totalShort = 0;
      let underwaterLong = 0;
      let underwaterShort = 0;

      for (const b of pb.buckets) {
        const bp = Number(b.price);
        const lp = Number(b.longCountPercent);
        const sp = Number(b.shortCountPercent);
        if (!Number.isFinite(bp)) continue;
        if (Number.isFinite(lp) && lp > 0) {
          totalLong += lp;
          if (bp > spot) underwaterLong += lp;
        }
        if (Number.isFinite(sp) && sp > 0) {
          totalShort += sp;
          if (bp < spot) underwaterShort += sp;
        }
      }

      const total = totalLong + totalShort;
      if (total <= 0) return positionBookCache.get(inst)?.data ?? null;

      const longPct = Number(((totalLong / total) * 100).toFixed(1));
      const shortPct = Number((100 - longPct).toFixed(1));
      const trappedLongPct = totalLong > 0 ? Number(((underwaterLong / totalLong) * 100).toFixed(0)) : 0;
      const trappedShortPct = totalShort > 0 ? Number(((underwaterShort / totalShort) * 100).toFixed(0)) : 0;
      const skew: OandaCrowdSkew =
        longPct >= 62 ? 'crowded_long' : shortPct >= 62 ? 'crowded_short' : 'balanced';

      const summary: OandaPositionBookSummary = {
        instrument: inst,
        price: spot,
        longPct,
        shortPct,
        trappedLongPct,
        trappedShortPct,
        skew,
        updatedAt: pb.time || new Date().toISOString()
      };
      positionBookCache.set(inst, { data: summary, fetchedAt: Date.now() });
      return summary;
    } catch (err) {
      console.warn(`[oanda] positionBook ${inst} failed:`, (err as Error).message);
      return positionBookCache.get(inst)?.data ?? null;
    } finally {
      positionBookInflight.delete(inst);
    }
  })();

  positionBookInflight.set(inst, task);
  return task;
}
