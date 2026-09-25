/**
 * update-health.ts — 更新后的健康检查 + `bolloon doctor` (Phase 6/7, 2026-09-19)
 *
 * 核心判断: **安装成功 ≠ 更新成功**。所以更新完成后必须真读一遍用户数据:
 *   版本读取 → CLI 启动 → 配置读取 → SetupStore → RunStore → TransactionStore →
 *   SkillsManager.health → Supervisor 状态。
 *
 * 分级:
 *   healthy   全过
 *   degraded  能用, 但有漂移/缺件 (例如技能 hash 与 registry 不一致、Web 构建缺失)
 *   failed    用不了 (例如配置损坏 / 旧交易记录读不出来)
 *
 * 硬约束: 健康检查**只读**。配置损坏时报 failed 并保留原文件, 绝不覆盖。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { detectInstallation, readPackageAt, PKG_NAME, type InstallationInfo } from './version-info.js';
import {
  readUpdateState, readUpdateLock, lockIsStale, reclaimStaleLockIfAny, IN_FLIGHT_RUN_STATUSES,
  type UpdateLockInfo,
} from './update-state.js';
import { queryRegistryDoc, parseJsonFromStdout } from './update-manager.js';
import { fetchGithubFacts, toGithubReport, renderGithubReportLine } from './dual-source.js';
import { devShaFromIdentity, channelKindOf, DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT } from './version-info.js';
import {
  detectRuntimeReport, verifyRuntimesDeep, evaluateCapabilities, RUNTIME_MIN, readIncompleteMarker,
  type RuntimeReport,
} from './runtime-bootstrap.js';

export type HealthGrade = 'healthy' | 'degraded' | 'failed';
export type ItemGrade = 'ok' | 'degraded' | 'failed';

export interface HealthItem {
  id: string;
  label: string;
  grade: ItemGrade;
  detail: string;
  /** 该项能否安全自动修复 (doctor 只提示, 不擅自改用户数据) */
  fixable?: boolean;
}

export interface HealthReport {
  grade: HealthGrade;
  version: string;
  checkedAt: string;
  items: HealthItem[];
  failures: string[];
  degradations: string[];
  /** 运行时报告 (Node/npm/Git/Python 事实 + 能力矩阵) */
  runtime?: RuntimeReport | null;
}

function worst(items: HealthItem[]): HealthGrade {
  if (items.some((i) => i.grade === 'failed')) return 'failed';
  if (items.some((i) => i.grade === 'degraded')) return 'degraded';
  return 'healthy';
}

export function gradeOfItems(items: HealthItem[]): HealthGrade { return worst(items); }

/**
 * 更新后 (以及 doctor) 执行的分层健康检查。
 * 每一项都真读一次磁盘/真起一次进程, 不做"应该没问题"的推断。
 *
 * 路径约定 (本仓两套约定并存, 这里显式分开, 不再混):
 *   bolloonHome = `~/.bolloon`     → readSetupState / update-state 用这个
 *   userHome    = `~`              → RunStore / TransactionStore / SkillsManager 的 home 参数
 *     (它们内部再拼 `.bolloon/<x>`, 传错会读到一个不存在的嵌套目录)
 */
