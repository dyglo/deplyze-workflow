import { getQuotesPayload, type MarketQuote } from '../quotes/service.js';
import type {
  AlignmentStatus,
  MacroBias,
  MacroMetric,
  MacroRegimeResponse,
  SymbolDriver,
  SymbolMacroSummary,
  TechBiasInput
} from './types.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const FRED_MACRO_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REGIME_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FRED_EVENT_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const FETCH_TIMEOUT_MS = 10_000;

interface FredPoint {
  date: string;
  value: number;
}

interface FredSeriesStats {
  seriesId: string;
  latest: number;
  prev: number | null;
  delta: number; // latest - prev
  asOf: string;
}

export interface MacroSnapshot {
  dxy: MarketQuote | null;
  us10yQuote: MarketQuote | null;
  vix: MarketQuote | null;
  usoil: MarketQuote | null;
  spx: MarketQuote | null;
  xau: MarketQuote | null;
  dgs10: FredSeriesStats | null;
  dgs2: FredSeriesStats | null;
  dfii10: FredSeriesStats | null;
  t10y2y: FredSeriesStats | null;
  riskMode: 'risk_on' | 'risk_off' | 'mixed';
  usdRegime: 'strong' | 'soft' | 'neutral';
  yieldsRegime: 'rising' | 'falling' | 'flat';
  regime: MacroRegimeResponse;
}

const fredSeriesCache = new Map<string, { stats: FredSeriesStats | null; fetchedAt: number }>();
const fredEventTrendCache = new Map<string, { text: string | null; fetchedAt: number }>();
let regimeCache: { snapshot: MacroSnapshot; fetchedAt: number } | null = null;
let regimeInflight: Promise<MacroSnapshot> | null = null;

function getFredApiKey(): string {
  return (process.env.FRED_API_KEY ?? '').trim();
}

export function normalizeShortSymbol(raw: string): string {
  const clean = (raw || '').trim().toUpperCase();
  const colon = clean.indexOf(':');
  const ticker = colon >= 0 ? clean.slice(colon + 1) : clean;
  if (ticker === 'GOLD') return 'XAUUSD';
  if (ticker === 'SILVER') return 'XAGUSD';
  if (ticker === 'NDX' || ticker === 'NAS100USD') return 'NAS100';
  if (ticker === 'US500') return 'SPX';
  if (ticker === 'DJI') return 'US30';
  if (ticker === 'WTI' || ticker === 'WTICOUSD' || ticker === 'OILUSD') return 'USOIL';
  return ticker || 'XAUUSD';
}

export function computeMacroAlignment(
  fundamentalBias: MacroBias,
  techBias: TechBiasInput | undefined
): AlignmentStatus {
  if (!techBias || techBias === 'none' || techBias === 'range') return 'neutral';
  if (fundamentalBias === 'neutral') return 'neutral';
  if (techBias === 'bull') return fundamentalBias === 'tailwind' ? 'aligned' : 'conflict';
  if (techBias === 'bear') return fundamentalBias === 'headwind' ? 'aligned' : 'conflict';
  return 'neutral';
}

