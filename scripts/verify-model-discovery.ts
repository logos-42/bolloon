/**
 * verify-model-discovery.ts — 「模型发现与缓存」真跑验收 (P5, 2026-09-26)
 *
 * 真跑的含义: 本地起**真 HTTP 服务器**扮演模型服务 (正常 / 401 / 500 / 挂起 / 空清单 / 垃圾形状 /
 * gemini 形状); 配置与缓存都走**真文件**; 跨进程用**真子进程**读回; 变异把关键行为改坏确认门**承重**。
 *
 * 覆盖:
 *   V1  已认证 → 真取 `/models`: `live` + 写缓存 (键 = provider+baseUrl+凭证指纹)
 *   V2  有效期: 新鲜期内命中 (零网络), 过期/`force` → 真再取
 *   V3  401: `auth_failed`, **不是空目录**, 不写缓存, provider 仍在
 *   V4  500 → 用上次成功缓存 (`cached` + `unavailable` 结论 + 原因 + 标过期)
 *   V5  挂起服务器 → `timeout` 分类, 仍回退上次成功缓存
 *   V6  从未成功 → 内置目录 (`curated`); 连目录都没有 → `unavailable` + 原因
 *   V7  **两个不同 key 不共用一份缓存** (同名 provider / 同 baseUrl / 只有凭证身份不同)
 *   V8  自定义模型**手动输入** (`custom`), 断网后仍在, 可撤销
 *   V9  五种标记 (live/cached/curated/custom/unavailable) **全部在本轮真跑里出现过**
 *   V10 发现失败**不删 provider** (全册长度 = 注册表长度)
 *   V11 元数据填充点: 真目录的能力字段端到端进 `model-catalog.ModelEntry`, 没有的不编
 *   V12 跨进程: 真子进程读同一份缓存, 指纹一致
 *   V13 凭据: 缓存/列表/理由/URL 里没有明文 key (含 gemini 的 `?key=` 那一类)
 *   V14 命令面能力 (可调用函数): `/model refresh` · `/model list` · `/model list <provider>`
 *   V15 变异: 4 条改写, 逐条**判红** (落盘 hash 先变, 再跑聚焦测试)
 *
 * 用法: npx tsx scripts/verify-model-discovery.ts            (含变异)
 *       npx tsx scripts/verify-model-discovery.ts --no-mutations
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-discovery-verify-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// 清掉可能"假装已配好凭证"的环境变量, 让判定只取决于配置文件
for (const k of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY',
  'QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'XAI_API_KEY', 'MIMO_API_KEY', 'MINIMAX_API_KEY', 'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL', 'MIMO_BASE_URL']) {
  process.env[k] = '';
}

const ROOT = process.cwd();
const KEY_A = 'verify-cred-alpha-1111';
const KEY_B = 'verify-cred-bravo-2222';
const SELF = 'src/llm/model-discovery.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
/** 所有打印过的行 —— 最后统一核对"里面没有 key 明文" */
const printed: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  const line = `  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`;
  printed.push(line);
  if (cond) { passed++; console.log(line); }
  else { failed++; failures.push(name); console.log(line); }
}
function section(t: string): void {
  const line = `\n[${t}]`;
  printed.push(line);
  console.log(line);
}
function sha(file: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return 'missing'; }
}
function tail(s: string): string { return `****${String(s).slice(-4)}`; }

// ── 真本地假模型服务 ─────────────────────────────────────────────

type StubMode =
  | { kind: 'models'; body: unknown }
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'hang' };

interface Hit { method: string; url: string; auth: string; query: string }

interface Stub {
  port: number;
  baseUrl: string;
  hits: Hit[];
  setMode(m: StubMode): void;
  setExpectedKey(k: string | null): void;
  setEchoKey(v: boolean): void;
  close(): Promise<void>;
}

