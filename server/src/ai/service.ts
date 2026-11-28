import type { ServerResponse } from 'node:http';
import {
  buildCopilotSystemPrompt,
  buildUpcomingCalendarContext,
  shouldAutoRunWebSearch
} from './context.js';
import { buildRangeAnalysisPacket } from './rangeContext.js';
import { isTavilyConfigured, runTavilyFinanceSearch } from './tavily.js';
import type { AiChatRequest, AiEffort, AiModelId, AiSourceLink } from './types.js';
import { isStrategyPrompt, runAgenticStrategyMode } from '../strategy/agent.js';

function getDeepSeekChatUrl(): string {
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}
const MAX_IMAGES = 4;
const MAX_HISTORY_MESSAGES = 16;

// Simple per-IP sliding window rate limiter (25 requests per 10 minutes)
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 25;
const ipHits = new Map<string, number[]>();

export function isDeepSeekConfigured(): boolean {
  return Boolean((process.env.DEEPSEEK_API_KEY ?? '').trim());
}

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const list = (ipHits.get(ip) ?? []).filter((ts) => ts > cutoff);
  if (list.length >= RATE_MAX_REQUESTS) {
    ipHits.set(ip, list);
    return false;
  }
  list.push(now);
  ipHits.set(ip, list);
  return true;
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mapEffortToDeepSeek(effort: AiEffort): {
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'high' | 'max';
} {
  switch (effort) {
    case 'low':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
    case 'high':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'max' };
    case 'medium':
    default:
      return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
  }
}

function sanitizeImages(images: string[] | undefined): string[] {
  if (!Array.isArray(images)) return [];
  const valid: string[] = [];
  for (const img of images) {
    if (typeof img !== 'string') continue;
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(img)) {
      valid.push(img);
      if (valid.length >= MAX_IMAGES) break;
    }
  }
  return valid;
}

/**
 * DeepSeek V4 Pro is text-only; when the user selects V4 Pro with chart image(s),
 * extract an exact, neutral visual chart readout via DeepSeek V4.1 Flash first.
 */
