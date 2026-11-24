import { isTavilyConfigured } from '../ai/tavily.js';
import {
  DEFAULT_NEWS_DOMAINS,
  NEWS_SOURCES,
  findSourcePolicyById,
  matchSourcePolicyByUrl,
  type SourceDisplayMode
} from './sources.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const TIMEOUT_MS = 12_000;

/**
 * Caching & Tavily Free Plan (1,000 credits/month, 100 RPM) budget guardrails:
 * - Basic search = 1 credit/call; Basic extract = 1 credit per 5 URLs (0.2 credit/URL).
 * - Fresh feed cache: 15 minutes per normalized filter key.
 * - Stale fallback cache: 6 hours (served gracefully on upstream error or daily cap).
 * - Force refresh cooldown: 60 seconds per query key.
 * - Permitted full-text extraction cache: 24 hours per URL (only public-domain / CC BY 4.0).
 * - Daily soft search budget: 25 news search credits/day (~750/mo max, leaving room for AI chat).
 */
const FEED_TTL_MS = 15 * 60 * 1000;
const FEED_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const FORCE_COOLDOWN_MS = 60 * 1000;
const ARTICLE_TTL_MS = 24 * 60 * 60 * 1000;
const DAILY_SEARCH_SOFT_CAP = 25;
const MAX_SNIPPET_CHARS = 520;

export interface NewsRelatedSymbol {
  symbol: string; // e.g. OANDA:XAUUSD
  shortName: string; // e.g. XAUUSD
}

export interface NewsFlowItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string; // ISO 8601
  providerId: string;
  providerName: string;
  providerDomain: string;
  brandColor: string;
  badgeStyle: 'reuters' | 'wordmark' | 'pill';
  displayMode: SourceDisplayMode;
  termsNote: string;
  readTimeMinutes: number;
  symbols: NewsRelatedSymbol[];
}

export interface NewsFlowRequest {
  mode: 'symbol' | 'watchlist' | 'full';
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
  mode: 'symbol' | 'watchlist' | 'full';
  queryLabel: string;
  items: NewsFlowItem[];
  cached: boolean;
  stale: boolean;
  tavilyConfigured: boolean;
  budget: {
    usedToday: number;
    dailySoftCap: number;
    cacheTtlMinutes: number;
  };
  updatedAt: string;
  notice?: string;
}

export interface NewsArticleResponse {
  url: string;
  displayMode: SourceDisplayMode;
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

interface FeedCacheEntry {
  items: NewsFlowItem[];
  queryLabel: string;
  fetchedAt: number;
}

interface ArticleCacheEntry {
  paragraphs: string[];
  readTimeMinutes: number;
  fetchedAt: number;
}

const feedCache = new Map<string, FeedCacheEntry>();
const feedInflight = new Map<string, Promise<NewsFlowResponse>>();
const articleCache = new Map<string, ArticleCacheEntry>();
const articleInflight = new Map<string, Promise<NewsArticleResponse>>();

let budgetDayKey = new Date().toISOString().slice(0, 10);
let dailySearchCredits = 0;

function checkAndResetBudgetDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDayKey) {
    budgetDayKey = today;
    dailySearchCredits = 0;
  }
}

function consumeSearchCredit(): boolean {
  checkAndResetBudgetDay();
  if (dailySearchCredits >= DAILY_SEARCH_SOFT_CAP) return false;
  dailySearchCredits += 1;
  return true;
}

interface SymbolMeta {
  shortName: string;
  fullSymbol: string;
  queryTerms: string;
  keywords: RegExp;
}

