const FETCH_TIMEOUT_MS = 12_000;
const SEASONALS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — historical daily series changes once per day

export interface SeasonalDayPoint {
  doy: number; // 0..365 normalized to leap-year calendar (Jan 1 = 0, Dec 31 = 365)
  pct: number; // Cumulative % return from year's first trading day close
  abs: number; // Cumulative price change from year's first trading day close
  idx: number; // Base-100 indexed level
  close: number;
}

export interface SeasonalYearSeries {
  year: number;
  startPrice: number;
  endPrice: number;
  totalPct: number;
  totalAbs: number;
  points: SeasonalDayPoint[];
  months: (number | null)[]; // 12 monthly % returns (Jan=0 .. Dec=11)
}

export interface DayOfWeekStat {
  day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri';
  avgReturnPct: number;
  winRatePct: number;
  avgRangePct: number;
  samples: number;
}

export interface SwingLevel {
  label: string;
  price: number;
  distancePct: number;
  kind: 'resistance' | 'support' | 'reference';
}

export interface VolatilityProfile {
  lastPrice: number;
  atr14: number | null;
  atr14Pct: number | null;
  adr20: number | null;
  adr20Pct: number | null;
  todayRange: number | null;
  todayRangePctOfAdr: number | null;
  week52High: number | null;
  week52Low: number | null;
  week52PositionPct: number | null;
  dayOfWeek1Y: DayOfWeekStat[];
  dayOfWeek5Y: DayOfWeekStat[];
  swingLevels: SwingLevel[];
}

export interface SymbolSeasonalsPayload {
  symbol: string;
  shortName: string;
  description: string;
  currency: string;
  minYear: number;
  maxYear: number;
  currentYear: number;
  years: SeasonalYearSeries[];
  volatility: VolatilityProfile | null;
  updatedAt: string;
}

const YAHOO_MAP: Record<string, { yahoo: string; desc: string; currency: string }> = {
  XAUUSD: { yahoo: 'GC=F', desc: 'Gold Spot / U.S. Dollar', currency: 'USD' },
  GOLD: { yahoo: 'GC=F', desc: 'Gold Spot / U.S. Dollar', currency: 'USD' },
  XAGUSD: { yahoo: 'SI=F', desc: 'Silver Spot / U.S. Dollar', currency: 'USD' },
  SILVER: { yahoo: 'SI=F', desc: 'Silver Spot / U.S. Dollar', currency: 'USD' },
  USOIL: { yahoo: 'CL=F', desc: 'WTI Crude Oil', currency: 'USD' },
  WTI: { yahoo: 'CL=F', desc: 'WTI Crude Oil', currency: 'USD' },
  WTICOUSD: { yahoo: 'CL=F', desc: 'WTI Crude Oil', currency: 'USD' },
  OILUSD: { yahoo: 'CL=F', desc: 'WTI Crude Oil', currency: 'USD' },
  UKOIL: { yahoo: 'BZ=F', desc: 'Brent Crude Oil', currency: 'USD' },
  BRENT: { yahoo: 'BZ=F', desc: 'Brent Crude Oil', currency: 'USD' },
  DXY: { yahoo: 'DX-Y.NYB', desc: 'U.S. Dollar Currency Index', currency: 'USD' },
  VIX: { yahoo: '^VIX', desc: 'CBOE Volatility Index', currency: 'USD' },
  US10Y: { yahoo: '^TNX', desc: 'US 10-Year Treasury Yield', currency: '%' },
  SPX: { yahoo: '^GSPC', desc: 'S&P 500 Index', currency: 'USD' },
  US500: { yahoo: '^GSPC', desc: 'S&P 500 Index', currency: 'USD' },
  NAS100: { yahoo: '^NDX', desc: 'NASDAQ 100 Index', currency: 'USD' },
  NDX: { yahoo: '^NDX', desc: 'NASDAQ 100 Index', currency: 'USD' },
  US30: { yahoo: '^DJI', desc: 'Dow Jones Industrial Average', currency: 'USD' },
  DJI: { yahoo: '^DJI', desc: 'Dow Jones Industrial Average', currency: 'USD' },
  EURUSD: { yahoo: 'EURUSD=X', desc: 'Euro / U.S. Dollar', currency: 'USD' },
  GBPUSD: { yahoo: 'GBPUSD=X', desc: 'British Pound / U.S. Dollar', currency: 'USD' },
  USDJPY: { yahoo: 'JPY=X', desc: 'U.S. Dollar / Japanese Yen', currency: 'JPY' },
  AUDUSD: { yahoo: 'AUDUSD=X', desc: 'Australian Dollar / U.S. Dollar', currency: 'USD' },
  USDCAD: { yahoo: 'CAD=X', desc: 'U.S. Dollar / Canadian Dollar', currency: 'CAD' },
  USDCHF: { yahoo: 'CHF=X', desc: 'U.S. Dollar / Swiss Franc', currency: 'CHF' },
  NZDUSD: { yahoo: 'NZDUSD=X', desc: 'New Zealand Dollar / U.S. Dollar', currency: 'USD' },
  GBPJPY: { yahoo: 'GBPJPY=X', desc: 'British Pound / Japanese Yen', currency: 'JPY' },
  EURJPY: { yahoo: 'EURJPY=X', desc: 'Euro / Japanese Yen', currency: 'JPY' },
  EURGBP: { yahoo: 'EURGBP=X', desc: 'Euro / British Pound', currency: 'GBP' },
  BTCUSD: { yahoo: 'BTC-USD', desc: 'Bitcoin / U.S. Dollar', currency: 'USD' },
  ETHUSD: { yahoo: 'ETH-USD', desc: 'Ethereum / U.S. Dollar', currency: 'USD' }
};

