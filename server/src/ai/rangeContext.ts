import { getCalendarEventsInWindow } from '../calendar/service.js';
import { addDays, formatPartsInTz, resolveTimeZone } from '../calendar/time.js';
import type { CountryCode, EconomicEvent } from '../calendar/types.js';
import { getNewsFlowPayload, type NewsFlowItem } from '../news/service.js';
import {
  fetchOandaPositionBook,
  fetchOandaSeries,
  fetchOandaSyntheticDxy,
  hasOandaPositionBook,
  isOandaConfigured,
  resolveOandaInstrument,
  type OandaBar,
  type OandaGranularity
} from '../quotes/oanda.js';
import {
  computeBullBearPower,
  computeCci,
  computeEmaSeries,
  computeIchimokuBaseLine,
  computeMacd,
  computeSma,
  computeStoch,
  computeVwma,
  computeWilderAdx,
  computeWilderAtr,
  computeWilderRsi,
  computeWilliamsR,
  roundNum,
  scoreTimeframeTechnicals
} from '../quotes/ta.js';
import { fetchStrategyHistory } from '../strategy/historyCache.js';
import {
  normalizeStrategyTimeframe,
  timeframeToSeconds,
  type StrategyCandle,
  type StrategyTimeframe
} from '../strategy/types.js';
import { inferRelevantCountries, shouldAutoRunWebSearch } from './context.js';
import { isTavilyConfigured, runTavilyFinanceSearch } from './tavily.js';
import type { AiChartContext, AiRangeMode, AiSourceLink } from './types.js';

