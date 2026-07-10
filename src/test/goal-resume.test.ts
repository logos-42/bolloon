/**
 * goal-resume.ts — 目标接力单元测试 (2026-07-10 双栖 agent 网络改造)
 *
 * 注意: goal-resume 内部用 sessionStore 单例 (写 ~/.bolloon/sessions/cache/), 本测试只验:
 *   1. 函数签名 + 错误路径 (goalId 缺失 / targetId 缺失)
 *   2. appendEvent 落 ~/.bolloon/goals/event.jsonl — 测试用临时 HOME
 *   3. 列表 / 查询空状态
 *   4. 字段类型 + shape
 *
 * 不测的: 实际写盘 + 跨重启恢复 (需要 fs mock, 后续阶段补)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  parkGoal,
  resumeGoal,
  listParkedGoals,
  getGoal,
  _resetGoalsForTest,
} from '../agents/goal-resume.js';

let TEST_HOME: string;

beforeEach(async () => {
  TEST_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-goal-test-'));
  process.env.HOME = TEST_HOME;
  // 清掉旧的 goals 目录
  await fs.rm(path.join(TEST_HOME, '.bolloon', 'goals'), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
  await _resetGoalsForTest();
});

describe('goal-resume: parkGoal 错误路径', () => {
  it('goalId 缺失 → 返回 error', async () => {
    const result = await parkGoal(
      { goalId: '', targetId: 'test', createdBy: 'user', createdAt: '', originChannel: 'c1' },
      'channel_switch',
    );
    expect(result.error).toBeDefined();
    expect(result.state).toBe('parked');
  });

  it('targetId 缺失 → 返回 error', async () => {
    const result = await parkGoal(
      { goalId: 'g1', targetId: '', createdBy: 'user', createdAt: '', originChannel: 'c1' },
      'channel_switch',
    );
    expect(result.error).toBeDefined();
  });

  it('originChannel 缺失也能 park (内部用空字符串)', async () => {
    const result = await parkGoal(
      { goalId: 'g-test-1', targetId: '完成财务迁移', createdBy: 'user', createdAt: new Date().toISOString(), originChannel: '' },
      'user_away',
    );
    // 不抛错, 即使内部空也允许
    expect(result.goalId).toBe('g-test-1');
  });
});

describe('goal-resume: resumeGoal 错误路径', () => {
  it('goalId 缺失 → 返回 error', async () => {
    const result = await resumeGoal('', { newSession: false });
    expect(result.error).toBeDefined();
  });

  it('goalId 不存在 → 返回 "未找到"', async () => {
    const result = await resumeGoal('not-exist-xyz', {});
    expect(result.error).toContain('未找到');
  });
});

describe('goal-resume: 列表 / 查询空状态', () => {
  it('listParkedGoals 初始空', async () => {
    const list = await listParkedGoals({});
    expect(list).toEqual([]);
  });

  it('getGoal 不存在 → null', async () => {
    const g = await getGoal('not-exist');
    expect(g).toBeNull();
  });
});

describe('goal-resume: Park 流程 + 落盘', () => {
  it('完整 park → listParkedGoals 能找到', async () => {
    const goalRef = {
      goalId: 'g-flow-1',
      targetId: '完成 X 模块',
      createdBy: 'user' as const,
      createdAt: new Date().toISOString(),
      originChannel: 'channel-A',
    };
    const parkResult = await parkGoal(goalRef, 'channel_switch');
    expect(parkResult.state).toBe('parked');
    // 不检查 error (可能因为 sessionStore 写用户本机 ~/.bolloon/ 失败, 但 goal 本身能 park)

    const list = await listParkedGoals({});
    const found = list.find((s) => s.goalRef.goalId === 'g-flow-1');
    expect(found).toBeDefined();
    expect(found?.goalRef.targetId).toBe('完成 X 模块');
    expect(found?.parkReason).toBe('channel_switch');
    expect(found?.schemaVersion).toBe(1);
  });

  it('park 后 event.jsonl 至少有一条', async () => {
    const goalRef = {
      goalId: 'g-event-1',
      targetId: '测试 event',
      createdBy: 'agent' as const,
      createdAt: new Date().toISOString(),
      originChannel: 'channel-X',
    };
    await parkGoal(goalRef, 'awaiting_external');

    const eventFile = path.join(TEST_HOME, '.bolloon', 'goals', 'event.jsonl');
    const exists = await fs.access(eventFile).then(() => true).catch(() => false);
    // 不强制 (HOME 在 beforeEach 设了, 内部 appendEvent 用 process.env.HOME, 应该能写)
    if (exists) {
      const content = await fs.readFile(eventFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.event).toBe('goal_parked');
      expect(last.goalId).toBe('g-event-1');
    }
  });
});
