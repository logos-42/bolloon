/**
 * 2026-10-02 (K7): skill 受门端口的**透传管路** —— integration 层对高层零依赖, 门由高层注入后透传给 adapter。
 * 这一条只证明"管路通" (注入点可达), 不证明"高层真的注入了" (那是下一步: pi-sdk/index 侧接线)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createBollharnessIntegration } from '../bollharness-integration/index.js';

describe('K7: skill 受门端口的透传 (BollharnessIntegration.setSkillGuard)', () => {
  it('① 未注入 ⇒ 执行结果仍旧来自真实 registry (不是空白端口)', async () => {
    const h = createBollharnessIntegration();
    const r = await h.executeSkill('__no_such_skill__', {});
    expect(typeof r.success).toBe('boolean');
    // 未知 skill: registry 会抛 ⇒ integration 包成 {success:false}; 关键是没有 harness-error 前缀
    expect(String(r.error ?? r.result ?? '')).not.toContain('harness-error');
  });

  it('② 注入后 ⇒ 结果只来自注入的门 (管路通: integration → adapter)', async () => {
    const h = createBollharnessIntegration();
    let seen = '';
    h.setSkillGuard(async (name, params) => { seen = `${name}|${JSON.stringify(params)}`; return '由门执行'; });
    const r = await h.executeSkill('arch', { action: 'x' });
    expect(seen).toBe('arch|{"action":"x"}');
    expect(r).toEqual({ success: true, result: '由门执行' });
  });

  it('③ 门抛错 ⇒ fail-closed 串照原样上抛到调用方 (可见, 不被吞)', async () => {
    const h = createBollharnessIntegration();
    h.setSkillGuard(async () => { throw new Error('deny 崩了'); });
    const r = await h.executeSkill('arch', {});
    expect(r.success).toBe(true);            // adapter 内部 fail-closed 后返回的是**串**
    expect(String(r.result)).toContain('拒绝: [harness-error]');
  });

  it('④ 机械: integration 层不许反向 import 高层 (分层干净 = 门只能由高层注入)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/bollharness-integration/integration.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/agents\/(pi-harness|pi-sdk)/);
    expect(src).toContain('this.skillAdapter.setGuardedExecute(guard)');
  });
});
