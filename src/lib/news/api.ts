import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  saveWorkspaceJson
} from '../workspace/storage';

export type NewsDisplayMode = 'full' | 'snippet';
export type NewsFeedMode = 'symbol' | 'watchlist' | 'full';

export interface NewsRelatedSymbol {
  symbol: string;
  shortName: string;
}

export interface NewsFlowItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string;
  providerId: string;
  providerName: string;
  providerDomain: string;
  brandColor: string;
  badgeStyle: 'reuters' | 'wordmark' | 'pill';
  displayMode: NewsDisplayMode;
  termsNote: string;
  readTimeMinutes: number;
  symbols: NewsRelatedSymbol[];
}

export interface NewsFlowQuery {
  mode: NewsFeedMode;
  symbol?: string;
  symbols?: string[];
  market?: string;
  topic?: string;
  country?: string;
  provider?: string;
  q?: string;
  force?: boolean;
}

export interface NewsFlowResponse {
  mode: NewsFeedMode;
  queryLabel: string;
  items: NewsFlowItem[];
  cached: boolean;
  stale: boolean;
  tavilyConfigured: boolean;
  budget?: {
    usedToday: number;
    dailySoftCap: number;
    cacheTtlMinutes: number;
  };
  updatedAt: string;
  notice?: string;
}

export interface NewsArticlePayload {
  url: string;
  displayMode: NewsDisplayMode;
  providerId: string;
  providerName: string;
  brandColor: string;
  termsNote: string;
  fullTextAvailable: boolean;
  paragraphs: string[];
  readTimeMinutes: number;
  cached: boolean;
  fetchedAt: string;
}

export interface SymbolSparkline {
  symbol: string;
  shortName: string;
  description: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  points: number[];
  periodLabel: string;
  updatedAt: string;
}

export interface SavedNewsFeed {
  id: string;
  name: string;
  followChart: boolean;
  instrument: string | null;
  watchlistId: string | null;
  market: string | null;
  topic: string | null;
  country: string | null;
  provider: string | null;
  createdAt: string;
}

export interface NewsFlowWorkspaceState {
  savedFeeds: SavedNewsFeed[];
  readIds: string[];
}

export interface NewsFilterOption {
  id: string;
  label: string;
  meta?: string;
}

export const MARKET_OPTIONS: NewsFilterOption[] = [
  { id: 'commodities', label: 'Commodities', meta: 'Gold, Silver, Oil' },
  { id: 'forex', label: 'Forex', meta: 'Major & Cross FX' },
  { id: 'indices', label: 'Indices', meta: 'SPX, NAS100, US30' },
  { id: 'crypto', label: 'Crypto', meta: 'BTC, ETH' },
  { id: 'stocks', label: 'Stocks', meta: 'Equities & Tech' },
  { id: 'bonds', label: 'Bonds & Rates', meta: 'Yields, Treasuries' }
];

export const TOPIC_OPTIONS: NewsFilterOption[] = [
  { id: 'macro', label: 'Macro & Inflation', meta: 'CPI, NFP, GDP' },
  { id: 'central-banks', label: 'Central Banks', meta: 'Fed, ECB, BoE, BoJ' },
  { id: 'geopolitics', label: 'Geopolitics', meta: 'Trade, Shipping, Tariffs' },
  { id: 'energy-metals', label: 'Energy & Metals', meta: 'OPEC, EIA, Bullion' },
  { id: 'earnings', label: 'Corporate Activity', meta: 'Earnings, M&A' },
  { id: 'crypto', label: 'Crypto Topics', meta: 'ETFs, Regulation' }
];

export const COUNTRY_OPTIONS: NewsFilterOption[] = [
  { id: 'US', label: 'United States', meta: 'USD' },
  { id: 'EU', label: 'Eurozone', meta: 'EUR' },
  { id: 'GB', label: 'United Kingdom', meta: 'GBP' },
  { id: 'JP', label: 'Japan', meta: 'JPY' },
  { id: 'CN', label: 'China', meta: 'CNY' },
  { id: 'AU', label: 'Australia', meta: 'AUD' },
  { id: 'CA', label: 'Canada', meta: 'CAD' },
  { id: 'CH', label: 'Switzerland', meta: 'CHF' }
];

export const PROVIDER_OPTIONS: NewsFilterOption[] = [
  { id: 'reuters', label: 'Reuters', meta: 'Summary + Link' },
  { id: 'fxstreet', label: 'FXStreet', meta: 'Summary + Link' },
  { id: 'kitco', label: 'Kitco News', meta: 'Summary + Link' },
  { id: 'oilprice', label: 'OilPrice', meta: 'Summary + Link' },
  { id: 'eia', label: 'U.S. EIA', meta: 'Full text · Public domain' },
  { id: 'federalreserve', label: 'Federal Reserve', meta: 'Full text · Public domain' },
  { id: 'bls', label: 'U.S. BLS', meta: 'Full text · Public domain' },
  { id: 'bea', label: 'U.S. BEA', meta: 'Full text · Public domain' },
  { id: 'ecb', label: 'ECB', meta: 'Full text · CC BY 4.0' },
  { id: 'cnbc', label: 'CNBC', meta: 'Summary + Link' },
  { id: 'marketwatch', label: 'MarketWatch', meta: 'Summary + Link' },
  { id: 'investing', label: 'Investing.com', meta: 'Summary + Link' },
  { id: 'forexlive', label: 'ForexLive', meta: 'Summary + Link' },
  { id: 'coindesk', label: 'CoinDesk', meta: 'Summary + Link' },
  { id: 'cointelegraph', label: 'Cointelegraph', meta: 'Summary + Link' },
  { id: 'globenewswire', label: 'GlobeNewswire', meta: 'Summary + Link' }
];

