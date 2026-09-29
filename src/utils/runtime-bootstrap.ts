/**
 * runtime-bootstrap.ts — **运行时安装与配置的唯一管理器** (2026-09-19, leo 计划 Phase 0-8)
 *
 * 新的完成定义 (冻结):
 *   **Bolloon 安装完成 = Node/npm、Git、Python 三个运行时都已可执行、版本可验证、路径已配置。**
 *   任何一个必需运行时不可用 → 整个安装**不能**宣布成功。
 *
 * 为什么需要它: 此前 `install.sh` 只查 Node/npm, `postinstall.js` 不查 Git/Python,
 * `version-info.ts` 只"探测"Python 不负责配置, PATH 没有任何统一来源 —— 于是
 * "装上但不可用 / 看似成功实际缺失" 这类状态没有任何事实可查。
 *
 * 边界 (冻结):
 *   - **不偷偷 sudo / 不静默高权限**: 需要管理员权限时进 `needsAdmin` + 只在显式 `allowSudo` 才执行;
 *   - **不覆盖用户已有运行时**: 已满足最低版本一律 `reuse`;
 *   - **不写用户配置里除 `runtime.*` 之外的任何字段**;
 *   - **每次启动重新验证**, 不盲信配置文件 (配置只是"优先探测路径")。
 *
 * 命令构造与执行分离: 纯函数 (探测/计划/报告) 可单测; 真执行只在 `bootstrapRuntimes` 里发生。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execFileSync, spawnSync } from 'child_process';
import { resolveBolloonHome, CANONICAL_CONFIG_FILE } from '../setup/setup-store.js';

// ── Phase 0: 冻结的最低版本 (不在代码里到处写死, 只此一处) ─────────────────

export type RuntimeId = 'node' | 'npm' | 'git' | 'python';

export const RUNTIME_MIN: Record<RuntimeId, { min: string; why: string }> = {
  node: { min: '18.0.0', why: 'Bolloon CLI 与依赖 (ESM / 全局 fetch / node: 前缀) 的运行时' },
  npm: { min: '9.0.0', why: '随 Node 18+ 发布; 全局安装与 `bolloon update` 的安装通道' },
  git: { min: '2.20.0', why: '`git -C` / `--porcelain` / worktree —— 源码更新与协作通道' },
  python: { min: '3.8.0', why: 'scripts/** (wiki 门禁/消融夹具) 与 Python Skill 执行' },
};

/** Phase 0 平台范围: 三个平台都在内; 未列出的平台 → `unsupported` (不假装能装)。 */
export const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'] as const;

export type RuntimeStatus = 'found' | 'installed' | 'configured' | 'missing' | 'failed' | 'unsupported';
export type InstallSource = 'existing' | 'brew' | 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'winget' | 'choco' | 'official-installer' | 'none';

export interface RuntimeFact {
  runtime: RuntimeId;
  status: RuntimeStatus;
  /** 绝对路径 (拿不到就是 null —— 不编造) */
  path: string | null;
  version: string | null;
  source: InstallSource;
  meetsMinimum: boolean;
  /** 是否由 Bolloon 装的 (用户自己有的运行时永远是 false) */
  installedByBolloon: boolean;
  startedAt?: string;
  finishedAt?: string;
  lastVerifiedAt?: string | null;
  /** 真执行验证结果 (不是"命令存在") */
  verified?: boolean;
  error?: string;
  notes: string[];
}

export interface RuntimeReport {
  schema: 'bolloon-runtime/1';
  platform: NodeJS.Platform;
  arch: string;
  facts: RuntimeFact[];
  /** 四个运行时全部满足最低版本 + 通过真执行验证 */
  ok: boolean;
  missing: RuntimeId[];
  belowMinimum: RuntimeId[];
  failedStage: string | null;
  advice: string[];
  capabilities: RuntimeCapabilities;
  checkedAt: string;
  /** 是否发生过真实安装动作 */
  installed: RuntimeId[];
  dryRun: boolean;
}

export interface RuntimeCapabilities {
  /** 核心运行 (node + npm) */
  core: boolean;
  /** 源码更新 (git + core) */
  sourceUpdate: boolean;
  /** Git 协作 */
  gitCollaboration: boolean;
  /** Python Skill / 脚本 */
  pythonSkill: boolean;
  /** Wiki 工具链 (git + python + core) */
  wikiTools: boolean;
}

// ── 版本比较 (自己实现, 不引依赖) ──────────────────────────────────────────

export function parseVersionString(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : null;
}

export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

// ── 探测 (纯执行 + 纯解析) ─────────────────────────────────────────────────

/** 在 PATH + 平台默认目录里找可执行文件 (找不到返回 null, 不猜)。 */
export function findExecutable(names: string[], envPath = process.env.PATH || ''): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const extra = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(String);
    for (const e of extra) dirs.push(path.join(e, 'Git', 'cmd'), path.join(e, 'Programs', 'Python'));
  }
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) return p;
        } catch { /* 继续 */ }
      }
    }
  }
  return null;
}

