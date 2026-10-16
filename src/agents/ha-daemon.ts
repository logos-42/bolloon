/**
 * ha-daemon.ts — 独立 kernel 守护进程入口 (业务侧宿主, 2026-10-16, leo: 双内核冗余 — 拆独立 kernel 守护进程)
 *
 * 由主进程 spawn (见 ha-supervisor.ts 的 startHaDaemon): `node dist/agents/ha-daemon.js --role standby --home <HOME>`
 * 职责: 以 **standby** 角色运行 HA 守护循环 —— 探测主进程心跳, 主死则接管其 orphan run。
 *
 * 位置说明: **不放在 src/kernel/** — kernel 目录有 K1 边界门 (禁 import 业务); 本文件要注入 run-store
 * 的 reconcileOrphans/prepareResume, 是**业务侧宿主**, 放 src/agents/。kernel/ha/ 只留纯机制
 * (ha-arbiter 心跳格式/锁/决策 + ha-guard 守护循环, 端口注入), 零业务依赖。
 *
 * 环境变量:
 *   BOLLOON_HOME          数据目录 (缺省 ~/.bolloon)
 *   BOLLOON_HA_BEAT_MS    心跳间隔 (缺省 10s)
 *   BOLLOON_HA_STALE_MS   心跳过期阈值 (缺省 30s)
 *
 * 退出: SIGTERM/SIGINT → 停心跳 → exit(0); 父进程退出 → 管道关闭 → 退出 (不孤儿存活)。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { startHaGuard, type HaGuardPorts } from '../kernel/ha/ha-guard.js';
import { runsDir } from './run-store.js';

const home = process.env.BOLLOON_HOME || os.homedir();
const beatMs = Number(process.env.BOLLOON_HA_BEAT_MS) || 10_000;
const staleMs = Number(process.env.BOLLOON_HA_STALE_MS) || 30_000;

// 2026-10-16: run-store 的 runsDir() 用 os.homedir() (POSIX 读 $HOME)。
//   设置了 BOLLOON_HOME = daemon 操作隔离数据目录 → 无条件把 $HOME 指过去
//   (daemon 是独立 spawn 的守护进程, 改自己的 HOME 不影响主进程; 这里不设的话
//   reconcileOrphans/prepareResume 会读真实 ~/.bolloon/runs, 接不到隔离 runs 的孤儿)。
if (process.env.BOLLOON_HOME) {
  process.env.HOME = process.env.BOLLOON_HOME;
}

// 业务侧端口注入: run-store 实现 (守护循环不自己 import 业务, 由宿主注入)
const ports: HaGuardPorts = {
  reconcileOrphans: async () => {
    const { reconcileOrphans } = await import('./run-store.js');
    return reconcileOrphans();
  },
  prepareResume: async (runId: string) => {
    const { prepareResume } = await import('./run-store.js');
    const r = await prepareResume(runId);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  },
  collectActiveRunIds: async () => {
    // 2026-10-16: BOLLOON_HOME 优先 (隔离 HOME 的 daemon 读隔离 runs), 否则 fallback 真实 runsDir()
    const home = process.env.BOLLOON_HOME || '';
    const dir = home ? path.join(home, '.bolloon', 'runs') : runsDir();
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const active: string[] = [];
    for (const n of files) {
      if (!n.endsWith('.json') || n.endsWith('.bak')) continue;
      const id = n.replace(/\.json$/, '');
      if (/^(run|goal)_/.test(id)) active.push(id); // 保守: 只认 run/goal 前缀
    }
    return active;
  },
  log: (level, message) => {
    process.stdout.write(`[ha-daemon:${level}] ${message}\n`);
  },
};

const guard = startHaGuard(ports, {
  role: 'standby',
  home,
  kernelVersion: process.env.npm_package_version || '',
  beatMs,
  staleMs,
  onTakeover: (info) => {
    process.stdout.write(`[ha-daemon] 接管主进程: adopted=${info.adoptedRunIds.length} runs (${info.reason})\n`);
  },
});

process.stdout.write(`[ha-daemon] 启动 role=standby pid=${process.pid} home=${home} beat=${beatMs}ms stale=${staleMs}ms\n`);

let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[ha-daemon] 收到 ${sig}, 停止心跳退出\n`);
  guard.stop();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { guard };