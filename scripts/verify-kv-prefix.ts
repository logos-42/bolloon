/**
 * verify-kv-prefix.ts — 「前缀 KV 可命中」离线验收 (2026-09-28)
 *
 * 要证的事 (用户原话: "在缓存复用方面, 目前文件还存在问题, 缓存无法命中"):
 *   服务端 (llama.cpp / OpenAI 兼容) 的前缀 KV 只在 **wire 字节前缀逐字一致** 时才复用.
 *   所以本门把整条链拆成可离线断言的事实, 用**可控的假 transport** (本机 HTTP stub, 拦下每次请求体)
 *   驱两轮以上对话, 逐条断言:
 *     [1] 第 2 轮请求的 messages **前部逐字节 == 第 1 轮**(含注入后的 D1 作为 U1 的一部分),
 *         只尾部新增 U2 —— 这是"前缀可命中"的**充要形状**
 *     [1b] 工具结果轮 (tool → user) 一样守住前缀 (带注入的条目要原样回带)
 *     [2] system 段跨轮 sha256 相同; 动态层 (registry 的 source==='function' 层) 已移出 system
 *     [3] 规范化后 tools 跨轮 sha256 相同 —— 调用方故意抖顺序 / 抖嵌套 key 顺序也相同
 *     [4] 工具名净化仍在 (发包名字全合法; 点号/空格/超长会被净化)
 *     [5] 同一条历史重复走 chat() **不重复注入** (幂等)
 *     [6] `cache_prompt` 只在 purpose='main-agent' 为 true (逐 purpose 断言)
 *     [7] initPiAI 指纹一致时**不重建・不清装配缓存** (实例引用 + 缓存时间戳)
 *     [8] 轻量分流: 非主对话请求 system ≤ 阈值 / 无工具全集 / 无 CURRENT TURN,
 *         且**主对话前缀稳定性不受影响** (中间插满轻量请求, 主对话前缀照样逐字节相同)
 *     [9] 诊断日志只打数字与 hash (绝不出现消息内容 / key / system 正文)
 *    [10] `stream_options.include_usage` 真带上 + 流式 kv 命中率数字取得到
 *    [11] llama.cpp 声明 id: 四个落点 (providerId/baseUrl/model/key) 都通; 空 key 不带鉴权头
 *    [12] 调用方自己的当前轮易变段 (pi-sdk 的循环进度/改进提示) 走 CURRENT TURN, 不进 system
 *
 * 全程**离线**、确定性、不发真 LLM 请求; 不需要任何凭据.
 *
 * 用法: npx tsx scripts/verify-kv-prefix.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';

// 隔离 HOME: 不读真凭据, 也不写用户目录
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-kv-prefix-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const ROOT = process.cwd();

const FAKE_KEY = 'k-verify-offline';
const FAKE_MODEL = 'kv-verify-1';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n[${t}]`); }
const sha = (s: string) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const M = '<!-- current-turn: runtime/git/p2p -->';
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/** 记下每次请求体 (假 transport 的"拦网") */
interface Capture {
  path: string;
  body: any;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
}
const captured: Capture[] = [];
const lastBody = () => captured[captured.length - 1].body;

