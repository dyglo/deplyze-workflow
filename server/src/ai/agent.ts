import { getCalendarEventsInWindow } from '../calendar/service.js';
import { resolveTimeZone } from '../calendar/time.js';
import type { CountryCode } from '../calendar/types.js';
import {
  getDislocationPayload,
  getDislocationScanPayload,
  parseTimeframe
} from '../insights/dislocation.js';
import { getSymbolSeasonalsPayload } from '../insights/seasonals.js';
import { getMacroRegimePayload, getSymbolBriefPayload } from '../insights/service.js';
import { getSymbolTechnicalsPayload } from '../insights/technicals.js';
import { getNewsFlowPayload } from '../news/service.js';
import {
  fetchOandaPositionBook,
  hasOandaPositionBook,
  isOandaConfigured
} from '../quotes/oanda.js';
import { getScreenerPayload } from '../screener/service.js';
import { getStrategyInstrumentSpec } from '../strategy/instruments.js';
import { inferRelevantCountries } from './context.js';
import { isTavilyConfigured, runTavilyFinanceSearch } from './tavily.js';
import type {
  AiAgentStep,
  AiApprovalCard,
  AiChartContext,
  AiChatHistoryMessage,
  AiClientAction,
  AiModelId,
  AiSourceLink,
  AiWorkspaceSnapshot
} from './types.js';

const DEFAULT_AGENT_UNIVERSE: Record<string, string[]> = {
  metals: ['OANDA:XAUUSD', 'OANDA:XAGUSD', 'TVC:USOIL', 'TVC:UKOIL', 'FX:NATGAS', 'OANDA:XCUUSD'],
  indices: ['TVC:DXY', 'NASDAQ:NDX', 'TVC:SPX', 'TVC:DJI', 'TVC:DEU40', 'TVC:UKX', 'TVC:NI225', 'TVC:VIX', 'TVC:US10Y'],
  fx: [
    'OANDA:EURUSD',
    'OANDA:GBPUSD',
    'OANDA:USDJPY',
    'OANDA:AUDUSD',
    'OANDA:USDCAD',
    'OANDA:USDCHF',
    'OANDA:NZDUSD',
    'OANDA:GBPJPY',
    'OANDA:EURJPY',
    'OANDA:EURGBP',
    'OANDA:AUDJPY',
    'OANDA:CADJPY',
    'OANDA:EURAUD',
    'OANDA:GBPAUD'
  ],
  crypto: ['BITSTAMP:BTCUSD', 'BITSTAMP:ETHUSD', 'BINANCE:SOLUSDT', 'BITSTAMP:XRPUSD'],
  stocks: ['NASDAQ:NVDA', 'NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:GOOGL', 'NASDAQ:AMZN', 'NASDAQ:META', 'NASDAQ:TSLA']
};

const ALL_UNIVERSE_SYMBOLS = Array.from(
  new Set([
    ...DEFAULT_AGENT_UNIVERSE.metals,
    ...DEFAULT_AGENT_UNIVERSE.indices,
    ...DEFAULT_AGENT_UNIVERSE.fx,
    ...DEFAULT_AGENT_UNIVERSE.crypto,
    ...DEFAULT_AGENT_UNIVERSE.stocks
  ])
);

const VALID_LAYOUTS = new Set([
  '1-single',
  '2-vertical',
  '2-horizontal',
  '3-columns',
  '3-rows',
  '3-left-big',
  '3-right-big',
  '3-bottom-big',
  '3-top-big',
  '4-grid',
  '4-rows',
  '4-columns',
  '4-left-big',
  '4-right-big',
  '4-top-big',
  '4-bottom-big'
]);

const VALID_PANELS = new Set([
  'list',
  'calendar',
  'tasks',
  'note',
  'alerts',
  'screener',
  'news',
  'dislocation'
]);