function runVersion(cmd: string, args: string[], timeoutMs = 8000): { ok: boolean; out: string; err: string; ms: number } {
  const t0 = Date.now();
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out).trim(), err: '', ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, out: String(e?.stdout || '').trim(), err: String(e?.stderr || e?.message || '').trim(), ms: Date.now() - t0 };
  }
}

/** Windows "App Execution Aliases" 会拦 Python: 路径在 WindowsApps 下且跑不起来/跑成 0 字节。 */
export function looksLikeStoreAlias(p: string | null): boolean {
  if (!p) return false;
  return /WindowsApps[\\/]python/i.test(p);
}

export interface ProbeOptions {
  /** 配置文件里记的绝对路径 (只作优先候选, 仍要真执行验证) */
  preferredPath?: string | null;
  envPath?: string;
}

/** 探测单个运行时: 真执行 `--version` 拿版本 + 绝对路径。 */
export function probeRuntime(id: RuntimeId, opts: ProbeOptions = {}): RuntimeFact {
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  const min = RUNTIME_MIN[id].min;
  const base: RuntimeFact = {
    runtime: id, status: 'missing', path: null, version: null, source: 'existing',
    meetsMinimum: false, installedByBolloon: false, startedAt, notes,
  };

  // 候选命令: 配置里的绝对路径优先, 然后是 PATH 常见名
  const candidates: { cmd: string; args: string[] }[] = [];
  if (opts.preferredPath) candidates.push({ cmd: opts.preferredPath, args: id === 'python' ? ['--version'] : ['--version'] });
  if (id === 'node') candidates.push({ cmd: 'node', args: ['--version'] });
  if (id === 'npm') candidates.push({ cmd: 'npm', args: ['--version'] });
  if (id === 'git') candidates.push({ cmd: 'git', args: ['--version'] });
  if (id === 'python') {
    candidates.push({ cmd: 'python3', args: ['--version'] }, { cmd: 'python', args: ['--version'] });
    if (process.platform === 'win32') candidates.push({ cmd: 'py', args: ['-3', '--version'] });
  }

  for (const c of candidates) {
    const r = runVersion(c.cmd, c.args);
    const rawVersion = parseVersionString(r.out || r.err);
    const resolved = findExecutable([path.basename(c.cmd)]) || (opts.preferredPath === c.cmd ? c.cmd : null);
    if (!r.ok || !rawVersion) {
      if (looksLikeStoreAlias(resolved)) {
        notes.push('命令指向 Windows Store alias —— 这不是真的 Python 解释器');
      }
      continue;
    }
    if (id === 'python' && looksLikeStoreAlias(resolved)) {
      base.error = 'python 命令指向 Microsoft Store alias';
      notes.push('Windows App Execution Aliases 拦截: 需在「应用执行别名」里关掉 python.exe 或改用官方安装器');
      base.status = 'missing';
      continue;
    }
    const meets = versionAtLeast(rawVersion, min);
    return {
      ...base,
      status: meets ? 'found' : 'failed',
      path: resolved || c.cmd,
      version: rawVersion,
      meetsMinimum: meets,
      verified: false,
      error: meets ? undefined : `${id} ${rawVersion} 低于最低要求 ${min} (${RUNTIME_MIN[id].why})`,
      notes: [
        ...notes,
        ...(opts.preferredPath && resolved && path.resolve(opts.preferredPath) !== path.resolve(resolved)
          ? ['配置里的路径已失效, 已按 PATH 重新发现'] : []),
        ...(opts.preferredPath && !resolved ? ['配置里的路径不可用'] : []),
      ],
    };
  }

  base.error = `找不到可用的 ${id} 命令`;
  return base;
}

// ── 包管理器识别 (Phase 2) ─────────────────────────────────────────────────

export type PackageManagerKind = 'brew' | 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'winget' | 'choco';

export interface PackageManager { kind: PackageManagerKind; path: string; installCmd: (pkg: string[]) => string[]; needsAdmin: boolean }

const PKG_NAME: Record<RuntimeId, Record<string, string[]>> = {
  // 每个包管理器里运行时的包名 (Linux 由发行版适配器决定, 见 Phase 2)
  node: { brew: ['node'], apt: ['nodejs'], dnf: ['nodejs'], yum: ['nodejs'], pacman: ['nodejs'], zypper: ['nodejs'], apk: ['nodejs'], winget: ['OpenJS.NodeJS.LTS'], choco: ['nodejs-lts'] },
  npm: { apt: ['npm'], dnf: ['npm'], yum: ['npm'], pacman: ['npm'], zypper: ['npm'], apk: ['npm'] },
  git: { brew: ['git'], apt: ['git'], dnf: ['git'], yum: ['git'], pacman: ['git'], zypper: ['git'], apk: ['git'], winget: ['Git.Git'], choco: ['git'] },
  python: { brew: ['python'], apt: ['python3', 'python3-venv'], dnf: ['python3', 'python3-pip'], yum: ['python3'], pacman: ['python'], zypper: ['python3'], apk: ['python3'], winget: ['Python.Python.3.12'], choco: ['python3'] },
};

