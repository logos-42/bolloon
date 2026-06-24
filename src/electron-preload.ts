/**
 * Electron Preload 脚本
 * 在渲染进程和主进程之间建立安全的通信桥梁
 * contextIsolation: true, nodeIntegration: false — 只能通过这里暴露的 API 触达主进程
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Unsub = () => void;

contextBridge.exposeInMainWorld('electronAPI', {
  // === 原有 (保留) ===
  getVersion: () => ipcRenderer.invoke('get-version'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // === 新增: 数据目录 ===
  getDataPath: () => ipcRenderer.invoke('get-data-path'),

  // === 新增: 文件 dialog ===
  openFile: (opts?: any) => ipcRenderer.invoke('dialog:open-file', opts),
  saveFile: (opts?: any) => ipcRenderer.invoke('dialog:save-file', opts),
  openDirectory: (opts?: any) => ipcRenderer.invoke('dialog:open-directory', opts),

  // === 新增: 文件系统 (限大小, 主进程守卫) ===
  readTextFile: (opts: { path: string; encoding?: string }) =>
    ipcRenderer.invoke('fs:read-text-file', opts),
  writeTextFile: (opts: { path: string; content: string; encoding?: string }) =>
    ipcRenderer.invoke('fs:write-text-file', opts),
  pathExists: (opts: { path: string }) => ipcRenderer.invoke('fs:path-exists', opts),

  // === 新增: 首启引导 ===
  getFirstRunSeen: () => ipcRenderer.invoke('first-run:seen'),
  markFirstRunSeen: () => ipcRenderer.invoke('first-run:mark-seen'),
  getDataPathSync: () => ipcRenderer.invoke('first-run:data-dir'),
  getLogsPathSync: () => ipcRenderer.invoke('first-run:logs-dir'),

  // === 元数据 ===
  platform: process.platform,
});

// 类型声明
declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      getUserDataPath: () => Promise<string>;
      getDataPath: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      openFile: (opts?: any) => Promise<{ canceled: boolean; filePaths: string[] }>;
      saveFile: (opts?: any) => Promise<{ canceled: boolean; filePath?: string }>;
      openDirectory: (opts?: any) => Promise<{ canceled: boolean; filePaths: string[] }>;
      readTextFile: (opts: { path: string; encoding?: string }) => Promise<string>;
      writeTextFile: (opts: { path: string; content: string; encoding?: string }) => Promise<void>;
      pathExists: (opts: { path: string }) => Promise<boolean>;
      getFirstRunSeen: () => Promise<boolean>;
      markFirstRunSeen: () => Promise<void>;
      getDataPathSync: () => Promise<string>;
      getLogsPathSync: () => Promise<string>;
      platform: string;
    };
  }
}