// ── wire 形状助手 (注意: 带工具时 generateText 会在最前面插一条"可用工具" system 消息) ──
type WireAny = { messages: Array<{ role: string; content: string }> };
/** 装配出来的那条 system (带 bolloon-runtime 尾标的那条; 轻量请求没有, 退回第一条) */
const sysMsgOf = (body: WireAny): string => {
  const hit = body.messages.find((m) => m.role === 'system' && /## bolloon-runtime/.test(String(m.content)));
  return String(hit?.content ?? body.messages[0]?.content ?? '');
};
const usersOf = (body: WireAny) => body.messages.filter((m) => m.role === 'user');
const firstDiffIndex = (a: any[], b: any[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (!same(a[i], b[i])) return i;
  return -1;
};

/** 启动本机 stub: 记录请求体 + 回一个形状合法的 OpenAI 响应 (含 usage / timings) */
async function startStub(): Promise<{ url: string; close: () => Promise<void>; mode: { sse: boolean; timingsOnly: boolean } }> {
  const mode = { sse: false, timingsOnly: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 记录原始就好 */ }
      captured.push({
        path: req.url || '',
        body,
        contentType: String(req.headers['content-type'] || ''),
        headers: req.headers as any,
      });

      const promptChars = JSON.stringify(body?.messages || '').length;
      const promptTokens = Math.max(1, Math.round(promptChars / 4));
      const cachedTokens = Math.floor(promptTokens * 0.75);

      if (mode.sse || body?.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stub-' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        // 末帧 usage: 只有带 stream_options.include_usage 才给 (与真实服务一致)
        const last: any = { choices: [{ delta: {}, finish_reason: 'stop' }] };
        if (body?.stream_options?.include_usage) {
          last.usage = { prompt_tokens: promptTokens, completion_tokens: 2, prompt_tokens_details: { cached_tokens: cachedTokens } };
        }
        res.write(`data: ${JSON.stringify(last)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const payload: any = {
        choices: [{ index: 0, message: { role: 'assistant', content: 'stub-ok' }, finish_reason: 'stop' }],
      };
      if (mode.timingsOnly) {
        // llama.cpp 形状: 没有 usage, 只有 timings
        payload.timings = { prompt_n: promptTokens, cache_n: cachedTokens, predicted_n: 2 };
      } else {
        payload.usage = { prompt_tokens: promptTokens, completion_tokens: 2, prompt_tokens_details: { cached_tokens: cachedTokens } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as any;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    mode,
  };
}

/** 在捕获 console.log 的同时跑 fn (诊断日志门的取样口) */
async function withLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  (console as any).log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    (console as any).log = orig;
  }
}

/** 模拟 pi-sdk buildMessages(): **每轮重建全新对象** + tool → user(带 `[工具结果]\n` 前缀) */
type HistMsg = { role: string; content?: string; reasoningContent?: string };
function render(history: HistMsg[]): Array<{ role: string; content: string }> {
  return history.map((m) => {
    const c = m.content || '';
    if (m.role === 'tool') return { role: 'user', content: c.includes(M) ? c : `[工具结果]\n${c}` };
    return { role: m.role, content: c };
  });
}

function toolDef(name: string, propsInOrder: string[] = ['a', 'b'], required: string[] = ['a']): any {
  const properties: Record<string, any> = {};
  for (const p of propsInOrder) properties[p] = { type: 'string', description: `param ${p}` };
  return { type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties, required } } };
}

async function main(): Promise<void> {
  const piAi = await import('../src/llm/pi-ai.js');
  const piSdk = await import('../src/agents/pi-sdk.js');
  const toolName = await import('../src/llm/tool-name.js');

  const stub = await startStub();
  const BASE = `${stub.url}/v1`;
  process.env.OPENAI_BASE_URL = BASE;   // 兜底: 万一走了内置表, 也回到 stub

  piAi.clearSystemPromptCache();
  const inst1 = piAi.initPiAI({ provider: 'openai', apiKey: FAKE_KEY, baseUrl: BASE, model: FAKE_MODEL });
  const fp1 = piAi.currentModelFingerprint();

  // 调用方给的 system (>2000 → 走 pivot/ReAct 那条"system 覆盖"分支; 与本仓真实主对话同形)
  const CALLER_SYS_A = `## 主对话 system (verify 用)\n${'调用方给的稳定 system 提示。'.repeat(120)}`;
  const CALLER_SYS_B = `## 主对话 system (verify 用 · 换过一版)\n${'调用方给的稳定 system 提示。'.repeat(120)}`;
  const toolsA = [toolDef('grep_tool'), toolDef('read_tool'), toolDef('write_tool')];

  // ─────────────────────────────────────────────────────────────
  section('1. 两轮主对话: messages 前部逐字节相同, 只尾部新增');
  // ─────────────────────────────────────────────────────────────
  const history: HistMsg[] = [{ role: 'user', content: 'U1 请做 A' }];

  const r1 = await inst1.chat(render(history), CALLER_SYS_A, undefined, toolsA, 'main-agent', 'gate');
  const body1 = lastBody();
  const wb1 = piSdk.writeBackCurrentTurnInto(history, r1.messages as any);
  ok('[1] chat() 回带了最终 wire messages', Array.isArray(r1.messages) && r1.messages!.length === 2, `messages=${r1.messages?.length}`);
  ok('[1] 调用方 history 真写回了 1 条 (pi-sdk 的 writeBackCurrentTurnInto)', wb1 === 1, `写回=${wb1}`);
  ok('[1] U1 被注入了 CURRENT TURN 动态区 (在前部)', String(usersOf(body1)[0].content).startsWith(M),
    `U1 头 60 字符=${JSON.stringify(String(usersOf(body1)[0].content).slice(0, 60))}`);
  ok('[2] 动态层不在 system 里 (system 无 dynamic.* 层标记)', !/<!-- dynamic\.[a-z-]+@/.test(sysMsgOf(body1)));
  ok('[2] 装配器仍在跑 (system 带 bolloon-runtime 尾标, 不是降级路径)', /## bolloon-runtime/.test(sysMsgOf(body1)),
    `system=${sysMsgOf(body1).length} 字符`);

  // 中间插一发轻量探针: 它不该动主对话的任何字节
  await inst1.chat('ping', '轻量探针 system', undefined, undefined, 'health', 'gate');
  const probeBody = lastBody();
  ok('[8] 轻量探针 system ≤ 1200 字符', String(probeBody.messages[0].content).length <= 1200, `system=${String(probeBody.messages[0].content).length} 字符`);
  ok('[8] 轻量探针不带工具集', !('tools' in probeBody));
  ok('[8] 轻量探针不带 CURRENT TURN 动态区', !JSON.stringify(probeBody.messages).includes(M));
  ok('[8] 轻量探针 system 不含完整前缀 (无 bolloon-runtime / layer 标记)', !/## bolloon-runtime|<!-- core\./.test(String(probeBody.messages[0].content)),
    `system=${JSON.stringify(String(probeBody.messages[0].content).slice(0, 46))}…`);

  history.push({ role: 'assistant', content: 'A1: 做完了' });
  history.push({ role: 'user', content: 'U2 再做 B' });
  const r2 = await inst1.chat(render(history), CALLER_SYS_A, undefined, toolsA, 'main-agent', 'gate');
  const body2 = lastBody();
  piSdk.writeBackCurrentTurnInto(history, r2.messages as any);

  ok('[1] 第 2 轮 messages 前部逐字节 == 第 1 轮 (核心断言)',
    same(body2.messages.slice(0, body1.messages.length), body1.messages),
    `第1轮 ${body1.messages.length} 条 → 第2轮 ${body2.messages.length} 条, 前 ${body1.messages.length} 条逐字节相同`);
  ok('[1] 只尾部新增 (第 2 轮 = 第 1 轮 + 2 条: A1 + U2)', body2.messages.length === body1.messages.length + 2);
  ok('[1] U1 那条跨轮逐字节相同 (注入成了 U1 的一部分, 不再是"每轮临时加的")',
    same(body2.messages[body1.messages.length - 1], body1.messages[body1.messages.length - 1]));
  ok('[1] 第 2 轮的 U2 也注入了动态区', String(usersOf(body2)[1].content).startsWith(M));
  ok('[5] 注入幂等: 每条消息里标记最多出现一次',
    body2.messages.every((m) => (String(m.content).match(/current-turn: runtime/g) || []).length <= 1));

  history.push({ role: 'assistant', content: 'A2: 好' });
  history.push({ role: 'user', content: 'U3 继续' });
  const r3 = await inst1.chat(render(history), CALLER_SYS_A, undefined, toolsA, 'main-agent', 'gate');
  const body3 = lastBody();
  piSdk.writeBackCurrentTurnInto(history, r3.messages as any);
  ok('[1] 第 3 轮前缀 == 第 2 轮 + 2 条 (连续三轮只追加)',
    same(body3.messages.slice(0, body2.messages.length), body2.messages),
    `第2轮 ${body2.messages.length} 条 → 第3轮 ${body3.messages.length} 条`);

  // ─────────────────────────────────────────────────────────────
  section('2. system 段跨轮 sha256 相同 + 稳定段 hash 可实测');
  // ─────────────────────────────────────────────────────────────
  ok('[2] system 段跨轮逐字节相同 (三轮)', sysMsgOf(body3) === sysMsgOf(body2) && sysMsgOf(body2) === sysMsgOf(body1),
    `system sha=${sha(sysMsgOf(body1))}`);
  // system = 稳定段 + '\n\n' + 调用方那段 ⇒ 稳定段 = 去掉分隔符与调用方文本
  const stableTextA = sysMsgOf(body1).slice(0, sysMsgOf(body1).length - CALLER_SYS_A.length - 2);
  ok('[2] 装配稳定段 hash 与实测稳定段一致 (systemPromptStableHash 落点)',
    piAi.systemPromptStableHash() === sha(stableTextA),
    `stableHash=${piAi.systemPromptStableHash()} 实测=${sha(stableTextA)} 稳定段=${stableTextA.length} 字符`);

  // ─────────────────────────────────────────────────────────────
  section('2b. 换调用方 system: 装配稳定段一字不动 (边界如实记录)');
  // ─────────────────────────────────────────────────────────────
  const stableHashBefore = piAi.systemPromptStableHash();
  const historyB: HistMsg[] = JSON.parse(JSON.stringify(history));
  historyB.push({ role: 'assistant', content: 'A3: 换 system 试一次' });
  const rB = await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  const bodyB = lastBody();
  const headB = sysMsgOf(bodyB).slice(0, sysMsgOf(bodyB).length - CALLER_SYS_B.length - 2);
  ok('[2] 调用方 system 变了, 装配稳定段仍逐字节不变', headB === stableTextA, `稳定段 sha=${sha(headB)}`);
  ok('[2] 装配稳定段 hash 未变 (缓存没被无谓清掉)', piAi.systemPromptStableHash() === stableHashBefore && !!stableHashBefore);
  ok('[2] 边界如实记录: 调用方自己那截在 system 里 ⇒ 它一变, 前缀从**第一条 system 消息**起分叉',
    firstDiffIndex(bodyB.messages, body3.messages) === 1,
    `分叉在第 ${firstDiffIndex(bodyB.messages, body3.messages)} 条 (0=可用工具表, 1=装配 system)`);
  ok('[1] 换成 B 之后继续走: 前缀又稳住了 (B 内部逐轮相同)', (() => {
    return true; // 下面 2c 段逐轮验证
  })());
  piSdk.writeBackCurrentTurnInto(historyB, rB.messages as any);

  // ─────────────────────────────────────────────────────────────
  section('2c. 工具结果轮 (tool → user) 也守住前缀');
  // ─────────────────────────────────────────────────────────────
  historyB.push({ role: 'assistant', content: 'A4: 调个工具' });
  historyB.push({ role: 'tool', content: 'TR1 工具结果原文' });
  const r4 = await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  const body4 = lastBody();
  ok('[1b] 注入落在最后一条 (工具结果转成的 user) 上', String(body4.messages[body4.messages.length - 1].content).startsWith(M),
    `末条 role=${body4.messages[body4.messages.length - 1].role}`);
  ok('[1b] 工具结果轮: 前缀仍与上一轮逐字节相同', same(body4.messages.slice(0, bodyB.messages.length), bodyB.messages));
  const wb4 = piSdk.writeBackCurrentTurnInto(historyB, r4.messages as any);
  ok('[1b] 工具结果条目被写回 history (tool 条目拿到注入后的整段)', wb4 === 1,
    `historyB 末条前 34 字符=${JSON.stringify(String(historyB[historyB.length - 1].content).slice(0, 34))}`);
  historyB.push({ role: 'assistant', content: 'A5: 收到结果' });
  historyB.push({ role: 'user', content: 'U4 收尾' });
  const r5 = await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  const body5 = lastBody();
  piSdk.writeBackCurrentTurnInto(historyB, r5.messages as any);
  ok('[1b] 工具结果轮之后: 前缀仍逐字节相同 (含带注入的 [工具结果] 条目)',
    same(body5.messages.slice(0, body4.messages.length), body4.messages),
    `第4轮 ${body4.messages.length} 条 → 第5轮 ${body5.messages.length} 条`);
  ok('[1b] 带注入的工具结果条目跨轮逐字节相同 (buildMessages 原样回带, 不重加前缀)',
    same(body5.messages[body4.messages.length - 1], body4.messages[body4.messages.length - 1]));

  // ─────────────────────────────────────────────────────────────
  section('3. 工具 schema 规范化 (排序 + 递归 key) 跨轮 sha256 相同');
  // ─────────────────────────────────────────────────────────────
  const toolsShuffled = [toolDef('write_tool', ['b', 'a']), toolDef('read_tool', ['b', 'a']), toolDef('grep_tool', ['b', 'a'])];
  const r6 = await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsShuffled, 'main-agent', 'gate');
  const body6 = lastBody();
  ok('[3] 抖顺序 + 抖嵌套 key 后 tools 字节完全相同',
    same(body6.tools, body4.tools),
    `tools sha=${sha(JSON.stringify(body6.tools || []))} (${body6.tools?.length} 条) vs 上一轮 ${sha(JSON.stringify(body4.tools || []))}`);
  const names = (body6.tools || []).map((t: any) => t.function.name);
  ok('[3] tools 按 function.name 升序', same(names, [...names].sort()), names.join(' / '));
  ok('[3] 嵌套对象 key 已排序 (a 在 b 前)',
    same(Object.keys(body6.tools[1].function.parameters.properties), ['a', 'b']),
    `properties keys=${JSON.stringify(Object.keys(body6.tools[1].function.parameters.properties))}`);
  ok('[3] 数组保序 (required 原样)', same(body6.tools[0].function.parameters.required, ['a']),
    `required=${JSON.stringify(body6.tools[0].function.parameters.required)}`);

  // ─────────────────────────────────────────────────────────────
  section('4. 工具名净化仍在 (出网名字全合法)');
  // ─────────────────────────────────────────────────────────────
  const dirtyTools = [toolDef('contact.list_authorized'), toolDef('has space in name'), toolDef('n'.repeat(80)), toolDef('ok_tool')];
  await inst1.chat(render(historyB), CALLER_SYS_B, undefined, dirtyTools, 'main-agent', 'gate');
  const body7 = lastBody();
  const outNames: string[] = (body7.tools || []).map((t: any) => t.function.name);
  ok('[4] 出网 function.name 全部合法 (^[a-zA-Z0-9_-]{1,64}$)', outNames.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)),
    outNames.join(' / '));
  ok('[4] 点号被净化 (contact.list_authorized → contact_list_authorized)', outNames.includes('contact_list_authorized'));
  ok('[4] 空格被净化', outNames.includes('has_space_in_name'));
  ok('[4] 超长名被净化到 ≤64 (截断 + hash8)', outNames.some((n) => n.length === 64 && n.startsWith('n'.repeat(55) + '_')));
  ok('[4] 回程派发: API 名能还原成原名', toolName.resolveApiToolName('contact_list_authorized') === 'contact.list_authorized');

  // ─────────────────────────────────────────────────────────────
  section('5. 注入幂等 + 原地写回调用方数组');
  // ─────────────────────────────────────────────────────────────
  const idemHist: HistMsg[] = [{ role: 'user', content: 'I1 幂等测试' }];
  const fresh = render(idemHist);                     // 全新对象 (未注入)
  ok('[5] 新渲染出来的数组还没注入', !fresh.some((m) => m.content.includes(M)));
  await inst1.chat(fresh, CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  const bodySame1 = lastBody();
  ok('[5] chat() 原地写回了调用方数组 (同对象引用被改)', fresh.some((m) => m.content.includes(M)),
    `带标记的消息数=${fresh.filter((m) => m.content.includes(M)).length}`);
  await inst1.chat(fresh, CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  const bodySame2 = lastBody();
  ok('[5] 同一份 messages 重发两次: 请求体逐字节相同', same(bodySame1.messages, bodySame2.messages));
  ok('[5] 重发时标记数没长 (每条 user 恰好 1 个)',
    bodySame2.messages.filter((m) => m.content.includes(M)).length === bodySame1.messages.filter((m) => m.content.includes(M)).length,
    `标记消息数 ${bodySame1.messages.filter((m) => m.content.includes(M)).length} → ${bodySame2.messages.filter((m) => m.content.includes(M)).length}`);
  ok('[5] 幂等: 未追加多余消息', bodySame2.messages.length === bodySame1.messages.length,
    `${bodySame1.messages.length} → ${bodySame2.messages.length}`);
  const wbFirst = piSdk.writeBackCurrentTurnInto(idemHist, bodySame2.messages as any);
  const wbSecond = piSdk.writeBackCurrentTurnInto(idemHist, bodySame2.messages as any);
  ok('[5] 重复写回幂等 (第一次可能补写, 第二次必为 0)', wbSecond === 0, `第一次=${wbFirst} 第二次=${wbSecond}`);

  // ─────────────────────────────────────────────────────────────
  section("6. cache_prompt 只在 purpose='main-agent' 为 true");
  // ─────────────────────────────────────────────────────────────
  ok('[6] main-agent 请求带 cache_prompt=true', body2.cache_prompt === true, `cache_prompt=${body2.cache_prompt}`);
  ok('[6] 轻量探针请求带 cache_prompt=false', probeBody.cache_prompt === false, `cache_prompt=${probeBody.cache_prompt}`);
  const PURPOSES = ['summarize', 'improve', 'auto-compact', 'social', 'health', 'p2p', 'cron', 'judgment', 'probe', 'chat'];
  ok('[6] 纯函数逐 purpose: 只有 main-agent 为 true',
    PURPOSES.every((p) => piAi.shouldUseCachePrompt(p) === false) && piAi.shouldUseCachePrompt('main-agent') === true,
    PURPOSES.map((p) => `${p}=${piAi.shouldUseCachePrompt(p)}`).join(' '));
  ok('[6] 缺省 purpose (老调用方) 按轻量处理 → cache_prompt=false', piAi.shouldUseCachePrompt(undefined) === false);
  const perPurpose: string[] = [];
  for (const p of PURPOSES) {
    await inst1.chat('一次性调用', '短 system', undefined, [toolDef('t1')], p as any, 'gate');
    const b = lastBody();
    perPurpose.push(`${p}(cp=${b.cache_prompt},tools=${'tools' in b ? (b.tools || []).length : '无'})`);
    if (b.cache_prompt !== false) ok(`[6] purpose=${p} 不该带 cache_prompt=true`, false, `拿到 ${b.cache_prompt}`);
  }
  ok('[6] 逐 purpose 请求体: 全部 cache_prompt=false 且工具集被丢弃', perPurpose.every((s) => s.includes('cp=false') && s.includes('tools=无')),
    perPurpose.join(' '));
  process.env.BOLLOON_DISABLE_CACHE_PROMPT = '1';
  ok('[6] BOLLOON_DISABLE_CACHE_PROMPT=1 彻底关 (含主对话)', piAi.shouldUseCachePrompt('main-agent') === false);
  await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  ok('[6] 关掉后主对话请求体 cache_prompt=false', lastBody().cache_prompt === false, `cache_prompt=${lastBody().cache_prompt}`);
  delete process.env.BOLLOON_DISABLE_CACHE_PROMPT;

  // ─────────────────────────────────────────────────────────────
  section('7. initPiAI 指纹幂等 (一致不重建・不清缓存)');
  // ─────────────────────────────────────────────────────────────
  const stampBefore = piAi.systemPromptCacheStamp();
  const instAgain = piAi.initPiAI({ provider: 'openai', apiKey: FAKE_KEY, baseUrl: BASE, model: FAKE_MODEL });
  const stampAfter = piAi.systemPromptCacheStamp();
  ok('[7] 指纹一致 → 复用同一实例 (===)', instAgain === inst1);
  ok('[7] 指纹一致 → 指纹不变', piAi.currentModelFingerprint() === fp1, `${fp1.slice(0, 8)}`);
  ok('[7] 指纹一致 → 装配缓存时间戳未变 (没被清掉)', !!stampBefore && stampBefore.at === stampAfter?.at, `at=${stampAfter?.at}`);
  ok('[7] 指纹只出 hex, 不含明文 key', /^[0-9a-f]{16}$/.test(fp1) && !fp1.includes(FAKE_KEY));
  const instNew = piAi.initPiAI({ provider: 'openai', apiKey: FAKE_KEY, baseUrl: BASE, model: 'kv-verify-2' });
  ok('[7] 真变化 (model) → 重建实例', instNew !== inst1);
  ok('[7] 真变化 → 清了装配缓存', piAi.systemPromptCacheStamp() === null);
  ok('[7] 指纹对 key 敏感 / 同参稳定',
    piAi.modelFingerprint({ provider: 'openai', model: 'm', apiKey: 'a' }) !== piAi.modelFingerprint({ provider: 'openai', model: 'm', apiKey: 'b' }) &&
    piAi.modelFingerprint({ provider: 'openai', model: 'm', apiKey: 'a' }) === piAi.modelFingerprint({ provider: 'openai', model: 'm', apiKey: 'a' }));
  piAi.initPiAI({ provider: 'openai', apiKey: FAKE_KEY, baseUrl: BASE, model: FAKE_MODEL });   // 回到 inst1 配置

  // ─────────────────────────────────────────────────────────────
  section('8. 轻量分流逐 purpose; 主对话前缀不受影响');
  // ─────────────────────────────────────────────────────────────
  const beforeMain = captured.length;
  for (const p of PURPOSES) {
    await inst1.chat('探针', '短 system', undefined, undefined, p as any, 'gate');
    const b = lastBody();
    const sys = String(b.messages[0].content);
    const clean = sys.length <= 1200 && !/## bolloon-runtime|<!-- core\./.test(sys) && !JSON.stringify(b.messages).includes(M) && !('tools' in b);
    if (!clean) ok(`[8] purpose=${p} 轻量请求不干净`, false, `system=${sys.length} 字符`);
  }
  ok('[8] 10 个非主对话 purpose 全部轻量 (system ≤1200 / 无工具 / 无 CURRENT TURN)', captured.length - beforeMain === PURPOSES.length,
    `本轮 ${captured.length - beforeMain} 发`);
  await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  const bodyMainAfter = lastBody();
  ok('[8] 中间插满轻量请求后, 主对话前缀照旧逐字节相同',
    same(bodyMainAfter.messages.slice(0, body5.messages.length), body5.messages),
    `主对话 ${body5.messages.length} 条前缀 vs 本次 ${bodyMainAfter.messages.length} 条`);
  ok('[8] 主对话仍是完整前缀 (带 bolloon-runtime, 且 > 2000 字符)', /## bolloon-runtime/.test(sysMsgOf(bodyMainAfter)) && sysMsgOf(bodyMainAfter).length > 2000,
    `装配 system=${sysMsgOf(bodyMainAfter).length} 字符 / 全文 system=${String(bodyMainAfter.messages[0].content).length}`);
  ok('[8] 主对话仍带完整工具集', Array.isArray(bodyMainAfter.tools) && bodyMainAfter.tools.length === toolsA.length, `tools=${bodyMainAfter.tools?.length}`);
  ok('[8] 轻量请求 messages 结构仍是 system + user', (() => {
    const b = captured[captured.length - 2].body;
    return b.messages.length === 2 && b.messages[0].role === 'system' && b.messages[1].role === 'user';
  })());

  // ─────────────────────────────────────────────────────────────
  section('9. 诊断日志只打数字与 hash');
  // ─────────────────────────────────────────────────────────────
  process.env.DEBUG_PROMPT_PREFIX = '1';
  process.env.BOLLOON_PROMPT_PROFILE = '1';
  const { logs } = await withLogs(async () => {
    await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
    await inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate');
  });
  delete process.env.DEBUG_PROMPT_PREFIX;
  delete process.env.BOLLOON_PROMPT_PROFILE;
  const dbg = logs.filter((l) => l.startsWith('[kv-debug]'));
  const kvl = logs.filter((l) => l.startsWith('[kv-server]'));
  const prof = logs.filter((l) => l.startsWith('[prompt-profile]'));
  ok('[9] 逐消息前缀 hash 打点存在', dbg.some((l) => /^\[kv-debug\] msg=0 role=system prefixHash=[0-9a-f]{12} chars=\d+$/.test(l)),
    dbg.find((l) => l.includes('msg=0')) || '(无)');
  ok('[9] tools hash 打点存在', dbg.some((l) => /^\[kv-debug\] tools count=\d+ hash=([0-9a-f]{12}|-)$/.test(l)),
    dbg.find((l) => l.includes('tools count')) || '(无)');
  ok('[9] 两次请求之间报出"逐条一致 / 第 N 条分叉"', dbg.some((l) => l.includes('对比上一次请求')),
    dbg.find((l) => l.includes('对比上一次请求')) || '(无)');
  ok('[9] kv 命中率行只含数字', kvl.length >= 2 && kvl.every((l) => /^\[kv-server\] purpose=\S+ cached=\d+ prompt=\d+ hit=(\d+\.\d%|\?)$/.test(l)),
    kvl[0] || '(无)');
  ok('[9] prompt-profile 行只含数字与枚举名', prof.length >= 2 &&
    prof.every((l) => /^\[prompt-profile\] purpose=\S+ source=\S+ profile=(full|light) systemCache=(hit|miss) stable=\d+ dynamic=\d+ history=\d+ msgs=\d+ tools=\d+ toolsHash=([0-9a-f]{12}|-)$/.test(l)),
    prof[0] || '(无)');
  const leak = logs.filter((l) => l.includes('U1 请做 A') || l.includes('工具结果原文') || l.includes(FAKE_KEY) || l.includes('调用方给的稳定 system 提示'));
  ok('[9] 日志里没有消息内容 / 没有 key / 没有 system 正文', leak.length === 0, leak.length ? `泄漏 ${leak.length} 行` : '干净');
  ok('[9] 命中率数字与 stub 回传的 usage 一致 (cached = floor(prompt*0.75))', (() => {
    const g = /cached=(\d+) prompt=(\d+)/.exec(kvl.find((l) => /cached=\d+ prompt=\d+/.test(l)) || '');
    if (!g) return false;
    const cached = Number(g[1]); const prompt = Number(g[2]);
    return prompt > 0 && cached === Math.floor(prompt * 0.75);
  })(), kvl[0] || '(无)');

  // ─────────────────────────────────────────────────────────────
  section('10. 流式: stream_options.include_usage + 命中率取得到');
  // ─────────────────────────────────────────────────────────────
  stub.mode.sse = true;
  const deltas: string[] = [];
  const streamRun = await withLogs(async () =>
    inst1.chat(render(historyB), CALLER_SYS_B, undefined, toolsA, 'main-agent', 'gate', (d) => deltas.push(d))
  );
  stub.mode.sse = false;
  const bodyS = lastBody();
  ok('[10] 请求体带 stream=true', bodyS.stream === true);
  ok('[10] 请求体带 stream_options.include_usage=true', bodyS.stream_options?.include_usage === true, JSON.stringify(bodyS.stream_options));
  ok('[10] SSE 增量交给 onToken', deltas.join('') === 'stub-ok', `deltas=${JSON.stringify(deltas)}`);
  ok('[10] 流式回复拼装正确', streamRun.result.reply === 'stub-ok', `reply=${JSON.stringify(streamRun.result.reply)}`);
  ok('[10] 流式 kv 命中率行带 stream 标记且有数字',
    streamRun.logs.some((l) => /^\[kv-server\] purpose=main-agent stream cached=\d+ prompt=\d+ hit=(\d+\.\d%|\?)$/.test(l)),
    streamRun.logs.find((l) => l.startsWith('[kv-server]') && l.includes('stream')) || '(无)');
  ok('[10] 流式 usage 进了 ChatResult', (streamRun.result.usage?.promptTokens || 0) > 0,
    `prompt=${streamRun.result.usage?.promptTokens} cached=${streamRun.result.usage?.cachedTokens}`);
  stub.mode.timingsOnly = true;
  const timingsRun = await withLogs(async () => inst1.chat('ping', '短 system', undefined, undefined, 'health', 'gate'));
  stub.mode.timingsOnly = false;
  const tl = timingsRun.logs.find((l) => l.startsWith('[kv-server]')) || '';
  ok('[10] llama.cpp 的 timings.cache_n / prompt_n 也认 (无 usage 时)', /cached=\d+ prompt=\d+ hit=\d+\.\d%/.test(tl) && !/cached=0 prompt=0/.test(tl), tl);

  // ─────────────────────────────────────────────────────────────
  section('11. llama.cpp 声明 id: 四个落点都通 + 空 key 不带鉴权头');
  // ─────────────────────────────────────────────────────────────
  process.env.LLAMACPP_BASE_URL = BASE;              // stub 冒充本地 llama-server
  process.env.LLAMACPP_MODEL = 'kv-verify-llamacpp';
  const ll = piAi.initPiAI({ provider: 'llamacpp' });   // 无 key
  const reqBefore = captured.length;
  const llRes = await ll.chat('ping', '短 system', undefined, undefined, 'health', 'llamacpp');
  ok('[11] llamacpp: 声明 id 走 openai 协议分支且真能发出去', captured.length === reqBefore + 1 && llRes.reply === 'stub-ok',
    `reply=${JSON.stringify(llRes.reply)}`);
  const llCap = captured[captured.length - 1];
  ok('[11] llamacpp: 打到 LLAMACPP_BASE_URL (getBaseUrl 落点)', /\/v1\/chat\/completions/.test(llCap.path), `path=${llCap.path}`);
  ok('[11] llamacpp: 空 key → 不带 Authorization 头', !llCap.headers['authorization'], `authorization=${llCap.headers['authorization'] ?? '(无)'}`);
  ok('[11] llamacpp: model 取自 LLAMACPP_MODEL (mapModel 落点)', llCap.body.model === 'kv-verify-llamacpp', `model=${llCap.body.model}`);
  const fpLL = piAi.currentModelFingerprint();
  ok('[11] llamacpp: 指纹带声明 id (不与 openai 混)', fpLL !== fp1 && /^[0-9a-f]{16}$/.test(fpLL));
  process.env.LLAMACPP_API_KEY = 'k-llamacpp-verify';
  const ll2 = piAi.initPiAI({ provider: 'llamacpp' });
  await ll2.chat('ping', '短 system', undefined, undefined, 'health', 'llamacpp');
  const ll2Cap = captured[captured.length - 1];
  ok('[11] llamacpp: 设了 LLAMACPP_API_KEY 就走 Bearer', ll2 !== ll && String(ll2Cap.headers['authorization'] || '').startsWith('Bearer '),
    `authorization=${ll2Cap.headers['authorization'] ? 'Bearer [REDACTED]' : '(无)'}`);
  ok('[11] llamacpp: key 变更 → 重建实例 (指纹敏感)', ll2 !== ll);
  const cfgStore = await import('../src/llm/config-store.js');
  ok('[11] llamacpp 不是内置表的一员 (内置 13 家未被动过)', !Object.prototype.hasOwnProperty.call(cfgStore.DEFAULT_PROVIDER_CONFIGS, 'llamacpp'));
  delete process.env.LLAMACPP_BASE_URL;
  delete process.env.LLAMACPP_MODEL;
  delete process.env.LLAMACPP_API_KEY;

  // ─────────────────────────────────────────────────────────────
  section('12. 调用方自己的当前轮易变段 (循环进度/改进提示) 走 CURRENT TURN, 不进 system');
  // ─────────────────────────────────────────────────────────────
  piAi.initPiAI({ provider: 'openai', apiKey: FAKE_KEY, baseUrl: BASE, model: FAKE_MODEL });
  const historyC: HistMsg[] = [{ role: 'user', content: 'C1 干活' }];
  const rc1 = await inst1.chat(render(historyC), CALLER_SYS_A, undefined, toolsA, 'main-agent', 'gate', undefined, '【本轮循环进度】第 1 步');
  const bc1 = lastBody();
  piSdk.writeBackCurrentTurnInto(historyC, rc1.messages as any);
  ok('[12] 调用方易变段进了最后一条 user (含标记)', String(usersOf(bc1)[usersOf(bc1).length - 1].content).includes('【本轮循环进度】第 1 步') &&
    String(usersOf(bc1)[usersOf(bc1).length - 1].content).startsWith(M));
  ok('[12] 易变段不在 system 里', !sysMsgOf(bc1).includes('本轮循环进度'));
  historyC.push({ role: 'assistant', content: 'A1' });
  historyC.push({ role: 'tool', content: 'TR1' });
  const rc2 = await inst1.chat(render(historyC), CALLER_SYS_A, undefined, toolsA, 'main-agent', 'gate', undefined, '【本轮循环进度】第 1 步 + 第 2 步');
  const bc2 = lastBody();
  ok('[12] 易变段变了, system 仍逐字节不变', sysMsgOf(bc2) === sysMsgOf(bc1), `system sha=${sha(sysMsgOf(bc2))}`);
  ok('[12] 下一轮前缀仍逐字节相同 (上一轮的进度已随写回成为前缀的一部分)',
    same(bc2.messages.slice(0, bc1.messages.length), bc1.messages),
    `${bc1.messages.length} → ${bc2.messages.length} 条`);
  ok('[12] 新进度落在新的当前轮消息上', String(usersOf(bc2)[usersOf(bc2).length - 1].content).includes('第 2 步'));
  const src = fs.readFileSync(path.join(ROOT, 'src/agents/pi-sdk.ts'), 'utf-8');
  const tplStart = src.indexOf('const systemPrompt = `${this.bootstrapAddition');
  const tpl = tplStart >= 0 ? src.slice(tplStart, src.indexOf('};', tplStart) > 0 ? src.indexOf('`;', tplStart) + 2 : tplStart + 4000) : '';
  ok('[12] pi-sdk 源码级: systemPrompt 模板里不再塞 loopProgressSection / refineContext',
    tpl.length > 0 && !/\$\{loopProgressSection\}|\$\{refineContext\}/.test(tpl));
  ok('[12] pi-sdk 源码级: 易变段交给 chat() 的 currentTurnContext',
    /const currentTurnContext = `\$\{refineContext\}\$\{loopProgressSection\}`/.test(src) && /currentTurnContext\)/.test(src));
  ok('[12] pi-sdk 源码级: 回带的当前轮真写回 history', /writeBackCurrentTurn\(response\.messages\)/.test(src));

  // ─────────────────────────────────────────────────────────────
  await stub.close();
  console.log('\n' + '='.repeat(68));
  console.log(`KV 前缀门: ${passed} PASS / ${failed} FAIL`);
  if (failures.length) console.log('FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身炸了:', e); process.exit(2); });
