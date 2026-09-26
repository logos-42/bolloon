/**
 * verify-mobile-model-sync.ts — 手机端「模型链路」同步验收 (本轮新能力, 2026-09-26)
 *
 * 为什么要有它: 这一批模型能力 (P2 分步选择器 / P5 发现与缓存 / P6 五端点 / 工具名净化)
 * 都是**桌面端/服务端**的, 手机端要"看得见、用得上"才有意义。手机端的显示层只有真浏览器
 * 真 DOM 能验 (grep 源码证明不了 `#api-eff-hash` 里到底渲染了什么), 所以:
 *
 *   · 起**真 express**: `registerLlmConfigRoutes(app)` (那五条新端点就是它注册的) + 静态服
 *     `dist/web` —— 于是 mobile.html 与 API **同源**, 手机端的 `desktopBaseUrl()` 就指它自己。
 *   · 起**假上游** (OpenAI 兼容, 127.0.0.1): 目录 `live` 来自它, 且它把**每一个出网请求体**
 *     原样记下来 —— 工具名净化那条要靠这份抓包才算"真验过"。
 *   · 真 Chrome headless + 裸 CDP (不依赖 playwright, 与 verify-mobile-tasks-ui.ts 同款)。
 *
 * 四段 (对应本轮要求的 ①②③④):
 *   §1 手机端显示"当前真实生效的模型配置" —— 逐字对照服务端 `/api/models/providers` 的 effective
 *   §2 手机端能用新服务端能力 —— 目录 origin 标记 / 刷新发现 / 手输模型 (每个都断言真打到服务端)
 *   §3 工具名净化后的行为对齐 —— 真 agent 环 + 出网抓包: 出网名字合法, 且回程派发到真实现
 *   §4 版本标识单源派生 —— package.json 是唯一数字源 (sw 缓存名 / web 构建戳 / 原生壳)
 *
 * 变异 (§5): 把 configHash 的显示改成**硬编码** → §1 必须判红 (证明这门不是空转)。
 *
 * 退出码: 0 = 全过 (+ 变异判红); 1 = 有断言失败; 2 = 环境不满足 (本机没 Chrome / 没 dist/web)
 *
 * 用法: npx tsx scripts/verify-mobile-model-sync.ts
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { spawn, spawnSync } from 'child_process';

// ── 隔离 HOME: 不碰真实 ~/.bolloon, 也不让它影响断言 ─────────────────────────
// ⚠️ 真 HOME 必须在**覆盖之前**取: Node 的 os.homedir() 就是读 $HOME, 覆盖后再取拿到的是临时目录。
//    Chrome 要用真 HOME (见下面 spawn 处的注释) —— 这条"取早了"的坑会把修复变成空操作。
const REAL_HOME = os.homedir();
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-mobile-model-'));
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR;
process.env.BOLLOON_HOME = path.join(HOME_DIR, '.bolloon');
process.env.BOLLOON_SKIP_KUBO = '1';
// 隔离 HOME 里没有真实初始化状态 ⇒ `getSetupGateCached()` 只能是 setup/identity_pending,
// 而 `PiAgentSession.prompt()` 在门不过时**直接拒执行** (fail-closed)。仓库自己的口径 (见
// pi-sdk.ts 那段注释): 隔离 HOME 的验证跑在 VITEST 语义下 —— 这里沿用同一开关, 只跳过
// 「初始化门禁」这一件事; 工具注册 / 名字净化 / 出网报文 / 派发回真实现 全是生产路径。
process.env.VITEST = '1';
process.env.BOLLOON_CRON = '0';

const ROOT = process.cwd();
const DIST_WEB = path.join(ROOT, 'dist/web');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-model-chrome-'));

// ── 端口纪律 (2026-09-26 踩过的真坑) ────────────────────────────────────────
// 本仓的 UI 验收脚本都爱用 **固定区间 + 随机** 挑 CDP 端口: verify-mobile-tasks-ui 9333+300,
// verify-mobile-update-ui / verify-goal-flywheel-p5-ui 9433+300 —— 区间互相重叠, 而且**并行的
// 另一条线留下的 Chrome 会一直占着那些端口不放**。
// 撞上的后果极其误导: 自己的 Chrome 起不来 (端口被占), 而 `GET /json/list` **仍然有人应答** ——
// 答的是**别人那个 Chrome**。于是: Runtime/Page.enable 正常回, `Page.navigate` 永远不回,
// 本机服务一个请求都收不到, `localStorage` SecurityError。看起来像"页面卡死", 实则连错了浏览器。
// 所以: ① 先挑一个**真能 bind** 的端口; ② 起完 Chrome 后**确认它自己活着**; ③ 把 Chrome 的
// stderr 收进文件, 出事时打得出来。三条都是为了"红要红在真因上"。
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort(lo: number, hi: number): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const p = lo + Math.floor(Math.random() * (hi - lo));
    if (await portFree(p)) return p;
  }
  throw new Error(`找不到空闲端口 (${lo}-${hi}) —— 本机被别的验收占满了`);
}

let PORT = 0;          // 真 express (同源手机页 + 五条模型端点)
let CDP_PORT = 0;      // 只有**自己起的** Chrome 会听它
const CHROME_ERR = path.join(HOME_DIR, 'chrome.stderr.log');
const TOOL_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++; failures.push(name);
    const d = detail === undefined ? '' : ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`;
    console.log(`  ❌ ${name}${d}`);
  }
}
function section(t: string): void { console.log(`\n[${t}]`); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// 假上游: OpenAI 兼容 + **记录原始请求体** (工具名净化那条靠它)
// ════════════════════════════════════════════════════════════════════════════
interface RecordedReq { at: number; path: string; body: any; toolNames: string[]; hasTools: boolean; }

interface Stub {
  port: number; baseUrl: string; reqs: RecordedReq[];
  /** 让第一个"带工具声明"的请求回一个 tool_call (用**净化后的**名字, 模拟 LLM 看到的名字) */
  toolCallName: string | null;
  toolRounds: number;
  close(): Promise<void>;
}

