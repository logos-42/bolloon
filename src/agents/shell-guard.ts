/**
 * Shell 命令硬护栏 (策略可配置版)
 *
 * 设计原则:
 *   1. 白名单/黑名单从 ~/.bolloon/self-improve-policy.json 加载
 *   2. 加载失败或缺失时, 使用**硬编码兜底** (永远拒绝 = 最安全)
 *   3. 策略文件在禁区里, AI 即便拿到 shell_exec 也改不了
 *   4. 提供 API 端点供**人**热加载策略, 并写审计日志
 *
 * 策略文件 schema (self-improve-policy.json):
 * {
 *   "version": 1,
 *   "commandAllowlist": ["git", "npm", "tsc", "vitest", "cat", "ls", "..."],
 *   "commandDenylist": ["rm", "mv", "chmod", "sudo", "su", "curl", "wget"],
 *   "pathAllowlist": [
 *     "src/web/client.ts",
 *     "src/agents/workflow-engine.ts",
 *     "*.md",
 *     "docs/**"
 *   ],
 *   "pathDenylist": [
 *     "src/agents/pi-sdk.ts",
 *     "src/agents/shell-guard.ts",
 *     "src/agents/shell-tool.ts",
 *     "src/heartbeat/**",
 *     "src/network/**",
 *     "src/pi-ecosystem-judgment/**",
 *     "package.json",
 *     ".env*",
 *     ".git/**",
 *     "dist/**",
 *     "node_modules/**"
 *   ],
 *   "cooldownMs": 21600000,
 *   "sandboxCwd": ".bolloon-shell-sandbox",
 *   "branchPrefix": "agent/self-imp-"
 * }
 *
 * 匹配规则:
 *   1. 路径先查 denylist (命中即拒), 再查 allowlist (没命中即拒)
 *   2. 命令先查 denylist (命中即拒), 再查 allowlist (没命中即拒)
 *   3. 通配符: * 匹配单层文件名, ** 匹配任意层级
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// 硬编码兜底 (策略文件读不到时, 用这套)
// 这是**最后一道防线** - AI 即便能改 ~/.bolloon/ 也没法删这个常量
// ============================================================================
const FALLBACK_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  'git', 'node', 'npm', 'npx', 'tsx', 'tsc', 'vitest',
  'cat', 'head', 'tail', 'wc', 'ls', 'echo', 'pwd', 'date',
  'mkdir', 'touch',
  // M3.5 (2026-06-17): Windows cmd 内置命令 (cmd.exe shell 模式)
  //   'cat'/'ls' 在 Git Bash 才存在, Windows 原生 cmd 用 'type'/'dir'
  'type', 'dir', 'cd', 'where', 'set', 'echo.',
]);

const FALLBACK_PATH_ALLOWLIST: readonly string[] = [
  // 自由区: AI 可以改
  'src/web/client.ts',
  'src/web/style.css',
  'src/agents/workflow-engine.ts',
  'src/agents/workflow-pivot-loop.ts',
  'src/agents/constraint-layer.ts',
  'src/test/**',
  'docs/**',
  '*.md',
  'README.md'
];

const FALLBACK_PATH_DENYLIST: ReadonlyArray<RegExp> = [
  // 2026-06-17 (Q2-B): 解除 pi-sdk.ts denylist — 现在允许 agent 改自己源码以自进化
  //   原屏蔽理由: "LLM 抽象层" — 但 owner 决定 auto-evolve 需要这个能力
  //   仍保留: shell-guard.ts / shell-tool.ts — 改这两个等于改护栏本身, fail-open 风险太高
  /(^|\/)src\/agents\/shell-guard\.ts$/,    // 护栏本身
  /(^|\/)src\/agents\/shell-tool\.ts$/,     // shell 工具实现
  /(^|\/)src\/heartbeat\//,                // 心跳
  /(^|\/)src\/network\//,                  // P2P / libp2p / iroh
  /(^|\/)src\/pi-ecosystem-judgment\//,    // judgment 系统
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.git\//,
  /(^|\/)\.bolloon\//,                     // 策略文件 / sessions / persona
  /(^|\/)dist\//,
  // 2026-06-17: node_modules 不再 denylist, 因为 M3.4 自动 commit 阶段需要 npm install / npx vitest
  //   通过 allowlist 限定 agent 只能 npm install, 不能 rm node_modules (shell arg denylist 仍禁 rm -rf)
];

const FALLBACK_ARG_DENYLIST: ReadonlyArray<RegExp> = [
  /^\s*push\s+(-f|--force)/i,
  /^\s*push\s+origin\s+(master|main)\b/i,
  /^\s*reset\s+--hard\b/i,
  /^\s*clean\s+-fd?\b/i,
  /^\s*--inspect\b/,
  /[|&;`$()<>]/,                           // shell 元字符
  /\brm\s+-rf?\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\.\.\//,                                 // 路径逃逸
  /^\//,                                    // 绝对路径
  /^[a-zA-Z]:\\/,                           // Windows 绝对路径
];

// ============================================================================
// 策略加载
// ============================================================================

export interface SelfImprovePolicy {
  version: number;
  commandAllowlist: string[];
  commandDenylist?: string[];
  pathAllowlist: string[];
  pathDenylist: string[];
  cooldownMs: number;
  sandboxCwd: string;
  branchPrefix: string;
}

let cachedPolicy: SelfImprovePolicy | null = null;
let policyLoadedAt: number = 0;
const POLICY_TTL_MS = 60_000; // 60 秒缓存 (避免每次 shell_exec 都读盘)

const POLICY_PATH = path.join(os.homedir(), '.bolloon', 'self-improve-policy.json');
const POLICY_AUDIT_PATH = path.join(os.homedir(), '.bolloon', 'self-improve-audit.log');

/**
 * 默认策略模板 - 第一次启动时写到磁盘
 */
