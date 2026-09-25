/**
 * update-commands.ts — `bolloon --version` / `bolloon update` / `bolloon doctor` 的实现
 * (Phase 1-7 的对外出口, 2026-09-19)
 *
 * 三个命令都只读同一个 `VersionInfo` / `UpdateState`, 不各自拼字符串:
 *   --version [--verbose|--json]  版本身份 (普通 / 诊断 / 机器)
 *   update [--plan|--status|--history|--now]  检查(默认) / 计划 / 状态 / 历史 / 执行
 *   doctor                        安装入口 + 版本事实 + 更新状态的自洽性
 *
 * 退出码 (供脚本用, 稳定约定):
 *   0  正常 (检查成功 / 更新成功 / doctor healthy|degraded)
 *   1  执行失败 (更新失败 / doctor failed)
 *   2  检查不可用 (离线 / registry 不可用 / 读不到本地版本) —— 与"没有更新"区分开
 */

import { resolveBolloonHome } from '../setup/setup-store.js';
import {
  collectVersionInfo, renderVersionText, renderVersionJson, describeSourceIdentity,
  DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT,
  resolveUpdateChannel, channelKindOf, isDevIdentity,
  type VersionInfo, type UpdateChannel,
} from '../utils/version-info.js';
import {
  checkForUpdate, buildUpdatePlan, renderUpdatePlan, applyUpdate, readUpdateStatus, readHistory,
  renderHistory, updateSummaryFor, compareVersions, checkExitCode, REFUSED_STATUSES, type CheckResult,
} from '../utils/update-manager.js';
import { renderGithubReportLine } from '../utils/dual-source.js';
import { runDoctor, renderDoctor } from '../utils/update-health.js';
import {
  detectRuntimeReport, bootstrapRuntimes, renderRuntimeReport, renderBootstrapPlan, RUNTIME_MIN,
  readRuntimeConfigWithFallback, type RuntimeReport,
} from '../utils/runtime-bootstrap.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[38;2;196;214;64m';
const GREEN = '\x1b[38;2;34;197;94m';
const YELLOW = '\x1b[38;2;245;158;11m';
const RED = '\x1b[38;2;239;68;68m';

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

// ── --channel (§12.2: 只覆盖本次进程, 不落盘) ───────────────────────────────

/** 允许的通道字面量 (`--channel stable|dev`; beta 仍是"与 stable 同源"的老口径)。 */
const CHANNEL_VALUES: UpdateChannel[] = ['stable', 'dev', 'beta'];

export interface ChannelArg { channel?: string; given: boolean; error?: string }

/**
 * 解析 `--channel <v>` / `--channel=<v>`。
 * 给了不认识的值 → **拒绝并说清** (不静默落回 stable, 那会让人以为切成功了)。
 */
export function parseChannelArg(args: string[]): ChannelArg {
  let raw: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--channel') { raw = args[i + 1] ?? ''; break; }
    if (a.startsWith('--channel=')) { raw = a.slice('--channel='.length); break; }
    if (a === 'channel') { raw = args[i + 1] ?? ''; break; }
  }
  if (raw === null) return { given: false };
  const v = raw.trim().toLowerCase();
  if (!CHANNEL_VALUES.includes(v as UpdateChannel)) {
    return { given: true, error: `--channel 只接受 ${CHANNEL_VALUES.join('|')}, 收到 "${raw}" — 拒绝执行 (没有静默落回 stable)` };
  }
  return { channel: v, given: true };
}

/** dev 通道的三条硬约束 (§12.4) 在这里统一打印: 显式警告 + 记录 sha + 一键回 stable。 */
function printDevNotice(): void {
  out('');
  out(DEV_CHANNEL_WARNING);
  out(DEV_BACK_TO_STABLE_HINT);
  out('');
}

// ── 版本 ────────────────────────────────────────────────────────────────────

