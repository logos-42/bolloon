/**
 * model-discovery.test.ts — 模型发现与缓存 (P5) 的单测 (2026-09-26)
 *
 * 全场景用**真本地 HTTP 服务器**造 (不许只做桩):
 *   ① `/models` 正常 → `live` + 写缓存 (键 = provider + baseUrl + 凭证指纹);
 *   ② 新鲜期内再问 → `cached`, **一个网络请求都不打**;
 *   ③ 401 → `auth_failed`, **不许当空目录** (清单退回内置目录, 且不写缓存);
 *   ④ 500 / 超时 → 用**上次成功缓存** (`cached` + `unavailable` 发现结论);
 *   ⑤ 从未成功 → 内置目录 (`curated`); 连内置目录都没有 → `unavailable` + 原因;
 *   ⑥ **两个不同 key 不共用一份缓存** (同名 provider/同 baseUrl, 只有凭据身份不同);
 *   ⑦ 自定义模型**手动输入** (`admitManualModel`) 在断网时依然在;
 *   ⑧ 发现失败**不删 provider** (全册列表长度 = 注册表长度);
 *   ⑨ 元数据填充点: 只填响应体里**字面读到**的能力;
 *   ⑩ 凭据: 缓存/列表/理由里没有明文 key (上游回显 key 也过脱敏)。
 *
 * 隔离: 临时 HOME (import 前设好, 所以走动态 import)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const TMP = path.join(os.tmpdir(), 'bolloon-model-discovery-' + Date.now());
const KEY_A = 'sk-test-key-AAAA-1111';
const KEY_B = 'sk-test-key-BBBB-2222';

type M = typeof import('../llm/model-discovery.js');
type CS = typeof import('../llm/config-store.js');
type MC = typeof import('../llm/model-catalog.js');
type PR = typeof import('../llm/provider-registry.js');
type STORE = typeof import('../llm/custom-provider-store.js');

let MD: M; let CS: CS; let MC: MC; let PR: PR; let STORE: STORE;

/** 会被读成"已有凭证"的环境变量: 一律清空, 免得本机环境干扰判定 */
const ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'KIMI_API_KEY', 'MOONSHOT_API_KEY',
  'GLM_API_KEY', 'ZHIPU_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'XAI_API_KEY', 'MIMO_BASE_URL', 'MIMO_API_KEY',
  'MINIMAX_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL',
];
const ENV_SAVED: Record<string, string | undefined> = {};

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  for (const k of ENV_KEYS) {
    ENV_SAVED[k] = process.env[k];
    process.env[k] = '';
  }
  await fs.mkdir(TMP, { recursive: true });
  CS = await import('../llm/config-store.js');
  MC = await import('../llm/model-catalog.js');
  PR = await import('../llm/provider-registry.js');
  STORE = await import('../llm/custom-provider-store.js');
  MD = await import('../llm/model-discovery.js');
});

