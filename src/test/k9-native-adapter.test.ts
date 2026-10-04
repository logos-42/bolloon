/**
 * k9-native-adapter.test.ts — K9: **第二个 (非 Pi) 推理适配器** + 「过同一套门」的最小实证
 *
 * 这一条对应 K10 撤换判据里的「**出现第二个推理适配器能过同一套门**」——
 * 在那个判据成立之前, "Pi 可以被替换" 只是设计声明。
 *
 * 判据分两段:
 *   A. **机械**: 适配器源码**不许 import 任何 Pi 模块** (否则它只是"Pi 的壳", 不构成第二个适配器);
 *   B. **行为**: 用**本地 stub HTTP 服务**当端点 (不打真 LLM ⇒ 判据确定、秒级):
 *      ① 普通回复 + tokens 透出
 *      ② native `tool_calls` **原样**透出 (OpenAI 形状 —— pivot 读的是 `tc.function.name/arguments`)
 *      ③ 429 两次后 200 ⇒ 退避重试成功 (且 `stats().retries === 2`)
 *      ④ 调用方 abort ⇒ 原样抛出 (不当网络错去重试)
 *      ⑤ 4xx (非 429) ⇒ **不重试**, 直接响亮报出
 *      ⑥ **过同一套门**: 把适配器喂给**真 pivot loop** + K7 的受门执行端口
 *         ⇒ 适配器给的 tool_call 经端口执行**恰一次**; 端口拒绝 ⇒ **零执行**。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { createNativeAdapter } from '../llm/native-adapter.js';
import { WorkflowPivotLoop } from '../agents/workflow-pivot-loop.js';

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) { try { s.close(); (s as any).closeAllConnections?.(); } catch { /* */ } } });

/** 起一个 stub 端点: 按 `script` 队列逐个应答 (元素可以是对象或 {status}) */
async function startStub(script: any[]): Promise<{ base: string; bodies: any[] }> {
  const bodies: any[] = [];
  let i = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw || '{}')); } catch { bodies.push(raw); }
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step?.status && step.status !== 200) {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message || 'stub error' } }));
        return;
      }
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(step?.body ?? { choices: [{ message: { content: 'ok' } }] }));
      };
      // 允许脚本指定延迟: 用例④要靠它让 abort 有机会落在**请求进行中**
      if (step?.delayMs) setTimeout(send, step.delayMs); else send();
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, bodies };
}

const openaiReply = (content: string, extra: any = {}) => ({
  choices: [{ message: { role: 'assistant', content, ...extra } }],
  usage: { total_tokens: 42 },
});

describe('K9 A. 机械: 适配器不许是"Pi 的壳"', () => {
  it('源码里没有 Pi 的 import / getMinimax, 且真的实现了 chat', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/llm/native-adapter.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*pi-(ai|sdk)/);      // 不 import Pi
    expect(src).not.toMatch(/getMinimax\s*\(/);                 // 不借 Pi 的模型工厂
    expect(src).toMatch(/async chat\(/);                        // 真实现契约方法
    expect(src).toMatch(/chat\/completions/);                   // 直连 OpenAI 兼容端点
  });
});

