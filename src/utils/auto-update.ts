/**
 * npm 自动更新检查器
 *
 * 功能：
 * - 启动时（后台、节流）检查 npm 注册表是否有新版本
 * - 检测到新版本时自动下载并安装最新版本（可按需关闭）
 * - 支持增量更新（只更新有变化的包）
 *
 * 设计要点：
 * - 全局安装位置通过 `npm root -g` / `npm prefix -g` 动态探测，
 *   不再依赖写死的路径，兼容 nvm / homebrew / 默认 prefix。
 * - 运行中的包版本优先从全局安装位置（npm root -g 动态探测）读取，
 *   开发态下若 cwd 的 package.json 就是本包则回退到 cwd，不受任意工作目录影响。
 * - 检查频率受节流缓存约束（默认 24h 一次），不会每次启动都打 npm。
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

// ANSI 颜色
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

const PKG_NAME = '@bolloon/bolloon-agent';
const BOLLOON_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.bolloon');
const UPDATE_CACHE = path.join(BOLLOON_DIR, '.update-check.json');

interface PackageInfo {
  name: string;
  version: string;
  latest: string;
  outdated: boolean;
  packages: OutdatedPackage[];
}

interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  location: string;
}

interface UpdateResult {
  success: boolean;
  updated: boolean;
  message: string;
  updatedPackages?: string[];
  error?: string;
}

/** 2026-08-07: CLI 交互模式下静音自动更新通知 (避免后台检查污染 TUI 屏幕) */
let notifyQuiet = false;
export function setNotifyQuiet(v: boolean): void {
  notifyQuiet = v;
}

/**
 * 通知用户。使用 stderr，避免在交互式 CLI 模式下 stdout 被吞掉。
 */
function notify(msg: string, color: string = RESET) {
  if (notifyQuiet) return;
  process.stderr.write(`${color}${msg}${RESET}`);
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * 读取某目录下的 package.json 版本号
 */
function readVersion(dir: string | null): string | null {
  if (!dir) return null;
  const pkgPath = path.join(dir, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || null;
    }
  } catch {
    // 忽略
  }
  return null;
}

/**
 * 获取 bolloon 全局安装目录（动态探测，兼容多种 npm 安装方式）。
 * 同时兼容 ESM(Node) 与 CJS(Electron) 上下文，不依赖 import.meta。
 */
function getGlobalBolloonDir(): string | null {
  const candidates: string[] = [];

  // 1. npm root -g（最可靠）
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 8000 }).trim();
    if (npmRoot) candidates.push(path.join(npmRoot, '@bolloon', 'bolloon-agent'));
  } catch {
    // 忽略
  }

  // 2. npm prefix -g
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 8000 }).trim();
    if (npmPrefix) candidates.push(path.join(npmPrefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent'));
  } catch {
    // 忽略
  }

  // 3. nvm 各版本目录
  const home = process.env.HOME || '';
  const nvmBase = path.join(home, '.nvm', 'versions', 'node');
  try {
    if (fs.existsSync(nvmBase)) {
      for (const ver of fs.readdirSync(nvmBase)) {
        candidates.push(path.join(nvmBase, ver, 'lib', 'node_modules', '@bolloon', 'bolloon-agent'));
      }
    }
  } catch {
    // 忽略
  }

  // 4. 常见写死路径兜底
  candidates.push(
    path.join(home, '.npm-global', 'lib', 'node_modules', '@bolloon', 'bolloon-agent'),
    '/usr/local/lib/node_modules/@bolloon/bolloon-agent',
    '/opt/homebrew/lib/node_modules/@bolloon/bolloon-agent',
    path.join(home, 'node_modules', '@bolloon', 'bolloon-agent'),
  );

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
  }
  return null;
}

/**
 * 获取当前安装的包版本。
 * 主包优先用「全局安装位置」；开发态下若 cwd 的 package.json 就是本包则回退到 cwd。
 * 不再无差别回退到 cwd（避免全局启动时误读用户工作目录的版本）。
 */
