/**
 * Electron 主进程入口
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// 日志文件路径
const userDataPath = app.getPath('userData');
const logPath = path.join(userDataPath, 'bolloon.log');

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(logPath, line);
  console.log(msg);
}

log('Bolloon Electron 启动');

// 全局窗口引用
let mainWindow: BrowserWindow | null = null;
let httpServer: any = null;

// 防止多个实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('已有实例在运行，退出');
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function createWindow() {
  log('创建主窗口...');

  const width = 1200;
  const height = 800;
  const minWidth = 800;
  const minHeight = 600;

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    title: 'Bolloon Agent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: false,
  });

  const port = parseInt(process.env.ELECTRON_PORT || '54188');

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools();
  } else {
    log(`启动内置 Web 服务器...`);
    const { createWebServer } = await import('./web/server.js');
    const { server } = await createWebServer(port);
    httpServer = server;
    log(`Web 服务器启动完成: http://localhost:${port}`);

    await new Promise<void>((resolve) => {
      server.once('listening', () => {
        log('服务器已监听');
        resolve();
      });
    });

    mainWindow.loadURL(`http://localhost:${port}`);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log('窗口已显示');
  });

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

app.whenReady().then(async () => {
  log('Electron 准备好');
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  log('所有窗口已关闭');
  if (httpServer) {
    httpServer.close();
    log('HTTP 服务器已关闭');
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log('应用即将退出');
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-user-data-path', () => {
  return userDataPath;
});

ipcMain.handle('open-external', async (_, url: string) => {
  await shell.openExternal(url);
});

log('主进程初始化完成');