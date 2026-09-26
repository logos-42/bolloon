/**
 * verify-model-entrypoints.ts — 「所有入口得到同一份有效配置」验收 (2026-09-26, P6)
 *
 * ## 这道门主张什么
 *
 * 模型选择此前有**多套入口**: CLI 命令面、会话内 `/model`、Web 路由、Agent 配置工具、
 * 安装向导、长任务恢复 —— 各自"读一点配置 + 写一点配置 + 可能重建运行时"。P6 把它们收敛到
 * 同一个入口 `selectModel()`。这道门证明收敛**真的发生了**, 而且是在真进程 / 真 HTTP / 真上游上证明:
 *
 *   §2  入口 A: CLI 命令面 (`bolloon model ...`, 真 argv 真进程)
 *   §3  入口 B: 会话内 `/model` (index.ts 的 `/model` 段逐字调 `runModelCommand`, 真函数)
 *   §4  入口 C: Web 真路由 (真起 `createWebServer` + 真 POST)
 *   §5  自定义供应商进得了入口 (本轮补的那个缺口: 此前只按内置表校验 → 自定义 id 被判 invalid_provider)
 *   §6  五个新端点 + 旧接口转发 (旧接口是**转发到同一个函数**, 不是各写一遍)
 *   §7  命令面挂上了 P5 的发现能力 (refresh / list / admit / --clear, 且**上游真被打过**)
 *   §8  Agent 工具 / 向导 / 恢复路径也走同一入口 (源码级 + 恢复装配真跑)
 *   §9  三个入口切到**同一选择**后, 三个独立进程读回的 EffectiveModelConfig 逐字段相同 (含 configHash)
 *
 * ## 为什么要有假上游
 *
 * 打真上游要真凭据 (不能进仓) 且会引入网络假红。所以在 127.0.0.1 起一个 OpenAI 兼容假上游
 * (`scripts/lib/model-stub-server.ts`): 路由/协议/HTTP 都是真的, 只有"对面是谁"是假的,
 * 而且它记录"目录端点被命中几次"—— 这样"发现真的打了上游"才有证据, 不是空转。
 *
 * 用法: npx tsx scripts/verify-model-entrypoints.ts
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import http from 'node:http';
import { startModelStub, type StubServer } from './lib/model-stub-server.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = path.join(os.tmpdir(), `bolloon-model-entrypoints-${Date.now()}`);
const HOME_DIR = path.join(TMP, 'home');
const BOLLOON_HOME = path.join(HOME_DIR, '.bolloon');

// 隔离必须在**任何 src 模块被 import 之前**生效 (config-store 的路径在模块加载期算)
process.env.BOLLOON_HOME = BOLLOON_HOME;
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR;
delete process.env.DEEPSEEK_API_KEY;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(id: number, label: string, extra = ''): void {
  passed++;
  console.log(`  ✅ ${String(id).padStart(2, '0')} ${label}${extra ? ` — ${extra}` : ''}`);
}
function bad(id: number, label: string, why: string): void {
  failed++;
  failures.push(`${id} ${label}: ${why}`);
  console.log(`  ❌ ${String(id).padStart(2, '0')} ${label} — ${why}`);
}
function check(id: number, label: string, cond: boolean, extra = '', why = ''): void {
  if (cond) ok(id, label, extra);
  else bad(id, label, why || extra || '断言不成立');
}

const CHILD = 'scripts/lib/model-entrypoint-child.ts';
const CUSTOM_ID = 'stubgw';
const TARGET = { provider: CUSTOM_ID, model: 'stub-model-b' };

interface ChildOut { ok: boolean; [k: string]: any }

/**
 * 真起一个子进程并等它结束。
 *
 * **必须异步** (`spawn`, 不是 `spawnSync`): 假上游就跑在本进程里, 而 `spawnSync` 会把父进程的
 * 事件循环**整个堵住** —— 子进程去探测上游时就没人应答, 8s 超时判红。这不是被测代码的问题,
 * 是验收脚本自己的问题 (第一轮真跑就是被这个坑红的, 记在这儿免得下次再踩)。
 */
async function runProc(cmd: string, args: string[], timeoutMs = 240_000): Promise<{ code: number; stdout: string }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, BOLLOON_HOME, HOME: HOME_DIR, USERPROFILE: HOME_DIR },
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经死了 */ } }, timeoutMs);
    child.stdout?.on('data', (c) => (out += c));
    child.stderr?.on('data', (c) => (out += c));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out + String(e) }); });
  });
}

