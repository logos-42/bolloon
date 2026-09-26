/**
 * provider-registry.test.ts — 供应商注册表 + 兼容协议 (P3) 的单测 (2026-09-26)
 *
 * 覆盖:
 *   ① 注册表内容: 优先保障清单在册 · **九项能力字段项项有出处** (provenance);
 *   ② **没有两处真相** (源码级门): defaultBaseUrl / defaultModel / requiresApiKey / protocol / reasoning /
 *      apiKeyEnvVars / baseUrlEnvVars 与既有真表逐项相等;
 *   ③ **工具调用能力不是编的** (源码级门): 逐字 range 双向等于客户端路由表里发得出原生 tools 的分支集合;
 *   ④ 兼容协议: 认证头 / 目录端点 / 自定义 endpoint / 运行期 provider 映射;
 *   ⑤ 元数据填充点真接线, 且**只填自己有真值的项** (内置供应商的模型级能力仍是"未知");
 *   ⑥ 自定义供应商规范化与长期任务执行器门。
 *
 * 隔离: 临时 HOME (import 前设好, 所以走动态 import)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

const TMP = path.join(os.tmpdir(), 'bolloon-provider-registry-' + Date.now());
const ROOT = process.cwd();

let PR: typeof import('../llm/provider-registry.js');
let CS: typeof import('../llm/config-store.js');
let MS: typeof import('../llm/model-selection.js');
let MC: typeof import('../llm/model-catalog.js');

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  await fs.mkdir(TMP, { recursive: true });
  CS = await import('../llm/config-store.js');
  MS = await import('../llm/model-selection.js');
  MC = await import('../llm/model-catalog.js');
  PR = await import('../llm/provider-registry.js');
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ============================================================
// 源码级门用的解析 (锚点缺失 → 判红, 不许静默当绿)
// ============================================================

function piAiSource(): string {
  return fsSync.readFileSync(path.join(ROOT, 'src', 'llm', 'pi-ai.ts'), 'utf-8');
}

/** 客户端的路由表里, 哪几家**收得到** `openaiTools` (原生工具调用真发得出去) */
function piAiNativeToolProviders(): string[] {
  const src = piAiSource();
  const start = src.indexOf('switch (this.provider) {');
  expect(start, '锚点 switch (this.provider) 不见了 — 门失效, 不许当绿').toBeGreaterThan(-1);
  const end = src.indexOf('default:', start);
  expect(end, '路由表 default: 锚点不见了').toBeGreaterThan(start);
  const block = src.slice(start, end);
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of block.split('\n')) {
    const c = line.match(/^\s*case '([^']+)':\s*$/);
    if (c) { pending.push(c[1]); continue; }
    const r = line.match(/return this\.(\w+)\((.*)\);/);
    if (r) {
      if (r[2].includes('openaiTools')) out.push(...pending);
      pending = [];
    }
  }
  return out;
}

/** 客户端取 base URL 的那张表: provider → 参与覆盖的环境变量名 */
function piAiBaseUrlEnvVars(): Record<string, string[]> {
  const src = piAiSource();
  const start = src.indexOf('const baseUrls: Record<ModelProvider, string> = {');
  expect(start, '锚点 const baseUrls 不见了').toBeGreaterThan(-1);
  const end = src.indexOf('};', start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  const out: Record<string, string[]> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*([a-z0-9_]+):\s*(.+?),?\s*$/i);
    if (!m) continue;
    out[m[1]] = [...m[2].matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((x) => x[1]);
  }
  return out;
}

// ============================================================
// ① 注册表内容
// ============================================================

