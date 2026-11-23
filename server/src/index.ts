import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCalendarEventsPayload, getCalendarWeekPayload } from './routes/calendar.js';

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(payload);
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
    sendJson(res, 200, {
      status: 'ok',
      service: 'deplyzeworkflow-api',
      version: '0.1.2',
      fredConfigured: Boolean(process.env.FRED_API_KEY),
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    sendJson(res, 200, {
      name: 'DeplyzeWorkflow API',
      version: '0.1.2',
      endpoints: [
        'GET /health',
        'GET /api/calendar/week?start=YYYY-MM-DD&tz=Africa/Nairobi',
        'GET /api/calendar/events?date=YYYY-MM-DD&category=economic&tz=Africa/Nairobi'
      ]
    });
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

  sendJson(res, 404, { error: 'Not found', path: pathname });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[server] unhandled request error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
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