export async function runVersionCommand(args: string[] = []): Promise<number> {
  // 2026-09-19 (leo): 子命令一律**裸词**, 不再带 `--` 前缀 (只有 `--version` 本身保留 --)
  // 为了不打断已经有脚本/肌肉记忆的用法, 旧的 `--verbose` / `--json` 仍然被接受。
  const json = args.includes('json') || args.includes('--json');
  const verbose = args.includes('verbose') || args.includes('--verbose') || args.includes('-V') || args.includes('all');
  const home = resolveBolloonHome();
  const update = await updateSummaryFor(home).catch(() => null);
  // 运行时配置 (leo 2026-09-19: 展示安装信息时要展示这些配置)。
  // 普通版做浅探测 (路径 + 版本); verbose/json 做**真执行验证** (git 建临时仓库/python 真跑脚本/node 真加载 CLI)。
  const runtime = await detectRuntimeReport({ home, deep: verbose || json }).catch(() => null);
  const rtCfg = await readRuntimeConfigWithFallback(home).catch(() => ({} as Partial<Record<string, unknown>>));
  const runtimeConfigBacked = Boolean((rtCfg as Record<string, unknown>).node);
  // 机器版也要完整身份 (git commit / npm / Python) —— "给问题报告用"就必须有这些;
  // 只有启动横幅那种高频场景才走 light。
  const info: VersionInfo = collectVersionInfo({ home, update, runtime, runtimeConfigBacked, light: false });

  if (json) {
    out(renderVersionJson(info));
    return 0;
  }
  if (!verbose) {
    // 普通版: 首次问"我运行的到底是什么"时也顺手把更新事实刷新一次
    // (不发通知, 只是别让用户看到永远空白的"尚未检查"; 迁移自旧缓存时 lastCheckStatus 为 null)
    if (!info.update || !info.update.lastCheckAt || !info.update.lastCheckStatus) {
      const r = await checkForUpdate({ home, force: false }).catch(() => null);
      if (r) {
        const fresh = await updateSummaryFor(home).catch(() => null);
        if (fresh) info.update = fresh;
      }
    }
  }
  out(renderVersionText(info, { verbose }));
  if (verbose) {
    out('');
    out('提示: bolloon --version json 给脚本/问题报告用; bolloon doctor 看安装是否自洽。');
  }
  return 0;
}

// ── 更新状态渲染 ────────────────────────────────────────────────────────────

function statusConclusion(status: string | null, latest: string | null, current: string): string {
  switch (status) {
    case 'up_to_date': return `${GREEN}已是最新${RESET} (${current})`;
    case 'update_available': return `${YELLOW}有新版可用${RESET} (${current} → ${latest || '未知'})`;
    case 'check_skipped': return `${CYAN}使用缓存结论${RESET} (未打网络)`;
    case 'offline': return `${RED}离线${RESET} — 连不上 npm registry, ${BOLD}不能判定为最新${RESET}`;
    case 'registry_unavailable': return `${RED}registry 不可用${RESET} — ${BOLD}不能判定为最新${RESET}`;
    case 'local_version_unknown': return `${RED}读不到本地版本${RESET} — 不判断是否有更新`;
    case 'unsupported_installation': {
      // 仍然把"和最新比到底差多少"说清楚 —— 不支持自动更新 ≠ 不需要知道有没有新版
      const cmp = !latest ? '' : compareVersions(current, latest) < 0 ? ` — 已有更新版 ${latest}, 需按该安装方式手动升级` : ` — 本地 ${current} 已是 registry 上最新`;
      return `${YELLOW}当前安装方式不支持自动更新${RESET}${cmp}`;
    }
    case 'github_unavailable': return `${RED}GitHub 源不可用${RESET} — ${BOLD}不能判定为最新${RESET}`;
    case 'cross_check_mismatch': return `${RED}两个源不一致${RESET} — npm 与 GitHub 指向不同版本, ${BOLD}拒绝更新${RESET}`;
    default: return '尚未检查';
  }
}

