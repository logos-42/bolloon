/**
 * Spawns dist/web/server.js as a child Node process (via Electron's
 * ELECTRON_RUN_AS_NODE=1) and parses BOLLOON_PORT=NNNN to learn the
 * actually-bound port (which may have drifted from the preferred port
 * due to EADDRINUSE auto-bump).
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { bolloonHome } from '../bootstrap/env-loader.js';
import { log } from './logger';
import { WEB_SERVER_STARTUP_TIMEOUT_MS, DEFAULT_HOST } from './config';

// Resolve to the directory holding this file. See src/electron/window.ts for the rationale;
// this avoids the same `import.meta` / `__dirname` redeclaration conflicts that broke
// the electron tsconfig when esnext module mode was set.
const g = globalThis as { __dirname?: string; __filename?: string };
const __basedir: string = g.__dirname
  ?? (g.__filename ? path.dirname(g.__filename) : process.cwd());

// 打包后 (electron-builder asar / 手搓 .app) 主进程 __dirname = <app>/Contents/Resources/app/dist/electron-build,
// 而 web server 在 <app>/Contents/Resources/app/dist/web —— 从 electron-build 走 ../web 恰好正确;
// 但手搓 .app 运行时 globalThis.__dirname 可能指向外层 (Contents/MacOS), 用 app.getAppPath() 兜底解析。
function resolveWebServerScript(): string {
  const fromElectronBuild = path.join(__basedir, '..', 'web', 'server.js');
  if (fs.existsSync(fromElectronBuild)) return fromElectronBuild;
  // app.getAppPath() = <app>/Contents/Resources/app (asar 或手搓目录)
  const appPath = (() => {
    try { return require('electron').app.getAppPath(); } catch { return process.cwd(); }
  })();
  return path.join(appPath, 'dist', 'web', 'server.js');
}

let webServerProcess: ChildProcess | null = null;

export function getWebServerProcess(): ChildProcess | null {
  return webServerProcess;
}

export function killWebServer(): void {
  if (webServerProcess && !webServerProcess.killed) {
    log('终止 Web 服务器进程');
    webServerProcess.kill();
  }
  webServerProcess = null;
}

export function startWebServer(preferredPort: number): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const serverScript = resolveWebServerScript();
    log(`启动 Web 服务器进程: ${serverScript}`);

    // ELECTRON_RUN_AS_NODE=1 — packaged 时 process.execPath 是 Electron 二进制,
    // 没这行 require() 会失败. Dev 模式 (electron dist/electron.js) 同样情况.
    // 2026-10-24: 显式设 cwd=bolloonHome() (~/.bolloon 这种小目录) ——
    //   GUI 启动 (open .app) 默认 cwd 是 '/'; 若设成 HOME, bootstrapBolloon 会扫整个用户目录 (~4min) 才出 UI。
    //   bolloonHome 既小又快, 且是 agent 真正的数据根, 语义也对。
    webServerProcess = spawn(process.execPath, [serverScript], {
      cwd: bolloonHome(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        // 2026-10-24: 让 server.js 作为独立进程自启 createWebServer (否则只是库, 永不监听 → 白屏)
        BOLLOON_STANDALONE_SERVER: '1',
        // 2026-10-24: 桌面端跳过拉起 Kubo —— 冷启动期间 IPNS 发布必 30s 超时且本环境最终失败,
        //   跳过则 DID 发布降级内存 CID 并跳过 IPNS, 启动 ~60s → ~30s。核心本地功能不依赖 Kubo。
        BOLLOON_SKIP_KUBO: '1',
        PORT: String(preferredPort),
        ELECTRON_PORT: String(preferredPort),
        BOLLOON_HOST: DEFAULT_HOST,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrData = '';

    webServerProcess.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString();
      process.stdout.write(`[WebServer] ${data}`);
      const m = stdoutBuf.match(/^BOLLOON_PORT=(\d+)/m);
      if (m) {
        const actualPort = parseInt(m[1], 10);
        log(`Web 服务器就绪: 实际端口=${actualPort} (preferred=${preferredPort})`);
        resolve({ port: actualPort });
      }
    });

    webServerProcess.stderr?.on('data', (data: Buffer) => {
      stderrData += data.toString();
      process.stderr.write(`[WebServer ERR] ${data}`);
      log(`[WebServer stderr] ${data.toString().trim()}`, 'warn');
    });

    webServerProcess.on('error', (err) => {
      log(`Web 服务器启动失败: ${err.message}`, 'error');
      reject(err);
    });

    webServerProcess.on('exit', (code, signal) => {
      log(`Web 服务器退出: code=${code} signal=${signal}`);
      if (code !== 0 && code !== null) {
        log(`Web 服务器 stderr: ${stderrData.slice(0, 500)}`, 'error');
      }
      webServerProcess = null;
    });

    setTimeout(() => {
      if (webServerProcess && !webServerProcess.killed) {
        log(`Web 服务器启动超时 (${WEB_SERVER_STARTUP_TIMEOUT_MS}ms)`, 'error');
        reject(new Error('Web server startup timeout'));
      }
    }, WEB_SERVER_STARTUP_TIMEOUT_MS);
  });
}
