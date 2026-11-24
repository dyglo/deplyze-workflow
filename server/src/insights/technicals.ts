const TV_SCANNER_URL = 'https://scanner.tradingview.com/global/scan';
const FETCH_TIMEOUT_MS = 10_000;

export type TechnicalsInterval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '1D'
  | '1W'
  | '1M';

export type SignalAction = 'Buy' | 'Neutral' | 'Sell';
export type RatingLabel = 'Strong sell' | 'Sell' | 'Neutral' | 'Buy' | 'Strong buy';

export interface GaugeSummary {
  score: number; // -1 to +1
  rating: RatingLabel;
  sell: number;
  neutral: number;
  buy: number;
}

export interface IndicatorRow {
  name: string;
  value: number | null;
  action: SignalAction;
}

export interface PivotRow {
  method: 'Classic' | 'Fibonacci' | 'Camarilla' | 'Woodie' | 'DM';
  s3: number | null;
  s2: number | null;
  s1: number | null;
  p: number | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
}

export interface MtfOverviewRow {
  interval: TechnicalsInterval;
  label: string;
  summaryScore: number | null;
  summaryRating: RatingLabel;
  oscillatorsRating: RatingLabel;
  movingAveragesRating: RatingLabel;
}

export interface SymbolTechnicalsPayload {
  symbol: string;
  shortName: string;
  description: string;
  resolvedTicker: string;
  interval: TechnicalsInterval;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  atr: number | null;
  summary: GaugeSummary;
  oscillatorsGauge: GaugeSummary;
  movingAveragesGauge: GaugeSummary;
  oscillators: IndicatorRow[];
  movingAverages: IndicatorRow[];
  pivots: PivotRow[];
  mtfOverview: MtfOverviewRow[];
  source: 'tv' | 'yahoo-fallback';
  updatedAt: string;
}

const INTERVAL_SUFFIX: Record<TechnicalsInterval, string> = {
  '1m': '|1',
  '5m': '|5',
  '15m': '|15',
  '30m': '|30',
  '1h': '|60',
  '2h': '|120',
  '4h': '|240',
  '1D': '',
  '1W': '|1W',
  '1M': '|1M'
};

const MTF_INTERVALS: { interval: TechnicalsInterval; label: string }[] = [
  { interval: '15m', label: '15m' },
  { interval: '1h', label: '1H' },
  { interval: '4h', label: '4H' },
  { interval: '1D', label: '1D' },
  { interval: '1W', label: '1W' },
  { interval: '1M', label: '1M' }
];

const TV_TECHNICALS_OVERRIDES: Record<string, string[]> = {
  XAUUSD: ['OANDA:XAUUSD', 'TVC:GOLD'],
  GOLD: ['OANDA:XAUUSD', 'TVC:GOLD'],
  XAGUSD: ['OANDA:XAGUSD', 'TVC:SILVER'],
  SILVER: ['OANDA:XAGUSD', 'TVC:SILVER'],
  USOIL: ['FX:USOIL', 'NYMEX:CL1!', 'TVC:USOIL'],
  WTI: ['FX:USOIL', 'NYMEX:CL1!'],
  WTICOUSD: ['FX:USOIL', 'NYMEX:CL1!'],
  OILUSD: ['FX:USOIL', 'NYMEX:CL1!'],
  UKOIL: ['FX:UKOIL', 'TVC:UKOIL', 'ICEEUR:BRN1!'],
  BRENT: ['FX:UKOIL', 'TVC:UKOIL'],
  DXY: ['TVC:DXY'],
  VIX: ['TVC:VIX'],
  US10Y: ['TVC:US10Y'],
  SPX: ['TVC:SPX', 'SP:SPX'],
  US500: ['TVC:SPX', 'SP:SPX'],
  NAS100: ['NASDAQ:NDX', 'OANDA:NAS100USD'],
  NDX: ['NASDAQ:NDX'],
  US30: ['TVC:DJI', 'DJ:DJI'],
  DJI: ['TVC:DJI', 'DJ:DJI'],
  EURUSD: ['OANDA:EURUSD', 'FX:EURUSD'],
  GBPUSD: ['OANDA:GBPUSD', 'FX:GBPUSD'],
  USDJPY: ['OANDA:USDJPY', 'FX:USDJPY'],
  AUDUSD: ['OANDA:AUDUSD', 'FX:AUDUSD'],
  USDCAD: ['OANDA:USDCAD', 'FX:USDCAD'],
  USDCHF: ['OANDA:USDCHF', 'FX:USDCHF'],
  NZDUSD: ['OANDA:NZDUSD', 'FX:NZDUSD'],
  GBPJPY: ['OANDA:GBPJPY', 'FX:GBPJPY'],
  EURJPY: ['OANDA:EURJPY', 'FX:EURJPY'],
  EURGBP: ['OANDA:EURGBP', 'FX:EURGBP'],
  BTCUSD: ['BITSTAMP:BTCUSD', 'COINBASE:BTCUSD'],
  ETHUSD: ['BITSTAMP:ETHUSD', 'COINBASE:ETHUSD']
};