afterAll(async () => {
  for (const [k, v] of Object.entries(ENV_SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ============================================================
// 真本地 HTTP 服务器 (可切成: 正常 / 401 / 500 / 挂起 / 空 / 垃圾形状)
// ============================================================

type StubMode =
  | { kind: 'models'; body: unknown }
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'hang' };

interface Hit { method: string; url: string; auth: string }

interface Stub {
  port: number;
  baseUrl: string;
  hits: Hit[];
  setMode(m: StubMode): void;
  setExpectedKey(k: string | null): void;
  setEchoKey(v: boolean): void;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  let mode: StubMode = { kind: 'models', body: { object: 'list', data: [] } };
  let expectedKey: string | null = null;
  let echoKey = false;
  const hits: Hit[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const auth = String(req.headers.authorization || '');
    hits.push({ method: req.method || '', url, auth });
    if (mode.kind === 'hang') return; // 永不响应 → 客户端超时
    const okKey = expectedKey === null || auth === `Bearer ${expectedKey}`;
    if (!okKey) {
      const leaked = echoKey ? ` — 收到的凭据是 ${auth.replace('Bearer ', '')}` : '';
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
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits,
    setMode: (m) => { mode = m; },
    setExpectedKey: (k) => { expectedKey = k; },
    setEchoKey: (v) => { echoKey = v; },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

/** 写配置 (真文件, 真读盘路径; 不走别人的写口) */
async function writeConfig(providers: Record<string, any>, activeProvider = 'deepseek'): Promise<void> {
  const cfg = { activeProvider, providers, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(TMP, 'bolloon-config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  CS.llmConfigStore.invalidate();
  await CS.llmConfigStore.initialize();
}

async function clearCache(): Promise<void> {
  await MD.clearDiscoveryCache();
}

const refusingFetch: typeof fetch = (async () => {
  const e: any = new Error('connect ECONNREFUSED 127.0.0.1:1');
  e.code = 'ECONNREFUSED';
  throw e;
}) as any;

// ============================================================
// ① live: 真取到目录 + 写缓存 (只存指纹)
// ============================================================

describe('① 已认证 → 优先取 /models, 结果按 provider+baseUrl+凭证身份 缓存', () => {
  let stub: Stub;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });

  it('真取到目录 → live; 端点/认证头/缓存键都对; 缓存里没有明文 key', async () => {
    await clearCache();
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'stub-a1' }, { id: 'stub-a2' }] } });
    stub.setExpectedKey(KEY_A);
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'stub-a1' } });

    const cat = await MD.discoverProviderModels('deepseek');
    expect(cat.origin).toBe('live');
    expect(cat.discoveryState).toBe('live');
    expect(cat.discoveryFailed).toBe(false);
    expect(cat.fromCache).toBe(false);
    expect(cat.models).toEqual(['stub-a1', 'stub-a2']);
    expect(cat.modelOrigins['stub-a1']).toBe('live');
    expect(cat.endpoint).toBe(`${stub.baseUrl}/models`);
    expect(cat.baseUrlSource).toBe('configured');
    expect(cat.credentialSource).toBe('config');
    expect(cat.credentialReady).toBe(true);

    // 凭证身份**只有指纹**
    expect(cat.credentialIdentity).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(cat.credentialIdentity).toBe(MD.credentialIdentityOf(KEY_A));
    expect(cat.cacheKey).toBe(MD.discoveryCacheKey('deepseek', stub.baseUrl, cat.credentialIdentity));

    // 服务器收到的正是这把 key (只算命中, 不打印值)
    const hit = stub.hits.filter((h) => h.url.includes('/models'));
    expect(hit.length).toBe(1);
    expect(hit[0].method).toBe('GET');
    expect(hit[0].auth).toBe(`Bearer ${KEY_A}`);

    // 缓存: 0600 + 有这一条 + **明文 key 不在里面**
    const file = await MD.readDiscoveryCache();
    const keys = Object.keys(file.entries);
    expect(keys.length).toBe(1);
    expect(file.entries[keys[0]].models).toEqual(['stub-a1', 'stub-a2']);
    expect(file.entries[keys[0]].credentialIdentity).toBe(cat.credentialIdentity);
    expect(file.entries[keys[0]].lastSuccessAt).toBeTruthy();
    const text = await fs.readFile(MD.discoveryCachePath(), 'utf-8');
    expect(text.includes(KEY_A)).toBe(false);
    expect(MD.discoveryCacheLeaks(file, KEY_A)).toBe(false);
    expect(MD.discoveryCacheLeaks(text, KEY_A)).toBe(false);
    const stat = await fs.stat(MD.discoveryCachePath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('新鲜期内再问 → cached, 一个网络请求都不打', async () => {
    const before = stub.hits.length;
    const cat = await MD.discoverProviderModels('deepseek');
    expect(cat.origin).toBe('cached');
    expect(cat.discoveryState).toBe('cached');
    expect(cat.fromCache).toBe(true);
    expect(cat.models).toEqual(['stub-a1', 'stub-a2']);
    expect(stub.hits.length).toBe(before);
  });

  it('force → 真再取一次 (live), 缓存有效期被刷新', async () => {
    const before = stub.hits.length;
    const cat = await MD.discoverProviderModels('deepseek', { force: true });
    expect(cat.origin).toBe('live');
    expect(stub.hits.length).toBe(before + 1);
    expect(Date.parse(cat.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('TTL 到了 (注入时钟越过有效期) → 重新真取, 不再吃旧缓存', async () => {
    const future = () => Date.now() + 10 * 60 * 1000;   // 越过 30 分钟 TTL 的一半以上? 用 ttlMs 明确控制
    await MD.discoverProviderModels('deepseek', { force: true, ttlMs: 1000 });
    const before = stub.hits.length;
    const cat = await MD.discoverProviderModels('deepseek', { now: future });
    // ttlMs=1000 → 注入时钟 +10min 后过期 → 必须重新发现
    expect(cat.origin).toBe('live');
    expect(stub.hits.length).toBe(before + 1);
  });
});

// ============================================================
// ② 401: 不许当空目录; 不许删 provider
// ============================================================

describe('② 401 不是"空目录"', () => {
  let stub: Stub;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });

  it('凭证被拒 → auth_failed; 清单退回内置目录; 不写缓存; provider 仍在', async () => {
    await clearCache();
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'nope' }] } });
    stub.setExpectedKey(KEY_A);
    await writeConfig({ kimi: { enabled: true, apiKey: KEY_B, baseUrl: stub.baseUrl, model: 'kimi-k2' } });

    const cat = await MD.discoverProviderModels('kimi');
    expect(cat.discoveryState).toBe('unavailable');
    expect(cat.discoveryFailed).toBe(true);
    expect(cat.keptDespiteFailure).toBe(true);
    expect(cat.failure?.failureClass).toBe('auth_failed');
    expect(String(cat.failureReason)).toContain('凭证被拒');
    // **绝对不是空目录**: 退回内置目录, 有内容
    expect(cat.origin).toBe('curated');
    const curated = MC.curatedModelIds('kimi');
    expect(curated.length).toBeGreaterThan(0);
    expect(cat.models).toEqual(curated);
    expect(cat.models.length).toBeGreaterThan(0);
    // 失败不写缓存 (不能拿一次 401 把目录钉成空的)
    const file = await MD.readDiscoveryCache();
    expect(Object.keys(file.entries).length).toBe(0);
  });

  it('上游把凭据回显在错误体里 → 理由里已脱敏, 不出现明文', async () => {
    stub.setEchoKey(true);
    const cat = await MD.discoverProviderModels('kimi', { force: true });
    expect(cat.failure?.failureClass).toBe('auth_failed');
    expect(String(cat.failureReason).includes(KEY_B)).toBe(false);
    expect(String(cat.failureReason)).toContain('[REDACTED]');
    expect(JSON.stringify(cat).includes(KEY_B)).toBe(false);
    stub.setEchoKey(false);
  });
});

