/**
 * web-loop-ui.spec.ts — mock SSE 验证前端工具调用 loop UI
 *
 * 用法:
 *   npm run build:web
 *   npx playwright test src/test/web-loop-ui.spec.ts --workers=1
 */
import { test, expect } from '@playwright/test';
import { createServer, type ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const WEB_ROOT = path.join(ROOT, 'dist', 'web');
const CHANNEL_ID = 'loop-channel';

type SseClient = {
  channelId: string;
  res: ServerResponse;
};

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sse(res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
}

function writeEvent(client: SseClient, payload: Record<string, unknown>) {
  client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function serveStatic(res: ServerResponse, pathname: string) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(WEB_ROOT, safePath);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function emitMockLoop(clients: Set<SseClient>) {
  const channelClients = [...clients].filter((c) => c.channelId === CHANNEL_ID);
  const send = (delayMs: number, payload: Record<string, unknown>) => {
    setTimeout(() => {
      for (const client of channelClients) writeEvent(client, { channelId: CHANNEL_ID, ...payload });
    }, delayMs);
  };

  send(100, { type: 'status', tool: 'loop', content: '循环 1/3' });
  send(250, { type: 'status', tool: 'read_document', content: '调用工具: read_document(path: README.md)' });
  send(500, { type: 'status', tool: 'read_document', content: '{"success":true,"output":"README content"}' });
  send(750, { type: 'stream', streamType: 'token', content: '工具结果已读取，' });
  send(950, { type: 'stream', streamType: 'token', content: '这是最终回复。' });
  send(1500, { type: 'done' });
}

async function startMockWebServer() {
  const clients = new Set<SseClient>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (url.pathname === '/events') {
      sse(res);
      const client = { channelId: url.searchParams.get('channelId') || '', res };
      clients.add(client);
      req.on('close', () => clients.delete(client));
      return;
    }

    if (url.pathname === '/theme') {
      if (req.method === 'POST') return json(res, { ok: true });
      return json(res, { theme: 'dark', agentId: 'agent-test' });
    }

    if (url.pathname === '/channels') {
      return json(res, [{
        id: CHANNEL_ID,
        name: 'Loop UI Test',
        agentId: 'agent-test',
        did: 'did:test:loop-ui',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
        currentSessionId: 'default',
        sessions: [{ id: 'default', createdAt: '2026-06-15T00:00:00.000Z', messageCount: 0, preview: '默认会话' }],
      }]);
    }

    if (url.pathname.startsWith('/sessions/')) {
      if (req.method === 'PATCH') return json(res, { ok: true });
      return json(res, { channelId: CHANNEL_ID, sessionId: 'default', messages: [] });
    }

    if (url.pathname === '/message' && req.method === 'POST') {
      json(res, { ok: true, async: true, channelId: CHANNEL_ID, sessionId: 'default' }, 202);
      emitMockLoop(clients);
      return;
    }

    if (url.pathname === '/api/chat/abort') return json(res, { aborted: false });
    if (url.pathname === '/api/remote-channels') return json(res, { count: 0, peers: [] });
    if (url.pathname === '/api/p2p-peers') return json(res, { peers: [] });
    if (url.pathname === '/api/p2p-publickey') return json(res, { publicKey: '0'.repeat(64) });
    if (url.pathname === '/api/chat/process-pending') return json(res, { ok: true });
    if (url.pathname === '/self-improve/history') return json(res, { events: [] });
    if (url.pathname === '/judgments') return json(res, []);

    await serveStatic(res, url.pathname);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start mock server');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('tool-call loop SSE events render, finalize, and hide timeline', async ({ page }) => {
  const server = await startMockWebServer();
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);

    await expect(page.locator('#channel-name')).toHaveText('Loop UI Test');
    await expect(page.locator('.message-ai .bubble').filter({ hasText: '你好！我是 Bolloon Agent' })).toBeVisible();

    await page.locator('#input').fill('读取 README 并总结');
    await page.locator('#send').click();

    await expect(page.locator('#loop-timeline-panel')).toBeVisible();
    await expect(page.locator('#loop-timeline-rows')).toContainText('read_document');
    await expect(page.locator('.message-streaming')).toContainText('工具结果已读取');

    await expect(page.locator('.message-streaming')).toHaveCount(0);
    await expect(page.locator('.message-ai .bubble').filter({ hasText: '工具结果已读取，这是最终回复。' })).toBeVisible();
    await expect(page.locator('#loop-timeline-panel')).toBeHidden();

    expect(consoleErrors.filter((line) => !line.includes('favicon'))).toEqual([]);
  } finally {
    await server.close();
  }
});
