import type { ServerResponse } from 'node:http';
import { isTavilyConfigured, runTavilyFinanceSearch } from '../ai/tavily.js';
import type { AiChartContext, AiEffort, AiModelId, AiSourceLink } from '../ai/types.js';
import { runStrategyBacktest, validateAndSanitizeStrategySpec } from './engine.js';
import { fetchStrategyHistory } from './historyCache.js';
import { normalizeShortTicker } from './instruments.js';
import {
  normalizeStrategyTimeframe,
  type BacktestReport,
  type HistoryFetchResult,
  type StrategyIterationStep,
  type StrategySpec,
  type StrategyTimeframe
} from './types.js';

function getDeepSeekChatUrl(): string {
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    .trim()
    .replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Detects whether the user is asking the AI to create, design, backtest, test,
 * or refine a systematic trading strategy (switching from Q&A to Agentic Strategy Mode).
 */
export function isStrategyPrompt(
  latestUserText: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const txt = latestUserText.trim();
  if (!txt || txt.length < 6) return false;

  // Explicit strategy / backtesting intent
  const strongMatch =
    /\b(backtest|back-?test|strategy\s*tester|build\s+(me\s+)?(a\s+)?(\w+\s+){0,3}strateg(y|ies)|create\s+(me\s+)?(a\s+)?(\w+\s+){0,3}strateg(y|ies)|design\s+(me\s+)?(a\s+)?(\w+\s+){0,3}strateg(y|ies)|make\s+(me\s+)?(a\s+)?(\w+\s+){0,3}strateg(y|ies)|develop\s+(a\s+)?(\w+\s+){0,3}strateg(y|ies)|test\s+(a\s+|this\s+|an\s+)?(\w+\s+){0,3}(strateg(y|ies)|system|setup\s+historically|edge\s+historically)|trading\s+system\s+(for|on)|systematic\s+(strateg|edge|model)|quant\s+strateg(y|ies)|algo(rithmic)?\s+strateg(y|ies))\b/i.test(
      txt
    );
  if (strongMatch) return true;

  // Follow-up strategy refinement inside an ongoing strategy thread
  const prevAssistant = [...history]
    .slice(0, -1)
    .reverse()
    .find((m) => m.role === 'assistant')?.content;
  if (
    prevAssistant &&
    /(Out-of-Sample|In-Sample|Profit Factor|Strategy Tester|StrategySpec|Verdict:)/i.test(
      prevAssistant
    )
  ) {
    const tweakMatch =
      /\b(re-?test|rerun|re-?run|refine|tweak|improve\s+(it|the\s+strateg)|tighten|widen|change\s+(the\s+)?(timeframe|tf|stop|sl|tp|filter|ema|rsi|adx|session)|try\s+(it\s+)?on\s+(1m|5m|15m|30m|1h|4h|1d|daily)|add\s+(an?\s+)?(adx|rsi|ema|session|trend|htf|trailing|filter)|long\s+only|short\s+only)\b/i.test(
        txt
      );
    if (tweakMatch) return true;
  }

  return false;
}

const KNOWN_SYMBOL_REGEX =
  /\b(XAUUSD|XAGUSD|EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|NZDUSD|USDCHF|GBPJPY|EURJPY|EURGBP|AUDJPY|CADJPY|EURAUD|GBPAUD|NAS100|SPX500|US500|US30|GER40|UK100|JP225|USOIL|UKOIL|NATGAS|COPPER|BTCUSD|ETHUSD|SOLUSD|DXY|GOLD|SILVER|AAPL|NVDA|TSLA|MSFT|META|AMZN)\b/i;

function extractTargetSymbol(
  prompt: string,
  ctx?: AiChartContext
): { symbol: string; shortName: string } {
  const m = prompt.match(KNOWN_SYMBOL_REGEX);
  if (m) {
    const raw = m[1].toUpperCase();
    const mapped = raw === 'GOLD' ? 'XAUUSD' : raw === 'SILVER' ? 'XAGUSD' : raw;
    return { symbol: `OANDA:${mapped}`, shortName: mapped };
  }
  const full = ctx?.fullSymbol?.trim() || ctx?.symbol?.trim() || 'OANDA:XAUUSD';
  const short = normalizeShortTicker(ctx?.symbol || full);
  return { symbol: full.includes(':') ? full : `OANDA:${short}`, shortName: short };
}

function extractTargetTimeframe(prompt: string, ctx?: AiChartContext): StrategyTimeframe {
  const p = prompt.toLowerCase();
  if (/\b(1\s?min|1m|m1)\b/.test(p)) return '1m';
  if (/\b(5\s?min|5m|m5)\b/.test(p)) return '5m';
  if (/\b(15\s?min|15m|m15)\b/.test(p)) return '15m';
  if (/\b(30\s?min|30m|m30)\b/.test(p)) return '30m';
  if (/\b(1\s?hour|1\s?hr|1h|h1|60m)\b/.test(p)) return '1h';
  if (/\b(4\s?hour|4\s?hr|4h|h4|240m)\b/.test(p)) return '4h';
  if (/\b(daily|1d|d1|day\s+chart)\b/.test(p)) return '1D';
  if (/\b(weekly|1w|w1)\b/.test(p)) return '1W';
  return normalizeStrategyTimeframe(ctx?.interval || '1h');
}

function shouldRunStrategyResearch(prompt: string, webMode: 'auto' | 'on' | 'off'): boolean {
  if (!isTavilyConfigured() || webMode === 'off') return false;
  if (webMode === 'on') return true;
  return /\b(research|literature|paper|connors|turtle|orb|opening\s+range|silver\s+bullet|ict|london\s+breakout|mean\s+reversion|donchian|keltner|squeeze|supertrend|institutional|published|classic)\b/i.test(
    prompt
  );
}

const STRATEGY_SCHEMA_GUIDE = `
AVAILABLE SAFE STRATEGY JSON SCHEMA (StrategySpec — strictly NO code/eval):
{
  "name": "Short clean strategy name (e.g. XAU London Pullback v1)",
  "description": "1-2 sentence hypothesis explaining WHY this edge should exist",
  "direction": "long" | "short" | "both",
  "interval": "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W",
  "indicators": [
    // Allowed fn: "ema", "sma", "wma", "hma", "vwma", "rsi", "atr", "adx", "macd",
    // "stoch", "bbands", "keltner", "donchian", "cci", "willr", "session_vwap",
    // "swing_high", "swing_low", "prev_day_high", "prev_day_low", "prev_day_close"
    // Optional fields: period (2..400), fast, slow, signal, kPeriod, dPeriod, mult, stdDev, source ("close"|"hl2"|"hlc3"),
    // tf ("15m"|"1h"|"4h"|"1D" — strictly higher than execution interval; evaluated causally on closed HTF candles only!)
    // Multi-output references:
    //   adx -> "<id>.adx", "<id>.plusDi", "<id>.minusDi"
    //   macd -> "<id>.macd", "<id>.signal", "<id>.hist"
    //   stoch -> "<id>.k", "<id>.d"
    //   bbands -> "<id>.upper", "<id>.mid", "<id>.lower", "<id>.widthPct"
    //   keltner / donchian -> "<id>.upper", "<id>.mid", "<id>.lower"
    //   (Note: donchian / swing_high / swing_low are already shifted 1 bar so close > donchian.upper is a causal breakout!)
  ],
  "entryLong": ConditionNode | null,   // MAX 4 leaf conditions!
  "entryShort": ConditionNode | null,  // MAX 4 leaf conditions!
  "exitLong": ConditionNode | null,    // optional signal exit
  "exitShort": ConditionNode | null,   // optional signal exit
  "risk": {
    "initialCapital": 10000,
    "sizingMode": "risk_pct",
    "riskPct": 1.0,
    "stopLoss": { "type": "atr_mult" | "pct" | "pips" | "swing", "atrId": "atr14", "mult": 1.5, "lookback": 10 },
    "takeProfit": { "type": "rr_multiple" | "atr_mult" | "pct" | "pips" | "none", "rr": 2.0, "atrId": "atr14", "mult": 3.0 },
    "trailingStop": { "type": "none" | "atr_mult" | "breakeven_at_r", "atrId": "atr14", "mult": 2.0, "triggerR": 1.0 },
    "maxBarsInTrade": 48,
    "cooldownBars": 1,
    "slippageTicks": 0.5,
    "commissionPerLotUsd": 0
  },
  "ruleSummary": ["Bullet 1 plain-English entry rule", "Bullet 2 risk & exit rule", "..."]
}

CONDITION NODES (exact syntax):
- { "op": "and", "args": [ ... ] }
- { "op": "or", "args": [ ... ] }
- { "op": "not", "arg": ConditionNode }
- { "op": "gt" | "gte" | "lt" | "lte" | "crosses_above" | "crosses_below", "left": ValueRef, "right": ValueRef }
- { "op": "between", "value": ValueRef, "min": number, "max": number }
- { "op": "rising" | "falling", "value": ValueRef, "bars": 1 }
- { "op": "session_utc", "startHour": 7, "endHour": 16 }
- { "op": "day_of_week", "days": [1, 2, 3, 4, 5] }
- { "op": "spread_below_atr", "atrId": "atr14", "maxRatio": 0.25 }

ValueRef can be a number, candle field ("open"|"high"|"low"|"close"|"volume"|"spread"|"hl2"|"hlc3"), indicator id ("ema20"), sub-field ("adx14.adx"), or lagged reference ("close[1]", "rsi14[1]").
`;

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim();
  // Try fenced ```json ... ``` first
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : cleaned;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function callDeepSeekJson(
  apiKey: string,
  model: AiModelId,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<Record<string, unknown> | null> {
  // Always use fast non-streaming call for structured JSON draft/refinement turns
  const res = await fetch(getDeepSeekChatUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
      thinking: { type: 'disabled' },
      temperature: 0.25,
      max_tokens: 2400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }),
    signal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Strategy planner LLM error (HTTP ${res.status}): ${errText.slice(0, 180)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  return extractJsonObject(content);
}

function summarizeInSampleDiagnostics(report: BacktestReport): string {
  const s = report.all; // when run with inSampleOnly: true, `all` IS the In-Sample segment
  const bestHours = [...s.byHourUtc]
    .filter((h) => h.trades >= 2)
    .sort((a, b) => b.pnlUsd - a.pnlUsd)
    .slice(0, 3)
    .map((h) => `${h.label} (${h.trades}t, $${h.pnlUsd})`);
  const worstHours = [...s.byHourUtc]
    .filter((h) => h.trades >= 2)
    .sort((a, b) => a.pnlUsd - b.pnlUsd)
    .slice(0, 3)
    .map((h) => `${h.label} (${h.trades}t, $${h.pnlUsd})`);

  const reasonCounts: Record<string, number> = {};
  for (const t of report.trades) {
    reasonCounts[t.exitReason] = (reasonCounts[t.exitReason] ?? 0) + 1;
  }

  return JSON.stringify(
    {
      inSampleWindow: `${new Date(report.fromTs * 1000).toISOString().slice(0, 10)} to ${new Date(report.toTs * 1000).toISOString().slice(0, 10)}`,
      trades: s.totalTrades,
      wins: s.winningTrades,
      losses: s.losingTrades,
      winRatePct: s.winRatePct,
      netPnlUsd: s.totalPnlUsd,
      netPnlPct: s.totalPnlPct,
      profitFactor: s.profitFactor,
      expectancyUsd: s.expectancyUsd,
      expectancyR: s.expectancyR,
      maxDrawdownPct: s.maxDrawdownPct,
      spreadAndSlippageCostUsd: s.totalCostUsd,
      costPctOfGrossProfit: s.costPctOfGrossProfit,
      longStats: { trades: s.tradesLong, winRatePct: s.winRateLongPct, netPnlUsd: s.netPnlLongUsd },
      shortStats: { trades: s.tradesShort, winRatePct: s.winRateShortPct, netPnlUsd: s.netPnlShortUsd },
      avgBarsHeld: s.avgBarsHeld,
      avgMfePct: s.avgMfePct,
      avgMaePct: s.avgMaePct,
      exitReasons: reasonCounts,
      bestHoursUtc: bestHours,
      worstHoursUtc: worstHours
    },
    null,
    2
  );
}

function scoreIsCandidate(report: BacktestReport): number {
  const s = report.all;
  if (s.totalTrades === 0) return -1000;
  // Penalize tiny sample sizes heavily so AI cannot win by filtering down to 2 lucky trades
  const sampleFactor = Math.min(1, s.totalTrades / 25);
  const pf = Math.min(3.5, s.profitFactor ?? 0);
  const ddPenalty = Math.max(0, s.maxDrawdownPct - 8) * 0.08;
  return (pf - 1) * 100 * sampleFactor + Math.max(-40, Math.min(40, s.totalPnlPct)) * sampleFactor - ddPenalty * 10;
}

function buildFallbackSpec(
  symbol: string,
  shortName: string,
  interval: StrategyTimeframe
): StrategySpec {
  return validateAndSanitizeStrategySpec(
    {
      name: `${shortName} Trend Pullback v1`,
      description: 'EMA trend filter with RSI pullback and ATR risk brackets.',
      version: 1,
      symbol,
      shortName,
      interval,
      direction: 'both',
      indicators: [
        { id: 'ema20', fn: 'ema', period: 20 },
        { id: 'ema50', fn: 'ema', period: 50 },
        { id: 'rsi14', fn: 'rsi', period: 14 },
        { id: 'atr14', fn: 'atr', period: 14 }
      ],
      entryLong: {
        op: 'and',
        args: [
          { op: 'gt', left: 'ema20', right: 'ema50' },
          { op: 'crosses_above', left: 'close', right: 'ema20' },
          { op: 'between', value: 'rsi14', min: 45, max: 70 }
        ]
      },
      entryShort: {
        op: 'and',
        args: [
          { op: 'lt', left: 'ema20', right: 'ema50' },
          { op: 'crosses_below', left: 'close', right: 'ema20' },
          { op: 'between', value: 'rsi14', min: 30, max: 55 }
        ]
      },
      risk: {
        initialCapital: 10000,
        sizingMode: 'risk_pct',
        riskPct: 1.0,
        stopLoss: { type: 'atr_mult', atrId: 'atr14', mult: 1.5 },
        takeProfit: { type: 'rr_multiple', rr: 2.0 },
        trailingStop: { type: 'none' },
        maxBarsInTrade: 48,
        cooldownBars: 1,
        slippageTicks: 0.5,
        commissionPerLotUsd: 0,
        oosFraction: 0.3
      },
      ruleSummary: [
        'Trend bias: EMA(20) above EMA(50) for longs; below for shorts',
        'Trigger: Close crosses EMA(20) with RSI(14) confirming momentum',
        'Risk: 1.0% equity risk, 1.5x ATR(14) stop loss, 2.0R take profit'
      ]
    },
    { symbol, shortName, interval }
  );
}

export interface AgenticStrategyParams {
  apiKey: string;
  model: AiModelId;
  effort: AiEffort;
  history: { role: 'user' | 'assistant'; content: string }[];
  latestUserText: string;
  context?: AiChartContext;
  webSearchMode: 'auto' | 'on' | 'off';
  res: ServerResponse;
  abortSignal: AbortSignal;
}

export async function runAgenticStrategyMode(params: AgenticStrategyParams): Promise<void> {
  const { apiKey, model, history, latestUserText, context, webSearchMode, res, abortSignal } =
    params;

  const { symbol, shortName } = extractTargetSymbol(latestUserText, context);
  const interval = extractTargetTimeframe(latestUserText, context);

  // 1. Optional Tavily Research
  let sources: AiSourceLink[] = [];
  let researchSnippets = '';
  if (shouldRunStrategyResearch(latestUserText, webSearchMode)) {
    writeSse(res, 'status', {
      phase: 'strategy_research',
      label: `Researching quantitative rules for ${shortName}...`
    });
    const q = `${shortName} systematic trading strategy rules backtest ${latestUserText.slice(0, 100)}`;
    const tavily = await runTavilyFinanceSearch(q, { topic: 'general', maxResults: 4 });
    if (tavily) {
      sources = tavily.sources;
      researchSnippets = tavily.snippets;
      if (sources.length > 0) writeSse(res, 'sources', { sources });
    }
  }

  // 2. Fetch historical OANDA Bid/Mid/Ask bars
  writeSse(res, 'status', {
    phase: 'strategy_data',
    label: `Loading historical Bid/Ask data for ${shortName} (${interval})...`
  });
  const fullHistory = await fetchStrategyHistory(symbol, interval);
  if (!fullHistory || fullHistory.bars.length < 120) {
    writeSse(res, 'token', {
      delta: `**Unable to run backtest for ${shortName} (${interval}).**\n\nInsufficient historical candle data was returned for this instrument/timeframe. Try a supported OANDA instrument (e.g., \`XAUUSD\`, \`EURUSD\`, \`NAS100\`, \`USOIL\`, \`BTCUSD\`) or a standard timeframe (\`15m\`, \`1h\`, \`4h\`, \`1D\`).`
    });
    writeSse(res, 'done', { model, usedWebSearch: sources.length > 0, usedVision: false });
    res.end();
    return;
  }

  // Lock the 70% In-Sample / 30% Out-of-Sample vault structurally BEFORE AI sees anything!
  const oosFraction = 0.3;
  const approxWarmup = Math.min(200, Math.floor(fullHistory.bars.length * 0.2));
  const splitIdx = Math.min(
    fullHistory.bars.length - 30,
    approxWarmup + Math.floor((fullHistory.bars.length - approxWarmup) * (1 - oosFraction))
  );
  const isOnlyHistory: HistoryFetchResult = {
    ...fullHistory,
    bars: fullHistory.bars.slice(0, splitIdx)
  };
  const isStartDate = new Date(isOnlyHistory.bars[0].ts * 1000).toISOString().slice(0, 10);
  const isEndDate = new Date(isOnlyHistory.bars[isOnlyHistory.bars.length - 1].ts * 1000)
    .toISOString()
    .slice(0, 10);
  const avgSpread =
    isOnlyHistory.bars.reduce((acc, b) => acc + b.spread, 0) / isOnlyHistory.bars.length;
  const latestClose = isOnlyHistory.bars[isOnlyHistory.bars.length - 1].close;

  // 3. Draft StrategySpec v1
  writeSse(res, 'status', {
    phase: 'strategy_design',
    label: `Designing Strategy v1 for ${shortName} (${interval})...`
  });

  const conversationSnippet = history
    .slice(-6)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`)
    .join('\n\n');

  const architectSystemPrompt = `You are a disciplined institutional quantitative strategy architect.
Output ONLY a single valid JSON object matching the StrategySpec schema below — NO markdown prose outside JSON.

ANTI-OVERFITTING & REALISM DISCIPLINE:
- Design clean, hypothesis-driven rules with MAX 3–4 entry conditions per side. Never stack 6+ arbitrary filters.
- Always include an ATR indicator (e.g. {"id":"atr14","fn":"atr","period":14}) for realistic volatility-scaled stops.
- Aim for enough signal frequency to produce >= 30 trades on In-Sample data (avoid overly rare multi-crossover coincidences that fire only 2–4 times).
- All signals execute strictly on NEXT bar open with real OANDA Bid/Ask spread + 0.5 tick slippage, and worst-case SL-before-TP intrabar resolution.
- Default initialCapital = 10000 USD, sizingMode = "risk_pct", riskPct = 1.0 unless the user explicitly specifies another capital/risk.
- Provide clear plain-English "ruleSummary" bullets.
${STRATEGY_SCHEMA_GUIDE}`;

  const draftUserPrompt = `USER REQUEST: ${latestUserText}

INSTRUMENT CONTEXT:
- Symbol: ${fullHistory.symbol} (${shortName})
- Timeframe: ${interval}
- Data Source: ${fullHistory.dataSource} (${fullHistory.bars.length} total bars; In-Sample build slice is ${isOnlyHistory.bars.length} bars from ${isStartDate} to ${isEndDate})
- Reference Price: ${latestClose} | Average Historical Spread: ${avgSpread.toFixed(5)}
${researchSnippets ? `\nWEB RESEARCH CONTEXT:\n${researchSnippets}\n` : ''}
${history.length > 1 ? `\nRECENT CONVERSATION:\n${conversationSnippet}\n` : ''}
Return ONLY the JSON object for StrategySpec v1.`;

  let rawV1: Record<string, unknown> | null = null;
  try {
    rawV1 = await callDeepSeekJson(apiKey, model, architectSystemPrompt, draftUserPrompt, abortSignal);
  } catch (err) {
    console.warn('[strategy-agent] v1 draft failed, using fallback:', (err as Error).message);
  }

  let currentSpec = rawV1
    ? validateAndSanitizeStrategySpec(
        { ...(rawV1 as Partial<StrategySpec>), version: 1, symbol: fullHistory.symbol, shortName, interval },
        { symbol: fullHistory.symbol, shortName, interval }
      )
    : buildFallbackSpec(fullHistory.symbol, shortName, interval);

  // 4. Run Deterministic In-Sample Backtest (v1)
  writeSse(res, 'status', {
    phase: 'strategy_backtest',
    label: `Backtesting v1 on In-Sample (${isOnlyHistory.bars.length.toLocaleString('en-US')} bars, 70% split)...`
  });

  let currentIsReport = runStrategyBacktest(currentSpec, isOnlyHistory, { inSampleOnly: true });
  let bestSpec = currentSpec;
  let bestIsReport = currentIsReport;
  let bestScore = scoreIsCandidate(currentIsReport);

  const iterations: StrategyIterationStep[] = [
    {
      version: 1,
      name: currentSpec.name,
      rationale: currentSpec.description || 'Initial hypothesis drafted from user request.',
      isTrades: currentIsReport.all.totalTrades,
      isWinRatePct: currentIsReport.all.winRatePct,
      isNetPnlUsd: currentIsReport.all.totalPnlUsd,
      isNetPnlPct: currentIsReport.all.totalPnlPct,
      isProfitFactor: currentIsReport.all.profitFactor,
      isMaxDdPct: currentIsReport.all.maxDrawdownPct,
      isCostPctGross: currentIsReport.all.costPctOfGrossProfit,
      kept: true
    }
  ];

  // 5. Bounded In-Sample Audit & Refinement Loop (MAX 2 refinements: v2, v3 — OOS NEVER TOUCHED!)
  const MAX_REFINEMENTS = 2;
  for (let step = 2; step <= 1 + MAX_REFINEMENTS; step++) {
    if (abortSignal.aborted) break;

    const s = currentIsReport.all;
    // If IS is already strong with healthy sample and low cost drag, freeze cleanly without overfitting!
    if (
      s.totalTrades >= 35 &&
      (s.profitFactor ?? 0) >= 1.45 &&
      s.maxDrawdownPct <= 10 &&
      (s.costPctOfGrossProfit ?? 0) < 25
    ) {
      break;
    }

    writeSse(res, 'status', {
      phase: 'strategy_refine',
      label: `Auditing v${step - 1} In-Sample diagnostics (${s.totalTrades} trades, PF ${(s.profitFactor ?? 0).toFixed(2)})...`
    });

    const critiqueSystemPrompt = `You are a skeptical institutional quant researcher auditing an IN-SAMPLE ONLY backtest.
You have NOT seen Out-of-Sample data (it is locked in a vault).
Your job: inspect the In-Sample diagnostics and decide whether ONE justified structural change is warranted, OR whether to FREEZE the strategy as-is.

RULES:
- NEVER curve-fit by tweaking arbitrary decimals (like changing RSI 45 to 47.3) or stacking >4 conditions.
- Valid structural reasons to REFINE:
  1. Too few trades (< 20 on IS): simplify overly restrictive condition or loosen an extreme threshold.
  2. Spread drag > 35% of gross profit: widen SL/TP or add a trend/volatility filter so fewer low-expectancy scalp trades fire.
  3. Clear regime mismatch (e.g., trend system bleeding in range chop -> add ADX > 18 or HTF EMA filter; or one session/direction failing catastrophically -> restrict or improve exit).
  4. Stops hit prematurely while MFE is large -> adjust SL ATR multiple or add breakeven/trailing rule.
- If the core concept clearly has no structural fix without overfitting, choose "FREEZE".

Output ONLY JSON:
{
  "decision": "FREEZE" | "REFINE",
  "rationale": "Concise 1-sentence reason for freezing or what single structural flaw v${step} addresses",
  "spec": { ...full updated StrategySpec JSON if decision is REFINE, otherwise omit... }
}
${STRATEGY_SCHEMA_GUIDE}`;

    const critiqueUserPrompt = `ORIGINAL USER REQUEST: ${latestUserText}

CURRENT SPEC (v${step - 1}):
${JSON.stringify(currentSpec, null, 2)}

IN-SAMPLE ONLY DIAGNOSTICS (70% split — OOS unseen):
${summarizeInSampleDiagnostics(currentIsReport)}

Decide FREEZE or REFINE (at most 1 structural change for v${step}). Return ONLY JSON.`;

    let decisionJson: Record<string, unknown> | null = null;
    try {
      decisionJson = await callDeepSeekJson(
        apiKey,
        model,
        critiqueSystemPrompt,
        critiqueUserPrompt,
        abortSignal
      );
    } catch {
      break;
    }

    if (!decisionJson || decisionJson.decision !== 'REFINE' || !decisionJson.spec) {
      break;
    }

    const rationale =
      typeof decisionJson.rationale === 'string' && decisionJson.rationale.trim()
        ? decisionJson.rationale.trim()
        : `Structural refinement v${step} based on In-Sample diagnostics.`;

    writeSse(res, 'status', {
      phase: 'strategy_backtest',
      label: `Backtesting v${step} on In-Sample...`
    });

    const candidateSpec = validateAndSanitizeStrategySpec(
      {
        ...(decisionJson.spec as Partial<StrategySpec>),
        id: currentSpec.id,
        version: step,
        symbol: fullHistory.symbol,
        shortName,
        interval
      },
      { symbol: fullHistory.symbol, shortName, interval }
    );
    const candidateIsReport = runStrategyBacktest(candidateSpec, isOnlyHistory, {
      inSampleOnly: true
    });
    const candidateScore = scoreIsCandidate(candidateIsReport);
    const improved = candidateScore > bestScore + 1.5;

    iterations.push({
      version: step,
      name: candidateSpec.name,
      rationale,
      isTrades: candidateIsReport.all.totalTrades,
      isWinRatePct: candidateIsReport.all.winRatePct,
      isNetPnlUsd: candidateIsReport.all.totalPnlUsd,
      isNetPnlPct: candidateIsReport.all.totalPnlPct,
      isProfitFactor: candidateIsReport.all.profitFactor,
      isMaxDdPct: candidateIsReport.all.maxDrawdownPct,
      isCostPctGross: candidateIsReport.all.costPctOfGrossProfit,
      kept: improved
    });

    if (improved) {
      // Mark earlier iterations as superseded
      for (let k = 0; k < iterations.length - 1; k++) iterations[k].kept = false;
      bestSpec = candidateSpec;
      bestIsReport = candidateIsReport;
      bestScore = candidateScore;
      currentSpec = candidateSpec;
      currentIsReport = candidateIsReport;
    } else {
      // Refinement didn't beat previous honest IS score — stop iterating
      break;
    }
  }

  // 6. SINGLE LOCKED OUT-OF-SAMPLE VALIDATION (Full stitched timeline with exact IS/OOS boundary)
  writeSse(res, 'status', {
    phase: 'strategy_oos',
    label: `Validating frozen v${bestSpec.version} once on unseen 30% Out-of-Sample data...`
  });

  const finalReport: BacktestReport = runStrategyBacktest(bestSpec, fullHistory, {
    iterations,
    inSampleOnly: false
  });

  // 7. Emit full BacktestReport immediately so Strategy Tester bottom tab opens cleanly!
  writeSse(res, 'strategy_result', { report: finalReport });

  // 8. Stream Honest Quantitative Report in the AI Copilot chat
  writeSse(res, 'status', { phase: 'writing', label: 'Writing honest backtest verdict...' });

  const reportSystemPrompt = `You are DeplyzeWorkflow AI Copilot — a rigorous, 100% honest institutional quantitative analyst presenting backtest results that have ALREADY been executed and opened in the user's Strategy Tester bottom panel.

MANDATORY HONESTY RULES:
1. NEVER sugarcoat losing, overfit, or low-sample results. Concluding "This strategy does NOT have a reliable edge" is a FIRST-CLASS, HIGH-VALUE answer when warranted.
2. ALWAYS show the exact trade count alongside every performance metric (both In-Sample and Out-of-Sample).
3. ALWAYS present a compact Markdown comparison table: \`| Segment | Trades | Win Rate | Net PnL | Profit Factor | Max DD | Spread+Slippage |\`.
4. STRICT RULE ACCURACY: Describe ONLY the exact rules listed in \`strategy.executedRules\` (auto-generated from the executed JSON AST). NEVER mention a filter (such as session hours or an indicator) that is NOT present in \`strategy.executedRules\`.
5. Highlight:
   - **Verdict** (matching the engine verdict honestly: Viable Candidate / Marginal / Low Sample / Overfit / No Viable Edge)
   - **Executed Rules** (strictly matching \`strategy.executedRules\`)
   - **In-Sample vs Out-of-Sample & 3-Fold Walk-Forward Breakdown** (explicitly call out whether OOS held up across regimes or degraded)
   - **Cost & Realism Audit** (exact real OANDA Bid/Ask spread + slippage drag and whether it crushed gross alpha)
   - **Iteration Trail** (if v1 -> v2/v3 happened, briefly note what changed on IS and whether it helped)
   - **Next Step** (if viable, suggest testing live in Paper Ledger via the "Forward in Paper" button; if rejected/overfit, clearly advise NOT trading it and explain why).
6. Keep it crisp, scannable, and institutional — no filler intros.`;

  const reportPayload = {
    verdict: finalReport.verdict,
    strategy: {
      name: finalReport.spec.name,
      symbol: finalReport.spec.symbol,
      interval: finalReport.spec.interval,
      direction: finalReport.spec.direction,
      initialCapital: finalReport.spec.risk.initialCapital,
      riskPct: finalReport.spec.risk.riskPct,
      stopLoss: finalReport.spec.risk.stopLoss,
      takeProfit: finalReport.spec.risk.takeProfit,
      executedRules: finalReport.executedRules
    },
    walkForward: finalReport.walkForward,
    data: {
      source: finalReport.dataSource,
      note: finalReport.dataQualityNote,
      barsTotal: finalReport.barsTotal,
      fromDate: new Date(finalReport.fromTs * 1000).toISOString().slice(0, 10),
      oosSplitDate: new Date(finalReport.oosSplitTs * 1000).toISOString().slice(0, 10),
      toDate: new Date(finalReport.toTs * 1000).toISOString().slice(0, 10)
    },
    inSample: {
      trades: finalReport.inSample.totalTrades,
      wins: finalReport.inSample.winningTrades,
      winRatePct: finalReport.inSample.winRatePct,
      netPnlUsd: finalReport.inSample.totalPnlUsd,
      netPnlPct: finalReport.inSample.totalPnlPct,
      profitFactor: finalReport.inSample.profitFactor,
      maxDdPct: finalReport.inSample.maxDrawdownPct,
      costUsd: finalReport.inSample.totalCostUsd,
      costPctOfGrossProfit: finalReport.inSample.costPctOfGrossProfit
    },
    outOfSample: {
      trades: finalReport.outOfSample.totalTrades,
      wins: finalReport.outOfSample.winningTrades,
      winRatePct: finalReport.outOfSample.winRatePct,
      netPnlUsd: finalReport.outOfSample.totalPnlUsd,
      netPnlPct: finalReport.outOfSample.totalPnlPct,
      profitFactor: finalReport.outOfSample.profitFactor,
      maxDdPct: finalReport.outOfSample.maxDrawdownPct,
      costUsd: finalReport.outOfSample.totalCostUsd,
      costPctOfGrossProfit: finalReport.outOfSample.costPctOfGrossProfit,
      buyAndHoldPct: finalReport.outOfSample.buyAndHoldPct
    },
    fullPeriod: {
      trades: finalReport.all.totalTrades,
      wins: finalReport.all.winningTrades,
      winRatePct: finalReport.all.winRatePct,
      netPnlUsd: finalReport.all.totalPnlUsd,
      netPnlPct: finalReport.all.totalPnlPct,
      profitFactor: finalReport.all.profitFactor,
      maxDdPct: finalReport.all.maxDrawdownPct,
      expectancyUsd: finalReport.all.expectancyUsd,
      expectancyR: finalReport.all.expectancyR,
      sharpeRatio: finalReport.all.sharpeRatio,
      costUsd: finalReport.all.totalCostUsd,
      buyAndHoldPct: finalReport.all.buyAndHoldPct
    },
    iterations: finalReport.iterations
  };

  const upstream = await fetch(getDeepSeekChatUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      stream: true,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: reportSystemPrompt },
        {
          role: 'user',
          content: `Original User Request: ${latestUserText}\n\nVerified Backtest Results JSON:\n${JSON.stringify(reportPayload, null, 2)}`
        }
      ]
    }),
    signal: abortSignal
  });

  if (!upstream.ok || !upstream.body) {
    // Fallback deterministic markdown report if streaming summary fails
    const f = finalReport;
    const fallbackMd =
      `**Verdict: ${f.verdict.label}**\n\n${f.verdict.summary}\n\n` +
      `| Segment | Trades | Win Rate | Net PnL | Profit Factor | Max DD | Costs |\n` +
      `| --- | --- | --- | --- | --- | --- | --- |\n` +
      `| In-Sample (70%) | ${f.inSample.totalTrades} (${f.inSample.winningTrades}W) | ${f.inSample.winRatePct.toFixed(1)}% | $${f.inSample.totalPnlUsd.toFixed(2)} (${f.inSample.totalPnlPct.toFixed(2)}%) | ${(f.inSample.profitFactor ?? 0).toFixed(2)} | ${f.inSample.maxDrawdownPct.toFixed(2)}% | $${f.inSample.totalCostUsd.toFixed(2)} |\n` +
      `| Out-of-Sample (30%) | ${f.outOfSample.totalTrades} (${f.outOfSample.winningTrades}W) | ${f.outOfSample.winRatePct.toFixed(1)}% | $${f.outOfSample.totalPnlUsd.toFixed(2)} (${f.outOfSample.totalPnlPct.toFixed(2)}%) | ${(f.outOfSample.profitFactor ?? 0).toFixed(2)} | ${f.outOfSample.maxDrawdownPct.toFixed(2)}% | $${f.outOfSample.totalCostUsd.toFixed(2)} |\n` +
      `| **All (IS + OOS)** | **${f.all.totalTrades} (${f.all.winningTrades}W)** | **${f.all.winRatePct.toFixed(1)}%** | **$${f.all.totalPnlUsd.toFixed(2)} (${f.all.totalPnlPct.toFixed(2)}%)** | **${(f.all.profitFactor ?? 0).toFixed(2)}** | **${f.all.maxDrawdownPct.toFixed(2)}%** | **$${f.all.totalCostUsd.toFixed(2)}** |\n\n` +
      `Results are open in the **Strategy Tester** tab at the bottom of your workspace.`;
    writeSse(res, 'token', { delta: fallbackMd });
    writeSse(res, 'done', { model, usedWebSearch: sources.length > 0, usedVision: false });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string | null } }[];
        };
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          writeSse(res, 'token', { delta: content });
        }
      } catch {
        // ignore
      }
    }
  }

  writeSse(res, 'done', {
    model,
    usedWebSearch: sources.length > 0,
    usedVision: false
  });
  res.end();
}