function getDeepSeekChatUrl(): string {
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    .trim()
    .replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function shortTicker(raw: string): string {
  const s = (raw || '').trim().toUpperCase();
  const idx = s.indexOf(':');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function mapTfToOandaSeriesGran(tf: StrategyTimeframe): OandaGranularity | null {
  switch (tf) {
    case '5m':
      return 'M5';
    case '15m':
      return 'M15';
    case '30m':
      return 'M30';
    case '1h':
      return 'H1';
    case '4h':
      return 'H4';
    case '1D':
      return 'D';
    default:
      return null;
  }
}

function toOandaBar(c: StrategyCandle): OandaBar {
  return {
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    spread: c.spread
  };
}

function dedupeOandaBars(bars: OandaBar[]): OandaBar[] {
  const map = new Map<number, OandaBar>();
  for (const b of bars) {
    map.set(b.ts, b);
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * Loads deep OANDA (or Yahoo fallback) historical bars plus the latest forming candle
 * so both range bar-index calibration and range AI analysis see live market action.
 */
async function loadRangeBarsWithLiveTail(
  rawSymbol: string,
  rawInterval: string | null | undefined,
  maxBars = 1500
): Promise<{
  symbol: string;
  shortName: string;
  interval: StrategyTimeframe;
  barSec: number;
  bars: OandaBar[];
  source: 'oanda' | 'yahoo';
}> {
  const symbol = (rawSymbol || 'OANDA:XAUUSD').trim();
  const short = shortTicker(symbol);
  const tf = normalizeStrategyTimeframe(rawInterval);
  const barSec = timeframeToSeconds(tf);
  const gran = mapTfToOandaSeriesGran(tf);

  // Synthetic DXY via OANDA 6-pair basket when configured
  if (short === 'DXY' && isOandaConfigured() && gran) {
    const synth = await fetchOandaSyntheticDxy(gran, Math.min(500, maxBars), false);
    if (synth && synth.bars.length > 0) {
      return {
        symbol,
        shortName: short,
        interval: tf,
        barSec,
        bars: synth.bars.slice(-maxBars),
        source: 'oanda'
      };
    }
  }

  // Primary: strategy history cache (1 page = up to 5,000 OANDA MBA bars, cached on disk & RAM)
  // plus live tail from fetchOandaSeries to include the currently forming candle!
  const [hist, liveTail] = await Promise.all([
    fetchStrategyHistory(symbol, tf, { maxPages: 1 }),
    isOandaConfigured() && gran && resolveOandaInstrument(short)
      ? fetchOandaSeries(short, gran, 24, false)
      : Promise.resolve(null)
  ]);

  let combined: OandaBar[] = [];
  let source: 'oanda' | 'yahoo' = 'yahoo';

  if (hist && hist.bars.length > 0) {
    combined = hist.bars.map(toOandaBar);
    source = hist.dataSource === 'oanda_mba' ? 'oanda' : 'yahoo';
  }

  if (liveTail && liveTail.bars.length > 0) {
    combined = dedupeOandaBars([...combined, ...liveTail.bars]);
    source = 'oanda';
  }

  if (combined.length > maxBars) {
    combined = combined.slice(combined.length - maxBars);
  }

  return {
    symbol,
    shortName: short,
    interval: tf,
    barSec,
    bars: combined,
    source
  };
}

export interface RangeBarPreviewItem {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface RangeBarsPreviewPayload {
  symbol: string;
  shortName: string;
  interval: StrategyTimeframe;
  barSec: number;
  source: 'oanda' | 'yahoo';
  bars: RangeBarPreviewItem[];
  updatedAt: string;
}

export async function getRangeBarsPreviewPayload(
  rawSymbol: string,
  rawInterval?: string | null,
  rawCount?: number | null
): Promise<RangeBarsPreviewPayload> {
  const count =
    typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.max(80, Math.min(2000, Math.round(rawCount)))
      : 1200;
  const loaded = await loadRangeBarsWithLiveTail(rawSymbol, rawInterval, count);
  return {
    symbol: loaded.symbol,
    shortName: loaded.shortName,
    interval: loaded.interval,
    barSec: loaded.barSec,
    source: loaded.source,
    bars: loaded.bars.map((b) => ({
      ts: b.ts,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close
    })),
    updatedAt: new Date().toISOString()
  };
}

export interface CalibratedAxisAnchor {
  xRatio: number; // 0..1 across the cropped time axis strip
  ts: number; // Unix seconds UTC
  label: string;
}

export interface CalibrateAxisResponse {
  ok: boolean;
  anchors: CalibratedAxisAnchor[];
  error?: string;
}

/**
 * Fast non-thinking vision readout of TradingView's bottom time-axis strip (~400-800ms)
 * to lock pixel X ratios onto exact calendar timestamps even when the user panned/zoomed.
 */
export async function calibrateChartTimeAxis(params: {
  image: string;
  symbol?: string;
  interval?: string;
  timezone?: string;
  referenceIso?: string;
}): Promise<CalibrateAxisResponse> {
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!apiKey) {
    return { ok: false, anchors: [], error: 'DEEPSEEK_API_KEY not configured' };
  }
  if (
    typeof params.image !== 'string' ||
    !/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(params.image)
  ) {
    return { ok: false, anchors: [], error: 'Invalid axis strip image' };
  }

  const tz = resolveTimeZone(params.timezone);
  const nowRef = params.referenceIso && !Number.isNaN(Date.parse(params.referenceIso))
    ? params.referenceIso
    : new Date().toISOString();
  const refDate = new Date(nowRef);
  const localNow = formatPartsInTz(refDate, tz);
  // Compute exact ISO timezone offset (e.g. "+03:00", "-05:00", "Z") so axis ticks always resolve cleanly
  let tzOffsetStr = '+00:00';
  try {
    const offFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset'
    }).formatToParts(refDate);
    const rawOff = offFmt.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = rawOff.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (m) {
      tzOffsetStr = `${m[1]}${m[2].padStart(2, '0')}:${(m[3] ?? '00').padStart(2, '0')}`;
    }
  } catch {
    tzOffsetStr = '+00:00';
  }

  const prompt = [
    `Read the horizontal time-axis tick labels visible in this cropped TradingView chart bottom axis strip.`,
    `Context: symbol=${params.symbol || 'unknown'}, timeframe=${params.interval || 'unknown'}, chart timezone=${tz} (UTC offset ${tzOffsetStr}), current local date=${localNow.date} ${localNow.time}.`,
    `Note: On TradingView axes, a bold day number like "18", "24", "26", "27", "28" means 00:00 on that day of the month in timezone ${tzOffsetStr}. Time labels like "09:00", "12:00", "15:00" belong to the most recent day number to their left. Monthly labels like "Nov" or "Dec" mean the 1st of that month 00:00.`,
    `Return ONLY strict JSON (no markdown, no explanation) with 3 to 7 clearly legible tick labels across the axis from left to right:`,
    `{"ticks":[{"label":"24","iso":"2026-11-24T00:00:00${tzOffsetStr}","xPercent":42.5}]}`,
    `Rules: xPercent is the horizontal center of each tick label as a percentage (0 to 100) from the left edge to the right edge of the provided image. Use offset "${tzOffsetStr}" in every iso string. Ignore any non-date icons (like a gear icon or TV logo).`
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9_000);

  try {
    const res = await fetch(getDeepSeekChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 320,
        messages: [
          {
            role: 'system',
            content: 'You are a precise chart time-axis OCR extractor. Output strict JSON only.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: params.image } }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      return { ok: false, anchors: [], error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const rawText = (data.choices?.[0]?.message?.content ?? '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { ok: false, anchors: [], error: 'Unparseable JSON response' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      ticks?: Array<{ label?: string; iso?: string; xPercent?: number }>;
    };
    const rawTicks = Array.isArray(parsed.ticks) ? parsed.ticks : [];

    const anchors: CalibratedAxisAnchor[] = [];
    for (const t of rawTicks) {
      const xp = typeof t.xPercent === 'number' ? t.xPercent : Number(t.xPercent);
      const ms = typeof t.iso === 'string' ? Date.parse(t.iso) : NaN;
      if (!Number.isFinite(xp) || xp < 1 || xp > 99 || !Number.isFinite(ms)) continue;
      anchors.push({
        xRatio: Number((xp / 100).toFixed(4)),
        ts: Math.floor(ms / 1000),
        label: String(t.label ?? '').trim()
      });
    }

    anchors.sort((a, b) => a.xRatio - b.xRatio);
    // Keep strictly monotonic timestamps
    const clean: CalibratedAxisAnchor[] = [];
    for (const a of anchors) {
      const prev = clean[clean.length - 1];
      if (!prev || (a.xRatio > prev.xRatio + 0.03 && a.ts > prev.ts)) {
        clean.push(a);
      }
    }

    return { ok: clean.length >= 2, anchors: clean };
  } catch (err) {
    return { ok: false, anchors: [], error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

interface TechnicalSnapshot {
  close: number;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  stochK: number | null;
  stochD: number | null;
  adx14: number | null;
  plusDi: number | null;
  minusDi: number | null;
  cci20: number | null;
  willR: number | null;
  bbp: number | null;
  atr14: number | null;
  ema10: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  vwma20: number | null;
  ichimokuBase: number | null;
  overallScore: number | null;
}

function lastFinite(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const v = arr[arr.length - 1];
  return Number.isFinite(v) ? v : null;
}

function computeTechnicalSnapshot(bars: OandaBar[]): TechnicalSnapshot | null {
  if (bars.length < 16) return null;
  const closes = bars.map((b) => b.close);
  const close = closes[closes.length - 1];
  const macd = computeMacd(closes);
  const stoch = computeStoch(bars, 14, 3);
  const adx = computeWilderAdx(bars, 14);
  const cci = computeCci(bars, 20);
  const score = scoreTimeframeTechnicals(bars);

  return {
    close,
    rsi14: computeWilderRsi(closes, 14),
    macd: macd ? macd.macd : null,
    macdSignal: macd ? macd.signal : null,
    macdHist: macd ? macd.hist : null,
    stochK: stoch ? roundNum(stoch.k, 2) : null,
    stochD: stoch ? roundNum(stoch.d, 2) : null,
    adx14: adx ? adx.adx : null,
    plusDi: adx ? adx.plusDi : null,
    minusDi: adx ? adx.minusDi : null,
    cci20: cci ? roundNum(cci.value, 2) : null,
    willR: computeWilliamsR(bars, 14) !== null ? roundNum(computeWilliamsR(bars, 14)!, 2) : null,
    bbp: computeBullBearPower(bars, 13),
    atr14: computeWilderAtr(bars, 14),
    ema10: lastFinite(computeEmaSeries(closes, 10)),
    ema20: lastFinite(computeEmaSeries(closes, 20)),
    ema50: lastFinite(computeEmaSeries(closes, 50)),
    ema100: lastFinite(computeEmaSeries(closes, 100)),
    ema200: lastFinite(computeEmaSeries(closes, 200)),
    sma20: computeSma(closes, 20),
    sma50: computeSma(closes, 50),
    sma200: computeSma(closes, 200),
    vwma20: computeVwma(bars, 20),
    ichimokuBase: computeIchimokuBaseLine(bars, 26),
    overallScore: score ? score.allScore : null
  };
}

function priceDigits(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 20) return 3;
  return 5;
}

function fmtPx(v: number | null | undefined, digits: number): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

function fmtTs(ts: number, tz: string): string {
  const p = formatPartsInTz(new Date(ts * 1000), tz);
  return `${p.date} ${p.time}`;
}

function detectRangeTechnicalShifts(
  startSnap: TechnicalSnapshot | null,
  endSnap: TechnicalSnapshot | null,
  digits: number
): string[] {
  if (!startSnap || !endSnap) return [];
  const shifts: string[] = [];

  if (startSnap.rsi14 !== null && endSnap.rsi14 !== null) {
    const d = endSnap.rsi14 - startSnap.rsi14;
    if (startSnap.rsi14 < 70 && endSnap.rsi14 >= 70) {
      shifts.push(`RSI(14) entered Overbought (${startSnap.rsi14.toFixed(1)} -> ${endSnap.rsi14.toFixed(1)})`);
    } else if (startSnap.rsi14 > 30 && endSnap.rsi14 <= 30) {
      shifts.push(`RSI(14) entered Oversold (${startSnap.rsi14.toFixed(1)} -> ${endSnap.rsi14.toFixed(1)})`);
    } else if (Math.abs(d) >= 12) {
      shifts.push(`RSI(14) momentum shift: ${startSnap.rsi14.toFixed(1)} -> ${endSnap.rsi14.toFixed(1)} (${d > 0 ? '+' : ''}${d.toFixed(1)})`);
    }
  }

  const checkCross = (label: string, sMa: number | null, eMa: number | null) => {
    if (sMa === null || eMa === null) return;
    if (startSnap.close <= sMa && endSnap.close > eMa) {
      shifts.push(`Price reclaimed above ${label} (${fmtPx(eMa, digits)})`);
    } else if (startSnap.close >= sMa && endSnap.close < eMa) {
      shifts.push(`Price broke below ${label} (${fmtPx(eMa, digits)})`);
    }
  };
  checkCross('EMA 20', startSnap.ema20, endSnap.ema20);
  checkCross('EMA 50', startSnap.ema50, endSnap.ema50);
  checkCross('EMA 200', startSnap.ema200, endSnap.ema200);

  if (
    startSnap.ema20 !== null &&
    startSnap.ema50 !== null &&
    endSnap.ema20 !== null &&
    endSnap.ema50 !== null
  ) {
    if (startSnap.ema20 <= startSnap.ema50 && endSnap.ema20 > endSnap.ema50) {
      shifts.push(`Bullish EMA 20 / EMA 50 crossover inside range`);
    } else if (startSnap.ema20 >= startSnap.ema50 && endSnap.ema20 < endSnap.ema50) {
      shifts.push(`Bearish EMA 20 / EMA 50 crossover inside range`);
    }
  }

  if (
    startSnap.macd !== null &&
    startSnap.macdSignal !== null &&
    endSnap.macd !== null &&
    endSnap.macdSignal !== null
  ) {
    if (startSnap.macd <= startSnap.macdSignal && endSnap.macd > endSnap.macdSignal) {
      shifts.push(`Bullish MACD signal crossover inside range`);
    } else if (startSnap.macd >= startSnap.macdSignal && endSnap.macd < endSnap.macdSignal) {
      shifts.push(`Bearish MACD signal crossover inside range`);
    }
  }

  if (startSnap.adx14 !== null && endSnap.adx14 !== null) {
    if (startSnap.adx14 < 20 && endSnap.adx14 >= 25) {
      shifts.push(`Trend ignition: ADX(14) expanded from ${startSnap.adx14.toFixed(1)} to ${endSnap.adx14.toFixed(1)}`);
    } else if (startSnap.adx14 >= 25 && endSnap.adx14 < 20) {
      shifts.push(`Trend exhaustion: ADX(14) faded from ${startSnap.adx14.toFixed(1)} to ${endSnap.adx14.toFixed(1)}`);
    }
  }

  if (startSnap.atr14 !== null && endSnap.atr14 !== null && startSnap.atr14 > 0) {
    const ratio = endSnap.atr14 / startSnap.atr14;
    if (ratio >= 1.25) {
      shifts.push(`Volatility expansion: ATR(14) rose +${((ratio - 1) * 100).toFixed(0)}% (${fmtPx(startSnap.atr14, digits)} -> ${fmtPx(endSnap.atr14, digits)})`);
    } else if (ratio <= 0.8) {
      shifts.push(`Volatility compression: ATR(14) contracted ${((ratio - 1) * 100).toFixed(0)}%`);
    }
  }

  return shifts;
}

function buildRangeModeGuidance(mode: AiRangeMode): string {
  const tableHint = `- Keep any Markdown tables compact (max 3–4 short columns) so they read cleanly inside a narrow side panel without wrapping words mid-word.`;
  switch (mode) {
    case 'explain':
      return [
        `TASK FOCUS (EXPLAIN THIS PRICE MOVE):`,
        `- Deliver a crisp, chronological explanation of HOW and WHY price moved across this exact range.`,
        `- Break down the impulse legs, consolidations/pullbacks, liquidity sweeps/wick rejections, volatility expansion, and any aligned calendar releases or news catalysts from the telemetry.`,
        `- Lead with a 1-line summary headline (direction, net % / points, and primary driver), followed by **Price Action Breakdown**, **Key Inflection Candles & Levels**, and **Catalyst / Context Link**.`,
        tableHint
      ].join('\n');
    case 'events':
      return [
        `TASK FOCUS (FIND EVENTS BEHIND THIS MOVE):`,
        `- Build a precise **Catalyst & Event Timeline** correlating the exact timestamps of the range's biggest displacement candles against the economic calendar releases (Actual vs Forecast vs Prior) and dated news stories provided in telemetry.`,
        `- Clearly state which events coincided with the exact move window and explain the transmission mechanism (e.g., USD yields/DXY reaction -> Gold).`,
        `- If NO scheduled macro release or verified news headline occurred during the exact window, state that transparently rather than fabricating a catalyst — and note whether the move looks session-open flow, stop-run/liquidity sweep, or technical breakout driven.`,
        `- Cite every news headline used as a Markdown link \`[Title](url)\`.`,
        tableHint
      ].join('\n');
    case 'technicals':
      return [
        `TASK FOCUS (ANALYZE TECHNICALS IN THIS AREA):`,
        `- Perform an institutional technical audit strictly anchored to this selected zone using the exact Start vs. End indicator telemetry and OHLC structure.`,
        `- Include a compact **Technical Shift Table (Range Start → Range End)** covering RSI(14), MACD, ADX(14), ATR(14), and key EMAs (20/50/200).`,
        `- Identify market structure (BOS / CHoCH / range accumulation / distribution), dynamic S/R interaction, momentum divergences or exhaustion, key support/resistance/invalidation levels inside the area, and the resulting technical bias exiting the range.`,
        tableHint
      ].join('\n');
    case 'custom':
    default:
      return [
        `TASK FOCUS (CUSTOM RANGE QUESTION):`,
        `- Answer the trader's specific question directly using the exact OANDA range candles, computed start-vs-end technicals, and windowed calendar/news telemetry provided below.`,
        tableHint
      ].join('\n');
  }
}

export interface RangeAnalysisPacket {
  dossier: string;
  sources: AiSourceLink[];
  usedWebSearch: boolean;
  rangeSummaryMeta: {
    barCount: number;
    netChangePct: number | null;
    dataSource: 'oanda' | 'yahoo';
  };
}

export async function buildRangeAnalysisPacket(
  ctx: AiChartContext,
  latestUserText: string,
  webMode: 'auto' | 'on' | 'off',
  onStatus?: (phase: string, label: string) => void
): Promise<RangeAnalysisPacket> {
  const range = ctx.range!;
  const symbol = ctx.fullSymbol || ctx.symbol || 'OANDA:XAUUSD';
  const short = shortTicker(ctx.symbol || symbol);
  const tz = resolveTimeZone(ctx.timezone);
  const rawIv = range.interval || ctx.interval || '15m';
  const mode: AiRangeMode = range.mode ?? 'custom';

  const startTs = Math.min(range.startTs, range.endTs);
  const endTs = Math.max(range.startTs, range.endTs);

  onStatus?.('data', `Loading ${short} OANDA candles & technicals in range...`);

  const countriesSet = new Set<CountryCode>(inferRelevantCountries(short));
  countriesSet.add('US'); // US macro releases move global liquidity across FX, metals, indices, crypto
  const countries = Array.from(countriesSet);

  const shouldSearchWeb =
    isTavilyConfigured() &&
    webMode !== 'off' &&
    (mode === 'events' ||
      mode === 'explain' ||
      webMode === 'on' ||
      shouldAutoRunWebSearch(latestUserText));

  const startIsoDate = formatPartsInTz(new Date(startTs * 1000), 'UTC').date;
  const endIsoDate = formatPartsInTz(new Date(endTs * 1000), 'UTC').date;
  const searchStartDate = addDays(startIsoDate, -1);
  const searchEndDate = addDays(endIsoDate, 1);

  const nowSec = Math.floor(Date.now() / 1000);
  const isNearLive = nowSec - endTs <= 24 * 3600;

  // Fetch candles, calendar events, news cache, and optional OANDA position book in parallel
  const [loadedBars, calWindow, newsFlow, posBook] = await Promise.all([
    loadRangeBarsWithLiveTail(symbol, rawIv, 2000),
    getCalendarEventsInWindow(startTs, endTs, tz, {
      padBeforeSec: 4 * 3600,
      padAfterSec: 2 * 3600,
      countries
    }),
    getNewsFlowPayload({ mode: 'symbol', symbol }),
    isNearLive && isOandaConfigured() && hasOandaPositionBook(short)
      ? fetchOandaPositionBook(short, false)
      : Promise.resolve(null)
  ]);

  const allBars = loadedBars.bars;
  const barSec = loadedBars.barSec;

  // Slice range bars inclusively (also match a bar whose open..close overlaps [startTs, endTs])
  let rangeBars = allBars.filter((b) => b.ts + barSec > startTs && b.ts <= endTs);
  let fallbackWindowNote = '';
  if (rangeBars.length === 0 && allBars.length > 0) {
    // User highlighted weekend gap or slightly beyond oldest cached bar — snap nearest bars
    let nearestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < allBars.length; i++) {
      const dist = Math.min(Math.abs(allBars[i].ts - startTs), Math.abs(allBars[i].ts - endTs));
      if (dist < bestDist) {
        bestDist = dist;
        nearestIdx = i;
      }
    }
    const lo = Math.max(0, nearestIdx - 3);
    const hi = Math.min(allBars.length - 1, nearestIdx + 3);
    rangeBars = allBars.slice(lo, hi + 1);
    fallbackWindowNote = `Note: Selected timestamps fell between closed-market sessions or outside available bar bounds; snapped to nearest ${rangeBars.length} bars (${fmtTs(rangeBars[0].ts, tz)} -> ${fmtTs(rangeBars[rangeBars.length - 1].ts, tz)}).`;
  }

  let netChangePct: number | null = null;
  let moveDirectionWord = 'price move';
  const lines: string[] = [];

  lines.push(`SELECTED CHART RANGE TELEMETRY (${loadedBars.source.toUpperCase()} DATA):`);
  lines.push(
    `- Instrument: ${short} (${symbol}) · Timeframe: ${loadedBars.interval} · Timezone: ${tz}`
  );
  lines.push(
    `- Selected Window: ${range.startLabel || fmtTs(startTs, tz)} -> ${range.endLabel || fmtTs(endTs, tz)} (UTC: ${new Date(startTs * 1000).toISOString()} -> ${new Date(endTs * 1000).toISOString()})`
  );
  if (range.calibrated === false) {
    lines.push(
      `- Calibration note: Timestamps were estimated from default chart bar scaling; cross-check against the attached range screenshot if any visual offset exists.`
    );
  }
  if (fallbackWindowNote) {
    lines.push(`- ${fallbackWindowNote}`);
  }

  if (rangeBars.length > 0) {
    const first = rangeBars[0];
    const last = rangeBars[rangeBars.length - 1];
    const digits = priceDigits(last.close);

    let highBar = first;
    let lowBar = first;
    let bullCount = 0;
    let bearCount = 0;
    let sumVol = 0;
    let maxVolBar = first;
    let sumSpread = 0;
    let maxSpread = 0;

    for (const b of rangeBars) {
      if (b.high > highBar.high) highBar = b;
      if (b.low < lowBar.low) lowBar = b;
      if (b.close >= b.open) bullCount += 1;
      else bearCount += 1;
      sumVol += b.volume;
      if (b.volume > maxVolBar.volume) maxVolBar = b;
      sumSpread += b.spread;
      if (b.spread > maxSpread) maxSpread = b.spread;
    }

    const netDelta = last.close - first.open;
    netChangePct = first.open > 0 ? (netDelta / first.open) * 100 : null;
    const totalSpan = highBar.high - lowBar.low;
    const totalSpanPct = lowBar.low > 0 ? (totalSpan / lowBar.low) * 100 : 0;

    if (netChangePct !== null) {
      moveDirectionWord =
        netChangePct >= 0.35
          ? 'rally surge higher'
          : netChangePct <= -0.35
            ? 'selloff drop lower'
            : 'consolidation range price action';
    }

    // Build warm-up slices up to startTs and up to endTs
    const firstIdxInAll = allBars.findIndex((b) => b.ts === first.ts);
    const lastIdxInAll = allBars.findIndex((b) => b.ts === last.ts);
    const barsUpToStart =
      firstIdxInAll >= 0 ? allBars.slice(Math.max(0, firstIdxInAll - 220), firstIdxInAll + 1) : [];
    const barsUpToEnd =
      lastIdxInAll >= 0 ? allBars.slice(Math.max(0, lastIdxInAll - 220), lastIdxInAll + 1) : [];

    const startTech = computeTechnicalSnapshot(barsUpToStart);
    const endTech = computeTechnicalSnapshot(barsUpToEnd);
    const atrMult =
      endTech?.atr14 && endTech.atr14 > 0 ? ` (${(totalSpan / endTech.atr14).toFixed(2)}x ATR-14)` : '';

    lines.push(
      `- Bars in Range: ${rangeBars.length} (${bullCount} bullish, ${bearCount} bearish) | Start Open: ${fmtPx(first.open, digits)} -> End Close: ${fmtPx(last.close, digits)}`
    );
    lines.push(
      `- Net Move: ${netDelta >= 0 ? '+' : ''}${fmtPx(netDelta, digits)} (${netChangePct !== null ? `${netChangePct >= 0 ? '+' : ''}${netChangePct.toFixed(2)}%` : 'n/a'})`
    );
    lines.push(
      `- Range High: ${fmtPx(highBar.high, digits)} at ${fmtTs(highBar.ts, tz)} | Range Low: ${fmtPx(lowBar.low, digits)} at ${fmtTs(lowBar.ts, tz)}`
    );
    lines.push(
      `- High-to-Low Excursion: ${fmtPx(totalSpan, digits)} (${totalSpanPct.toFixed(2)}%)${atrMult}`
    );
    if (sumVol > 0) {
      const avgVol = Math.round(sumVol / rangeBars.length);
      lines.push(
        `- Tick Volume: avg ${avgVol}/bar, peak ${maxVolBar.volume} at ${fmtTs(maxVolBar.ts, tz)} (${maxVolBar.close >= maxVolBar.open ? 'bull' : 'bear'} bar ${fmtPx(maxVolBar.open, digits)} -> ${fmtPx(maxVolBar.close, digits)})`
      );
    }
    if (maxSpread > 0) {
      lines.push(
        `- Spread: avg ${fmtPx(sumSpread / rangeBars.length, digits)}, max ${fmtPx(maxSpread, digits)}`
      );
    }

    // Top 5 biggest displacement/impulse candles inside the range
    const rankedImpulse = [...rangeBars]
      .sort((a, b) => Math.abs(b.close - b.open) + (b.high - b.low) * 0.5 - (Math.abs(a.close - a.open) + (a.high - a.low) * 0.5))
      .slice(0, 5)
      .sort((a, b) => a.ts - b.ts);

    lines.push(`\nKEY DISPLACEMENT / INFLECTION CANDLES IN RANGE:`);
    for (const b of rankedImpulse) {
      const chg = b.close - b.open;
      const rng = b.high - b.low;
      const upperWick = b.high - Math.max(b.open, b.close);
      const lowerWick = Math.min(b.open, b.close) - b.low;
      const tag =
        upperWick > rng * 0.45
          ? ' [upper-wick rejection]'
          : lowerWick > rng * 0.45
            ? ' [lower-wick rejection]'
            : '';
      lines.push(
        `- ${fmtTs(b.ts, tz)}: O ${fmtPx(b.open, digits)} H ${fmtPx(b.high, digits)} L ${fmtPx(b.low, digits)} C ${fmtPx(b.close, digits)} (body ${chg >= 0 ? '+' : ''}${fmtPx(chg, digits)}, range ${fmtPx(rng, digits)}, vol ${b.volume})${tag}`
      );
    }

    // Chronological OHLCV tape (all candles if <= 36; otherwise key sampled points + turning points)
    lines.push(`\nCHRONOLOGICAL CANDLE TAPE (${tz}):`);
    lines.push(`Time | Open | High | Low | Close | Vol`);
    let tapeBars: OandaBar[];
    if (rangeBars.length <= 36) {
      tapeBars = rangeBars;
    } else {
      const pickedIdx = new Set<number>([0, rangeBars.length - 1]);
      const step = (rangeBars.length - 1) / 24;
      for (let k = 0; k <= 24; k++) pickedIdx.add(Math.round(k * step));
      const hiIdx = rangeBars.indexOf(highBar);
      const loIdx = rangeBars.indexOf(lowBar);
      if (hiIdx >= 0) pickedIdx.add(hiIdx);
      if (loIdx >= 0) pickedIdx.add(loIdx);
      for (const imp of rankedImpulse) {
        const idx = rangeBars.indexOf(imp);
        if (idx >= 0) pickedIdx.add(idx);
      }
      tapeBars = Array.from(pickedIdx)
        .sort((a, b) => a - b)
        .map((i) => rangeBars[i]);
    }
    for (const b of tapeBars) {
      lines.push(
        `${fmtTs(b.ts, tz)} | ${fmtPx(b.open, digits)} | ${fmtPx(b.high, digits)} | ${fmtPx(b.low, digits)} | ${fmtPx(b.close, digits)} | ${b.volume}`
      );
    }

    // Technicals at Range Start vs Range End
    if (startTech || endTech) {
      lines.push(`\nCOMPUTED TECHNICALS (RANGE START vs RANGE END — ${loadedBars.interval}):`);
      lines.push(`Indicator | At Range Start | At Range End`);
      const row = (name: string, a: string, b: string) => lines.push(`${name} | ${a} | ${b}`);
      row('Close', fmtPx(startTech?.close, digits), fmtPx(endTech?.close, digits));
      row('RSI (14)', startTech?.rsi14?.toFixed(2) ?? 'n/a', endTech?.rsi14?.toFixed(2) ?? 'n/a');
      row(
        'MACD / Signal / Hist',
        startTech?.macd != null
          ? `${fmtPx(startTech.macd, digits)} / ${fmtPx(startTech.macdSignal, digits)} / ${fmtPx(startTech.macdHist, digits)}`
          : 'n/a',
        endTech?.macd != null
          ? `${fmtPx(endTech.macd, digits)} / ${fmtPx(endTech.macdSignal, digits)} / ${fmtPx(endTech.macdHist, digits)}`
          : 'n/a'
      );
      row(
        'Stoch %K / %D (14,3)',
        startTech?.stochK != null ? `${startTech.stochK} / ${startTech.stochD}` : 'n/a',
        endTech?.stochK != null ? `${endTech.stochK} / ${endTech.stochD}` : 'n/a'
      );
      row(
        'ADX (14) [+DI / -DI]',
        startTech?.adx14 != null ? `${startTech.adx14} [${startTech.plusDi} / ${startTech.minusDi}]` : 'n/a',
        endTech?.adx14 != null ? `${endTech.adx14} [${endTech.plusDi} / ${endTech.minusDi}]` : 'n/a'
      );
      row('CCI (20)', startTech?.cci20?.toFixed(1) ?? 'n/a', endTech?.cci20?.toFixed(1) ?? 'n/a');
      row('Williams %R (14)', startTech?.willR?.toFixed(1) ?? 'n/a', endTech?.willR?.toFixed(1) ?? 'n/a');
      row('ATR (14)', fmtPx(startTech?.atr14, digits), fmtPx(endTech?.atr14, digits));
      row('EMA 10 / 20', `${fmtPx(startTech?.ema10, digits)} / ${fmtPx(startTech?.ema20, digits)}`, `${fmtPx(endTech?.ema10, digits)} / ${fmtPx(endTech?.ema20, digits)}`);
      row('EMA 50 / 100 / 200', `${fmtPx(startTech?.ema50, digits)} / ${fmtPx(startTech?.ema100, digits)} / ${fmtPx(startTech?.ema200, digits)}`, `${fmtPx(endTech?.ema50, digits)} / ${fmtPx(endTech?.ema100, digits)} / ${fmtPx(endTech?.ema200, digits)}`);
      row('VWMA (20)', fmtPx(startTech?.vwma20, digits), fmtPx(endTech?.vwma20, digits));
      row('Ichimoku Base (26)', fmtPx(startTech?.ichimokuBase, digits), fmtPx(endTech?.ichimokuBase, digits));
      row(
        'Composite TA Score (-1..+1)',
        startTech?.overallScore != null ? startTech.overallScore.toFixed(2) : 'n/a',
        endTech?.overallScore != null ? endTech.overallScore.toFixed(2) : 'n/a'
      );

      const shifts = detectRangeTechnicalShifts(startTech, endTech, digits);
      if (shifts.length > 0) {
        lines.push(`\nDETECTED TECHNICAL EVENTS INSIDE RANGE:`);
        for (const s of shifts) lines.push(`- ${s}`);
      }
    }

    if (posBook) {
      lines.push(
        `\nOANDA LIVE POSITION BOOK (CURRENT CROWD SKEW): ${posBook.longPct}% Long / ${posBook.shortPct}% Short (${posBook.skew}, trapped longs ${posBook.trappedLongPct}%, trapped shorts ${posBook.trappedShortPct}%).`
      );
    }
  } else {
    lines.push(`- No historical candles were returned for ${symbol} (${loadedBars.interval}).`);
  }

  // Economic calendar events in window
  lines.push(`\nECONOMIC CALENDAR EVENTS IN RANGE WINDOW (${tz}, padded -4h to +2h):`);
  if (calWindow.events.length === 0) {
    lines.push(
      `- No scheduled economic releases found in calendar database for ${countries.join(', ')} during this exact window.`
    );
  } else {
    const formatCalLine = (ev: EconomicEvent) => {
      const timing =
        ev.ts < startTs
          ? 'pre-range'
          : ev.ts > endTs
            ? 'post-range'
            : 'IN-RANGE';
      const stats: string[] = [];
      if (ev.actual) stats.push(`Actual: ${ev.actual}`);
      if (ev.forecast) stats.push(`Forecast: ${ev.forecast}`);
      if (ev.prior) stats.push(`Prior: ${ev.prior}`);
      const meta = stats.length > 0 ? ` (${stats.join(', ')})` : '';
      return `- [${timing}] ${ev.date} ${ev.time} ${tz} [${ev.country} · ${ev.impact.toUpperCase()}] ${ev.title}${meta}`;
    };
    for (const ev of calWindow.events.slice(0, 20)) {
      lines.push(formatCalLine(ev));
    }
  }

  // News Flow items matching the range window
  const sources: AiSourceLink[] = [];
  const seenUrls = new Set<string>();
  const addSource = (s: AiSourceLink) => {
    if (!s.url || seenUrls.has(s.url)) return;
    seenUrls.add(s.url);
    sources.push(s);
  };

  const windowNewsItems: NewsFlowItem[] = [];
  const newsPadBeforeMs = 18 * 3600 * 1000;
  const newsPadAfterMs = 12 * 3600 * 1000;
  for (const item of newsFlow.items) {
    const pubMs = Date.parse(item.publishedAt);
    if (!Number.isFinite(pubMs)) continue;
    if (pubMs >= startTs * 1000 - newsPadBeforeMs && pubMs <= endTs * 1000 + newsPadAfterMs) {
      windowNewsItems.push(item);
    }
  }

  if (windowNewsItems.length > 0) {
    lines.push(`\nNEWS FLOW HEADLINES NEAR THIS WINDOW:`);
    for (const item of windowNewsItems.slice(0, 8)) {
      const pubStr = fmtTs(Math.floor(Date.parse(item.publishedAt) / 1000), tz);
      lines.push(`- [${pubStr} · ${item.providerName}] ${item.title}\n  URL: ${item.url}\n  Summary: ${item.snippet.slice(0, 260)}`);
      addSource({ title: item.title, url: item.url, publishedDate: item.publishedAt });
    }
  }

  // Date-bounded Tavily search when requested / for Events & Explain modes
  let usedWebSearch = false;
  if (shouldSearchWeb) {
    onStatus?.('searching', `Searching news & catalysts for ${short} (${startIsoDate}..${endIsoDate})...`);
    const datePhrase =
      startIsoDate === endIsoDate ? startIsoDate : `${startIsoDate} to ${endIsoDate}`;
    const userHint =
      mode === 'custom' ? latestUserText.slice(0, 90) : `${moveDirectionWord} catalyst macro news`;
    const query = `${short} market price ${userHint} ${datePhrase}`;

    const tavily = await runTavilyFinanceSearch(query, {
      topic: 'news',
      maxResults: 6,
      startDate: searchStartDate,
      endDate: searchEndDate
    });

    if (tavily && tavily.snippets) {
      usedWebSearch = true;
      lines.push(`\nDATE-BOUNDED WEB SEARCH RESULTS (${searchStartDate} to ${searchEndDate}):`);
      lines.push(tavily.snippets);
      for (const s of tavily.sources) addSource(s);
    }
  }

  lines.push(`\n${buildRangeModeGuidance(mode)}`);

  return {
    dossier: lines.join('\n'),
    sources: sources.slice(0, 10),
    usedWebSearch,
    rangeSummaryMeta: {
      barCount: rangeBars.length,
      netChangePct: netChangePct !== null ? Number(netChangePct.toFixed(2)) : null,
      dataSource: loadedBars.source
    }
  };
}
