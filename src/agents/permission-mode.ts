/**
 * Permission Mode — 3 种模式枚举 + 解析
 *
 * 设计: 严格对齐 Claude Code 论文 3 种 mode (default / acceptEdits / bypassPermissions)
 * 论文第 7 种 (plan/dontAsk/bubble) bolloon 暂不引入, 减少 API surface.
 *
 * 关键设计: shell-guard **不受** mode 影响
 *   - 路径黑名单 (.bolloon/, pi-sdk.ts, shell-guard.ts, .env, .git/ 等) 永远生效
 *   - 命令 allowlist 默认: git/node/npm/npx/tsx/tsc/vitest/cat/head/tail/wc/ls/echo/pwd/date/mkdir/touch 永远生效
 *   - 即使用户设 bypassPermissions, shell 类工具仍走 shell-guard
 *
 * 失败静默: 任何异常 → 返回 'default' (向后兼容)
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
] as const;

export interface ResolveOptions {
  /** BootstrapOptions / onPreToolUse 调用处透传 */
  permissionMode?: PermissionMode;
}

/**
 * 解析当前 permission mode.
 * 优先级 (由高到低):
 *   1. opts.permissionMode          (BootstrapOptions 显式传入)
 *   2. runtime override             (~/.bolloon/sessions/permission-mode.json, UI 设置)
 *   3. env BOLLOON_PERM_MODE        (环境变量)
 *   4. 'default'                    (兜底)
 *
 * 非法值 → fallback 'default', console.warn
 * 失败静默: 任何异常 → 'default' (不阻塞主对话)
 */
export function resolvePermissionMode(opts?: ResolveOptions): PermissionMode {
  try {
    if (opts?.permissionMode && ALL_PERMISSION_MODES.includes(opts.permissionMode)) {
      return opts.permissionMode;
    }
    // runtime override (UI 设置, 存 ~/.bolloon/sessions/permission-mode.json)
    const override = readRuntimeOverride();
    if (override) {
      return override;
    }
    const env = process.env.BOLLOON_PERM_MODE;
    if (env === 'default' || env === 'acceptEdits' || env === 'bypassPermissions') {
      return env;
    }
    if (env && env.length > 0) {
      console.warn(`[permission-mode] unknown BOLLOON_PERM_MODE="${env}", fallback to "default"`);
    }
    return 'default';
  } catch (err) {
    console.warn('[permission-mode] resolvePermissionMode failed (silent, using default):', err);
    return 'default';
  }
}

/**
 * 读 runtime override 文件 (UI 设的 mode).
 * 失败静默: 任何异常 → null (回到 env/default)
 */
function readRuntimeOverride(): PermissionMode | null {
  try {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const file = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'permission-mode.json'
    );
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.mode === 'string' && ALL_PERMISSION_MODES.includes(obj.mode as any)) {
      return obj.mode as PermissionMode;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 工具名分类: 是不是"编辑"类 (受 acceptEdits 模式影响)
 * 简单按前缀, 不做完整注册表
 */
export function isEditTool(toolName: string): boolean {
  const lc = toolName.toLowerCase();
  return lc.startsWith('edit_') || lc.startsWith('write_') || lc === 'str_replace' || lc === 'create_file' || lc === 'present_files';
}

/**
 * 工具名分类: 是不是"shell"类 (永远走 shell-guard, 不受 mode 影响)
 */
export function isShellTool(toolName: string): boolean {
  const lc = toolName.toLowerCase();
  return lc === 'shell' || lc === 'shell_exec' || lc === 'bash';
}

/**
 * 判断当前 mode + tool 的最终是否需要走 blacklist
 *
 * 逻辑表:
 *   - shell 工具: 永远走 blacklist (shell-guard 接管)
 *   - bypassPermissions 模式: 非 shell 全部放行
 *   - acceptEdits 模式: edit_* / write_* 类跳过 blacklist
 *   - default 模式: 全部走 blacklist
 */
export function shouldRunBlacklist(toolName: string, mode: PermissionMode): boolean {
  if (isShellTool(toolName)) return true;  // shell-guard 永远跑
  if (mode === 'bypassPermissions') return false;
  if (mode === 'acceptEdits' && isEditTool(toolName)) return false;
  return true;  // default
}

// ============================================================
// 测试钩子
// ============================================================

export function _resetPermissionModeForTest(): void {
  // 解析只读 env, 无内部状态, 保留 API 一致
}
