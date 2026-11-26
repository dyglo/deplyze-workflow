import { getQuotesPayload, type MarketQuote } from '../quotes/service.js';
import { normalizeShortSymbol } from './macro.js';

export type DislocationTimeframe = '15m' | '1h' | '4h';
export type SmDirection = 'bullish' | 'bearish';
export type VerdictKind =
  | 'bearish_trap'
  | 'bullish_spring'
  | 'bearish_smt'
  | 'bullish_smt'
  | 'mixed'
  | 'rich'
  | 'cheap'
  | 'weak_fit'
  | 'equilibrium';

export interface OhlcBar {
  ts: number; // Unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DriverContribution {
  symbol: string;
  shortName: string;
  price: number | null;
  windowChangePct: number;
  beta: number; // stationary return elasticity
  correlation: number; // bar-to-bar return correlation (-1..1)
  weightPct: number; // share of model impact (0..100)
  pull: 'up' | 'down' | 'flat';
  lagBars: number;
  lagCorrelation: number;
  active: boolean;
}

export interface SmtSignal {
  id: string;
  direction: SmDirection;
  levelKind:
    | 'asia_high'
    | 'asia_low'
    | 'london_high'
    | 'london_low'
    | 'pdh'
    | 'pdl'
    | 'swing_high'
    | 'swing_low';
  levelLabel: string;
  peerSymbol: string;
  peerShortName: string;
  relation: 'positive' | 'inverse';
  sweptBy: 'target' | 'peer';
  targetLevel: number;
  targetExtreme: number;
  peerLevel: number;
  peerExtreme: number;
  peerGapAtr: number; // how many peer avg-bar moves short of confirming
  peerGapPct: number;
  minutesAgo: number;
  freshness: 'fresh' | 'recent';
  summary: string;
}

export interface SessionPoolWatch {
  id: string;
  label: string;
  side: 'high' | 'low';
  targetLevel: number;
  distancePct: number;
  targetSwept: boolean;
  peerShortName: string;
  peerSwept: boolean;
  smtState: 'none' | 'bullish' | 'bearish';
}

export interface LeadLagReadout {
  leaderShortName: string;
  leaderSymbol: string;
  lagBars: number;
  lagMinutes: number;
  correlation: number;
  relation: 'positive' | 'inverse';
  summary: string;
}

export interface ResidualPoint {
  ts: number;
  z: number; // stretch multiple vs typical H-bar gap
  spot: number;
  fair: number;
}

export interface ScoreBreakdown {
  stretchPts: number;
  maxStretchPts: number;
  fitPts: number;
  maxFitPts: number;
  smtPts: number;
  maxSmtPts: number;
  conflictPenalty: number;
  total: number;
  explanation: string;
}

export interface DislocationPayload {
  symbol: string;
  shortName: string;
  timeframe: DislocationTimeframe;
  spotPrice: number;
  fairValuePrice: number;
  gapPoints: number;
  gapPct: number;
  zScore: number; // stretch multiple (plain UI shows e.g. +1.8x normal)
  rSquared: number; // honest Adjusted Return R² (0..0.99)
  driverFitLabel: 'Strong' | 'Moderate' | 'Weak';
  atr: number; // avg bar range (14 bars)
  atrPct: number;
  windowBars: number;
  horizonBars: number;
  reversingCandle: boolean;
  verdict: VerdictKind;
  verdictLabel: string;
  verdictDetail: string;
  verdictReason: string;
  convictionScore: number; // 0..100
  scoreBreakdown: ScoreBreakdown;
  drivers: DriverContribution[];
  leadLag: LeadLagReadout | null;
  smtSignals: SmtSignal[];
  sessionPools: SessionPoolWatch[];
  residualSeries: ResidualPoint[];
  updatedAt: string;
}

export interface DislocationScanRow {
  symbol: string;
  shortName: string;
  spotPrice: number;
  fairValuePrice: number;
  gapPct: number;
  zScore: number;
  rSquared: number;
  driverFitLabel: 'Strong' | 'Moderate' | 'Weak';
  atr: number;
  verdict: VerdictKind;
  verdictLabel: string;
  convictionScore: number;
  topSmtLabel: string | null;
  topSmtDirection: SmDirection | null;
  topSmtMinutesAgo: number | null;
  smtConflict: boolean;
  topDriverLabel: string | null;
}

export interface DislocationScanPayload {
  timeframe: DislocationTimeframe;
  rows: DislocationScanRow[];
  updatedAt: string;
}

interface DriverSpec {
  symbol: string;
  shortName: string;
  expectedSign: 1 | -1;
}

interface PeerSpec {
  symbol: string;
  shortName: string;
  relation: 'positive' | 'inverse';
}

interface SymbolModelSpec {
  canonical: string;
  shortName: string;
  drivers: DriverSpec[];
  peers: PeerSpec[];
}

const YAHOO_MAP: Record<string, string> = {
  XAUUSD: 'GC=F',
  GOLD: 'GC=F',
  XAGUSD: 'SI=F',
  SILVER: 'SI=F',
  USOIL: 'CL=F',
  WTI: 'CL=F',
  UKOIL: 'BZ=F',
  BRENT: 'BZ=F',
  DXY: 'DX-Y.NYB',
  VIX: '^VIX',
  US10Y: '^TNX',
  SPX: '^GSPC',
  US500: '^GSPC',
  NAS100: '^NDX',
  NDX: '^NDX',
  US30: '^DJI',
  DJI: '^DJI',
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'JPY=X',
  AUDUSD: 'AUDUSD=X',
  USDCAD: 'CAD=X',
  USDCHF: 'CHF=X',
  NZDUSD: 'NZDUSD=X',
  GBPJPY: 'GBPJPY=X',
  EURJPY: 'EURJPY=X',
  EURGBP: 'EURGBP=X',
  BTCUSD: 'BTC-USD',
  ETHUSD: 'ETH-USD',
  SOLUSD: 'SOL-USD'
};

const CANONICAL_MAP: Record<string, string> = {
  XAUUSD: 'OANDA:XAUUSD',
  XAGUSD: 'OANDA:XAGUSD',
  DXY: 'TVC:DXY',
  US10Y: 'TVC:US10Y',
  VIX: 'TVC:VIX',
  EURUSD: 'OANDA:EURUSD',
  GBPUSD: 'OANDA:GBPUSD',
  USDJPY: 'OANDA:USDJPY',
  AUDUSD: 'OANDA:AUDUSD',
  USDCAD: 'OANDA:USDCAD',
  USDCHF: 'OANDA:USDCHF',
  NZDUSD: 'OANDA:NZDUSD',
  GBPJPY: 'OANDA:GBPJPY',
  EURJPY: 'OANDA:EURJPY',
  EURGBP: 'OANDA:EURGBP',
  NAS100: 'NASDAQ:NDX',
  SPX: 'TVC:SPX',
  US30: 'TVC:DJI',
  USOIL: 'TVC:USOIL',
  UKOIL: 'TVC:UKOIL',
  BTCUSD: 'BITSTAMP:BTCUSD',
  ETHUSD: 'BITSTAMP:ETHUSD'
};

const SCAN_UNIVERSE: string[] = [
  'OANDA:XAUUSD',
  'OANDA:XAGUSD',
  'OANDA:EURUSD',
  'OANDA:GBPUSD',
  'OANDA:USDJPY',
  'OANDA:AUDUSD',
  'OANDA:USDCAD',
  'NASDAQ:NDX',
  'TVC:SPX',
  'TVC:DJI',
  'TVC:USOIL',
  'BITSTAMP:BTCUSD'
];

