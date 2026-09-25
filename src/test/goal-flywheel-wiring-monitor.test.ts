/**
 * M3 接缝 ④ (monitor) 验收 —— 「执行中统一监控 + 用户只看到闭集」是不是代码里绕不过去 (2026-09-25)
 *
 * 这一份回答两个问题:
 *   ① **统一监控**: 一条子 Agent 工作从**真派遣**到**真被监控看见卡住**, 中间没有人工喂数据
 *      (真 SubAgentManager 派遣 → 真合同/心跳落盘 → 接缝 `sweepAll` 一次看到全部);
 *   ② **用户视野**: 只可能出现冻结闭集里的那几类, 闭集外的值 / 端口抛错 / 没有可见面来源
 *      **一律拒绝**并说清原因 (旧版是裸透传)。
 *
 * 手法: 真 Goal Store (隔离 HOME) · 真 `SubAgentManager` · 真落盘的合同与心跳 ·
 *       真 P3 判定 (`toUserVisibleState`); 负控制逐条"该拒必须真拒"(调用计数器证明没被调到)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
  BlockKind,
  BlockRecord,
  GoalContinuationRecord,
  UserVisibleState,
} from '../agents/goal-flywheel/types.js';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-m3-monitor-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
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
    seam: await import('../agents/goal-flywheel/wiring/monitor.js'),
    types: await import('../agents/goal-flywheel/types.js'),
    p3: await import('../agents/goal-flywheel/work-monitor.js'),
  };
}

/** 真接缝: 依赖全部来自真接线层 + 真 Goal Store (不 mock 任何事实面) */
async function realSeam(over: Record<string, unknown> = {}) {
  const { gs, wiring, seam } = await mods();
  return seam.createMonitorSeam({
    collect: (i: { goalId: string; now?: string; runnerAvailable?: boolean }) => wiring.collectWorkBlocks({
      goalId: i.goalId, now: i.now, runnerAvailable: i.runnerAvailable,
    }),
    handle: (i: { goalId: string; blocks: BlockRecord[]; now?: string }) => wiring.applyBlockHandling({
      goalId: i.goalId, blocks: i.blocks, now: i.now,
    }),
    goalsWithPendingWork: async (limit?: number) => (await wiring.listGoalsWithPendingWork(limit)).map((g) => ({ goalId: g.goalId })),
    // 宿主的可见面适配: 读真 Goal 的权威 continuation (故意**不**补默认值, 检验接缝自己不许崩)
    continuationOf: async (goalId: string) => {
      const g = await gs.readGoal(goalId);
      return g?.continuation ? (g.continuation as unknown as GoalContinuationRecord) : null;
    },
    ...over,
  });
}

function blockOf(goalId: string, kind: BlockKind, over: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockId: `blk:test:${kind}`,
    kind,
    goalId,
    runId: 'run-1',
    workId: 'work-test',
    childAgentId: 'child-1',
    blockedAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
    owner: 'child',
    dependency: null,
    suggestedAction: 'request_report',
    escalationAt: null,
    resolvedAt: null,
    resolution: null,
    note: `测试用阻塞 (${kind})`,
    ...over,
  };
}

const MINUTE = 60_000;

/**
 * `sweepAll` 的两种返回值: tick 视图 (对象) 或拒绝 (结构化)。
 * 判别必须走 `isRefusal` —— 拿 `Array.isArray` 猜会把"视图"误当成拒绝 (本文件第一版就踩了)。
 */
async function asView(x: unknown, label = 'sweepAll'): Promise<import('../agents/goal-flywheel/wiring/monitor.js').MonitorTickView> {
  const { wiring } = await mods();
  if (wiring.isRefusal(x)) throw new Error(`${label} 被拒绝: ${(x as { reason: string }).reason}`);
  return x as import('../agents/goal-flywheel/wiring/monitor.js').MonitorTickView;
}

