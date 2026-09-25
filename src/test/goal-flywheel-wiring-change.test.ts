/**
 * goal-flywheel-wiring-change.test.ts — M4 接缝验收: **把 P4 接进"正在运行的 Goal"** (2026-09-25)
 *
 * 这道门回答一个问题: 用户在**目标跑着的时候**提要求, 「正在运行的 Goal」会被怎么处理。
 * 覆盖面 (对应用户验收清单的 M4 四项):
 *
 *   ① 撤销 → 在跑的 Run **真的停** (走既有外部控制面原语, 不是新造停止通道); 已发生的历史一字不改
 *   ② 非撤销 → **不打断**在跑的 Run (规则 4); 新要求只影响下一个 Run
 *   ③ 在跑的子 Agent → 逐 workId 一份下发内容, 必须先 ack (规则 5)
 *   ④ 用户可见态 → 有待拍板的变更 = "需要你决定"; 目标已结束则不许抬
 *
 * 测试纪律 (AGENTS.md §5.2.1 + 本轮任务书):
 *   · **期望值从真状态推导**: 真 Goal Store + 真 Run Store (隔离 HOME), 断言读回的是落盘事实
 *     ("Run 记录真的变成 aborted" 而不是"函数返回了 aborted")
 *   · **负控制 (该拒必须真拒)**: agent 提撤销 → 拒绝, 且在跑的 Run **没有被停**;
 *     没注入执行器 → `stopped: false` + 原因, **不许**假装停过
 *   · **变异验证 (按词界改名字)**: 每条主不变量都有一条"把源码改坏 → 判红"的对照 ——
 *     变异用 `replace(正则, 新文本)` 且新文本**不是**原子串的延伸 (否则门没红是变异没生效)
 *   · 变异只在**内存里改文本**喂给纯函数判据, 不落盘改源码: 本仓四阶段并行跑,
 *     改盘上的 `goal-change.ts` 会把别的 worker 正在 import 的模块一起改坏
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as nodeFs from 'node:fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const ROOT = process.cwd();
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const OLD_PERSIST = process.env.BOLLOON_RUN_PERSIST;
let TMP = '';

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-m4-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  if (OLD_PERSIST === undefined) delete process.env.BOLLOON_RUN_PERSIST;
  else process.env.BOLLOON_RUN_PERSIST = OLD_PERSIST;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// 真接线: 接缝的依赖全部指向真实 Store / 真实接线层 (测试里不伪造任何 Goal/Run 事实)
// ─────────────────────────────────────────────────────────────────────────────

interface Harness {
  seam: any;
  gs: any;
  rs: any;
  wiring: any;
  change: any;
  seams: any;
  /** 在跑的 Run 的"历史部分" (不含 status/updatedAt) —— 用来证明历史不被改写 */
  historyOf(runId: string): Promise<string>;
}

async function harness(opts: { withStop?: boolean; withRunningProbe?: boolean } = {}): Promise<Harness> {
  const gs = await import('../agents/goal-store.js');
  const rs = await import('../agents/run-store.js');
  const wiring = await import('../agents/goal-flywheel-wiring.js');
  const change = await import('../agents/goal-flywheel/wiring/change.js');
  const seams = await import('../agents/goal-flywheel/wiring/seams.js');
  const withProbe = opts.withRunningProbe !== false;

  const seam = change.createChangeSeam({
    ingest: (i: any) => wiring.ingestGoalChange({
      goalId: i.goalId,
      instruction: i.instruction,
      source: i.source,
      recordedBy: i.recordedBy,
      now: i.now,
      scopeWorkIds: i.workId ? [i.workId] : undefined,
      home: TMP,
    }).then((out: any) => {
      if (!out) throw new Error(`goal 不存在: ${i.goalId}`);
      return { request: out.request, classification: out.application, application: out.application };
    }),
    nextRunDirective: (goalId: string) => wiring.nextRunChangeDirective(goalId),
    markConsumed: (goalId: string, runIndex: number, now: string) => wiring.markChangesConsumed(goalId, runIndex, now),
    visibleState: (i: any) => wiring.goalVisibleState({ goalId: i.goalId, now: i.now, home: TMP }),
    pending: async (goalId: string) => (await gs.readGoal(goalId))?.goalChanges ?? [],
    // 真事实: 在跑的 Run = goal.currentRunId + 它的 Run 记录状态
    ...(withProbe
      ? {
        runningRun: async (goalId: string) => {
          const g = await gs.readGoal(goalId);
          if (!g?.currentRunId) return null;
          const r = await rs.readRun(g.currentRunId);
          return r ? { runId: r.runId, status: String(r.status) } : null;
        },
      }
      : {}),
    // 真执行器: 既有的外部控制面原语 (与 POST /api/runs/:id/abort 同一条路)
    ...(opts.withStop
      ? {
        stopRunningRun: async (i: any) => {
          const r = await rs.setRunStatus(i.runId, i.runStatus, { error: i.reason });
          return { ok: !!r.ok, reason: r.reason || '' };
        },
      }
      : {}),
  });

  return {
    seam, gs, rs, wiring, change, seams,
    async historyOf(runId: string) {
      const r = await rs.readRun(runId);
      return JSON.stringify({ steps: r.steps, startedAt: r.startedAt, budget: r.budget, recovery: r.recovery, goal: r.goal });
    },
  };
}

