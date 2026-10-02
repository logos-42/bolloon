/**
 * K5 门: Channel Actor 台账 (完整性 + **与盘上事实同步** + 跨台账一致)
 *
 * K5 要搬的 4 个字段是**会话状态** (K2 已按 leo 口径判定不搬进 RunContext)。这条路线最容易出的两种假账:
 *   ① 台账写"容器未建 / 进度 0", 但盘上其实已经建了 (或反过来: 标了进度却什么都没有);
 *   ② K2 移交清单里抄错访问数 —— 两个台账各说各话。
 * 所以判据有三件硬要求: **真读盘核对容器存在性** · **进度棘轮** · **跨台账逐字相等**。
 *
 * 纪律: 真读盘 · 判据是纯函数 · 变异每次跑测试真做 · 拿不到事实就拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ACTOR_STATE_ITEMS,
  K5_ACCEPTANCE,
  K5_DELETION_PRECONDITIONS,
  K5_GOAL_BINDING_RULE,
  K5_INHERITED_FIELDS,
  K5_PROGRESS,
  K5_STEPS,
} from '../kernel/plan-channel-actor.js';
import { RUN_CONTEXT_FIELDS } from '../kernel/plan-runcontext.js';
import { ChannelActor, SerialMailbox, actorCount, createActorState, getOrCreateActor, peekActor, resetActors } from '../kernel/channel-actor.js';
import { type K5LedgerLike, scanActorLedger } from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');
const KERNEL = path.join(SRC, 'kernel');
/** 台账里的路径是**相对 src** 的 (containerPath = 'kernel/channel-actor.ts') ⇒ 拼 SRC, 不是拼 KERNEL */
const exists = (rel: string) => fs.existsSync(path.join(SRC, rel));

const LEDGER: K5LedgerLike = {
  stateItems: ACTOR_STATE_ITEMS,
  acceptance: K5_ACCEPTANCE,
  steps: K5_STEPS,
  preconditions: K5_DELETION_PRECONDITIONS,
  inheritedFields: K5_INHERITED_FIELDS,
  progress: K5_PROGRESS,
};
const K2_SESSION = RUN_CONTEXT_FIELDS.filter((f) => f.scope === 'session').map((f) => ({ name: f.name, accesses: f.accesses }));

