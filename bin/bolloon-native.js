#!/usr/bin/env node
/**
 * `bolloon` 的真实入口 —— 直接启动**随包分发的 Rust 二进制**。
 *
 * 为什么不转发 dist/cli-entry.js: npm 包从 0.6.11 起发的是 Rust 编译产物,
 * 不是 TS 构建 (leo: "我要的 npm 是 Rust 编译的二进制发表的")。
 *
 * 职责只有三件:
 *   1. 按 process.platform / process.arch 找二进制
 *   2. 原样转发 argv / stdio / 退出码 (Ctrl+C、TTY、管道都一致)
 *   3. 找不到就**如实报错** (127), 不悄悄回落到别的实现
 *
 * 覆盖路径: BOLLOON_NATIVE_BIN=/path/to/bolloon
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ext = process.platform === 'win32' ? '.exe' : '';
const local = path.join(dir, `bolloon-native-${process.platform}-${process.arch}${ext}`);

const usable = (p) => {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
};

const bin = [process.env.BOLLOON_NATIVE_BIN, local].filter(Boolean).find(usable);
if (!bin) {
  const have = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('bolloon-native-'))
    .map((f) => f.replace('bolloon-native-', '').replace(/\.exe$/, ''))
    .sort();
  console.error(
    `[bolloon] 本包没有 ${process.platform}-${process.arch} 的原生二进制。\n` +
      `  · 本包已带: ${have.length ? have.join(', ') : '(无)'}\n` +
      `  · 自己编译: cargo build --release -p bolloon-cli, 然后 BOLLOON_NATIVE_BIN=<路径> bolloon`,
  );
  process.exit(127);
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', env: process.env });
child.on('error', (e) => {
  console.error(`[bolloon] 无法启动原生二进制 (${bin}): ${e.message}`);
  process.exit(126);
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 0 : code);
});