function getDefaultPolicy(): SelfImprovePolicy {
  return {
    version: 1,
    commandAllowlist: Array.from(FALLBACK_COMMAND_ALLOWLIST),
    pathAllowlist: [...FALLBACK_PATH_ALLOWLIST],
    pathDenylist: FALLBACK_PATH_DENYLIST.map(r => r.source),
    cooldownMs: 6 * 60 * 60 * 1000,
    sandboxCwd: '.bolloon-shell-sandbox',
    branchPrefix: 'agent/self-imp-'
  };
}

/**
 * 加载策略 (有缓存)
 * 加载失败返回 null, 调用方应回退到硬编码兜底
 */
export function loadPolicy(forceReload = false): SelfImprovePolicy | null {
  const now = Date.now();
  if (!forceReload && cachedPolicy && now - policyLoadedAt < POLICY_TTL_MS) {
    return cachedPolicy;
  }

  try {
    if (!fs.existsSync(POLICY_PATH)) {
      // 第一次启动: 写入默认策略
      const dir = path.dirname(POLICY_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(POLICY_PATH, JSON.stringify(getDefaultPolicy(), null, 2));
      console.log(`[shell-guard] 已生成默认策略: ${POLICY_PATH}`);
    }

    const raw = fs.readFileSync(POLICY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SelfImprovePolicy;

    // 极简 schema 校验
    if (!parsed.version || !Array.isArray(parsed.commandAllowlist) || !Array.isArray(parsed.pathAllowlist) || !Array.isArray(parsed.pathDenylist)) {
      console.warn('[shell-guard] 策略文件 schema 不对, 用硬编码兜底');
      return null;
    }

    cachedPolicy = parsed;
    policyLoadedAt = now;
    return parsed;
  } catch (err) {
    console.warn('[shell-guard] 策略文件加载失败, 用硬编码兜底:', err);
    return null;
  }
}

/**
 * 审计日志: 记录所有被拒/被允许的 shell_exec 调用
 */
export function auditShellCall(
  result: 'allowed' | 'denied',
  cmd: string,
  args: string[],
  reason?: string,
  targetPath?: string
): void {
  try {
    const dir = path.dirname(POLICY_AUDIT_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      result,
      cmd,
      args,
      reason,
      targetPath
    }) + '\n';
    fs.appendFileSync(POLICY_AUDIT_PATH, line);
  } catch {
    // 审计失败不阻塞
  }
}

// ============================================================================
// 检查逻辑
// ============================================================================

export interface ShellCheckResult {
  allowed: boolean;
  reason?: string;
  /** 触发的是哪条规则 (denylist / allowlist / fallback) */
  matchedBy?: 'cmd-denylist' | 'cmd-allowlist' | 'arg-denylist' | 'path-denylist' | 'path-allowlist' | 'fallback-deny';
}

/**
 * 把通配符模式编译成正则
 * *  -> [^/]*
 * ** -> .*
 */
function compileGlob(pattern: string): RegExp {
  // 转义正则元字符, 但保留 * 和 **
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * 检查命令
 */
export function checkCommand(cmd: string, args: string[]): ShellCheckResult {
  const policy = loadPolicy();
  const fullCmd = [cmd, ...args].join(' ').trim();

  // ---- 1. 命令黑名单 (策略里有的话) ----
  if (policy?.commandDenylist) {
    for (const denied of policy.commandDenylist) {
      if (cmd === denied || fullCmd.startsWith(denied)) {
        auditShellCall('denied', cmd, args, `命中 commandDenylist: ${denied}`);
        return { allowed: false, reason: `命令 '${cmd}' 命中策略黑名单: ${denied}`, matchedBy: 'cmd-denylist' };
      }
    }
  }

  // ---- 2. 命令白名单 ----
  const allowSet = policy
    ? new Set(policy.commandAllowlist)
    : FALLBACK_COMMAND_ALLOWLIST as Set<string>;
  if (!allowSet.has(cmd)) {
    auditShellCall('denied', cmd, args, `命令 '${cmd}' 不在白名单`);
    return {
      allowed: false,
      reason: `命令 '${cmd}' 不在白名单. 允许: ${Array.from(allowSet).join(', ')}`,
      matchedBy: policy ? 'cmd-allowlist' : 'fallback-deny'
    };
  }

  // ---- 3. 参数黑名单 (策略文件 + 硬编码兜底都查) ----
  const argPatterns = policy
    ? [
        ...FALLBACK_ARG_DENYLIST,
        // 策略里没有专门的 argDenylist 字段, 复用 pathDenylist 模式不太合适
        // 故意**不**让用户在策略里加 arg denylist - 防止 AI 删自己的 arg 限制
      ]
    : FALLBACK_ARG_DENYLIST;

  for (const arg of args) {
    for (const pattern of argPatterns) {
      if (pattern.test(arg)) {
        auditShellCall('denied', cmd, args, `参数 '${arg}' 命中黑名单`);
        return { allowed: false, reason: `参数 '${arg}' 命中黑名单模式 ${pattern}`, matchedBy: 'arg-denylist' };
      }
    }
  }

  // 整条命令再过一遍
  for (const pattern of argPatterns) {
    if (pattern.test(fullCmd)) {
      auditShellCall('denied', cmd, args, `整条命令命中黑名单`);
      return { allowed: false, reason: `整条命令命中黑名单模式 ${pattern}`, matchedBy: 'arg-denylist' };
    }
  }

  auditShellCall('allowed', cmd, args);
  return { allowed: true };
}

/**
 * 检查路径
 *
 * 逻辑:
 *   1. denylist 优先: 命中即拒 (用硬编码兜底正则)
 *   2. allowlist: 命中放行
 *   3. 都不命中: 拒 (默认拒绝)
 */
export function checkWritePath(targetPath: string): ShellCheckResult {
  const policy = loadPolicy();
  const normalized = path.normalize(targetPath).replace(/\\/g, '/');

  // ---- 1. 路径黑名单 (硬编码兜底不可绕过) ----
  // 即便策略文件里 denylist 是空的, 硬编码兜底永远生效
  const hardcodedDenylist = FALLBACK_PATH_DENYLIST;
  for (const pattern of hardcodedDenylist) {
    if (pattern.test(normalized)) {
      auditShellCall('denied', '', [], `路径 '${targetPath}' 命中硬编码禁区`, targetPath);
      return { allowed: false, reason: `路径 '${targetPath}' 命中硬编码禁区 ${pattern}`, matchedBy: 'fallback-deny' };
    }
  }

  // 策略文件里的额外 denylist
  if (policy?.pathDenylist) {
    for (const patternStr of policy.pathDenylist) {
      try {
        const regex = compileGlob(patternStr);
        if (regex.test(normalized)) {
          auditShellCall('denied', '', [], `路径 '${targetPath}' 命中策略 denylist`, targetPath);
          return { allowed: false, reason: `路径 '${targetPath}' 命中策略 denylist: ${patternStr}`, matchedBy: 'path-denylist' };
        }
      } catch {
        // 编译失败的模式跳过
      }
    }
  }

  // ---- 2. 路径白名单 (来自策略或兜底) ----
  const allowlist = policy?.pathAllowlist || FALLBACK_PATH_ALLOWLIST;
  for (const patternStr of allowlist) {
    try {
      const regex = compileGlob(patternStr);
      if (regex.test(normalized)) {
        auditShellCall('allowed', '', [], undefined, targetPath);
        return { allowed: true, matchedBy: 'path-allowlist' };
      }
    } catch {
      // 编译失败的模式跳过
    }
  }

  // 都不命中: 默认拒绝
  auditShellCall('denied', '', [], `路径 '${targetPath}' 不在任何 allowlist 中`, targetPath);
  return {
    allowed: false,
    reason: `路径 '${targetPath}' 不在白名单. 允许: ${allowlist.join(', ')}`,
    matchedBy: 'path-allowlist'
  };
}

// ============================================================================
// 运行时配置 (从策略文件读, 但有兜底)
// ============================================================================

/**
 * 自改分支名前缀
 */
export function getBranchPrefix(): string {
  const policy = loadPolicy();
  return policy?.branchPrefix || 'agent/self-imp-';
}

/**
 * 冷却期 (毫秒)
 */
export function getCooldownMs(): number {
  const policy = loadPolicy();
  return policy?.cooldownMs || 6 * 60 * 60 * 1000;
}

/**
 * 沙箱工作目录
 */
export function getSandboxCwd(): string {
  const policy = loadPolicy();
  const rel = policy?.sandboxCwd || '.bolloon-shell-sandbox';
  return path.resolve(process.cwd(), rel);
}

// ============================================================================
// 兼容旧 API - 保留原导出名
// ============================================================================

/** @deprecated 用 getBranchPrefix() */
export const SELF_IMPROVE_BRANCH_PREFIX = 'agent/self-imp-';
/** @deprecated 用 getCooldownMs() */
export const SELF_IMPROVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** @deprecated 用 getSandboxCwd() */
export const SHELL_SANDBOX_CWD = path.resolve(process.cwd(), '.bolloon-shell-sandbox');

// ============================================================================
// terminal 工具宽松护栏 (2026-08-10) — denylist-only, 不碰核心即可
// 与 checkCommand 的区别: 不查命令白名单/参数 allowlist — 完整 shell 命令字符串放行,
//   只挡"高危破坏/碰核心数据"模式. 用户明确: 灵活一点, 少围栏, 核心的东西不碰不搞乱.
// ============================================================================

const TERMINAL_DENY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsudo\b/,                          // 提权
  /\bsu\b/,
  /\bmkfs\b/,                          // 格式化
  /\bshred\b/,                         // 擦除
  /\bdd\s+.*of=\/dev\//,               // 写设备
  /\brm\s+-(rf|fr)\b/,                 // 递归删除 (rm 单个文件允许)
  /\bchmod\s+-R\s+777\b/,              // 全权限
  /\bcurl\b[^|]*\|\s*(sh|bash)\b/,     // curl|sh 远程执行
  /\bwget\b[^|]*\|\s*(sh|bash)\b/,
  /\b:\(\)\s*\{[^}]*\}\s*;\s*:/,       // fork bomb
  /\b(>|>>)\s*(\/etc\/|\/usr\/|\/System\/|\/bin\/|\/sbin\/)/, // 写系统目录
  /[\/\s]\.bolloon\b/,                  // Bolloon 数据 (sessions/persona/keys; 覆盖 ~/.bolloon, $HOME/.bolloon, 空格.bolloon)
  /[\/\s]\.(diap|hermes|openclaw)\b/,   // 其他 agent 数据
  /\brm\s+-rf\s+(\/|~|\*|\.|\$HOME)\b/,  // 删根/家/通配
  /\bgit\s+push\b[^|]*\s+(-f|--force)/,  // 强推
  /\bgit\s+reset\s+--hard\b/,
  /\bkill\s+-9\s+\d+\b/,               // 杀进程 (保留给用户)
];

