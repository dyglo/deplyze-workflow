import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getCalendarEventsPayload, getCalendarWeekPayload } from './routes/calendar.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(payload);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'deplyzeworkflow-api',
      version: '0.1.0',
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'GET' && path === '/') {
    sendJson(res, 200, {
      name: 'DeplyzeWorkflow API',
      version: '0.1.0',
      endpoints: [
        'GET /health',
        'GET /api/calendar/week?start=YYYY-MM-DD',
        'GET /api/calendar/events?date=YYYY-MM-DD&category=economic'
      ]
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/calendar/week') {
    sendJson(res, 200, getCalendarWeekPayload(url.searchParams.get('start')));
    return;
  }

  if (req.method === 'GET' && path === '/api/calendar/events') {
    sendJson(
      res,
      200,
      getCalendarEventsPayload(url.searchParams.get('date'), url.searchParams.get('category'))
    );
    return;
  }

  sendJson(res, 404, { error: 'Not found', path });
}

const server = createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`DeplyzeWorkflow API listening on http://${HOST}:${PORT}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
