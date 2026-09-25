/**
 * version-info.ts — **版本身份的唯一事实来源** (Phase 0/1, 2026-09-19)
 *
 * 为什么需要它: 此前"我是什么版本"有 4 处各写一遍 (cli-entry 读 package.json、
 * bin/bolloon.cjs 硬编码 `0.1.1`、scripts/version_check.py 写死 `0.3.7`、
 * postinstall 写死 `0.1.12`), 4 处就会给出 4 个答案。这里把
 *   「包版本 / 构建时间 / git commit / 安装方式 / 安装目录 / 入口 / 上流 / 更新通道」
 * 收敛成一个 `VersionInfo`, 所有出口 (`--version` / `--version --verbose` /
 * `--version --json` / doctor / 更新检查 / 安装脚本) 都只读它。
 *
 * 边界 (冻结): 本模块**只读** —— 不写配置、不装包、不决定是否更新。
 * 写入与决策分别在 `update-state.ts` (状态落盘) 与 `update-manager.ts` (计划/执行)。
 *
 * 安装方式语义 (与脚本侧同一份枚举):
 *   npm-global       npm 全局安装 (`npm i -g`), 可自动更新
 *   npm-local        装在某个项目的 node_modules 里 (非全局), 交给该项目的包管理
 *   source-git       git 检出 + 自建 (dist 已产出), 更新走 git pull + build
 *   release-binary   解压的发行包 (带 RELEASE.json 标记)
 *   development      开发目录 (携带 .git 的源码树 / 被 npm link 进全局 / tsx 直跑)
 *   unknown          认不出来 → 一律不自动更新
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveBolloonHome } from '../setup/setup-store.js';
import { renderRuntimeLines, type RuntimeReport } from './runtime-bootstrap.js';

export const PKG_NAME = '@bolloon/bolloon-agent';
export const CONSTRAINT_PKG_NAME = '@bolloon/constraint-runtime';
/** npm registry (可用 BOLLOON_NPM_REGISTRY 指向镜像/内网; 末尾斜杠统一去掉) */
export const NPM_REGISTRY_BASE = (process.env.BOLLOON_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
export const UPSTREAM_REPO = 'https://github.com/logos-42/bolloon';

export const INSTALL_METHODS = [
  'npm-global', 'npm-local', 'source-git', 'release-binary', 'development', 'unknown',
] as const;
export type InstallMethod = typeof INSTALL_METHODS[number];

export const UPDATE_SOURCES = ['npm', 'github-release', 'git', 'unknown'] as const;
export type UpdateSource = typeof UPDATE_SOURCES[number];

export const UPDATE_CHANNELS = ['stable', 'beta', 'dev'] as const;
export type UpdateChannel = typeof UPDATE_CHANNELS[number];

/** 发行通道: 环境变量 > 配置 > stable。npm 只有 `latest` (stable) 一个 dist-tag, beta/dev 暂走同一标签。 */
export function resolveUpdateChannel(explicit?: string): UpdateChannel {
  const raw = (explicit || process.env.BOLLOON_UPDATE_CHANNEL || '').trim().toLowerCase();
  if (raw === 'stable' || raw === 'beta' || raw === 'dev') return raw;
  return 'stable';
}

/** dist-tag 映射: stable → latest; beta/dev 暂与 stable 同源 (明说, 不假装有独立通道)。 */
export function distTagForChannel(channel: UpdateChannel): string {
  return channel === 'beta' ? 'beta' : 'latest';
}

// ── 双源 (update-protocol §12, 2026-09-25) ──────────────────────────────────
//
// stable: npm registry (`dist-tags.latest`) 是**权威**, GitHub Release/Tag 是**交叉校验源**;
// dev   : GitHub `master` HEAD 是**唯一源**, 版本身份 = `<package.json 版本>+dev.<commit sha 前 7>`。
//
// 两条硬口径 (从这里开始, 全局只有这一份):
//   ① 两套版本比较语义**显式分开** —— stable 比 semver, dev 比 commit sha (`ChannelKind`)
//   ② 源不可达 / 版本不存在 → **拒绝并说清**, 不许静默装回旧版 (§12.5)

/** GitHub 上游 (owner/repo) —— 与 UPSTREAM_REPO 同一处, 这里给 API 用。 */
export const GITHUB_UPSTREAM_SLUG = 'logos-42/bolloon';
/** GitHub API 根 (可被 BOLLOON_GITHUB_API 覆盖 → 受控假 API / 企业实例)。 */
export const GITHUB_API_BASE = (process.env.BOLLOON_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
/** dev 通道盯的分支 (冻结: master)。 */
export const DEV_BRANCH = 'master';
export const DEV_REF = `refs/heads/${DEV_BRANCH}`;

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

/**
 * dev 通道的**唯一一句警告** (§12.4 硬约束 1) —— 检查 / 计划 / 执行三处打印同一句话。
 * 定义在这里 (唯一事实层), 由 dual-source / update-manager / CLI 复用, 不允许各处自己造一句。
 */
export const DEV_CHANNEL_WARNING = '⚠️ dev 通道 = GitHub master HEAD 的即时快照 (未走发布门): 可能中断正在跑的 Goal/Run, 且不保证可回滚到上一个 dev 版。';
/** 一键回 stable 的提示语 (同一份措辞)。 */
export const DEV_BACK_TO_STABLE_HINT = '一键回稳定版: bolloon update now --channel stable';

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

// ── 包根定位 ────────────────────────────────────────────────────────────────

/**
 * 从当前模块 URL 定位**运行中的**包根。
 * Node 默认解析软链 (preserveSymlinks=false) → npm link 场景下这里拿到的是**真实源码目录**,
 * 这正是"开发目录不能被误判成全局安装"的基础。
 */
export function packageRootFrom(moduleUrl: string): string {
  const file = fileURLToPath(moduleUrl);
  return path.resolve(path.dirname(file), '..', '..');
}

export function readPackageAt(root: string): { name?: string; version?: string; raw?: any } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    return { name: raw.name, version: raw.version, raw };
  } catch {
    return null;
  }
}

