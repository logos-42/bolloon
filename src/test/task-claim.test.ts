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
});
