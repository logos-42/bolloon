/**
 * version-identity.ts — 版本身份 / 通道 / 结论分类的**纯词汇表** (2026-09-26)
 *
 * 为什么要从 `version-info.ts` 里抽出来 (抽出 ≠ 改写): 手机端 WebView **没有 node:**
 * (`fs`/`os`/`path`/`child_process` 都没有), 而手机端双源更新必须用**和桌面同一份**
 * 身份与结论语义 —— 否则同一台机器上的 `bolloon update status` 和手机上的"当前源"
 * 会长出两套说法。所以:
 *
 *   本模块 = **不碰 node 的那一半** (纯函数 + 常量), 桌面与手机都 import 它;
 *   `version-info.ts` = 本模块 + 需要 node 的探测 (安装识别 / git / npm / python / VersionInfo)
 *
 * 纪律 (改这里之前先读):
 *   · 不许 import 任何 `node:*` / 不许在模块顶层直读 `process.env` (浏览器里会 ReferenceError);
 *     环境变量一律走 `envValue()` (`typeof process` 守卫)。
 *   · 版本比较语义与结论枚举**只此一份** (§12.1 / §3): stable 比 semver, dev 比 commit sha。
 */

// ── 包与上游 ────────────────────────────────────────────────────────────────

export const PKG_NAME = '@bolloon/bolloon-agent';
export const CONSTRAINT_PKG_NAME = '@bolloon/constraint-runtime';
export const UPSTREAM_REPO = 'https://github.com/logos-42/bolloon';
/** GitHub 上游 (owner/repo) —— 与 UPSTREAM_REPO 同一处, 这里给 API 用。 */
export const GITHUB_UPSTREAM_SLUG = 'logos-42/bolloon';

/**
 * 环境变量读取 (浏览器安全的唯一入口)。
 * `process` 在 WebView 里不存在 —— 直接写 `process.env.X` 会在**模块求值期**抛,
 * 表现为整页 JS 不执行 (那样的红只有真浏览器能看见)。这里用 `typeof` 守卫。
 */
export function envValue(key: string): string | undefined {
  try {
    // ① 壳层/页面的配置通道 (浏览器没有 process.env; 手机端由原生壳或验收 harness 注入)
    const cfg = (globalThis as any)?.__bolloonUpdateConfig;
    if (cfg && cfg[key] !== undefined && cfg[key] !== null) return String(cfg[key]);
    // ② 进程环境 (桌面 CLI / Node 验收)
    const env = typeof process !== 'undefined' ? (process as any)?.env : null;
    const v = env ? env[key] : undefined;
    return v === undefined || v === null ? undefined : String(v);
  } catch {
    return undefined;
  }
}

/** npm registry (可用 BOLLOON_NPM_REGISTRY 指向镜像/内网; 末尾斜杠统一去掉) */
export const NPM_REGISTRY_BASE = (envValue('BOLLOON_NPM_REGISTRY') || 'https://registry.npmjs.org').replace(/\/+$/, '');
/** GitHub API 根 (可被 BOLLOON_GITHUB_API 覆盖 → 受控假 API / 企业实例)。 */
export const GITHUB_API_BASE = (envValue('BOLLOON_GITHUB_API') || 'https://api.github.com').replace(/\/+$/, '');
/** dev 通道盯的分支 (冻结: master)。 */
export const DEV_BRANCH = 'master';
export const DEV_REF = `refs/heads/${DEV_BRANCH}`;

// ── 安装方式 / 来源 / 通道 ──────────────────────────────────────────────────

export const INSTALL_METHODS = [
  'npm-global', 'npm-local', 'source-git', 'release-binary', 'development', 'unknown',
] as const;
export type InstallMethod = typeof INSTALL_METHODS[number];

export const UPDATE_SOURCES = ['npm', 'github-release', 'git', 'unknown'] as const;
export type UpdateSource = typeof UPDATE_SOURCES[number];

export const UPDATE_CHANNELS = ['stable', 'beta', 'dev'] as const;
export type UpdateChannel = typeof UPDATE_CHANNELS[number];

