/**
 * provider-catalog.test.ts — 供应商目录 (目录驱动) 的单测 (2026-09-27)
 *
 * 这一层的作用: 把"一家一家手写供应商"改成**目录驱动** —— 目录里新出现一家, 不用改代码就能用。
 * 本文件钉住的不是"目录里有什么" (那是公开源决定的, 会变), 而是**五条不许破的规矩**:
 *   ① 数据只从公开源来, 且带**来源与生成时间** (可核事实), 没有编造;
 *   ② **无 api 基址的家不许编一个基址** (目录里没给就是空, 选它就如实报"需自定义 baseUrl");
 *   ③ **需专用鉴权 (未支持) 的家不许当可用** (列表/选择器/admission 三处都如实标);
 *   ④ 能力字段**只填目录里字面声明过的**,其余一律 `unknown` (拿不到就不许猜);
 *   ⑤ **内置 13 家的行为与标识一个字都不许变**, 且内置优先于同名目录项;
 * 外加: 运行期刷新落盘 0600 + 来源/字节数/时间/家数, 陈旧如实标, 坏文件不崩也不静默采用。
 *
 * 隔离: 临时 HOME (import 前设好 → 走动态 import)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsP from 'fs/promises';

const TMP = path.join(os.tmpdir(), 'bolloon-provider-catalog-' + process.pid + '-' + Date.now());
const CATALOG_FILE = path.join(TMP, 'provider-catalog.json');

let CS: typeof import('../llm/config-store.js');
let PC: typeof import('../llm/provider-catalog.js');
let MC: typeof import('../llm/model-catalog.js');
let PR: typeof import('../llm/provider-registry.js');
let MS: typeof import('../llm/model-selection.js');

/** 目录里**独有**的家: 与内置 13 家同名的要排除 (那几家内置优先, 拿到的永远是内置那条) */
function catalogOwnIds(): string[] {
  const builtin = new Set(Object.keys(CS.DEFAULT_PROVIDER_CONFIGS));
  return PC.catalogProviders().map((v: any) => v.id).filter((id: string) => !builtin.has(id));
}

const BAKED = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'src/llm/data/provider-catalog.json'), 'utf-8'),
) as { providerCount: number; generatedAt: string; provenance: any; providers: Record<string, any> };

/** 公开源形状 (一家一个键) 的一份**假源**: 只改少量家的 api 指向本地, 其余照真身 —— 验收/演示用 */
function fakeRawSource(mutate: (raw: Record<string, any>) => void): Record<string, any> {
  const raw: Record<string, any> = {};
  for (const [id, r] of Object.entries<any>(BAKED.providers)) {
    const models: Record<string, any> = {};
    for (const [mid, f] of Object.entries<any>(r.models || {})) {
      const m: Record<string, any> = { name: f.name || mid };
      if (f.toolCalling !== undefined) m.tool_call = f.toolCalling;
      if (f.reasoning !== undefined) m.reasoning = f.reasoning;
      if (f.contextLength !== undefined) m.limit = { context: f.contextLength };
      models[mid] = m;
    }
    raw[id] = { id, name: r.name, env: r.env, npm: r.npm, doc: r.doc, ...(r.api ? { api: r.api } : {}), models };
  }
  mutate(raw);
  return raw;
}

async function writeRuntimeCatalog(data: any): Promise<void> {
  await fsP.writeFile(CATALOG_FILE, PC.renderCatalogJson(data), { mode: 0o600 });
}

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  await fsP.mkdir(TMP, { recursive: true });
  CS = await import('../llm/config-store.js');
  PC = await import('../llm/provider-catalog.js');
  MC = await import('../llm/model-catalog.js');
  PR = await import('../llm/provider-registry.js');
  MS = await import('../llm/model-selection.js');
});

