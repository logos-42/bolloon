/**
 * auto-update.ts — 启动时后台检查的**薄适配层** (2026-09-19 重写)
 *
 * 这里以前是"多套更新逻辑中的一套": 自己拼 package.json 路径、自己打 registry、
 * 自己 `npm install -g`、自己重启。现在它只剩两件事:
 *   ① 启动时决定"要不要检查" (开关 / 节流 / 显式屏蔽)
 *   ② 把结论**通知**给用户
 * 真正的检查 / 计划 / 执行全在 `update-manager.ts` —— 一份逻辑, 一个事实。
 *
 * **行为变更 (刻意, 2026-09-19)**: 旧默认是"发现新版本 → 自动安装 → 自动重启"。
 *   新默认是"发现新版本 → 只通知"。理由: Bolloon 有长期运行 / Supervisor / 持久化任务 /
 *   支付恢复, 自动替换运行时可能打断正在执行的 Goal。要自动装需显式打开
 *   `config.json` 的 `autoInstall: true` (再加 `autoRestart: true` 才自动重启),
 *   或用 `BOLLOON_AUTO_UPDATE=1` 临时覆盖。
 */

import {
  checkForUpdate, applyUpdate, compareVersions, type CheckResult,
} from './update-manager.js';
import { readUpdatePrefs } from './update-state.js';
import { resolveBolloonHome } from '../setup/setup-store.js';
import { PKG_NAME, CONSTRAINT_PKG_NAME } from './version-info.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

/** 旧结构 (向后兼容外部调用者), 内部由 CheckResult 派生 */
export interface PackageInfo {
  name: string;
  version: string;
  latest: string;
  outdated: boolean;
  packages: OutdatedPackage[];
}
export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  location: string;
}
export interface UpdateResult {
  success: boolean;
  updated: boolean;
  message: string;
  updatedPackages?: string[];
  error?: string;
}

/** 2026-08-07: CLI 交互模式下静音后台通知 (避免污染 TUI 屏幕) */
let notifyQuiet = false;
export function setNotifyQuiet(v: boolean): void {
  notifyQuiet = v;
}

/** 通知用户。用 stderr, 避免交互式 CLI 模式下 stdout 被 Ink 接管/吞掉。 */
function notify(msg: string, color: string = RESET) {
  if (notifyQuiet) return;
  process.stderr.write(`${color}${msg}${RESET}\n`);
}

export function checkResultToPackageInfo(r: CheckResult): PackageInfo {
  const outdated = r.status === 'update_available' && !!r.latestVersion;
  return {
    name: PKG_NAME,
    version: r.currentVersion,
    latest: r.latestVersion || r.currentVersion,
    outdated,
    packages: outdated
      ? [{
        name: PKG_NAME,
        current: r.currentVersion,
        wanted: r.latestVersion!,
        latest: r.latestVersion!,
        location: r.installMethod,
      }]
      : [],
  };
}

/**
 * 启动时的检查 (后台调用)。
 *
 * @param opts.force      忽略节流与开关强制检查 (手动触发)
 * @param opts.onUpdated  已安装新版本且允许自动重启时调用 (调用方给模式相关的重启逻辑);
 *                        未提供或 autoRestart=false 时只提示用户手动重启。
 */