// ============================================================
// ③ 500 / 超时: 用上一次成功缓存
// ============================================================

describe('③ 500 / 超时 → 回退上次成功缓存', () => {
  let stub: Stub;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });

  it('先成功一次, 再 500 → cached 清单 + unavailable 结论 + 原因 + 标记过期', async () => {
    await clearCache();
    stub.setExpectedKey(KEY_A);
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'srv-1' }, { id: 'srv-2' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'srv-1' } });
    const live = await MD.discoverProviderModels('deepseek', { ttlMs: 1000 });
    expect(live.origin).toBe('live');
    expect(live.models).toEqual(['srv-1', 'srv-2']);

    stub.setMode({ kind: 'status', status: 500 });
    const cat = await MD.discoverProviderModels('deepseek', { force: true, now: () => Date.now() + 60_000 });
    expect(cat.origin).toBe('cached');
    expect(cat.discoveryState).toBe('unavailable');
    expect(cat.discoveryFailed).toBe(true);
    expect(cat.fromCache).toBe(true);
    expect(cat.stale).toBe(true);                 // 有效期已过 → 明确标"过期缓存"
    expect(cat.failure?.failureClass).toBe('provider_unreachable');
    expect(cat.models).toEqual(['srv-1', 'srv-2']); // 清单没丢
    expect(cat.notes.join('\n')).toContain('没有被删除');
  });

  it('挂起的服务器 → timeout 分类, 仍回退上次成功缓存', async () => {
    stub.setMode({ kind: 'hang' });
    const cat = await MD.discoverProviderModels('deepseek', { force: true, timeoutMs: 250 });
    expect(cat.failure?.failureClass).toBe('timeout');
    expect(cat.origin).toBe('cached');
    expect(cat.discoveryState).toBe('unavailable');
    expect(cat.models).toEqual(['srv-1', 'srv-2']);
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'srv-1' }, { id: 'srv-2' }] } });
  });

  it('200 但是空清单 / 不是目录形状 → 都算失败, 且不覆盖上次成功缓存', async () => {
    stub.setMode({ kind: 'models', body: { object: 'list', data: [] } });
    const empty = await MD.discoverProviderModels('deepseek', { force: true });
    expect(empty.failure?.failureClass).toBe('model_not_found');
    expect(String(empty.failureReason)).toContain('0 个模型');
    expect(empty.origin).toBe('cached');
    expect(empty.models).toEqual(['srv-1', 'srv-2']);

    stub.setMode({ kind: 'models', body: { hello: 'world' } });
    const garbage = await MD.discoverProviderModels('deepseek', { force: true });
    expect(garbage.failure?.failureClass).toBe('protocol_mismatch');
    expect(garbage.discoveryState).toBe('unavailable');

    const file = await MD.readDiscoveryCache();
    const key = Object.keys(file.entries)[0];
    expect(file.entries[key].models).toEqual(['srv-1', 'srv-2']);    // 缓存没被空清单污染
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'srv-1' }, { id: 'srv-2' }] } });
  });
});