/**
 * 由包管理器种类构造管理器对象 (**纯函数**)。
 * 抽出来的理由: winget/choco 的命令形状必须在 Linux/macOS 上也能被单测覆盖 ——
 * 不然"Windows 支持"就只能靠嘴说。
 */
export function packageManagerFor(kind: PackageManagerKind, pmPath: string): PackageManager {
  const needsAdmin = kind === 'apt' || kind === 'dnf' || kind === 'yum' || kind === 'pacman' || kind === 'zypper' || kind === 'apk' || kind === 'choco';
  return {
    kind,
    path: pmPath,
    needsAdmin,
    installCmd: (pkgs) => {
      switch (kind) {
        case 'brew': return ['brew', 'install', ...pkgs];
        case 'choco': return ['choco', 'install', ...pkgs, '-y'];
        case 'winget': return ['winget', 'install', '--silent', '--accept-package-agreements', '--accept-source-agreements', ...pkgs.flatMap((x) => ['--id', x])];
        case 'apt': return ['apt-get', 'install', '-y', ...pkgs];
        case 'pacman': return ['pacman', '-S', '--noconfirm', ...pkgs];
        case 'zypper': return ['zypper', '--non-interactive', 'install', ...pkgs];
        case 'apk': return ['apk', 'add', ...pkgs];
        default: return [kind, 'install', '-y', ...pkgs];
      }
    },
  };
}

export function detectPackageManager(platform: NodeJS.Platform = process.platform, envPath = process.env.PATH || ''): PackageManager | null {
  const defs: { kind: PackageManagerKind; bins: string[] }[] =
    platform === 'darwin' ? [{ kind: 'brew', bins: ['brew'] }]
      : platform === 'win32' ? [{ kind: 'winget', bins: ['winget'] }, { kind: 'choco', bins: ['choco'] }]
        : [
          { kind: 'apt', bins: ['apt-get'] },
          { kind: 'dnf', bins: ['dnf'] },
          { kind: 'yum', bins: ['yum'] },
          { kind: 'pacman', bins: ['pacman'] },
          { kind: 'zypper', bins: ['zypper'] },
          { kind: 'apk', bins: ['apk'] },
        ];
  for (const d of defs) {
    const p = findExecutable(d.bins, envPath);
    if (!p) continue;
    return packageManagerFor(d.kind, p);
  }
  return null;
}

