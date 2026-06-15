# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/test/web-loop-ui.spec.ts >> tool-call loop SSE events render, finalize, and hide timeline
- Location: src/test/web-loop-ui.spec.ts:164:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 10

- Array []
+ Array [
+   "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"application/octet-stream\". Strict MIME type checking is enforced for module scripts per HTML spec.",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "bootstrap is not defined",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "加载连接历史失败: SyntaxError: Unexpected token 'N', \"Not found\" is not valid JSON",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to check API config: SyntaxError: Unexpected token 'N', \"Not found\" is not valid JSON",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - complementary [ref=e3]:
    - generic [ref=e4]:
      - button "收起侧边栏" [ref=e5] [cursor=pointer]:
        - img [ref=e6]
      - generic [ref=e8]:
        - generic [ref=e9]: ◈
        - generic [ref=e10]: Bolloon
    - generic [ref=e11]:
      - generic [ref=e13]: 智能体
      - button "新建智能体" [ref=e14] [cursor=pointer]:
        - img [ref=e15]
        - generic [ref=e16]: 新建智能体
      - list [ref=e17]:
        - listitem [ref=e18]:
          - generic [ref=e19] [cursor=pointer]:
            - img [ref=e20]
            - generic [ref=e22]: 💬
            - generic "Loop UI Test" [ref=e23]
            - generic [ref=e24]:
              - button "配置智能体 (钱包 / 工具)" [ref=e25]:
                - img [ref=e26]
              - button "×" [ref=e29]
          - list
    - generic "拖动调整上方/下方高度" [ref=e30]
    - generic [ref=e31]:
      - generic [ref=e32] [cursor=pointer]:
        - generic [ref=e33]:
          - generic [ref=e34]: ▼
          - generic [ref=e35]: P2P 好友
        - generic [ref=e36]:
          - button "⊞ 展开" [ref=e37]
          - button "我的 ID" [ref=e38]
          - button "+ 好友" [ref=e39]
      - list [ref=e40]:
        - listitem [ref=e41]: (暂无好友, 点 + 添加)
    - generic [ref=e45]: 已连接
  - main [ref=e46]:
    - generic [ref=e47]:
      - heading "Loop UI Test" [level=1] [ref=e50]
      - generic [ref=e51]:
        - button "切换主题" [ref=e52] [cursor=pointer]:
          - img [ref=e53]
        - button "API 配置" [ref=e59] [cursor=pointer]:
          - img [ref=e60]
        - button "钱包管理" [ref=e63] [cursor=pointer]:
          - img [ref=e64]
        - button "我的判断" [ref=e68] [cursor=pointer]:
          - img [ref=e69]
    - generic [ref=e73]:
      - generic [ref=e74]:
        - generic [ref=e75]: 你好！我是 Bolloon Agent。有什么我可以帮你的吗？
        - generic [ref=e76]:
          - button "复制" [ref=e77] [cursor=pointer]:
            - img [ref=e78]
            - text: 复制
          - button "蒸馏为判断" [ref=e81] [cursor=pointer]:
            - img [ref=e82]
            - text: 蒸馏为判断
          - button "重新回答" [ref=e85] [cursor=pointer]:
            - img [ref=e86]
            - text: 重新回答
        - generic [ref=e88]: 18:35
      - generic [ref=e89]:
        - paragraph [ref=e91]: 读取 README 并总结
        - generic [ref=e92]: 18:35
      - generic [ref=e93]:
        - paragraph [ref=e95]: 工具结果已读取，这是最终回复。
        - generic [ref=e96]:
          - button "复制" [ref=e97] [cursor=pointer]:
            - img [ref=e98]
            - text: 复制
          - button "蒸馏为判断" [ref=e101] [cursor=pointer]:
            - img [ref=e102]
            - text: 蒸馏为判断
          - button "重新回答" [ref=e105] [cursor=pointer]:
            - img [ref=e106]
            - text: 重新回答
        - generic [ref=e108]: 18:35
    - generic [ref=e110]:
      - textbox "输入消息..." [ref=e111]
      - button [active] [ref=e112] [cursor=pointer]:
        - img [ref=e113]
```

# Test source

```ts
  89  | }
  90  | 
  91  | async function startMockWebServer() {
  92  |   const clients = new Set<SseClient>();
  93  | 
  94  |   const server = createServer(async (req, res) => {
  95  |     const url = new URL(req.url || '/', 'http://127.0.0.1');
  96  | 
  97  |     if (req.method === 'OPTIONS') {
  98  |       res.writeHead(204, {
  99  |         'Access-Control-Allow-Origin': '*',
  100 |         'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  101 |         'Access-Control-Allow-Headers': 'Content-Type',
  102 |       });
  103 |       res.end();
  104 |       return;
  105 |     }
  106 | 
  107 |     if (url.pathname === '/events') {
  108 |       sse(res);
  109 |       const client = { channelId: url.searchParams.get('channelId') || '', res };
  110 |       clients.add(client);
  111 |       req.on('close', () => clients.delete(client));
  112 |       return;
  113 |     }
  114 | 
  115 |     if (url.pathname === '/theme') {
  116 |       if (req.method === 'POST') return json(res, { ok: true });
  117 |       return json(res, { theme: 'dark', agentId: 'agent-test' });
  118 |     }
  119 | 
  120 |     if (url.pathname === '/channels') {
  121 |       return json(res, [{
  122 |         id: CHANNEL_ID,
  123 |         name: 'Loop UI Test',
  124 |         agentId: 'agent-test',
  125 |         did: 'did:test:loop-ui',
  126 |         createdAt: '2026-06-15T00:00:00.000Z',
  127 |         updatedAt: '2026-06-15T00:00:00.000Z',
  128 |         currentSessionId: 'default',
  129 |         sessions: [{ id: 'default', createdAt: '2026-06-15T00:00:00.000Z', messageCount: 0, preview: '默认会话' }],
  130 |       }]);
  131 |     }
  132 | 
  133 |     if (url.pathname.startsWith('/sessions/')) {
  134 |       if (req.method === 'PATCH') return json(res, { ok: true });
  135 |       return json(res, { channelId: CHANNEL_ID, sessionId: 'default', messages: [] });
  136 |     }
  137 | 
  138 |     if (url.pathname === '/message' && req.method === 'POST') {
  139 |       json(res, { ok: true, async: true, channelId: CHANNEL_ID, sessionId: 'default' }, 202);
  140 |       emitMockLoop(clients);
  141 |       return;
  142 |     }
  143 | 
  144 |     if (url.pathname === '/api/chat/abort') return json(res, { aborted: false });
  145 |     if (url.pathname === '/api/remote-channels') return json(res, { count: 0, peers: [] });
  146 |     if (url.pathname === '/api/p2p-peers') return json(res, { peers: [] });
  147 |     if (url.pathname === '/api/p2p-publickey') return json(res, { publicKey: '0'.repeat(64) });
  148 |     if (url.pathname === '/api/chat/process-pending') return json(res, { ok: true });
  149 |     if (url.pathname === '/self-improve/history') return json(res, { events: [] });
  150 |     if (url.pathname === '/judgments') return json(res, []);
  151 | 
  152 |     await serveStatic(res, url.pathname);
  153 |   });
  154 | 
  155 |   await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  156 |   const address = server.address();
  157 |   if (!address || typeof address === 'string') throw new Error('Failed to start mock server');
  158 |   return {
  159 |     port: address.port,
  160 |     close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  161 |   };
  162 | }
  163 | 
  164 | test('tool-call loop SSE events render, finalize, and hide timeline', async ({ page }) => {
  165 |   const server = await startMockWebServer();
  166 |   const consoleErrors: string[] = [];
  167 |   page.on('pageerror', (err) => consoleErrors.push(err.message));
  168 |   page.on('console', (msg) => {
  169 |     if (msg.type() === 'error') consoleErrors.push(msg.text());
  170 |   });
  171 | 
  172 |   try {
  173 |     await page.goto(`http://127.0.0.1:${server.port}/`);
  174 | 
  175 |     await expect(page.locator('#channel-name')).toHaveText('Loop UI Test');
  176 |     await expect(page.locator('.message-ai .bubble').filter({ hasText: '你好！我是 Bolloon Agent' })).toBeVisible();
  177 | 
  178 |     await page.locator('#input').fill('读取 README 并总结');
  179 |     await page.locator('#send').click();
  180 | 
  181 |     await expect(page.locator('#loop-timeline-panel')).toBeVisible();
  182 |     await expect(page.locator('#loop-timeline-rows')).toContainText('read_document');
  183 |     await expect(page.locator('.message-streaming')).toContainText('工具结果已读取');
  184 | 
  185 |     await expect(page.locator('.message-streaming')).toHaveCount(0);
  186 |     await expect(page.locator('.message-ai .bubble').filter({ hasText: '工具结果已读取，这是最终回复。' })).toBeVisible();
  187 |     await expect(page.locator('#loop-timeline-panel')).toBeHidden();
  188 | 
> 189 |     expect(consoleErrors.filter((line) => !line.includes('favicon'))).toEqual([]);
      |                                                                       ^ Error: expect(received).toEqual(expected) // deep equality
  190 |   } finally {
  191 |     await server.close();
  192 |   }
  193 | });
  194 | 
```