function getInstalledVersion(packageName: string): string | null {
  if (packageName === PKG_NAME) {
    const fromGlobal = readVersion(getGlobalBolloonDir());
    if (fromGlobal) return fromGlobal;

    // 开发态：仅在 cwd 的 package.json 确为本包时才采用
    const cwdPkg = path.join(process.cwd(), 'package.json');
    try {
      if (fs.existsSync(cwdPkg)) {
        const data = JSON.parse(fs.readFileSync(cwdPkg, 'utf-8'));
        if (data.name === PKG_NAME && data.version) return data.version;
      }
    } catch {
      // 忽略
    }
  }

  // 其它包：检查本地 node_modules
  const packageJsonPath = findPackageJson(packageName);
  if (packageJsonPath) {
    return readVersion(path.dirname(packageJsonPath));
  }
  return null;
}

/**
 * 查找包的 package.json 路径
 */
function findPackageJson(packageName: string): string | null {
  const checkPaths = [
    path.join(process.cwd(), 'node_modules', packageName, 'package.json'),
    path.join(process.cwd(), 'node_modules', '@' + packageName.split('/')[0], packageName.split('/')[1] || '', 'package.json'),
  ];

  for (const p of checkPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 检查 npm 注册表获取最新版本
 */
async function getLatestVersion(packageName: string): Promise<string | null> {
  try {
    const encodedName = encodeURIComponent(packageName);
    const url = `https://registry.npmjs.org/${encodedName}`;
    const response = await httpGet(url);
    const data = JSON.parse(response);
    return data['dist-tags']?.latest || null;
  } catch (e) {
    return null;
  }
}

/**
 * 比较版本号
 */
function compareVersions(current: string, latest: string): -1 | 0 | 1 {
  const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const currentParts = norm(current);
  const latestParts = norm(latest);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const c = currentParts[i] || 0;
    const l = latestParts[i] || 0;
    if (c < l) return -1;
    if (c > l) return 1;
  }
  return 0;
}

/**
 * 检查 bolloon 相关包是否有更新
 */
async function checkBolloonUpdates(): Promise<PackageInfo | null> {
  const packagesToCheck = [
    PKG_NAME,
    '@bolloon/constraint-runtime',
  ];

  const outdatedPackages: OutdatedPackage[] = [];
  let hasUpdate = false;
  let currentVersion = '';
  let latestVersion = '';

  for (const pkg of packagesToCheck) {
    const installed = getInstalledVersion(pkg);
    if (!installed) continue;

    if (pkg === PKG_NAME) {
      currentVersion = installed;
    }

    const latest = await getLatestVersion(pkg);
    if (latest && compareVersions(installed, latest) < 0) {
      hasUpdate = true;
      latestVersion = latest;
      outdatedPackages.push({
        name: pkg,
        current: installed,
        wanted: latest,
        latest,
        location: pkg
      });
    }
  }

  if (outdatedPackages.length === 0) {
    return {
      name: PKG_NAME,
      version: currentVersion,
      latest: currentVersion,
      outdated: false,
      packages: []
    };
  }

  return {
    name: PKG_NAME,
    version: currentVersion,
    latest: latestVersion,
    outdated: hasUpdate,
    packages: outdatedPackages
  };
}

/**
 * 使用 npm outdated 检查所有包的更新
 */
function checkNpmOutdated(): OutdatedPackage[] {
  try {
    const output = execSync('npm outdated --json', {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: process.cwd()
    });

    if (!output.trim()) return [];

    const data = JSON.parse(output);
    const packages: OutdatedPackage[] = [];

    for (const [name, info] of Object.entries(data)) {
      const pkg = info as any;
      packages.push({
        name,
        current: pkg.current || '0.0.0',
        wanted: pkg.wanted || '0.0.0',
        latest: pkg.latest || '0.0.0',
        location: pkg.location || name
      });
    }

    return packages;
  } catch (e: any) {
    // npm outdated 在没有过时包时会返回非零退出码
    if (e.status !== 0 && !e.message?.includes('npm outdated')) {
      return [];
    }
    return [];
  }
}

/**
 * 解析 `name` 或 `name@version` 形式，未带版本时从 npm 解析 latest，
 * 拼成 `name@version`，避免 npm 被本地 package.json 的 semver 约束卡住。
 */
async function resolveTargetsWithVersion(targets: string[]): Promise<string[]> {
  return Promise.all(targets.map(async (spec) => {
    const m = spec.match(/^(.+?)@([^@]+)$/);
    // 形如 @scope/name@1.2.3 或 name@1.2.3 且版本以数字开头 -> 已带版本
    if (m && m[2] && /^\d/.test(m[2])) return spec;
    const latest = await getLatestVersion(spec);
    return latest ? `${spec}@${latest}` : spec;
  }));
}

/**
 * 自动更新 npm 包, 传 `name@version` 形式的目标让 npm install 不被本地
 * package.json 的 semver 约束卡住（旧版只传 name 时, npm 看到本地
 * package.json 里 "^0.3.x" 已经满足就判 up to date, 永远升不上去）
 */
async function updatePackagesWithVersion(packagesWithVersion: string[]): Promise<UpdateResult> {
  const parsed = packagesWithVersion.map(spec => {
    const at = spec.lastIndexOf('@');
    if (at <= 0) return { name: spec, version: '' };
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  });
  const targets = parsed.map(p => p.name);
  const before = new Map<string, string | null>();
  for (const p of targets) before.set(p, getInstalledVersion(p));

  // 用 targetsWithVersion 直接拼命令 - 包含具体版本号, 不会被本地约束拦截
  const args = ['npm', 'install', '-g', ...packagesWithVersion];

  notify(`\n${CYAN}📦 正在更新包...${RESET}\n`, RESET);

  try {
    execSync(args.join(' '), {
      encoding: 'utf-8',
      timeout: 300000,
      stdio: 'inherit',
      // 全局安装与 cwd 无关，用中性目录避免本地 package.json 干扰
      cwd: process.env.TMPDIR || '/tmp'
    });
  } catch (e: any) {
    return {
      success: false,
      updated: false,
      message: '更新失败',
      error: e.message
    };
  }

  // install 退出码 0 并不等于"真的升上去了" ("up to date" 也是 0)。
  // 重新读取磁盘版本, 只有真的达到 latest 之一才算 updated。
  const upgraded: string[] = [];
  for (const p of parsed) {
    const after = getInstalledVersion(p.name);
    const was = before.get(p.name);
    if (after && was && compareVersions(was, after) < 0) {
      upgraded.push(p.name);
    }
  }

  if (upgraded.length > 0) {
    return {
      success: true,
      updated: true,
      message: `已更新: ${upgraded.join(', ')}`,
      updatedPackages: upgraded
    };
  }
  return {
    success: true,
    updated: false,
    message: '已是最新版本，无需重启',
    updatedPackages: []
  };
}

/**
 * 自动更新 npm 包（不传版本时自动解析 latest）
 */
async function updatePackages(packages?: string[]): Promise<UpdateResult> {
  const targets = packages && packages.length > 0 ? packages : [PKG_NAME];
  const withVersion = await resolveTargetsWithVersion(targets);
  return updatePackagesWithVersion(withVersion);
}

// ---------------------------------------------------------------------------
// 配置 / 节流
// ---------------------------------------------------------------------------

interface UpdateConfig {
  autoUpdate: boolean;       // 是否允许启动时自动检查并安装
  autoRestart: boolean;      // 安装成功后是否自动重启以应用新版本
  checkIntervalHours: number;
}

function loadUpdateConfig(): UpdateConfig {
  const def: UpdateConfig = { autoUpdate: true, autoRestart: true, checkIntervalHours: 24 };
  try {
    const cfgPath = path.join(BOLLOON_DIR, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (typeof cfg.autoUpdate === 'boolean') def.autoUpdate = cfg.autoUpdate;
      if (typeof cfg.autoRestart === 'boolean') def.autoRestart = cfg.autoRestart;
    }
  } catch {
    // 忽略
  }
  return def;
}

function readCache(): any {
  try {
    if (fs.existsSync(UPDATE_CACHE)) {
      return JSON.parse(fs.readFileSync(UPDATE_CACHE, 'utf-8'));
    }
  } catch {
    // 忽略
  }
  return {};
}

function writeCache(patch: object) {
  try {
    fs.mkdirSync(BOLLOON_DIR, { recursive: true });
    const merged = { ...readCache(), ...patch, lastCheck: Date.now() };
    fs.writeFileSync(UPDATE_CACHE, JSON.stringify(merged));
  } catch {
    // 忽略
  }
}

function shouldCheckNow(cfg: UpdateConfig): boolean {
  const cache = readCache();
  const last = cache.lastCheck || 0;
  const interval = cfg.checkIntervalHours * 3600 * 1000;
  return Date.now() - last >= interval;
}

/**
 * 判断本次启动是否应执行自动更新检查。
 * 显式屏蔽（--no-update / BOLLOON_SKIP_UPDATE）始终优先。
 * 否则依据 config.json 的 autoUpdate（默认开启）或显式允许标志。
 */
function resolveAutoUpdatePolicy() {
  const blockFlag = process.argv.includes('--no-update') || process.argv.includes('--skip-update');
  const blockEnv = process.env.BOLLOON_SKIP_UPDATE === 'true';
  const allowFlag = process.argv.includes('--update-check')
    || process.argv.includes('--update-now')
    || process.argv.includes('--allow-update');
  const allowEnv = process.env.BOLLOON_AUTO_UPDATE === '1';
  const cfg = loadUpdateConfig();

  const blocked = blockFlag || blockEnv;
  const enabled = cfg.autoUpdate || allowFlag || allowEnv;
  return { blocked, enabled, allowFlag, allowEnv, cfg };
}

/**
 * 检查并自动更新（启动时调用）
 *
 * @param opts.force     忽略节流/配置强制检查
 * @param opts.onUpdated 安装成功且允许自动重启时调用（由调用方提供模式相关的重启逻辑，
 *                       例如 Electron 用 app.relaunch()，Node 用 detached 重新 spawn）。
 *                       若未提供或 autoRestart=false，则仅提示用户手动重启。
 */
export async function checkAndUpdate(opts: { force?: boolean; onUpdated?: () => void } = {}): Promise<{
  hasUpdate: boolean;
  info: PackageInfo | null;
  updated: boolean;
  message: string;
}> {
  const policy = resolveAutoUpdatePolicy();

  if (policy.blocked) {
    return { hasUpdate: false, info: null, updated: false, message: '跳过更新检查（已显式禁用）' };
  }

  if (!policy.enabled && !opts.force) {
    return { hasUpdate: false, info: null, updated: false, message: '自动更新已关闭 (config.json autoUpdate=false，或设置 BOLLOON_AUTO_UPDATE=1 开启)' };
  }

  // 节流：除非显式触发或强制，否则距离上次检查不足间隔就跳过
  if (!opts.force && !policy.allowFlag && !policy.allowEnv && !shouldCheckNow(policy.cfg)) {
    return { hasUpdate: false, info: null, updated: false, message: '距上次检查不足间隔，跳过' };
  }

  notify(`\n${CYAN}🔍 检查更新...${RESET}`, RESET);

  try {
    const bolloonInfo = await checkBolloonUpdates();

    if (bolloonInfo && bolloonInfo.outdated) {
      notify(`\n${YELLOW}⚠️  发现新版本: ${bolloonInfo.latest}${RESET}\n`, RESET);
      notify(`   当前版本: ${bolloonInfo.version}\n`, RESET);
      notify(`   最新版本: ${bolloonInfo.latest}\n\n`, RESET);

      // 避免对同一个版本反复自动安装失败：记录上次尝试
      const cache = readCache();
      const lastAttempt = cache.lastAttempt || {};
      if (lastAttempt.version === bolloonInfo.latest && lastAttempt.ok === false && !opts.force) {
        notify(`${YELLOW}💡 该版本上次自动更新失败，请手动运行: bolloon --update-now${RESET}\n\n`, RESET);
        writeCache({ lastCheck: Date.now() });
        return {
          hasUpdate: true,
          info: bolloonInfo,
          updated: false,
          message: `更新 ${bolloonInfo.latest} 上次失败，需手动更新`
        };
      }

      // 自动更新（用户要求：检测到新版本包时自动更新）
      const targetsWithVersion = bolloonInfo.packages.map(p => `${p.name}@${p.latest}`);
      const result = await updatePackagesWithVersion(targetsWithVersion);

      if (result.success && result.updated) {
        writeCache({ lastAttempt: { version: bolloonInfo.latest, ok: true } });

        // 通知主进程更新完成
        process.emit('bolloon-update-complete', result);

        // 安装成功：按配置自动重启，或退回手动提示
        if (opts.onUpdated && policy.cfg.autoRestart) {
          notify(`\n${GREEN}✅ 已更新到 ${bolloonInfo.latest}，即将自动重启以应用新版本...${RESET}\n\n`, RESET);
          // 调用方执行模式相关的重启（Electron: app.relaunch(); Node: detached spawn）。
          // 此调用预期会退出当前进程，不会返回。
          opts.onUpdated();
          // 兜底：若 onUpdated 意外返回，则手动退出
          process.exit(0);
        }

        notify(`\n${GREEN}✅ 已更新到 ${bolloonInfo.latest}！请重新启动应用${RESET}\n`, RESET);
        notify(`${YELLOW}💡 请重新运行 bolloon 以使用新版本${RESET}\n\n`, RESET);
        return {
          hasUpdate: true,
          info: bolloonInfo,
          updated: true,
          message: `已更新到 ${bolloonInfo.latest}`
        };
      } else if (result.success && !result.updated) {
        // npm 判定已是最新（未真正升级），记录失败避免反复尝试
        writeCache({ lastAttempt: { version: bolloonInfo.latest, ok: false } });
        notify(` ${YELLOW}⚠ 已是最新（无需重启）${RESET}\n\n`, RESET);
        return {
          hasUpdate: true,
          info: bolloonInfo,
          updated: false,
          message: '已是最新版本'
        };
      } else {
        writeCache({ lastAttempt: { version: bolloonInfo.latest, ok: false } });
        notify(` ${YELLOW}⚠ 自动更新失败: ${result.error}${RESET}\n`, RESET);
        notify(`${YELLOW}💡 可手动运行: bolloon --update-now${RESET}\n\n`, RESET);
        return {
          hasUpdate: true,
          info: bolloonInfo,
          updated: false,
          message: `更新失败: ${result.error}`
        };
      }
    } else {
      notify(` ${GREEN}✓${RESET} 已是最新版本 (${bolloonInfo?.version || 'unknown'})\n`, RESET);
      writeCache({ lastAttempt: { version: '', ok: true } });
      return {
        hasUpdate: false,
        info: bolloonInfo,
        updated: false,
        message: '已是最新版本'
      };
    }
  } catch (e: any) {
    notify(` ${YELLOW}⚠${RESET} 更新检查失败: ${e.message}\n`, RESET);
    return {
      hasUpdate: false,
      info: null,
      updated: false,
      message: `检查失败: ${e.message}`
    };
  }
}

/**
 * 仅检查更新，不自动安装
 */
export async function checkForUpdates(): Promise<PackageInfo | null> {
  return await checkBolloonUpdates();
}

/**
 * 手动触发更新
 */
export async function performUpdate(packages?: string[]): Promise<UpdateResult> {
  return await updatePackages(packages);
}

// CLI 入口
if (process.argv[1]?.includes('auto-update')) {
  (async () => {
    const command = process.argv[2];

    switch (command) {
      case 'check':
        const info = await checkForUpdates();
        if (info) {
          console.log(JSON.stringify(info, null, 2));
        }
        break;

      case 'update':
        const result = await performUpdate(process.argv.slice(3));
        console.log(JSON.stringify(result, null, 2));
        break;

      default:
        await checkAndUpdate();
    }
  })();
}
