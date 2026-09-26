/**
 * update-manager.ts — 更新系统的**唯一决策者** (Phase 2/4/5, 2026-09-19)
 *
 * 职责只有三件 (不多做):
 *   ① 识别当前安装 (`detectInstallation`)
 *   ② 查询目标版本 (npm registry, 唯一稳定渠道)
 *   ③ 形成更新计划 (`buildUpdatePlan`) / 执行更新 (`applyUpdate`)
 *
 * 它**不**直接改用户配置, **不**默认自动安装, **不**碰 `~/.bolloon` 的用户数据
 * (goals / runs / transactions / skills / config 一律不动)。
 *
 * 渠道决定 (2026-09-19, 冻结): **npm 是唯一稳定发行渠道**; GitHub 只作为源码与发布记录。
 *   因此安装脚本不再优先查 GitHub Releases, 版本解析也只有一份 (本模块)。
 *
 * 与计划的刻意偏差 (如实记录, 见 docs/wiki/update-protocol.md §5):
 *   "安装到临时位置 → 原子切换" 落成 **"临时位置下载并校验 tarball → 交给 npm 完成替换 → 验证可启动 → 失败回滚"**。
 *   理由: 手工把整棵 node_modules (949 个包) 复制/切换一遍, 比 npm 自己的替换更危险也更容易半更新;
 *   真正要保的性质 ("不能删掉旧版本后才发现新版本起不来") 由**切换后验证 + 失败回滚**保证, 这两步是真跑的。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as https from 'https';
import * as http from 'http';
import { spawnSync, execFileSync } from 'child_process';
import {
  PKG_NAME, CONSTRAINT_PKG_NAME, NPM_REGISTRY_BASE, resolveUpdateChannel, distTagForChannel,
  detectInstallation, collectVersionInfo, readPackageAt, packageRootFrom, npmGlobalRoot,
  channelKindOf, isDevIdentity, devShaFromIdentity, devIdentity, baseVersionOf,
  DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT,
  type InstallMethod, type UpdateSource, type UpdateChannel, type ChannelKind, type InstallationInfo, type VersionUpdateSummary,
} from './version-info.js';
import {
  parseVersion, compareVersions, isKnownVersion, checkExitCode, REFUSED_STATUSES,
} from './version-identity.js';
// registry 侧的错误分类也在纯那一半 (手机端要用同一份分类) —— 定义在 dual-source-facts.ts。
import { classifyRegistryError } from './dual-source-facts.js';
import {
  fetchGithubFacts, toGithubReport, crossCheckStable, compareDevSnapshots, prepareDevSnapshot,
  renderGithubReportLine,
  type GithubResult, type GithubReport, type CrossCheck, type DevCheck,
} from './dual-source.js';
import {
  type CheckStatus, type UpdateRunStatus, type UpdateRecord, type UpdatePrefs, type UpdateState,
  type SourceFacts, type SwitchTarget, type InstalledChannel,
  readUpdateState, writeUpdateState, appendUpdateHistory, readUpdateHistory,
  acquireUpdateLock, releaseUpdateLock, readUpdateLock, lockIsStale, readUpdatePrefs,
} from './update-state.js';

export type { CheckStatus, UpdateRunStatus, UpdateRecord, UpdatePrefs, UpdateState };
export { DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT };

// 版本比较 / 结论→退出码 / 拒绝语义: **唯一一份在 `version-identity.ts`** (桌面与手机共用)。
// 这里原样再导出, 避免出现第二套实现 (手机端 WebView 里也要判同一批结论)。
export { parseVersion, compareVersions, isKnownVersion, checkExitCode, REFUSED_STATUSES };

// ── 版本比较 (唯一一份在 version-identity.ts; 上面已再导出) ────────────────

/**
 * 从子进程 stdout 里取 JSON —— **不要**按"行首是否 { "过滤:
 * `JSON.stringify(x, null, 2)` 是**多行**的, 只留第一行 `{` 会解析失败
 * (真跑抓到过: 更新后验证永远判失败 → 每次都"回滚").
 */
