#!/usr/bin/env node
/**
 * check-mobile-parity.mjs — 手机端与 PC 端**逻辑一致**门 (2026-10-02)
 *
 * leo 的口径: **手机端继续保持独立, 但逻辑要与 PC 端一条 (核是需要的)**。
 *
 * 独立 = 自己的壳/包/入口 (Capacitor iOS/Android, dist/ios 用 mobile.html 当 index.html);
 * 一致 = 包里的 web 逻辑必须**逐字节**来自同一份源码产物 (src/web + src/kernel → dist/web → dist/ios),
 *        不许在原生壳里出现"只属于手机的分叉实现"。
 *
 * 为什么需要这道门: 机制上早就是同源 (capacitor.config.ts 的 webDir=dist/web; build-ios-web 从 dist/web 组装),
 * 但**没有任何东西拦住漂移** —— 2026-10-02 实测: 壳里的 client.js 与刚构建的产物 sha 不同 (旧一版),
 * 也就是说"修好的 bug 手机端还没拿到"而没人发现。
 *
 * 口径:
 *   · 源产物缺失 (dist/web 或 dist/ios) ⇒ **拒跑** (不静默跳过)
 *   · 壳目录缺失 ⇒ **拒跑** (手机端从未同步过 ⇒ 那本身就是要报的事实)
 *   · 共有文件 sha256 必须**逐字节相同**
 *   · 壳里**多出来**的文件: 只允许 Capacitor 自己注入的白名单 (capacitor.js / cordova.js / native-bridge.js);
 *     其余多出来的 = **分叉嫌疑**, 必须报出来 (手机端不许长出自己的逻辑)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Capacitor 同步时自己塞进去的文件 (不含业务逻辑), 允许壳里多出来 */
const CAP_ALLOWED_EXTRA = /^(capacitor\.js|cordova\.js|cordova_plugins\.js|native-bridge\.js|plugins\/)/;

const PAIRS = [
  { name: 'iOS', src: 'dist/ios', shell: 'ios/App/App/public' },
  { name: 'Android', src: 'dist/web', shell: 'android/app/src/main/assets/public' },
];

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.DS_Store') continue;
      walk(p, base, out);
    } else {
      if (e.name === '.DS_Store') continue;
      out.push(relative(base, p));
    }
  }
  return out;
}

let bad = 0;
const ok = (m, d = '') => console.log(`  ✓ ${m}${d ? ' — ' + d : ''}`);
const fail = (m, d = '') => { bad++; console.log(`  ✗ ${m}${d ? ' — ' + d : ''}`); };
const skip = (m, d = '') => console.log(`  · ${m}${d ? ' — ' + d : ''}`);

console.log('\n手机端 ⇄ PC 端 逻辑一致门 (逐字节)\n');

for (const { name, src, shell } of PAIRS) {
  const srcDir = join(ROOT, src);
  const shellDir = join(ROOT, shell);
  console.log(`${name}: ${src} ⇄ ${shell}`);

  if (!existsSync(srcDir)) {          // 拒跑: 拿不到事实
    fail(`${name}: 源产物不存在 ⇒ 拒跑`, `先跑 build:web (iOS 还要 build:ios-web)`);
    continue;
  }
  if (!existsSync(shellDir)) {
    fail(`${name}: 原生壳 web 目录不存在 ⇒ 拒跑 (从未同步过)`, `同步入口见 package.json 的 ios:sync / cap sync android`);
    continue;
  }

  const srcFiles = walk(srcDir);
  const shellFiles = walk(shellDir);
  const srcSet = new Set(srcFiles);
  const shellSet = new Set(shellFiles);

  const missing = srcFiles.filter((f) => !shellSet.has(f));
  const extra = shellFiles.filter((f) => !srcSet.has(f) && !CAP_ALLOWED_EXTRA.test(f));
  const drift = [];
  for (const f of srcFiles) {
    if (!shellSet.has(f)) continue;
    const a = sha(join(srcDir, f));
    const b = sha(join(shellDir, f));
    if (a !== b) drift.push({ f, a: a.slice(0, 8), b: b.slice(0, 8), size: statSync(join(shellDir, f)).size });
  }

  if (missing.length) fail(`${name}: 壳里缺 ${missing.length} 个文件 (手机端拿不到这些逻辑)`, missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' …' : ''));
  if (extra.length) fail(`${name}: 壳里多出 ${extra.length} 个**非 Capacitor** 文件 (分叉嫌疑)`, extra.slice(0, 5).join(', '));
  if (drift.length) {
    fail(`${name}: ${drift.length} 个文件与源产物**不一致** (手机端是旧一版逻辑)`,
      drift.slice(0, 4).map((d) => `${d.f} src=${d.a} shell=${d.b}`).join(' · '));
  }
  if (!missing.length && !extra.length && !drift.length) {
    ok(`${name}: ${srcFiles.length} 个文件逐字节一致 (同一份逻辑)`);
  }
}

console.log('');
if (bad) {
  console.log(`结论: ✗ ${bad} 项不一致 —— 手机端与 PC 端**逻辑漂移** (修法: 重新构建并 cap sync, 不要改壳里的文件)\n`);
  process.exit(1);
}
console.log('结论: ✓ 手机端与 PC 端逻辑一致 (独立部署, 同一份产物)\n');
