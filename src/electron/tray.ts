/**
 * 系统托盘 — Show / Hide / Quit
 *
 * 图标资源要求 (需用户自备):
 *   build/trayTemplate.png  (mac, 16x16 + 32x32 @2x, 单色 alpha, 自动暗/亮)
 *   build/tray.png          (win/linux, 16x16 + 32x32)
 *
 * 若 build 目录没有 tray 图标, 降级为不创建托盘 (主菜单和窗口关闭行为不变)
 */
import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { buildResourcesDir } from './paths';
import { log } from './logger';

type WinGetter = () => BrowserWindow | null;

let trayInstance: Tray | null = null;

function loadTrayIcon(): Electron.NativeImage | null {
  const isMac = process.platform === 'darwin';
  const file = isMac ? 'trayTemplate.png' : 'tray.png';
  const iconPath = path.join(buildResourcesDir(), file);

  if (!fs.existsSync(iconPath)) {
    log(`托盘图标缺失: ${iconPath} (跳过托盘创建)`, 'warn');
    return null;
  }
  const img = nativeImage.createFromPath(iconPath);
  if (isMac) img.setTemplateImage(true);
  return img;
}

export function createTray(getMainWindow: WinGetter): void {
  if (trayInstance) return;

  const icon = loadTrayIcon();
  if (!icon) return;

  trayInstance = new Tray(icon);
  trayInstance.setToolTip(`Bolloon Agent v${app.getVersion()}`);

  const toggle = () => {
    const w = getMainWindow();
    if (!w) return;
    if (w.isVisible() && w.isFocused()) {
      w.hide();
    } else {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  };

  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => toggle() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        log('托盘菜单 Quit');
        app.quit();
      },
    },
  ]);

  trayInstance.setContextMenu(menu);

  // mac 默认 click 弹菜单, win/linux 默认 click 触发自定义
  if (process.platform !== 'darwin') {
    trayInstance.on('click', () => toggle());
  }
}

export function destroyTray(): void {
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }
}