export function parseJsonFromStdout(stdout: string): any | null {
  const s = String(stdout || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(s.slice(start));
  } catch {
    // 尾部可能有非 JSON 输出: 退一步只取到最后一个 }
    const end = s.lastIndexOf('}');
    if (end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

// ── registry 查询 (错误分类是本模块的核心价值之一) ──────────────────────────

export interface RegistryDoc { latest: string; distTags: Record<string, string>; versions: string[]; gitHeads: Record<string, string> }
export type RegistryResult =
  | { ok: true; doc: RegistryDoc }
  | { ok: false; kind: 'offline' | 'registry_unavailable'; detail: string };

function httpGetJson(url: string, timeoutMs = 10000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res: any) => {
      let data = '';
      res.on('data', (c: any) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

/**
 * 网络类错误 → offline; 其它 (HTTP 5xx / 解析失败 / 包不存在) → registry_unavailable。
 * **唯一一份在 `dual-source-facts.ts`** (上面已 import+再导出) —— 桌面与手机端同一个分类器。
 */
export { classifyRegistryError };

export async function queryRegistryDoc(pkg: string = PKG_NAME, timeoutMs = 10000): Promise<RegistryResult> {
  const url = `${NPM_REGISTRY_BASE}/${encodeURIComponent(pkg).replace('%40', '@')}`;
  try {
    const { status, body } = await httpGetJson(url, timeoutMs);
    if (status < 200 || status >= 300) return { ok: false, ...classifyRegistryError(null, status) };
    let raw: any;
    try {
      raw = JSON.parse(body);
    } catch (e: any) {
      return { ok: false, kind: 'registry_unavailable', detail: 'registry 返回了无法解析的内容' };
    }
    const distTags = (raw?.['dist-tags'] || {}) as Record<string, string>;
    const versions = Object.keys(raw?.versions || {});
    if (!distTags.latest && versions.length === 0) {
      return { ok: false, kind: 'registry_unavailable', detail: 'registry 上没有可用版本' };
    }
    const gitHeads: Record<string, string> = {};
    for (const v of versions) {
      const gh = raw.versions[v]?.gitHead;
      if (typeof gh === 'string' && gh) gitHeads[v] = gh;
    }
    return { ok: true, doc: { latest: distTags.latest || versions[versions.length - 1], distTags, versions, gitHeads } };
  } catch (e: any) {
    return { ok: false, ...classifyRegistryError(e) };
  }
}

// ── 检查 ────────────────────────────────────────────────────────────────────

export interface CheckResult {
  status: CheckStatus;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  source: UpdateSource;
  installMethod: InstallMethod;
  checkedAt: string;
  /** 结论来自缓存 (本次没打网络) */
  fromCache: boolean;
  /** 缓存里那条结论 (status='check_skipped' 时才有意义) */
  cachedStatus?: CheckStatus | null;
  /** 非致命附加说明 (unsupported_installation 时说明为什么) */
  reason?: string;
  /** 目标版本在 registry 上真实存在 + 当前版本在 registry 上存在 (回滚可行性) */
  targetPublished?: boolean;
  rollbackSupported?: boolean;

  // ── 双源事实 (§12, 2026-09-25) ──────────────────────────────────────────
  /** 该通道的**比较语义** (stable=semver / dev=git-ref) —— 显式 */
  channelKind?: ChannelKind;
  /** 当前装的是哪个源 (从**磁盘身份**读, 不是从状态猜) */
  installedChannel?: InstalledChannel | null;
  /** 磁盘身份里的 dev commit sha; 非 dev 安装 = null */
  installedDevSha?: string | null;
  /** dev 通道: git ref + commit sha 的新旧判定 (不用 semver) */
  dev?: DevCheck | null;
  /** dev 通道: 目标快照身份 (`<base>+dev.<sha7>`) */
  targetIdentity?: string | null;
  /** stable 通道: npm ↔ GitHub 的交叉校验结论 */
  crossCheck?: CrossCheck | null;
  /** GitHub 源的事实 (可达性 / HEAD / Release / Tag) */
  github?: GithubReport | null;
  /** 一键能切回的那个源 */
  switchableTo?: SwitchTarget | null;
  /** 两个源各自的事实 (落盘, 供 status/doctor 回答"谁答的") */
  sourceFacts?: SourceFacts | null;
}

export interface CheckOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 忽略节流 */
  force?: boolean;
  /** 完全不打网络 (用缓存/状态) */
  offline?: boolean;
  /** 覆盖更新通道 (--channel stable|dev) */
  channel?: string;
  /** 覆盖安装识别 (测试) */
  installation?: InstallationInfo;
  /**
   * 注入 registry 结果 (测试)。
   * **注意**: 注入 registry = 受控检查 —— 此时 GitHub 事实**同样只认注入**(`opts.github`),
   * 不会去打真网。这样已有单测仍是离线的, 而受控验收能同时控制两个源。
   */
  registry?: RegistryResult;
  /** 注入 GitHub 事实 (测试 / 受控假 API) */
  github?: GithubResult;
  /** 不写状态 (测试 / 只读命令) */
  persist?: boolean;
}

/**
 * 检查结论 → 退出码 / "源不可达必拒" 的这一组结论:
 * **唯一一份在 `version-identity.ts`** (上面已 import+再导出)。
 * §12.5 的核心就是这一句: **源不可达 / 版本不存在 → 拒绝并说清 (退出码 2)**,
 * 不许静默装回旧版, 也不许打印"✅ 已是最新"。桌面与手机共用同一份。
 */

/**
 * 检查更新。**这是唯一的检查入口** —— CLI / 启动后台 / Python 检查器 / 安装脚本都走它。
 *
 * 结论优先级 (刻意定死, 防"模糊行为"; §12.3 在 stable 序列里插入两个双源结论):
 *   1. 读不到本地版本               → local_version_unknown (绝不默认 0.0.0 后继续)
 *   2. 安装方式不支持自动更新       → unsupported_installation (仍会带出 latestVersion)
 *   3. 显式跳过 / 节流              → check_skipped (结论来自缓存)
 *   4. 网络不可达                   → offline  (绝不显示"已是最新")
 *   5. GitHub 不可达 (**dev 通道**) → github_unavailable (dev 只有这一个源, 拒绝)
 *   6. registry 不可用 / 包不存在   → registry_unavailable
 *   7. 两个源指向不同版本           → cross_check_mismatch (stable, 拒绝)
 *   8. 有新版 (semver / dev 比 sha) → update_available
 *   9. 否则                         → up_to_date
 *
 * 两套比较语义**显式分开** (§12.1): stable 比 semver; dev 比 commit sha (不碰 semver)。
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<CheckResult> {
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const prefs = await readUpdatePrefs({ home, env: opts.env });
  const channel = resolveUpdateChannel(opts.channel || prefs.channel);
  const channelKind = channelKindOf(channel);
  const install = opts.installation || detectInstallation({ home });
  const pkg = readPackageAt(install.packageRoot);
  const current = isKnownVersion(pkg?.version) ? String(pkg?.version) : 'unknown';
  const currentBase = baseVersionOf(current);
  /** 磁盘身份里就是 dev 快照的 sha —— 不从状态文件猜 */
  const installedDevSha = devShaFromIdentity(current);
  const installedChannel: InstalledChannel = installedDevSha ? 'dev' : 'stable';
  const now = new Date().toISOString();
  const state = await readUpdateState(home);
  const persist = opts.persist !== false;
  /** 注入 registry = 受控检查 (GitHub 事实同样只认注入, 不打真网) */
  const controlled = !!opts.registry;

  const base = {
    currentVersion: current,
    channel,
    channelKind,
    source: install.updateSource,
    installMethod: install.method,
    checkedAt: now,
    fromCache: false,
  } as const;

  const commit = async (r: CheckResult): Promise<CheckResult> => {
    if (persist) {
      await writeUpdateState({
        currentVersion: r.currentVersion,
        latestVersion: r.latestVersion,
        channel: r.channel,
        installMethod: r.installMethod,
        installDir: install.installDir,
        entryPath: install.entryPath,
        nodeVersion: process.version.replace(/^v/, ''),
        platform: os.platform(),
        arch: os.arch(),
        lastCheckAt: r.checkedAt,
        lastCheckStatus: r.status,
        lastCheckReason: r.reason,
        // 双源 (§12): 谁装的 / 哪个 sha / 能切回哪 / 两个源各给了什么
        installedChannel: r.installedChannel ?? installedChannel,
        installedDevSha: r.installedDevSha ?? null,
        sourceFacts: r.sourceFacts ?? null,
        switchableTo: r.switchableTo ?? null,
      }, home);
    }
    return r;
  };

  // 1. 本地版本读不到 —— 不猜
  if (!isKnownVersion(current)) {
    return commit({
      ...base, status: 'local_version_unknown', latestVersion: null,
      installedChannel: null, installedDevSha: null,
      reason: `读不到 ${install.packageRoot}/package.json 的版本`,
    });
  }

  // 3. 显式跳过 / 节流
  const throttled = !opts.force && state.lastCheckAt
    ? (Date.now() - Date.parse(state.lastCheckAt)) < prefs.checkIntervalHours * 3600_000
    : false;
  const useCache = !!opts.offline || throttled;

  if (useCache && state.lastCheckStatus) {
    // 语义: 本次**没有真的检查** → 结论就是 check_skipped, 上次的结论原样带出来
    // (绝不把缓存里的 update_available/up_to_date 冒充成"刚查出来的")
    const cached = state.lastCheckStatus;
    const r = await commit({
      ...base, fromCache: true,
      status: 'check_skipped',
      cachedStatus: cached,
      latestVersion: state.latestVersion,
      installedChannel, installedDevSha,
      switchableTo: state.switchableTo ?? null,
      sourceFacts: state.sourceFacts ?? null,
      reason: opts.offline
        ? `离线模式: 使用缓存结论 (${cached})`
        : `距上次检查不足 ${prefs.checkIntervalHours}h, 使用缓存结论 (${cached})`,
      checkedAt: state.lastCheckAt || now,
    });
    if (persist) await writeUpdateState({ lastCheckReason: r.reason }, home);
    return r;
  }

  // 两个源并行查 (受控检查里 GitHub 事实只认注入)
  const [registry, githubRes] = await Promise.all([
    opts.registry ? Promise.resolve(opts.registry) : queryRegistryDoc(PKG_NAME),
    opts.github
      ? Promise.resolve(opts.github)
      : (controlled || opts.offline ? Promise.resolve(null) : fetchGithubFacts()),
  ]);

  const latest = registry.ok ? (registry.doc.distTags[distTagForChannel(channel)] || registry.doc.latest) : null;
  const githubReport: GithubReport | null = githubRes ? toGithubReport(githubRes) : null;
  const sourceFacts: SourceFacts = {
    npm: registry.ok
      ? { reachable: true, latest }
      : { reachable: false, latest: null, detail: registry.detail },
    github: githubReport
      ? {
        reachable: githubReport.reachable,
        reason: githubReport.reason, detail: githubReport.detail, retryAt: githubReport.retryAt ?? null,
        ref: githubReport.ref, headSha: githubReport.headSha, newestVersion: githubReport.newestVersion,
        releases: githubReport.releases, tags: githubReport.tags,
      }
      : null,
    crossCheck: null,
  };
  const targetPublishedOf = (v: string | null | undefined): boolean | undefined =>
    v && registry.ok ? registry.doc.versions.includes(baseVersionOf(v)) : undefined;
  const rollbackSupportedOf = registry.ok ? registry.doc.versions.includes(currentBase) : undefined;

  // 2. 安装方式不支持自动更新 —— 仍把 latest / 可回滚性带出来, 但结论就是"不支持"
  if (install.method === 'development' || install.method === 'unknown' || install.method === 'release-binary') {
    return commit({
      ...base, status: 'unsupported_installation', latestVersion: latest,
      installedChannel, installedDevSha, github: githubReport, sourceFacts,
      switchableTo: state.switchableTo ?? null,
      reason: `${install.reason}; 这种安装方式不支持自动更新`,
      targetPublished: targetPublishedOf(latest),
      rollbackSupported: rollbackSupportedOf,
    });
  }

  // ── dev 通道: git ref + commit sha (不碰 semver) ─────────────────────────
  if (channelKind === 'git-ref') {
    /** dev 的"一键回 stable"目标 = registry 上的 latest (§12.4 硬约束 3) */
    const backToStable: SwitchTarget = { channel: 'stable', source: 'npm', target: latest };
    const devBase = {
      ...base, installedChannel, installedDevSha, github: githubReport,
      switchableTo: backToStable, sourceFacts,
    };
    // dev 只有 GitHub 一个源 → 不可达就是**直接拒** (没有第二个源可退, §12.3)
    if (!githubReport || !githubReport.reachable) {
      const reason = githubReport?.reason || (opts.offline ? 'offline' : 'http_error');
      const detail = githubReport?.detail
        || (opts.offline ? '离线模式: 未查询 GitHub 源' : '本次未查询 GitHub 源 (受控检查未注入 GitHub 事实)');
      return commit({
        ...devBase, status: 'github_unavailable', latestVersion: null, dev: null, targetIdentity: null,
        reason: `github_unavailable(${reason}): ${detail} — dev 通道只有 GitHub 一个源, 拒绝安装 (不回落到 stable 装一个 npm 版本)`,
      });
    }
    if (!githubReport.headSha) {
      return commit({
        ...devBase, status: 'github_unavailable', latestVersion: null, dev: null, targetIdentity: null,
        reason: `github_unavailable(not_found): GitHub 上没有 refs/heads/master 或读不到 HEAD — 拒绝安装一个身份不明的快照`,
      });
    }
    const dev = compareDevSnapshots(installedDevSha, githubReport.headSha, githubReport.ref);
    const targetIdentity = devIdentity(currentBase, githubReport.headSha);
    const common = {
      ...devBase, dev, targetIdentity, latestVersion: targetIdentity, targetPublished: true,
      rollbackSupported: rollbackSupportedOf,
    };
    if (dev.same) return commit({ ...common, status: 'up_to_date', reason: dev.detail });
    return commit({
      ...common, status: 'update_available',
      reason: `${dev.detail}${registry.ok ? '' : ` · 注意: registry 不可达 (${registry.detail}) — 回 stable 会需要它`}`,
    });
  }

  // ── stable 通道: npm 是权威, GitHub 是交叉校验 (§12.1) ───────────────────
  // 4/5. registry 拿不到 —— 绝不显示"已是最新" (GitHub 的事实一并摆出来, 方便判断是哪一源的问题)
  if (!registry.ok) {
    return commit({
      ...base,
      status: registry.kind === 'offline' ? 'offline' : 'registry_unavailable',
      latestVersion: null,
      installedChannel, installedDevSha, github: githubReport, sourceFacts,
      switchableTo: state.switchableTo ?? null,
      reason: `${registry.detail}${githubReport ? ` · ${renderGithubReportLine(githubReport)}` : ''}`,
    });
  }

  const crossCheck = githubRes && githubRes.ok ? crossCheckStable(latest, githubRes.facts) : null;
  sourceFacts.crossCheck = crossCheck ? { kind: crossCheck.kind, blocking: crossCheck.blocking, detail: crossCheck.detail } : null;
  const switchableTo: SwitchTarget = installedDevSha
    ? { channel: 'stable', source: 'npm', target: latest }
    : { channel: 'dev', source: 'github', target: githubReport?.headSha ? githubReport.headSha.slice(0, 7) : null };
  const stableBase = {
    ...base, installedChannel, installedDevSha, github: githubReport, crossCheck, sourceFacts, switchableTo,
  };
  const targetPublished = !!latest && registry.doc.versions.includes(latest);
  const rollbackSupported = rollbackSupportedOf === true;

  // 7. 两个源指向不同版本 → 拒绝 (不许按 GitHub 的记录去装)
  if (crossCheck?.kind === 'mismatch') {
    return commit({
      ...stableBase, status: 'cross_check_mismatch', latestVersion: latest,
      targetPublished, rollbackSupported,
      reason: `cross_check_mismatch: ${crossCheck.detail} (npm latest=${latest} / GitHub ${crossCheck.githubVersion || '无记录'})`,
    });
  }

  // 8/9. 比较: 当前是 dev 快照时**显式**判"切回 stable", 而不是拿 semver 硬比
  if (isDevIdentity(current)) {
    return commit({
      ...stableBase, status: 'update_available', latestVersion: latest,
      targetPublished, rollbackSupported,
      reason: `当前装的是 dev 快照 ${current} → 切回 stable 的 ${latest || '未知'} (一键: ${DEV_BACK_TO_STABLE_HINT})`,
    });
  }
  if (latest && compareVersions(currentBase, latest) < 0) {
    return commit({
      ...stableBase, status: 'update_available', latestVersion: latest, targetPublished, rollbackSupported,
      reason: `当前 ${current} → 目标 ${latest}${crossCheck ? ` · 交叉校验: ${crossCheck.kind}` : ''}`,
    });
  }

  return commit({ ...stableBase, status: 'up_to_date', latestVersion: latest, targetPublished, rollbackSupported });
}

// ── 计划 ────────────────────────────────────────────────────────────────────

export interface RiskCheck {
  id: string;
  label: string;
  ok: boolean;
  /** 阻塞 = 不能更新; 非阻塞 = 只是提醒/建议延迟 */
  blocking: boolean;
  detail: string;
  /** 需要人工看一眼的信号 (Supervisor/Goal/支付) */
  advisory?: boolean;
}

export interface UpdatePlan {
  ok: boolean;
  currentVersion: string;
  targetVersion: string | null;
  channel: UpdateChannel;
  /** 该通道的比较语义 (stable=semver / dev=git-ref) */
  channelKind: ChannelKind;
  /** dev 通道的目标快照身份 (`<base>+dev.<sha7>`) */
  targetIdentity?: string | null;
  /** 必须原样打印给用户的提醒 (dev 通道警告等) —— 不许各处自己造一句 */
  warnings: string[];
  installMethod: InstallMethod;
  source: UpdateSource;
  installDir: string;
  needsRestart: boolean;
  willUpdate: string[];
  willNotTouch: string[];
  risk: RiskCheck[];
  blockers: string[];
  advisories: string[];
  strategies: ('now' | 'wait' | 'cancel')[];
  defaultStrategy: 'now' | 'wait';
  check: CheckResult;
}

const WILL_NOT_TOUCH = [
  '~/.bolloon/config.json',
  '~/.bolloon/goals/',
  '~/.bolloon/runs/',
  '~/.bolloon/transactions/',
  '~/.bolloon/skills/',
  '~/.bolloon/sessions/',
  '~/.bolloon/identity/',
];

/** 磁盘余量 (字节)。statfs 不可用时返回 null (不假装知道)。 */
export function freeBytesAt(dir: string): number | null {
  try {
    const st: any = (fs as any).statfsSync?.(dir);
    if (!st) return null;
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export const MIN_FREE_BYTES = 300 * 1024 * 1024;

/** 安装类风险: 与"机器上有没有在跑的任务"无关, 任何计划都要评估 (测试也不许跳过)。 */
async function collectInstallRisk(install: InstallationInfo): Promise<RiskCheck[]> {
  const out: RiskCheck[] = [];

  out.push({
    id: 'install_method', label: '安装方式支持自动更新', ok: install.method === 'npm-global', blocking: true,
    detail: install.method === 'npm-global'
      ? `npm 全局安装 (${install.installDir})`
      : `${install.method}: ${install.reason} (请用对应方式更新: git pull + npm run build:all / 项目的包管理)`,
  });

  out.push({
    id: 'install_dir_writable', label: '安装目录可写', ok: install.writable, blocking: true,
    detail: install.writable ? install.installDir : `${install.installDir} 不可写 (需要 sudo 或改 npm prefix)`,
  });

  const free = freeBytesAt(install.installDir);
  out.push({
    id: 'disk_space', label: '磁盘空间充足', ok: free === null ? true : free >= MIN_FREE_BYTES,
    blocking: free === null ? false : free < MIN_FREE_BYTES,
    detail: free === null ? '无法读取磁盘余量 (跳过)' : `${(free / 1024 / 1024 / 1024).toFixed(2)} GiB 可用 (需 ≥ ${(MIN_FREE_BYTES / 1024 / 1024).toFixed(0)} MiB)`,
  });

  const lock = readUpdateLock();
  out.push({
    id: 'update_lock', label: '没有其它更新进程', ok: !lock || lockIsStale(lock), blocking: !!lock && !lockIsStale(lock),
    detail: !lock ? '无更新锁'
      : lockIsStale(lock) ? `存在陈旧锁 (pid ${lock.pid}, ${lock.at}) — 可回收`
        : `另一个更新进程持有锁 (pid ${lock.pid}, ${lock.at})`,
  });

  return out;
}

/** 负载类风险: Supervisor / Goal / Run / 支付 (非阻塞提醒, 但会把默认策略变成"等 Run 结束")。 */
async function collectWorkloadRisk(): Promise<RiskCheck[]> {
  const out: RiskCheck[] = [];
  try {
    const { supervisorStatePath } = await import('../agents/supervisor-host.js');
    let sup: any = null;
    try { sup = JSON.parse(await fsp.readFile(supervisorStatePath(), 'utf8')); } catch { sup = null; }
    const alive = sup && typeof sup.pid === 'number' ? (() => { try { process.kill(sup.pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } })() : false;
    const running = !!sup && alive && !sup.stoppedAt;
    out.push({
      id: 'supervisor_running', label: 'Supervisor 未在运行', ok: !running, blocking: false, advisory: true,
      detail: running ? `Supervisor 正在运行 (pid ${sup.pid}, owner ${sup.owner}, 最近 tick ${sup.lastTickAt || '未知'})` : '无运行中的 Supervisor 宿主',
    });
  } catch {
    out.push({ id: 'supervisor_running', label: 'Supervisor 未在运行', ok: true, blocking: false, advisory: true, detail: '无法读取 supervisor.json (按未运行处理)' });
  }

  try {
    const { listGoals } = await import('../agents/goal-store.js');
    const goals = await listGoals({ status: ['open', 'active', 'recovering', 'retry_wait', 'awaiting_external', 'stalled'], limit: 50 });
    out.push({
      id: 'active_goals', label: '没有进行中的 Goal', ok: goals.length === 0, blocking: false, advisory: true,
      detail: goals.length === 0 ? '无进行中 Goal' : `${goals.length} 个未收尾 Goal (${goals.slice(0, 3).map((g: any) => `${g.goalId}:${g.status}`).join(', ')}${goals.length > 3 ? ', …' : ''})`,
    });
  } catch {
    out.push({ id: 'active_goals', label: '没有进行中的 Goal', ok: true, blocking: false, advisory: true, detail: '无法读取 goals (按无处理)' });
  }

  try {
    const { listRuns } = await import('../agents/run-store.js');
    const runs = await listRuns({ status: ['queued', 'running', 'recovering', 'paused', 'awaiting_external', 'interrupted', 'stalled'], limit: 50 });
    out.push({
      id: 'active_runs', label: '没有进行中的 Run', ok: runs.length === 0, blocking: false, advisory: true,
      detail: runs.length === 0 ? '无进行中 Run' : `${runs.length} 个未收尾 Run (${runs.slice(0, 3).map((r: any) => `${r.runId}:${r.status}`).join(', ')}${runs.length > 3 ? ', …' : ''})`,
    });
  } catch {
    out.push({ id: 'active_runs', label: '没有进行中的 Run', ok: true, blocking: false, advisory: true, detail: '无法读取 runs (按无处理)' });
  }

  try {
    const { pendingTransactions } = await import('../agents/x402/transaction-store.js');
    const pend = await pendingTransactions();
    const paying = pend.filter((t: any) => ['paying', 'payment_required'].includes(t.status));
    out.push({
      id: 'payment_in_flight', label: '没有支付中的交易', ok: paying.length === 0, blocking: false, advisory: true,
      detail: paying.length === 0
        ? (pend.length ? `${pend.length} 笔待收尾交易 (无支付中, 可继续)` : '无待收尾交易')
        : `${paying.length} 笔支付中/待付交易 (${paying.slice(0, 3).map((t: any) => t.id || t.transactionId).join(', ')}) — 更新前应先对账`,
    });
  } catch {
    out.push({ id: 'payment_in_flight', label: '没有支付中的交易', ok: true, blocking: false, advisory: true, detail: '无法读取 transactions (按无处理)' });
  }

  return out;
}

export interface PlanOptions extends CheckOptions {
  installation?: InstallationInfo;
  /** 跳过 registry (离线计划: 只显示本地可判定的部分) */
  skipRegistry?: boolean;
  /** 测试注入: 覆盖**负载类**风险探测 (不动真实 supervisor/goals/runs/transactions);
   *  安装类风险 (安装方式/可写/磁盘/锁) 永远真实评估, 不许被注入跳过。 */
  workloadRiskOverride?: RiskCheck[];
}

export async function buildUpdatePlan(opts: PlanOptions = {}): Promise<UpdatePlan> {
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const install = opts.installation || detectInstallation({ home });
  const check = await checkForUpdate({ ...opts, home, persist: false, installation: install });
  const isDev = check.channelKind === 'git-ref';

  const risk = [
    ...await collectInstallRisk(install),
    ...(opts.workloadRiskOverride || await collectWorkloadRisk()),
  ];

  // registry 侧风险项来自检查结论
  risk.push({
    id: 'registry_reachable',
    label: 'registry 可达',
    ok: check.status !== 'offline' && check.status !== 'registry_unavailable',
    blocking: check.status === 'offline' || check.status === 'registry_unavailable' || check.status === 'local_version_unknown',
    detail: check.status === 'offline' ? `离线: ${check.reason}`
      : check.status === 'registry_unavailable' ? `registry 不可用: ${check.reason}`
        : 'npm registry 可达',
  });
  /**
   * GitHub 侧风险 (§12.3) —— **dev 通道阻塞, stable 通道只提醒**:
   * dev 只有 GitHub 一个源, 不可达就没有"退回哪去"这件事; stable 的权威是 npm, GitHub 只是交叉校验源。
   */
  const gh = check.github;
  risk.push({
    id: 'github_reachable',
    label: 'GitHub 源可达 (dev 通道的源 / stable 的交叉校验源)',
    ok: !gh ? true : gh.reachable,
    blocking: isDev && (!gh || !gh.reachable),
    advisory: !isDev,
    detail: !gh
      ? '未查询 GitHub 源 (离线或受控检查未注入)'
      : gh.reachable
        ? `可达 · master HEAD ${gh.headSha ? gh.headSha.slice(0, 7) : '未知'} · Release ${gh.releases ?? 0} 个 · Tag ${gh.tags ?? 0} 个`
        : `github_unavailable(${gh.reason}): ${gh.detail || ''}${gh.retryAt ? ` (限流重试 ${gh.retryAt})` : ''}`,
  });
  risk.push({
    id: 'cross_check',
    label: '两个源指向同一版本 (npm ↔ GitHub)',
    ok: check.crossCheck ? check.crossCheck.kind !== 'mismatch' : true,
    blocking: !!check.crossCheck?.blocking,
    advisory: check.crossCheck?.kind === 'missing_record' || check.crossCheck?.kind === 'no_record_at_all',
    detail: !check.crossCheck
      ? (isDev ? 'dev 通道不看 npm (GitHub 是唯一源)' : '未做交叉校验 (GitHub 源未查)')
      : check.crossCheck.detail,
  });
  risk.push({
    id: 'target_published',
    label: '目标版本真实存在',
    ok: check.targetPublished !== false,
    blocking: !!check.latestVersion && check.targetPublished === false,
    detail: check.targetPublished === false
      ? `registry 上没有 ${PKG_NAME}@${check.latestVersion} — 不执行更新`
      : check.targetPublished === true ? `已确认 ${check.latestVersion} 可下载` : '未检查 (离线)',
  });
  risk.push({
    id: 'rollback_supported',
    label: '当前版本可回滚',
    ok: check.rollbackSupported !== false,
    blocking: false,
    detail: check.rollbackSupported === false
      ? `registry 上找不到当前版本 ${baseVersionOf(check.currentVersion)} — 更新失败将无法用 npm 回滚`
      : check.rollbackSupported === true ? `registry 上存在 ${baseVersionOf(check.currentVersion)} (可回滚)` : '未检查 (离线)',
  });

  const blockers = risk.filter((r) => !r.ok && r.blocking).map((r) => `${r.label}: ${r.detail}`);
  const advisories = risk.filter((r) => !r.ok && !r.blocking).map((r) => `${r.label}: ${r.detail}`);

  const target = check.status === 'update_available'
    ? (check.targetIdentity || check.latestVersion || null)
    : null;

  const warnings: string[] = [];
  if (isDev) {
    warnings.push(DEV_CHANNEL_WARNING);
    warnings.push(DEV_BACK_TO_STABLE_HINT);
  }
  if (check.installedDevSha && !isDev) warnings.push(`当前装的是 dev 快照 (commit ${check.installedDevSha}), 本次要切回 stable: 会把 GitHub master 快照换成 registry 上的 latest`);

  return {
    ok: blockers.length === 0 && !!target,
    currentVersion: check.currentVersion,
    targetVersion: target,
    channel: check.channel,
    channelKind: check.channelKind || channelKindOf(check.channel),
    targetIdentity: check.targetIdentity ?? null,
    warnings,
    installMethod: check.installMethod,
    source: check.source,
    installDir: install.installDir,
    needsRestart: !!target,
    willUpdate: target && install.method === 'npm-global'
      ? (isDev ? [`GitHub master 快照 ${check.github?.headSha?.slice(0, 7) || ''} (身份 ${target})`, PKG_NAME] : [PKG_NAME, CONSTRAINT_PKG_NAME])
      : [],
    willNotTouch: WILL_NOT_TOUCH,
    risk, blockers, advisories,
    strategies: ['now', 'wait', 'cancel'],
    defaultStrategy: advisories.length > 0 ? 'wait' : 'now',
    check,
  };
}

export function renderUpdatePlan(plan: UpdatePlan): string {
  const L: string[] = [];
  L.push(`当前版本: ${plan.currentVersion}${plan.check.installedDevSha ? ` (dev 快照 commit ${plan.check.installedDevSha})` : ''}`);
  L.push(`目标版本: ${plan.targetVersion || '(无可用更新)'}`);
  L.push(`安装方式: ${plan.installMethod}`);
  L.push(`更新通道: ${plan.channel} (比较语义: ${plan.channelKind})`);
  L.push(`更新来源: ${plan.source}${plan.channelKind === 'git-ref' ? ' · GitHub master (唯一源)' : ' · npm registry (权威) + GitHub (交叉校验)'}`);
  L.push(renderGithubReportLine(plan.check.github));
  if (plan.check.crossCheck) L.push(`交叉校验: ${plan.check.crossCheck.kind}${plan.check.crossCheck.blocking ? ' (阻塞)' : ''} — ${plan.check.crossCheck.detail}`);
  if (plan.check.dev) L.push(`dev 快照: ${plan.check.dev.detail}`);
  for (const w of plan.warnings) L.push(w);
  L.push(`安装目录: ${plan.installDir}`);
  L.push('');
  L.push('将更新:');
  if (plan.willUpdate.length === 0) L.push('  (无 — 当前没有可执行的更新)');
  for (const p of plan.willUpdate) L.push(`  ${p}`);
  L.push('');
  L.push('不会修改:');
  for (const p of plan.willNotTouch) L.push(`  ${p}`);
  L.push('');
  L.push(`需要重启: ${plan.needsRestart ? '是' : '否'}`);
  L.push(`风险检查: ${plan.blockers.length === 0 ? '通过' : `未通过 (${plan.blockers.length} 项阻塞)`}`);
  for (const r of plan.risk) L.push(`  ${r.ok ? '✓' : r.blocking ? '✗' : '!'} ${r.label}: ${r.detail}`);
  if (plan.blockers.length) {
    L.push('');
    L.push('阻塞项 (修好才能更新):');
    for (const b of plan.blockers) L.push(`  - ${b}`);
  }
  if (plan.advisories.length) {
    L.push('');
    L.push('提醒 (不阻塞, 但建议先处理):');
    for (const a of plan.advisories) L.push(`  - ${a}`);
    L.push(`  建议策略: 等当前 Run 结束后更新 (bolloon update --now --wait)`);
  }
  L.push('');
  L.push(`可选: 立即更新 (bolloon update --now --channel ${plan.channel}) / 等当前 Run 结束 (bolloon update --now --wait --channel ${plan.channel}) / 取消`);
  if (plan.channelKind === 'git-ref') L.push(`一键回稳定版: bolloon update now --channel stable`);
  L.push(`默认: ${plan.defaultStrategy === 'wait' ? '等待当前 Run 结束后更新' : '立即更新'}`);
  return L.join('\n');
}

// ── 执行 ────────────────────────────────────────────────────────────────────

export type UpdateStage = 'planned' | 'downloading' | 'staged' | 'switching' | 'verifying' | 'succeeded' | 'failed' | 'rolled_back' | 'blocked';

/** 进行中的阶段 (落盘时看到它 = 上次更新被中断; 与 update-state 的 IN_FLIGHT_RUN_STATUSES 同义) */
export const IN_FLIGHT_STAGES: UpdateStage[] = ['planned', 'downloading', 'staged', 'switching', 'verifying'];

export interface ApplyOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  strategy?: 'now' | 'wait';
  /** 强制: 即使有提醒项也继续 (阻塞项仍然阻塞) */
  force?: boolean;
  /** 目标通道 (§12.2: `--channel stable|dev`) —— dev 走 GitHub master 快照, stable 走 npm */
  channel?: string;
  /** 注入 registry 结果 (测试) */
  registry?: RegistryResult;
  /** 注入 GitHub 事实 (测试 / 受控 API) */
  github?: GithubResult;
  /** 注入安装命令执行器 (测试) */
  runNpm?: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };
  /** 注入 dev 快照产物 (测试): 跳过"取源码 + 构建 + 打包", 但切换/验证/回滚仍是真跑 */
  devSnapshot?: { tarball: string; identity: string; sha: string };
  /** 注入切换后验证 (测试) */
  verifyInstall?: (target: string, home: string) => Promise<boolean>;
  onStage?: (stage: UpdateStage, detail: string) => void;
  installation?: InstallationInfo;
  /** 测试注入: 覆盖负载类风险探测 (见 PlanOptions.workloadRiskOverride) */
  workloadRiskOverride?: RiskCheck[];
}

export interface ApplyOutcome {
  stage: UpdateStage;
  /** 失败发生在哪一步 (stage 是最终结果, 例如 failed/rolled_back) */
  failedAt?: UpdateStage;
  ok: boolean;
  from: string;
  to: string;
  durationMs: number;
  reason?: string;
  needsRestart: boolean;
  stagedTarball?: string | null;
  health?: { grade: string; detail: string } | null;
}

/** npm 默认只重试 2 次/10s —— 真网络抖动会让一次干净安装失败 (本机 ECONNRESET 实测)。 */
export const NPM_FETCH_RETRY_FLAGS = [
  '--fetch-retries=5', '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=120000',
];

function defaultRunNpm(args: string[], cwd: string) {
  const finalArgs = args[0] === 'pack' || args[0] === 'install' ? [...args, ...NPM_FETCH_RETRY_FLAGS] : args;
  const r = spawnSync('npm', finalArgs, { cwd, encoding: 'utf-8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 校验一个解压后的包目录: 版本对得上 + 入口存在。 */
export function validateStagedPackage(dir: string, target: string): { ok: boolean; detail: string } {
  const pkg = readPackageAt(dir);
  if (!pkg) return { ok: false, detail: `${dir}/package.json 读不到` };
  if (pkg.version !== target) return { ok: false, detail: `临时目录版本 ${pkg.version} ≠ 目标 ${target}` };
  const entry = path.join(dir, 'dist', 'cli-entry.js');
  if (!fs.existsSync(entry)) return { ok: false, detail: '包内缺少 dist/cli-entry.js' };
  return { ok: true, detail: `版本 ${pkg.version} + 入口存在` };
}

/** 读"磁盘上真的装了什么版本" (不看进程内存), 供切换后验证。 */
export function installedVersionOnDisk(installRoot: string): string | null {
  return readPackageAt(installRoot)?.version ?? null;
}

/**
 * 执行更新。
 *
 * 流水线: 计划(检查+锁) → 下载 tarball 到临时目录并校验 → 切换(npm 替换) → 验证 → 成功/回滚。
 * 任何一步失败: 清理临时目录、保留旧版本、写失败原因、释放锁、用户继续用旧版本。
 */
export async function applyUpdate(opts: ApplyOptions = {}): Promise<ApplyOutcome> {
  const started = Date.now();
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const install = opts.installation || detectInstallation({ home });
  /** 落盘"进行中"的阶段 —— 这样进程被 SIGKILL 时盘上会留下证据 (doctor 报"上次更新异常中断") */
  const markInFlight = async (s: UpdateStage, detail: string) => {
    if (!(IN_FLIGHT_STAGES as string[]).includes(s)) return;
    try {
      await writeUpdateState({
        lastUpdate: { at: new Date().toISOString(), from, to, status: s as UpdateRunStatus, reason: detail },
      }, home);
    } catch { /* 阶段留痕写失败不能影响更新本身 */ }
  };
  /**
   * 报阶段 —— **必须 await**: 先在盘上落下"进行中"的阶段, 再去做那件危险的事
   * (否则进程在写状态之前被杀, 盘上就没有"上次更新中断"的证据)。
   */
  const stage = async (s: UpdateStage, detail: string) => {
    try { opts.onStage?.(s, detail); } catch { /* 回调失败不影响流程 */ }
    await markInFlight(s, detail);
  };

  const plan = await buildUpdatePlan({
    home, env: opts.env, force: true, installation: install, registry: opts.registry,
    github: opts.github, channel: opts.channel,
    workloadRiskOverride: opts.workloadRiskOverride,
  });
  const from = plan.currentVersion;
  const to = plan.targetVersion || plan.currentVersion;
  const isDev = plan.channelKind === 'git-ref';
  /** dev 的目标 commit (身份就是它, 不是版本号) */
  const devSha = plan.check.dev?.headSha || plan.check.github?.headSha || null;


  const record = async (r: ApplyOutcome, historyStatus: UpdateRunStatus) => {
    const rec: UpdateRecord = { at: new Date().toISOString(), from: r.from, to: r.to, status: historyStatus, durationMs: r.durationMs, reason: r.reason };
    // 记账失败**不能**把"更新其实成功了"变成向上抛异常 (真被测试 teardown 竞态抓到过:
    // HOME 在写到一半时消失 → rename ENOENT)。失败就如实记进 reason, 结果照常返回。
    try {
      await appendUpdateHistory(rec, home);
      /**
       * 双源落盘 (§12.4 硬约束 2): 装成 dev 时记下 `{channel, devSha, devRef, checkedAt}`;
       * 切回 stable 时把安装通道改回 stable 并把 dev 记录保留成"上次那个 dev 快照"。
       */
      const dualSource: Partial<UpdateState> = isDev && r.ok
        ? {
          installedChannel: 'dev',
          installedDevSha: devSha ? devSha.slice(0, 7) : devShaFromIdentity(r.to),
          devSha: devSha || null,
          devRef: `refs/heads/master`,
          devCheckedAt: rec.at,
          switchableTo: { channel: 'stable', source: 'npm', target: baseVersionOf(r.from) },
        }
        : {};
      const backToStable: Partial<UpdateState> = !isDev && r.ok
        ? { installedChannel: 'stable', installedDevSha: null, switchableTo: { channel: 'dev', source: 'github', target: devSha ? devSha.slice(0, 7) : null } }
        : {};
      await writeUpdateState({
        lastUpdate: rec,
        lastFailure: r.ok ? null : { at: rec.at, stage: r.failedAt || r.stage, reason: r.reason || '未知原因' },
        needsRestart: r.ok ? r.needsRestart : false,
        currentVersion: r.from,
        ...dualSource,
        ...backToStable,
      }, home);
    } catch (e: any) {
      const note = `状态记录写入失败: ${e?.message || e}`;
      return { ...r, reason: r.reason ? `${r.reason}; ${note}` : note };
    }
    return r;
  };

  if (!plan.targetVersion) {
    /**
     * §12.5 的核心分流: **源不可达 / 版本不存在 → 拒绝并说清**,
     * 绝不把"没查到"说成"已是最新"。
     */
    const refused = REFUSED_STATUSES.includes(plan.check.status);
    await stage('blocked', refused ? `拒绝更新 (${plan.check.status})` : '没有可执行的更新');
    const reason = refused
      ? `拒绝更新 (${plan.check.status}): ${plan.check.reason || plan.blockers[0] || '源不可达 / 版本不存在'}`
      : (plan.blockers[0] || '已是最新, 无需更新');
    return record({ stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason, needsRestart: false }, 'blocked');
  }

  if (plan.blockers.length > 0) {
    await stage('blocked', plan.blockers.join('; '));
    return record({ stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason: `阻塞: ${plan.blockers.join('; ')}`, needsRestart: false }, 'blocked');
  }

  if (opts.strategy === 'wait' && plan.advisories.length > 0) {
    await stage('blocked', '按策略等待当前 Run 结束');
    const reason = `等待当前 Run 结束后更新 (${plan.advisories.length} 项提醒); 待收尾后重新执行 bolloon update --now`;
    await appendUpdateHistory({ at: new Date().toISOString(), from, to, status: 'planned', reason }, home);
    return { stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason, needsRestart: false };
  }

  // 锁 (第二个进程不许同时更新)
  const lock = await acquireUpdateLock({ home, reason: `${from} → ${to}` });
  if (!lock.ok) {
    const held = lock.heldBy;
    await stage('blocked', `已有更新进程 (pid ${held?.pid})`);
    return record({ stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason: `另一个更新进程持有锁 (pid ${held?.pid}, ${held?.at})`, needsRestart: false }, 'blocked');
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bolloon-update-'));
  const runNpm = opts.runNpm || defaultRunNpm;
  let stagedTarball: string | null = null;
  /** 切换时交给 npm 的安装目标: stable = `<包>@<semver>`; dev = 本地 dev 快照 tarball */
  let switchSpec = `${PKG_NAME}@${to}`;
  /**
   * 实际装入的身份。dev 的身份来自**源码树的 package.json + master sha**, 可能与检查阶段的预测
   * 略有差别 (源码树的版本号才是真的) → 以产物为准, 校验/验证/记账都用它, 不用预测值糊过去。
   */
  let effectiveTo = to;

  try {
    // 1. 取产物到临时目录 (不动现有安装)
    if (isDev) {
      // dev: 源是 GitHub master 的 git ref, 身份是 commit sha (§12.1)
      if (!devSha) {
        throw Object.assign(new Error('dev 通道没有拿到 master HEAD 的 commit sha — 拒绝安装一个身份不明的快照'), { stage: 'downloading' as UpdateStage });
      }
      await stage('downloading', `取 GitHub master @ ${devSha.slice(0, 7)} (${DEV_BACK_TO_STABLE_HINT})`);
      const snap = opts.devSnapshot
        ? { ok: true as const, tarball: opts.devSnapshot.tarball, identity: opts.devSnapshot.identity, sha: opts.devSnapshot.sha, source: 'injected', built: false, dir: '' }
        : await prepareDevSnapshot({
          sha: devSha, workDir: tmpRoot, env: opts.env,
          runNpm,
          onStage: (s, d) => { try { opts.onStage?.(s as UpdateStage, d); } catch { /* 回调失败不影响流程 */ } },
        });
      if (!snap.ok) {
        const kind = 'kind' in snap ? String(snap.kind) : 'dev_source_failed';
        const reason = 'reason' in snap ? String(snap.reason) : '';
        const detail = 'detail' in snap ? String(snap.detail) : '未知原因';
        throw Object.assign(new Error(`${kind}/${reason}: ${detail}`), { stage: 'downloading' as UpdateStage });
      }
      stagedTarball = snap.tarball;
      switchSpec = snap.tarball;
      effectiveTo = snap.identity;
      await stage('staged', `dev 快照身份 ${snap.identity} (来源 ${snap.source}${snap.built ? ', 已现场构建' : ''})`);
    } else {
      await stage('downloading', `npm pack ${PKG_NAME}@${to}`);
      const packed = runNpm(['pack', `${PKG_NAME}@${to}`, '--pack-destination', tmpRoot, '--loglevel=error'], tmpRoot);
      if (packed.code !== 0) {
        throw Object.assign(new Error(`下载 ${PKG_NAME}@${to} 失败: ${(packed.stderr || packed.stdout).trim().slice(0, 400)}`), { stage: 'downloading' as UpdateStage });
      }
      const tarballs = (await fsp.readdir(tmpRoot)).filter((f) => f.endsWith('.tgz'));
      if (tarballs.length === 0) throw Object.assign(new Error('npm pack 没有产出 tarball'), { stage: 'downloading' as UpdateStage });
      stagedTarball = path.join(tmpRoot, tarballs[0]);
    }

    // 2. 解压 + 校验包内容 (版本 + 入口) —— 两个源共用同一条校验
    if (!isDev) await stage('staged', `解压并校验 ${path.basename(stagedTarball)}`);
    const extractDir = path.join(tmpRoot, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', stagedTarball, '-C', extractDir], { encoding: 'utf-8', timeout: 120_000 });
    if (tar.status !== 0) throw Object.assign(new Error(`解压失败: ${(tar.stderr || '').slice(0, 300)}`), { stage: 'staged' as UpdateStage });
    const stagedCheck = validateStagedPackage(path.join(extractDir, 'package'), effectiveTo);
    if (!stagedCheck.ok) throw Object.assign(new Error(`目标包校验失败: ${stagedCheck.detail}`), { stage: 'staged' as UpdateStage });

    // 3. 切换 (npm 完成替换; 旧版本在替换成功前不会消失) —— 两个源共用同一条替换路径
    await stage('switching', isDev ? `npm install -g <dev 快照 ${path.basename(switchSpec)}>` : `npm install -g ${PKG_NAME}@${to}`);
    const installed = runNpm(['install', '-g', switchSpec, '--no-fund', '--no-audit', '--loglevel=error'], os.tmpdir());
    if (installed.code !== 0) {
      throw Object.assign(new Error(`npm 安装失败: ${(installed.stderr || installed.stdout).trim().slice(0, 400)}`), { stage: 'switching' as UpdateStage });
    }

    // 4. 验证: 磁盘版本 + 新入口真能启动 + 健康检查
    await stage('verifying', '核对磁盘版本并试启新入口');
    const verify = opts.verifyInstall || defaultVerifyInstall;
    const ok = await verify(effectiveTo, home);
    if (!ok) throw Object.assign(new Error(`切换后验证失败: 新版本 ${effectiveTo} 未能正确启动`), { stage: 'verifying' as UpdateStage });

    await stage('succeeded', `已更新到 ${effectiveTo}`);
    const out: ApplyOutcome = {
      stage: 'succeeded', ok: true, from, to: effectiveTo, durationMs: Date.now() - started, needsRestart: true, stagedTarball,
    };
    await record(out, 'succeeded');
    return out;
  } catch (e: any) {
    const failureStage: UpdateStage = (e?.stage as UpdateStage) || 'failed';
    const reason: string = e?.message || String(e);
    await stage(failureStage, reason);

    // 失败处理: 保留旧版本 → 能回滚就回滚 → 写原因 → 释放锁
    const fromBase = baseVersionOf(from);
    let finalStage: UpdateStage = 'failed';
    let finalReason = reason;
    try {
      const nowVersion = installedVersionOnDisk(install.packageRoot);
      if (install.method === 'npm-global' && nowVersion && nowVersion !== from && nowVersion !== effectiveTo) {
        await stage('rolled_back', `检测到半更新 (磁盘版本 ${nowVersion}), 回滚到 ${fromBase}`);
        const rb = runNpm(['install', '-g', `${PKG_NAME}@${fromBase}`, '--no-fund', '--no-audit', '--loglevel=error'], os.tmpdir());
        const after = installedVersionOnDisk(install.packageRoot);
        if (rb.code === 0 && after === fromBase) {
          finalStage = 'rolled_back';
          finalReason = `${reason}; 已回滚到 ${fromBase}`;
        } else {
          finalReason = `${reason}; 回滚也未成功 (磁盘版本 ${after || 'unknown'}) — 请手动: npm install -g ${PKG_NAME}@${fromBase}`;
        }
      } else if (nowVersion === effectiveTo && failureStage === 'verifying') {
        // 装上了但验证没过: 保留新版本但如实报失败, 并给出回滚指令
        finalReason = `${reason}; 磁盘版本已是 ${effectiveTo}, 如需回退: npm install -g ${PKG_NAME}@${fromBase}`;
      }
    } catch (e2: any) {
      finalReason = `${reason}; 回滚过程出错: ${e2?.message || e2}`;
    }

    const out: ApplyOutcome = {
      stage: finalStage, failedAt: failureStage, ok: false, from, to, durationMs: Date.now() - started,
      reason: finalReason, needsRestart: false, stagedTarball,
    };
    await record(out, finalStage === 'rolled_back' ? 'rolled_back' : 'failed');
    return out;
  } finally {
    // 临时目录清理 (成功/失败都清)
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    await releaseUpdateLock(home);
  }
}

async function defaultVerifyInstall(target: string, home: string): Promise<boolean> {
  const install = detectInstallation({ home });
  const onDisk = installedVersionOnDisk(install.packageRoot);
  if (onDisk !== target) return false;
  const entry = path.join(install.packageRoot, 'dist', 'cli-entry.js');
  if (!fs.existsSync(entry)) return false;
  const r = spawnSync(process.execPath, [entry, '--version', '--json'], { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return false;
  const parsed = parseJsonFromStdout(String(r.stdout || ''));
  return parsed?.packageVersion === target;
}

// ── 状态 / 历史 / 摘要 ──────────────────────────────────────────────────────

export interface UpdateStatusReport {
  currentVersion: string;
  /** 当前装的是哪个源 (§12.5: 必须说清"哪个源答的") */
  installedChannel: InstalledChannel | null;
  /** 已装 dev 快照的 commit sha (非 dev = null) */
  installedDevSha: string | null;
  /** 一键能切回的另一个源 */
  switchableTo: SwitchTarget | null;
  /** 最近一次装成 dev 用的 sha (切回 stable 后仍能看到"上次那个 dev 快照") */
  lastDevSha: string | null;
  devRef: string | null;
  devCheckedAt: string | null;
  /** 两个源上次各给了什么 */
  sourceFacts: SourceFacts | null;
  latestVersion: string | null;
  channel: string;
  channelKind: ChannelKind;
  installMethod: string;
  installDir: string;
  entryPath: string;
  lastCheckAt: string | null;
  lastCheckStatus: CheckStatus | null;
  lastCheckReason?: string;
  lastUpdate: UpdateRecord | null;
  lastFailure: { at: string; stage: string; reason: string } | null;
  needsRestart: boolean;
  prefs: UpdatePrefs;
  lock: { pid: number; at: string; by: string; stale: boolean } | null;
}

export async function readUpdateStatus(opts: { home?: string; env?: NodeJS.ProcessEnv; channel?: string; installation?: InstallationInfo } = {}): Promise<UpdateStatusReport> {
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const st = await readUpdateState(home);
  const prefs = await readUpdatePrefs({ home, env: opts.env });
  const lock = readUpdateLock(home);
  const install = opts.installation || detectInstallation({ home });
  const pkg = readPackageAt(install.packageRoot);
  const currentVersion = isKnownVersion(pkg?.version) ? String(pkg?.version) : st.currentVersion;
  const installedDevSha = devShaFromIdentity(currentVersion);
  const channel = resolveUpdateChannel(opts.channel || prefs.channel);
  return {
    currentVersion,
    // 安装通道从**磁盘身份**判定 (不从状态文件猜); 状态里的 dev 记录另外带出来做历史
    installedChannel: installedDevSha ? 'dev' : 'stable',
    installedDevSha,
    switchableTo: st.switchableTo ?? (installedDevSha
      ? { channel: 'stable', source: 'npm', target: st.latestVersion }
      : { channel: 'dev', source: 'github', target: null }),
    lastDevSha: st.devSha ?? null,
    devRef: st.devRef ?? null,
    devCheckedAt: st.devCheckedAt ?? null,
    sourceFacts: st.sourceFacts ?? null,
    latestVersion: st.latestVersion,
    channel,
    channelKind: channelKindOf(channel),
    installMethod: install.method,
    installDir: install.installDir,
    entryPath: install.entryPath,
    lastCheckAt: st.lastCheckAt,
    lastCheckStatus: st.lastCheckStatus,
    lastCheckReason: st.lastCheckReason,
    lastUpdate: st.lastUpdate,
    lastFailure: st.lastFailure,
    needsRestart: st.needsRestart,
    prefs,
    lock: lock ? { ...lock, stale: lockIsStale(lock) } : null,
  };
}

export async function readHistory(limit = 10, home?: string): Promise<UpdateRecord[]> {
  const h = home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  return readUpdateHistory(limit, h);
}

export function renderHistory(records: UpdateRecord[]): string {
  if (records.length === 0) return '没有更新历史记录。';
  const L = ['时间 · 当前版本 → 目标版本 · 结果 · 耗时 · 原因'];
  for (const r of records) {
    const ms = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '-';
    L.push(`${r.at} · ${r.from} → ${r.to} · ${r.status} · ${ms}${r.reason ? ` · ${r.reason}` : ''}`);
  }
  return L.join('\n');
}

/** 启动后台检查用的摘要 (供 --version 显示)。 */
export async function updateSummaryFor(home?: string): Promise<VersionUpdateSummary> {
  const h = home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const st = await readUpdateState(h);
  return {
    lastCheckAt: st.lastCheckAt,
    lastCheckStatus: st.lastCheckStatus,
    lastCheckReason: st.lastCheckReason,
    latestVersion: st.latestVersion,
    lastUpdate: st.lastUpdate ? { at: st.lastUpdate.at, from: st.lastUpdate.from, to: st.lastUpdate.to, status: st.lastUpdate.status, reason: st.lastUpdate.reason } : null,
    needsRestart: st.needsRestart,
    // 双源 (§12.5): "我装的是哪个源 / 哪个 commit / 能切回哪" 从同一份状态读
    installedChannel: st.installedChannel ?? null,
    installedDevSha: st.installedChannel === 'dev' ? (st.installedDevSha ?? null) : null,
    switchableTo: st.switchableTo ?? null,
  };
}
