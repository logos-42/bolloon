/**
 * npm 自动更新检查器
 *
 * 功能：
 * - 启动时检查 npm 注册表是否有新版本
 * - 自动下载并安装最新版本
 * - 支持增量更新（只更新新增的包）
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

function log(msg: string, color: string = RESET) {
  process.stdout.write(`${color}${msg}${RESET}`);
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
 * 获取 bolloon 全局安装目录
 */
function getGlobalBolloonDir(): string | null {
  const possiblePaths = [
    path.join(process.env.HOME || '', '.npm-global/lib/node_modules/@bolloon/bolloon-agent'),
    path.join(process.env.PREFIX || '/usr/local', 'lib/node_modules/@bolloon/bolloon-agent'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'package.json'))) {
      return p;
    }
  }
  return null;
}

/**
 * 获取当前安装的包版本
 * 优先使用全局安装的版本（更准确反映实际运行的版本）
 */
function getInstalledVersion(packageName: string): string | null {
  // 调试：打印 cwd
  console.error(`[DEBUG] getInstalledVersion called, cwd=${process.cwd()}, package=${packageName}`);

  // 对于 @bolloon/bolloon-agent，始终优先从全局安装位置读取版本
  // 这样可以准确检测实际安装的版本，而不受 cwd 影响
  if (packageName === '@bolloon/bolloon-agent') {
    const globalDir = getGlobalBolloonDir();
    console.error(`[DEBUG] globalDir=${globalDir}`);
    if (globalDir) {
      const pkgPath = path.join(globalDir, 'package.json');
      console.error(`[DEBUG] pkgPath=${pkgPath}, exists=${fs.existsSync(pkgPath)}`);
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        console.error(`[DEBUG] pkg.version=${pkg.version}`);
        return pkg.version || null;
      } catch (e) {
        // 忽略
      }
    }

    // 回退到本地 package.json
    const localPkgPath = path.join(process.cwd(), 'package.json');
    console.error(`[DEBUG] localPkgPath=${localPkgPath}, exists=${fs.existsSync(localPkgPath)}`);
    if (fs.existsSync(localPkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
        console.error(`[DEBUG] local pkg.version=${pkg.version}`);
        return pkg.version || null;
      } catch (e) {
        // 忽略
      }
    }
  }

  // 检查本地 node_modules
  const packageJsonPath = findPackageJson(packageName);
  console.error(`[DEBUG] findPackageJson=${packageJsonPath}`);
  if (packageJsonPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      console.error(`[DEBUG] node_modules pkg.version=${pkg.version}`);
      return pkg.version || null;
    } catch (e) {
      // 忽略错误
    }
  }
  return null;
}

/**
 * 查找包的 package.json 路径
 */
function findPackageJson(packageName: string): string | null {
  // 检查当前项目的 node_modules
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
  const currentParts = current.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const c = currentParts[i] || 0;
    const l = latestParts[i] || 0;
    if (c < l) return -1;
    if (c > l) return 1;
  }
  return 0;
}

/**
 * 检查 @bolloon 相关的包是否有更新
 */
