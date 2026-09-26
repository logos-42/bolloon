/**
 * verify-tool-names.ts — 「工具名出网净化 + 回程派发」真跑验收 (2026-09-26)
 *
 * 对应真 bug: 第 121 个工具的名字含非法字符 ⇒ 整个请求 400:
 *   Invalid 'tools[120].function.name': string does not match pattern.
 *   Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
 * 表现 = 「网页端明明配好了 API, 一跑就失败」—— 根因在发包形状, 不在凭据.
 *
 * 本脚本做四件事 (前四件离线且确定性; 第五件要真凭据, 默认关):
 *   [1] **探针**: 装配**真实工具注册表**, 逐个 function.name 对照
 *       /^[a-zA-Z0-9_-]{1,64}$/ 校验 → 打印总数 / 违规名单 (名字 + 来源 + 违规字符 + 序号)
 *   [2] 断言: 全部注册工具名净化后合法, 且「原名 → API 名 → 原名」往返一致
 *   [3] **派发证明**: 拿一个"名字被改写过、原名叫不出来"的真工具, 只用净化后的名字
 *       (LLM 回吐的形状) 真调一次 → 必须跑到正确实现 (真 execute(), 真返回值)
 *   [4] **没有第二条发包路径** (源码级): wire 形状 tools 数组只有两处产出, 都经
 *       llm.chat(..., tools) → pi-ai.ts generateText() 的唯一边界; HTTP 请求体里挂 tools
 *       全仓只有一处
 *   [5] (可选) 真发一次带完整工具面的请求 —— 需 `BOLLOON_TOOLNAMES_LIVE=1`, 用真凭据,
 *       单次调用, 最便宜的模型; 进程里绝不打印 key (报告写 [REDACTED])
 *
 * 用法: npx tsx scripts/verify-tool-names.ts
 *      BOLLOON_TOOLNAMES_LIVE=1 npx tsx scripts/verify-tool-names.ts   # 多一次真 LLM 调用
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 隔离 HOME: 不给真 HOME, 也不碰真凭据 (第 [5] 段自己读真配置, 且只读不打印)
// 真 HOME 先记下来 —— 第 [5] 段要按真路径读 llm-config.json (只读, 值不进日志)
const REAL_HOME = process.env.HOME || os.homedir();
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-tool-names-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const ROOT = process.cwd();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n[${t}]`); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function illegalChars(name: string): string[] {
  const out: string[] = [];
  for (const ch of name) if (!/[a-zA-Z0-9_-]/.test(ch) && !out.includes(ch)) out.push(ch);
  return out;
}

async function main(): Promise<void> {
  const { registerBuiltinTools, registerWalletTools } = await import('../src/agents/pi-sdk-tools.js');
  const { registerContactTools } = await import('../src/agents/contacts/tools.js');
  const { ContactChain } = await import('../src/agents/contacts/chain.js');
  const { sanitizeToolName, sanitizeToolsForApi, resolveApiToolName, ToolNameRouteTable, TOOL_NAME_PATTERN } =
    await import('../src/llm/tool-name.js');

  // ─────────────────────────────────────────────────────────────
  // [1] 装配真实工具注册表 + 探针
  // ─────────────────────────────────────────────────────────────
  section('1. 真实工具注册表枚举 (探针)');

  const tools = new Map<string, any>();
  const sources = new Map<string, string>();
  const mark = (src: string) => { for (const k of tools.keys()) if (!sources.has(k)) sources.set(k, src); };

  const ctx: any = {
    tools,
    cwd: HOME,
    identity: { did: 'did:bolln:tool-name-verify', name: 'tool-name-verify' },
    persona: null,
    minimaxAvailable: false,
    setPersona: async () => {},
    sessionManager: { addFileContext: () => {}, getAllChannels: () => [] },
    constraintLayer: { getLogs: () => [] },
    _inboxMessages: [],
    getChannelWallet: async () => null,
  };

  // 与 PiAgentSession.registerTools() **同序同源**: builtin → contacts → wallet 都是**同步**的,
  //   异步的 (browser/lsp/orbitdb) 在它们之后才落地 —— 顺序会决定"第 121 个是谁", 不能乱.
  registerBuiltinTools(ctx);
  mark('builtin: pi-sdk-tools.registerBuiltinTools');
  registerContactTools(ctx, new ContactChain({ home: HOME, ownerDid: 'did:bolln:tool-name-verify', displayName: 'verify' }));
  mark('contacts: agents/contacts/tools (registerContactTools)');
  registerWalletTools(ctx);
  mark('wallet/x402/safe: pi-sdk-tools.registerWalletTools');
  await sleep(1500);                       // 给 browser-cdp / lsp / orbitdb 的异步注册落地
  mark('async: browser-cdp + lsp/lsp-tools + orbitdb/agent-tools');

  const names = Array.from(tools.keys());
  const violations = names
    .map((name, i) => ({ name, i0: i, i1: i + 1, source: sources.get(name) || '?', chars: illegalChars(name), tooLong: name.length > 64 }))
    .filter((v) => !PATTERN.test(v.name));

  console.log(`  工具总数: ${names.length}`);
  console.log(`  来源分布: ${Array.from(new Set(sources.values())).map((s) => `${s}=${Array.from(sources.values()).filter((x) => x === s).length}`).join(' · ')}`);
  console.log(`  违规数 (出网即 400): ${violations.length}`);
  for (const v of violations) {
    console.log(`    - #${v.i1} \`${v.name}\`  来源=${v.source}  违规字符=${JSON.stringify(v.chars)}${v.tooLong ? ' 超长' : ''}`);
  }
  const at120 = violations.find((v) => v.i0 === 120);
  console.log(`  真实报错的 tools[120] (= 第 121 个) 在本探针顺序下是: ${at120 ? `\`${at120.name}\` (违规 ✓ 与报错逐字对上)` : `\`${names[120]}\` (不违规; 首例违规是 #${violations[0]?.i1 ?? '-'})`}`);
  console.log(`  首例违规: ${violations[0] ? `#${violations[0].i1} \`${violations[0].name}\` (${violations[0].chars.join(' ')})` : '无 (全部合法)'}`);

  ok('真注册表里存在会被 400 拒掉的工具名 (bug 可复现)', violations.length > 0, `${violations.length} 个违规`);
  ok('全部违规都是「非法字符」而不是超长', violations.every((v) => !v.tooLong));

  // ─────────────────────────────────────────────────────────────
  // [2] 净化 + 往返映射
  // ─────────────────────────────────────────────────────────────
  section('2. 净化后全部合法 + 原名↔API 名往返');
  const table = new ToolNameRouteTable();
  const apiNames: string[] = [];
  let rewriteFail = '';
  for (const n of names) {
    let api = '';
    try { api = table.register(n); } catch (e: any) { rewriteFail = String(e?.message || e); break; }
    apiNames.push(api);
    if (!PATTERN.test(api)) { rewriteFail = `净化结果仍违规: ${n} → ${api}`; break; }
    if (table.resolveToOriginal(api) !== n) { rewriteFail = `往返不一致: ${n} → ${api} → ${table.resolveToOriginal(api)}`; break; }
  }
  ok('每个注册工具名净化后都匹配 /^[a-zA-Z0-9_-]{1,64}$/ 且往返还原回原名', rewriteFail === '', rewriteFail);
  ok('净化是幂等的 (再净化一次不变)', names.every((n) => sanitizeToolName(sanitizeToolName(n)) === sanitizeToolName(n)));
  ok('被改写的名字与违规名单一一对应', table.changed.length === violations.length, `改写 ${table.changed.length} 个 / 违规 ${violations.length} 个`);
  ok('净化后没有两个原名撞到同一个 API 名', new Set(apiNames).size === apiNames.length, `${new Set(apiNames).size}/${apiNames.length}`);

  // ─────────────────────────────────────────────────────────────
  // [3] 派发证明: 只用净化名真调一次真实现
  // ─────────────────────────────────────────────────────────────
  section('3. 派发证明 (只用 LLM 会看到的 API 名 → 真 handler 真跑一次)');
  const face = names.map((n) => {
    const t = tools.get(n);
    const params = (t as any)?.parameters || {};
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const [pName, pDesc] of Object.entries(params)) {
      properties[pName] = { type: 'string', description: String(pDesc) };
      if (String(pDesc).includes('必填')) required.push(pName);
    }
    // 与 pi-sdk.ts:1907-1925 的 wire 形状一致 (同 2 个产出点之一)
    return { type: 'function', function: { name: n, description: (t as any)?.description || n, parameters: { type: 'object', properties, required } } };
  });
  const wire = sanitizeToolsForApi(face, table);
  ok('完整工具面 (真注册表 + pi-sdk wire 形状) 净化后逐条合法', wire.every((t) => PATTERN.test(t.function.name)), `${wire.length} 条`);
  ok('入参没被就地改写 (调用方原数组未被污染)', face.every((t) => t.function.name === names[face.indexOf(t)]));

  const targetOriginal = violations[0].name;                 // 名字真被改写过的工具
  const targetApi = table.apiNameOf(targetOriginal);
  const viaApi = tools.get(resolveApiToolName(targetApi, table));
  console.log(`  目标工具: 原名 \`${targetOriginal}\` → API 名 \`${targetApi}\``);
  ok('API 名不是注册名 (LLM 靠它直接查表查不到 ⇒ 还原这一步是承重的)', !tools.has(targetApi));
  ok('还原后拿到的就是真实现 (同一个函数引用)', viaApi === tools.get(targetOriginal));
  ok('原名/API 名不同 (确实被改写过)', targetOriginal !== targetApi);
  // 真调一次: 拿 LLM 回吐的 API 名走完整回程 → 真 execute()
  const dispatchName = resolveApiToolName(targetApi, table);
  const tool = tools.get(dispatchName);
  const result = await tool.execute({});
  ok('真调一次: 派发到真 handler 且真返回 (不是"未知工具"分支)', !!result && result.success === true,
    `success=${result?.success} keys=${result ? Object.keys(result).join(',') : '-'}`);
  // contact.list_authorized 的实现形状: { success, contacts[], channels[], note } — "未知工具"分支给不出这个
  ok('真 handler 返回的形状 = contact.list_authorized 的实现 (证明跑到了正确实现)',
    Array.isArray(result?.contacts) && Array.isArray(result?.channels) && typeof result?.note === 'string' && result.note.includes('联系方式'),
    `contacts=${Array.isArray(result?.contacts) ? result.contacts.length : 'n/a'} note=${String(result?.note || '').slice(0, 40)}`);

  // ─────────────────────────────────────────────────────────────
  // [4] 源码级: 没有第二条发包路径
  // ─────────────────────────────────────────────────────────────
  section('4. 源码级证据: 唯一净化边界 + 没有第二条发包路径');
  const srcFiles: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'test') walk(p); }
      else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(p);
    }
  })(path.join(ROOT, 'src'));
  const rel = (p: string) => path.relative(ROOT, p);
  const read = (p: string) => fs.readFileSync(p, 'utf-8');

  const attachTools = srcFiles.filter((f) => /requestBody\.tools\s*=/.test(read(f))).map(rel);
  ok('HTTP 请求体里挂 tools 全仓只有 1 处', attachTools.length === 1 && attachTools[0] === 'src/llm/pi-ai.ts', attachTools.join(', ') || '(0 处)');

  const producers = srcFiles.filter((f) => /type:\s*'function'[;,]\s*\n\s*function:\s*\{/.test(read(f))).map(rel);
  const expectedProducers = ['src/agents/pi-sdk.ts', 'src/agents/workflow-pivot-loop.ts', 'src/llm/pi-ai.ts'];
  ok('wire 形状 tools 产出点只有 2 个 builder (+1 个类型声明 = 边界文件本身)',
    producers.length === 3 && expectedProducers.every((p) => producers.includes(p)), producers.join(', '));

  const sanitizeCallers = srcFiles.filter((f) => /sanitizeToolsForApi\(/.test(read(f)) && !/export function sanitizeToolsForApi/.test(read(f))).map(rel);
  ok('净化只有 1 个调用点 (唯一边界)', sanitizeCallers.length === 1 && sanitizeCallers[0] === 'src/llm/pi-ai.ts', sanitizeCallers.join(', ') || '(0 处)');

  const callOpenAI = srcFiles.filter((f) => /this\.callOpenAI\(/.test(read(f))).map(rel);
  const piAiSrc = read(path.join(ROOT, 'src/llm/pi-ai.ts'));
  const callOpenAICount = (piAiSrc.match(/this\.callOpenAI\(/g) || []).length;
  ok('callOpenAI (唯一 OpenAI 兼容发包函数) 只在 generateText 里被调 1 次', callOpenAI.length === 1 && callOpenAICount === 1, `${callOpenAI.join(', ')} ×${callOpenAICount}`);

  const chatCompletions = srcFiles.filter((f) => /chat\/completions/.test(read(f))).map(rel);
  const withToolsKey = chatCompletions.filter((f) => f !== 'src/llm/pi-ai.ts' && /\btools\s*[,:]/.test(read(path.join(ROOT, f))));
  ok('另外两个 chat/completions 发送点 (p2p-chat-tools / judgment-protocol) 不带 tools', withToolsKey.length === 0,
    `chat/completions: ${chatCompletions.join(', ')}`);

  const chatWithTools = srcFiles.filter((f) => /\.chat\([^)]*,\s*(signal|undefined),?\s*(tools|openAITools)\b/.test(read(f))).map(rel);
  ok('把 tools 交给 llm.chat() 的两处都喂给同一个边界 (pi-sdk / workflow-pivot-loop)', chatWithTools.length === 2, chatWithTools.join(', '));

  // 回程还原点: 净化名进了 wire, 派发侧就必须有还原, 否则 LLM 调工具必然"未知工具"
  const piSdkSrc = read(path.join(ROOT, 'src/agents/pi-sdk.ts'));
  const pivotSrc = read(path.join(ROOT, 'src/agents/workflow-pivot-loop.ts'));
  ok('pi-sdk 派发侧有回程还原 (LLM 回吐的 API 名 → 注册表真名)', /tc\.name = resolveApiToolName\(tc\.name\)/.test(piSdkSrc));
  const pivotRestores = (pivotSrc.match(/resolveApiToolName\(/g) || []).length;
  ok('pivot loop 派发侧有回程还原 (原生 + 6 个文本 pattern 全覆盖)', pivotRestores >= 8, `${pivotRestores} 处`);

  // ─────────────────────────────────────────────────────────────
  // [5] HTTP 级证明: 本地冒充 OpenAI 的服务器逐条校验 function.name
  //     (自带, 不需要凭据 —— 真凭据那一节在 [6], 默认关)
  // ─────────────────────────────────────────────────────────────
  section('5. HTTP 级: 本地冒充 OpenAI 的服务器 (按官方文档正则逐条校验)');
  {
    const http = await import('http');
    const seenNames: string[][] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        const t = Array.isArray(body.tools) ? body.tools : [];
        const names = t.map((x: any) => String(x?.function?.name ?? ''));
        seenNames.push(names);
        // 只做 OpenAI 文档里那一条形状校验 (其它一律放行)
        const badIdx = names.findIndex((n) => !PATTERN.test(n));
        if (badIdx >= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `Invalid 'tools[${badIdx}].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`,
              type: 'invalid_request_error',
            },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}/v1`;

    // 5a. 修复前的形状 (不加净化, 直接挂 tools) 打同一台服务器 → 必须复现 leo 的 400
    const rawRes = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], tools: face }),
    });
    const rawBody = await rawRes.text();
    ok('修复前形状 (未净化 180 工具) 打服务器 → 400 + 逐字复现报错',
      rawRes.status === 400 && rawBody.includes("Invalid 'tools[120].function.name': string does not match pattern"),
      `${rawRes.status} ${rawBody.slice(0, 120)}`);

    // 5b. 走**真应用边界** (PiAIModel.chat → generateText → callOpenAI), 同一个未净化输入
    const { PiAIModel } = await import('../src/llm/pi-ai.js');
    const llm = new PiAIModel({ provider: 'deepseek', apiKey: 'test-key-not-real', baseUrl: base, model: 'deepseek-chat' });
    const r = await llm.chat('只回复两个字: 收到 (不要调用任何工具)', '你是连通性测试桩。严格只回「收到」两个字。', undefined, face as any);
    ok('走真边界 (chat → generateText → callOpenAI) → 200 + 正常回复', String(r?.reply || '').includes('收到'), `reply=${JSON.stringify(String(r?.reply || '').slice(0, 30))}`);
    const last = seenNames[seenNames.length - 1] || [];
    ok('服务器真收到 180 条工具, 逐条合法', last.length === face.length && last.every((n) => PATTERN.test(n)), `${last.length} 条, 源 ${names.length}`);
    ok('服务器侧看到的都是净化后的名字 (点已变下划线)',
      last.includes('contact_list_authorized') && !last.includes('contact.list_authorized'),
      `contact_list_authorized=${last.includes('contact_list_authorized')}`);
    ok('同一个请求里没有重复名 (撞名会让 LLM 调到的实现不可知)', new Set(last).size === last.length);
    server.close();
  }

  // ─────────────────────────────────────────────────────────────
  // [6] 可选: 真发一次 (真凭据, 单次, 最便宜模型)
  // ─────────────────────────────────────────────────────────────
  section('6. 真发 (opt-in: BOLLOON_TOOLNAMES_LIVE=1)');
  if (process.env.BOLLOON_TOOLNAMES_LIVE !== '1') {
    console.log('  ⏭️  未真发 (BOLLOON_TOOLNAMES_LIVE != 1). 离线部分: 断言了整理后 payload 里全部 function.name 合法 + 派发可达.');
  } else {
    const cfgPath = path.join(REAL_HOME, '.bolloon', 'llm-config.json');
    let cfg: any = null;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch { /* 无配置 */ }
    const provider = process.env.BOLLOON_TOOLNAMES_LIVE_PROVIDER || cfg?.activeProvider;
    const p = cfg?.providers?.[provider];
    const apiKey = p?.apiKey || process.env[`${String(provider || '').toUpperCase()}_API_KEY`] || '';
    const baseUrl = p?.baseUrl;
    // 只挑最便宜的模型: deepseek 线用 deepseek-chat
    const cheapest: Record<string, string> = { deepseek: 'deepseek-chat', minimax: 'MiniMax-M2.5' };
    const model = cheapest[provider] || p?.model;
    if (!apiKey || !baseUrl) {
      console.log(`  ⏭️  未真发: ${cfgPath} 里没有可用凭据 (provider=${provider || 'none'}, key=${apiKey ? '[REDACTED]' : '缺失'})`);
    } else {
      console.log(`  真发: provider=${provider} baseUrl=${baseUrl} model=${model} (key=[REDACTED]) tools=${wire.length}`);
      const { PiAIModel } = await import('../src/llm/pi-ai.js');
      const llm = new PiAIModel({ provider, apiKey, baseUrl, model });
      const t0 = Date.now();
      let reply = '';
      let err = '';
      try {
        const r = await llm.chat(
          '只回复两个字: 收到 (不要调用任何工具)',
          '你是连通性测试桩。严格只回「收到」两个字。',
          undefined,
          wire as any
        );
        reply = String(r?.reply || '');
      } catch (e: any) { err = String(e?.message || e); }
      const ms = Date.now() - t0;
      const bad = !/^[\s\S]*收到[\s\S]*$/.test(reply) || /Invalid 'tools|string does not match pattern|OpenAI API error: 4|AI 服务调用失败/.test(err + ' ' + reply);
      ok(`真发带完整工具面 (${wire.length} 条) 的请求被接受 (HTTP 2xx, 非 400)`, !bad,
        bad ? `被拒: ${(err + ' ' + reply).slice(0, 300)}` : `${ms}ms reply=${JSON.stringify(reply.slice(0, 40))}`);
    }
  }

  console.log('\n' + '='.repeat(64));
  console.log(`工具名门: ${passed} PASS / ${failed} FAIL`);
  if (failures.length) console.log('FAILED: ' + failures.join(' | '));
  // 注册表里带常驻句柄 (browser-cdp / orbitdb), 事件循环不会自己空 —— 显式退出
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身炸了:', e); process.exit(2); });
