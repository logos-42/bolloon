/**
 * 切频道后身份必须"就地"生效 (2026-10-01, 用户报: 一个 session 内切换后身份找不对)。
 *
 * 根因: `updateIdentity` 上一版 `this.identity = { ...this.identity, ...updates }` ⇒ **换新对象**;
 *   而工具上下文在 registerTools() 时按**对象引用**捕获 identity, 且切频道时 session 是**复用**的
 *   (模块级单例, 只调 updateIdentity) ⇒ 工具里的 ctx.identity 永远指向旧对象
 *   ⇒ get_identity 一直返回**上一个频道**的身份。
 * 规矩: 身份对象**同一性**不能变 —— 只原地改字段 (谁都不必重新订阅)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('updateIdentity 必须原地改', () => {
  it('源码里不允许再出现 `this.identity = { ...this.identity` (换对象写法)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    // ⚠️ 必须排除**注释行** —— 源文件里那句"上一版是 this.identity = { ...this.identity }"的说明文字
    //   就是注释 (同类教训第三次: grep 计数当判据前先排除自己的注释 ✗)
    const code = src.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    const offenders = code.filter((l) => l.includes('this.identity = {') && l.includes('...this.identity'));
    expect(offenders, `还有换对象写法: ${offenders.join(' | ')}`).toEqual([]);
  });
  it('改为 Object.assign(this.identity, …) (原地)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    expect(src).toContain('Object.assign(this.identity, updates)');
  });
  it('**行为**: 原地改时, 旧引用看得到新值 (这正是工具上下文的情形)', () => {
    const holder = { did: 'did:key:OLD', name: '小龙' };   // 工具上下文持有的那个对象
    const ctx = { identity: holder };
    // 模拟 updateIdentity 的正确实现
    Object.assign(holder, { did: 'did:key:NEW', name: '小红' });
    expect(ctx.identity.did).toBe('did:key:NEW');           // 旧引用看得到 ✓
    expect(ctx.identity.name).toBe('小红');
    // 反例: 换对象写法 ⇒ 旧引用看不到 (这就是 bug)
    let cur = holder;
    cur = { ...cur, did: 'did:key:NEWER' } as any;
    expect(ctx.identity.did).not.toBe('did:key:NEWER');
  });
});
