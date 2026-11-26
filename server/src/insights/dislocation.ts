import { getCalendarEventsPayload } from '../calendar/service.js';
import type { CountryCode, EconomicEvent } from '../calendar/types.js';
import {
  fetchOandaSeries,
  fetchOandaSyntheticDxy,
  isOandaConfigured,
  type OandaGranularity
} from '../quotes/oanda.js';
import { getQuotesPayload, type MarketQuote } from '../quotes/service.js';
import {
  recordSystemAuditCandidate,
  type AuditTrendAlign
} from './auditLog.js';
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
  | 'event_lock'
  | 'equilibrium';

export interface OhlcBar {
  ts: number; // Unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  spread?: number;
}

export interface FeedInfo {
  source: 'oanda' | 'hybrid' | 'yahoo';
  label: string;
  instrument: string | null;
  liveSpreadPx: number | null;
  liveSpreadPct: number | null;
  spreadInAtrPct: number | null;
  wideSpread: boolean;
}

export interface EventRiskInfo {
  status: 'clear' | 'caution' | 'locked';
  headline: string;
  eventTitle: string | null;
  country: string | null;
  minutesUntil: number | null;
}

export interface HtfContextInfo {
  timeframeLabel: '4H' | 'Daily';
  bias: 'bull' | 'bear' | 'range';
  biasLabel: string;
  alignment: 'with_trend' | 'counter_trend' | 'neutral';
  alignmentLabel: string;
  summary: string;
}

export interface DriverLinkInfo {
  status: 'stable' | 'shifting' | 'breaking';
  label: string;
  baselineFitPct: number;
  recentFitPct: number;
  summary: string;
}

export interface CandleConfirmInfo {
  turnConfirmed: boolean;
  label: string;
  volumeRatio: number | null;
  volumeLabel: string;
}

export interface SetupLevelsInfo {
  actionableBias: 'buy_watch' | 'sell_watch' | 'wait';
  expectedTarget: number;
  invalidationLevel: number | null;
  invalidationLabel: string | null;
  distanceInAvgMoves: number;
}

export interface DriverContribution {
  symbol: string;
  shortName: string;
  price: number | null;
  windowChangePct: number;
  beta: number;
  correlation: number;
  weightPct: number;
  pull: 'up' | 'down' | 'flat';
  lagBars: number;
  lagCorrelation: number;
  active: boolean;
  feed: 'oanda' | 'yahoo';
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
  alignedWithHtf: 'with_trend' | 'counter_trend' | 'neutral';
  contextNote: string;
  targetLevel: number;
  targetExtreme: number;
  peerLevel: number;
  peerExtreme: number;
  peerGapAtr: number;
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
  z: number;
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
  alignBonus: number;
  maxAlignBonus: number;
  conflictPenalty: number;
  decouplingPenalty: number;
  counterTrendPenalty: number;
  eventLocked: boolean;
  total: number;
  explanation: string;
}

export interface DislocationPayload {
  symbol: string;
  shortName: string;
  timeframe: DislocationTimeframe;
  feedInfo: FeedInfo;
  eventRisk: EventRiskInfo;
  htfContext: HtfContextInfo;
  driverLink: DriverLinkInfo;
  candleConfirm: CandleConfirmInfo;
  setupLevels: SetupLevelsInfo;
  spotPrice: number;
  fairValuePrice: number;
  gapPoints: number;
  gapPct: number;
  zScore: number;
  rSquared: number;
  driverFitLabel: 'Strong' | 'Moderate' | 'Weak';
  atr: number;
  atrPct: number;
  windowBars: number;
  horizonBars: number;
  reversingCandle: boolean;
  verdict: VerdictKind;
  verdictLabel: string;
  verdictDetail: string;
  verdictReason: string;
  convictionScore: number;
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
  feedSource: 'oanda' | 'hybrid' | 'yahoo';
  spotPrice: number;
  fairValuePrice: number;
  gapPct: number;
  zScore: number;
  rSquared: number;
  driverFitLabel: 'Strong' | 'Moderate' | 'Weak';
  driverLinkStatus: 'stable' | 'shifting' | 'breaking';
  htfBias: 'bull' | 'bear' | 'range';
  htfAlignment: 'with_trend' | 'counter_trend' | 'neutral';
  eventRiskStatus: 'clear' | 'caution' | 'locked';
  eventRiskLabel: string | null;
  turnConfirmed: boolean;
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
  oandaActive: boolean;
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

function sensitiveCountriesFor(shortName: string): CountryCode[] {
  const s = shortName.toUpperCase();
  const out = new Set<CountryCode>();
  if (s.includes('USD') || ['XAUUSD', 'XAGUSD', 'NAS100', 'SPX', 'US30', 'USOIL', 'BTCUSD', 'ETHUSD', 'DXY'].includes(s)) {
    out.add('US');
  }
  if (s.includes('EUR')) {
    out.add('EU');
    out.add('DE');
  }
  if (s.includes('GBP') || s === 'UK100') out.add('GB');
  if (s.includes('JPY')) out.add('JP');
  if (s.includes('AUD')) out.add('AU');
  if (s.includes('CAD')) out.add('CA');
  if (s.includes('NZD')) out.add('NZ');
  if (s.includes('CHF')) out.add('CH');
  if (out.size === 0) out.add('US');
  return Array.from(out);
}

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

// ── Hybrid Market Data Layer (OANDA v20 Primary + Yahoo Macro Fallback) ──────

interface SeriesBundle {
  bars: OhlcBar[];
  source: 'oanda' | 'yahoo';
  instrument: string | null;
  livePrice: number | null;
  liveSpreadPx: number | null;
  liveSpreadPct: number | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const BAR_CACHE_TTL_MS = 55_000;
const PAYLOAD_CACHE_TTL_MS = 40_000;
const SCAN_CACHE_TTL_MS = 65_000;
const CALENDAR_CACHE_TTL_MS = 5 * 60_000;

const yahooBarCache = new Map<string, { bars: OhlcBar[]; fetchedAt: number }>();
const yahooBarInflight = new Map<string, Promise<OhlcBar[]>>();
const payloadCache = new Map<string, { data: DislocationPayload; fetchedAt: number }>();
const scanCache = new Map<string, { data: DislocationScanPayload; fetchedAt: number }>();
const scanInflight = new Map<string, Promise<DislocationScanPayload>>();

let calendarCache: { events: EconomicEvent[]; fetchedAt: number } | null = null;
let calendarInflight: Promise<EconomicEvent[]> | null = null;

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

function oandaPlanForTf(tf: DislocationTimeframe): { gran: OandaGranularity; count: number } {
  if (tf === '15m') return { gran: 'M15', count: 240 };
  if (tf === '4h') return { gran: 'H4', count: 160 };
  return { gran: 'H1', count: 220 };
}

function yahooQueryForTf(tf: DislocationTimeframe | '1d'): { range: string; interval: string } {
  if (tf === '15m') return { range: '5d', interval: '15m' };
  if (tf === '4h') return { range: '3mo', interval: '1h' };
  if (tf === '1d') return { range: '6mo', interval: '1d' };
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
  tf: DislocationTimeframe | '1d',
  force = false
): Promise<OhlcBar[]> {
  const norm = normalizeShortSymbol(shortName);
  const yahooSym = YAHOO_MAP[norm] ?? norm;
  const cacheKey = `${yahooSym}|${tf}`;
  const now = Date.now();

  if (!force) {
    const cached = yahooBarCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < BAR_CACHE_TTL_MS) {
      return cached.bars;
    }
    const existing = yahooBarInflight.get(cacheKey);
    if (existing) return existing;
  }