export function renderCheckResult(r: CheckResult): string {
  const dev = r.channelKind === 'git-ref';
  const L: string[] = [];
  L.push(`当前版本: ${r.currentVersion}${r.installedDevSha ? ` (dev 快照 commit ${r.installedDevSha})` : ''}`);
  L.push(`${dev ? '最新快照' : '最新版本'}: ${r.latestVersion || '未知'}`);
  L.push(`更新通道: ${r.channel} (比较语义: ${r.channelKind || channelKindOf(r.channel)})`);
  L.push(`当前来源: ${r.installedChannel === 'dev' ? `dev (GitHub master 快照 @ ${r.installedDevSha})` : 'stable (npm registry)'}`);
  L.push(`安装方式: ${r.installMethod}`);
  if (dev) L.push(renderGithubReportLine(r.github));
  else {
    L.push(renderGithubReportLine(r.github));
    if (r.crossCheck) L.push(`交叉校验: ${r.crossCheck.kind}${r.crossCheck.blocking ? ' (阻塞)' : ''} — ${r.crossCheck.detail}`);
  }
  if (r.dev) L.push(`dev 判定: ${r.dev.detail}`);
  if (r.switchableTo) L.push(`能切回: ${r.switchableTo.channel} (${r.switchableTo.source}${r.switchableTo.target ? ` @ ${r.switchableTo.target}` : ''})`);
  L.push(`检查时间: ${r.checkedAt}${r.fromCache ? ' (缓存)' : ''}`);
  L.push(`结论: ${statusConclusion(r.status, r.latestVersion, r.currentVersion)}`);
  if (r.reason) L.push(`说明: ${r.reason}`);
  L.push('');
  if (r.status === 'update_available') {
    L.push(`下一步: ${BOLD}bolloon update plan --channel ${r.channel}${RESET} 看计划, ${BOLD}bolloon update now --channel ${r.channel}${RESET} 执行更新`);
    if (dev) L.push(DEV_CHANNEL_WARNING), L.push(DEV_BACK_TO_STABLE_HINT);
  } else if (r.status === 'unsupported_installation') {
    L.push('下一步: 按上面"说明"里对应安装方式更新 (源码目录: git pull && npm install && npm run build:all)');
  } else if (r.status === 'offline' || r.status === 'registry_unavailable') {
    L.push('下一步: 检查网络/代理后重跑 `bolloon update`; 也可以 `bolloon update status` 看上次结论');
  } else if (r.status === 'github_unavailable') {
    L.push('下一步: 检查到 GitHub 的网络/代理/限流后重跑 `bolloon update --channel dev`;'
      + `${BOLD}dev 通道不会退回 stable 装旧版${RESET} —— 要稳定版请显式 --channel stable`);
  } else if (r.status === 'cross_check_mismatch') {
    L.push('下一步: 两个发布源不一致, 先查清哪个是对的 (npm: registry dist-tags / GitHub: Release 记录);'
      + '本条不执行任何安装, 也不会按 GitHub 的 tag 去装。');
  } else if (r.status === 'local_version_unknown') {
    L.push('下一步: 重新安装 (npm install -g @bolloon/bolloon-agent) 以恢复 package.json');
  }
  return L.join('\n');
}

