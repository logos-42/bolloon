# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/test/web-loop-status-bar.spec.ts >> loop-status-bar 三态机 >> 1. loading 态: status bar 显示 spinner, 不显示循环计数
- Location: src/test/web-loop-status-bar.spec.ts:149:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#loop-status-bar')
Expected: visible
Received: hidden
Timeout:  5000ms

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('#loop-status-bar')
    14 × locator resolved to <div hidden="" id="loop-status-bar" data-state="loading" class="loop-status-bar">…</div>
       - unexpected value "hidden"

```

```yaml
- complementary:
  - button "收起侧边栏":
    - img
  - text: ◈ Bolloon 智能体
  - button "新建智能体":
    - img
    - text: 新建智能体
  - list:
    - listitem:
      - img
      - text: 💬 Loop Bar Channel
      - button "配置智能体 (钱包 / 工具)":
        - img
      - button "×"
      - list
  - text: ▼ P2P 好友
  - button "⊞ 展开"
  - button "我的 ID"
  - button "+ 好友"
  - list:
    - listitem: (暂无好友, 点 + 添加)
  - text: 已连接
- main:
  - heading "Loop Bar Channel" [level=1]
  - button "切换主题":
    - img
  - button "API 配置":
    - img
  - button "钱包管理":
    - img
  - button "我的判断":
    - img
  - text: 你好！我是 Bolloon Agent。有什么我可以帮你的吗？ 执行步骤 ▾
  - list
  - button "复制":
    - img
    - text: 复制
  - button "蒸馏为判断":
    - img
    - text: 蒸馏为判断
  - button "重新回答":
    - img
    - text: 重新回答
  - text: 16:53
  - textbox "输入消息..."
  - button "发送 (Enter)":
    - img
