export type SourceDisplayMode = 'full' | 'snippet';

export interface NewsSourcePolicy {
  id: string;
  name: string;
  domains: string[];
  displayMode: SourceDisplayMode;
  brandColor: string;
  badgeStyle?: 'reuters' | 'wordmark' | 'pill';
  termsNote: string;
}

/**
 * Source-by-source Terms of Use & copyright display policy.
 *
 * - `full`: U.S. federal government public-domain works (17 U.S.C. § 105) or
 *   open CC BY 4.0 institutional publications where full article text may be
 *   rendered in-app with attribution and link back.
 * - `snippet`: Commercial publishers & news wires whose Terms of Use restrict
 *   republishing full article text. For these we display only the headline,
 *   a concise fair-use snippet, attribution, and a direct link to the source.
 */
export const NEWS_SOURCES: NewsSourcePolicy[] = [
  // ---- Permitted Full-Text Sources (Public Domain / CC BY 4.0) ----
  {
    id: 'federalreserve',
    name: 'Federal Reserve',
    domains: ['federalreserve.gov'],
    displayMode: 'full',
    brandColor: '#1f6feb',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (U.S. Federal Reserve Board, 17 U.S.C. § 105). Full release text displayed with attribution.'
  },
  {
    id: 'eia',
    name: 'U.S. EIA',
    domains: ['eia.gov'],
    displayMode: 'full',
    brandColor: '#0072ce',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (U.S. Energy Information Administration, 17 U.S.C. § 105). Full report text displayed with attribution.'
  },
  {
    id: 'bls',
    name: 'U.S. BLS',
    domains: ['bls.gov'],
    displayMode: 'full',
    brandColor: '#2563eb',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (U.S. Bureau of Labor Statistics, 17 U.S.C. § 105). Full release text displayed with attribution.'
  },
  {
    id: 'bea',
    name: 'U.S. BEA',
    domains: ['bea.gov'],
    displayMode: 'full',
    brandColor: '#1d4ed8',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (U.S. Bureau of Economic Analysis, 17 U.S.C. § 105). Full release text displayed with attribution.'
  },
  {
    id: 'treasury',
    name: 'U.S. Treasury',
    domains: ['treasury.gov', 'home.treasury.gov'],
    displayMode: 'full',
    brandColor: '#0f766e',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (U.S. Department of the Treasury, 17 U.S.C. § 105). Full release text displayed with attribution.'
  },
  {
    id: 'cftc',
    name: 'CFTC',
    domains: ['cftc.gov'],
    displayMode: 'full',
    brandColor: '#0369a1',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (Commodity Futures Trading Commission, 17 U.S.C. § 105). Full release text displayed with attribution.'
  },
  {
    id: 'sec',
    name: 'U.S. SEC',
    domains: ['sec.gov'],
    displayMode: 'full',
    brandColor: '#1e40af',
    badgeStyle: 'wordmark',
    termsNote: 'Public domain (U.S. Securities and Exchange Commission, 17 U.S.C. § 105). Full release text displayed with attribution.'
  },
  {
    id: 'ecb',
    name: 'ECB',
    domains: ['ecb.europa.eu'],
    displayMode: 'full',
    brandColor: '#003399',
    badgeStyle: 'wordmark',
    termsNote: 'European Central Bank (CC BY 4.0 reuse policy). Full release text displayed with source attribution.'
  },

  // ---- Snippet + Attribution + External Link Only (Commercial / Copyrighted) ----
  {
    id: 'reuters',
    name: 'Reuters',
    domains: ['reuters.com'],
    displayMode: 'snippet',
    brandColor: '#ff8000',
    badgeStyle: 'reuters',
    termsNote: 'Reuters copyright & Terms of Use restrict full-text republication. Showing summary preview with link to Reuters.'
  },
  {
    id: 'fxstreet',
    name: 'FXStreet',
    domains: ['fxstreet.com'],
    displayMode: 'snippet',
    brandColor: '#e65100',
    badgeStyle: 'wordmark',
    termsNote: 'FXStreet Terms of Use restrict full-text redistribution. Showing summary preview with link to FXStreet.'
  },
  {
    id: 'kitco',
    name: 'Kitco News',
    domains: ['kitco.com'],
    displayMode: 'snippet',
    brandColor: '#d97706',
    badgeStyle: 'wordmark',
    termsNote: 'Kitco Terms of Use restrict full-text redistribution. Showing summary preview with link to Kitco.'
  },
  {
    id: 'oilprice',
    name: 'OilPrice',
    domains: ['oilprice.com'],
    displayMode: 'snippet',
    brandColor: '#dc2626',
    badgeStyle: 'wordmark',
    termsNote: 'OilPrice Terms of Use restrict full-text redistribution. Showing summary preview with link to OilPrice.'
  },
  {
    id: 'cnbc',
    name: 'CNBC',
    domains: ['cnbc.com'],
    displayMode: 'snippet',
    brandColor: '#005596',
    badgeStyle: 'wordmark',
    termsNote: 'CNBC Terms of Use restrict full-text redistribution. Showing summary preview with link to CNBC.'
  },
  {
    id: 'marketwatch',
    name: 'MarketWatch',
    domains: ['marketwatch.com'],
    displayMode: 'snippet',
    brandColor: '#089981',
    badgeStyle: 'wordmark',
    termsNote: 'MarketWatch / Dow Jones Terms of Use restrict full-text redistribution. Showing summary preview with link to MarketWatch.'
  },
  {
    id: 'investing',
    name: 'Investing.com',
    domains: ['investing.com'],
    displayMode: 'snippet',
    brandColor: '#f59e0b',
    badgeStyle: 'wordmark',
    termsNote: 'Investing.com Terms of Use restrict full-text redistribution. Showing summary preview with link to Investing.com.'
  },
  {
    id: 'bloomberg',
    name: 'Bloomberg',
    domains: ['bloomberg.com'],
    displayMode: 'snippet',
    brandColor: '#7c3aed',
    badgeStyle: 'wordmark',
    termsNote: 'Bloomberg Terms of Use restrict full-text redistribution. Showing summary preview with link to Bloomberg.'
  },
  {
    id: 'forexlive',
    name: 'ForexLive',
    domains: ['forexlive.com'],
    displayMode: 'snippet',
    brandColor: '#16a34a',
    badgeStyle: 'wordmark',
    termsNote: 'ForexLive Terms of Use restrict full-text redistribution. Showing summary preview with link to ForexLive.'
  },
  {
    id: 'yahoo',
    name: 'Yahoo Finance',
    domains: ['finance.yahoo.com', 'yahoo.com'],
    displayMode: 'snippet',
    brandColor: '#7e22ce',
    badgeStyle: 'wordmark',
    termsNote: 'Yahoo Finance Terms of Use restrict full-text redistribution. Showing summary preview with link to Yahoo Finance.'
  },
  {
    id: 'seekingalpha',
    name: 'Seeking Alpha',
    domains: ['seekingalpha.com'],
    displayMode: 'snippet',
    brandColor: '#ea580c',
    badgeStyle: 'wordmark',
    termsNote: 'Seeking Alpha Terms of Use restrict full-text redistribution. Showing summary preview with link to Seeking Alpha.'
  },
  {
    id: 'coindesk',
    name: 'CoinDesk',
    domains: ['coindesk.com'],
    displayMode: 'snippet',
    brandColor: '#2563eb',
    badgeStyle: 'wordmark',
    termsNote: 'CoinDesk Terms of Use restrict full-text redistribution. Showing summary preview with link to CoinDesk.'
  },
  {
    id: 'cointelegraph',
    name: 'Cointelegraph',
    domains: ['cointelegraph.com'],
    displayMode: 'snippet',
    brandColor: '#eab308',
    badgeStyle: 'wordmark',
    termsNote: 'Cointelegraph Terms of Use restrict full-text redistribution. Showing summary preview with link to Cointelegraph.'
  },
  {
    id: 'globenewswire',
    name: 'GlobeNewswire',
    domains: ['globenewswire.com'],
    displayMode: 'snippet',
    brandColor: '#0284c7',
    badgeStyle: 'wordmark',
    termsNote: 'GlobeNewswire Terms of Use restrict automated full-text harvesting. Showing summary preview with link to GlobeNewswire.'
  },
  {
    id: 'benzinga',
    name: 'Benzinga',
    domains: ['benzinga.com'],
    displayMode: 'snippet',
    brandColor: '#0ea5e9',
    badgeStyle: 'wordmark',
    termsNote: 'Benzinga Terms of Use restrict full-text redistribution. Showing summary preview with link to Benzinga.'
  },
  {
    id: 'ft',
    name: 'Financial Times',
    domains: ['ft.com'],
    displayMode: 'snippet',
    brandColor: '#f97316',
    badgeStyle: 'wordmark',
    termsNote: 'Financial Times Terms of Use restrict full-text redistribution. Showing summary preview with link to FT.'
  },
  {
    id: 'wsj',
    name: 'Wall Street Journal',
    domains: ['wsj.com'],
    displayMode: 'snippet',
    brandColor: '#525252',
    badgeStyle: 'wordmark',
    termsNote: 'Dow Jones / WSJ Terms of Use restrict full-text redistribution. Showing summary preview with link to WSJ.'
  }
];

