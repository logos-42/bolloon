/**
 * 首启检测 + 引导浮层
 *
 * 标记文件写在 userData (不是 ~/.bolloon/), 卸载 app 自然清掉
 * 引导窗是父主窗的 modal, frame=false, 透明背景; 关闭时标记写入
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { firstRunFlagPath, dataDir, logsDir } from './paths';
import { log } from './logger';

const OVERLAY_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; padding: 32px 28px;
    background: rgba(245,245,247,0.97);
    color: #1d1d1f;
    height: 100vh; box-sizing: border-box;
  }
  @media (prefers-color-scheme: dark) {
    body { background: rgba(28,28,30,0.97); color: #f5f5f7; }
  }
  h1 { font-size: 18px; margin: 0 0 14px; font-weight: 600; }
  p  { font-size: 13px; line-height: 1.55; margin: 8px 0; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px; padding: 1px 5px;
    background: rgba(0,0,0,0.06); border-radius: 3px;
  }
  @media (prefers-color-scheme: dark) {
    code { background: rgba(255,255,255,0.08); }
  }
  .btn {
    display: inline-block; margin-top: 18px; padding: 8px 18px;
    background: #007aff; color: #fff; border: none; border-radius: 6px;
    font-size: 13px; font-weight: 500; cursor: pointer;
  }
  .btn:hover { background: #0066d6; }
  ul { padding-left: 20px; }
  li { font-size: 13px; line-height: 1.7; }
</style>
</head>
<body>
<h1>欢迎使用 Bolloon Agent</h1>
<p>你的数据存放在本地, 不上传:</p>
<ul>
  <li>配置 / 频道 / P2P 密钥: <code id="data"></code></li>
  <li>运行日志: <code id="logs"></code></li>
</ul>
<p>所有数据在卸载后仍保留 — 想清理就手动删除 ~/.bolloon/。</p>
<button class="btn" id="ok">知道了</button>
<script>
  const ok = document.getElementById('ok');
  ok.addEventListener('click', () => window.electronAPI.markFirstRunSeen());
  document.getElementById('data').textContent = window.electronAPI.getDataPathSync?.() || '';
  document.getElementById('logs').textContent = window.electronAPI.getLogsPathSync?.() || '';
</script>
</body>
</html>
`;

export function hasSeenFirstRun(): boolean {
  try {
    return fs.existsSync(firstRunFlagPath());
  } catch {
    return false;
  }
}

export function markFirstRunSeen(): void {
  try {
    fs.mkdirSync(path.dirname(firstRunFlagPath()), { recursive: true });
    fs.writeFileSync(firstRunFlagPath(), new Date().toISOString());
  } catch (err) {
    log(`写入首启标记失败: ${(err as Error).message}`, 'warn');
  }
}

export function showFirstRunOverlay(parent: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      parent,
      modal: true,
      frame: false,
      transparent: true,
      width: 520,
      height: 360,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      title: 'Welcome',
    });

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML);
    overlay.loadURL(dataUrl);

    // 一次性的 IPC handler, 关闭后清掉避免累积
    const handler = () => {
      markFirstRunSeen();
      overlay.close();
    };
    ipcMain.once('first-run:ack', handler);

    overlay.on('closed', () => {
      ipcMain.removeListener('first-run:ack', handler);
      resolve();
    });
  });
}

/** 注册 IPC handlers (给 preload 桥用) */
export function registerFirstRunIpc(): void {
  ipcMain.handle('first-run:seen', () => hasSeenFirstRun());
  ipcMain.handle('first-run:mark-seen', () => { markFirstRunSeen(); });
  // 同步值 (不用 ipcRenderer.invoke 的 await) — 用 exposeInMainWorld 的 sync getter 更顺
  ipcMain.handle('first-run:data-dir', () => dataDir());
  ipcMain.handle('first-run:logs-dir', () => logsDir());
  log('first-run IPC handlers registered');
}

/** 包装 — 决定要不要弹 overlay */
export async function maybeShowFirstRun(parent: BrowserWindow): Promise<void> {
  if (hasSeenFirstRun()) return;
  log('首启 — 弹出引导');
  await showFirstRunOverlay(parent);
  app.addRecentDocument(firstRunFlagPath()); // 跟踪最近文档, 让 user 知道有这文件
}