/** 跑一个入口子进程 (真进程; npx tsx) */
async function runChild(args: string[], timeoutMs = 240_000): Promise<{ code: number; stdout: string; out: ChildOut | null }> {
  const r = await runProc('npx', ['tsx', CHILD, HOME_DIR, BOLLOON_HOME, ...args], timeoutMs);
  const stdout = String(r.stdout || '');
  const line = stdout.split('\n').find((l) => l.startsWith('CHILD:')) || '';
  let out: ChildOut | null = null;
  if (line) { try { out = JSON.parse(line.slice('CHILD:'.length)); } catch { out = null; } }
  return { code: r.code, stdout, out };
}

/** 跑 CLI 命令面 (真 argv; src/cli-entry.ts 就是 `bolloon` 那个入口) */
async function runCli(args: string[], timeoutMs = 240_000): Promise<{ code: number; stdout: string }> {
  return await runProc('npx', ['tsx', 'src/cli-entry.ts', ...args], timeoutMs);
}

interface HttpOut { status: number; body: any; raw: string }
function httpJson(method: string, url: string, body?: any, timeoutMs = 120_000): Promise<HttpOut> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = d ? JSON.parse(d) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed, raw: d });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('http timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const EFFECTIVE_FIELDS = [
  'provider', 'model', 'baseUrl', 'protocol', 'authRef', 'reasoning',
  'reasoningMode', 'temperature', 'scope', 'source', 'configHash',
] as const;

function fieldDiff(a: any, b: any): string[] {
  const diff: string[] = [];
  for (const f of EFFECTIVE_FIELDS) {
    if (JSON.stringify(a?.[f]) !== JSON.stringify(b?.[f])) {
      diff.push(`${f}: ${JSON.stringify(a?.[f])} vs ${JSON.stringify(b?.[f])}`);
    }
  }
  return diff;
}

async function readSrc(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}
/** 只看代码不看注释 (否则"说明为什么要判红"的注释会被自己的门抓到) */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** 从一个源码位置切到下一个 `export`/函数边界, 拿到"这一段" */
function section(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = to ? src.indexOf(to, i + from.length) : -1;
  return j > i ? src.slice(i, j) : src.slice(i);
}