const SYMBOL_CATALOG: SymbolMeta[] = [
  {
    shortName: 'XAUUSD',
    fullSymbol: 'OANDA:XAUUSD',
    queryTerms: 'gold price XAUUSD spot gold bullion precious metals',
    keywords: /\b(gold|xau|xauusd|bullion|comex gold|precious metals)\b/i
  },
  {
    shortName: 'XAGUSD',
    fullSymbol: 'OANDA:XAGUSD',
    queryTerms: 'silver price XAGUSD spot silver precious metals',
    keywords: /\b(silver|xag|xagusd)\b/i
  },
  {
    shortName: 'USOIL',
    fullSymbol: 'TVC:USOIL',
    queryTerms: 'WTI crude oil prices USOIL OPEC EIA energy market',
    keywords: /\b(wti|crude oil|oil price|oil prices|usoil|opec|barrels?|petroleum|refinery)\b/i
  },
  {
    shortName: 'UKOIL',
    fullSymbol: 'TVC:UKOIL',
    queryTerms: 'Brent crude oil prices UKOIL OPEC energy market',
    keywords: /\b(brent|ukoil|north sea crude)\b/i
  },
  {
    shortName: 'DXY',
    fullSymbol: 'TVC:DXY',
    queryTerms: 'US Dollar Index DXY Federal Reserve Treasury yields greenback',
    keywords: /\b(dollar index|dxy|greenback|u\.s\. dollar|us dollar|federal reserve|fomc|powell|treasury yields?)\b/i
  },
  {
    shortName: 'EURUSD',
    fullSymbol: 'OANDA:EURUSD',
    queryTerms: 'EUR/USD euro dollar ECB eurozone forex',
    keywords: /\b(eur\/usd|eurusd|eurozone|\beuro\b|\becb\b|lagarde)\b/i
  },
  {
    shortName: 'GBPUSD',
    fullSymbol: 'OANDA:GBPUSD',
    queryTerms: 'GBP/USD British pound sterling Bank of England UK forex',
    keywords: /\b(gbp\/usd|gbpusd|sterling|british pound|bank of england|\bboe\b)\b/i
  },
  {
    shortName: 'USDJPY',
    fullSymbol: 'OANDA:USDJPY',
    queryTerms: 'USD/JPY Japanese yen Bank of Japan forex',
    keywords: /\b(usd\/jpy|usdjpy|japanese yen|\byen\b|bank of japan|\bboj\b)\b/i
  },
  {
    shortName: 'AUDUSD',
    fullSymbol: 'OANDA:AUDUSD',
    queryTerms: 'AUD/USD Australian dollar RBA forex',
    keywords: /\b(aud\/usd|audusd|aussie dollar|australian dollar|\brba\b)\b/i
  },
  {
    shortName: 'USDCAD',
    fullSymbol: 'OANDA:USDCAD',
    queryTerms: 'USD/CAD Canadian dollar loonie Bank of Canada forex',
    keywords: /\b(usd\/cad|usdcad|loonie|canadian dollar|bank of canada)\b/i
  },
  {
    shortName: 'USDCHF',
    fullSymbol: 'OANDA:USDCHF',
    queryTerms: 'USD/CHF Swiss franc SNB forex',
    keywords: /\b(usd\/chf|usdchf|swiss franc|\bsnb\b)\b/i
  },
  {
    shortName: 'NZDUSD',
    fullSymbol: 'OANDA:NZDUSD',
    queryTerms: 'NZD/USD New Zealand dollar RBNZ forex',
    keywords: /\b(nzd\/usd|nzdusd|kiwi dollar|new zealand dollar|\brbnz\b)\b/i
  },
  {
    shortName: 'NAS100',
    fullSymbol: 'NASDAQ:NDX',
    queryTerms: 'Nasdaq 100 NDX tech stocks Wall Street equities',
    keywords: /\b(nasdaq|ndx|nas100|tech stocks|big tech)\b/i
  },
  {
    shortName: 'SPX',
    fullSymbol: 'TVC:SPX',
    queryTerms: 'S&P 500 SPX Wall Street US stocks equities',
    keywords: /\b(s&p 500|s&p500|\bspx\b|wall street|u\.s\. stocks)\b/i
  },
  {
    shortName: 'US30',
    fullSymbol: 'TVC:DJI',
    queryTerms: 'Dow Jones Industrial Average US30 DJI Wall Street',
    keywords: /\b(dow jones|\bdjia?\b|us30)\b/i
  },
  {
    shortName: 'BTCUSD',
    fullSymbol: 'BITSTAMP:BTCUSD',
    queryTerms: 'Bitcoin BTC price crypto ETF market news',
    keywords: /\b(bitcoin|\bbtc\b|btcusd)\b/i
  },
  {
    shortName: 'ETHUSD',
    fullSymbol: 'BITSTAMP:ETHUSD',
    queryTerms: 'Ethereum ETH price crypto market news',
    keywords: /\b(ethereum|\beth\b|ethusd|ether)\b/i
  },
  {
    shortName: 'NVDA',
    fullSymbol: 'NASDAQ:NVDA',
    queryTerms: 'NVIDIA NVDA stock AI chips earnings news',
    keywords: /\b(nvidia|nvda)\b/i
  },
  {
    shortName: 'AAPL',
    fullSymbol: 'NASDAQ:AAPL',
    queryTerms: 'Apple AAPL stock earnings news',
    keywords: /\b(apple inc|aapl|\bapple\b.*stock)\b/i
  },
  {
    shortName: 'TSLA',
    fullSymbol: 'NASDAQ:TSLA',
    queryTerms: 'Tesla TSLA stock EV deliveries earnings news',
    keywords: /\b(tesla|tsla)\b/i
  }
];

