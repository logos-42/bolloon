/**
 * 手机端 ⇄ PC 端 逻辑一致 (漂移检测) —— 2026-10-02, leo 口径:
 *   "手机端继续保持独立, 但是还是要和目前的 pc 端一致的逻辑 / 核是需要的"
 *
 * 机制上早就同源 (capacitor webDir=dist/web; build-ios-web 从 dist/web 组装 dist/ios),
 * 但**没有门拦漂移**: 实测出现过"修好的 bug 手机端还是旧一版"而没人发现。
 *
 * 这条直接跑 scripts/check-mobile-parity.mjs (逐字节比 171 个文件), 断言 exit 0。
 * 未构建 (dist/web 不存在) ⇒ 跳过 (CI 里先 build:web + cap copy)。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();

describe('手机端与 PC 端逻辑一致门', () => {
  it('① 两个原生壳里的 web 资源与源产物**逐字节一致** (不许分叉逻辑)', () => {
    if (!existsSync(path.join(ROOT, 'dist/web'))) return;   // 未构建 ⇒ 跳过
    const shellIos = path.join(ROOT, 'ios/App/App/public');
    const shellAndroid = path.join(ROOT, 'android/app/src/main/assets/public');
    if (!existsSync(shellIos) && !existsSync(shellAndroid)) return;   // 壳不存在 ⇒ 跳过

    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-mobile-parity.mjs')], { encoding: 'utf8', timeout: 120000 });
    } catch (e: any) {
      code = e.status ?? 1;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    expect({ code, 结论: out.split('\n').filter((l) => /结论|✗/.test(l)).slice(0, 6) }).toEqual({ code: 0, 结论: expect.anything() });
  });

  it('② 门本身在"源缺失/壳缺失"时**拒跑** (不静默跳过)', () => {
    const src = require('node:fs').readFileSync(path.join(ROOT, 'scripts/check-mobile-parity.mjs'), 'utf8');
    expect(src).toMatch(/源产物不存在 ⇒ 拒跑/);
    expect(src).toMatch(/原生壳 web 目录不存在 ⇒ 拒跑/);
    expect(src).toMatch(/分叉嫌疑/);
  });
});
