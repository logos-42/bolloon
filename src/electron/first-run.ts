/**
 * 首启检测 + 引导浮层
 *
 * 标记文件写在 userData (不是 ~/.bolloon/), 卸载 app 自然清掉
 * 引导窗是父主窗的 modal, frame=false, 透明背景; 关闭时标记写入
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
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
// 2026-10-24: 原先只调 markFirstRunSeen, 主进程监听的 first-run:ack 从没被触发 → modal 关不掉。
// 改为: 写标记后由页面自己 window.close() 关闭本 BrowserWindow, 主进程在 'closed' 里 resolve。
ok.addEventListener('click', () => {
  void window.electronAPI.markFirstRunSeen();
  window.close();
});
document.getElementById('data').textContent = window.electronAPI.getDataPathSync?.() || '';
document.getElementById('logs').textContent = window.electronAPI.getLogsPathSync?.() || '';
</script>
</body>
</html>
`;

/**
 * 2026-09-16 (Phase 3): 首启**事实**来自 SetupStore 的状态文件 (setup-state.json),
 * first-run flag 只决定"要不要自动弹窗"。Electron 不能用 flag 当初始化事实。
 */
export function readSetupFact(): { ready: boolean; stage: string; gate: string } {
  try {
    const p = path.join(os.homedir(), '.bolloon', 'setup-state.json');
    const js = JSON.parse(fs.readFileSync(p, 'utf8'));
    const stage = String(js?.stage || 'uninitialized');
    const ready = stage === 'ready';
    return { ready, stage, gate: ready ? 'ready' : (stage === 'needs_repair' ? 'repair' : stage === 'blocked' ? 'blocked' : 'setup') };
  } catch {
    return { ready: false, stage: 'uninitialized', gate: 'setup' };
  }
}

/** 未 ready → 显示 Onboard (无论 flag 是否已看过) */
export function shouldShowOnboard(): boolean {
  return !readSetupFact().ready;
}

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
      // 2026-10-24: 缺 preload ⇒ window.electronAPI undefined ⇒ data/logs 路径空白 + 点"知道了"抛错关不掉。
      //   OVERLAY_HTML 依赖 electronAPI.getDataPathSync / markFirstRunSeen, 必须与主窗口同一 preload。
      webPreferences: {
        preload: path.join(__dirname, '..', 'electron-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML);
    overlay.loadURL(dataUrl);

    // 页面点 "知道了" 会先 markFirstRunSeen 再 window.close() (见 OVERLAY_HTML), 这里只在关闭后 resolve。
    // 旧实现监听 first-run:ack, 但该 channel 从未被发送 → modal 关不掉, 已改为页面自关。
    overlay.on('closed', () => {
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
/**
 * 2026-09-16 (Phase 3): 是否弹引导 —— **事实来自 SetupStore** (setup-state.json), flag 只控制"已 ready 后是否还提示"。
 * 未 ready 时无论 flag 有没有都弹 (初始化没完成的机器不能装作已配置)。
 */
export async function maybeShowFirstRun(parent: BrowserWindow): Promise<void> {
  const fact = readSetupFact();
  if (fact.ready && hasSeenFirstRun()) return;
  if (!fact.ready) {
    log(`初始化未就绪 (stage=${fact.stage}, gate=${fact.gate}) — 弹出引导 (flag=${hasSeenFirstRun() ? '已看过' : '未看过'})`);
  } else {
    log('首启 — 弹出引导');
  }
  await showFirstRunOverlay(parent);
  app.addRecentDocument(firstRunFlagPath()); // 跟踪最近文档, 让 user 知道有这文件
}
