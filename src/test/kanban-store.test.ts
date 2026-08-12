/**
 * kanban-store.test.ts — 2026-08-12 (Task5)
 *
 * 覆盖 Hermes kanban → OrbitDB 的核心语义 (用内存 KV 注入):
 *   - 9 态状态机 / 非法迁移拒绝 / blocked 强 reason
 *   - 原子认领 CAS (至多一个赢家)
 *   - 父依赖不变式 (认领点强校验)
 *   - TTL 过期释放 (崩溃锁不泄漏)
 *   - 熔断 (连续失败 → blocked)
 *   - 完成防幻觉 (createdRefs 校验)
 *   - review 审批通道
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KanbanBoard, type KanbanTask } from '../orbitdb/kanban-store.js';

describe('KanbanBoard (OrbitDB kanban, Task5)', () => {
  let board: KanbanBoard;
  let map: Map<string, unknown>;
  beforeEach(() => {
    map = new Map<string, unknown>();
    const kv = {
      put: async (k: string, v: unknown) => { map.set(k, v); },
      get: async (k: string) => map.get(k) ?? null,
      all: async () => Array.from(map.entries()).map(([k, value]) => ({ key: k, value })),
    };
    board = new KanbanBoard(kv);
  });

  const ready = async (id: string): Promise<void> => {
    await board.setStatus(id, 'todo');
    await board.setStatus(id, 'ready');
  };
  const task = async (id: string): Promise<KanbanTask> => board.getTask(id).then(t => t!);

  it('create task 默认 triage, 含全部字段默认值 (dag-cbor 无 undefined)', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '写模块' });
    expect(t.status).toBe('triage');
    expect(t.body).toBe('');
    expect(t.parentIds).toEqual([]);
    expect(t.claimLock).toBe('');
    expect(t.consecutiveFailures).toBe(0);
    expect(t.createdRefs).toEqual([]);
  });

  it('todo → ready, 然后 CAS 认领至多一个赢家', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '并行认领' });
    await ready(t.id);
    const w1 = await board.claimTask(t.id, 'worker-1');
    expect(w1.ok).toBe(true);
    const w2 = await board.claimTask(t.id, 'worker-2');
    expect(w2.ok).toBe(false);
    expect(w2.reason).toContain('已被');
    const got = await task(t.id);
    expect(got.status).toBe('running');
    expect(got.claimLock).toBe('worker-1');
  });

  it('只有 ready 可认领; 父任务未完成时认领点强校验降级 blocked', async () => {
    const parent = await board.createTask({ boardId: 'b1', title: '父' });
    const child = await board.createTask({ boardId: 'b1', title: '子', parentIds: [parent.id] });
    // 子任务直接推到 ready (父未 done) — promoteReady / setStatus 应纠正为 blocked
    await ready(child.id);
    const c = await task(child.id);
    expect(c.status).toBe('blocked'); // 父未完成 → 不允许 ready
  });

  it('TTL 过期认领被释放回 ready', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '过期锁' });
    await ready(t.id);
    await board.claimTask(t.id, 'w');
    const old = await task(t.id);
    map.set(`task:${t.id}`, { ...old, claimExpires: Date.now() - 1 });
    const freed = await board.releaseStaleClaims();
    expect(freed).toBe(1);
    const got = await task(t.id);
    expect(got.status).toBe('ready');
    expect(got.claimLock).toBe('');
  });

  it('连续失败熔断 → blocked, 不再可认领', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '会挂' });
    await ready(t.id);
    await board.claimTask(t.id, 'w');
    await board.registerFailure(t.id, 3);
    await board.registerFailure(t.id, 3);
    await board.registerFailure(t.id, 3);
    const got = await task(t.id);
    expect(got.status).toBe('blocked');
    expect(got.consecutiveFailures).toBe(3);
    const claim = await board.claimTask(t.id, 'w2');
    expect(claim.ok).toBe(false);
  });

  it('completeTask 校验声称创建的引用 (防幻觉, advisory), 且自动释放认领锁', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '交付' });
    await ready(t.id);
    await board.claimTask(t.id, 'w');
    const done = await board.completeTask(t.id, 'w', ['t_needs_channel', 't_ghost']);
    expect(done!.status).toBe('done');
    expect(done!.reason).toContain('advisory_missing_refs');
    expect(done!.claimLock).toBe('');
  });

  it('review → approve 审批通道; 非法迁移 (done → todo) 拒绝', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '审批' });
    await ready(t.id);
    await board.claimTask(t.id, 'w');
    await board.requestReview(t.id, '请审');
    expect((await task(t.id)).status).toBe('review');
    const approved = await board.approveReview(t.id);
    expect(approved!.status).toBe('done');
    const rollback = await board.setStatus(t.id, 'todo');
    expect(rollback).toBeNull(); // 终态不可再动
  });

  it('blocked 必须带 reason 否则拒绝', async () => {
    const t = await board.createTask({ boardId: 'b1', title: '阻塞' });
    const noReason = await board.setStatus(t.id, 'blocked', '');
    expect(noReason).toBeNull();
    const ok = await board.setStatus(t.id, 'blocked', '需要人工确认');
    expect(ok!.status).toBe('blocked');
  });

  it('父任务 done 后子任务自动晋升 ready (promoteReady 解阻塞)', async () => {
    const parent = await board.createTask({ boardId: 'b1', title: '父' });
    const child = await board.createTask({ boardId: 'b1', title: '子', parentIds: [parent.id] });
    await ready(child.id);
    expect((await task(child.id)).status).toBe('blocked'); // 父未 done
    await ready(parent.id);
    await board.claimTask(parent.id, 'w');
    await board.completeTask(parent.id, 'w');
    // completeTask 已完成子任务晋升
    const c = await task(child.id);
    expect(c.status).toBe('ready');
  });
});