async function asRefusal(x: unknown, label = 'sweepAll'): Promise<{ ok: false; reason: string; rule: string }> {
  const { wiring } = await mods();
  if (!wiring.isRefusal(x)) throw new Error(`${label} 本该被拒绝, 实际拿到: ${JSON.stringify(x).slice(0, 200)}`);
  return x as { ok: false; reason: string; rule: string };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('M3-monitor ① 真跑: 真派遣 → 真心跳/合同 → 接缝一次看到全部', () => {
  it('刚派出: 用户看到"等待外部回复"; 心跳老化: 真被监控发现 → "子 Agent 被阻塞"', async () => {
    const { gs, wiring } = await mods();
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const s = await realSeam();
    const goal = await gs.createGoal({ objective: '父目标: 收数据', successCriteria: ['有 3 条数据'], createdBy: 'm3-test' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as never);
      const { workContract } = await mgr.delegateTask(
        'parent-agent', '收集数据', ['collect_data'], 'normal', undefined,
        { goalId: goal.goalId, successCriteria: ['有 3 条数据'] },
      );
      expect(workContract).toBeTruthy();

      // ① 刚派出: 没有阻塞, 但有子工作在等回报 → 用户看到"等待外部回复" (不是假"正在执行")
      const first = await asView(await s.sweepAll({ caller: 'supervisor' }));
      expect(first.errors).toEqual([]);
      expect(first.silentRisk).toBe(false);
      expect(first.goals.length).toBe(1);
      expect(first.goals[0].goalId).toBe(goal.goalId);
      expect(first.goals[0].blocks.length).toBe(0);
      expect(first.goals[0].visibleState).toBe('waiting_external_reply');
      expect(first.blockCount).toBe(0);

      // ② 心跳老化 (真写盘: 10 分钟前的心跳) → **只诊断**先看清事实 (sweep 不改任何状态)
      await wiring.recordWorkHeartbeat(goal.goalId, workContract!.workId, new Date(Date.now() - 10 * MINUTE).toISOString());
      const diagnosed = await s.sweep({ goalId: goal.goalId, caller: 'supervisor' });
      expect(Array.isArray(diagnosed)).toBe(true);
      const blocks = diagnosed as BlockRecord[];
      expect(blocks.map((b) => b.kind)).toContain('no_heartbeat');
      // 处置动作出自 P3 的规则表 (默认 failurePolicy.onHeartbeatMiss='stall' → 上报父, **不**自动接管:
      //   接管要先确认执行权空闲且合同允许, 见 work-monitor 的处理规则表)
      expect(blocks.find((b) => b.kind === 'no_heartbeat')!.suggestedAction).toBe('escalate_parent');
      // **处置前**用户看到的是"子 Agent 被阻塞" (诊断事实, 不是内部词)
      expect(await s.visibleState({ goalId: goal.goalId, blocks })).toBe('child_blocked');

      // ③ 统一监控一次跑完: 诊断 → 处置 → 可见态。处置把目标交人 ⇒ 之后用户看到"需要你决定"
      const second = await asView(await s.sweepAll({ caller: 'supervisor' }));
      const cell = second.goals.find((c) => c.goalId === goal.goalId)!;
      expect(cell.error).toBeNull();
      expect(cell.blocks.map((b) => b.kind)).toContain('no_heartbeat');
      expect(second.blockCount).toBeGreaterThan(0);
      expect(second.errors).toEqual([]);
      const hv = cell.handling as import('../agents/goal-flywheel/wiring/monitor.js').BlockHandlingView;
      expect(hv.actions.map((a) => a.action)).toContain('escalate_parent');
      // 处置的后果落在 Goal 上 (经 reducer, 不是接缝自己写状态): 目标交人
      const after = (await gs.readGoal(goal.goalId))!;
      expect(after.status).toBe('needs_human');
      // 时间线: 子被阻塞 → 上报 → 交人 → "需要你决定" (同一次巡检里就已经反映出来)
      expect(cell.visibleState).toBe('needs_your_decision');
      expect(second.visibleCounts.needs_your_decision).toBe(1);
      const vis = await s.visibleState({ goalId: goal.goalId, blocks });
      expect(vis).toBe('needs_your_decision');

      // ④ 执行器不可用也一样被看见 (只诊断, 不假装跑过)
      const noRunner = await s.sweep({ goalId: goal.goalId, caller: 'supervisor', runnerAvailable: false });
      expect((noRunner as BlockRecord[]).map((b) => b.kind)).toContain('runner_unavailable');
    } finally {
      await mgr.destroy();
    }
  });
});

describe('M3-monitor ② 统一监控: 有界 + 失败必须留痕 (不许某个 Goal 静默消失)', () => {
  it('一个 Goal 巡检抛错 → 它的 error 与顶层 errors 都留痕, 另一个照常出结论', async () => {
    const { gs } = await mods();
    const g1 = await gs.createGoal({ objective: '好目标', successCriteria: ['c1'], createdBy: 'm3-test' });
    await gs.setContinuation(g1.goalId, { state: 'awaiting_external', pendingReports: [], unresolvedItems: [] });
    let collected: string[] = [];
    const s = await realSeam({
      goalsWithPendingWork: async () => [{ goalId: g1.goalId }, { goalId: 'g-boom' }],
      collect: async (i: { goalId: string }) => {
        collected.push(i.goalId);
        if (i.goalId === 'g-boom') throw new Error('盘读坏了 (EIO)');
        return [];
      },
      handle: async () => ({ actions: [], escalated: [], takeovers: [], requests: [] }),
    });
    const view = await asView(await s.sweepAll({ caller: 'supervisor' }));
    expect(collected.sort()).toEqual([g1.goalId, 'g-boom'].sort());
    expect(view.goals.length).toBe(2);
    const bad = view.goals.find((c) => c.goalId === 'g-boom')!;
    expect(bad.error).toContain('EIO');
    expect(bad.visibleState).toBeNull();
    expect(view.errors.length).toBe(1);
    expect(view.errors[0]).toContain('g-boom');
    expect(view.silentRisk).toBe(false);              // 还有一个查成了 → 不是"全静默"
    const good = view.goals.find((c) => c.goalId === g1.goalId)!;
    expect(good.error).toBeNull();
    expect(good.visibleState).toBe('waiting_external_reply');
    expect(view.visibleCounts.waiting_external_reply).toBe(1);
  });

  it('全部巡检失败 → silentRisk=true 且必须交人 (不是"没有阻塞")', async () => {
    const s = await realSeam({
      goalsWithPendingWork: async () => [{ goalId: 'g-a' }, { goalId: 'g-b' }],
      collect: async () => { throw new Error('盘全坏了'); },
      handle: async () => ({ actions: [], escalated: [], takeovers: [], requests: [] }),
    });
    const view = await asView(await s.sweepAll({ caller: 'supervisor' }));
    expect(view.goals.every((c) => c.error !== null)).toBe(true);
    expect(view.silentRisk).toBe(true);
    expect(view.errors.length).toBe(2);
    expect(view.escalated.some((x) => x.includes('巡检未完成'))).toBe(true);
  });

  it('拿不到待巡检清单 → 如实报错 (不是"巡检过了, 没问题")', async () => {
    let collectCalls = 0;
    const s = await realSeam({
      goalsWithPendingWork: async () => { throw new Error('Goal 索引读不出 (ENOENT)'); },
      collect: async () => { collectCalls++; return []; },
      handle: async () => ({ actions: [], escalated: [], takeovers: [], requests: [] }),
    });
    const view = await asView(await s.sweepAll({ caller: 'supervisor' }));
    expect(view.errors.length).toBe(1);
    expect(view.errors[0]).toContain('ENOENT');
    expect(view.silentRisk).toBe(true);
    expect(view.goals.length).toBe(0);
    expect(collectCalls).toBe(0);
  });

  it('有界: limit 被夹住, 不许多查 (tick 里不许无界扫盘)', async () => {
    const seen: (number | undefined)[] = [];
    const many = Array.from({ length: 500 }, (_, i) => ({ goalId: `g-${i}` }));
    const s = await realSeam({
      goalsWithPendingWork: async (limit?: number) => { seen.push(limit); return many; },
      collect: async () => [],
      handle: async () => ({ actions: [], escalated: [], takeovers: [], requests: [] }),
    });
    const v1 = await asView(await s.sweepAll({ caller: 'supervisor' }));
    expect(v1.goals.length).toBeLessThanOrEqual(20);       // 默认 20
    const v2 = await asView(await s.sweepAll({ caller: 'supervisor', limit: 9_999 }));
    expect(v2.goals.length).toBeLessThanOrEqual(200);      // 上限 200
    expect(seen[0]).toBe(20);
    expect(seen[1]).toBe(200);
  });

  it('负控制: 子 Agent 不许巡检/处置别人的阻塞 → 真拒, 且一次都没查', async () => {
    let calls = 0;
    const s = await realSeam({
      goalsWithPendingWork: async () => { calls++; return []; },
      collect: async () => { calls++; return []; },
      handle: async () => { calls++; return { actions: [], escalated: [], takeovers: [], requests: [] }; },
    });
    const r = await asRefusal(await s.sweepAll({ caller: 'child_agent' }));
    expect(r.rule).toBe('child_cannot_mutate_goal');
    expect(calls).toBe(0);   // ★ 真拒: 一次都没查 (拿不到"别人的阻塞"这件事)
    // 负控制: 父/调度器 → 真跑 (门不是永远判红)
    const ok = await asView(await s.sweepAll({ caller: 'supervisor' }));
    expect(ok.goals).toEqual([]);
    expect(calls).toBe(1);
  });

  it('旧方法语义不变: 没有 goalId 的巡检真拒 (拿到的是"谁都不卡"的假结论)', async () => {
    const s = await realSeam();
    const r = await asRefusal(await s.sweep({ goalId: '', caller: 'supervisor' }), 'sweep');
    expect(r.reason).toContain('假结论');
  });
});

describe('M3-monitor ③ 用户只看到闭集: 五类设计状态 + 已结束 (第 6 类, 冻结层)', () => {
  it('闭集取自冻结层 (不另立一份), 且设计稿的五类都在', async () => {
    const { seam, types } = await mods();
    expect(seam.USER_FACING_STATES).toBe(types.USER_VISIBLE_STATES);   // 同一份数组 (不是抄的)
    const expected: Record<string, string> = {
      executing: '正在执行',
      waiting_external_reply: '等待外部回复',
      child_blocked: '子 Agent 被阻塞',
      no_progress: '暂时没有进展',
      needs_your_decision: '需要你决定',
      ended: '已结束',   // 2026-09-25 冻结层追加的第 6 类 (改冻结层要单独提交, 不归 M3)
    };
    for (const [state, zh] of Object.entries(expected)) {
      expect(seam.USER_FACING_STATES).toContain(state as UserVisibleState);
      const view = seam.describeVisibleState(state);
      expect((view as { zh: string }).zh).toBe(zh);
      expect((view as { state: string }).state).toBe(state);
      expect(seam.scanInternalLeak(JSON.stringify(view))).toEqual([]);
    }
  });

  it('真跑: 每一个闭集状态都能由真 Goal continuation + 真 P3 判定取到 (没有取不到的空类)', async () => {
    const { gs, seam, p3 } = await mods();
    const s = await realSeam();
    const goal = await gs.createGoal({ objective: '父目标: 六类覆盖', successCriteria: ['c'], createdBy: 'm3-test' });

    // ① 正在执行: 活跃 + 没有待回报 + 没有阻塞
    await gs.setContinuation(goal.goalId, { state: 'active', pendingReports: [], unresolvedItems: [] });
    expect(await s.visibleState({ goalId: goal.goalId })).toBe('executing');

    // ② 等待外部回复: 有子工作待回报
    await gs.setContinuation(goal.goalId, {
      state: 'awaiting_external', pendingReports: [], unresolvedItems: [],
    });
    expect(await s.visibleState({ goalId: goal.goalId })).toBe('waiting_external_reply');

    // ③ 子 Agent 被阻塞: 真判定 (toUserVisibleState) + 真 BlockRecord (工具被阻 → 不自动绕过 Harness)
    const toolBlock = blockOf(goal.goalId, 'tool_blocked', { suggestedAction: 'not_an_action' as never });
    expect(p3.planBlockHandling(toolBlock)).toBe('change_plan');   // 规则表回落: 工具被阻只许改计划/转人工
    expect(p3.planBlockHandling(blockOf(goal.goalId, 'budget_blocked', { suggestedAction: 'not_an_action' as never })))
      .toBe('needs_human');   // 预算被阻: 加预算不许 Agent 自动批
    // 对照: 记录里写着已知动作时以记录为准 (work-monitor 的语义: 记录既是事实也是结论)
    expect(p3.planBlockHandling(blockOf(goal.goalId, 'budget_blocked', { suggestedAction: 'needs_human' }))).toBe('needs_human');
    await gs.setContinuation(goal.goalId, { state: 'active', pendingReports: [], unresolvedItems: [] });
    expect(await s.visibleState({ goalId: goal.goalId, blocks: [toolBlock] })).toBe('child_blocked');

    // ④ 暂时没有进展
    await gs.setContinuation(goal.goalId, { state: 'stalled', pendingReports: [], unresolvedItems: [] });
    expect(await s.visibleState({ goalId: goal.goalId })).toBe('no_progress');

    // ⑤ 需要你决定
    await gs.setContinuation(goal.goalId, { state: 'needs_human', pendingReports: [], unresolvedItems: [] });
    expect(await s.visibleState({ goalId: goal.goalId })).toBe('needs_your_decision');

    // ⑥ 已结束 (第 6 类): 已结束**绝不**说成"正在执行"
    await gs.setContinuation(goal.goalId, { state: 'completed', pendingReports: [], unresolvedItems: [] });
    const ended = await s.visibleState({ goalId: goal.goalId });
    expect(ended).toBe('ended');
    expect(ended).not.toBe('executing');

    // 顺带钉住: 接缝的返回值不允许出现闭集外的值 (枚举比对, 不是抽样)
    for (const v of ['executing', 'waiting_external_reply', 'child_blocked', 'no_progress', 'needs_your_decision', 'ended']) {
      expect(seam.USER_FACING_STATES).toContain(v);
    }
    // 缺字段的 continuation 不许让接缝崩 (goal-store 的 `pendingReports` 是 optional):
    // 真写一条**只有 state** 的 continuation, 再接缝算一次可见态 —— 缺的字段按"没有"补。
    const fresh = await gs.createGoal({ objective: '父目标: 缺字段', successCriteria: ['c'], createdBy: 'm3-test' });
    await gs.setContinuation(fresh.goalId, { state: 'active' });
    const raw = (await gs.readGoal(fresh.goalId))!.continuation;
    expect(raw!.pendingReports ?? null).toBeNull();       // 事实: 盘上这份确实没有 pendingReports 字段
    expect(await s.visibleState({ goalId: fresh.goalId })).toBe('executing');
  });

  it('负控制: 端口给出闭集外的值 / 空值 / 抛错 / 没有端口 → 一律拒绝并说清原因 (不许静默降级)', async () => {
    const { seam } = await mods();
    const bad = seam.createVisibleStateProbe({ visible: async () => 'kaboom' as never });
    const r1 = await bad({ goalId: 'g' });
    expect((r1 as { ok: false }).ok).toBe(false);
    expect((r1 as { reason: string }).reason).toContain('闭集');

    const undef = seam.createVisibleStateProbe({ visible: async () => undefined as never });
    const r2 = await undef({ goalId: 'g' });
    expect((r2 as { ok: false }).ok).toBe(false);
    expect((r2 as { reason: string }).reason).toContain('闭集');

    const boom = seam.createVisibleStateProbe({ visible: async () => { throw new Error('视图服务挂了 (ETIMEDOUT)'); } });
    const r3 = await boom({ goalId: 'g' });
    expect((r3 as { ok: false }).ok).toBe(false);
    expect((r3 as { reason: string }).reason).toContain('ETIMEDOUT');
    expect((r3 as { reason: string }).reason).toContain('不静默降级');

    const none = seam.createVisibleStateProbe({});
    const r4 = await none({ goalId: 'g' });
    expect((r4 as { ok: false }).ok).toBe(false);
    expect((r4 as { reason: string }).reason).toContain('不许编一个状态');

    // 负控制: 合法值必须原样放行 (门不是永远判红)
    const good = seam.createVisibleStateProbe({ visible: async () => 'child_blocked' });
    expect(await good({ goalId: 'g' })).toBe('child_blocked');
  });

  it('内部词扫描: 闭集外露真会被抓到 (租约/重试计数/worker owner 这类词不许进用户视野)', async () => {
    const { seam } = await mods();
    expect(seam.scanInternalLeak('正在执行')).toEqual([]);
    expect(seam.scanInternalLeak('lease owner=worker-3 持有中')).toContain('lease');
    expect(seam.scanInternalLeak('retry counter=2')).toContain('retry counter');
    expect(seam.scanInternalLeak('worker owner: node-A')).toContain('worker owner');
    // 每种用户可见态的文案都不含内部词 (真跑一遍闭集)
    for (const st of seam.USER_FACING_STATES) {
      expect(seam.scanInternalLeak(JSON.stringify(seam.describeVisibleState(st)))).toEqual([]);
    }
  });

  it('sweepAll 里可见面被拒 → 这一格留痕 (不静默给个"正在执行")', async () => {
    const s = await realSeam({
      goalsWithPendingWork: async () => [{ goalId: 'g-vis' }],
      collect: async () => [],
      handle: async () => ({ actions: [], escalated: [], takeovers: [], requests: [] }),
      visible: async () => '正在执行中' as never,   // 闭集外 (中文文案被当成状态值)
    });
    const view = await asView(await s.sweepAll({ caller: 'supervisor' }));
    expect(view.goals[0].visibleState).toBeNull();
    expect(String(view.goals[0].error)).toContain('闭集');
    expect(view.errors.length).toBe(1);
    expect(view.visibleCounts.executing ?? 0).toBe(0);
  });
});