const MARKET_TERMS: Record<string, string> = {
  commodities: 'commodities gold silver crude oil metals energy',
  forex: 'forex currency market EUR/USD GBP/USD USD/JPY US dollar',
  indices: 'stock market S&P 500 Nasdaq Dow Jones equities',
  crypto: 'cryptocurrency Bitcoin Ethereum digital assets',
  stocks: 'equities corporate earnings Wall Street stocks',
  bonds: 'Treasury yields bond market Federal Reserve interest rates'
};

const TOPIC_TERMS: Record<string, string> = {
  macro: 'inflation CPI GDP employment macroeconomics economic data',
  'central-banks': 'Federal Reserve ECB Bank of England Bank of Japan interest rates monetary policy',
  geopolitics: 'geopolitics tariffs trade war Middle East sanctions shipping risks',
  earnings: 'earnings results guidance revenue corporate activity M&A',
  'energy-metals': 'OPEC oil supply inventories gold central bank buying metals',
  crypto: 'crypto ETF Bitcoin regulation DeFi digital assets'
};

const COUNTRY_TERMS: Record<string, string> = {
  US: 'United States US economy Federal Reserve Wall Street',
  EU: 'Eurozone Europe ECB European economy',
  GB: 'United Kingdom UK economy Bank of England London',
  JP: 'Japan Japanese economy Bank of Japan Tokyo',
  CN: 'China Chinese economy PBOC Beijing',
  AU: 'Australia Australian economy RBA',
  CA: 'Canada Canadian economy Bank of Canada',
  CH: 'Switzerland Swiss economy SNB'
};

function normalizeShortTicker(raw: string): string {
  const cleaned = (raw || '').trim().toUpperCase();
  const colon = cleaned.indexOf(':');
  const ticker = colon >= 0 ? cleaned.slice(colon + 1) : cleaned;
  if (ticker === 'GOLD') return 'XAUUSD';
  if (ticker === 'SILVER') return 'XAGUSD';
  if (ticker === 'WTI' || ticker === 'WTICOUSD' || ticker === 'OILUSD') return 'USOIL';
  if (ticker === 'BRENT') return 'UKOIL';
  if (ticker === 'NDX' || ticker === 'NAS100USD') return 'NAS100';
  if (ticker === 'US500') return 'SPX';
  if (ticker === 'DJI') return 'US30';
  return ticker;
}

