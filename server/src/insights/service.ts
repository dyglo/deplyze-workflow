import { isDeepSeekConfigured } from '../ai/service.js';
import { isTavilyConfigured, runTavilyFinanceSearch } from '../ai/tavily.js';
import {
  computeMacroAlignment,
  getDriversForSymbolFromSnapshot,
  getFredTrendForEvent,
  getMacroSnapshot,
  normalizeShortSymbol
} from './macro.js';
import type {
  EdgeAuditEntryInput,
  EdgeAuditResponse,
  EventPlaybookResponse,
  InsightSource,
  MacroBias,
  MacroRegimeResponse,
  SymbolBriefResponse,
  TechBiasInput,
  TransmissionMove
} from './types.js';

const SYMBOL_BRIEF_TTL_MS = 45 * 60 * 1000; // 45 minutes
const EVENT_PLAYBOOK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const AI_TIMEOUT_MS = 18_000;

interface CachedSymbolBrief {
  base: Omit<SymbolBriefResponse, 'alignment' | 'symbol'>;
  fetchedAt: number;
}

const symbolBriefCache = new Map<string, CachedSymbolBrief>();
const eventPlaybookCache = new Map<string, { data: EventPlaybookResponse; fetchedAt: number }>();

function getDeepSeekChatUrl(): string {
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    .trim()
    .replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function extractJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(fenced) as T;
  } catch {
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(fenced.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callDeepSeekJson<T>(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 480
): Promise<T | null> {
  if (!isDeepSeekConfigured()) return null;
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(getDeepSeekChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      console.warn(`[insights:ai] DeepSeek HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    return extractJsonObject<T>(content);
  } catch (err) {
    console.warn('[insights:ai] structured call failed:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clampStr(v: unknown, fallback: string, maxLen = 150): string {
  if (typeof v !== 'string') return fallback;
  const clean = v.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1).trim()}…` : clean;
}

function searchQueryForSymbol(shortName: string): string {
  const map: Record<string, string> = {
    XAUUSD: 'gold price XAUUSD Fed real yields central bank macro driver',
    XAGUSD: 'silver price XAGUSD industrial demand real yields USD',
    DXY: 'US dollar index DXY Fed Treasury yields macro',
    EURUSD: 'EURUSD ECB Fed rate differential eurozone macro',
    GBPUSD: 'GBPUSD Bank of England UK inflation Fed macro',
    USDJPY: 'USDJPY Bank of Japan US Treasury yields yen intervention',
    AUDUSD: 'AUDUSD RBA China commodities risk sentiment',
    USDCAD: 'USDCAD Bank of Canada crude oil USD macro',
    USDCHF: 'USDCHF Swiss National Bank safe haven USD',
    NZDUSD: 'NZDUSD RBNZ commodities risk sentiment',
    GBPJPY: 'GBPJPY Bank of England Bank of Japan yield spread',
    EURJPY: 'EURJPY ECB Bank of Japan risk sentiment',
    EURGBP: 'EURGBP ECB Bank of England rate spread',
    USOIL: 'WTI crude oil price OPEC inventory macro catalyst',
    UKOIL: 'Brent crude oil price OPEC supply demand macro',
    NAS100: 'Nasdaq 100 NDX Treasury yields AI earnings macro',
    SPX: 'S&P 500 SPX Fed yields earnings macro catalyst',
    US30: 'Dow Jones US30 macro yields economic data',
    BTCUSD: 'Bitcoin BTC macro ETF flows Fed liquidity USD',
    ETHUSD: 'Ethereum ETH ETF flows crypto macro liquidity'
  };
  return map[shortName] ?? `${shortName} market fundamental macro news catalyst`;
}

export async function getMacroRegimePayload(force = false): Promise<MacroRegimeResponse> {
  const snap = await getMacroSnapshot(force);
  return snap.regime;
}

export async function getSymbolBriefPayload(
  rawSymbol: string,
  techBias: TechBiasInput = 'none',
  force = false
): Promise<SymbolBriefResponse> {
  const shortName = normalizeShortSymbol(rawSymbol);
  const symbol = rawSymbol.trim() || shortName;
  const now = Date.now();

  const cached = symbolBriefCache.get(shortName);
  if (!force && cached && now - cached.fetchedAt < SYMBOL_BRIEF_TTL_MS) {
    return {
      symbol,
      ...cached.base,
      alignment: computeMacroAlignment(cached.base.fundamentalBias, techBias)
    };
  }

  const [snap, tavily] = await Promise.all([
    getMacroSnapshot(false),
    isTavilyConfigured()
      ? runTavilyFinanceSearch(searchQueryForSymbol(shortName), {
          topic: 'news',
          maxResults: 4,
          days: 4
        })
      : Promise.resolve(null)
  ]);

  const quant = getDriversForSymbolFromSnapshot(shortName, snap);
  const sources: InsightSource[] = (tavily?.sources ?? []).slice(0, 3).map((s) => ({
    title: s.title,
    url: s.url,
    publishedDate: s.publishedDate
  }));
  const hasFreshCatalyst = sources.length > 0;

  // Deterministic quantitative baseline (always valid even without AI)
  const topDriver = quant.drivers.find((d) => d.impact !== 'neutral') ?? quant.drivers[0];
  let fundamentalBias: MacroBias = quant.bias;
  let headlineSummary =
    fundamentalBias === 'tailwind'
      ? `Macro tailwind: ${topDriver.label} (${topDriver.delta}) supports ${shortName}.`
      : fundamentalBias === 'headwind'
        ? `Macro headwind: ${topDriver.label} (${topDriver.delta}) pressures ${shortName}.`
        : `Balanced macro tape (${snap.regime.summary}); watch upcoming catalyst.`;
  let primaryDriver = `${topDriver.label} at ${topDriver.value} (${topDriver.delta}) — ${topDriver.note}.`;
  let keyRisk =
    fundamentalBias === 'tailwind'
      ? `Sudden reversal in ${topDriver.label} or a hawkish US macro surprise could fade strength.`
      : fundamentalBias === 'headwind'
        ? `Soft US data or yield pullback could trigger a sharp short-covering squeeze.`
        : `Choppy cross-asset tape with no single dominant macro impulse yet.`;
  let invalidationCatalyst =
    sources[0]?.title
      ? `Monitor headline follow-through: ${sources[0].title.slice(0, 95)}.`
      : `Watch next high-impact rate/inflation release or decisive shift in US 10Y yields and DXY.`;

  let aiSynthesized = false;

  const macroContextText = [
    `Instrument: ${shortName} (${symbol})`,
    `Regime: ${snap.regime.summary}`,
    `Quantitative Macro Drivers:`,
    ...quant.drivers.map((d) => `- ${d.label}: ${d.value} (${d.delta}) -> ${d.impact} (${d.note})`),
    `Quantitative Baseline Bias: ${quant.bias}`,
    tavily?.snippets ? `Recent News (last 4 days):\n${tavily.snippets.slice(0, 1800)}` : 'Recent News: none retrieved.'
  ].join('\n');

  interface AiBriefJson {
    fundamentalBias?: string;
    headlineSummary?: string;
    primaryDriver?: string;
    keyRisk?: string;
    invalidationCatalyst?: string;
  }

  const ai = await callDeepSeekJson<AiBriefJson>(
    'You are an institutional macro strategist writing a quiet, ultra-concise non-technical fundamental brief for a trading desk. ' +
      'NEVER mention candlestick patterns, RSI, MACD, moving averages, support/resistance, or chart TA. ' +
      'Focus ONLY on yields, USD, central banks, cross-asset flows, and news catalysts. ' +
      'Return strict JSON with keys: fundamentalBias ("tailwind"|"headwind"|"neutral"), headlineSummary (<=110 chars), primaryDriver (<=125 chars), keyRisk (<=125 chars), invalidationCatalyst (<=125 chars).',
    macroContextText,
    360
  );

  if (ai) {
    aiSynthesized = true;
    if (
      ai.fundamentalBias === 'tailwind' ||
      ai.fundamentalBias === 'headwind' ||
      ai.fundamentalBias === 'neutral'
    ) {
      fundamentalBias = ai.fundamentalBias;
    }
    headlineSummary = clampStr(ai.headlineSummary, headlineSummary, 120);
    primaryDriver = clampStr(ai.primaryDriver, primaryDriver, 140);
    keyRisk = clampStr(ai.keyRisk, keyRisk, 140);
    invalidationCatalyst = clampStr(ai.invalidationCatalyst, invalidationCatalyst, 140);
  }

  const base: Omit<SymbolBriefResponse, 'alignment' | 'symbol'> = {
    shortName,
    fundamentalBias,
    hasFreshCatalyst,
    headlineSummary,
    drivers: quant.drivers,
    primaryDriver,
    keyRisk,
    invalidationCatalyst,
    sources,
    aiSynthesized,
    updatedAt: new Date().toISOString()
  };

  // Cap cache size cleanly
  if (symbolBriefCache.size >= 60) {
    const oldest = symbolBriefCache.keys().next().value;
    if (oldest) symbolBriefCache.delete(oldest);
  }
  symbolBriefCache.set(shortName, { base, fetchedAt: Date.now() });

  return {
    symbol,
    ...base,
    alignment: computeMacroAlignment(fundamentalBias, techBias)
  };
}

// --- Pillar 2: High-Impact Calendar Event Transmission Playbook ---

interface DeterministicEventRule {
  category: string;
  /** True when a higher-than-forecast number is actually WEAKER/DOVISH (e.g., Unemployment Rate, Jobless Claims). */
  invertedHigherIsBearish: boolean;
  ifHot: TransmissionMove[];
  ifCold: TransmissionMove[];
  affectedSymbols: string[];
  defaultContext: string;
  defaultWatch: string;
}

function flipMoves(moves: TransmissionMove[]): TransmissionMove[] {
  return moves.map((m) => ({
    symbol: m.symbol,
    direction: m.direction === 'up' ? 'down' : 'up'
  }));
}

function classifyEventDeterministically(
  title: string,
  countryRaw: string,
  forecast?: string,
  prior?: string
): DeterministicEventRule {
  const country = (countryRaw || 'US').toUpperCase();
  const t = title.toLowerCase();

  const isInverted =
    t.includes('unemployment') ||
    t.includes('jobless') ||
    t.includes('initial claims') ||
    t.includes('continuing claims');

  let category = 'Macro Release';
  if (t.includes('cpi') || t.includes('pce') || t.includes('ppi') || t.includes('inflation') || t.includes('price index')) {
    category = 'Inflation';
  } else if (
    t.includes('payroll') ||
    t.includes('nonfarm') ||
    t.includes('non-farm') ||
    t.includes('employment') ||
    t.includes('unemployment') ||
    t.includes('jobless') ||
    t.includes('jolts') ||
    t.includes('adp') ||
    t.includes('earnings') ||
    t.includes('wage')
  ) {
    category = 'Labor Market';
  } else if (
    t.includes('fomc') ||
    t.includes('interest rate') ||
    t.includes('rate decision') ||
    t.includes('monetary policy') ||
    t.includes('central bank') ||
    t.includes('fed') ||
    t.includes('ecb') ||
    t.includes('boe') ||
    t.includes('boj') ||
    t.includes('rba') ||
    t.includes('boc') ||
    t.includes('snb') ||
    t.includes('powell') ||
    t.includes('lagarde') ||
    t.includes('minutes')
  ) {
    category = 'Central Bank';
  } else if (t.includes('gdp') || t.includes('pmi') || t.includes('ism') || t.includes('manufacturing') || t.includes('services')) {
    category = 'Growth & PMI';
  } else if (t.includes('retail') || t.includes('consumer') || t.includes('confidence') || t.includes('sentiment')) {
    category = 'Consumer';
  } else if (t.includes('crude') || t.includes('oil') || t.includes('inventories')) {
    category = 'Energy';
  }

  let hawkishMoves: TransmissionMove[];
  let affectedSymbols: string[];

  if (category === 'Energy') {
    // Higher inventories = bearish Oil
    hawkishMoves = [
      { symbol: 'USOIL', direction: 'down' },
      { symbol: 'UKOIL', direction: 'down' },
      { symbol: 'USDCAD', direction: 'up' },
      { symbol: 'XAUUSD', direction: 'down' }
    ];
    affectedSymbols = ['USOIL', 'UKOIL', 'USDCAD'];
  } else if (country === 'US') {
    if (category === 'Inflation' || category === 'Central Bank') {
      hawkishMoves = [
        { symbol: 'DXY', direction: 'up' },
        { symbol: 'USDJPY', direction: 'up' },
        { symbol: 'XAUUSD', direction: 'down' },
        { symbol: 'NAS100', direction: 'down' }
      ];
      affectedSymbols = ['DXY', 'XAUUSD', 'NAS100', 'SPX', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'];
    } else if (category === 'Labor Market') {
      hawkishMoves = [
        { symbol: 'DXY', direction: 'up' },
        { symbol: 'USDJPY', direction: 'up' },
        { symbol: 'XAUUSD', direction: 'down' },
        { symbol: 'EURUSD', direction: 'down' }
      ];
      affectedSymbols = ['DXY', 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'NAS100', 'SPX'];
    } else {
      hawkishMoves = [
        { symbol: 'DXY', direction: 'up' },
        { symbol: 'SPX', direction: 'up' },
        { symbol: 'XAUUSD', direction: 'down' },
        { symbol: 'EURUSD', direction: 'down' }
      ];
      affectedSymbols = ['DXY', 'SPX', 'NAS100', 'XAUUSD', 'EURUSD', 'USDJPY'];
    }
  } else if (country === 'EU' || country === 'DE' || country === 'FR') {
    hawkishMoves = [
      { symbol: 'EURUSD', direction: 'up' },
      { symbol: 'EURGBP', direction: 'up' },
      { symbol: 'EURJPY', direction: 'up' },
      { symbol: 'DXY', direction: 'down' }
    ];
    affectedSymbols = ['EURUSD', 'EURGBP', 'EURJPY', 'DXY'];
  } else if (country === 'GB' || country === 'UK') {
    hawkishMoves = [
      { symbol: 'GBPUSD', direction: 'up' },
      { symbol: 'GBPJPY', direction: 'up' },
      { symbol: 'EURGBP', direction: 'down' },
      { symbol: 'DXY', direction: 'down' }
    ];
    affectedSymbols = ['GBPUSD', 'GBPJPY', 'EURGBP', 'DXY'];
  } else if (country === 'JP') {
    hawkishMoves = [
      { symbol: 'USDJPY', direction: 'down' },
      { symbol: 'GBPJPY', direction: 'down' },
      { symbol: 'EURJPY', direction: 'down' },
      { symbol: 'XAUUSD', direction: 'up' }
    ];
    affectedSymbols = ['USDJPY', 'GBPJPY', 'EURJPY', 'XAUUSD'];
  } else if (country === 'CA') {
    hawkishMoves = [
      { symbol: 'USDCAD', direction: 'down' },
      { symbol: 'USOIL', direction: 'up' },
      { symbol: 'DXY', direction: 'down' },
      { symbol: 'XAUUSD', direction: 'up' }
    ];
    affectedSymbols = ['USDCAD', 'USOIL', 'DXY'];
  } else if (country === 'AU') {
    hawkishMoves = [
      { symbol: 'AUDUSD', direction: 'up' },
      { symbol: 'NZDUSD', direction: 'up' },
      { symbol: 'XAUUSD', direction: 'up' },
      { symbol: 'DXY', direction: 'down' }
    ];
    affectedSymbols = ['AUDUSD', 'NZDUSD', 'XAUUSD'];
  } else if (country === 'NZ') {
    hawkishMoves = [
      { symbol: 'NZDUSD', direction: 'up' },
      { symbol: 'AUDUSD', direction: 'up' },
      { symbol: 'DXY', direction: 'down' },
      { symbol: 'XAUUSD', direction: 'up' }
    ];
    affectedSymbols = ['NZDUSD', 'AUDUSD'];
  } else if (country === 'CH') {
    hawkishMoves = [
      { symbol: 'USDCHF', direction: 'down' },
      { symbol: 'EURUSD', direction: 'up' },
      { symbol: 'XAUUSD', direction: 'up' },
      { symbol: 'DXY', direction: 'down' }
    ];
    affectedSymbols = ['USDCHF', 'EURUSD', 'XAUUSD'];
  } else if (country === 'CN') {
    hawkishMoves = [
      { symbol: 'AUDUSD', direction: 'up' },
      { symbol: 'USOIL', direction: 'up' },
      { symbol: 'XAUUSD', direction: 'up' },
      { symbol: 'DXY', direction: 'down' }
    ];
    affectedSymbols = ['AUDUSD', 'NZDUSD', 'USOIL', 'XAUUSD', 'XAGUSD'];
  } else {
    hawkishMoves = [
      { symbol: 'DXY', direction: 'up' },
      { symbol: 'XAUUSD', direction: 'down' },
      { symbol: 'EURUSD', direction: 'down' },
      { symbol: 'SPX', direction: 'up' }
    ];
    affectedSymbols = ['DXY', 'XAUUSD', 'EURUSD', 'SPX'];
  }

  const ifHot = isInverted ? flipMoves(hawkishMoves) : hawkishMoves;
  const ifCold = isInverted ? hawkishMoves : flipMoves(hawkishMoves);

  const fpNote =
    forecast && prior
      ? `Consensus ${forecast} vs prior ${prior}.`
      : forecast
        ? `Market consensus sits at ${forecast}.`
        : prior
          ? `Prior reading was ${prior}.`
          : `Markets pricing rate-path sensitivity into the print.`;

  const defaultWatch = isInverted
    ? 'Higher-than-expected reading signals labor cooling (dovish); watch revisions alongside headline.'
    : category === 'Inflation'
      ? 'Watch core momentum and front-end yield reaction in the first 5 minutes before chasing.'
      : category === 'Central Bank'
        ? 'Statement wording and press-conference rate-path guidance typically drive the second wave.'
        : 'Initial spike often tests liquidity; confirm US 2Y/10Y yield direction before committing.';

  return {
    category,
    invertedHigherIsBearish: isInverted,
    ifHot,
    ifCold,
    affectedSymbols,
    defaultContext: fpNote,
    defaultWatch
  };
}

function sanitizeMoves(raw: unknown, fallback: TransmissionMove[]): TransmissionMove[] {
  if (!Array.isArray(raw)) return fallback;
  const cleaned: TransmissionMove[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { symbol?: unknown; direction?: unknown };
    const sym = typeof obj.symbol === 'string' ? normalizeShortSymbol(obj.symbol) : '';
    const dir = obj.direction === 'up' || obj.direction === 'down' ? obj.direction : null;
    if (sym && sym.length <= 10 && dir) {
      cleaned.push({ symbol: sym, direction: dir });
    }
    if (cleaned.length >= 4) break;
  }
  return cleaned.length >= 2 ? cleaned : fallback;
}

export async function getEventPlaybookPayload(params: {
  title: string;
  country: string;
  forecast?: string;
  prior?: string;
  actual?: string;
}): Promise<EventPlaybookResponse> {
  const title = params.title.trim();
  const country = (params.country || 'US').trim().toUpperCase();
  const forecast = params.forecast?.trim() || undefined;
  const prior = params.prior?.trim() || undefined;
  const actual = params.actual?.trim() || undefined;

  const cacheKey = `${country}|${title.toLowerCase()}|${forecast ?? ''}|${prior ?? ''}|${actual ?? ''}`;
  const now = Date.now();
  const cached = eventPlaybookCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < EVENT_PLAYBOOK_TTL_MS) {
    return cached.data;
  }

  const baseline = classifyEventDeterministically(title, country, forecast, prior);

  const [fredTrend, tavily] = await Promise.all([
    getFredTrendForEvent(title, country),
    isTavilyConfigured()
      ? runTavilyFinanceSearch(`${country} ${title} forecast consensus market expectation`, {
          topic: 'news',
          maxResults: 3,
          days: 5
        })
      : Promise.resolve(null)
  ]);

  let consensusContext = baseline.defaultContext;
  let watchNote = baseline.defaultWatch;
  let ifHot = baseline.ifHot;
  let ifCold = baseline.ifCold;
  let aiSynthesized = false;

  interface AiEventJson {
    consensusContext?: string;
    watchNote?: string;
    ifHot?: { symbol?: string; direction?: string }[];
    ifCold?: { symbol?: string; direction?: string }[];
  }

  const prompt = [
    `Event: ${country} ${title}`,
    `Category: ${baseline.category}`,
    `Higher-than-forecast is dovish/bearish currency: ${baseline.invertedHigherIsBearish ? 'YES (e.g. unemployment/claims)' : 'NO'}`,
    `Forecast: ${forecast ?? 'n/a'} | Prior: ${prior ?? 'n/a'} | Actual: ${actual ?? 'pending'}`,
    fredTrend ? `Recent Official Trend: ${fredTrend}` : '',
    `Baseline If Hot: ${baseline.ifHot.map((m) => `${m.symbol} ${m.direction}`).join(', ')}`,
    `Baseline If Cold: ${baseline.ifCold.map((m) => `${m.symbol} ${m.direction}`).join(', ')}`,
    tavily?.snippets ? `Market Preview Snippets:\n${tavily.snippets.slice(0, 1200)}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  const ai = await callDeepSeekJson<AiEventJson>(
    'You are a macro desk strategist creating a compact pre-release transmission card for an economic calendar event. ' +
      'Return strict JSON with keys: ' +
      'consensusContext (1 concise sentence <=115 chars on what the market is pricing or how actual compares to forecast), ' +
      'watchNote (1 concise tactical macro execution note <=120 chars, no TA jargon), ' +
      'ifHot (array of 4 objects {symbol, direction: "up"|"down"} using standard tickers like DXY, XAUUSD, NAS100, SPX, EURUSD, GBPUSD, USDJPY, USDCAD, AUDUSD, USOIL), ' +
      'ifCold (array of 4 objects {symbol, direction: "up"|"down"}).',
    prompt,
    360
  );

  if (ai) {
    aiSynthesized = true;
    consensusContext = clampStr(ai.consensusContext, consensusContext, 125);
    watchNote = clampStr(ai.watchNote, watchNote, 130);
    ifHot = sanitizeMoves(ai.ifHot, ifHot);
    ifCold = sanitizeMoves(ai.ifCold, ifCold);
  }

  const affectedSet = new Set<string>(baseline.affectedSymbols);
  for (const m of ifHot) affectedSet.add(m.symbol);
  for (const m of ifCold) affectedSet.add(m.symbol);

  const data: EventPlaybookResponse = {
    title,
    country,
    category: baseline.category,
    consensusContext,
    recentTrend: fredTrend ?? undefined,
    ifHot,
    ifCold,
    affectedSymbols: Array.from(affectedSet),
    watchNote,
    aiSynthesized,
    updatedAt: new Date().toISOString()
  };

  if (eventPlaybookCache.size >= 120) {
    const oldest = eventPlaybookCache.keys().next().value;
    if (oldest) eventPlaybookCache.delete(oldest);
  }
  eventPlaybookCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

// --- Pillar 3: Playbook 1-Click Edge Audit ---

interface BucketStat {
  key: string;
  count: number;
  wins: number;
  losses: number;
  mistakes: number;
  totalR: number;
  rCount: number;
}

function summarizeBucket(
  entries: EdgeAuditEntryInput[],
  keyFn: (e: EdgeAuditEntryInput) => string
): BucketStat[] {
  const map = new Map<string, BucketStat>();
  for (const e of entries) {
    const key = keyFn(e).trim() || 'Unspecified';
    const cur = map.get(key) ?? {
      key,
      count: 0,
      wins: 0,
      losses: 0,
      mistakes: 0,
      totalR: 0,
      rCount: 0
    };
    cur.count += 1;
    if (e.outcome === 'Win') cur.wins += 1;
    else if (e.outcome === 'Loss') cur.losses += 1;
    if (e.grade === 'Mistake') cur.mistakes += 1;
    if (typeof e.rMultiple === 'number' && Number.isFinite(e.rMultiple)) {
      cur.totalR += e.rMultiple;
      cur.rCount += 1;
    }
    map.set(key, cur);
  }
  return Array.from(map.values());
}

function fmtBucket(b: BucketStat): string {
  const decided = b.wins + b.losses;
  const wr = decided > 0 ? `${Math.round((b.wins / decided) * 100)}% Win` : `${b.count} logged`;
  const rPart =
    b.rCount > 0 ? `, ${b.totalR >= 0 ? '+' : ''}${b.totalR.toFixed(1)}R` : '';
  return `${b.key} (${wr}${rPart}, ${b.count} trades${b.mistakes > 0 ? `, ${b.mistakes} mistakes` : ''})`;
}

export async function runEdgeAuditPayload(rawEntries: EdgeAuditEntryInput[]): Promise<EdgeAuditResponse> {
  const entries = (Array.isArray(rawEntries) ? rawEntries : [])
    .slice(0, 60)
    .map((e) => ({
      symbol: normalizeShortSymbol(String(e.symbol || 'UNKNOWN')),
      setupType: String(e.setupType || 'Unspecified').trim().slice(0, 40),
      grade: String(e.grade || 'A+').trim().slice(0, 16),
      outcome: String(e.outcome || 'Win').trim().slice(0, 16),
      rMultiple:
        typeof e.rMultiple === 'number' && Number.isFinite(e.rMultiple)
          ? Math.round(e.rMultiple * 100) / 100
          : null,
      date: String(e.date || '').slice(0, 16),
      title: typeof e.title === 'string' ? e.title.trim().slice(0, 80) : '',
      notes: typeof e.notes === 'string' ? e.notes.replace(/\s+/g, ' ').trim().slice(0, 260) : ''
    }));

  if (entries.length === 0) {
    return {
      trueEdge: {
        headline: 'Not enough trades logged yet',
        detail: 'Log at least 3–5 setups with outcomes and R-multiples to surface your real statistical edge.'
      },
      primaryLeak: {
        headline: 'No recurring leak detected yet',
        detail: 'Tag losses or impulsive entries as Mistake with a 1-line note so patterns can be audited.'
      },
      nextWeekRule: {
        rule: 'Log every executed trade with grade, setup type, and R-multiple',
        rationale: 'Building a clean 10-trade sample unlocks accurate setup and mistake diagnosis.'
      },
      analyzedCount: 0,
      aiSynthesized: false,
      updatedAt: new Date().toISOString()
    };
  }

  const bySetup = summarizeBucket(entries, (e) => e.setupType).sort(
    (a, b) => b.totalR - a.totalR || b.wins - a.wins
  );
  const bySymbol = summarizeBucket(entries, (e) => e.symbol).sort(
    (a, b) => b.totalR - a.totalR || b.wins - a.wins
  );
  const byGrade = summarizeBucket(entries, (e) => e.grade);

  const bestSetup = bySetup[0];
  const bestSymbol = bySymbol[0];
  const worstSetup = bySetup
    .slice()
    .sort((a, b) => a.totalR - b.totalR || b.losses + b.mistakes - (a.losses + a.mistakes))[0];

  const mistakeEntries = entries.filter((e) => e.grade === 'Mistake' || e.outcome === 'Loss');
  const aPlusEntries = entries.filter((e) => e.grade === 'A+');
  const totalWins = entries.filter((e) => e.outcome === 'Win').length;
  const totalLosses = entries.filter((e) => e.outcome === 'Loss').length;
  const overallWr =
    totalWins + totalLosses > 0 ? Math.round((totalWins / (totalWins + totalLosses)) * 100) : null;

  // Deterministic statistical baseline
  let trueEdge = {
    headline: `${bestSetup.key} on ${bestSymbol.key}`,
    detail: `Top performer: ${fmtBucket(bestSetup)}; strongest symbol is ${fmtBucket(bestSymbol)}.`
  };

  let primaryLeak =
    mistakeEntries.length > 0
      ? {
          headline:
            worstSetup && (worstSetup.totalR < 0 || worstSetup.losses > 0)
              ? `${worstSetup.key} & Mistake entries (${mistakeEntries.length})`
              : `${mistakeEntries.length} loss/mistake trades dragging expectancy`,
          detail:
            mistakeEntries.find((m) => m.notes)?.notes.slice(0, 125) ||
            `${mistakeEntries.length} of ${entries.length} logged trades were losses or tagged Mistake.`
        }
      : {
          headline: 'Small sample — no major leak flagged yet',
          detail: `Keep logging B-grade and Mistake trades honestly alongside A+ wins to expose hidden leaks.`
        };

  let nextWeekRule =
    mistakeEntries.length > 0 && worstSetup && worstSetup.key !== bestSetup.key
      ? {
          rule: `Only execute A+ ${bestSetup.key} setups and pause ${worstSetup.key} until reviewed`,
          rationale: `Concentrates risk in your highest-expectancy setup while cutting your main drag.`
        }
      : {
          rule: `Pass every Pre-Trade Gate item before taking non-A+ ${bestSymbol.key} entries`,
          rationale: `Protects expectancy and prevents unforced B-grade or impulsive entries.`
        };

  let aiSynthesized = false;

  const statsBrief = [
    `Total Playbook Entries: ${entries.length} (Win rate: ${overallWr != null ? `${overallWr}%` : 'n/a'}, A+ count: ${aPlusEntries.length}, Loss/Mistake count: ${mistakeEntries.length})`,
    `By Setup: ${bySetup.slice(0, 6).map(fmtBucket).join(' | ')}`,
    `By Symbol: ${bySymbol.slice(0, 6).map(fmtBucket).join(' | ')}`,
    `By Grade: ${byGrade.map(fmtBucket).join(' | ')}`,
    `Recent Winning / A+ Notes:`,
    ...entries
      .filter((e) => e.outcome === 'Win' || e.grade === 'A+')
      .slice(0, 8)
      .map(
        (e) =>
          `- [${e.date}] ${e.symbol} | ${e.setupType} | ${e.grade} | ${e.outcome} (${e.rMultiple ?? 'n/a'}R): ${e.title}${e.notes ? ` — ${e.notes}` : ''}`
      ),
    `Recent Loss / Mistake Notes:`,
    ...mistakeEntries
      .slice(0, 10)
      .map(
        (e) =>
          `- [${e.date}] ${e.symbol} | ${e.setupType} | ${e.grade} | ${e.outcome} (${e.rMultiple ?? 'n/a'}R): ${e.title}${e.notes ? ` — ${e.notes}` : ''}`
      )
  ].join('\n');

  interface AiAuditJson {
    trueEdge?: { headline?: string; detail?: string };
    primaryLeak?: { headline?: string; detail?: string };
    nextWeekRule?: { rule?: string; rationale?: string };
  }

  const ai = await callDeepSeekJson<AiAuditJson>(
    'You are a trading performance coach auditing a trader’s personal Playbook journal. ' +
      'Use ONLY the exact numbers and notes provided — never invent statistics or trades. ' +
      'Be quiet, clinical, and direct (zero hype or cheerleading). ' +
      'Return strict JSON with keys: ' +
      'trueEdge: { headline (<=65 chars), detail (<=135 chars citing exact stats) }, ' +
      'primaryLeak: { headline (<=65 chars), detail (<=135 chars citing exact pattern/mistake) }, ' +
      'nextWeekRule: { rule (short imperative checklist item <=78 chars suitable for a Pre-Trade Gate checkbox), rationale (<=115 chars) }.',
    statsBrief,
    420
  );

  if (ai) {
    aiSynthesized = true;
    if (ai.trueEdge) {
      trueEdge = {
        headline: clampStr(ai.trueEdge.headline, trueEdge.headline, 72),
        detail: clampStr(ai.trueEdge.detail, trueEdge.detail, 145)
      };
    }
    if (ai.primaryLeak) {
      primaryLeak = {
        headline: clampStr(ai.primaryLeak.headline, primaryLeak.headline, 72),
        detail: clampStr(ai.primaryLeak.detail, primaryLeak.detail, 145)
      };
    }
    if (ai.nextWeekRule) {
      nextWeekRule = {
        rule: clampStr(ai.nextWeekRule.rule, nextWeekRule.rule, 86),
        rationale: clampStr(ai.nextWeekRule.rationale, nextWeekRule.rationale, 125)
      };
    }
  }

  return {
    trueEdge,
    primaryLeak,
    nextWeekRule,
    analyzedCount: entries.length,
    aiSynthesized,
    updatedAt: new Date().toISOString()
  };
}