function startStub(): Promise<Stub> {
  let mode: StubMode = { kind: 'models', body: { object: 'list', data: [] } };
  let expectedKey: string | null = null;
  let echoKey = false;
  const hits: Hit[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const auth = String(req.headers.authorization || '');
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    hits.push({ method: req.method || '', url, auth, query });
    if (mode.kind === 'hang') return;                      // 永不响应 → 客户端超时
    const queryKey = /(?:^|&)key=([^&]*)/.exec(query)?.[1] || '';
    const headerKey = String(req.headers['x-goog-api-key'] || '');
    const cameWithKey = expectedKey === null
      || auth === `Bearer ${expectedKey}`
      || headerKey === expectedKey
      || decodeURIComponent(queryKey) === expectedKey;
    if (!cameWithKey) {
      const leaked = echoKey ? ` — 收到的凭据是 ${auth.replace('Bearer ', '') || headerKey || queryKey}` : '';
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `bad or missing api key${leaked}` } }));
      return;
    }
    if (mode.kind === 'status') {
      res.writeHead(mode.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mode.body ?? { error: { message: `upstream says ${mode.status}` } }));
      return;
    }
    if (/\/models(\?|$)/.test(url) || /\/api\/tags(\?|$)/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mode.body));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${url}` } }));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits,
        setMode: (m) => { mode = m; },
        setExpectedKey: (k) => { expectedKey = k; },
        setEchoKey: (v) => { echoKey = v; },
        close: () => new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.close(() => r());
        }),
      });
    });
  });
}

/** 真子进程: 只 import 发现层, 读同一份缓存后打印一行 JSON */
function childJson(home: string, body: string): any {
  const script = `(async () => {${body}})();`;
  const r = spawnSync('npx', ['tsx', '-e', script], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, BOLLOON_HOME: home, HOME: home, USERPROFILE: home },
    timeout: 180_000,
  });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD:'));
  if (!line) throw new Error(`子进程没输出 (exit=${r.status}): ${String(r.stderr || '').slice(-400)}`);
  return JSON.parse(line.slice('CHILD:'.length));
}

const refusingFetch = (async () => {
  const e: any = new Error('connect ECONNREFUSED 127.0.0.1:1');
  e.code = 'ECONNREFUSED';
  throw e;
}) as any;

async function main(): Promise<void> {
  const MD: any = await import('../src/llm/model-discovery.js');
  const CS: any = await import('../src/llm/config-store.js');
  const MC: any = await import('../src/llm/model-catalog.js');
  const PR: any = await import('../src/llm/provider-registry.js');
  const STORE: any = await import('../src/llm/custom-provider-store.js');

  const CFG = path.join(HOME, 'bolloon-config.json');
  const writeConfig = async (providers: Record<string, any>, activeProvider = 'deepseek') => {
    fs.writeFileSync(CFG, JSON.stringify({ activeProvider, providers, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    CS.llmConfigStore.invalidate();
    await CS.llmConfigStore.initialize();
  };

  const server = await startStub();
  const seenOrigins = new Set<string>();
  const seenStates = new Set<string>();

  try {
    // ────────────────────────────────────────────────────────
    section('V1 已认证 → 真取 /models (live + 写缓存, 键含凭证指纹)');

    await MD.clearDiscoveryCache();
    server.setExpectedKey(KEY_A);
    server.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'gw-a1' }, { id: 'gw-a2' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: server.baseUrl, model: 'gw-a1' } });

    const live = await MD.discoverProviderModels('deepseek');
    seenOrigins.add(live.origin); seenStates.add(live.discoveryState);
    ok('真取到目录 → origin=live / discoveryState=live', live.origin === 'live' && live.discoveryState === 'live', live.origin);
    ok('清单 = 端点真回的那两个 (逐字)', JSON.stringify(live.models) === JSON.stringify(['gw-a1', 'gw-a2']), live.models.join(','));
    ok('端点 = 配置里的 baseUrl + /models (不再有隐藏 URL)',
      live.endpoint === `${server.baseUrl}/models`, live.endpoint);
    ok('baseUrl 来源 = 配置层 (四层优先级的第二层)', live.baseUrlSource === 'configured', String(live.baseUrlSource));
    ok('服务器真收到 GET /models', server.hits.some((h) => h.method === 'GET' && h.url.endsWith('/models')),
      `${server.hits.length} 次命中`);
    ok('认证头真发出去 (只显示尾号)', server.hits[server.hits.length - 1].auth === `Bearer ${KEY_A}`, tail(KEY_A));
    ok('凭证身份**只是指纹**', /^fp:[0-9a-f]{16}$/.test(live.credentialIdentity) && live.credentialIdentity === MD.credentialIdentityOf(KEY_A),
      live.credentialIdentity);
    ok('缓存键 = hash(provider + baseUrl + 凭证身份)',
      live.cacheKey === MD.discoveryCacheKey('deepseek', server.baseUrl, live.credentialIdentity), live.cacheKey);

    const cacheFile = await MD.readDiscoveryCache();
    const entries = Object.values(cacheFile.entries) as any[];
    ok('缓存真落盘 (1 条), 里有模型清单与 lastSuccessAt',
      entries.length === 1 && JSON.stringify(entries[0].models) === JSON.stringify(['gw-a1', 'gw-a2']) && !!entries[0].lastSuccessAt);
    ok('缓存文件权限 0600', (fs.statSync(MD.discoveryCachePath()).mode & 0o777) === 0o600);
    const cacheText = fs.readFileSync(MD.discoveryCachePath(), 'utf-8');
    ok('缓存文件里**没有** key 明文 (也没有 8 位切片)',
      !cacheText.includes(KEY_A) && !MD.discoveryCacheLeaks(cacheFile, KEY_A) && !MD.discoveryCacheLeaks(cacheText, KEY_A));
    ok('缓存记录里的凭证身份 = 指纹 (不是明文)',
      entries[0].credentialIdentity === live.credentialIdentity && !String(entries[0].credentialIdentity).includes(KEY_A));

    // ────────────────────────────────────────────────────────
    section('V2 有效期: 新鲜期内命中 (零网络), 过期或 force → 真再取');

    const hitsBefore = server.hits.length;
    const cached = await MD.discoverProviderModels('deepseek');
    seenOrigins.add(cached.origin); seenStates.add(cached.discoveryState);
    ok('新鲜期内再问 → cached, 且**一个网络请求都没打**',
      cached.origin === 'cached' && cached.fromCache === true && server.hits.length === hitsBefore, `命中 ${hitsBefore} → ${server.hits.length}`);
    ok('缓存命中的清单与 live 一致', JSON.stringify(cached.models) === JSON.stringify(live.models), cached.models.join(','));
    ok('缓存命中时有效期在校将来', Date.parse(cached.expiresAt || '') > Date.now(), String(cached.expiresAt));

    const forced = await MD.discoverProviderModels('deepseek', { force: true, ttlMs: 1000 });
    ok('force → 真再取一次 (live)', forced.origin === 'live' && server.hits.length === hitsBefore + 1, forced.origin);
    const expired = await MD.discoverProviderModels('deepseek', { now: () => Date.now() + 10 * 60 * 1000 });
    ok('有效期过了 → 重新发现 (不吃过期缓存当新鲜)', expired.origin === 'live' && server.hits.length === hitsBefore + 2, expired.origin);

    // ────────────────────────────────────────────────────────
    section('V3 401: auth_failed, **不是空目录**, 不写缓存, provider 仍在');

    await MD.clearDiscoveryCache();
    await writeConfig({ kimi: { enabled: true, apiKey: KEY_B, baseUrl: server.baseUrl, model: 'kimi-k2' } });
    const denied = await MD.discoverProviderModels('kimi');
    seenStates.add(denied.discoveryState); seenOrigins.add(denied.origin);
    ok('401 → discoveryState=unavailable + auth_failed + 人话理由',
      denied.discoveryState === 'unavailable' && denied.failure?.failureClass === 'auth_failed'
      && String(denied.failureReason).includes('凭证被拒'), `${denied.failure?.failureClass}`);
    ok('**不当空目录**: 清单退回内置目录且非空',
      denied.origin === 'curated' && denied.models.length === MC.curatedModelIds('kimi').length && denied.models.length > 0,
      `${denied.models.length} 个 (内置目录 ${MC.curatedModelIds('kimi').length} 个)`);
    ok('provider **没有被删掉** (keptDespiteFailure 标记 + 备注写清)',
      denied.keptDespiteFailure === true && denied.notes.join('\n').includes('没有被删除'));
    ok('一次 401 不写缓存 (不能把目录钉成空的)',
      Object.keys((await MD.readDiscoveryCache()).entries).length === 0);

    server.setEchoKey(true);
    const echoed = await MD.discoverProviderModels('kimi', { force: true });
    ok('上游把凭据回显在错误体里 → 理由/备注已脱敏, 出现 [REDACTED]',
      !String(echoed.failureReason).includes(KEY_B) && String(echoed.failureReason).includes('[REDACTED]')
      && !JSON.stringify(echoed).includes(KEY_B));
    server.setEchoKey(false);

    // ────────────────────────────────────────────────────────
    section('V4/V5 500 与超时 → 用上一次成功缓存 (+ 标过期 + 保留 provider)');

    await MD.clearDiscoveryCache();
    server.setExpectedKey(KEY_A);
    server.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'ok-1' }, { id: 'ok-2' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: server.baseUrl, model: 'ok-1' } });
    const first = await MD.discoverProviderModels('deepseek', { ttlMs: 1000 });
    ok('先成功一次 (live, 2 个模型)', first.origin === 'live' && first.models.length === 2);

    server.setMode({ kind: 'status', status: 500 });
    const on500 = await MD.discoverProviderModels('deepseek', { force: true, now: () => Date.now() + 60_000 });
    seenOrigins.add(on500.origin);
    ok('500 → 用上次成功缓存 (清单一模一样)',
      on500.origin === 'cached' && on500.fromCache === true && JSON.stringify(on500.models) === JSON.stringify(first.models));
    ok('500 → 结论是 unavailable + provider_unreachable + 理由是上游错误',
      on500.discoveryState === 'unavailable' && on500.failure?.failureClass === 'provider_unreachable'
      && String(on500.failureReason).includes('HTTP 500'), String(on500.failureReason).slice(0, 60));
    ok('有效期已过 → 明确标 stale (不假装是新鲜缓存)', on500.stale === true);

    server.setMode({ kind: 'hang' });
    const onTimeout = await MD.discoverProviderModels('deepseek', { force: true, timeoutMs: 250 });
    ok('挂起 → timeout 分类 (不是"没有模型")',
      onTimeout.failure?.failureClass === 'timeout' && String(onTimeout.failureReason).includes('超时'), `${onTimeout.failure?.failureClass}`);
    ok('超时 → 仍回退上次成功缓存, 清单不丢',
      onTimeout.origin === 'cached' && JSON.stringify(onTimeout.models) === JSON.stringify(first.models));

    server.setMode({ kind: 'models', body: { object: 'list', data: [] } });
    const onEmpty = await MD.discoverProviderModels('deepseek', { force: true });
    ok('200 但 0 个模型 → model_not_found (不当成功, 也不污染缓存)',
      onEmpty.failure?.failureClass === 'model_not_found' && String(onEmpty.failureReason).includes('0 个模型')
      && JSON.stringify(onEmpty.models) === JSON.stringify(first.models));
    server.setMode({ kind: 'models', body: { hello: 'world' } });
    const onGarbage = await MD.discoverProviderModels('deepseek', { force: true });
    ok('200 但不是目录形状 → protocol_mismatch', onGarbage.failure?.failureClass === 'protocol_mismatch');
    server.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'ok-1' }, { id: 'ok-2' }] } });
    const kept = Object.values((await MD.readDiscoveryCache()).entries) as any[];
    ok('上面这些失败**都没有覆盖**上次成功缓存', kept.length === 1 && kept[0].models.length === 2);

    // ────────────────────────────────────────────────────────
    section('V6 从未成功 → 内置目录 (curated); 连目录都没有 → unavailable + 原因');

    await MD.clearDiscoveryCache();
    await writeConfig({ grok: { enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'grok-4' } });
    const noCred = await MD.discoverProviderModels('grok');
    seenOrigins.add(noCred.origin); seenStates.add(noCred.discoveryState);
    ok('未配置凭据 → **不发请求**, 走内置目录并说明为什么没问',
      noCred.origin === 'curated' && noCred.credentialReady === false && noCred.credentialIdentity === 'anonymous'
      && noCred.notes.join('\n').includes('未配置凭据'), noCred.origin);
    ok('内置目录清单逐条一致 (不编)', JSON.stringify(noCred.models) === JSON.stringify(MC.curatedModelIds('grok')));

    await writeConfig({ grok: { enabled: true, apiKey: KEY_A, baseUrl: 'http://127.0.0.1:1/v1', model: 'grok-4' } });
    const refused = await MD.discoverProviderModels('grok', { timeoutMs: 300 });
    seenStates.add(refused.discoveryState);
    ok('有凭据但连不上 → unavailable + provider_unreachable + 清单退回内置目录',
      refused.discoveryState === 'unavailable' && refused.failure?.failureClass === 'provider_unreachable'
      && refused.origin === 'curated' && refused.models.length > 0, `${refused.failure?.failureClass}`);

    await MD.clearDiscoveryCache();
    const added = await STORE.addCustomProvider({
      providerId: 'stub-none', displayName: '没目录的自定义家',
      baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-compatible', apiKey: KEY_A, model: 'x',
    });
    ok('自定义供应商真落盘 (走 P3 的写口)', added.ok === true, added.reason || 'stub-none');
    const nothing = await MD.discoverProviderModels('stub-none', { timeoutMs: 300 });
    seenOrigins.add(nothing.origin); seenStates.add(nothing.discoveryState);
    ok('回退链全空 → origin=unavailable (清单为空, 不编) + 原因',
      nothing.origin === 'unavailable' && nothing.models.length === 0 && String(nothing.failureReason).length > 0,
      String(nothing.failureReason).slice(0, 50));
    ok('但它**仍然在列表里** (一家都没删)',
      nothing.keptDespiteFailure === true && (await MD.listModelCatalog('stub-none', { timeoutMs: 300 })).entries.length === 1);
    await STORE.removeCustomProvider('stub-none');

    // ────────────────────────────────────────────────────────
    section('V7 两个不同 key **不共用一份缓存**');

    await MD.clearDiscoveryCache();
    server.setExpectedKey(null);
    server.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'ka-1' }, { id: 'ka-2' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: server.baseUrl, model: 'ka-1' } });
    const catA = await MD.discoverProviderModels('deepseek');
    server.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'kb-1' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_B, baseUrl: server.baseUrl, model: 'kb-1' } });
    const catB = await MD.discoverProviderModels('deepseek', { force: true });
    ok('同名 provider + 同 baseUrl, 换 key 后取到的是**另一批**模型',
      JSON.stringify(catA.models) === JSON.stringify(['ka-1', 'ka-2']) && JSON.stringify(catB.models) === JSON.stringify(['kb-1']),
      `A=${catA.models.join(',')} B=${catB.models.join(',')}`);
    ok('两个 key 的凭证身份与缓存键都不同',
      catA.credentialIdentity !== catB.credentialIdentity && catA.cacheKey !== catB.cacheKey);
    const two = await MD.readDiscoveryCache();
    ok('缓存文件里是**两条独立记录**, 指纹各不相同',
      Object.keys(two.entries).length === 2
      && new Set(Object.values(two.entries).map((e: any) => e.credentialIdentity)).size === 2);

    server.setMode({ kind: 'hang' });
    const bDown = await MD.discoverProviderModels('deepseek', { force: true, timeoutMs: 250 });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: server.baseUrl, model: 'ka-1' } });
    const aDown = await MD.discoverProviderModels('deepseek', { force: true, timeoutMs: 250 });
    ok('断网时 B 只回退到**自己那份** (看不到 A 的模型)',
      bDown.origin === 'cached' && JSON.stringify(bDown.models) === JSON.stringify(['kb-1']) && !bDown.models.includes('ka-1'));
    ok('断网时 A 也只回退到**自己那份** (看不到 B 的模型)',
      aDown.origin === 'cached' && JSON.stringify(aDown.models) === JSON.stringify(['ka-1', 'ka-2']) && !aDown.models.includes('kb-1'));

    // ────────────────────────────────────────────────────────
    section('V8 自定义模型允许手动输入 (断网/没目录时依然在)');

    await MD.clearDiscoveryCache();
    await STORE.addCustomProvider({
      providerId: 'stub-manual', displayName: '手输家', baseUrl: 'http://127.0.0.1:1/v1',
      protocol: 'openai-compatible', apiKey: KEY_A, model: 'declared-1', models: ['declared-1'],
    });
    const admitted = await MD.admitManualModel('stub-manual', 'manual-7', { timeoutMs: 300 });
    ok('手输一个模型 ID → 落进缓存 (按 provider+baseUrl+指纹那一格), 标记 custom',
      admitted.ok === true && admitted.catalog.models.includes('manual-7')
      && admitted.catalog.modelOrigins['manual-7'] === 'custom', admitted.ok ? admitted.catalog.models.join(',') : admitted.reason);
    seenOrigins.add(admitted.ok ? admitted.catalog.origin : 'unavailable');
    const againManual = await MD.discoverProviderModels('stub-manual', { force: true, timeoutMs: 300 });
    ok('端点连不上时, 手输的模型**仍在清单里**', againManual.models.includes('manual-7'));
    ok('撤销之后就不在了 (declared 那份还在)',
      (await MD.forgetManualModel('stub-manual', 'manual-7')) === true
      && !(await MD.discoverProviderModels('stub-manual', { force: true, timeoutMs: 300 })).models.includes('manual-7'));
    ok('非法 ID 一律拒绝并给理由',
      (await MD.admitManualModel('stub-manual', '')).ok === false
      && (await MD.admitManualModel('stub-manual', 'a b')).ok === false
      && (await MD.admitManualModel('stub-manual', 'a\u0000b')).ok === false);
    await STORE.removeCustomProvider('stub-manual');

    // ────────────────────────────────────────────────────────
    section('V9 五种标记在本轮真跑里**全部出现过**');

    for (const o of ['live', 'cached', 'curated', 'custom', 'unavailable']) {
      ok(`标记 ${o} 真被观测到 (origin)`, seenOrigins.has(o), [...seenOrigins].sort().join(','));
    }
    ok('`unavailable` 作为**发现结论**真被观测到', seenStates.has('unavailable'), [...seenStates].sort().join(','));

    // ────────────────────────────────────────────────────────
    section('V10 发现失败**不删 provider** (全册)');

    await MD.clearDiscoveryCache();
    await writeConfig({}, 'deepseek');
    const listing = await MD.listModelCatalog(undefined, { force: true, timeoutMs: 120, fetchImpl: refusingFetch });
    const registryIds = PR.listProviderRegistry().map((e: any) => e.id);
    ok('全员发现失败时, 列表长度仍 = 注册表长度 (一家都不少)',
      listing.entries.length === registryIds.length, `${listing.entries.length} vs ${registryIds.length}`);
    ok('逐家 id 与注册表逐字一致 (顺序也一致)',
      JSON.stringify(listing.entries.map((e: any) => e.provider)) === JSON.stringify(registryIds));
    ok('失败的那些条条有原因 (unavailable 索引非空)',
      listing.unavailable.length > 0 && listing.unavailable.every((u: any) => String(u.reason).length > 0),
      `${listing.unavailable.length} 家失败`);
    ok('每条都有五种标记之一 (origin 与 discoveryState)',
      listing.entries.every((e: any) => ['live', 'cached', 'curated', 'custom', 'unavailable'].includes(e.origin)
        && ['live', 'cached', 'curated', 'custom', 'unavailable'].includes(e.discoveryState)));
    ok('摘要行明说"一家都没删"', MD.formatListingSummary(listing)[0].includes('一家都没删'));

    // ────────────────────────────────────────────────────────
    section('V11 元数据填充点: 真目录的能力**端到端**进 ModelEntry, 没有的不编');

    await MD.clearDiscoveryCache();
    server.setMode({
      kind: 'models',
      body: {
        object: 'list',
        data: [
          { id: 'rich-1', context_length: 131072, capabilities: { tool_calling: true, reasoning: false } },
          { id: 'plain-2' },
        ],
      },
    });
    server.setExpectedKey(KEY_A);
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: server.baseUrl, model: 'rich-1' } });
    const richCat = await MD.discoverProviderModels('deepseek', { force: true });
    ok('响应体里**字面写着**的 context_length / capabilities.tool_calling 真被取到',
      richCat.facts['rich-1']?.contextLength === 131072 && richCat.facts['rich-1']?.toolCalling === 'yes'
      && richCat.facts['rich-1']?.reasoning === 'no');
    ok('没有这些字段的模型**一个字段都不填**', richCat.facts['plain-2'] === undefined);
    ok('填充点已接线 (id=live-discovery, 走 P2 冻结接口)', MC.listModelMetadataSources().includes('live-discovery'),
      MC.listModelMetadataSources().join(','));
    const src = MD.modelDiscoveryMetadataSource();
    ok('填充点只回有真值的键 (plain-2 只有 origin)',
      JSON.stringify(src.metadataOf({ provider: 'deepseek', model: 'plain-2' })) === JSON.stringify({ origin: 'live' }));
    ok('从没跑过发现的 provider → 填充点什么都不回 (保持 unknown)',
      src.metadataOf({ provider: 'minimax', model: 'MiniMax-M3' }) === undefined);
    const modelEntries = await MC.listModelsFor('deepseek', { extra: ['rich-1', 'plain-2'] });
    const richEntry = modelEntries.find((e: any) => e.id === 'rich-1');
    ok('端到端: ModelEntry 真拿到工具调用=支持 与 上下文 131072',
      richEntry?.toolCalling === 'yes' && richEntry?.contextLength === 131072 && richEntry?.origin === 'live');
    const plainEntry = modelEntries.find((e: any) => e.id === 'plain-2');
    ok('端到端: 没数据的那条仍是"未知" + 有未知原因 (不编)',
      plainEntry?.toolCalling === 'unknown' && plainEntry?.unknowns.some((u: any) => u.field === 'toolCalling'));

    // ────────────────────────────────────────────────────────
    section('V12 跨进程: 真子进程读同一份缓存 (指纹一致, 命中缓存)');

    const child = childJson(HOME, `
      const md = await import('./src/llm/model-discovery.js');
      const f = await md.readDiscoveryCache();
      const e = Object.values(f.entries)[0] || null;
      console.log('CHILD:' + JSON.stringify({
        entries: Object.keys(f.entries).length,
        identity: e ? e.credentialIdentity : null,
        models: e ? e.models : null,
        path: md.discoveryCachePath(),
        wired: md.isDiscoveryMetadataSourceWired(),
      }));
    `);
    ok('子进程读到同一条缓存 (指纹与模型清单一致)',
      child.entries === 1 && child.identity === live.credentialIdentity
      && JSON.stringify(child.models) === JSON.stringify(['rich-1', 'plain-2']), JSON.stringify(child));
    ok('子进程的缓存路径与父进程一致 (同一个 BOLLOON_HOME)', child.path === MD.discoveryCachePath());

    // ────────────────────────────────────────────────────────
    section('V13 凭据: 明文 key 不出现在缓存 / 列表 / 理由 / URL 任何一处');

    // gemini 这类协议把 key 放在 URL 的 query 上 —— 最容易从 URL 漏出去
    await MD.clearDiscoveryCache();
    server.setExpectedKey(KEY_A);
    server.setMode({ kind: 'models', body: { models: [{ name: 'models/gemini-x', inputTokenLimit: 1000000 }] } });
    await writeConfig({ gemini: { enabled: true, apiKey: KEY_A, baseUrl: `${server.baseUrl}`.replace('/v1', ''), model: 'gemini-x' } });
    const gem = await MD.discoverProviderModels('gemini', { force: true });
    ok('gemini 形状真跑: name 前缀 `models/` 被去掉, inputTokenLimit 当真值',
      JSON.stringify(gem.models) === JSON.stringify(['gemini-x']) && gem.facts['gemini-x']?.contextLength === 1000000,
      gem.models.join(','));
    const gemQuery = server.hits.filter((h) => h.query.includes('key=')).map((h) => decodeURIComponent(h.query));
    ok('gemini 的 key 真放在 query 上发出去了 (只显示尾号)',
      gemQuery.some((q) => q.includes(KEY_A)) && gemQuery.length > 0, `?key=${tail(KEY_A)} (${gemQuery.length} 次)`);
    const gemCacheText = fs.readFileSync(MD.discoveryCachePath(), 'utf-8');
    ok('缓存里存的端点 URL **不带**认证 query (凭据不落盘)',
      !gemCacheText.includes(KEY_A) && !gemCacheText.includes('key='), JSON.parse(gemCacheText).entries ? Object.values(JSON.parse(gemCacheText).entries).map((e: any) => e.endpoint).join(',') : '');

    const dump = [
      ...printed,
      fs.readFileSync(MD.discoveryCachePath(), 'utf-8'),
      JSON.stringify(await MD.listModelCatalog(undefined, { timeoutMs: 150, force: true })),
      MD.formatCatalogLine(gem),
      MD.formatListingSummary(await MD.listModelCatalog('gemini', { timeoutMs: 300 })).join('\n'),
    ].join('\n');
    ok('所有打印行 + 缓存 + 列表 + 展示行里没有两把 key 的明文',
      !dump.includes(KEY_A) && !dump.includes(KEY_B), `检查了 ${printed.length} 行输出 + 缓存 + 全册列表`);
    ok('脱敏工具真能抹掉凭据 (回显场景实测过)', MD.redactSecretIn(`leak ${KEY_A} here`, KEY_A) === 'leak [REDACTED] here');
    ok('发现层从不把 apiKey 放进 catalog 对象 (按字段名核)',
      !JSON.stringify(gem).includes('apiKey') && !JSON.stringify(listing.entries[0]).includes('apiKey'));

    // ────────────────────────────────────────────────────────
    section('V14 命令面能力 (做成可调用函数; 命令面接线不归本层)');

    const refresh = await MD.refreshModelDiscovery(['gemini', 'deepseek'], { timeoutMs: 500 });
    ok('/model refresh → 强制真取 + 逐家结论 + 逐家失败原因',
      refresh.force === true && refresh.results.length === 2
      && (refresh.counts.live + refresh.counts.cached + refresh.counts.curated + refresh.counts.custom + refresh.counts.unavailable) === 2,
      JSON.stringify(refresh.counts));
    const listAll = await MD.listModelCatalog(undefined, { timeoutMs: 300, fetchImpl: refusingFetch });
    ok('/model list → 全册 (含发现失败的家)', listAll.entries.length === PR.listProviderRegistry().length,
      `${listAll.entries.length} 家`);
    const listOne = await MD.listModelCatalog('gemini', { timeoutMs: 300 });
    ok('/model list <provider> → 只看这一家', listOne.entries.length === 1 && listOne.entries[0].provider === 'gemini');
    ok('清缓存能力可用 (命令面 refresh --clear 用)', typeof MD.clearDiscoveryCache === 'function'
      && (await MD.clearDiscoveryCache('gemini')) >= 1);
    ok('手工模型能力可用 (/model add-model 用)', typeof MD.admitManualModel === 'function' && typeof MD.forgetManualModel === 'function');

    // ────────────────────────────────────────────────────────
    if (!process.argv.includes('--no-mutations')) {
      section('V15 变异: 4 条改写, 逐条必须**判红** (门承重)');
      runMutations();
    }

  } finally {
    await server.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`verify-model-discovery: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
  if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

