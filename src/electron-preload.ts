/**
 * Electron Preload 脚本
 * 在渲染进程和主进程之间建立安全的通信桥梁
 */
import { contextBridge, ipcRenderer } from 'electron';

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-version'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  platform: process.platform,
});

// 类型声明
declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      getUserDataPath: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      platform: string;
    };
  }
}