// ── 运行入口 ────────────────────────────────────────────────────────────────

export function buildTimeOf(file: string | null): string | null {
  if (!file) return null;
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function whichBin(name: string): string | null {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // 忽略
    }
  }
  return null;
}

/** npm 全局根 (`npm root -g`), 拿不到返回 null (npm 不在 PATH / 超时)。 */
export function npmGlobalRoot(): string | null {
  try {
    const out = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

/** npm 全局前缀 (`npm prefix -g`), 用于算 bin 目录。 */
export function npmGlobalPrefix(): string | null {
  try {
    const out = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

function npmVersion(): string | null {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function pythonVersion(): string | null {
  for (const bin of ['python3', 'python']) {
    try {
      const out = execFileSync(bin, ['-V'], { encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (out) return out;
    } catch {
      // 继续
    }
  }
  return null;
}

// ── 安装识别 ────────────────────────────────────────────────────────────────

export interface InstallationInfo {
  method: InstallMethod;
  /** 运行中的包根 (真实路径) */
  packageRoot: string;
  /** 发行安装目录 (npm 全局包目录 / 源码目录) */
  installDir: string;
  /** 全局 bin 里的 shim (用户敲的那个 bolloon) */
  binPath: string | null;
  /** 真正被 node 加载的入口文件 */
  entryPath: string;
  /** installDir 是否可写 (不可写 → 只能 sudo 或换 prefix) */
  writable: boolean;
  /** npm link / 软链进全局 */
  linked: boolean;
  linkTarget: string | null;
  updateSource: UpdateSource;
  /** 是否支持本工具的自动更新 (`bolloon update --now`) */
  autoUpdatable: boolean;
  /** 分类依据 (给人看的一句话) */
  reason: string;
}

export function isNpmGlobalPackageDir(pkgRoot: string): boolean {
  const norm = pkgRoot.replace(/\\/g, '/');
  return /\/lib\/node_modules\/@bolloon\/bolloon-agent$/.test(norm)
    || /\/node_modules\/@bolloon\/bolloon-agent$/.test(norm) && norm.includes('/npm-global/');
}

function looksLikeGitCheckout(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 两个路径是否指向同一处 (软链也算同一处)。 */
function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 识别当前运行的是哪种安装。
 *
 * 判定顺序 (先具体后兜底):
 *   1. 全局 npm 包目录里是**软链**, 且链到 git 检出 → `development` (npm link: 全局入口 ≠ 发行安装)
 *   2. 包根在 `<npm root -g>` 里 → `npm-global`
 *   3. 包根在任意 `node_modules/<PKG_NAME>` (非全局) → `npm-local`
 *   4. 包根是 git 检出 → `source-git`
 *   5. 包根有 RELEASE.json 标记 → `release-binary`
 *   6. 其余 → `unknown`
 */
export function detectInstallation(opts: { packageRoot?: string; home?: string } = {}): InstallationInfo {
  const packageRoot = path.resolve(opts.packageRoot || currentPackageRoot());
  const globalRoot = npmGlobalRoot();
  const globalPrefix = npmGlobalPrefix();
  const expectedGlobalDir = globalRoot ? path.join(globalRoot, '@bolloon', 'bolloon-agent') : null;

  const binCandidates = [
    globalPrefix ? path.join(globalPrefix, 'bin', 'bolloon') : null,
    whichBin('bolloon'),
  ].filter((p): p is string => !!p);
  const binPath = binCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;

  let linked = false;
  let linkTarget: string | null = null;
  let linkedReal: string | null = null;
  if (expectedGlobalDir) {
    try {
      if (fs.lstatSync(expectedGlobalDir).isSymbolicLink()) {
        linked = true;
        linkTarget = path.resolve(path.dirname(expectedGlobalDir), fs.readlinkSync(expectedGlobalDir));
        linkedReal = fs.realpathSync(expectedGlobalDir);
      }
    } catch {
      // 不存在 / 无权限
    }
  }

  const gitCheckout = looksLikeGitCheckout(packageRoot);
  const inGlobal = !!expectedGlobalDir && fs.existsSync(path.join(expectedGlobalDir, 'package.json'))
    && samePath(expectedGlobalDir, packageRoot);
  const posixPath = packageRoot.replace(/\\/g, '/');
  /**
   * npm 的**全局布局**就是 `<prefix>/lib/node_modules/<pkg>`
   * (homebrew / nvm / 自定义 prefix 都一样)。`npm root -g` 拿不到或与安装时的 prefix
   * 不一致时 (真装一遍的验收里就遇到过: 安装用 prefix=X, 查询时 npm 从别的 HOME 解析出 Y),
   * 只看 `npm root -g` 会把它误判成 `npm-local`。这里按布局兜底。
   * 对照: 项目内局部依赖是 `<proj>/node_modules/<pkg>` (没有 `lib/`), 仍是 npm-local。
   */
  const globalLayout = /\/lib\/node_modules\/@bolloon\/bolloon-agent$/.test(posixPath);
  const inAnyNodeModules = /[\\/]node_modules[\\/]@bolloon[\\/]bolloon-agent$/.test(posixPath);
  const hasReleaseMarker = fs.existsSync(path.join(packageRoot, 'RELEASE.json'));

  let method: InstallMethod;
  let reason: string;
  if (linked && linkedReal && samePath(linkedReal, packageRoot) && gitCheckout) {
    // npm link: 全局入口指向开发源码 → 这不是发行安装
    method = 'development';
    reason = `npm 全局目录是软链, 指向开发源码 (${linkTarget || packageRoot}) — 不是发行安装`;
  } else if (inGlobal && !gitCheckout) {
    method = 'npm-global';
    reason = `包根位于 npm 全局目录 ${expectedGlobalDir}`;
  } else if (inGlobal && gitCheckout) {
    method = 'source-git';
    reason = '包根位于 npm 全局目录, 但本身就是 git 检出 (就地发布)';
  } else if (globalLayout && !gitCheckout) {
    method = 'npm-global';
    reason = `包根符合 npm 全局布局 <prefix>/lib/node_modules/${PKG_NAME} (prefix=${posixPath.replace('/lib/node_modules/' + PKG_NAME, '')})`;
  } else if (inAnyNodeModules) {
    method = 'npm-local';
    reason = '包根位于某个项目的 node_modules (非全局)';
  } else if (gitCheckout) {
    method = 'source-git';
    reason = '包根是 git 检出';
  } else if (hasReleaseMarker) {
    method = 'release-binary';
    reason = '包根带 RELEASE.json 标记 (解压的发行包)';
  } else {
    method = 'unknown';
    reason = `无法从 ${packageRoot} 判定安装方式`;
  }

  const updateSource: UpdateSource =
    method === 'npm-global' || method === 'npm-local' ? 'npm'
      : method === 'source-git' || method === 'development' ? 'git'
        : 'unknown';

  // 自动更新的硬条件: 走 npm 通道 + npm 全局 + 目标目录可写
  const autoUpdatable = (method === 'npm-global') && isWritable(packageRoot);

  return {
    method,
    packageRoot,
    installDir: packageRoot,
    binPath,
    entryPath: resolveEntryPath(packageRoot),
    writable: isWritable(packageRoot),
    linked,
    linkTarget,
    updateSource,
    autoUpdatable,
    reason,
  };
}

/** 被 node 真正加载的入口 (`dist/cli-entry.js`), 找不到时回退到模块自身。 */
function resolveEntryPath(packageRoot: string): string {
  const fromArgv = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (fromArgv && fromArgv.startsWith(packageRoot)) return fromArgv;
  const dist = path.join(packageRoot, 'dist', 'cli-entry.js');
  if (fs.existsSync(dist)) return dist;
  const idx = path.join(packageRoot, 'dist', 'index.js');
  if (fs.existsSync(idx)) return idx;
  return packageRoot;   // 找不到入口就如实报包根, 不编路径
}

/**
 * 当前包根目录 —— ESM(Node) 与 CJS(Electron) 双上下文都能用。
 *
 * **刻意不用 import.meta**: `tsconfig.electron.json` 是 `module: CommonJS`,
 * 只要本文件被 electron 主进程链路 (electron.ts -> auto-update -> update-manager -> version-info)
 * 引到, 用了 import.meta 就 TS1343 编译失败 —— 这个坑平时看不见, 只有
 * `npm publish` (prepublishOnly -> build:all -> build:electron) 才会走 electron 编译。
 */
export function currentPackageRoot(): string {
  const climb = (start: string): string | null => {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
          if (j && j.name === PKG_NAME) return dir;
        } catch { /* 读不了就当没有, 继续往上 */ }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };

  // (1) 进程入口 (CLI = dist/cli-entry.js, 脚本, electron 主进程)
  const fromArgv = process.argv[1] ? climb(path.dirname(process.argv[1])) : null;
  if (fromArgv) return fromArgv;

  // (2) CJS 上下文能直接拿 __dirname —— 包在 new Function 里, 避免 ESM 编译期报"未定义"
  try {
    const dir = new Function('return typeof __dirname === "string" ? __dirname : null')() as string | null;
    const hit = dir ? climb(dir) : null;
    if (hit) return hit;
  } catch { /* ESM 下这里拿不到 __dirname, 正常 */ }

  // (3) 调用栈里的本文件绝对路径 (ESM 也能拿到)
  try {
    const stack = new Error().stack || '';
    const m = stack.match(/(?:file:\/\/)?(\/[^\s()]*version-info\.(?:js|mjs|cjs|ts)):\d+:\d+/);
    if (m) {
      const hit = climb(path.dirname(m[1]));
      if (hit) return hit;
    }
  } catch { /* 拿不到就退到 cwd */ }

  // (4) 仓库里直接跑 (开发态)
  return climb(process.cwd()) || process.cwd();
}

// ── git 事实 ────────────────────────────────────────────────────────────────

export interface GitFacts { commit: string | null; dirty: boolean | null; branch: string | null }

export function gitFactsAt(dir: string): GitFacts {
  if (!looksLikeGitCheckout(dir)) return { commit: null, dirty: null, branch: null };
  try {
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf-8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    let dirty: boolean | null = null;
    try {
      const st = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      dirty = st.trim().length > 0;
    } catch {
      dirty = null;
    }
    let branch: string | null = null;
    try {
      branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      branch = null;
    }
    return { commit, dirty, branch };
  } catch {
    return { commit: null, dirty: null, branch: null };
  }
}

// ── 统一 VersionInfo ────────────────────────────────────────────────────────

/** 更新的只读摘要 —— 由 update-state 提供, 这里只声明结构 (避免反向依赖)。 */
export interface VersionUpdateSummary {
  lastCheckAt: string | null;
  lastCheckStatus: string | null;
  lastCheckReason?: string;
  latestVersion: string | null;
  lastUpdate: { at: string; from: string; to: string; status: string; reason?: string } | null;
  needsRestart: boolean;
  /** 当前装的是哪个源 (stable= npm 权威 / dev= GitHub master 快照) —— §12.5 "哪个源答的" */
  installedChannel?: 'stable' | 'dev' | null;
  /** 已装 dev 快照的 commit sha (只在 installedChannel=dev 时有意义) */
  installedDevSha?: string | null;
  /** 一键能切回的另一个源 (例如 dev 快照能一键回 stable) */
  switchableTo?: { channel: 'stable' | 'dev'; source: string; target: string | null } | null;
}

export interface VersionInfo {
  schema: 'bolloon-version/1';
  packageName: string;
  packageVersion: string;
  /** 入口文件的构建时间 (无构建戳时用 mtime, 并明确标注) */
  buildTime: string | null;
  buildTimeSource: 'entry-mtime';
  gitCommit: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  gitCommitSource: 'git' | 'package.json' | 'unknown';
  nodeVersion: string;
  npmVersion: string | null;
  pythonVersion: string | null;
  platform: string;
  arch: string;
  installMethod: InstallMethod;
  installDir: string;
  entryPath: string;
  binPath: string | null;
  configDir: string;
  channel: UpdateChannel;
  /** 该通道的**比较语义** (stable=semver / dev=git-ref) —— 显式, 不靠约定 */
  channelKind: ChannelKind;
  upstream: string;
  registry: string;
  updateSource: UpdateSource;
  autoUpdatable: boolean;
  installReason: string;
  /** 当前安装的 dev 快照 commit sha (非 dev 安装 = null) */
  installedDevSha: string | null;
  /** 一键能切回的另一个源 (dev → stable / stable → dev) */
  switchableTo: { channel: 'stable' | 'dev'; source: string; target: string | null } | null;
  update: VersionUpdateSummary | null;
  /**
   * 运行时配置 (Node/npm/Git/Python 的路径 + 版本 + 来源 + 是否由 Bolloon 安装 + 最后验证时间)。
   * leo 2026-09-19: 展示安装信息时必须展示这些配置 —— 它们是"安装是否真的完成"的事实。
   */
  runtime: RuntimeReport | null;
  /** 配置里是否真的写了 runtime.* (没写就是实时探测, 展示时要说清) */
  runtimeConfigBacked?: boolean;
}

export interface CollectVersionOptions {
  packageRoot?: string;
  home?: string;
  channel?: string;
  update?: VersionUpdateSummary | null;
  runtime?: RuntimeReport | null;
  /** 配置里是否真的写了 runtime.* (没写就是实时探测, 展示时要说清) */
  runtimeConfigBacked?: boolean;
  /** 跳过 git/npm/python 子进程探测 (测试用, 快很多) */
  light?: boolean;
}

export function collectVersionInfo(opts: CollectVersionOptions = {}): VersionInfo {
  const packageRoot = path.resolve(opts.packageRoot || currentPackageRoot());
  const pkg = readPackageAt(packageRoot);
  const install = detectInstallation({ packageRoot, home: opts.home });
  const home = opts.home || resolveBolloonHome();
  const git = opts.light ? { commit: null, dirty: null, branch: null } : gitFactsAt(packageRoot);
  const channel = resolveUpdateChannel(opts.channel);

  const gitHeadFromPkg = pkg?.raw?.gitHead as string | undefined;
  let gitCommit = git.commit;
  let gitCommitSource: VersionInfo['gitCommitSource'] = 'git';
  if (!gitCommit && gitHeadFromPkg) { gitCommit = String(gitHeadFromPkg).slice(0, 7); gitCommitSource = 'package.json'; }
  if (!gitCommit) gitCommitSource = 'unknown';

  // dev 身份从**磁盘上的版本号**读 (不是从状态文件猜): `0.4.33+dev.a1b2c3d` → sha=a1b2c3d
  const installedDevSha = devShaFromIdentity(pkg?.version) || (opts.update?.installedDevSha ?? null);
  const switchableTo = opts.update?.switchableTo ?? (installedDevSha
    ? { channel: 'stable' as const, source: 'npm', target: null }
    : null);

  return {
    schema: 'bolloon-version/1',
    packageName: pkg?.name || PKG_NAME,
    packageVersion: pkg?.version || 'unknown',
    buildTime: buildTimeOf(install.entryPath),
    buildTimeSource: 'entry-mtime',
    gitCommit,
    gitBranch: git.branch,
    gitDirty: git.dirty,
    gitCommitSource,
    nodeVersion: process.version.replace(/^v/, ''),
    npmVersion: opts.light ? null : npmVersion(),
    pythonVersion: opts.light ? null : pythonVersion(),
    platform: os.platform(),
    arch: os.arch(),
    installMethod: install.method,
    installDir: install.installDir,
    entryPath: install.entryPath,
    binPath: install.binPath,
    configDir: home,
    channel,
    channelKind: channelKindOf(channel),
    upstream: UPSTREAM_REPO,
    registry: `${NPM_REGISTRY_BASE}/${PKG_NAME}`,
    updateSource: install.updateSource,
    autoUpdatable: install.autoUpdatable,
    installReason: install.reason,
    installedDevSha,
    switchableTo,
    update: opts.update ?? null,
    runtime: opts.runtime ?? null,
    runtimeConfigBacked: opts.runtimeConfigBacked ?? false,
  };
}

// ── 渲染 (三种输出读同一份 VersionInfo) ─────────────────────────────────────

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '未记录';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '未记录';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '未记录';
  }
}

/** 一句话更新结论 (普通版 + verbose 共用, 保证两处不会说两套话) */
export function describeUpdateLine(info: VersionInfo): string {
  const u = info.update;
  if (!u || !u.lastCheckStatus || !u.lastCheckAt) return '更新检查: 尚未检查 (运行 bolloon update)';
  switch (u.lastCheckStatus) {
    case 'up_to_date': return '更新检查: 已是最新';
    case 'update_available': return `更新检查: 有新版可用 (${u.latestVersion || '未知'})`;
    case 'check_skipped': return '更新检查: 已跳过 (使用缓存)';
    case 'offline': return '更新检查: 离线 — 无法访问 npm registry (不等于最新)';
    case 'registry_unavailable': return `更新检查: registry 不可用${u.lastCheckReason ? ` (${u.lastCheckReason})` : ''} (不等于最新)`;
    case 'local_version_unknown': return '更新检查: 读不到本地版本 — 不判断是否有更新';
    case 'unsupported_installation': return '更新检查: 当前安装方式不支持自动更新';
    case 'github_unavailable': return `更新检查: GitHub 源不可用${u.lastCheckReason ? ` (${u.lastCheckReason})` : ''} (不等于最新)`;
    case 'cross_check_mismatch': return `更新检查: 两个源不一致 (npm ↔ GitHub) — 不执行更新`;
    default: return `更新检查: ${u.lastCheckStatus}`;
  }
}

/** 双源身份那一行 (谁装的 / 哪个 sha / 能切回哪) —— `--version` 与 `update status` 共用同一份措辞。 */
export function describeSourceIdentity(info: Pick<VersionInfo, 'packageVersion' | 'installedDevSha' | 'switchableTo' | 'channel' | 'channelKind'>): string {
  const src = info.installedDevSha ? 'dev (GitHub master 快照)' : 'stable (npm registry)';
  const ident = info.installedDevSha ? `commit ${info.installedDevSha}` : baseVersionOf(info.packageVersion);
  const back = info.switchableTo ? ` · 可切回 ${info.switchableTo.channel} (${info.switchableTo.source})` : '';
  return `当前安装源: ${src} · 版本/commit: ${ident} · 比较语义: ${info.channelKind}${back}`;
}

export function renderVersionText(info: VersionInfo, opts: { verbose?: boolean } = {}): string {
  if (opts.verbose) {
    const lines: string[] = [
      `Bolloon Agent v${info.packageVersion} (verbose)`,
      `包名:        ${info.packageName}`,
      `构建时间:    ${fmtTime(info.buildTime)} (${info.buildTimeSource === 'entry-mtime' ? '入口文件 mtime' : info.buildTimeSource})`,
      `Git commit:  ${info.gitCommit || 'unknown'}${info.gitDirty ? ' (dirty)' : info.gitDirty === false ? ' (clean)' : ''}  [来源: ${info.gitCommitSource}]`,
      `Git 分支:    ${info.gitBranch || 'unknown'}`,
      `Node.js:     ${info.nodeVersion}`,
      `npm:         ${info.npmVersion || 'unknown'}`,
      `Python:      ${info.pythonVersion || 'unknown'}`,
      `平台:        ${info.platform} ${info.arch}`,
      `安装方式:    ${info.installMethod}${info.installReason ? `  (${info.installReason})` : ''}`,
      `安装目录:    ${info.installDir}`,
      `运行入口:    ${info.entryPath}`,
      `bin shim:    ${info.binPath || 'unknown'}`,
      `配置目录:    ${info.configDir}`,
      `更新通道:    ${info.channel} (比较语义: ${info.channelKind})`,
      `更新来源:    ${info.updateSource}${info.autoUpdatable ? '' : ' (不支持自动更新)'}`,
      describeSourceIdentity(info),
      `上游地址:    ${info.upstream}`,
      `registry:    ${info.registry}`,
      `GitHub:      ${GITHUB_UPSTREAM_SLUG} (${DEV_BRANCH} HEAD = dev 通道的源)`,
      describeUpdateLine(info),
      `上次检查:    ${fmtTime(info.update?.lastCheckAt)}`,
    ];
    if (info.update?.lastUpdate) {
      const lu = info.update.lastUpdate;
      lines.push(`最近更新:    ${fmtTime(lu.at)} ${lu.from} → ${lu.to} [${lu.status}]${lu.reason ? ` ${lu.reason}` : ''}`);
    } else {
      lines.push('最近更新:    无记录');
    }
    if (info.update?.needsRestart) lines.push('需要重启:    是 (新版已就位, 重启后生效)');
    if (info.runtime) {
      lines.push('');
      lines.push(...renderRuntimeLines(info.runtime, { verbose: true, configBacked: info.runtimeConfigBacked }));
    }
    return lines.join('\n');
  }

  // 普通版: 给人看, 简洁但完整 (含安装位置/方式/通道/上游/是否最新)
  const lines: string[] = [
    `Bolloon Agent v${info.packageVersion}`,
    `安装方式: ${info.installMethod}`,
    `安装目录: ${info.installDir}`,
    `运行入口: ${info.binPath || info.entryPath}`,
    `更新通道: ${info.channel}`,
    describeSourceIdentity(info),
    `Node.js: ${info.nodeVersion}`,
    `平台: ${info.platform} ${info.arch}`,
    `上游提交: ${info.gitCommit || 'unknown'}`,
    describeUpdateLine(info),
    `上次检查: ${fmtTime(info.update?.lastCheckAt)}`,
  ];
  if (info.installedDevSha) lines.push(DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT);
  if (info.runtime) {
    lines.push('');
    lines.push(...renderRuntimeLines(info.runtime, { verbose: false, configBacked: info.runtimeConfigBacked }));
  }
  return lines.join('\n');
}

export function renderVersionJson(info: VersionInfo): string {
  return JSON.stringify(info, null, 2);
}