/** 真目标 + **真在跑的 Run** (startRun 落盘 + recordStep 真步骤 + attachRun 建 currentRunId 链) */
async function runningGoal(h: Harness, objective: string, criteria: string[] = ['判据0']) {
  const g = await h.gs.createGoal({ objective, successCriteria: criteria, createdBy: 'm4' });
  const rec = await h.rs.startRun({ surface: 'cli', channelId: 'ch-m4', goalId: g.goalId, goal: objective });
  await h.rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '第一步: 产出了 evidence-0.txt' });
  await h.gs.attachRun(g.goalId, rec.runId);
  // 生产形态: 在跑的目标一定有一份 continuation, 且 pendingReports 是数组 (飞轮写 continuation 时总是给全这个字段)
  await h.gs.setContinuation(g.goalId, { pendingReports: [] } as any);
  const after = await h.gs.readGoal(g.goalId);
  expect(after.currentRunId, '前提: currentRunId 已建立 (否则"正在运行的 Goal"这个前提不成立)').toBe(rec.runId);
  expect(await runStatus(h, rec.runId)).toBe('running');
  return { goalId: g.goalId, runId: rec.runId };
}

async function runStatus(h: Harness, runId: string): Promise<string> {
  return String((await h.rs.readRun(runId))?.status);
}

const NOW = '2026-09-25T10:00:00.000Z';
const LATER = '2026-09-25T10:05:00.000Z';

