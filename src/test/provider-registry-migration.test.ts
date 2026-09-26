/**
 * provider-registry-migration.test.ts — 自定义供应商的持久化 + **旧配置向后兼容** (P3) 回归 (2026-09-26)
 *
 * 这是 P8 #13「旧 `llm-config.json` 可迁移」在 P3 这一层的回归:
 *   ① 只有内置供应商的旧配置 → 读出来**磁盘字节不变** (读一下不改用户文件), 内置 13 家照旧;
 *   ② 旧文件名 `llm-config.json` 里写了自定义端点 + `activeProvider` 指向它 →
 *      **不许被静默改成 ollama** (P3 之前就是这样失效的), 迁移后有效配置仍是它;
 *   ③ 早期**数组形** `customProviders` → 按 providerId 收成 map, 内容不丢;
 *   ④ 旧版本把自定义端点直接写进 `providers.<id>` → **吸收**, 协议按 base URL 主机名推;
 *   ⑤ 形状损坏的那一格 → 留名 + 留理由 (不静默当空表);
 *   ⑥ 增/改/删真落盘、重启 (新实例) 读得回、**只动 customProviders 一格**;
 *   ⑦ 凭据永不明文出现在展示/导出路径。
 *
 * 隔离: 每个用例自己一份临时 HOME (import 前设好 → 动态 import)。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';

const TMP = path.join(os.tmpdir(), 'bolloon-provider-migration-' + Date.now());
const CFG = path.join(TMP, 'bolloon-config.json');
const LEGACY = path.join(TMP, 'llm-config.json');

let PR: typeof import('../llm/provider-registry.js');
let STORE: typeof import('../llm/custom-provider-store.js');
let CS: typeof import('../llm/config-store.js');
let MS: typeof import('../llm/model-selection.js');

const HOME = process.env.BOLLOON_HOME;

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  await fs.mkdir(TMP, { recursive: true });
  CS = await import('../llm/config-store.js');
  MS = await import('../llm/model-selection.js');
  PR = await import('../llm/provider-registry.js');
  STORE = await import('../llm/custom-provider-store.js');
});

afterAll(async () => {
  process.env.BOLLOON_HOME = HOME;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await fs.rm(CFG, { force: true });
  await fs.rm(LEGACY, { force: true });
  CS.llmConfigStore.invalidate();
  PR.setCustomProviderSnapshot({});     // 注册表快照也是"上一次的", 一起清掉
});

function sha(file: string): string {
  try { return crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return 'missing'; }
}

async function writeCfg(obj: unknown, file = CFG): Promise<void> {
  await fs.writeFile(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  CS.llmConfigStore.invalidate();
}

/** 旧配置原样: 只有内置供应商, 没有 customProviders 这一格 */
function legacyBuiltinOnly(): any {
  return {
    activeProvider: 'deepseek',
    providers: {
      deepseek: { enabled: true, apiKey: 'k-legacy-deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', requiresApiKey: false },
      openai: { enabled: true, apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', requiresApiKey: true },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// ============================================================
// ① 旧配置原样可用, 且"读一下"不写盘
// ============================================================

describe('向后兼容①: 没有 customProviders 的旧配置', () => {
  it('读出来不报错、内置照旧、customProviders = 空表', async () => {
    await writeCfg(legacyBuiltinOnly());
    const cfg: any = await CS.llmConfigStore.getConfig();
    expect(cfg.activeProvider).toBe('deepseek');
    expect(Object.keys(cfg.providers).sort()).toEqual(Object.keys(CS.DEFAULT_PROVIDER_CONFIGS).sort());
    expect(cfg.customProviders).toEqual({});
    expect(await STORE.readCustomProviders()).toEqual({});
    expect(PR.listProviderRegistry().length).toBe(Object.keys(CS.DEFAULT_PROVIDER_CONFIGS).length);
  });

  it('initialize() **不改盘** (字节不变) —— 迁移只在显式写的时候落盘', async () => {
    await writeCfg(legacyBuiltinOnly());
    const before = sha(CFG);
    await CS.llmConfigStore.initialize();
    await CS.llmConfigStore.getConfig();
    await STORE.readCustomProviders();
    expect(sha(CFG)).toBe(before);
  });

  it('有效模型配置与旧配置一模一样', async () => {
    await writeCfg(legacyBuiltinOnly());
    const eff = await MS.effectiveModelConfig({});
    expect(eff.provider).toBe('deepseek');
    expect(eff.model).toBe('deepseek-v4-flash');
    expect(eff.baseUrl).toBe('https://api.deepseek.com/v1');
  });
});

// ============================================================
// ② 旧文件名 + 自定义端点当默认 → 不许被静默改掉
// ============================================================

describe('向后兼容②: 旧 llm-config.json 里的自定义端点', () => {
  it('activeProvider 指向自定义端点 → 不被静默改成 ollama; 迁移后有效配置还是它', async () => {
    await writeCfg({
      activeProvider: 'my-gw',
      providers: {
        'my-gw': { enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model-7', requiresApiKey: false },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, LEGACY);

    await CS.llmConfigStore.initialize();
    const cfg: any = await CS.llmConfigStore.getConfig();
    // P3 之前的实现: 只认内置表 → 这里会变成 'ollama' (旧配置直接失效)
    expect(cfg.activeProvider).toBe('my-gw');

    const eff = await MS.effectiveModelConfig({});
    expect(eff.provider).toBe('my-gw');
    expect(eff.model).toBe('local-model-7');
    expect(eff.baseUrl).toBe('http://127.0.0.1:8080/v1');

    // 旧文件被迁移进新文件名
    expect(await fs.readFile(CFG, 'utf-8').catch(() => '')).not.toBe('');
    // 自定义端点被**吸收**进注册表 (协议按 base URL 主机名推: 环回地址 → openai-compatible)
    const loaded = await STORE.loadCustomProviders();
    expect(loaded.absorbed.map((a) => a.providerId)).toEqual(['my-gw']);
    expect(loaded.absorbed[0].inferredProtocol).toBe(true);
    expect(loaded.providers['my-gw'].protocol).toBe('openai-compatible');
    expect(loaded.providers['my-gw'].model).toBe('local-model-7');
    const entry = PR.getProviderRegistryEntry('my-gw')!;
    expect(entry.kind).toBe('custom');
    expect(entry.defaultBaseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  it('只有完全读不出来的 activeProvider 才退到 ollama', async () => {
    await writeCfg({ ...legacyBuiltinOnly(), activeProvider: 'never-existed' });
    const cfg: any = await CS.llmConfigStore.getConfig();
    expect(cfg.activeProvider).toBe('ollama');
  });

  it('名字不合法/没有地址的未知键不被吸收 (不猜)', async () => {
    await writeCfg({
      activeProvider: 'deepseek',
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
        'bad name!': { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' },
        emptyone: { model: 'y' },
      },
    });
    const loaded = await STORE.loadCustomProviders();
    expect(loaded.providers).toEqual({});
    expect(loaded.absorbed).toEqual([]);
  });
});

// ============================================================
// ③④ 形态迁移
// ============================================================

describe('向后兼容③④: 数组形与损坏形', () => {
  it('早期数组形 → map 形, 内容不丢', async () => {
    await writeCfg({
      ...legacyBuiltinOnly(),
      customProviders: [
        { providerId: 'gw-a', displayName: '网关 A', baseUrl: 'https://gw-a.example.com/v1', protocol: 'openai-compatible', model: 'a-1', apiKey: 'k-a' },
        { providerId: 'gw-b', baseUrl: 'http://localhost:11434', protocol: 'ollama', model: 'llama4' },
      ],
    });
    const loaded = await STORE.loadCustomProviders();
    expect(Object.keys(loaded.providers).sort()).toEqual(['gw-a', 'gw-b']);
    expect(loaded.notes.join(' ')).toContain('数组形');
    expect(loaded.providers['gw-a'].displayName).toBe('网关 A');
    expect(loaded.providers['gw-a'].model).toBe('a-1');
    expect(loaded.providers['gw-b'].protocol).toBe('ollama');
    // 新写的配置里, 数组形被收成 map 形 (内存视图)
    const cfg: any = await CS.llmConfigStore.getConfig();
    expect(Array.isArray(cfg.customProviders)).toBe(false);
    expect(Object.keys(cfg.customProviders).sort()).toEqual(['gw-a', 'gw-b']);
  });

  it('那一格形状损坏 → 留名 + 留理由, 内置供应商照旧', async () => {
    await writeCfg({ ...legacyBuiltinOnly(), customProviders: 'oops-a-string' });
    const loaded = await STORE.loadCustomProviders();
    expect(loaded.providers).toEqual({});
    expect(loaded.rejected.length).toBe(1);
    expect(loaded.rejected[0].key).toBe('customProviders');
    expect(loaded.rejected[0].reason).toContain('形状');
    const cfg: any = await CS.llmConfigStore.getConfig();
    expect(cfg.activeProvider).toBe('deepseek');
  });

  it('单条坏条目留名留理由, 好的照收 (不静默丢)', async () => {
    await writeCfg({
      ...legacyBuiltinOnly(),
      customProviders: {
        good: { providerId: 'good', baseUrl: 'http://127.0.0.1:8080/v1', protocol: 'openai-compatible', model: 'g-1' },
        broken: { providerId: 'broken' },
        collides: { providerId: 'openai', baseUrl: 'https://x.example.com/v1' },
      },
    });
    const loaded = await STORE.loadCustomProviders();
    expect(Object.keys(loaded.providers)).toEqual(['good']);
    expect(loaded.rejected.map((r) => r.key).sort()).toEqual(['broken', 'collides']);
  });
});

// ============================================================
// ⑤ 增/改/删真落盘 + 只动一格
// ============================================================

describe('自定义供应商写路径: 真落盘 / 只动一格 / 重启读得回', () => {
  const spec = {
    providerId: 'gw-up', displayName: '自建上行', baseUrl: 'http://127.0.0.1:9099/v1',
    protocol: 'openai-compatible' as const, apiKey: 'k-up-secret', model: 'up-1',
    modelsEndpoint: '/models', authHeader: 'x-token', models: ['up-1'],
    capabilities: { toolCalling: 'yes' as const },
  };

  it('新增 → 盘上有这一格 → 新实例 (重启) 读得回 → 注册表认得', async () => {
    await writeCfg(legacyBuiltinOnly());
    const add = await STORE.addCustomProvider(spec as any);
    expect(add.ok, add.reason).toBe(true);

    const onDisk: any = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(onDisk.customProviders['gw-up'].baseUrl).toBe('http://127.0.0.1:9099/v1');
    expect(onDisk.customProviders['gw-up'].protocol).toBe('openai-compatible');
    // 其他字段一个字节没动
    expect(onDisk.activeProvider).toBe('deepseek');
    expect(onDisk.providers.deepseek.model).toBe('deepseek-v4-flash');

    // "重启": 丢掉内存缓存重新读盘
    CS.llmConfigStore.invalidate();
    await CS.llmConfigStore.initialize();
    const back = await STORE.readCustomProviders();
    expect(back['gw-up'].model).toBe('up-1');
    expect(back['gw-up'].authHeader).toBe('x-token');
    const entry = PR.getProviderRegistryEntry('gw-up')!;
    expect(entry.displayName).toBe('自建上行');
    expect(entry.auth.header).toBe('x-token');
    expect(entry.toolCalling).toBe('yes');
    expect(PR.canServeLongRunningTasks('gw-up')).toBe(true);
  });

  it('改 → 只改给的那几项; 删 → 真的没了', async () => {
    await writeCfg(legacyBuiltinOnly());
    await STORE.addCustomProvider(spec as any);
    const up = await STORE.updateCustomProvider('gw-up', { model: 'up-2' });
    expect(up.ok, up.reason).toBe(true);
    let back = await STORE.readCustomProviders();
    expect(back['gw-up'].model).toBe('up-2');
    expect(back['gw-up'].baseUrl).toBe('http://127.0.0.1:9099/v1');   // 没给的键保持原样

    const rm = await STORE.removeCustomProvider('gw-up');
    expect(rm.ok, rm.reason).toBe(true);
    back = await STORE.readCustomProviders();
    expect(back).toEqual({});
    const onDisk: any = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(onDisk.customProviders).toEqual({});
    expect(onDisk.providers.deepseek.model).toBe('deepseek-v4-flash');
  });

  it('与内置撞名 / 缺地址 / 不存在的 id → 拒绝, 且**磁盘字节不变**', async () => {
    await writeCfg(legacyBuiltinOnly());
    const before = sha(CFG);
    const collide = await STORE.addCustomProvider({ ...spec, providerId: 'openai' } as any);
    expect(collide.ok).toBe(false);
    expect(collide.reason).toContain('撞名');
    const noUrl = await STORE.addCustomProvider({ providerId: 'gw-x', displayName: 'x', baseUrl: '', protocol: 'openai-compatible' } as any);
    expect(noUrl.ok).toBe(false);
    const noSuch = await STORE.updateCustomProvider('not-there', { model: 'm' });
    expect(noSuch.ok).toBe(false);
    expect(noSuch.reason).toContain('不在册');
    const noSuchRemove = await STORE.removeCustomProvider('not-there');
    expect(noSuchRemove.ok).toBe(false);
    expect(sha(CFG)).toBe(before);      // 失败 = 什么都没落盘
  });

  it('配置里有读不出来的条目时, 写操作**拒绝** (不把用户的坏写法悄悄抹掉)', async () => {
    await writeCfg({
      ...legacyBuiltinOnly(),
      customProviders: { broken: { providerId: 'broken' } },   // 缺 baseUrl
    });
    const before = sha(CFG);
    const add = await STORE.addCustomProvider({
      providerId: 'gw-new', displayName: 'n', baseUrl: 'http://127.0.0.1:8081/v1', protocol: 'openai-compatible',
    } as any);
    expect(add.ok).toBe(false);
    expect(add.reason).toContain('读不出来');
    expect(add.reason).toContain('broken');
    expect(sha(CFG)).toBe(before);
  });

  it('配置文件权限仍是 0600 (凭据不许被别人读)', async () => {
    await writeCfg(legacyBuiltinOnly());
    await STORE.addCustomProvider(spec as any);
    const st = await fs.stat(CFG);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

// ============================================================
// ⑥ 凭据不进展示路径
// ============================================================

describe('展示与导出: 凭据一律脱敏', () => {
  it('行文本与导出副本里没有明文 key', async () => {
    const spec = {
      providerId: 'gw-sec', displayName: '网关', baseUrl: 'https://gw.example.com/v1',
      protocol: 'openai-compatible' as const, apiKey: 'sk-topsecret-9182', model: 'm-1',
    };
    const line = STORE.formatCustomProviderLine(spec as any);
    expect(line).not.toContain('sk-topsecret-9182');
    expect(line).toContain('9182');                    // 只留尾 4 位
    expect(line).toContain('openai-compatible');
    const red = STORE.redactCustomProviders({ 'gw-sec': spec as any });
    expect(red['gw-sec'].apiKey).toBe('[REDACTED]');
    expect(JSON.stringify(red)).not.toContain('sk-topsecret-9182');

    await writeCfg(legacyBuiltinOnly());
    await STORE.addCustomProvider(spec as any);
    const snippet = await STORE.customProvidersFileSnippet();
    expect(snippet).not.toContain('sk-topsecret-9182');
    expect(snippet).toContain('[REDACTED]');
  });

  it('无 key / 环境变量 / 本地免 key 三种状态的文案不同 (不含凭据)', () => {
    const base = { providerId: 'gw', displayName: 'gw', baseUrl: 'https://gw.example.com/v1', protocol: 'openai-compatible' as const };
    expect(STORE.formatCustomProviderLine({ ...base, apiKey: 'k-1234' } as any)).toContain('尾号 1234');
    expect(STORE.formatCustomProviderLine({ ...base, apiKeyEnvVar: 'MY_KEY' } as any)).toContain('环境变量 MY_KEY');
    expect(STORE.formatCustomProviderLine(base as any)).toContain('key=缺');
    expect(STORE.formatCustomProviderLine({ ...base, baseUrl: 'http://127.0.0.1:8080/v1' } as any)).toContain('key=不需要');
  });
});