// ============================================================
// ④ 从未成功 → 内置目录 / unavailable
// ============================================================

describe('④ 从未成功 → 内置目录; 连目录都没有 → unavailable + 原因', () => {
  it('未配置凭据 → 不发请求, 清单来自内置目录 (curated) 并说明为什么没问', async () => {
    await clearCache();
    await writeConfig({ grok: { enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'grok-4' } });
    const cat = await MD.discoverProviderModels('grok');
    expect(cat.origin).toBe('curated');
    expect(cat.discoveryState).toBe('curated');
    expect(cat.discoveryFailed).toBe(false);
    expect(cat.credentialIdentity).toBe('anonymous');
    expect(cat.models).toEqual(MC.curatedModelIds('grok'));
    expect(cat.notes.join('\n')).toContain('未配置凭据');
  });

  it('有凭据但端点连不上 → unavailable + provider_unreachable, 清单退回内置目录', async () => {
    await writeConfig({ grok: { enabled: true, apiKey: KEY_A, baseUrl: 'http://127.0.0.1:1/v1', model: 'grok-4' } });
    const cat = await MD.discoverProviderModels('grok', { timeoutMs: 300 });
    expect(cat.discoveryState).toBe('unavailable');
    expect(cat.keptDespiteFailure).toBe(true);
    expect(['provider_unreachable', 'invalid_url']).toContain(cat.failure?.failureClass);
    expect(cat.origin).toBe('curated');
    expect(cat.models.length).toBeGreaterThan(0);
  });

  it('自定义供应商: 端点连不上 + 没声明模型 → origin=unavailable, 但**仍然在列表里**', async () => {
    await clearCache();
    const add = await STORE.addCustomProvider({
      providerId: 'stub-noendpoint', displayName: '没目录的自定义家',
      baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-compatible', apiKey: KEY_A, model: 'x',
    });
    expect(add.ok).toBe(true);
    const cat = await MD.discoverProviderModels('stub-noendpoint', { timeoutMs: 300 });
    expect(cat.origin).toBe('unavailable');
    expect(cat.discoveryState).toBe('unavailable');
    expect(cat.models).toEqual([]);
    expect(cat.keptDespiteFailure).toBe(true);
    expect(String(cat.failureReason).length).toBeGreaterThan(0);
    // 列表里还在
    const listing = await MD.listModelCatalog('stub-noendpoint', { timeoutMs: 300 });
    expect(listing.entries.map((e) => e.provider)).toContain('stub-noendpoint');
    await STORE.removeCustomProvider('stub-noendpoint');
  });

  it('discovery=manual (没有可用目录端点) → 不发请求, 走内置目录并说明原因', async () => {
    await clearCache();
    await writeConfig({ anthropic: { enabled: true, apiKey: KEY_A, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x' } });
    const target = await MD.resolveDiscoveryTarget('anthropic');
    expect(target.canDiscover).toBe(false);
    expect(target.endpoint).toBe('');
    const cat = await MD.discoverProviderModels('anthropic', { fetchImpl: refusingFetch });
    expect(cat.origin).toBe('curated');
    expect(cat.notes.join('\n')).toContain('目录端点');
  });
});

// ============================================================
// ⑤ 两个不同 key 不共用一份缓存
// ============================================================

describe('⑤ 两个不同 key 不共享缓存 (同名 provider / 同 baseUrl / 只有凭据身份不同)', () => {
  let stub: Stub;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });

  it('A 的发现结果对 B 不可见, 断网时各自回退到**自己那份**缓存', async () => {
    await clearCache();
    stub.setExpectedKey(null);
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'a-1' }, { id: 'a-2' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'a-1' } });
    const catA = await MD.discoverProviderModels('deepseek');
    expect(catA.origin).toBe('live');
    expect(catA.models).toEqual(['a-1', 'a-2']);

    // 换 key B: 同一 provider、同一 baseUrl, 端点回的是另一批模型
    stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'b-1' }] } });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_B, baseUrl: stub.baseUrl, model: 'b-1' } });
    const catB = await MD.discoverProviderModels('deepseek', { force: true });
    expect(catB.origin).toBe('live');
    expect(catB.models).toEqual(['b-1']);
    expect(catB.credentialIdentity).not.toBe(catA.credentialIdentity);
    expect(catB.cacheKey).not.toBe(catA.cacheKey);

    // 断网: B 只能看到自己那份
    stub.setMode({ kind: 'hang' });
    const bDown = await MD.discoverProviderModels('deepseek', { force: true, timeoutMs: 250 });
    expect(bDown.origin).toBe('cached');
    expect(bDown.models).toEqual(['b-1']);
    expect(bDown.models).not.toContain('a-1');
    expect(bDown.credentialIdentity).toBe(catB.credentialIdentity);

    // 断网: A 也只能看到自己那份
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'a-1' } });
    const aDown = await MD.discoverProviderModels('deepseek', { force: true, timeoutMs: 250 });
    expect(aDown.origin).toBe('cached');
    expect(aDown.models).toEqual(['a-1', 'a-2']);
    expect(aDown.models).not.toContain('b-1');

    // 缓存文件里两条独立记录, 各带各的指纹
    const file = await MD.readDiscoveryCache();
    const identities = Object.values(file.entries).map((e) => e.credentialIdentity).sort();
    expect(Object.keys(file.entries).length).toBe(2);
    expect(new Set(identities).size).toBe(2);
    expect(identities).toContain(catA.credentialIdentity);
    expect(identities).toContain(catB.credentialIdentity);
    expect(identities).not.toContain('anonymous');
    // 文件里两把 key 的明文都没出现
    const text = JSON.stringify(file);
    expect(text.includes(KEY_A)).toBe(false);
    expect(text.includes(KEY_B)).toBe(false);
  });

  it('凭证身份是稳定指纹: 同一把 key 两次相同, 不同 key 不同, 匿名是 anonymous', () => {
    expect(MD.credentialIdentityOf(KEY_A)).toBe(MD.credentialIdentityOf(KEY_A));
    expect(MD.credentialIdentityOf(KEY_A)).not.toBe(MD.credentialIdentityOf(KEY_B));
    expect(MD.credentialIdentityOf('')).toBe('anonymous');
    expect(MD.credentialIdentityOf(undefined)).toBe('anonymous');
    expect(MD.isFingerprintIdentity(MD.credentialIdentityOf(KEY_A))).toBe(true);
    expect(MD.isFingerprintIdentity('anonymous')).toBe(false);
    // 指纹里不含明文
    expect(MD.credentialIdentityOf(KEY_A).includes(KEY_A)).toBe(false);
  });
});