export async function checkAndUpdate(opts: { force?: boolean; onUpdated?: () => void } = {}): Promise<{
  hasUpdate: boolean;
  info: PackageInfo | null;
  updated: boolean;
  message: string;
}> {
  const home = resolveBolloonHome();
  const blocked = process.argv.includes('--no-update')
    || process.argv.includes('--skip-update')
    || process.env.BOLLOON_SKIP_UPDATE === '1'
    || process.env.BOLLOON_SKIP_UPDATE === 'true';
  if (blocked) {
    return { hasUpdate: false, info: null, updated: false, message: '跳过更新检查（已显式禁用）' };
  }

  const prefs = await readUpdatePrefs({ home });
  const explicit = opts.force
    || process.argv.includes('--update-check')
    || process.argv.includes('--update-now')
    || process.argv.includes('--allow-update');

  if (!prefs.checkUpdates && !explicit) {
    return {
      hasUpdate: false, info: null, updated: false,
      message: '更新检查已关闭 (config.json checkUpdates=false; BOLLOON_SKIP_UPDATE=1 也可临时关闭)',
    };
  }

  let r: CheckResult;
  try {
    r = await checkForUpdate({ home, force: !!explicit });
  } catch (e: any) {
    // 检查失败**绝不**报"已是最新"
    notify(`⚠ 更新检查失败: ${e?.message || e}`, YELLOW);
    return { hasUpdate: false, info: null, updated: false, message: `检查失败: ${e?.message || e}` };
  }

  const info = checkResultToPackageInfo(r);

  switch (r.status) {
    case 'up_to_date':
      notify(`✓ 已是最新版本 (${r.currentVersion})`, GREEN);
      return { hasUpdate: false, info, updated: false, message: '已是最新版本' };

    case 'update_available': {
      notify(`⚠ 发现新版本: ${r.currentVersion} → ${r.latestVersion}`, YELLOW);
      if (!prefs.autoInstall) {
        notify('  当前设置为**只通知不自动安装** (autoInstall=false)。更新: bolloon update (直接执行; 只看计划用 --dry-run)', CYAN);
        return {
          hasUpdate: true, info, updated: false,
          message: `发现新版 ${r.latestVersion}（未自动安装；运行 bolloon update 更新）`,
        };
      }
      notify('  自动安装已开启 (autoInstall=true)，执行更新...', CYAN);
      const res = await applyUpdate({
        home, strategy: 'now',
        onStage: notifyQuiet ? undefined : (s, d) => notify(`  [${s}] ${d}`),
      });
      if (res.ok) {
        try { process.emit('bolloon-update-complete', res); } catch { /* 忽略 */ }
        if (opts.onUpdated && prefs.autoRestart) {
          notify(`✅ 已更新到 ${res.to}，即将自动重启以应用新版本...`, GREEN);
          // 调用方执行模式相关的重启 (Electron: app.relaunch(); Node: detached spawn)。
          // 预期不会返回; 兜底 exit 防"重启后还在旧进程里"。
          opts.onUpdated();
          process.exit(0);
        }
        notify(`✅ 已更新到 ${res.to}！请重新启动应用`, GREEN);
        return { hasUpdate: true, info, updated: true, message: `已更新到 ${res.to}` };
      }
      notify(`⚠ 更新未成功 (${res.stage}): ${res.reason}`, YELLOW);
      notify(`  旧版本仍在 (${res.from})，可继续使用；详情: bolloon update status`, YELLOW);
      return { hasUpdate: true, info, updated: false, message: `更新失败: ${res.reason}` };
    }

    // 关键: 网络失败**绝不**显示"已是最新"
    case 'offline':
      notify('⚠ 无法检查更新: 离线 (连不上 npm registry) — 这不代表是最新版', YELLOW);
      return { hasUpdate: false, info, updated: false, message: '更新检查失败（离线）' };

    case 'registry_unavailable':
      notify(`⚠ 无法检查更新: registry 不可用 (${r.reason || '未知'}) — 这不代表是最新版`, YELLOW);
      return { hasUpdate: false, info, updated: false, message: '更新检查失败（registry 不可用）' };

    case 'unsupported_installation':
      return { hasUpdate: false, info, updated: false, message: `当前安装方式不支持自动更新 (${r.installMethod})` };

    case 'local_version_unknown':
      notify('⚠ 读不到本地版本，跳过更新判断', YELLOW);
      return { hasUpdate: false, info, updated: false, message: '读不到本地版本' };

    case 'check_skipped':
    default:
      return { hasUpdate: false, info, updated: false, message: '距上次检查不足间隔，跳过' };
  }
}

/** 仅检查, 不安装 (兼容旧调用点; 结论来自同一个 Update Manager)。 */
export async function checkForUpdates(): Promise<PackageInfo | null> {
  const r = await checkForUpdate({ home: resolveBolloonHome(), force: true });
  return checkResultToPackageInfo(r);
}

/** 手动执行更新 (兼容旧调用点; 现在走同一条 applyUpdate 流水线)。 */
export async function performUpdate(_packages?: string[]): Promise<UpdateResult> {
  const home = resolveBolloonHome();
  const res = await applyUpdate({ home, strategy: 'now' });
  return {
    success: res.ok,
    updated: res.ok,
    message: res.ok ? `已更新到 ${res.to}` : (res.reason || '更新失败'),
    updatedPackages: res.ok ? [PKG_NAME, CONSTRAINT_PKG_NAME] : [],
    error: res.ok ? undefined : res.reason,
  };
}

/** 版本比较 (旧导出, 转发到唯一实现)。 */
export function compareVersionsLegacy(a: string, b: string): -1 | 0 | 1 {
  return compareVersions(a, b);
}

// CLI 入口: `node dist/utils/auto-update.js [check|update]`
if (process.argv[1]?.includes('auto-update')) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === 'check') {
      console.log(JSON.stringify(await checkForUpdates(), null, 2));
    } else if (cmd === 'update') {
      console.log(JSON.stringify(await performUpdate(), null, 2));
    } else {
      console.log(JSON.stringify(await checkAndUpdate({ force: true }), null, 2));
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
