/**
 * 简单 logger: 写日志到 <userData>/logs/bolloon.log, size-based 轮转
 * (5MB 上限, 保留 .1 .2 .3 共 3 个备份 → ~20MB 上限)
 *
 * 同步写是因为 Electron 主进程日志量小, 同步 append 简单可靠, 不丢日志.
 * 量大的会话级 jsonl 走自己路径 (lifecycle-hooks 等), 跟本 logger 无关.
 */
import * as fs from 'fs';
import * as path from 'path';
import { mainLogPath, logsDir } from './paths';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS = 3; // 保留 bolloon.log.1 .2 .3

let currentSize = 0;
let initialized = false;

function ensureLogFile(): void {
  if (initialized) return;
  initialized = true;
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    try {
      currentSize = fs.statSync(mainLogPath()).size;
    } catch {
      currentSize = 0;
    }
  } catch (err) {
    // 失败也无所谓, log() 内部会 swallow
    currentSize = 0;
    console.error('[logger] ensureLogFile failed:', err);
  }
}

function rotate(): void {
  const logPath = mainLogPath();
  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (i === MAX_BACKUPS) {
      try { fs.unlinkSync(src); } catch { /* missing ok */ }
    } else {
      try { fs.renameSync(src, dst); } catch { /* missing ok */ }
    }
  }
  try { fs.renameSync(logPath, `${logPath}.1`); } catch { /* missing ok */ }
  currentSize = 0;
}

export type LogLevel = 'info' | 'warn' | 'error';

export function log(message: string, level: LogLevel = 'info'): void {
  ensureLogFile();
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;

  if (currentSize + line.length > MAX_BYTES) rotate();

  try {
    fs.appendFileSync(mainLogPath(), line);
    currentSize += line.length;
  } catch (err) {
    // 写不进就 console, 不要再递归 log
    console.error('[logger] appendFileSync failed:', err);
  }

  if (level === 'error') console.error(line.trimEnd());
  else if (level === 'warn') console.warn(line.trimEnd());
  else console.log(line.trimEnd());
}
