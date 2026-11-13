#!/usr/bin/env node
/**
 * 统一构建 / 自检随 npm 分发的 Rust 原生二进制。
 *
 * 2026-11-13 踩过的坑：跨机互联（DIAP 隧道 / Kademlia DHT / 手机号发现）是
 * `diap-backend` + `dht-backend` 两个 opt-in feature。若按裸
 * `cargo build --release -p bolloon-cli` 发版，装 npm 包的用户**用不了跨机交流**
 * （`/api/dht/status`、`/api/diap/addr` 只会回「未编译 feature」）。
 * 此脚本是唯一的发版构建入口，默认就带这两个 feature。
 *
 *   node scripts/build-native.mjs            # 构建两个 macOS 架构并放进 bin/
 *   node scripts/build-native.mjs --check    # 只校验现有产物（CI / 发版门禁）
 *   node scripts/build-native.mjs --targets x86_64-apple-darwin
 *
 * 自检三项：版本与 package.json 对齐、Mach-O 架构正确、二进制里确实含
 * 跨机 feature 的字符串常量（BOLLOON_DIAP / BOLLOON_DHT）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST = path.join(ROOT, 'rust');
const BIN = path.join(ROOT, 'bin');
const FEATURES = 'diap-backend,dht-backend';
const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const TARGETS = [
  { triple: 'x86_64-apple-darwin', file: 'bolloon-native-darwin-x64', arch: 'x86_64' },
  { triple: 'aarch64-apple-darwin', file: 'bolloon-native-darwin-arm64', arch: 'arm64' },
];

const checkOnly = process.argv.includes('--check');
const ti = process.argv.indexOf('--targets');
const only = ti >= 0 ? new Set((process.argv[ti + 1] || '').split(',').filter(Boolean)) : null;
const targets = TARGETS.filter((t) => !only || only.has(t.triple));

let bad = 0;
const say = (ok, msg, extra = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${msg}${extra ? ` :: ${extra}` : ''}`);
  if (!ok) bad++;
};

if (!checkOnly) {
  for (const t of targets) {
    console.log(`\n=== build ${t.triple} (features: ${FEATURES}) ===`);
    execFileSync('cargo', [
      'build', '--release', '-p', 'bolloon-cli',
      '--target', t.triple, '--features', FEATURES,
    ], { cwd: RUST, stdio: 'inherit' });
    const from = path.join(RUST, 'target', t.triple, 'release', 'bolloon');
    const to = path.join(BIN, t.file);
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o755);
    console.log(`→ ${path.relative(ROOT, to)}`);
  }
}

console.log(`\n=== check (npm ${want}) ===`);
for (const t of targets) {
  const p = path.join(BIN, t.file);
  if (!fs.existsSync(p)) {
    say(false, `${t.file} 存在`, '缺失，先跑 node scripts/build-native.mjs');
    continue;
  }
  const size = fs.statSync(p).size;
  say(true, `${t.file} 存在`, `${(size / 1024 / 1024).toFixed(1)} MB`);

  // 架构：用 file(1)；非 macOS 上降级为跳过
  try {
    const desc = execFileSync('file', [p], { encoding: 'utf8' });
    say(desc.includes(t.arch), `${t.file} Mach-O ${t.arch}`, desc.trim().slice(0, 110));
  } catch {
    console.log(`[SKIP] ${t.file} 架构检查（本机无 file 命令）`);
  }

  // 版本：只有能在本机执行的那个架构可以跑 --version
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  if (t.arch === hostArch) {
    try {
      const v = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
      say(v.includes(want), `${t.file} --version 与 npm 对齐`, `${v} (期望 ${want})`);
    } catch (e) {
      say(false, `${t.file} --version 可执行`, String(e.message || e).slice(0, 120));
    }
  } else {
    console.log(`[SKIP] ${t.file} --version（本机架构跑不了）`);
  }

  // 关键：feature 是否真的编进二进制（字符串常量来自 dht.rs / diap_hub.rs / server.rs）
  const raw = fs.readFileSync(p);
  for (const marker of ['BOLLOON_DIAP', 'BOLLOON_DHT_BOOTSTRAP', 'Kademlia DHT']) {
    say(raw.includes(Buffer.from(marker)), `${t.file} 含跨机 feature: ${marker}`);
  }
}

if (bad) {
  console.error(`\n${bad} 项自检失败 —— 不要发版。构建: node scripts/build-native.mjs`);
  process.exit(1);
}
console.log('\nALL PASS · 二进制版本/架构/跨机 features 三项对齐');
