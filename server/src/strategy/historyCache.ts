import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getOandaApiKey,
  getOandaEnv,
  isOandaConfigured,
  resolveOandaInstrument
} from '../quotes/oanda.js';
import {
  getStrategyInstrumentSpec,
  normalizeShortTicker,
  normalizeSymbolKey
} from './instruments.js';
import {
  timeframeToOandaGranularity,
  timeframeToSeconds,
  type HistoryFetchResult,
  type OandaBacktestGranularity,
  type StrategyCandle,
  type StrategyTimeframe
} from './types.js';

interface RawOandaMbaCandle {
  complete?: boolean;
  volume?: number;
  time?: string;
  mid?: { o?: string; h?: string; l?: string; c?: string };
  bid?: { o?: string; h?: string; l?: string; c?: string };
  ask?: { o?: string; h?: string; l?: string; c?: string };
}

interface MemoryCacheEntry {
  result: HistoryFetchResult;
  fetchedAt: number;
}

interface DiskCachePayload {
  symbol: string;
  shortName: string;
  instrument: string;
  timeframe: StrategyTimeframe;
  dataSource: 'oanda_mba' | 'yahoo_indicative';
  dataQualityNote: string;
  savedAt: number;
  bars: StrategyCandle[];
}

const CACHE_DIR = path.join(os.tmpdir(), 'deplyze-strategy-candles');
const MEMORY_TTL_MS = 45_000;
const DISK_FRESH_MS = 10 * 60 * 1000; // reuse disk chunk and only append tail if older than 45s
const MAX_MEM_ENTRIES = 36;
const OANDA_PAGE_LIMIT = 5000;
const FETCH_TIMEOUT_MS = 14_000;

const memCache = new Map<string, MemoryCacheEntry>();
const inflightMap = new Map<string, Promise<HistoryFetchResult | null>>();

function getOandaBaseUrl(): string {
  return getOandaEnv() === 'live'
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}

function defaultTargetPages(tf: StrategyTimeframe): number {
  switch (tf) {
    case '1m':
      return 2; // 10,000 bars (~7.5 days)
    case '5m':
      return 3; // 15,000 bars (~72 days)
    case '15m':
      return 4; // 20,000 bars (~10 months)
    case '30m':
      return 3; // 15,000 bars (~1.2 years)
    case '1h':
      return 2; // 10,000 bars (~1.7 years)
    case '4h':
      return 1; // 5,000 bars (~3.2 years)
    case '1D':
      return 1; // 5,000 bars (~18 years)
    case '1W':
      return 1; // ~1,079 bars (~20 years)
  }
}

function ensureCacheDir(): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
  } catch {
    // Non-fatal if tmpdir is read-only
  }
}