// ============================================================
// ⑥ 自定义模型手动输入
// ============================================================

describe('⑥ 自定义模型允许手动输入 (断网/没目录时依然在)', () => {
  it('手输的模型标记 custom, 失败后仍在, 能撤销, 非法 ID 被拒', async () => {
    await clearCache();
    await STORE.addCustomProvider({
      providerId: 'stub-manual', displayName: '手输家', baseUrl: 'http://127.0.0.1:1/v1',
      protocol: 'openai-compatible', apiKey: KEY_A, model: 'declared-1', models: ['declared-1'],
    });
    const admitted = await MD.admitManualModel('stub-manual', 'manual-7', { timeoutMs: 300 });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.catalog.models).toContain('manual-7');
    expect(admitted.catalog.models).toContain('declared-1');
    expect(admitted.catalog.modelOrigins['manual-7']).toBe('custom');
    expect(admitted.catalog.modelOrigins['declared-1']).toBe('custom');
    expect(admitted.catalog.discoveryState).toBe('unavailable');   // 端点连不上 (真事)
    expect(admitted.catalog.origin).toBe('custom');                // 但清单来自用户声明/手输

    // 再发现一次 (仍然连不上): 手输的模型仍在
    const again = await MD.discoverProviderModels('stub-manual', { force: true, timeoutMs: 300 });
    expect(again.models).toContain('manual-7');

    // 撤销
    expect(await MD.forgetManualModel('stub-manual', 'manual-7')).toBe(true);
    const after = await MD.discoverProviderModels('stub-manual', { force: true, timeoutMs: 300 });
    expect(after.models).not.toContain('manual-7');
    expect(after.models).toContain('declared-1');

    // 非法 ID 一律拒绝 (给理由)
    expect((await MD.admitManualModel('stub-manual', '')).ok).toBe(false);
    expect((await MD.admitManualModel('stub-manual', 'has space')).ok).toBe(false);
    expect((await MD.admitManualModel('stub-manual', 'bad\u0000id')).ok).toBe(false);
    expect((await MD.admitManualModel('stub-manual', 'x'.repeat(300))).ok).toBe(false);

    await STORE.removeCustomProvider('stub-manual');
  });
});