// ============================================================
// 变异验证 (改写本层的关键行为, 确认聚焦测试**判红**)
// ============================================================

interface Mutation {
  id: string;
  desc: string;
  /** 一处或多处逐字替换 (锚点必须唯一) */
  pairs: Array<[string, string]>;
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    desc: '发现失败就把 provider 从列表里**静默删掉**',
    pairs: [[
      `  return {
    generatedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    cachePath: discoveryCachePath(),
    entries,`,
      `  return {
    generatedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    cachePath: discoveryCachePath(),
    entries: entries.filter((e) => e.discoveryState !== 'unavailable'),`,
    ]],
  },
  {
    id: 'M2',
    desc: '缓存键**丢掉凭证身份** (两个 key 共用一份缓存)',
    pairs: [[
      `    cacheKey: discoveryCacheKey(id, baseUrl, credentialIdentity),`,
      `    cacheKey: discoveryCacheKey(id, baseUrl, ANONYMOUS_IDENTITY),`,
    ]],
  },
  {
    id: 'M3',
    desc: '把 401 当成"空目录" (凭证被拒 → 0 个模型也算成功并写缓存)',
    pairs: [
      [
        `    if (statusFail) {
      failure = { failureClass: statusFail.failureClass, reason: statusFail.detail, at: nowIso };
    } else {`,
        `    if (statusFail && statusFail.failureClass !== 'auth_failed') {
      failure = { failureClass: statusFail.failureClass, reason: statusFail.detail, at: nowIso };
    } else if (statusFail) {
      parsed = { kind: 'ok', ids: [], facts: {} };
    } else {`,
      ],
      [
        `  if (parsed && parsed.kind === 'ok' && parsed.ids.length > 0) {`,
        `  if (parsed && parsed.kind === 'ok') {`,
      ],
    ],
  },
  {
    id: 'M4',
    desc: '缓存里存**明文凭证**而不是指纹',
    pairs: [[
      `  const credentialIdentity = credentialIdentityOf(cred.apiKey);`,
      `  const credentialIdentity = cred.apiKey || ANONYMOUS_IDENTITY;`,
    ]],
  },
];