// Clean, high-correlation structural peers (avoids noisy weak cross-pairs)
const MODEL_SPECS: Record<string, { drivers: DriverSpec[]; peers: PeerSpec[] }> = {
  XAUUSD: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 },
      { symbol: 'OANDA:XAGUSD', shortName: 'XAGUSD', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'OANDA:XAGUSD', shortName: 'XAGUSD', relation: 'positive' },
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
    ]
  },
  XAGUSD: {
    drivers: [
      { symbol: 'OANDA:XAUUSD', shortName: 'XAUUSD', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'OANDA:XAUUSD', shortName: 'XAUUSD', relation: 'positive' },
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
    ]
  },
  DXY: {
    drivers: [
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: -1 },
      { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'inverse' },
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', relation: 'inverse' }
    ]
  },
  EURUSD: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', relation: 'positive' },
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
    ]
  },
  GBPUSD: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'positive' },
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
    ]
  },
  USDJPY: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [{ symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' }]
  },
  AUDUSD: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'OANDA:NZDUSD', shortName: 'NZDUSD', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'OANDA:NZDUSD', shortName: 'NZDUSD', relation: 'positive' },
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
    ]
  },
  NZDUSD: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'OANDA:AUDUSD', shortName: 'AUDUSD', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'OANDA:AUDUSD', shortName: 'AUDUSD', relation: 'positive' },
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
    ]
  },
  USDCAD: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: 1 },
      { symbol: 'TVC:USOIL', shortName: 'USOIL', expectedSign: -1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: 1 }
    ],
    peers: [{ symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' }]
  },
  USDCHF: {
    drivers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: 1 },
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: -1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' },
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'inverse' }
    ]
  },
  GBPJPY: {
    drivers: [
      { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', expectedSign: 1 },
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [{ symbol: 'OANDA:EURJPY', shortName: 'EURJPY', relation: 'positive' }]
  },
  EURJPY: {
    drivers: [
      { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', expectedSign: 1 },
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [{ symbol: 'OANDA:GBPJPY', shortName: 'GBPJPY', relation: 'positive' }]
  },
  EURGBP: {
    drivers: [
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', expectedSign: -1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 }
    ],
    peers: [{ symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'positive' }]
  },
  NAS100: {
    drivers: [
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 },
      { symbol: 'TVC:VIX', shortName: 'VIX', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'TVC:SPX', shortName: 'SPX', relation: 'positive' },
      { symbol: 'TVC:DJI', shortName: 'US30', relation: 'positive' }
    ]
  },
  SPX: {
    drivers: [
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:DJI', shortName: 'US30', expectedSign: 1 },
      { symbol: 'TVC:VIX', shortName: 'VIX', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', relation: 'positive' },
      { symbol: 'TVC:DJI', shortName: 'US30', relation: 'positive' }
    ]
  },
  US30: {
    drivers: [
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:VIX', shortName: 'VIX', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'TVC:SPX', shortName: 'SPX', relation: 'positive' },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', relation: 'positive' }
    ]
  },
  USOIL: {
    drivers: [
      { symbol: 'TVC:UKOIL', shortName: 'UKOIL', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [{ symbol: 'TVC:UKOIL', shortName: 'UKOIL', relation: 'positive' }]
  },
  UKOIL: {
    drivers: [
      { symbol: 'TVC:USOIL', shortName: 'USOIL', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [{ symbol: 'TVC:USOIL', shortName: 'USOIL', relation: 'positive' }]
  },
  BTCUSD: {
    drivers: [
      { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', expectedSign: 1 },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 }
    ],
    peers: [{ symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', relation: 'positive' }]
  },
  ETHUSD: {
    drivers: [
      { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', expectedSign: 1 },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 }
    ],
    peers: [{ symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', relation: 'positive' }]
  }
};

function resolveModelSpec(rawSymbol: string): SymbolModelSpec {
  const short = normalizeShortSymbol(rawSymbol);
  const canonical = rawSymbol.includes(':')
    ? rawSymbol.trim().toUpperCase()
    : (CANONICAL_MAP[short] ?? short);

  if (MODEL_SPECS[short]) {
    return { canonical, shortName: short, ...MODEL_SPECS[short] };
  }

  if (short.endsWith('USD') && short.length === 6 && !short.startsWith('X')) {
    return {
      canonical,
      shortName: short,
      drivers: [
        { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
        { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
        { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
      ],
      peers: [{ symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'positive' }]
    };
  }
  if (short.startsWith('USD') && short.length === 6) {
    return {
      canonical,
      shortName: short,
      drivers: [
        { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: 1 },
        { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: 1 },
        { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', expectedSign: 1 }
      ],
      peers: [{ symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' }]
    };
  }
  if (short.endsWith('USDT') || (short.endsWith('USD') && short.length >= 6)) {
    return {
      canonical,
      shortName: short,
      drivers: [
        { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', expectedSign: 1 },
        { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', expectedSign: 1 },
        { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 }
      ],
      peers: [{ symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', relation: 'positive' }]
    };
  }

  return {
    canonical,
    shortName: short,
    drivers: [
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
    ],
    peers: [{ symbol: 'NASDAQ:NDX', shortName: 'NAS100', relation: 'positive' }]
  };
}

// ── Cached Yahoo OHLC Fetcher ────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;
const BAR_CACHE_TTL_MS = 60_000;
const PAYLOAD_CACHE_TTL_MS = 45_000;
const SCAN_CACHE_TTL_MS = 75_000;

const barCache = new Map<string, { bars: OhlcBar[]; fetchedAt: number }>();
const barInflight = new Map<string, Promise<OhlcBar[]>>();
const payloadCache = new Map<string, { data: DislocationPayload; fetchedAt: number }>();
const scanCache = new Map<string, { data: DislocationScanPayload; fetchedAt: number }>();
const scanInflight = new Map<string, Promise<DislocationScanPayload>>();

export function parseTimeframe(raw: string | null | undefined): DislocationTimeframe {
  const clean = (raw ?? '').trim().toLowerCase();
  if (clean === '15m' || clean === '15') return '15m';
  if (clean === '4h' || clean === '240') return '4h';
  return '1h';
}

function stepSecondsForTf(tf: DislocationTimeframe): number {
  if (tf === '15m') return 900;
  if (tf === '4h') return 14_400;
  return 3_600;
}

function yahooQueryForTf(tf: DislocationTimeframe): { range: string; interval: string } {
  if (tf === '15m') return { range: '5d', interval: '15m' };
  if (tf === '4h') return { range: '3mo', interval: '1h' };
  return { range: '1mo', interval: '1h' };
}

function aggregateTo4h(hourly: OhlcBar[]): OhlcBar[] {
  const buckets = new Map<number, OhlcBar>();
  for (const b of hourly) {
    const key = Math.floor(b.ts / 14_400) * 14_400;
    const prev = buckets.get(key);
    if (!prev) {
      buckets.set(key, { ts: key, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      prev.high = Math.max(prev.high, b.high);
      prev.low = Math.min(prev.low, b.low);
      prev.close = b.close;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

async function fetchYahooSeries(
  shortName: string,
  tf: DislocationTimeframe,
  force = false
): Promise<OhlcBar[]> {
  const norm = normalizeShortSymbol(shortName);
  const yahooSym = YAHOO_MAP[norm] ?? norm;
  const cacheKey = `${yahooSym}|${tf}`;
  const now = Date.now();

  if (!force) {
    const cached = barCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < BAR_CACHE_TTL_MS) {
      return cached.bars;
    }
    const existing = barInflight.get(cacheKey);
    if (existing) return existing;
  }

  const task = (async (): Promise<OhlcBar[]> => {
    const { range, interval } = yahooQueryForTf(tf);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}&includePrePost=true`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 DeplyzeWorkflow/0.1.19' },
        signal: controller.signal
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        chart?: {
          result?: {
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
      const r = json.chart?.result?.[0];
      const tsArr = r?.timestamp ?? [];
      const q = r?.indicators?.quote?.[0];
      const opens = q?.open ?? [];
      const highs = q?.high ?? [];
      const lows = q?.low ?? [];
      const closes = q?.close ?? [];

      const rawBars: OhlcBar[] = [];
      for (let i = 0; i < tsArr.length; i++) {
        const ts = tsArr[i];
        const o = opens[i];
        const h = highs[i];
        const l = lows[i];
        const c = closes[i];
        if (
          typeof ts !== 'number' ||
          typeof o !== 'number' ||
          typeof h !== 'number' ||
          typeof l !== 'number' ||
          typeof c !== 'number' ||
          !Number.isFinite(o) ||
          !Number.isFinite(h) ||
          !Number.isFinite(l) ||
          !Number.isFinite(c) ||
          c <= 0
        ) {
          continue;
        }
        rawBars.push({
          ts,
          open: o,
          high: Math.max(h, o, c),
          low: Math.min(l, o, c),
          close: c
        });
      }

      rawBars.sort((a, b) => a.ts - b.ts);
      const bars = tf === '4h' ? aggregateTo4h(rawBars) : rawBars;
      barCache.set(cacheKey, { bars, fetchedAt: Date.now() });
      if (barCache.size > 90) {
        const oldest = barCache.keys().next().value;
        if (oldest) barCache.delete(oldest);
      }
      return bars;
    } catch (err) {
      console.warn(`[insights:dislocation] bars ${yahooSym} (${tf}) failed:`, (err as Error).message);
      const fallback = barCache.get(cacheKey);
      return fallback?.bars ?? [];
    } finally {
      clearTimeout(timer);
      barInflight.delete(cacheKey);
    }
  })();

  barInflight.set(cacheKey, task);
  return task;
}

// ── Math Utilities (Stationary Return OLS + Adjusted R², Correlation, ATR) ──

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stdDev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const m = avg ?? mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (arr.length - 1));
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 6) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom > 1e-12 ? Math.max(-1, Math.min(1, num / denom)) : 0;
}

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = r;
      }
    }
    if (maxVal < 1e-12) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return M.map((row) => row[n]);
}

function computeAtr(bars: OhlcBar[], period = 14): number {
  if (bars.length < 2) return 0;
  const start = Math.max(1, bars.length - period);
  let trSum = 0;
  let count = 0;
  for (let i = start; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trSum += tr;
    count += 1;
  }
  return count > 0 ? trSum / count : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function roundTo(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function priceDecimals(shortName: string, price: number): number {
  const s = shortName.toUpperCase();
  if (s.endsWith('JPY')) return 3;
  if (
    s.length === 6 &&
    /^[A-Z]{6}$/.test(s) &&
    !s.startsWith('XAU') &&
    !s.startsWith('XAG') &&
    !s.startsWith('BTC') &&
    !s.startsWith('ETH')
  ) {
    return 5;
  }
  if (price >= 10) return 2;
  return 4;
}

function alignSeriesToTimestamps(
  targetTs: number[],
  driverBars: OhlcBar[],
  maxStaleSec: number
): (number | null)[] {
  if (driverBars.length === 0) return targetTs.map(() => null);
  const out: (number | null)[] = new Array(targetTs.length).fill(null);
  let j = 0;

  for (let i = 0; i < targetTs.length; i++) {
    const t = targetTs[i];
    while (j + 1 < driverBars.length && driverBars[j + 1].ts <= t) {
      j += 1;
    }
    if (driverBars[j].ts <= t && t - driverBars[j].ts <= maxStaleSec) {
      out[i] = driverBars[j].close;
    } else if (j === 0 && driverBars[0].ts > t && driverBars[0].ts - t <= maxStaleSec) {
      out[i] = driverBars[0].close;
    }
  }
  return out;
}

function computeBestLeadLag(
  targetReturns: number[],
  driverReturns: number[]
): { bestLag: number; bestCorr: number; zeroCorr: number } {
  const n = Math.min(targetReturns.length, driverReturns.length);
  if (n < 14) return { bestLag: 0, bestCorr: 0, zeroCorr: 0 };

  const zeroCorr = pearson(driverReturns.slice(0, n), targetReturns.slice(0, n));
  let bestLag = 0;
  let bestCorr = zeroCorr;

  for (const lag of [1, 2, 3]) {
    if (n - lag < 12) continue;
    const dSlice = driverReturns.slice(0, n - lag);
    const tSlice = targetReturns.slice(lag, n);
    const c = pearson(dSlice, tSlice);
    if (Math.abs(c) > Math.abs(bestCorr) + 0.06) {
      bestLag = lag;
      bestCorr = c;
    }
  }

  return { bestLag, bestCorr, zeroCorr };
}

// ── Ultra-Strict 4-Gate Session & Major-Swing SMT Engine ─────────────────────

interface RefPool {
  kind: SmtSignal['levelKind'];
  label: string;
  side: 'high' | 'low';
  level: number;
  endTs: number;
}

function utcDayFloor(tsSec: number): number {
  return Math.floor(tsSec / 86_400) * 86_400;
}

function extractReferencePools(bars: OhlcBar[]): RefPool[] {
  if (bars.length < 20) return [];
  const lastBar = bars[bars.length - 1];
  const latestDay = utcDayFloor(lastBar.ts);
  const pools: RefPool[] = [];

  const dayGroups = new Map<number, OhlcBar[]>();
  for (const b of bars) {
    const d = utcDayFloor(b.ts);
    const list = dayGroups.get(d);
    if (list) list.push(b);
    else dayGroups.set(d, [b]);
  }
  const priorDays = Array.from(dayGroups.keys())
    .filter((d) => d < latestDay && (dayGroups.get(d)?.length ?? 0) >= 3)
    .sort((a, b) => b - a);

  if (priorDays.length > 0) {
    const pdBars = dayGroups.get(priorDays[0])!;
    let pdh = -Infinity;
    let pdl = Infinity;
    for (const b of pdBars) {
      if (b.high > pdh) pdh = b.high;
      if (b.low < pdl) pdl = b.low;
    }
    const endTs = pdBars[pdBars.length - 1].ts;
    pools.push(
      { kind: 'pdh', label: "Yesterday's High", side: 'high', level: pdh, endTs },
      { kind: 'pdl', label: "Yesterday's Low", side: 'low', level: pdl, endTs }
    );
  }

  // Asia Session (00:00–07:59 UTC)
  const latestUtcHour = Math.floor((lastBar.ts % 86_400) / 3600);
  const asiaDay = latestUtcHour >= 8 ? latestDay : (priorDays[0] ?? latestDay - 86_400);
  const asiaBars = bars.filter((b) => {
    const d = utcDayFloor(b.ts);
    const h = Math.floor((b.ts % 86_400) / 3600);
    return d === asiaDay && h >= 0 && h < 8;
  });
  if (asiaBars.length >= 2) {
    const endTs = asiaBars[asiaBars.length - 1].ts;
    if (lastBar.ts > endTs) {
      pools.push(
        {
          kind: 'asia_high',
          label: 'Asia High',
          side: 'high',
          level: Math.max(...asiaBars.map((b) => b.high)),
          endTs
        },
        {
          kind: 'asia_low',
          label: 'Asia Low',
          side: 'low',
          level: Math.min(...asiaBars.map((b) => b.low)),
          endTs
        }
      );
    }
  }

  // London Session (07:00–13:59 UTC)
  const londonDay = latestUtcHour >= 13 ? latestDay : (priorDays[0] ?? latestDay - 86_400);
  const londonBars = bars.filter((b) => {
    const d = utcDayFloor(b.ts);
    const h = Math.floor((b.ts % 86_400) / 3600);
    return d === londonDay && h >= 7 && h < 14;
  });
  if (londonBars.length >= 2) {
    const endTs = londonBars[londonBars.length - 1].ts;
    if (lastBar.ts > endTs) {
      pools.push(
        {
          kind: 'london_high',
          label: 'London High',
          side: 'high',
          level: Math.max(...londonBars.map((b) => b.high)),
          endTs
        },
        {
          kind: 'london_low',
          label: 'London Low',
          side: 'low',
          level: Math.min(...londonBars.map((b) => b.low)),
          endTs
        }
      );
    }
  }

  // Major 5-bar Swing High & Swing Low (strictly 5 bars higher/lower on BOTH sides)
  const swingRadius = 5;
  const lookbackStart = Math.max(swingRadius, bars.length - 64);
  const lookbackEnd = bars.length - swingRadius - 3;
  let lastSwingHigh: OhlcBar | null = null;
  let lastSwingLow: OhlcBar | null = null;
  for (let i = lookbackStart; i <= lookbackEnd; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= swingRadius; k++) {
      if (bars[i].high < bars[i - k].high || bars[i].high < bars[i + k].high) isH = false;
      if (bars[i].low > bars[i - k].low || bars[i].low > bars[i + k].low) isL = false;
    }
    if (isH) lastSwingHigh = bars[i];
    if (isL) lastSwingLow = bars[i];
  }
  if (lastSwingHigh) {
    pools.push({
      kind: 'swing_high',
      label: 'Major Swing High',
      side: 'high',
      level: lastSwingHigh.high,
      endTs: lastSwingHigh.ts
    });
  }
  if (lastSwingLow) {
    pools.push({
      kind: 'swing_low',
      label: 'Major Swing Low',
      side: 'low',
      level: lastSwingLow.low,
      endTs: lastSwingLow.ts
    });
  }

  return pools;
}

function mirrorPoolKind(kind: SmtSignal['levelKind']): SmtSignal['levelKind'] {
  switch (kind) {
    case 'asia_high':
      return 'asia_low';
    case 'asia_low':
      return 'asia_high';
    case 'london_high':
      return 'london_low';
    case 'london_low':
      return 'london_high';
    case 'pdh':
      return 'pdl';
    case 'pdl':
      return 'pdh';
    case 'swing_high':
      return 'swing_low';
    case 'swing_low':
      return 'swing_high';
  }
}

/**
 * Ultra-Strict 4-Gate SMT Divergence Detection:
 * 1. Fresh Sweep Only: Pool must have been unswept until the last 2 bars.
 * 2. ATR-Scaled Separation: Sweeper breaks by >= 0.10 ATR; peer fails by >= 0.40 peer ATR.
 * 3. Rejection Close: Latest close is back inside the swept level (liquidity trap, not breakout).
 * 4. Active Proximity: Price is still within 1.2 ATR of the swept level.
 */
function detectSmtForPeer(
  targetShort: string,
  targetBars: OhlcBar[],
  targetScaleRatio: number,
  peerSpec: PeerSpec,
  peerBars: OhlcBar[],
  peerScaleRatio: number,
  stepSec: number
): { signals: SmtSignal[]; poolWatches: SessionPoolWatch[] } {
  const signals: SmtSignal[] = [];
  const poolWatches: SessionPoolWatch[] = [];
  if (targetBars.length < 30 || peerBars.length < 30) {
    return { signals, poolWatches };
  }

  const tAtrRaw = computeAtr(targetBars, 14);
  const pAtrRaw = computeAtr(peerBars, 14);
  if (tAtrRaw <= 0 || pAtrRaw <= 0) {
    return { signals, poolWatches };
  }

  const targetPools = extractReferencePools(targetBars);
  const peerPools = extractReferencePools(peerBars);
  const peerByKind = new Map(peerPools.map((p) => [p.kind, p]));

  const lastTargetBar = targetBars[targetBars.length - 1];
  const recentCutoffTs = targetBars[Math.max(0, targetBars.length - 3)].ts; // last 2 bars only
  const nowSec = Math.floor(Date.now() / 1000);
  const tDec = priceDecimals(targetShort, lastTargetBar.close * targetScaleRatio);
  const pDec = priceDecimals(
    peerSpec.shortName,
    peerBars[peerBars.length - 1].close * peerScaleRatio
  );

  for (const tPool of targetPools) {
    const peerKind = peerSpec.relation === 'positive' ? tPool.kind : mirrorPoolKind(tPool.kind);
    const pPool = peerByKind.get(peerKind);
    if (!pPool) continue;

    const tAfter = targetBars.filter((b) => b.ts > tPool.endTs);
    const pAfter = peerBars.filter((b) => b.ts > pPool.endTs);
    if (tAfter.length === 0 || pAfter.length === 0) continue;

    // Overall swept status for the Pool Monitor display
    const tOverallEx =
      tPool.side === 'high'
        ? Math.max(...tAfter.map((b) => b.high))
        : Math.min(...tAfter.map((b) => b.low));
    const pOverallEx =
      pPool.side === 'high'
        ? Math.max(...pAfter.map((b) => b.high))
        : Math.min(...pAfter.map((b) => b.low));
    const tAnySwept =
      tPool.side === 'high'
        ? tOverallEx > tPool.level + 0.08 * tAtrRaw
        : tOverallEx < tPool.level - 0.08 * tAtrRaw;
    const pAnySwept =
      pPool.side === 'high'
        ? pOverallEx > pPool.level + 0.08 * pAtrRaw
        : pOverallEx < pPool.level - 0.08 * pAtrRaw;

    // Gate 1: Must NOT have been swept earlier before the last 2 bars
    const tEarly = tAfter.filter((b) => b.ts <= recentCutoffTs);
    const pEarly = pAfter.filter((b) => b.ts <= recentCutoffTs);
    const tEarlySwept = tEarly.some((b) =>
      tPool.side === 'high'
        ? b.high > tPool.level + 0.08 * tAtrRaw
        : b.low < tPool.level - 0.08 * tAtrRaw
    );
    const pEarlySwept = pEarly.some((b) =>
      pPool.side === 'high'
        ? b.high > pPool.level + 0.08 * pAtrRaw
        : b.low < pPool.level - 0.08 * pAtrRaw
    );

    let smtState: 'none' | 'bullish' | 'bearish' = 'none';

    if (!tEarlySwept && !pEarlySwept) {
      const tRec = tAfter.filter((b) => b.ts > recentCutoffTs);
      const pRec = pAfter.filter((b) => b.ts > recentCutoffTs);
      if (tRec.length > 0 && pRec.length > 0) {
        const tEx =
          tPool.side === 'high'
            ? Math.max(...tRec.map((b) => b.high))
            : Math.min(...tRec.map((b) => b.low));
        const pEx =
          pPool.side === 'high'
            ? Math.max(...pRec.map((b) => b.high))
            : Math.min(...pRec.map((b) => b.low));

        const tBreachAtr =
          tPool.side === 'high' ? (tEx - tPool.level) / tAtrRaw : (tPool.level - tEx) / tAtrRaw;
        const pBreachAtr =
          pPool.side === 'high' ? (pEx - pPool.level) / pAtrRaw : (pPool.level - pEx) / pAtrRaw;

        // Gate 2: Sweeper clears level by >= 0.10 ATR; non-sweeper stays >= 0.40 ATR shy
        const tSw = tBreachAtr >= 0.1;
        const pSw = pBreachAtr >= 0.1;

        if (tSw !== pSw) {
          const sweptBy: 'target' | 'peer' = tSw ? 'target' : 'peer';
          const missAtr = sweptBy === 'target' ? -pBreachAtr : -tBreachAtr;
          const distFromLvlAtr = Math.abs(lastTargetBar.close - tPool.level) / tAtrRaw;

          // Gate 3 & 4: Still within 1.2 ATR of level + closed back inside the swept level
          const direction: SmDirection = tPool.side === 'high' ? 'bearish' : 'bullish';
          const closedInside =
            direction === 'bearish'
              ? lastTargetBar.close < tPool.level
              : lastTargetBar.close > tPool.level;

          if (missAtr >= 0.4 && distFromLvlAtr <= 1.2 && closedInside) {
            smtState = direction;

            const sweepBars = sweptBy === 'target' ? tRec : pRec;
            const refLevel = sweptBy === 'target' ? tPool.level : pPool.level;
            const refSide = sweptBy === 'target' ? tPool.side : pPool.side;
            const refAtr = sweptBy === 'target' ? tAtrRaw : pAtrRaw;
            let sweepTs = sweepBars[sweepBars.length - 1].ts;
            for (let i = sweepBars.length - 1; i >= 0; i--) {
              const hit =
                refSide === 'high'
                  ? sweepBars[i].high > refLevel + 0.1 * refAtr
                  : sweepBars[i].low < refLevel - 0.1 * refAtr;
              if (hit) {
                sweepTs = sweepBars[i].ts;
                break;
              }
            }

            const ageSec = Math.max(60, nowSec - sweepTs);
            const minutesAgo = Math.round(ageSec / 60);
            const freshness: SmtSignal['freshness'] = ageSec <= stepSec * 1.5 ? 'fresh' : 'recent';

            const scaledTargetLevel = roundTo(tPool.level * targetScaleRatio, tDec);
            const scaledTargetExtreme = roundTo(tEx * targetScaleRatio, tDec);
            const scaledPeerLevel = roundTo(pPool.level * peerScaleRatio, pDec);
            const scaledPeerExtreme = roundTo(pEx * peerScaleRatio, pDec);

            const peerGapPct =
              sweptBy === 'target'
                ? (Math.abs(pPool.level - pEx) / pPool.level) * 100
                : (Math.abs(tPool.level - tEx) / tPool.level) * 100;

            const sweepAction =
              tPool.side === 'high' ? 'poked above and rejected' : 'dipped below and reclaimed';
            const peerRef = pPool.label.toLowerCase();
            const targetRef = tPool.label.toLowerCase();
            const peerSweepVerb = pPool.side === 'high' ? 'broke above' : 'broke below';

            const summary =
              sweptBy === 'target'
                ? `${targetShort} ${sweepAction} ${targetRef} (${scaledTargetLevel}), while ${peerSpec.shortName} stayed far from its ${peerRef} (${missAtr.toFixed(1)}× avg move away).`
                : `${peerSpec.shortName} ${peerSweepVerb} its ${peerRef}, while ${targetShort} held firmly inside ${targetRef} (${missAtr.toFixed(1)}× avg move away).`;

            signals.push({
              id: `smt-${tPool.kind}-${peerSpec.shortName}`,
              direction,
              levelKind: tPool.kind,
              levelLabel: tPool.label,
              peerSymbol: peerSpec.symbol,
              peerShortName: peerSpec.shortName,
              relation: peerSpec.relation,
              sweptBy,
              targetLevel: scaledTargetLevel,
              targetExtreme: scaledTargetExtreme,
              peerLevel: scaledPeerLevel,
              peerExtreme: scaledPeerExtreme,
              peerGapAtr: roundTo(missAtr, 2),
              peerGapPct: roundTo(peerGapPct, 2),
              minutesAgo,
              freshness,
              summary
            });
          }
        }
      }
    }

    if (
      tPool.kind === 'asia_high' ||
      tPool.kind === 'asia_low' ||
      tPool.kind === 'london_high' ||
      tPool.kind === 'london_low' ||
      tPool.kind === 'pdh' ||
      tPool.kind === 'pdl'
    ) {
      const scaledLvl = roundTo(tPool.level * targetScaleRatio, tDec);
      const scaledSpot = lastTargetBar.close * targetScaleRatio;
      const distPct = scaledSpot > 0 ? ((scaledLvl - scaledSpot) / scaledSpot) * 100 : 0;
      poolWatches.push({
        id: `${tPool.kind}-${peerSpec.shortName}`,
        label: tPool.label,
        side: tPool.side,
        targetLevel: scaledLvl,
        distancePct: roundTo(distPct, 2),
        targetSwept: tAnySwept,
        peerShortName: peerSpec.shortName,
        peerSwept: pAnySwept,
        smtState
      });
    }
  }

  return { signals, poolWatches };
}

// ── Core Dislocation Computation (Stationary Return OLS) ─────────────────────

async function computeDislocationForSpec(
  spec: SymbolModelSpec,
  tf: DislocationTimeframe,
  force = false
): Promise<DislocationPayload> {
  const stepSec = stepSecondsForTf(tf);
  const uniqueShortNames = new Set<string>([spec.shortName]);
  const quoteSymbols = new Set<string>([spec.canonical]);

  for (const d of spec.drivers) {
    uniqueShortNames.add(d.shortName);
    quoteSymbols.add(d.symbol);
  }
  for (const p of spec.peers) {
    uniqueShortNames.add(p.shortName);
    quoteSymbols.add(p.symbol);
  }

  const shortList = Array.from(uniqueShortNames);
  const [quotesRes, ...barArrays] = await Promise.all([
    getQuotesPayload(Array.from(quoteSymbols)),
    ...shortList.map((s) => fetchYahooSeries(s, tf, force))
  ]);

  const barsByShort = new Map<string, OhlcBar[]>();
  for (let i = 0; i < shortList.length; i++) {
    barsByShort.set(shortList[i], barArrays[i]);
  }

  const targetBars = barsByShort.get(spec.shortName) ?? [];
  const targetQuote: MarketQuote | undefined = quotesRes.quotes[spec.canonical];

  const lastBar = targetBars.length > 0 ? targetBars[targetBars.length - 1] : null;
  const lastBarClose = lastBar?.close ?? 0;
  const spotPrice = targetQuote?.price && targetQuote.price > 0 ? targetQuote.price : lastBarClose;
  const targetScaleRatio = lastBarClose > 0 && spotPrice > 0 ? spotPrice / lastBarClose : 1;
  const decimals = priceDecimals(spec.shortName, spotPrice || 100);

  const rawAtr = computeAtr(targetBars, 14) * targetScaleRatio;
  const atr = roundTo(rawAtr, decimals);
  const atrPct = spotPrice > 0 ? roundTo((rawAtr / spotPrice) * 100, 2) : 0;

  // Stationary Return Regression Window: 72 bars (~3 days on 1H); Horizon H = 8 bars
  const HORIZON = 8;
  const WINDOW = Math.min(72, targetBars.length);
  const slice = targetBars.slice(targetBars.length - WINDOW);
  const targetTs = slice.map((b) => b.ts);
  const yCloses = slice.map((b) => b.close);

  let zScore = 0;
  let adjRSquared = 0;
  let gapPct = 0;
  let fairValuePrice = spotPrice;
  const residualSeries: ResidualPoint[] = [];
  const driversOut: DriverContribution[] = [];
  let bestLeadLag: LeadLagReadout | null = null;

  if (slice.length >= 24 && yCloses[0] > 0) {
    // Bar-to-bar stationary log returns (length = N - 1)
    const nBars = slice.length;
    const nRet = nBars - 1;
    const yRet: number[] = [];
    for (let i = 1; i < nBars; i++) {
      yRet.push(Math.log(yCloses[i] / yCloses[i - 1]));
    }

    const maxStaleSec = Math.max(stepSec * 4, 14_400);
    interface ActiveDriverData {
      spec: DriverSpec;
      closes: number[];
      xRet: number[];
      meanRet: number;
      stdRet: number;
      windowChangePct: number;
      price: number | null;
      corr: number;
      lagBars: number;
      lagCorr: number;
    }

    const activeDrivers: ActiveDriverData[] = [];
    const inactiveDrivers: DriverContribution[] = [];

    for (const d of spec.drivers) {
      const dBars = barsByShort.get(d.shortName) ?? [];
      const dQuote = quotesRes.quotes[d.symbol];
      const aligned = alignSeriesToTimestamps(targetTs, dBars, maxStaleSec);
      const validCount = aligned.filter((v) => v !== null).length;

      let firstValid: number | null = null;
      for (const v of aligned) {
        if (v !== null && v > 0) {
          firstValid = v;
          break;
        }
      }

      if (validCount < Math.floor(nBars * 0.7) || firstValid === null) {
        inactiveDrivers.push({
          symbol: d.symbol,
          shortName: d.shortName,
          price: dQuote?.price ?? (dBars.length > 0 ? dBars[dBars.length - 1].close : null),
          windowChangePct: 0,
          beta: 0,
          correlation: 0,
          weightPct: 0,
          pull: 'flat',
          lagBars: 0,
          lagCorrelation: 0,
          active: false
        });
        continue;
      }

      const filled: number[] = [];
      let lastSeen = firstValid;
      for (const v of aligned) {
        if (v !== null && v > 0) lastSeen = v;
        filled.push(lastSeen);
      }

      const xRet: number[] = [];
      for (let i = 1; i < nBars; i++) {
        xRet.push(Math.log(filled[i] / filled[i - 1]));
      }
      const mRet = mean(xRet);
      const sRet = stdDev(xRet, mRet);
      const hStart = Math.max(0, nBars - 1 - HORIZON);
      const recentChgPct = ((filled[nBars - 1] - filled[hStart]) / filled[hStart]) * 100;

      // Drop flat/closed drivers (e.g. DXY during crypto weekend)
      if (sRet < 1e-5) {
        inactiveDrivers.push({
          symbol: d.symbol,
          shortName: d.shortName,
          price: dQuote?.price ?? filled[nBars - 1],
          windowChangePct: roundTo(recentChgPct, 2),
          beta: 0,
          correlation: 0,
          weightPct: 0,
          pull: 'flat',
          lagBars: 0,
          lagCorrelation: 0,
          active: false
        });
        continue;
      }

      const corr = pearson(xRet, yRet);
      const ll = computeBestLeadLag(yRet, xRet);

      activeDrivers.push({
        spec: d,
        closes: filled,
        xRet,
        meanRet: mRet,
        stdRet: sRet,
        windowChangePct: roundTo(recentChgPct, 2),
        price: dQuote?.price ?? filled[nBars - 1],
        corr,
        lagBars: ll.bestLag,
        lagCorr: ll.bestCorr
      });
    }

    if (activeDrivers.length > 0) {
      const m = activeDrivers.length;
      const dim = m + 1;
      const XtX: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
      const Xty: number[] = new Array(dim).fill(0);

      // Fit stationary bar-to-bar return OLS with mild ridge penalty
      for (let t = 0; t < nRet; t++) {
        const row = [1];
        for (let k = 0; k < m; k++) {
          row.push((activeDrivers[k].xRet[t] - activeDrivers[k].meanRet) / activeDrivers[k].stdRet);
        }
        for (let r = 0; r < dim; r++) {
          Xty[r] += row[r] * yRet[t];
          for (let c = 0; c < dim; c++) {
            XtX[r][c] += row[r] * row[c];
          }
        }
      }

      const ridge = 0.02 * nRet;
      for (let k = 1; k < dim; k++) {
        XtX[k][k] += ridge;
      }

      const coeffs = solveLinearSystem(XtX, Xty);
      if (coeffs) {
        const intercept = coeffs[0];
        const stdBetas = coeffs.slice(1);
        const rawBetas = stdBetas.map((b, k) => b / activeDrivers[k].stdRet);

        // Honest Adjusted Return R² (never spurious level R²!)
        const yMean = mean(yRet);
        let ssTot = 0;
        let ssRes = 0;
        for (let t = 0; t < nRet; t++) {
          let pred = intercept;
          for (let k = 0; k < m; k++) {
            const zX =
              (activeDrivers[k].xRet[t] - activeDrivers[k].meanRet) / activeDrivers[k].stdRet;
            pred += stdBetas[k] * zX;
          }
          const dy = yRet[t] - yMean;
          const e = yRet[t] - pred;
          ssTot += dy * dy;
          ssRes += e * e;
        }
        const rawR2 = ssTot > 1e-12 ? clamp(1 - ssRes / ssTot, 0, 0.99) : 0;
        adjRSquared =
          nRet > m + 1
            ? clamp(1 - (1 - rawR2) * ((nRet - 1) / (nRet - m - 1)), 0, 0.99)
            : rawR2;

        // Compute stationary H-bar return prediction errors across the window
        const hErrors: { idx: number; err: number }[] = [];
        for (let i = HORIZON; i < nBars; i++) {
          const actualH = Math.log(yCloses[i] / yCloses[i - HORIZON]);
          let impliedH = 0;
          for (let k = 0; k < m; k++) {
            const drvH = Math.log(
              activeDrivers[k].closes[i] / activeDrivers[k].closes[i - HORIZON]
            );
            impliedH += rawBetas[k] * drvH;
          }
          hErrors.push({ idx: i, err: actualH - impliedH });
        }

        if (hErrors.length >= 8) {
          const errVals = hErrors.map((e) => e.err);
          const errMean = mean(errVals);
          const errStd = Math.max(stdDev(errVals, errMean), 1e-6);
          const latestErr = errVals[errVals.length - 1];

          zScore = clamp((latestErr - errMean) / errStd, -4.5, 4.5);
          const impliedRatio = Math.exp(latestErr);
          fairValuePrice = spotPrice > 0 ? spotPrice / impliedRatio : spotPrice;
          gapPct = (impliedRatio - 1) * 100;

          // Build trailing 36-point stretch history
          const startPlot = Math.max(0, hErrors.length - 36);
          for (let j = startPlot; j < hErrors.length; j++) {
            const pt = hErrors[j];
            const zt = clamp((pt.err - errMean) / errStd, -4.5, 4.5);
            const barSpot = yCloses[pt.idx] * targetScaleRatio;
            const barFair = barSpot / Math.exp(pt.err);
            residualSeries.push({
              ts: targetTs[pt.idx],
              z: roundTo(zt, 2),
              spot: roundTo(barSpot, decimals),
              fair: roundTo(barFair, decimals)
            });
          }
        }

        // Factor weights & lead-lag summary
        const absSum = stdBetas.reduce((acc, b) => acc + Math.abs(b), 0) || 1;
        for (let k = 0; k < m; k++) {
          const ad = activeDrivers[k];
          const weightPct = Math.round((Math.abs(stdBetas[k]) / absSum) * 100);
          const look = Math.max(0, ad.closes.length - 1 - HORIZON);
          const recentDx = Math.log(ad.closes[ad.closes.length - 1] / ad.closes[look]);
          const pullVal = rawBetas[k] * recentDx;
          const pull: 'up' | 'down' | 'flat' =
            pullVal > 0.0006 ? 'up' : pullVal < -0.0006 ? 'down' : 'flat';

          driversOut.push({
            symbol: ad.spec.symbol,
            shortName: ad.spec.shortName,
            price: ad.price,
            windowChangePct: ad.windowChangePct,
            beta: roundTo(rawBetas[k], 2),
            correlation: roundTo(ad.corr, 2),
            weightPct,
            pull,
            lagBars: ad.lagBars,
            lagCorrelation: roundTo(ad.lagCorr, 2),
            active: true
          });

          if (
            ad.lagBars > 0 &&
            Math.abs(ad.lagCorr) >= 0.35 &&
            (!bestLeadLag || Math.abs(ad.lagCorr) > Math.abs(bestLeadLag.correlation))
          ) {
            const lagMinutes = Math.round((ad.lagBars * stepSec) / 60);
            const rel: 'positive' | 'inverse' = ad.lagCorr >= 0 ? 'positive' : 'inverse';
            const lagLabel =
              lagMinutes >= 60 ? `${roundTo(lagMinutes / 60, 1)}h` : `${lagMinutes}m`;
            bestLeadLag = {
              leaderShortName: ad.spec.shortName,
              leaderSymbol: ad.spec.symbol,
              lagBars: ad.lagBars,
              lagMinutes,
              correlation: roundTo(ad.lagCorr, 2),
              relation: rel,
              summary: `${ad.spec.shortName} tends to move ~${lagLabel} ahead of ${spec.shortName} (${rel === 'positive' ? 'same direction' : 'opposite direction'})`
            };
          }
        }
      }
    }

    for (const d of inactiveDrivers) driversOut.push(d);
    driversOut.sort((a, b) => Number(b.active) - Number(a.active) || b.weightPct - a.weightPct);
  }

  // ── Ultra-Strict SMT Detection across Peers ────────────────────────────────
  const allSmtSignals: SmtSignal[] = [];
  let primaryPoolWatches: SessionPoolWatch[] = [];

  for (let i = 0; i < spec.peers.length; i++) {
    const peer = spec.peers[i];
    const pBars = barsByShort.get(peer.shortName) ?? [];
    const pQuote = quotesRes.quotes[peer.symbol];
    const pLastClose = pBars.length > 0 ? pBars[pBars.length - 1].close : 0;
    const pSpot = pQuote?.price && pQuote.price > 0 ? pQuote.price : pLastClose;
    const pScale = pLastClose > 0 && pSpot > 0 ? pSpot / pLastClose : 1;

    const { signals, poolWatches } = detectSmtForPeer(
      spec.shortName,
      targetBars,
      targetScaleRatio,
      peer,
      pBars,
      pScale,
      stepSec
    );
    allSmtSignals.push(...signals);
    if (i === 0) {
      primaryPoolWatches = poolWatches;
    }
  }

  allSmtSignals.sort((a, b) => a.minutesAgo - b.minutesAgo || b.peerGapAtr - a.peerGapAtr);

  // ── Explicit Tie-Breaking, Plain-English Verdict & Transparent 0–100 Score ─
  const bearSmts = allSmtSignals.filter((s) => s.direction === 'bearish');
  const bullSmts = allSmtSignals.filter((s) => s.direction === 'bullish');
  const hasBearSmt = bearSmts.length > 0;
  const hasBullSmt = bullSmts.length > 0;
  const smtConflict = hasBearSmt && hasBullSmt;

  const roundedSpot = roundTo(spotPrice, decimals);
  const roundedFair = roundTo(fairValuePrice, decimals);
  const gapPoints = roundTo(roundedSpot - roundedFair, decimals);
  const roundedZ = roundTo(zScore, 2);
  const roundedR2 = roundTo(adjRSquared, 2);
  const roundedGapPct = roundTo(gapPct, 2);
  const fitPct = Math.round(roundedR2 * 100);
  const driverFitLabel: 'Strong' | 'Moderate' | 'Weak' =
    roundedR2 >= 0.55 ? 'Strong' : roundedR2 >= 0.3 ? 'Moderate' : 'Weak';

  const reversingCandle = Boolean(
    lastBar &&
      ((roundedZ >= 1.5 && lastBar.close < lastBar.open) ||
        (roundedZ <= -1.5 && lastBar.close > lastBar.open))
  );

  let verdict: VerdictKind = 'equilibrium';
  let verdictLabel = 'In Line';
  let verdictDetail = `${spec.shortName} is moving in step with its related markets right now.`;
  let verdictReason = 'Price is within its normal range vs. drivers and no clean peer divergence is active.';

  if (smtConflict) {
    verdict = 'mixed';
    verdictLabel = 'Mixed Signals';
    verdictDetail = `Opposing peer divergences are active on both highs and lows — choppy range, wait for a clean break.`;
    verdictReason = `Headline set to Mixed because both a bullish sweep (${bullSmts[0].levelLabel}) and a bearish sweep (${bearSmts[0].levelLabel}) are active at once.`;
  } else if (driverFitLabel === 'Weak' && !hasBearSmt && !hasBullSmt) {
    verdict = 'weak_fit';
    verdictLabel = 'Weak Driver Fit';
    verdictDetail = `Related markets only explain ${fitPct}% of recent ${spec.shortName} bar moves — ignore the expected price gap.`;
    verdictReason = `Driver fit is below 30% (${fitPct}%), so stretch readings are muted until correlation returns.`;
  } else if (driverFitLabel !== 'Weak' && roundedZ >= 1.6 && hasBearSmt) {
    verdict = 'bearish_trap';
    verdictLabel = 'Stretched High + Bearish Sweep';
    verdictDetail = `${spec.shortName} is ${Math.abs(roundedZ).toFixed(1)}× above normal vs. drivers (expected ${roundedFair}) and just failed a high sweep against ${bearSmts[0].peerShortName}.`;
    verdictReason = 'Both price stretch above drivers and a fresh bearish peer divergence point lower.';
  } else if (driverFitLabel !== 'Weak' && roundedZ <= -1.6 && hasBullSmt) {
    verdict = 'bullish_spring';
    verdictLabel = 'Lagging Low + Bullish Sweep';
    verdictDetail = `${spec.shortName} is ${Math.abs(roundedZ).toFixed(1)}× below normal vs. drivers (expected ${roundedFair}) and just reclaimed a low sweep against ${bullSmts[0].peerShortName}.`;
    verdictReason = 'Both price lag below drivers and a fresh bullish peer divergence point higher.';
  } else if (driverFitLabel !== 'Weak' && roundedZ >= 2.0) {
    verdict = 'rich';
    verdictLabel = reversingCandle ? 'Stretched High · Turning' : 'Stretched High';
    verdictDetail = reversingCandle
      ? `${spec.shortName} ran ${Math.abs(roundedZ).toFixed(1)}× above its drivers (expected ${roundedFair}) and the latest candle is turning down.`
      : `${spec.shortName} ran ${Math.abs(roundedZ).toFixed(1)}× above its drivers (expected ${roundedFair}) — wait for a red reversal candle before fading.`;
    verdictReason = `Driven by a ≥2.0× stretch above expected price with ${driverFitLabel.toLowerCase()} driver fit (${fitPct}%).`;
  } else if (driverFitLabel !== 'Weak' && roundedZ <= -2.0) {
    verdict = 'cheap';
    verdictLabel = reversingCandle ? 'Lagging Behind · Turning' : 'Lagging Behind';
    verdictDetail = reversingCandle
      ? `${spec.shortName} sits ${Math.abs(roundedZ).toFixed(1)}× behind its drivers (expected ${roundedFair}) and the latest candle is turning up.`
      : `${spec.shortName} sits ${Math.abs(roundedZ).toFixed(1)}× behind its drivers (expected ${roundedFair}) — wait for a green reversal candle before buying.`;
    verdictReason = `Driven by a ≥2.0× lag below expected price with ${driverFitLabel.toLowerCase()} driver fit (${fitPct}%).`;
  } else if (hasBearSmt) {
    verdict = 'bearish_smt';
    verdictLabel = 'Bearish Peer Divergence';
    verdictDetail = bearSmts[0].summary;
    verdictReason = `Fresh bearish peer divergence on ${bearSmts[0].levelLabel} vs ${bearSmts[0].peerShortName} (no conflicting bullish divergence).`;
  } else if (hasBullSmt) {
    verdict = 'bullish_smt';
    verdictLabel = 'Bullish Peer Divergence';
    verdictDetail = bullSmts[0].summary;
    verdictReason = `Fresh bullish peer divergence on ${bullSmts[0].levelLabel} vs ${bullSmts[0].peerShortName} (no conflicting bearish divergence).`;
  } else if (driverFitLabel !== 'Weak' && roundedZ >= 1.4) {
    verdict = 'rich';
    verdictLabel = 'Slightly High';
    verdictDetail = `Trading ${Math.abs(roundedZ).toFixed(1)}× above expected price (${roundedFair}) — watch for exhaustion if it pushes higher.`;
    verdictReason = `Mild stretch (+${Math.abs(roundedZ).toFixed(1)}×) with ${driverFitLabel.toLowerCase()} driver fit (${fitPct}%).`;
  } else if (driverFitLabel !== 'Weak' && roundedZ <= -1.4) {
    verdict = 'cheap';
    verdictLabel = 'Slightly Lagging';
    verdictDetail = `Trading ${Math.abs(roundedZ).toFixed(1)}× below expected price (${roundedFair}) — related markets lean stronger.`;
    verdictReason = `Mild lag (-${Math.abs(roundedZ).toFixed(1)}×) with ${driverFitLabel.toLowerCase()} driver fit (${fitPct}%).`;
  }

  // Transparent 0–100 Setup Strength formula:
  //   Stretch (0–45) + Driver Fit (0–25) + Clean Peer Divergence (0–30) - Conflict Penalty (0 or 20)
  //   Stretch points are halved if Driver Fit is Weak (<30%).
  const fitMultiplier = driverFitLabel === 'Weak' ? 0.35 : 1.0;
  const stretchPts = Math.round(Math.min(45, Math.abs(roundedZ) * 18) * fitMultiplier);
  const fitPts = Math.round(Math.min(25, roundedR2 * 30));
  const smtDirectionAligned =
    !smtConflict &&
    ((hasBearSmt && roundedZ >= 0.5) || (hasBullSmt && roundedZ <= -0.5));
  const smtPts = smtConflict
    ? 0
    : hasBearSmt || hasBullSmt
      ? smtDirectionAligned
        ? 30
        : 20
      : 0;
  const conflictPenalty = smtConflict ? 20 : 0;
  const convictionScore = Math.round(
    clamp(stretchPts + fitPts + smtPts - conflictPenalty, 0, 100)
  );

  const scoreBreakdown: ScoreBreakdown = {
    stretchPts,
    maxStretchPts: 45,
    fitPts,
    maxFitPts: 25,
    smtPts,
    maxSmtPts: 30,
    conflictPenalty,
    total: convictionScore,
    explanation:
      conflictPenalty > 0
        ? `Stretch ${stretchPts}/45 + Driver Fit ${fitPts}/25 − Conflict ${conflictPenalty}`
        : `Stretch ${stretchPts}/45 + Driver Fit ${fitPts}/25 + Divergence ${smtPts}/30`
  };

  return {
    symbol: spec.canonical,
    shortName: spec.shortName,
    timeframe: tf,
    spotPrice: roundedSpot,
    fairValuePrice: roundedFair,
    gapPoints,
    gapPct: roundedGapPct,
    zScore: roundedZ,
    rSquared: roundedR2,
    driverFitLabel,
    atr,
    atrPct,
    windowBars: slice.length,
    horizonBars: HORIZON,
    reversingCandle,
    verdict,
    verdictLabel,
    verdictDetail,
    verdictReason,
    convictionScore,
    scoreBreakdown,
    drivers: driversOut,
    leadLag: bestLeadLag,
    smtSignals: allSmtSignals.slice(0, 6),
    sessionPools: primaryPoolWatches,
    residualSeries,
    updatedAt: new Date().toISOString()
  };
}

export async function getDislocationPayload(
  rawSymbol: string,
  tfParam?: string | null,
  force = false
): Promise<DislocationPayload> {
  const tf = parseTimeframe(tfParam);
  const spec = resolveModelSpec(rawSymbol || 'OANDA:XAUUSD');
  const cacheKey = `${spec.shortName}|${tf}`;
  const now = Date.now();

  if (!force) {
    const cached = payloadCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < PAYLOAD_CACHE_TTL_MS) {
      return { ...cached.data, symbol: spec.canonical };
    }
  }

  const data = await computeDislocationForSpec(spec, tf, force);
  payloadCache.set(cacheKey, { data, fetchedAt: Date.now() });
  if (payloadCache.size > 60) {
    const oldest = payloadCache.keys().next().value;
    if (oldest) payloadCache.delete(oldest);
  }
  return data;
}

export async function getDislocationScanPayload(
  tfParam?: string | null,
  force = false
): Promise<DislocationScanPayload> {
  const tf = parseTimeframe(tfParam);
  const now = Date.now();

  if (!force) {
    const cached = scanCache.get(tf);
    if (cached && now - cached.fetchedAt < SCAN_CACHE_TTL_MS) {
      return cached.data;
    }
    const existing = scanInflight.get(tf);
    if (existing) return existing;
  }

  const task = (async (): Promise<DislocationScanPayload> => {
    const results: DislocationPayload[] = [];
    const batchSize = 4;
    for (let i = 0; i < SCAN_UNIVERSE.length; i += batchSize) {
      const slice = SCAN_UNIVERSE.slice(i, i + batchSize);
      const batch = await Promise.all(
        slice.map((sym) => getDislocationPayload(sym, tf, force).catch(() => null))
      );
      for (const item of batch) {
        if (item && item.spotPrice > 0) results.push(item);
      }
    }

    const rows: DislocationScanRow[] = results
      .map((r) => {
        const topSmt = r.smtSignals[0] ?? null;
        const smtConflict =
          r.smtSignals.some((s) => s.direction === 'bullish') &&
          r.smtSignals.some((s) => s.direction === 'bearish');
        const topDriver = r.drivers.find((d) => d.active) ?? null;
        return {
          symbol: r.symbol,
          shortName: r.shortName,
          spotPrice: r.spotPrice,
          fairValuePrice: r.fairValuePrice,
          gapPct: r.gapPct,
          zScore: r.zScore,
          rSquared: r.rSquared,
          driverFitLabel: r.driverFitLabel,
          atr: r.atr,
          verdict: r.verdict,
          verdictLabel: r.verdictLabel,
          convictionScore: r.convictionScore,
          topSmtLabel: topSmt ? `${topSmt.levelLabel} vs ${topSmt.peerShortName}` : null,
          topSmtDirection: topSmt ? topSmt.direction : null,
          topSmtMinutesAgo: topSmt ? topSmt.minutesAgo : null,
          smtConflict,
          topDriverLabel: topDriver ? `${topDriver.shortName} (${topDriver.weightPct}%)` : null
        };
      })
      .sort(
        (a, b) => b.convictionScore - a.convictionScore || Math.abs(b.zScore) - Math.abs(a.zScore)
      );

    const payload: DislocationScanPayload = {
      timeframe: tf,
      rows,
      updatedAt: new Date().toISOString()
    };
    scanCache.set(tf, { data: payload, fetchedAt: Date.now() });
    return payload;
  })().finally(() => {
    scanInflight.delete(tf);
  });

  scanInflight.set(tf, task);
  return task;
}
