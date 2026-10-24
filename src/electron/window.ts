/**
 * 主窗口工厂 — preload 路径解析 + dev/prod loadURL + 外部链接走系统浏览器
 */
import { BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { log } from './logger';
import { isDev, MAIN_WINDOW_DEFAULT, MAIN_WINDOW_MIN, preferredPort } from './config';
import { startWebServer } from './server';

// Resolve to the directory holding this file. Electron's main process is always CJS
// (electron-builder sets extraMetadata.type=commonjs on the packaged app), so `__dirname`
// is the CJS magic global here. We read it via `globalThis` so the source compiles under
// both `module: commonjs` and `module: esnext` tsconfigs without TS2300 / TS1343 errors.
// Fallback to cwd is only hit if the runtime fully strips both (i.e. a future ESM electron).
declare const process: { cwd(): string };
const g = globalThis as { __dirname?: string; __filename?: string };
const __basedir: string = g.__dirname
  ?? (g.__filename ? path.dirname(g.__filename) : process.cwd());

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * 启动占位页: 内嵌 web server 冷启动 (IPFS/Kubo/P2P/DID/IPNS 引导) 可能要 30~140s,
 * 这期间不能让窗口白屏。此页每 1s 探测 http://localhost:<port>/, 一旦 200 就跳进真实 app。
 * 用 data: URL 内联, 无需额外文件、不依赖 bundle 拷贝。
 */
function buildLoadingUrl(port: number): string {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root{color-scheme:light dark}
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#0e0e10;color:#e8e8ea}
  .spinner{width:38px;height:38px;border:3px solid rgba(255,255,255,.15);
    border-top-color:#3b82f6;border-radius:50%;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .t{font-size:14px;opacity:.85}.s{font-size:12px;opacity:.5}
</style></head><body>
  <div class="spinner"></div>
  <div class="t">正在启动 Bolloon Agent…</div>
  <div class="s" id="st">初始化本地服务 (首次约 1–2 分钟)</div>
<script>
  const PORT=${port};
  // 2026-10-24: 必须用 127.0.0.1 而不是 localhost —— server 只 bind IPv4 loopback
  //   (src/web/server.ts DEFAULT_HOST='127.0.0.1'), 而 Chromium 的 fetch 对 'localhost'
  //   在 macOS 上可能只解析 ::1 (IPv6) ⇒ 探测永远失败 ⇒ 卡在"初始化"。
  const tryUrl = 'http://127.0.0.1:'+PORT+'/';
  let n=0;
  async function probe(){
    try{
      const r=await fetch(tryUrl,{method:'GET',cache:'no-store'});
      if(r.ok){ location.href=tryUrl; return; }
    }catch(e){}
    n++;
    if(n===5) document.getElementById('st').textContent='仍在初始化 P2P / IPFS 节点…';
    if(n===30) document.getElementById('st').textContent='首次启动较慢, 请稍候 (最长约 2 分钟)';
    setTimeout(probe,1000);
  }
  probe();
</script></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

export async function createMainWindow(): Promise<void> {
  log('创建主窗口...');
  mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_DEFAULT.width,
    height: MAIN_WINDOW_DEFAULT.height,
    minWidth: MAIN_WINDOW_MIN.width,
    minHeight: MAIN_WINDOW_MIN.height,
    title: 'Bolloon Agent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // MCP/spawn 等需要 fs; 真正的隔离靠 preload 边界
      preload: path.join(__basedir, '..', 'electron-preload.js'),
    },
    show: false,
  });

  if (isDev) {
    // dev:web 用 tsx 起 server, 端口固定 preferredPort, 不会 EADDRINUSE 自增
    const port = preferredPort();
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools();
  } else {
    // 2026-10-24: 先立刻显示 loading 页 (自带轮询重定向), 避免内嵌服务冷启动
    //   (IPFS/Kubo/P2P/DID/IPNS 引导约 30~140s) 期间窗口长期隐藏/白屏。
    //   loading 页会每 1s 探测实际端口, 一旦 web server 监听成功就跳进真实 app ——
    //   即使 startWebServer 超时也自愈, 绝不永久白屏。
    const port = preferredPort();
    mainWindow.loadURL(buildLoadingUrl(port));

    try {
      log('启动内置 Web 服务器...');
      const { port: actualPort } = await startWebServer(port);
      log(`内嵌服务就绪, 切换到 http://127.0.0.1:${actualPort}`);
      if (!mainWindow.isDestroyed()) mainWindow.loadURL(`http://127.0.0.1:${actualPort}`);
    } catch (err) {
      // 超时/失败不致命: loading 页的轮询会在 server 就绪后自动跳转
      log(`启动服务器超时/失败 (server 可能仍在后台就绪): ${(err as Error).message}`, 'warn');
      console.warn('启动服务器失败:', err);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log('窗口已显示');
  });

  // 外部链接走系统浏览器, 不在 app 内开新窗口
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

export function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