export function renderStatusReport(s: Awaited<ReturnType<typeof readUpdateStatus>>): string {
  const L: string[] = [];
  const lu = s.lastUpdate;
  const dev = s.installedChannel === 'dev';
  L.push(`${BOLD}更新状态${RESET}`);
  L.push(`当前版本:   ${s.currentVersion}`);
  // ── §12.5: 必须说清"当前装的是哪个源 + 哪个版本/commit sha + 能切回哪个源" ──
  L.push(`安装来源:   ${dev
    ? `dev (GitHub master 快照, ref ${s.devRef || 'refs/heads/master'}, commit ${s.installedDevSha || '未知'})`
    : 'stable (npm registry)'}`);
  L.push(`身份标识:   ${dev ? `commit ${s.installedDevSha || '未知'}` : s.currentVersion}`);
  L.push(`能切回:     ${s.switchableTo
    ? `${s.switchableTo.channel} (${s.switchableTo.source}${s.switchableTo.target ? ` @ ${s.switchableTo.target}` : ''}) — 一键切: bolloon update now --channel ${s.switchableTo.channel}`
    : '无 (未知来源)'}`);
  if (s.lastDevSha && !dev) L.push(`上次 dev:   commit ${s.lastDevSha}${s.devCheckedAt ? ` @ ${s.devCheckedAt}` : ''} (已切回 stable)`);
  L.push(`最新版本:   ${s.latestVersion || (s.lastCheckStatus ? '未知' : '尚未检查')}`);
  L.push(`是否最新:   ${statusConclusion(s.lastCheckStatus, s.latestVersion, s.currentVersion)}`);
  L.push(`更新通道:   ${s.channel} (比较语义: ${s.channelKind})`);
  L.push(`安装方式:   ${s.installMethod}`);
  L.push(`安装目录:   ${s.installDir}`);
  L.push(`运行入口:   ${s.entryPath}`);
  if (s.sourceFacts) {
    const f = s.sourceFacts;
    L.push(`源事实:     npm ${f.npm?.reachable ? `可达 (latest=${f.npm.latest || '未知'})` : `不可达${f.npm?.detail ? ` (${f.npm.detail})` : ''}`}`
      + ` · GitHub ${f.github?.reachable
        ? `可达 (HEAD ${f.github.headSha ? f.github.headSha.slice(0, 7) : '未知'}, Release ${f.github.releases ?? 0}, Tag ${f.github.tags ?? 0})`
        : `不可达${f.github?.reason ? ` (github_unavailable(${f.github.reason}))` : ' (未查询)'}`}`);
    if (f.crossCheck) L.push(`交叉校验:   ${f.crossCheck.kind}${f.crossCheck.blocking ? ' (阻塞)' : ''} — ${f.crossCheck.detail}`);
  }
  L.push(`最近检查:   ${s.lastCheckAt || '从未'}${s.lastCheckReason ? ` (${s.lastCheckReason})` : ''}`);
  L.push(`最近更新:   ${lu ? `${lu.at} ${lu.from} → ${lu.to} [${lu.status}]${lu.reason ? ` ${lu.reason}` : ''}` : '无记录'}`);
  L.push(`最近失败:   ${s.lastFailure ? `${s.lastFailure.at} @${s.lastFailure.stage}: ${s.lastFailure.reason}` : '无'}`);
  L.push(`需要重启:   ${s.needsRestart ? '是 (新版已就位, 重启后生效)' : '否'}`);
  L.push(`更新锁:     ${s.lock ? `有 (pid ${s.lock.pid}, ${s.lock.at}${s.lock.stale ? ', 已陈旧' : ''})` : '无'}`);
  L.push(`开关:       检查更新=${s.prefs.checkUpdates} (${s.prefs.sources.checkUpdates}) · 自动安装=${s.prefs.autoInstall} (${s.prefs.sources.autoInstall}) · 自动重启=${s.prefs.autoRestart} (${s.prefs.sources.autoRestart})`);
  if (dev) { L.push(''); L.push(DEV_CHANNEL_WARNING); L.push(DEV_BACK_TO_STABLE_HINT); }
  return L.join('\n');
}

// ── update 子命令 ───────────────────────────────────────────────────────────

