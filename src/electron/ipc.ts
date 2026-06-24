/**
 * IPC handler 集中注册 — version / userData path / open-external (legacy 3 个)
 * dialog/fs 的注册在 dialogs.ts; updater 的注册在 updater.ts
 */
import { app, ipcMain, shell } from 'electron';
import { userDataDir, dataDir } from './paths';
import { log } from './logger';

export function registerCoreIpc(): void {
  ipcMain.handle('get-version', () => app.getVersion());

  ipcMain.handle('get-user-data-path', () => userDataDir());
  ipcMain.handle('get-data-path', () => dataDir()); // 跟 userData 分开, 渲染层要用

  ipcMain.handle('open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  log('core IPC handlers registered');
}
