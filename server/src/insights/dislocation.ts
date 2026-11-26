import { getQuotesPayload, type MarketQuote } from '../quotes/service.js';
import { normalizeShortSymbol } from './macro.js';

export type DislocationTimeframe = '15m' | '1h' | '4h';
export type SmDirection = 'bullish' | 'bearish';
export type VerdictKind =
  | 'bearish_trap'
  | 'bullish_spring'
  | 'bearish_smt'
  | 'bullish_smt'
  | 'rich'
  | 'cheap'
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
  beta: number; // log-return elasticity in OLS model
  correlation: number; // Pearson r over window
  weightPct: number; // share of explained variance (0..100)
  pull: 'up' | 'down' | 'flat';
  lagBars: number; // >0 means driver leads target by lagBars bars
  lagCorrelation: number;
  active: boolean;
}

export interface SmtSignal {
  id: string;
  direction: SmDirection;
  levelKind: 'asia_high' | 'asia_low' | 'london_high' | 'london_low' | 'pdh' | 'pdl' | 'swing_high' | 'swing_low';
  levelLabel: string;
  peerSymbol: string;
  peerShortName: string;
  relation: 'positive' | 'inverse';
  sweptBy: 'target' | 'peer';
  targetLevel: number;
  targetExtreme: number;
  peerLevel: number;
  peerExtreme: number;
  peerGapPct: number; // positive distance by which confirmation failed
  minutesAgo: number;
  freshness: 'fresh' | 'recent' | 'active';
  summary: string;
}

export interface SessionPoolWatch {
  id: string;
  label: string;
  side: 'high' | 'low';
  targetLevel: number;
  distancePct: number; // (level - spot) / spot * 100
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
  z: number;
  spot: number;
  fair: number;
}

