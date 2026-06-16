/**
 * web-loop-status-bar.spec.ts — 验证三态机 (loading / retrying / done)
 *
 *   1. loading 态: spinner 持续转, 不显示数量
 *   2. retrying 态: server 推 "↻ 自动重试 loop X/N" → status bar 显示橙色 retry 徽章
 *   3. done 态: server 推 done → 显示「✓ 检查」按钮
 *   4. 检查按钮: 点 → 弹 modal 列出 step 输出
 *   5. 无重试按钮 (用户模式, 重试是自动的)
 *
 * 用法:
 *   npm run build:web
 *   npx playwright test src/test/web-loop-status-bar.spec.ts --workers=1
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
const CHANNEL_ID = 'loop-bar-channel';

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
  name: 'Loop Bar Channel',
  did: 'did:fake:loopbar',
  cid: 'bafyfake',
  sessions: [{ id: 'sess-1', name: '默认', createdAt: new Date().toISOString() }],
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
    if (pathname === `/channels/${CHANNEL_ID}/sessions`) {
      return json(res, { session: { id: 'sess-1' }, currentSessionId: 'sess-1' });
    }
    if (pathname === '/theme') return json(res, { theme: 'dark', agentId: 'agent_loop' });
    if (pathname === '/api/remote-channels') return json(res, { peers: [] });
    if (pathname.startsWith('/sessions/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/loop/inspect') {
      return json(res, {
        summary: 'loop 完成 (mock): 跑了 3 个步骤',
        steps: [
          { name: 'shell_exec: echo 1', status: 'ok', durationMs: 320, output: '1' },
          { name: 'shell_exec: echo 2', status: 'ok', durationMs: 280, output: '2' },
          { name: 'shell_exec: echo 3', status: 'ok', durationMs: 250, output: '3' },
        ],
        finalReply: '已完成 3 步',
        tokens: { input: 1200, output: 80 },
      });
    }
    if (pathname === '/message' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => json(res, { ok: true, reply: 'mock' }));
      return;
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

test.describe.serial('loop-status-bar 三态机', () => {
  test('1. loading 态: status bar 显示 spinner, 不显示循环计数', async () => {
    const { server, port } = await startMockServer((clients) => {
      setTimeout(() => {
        const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
        if (!ch) return;
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '🔄 开始 ReAct 循环...' });
      }, 500);
    });
    try {
      const { chromium } = await import('@playwright/test');
      const ctx = await chromium.launch();
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[test1 console err]', msg.text());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const bar = page.locator('#loop-status-bar');
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('data-state', 'loading');
      const text = await bar.textContent();
      expect(text).not.toMatch(/\d+\/\d+/);
      await ctx.close();
    } finally {
      server.close();
    }
  });

  test('2. retrying 态: 自动重试徽章出现, 无重试按钮', async () => {
    const { server, port } = await startMockServer((clients) => {
      setTimeout(() => {
        const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
        if (!ch) return;
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '↻ 自动重试 loop 1/3 (1s 后)' });
      }, 800);
    });
    try {
      const { chromium } = await import('@playwright/test');
      const ctx = await chromium.launch();
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[test2 console err]', msg.text());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const bar = page.locator('#loop-status-bar');
      await expect(bar).toHaveAttribute('data-state', 'retrying');

      const retry = page.locator('#loop-status-retry');
      await expect(retry).toBeVisible();
      const retryText = await retry.textContent();
      expect(retryText).toMatch(/自动重试\s+1\/3/);

      const tagName = await retry.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('span');
      await ctx.close();
    } finally {
      server.close();
    }
  });

  test('3. done 态: 检查按钮出现, 重试徽章隐藏', async () => {
    const { server, port } = await startMockServer((clients) => {
      setTimeout(() => {
        const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
        if (!ch) return;
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '🔄 循环中' });
        setTimeout(() => {
          writeEvent(ch, { channelId: CHANNEL_ID, type: 'done', content: '' });
        }, 600);
      }, 800);
    });
    try {
      const { chromium } = await import('@playwright/test');
      const ctx = await chromium.launch();
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[test3 console err]', msg.text());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const bar = page.locator('#loop-status-bar');
      await expect(bar).toHaveAttribute('data-state', 'done');

      const checkBtn = page.locator('#loop-status-check');
      await expect(checkBtn).toBeVisible();
      await expect(checkBtn).toHaveText(/检查/);

      const retry = page.locator('#loop-status-retry');
      await expect(retry).toBeHidden();
      await ctx.close();
    } finally {
      server.close();
    }
  });

  test('4. 点检查按钮 → 弹 modal 列出 step 输出', async () => {
    const { server, port } = await startMockServer((clients) => {
      setTimeout(() => {
        const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
        if (!ch) return;
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '🔄 循环中' });
        setTimeout(() => {
          writeEvent(ch, { channelId: CHANNEL_ID, type: 'done', content: '' });
        }, 600);
      }, 800);
    });
    try {
      const { chromium } = await import('@playwright/test');
      const ctx = await chromium.launch();
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[test4 console err]', msg.text());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const checkBtn = page.locator('#loop-status-check');
      await checkBtn.click();
      await page.waitForSelector('#loop-inspect-modal', { timeout: 3000 });

      const modal = page.locator('#loop-inspect-modal');
      await expect(modal).toContainText('循环检查');
      await expect(modal).toContainText('shell_exec: echo 1');
      await expect(modal).toContainText('已完成 3 步');
      await expect(modal).toContainText('token: input 1200');

      await page.locator('#loop-inspect-modal button').first().click();
      await page.waitForTimeout(300);
      await expect(page.locator('#loop-inspect-modal')).toHaveCount(0);
      await ctx.close();
    } finally {
      server.close();
    }
  });

  test('5. error 态 (最终失败) → 走 done 路径, 让用户看检查而不是手动重试', async () => {
    const { server, port } = await startMockServer((clients) => {
      setTimeout(() => {
        const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
        if (!ch) return;
        writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '⛔ loop 自动重试 3 次后仍失败: AI 配额耗尽' });
      }, 800);
    });
    try {
      const { chromium } = await import('@playwright/test');
      const ctx = await chromium.launch();
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[test5 console err]', msg.text());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const bar = page.locator('#loop-status-bar');
      await expect(bar).toHaveAttribute('data-state', 'done');

      const retry = page.locator('#loop-status-retry');
      await expect(retry).toBeHidden();

      const checkBtn = page.locator('#loop-status-check');
      await expect(checkBtn).toBeVisible();
      await ctx.close();
    } finally {
      server.close();
    }
  });
});