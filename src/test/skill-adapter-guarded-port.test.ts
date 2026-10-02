/**
 * 2026-10-02 (K7): SkillAdapter 的受门执行端口 —— skill 路径与主工具路径共用一扇门的前置。
 * (K7 台账 `K7_BYPASS_CANDIDATES` 里 skill 那条: 两条 skill 执行路径必须收敛成唯一且经门的入口)
 * 三条契约: ① 未注入 ⇒ 旧行为 ② 注入 ⇒ 执行只走端口 ③ 端口抛错 ⇒ fail-closed (拒绝串, 不回落)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSkillAdapter } from '../bollharness-integration/skill-adapter.js';

describe('K7: SkillAdapter 受门端口 (executeSkill)', () => {
  it('① 未注入端口 ⇒ 仍旧走自己的 registry (旧语义: 未知 skill 由 registry 抛错, 不是 harness 拒绝)', async () => {
    const adapter = createSkillAdapter();
    expect(adapter.listSkills().length).toBeGreaterThan(0);
    await expect(adapter.executeSkill('__no_such_skill__', {})).rejects.toThrow();
    await adapter.executeSkill('__no_such_skill__', {}).catch((e: Error) => {
      expect(String((e as Error).message)).not.toContain('harness-error');
    });
  });

  it('② 注入端口 ⇒ 执行只走端口, 自己 registry 不再被调', async () => {
    const adapter = createSkillAdapter();
    const seen: string[] = [];
    adapter.setGuardedExecute(async (name, params) => {
      seen.push(`${name}:${JSON.stringify(params)}`);
      return '由端口执行';
    });
    const r = await adapter.executeSkill('arch', { action: 'x' });
    expect(r).toBe('由端口执行');
    expect(seen).toEqual(['arch:{"action":"x"}']);
  });

  it('③ 端口抛错 ⇒ fail-closed: 返回 拒绝: [harness-error] 且不落回 registry', async () => {
    const adapter = createSkillAdapter();
    adapter.setGuardedExecute(async () => { throw new Error('deny 判定崩了'); });
    const r = await adapter.executeSkill('arch', {});
    expect(r.startsWith('拒绝: [harness-error]')).toBe(true);
    expect(r).toContain('deny 判定崩了');
  });

  it('④ 机械: fail-closed 的落地形态在源码里 (端口分支在 try 内, 回落在其后)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/bollharness-integration/skill-adapter.ts'), 'utf8');
    const portIdx = src.indexOf('await this.guardedExecute(name, params)');
    const fallbackIdx = src.indexOf('return this.registry.execute(name, params);');
    expect(portIdx).toBeGreaterThan(0);
    expect(fallbackIdx).toBeGreaterThan(portIdx);
    expect(src.slice(portIdx, fallbackIdx)).toContain('harness-error');
  });
});