/** 检查完整 shell 命令 (terminal 工具用). denylist-only: 命中高危模式即拒, 否则放行. */
export function checkTerminalCommand(rawCmd: string): ShellCheckResult {
  const cmd = (rawCmd || '').trim();
  if (!cmd) return { allowed: false, reason: '命令为空', matchedBy: 'fallback-deny' };
  for (const pattern of TERMINAL_DENY_PATTERNS) {
    if (pattern.test(cmd)) {
      auditShellCall('denied', cmd, [], `terminal 高危模式 ${pattern}`);
      return { allowed: false, reason: `命令命中高危护栏 ${pattern} (核心不碰: 提权/格式化/删根/.bolloon 数据). 换一条安全命令.`, matchedBy: 'arg-denylist' };
    }
  }
  auditShellCall('allowed', cmd, []);
  return { allowed: true };
}

// ============================================================================
// 写策略 / 审计路径 (供 API 端点用)
// ============================================================================

export const POLICY_AUDIT_PATH_PUBLIC = POLICY_AUDIT_PATH;

/**
 * 把新策略写到磁盘, 立即清缓存让下次 loadPolicy() 重读
 * **只供人手动调用**
 */
export function writePolicy(newPolicy: SelfImprovePolicy): boolean {
  try {
    newPolicy.version = (newPolicy.version || 0) + 1;
    const dir = path.dirname(POLICY_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(POLICY_PATH, JSON.stringify(newPolicy, null, 2));
    cachedPolicy = null; // 清缓存
    policyLoadedAt = 0;
    console.log(`[shell-guard] 策略已更新, version=${newPolicy.version}`);
    return true;
  } catch (err) {
    console.error('[shell-guard] 写策略失败:', err);
    return false;
  }
}
