import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_MODELS,
  checkRateLimit,
  isDeepSeekConfigured,
  isTavilyConfigured,
  streamAiChat,
  type AiChatRequest
} from './routes/ai.js';
import { getCalendarEventsPayload, getCalendarWeekPayload } from './routes/calendar.js';
import {
  dispatchAlertWebhook,
  getHistoricalBarsPayload,
  getQuotesPayload,
  getSparklinePayload
} from './quotes/service.js';
import {
  getNewsArticlePayload,
  getNewsFlowPayload,
  listNewsProviders
} from './news/service.js';
import {
  getEventPlaybookPayload,
  getMacroRegimePayload,
  getSymbolBriefPayload,
  runEdgeAuditPayload
} from './insights/service.js';
import { getSymbolTechnicalsPayload } from './insights/technicals.js';
import { getSymbolSeasonalsPayload } from './insights/seasonals.js';
import {
  getDislocationPayload,
  getDislocationScanPayload
} from './insights/dislocation.js';
import { getSystemAuditPayload } from './insights/auditLog.js';
import { getOandaEnv, isOandaConfigured } from './quotes/oanda.js';
import { getScreenerPayload } from './screener/service.js';
import type { EdgeAuditEntryInput, TechBiasInput } from './insights/types.js';

/** Load local .env files (repo root + server dir) without overriding real environment variables. */
function loadLocalEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '.env'),
    path.resolve(here, '..', '..', '.env')
  ];
  for (const envPath of candidates) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        } else {
          // Strip unquoted inline comments like `OANDA_ENV=practice   # comment`
          val = val.replace(/\s+#.*$/, '').trim();
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {
      // Optional local .env file
    }
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT) || 3001;
const HOST = '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_AI_BODY_BYTES = 12 * 1024 * 1024; // 12 MiB for up to 4 chart captures

function sendJson(res: ServerResponse, status: number, body: unknown, cacheControl = 'public, max-age=60'): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(payload);
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(
      res,
      200,
      {
        status: 'ok',
        service: 'deplyzeworkflow-api',
        version: '0.1.20',
        fredConfigured: Boolean(process.env.FRED_API_KEY),
        deepseekConfigured: isDeepSeekConfigured(),
        tavilyConfigured: isTavilyConfigured(),
        oandaConfigured: isOandaConfigured(),
        oandaEnv: isOandaConfigured() ? getOandaEnv() : null,
        timestamp: new Date().toISOString()
      },
      'no-store'
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    sendJson(res, 200, {
      name: 'DeplyzeWorkflow API',
      version: '0.1.20',
      endpoints: [
        'GET /health',
        'GET /api/calendar/week?start=YYYY-MM-DD&tz=Africa/Nairobi',
        'GET /api/calendar/events?date=YYYY-MM-DD&category=economic&tz=Africa/Nairobi',
        'GET /api/quotes?symbols=OANDA:XAUUSD,TVC:DXY',
        'GET /api/quotes/sparkline?symbol=OANDA:XAUUSD',
        'GET /api/quotes/bars?symbol=OANDA:XAUUSD&from=1730000000',
        'GET /api/screener?symbols=OANDA:XAUUSD,TVC:DXY',
        'POST /api/screener',
        'GET /api/news?mode=symbol&symbol=OANDA:XAUUSD',
        'GET /api/news/article?url=...',
        'GET /api/news/providers',
        'POST /api/alerts/webhook',
        'GET /api/insights/regime',
        'GET /api/insights/symbol?symbol=OANDA:XAUUSD&bias=bull',
        'GET /api/insights/technicals?symbol=OANDA:XAUUSD&interval=1D',
        'GET /api/insights/seasonals?symbol=OANDA:XAUUSD',
        'GET /api/insights/dislocation?symbol=OANDA:XAUUSD&tf=1h',
        'GET /api/insights/dislocation/scan?tf=1h',
        'GET /api/insights/dislocation/audit',
        'GET /api/insights/event?title=Consumer%20Price%20Index%20YoY&country=US',
        'POST /api/insights/edge-audit',
        'GET /api/ai/models',
        'POST /api/ai/chat'
      ]
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/quotes/sparkline') {
    const rawSym = (url.searchParams.get('symbol') ?? '').trim();
    if (!rawSym) {
      sendJson(res, 400, { error: 'Missing symbol query parameter' }, 'no-store');
      return;
    }
    const payload = await getSparklinePayload(rawSym);
    sendJson(res, 200, payload, 'public, max-age=60');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/quotes/bars') {
    const rawSym = (url.searchParams.get('symbol') ?? '').trim();
    if (!rawSym) {
      sendJson(res, 400, { error: 'Missing symbol query parameter' }, 'no-store');
      return;
    }
    const rawFrom = url.searchParams.get('from');
    const parsedFrom = rawFrom ? Number(rawFrom) : null;
    const chartInterval = url.searchParams.get('interval');
    const payload = await getHistoricalBarsPayload(
      rawSym,
      parsedFrom != null && Number.isFinite(parsedFrom) ? parsedFrom : null,
      chartInterval
    );
    sendJson(res, 200, payload, 'public, max-age=30');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/news/providers') {
    sendJson(res, 200, { providers: listNewsProviders() }, 'public, max-age=3600');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/news/article') {
    const rawUrl = (url.searchParams.get('url') ?? '').trim();
    if (!rawUrl) {
      sendJson(res, 400, { error: 'Missing url query parameter' }, 'no-store');
      return;
    }
    const payload = await getNewsArticlePayload(rawUrl);
    sendJson(res, 200, payload, 'public, max-age=600');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/news') {
    const rawMode = (url.searchParams.get('mode') ?? '').trim().toLowerCase();
    const symbol = (url.searchParams.get('symbol') ?? '').trim();
    const rawSymbols = (url.searchParams.get('symbols') ?? '').trim();
    const symbols = rawSymbols
      ? rawSymbols
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const mode: 'symbol' | 'watchlist' | 'full' =
      rawMode === 'symbol' || rawMode === 'watchlist' || rawMode === 'full'
        ? rawMode
        : symbol
          ? 'symbol'
          : symbols && symbols.length > 0
            ? 'watchlist'
            : 'full';

    const payload = await getNewsFlowPayload({
      mode,
      symbol: symbol || undefined,
      symbols,
      market: url.searchParams.get('market') ?? undefined,
      topic: url.searchParams.get('topic') ?? undefined,
      country: url.searchParams.get('country') ?? undefined,
      provider: url.searchParams.get('provider') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      force: url.searchParams.get('force') === '1'
    });
    sendJson(res, 200, payload, 'no-store');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/quotes') {
    const raw = url.searchParams.get('symbols') ?? '';
    const symbols = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = await getQuotesPayload(symbols);
    sendJson(res, 200, payload, 'public, max-age=5');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/screener') {
    const raw = url.searchParams.get('symbols') ?? '';
    const symbols = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const force = url.searchParams.get('force') === '1';
    const payload = await getScreenerPayload(symbols, force);
    sendJson(res, 200, payload, 'public, max-age=10');
    return;
  }

  if (req.method === 'POST' && pathname === '/api/screener') {
    let body: { symbols?: string[]; force?: boolean };
    try {
      body = await readJsonBody<{ symbols?: string[]; force?: boolean }>(req, 128 * 1024);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message }, 'no-store');
      return;
    }
    const symbols = Array.isArray(body.symbols)
      ? body.symbols.filter((s): s is string => typeof s === 'string')
      : [];
    const payload = await getScreenerPayload(symbols, Boolean(body.force));
    sendJson(res, 200, payload, 'no-store');
    return;
  }

  if (req.method === 'POST' && pathname === '/api/alerts/webhook') {
    let body: { url?: string; payload?: Record<string, unknown> };
    try {
      body = await readJsonBody<{ url?: string; payload?: Record<string, unknown> }>(req, 64 * 1024);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message }, 'no-store');
      return;
    }
    if (!body.url) {
      sendJson(res, 400, { error: 'Missing webhook url' }, 'no-store');
      return;
    }
    const result = await dispatchAlertWebhook(body.url, body.payload ?? {});
    sendJson(res, result.ok ? 200 : 502, result, 'no-store');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/calendar/week') {
    const payload = await getCalendarWeekPayload(
      url.searchParams.get('start'),
      url.searchParams.get('tz')
    );
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/calendar/events') {
    const payload = await getCalendarEventsPayload(
      url.searchParams.get('date'),
      url.searchParams.get('category'),
      url.searchParams.get('tz')
    );
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/regime') {
    const force = url.searchParams.get('force') === '1';
    const payload = await getMacroRegimePayload(force);
    sendJson(res, 200, payload, 'public, max-age=120');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/technicals') {
    const rawSym = (url.searchParams.get('symbol') ?? '').trim();
    if (!rawSym) {
      sendJson(res, 400, { error: 'Missing symbol query parameter' }, 'no-store');
      return;
    }
    const interval = url.searchParams.get('interval');
    const payload = await getSymbolTechnicalsPayload(rawSym, interval);
    sendJson(res, 200, payload, 'public, max-age=15');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/seasonals') {
    const rawSym = (url.searchParams.get('symbol') ?? '').trim();
    if (!rawSym) {
      sendJson(res, 400, { error: 'Missing symbol query parameter' }, 'no-store');
      return;
    }
    const payload = await getSymbolSeasonalsPayload(rawSym);
    sendJson(res, 200, payload, 'public, max-age=300');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/dislocation') {
    const rawSym = (url.searchParams.get('symbol') ?? '').trim() || 'OANDA:XAUUSD';
    const tf = url.searchParams.get('tf');
    const force = url.searchParams.get('force') === '1';
    const payload = await getDislocationPayload(rawSym, tf, force);
    sendJson(res, 200, payload, 'public, max-age=30');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/dislocation/scan') {
    const tf = url.searchParams.get('tf');
    const force = url.searchParams.get('force') === '1';
    const payload = await getDislocationScanPayload(tf, force);
    sendJson(res, 200, payload, 'public, max-age=45');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/dislocation/audit') {
    const payload = await getSystemAuditPayload();
    sendJson(res, 200, payload, 'public, max-age=60');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/symbol') {
    const rawSym = (url.searchParams.get('symbol') ?? '').trim();
    if (!rawSym) {
      sendJson(res, 400, { error: 'Missing symbol query parameter' }, 'no-store');
      return;
    }
    const rawBias = (url.searchParams.get('bias') ?? 'none').toLowerCase();
    const techBias: TechBiasInput =
      rawBias === 'bull' || rawBias === 'bear' || rawBias === 'range' ? rawBias : 'none';
    const force = url.searchParams.get('force') === '1';
    const payload = await getSymbolBriefPayload(rawSym, techBias, force);
    sendJson(res, 200, payload, 'no-store');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/insights/event') {
    const title = (url.searchParams.get('title') ?? '').trim();
    if (!title) {
      sendJson(res, 400, { error: 'Missing title query parameter' }, 'no-store');
      return;
    }
    const country = (url.searchParams.get('country') ?? 'US').trim();
    const forecast = url.searchParams.get('forecast') ?? undefined;
    const prior = url.searchParams.get('prior') ?? undefined;
    const actual = url.searchParams.get('actual') ?? undefined;
    const payload = await getEventPlaybookPayload({ title, country, forecast, prior, actual });
    sendJson(res, 200, payload, 'public, max-age=300');
    return;
  }

  if (req.method === 'POST' && pathname === '/api/insights/edge-audit') {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      sendJson(
        res,
        429,
        { error: 'Rate limit exceeded. Please wait a minute before auditing again.' },
        'no-store'
      );
      return;
    }

    let body: { entries?: EdgeAuditEntryInput[] };
    try {
      body = await readJsonBody<{ entries?: EdgeAuditEntryInput[] }>(req, 512 * 1024);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message }, 'no-store');
      return;
    }

    const payload = await runEdgeAuditPayload(body.entries ?? []);
    sendJson(res, 200, payload, 'no-store');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/ai/models') {
    sendJson(
      res,
      200,
      {
        models: AI_MODELS,
        defaultModel: 'deepseek-flash',
        deepseekConfigured: isDeepSeekConfigured(),
        tavilyConfigured: isTavilyConfigured()
      },
      'no-store'
    );
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/chat') {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      sendJson(
        res,
        429,
        { error: 'Rate limit exceeded. Please wait a minute before sending another request.' },
        'no-store'
      );
      return;
    }

    let body: AiChatRequest;
    try {
      body = await readJsonBody<AiChatRequest>(req, MAX_AI_BODY_BYTES);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message }, 'no-store');
      return;
    }

    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    await streamAiChat(body, res, CORS_ORIGIN, abortController.signal);
    return;
  }

  sendJson(res, 404, { error: 'Not found', path: pathname });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[server] unhandled request error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' }, 'no-store');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`DeplyzeWorkflow API listening on http://${HOST}:${PORT}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
