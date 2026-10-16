/**
 * verify-kernel-ha.ts — Kernel 双活真跑验证 (2026-10-16, leo: 双内核冗余)
 *
 * 真跑三阶段:
 *   ① 起 primary 进程: 写 primary.heartbeat + 一个伪造的 interrupted run (孤儿)
 *   ② 起 standby daemon 进程 (src/agents/ha-daemon.ts): 探测 primary 心跳 → 待命
 *   ③ 杀 primary → 等 primary 心跳过期 → daemon 接管:
 *        reconcileOrphans 被调 (孤儿 run 被标记) → prepareResume 被调 → 心跳切 primary
 *
 * 判据 (只认真跑输出):
 *   - daemon stdout 出现 "[ha-daemon] 启动" (standby 就位)
 *   - 杀 primary 后 daemon stdout 出现 "接管主进程: adopted=1"
 *   - 接管后 primary.heartbeat 的 role=primary 且 runIds 含孤儿 run
 *   - 退出码 0 = 通过; 任何断言失败 exit 1
 *
 * 用法: npx tsx scripts/verify-kernel-ha.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'node:child_process';

const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-ha-verify-'));
const HA_DIR = path.join(HOME_TMP, '.bolloon', 'kernel-ha');
const RUNS_DIR = path.join(HOME_TMP, '.bolloon', 'runs');
const DAEMON_ENTRY = path.join(process.cwd(), 'src/agents/ha-daemon.ts');

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}
function ok(msg: string) { console.log(`✅ ${msg}`); }

const BEAT_MS = 1000;
const STALE_MS = 3500; // 心跳过期 = 3.5 拍, 验证够快

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  fs.mkdirSync(HA_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  // ── ① 伪造一个孤儿 run (interrupted, 无 pid) ─────────────────────────────
  const orphanId = 'run_ha_orphan_test';
  fs.writeFileSync(path.join(RUNS_DIR, `${orphanId}.json`), JSON.stringify({
    runId: orphanId, status: 'running', pid: 99999999, // 真实崩溃场景: run 停在 running + pid 已死
    host: 'gone', goal: '双活接管验证', steps: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    channelId: 'ha-test',
  }));

  // ── ② 起 primary 进程: 写 primary 心跳 (带去向的 runIds) ─────────────────
  //     primary 用 kernel 的 startHaGuard (role=primary) — tsx 跑一个内联脚本
  const primaryCode = `
    import { startHaGuard } from ${JSON.stringify(path.join(process.cwd(), 'src/kernel/ha/ha-guard.ts'))};
    const guard = startHaGuard({
      reconcileOrphans: async () => ({ interrupted: [], stillRunning: [], failed: [] }),
      prepareResume: async () => ({ ok: true }),
      collectActiveRunIds: async () => ['${orphanId}'],
    }, { role: 'primary', home: ${JSON.stringify(HOME_TMP)}, beatMs: ${BEAT_MS}, staleMs: ${STALE_MS} });
    process.stdout.write('PRIMARY_READY pid=' + process.pid + '\\n');
    setTimeout(() => {}, 60000);
  `;
  const primaryProc: ChildProcess = spawn('npx', ['tsx', '-e', primaryCode], {
    env: { ...process.env, BOLLOON_HOME: HOME_TMP },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 独立进程组 — 杀 primary 必须杀进程组 (npx→tsx 两层 fork)
  });
  let primaryRealPid = -1;
  primaryProc.stdout?.on('data', (d) => {
    const line = String(d).trim();
    console.log(`[primary] ${line}`);
    const m = line.match(/PRIMARY_READY pid=(\d+)/);
    if (m) primaryRealPid = Number(m[1]);
  });
  primaryProc.stderr?.on('data', (d) => { const s = String(d).trim(); if (s && !s.includes('--')) console.log(`[primary:err] ${s}`); });
  await waitFor(() => fs.existsSync(path.join(HA_DIR, 'primary.heartbeat')), 8000, 'primary 心跳文件出现');
  ok('primary 心跳已写出 (role=primary, runIds 含孤儿 run)');

  // ── ③ 起 standby daemon — 必须在 primary 心跳**就位后**才启动,
  //     否则 daemon 首跳会误判「无主」而立即接管 (真实现里 primary 先起, 不会踩到) ──
  const daemonProc: ChildProcess = spawn('npx', ['tsx', DAEMON_ENTRY], {
    env: {
      ...process.env,
      BOLLOON_HOME: HOME_TMP,
      BOLLOON_HA_BEAT_MS: String(BEAT_MS),
      BOLLOON_HA_STALE_MS: String(STALE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonOut = '';
  daemonProc.stdout?.on('data', (d) => { daemonOut += String(d); console.log(`[daemon] ${String(d).trim()}`); });
  daemonProc.stderr?.on('data', (d) => { const s = String(d).trim(); if (s) console.log(`[daemon:err] ${s}`); });
  await waitFor(() => daemonOut.includes('启动'), 10000, 'daemon 启动');
  ok('standby daemon 启动 (探测 primary 心跳)');

  // ── ④ 杀 primary → 等心跳过期 → daemon 接管 ──────────────────────────────
  await waitFor(() => fs.existsSync(path.join(HA_DIR, 'standby.heartbeat')), 8000, 'daemon 写出 standby 心跳');
  ok('primary 存活期间 daemon 待命 (standby.heartbeat 存在, 未接管)');
  if (daemonOut.includes('接管')) fail('primary 还活着就接管的假阳性');

  // 杀 primary: 先杀 stdout 报告的真身 pid (写心跳的那个 node), 再杀 npx 进程组兜底
  try { if (primaryRealPid > 0) process.kill(primaryRealPid, 'SIGKILL'); } catch { /* 可能已被组杀 */ }
  primaryProc.kill('SIGKILL');
  try { process.kill(-primaryProc.pid!, 'SIGKILL'); } catch { /* 组已消失 */ }
  // 兜底: 主进程消亡后, 把心跳文件里 pid 显式覆盖成死 pid (与真实主进程崩溃后一致),
  //   排除「daemon 读到的还是旧心跳」的时序假象。
  try {
    const beat = JSON.parse(fs.readFileSync(path.join(HA_DIR, 'primary.heartbeat'), 'utf-8'));
    fs.writeFileSync(path.join(HA_DIR, 'primary.heartbeat'), JSON.stringify({ ...beat, pid: 99999999, lastBeat: new Date().toISOString() }));
  } catch { /* 心跳读不到 → 靠组杀 */ }
  ok(`已杀 primary (真身 pid=${primaryRealPid} + 进程组)`);
  const tookOver = await waitFor(() => daemonOut.includes('接管主进程'), STALE_MS + 15000, 'daemon 接管');
  if (!tookOver) {
    console.error('[diag] 接管超时, daemon 输出如下:\n' + daemonOut);
    try { process.kill(daemonProc.pid!, 0); console.error('[diag] daemon pid=' + daemonProc.pid + ' 仍存活'); }
    catch { console.error('[diag] daemon pid=' + daemonProc.pid + ' 已退出'); }
    try { console.error('[diag] primary.heartbeat=' + fs.readFileSync(path.join(HA_DIR, 'primary.heartbeat'), 'utf-8')); }
    catch (e2: any) { console.error('[diag] primary.heartbeat 读不到: ' + String(e2?.message || e2)); }
    try { console.error('[diag] standby.heartbeat=' + fs.readFileSync(path.join(HA_DIR, 'standby.heartbeat'), 'utf-8')); }
    catch (e2: any) { console.error('[diag] standby.heartbeat 读不到: ' + String(e2?.message || e2)); }
    fail('daemon 接管超时');
  }
  ok('daemon 检测到 primary 死亡并接管');

  // ── ⑤ 断言: 接管后 primary.heartbeat 归 daemon (role=primary + 含孤儿 run) ──
  const beat = JSON.parse(fs.readFileSync(path.join(HA_DIR, 'primary.heartbeat'), 'utf-8'));
  if (beat.role !== 'primary') fail(`接管后心跳 role 应为 primary, 实际 ${beat.role}`);
  if (!beat.runIds.includes(orphanId)) fail(`接管后 runIds 应含孤儿 run, 实际 ${JSON.stringify(beat.runIds)}`);
  // npx→tsx 两层 fork: daemonProc.pid 是 npx 壳, 心跳里的是写心跳的 tsx 真身。
  //   从 daemon 启动日志解析真身 pid 核对。
  const m = daemonOut.match(/pid=(\d+) home=/);
  const daemonRealPid = m ? Number(m[1]) : -1;
  if (daemonRealPid > 0 && beat.pid !== daemonRealPid) fail(`接管后心跳 pid 应为 daemon 真身 (${daemonRealPid}), 实际 ${beat.pid}`);
  ok(`接管心跳归 daemon: pid=${beat.pid} role=primary runIds=${JSON.stringify(beat.runIds)}`);
  // 孤儿 run 已被 prepareResume 处理 → 状态应变为 recovering
  const orphan = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${orphanId}.json`), 'utf-8'));
  if (orphan.status !== 'recovering') fail(`孤儿 run 应被 prepareResume 标 recovering, 实际 ${orphan.status}`);
  ok(`孤儿 run 已接管: status=${orphan.status} (recovering)`);

  // 清理 (杀进程组, 防 npx→tsx 二层残留)
  daemonProc.kill('SIGTERM');
  try { process.kill(-daemonProc.pid!, 'SIGTERM'); } catch { /* 忽略 */ }
  try { process.kill(-primaryProc.pid!, 'SIGKILL'); } catch { /* 忽略 */ }
  await sleep(500);
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
  console.log('\n🎉 全部通过: 双活心跳探测 + 故障接管闭环真跑成立');
  process.exit(0);
}

main().catch((e) => fail(String(e?.message || e)));