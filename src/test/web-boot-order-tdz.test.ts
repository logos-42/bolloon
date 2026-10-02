/**
 * DID 目录启动顺序门 (2026-10-02)
 *
 * 病征: 开机日志出现
 *   `[did-catalog] OrbitDB 复制启动失败 (非致命, 稍后可用 API 重试): Cannot access 'userIdentityCache' before initialization`
 * —— "非致命"是兜底说法, 实际是**开机时 OrbitDB 复制根本没起来** (TDZ: `let` 声明晚于首次使用)。
 *
 * 这条门锁住**声明位置**: `userIdentityCache` 的声明必须早于 `loadOrCreateUserIdentity()` 的首次调用。
 * 行号会漂, 所以核的是**偏移顺序**而不是具体行号。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = () => fs.readFileSync(path.join(process.cwd(), 'src/web/server.ts'), 'utf8');

describe('web 启动顺序门: TDZ 类缺陷 (声明晚于首次使用)', () => {
  it('① `userIdentityCache` 声明必须早于 did-catalog 的首次调用', () => {
    const s = SRC();
    const decl = s.indexOf('let userIdentityCache');
    const use = s.indexOf('await loadOrCreateUserIdentity()');
    expect(decl).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect({ '声明早于使用': decl < use }).toEqual({ '声明早于使用': true });
  });

  it('② 为什么必须这样: 首次调用处在 did-catalog 的启动 IIFE 里 (与注释一起锁住意图)', () => {
    const s = SRC();
    const iife = s.indexOf('// 2026-08-08: DID 目录 → OrbitDB 自动复制');
    expect(iife).toBeGreaterThan(-1);
    const block = s.slice(iife, iife + 500);
    expect(block).toContain('await loadOrCreateUserIdentity()');   // 就是这里 await 了它
    expect(s).toContain('声明位置有硬约束');                        // 注释解释了为什么不能挪回去
  });
});