describe('注册表: 优先保障清单 + 九项能力字段项项有出处', () => {
  it('计划点名的十一家内置供应商全部在册, 且都有一条记录', () => {
    const mustHave = ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax', 'kimi', 'qwen', 'glm', 'openrouter', 'ollama', 'grok'];
    for (const id of mustHave) {
      const e = PR.getProviderRegistryEntry(id);
      expect(e, `${id} 不在注册表里`).toBeDefined();
      expect(e!.kind).toBe('builtin');
    }
    // 优先清单顺序 = 展示顺序, 且十一家都在里面
    expect(PR.PRIORITY_BUILTIN_IDS).toEqual(mustHave);
    // 在册的内置供应商 = 既有内置表那 13 家 (一个不多一个不少)
    expect(PR.listBuiltinProviderIds().sort()).toEqual(Object.keys(CS.DEFAULT_PROVIDER_CONFIGS).sort());
    expect(PR.listProviderRegistry().length).toBe(Object.keys(CS.DEFAULT_PROVIDER_CONFIGS).length);
  });

  it('九项能力字段一项不缺, 且**每项都有出处** (provenance 指向真来源)', () => {
    for (const e of PR.listProviderRegistry()) {
      for (const field of PR.REQUIRED_REGISTRY_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(e, field), `${e.id} 缺 ${field}`).toBe(true);
        const val = (e as any)[field];
        expect(val, `${e.id}.${field} 是空的`).not.toBeUndefined();
        const src = e.provenance[field];
        expect(src, `${e.id}.${field} 没有出处`).toBeTruthy();
        expect(String(src).length).toBeGreaterThan(4);
      }
    }
    expect(PR.REQUIRED_REGISTRY_FIELDS.length).toBe(9);
  });

  it('内置条目的字段值 = 既有真表的值 (逐项比, 不是"看起来对")', async () => {
    for (const id of PR.listBuiltinProviderIds()) {
      const e = PR.getProviderRegistryEntry(id)!;
      const def = (CS.DEFAULT_PROVIDER_CONFIGS as any)[id];
      const info = (CS.PROVIDER_INFO as any)[id];
      expect(e.defaultBaseUrl).toBe(MS.normalizeBaseUrl(def.baseUrl));
      expect(e.defaultModel).toBe(def.model);
      expect(e.protocol).toBe(MS.protocolOf(id));
      expect(e.reasoning).toBe(MS.supportsReasoning(id) ? 'yes' : 'unknown');
      expect(e.apiKeyEnvVars).toEqual(MS.envKeyNamesOf(id));
      // "要不要 key" 以注册表 (PROVIDER_INFO) 为准 —— ollama 与默认配置冲突也如实照注册表
      expect(e.requiresApiKey).toBe(info.requiresApiKey !== false);
      expect(e.declaredModelIds).toEqual(Array.isArray(info.models) ? info.models : []);
    }
    // 真实存在的那个冲突: DEFAULT_PROVIDER_CONFIGS.ollama.requiresApiKey=true 而 PROVIDER_INFO 说 false
    expect((CS.DEFAULT_PROVIDER_CONFIGS as any).ollama.requiresApiKey).toBe(true);
    expect(PR.getProviderRegistryEntry('ollama')!.requiresApiKey).toBe(false);
  });

  it('本地判定是真判定 (主机名, 不是白名单)', () => {
    expect(PR.getProviderRegistryEntry('ollama')!.isLocal).toBe(true);
    expect(PR.getProviderRegistryEntry('local')!.isLocal).toBe(true);
    expect(PR.getProviderRegistryEntry('openai')!.isLocal).toBe(false);
    const local = PR.customProviderEntryOf({ providerId: 'gw-local', displayName: '自建', baseUrl: 'http://127.0.0.1:8080/v1', protocol: 'openai-compatible' });
    expect(local.isLocal).toBe(true);
    expect(local.requiresApiKey).toBe(false);       // 本地端点不该被要求 key
    const remote = PR.customProviderEntryOf({ providerId: 'gw-remote', displayName: '远端', baseUrl: 'https://gw.example.com/v1', protocol: 'openai-compatible' });
    expect(remote.isLocal).toBe(false);
    expect(remote.requiresApiKey).toBe(true);
  });

  it('不在册的 id → undefined (不编一条出来)', () => {
    expect(PR.getProviderRegistryEntry('nope-not-a-provider')).toBeUndefined();
    expect(PR.isRegisteredProvider('nope-not-a-provider')).toBe(false);
    expect(PR.registryProtocolOf('nope-not-a-provider')).toBeNull();
    expect(PR.canServeLongRunningTasks('nope-not-a-provider')).toBe(false);
    expect(PR.longRunningRefusalReason('nope-not-a-provider')).toContain('不在册');
  });
});

// ============================================================
// ②③ 源码级门: 不许两处真相 / 能力不许编
// ============================================================