// ============================================================
// ⑦ 发现失败不删 provider (全册)
// ============================================================

describe('⑦ 发现失败**不静默删 provider**', () => {
  it('全员发现失败时, 列表长度仍 = 注册表长度, 每家都有来源标记 + 失败原因', async () => {
    await clearCache();
    await writeConfig({}, 'deepseek');
    const listing = await MD.listModelCatalog(undefined, { force: true, timeoutMs: 120, fetchImpl: refusingFetch });
    const registryIds = PR.listProviderRegistry().map((e) => e.id);
    expect(listing.entries.length).toBe(registryIds.length);
    expect(listing.entries.map((e) => e.provider).sort()).toEqual(registryIds.slice().sort());
    for (const e of listing.entries) {
      expect(['live', 'cached', 'curated', 'custom', 'unavailable']).toContain(e.origin);
      expect(['live', 'cached', 'curated', 'custom', 'unavailable']).toContain(e.discoveryState);
    }
    // 失败的那些: 一条都不少, 且条条有原因
    for (const u of listing.unavailable) {
      expect(String(u.reason).length).toBeGreaterThan(0);
    }
    expect(listing.unavailable.length).toBeGreaterThan(0);
    // 摘要行里明确写"一家都没删"
    expect(MD.formatListingSummary(listing)[0]).toContain('一家都没删');
  });
});

// ============================================================
// ⑧ 元数据填充点: 只填字面读到的
// ============================================================