async function fetchFredSeriesPoints(seriesId: string, limit = 10): Promise<FredPoint[]> {
  const apiKey = getFredApiKey();
  if (!apiKey) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url =
    `${FRED_BASE}/series/observations?series_id=${encodeURIComponent(seriesId)}` +
    `&sort_order=desc&limit=${limit}&api_key=${encodeURIComponent(apiKey)}&file_type=json`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'DeplyzeWorkflow-API/0.1.7',
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      observations?: { date?: string; value?: string }[];
    };
    const pts: FredPoint[] = [];
    for (const obs of data.observations ?? []) {
      if (!obs.date || !obs.value || obs.value === '.') continue;
      const val = Number(obs.value);
      if (Number.isFinite(val)) {
        pts.push({ date: obs.date, value: val });
      }
    }
    return pts;
  } catch (err) {
    console.warn(`[insights:fred] ${seriesId} failed:`, (err as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function getFredSeriesStats(seriesId: string): Promise<FredSeriesStats | null> {
  const now = Date.now();
  const cached = fredSeriesCache.get(seriesId);
  if (cached && now - cached.fetchedAt < FRED_MACRO_TTL_MS) {
    return cached.stats;
  }

  const pts = await fetchFredSeriesPoints(seriesId, 8);
  const stats: FredSeriesStats | null =
    pts.length > 0
      ? {
          seriesId,
          latest: pts[0].value,
          prev: pts[1]?.value ?? null,
          delta: pts[1] ? Number((pts[0].value - pts[1].value).toFixed(4)) : 0,
          asOf: pts[0].date
        }
      : null;

  fredSeriesCache.set(seriesId, { stats, fetchedAt: now });
  return stats;
}

function fmtPct(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '0.00%';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function fmtBps(deltaPctPts: number | null | undefined): string {
  if (typeof deltaPctPts !== 'number' || !Number.isFinite(deltaPctPts)) return '0bp';
  const bps = Math.round(deltaPctPts * 100);
  const sign = bps > 0 ? '+' : '';
  return `${sign}${bps}bp`;
}

function dirFromNum(n: number, threshold = 0.001): 'up' | 'down' | 'flat' {
  if (n > threshold) return 'up';
  if (n < -threshold) return 'down';
  return 'flat';
}

function normalizeYieldPrice(q: MarketQuote | null): { value: number; deltaPts: number } | null {
  if (!q || !Number.isFinite(q.price) || q.price <= 0) return null;
  // Yahoo ^TNX can quote 4.25 or 42.5; normalize to percent (0..20)
  const scale = q.price > 25 ? 0.1 : 1;
  const val = q.price * scale;
  const chg = Number.isFinite(q.change) ? q.change * scale : 0;
  return { value: val, deltaPts: chg };
}

function impactFromScore(score: number, threshold = 0.25): 'bull' | 'bear' | 'neutral' {
  if (score >= threshold) return 'bull';
  if (score <= -threshold) return 'bear';
  return 'neutral';
}

function biasFromScore(score: number, threshold = 0.35): MacroBias {
  if (score >= threshold) return 'tailwind';
  if (score <= -threshold) return 'headwind';
  return 'neutral';
}

export function buildSymbolDriversAndBias(
  shortName: string,
  ctx: {
    dxy: MarketQuote | null;
    us10yVal: number | null;
    us10yDeltaPts: number;
    real10yVal: number | null;
    real10yDeltaPts: number;
    us2yVal: number | null;
    us2yDeltaPts: number;
    vix: MarketQuote | null;
    usoil: MarketQuote | null;
    spx: MarketQuote | null;
    riskMode: 'risk_on' | 'risk_off' | 'mixed';
  }
): { bias: MacroBias; reason: string; drivers: SymbolDriver[] } {
  const sym = normalizeShortSymbol(shortName);

  const dxyPct = ctx.dxy?.changePercent ?? 0;
  const dxyW1 = ctx.dxy?.performance?.w1 ?? 0;
  const dxyScore = dxyPct * 1.4 + dxyW1 * 0.35; // >0 = stronger USD

  const y10Bps = ctx.us10yDeltaPts * 100;
  const realBps = ctx.real10yDeltaPts * 100;
  const y2Bps = ctx.us2yDeltaPts * 100;

  const vixVal = ctx.vix?.price ?? null;
  const vixPct = ctx.vix?.changePercent ?? 0;
  const spxPct = ctx.spx?.changePercent ?? 0;
  const oilPct = ctx.usoil?.changePercent ?? 0;

  const dxyDriver = (inverse: boolean, noteBull: string, noteBear: string): SymbolDriver => {
    const raw = inverse ? -dxyScore : dxyScore;
    const imp = impactFromScore(raw, 0.25);
    return {
      label: 'US Dollar (DXY)',
      value: ctx.dxy ? ctx.dxy.price.toFixed(2) : '—',
      delta: ctx.dxy ? fmtPct(ctx.dxy.changePercent) : 'n/a',
      impact: imp,
      note: imp === 'bull' ? noteBull : imp === 'bear' ? noteBear : 'USD trading near flat'
    };
  };

  const realYieldDriver = (inverse: boolean): SymbolDriver => {
    const bps = ctx.real10yVal != null ? realBps : y10Bps;
    const val = ctx.real10yVal ?? ctx.us10yVal;
    const raw = inverse ? -bps / 4 : bps / 4;
    const imp = impactFromScore(raw, 0.4);
    return {
      label: ctx.real10yVal != null ? 'Real 10Y Yield' : 'US 10Y Yield',
      value: val != null ? `${val.toFixed(2)}%` : '—',
      delta: val != null ? fmtBps(ctx.real10yVal != null ? ctx.real10yDeltaPts : ctx.us10yDeltaPts) : 'n/a',
      impact: imp,
      note:
        imp === 'bull'
          ? inverse
            ? 'Easing yields lower carry cost'
            : 'Rising yields support upside'
          : imp === 'bear'
            ? inverse
              ? 'Higher real yields pressure price'
              : 'Falling yields weigh on carry'
            : 'Yields steady in narrow range'
    };
  };

  const y10Driver = (inverse: boolean, bullText: string, bearText: string): SymbolDriver => {
    const raw = inverse ? -y10Bps / 4 : y10Bps / 4;
    const imp = impactFromScore(raw, 0.4);
    return {
      label: 'US 10Y Yield',
      value: ctx.us10yVal != null ? `${ctx.us10yVal.toFixed(2)}%` : '—',
      delta: ctx.us10yVal != null ? fmtBps(ctx.us10yDeltaPts) : 'n/a',
      impact: imp,
      note: imp === 'bull' ? bullText : imp === 'bear' ? bearText : 'Rates largely unchanged'
    };
  };

  const y2Driver = (inverse: boolean): SymbolDriver => {
    const raw = inverse ? -y2Bps / 4 : y2Bps / 4;
    const imp = impactFromScore(raw, 0.4);
    return {
      label: 'US 2Y Yield',
      value: ctx.us2yVal != null ? `${ctx.us2yVal.toFixed(2)}%` : '—',
      delta: ctx.us2yVal != null ? fmtBps(ctx.us2yDeltaPts) : 'n/a',
      impact: imp,
      note:
        imp === 'bull'
          ? inverse
            ? 'Softer Fed pricing supports pair'
            : 'Higher front-end rate supports USD'
          : imp === 'bear'
            ? inverse
              ? 'Higher front-end yields favor USD'
              : 'Easing Fed pricing weighs on USD'
            : 'Front-end rate pricing stable'
    };
  };

  const vixDriver = (safeHavenBull: boolean): SymbolDriver => {
    const elevated = (vixVal != null && vixVal >= 21) || vixPct >= 4.5;
    const calm = (vixVal != null && vixVal <= 16.5 && vixPct <= 1) || vixPct <= -4;
    let imp: 'bull' | 'bear' | 'neutral' = 'neutral';
    if (safeHavenBull) {
      if (elevated) imp = 'bull';
      else if (calm) imp = 'bear';
    } else {
      if (elevated) imp = 'bear';
      else if (calm) imp = 'bull';
    }
    return {
      label: 'Volatility (VIX)',
      value: vixVal != null ? vixVal.toFixed(1) : '—',
      delta: ctx.vix ? fmtPct(vixPct) : 'n/a',
      impact: imp,
      note: elevated
        ? safeHavenBull
          ? 'Elevated vol supports defensive bid'
          : 'Risk-off vol weighs on risk assets'
        : calm
          ? safeHavenBull
            ? 'Calm risk mood caps haven demand'
            : 'Low volatility favors risk-on flow'
          : 'Balanced volatility regime'
    };
  };

  const spxDriver = (positiveCorr: boolean): SymbolDriver => {
    const raw = positiveCorr ? spxPct : -spxPct;
    const imp = impactFromScore(raw, 0.3);
    return {
      label: 'Risk Mood (SPX)',
      value: ctx.spx ? ctx.spx.price.toFixed(0) : '—',
      delta: ctx.spx ? fmtPct(spxPct) : 'n/a',
      impact: imp,
      note:
        imp === 'bull'
          ? positiveCorr
            ? 'Broad equity risk-on supports flow'
            : 'Equity weakness feeds haven bid'
          : imp === 'bear'
            ? positiveCorr
              ? 'Risk-off equities weigh on beta'
              : 'Equity rally reduces defensive bid'
            : 'Broad risk tone mixed'
    };
  };

  const oilDriver = (inverse: boolean): SymbolDriver => {
    const raw = inverse ? -oilPct : oilPct;
    const imp = impactFromScore(raw, 0.8);
    return {
      label: 'WTI Crude (USOIL)',
      value: ctx.usoil ? `$${ctx.usoil.price.toFixed(2)}` : '—',
      delta: ctx.usoil ? fmtPct(oilPct) : 'n/a',
      impact: imp,
      note:
        imp === 'bull'
          ? inverse
            ? 'Softer crude weakens CAD (lifts pair)'
            : 'Firm crude supports energy/commodity bid'
          : imp === 'bear'
            ? inverse
              ? 'Rising crude strengthens CAD (pressures pair)'
              : 'Falling crude drags commodity tone'
            : 'Energy prices steady'
    };
  };

  let drivers: SymbolDriver[] = [];
  let totalScore = 0;

  // 1. Precious Metals (XAUUSD, XAGUSD)
  if (sym.startsWith('XAU') || sym.startsWith('XAG')) {
    const d1 = realYieldDriver(true);
    const d2 = dxyDriver(true, 'Softer USD supports bullion', 'Firmer USD caps bullion upside');
    const d3 = vixDriver(true);
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.55 : d1.impact === 'bear' ? -0.55 : 0) +
      (d2.impact === 'bull' ? 0.45 : d2.impact === 'bear' ? -0.45 : 0) +
      (d3.impact === 'bull' ? 0.25 : d3.impact === 'bear' ? -0.15 : 0);
  }
  // 2. US Dollar Index itself
  else if (sym === 'DXY') {
    const d1 = y2Driver(false);
    const d2 = y10Driver(false, 'Higher 10Y yields draw USD flow', 'Softer 10Y yields weigh on USD');
    const d3 = vixDriver(true);
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.5 : d1.impact === 'bear' ? -0.5 : 0) +
      (d2.impact === 'bull' ? 0.45 : d2.impact === 'bear' ? -0.45 : 0) +
      (d3.impact === 'bull' ? 0.25 : d3.impact === 'bear' ? -0.15 : 0);
  }
  // 3. Crude Oil
  else if (sym === 'USOIL' || sym === 'UKOIL') {
    const d1 = dxyDriver(true, 'Softer USD supports crude pricing', 'Stronger USD weighs on crude');
    const d2 = spxDriver(true);
    const d3 = vixDriver(false);
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.45 : d1.impact === 'bear' ? -0.45 : 0) +
      (d2.impact === 'bull' ? 0.4 : d2.impact === 'bear' ? -0.4 : 0) +
      (d3.impact === 'bull' ? 0.25 : d3.impact === 'bear' ? -0.25 : 0);
  }
  // 4. USD-Base FX (USDJPY, USDCAD, USDCHF)
  else if (sym.startsWith('USD') && sym.length === 6) {
    const d1 = dxyDriver(false, 'Broad USD bid lifts pair', 'Broad USD softness pressures pair');
    const d2 =
      sym === 'USDJPY'
        ? y10Driver(false, 'Wider US-JP rate spread lifts USDJPY', 'Falling US yields support Yen')
        : y2Driver(false);
    const d3 = sym === 'USDCAD' ? oilDriver(true) : spxDriver(sym === 'USDJPY');
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.55 : d1.impact === 'bear' ? -0.55 : 0) +
      (d2.impact === 'bull' ? 0.45 : d2.impact === 'bear' ? -0.45 : 0) +
      (d3.impact === 'bull' ? 0.25 : d3.impact === 'bear' ? -0.25 : 0);
  }
  // 5. USD-Quoted FX Majors (EURUSD, GBPUSD, AUDUSD, NZDUSD)
  else if (sym.endsWith('USD') && sym.length === 6 && !sym.startsWith('BTC') && !sym.startsWith('ETH') && !sym.startsWith('SOL')) {
    const d1 = dxyDriver(true, 'Softer USD creates tailwind', 'Stronger USD creates headwind');
    const d2 = y2Driver(true);
    const d3 = spxDriver(true);
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.55 : d1.impact === 'bear' ? -0.55 : 0) +
      (d2.impact === 'bull' ? 0.35 : d2.impact === 'bear' ? -0.35 : 0) +
      (d3.impact === 'bull' ? 0.3 : d3.impact === 'bear' ? -0.3 : 0);
  }
  // 6. JPY Crosses (GBPJPY, EURJPY, AUDJPY)
  else if (sym.endsWith('JPY') && sym.length === 6) {
    const d1 = y10Driver(false, 'Firm global yields weigh on Yen', 'Falling yields lift safe-haven Yen');
    const d2 = spxDriver(true);
    const d3 = vixDriver(false);
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.45 : d1.impact === 'bear' ? -0.45 : 0) +
      (d2.impact === 'bull' ? 0.4 : d2.impact === 'bear' ? -0.4 : 0) +
      (d3.impact === 'bull' ? 0.3 : d3.impact === 'bear' ? -0.3 : 0);
  }
  // 7. Crypto (BTCUSD, ETHUSD, SOLUSD)
  else if (sym.startsWith('BTC') || sym.startsWith('ETH') || sym.startsWith('SOL')) {
    const d1 = dxyDriver(true, 'Softer USD eases global liquidity', 'Stronger USD tightens liquidity');
    const d2 = spxDriver(true);
    const d3 = y10Driver(true, 'Lower yields support high-beta risk', 'Rising yields pressure risk assets');
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.4 : d1.impact === 'bear' ? -0.4 : 0) +
      (d2.impact === 'bull' ? 0.45 : d2.impact === 'bear' ? -0.45 : 0) +
      (d3.impact === 'bull' ? 0.3 : d3.impact === 'bear' ? -0.3 : 0);
  }
  // 8. US Indices & Equities (NAS100, SPX, US30, NVDA, AAPL, TSLA, etc.)
  else {
    const d1 = y10Driver(true, 'Easing 10Y yields lift equity multiples', 'Rising 10Y yields pressure multiples');
    const d2 = vixDriver(false);
    const d3 = dxyDriver(true, 'Softer USD supports earnings', 'Stronger USD tightens financial conditions');
    drivers = [d1, d2, d3];
    totalScore =
      (d1.impact === 'bull' ? 0.5 : d1.impact === 'bear' ? -0.5 : 0) +
      (d2.impact === 'bull' ? 0.45 : d2.impact === 'bear' ? -0.45 : 0) +
      (d3.impact === 'bull' ? 0.25 : d3.impact === 'bear' ? -0.25 : 0);
  }

  const bias = biasFromScore(totalScore, 0.35);
  const topActive = drivers.find((d) => d.impact !== 'neutral') ?? drivers[0];
  const reason =
    bias === 'tailwind'
      ? `Macro tailwind: ${topActive.label} (${topActive.delta})`
      : bias === 'headwind'
        ? `Macro headwind: ${topActive.label} (${topActive.delta})`
        : `Mixed macro backdrop (${ctx.riskMode.replace('_', '-')})`;

  return { bias, reason, drivers };
}