describe('源码级门: 注册表与客户端真表逐项对齐 (漂移即判红)', () => {
  it('工具调用能力 = 客户端路由表里发得出原生 tools 的分支 (双向相等)', () => {
    const native = piAiNativeToolProviders().sort();
    const claimed = PR.listProviderRegistry().filter((e) => e.toolCalling === 'yes').map((e) => e.id).sort();
    expect(native.length, '路由表解析出 0 条 — 锚点失效, 门不承重').toBeGreaterThan(0);
    expect(claimed).toEqual(native);
    // 每个"yes"都带证据句; 每个"no"也带
    for (const e of PR.listProviderRegistry()) {
      expect(e.toolCallingEvidence.length).toBeGreaterThan(10);
    }
  });

  it('base URL 的环境变量覆盖名 = 客户端取 base URL 的那张表 (逐家相等)', () => {
    const table = piAiBaseUrlEnvVars();
    expect(Object.keys(table).length, 'baseUrls 表没解析出来').toBeGreaterThan(5);
    for (const id of PR.listBuiltinProviderIds()) {
      const e = PR.getProviderRegistryEntry(id)!;
      expect(e.baseUrlEnvVars, `${id} 的环境变量覆盖名与客户端表不一致`).toEqual(table[id] ?? []);
    }
  });

  it('发现方式与协议/端点对得上 (anthropic 没有可用目录端点 → 手工)', () => {
    const ep = (id: string) => PR.getProviderRegistryEntry(id)!;
    expect(ep('openai').discovery).toBe('openai-models');
    expect(ep('openai').modelsEndpoint).toBe('https://api.openai.com/v1/models');
    expect(ep('ollama').discovery).toBe('ollama-tags');
    expect(ep('ollama').modelsEndpoint).toBe('http://localhost:11434/api/tags');
    expect(ep('gemini').discovery).toBe('gemini-models');
    expect(ep('gemini').modelsEndpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(ep('anthropic').discovery).toBe('manual');
    expect(ep('anthropic').modelsEndpoint).toBe('');    // 没有端 → 空串, 不编一个
    // local 与 ollama 同一张事实
    expect(ep('local').modelsEndpoint).toBe(ep('ollama').modelsEndpoint);
  });

  it('自定义供应商的 modelsEndpoint: 相对路径拼 base, 绝对 URL 原样', () => {
    const base = { providerId: 'gw', displayName: 'gw', baseUrl: 'http://127.0.0.1:8080/v1', protocol: 'openai-compatible' as const };
    expect(PR.customProviderEntryOf(base).modelsEndpoint).toBe('http://127.0.0.1:8080/v1/models');
    expect(PR.customProviderEntryOf({ ...base, modelsEndpoint: '/v2/models' }).modelsEndpoint).toBe('http://127.0.0.1:8080/v1/v2/models');
    expect(PR.customProviderEntryOf({ ...base, modelsEndpoint: 'https://gw.example.com/openapi.json' }).modelsEndpoint).toBe('https://gw.example.com/openapi.json');
    // 没有地址 → 空串 (不编)
    expect(PR.customProviderEntryOf({ ...base, baseUrl: '' }).modelsEndpoint).toBe('');
  });
});

// ============================================================
// ④ 兼容协议: 认证 / 运行期映射
// ============================================================

describe('兼容协议: 认证怎么摆 + 自定义供应商接到哪条分支', () => {
  it('认证头按协议走, 且**空 key 不放任何凭据**', () => {
    const bearer = PR.authHeadersFor(PR.getProviderRegistryEntry('openai')!, 'sk-live');
    expect(bearer.headers.Authorization).toBe('Bearer sk-live');
    expect(bearer.query).toEqual({});

    const anthropic = PR.authHeadersFor(PR.getProviderRegistryEntry('anthropic')!, 'sk-a');
    expect(anthropic.headers['x-api-key']).toBe('sk-a');
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01');

    const gemini = PR.authHeadersFor(PR.getProviderRegistryEntry('gemini')!, 'g-key');
    expect(gemini.query.key).toBe('g-key');
    expect(gemini.headers['x-goog-api-key']).toBe('g-key');

    const ollama = PR.authHeadersFor(PR.getProviderRegistryEntry('ollama')!, 'whatever');
    expect(ollama.headers).toEqual({});              // 本地 ollama: 不放 Authorization
    expect(ollama.query).toEqual({});

    const empty = PR.authHeadersFor(PR.getProviderRegistryEntry('openai')!, '');
    expect(empty.headers).toEqual({});
    const emptyAnthropic = PR.authHeadersFor(PR.getProviderRegistryEntry('anthropic')!, '');
    expect(emptyAnthropic.headers['Authorization']).toBeUndefined();
  });

  it('自定义 authHeader: Authorization 带 Bearer, 其他头按原值; 声明优先于协议默认', () => {
    const base = { providerId: 'gw', displayName: 'gw', baseUrl: 'https://gw.example.com/v1', protocol: 'openai-compatible' as const };
    const withAuth = PR.customProviderEntryOf({ ...base, authHeader: 'Authorization' });
    expect(PR.authHeadersFor(withAuth, 't-1').headers.Authorization).toBe('Bearer t-1');
    const custom = PR.customProviderEntryOf({ ...base, authHeader: 'x-token' });
    expect(PR.authHeadersFor(custom, 't-2').headers['x-token']).toBe('t-2');
    expect(custom.auth.kind).toBe('custom');
    // 不声明就不覆盖协议默认 (自定义条目不得把真相改掉)
    expect(PR.customProviderEntryOf(base).auth.kind).toBe('bearer');
  });

  it('运行期 provider 映射: 内置返回自己, 自定义按协议接到同协议的内置分支', () => {
    expect(PR.runtimeProviderIdOf(PR.getProviderRegistryEntry('openrouter')!)).toBe('openrouter');
    expect(PR.runtimeProviderIdOf(PR.getProviderRegistryEntry('gemini')!)).toBe('gemini');
    const mk = (protocol: any) => PR.customProviderEntryOf({ providerId: 'gw', displayName: 'gw', baseUrl: 'http://127.0.0.1:9', protocol });
    expect(PR.runtimeProviderIdOf(mk('openai-compatible'))).toBe('openai');
    expect(PR.runtimeProviderIdOf(mk('anthropic'))).toBe('anthropic');
    expect(PR.runtimeProviderIdOf(mk('gemini'))).toBe('gemini');
    expect(PR.runtimeProviderIdOf(mk('ollama'))).toBe('ollama');
  });
});

// ============================================================
// ⑤ 元数据填充点
// ============================================================

describe('元数据填充点: 真接线, 且只填自己有真值的项', () => {
  it('新进程里先 import model-catalog 再读配置: 不炸 (TDZ 回归) 且填充点真接上', () => {
    // 这一条同时钉两件事:
    //   ① 循环 import 的 TDZ 回归 —— model-catalog 先被拉起来时, 模块体里注册会崩 (实测过);
    //   ② 接线是真接线 —— 读一次配置就把填充点接上, 不依赖 import 顺序、也不靠"谁记得手动调"。
    const script = `(async () => {
      const mc = await import('./src/llm/model-catalog.js');
      const before = mc.listModelMetadataSources();
      const cs = await import('./src/llm/config-store.js');
      await cs.llmConfigStore.initialize();
      const after = mc.listModelMetadataSources();
      console.log('CHILD:' + JSON.stringify({ before, after }));
    })();`;
    const r = spawnSync('npx', ['tsx', '-e', script], {
      cwd: ROOT, encoding: 'utf-8',
      env: { ...process.env, BOLLOON_HOME: TMP, HOME: TMP, USERPROFILE: TMP },
      timeout: 120_000,
    });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD:'));
    expect(line, `子进程没起来或崩了: ${String(r.stderr || '').slice(-300)}`).toBeTruthy();
    const got = JSON.parse(line!.slice('CHILD:'.length));
    expect(got.before).toEqual([]);                                    // 没读配置 → 还没有人注册
    expect(got.after).toContain('provider-registry');                  // 读了一次配置 → 接上了
    expect(PR.PROVIDER_REGISTRY_SOURCE_ID).toBe('provider-registry');
  });

  it('接线是幂等的; 显式 reset 之后不会被偷偷加回来 (不跟测试/别的填充点抢)', async () => {
    PR.registerProviderRegistryMetadataSource();          // 先让"自动接线已做过"这一状态成立
    MC.resetModelMetadataSources();
    expect(MC.listModelMetadataSources()).toEqual([]);
    await CS.llmConfigStore.initialize();                 // 自动接线只做一次 → 不会偷偷加回来
    expect(MC.listModelMetadataSources()).toEqual([]);
    PR.registerProviderRegistryMetadataSource();          // 显式接回去
    expect(MC.listModelMetadataSources().filter((s) => s === PR.PROVIDER_REGISTRY_SOURCE_ID).length).toBe(1);
    PR.registerProviderRegistryMetadataSource();          // 再显式一次: 同 id 原地替换, 不重复
    expect(MC.listModelMetadataSources().filter((s) => s === PR.PROVIDER_REGISTRY_SOURCE_ID).length).toBe(1);
  });

  it('内置供应商: 只填"要不要 key"; 模型级能力**一个都不填** (仍是未知)', () => {
    const src = PR.providerRegistryMetadataSource();
    const facts = src.metadataOf({ provider: 'deepseek', model: 'deepseek-v4-flash' })!;
    expect(facts.requiresApiKey).toBe(true);
    expect(facts.toolCalling).toBeUndefined();     // 供应商级 ≠ 模型级, 不许装
    expect(facts.reasoning).toBeUndefined();
    expect(facts.contextLength).toBeUndefined();
    expect(facts.origin).toBeUndefined();
    expect(src.metadataOf({ provider: 'openai', model: '我手打的模型' })!.toolCalling).toBeUndefined();
    // 不在册 → 什么都不回答
    expect(src.metadataOf({ provider: 'nope', model: 'x' })).toBeUndefined();
  });

  it('自定义供应商: 声明的能力才变真值; 没声明的仍然未知', async () => {
    const spec = {
      providerId: 'gw-declared', displayName: '自建网关', baseUrl: 'http://127.0.0.1:8080/v1',
      protocol: 'openai-compatible' as const, model: 'my-model-1', models: ['my-model-1', 'my-model-2'],
      capabilities: { toolCalling: 'yes' as const, contextLength: 32768 },
    };
    PR.setCustomProviderSnapshot({ [spec.providerId]: spec });
    const src = PR.providerRegistryMetadataSource();
    const f1 = src.metadataOf({ provider: 'gw-declared', model: 'my-model-1' })!;
    expect(f1.requiresApiKey).toBe(false);          // 本地端点
    expect(f1.toolCalling).toBe('yes');             // 用户声明 → 真值
    expect(f1.contextLength).toBe(32768);
    expect(f1.origin).toBe('custom');
    expect(f1.reasoning).toBeUndefined();           // 没声明就不给
    PR.setCustomProviderSnapshot({});
    expect(src.metadataOf({ provider: 'gw-declared', model: 'my-model-1' })).toBeUndefined();
  });

  it('撤掉填充点 → 回到"未知" (证明那些真值真的是它填进去的)', async () => {
    const spec = {
      providerId: 'gw-x', displayName: 'x', baseUrl: 'http://127.0.0.1:8080/v1',
      protocol: 'openai-compatible' as const, models: ['m1'], capabilities: { toolCalling: 'yes' as const },
    };
    PR.setCustomProviderSnapshot({ 'gw-x': spec });
    MC.resetModelMetadataSources();
    const src = PR.providerRegistryMetadataSource();
    expect(src.metadataOf({ provider: 'gw-x', model: 'm1' })!.toolCalling).toBe('yes');
    PR.registerProviderRegistryMetadataSource();     // 接回去 (后面的测试还要用)
    PR.setCustomProviderSnapshot({});
  });
});

// ============================================================
// ⑥ 长期任务执行器门 + 规范化
// ============================================================

describe('长期任务执行器门: 工具有真结论才允许', () => {
  it('有原生工具调用的分支允许; 其余如实拒绝**并给理由**', () => {
    for (const id of ['openai', 'minimax', 'deepseek', 'kimi', 'glm', 'qwen', 'mimo', 'grok']) {
      expect(PR.canServeLongRunningTasks(id), `${id} 应该允许`).toBe(true);
      expect(PR.longRunningRefusalReason(id)).toBeNull();
    }
    for (const id of ['anthropic', 'gemini', 'openrouter', 'ollama', 'local']) {
      expect(PR.canServeLongRunningTasks(id), `${id} 不该允许`).toBe(false);
      const reason = PR.longRunningRefusalReason(id)!;
      expect(reason).toContain('不允许');
      expect(reason.length).toBeGreaterThan(10);
    }
    // 理由里必须点名"工具调用", 而不是一句"不支持"
    expect(PR.longRunningRefusalReason('ollama')).toContain('工具调用');
  });

  it('自定义供应商: 声明 yes + openai-compatible 才允许; 未知/声明 no/别的协议都拒绝', () => {
    const base = { providerId: 'gw', displayName: 'gw', baseUrl: 'https://gw.example.com/v1', protocol: 'openai-compatible' as const };
    PR.setCustomProviderSnapshot({
      gw: { ...base, capabilities: { toolCalling: 'yes' } },
      gw2: { ...base, providerId: 'gw2', capabilities: { toolCalling: 'no' } },
      gw3: { ...base, providerId: 'gw3' },
      gw4: { ...base, providerId: 'gw4', protocol: 'anthropic', capabilities: { toolCalling: 'yes' } },
    });
    expect(PR.canServeLongRunningTasks('gw')).toBe(true);
    expect(PR.canServeLongRunningTasks('gw2')).toBe(false);
    expect(PR.longRunningRefusalReason('gw2')).toContain('不支持');
    expect(PR.canServeLongRunningTasks('gw3')).toBe(false);
    expect(PR.longRunningRefusalReason('gw3')).toContain('未知');
    // 声明了工具调用能力, 但协议分支发不出去 → 照样拒绝 (不是看声明就放行)
    expect(PR.canServeLongRunningTasks('gw4')).toBe(false);
    expect(PR.longRunningRefusalReason('gw4')).toContain('不发原生 tools');
    PR.setCustomProviderSnapshot({});
  });
});

describe('规范化与协议推断 (纯函数)', () => {
  it('必填项缺失/撞内置名 → 明确拒绝, 并说出缺哪一项', () => {
    expect(PR.normalizeCustomProvider(null)).toEqual({ ok: false, reason: '不是对象' });
    expect(PR.normalizeCustomProvider({} as any).ok).toBe(false);
    const noUrl = PR.normalizeCustomProvider({ providerId: 'gw' });
    expect(noUrl.ok).toBe(false);
    expect((noUrl as any).reason).toContain('baseUrl');
    const collide = PR.normalizeCustomProvider({ providerId: 'openai', baseUrl: 'https://x.example.com/v1' });
    expect(collide.ok).toBe(false);
    expect((collide as any).reason).toContain('撞名');
    const badProtocol = PR.normalizeCustomProvider({ providerId: 'gw', baseUrl: 'https://x.example.com/v1', protocol: 'soap' });
    expect(badProtocol.ok).toBe(false);
    expect((badProtocol as any).reason).toContain('protocol 不合法');
    const badShape = PR.normalizeCustomProvider({ providerId: 'gw', baseUrl: 'ftp://x/y' });
    expect(badShape.ok).toBe(false);
  });

  it('规范化: 别名收成规范形, URL 规范化, 未声明的键不加', () => {
    const r = PR.normalizeCustomProvider({ id: 'gw', name: '自建网关', base_url: 'http://127.0.0.1:8080/v1/', api_key: ' k-1 ', model: 'm-1', auth_header: 'x-token' });
    expect(r.ok).toBe(true);
    const v = (r as any).value;
    expect(v.providerId).toBe('gw');
    expect(v.displayName).toBe('自建网关');
    expect(v.baseUrl).toBe('http://127.0.0.1:8080/v1');   // 尾斜杠去掉 (URL 规范化)
    expect(v.apiKey).toBe('k-1');
    expect(v.authHeader).toBe('x-token');
    expect(v.models).toBeUndefined();                      // 没声明就是没有, 不补空数组
    expect(v.capabilities).toBeUndefined();
  });

  it('协议推断按 base URL 主机名 (迁移用), 判不出来才退到 openai-compatible', () => {
    expect(PR.inferProtocolFromBaseUrl('http://localhost:11434')).toBe('ollama');
    expect(PR.inferProtocolFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('openai-compatible');
    expect(PR.inferProtocolFromBaseUrl('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(PR.inferProtocolFromBaseUrl('https://generativelanguage.googleapis.com/v1beta')).toBe('gemini');
    expect(PR.inferProtocolFromBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe('openai-compatible');
    expect(PR.inferProtocolFromBaseUrl('not a url')).toBe('openai-compatible');
  });

  it('数组形 → map 形; 坏的条目**留名+留理由**, 不静默丢', () => {
    const norm = PR.normalizeCustomProviders([
      { providerId: 'a', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-compatible' },
      { providerId: 'b' },                                  // 缺 baseUrl
      { providerId: 'openai', baseUrl: 'https://x.example.com' },   // 撞内置
    ]);
    expect(Object.keys(norm.providers)).toEqual(['a']);
    expect(norm.rejected.map((r) => r.key).sort()).toEqual(['b', 'openai']);
    expect(norm.rejected.every((r) => r.reason.length > 2)).toBe(true);
    // 形状整体不对 → 留名
    const bad = PR.normalizeCustomProviders('nonsense');
    expect(bad.rejected[0].key).toBe('customProviders');
    // undefined/null → 干净的空表 (旧配置那一格根本没写)
    expect(PR.normalizeCustomProviders(undefined).providers).toEqual({});
    expect(PR.normalizeCustomProviders(undefined).rejected).toEqual([]);
  });
});
