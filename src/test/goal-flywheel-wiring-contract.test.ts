/**
 * M3 接缝 ③ (contract) 验收 —— 「派前必须有工作合同」是不是代码里绕不过去 (2026-09-25)
 *
 * 这一份只回答一个问题: **合同门是真的, 还是文档里的一句话**。
 * 手法 (与 M0 freeze 门同一套纪律):
 *   · **真跑**: 真 Goal Store (隔离 HOME) + 真的把合同/心跳写到盘上 + 真子 Agent 派遣路径
 *     (`SubAgentManager.delegateTask`), 不是 mock 出来的"合同对象";
 *   · **期望值从真状态推导**: 合同文件、`pendingReports`、任务状态都从盘上/Store 读回来比对;
 *   · **负控制 (该拒必须真拒)**: 签不出合同 / 没有派遣面 / 端口说没派出去 / 子 Agent 想派活 ——
 *     逐条必须真拒, 且**派遣端口零调用** (用调用计数器证明, 不是看返回值猜);
 *   · **变异验证**: 把真源码里的关键判据**按词界改名**拿掉 → 源码级判据必须判红; 恢复 → 全绿。
 *     (子串替换会假绿 —— 这个坑本仓踩过, 所以变异一律整词改名。)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { AgentWorkContract, AgentWorkReport } from '../agents/goal-flywheel/types.js';
import type { ContractIssueInput } from '../agents/goal-flywheel/wiring/contract.js';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-m3-contract-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    wiring: await import('../agents/goal-flywheel-wiring.js'),
    seam: await import('../agents/goal-flywheel/wiring/contract.js'),
    wc: await import('../agents/goal-flywheel/work-contract.js'),
  };
}

const NOW = '2026-09-25T10:00:00.000Z';
const LATER = '2026-09-25T11:00:00.000Z';

/** 真落盘: `<home>/.bolloon/goal-works/<goalId>/<workId>.json` (与接线层同一布局, 但不是它的代码) */
function worksDir(goalId: string): string {
  return path.join(TMP, '.bolloon', 'goal-works', goalId);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function listDir(p: string): Promise<string[]> {
  try { return await fs.readdir(p); } catch { return []; }
}

interface DispatchSpy {
  calls: { workId: string; childAgentId: string; caller: string }[];
  port: (input: { contract: AgentWorkContract; caller: string; now: string }) => Promise<{ dispatched: boolean; detail: string; receipt?: string | null }>;
}

function spyPort(result: { dispatched: boolean; detail: string; receipt?: string | null } | 'throw'): DispatchSpy {
  const calls: DispatchSpy['calls'] = [];
  return {
    calls,
    port: async (input: { contract: AgentWorkContract; caller: string; now: string }) => {
      calls.push({ workId: input.contract.workId, childAgentId: input.contract.childAgentId, caller: input.caller });
      if (result === 'throw') throw new Error('派不出去: 传输层断了 (ECONNRESET)');
      return result;
    },
  };
}

function baseIssue(over: Partial<ContractIssueInput> = {}): ContractIssueInput {
  return {
    goalId: 'g-m3',
    parentRunId: 'run-parent-1',
    childAgentId: 'child-node-1',
    capability: 'collect_data',
    objective: '收集 3 条数据',
    inputs: { q: 'x' },
    allowedTools: ['read_file'],
    budget: { maxSteps: 5, maxDurationMs: 300_000, maxAmount: null, currency: null },
    deadline: null,
    successCriteria: ['有 3 条数据'],
    now: NOW,
    issuedBy: 'test',
    ...over,
  };
}

function goodReport(c: AgentWorkContract, over: Partial<AgentWorkReport> = {}): AgentWorkReport {
  return {
    workId: c.workId,
    childAgentId: c.childAgentId,
    status: 'completed',
    summary: '产出 /tmp/data.json (3 条记录)',
    evidence: c.requiredEvidence.map((r) => ({ kind: r, ref: '/tmp/data.json', note: '真实产物' })),
    artifacts: [],
    checks: c.successCriteria.map((s) => ({ name: `criterion:${s}`, verdict: 'pass' as const, detail: '读到 3 条记录' })),
    unresolvedItems: [],
    blockReason: null,
    nextRecommendation: '交给父汇总',
    durationMs: 1000,
    reportedAt: LATER,
    ...over,
  } as AgentWorkReport;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('M3-contract ① 真跑: 签合同 → 落盘 → 真派遣 → 真核验 (真 Store + 隔离 HOME)', () => {
  it('合同真写进盘, 派遣真被调用; 漂亮但无证据的回报真被拒, 补齐证据才接受', async () => {
    const { gs, seam, wiring } = await mods();
    const goal = await gs.createGoal({ objective: '父目标: 收数据', successCriteria: ['有 3 条数据'], createdBy: 'm3-test' });
    const spy = spyPort({ dispatched: true, detail: '交给 agent:child-node-1', receipt: 'task-1' });
    const s = seam.createContractSeamFromLogic({
      persistContract: async (c) => {
        await fs.mkdir(worksDir(c.goalId), { recursive: true });
        await fs.writeFile(path.join(worksDir(c.goalId), `${c.workId}.json`), JSON.stringify(c, null, 2));
      },
      loadContract: async ({ goalId, workId }) => {
        try { return JSON.parse(await fs.readFile(path.join(worksDir(goalId), `${workId}.json`), 'utf8')) as AgentWorkContract; }
        catch { return null; }
      },
      dispatch: spy.port as never,
    });

    const out = await s.dispatchWorker({ ...baseIssue({ goalId: goal.goalId, childAgentId: 'child-node-1' }), caller: 'supervisor' });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    // 期望值从真实状态推导: 盘上真有一份合同, 且内容就是签发的那份
    const file = path.join(worksDir(goal.goalId), `${out.contract.workId}.json`);
    expect(await exists(file)).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as AgentWorkContract;
    expect(onDisk.workId).toBe(out.contract.workId);
    expect(onDisk.successCriteria).toEqual(['有 3 条数据']);
    expect(onDisk.reportSchema).toBe('bolloon-work-report/1');
    // 派遣真被调了一次, 带的是那份合同
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0].workId).toBe(out.contract.workId);
    expect(out.receipt).toBe('task-1');

    // ① 漂亮但没有逐条证据 → 不接受为完成
    const beautiful = goodReport(out.contract, { evidence: [], checks: [{ name: '自检', verdict: 'pass', detail: '看着没问题' }] });
    const v1 = await s.acceptReport({ goalId: goal.goalId, workId: out.contract.workId, report: beautiful, caller: 'supervisor' });
    expect(wiring.isRefusal(v1)).toBe(false);
    const ver1 = v1 as seam.ReportVerdict;
    expect(ver1.accepted).toBe(false);
    expect(ver1.outcome).toBe('incomplete');
    expect(ver1.missingEvidence.length).toBeGreaterThan(0);
    expect(ver1.missingEvidence.every((m) => m.startsWith('criterion:'))).toBe(true);

    // ② 按合同协议补齐 → 接受, 且判定与**真 P2** 一致 (口径一份)
    const good = goodReport(out.contract);
    const v2 = await s.acceptReport({ goalId: goal.goalId, workId: out.contract.workId, report: good, caller: 'supervisor' });
    expect((v2 as seam.ReportVerdict).accepted).toBe(true);
    expect(v2).toEqual(seam.realReportVerdict(out.contract, good));
  });

  it('没有这个 workId 的合同 → no_contract: 没有合同的回报不核验也不接受', async () => {
    const { seam } = await mods();
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => {},
      loadContract: async () => null,
    });
    const v = await s.acceptReport({ goalId: 'g-x', workId: 'work-missing', report: {} as never, caller: 'supervisor' });
    expect((v as { outcome: string }).outcome).toBe('no_contract');
    expect((v as { accepted: boolean }).accepted).toBe(false);
  });
});

