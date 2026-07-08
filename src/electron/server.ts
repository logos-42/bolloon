/**
 * Spawns dist/web/server.js as a child Node process (via Electron's
 * ELECTRON_RUN_AS_NODE=1) and parses BOLLOON_PORT=NNNN to learn the
 * actually-bound port (which may have drifted from the preferred port
 * due to EADDRINUSE auto-bump).
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { log } from './logger';
import { WEB_SERVER_STARTUP_TIMEOUT_MS, DEFAULT_HOST } from './config';

// Resolve to the directory holding this file. See src/electron/window.ts for the rationale;
// this avoids the same `import.meta` / `__dirname` redeclaration conflicts that broke
// the electron tsconfig when esnext module mode was set.
const g = globalThis as { __dirname?: string; __filename?: string };
const __basedir: string = g.__dirname
  ?? (g.__filename ? path.dirname(g.__filename) : process.cwd());

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
    const serverScript = path.join(__basedir, '..', 'web', 'server.js');
    log(`启动 Web 服务器进程: ${serverScript}`);

    // ELECTRON_RUN_AS_NODE=1 — packaged 时 process.execPath 是 Electron 二进制,
    // 没这行 require() 会失败. Dev 模式 (electron dist/electron.js) 同样情况.
    webServerProcess = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
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