async function main(): Promise<void> {
  await fs.mkdir(BOLLOON_HOME, { recursive: true });

  // 假上游: 目录里两个模型, 认工具声明
  const stub = await startModelStub({ models: ['stub-model-a', 'stub-model-b'] });
  console.log(`\n════ 模型入口验收 (P6) · 假上游 http://127.0.0.1:${stub.port}/v1 ════\n`);

  // ── §1 环境自检 ────────────────────────────────────────────
  console.log('§1 环境自检');
  {
    const r = await httpJson('GET', `${stub.baseUrl}/models`);
    check(1, '假上游目录端点可达', r.status === 200 && Array.isArray(r.body?.data) && r.body.data.length === 2,
      `HTTP ${r.status} · ${r.body?.data?.length ?? '?'} 个模型`, `HTTP ${r.status}`);
    const homeStat = await fs.stat(BOLLOON_HOME).catch(() => null);
    check(2, '隔离 home 已建立 (BOLLOON_HOME 生效)', !!homeStat?.isDirectory(), BOLLOON_HOME);
  }

  // 预置配置: 一家内置 (deepseek, 地址指向假上游) + 一家**自定义** (stubgw)
  {
    const CS: any = await import('../src/llm/config-store.js');
    await CS.llmConfigStore.initialize();
    await CS.llmConfigStore.updateProvider('deepseek', {
      enabled: true, baseUrl: stub.baseUrl, model: 'stub-model-a', apiKey: 'stub-key-deepseek',
    });
    await CS.llmConfigStore.setCustomProviders({
      [CUSTOM_ID]: {
        providerId: CUSTOM_ID,
        displayName: '假上游网关',
        baseUrl: stub.baseUrl,
        protocol: 'openai-compatible',
        apiKey: 'stub-key-gw',
        model: 'stub-model-a',
        models: ['stub-model-a', 'stub-model-b'],
        capabilities: { toolCalling: 'yes', reasoning: 'no' },
      },
    });
    const cfg = await CS.llmConfigStore.getConfig();
    const customOk = !!cfg.customProviders?.[CUSTOM_ID];
    check(3, '预置: 内置 deepseek + 自定义 stubgw 都落盘', customOk && !!cfg.providers?.deepseek,
      `customProviders=${Object.keys(cfg.customProviders || {}).join(',') || '(空)'}`);
  }

  const REG: any = await import('../src/llm/provider-registry.js');
  const MS: any = await import('../src/llm/model-selection.js');
  const entry = REG.getProviderRegistryEntry(CUSTOM_ID);
  check(4, '注册表认识自定义供应商 (kind=custom, protocol=openai-compatible)',
    !!entry && entry.kind === 'custom' && entry.protocol === 'openai-compatible',
    entry ? `${entry.kind}/${entry.protocol}` : '注册表里没有它');
  check(5, '自定义 id 不在内置 13 家里 (所以"能被入口接受"不是靠内置表)',
    !['openai', 'anthropic', 'ollama', 'openrouter', 'gemini', 'minimax', 'deepseek', 'kimi', 'glm', 'qwen', 'mimo', 'grok', 'local'].includes(CUSTOM_ID));

  // ── §2 入口 A: CLI 命令面 (真 argv / 真进程) ────────────────
  console.log('\n§2 入口 A — CLI 命令面 `bolloon model`');
  {
    const base = await runCli(['model', 'deepseek', 'stub-model-a']);
    check(6, '① 先切到内置 deepseek/stub-model-a (基线, 真探测假上游)',
      /已切换到 deepseek/.test(base.stdout), base.stdout.split('\n').filter((l) => l.includes('当前生效'))[0]?.trim().slice(0, 80) || base.stdout.slice(-160));
    const beforeCfg = await fs.readFile(path.join(BOLLOON_HOME, 'bolloon-config.json'), 'utf8');

    const r = await runCli(['model', TARGET.provider, TARGET.model]);
    check(7, `② 真切到自定义供应商 ${TARGET.provider}/${TARGET.model}`,
      /已切换到 stubgw/.test(r.stdout) && r.stdout.includes('当前生效'),
      r.stdout.split('\n').filter((l) => l.includes('当前生效'))[0]?.trim().slice(0, 120) || r.stdout.slice(-200));

    const afterCfg = await fs.readFile(path.join(BOLLOON_HOME, 'bolloon-config.json'), 'utf8');
    const parsed = JSON.parse(afterCfg);
    check(8, '③ activeProvider 落成自定义 id (不是内置那家)',
      parsed.activeProvider === CUSTOM_ID && !!(parsed.providers || {})[CUSTOM_ID],
      `activeProvider=${parsed.activeProvider}`);
    check(9, '④ 写盘真的发生了 (配置字节变了)', beforeCfg !== afterCfg);

    const read = await runChild(['effective']);
    check(10, '⑤ 独立进程读回同一份 (CLI 入口)',
      !!read.out?.effective && read.out.effective.provider === CUSTOM_ID && read.out.effective.model === TARGET.model,
      `${read.out?.effective?.provider}/${read.out?.effective?.model} · hash=${String(read.out?.effective?.configHash).slice(0, 12)}`);
    (globalThis as any).__E_A = read.out?.effective;
  }

  // ── §3 入口 B: 会话内 `/model` ─────────────────────────────
  console.log('\n§3 入口 B — 会话内 `/model` (index.ts 那个调用形状)');
  {
    // 先制造"漂移": 切回内置那家, 再让会话内的 /model 切回目标 —— 这样"读到的一样"不是"没人动过"
    await runCli(['model', 'deepseek', 'stub-model-a']);

    const r = await runChild(['session', 'status']);
    check(11, '`/model status` 真跑 (会话形状的 io: 只给 choose)',
      r.out?.ok === true && /当前生效/.test(String(r.out?.printed || '')),
      String(r.out?.printed || '').split('\n')[0]?.slice(0, 100));

    const sw = await runChild(['session', TARGET.provider, TARGET.model]);
    check(12, `会话内 \`/model ${TARGET.provider} ${TARGET.model}\` 切换成功`,
      sw.out?.ok === true && /已切换到 stubgw/.test(String(sw.out?.printed || '')),
      String(sw.out?.printed || '').split('\n').filter((l) => l.includes('当前生效'))[0]?.slice(0, 120) || String(sw.out?.printed || '').slice(-200));

    const read = await runChild(['effective']);
    check(13, '独立进程读回同一份 (会话入口)',
      !!read.out?.effective && read.out.effective.provider === CUSTOM_ID && read.out.effective.model === TARGET.model,
      `${read.out?.effective?.provider}/${read.out?.effective?.model}`);
    (globalThis as any).__E_B = read.out?.effective;

    // 源码级: 会话内的 /model 段就是调命令面那一个函数, 自己不动配置
    // 注意: 先在**原文**上切段再剥注释 —— 否则标记 `// /model —` 自己就被 stripComments 删了
    const idxRaw = await readSrc('src/index.ts');
    const block = stripComments(section(idxRaw, '// /model —', '// /questions —'));
    check(14, '源码级: 会话内 /model 段调用 runModelCommand 且自己不动配置/运行时',
      block.includes('runModelCommand(') && !block.includes('updateProvider(') && !block.includes('setActiveProvider(') && !block.includes('initMinimax('),
      `段长 ${block.length} 字符`);
  }

  // ── §4 入口 C: Web 真路由 ──────────────────────────────────
  console.log('\n§4 入口 C — Web 真路由 (真起 createWebServer)');
  const web = { ready: false, port: 0, mode: '' as '' | 'server' | 'inproc', child: null as any };
  {
    // 真起服务: 子进程里 createWebServer(PORT) —— 冷启动慢, 用健康检查等它 (不猜时间)
    const port = 43300 + Math.floor(Math.random() * 400);
    const { spawn } = await import('child_process');
    const child = spawn('npx', ['tsx', 'scripts/lib/model-web-boot.ts'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port), BOLLOON_HOME, HOME: HOME_DIR, USERPROFILE: HOME_DIR }, stdio: 'ignore',
    });
    web.child = child;
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline) {
      try {
        const r = await httpJson('GET', `http://127.0.0.1:${port}/api/models/providers`, undefined, 8000);
        if (r.status === 200) { web.ready = true; web.mode = 'server'; break; }
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 700));
    }
    web.port = port;
    check(15, '真起 web 服务 (PORT 环境变量, 真 HTTP 200)', web.ready,
      web.ready ? `端口 ${port}` : `210s 内没就绪 → 后面走"同进程挂真路由"并如实标注`);
  }

  // in-process 兜底: 真 express + 真 HTTP 监听 + 真 registerLlmConfigRoutes (只是不跑 server.ts 的 P2P 引导)
  let inproc: { url: string; close: () => Promise<void> } | null = null;
  if (!web.ready) {
    const expressMod: any = await import('express');
    const express = expressMod.default || expressMod;
    const { registerLlmConfigRoutes } = await import('../src/web/routes-llm-config.js');
    const app = express();
    app.use(express.json());
    registerLlmConfigRoutes(app);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const p = (srv.address() as any).port;
    inproc = { url: `http://127.0.0.1:${p}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
    web.mode = 'inproc';
    console.log(`  · 兜底: 同进程挂真路由 + 真 HTTP 监听 @ ${p}`);
  }
  const WEB_URL = inproc ? inproc.url : `http://127.0.0.1:${web.port}`;

  try {
    // 五个端点
    const providers = await httpJson('GET', `${WEB_URL}/api/models/providers`);
    check(16, 'GET /api/models/providers → 200, 列出内置 + 自定义, 并给出注册表事实',
      providers.status === 200 && providers.body?.ok === true
        && Array.isArray(providers.body?.registry) && providers.body.registry.some((e: any) => e.id === CUSTOM_ID)
        && !!providers.body?.effective,
      `providers=${providers.body?.count ?? '?'} · registry=${(providers.body?.registry || []).length}`);

    const options = await httpJson('GET', `${WEB_URL}/api/models/options?provider=${CUSTOM_ID}`);
    check(17, 'GET /api/models/options?provider=<自定义> → 200, 有模型清单',
      options.status === 200 && options.body?.ok === true && Array.isArray(options.body?.models) && options.body.models.length > 0,
      `models=${(options.body?.models || []).map((m: any) => m.id).slice(0, 4).join(',')}`);

    const badProvider = await httpJson('GET', `${WEB_URL}/api/models/options?provider=no-such-provider`);
    check(18, 'GET /api/models/options?provider=<不存在> → 404 (不编一家出来)',
      badProvider.status === 404 && badProvider.body?.failureClass === 'invalid_provider',
      `HTTP ${badProvider.status}`);

    stub.reset();
    const test = await httpJson('POST', `${WEB_URL}/api/models/test`, { provider: CUSTOM_ID, model: 'stub-model-a' });
    check(19, 'POST /api/models/test → 真探测 (假上游被打到, 工具调用=yes)',
      test.status === 200 && test.body?.ok === true && test.body?.toolCalling === 'yes' && stub.catalogHits() > 0,
      `toolCalling=${test.body?.toolCalling} · 目录端点命中 ${stub.catalogHits()} 次`);

    // 先漂走, 再让 Web 切回目标
    await runCli(['model', 'deepseek', 'stub-model-a']);
    const sel = await httpJson('POST', `${WEB_URL}/api/models/select`, TARGET);
    check(20, 'POST /api/models/select (自定义供应商) → 200 + 返回真生效配置',
      sel.status === 200 && sel.body?.ok === true && sel.body?.effective?.provider === CUSTOM_ID && sel.body?.effective?.model === TARGET.model,
      `${sel.body?.effective?.provider}/${sel.body?.effective?.model} · hash=${String(sel.body?.effective?.configHash).slice(0, 12)}`);

    const read = await runChild(['effective']);
    check(21, '独立进程读回同一份 (Web 入口)',
      !!read.out?.effective && read.out.effective.provider === CUSTOM_ID && read.out.effective.model === TARGET.model,
      `${read.out?.effective?.provider}/${read.out?.effective?.model}`);
    (globalThis as any).__E_C = read.out?.effective;

    stub.reset();
    const disc = await httpJson('POST', `${WEB_URL}/api/models/discover`, { provider: CUSTOM_ID, action: 'refresh' });
    check(22, 'POST /api/models/discover {action:refresh} → 真打上游目录端点',
      disc.status === 200 && disc.body?.ok === true && stub.catalogHits() > 0
        && Array.isArray(disc.body?.catalog?.models) && disc.body.catalog.models.includes('stub-model-a'),
      `目录端点命中 ${stub.catalogHits()} 次 · models=${(disc.body?.catalog?.models || []).slice(0, 3).join(',')}`);

    const discList = await httpJson('POST', `${WEB_URL}/api/models/discover`, { action: 'list', provider: CUSTOM_ID });
    check(23, 'POST /api/models/discover {action:list} → 200 有清单',
      discList.status === 200 && discList.body?.ok === true && Array.isArray(discList.body?.listing?.entries),
      `entries=${discList.body?.listing?.entries?.length ?? '?'}`);

    const discClear = await httpJson('POST', `${WEB_URL}/api/models/discover`, { action: 'clear', provider: CUSTOM_ID });
    check(24, 'POST /api/models/discover {action:clear} → 清缓存 (返回清了几条)',
      discClear.status === 200 && discClear.body?.ok === true && typeof discClear.body?.cleared === 'number',
      `cleared=${discClear.body?.cleared}`);

    const discBad = await httpJson('POST', `${WEB_URL}/api/models/discover`, { provider: 'nope-nope', action: 'refresh' });
    check(25, 'POST /api/models/discover {未知供应商} → 404 (入口不放过垃圾)',
      discBad.status === 404 && discBad.body?.failureClass === 'invalid_provider', `HTTP ${discBad.status}`);
  } catch (e: any) {
    bad(16, 'Web 端点一组', String(e?.message || e).slice(0, 200));
  }

  // ── §5 自定义供应商进得了入口 (缺口㈡) ──────────────────────
  console.log('\n§5 自定义供应商 / 垃圾 id');
  {
    const eff = (globalThis as any).__E_C;
    check(26, '入口返回的 protocol 来自注册表声明 (不是内置表猜的)',
      eff?.protocol === entry.protocol, `${eff?.protocol} vs ${entry?.protocol}`);
    const r = await runChild(['session', 'no-such-provider', 'm']);
    check(27, '未知供应商 → invalid_provider (不静默退回默认)',
      /供应商不存在/.test(String(r.out?.printed || '')) || /invalid_provider/.test(String(r.out?.printed || '')),
      String(r.out?.printed || '').split('\n')[0]?.slice(0, 120));
  }

  // ── §6 旧接口兼容但内部转发 ────────────────────────────────
  console.log('\n§6 旧接口转发 (同一函数) + 五个端点齐全');
  {
    const routes = stripComments(await readSrc('src/web/routes-llm-config.ts'));
    const selects = routes.split('selectModel(').length - 1;
    check(28, '源码级: 整个 Web 路由里 `selectModel(` 只有一处 (runModelSelect 内部)',
      selects === 1, `出现 ${selects} 次`);
    for (const [id, ep, label] of [
      [29, '/api/models/providers', 'providers'],
      [30, '/api/models/options', 'options'],
      [31, '/api/models/test', 'test'],
      [32, '/api/models/select', 'select'],
      [33, '/api/models/discover', 'discover'],
    ] as const) {
      check(id, `端点 ${label} 已注册 (${ep})`, routes.includes(ep));
    }
    const legacyProvider = section(routes, "app.post('/api/llm-provider'", "app.post('/api/models/discover'");
    check(34, '源码级: 旧 /api/llm-provider 转发到 runModelSelect (不自己写配置)',
      legacyProvider.includes('runModelSelect(') && !legacyProvider.includes('setActiveProvider(') && !legacyProvider.includes('updateProvider('));
    const legacyConfig = section(routes, "app.post('/api/llm-config'", "app.post('/api/llm-provider'");
    check(35, '源码级: 旧 /api/llm-config 的激活分支也转发到 runModelSelect',
      legacyConfig.includes('runModelSelect('), `段长 ${legacyConfig.length}`);
    check(36, '源码级: 旧 /api/llm-test 转发到同一个探测函数',
      section(routes, "app.post('/api/llm-test'", "app.post('/api/models/providers'").includes('runModelTest('));

    // 真跑: 旧接口真转发
    const lg = await httpJson('POST', `${WEB_URL}/api/llm-provider`, { provider: CUSTOM_ID, model: 'stub-model-a' });
    check(37, '真跑: POST /api/llm-provider → 200 ok + effective (真转发到入口)',
      lg.status === 200 && lg.body?.ok === true && lg.body?.effective?.model === 'stub-model-a' && lg.body?.legacy === 'llm-provider',
      `${lg.body?.effective?.model} · legacy=${lg.body?.legacy}`);

    const lgTest = await httpJson('POST', `${WEB_URL}/api/llm-test`, { provider: CUSTOM_ID, model: 'stub-model-a' });
    check(38, '真跑: POST /api/llm-test → 200 (转发到同一探测函数, 有 legacy 标记)',
      lgTest.status === 200 && lgTest.body?.ok === true && lgTest.body?.legacy === 'llm-test',
      `HTTP ${lgTest.status} · ok=${lgTest.body?.ok}`);

    // 旧接口**绕不过**入口: 探测没过 → 409, 且盘上配置一个字节没变
    const before = await fs.readFile(path.join(BOLLOON_HOME, 'bolloon-config.json'), 'utf8');
    const fail = await httpJson('POST', `${WEB_URL}/api/llm-provider`, { provider: CUSTOM_ID, model: 'stub-model-a', baseUrl: 'http://127.0.0.1:1/v1' });
    const after = await fs.readFile(path.join(BOLLOON_HOME, 'bolloon-config.json'), 'utf8');
    check(39, '真跑: 旧接口探测没过 → 409 + 盘上配置字节不变 (绕不过入口)',
      fail.status === 409 && fail.body?.ok === false && before === after,
      `HTTP ${fail.status} · failureClass=${fail.body?.failureClass} · 配置${before === after ? '未变' : '被改了!'}`);

    const lgCfg = await httpJson('POST', `${WEB_URL}/api/llm-config`, { provider: CUSTOM_ID, config: { enabled: true, model: TARGET.model, baseUrl: stub.baseUrl, temperature: 0.2 } });
    check(40, '真跑: POST /api/llm-config → 转发入口并标 autoActivated',
      lgCfg.status === 200 && lgCfg.body?.ok === true && lgCfg.body?.autoActivated === true && lgCfg.body?.effective?.model === TARGET.model,
      `autoActivated=${lgCfg.body?.autoActivated} · model=${lgCfg.body?.effective?.model}`);
  }

  // ── §7 命令面挂上 P5 的发现能力 ────────────────────────────
  console.log('\n§7 命令面 × P5 发现能力 (refresh / list / admit / --clear)');
  const CMD_SRC_CACHE = stripComments(await readSrc('src/cli/setup-wizard.ts'));
  {
    const before = stub.catalogHits();
    const ref = await runChild(['discover', 'refresh', CUSTOM_ID]);
    check(41, '`/model refresh <provider>` 真去上游取目录 (上游命中数增加)',
      ref.out?.ok === true && stub.catalogHits() > before && /模型目录已刷新/.test(String(ref.out?.printed || '')),
      `上游目录端点命中 ${before} → ${stub.catalogHits()}`);

    const list = await runChild(['discover', 'list', CUSTOM_ID]);
    check(42, '`/model list <provider>` 打印发现目录 (含上游模型 id)',
      list.out?.ok === true && String(list.out?.printed || '').includes('stub-model-a'),
      String(list.out?.printed || '').split('\n').slice(0, 3).join(' / ').slice(0, 140));

    const all = await runChild(['discover', 'list']);
    check(43, '`/model list` (不带 provider) 给全量汇总',
      all.out?.ok === true && /模型目录/.test(String(all.out?.printed || '')),
      String(all.out?.printed || '').split('\n')[0]?.slice(0, 120));

    const admit = await runChild(['discover', 'admit', CUSTOM_ID, 'my-manual-model-1']);
    const listAfter = await runChild(['discover', 'list', CUSTOM_ID]);
    check(44, '手输模型 → `admitManualModel` 进发现缓存, 且 list 里看得到',
      admit.out?.ok === true && String(admit.out?.printed || '').includes('my-manual-model-1')
        && String(listAfter.out?.printed || '').includes('my-manual-model-1'),
      String(admit.out?.printed || '').split('\n')[0]?.slice(0, 120));

    const cleared = await runChild(['discover', 'refresh', '--clear']);
    check(45, '`/model refresh --clear` 清发现缓存 (报清了几条)',
      cleared.out?.ok === true && /已清掉发现缓存/.test(String(cleared.out?.printed || '')) && !listedAfterClear(cleared),
      String(cleared.out?.printed || '').split('\n')[0]?.slice(0, 120));

    check(46, '源码级: 命令面确实调 P5 的函数 (不是自己重写一遍)',
      ['refreshModelDiscovery(', 'clearDiscoveryCache(', 'listModelCatalog(', 'admitManualModel(']
        .every((f) => stripComments(String(CMD_SRC_CACHE)).includes(f)));
  }

  // ── §8 Agent 工具 / 向导 / 恢复 也走同一入口 ────────────────
  console.log('\n§8 Agent 工具 / 向导 / 恢复路径');
  {
    const tools = stripComments(await readSrc('src/agents/pi-sdk-tools.ts'));
    const setTool = section(tools, "ctx.tools.set('bolloon_config_set'", "ctx.tools.set('bolloon_next_gen");
    check(47, '源码级: Agent 配置工具走 selectModel, 不自己 setActiveProvider',
      setTool.includes('selectModel(') && !setTool.includes('setActiveProvider('), `段长 ${setTool.length}`);

    const onboard = stripComments(await readSrc('src/setup/onboard.ts'));
    check(48, '源码级: 向导运行时步骤不再自己 initMinimax (改走统一入口装配)',
      !section(onboard, 'const stepRuntime', 'export const ONBOARD_STEPS').includes('initMinimax(')
        && section(onboard, 'const stepRuntime', 'export const ONBOARD_STEPS').includes('applyEffectiveToRuntime('));
    check(49, '源码级: 向导不再自己 setActiveProvider (激活走统一入口)',
      !onboard.includes('setActiveProvider('));

    const wizard = stripComments(await readSrc('src/cli/setup-wizard.ts'));
    check(50, '源码级: runSetupWizard 参数式切配置走 selectModel, 不自己 setActiveProvider',
      section(wizard, 'export async function runSetupWizard', 'export interface ModelCommandIO').includes('selectModel')
        && !section(wizard, 'export async function runSetupWizard', 'export interface ModelCommandIO').includes('setActiveProvider('));

    const pi = stripComments(await readSrc('src/agents/pi-sdk.ts'));
    const resume = section(pi, 'async resumeRun(', 'private piHarness()');
    check(51, '源码级: 恢复路径按 Run 快照装配 (applyRunModelConfigToRuntime), 不自己 initMinimax',
      resume.includes('applyRunModelConfigToRuntime(') && !resume.includes('initMinimax('));

    // 真跑恢复装配: 造一条带快照的 Run → 把全局切走 → 按快照装回去 → 与快照逐字相同
    const RS: any = await import('../src/agents/run-store.js');
    await runCli(['model', TARGET.provider, TARGET.model]);
    const snap = await MS.captureRunModelConfig();
    const rec = await RS.startRun({ surface: 'cli', goal: 'P6 恢复路径验收: 按 Run 快照装配运行时', modelConfig: snap });
    await runCli(['model', 'deepseek', 'stub-model-a']);   // 全局漂走
    const res = await runChild(['resume', rec.runId]);
    const applied = res.out?.applied;
    const snapDiff = [
      ['provider', applied?.provider, snap.provider],
      ['model', applied?.model, snap.model],
      ['baseUrl', applied?.baseUrl, snap.baseUrl],
      ['configHash', applied?.configHash, snap.configHash],
    ].filter(([, a, b]) => a !== b);
    check(52, '真跑: 恢复装配用的是 Run **自己那份**快照 (provider/model/baseUrl/configHash 全同)',
      res.out?.ok === true && snapDiff.length === 0,
      (snapDiff.length ? snapDiff.map(([f, a, b]) => `${f}: ${a} vs ${b}`).join('; ') : `${applied?.provider}/${applied?.model} hash=${String(applied?.configHash).slice(0, 12)}`)
        + (res.out?.ok === true ? '' : ` · 子进程说: ${String(res.stdout).replace(/\s+/g, ' ').slice(-240)}`));

    const now = (await MS.effectiveModelConfig({})).provider;
    check(53, '真跑: 恢复装配**没有**改全局默认 (改的只是运行时)', now === 'deepseek', `全局仍是 ${now}`);
  }

  // ── §9 三个入口同一份配置 ──────────────────────────────────
  console.log('\n§9 三个入口 → 同一份有效配置');
  {
    const E_A = (globalThis as any).__E_A;
    const E_B = (globalThis as any).__E_B;
    const E_C = (globalThis as any).__E_C;
    check(54, '三个入口都产出了有效配置 (CLI / 会话 / Web)',
      !!E_A && !!E_B && !!E_C, `hash: A=${String(E_A?.configHash).slice(0, 12)} B=${String(E_B?.configHash).slice(0, 12)} C=${String(E_C?.configHash).slice(0, 12)}`);
    const dAB = fieldDiff(E_A, E_B);
    const dAC = fieldDiff(E_A, E_C);
    check(55, '入口 A (CLI) ≡ 入口 B (会话): 11 个字段逐字段相同', dAB.length === 0, dAB.join('; '));
    check(56, '入口 A (CLI) ≡ 入口 C (Web): 11 个字段逐字段相同', dAC.length === 0, dAC.join('; '));
    check(57, 'configHash 三者相同 (同一份配置的指纹)',
      !!E_A?.configHash && E_A.configHash === E_B?.configHash && E_A.configHash === E_C?.configHash,
      String(E_A?.configHash));
    check(58, '三个入口选中的是**同一个选择** (自定义供应商那一家)',
      E_A?.provider === CUSTOM_ID && E_B?.provider === CUSTOM_ID && E_C?.provider === CUSTOM_ID,
      `${E_A?.provider}/${E_B?.provider}/${E_C?.provider}`);
  }

  // ── §10 新增产物不带外部 Agent 平台表述 ─────────────────────
  console.log('\n§10 新增产物自检');
  {
    const files = [
      'scripts/verify-model-entrypoints.ts',
      'scripts/lib/model-stub-server.ts',
      'scripts/lib/model-entrypoint-child.ts',
    ];
    const hits: string[] = [];
    for (const f of files) {
      const s = await readSrc(f);
      // 黑名单**分段拼**: 整词静态写在文件里的话, 这段检查自己的字面量就会把自己判红 (第一轮真跑踩过)
      const banned = [['Her', 'mes'], ['Her', 'mes Agent']].map((a) => a.join(''));
      for (const bad of banned) {
        if (s.includes(bad)) hits.push(`${f}:${bad.split('').length}字词`);
      }
    }
    check(59, '新增产物里没有外部 Agent 平台的表述', hits.length === 0, hits.join(', '));
  }

  // 收尾
  try { inproc && await inproc.close(); } catch { /* 无所谓 */ }
  try { web.child?.kill('SIGTERM'); } catch { /* 无所谓 */ }
  try { await stub.close(); } catch { /* 无所谓 */ }

  console.log('\n' + '='.repeat(64));
  console.log(`verify-model-entrypoints: ${passed} passed / ${failed} failed`);
  if (failed) {
    console.log('失败项:');
    for (const f of failures) console.log(`  · ${f}`);
    console.log(`(隔离 home: ${BOLLOON_HOME})`);
    process.exit(1);
  }
  console.log(`Web 入口模式: ${web.mode === 'server' ? '真起 createWebServer' : '同进程挂真路由'}`);
  console.log(`(隔离 home: ${BOLLOON_HOME})`);
  process.exit(0);
}

/** `/model refresh --clear` 的输出里若还声称有缓存命中, 就不算真清 */
function listedAfterClear(out: { out: ChildOut | null }): boolean {
  const text = String(out.out?.printed || '');
  return /缓存命中|缓存已过期/.test(text);
}

main().catch((e) => {
  console.error('verify-model-entrypoints 崩了:', e);
  process.exit(2);
});