describe('M3-contract ② 派前必须有合同: 签不出 → 不派 (派遣端口零调用)', () => {
  it('没有成功判据 → 拒派, 端口零调用, 盘上零文件', async () => {
    const { seam } = await mods();
    const spy = spyPort({ dispatched: true, detail: '不该被调到' });
    let persisted = 0;
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => { persisted++; },
      loadContract: async () => null,
      dispatch: spy.port as never,
    });
    const out = await s.dispatchWorker({ ...baseIssue({ successCriteria: [] }), caller: 'supervisor' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('no_criteria');
    expect(out.reason).toContain('成功判据');
    expect(spy.calls.length).toBe(0);   // ★ 关键: 一次都没派
    expect(persisted).toBe(0);
    expect(out.detail).toContain('零调用');
  });

  it('合同不合法 (deadline 早于 now) → 拒派, 端口零调用, 原因带结构化 issues', async () => {
    const { seam } = await mods();
    const spy = spyPort({ dispatched: true, detail: '不该被调到' });
    let persisted = 0;
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => { persisted++; },
      loadContract: async () => null,
      dispatch: spy.port as never,
    });
    const out = await s.dispatchWorker({ ...baseIssue({ deadline: '2026-09-25T09:00:00.000Z' }), caller: 'supervisor' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('contract_invalid');
    expect(out.reason).toContain('deadline 早于签发时间');
    expect(spy.calls.length).toBe(0);
    expect(persisted).toBe(0);
  });

  it('金额有值但没币种 → 同样拒派 (无法核验的预算不许签)', async () => {
    const { seam } = await mods();
    const spy = spyPort({ dispatched: true, detail: '不该被调到' });
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => {},
      loadContract: async () => null,
      dispatch: spy.port as never,
    });
    const out = await s.dispatchWorker({
      ...baseIssue({ budget: { maxSteps: null, maxDurationMs: null, maxAmount: 10, currency: null } }),
      caller: 'supervisor',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('contract_invalid');
    expect(out.reason).toContain('currency');
    expect(spy.calls.length).toBe(0);
  });

  it('没有注入派遣面 → 拒 (拿不到"真派出去了"的事实, 不许把签发放当已派遣)', async () => {
    const { seam } = await mods();
    let persisted = 0;
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => { persisted++; },
      loadContract: async () => null,
      // 刻意不给 dispatch
    });
    const out = await s.dispatchWorker({ ...baseIssue(), caller: 'supervisor' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('no_dispatch_port');
    expect(out.detail).toContain('零调用');
    expect(persisted).toBe(0);   // 没有派遣面就连合同都不落盘 (不许留半截事实)
  });
});

