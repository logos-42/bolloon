/**
 * 待办/计划的 revision + 重注入 (2026-10-01 落实④)。
 * 两条性质: ① 每次写入 rev **单调递增**; ② 带 expectedRev 且过期 ⇒ **拒收**(不默默覆盖别人);
 *           ③ 注入段**有界**且只带 active 计划 (压缩后每轮重注入, 所以必须封顶)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlan, updatePlan, loadPlan, formatPlansForPrompt } from '../agents/plan-store.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-planrev-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('rev: 单调递增 + 乐观并发', () => {
  it('新建 = rev 1; 每次更新 +1; 过期 expectedRev ⇒ 拒收', async () => {
    const c = await createPlan({ goal: '测试目标', steps: ['第一步', '第二步'], originChannel: 'ch_t' } as any, TMP);
    expect(c.ok).toBe(true);
    const id = c.plan!.planId;
    expect((await loadPlan(id, TMP))!.rev).toBe(1);

    const u1 = await updatePlan(id, { stepId: c.plan!.steps[0].id, status: 'done' } as any, TMP);
    expect(u1.ok).toBe(true);
    expect(u1.plan!.rev).toBe(2);

    // 拿**旧** rev 来写 ⇒ 必须拒收
    const stale = await updatePlan(id, { stepId: c.plan!.steps[1].id, status: 'done', expectedRev: 1 } as any, TMP);
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain('已被更新');

    // 拿**当前** rev 来写 ⇒ 允许, 且 rev 再 +1
    const ok = await updatePlan(id, { stepId: c.plan!.steps[1].id, status: 'done', expectedRev: 2 } as any, TMP);
    expect(ok.ok).toBe(true);
    expect(ok.plan!.rev).toBe(3);
  });
  it('不带 expectedRev ⇒ 保持旧行为(无条件写), 兼容既有调用方', async () => {
    const c = await createPlan({ goal: '兼容性', steps: ['x'], originChannel: '' } as any, TMP);
    const u = await updatePlan(c.plan!.planId, { stepId: c.plan!.steps[0].id, status: 'done' } as any, TMP);
    expect(u.ok).toBe(true);
  });
});

describe('重注入段: 有界 + 只带 active', () => {
  it('空 ⇒ 空串; 有 active ⇒ 含目标/进度/rev; 超限 ⇒ 截断', () => {
    expect(formatPlansForPrompt([])).toBe('');
    const many = Array.from({ length: 6 }, (_, i) => ({
      planId: `p${i}`, goal: `目标${i}`, createdBy: 'agent' as const, createdAt: '', originChannel: '',
      steps: [{ id: 's', description: '步骤描述'.repeat(10), status: 'pending' as const }],
      status: 'active' as const, updatedAt: '', rev: 1,
    }));
    const out = formatPlansForPrompt(many as any, { maxChars: 300, maxItems: 3 });
    expect(out).toContain('每轮重注入');
    expect(out.length).toBeLessThanOrEqual(340);
    expect(out).toContain('目标0');
    expect(out).not.toContain('目标5');       // maxItems 封顶
    // done 的计划不出现
    const doneOnly = formatPlansForPrompt([{ ...many[0], status: 'done' }] as any);
    expect(doneOnly).toBe('');
  });
});

describe('挂点存在 (源级核对)', () => {
  it('系统提示每轮带上活跃计划段', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    expect(src).toContain('renderActivePlansSection');
    expect(src).toContain('formatPlansForPrompt');
  });
});