describe('K9 B. 行为: 第二个适配器 (stub 端点, 不打真 LLM)', () => {
  it('① 普通回复 + tokens 透出', async () => {
    const { base } = await startStub([{ body: openaiReply('你好呀') }]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm' });
    const r = await a.chat('用户说你好', '你是助手');
    expect(r.reply).toBe('你好呀');
    expect(r.tokens).toBe(42);
    expect(r.toolCalls).toBeUndefined();
  });

  it('② native tool_calls 原样透出 (OpenAI 形状, pivot 依赖 tc.function.*)', async () => {
    const tc = [{ id: 'call_1', type: 'function', function: { name: 'probe_tool', arguments: '{"a":1}' } }];
    const { base } = await startStub([{ body: openaiReply('', { tool_calls: tc }) }]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm' });
    const r = await a.chat('做事', 'sys', undefined, [{ type: 'function', function: { name: 'probe_tool' } }]);
    expect(r.toolCalls).toEqual(tc);
    expect(r.toolCalls![0].function.name).toBe('probe_tool');
  });

  it('③ 429 两次后 200 ⇒ 退避重试成功 (retries=2)', async () => {
    const { base, bodies } = await startStub([
      { status: 429, message: 'rate limited' },
      { status: 429, message: 'rate limited' },
      { body: openaiReply('重试后成功') },
    ]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm' });
    const r = await a.chat('x', 'y');
    expect(r.reply).toBe('重试后成功');
    expect(a.stats().retries).toBe(2);
    expect(bodies.length).toBe(3);
  });

  it('④ 调用方 abort ⇒ 原样抛出 (不当网络错重试)', async () => {
    const { base } = await startStub([{ body: openaiReply('不该到这'), delayMs: 3000 }]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm', maxRetries: 3 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(a.chat('x', 'y', ac.signal)).rejects.toBeTruthy();
    expect(a.stats().retries, 'abort 不该触发重试').toBe(0);
  });

  it('⑤ 4xx (非 429) ⇒ 不重试, 直接报出', async () => {
    const { base, bodies } = await startStub([{ status: 400, message: 'bad request' }]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm' });
    await expect(a.chat('x', 'y')).rejects.toThrow(/HTTP 400/);
    expect(bodies.length).toBe(1);          // 只发一次
  });

  it('⑦ 出程净化工具名 (端点只收 ^[a-zA-Z0-9_-]{1,64}$) + 回程能还原', async () => {
    // 实测踩过: 原样转发 183 个工具时第 124 个名字不合规 ⇒ HTTP 400, 整轮空回复
    const { base, bodies } = await startStub([{ body: openaiReply('ok') }]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm' });
    const weird = { type: 'function', function: { name: 'bad name:with:illegal*chars', description: 'd', parameters: {} } };
    await a.chat('x', 'y', undefined, [weird]);
    const sent = bodies[0]?.tools?.[0]?.function?.name as string;
    expect(sent, '出程名字必须合规').toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // 回程: pivot 用 resolveApiToolName 还原 ⇒ 同一张全局路由表必须能映射回去
    const { resolveApiToolName } = await import('../llm/tool-name.js');
    expect(resolveApiToolName(sent), '回程必须还原成原名').toBe('bad name:with:illegal*chars');
  });

  it('⑥ 过同一套门: 适配器的 tool_call 经受门端口恰执行一次; 拒绝 ⇒ 零执行', async () => {
    const toolCall = [{ id: 'c1', type: 'function', function: { name: 'probe_tool', arguments: '{}' } }];
    // 第一轮: 适配器给 tool_call; 第二轮: 给最终回复 (带 <final gen> ⇒ 真 loop 立即收尾)
    const { base } = await startStub([
      { body: openaiReply('', { tool_calls: toolCall }) },
      { body: openaiReply('做完了 <final gen>') },
    ]);
    const a = createNativeAdapter({ baseUrl: base, apiKey: 'k', model: 'm' });

    let innerExecuted = 0;      // 工具**本身**被执行几次 (端口放行才会 +1)
    let portCalls = 0;
    const tool = {
      name: 'probe_tool',
      description: '探针',
      execute: async () => { innerExecuted += 1; return { success: true, output: 'INNER_OK' }; },
    };
    const mkLoop = (allow: boolean) => {
      // K7 的受门端口**从构造函数注入** (端口是 PivotLoopConfig 的一等成员)
      const loop = new WorkflowPivotLoop({
        maxIterations: 4, minIterations: 1, qualityThreshold: 0.1, maxConsecutiveNoProgress: 3, maxTokenBudget: 1e6,
        guardedExecute: async (t: any, args: any) => {
          portCalls += 1;
          if (!allow) return { success: false, error: '拒绝: [deny-list] 测试拒绝' };
          return t.execute(args);
        },
      } as any);
      loop.registerTools([tool as any]);
      return loop;
    };

    // 允许 ⇒ 门被问一次、工具恰执行一次
    const okLoop = mkLoop(true);
    const okRes: any = await okLoop.execute('跑一下探针', a as any, '你是助手');

    expect(portCalls, '适配器给的 tool_call 必须经端口').toBeGreaterThanOrEqual(1);
    expect(innerExecuted, '允许 ⇒ 恰执行一次').toBe(1);
    expect(String(okRes.response ?? '')).toContain('做完了');

    // 拒绝 ⇒ 端口被问, 但工具**零执行**
    //   ⚠️ 必须换一个**新 stub**: 上面的脚本只有两步, 已被允许路消费完 ⇒ 复用会让第二个请求落到
    //   "最终回复"那步 (压根没有工具调用), 于是端口 0 次 —— 踩过 (那不是产品问题, 是我夹具的问题)。
    const { base: base2 } = await startStub([
      { body: openaiReply('', { tool_calls: toolCall }) },
      { body: openaiReply('做完了 <final gen>') },
    ]);
    const a2 = createNativeAdapter({ baseUrl: base2, apiKey: 'k', model: 'm' });
    portCalls = 0;
    const denyLoop = mkLoop(false);
    await denyLoop.execute('再跑一次', a2 as any, '你是助手');
    expect(portCalls).toBeGreaterThanOrEqual(1);
    expect(innerExecuted, '拒绝 ⇒ 一次都不许执行').toBe(1);   // 仍是上面那次
  });
});