function getDeepSeekChatUrl(): string {
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    .trim()
    .replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function makeStepId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function shortTicker(raw: string): string {
  const s = (raw || '').trim().toUpperCase();
  const idx = s.indexOf(':');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function canonicalizeSymbol(raw: string): { symbol: string; shortName: string } {
  const cleaned = (raw || '').trim().toUpperCase().replace(/^\$/, '');
  const short = shortTicker(cleaned);
  const aliases: Record<string, string> = {
    GOLD: 'OANDA:XAUUSD',
    XAUUSD: 'OANDA:XAUUSD',
    SILVER: 'OANDA:XAGUSD',
    XAGUSD: 'OANDA:XAGUSD',
    USOIL: 'TVC:USOIL',
    WTI: 'TVC:USOIL',
    UKOIL: 'TVC:UKOIL',
    BRENT: 'TVC:UKOIL',
    DXY: 'TVC:DXY',
    VIX: 'TVC:VIX',
    US10Y: 'TVC:US10Y',
    SPX: 'TVC:SPX',
    US500: 'TVC:SPX',
    NAS100: 'NASDAQ:NDX',
    NDX: 'NASDAQ:NDX',
    US30: 'TVC:DJI',
    DJI: 'TVC:DJI',
    BTCUSD: 'BITSTAMP:BTCUSD',
    BTC: 'BITSTAMP:BTCUSD',
    ETHUSD: 'BITSTAMP:ETHUSD',
    ETH: 'BITSTAMP:ETHUSD'
  };
  if (aliases[short]) {
    return { symbol: aliases[short], shortName: shortTicker(aliases[short]) === 'NDX' ? 'NAS100' : short === 'GOLD' ? 'XAUUSD' : short === 'SILVER' ? 'XAGUSD' : short };
  }
  if (cleaned.includes(':')) {
    return { symbol: cleaned, shortName: short };
  }
  if (/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY){2}$/.test(short)) {
    return { symbol: `OANDA:${short}`, shortName: short };
  }
  return { symbol: cleaned, shortName: short };
}

function normalizeChartInterval(raw: string | undefined): string {
  const s = (raw ?? '60').trim().toUpperCase();
  if (s === '1M' || s === '1') return '1';
  if (s === '3M' || s === '3') return '3';
  if (s === '5M' || s === '5') return '5';
  if (s === '15M' || s === '15') return '15';
  if (s === '30M' || s === '30') return '30';
  if (s === '1H' || s === '60' || s === 'H1') return '60';
  if (s === '2H' || s === '120') return '120';
  if (s === '4H' || s === '240' || s === 'H4') return '240';
  if (s === '1D' || s === 'D' || s === 'DAILY') return 'D';
  if (s === '1W' || s === 'W' || s === 'WEEKLY') return 'W';
  return '60';
}

/**
 * Decides whether a user prompt benefits from the Multi-Step Agentic Planner (workspace actions,
 * multi-market scanning, dislocations, risk-sized order staging, position protection, multi-TF dossiers).
 */
export function shouldRunAgenticOrchestrator(
  latestUserText: string,
  hasRangeSelection: boolean
): boolean {
  const txt = latestUserText.trim();
  if (!txt || txt.length < 4) return false;
  if (/^(hi|hello|hey|thanks|thank you|what can you do\??)$/i.test(txt)) return false;

  // Explicit workspace / action / multi-market / risk / execution / institutional flow intents
  const actionOrScanRegex =
    /\b(set up|setup|configure|switch|change|open|layout|4-?grid|2-?vertical|multi-?chart|desk|pane|tab|watchlist|alert|notify|remind|note|journal|task|todo|rule|checklist|screen|scan|find\s+(me\s+)?(best|top|setups|pairs|stocks|opportunities|asymmetric|trapped|dislocat)|dislocation|smt|fair\s+value|trapped|crowd|position\s+book|stage|order|buy\s+limit|sell\s+limit|buy\s+stop|sell\s+stop|long\s+on|short\s+on|trade\s+plan|position\s+size|size\s+a|risk\s+\d|stop\s+loss|take\s+profit|breakeven|break-?even|protect|close\s+(my|the|half|50%|position)|modify\s+(sl|tp|bracket)|deploy|bot|forward|morning\s+brief|session\s+prep|prep\s+my|london\s+open|ny\s+open|macro\s+regime|seasonal|multi-?timeframe|mtf|full\s+technical|complete\s+breakdown|portfolio|exposure|playbook|my\s+positions|my\s+alerts|my\s+watchlist)\b/i;

  if (actionOrScanRegex.test(txt)) return true;

  // If user mentions another ticker not currently open, agent should fetch that symbol's live dossier!
  if (
    !hasRangeSelection &&
    /\b(XAUUSD|XAGUSD|EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF|NZDUSD|GBPJPY|EURJPY|NAS100|SPX|US30|DXY|USOIL|UKOIL|BTCUSD|ETHUSD|NVDA|AAPL|TSLA|MSFT|GOLD|SILVER)\b/i.test(
      txt
    )
  ) {
    return true;
  }

  return false;
}

/** Determine signed USD directional sensitivity (+1 = benefits from weaker USD / short USD; -1 = long USD). */
function inferUsdDirectionalSign(shortName: string, side: 'long' | 'short'): number {
  const s = shortName.toUpperCase();
  const dir = side === 'long' ? 1 : -1;
  if (s === 'DXY') return -dir;
  if (s.startsWith('USD')) return -dir; // Long USDJPY / USDCAD / USDCHF = Long USD (-1)
  if (
    s.endsWith('USD') ||
    s.includes('XAU') ||
    s.includes('XAG') ||
    s.includes('GOLD') ||
    s.includes('SILVER') ||
    s.includes('NAS') ||
    s.includes('SPX') ||
    s.includes('US30') ||
    s.includes('BTC') ||
    s.includes('ETH')
  ) {
    return dir; // Long EURUSD / XAUUSD / NAS100 = Short USD (+1)
  }
  return 0;
}

function roundToStep(val: number, step: number): number {
  if (!Number.isFinite(val) || !Number.isFinite(step) || step <= 0) return val;
  const inv = 1 / step;
  return Math.round(val * inv) / inv;
}

interface RiskAuditResult {
  symbol: string;
  shortName: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop';
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPct: number;
  riskUsd: number | null;
  suggestedQuantity: number;
  rrRatio: number | null;
  equityUsed: number;
  paperConnected: boolean;
  correlatedPositions: string[];
  imminentEvents: string[];
  uncheckedRulesCount: number;
  playbookNote: string | null;
  warnings: string[];
}

async function runDeterministicRiskAudit(
  args: Record<string, unknown>,
  workspace: AiWorkspaceSnapshot | undefined,
  tz: string
): Promise<RiskAuditResult> {
  const rawSym = String(args.symbol ?? 'OANDA:XAUUSD');
  const { symbol, shortName } = canonicalizeSymbol(rawSym);
  const side: 'buy' | 'sell' = String(args.side ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const rawType = String(args.orderType ?? 'limit').toLowerCase();
  const orderType: 'market' | 'limit' | 'stop' =
    rawType === 'market' || rawType === 'stop' ? rawType : 'limit';

  const spec = getStrategyInstrumentSpec(symbol);
  let entryPrice = Number(args.entryPrice);
  const stopLossRaw = args.stopLoss != null ? Number(args.stopLoss) : NaN;
  const takeProfitRaw = args.takeProfit != null ? Number(args.takeProfit) : NaN;
  const riskPct = Math.max(
    0.1,
    Math.min(5, Number.isFinite(Number(args.riskPct)) ? Number(args.riskPct) : 1.0)
  );

  // If entryPrice missing, pull live technicals/price
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const tech = await getSymbolTechnicalsPayload(symbol, '1h').catch(() => null);
    entryPrice = tech?.price ?? 0;
  }

  const stopLoss = Number.isFinite(stopLossRaw) && stopLossRaw > 0 ? roundToStep(stopLossRaw, spec.tickSize) : null;
  const takeProfit =
    Number.isFinite(takeProfitRaw) && takeProfitRaw > 0 ? roundToStep(takeProfitRaw, spec.tickSize) : null;

  const equity =
    workspace?.paper?.equity && Number.isFinite(workspace.paper.equity) && workspace.paper.equity > 0
      ? workspace.paper.equity
      : workspace?.paper?.balance && Number.isFinite(workspace.paper.balance) && workspace.paper.balance > 0
        ? workspace.paper.balance
        : 100_000;

  const warnings: string[] = [];
  if (!workspace?.paper?.connected) {
    warnings.push('Paper Ledger is disconnected; connect Paper Ledger to execute or stage live orders.');
  }

  // Validate SL / TP geometry against trade side
  let validSl = stopLoss;
  let validTp = takeProfit;
  if (entryPrice > 0 && validSl !== null) {
    if (side === 'buy' && validSl >= entryPrice) {
      warnings.push(`Stop Loss (${validSl}) must be below Entry (${entryPrice}) for a Buy.`);
      validSl = null;
    } else if (side === 'sell' && validSl <= entryPrice) {
      warnings.push(`Stop Loss (${validSl}) must be above Entry (${entryPrice}) for a Sell.`);
      validSl = null;
    }
  }
  if (entryPrice > 0 && validTp !== null) {
    if (side === 'buy' && validTp <= entryPrice) {
      warnings.push(`Take Profit (${validTp}) must be above Entry (${entryPrice}) for a Buy.`);
      validTp = null;
    } else if (side === 'sell' && validTp >= entryPrice) {
      warnings.push(`Take Profit (${validTp}) must be below Entry (${entryPrice}) for a Sell.`);
      validTp = null;
    }
  }

  let riskUsd: number | null = Number(((equity * riskPct) / 100).toFixed(2));
  let suggestedQuantity = spec.qtyStep;
  let rrRatio: number | null = null;

  if (entryPrice > 0 && validSl !== null) {
    const slDist = Math.abs(entryPrice - validSl);
    if (slDist > 0) {
      // Estimate USD risk per 1 unit matching paper/instruments.ts:
      // For XXX/USD pairs, Metals, Oil, Indices, Crypto -> 1 price move per 1 unit = $1 (unit-based Paper Ledger!)
      // For USD/JPY, USD/CAD, USD/CHF -> 1 price move per 1 unit = $1 / entryPrice
      const isUsdBaseFx = shortName.startsWith('USD') && shortName.length === 6;
      const usdPerUnitMove = isUsdBaseFx ? slDist / entryPrice : slDist;
      const rawUnits = usdPerUnitMove > 0 ? riskUsd / usdPerUnitMove : spec.qtyStep;
      suggestedQuantity = Math.max(
        spec.qtyStep,
        roundToStep(rawUnits, spec.qtyStep)
      );
      if (validTp !== null) {
        rrRatio = Number((Math.abs(validTp - entryPrice) / slDist).toFixed(2));
        if (rrRatio < 1.5) {
          warnings.push(`Risk-to-Reward is ${rrRatio}:1 (below institutional 1.5:1 threshold).`);
        }
      }
    }
  } else {
    riskUsd = null;
    warnings.push('No Stop Loss specified — position sized to minimum lot step; add a stop loss to cap downside.');
  }

  // Correlated USD portfolio exposure audit
  const proposedSign = inferUsdDirectionalSign(shortName, side === 'buy' ? 'long' : 'short');
  const correlatedPositions: string[] = [];
  if (proposedSign !== 0 && workspace?.paper?.openPositions) {
    for (const pos of workspace.paper.openPositions) {
      const posSign = inferUsdDirectionalSign(pos.shortName, pos.side);
      if (posSign === proposedSign) {
        correlatedPositions.push(`${pos.side.toUpperCase()} ${pos.shortName} (${pos.quantity} u)`);
      }
    }
  }
  if (correlatedPositions.length > 0) {
    warnings.push(
      `Correlated USD exposure: already holding ${correlatedPositions.join(', ')} in the same USD direction.`
    );
  }

  // Imminent High-Impact Economic Calendar Risk Check (next 90 minutes)
  const nowSec = Math.floor(Date.now() / 1000);
  const countries = Array.from(new Set<CountryCode>([...inferRelevantCountries(shortName), 'US']));
  const cal = await getCalendarEventsInWindow(nowSec, nowSec + 90 * 60, tz, {
    padBeforeSec: 15 * 60,
    padAfterSec: 0,
    countries
  }).catch(() => ({ events: [], timezone: tz, sources: [] }));

  const imminentEvents = cal.events
    .filter((ev) => ev.impact === 'high')
    .slice(0, 4)
    .map((ev) => `${ev.time} ${tz} [${ev.country}] ${ev.title}`);
  if (imminentEvents.length > 0) {
    warnings.push(`Event Risk Lock: High-impact release within 90m — ${imminentEvents[0]}.`);
  }

  const uncheckedRulesCount = workspace?.uncheckedPreTradeRules?.length ?? 0;
  let playbookNote: string | null = null;
  if (workspace?.playbookSummary && workspace.playbookSummary.totalEntries > 0) {
    const pb = workspace.playbookSummary;
    playbookNote = `Playbook (${pb.totalEntries} logged): ${pb.winRatePct !== null ? `${pb.winRatePct}% WR` : 'n/a'}, ${pb.totalR !== null ? `${pb.totalR >= 0 ? '+' : ''}${pb.totalR}R` : 'n/a'}${pb.bestSetup ? `, best setup: ${pb.bestSetup}` : ''}.`;
  }

  return {
    symbol,
    shortName,
    side,
    orderType,
    entryPrice: roundToStep(entryPrice, spec.tickSize),
    stopLoss: validSl,
    takeProfit: validTp,
    riskPct,
    riskUsd,
    suggestedQuantity,
    rrRatio,
    equityUsed: equity,
    paperConnected: Boolean(workspace?.paper?.connected),
    correlatedPositions,
    imminentEvents,
    uncheckedRulesCount,
    playbookNote,
    warnings
  };
}

interface PlannerToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface PlannerResponse {
  thought?: string;
  toolCalls?: PlannerToolCall[];
  clientActions?: Array<Record<string, unknown>>;
  approvalCards?: Array<Record<string, unknown>>;
  done?: boolean;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : cleaned;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sanitizeClientActions(rawList: unknown): AiClientAction[] {
  if (!Array.isArray(rawList)) return [];
  const out: AiClientAction[] = [];

  for (const raw of rawList.slice(0, 6)) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const kind = String(obj.kind ?? '').trim();
    const id = makeStepId('act');

    if (kind === 'configure_chart_desk') {
      const rawPanes = Array.isArray(obj.panes) ? obj.panes : [];
      const panes = rawPanes
        .slice(0, 4)
        .map((p, idx) => {
          if (!p || typeof p !== 'object') return null;
          const pr = p as Record<string, unknown>;
          const symStr = String(pr.symbol ?? '').trim();
          if (!symStr) return null;
          const norm = canonicalizeSymbol(symStr);
          return {
            paneIndex: typeof pr.paneIndex === 'number' && Number.isFinite(pr.paneIndex) ? pr.paneIndex : idx,
            symbol: norm.symbol,
            interval: pr.interval ? normalizeChartInterval(String(pr.interval)) : undefined
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const layoutRaw = typeof obj.layoutId === 'string' ? obj.layoutId.trim() : undefined;
      const layoutId = layoutRaw && VALID_LAYOUTS.has(layoutRaw) ? layoutRaw : undefined;
      if (panes.length === 0 && !layoutId) continue;

      out.push({
        id,
        kind: 'configure_chart_desk',
        label: String(obj.label ?? `Configure ${layoutId ?? 'chart'} desk`).slice(0, 80),
        layoutId,
        openInNewTab: Boolean(obj.openInNewTab),
        tabTitle: typeof obj.tabTitle === 'string' ? obj.tabTitle.trim().slice(0, 32) : undefined,
        panes
      });
    } else if (kind === 'manage_watchlist') {
      const rawItems = Array.isArray(obj.items) ? obj.items : [];
      const items = rawItems
        .slice(0, 12)
        .map((it) => {
          if (typeof it === 'string') {
            return { symbol: canonicalizeSymbol(it).symbol };
          }
          if (!it || typeof it !== 'object') return null;
          const ir = it as Record<string, unknown>;
          const symStr = String(ir.symbol ?? '').trim();
          if (!symStr) return null;
          const rawBias = String(ir.bias ?? '').toLowerCase();
          const bias: 'bull' | 'bear' | 'range' | 'none' | undefined =
            rawBias === 'bull' || rawBias === 'bear' || rawBias === 'range' || rawBias === 'none'
              ? rawBias
              : undefined;
          return {
            symbol: canonicalizeSymbol(symStr).symbol,
            bias,
            poiNote: typeof ir.poiNote === 'string' ? ir.poiNote.trim().slice(0, 90) : undefined
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const groupName = String(obj.groupName ?? 'AI Focus').trim().slice(0, 36);
      const rawMode = String(obj.mode ?? 'add_symbols');
      const mode: 'create_group' | 'add_symbols' | 'update_bias' =
        rawMode === 'create_group' || rawMode === 'update_bias' ? rawMode : 'add_symbols';
      if (items.length === 0) continue;

      out.push({
        id,
        kind: 'manage_watchlist',
        label: String(obj.label ?? `Update watchlist "${groupName}"`).slice(0, 80),
        mode,
        groupName,
        sectionName:
          typeof obj.sectionName === 'string' && obj.sectionName.trim()
            ? obj.sectionName.trim().slice(0, 28).toUpperCase()
            : undefined,
        items
      });
    } else if (kind === 'create_alert') {
      const norm = canonicalizeSymbol(String(obj.symbol ?? 'OANDA:XAUUSD'));
      const rawConds = Array.isArray(obj.conditions) ? obj.conditions : [];
      const validMetrics = new Set(['price', 'rsi14', 'tech_rating', 'change_pct', 'range_pos']);
      const validOps = new Set([
        'crossing',
        'crossing_up',
        'crossing_down',
        'greater_than',
        'less_than',
        'abs_gte',
        'is_rating'
      ]);
      const validRatings = new Set([
        'strong_buy',
        'buy_or_strong',
        'neutral',
        'sell_or_strong',
        'strong_sell'
      ]);

      const conditions = rawConds
        .slice(0, 4)
        .map((c) => {
          if (!c || typeof c !== 'object') return null;
          const cr = c as Record<string, unknown>;
          const metric = String(cr.metric ?? 'price');
          const operator = String(cr.operator ?? 'crossing');
          if (!validMetrics.has(metric) || !validOps.has(operator)) return null;
          const val = cr.value != null ? Number(cr.value) : undefined;
          const rt = typeof cr.ratingTarget === 'string' && validRatings.has(cr.ratingTarget)
            ? cr.ratingTarget
            : undefined;
          if (metric !== 'tech_rating' && (val === undefined || !Number.isFinite(val))) return null;
          return {
            symbol: typeof cr.symbol === 'string' && cr.symbol.trim()
              ? canonicalizeSymbol(cr.symbol).symbol
              : undefined,
            metric: metric as 'price' | 'rsi14' | 'tech_rating' | 'change_pct' | 'range_pos',
            operator: operator as
              | 'crossing'
              | 'crossing_up'
              | 'crossing_down'
              | 'greater_than'
              | 'less_than'
              | 'abs_gte'
              | 'is_rating',
            value: val,
            ratingTarget: rt as
              | 'strong_buy'
              | 'buy_or_strong'
              | 'neutral'
              | 'sell_or_strong'
              | 'strong_sell'
              | undefined
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (conditions.length === 0) continue;

      out.push({
        id,
        kind: 'create_alert',
        label: String(obj.label ?? `Create alert on ${norm.shortName}`).slice(0, 80),
        symbol: norm.symbol,
        scope: obj.scope === 'watchlist' ? 'watchlist' : 'symbol',
        watchlistGroupName:
          typeof obj.watchlistGroupName === 'string' ? obj.watchlistGroupName.trim() : undefined,
        logic: obj.logic === 'or' ? 'or' : 'and',
        conditions,
        trigger: obj.trigger === 'every' ? 'every' : 'once',
        message: typeof obj.message === 'string' ? obj.message.trim().slice(0, 160) : undefined
      });
    } else if (kind === 'update_alert') {
      const alertId = String(obj.alertId ?? '').trim();
      const op = String(obj.operation ?? '').trim();
      if (
        !alertId ||
        !(op === 'pause' || op === 'resume' || op === 'delete' || op === 'update_price')
      ) {
        continue;
      }
      const newPrice = obj.newPrice != null && Number.isFinite(Number(obj.newPrice)) ? Number(obj.newPrice) : undefined;
      out.push({
        id,
        kind: 'update_alert',
        label: String(obj.label ?? `Update alert`).slice(0, 80),
        alertId,
        operation: op,
        newPrice
      });
    } else if (kind === 'create_note') {
      const title = String(obj.title ?? '').trim().slice(0, 100);
      const body = String(obj.body ?? '').trim().slice(0, 4000);
      if (!title || !body) continue;
      out.push({
        id,
        kind: 'create_note',
        label: String(obj.label ?? `Save note "${title}"`).slice(0, 80),
        title,
        body,
        symbol: typeof obj.symbol === 'string' && obj.symbol.trim()
          ? canonicalizeSymbol(obj.symbol).symbol
          : undefined
      });
    } else if (kind === 'add_tasks') {
      const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
      const tasks = rawTasks
        .slice(0, 8)
        .map((t) => {
          if (typeof t === 'string' && t.trim()) return { title: t.trim().slice(0, 120) };
          if (!t || typeof t !== 'object') return null;
          const tr = t as Record<string, unknown>;
          const title = String(tr.title ?? '').trim().slice(0, 120);
          if (!title) return null;
          return {
            title,
            symbol: typeof tr.symbol === 'string' && tr.symbol.trim()
              ? shortTicker(tr.symbol)
              : undefined
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const rules = Array.isArray(obj.preTradeRules)
        ? obj.preTradeRules
            .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
            .slice(0, 4)
            .map((r) => r.trim().slice(0, 120))
        : undefined;
      if (tasks.length === 0 && (!rules || rules.length === 0)) continue;
      out.push({
        id,
        kind: 'add_tasks',
        label: String(obj.label ?? `Add ${tasks.length} trading task(s)`).slice(0, 80),
        tasks,
        preTradeRules: rules
      });
    } else if (kind === 'open_panel') {
      const panel = String(obj.panel ?? '').trim();
      if (!VALID_PANELS.has(panel)) continue;
      out.push({
        id,
        kind: 'open_panel',
        label: String(obj.label ?? `Open ${panel} panel`).slice(0, 80),
        panel: panel as
          | 'list'
          | 'calendar'
          | 'tasks'
          | 'note'
          | 'alerts'
          | 'screener'
          | 'news'
          | 'dislocation'
      });
    }
  }

  return out;
}

async function sanitizeApprovalCards(
  rawList: unknown,
  workspace: AiWorkspaceSnapshot | undefined,
  tz: string
): Promise<AiApprovalCard[]> {
  if (!Array.isArray(rawList)) return [];
  const out: AiApprovalCard[] = [];

  for (const raw of rawList.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const kind = String(obj.kind ?? '').trim();
    const id = makeStepId('appr');

    if (kind === 'stage_paper_order') {
      // ALWAYS pass through deterministic risk audit so lot size, R:R, and warnings are mathematically verified!
      const audit = await runDeterministicRiskAudit(obj, workspace, tz);
      if (audit.entryPrice <= 0) continue;
      const llmWarnings = Array.isArray(obj.warnings)
        ? obj.warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        : [];
      const mergedWarnings = Array.from(new Set([...audit.warnings, ...llmWarnings])).slice(0, 4);

      out.push({
        id,
        kind: 'stage_paper_order',
        title: String(
          obj.title ?? `${audit.side.toUpperCase()} ${audit.orderType.toUpperCase()} ${audit.shortName}`
        ).slice(0, 72),
        rationale: String(obj.rationale ?? 'Risk-sized institutional order proposal').slice(0, 220),
        symbol: audit.symbol,
        shortName: audit.shortName,
        side: audit.side,
        orderType: audit.orderType,
        entryPrice: audit.entryPrice,
        stopLoss: audit.stopLoss,
        takeProfit: audit.takeProfit,
        riskPct: audit.riskPct,
        riskUsd: audit.riskUsd,
        suggestedQuantity: audit.suggestedQuantity,
        rrRatio: audit.rrRatio,
        spreadNote: typeof obj.spreadNote === 'string' ? obj.spreadNote.slice(0, 80) : undefined,
        warnings: mergedWarnings
      });
    } else if (kind === 'protect_position') {
      const posId = String(obj.positionId ?? '').trim();
      const matchedPos = workspace?.paper?.openPositions?.find((p) => p.id === posId) ??
        workspace?.paper?.openPositions?.find(
          (p) => shortTicker(p.shortName) === shortTicker(String(obj.symbol ?? ''))
        );
      if (!matchedPos) continue;
      const opRaw = String(obj.operation ?? 'modify_brackets');
      const operation: 'modify_brackets' | 'close_partial' | 'close_full' =
        opRaw === 'close_partial' || opRaw === 'close_full' ? opRaw : 'modify_brackets';
      const newStopLoss =
        obj.newStopLoss === null
          ? null
          : obj.newStopLoss !== undefined && Number.isFinite(Number(obj.newStopLoss))
            ? Number(obj.newStopLoss)
            : undefined;
      const newTakeProfit =
        obj.newTakeProfit === null
          ? null
          : obj.newTakeProfit !== undefined && Number.isFinite(Number(obj.newTakeProfit))
            ? Number(obj.newTakeProfit)
            : undefined;
      const closeFraction =
        operation === 'close_partial'
          ? Math.max(0.1, Math.min(0.95, Number(obj.closeFraction) || 0.5))
          : undefined;
      const warnings = Array.isArray(obj.warnings)
        ? obj.warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).slice(0, 3)
        : [];

      out.push({
        id,
        kind: 'protect_position',
        title: String(obj.title ?? `Protect ${matchedPos.side.toUpperCase()} ${matchedPos.shortName}`).slice(0, 72),
        rationale: String(obj.rationale ?? 'Adjust live Paper position risk brackets').slice(0, 220),
        positionId: matchedPos.id,
        symbol: matchedPos.symbol,
        shortName: matchedPos.shortName,
        side: matchedPos.side,
        operation,
        newStopLoss,
        newTakeProfit,
        closeFraction,
        warnings
      });
    } else if (kind === 'deploy_strategy_bot') {
      const stratId = String(obj.strategyId ?? '').trim();
      const matched = workspace?.savedStrategies?.find((s) => s.id === stratId);
      if (!matched) continue;
      out.push({
        id,
        kind: 'deploy_strategy_bot',
        title: String(obj.title ?? `Deploy SIM Bot: ${matched.name}`).slice(0, 72),
        rationale: String(obj.rationale ?? 'Forward-test verified strategy on isolated Paper account').slice(0, 220),
        strategyId: matched.id,
        strategyName: matched.name,
        symbol: matched.symbol,
        interval: matched.interval,
        executionMode: obj.executionMode === 'auto_sim' ? 'auto_sim' : 'notify',
        maxDailyLossPct: Math.max(0.5, Math.min(10, Number(obj.maxDailyLossPct) || 3)),
        warnings: Array.isArray(obj.warnings)
          ? obj.warnings.filter((w): w is string => typeof w === 'string').slice(0, 3)
          : []
      });
    }
  }

  return out;
}

const AGENT_PLANNER_SYSTEM_PROMPT = `You are the DeplyzeWorkflow Institutional Desk Agent Orchestrator.
You THINK, PLAN, call deterministic SERVER QUANT TOOLS to gather real live data, and optionally emit WORKSPACE CLIENT ACTIONS (Tier 1) and HUMAN-APPROVED RISK/EXECUTION CARDS (Tier 2).

You MUST respond with STRICT JSON ONLY (no prose outside JSON):
{
  "thought": "1-sentence concise reasoning for this step",
  "toolCalls": [ { "tool": "<name>", "args": { ... } } ],
  "clientActions": [ ... ],
  "approvalCards": [ ... ],
  "done": true | false
}

AVAILABLE SERVER READ/COMPUTE TOOLS (can invoke 1 to 4 in parallel per turn):
1. "scan_screener": { "scope": "all"|"fx"|"metals"|"indices"|"crypto"|"stocks"|"watchlist", "minRsi"?: number, "maxRsi"?: number, "minAdx"?: number, "rating"?: "Strong buy"|"Buy"|"Sell"|"Strong sell", "crowdSkew"?: "crowded_long"|"crowded_short"|"balanced", "minTrappedPct"?: number, "sortBy"?: "recommendAll"|"changePercent"|"rsi14"|"adx14"|"trappedPct", "limit"?: number }
   -> Live OANDA/global screener with RSI, ADX, ATR, Spread/ATR, MTF rating, and OANDA Position Book trapped crowd %.
2. "scan_dislocations": { "timeframe": "15m"|"1h"|"4h", "minConviction"?: number, "symbol"?: string }
   -> Econometric Intermarket Fair-Value Dislocation Radar (Z-score, R², lead-lag drivers, Asia/London/PDH/PDL SMT liquidity sweeps, Event Risk Lock, expected target & invalidation). Pass "symbol" to drill into one symbol's full breakdown.
3. "get_symbol_dossier": { "symbol": "OANDA:XAUUSD", "intervals"?: ["15m","1h","4h","1D"], "includeSeasonals"?: boolean }
   -> Synchronized OANDA multi-timeframe technicals, pivots, live macro brief, OANDA Position Book skew, and optional monthly seasonality.
4. "get_calendar_and_news": { "symbol"?: "OANDA:XAUUSD", "hoursBack"?: number, "hoursAhead"?: number, "query"?: string }
   -> Live FRED Macro Regime + economic calendar releases (actual/forecast/prior) + News Flow + Tavily web search.
5. "audit_risk_and_sizing": { "symbol": "OANDA:XAUUSD", "side": "buy"|"sell", "orderType": "market"|"limit"|"stop", "entryPrice": number, "stopLoss"?: number, "takeProfit"?: number, "riskPct"?: number }
   -> Deterministic lot sizing from live Paper equity, R:R ratio, correlated USD open-position audit, imminent high-impact event check, and Playbook stats. ALWAYS call this BEFORE emitting a "stage_paper_order" approvalCard!

AVAILABLE TIER-1 CLIENT WORKSPACE ACTIONS (emit ONLY when the user explicitly asks to act on their workspace, or asks to prep a desk / set alerts / create watchlist / save notes / add tasks; emit on final "done": true turn):
- { "kind": "configure_chart_desk", "label": "...", "layoutId"?: "1-single"|"2-vertical"|"2-horizontal"|"3-left-big"|"4-grid", "openInNewTab"?: boolean, "tabTitle"?: "...", "panes": [{ "paneIndex": 0, "symbol": "OANDA:XAUUSD", "interval": "15" }] }
- { "kind": "manage_watchlist", "label": "...", "mode": "create_group"|"add_symbols"|"update_bias", "groupName": "Session Focus", "sectionName"?: "TOP SETUPS", "items": [{ "symbol": "OANDA:XAUUSD", "bias": "bull"|"bear"|"range", "poiNote": "Demand 3640" }] }
- { "kind": "create_alert", "label": "...", "symbol": "OANDA:XAUUSD", "scope"?: "symbol"|"watchlist", "watchlistGroupName"?: "...", "logic"?: "and"|"or", "conditions": [{ "metric": "price"|"rsi14"|"tech_rating"|"change_pct"|"range_pos", "operator": "crossing"|"crossing_up"|"crossing_down"|"greater_than"|"less_than"|"abs_gte"|"is_rating", "value"?: 3680, "ratingTarget"?: "strong_buy" }], "trigger"?: "once"|"every", "message"?: "..." }
- { "kind": "update_alert", "label": "...", "alertId": "<id from workspace>", "operation": "pause"|"resume"|"delete"|"update_price", "newPrice"?: number }
- { "kind": "create_note", "label": "...", "title": "...", "body": "clean plain text brief", "symbol"?: "OANDA:XAUUSD" }
- { "kind": "add_tasks", "label": "...", "tasks": [{ "title": "...", "symbol"?: "XAUUSD" }], "preTradeRules"?: ["..."] }
- { "kind": "open_panel", "label": "...", "panel": "list"|"calendar"|"tasks"|"note"|"alerts"|"screener"|"news"|"dislocation" }

AVAILABLE TIER-2 HUMAN-APPROVAL CARDS (NEVER auto-executed — user clicks Approve/Stage in UI; emit on final "done": true turn):
- { "kind": "stage_paper_order", "title": "BUY LIMIT XAUUSD", "rationale": "...", "symbol": "OANDA:XAUUSD", "side": "buy"|"sell", "orderType": "market"|"limit"|"stop", "entryPrice": 3640, "stopLoss": 3628, "takeProfit": 3668, "riskPct": 1.0 }
- { "kind": "protect_position", "title": "Move XAUUSD SL to Breakeven", "rationale": "...", "positionId": "<exact id from workspace.paper.openPositions>", "symbol": "OANDA:XAUUSD", "operation": "modify_brackets"|"close_partial"|"close_full", "newStopLoss"?: 3640, "newTakeProfit"?: 3690, "closeFraction"?: 0.5 }
- { "kind": "deploy_strategy_bot", "title": "Deploy SIM Bot", "rationale": "...", "strategyId": "<exact id from workspace.savedStrategies>", "executionMode": "notify"|"auto_sim", "maxDailyLossPct": 3 }

STRICT OPERATING RULES:
1. NEVER invent prices, indicator values, alert IDs, or position IDs — fetch them via tools or read them from WORKSPACE SNAPSHOT first!
2. If you need market data BEFORE deciding what actions/alerts/orders to emit, set "done": false and issue your "toolCalls" first! On the next turn after seeing the tool results, emit your "clientActions" / "approvalCards" and set "done": true.
3. For pure Q&A where no workspace mutation was requested, keep "clientActions": [] and "approvalCards": [].
4. Be efficient: batch independent read tools in parallel on Turn 1, and finish in 1–2 tool rounds whenever possible.`;

export interface AgentOrchestrationResult {
  ranAgent: boolean;
  steps: AiAgentStep[];
  clientActions: AiClientAction[];
  approvalCards: AiApprovalCard[];
  sources: AiSourceLink[];
  usedWebSearch: boolean;
  telemetryDossier: string;
}

export async function runAgenticOrchestrator(params: {
  apiKey: string;
  model: AiModelId;
  history: AiChatHistoryMessage[];
  latestUserText: string;
  context?: AiChartContext;
  workspace?: AiWorkspaceSnapshot;
  webSearchMode: 'auto' | 'on' | 'off';
  abortSignal: AbortSignal;
  onStep: (step: AiAgentStep) => void;
  onStatus: (phase: string, label: string) => void;
}): Promise<AgentOrchestrationResult> {
  const {
    apiKey,
    model,
    history,
    latestUserText,
    context,
    workspace,
    webSearchMode,
    abortSignal,
    onStep,
    onStatus
  } = params;

  const tz = resolveTimeZone(context?.timezone);
  const steps: AiAgentStep[] = [];
  const allSources: AiSourceLink[] = [];
  const seenSourceUrls = new Set<string>();
  let usedWebSearch = false;

  const pushSource = (src: AiSourceLink) => {
    if (!src.url || seenSourceUrls.has(src.url)) return;
    seenSourceUrls.add(src.url);
    allSources.push(src);
  };

  const toolTranscript: Array<{ tool: string; args: Record<string, unknown>; result: unknown }> = [];
  let finalClientActions: AiClientAction[] = [];
  let finalApprovalCards: AiApprovalCard[] = [];

  const compactWorkspace = workspace
    ? JSON.stringify(workspace).slice(0, 3200)
    : 'No workspace snapshot attached.';

  const recentHistory = history
    .slice(-6)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`)
    .join('\n');

  const MAX_TURNS = 3;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (abortSignal.aborted) break;
    onStatus('agent_plan', turn === 1 ? 'Planning desk workflow & tools...' : `Synthesizing step ${turn}...`);

    const userMessage = [
      `ACTIVE CHART: symbol=${context?.symbol || 'XAUUSD'} (${context?.fullSymbol || 'OANDA:XAUUSD'}), interval=${context?.interval || 'D'}, livePrice=${context?.price ?? 'unknown'}, timezone=${tz}, webSearchMode=${webSearchMode}`,
      `WORKSPACE SNAPSHOT:\n${compactWorkspace}`,
      recentHistory ? `RECENT CONVERSATION:\n${recentHistory}` : '',
      `LATEST USER REQUEST:\n${latestUserText}`,
      toolTranscript.length > 0
        ? `TOOL RESULTS ALREADY COLLECTED:\n${JSON.stringify(toolTranscript, null, 2).slice(0, 14000)}`
        : '',
      turn === MAX_TURNS
        ? `This is the final planning turn. Set "done": true, emit any requested "clientActions" / "approvalCards" using the verified tool data above, and leave "toolCalls": [].`
        : `Return strict JSON plan.`
    ]
      .filter(Boolean)
      .join('\n\n');

    let planObj: PlannerResponse | null = null;
    try {
      const plannerRes = await fetch(getDeepSeekChatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
          thinking: { type: 'disabled' },
          temperature: 0.1,
          max_tokens: 1800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: AGENT_PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
          ]
        }),
        signal: abortSignal
      });
      if (!plannerRes.ok) break;
      const data = (await plannerRes.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const rawContent = data.choices?.[0]?.message?.content ?? '';
      planObj = extractJsonObject(rawContent) as PlannerResponse | null;
    } catch {
      break;
    }

    if (!planObj) break;

    const rawCalls =
      turn < MAX_TURNS && Array.isArray(planObj.toolCalls) ? planObj.toolCalls.slice(0, 4) : [];

    // Execute all requested server tools in parallel
    if (rawCalls.length > 0) {
      const results = await Promise.all(
        rawCalls.map(async (tc) => {
          const toolName = String(tc.tool ?? '').trim();
          const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
          const stepId = makeStepId('step');
          const label = describeToolCall(toolName, args);
          const runningStep: AiAgentStep = { id: stepId, tool: toolName, label, status: 'running' };
          steps.push(runningStep);
          onStep(runningStep);

          try {
            const executed = await executeServerTool(
              toolName,
              args,
              context,
              workspace,
              tz,
              webSearchMode,
              pushSource
            );
            if (executed.usedWebSearch) usedWebSearch = true;
            const doneStep: AiAgentStep = {
              id: stepId,
              tool: toolName,
              label,
              status: 'done',
              detail: executed.detail
            };
            const idx = steps.findIndex((s) => s.id === stepId);
            if (idx >= 0) steps[idx] = doneStep;
            onStep(doneStep);
            return { tool: toolName, args, result: executed.result };
          } catch (err) {
            const errStep: AiAgentStep = {
              id: stepId,
              tool: toolName,
              label,
              status: 'error',
              detail: (err as Error).message.slice(0, 90)
            };
            const idx = steps.findIndex((s) => s.id === stepId);
            if (idx >= 0) steps[idx] = errStep;
            onStep(errStep);
            return { tool: toolName, args, result: { error: (err as Error).message } };
          }
        })
      );
      toolTranscript.push(...results);
    }

    // Collect actions & approval cards when planner marks done (or on final turn)
    if (planObj.done || rawCalls.length === 0 || turn === MAX_TURNS) {
      finalClientActions = sanitizeClientActions(planObj.clientActions);
      finalApprovalCards = await sanitizeApprovalCards(planObj.approvalCards, workspace, tz);
      break;
    }
  }

  // Build grounded telemetry dossier for the final streaming synthesis pass
  const dossierParts: string[] = [];
  if (toolTranscript.length > 0) {
    dossierParts.push(
      `AGENTIC TOOL TELEMETRY (LIVE VERIFIED DATA — CITE THESE EXACT FIGURES):\n${JSON.stringify(toolTranscript, null, 2).slice(0, 16000)}`
    );
  }
  if (finalClientActions.length > 0) {
    dossierParts.push(
      `TIER-1 WORKSPACE ACTIONS DISPATCHED AUTOMATICALLY ON USER'S WORKSPACE (WITH 1-CLICK UNDO):\n${JSON.stringify(
        finalClientActions.map((a) => ({ kind: a.kind, label: a.label })),
        null,
        2
      )}\nMention briefly what you executed on their workspace (e.g. desk layout, watchlist, alerts, notes, tasks).`
    );
  }
  if (finalApprovalCards.length > 0) {
    dossierParts.push(
      `TIER-2 HUMAN-APPROVAL CARDS RENDERED IN CHAT (AWAITING 1-CLICK USER CONFIRMATION):\n${JSON.stringify(finalApprovalCards, null, 2)}\nRefer clearly to the interactive approval card(s) below so the trader can review and click Stage Ticket / Execute / Apply Protection.`
    );
  }

  return {
    ranAgent: steps.length > 0 || finalClientActions.length > 0 || finalApprovalCards.length > 0,
    steps,
    clientActions: finalClientActions,
    approvalCards: finalApprovalCards,
    sources: allSources.slice(0, 10),
    usedWebSearch,
    telemetryDossier: dossierParts.join('\n\n')
  };
}

function describeToolCall(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'scan_screener':
      return `Screening ${String(args.scope ?? 'all')} markets (OANDA quant & crowd book)`;
    case 'scan_dislocations':
      return args.symbol
        ? `Analyzing intermarket fair value & SMT on ${shortTicker(String(args.symbol))}`
        : `Scanning Intermarket Dislocation Radar (${String(args.timeframe ?? '1h')})`;
    case 'get_symbol_dossier':
      return `Loading MTF OANDA technicals & macro brief for ${shortTicker(String(args.symbol ?? 'XAUUSD'))}`;
    case 'get_calendar_and_news':
      return `Checking Macro Regime, calendar releases & news${args.symbol ? ` (${shortTicker(String(args.symbol))})` : ''}`;
    case 'audit_risk_and_sizing':
      return `Auditing lot size, USD correlation & event risk (${shortTicker(String(args.symbol ?? 'XAUUSD'))})`;
    default:
      return `Running ${tool}`;
  }
}

async function executeServerTool(
  tool: string,
  args: Record<string, unknown>,
  context: AiChartContext | undefined,
  workspace: AiWorkspaceSnapshot | undefined,
  tz: string,
  webSearchMode: 'auto' | 'on' | 'off',
  pushSource: (src: AiSourceLink) => void
): Promise<{ result: unknown; detail: string; usedWebSearch: boolean }> {
  if (tool === 'scan_screener') {
    const scope = String(args.scope ?? 'all').toLowerCase();
    let symbols: string[] = ALL_UNIVERSE_SYMBOLS;
    if (scope === 'watchlist' && workspace?.watchlists && workspace.watchlists.length > 0) {
      const wlSyms = workspace.watchlists.flatMap((w) => w.symbols).map((s) => canonicalizeSymbol(s).symbol);
      if (wlSyms.length > 0) symbols = Array.from(new Set(wlSyms));
    } else if (DEFAULT_AGENT_UNIVERSE[scope]) {
      symbols = DEFAULT_AGENT_UNIVERSE[scope];
    }

    const payload = await getScreenerPayload(symbols, false);
    let rows = [...payload.rows];

    const minRsi = args.minRsi != null ? Number(args.minRsi) : null;
    const maxRsi = args.maxRsi != null ? Number(args.maxRsi) : null;
    const minAdx = args.minAdx != null ? Number(args.minAdx) : null;
    const ratingFilter = typeof args.rating === 'string' ? args.rating.toLowerCase() : null;
    const crowdFilter = typeof args.crowdSkew === 'string' ? args.crowdSkew.toLowerCase() : null;
    const minTrapped = args.minTrappedPct != null ? Number(args.minTrappedPct) : null;

    if (minRsi !== null && Number.isFinite(minRsi)) {
      rows = rows.filter((r) => r.rsi14 !== null && r.rsi14 >= minRsi);
    }
    if (maxRsi !== null && Number.isFinite(maxRsi)) {
      rows = rows.filter((r) => r.rsi14 !== null && r.rsi14 <= maxRsi);
    }
    if (minAdx !== null && Number.isFinite(minAdx)) {
      rows = rows.filter((r) => r.adx14 !== null && r.adx14 >= minAdx);
    }
    if (ratingFilter) {
      rows = rows.filter((r) => r.rating.toLowerCase() === ratingFilter);
    }
    if (crowdFilter) {
      rows = rows.filter((r) => (r.crowdSkew ?? '').toLowerCase() === crowdFilter);
    }
    if (minTrapped !== null && Number.isFinite(minTrapped)) {
      rows = rows.filter(
        (r) =>
          Math.max(r.trappedLongPct ?? 0, r.trappedShortPct ?? 0) >= minTrapped
      );
    }

    const sortBy = String(args.sortBy ?? 'recommendAll');
    rows.sort((a, b) => {
      if (sortBy === 'changePercent') return Math.abs(b.changePercent) - Math.abs(a.changePercent);
      if (sortBy === 'rsi14') return (b.rsi14 ?? 50) - (a.rsi14 ?? 50);
      if (sortBy === 'adx14') return (b.adx14 ?? 0) - (a.adx14 ?? 0);
      if (sortBy === 'trappedPct') {
        return (
          Math.max(b.trappedLongPct ?? 0, b.trappedShortPct ?? 0) -
          Math.max(a.trappedLongPct ?? 0, a.trappedShortPct ?? 0)
        );
      }
      return Math.abs(b.recommendAll ?? 0) - Math.abs(a.recommendAll ?? 0);
    });

    const limit = Math.max(3, Math.min(12, Number(args.limit) || 10));
    const compact = rows.slice(0, limit).map((r) => ({
      symbol: r.symbol,
      shortName: r.shortName,
      price: r.price,
      chg1D: r.changePercent,
      chg1h: r.change1h,
      chg4h: r.change4h,
      rating: r.rating,
      score: r.recommendAll,
      rsi14: r.rsi14,
      adx14: r.adx14,
      atr14: r.atr14,
      rangePosPct: r.rangePosPct,
      spreadAtrPct: r.spreadAtrPct ?? null,
      crowdSkew: r.crowdSkew ?? null,
      crowdLongPct: r.crowdLongPct ?? null,
      trappedLongPct: r.trappedLongPct ?? null,
      trappedShortPct: r.trappedShortPct ?? null
    }));

    return {
      result: { totalScanned: payload.rows.length, matchedCount: rows.length, rows: compact },
      detail: `${payload.rows.length} scanned · ${rows.length} matched`,
      usedWebSearch: false
    };
  }

  if (tool === 'scan_dislocations') {
    const tf = parseTimeframe(typeof args.timeframe === 'string' ? args.timeframe : '1h');
    if (typeof args.symbol === 'string' && args.symbol.trim()) {
      const norm = canonicalizeSymbol(args.symbol);
      const d = await getDislocationPayload(norm.symbol, tf, false);
      return {
        result: {
          symbol: d.symbol,
          timeframe: d.timeframe,
          spotPrice: d.spotPrice,
          fairValuePrice: d.fairValuePrice,
          gapPct: d.gapPct,
          zScore: d.zScore,
          rSquared: d.rSquared,
          verdict: d.verdictLabel,
          convictionScore: d.convictionScore,
          htfContext: d.htfContext,
          eventRisk: d.eventRisk,
          driverLink: d.driverLink,
          setupLevels: d.setupLevels,
          smtSignals: d.smtSignals.slice(0, 3),
          leadLag: d.leadLag,
          topDrivers: d.drivers.slice(0, 4).map((dr) => ({
            shortName: dr.shortName,
            corr: dr.correlation,
            pull: dr.pull,
            weightPct: dr.weightPct
          }))
        },
        detail: `${norm.shortName} ${tf} · Z=${d.zScore.toFixed(2)} · Conviction ${d.convictionScore}/100`,
        usedWebSearch: false
      };
    }

    const scan = await getDislocationScanPayload(tf, false);
    const minConv = Number.isFinite(Number(args.minConviction)) ? Number(args.minConviction) : 0;
    const filtered = scan.rows
      .filter((r) => r.convictionScore >= minConv)
      .slice(0, 10)
      .map((r) => ({
        symbol: r.symbol,
        shortName: r.shortName,
        spotPrice: r.spotPrice,
        fairValuePrice: r.fairValuePrice,
        zScore: r.zScore,
        rSquared: r.rSquared,
        convictionScore: r.convictionScore,
        verdict: r.verdictLabel,
        verdictKind: r.verdict,
        htfBias: r.htfBias,
        htfAlignment: r.htfAlignment,
        turnConfirmed: r.turnConfirmed,
        topSmtLabel: r.topSmtLabel,
        topSmtDirection: r.topSmtDirection,
        topDriverLabel: r.topDriverLabel,
        eventRiskStatus: r.eventRiskStatus,
        driverLinkStatus: r.driverLinkStatus
      }));

    return {
      result: { timeframe: tf, totalScanned: scan.rows.length, setups: filtered },
      detail: `${scan.rows.length} pairs · ${filtered.length} ranked`,
      usedWebSearch: false
    };
  }

  if (tool === 'get_symbol_dossier') {
    const norm = canonicalizeSymbol(String(args.symbol ?? context?.fullSymbol ?? 'OANDA:XAUUSD'));
    const rawIntervals = Array.isArray(args.intervals) && args.intervals.length > 0
      ? args.intervals.slice(0, 3).map((x) => String(x))
      : ['1h', '4h', '1D'];
    const wantSeasonals = Boolean(args.includeSeasonals);

    const [techList, brief, posBook, seasonals] = await Promise.all([
      Promise.all(rawIntervals.map((iv) => getSymbolTechnicalsPayload(norm.symbol, iv).catch(() => null))),
      getSymbolBriefPayload(norm.symbol, 'none', false).catch(() => null),
      isOandaConfigured() && hasOandaPositionBook(norm.shortName)
        ? fetchOandaPositionBook(norm.shortName, false).catch(() => null)
        : Promise.resolve(null),
      wantSeasonals ? getSymbolSeasonalsPayload(norm.symbol).catch(() => null) : Promise.resolve(null)
    ]);

    if (brief?.sources) {
      for (const s of brief.sources) pushSource({ title: s.title, url: s.url, publishedDate: s.publishedDate });
    }

    const timeframes = techList
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => ({
        interval: t.interval,
        price: t.price,
        changePct: t.changePercent,
        atr: t.atr,
        summary: t.summary,
        spreadAtrPct: t.spreadAtrPct ?? null,
        keyOscillators: t.oscillators.slice(0, 5),
        keyMAs: t.movingAverages.filter((m) =>
          /Exponential Moving Average \((20|50|100|200)\)|Ichimoku/.test(m.name)
        ),
        classicPivot: t.pivots.find((p) => p.method === 'Classic') ?? null
      }));

    return {
      result: {
        symbol: norm.symbol,
        shortName: norm.shortName,
        timeframes,
        macroBrief: brief
          ? {
              bias: brief.fundamentalBias,
              headline: brief.headlineSummary,
              primaryDriver: brief.primaryDriver,
              keyRisk: brief.keyRisk,
              drivers: brief.drivers.slice(0, 4)
            }
          : null,
        oandaPositionBook: posBook,
        seasonals: seasonals
          ? (() => {
              const monthIdx = new Date().getUTCMonth();
              const histVals = seasonals.years
                .filter((y) => y.year < seasonals.currentYear)
                .map((y) => y.months[monthIdx])
                .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
              const avgPct =
                histVals.length > 0
                  ? Number((histVals.reduce((a, b) => a + b, 0) / histVals.length).toFixed(2))
                  : null;
              const winRatePct =
                histVals.length > 0
                  ? Math.round((histVals.filter((v) => v > 0).length / histVals.length) * 100)
                  : null;
              return {
                samplesYears: histVals.length,
                currentMonthAvgPct: avgPct,
                currentMonthWinRatePct: winRatePct,
                adr20: seasonals.volatility?.adr20 ?? null,
                todayRangePctOfAdr: seasonals.volatility?.todayRangePctOfAdr ?? null,
                week52PositionPct: seasonals.volatility?.week52PositionPct ?? null
              };
            })()
          : null
      },
      detail: `${norm.shortName} · ${timeframes.length} TFs + macro${posBook ? ' + OANDA book' : ''}`,
      usedWebSearch: Boolean(brief?.sources?.length)
    };
  }

  if (tool === 'get_calendar_and_news') {
    const sym = typeof args.symbol === 'string' && args.symbol.trim()
      ? canonicalizeSymbol(args.symbol).symbol
      : context?.fullSymbol || 'OANDA:XAUUSD';
    const short = shortTicker(sym);
    const nowSec = Math.floor(Date.now() / 1000);
    const hoursBack = Math.max(0, Math.min(72, Number(args.hoursBack) || 12));
    const hoursAhead = Math.max(1, Math.min(120, Number(args.hoursAhead) || 48));
    const countries = Array.from(new Set<CountryCode>([...inferRelevantCountries(short), 'US']));

    const runSearch =
      webSearchMode !== 'off' && isTavilyConfigured() && Boolean(args.query || webSearchMode === 'on');

    const [regime, cal, news, tavily] = await Promise.all([
      getMacroRegimePayload(false).catch(() => null),
      getCalendarEventsInWindow(nowSec - hoursBack * 3600, nowSec + hoursAhead * 3600, tz, {
        padBeforeSec: 0,
        padAfterSec: 0,
        countries
      }).catch(() => ({ events: [], timezone: tz, sources: [] })),
      getNewsFlowPayload({ mode: 'symbol', symbol: sym }).catch(() => null),
      runSearch
        ? runTavilyFinanceSearch(
            String(args.query || `${short} macro catalysts market news`),
            { topic: 'news', maxResults: 5, days: 4 }
          ).catch(() => null)
        : Promise.resolve(null)
    ]);

    const newsItems = (news?.items ?? []).slice(0, 5).map((n) => {
      pushSource({ title: n.title, url: n.url, publishedDate: n.publishedAt });
      return { title: n.title, provider: n.providerName, publishedAt: n.publishedAt, snippet: n.snippet.slice(0, 220) };
    });

    if (tavily?.sources) {
      for (const s of tavily.sources) pushSource(s);
    }

    const highMedEvents = cal.events
      .filter((e) => e.impact === 'high' || e.impact === 'medium')
      .slice(0, 15)
      .map((e) => ({
        date: e.date,
        time: e.time,
        country: e.country,
        impact: e.impact,
        title: e.title,
        actual: e.actual,
        forecast: e.forecast,
        prior: e.prior
      }));

    return {
      result: {
        macroRegime: regime,
        timezone: tz,
        calendarEvents: highMedEvents,
        newsHeadlines: newsItems,
        webSearchSnippets: tavily?.snippets ?? null
      },
      detail: `${highMedEvents.length} events · ${newsItems.length} news${tavily ? ' + web' : ''}`,
      usedWebSearch: Boolean(tavily)
    };
  }

  if (tool === 'audit_risk_and_sizing') {
    const audit = await runDeterministicRiskAudit(args, workspace, tz);
    return {
      result: audit,
      detail: `${audit.shortName} ${audit.side.toUpperCase()} · ${audit.suggestedQuantity}u · R:R ${audit.rrRatio ?? '—'}`,
      usedWebSearch: false
    };
  }

  return {
    result: { error: `Unknown tool: ${tool}` },
    detail: 'Unknown tool',
    usedWebSearch: false
  };
}
