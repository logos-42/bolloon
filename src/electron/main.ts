/**
 * Electron 主进程 lifecycle 入口
 * 单实例锁 → whenReady → createMainWindow → cleanup on quit
 * 启动时: 装 menu / tray / IPC handlers / 首启引导
 */
import { app, BrowserWindow } from 'electron';
import { log } from './logger';
import { createMainWindow, focusMainWindow, getMainWindow } from './window';
import { killWebServer } from './server';
import { installAppMenu } from './menu';
import { createTray, destroyTray } from './tray';
import { registerCoreIpc } from './ipc';
import { registerDialogIpc } from './dialogs';
import { registerFirstRunIpc, maybeShowFirstRun } from './first-run';
import { checkAndUpdate } from '../utils/auto-update.js';

log('Bolloon Electron 启动');

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('已有实例在运行，退出');
  app.quit();
}

app.on('second-instance', () => {
  focusMainWindow();
});

app.whenReady().then(async () => {
  log('Electron 准备好');
  registerCoreIpc();
  registerDialogIpc();
  registerFirstRunIpc();
  installAppMenu(getMainWindow);
  createTray(getMainWindow);

  // 启动自动更新检查（后台，不阻塞 UI）。
  // 2026-10-24 (P0): 桌面端尚未接入签名/公证/发布更新源, 暂不自动安装重启 —— onUpdated 只记录不退出,
  //   否则 checkAndUpdate 发现新版本时会 app.exit(0) 直接杀掉整个 app (白屏/闪退)。
  void (async () => {
    try {
      await checkAndUpdate({
        onUpdated: () => {
          log('[auto-update] 发现新版本 (桌面端暂不自动重启, 请手动更新)', 'warn');
        },
      });
    } catch {
      // 自动更新失败不影响主程序
    }
  })();

  await createMainWindow();

  // 首启引导 (在主窗口就绪后弹, 不阻塞 UI)
  const win = getMainWindow();
  if (win) {
    win.webContents.once('did-finish-load', () => {
      void maybeShowFirstRun(win);
    });
  }

  app.on('activate', async () => {
    // macOS: dock 图标被点击且没有窗口时, 重开
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  log('所有窗口已关闭');
  destroyTray();
  killWebServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log('应用即将退出');
  destroyTray();
  killWebServer();
});

log('主进程初始化完成');