const REGIME_SYMBOLS = [
  'XAUUSD',
  'XAGUSD',
  'DXY',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
  'GBPJPY',
  'EURJPY',
  'EURGBP',
  'USOIL',
  'UKOIL',
  'NAS100',
  'SPX',
  'US30',
  'BTCUSD',
  'ETHUSD',
  'NVDA',
  'AAPL',
  'TSLA'
];

export async function getMacroSnapshot(force = false): Promise<MacroSnapshot> {
  const now = Date.now();
  if (!force && regimeCache && now - regimeCache.fetchedAt < REGIME_TTL_MS) {
    return regimeCache.snapshot;
  }
  if (!force && regimeInflight) {
    return regimeInflight;
  }

  regimeInflight = (async () => {
    const [quotePayload, dgs10, dgs2, dfii10, t10y2y] = await Promise.all([
      getQuotesPayload([
        'TVC:DXY',
        'TVC:US10Y',
        'TVC:VIX',
        'TVC:USOIL',
        'TVC:SPX',
        'OANDA:XAUUSD'
      ]),
      getFredSeriesStats('DGS10'),
      getFredSeriesStats('DGS2'),
      getFredSeriesStats('DFII10'),
      getFredSeriesStats('T10Y2Y')
    ]);

    const q = quotePayload.quotes;
    const dxy = q['TVC:DXY'] ?? null;
    const us10yQuote = q['TVC:US10Y'] ?? null;
    const vix = q['TVC:VIX'] ?? null;
    const usoil = q['TVC:USOIL'] ?? null;
    const spx = q['TVC:SPX'] ?? null;
    const xau = q['OANDA:XAUUSD'] ?? null;

    const live10y = normalizeYieldPrice(us10yQuote);
    const us10yVal = live10y?.value ?? dgs10?.latest ?? null;
    const us10yDeltaPts =
      live10y && Math.abs(live10y.deltaPts) > 0.0001 ? live10y.deltaPts : (dgs10?.delta ?? 0);
    const real10yVal = dfii10?.latest ?? null;
    const real10yDeltaPts = dfii10?.delta ?? 0;
    const us2yVal = dgs2?.latest ?? null;
    const us2yDeltaPts = dgs2?.delta ?? 0;

    const dxyPct = dxy?.changePercent ?? 0;
    const usdRegime: 'strong' | 'soft' | 'neutral' =
      dxyPct >= 0.2 ? 'strong' : dxyPct <= -0.2 ? 'soft' : 'neutral';

    const yieldsRegime: 'rising' | 'falling' | 'flat' =
      us10yDeltaPts >= 0.025 ? 'rising' : us10yDeltaPts <= -0.025 ? 'falling' : 'flat';

    const vixVal = vix?.price ?? null;
    const vixPct = vix?.changePercent ?? 0;
    const spxPct = spx?.changePercent ?? 0;
    const riskMode: 'risk_on' | 'risk_off' | 'mixed' =
      (vixVal != null && vixVal >= 22) || vixPct >= 5 || spxPct <= -0.55
        ? 'risk_off'
        : spxPct >= 0.3 || (vixVal != null && vixVal <= 16.5 && vixPct <= -1.5)
          ? 'risk_on'
          : 'mixed';

    const metrics: MacroMetric[] = [];
    if (dxy) {
      metrics.push({
        id: 'DXY',
        label: 'DXY',
        value: dxy.price.toFixed(2),
        delta: fmtPct(dxy.changePercent),
        direction: dirFromNum(dxy.changePercent, 0.05)
      });
    }
    if (us10yVal != null) {
      metrics.push({
        id: 'US10Y',
        label: 'US 10Y',
        value: `${us10yVal.toFixed(2)}%`,
        delta: fmtBps(us10yDeltaPts),
        direction: dirFromNum(us10yDeltaPts, 0.01),
        asOf: dgs10?.asOf
      });
    }
    if (real10yVal != null) {
      metrics.push({
        id: 'DFII10',
        label: 'Real 10Y',
        value: `${real10yVal.toFixed(2)}%`,
        delta: fmtBps(real10yDeltaPts),
        direction: dirFromNum(real10yDeltaPts, 0.01),
        asOf: dfii10?.asOf
      });
    }
    if (us2yVal != null) {
      metrics.push({
        id: 'DGS2',
        label: 'US 2Y',
        value: `${us2yVal.toFixed(2)}%`,
        delta: fmtBps(us2yDeltaPts),
        direction: dirFromNum(us2yDeltaPts, 0.01),
        asOf: dgs2?.asOf
      });
    }
    if (vix) {
      metrics.push({
        id: 'VIX',
        label: 'VIX',
        value: vix.price.toFixed(1),
        delta: fmtPct(vix.changePercent),
        direction: dirFromNum(vix.changePercent, 0.5)
      });
    }
    if (usoil) {
      metrics.push({
        id: 'USOIL',
        label: 'WTI',
        value: `$${usoil.price.toFixed(2)}`,
        delta: fmtPct(usoil.changePercent),
        direction: dirFromNum(usoil.changePercent, 0.2)
      });
    }

    const symbolBias: Record<string, SymbolMacroSummary> = {};
    for (const sym of REGIME_SYMBOLS) {
      const res = buildSymbolDriversAndBias(sym, {
        dxy,
        us10yVal,
        us10yDeltaPts,
        real10yVal,
        real10yDeltaPts,
        us2yVal,
        us2yDeltaPts,
        vix,
        usoil,
        spx,
        riskMode
      });
      symbolBias[sym] = { bias: res.bias, reason: res.reason };
    }

    const riskLabel =
      riskMode === 'risk_on' ? 'Risk-On' : riskMode === 'risk_off' ? 'Risk-Off' : 'Mixed Risk';
    const usdLabel =
      usdRegime === 'strong' ? 'USD Firm' : usdRegime === 'soft' ? 'USD Soft' : 'USD Flat';
    const yieldLabel =
      yieldsRegime === 'rising'
        ? 'Yields Rising'
        : yieldsRegime === 'falling'
          ? 'Yields Easing'
          : 'Yields Steady';

    const regime: MacroRegimeResponse = {
      riskMode,
      usdRegime,
      yieldsRegime,
      summary: `${riskLabel} · ${usdLabel} · ${yieldLabel}`,
      metrics,
      symbolBias,
      updatedAt: new Date().toISOString()
    };

    const snapshot: MacroSnapshot = {
      dxy,
      us10yQuote,
      vix,
      usoil,
      spx,
      xau,
      dgs10,
      dgs2,
      dfii10,
      t10y2y,
      riskMode,
      usdRegime,
      yieldsRegime,
      regime
    };

    regimeCache = { snapshot, fetchedAt: Date.now() };
    return snapshot;
  })();

  try {
    return await regimeInflight;
  } finally {
    regimeInflight = null;
  }
}

