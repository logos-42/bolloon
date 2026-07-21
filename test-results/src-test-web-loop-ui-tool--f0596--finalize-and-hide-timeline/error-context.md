# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/test/web-loop-ui.spec.ts >> tool-call loop SSE events render, finalize, and hide timeline
- Location: src/test/web-loop-ui.spec.ts:165:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 12

- Array []
+ Array [
+   "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"application/octet-stream\". Strict MIME type checking is enforced for module scripts per HTML spec.",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "加载连接历史失败: SyntaxError: Unexpected token 'N', \"Not found\" is not valid JSON",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
+   "Failed to check API config: SyntaxError: Unexpected token 'N', \"Not found\" is not valid JSON",
+   "Failed to load resource: the server responded with a status of 404 (Not Found)",
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
          - generic [ref=e77] [cursor=pointer]:
            - generic [ref=e78]: 执行步骤
            - generic [ref=e79]: ▾
          - list [ref=e81]
        - generic [ref=e82]:
          - button "复制" [ref=e83] [cursor=pointer]:
            - img [ref=e84]
            - text: 复制
          - button "蒸馏为判断" [ref=e87] [cursor=pointer]:
            - img [ref=e88]
            - text: 蒸馏为判断
          - button "重新回答" [ref=e91] [cursor=pointer]:
            - img [ref=e92]
            - text: 重新回答
        - generic [ref=e94]: 11:35
      - generic [ref=e95]:
        - paragraph [ref=e97]: 读取 README 并总结
        - generic [ref=e98]: 11:35
      - generic [ref=e99]:
        - paragraph [ref=e101]: 这是最终回复。
        - generic [ref=e102]:
          - button "复制" [ref=e103] [cursor=pointer]:
            - img [ref=e104]
            - text: 复制
          - button "蒸馏为判断" [ref=e107] [cursor=pointer]:
            - img [ref=e108]
            - text: 蒸馏为判断
          - button "重新回答" [ref=e111] [cursor=pointer]:
            - img [ref=e112]
            - text: 重新回答
        - generic [ref=e114]: 11:35
        - generic [ref=e115]:
          - generic [ref=e116] [cursor=pointer]:
            - generic [ref=e117]: ✓ 已完成 · 1 步
            - generic "read_document · done" [ref=e119]
            - generic [ref=e120]: ▾
          - list [ref=e122]:
            - listitem [ref=e123]:
              - generic [ref=e125]: read_document
              - generic [ref=e126]: "{\"path\":\"README.md\"}"
    - generic [ref=e128]:
      - textbox "输入消息..." [ref=e129]
      - button "发送 (Enter)" [active] [ref=e130] [cursor=pointer]:
        - img [ref=e131]
```

# Test source

```ts
  103 |       });
  104 |       res.end();
  105 |       return;
  106 |     }
  107 | 
  108 |     if (url.pathname === '/events') {
  109 |       sse(res);
  110 |       const client = { channelId: url.searchParams.get('channelId') || '', res };
  111 |       clients.add(client);
  112 |       req.on('close', () => clients.delete(client));
  113 |       return;
  114 |     }
  115 | 
  116 |     if (url.pathname === '/theme') {
  117 |       if (req.method === 'POST') return json(res, { ok: true });
  118 |       return json(res, { theme: 'dark', agentId: 'agent-test' });
  119 |     }
  120 | 
  121 |     if (url.pathname === '/channels') {
  122 |       return json(res, [{
  123 |         id: CHANNEL_ID,
  124 |         name: 'Loop UI Test',
  125 |         agentId: 'agent-test',
  126 |         did: 'did:test:loop-ui',
  127 |         createdAt: '2026-06-15T00:00:00.000Z',
  128 |         updatedAt: '2026-06-15T00:00:00.000Z',
  129 |         currentSessionId: 'default',
  130 |         sessions: [{ id: 'default', createdAt: '2026-06-15T00:00:00.000Z', messageCount: 0, preview: '默认会话' }],
  131 |       }]);
  132 |     }
  133 | 
  134 |     if (url.pathname.startsWith('/sessions/')) {
  135 |       if (req.method === 'PATCH') return json(res, { ok: true });
  136 |       return json(res, { channelId: CHANNEL_ID, sessionId: 'default', messages: [] });
  137 |     }
  138 | 
  139 |     if (url.pathname === '/message' && req.method === 'POST') {
  140 |       json(res, { ok: true, async: true, channelId: CHANNEL_ID, sessionId: 'default' }, 202);
  141 |       emitMockLoop(clients);
  142 |       return;
  143 |     }
  144 | 
  145 |     if (url.pathname === '/api/chat/abort') return json(res, { aborted: false });
  146 |     if (url.pathname === '/api/remote-channels') return json(res, { count: 0, peers: [] });
  147 |     if (url.pathname === '/api/p2p-peers') return json(res, { peers: [] });
  148 |     if (url.pathname === '/api/p2p-publickey') return json(res, { publicKey: '0'.repeat(64) });
  149 |     if (url.pathname === '/api/chat/process-pending') return json(res, { ok: true });
  150 |     if (url.pathname === '/self-improve/history') return json(res, { events: [] });
  151 |     if (url.pathname === '/judgments') return json(res, []);
  152 | 
  153 |     await serveStatic(res, url.pathname);
  154 |   });
  155 | 
  156 |   await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  157 |   const address = server.address();
  158 |   if (!address || typeof address === 'string') throw new Error('Failed to start mock server');
  159 |   return {
  160 |     port: address.port,
  161 |     close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  162 |   };
  163 | }
  164 | 
  165 | test('tool-call loop SSE events render, finalize, and hide timeline', async ({ page }) => {
  166 |   const server = await startMockWebServer();
  167 |   const consoleErrors: string[] = [];
  168 |   page.on('pageerror', (err) => consoleErrors.push(err.message));
  169 |   page.on('console', (msg) => {
  170 |     if (msg.type() === 'error') consoleErrors.push(msg.text());
  171 |   });
  172 | 
  173 |   try {
  174 |     await page.goto(`http://127.0.0.1:${server.port}/`);
  175 | 
  176 |     await expect(page.locator('#channel-name')).toHaveText('Loop UI Test');
  177 |     await expect(page.locator('.message-ai .bubble').filter({ hasText: '你好！我是 Bolloon Agent' })).toBeVisible();
  178 | 
  179 |     await page.locator('#input').fill('读取 README 并总结');
  180 |     await page.locator('#send').click();
  181 | 
  182 |     // 等待 stream event 到达 (750ms + buffer)
  183 |     await page.waitForSelector('.message-streaming', { timeout: 5000 });
  184 |     // 调试: 看 timeline 内部
  185 |     const timelineHtml = await page.evaluate(() => {
  186 |       const el = document.querySelector('.message-streaming [data-step-timeline]');
  187 |       return el ? el.innerHTML : 'no timeline';
  188 |     });
  189 |     console.log('=== TIMELINE HTML ===\n' + timelineHtml);
  190 | 
  191 |     await expect(page.locator('.message-streaming [data-step-timeline] .step-timeline-node[data-status="done"] .step-timeline-label'))
  192 |       .toHaveText('read_document');
  193 | 
  194 |     // finalize 后流式元素消失, 节点搬到正式 message 内
  195 |     await expect(page.locator('.message-streaming')).toHaveCount(0);
  196 |     await expect(page.locator('.message-ai .bubble').filter({ hasText: '这是最终回复。' })).toBeVisible();
  197 |     await expect(page.locator('.message-ai:last-of-type [data-step-timeline] .step-timeline-node[data-status="done"] .step-timeline-label'))
  198 |       .toHaveText('read_document');
  199 |     // 摘要条应显示已完成
  200 |     await expect(page.locator('.message-ai:last-of-type [data-step-timeline] [data-current-tool]'))
  201 |       .toHaveText('✓ 已完成 · 1 步');
  202 | 
> 203 |     expect(consoleErrors.filter((line) => !line.includes('favicon'))).toEqual([]);
      |                                                                       ^ Error: expect(received).toEqual(expected) // deep equality
  204 |   } finally {
  205 |     await server.close();
  206 |   }
  207 | });
  208 | 
```