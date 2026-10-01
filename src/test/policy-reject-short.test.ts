/**
 * 护栏拒绝的错误信息必须是**短形态** (2026-10-01)。
 * 现场: 真实机上「路径被护栏拒: …允许: <整张白名单, 含 bootstrap 临时目录>」✗
 *   ⇒ 这条超长文本 ① 填满反思框 ② 被当成最终回复(看着像"回复不完整") ③ 让熔断误判成"鉴权类错误" ⇒ 停摆。
 * 契约: ① 分类单列 policy 且在 auth 之前 ② reason 里不得出现临时目录 ③ reason 长度有界。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkWritePath, classifyError } from '../agents/shell-guard.js';
import { classifyError as cls } from '../agents/error-classifier.js';

describe('护栏拒绝的错误形态', () => {
  it('① 分类: 护栏拒 ⇒ policy(不是鉴权类)', () => {
    const c = cls('路径被护栏拒: 路径 \'www/_p1.html\' 不在白名单. 允许的根: docs/**');
    expect(c.cls).toBe('policy');
  });
  it('② 真实拒绝: reason 里没有临时目录、长度有界', () => {
    const r = checkWritePath('www/_p1.html');
    if (!r.allowed) {
      expect(r.reason).not.toMatch(/bolloon-bootstrap|\/var\/folders\//);
      expect(r.reason.length).toBeLessThan(400);
    }
  });
  it('③ 源码不再把整张表拼进 reason', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/shell-guard.ts'), 'utf-8');
    expect(src).toContain('shortRoots');
    expect(src).not.toMatch(/允许: \$\{allowlist\.join/);
  });
});