```

# Test source

```ts
  69  |   const safePath = pathname === '/' ? '/index.html' : pathname;
  70  |   const filePath = path.join(WEB_ROOT, safePath);
  71  |   if (!filePath.startsWith(WEB_ROOT)) {
  72  |     res.writeHead(403);
  73  |     res.end('Forbidden');
  74  |     return;
  75  |   }
  76  |   try {
  77  |     const body = await readFile(filePath);
  78  |     const ext = path.extname(filePath);
  79  |     res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
  80  |     res.end(body);
  81  |   } catch {
  82  |     res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  83  |     res.end('Not found');
  84  |   }
  85  | }
  86  | 
  87  | type MockServer = { server: ReturnType<typeof createServer>; clients: Set<SseClient>; port: number };
  88  | 
  89  | function startMockServer(extraSetup?: (clients: Set<SseClient>) => void): Promise<MockServer> {
  90  |   const clients = new Set<SseClient>();
  91  |   const server = createServer(async (req, res) => {
  92  |     const url = new URL(req.url || '/', `http://localhost`);
  93  |     const pathname = url.pathname;
  94  | 
  95  |     if (pathname === '/events' || pathname.startsWith('/events')) {
  96  |       const channelId = url.searchParams.get('channelId') || CHANNEL_ID;
  97  |       sse(res);
  98  |       const client: SseClient = { channelId, res };
  99  |       clients.add(client);
  100 |       req.on('close', () => clients.delete(client));
  101 |       setTimeout(() => writeEvent(client, { type: 'ping' }), 100);
  102 |       return;
  103 |     }
  104 | 
  105 |     if (pathname === '/channels') return json(res, [defaultChannel]);
  106 |     if (pathname === `/channels/${CHANNEL_ID}/sessions`) {
  107 |       return json(res, { session: { id: 'sess-1' }, currentSessionId: 'sess-1' });
  108 |     }
  109 |     if (pathname === '/theme') return json(res, { theme: 'dark', agentId: 'agent_loop' });
  110 |     if (pathname === '/api/remote-channels') return json(res, { peers: [] });
  111 |     if (pathname.startsWith('/sessions/')) {
  112 |       res.writeHead(200, { 'Content-Type': 'application/json' });
  113 |       return res.end(JSON.stringify({ ok: true }));
  114 |     }
  115 |     if (pathname === '/api/loop/inspect') {
  116 |       return json(res, {
  117 |         summary: 'loop 完成 (mock): 跑了 3 个步骤',
  118 |         steps: [
  119 |           { name: 'shell_exec: echo 1', status: 'ok', durationMs: 320, output: '1' },
  120 |           { name: 'shell_exec: echo 2', status: 'ok', durationMs: 280, output: '2' },
  121 |           { name: 'shell_exec: echo 3', status: 'ok', durationMs: 250, output: '3' },
  122 |         ],
  123 |         finalReply: '已完成 3 步',
  124 |         tokens: { input: 1200, output: 80 },
  125 |       });
  126 |     }
  127 |     if (pathname === '/message' && req.method === 'POST') {
  128 |       let body = '';
  129 |       req.on('data', (chunk) => { body += chunk; });
  130 |       req.on('end', () => json(res, { ok: true, reply: 'mock' }));
  131 |       return;
  132 |     }
  133 | 
  134 |     return serveStatic(res, pathname);
  135 |   });
  136 | 
  137 |   if (extraSetup) extraSetup(clients);
  138 | 
  139 |   return new Promise<MockServer>((resolve) => {
  140 |     server.listen(0, '127.0.0.1', () => {
  141 |       const addr = server.address();
  142 |       const port = typeof addr === 'object' && addr ? addr.port : 0;
  143 |       resolve({ server, clients, port });
  144 |     });
  145 |   });
  146 | }
  147 | 
  148 | test.describe.serial('loop-status-bar 三态机', () => {
  149 |   test('1. loading 态: status bar 显示 spinner, 不显示循环计数', async () => {
  150 |     const { server, port } = await startMockServer((clients) => {
  151 |       setTimeout(() => {
  152 |         const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
  153 |         if (!ch) return;
  154 |         writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '🔄 开始 ReAct 循环...' });
  155 |       }, 500);
  156 |     });
  157 |     try {
  158 |       const { chromium } = await import('@playwright/test');
  159 |       const ctx = await chromium.launch();
  160 |       const page = await ctx.newPage();
  161 |       page.on('console', (msg) => {
  162 |         if (msg.type() === 'error') console.log('[test1 console err]', msg.text());
  163 |       });
  164 |       await page.goto(`http://127.0.0.1:${port}/`);
  165 |       await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
  166 |       await page.waitForTimeout(2500);
  167 | 
  168 |       const bar = page.locator('#loop-status-bar');
> 169 |       await expect(bar).toBeVisible();
      |                         ^ Error: expect(locator).toBeVisible() failed
  170 |       await expect(bar).toHaveAttribute('data-state', 'loading');
  171 |       const text = await bar.textContent();
  172 |       expect(text).not.toMatch(/\d+\/\d+/);
  173 |       await ctx.close();
  174 |     } finally {
  175 |       server.close();
  176 |     }
  177 |   });
  178 | 
  179 |   test('2. retrying 态: 自动重试徽章出现, 无重试按钮', async () => {
  180 |     const { server, port } = await startMockServer((clients) => {
  181 |       setTimeout(() => {
  182 |         const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
  183 |         if (!ch) return;
  184 |         writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '↻ 自动重试 loop 1/3 (1s 后)' });
  185 |       }, 800);
  186 |     });
  187 |     try {
  188 |       const { chromium } = await import('@playwright/test');
  189 |       const ctx = await chromium.launch();
  190 |       const page = await ctx.newPage();
  191 |       page.on('console', (msg) => {
  192 |         if (msg.type() === 'error') console.log('[test2 console err]', msg.text());
  193 |       });
  194 |       await page.goto(`http://127.0.0.1:${port}/`);
  195 |       await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
  196 |       await page.waitForTimeout(2500);
  197 | 
  198 |       const bar = page.locator('#loop-status-bar');
  199 |       await expect(bar).toHaveAttribute('data-state', 'retrying');
  200 | 
  201 |       const retry = page.locator('#loop-status-retry');
  202 |       await expect(retry).toBeVisible();
  203 |       const retryText = await retry.textContent();
  204 |       expect(retryText).toMatch(/自动重试\s+1\/3/);
  205 | 
  206 |       const tagName = await retry.evaluate((el) => el.tagName.toLowerCase());
  207 |       expect(tagName).toBe('span');
  208 |       await ctx.close();
  209 |     } finally {
  210 |       server.close();
  211 |     }
  212 |   });
  213 | 
  214 |   test('3. done 态: 检查按钮出现, 重试徽章隐藏', async () => {
  215 |     const { server, port } = await startMockServer((clients) => {
  216 |       setTimeout(() => {
  217 |         const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
  218 |         if (!ch) return;
  219 |         writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '🔄 循环中' });
  220 |         setTimeout(() => {
  221 |           writeEvent(ch, { channelId: CHANNEL_ID, type: 'done', content: '' });
  222 |         }, 600);
  223 |       }, 800);
  224 |     });
  225 |     try {
  226 |       const { chromium } = await import('@playwright/test');
  227 |       const ctx = await chromium.launch();
  228 |       const page = await ctx.newPage();
  229 |       page.on('console', (msg) => {
  230 |         if (msg.type() === 'error') console.log('[test3 console err]', msg.text());
  231 |       });
  232 |       await page.goto(`http://127.0.0.1:${port}/`);
  233 |       await page.waitForSelector('#input', { timeout: 5000 }).catch(() => {});
  234 |       await page.waitForTimeout(2500);
  235 | 
  236 |       const bar = page.locator('#loop-status-bar');
  237 |       await expect(bar).toHaveAttribute('data-state', 'done');
  238 | 
  239 |       const checkBtn = page.locator('#loop-status-check');
  240 |       await expect(checkBtn).toBeVisible();
  241 |       await expect(checkBtn).toHaveText(/检查/);
  242 | 
  243 |       const retry = page.locator('#loop-status-retry');
  244 |       await expect(retry).toBeHidden();
  245 |       await ctx.close();
  246 |     } finally {
  247 |       server.close();
  248 |     }
  249 |   });
  250 | 
  251 |   test('4. 点检查按钮 → 弹 modal 列出 step 输出', async () => {
  252 |     const { server, port } = await startMockServer((clients) => {
  253 |       setTimeout(() => {
  254 |         const ch = [...clients].find((c) => c.channelId === CHANNEL_ID);
  255 |         if (!ch) return;
  256 |         writeEvent(ch, { channelId: CHANNEL_ID, type: 'status', tool: 'system', content: '🔄 循环中' });
  257 |         setTimeout(() => {
  258 |           writeEvent(ch, { channelId: CHANNEL_ID, type: 'done', content: '' });
  259 |         }, 600);
  260 |       }, 800);
  261 |     });
  262 |     try {
  263 |       const { chromium } = await import('@playwright/test');
  264 |       const ctx = await chromium.launch();
  265 |       const page = await ctx.newPage();
  266 |       page.on('console', (msg) => {
  267 |         if (msg.type() === 'error') console.log('[test4 console err]', msg.text());
  268 |       });
  269 |       await page.goto(`http://127.0.0.1:${port}/`);
```