const WORKSPACE_KEY = 'news-flow';
const CLIENT_FEED_TTL_MS = 5 * 60 * 1000; // 5m local cache to avoid redundant fetches across tab switches
const CLIENT_SPARKLINE_TTL_MS = 5 * 60 * 1000;
const CLIENT_ARTICLE_TTL_MS = 60 * 60 * 1000;

const clientFeedCache = new Map<string, { data: NewsFlowResponse; fetchedAt: number }>();
const clientArticleCache = new Map<string, { data: NewsArticlePayload; fetchedAt: number }>();
const clientSparklineCache = new Map<string, { data: SymbolSparkline; fetchedAt: number }>();

function buildFeedCacheKey(q: NewsFlowQuery): string {
  const syms = q.symbols ? [...q.symbols].map((s) => s.toUpperCase()).sort().join(',') : '';
  return [
    q.mode,
    (q.symbol ?? '').toUpperCase(),
    syms,
    (q.market ?? '').toLowerCase(),
    (q.topic ?? '').toLowerCase(),
    (q.country ?? '').toUpperCase(),
    (q.provider ?? '').toLowerCase(),
    (q.q ?? '').trim().toLowerCase()
  ].join('|');
}

export async function fetchNewsFlow(
  query: NewsFlowQuery,
  signal?: AbortSignal
): Promise<NewsFlowResponse> {
  const key = buildFeedCacheKey(query);
  const cached = clientFeedCache.get(key);
  if (!query.force && cached && Date.now() - cached.fetchedAt < CLIENT_FEED_TTL_MS) {
    return cached.data;
  }

  const params = new URLSearchParams();
  params.set('mode', query.mode);
  if (query.symbol) params.set('symbol', query.symbol);
  if (query.symbols && query.symbols.length > 0) params.set('symbols', query.symbols.join(','));
  if (query.market) params.set('market', query.market);
  if (query.topic) params.set('topic', query.topic);
  if (query.country) params.set('country', query.country);
  if (query.provider) params.set('provider', query.provider);
  if (query.q && query.q.trim()) params.set('q', query.q.trim());
  if (query.force) params.set('force', '1');

  const url = `${getApiBaseUrl()}/api/news?${params.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!res.ok) {
    throw new Error(`News Flow API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as NewsFlowResponse;
  clientFeedCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

export async function fetchNewsArticle(
  articleUrl: string,
  signal?: AbortSignal
): Promise<NewsArticlePayload> {
  const cached = clientArticleCache.get(articleUrl);
  if (cached && Date.now() - cached.fetchedAt < CLIENT_ARTICLE_TTL_MS) {
    return cached.data;
  }

  const url = `${getApiBaseUrl()}/api/news/article?url=${encodeURIComponent(articleUrl)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!res.ok) {
    throw new Error(`Article API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as NewsArticlePayload;
  clientArticleCache.set(articleUrl, { data, fetchedAt: Date.now() });
  return data;
}

export async function fetchSymbolSparkline(
  symbol: string,
  signal?: AbortSignal
): Promise<SymbolSparkline> {
  const key = symbol.trim().toUpperCase();
  const cached = clientSparklineCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CLIENT_SPARKLINE_TTL_MS) {
    return cached.data;
  }

  const url = `${getApiBaseUrl()}/api/quotes/sparkline?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!res.ok) {
    throw new Error(`Sparkline API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as SymbolSparkline;
  clientSparklineCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

export async function loadNewsFlowWorkspace(): Promise<NewsFlowWorkspaceState> {
  const fallback: NewsFlowWorkspaceState = { savedFeeds: [], readIds: [] };
  const loaded = await loadWorkspaceJson<NewsFlowWorkspaceState>(WORKSPACE_KEY, fallback);
  return {
    savedFeeds: Array.isArray(loaded?.savedFeeds) ? loaded.savedFeeds : [],
    readIds: Array.isArray(loaded?.readIds) ? loaded.readIds.slice(-250) : []
  };
}

export async function saveNewsFlowWorkspace(data: NewsFlowWorkspaceState): Promise<void> {
  await saveWorkspaceJson(WORKSPACE_KEY, {
    savedFeeds: data.savedFeeds.slice(0, 30),
    readIds: data.readIds.slice(-250)
  });
}

export function createSavedFeedId(): string {
  return makeWorkspaceId('nf');
}

export function formatTimeAgo(isoTimestamp: string, nowMs = Date.now()): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return 'Recently';
  const diffSec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms));
}

export function formatArticleMetaDate(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return '';
  try {
    const dt = new Date(ms);
    const datePart = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(dt);
    const timePart = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(dt);
    const offsetMin = -dt.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const absH = Math.floor(Math.abs(offsetMin) / 60);
    const absM = Math.abs(offsetMin) % 60;
    const tzLabel = absM === 0 ? `GMT${sign}${absH}` : `GMT${sign}${absH}:${absM < 10 ? '0' : ''}${absM}`;
    return `${datePart}, ${timePart} ${tzLabel}`;
  } catch {
    return isoTimestamp.slice(0, 16).replace('T', ' ');
  }
}

export function formatReadTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 1) return 'Less than 1 min read';
  return `${Math.round(minutes)} min read`;
}