export async function runUpdateCommand(args: string[] = []): Promise<number> {
  const home = resolveBolloonHome();
  // 裸词优先 (bolloon update plan / status / history / now / wait / force / json / --channel dev),
  // 同时兼容旧的 --plan / --status / ... 写法 (已有脚本不断裂)。
  const has = (...f: string[]) => f.some((x) => args.includes(x));
  const json = has('json', '--json');
  const ch = parseChannelArg(args);
  if (ch.error) {
    err(`${RED}✗ ${ch.error}${RESET}`);
    return 2;
  }
  const channel = ch.channel;

  // ── 状态 ──
  if (has('status', '--status')) {
    const s = await readUpdateStatus({ home, channel });
    if (json) { out(JSON.stringify(s, null, 2)); return 0; }
    out(renderStatusReport(s));
    return 0;
  }

  // ── 历史 ──
  if (has('history', '--history')) {
    const idx = args.findIndex((a) => a === 'history' || a === '--history');
    const n = parseInt(args[idx + 1] || '10', 10);
    const recs = await readHistory(Number.isFinite(n) && n > 0 ? n : 10, home);
    if (json) { out(JSON.stringify(recs, null, 2)); return 0; }
    out(renderHistory(recs));
    return 0;
  }

  // ── 计划 ──
  if (has('plan', '--plan')) {
    const plan = await buildUpdatePlan({ home, force: true, channel });
    if (json) { out(JSON.stringify(plan, null, 2)); return 0; }
    out(renderUpdatePlan(plan));
    if (plan.channelKind === 'git-ref') printDevNotice();
    return 0;
  }

  // ── 执行 ──
  if (has('now', '--now')) {
    const wait = has('wait', '--wait');
    const force = has('force', '--force', '-f');
    const plan = await buildUpdatePlan({ home, force: true, channel });
    if (!json) {
      out(renderUpdatePlan(plan));
      if (plan.channelKind === 'git-ref') printDevNotice();
    }
    if (!plan.ok && plan.blockers.length > 0) {
      if (json) out(JSON.stringify({ stage: 'blocked', reason: plan.blockers.join('; ') }, null, 2));
      err(`${RED}✗ 更新被阻塞${RESET}: ${plan.blockers.join('; ')}`);
      return 1;
    }
    if (!plan.targetVersion) {
      /**
       * §12.5: 源不可达 / 版本不存在 → **拒绝并说清**, 退出码 2。
       * 绝不打印"✅ 已是最新, 无需更新" (那正是这次要收敛掉的骗人行为)。
       */
      if (REFUSED_STATUSES.includes(plan.check.status)) {
        if (json) out(JSON.stringify({ stage: 'blocked', refused: true, status: plan.check.status, reason: plan.check.reason }, null, 2));
        err(`${RED}✗ 拒绝更新${RESET} (${plan.check.status}): ${plan.check.reason || '源不可达 / 版本不存在'}`);
        err('  没有安装任何东西, 也没有静默退回旧版。');
        return 2;
      }
      if (json) out(JSON.stringify({ stage: 'succeeded', ok: true, reason: '已是最新', from: plan.currentVersion, to: plan.currentVersion }, null, 2));
      out(`${GREEN}✓ 已是最新, 无需更新${RESET} (${plan.currentVersion})`);
      return 0;
    }
    const res = await applyUpdate({
      home,
      channel,
      strategy: wait ? 'wait' : 'now',
      force,
      onStage: json ? undefined : (stage, detail) => out(`  [${stage}] ${detail}`),
    });
    if (json) { out(JSON.stringify(res, null, 2)); return res.ok ? 0 : (res.stage === 'blocked' ? 2 : 1); }

    if (res.ok) {
      out(`${GREEN}✓ 更新成功${RESET}: ${res.from} → ${res.to} (${(res.durationMs / 1000).toFixed(1)}s)`);
      if (isDevIdentity(res.to)) {
        out(`  dev 快照已记录: commit ${res.to.split('+dev.')[1] || '未知'} (ref refs/heads/master) — bolloon update status 可查`);
      }
      out('  正在做更新后健康检查...');
      const health = await runDoctor({ bolloonHome: home }).catch(() => null);
      if (health) {
        out(renderDoctor(health));
      }
      if (isDevIdentity(res.to)) printDevNotice();
      out(`${YELLOW}请重启 bolloon 以使用新版本${RESET}`);
      return 0;
    }
    if (res.stage === 'blocked') {
      const refused = /拒绝更新|github_unavailable|cross_check_mismatch/.test(res.reason || '');
      err(`${YELLOW}! ${res.reason}${RESET}`);
      return refused ? 2 : 1;
    }
    err(`${RED}✗ 更新失败${RESET} (${res.stage}): ${res.reason}`);
    err(`  旧版本仍在: ${res.from} — 可继续使用; 详情: bolloon update status`);
    if (res.stage === 'rolled_back') err(`  已回滚到 ${res.from}`);
    return 1;
  }

  // ── 默认: 只检查, 给清晰结论 (显式命令 = 忽略节流) ──
  const r = await checkForUpdate({ home, force: true, channel });
  if (json) { out(JSON.stringify(r, null, 2)); return checkExitCode(r.status); }
  out(renderCheckResult(r));
  if (r.status !== 'up_to_date' && r.status !== 'check_skipped') {
    out('');
    out(`${YELLOW}提示${RESET}: 本次只检查, 没有安装任何东西。`);
  }
  return checkExitCode(r.status);
}