interface DailyBar {
  ts: number; // epoch ms
  year: number;
  month: number; // 0..11
  day: number; // 1..31
  dow: number; // 0=Sun..6=Sat
  doy: number; // normalized 0..365 (using leap year 2024 as reference)
  open: number;
  high: number;
  low: number;
  close: number;
}

const seasonalsCache = new Map<string, { payload: SymbolSeasonalsPayload; fetchedAt: number }>();

function shortTicker(raw: string): string {
  const upper = (raw || '').trim().toUpperCase();
  const idx = upper.indexOf(':');
  return idx >= 0 ? upper.slice(idx + 1) : upper;
}

function round(val: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

const MONTH_OFFSET_LEAP = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

function normalizedDayOfYear(month: number, day: number): number {
  return Math.min(365, Math.max(0, (MONTH_OFFSET_LEAP[month] ?? 0) + (day - 1)));
}

function computeDayOfWeekStats(bars: DailyBar[], lookbackDays: number): DayOfWeekStat[] {
  const labels: ('Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri')[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const cutoff = bars.length > 0 ? bars[bars.length - 1].ts - lookbackDays * 86_400_000 : 0;
  const buckets = Array.from({ length: 5 }, () => ({
    retSum: 0,
    wins: 0,
    rangeSum: 0,
    count: 0
  }));

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    if (b.ts < cutoff) continue;
    if (b.dow < 1 || b.dow > 5) continue;
    if (prev.close <= 0) continue;
    const idx = b.dow - 1;
    const retPct = ((b.close - prev.close) / prev.close) * 100;
    const rngPct = ((b.high - b.low) / prev.close) * 100;
    buckets[idx].retSum += retPct;
    if (retPct > 0) buckets[idx].wins += 1;
    buckets[idx].rangeSum += rngPct;
    buckets[idx].count += 1;
  }

  return labels.map((day, idx) => {
    const b = buckets[idx];
    return {
      day,
      avgReturnPct: b.count > 0 ? round(b.retSum / b.count, 3) : 0,
      winRatePct: b.count > 0 ? round((b.wins / b.count) * 100, 1) : 0,
      avgRangePct: b.count > 0 ? round(b.rangeSum / b.count, 2) : 0,
      samples: b.count
    };
  });
}

function computeVolatilityProfile(bars: DailyBar[]): VolatilityProfile | null {
  if (bars.length < 22) return null;
  const last = bars[bars.length - 1];
  const lastPrice = last.close;

  // True Range & ATR(14)
  const trs: number[] = [];
  for (let i = Math.max(1, bars.length - 40); i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  const atrSlice = trs.slice(-14);
  const atr14 = atrSlice.length >= 10 ? atrSlice.reduce((a, b) => a + b, 0) / atrSlice.length : null;
  const atr14Pct = atr14 != null && lastPrice > 0 ? (atr14 / lastPrice) * 100 : null;

  // 20-day Average Daily Range (High - Low)
  const last20 = bars.slice(-21, -1); // previous 20 completed sessions
  const adr20 =
    last20.length >= 10
      ? last20.reduce((sum, b) => sum + Math.max(0, b.high - b.low), 0) / last20.length
      : null;
  const adr20Pct = adr20 != null && lastPrice > 0 ? (adr20 / lastPrice) * 100 : null;

  const todayRange = Math.max(0, last.high - last.low);
  const todayRangePctOfAdr = adr20 && adr20 > 0 ? (todayRange / adr20) * 100 : null;

  // 52-week High / Low (~252 trading sessions)
  const last252 = bars.slice(-252);
  let week52High = -Infinity;
  let week52Low = Infinity;
  for (const b of last252) {
    if (b.high > week52High) week52High = b.high;
    if (b.low < week52Low) week52Low = b.low;
  }
  const has52 = Number.isFinite(week52High) && Number.isFinite(week52Low) && week52High > week52Low;
  const week52PositionPct = has52
    ? Math.max(0, Math.min(100, ((lastPrice - week52Low) / (week52High - week52Low)) * 100))
    : null;

  // Swing reference levels (20D, 60D, 52W)
  const calcHiLo = (slice: DailyBar[]) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (const b of slice) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    return { hi, lo };
  };

  const r20 = calcHiLo(bars.slice(-20));
  const r60 = calcHiLo(bars.slice(-60));
  const prevBar = bars[bars.length - 2];

  const rawLevels: { label: string; price: number }[] = [
    { label: '52-Week High', price: week52High },
    { label: '60-Day High', price: r60.hi },
    { label: '20-Day High', price: r20.hi },
    { label: 'Previous Day High', price: prevBar.high },
    { label: 'Previous Day Low', price: prevBar.low },
    { label: '20-Day Low', price: r20.lo },
    { label: '60-Day Low', price: r60.lo },
    { label: '52-Week Low', price: week52Low }
  ];

  // Deduplicate identical levels (e.g. when 20D high === 60D high)
  const swingLevels: SwingLevel[] = [];
  const seenPrices = new Set<string>();
  for (const lv of rawLevels) {
    if (!Number.isFinite(lv.price)) continue;
    const key = lv.price.toFixed(4);
    if (seenPrices.has(key)) continue;
    seenPrices.add(key);
    const dist = lastPrice > 0 ? ((lv.price - lastPrice) / lastPrice) * 100 : 0;
    swingLevels.push({
      label: lv.label,
      price: round(lv.price, 4),
      distancePct: round(dist, 2),
      kind: dist > 0.05 ? 'resistance' : dist < -0.05 ? 'support' : 'reference'
    });
  }
  swingLevels.sort((a, b) => b.price - a.price);

  return {
    lastPrice: round(lastPrice, 4),
    atr14: atr14 != null ? round(atr14, 4) : null,
    atr14Pct: atr14Pct != null ? round(atr14Pct, 2) : null,
    adr20: adr20 != null ? round(adr20, 4) : null,
    adr20Pct: adr20Pct != null ? round(adr20Pct, 2) : null,
    todayRange: round(todayRange, 4),
    todayRangePctOfAdr: todayRangePctOfAdr != null ? round(todayRangePctOfAdr, 1) : null,
    week52High: has52 ? round(week52High, 4) : null,
    week52Low: has52 ? round(week52Low, 4) : null,
    week52PositionPct: week52PositionPct != null ? round(week52PositionPct, 1) : null,
    dayOfWeek1Y: computeDayOfWeekStats(bars, 366),
    dayOfWeek5Y: computeDayOfWeekStats(bars, 366 * 5),
    swingLevels
  };
}

export async function getSymbolSeasonalsPayload(rawSymbol: string): Promise<SymbolSeasonalsPayload> {
  const symbol = rawSymbol.trim().toUpperCase();
  const short = shortTicker(symbol);
  const mapped = YAHOO_MAP[short];
  const yahooSym = mapped?.yahoo ?? short;
  const cacheKey = yahooSym.toUpperCase();

  const cached = seasonalsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEASONALS_TTL_MS) {
    return {
      ...cached.payload,
      symbol,
      shortName: short
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Request daily bars from 2000-01-01 to present (~26 years of true daily candles!)
  const startSec = Math.floor(Date.UTC(2000, 0, 1) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?period1=${startSec}&period2=${nowSec}&interval=1d`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 DeplyzeWorkflow/0.1.14' },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Yahoo Finance returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as {
      chart?: {
        result?: {
          meta?: {
            currency?: string;
            longName?: string;
            shortName?: string;
          };
          timestamp?: number[];
          indicators?: {
            quote?: {
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
            }[];
          };
        }[];
      };
    };

    const result = json.chart?.result?.[0];
    const meta = result?.meta;
    const timestamps = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    const opens = q?.open ?? [];
    const highs = q?.high ?? [];
    const lows = q?.low ?? [];
    const closes = q?.close ?? [];

    const bars: DailyBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue;
      const o = typeof opens[i] === 'number' && Number.isFinite(opens[i]!) ? opens[i]! : c;
      const h = typeof highs[i] === 'number' && Number.isFinite(highs[i]!) ? highs[i]! : Math.max(o, c);
      const l = typeof lows[i] === 'number' && Number.isFinite(lows[i]!) ? lows[i]! : Math.min(o, c);
      const ts = timestamps[i] * 1000;
      const dt = new Date(ts);
      const year = dt.getUTCFullYear();
      const month = dt.getUTCMonth();
      const day = dt.getUTCDate();
      bars.push({
        ts,
        year,
        month,
        day,
        dow: dt.getUTCDay(),
        doy: normalizedDayOfYear(month, day),
        open: o,
        high: h,
        low: l,
        close: c
      });
    }

    // Group daily bars by calendar year
    const byYear = new Map<number, DailyBar[]>();
    for (const b of bars) {
      let arr = byYear.get(b.year);
      if (!arr) {
        arr = [];
        byYear.set(b.year, arr);
      }
      arr.push(b);
    }

    const sortedYears = Array.from(byYear.keys()).sort((a, b) => a - b);
    const years: SeasonalYearSeries[] = [];

    for (let yi = 0; yi < sortedYears.length; yi++) {
      const yr = sortedYears[yi];
      const yBars = byYear.get(yr)!;
      if (yBars.length < 3) continue;

      // Baseline is previous year's final close if available (matches TradingView YTD seasonality), else first bar open/close
      const prevYearBars = yi > 0 ? byYear.get(sortedYears[yi - 1]) : undefined;
      const basePrice =
        prevYearBars && prevYearBars.length > 0
          ? prevYearBars[prevYearBars.length - 1].close
          : yBars[0].open > 0
            ? yBars[0].open
            : yBars[0].close;

      const points: SeasonalDayPoint[] = [];
      let prevDoy = -1;
      for (const b of yBars) {
        if (b.doy === prevDoy && points.length > 0) {
          // Overwrite duplicate date entry with latest close
          points[points.length - 1] = {
            doy: b.doy,
            pct: round(((b.close - basePrice) / basePrice) * 100, 2),
            abs: round(b.close - basePrice, 4),
            idx: round((b.close / basePrice) * 100, 2),
            close: round(b.close, 4)
          };
          continue;
        }
        prevDoy = b.doy;
        points.push({
          doy: b.doy,
          pct: round(((b.close - basePrice) / basePrice) * 100, 2),
          abs: round(b.close - basePrice, 4),
          idx: round((b.close / basePrice) * 100, 2),
          close: round(b.close, 4)
        });
      }

      // Compute monthly % returns (Jan..Dec): close at end of month vs close at end of previous month
      const monthLastClose: (number | null)[] = Array(12).fill(null);
      const monthFirstOpen: (number | null)[] = Array(12).fill(null);
      for (const b of yBars) {
        if (monthFirstOpen[b.month] == null) monthFirstOpen[b.month] = b.open > 0 ? b.open : b.close;
        monthLastClose[b.month] = b.close;
      }

      const months: (number | null)[] = Array(12).fill(null);
      let runningBase: number | null = basePrice;
      for (let mIdx = 0; mIdx < 12; mIdx++) {
        const endC = monthLastClose[mIdx];
        if (endC != null) {
          const ref = runningBase ?? monthFirstOpen[mIdx];
          if (ref != null && ref > 0) {
            months[mIdx] = round(((endC - ref) / ref) * 100, 2);
          }
          runningBase = endC;
        }
      }

      const endPrice = yBars[yBars.length - 1].close;
      years.push({
        year: yr,
        startPrice: round(basePrice, 4),
        endPrice: round(endPrice, 4),
        totalPct: round(((endPrice - basePrice) / basePrice) * 100, 2),
        totalAbs: round(endPrice - basePrice, 4),
        points,
        months
      });
    }

    const nowYear = new Date().getUTCFullYear();
    const minYear = years.length > 0 ? years[0].year : nowYear;
    const maxYear = years.length > 0 ? years[years.length - 1].year : nowYear;
    const description =
      mapped?.desc ??
      (meta?.longName && meta.longName.trim()) ??
      (meta?.shortName && meta.shortName.trim()) ??
      short;
    const currency = mapped?.currency ?? meta?.currency ?? 'USD';

    const payload: SymbolSeasonalsPayload = {
      symbol,
      shortName: short,
      description,
      currency,
      minYear,
      maxYear,
      currentYear: maxYear,
      years,
      volatility: computeVolatilityProfile(bars),
      updatedAt: new Date().toISOString()
    };

    seasonalsCache.set(cacheKey, { payload, fetchedAt: Date.now() });
    if (seasonalsCache.size > 60) {
      const oldest = seasonalsCache.keys().next().value;
      if (oldest) seasonalsCache.delete(oldest);
    }

    return payload;
  } catch (err) {
    console.warn('[insights:seasonals] fetch error:', (err as Error).message);
    const nowYear = new Date().getUTCFullYear();
    return {
      symbol,
      shortName: short,
      description: mapped?.desc ?? short,
      currency: mapped?.currency ?? 'USD',
      minYear: nowYear,
      maxYear: nowYear,
      currentYear: nowYear,
      years: [],
      volatility: null,
      updatedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}