/** 发行通道: 环境变量 > 配置 > stable。npm 只有 `latest` (stable) 一个 dist-tag, beta/dev 暂走同一标签。 */
export function resolveUpdateChannel(explicit?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>): UpdateChannel {
  const raw = (explicit || (env ? env.BOLLOON_UPDATE_CHANNEL : envValue('BOLLOON_UPDATE_CHANNEL')) || '').trim().toLowerCase();
  if (raw === 'stable' || raw === 'beta' || raw === 'dev') return raw;
  return 'stable';
}

/** dist-tag 映射: stable → latest; beta/dev 暂与 stable 同源 (明说, 不假装有独立通道)。 */
export function distTagForChannel(channel: UpdateChannel): string {
  return channel === 'beta' ? 'beta' : 'latest';
}

// ── 身份 (dev 用 commit sha, 不用 semver) ───────────────────────────────────

/**
 * 版本比较语义 (显式, 不是隐含约定):
 *   semver  —— stable: 按 semver 数值段比大小
 *   git-ref —— dev: **不用 semver**, 只判"是否同一 commit / 是否落后"
 */
export const CHANNEL_KINDS = ['semver', 'git-ref'] as const;
export type ChannelKind = typeof CHANNEL_KINDS[number];

export function channelKindOf(channel: UpdateChannel): ChannelKind {
  return channel === 'dev' ? 'git-ref' : 'semver';
}

/** dev 快照身份里的后缀标记 (`0.4.33+dev.a1b2c3d`)。 */
export const DEV_IDENTITY_SEP = '+dev.';

/** dev 快照身份 —— 用 commit sha (不是 semver) 当身份, 版本号只作参考展示。 */
export function devIdentity(baseVersion: string, sha: string): string {
  return `${baseVersionOf(baseVersion)}${DEV_IDENTITY_SEP}${String(sha).slice(0, 7)}`;
}

/** 去掉 `+dev.<sha>` 后缀, 拿到基础版本号 (stable 目标的比对基准)。 */
export function baseVersionOf(v: string | null | undefined): string {
  return String(v || '').split(DEV_IDENTITY_SEP)[0].trim();
}

/** 这个版本号是不是一个 dev 快照身份。 */
export function isDevIdentity(v: string | null | undefined): boolean {
  return String(v || '').includes(DEV_IDENTITY_SEP);
}

/** 从 dev 身份里取 commit sha (前 7 位); 不是 dev 身份返回 null。 */
export function devShaFromIdentity(v: string | null | undefined): string | null {
  if (!isDevIdentity(v)) return null;
  const sha = String(v).split(DEV_IDENTITY_SEP)[1]?.trim();
  return sha ? sha : null;
}

/**
 * dev 通道的**唯一一句警告** (§12.4 硬约束 1) —— 检查 / 计划 / 执行 / 手机端四处打印同一句话。
 * 定义在这里 (唯一事实层), 由 dual-source / update-manager / CLI / 手机端复用, 不允许各处自己造一句。
 */
export const DEV_CHANNEL_WARNING = '⚠️ dev 通道 = GitHub master HEAD 的即时快照 (未走发布门): 可能中断正在跑的 Goal/Run, 且不保证可回滚到上一个 dev 版。';
/** 一键回 stable 的提示语 (同一份措辞)。 */
export const DEV_BACK_TO_STABLE_HINT = '一键回稳定版: bolloon update now --channel stable';
/** 手机端同一件事的说法 (原生层规则不同: 手机走 web 层 OTA, 不是 npm 全局安装)。 */
export const DEV_BACK_TO_STABLE_HINT_MOBILE = '一键回稳定版: 手机端「更新」页 → 切回 stable';

// ── 版本比较 (唯一一份) ─────────────────────────────────────────────────────

export function parseVersion(v: string): number[] {
  const clean = String(v || '').trim().replace(/^v/, '').split('-')[0];
  const parts = clean.split('.').map((p) => parseInt(p.replace(/\D.*$/, ''), 10));
  return parts.map((n) => (Number.isFinite(n) ? n : 0));
}

/** -1 = a<b, 0 = 相等, 1 = a>b (只比数值段, 忽略预发布标签) */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a); const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function isKnownVersion(v: string | null | undefined): boolean {
  return !!v && v !== 'unknown' && /^\d/.test(String(v).trim().replace(/^v/, ''));
}

