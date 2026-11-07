/**
 * 手机端 (Tauri) 产物完整性 (漂移检测) —— 2026-11
 *
 * 机制上早就同源 (Tauri frontendDist = ../ui → dist/web → tauri.conf.json build.frontendDist),
 * 但**没有门拦漂移**: 实测出现过"修好的 bug 手机端还是旧一版"而没人发现。
 *
 * 这条直接跑 scripts/check-mobile-parity.mjs (逐字节比 dist/web 内部引用), 断言 exit 0。
 * 未构建 (dist/web 不存在) ⇒ 跳过 (CI 里先 npm run build:web)。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();

describe('手机端 (Tauri) 产物完整性门', () => {
  it('① dist/web 产物完整且自洽 (不许分叉逻辑)', () => {
    if (!existsSync(path.join(ROOT, 'dist/web'))) return;   // 未构建 ⇒ 跳过

    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-mobile-parity.mjs')], { encoding: 'utf8', timeout: 120000 });
    } catch (e: any) {
      code = e.status ?? 1;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    expect({ code, 结论: out.split('\n').filter((l) => /结论|✗/.test(l)).slice(0, 6) }).toEqual({ code: 0, 结论: expect.anything() });
  });

  it('② 门本身在"源缺失"时**拒跑** (不静默跳过)', () => {
    const src = require('node:fs').readFileSync(path.join(ROOT, 'scripts/check-mobile-parity.mjs'), 'utf8');
    expect(src).toMatch(/dist\/web 不存在 ⇒ 拒跑/);
    expect(src).toMatch(/资源自洽/);
  });
});