describe('⑧ 元数据填充点 (P2 冻结接口): 只填响应体里字面读到的能力', () => {
  let stub: Stub;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });

  it('字面字段 (context_length / capabilities.tool_calling) 才填; origin 按真实来源标', async () => {
    await clearCache();
    stub.setExpectedKey(KEY_A);
    stub.setMode({
      kind: 'models',
      body: {
        object: 'list',
        data: [
          { id: 'rich-1', context_length: 131072, capabilities: { tool_calling: true, reasoning: false } },
          { id: 'plain-2' },
        ],
      },
    });
    await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'rich-1' } });
    const cat = await MD.discoverProviderModels('deepseek', { force: true });
    expect(cat.origin).toBe('live');
    expect(cat.facts['rich-1']?.contextLength).toBe(131072);
    expect(cat.facts['rich-1']?.toolCalling).toBe('yes');
    expect(cat.facts['rich-1']?.reasoning).toBe('no');
    expect(cat.facts['plain-2']).toBeUndefined();

    expect(MD.isDiscoveryMetadataSourceWired()).toBe(true);
    expect(MC.listModelMetadataSources()).toContain('live-discovery');
    const src = MD.modelDiscoveryMetadataSource();
    expect(src.metadataOf({ provider: 'deepseek', model: 'rich-1' })).toEqual({
      origin: 'live', toolCalling: 'yes', reasoning: 'no', contextLength: 131072,
    });
    // 没有字面能力字段的 → 不出现 (保持 unknown, 不编)
    expect(src.metadataOf({ provider: 'deepseek', model: 'plain-2' })).toEqual({ origin: 'live' });
    // 从没跑过发现的 provider → 一个字段都不填
    expect(src.metadataOf({ provider: 'minimax', model: 'anything' })).toBeUndefined();
  });

  it('撤掉填充点 → 站点清空; 接回去 → 只有一条 (幂等)', () => {
    MC.resetModelMetadataSources();
    expect(MC.listModelMetadataSources()).toEqual([]);
    MD.registerDiscoveryMetadataSource();
    MD.registerDiscoveryMetadataSource();
    expect(MC.listModelMetadataSources()).toEqual(['live-discovery']);
  });

  it('填充点接上后, 目录条目真能拿到能力 (端到端: ModelEntry)', async () => {
    MD.registerDiscoveryMetadataSource();
    const entries = await MC.listModelsFor('deepseek', { extra: ['rich-1', 'plain-2'] });
    const rich = entries.find((e) => e.id === 'rich-1');
    expect(rich?.toolCalling).toBe('yes');
    expect(rich?.contextLength).toBe(131072);
    expect(rich?.origin).toBe('live');
    const unknownOne = entries.find((e) => e.id === 'plain-2');
    expect(unknownOne?.toolCalling).toBe('unknown');
    expect(unknownOne?.unknowns.some((u) => u.field === 'toolCalling')).toBe(true);
  });
});

// ============================================================
// ⑨ 解析 (纯函数): 三种协议形状
// ============================================================

describe('⑨ 目录响应解析 (真形状, 不编)', () => {
  it('openai 兼容 / gemini / ollama 三种形状', () => {
    expect(MD.parseCatalogBody({ data: [{ id: 'm1' }, 'm2'] }, 'openai-compatible'))
      .toEqual({ kind: 'ok', ids: ['m1', 'm2'], facts: {} });
    const gem = MD.parseCatalogBody({ models: [{ name: 'models/gemini-x', inputTokenLimit: 1000000, displayName: 'Gemini X' }] }, 'gemini');
    expect(gem.kind).toBe('ok');
    if (gem.kind === 'ok') {
      expect(gem.ids).toEqual(['gemini-x']);
      expect(gem.facts['gemini-x']?.contextLength).toBe(1000000);
      expect(gem.facts['gemini-x']?.displayName).toBe('Gemini X');
    }
    const oll = MD.parseCatalogBody({ models: [{ name: 'llama3:8b' }] }, 'ollama');
    expect(oll.kind === 'ok' && oll.ids).toEqual(['llama3:8b']);
    expect(MD.parseCatalogBody({ tags: ['x'] }, 'ollama').kind).toBe('ok');
  });

  it('空清单是"形状对但 0 个"; 垃圾形状是 shape_error (不当空目录)', () => {
    const empty = MD.parseCatalogBody({ data: [] }, 'openai-compatible');
    expect(empty.kind).toBe('ok');
    expect(empty.kind === 'ok' && empty.ids).toEqual([]);
    expect(MD.parseCatalogBody({ hello: 1 }, 'openai-compatible').kind).toBe('shape_error');
    expect(MD.parseCatalogBody('not json', 'openai-compatible').kind).toBe('shape_error');
    expect(MD.parseCatalogBody(null, 'openai-compatible').kind).toBe('shape_error');
  });

  it('字符串不是布尔/数字 → 不算结论 (unknown, 不编)', () => {
    const r = MD.parseCatalogBody({ data: [{ id: 'm', capabilities: { tool_calling: 'yes' }, context_length: '128k' }] }, 'openai-compatible');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.facts['m']).toBeUndefined();
  });
});

