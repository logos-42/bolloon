/**
 * 应用菜单 — macOS 标准 + File/Edit/View/Window/Help 自定义项
 * "Open Data Folder" 等会跨平台显示 (mac 也会出现, 不会冲突)
 */
import { app, Menu, MenuItemConstructorOptions, shell, BrowserWindow } from 'electron';
import { dataDir, logsDir } from './paths';
import { log } from './logger';

type WinGetter = () => BrowserWindow | null;

function openDataFolder(): void {
  shell.openPath(dataDir()).catch((e) => log(`open data folder 失败: ${e.message}`, 'error'));
}

function openLogsFolder(): void {
  shell.openPath(logsDir()).catch((e) => log(`open logs folder 失败: ${e.message}`, 'error'));
}

function openExternal(url: string): void {
  shell.openExternal(url).catch((e) => log(`openExternal 失败: ${e.message}`, 'error'));
}

export function buildAppMenu(getMainWindow: WinGetter): Menu {
  const isMac = process.platform === 'darwin';
  const win = getMainWindow();

  const appMenu: MenuItemConstructorOptions = {
    label: app.getName(),
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open Data Folder',
        accelerator: 'CmdOrCtrl+Shift+D',
        click: () => openDataFolder(),
      },
      {
        label: 'Open Logs Folder',
        accelerator: 'CmdOrCtrl+Shift+L',
        click: () => openLogsFolder(),
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => win?.webContents.reload(),
      },
      {
        label: 'Force Reload',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () => win?.webContents.reloadIgnoringCache(),
      },
      {
        label: 'Toggle DevTools',
        accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
        click: () => win?.webContents.toggleDevTools(),
      },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([{ type: 'separator' as const }, { role: 'front' as const }] as MenuItemConstructorOptions[])
        : ([{ role: 'close' as const }] as MenuItemConstructorOptions[])),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'GitHub Repository',
        click: () => openExternal('https://github.com/bolloon/bolloon'),
      },
      {
        label: 'Report Issue',
        click: () => openExternal('https://github.com/bolloon/bolloon/issues'),
      },
      { type: 'separator' },
      {
        label: 'About Bolloon Agent',
        click: () => {
          // 简单 about — 用 dialog 暂代 (避免再造 HTML 窗口)
          // 真实 about panel 在 macOS 是 app.role 触发的, 我们走菜单项即可
          const { dialog } = require('electron');
          dialog.showMessageBox({
            type: 'info',
            title: 'About Bolloon Agent',
            message: `Bolloon Agent v${app.getVersion()}`,
            detail: `P2P AI Document Agent\nData: ${dataDir()}\nLogs: ${logsDir()}`,
            buttons: ['OK'],
          }).catch(() => {});
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

export function installAppMenu(getMainWindow: WinGetter): void {
  Menu.setApplicationMenu(buildAppMenu(getMainWindow));
}