async function checkBolloonUpdates(): Promise<PackageInfo | null> {
  const packagesToCheck = [
    '@bolloon/bolloon-agent',
    '@bolloon/constraint-runtime',
  ];

  const outdatedPackages: OutdatedPackage[] = [];
  let hasUpdate = false;
  let currentVersion = '';
  let latestVersion = '';

  for (const pkg of packagesToCheck) {
    const installed = getInstalledVersion(pkg);
    console.error(`[DEBUG] getInstalledVersion(${pkg}) = ${installed}`);
    if (!installed) continue;

    // 只记录 @bolloon/bolloon-agent 的版本作为当前版本
    if (pkg === '@bolloon/bolloon-agent') {
      currentVersion = installed;
    }

    const latest = await getLatestVersion(pkg);
    console.error(`[DEBUG] getLatestVersion(${pkg}) = ${latest}`);

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
      name: '@bolloon/bolloon-agent',
      version: currentVersion,
      latest: currentVersion,
      outdated: false,
      packages: []
    };
  }

  return {
    name: '@bolloon/bolloon-agent',
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
 * 自动更新 npm 包 (legacy: 只传包名, 让 npm 按本地 semver 约束判断 — 不可靠)
 * 新代码应使用 updatePackagesWithVersion 并传 name@version
 */
async function updatePackages(packages?: string[]): Promise<UpdateResult> {
  const targets = packages && packages.length > 0 ? packages : ['@bolloon/bolloon-agent'];
  // 旧 API 没有 version, 加一个空 placeholder 走相同路径
  return updatePackagesWithVersion(targets);
}

/**
 * 自动更新 npm 包, 传 `name@version` 形式的目标让 npm install 不被本地
 * package.json 的 semver 约束卡住 (旧版只传 name 时, npm 看到本地
 * package.json 里 "^0.1.17" 已经满足就判 up to date, 永远升不上去)
 */
async function updatePackagesWithVersion(packagesWithVersion: string[]): Promise<UpdateResult> {
  // 解析 `name@version` 形式, 提取 name 用于 before/after 校验
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

  log(`\n${CYAN}📦 正在更新包...${RESET}\n`, RESET);

  try {
    execSync(args.join(' '), {
      encoding: 'utf-8',
      timeout: 300000,
      stdio: 'inherit',
      cwd: process.cwd()
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
    // 版本没变 = npm 仍判 up to date; 不当成功
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
 * 检查并自动更新（启动时调用）
 */
export async function checkAndUpdate(): Promise<{
  hasUpdate: boolean;
  info: PackageInfo | null;
  updated: boolean;
  message: string;
}> {
  // 检查是否有 --no-update 标志
  if (process.argv.includes('--no-update') || process.argv.includes('--skip-update')) {
    return { hasUpdate: false, info: null, updated: false, message: '跳过更新检查' };
  }

  // 检查环境变量
  if (process.env.BOLLOON_SKIP_UPDATE === 'true') {
    return { hasUpdate: false, info: null, updated: false, message: '跳过更新检查（环境变量）' };
  }

  log(`\n${CYAN}🔍 检查更新...${RESET}`, RESET);

  try {
    // 检查 @bolloon 包的更新
    const bolloonInfo = await checkBolloonUpdates();

    if (bolloonInfo && bolloonInfo.outdated) {
      log(`\n${YELLOW}⚠️  发现新版本: ${bolloonInfo.latest}${RESET}\n`, RESET);
      log(`   当前版本: ${bolloonInfo.version}\n`, RESET);
      log(`   最新版本: ${bolloonInfo.latest}\n\n`, RESET);

      // 自动更新
      // 关键: 把目标版本号也传过去, 否则 `npm install -g @bolloon/bolloon-agent`
      // 会按本地 package.json 的 "^0.1.17" 约束去判断, 永远装不上去
      const targetsWithVersion = bolloonInfo.packages.map(p => `${p.name}@${p.latest}`);
      const result = await updatePackagesWithVersion(targetsWithVersion);

      if (result.success) {
        log(`\n${GREEN}✅ 更新成功！请重新启动应用${RESET}\n`, RESET);

        // 提示用户重启
        log(`${YELLOW}💡 请重新运行 bolloon 以使用新版本${RESET}\n\n`, RESET);

        // 通知主进程更新完成
        process.emit('bolloon-update-complete', result);

        return {
          hasUpdate: true,
          info: bolloonInfo,
          updated: true,
          message: `已更新到 ${bolloonInfo.latest}`
        };
      } else {
        return {
          hasUpdate: true,
          info: bolloonInfo,
          updated: false,
          message: `更新失败: ${result.error}`
        };
      }
    } else {
      log(` ${GREEN}✓${RESET} 已是最新版本 (${bolloonInfo?.version || 'unknown'})\n`, RESET);
      return {
        hasUpdate: false,
        info: bolloonInfo,
        updated: false,
        message: '已是最新版本'
      };
    }
  } catch (e: any) {
    log(` ${YELLOW}⚠${RESET} 更新检查失败: ${e.message}\n`, RESET);
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