// ── 检查结论 + 拒绝语义 (§3 / §12.3 / §12.5) ────────────────────────────────

/**
 * 一次"检查"的结论。**9 个值就是全部** (桌面侧), 不认识的一律落进 registry_unavailable 并带原因。
 *
 * 2026-09-25 (update-protocol §12.3, 双源): **只增不改** —— 新增 2 个, 错误分类**不合并**:
 *   github_unavailable     GitHub 不可达 / 403·429 限流 / 没有 Release / 没有 master
 *   cross_check_mismatch   stable 下 npm 与 GitHub 指向不同版本 (两个源的事实都摆出来)
 */
export const CHECK_STATUSES = [
  'up_to_date',              // 确认最新
  'update_available',        // 有新版本
  'check_skipped',           // 节流/显式跳过, 结论来自缓存
  'offline',                 // 网络不可达 (≠ 最新)
  'registry_unavailable',    // 可达但拿不到有效数据 (5xx / 包不存在 / 无 dist-tags)
  'local_version_unknown',   // 读不到本地版本 (不猜 0.0.0)
  'unsupported_installation',// 认得出本地版本, 但这种安装方式不支持自动更新
  'github_unavailable',      // GitHub 源不可用 (offline / rate_limited / not_found / http_error)
  'cross_check_mismatch',    // npm 与 GitHub 两个源不一致 → 拒绝更新
] as const;
export type CheckStatus = typeof CHECK_STATUSES[number];

/**
 * "源不可达 / 版本不存在" 这一组结论 —— 它们必须**拒绝执行并说清**。
 * 这是 §12.5 那一条的代码落点: 不许静默装回旧版, 也不许打印"已是最新"。
 *
 * **桌面与手机共用同一份** —— 手机上这几个状态同样会让 apply 直接 blocked, 一个字节都不下载。
 */
export const REFUSED_STATUSES: CheckStatus[] = ['offline', 'registry_unavailable', 'local_version_unknown', 'github_unavailable', 'cross_check_mismatch'];

/** 检查结论 → 退出码 (稳定约定, §2): 0 正常 / 2 检查不可用。 */
export function checkExitCode(status: CheckStatus | null | undefined): 0 | 2 {
  switch (status) {
    case 'offline':
    case 'registry_unavailable':
    case 'local_version_unknown':
    case 'github_unavailable':
    case 'cross_check_mismatch':
      return 2;
    default:
      return 0;
  }
}

// ── 更新开关 (结构声明; 读写在 update-state.ts) ─────────────────────────────

export interface UpdatePrefs {
  /** 启动时后台检查 (默认开) */
  checkUpdates: boolean;
  /** 自动安装 (默认关 —— 长期运行/Supervisor/支付恢复不能被自动换运行时打断) */
  autoInstall: boolean;
  /** 装完自动重启 (默认关) */
  autoRestart: boolean;
  channel: 'stable' | 'beta' | 'dev';
  /** 检查节流 (小时) */
  checkIntervalHours: number;
  /** 每项开关的来源: 'config' | 'env' | 'default' */
  sources: Record<'checkUpdates' | 'autoInstall' | 'autoRestart' | 'channel', 'config' | 'env' | 'default'>;
}

// ── 身份那一行的渲染 (§12.5: 桌面与手机同一份措辞) ──────────────────────────

/** 双源身份那一行 (谁装的 / 哪个 sha / 能切回哪) —— 桌面 `--version`/`update status` 与手机端共用同一份措辞。 */
export function describeSourceIdentity(info: {
  packageVersion: string;
  installedDevSha: string | null;
  switchableTo: { channel: 'stable' | 'dev'; source: string; target: string | null } | null;
  channelKind: ChannelKind;
}): string {
  const src = info.installedDevSha ? 'dev (GitHub master 快照)' : 'stable (npm registry)';
  const ident = info.installedDevSha ? `commit ${info.installedDevSha}` : baseVersionOf(info.packageVersion);
  const back = info.switchableTo ? ` · 可切回 ${info.switchableTo.channel} (${info.switchableTo.source})` : '';
  return `当前安装源: ${src} · 版本/commit: ${ident} · 比较语义: ${info.channelKind}${back}`;
}