  const task = (async (): Promise<OhlcBar[]> => {
    const { range, interval } = yahooQueryForTf(tf);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}&includePrePost=true`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 DeplyzeWorkflow/0.1.20' },
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
      yahooBarCache.set(cacheKey, { bars, fetchedAt: Date.now() });
      if (yahooBarCache.size > 100) {
        const oldest = yahooBarCache.keys().next().value;
        if (oldest) yahooBarCache.delete(oldest);
      }
      return bars;
    } catch (err) {
      console.warn(`[insights:dislocation] yahoo ${yahooSym} (${tf}) failed:`, (err as Error).message);
      const fallback = yahooBarCache.get(cacheKey);
      return fallback?.bars ?? [];
    } finally {
      clearTimeout(timer);
      yahooBarInflight.delete(cacheKey);
    }
  })();

  yahooBarInflight.set(cacheKey, task);
  return task;
}

async function fetchHybridSeries(
  shortName: string,
  tf: DislocationTimeframe,
  force = false
): Promise<SeriesBundle> {
  const norm = normalizeShortSymbol(shortName);

  if (isOandaConfigured()) {
    const { gran, count } = oandaPlanForTf(tf);
    if (norm === 'DXY') {
      const synth = await fetchOandaSyntheticDxy(gran, count, force);
      if (synth && synth.bars.length >= 24) {
        return {
          bars: synth.bars,
          source: 'oanda',
          instrument: synth.instrument,
          livePrice: synth.livePrice,
          liveSpreadPx: synth.liveSpreadPx,
          liveSpreadPct: synth.liveSpreadPct
        };
      }
    } else if (norm !== 'US10Y' && norm !== 'VIX') {
      const oanda = await fetchOandaSeries(norm, gran, count, force);
      if (oanda && oanda.bars.length >= 24) {
        return {
          bars: oanda.bars,
          source: 'oanda',
          instrument: oanda.instrument,
          livePrice: oanda.livePrice,
          liveSpreadPx: oanda.liveSpreadPx,
          liveSpreadPct: oanda.liveSpreadPct
        };
      }
    }
  }

  const yahooBars = await fetchYahooSeries(norm, tf, force);
  return {
    bars: yahooBars,
    source: 'yahoo',
    instrument: YAHOO_MAP[norm] ?? norm,
    livePrice: yahooBars.length > 0 ? yahooBars[yahooBars.length - 1].close : null,
    liveSpreadPx: null,
    liveSpreadPct: null
  };
}

async function fetchHigherTfBars(
  shortName: string,
  tf: DislocationTimeframe,
  force = false
): Promise<{ label: '4H' | 'Daily'; bars: OhlcBar[] }> {
  const norm = normalizeShortSymbol(shortName);
  const label: '4H' | 'Daily' = tf === '4h' ? 'Daily' : '4H';
  const oandaGran: OandaGranularity = tf === '4h' ? 'D' : 'H4';
  const count = 90;

  if (isOandaConfigured()) {
    if (norm === 'DXY') {
      const synth = await fetchOandaSyntheticDxy(oandaGran, count, force);
      if (synth && synth.bars.length >= 40) return { label, bars: synth.bars };
    } else if (norm !== 'US10Y' && norm !== 'VIX') {
      const oanda = await fetchOandaSeries(norm, oandaGran, count, force);
      if (oanda && oanda.bars.length >= 40) return { label, bars: oanda.bars };
    }
  }

  const fallbackBars = await fetchYahooSeries(norm, tf === '4h' ? '1d' : '4h', force);
  return { label, bars: fallbackBars };
}

// ── Live Macro Event Risk Lock (Wired to App Economic Calendar) ──────────────

async function getUpcomingHighImpactEvents(): Promise<EconomicEvent[]> {
  const now = Date.now();
  if (calendarCache && now - calendarCache.fetchedAt < CALENDAR_CACHE_TTL_MS) {
    return calendarCache.events;
  }
  if (calendarInflight) return calendarInflight;

  calendarInflight = (async (): Promise<EconomicEvent[]> => {
    try {
      const todayUtc = new Date().toISOString().slice(0, 10);
      const tomorrowUtc = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const [d0, d1] = await Promise.all([
        getCalendarEventsPayload(todayUtc, 'economic', 'UTC').catch(() => null),
        getCalendarEventsPayload(tomorrowUtc, 'economic', 'UTC').catch(() => null)
      ]);
      const combined = [...(d0?.events ?? []), ...(d1?.events ?? [])].filter(
        (e) => e.impact === 'high'
      );
      const dedup = new Map<string, EconomicEvent>();
      for (const e of combined) dedup.set(e.id, e);
      const events = Array.from(dedup.values()).sort((a, b) => a.ts - b.ts);
      calendarCache = { events, fetchedAt: Date.now() };
      return events;
    } catch {
      return calendarCache?.events ?? [];
    } finally {
      calendarInflight = null;
    }
  })();

  return calendarInflight;
}

function evaluateEventRisk(shortName: string, highEvents: EconomicEvent[]): EventRiskInfo {
  const countries = new Set(sensitiveCountriesFor(shortName));
  const nowSec = Math.floor(Date.now() / 1000);

  let lockedEv: { ev: EconomicEvent; diffMin: number } | null = null;
  let cautionEv: { ev: EconomicEvent; diffMin: number } | null = null;

  for (const ev of highEvents) {
    if (!countries.has(ev.country)) continue;
    const diffMin = Math.round((ev.ts - nowSec) / 60);
    // Lock window: 30m before release through 35m after release
    if (diffMin >= -30 && diffMin <= 35) {
      if (!lockedEv || Math.abs(diffMin) < Math.abs(lockedEv.diffMin)) {
        lockedEv = { ev, diffMin };
      }
    } else if (diffMin > 35 && diffMin <= 120) {
      if (!cautionEv || diffMin < cautionEv.diffMin) {
        cautionEv = { ev, diffMin };
      }
    }
  }

  if (lockedEv) {
    const m = lockedEv.diffMin;
    const timing = m > 0 ? `in ${m}m` : m === 0 ? 'now' : `${Math.abs(m)}m ago`;
    return {
      status: 'locked',
      headline: `Event Risk Lock: ${lockedEv.ev.country} ${lockedEv.ev.title} (${timing}) — move may be fundamental repricing, avoid fading.`,
      eventTitle: lockedEv.ev.title,
      country: lockedEv.ev.country,
      minutesUntil: m
    };
  }

  if (cautionEv) {
    const h = Math.floor(cautionEv.diffMin / 60);
    const rem = cautionEv.diffMin % 60;
    const timing = h > 0 ? `${h}h ${rem}m` : `${rem}m`;
    return {
      status: 'caution',
      headline: `High-impact ${cautionEv.ev.country} release in ${timing}: ${cautionEv.ev.title}.`,
      eventTitle: cautionEv.ev.title,
      country: cautionEv.ev.country,
      minutesUntil: cautionEv.diffMin
    };
  }

  return {
    status: 'clear',
    headline: 'No high-impact economic releases in the next 2 hours.',
    eventTitle: null,
    country: null,
    minutesUntil: null
  };
}

// ── Math Utilities (Stationary Return OLS + Adjusted R², EMA, ATR) ───────────

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

function computeEma(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeHtfBias(bars: OhlcBar[]): 'bull' | 'bear' | 'range' {
  if (bars.length < 52) return 'range';
  const closes = bars.map((b) => b.close);
  const ema20 = computeEma(closes, 20);
  const ema50 = computeEma(closes, 50);
  const lastIdx = closes.length - 1;
  const c = closes[lastIdx];
  const e20 = ema20[lastIdx];
  const e50 = ema50[lastIdx];
  const e20Prev = ema20[Math.max(0, lastIdx - 4)];
  if (!Number.isFinite(e20) || !Number.isFinite(e50)) return 'range';

  const rising = Number.isFinite(e20Prev) && e20 > e20Prev;
  const falling = Number.isFinite(e20Prev) && e20 < e20Prev;

  if (c > e20 && e20 > e50) return 'bull';
  if (c < e20 && e20 < e50) return 'bear';
  if (c > e50 && e20 > e50 && rising) return 'bull';
  if (c < e50 && e20 < e50 && falling) return 'bear';
  return 'range';
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

/** Fit stationary return OLS with mild ridge penalty and return Adjusted Return R². */
function fitStationaryReturnOls(
  yRet: number[],
  xRets: number[][]
): { intercept: number; stdBetas: number[]; rawBetas: number[]; adjR2: number } | null {
  const nRet = yRet.length;
  const m = xRets.length;
  if (nRet < 10 || m === 0) return null;

  const means = xRets.map((arr) => mean(arr));
  const stds = xRets.map((arr, k) => stdDev(arr, means[k]));
  if (stds.some((s) => s < 1e-6)) return null;

  const dim = m + 1;
  const XtX: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const Xty: number[] = new Array(dim).fill(0);

  for (let t = 0; t < nRet; t++) {
    const row = [1];
    for (let k = 0; k < m; k++) {
      row.push((xRets[k][t] - means[k]) / stds[k]);
    }
    for (let r = 0; r < dim; r++) {
      Xty[r] += row[r] * yRet[t];
      for (let c = 0; c < dim; c++) {
        XtX[r][c] += row[r] * row[c];
      }
    }
  }

  const ridge = 0.02 * nRet;
  for (let k = 1; k < dim; k++) XtX[k][k] += ridge;

  const coeffs = solveLinearSystem(XtX, Xty);
  if (!coeffs) return null;

  const intercept = coeffs[0];
  const stdBetas = coeffs.slice(1);
  const rawBetas = stdBetas.map((b, k) => b / stds[k]);

  const yMean = mean(yRet);
  let ssTot = 0;
  let ssRes = 0;
  for (let t = 0; t < nRet; t++) {
    let pred = intercept;
    for (let k = 0; k < m; k++) {
      pred += stdBetas[k] * ((xRets[k][t] - means[k]) / stds[k]);
    }
    const dy = yRet[t] - yMean;
    const e = yRet[t] - pred;
    ssTot += dy * dy;
    ssRes += e * e;
  }
  const rawR2 = ssTot > 1e-12 ? clamp(1 - ssRes / ssTot, 0, 0.99) : 0;
  const adjR2 =
    nRet > m + 1 ? clamp(1 - (1 - rawR2) * ((nRet - 1) / (nRet - m - 1)), 0, 0.99) : rawR2;

  return { intercept, stdBetas, rawBetas, adjR2 };
}

// ── Strict 4-Gate Session & Major-Swing SMT Engine (OANDA Wick Parity) ───────

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

  // Major 5-bar Swing High & Swing Low
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

function detectSmtForPeer(
  targetShort: string,
  targetBars: OhlcBar[],
  targetScaleRatio: number,
  peerSpec: PeerSpec,
  peerBars: OhlcBar[],
  peerScaleRatio: number,
  stepSec: number,
  htfBias: 'bull' | 'bear' | 'range',
  htfLabel: '4H' | 'Daily'
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

    // Gate 1: Untouched prior to the last 2 bars
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

        const tSw = tBreachAtr >= 0.1;
        const pSw = pBreachAtr >= 0.1;

        if (tSw !== pSw) {
          const sweptBy: 'target' | 'peer' = tSw ? 'target' : 'peer';
          const missAtr = sweptBy === 'target' ? -pBreachAtr : -tBreachAtr;
          const distFromLvlAtr = Math.abs(lastTargetBar.close - tPool.level) / tAtrRaw;

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

            const alignedWithHtf: SmtSignal['alignedWithHtf'] =
              htfBias === 'range'
                ? 'neutral'
                : (direction === 'bullish' && htfBias === 'bull') ||
                    (direction === 'bearish' && htfBias === 'bear')
                  ? 'with_trend'
                  : 'counter_trend';

            const contextNote =
              alignedWithHtf === 'with_trend'
                ? `Aligned with ${htfLabel} trend (pullback sweep)`
                : alignedWithHtf === 'counter_trend'
                  ? `Against ${htfLabel} trend — wait for structure break before fading`
                  : `${htfLabel} range — watch for follow-through`;

            const sweepAction =
              tPool.side === 'high' ? 'poked above and rejected' : 'dipped below and reclaimed';
            const peerRef = pPool.label.toLowerCase();
            const targetRef = tPool.label.toLowerCase();
            const peerSweepVerb = pPool.side === 'high' ? 'broke above' : 'broke below';

            const summary =
              sweptBy === 'target'
                ? `${targetShort} ${sweepAction} ${targetRef} (${scaledTargetLevel}), while ${peerSpec.shortName} stayed ${missAtr.toFixed(1)}× avg move away from its ${peerRef}.`
                : `${peerSpec.shortName} ${peerSweepVerb} its ${peerRef}, while ${targetShort} held ${missAtr.toFixed(1)}× avg move inside ${targetRef}.`;

            signals.push({
              id: `smt-${tPool.kind}-${peerSpec.shortName}`,
              direction,
              levelKind: tPool.kind,
              levelLabel: tPool.label,
              peerSymbol: peerSpec.symbol,
              peerShortName: peerSpec.shortName,
              relation: peerSpec.relation,
              sweptBy,
              alignedWithHtf,
              contextNote,
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

// ── Core Institutional Intermarket Computation ───────────────────────────────

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

  // Fetch OANDA/hybrid candles in gentle parallel waves + quotes + HTF bars + live calendar events
  const [quotesRes, htfBundle, highEvents] = await Promise.all([
    getQuotesPayload(Array.from(quoteSymbols)),
    fetchHigherTfBars(spec.shortName, tf, force),
    getUpcomingHighImpactEvents()
  ]);

  const seriesByShort = new Map<string, SeriesBundle>();
  for (let i = 0; i < shortList.length; i += 4) {
    const batch = shortList.slice(i, i + 4);
    const res = await Promise.all(batch.map((s) => fetchHybridSeries(s, tf, force)));
    batch.forEach((s, idx) => seriesByShort.set(s, res[idx]));
  }

  const targetSeries = seriesByShort.get(spec.shortName)!;
  const targetBars = targetSeries?.bars ?? [];
  const targetQuote: MarketQuote | undefined = quotesRes.quotes[spec.canonical];

  const lastBar = targetBars.length > 0 ? targetBars[targetBars.length - 1] : null;
  const lastBarClose = lastBar?.close ?? 0;

  // When target comes directly from OANDA, its live candle close IS exact OANDA spot (ratio = 1.0)!
  const isTargetOanda = targetSeries?.source === 'oanda';
  const spotPrice =
    isTargetOanda && targetSeries.livePrice && targetSeries.livePrice > 0
      ? targetSeries.livePrice
      : targetQuote?.price && targetQuote.price > 0
        ? targetQuote.price
        : lastBarClose;
  const targetScaleRatio =
    isTargetOanda
      ? 1
      : lastBarClose > 0 && spotPrice > 0
        ? spotPrice / lastBarClose
        : 1;
  const decimals = priceDecimals(spec.shortName, spotPrice || 100);

  const rawAtr = computeAtr(targetBars, 14) * targetScaleRatio;
  const atr = roundTo(rawAtr, decimals);
  const atrPct = spotPrice > 0 ? roundTo((rawAtr / spotPrice) * 100, 2) : 0;

  // Feed & Live Spread Info
  const liveSpreadPx =
    targetSeries?.liveSpreadPx !== null && targetSeries?.liveSpreadPx !== undefined
      ? roundTo(targetSeries.liveSpreadPx, Math.min(5, decimals + 1))
      : null;
  const liveSpreadPct = targetSeries?.liveSpreadPct ?? null;
  const spreadInAtrPct =
    liveSpreadPx !== null && rawAtr > 0 ? roundTo((liveSpreadPx / rawAtr) * 100, 1) : null;
  const wideSpread = spreadInAtrPct !== null && spreadInAtrPct >= 12;

  const oandaDriverCount = Array.from(seriesByShort.values()).filter((s) => s.source === 'oanda').length;
  const feedSource: FeedInfo['source'] = isTargetOanda
    ? oandaDriverCount === seriesByShort.size
      ? 'oanda'
      : 'hybrid'
    : 'yahoo';
  const feedInfo: FeedInfo = {
    source: feedSource,
    label: isTargetOanda ? 'OANDA Live' : 'Yahoo Proxy',
    instrument: targetSeries?.instrument ?? null,
    liveSpreadPx,
    liveSpreadPct,
    spreadInAtrPct,
    wideSpread
  };

  // Live Macro Event Risk Lock
  const eventRisk = evaluateEventRisk(spec.shortName, highEvents);

  // Higher-Timeframe Trend Context
  const htfBias = computeHtfBias(htfBundle.bars);
  const htfBiasLabel =
    htfBias === 'bull'
      ? `${htfBundle.label} Uptrend`
      : htfBias === 'bear'
        ? `${htfBundle.label} Downtrend`
        : `${htfBundle.label} Range`;

  // Stationary Return Regression Window: 72 bars (~3 days on 1H); Horizon H = 8 bars
  const HORIZON = 8;
  const WINDOW = Math.min(72, targetBars.length);
  const slice = targetBars.slice(targetBars.length - WINDOW);
  const targetTs = slice.map((b) => b.ts);
  const yCloses = slice.map((b) => b.close);

  let zScore = 0;
  let adjRSquared = 0;
  let recentAdjR2 = 0;
  let gapPct = 0;
  let fairValuePrice = spotPrice;
  const residualSeries: ResidualPoint[] = [];
  const driversOut: DriverContribution[] = [];
  let bestLeadLag: LeadLagReadout | null = null;

  if (slice.length >= 24 && yCloses[0] > 0) {
    const nBars = slice.length;
    const yRet: number[] = [];
    for (let i = 1; i < nBars; i++) {
      yRet.push(Math.log(yCloses[i] / yCloses[i - 1]));
    }

    const maxStaleSec = Math.max(stepSec * 4, 14_400);
    interface ActiveDriverData {
      spec: DriverSpec;
      closes: number[];
      xRet: number[];
      windowChangePct: number;
      price: number | null;
      corr: number;
      lagBars: number;
      lagCorr: number;
      feed: 'oanda' | 'yahoo';
    }

    const activeDrivers: ActiveDriverData[] = [];
    const inactiveDrivers: DriverContribution[] = [];

    for (const d of spec.drivers) {
      const dSeries = seriesByShort.get(d.shortName);
      const dBars = dSeries?.bars ?? [];
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

      const dLivePrice =
        dSeries?.source === 'oanda' && dSeries.livePrice
          ? dSeries.livePrice
          : (dQuote?.price ?? (dBars.length > 0 ? dBars[dBars.length - 1].close : null));

      if (validCount < Math.floor(nBars * 0.7) || firstValid === null) {
        inactiveDrivers.push({
          symbol: d.symbol,
          shortName: d.shortName,
          price: dLivePrice,
          windowChangePct: 0,
          beta: 0,
          correlation: 0,
          weightPct: 0,
          pull: 'flat',
          lagBars: 0,
          lagCorrelation: 0,
          active: false,
          feed: dSeries?.source ?? 'yahoo'
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
      const sRet = stdDev(xRet);
      const hStart = Math.max(0, nBars - 1 - HORIZON);
      const recentChgPct = ((filled[nBars - 1] - filled[hStart]) / filled[hStart]) * 100;

      if (sRet < 1e-5) {
        inactiveDrivers.push({
          symbol: d.symbol,
          shortName: d.shortName,
          price: dLivePrice,
          windowChangePct: roundTo(recentChgPct, 2),
          beta: 0,
          correlation: 0,
          weightPct: 0,
          pull: 'flat',
          lagBars: 0,
          lagCorrelation: 0,
          active: false,
          feed: dSeries?.source ?? 'yahoo'
        });
        continue;
      }

      const corr = pearson(xRet, yRet);
      const ll = computeBestLeadLag(yRet, xRet);

      activeDrivers.push({
        spec: d,
        closes: filled,
        xRet,
        windowChangePct: roundTo(recentChgPct, 2),
        price: dLivePrice,
        corr,
        lagBars: ll.bestLag,
        lagCorr: ll.bestCorr,
        feed: dSeries?.source ?? 'yahoo'
      });
    }

    if (activeDrivers.length > 0) {
      const xRetList = activeDrivers.map((a) => a.xRet);
      const fullFit = fitStationaryReturnOls(yRet, xRetList);

      if (fullFit) {
        const { stdBetas, rawBetas } = fullFit;
        adjRSquared = fullFit.adjR2;

        // Regime-Break Check: Compare recent 18-bar fit vs 72-bar baseline fit
        const shortN = Math.min(18, yRet.length);
        if (shortN >= 12) {
          const shortFit = fitStationaryReturnOls(
            yRet.slice(yRet.length - shortN),
            xRetList.map((xr) => xr.slice(xr.length - shortN))
          );
          recentAdjR2 = shortFit ? shortFit.adjR2 : adjRSquared;
        } else {
          recentAdjR2 = adjRSquared;
        }

        // Compute stationary H-bar return prediction errors
        const hErrors: { idx: number; err: number }[] = [];
        for (let i = HORIZON; i < nBars; i++) {
          const actualH = Math.log(yCloses[i] / yCloses[i - HORIZON]);
          let impliedH = 0;
          for (let k = 0; k < activeDrivers.length; k++) {
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

        const absSum = stdBetas.reduce((acc, b) => acc + Math.abs(b), 0) || 1;
        for (let k = 0; k < activeDrivers.length; k++) {
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
            active: true,
            feed: ad.feed
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

  // ── Strict SMT Detection across Peers (OANDA Wick Parity) ──────────────────
  const allSmtSignals: SmtSignal[] = [];
  let primaryPoolWatches: SessionPoolWatch[] = [];

  for (let i = 0; i < spec.peers.length; i++) {
    const peer = spec.peers[i];
    const pSeries = seriesByShort.get(peer.shortName);
    const pBars = pSeries?.bars ?? [];
    const pQuote = quotesRes.quotes[peer.symbol];
    const pLastClose = pBars.length > 0 ? pBars[pBars.length - 1].close : 0;
    const isPeerOanda = pSeries?.source === 'oanda';
    const pSpot =
      isPeerOanda && pSeries.livePrice
        ? pSeries.livePrice
        : pQuote?.price && pQuote.price > 0
          ? pQuote.price
          : pLastClose;
    const pScale = isPeerOanda ? 1 : pLastClose > 0 && pSpot > 0 ? pSpot / pLastClose : 1;

    const { signals, poolWatches } = detectSmtForPeer(
      spec.shortName,
      targetBars,
      targetScaleRatio,
      peer,
      pBars,
      pScale,
      stepSec,
      htfBias,
      htfBundle.label
    );
    allSmtSignals.push(...signals);
    if (i === 0) {
      primaryPoolWatches = poolWatches;
    }
  }

  allSmtSignals.sort((a, b) => a.minutesAgo - b.minutesAgo || b.peerGapAtr - a.peerGapAtr);

  // ── Regime-Break / Decoupling Evaluation ───────────────────────────────────
  const roundedSpot = roundTo(spotPrice, decimals);
  const roundedFair = roundTo(fairValuePrice, decimals);
  const gapPoints = roundTo(roundedSpot - roundedFair, decimals);
  const roundedZ = roundTo(zScore, 2);
  const roundedR2 = roundTo(adjRSquared, 2);
  const roundedRecentR2 = roundTo(recentAdjR2, 2);
  const roundedGapPct = roundTo(gapPct, 2);
  const fitPct = Math.round(roundedR2 * 100);
  const recentFitPct = Math.round(roundedRecentR2 * 100);
  const driverFitLabel: 'Strong' | 'Moderate' | 'Weak' =
    roundedR2 >= 0.55 ? 'Strong' : roundedR2 >= 0.3 ? 'Moderate' : 'Weak';

  const fitDrop = fitPct - recentFitPct;
  const driverLinkStatus: DriverLinkInfo['status'] =
    driverFitLabel === 'Weak'
      ? 'breaking'
      : fitPct >= 35 && (recentFitPct < 20 || fitDrop >= 30)
        ? 'breaking'
        : fitPct >= 35 && fitDrop >= 18
          ? 'shifting'
          : 'stable';

  const driverLink: DriverLinkInfo = {
    status: driverLinkStatus,
    label:
      driverLinkStatus === 'breaking'
        ? 'Decoupling'
        : driverLinkStatus === 'shifting'
          ? 'Softening'
          : 'Stable',
    baselineFitPct: fitPct,
    recentFitPct,
    summary:
      driverLinkStatus === 'breaking'
        ? `Recent driver link dropped to ${recentFitPct}% (vs ${fitPct}% baseline) — treat expected price with caution.`
        : driverLinkStatus === 'shifting'
          ? `Short-term link eased to ${recentFitPct}% (vs ${fitPct}% baseline).`
          : `Drivers tracking cleanly (${recentFitPct}% recent vs ${fitPct}% baseline).`
  };

  // ── Candle Turn & OANDA Tick-Volume Confirmation ───────────────────────────
  const bearSmts = allSmtSignals.filter((s) => s.direction === 'bearish');
  const bullSmts = allSmtSignals.filter((s) => s.direction === 'bullish');
  const hasBearSmt = bearSmts.length > 0;
  const hasBullSmt = bullSmts.length > 0;
  const smtConflict = hasBearSmt && hasBullSmt;

  // Intended directional lean
  let leanDir: 'long' | 'short' | null = null;
  if (!smtConflict) {
    if (driverFitLabel !== 'Weak' && roundedZ >= 1.4) leanDir = 'short';
    else if (driverFitLabel !== 'Weak' && roundedZ <= -1.4) leanDir = 'long';
    else if (hasBearSmt) leanDir = 'short';
    else if (hasBullSmt) leanDir = 'long';
  }

  let turnConfirmed = false;
  if (lastBar && leanDir) {
    const range = Math.max(lastBar.high - lastBar.low, 1e-9);
    const upperWickRatio = (lastBar.high - Math.max(lastBar.open, lastBar.close)) / range;
    const lowerWickRatio = (Math.min(lastBar.open, lastBar.close) - lastBar.low) / range;
    if (leanDir === 'short') {
      turnConfirmed = lastBar.close < lastBar.open || upperWickRatio >= 0.38;
    } else {
      turnConfirmed = lastBar.close > lastBar.open || lowerWickRatio >= 0.38;
    }
  }

  let volumeRatio: number | null = null;
  if (targetBars.length >= 22 && typeof targetBars[targetBars.length - 2].volume === 'number') {
    const checkBar = targetBars[targetBars.length - 2]; // latest completed bar for honest volume ratio
    const prev20 = targetBars.slice(targetBars.length - 22, targetBars.length - 2);
    const avgVol = mean(prev20.map((b) => b.volume ?? 0));
    if (avgVol > 0 && (checkBar.volume ?? 0) > 0) {
      volumeRatio = roundTo((checkBar.volume ?? 0) / avgVol, 2);
    }
  }
  const volumeLabel =
    volumeRatio === null
      ? 'No volume feed'
      : volumeRatio >= 1.3
        ? `High vol (${volumeRatio.toFixed(1)}×)`
        : volumeRatio <= 0.65
          ? `Light vol (${volumeRatio.toFixed(1)}×)`
          : `Normal vol (${volumeRatio.toFixed(1)}×)`;

  const candleConfirm: CandleConfirmInfo = {
    turnConfirmed,
    label: !leanDir ? 'Neutral' : turnConfirmed ? 'Turn Confirmed' : 'Waiting for Turn',
    volumeRatio,
    volumeLabel
  };

  // HTF Alignment relative to directional lean
  const htfAlignment: AuditTrendAlign =
    !leanDir || htfBias === 'range'
      ? 'neutral'
      : (leanDir === 'long' && htfBias === 'bull') || (leanDir === 'short' && htfBias === 'bear')
        ? 'with_trend'
        : 'counter_trend';

  const htfContext: HtfContextInfo = {
    timeframeLabel: htfBundle.label,
    bias: htfBias,
    biasLabel: htfBiasLabel,
    alignment: htfAlignment,
    alignmentLabel:
      htfAlignment === 'with_trend'
        ? 'With Trend'
        : htfAlignment === 'counter_trend'
          ? 'Counter-Trend'
          : 'Neutral',
    summary:
      htfAlignment === 'with_trend'
        ? `Aligned with ${htfBiasLabel} — higher-probability pullback context.`
        : htfAlignment === 'counter_trend'
          ? `Against ${htfBiasLabel} — wait for clear turn or structure break.`
          : htfBias !== 'range'
            ? `${htfBiasLabel} active — wait for a pullback or sweep aligned with it.`
            : `${htfBiasLabel} — no dominant higher-timeframe push.`
  };

  // ── Headline Verdict & Plain-English Explanation ───────────────────────────
  let verdict: VerdictKind = 'equilibrium';
  let verdictLabel = 'In Line';
  let verdictDetail = `${spec.shortName} is moving in step with its related markets right now.`;
  let verdictReason =
    'Price is within its normal range vs. drivers and no clean peer divergence is active.';

  if (eventRisk.status === 'locked') {
    verdict = 'event_lock';
    verdictLabel = 'Event Risk Lock';
    verdictDetail = eventRisk.headline;
    verdictReason = `Setup strength is capped because high-impact ${eventRisk.country} news (${eventRisk.eventTitle}) is inside the ±30m lock window.`;
  } else if (smtConflict) {
    verdict = 'mixed';
    verdictLabel = 'Mixed Signals';
    verdictDetail =
      'Opposing peer divergences are active on both highs and lows — choppy range, wait for a clean break.';
    verdictReason = `Headline set to Mixed because both a bullish sweep (${bullSmts[0].levelLabel}) and a bearish sweep (${bearSmts[0].levelLabel}) are active at once.`;
  } else if (driverFitLabel === 'Weak' && !hasBearSmt && !hasBullSmt) {
    verdict = 'weak_fit';
    verdictLabel = 'Weak Driver Fit';
    verdictDetail = `Related markets only explain ${fitPct}% of recent ${spec.shortName} bar moves — ignore the expected price gap.`;
    verdictReason = `Driver fit is below 30% (${fitPct}%), so stretch readings are muted until correlation returns.`;
  } else if (driverFitLabel !== 'Weak' && roundedZ >= 1.6 && hasBearSmt) {
    verdict = 'bearish_trap';
    verdictLabel =
      htfAlignment === 'with_trend'
        ? 'With-Trend High Sweep'
        : 'Stretched High + Bearish Sweep';
    verdictDetail = `${spec.shortName} is ${Math.abs(roundedZ).toFixed(1)}× above drivers (expected ${roundedFair}) and rejected ${bearSmts[0].levelLabel.toLowerCase()} vs ${bearSmts[0].peerShortName}.`;
    verdictReason = `Price stretch and bearish peer divergence align (${htfContext.alignmentLabel.toLowerCase()}).`;
  } else if (driverFitLabel !== 'Weak' && roundedZ <= -1.6 && hasBullSmt) {
    verdict = 'bullish_spring';
    verdictLabel =
      htfAlignment === 'with_trend'
        ? 'With-Trend Low Sweep'
        : 'Lagging Low + Bullish Sweep';
    verdictDetail = `${spec.shortName} is ${Math.abs(roundedZ).toFixed(1)}× below drivers (expected ${roundedFair}) and reclaimed ${bullSmts[0].levelLabel.toLowerCase()} vs ${bullSmts[0].peerShortName}.`;
    verdictReason = `Price lag and bullish peer divergence align (${htfContext.alignmentLabel.toLowerCase()}).`;
  } else if (driverFitLabel !== 'Weak' && roundedZ >= 2.0) {
    verdict = 'rich';
    verdictLabel =
      htfAlignment === 'with_trend' && turnConfirmed
        ? 'With-Trend Pullback High'
        : turnConfirmed
          ? 'Stretched High · Turning'
          : 'Stretched High';
    verdictDetail = turnConfirmed
      ? `${spec.shortName} ran ${Math.abs(roundedZ).toFixed(1)}× above its drivers (expected ${roundedFair}) with a turning candle (${htfContext.alignmentLabel.toLowerCase()}).`
      : `${spec.shortName} ran ${Math.abs(roundedZ).toFixed(1)}× above its drivers (expected ${roundedFair}) — wait for a clear reversal candle before acting.`;
    verdictReason = `Driven by a ≥2.0× stretch above expected price with ${driverFitLabel.toLowerCase()} driver fit (${fitPct}%).`;
  } else if (driverFitLabel !== 'Weak' && roundedZ <= -2.0) {
    verdict = 'cheap';
    verdictLabel =
      htfAlignment === 'with_trend' && turnConfirmed
        ? 'With-Trend Pullback Dip'
        : turnConfirmed
          ? 'Lagging Behind · Turning'
          : 'Lagging Behind';
    verdictDetail = turnConfirmed
      ? `${spec.shortName} sits ${Math.abs(roundedZ).toFixed(1)}× behind its drivers (expected ${roundedFair}) with a turning candle (${htfContext.alignmentLabel.toLowerCase()}).`
      : `${spec.shortName} sits ${Math.abs(roundedZ).toFixed(1)}× behind its drivers (expected ${roundedFair}) — wait for a green reversal candle before acting.`;
    verdictReason = `Driven by a ≥2.0× lag below expected price with ${driverFitLabel.toLowerCase()} driver fit (${fitPct}%).`;
  } else if (hasBearSmt) {
    verdict = 'bearish_smt';
    verdictLabel =
      htfAlignment === 'with_trend' ? 'With-Trend Bearish Sweep' : 'Bearish Peer Divergence';
    verdictDetail = `${bearSmts[0].summary} ${bearSmts[0].contextNote}.`;
    verdictReason = `Fresh bearish peer divergence on ${bearSmts[0].levelLabel} vs ${bearSmts[0].peerShortName} (${htfContext.alignmentLabel.toLowerCase()}).`;
  } else if (hasBullSmt) {
    verdict = 'bullish_smt';
    verdictLabel =
      htfAlignment === 'with_trend' ? 'With-Trend Bullish Sweep' : 'Bullish Peer Divergence';
    verdictDetail = `${bullSmts[0].summary} ${bullSmts[0].contextNote}.`;
    verdictReason = `Fresh bullish peer divergence on ${bullSmts[0].levelLabel} vs ${bullSmts[0].peerShortName} (${htfContext.alignmentLabel.toLowerCase()}).`;
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

  // ── Empirically Calibrated Transparent 0–100 Setup Strength ────────────────
  //   Stretch (0–40) + Driver Fit (0–25) + Divergence (0–25) + Trend & Turn Bonus (0–10)
  //   minus Conflict (-20), Decoupling (-12), Unconfirmed Counter-Trend (-10), capped <=35 on Event Lock.
  const fitMultiplier =
    driverFitLabel === 'Weak' ? 0.3 : driverLinkStatus === 'breaking' ? 0.55 : 1.0;
  const stretchPts = Math.round(Math.min(40, Math.abs(roundedZ) * 16) * fitMultiplier);
  const fitPts = Math.round(Math.min(25, roundedR2 * 30));
  const smtDirectionAligned =
    !smtConflict &&
    ((hasBearSmt && roundedZ >= 0.5) || (hasBullSmt && roundedZ <= -0.5));
  const smtPts = smtConflict
    ? 0
    : hasBearSmt || hasBullSmt
      ? smtDirectionAligned
        ? 25
        : 18
      : 0;

  let alignBonus = 0;
  if (leanDir && !smtConflict) {
    if (htfAlignment === 'with_trend' && turnConfirmed) alignBonus = 10;
    else if (htfAlignment === 'with_trend' || turnConfirmed) alignBonus = 5;
  }

  const conflictPenalty = smtConflict ? 20 : 0;
  const decouplingPenalty = driverLinkStatus === 'breaking' && driverFitLabel !== 'Weak' ? 12 : 0;
  const counterTrendPenalty =
    leanDir && htfAlignment === 'counter_trend' && !turnConfirmed ? 10 : 0;

  let rawScore = clamp(
    stretchPts +
      fitPts +
      smtPts +
      alignBonus -
      conflictPenalty -
      decouplingPenalty -
      counterTrendPenalty,
    0,
    100
  );
  const eventLocked = eventRisk.status === 'locked';
  if (eventLocked) rawScore = Math.min(rawScore, 35);
  const convictionScore = Math.round(rawScore);

  const parts: string[] = [
    `Stretch ${stretchPts}/40`,
    `Fit ${fitPts}/25`,
    `Divergence ${smtPts}/25`
  ];
  if (alignBonus > 0) parts.push(`Trend/Turn +${alignBonus}`);
  if (conflictPenalty > 0) parts.push(`Conflict −${conflictPenalty}`);
  if (decouplingPenalty > 0) parts.push(`Decoupling −${decouplingPenalty}`);
  if (counterTrendPenalty > 0) parts.push(`Counter-trend −${counterTrendPenalty}`);
  if (eventLocked) parts.push('Capped ≤35 (News Lock)');

  const scoreBreakdown: ScoreBreakdown = {
    stretchPts,
    maxStretchPts: 40,
    fitPts,
    maxFitPts: 25,
    smtPts,
    maxSmtPts: 25,
    alignBonus,
    maxAlignBonus: 10,
    conflictPenalty,
    decouplingPenalty,
    counterTrendPenalty,
    eventLocked,
    total: convictionScore,
    explanation: parts.join(' · ')
  };

  // Structural reference levels (purely informational, matching exact OANDA prices)
  const topSmt = allSmtSignals[0] ?? null;
  let invalidationLevel: number | null = null;
  let invalidationLabel: string | null = null;
  if (topSmt) {
    invalidationLevel = topSmt.targetExtreme;
    invalidationLabel = `${topSmt.levelLabel} extreme`;
  } else if (leanDir && targetBars.length >= 6) {
    const rec6 = targetBars.slice(targetBars.length - 6);
    invalidationLevel = roundTo(
      (leanDir === 'short'
        ? Math.max(...rec6.map((b) => b.high))
        : Math.min(...rec6.map((b) => b.low))) * targetScaleRatio,
      decimals
    );
    invalidationLabel = leanDir === 'short' ? 'Recent 6-bar high' : 'Recent 6-bar low';
  }

  const actionableBias: SetupLevelsInfo['actionableBias'] =
    eventLocked || smtConflict || !leanDir || convictionScore < 55
      ? 'wait'
      : leanDir === 'long'
        ? 'buy_watch'
        : 'sell_watch';

  const setupLevels: SetupLevelsInfo = {
    actionableBias,
    expectedTarget: roundedFair,
    invalidationLevel,
    invalidationLabel,
    distanceInAvgMoves: rawAtr > 0 ? roundTo(Math.abs(spotPrice - fairValuePrice) / rawAtr, 2) : 0
  };

  return {
    symbol: spec.canonical,
    shortName: spec.shortName,
    timeframe: tf,
    feedInfo,
    eventRisk,
    htfContext,
    driverLink,
    candleConfirm,
    setupLevels,
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
    reversingCandle: turnConfirmed,
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
    const batchSize = 3; // gentle concurrency for OANDA + Yahoo
    for (let i = 0; i < SCAN_UNIVERSE.length; i += batchSize) {
      const slice = SCAN_UNIVERSE.slice(i, i + batchSize);
      const batch = await Promise.all(
        slice.map((sym) => getDislocationPayload(sym, tf, force).catch(() => null))
      );
      for (const item of batch) {
        if (item && item.spotPrice > 0) results.push(item);
      }
    }

    // Automatically log high-conviction 1H setups into the rolling System Audit journal
    if (tf === '1h') {
      for (const r of results) {
        const hasConflict =
          r.smtSignals.some((s) => s.direction === 'bullish') &&
          r.smtSignals.some((s) => s.direction === 'bearish');
        if (
          r.convictionScore >= 62 &&
          !hasConflict &&
          r.eventRisk.status !== 'locked' &&
          r.driverLink.status !== 'breaking' &&
          r.driverFitLabel !== 'Weak' &&
          r.setupLevels.actionableBias !== 'wait'
        ) {
          const dir = r.setupLevels.actionableBias === 'buy_watch' ? 'long' : 'short';
          const spreadPx =
            r.feedInfo.liveSpreadPx ?? r.spotPrice * 0.0002;
          recordSystemAuditCandidate({
            symbol: r.symbol,
            shortName: r.shortName,
            direction: dir,
            setupKind: r.verdictLabel,
            convictionScore: r.convictionScore,
            entryPrice: r.spotPrice,
            expectedPrice: r.fairValuePrice,
            atr: r.atr,
            spreadPx,
            spreadSource: r.feedInfo.liveSpreadPx !== null ? 'oanda' : 'est',
            trendAlign: r.htfContext.alignment
          });
        }
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
          feedSource: r.feedInfo.source,
          spotPrice: r.spotPrice,
          fairValuePrice: r.fairValuePrice,
          gapPct: r.gapPct,
          zScore: r.zScore,
          rSquared: r.rSquared,
          driverFitLabel: r.driverFitLabel,
          driverLinkStatus: r.driverLink.status,
          htfBias: r.htfContext.bias,
          htfAlignment: r.htfContext.alignment,
          eventRiskStatus: r.eventRisk.status,
          eventRiskLabel:
            r.eventRisk.status === 'locked'
              ? `News Lock (${r.eventRisk.country})`
              : r.eventRisk.status === 'caution'
                ? `${r.eventRisk.country} News <2h`
                : null,
          turnConfirmed: r.candleConfirm.turnConfirmed,
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
      oandaActive: isOandaConfigured(),
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
