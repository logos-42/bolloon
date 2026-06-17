// src/git-transport/chat-watch.ts
// 后台长循环: 定时 fetch + rebase + 解析新消息 + 打印到 stdout.
// 走 SIGHUP / SIGINT 优雅退出.

import * as fs from 'fs';
import * as path from 'path';
import { chatPull, chatStatus, resolveIdentity } from './chat-repo.js';
import { renderOneLine, dedupeKey } from './chat-render.js';
import { chatPaths, CHAT_DEFAULT_PULL_INTERVAL_MS, CHAT_PULL_BACKOFF_MAX_MS } from './chat-types.js';

export interface WatchOptions {
  repoDir: string;
  intervalMs?: number;
  onNew?: (lines: string[]) => void;
  onError?: (msg: string) => void;
  signal?: AbortSignal;
}

export async function chatWatch(opts: WatchOptions): Promise<void> {
  const repoDir = opts.repoDir;
  const interval = opts.intervalMs ?? CHAT_DEFAULT_PULL_INTERVAL_MS;
  const paths = chatPaths(repoDir);
  await fs.promises.mkdir(paths.stateDir, { recursive: true });

  // 启动时主动拉一次
  let backoff = interval;
  const seen: Record<string, number> = readJsonSafe(paths.seenFile, {});
  const id = await resolveIdentity();

  let stopped = false;
  const onAbort = () => { stopped = true; };
  if (opts.signal) opts.signal.addEventListener('abort', onAbort);

  const cleanup = () => {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  };

  process.on('SIGHUP', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  process.on('SIGTERM', () => { stopped = true; });

  // 启动 banner
  banner(id, repoDir, interval);

  while (!stopped) {
    try {
      const r = await chatPull({ repoDir });
      if (!r.ok) {
        const m = `[chat-watch] pull failed: ${r.reason ?? 'unknown'}`;
        opts.onError ? opts.onError(m) : console.error(m);
        backoff = Math.min(backoff * 1.5, CHAT_PULL_BACKOFF_MAX_MS);
      } else {
        backoff = interval;
        if (r.newMessages.length > 0) {
          const lines: string[] = [];
          for (const msg of r.newMessages) {
            const key = dedupeKey(msg);
            if (seen[key]) continue;
            seen[key] = Date.now();
            lines.push(renderOneLine(msg));
          }
          if (lines.length > 0) {
            opts.onNew ? opts.onNew(lines) : process.stdout.write(lines.join('\n') + '\n');
          }
        } else {
          // 5 分钟自打 ping, 防止 watchdog 30min 静默误杀
          if (shouldSelfPing()) {
            const st = await chatStatus({ repoDir });
            process.stdout.write(`[chat-watch] idle, role=${st.role} head=${st.head ?? '?'}\n`);
          }
        }
      }
      await writeJsonSafe(paths.seenFile, seen);
    } catch (e: any) {
      const m = `[chat-watch] loop error: ${e?.message ?? e}`;
      opts.onError ? opts.onError(m) : console.error(m);
    }

    // 退避 sleep, 但要响应停止信号
    for (let i = 0; i < backoff / 1000 && !stopped; i++) {
      await sleep(1000);
    }
  }

  cleanup();
  process.stdout.write('[chat-watch] stopped\n');
}

// helpers
function readJsonSafe<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return fallback; }
}
async function writeJsonSafe(p: string, v: any): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

let lastPing = 0;
function shouldSelfPing(): boolean {
  const now = Date.now();
  if (now - lastPing > 5 * 60_000) { lastPing = now; return true; }
  return false;
}

function banner(id: { role: string; publicKey: string }, repoDir: string, interval: number): void {
  process.stdout.write(`[chat-watch] role=${id.role} pk=${id.publicKey.slice(0, 12)} repo=${repoDir} interval=${interval}ms\n`);
  process.stdout.write(`[chat-watch] press Ctrl-C to stop\n`);
}
