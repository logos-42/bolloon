/**
 * 主窗口工厂 — preload 路径解析 + dev/prod loadURL + 外部链接走系统浏览器
 */
import { BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { log } from './logger';
import { isDev, MAIN_WINDOW_DEFAULT, MAIN_WINDOW_MIN, preferredPort } from './config';
import { startWebServer } from './server';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export async function createMainWindow(): Promise<void> {
  log('创建主窗口...');
  mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_DEFAULT.width,
    height: MAIN_WINDOW_DEFAULT.height,
    minWidth: MAIN_WINDOW_MIN.width,
    minHeight: MAIN_WINDOW_MIN.height,
    title: 'Bolloon Agent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // MCP/spawn 等需要 fs; 真正的隔离靠 preload 边界
      preload: path.join(__dirname, '..', 'electron-preload.js'),
    },
    show: false,
  });

  if (isDev) {
    // dev:web 用 tsx 起 server, 端口固定 preferredPort, 不会 EADDRINUSE 自增
    const port = preferredPort();
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools();
  } else {
    try {
      log('启动内置 Web 服务器...');
      const { port: actualPort } = await startWebServer(preferredPort());
      mainWindow.loadURL(`http://localhost:${actualPort}`);
    } catch (err) {
      log(`启动服务器失败: ${(err as Error).message}`, 'error');
      console.error('启动服务器失败:', err);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log('窗口已显示');
  });

  // 外部链接走系统浏览器, 不在 app 内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  log('窗口创建完成');
}

export function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