/** 发行版识别 (Linux 适配器用; 只读 /etc/os-release)。 */
export function detectLinuxDistro(): { id: string; version?: string } | null {
  try {
    const txt = fs.readFileSync('/etc/os-release', 'utf-8');
    const id = /^ID=(.+)$/m.exec(txt)?.[1]?.replace(/"/g, '') || '';
    const ver = /^VERSION_ID=(.+)$/m.exec(txt)?.[1]?.replace(/"/g, '');
    return id ? { id, version: ver } : null;
  } catch {
    return null;
  }
}

// ── Phase 4: 计划 (纯函数, 先看计划再动手) ─────────────────────────────────

export interface BootstrapStep {
  runtime: RuntimeId;
  action: 'reuse' | 'install' | 'manual' | 'unsupported';
  /** 将要执行的命令 (manual 时是给人照抄的) */
  command: string[] | null;
  note: string;
}

export interface BootstrapPlan {
  platform: NodeJS.Platform;
  distro?: { id: string; version?: string } | null;
  present: RuntimeId[];
  missing: RuntimeId[];
  belowMinimum: RuntimeId[];
  manager: { kind: PackageManagerKind; path: string } | null;
  steps: BootstrapStep[];
  needsAdmin: boolean;
  pathChanges: boolean;
  canAutoInstall: boolean;
  blockers: string[];
  advice: string[];
}

export function planBootstrap(facts: RuntimeFact[], opts: { platform?: NodeJS.Platform; manager?: PackageManager | null; envPath?: string } = {}): BootstrapPlan {
  const platform = opts.platform || process.platform;
  const manager = opts.manager !== undefined ? opts.manager : detectPackageManager(platform, opts.envPath);
  const supported = (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);

  const missing = facts.filter((f) => f.status === 'missing').map((f) => f.runtime);
  const belowMinimum = facts.filter((f) => f.status === 'failed').map((f) => f.runtime);
  const present = facts.filter((f) => f.status === 'found').map((f) => f.runtime);
  const steps: BootstrapStep[] = [];
  const blockers: string[] = [];
  const advice: string[] = [];
  let needsAdmin = false;
  let pathChanges = false;

  if (!supported) {
    for (const f of facts) {
      steps.push({
        runtime: f.runtime, action: 'unsupported', command: null,
        note: `平台 ${platform} 未在支持矩阵内 (${SUPPORTED_PLATFORMS.join('/')}) —— 不自动安装, 请手动准备运行时`,
      });
    }
    return { platform, present, missing, belowMinimum, manager: manager ? { kind: manager.kind, path: manager.path } : null, steps, needsAdmin: false, pathChanges: false, canAutoInstall: false, blockers: [`不支持的平台 ${platform}`], advice };
  }

  for (const f of facts) {
    if (f.status === 'found') {
      steps.push({ runtime: f.runtime, action: 'reuse', command: null, note: `已有 ${f.version} (${f.path}) —— 复用, 不覆盖用户已有运行时` });
      continue;
    }
    const pkgs = PKG_NAME[f.runtime]?.[manager?.kind || ''] || [];
    if (!manager) {
      steps.push({
        runtime: f.runtime, action: 'manual', command: null,
        note: platform === 'darwin'
          ? '没有 Homebrew —— 不静默安装 Homebrew (会写 /opt/homebrew 或 /usr/local 并可能要管理员密码); 请手动安装 git/python 或先装 Homebrew'
          : '没有可用的包管理器 —— 请手动安装后重跑',
      });
      advice.push(manualAdvice(f.runtime, platform));
      continue;
    }
    if (pkgs.length === 0) {
      steps.push({ runtime: f.runtime, action: 'manual', command: null, note: `${manager.kind} 里没有 ${f.runtime} 的映射包名` });
      advice.push(manualAdvice(f.runtime, platform));
      continue;
    }
    const needsElevation = manager.needsAdmin && typeof process.getuid === 'function' && process.getuid() !== 0;
    const base = manager.installCmd(pkgs);
    const command = needsElevation ? ['sudo', ...base] : base;
    steps.push({
      runtime: f.runtime, action: 'install', command,
      note: needsElevation ? `需要管理员权限 (会执行 sudo, 只在显式同意后)` : `用 ${manager.kind} 安装: ${pkgs.join(', ')}`,
    });
    needsAdmin = needsAdmin || needsElevation;
    pathChanges = true;
  }

  // Python 安装后 PATH 可能变 (brew/pyenv/Windows); node/npm 同理标注
  const canAutoInstall = steps.some((s) => s.action === 'install') && !blockers.length;
  if (missing.includes('git')) advice.push('Git 缺失会让「源码更新」与「协作」能力不可用 —— 不把缺 Git 隐藏成后续运行时错误');
  if (missing.includes('python')) advice.push('Python 缺失会让 wiki 门禁脚本与 Python Skill 不可用');
  return { platform, distro: platform === 'linux' ? detectLinuxDistro() : null, present, missing, belowMinimum, manager: manager ? { kind: manager.kind, path: manager.path } : null, steps, needsAdmin, pathChanges, canAutoInstall, blockers, advice };
}

export function manualAdvice(id: RuntimeId, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return id === 'python'
      ? 'macOS: 装 Homebrew 后 `brew install python`, 或用 python.org 官方安装器 (https://www.python.org/downloads/macos/)'
      : id === 'git' ? 'macOS: `brew install git`, 或 `xcode-select --install` (Command Line Tools 自带 git)'
        : `macOS: \`brew install ${id}\` 或官方安装器`;
  }
  if (platform === 'win32') {
    return id === 'python'
      ? 'Windows: `winget install Python.Python.3.12` (装完到「应用执行别名」关掉 python.exe, 避免 Store alias 劫持)'
      : `Windows: \`winget install ${id === 'git' ? 'Git.Git' : id === 'node' ? 'OpenJS.NodeJS.LTS' : id}\``;
  }
  return `Linux: 用发行版包管理器安装 ${id} (apt: \`sudo apt-get install -y ${id === 'python' ? 'python3' : id === 'node' ? 'nodejs' : id}\`)`;
}

export function renderBootstrapPlan(plan: BootstrapPlan): string {
  const L: string[] = [];
  L.push('运行时预检结果:');
  L.push(`  平台: ${plan.platform}${plan.distro ? ` (${plan.distro.id}${plan.distro.version ? ' ' + plan.distro.version : ''})` : ''}`);
  L.push(`  已就绪: ${plan.present.join(', ') || '(无)'}`);
  if (plan.missing.length) L.push(`  缺失:   ${plan.missing.join(', ')}`);
  if (plan.belowMinimum.length) L.push(`  版本不足: ${plan.belowMinimum.join(', ')}`);
  L.push(`  包管理器: ${plan.manager ? `${plan.manager.kind} (${plan.manager.path})` : '(无)'}`);
  L.push('');
  for (const s of plan.steps) {
    L.push(`  [${s.action}] ${s.runtime}: ${s.note}`);
    if (s.command) L.push(`         ${s.command.join(' ')}`);
  }
  L.push('');
  L.push(`  需要管理员权限: ${plan.needsAdmin ? '是' : '否'}`);
  L.push(`  将修改 PATH: ${plan.pathChanges ? '是' : '否'}`);
  if (plan.blockers.length) L.push(`  阻塞: ${plan.blockers.join('; ')}`);
  for (const a of plan.advice) L.push(`  ⚠ ${a}`);
  return L.join('\n');
}

// ── Phase 5: 真执行验证 (不是"命令存在") ───────────────────────────────────

export interface VerifyResult { ok: boolean; detail: string }

/** git: 真建一个临时仓库并读状态。 */
export function verifyGitUsable(gitPath: string): VerifyResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-git-check-'));
  try {
    const init = spawnSync(gitPath, ['init', '-q'], { cwd: dir, encoding: 'utf-8', timeout: 20000 });
    if (init.status !== 0) return { ok: false, detail: `git init 失败: ${(init.stderr || '').slice(0, 200)}` };
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    spawnSync(gitPath, ['add', 'f.txt'], { cwd: dir, encoding: 'utf-8', timeout: 20000 });
    const st = spawnSync(gitPath, ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8', timeout: 20000 });
    const out = String(st.stdout || '').trim();
    if (!/^A\s+f\.txt/m.test(out)) return { ok: false, detail: `git status 读到 "${out}" (期望 A f.txt)` };
    const cfg = spawnSync(gitPath, ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf-8', timeout: 20000 });
    if (!/true/.test(String(cfg.stdout))) return { ok: false, detail: 'git -C 不可用' };
    return { ok: true, detail: 'git init/add/status/`-C` 真跑通过' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** python: 真跑一段最小脚本。 */
export function verifyPythonUsable(pyPath: string): VerifyResult {
  const r = spawnSync(pyPath, ['-c', 'import sys; sys.stdout.write(str(6*7))'], { encoding: 'utf-8', timeout: 20000 });
  if (r.status !== 0) return { ok: false, detail: `执行失败: ${(r.stderr || '').slice(0, 200)}` };
  const out = String(r.stdout || '').trim();
  if (out !== '42') return { ok: false, detail: `输出 "${out}" (期望 42)` };
  return { ok: true, detail: 'python -c 真跑通过 (6*7=42)' };
}

/** node: 真加载 Bolloon CLI 入口并读回版本 (不是只跑 node --version)。 */
export function verifyNodeLoadsCli(nodePath: string, entryPath: string): VerifyResult {
  const r = spawnSync(nodePath, [entryPath, '--version', 'json'], { encoding: 'utf-8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, detail: `CLI 启动失败 (exit ${r.status}): ${String(r.stderr || '').slice(0, 200)}` };
  const s = String(r.stdout || '');
  const i = s.indexOf('{');
  if (i < 0) return { ok: false, detail: 'CLI 没有输出可解析的版本 JSON' };
  try {
    const v = JSON.parse(s.slice(i));
    return { ok: true, detail: `CLI 加载成功, 报出版本 ${v.packageVersion}` };
  } catch {
    return { ok: false, detail: '版本 JSON 无法解析' };
  }
}

/** npm: 读本地全局安装信息 (网络查询交给 update 检查, 不在这里重复打 registry)。 */
export function verifyNpmUsable(npmPath: string): VerifyResult {
  const r = spawnSync(npmPath, ['ls', '-g', '--depth=0', '--json'], { encoding: 'utf-8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const out = String(r.stdout || '').trim();
  if (!out) return { ok: false, detail: `npm ls -g 无输出: ${String(r.stderr || '').slice(0, 200)}` };
  try {
    const data = JSON.parse(out);
    return { ok: true, detail: `npm 可执行, 全局依赖 ${Object.keys(data.dependencies || {}).length} 个` };
  } catch {
    return { ok: false, detail: 'npm ls -g 输出无法解析' };
  }
}

/** 四个运行时一起做真执行验证。 */
export async function verifyRuntimesDeep(facts: RuntimeFact[], entryPath?: string): Promise<RuntimeFact[]> {
  const byId = new Map(facts.map((f) => [f.runtime, f]));
  const out: RuntimeFact[] = [];
  for (const f of facts) {
    if (f.status !== 'found' || !f.path) { out.push(f); continue; }
    const at = new Date().toISOString();
    let v: VerifyResult = { ok: false, detail: '未验证' };
    if (f.runtime === 'git') v = verifyGitUsable(f.path);
    else if (f.runtime === 'python') v = verifyPythonUsable(f.path);
    else if (f.runtime === 'npm') v = verifyNpmUsable(f.path);
    else if (f.runtime === 'node') {
      v = entryPath ? verifyNodeLoadsCli(f.path, entryPath) : { ok: true, detail: 'node --version 通过 (未提供 CLI 入口)' };
    }
    out.push({
      ...f,
      verified: v.ok,
      lastVerifiedAt: at,
      notes: [...f.notes, v.ok ? v.detail : `真执行验证失败: ${v.detail}`],
      status: v.ok ? f.status : 'failed',
      ...(v.ok ? {} : { meetsMinimum: false, error: v.detail }),
    });
  }
  void byId;
  return out;
}

// ── Phase 4: 配置持久化 (~/.bolloon/config.json 的 runtime.*) ──────────────

export interface RuntimeConfigEntry {
  path: string | null;
  version: string | null;
  source: InstallSource;
  installedByBolloon: boolean;
  lastVerifiedAt: string | null;
  meetsMinimum: boolean;
}

export function buildRuntimeConfig(facts: RuntimeFact[]): Record<RuntimeId, RuntimeConfigEntry> {
  const out: any = {};
  for (const f of facts) {
    out[f.runtime] = {
      path: f.path, version: f.version, source: f.source,
      installedByBolloon: f.installedByBolloon,
      lastVerifiedAt: f.lastVerifiedAt || null,
      meetsMinimum: f.meetsMinimum,
    } as RuntimeConfigEntry;
  }
  return out;
}

/**
 * 写入 `~/.bolloon/config.json` 的 `runtime` 字段。
 * **只动 runtime 一个键**; 文件不存在时创建 (与 postinstall 同一份默认形状); 其余字段原样保留。
 */
export async function writeRuntimeConfig(home: string, facts: RuntimeFact[]): Promise<{ written: boolean; configPath: string; created: boolean }> {
  const configPath = path.join(home, 'config.json');
  let cfg: any;
  let created = false;
  try {
    cfg = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch {
    cfg = { version: 'unknown', initializedAt: new Date().toISOString(), updateChannel: 'stable', checkUpdates: true, autoInstall: false, autoRestart: false };
    created = true;
  }
  cfg.runtime = buildRuntimeConfig(facts);
  cfg.runtimeUpdatedAt = new Date().toISOString();
  await fsp.mkdir(home, { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await fsp.rename(tmp, configPath);
  return { written: true, configPath, created };
}

export async function readRuntimeConfig(home: string = resolveBolloonHome()): Promise<Partial<Record<RuntimeId, RuntimeConfigEntry>>> {
  try {
    const p = path.join(home, 'config.json');
    const cfg = JSON.parse(await fsp.readFile(p, 'utf8'));
    return (cfg?.runtime && typeof cfg.runtime === 'object') ? cfg.runtime : {};
  } catch {
    return {};
  }
}

/** 兼容入口: 有些安装只写 bolloon-config.json (正式配置文件) —— runtime.* 也读它作为回退。 */
export async function readRuntimeConfigWithFallback(home: string = resolveBolloonHome()): Promise<Partial<Record<RuntimeId, RuntimeConfigEntry>>> {
  const a = await readRuntimeConfig(home);
  if (Object.keys(a).length) return a;
  try {
    const p = path.join(home, CANONICAL_CONFIG_FILE);
    const cfg = JSON.parse(await fsp.readFile(p, 'utf8'));
    return (cfg?.runtime && typeof cfg.runtime === 'object') ? cfg.runtime : {};
  } catch {
    return {};
  }
}

// ── 能力矩阵 (Phase 5/8 的六行输出) ────────────────────────────────────────

export function evaluateCapabilities(facts: RuntimeFact[]): RuntimeCapabilities {
  const ok = (id: RuntimeId): boolean => {
    const f = facts.find((x) => x.runtime === id);
    return !!f && f.status === 'found' && f.meetsMinimum && f.verified !== false;
  };
  const core = ok('node') && ok('npm');
  const git = ok('git');
  const py = ok('python');
  return {
    core,
    sourceUpdate: core && git,
    gitCollaboration: core && git,
    pythonSkill: core && py,
    wikiTools: core && git && py,
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

export interface DetectOptions {
  home?: string;
  /** 用配置文件里的绝对路径做优先候选 (仍会真执行验证) */
  useConfig?: boolean;
  deep?: boolean;
  entryPath?: string;
  envPath?: string;
}

/** 探测四个运行时 (Phase 1 的统一出口; install.sh / postinstall / doctor / --version 都走它)。 */
export async function detectRuntimeReport(opts: DetectOptions = {}): Promise<RuntimeReport> {
  const home = opts.home || resolveBolloonHome();
  const cfg = opts.useConfig === false ? {} : await readRuntimeConfigWithFallback(home);
  const facts = (['node', 'npm', 'git', 'python'] as RuntimeId[]).map((id) =>
    probeRuntime(id, { preferredPath: cfg[id]?.path ?? null, envPath: opts.envPath }));

  const checkedAt = new Date().toISOString();
  const withVerify = opts.deep ? await verifyRuntimesDeep(facts, opts.entryPath) : facts;
  const caps = evaluateCapabilities(withVerify);
  const missing = withVerify.filter((f) => f.status === 'missing').map((f) => f.runtime);
  const below = withVerify.filter((f) => f.status === 'failed' && !(f.verified === false)).map((f) => f.runtime);
  const failedStage = withVerify.find((f) => f.status === 'failed');
  const ok = missing.length === 0 && withVerify.every((f) => f.status === 'found' && f.meetsMinimum);

  const advice: string[] = [];
  for (const f of withVerify) {
    if (f.status === 'found') continue;
    advice.push(`${f.runtime}: ${f.error || '不可用'} → ${manualAdvice(f.runtime, process.platform)}`);
  }

  return {
    schema: 'bolloon-runtime/1',
    platform: process.platform,
    arch: process.arch,
    facts: withVerify,
    ok,
    missing,
    belowMinimum: below,
    failedStage: ok ? null : (failedStage ? `${failedStage.runtime} 验证` : (missing.length ? `${missing.join('/')} 缺失` : '运行时检查')),
    advice,
    capabilities: caps,
    checkedAt,
    installed: [],
    dryRun: false,
  };
}

export interface BootstrapOptions {
  home?: string;
  /** 只看不做 (Phase 3 --dry-run) */
  dryRun?: boolean;
  /** 显式同意执行安装 (交互确认由调用方负责) */
  yes?: boolean;
  /** 允许 sudo (默认 **不允许**, 见 Phase 3「不偷偷 sudo」) */
  allowSudo?: boolean;
  /** 允许写 PATH/配置 */
  configurePath?: boolean;
  entryPath?: string;
  envPath?: string;
  onProgress?: (msg: string) => void;
  /** 注入执行器 (测试) */
  run?: (cmd: string, args: string[]) => { code: number; out: string; err: string };
}

function defaultRun(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 1800_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || r.error?.message || '') };
}

export interface BootstrapResult extends RuntimeReport {
  plan: BootstrapPlan;
  /** 每个运行时的安装命令与结果 (供安装日志/报告) */
  actions: { runtime: RuntimeId; command: string[] | null; code: number | null; action: string }[];
}

/**
 * 运行时安装 (Phase 1/2/3/4/5)。
 * 顺序: 探测 → 计划 → (dryRun 停) → 逐项安装 → 重新探测 → 真执行验证 → 写配置。
 * 不满足任何一个必需运行时 → 报告 `ok:false` + `failedStage` + `advice` (退出码由调用方给非 0)。
 */
export async function bootstrapRuntimes(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const home = opts.home || resolveBolloonHome();
  const log = opts.onProgress || (() => { /* 静默 */ });
  const envPath = opts.envPath || process.env.PATH || '';
  const manager = detectPackageManager(process.platform, envPath);
  const run = opts.run || defaultRun;

  const before = await detectRuntimeReport({ home, useConfig: true, envPath });
  const plan = planBootstrap(before.facts, { manager, envPath });
  const actions: BootstrapResult['actions'] = [];

  if (opts.dryRun) {
    log('[dry-run] 只显示计划, 不执行任何安装');
    return {
      ...before, plan, actions, dryRun: true,
      advice: [...before.advice, ...plan.advice.filter((a) => !before.advice.includes(a))],
    };
  }

  if (!opts.yes) {
    log('未获得显式同意 (需要 --yes / 交互确认) —— 不执行安装');
    return {
      ...before, plan, actions,
      advice: [...before.advice, ...plan.advice.filter((a) => !before.advice.includes(a)),
        before.ok ? '' : '确认后重跑: bolloon runtime install (或 install.sh --yes)'].filter(Boolean),
    };
  }

  const installed: RuntimeId[] = [];
  for (const step of plan.steps) {
    if (step.action !== 'install' || !step.command) continue;
    const needsSudo = step.command[0] === 'sudo';
    if (needsSudo && !opts.allowSudo) {
      actions.push({ runtime: step.runtime, command: step.command, code: null, action: 'skipped-needs-sudo' });
      log(`跳过 ${step.runtime}: 需要管理员权限, 未显式允许 sudo (不偷偷提权)`);
      continue;
    }
    log(`安装 ${step.runtime}: ${step.command.join(' ')}`);
    const t0 = new Date().toISOString();
    const r = run(step.command[0], step.command.slice(1));
    const t1 = new Date().toISOString();
    actions.push({ runtime: step.runtime, command: step.command, code: r.code, action: 'install' });
    if (r.code !== 0) {
      log(`安装 ${step.runtime} 失败 (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`);
    } else {
      installed.push(step.runtime);
    }
    void t0; void t1;
  }

  // 重新探测 (PATH 可能变) + 真执行验证
  const after = await detectRuntimeReport({ home, useConfig: true, deep: true, entryPath: opts.entryPath, envPath });
  const merged: RuntimeReport = {
    ...after,
    facts: after.facts.map((f) => installed.includes(f.runtime)
      ? { ...f, status: (f.status === 'found' ? 'installed' : f.status), source: (manager?.kind as InstallSource) || 'official-installer', installedByBolloon: f.status === 'found' }
      : f),
    installed,
    dryRun: false,
  };

  // 能力矩阵要用最终状态重算
  merged.capabilities = evaluateCapabilities(merged.facts);
  const stillMissing = merged.facts.filter((f) => f.status !== 'found');
  merged.ok = stillMissing.length === 0;
  merged.missing = merged.facts.filter((f) => f.status === 'missing').map((f) => f.runtime);
  merged.failedStage = merged.ok ? null : `运行时验证 (${stillMissing.map((f) => f.runtime).join('/')})`;
  const extraAdvice = stillMissing.map((f) => `${f.runtime}: ${f.error || '仍不可用'} → ${manualAdvice(f.runtime, process.platform)}`);
  merged.advice = Array.from(new Set([...merged.advice, ...plan.advice, ...extraAdvice]));

  if (opts.configurePath !== false) {
    try {
      await writeRuntimeConfig(home, merged.facts);
      log(`已写入运行时配置: ${path.join(home, 'config.json')} (只动 runtime 字段)`);
    } catch (e: any) {
      merged.advice.push(`写运行时配置失败: ${e?.message || e}`);
    }
  }

  // 运行时补齐成功 → 清掉 postinstall 留下的"安装未完成"标记
  if (merged.ok) {
    try { await fsp.unlink(path.join(home, 'install-incomplete.json')); } catch { /* 没有就算了 */ }
  }

  return { ...merged, plan, actions };
}

// ── 报告渲染 (Phase 5 的两种形状) ──────────────────────────────────────────

const CAP_LABEL: Record<keyof RuntimeCapabilities, string> = {
  core: '核心运行', sourceUpdate: '源码更新', gitCollaboration: 'Git 协作',
  pythonSkill: 'Python Skill', wikiTools: 'Wiki 工具',
};

export function renderRuntimeReport(rep: RuntimeReport, opts: { verbose?: boolean } = {}): string {
  const L: string[] = [];
  const nameOf: Record<RuntimeId, string> = { node: 'Node.js', npm: 'npm', git: 'Git', python: 'Python' };
  if (!rep.ok) {
    const bad = rep.facts.filter((f) => f.status !== 'found');
    L.push('Bolloon 安装未完成');
    L.push(`失败阶段: ${rep.failedStage || '运行时检查'}`);
    for (const f of bad) L.push(`${nameOf[f.runtime]}: ${f.error || '不可用'}${f.path ? ` (路径 ${f.path})` : ''}`);
    if (rep.advice.length) {
      L.push('处理建议:');
      for (const a of rep.advice) L.push(`  - ${a}`);
    }
    L.push('');
    L.push('(模拟/联调提示: 修复后重跑 `bolloon runtime check`, 或 `bolloon runtime install`)');
    return L.join('\n');
  }

  L.push(rep.installed.length ? 'Bolloon 安装完成 (含本次安装的运行时)' : 'Bolloon 运行时检查通过');
  L.push('');
  for (const f of rep.facts) {
    const extra = opts.verbose ? `  ${f.path || ''}  [${f.source}${f.installedByBolloon ? ', 由 Bolloon 安装' : ''}${f.lastVerifiedAt ? `, 验证于 ${f.lastVerifiedAt}` : ''}]` : '';
    L.push(`${nameOf[f.runtime].padEnd(8)} ✓  ${(f.version || '?').padEnd(10)}${extra}`);
  }
  L.push('');
  for (const [k, label] of Object.entries(CAP_LABEL) as [keyof RuntimeCapabilities, string][]) {
    L.push(`${label.padEnd(14)} ${rep.capabilities[k] ? '可用' : '不可用'}`);
  }
  return L.join('\n');
}

/** `bolloon --version` 的运行时一节 (leo: 展示安装信息时要展示这些配置)。 */
export async function readIncompleteMarker(home = resolveBolloonHome()): Promise<{ at: string; missing: string[]; howToFix?: string[] } | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(home, 'install-incomplete.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function renderRuntimeLines(rep: RuntimeReport, opts: { verbose?: boolean; configBacked?: boolean } = {}): string[] {
  const nameOf: Record<RuntimeId, string> = { node: 'Node.js', npm: 'npm', git: 'Git', python: 'Python' };
  const L: string[] = [];
  // 配置里还没写 runtime.* 时不要假装"来自配置" —— 那是实时探测的结果
  L.push(opts.configBacked
    ? '运行时配置: (来自 ~/.bolloon/config.json 的 runtime.*, 每次启动重新验证)'
    : '运行时配置: (实时探测 — 配置里还没有 runtime.*; 跑 `bolloon runtime` 会写入)');
  for (const f of rep.facts) {
    const mark = f.status === 'found' ? '✓' : '✗';
    const src = f.installedByBolloon ? '由 Bolloon 安装' : f.source === 'existing' ? '已有' : f.source;
    L.push(`  ${mark} ${nameOf[f.runtime].padEnd(8)} ${(f.version || '未找到').padEnd(10)} ${f.path || '-'}  [${src}]`);
  }
  if (opts.verbose) {
    L.push(`  能力: 核心运行=${rep.capabilities.core ? '可用' : '不可用'} · 源码更新=${rep.capabilities.sourceUpdate ? '可用' : '不可用'} · Python Skill=${rep.capabilities.pythonSkill ? '可用' : '不可用'} · Wiki 工具=${rep.capabilities.wikiTools ? '可用' : '不可用'}`);
    L.push(`  检查时间: ${rep.checkedAt}`);
  }
  return L;
}
