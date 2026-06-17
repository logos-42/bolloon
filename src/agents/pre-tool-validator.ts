/**
 * Pre-Tool Validator — 4 步链式校验
 *
 * 严格对齐 Claude Code 论文 PreToolUse 4 步:
 *   1. modeGate(tool, mode)         — bypassPermissions → 直接放行(除 shell)
 *   2. blacklistGate(tool, args)    — 6 模式黑名单 (recursive rm, force push, dd 等)
 *   3. shellGuardGate(tool, args)   — **完整** shell-guard (checkCommand + checkWritePath), 永远生效
 *   4. schemaGate(tool, args)       — 第一版 stub: always allow (后续接入 tool-gate.ts)
 *
 * 每步独立 try/catch, 失败 = 跳过该步, 不阻塞 (与现有 lifecycle-hooks 风格一致)
 *
 * 失败静默: 任何 step 异常 → console.warn + 继续下一 step, 不抛错
 */

import { shouldRunBlacklist, isShellTool, type PermissionMode } from './permission-mode.js';
import { checkCommand, checkWritePath } from './shell-guard.js';

export interface PreToolResult {
  allowed: boolean;
  reason?: string;
  /** 哪一步拒绝的 (供 audit log) */
  rejectedBy?: 'mode' | 'blacklist' | 'shell-guard' | 'schema';
  mode: PermissionMode;
  /** bypassPermissions 时记录, 区分 "完全放行" vs "shell-guard 仍生效" */
  shellGuardRetained?: boolean;
}