// ============================================================
// ⑩ 缓存文件健壮性 + 清理
// ============================================================

describe('⑩ 缓存文件坏了不影响使用; 清缓存可用', () => {
  it('坏 JSON → 当空表 + 警告; 发现照常跑', async () => {
    await clearCache();
    await fs.writeFile(MD.discoveryCachePath(), '{ this is not json', { mode: 0o600 });
    const file = await MD.readDiscoveryCache();
    expect(Object.keys(file.entries).length).toBe(0);
    expect((file.warnings || []).join('\n')).toContain('JSON');
    await writeConfig({ grok: { enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'grok-4' } });
    const cat = await MD.discoverProviderModels('grok');
    expect(cat.origin).toBe('curated');
    expect(cat.notes.join('\n')).toContain('JSON');
  });

  it('clearDiscoveryCache 真清掉 (全清 / 按 provider 清)', async () => {
    await clearCache();
    const stub = await startStub();
    try {
      stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'k1' }] } });
      await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'k1' } });
      await MD.discoverProviderModels('deepseek');
      expect(Object.keys((await MD.readDiscoveryCache()).entries).length).toBe(1);
      expect(await MD.clearDiscoveryCache('deepseek')).toBe(1);
      expect(Object.keys((await MD.readDiscoveryCache()).entries).length).toBe(0);
      const again = await MD.discoverProviderModels('deepseek');
      expect(again.origin).toBe('live');
      expect(await MD.clearDiscoveryCache()).toBe(1);
      expect(Object.keys((await MD.readDiscoveryCache()).entries).length).toBe(0);
    } finally {
      await stub.close();
    }
  });
});

// ============================================================
// ⑪ refresh 报告 (命令面能力)
// ============================================================

describe('⑪ refresh 报告: 逐家结论 + 失误清单 (能力可被命令面直接调)', () => {
  it('refreshModelDiscovery 强制真取 + 计数 + 失误带原因', async () => {
    await clearCache();
    const stub = await startStub();
    try {
      stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'r-1' }] } });
      stub.setExpectedKey(KEY_A);
      await writeConfig({
        deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'r-1' },
        grok: { enabled: true, apiKey: KEY_B, baseUrl: stub.baseUrl, model: 'grok-4' },
      });
      const report = await MD.refreshModelDiscovery(['deepseek', 'grok'], { timeoutMs: 500 });
      expect(report.force).toBe(true);
      expect(report.results.map((r) => r.provider)).toEqual(['deepseek', 'grok']);
      expect(report.counts.live).toBe(1);
      expect(report.counts.unavailable).toBe(1);       // grok 的 key 不对 (stub 只认 KEY_A 对应的头)
      expect(report.failures.map((f) => f.provider)).toEqual(['grok']);
      expect(String(report.failures[0].reason).length).toBeGreaterThan(0);
      expect(report.notes.join('\n')).toContain('一家都没删');
      expect(report.cachePath).toBe(MD.discoveryCachePath());
    } finally {
      await stub.close();
    }
  });

  it('formatCatalogLine / catalogOriginZh 不打印凭据', async () => {
    await clearCache();
    const stub = await startStub();
    try {
      stub.setMode({ kind: 'models', body: { object: 'list', data: [{ id: 'f-1' }] } });
      stub.setExpectedKey(KEY_A);
      await writeConfig({ deepseek: { enabled: true, apiKey: KEY_A, baseUrl: stub.baseUrl, model: 'f-1' } });
      const cat = await MD.discoverProviderModels('deepseek', { force: true });
      const line = MD.formatCatalogLine(cat);
      expect(line).toContain('实时目录(live)');
      expect(line.includes(KEY_A)).toBe(false);
      expect(line).toContain('fp:');
      expect(MD.catalogOriginZh('unavailable')).toBe('发现不可用');
      expect(MD.catalogOriginZh('curated')).toBe('内置目录');
      expect(MD.catalogOriginZh('custom')).toBe('用户声明/手输');
    } finally {
      await stub.close();
    }
  });
});
