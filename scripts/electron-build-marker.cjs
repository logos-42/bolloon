/**
 * scripts/electron-build-marker.cjs — 在 dist/electron-build/ 写入 package.json {"type":"commonjs"}
 *
 * 背景 (2026-10-24 真跑打包产物撞出):
 *   - 仓库根 package.json 是 "type":"module" ⇒ tsc build:main 把整个 dist/ 编译成 ESM。
 *   - electron 主进程链 (tsconfig.electron.json, module: CommonJS) 编译到 dist/electron-build/*.js,
 *     是 CommonJS (require/module.exports)。
 *   - Electron 加载主进程时按「最近的 package.json」决定模块形态。打包后 app 根 package.json 是
 *     type: module, 若 dist/electron-build 没有自己的 package.json, 主进程会被当成 ESM 加载 ⇒
 *     require/module.exports 直接崩 (ReferenceError: require is not defined)。
 *   - 修法 = 给 dist/electron-build/ 单独标 commonjs, 与 dist/ 其余 ESM 井水不犯河水。
 *     (曾尝试反方向: 把 app 根标 commonjs + dist/web 标 module, 但 web server 会 import ../agents/*
 *      等跨目录 ESM, 根 commonjs 会把它们全打回 CJS ⇒ 仍崩。方向必须如此。)
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'dist', 'electron-build', 'package.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('[electron-build-marker] dist/electron-build/package.json → ' + fs.readFileSync(OUT, 'utf8').trim());