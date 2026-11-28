import { getCalendarWeekPayload } from '../calendar/service.js';
import { addDays, getTodayInTz, getWeekStart, resolveTimeZone } from '../calendar/time.js';
import type { CountryCode, EconomicEvent } from '../calendar/types.js';
import type { AiChartContext } from './types.js';

export function inferRelevantCountries(symbol: string | undefined): CountryCode[] {
  const s = (symbol ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const set = new Set<CountryCode>();

  if (s.includes('USD') || s.includes('XAU') || s.includes('XAG') || s.includes('OIL') || s.includes('WTI') || s.includes('SPX') || s.includes('NAS') || s.includes('DXY') || s.includes('US30') || s.includes('BTC')) {
    set.add('US');
  }
  if (s.includes('EUR')) {
    set.add('EU');
    set.add('DE');
  }
  if (s.includes('GBP') || s.includes('UK100')) set.add('GB');
  if (s.includes('JPY') || s.includes('NI225')) set.add('JP');
  if (s.includes('AUD')) set.add('AU');
  if (s.includes('NZD')) set.add('NZ');
  if (s.includes('CAD')) set.add('CA');
  if (s.includes('CHF')) set.add('CH');
  if (s.includes('CNY') || s.includes('CNH') || s.includes('OIL')) set.add('CN');

  if (set.size === 0) set.add('US');
  return Array.from(set);
}

export async function buildUpcomingCalendarContext(ctx?: AiChartContext): Promise<string> {
  try {
    const tz = resolveTimeZone(ctx?.timezone);
    const today = getTodayInTz(tz);
    const weekStart = getWeekStart(today);
    const countries = new Set(inferRelevantCountries(ctx?.symbol || ctx?.fullSymbol));

    const week = await getCalendarWeekPayload(weekStart, tz);
    const targetDates = [today, addDays(today, 1), addDays(today, 2)];

    const relevant: EconomicEvent[] = [];
    for (const day of targetDates) {
      const evs = week.eventsByDate[day] ?? [];
      for (const ev of evs) {
        if (ev.impact === 'high' && countries.has(ev.country)) {
          relevant.push(ev);
        }
      }
    }

    if (relevant.length === 0) {
      return `No high-impact economic releases found in the next 48h for ${Array.from(countries).join(', ')} (${tz}).`;
    }

    const lines = relevant.slice(0, 10).map((ev) => {
      const stats: string[] = [];
      if (ev.actual) stats.push(`Actual: ${ev.actual}`);
      if (ev.forecast) stats.push(`Forecast: ${ev.forecast}`);
      if (ev.prior) stats.push(`Prior: ${ev.prior}`);
      const meta = stats.length > 0 ? ` (${stats.join(', ')})` : '';
      return `- ${ev.date} ${ev.time} ${tz} [${ev.country}] ${ev.title}${meta}`;
    });

    return `Upcoming high-impact economic calendar events (${tz}):\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

export function buildCopilotSystemPrompt(
  ctx: AiChartContext | undefined,
  calendarContext: string,
  tavilyContext: string | null,
  hasChartImage: boolean,
  rangeDossier?: string | null,
  agentDossier?: string | null
): string {
  const symbol = ctx?.symbol || 'the active chart';
  const fullSymbol = ctx?.fullSymbol ? ` (${ctx.fullSymbol})` : '';
  const tfLine = ctx?.interval ? ` · Timeframe: ${ctx.interval}` : '';
  const priceLine =
    typeof ctx?.price === 'number' && Number.isFinite(ctx.price)
      ? `Live Price: ${ctx.price}${typeof ctx.changePercent === 'number' ? ` (${ctx.changePercent >= 0 ? '+' : ''}${ctx.changePercent.toFixed(2)}%)` : ''}`
      : 'Live Price: read from the chart price axis if visible';
  const tz = ctx?.timezone || 'UTC';
  const nowIso = new Date().toISOString();
  const hasRangeDossier = Boolean(rangeDossier && rangeDossier.trim().length > 0);
  const hasAgentDossier = Boolean(agentDossier && agentDossier.trim().length > 0);
  const hasGroundedData = hasRangeDossier || hasAgentDossier;

  const sections: string[] = [
    `You are DeplyzeWorkflow AI Copilot — an institutional-grade Agentic Trading Desk Analyst & Risk Officer integrated directly into the trader's live workstation.`,
    `Current UTC time: ${nowIso} (User timezone: ${tz}).`,
    `Active Instrument: ${symbol}${fullSymbol}${tfLine}\n${priceLine}`,
    hasChartImage
      ? hasRangeDossier
        ? `A live capture of the user's active chart WITH their highlighted purple-to-blue selected range is attached, TOGETHER with exact OANDA/historical candles, computed start-vs-end technical indicators, and windowed economic calendar & news data below. Anchor your analysis strictly to the selected range.`
        : hasAgentDossier
          ? `A live capture of the user's active chart is attached TOGETHER with verified multi-market OANDA tool telemetry, workspace state, and executed/proposed agent actions below.`
          : `A live capture of the user's active chart (and any attached higher/lower timeframe screenshots) is included with this request. Inspect EVERY visual detail carefully: timeframe label in the top-left, exact price axis scale, recent candlestick structure (swing highs/lows, wicks, engulfing/rejection bars, consolidation, break of structure), any visible indicators, and any drawings/zones/entry-SL-TP boxes the user has placed on the chart.`
      : hasGroundedData
        ? `Verified real-time OANDA market telemetry, intermarket dislocation metrics, workspace portfolio state, and/or selected chart range data are provided below. Ground every figure strictly in those real numbers.`
        : `No chart screenshot was attached to this message. Base your answer on the live quote, macro calendar, web search context (if provided), and general market structure principles. Remind the user briefly if visual chart context would improve precision.`,
    `STRICT RULES:
1. Be 100% honest and grounded. ${
      hasGroundedData
        ? `Cite the exact OANDA OHLC prices, technical indicator values, screener/dislocation scores, OANDA crowd skew, risk sizing numbers, calendar releases, and news sources supplied in the verified telemetry below. NEVER invent prices, events, or indicator values not present in the telemetry or visible on the chart.`
        : `NEVER fabricate indicator values (RSI, MACD, 200 EMA, etc.) that are NOT actually visible on the chart image. If an indicator isn't on the chart, analyze pure price action, market structure, and key S/R levels instead.`
    }
2. You CANNOT draw trendlines or add TradingView studies directly inside the embedded TradingView chart iframe — be transparent if asked, and instead present exact levels or use your workspace tools (multi-chart desk layouts, watchlists, alerts, notes, tasks, Strategy Tester, and 1-click risk-sized Paper Order cards).
3. Keep output crisp, scannable, and high-signal — no filler intros like "Sure! Here is your analysis". Start immediately with the structured breakdown.
4. Format cleanly with GitHub-flavored Markdown:
   - Use bold section headings (e.g., **Directional Bias: BULLISH**, **Setup Rating: 7.5 / 10**, **Key Levels**, **Trade Plan**, **Macro & Event Risk**).
   - Keep Markdown tables compact (3–4 short columns max) so they read cleanly inside a side panel without wrapping words.
   - Use exact price numbers matching the instrument's decimal precision.
   - When rating a user's setup, score out of 10 with a concise confluence table plus clear Strengths, Risks, and Invalidation.
   - When web search results or news items are provided, synthesize the relevant catalysts concisely and cite sources as Markdown links \`[Source Title](url)\`.
5. Keep tone disciplined and analytical; this is market analysis, not personalized financial advice.`
  ];

  if (hasRangeDossier && rangeDossier) {
    sections.push(rangeDossier);
  }

  if (hasAgentDossier && agentDossier) {
    sections.push(agentDossier);
  }

  if (calendarContext) {
    sections.push(`LIVE ECONOMIC CALENDAR CONTEXT:\n${calendarContext}`);
  }

  if (tavilyContext) {
    sections.push(`LIVE WEB SEARCH RESULTS (TAVILY):\n${tavilyContext}`);
  }

  return sections.join('\n\n---\n\n');
}

export function shouldAutoRunWebSearch(prompt: string): boolean {
  return /\b(latest|news|headline|catalyst|macro|fundamental|fed|fomc|cpi|nfp|ppi|ecb|boe|boj|tariff|war|geopolit|earnings|yield|dxy|why is|why did|moving|driver|sentiment|outlook|today'?s|this week)\b/i.test(
    prompt
  );
}
