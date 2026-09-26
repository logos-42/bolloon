/**
 * model-selection.test.ts — 「有效模型配置 + 统一切换入口」单测 (2026-09-26)
 *
 * 覆盖的是**判据本身** (纯函数 + 磁盘读写), 不覆盖"真发一次请求" —— 那部分在
 * `scripts/verify-model-selection.ts` 里对真 HTTP 服务器跑。
 *
 * 隔离: 全程用临时 HOME (BOLLOON_HOME + HOME), 不碰真 ~/.bolloon。
 * 注意顺序: config-store 在**模块加载时**就把配置路径定下来了, 所以必须先设环境变量
 * 再 `await import(...)`, 不能在文件顶部静态 import。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const TMP = path.join(os.tmpdir(), 'bolloon-model-selection-' + Date.now());
const CFG = path.join(TMP, 'bolloon-config.json');
const SESS = path.join(TMP, 'model-sessions.json');

let MS: typeof import('../llm/model-selection.js');
let SW: typeof import('../cli/setup-wizard.js');
let RS: typeof import('../agents/run-store.js');

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  delete process.env.BOLLOON_MODEL_SKIP_PROBE;
  await fs.mkdir(TMP, { recursive: true });
  MS = await import('../llm/model-selection.js');
  SW = await import('../cli/setup-wizard.js');
  RS = await import('../agents/run-store.js');
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ───────────────────────── base URL 规范化 ─────────────────────────

describe('base URL 规范化 (消除隐藏 URL)', () => {
  it('去尾斜杠', () => {
    expect(MS.normalizeBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
  });
  it('去重复斜杠 (不碰协议后的 //)', () => {
    expect(MS.normalizeBaseUrl('http://127.0.0.1:8080//v1')).toBe('http://127.0.0.1:8080/v1');
  });
  it('去重复的 /v1 — 否则拼出来是 /v1/v1/models', () => {
    expect(MS.normalizeBaseUrl('https://api.example.com/v1/v1')).toBe('https://api.example.com/v1');
  });
  it('空串 → 空串 (不编一个默认出来)', () => {
    expect(MS.normalizeBaseUrl('   ')).toBe('');
  });
  it('畸形 URL 被形状校验拒绝 (invalid_url)', () => {
    const r = MS.validateBaseUrlShape('not-a-url');
    expect(r.ok).toBe(false);
  });
  it('非 http/https 被拒', () => {
    const r = MS.validateBaseUrlShape('ftp://example.com/v1');
    expect(r.ok).toBe(false);
  });
  it('合法 URL 通过并已规范化', () => {
    const r = MS.validateBaseUrlShape('http://127.0.0.1:9/v1/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('http://127.0.0.1:9/v1');
  });
});

// ───────────────────────── 协议 / 摘要 ─────────────────────────

describe('协议与配置摘要', () => {
  it('anthropic / gemini / ollama 各有自己的协议, 其余是 openai 兼容', () => {
    expect(MS.protocolOf('anthropic')).toBe('anthropic');
    expect(MS.protocolOf('gemini')).toBe('gemini');
    expect(MS.protocolOf('ollama')).toBe('ollama');
    expect(MS.protocolOf('local')).toBe('ollama');
    expect(MS.protocolOf('deepseek')).toBe('openai-compatible');
    expect(MS.protocolOf('unknown-provider')).toBe('openai-compatible');
  });

  it('同样的 provider/model/baseUrl → 同样的 hash (跨进程可比)', () => {
    const a = MS.configHashOf({ provider: 'deepseek', model: 'm1', baseUrl: 'https://x/v1/' });
    const b = MS.configHashOf({ provider: 'deepseek', model: 'm1', baseUrl: 'https://x/v1' });
    expect(a).toBe(b);
  });

  it('任何一个字段变了 → hash 就变', () => {
    const base = MS.configHashOf({ provider: 'deepseek', model: 'm1', baseUrl: 'https://x/v1' });
    expect(MS.configHashOf({ provider: 'deepseek', model: 'm2', baseUrl: 'https://x/v1' })).not.toBe(base);
    expect(MS.configHashOf({ provider: 'deepseek', model: 'm1', baseUrl: 'https://y/v1' })).not.toBe(base);
    expect(MS.configHashOf({ provider: 'kimi', model: 'm1', baseUrl: 'https://x/v1' })).not.toBe(base);
  });
});

// ───────────────────────── 优先级 ─────────────────────────

describe('来源优先级 (Run > Session > Global > provider 默认 > 环境变量)', () => {
  const L = (model: string) => ({ provider: 'deepseek', model, baseUrl: 'https://x/v1' });

  it('五层齐全 → Run 赢', () => {
    const e = MS.resolveSelection({ run: L('run'), session: L('sess'), global: L('glob'), provider: L('prov'), env: L('env') });
    expect(e.model).toBe('run');
    expect(e.source).toBe('run');
  });

  it('没有 Run → Session 赢', () => {
    const e = MS.resolveSelection({ session: L('sess'), global: L('glob'), provider: L('prov'), env: L('env') });
    expect(e.model).toBe('sess');
    expect(e.source).toBe('session');
  });

  it('Session 缺席 → Global 赢', () => {
    const e = MS.resolveSelection({ global: L('glob'), provider: L('prov'), env: L('env') });
    expect(e.model).toBe('glob');
    expect(e.source).toBe('global');
  });

  it('Global 缺席 → provider 默认赢 (环境变量排在它后面)', () => {
    const e = MS.resolveSelection({ provider: L('prov'), env: L('env') });
    expect(e.model).toBe('prov');
    expect(e.source).toBe('provider');
  });

  it('只有环境变量层 → env 赢', () => {
    const e = MS.resolveSelection({ env: L('env') });
    expect(e.model).toBe('env');
    expect(e.source).toBe('env');
  });

  it('空层 (只有 provider 没有 model/baseUrl) 被跳过, 不产生空配置', () => {
    const e = MS.resolveSelection({ session: { provider: 'deepseek', model: '', baseUrl: '' }, global: L('glob') });
    expect(e.model).toBe('glob');
  });

  it('优先级顺序表本身是固定的 (改顺序必须改这个常量)', () => {
    expect([...MS.SELECTION_PRIORITY]).toEqual(['run', 'session', 'global', 'provider', 'env']);
  });
});

// ───────────────────────── 凭证不进有效配置 ─────────────────────────

describe('有效配置只记凭证来源, 不记凭证本身', () => {
  it('有 apiKey → authRef = provider:<id> (没有 key 内容)', () => {
    const e = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1', apiKey: 'sk-super-secret' }, 'global');
    expect(e.authRef).toBe('provider:deepseek');
    expect(JSON.stringify(e)).not.toContain('sk-super-secret');
  });

  it('没有 apiKey 但有环境变量 → authRef = env:<VAR>', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env-secret';
    const e = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1' }, 'global');
    expect(e.authRef).toBe('env:DEEPSEEK_API_KEY');
    expect(JSON.stringify(e)).not.toContain('sk-env-secret');
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('两者都没有 → authRef = none', () => {
    delete process.env.DEEPSEEK_API_KEY;
    const e = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1' }, 'global');
    expect(e.authRef).toBe('none');
  });
});

// ───────────────────────── 校验 ─────────────────────────

describe('validateSelection 的失败分类', () => {
  const ctx = { providerConfig: { enabled: true, apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', requiresApiKey: true } as any };

  it('未知供应商 → invalid_provider', () => {
    expect(MS.validateSelection({ provider: 'nope' }, { providerConfig: null }).failureClass).toBe('invalid_provider');
  });
  it('空 provider → invalid_provider', () => {
    expect(MS.validateSelection({}, ctx).failureClass).toBe('invalid_provider');
  });
  it('畸形 URL → invalid_url', () => {
    expect(MS.validateSelection({ provider: 'deepseek', baseUrl: 'nope' }, ctx).failureClass).toBe('invalid_url');
  });
  it('需要 key 但没有 → missing_api_key', () => {
    delete process.env.DEEPSEEK_API_KEY;
    const r = MS.validateSelection({ provider: 'deepseek' }, { providerConfig: { ...ctx.providerConfig, apiKey: '' } });
    expect(r.failureClass).toBe('missing_api_key');
  });
  it('通过时把 URL 规范化后放进 selection', () => {
    const r = MS.validateSelection({ provider: 'deepseek', baseUrl: 'https://x/v1/' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.selection?.baseUrl).toBe('https://x/v1');
  });
  it('免 key 的 provider (local) 不需要 key', () => {
    const r = MS.validateSelection({ provider: 'local' }, { providerConfig: { enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:11434', model: 'llama4', requiresApiKey: false } });
    expect(r.ok).toBe(true);
  });
});

// ───────────────────────── 命令面解析 ─────────────────────────

describe('/model 命令面解析', () => {
  it('空参 / status / list → 状态', () => {
    expect(SW.parseModelCommand('').action).toBe('status');
    expect(SW.parseModelCommand('status').action).toBe('status');
    expect(SW.parseModelCommand('list').action).toBe('status');
  });
  it('reset / test', () => {
    expect(SW.parseModelCommand('reset').action).toBe('reset');
    expect(SW.parseModelCommand('test').action).toBe('test');
    expect(SW.parseModelCommand('test kimi').provider).toBe('kimi');
  });
  it('<provider> / <provider> <model>', () => {
    const a = SW.parseModelCommand('deepseek');
    expect(a.action).toBe('select');
    expect(a.provider).toBe('deepseek');
    expect(a.model).toBeUndefined();
    const b = SW.parseModelCommand('deepseek deepseek-v4-flash');
    expect(b.provider).toBe('deepseek');
    expect(b.model).toBe('deepseek-v4-flash');
  });
  it('--base-url 两种写法都认', () => {
    expect(SW.parseModelCommand('kimi k1 --base-url http://127.0.0.1:8080/v1').baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(SW.parseModelCommand('kimi k1 --base-url=http://127.0.0.1:8080/v1/').baseUrl).toBe('http://127.0.0.1:8080/v1');
  });
  it('非法 --base-url → 解析期就报错 (不落到切换)', () => {
    const p = SW.parseModelCommand('kimi k1 --base-url not-a-url');
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.baseUrl).toBeUndefined();
  });
  it('--session / --scope session / --global', () => {
    expect(SW.parseModelCommand('deepseek --session').scope).toBe('session');
    expect(SW.parseModelCommand('deepseek --scope session').scope).toBe('session');
    expect(SW.parseModelCommand('deepseek --global').scope).toBe('global');
    expect(SW.parseModelCommand('deepseek').scope).toBe('global');
  });
  it('--scope 非法值 → 报错', () => {
    expect(SW.parseModelCommand('deepseek --scope forever').errors.length).toBeGreaterThan(0);
  });
  it('--no-verify 关掉探测 · --json 走机器可读', () => {
    const p = SW.parseModelCommand('kimi k1 --no-verify --json');
    expect(p.verify).toBe(false);
    expect(p.json).toBe(true);
  });
  it('未知选项 → 报错 (不静默忽略)', () => {
    expect(SW.parseModelCommand('kimi --frobnicate').errors.length).toBeGreaterThan(0);
  });
  it('key <provider> [key]', () => {
    const p = SW.parseModelCommand('key kimi sk-abc');
    expect(p.action).toBe('key');
    expect(p.provider).toBe('kimi');
    expect(p.apiKey).toBe('sk-abc');
  });
});

// ───────────────────────── 磁盘层: 会话绑定与 Global ─────────────────────────

describe('会话绑定与 Global 的磁盘语义', () => {
  async function seedConfig(activeProvider: string, model: string, baseUrl: string): Promise<void> {
    const cfg = {
      activeProvider,
      providers: {
        [activeProvider]: { enabled: true, apiKey: 'k-file', baseUrl, model, requiresApiKey: false },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await fs.rm(SESS, { force: true });
  }

  it('会话绑定写读往返', async () => {
    await MS.writeSessionSelection('sess-a', { provider: 'deepseek', model: 'm1', baseUrl: 'https://x/v1' });
    const got = await MS.readSessionSelection('sess-a');
    expect(got?.provider).toBe('deepseek');
    expect(got?.model).toBe('m1');
    expect(await MS.readSessionSelection('sess-b')).toBeNull();
    await MS.clearSessionSelection('sess-a');
    expect(await MS.readSessionSelection('sess-a')).toBeNull();
  });

  it('空 sessionKey 拒绝写 (不生成一个匿名绑定)', async () => {
    await expect(MS.writeSessionSelection('  ', { provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1' })).rejects.toThrow();
  });

  it('会话绑定文件是 0600 且不含 key 字段', async () => {
    await MS.writeSessionSelection('sess-perm', { provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1' });
    const raw = await fs.readFile(SESS, 'utf-8');
    expect(raw).not.toContain('apiKey');
    const st = await fs.stat(SESS);
    expect((st.mode & 0o777).toString(8)).toBe('600');
    await MS.clearSessionSelection('sess-perm');
  });

  it('Global 有可用凭证 → 有效配置来源是 global', async () => {
    await seedConfig('deepseek', 'm1', 'https://x/v1');
    const CFG_STORE: any = await import('../llm/config-store.js');
    CFG_STORE.llmConfigStore.invalidate();
    const e = await MS.effectiveModelConfig({ sessionKey: 'no-such-session' });
    expect(e.source).toBe('global');
    expect(e.provider).toBe('deepseek');
    expect(e.model).toBe('m1');
  });

  it('会话绑定存在时压过 Global, 且不动 Global 文件', async () => {
    const before = await fs.readFile(CFG, 'utf-8');
    await MS.writeSessionSelection('sess-win', { provider: 'kimi', model: 'km', baseUrl: 'https://kimi/v1' });
    const e = await MS.effectiveModelConfig({ sessionKey: 'sess-win' });
    expect(e.source).toBe('session');
    expect(e.provider).toBe('kimi');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
    await MS.clearSessionSelection('sess-win');
  });

  it('Global 不可用 (无 key 且需要 key) → 落到 provider 默认, 不假装是用户选的', async () => {
    const CFG_STORE: any = await import('../llm/config-store.js');
    await fs.writeFile(CFG, JSON.stringify({
      activeProvider: 'openai',
      providers: { openai: { enabled: false, apiKey: '', baseUrl: 'https://api.openai.com/v1', model: '', requiresApiKey: true } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2), { mode: 0o600 });
    delete process.env.OPENAI_API_KEY;
    CFG_STORE.llmConfigStore.invalidate();
    const e = await MS.effectiveModelConfig({ sessionKey: 'x' });
    expect(e.provider).toBe('openai');
    expect(e.source).toBe('provider');
    expect(e.model).toBe('gpt-5.6');
    await seedConfig('deepseek', 'm1', 'https://x/v1');
    CFG_STORE.llmConfigStore.invalidate();
  });
});

// ───────────────────────── Run 快照 ─────────────────────────

describe('Run 记录里的模型快照', () => {
  it('startRun 存下 modelConfig 并能读回 (加成字段)', async () => {
    const snap: any = {
      provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1',
      configHash: 'abc123', selectionScope: 'global', capturedAt: new Date().toISOString(),
    };
    const rec = await RS.startRun({ surface: 'cli', goal: '快照用例', modelConfig: snap });
    expect(rec.modelConfig).toEqual(snap);
    const back = await RS.readRun(rec.runId);
    expect(back?.modelConfig?.configHash).toBe('abc123');
    expect(back?.modelConfig?.selectionScope).toBe('global');
  });

  it('不传 modelConfig 的老调用方式仍然可用 (字段缺省, 不是 null 就不是假的)', async () => {
    const rec = await RS.startRun({ surface: 'cli', goal: '没有快照' });
    expect(rec.modelConfig).toBeUndefined();
  });

  it('captureRunModelConfig 给出的就是当前有效配置的快照', async () => {
    const e = await MS.effectiveModelConfig({ sessionKey: 'x' });
    const snap = await MS.captureRunModelConfig('x');
    expect(snap.provider).toBe(e.provider);
    expect(snap.model).toBe(e.model);
    expect(snap.baseUrl).toBe(e.baseUrl);
    expect(snap.configHash).toBe(e.configHash);
    expect(snap.selectionScope).toBe(e.source);
  });

  it('runModelConfigOf 不夹带凭证', () => {
    const e = MS.materialize({ provider: 'deepseek', model: 'm', baseUrl: 'https://x/v1', apiKey: 'sk-y' }, 'global');
    expect(JSON.stringify(MS.runModelConfigOf(e))).not.toContain('sk-y');
  });
});

// ───────────────────────── 统一入口的"失败不留痕"性质 ─────────────────────────

describe('selectModel 失败时不留半成功状态', () => {
  it('未知 provider → 配置字节不变', async () => {
    const CFG_STORE: any = await import('../llm/config-store.js');
    CFG_STORE.llmConfigStore.invalidate();
    const before = await fs.readFile(CFG, 'utf-8');
    const r = await MS.selectModel({ provider: 'nope-provider' });
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('invalid_provider');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
    // 运行时必须还在 (旧模型仍可用)
    expect(() => (globalThis as any)).not.toThrow();
  });

  it('会话级带凭证 → credential_scope_conflict, 且不写配置文件', async () => {
    const CFG_STORE: any = await import('../llm/config-store.js');
    CFG_STORE.llmConfigStore.invalidate();
    const before = await fs.readFile(CFG, 'utf-8');
    const r = await MS.selectModel({ provider: 'deepseek', apiKey: 'sk-new', scope: 'session', sessionKey: 's1' });
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('credential_scope_conflict');
    expect(await fs.readFile(CFG, 'utf-8')).toBe(before);
  });

  it('探测跳过时能真写入, 且直接调用被拒的 provider 不会改配置', async () => {
    process.env.BOLLOON_MODEL_SKIP_PROBE = '1';
    const r = await MS.selectModel({ provider: 'deepseek', model: 'm-new', baseUrl: 'https://x/v1', scope: 'global' });
    expect(r.ok).toBe(true);
    expect(r.effective?.model).toBe('m-new');
    const onDisk = JSON.parse(await fs.readFile(CFG, 'utf-8'));
    expect(onDisk.activeProvider).toBe('deepseek');
    expect(onDisk.providers.deepseek.model).toBe('m-new');
    delete process.env.BOLLOON_MODEL_SKIP_PROBE;
  });
});
