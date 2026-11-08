#!/usr/bin/env node
/**
 * check-mobile-parity.mjs — 手机端 (Tauri) 产物完整性门 (2026-11)
 *
 * Tauri 模式下，Web 资源被嵌入到 Rust 二进制中 (frontendDist → tauri.conf.json build.frontendDist)。
 * 与 Capacitor 不同：不再把 dist/web 复制到 ios/App/App/public 或 android/assets/public，
 * 而是由 `cargo tauri build` 打包进 apk/ipa。
 *
 * 这道门检查:
 *   1. tauri.conf.json 存在，且 bundle.targets 包含 android/ios
 *   2. dist/web 产物存在，mobile.html / mobile.css / mobile.js 三件套齐全
 *   3. dist/web 内所有相对引用都在 dist/web 内 (与 build-web.assertSelfContained 同一套口径)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();
const DIST_WEB = join(ROOT, 'dist', 'web');
const TAURI_CONF = join(ROOT, 'rust', 'app-tauri', 'src-tauri', 'tauri.conf.json');

const REQUIRED_FILES = ['mobile.html', 'mobile.css', 'mobile.js', 'mobile-core.js'];

let bad = 0;
const ok = (m, d = '') => console.log(`  ✓ ${m}${d ? ' — ' + d : ''}`);
const fail = (m, d = '') => { bad++; console.log(`  ✗ ${m}${d ? ' — ' + d : ''}`); };

console.log('\n手机端 (Tauri) 产物完整性门\n');

// 1. tauri.conf.json
if (!existsSync(TAURI_CONF)) {
  fail('tauri.conf.json 不存在', TAURI_CONF);
} else {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  const targets = conf.bundle?.targets || [];
  const hasAndroid = targets.includes('android');
  const hasIos = targets.includes('ios');
  if (!hasAndroid || !hasIos) {
    fail('tauri.conf.json bundle.targets 缺少 android/ios', JSON.stringify(targets));
  } else {
    ok('tauri.conf.json bundle.targets 包含 android + ios');
  }
  if (conf.build?.frontendDist !== '../../../dist/web') {
    fail('frontendDist 应指向 ../ui', String(conf.build?.frontendDist));
  } else {
    ok('frontendDist = ../ui');
  }
}

// 2. dist/web 三件套 + 自洽性
if (!existsSync(DIST_WEB)) {
  fail('dist/web 不存在 ⇒ 拒跑', `先跑 npm run build:web`);
} else {
  for (const f of REQUIRED_FILES) {
    if (!existsSync(join(DIST_WEB, f))) fail(`dist/web 缺少 ${f}`);
    else ok(`dist/web/${f} 存在`);
  }

  // 3. 自检: dist/web 内所有相对引用都在 dist/web 内
  const htmls = ['index.html', 'mobile.html', 'explorer.html', 'api-config.html'];
  const queue = [];
  const seen = new Set();
  const missing = [];
  for (const h of htmls) {
    const p = join(DIST_WEB, h);
    if (existsSync(p)) queue.push(p);
  }
  while (queue.length > 0) {
    const abs = queue.shift();
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const src = readFileSync(abs, 'utf8').catch(() => '');
    const specs = [];
    if (abs.endsWith('.html')) {
      for (const m of src.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) specs.push(m[1]);
      for (const m of src.matchAll(/<link[^>]*\shref="([^"]+)"/g)) specs.push(m[1]);
    } else {
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) specs.push(m[1]);
    }
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const clean = spec.split('?')[0];
      if (!abs.endsWith('.html') && !/\.(js|mjs|json|css)$/.test(clean)) continue;
      const target = resolve(join(abs, '..'), clean);
      if (!(target === DIST_WEB || target.startsWith(DIST_WEB + sep))) {
        missing.push(`${relative(DIST_WEB, abs)} → ${spec}  ⚠ 逃出 dist/web`);
        continue;
      }
      if (!existsSync(target)) { missing.push(`${relative(DIST_WEB, abs)} → ${spec}`); continue; }
      if (/\.(js|mjs)$/.test(target)) queue.push(target);
    }
  }
  if (missing.length > 0) {
    fail(`dist/web 内有 ${missing.length} 处相对引用无法在 dist/web 内解析`);
    for (const b of missing.slice(0, 5)) console.log(`    ${b}`);
  } else {
    ok(`dist/web 资源自洽 (${seen.size} 个文件, 0 处逃出引用)`);
  }
}

console.log('');
if (bad) {
  console.log(`结论: ✗ ${bad} 项不通过 ⇒ 手机端产物不完整`);
  process.exit(1);
}
console.log('结论: ✓ 手机端 (Tauri) 产物完整\n');