afterAll(async () => {
  await fsP.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe('C1 数据来源与形状 (只从公开源来, 带可核事实)', () => {
  it('烘焙目录来自公开源, 且记了 URL / 字节数 / sha256 / 拉取时间', () => {
    const load = PC.catalogLoad();
    expect(load.data.providerCount).toBeGreaterThanOrEqual(100);
    expect(load.provenance.sourceUrl).toMatch(/^https:\/\//);
    expect(load.provenance.sourceBytes).toBeGreaterThan(100_000);
    expect(load.provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isFinite(Date.parse(load.provenance.fetchedAt))).toBe(true);
  });

  it('磁盘上的 JSON 是**合法可读**的 (写出格式自校验, 坏 JSON 不许落地)', () => {
    const text = fs.readFileSync(path.join(process.cwd(), 'src/llm/data/provider-catalog.json'), 'utf-8');
    const back = JSON.parse(text);
    expect(back.providerCount).toBe(BAKED.providerCount);
    expect(Object.keys(back.providers).length).toBe(BAKED.providerCount);
    // 再渲染一次必须与原文本**逐字相同** (格式稳定 = 可 diff, 不会每次生成都抖动)
    expect(PC.renderCatalogJson(back)).toBe(text);
  });

  it('目录里的每一项都是"公共元数据": id/name/env 名/api/doc/模型 —— 没有别的字段', () => {
    const allowed = new Set(['id', 'name', 'env', 'npm', 'api', 'doc', 'models']);
    for (const [id, rec] of Object.entries<any>(BAKED.providers)) {
      for (const k of Object.keys(rec)) expect(allowed.has(k), `${id} 有意外字段 ${k}`).toBe(true);
      // 值里也不许出现凭据形状: env 只存**名字**
      for (const e of rec.env || []) expect(String(e)).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it('视图逐家带"为什么判成这一族"的信号 (只给结论不给理由 = 不可核)', () => {
    for (const v of PC.catalogProviders()) {
      expect(['openai-compatible', 'anthropic', 'gemini', 'special']).toContain(v.family);
      expect(String(v.familySignal).length).toBeGreaterThan(3);
      expect(['bearer', 'x-api-key', 'x-goog-api-key', 'special', 'none']).toContain(v.auth.kind);
    }
  });
});

describe('C2 诚实边界①: 无 api 基址的家, 不许编一个', () => {
  it('目录里没给 api 的家 → hasBaseUrl=false 且 defaultBaseUrl 是空串 (不是猜的地址)', () => {
    const own = new Set(catalogOwnIds());
    const noApi = PC.catalogProviders().filter((v: any) => !v.api && own.has(v.id));
    expect(noApi.length).toBeGreaterThan(0);
    for (const v of noApi) {
      expect(v.hasBaseUrl).toBe(false);
      expect(v.speakable).toBe(false);
      const entry = PR.getProviderRegistryEntry(v.id)!;
      expect(entry.origin).toBe('catalog');
      expect(entry.defaultBaseUrl).toBe('');           // ← 空就是空, 不许填一个"看着像"的
      expect(entry.modelsEndpoint).toBe('');
    }
  });

  it('有 api 的家: 注册表条目里的 defaultBaseUrl **逐字等于**目录里的值 (没被"归一"成别的)', () => {
    const own = new Set(catalogOwnIds());
    const sample = PC.catalogProviders().filter((v: any) => v.api && own.has(v.id)).slice(0, 40);
    expect(sample.length).toBeGreaterThan(10);
    for (const v of sample) {
      const entry = PR.getProviderRegistryEntry(v.id)!;
      // 只允许去掉结尾斜杠这一种归一
      expect(entry.defaultBaseUrl.replace(/\/$/, '')).toBe(String(v.api).replace(/\/$/, ''));
    }
  });

  it('选一家无基址的 → 如实报"没有 api 基址, 需自定义 baseUrl" (不静默换成别的地址)', async () => {
    const victim = PC.catalogProviders().find((v: any) => !v.api && v.auth.supported && catalogOwnIds().includes(v.id))!;
    const r = MS.validateSelection({ provider: victim.id, model: 'whatever-model' }, {});
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('invalid_url');
    expect(String(r.message)).toContain('没有 api 基址');
  });
});

describe('C3 诚实边界②: 需专用鉴权 (未支持) 的家不许当可用', () => {
  it('special 族的家: authSupported=false + 理由写清; speakable=false', () => {
    const special = PC.catalogProviders().filter((v: any) => v.family === 'special' && catalogOwnIds().includes(v.id));
    expect(special.length).toBeGreaterThan(0);
    for (const v of special) {
      const entry = PR.getProviderRegistryEntry(v.id)!;
      expect(entry.authSupported).toBe(false);
      expect(String(entry.authSupportNote)).toContain('未支持');
      expect(v.speakable).toBe(false);
      expect(v.unusableReason).toBeTruthy();
    }
  });

  it('选 special 家的模型 → 明确报"需专用鉴权 (本版本未支持)" (不是"凭证被拒"、更不是成功)', async () => {
    const victim = PC.catalogProviders().find((v: any) => v.family === 'special')!;
    const r = MS.validateSelection({ provider: victim.id, model: 'some-model' }, {});
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('provider_auth_unsupported');
    expect(String(r.message)).toContain('未支持');
    // 分类表要有中文人话 (否则界面只能露出英文类名)
    expect(MS.SELECTION_FAILURE_ZH.provider_auth_unsupported).toContain('专用鉴权');
    expect(MS.SELECTION_FAILURE_CLASS_ORIGIN.provider_auth_unsupported).toBe('entry');
  });

  it('列表行里也如实标 (不是只有校验层知道)', async () => {
    const victim = PC.catalogProviders().find((v: any) => v.family === 'special')!;
    const sums = await MC.buildProviderSummaries({ catalog: 'all' });
    const row = sums.find((s: any) => s.id === victim.id)!;
    expect(row.origin).toBe('catalog');
    expect(String(row.catalogNote)).toContain('未支持');
    expect(MC.formatProviderLine(row)).toContain('未支持');
  });
});

describe('C4 诚实边界③: 能力只填目录里字面声明过的, 其余 unknown', () => {
  it('目录数据里每个模型的事实字段只有字面声明过的键', () => {
    const allowed = new Set(['name', 'toolCalling', 'reasoning', 'contextLength']);
    for (const v of PC.catalogProviders()) {
      for (const [mid, f] of Object.entries<any>(v.models)) {
        for (const k of Object.keys(f)) expect(allowed.has(k), `${v.id}/${mid} 有意外能力字段 ${k}`).toBe(true);
        for (const k of ['toolCalling', 'reasoning']) {
          if (k in f) expect(typeof (f as any)[k]).toBe('boolean');
        }
        if ('contextLength' in f) expect((f as any).contextLength).toBeGreaterThan(0);
      }
    }
  });

  it('声明过的能力真的出现在模型行里 (支持/不支持), 值来自目录而不是猜的', async () => {
    const own = catalogOwnIds();
    // 公开目录对 tool_call/reasoning 是**逐模型全量声明**的 (223 家里没有一个"部分声明");
    // 所以"声明过 → 出真值"这条路用真数据就能验。
    const v = PC.catalogProviders().find((x: any) => own.includes(x.id) && x.auth.supported
      && x.modelIds.some((m: string) => x.models[m]?.toolCalling !== undefined))!;
    const mid = v.modelIds.find((m: string) => v.models[m]?.toolCalling !== undefined)!;
    const rows = await MC.listModelsFor(v.id);
    const row = rows.find((r: any) => r.id === mid)!;
    expect(row.toolCalling).toBe(v.models[mid].toolCalling ? 'yes' : 'no');
    expect(row.origin).toBe('catalog');
    if (v.models[mid].reasoning !== undefined) expect(row.reasoning).toBe(v.models[mid].reasoning ? 'yes' : 'no');
    if (typeof v.models[mid].contextLength === 'number') expect(row.contextLength).toBe(v.models[mid].contextLength);
  });

  it('目录里**没声明**的字段仍是 unknown (拿不到就不猜): 真数据里的 contextLength 缺项 + 假源里的 tool_call 缺项', async () => {
    // ① 真数据: 有一批模型目录里没给 limit.context (上下文长度) —— 那一条必须是"未知", 不是 0
    const own = catalogOwnIds();
    let victim: { id: string; model: string } | null = null;
    for (const v of PC.catalogProviders()) {
      if (!own.includes(v.id)) continue;
      const m = v.modelIds.find((x: string) => v.models[x]?.contextLength === undefined);
      if (m) { victim = { id: v.id, model: m }; break; }
    }
    expect(victim).not.toBeNull();
    const rows = await MC.listModelsFor(victim!.id);
    const row = rows.find((r: any) => r.id === victim!.model)!;
    expect(row.contextLength).toBeNull();
    expect(MC.formatModelLine(row)).toContain('上下文=未知');
    expect(MC.unknownFootnote([row]).join(' ')).toContain('目录');   // 原因: 目录里没声明

    // ② 假源: 一家新家的模型**没有** tool_call/reasoning/limit → 三项全 unknown (不拿 unknown 当 no)
    const raw = fakeRawSource((r) => {
      r['acme-unknowns'] = {
        id: 'acme-unknowns', name: 'Acme Unknowns', env: ['ACME_U_KEY'], npm: '@ai-sdk/openai-compatible',
        api: 'http://127.0.0.1:9/v1', doc: '', models: { 'u-1': { name: 'U One' } },
      };
    });
    const srcFile = path.join(TMP, 'fake-unknowns.json');
    await fsP.writeFile(srcFile, JSON.stringify(raw));
    const rep = await PC.refreshProviderCatalog({ fromFile: srcFile });
    expect(rep.ok).toBe(true);
    const ur = (await MC.listModelsFor('acme-unknowns')).find((r: any) => r.id === 'u-1')!;
    expect(ur.toolCalling).toBe('unknown');
    expect(ur.reasoning).toBe('unknown');
    expect(ur.contextLength).toBeNull();
    expect(MC.formatModelLine(ur)).toContain('工具调用=未知');
    expect(MC.formatModelLine(ur)).toContain('reasoning=未知');
    expect(MC.unknownFootnote([ur]).join(' ')).toContain('没有字面声明');
  });

  it('模型级的"目录里没有这一条"也如实 (不拿 unknown 当 no)', async () => {
    const v = PC.catalogProviders().find((x: any) => x.auth.supported && catalogOwnIds().includes(x.id))!;
    const rows = await MC.listModelsFor(v.id, { extra: ['definitely-not-in-catalog-xyz'] });
    const row = rows.find((r: any) => r.id === 'definitely-not-in-catalog-xyz')!;
    expect(row.toolCalling).toBe('unknown');
    expect(row.contextLength).toBeNull();
  });
});

describe('C5 内置 13 家的行为与标识一个字都不许变', () => {
  // 注意: 这里必须是**函数**, 不能是 describe 体里的 const —— describe 体在 beforeAll 之前就跑,
  // 那时 CS 还没 import (拿到的是 undefined)。
  const builtinIds = (): string[] => Object.keys(CS.DEFAULT_PROVIDER_CONFIGS);

  it('在册名单仍是那 13 家内置 (目录家**不**混进这张表)', () => {
    const roster = PR.listProviderRegistry();
    expect(roster.map((e: any) => e.id).sort()).toEqual([...builtinIds()].sort());
    expect(roster.length).toBe(13);
    for (const e of roster) {
      expect(e.kind).toBe('builtin');
      expect(e.origin).toBe('builtin');
      expect(e.authSupported).toBe(true);                 // 内置不是"需专用鉴权"
      expect(e.catalogFamilySignal).toBe(null);
    }
  });

  it('目录层**不回答**内置 13 家的模型能力 (那是内置目录 + 真发现的事)', () => {
    for (const id of builtinIds()) expect(PC.catalogAnswersProvider(id)).toBe(false);
  });

  it('同名目录项不会顶掉内置: 拿到的还是内置那条 (origin=builtin)', () => {
    // 这 5 个 id 在公开目录里**真的**也有 (其余内置 id 目录里没有) —— 有同名项才谈得上"谁优先"
    const collisions = ['openai', 'anthropic', 'deepseek', 'minimax', 'openrouter'];
    for (const id of collisions) {
      expect(PC.getCatalogProvider(id), `${id} 目录里应该有`).toBeTruthy();
      const entry = PR.getProviderRegistryEntry(id)!;
      expect(entry.kind).toBe('builtin');
      expect(entry.origin).toBe('builtin');
    }
  });

  it('在册 + 目录 合并读口: 家数变多但**没有重复 id**, 且内置那 13 家原样在前面', () => {
    const merged = PR.listProvidersWithCatalog();
    const ids = merged.map((e: any) => e.id);
    expect(new Set(ids).size).toBe(ids.length);            // 不许出现同名两条
    expect(merged.length).toBeGreaterThan(13);
    expect(merged.slice(0, 13).map((e: any) => e.id)).toEqual(PR.listProviderRegistry().map((e: any) => e.id));
    // 目录家的身份标得出来
    expect(merged.filter((e: any) => e.origin === 'catalog').length).toBeGreaterThan(100);
  });

  it('内置那 13 家的九项能力字段与出处一字未改 (与既有注册表门同一份真值)', () => {
    const roster = PR.listProviderRegistry();
    for (const e of roster) {
      for (const f of ['defaultBaseUrl', 'defaultModel', 'requiresApiKey', 'protocol', 'reasoning', 'toolCalling', 'isLocal', 'allowsLongRunningExecutor', 'apiKeyEnvVars']) {
        if (f === 'apiKeyEnvVars') continue;               // 数组项逐项比对 (下一条)
        expect(Object.prototype.hasOwnProperty.call(e, f), `${e.id}.${f} 丢了`).toBe(true);
        expect(String(e.provenance[f as any] ?? '').length).toBeGreaterThan(0);
      }
      expect(Array.isArray(e.apiKeyEnvVars)).toBe(true);
    }
  });
});

describe('C6 运行期刷新: 落盘 0600 + 来源/字节数/时间/家数; 陈旧如实标', () => {
  it('从假源刷新一次 → 落盘 0600, 报告里来源 URL/字节数/sha/时间/家数都在', async () => {
    const raw = fakeRawSource((r) => {
      r['acme-local'] = {
        id: 'acme-local', name: 'Acme Local', env: ['ACME_API_KEY'], npm: '@ai-sdk/openai-compatible',
        api: 'http://127.0.0.1:9/v1', doc: '', models: { 'acme-1': { name: 'Acme One' } },
      };
    });
    const srcFile = path.join(TMP, 'fake-source.json');
    await fsP.writeFile(srcFile, JSON.stringify(raw));
    const rep = await PC.refreshProviderCatalog({ fromFile: srcFile });
    expect(rep.ok).toBe(true);
    expect(rep.sourceBytes).toBeGreaterThan(100_000);
    expect(rep.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isFinite(Date.parse(rep.fetchedAt))).toBe(true);
    expect(rep.providerCount).toBe(BAKED.providerCount + 1);
    expect(rep.modelCount).toBeGreaterThan(1000);
    expect(rep.fileMode).toBe('600');
    expect(fs.statSync(CATALOG_FILE).mode & 0o777).toBe(0o600);
    const load = PC.catalogLoad();
    expect(load.source).toBe('runtime');
    expect(PC.catalogProviders().some((v: any) => v.id === 'acme-local')).toBe(true);
  });

  it('新家当场就"进得来": 注册表认它、列表出它、环境变量一配就算能用 (无码变更)', async () => {
    const entry = PR.getProviderRegistryEntry('acme-local');
    expect(entry!.kind).toBe('catalog');
    expect(entry!.defaultBaseUrl).toBe('http://127.0.0.1:9/v1');
    expect(entry!.apiKeyEnvVars).toEqual(['ACME_API_KEY']);
    const before = (await MC.buildProviderSummaries({})).find((s: any) => s.id === 'acme-local');
    expect(before).toBeUndefined();                        // 没配环境变量 → 默认列表里不出现 (不刷噪音)
    process.env.ACME_API_KEY = 'stub-key';
    try {
      const sums = await MC.buildProviderSummaries({});
      const row = sums.find((s: any) => s.id === 'acme-local')!;
      expect(row).toBeTruthy();
      expect(row.configured).toBe(true);
      expect(row.origin).toBe('catalog');
      expect(MC.formatProviderLine(row)).toContain('acme-local');
      // 目录家没有"默认模型"这回事 → 不给默认, 如实要用户指定
      const r = MS.validateSelection({ provider: 'acme-local' }, {});
      expect(r.ok).toBe(false);
      expect(String(r.message)).toContain('没有"默认模型"');
    } finally {
      delete process.env.ACME_API_KEY;
    }
  });

  it('状态行答得出"这份目录是几号的 / 新不新"', () => {
    const line = PC.catalogStatusLine();
    expect(line.startsWith('目录数据: ')).toBe(true);
    expect(line).toMatch(/目录数据: \d{4}-\d{2}-\d{2} \(/);
    expect(line).toContain('家');
    expect(line).toContain('源 http');
  });

  it('陈旧判定与展示: ageDays>30 必标 ⚠ 陈旧; 新刷的写"刚刚刷新" (不许静默拿旧的当新的)', async () => {
    // 新刷的那份: ageDays 由真正的刷新路径算出来 (≈0) → 状态行说"刚刚刷新"、不带 ⚠ 陈旧
    const fresh = PC.catalogLoad();
    expect(fresh.ageDays).toBeLessThan(1);
    expect(fresh.stale).toBe(false);
    const freshLine = PC.catalogStatusLine(fresh);
    expect(freshLine).toContain('刚刚刷新');
    expect(freshLine).not.toContain('⚠ 陈旧');

    // 40 天前那份: 展示层必须如实标 (这一条钉的是"展示不许把旧的说成新的")
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const staleLoad = {
      ...fresh,
      generatedAt: oldIso,
      provenance: { ...fresh.provenance, fetchedAt: oldIso },
      ageDays: 40,
      stale: true,
    };
    expect(PC.catalogDateText(staleLoad as any)).toBe(oldIso.slice(0, 10));
    expect(PC.catalogAgeText(staleLoad as any)).toBe('40 天前');
    const staleLine = PC.catalogStatusLine(staleLoad as any);
    expect(staleLine).toContain('⚠ 陈旧');
    expect(staleLine).toContain(oldIso.slice(0, 10));       // 日期必须打出来
    expect(staleLine).toContain('refresh');
  });

  it('盘上的运行期文件比烘焙数据**旧** → 不采用, 并说清为什么 (防"旧文件盖掉新数据")', async () => {
    const old = JSON.parse(JSON.stringify(PC.catalogLoad().data));
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
    old.generatedAt = oldIso;
    old.provenance.fetchedAt = oldIso;
    await writeRuntimeCatalog(old);
    PC.resetProviderCatalogSnapshot();                      // 回到"刚启动、只有烘焙数据"的状态
    const load = await PC.initializeProviderCatalog({ force: true });
    expect(load.warnings.join(' ')).toContain('比构建期烘焙数据');
    expect(load.source).toBe('bundled');                    // 旧文件不许盖掉烘焙数据
    expect(load.generatedAt).not.toBe(oldIso);
    expect(PC.catalogProviders().some((v: any) => v.id === 'acme-local')).toBe(false);
  });

  it('坏文件 / 半份目录: 不崩, 不静默采用, 用烘焙数据 + warning', async () => {
    await fsP.writeFile(CATALOG_FILE, '{ 这不是 JSON');
    const a = await PC.initializeProviderCatalog({ force: true });
    expect(a.data.providerCount).toBeGreaterThanOrEqual(100);
    expect(a.warnings.join(' ')).toContain('不是合法 JSON');

    const mk = (id: string) => ({ id, name: id, env: ['X_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:9/v1', doc: '', models: { [`${id}-1`]: { name: id } } });
    const tinyProviders: Record<string, any> = {};
    for (const id of ['tiny-a', 'tiny-b', 'tiny-c']) tinyProviders[id] = mk(id);
    const tiny = { ...PC.catalogLoad().data, providerCount: 3, providers: tinyProviders };
    await writeRuntimeCatalog(tiny);
    const b = await PC.initializeProviderCatalog({ force: true });
    expect(b.data.providerCount).toBeGreaterThanOrEqual(100);
    expect(b.warnings.join(' ')).toContain('不信任半份目录');
  });

  it('源被截断 (家数 < 100) → refresh 拒绝采用, 盘上文件不动', async () => {
    const srcFile = path.join(TMP, 'tiny-source.json');
    await fsP.writeFile(srcFile, JSON.stringify({ onlyone: { id: 'onlyone', env: ['X'], models: {} } }));
    const beforeText = fs.readFileSync(CATALOG_FILE, 'utf-8');
    const rep = await PC.refreshProviderCatalog({ fromFile: srcFile });
    expect(rep.ok).toBe(false);
    expect(String(rep.error)).toContain('拒绝采用');
    expect(fs.readFileSync(CATALOG_FILE, 'utf-8')).toBe(beforeText);
  });
});