describe('M3-contract ③ 派遣端口如实回"没派出去" / 抛错 → 不许谎报成功', () => {
  it('dispatched=false → ok=false + dispatch_failed, 但合同事实带回来 (父能决定重派)', async () => {
    const { seam } = await mods();
    const spy = spyPort({ dispatched: false, detail: '目标执行者已下线' });
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => {},
      loadContract: async () => null,
      dispatch: spy.port as never,
    });
    const out = await s.dispatchWorker({ ...baseIssue(), caller: 'supervisor' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('dispatch_failed');
    expect(out.reason).toContain('目标执行者已下线');
    expect(out.contract).not.toBeNull();          // 合同是真签了的 (事实)
    expect(spy.calls.length).toBe(1);
  });

  it('端口抛错 → ok=false + 原文进 reason (不吞)', async () => {
    const { seam } = await mods();
    const spy = spyPort('throw');
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => {},
      loadContract: async () => null,
      dispatch: spy.port as never,
    });
    const out = await s.dispatchWorker({ ...baseIssue(), caller: 'supervisor' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('dispatch_failed');
    expect(out.reason).toContain('ECONNRESET');
  });
});

describe('M3-contract ④ 规则⑤: 子 Agent 不许派生 (真拒 + 端口零调用)', () => {
  it('caller=child_agent → 拒派, 且带上冻结规则 ⑤ (不编规则号)', async () => {
    const { seam } = await mods();
    const spy = spyPort({ dispatched: true, detail: '不该被调到' });
    const s = seam.createContractSeamFromLogic({
      persistContract: async () => {},
      loadContract: async () => null,
      dispatch: spy.port as never,
    });
    const out = await s.dispatchWorker({ ...baseIssue(), caller: 'child_agent' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('caller_not_allowed');
    expect(out.refusal).not.toBeNull();
    expect(out.refusal!.rule).toBe('child_cannot_mutate_goal');
    expect(spy.calls.length).toBe(0);
    // 负控制: 同一份输入换成父/调度器 → 真派出去 (门不是永远判红)
    const ok = await s.dispatchWorker({ ...baseIssue({ objective: '收集 4 条数据' }), caller: 'supervisor' });
    expect(ok.ok).toBe(true);
    expect(spy.calls.length).toBe(1);
  });

  it('issueWork / acceptReport 的旧拒绝语义不变 (没有判据 / 没有 workId 都真拒)', async () => {
    const { seam, wiring } = await mods();
    const s = seam.createContractSeamFromLogic({ persistContract: async () => {}, loadContract: async () => null });
    const r1 = await s.issueWork({ ...baseIssue({ successCriteria: [] }), caller: 'supervisor' });
    expect(wiring.isRefusal(r1)).toBe(true);
    const r2 = await s.acceptReport({ goalId: 'g', workId: '', report: {} as never, caller: 'supervisor' });
    expect(wiring.isRefusal(r2)).toBe(true);
    expect((r2 as { rule: string }).rule).toBe('child_cannot_mutate_goal');
  });
});

describe('M3-contract ⑤ 换人必须重签合同 (合同把执行者钉死了)', () => {
  it('childMatchesContract: 同人 ok / 换人拒 / 空 id 拒 (理由带 workId 与两个 id)', async () => {
    const { seam } = await mods();
    const contract = seam.realIssueContract(baseIssue({ childAgentId: 'child-node-1' }));
    expect(seam.childMatchesContract(contract, 'child-node-1').ok).toBe(true);
    const other = seam.childMatchesContract(contract, 'child-node-2');
    expect(other.ok).toBe(false);
    expect(other.reason).toContain(contract.workId);
    expect(other.reason).toContain('child-node-1');
    expect(other.reason).toContain('child-node-2');
    expect(other.reason).toContain('重签');
    expect(seam.childMatchesContract(contract, '   ').ok).toBe(false);
  });

  it('真跑: 有合同的任务换人 → 拒绝且指派关系不变; 换成原执行者 → 放行', async () => {
    const { gs } = await mods();
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const goal = await gs.createGoal({ objective: '父目标: 换人测试', successCriteria: ['有产出'], createdBy: 'm3-test' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      const a1 = await mgr.registerAgent({ name: 'A1', capabilities: ['collect_data'] } as never);
      const a2 = await mgr.registerAgent({ name: 'A2', capabilities: ['collect_data'] } as never);
      const { task, workContract } = await mgr.delegateTask(
        'parent-agent', '收集数据', ['collect_data'], 'normal', undefined,
        { goalId: goal.goalId, successCriteria: ['有产出'] },
      );
      expect(workContract).toBeTruthy();
      const assignedTo = task.assignedAgentId;
      // 换人 → 拒 (合同绑的是原来那个执行者)
      await mgr.assignTask(task.id, a2.id === assignedTo ? a1.id : a2.id);
      const t2 = (await mgr.getTask(task.id))!;
      expect(t2.assignedAgentId).toBe(assignedTo);
      expect(t2.reassignRefused).toBeTruthy();
      expect(String(t2.reassignRefused!.reason)).toContain('重签');
      // 换成原执行者 → 放行 (门不是永远判红)
      await mgr.assignTask(task.id, assignedTo!);
      const t3 = (await mgr.getTask(task.id))!;
      expect(t3.reassignRefused).toBeNull();
      expect(t3.assignedAgentId).toBe(assignedTo);
    } finally {
      await mgr.destroy();
    }
  });
});

describe('M3-contract ⑥ 真派遣路径: 合同签不出 → 不派出 (旧形状会照样派出去)', () => {
  it('deadline 已过期 → agent 不返回 / 任务退回 pending / 盘上没有合同 / 不计入活跃任务', async () => {
    const { gs, wiring } = await mods();
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const goal = await gs.createGoal({ objective: '父目标: 签不出合同', successCriteria: ['有产出'], createdBy: 'm3-test' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as never);
      const { task, agent, workContract } = await mgr.delegateTask(
        'parent-agent', '收集数据', ['collect_data'], 'normal', undefined,
        { goalId: goal.goalId, successCriteria: ['有产出'], deadline: '2026-09-25T09:00:00.000Z' },
      );
      expect(workContract).toBeUndefined();
      expect(agent).toBeUndefined();                 // 调用方**没有**可派遣的对象
      expect(task.status).toBe('pending');
      expect(task.assignedAgentId).toBeUndefined();
      expect(task.workId).toBeUndefined();
      expect(task.contractRefused).toBeTruthy();
      expect(String(task.contractRefused!.reason)).toContain('不派出');
      expect((await mgr.getActiveTasks()).some((t) => t.id === task.id)).toBe(false);
      expect(await listDir(path.join(TMP, '.bolloon', 'goal-works', goal.goalId))).toEqual([]);
    } finally {
      await mgr.destroy();
    }
  });

  it('后果一: 目标语境下没有合同的任务不许自称完成 (没有合同就没有判据)', async () => {
    const { gs } = await mods();
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const goal = await gs.createGoal({ objective: '父目标: 完成门', successCriteria: ['有产出'], createdBy: 'm3-test' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as never);
      const { task } = await mgr.delegateTask(
        'parent-agent', '收集数据', ['collect_data'], 'normal', undefined,
        { goalId: goal.goalId, successCriteria: ['有产出'], deadline: '2026-09-25T09:00:00.000Z' },
      );
      expect(task.goalId).toBe(goal.goalId);
      await mgr.updateTaskStatus(task.id, 'completed', '全部做完了, 质量很好');
      const t2 = (await mgr.getTask(task.id))!;
      expect(t2.status).not.toBe('completed');
      expect(String(t2.error)).toContain('没有工作合同');
    } finally {
      await mgr.destroy();
    }
  });

  it('负控制: 没有 goalId 的旧形状完全不变; 有 goalId 且合同签成 → 合同 + 心跳真落盘', async () => {
    const { gs, wiring } = await mods();
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const goal = await gs.createGoal({ objective: '父目标: 正常派遣', successCriteria: ['有产出'], createdBy: 'm3-test' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as never);
      // 旧形状 (无目标上下文): 行为与接线前一致 —— 没有合同, 说完成就完成
      const legacy = await mgr.delegateTask('cli-user', '收集数据2', ['collect_data']);
      expect(legacy.workContract).toBeUndefined();
      expect(legacy.agent).toBeTruthy();
      expect(legacy.task.contractRefused ?? null).toBeNull();
      await mgr.updateTaskStatus(legacy.task.id, 'completed', '全部做完了');
      expect((await mgr.getTask(legacy.task.id))!.status).toBe('completed');

      // 目标上下文: 合同真签 + 心跳真落盘 (真派遣过程的监控输入)
      const ok = await mgr.delegateTask(
        'parent-agent', '收集数据3', ['collect_data'], 'normal', undefined,
        { goalId: goal.goalId, successCriteria: ['有产出'] },
      );
      expect(ok.workContract).toBeTruthy();
      expect(ok.agent).toBeTruthy();
      expect(await exists(wiring.contractPathFor(goal.goalId, ok.task.workId!))).toBe(true);
      const hbPath = wiring.heartbeatPathFor(goal.goalId, ok.task.workId!);
      expect(await exists(hbPath)).toBe(true);
      const hb1 = JSON.parse(await fs.readFile(hbPath, 'utf8')) as { at: string };
      const t1 = (await mgr.getTask(ok.task.id))!;
      expect(t1.lastHeartbeatAt).toBe(hb1.at);
      // 子更新状态 → 心跳被刷新 (执行中"在动"的证据)
      await mgr.updateTaskStatus(ok.task.id, 'in_progress');
      const hb2 = JSON.parse(await fs.readFile(hbPath, 'utf8')) as { at: string };
      const t2 = (await mgr.getTask(ok.task.id))!;
      expect(t2.lastHeartbeatAt).toBe(hb2.at);
      expect(t2.heartbeatError ?? null).toBeNull();
      // 派遣真的写进了 Goal 的权威 continuation (父知道自己在等谁)
      const after = (await gs.readGoal(goal.goalId))!;
      expect((after.continuation!.pendingReports ?? []).map((p) => p.workId)).toContain(ok.task.workId);
    } finally {
      await mgr.destroy();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 变异验证: 把真源码里的关键判据按词界改名拿掉 → 源码级判据必须判红
// ═════════════════════════════════════════════════════════════════════════════

const SRC_SUBAGENT = 'src/agents/subagent-manager.ts';
const SRC_CONTRACT = 'src/agents/goal-flywheel/wiring/contract.ts';

async function readSrc(rel: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), rel), 'utf8');
}

/**
 * 源码级判据: "派前必须有合同"这条门在真派遣路径上有没有落到代码里。
 * 每条都返回**违规清单** (空 = 通过) —— 因此可以对被人为改坏的源码跑同一份判据 (变异验证)。
 */
function scanDispatchGate(src: string): string[] {
  const out: string[] = [];
  // ① 两个返回分支都要在合同失败时把任务退回"未派出"
  const refuses = (src.match(/(?<![A-Za-z0-9_])refuseDispatchWithoutContract\s*\(/g) ?? []).length;
  if (refuses < 3) out.push(`合同失败 → 不派出的调用点只有 ${refuses} 处 (方法定义 1 + 两个返回分支各 1 = 3)`);
  // ② "不派出"必须落成事实: 退回 pending 且不绑执行者
  const body = src.slice(src.indexOf('private refuseDispatchWithoutContract'), src.indexOf('private refuseDispatchWithoutContract') + 900);
  if (!/task\.status\s*=\s*'pending'/.test(body)) out.push('refuseDispatchWithoutContract 没有把任务退回 pending');
  if (!/task\.assignedAgentId\s*=\s*undefined/.test(body)) out.push('refuseDispatchWithoutContract 没有清掉执行者绑定');
  if (!/task\.goalId\s*=/.test(body)) out.push('refuseDispatchWithoutContract 没有留下 Goal 上下文 (完成门就管不到它)');
  // ③ 完成门必须按 goalId 判 (按 workId && goalId 判会放过"没有合同的目标任务")
  if (!/status\s*===\s*'completed'\s*&&\s*task\.goalId/.test(src)) out.push('完成门没有按 task.goalId 判 (没有合同的目标任务会混过)');
  // ④ 换人必须过合同判据
  if (!/(?<![A-Za-z0-9_])childMatchesContract\s*\(/.test(src)) out.push('assignTask 没有用 childMatchesContract 判换人');
  // ⑤ 心跳必须真写入监控的输入面
  if (!/(?<![A-Za-z0-9_])recordWorkHeartbeat\s*\(/.test(src)) out.push('派遣过程没有落心跳 (监控看不到"在动")');
  return out;
}

/** 源码级判据: 接缝自己的纪律 (合同先签再派 / 可见面闭集) */
function scanSeamDiscipline(contractSrc: string, monitorSrc: string): string[] {
  const out: string[] = [];
  // ① 派遣顺序: 先签发 (含 try/catch) 再 dispatch —— 位置必须固定
  const issueAt = contractSrc.indexOf('contract = await deps.issue(input)');
  const dispatchAt = contractSrc.indexOf('await dispatch({ contract, caller: input.caller, now: input.now })');
  if (issueAt < 0) out.push('dispatchWorker 没有先签发合同');
  if (dispatchAt < 0) out.push('dispatchWorker 没有真调派遣端口');
  if (issueAt >= 0 && dispatchAt >= 0 && issueAt > dispatchAt) out.push('派遣端口在签发之前就被调用了 (顺序反了 ⇒ 无合同也能派)');
  if (!/no_dispatch:\s*合同没签成, 派遣端口零调用/.test(contractSrc)) out.push('签发失败时没有明确标注"派遣端口零调用"');
  // ② 可见面: 必须逐值校验闭集 (不能裸透传端口返回值)
  if (!/(?<![A-Za-z0-9_])userFacingState\s*\(/.test(monitorSrc)) out.push('可见面探针没有做闭集校验');
  if (!/USER_VISIBLE_STATES/.test(monitorSrc)) out.push('闭集不是取自冻结层 (自己另立了一份)');
  // ③ 统一巡检: 失败必须留痕 (errors.push 至少两处: 取清单失败 + 单目标失败)
  const pushes = (monitorSrc.match(/view\.errors\.push\s*\(/g) ?? []).length;
  if (pushes < 2) out.push(`统一巡检的失败留痕只有 ${pushes} 处 (取清单 + 单目标) —— 会静默漏 Goal`);
  if (!/(?<![A-Za-z0-9_])silentRisk\s*=/.test(monitorSrc)) out.push('统一巡检没有静默自检位');
  return out;
}

describe('M3-contract ⑦ 变异验证: 判据本身能被改坏抓出来 (按词界改名, 防子串假绿)', () => {
  it('干净源码上两条判据都绿 (不空转)', async () => {
    const sub = await readSrc(SRC_SUBAGENT);
    const con = await readSrc(SRC_CONTRACT);
    const mon = await readSrc('src/agents/goal-flywheel/wiring/monitor.ts');
    expect(scanDispatchGate(sub)).toEqual([]);
    expect(scanSeamDiscipline(con, mon)).toEqual([]);
  });

  it('变异 1: refuseDispatchWithoutContract → refuseQuietly (整体改名) → 真捕 1 条', async () => {
    const src = (await readSrc(SRC_SUBAGENT)).replace(/(?<![A-Za-z0-9_])refuseDispatchWithoutContract/g, 'refuseQuietly');
    const v = scanDispatchGate(src);
    expect(v.length).toBe(4);   // 实证: 定义丢失 ⇒ 4 条判据同时报警 (含 3 条字段判据)
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.includes('不派出'))).toBe(true);
  });

  it('变异 2: 完成门退回旧写法 (&& task.workId && task.goalId) → 真捕 1 条', async () => {
    const src = (await readSrc(SRC_SUBAGENT)).replace(
      /status\s*===\s*'completed'\s*&&\s*task\.goalId/,
      "status === 'completed' && task.workId && task.goalId",
    );
    const v = scanDispatchGate(src);
    expect(v.length).toBe(1);
    expect(v.some((x) => x.includes('完成门'))).toBe(true);
  });

  it('变异 3: 换人判据改名 (childMatchesContract → sameChild) → 真捕 1 条', async () => {
    const src = (await readSrc(SRC_SUBAGENT)).replace(/(?<![A-Za-z0-9_])childMatchesContract/g, 'sameChild');
    const v = scanDispatchGate(src);
    expect(v.length).toBe(1);
    expect(v.some((x) => x.includes('换人'))).toBe(true);
  });

  it('变异 4: 心跳落点改名 (recordWorkHeartbeat → ping) → 真捕 1 条', async () => {
    const src = (await readSrc(SRC_SUBAGENT)).replace(/(?<![A-Za-z0-9_])recordWorkHeartbeat/g, 'ping');
    const v = scanDispatchGate(src);
    expect(v.length).toBe(1);
    expect(v.some((x) => x.includes('心跳'))).toBe(true);
  });

  it('变异 5: 接缝里把"先签后派"改成"先派后签" → 真捕 1 条', async () => {
    const con = await readSrc(SRC_CONTRACT);
    // 把两个锚点**互换位置** (签发点搬到派遣点之后) —— 等价于"派遣先发生, 合同后补"
    const ISSUE = 'contract = await deps.issue(input);';
    const DISPATCH = 'const receipt = await dispatch({ contract, caller: input.caller, now: input.now });';
    expect(con.includes(ISSUE)).toBe(true);
    expect(con.includes(DISPATCH)).toBe(true);
    const mutated = con.replace(ISSUE, '@@ISSUE@@').replace(DISPATCH, ISSUE).replace('@@ISSUE@@', DISPATCH);
    expect(mutated).not.toBe(con);   // 变异必须真生效 (否则这条阴性对照自己失效)
    const v = scanSeamDiscipline(mutated, await readSrc('src/agents/goal-flywheel/wiring/monitor.ts'));
    expect(v.length).toBe(1);
    expect(v.some((x) => x.includes('顺序反了'))).toBe(true);
  });

  it('变异 6: 可见面裸透传 (userFacingState 改名) → 真捕 1 条', async () => {
    const mon = (await readSrc('src/agents/goal-flywheel/wiring/monitor.ts')).replace(/(?<![A-Za-z0-9_])userFacingState/g, 'passthrough');
    const v = scanSeamDiscipline(await readSrc(SRC_CONTRACT), mon);
    expect(v.length).toBe(1);
    expect(v.some((x) => x.includes('闭集校验'))).toBe(true);
  });

  it('变异 7: 统一巡检删掉一处失败留痕 → 真捕 1 条', async () => {
    const mon = (await readSrc('src/agents/goal-flywheel/wiring/monitor.ts')).replace(/view\.errors\.push\s*\(/g, 'view.notes.push(');
    const v = scanSeamDiscipline(await readSrc(SRC_CONTRACT), mon);
    expect(v.length).toBe(1);
    expect(v.some((x) => x.includes('失败留痕'))).toBe(true);
  });
});