interface CacheItem {
  payload: SymbolTechnicalsPayload;
  fetchedAt: number;
}

const techCache = new Map<string, CacheItem>();

export function parseTechnicalsInterval(raw: string | null | undefined): TechnicalsInterval {
  const s = (raw ?? '1D').trim();
  const map: Record<string, TechnicalsInterval> = {
    '1': '1m',
    '1m': '1m',
    '5': '5m',
    '5m': '5m',
    '15': '15m',
    '15m': '15m',
    '30': '30m',
    '30m': '30m',
    '60': '1h',
    '1h': '1h',
    '1H': '1h',
    '120': '2h',
    '2h': '2h',
    '2H': '2h',
    '240': '4h',
    '4h': '4h',
    '4H': '4h',
    D: '1D',
    '1d': '1D',
    '1D': '1D',
    W: '1W',
    '1w': '1W',
    '1W': '1W',
    M: '1M',
    '1M': '1M'
  };
  return map[s] ?? '1D';
}

function shortTicker(raw: string): string {
  const upper = (raw || '').trim().toUpperCase();
  const idx = upper.indexOf(':');
  return idx >= 0 ? upper.slice(idx + 1) : upper;
}

function candidateTvTickers(raw: string): string[] {
  const upper = (raw || '').trim().toUpperCase();
  const short = shortTicker(upper);
  const list: string[] = [];
  if (TV_TECHNICALS_OVERRIDES[short]) {
    for (const t of TV_TECHNICALS_OVERRIDES[short]) {
      if (!list.includes(t)) list.push(t);
    }
  }
  if (upper.includes(':') && !list.includes(upper)) {
    list.unshift(upper);
    // For USOIL, prioritize FX:USOIL / NYMEX:CL1! ahead of TVC:USOIL since TVC:USOIL lacks scanner data
    if (short === 'USOIL' || short === 'WTI' || short === 'WTICOUSD') {
      return ['FX:USOIL', 'NYMEX:CL1!', upper];
    }
  }
  if (!list.includes(short)) list.push(short);
  return list;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function roundVal(v: number | null, digits = 4): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(v * factor) / factor;
}

export function scoreToRating(score: number | null): RatingLabel {
  if (score == null || !Number.isFinite(score)) return 'Neutral';
  if (score < -0.5) return 'Strong sell';
  if (score < -0.1) return 'Sell';
  if (score <= 0.1) return 'Neutral';
  if (score <= 0.5) return 'Buy';
  return 'Strong buy';
}

function recNumToAction(rec: number | null): SignalAction {
  if (rec == null || !Number.isFinite(rec)) return 'Neutral';
  if (rec > 0) return 'Buy';
  if (rec < 0) return 'Sell';
  return 'Neutral';
}

