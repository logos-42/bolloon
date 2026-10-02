/**
 * 2026-10-02 (K7): skill 受门端口的**透传管路** (integration 层对高层零依赖, 门由高层注入后透传)。
 * 只证明"管路通"; "高层真的注入了"是下一步 (index.ts 活路径) 的事, 这里不声称。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createBollharnessIntegration } from '../bollharness-integration/index.js';

describe('K7: skill 受门端口的透传 (BollharnessIntegration.setSkillGuard)', () => {
  it('① 未注入 ⇒ 结果仍来自真 registry (不是空白端口)', async () => {
    const h = createBollharnessIntegration();
    const r = await h.executeSkill('__no_such_skill__', {});
    expect(String(r.error ?? r.result ?? '')).not.toContain('harness-error');
  });

  it('② 判定 allow ⇒ 落到 registry; 判定 deny ⇒ 拒绝串回传到调用方 (可见, 不被吞)', async () => {
    const h = createBollharnessIntegration();
    h.setSkillGuard(async () => ({ allow: true }));
    const ok = await h.executeSkill('__no_such_skill__', {});   // 允许 ⇒ 落到 registry ⇒ 未知 skill 报错
    expect(ok.success).toBe(false);

    h.setSkillGuard(async () => ({ allow: false, rejectedBy: 'react-harness', reason: '越权' }));
    const denied = await h.executeSkill('__no_such_skill__', {});
    expect(denied.success).toBe(true);
    expect(String(denied.result)).toBe('拒绝: [react-harness] 越权');
  });

  it('③ 门抛错 ⇒ fail-closed 串上抛到调用方', async () => {
    const h = createBollharnessIntegration();
    h.setSkillGuard(async () => { throw new Error('deny 崩了'); });
    const r = await h.executeSkill('__no_such_skill__', {});
    expect(String(r.result)).toContain('拒绝: [harness-error]');
  });

  it('④ 机械: integration 不许反向 import 高层 + 透传语句必须在', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/bollharness-integration/integration.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/agents\/(pi-harness|pi-sdk)/);
    expect(src).toContain('this.skillAdapter.setGuardedExecute(guard)');
  });
});
