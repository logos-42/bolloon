/**
 * 2026-10-02 (K7): SkillAdapter 的受门端口 —— 端口只给**判定**, 执行留在 adapter 的**唯一**执行点。
 * 四条契约 (对应 leo 的四条件):
 *  ① 未注入 ⇒ 旧行为一字不差
 *  ② allow=true ⇒ 恰执行一次 (端口调 1 次 + registry 真执行 1 次)
 *  ③ deny ⇒ **不进 registry** (返回拒绝串, 不是该 skill 的真实输出)
 *  ④ 端口抛错 ⇒ **fail-closed**: 拒绝串且同样不进 registry
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSkillAdapter } from '../bollharness-integration/skill-adapter.js';

describe('K7: SkillAdapter 受门端口 (判定契约)', () => {
  const aRealSkillName = (adapter: ReturnType<typeof createSkillAdapter>) => adapter.listSkills()[0]?.name ?? '';

  it('① 未注入 ⇒ 仍旧走自己的 registry (旧语义: 未知 skill 由 registry 抛错, 不是 harness 拒绝)', async () => {
    const adapter = createSkillAdapter();
    expect(adapter.listSkills().length).toBeGreaterThan(0);
    await expect(adapter.executeSkill('__no_such_skill__', {})).rejects.toThrow();
    await adapter.executeSkill('__no_such_skill__', {}).catch((e: Error) => {
      expect(String((e as Error).message)).not.toContain('harness-error');
    });
  });

  it('② allow=true ⇒ 端口调 1 次 + 落到 registry 真执行 1 次 (恰一次)', async () => {
    const adapter = createSkillAdapter();
    const name = aRealSkillName(adapter);
    expect(name).not.toBe('');
    let portCalls = 0;
    adapter.setGuardedExecute(async () => { portCalls++; return { allow: true }; });
    const r = await adapter.executeSkill(name, { action: 'x' });
    expect(portCalls).toBe(1);
    expect(typeof r).toBe('string');
    expect(r).not.toContain('拒绝:');
  });

  it('③ deny ⇒ 不进 registry: 返回拒绝串, 且**不是**该 skill 的真实输出', async () => {
    const adapter = createSkillAdapter();
    const name = aRealSkillName(adapter);
    adapter.setGuardedExecute(async () => ({ allow: false, rejectedBy: 'deny-pipeline', reason: '命中禁用规则' }));
    const r = await adapter.executeSkill(name, {});
    expect(r).toBe('拒绝: [deny-pipeline] 命中禁用规则');
  });

  it('④ 端口抛错 ⇒ fail-closed: 拒绝串 + 不回落 registry', async () => {
    const adapter = createSkillAdapter();
    const name = aRealSkillName(adapter);
    adapter.setGuardedExecute(async () => { throw new Error('门崩了'); });
    const r = await adapter.executeSkill(name, {});
    expect(r.startsWith('拒绝: [harness-error]')).toBe(true);
    expect(r).toContain('门崩了');
  });

  it('⑤ 机械: 唯一执行点 —— executeSkill 内只有一处 registry.execute, 且在判定之后', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/bollharness-integration/skill-adapter.ts'), 'utf8');
    const start = src.indexOf('async executeSkill(');
    const body = src.slice(start, src.indexOf('\n  }', start));
    const execSites = body.match(/this\.registry\.execute\(/g) || [];
    expect(execSites).toHaveLength(1);
    expect(body.indexOf('allow')).toBeLessThan(body.indexOf('this.registry.execute('));
  });
});
