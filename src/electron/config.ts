/**
 * 常量配置 (env 解析在这里集中, 不散在 main 流程)
 */
import { app } from 'electron';

export const DEFAULT_PORT = 54188;
/** Hard-pin to loopback; LAN exposure must be explicit. */
export const DEFAULT_HOST = '127.0.0.1';

export const WEB_SERVER_STARTUP_TIMEOUT_MS = 15_000;

export const MAIN_WINDOW_DEFAULT = { width: 1200, height: 800 };
export const MAIN_WINDOW_MIN = { width: 800, height: 600 };

export function preferredPort(): number {
  const raw = process.env.ELECTRON_PORT || process.env.PORT;
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