function runMutations(): void {
  const target = path.join(ROOT, SELF);
  const original = fs.readFileSync(target, 'utf-8');
  const originalSha = sha(target);
  let red = 0;
  try {
    for (const m of MUTATIONS) {
      let src = original;
      let anchorMissing = false;
      for (const [oldText, newText] of m.pairs) {
        const count = src.split(oldText).length - 1;
        if (count !== 1) {
          console.log(`  ❌ ${m.id} 锚点${count === 0 ? '没找到' : `不唯一(${count})`} — 变异没落盘: ${m.desc}`);
          failures.push(`${m.id}(锚点)`);
          failCount();
          anchorMissing = true;
          break;
        }
        src = src.replace(oldText, newText);
      }
      if (anchorMissing) continue;
      fs.writeFileSync(target, src, 'utf-8');
      if (sha(target) === originalSha) {
        console.log(`  ❌ ${m.id} 盘上 hash 没变 — 后面的结果无效`);
        failures.push(`${m.id}(没落盘)`);
        failCount();
        fs.writeFileSync(target, original, 'utf-8');
        continue;
      }
      const r = spawnSync('npx', ['vitest', 'run', 'src/test/model-discovery.test.ts'], {
        cwd: ROOT, encoding: 'utf-8', timeout: 900_000,
        env: { ...process.env, BOLLOON_HOME: HOME, HOME, USERPROFILE: HOME },
      });
      const didRed = r.status !== 0;
      if (didRed) {
        red++;
        ok(`${m.id} 判红 — ${m.desc}`, true, `sha ${originalSha} → ${sha(target)}`);
      } else {
        ok(`${m.id} 判红 — ${m.desc}`, false, '判绿 = 门不承重 (不许当通过)');
      }
      fs.writeFileSync(target, original, 'utf-8');
      if (sha(target) !== originalSha) {
        console.log(`  ❌ ${m.id} 恢复失败 — 源文件被留在变异状态!`);
        failures.push(`${m.id}(恢复失败)`);
        failCount();
        return;
      }
    }
  } finally {
    if (sha(target) !== originalSha) {
      fs.writeFileSync(target, original, 'utf-8');
      console.log(`  (兜底) ${SELF} 已恢复为原文 (sha=${originalSha})`);
    }
  }
  console.log(`\n变异验证: ${red}/${MUTATIONS.length} 判红`);
}

function failCount(): void {
  failed++;
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
