/**
 * Electron 主进程入口
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

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
let webServerProcess: ChildProcess | null = null;

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

function startWebServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(__dirname, 'web', 'server.js');
    log(`启动 Web 服务器进程: ${serverScript}`);

    webServerProcess = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        ELECTRON_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    let stderrData = '';

    webServerProcess.stdout?.on('data', (data: Buffer) => {
      stdoutData += data.toString();
      process.stdout.write(`[WebServer] ${data}`);
    });

    webServerProcess.stderr?.on('data', (data: Buffer) => {
      stderrData += data.toString();
      process.stderr.write(`[WebServer ERR] ${data}`);
    });

    webServerProcess.on('error', (err) => {
      log(`Web 服务器进程启动失败: ${err}`);
      reject(err);
    });

    webServerProcess.on('exit', (code, signal) => {
      log(`Web 服务器进程退出: code=${code} signal=${signal}`);
      if (code !== 0 && code !== null) {
        log(`Web 服务器 stderr: ${stderrData}`);
      }
    });

    // 等待服务器就绪 - 检查 stdout 中的标记
    const checkReady = setInterval(() => {
      if (stdoutData.includes('服务器已监听') || stdoutData.includes('Web 服务器启动完成')) {
        clearInterval(checkReady);
        log('Web 服务器进程已就绪');
        resolve();
      }
    }, 200);

    // 超时
    setTimeout(() => {
      clearInterval(checkReady);
      if (webServerProcess?.killed === false) {
        log('Web 服务器启动超时');
        reject(new Error('Web server startup timeout'));
      }
    }, 15000);
  });
}

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
    try {
      log(`启动内置 Web 服务器...`);
      await startWebServer(port);
      mainWindow.loadURL(`http://localhost:${port}`);
    } catch (err) {
      log(`启动服务器失败: ${err}`);
      console.error('启动服务器失败:', err);
    }
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
  if (webServerProcess) {
    webServerProcess.kill();
    log('Web 服务器进程已终止');
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log('应用即将退出');
  if (webServerProcess) {
    webServerProcess.kill();
  }
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