/**
 * 路径常量 — 单一来源, 避免散落各处
 *
 * dataDir: 用户数据 (LLM config / P2P secret / 频道 JSON 等) — 故意保持在 ~/.bolloon/
 *          与 CLI 共用, 卸载 app 不删数据. 不要改这个路径, 不要做 userData 重定向.
 * userDataDir: Electron 的 app.getPath('userData'), 用来放日志 / 临时 / 锁文件
 * logsDir: userData 下的 logs/ 子目录
 */
import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';

export function dataDir(): string {
  return path.join(os.homedir(), '.bolloon');
}

export function userDataDir(): string {
  return app.getPath('userData');
}

export function logsDir(): string {
  return path.join(userDataDir(), 'logs');
}

export function mainLogPath(): string {
  return path.join(logsDir(), 'bolloon.log');
}

export function firstRunFlagPath(): string {
  return path.join(userDataDir(), '.bolloon-first-run-seen');
}

/** 资源目录: packaged 下是 process.resourcesPath/build, dev 下是 repo/build/ */
export function buildResourcesDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'build');
  }
  return path.join(app.getAppPath(), 'build');
}
