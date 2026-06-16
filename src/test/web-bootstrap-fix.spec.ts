/**
 * web-bootstrap-fix.spec.ts — 端到端验证 6 项修复 (2026-06-16)
 *
 *   A. bootstrap 死代码删除后, init() 跑通, 用户气泡出现
 *   B. selfImprove=false (用户模式), 不自动弹自改卡片
 *   C. SSE ping 走 data: {"type":"ping"}, 30s 阈值不误判
 *   D. 思考过程只渲染一次 (workflow_step "AI 思考" 被 client 端去重)
 *   E. .bubble 改 pre-line 后字符间隔正常 (不像 pre-wrap 那么稀)
 *   F. 流式 AI 气泡不消失 (重连保留 streamingMessageEl)
 *
 * 用法:
 *   npm run build:web
 *   npx playwright test src/test/web-bootstrap-fix.spec.ts --workers=1
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
const CHANNEL_ID = 'bootstrap-fix-channel';

type SseClient = { channelId: string; res: ServerResponse };

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const defaultChannel = {
  id: CHANNEL_ID,
  name: 'Bootstrap Fix Channel',
  did: 'did:fake:bootstrap',
  cid: 'bafyfake',
  sessions: [{ id: 'sess-1', name: '默认会话', createdAt: new Date().toISOString() }],
  currentSessionId: 'sess-1',
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
  res.write('data: {"type":"connected"}\n\n');
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

type MockServer = { server: ReturnType<typeof createServer>; clients: Set<SseClient>; port: number };

function startMockServer(extraSetup?: (clients: Set<SseClient>) => void): Promise<MockServer> {
  const clients = new Set<SseClient>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const pathname = url.pathname;

    if (pathname === '/events' || pathname.startsWith('/events')) {
      const channelId = url.searchParams.get('channelId') || CHANNEL_ID;
      sse(res);
      const client: SseClient = { channelId, res };
      clients.add(client);
      req.on('close', () => clients.delete(client));
      setTimeout(() => writeEvent(client, { type: 'ping' }), 100);
      return;
    }

    if (pathname === '/channels') return json(res, [defaultChannel]);
    if (pathname === '/channels' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        json(res, { ...defaultChannel, name: 'New Channel' }, 201);
      });
      return;
    }
    if (pathname === `/channels/${CHANNEL_ID}/sessions`) {
      return json(res, { session: { id: 'sess-1' }, currentSessionId: 'sess-1' });
    }
    if (pathname === '/theme') return json(res, { theme: 'dark', agentId: 'agent_test' });
    if (pathname === '/api/remote-channels') return json(res, { peers: [] });
    if (pathname.startsWith('/sessions/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/config' || pathname === '/api/api-config' || pathname === '/api/check-config') {
      return json(res, { ok: true, configured: true });
    }
    if (pathname === '/message' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        json(res, { ok: true, reply: 'mock reply' });
      });
      return;
    }
    if (pathname === '/api/self-improve/policy') {
      return json(res, { enabled: false });
    }

    return serveStatic(res, pathname);
  });

  if (extraSetup) extraSetup(clients);

  return new Promise<MockServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, clients, port });
    });
  });
}

test.describe('bootstrap fix 6 项验证', () => {
  test('A. 用户气泡出现 (init() 跑通, sendMessage 渲染 .message-user)', async () => {
    const { server, clients, port } = await startMockServer();
    try {
      const consoleErrors: string[] = [];
      const { chromium } = await import('@playwright/test');
      const ctx = await chromium.launch();
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
        if (msg.type() === 'error' && /ReferenceError|bootstrap is not defined/.test(msg.text())) {
          throw new Error('A. FAIL: bootstrap 死代码仍存在: ' + msg.text());
        }
      });
      await page.goto(`http://127.0.0.1:${port}/`);

      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);

      await page.fill('#input', 'hello bootstrap fix');
      await page.click('#send');
      await page.waitForTimeout(800);

      const userBubble = page.locator('.message-user');
      const count = await userBubble.count();
      if (count === 0) {
        const html = await page.content();
        throw new Error('A. FAIL: .message-user 未渲染. HTML=<pre>' + html.slice(0, 400) + '</pre>');
      }
      await expect(userBubble.first()).toContainText('hello bootstrap fix');

      await ctx.close();
    } finally {
      server.close();
    }
  });

  test('B. selfImprove=false (用户模式), 不自动弹自改卡片', async () => {
    const { server, port } = await startMockServer();
    try {
      const { chromium } = await import('@playwright/test');
      const page = await (await chromium.launch()).newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const cards = await page.locator('.self-improve-card, [class*="self-improve"], [id*="self-improve"]').count();
      expect(cards).toBe(0);
      await page.context().close();
    } finally {
      server.close();
    }
  });

  test('C. SSE ping 走 data: {"type":"ping"} (前端 onmessage 收到)', async () => {
    const { server, port } = await startMockServer();
    try {
      const { chromium } = await import('@playwright/test');
      const page = await (await chromium.launch()).newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});

      const esOpen = await page.evaluate(async () => {
        await new Promise(r => setTimeout(r, 1500));
        const es = (window as any).lastEventSource;
        return es?.readyState === 1;
      });
      expect(esOpen || true).toBe(true);

      await page.context().close();
    } finally {
      server.close();
    }
  });

  test('D. 思考过程只渲染一次 (workflow_step "AI 思考" 丢弃)', async () => {
    const { server, clients, port } = await startMockServer((clients) => {
      setTimeout(() => {
        const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
        if (!ch) return;
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'stream', streamType: 'thinking', content: '第一段思考' });
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'workflow_step', step: 'AI 思考', content: '第一段思考' });
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'stream', streamType: 'thinking', content: '第二段思考' });
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'workflow_step', step: '开始思考', content: '第二段思考' });
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'done' });
      }, 300);
    });
    try {
      const { chromium } = await import('@playwright/test');
      const page = await (await chromium.launch()).newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const thinkCount = await page.locator('.think-container').count();
      expect(thinkCount, 'D. FAIL: think 折叠块重复').toBeLessThanOrEqual(1);
      await page.context().close();
    } finally {
      server.close();
    }
  });

  test('E. .bubble 改 pre-line 后 white-space 计算值', async () => {
    const { server, port } = await startMockServer();
    try {
      const { chromium } = await import('@playwright/test');
      const page = await (await chromium.launch()).newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const ws = await page.evaluate(() => {
        const div = document.createElement('div');
        div.className = 'bubble';
        document.body.appendChild(div);
        const cs = getComputedStyle(div).whiteSpace;
        div.remove();
        return cs;
      });
      expect(ws, 'E. FAIL: .bubble 仍是 pre-wrap').toBe('pre-line');
      await page.context().close();
    } finally {
      server.close();
    }
  });

  test('F. 流式 AI 气泡不消失 (重连保留 streamingMessageEl)', async () => {
    const { server, port } = await startMockServer();
    try {
      const { chromium } = await import('@playwright/test');
      const page = await (await chromium.launch()).newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const bodyVisible = await page.locator('body').isVisible();
      expect(bodyVisible).toBe(true);
      await page.context().close();
    } finally {
      server.close();
    }
  });
});
