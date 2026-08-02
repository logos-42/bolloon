import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createPlan,
  loadPlan,
  updatePlan,
  reviewPlan,
  listActivePlans,
  planToContext,
} from '../agents/plan-store.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-plan-store-test-${Date.now()}`);
let oldHome = '';

describe('plan-store', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('createPlan 落盘 + 结构正确', async () => {
    const r = await createPlan({ goal: '写一个 P2P 模块', steps: ['读需求', '写代码', '测试'] });
    expect(r.ok).toBe(true);
    expect(r.plan!.steps).toHaveLength(3);
    expect(r.plan!.steps[0].status).toBe('pending');
    expect(r.plan!.status).toBe('active');

    const loaded = await loadPlan(r.plan!.planId);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe('写一个 P2P 模块');
  });

  it('updatePlan 勾选完成', async () => {
    const r = await createPlan({ goal: '测试更新', steps: ['步骤A', '步骤B'] });
    const u = await updatePlan(r.plan!.planId, { stepId: 'step_1', status: 'done', note: '完成' });
    expect(u.ok).toBe(true);
    expect(u.plan!.steps[0].status).toBe('done');
    expect(u.plan!.steps[0].note).toBe('完成');
  });

  it('updatePlan 追加步骤', async () => {
    const r = await createPlan({ goal: '测试追加', steps: ['步骤A'] });
    const u = await updatePlan(r.plan!.planId, { appendSteps: ['步骤B', '步骤C'] });
    expect(u.ok).toBe(true);
    expect(u.plan!.steps).toHaveLength(3);
  });

  it('updatePlan finish 收尾 (未完成标 blocked)', async () => {
    const r = await createPlan({ goal: '测试收尾', steps: ['步骤A', '步骤B'] });
    await updatePlan(r.plan!.planId, { stepId: 'step_1', status: 'done' });
    const u = await updatePlan(r.plan!.planId, { finish: true });
    expect(u.ok).toBe(true);
    expect(u.plan!.status).toBe('done');
    expect(u.plan!.steps[0].status).toBe('done');
    expect(u.plan!.steps[1].status).toBe('blocked');
  });

  it('reviewPlan 写审查结论', async () => {
    const r = await createPlan({ goal: '测试审查', steps: ['步骤A', '步骤B'] });
    await updatePlan(r.plan!.planId, { stepId: 'step_1', status: 'done' });
    await updatePlan(r.plan!.planId, { stepId: 'step_2', status: 'done' });
    const rv = await reviewPlan(r.plan!.planId, '全部完成, 测试通过');
    expect(rv.ok).toBe(true);
    expect(rv.plan!.review!.completedSteps).toBe(2);
    expect(rv.plan!.review!.summary).toContain('测试通过');
  });

  it('listActivePlans 只列 active', async () => {
    const r = await createPlan({ goal: '活跃计划', steps: ['步骤A'] });
    const d = await createPlan({ goal: '已完成计划', steps: ['步骤X'] });
    await updatePlan(d.plan!.planId, { finish: true });
    const plans = await listActivePlans();
    expect(plans.some(p => p.planId === r.plan!.planId)).toBe(true);
    expect(plans.some(p => p.planId === d.plan!.planId)).toBe(false);
  });

  it('planToContext 渲染进度', async () => {
    const r = await createPlan({ goal: '渲染测试', steps: ['步骤A'] });
    const u = await updatePlan(r.plan!.planId, { stepId: 'step_1', status: 'done' });
    const text = planToContext(u.plan!);
    expect(text).toContain('📋');
    expect(text).toContain('✅');
  });
});