/** Curated default domains passed to Tavily so the feed stays high-signal and free of low-quality blogs. */
export const DEFAULT_NEWS_DOMAINS: string[] = [
  'reuters.com',
  'fxstreet.com',
  'kitco.com',
  'oilprice.com',
  'cnbc.com',
  'marketwatch.com',
  'investing.com',
  'forexlive.com',
  'finance.yahoo.com',
  'coindesk.com',
  'cointelegraph.com',
  'globenewswire.com',
  'federalreserve.gov',
  'eia.gov',
  'bls.gov',
  'bea.gov',
  'ecb.europa.eu'
];

export function normalizeHostname(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function matchSourcePolicyByUrl(urlStr: string): NewsSourcePolicy {
  const host = normalizeHostname(urlStr);
  if (host) {
    for (const src of NEWS_SOURCES) {
      for (const d of src.domains) {
        if (host === d || host.endsWith(`.${d}`)) {
          return src;
        }
      }
    }
  }

  const label = host
    ? host
        .split('.')
        .slice(0, -1)
        .join('.')
        .replace(/^finance\./, '')
        .replace(/^news\./, '')
    : 'News';
  const pretty = label
    ? label.charAt(0).toUpperCase() + label.slice(1)
    : 'Financial News';

  return {
    id: host || 'web',
    name: pretty,
    domains: host ? [host] : [],
    displayMode: 'snippet',
    brandColor: '#737373',
    badgeStyle: 'wordmark',
    termsNote: 'Showing summary preview with attribution. Open the original source for the full article.'
  };
}

export function findSourcePolicyById(providerId: string): NewsSourcePolicy | null {
  const clean = providerId.trim().toLowerCase();
  if (!clean) return null;
  for (const src of NEWS_SOURCES) {
    if (src.id === clean || src.name.toLowerCase() === clean) return src;
    if (src.domains.some((d) => d === clean || d.includes(clean))) return src;
  }
  return null;
}
