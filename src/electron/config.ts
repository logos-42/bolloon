/**
 * 常量配置 (env 解析在这里集中, 不散在 main 流程)
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// 手搓打包 (scripts/build-app-bundle.cjs) 不走 electron-builder, app.isPackaged 不一定可信
// (实测在 macOS 手搓 .app 里返回 false, 会被判成 dev 分支 → 不起内嵌服务, 窗口空白)。
// 打包脚本会在 app 目录写入 .bolloon-packaged 作为权威判定; dev / electron-builder 产物走原逻辑。
const PACKAGED_MARKER = path.join(app.getAppPath(), '.bolloon-packaged');

export const DEFAULT_PORT = 54188;
/** Hard-pin to loopback; LAN exposure must be explicit. */
export const DEFAULT_HOST = '127.0.0.1';

// 内嵌 web server 冷启动 (DID 上传 IPFS + IPNS 发布 + MCP 发现) 实测 30~140s:
//   15s 硬超时会在 server 还没监听时就 reject → 窗口不 loadURL → 白屏 (2026-10-24 真跑打包产物撞出)。
//   默认 120s, 可用 BOLLOON_DESKTOP_SERVER_TIMEOUT_MS 覆盖 (诊断/慢机器)。
export const WEB_SERVER_STARTUP_TIMEOUT_MS = (() => {
  const raw = process.env.BOLLOON_DESKTOP_SERVER_TIMEOUT_MS;
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n >= 1000 ? n : 120_000;
})();

export const MAIN_WINDOW_DEFAULT = { width: 1200, height: 800 };
export const MAIN_WINDOW_MIN = { width: 800, height: 600 };

export function preferredPort(): number {
  const raw = process.env.ELECTRON_PORT || process.env.PORT;
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export const isDev =
  process.env.NODE_ENV === 'development' || (!app.isPackaged && !fs.existsSync(PACKAGED_MARKER));
