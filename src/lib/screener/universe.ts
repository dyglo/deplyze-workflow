import type { WatchlistState } from '../watchlist/store';
import type { ScreenerCategory, ScreenerScopeId, ScreenerUniverseItem } from './types';

export const PERSONAL_UNIVERSE_BASE: Omit<ScreenerUniverseItem, 'watchlistGroups'>[] = [
  // Metals & Energy
  { symbol: 'OANDA:XAUUSD', shortName: 'XAUUSD', description: 'Gold Spot / U.S. Dollar', category: 'Metals & Energy' },
  { symbol: 'OANDA:XAGUSD', shortName: 'XAGUSD', description: 'Silver Spot / U.S. Dollar', category: 'Metals & Energy' },
  { symbol: 'TVC:USOIL', shortName: 'USOIL', description: 'WTI Crude Oil', category: 'Metals & Energy' },
  { symbol: 'TVC:UKOIL', shortName: 'UKOIL', description: 'Brent Crude Oil', category: 'Metals & Energy' },
  { symbol: 'FX:NATGAS', shortName: 'NATGAS', description: 'Natural Gas', category: 'Metals & Energy' },
  { symbol: 'OANDA:XCUUSD', shortName: 'COPPER', description: 'Copper / U.S. Dollar', category: 'Metals & Energy' },

  // Indices & Rates
  { symbol: 'TVC:DXY', shortName: 'DXY', description: 'U.S. Dollar Currency Index', category: 'Indices & Rates' },
  { symbol: 'NASDAQ:NDX', shortName: 'NAS100', description: 'NASDAQ 100 Index', category: 'Indices & Rates' },
  { symbol: 'TVC:SPX', shortName: 'SPX', description: 'S&P 500 Index', category: 'Indices & Rates' },
  { symbol: 'TVC:DJI', shortName: 'US30', description: 'Dow Jones Industrial Average', category: 'Indices & Rates' },
  { symbol: 'TVC:DEU40', shortName: 'GER40', description: 'DAX Performance Index', category: 'Indices & Rates' },
  { symbol: 'TVC:UKX', shortName: 'UK100', description: 'FTSE 100 Index', category: 'Indices & Rates' },
  { symbol: 'TVC:NI225', shortName: 'JP225', description: 'Nikkei 225 Index', category: 'Indices & Rates' },
  { symbol: 'TVC:VIX', shortName: 'VIX', description: 'CBOE Volatility Index', category: 'Indices & Rates' },
  { symbol: 'TVC:US10Y', shortName: 'US10Y', description: 'US 10-Year Treasury Yield', category: 'Indices & Rates' },

  // FX Majors
  { symbol: 'OANDA:EURUSD', shortName: 'EURUSD', description: 'Euro / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:GBPUSD', shortName: 'GBPUSD', description: 'British Pound / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:USDJPY', shortName: 'USDJPY', description: 'U.S. Dollar / Japanese Yen', category: 'FX Majors' },
  { symbol: 'OANDA:AUDUSD', shortName: 'AUDUSD', description: 'Australian Dollar / U.S. Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:USDCAD', shortName: 'USDCAD', description: 'U.S. Dollar / Canadian Dollar', category: 'FX Majors' },
  { symbol: 'OANDA:USDCHF', shortName: 'USDCHF', description: 'U.S. Dollar / Swiss Franc', category: 'FX Majors' },
  { symbol: 'OANDA:NZDUSD', shortName: 'NZDUSD', description: 'New Zealand Dollar / U.S. Dollar', category: 'FX Majors' },

  // FX Crosses
  { symbol: 'OANDA:GBPJPY', shortName: 'GBPJPY', description: 'British Pound / Japanese Yen', category: 'FX Crosses' },
  { symbol: 'OANDA:EURJPY', shortName: 'EURJPY', description: 'Euro / Japanese Yen', category: 'FX Crosses' },
  { symbol: 'OANDA:EURGBP', shortName: 'EURGBP', description: 'Euro / British Pound', category: 'FX Crosses' },
  { symbol: 'OANDA:AUDJPY', shortName: 'AUDJPY', description: 'Australian Dollar / Japanese Yen', category: 'FX Crosses' },
  { symbol: 'OANDA:CADJPY', shortName: 'CADJPY', description: 'Canadian Dollar / Japanese Yen', category: 'FX Crosses' },
  { symbol: 'OANDA:EURAUD', shortName: 'EURAUD', description: 'Euro / Australian Dollar', category: 'FX Crosses' },
  { symbol: 'OANDA:GBPAUD', shortName: 'GBPAUD', description: 'British Pound / Australian Dollar', category: 'FX Crosses' },

  // Crypto
  { symbol: 'BITSTAMP:BTCUSD', shortName: 'BTCUSD', description: 'Bitcoin / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BITSTAMP:ETHUSD', shortName: 'ETHUSD', description: 'Ethereum / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BINANCE:SOLUSDT', shortName: 'SOLUSD', description: 'Solana / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BITSTAMP:XRPUSD', shortName: 'XRPUSD', description: 'XRP / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BINANCE:BNBUSDT', shortName: 'BNBUSD', description: 'BNB / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BINANCE:DOGEUSDT', shortName: 'DOGEUSD', description: 'Dogecoin / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BINANCE:LINKUSDT', shortName: 'LINKUSD', description: 'Chainlink / U.S. Dollar', category: 'Crypto' },
  { symbol: 'BINANCE:AVAXUSDT', shortName: 'AVAXUSD', description: 'Avalanche / U.S. Dollar', category: 'Crypto' },

  // Mega-Cap Stocks
  { symbol: 'NASDAQ:NVDA', shortName: 'NVDA', description: 'NVIDIA Corporation', category: 'Stocks' },
  { symbol: 'NASDAQ:AAPL', shortName: 'AAPL', description: 'Apple Inc.', category: 'Stocks' },
  { symbol: 'NASDAQ:MSFT', shortName: 'MSFT', description: 'Microsoft Corporation', category: 'Stocks' },
  { symbol: 'NASDAQ:GOOGL', shortName: 'GOOGL', description: 'Alphabet Inc.', category: 'Stocks' },
  { symbol: 'NASDAQ:AMZN', shortName: 'AMZN', description: 'Amazon.com, Inc.', category: 'Stocks' },
  { symbol: 'NASDAQ:META', shortName: 'META', description: 'Meta Platforms, Inc.', category: 'Stocks' },
  { symbol: 'NASDAQ:TSLA', shortName: 'TSLA', description: 'Tesla, Inc.', category: 'Stocks' },
  { symbol: 'NASDAQ:AVGO', shortName: 'AVGO', description: 'Broadcom Inc.', category: 'Stocks' }
];

