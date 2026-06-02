/**
 * Shell 命令硬护栏
 *
 * 设计原则: AI 即便拿到 shell_exec 工具, 也只能跑白名单内命令.
 * 黑名单 / 路径白名单 / 危险选项都是**人写死的**, AI 改不了这个文件.
 *
 * 这不是"软约束", 是"物理隔绝". 任何对护栏的修改都需要人手动改源码 + 重新构建.
 */

import * as path from 'path';

// 命令白名单: 只允许这些可执行文件
// 故意不开放: rm, mv, chmod, chown, dd, mkfs, sudo, su, curl, wget, ssh, scp, eval, exec, source
const COMMAND_ALLOWLIST = new Set<string>([
  'git',
  'node',
  'npm',
  'npx',
  'tsx',
  'tsc',
  'vitest',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'echo',  // 仅用于空操作测试
  'pwd',
  'date',
  'mkdir', // 仅在沙箱内
  'touch', // 仅在沙箱内
]);

// 危险参数黑名单 (即使命令在白名单内, 这些参数也拒)
const ARG_DENYLIST: RegExp[] = [
  // git 危险操作
  /^\s*push\s+(-f|--force(-with-lease)?)\b/i,
  /^\s*push\s+origin\s+master\b/i,
  /^\s*push\s+origin\s+main\b/i,
  /^\s*reset\s+--hard\b/i,
  /^\s*clean\s+-fd?\b/i,
  // node 危险
  /^\s*--inspect\b/,
  /^\s*eval\b/i,
  /^\s*-e\b/,  // node -e "code" - 避免 inline 注入
  // shell 元字符 (任何管道 / 重定向 / 子 shell)
  /[|&;`$()<>]/,
  /\brm\s+-rf?\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  // 跨目录逃逸
  /\.\.\//,
  /^\//,  // 绝对路径
  // Windows 路径分隔 (即使在 git bash 下也禁用)
  /^[a-zA-Z]:\\/,
];

// 禁区路径: AI 改这些目录里的文件, 一律拒
// 这些路径**绝对不**通过 shell_exec 写入
const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /(^|\/)src\/agents\/pi-sdk\.ts$/,
  /(^|\/)src\/agents\/shell-guard\.ts$/,
  /(^|\/)src\/agents\/shell-tool\.ts$/,
  /(^|\/)src\/heartbeat\//,
  /(^|\/)src\/network\//,
  /(^|\/)src\/pi-ecosystem-judgment\//,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.git\//,
  /(^|\/)\.bolloon\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
];

// 允许的写操作命令参数前缀 (git checkout -b / git add 之类)
const ALLOWED_WRITE_OPERATIONS = new Set<string>([
  'git checkout -b',
  'git add',
  'git diff',
  'git log',
  'git status',
  'git rev-parse',
  'git apply',  // 沙箱内 patch
  'git commit -m',  // 沙箱分支
  'git branch -D',  // 仅沙箱分支
  'git format-patch',
  'mkdir -p',
  'touch',
  'cat >',  // 沙箱写入
]);

export interface ShellCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 检查一条命令是否被允许
 */
export function checkCommand(cmd: string, args: string[]): ShellCheckResult {
  const fullCmd = [cmd, ...args].join(' ').trim();

  // 1. 命令必须在白名单
  if (!COMMAND_ALLOWLIST.has(cmd)) {
    return {
      allowed: false,
      reason: `命令 '${cmd}' 不在白名单. 允许: ${Array.from(COMMAND_ALLOWLIST).join(', ')}`
    };
  }

  // 2. 参数逐个检查
  for (const arg of args) {
    for (const pattern of ARG_DENYLIST) {
      if (pattern.test(arg)) {
        return { allowed: false, reason: `参数 '${arg}' 命中黑名单模式 ${pattern}` };
      }
    }
  }

  // 3. 完整命令再过一遍 (防止 args 拼接绕过)
  for (const pattern of ARG_DENYLIST) {
    if (pattern.test(fullCmd)) {
      return { allowed: false, reason: `命令整体命中黑名单模式 ${pattern}` };
    }
  }

  return { allowed: true };
}

/**
 * 检查写入路径是否在禁区
 */
export function checkWritePath(targetPath: string): ShellCheckResult {
  const normalized = path.normalize(targetPath).replace(/\\/g, '/');
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      return { allowed: false, reason: `路径 '${targetPath}' 命中禁区 ${pattern}` };
    }
  }
  return { allowed: true };
}

/**
 * 沙箱工作目录
 * shell_exec 默认 cwd 锁在这里, 防止 AI 跑到 /etc /root 之类的地方
 */
export const SHELL_SANDBOX_CWD = path.resolve(process.cwd(), '.bolloon-shell-sandbox');

/**
 * 自改分支名前缀 - 强制 AI 在这个前缀下开分支
 */
export const SELF_IMPROVE_BRANCH_PREFIX = 'agent/self-imp-';

/**
 * 冷却期: 同一类事件触发自改后, N 小时内不再触发
 */
export const SELF_IMPROVE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 小时