// TradingView documented oscillator signal rules
function computeRsiAction(rsi: number | null, rsiPrev: number | null): SignalAction {
  if (rsi == null) return 'Neutral';
  if (rsi < 30 && (rsiPrev == null || rsi > rsiPrev)) return 'Buy';
  if (rsi > 70 && (rsiPrev == null || rsi < rsiPrev)) return 'Sell';
  return 'Neutral';
}

function computeStochAction(
  k: number | null,
  d: number | null,
  kPrev: number | null,
  dPrev: number | null
): SignalAction {
  if (k == null || d == null) return 'Neutral';
  if (k < 20 && d < 20 && k > d && (kPrev == null || dPrev == null || kPrev < dPrev)) return 'Buy';
  if (k > 80 && d > 80 && k < d && (kPrev == null || dPrev == null || kPrev > dPrev)) return 'Sell';
  return 'Neutral';
}

function computeCciAction(cci: number | null, cciPrev: number | null): SignalAction {
  if (cci == null) return 'Neutral';
  if (cci < -100 && (cciPrev == null || cci > cciPrev)) return 'Buy';
  if (cci > 100 && (cciPrev == null || cci < cciPrev)) return 'Sell';
  return 'Neutral';
}

function computeAdxAction(
  adx: number | null,
  diPlus: number | null,
  diMinus: number | null,
  diPlusPrev: number | null,
  diMinusPrev: number | null
): SignalAction {
  if (adx == null || diPlus == null || diMinus == null) return 'Neutral';
  if (adx > 20) {
    if (diPlus > diMinus && (diPlusPrev == null || diMinusPrev == null || diPlusPrev < diMinusPrev)) {
      return 'Buy';
    }
    if (diMinus > diPlus && (diPlusPrev == null || diMinusPrev == null || diMinusPrev < diPlusPrev)) {
      return 'Sell';
    }
  }
  return 'Neutral';
}

function computeAoAction(ao: number | null, ao1: number | null, ao2: number | null): SignalAction {
  if (ao == null || ao1 == null) return 'Neutral';
  // Zero line crossover or saucer pattern
  if (ao > 0 && ao1 < 0) return 'Buy';
  if (ao < 0 && ao1 > 0) return 'Sell';
  if (ao2 != null) {
    if (ao > 0 && ao > ao1 && ao1 < ao2) return 'Buy';
    if (ao < 0 && ao < ao1 && ao1 > ao2) return 'Sell';
  }
  return 'Neutral';
}

function computeMomAction(mom: number | null, momPrev: number | null): SignalAction {
  if (mom == null || momPrev == null) return 'Neutral';
  if (mom > momPrev) return 'Buy';
  if (mom < momPrev) return 'Sell';
  return 'Neutral';
}

function computeMacdAction(macd: number | null, signal: number | null): SignalAction {
  if (macd == null || signal == null) return 'Neutral';
  if (macd > signal) return 'Buy';
  if (macd < signal) return 'Sell';
  return 'Neutral';
}

function computeMaAction(maVal: number | null, close: number | null): SignalAction {
  if (maVal == null || close == null) return 'Neutral';
  if (maVal < close) return 'Buy';
  if (maVal > close) return 'Sell';
  return 'Neutral';
}

function tallyRows(rows: IndicatorRow[], tvScore: number | null): GaugeSummary {
  let buy = 0;
  let neutral = 0;
  let sell = 0;
  for (const r of rows) {
    if (r.action === 'Buy') buy += 1;
    else if (r.action === 'Sell') sell += 1;
    else neutral += 1;
  }
  const total = buy + neutral + sell;
  const computed = total > 0 ? (buy - sell) / total : 0;
  const score = tvScore != null && Number.isFinite(tvScore) ? tvScore : computed;
  return {
    score: Number(score.toFixed(4)),
    rating: scoreToRating(score),
    sell,
    neutral,
    buy
  };
}

