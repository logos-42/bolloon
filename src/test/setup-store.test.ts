/**
 * setup-store 单测 (M0/M1 + Phase 1 事实来源统一, 2026-09-16)
 *
 * 修的是: 判定失败不能当"不需要初始化"; 引导状态必须能回答"到哪一步/为什么停/下一步";
 * 事实来源必须与真实写入路径一致 (身份在 identity/user.json, LLM 在 bolloon-config.json)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '', BHOME = '', HOME = '';
const OLD = { HOME: process.env.HOME, UP: process.env.USERPROFILE, BH: process.env.BOLLOON_HOME };

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-setup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  HOME = path.join(TMP, 'home');
  BHOME = path.join(HOME, '.bolloon');
  await fs.mkdir(BHOME, { recursive: true });
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.BOLLOON_HOME;
});

afterEach(async () => {
  process.env.HOME = OLD.HOME; process.env.USERPROFILE = OLD.UP;
  if (OLD.BH === undefined) delete process.env.BOLLOON_HOME; else process.env.BOLLOON_HOME = OLD.BH;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function mod() { const m = await import('../setup/setup-store.js'); m.resetSetupGateCache(); return m; }
async function writeIdentity(name = 'leo') {
  await fs.mkdir(path.join(BHOME, 'identity'), { recursive: true });
  await fs.writeFile(path.join(BHOME, 'identity', 'user.json'), JSON.stringify({ name, did: 'did:key:zTest', publicKeyHex: '00' }), 'utf8');
}
async function writeConfig(provider = 'deepseek', p: any = {}) {
  await fs.writeFile(path.join(BHOME, 'bolloon-config.json'), JSON.stringify({ activeProvider: provider, providers: { [provider]: { model: 'm-1', requiresApiKey: true, ...p } } }), 'utf8');
}
const base = (over: any = {}) => ({ readIdentity: async () => ({ did: 'did:key:zTest', name: 'leo' }), readConfig: async () => ({ source: 'canonical', activeProvider: 'deepseek', providers: { deepseek: { apiKey: 'k', model: 'm-1' } }, legacyPresent: false }), runtimeReady: async () => true, readSkills: async () => ({ total: 1, invalid: 0 }), supervisorStatus: async () => ({ resolvable: true }), providerDefaults: { deepseek: { model: 'm-1' } }, ...over });

describe('路径与配置事实来源 (Phase 1)', () => {
  it('BOLLOON_HOME 优先; 否则 $HOME/.bolloon; 改 env 立刻生效 (不缓存)', async () => {
    const m = await mod();
    expect(m.resolveBolloonHome()).toBe(path.join(HOME, '.bolloon'));
    process.env.BOLLOON_HOME = path.join(TMP, 'custom');
    expect(m.resolveBolloonHome()).toBe(path.join(TMP, 'custom'));
    delete process.env.BOLLOON_HOME;
    process.env.HOME = path.join(TMP, 'other');
    expect(m.resolveBolloonHome()).toBe(path.join(TMP, 'other', '.bolloon'));
  });

  it('正式配置 bolloon-config.json 优先; 只有旧文件时标 legacy (迁移输入)', async () => {
    const m = await mod();
    expect((await m.readConfigFacts(BHOME)).source).toBe('missing');
    await fs.writeFile(path.join(BHOME, 'llm-config.json'), JSON.stringify({ activeProvider: 'openai', providers: { openai: { model: 'gpt' } } }), 'utf8');
    const legacy = await m.readConfigFacts(BHOME);
    expect(legacy.source).toBe('legacy');
    expect(legacy.activeProvider).toBe('openai');
    await writeConfig('deepseek', { apiKey: 'k' });
    const canon = await m.readConfigFacts(BHOME);
    expect(canon.source).toBe('canonical');
    expect(canon.activeProvider).toBe('deepseek');
    expect(canon.legacyPresent).toBe(true);
  });

  it('正式配置损坏 → 抛错 (由上层判 needs_repair), 不静默降级到旧文件', async () => {
    const m = await mod();
    await fs.writeFile(path.join(BHOME, 'bolloon-config.json'), '{broken', 'utf8');
    await fs.writeFile(path.join(BHOME, 'llm-config.json'), JSON.stringify({ activeProvider: 'openai', providers: {} }), 'utf8');
    await expect(m.readConfigFacts(BHOME)).rejects.toThrow();
  });

  it('身份事实来源 = ~/.bolloon/identity/user.json (真实写入路径)', async () => {
    const m = await mod();
    await writeIdentity('真路径用户');
    const ev = await m.evaluateSetup({ ...base(), readIdentity: undefined as any });
    expect(ev.state.checks.identity).toBe(true);
    const fp1 = await m.hashConfigFiles(BHOME);
    await writeIdentity('改过名字');
    const fp2 = await m.hashConfigFiles(BHOME);
    expect(fp2.hash).not.toBe(fp1.hash);        // 身份变化必须进指纹
  });
});

describe('状态机: 单调推进 + 每个阶段可达', () => {
  it('全新 HOME → setup / identity_pending; agent/web/supervisor 全不允许', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup({ readIdentity: async () => null, readConfig: async () => ({ source: 'missing', activeProvider: undefined, providers: {}, legacyPresent: false }), runtimeReady: async () => false });
    expect(ev.gate).toBe('setup');
    expect(ev.state.stage).toBe('identity_pending');
    expect(ev.state.allow).toEqual({ cli: true, web: false, supervisor: false, agent: false });
    expect(ev.state.actions[0]).toContain('身份');
  });

  it('身份有、供应商缺 → provider_pending', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup(base({ readConfig: async () => ({ source: 'canonical', activeProvider: undefined, providers: {}, legacyPresent: false }) }));
    expect(ev.state.stage).toBe('provider_pending');
    expect(ev.gate).toBe('setup');
    expect(ev.reasons.join(' ')).toMatch(/供应商/);
  });

  it('供应商已选但缺 key → **credential_pending** (此前不可达的状态)', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup(base({ readConfig: async () => ({ source: 'canonical', activeProvider: 'deepseek', providers: { deepseek: { model: 'm-1', requiresApiKey: true } }, legacyPresent: false }) }));
    expect(ev.state.stage).toBe('credential_pending');
    expect(ev.reasons.join(' ')).toContain('apiKey');
    expect(ev.state.readinessWhy.basic.join(' ')).toContain('apiKey');
    expect(ev.state.allow.agent).toBe(false);
  });

  it('供应商不需要 key → 直接进 model/connectivity (不卡在 credential)', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup(base({ readConfig: async () => ({ source: 'canonical', activeProvider: 'local', providers: { local: { requiresApiKey: false, model: 'llama' } }, legacyPresent: false }) }));
    expect(ev.state.stage).toBe('connectivity_pending');
  });

  it('缺模型名 → model_pending', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup(base({ providerDefaults: {}, readConfig: async () => ({ source: 'canonical', activeProvider: 'weird', providers: { weird: { apiKey: 'k' } }, legacyPresent: false }) }));
    expect(ev.state.stage).toBe('model_pending');
  });

  it('测过 + 配置没变 → 结论有效 (48h 前测过也不算过期; 配置变了才需重测)', async () => {
    const m = await mod();
    const fresh = await m.evaluateSetup(base());
    expect(fresh.state.stage).toBe('connectivity_pending');   // 还没测过
    // 记录「测过」(48h 前) — recordSetupStage 现在同步落 configHash
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date(Date.now() - 48 * 3600_000).toISOString() } });
    // 配置没变 (hash 一致) ⇒ 48h 前测过仍有效 → 前进到 runtime (不是 connectivity_pending)
    const stale = await m.evaluateSetup(base());
    expect(stale.state.stage).not.toBe('connectivity_pending');
    expect(stale.reasons.join(' ')).not.toContain('连通性');
    // 配置变了 (真实文件改 provider) ⇒ 指纹变 ⇒ 需重测
    await writeConfig('other', { apiKey: 'x' });
    const changed = await m.evaluateSetup(base());
    expect(changed.state.stage).toBe('connectivity_pending');
    expect(changed.reasons.join(' ')).toMatch(/重测|变化/);
  });

  it('运行时没起来 → runtime_pending', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    const ev = await m.evaluateSetup(base({ runtimeReady: async () => false }));
    expect(ev.state.stage).toBe('runtime_pending');
    expect(ev.state.readinessWhy.basic.join(' ')).toContain('运行时');
  });

  it('全部真实通过 → ready, allow.agent/supervisor 打开, 四层 readiness 有解释', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    const ev = await m.evaluateSetup(base());
    expect(ev.gate).toBe('ready');
    expect(ev.state.stage).toBe('ready');
    expect(ev.state.readiness).toMatchObject({ basic: true, agent: true, durable: true });
    expect(ev.state.allow).toMatchObject({ agent: true, supervisor: true, web: true });
    expect(ev.state.completed).toContain('connectivity_pending');
  });
});

describe('readiness 是真实检查 (不是推断字段)', () => {
  it('skillsOk 未知 → agent 不通过, 且说明"不能当作通过"', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    const ev = await m.evaluateSetup(base({ readSkills: async () => null }));
    expect(ev.state.readiness.agent).toBe(false);
    expect(ev.state.readiness.basic).toBe(true);
    expect(ev.state.readinessWhy.agent.join(' ')).toContain('未知');
  });

  it('有坏技能 → agent 不通过并指出数量', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    const ev = await m.evaluateSetup(base({ readSkills: async () => ({ total: 3, invalid: 2 }) }));
    expect(ev.state.readiness.agent).toBe(false);
    expect(ev.state.readinessWhy.agent.join(' ')).toContain('2');
  });

  it('Supervisor runner 解析不出来 → durable 不通过, 带原因', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    const ev = await m.evaluateSetup(base({ supervisorStatus: async () => ({ resolvable: false, reason: 'create_session 阶段失败: 超时' }) }));
    expect(ev.state.readiness.durable).toBe(false);
    expect(ev.state.readinessWhy.durable.join(' ')).toContain('create_session');
  });

  it('durable 不能只看 identity/provider (runs 目录不可写 → durable false)', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    // 把 runs 变成一个"文件" → mkdir 必失败
    await fs.writeFile(path.join(BHOME, 'runs'), 'not a dir', 'utf8');
    const ev = await m.evaluateSetup(base());
    expect(ev.state.readiness.durable).toBe(false);
    expect(ev.state.readinessWhy.durable.join(' ')).toContain('runs');
  });
});

describe('fail-closed 与失败记录', () => {
  it('配置损坏 (有历史) → gate=repair, lastError=config, 输入保留', async () => {
    const m = await mod();
    await m.recordSetupStage('identity_pending', { inputs: { name: 'leo', identityDid: 'did:key:z' } });
    const ev = await m.evaluateSetup(base({ readConfig: async () => { throw new Error('Unexpected token in JSON'); } }));
    expect(ev.gate).toBe('repair');
    expect(ev.state.lastError?.errorClass).toBe('config');
    expect(ev.state.inputs.identityDid).toBe('did:key:z');
    expect(ev.state.actions.join(' ')).toContain('repair');
  });

  it('家目录不可写 → blocked (唯一不能自动继续的情形)', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup(base({ homeWritableProbe: async () => false }));
    expect(ev.gate).toBe('blocked');
    expect(ev.reasons.join(' ')).toContain('不可写');
  });

  it('门禁缓存 fail-closed: 状态不可读 → blocked; reset 后可重算', async () => {
    const m = await mod();
    const asFile = path.join(TMP, 'not-a-dir');
    await fs.writeFile(asFile, 'x', 'utf8');
    process.env.BOLLOON_HOME = asFile;
    expect((await m.getSetupGateCached()).gate).toBe('blocked');
    m.resetSetupGateCache();
    delete process.env.BOLLOON_HOME;
    const again = await m.getSetupGateCached();
    expect(['ready', 'setup', 'repair']).toContain(again.gate);
  });

  it('失败记录: 分类 + 关掉 agent/web/supervisor + 给恢复动作; 成功阶段清掉错误', async () => {
    const m = await mod();
    const st = await m.recordSetupFailure('connectivity', 'timeout', '连通性测试超时');
    expect(st.lastError?.errorClass).toBe('timeout');
    expect(st.allow).toEqual({ cli: true, web: false, supervisor: false, agent: false });
    expect(st.actions.join(' ')).toMatch(/重试/);
    const st2 = await m.recordSetupStage('provider_pending', { inputs: { provider: 'deepseek' } });
    expect(st2.lastError).toBeUndefined();
    expect(st2.completed).toContain('provider_pending');
  });

  it('状态文件原子写 (无 .tmp 残留), describeSetup 给出缺什么 + 下一步', async () => {
    const m = await mod();
    await m.writeSetupState(m.emptySetupState());
    const files = await fs.readdir(BHOME);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
    const ev = await m.evaluateSetup({ readIdentity: async () => null, readConfig: async () => ({ source: 'missing', providers: {}, legacyPresent: false }), runtimeReady: async () => false });
    const text = m.describeSetup(ev);
    expect(text).toContain('门禁');
    expect(text).toContain('缺 (basic)');
    expect(text).toContain('下一步');
  });
});