async function startStub(models: string[], toolCallName: string | null = null): Promise<Stub> {
  const reqs: RecordedReq[] = [];
  const stub: any = { reqs, toolCallName, toolRounds: 0, port: 0, baseUrl: '' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      reqs.push({
        at: Date.now(), path: url.pathname, body,
        toolNames: tools.map((t: any) => String(t?.function?.name ?? '')),
        hasTools: tools.length > 0,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/models')) {
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'stub' })) }));
        return;
      }
      if (url.pathname.endsWith('/chat/completions')) {
        const wantTool = !!stub.toolCallName && tools.length > 0 && stub.toolRounds < 1;
        if (wantTool) {
          stub.toolRounds++;
          res.end(JSON.stringify({
            id: 'stub', object: 'chat.completion', model: body?.model || 'stub',
            choices: [{ index: 0, finish_reason: 'tool_calls',
              message: { role: 'assistant', content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: stub.toolCallName, arguments: '{}' } }] } }],
          }));
          return;
        }
        res.end(JSON.stringify({
          id: 'stub', object: 'chat.completion', model: body?.model || 'stub',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `stub 不认这个路径: ${url.pathname}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stub.port = (server.address() as any).port;
  stub.baseUrl = `http://127.0.0.1:${stub.port}/v1`;
  stub.close = () => new Promise<void>((r) => server.close(() => r()));
  return stub as Stub;
}

// ════════════════════════════════════════════════════════════════════════════
// CDP (真 Chrome, 裸 WebSocket, 不依赖 playwright)
// ════════════════════════════════════════════════════════════════════════════
let ws: any = null, chrome: any = null, srv: any = null;
const pageErrors: string[] = [];

async function evaluate(expr: string): Promise<any> {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) return { error: String(ex.exception?.description || ex.text || '').slice(0, 400) };
  return { value: r.result?.result?.value };
}

let msgCount = 0;
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
/** CDP 调用: **每次都有超时**。没有超时的话, 一旦对面不回 (重负载 / 目标被换),
 *  整个门就吊死在这儿 —— 那种"挂住"既不是红也不是绿, 最难查。 */
function send(method: string, params: any = {}, timeoutMs = 60000): Promise<any> {
  return new Promise((res) => {
    const id = ++msgId;
    const t = setTimeout(() => {
      pending.delete(id);
      console.log(`    [harness] CDP ${method} 超时 ${timeoutMs}ms (ws.readyState=${ws ? ws.readyState : '?'}, 已收 ${msgCount} 条) — 当作空响应继续 (不吊死)`);
      res({ timeout: true });
    }, timeoutMs);
    pending.set(id, (v: any) => { clearTimeout(t); res(v); });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (e: any) { clearTimeout(t); pending.delete(id); console.log(`    [harness] ws.send 失败: ${String(e?.message || e).slice(0, 120)}`); res({ sendError: true }); }
  });
}

/** 导航 + 等就绪。**带重试**: 这台机器上并行跑别的验收时 (load 10+) headless Chrome 会
 *  偶尔吃掉一条 CDP 消息 —— 那属于负载假红, 不该让门红。真加载不了会在重试后如实退出 2。 */
async function reloadPage(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/mobile.html` }, 90000);
    if (await waitReady()) return true;
    console.log(`    [harness] 第 ${attempt + 1} 次导航后没就绪, 重试`);
  }
  return false;
}

async function waitReady(): Promise<boolean> {
  for (let i = 0; i < 70; i++) {
    try {
      const r = await evaluate(`JSON.stringify({ href: location.href, rs: document.readyState })`);
      const v = JSON.parse(String(r.value || '{}'));
    if (String(v.href).includes('mobile.html') && v.rs === 'complete') { await sleep(2200); return true; }
    } catch { /* 还在换页 */ }
    await sleep(300);
  }
  return false;
}

/** 打开设置页 → 模型配置, 等加载完 (等 #api-eff-provider 不再是"读取中…") */
async function openModelPage(): Promise<boolean> {
  await evaluate(`(function(){
    var sp = document.getElementById('settings-page'); if (sp) sp.remove();
    var ap = document.getElementById('api-config-page'); if (ap) ap.remove();
  })()`);
  // ① 走用户真会点的三步: 「我」tab → 「设置」→ 「模型配置」
  //    为什么必须先切 tab: 「设置」入口在「我」页里, 页面按 tab 切显隐; 不切就点不到
  //    (元素在 DOM 里但所属页没激活, 点了没反应 —— 这正是上一版全红的原因)。
  await acceptPrivacyIfShown();
  const step0 = await evaluate(`(function(){
    var tab = document.querySelector('.tab[data-tab="me"]');
    if (!tab) return { err: 'no .tab[data-tab=me]' };
    tab.click();
    return { ok: true };
  })()`);
  if (step0.value?.err) { console.log('    [harness] ' + step0.value.err); return false; }
  await sleep(300);
  const step1 = await evaluate(`(function(){
    var it = document.getElementById('item-settings');
    if (!it) return { err: 'no #item-settings' };
    it.click();
    return { ok: true };
  })()`);
  if (step1.value?.err) { console.log('    [harness] ' + step1.value.err); return false; }
  let hasItem = false;
  for (let i = 0; i < 20; i++) {
    if ((await evaluate(`!!document.getElementById('api-config-item')`)).value) { hasItem = true; break; }
    await sleep(200);
  }
  if (!hasItem) {
    // 点不开就当"红"的原因是重要信息 —— 打出来 (含页面现在到底有哪些 id), 别静默改道
    const ids = (await evaluate(`Array.prototype.map.call(document.querySelectorAll('[id]'), function(e){return e.id}).join(',')`)).value;
    console.log('    [harness] 点「设置」后没等到 #api-config-item; 当前 DOM 里已有 id: ' + String(ids).slice(0, 300));
    return false;
  }
  const step2 = await evaluate(`(function(){
    var api = document.getElementById('api-config-item');
    if (!api) return { err: 'no #api-config-item' };
    api.click();
    return { ok: true };
  })()`);
  const r = step2;
  for (let i = 0; i < 40; i++) {
    const t = await evaluate(`(function(){ var el = document.getElementById('api-eff-provider'); return el ? el.textContent : null; })()`);
    if (t.value && t.value !== '读取中…' && t.value !== '') return true;
    await sleep(250);
  }
  return !!r.value?.ok;
}

/** 首启隐私同意门 (真实首启必经): 不同意时 `init()` 直接 return —— `initApp()`/`bindMenu()`
 *  都不跑, 于是整个页面**没有任何监听器** (用 CDP DOMDebugger.getEventListeners 实测: `#item-settings`
 *  上 0 个监听器)。这一条不是测试脚手架, 是 app 的真实首启步骤。幂等: 已同意就什么都不做。 */
async function acceptPrivacyIfShown(): Promise<boolean> {
  const r = await evaluate(`(function(){
    var gate = document.getElementById('privacy-gate');
    var btn = document.getElementById('privacy-agree');
    if (!gate || !btn) return { skipped: true };
    // 注意: 不要用 offsetParent 判可见 —— headless 里 sheet 的 offsetParent 是 null (实测),
    //   会把"门明明开着"误判成"没开", 于是不点, 于是整页没有监听器, 全线红。
    //   判据只认 app 自己的 gate 语义: hidden 属性在不在。
    if (gate.hasAttribute('hidden')) return { skipped: true };
    btn.click();
    return { clicked: true };
  })()`);
  if (r.value?.clicked) {
    console.log('   · 点了首启隐私同意门 (#privacy-agree) —— 不点的话页面一个监听器都不会有');
    await sleep(600);
  }
  return !!r.value?.clicked;
}

/** 页面里读到的生效卡片 (真 DOM 文本) */
async function readEffectiveCard(): Promise<any> {
  return (await evaluate(`(function(){
    function g(id){ var el = document.getElementById(id); return el ? el.textContent : null; }
    return { provider: g('api-eff-provider'), model: g('api-eff-model'), baseUrl: g('api-eff-baseurl'),
             scope: g('api-eff-scope'), hash: g('api-eff-hash'), note: g('api-eff-note') };
  })()`)).value;
}

async function readCatalog(): Promise<any> {
  return (await evaluate(`(function(){
    function g(id){ var el = document.getElementById(id); return el ? el.textContent : null; }
    return { origin: g('api-catalog-origin'), head: g('api-catalog-head'), list: g('api-catalog-list'),
             note: g('api-catalog-note'), result: g('api-discover-result') };
  })()`)).value;
}

async function httpJson(method: string, url: string, body?: any): Promise<{ status: number; json: any }> {
  const res = await fetch(url, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// ════════════════════════════════════════════════════════════════════════════
/** 无论怎么结束 (正常 / 超时看门狗 / 抛错), 都把已跑出的结论打出来 ——
 *  免得"挂住"看起来像"没跑过" (那是最没法排查的一种)。 */
function dumpSummary(): void {
  console.log(`\n──────── ${passed} PASS / ${failed} FAIL (到此为止) ────────`);
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); }
  for (const e of pageErrors.slice(0, 5)) console.log('  页面错: ' + e);
}
process.on('exit', () => { try { dumpSummary(); } catch { /* 忽略 */ } });

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(DIST_WEB, 'mobile.html')) || !fs.existsSync(path.join(DIST_WEB, 'mobile.js'))) {
    console.error('dist/web 不完整 → 先 npm run build:web'); process.exit(2);
  }
  const hasChrome = fs.existsSync(CHROME);
  if (!hasChrome) { console.error('本机没有 Chrome → 手机端 DOM 那段无法真验 (需真机/需 Chrome)'); process.exit(2); }

  await fsp.mkdir(path.join(process.env.BOLLOON_HOME!, ''), { recursive: true });

  // ── 假上游 + 预置配置: 一家内置 (deepseek) 指到假上游 + 一家自定义 ───────
  // 看门狗: 门自己不许无限期吊住 (超时 = 明确失败, 不是"还在跑")
  setTimeout(() => { console.error('\n[看门狗] 全局超时 420s — 强制退出 (结论如下)'); process.exit(1); }, 420_000);
  const stub = await startStub(['stub-model-a', 'stub-model-b']);
  console.log(`\n════ 手机端模型链路同步验收 · 假上游 ${stub.baseUrl} ════\n`);

  const CS: any = await import('../src/llm/config-store.js');
  await CS.llmConfigStore.initialize();
  await CS.llmConfigStore.updateProvider('deepseek', {
    enabled: true, baseUrl: stub.baseUrl, model: 'stub-model-a', apiKey: 'stub-placeholder-not-a-real-key',
  });

  // 必须**显式**设 active provider: 默认配置里 `ollama { enabled: true, model: 'llama4' }` ——
  //   不设的话 effective 可能落在本机 ollama 上 (模型 llama4), 基线就不是"刚写的那一个", 断言会随机飘。
  await CS.llmConfigStore.setActiveProvider('deepseek');

  const reqLog: string[] = [];

  PORT = await pickPort(8840, 8960);
  // ── 真 express: registerLlmConfigRoutes (五条新端点) + 静态 dist/web (同源) ──
  const expressMod: any = await import('express');
  const express = expressMod.default || expressMod;
  const { registerLlmConfigRoutes } = await import('../src/web/routes-llm-config.js');
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  // 请求流水账: 只在"页面没就绪"时打出来当证据 —— 能一眼分清
  //   「浏览器根本没过来说明认错了 CDP 目标」 vs 「请求到了但页面脚本没跑起来」。
  app.use((req: any, _res: any, next: any) => {
    if (req.url !== '/favicon.ico') reqLog.push(`${req.method} ${req.url}`);
    next();
  });
  registerLlmConfigRoutes(app);
  app.use(express.static(DIST_WEB, { index: false }));
  srv = app.listen(PORT, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', r));
  const ORIGIN = `http://127.0.0.1:${PORT}`;

  try {
    // ════════════════════════════════════════════════════════════════════
    section('1. 服务端基线 (手机端要显示的东西, 先拿到服务端真值)');
    const prov = await httpJson('GET', `${ORIGIN}/api/models/providers`);
    const eff = prov.json?.effective;
    check('GET /api/models/providers 可用, 且带 effective', prov.status === 200 && !!eff,
      `HTTP ${prov.status} · effective=${JSON.stringify(eff)?.slice(0, 160)}`);
    check('effective 四要素齐全 (provider/model/baseUrl/scope/configHash)',
      !!eff?.provider && !!eff?.model && !!eff?.baseUrl && !!eff?.scope && !!eff?.configHash,
      eff ? Object.keys(eff).join(',') : '(无)');
    check('effective.model 就是刚写的那一个 (基线不是默认值)', eff?.model === 'stub-model-a', eff?.model);
    const hash8 = String(eff?.configHash || '').slice(0, 8);
    check('configHash 至少 8 位可显示的摘要', hash8.length === 8, hash8);

    const optLive = await httpJson('GET', `${ORIGIN}/api/models/options?provider=deepseek&refresh=1`);
    check('GET /api/models/options?provider=deepseek&refresh=1 → 200 且 catalog.origin=live',
      optLive.status === 200 && optLive.json?.catalog?.origin === 'live',
      `origin=${optLive.json?.catalog?.origin} · models=${optLive.json?.count}`);
    check('目录真来自假上游 (两个 stub 模型都在)', (optLive.json?.models || []).length >= 2,
      (optLive.json?.models || []).map((m: any) => m.id).slice(0, 4).join(','));

    // ════════════════════════════════════════════════════════════════════
    section('2. 真 Chrome headless: 手机端 DOM');
    // ⚠️ 别用 about:blank 起 Chrome: macOS 上 Chrome 153 + `--window-size` 会开一个
    //   `chrome://newtab/` 的 **WebUI 目标**, 而 /json/list 里它也是 type==='page' —— 谁按
    //   "第一个 page 目标" 连, 连的就是它。WebUI 目标 `Page.navigate` 到 http 页**永远不回**,
    //   而且一格请求都不会落到本机服务上, 看起来像"页面卡住/服务不响应", 实则连错了目标。
    //   所以: 起手就把手机页作为启动 URL (与 scripts/verify-mobile-tasks-ui.ts 同款), 并按 url 认目标。
    // `--remote-debugging-port=0`: 让 **Chrome 自己**挑端口, 再把真端口写进 `<profile>/DevToolsActivePort`。
    //   这样"我连的 CDP 一定是本次起的这个 Chrome"是结构性保证, 不靠"随机到没人用的端口"的运气。
    chrome = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      // ① 不放 --window-size: macOS Chrome 153 在 `--headless=new --window-size` 下会**额外**开一个
      //    `chrome://newtab/` 的 WebUI 目标 (它也是 type==='page'), 会跟手机页抢"第一个 page 目标";
      //    DOM 断言与视口无关, 不加反而更干净。
      // ② 不放手机页 URL 作启动参数: 实测 (本机 Chrome 153) 这样起的 target 虽然 `url` 报的是
      //    手机页, 但**文档一直没提交** —— 本机服务一个请求都收不到, `localStorage` 直接
      //    SecurityError, 所有 evaluate 60s 超时 (看起来像"页面卡死", 实则 target 是空的)。
      //    改成 `about:blank` 起手 + 用 CDP `Page.navigate` 过去 ⇒ 稳定, 且"导航"这一步本身
      //    也成了被测行为 (手机端本来就是这么打开页面的)。
      'about:blank',
    ], {
      stdio: ['ignore', fs.openSync(CHROME_ERR, 'a'), fs.openSync(CHROME_ERR, 'a')],
      // ⚠️ 关键: **给 Chrome 用真的 HOME**。
      //   本脚本为了不碰真实 ~/.bolloon 把 Node 的 HOME 换成了临时目录 (截图隔离 HOME 那一行),
      //   而 Chrome 继承进程环境 ⇒ 也拿到那个假 HOME。实测后果: 本 Chrome **任何导航都不提交** ——
      //   `Page.navigate` 不回、本机服务一个请求都收不到、文档是空的 (localStorage SecurityError),
      //   但 `Runtime.enable` / `Runtime.evaluate('1+1')` 一切正常, 看着像"页面卡死"。
      //   所以: Node 侧继续隔离, **Chrome 侧还原真 HOME** (它只读到自己的 profile/缓存, 不碰 ~/.bolloon)。
      env: { ...process.env, HOME: REAL_HOME, USERPROFILE: REAL_HOME },
    });

    // Chrome 自己挑的端口 (写进 DevToolsActivePort 第一行) —— 只认它, 不猜
    const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
    for (let i = 0; i < 60 && !CDP_PORT; i++) {
      try {
        const raw = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
        if (/^\d+$/.test(raw)) CDP_PORT = parseInt(raw, 10);
      } catch { /* 还没写出来 */ }
      if (!CDP_PORT) await sleep(400);
    }
    if (!CDP_PORT) {
      console.error('Chrome 没写出 DevToolsActivePort —— 起不来 (或被杀)。Chrome stderr 尾巴:');
      try { console.error(fs.readFileSync(CHROME_ERR, 'utf8').split('\n').slice(-6).join('\n')); } catch { /* 无 */ }
      process.exit(2);
    }
    console.log(`   · Chrome 自报 CDP 端口 ${CDP_PORT} (DevToolsActivePort, 只可能是本次这个 Chrome)`);
    // 代理体检: Chrome **继承** 本进程环境。若 src 树里的某个模块 (为了访问外网) 设了
    //   HTTP(S)_PROXY, Chrome 连 127.0.0.1 也会走代理 → 本机服务永远收不到请求,
    //   表现就是"Page.navigate 不回 + 页面空白", 极难查。这里把它点名打出来。
    const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
      .filter((k) => process.env[k]).map((k) => `${k}=${String(process.env[k]).replace(/\/\/.*@/, '//***@')}`);
    console.log(`   · 进程代理环境: ${proxyEnv.length ? proxyEnv.join(' ') : '(无)'}`);

    let wsUrl = '';
    let seenTargets: string[] = [];
    void reqLog;
    for (let i = 0; i < 80; i++) {
      try {
        const list: any = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
        seenTargets = list.map((t: any) => `${t.type}:${String(t.url).slice(0, 44)}`);
        const page = list.find((t: any) => t.type === 'page' && String(t.url) === 'about:blank')
          || list.find((t: any) => t.type === 'page' && !/^(chrome|chrome-extension|devtools|chrome-untrusted):/.test(String(t.url)));
        if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
      } catch { /* 还没起来 */ }
      await sleep(400);
    }
    if (!wsUrl) {
      console.error(`CDP 没连上 about:blank 页目标。本次 Chrome 看到的目标:\n  ${seenTargets.join('\n  ') || '(空)'}`);
      try { console.error('Chrome stderr 尾巴:\n' + fs.readFileSync(CHROME_ERR, 'utf8').split('\n').slice(-6).join('\n')); } catch { /* 无 */ }
      process.exit(2);
    }
    console.log('   · CDP 目标已找到, 建 WebSocket…');
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('WebSocket open 超时 15s')), 15000);
      ws.onopen = () => { clearTimeout(t); res(null); };
      ws.onerror = (e: any) => { clearTimeout(t); rej(e); };
    });
    console.log('   · WebSocket 已连');
    ws.onclose = (e: any) => { console.log(`    [harness] WebSocket 关了 code=${e && e.code} reason=${e && e.reason}`); };
    ws.onerror = (e: any) => { console.log(`    [harness] WebSocket 报错 ${e && e.message}`); };
    ws.onmessage = (ev: any) => {
      msgCount++;
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 200));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        pageErrors.push('[console] ' + String((m.params.args || []).map((a: any) => a.value || a.description || '').join(' ')).slice(0, 200));
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    const pre = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 20000);
    console.log(`   · 导航前探针 1+1 = ${JSON.stringify(pre?.result?.result?.value)} · 已收消息 ${msgCount} 条`);

    // 同源 + 手机端 desktopBaseUrl() 读 localStorage → 让它指向这台真服务
    const firstLoad = await reloadPage();   // about:blank → CDP 导航到手机页 (见上面 ②)
    check('真 Chrome 加载 mobile.html (真 DOM, 不是自述)', firstLoad === true);
    await acceptPrivacyIfShown();
    if (!firstLoad) {
      console.log('    [harness] 诊断 · 本机服务收到的请求: ' + (reqLog.slice(0, 12).join(' | ') || '(一个都没有 → 浏览器根本没连上这台服务)'));
      console.log('    [harness] 诊断 · CDP 目标: ' + (seenTargets.join(' | ') || '(空)'));
    }
    let seeded: any = {};
    for (let i = 0; i < 3; i++) {
      seeded = await evaluate(`(function(){
        try { localStorage.setItem('bolloon_desktop_base_url', ${JSON.stringify(ORIGIN)}); } catch (e) { return 'set 失败: ' + e; }
        return localStorage.getItem('bolloon_desktop_base_url');
      })()`);
      if (seeded.value === ORIGIN) break;
      await sleep(500);
    }
    check('本机 localStorage 已写入电脑端基址 (手机端 desktopBaseUrl 的真来源)', seeded.value === ORIGIN, seeded.value ?? seeded.error);

    const loaded = await reloadPage();
    check('重新加载后文案与 DOM 重画 (用的是刚写入的基址)', loaded === true);
    check('页面零未捕获异常 (整页 JS 真的跑起来了)', pageErrors.length === 0, pageErrors.slice(0, 3));

    // ── ① 当前真实生效 ────────────────────────────────────────────────
    section('3. ① 手机端显示"当前真实生效的模型配置" (逐字对照服务端 effective)');
    const opened = await openModelPage();
    check('从「设置 → 模型配置」真点进模型页 (#api-config-page 出现)', opened === true,
      (await evaluate(`!!document.getElementById('api-config-page')`)).value);
    const card = await readEffectiveCard();
    check('DOM: provider = 服务端 effective.provider', card?.provider === eff?.provider, `${card?.provider} vs ${eff?.provider}`);
    check('DOM: model = 服务端 effective.model', card?.model === eff?.model, `${card?.model} vs ${eff?.model}`);
    check('DOM: baseUrl = 服务端 effective.baseUrl', card?.baseUrl === eff?.baseUrl, `${card?.baseUrl} vs ${eff?.baseUrl}`);
    check('DOM: 来源(scope) = 服务端 effective.scope', card?.scope === String(eff?.scope), `${card?.scope} vs ${eff?.scope}`);
    check('DOM: configHash = 服务端 hash 前 8 位 (逐字)', card?.hash === hash8, `${card?.hash} vs ${hash8}`);
    check('DOM: 没显示完整 64 位指纹 (手机上只给前几位)', !String(card?.hash || '').includes(String(eff?.configHash).slice(9)), card?.hash);
    check('页面上真的打的是新端点名 (可核产物: DOM 里有端点自述)', String(card?.note || '').includes(eff?.authRef || 'none'), card?.note);

    // ── ② 目录 / 刷新发现 / 手输模型 ──────────────────────────────────
    section('4. ② 手机端用新服务端能力 (目录 origin · 刷新发现 · 手输模型)');
    let cat = await readCatalog();
    check('DOM: 目录来源标记来自服务端 (含 live 或 curated)', /live|curated|cached|custom|unavailable/.test(String(cat?.origin || '')), cat?.origin);
    check('DOM: 目录条目数 > 0 且标题写明数量', /\d+\s*个模型/.test(String(cat?.head || '')), cat?.head);

    stub.reqs.length = 0;                        // 只数"点这一下"产生的上游请求
    const beforeRefresh = (await readCatalog())?.result || '';
    await evaluate(`document.getElementById('api-discover-refresh').click()`);
    for (let i = 0; i < 40; i++) {
      const r = await readCatalog();
      if (r?.result && r.result !== beforeRefresh && !/刷新中/.test(r.result)) break;
      await sleep(250);
    }
    const afterRefresh = (await readCatalog())?.result || '';
    check('点「刷新发现」→ 结果文案变了 (不是原地空转)', afterRefresh !== beforeRefresh, `"${afterRefresh}"`);
    check('「刷新发现」真打到了上游 (假上游收到 POST /chat 之外的 /models)',
      stub.reqs.some((r) => r.path.endsWith('/models')), stub.reqs.map((r) => `${r.path}`).join(',') || '(零请求)');
    check('刷新后目录来源仍是 live (真去上游过一遍)', /live/.test(String((await readCatalog())?.origin || '')), (await readCatalog())?.origin);

    const NEW_MODEL = 'stub-model-manual-9';
    await evaluate(`(function(){
      var el = document.getElementById('api-manual-model'); el.value = ${JSON.stringify(NEW_MODEL)};
      document.getElementById('api-manual-admit').click();
    })()`);
    for (let i = 0; i < 40; i++) {
      const r = await readCatalog();
      if (/已加入目录|加入失败/.test(String(r?.result || ''))) break;
      await sleep(250);
    }
    const admitResult = (await readCatalog())?.result || '';
    check('手输模型 → 服务端真的收下了 (DOM 报"已加入目录")', admitResult.includes(NEW_MODEL), admitResult);
    const optAfter = await httpJson('GET', `${ORIGIN}/api/models/options?provider=deepseek`);
    const idsAfter = (optAfter.json?.models || []).map((m: any) => String(m.id));
    check('手输的模型真进了服务端目录 (回读 /api/models/options 能看见)', idsAfter.includes(NEW_MODEL), idsAfter.slice(0, 8).join(','));
    check('手输进来的那一条标记为 custom (来源可辨, 不是混进 live)',
      (optAfter.json?.models || []).some((m: any) => String(m.id) === NEW_MODEL
        && String(m.origin || m.source || 'custom') !== 'live'),
      JSON.stringify((optAfter.json?.models || []).find((m: any) => String(m.id) === NEW_MODEL) || {}).slice(0, 200));

    // ── 断网/未接电脑端: 必须如实说, 不许编 ────────────────────────────
    await evaluate(`localStorage.removeItem('bolloon_desktop_base_url')`);
    const reloaded = await reloadPage();
    check('清掉电脑端基址后重新加载 (模拟手机自足模式)', reloaded === true);
    await openModelPage();
    const offlineCard = await readEffectiveCard();
    const offlineCatalog = await readCatalog();
    check('未接电脑端时如实说"读不到" (不显示任何编出来的默认模型)',
      /读不到|未接电脑端/.test(String(offlineCard?.note || '')) && offlineCard?.model === '—', JSON.stringify(offlineCard).slice(0, 240));
    check('未接电脑端时目录也如实说"读不到" (不假装有目录)',
      /读不到|未接电脑端/.test(String(offlineCatalog?.note || '')), offlineCatalog?.note);

    // 恢复基址, 供 §5 变异用
    await evaluate(`localStorage.setItem('bolloon_desktop_base_url', ${JSON.stringify(ORIGIN)})`);
    await reloadPage();

    // ════════════════════════════════════════════════════════════════════
    section('5. ③ 工具名净化后的行为对齐 (真 agent 环 + 出网抓包)');
    // 这一段的"服务端路径"= 手机端 `POST /message` 触发的那条: web 服务 → agent 会话
    //   (createAgentSession, 与 src/web/server.ts 的 /message 同一个构造函数)
    //   → 组装工具面 (registerBuiltinTools + registerContactTools + registerWalletTools)
    //   → getMinimax().chat(..., tools) → pi-ai 的唯一净化边界 → 真 HTTP 出网。
    const agentStub = await startStub(['stub-model-a'], 'contact_list_authorized');
    await CS.llmConfigStore.updateProvider('deepseek', {
      enabled: true, baseUrl: agentStub.baseUrl, model: 'stub-model-a', apiKey: 'stub-placeholder-not-a-real-key',
    });
    const PA: any = await import('../src/llm/pi-ai.js');
    PA.initMinimax({ provider: 'deepseek' as any, providerId: 'deepseek', apiKey: 'stub-placeholder-not-a-real-key', baseUrl: agentStub.baseUrl, model: 'stub-model-a' });
    const PA2: any = await import('../src/llm/tool-name.js');
    const { createAgentSession } = await import('../src/agents/pi-sdk.js');

    const agent: any = await createAgentSession({ cwd: ROOT, peerId: 'mobile-model-sync:' + Date.now(), agentId: 'mobile-model-sync' });
    await (agent.whenReady ? agent.whenReady() : Promise.resolve());
    const localNames: string[] = Array.from(agent.tools.keys());
    const dotted = localNames.filter((n) => !TOOL_PATTERN.test(n));
    check('本机工具注册表里**确实**有名字带点号的工具 (contact.* 一族, 旧名)', dotted.length >= 6,
      `${dotted.length} 个: ${dotted.slice(0, 6).join(', ')}`);
    check('这些旧名按 OpenAI 的硬约束是**非法**的 (所以净化是承重的, 不是装饰)',
      dotted.every((n) => !TOOL_PATTERN.test(n)) && dotted.includes('contact.list_authorized'));

    const steps: Array<{ tool: string; ok?: boolean }> = [];
    const ac = new AbortController();
    // 45s 就够: 工具调用发生在**第 1 轮** (假上游第一次就回 tool_call), 想要的证据 (出网报文 +
    //   轨迹里的工具名) 那时已经落袋。之后 agent 会一直"pong→继续循环"空转 (它的 needsMoreWork
    //   启发式认不出这轮结束), 没必要陪它跑满 —— abort 掉即可, 断言照旧。
    const timer = setTimeout(() => ac.abort(), 45_000);
    let promptErr = '';
    try {
      await agent.prompt('调用一个工具, 然后回答 pong', {
        signal: ac.signal,
        onStream: (ev: any) => {
          if (ev?.type === 'status' && ev?.tool) steps.push({ tool: String(ev.tool) });
          else if (ev?.type === 'step_done' && ev?.tool) {
            const last = [...steps].reverse().find((s) => s.tool === String(ev.tool) && s.ok === undefined);
            if (last) last.ok = ev.success !== false;
          }
        },
      });
    } catch (e: any) { promptErr = String(e?.message || e).slice(0, 200); }
    clearTimeout(timer);

    const withTools = agentStub.reqs.filter((r) => r.hasTools);
    const wireNames = withTools.flatMap((r) => r.toolNames);
    check('真 agent 环把工具面发出去了 (假上游收到带 tools 的请求, 真 HTTP)',
      withTools.length > 0 && wireNames.length > 20, `请求 ${withTools.length} 个 · 工具名 ${wireNames.length} 条${promptErr ? ' · prompt 报错: ' + promptErr : ''}`);
    check('★ 出网前**每一个**工具名都合法 (无点号/无空格/≤64)', wireNames.length > 0 && wireNames.every((n) => TOOL_PATTERN.test(n)),
      wireNames.filter((n) => !TOOL_PATTERN.test(n)).slice(0, 5).join(' | ') || `全部合法 (${wireNames.length} 条)`);
    check('★ 点号的旧名**一个都没出网** (contact.list_authorized 不在线上)', !wireNames.includes('contact.list_authorized')
      && wireNames.every((n) => !n.includes('.')), wireNames.filter((n) => n.includes('.')).slice(0, 5).join(' | ') || '(零带点号名)');
    check('★ 净化后的名字真的在线上 (contact_list_authorized 出现了)', wireNames.includes('contact_list_authorized'),
      wireNames.filter((n) => n.startsWith('contact_')).slice(0, 6).join(', '));
    check('本地注册表里的真名仍是带点的原名 (改写只发生在出网那一步)',
      agent.tools.has('contact.list_authorized') && !agent.tools.has('contact_list_authorized'));

    // 回程派发: 假上游回的 tool_call 用的是**净化后的名字**, 派发必须还原成真名
    const ranContact = steps.find((s) => s.tool === 'contact.list_authorized');
    check('★ 回程派发回到了**真实现**: 轨迹里的工具名是注册表真名 contact.list_authorized',
      !!ranContact, steps.map((s) => s.tool).slice(0, 8).join(' | ') || '(零工具步)');
    check('真实现真跑成功 (不是"未知工具"分支)',
      !!ranContact && ranContact.ok !== false, ranContact ? `ok=${ranContact.ok}` : '没跑到');
    const resolved = PA2.resolveApiToolName('contact_list_authorized');
    check('resolveApiToolName(线上名) === 注册表真名 (还原映射是活的)',
      resolved === 'contact.list_authorized', resolved);
    check('反事实: 若不做净化, 出网的会是非法名 → 400 (线上名通过而原名不通过)',
      TOOL_PATTERN.test('contact_list_authorized') && !TOOL_PATTERN.test('contact.list_authorized'));

    // ════════════════════════════════════════════════════════════════════
    section('6. ④ 版本标识单源派生 (package.json 是唯一数字源)');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const VER = String(pkg.version);
    const stamp = JSON.parse(fs.readFileSync(path.join(DIST_WEB, 'bolloon-web.json'), 'utf8'));
    check('web 构建戳的 version = package.json version (逐字)', stamp.version === VER, `${stamp.version} vs ${VER}`);
    check('web 构建戳写明了它的出处 (layer/note 都在)', stamp.layer === 'web' && typeof stamp.note === 'string' && stamp.note.length > 10);
    const swSrc = fs.readFileSync(path.join(ROOT, 'src/web/sw.js'), 'utf8');
    const swBuilt = fs.readFileSync(path.join(DIST_WEB, 'sw.js'), 'utf8');
    const swCache = (swBuilt.match(/const CACHE = '([^']+)';/) || [])[1] || '';
    check('★ 手机端 sw 缓存名 = 派生自包版本 (bolloon-mobile-v<version>)', swCache === `bolloon-mobile-v${VER}`, `${swCache} vs bolloon-mobile-v${VER}`);
    // ⚠️ 2026-09-26 收口修正: 这一条原来写成 `... || true` —— 恒真, 等于**没有断言** (标签声称的事一条都验不到)。
    //   改成真断言: 源码 sw.js 里不许出现「构建期才会派生出来的那个缓存名」, 否则构建期替换就失去了意义
    //   (源码已经是派生结果 ⇒ 以后改包版本, 源码里那个死数字会跟着骗人)。
    check('源码 sw.js 里**没有**第二个手写版本数字跟包版本并存 (缓存名由构建派生)',
      !swSrc.includes(`bolloon-mobile-v${VER}`),
      `src/web/sw.js 里出现了 bolloon-mobile-v${VER} —— 源码被写成了派生结果 (构建期替换形同虚设)`);
    check('源码 sw.js 里仍是占位来源 (构建期才被替换)', /const CACHE = 'bolloon-mobile-v[^']*';/.test(swSrc));
    const nativeRun = spawnSync('node', ['scripts/build-ios-web.mjs'], { cwd: ROOT, encoding: 'utf8' });
    check('scripts/build-ios-web.mjs 真跑成功 (它把原生壳版本从 package.json 派生)',
      nativeRun.status === 0, String(nativeRun.stdout || '').split('\n').slice(0, 3).join(' / ') + String(nativeRun.stderr || '').slice(0, 200));
    const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
    const pbx = fs.readFileSync(path.join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    const code = String(VER).split('.').map((n) => parseInt(n, 10)).reduce((a, b, i) => a + b * [10000, 100, 1][i], 0);
    check('★ Android versionName 与包版本一致 (构建派生, 不是手抄)', (gradle.match(/versionName\s+'([^']+)'/) || [])[1] === VER, (gradle.match(/versionName\s+'([^']+)'/) || [])[1]);
    check('★ Android versionCode 与包版本一致', (gradle.match(/versionCode\s+(\d+)/) || [])[1] === String(code), (gradle.match(/versionCode\s+(\d+)/) || [])[1]);
    const marketing = [...new Set([...pbx.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)].map((m) => m[1].trim()))];
    check('★ iOS MARKETING_VERSION 与包版本一致 (构建派生)', marketing.length === 1 && marketing[0] === VER, marketing.join('/'));
    const gateRun = spawnSync('node', ['scripts/check-native-artifacts.mjs'], { cwd: ROOT, encoding: 'utf8' });
    check('已有原生对齐门 check-native-artifacts.mjs 仍全绿 (没被这次派生改坏)',
      gateRun.status === 0, String(gateRun.stdout || '').split('\n').filter((l) => l.includes('❌')).join(' / ') || String(gateRun.stdout || '').slice(-200));
    const iosWeb = await fsp.readFile(path.join(ROOT, 'dist/ios', 'bolloon-web.json'), 'utf8').then((s) => JSON.parse(s)).catch(() => null);
    check('dist/ios 里的构建戳版本与包版本一致 (装机那层的身份)', iosWeb?.version === VER, iosWeb?.version);

    // ════════════════════════════════════════════════════════════════════
    section('7. 变异验证: 把 configHash 显示改成硬编码 → 门必须判红');
    // 现读服务端的**当前**指纹: §5 把 provider 重指到了另一个假上游 (端口不同 ⇒ 配置哈希不同),
    //   再拿 §1 那个旧值比就成了"比错基准" (第一次跑就是这么假红的)。变异前后都以现值为准。
    const effNow = await httpJson('GET', `${ORIGIN}/api/models/providers`);
    const hashNow = String(effNow.json?.effective?.configHash || '').slice(0, 8);
    const MOBILE_DIST = path.join(DIST_WEB, 'mobile.js');
    const backup = fs.readFileSync(MOBILE_DIST, 'utf8');
    try {
      const mutated = backup.replace(
        `      setText('#api-eff-hash', shortConfigHash(eff.configHash));`,
        `      setText('#api-eff-hash', 'deadbeef');`,
      );
      check('变异点定位成功 (mobile.js 里那一行真存在)', mutated !== backup);
      fs.writeFileSync(MOBILE_DIST, mutated, 'utf8');
      await reloadPage();
      const okOpen = await openModelPage();
      const mCard = await readEffectiveCard();
      const mutantRed = !(mCard?.hash === hashNow) && okOpen;
      check('★ 变异后 §3 的 configHash 断言真的判红 (门不是空转)', mutantRed,
        `变异后显示 "${mCard?.hash}", 服务端 "${hashNow}"`);
    } finally {
      fs.writeFileSync(MOBILE_DIST, backup, 'utf8');
      await reloadPage();
      await openModelPage();          // ⚠️ 重载会关掉模型页: 不重新点开, 读卡片只能读到 null
      const back = await readEffectiveCard();
      check('还原后 configHash 断言重新变绿 (证明红的只是变异本身)', back?.hash === hashNow, `${back?.hash} vs ${hashNow}`);
    }

    void optLive; void hasChrome; void optAfter; void beforeRefresh;
  } finally {
    try { if (chrome) chrome.kill('SIGKILL'); } catch { /* 已退 */ }
    try { if (srv) await new Promise<void>((r) => srv.close(() => r())); } catch { /* 已关 */ }
    try { await stub.close(); } catch { /* 已关 */ }
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`隔离 HOME (跑完不删, 便于事后核对): ${HOME_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('验收脚本自身抛错:', e); process.exit(1); });
