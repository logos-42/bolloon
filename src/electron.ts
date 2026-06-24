/**
 * Electron 入口 shim — 真正逻辑在 src/electron/main.ts
 * (保留 src/electron.ts 平铺入口, 不动 package.json 的 dist/electron.js 解析)
 */
import './electron/main';
