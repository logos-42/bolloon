/**
 * 文件 dialog 桥 (open / save / dir) + 安全的 fs 桥 (read / write / exists)
 *
 * 5MB read 上限保护 — 渲染进程直接 fs.readFile 没法做限制, 走主进程就有界
 * 所有 handler 解析 event.sender 拿到 window, 让 dialog 模态在该窗口上
 */
import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB

function windowFor(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function resolveSafe(target: string): string {
  // 不去硬限制路径 — user 给 renderer 暴露 fs 已经信任了, 这里只 normalize
  return path.resolve(target);
}

export function registerDialogIpc(): void {
  ipcMain.handle('dialog:open-file', async (event, opts: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory'>;
  } = {}) => {
    const win = windowFor(event);
    const result = await dialog.showOpenDialog(win!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: opts.properties ?? ['openFile'],
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle('dialog:save-file', async (event, opts: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  } = {}) => {
    const win = windowFor(event);
    const result = await dialog.showSaveDialog(win!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    return { canceled: result.canceled, filePath: result.filePath };
  });

  ipcMain.handle('dialog:open-directory', async (event, opts: {
    title?: string;
    defaultPath?: string;
  } = {}) => {
    const win = windowFor(event);
    const result = await dialog.showOpenDialog(win!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle('fs:read-text-file', async (_event, opts: {
    path: string;
    encoding?: BufferEncoding;
  }) => {
    const target = resolveSafe(opts.path);
    const stat = fs.statSync(target);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`文件过大: ${stat.size} > ${MAX_READ_BYTES} bytes`);
    }
    return fs.readFileSync(target, { encoding: opts.encoding ?? 'utf8' });
  });

  ipcMain.handle('fs:write-text-file', async (_event, opts: {
    path: string;
    content: string;
    encoding?: BufferEncoding;
  }) => {
    const target = resolveSafe(opts.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, opts.content, { encoding: opts.encoding ?? 'utf8' });
  });

  ipcMain.handle('fs:path-exists', async (_event, opts: { path: string }) => {
    try {
      fs.accessSync(resolveSafe(opts.path));
      return true;
    } catch {
      return false;
    }
  });

  log('dialog + fs IPC handlers registered');
}