async function ingest(h: Harness, input: Record<string, unknown>) {
  return h.seam.ingestChange({
    goalId: '', instruction: '', source: 'user', recordedBy: 'm4-test', now: NOW, caller: 'human', ...input,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
describe('M4-① 撤销接进正在运行的 Goal: 在跑的 Run 真的停, 历史一字不改', () => {
  it('用户撤销 → Run 记录真变 aborted (落盘事实); Goal → abandoned; 已发生的步骤/预算不被改写', async () => {
    const h = await harness({ withStop: true });
    const { goalId, runId } = await runningGoal(h, '撤销会打断在跑的 Run');
    const historyBefore = await h.historyOf(runId);
    const goalRunsBefore = (await h.gs.readGoal(goalId)).runs.length;

    const view = await ingest(h, { goalId, instruction: '撤销这个目标, 别继续做了', source: 'user' });

    expect(view.plan.kind).toBe('abort');
    expect(view.plan.outcome).toBe('next_run');
    // ★ 判定: 撤销 = 现在停 (其余变更都 let_finish, 见下一条用例)
    expect(view.plan.runBoundary.action).toBe('stop_running_run');
    expect(view.plan.runBoundary.runStatus).toBe('aborted');
    expect(view.plan.runBoundary.runId).toBe(runId);
    expect(view.runBoundary.stopped).toBe(true);
    expect(view.runBoundary.reason).toMatch(/置为 aborted|自行停下/);

    // ★ 真状态: 从 Run Store 读回来 (不是"函数说停了")
    expect(await runStatus(h, runId)).toBe('aborted');
    // 历史部分逐字节不变 (停的是"继续", 不是"历史")
    expect(await h.historyOf(runId)).toBe(historyBefore);
    // Goal 侧: 撤销走 reducer → abandoned + 不许自动继续
    const goal = await h.gs.readGoal(goalId);
    expect(goal.status).toBe('abandoned');
    expect(goal.continuation.autoContinue).toBe(false);
    // 原话逐字入档 (含被撤销这条本身)
    expect(view.instructionVerbatim).toBe('撤销这个目标, 别继续做了');
    expect(goal.goalChanges.at(-1).instruction).toBe('撤销这个目标, 别继续做了');
    expect(goal.goalChanges.at(-1).kind).toBe('abort');
    // 没有因为"撤销"而多出/改写 Run 历史的关联
    expect(goal.runs.length).toBe(goalRunsBefore);
    // 没有待拍板的变更 (撤销是"已排入下一 Run", 不是"等你批") → 可见态是基础态: 已结束
    // (只升不降的另一面: 撤销不该把界面说成"需要你决定")
    expect(view.visibleState).toBe('ended');
    expect(view.visibleReason).toMatch(/不变|已结束/);
  });

  it('负控制: 没注入执行器 → 如实说"没有停" (stopped:false), 且 Run 状态**真的是 running** 没被偷偷改', async () => {
    const h = await harness(); // 不给 stopRunningRun
    const { goalId, runId } = await runningGoal(h, '没接线时不许假装停');

    const view = await ingest(h, { goalId, instruction: '撤销这个目标, 别继续做了', source: 'user' });

    expect(view.plan.runBoundary.action).toBe('stop_running_run'); // 判定照样给出
    expect(view.runBoundary.stopped).toBe(false);                  // 但没执行
    expect(view.runBoundary.reason).toMatch(/没有停|没有注入停 Run 的执行器/);
    expect(await runStatus(h, runId)).toBe('running');             // 真事实: 还在跑
  });

  it('端点按计划补上执行器 (web 入口的做法): 同一条计划当场把真 Run 停下', async () => {
    const h = await harness();
    const { goalId, runId } = await runningGoal(h, '端点补执行器');
    const view = await ingest(h, { goalId, instruction: '撤销这个目标, 别继续做了', source: 'user' });
    expect(view.runBoundary.stopped).toBe(false); // 接缝自己没执行器

    // 入口按 plan 注入既有原语 (等价于 web/server.ts 的 requirement 路由)
    const res = await h.seam.applyRunBoundary({
      plan: view.plan,
      now: LATER,
      stop: async (i: any) => {
        const r = await h.rs.setRunStatus(i.runId, i.runStatus, { error: i.reason });
        return { ok: !!r.ok, reason: r.reason || '' };
      },
    });
    expect(res.stopped).toBe(true);
    expect(await runStatus(h, runId)).toBe('aborted');
  });

  it('负控制 (该拒必须真拒): Agent 提撤销 → 结构化拒绝, 且 Run 没被停、Goal 没被撤销', async () => {
    const h = await harness({ withStop: true });
    const { goalId, runId } = await runningGoal(h, 'Agent 不许替人撤销');

    const view = await ingest(h, { goalId, instruction: '撤销这个目标, 别继续做了', source: 'agent' });

    expect(h.change.isRefusal).toBeUndefined(); // 接缝模块自己不导出拒绝判据 (它在 seams.ts)
    expect(h.change.createChangeSeam).toBeTypeOf('function');
    const refused = await ingest(h, { goalId, instruction: '撤销这个目标, 别继续做了', source: 'agent' });
    expect(h.seams.isRefusal(refused)).toBe(true);
    expect(refused.ok).toBe(false);
    expect(refused.rule).toBe('only_goal_reducer_changes_goal_state');
    expect(refused.reason).toMatch(/只有人能撤销/);
    // 真事实: 什么都没动
    expect(await runStatus(h, runId)).toBe('running');
    expect((await h.gs.readGoal(goalId)).status).toBe('active');
    expect((await h.gs.readGoal(goalId)).goalChanges ?? []).toEqual([]);
  });

  it('负控制 (判据是真分诊, 不是关键词): 换一种说法说撤销, Agent 一样被拒', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '换说法也认得出');
    // 旧实现按关键词子串判 (`includes('撤销')` / `includes('scope_reduction')`), 这句话它放行 ——
    // 但它显然是一句撤销。真分诊 (`detectChangeIntents` → ABORT_PATTERNS) 认得出来。
    const view = await ingest(h, { goalId, instruction: 'cancel the goal', source: 'agent' });
    expect(h.seams.isRefusal(view)).toBe(true);
    expect(view.reason).toMatch(/只有人能撤销/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('M4-② 非撤销变更不打断在跑的 Run (规则 4), 新要求只影响下一个 Run', () => {
  it('用户改优先级 → 在跑的 Run 照跑 (真状态仍 running), 下一 Run 指令含原话', async () => {
    const h = await harness({ withStop: true });
    const { goalId, runId } = await runningGoal(h, '新要求等这一轮跑完');
    const historyBefore = await h.historyOf(runId);

    const text = '先做离线模式, 优先级提前';
    const view = await ingest(h, { goalId, instruction: text, source: 'user' });

    expect(view.plan.kind).toBe('priority_change');
    expect(view.plan.outcome).toBe('next_run');
    expect(view.plan.runBoundary.action).toBe('let_finish');
    expect(view.runBoundary.stopped).toBe(false);
    expect(view.plan.runBoundary.reason).toMatch(/只影响后续 Run|跑完/);
    expect(await runStatus(h, runId)).toBe('running');
    expect(await h.historyOf(runId)).toBe(historyBefore);
    // 下一 Run 真的会读到 (原话逐字 + 不变的历史条款)
    expect(view.plan.nextRunDirective).toContain(text);
    expect(String((await h.gs.readGoal(goalId)).continuation.nextAction)).toContain(text);
    expect(view.plan.appliesToFutureRunsOnly).toBe(true);
    expect((await h.gs.readGoal(goalId)).criteriaVersion ?? 1).toBe(1); // 不改判据就不动版本
  });

  it('用户改完成判据 → 版本 +1 且仍然不打断在跑的 Run (改判据也不许改写已发生的历史)', async () => {
    const h = await harness({ withStop: true });
    const { goalId, runId } = await runningGoal(h, '改判据不打断');

    const view = await ingest(h, { goalId, instruction: '把完成判据改成必须支持离线模式', source: 'user' });

    expect(view.plan.kind).toBe('success_criteria_change');
    expect(view.plan.runBoundary.action).toBe('let_finish');
    expect(view.plan.criteriaVersion).toBe(2);
    expect((await h.gs.readGoal(goalId)).criteriaVersion).toBe(2);
    expect(await runStatus(h, runId)).toBe('running');
    expect(view.plan.nextRunDirective).toMatch(/criteriaVersion 1 → 2|criteriaVersion=v2/);
  });

  it('负控制: Agent 提"扩预算" → 待批准, 不许用"待批准"打断在跑的 Run, 界面抬成"需要你决定"', async () => {
    const h = await harness({ withStop: true });
    const { goalId, runId } = await runningGoal(h, '待批准不许按暂停键');
    const budgetBefore = JSON.stringify((await h.gs.readGoal(goalId)).budget);

    const view = await ingest(h, { goalId, instruction: '把预算上限提高到 999 个 Run', source: 'agent' });

    expect(view.plan.outcome).toBe('pending_approval');
    expect(view.plan.runBoundary.action).toBe('let_finish');
    expect(view.plan.runBoundary.reason).toMatch(/还没生效|不许用它打断/);
    expect(await runStatus(h, runId)).toBe('running');           // 真事实: Agent 按不动暂停键
    const after = await h.gs.readGoal(goalId);
    expect(JSON.stringify(after.budget)).toBe(budgetBefore);     // 预算一个字节没动
    expect(after.criteriaVersion ?? 1).toBe(1);
    // 但人必须知道有东西在等他
    expect(view.visibleState).toBe('needs_your_decision');
    expect(view.visibleReason).toMatch(/等你决定/);
  });

  it('一个 kind 装不下 (原话命中两个意图) → 已入档但不生效, 在跑的 Run 不受影响', async () => {
    const h = await harness({ withStop: true });
    const { goalId, runId } = await runningGoal(h, '歧义变更不生效');

    const view = await ingest(h, {
      goalId,
      instruction: '把工具白名单里加上 shell_exec, 另外预算上限提高到 50',
      source: 'user',
    });

    expect(view.needsDisambiguation).toBe(true);
    expect(view.plan.outcome).toBe('rejected');
    expect(view.plan.nextRunDirective).toMatch(/需拆成多条|未分诊/);
    expect(view.plan.runBoundary.action).toBe('let_finish');
    expect(await runStatus(h, runId)).toBe('running');
    const goal = await h.gs.readGoal(goalId);
    expect(goal.status).toBe('active');                                    // 没被误判成撤销
    expect(goal.continuation?.nextAction ?? '').not.toContain('白名单');    // 没写进下一 Run
    expect(view.plan.steps[3]).toMatch(/未生成/);                           // 流程留痕如实说"没生成摘要"
    expect(view.plan.steps.length).toBe(8);
  });

  it('拿不到"在跑的 Run"事实 → 如实标 factsMissing (不许当成"没有在跑", 也不许瞎停)', async () => {
    // 宿主没注入探针 (生产里 M0 尚未注入 runningRun 时的形态) → 接缝拿不到事实
    const h = await harness({ withStop: true, withRunningProbe: false });
    const { goalId, runId } = await runningGoal(h, '事实缺失要如实说');
    const view = await ingest(h, { goalId, instruction: '先做离线模式, 优先级提前', source: 'user' });
    expect(view.plan.runBoundary.action).toBe('let_finish');
    expect(view.plan.runBoundary.reason).toMatch(/事实/);
    expect(view.plan.runBoundary.factsMissing).toBe(true);

    // 撤销 + 拿不到事实: 也不许凭空停一个"不知道是谁"的 Run (如实说不知道)
    const abortView = await ingest(h, { goalId, instruction: '撤销这个目标, 别继续做了', source: 'user' });
    expect(abortView.plan.runBoundary.action).toBe('let_finish');
    expect(abortView.plan.runBoundary.factsMissing).toBe(true);
    expect(abortView.runBoundary.stopped).toBe(false);
    expect(await runStatus(h, runId)).toBe('running');   // 事实: 没有偷偷停

    // 宿主报了事实就不能说缺失
    const h2 = await harness({ withStop: true });
    const g2 = await runningGoal(h2, '宿主报了事实就不能说缺失');
    const v2 = await h2.seam.ingestChange({
      goalId: g2.goalId, instruction: '先做离线模式, 优先级提前', source: 'user', recordedBy: 'm4', now: NOW, caller: 'human',
      runningRun: { runId: g2.runId, status: 'running' },
    });
    expect(v2.plan.runBoundary.factsMissing).toBe(false);
    // 明确传 null (= 确实没有在跑的 Run) 与 undefined (= 不知道) 必须区分开
    const noRun = await h2.seam.ingestChange({
      goalId: g2.goalId, instruction: '先做离线模式, 优先级提前', source: 'user', recordedBy: 'm4', now: NOW, caller: 'human',
      runningRun: null,
    });
    expect(noRun.plan.runBoundary.factsMissing).toBe(false);
    expect(noRun.plan.runBoundary.reason).toMatch(/没有在跑的 Run/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('M4-③ 规则 5: 在跑的子 Agent 必须先拿到变更版本', () => {
  it('两个在跑的子 Agent → 逐 workId 一份下发内容, 都要求先 ack', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '子 Agent 要收到版本');
    await h.gs.setContinuation(goalId, {
      pendingReports: [
        { workId: 'w-1', childAgentId: 'agent-a', capability: 'cap-a', requestedAt: NOW, deadlineAt: null, lastHeartbeatAt: NOW },
        { workId: 'w-2', childAgentId: 'agent-b', capability: 'cap-b', requestedAt: NOW, deadlineAt: null, lastHeartbeatAt: NOW },
      ] as any,
    });

    const view = await ingest(h, { goalId, instruction: '先做离线模式, 优先级提前', source: 'user', liveWorkIds: ['w-1', 'w-2'] });

    expect(view.childDelivery.directives.length).toBe(2);
    expect(view.childDelivery.workIds).toEqual(['w-1', 'w-2']);
    expect(view.childDelivery.mustAck).toBe(true);
    for (const d of view.childDelivery.directives) {
      expect(d.workIds.length).toBe(1);                       // 逐个下发, 不搞集体背书
      expect(d.criteriaVersion).toBe(view.plan.criteriaVersion);
      expect(d.mustAckBeforeNextStep).toBe(true);
      expect(d.rewritesHistory).toBe(false);
      expect(d.directive).toMatch(/必须先确认收到|未确认前不得按旧版本继续/);
      expect(d.directive).toContain(d.workIds[0]);
    }
    expect(new Set(view.childDelivery.directives.flatMap((d: any) => d.workIds)).size).toBe(2);
    // 变更记录里没点明影响面 → 如实标"下发前必须补全", 不许静默漏发
    expect(view.childDelivery.scopeMissing).toBe(true);
    expect(view.childDelivery.blocked).toBe(true);
    expect(view.childDelivery.note).toMatch(/补全影响面|scopeChangeToWork/);
  });

  it('没有在跑的子 Agent → 不下发 (不编受众), 子 Agent 条款仍在下一 Run 指令里', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '没有子 Agent');
    const view = await ingest(h, { goalId, instruction: '先做离线模式, 优先级提前', source: 'user', liveWorkIds: [] });
    expect(view.childDelivery.directives).toEqual([]);
    expect(view.childDelivery.scopeMissing).toBe(false);
    expect(view.childDelivery.blocked).toBe(false);
    expect(view.childDelivery.note).toMatch(/没有在跑的子 Agent/);
    expect(view.plan.nextRunDirective).toMatch(/无受影响子 Agent|affectedWorkIds 为空/);
  });

  it('撤销类下发给子 Agent 的动词语义不同 (停止并按 cancelPolicy 收尾, 不是"继续下一步")', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '撤销下发语义');
    const view = await ingest(h, {
      goalId, instruction: '撤销这个目标, 别继续做了', source: 'user', liveWorkIds: ['w-9'],
    });
    expect(view.childDelivery.directives[0].directive).toMatch(/停止并按父的 cancelPolicy 收尾/);
    expect(view.childDelivery.directives[0].directive).toContain('w-9');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('M4-④ 用户可见态: 只升不降', () => {
  it('有待拍板的变更 → 需要你决定 (覆盖 正在执行/等外部/子被阻塞 等一切非终态)', async () => {
    const { changeVisibleState } = (await harness()).change;
    const pending = [{ changeId: 'chg_1', kind: 'permission_change', status: 'needs_approval' }];
    for (const base of ['executing', 'waiting_external_reply', 'child_blocked', 'no_progress'] as const) {
      const out = changeVisibleState({ base, changes: pending });
      expect(out.state, `base=${base} 时被待批准的变更挡住了视线`).toBe('needs_your_decision');
      expect(out.elevated).toBe(true);
      expect(out.reason).toContain('chg_1');
    }
  });

  it('负控制: 没有待拍板的变更 → 原样返回 (不无中生有); 已结束 → 不许抬起来', async () => {
    const { changeVisibleState } = (await harness()).change;
    expect(changeVisibleState({ base: 'executing', changes: [{ changeId: 'c', kind: 'clarification', status: 'scheduled_next_run' }] }))
      .toEqual({ state: 'executing', elevated: false, reason: '没有等拍板的变更 → 用户可见态不变' });
    expect(changeVisibleState({ base: 'executing', changes: [] }).state).toBe('executing');
    const ended = changeVisibleState({ base: 'ended', changes: [{ changeId: 'c', kind: 'budget_change', status: 'needs_approval' }] });
    expect(ended.state).toBe('ended');
    expect(ended.elevated).toBe(false);
    expect(ended.reason).toMatch(/已结束/);
    // 本来就要求你决定 → 不假装"是我抬起来的"
    expect(changeVisibleState({ base: 'needs_your_decision', changes: [{ changeId: 'c', kind: 'abort', status: 'triaged' }] }).elevated).toBe(false);
  });

  it('接缝的 visibleState() 与入档结论共用同一份判据 (待批准时是 needs_your_decision)', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '接缝读出来的可见态');
    expect(await h.seam.visibleState({ goalId })).toBe('executing');
    const view = await ingest(h, { goalId, instruction: '把预算上限提高到 999 个 Run', source: 'agent' });
    expect(view.plan.outcome).toBe('pending_approval');
    expect(await h.seam.visibleState({ goalId })).toBe('needs_your_decision');
    expect(view.visibleState).toBe(await h.seam.visibleState({ goalId })); // 两条读法必须一致
  });

  it('可见态的**基础态读不到**时不许编: 入档照样成功, 视图如实说"读不到" (不许报成失败/不许说成"正在执行")', async () => {
    const h = await harness({ withStop: true });
    const g = await h.gs.createGoal({ objective: '基础态读不到', successCriteria: ['判据0'], createdBy: 'm4' });
    const rec = await h.rs.startRun({ surface: 'cli', channelId: 'ch-m4', goalId: g.goalId, goal: g.objective });
    await h.rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '第一步' });
    await h.gs.attachRun(g.goalId, rec.runId);
    // 造出"基础态读不到"的真实触发条件: `setContinuation` 是**部分覆盖** —— 第 5 步写下的
    // continuation 里没有 pendingReports, 而 `toUserVisibleState` 把该字段当必存 → 读基础态抛错。
    // 这是上游的既有缺口 (已报主线); 本接缝必须扛住: 不许让"读一个展示态失败"把**已经生效的变更**
    // 报成失败 (人会以为没提上去而重提一遍 = 重复变更)。
    await h.gs.setContinuation(g.goalId, { nextAction: '原始 continuation (缺 pendingReports)' } as any);
    const goalId = g.goalId;
    const runId = rec.runId;

    const view = await ingest(h, { goalId, instruction: '先做离线模式, 优先级提前', source: 'user' });

    expect(h.seams.isRefusal(view)).toBe(false);
    expect(view.plan.outcome).toBe('next_run');                        // 变更真的生效了 (入档没被展示态拖垮)
    expect(view.plan.runBoundary.action).toBe('let_finish');
    expect(view.plan.runBoundary.factsMissing).toBe(false);            // 事实是宿主读出来的, 不缺失
    expect(view.visibleReason).toMatch(/读不到|没有等拍板|不变/);
    expect(['executing', null]).toContain(view.visibleState);           // 不编一个态, 也不崩
    expect(await runStatus(h, runId)).toBe('running');
    expect((await h.gs.readGoal(goalId)).goalChanges.at(-1).instruction).toBe('先做离线模式, 优先级提前');
    // 有人必须拍板时, 无论基础态读不读得到, 都必须是"需要你决定"
    const wide = await ingest(h, { goalId, instruction: '把预算上限提高到 999 个 Run', source: 'agent' });
    expect(wide.plan.outcome).toBe('pending_approval');
    expect(wide.visibleState).toBe('needs_your_decision');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('M4-⑤ 记账与接口自洽', () => {
  it('markConsumed 只接受真实存在的 Run 序号 (记账不许记在不存在的序号上)', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '记账纪律');
    await expect(h.seam.markConsumed(goalId, -1, NOW)).rejects.toThrow(/runIndex 必须是 >=0 的整数/);
    await expect(h.seam.markConsumed(goalId, 1.5, NOW)).rejects.toThrow(/runIndex/);
    await expect(h.seam.markConsumed(goalId, 0, NOW)).resolves.toBeUndefined();
  });

  it('接缝的 id/stage 与名册一致 (M4 独占这条接缝)', async () => {
    const h = await harness();
    const seams = await import('../agents/goal-flywheel/wiring/seams.js');
    expect(h.seam.id).toBe('change');
    expect(h.seam.stage).toBe('M4');
    expect(seams.seamOf('change').stage).toBe('M4');
    expect(seams.seamOf('change').module).toBe('change.ts');
  });

  it('空原话 → 拒绝 (一句"理解"不能代替人说过的话)', async () => {
    const h = await harness({ withStop: true });
    const { goalId } = await runningGoal(h, '空原话');
    const view = await ingest(h, { goalId, instruction: '   ', source: 'user' });
    expect(h.seams.isRefusal(view)).toBe(true);
    expect(view.reason).toMatch(/没有原文/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §M4-⑥ 源码级不变量 + **变异验证** (内存里改坏 → 必须判红)
// ═════════════════════════════════════════════════════════════════════════════

interface SrcFile { path: string; text: string }
interface SrcViolation { invariant: string; path: string; reason: string }

function readSrc(rel: string): SrcFile {
  // 真读盘: 读不到就抛 (门不许空转 —— 拿不到源码等于这道门什么都没验)
  return { path: rel, text: nodeFs.readFileSync(path.join(ROOT, rel), 'utf8') };
}

const SEAM_SRC = readSrc('src/agents/goal-flywheel/wiring/change.ts');
const CHANGE_SRC = readSrc('src/agents/goal-flywheel/goal-change.ts');
const SERVER_SRC = readSrc('src/web/server.ts');

/** requirement 路由的函数体 (从路由声明到下一个路由声明) */
function requirementRouteBody(text: string): string {
  const start = text.indexOf("app.post('/api/goals/:goalId/requirement'");
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.search(/\n\s{2}app\.(get|post|put|delete)\(/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 其它阶段的实现文件 / M0 骨架 —— 这条接缝一个都不许碰 (接了就是第二套事实) */
const FOREIGN_MODULES = [
  'work-monitor', 'work-contract', 'run-closure', 'continuation-decision', 'memory-layers',
  'skill-candidate', 'execution-supervisor', 'goal-flywheel-wiring', 'run-store', 'goal-store',
  'subagent-manager', 'skills-manager',
];

const IO_TOKENS = ['node:fs', "from 'fs'", 'Date.now', 'new Date(', 'Math.random', 'process.env'];

/**
 * 纯函数判据: 吃源码文本, 吐违规清单。
 * 为什么是纯函数: 变异验证要把**人为改坏的文本**喂给同一份判据 —— 于是"这道门真的抓得到"
 * 变成每次跑测试都在验的事, 而不是我口头声明 (与 M0 的 seams.ts 同一手法)。
 */
function scanChangeInjection(src: { seam: SrcFile; change: SrcFile; server: SrcFile }): SrcViolation[] {
  const out: SrcViolation[] = [];
  const push = (invariant: string, path: string, reason: string) => out.push({ invariant, path, reason });

  // A. 接缝必须真的用上四个 M4 元件 (少了就是没接)
  for (const [sym, why] of [
    ['applyRunBoundary', '在跑 Run 的边界动作没有执行口'],
    ['planChangeInjection', '没有把变更接到"正在跑的 Goal"上 (计划未由纯函数给出)'],
    ['userOnlyChangeKind', '撤销类变更的判据没走真实分诊'],
    ['changeVisibleState', '变更驱动的用户可见态没接线'],
  ] as const) {
    if (!new RegExp(`(?<![A-Za-z0-9_])${sym}\\s*[(<]`).test(src.seam.text)) {
      push('seam_uses_m4_parts', src.seam.path, `接缝里找不到 ${sym} (${why})`);
    }
  }

  // B. 接缝自己不读盘/不读钟/不读 env (事实一律由宿主注入)
  for (const tok of IO_TOKENS) {
    if (src.seam.text.includes(tok)) push('seam_no_io', src.seam.path, `接缝出现了 ${tok} (事实/时间必须由宿主注入)`);
  }
  // C. 接缝不许 import 别的阶段/骨架
  for (const mod of FOREIGN_MODULES) {
    if (src.seam.text.includes(mod)) push('seam_no_foreign_module', src.seam.path, `接了 ${mod} (别人的责任面)`);
  }

  // D. 撤销分支必须给出"停" (判定与状态名都要在)
  if (!/r\.kind === 'abort'[\s\S]{0,400}?action: 'stop_running_run'/.test(src.change.text)) {
    push('abort_stops_running_run', src.change.path, '撤销分支没有给出 stop_running_run —— 撤销落不到在跑的 Run 上');
  }
  if (!/action: 'stop_running_run'[\s\S]{0,200}?runStatus: 'aborted'/.test(src.change.text)) {
    push('abort_writes_aborted', src.change.path, '撤销分支没有写 aborted (执行器读不到就停不下来)');
  }
  // E. "拿不到事实不许当成没有在跑" 必须由 runningRun === undefined 推导
  if (!/const factsMissing = input\.runningRun === undefined;/.test(src.change.text)) {
    push('facts_missing_is_explicit', src.change.path, 'factsMissing 不再由 runningRun === undefined 推导 (会把"不知道"当成"没有在跑")');
  }
  // F. 在跑的 Run 状态集合必须含 running/recovering
  for (const st of ['running', 'recovering']) {
    if (!new RegExp(`IN_FLIGHT_RUN_STATUSES = \\[[^\\]]*'${st}'`).test(src.change.text)) {
      push('in_flight_statuses', src.change.path, `在跑的 Run 状态集合少了 ${st}`);
    }
  }
  // G. 待拍板状态必须含 needs_approval (漏了它 = 界面永远显示"正在执行")
  if (!/DECISION_PENDING_STATUSES = \['needs_approval', 'triaged'\]/.test(src.seam.text)) {
    push('pending_needs_approval', src.seam.path, 'DECISION_PENDING_STATUSES 少了 needs_approval → 待批准的新要求不会让界面说"需要你决定"');
  }

  // H. web 入口必须走接缝 (不再绕过它直调入档函数), 且必须喂进真事实
  const route = requirementRouteBody(src.server.text);
  if (!route) push('route_exists', src.server.path, "找不到 POST /api/goals/:goalId/requirement 路由");
  else {
    if (!route.includes('flywheelSeams().change')) push('route_uses_seam', src.server.path, 'requirement 路由没有走 change 接缝');
    if (!route.includes('applyRunBoundary(')) push('route_applies_boundary', src.server.path, 'requirement 路由没有按计划执行在跑 Run 的边界动作');
    if (!/runningRun:/.test(route)) push('route_passes_running_fact', src.server.path, 'requirement 路由没有把"在跑的 Run"事实注入接缝');
    if (!/liveWorkIds[,\s]/.test(route)) push('route_passes_live_children', src.server.path, 'requirement 路由没有把在跑的子 Agent 注入接缝 (规则 5 会漏发)');
    if (route.includes('ingestGoalChange(')) push('route_no_bypass', src.server.path, 'requirement 路由绕过了接缝直调入档函数 (两条链 = 两套事实)');
  }
  // I. 列表界面的用户可见态必须过变更覆盖
  if (!/changeVisibleState\(\{ base, changes: g\.goalChanges \?\? \[\] \}\)/.test(src.server.text)) {
    push('goals_list_uses_override', src.server.path, '/api/goals 的可见态没有过变更覆盖 (待批准的目标会显示成"正在执行")');
  }
  return out;
}

const CLEAN = { seam: SEAM_SRC, change: CHANGE_SRC, server: SERVER_SRC };

/** 变异: 只改内存文本; 改不动就抛 (变异失效 = 阴性对照失效, 这正是今天踩过的坑) */
function mutate(f: SrcFile, from: RegExp, to: string): SrcFile {
  const next = f.text.replace(from, to);
  if (next === f.text) throw new Error(`变异没生效: ${f.path} 里找不到 ${String(from)}`);
  return { path: f.path, text: next };
}

describe('M4-⑥ 源码级不变量 (干净树全绿 + 变异必须判红)', () => {
  it('干净树上 M4 的九条不变量全绿', () => {
    expect(scanChangeInjection(CLEAN)).toEqual([]);
    // 门不空转: 每条判据依赖的锚点都真的在源码里
    expect(requirementRouteBody(SERVER_SRC.text).length).toBeGreaterThan(200);
    expect(SEAM_SRC.text.length).toBeGreaterThan(2000);
  });

  it('★ 变异 1: 撤销分支改成 let_finish → 判红 (abort_stops_running_run)', () => {
    const v = scanChangeInjection({
      ...CLEAN,
      change: mutate(CHANGE_SRC, /action: 'stop_running_run',\n      runStatus: 'aborted',/, "action: 'let_finish',\n      runStatus: null,"),
    });
    expect(v.map((x) => x.invariant)).toContain('abort_stops_running_run');
    expect(v.find((x) => x.invariant === 'abort_stops_running_run')!.reason).toMatch(/撤销分支/);
  });

  it('★ 变异 2: 撤销分支不写 aborted (写 paused) → 判红 (abort_writes_aborted)', () => {
    const v = scanChangeInjection({
      ...CLEAN,
      change: mutate(CHANGE_SRC, /runStatus: 'aborted',\n      runId: run!\.runId/, "runStatus: 'paused',\n      runId: run!.runId"),
    });
    expect(v.map((x) => x.invariant)).toContain('abort_writes_aborted');
  });

  it('★ 变异 3: factsMissing 恒为 false (= 把"不知道"当成"没有在跑") → 判红', () => {
    const v = scanChangeInjection({
      ...CLEAN,
      change: mutate(CHANGE_SRC, /const factsMissing = input\.runningRun === undefined;/, 'const factsMissing = false;'),
    });
    expect(v.map((x) => x.invariant)).toContain('facts_missing_is_explicit');
  });

  it('★ 变异 4: 在跑的 Run 状态集合去掉 running → 判红 (in_flight_statuses)', () => {
    const v = scanChangeInjection({
      ...CLEAN,
      change: mutate(CHANGE_SRC, /IN_FLIGHT_RUN_STATUSES = \['queued', 'running', 'recovering'\]/, "IN_FLIGHT_RUN_STATUSES = ['queued', 'recovering']"),
    });
    expect(v.map((x) => x.invariant)).toContain('in_flight_statuses');
  });

  it('★ 变异 5: 撤销判据退回关键词子串 (不用真实分诊) → 判红 (seam_uses_m4_parts)', () => {
    const v = scanChangeInjection({
      ...CLEAN,
      seam: mutate(SEAM_SRC, /userOnlyChangeKind\(raw\)/, 'legacyKeywordGuess(raw)'),
    });
    expect(v.map((x) => x.invariant)).toContain('seam_uses_m4_parts');
  });

  it('★ 变异 6: 待拍板状态集合漏掉 needs_approval → 判红 (pending_needs_approval)', () => {
    const v = scanChangeInjection({
      ...CLEAN,
      seam: mutate(SEAM_SRC, /DECISION_PENDING_STATUSES = \['needs_approval', 'triaged'\]/, "DECISION_PENDING_STATUSES = ['scheduled_next_run', 'applied']"),
    });
    expect(v.map((x) => x.invariant)).toContain('pending_needs_approval');
  });

  it('★ 变异 7: 接缝里塞进 I/O + 别人的模块 → 判红 (seam_no_io / seam_no_foreign_module)', () => {
    const withFs = mutate(SEAM_SRC, /import \{ refuse, type SeamRefusal, type WiringCaller \} from '\.\/seams\.js';/, "import nodefs from 'node:fs';\nimport { refuse, type SeamRefusal, type WiringCaller } from './seams.js';");
    expect(scanChangeInjection({ ...CLEAN, seam: withFs }).map((x) => x.invariant)).toContain('seam_no_io');
    const withForeign = mutate(SEAM_SRC, /import \{ refuse, type SeamRefusal, type WiringCaller \} from '\.\/seams\.js';/, "import { collectWorkBlocks } from '../work-monitor.js';\nimport { refuse, type SeamRefusal, type WiringCaller } from './seams.js';");
    expect(scanChangeInjection({ ...CLEAN, seam: withForeign }).map((x) => x.invariant)).toContain('seam_no_foreign_module');
  });

  it('★ 变异 8: web 入口绕过接缝直调入档函数 / 不喂事实 → 判红 (route_no_bypass / route_passes_running_fact)', () => {
    const bypass = mutate(SERVER_SRC, /const seam = flywheelSeams\(\)\.change;/, "const seam = flywheelSeams().change;\n      const legacyOut = await ingestGoalChange({ goalId, instruction: text });");
    const vb = scanChangeInjection({ ...CLEAN, server: bypass }).map((x) => x.invariant);
    expect(vb).toContain('route_no_bypass');
    const noFact = mutate(SERVER_SRC, /runningRun: runRec \? \{ runId: runRec\.runId, status: String\(runRec\.status\) \} : null,/, 'runFactsOmitted: true,');
    const vf = scanChangeInjection({ ...CLEAN, server: noFact }).map((x) => x.invariant);
    expect(vf).toContain('route_passes_running_fact');
  });

  it('★ 变异 9: 列表界面不再过变更覆盖 → 判红 (goals_list_uses_override); 换掉接缝实现 → 判红 (route_uses_seam)', () => {
    const listNoOverride = mutate(SERVER_SRC, /return changeVisibleState\(\{ base, changes: g\.goalChanges \?\? \[\] \}\)\.state \?\? base;/, 'return base;');
    expect(scanChangeInjection({ ...CLEAN, server: listNoOverride }).map((x) => x.invariant)).toContain('goals_list_uses_override');
    const wrongSeam = mutate(SERVER_SRC, /flywheelSeams\(\)\.change;/, 'flywheelSeams().closure;');
    expect(scanChangeInjection({ ...CLEAN, server: wrongSeam }).map((x) => x.invariant)).toContain('route_uses_seam');
  });

  it('变异器自身不空转: 改不动的变异必须抛错 (变异失效 = 阴性对照失效)', () => {
    expect(() => mutate(SEAM_SRC, /这串字在源码里一定找不到/, 'x')).toThrow(/变异没生效/);
  });
});
