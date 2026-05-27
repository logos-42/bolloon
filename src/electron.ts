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

function createWindow() {
  log('创建主窗口...');

  // 计算窗口大小
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
      sandbox: false, // 允许加载本地模块
    },
    show: false, // 等内容加载完成再显示
  });

  // 加载应用
  const distPath = isDev
    ? path.join(__dirname, '..', 'dist', 'web')
    : path.join(__dirname, '..', 'app', 'dist', 'web');

  const indexPath = path.join(distPath, 'index.html');

  if (isDev) {
    // 开发模式：从本地服务器加载
    const port = process.env.PORT || '54188';
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools();
  } else {
    // 生产模式：从文件系统加载
    mainWindow.loadFile(indexPath);
  }

  // 显示窗口
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log('窗口已显示');
  });

  // 外部链接用浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  log(`窗口创建完成，加载: ${indexPath}`);
}

// Electron 准备好后创建窗口
app.whenReady().then(() => {
  log('Electron 准备好');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  log('所有窗口已关闭');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log('应用即将退出');
});

// IPC 处理器
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