async function extractChartSummaryWithFlash(
  apiKey: string,
  images: string[],
  symbol: string,
  signal: AbortSignal
): Promise<string> {
  const contentBlocks: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text:
        `Extract a precise, objective technical visual inventory of the attached chart image(s) for ${symbol}. ` +
        `Report ONLY what is visibly present: timeframe(s), visible price range & current price line, candle trend & market structure (swing highs/lows, recent impulses/pullbacks, notable wicks/patterns), any visible indicators and their approximate readings, and any user-drawn lines, zones, or long/short RR boxes with their exact price levels from the axis. Keep it dense and factual.`
    },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];

  const res = await fetch(getDeepSeekChatUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      max_tokens: 1400,
      messages: [
        {
          role: 'system',
          content: 'You are a high-precision financial chart OCR and visual structure extractor.'
        },
        { role: 'user', content: contentBlocks }
      ]
    }),
    signal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Chart vision pass failed (HTTP ${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() || '';
}

export async function streamAiChat(
  body: AiChatRequest,
  res: ServerResponse,
  corsOrigin: string,
  abortSignal: AbortSignal
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });

  const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!apiKey) {
    writeSse(res, 'error', {
      message:
        'DEEPSEEK_API_KEY is not configured on the backend yet. Add DEEPSEEK_API_KEY (and optional TAVILY_API_KEY) to your environment / Render settings.'
    });
    res.end();
    return;
  }

  const model: AiModelId = body.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash';
  const effort: AiEffort =
    body.effort === 'low' || body.effort === 'high' ? body.effort : 'medium';
  const images = sanitizeImages(body.images);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const history = rawMessages
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
    )
    .slice(-MAX_HISTORY_MESSAGES);

  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    writeSse(res, 'error', { message: 'Request must end with a non-empty user message.' });
    res.end();
    return;
  }

  const latestUserText = history[history.length - 1].content.trim();
  const symbolLabel = body.context?.symbol || body.context?.fullSymbol || 'market';
  const webMode = body.webSearchMode ?? 'auto';
  const hasRangeSelection = Boolean(
    body.context?.range &&
      typeof body.context.range.startTs === 'number' &&
      typeof body.context.range.endTs === 'number' &&
      Number.isFinite(body.context.range.startTs) &&
      Number.isFinite(body.context.range.endTs)
  );

  // Route strategy design / backtesting / refinement requests into the Agentic Strategy Loop
  // (Skip auto-routing into strategy builder when the user explicitly clicked a range analysis pill)
  if (!hasRangeSelection && isStrategyPrompt(latestUserText, history)) {
    try {
      await runAgenticStrategyMode({
        apiKey,
        model,
        effort,
        history,
        latestUserText,
        context: body.context,
        webSearchMode: webMode,
        res,
        abortSignal
      });
    } catch (err) {
      if (abortSignal.aborted) {
        res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unexpected strategy backtest error';
      writeSse(res, 'error', { message: msg });
      res.end();
    }
    return;
  }

  const runSearch =
    !hasRangeSelection &&
    isTavilyConfigured() &&
    (webMode === 'on' || (webMode === 'auto' && shouldAutoRunWebSearch(latestUserText)));

  try {
    let sources: AiSourceLink[] = [];
    let tavilySnippets: string | null = null;
    let rangeDossier: string | null = null;
    let usedRangeSearch = false;
    let calendarCtx = '';

    if (hasRangeSelection && body.context) {
      const rangePacket = await buildRangeAnalysisPacket(
        body.context,
        latestUserText,
        webMode,
        (phase, label) => writeSse(res, 'status', { phase, label })
      );
      rangeDossier = rangePacket.dossier;
      usedRangeSearch = rangePacket.usedWebSearch;
      if (rangePacket.sources.length > 0) {
        sources = rangePacket.sources;
        writeSse(res, 'sources', { sources });
      }
    } else {
      if (runSearch) {
        writeSse(res, 'status', {
          phase: 'searching',
          label: `Searching latest news on ${symbolLabel}...`
        });
      } else if (images.length > 0) {
        writeSse(res, 'status', {
          phase: 'vision',
          label: `Inspecting ${symbolLabel} chart...`
        });
      } else {
        writeSse(res, 'status', { phase: 'thinking', label: 'Analyzing...' });
      }

      const searchQuery = `${symbolLabel} price market news macro catalysts ${latestUserText.slice(0, 120)}`;
      const [upcomingCal, tavilyResult] = await Promise.all([
        buildUpcomingCalendarContext(body.context),
        runSearch
          ? runTavilyFinanceSearch(searchQuery, { topic: 'news', maxResults: 5, days: 7 })
          : Promise.resolve(null)
      ]);
      calendarCtx = upcomingCal;

      if (tavilyResult) {
        sources = tavilyResult.sources;
        tavilySnippets = tavilyResult.snippets;
        if (sources.length > 0) {
          writeSse(res, 'sources', { sources });
        }
      }
    }

    // If user chose DeepSeek V4 Pro (text-only) with chart screenshot(s), run Flash vision bridge first
    let visionBridgeSummary = '';
    const attachImagesDirectly = model === 'deepseek-flash' && images.length > 0;
    if (model === 'deepseek-v4-pro' && images.length > 0) {
      writeSse(res, 'status', {
        phase: 'vision',
        label: `Reading ${symbolLabel} chart for DeepSeek V4 Pro...`
      });
      visionBridgeSummary = await extractChartSummaryWithFlash(
        apiKey,
        images,
        symbolLabel,
        abortSignal
      );
    }

    const systemPrompt = buildCopilotSystemPrompt(
      body.context,
      calendarCtx,
      tavilySnippets,
      images.length > 0,
      rangeDossier
    );

    const apiMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt }
    ];

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      const isLast = i === history.length - 1;
      if (!isLast) {
        apiMessages.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (attachImagesDirectly) {
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        });
      } else if (visionBridgeSummary) {
        apiMessages.push({
          role: 'user',
          content: `${msg.content}\n\n[VISUAL CHART EXTRACTION FROM LIVE SCREENSHOT]\n${visionBridgeSummary}`
        });
      } else {
        apiMessages.push({ role: 'user', content: msg.content });
      }
    }

    const effortParams = mapEffortToDeepSeek(effort);
    writeSse(res, 'status', { phase: 'thinking', label: 'Thinking...' });

    const upstream = await fetch(getDeepSeekChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        stream: true,
        ...effortParams,
        messages: apiMessages
      }),
      signal: abortSignal
    });

    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => '');
      let cleanMsg = `DeepSeek API returned HTTP ${upstream.status}`;
      try {
        const parsed = JSON.parse(errBody) as { error?: { message?: string } };
        if (parsed.error?.message) cleanMsg = parsed.error.message;
      } catch {
        if (errBody) cleanMsg = `${cleanMsg}: ${errBody.slice(0, 220)}`;
      }
      writeSse(res, 'error', { message: cleanMsg });
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sentWritingStatus = false;

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

        let chunk: {
          choices?: {
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
            };
          }[];
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          writeSse(res, 'reasoning', { delta: delta.reasoning_content });
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (!sentWritingStatus) {
            sentWritingStatus = true;
            writeSse(res, 'status', { phase: 'writing', label: 'Writing analysis...' });
          }
          writeSse(res, 'token', { delta: delta.content });
        }
      }
    }

    writeSse(res, 'done', {
      model,
      usedWebSearch: Boolean(tavilySnippets) || usedRangeSearch,
      usedVision: images.length > 0
    });
    res.end();
  } catch (err) {
    if (abortSignal.aborted) {
      res.end();
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unexpected AI streaming error';
    writeSse(res, 'error', { message: msg });
    res.end();
  }
}