// ── doctor ──────────────────────────────────────────────────────────────────

export async function runDoctorCommand(args: string[] = []): Promise<number> {
  const home = resolveBolloonHome();
  const json = args.includes('json') || args.includes('--json');
  const skipNetwork = args.includes('offline') || args.includes('--offline');
  const rep = await runDoctor({ bolloonHome: home, skipNetwork });
  if (json) {
    out(JSON.stringify(rep, null, 2));
    return rep.grade === 'failed' ? 1 : 0;
  }
  out(renderDoctor(rep));
  return rep.grade === 'failed' ? 1 : 0;
}

/**
 * `bolloon runtime [check|install|report|json|dry-run|yes]`
 *   check/report  —— 只看 (Phase 5 报告: 四个运行时 + 五项能力)
 *   install       —— 真安装缺失的运行时 (需要 yes; 不偷偷 sudo)
 *   dry-run       —— 只显示将执行的命令
 *   json          —— 机器可读
 * 也是 `bolloon setup repair-runtime` 的同一实现 (只有一份)。
 */
export async function runRuntimeCommand(args: string[] = []): Promise<number> {
  const home = resolveBolloonHome();
  const json = args.includes('json') || args.includes('--json');
  const dryRun = args.includes('dry-run') || args.includes('--dry-run');
  const yes = args.includes('yes') || args.includes('--yes') || args.includes('-y');
  const verbose = args.includes('verbose') || args.includes('--verbose');
  const install = args.includes('install') || args.includes('repair') || args.includes('repair-runtime');
  const wantPlan = args.includes('plan') || dryRun;

  if (args.includes('help') || args.includes('--help')) {
    out(`${BOLD}bolloon runtime${RESET} — 运行时 (Node/npm/Git/Python) 检查与安装`);
    out('');
    for (const [id, v] of Object.entries(RUNTIME_MIN)) out(`  ${id.padEnd(7)} 最低 ${v.min.padEnd(8)} ${v.why}`);
    out('');
    out('  bolloon runtime              检查并给报告 (真执行验证)');
    out('  bolloon runtime verbose      同上 + 路径/来源/验证时间');
    out('  bolloon runtime plan         只看安装计划 (要装什么/用哪个包管理器/是否要管理员权限)');
    out('  bolloon runtime install yes  真安装缺失项 (不偷偷 sudo; 需要管理员权限时会明确说)');
    out('  bolloon runtime dry-run      只显示将执行的命令');
    out('  bolloon runtime json         机器可读');
    return 0;
  }

  if (wantPlan && !install) {
    const before = await detectRuntimeReport({ home, deep: false });
    const { planBootstrap } = await import('../utils/runtime-bootstrap.js');
    const plan = planBootstrap(before.facts);
    if (json) { out(JSON.stringify({ report: before, plan }, null, 2)); return before.ok ? 0 : 1; }
    out(renderBootstrapPlan(plan));
    return before.ok ? 0 : 1;
  }

  if (install && !json) {
    // Phase 3: 真正改变系统之前先显示一次计划 (装什么/用什么装/要不要管理员权限/是否改 PATH)
    const before = await detectRuntimeReport({ home, deep: false });
    const { planBootstrap } = await import('../utils/runtime-bootstrap.js');
    out(renderBootstrapPlan(planBootstrap(before.facts)));
    out('');
    if (install && !yes) out(`${YELLOW}未带 yes: 只显示计划, 不执行安装${RESET} (加 yes 才真装)`);
  }

  // 只看 (check/report): 不经过安装流程, 免得打印"未获得同意"这种与本次目的无关的话
  if (!install && !dryRun) {
    const fresh = await detectRuntimeReport({ home, deep: true });
    if (json) { out(JSON.stringify(fresh, null, 2)); return fresh.ok ? 0 : 1; }
    out(renderRuntimeReport(fresh, { verbose }));
    return fresh.ok ? 0 : 1;
  }

  const rep = await bootstrapRuntimes({
    home,
    dryRun,
    yes: install ? yes : false,
    onProgress: json ? undefined : (m) => out(`  ${m}`),
  });

  if (json) {
    out(JSON.stringify(rep, null, 2));
    return rep.ok ? 0 : 1;
  }
  out(renderRuntimeReport(rep, { verbose: true }));
  if (!rep.ok) {
    out('');
    out(`${YELLOW}不宣布安装成功${RESET}: ${rep.missing.concat(rep.belowMinimum).join(', ') || '运行时未全部就绪'}`);
    return 1;
  }
  return 0;
}

