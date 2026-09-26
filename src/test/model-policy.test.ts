/**
 * model-policy.test.ts — P7 模型策略 (Goal modelPolicy / 在跑 Run 不改写 / 跨 Run 守卫) 单测
 *
 * 覆盖:
 *   ① 策略解析 (三种模式 + 未知模式 + 不完整 pinned) —— 降级方向必须**保守** (不擅自跟随全局);
 *   ② `resolveRunModel` 语义表逐行: 在跑的 Run 用自己快照 (Global 变了也不改) / 新 Run 按策略取一份;
 *   ③ pinned 与在跑快照冲突 → 只报冲突, 不改写;
 *   ④ 非幂等守卫: 模型变了守卫照带 (`guardsDropped` 恒 0) + 重放判定;
 *   ⑤ Supervisor 备用模型: 按失败类别放行/拒绝的矩阵;
 *   ⑥ 事件与策略文件落盘 (真 I/O, 隔离 HOME)。
 *
 * 隔离: 临时 HOME (run-store/goal 系按 os.homedir(), 配置层按 BOLLOON_HOME), 所以两者都指到 TMP。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const TMP = path.join(os.tmpdir(), 'bolloon-model-policy-' + Date.now());
const CFG = path.join(TMP, 'bolloon-config.json');

let MP: typeof import('../agents/model-policy.js');
let RS: typeof import('../agents/run-store.js');
let MS: typeof import('../llm/model-selection.js');

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;      // 配置层 (resolveBolloonHome 优先它)
  process.env.HOME = TMP;              // 记录层 (runsDir/goal 用 os.homedir())
  process.env.USERPROFILE = TMP;
  await fs.mkdir(TMP, { recursive: true });
  MP = await import('../agents/model-policy.js');
  RS = await import('../agents/run-store.js');
  MS = await import('../llm/model-selection.js');
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** 写一份全局配置 (测试夹具; 走的是配置层自己的文件, 与统一入口落盘格式一致) */
async function seedConfig(activeProvider: string, model: string, baseUrl: string): Promise<void> {
  await fs.writeFile(CFG, JSON.stringify({
    activeProvider,
    providers: {
      [activeProvider]: { enabled: true, apiKey: 'k-test', baseUrl, model, requiresApiKey: true },
    },
    updatedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  const store: any = (await import('../llm/config-store.js')).llmConfigStore;
  store.invalidate();
}

function runConfig(provider: string, model: string, baseUrl: string, scope: any = 'global'): any {
  return MP.runConfigOf({ provider, model, baseUrl, selectionScope: scope, capturedAt: 'T' });
}

async function makeRun(opts: { goalId?: string; snapshot?: any; steps?: any[] } = {}): Promise<any> {
  const rec = await RS.startRun({
    surface: 'cli',
    goal: 'P7 策略用例',
    goalId: opts.goalId,
    modelConfig: opts.snapshot,
  });
  if (opts.steps) {
    for (const s of opts.steps) {
      await RS.recordStep(rec.runId, { tool: s.tool, ok: s.ok, args: s.args, summary: s.summary });
    }
  }
  return (await RS.readRun(rec.runId))!;
}

// ============================================================
// ① 策略解析
// ============================================================

describe('① Goal 模型策略解析 (降级必须保守)', () => {
  it('未声明 → auto (计划里的默认行为), 且不算失败', () => {
    const r = MP.parseGoalModelPolicy(undefined);
    expect(r.ok).toBe(true);
    expect(r.policy.mode).toBe('auto');
    expect(String(r.reason)).toContain('auto');
  });

  it('三种模式都认 (pinned 带完整 pin, baseUrl 归一化)', () => {
    expect(MP.parseGoalModelPolicy({ mode: 'auto' }).ok).toBe(true);
    expect(MP.parseGoalModelPolicy({ mode: 'session' }).policy.mode).toBe('session');
    const p = MP.parseGoalModelPolicy({ mode: 'pinned', pin: { provider: 'Kimi', model: 'k3', baseUrl: 'https://h/v1/' } });
    expect(p.ok).toBe(true);
    expect(p.policy.pin).toEqual({ provider: 'kimi', model: 'k3', baseUrl: 'https://h/v1' });
  });

  it('未知模式 → ok=false + 降级 auto (理由里点名原值)', () => {
    const r = MP.parseGoalModelPolicy({ mode: 'forever' });
    expect(r.ok).toBe(false);
    expect(r.policy.mode).toBe('auto');
    expect(String(r.reason)).toContain('forever');
    expect(String(r.reason)).toContain('不自动改写在跑的 Run');
  });

  it('pinned 缺 provider/model → ok=false (固定不下来)', () => {
    const r = MP.parseGoalModelPolicy({ mode: 'pinned', pin: { provider: 'kimi' } });
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('pinned');
  });

  it('不是对象 (字符串/数字) → ok=false, 不假装读到策略', () => {
    expect(MP.parseGoalModelPolicy('pinned').ok).toBe(false);
    expect(MP.parseGoalModelPolicy(42).ok).toBe(false);
  });

  it('字符串 JSON 也能吃 (sidecar 原文直传)', () => {
    const r = MP.parseGoalModelPolicy('{"mode":"session"}');
    expect(r.ok).toBe(true);
    expect(r.policy.mode).toBe('session');
  });
});

// ============================================================
// ② 在跑的 Run 用自己快照 (Global 切换不改写)
// ============================================================

describe('② 正在执行的 Run: 快照是唯一真源', () => {
  // 注意: 在 describe 体里求值会早于 beforeAll 的动态 import, 所以用惰性构造函数
  const snap = () => runConfig('deepseek', 'old-model', 'https://api.deepseek.com/v1');
  const newer = {
    provider: 'kimi', model: 'new-model', baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai-compatible', authRef: 'provider:kimi', reasoning: false, reasoningMode: 'unset',
    temperature: null, scope: 'global', source: 'global', updatedAt: 'T', configHash: 'HASH-NEW',
  } as any;

  it('Global 变了也不改写在跑的 Run (返回原快照, frozen=true)', () => {
    const d = MP.resolveRunModel({
      intent: 'current_run',
      run: { runId: 'r1', goalId: 'g1', status: 'running', modelConfig: snap() },
      policy: { mode: 'auto' },
      latest: newer,
    });
    expect(d.config?.configHash).toBe(snap().configHash);
    expect(d.source).toBe('run_snapshot');
    expect(d.switched).toBe(false);
    expect(d.frozen).toBe(true);
    expect(d.reason).toContain('Global 切换不自动改写');
  });

  it('pinned 目标与在跑快照冲突 → 报冲突字段, 且**不改写**', () => {
    const d = MP.resolveRunModel({
      intent: 'current_run',
      run: { runId: 'r1', goalId: 'g1', status: 'running', modelConfig: snap() },
      policy: { mode: 'pinned', pin: { provider: 'kimi', model: 'k3', baseUrl: 'https://api.moonshot.cn/v1' } },
      latest: newer,
    });
    expect(d.config?.configHash).toBe(snap().configHash);       // 在跑的那一份没被动
    expect(d.conflict.map((c) => c.field).sort()).toEqual(['baseUrl', 'model', 'provider']);
    expect(d.reason).toContain('不在跑动中换模型');
  });

  it('老 Run 没有快照 → 如实给 null (不编一份)', () => {
    const d = MP.resolveRunModel({
      intent: 'current_run',
      run: { runId: 'r0', status: 'running' },
      policy: { mode: 'auto' },
      latest: newer,
    });
    expect(d.config).toBeNull();
    expect(d.source).toBe('none');
    expect(d.reason).toContain('没有模型快照');
  });
});

// ============================================================
// ③ 新 Run: 三种模式各怎么取
// ============================================================

describe('③ 新 Run 的模型来源 (auto / pinned / session)', () => {
  // 同上: 惰性求值 (beforeAll 里才 import 到模块)
  const prev = () => runConfig('deepseek', 'old-model', 'https://api.deepseek.com/v1');
  const latest = {
    provider: 'kimi', model: 'new-model', baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai-compatible', authRef: 'provider:kimi', reasoning: false, reasoningMode: 'unset',
    temperature: null, scope: 'global', source: 'global', updatedAt: 'T', configHash: 'HASH-NEW',
  } as any;
  const run = () => ({ runId: 'r1', goalId: 'g1', status: 'done', modelConfig: prev() } as any);

  it('auto: 新 Run 用最新默认, 且承认"换了"', () => {
    const d = MP.resolveRunModel({ intent: 'next_run', run: run(), policy: { mode: 'auto' }, latest });
    expect(d.source).toBe('global');
    expect(d.switched).toBe(true);
    expect(d.frozen).toBe(false);
    expect(d.config?.model).toBe('new-model');
  });

  it('auto: 与上一个 Run 同一份 → switched=false (没换就说没换)', () => {
    const same = { ...latest, provider: 'deepseek', model: 'old-model', baseUrl: 'https://api.deepseek.com/v1' } as any;
    const d = MP.resolveRunModel({ intent: 'next_run', run: run(), policy: { mode: 'auto' }, latest: same });
    expect(d.switched).toBe(false);
  });

  it('auto: 读不到最新默认 → 保守沿用上一个 Run 的快照 (不假装换了)', () => {
    const d = MP.resolveRunModel({ intent: 'next_run', run: run(), policy: { mode: 'auto' }, latest: null });
    expect(d.config?.configHash).toBe(prev().configHash);
    expect(d.frozen).toBe(true);
    expect(d.reason).toContain('不假装换了');
  });

  it('pinned: 新 Run 用固定三元组 (与 Global 无关)', () => {
    const d = MP.resolveRunModel({
      intent: 'next_run', run: run(),
      policy: { mode: 'pinned', pin: { provider: 'glm', model: 'glm-5.2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } },
      latest,
    });
    expect(d.source).toBe('goal_pin');
    expect(d.config?.provider).toBe('glm');
    expect(d.config?.model).toBe('glm-5.2');
    expect(d.config?.configHash).toBe(MS.configHashOf({ provider: 'glm', model: 'glm-5.2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }));
    expect(d.switched).toBe(true);
  });

  it('session: 有会话绑定 → 用会话那一份 (Global 的新默认不传播)', () => {
    const d = MP.resolveRunModel({
      intent: 'next_run', run: run(), policy: { mode: 'session' }, latest,
      sessionBinding: { provider: 'glm', model: 'session-model', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    });
    expect(d.source).toBe('session');
    expect(d.config?.model).toBe('session-model');
    expect(d.config?.configHash).not.toBe(latest.configHash);
  });

  it('session: 没有会话绑定 → 保住上一个 Run 的快照 (不让 Global 漏进来), frozen=true', () => {
    const d = MP.resolveRunModel({ intent: 'next_run', run: run(), policy: { mode: 'session' }, latest });
    expect(d.config?.configHash).toBe(prev().configHash);
    expect(d.frozen).toBe(true);
    expect(d.reason).toContain('不让 Global 的新默认漏进来');
  });

  it('策略解析失败 → 谁都不许换 (沿用上一个 Run 快照)', () => {
    const d = MP.resolveRunModel({ intent: 'next_run', run: run(), policy: { mode: 'nonsense' }, latest });
    expect(d.mode).toBe('unknown');
    expect(d.policyOk).toBe(false);
    expect(d.config?.configHash).toBe(prev().configHash);
    expect(d.frozen).toBe(true);
  });

  it('pinned 缺固定且无处继承 baseUrl → 不为新 Run 编造地址', () => {
    const d = MP.resolveRunModel({
      intent: 'next_run',
      run: { runId: 'r9', goalId: 'g9', status: 'done' },
      policy: { mode: 'pinned', pin: { provider: 'glm', model: 'glm-5.2' } },
      latest: null,
    });
    expect(d.config).toBeNull();
    expect(d.frozen).toBe(true);
    expect(d.reason).toContain('编造');
  });
});

// ============================================================
// ④ 非幂等守卫: 模型变了 ≠ 可以重做
// ============================================================

describe('④ 模型切换不构成重做非幂等动作的理由', () => {
  it('模型真的换了, 守卫照带 (guardsDropped=0, 指令里点名不许重做)', () => {
    const prev: any = {
      modelConfig: runConfig('deepseek', 'old-model', 'https://api.deepseek.com/v1'),
      steps: [
        { n: 1, tool: 'read_file', ok: true, argsDigest: 'p1', summary: '读' },
        { n: 2, tool: 'terminal', ok: true, argsDigest: 'printf x >> probe.txt', summary: '追加写了 probe' },
        { n: 3, tool: 'write_file', ok: false, argsDigest: 'p2', summary: '失败的一次' },   // 失败的不算已执行
      ],
    };
    const decision = MP.resolveRunModel({
      intent: 'next_run',
      run: { runId: 'r1', goalId: 'g1', status: 'done', modelConfig: prev.modelConfig },
      policy: { mode: 'auto' },
      latest: { provider: 'kimi', model: 'new-model', baseUrl: 'https://api.moonshot.cn/v1', configHash: 'NEW' } as any,
    });
    const plan = MP.planSwitchContinuation({ prevRun: prev, decision });
    expect(plan.modelChanged).toBe(true);
    expect(plan.guards.map((g) => g.tool)).toEqual(['terminal']);
    expect(plan.previousGuardCount).toBe(1);
    expect(plan.guardsDropped).toBe(0);
    expect(plan.instructionNote).toContain('绝不重复执行');
  });

  it('模型没换也照样带守卫 (守卫与模型决定解耦)', () => {
    const prev: any = {
      modelConfig: runConfig('deepseek', 'old-model', 'https://api.deepseek.com/v1'),
      steps: [{ n: 1, tool: 'terminal', ok: true, argsDigest: 'd', summary: '写了一次' }],
    };
    const decision = MP.resolveRunModel({
      intent: 'next_run', run: { runId: 'r1', status: 'done', modelConfig: prev.modelConfig },
      policy: { mode: 'session' }, latest: null,
    });
    const plan = MP.planSwitchContinuation({ prevRun: prev, decision });
    expect(plan.modelChanged).toBe(false);
    expect(plan.guards.length).toBe(1);
    expect(plan.guardsDropped).toBe(0);
  });

  it('只读工具不进守卫 (白名单), 非幂等才进', () => {
    expect(RS.isNonIdempotentTool('read_file')).toBe(false);
    expect(RS.isNonIdempotentTool('terminal')).toBe(true);
    expect(RS.isNonIdempotentTool('write_file')).toBe(true);
    const prev: any = { modelConfig: null, steps: [
      { n: 1, tool: 'read_file', ok: true, summary: '读' },
      { n: 2, tool: 'shell_exec', ok: true, argsDigest: 'rm -f x', summary: '删了一次' },
    ] };
    expect(MP.guardsOfRun(prev).map((g) => g.tool)).toEqual(['shell_exec']);
  });

  it('重放判定: 同工具同参数才跳过; 换了参数照跑', () => {
    // 指纹走的就是记录层那一套 (argsDigestOf), 不另造一种摘要 —— 否则守卫永远匹配不上
    const sameArgs = { command: 'printf x >> f' };
    const guards = [{ tool: 'terminal', argsDigest: RS.argsDigestOf(sameArgs), summary: '已追加' }];
    expect(MP.shouldSkipAsReplay(guards, 'terminal', { command: 'printf x >> f' }).skip).toBe(true);
    expect(MP.shouldSkipAsReplay(guards, 'terminal', { command: 'printf y >> f' }).skip).toBe(false);
    expect(MP.shouldSkipAsReplay(guards, 'read_file', { command: 'printf x >> f' }).skip).toBe(false);
    // 没有指纹的守卫按"同一工具就保守跳过"处理
    expect(MP.shouldSkipAsReplay([{ tool: 'git_commit', summary: '提交过' }], 'git_commit', { msg: '别的' }).skip).toBe(true);
    // 守卫与真步骤之间能对上 (端到端一致性: 用 Run 里记的那条指纹去判)
    const run: any = { steps: [{ n: 1, tool: 'terminal', ok: true, argsSaved: sameArgs, argsDigest: RS.argsDigestOf(sameArgs), summary: '追加写了一次' }] };
    expect(MP.shouldSkipAsReplay(MP.guardsOfRun(run), 'terminal', sameArgs).summary).toBe('追加写了一次');
  });

  it('守卫去重: 同工具同指纹只留一条', () => {
    const merged = MP.mergeGuards(
      [{ tool: 'terminal', argsDigest: 'a', summary: '1' }],
      [{ tool: 'terminal', argsDigest: 'a', summary: '2' }, { tool: 'terminal', argsDigest: 'b', summary: '3' }],
    );
    expect(merged.length).toBe(2);
    expect(merged[0].summary).toBe('1');
  });
});

// ============================================================
// ⑤ Supervisor 备用模型 (按失败类别)
// ============================================================

describe('⑤ Supervisor 挑选备用模型的边界', () => {
  it('auto + 模型相关失败 → 允许', () => {
    for (const cls of ['transient', 'auth', 'no_such_tool', 'unparsable'] as const) {
      expect(MP.supervisorMaySwitchModel({ mode: 'auto', errorClass: cls }).allowed).toBe(true);
    }
  });

  it('auto + 非模型相关失败 → 不允许 (换模型只会掩盖)', () => {
    for (const cls of ['bad_args', 'policy_denied', 'persist_failed', 'crash', 'external_no_reply'] as const) {
      const v = MP.supervisorMaySwitchModel({ mode: 'auto', errorClass: cls });
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain(String(cls));
    }
  });

  it('pinned / session / unknown 一律不允许', () => {
    expect(MP.supervisorMaySwitchModel({ mode: 'pinned', errorClass: 'transient' }).allowed).toBe(false);
    expect(MP.supervisorMaySwitchModel({ mode: 'session', errorClass: 'auth' }).allowed).toBe(false);
    expect(MP.supervisorMaySwitchModel({ mode: 'unknown', errorClass: 'transient' }).allowed).toBe(false);
  });

  it('没有失败类别 → 不为"顺手换个模型"开门', () => {
    expect(MP.supervisorMaySwitchModel({ mode: 'auto' }).allowed).toBe(false);
  });

  it('备用候选: 跳过与当前相同的那一份; 挑不到如实说', () => {
    const cur = runConfig('deepseek', 'a', 'https://h/v1');
    const same = runConfig('deepseek', 'a', 'https://h/v1/');
    const other = runConfig('kimi', 'b', 'https://k/v1');
    expect(MP.pickFallbackConfig(cur, [same, other]).config?.provider).toBe('kimi');
    expect(MP.pickFallbackConfig(cur, [same]).ok).toBe(false);
    expect(MP.pickFallbackConfig(cur, []).reason).toContain('没有可用备用模型');
  });
});

// ============================================================
// ⑥ 落盘: 事件 + 策略文件 (真 I/O)
// ============================================================

describe('⑥ 事件与策略文件真实落盘', () => {
  it('recordModelSwitch 写 modelSwitches + harness 镜像, 且**不动** modelConfig', async () => {
    const snap = runConfig('deepseek', 'old-model', 'https://api.deepseek.com/v1');
    const rec = await makeRun({ snapshot: snap });
    const to = runConfig('kimi', 'new-model', 'https://api.moonshot.cn/v1');
    const res = await RS.recordModelSwitch(rec.runId, {
      to, from: snap, outcome: 'switched', mode: 'auto', source: 'global',
      reason: 'auto: 新 Run 用最新默认', guardsCarried: 2, goalId: 'g-x',
    });
    expect(res.ok).toBe(true);
    const back = (await RS.readRun(rec.runId))!;
    expect(back.modelSwitches?.length).toBe(1);
    expect(back.modelSwitches?.[0].to.configHash).toBe(to.configHash);
    expect(back.modelSwitches?.[0].guardsCarried).toBe(2);
    expect(back.modelConfig?.configHash).toBe(snap.configHash);       // 快照定稿不改
    const mirror = (back.harness || []).find((e) => e.event === 'model.switch');
    expect(mirror?.kind).toBe('note');
    expect(String(mirror?.reason)).toContain('switched');
  });

  it('账本只留最近 MAX_MODEL_SWITCHES 条', async () => {
    const rec = await makeRun({ snapshot: runConfig('deepseek', 'm', 'https://h/v1') });
    for (let i = 0; i < RS.MAX_MODEL_SWITCHES + 3; i++) {
      await RS.recordModelSwitch(rec.runId, {
        to: runConfig('kimi', `m${i}`, 'https://k/v1'), outcome: 'frozen', mode: 'pinned', source: 'run_snapshot',
        reason: `第 ${i} 次`, guardsCarried: 0,
      });
    }
    const back = (await RS.readRun(rec.runId))!;
    expect(back.modelSwitches?.length).toBe(RS.MAX_MODEL_SWITCHES);
    expect(String(back.modelSwitches?.at(-1)?.reason)).toContain(`${RS.MAX_MODEL_SWITCHES + 2}`);
  });

  it('run 不存在时如实返回 ok=false (不是静默成功)', async () => {
    const res = await RS.recordModelSwitch('no-such-run', {
      to: runConfig('kimi', 'm', 'https://k/v1'), outcome: 'switched', mode: 'auto', source: 'global',
      reason: 'x', guardsCarried: 0,
    });
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('run 不存在');
  });

  it('策略文件: 写→读 (sidecar), Goal 记录上的字段优先于 sidecar', async () => {
    const goalId = 'g-policy-1';
    const w = await MP.writeGoalModelPolicy(goalId, { mode: 'pinned', pin: { provider: 'glm', model: 'glm-5.2', baseUrl: 'https://h/v1' } }, { updatedBy: 'test' });
    expect(w.ok).toBe(true);
    const v = await MP.readGoalModelPolicy(goalId);
    expect(v.origin).toBe('sidecar');
    expect(v.policy.mode).toBe('pinned');
    expect(v.policy.pin?.provider).toBe('glm');
    // Goal 记录上有这个字段时以记录为准 (未来主线接上就自动生效)
    const v2 = await MP.readGoalModelPolicy(goalId, { goalRecord: { modelPolicy: { mode: 'session' } } });
    expect(v2.origin).toBe('goal_record');
    expect(v2.policy.mode).toBe('session');
  });

  it('写一份用不了的 pinned 会被拒绝 (不落盘半成品)', async () => {
    const w = await MP.writeGoalModelPolicy('g-bad', { mode: 'pinned', pin: { provider: 'glm' } as any });
    expect(w.ok).toBe(false);
    const v = await MP.readGoalModelPolicy('g-bad');
    expect(v.origin).toBe('default');
  });

  it('sidecar 损坏 → origin=invalid + problems (不假装是默认)', async () => {
    const dir = MP.modelPolicyDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(MP.modelPolicyPath('g-broken'), '{ not json', 'utf8');
    const v = await MP.readGoalModelPolicy('g-broken');
    expect(v.origin).toBe('invalid');
    expect(v.problems.length).toBeGreaterThan(0);
    expect(v.policy.mode).toBe('auto');
  });
});

// ============================================================
// ⑦ 端到端 (真读配置): 在跑 Run 不改写 · 新 Run 用最新 Global · 事件落盘
// ============================================================

describe('⑦ 用真配置读一遍: 在跑的不动, 新的跟随', () => {
  it('切全局默认 → 在跑 Run 快照不变; 新 Run 快照变; 事件写在旧 Run 上', async () => {
    await seedConfig('deepseek', 'model-1', 'https://api.deepseek.com/v1');
    const snap1 = await MS.captureRunModelConfig();
    const rec = await makeRun({ snapshot: snap1, goalId: 'g-e2e', steps: [{ tool: 'terminal', ok: true, args: { command: 'printf x >> f' }, summary: '追加写了一次' }] });

    // 用户切全局默认 (真配置真变)
    await seedConfig('kimi', 'model-2', 'https://api.moonshot.cn/v1');
    const snap2 = await MS.captureRunModelConfig();
    expect(snap2.configHash).not.toBe(snap1.configHash);

    // (a) 在跑的 Run: 拿到的仍是自己的快照
    const cur = await MP.resolveCurrentRunModel(rec.runId, { record: true });
    expect(cur?.decision.config?.configHash).toBe(snap1.configHash);
    expect(cur?.decision.frozen).toBe(true);
    expect(cur?.event?.ok).toBe(true);

    // (b) 下一个 Run: auto → 用最新 Global
    const next = await MP.resolveNextRunModel({ prevRunId: rec.runId, goalId: 'g-e2e' });
    expect(next.decision.source).toBe('global');
    expect(next.decision.config?.configHash).toBe(snap2.configHash);
    expect(next.decision.switched).toBe(true);
    expect(next.policyOrigin).toBe('default');                      // 没声明策略 → 默认 auto, 不假装用户设过
    expect(next.continuation?.guards.map((g) => g.tool)).toEqual(['terminal']);   // 换了模型也不许重做
    expect(next.continuation?.guardsDropped).toBe(0);
    expect(next.event.ok).toBe(true);

    // (c) 旧 Run 记录: 快照没被改写, 但事件账本上有两条 (冻结 + 切换)
    const back = (await RS.readRun(rec.runId))!;
    expect(back.modelConfig?.configHash).toBe(snap1.configHash);
    expect(back.modelSwitches?.length).toBe(2);
    expect(back.modelSwitches?.map((e) => e.outcome)).toEqual(['frozen', 'switched']);

    // (d) 用决定里的快照开新 Run → 新 Run 的 modelConfig 就是新模型
    const rec2 = await makeRun({ snapshot: next.startRunModelConfig, goalId: 'g-e2e' });
    expect(rec2.modelConfig?.model).toBe('model-2');
  });

  it('pinned 目标: 全局切成 kimi, 新 Run 仍用固定的 glm 那一份', async () => {
    await MP.writeGoalModelPolicy('g-pin', { mode: 'pinned', pin: { provider: 'glm', model: 'glm-5.2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } }, { updatedBy: 'test' });
    await seedConfig('kimi', 'model-2', 'https://api.moonshot.cn/v1');
    const snap = await MS.captureRunModelConfig();
    const rec = await makeRun({ snapshot: snap, goalId: 'g-pin' });
    const next = await MP.resolveNextRunModel({ prevRunId: rec.runId, goalId: 'g-pin' });
    expect(next.decision.source).toBe('goal_pin');
    expect(next.decision.config?.provider).toBe('glm');
    expect(next.decision.config?.model).toBe('glm-5.2');
    expect(next.policyOrigin).toBe('sidecar');
  });

  it('Supervisor 备用: auto + transient 用候选; pinned + transient 拒绝并说原因', async () => {
    await seedConfig('kimi', 'model-2', 'https://api.moonshot.cn/v1');
    const snap = await MS.captureRunModelConfig();
    const rec = await makeRun({ snapshot: snap, goalId: 'g-fb' });
    const alt = MP.runConfigOf({ provider: 'glm', model: 'glm-backup', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', selectionScope: 'global' });

    const allowed = await MP.resolveNextRunModel({ prevRunId: rec.runId, goalId: 'g-fb', errorClass: 'transient', fallbackCandidates: [snap, alt], policy: { mode: 'auto' } });
    expect(allowed.decision.source).toBe('supervisor_fallback');
    expect(allowed.decision.config?.provider).toBe('glm');

    const denied = await MP.resolveNextRunModel({ prevRunId: rec.runId, goalId: 'g-fb', errorClass: 'transient', fallbackCandidates: [alt], policy: { mode: 'pinned', pin: { provider: 'kimi', model: 'model-2', baseUrl: 'https://api.moonshot.cn/v1' } } });
    expect(denied.decision.source).not.toBe('supervisor_fallback');
    expect(denied.decision.reason).toContain('不许挑备用模型');
  });
});
