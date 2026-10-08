/**
 * 手机端 Harness 扩展能力验证 (2026-10-07)
 * 初始化智能体 / 目标设计 / 计划执行 / Block 分块 / 断点恢复 / 发派子智能体
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentInit, GoalDesigner, PlanExecutor, BlockRunner, CheckpointResume,
  SubAgentDispatch, GoalPlan, BlockDef, HarnessStorage,
} from '../web/mobile-harness.ts';

function memStorage(): HarnessStorage {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, v); },
  };
}

const okTools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  ok_tool: async () => '{"success":true,"out":"ok"}',
  fail_tool: async () => '{"success":false,"error":"boom"}',
  get_wallet: async () => '{"success":true,"balance":"12.5"}',
  get_status: async () => '{"success":true,"status":"ok"}',
};

describe('手机端 Harness 扩展能力 (6 项)', () => {
  let storage: HarnessStorage;
  beforeEach(() => { storage = memStorage(); });

  it('9. 初始化智能体: 身份 + persona + 记忆装配, 可读回', async () => {
    const { MemoryStore } = await import('../web/mobile-harness.ts');
    const mem = new MemoryStore(storage);
    const init = new AgentInit(storage, mem);
    const r = await init.init({ name: '小B', personality: '活泼', identity: { did: 'did:key:z6MkREAL', publicKey: 'ab'.repeat(32) } });
    expect(r.ok).toBe(true);
    expect(r.agentId).toContain('mobile-agent');
    expect(r.did).toBe('did:key:z6MkREAL');
    expect(r.personaApplied).toBe(true);
    const spec = await init.get(r.agentId);
    expect(spec?.name).toBe('小B');
    expect(spec?.personality).toBe('活泼');
    const mems = await mem.all();
    expect(mems.some((m) => m.content.includes('初始化'))).toBe(true);
  });

  it('10. 目标设计: 规则拆解长目标为多个里程碑 (无 LLM)', async () => {
    const gd = new GoalDesigner(); // 无 LLM → 规则
    const plan = await gd.design('查我的钱包余额，然后汇报状态，最后发到群聊');
    expect(plan.goal).toContain('钱包');
    expect(plan.milestones.length).toBeGreaterThanOrEqual(3);
    expect(plan.milestones[0].steps[0].action).toContain('钱包');
  });

  it('11. 计划执行: 按里程碑顺序执行工具, 失败记录不阻塞', async () => {
    const pe = new PlanExecutor(okTools);
    const plan: GoalPlan = {
      goal: '测试',
      milestones: [
        { id: 'm1', title: '查余额', steps: [{ id: 'm1s1', action: '查余额', tool: 'get_wallet', doneWhen: '有余额' }] },
        { id: 'm2', title: '失败步骤', steps: [{ id: 'm2s1', action: '失败', tool: 'fail_tool', doneWhen: '不触发' }] },
        { id: 'm3', title: '纯引导', steps: [{ id: 'm3s1', action: '记录', doneWhen: '记录' }] },
      ],
    };
    const r = await pe.execute(plan);
    expect(r.completed).toContain('m1/m1s1');
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].step).toBe('m2/m2s1');
    expect(r.completed).toContain('m3/m3s1'); // 无工具步骤记为完成
    expect(r.progress).toBeGreaterThan(0.5);
  });

  it('12. Block 分块: 块内失败重试, 成功后返回块完成', async () => {
    const br = new BlockRunner(okTools);
    const block: BlockDef = {
      id: 'b1', name: '第一块',
      steps: [
        { tool: 'ok_tool', args: {} },
        { tool: 'fail_tool', args: {} },
      ],
      maxRetries: 3,
    };
    const r = await br.runBlock(block);
    expect(r.ok).toBe(false); // fail_tool 始终失败
    expect(r.results.length).toBe(2);
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1].ok).toBe(false);
    expect(r.error).toContain('重试 3 次');
    // 全 ok 的块
    const good: BlockDef = { id: 'b2', name: '好块', steps: [{ tool: 'ok_tool', args: {} }, { tool: 'get_status', args: {} }] };
    const g = await br.runBlock(good);
    expect(g.ok).toBe(true);
  });

  it('13. 断点恢复: 中断后从断点续跑, 跳过已完成块', async () => {
    const cp = new CheckpointResume(storage);
    const blocks: BlockDef[] = [
      { id: 'b1', name: '块1', steps: [{ tool: 'ok_tool', args: {} }] },
      { id: 'b2', name: '块2', steps: [{ tool: 'ok_tool', args: {} }] },
    ];
    // 模拟: 完成 b1 后中断 (记录 checkpoint)
    await cp.save({ runId: 'run-x', goal: '测试', blockIndex: 1, stepIndex: 0, completedBlocks: ['b1'], updatedAt: Date.now() });
    const loaded = await cp.load();
    expect(loaded?.completedBlocks).toContain('b1');
    // resume: 应从 b2 开始, 完成所有
    const r = await cp.resume(blocks, okTools);
    expect(r.ok).toBe(true);
    expect(r.completedBlocks).toEqual(['b1', 'b2']);
    await expect(cp.load()).resolves.toBeNull(); // 完成清 checkpoint
  });

  it('14. 发派子智能体: 远端 P2P + 本地嵌套, 并行混合', async () => {
    const dispatcher = new SubAgentDispatch(
      async (peer, text) => ({ ok: true, reply: `远端处理: ${text}` }),
      async (goal) => `本地处理: ${goal}`,
    );
    // 远端
    const remote = await dispatcher.dispatch({ taskId: 't1', goal: '查数据', target: '12D3KooWxxx' });
    expect(remote.ok).toBe(true);
    expect(remote.delegatedTo).toBe('remote');
    expect(remote.reply).toContain('远端处理');
    // 本地
    const local = await dispatcher.dispatch({ taskId: 't2', goal: '写记忆' });
    expect(local.ok).toBe(true);
    expect(local.delegatedTo).toBe('local');
    // 并行混合
    const all = await dispatcher.dispatchAll([
      { taskId: 't3', goal: 'a', target: 'peer1' },
      { taskId: 't4', goal: 'b' },
    ]);
    expect(all.length).toBe(2);
    expect(all.filter((x) => x.ok).length).toBe(2);
    expect(new Set(all.map((x) => x.delegatedTo))).toEqual(new Set(['remote', 'local']));
  });
});