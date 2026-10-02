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

  it('K5 尚未开工: 容器不存在, 进度为 0 (台账与盘上事实一致)', () => {
    expect(K5_PROGRESS.stage).toBe('not-started');
    expect(fs.existsSync(path.join(SRC, K5_PROGRESS.containerPath))).toBe(false);
    expect(K5_PROGRESS.fieldsMigrated).toBe(0);
    expect(K5_PROGRESS.entriesWired).toBe(0);
  });

  it('判别力自证: 四种坏形状都必须判红', () => {
    const base = { exists, k2SessionFields: K2_SESSION };
    const clone = (o: Partial<K5LedgerLike>) => ({ ...LEDGER, ...o });
    // ① 标 not-started 但容器已存在 (假账)
    expect(scanActorLedger(clone({}), { exists: () => true, k2SessionFields: K2_SESSION })
      .some((f) => f.rule === 'actor-stage-stale')).toBe(true);
    // ② 标了进度但容器不存在 (假进度)
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, stage: 'container-built' } }), base)
      .some((f) => f.rule === 'actor-container-missing')).toBe(true);
    // ③ 移交字段访问数被抄错 (跨台账漂移)
    expect(scanActorLedger(clone({ inheritedFields: K5_INHERITED_FIELDS.map((f, i) => (i === 0 ? { ...f, accesses: f.accesses + 1 } : f)) }), base)
      .some((f) => f.rule === 'actor-inherit-drift')).toBe(true);
    // ④ 验收标准没接住从 K2 移来的那条
    expect(scanActorLedger(clone({ acceptance: K5_ACCEPTANCE.filter((a) => !a.includes('history')) }), base)
      .some((f) => f.rule === 'actor-handoff-missing')).toBe(true);
    // ⑤ not-started 阶段不许有非零进度
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, fieldsMigrated: 1 } }), base)
      .some((f) => f.rule === 'actor-progress-premature')).toBe(true);
  });

  it('变异: 容器文件真被建出来 ⇒ 台账立刻变红 (逼着登记进度)', () => {
    // **不许在 src/ 里真建文件再删** —— 8 个测试文件并行跑时, 别的 worker 正在扫这个目录,
    //   会采集成竞态 (2026-10-02 实测: 造成 kernel-constraint.test.ts 的并行假红)。
    //   判据本来就是纯函数, `exists` 是它设计好的接缝 ⇒ 在这里注入即可。
    expect(fs.existsSync(path.join(SRC, K5_PROGRESS.containerPath))).toBe(false); // 盘上事实: 现在真的没有
    const findings = scanActorLedger(LEDGER, { exists: (rel) => rel === K5_PROGRESS.containerPath, k2SessionFields: K2_SESSION });
    expect(findings.some((f) => f.rule === 'actor-stage-stale')).toBe(true);
    // 复原后仍绿
    expect(scanActorLedger(LEDGER, { exists, k2SessionFields: K2_SESSION })).toEqual([]);
  });
});