function findSymbolMeta(raw: string): SymbolMeta | null {
  const short = normalizeShortTicker(raw);
  return SYMBOL_CATALOG.find((s) => s.shortName === short) ?? null;
}

function hashId(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `nf_${(h >>> 0).toString(36)}`;
}

function parsePublishedIso(raw: string | undefined, fallbackOffsetMinutes: number): string {
  if (raw && raw.trim()) {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(Date.now() - fallbackOffsetMinutes * 60_000).toISOString();
}

function cleanSnippet(raw: string, title: string): string {
  let text = (raw || '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.toLowerCase().startsWith(title.toLowerCase())) {
    text = text.slice(title.length).replace(/^[\s\-–—:|.]+/, '').trim();
  }

  if (text.length > MAX_SNIPPET_CHARS) {
    const cut = text.slice(0, MAX_SNIPPET_CHARS);
    const lastPeriod = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = (lastPeriod > 180 ? cut.slice(0, lastPeriod + 1) : `${cut.trim()}…`);
  }

  return text;
}

function estimateReadMinutes(textLength: number, displayMode: SourceDisplayMode): number {
  const words = Math.max(1, Math.round(textLength / 5));
  if (displayMode === 'snippet') {
    // Typical financial news story read time estimated from snippet density
    return Math.max(1, Math.min(5, Math.round(words / 45)));
  }
  return Math.max(1, Math.round(words / 220));
}

function detectRelatedSymbols(
  title: string,
  snippet: string,
  primarySymbol?: string,
  watchlistSymbols?: string[]
): NewsRelatedSymbol[] {
  const haystack = `${title} ${snippet}`;
  const found: NewsRelatedSymbol[] = [];
  const seen = new Set<string>();

  const addMeta = (meta: SymbolMeta) => {
    if (seen.has(meta.shortName)) return;
    seen.add(meta.shortName);
    found.push({ symbol: meta.fullSymbol, shortName: meta.shortName });
  };

  // Prioritize explicit symbol matches in headline/snippet
  for (const meta of SYMBOL_CATALOG) {
    if (meta.keywords.test(haystack)) {
      addMeta(meta);
      if (found.length >= 4) break;
    }
  }

  // Ensure primary queried symbol appears first when filtering by a single symbol
  if (primarySymbol) {
    const short = normalizeShortTicker(primarySymbol);
    const meta = findSymbolMeta(short);
    const entry: NewsRelatedSymbol = meta
      ? { symbol: meta.fullSymbol, shortName: meta.shortName }
      : { symbol: primarySymbol.toUpperCase(), shortName: short };

    const existingIdx = found.findIndex((f) => f.shortName === entry.shortName);
    if (existingIdx > 0) {
      found.splice(existingIdx, 1);
      found.unshift(entry);
    } else if (existingIdx === -1) {
      found.unshift(entry);
    }
  } else if (watchlistSymbols && watchlistSymbols.length > 0 && found.length === 0) {
    const first = normalizeShortTicker(watchlistSymbols[0]);
    const meta = findSymbolMeta(first);
    found.push(
      meta ? { symbol: meta.fullSymbol, shortName: meta.shortName } : { symbol: first, shortName: first }
    );
  }

  // Fallback for broad macro stories with no specific asset mention
  if (found.length === 0) {
    if (/\b(oil|energy|opec|gas|crude)\b/i.test(haystack)) {
      addMeta(findSymbolMeta('USOIL')!);
    } else if (/\b(fed|inflation|cpi|yield|rate|treasury|economy)\b/i.test(haystack)) {
      addMeta(findSymbolMeta('DXY')!);
    } else {
      addMeta(findSymbolMeta('SPX')!);
    }
  }

  return found.slice(0, 4);
}

function buildSearchSpec(req: NewsFlowRequest): {
  cacheKey: string;
  query: string;
  queryLabel: string;
  includeDomains: string[];
  days: number;
  primarySymbol?: string;
} {
  const parts: string[] = [];
  let queryLabel = 'Full feed';
  let primarySymbol: string | undefined;

  if (req.mode === 'symbol' && req.symbol && req.symbol.trim()) {
    const short = normalizeShortTicker(req.symbol);
    primarySymbol = short;
    queryLabel = short;
    const meta = findSymbolMeta(short);
    parts.push(meta ? meta.queryTerms : `${short} financial market price news`);
  } else if (req.mode === 'watchlist' && req.symbols && req.symbols.length > 0) {
    const shorts = Array.from(
      new Set(req.symbols.map((s) => normalizeShortTicker(s)).filter(Boolean))
    ).slice(0, 6);
    queryLabel = shorts.length > 0 ? `Watchlist (${shorts.length})` : 'Watchlist';
    const terms = shorts.map((short) => {
      const m = findSymbolMeta(short);
      if (!m) return short;
      // Compact high-signal keywords so 1 Tavily query covers the whole watchlist cleanly
      return m.queryTerms.split(' ').slice(0, 3).join(' ');
    });
    parts.push(`(${terms.join(' OR ')}) market news`);
  } else {
    parts.push('global financial markets gold crude oil forex Federal Reserve stocks crypto breaking news');
  }

  const marketKey = (req.market ?? '').trim().toLowerCase();
  if (marketKey && MARKET_TERMS[marketKey]) {
    parts.push(MARKET_TERMS[marketKey]);
  }

  const topicKey = (req.topic ?? '').trim().toLowerCase();
  if (topicKey && TOPIC_TERMS[topicKey]) {
    parts.push(TOPIC_TERMS[topicKey]);
  }

  const countryKey = (req.country ?? '').trim().toUpperCase();
  if (countryKey && COUNTRY_TERMS[countryKey]) {
    parts.push(COUNTRY_TERMS[countryKey]);
  }

  const customQ = (req.q ?? '').trim().slice(0, 120);
  if (customQ) {
    parts.push(customQ);
  }

  const providerKey = (req.provider ?? '').trim().toLowerCase();
  const providerPolicy = providerKey ? findSourcePolicyById(providerKey) : null;
  let includeDomains = DEFAULT_NEWS_DOMAINS;
  let days = 7;

  if (providerPolicy && providerPolicy.domains.length > 0) {
    includeDomains = providerPolicy.domains;
    if (providerPolicy.displayMode === 'full') {
      days = 30; // Official central bank / EIA / BLS releases publish weekly/monthly
    }
  } else if (primarySymbol === 'USOIL' || primarySymbol === 'UKOIL') {
    includeDomains = [
      'reuters.com',
      'oilprice.com',
      'eia.gov',
      'fxstreet.com',
      'cnbc.com',
      'marketwatch.com',
      'investing.com',
      'finance.yahoo.com'
    ];
  } else if (primarySymbol === 'XAUUSD' || primarySymbol === 'XAGUSD') {
    includeDomains = [
      'reuters.com',
      'fxstreet.com',
      'kitco.com',
      'cnbc.com',
      'marketwatch.com',
      'investing.com',
      'federalreserve.gov',
      'globenewswire.com'
    ];
  } else if (primarySymbol === 'BTCUSD' || primarySymbol === 'ETHUSD') {
    includeDomains = [
      'coindesk.com',
      'cointelegraph.com',
      'reuters.com',
      'fxstreet.com',
      'cnbc.com',
      'investing.com'
    ];
  }

  const normSymbols =
    req.mode === 'watchlist' && req.symbols
      ? Array.from(new Set(req.symbols.map((s) => normalizeShortTicker(s)).filter(Boolean)))
          .sort()
          .slice(0, 6)
          .join(',')
      : '';

  const cacheKey = [
    req.mode,
    primarySymbol ?? '',
    normSymbols,
    marketKey,
    topicKey,
    countryKey,
    providerPolicy?.id ?? providerKey,
    customQ.toLowerCase()
  ].join('|');

  return {
    cacheKey,
    query: parts.join(' ').trim(),
    queryLabel,
    includeDomains,
    days,
    primarySymbol
  };
}

interface TavilySearchResultItem {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  score?: number;
}

interface TavilySearchApiResponse {
  results?: TavilySearchResultItem[];
}

export async function getNewsFlowPayload(req: NewsFlowRequest): Promise<NewsFlowResponse> {
  checkAndResetBudgetDay();
  const configured = isTavilyConfigured();
  const spec = buildSearchSpec(req);
  const nowMs = Date.now();
  const cached = feedCache.get(spec.cacheKey);

  const budgetSnapshot = () => ({
    usedToday: dailySearchCredits,
    dailySoftCap: DAILY_SEARCH_SOFT_CAP,
    cacheTtlMinutes: Math.round(FEED_TTL_MS / 60_000)
  });

  if (!configured) {
    return {
      mode: req.mode,
      queryLabel: spec.queryLabel,
      items: [],
      cached: false,
      stale: false,
      tavilyConfigured: false,
      budget: budgetSnapshot(),
      updatedAt: new Date(nowMs).toISOString(),
      notice: 'TAVILY_API_KEY is not configured on the backend server.'
    };
  }

  const ageMs = cached ? nowMs - cached.fetchedAt : Infinity;
  const allowForce = Boolean(req.force) && ageMs >= FORCE_COOLDOWN_MS;

  if (cached && ageMs < FEED_TTL_MS && !allowForce) {
    return {
      mode: req.mode,
      queryLabel: cached.queryLabel,
      items: cached.items,
      cached: true,
      stale: false,
      tavilyConfigured: true,
      budget: budgetSnapshot(),
      updatedAt: new Date(cached.fetchedAt).toISOString()
    };
  }

  const existing = feedInflight.get(spec.cacheKey);
  if (existing) return existing;

  // Enforce daily soft cap to stay safely inside Tavily Free plan (1,000 credits/month)
  if (!consumeSearchCredit()) {
    if (cached && ageMs < FEED_STALE_TTL_MS) {
      return {
        mode: req.mode,
        queryLabel: cached.queryLabel,
        items: cached.items,
        cached: true,
        stale: true,
        tavilyConfigured: true,
        budget: budgetSnapshot(),
        updatedAt: new Date(cached.fetchedAt).toISOString(),
        notice: 'Daily Tavily news budget reached; serving cached feed until reset.'
      };
    }
    return {
      mode: req.mode,
      queryLabel: spec.queryLabel,
      items: [],
      cached: false,
      stale: true,
      tavilyConfigured: true,
      budget: budgetSnapshot(),
      updatedAt: new Date(nowMs).toISOString(),
      notice: 'Daily Tavily news budget cap reached (25 searches/day) to protect monthly free-tier credits.'
    };
  }

  const task = (async (): Promise<NewsFlowResponse> => {
    const apiKey = (process.env.TAVILY_API_KEY ?? '').trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          query: spec.query,
          topic: spec.days > 14 ? 'general' : 'news',
          search_depth: 'basic', // Strictly 1 credit per request
          days: spec.days,
          max_results: 16,
          include_answer: false,
          include_raw_content: false,
          include_domains: spec.includeDomains
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        console.warn(`[news:tavily] HTTP ${res.status} for ${spec.cacheKey}`);
        if (cached && nowMs - cached.fetchedAt < FEED_STALE_TTL_MS) {
          return {
            mode: req.mode,
            queryLabel: cached.queryLabel,
            items: cached.items,
            cached: true,
            stale: true,
            tavilyConfigured: true,
            budget: budgetSnapshot(),
            updatedAt: new Date(cached.fetchedAt).toISOString(),
            notice: `News provider temporarily returned HTTP ${res.status}; showing cached stories.`
          };
        }
        return {
          mode: req.mode,
          queryLabel: spec.queryLabel,
          items: [],
          cached: false,
          stale: false,
          tavilyConfigured: true,
          budget: budgetSnapshot(),
          updatedAt: new Date(nowMs).toISOString(),
          notice: `News fetch failed (HTTP ${res.status}).`
        };
      }

      const json = (await res.json()) as TavilySearchApiResponse;
      const rawResults = Array.isArray(json.results) ? json.results : [];

      const seenUrls = new Set<string>();
      const items: NewsFlowItem[] = [];

      for (let i = 0; i < rawResults.length; i++) {
        const raw = rawResults[i];
        const title = (raw.title ?? '').replace(/\s+/g, ' ').trim();
        const url = (raw.url ?? '').trim();
        if (!title || !url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        const policy = matchSourcePolicyByUrl(url);
        const snippet = cleanSnippet(raw.content ?? '', title);
        const publishedAt = parsePublishedIso(raw.published_date, 15 + i * 24);
        const symbols = detectRelatedSymbols(title, snippet, spec.primarySymbol, req.symbols);

        let domain = '';
        try {
          domain = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          domain = policy.domains[0] ?? '';
        }

        items.push({
          id: hashId(url),
          title,
          url,
          snippet,
          publishedAt,
          providerId: policy.id,
          providerName: policy.name,
          providerDomain: domain,
          brandColor: policy.brandColor,
          badgeStyle: policy.badgeStyle ?? 'wordmark',
          displayMode: policy.displayMode,
          termsNote: policy.termsNote,
          readTimeMinutes: estimateReadMinutes(snippet.length * 4, policy.displayMode),
          symbols
        });
      }

      // Sort newest first
      items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

      const fetchedAt = Date.now();
      feedCache.set(spec.cacheKey, {
        items,
        queryLabel: spec.queryLabel,
        fetchedAt
      });

      // Bound cache size
      if (feedCache.size > 60) {
        const oldestKey = feedCache.keys().next().value;
        if (oldestKey) feedCache.delete(oldestKey);
      }

      return {
        mode: req.mode,
        queryLabel: spec.queryLabel,
        items,
        cached: false,
        stale: false,
        tavilyConfigured: true,
        budget: budgetSnapshot(),
        updatedAt: new Date(fetchedAt).toISOString()
      };
    } catch (err) {
      console.warn('[news:tavily] fetch failed:', (err as Error).message);
      if (cached && nowMs - cached.fetchedAt < FEED_STALE_TTL_MS) {
        return {
          mode: req.mode,
          queryLabel: cached.queryLabel,
          items: cached.items,
          cached: true,
          stale: true,
          tavilyConfigured: true,
          budget: budgetSnapshot(),
          updatedAt: new Date(cached.fetchedAt).toISOString(),
          notice: 'Upstream timeout; serving cached stories.'
        };
      }
      return {
        mode: req.mode,
        queryLabel: spec.queryLabel,
        items: [],
        cached: false,
        stale: false,
        tavilyConfigured: true,
        budget: budgetSnapshot(),
        updatedAt: new Date(nowMs).toISOString(),
        notice: 'Unable to reach news service right now.'
      };
    } finally {
      clearTimeout(timer);
      feedInflight.delete(spec.cacheKey);
    }
  })();

  feedInflight.set(spec.cacheKey, task);
  return task;
}