export function getDriversForSymbolFromSnapshot(
  shortName: string,
  snap: MacroSnapshot
): { bias: MacroBias; reason: string; drivers: SymbolDriver[] } {
  const live10y = normalizeYieldPrice(snap.us10yQuote);
  const us10yVal = live10y?.value ?? snap.dgs10?.latest ?? null;
  const us10yDeltaPts =
    live10y && Math.abs(live10y.deltaPts) > 0.0001 ? live10y.deltaPts : (snap.dgs10?.delta ?? 0);

  return buildSymbolDriversAndBias(shortName, {
    dxy: snap.dxy,
    us10yVal,
    us10yDeltaPts,
    real10yVal: snap.dfii10?.latest ?? null,
    real10yDeltaPts: snap.dfii10?.delta ?? 0,
    us2yVal: snap.dgs2?.latest ?? null,
    us2yDeltaPts: snap.dgs2?.delta ?? 0,
    vix: snap.vix,
    usoil: snap.usoil,
    spx: snap.spx,
    riskMode: snap.riskMode
  });
}

/** Look up recent FRED observation trend for major US economic releases. */
export async function getFredTrendForEvent(title: string, country: string): Promise<string | null> {
  if (country.toUpperCase() !== 'US') return null;
  const t = title.toLowerCase();

  let spec: { seriesId: string; mode: 'yoy' | 'mom' | 'deltaK' | 'levelPct' | 'levelK' } | null =
    null;

  if (t.includes('core cpi')) {
    spec = { seriesId: 'CPILFESL', mode: t.includes('mom') ? 'mom' : 'yoy' };
  } else if (t.includes('cpi') || t.includes('consumer price')) {
    spec = { seriesId: 'CPIAUCSL', mode: t.includes('mom') ? 'mom' : 'yoy' };
  } else if (t.includes('core pce')) {
    spec = { seriesId: 'PCEPILFE', mode: t.includes('mom') ? 'mom' : 'yoy' };
  } else if (t.includes('pce')) {
    spec = { seriesId: 'PCEPI', mode: t.includes('mom') ? 'mom' : 'yoy' };
  } else if (t.includes('ppi') || t.includes('producer price')) {
    spec = { seriesId: 'PPIFIS', mode: 'mom' };
  } else if (t.includes('nonfarm') || t.includes('non-farm') || t.includes('payroll')) {
    spec = { seriesId: 'PAYEMS', mode: 'deltaK' };
  } else if (t.includes('unemployment rate')) {
    spec = { seriesId: 'UNRATE', mode: 'levelPct' };
  } else if (t.includes('jobless claims') || t.includes('initial claims')) {
    spec = { seriesId: 'ICSA', mode: 'levelK' };
  } else if (t.includes('retail sales')) {
    spec = { seriesId: 'RSAFS', mode: 'mom' };
  } else if (t.includes('gdp')) {
    spec = { seriesId: 'A191RL1Q225SBEA', mode: 'levelPct' };
  } else if (t.includes('fomc') || t.includes('fed interest') || t.includes('federal funds')) {
    spec = { seriesId: 'DFEDTARU', mode: 'levelPct' };
  }

  if (!spec) return null;

  const cacheKey = `${spec.seriesId}|${spec.mode}`;
  const now = Date.now();
  const cached = fredEventTrendCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < FRED_EVENT_TTL_MS) {
    return cached.text;
  }

  const pts = await fetchFredSeriesPoints(spec.seriesId, spec.mode === 'yoy' ? 16 : 6);
  let text: string | null = null;

  if (spec.mode === 'yoy' && pts.length >= 14) {
    const latestYoy = ((pts[0].value - pts[12].value) / pts[12].value) * 100;
    const prevYoy = ((pts[1].value - pts[13].value) / pts[13].value) * 100;
    text = `FRED trend: ${prevYoy.toFixed(1)}% → ${latestYoy.toFixed(1)}% YoY`;
  } else if (spec.mode === 'mom' && pts.length >= 3) {
    const latestMom = ((pts[0].value - pts[1].value) / pts[1].value) * 100;
    const prevMom = ((pts[1].value - pts[2].value) / pts[2].value) * 100;
    text = `FRED trend: ${prevMom >= 0 ? '+' : ''}${prevMom.toFixed(1)}% → ${latestMom >= 0 ? '+' : ''}${latestMom.toFixed(1)}% MoM`;
  } else if (spec.mode === 'deltaK' && pts.length >= 3) {
    const latestK = Math.round(pts[0].value - pts[1].value);
    const prevK = Math.round(pts[1].value - pts[2].value);
    text = `FRED trend: ${prevK}K → ${latestK}K jobs`;
  } else if (spec.mode === 'levelPct' && pts.length >= 2) {
    text = `FRED trend: ${pts[1].value.toFixed(2)}% → ${pts[0].value.toFixed(2)}%`;
  } else if (spec.mode === 'levelK' && pts.length >= 2) {
    text = `FRED trend: ${Math.round(pts[1].value / 1000)}K → ${Math.round(pts[0].value / 1000)}K`;
  }

  fredEventTrendCache.set(cacheKey, { text, fetchedAt: now });
  return text;
}
