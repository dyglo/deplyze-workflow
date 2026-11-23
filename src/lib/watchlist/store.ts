import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  saveWorkspaceJson
} from '../workspace/storage';

export type BiasDirection = 'bull' | 'bear' | 'range' | 'none';

export interface QuotePerformance {
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
}

export interface MarketQuote {
  symbol: string;
  shortName: string;
  description: string;
  price: number;
  change: number;
  changePercent: number;
  type: string;
  performance: QuotePerformance;
  source: 'tv' | 'yahoo';
  updatedAt: string;
}

export interface WatchlistItem {
  id: string;
  symbol: string; // e.g. OANDA:XAUUSD
  shortName: string; // e.g. XAUUSD
  description: string;
  bias: BiasDirection;
  poiNote: string;
}

export interface WatchlistSection {
  id: string;
  name: string;
  collapsed: boolean;
  items: WatchlistItem[];
}

export interface WatchlistGroup {
  id: string;
  name: string;
  sections: WatchlistSection[];
}

export interface WatchlistState {
  activeGroupId: string;
  groups: WatchlistGroup[];
}

export interface SymbolCatalogEntry {
  symbol: string;
  shortName: string;
  description: string;
  category: string;
}

export const SYMBOL_CATALOG: SymbolCatalogEntry[] = [
  { symbol: 'OANDA:XAUUSD', shortName: 'XAUUSD', description: 'Gold Spot / U.S. Dollar', category: 'Commodities' },
  { symbol: 'OANDA:XAGUSD', shortName: 'XAGUSD', description: 'Silver Spot / U.S. Dollar', category: 'Commodities' },
  { symbol: 'TVC:USOIL', shortName: 'USOIL', description: 'WTI Crude Oil', category: 'Commodities' },
  { symbol: 'TVC:UKOIL', shortName: 'UKOIL', description: 'Brent Crude Oil', category: 'Commodities' },
  { symbol: 'TVC:DXY', shortName: 'DXY', description: 'U.S. Dollar Currency Index', category: 'Indices' },
  { symbol: 'NASDAQ:NDX', shortName: 'NAS100', description: 'NASDAQ 100 Index', category: 'Indices' },
  { symbol: 'TVC:SPX', shortName: 'SPX', description: 'S&P 500 Index', category: 'Indices' },
  { symbol: 'TVC:DJI', shortName: 'US30', description: 'Dow Jones Industrial Average', category: 'Indices' },
  { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', description: 'Euro / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', description: 'British Pound / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', description: 'U.S. Dollar / Japanese Yen', category: 'FX Majors' },
  { symbol: 'OANDA:AUDUSD', shortName: 'AUDUSD', description: 'Australian Dollar / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:USDCAD', shortName: 'USDCAD', description: 'U.S. Dollar / Canadian Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:USDCHF', shortName: 'USDCHF', description: 'U.S. Dollar / Swiss Franc', category: 'FX Majors' },
  { symbol: 'OANDA:NZDUSD', shortName: 'NZDUSD', description: 'New Zealand Dollar / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:GBPJPY', shortName: 'GBPJPY', description: 'British Pound / Japanese Yen', category: 'FX Crosses' },
  { symbol: 'OANDA:EURJPY', shortName: 'EURJPY', description: 'Euro / Japanese Yen', category: 'FX Crosses' },
  { symbol: 'OANDA:EURGBP', shortName: 'EURGBP', description: 'Euro / British Pound', category: 'FX Crosses' },
  { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', description: 'Bitcoin / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', description: 'Ethereum / U.S. Dollar', category: 'Crypto' },
  { symbol: 'NASDAQ:NVDA', shortName: 'NVDA', description: 'NVIDIA Corporation', category: 'Stocks' },
  { symbol: 'NASDAQ:AAPL', shortName: 'AAPL', description: 'Apple Inc.', category: 'Stocks' },
  { symbol: 'NASDAQ:TSLA', shortName: 'TSLA', description: 'Tesla, Inc.', category: 'Stocks' }
];

const STORAGE_KEY = 'watchlist';

export function createDefaultWatchlistState(): WatchlistState {
  return {
    activeGroupId: 'wl-main',
    groups: [
      {
        id: 'wl-main',
        name: 'Watchlist',
        sections: [
          {
            id: 'sec-indices',
            name: 'INDICES',
            collapsed: false,
            items: [
              {
                id: 'wi-dxy',
                symbol: 'TVC:DXY',
                shortName: 'DXY',
                description: 'U.S. Dollar Currency Index',
                bias: 'none',
                poiNote: ''
              },
              {
                id: 'wi-nas100',
                symbol: 'NASDAQ:NDX',
                shortName: 'NAS100',
                description: 'NASDAQ 100 Index',
                bias: 'none',
                poiNote: ''
              }
            ]
          },
          {
            id: 'sec-commodities',
            name: 'COMMODITIES',
            collapsed: false,
            items: [
              {
                id: 'wi-xau',
                symbol: 'OANDA:XAUUSD',
                shortName: 'XAUUSD',
                description: 'Gold Spot / U.S. Dollar',
                bias: 'none',
                poiNote: ''
              },
              {
                id: 'wi-usoil',
                symbol: 'TVC:USOIL',
                shortName: 'USOIL',
                description: 'WTI Crude Oil',
                bias: 'none',
                poiNote: ''
              }
            ]
          },
          {
            id: 'sec-fx',
            name: 'FX MAJORS',
            collapsed: false,
            items: [
              {
                id: 'wi-eurusd',
                symbol: 'OANDA:EURUSD',
                shortName: 'EURUSD',
                description: 'Euro / U.S. Dollar',
                bias: 'none',
                poiNote: ''
              },
              {
                id: 'wi-usdjpy',
                symbol: 'OANDA:USDJPY',
                shortName: 'USDJPY',
                description: 'U.S. Dollar / Japanese Yen',
                bias: 'none',
                poiNote: ''
              },
              {
                id: 'wi-gbpusd',
                symbol: 'OANDA:GBPUSD',
                shortName: 'GBPUSD',
                description: 'British Pound / U.S. Dollar',
                bias: 'none',
                poiNote: ''
              }
            ]
          },
          {
            id: 'sec-crypto',
            name: 'CRYPTO',
            collapsed: false,
            items: [
              {
                id: 'wi-btcusd',
                symbol: 'BITSTAMP:BTCUSD',
                shortName: 'BTCUSD',
                description: 'Bitcoin / U.S. Dollar',
                bias: 'none',
                poiNote: ''
              }
            ]
          }
        ]
      }
    ]
  };
}

export async function loadWatchlistState(): Promise<WatchlistState> {
  const def = createDefaultWatchlistState();
  const loaded = await loadWorkspaceJson<WatchlistState>(STORAGE_KEY, def);
  if (!loaded || !Array.isArray(loaded.groups) || loaded.groups.length === 0) {
    return def;
  }
  return loaded;
}

export async function saveWatchlistState(state: WatchlistState): Promise<void> {
  await saveWorkspaceJson(STORAGE_KEY, state);
}

export function normalizeSymbolInput(raw: string): {
  symbol: string;
  shortName: string;
  description: string;
} {
  const cleaned = raw.trim().toUpperCase();
  const known = SYMBOL_CATALOG.find(
    (c) => c.symbol.toUpperCase() === cleaned || c.shortName.toUpperCase() === cleaned
  );
  if (known) {
    return {
      symbol: known.symbol,
      shortName: known.shortName,
      description: known.description
    };
  }
  const colon = cleaned.indexOf(':');
  const shortName = colon >= 0 ? cleaned.slice(colon + 1) : cleaned;
  return {
    symbol: cleaned,
    shortName,
    description: shortName
  };
}

export function createWatchlistItem(raw: string): WatchlistItem {
  const norm = normalizeSymbolInput(raw);
  return {
    id: makeWorkspaceId('wi'),
    symbol: norm.symbol,
    shortName: norm.shortName,
    description: norm.description,
    bias: 'none',
    poiNote: ''
  };
}

export async function fetchMarketQuotes(
  symbols: string[],
  signal?: AbortSignal
): Promise<Record<string, MarketQuote>> {
  if (symbols.length === 0) return {};
  const unique = Array.from(new Set(symbols));
  const url = `${getApiBaseUrl()}/api/quotes?symbols=${encodeURIComponent(unique.join(','))}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!res.ok) return {};
  const json = (await res.json()) as { quotes?: Record<string, MarketQuote> };
  return json.quotes ?? {};
}

export function formatQuotePrice(price: number | undefined, shortName = ''): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) return '—';
  const upper = shortName.toUpperCase();
  let decimals = 2;
  if (upper.includes('JPY')) decimals = 3;
  else if (
    /^(EUR|GBP|AUD|NZD|USD)(USD|CAD|CHF|GBP|AUD|NZD)$/.test(upper) &&
    !upper.includes('JPY')
  ) {
    decimals = 5;
  } else if (upper.includes('XAU') || upper.includes('GOLD') || upper.includes('DXY')) {
    decimals = 3;
  } else if (Math.abs(price) < 5) {
    decimals = 4;
  } else if (Math.abs(price) >= 10000) {
    decimals = 2;
  }
  return price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function formatQuoteChange(change: number | undefined, shortName = ''): string {
  if (typeof change !== 'number' || !Number.isFinite(change)) return '—';
  const sign = change > 0 ? '+' : '';
  const abs = Math.abs(change);
  const upper = shortName.toUpperCase();
  let decimals = 2;
  if (upper.includes('JPY') || upper.includes('XAU') || upper.includes('DXY')) decimals = 3;
  else if (abs < 0.5 && abs > 0) decimals = 5;
  return `${sign}${change.toFixed(decimals)}`;
}

export function formatQuotePct(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export type SymbolBadgeKind = 'gold' | 'oil' | 'btc' | 'eth' | 'dxy' | 'nas' | 'monogram';

export function getSymbolBadgeKind(shortName: string): SymbolBadgeKind {
  const s = shortName.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 'gold';
  if (s.includes('OIL') || s.includes('WTI') || s.includes('CRUDE')) return 'oil';
  if (s.includes('BTC')) return 'btc';
  if (s.includes('ETH')) return 'eth';
  if (s === 'DXY') return 'dxy';
  if (s.includes('NAS') || s === 'NDX') return 'nas';
  return 'monogram';
}

export function symbolBadgeBg(shortName: string): string {
  const s = shortName.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return '#e2a700';
  if (s.includes('OIL') || s.includes('WTI')) return '#1c212b';
  if (s.includes('BTC')) return '#f7931a';
  if (s.includes('ETH')) return '#627eea';
  if (s === 'DXY') return '#089981';
  if (s.includes('NAS') || s === 'NDX') return '#00a3e0';
  const palette = ['#2962ff', '#089981', '#e04f5f', '#7b61ff', '#00897b', '#d97706'];
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}
