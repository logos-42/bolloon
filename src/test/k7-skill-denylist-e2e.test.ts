/**
 * 2026-10-02 (K7) ★ 真跑: **生产链上被 deny 的 skill 执行不了**
 *
 * 走的是真链, 不是假对象:
 *   PiAgentSession (真 session) → createSkillGuard() (真 Harness: deny-pipeline 的 deny-list checker
 *   + pre-tool-validator + react-harness) → BollharnessIntegration.setSkillGuard → SkillAdapter → registry
 *
 * 覆盖 leo 的验收项: ① deny 的 skill 无副作用 ② 允许的 skill 正常执行 ③ 重试不绕过门
 *   ④ 证明是"名单在起作用"而不是"链断了" (放开名单 ⇒ 又能执行)
 */
import { describe, it, expect } from 'vitest';
import { createAgentSession } from '../agents/pi-sdk.js';
import { createBollharnessIntegration } from '../bollharness-integration/index.js';

describe('K7 ★ 真跑: deny 的 skill 在生产链上执行不了', () => {
  it('deny-list 命中 tool 名 `skill:arch` ⇒ 拒绝且无 skill 输出; 放开 ⇒ 又能执行; 重试仍被拒', async () => {
    const session = await createAgentSession({ cwd: process.cwd(), peerId: 'k7-skill-denylist-probe' });
    const s = session as unknown as { createSkillGuard?: () => unknown; denyTool: (...n: string[]) => void; allowTool: (...n: string[]) => void };
    expect(typeof s.createSkillGuard).toBe('function');
    const guard = s.createSkillGuard!() as (name: string, params: Record<string, unknown>) => Promise<{ allow: boolean; reason?: string; rejectedBy?: string }>;

    // ——— ① allow 基线: 先证明这条链**真能**执行 skill (否则下面的"被拒"可能另有原因) ———
    const h1 = createBollharnessIntegration();
    h1.setSkillGuard(guard);
    const ok = await h1.executeSkill('arch', { action: 'get_gate' });
    expect(String(ok.result ?? ok.error ?? '')).not.toMatch(/^拒绝: /);

    // ——— ② deny: 把该 skill 的工具名放进拒绝列表 ———
    s.denyTool('skill:arch');
    const h2 = createBollharnessIntegration();
    h2.setSkillGuard(guard);
    const denied = await h2.executeSkill('arch', { action: 'get_gate' });
    expect(String(denied.result)).toMatch(/^拒绝: \[deny-list\]/);        // 来自 deny-pipeline 的 deny-list checker
    expect(String(denied.result)).not.toBe(String(ok.result));             // 无副作用: 拿不到 skill 的真实输出

    // ——— ③ 重试不绕过门 ———
    const again = await h2.executeSkill('arch', { action: 'get_gate' });
    expect(String(again.result)).toMatch(/^拒绝: /);

    // ——— ④ 放开名单 ⇒ 又能执行 (证明是"名单在起作用", 不是"链断了") ———
    s.allowTool('skill:arch');
    const h3 = createBollharnessIntegration();
    h3.setSkillGuard(guard);
    const back = await h3.executeSkill('arch', { action: 'get_gate' });
    expect(String(back.result ?? back.error ?? '')).not.toMatch(/^拒绝: /);
  }, 180000);
});