export async function runHealthCheck(opts: { bolloonHome: string; userHome?: string; installation?: InstallationInfo; entry?: string }): Promise<HealthReport> {
  const home = opts.bolloonHome;
  const userHome = opts.userHome || os.homedir();
  const install = opts.installation || detectInstallation({ home });
  const entry = opts.entry || install.entryPath;
  const items: HealthItem[] = [];

  // 1. 版本读取
  const pkg = readPackageAt(install.packageRoot);
  const version = pkg?.version || 'unknown';
  items.push(pkg?.version
    ? { id: 'version_read', label: '版本读取', grade: 'ok', detail: `${PKG_NAME}@${version} (${install.packageRoot})` }
    : { id: 'version_read', label: '版本读取', grade: 'failed', detail: `${install.packageRoot}/package.json 读不到版本` });

  // 2. CLI 启动 (真起一次进程)
  const cli = spawnSync(process.execPath, [entry, '--version', '--json'], { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (cli.status === 0) {
    const parsed = parseJsonFromStdout(String(cli.stdout || ''));
    const parsedVersion: string | null = parsed?.packageVersion ?? null;
    if (parsedVersion && parsedVersion === version) {
      items.push({ id: 'cli_startup', label: 'CLI 启动', grade: 'ok', detail: `node dist/cli-entry.js --version --json → ${parsedVersion}` });
    } else {
      items.push({
        id: 'cli_startup', label: 'CLI 启动', grade: 'degraded',
        detail: `CLI 能启动但版本不一致 (磁盘 ${version} / 入口报 ${parsedVersion || '解析失败'}) — dist 可能过期, 跑 npm run build:main`,
      });
    }
  } else {
    items.push({
      id: 'cli_startup', label: 'CLI 启动', grade: 'failed',
      detail: `新入口无法启动 (exit ${cli.status}): ${String(cli.stderr || '').trim().slice(0, 200) || '无输出'}`,
    });
  }

  // 3. 配置读取 (损坏只报, 绝不覆盖)
  const cfgFiles = ['config.json', 'bolloon-config.json', 'llm-config.json'];
  const cfgProblems: string[] = [];
  const cfgPresent: string[] = [];
  for (const f of cfgFiles) {
    const p = path.join(home, f);
    if (!fs.existsSync(p)) continue;
    try {
      JSON.parse(await fsp.readFile(p, 'utf8'));
      cfgPresent.push(f);
    } catch (e: any) {
      cfgProblems.push(`${f}: ${e?.message || '解析失败'}`);
    }
  }
  items.push(cfgProblems.length === 0
    ? { id: 'config_read', label: '配置读取', grade: cfgPresent.length ? 'ok' : 'degraded', detail: cfgPresent.length ? `可读: ${cfgPresent.join(', ')}` : '没有配置文件 (首次运行?)' }
    : { id: 'config_read', label: '配置读取', grade: 'failed', detail: `配置损坏, 已保留原文件不覆盖: ${cfgProblems.join('; ')}`, fixable: true });

  // 4. SetupStore
  try {
    const { readSetupState } = await import('../setup/setup-store.js');
    const st = await readSetupState(home);
    items.push(st
      ? { id: 'setup_store', label: 'SetupStore 读取', grade: 'ok', detail: `stage=${st.stage} gate=${st.allow?.agent ? 'agent-ready' : 'agent-blocked'}` }
      : { id: 'setup_store', label: 'SetupStore 读取', grade: 'degraded', detail: '没有 setup-state.json (未初始化或未走过向导)' });
  } catch (e: any) {
    items.push({ id: 'setup_store', label: 'SetupStore 读取', grade: 'failed', detail: `读取异常: ${e?.message || e}` });
  }

  // 5. RunStore
  try {
    const { listRuns } = await import('../agents/run-store.js');
    const runs = await listRuns({ limit: 5 });
    items.push({ id: 'run_store', label: 'RunStore 读取', grade: 'ok', detail: `可读, 最近 ${runs.length} 条 Run` });
  } catch (e: any) {
    items.push({ id: 'run_store', label: 'RunStore 读取', grade: 'failed', detail: `旧 Run 记录读不出来: ${e?.message || e}` });
  }

  // 6. TransactionStore (home 参数 = 用户 home, 内部再拼 .bolloon/transactions)
  try {
    const { listTransactions } = await import('../agents/x402/transaction-store.js');
    const txs = await listTransactions(userHome);
    items.push({ id: 'transaction_store', label: 'TransactionStore 读取', grade: 'ok', detail: `可读, ${txs.length} 笔交易` });
  } catch (e: any) {
    items.push({ id: 'transaction_store', label: 'TransactionStore 读取', grade: 'failed', detail: `旧交易记录读不出来: ${e?.message || e}` });
  }

  // 7. SkillsManager health (home 参数 = 用户 home)
  try {
    const { getSkillsManager } = await import('../agents/skills-manager.js');
    const h = await getSkillsManager({ home: userHome }).health({ home: userHome });
    const issues: string[] = [];
    if (h.drifted.length) issues.push(`漂移 ${h.drifted.length}`);
    if (h.invalid.length) issues.push(`不合格 ${h.invalid.length}`);
    if (h.missing.length) issues.push(`registry 缺盘 ${h.missing.length}`);
    if (h.duplicates.length) issues.push(`重复 ${h.duplicates.length}`);
    items.push(issues.length === 0
      ? { id: 'skills_health', label: 'SkillsManager 健康', grade: 'ok', detail: `${h.total} 个技能, 无漂移` }
      : { id: 'skills_health', label: 'SkillsManager 健康', grade: 'degraded', detail: `${h.total} 个技能: ${issues.join(', ')}` });
  } catch (e: any) {
    items.push({ id: 'skills_health', label: 'SkillsManager 健康', grade: 'degraded', detail: `无法检查: ${e?.message || e}` });
  }

  // 8. 运行时 (Node/npm/Git/Python) —— Phase 8: 更新后不能只验证 CLI 版本,
  //    还要**真执行**: git 建临时仓库读状态 / python 真跑脚本 / node 真加载 CLI。
  let runtimeReport: RuntimeReport | null = null;
  try {
    const detected = await detectRuntimeReport({ home, useConfig: true, entryPath: entry });
    const deep = await verifyRuntimesDeep(detected.facts, entry);
    runtimeReport = { ...detected, facts: deep, capabilities: evaluateCapabilities(deep) };
    runtimeReport.ok = deep.every((f) => f.status === 'found' && f.meetsMinimum);
    runtimeReport.missing = deep.filter((f) => f.status === 'missing').map((f) => f.runtime);
    const bad = deep.filter((f) => f.status !== 'found');
    if (bad.length === 0) {
      items.push({
        id: 'runtime', label: '运行时 (Node/npm/Git/Python)', grade: 'ok',
        detail: deep.map((f) => `${f.runtime} ${f.version}`).join(' · ') + ` (最低: ${Object.entries(RUNTIME_MIN).map(([k, v]) => `${k}≥${v.min}`).join(', ')})`,
      });
    } else {
      items.push({
        id: 'runtime', label: '运行时 (Node/npm/Git/Python)', grade: 'failed',
        detail: `${bad.map((f) => `${f.runtime}: ${f.error || '不可用'}`).join('; ')} → bolloon runtime install yes`,
        fixable: true,
      });
    }
  } catch (e: any) {
    items.push({ id: 'runtime', label: '运行时 (Node/npm/Git/Python)', grade: 'degraded', detail: `检查失败: ${e?.message || e}` });
  }

  // 9. Supervisor 状态
  try {
    const { supervisorStatePath } = await import('../agents/supervisor-host.js');
    let sup: any = null;
    try { sup = JSON.parse(await fsp.readFile(supervisorStatePath(), 'utf8')); } catch { sup = null; }
    if (!sup) {
      items.push({ id: 'supervisor_state', label: 'Supervisor 状态', grade: 'ok', detail: '无 supervisor.json (未启用长期执行)' });
    } else {
      let alive = false;
      try { process.kill(sup.pid, 0); alive = true; } catch (e: any) { alive = e?.code === 'EPERM'; }
      const ghost = alive === false && !sup.stoppedAt;
      items.push(ghost
        ? { id: 'supervisor_state', label: 'Supervisor 状态', grade: 'degraded', detail: `幽灵状态: pid ${sup.pid} 已不在, 但没有 stoppedAt (上次没好好停)` }
        : { id: 'supervisor_state', label: 'Supervisor 状态', grade: 'ok', detail: alive ? `运行中 (pid ${sup.pid})` : `已停止 (${sup.stoppedAt})` });
    }
  } catch (e: any) {
    items.push({ id: 'supervisor_state', label: 'Supervisor 状态', grade: 'degraded', detail: `无法读取: ${e?.message || e}` });
  }

  return {
    grade: worst(items),
    version,
    checkedAt: new Date().toISOString(),
    items,
    failures: items.filter((i) => i.grade === 'failed').map((i) => `${i.label}: ${i.detail}`),
    degradations: items.filter((i) => i.grade === 'degraded').map((i) => `${i.label}: ${i.detail}`),
    runtime: runtimeReport,
  };
}

export function renderHealth(r: HealthReport): string {
  const L = [`更新健康检查: ${r.grade} (v${r.version} @ ${r.checkedAt})`];
  for (const i of r.items) L.push(`  ${i.grade === 'ok' ? '✓' : i.grade === 'degraded' ? '!' : '✗'} ${i.label}: ${i.detail}`);
  return L.join('\n');
}

// ── doctor ──────────────────────────────────────────────────────────────────

export interface DoctorCheck {
  id: string;
  label: string;
  grade: ItemGrade;
  detail: string;
  /** 给出的下一条命令 (可选) */
  action?: string;
}

export interface DoctorReport {
  grade: HealthGrade;
  version: string;
  checkedAt: string;
  checks: DoctorCheck[];
  health: HealthReport;
}

/** npm 各可能位置上的 @bolloon/bolloon-agent 副本 (用来发现"装了多份/装错份")。 */
export async function findInstalledCopies(home: string): Promise<{ dir: string; version: string | null; isCurrent: boolean }[]> {
  const { npmGlobalRoot, npmGlobalPrefix } = await import('./version-info.js');
  const globalRoot = npmGlobalRoot();
  const prefix = npmGlobalPrefix();
  const candidates: string[] = [];
  if (globalRoot) candidates.push(path.join(globalRoot, '@bolloon', 'bolloon-agent'));
  if (prefix) candidates.push(path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent'));
  candidates.push(
    path.join(home, '.npm-global', 'lib', 'node_modules', '@bolloon', 'bolloon-agent'),
    '/usr/local/lib/node_modules/@bolloon/bolloon-agent',
    '/opt/homebrew/lib/node_modules/@bolloon/bolloon-agent',
  );
  try {
    const nvmBase = path.join(home, '.nvm', 'versions', 'node');
    for (const ver of await fsp.readdir(nvmBase)) candidates.push(path.join(nvmBase, ver, 'lib', 'node_modules', '@bolloon', 'bolloon-agent'));
  } catch { /* 没有 nvm */ }

  const install = detectInstallation({ home });
  const seen = new Set<string>();
  const out: { dir: string; version: string | null; isCurrent: boolean }[] = [];
  for (const c of candidates) {
    let real = c;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const pkg = readPackageAt(c) || readPackageAt(real);
    if (!pkg?.version) continue;
    out.push({ dir: c, version: pkg.version, isCurrent: path.resolve(real) === path.resolve(install.packageRoot) });
  }
  return out;
}

/**
 * `bolloon doctor` —— 回答"我这台机器上的 Bolloon 是不是健康的"。
 * 重点不在"能不能跑", 而在"安装入口 / 版本事实 / 更新状态 三者是否自洽"。
 */
export async function runDoctor(opts: { bolloonHome: string; userHome?: string; installation?: InstallationInfo; skipNetwork?: boolean }): Promise<DoctorReport> {
  const home = opts.bolloonHome;
  const userHome = opts.userHome || os.homedir();
  const install = opts.installation || detectInstallation({ home });
  const checks: DoctorCheck[] = [];

  const pkg = readPackageAt(install.packageRoot);
  const version = pkg?.version || 'unknown';

  // 1. 安装入口指向正确版本
  if (!install.binPath) {
    checks.push({ id: 'entry_point', label: '安装入口', grade: 'degraded', detail: 'PATH 里找不到 bolloon 入口 (可能只是没加 PATH)', action: 'export PATH="$(npm prefix -g)/bin:$PATH"' });
  } else {
    let target = '';
    try { target = fs.realpathSync(install.binPath); } catch { target = ''; }
    const expect = path.join(install.packageRoot, 'dist', 'cli-entry.js');
    const ok = target === '' || path.resolve(target) === path.resolve(expect) || target.startsWith(path.resolve(install.packageRoot));
    checks.push(ok
      ? { id: 'entry_point', label: '安装入口', grade: 'ok', detail: `${install.binPath} → ${target || '未知'}` }
      : { id: 'entry_point', label: '安装入口', grade: 'failed', detail: `${install.binPath} 指向 ${target}, 但当前安装目录是 ${install.packageRoot}`, action: '重新安装: npm install -g @bolloon/bolloon-agent' });
  }

  // 2. package.json 版本 vs 运行时版本
  const cli = spawnSync(process.execPath, [install.entryPath, '--version', '--json'], { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const runtimeVersion: string | null = parseJsonFromStdout(String(cli.stdout || ''))?.packageVersion ?? null;
  checks.push(runtimeVersion === version
    ? { id: 'version_consistency', label: '版本一致性', grade: 'ok', detail: `package.json 与运行时一致 (${version})` }
    : { id: 'version_consistency', label: '版本一致性', grade: 'failed', detail: `package.json ${version} ≠ 运行时 ${runtimeVersion || '读取失败'} (dist 过期或入口错位)`, action: 'npm run build:main' });

  // 3. npm 全局路径冲突 (装了几份)
  const copies = await findInstalledCopies(userHome);
  const others = copies.filter((c) => !c.isCurrent);
  checks.push(others.length === 0
    ? { id: 'npm_conflicts', label: 'npm 全局路径', grade: 'ok', detail: `只有一份 (${copies[0]?.dir || install.packageRoot} = ${copies[0]?.version || version})` }
    : { id: 'npm_conflicts', label: 'npm 全局路径', grade: 'degraded', detail: `发现 ${others.length} 份其它安装: ${others.map((o) => `${o.dir} (${o.version})`).join(', ')}`, action: '删掉多余那份, 否则 which bolloon 可能指向旧版本' });

  // 4. ~/.bolloon 可写
  //    注意: 目录**还不存在** (首次运行) 不等于不可写 —— 真跑抓到过这个假阴性:
  //    全新 HOME 里 doctor 报"不可写"并据此退出 1, 而实际上父目录可写、首次运行会自己创建。
  let homeState: 'writable' | 'creatable' | 'blocked' = 'blocked';
  if (fs.existsSync(home)) {
    try { fs.accessSync(home, fs.constants.W_OK); homeState = 'writable'; } catch { homeState = 'blocked'; }
  } else {
    try {
      fs.accessSync(path.dirname(home), fs.constants.W_OK);
      homeState = 'creatable';
    } catch { homeState = 'blocked'; }
  }
  checks.push(homeState === 'blocked'
    ? { id: 'home_writable', label: '~/.bolloon 可写', grade: 'failed', detail: `${home} 不可写 — 会话/技能/Run 都落不下去`, action: `chmod u+w ${path.dirname(home)}` }
    : homeState === 'creatable'
      ? { id: 'home_writable', label: '~/.bolloon 可写', grade: 'degraded', detail: `${home} 还不存在 (首次运行会创建; 父目录 ${path.dirname(home)} 可写)` }
      : { id: 'home_writable', label: '~/.bolloon 可写', grade: 'ok', detail: home });

  // 5. 更新锁残留
  const lock: UpdateLockInfo | null = readUpdateLock(home);
  if (!lock) {
    checks.push({ id: 'update_lock', label: '更新锁', grade: 'ok', detail: '无残留锁' });
  } else if (lockIsStale(lock)) {
    const rec = await reclaimStaleLockIfAny(home);
    checks.push({ id: 'update_lock', label: '更新锁', grade: 'degraded', detail: `陈旧锁 (pid ${lock.pid}, ${lock.at})${rec.reclaimed ? ' — 已回收' : ' — 回收失败, 请手动删除 update.lock'}` });
  } else {
    checks.push({ id: 'update_lock', label: '更新锁', grade: 'degraded', detail: `另一个更新进程正在持有锁 (pid ${lock.pid}, ${lock.at}) — 等它结束或确认该进程已死` });
  }

  // 6. 上次更新是否异常中断
  const st = await readUpdateState(home);
  // 6.5 双源身份 (§12.5): doctor 也必须能回答"我装的是哪个源 / 哪个 commit / 能切回哪"
  {
    const devSha = devShaFromIdentity(version);
    const prefsChannel = st.channel || 'stable';
    checks.push(devSha
      ? {
        id: 'update_source', label: '安装来源 (双源)', grade: 'degraded',
        detail: `dev 快照: GitHub master ${st.devRef || 'refs/heads/master'} @ commit ${devSha} (比较语义 ${channelKindOf('dev')}, 非 semver)`
          + `${st.switchableTo ? ` · 可切回 stable (${st.switchableTo.source}${st.switchableTo.target ? ` @ ${st.switchableTo.target}` : ''})` : ''}`
          + ` · ${DEV_CHANNEL_WARNING}`,
        action: 'bolloon update now --channel stable',
      }
      : {
        id: 'update_source', label: '安装来源 (双源)', grade: 'ok',
        detail: `stable: npm registry 权威 (比较语义 ${channelKindOf('stable')})`
          + `${st.devSha ? ` · 上次用过 dev 快照 commit ${st.devSha}${st.devCheckedAt ? ` (${st.devCheckedAt})` : ''}, 已切回` : ''}`
          + ` · 默认通道 ${prefsChannel} · 切 dev 用: bolloon update now --channel dev`,
      });
  }
  const inFlight = st.lastUpdate && (IN_FLIGHT_RUN_STATUSES as string[]).includes(st.lastUpdate.status);
  checks.push(inFlight
    ? { id: 'last_update', label: '上次更新', grade: 'degraded', detail: `上次更新停在 ${st.lastUpdate!.status} (${st.lastUpdate!.at}) — 异常中断, 建议 bolloon update --plan 后再更新一次`, action: 'bolloon update --plan' }
    : st.lastFailure
      ? { id: 'last_update', label: '上次更新', grade: 'degraded', detail: `上次更新失败 (${st.lastFailure.at}, ${st.lastFailure.stage}): ${st.lastFailure.reason}` }
      : { id: 'last_update', label: '上次更新', grade: 'ok', detail: st.lastUpdate ? `最近一次 ${st.lastUpdate.at} ${st.lastUpdate.from} → ${st.lastUpdate.to} [${st.lastUpdate.status}]` : '无更新记录' });

  if (st.needsRestart) {
    checks.push({ id: 'needs_restart', label: '待重启', grade: 'degraded', detail: '新版本已就位但还没重启, 当前进程仍在跑旧代码', action: '重启 bolloon' });
  }

  // 7. 版本检查源是否可达 (可跳过) —— 双源: npm 是权威, GitHub 是交叉校验/dev 的源
  if (opts.skipNetwork) {
    checks.push({ id: 'version_source', label: '版本源可达', grade: 'ok', detail: '已跳过 (离线)' });
  } else {
    const [reg, ghRes] = await Promise.all([queryRegistryDoc(), fetchGithubFacts()]);
    const gh = toGithubReport(ghRes);
    const npmPart = reg.ok
      ? `npm registry 可达, latest=${reg.doc.latest}`
      : `npm ${reg.kind}: ${reg.detail}`;
    checks.push({
      id: 'version_source', label: '版本源可达 (双源)',
      // npm 是 stable 的权威 (坏了就是 degraded); GitHub 坏了只影响交叉校验与 dev 通道 → 也只 degraded
      grade: reg.ok ? (gh.reachable ? 'ok' : 'degraded') : 'degraded',
      detail: `${npmPart} · ${renderGithubReportLine(gh)}`,
      action: !reg.ok ? '检查网络/代理后重跑 bolloon doctor'
        : (!gh.reachable ? 'GitHub 交叉校验不可用 (stable 仍以 npm 为权威); dev 通道此时会直接拒绝' : undefined),
    });
  }

  // 7.5 安装完整性标记 (postinstall 发现缺 Git/Python 时留下的)
  const marker = await readIncompleteMarker(home).catch(() => null);
  if (marker) {
    checks.push({
      id: 'install_complete', label: '安装完整性', grade: 'degraded',
      detail: `postinstall 记下过一次"安装未完成" (${marker.at}): 缺 ${marker.missing.join(', ')} —— 运行时补齐成功会自动清掉这个标记`,
      action: 'bolloon runtime install yes',
    });
  }

  // 8. 分层健康检查 (版本/CLI/配置/三个 Store/运行时/技能/Supervisor)
  const health = await runHealthCheck({ bolloonHome: home, userHome, installation: install });
  if (health.runtime) {
    const rt = health.runtime;
    const detail = rt.facts.map((f) => `${f.runtime} ${f.version || '-'} ${f.path || ''}[${f.installedByBolloon ? 'Bolloon 安装' : f.source}]`).join(' · ');
    checks.push({
      id: 'runtime', label: '运行时配置', grade: rt.ok ? 'ok' : 'failed', detail,
      action: rt.ok ? undefined : 'bolloon runtime install yes (补装缺失运行时; 不会偷偷 sudo)',
    });
    checks.push({
      id: 'runtime_capabilities', label: '能力矩阵',
      grade: rt.capabilities.core ? (rt.capabilities.sourceUpdate && rt.capabilities.pythonSkill ? 'ok' : 'degraded') : 'failed',
      detail: `核心运行=${rt.capabilities.core ? '可用' : '不可用'} · 源码更新=${rt.capabilities.sourceUpdate ? '可用' : '不可用'} · Git 协作=${rt.capabilities.gitCollaboration ? '可用' : '不可用'} · Python Skill=${rt.capabilities.pythonSkill ? '可用' : '不可用'} · Wiki 工具=${rt.capabilities.wikiTools ? '可用' : '不可用'}`,
    });
  }
  checks.push({
    id: 'health', label: '分层健康检查', grade: health.grade === 'healthy' ? 'ok' : health.grade === 'degraded' ? 'degraded' : 'failed',
    detail: `${health.grade}: ${[...health.failures, ...health.degradations].join(' | ') || '全部通过'}`,
  });

  return { grade: worst(checks.map((c) => ({ ...c, id: c.id, label: c.label, detail: c.detail, grade: c.grade } as HealthItem))), version, checkedAt: new Date().toISOString(), checks, health };
}

export function renderDoctor(r: DoctorReport): string {
  const L = [`Bolloon doctor — ${r.grade} (v${r.version})`, ''];
  for (const c of r.checks) {
    L.push(`${c.grade === 'ok' ? '✅' : c.grade === 'degraded' ? '⚠️ ' : '❌'} ${c.label}: ${c.detail}`);
    if (c.action) L.push(`      → ${c.action}`);
  }
  if (r.grade !== 'healthy') {
    L.push('');
    L.push(r.grade === 'failed' ? '结论: 有阻塞性问题, 先按上面 → 的提示修。' : '结论: 能跑, 但有需要看一眼的地方 (不影响基本使用)。');
  } else {
    L.push('');
    L.push('结论: 安装入口 / 版本事实 / 更新状态三者自洽。');
  }
  return L.join('\n');
}