const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\s+\//, reason: '禁止递归删除根目录' },
  { re: /\bgit\s+push\s+.*--force\b/, reason: '禁止 force push' },
  { re: /\brm\s+-rf\s+~\//, reason: '禁止递归删除 home' },
  { re: /\bdd\s+if=.*\s+of=\/dev\//, reason: '禁止 dd 覆盖块设备' },
  { re: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: '禁止 curl|sh 直执行' },
  { re: />\s*\/dev\/sd[a-z]/, reason: '禁止写裸设备' },
];

/**
 * Step 1: modeGate
 * - bypassPermissions + 非 shell → 直接放行 (但保留 shellGuardRetained 标记)
 * - 其他 → 继续
 */
function modeGate(tool: string, mode: PermissionMode): PreToolResult | null {
  try {
    if (mode === 'bypassPermissions' && !isShellTool(tool)) {
      return { allowed: true, mode, rejectedBy: undefined, shellGuardRetained: false };
    }
    return null;  // 不在这一步决定
  } catch (err) {
    console.warn('[pre-tool] modeGate failed (silent):', err);
    return null;
  }
}

/**
 * Step 2: blacklistGate
 * 6 模式黑名单 (现有 lifecycle-hooks.ts 行为)
 */
function blacklistGate(tool: string, args: Record<string, unknown>, mode: PermissionMode): PreToolResult | null {
  try {
    if (!isShellTool(tool)) return null;
    const cmd = String(args.command || args.cmd || '');
    if (!cmd) return null;
    for (const { re, reason } of DANGEROUS_PATTERNS) {
      if (re.test(cmd)) {
        return { allowed: false, reason, rejectedBy: 'blacklist', mode };
      }
    }
    return null;
  } catch (err) {
    console.warn('[pre-tool] blacklistGate failed (silent):', err);
    return null;
  }
}

/**
 * Step 3: shellGuardGate
 * 永远跑 (绕过 mode), 是 bolloon 自身的安全底线
 *
 * 接完整 shell-guard.ts (checkCommand + checkWritePath):
 *   - checkCommand 走命令白名单 + 参数黑名单 (允许列表默认 git/node/npm/npx/tsx/tsc/vitest 等)
 *   - checkWritePath 走路径黑名单 (硬编码: pi-sdk.ts, shell-guard.ts, .env, .git/, .bolloon/, package.json, dist/ 等)
 *
 * 失败静默: 任何异常 → 跳过这步, 不阻塞
 */
function shellGuardGate(tool: string, args: Record<string, unknown>, mode: PermissionMode): PreToolResult | null {
  try {
    if (!isShellTool(tool)) return null;

    // 1. 命令检查 (含白名单 + arg 黑名单)
    const cmd = String(args.command || args.cmd || '');
    let bin = '';
    if (cmd) {
      // shell-guard 期望 (cmd, args[]) 形式
      // 简单 split: 第一个 token 是 cmd, 之后是 args
      const parts = cmd.split(/\s+/).filter(Boolean);
      bin = parts[0] || '';
      const rest = parts.slice(1);
      if (bin) {
        const cmdResult = checkCommand(bin, rest);
        if (!cmdResult.allowed) {
          return {
            allowed: false,
            reason: cmdResult.reason,
            rejectedBy: 'shell-guard',
            mode,
            shellGuardRetained: true,
          };
        }
      }
    }

    // 2. 写路径检查 — 从 2 个来源抽:
    //    a) 结构化字段 (args.path / args.target / args.file)
    //    b) 命令字符串里的 token (老测试传 args.command='cat pi-sdk.ts' 时也能拦)
    const pathCandidates: string[] = [];
    const structured = String(
      args.path || args.target || args.file || args.targetPath || args.destination || ''
    );
    if (structured) pathCandidates.push(structured);
    if (cmd) {
      // 简单 tokenize: 按空白切, 取不含 shell 元字符的 token
      const tokens = cmd.split(/\s+/).filter((t) => t && !/^[|>;&`$()<]/.test(t));
      for (const t of tokens) {
        if (t !== bin) pathCandidates.push(t);  // 跳过命令本身
      }
    }
    // 纯文件名 denylist (兜底 — checkWritePath 的 regex 要求 /src/xxx/ 锚定, 纯文件名拦不到)
    // 只对**写/删/改**类命令生效 (rm, cp, mv, sed -i, echo >); 读类命令 (cat, head, tail, ls) 跳过
    const READ_BINS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'echo', 'pwd', 'date', 'mkdir', 'touch', 'find', 'grep', 'git', 'node', 'npm', 'npx', 'tsx', 'tsc', 'vitest']);
    const FILENAME_DENYLIST = [
      // 2026-06-17 (Q2-B): 解除 pi-sdk.ts — agent 可改自己源码
      'shell-guard.ts', 'shell-tool.ts',
      '.env', 'package.json', 'tsconfig.json',
    ];
    const isReadOperation = READ_BINS.has(bin);
    for (const candidate of pathCandidates) {
      // 2a. checkWritePath 只对写操作调用 (读类命令绕开, 避免 cat pi-sdk.ts 误拦)
      if (!isReadOperation) {
        const pathResult = checkWritePath(candidate);
        if (!pathResult.allowed) {
          return {
            allowed: false,
            reason: pathResult.reason,
            rejectedBy: 'shell-guard',
            mode,
            shellGuardRetained: true,
          };
        }
      }
      // 2b. 纯文件名兜底 — 只对写操作生效
      if (!isReadOperation) {
        const baseName = candidate.split('/').pop() || '';
        if (FILENAME_DENYLIST.includes(baseName)) {
          return {
            allowed: false,
            reason: `shell-guard: 禁止 ${bin} 操作 ${candidate} (命中文件名硬编码黑名单)`,
            rejectedBy: 'shell-guard',
            mode,
            shellGuardRetained: true,
          };
        }
      }
    }

    return null;  // 通过
  } catch (err) {
    console.warn('[pre-tool] shellGuardGate failed (silent):', err);
    return null;
  }
}

/**
 * Step 4: schemaGate
 * 第一版 stub: always allow
 */
function schemaGate(_tool: string, _args: Record<string, unknown>, mode: PermissionMode): PreToolResult | null {
  return null;  // 不在这一步决定
}

/**
 * 主入口: 4 步链式, 任何一步拒绝 → 返回, 否则最终放行
 */
export function validatePreToolUse(
  tool: string,
  args: Record<string, unknown>,
  mode: PermissionMode
): PreToolResult {
  const steps = [
    () => modeGate(tool, mode),
    () => blacklistGate(tool, args, mode),
    () => shellGuardGate(tool, args, mode),
    () => schemaGate(tool, args, mode),
  ];
  for (const step of steps) {
    const result = step();
    if (result && !result.allowed) return result;
  }
  // 全部通过 → 放行
  // bypassPermissions + shell 走到这里 = shellGuardGate 已经放过, 但要标记 shellGuardRetained
  return {
    allowed: true,
    mode,
    rejectedBy: undefined,
    shellGuardRetained: isShellTool(tool),
  };
}

// ============================================================
// 测试钩子
// ============================================================

export function _resetValidatorForTest(): void {
  // validator 是 pure, 保留 API 一致
}
