/**
 * runner-resolver 单测 (2026-09-16, 批次 2-C.2)
 *
 * 这一层是"独立宿主为什么跑不起来"的诊断面, 所以测试重点是**失败要说清卡在哪一阶段**:
 *  - 没有 channelId → resolve_agent
 *  - LLM 不可用 → init_llm (且**不会**建 session, 不浪费一次执行)
 *  - 建 session 超时 → create_session + errorClass=timeout
 *  - 全程通过 → ok=true, 阶段有序, ready 收尾
 *  - runner 拿不到 Run → 如实返回 failed (**不许**把"没跑"当"跑完")
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-rr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(path.join(TMP, '.bolloon'), { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const OK_LLM = async () => ({ ok: true, provider: 'test', model: 'test-1', hasKey: true });

async function mk() {
  const gs = await import('../agents/goal-store.js');
  const rr = await import('../agents/runner-resolver.js');
  return { gs, rr };
}

const req = (goal: any, over: Record<string, unknown> = {}) => ({ goal, kind: 'first_run', instruction: 'x', guards: [], ...over }) as any;

describe('分阶段解析 — 失败必须说清卡在哪', () => {
  it('Goal 没有 channelId → 卡在 resolve_agent (不建 Run, 不改 Goal)', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: '没有 channel 的目标' });
    let created = 0;
    const res = await rr.resolveGoalRunner(req(g), { probeLlm: OK_LLM, createAgent: () => { created++; return {}; } });
    expect(res.ok).toBe(false);
    expect(res.failedStage).toBe('resolve_agent');
    expect(String(res.reason)).toContain('channelId');
    expect(created).toBe(0);                                     // 阶段顺序: 先解析 agent 才建 session
    expect((await gs.readGoal(g.goalId))!.status).toBe('open');   // 状态未动
  });

  it('LLM 不可用 → 卡在 init_llm (config), 且**不会**建 session', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: 'llm 不可用', channelId: 'ch-1' });
    let created = 0;
    const res = await rr.resolveGoalRunner(req(g), {
      probeLlm: async () => ({ ok: false, provider: 'deepseek', reason: 'provider deepseek 需要 apiKey 但没配' }),
      createAgent: () => { created++; return {}; },
    });
    expect(res.ok).toBe(false);
    expect(res.failedStage).toBe('init_llm');
    expect(res.stages.find((s) => s.stage === 'init_llm')?.errorClass).toBe('config');
    expect(created).toBe(0);
  });

  it('建 session 超时 → 卡在 create_session 且分类为 timeout', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: 'session 卡住', channelId: 'ch-1' });
    const res = await rr.resolveGoalRunner(req(g), {
      probeLlm: OK_LLM,
      createTimeoutMs: 120,
      createAgent: () => new Promise(() => { /* 永不 resolve */ }),
    });
    expect(res.ok).toBe(false);
    expect(res.failedStage).toBe('create_session');
    expect(res.stages.find((s) => s.stage === 'create_session')?.errorClass).toBe('timeout');
    expect(String(res.stages.find((s) => s.stage === 'create_session')?.error)).toContain('超时');
  });

  it('显式关闭自动执行 → 明确 unresolved, 不偷偷跑', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: 'x', channelId: 'ch-1' });
    const res = await rr.resolveGoalRunner(req(g), { allow: false });
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('显式关闭');
  });
});

describe('分阶段解析 — 通过路径', () => {
  it('全绿: 阶段有序、ready 收尾、runner 可用、非必需阶段带 note', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: '能跑', channelId: 'ch-1', agentId: 'ag-1' });
    const fakeAgent = {
      // K8 (2026-10-02): 通道/runner 现在走**唯一执行入口** `runExecution` ⇒ 夹具必须跟上契约
      runExecution: async () => 'done',
      prompt: async () => 'done',
      getLastRunId: () => 'run-fake-1',
      setGoalId: () => {},
      setContinuationGuards: () => {},
    };
    const res = await rr.resolveGoalRunner(req(g), { probeLlm: OK_LLM, createAgent: () => fakeAgent });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('standalone');
    expect(res.stages.map((s) => s.stage)).toEqual(['resolve_goal', 'resolve_agent', 'load_identity', 'load_session', 'load_skills', 'init_llm', 'create_session', 'ready']);
    expect(res.stages.every((s) => s.ok)).toBe(true);
    expect(res.stages.find((s) => s.stage === 'init_llm')?.note).toContain('provider=test');
    expect(res.stages.find((s) => s.stage === 'load_skills')?.note).toContain('技能视图');
    expect(res.stages.find((s) => s.stage === 'ready')?.note).toContain('runner 就绪');
    const out = await res.runner!(req(g));
    expect(out.runId).toBe('run-fake-1');
    expect(out.status).toBe('done');
  });

  it('runner 拿不到 Run → 如实 failed (不把"没跑"当"跑完")', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: '没建 Run', channelId: 'ch-1' });
    const fakeAgent = { runExecution: async () => '兜底文案', prompt: async () => '兜底文案', getLastRunId: () => '', getRunId: () => '', setGoalId: () => {}, setContinuationGuards: () => {} };
    const res = await rr.resolveGoalRunner(req(g), { probeLlm: OK_LLM, createAgent: () => fakeAgent });
    const out = await res.runner!(req(g));
    expect(out.status).toBe('failed');
    expect(String(out.error)).toContain('没有产生 Run 记录');
  });

  it('formatStages / describeResolution 能把诊断讲清楚', async () => {
    const { gs, rr } = await mk();
    const g = await gs.createGoal({ objective: 'x' });
    const res = await rr.resolveGoalRunner(req(g), { probeLlm: OK_LLM });
    const line = rr.formatStages(res.stages);
    expect(line).toContain('resolve_goal✓');
    expect(line).toContain('resolve_agent✗');
    const desc = rr.describeResolution(res);
    expect(desc).toContain('不可执行');
    expect(desc).toContain('resolve_agent');
  });
});
