export type ScreenerCategory =
  | 'FX Majors'
  | 'FX Crosses'
  | 'Metals & Energy'
  | 'Indices & Rates'
  | 'Crypto'
  | 'Stocks'
  | 'Watchlist';

export type ScreenerScopeId =
  | 'all'
  | 'watchlists'
  | 'fx'
  | 'metals'
  | 'indices'
  | 'crypto'
  | 'stocks';

export type ScreenerColumnPreset = 'overview' | 'performance' | 'technicals' | 'volatility';

export type ScreenerQuickFilter =
  | 'all'
  | 'bullish'
  | 'bearish'
  | 'strong_tech'
  | 'high_vol'
  | 'near_high'
  | 'near_low'
  | 'macro_tailwind';

export type TechRatingLabel = 'Strong buy' | 'Buy' | 'Neutral' | 'Sell' | 'Strong sell';

export interface ScreenerUniverseItem {
  symbol: string;
  shortName: string;
  description: string;
  category: ScreenerCategory;
  watchlistGroups: string[];
  watchlistSection?: string;
}

export interface ScreenerRowData {
  symbol: string;
  shortName: string;
  description: string;
  price: number;
  change: number;
  changePercent: number;
  change1h: number | null;
  change4h: number | null;
  perfW: number | null;
  perf1M: number | null;
  perf3M: number | null;
  perf6M: number | null;
  perfYTD: number | null;
  perf1Y: number | null;
  recommendAll: number | null;
  recommendMA: number | null;
  recommendOsc: number | null;
  rating: TechRatingLabel;
  maRating: TechRatingLabel;
  oscRating: TechRatingLabel;
  rsi14: number | null;
  adx14: number | null;
  atr14: number | null;
  volatilityD: number | null;
  high: number | null;
  low: number | null;
  rangePosPct: number | null;
  relVolume: number | null;
  volume: number | null;
  type: string;
  source: 'tv' | 'yahoo';
  updatedAt: string;
}

export interface EnrichedScreenerRow extends ScreenerRowData {
  category: ScreenerCategory;
  watchlistGroups: string[];
  watchlistSection?: string;
  macroBias: 'tailwind' | 'headwind' | 'neutral';
  macroReason: string;
}

export type HeatmapSizeBy = 'mono' | 'volatility' | 'abs_change';
export type HeatmapColorBy =
  | 'change_1d'
  | 'change_4h'
  | 'change_1h'
  | 'perf_w'
  | 'perf_1m'
  | 'perf_ytd'
  | 'tech_rating';
export type HeatmapGroupBy = 'category' | 'watchlist_section' | 'none';
export type HeatmapColorScheme = 'classic' | 'colorblind' | 'monochrome';

export interface HeatmapDisplaySettings {
  showLogo: boolean;
  titleMode: 'symbol' | 'name' | 'none';
  valueMode: 'color_metric' | 'price' | 'none';
  colorScheme: HeatmapColorScheme;
}