export async function getSymbolTechnicalsPayload(
  rawSymbol: string,
  rawInterval?: string | null
): Promise<SymbolTechnicalsPayload> {
  const symbol = rawSymbol.trim().toUpperCase();
  const short = shortTicker(symbol);
  const interval = parseTechnicalsInterval(rawInterval);
  const cacheKey = `${symbol}|${interval}`;
  const ttlMs = interval === '1D' || interval === '1W' || interval === '1M' ? 60_000 : 20_000;

  const cached = techCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.payload;
  }

  const s = INTERVAL_SUFFIX[interval];
  const cols: string[] = [
    'close',
    'description',
    'change',
    'change_abs',
    `Recommend.All${s}`,
    `Recommend.Other${s}`,
    `Recommend.MA${s}`,
    `RSI${s}`,
    `RSI[1]${s}`,
    `Stoch.K${s}`,
    `Stoch.D${s}`,
    `Stoch.K[1]${s}`,
    `Stoch.D[1]${s}`,
    `CCI20${s}`,
    `CCI20[1]${s}`,
    `ADX${s}`,
    `ADX+DI${s}`,
    `ADX-DI${s}`,
    `ADX+DI[1]${s}`,
    `ADX-DI[1]${s}`,
    `AO${s}`,
    `AO[1]${s}`,
    `AO[2]${s}`,
    `Mom${s}`,
    `Mom[1]${s}`,
    `MACD.macd${s}`,
    `MACD.signal${s}`,
    `Stoch.RSI.K${s}`,
    `Rec.Stoch.RSI${s}`,
    `W.R${s}`,
    `Rec.WR${s}`,
    `BBPower${s}`,
    `Rec.BBPower${s}`,
    `UO${s}`,
    `Rec.UO${s}`,
    `EMA10${s}`,
    `SMA10${s}`,
    `EMA20${s}`,
    `SMA20${s}`,
    `EMA30${s}`,
    `SMA30${s}`,
    `EMA50${s}`,
    `SMA50${s}`,
    `EMA100${s}`,
    `SMA100${s}`,
    `EMA200${s}`,
    `SMA200${s}`,
    `Ichimoku.BLine${s}`,
    `Rec.Ichimoku${s}`,
    `VWMA${s}`,
    `Rec.VWMA${s}`,
    `HullMA9${s}`,
    `Rec.HullMA9${s}`,
    `Pivot.M.Classic.S3${s}`,
    `Pivot.M.Classic.S2${s}`,
    `Pivot.M.Classic.S1${s}`,
    `Pivot.M.Classic.Middle${s}`,
    `Pivot.M.Classic.R1${s}`,
    `Pivot.M.Classic.R2${s}`,
    `Pivot.M.Classic.R3${s}`,
    `Pivot.M.Fibonacci.S3${s}`,
    `Pivot.M.Fibonacci.S2${s}`,
    `Pivot.M.Fibonacci.S1${s}`,
    `Pivot.M.Fibonacci.Middle${s}`,
    `Pivot.M.Fibonacci.R1${s}`,
    `Pivot.M.Fibonacci.R2${s}`,
    `Pivot.M.Fibonacci.R3${s}`,
    `Pivot.M.Camarilla.S3${s}`,
    `Pivot.M.Camarilla.S2${s}`,
    `Pivot.M.Camarilla.S1${s}`,
    `Pivot.M.Camarilla.Middle${s}`,
    `Pivot.M.Camarilla.R1${s}`,
    `Pivot.M.Camarilla.R2${s}`,
    `Pivot.M.Camarilla.R3${s}`,
    `Pivot.M.Woodie.S3${s}`,
    `Pivot.M.Woodie.S2${s}`,
    `Pivot.M.Woodie.S1${s}`,
    `Pivot.M.Woodie.Middle${s}`,
    `Pivot.M.Woodie.R1${s}`,
    `Pivot.M.Woodie.R2${s}`,
    `Pivot.M.Woodie.R3${s}`,
    `Pivot.M.Demark.S1${s}`,
    `Pivot.M.Demark.Middle${s}`,
    `Pivot.M.Demark.R1${s}`,
    `ATR${s}`
  ];

  // Append multi-timeframe overview columns in the same single scan call
  for (const mtf of MTF_INTERVALS) {
    const ms = INTERVAL_SUFFIX[mtf.interval];
    cols.push(`Recommend.All${ms}`, `Recommend.Other${ms}`, `Recommend.MA${ms}`);
  }

  const tickers = candidateTvTickers(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(TV_SCANNER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeplyzeWorkflow-API/0.1.14'
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: cols
      }),
      signal: controller.signal
    });

    if (res.ok) {
      const json = (await res.json()) as { data?: { s?: string; d?: unknown[] }[] };
      const rowsByTicker = new Map<string, unknown[]>();
      for (const item of json.data ?? []) {
        if (item.s && Array.isArray(item.d)) {
          rowsByTicker.set(item.s.toUpperCase(), item.d);
        }
      }

      let chosenTicker = '';
      let chosenData: unknown[] | null = null;
      for (const t of tickers) {
        const d = rowsByTicker.get(t.toUpperCase());
        if (d && num(d[0]) != null) {
          chosenTicker = t;
          chosenData = d;
          break;
        }
      }
      if (!chosenData && json.data && json.data.length > 0 && Array.isArray(json.data[0].d)) {
        chosenTicker = json.data[0].s ?? tickers[0];
        chosenData = json.data[0].d;
      }

      if (chosenData) {
        const m = new Map<string, unknown>();
        for (let i = 0; i < cols.length; i++) {
          m.set(cols[i], chosenData[i]);
        }

        const close = num(m.get('close'));
        const descRaw = m.get('description');
        const description =
          typeof descRaw === 'string' && descRaw.trim() ? descRaw.trim() : short;
        const changePercent = num(m.get('change'));
        const change = num(m.get('change_abs'));
        const recAll = num(m.get(`Recommend.All${s}`));
        const recOsc = num(m.get(`Recommend.Other${s}`));
        const recMa = num(m.get(`Recommend.MA${s}`));
        const atr = num(m.get(`ATR${s}`));

        const oscillators: IndicatorRow[] = [
          {
            name: 'Relative Strength Index (14)',
            value: roundVal(num(m.get(`RSI${s}`)), 2),
            action: computeRsiAction(num(m.get(`RSI${s}`)), num(m.get(`RSI[1]${s}`)))
          },
          {
            name: 'Stochastic %K (14, 3, 3)',
            value: roundVal(num(m.get(`Stoch.K${s}`)), 2),
            action: computeStochAction(
              num(m.get(`Stoch.K${s}`)),
              num(m.get(`Stoch.D${s}`)),
              num(m.get(`Stoch.K[1]${s}`)),
              num(m.get(`Stoch.D[1]${s}`))
            )
          },
          {
            name: 'Commodity Channel Index (20)',
            value: roundVal(num(m.get(`CCI20${s}`)), 2),
            action: computeCciAction(num(m.get(`CCI20${s}`)), num(m.get(`CCI20[1]${s}`)))
          },
          {
            name: 'Average Directional Index (14)',
            value: roundVal(num(m.get(`ADX${s}`)), 2),
            action: computeAdxAction(
              num(m.get(`ADX${s}`)),
              num(m.get(`ADX+DI${s}`)),
              num(m.get(`ADX-DI${s}`)),
              num(m.get(`ADX+DI[1]${s}`)),
              num(m.get(`ADX-DI[1]${s}`))
            )
          },
          {
            name: 'Awesome Oscillator',
            value: roundVal(num(m.get(`AO${s}`)), 4),
            action: computeAoAction(
              num(m.get(`AO${s}`)),
              num(m.get(`AO[1]${s}`)),
              num(m.get(`AO[2]${s}`))
            )
          },
          {
            name: 'Momentum (10)',
            value: roundVal(num(m.get(`Mom${s}`)), 4),
            action: computeMomAction(num(m.get(`Mom${s}`)), num(m.get(`Mom[1]${s}`)))
          },
          {
            name: 'MACD Level (12, 26)',
            value: roundVal(num(m.get(`MACD.macd${s}`)), 4),
            action: computeMacdAction(
              num(m.get(`MACD.macd${s}`)),
              num(m.get(`MACD.signal${s}`))
            )
          },
          {
            name: 'Stochastic RSI Fast (3, 3, 14, 14)',
            value: roundVal(num(m.get(`Stoch.RSI.K${s}`)), 2),
            action: recNumToAction(num(m.get(`Rec.Stoch.RSI${s}`)))
          },
          {
            name: 'Williams Percent Range (14)',
            value: roundVal(num(m.get(`W.R${s}`)), 2),
            action: recNumToAction(num(m.get(`Rec.WR${s}`)))
          },
          {
            name: 'Bull Bear Power',
            value: roundVal(num(m.get(`BBPower${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.BBPower${s}`)))
          },
          {
            name: 'Ultimate Oscillator (7, 14, 28)',
            value: roundVal(num(m.get(`UO${s}`)), 2),
            action: recNumToAction(num(m.get(`Rec.UO${s}`)))
          }
        ];

        const movingAverages: IndicatorRow[] = [
          {
            name: 'Exponential Moving Average (10)',
            value: roundVal(num(m.get(`EMA10${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA10${s}`)), close)
          },
          {
            name: 'Simple Moving Average (10)',
            value: roundVal(num(m.get(`SMA10${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA10${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (20)',
            value: roundVal(num(m.get(`EMA20${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA20${s}`)), close)
          },
          {
            name: 'Simple Moving Average (20)',
            value: roundVal(num(m.get(`SMA20${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA20${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (30)',
            value: roundVal(num(m.get(`EMA30${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA30${s}`)), close)
          },
          {
            name: 'Simple Moving Average (30)',
            value: roundVal(num(m.get(`SMA30${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA30${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (50)',
            value: roundVal(num(m.get(`EMA50${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA50${s}`)), close)
          },
          {
            name: 'Simple Moving Average (50)',
            value: roundVal(num(m.get(`SMA50${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA50${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (100)',
            value: roundVal(num(m.get(`EMA100${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA100${s}`)), close)
          },
          {
            name: 'Simple Moving Average (100)',
            value: roundVal(num(m.get(`SMA100${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA100${s}`)), close)
          },
          {
            name: 'Exponential Moving Average (200)',
            value: roundVal(num(m.get(`EMA200${s}`)), 4),
            action: computeMaAction(num(m.get(`EMA200${s}`)), close)
          },
          {
            name: 'Simple Moving Average (200)',
            value: roundVal(num(m.get(`SMA200${s}`)), 4),
            action: computeMaAction(num(m.get(`SMA200${s}`)), close)
          },
          {
            name: 'Ichimoku Base Line (9, 26, 52, 26)',
            value: roundVal(num(m.get(`Ichimoku.BLine${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.Ichimoku${s}`)))
          },
          {
            name: 'Volume Weighted Moving Average (20)',
            value: roundVal(num(m.get(`VWMA${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.VWMA${s}`)))
          },
          {
            name: 'Hull Moving Average (9)',
            value: roundVal(num(m.get(`HullMA9${s}`)), 4),
            action: recNumToAction(num(m.get(`Rec.HullMA9${s}`)))
          }
        ];

        const oscillatorsGauge = tallyRows(oscillators, recOsc);
        const movingAveragesGauge = tallyRows(movingAverages, recMa);
        const summary = tallyRows([...oscillators, ...movingAverages], recAll);

        const pivots: PivotRow[] = [
          {
            method: 'Classic',
            s3: roundVal(num(m.get(`Pivot.M.Classic.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Classic.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Classic.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Classic.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Classic.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Classic.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Classic.R3${s}`)), 4)
          },
          {
            method: 'Fibonacci',
            s3: roundVal(num(m.get(`Pivot.M.Fibonacci.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Fibonacci.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Fibonacci.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Fibonacci.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Fibonacci.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Fibonacci.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Fibonacci.R3${s}`)), 4)
          },
          {
            method: 'Camarilla',
            s3: roundVal(num(m.get(`Pivot.M.Camarilla.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Camarilla.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Camarilla.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Camarilla.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Camarilla.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Camarilla.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Camarilla.R3${s}`)), 4)
          },
          {
            method: 'Woodie',
            s3: roundVal(num(m.get(`Pivot.M.Woodie.S3${s}`)), 4),
            s2: roundVal(num(m.get(`Pivot.M.Woodie.S2${s}`)), 4),
            s1: roundVal(num(m.get(`Pivot.M.Woodie.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Woodie.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Woodie.R1${s}`)), 4),
            r2: roundVal(num(m.get(`Pivot.M.Woodie.R2${s}`)), 4),
            r3: roundVal(num(m.get(`Pivot.M.Woodie.R3${s}`)), 4)
          },
          {
            method: 'DM',
            s3: null,
            s2: null,
            s1: roundVal(num(m.get(`Pivot.M.Demark.S1${s}`)), 4),
            p: roundVal(num(m.get(`Pivot.M.Demark.Middle${s}`)), 4),
            r1: roundVal(num(m.get(`Pivot.M.Demark.R1${s}`)), 4),
            r2: null,
            r3: null
          }
        ];

        const mtfOverview: MtfOverviewRow[] = MTF_INTERVALS.map((entry) => {
          const ms = INTERVAL_SUFFIX[entry.interval];
          const mAll = num(m.get(`Recommend.All${ms}`));
          const mOsc = num(m.get(`Recommend.Other${ms}`));
          const mMa = num(m.get(`Recommend.MA${ms}`));
          return {
            interval: entry.interval,
            label: entry.label,
            summaryScore: mAll != null ? Number(mAll.toFixed(3)) : null,
            summaryRating: scoreToRating(mAll),
            oscillatorsRating: scoreToRating(mOsc),
            movingAveragesRating: scoreToRating(mMa)
          };
        });

        const payload: SymbolTechnicalsPayload = {
          symbol,
          shortName: short,
          description,
          resolvedTicker: chosenTicker,
          interval,
          price: close,
          change,
          changePercent,
          atr: roundVal(atr, 4),
          summary,
          oscillatorsGauge,
          movingAveragesGauge,
          oscillators,
          movingAverages,
          pivots,
          mtfOverview,
          source: 'tv',
          updatedAt: new Date().toISOString()
        };

        techCache.set(cacheKey, { payload, fetchedAt: Date.now() });
        if (techCache.size > 120) {
          const oldest = techCache.keys().next().value;
          if (oldest) techCache.delete(oldest);
        }
        return payload;
      }
    }
  } catch (err) {
    console.warn('[insights:technicals] TV scan error:', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }

  // Graceful neutral fallback if symbol is unrecognized upstream
  const emptyGauge: GaugeSummary = { score: 0, rating: 'Neutral', sell: 0, neutral: 0, buy: 0 };
  return {
    symbol,
    shortName: short,
    description: short,
    resolvedTicker: tickers[0] ?? symbol,
    interval,
    price: null,
    change: null,
    changePercent: null,
    atr: null,
    summary: emptyGauge,
    oscillatorsGauge: emptyGauge,
    movingAveragesGauge: emptyGauge,
    oscillators: [],
    movingAverages: [],
    pivots: [],
    mtfOverview: [],
    source: 'yahoo-fallback',
    updatedAt: new Date().toISOString()
  };
}