export const UPDATE_HELP = `
${BOLD}版本与更新:${RESET} (子命令一律裸词, 不带 -- 前缀)
  bolloon --version                  版本 + 安装方式/目录/入口/通道/来源身份/上游/是否最新
  bolloon --version verbose          诊断版 (构建时间/git/Node/npm/Python/配置目录/最近更新)
  bolloon --version json             机器版 (同一份 VersionInfo, 给脚本与问题报告)
  bolloon update                     只检查并给结论 (不安装任何东西)
  bolloon update plan                更新计划: 要更新什么 / 不会动什么 / 风险检查
  bolloon update status              更新状态: 装的哪个源+版本/commit+能切回哪/最近检查/失败/开关
  bolloon update history [N]         最近 N 次更新 (时间 · 版本变化 · 结果 · 耗时 · 原因)
  bolloon update now                 真正执行更新 (默认先看计划)
  bolloon update now wait            等当前 Run 结束后再更新 (有长期任务时的默认建议)
  bolloon doctor                     安装入口 + 版本事实 + 更新状态 + 运行时 是否自洽
  bolloon doctor json                同上, 机器可读
  bolloon runtime [plan|install|json] 运行时 (Node/npm/Git/Python) 检查与安装 (install 需显式 yes)

${BOLD}双源 (--channel):${RESET}
  --channel stable  (默认) npm registry 是权威 (dist-tags.latest), GitHub Tag/Release 只做交叉校验;
                           比较语义 = semver (npm 的 latest ↔ GitHub 同名 tag)
  --channel dev     GitHub master HEAD 是唯一源; 比较语义 = git ref + commit sha (不用 semver);
                           身份 = <版本>+dev.<sha7>; 未走发布门, 会打印警告并记录 sha
  一键回稳定版:     bolloon update now --channel stable
  --channel 只覆盖本次进程, 不落盘 (config 里的 updateChannel 仍是默认值)
  源不可达 / 版本不存在 → 拒绝并说清 (退出码 2), 不会静默装回旧版

${BOLD}开关 (config.json):${RESET}
  checkUpdates (默认 true)   启动时后台检查
  autoInstall  (默认 false)  自动安装 —— 默认关, 需显式打开
  autoRestart  (默认 false)  装完自动重启
${BOLD}环境变量 (临时覆盖, 不落盘):${RESET}
  BOLLOON_SKIP_UPDATE=1      本次不检查
  BOLLOON_AUTO_UPDATE=1      本次允许自动安装
  BOLLOON_UPDATE_CHANNEL=stable|beta|dev
  BOLLOON_GITHUB_API         覆盖 GitHub API 根 (镜像/受控验收用)
  BOLLOON_DEV_SOURCE_DIR     dev 快照用本地源码树 (必须与该 sha 一致, 否则拒绝)

${BOLD}退出码:${RESET} 0 正常 · 1 执行失败 · 2 检查不可用 (离线/registry 不可用/GitHub 不可用/两源不一致/读不到本地版本)
`;