export const SCREENER_SCOPES: { id: ScreenerScopeId; label: string; shortLabel: string }[] = [
  { id: 'all', label: 'All Markets', shortLabel: 'All markets' },
  { id: 'watchlists', label: 'My Watchlists', shortLabel: 'My watchlists' },
  { id: 'fx', label: 'FX Screener', shortLabel: 'FX Majors & Crosses' },
  { id: 'metals', label: 'Metals & Energy', shortLabel: 'Metals & Energy' },
  { id: 'indices', label: 'Indices & Rates', shortLabel: 'Indices & Rates' },
  { id: 'crypto', label: 'Crypto Screener', shortLabel: 'Crypto coins' },
  { id: 'stocks', label: 'Stocks Screener', shortLabel: 'Mega-cap stocks' }
];

function inferCategory(shortName: string, sectionName?: string): ScreenerCategory {
  const s = shortName.toUpperCase();
  const sec = (sectionName ?? '').toUpperCase();
  if (s.includes('XAU') || s.includes('XAG') || s.includes('OIL') || s.includes('GAS') || s.includes('XCU')) {
    return 'Metals & Energy';
  }
  if (s === 'DXY' || s === 'VIX' || s === 'US10Y' || s.includes('NAS') || s.includes('SPX') || s.includes('NDX') || s.includes('US30') || s.includes('DJI') || s.includes('GER40') || s.includes('UK100')) {
    return 'Indices & Rates';
  }
  if (s.includes('BTC') || s.includes('ETH') || s.includes('SOL') || s.includes('XRP') || s.includes('BNB') || s.includes('DOGE') || sec.includes('CRYPTO')) {
    return 'Crypto';
  }
  if (/^[A-Z]{6}$/.test(s) && (s.includes('USD') || s.includes('EUR') || s.includes('GBP') || s.includes('JPY'))) {
    return s.includes('USD') ? 'FX Majors' : 'FX Crosses';
  }
  if (sec.includes('STOCK') || sec.includes('EQUIT')) return 'Stocks';
  return 'Watchlist';
}

export function buildPersonalUniverse(watchlist: WatchlistState | null): ScreenerUniverseItem[] {
  const map = new Map<string, ScreenerUniverseItem>();

  for (const item of PERSONAL_UNIVERSE_BASE) {
    const key = item.shortName.toUpperCase();
    map.set(key, { ...item, watchlistGroups: [] });
  }

  if (watchlist) {
    for (const grp of watchlist.groups) {
      for (const sec of grp.sections) {
        for (const item of sec.items) {
          const key = item.shortName.toUpperCase();
          const existing = map.get(key);
          if (existing) {
            if (!existing.watchlistGroups.includes(grp.id)) {
              existing.watchlistGroups.push(grp.id);
            }
            if (!existing.watchlistSection) {
              existing.watchlistSection = sec.name;
            }
          } else {
            map.set(key, {
              symbol: item.symbol,
              shortName: item.shortName,
              description: item.description || item.shortName,
              category: inferCategory(item.shortName, sec.name),
              watchlistGroups: [grp.id],
              watchlistSection: sec.name
            });
          }
        }
      }
    }
  }

  return Array.from(map.values());
}

export function filterUniverseByScope(
  items: ScreenerUniverseItem[],
  scope: ScreenerScopeId,
  watchlistGroupId: string | null = null
): ScreenerUniverseItem[] {
  if (scope === 'all') return items;
  if (scope === 'watchlists') {
    return items.filter((item) =>
      watchlistGroupId
        ? item.watchlistGroups.includes(watchlistGroupId)
        : item.watchlistGroups.length > 0
    );
  }
  if (scope === 'fx') {
    return items.filter((i) => i.category === 'FX Majors' || i.category === 'FX Crosses');
  }
  if (scope === 'metals') return items.filter((i) => i.category === 'Metals & Energy');
  if (scope === 'indices') return items.filter((i) => i.category === 'Indices & Rates');
  if (scope === 'crypto') return items.filter((i) => i.category === 'Crypto');
  if (scope === 'stocks') return items.filter((i) => i.category === 'Stocks');
  return items;
}
