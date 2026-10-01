/**
 * 建群默认写入权限: **默认创建者独占**, 开放写入必须显式声明 (2026-10-01)。
 *
 * 背景: 老默认是 `write:['*']` —— 「谁拿到邀请链接都能写」是**隐式默认**, 10,000 agent 场景下是敞口。
 * 翻法 (不静默改行为): 默认改创建者独占; 产品的两个真调用点显式写 `acl: 'open'` (微信式群聊语义不变)。
 *
 * 这个门对**源码**断言 (会随变异判红) + 对 ACL 选项的**语义**断言:
 *   ① 源码里不许再出现"默认 ['*']"的写法; 默认那条路必须走"不传 AC 选项"(创建者独占);
 *   ② 两个真调用点必须**显式**声明 acl:'open' (隐式默认一旦回归, 报错指向这里);
 *   ③ groupAccessOptions 的语义: 空名单必须抛错 (否则会被 accessControllerOption 丢掉 ⇒ 悄悄落回默认)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf-8');

describe('建群写入权限的默认口径', () => {
  it('gateway-group: 不许再有"默认 write:[*]"; 默认那条路必须不传 AC 选项', () => {
    const src = read('src/agents/gateway-group.ts');
    expect(src).not.toContain("let writeList: string[] = ['*']");
    expect(src).toContain('let writeList: string[] | null = null;');
    expect(src).toContain("writeList ? groupAccessOptions(writeList) : {}");
    // 开放写入只能是显式声明那条分支
    expect(src).toMatch(/else if \(opts\?\.acl === 'open'\)/);
  });

  it('两个真调用点必须显式声明 acl:open (行为不变, 但不再是隐式默认)', () => {
    expect(read('src/web/server.ts')).toContain("acl: 'open',");
    expect(read('src/web/routes-mobile-tasks.ts')).toContain("acl: 'open'");
  });

  it('groupAccessOptions 语义: 空名单抛错 (空的会被吞掉 ⇒ 悄悄落回默认)', async () => {
    const { groupAccessOptions } = await import('../orbitdb/group-access.js');
    expect(() => groupAccessOptions([])).toThrow();
    expect(groupAccessOptions(['*'])).toEqual({ accessController: { write: ['*'] } });
  });
});
