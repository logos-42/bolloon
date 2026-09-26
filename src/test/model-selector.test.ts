/**
 * model-selector.test.ts — 分步选择器 + 模型元数据 + 三条遗留处理 的单测 (2026-09-26)
 *
 * 覆盖四组判据:
 *   ① 元数据诚实性: 有真来源的给真值, 没有来源的必须是 `unknown`/`null`, 且渲染层不产生能力值;
 *   ② 分步选择器: 七步流程的行为 (取消不留痕 / 缺凭证拒绝 / 会话级带凭证被拒 / 落盘真发生);
 *   ③ **唯一写盘路径的源码级门**: 选择器与命令面不许出现写配置或重建运行时的第二条路;
 *   ④ 上轮三条遗留: 锁内 `invalidate()` 的承重性 (mtime+size 撞车) 与 `configHash` 反向核对。
 *
 * 隔离: 全程临时 HOME; 需要 `BOLLOON_HOME` 在 import 前设好, 所以用动态 import。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const TMP = path.join(os.tmpdir(), 'bolloon-model-selector-' + Date.now());
const CFG = path.join(TMP, 'bolloon-config.json');
const ROOT = process.cwd();

let MS: typeof import('../llm/model-selection.js');
let MC: typeof import('../llm/model-catalog.js');
let SEL: typeof import('../cli/model-selector.js');
let SW: typeof import('../cli/setup-wizard.js');
let RS: typeof import('../agents/run-store.js');

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  delete process.env.BOLLOON_MODEL_SKIP_PROBE;
  await fs.mkdir(TMP, { recursive: true });
  MS = await import('../llm/model-selection.js');
  MC = await import('../llm/model-catalog.js');
  SEL = await import('../cli/model-selector.js');
  SW = await import('../cli/setup-wizard.js');
  RS = await import('../agents/run-store.js');
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** 写一份全局配置 (统一入口之外唯一允许写配置的地方: 测试夹具) */
async function seedConfig(cfg: any): Promise<void> {
  await fs.writeFile(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  const store: any = (await import('../llm/config-store.js')).llmConfigStore;
  store.invalidate();
}

function baseConfig(activeProvider = 'deepseek'): any {
  return {
    activeProvider,
    providers: {
      deepseek: { enabled: true, apiKey: 'k-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', requiresApiKey: false },
      kimi: { enabled: true, apiKey: 'k-kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', requiresApiKey: false },
      glm: { enabled: true, apiKey: 'k-glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', requiresApiKey: false },
      openai: { enabled: true, apiKey: 'k-oa', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', requiresApiKey: false },
      ollama: { enabled: true, apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama4', requiresApiKey: false },
      local: { enabled: true, apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama4', requiresApiKey: false },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// ============================================================
// ① 元数据诚实性
// ============================================================

describe('模型元数据: 有来源给真值, 没来源必须"未知"', () => {
  beforeEach(() => { MC.resetModelMetadataSources(); });

  it('三态与人话: unknown 就是"未知", 不许写成"不支持"', () => {
    expect(MC.capabilityZh('unknown')).toBe('未知');
    expect(MC.capabilityZh('yes')).toBe('支持');
    expect(MC.capabilityZh('no')).toBe('不支持');
    expect(MC.contextZh(null)).toBe('未知');
    expect(MC.contextZh(128000)).toBe('128K');
    expect(MC.contextZh(1_000_000)).toBe('1M');
  });

  it('内置目录只有模型 ID → 三个能力字段全是未知, 且带上"为什么不知道"', async () => {
    await seedConfig(baseConfig());
    const entries = await MC.listModelsFor('deepseek');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.toolCalling).toBe('unknown');
      expect(e.reasoning).toBe('unknown');
      expect(e.contextLength).toBeNull();
      expect(e.unknowns.map((u) => u.field).sort()).toEqual(['contextLength', 'reasoning', 'toolCalling']);
      expect(e.unknowns[0].reason).toBe(MC.CURATED_ONLY_REASON);
    }
  });

  it('模型条目行里显示"未知", 不出现编造的支持/不支持', async () => {
    await seedConfig(baseConfig());
    const entries = await MC.listModelsFor('deepseek');
    const line = MC.formatModelLine(entries[0]);
    expect(line).toContain('工具调用=未知');
    expect(line).toContain('reasoning=未知');
    expect(line).toContain('上下文=未知');
    expect(line).not.toContain('工具调用=支持');
    expect(line).not.toContain('工具调用=不支持');
    expect(line).toContain(entries[0].id);                 // provider 原始 model ID 逐字出现
  });

  it('provider 原始 model ID 逐字保留 (不改大小写/不加前缀)', async () => {
    await seedConfig(baseConfig());
    const entries = await MC.listModelsFor('glm');
    expect(entries.map((e) => e.id)).toContain('glm-5.2');
    expect(entries.map((e) => e.id)).toContain('glm-4-flash');
    expect(entries.every((e) => e.id === e.displayName)).toBe(true);   // 没有单独来源就不编展示名
  });

  it('填充点优先级 = 注册顺序, 且同一 id 原地替换不改变优先级', async () => {
    await seedConfig(baseConfig());
    // 两个填充点都想回答同一个字段 → 先注册的赢
    MC.registerModelMetadataSource({ id: 'first', providers: ['kimi'], metadataOf: () => ({ toolCalling: 'yes' }) });
    MC.registerModelMetadataSource({ id: 'second', providers: ['kimi'], metadataOf: () => ({ toolCalling: 'no' }) });
    expect((await MC.listModelsFor('kimi'))[0].toolCalling).toBe('yes');
    // 原地替换 first → 它**仍在**第二位 second 之前
    MC.registerModelMetadataSource({ id: 'first', providers: ['kimi'], metadataOf: () => ({ toolCalling: 'unknown' }) });
    expect(MC.listModelMetadataSources()).toEqual(['first', 'second']);
    // 注意: 'unknown' 是**合法取值** (填充点明说"我不知道") → 它会盖住 second 的 'no'
    expect((await MC.listModelsFor('kimi'))[0].toolCalling).toBe('unknown');
    MC.resetModelMetadataSources();
  });

  it('注册了真填充点 → 真字段变成真值; 填不到的字段仍然是未知 (不许顺手补默认)', async () => {
    await seedConfig(baseConfig());
    MC.registerModelMetadataSource({
      id: 'unit-test-registry',
      providers: ['deepseek'],
      metadataOf: ({ model }) => (model === 'deepseek-v4-flash'
        ? { toolCalling: 'yes', reasoning: 'yes', contextLength: 128000, origin: 'live' }
        : { toolCalling: 'no' }),   // 只回答一项: 另外两项必须保持未知
    });
    const entries = await MC.listModelsFor('deepseek');
    const flash = entries.find((e) => e.id === 'deepseek-v4-flash')!;
    expect(flash.toolCalling).toBe('yes');
    expect(flash.reasoning).toBe('yes');
    expect(flash.contextLength).toBe(128000);
    expect(flash.origin).toBe('live');
    expect(flash.unknowns).toEqual([]);
    const other = entries.find((e) => e.id !== 'deepseek-v4-flash')!;
    expect(other.toolCalling).toBe('no');
    expect(other.reasoning).toBe('unknown');       // 填充点没说 → 未知, 不继承别的条目
    expect(other.contextLength).toBeNull();
    expect(MC.listModelMetadataSources()).toContain('unit-test-registry');
    MC.resetModelMetadataSources();
    expect(MC.listModelMetadataSources()).toEqual([]);
  });

  it('填充点返回 undefined / 抛错 → 保持未知 (不把异常变成"不支持")', async () => {
    await seedConfig(baseConfig());
    MC.registerModelMetadataSource({ id: 's1', metadataOf: () => undefined });
    MC.registerModelMetadataSource({ id: 's2', metadataOf: () => { throw new Error('boom'); } });
    const entries = await MC.listModelsFor('kimi');
    expect(entries.every((e) => e.toolCalling === 'unknown' && e.reasoning === 'unknown')).toBe(true);
    expect(entries.every((e) => e.unknowns.length === 3)).toBe(true);
    MC.resetModelMetadataSources();
  });

  it('需要 key / 是否本地是**真判定**(不走填充点)', async () => {
    expect(MC.isLocalBaseUrl('http://localhost:11434')).toBe(true);
    expect(MC.isLocalBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(MC.isLocalBaseUrl('https://api.deepseek.com/v1')).toBe(false);
    expect(MC.isLocalBaseUrl('not-a-url')).toBe(false);

    await seedConfig(baseConfig());
    const summaries = await MC.buildProviderSummaries({});
    const ollama = summaries.find((s) => s.id === 'ollama')!;
    expect(ollama.isLocal).toBe(true);
    expect(ollama.modelCountOrigin).toBe('unavailable');     // 无内置目录 ≠ 0 个模型
    expect(MC.formatProviderLine(ollama)).toContain('本地');
    expect(MC.formatProviderLine(ollama)).toContain('无内置目录');
    const ds = summaries.find((s) => s.id === 'deepseek')!;
    expect(ds.isLocal).toBe(false);
    expect(ds.configured).toBe(true);
    expect(ds.keyState).toBe('configured');
  });

  it('供应商行形状: ● 可用 · N models / ○ 未配置 key / ● 本地', async () => {
    const cfg = baseConfig();
    delete cfg.providers.glm;                 // 让 glm 走内置默认 (无 key)
    await seedConfig(cfg);
    const summaries = await MC.buildProviderSummaries({});
    const line = (id: string) => MC.formatProviderLine(summaries.find((s) => s.id === id)!);
    expect(line('deepseek')).toMatch(/^● deepseek · \d+ models/);
    expect(line('glm')).toMatch(/^○ glm · \d+ models · 未配置 key \(/);
    expect(line('ollama')).toMatch(/^● ollama · 本地 · 无内置目录/);
  });

  it('"这家要不要 key"以**注册表**为准; 与配置不一致时如实标出 (不许挑一个装作不知道)', async () => {
    const cfg = baseConfig();
    // 真实内置默认就是这副样子: DEFAULT_PROVIDER_CONFIGS.ollama.requiresApiKey=true,
    // 而 PROVIDER_INFO.ollama.requiresApiKey=false —— 两处说法冲突
    cfg.providers.ollama.requiresApiKey = true;
    cfg.providers.ollama.apiKey = '';
    await seedConfig(cfg);
    const summaries = await MC.buildProviderSummaries({});
    const ollama = summaries.find((s) => s.id === 'ollama')!;
    expect(ollama.requiresApiKey).toBe(false);          // 注册表
    expect(ollama.configRequiresKey).toBe(true);        // 配置
    expect(ollama.requiresKeyConflict).toBe(true);
    expect(ollama.configured).toBe(true);               // 本地且注册表说免 key → ● 可用
    const l = MC.formatProviderLine(ollama);
    expect(l).toContain('⚠ key 要求不一致');
    expect(l.startsWith('● ollama')).toBe(true);

    // 切换路径把配置里那格写成 false (= 别再问我了) 之后, 注册表说法**不变**
    cfg.providers.openai.requiresApiKey = false;
    cfg.providers.openai.apiKey = 'k-openai';
    await seedConfig(cfg);
    const s2 = await MC.buildProviderSummaries({});
    const openai = s2.find((s) => s.id === 'openai')!;
    expect(openai.requiresApiKey).toBe(true);
    expect(openai.configRequiresKey).toBe(false);
    expect(openai.requiresKeyConflict).toBe(true);
    expect(openai.credentialReady ?? openai.keyState).toBeDefined();
    expect(openai.keyState).toBe('configured');
    const e = (await MC.listModelsFor('openai'))[0];
    expect(e.requiresApiKey).toBe(true);       // 这家要 key (注册表)
    expect(e.credentialReady).toBe(true);      // 而且现在手上真有
    expect(MC.formatModelLine(e)).toContain('key 已配');
    const noKey = (await MC.listModelsFor('anthropic'))[0];
    expect(MC.formatModelLine(noKey)).toContain('缺 key');
  });

  it('当前生效的模型置顶; 配置里的自定义 model 也在清单里 (不在内置目录也要看得到)', async () => {
    const cfg = baseConfig();
    cfg.providers.deepseek.model = 'my-own-tuned-model';
    await seedConfig(cfg);
    const entries = await MC.listModelsFor('deepseek');
    expect(entries[0].id).toBe('my-own-tuned-model');
    expect(entries[0].current).toBe(true);
    expect(MC.formatModelLine(entries[0]).startsWith('▸')).toBe(true);
    expect(entries.filter((e) => e.current).length).toBe(1);
  });

  it('模糊搜索: 子序列命中 + 不匹配返回空 + 空查询原样返回', async () => {
    await seedConfig(baseConfig());
    const entries = await MC.listModelsFor('deepseek');
    expect(MC.searchModelEntries(entries, 'dsv4').map((e) => e.id)).toContain('deepseek-v4-flash');
    expect(MC.searchModelEntries(entries, 'v4-pro').map((e) => e.id)).toEqual(['deepseek-v4-pro']);
    expect(MC.searchModelEntries(entries, 'zzz-nope')).toEqual([]);
    expect(MC.searchModelEntries(entries, '')).toBe(entries);
    expect(MC.fuzzyScore('deepseek-v4-flash', 'deepseek')).toBeGreaterThan(0);
    expect(MC.fuzzyScore('deepseek-v4-flash', 'flash')).toBeLessThan(MC.fuzzyScore('deepseek-v4-flash', 'deepseek'));
    expect(MC.fuzzyScore('abc', 'xyz')).toBeNull();
  });
});

// ============================================================
// ② 分步选择器行为
// ============================================================

/** 脚本化 IO: 按顺序回答每一步的选择/输入; 用完了 (或喂 null) 就当成用户取消 */
function scriptedIO(
  answers: Array<string | null>,
  opts: { withKey?: boolean; withAsk?: boolean } = {},
) {
  const printed: string[] = [];
  const chosen: string[] = [];
  const asks: string[] = [];
  return {
    printed, chosen, asks,
    io: {
      print: (l: string) => { printed.push(l); },
      choose: async (items: any[], title: string) => {
        chosen.push(title);
        const a = answers.length ? answers.shift()! : null;
        if (a === null) return null;
        // 允许按 value 或 label 前缀回答; 不在候选里就把原样返回 (由流程自己判)
        const hit = items.find((c) => c.value === a) || items.find((c) => c.label.startsWith(a));
        return hit ? hit.value : a;
      },
      ...(opts.withKey ? { askHidden: async () => 'k-from-selector' } : {}),
      ...(opts.withAsk === false ? {} : {
        ask: async (q: string, o?: { default?: string }) => {
          asks.push(q);
          const a = answers.length ? answers.shift()! : null;
          return a === null ? '' : a;
        },
      }),
    },
  };
}

const ALL_OFF_VERIFY = { verify: false };   // 单测不真发请求 (真跑在 verify-model-selector.ts)

describe('分步选择器: 流程与"不留痕"', () => {
  it('七步走完会真落盘, 且是走统一入口落的', async () => {
    await seedConfig(baseConfig());
    const s = scriptedIO(['deepseek', 'deepseek-v4-pro', '不设', '0.3', 'global'], { withAsk: false });
    const r = await SEL.runModelSelector(s.io, { ...ALL_OFF_VERIFY, assumeYes: true });
    expect(r.ok).toBe(true);
    expect(r.reachedStep).toBe('done');
    // 步骤顺序真的走了: 供应商 → 模型 → 参数(reasoning/temperature) → 作用域 → 提交
    expect(s.chosen[0]).toBe('选择供应商');
    expect(s.chosen[1]).toBe('选择模型');
    expect(s.chosen[2]).toContain('reasoning');
    expect(s.chosen[3]).toBe('temperature (0~2)');
    expect(s.chosen[4]).toBe('这次切换的作用域?');
    // 落盘: 盘上真变了, 且 temperature 也写进去了
    const onDisk = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(onDisk.providers.deepseek.model).toBe('deepseek-v4-pro');
    expect(onDisk.providers.deepseek.temperature).toBe(0.3);
    expect(onDisk.activeProvider).toBe('deepseek');
    expect(r.effective!.model).toBe('deepseek-v4-pro');
    expect(r.effective!.temperature).toBe(0.3);
    // 打印里有"交给统一入口"这句话 (说明它不是自己写的)
    expect(s.printed.join('\n')).toContain('selectModel()');
  });

  it('模糊搜索: 先按关键词收窄再选 (只列出命中项)', async () => {
    await seedConfig(baseConfig());
    // glm: 先喂搜索词 'flash' → 只剩 glm-4-flash
    const s = scriptedIO(['glm', 'flash', 'glm-4-flash', '不设', '0.7', 'global']);
    const r = await SEL.runModelSelector(s.io, { ...ALL_OFF_VERIFY, assumeYes: true });
    expect(r.ok).toBe(true);
    expect(s.asks.join('|')).toContain('搜索模型');
    expect(s.printed.join('\n')).toContain("搜索 'flash'");
    expect((await MS.effectiveModelConfig({})).model).toBe('glm-4-flash');
  });

  it('搜不到 → 允许手工输入原始 model ID, 但仍要走完参数/作用域/提交', async () => {
    await seedConfig(baseConfig());
    const s = scriptedIO(['glm', 'zzz-nothing', 'my-own-model-1', '不设', '0.7', 'global']);
    const r = await SEL.runModelSelector(s.io, { ...ALL_OFF_VERIFY, assumeYes: true });
    expect(r.ok).toBe(true);
    expect(s.printed.join('\n')).toContain('使用手工输入的 model ID: my-own-model-1');
    const onDisk = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(onDisk.providers.glm.model).toBe('my-own-model-1');
    expect(onDisk.providers.glm.temperature).toBe(0.7);      // 手工 ID 也必须走完后续步骤
  });

  it('取消 (Esc/选择器返回 null) → 配置字节一模一样', async () => {
    await seedConfig(baseConfig());
    const before = await fs.readFile(CFG, 'utf-8');
    const s = scriptedIO([null], { withAsk: false });
    const r = await SEL.runModelSelector(s.io, ALL_OFF_VERIFY);
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.reachedStep).toBe('provider');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
  });

  it('走到一半取消 (选完供应商再退) → 也不留痕', async () => {
    await seedConfig(baseConfig());
    const before = await fs.readFile(CFG, 'utf-8');
    const s = scriptedIO(['deepseek', null], { withAsk: false });
    const r = await SEL.runModelSelector(s.io, ALL_OFF_VERIFY);
    expect(r.cancelled).toBe(true);
    expect(r.reachedStep).toBe('model');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
  });

  it('缺凭证且环境收不了 key → 拒绝并指向系统终端, 不写任何东西', async () => {
    const cfg = baseConfig();
    delete cfg.providers.glm;
    await seedConfig(cfg);
    const before = await fs.readFile(CFG, 'utf-8');
    const s = scriptedIO(['glm', 'glm-5.2'], { withAsk: false });
    const r = await SEL.runModelSelector(s.io, ALL_OFF_VERIFY);
    expect(r.ok).toBe(false);
    expect(r.reachedStep).toBe('key');
    expect(r.failureClass).toBe('missing_api_key');
    expect(r.message).toContain('bolloon model key glm');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
  });

  it('会话级 + 带新 key → credential_scope_conflict, 且配置字节不变', async () => {
    const cfg = baseConfig();
    cfg.providers.glm = { enabled: true, apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', requiresApiKey: true };
    await seedConfig(cfg);
    const before = await fs.readFile(CFG, 'utf-8');
    // 供应商 → (要 key, 隐藏输入) → 模型 → 参数 → 作用域(两次都选 session)
    const s = scriptedIO(['glm', 'glm-5.2', '不设', '0.7', 'session', 'session'], { withKey: true, withAsk: false });
    const r = await SEL.runModelSelector(s.io, ALL_OFF_VERIFY);
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('credential_scope_conflict');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
    expect(s.printed.join('\n')).not.toContain('k-from-selector');   // key 明文字面不进任何输出
    expect(s.printed.join('\n')).toContain('****ctor');              // 只回显尾 4 位
  });

  it('会话级 (不带 key) → 只写会话绑定, 全局配置文件字节不变', async () => {
    await seedConfig(baseConfig());
    process.env.BOLLOON_SESSION_KEY = 'sel-sess-1';
    const before = await fs.readFile(CFG, 'utf-8');
    const s = scriptedIO(['deepseek', 'deepseek-v4-pro', '不设', '0.7', 'session'], { withAsk: false });
    const r = await SEL.runModelSelector(s.io, { ...ALL_OFF_VERIFY, assumeYes: true });
    expect(r.ok).toBe(true);
    expect(r.effective!.source).toBe('session');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
    const bind = JSON.parse(await fs.readFile(path.join(TMP, 'model-sessions.json'), 'utf-8'));
    expect(bind.sessions['sel-sess-1'].model).toBe('deepseek-v4-pro');
    expect(JSON.stringify(bind)).not.toContain('k-ds');
    delete process.env.BOLLOON_SESSION_KEY;
  });

  it('temperature 越界 → 当场拒 (不夹到边界, 不静默), 配置字节不变', async () => {
    await seedConfig(baseConfig());
    const before = await fs.readFile(CFG, 'utf-8');
    // 供应商 → 模型 → reasoning → temperature(选"手工输入") → 喂 7
    const s = scriptedIO(['deepseek', 'deepseek-v4-pro', '不设', '__custom__', '7']);
    const r = await SEL.runModelSelector(s.io, ALL_OFF_VERIFY);
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('invalid_temperature');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
  });

  it('只有 choose 没有文本输入时 (会话内) 也能走完', async () => {
    await seedConfig(baseConfig());
    const printed: string[] = [];
    const answers: Array<string | null> = ['deepseek', 'deepseek-v4-pro', '不设', '0.7', 'global'];
    const r = await SEL.runModelSelector({
      print: (l) => printed.push(l),
      choose: async (items: any[]) => {
        const a = answers.shift() ?? null;
        if (a === null) return null;
        const hit = items.find((c) => c.value === a) || items.find((c) => c.label.startsWith(a));
        return hit ? hit.value : a;
      },
    }, { ...ALL_OFF_VERIFY, assumeYes: true });
    expect(r.ok).toBe(true);
    expect((await MS.effectiveModelConfig({})).model).toBe('deepseek-v4-pro');
  });
});

// ============================================================
// ③ 唯一写盘路径的源码级门
// ============================================================

describe('唯一写盘路径 (源码级门: 选择器里不许出现第二条路)', () => {
  const read = async (p: string) => fs.readFile(path.join(ROOT, p), 'utf-8');
  /** 只看代码, 不看注释 —— 否则"说明为什么要判红"的那段注释会被自己的门抓到 */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('model-selector.ts 只调 selectModel, 不写配置/不重建运行时', async () => {
    const src = stripComments(await read('src/cli/model-selector.ts'));
    expect(src).toContain('selectModel(');
    for (const bad of ['updateProvider(', 'setActiveProvider(', 'initMinimax(']) {
      expect(src, `model-selector.ts 不该出现 ${bad}`).not.toContain(bad);
    }
    // 不直接写文件 (读写配置文件的活归 config-store)
    expect(src).not.toMatch(/fs\.writeFile|writeFileSync|fsp\.writeFile/);
  });

  it('setup-wizard 的 runModelCommand 段: 写配置与重建运行时都不在它手里', async () => {
    const src = await read('src/cli/setup-wizard.ts');
    const start = src.indexOf('export async function runModelCommand');
    expect(start).toBeGreaterThan(0);
    const body = stripComments(src.slice(start));
    expect(body).toContain('selectModel(');
    expect(body).toContain('runModelPicker(');
    for (const bad of ['updateProvider(', 'setActiveProvider(', 'initMinimax(']) {
      expect(body, `runModelCommand 不该出现 ${bad}`).not.toContain(bad);
    }
  });

  it('会话内的 /model 段: 自己不切模型, 交给统一命令面', async () => {
    const src = await read('src/index.ts');
    const start = src.indexOf('// /model —');
    const end = src.indexOf('// /questions —');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('runModelCommand(');
    expect(block).toContain('__inkOpenPicker');
    for (const bad of ['updateProvider(', 'setActiveProvider(', 'initMinimax(']) {
      expect(block, `/model 段不该出现 ${bad}`).not.toContain(bad);
    }
  });
});

// ============================================================
// ④ 遗留① 锁内 invalidate() 的承重性
// ============================================================

describe('遗留①: 锁内 invalidate() 承重 —— mtime+size 撞车时必须重读', () => {
  /**
   * 这道门构造的是 `initialize()` 的文件签名检查**唯一失效**的场景:
   * 另一个进程改了配置文件, 但字节数一样、mtime 被拨回同一个整毫秒 → `${mtimeMs}:${size}` 不变。
   * 此时不显式作废缓存就会拿陈旧快照覆盖别人的改动; `invalidate()` 就是为这个场景存在的。
   */
  it('外部改动撞上同样的 mtime+size → 仍然要重读 (否则改动被陈旧快照吃掉)', async () => {
    const v1 = baseConfig('deepseek');
    v1.providers.glm.model = 'glm-orig-1';
    const v2 = baseConfig('deepseek');
    v2.providers.glm.model = 'glm-mark-1';           // 同样 10 个字符
    const A = JSON.stringify(v1, null, 2);
    const B = JSON.stringify(v2, null, 2);
    expect(Buffer.byteLength(A)).toBe(Buffer.byteLength(B));

    // 写 v1 并把 mtime 定成一个整毫秒 (下面 v2 会拨回同一个值)
    await fs.writeFile(CFG, A, { mode: 0o600 });
    const T = Math.trunc(Date.now() / 1000) * 1000;
    await fs.utimes(CFG, T / 1000, T / 1000);

    const store: any = (await import('../llm/config-store.js')).llmConfigStore;
    store.invalidate();
    await store.initialize();                         // 缓存灌满 (记下签名)
    expect((await store.getConfig()).providers.glm.model).toBe('glm-orig-1');

    // 另一个进程改盘: 同字节数 + mtime 拨回同一整毫秒 → 签名不变
    await fs.writeFile(CFG, B, { mode: 0o600 });
    await fs.utimes(CFG, T / 1000, T / 1000);
    const onDiskNow = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(onDiskNow.providers.glm.model).toBe('glm-mark-1');

    // 签名检查这时**看不见**这次改动 —— 缓存在 `invalidate()` 之前是陈旧的
    await store.initialize();
    expect((await store.getConfig()).providers.glm.model).toBe('glm-orig-1');

    // 真正要判的: 统一入口写配置时会作废缓存, 于是另一个进程的改动活下来
    const r = await MS.selectModel({ provider: 'kimi', model: 'kimi-k3', scope: 'global', verify: false });
    expect(r.ok).toBe(true);
    const after = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(after.providers.glm.model, '另一个进程的改动被陈旧快照覆盖了').toBe('glm-mark-1');
    expect(after.providers.kimi.model).toBe('kimi-k3');
  });
});

// ============================================================
// ④ 遗留③ configHash 反向核对
// ============================================================

describe('遗留③: configHash 反查 (配置被外部改过要如实上报)', () => {
  it('一致 → verified=true 且明确说"一致"', async () => {
    await seedConfig(baseConfig());
    const snap = await MS.captureRunModelConfig();
    const rep = await MS.detectRunModelDrift(snap);
    expect(rep.verified).toBe(true);
    expect(rep.drifted).toBe(false);
    expect(rep.fields).toEqual([]);
    expect(rep.message).toContain('一致');
    expect(rep.message).toContain(snap.configHash);
  });

  it('外部改了配置 → drifted=true, 逐字段点名 (model + configHash)', async () => {
    await seedConfig(baseConfig());
    const snap = await MS.captureRunModelConfig();
    const cfg = baseConfig();
    cfg.providers.deepseek.model = 'changed-behind-your-back';
    await seedConfig(cfg);                            // 模拟"外部手改/别的进程切了默认"
    const rep = await MS.detectRunModelDrift(snap);
    expect(rep.verified).toBe(true);
    expect(rep.drifted).toBe(true);
    expect(rep.fields.map((f) => f.field)).toEqual(['model', 'configHash']);
    expect(rep.message).toContain('已偏离');
    expect(rep.message).toContain(snap.model);
    expect(rep.message).toContain('changed-behind-your-back');
  });

  it('纯函数: hash 相同但 provider 不同也要点名 (不只比 hash)', () => {
    const eff = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1' }, 'global');
    const snap = MS.runModelConfigOf(eff, 'T');
    const same = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1/' }, 'global');
    expect(MS.compareRunModelConfig(snap, same).drifted).toBe(false);       // 尾斜杠不算漂
    const other = MS.materialize({ provider: 'kimi', model: 'm', baseUrl: 'https://x/v1' }, 'global');
    const rep = MS.compareRunModelConfig(snap, other);
    expect(rep.drifted).toBe(true);
    expect(rep.verified).toBe(true);
    expect(rep.fields.map((f) => f.field)).toEqual(['provider', 'configHash']);
  });

  it('现状读不出来 → verified=false, 不假装"一致"', () => {
    const eff = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1' }, 'global');
    const rep = MS.compareRunModelConfig(MS.runModelConfigOf(eff, 'T'), null);
    expect(rep.verified).toBe(false);
    expect(rep.drifted).toBe(false);
    expect(rep.message).toContain('无法核对');
  });

  it('detectRunConfigDrift 从盘上 Run 读快照 (没快照 → null, 不编)', async () => {
    await seedConfig(baseConfig());
    const snap = await MS.captureRunModelConfig();
    const run = await RS.startRun({ surface: 'cli', goal: '反查用例', modelConfig: snap });
    const rep = await MS.detectRunConfigDrift(run.runId);
    expect(rep?.verified).toBe(true);
    expect(rep?.drifted).toBe(false);
    const noSnap = await RS.startRun({ surface: 'cli', goal: '没有快照' });
    expect(await MS.detectRunConfigDrift(noSnap.runId)).toBeNull();
    expect(await MS.detectRunConfigDrift('run-does-not-exist')).toBeNull();

    // 之后外部改了配置 → 同一个 Run 的快照开始报漂
    const cfg = baseConfig();
    cfg.providers.deepseek.model = 'again-changed';
    await seedConfig(cfg);
    const rep2 = await MS.detectRunConfigDrift(run.runId);
    expect(rep2?.drifted).toBe(true);
  });
});

// ============================================================
// 命令面接线 (pick 子命令 / 状态列表)
// ============================================================

describe('命令面: /model pick 与状态列表', () => {
  it('parseModelCommand 认得 pick (不把它当供应商名)', () => {
    expect(SW.parseModelCommand('pick').action).toBe('pick');
    expect(SW.parseModelCommand('wizard').action).toBe('pick');
    expect(SW.parseModelCommand('').action).toBe('status');
    expect(SW.parseModelCommand('status').action).toBe('status');
    expect(SW.parseModelCommand('deepseek').action).toBe('select');
  });

  it('没有交互能力时 pick 给的是可执行指引, 不是假装成功', async () => {
    await seedConfig(baseConfig());
    const out = await SW.runModelCommand('pick');
    expect(out).toContain('bolloon model pick');
    expect(out).not.toContain('✅');
  });

  it('状态列表用新行形状并说明当前生效的那一份', async () => {
    await seedConfig(baseConfig());
    const out = await SW.runModelCommand('status');
    expect(out).toContain('当前生效: deepseek/deepseek-v4-flash');
    expect(out).toMatch(/● deepseek · \d+ models/);
    expect(out).toContain('/model pick');
  });

  it('key 命令失败时不谎称"key 已保存" (失败=什么都没落盘)', async () => {
    const cfg = baseConfig();
    cfg.providers.glm = { enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', model: 'glm-5.2', requiresApiKey: true };
    await seedConfig(cfg);
    const before = await fs.readFile(CFG, 'utf-8');
    const out = await SW.runModelCommand('key glm bad-key-xyz');
    expect(out).toContain('没有配置成功');
    expect(out).toContain('都没有落盘');
    expect(out).not.toContain('已保存');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
  });
});
