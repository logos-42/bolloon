import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// server-types 的路径常量在模块求值时用 HOME/USERPROFILE 解析 —
// 先设临时 HOME 再动态 import (静态 import 会被提升, env 来不及生效)
const tmpHome = path.join(os.tmpdir(), 'bolloon-task-claim-' + Date.now());
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  claimTaskForExecution,
  claimNextPendingTask,
  endTaskExecution,
  heartbeatTaskExecution,
  releaseStaleClaims,
  loadTaskQueue,
  saveTaskQueue,
} = await import('../web/server-storage.js');
const { TASK_QUEUE_PATH } = await import('../web/server-types.js');

function makeTask(id: string, status: string = 'pending') {
  return {
    id,
    type: 'chat' as const,
    title: `t-${id}`,
    status: status as any,
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  await fs.mkdir(path.dirname(TASK_QUEUE_PATH), { recursive: true });
});

afterAll(async () => {
  endTaskExecution();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('任务认领 CAS (Hermes kanban compare-and-swap 模式)', () => {
  it('pending → claimed (原子翻 running)', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('a'), makeTask('b')]);
    const r = await claimTaskForExecution('a');
    expect(r).toBe('claimed');
    const tasks = await loadTaskQueue();
    expect(tasks.find((t) => t.id === 'a')?.status).toBe('running');
    expect(tasks.find((t) => t.id === 'b')?.status).toBe('pending');
    endTaskExecution();
  });

  it('非 pending / 不存在 → not-pending (输家不认领不重试)', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('a', 'completed'), makeTask('b')]);
    expect(await claimTaskForExecution('a')).toBe('not-pending');
    expect(await claimTaskForExecution('missing')).toBe('not-pending');
    endTaskExecution();
  });

  it('busy: 已有任务在执行 → 拒绝 (至多一个 winner)', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('a'), makeTask('b')]);
    expect(await claimTaskForExecution('a')).toBe('claimed');
    expect(await claimTaskForExecution('b')).toBe('busy');
    expect(await claimNextPendingTask()).toBeNull();
    endTaskExecution();
  });

  it('claimNextPendingTask: 只认领第一个 pending; 认领后无剩余 → null', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('x', 'completed'), makeTask('y')]);
    const t = await claimNextPendingTask();
    expect(t?.id).toBe('y');
    expect(await claimNextPendingTask()).toBeNull();
    endTaskExecution();
  });

  it('认领写 claim_expires (TTL)', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('a')]);
    expect(await claimTaskForExecution('a')).toBe('claimed');
    const tasks = await loadTaskQueue();
    const t = tasks.find((x) => x.id === 'a');
    expect(t?.claimExpires).toBeGreaterThan(Date.now());
    expect(t?.claimExpires).toBeLessThanOrEqual(Date.now() + 16 * 60 * 1000);
    endTaskExecution();
  });

  it('heartbeat 续期: 当前执行任务 claim_expires 后移; 非执行中 → false', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('a')]);
    await claimTaskForExecution('a');
    const before = (await loadTaskQueue()).find((x) => x.id === 'a')!.claimExpires!;
    // 模拟时间流逝后心跳 → 续期
    const patched = await loadTaskQueue();
    const t = patched.find((x) => x.id === 'a')!;
    t.claimExpires = Date.now() + 60_000;
    await saveTaskQueue(patched);
    expect(await heartbeatTaskExecution('a')).toBe(true);
    const after = (await loadTaskQueue()).find((x) => x.id === 'a')!.claimExpires!;
    expect(after).toBeGreaterThan(before);
    endTaskExecution();
    // 未执行中 → false
    expect(await heartbeatTaskExecution('a')).toBe(false);
  });

  it('releaseStaleClaims: 过期 running → 回 pending + 解锁; 未过期 → 不动', async () => {
    endTaskExecution();
    // 过期任务 (直接写 claimExpires 为过去)
    await saveTaskQueue([makeTask('stale'), makeTask('fresh')]);
    await claimTaskForExecution('stale');
    const tasks1 = await loadTaskQueue();
    const s = tasks1.find((x) => x.id === 'stale')!;
    s.claimExpires = Date.now() - 1000;
    await saveTaskQueue(tasks1);
    // fresh 未过期
    expect(await claimTaskForExecution('fresh')).toBe('busy'); // stale 持锁
    const n = await releaseStaleClaims();
    expect(n).toBe(1);
    const tasks2 = await loadTaskQueue();
    expect(tasks2.find((x) => x.id === 'stale')?.status).toBe('pending');
    expect(tasks2.find((x) => x.id === 'stale')?.claimExpires).toBeUndefined();
    expect(tasks2.find((x) => x.id === 'fresh')?.status).toBe('pending');
    // 锁已释放 → 可重新认领
    expect(await claimTaskForExecution('fresh')).toBe('claimed');
    endTaskExecution();
  });

  it('releaseStaleClaims: 无过期 → 0', async () => {
    endTaskExecution();
    await saveTaskQueue([makeTask('a')]);
    expect(await releaseStaleClaims()).toBe(0);
    endTaskExecution();
  });
});