export interface DislocationPayload {
  symbol: string;
  shortName: string;
  timeframe: DislocationTimeframe;
  spotPrice: number;
  fairValuePrice: number;
  gapPoints: number;
  gapPct: number;
  zScore: number;
  rSquared: number;
  atr: number;
  atrPct: number;
  windowBars: number;
  verdict: VerdictKind;
  verdictLabel: string;
  verdictDetail: string;
  convictionScore: number; // 0..100
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
  atr: number;
  verdict: VerdictKind;
  verdictLabel: string;
  convictionScore: number;
  topSmtLabel: string | null;
  topSmtDirection: SmDirection | null;
  topSmtMinutesAgo: number | null;
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
    peers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' },
      { symbol: 'OANDA:EURJPY', shortName: 'EURJPY', relation: 'positive' }
    ]
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
    peers: [
      { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' },
      { symbol: 'TVC:USOIL', shortName: 'USOIL', relation: 'inverse' }
    ]
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
    peers: [
      { symbol: 'OANDA:EURJPY', shortName: 'EURJPY', relation: 'positive' },
      { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', relation: 'positive' }
    ]
  },
  EURJPY: {
    drivers: [
      { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', expectedSign: 1 },
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'OANDA:GBPJPY', shortName: 'GBPJPY', relation: 'positive' },
      { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', relation: 'positive' }
    ]
  },
  EURGBP: {
    drivers: [
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', expectedSign: -1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'positive' },
      { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', relation: 'inverse' }
    ]
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
    peers: [
      { symbol: 'TVC:UKOIL', shortName: 'UKOIL', relation: 'positive' },
      { symbol: 'OANDA:USDCAD', shortName: 'USDCAD', relation: 'inverse' }
    ]
  },
  UKOIL: {
    drivers: [
      { symbol: 'TVC:USOIL', shortName: 'USOIL', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 }
    ],
    peers: [
      { symbol: 'TVC:USOIL', shortName: 'USOIL', relation: 'positive' },
      { symbol: 'OANDA:USDCAD', shortName: 'USDCAD', relation: 'inverse' }
    ]
  },
  BTCUSD: {
    drivers: [
      { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', expectedSign: 1 },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', relation: 'positive' },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', relation: 'positive' }
    ]
  },
  ETHUSD: {
    drivers: [
      { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', expectedSign: 1 },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', relation: 'positive' },
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', relation: 'positive' }
    ]
  }
};

function resolveModelSpec(rawSymbol: string): SymbolModelSpec {
  const short = normalizeShortSymbol(rawSymbol);
  const canonical = rawSymbol.includes(':') ? rawSymbol.trim().toUpperCase() : (CANONICAL_MAP[short] ?? short);

  if (MODEL_SPECS[short]) {
    return { canonical, shortName: short, ...MODEL_SPECS[short] };
  }

  // Fallback inference by asset class (equities, crypto altcoins, minor FX)
  if (short.endsWith('USD') && short.length === 6 && !short.startsWith('X')) {
    return {
      canonical,
      shortName: short,
      drivers: [
        { symbol: 'TVC:DXY', shortName: 'DXY', expectedSign: -1 },
        { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', expectedSign: 1 },
        { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
      ],
      peers: [
        { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', relation: 'positive' },
        { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'inverse' }
      ]
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
      peers: [
        { symbol: 'TVC:DXY', shortName: 'DXY', relation: 'positive' },
        { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', relation: 'positive' }
      ]
    };
  }
  if (short.endsWith('USDT') || short.endsWith('USD') && short.length >= 6) {
    return {
      canonical,
      shortName: short,
      drivers: [
        { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', expectedSign: 1 },
        { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', expectedSign: 1 },
        { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 }
      ],
      peers: [
        { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', relation: 'positive' },
        { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', relation: 'positive' }
      ]
    };
  }

  // Default: US equities / indices
  return {
    canonical,
    shortName: short,
    drivers: [
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', expectedSign: 1 },
      { symbol: 'TVC:SPX', shortName: 'SPX', expectedSign: 1 },
      { symbol: 'TVC:US10Y', shortName: 'US10Y', expectedSign: -1 }
    ],
    peers: [
      { symbol: 'NASDAQ:NDX', shortName: 'NAS100', relation: 'positive' },
      { symbol: 'TVC:SPX', shortName: 'SPX', relation: 'positive' }
    ]
  };
}

// ── Cached Yahoo OHLC Fetcher (deduplicated across concurrent symbol/scan calls) ──

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

async function fetchYahooSeries(shortName: string, tf: DislocationTimeframe, force = false): Promise<OhlcBar[]> {
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

// ── Math Utilities (OLS with Ridge Stabilization, Correlation, ATR) ──────────

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
  if (n < 4) return 0;
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

/** Solves linear system A * x = b via Gaussian elimination with partial pivoting. */
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
  if (s.length === 6 && /^[A-Z]{6}$/.test(s) && !s.startsWith('XAU') && !s.startsWith('XAG') && !s.startsWith('BTC') && !s.startsWith('ETH')) {
    return 5;
  }
  if (price >= 1000) return 2;
  if (price >= 10) return 2;
  return 4;
}

/**
 * Aligns a driver's close series onto the target timestamps using nearest-prior bar
 * within maxStaleSec (gracefully bridging short session gaps while rejecting dead data).
 */
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
  if (n < 12) return { bestLag: 0, bestCorr: 0, zeroCorr: 0 };

  const zeroCorr = pearson(driverReturns.slice(0, n), targetReturns.slice(0, n));
  let bestLag = 0;
  let bestCorr = zeroCorr;

  // lag k > 0 checks corr(driver[t - k], target[t]) -> driver leads target by k bars
  for (const lag of [1, 2, 3]) {
    if (n - lag < 10) continue;
    const dSlice = driverReturns.slice(0, n - lag);
    const tSlice = targetReturns.slice(lag, n);
    const c = pearson(dSlice, tSlice);
    if (Math.abs(c) > Math.abs(bestCorr) + 0.04) {
      bestLag = lag;
      bestCorr = c;
    }
  }

  return { bestLag, bestCorr, zeroCorr };
}

// ── Session & Structural Pivot SMT Detection ─────────────────────────────────

interface RefPool {
  kind: SmtSignal['levelKind'];
  label: string;
  side: 'high' | 'low';
  level: number;
  startTs: number;
  endTs: number;
}

function utcDayFloor(tsSec: number): number {
  return Math.floor(tsSec / 86_400) * 86_400;
}

function extractReferencePools(bars: OhlcBar[]): RefPool[] {
  if (bars.length < 12) return [];
  const lastBar = bars[bars.length - 1];
  const latestDay = utcDayFloor(lastBar.ts);
  const pools: RefPool[] = [];

  // 1. Prior Trading Day High / Low (most recent UTC day strictly before latestDay with >= 4 bars)
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
      { kind: 'pdh', label: 'Prior Day High', side: 'high', level: pdh, startTs: pdBars[0].ts, endTs },
      { kind: 'pdl', label: 'Prior Day Low', side: 'low', level: pdl, startTs: pdBars[0].ts, endTs }
    );
  }

  // 2. Asia Session (00:00–07:59 UTC) — use today's completed Asia if current UTC hour >= 8, else previous day's
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
      let hi = -Infinity;
      let lo = Infinity;
      for (const b of asiaBars) {
        if (b.high > hi) hi = b.high;
        if (b.low < lo) lo = b.low;
      }
      pools.push(
        { kind: 'asia_high', label: 'Asia High', side: 'high', level: hi, startTs: asiaBars[0].ts, endTs },
        { kind: 'asia_low', label: 'Asia Low', side: 'low', level: lo, startTs: asiaBars[0].ts, endTs }
      );
    }
  }

  // 3. London Session (07:00–13:59 UTC) — use today's if current UTC hour >= 13, else prior day's
  const londonDay = latestUtcHour >= 13 ? latestDay : (priorDays[0] ?? latestDay - 86_400);
  const londonBars = bars.filter((b) => {
    const d = utcDayFloor(b.ts);
    const h = Math.floor((b.ts % 86_400) / 3600);
    return d === londonDay && h >= 7 && h < 14;
  });
  if (londonBars.length >= 2) {
    const endTs = londonBars[londonBars.length - 1].ts;
    if (lastBar.ts > endTs) {
      let hi = -Infinity;
      let lo = Infinity;
      for (const b of londonBars) {
        if (b.high > hi) hi = b.high;
        if (b.low < lo) lo = b.low;
      }
      pools.push(
        { kind: 'london_high', label: 'London High', side: 'high', level: hi, startTs: londonBars[0].ts, endTs },
        { kind: 'london_low', label: 'London Low', side: 'low', level: lo, startTs: londonBars[0].ts, endTs }
      );
    }
  }

  // 4. Recent Structural Swing High & Low (confirmed 2-bar left/right fractal strictly before last 4 bars)
  const lookbackStart = Math.max(2, bars.length - 48);
  const lookbackEnd = bars.length - 5;
  let lastSwingHigh: OhlcBar | null = null;
  let lastSwingLow: OhlcBar | null = null;
  for (let i = lookbackStart; i <= lookbackEnd; i++) {
    const cur = bars[i];
    if (
      cur.high >= bars[i - 1].high &&
      cur.high >= bars[i - 2].high &&
      cur.high >= bars[i + 1].high &&
      cur.high >= bars[i + 2].high
    ) {
      lastSwingHigh = cur;
    }
    if (
      cur.low <= bars[i - 1].low &&
      cur.low <= bars[i - 2].low &&
      cur.low <= bars[i + 1].low &&
      cur.low <= bars[i + 2].low
    ) {
      lastSwingLow = cur;
    }
  }
  if (lastSwingHigh) {
    pools.push({
      kind: 'swing_high',
      label: 'Swing High',
      side: 'high',
      level: lastSwingHigh.high,
      startTs: lastSwingHigh.ts,
      endTs: lastSwingHigh.ts
    });
  }
  if (lastSwingLow) {
    pools.push({
      kind: 'swing_low',
      label: 'Swing Low',
      side: 'low',
      level: lastSwingLow.low,
      startTs: lastSwingLow.ts,
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
  if (targetBars.length < 15 || peerBars.length < 15) {
    return { signals, poolWatches };
  }

  const targetPools = extractReferencePools(targetBars);
  const peerPools = extractReferencePools(peerBars);
  const peerByKind = new Map(peerPools.map((p) => [p.kind, p]));

  const lastTargetBar = targetBars[targetBars.length - 1];
  const nowSec = Math.floor(Date.now() / 1000);
  const recentWindowSec = Math.max(stepSec * 6, 3600 * 3);
  const tDec = priceDecimals(targetShort, lastTargetBar.close * targetScaleRatio);
  const pDec = priceDecimals(peerSpec.shortName, peerBars[peerBars.length - 1].close * peerScaleRatio);

  for (const tPool of targetPools) {
    const peerKind = peerSpec.relation === 'positive' ? tPool.kind : mirrorPoolKind(tPool.kind);
    const pPool = peerByKind.get(peerKind);
    if (!pPool) continue;

    // Inspect bars strictly after the reference pool completed
    const tAfter = targetBars.filter((b) => b.ts > tPool.endTs);
    const pAfter = peerBars.filter((b) => b.ts > pPool.endTs);
    if (tAfter.length === 0 || pAfter.length === 0) continue;

    const tExtreme =
      tPool.side === 'high'
        ? Math.max(...tAfter.map((b) => b.high))
        : Math.min(...tAfter.map((b) => b.low));
    const pExtreme =
      pPool.side === 'high'
        ? Math.max(...pAfter.map((b) => b.high))
        : Math.min(...pAfter.map((b) => b.low));

    // Require clear structural breach (>= 0.02%) to avoid single-tick noise
    const breachTol = 0.0002;
    const tSwept =
      tPool.side === 'high'
        ? tExtreme > tPool.level * (1 + breachTol)
        : tExtreme < tPool.level * (1 - breachTol);
    const pSwept =
      pPool.side === 'high'
        ? pExtreme > pPool.level * (1 + breachTol)
        : pExtreme < pPool.level * (1 - breachTol);

    // Distance by which the non-sweeping instrument failed to reach its pool
    const pMissPct =
      pPool.side === 'high'
        ? ((pPool.level - pExtreme) / pPool.level) * 100
        : ((pExtreme - pPool.level) / pPool.level) * 100;
    const tMissPct =
      tPool.side === 'high'
        ? ((tPool.level - tExtreme) / tPool.level) * 100
        : ((tExtreme - tPool.level) / tPool.level) * 100;

    let smtState: 'none' | 'bullish' | 'bearish' = 'none';

    if (tSwept !== pSwept) {
      const sweptBy: 'target' | 'peer' = tSwept ? 'target' : 'peer';
      const missPct = sweptBy === 'target' ? pMissPct : tMissPct;

      // Only report meaningful divergence where the confirming peer stayed clearly off the level (>= 0.03%)
      if (missPct >= 0.03) {
        const direction: SmDirection = tPool.side === 'high' ? 'bearish' : 'bullish';
        smtState = direction;

        // Find timestamp of the sweep bar on whichever asset swept
        const sweepBars = sweptBy === 'target' ? tAfter : pAfter;
        const refLevel = sweptBy === 'target' ? tPool.level : pPool.level;
        const refSide = sweptBy === 'target' ? tPool.side : pPool.side;
        let sweepTs = sweepBars[sweepBars.length - 1].ts;
        for (let i = sweepBars.length - 1; i >= 0; i--) {
          const hit =
            refSide === 'high'
              ? sweepBars[i].high > refLevel * (1 + breachTol)
              : sweepBars[i].low < refLevel * (1 - breachTol);
          if (hit) {
            sweepTs = sweepBars[i].ts;
            break;
          }
        }

        const ageSec = Math.max(60, nowSec - sweepTs);
        const minutesAgo = Math.round(ageSec / 60);
        const freshness: SmtSignal['freshness'] =
          ageSec <= stepSec * 2 ? 'fresh' : ageSec <= recentWindowSec ? 'recent' : 'active';

        const scaledTargetLevel = roundTo(tPool.level * targetScaleRatio, tDec);
        const scaledTargetExtreme = roundTo(tExtreme * targetScaleRatio, tDec);
        const scaledPeerLevel = roundTo(pPool.level * peerScaleRatio, pDec);
        const scaledPeerExtreme = roundTo(pExtreme * peerScaleRatio, pDec);

        const targetVerb = tPool.side === 'high' ? 'swept above' : 'swept below';
        const peerHoldVerb =
          pPool.side === 'high'
            ? `held ${missPct.toFixed(2)}% below its ${pPool.label}`
            : `held ${missPct.toFixed(2)}% above its ${pPool.label}`;
        const targetHoldVerb =
          tPool.side === 'high'
            ? `failed ${missPct.toFixed(2)}% below its ${tPool.label}`
            : `held ${missPct.toFixed(2)}% above its ${tPool.label}`;
        const peerSweepVerb = pPool.side === 'high' ? 'swept above' : 'swept below';

        const summary =
          sweptBy === 'target'
            ? `${targetShort} ${targetVerb} ${tPool.label} (${scaledTargetLevel}) while ${peerSpec.shortName} ${peerHoldVerb}.`
            : `${peerSpec.shortName} ${peerSweepVerb} ${pPool.label} while ${targetShort} ${targetHoldVerb}.`;

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
          peerGapPct: roundTo(missPct, 2),
          minutesAgo,
          freshness,
          summary
        });
      }
    }

    // Add primary session/day pools to Watch table (for the primary peer only)
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
        targetSwept: tSwept,
        peerShortName: peerSpec.shortName,
        peerSwept: pSwept,
        smtState
      });
    }
  }

  return { signals, poolWatches };
}

// ── Core Dislocation Computation ─────────────────────────────────────────────

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

  const lastBarClose = targetBars.length > 0 ? targetBars[targetBars.length - 1].close : 0;
  const spotPrice = targetQuote?.price && targetQuote.price > 0 ? targetQuote.price : lastBarClose;
  // Scale factor converts Yahoo proxy (e.g. GC=F) cleanly into live TradingView/OANDA spot price
  const targetScaleRatio = lastBarClose > 0 && spotPrice > 0 ? spotPrice / lastBarClose : 1;
  const decimals = priceDecimals(spec.shortName, spotPrice || 100);

  const rawAtr = computeAtr(targetBars, 14) * targetScaleRatio;
  const atr = roundTo(rawAtr, decimals);
  const atrPct = spotPrice > 0 ? roundTo((rawAtr / spotPrice) * 100, 2) : 0;

  // Regression window: up to 64 bars (minimum 16)
  const WINDOW = Math.min(64, targetBars.length);
  const slice = targetBars.slice(targetBars.length - WINDOW);
  const targetTs = slice.map((b) => b.ts);
  const yCloses = slice.map((b) => b.close);

  let zScore = 0;
  let rSquared = 0;
  let gapPct = 0;
  let fairValuePrice = spotPrice;
  const residualSeries: ResidualPoint[] = [];
  const driversOut: DriverContribution[] = [];
  let bestLeadLag: LeadLagReadout | null = null;

  if (slice.length >= 16 && yCloses[0] > 0) {
    const y0 = yCloses[0];
    const yLog = yCloses.map((c) => Math.log(c / y0));
    const yRet: number[] = [];
    for (let i = 1; i < yLog.length; i++) yRet.push(yLog[i] - yLog[i - 1]);

    // Align each driver and filter out flat/closed-session drivers automatically
    const maxStaleSec = Math.max(stepSec * 4, 14_400);
    interface ActiveDriverData {
      spec: DriverSpec;
      xLog: number[];
      xRet: number[];
      meanX: number;
      stdX: number;
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

      // Forward-fill leading/internal small gaps if >= 75% present
      let firstValid: number | null = null;
      for (const v of aligned) {
        if (v !== null) {
          firstValid = v;
          break;
        }
      }

      if (validCount < Math.floor(slice.length * 0.7) || firstValid === null || firstValid <= 0) {
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

      const x0 = filled[0];
      const xLog = filled.map((c) => Math.log(c / x0));
      const mX = mean(xLog);
      const sX = stdDev(xLog, mX);
      const winChgPct = ((filled[filled.length - 1] - x0) / x0) * 100;

      // Drop completely flat/closed-market drivers (e.g., DXY during crypto weekend)
      if (sX < 1e-5) {
        inactiveDrivers.push({
          symbol: d.symbol,
          shortName: d.shortName,
          price: dQuote?.price ?? filled[filled.length - 1],
          windowChangePct: roundTo(winChgPct, 2),
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

      const xRet: number[] = [];
      for (let i = 1; i < xLog.length; i++) xRet.push(xLog[i] - xLog[i - 1]);
      const corr = pearson(xLog, yLog);
      const ll = computeBestLeadLag(yRet, xRet);

      activeDrivers.push({
        spec: d,
        xLog,
        xRet,
        meanX: mX,
        stdX: sX,
        windowChangePct: roundTo(winChgPct, 2),
        price: dQuote?.price ?? filled[filled.length - 1],
        corr,
        lagBars: ll.bestLag,
        lagCorr: ll.bestCorr
      });
    }

    if (activeDrivers.length > 0) {
      const m = activeDrivers.length;
      const n = slice.length;
      const dim = m + 1; // intercept + m standardized drivers
      const XtX: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
      const Xty: number[] = new Array(dim).fill(0);

      for (let t = 0; t < n; t++) {
        const row = [1];
        for (let k = 0; k < m; k++) {
          row.push((activeDrivers[k].xLog[t] - activeDrivers[k].meanX) / activeDrivers[k].stdX);
        }
        for (let r = 0; r < dim; r++) {
          Xty[r] += row[r] * yLog[t];
          for (let c = 0; c < dim; c++) {
            XtX[r][c] += row[r] * row[c];
          }
        }
      }

      // Mild ridge penalty on slope terms prevents collinear blow-ups (e.g. SPX + NDX together)
      const ridge = 0.08 * n;
      for (let k = 1; k < dim; k++) {
        XtX[k][k] += ridge;
      }

      const coeffs = solveLinearSystem(XtX, Xty);
      if (coeffs) {
        const intercept = coeffs[0];
        const stdBetas = coeffs.slice(1);

        const yHat: number[] = new Array(n).fill(0);
        const residuals: number[] = new Array(n).fill(0);
        for (let t = 0; t < n; t++) {
          let pred = intercept;
          for (let k = 0; k < m; k++) {
            const zX = (activeDrivers[k].xLog[t] - activeDrivers[k].meanX) / activeDrivers[k].stdX;
            pred += stdBetas[k] * zX;
          }
          yHat[t] = pred;
          residuals[t] = yLog[t] - pred;
        }

        const yMean = mean(yLog);
        let ssTot = 0;
        let ssRes = 0;
        for (let t = 0; t < n; t++) {
          const dy = yLog[t] - yMean;
          ssTot += dy * dy;
          ssRes += residuals[t] * residuals[t];
        }
        rSquared = ssTot > 1e-12 ? clamp(1 - ssRes / ssTot, 0, 0.99) : 0;

        const resMean = mean(residuals);
        const resStd = Math.max(stdDev(residuals, resMean), 1e-6);
        const latestRes = residuals[n - 1];
        zScore = clamp((latestRes - resMean) / resStd, -4.5, 4.5);

        // Fair value anchored cleanly to live spotPrice
        const impliedRatio = Math.exp(latestRes);
        fairValuePrice = spotPrice > 0 ? spotPrice / impliedRatio : spotPrice;
        gapPct = (impliedRatio - 1) * 100;

        // Build trailing 36-point Z-score residual series
        const startPlot = Math.max(0, n - 36);
        for (let t = startPlot; t < n; t++) {
          const zt = clamp((residuals[t] - resMean) / resStd, -4.5, 4.5);
          const barSpot = yCloses[t] * targetScaleRatio;
          const barFair = barSpot / Math.exp(residuals[t]);
          residualSeries.push({
            ts: targetTs[t],
            z: roundTo(zt, 2),
            spot: roundTo(barSpot, decimals),
            fair: roundTo(barFair, decimals)
          });
        }

        // Factor weights & lead-lag summary
        const absSum = stdBetas.reduce((acc, b) => acc + Math.abs(b), 0) || 1;
        for (let k = 0; k < m; k++) {
          const ad = activeDrivers[k];
          const rawBeta = stdBetas[k] / ad.stdX;
          const weightPct = Math.round((Math.abs(stdBetas[k]) / absSum) * 100);
          // Recent driver impulse over last 4 bars -> implied pull on target
          const look = Math.max(0, ad.xLog.length - 5);
          const recentDx = ad.xLog[ad.xLog.length - 1] - ad.xLog[look];
          const pullVal = rawBeta * recentDx;
          const pull: 'up' | 'down' | 'flat' =
            pullVal > 0.0005 ? 'up' : pullVal < -0.0005 ? 'down' : 'flat';

          driversOut.push({
            symbol: ad.spec.symbol,
            shortName: ad.spec.shortName,
            price: ad.price,
            windowChangePct: ad.windowChangePct,
            beta: roundTo(rawBeta, 2),
            correlation: roundTo(ad.corr, 2),
            weightPct,
            pull,
            lagBars: ad.lagBars,
            lagCorrelation: roundTo(ad.lagCorr, 2),
            active: true
          });

          // Pick sharpest statistically meaningful lead-lag driver
          if (
            ad.lagBars > 0 &&
            Math.abs(ad.lagCorr) >= 0.35 &&
            (!bestLeadLag || Math.abs(ad.lagCorr) > Math.abs(bestLeadLag.correlation))
          ) {
            const lagMinutes = Math.round((ad.lagBars * stepSec) / 60);
            const rel: 'positive' | 'inverse' = ad.lagCorr >= 0 ? 'positive' : 'inverse';
            const lagLabel =
              lagMinutes >= 60
                ? `${roundTo(lagMinutes / 60, 1)}h`
                : `${lagMinutes}m`;
            bestLeadLag = {
              leaderShortName: ad.spec.shortName,
              leaderSymbol: ad.spec.symbol,
              lagBars: ad.lagBars,
              lagMinutes,
              correlation: roundTo(ad.lagCorr, 2),
              relation: rel,
              summary: `${ad.spec.shortName} leads ${spec.shortName} by ~${lagLabel} (r = ${ad.lagCorr >= 0 ? '+' : ''}${ad.lagCorr.toFixed(2)})`
            };
          }
        }
      }
    }

    for (const d of inactiveDrivers) driversOut.push(d);
    driversOut.sort((a, b) => Number(b.active) - Number(a.active) || b.weightPct - a.weightPct);
  }

  // ── SMT Detection across all Triad Peers ───────────────────────────────────
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

  // Sort SMT signals: fresh first, then smallest minutesAgo, then largest failure gap
  const freshRank: Record<SmtSignal['freshness'], number> = { fresh: 0, recent: 1, active: 2 };
  allSmtSignals.sort(
    (a, b) =>
      freshRank[a.freshness] - freshRank[b.freshness] ||
      a.minutesAgo - b.minutesAgo ||
      b.peerGapPct - a.peerGapPct
  );

  // ── Composite Verdict & Conviction Score ───────────────────────────────────
  const freshBearSmt = allSmtSignals.find((s) => s.direction === 'bearish' && s.freshness !== 'active');
  const freshBullSmt = allSmtSignals.find((s) => s.direction === 'bullish' && s.freshness !== 'active');
  const anyBearSmt = allSmtSignals.find((s) => s.direction === 'bearish');
  const anyBullSmt = allSmtSignals.find((s) => s.direction === 'bullish');

  const absZ = Math.abs(zScore);
  const roundedSpot = roundTo(spotPrice, decimals);
  const roundedFair = roundTo(fairValuePrice, decimals);
  const gapPoints = roundTo(roundedSpot - roundedFair, decimals);
  const roundedZ = roundTo(zScore, 2);
  const roundedR2 = roundTo(rSquared, 2);
  const roundedGapPct = roundTo(gapPct, 2);

  let verdict: VerdictKind = 'equilibrium';
  let verdictLabel = 'Equilibrium';
  let verdictDetail = `Spot tracks intermarket drivers within ±1.2σ (R² ${roundedR2.toFixed(2)}).`;

  if (zScore >= 1.5 && (freshBearSmt || anyBearSmt)) {
    verdict = 'bearish_trap';
    verdictLabel = 'Bearish Trap · Rich';
    verdictDetail = `${spec.shortName} trades +${roundedZ.toFixed(2)}σ above driver fair value (${roundedFair}) with active bearish SMT non-confirmation.`;
  } else if (zScore <= -1.5 && (freshBullSmt || anyBullSmt)) {
    verdict = 'bullish_spring';
    verdictLabel = 'Bullish Spring · Cheap';
    verdictDetail = `${spec.shortName} lags ${roundedZ.toFixed(2)}σ below driver fair value (${roundedFair}) with active bullish SMT stop-sweep.`;
  } else if (zScore >= 2.0 && rSquared >= 0.35) {
    verdict = 'rich';
    verdictLabel = 'Stretched Rich';
    verdictDetail = `Spot is +${roundedZ.toFixed(2)}σ (+${Math.abs(roundedGapPct).toFixed(2)}%) above implied fair value (${roundedFair}); unbacked upside risk.`;
  } else if (zScore <= -2.0 && rSquared >= 0.35) {
    verdict = 'cheap';
    verdictLabel = 'Lagging Cheap';
    verdictDetail = `Spot lags ${roundedZ.toFixed(2)}σ (-${Math.abs(roundedGapPct).toFixed(2)}%) behind implied fair value (${roundedFair}); catch-up bid potential.`;
  } else if (freshBearSmt) {
    verdict = 'bearish_smt';
    verdictLabel = 'Bearish SMT';
    verdictDetail = freshBearSmt.summary;
  } else if (freshBullSmt) {
    verdict = 'bullish_smt';
    verdictLabel = 'Bullish SMT';
    verdictDetail = freshBullSmt.summary;
  } else if (zScore >= 1.35) {
    verdict = 'rich';
    verdictLabel = 'Mildly Rich';
    verdictDetail = `Spot is +${roundedZ.toFixed(2)}σ above model fair value (${roundedFair}); watch for driver catch-up or rejection.`;
  } else if (zScore <= -1.35) {
    verdict = 'cheap';
    verdictLabel = 'Mildly Cheap';
    verdictDetail = `Spot sits ${roundedZ.toFixed(2)}σ below model fair value (${roundedFair}); drivers lean constructive.`;
  }

  // Conviction score (0..100): blends |zScore|, model R², and confirming SMT
  const zComponent = Math.min(52, absZ * 20);
  const r2Component = Math.min(22, rSquared * 26);
  const smtAligned =
    (zScore >= 0.8 && Boolean(anyBearSmt)) ||
    (zScore <= -0.8 && Boolean(anyBullSmt)) ||
    Boolean(freshBearSmt || freshBullSmt);
  const smtComponent = smtAligned ? (freshBearSmt || freshBullSmt ? 26 : 16) : 0;
  const convictionScore = Math.round(clamp(zComponent + r2Component + smtComponent, 0, 100));

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
    atr,
    atrPct,
    windowBars: slice.length,
    verdict,
    verdictLabel,
    verdictDetail,
    convictionScore,
    drivers: driversOut,
    leadLag: bestLeadLag,
    smtSignals: allSmtSignals.slice(0, 8),
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
    // Run in small parallel waves to share cached factor bars (DXY, US10Y, SPX, XAUUSD, etc.)
    const results: DislocationPayload[] = [];
    const batchSize = 4;
    for (let i = 0; i < SCAN_UNIVERSE.length; i += batchSize) {
      const slice = SCAN_UNIVERSE.slice(i, i + batchSize);
      const batch = await Promise.all(
        slice.map((sym) =>
          getDislocationPayload(sym, tf, force).catch(() => null)
        )
      );
      for (const item of batch) {
        if (item && item.spotPrice > 0) results.push(item);
      }
    }

    const rows: DislocationScanRow[] = results
      .map((r) => {
        const topSmt = r.smtSignals[0] ?? null;
        const topDriver = r.drivers.find((d) => d.active) ?? null;
        return {
          symbol: r.symbol,
          shortName: r.shortName,
          spotPrice: r.spotPrice,
          fairValuePrice: r.fairValuePrice,
          gapPct: r.gapPct,
          zScore: r.zScore,
          rSquared: r.rSquared,
          atr: r.atr,
          verdict: r.verdict,
          verdictLabel: r.verdictLabel,
          convictionScore: r.convictionScore,
          topSmtLabel: topSmt ? `${topSmt.levelLabel} vs ${topSmt.peerShortName}` : null,
          topSmtDirection: topSmt ? topSmt.direction : null,
          topSmtMinutesAgo: topSmt ? topSmt.minutesAgo : null,
          topDriverLabel: topDriver ? `${topDriver.shortName} (${topDriver.weightPct}%)` : null
        };
      })
      .sort((a, b) => b.convictionScore - a.convictionScore || Math.abs(b.zScore) - Math.abs(a.zScore));

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