describe('K5 门: Channel Actor 台账', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(ACTOR_STATE_ITEMS.length).toBeGreaterThan(0);
    expect(K2_SESSION.length).toBe(4);
  });

  it('台账完整 + 与盘上事实同步 + 跨台账一致', () => {
    expect(scanActorLedger(LEDGER, { exists, k2SessionFields: K2_SESSION })).toEqual([]);
  });

  it('9 项 Actor 状态逐条有名有据 (不许占位)', () => {
    for (const i of ACTOR_STATE_ITEMS) {
      expect(i.name.length).toBeGreaterThan(2);
      expect(i.why.length).toBeGreaterThan(10);
      expect(i.owner.length).toBeGreaterThan(0);
    }
    for (const need of ['channelId', 'agentId', 'goalBinding', 'messageHistory', 'mailbox', 'activeRun', 'cancellation', 'outboundStream', 'serialLock']) {
      expect(ACTOR_STATE_ITEMS.map((i) => i.name)).toContain(need);
    }
  });

  it('从 K2 移交的 4 个字段的访问数与 K2 台账逐字相等', () => {
    for (const f of K5_INHERITED_FIELDS) {
      const k2 = RUN_CONTEXT_FIELDS.find((x) => x.name === f.name)!;
      expect(k2).toBeTruthy();
      expect(k2.scope).toBe('session');
      expect(f.accesses).toBe(k2.accesses);
    }
    expect(K5_INHERITED_FIELDS.map((f) => f.name).sort()).toEqual(K2_SESSION.map((f) => f.name).sort());
  });

  it('Goal 绑定必须是显式操作 (口径留档)', () => {
    expect(K5_GOAL_BINDING_RULE).toContain('显式');
    expect(K5_GOAL_BINDING_RULE).toContain('不许靠裸字段');
  });

  it('台账与盘上事实一致: 标了 registry-built ⇒ 容器文件必须真的存在', () => {
    expect(K5_PROGRESS.stage).toBe('registry-built');
    expect(fs.existsSync(path.join(SRC, K5_PROGRESS.containerPath))).toBe(true);
    // 容器建了 ≠ 字段迁了 / 入口接了 (两个计数仍必须是 0)
    expect(K5_PROGRESS.fieldsMigrated).toBe(0);
    expect(K5_PROGRESS.entriesWired).toBe(0);
  });

  it('串行语义真跑: 同 Channel 内任务永不交错, 且按入队顺序执行', async () => {
    const actor = new ChannelActor({ channelId: 'c1' });
    const log: string[] = [];
    const task = (name: string, gapMs: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, gapMs));
      log.push(`${name}:end`);
      return name;
    };
    // 故意让后入队的任务更短 —— 若并发, 它会先结束 (交错)
    const results = await Promise.all([
      actor.submit(task('a', 30)),
      actor.submit(task('b', 10)),
      actor.submit(task('c', 1)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(actor.mailbox.pending).toBe(0);
    expect(actor.mailbox.processed).toBe(3);
  });

  it('一个任务抛错不阻塞队列 (错误交给调用方, 队列继续)', async () => {
    const mb = new SerialMailbox();
    const ran: string[] = [];
    const bad = mb.submit(async () => { ran.push('bad'); throw new Error('boom'); });
    const good = mb.submit(async () => { ran.push('good'); return 42; });
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe(42);
    expect(ran).toEqual(['bad', 'good']);
    await mb.drain();
    expect(mb.pending).toBe(0);
  });

  it('跨 Actor 隔离: 两个 channel 的 history 互不可见', async () => {
    const a = new ChannelActor({ channelId: 'a' });
    const b = new ChannelActor({ channelId: 'b' });
    await a.submit((st) => { st.messageHistory.push('A1'); });
    await b.submit((st) => { st.messageHistory.push('B1'); });
    expect(a.state.messageHistory).toEqual(['A1']);
    expect(b.state.messageHistory).toEqual(['B1']);
    expect(a.state.channelId).not.toBe(b.state.channelId);
  });

  it('取消位: beginCancellation/abort 语义 (取代 Pi 上的 currentSignal)', () => {
    const actor = new ChannelActor();
    expect(actor.state.cancellation).toBeNull();
    const signal = actor.beginCancellation();
    expect(signal.aborted).toBe(false);
    actor.abort();
    expect(signal.aborted).toBe(true);
    expect(actor.state.cancellation).toBeNull();
  });

  it('★ 注册表: 一个 channel 一个 actor, 跨 channel 隔离 (K5 第 3 步)', () => {
    resetActors();
    expect(actorCount()).toBe(0);
    const a1 = getOrCreateActor('chanA');
    const a2 = getOrCreateActor('chanA');
    const b = getOrCreateActor('chanB');
    expect(a1).toBe(a2);                    // 同 channel 幂等
    expect(a1).not.toBe(b);                 // 跨 channel 隔离
    expect(a1.state.channelId).toBe('chanA');
    expect(b.state.channelId).toBe('chanB');
    expect(actorCount()).toBe(2);
    // 已有的 actor 不会被后来的 init 覆盖
    const a3 = getOrCreateActor('chanA', { agentId: '不该生效' });
    expect(a3).toBe(a1);
    expect(a1.state.agentId).toBe('');
    // 空 channelId 落 default 桶
    expect(getOrCreateActor('').state.channelId).toBe('default');
    expect(peekActor('chanZ')).toBeUndefined();
    resetActors();
    expect(actorCount()).toBe(0);
  });

  it('★ 真跑: 按 channel 造 session ⇒ 各自绑到自己的 actor (一个 channel 一个 actor 成立)', async () => {
    resetActors();
    const { createAgentSession } = await import('../agents/pi-sdk-session-factory.js');
    const mk = (peer: string) => createAgentSession({ cwd: process.cwd(), peerId: peer });
    const sa1 = await mk('k5probe-a:s1');
    const sa2 = await mk('k5probe-a:s2');   // 同 channel, 不同 session 后缀
    const sb = await mk('k5probe-b:s1');
    expect(sa1.actor).toBeTruthy();
    expect(sa1.actor!.state.channelId).toBe('k5probe-a');   // channelId 取自 peerId 的 `:` 前段
    expect(sa2.actor).toBe(sa1.actor);                       // 同 channel ⇒ 同一个 actor
    expect(sb.actor).not.toBe(sa1.actor);                    // 跨 channel 隔离
    // 状态仍在 Pi 实例上 (这一步只做归属, 没搬字段)
    await sa1.actor!.submit((st) => { st.messageHistory.push('actor-owned'); });
    expect(sa1.actor!.state.messageHistory).toEqual(['actor-owned']);
    expect(sb.actor!.state.messageHistory).toEqual([]);
    resetActors();
  }, 60000);

  it('容器语义: 未给的字段显式置空 (镜像 K2 的「不继承残留」)', () => {
    const st = createActorState();
    expect(st.channelId).toBe('');
    expect(st.agentId).toBe('');
    expect(st.goalBinding).toBe('');
    expect(st.messageHistory).toEqual([]);
    expect(st.activeRun).toBe('');
    expect(st.cancellation).toBeNull();
    expect(st.outboundStream).toBeNull();
    expect(st.mailbox).toEqual({ pending: 0, processed: 0 });
  });

  it('判别力自证: 四种坏形状都必须判红', () => {
    const base = { exists, k2SessionFields: K2_SESSION };
    const clone = (o: Partial<K5LedgerLike>) => ({ ...LEDGER, ...o });
    // ① 标 not-started 但容器已存在 (假账) —— 现在容器的确是建了的, 所以要把 stage 显式改回 not-started 才测得到这条
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, stage: 'not-started' } }), { exists: () => true, k2SessionFields: K2_SESSION })
      .some((f) => f.rule === 'actor-stage-stale')).toBe(true);
    // ② 标了进度但容器不存在 (假进度) —— 现在 stage 就是 container-built, 所以注入"盘上没有"
    expect(scanActorLedger(clone({}), { exists: () => false, k2SessionFields: K2_SESSION })
      .some((f) => f.rule === 'actor-container-missing')).toBe(true);
    // ③ 移交字段访问数被抄错 (跨台账漂移)
    expect(scanActorLedger(clone({ inheritedFields: K5_INHERITED_FIELDS.map((f, i) => (i === 0 ? { ...f, accesses: f.accesses + 1 } : f)) }), base)
      .some((f) => f.rule === 'actor-inherit-drift')).toBe(true);
    // ④ 验收标准没接住从 K2 移来的那条
    expect(scanActorLedger(clone({ acceptance: K5_ACCEPTANCE.filter((a) => !a.includes('history')) }), base)
      .some((f) => f.rule === 'actor-handoff-missing')).toBe(true);
    // ⑤ not-started 阶段不许有非零进度 (显式把 stage 改回 not-started 才测得到)
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, stage: 'not-started', fieldsMigrated: 1 } }), base)
      .some((f) => f.rule === 'actor-progress-premature')).toBe(true);
  });

  it('变异: 台账说容器已建、盘上却没有 ⇒ 立刻判红 (假进度)', () => {
    // 镜像方向: 容器真的建了之后, 这条规则换成"标了进度却没有文件"才测得动。
    // **不许在 src/ 里真建/真删文件** —— 多个测试文件并行跑时别的 worker 正在扫这个目录, 会采集成竞态
    // (2026-10-02 实测: 造成 kernel-constraint.test.ts 的并行假红)。判据是纯函数, `exists` 就是它的接缝。
    expect(fs.existsSync(path.join(SRC, K5_PROGRESS.containerPath))).toBe(true); // 盘上事实: 现在真的有
    const findings = scanActorLedger(LEDGER, { exists: () => false, k2SessionFields: K2_SESSION });
    expect(findings.some((f) => f.rule === 'actor-container-missing')).toBe(true);
    // 复原后仍绿
    expect(scanActorLedger(LEDGER, { exists, k2SessionFields: K2_SESSION })).toEqual([]);
  });
});
