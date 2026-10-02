/**
 * 2026-10-02 (K7) ★ 真跑: **PiAgentSession.executeSkill 这个公开出口也必须过门** (leo 第 4 步 / 方案 a)
 *
 * 手法: 往**本会话 registry** 注册一个探针 skill (带调用计数), 于是每条断言都能落到"到底执没执行":
 *   允许 ⇒ 真执行且**恰一次** (计数 +1, 返回标记) · deny ⇒ **零执行** (计数不变, 无标记)
 *   重试 ⇒ 仍零执行 · 放开名单 ⇒ 又能执行
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentSession } from '../agents/pi-sdk.js';

describe('K7 ★ 真跑: session.executeSkill 走门 (公开出口零旁路)', () => {
  it('允许 ⇒ 执行一次返回真结果 · deny ⇒ 零执行 · 重试仍拒 · 放开 ⇒ 又能执行', async () => {
    const session = await createAgentSession({ cwd: process.cwd(), peerId: 'k7-session-skill-probe' });
    const s = session as unknown as {
      getSkillRegistry: () => { register: (sk: { name: string; description: string; execute: (p: Record<string, unknown>) => Promise<string> }) => void };
      denyTool: (...n: string[]) => void;
      allowTool: (...n: string[]) => void;
    };
    let executed = 0;
    s.getSkillRegistry().register({
      name: '__k7_probe__',
      description: 'K7 探针 skill (只为证明门是否承重)',
      execute: async () => { executed++; return 'PROBE_EXECUTED'; },
    });

    // ① 允许 ⇒ 真执行, 恰一次, 返回真结果
    expect(await session.executeSkill('__k7_probe__', {})).toBe('PROBE_EXECUTED');
    expect(executed).toBe(1);

    // ② deny ⇒ **零执行** (无副作用), 且是 deny-list 的拒绝串
    s.denyTool('skill:__k7_probe__');
    const denied = await session.executeSkill('__k7_probe__', {});
    expect(String(denied)).toMatch(/^拒绝: \[deny-list\]/);
    expect(executed).toBe(1);            // 计数没动 = 真的没执行

    // ③ 重试不绕过门
    const again = await session.executeSkill('__k7_probe__', {});
    expect(String(again)).toMatch(/^拒绝: /);
    expect(executed).toBe(1);

    // ④ 放开名单 ⇒ 又能执行 (证明是"名单"在起作用, 不是"链断了")
    s.allowTool('skill:__k7_probe__');
    expect(await session.executeSkill('__k7_probe__', {})).toBe('PROBE_EXECUTED');
    expect(executed).toBe(2);
  }, 180000);

  it('⑤ 机械: executeSkill 里只有一处 registry.execute, 且判定在它之前', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf8');
    const start = src.indexOf('async executeSkill(name: string');
    const body = src.slice(start, src.indexOf('\n  }', start));
    expect(body.match(/this\.skillRegistry\.execute\(/g) || []).toHaveLength(1);
    expect(body.indexOf('createSkillGuard()')).toBeLessThan(body.indexOf('this.skillRegistry.execute('));
    expect(body).toContain('harness-error');
  });
});