function diskCachePath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function loadDiskCache(key: string): DiskCachePayload | null {
  try {
    const file = diskCachePath(key);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as DiskCachePayload;
    if (!parsed || !Array.isArray(parsed.bars) || parsed.bars.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveDiskCache(key: string, payload: DiskCachePayload): void {
  try {
    ensureCacheDir();
    writeFileSync(diskCachePath(key), JSON.stringify(payload), 'utf-8');
  } catch {
    // Non-fatal
  }
}

async function fetchOandaJson(url: string, apiKey: string): Promise<unknown | null> {
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
      if (res.ok) return await res.json();
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return null;
    } catch {
      if (attempt === 1) return null;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
  }
  return null;
}

function parseOandaMbaCandles(
  rawCandles: RawOandaMbaCandle[],
  barSec: number,
  includeIncomplete = false
): StrategyCandle[] {
  const out: StrategyCandle[] = [];
  for (const c of rawCandles) {
    if (!includeIncomplete && c.complete === false) continue;
    const tsMs = c.time ? Date.parse(c.time) : NaN;
    const o = Number(c.mid?.o);
    const h = Number(c.mid?.h);
    const l = Number(c.mid?.l);
    const cl = Number(c.mid?.c);
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
    const bidO = Number.isFinite(Number(c.bid?.o)) ? Number(c.bid?.o) : o;
    const bidH = Number.isFinite(Number(c.bid?.h)) ? Number(c.bid?.h) : h;
    const bidL = Number.isFinite(Number(c.bid?.l)) ? Number(c.bid?.l) : l;
    const bidC = Number.isFinite(Number(c.bid?.c)) ? Number(c.bid?.c) : cl;
    const askO = Number.isFinite(Number(c.ask?.o)) ? Number(c.ask?.o) : o;
    const askH = Number.isFinite(Number(c.ask?.h)) ? Number(c.ask?.h) : h;
    const askL = Number.isFinite(Number(c.ask?.l)) ? Number(c.ask?.l) : l;
    const askC = Number.isFinite(Number(c.ask?.c)) ? Number(c.ask?.c) : cl;
    const spread = askC >= bidC ? askC - bidC : Math.abs(askC - bidC);
    const ts = Math.floor(tsMs / 1000);
    out.push({
      ts,
      closeTs: ts + barSec,
      open: o,
      high: Math.max(h, o, cl),
      low: Math.min(l, o, cl),
      close: cl,
      bidO,
      bidH: Math.max(bidH, bidO, bidC),
      bidL: Math.min(bidL, bidO, bidC),
      bidC,
      askO,
      askH: Math.max(askH, askO, askC),
      askL: Math.min(askL, askO, askC),
      askC,
      volume: typeof c.volume === 'number' && Number.isFinite(c.volume) ? c.volume : 0,
      spread
    });
  }
  return out;
}

function dedupeAndSort(bars: StrategyCandle[]): StrategyCandle[] {
  const byTs = new Map<number, StrategyCandle>();
  for (const b of bars) {
    byTs.set(b.ts, b);
  }
  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

async function fetchOandaPages(
  instrument: string,
  gran: OandaBacktestGranularity,
  barSec: number,
  pages: number,
  apiKey: string
): Promise<StrategyCandle[]> {
  const base = getOandaBaseUrl();
  const collected: StrategyCandle[] = [];
  let cursorTo: string | null = null;

  for (let p = 0; p < pages; p++) {
    const query = cursorTo
      ? `granularity=${gran}&to=${encodeURIComponent(cursorTo)}&count=${OANDA_PAGE_LIMIT}&price=MBA`
      : `granularity=${gran}&count=${OANDA_PAGE_LIMIT}&price=MBA`;
    const url = `${base}/v3/instruments/${encodeURIComponent(instrument)}/candles?${query}`;
    const json = (await fetchOandaJson(url, apiKey)) as {
      candles?: RawOandaMbaCandle[];
    } | null;
    const raw = json?.candles;
    if (!Array.isArray(raw) || raw.length === 0) break;

    const parsed = parseOandaMbaCandles(raw, barSec, false);
    if (parsed.length === 0) break;
    collected.push(...parsed);

    if (raw.length < OANDA_PAGE_LIMIT - 20) break; // reached start of instrument history
    const oldestTime = raw[0]?.time;
    if (!oldestTime || oldestTime === cursorTo) break;
    // Step 1 second earlier so the oldest candle isn't re-fetched endlessly
    const oldestMs = Date.parse(oldestTime);
    if (!Number.isFinite(oldestMs)) break;
    cursorTo = new Date(oldestMs - 1000).toISOString();
  }

  return dedupeAndSort(collected);
}

async function fetchOandaTail(
  instrument: string,
  gran: OandaBacktestGranularity,
  barSec: number,
  count: number,
  apiKey: string
): Promise<StrategyCandle[]> {
  const base = getOandaBaseUrl();
  const clamped = Math.max(10, Math.min(500, count));
  const url = `${base}/v3/instruments/${encodeURIComponent(instrument)}/candles?granularity=${gran}&count=${clamped}&price=MBA`;
  const json = (await fetchOandaJson(url, apiKey)) as {
    candles?: RawOandaMbaCandle[];
  } | null;
  if (!json || !Array.isArray(json.candles)) return [];
  return dedupeAndSort(parseOandaMbaCandles(json.candles, barSec, false));
}

function resolveYahooFallbackTicker(rawSymbol: string): string {
  const short = normalizeShortTicker(rawSymbol);
  const key = normalizeSymbolKey(short);
  const map: Record<string, string> = {
    DXY: 'DX-Y.NYB',
    XAUUSD: 'GC=F',
    GOLD: 'GC=F',
    XAGUSD: 'SI=F',
    USOIL: 'CL=F',
    UKOIL: 'BZ=F',
    NAS100: '^NDX',
    SPX: '^GSPC',
    US500: '^GSPC',
    US30: '^DJI',
    BTCUSD: 'BTC-USD',
    ETHUSD: 'ETH-USD',
    SOLUSD: 'SOL-USD',
    XRPUSD: 'XRP-USD',
    DOGEUSD: 'DOGE-USD',
    BNBUSD: 'BNB-USD',
    AVAXUSD: 'AVAX-USD',
    LINKUSD: 'LINK-USD'
  };
  if (map[key]) return map[key];
  if (key.length === 6 && /^[A-Z]{6}$/.test(key)) return `${key}=X`;
  if (key.endsWith('USD') && key.length >= 6) return `${key.slice(0, -3)}-USD`;
  return short;
}

function mapTfToYahooParams(tf: StrategyTimeframe): { interval: string; range: string } {
  switch (tf) {
    case '1m':
      return { interval: '1m', range: '7d' };
    case '5m':
      return { interval: '5m', range: '60d' };
    case '15m':
      return { interval: '15m', range: '60d' };
    case '30m':
      return { interval: '30m', range: '60d' };
    case '1h':
      return { interval: '60m', range: '730d' };
    case '4h':
      return { interval: '60m', range: '730d' }; // aggregated to 4h
    case '1D':
      return { interval: '1d', range: '10y' };
    case '1W':
      return { interval: '1wk', range: '15y' };
  }
}

function aggregateCandles(bars: StrategyCandle[], targetSec: number): StrategyCandle[] {
  const buckets = new Map<number, StrategyCandle>();
  for (const b of bars) {
    const bucketTs = Math.floor(b.ts / targetSec) * targetSec;
    const prev = buckets.get(bucketTs);
    if (!prev) {
      buckets.set(bucketTs, { ...b, ts: bucketTs, closeTs: bucketTs + targetSec });
    } else {
      prev.high = Math.max(prev.high, b.high);
      prev.low = Math.min(prev.low, b.low);
      prev.close = b.close;
      prev.bidH = Math.max(prev.bidH, b.bidH);
      prev.bidL = Math.min(prev.bidL, b.bidL);
      prev.bidC = b.bidC;
      prev.askH = Math.max(prev.askH, b.askH);
      prev.askL = Math.min(prev.askL, b.askL);
      prev.askC = b.askC;
      prev.volume += b.volume;
      prev.spread = b.spread;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

async function fetchYahooFallbackBars(
  symbol: string,
  shortName: string,
  tf: StrategyTimeframe
): Promise<HistoryFetchResult | null> {
  const ticker = resolveYahooFallbackTicker(symbol);
  const { interval, range } = mapTfToYahooParams(tf);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }>;
      };
    };
    const r0 = json.chart?.result?.[0];
    const tsList = r0?.timestamp ?? [];
    const q = r0?.indicators?.quote?.[0];
    if (!q || tsList.length === 0) return null;

    const spec = getStrategyInstrumentSpec(symbol);
    const halfSpread = spec.defaultSpreadPrice / 2;
    const rawBarSec = tf === '4h' ? 3600 : timeframeToSeconds(tf);
    const out: StrategyCandle[] = [];

    for (let i = 0; i < tsList.length; i++) {
      const ts = tsList[i];
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i] ?? 0;
      if (
        typeof ts !== 'number' ||
        typeof o !== 'number' ||
        typeof h !== 'number' ||
        typeof l !== 'number' ||
        typeof c !== 'number' ||
        !Number.isFinite(c) ||
        c <= 0
      ) {
        continue;
      }
      const hi = Math.max(h, o, c);
      const lo = Math.min(l, o, c);
      out.push({
        ts,
        closeTs: ts + rawBarSec,
        open: o,
        high: hi,
        low: lo,
        close: c,
        bidO: Math.max(spec.tickSize, o - halfSpread),
        bidH: Math.max(spec.tickSize, hi - halfSpread),
        bidL: Math.max(spec.tickSize, lo - halfSpread),
        bidC: Math.max(spec.tickSize, c - halfSpread),
        askO: o + halfSpread,
        askH: hi + halfSpread,
        askL: lo + halfSpread,
        askC: c + halfSpread,
        volume: typeof v === 'number' && Number.isFinite(v) ? v : 0,
        spread: spec.defaultSpreadPrice
      });
    }

    const finalBars = tf === '4h' ? aggregateCandles(out, 14400) : dedupeAndSort(out);
    if (finalBars.length < 30) return null;

    return {
      symbol,
      shortName,
      instrument: ticker,
      timeframe: tf,
      bars: finalBars,
      dataSource: 'yahoo_indicative',
      dataQualityNote: `Yahoo Finance indicative OHLC (${ticker}) with simulated ${spec.defaultSpreadPrice} instrument spread.`,
      fromCache: false
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchHistoryOptions {
  maxPages?: number;
  forceRefresh?: boolean;
  tailOnlyCount?: number; // for lightweight live evaluation (e.g. 260 bars)
}

/**
 * Loads deep Bid/Mid/Ask historical candles for backtesting or live signal evaluation.
 * Uses two-tier cache (in-memory LRU + OS temp disk cache) so repeat iterations &
 * Properties edits re-run in < 5ms without re-hitting OANDA.
 */
export async function fetchStrategyHistory(
  rawSymbol: string,
  timeframe: StrategyTimeframe,
  opts: FetchHistoryOptions = {}
): Promise<HistoryFetchResult | null> {
  const shortName = normalizeShortTicker(rawSymbol);
  const symbol = rawSymbol.includes(':') ? rawSymbol.trim().toUpperCase() : `OANDA:${shortName}`;
  const pages = opts.maxPages ?? defaultTargetPages(timeframe);
  const isTailOnly = typeof opts.tailOnlyCount === 'number' && opts.tailOnlyCount > 0;
  const cacheKey = `${normalizeSymbolKey(shortName)}_${timeframe}_${isTailOnly ? `tail${opts.tailOnlyCount}` : `p${pages}`}`;

  const now = Date.now();
  if (!opts.forceRefresh) {
    const mem = memCache.get(cacheKey);
    if (mem && now - mem.fetchedAt < MEMORY_TTL_MS) {
      return { ...mem.result, fromCache: true };
    }
    const pending = inflightMap.get(cacheKey);
    if (pending) return pending;
  }

  const task = (async (): Promise<HistoryFetchResult | null> => {
    try {
      const barSec = timeframeToSeconds(timeframe);
      const gran = timeframeToOandaGranularity(timeframe);
      const instrument = resolveOandaInstrument(shortName);

      if (isOandaConfigured() && instrument) {
        const apiKey = getOandaApiKey();

        // Fast path for live evaluation tail-only calls
        if (isTailOnly) {
          const tailBars = await fetchOandaTail(
            instrument,
            gran,
            barSec,
            opts.tailOnlyCount!,
            apiKey
          );
          if (tailBars.length >= 20) {
            const resObj: HistoryFetchResult = {
              symbol,
              shortName,
              instrument,
              timeframe,
              bars: tailBars,
              dataSource: 'oanda_mba',
              dataQualityNote: `OANDA v20 live MBA candles (${instrument} · ${gran}) with exact historical Bid/Ask spreads.`,
              fromCache: false
            };
            storeMem(cacheKey, resObj);
            return resObj;
          }
        }

        // Check Tier 2 disk cache first for full backtest histories
        const disk = !opts.forceRefresh ? loadDiskCache(cacheKey) : null;
        if (disk && disk.bars.length >= 100) {
          const ageMs = Date.now() - disk.savedAt;
          if (ageMs < DISK_FRESH_MS) {
            // Merge a small fresh tail so newly closed bars are included without re-paging 20,000 bars
            const tail = await fetchOandaTail(instrument, gran, barSec, 60, apiKey);
            const merged = tail.length > 0 ? dedupeAndSort([...disk.bars, ...tail]) : disk.bars;
            const resObj: HistoryFetchResult = {
              symbol,
              shortName,
              instrument,
              timeframe,
              bars: merged,
              dataSource: 'oanda_mba',
              dataQualityNote: `OANDA v20 MBA history (${instrument} · ${gran}, ${merged.length.toLocaleString('en-US')} bars) with actual per-bar Bid/Ask spreads.`,
              fromCache: true
            };
            storeMem(cacheKey, resObj);
            if (tail.length > 0) {
              saveDiskCache(cacheKey, { ...disk, savedAt: Date.now(), bars: merged });
            }
            return resObj;
          }
        }

        // Full multi-page OANDA MBA fetch
        const bars = await fetchOandaPages(instrument, gran, barSec, pages, apiKey);
        if (bars.length >= 40) {
          const note = `OANDA v20 MBA history (${instrument} · ${gran}, ${bars.length.toLocaleString('en-US')} bars) with actual per-bar Bid/Ask spreads.`;
          const resObj: HistoryFetchResult = {
            symbol,
            shortName,
            instrument,
            timeframe,
            bars,
            dataSource: 'oanda_mba',
            dataQualityNote: note,
            fromCache: false
          };
          storeMem(cacheKey, resObj);
          saveDiskCache(cacheKey, {
            symbol,
            shortName,
            instrument,
            timeframe,
            dataSource: 'oanda_mba',
            dataQualityNote: note,
            savedAt: Date.now(),
            bars
          });
          return resObj;
        }
      }

      // Fallback to Yahoo indicative history for equities / altcoins / DXY when OANDA instrument unavailable
      const diskFallback = !opts.forceRefresh ? loadDiskCache(cacheKey) : null;
      if (diskFallback && Date.now() - diskFallback.savedAt < DISK_FRESH_MS) {
        const resObj: HistoryFetchResult = {
          symbol,
          shortName,
          instrument: diskFallback.instrument,
          timeframe,
          bars: diskFallback.bars,
          dataSource: diskFallback.dataSource,
          dataQualityNote: diskFallback.dataQualityNote,
          fromCache: true
        };
        storeMem(cacheKey, resObj);
        return resObj;
      }

      const yahoo = await fetchYahooFallbackBars(symbol, shortName, timeframe);
      if (yahoo) {
        storeMem(cacheKey, yahoo);
        saveDiskCache(cacheKey, {
          symbol: yahoo.symbol,
          shortName: yahoo.shortName,
          instrument: yahoo.instrument,
          timeframe: yahoo.timeframe,
          dataSource: yahoo.dataSource,
          dataQualityNote: yahoo.dataQualityNote,
          savedAt: Date.now(),
          bars: yahoo.bars
        });
        return yahoo;
      }

      return null;
    } finally {
      inflightMap.delete(cacheKey);
    }
  })();

  inflightMap.set(cacheKey, task);
  return task;
}

function storeMem(key: string, result: HistoryFetchResult): void {
  memCache.set(key, { result, fetchedAt: Date.now() });
  if (memCache.size > MAX_MEM_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
}

export function sliceBarsByDateRange(
  bars: StrategyCandle[],
  fromTs?: number | null,
  toTs?: number | null
): StrategyCandle[] {
  if (!fromTs && !toTs) return bars;
  return bars.filter((b) => {
    if (typeof fromTs === 'number' && Number.isFinite(fromTs) && b.ts < fromTs) return false;
    if (typeof toTs === 'number' && Number.isFinite(toTs) && b.ts > toTs) return false;
    return true;
  });
}