function splitCleanParagraphs(rawContent: string): string[] {
  const cleaned = rawContent
    .replace(/\r\n/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');

  const rawBlocks = cleaned
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b.length >= 40 && !/^(cookie|skip to|navigation|menu|share|print|subscribe|breadcrumb)/i.test(b));

  return rawBlocks.slice(0, 24);
}

/**
 * Fetches full article text ONLY for sources verified as public domain (17 U.S.C. § 105)
 * or open CC BY 4.0 reuse (e.g. Federal Reserve, EIA, BLS, BEA, ECB, SEC, CFTC, Treasury).
 * For all commercial / copyrighted publishers, returns `fullTextAvailable: false` immediately
 * without calling Tavily Extract or scraping the publisher.
 */
export async function getNewsArticlePayload(rawUrl: string): Promise<NewsArticleResponse> {
  const url = (rawUrl || '').trim();
  const policy = matchSourcePolicyByUrl(url);
  const nowIso = new Date().toISOString();

  if (!url || policy.displayMode !== 'full') {
    return {
      url,
      displayMode: 'snippet',
      providerId: policy.id,
      providerName: policy.name,
      brandColor: policy.brandColor,
      termsNote: policy.termsNote,
      fullTextAvailable: false,
      paragraphs: [],
      readTimeMinutes: 1,
      cached: false,
      fetchedAt: nowIso
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Unsupported protocol');
    }
  } catch {
    return {
      url,
      displayMode: 'snippet',
      providerId: policy.id,
      providerName: policy.name,
      brandColor: policy.brandColor,
      termsNote: policy.termsNote,
      fullTextAvailable: false,
      paragraphs: [],
      readTimeMinutes: 1,
      cached: false,
      fetchedAt: nowIso
    };
  }

  const nowMs = Date.now();
  const cached = articleCache.get(url);
  if (cached && nowMs - cached.fetchedAt < ARTICLE_TTL_MS) {
    return {
      url,
      displayMode: 'full',
      providerId: policy.id,
      providerName: policy.name,
      brandColor: policy.brandColor,
      termsNote: policy.termsNote,
      fullTextAvailable: cached.paragraphs.length > 0,
      paragraphs: cached.paragraphs,
      readTimeMinutes: cached.readTimeMinutes,
      cached: true,
      fetchedAt: new Date(cached.fetchedAt).toISOString()
    };
  }

  const inflight = articleInflight.get(url);
  if (inflight) return inflight;

  const task = (async (): Promise<NewsArticleResponse> => {
    const apiKey = (process.env.TAVILY_API_KEY ?? '').trim();
    let paragraphs: string[] = [];

    if (apiKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(TAVILY_EXTRACT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            urls: [url],
            extract_depth: 'basic',
            format: 'text'
          }),
          signal: controller.signal
        });
        if (res.ok) {
          const json = (await res.json()) as { results?: { raw_content?: string }[] };
          const text = json.results?.[0]?.raw_content ?? '';
          if (text.trim()) {
            paragraphs = splitCleanParagraphs(text);
          }
        }
      } catch (err) {
        console.warn('[news:extract] failed:', (err as Error).message);
      } finally {
        clearTimeout(timer);
      }
    }

    const totalChars = paragraphs.reduce((acc, p) => acc + p.length, 0);
    const readTimeMinutes = Math.max(1, Math.round(totalChars / 1100));
    const fetchedAt = Date.now();

    if (paragraphs.length > 0) {
      articleCache.set(url, { paragraphs, readTimeMinutes, fetchedAt });
      if (articleCache.size > 80) {
        const oldest = articleCache.keys().next().value;
        if (oldest) articleCache.delete(oldest);
      }
    }

    articleInflight.delete(url);
    return {
      url,
      displayMode: 'full',
      providerId: policy.id,
      providerName: policy.name,
      brandColor: policy.brandColor,
      termsNote: policy.termsNote,
      fullTextAvailable: paragraphs.length > 0,
      paragraphs,
      readTimeMinutes,
      cached: false,
      fetchedAt: new Date(fetchedAt).toISOString()
    };
  })();

  articleInflight.set(url, task);
  return task;
}

export function listNewsProviders() {
  return NEWS_SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    displayMode: s.displayMode,
    brandColor: s.brandColor
  }));
}
