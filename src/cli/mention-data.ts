/**
 * mention-data.ts — CLI @ / # 弹出窗数据源 (2026-08-05)
 *
 * 弹出窗三路命中:
 *   @ → 智能体 (本地 channels + 远端 channel 缓存)
 *   / → 命令 (CLI 内置 + Web 斜杠命令) + 技能 (3 个 skill 目录) + 插件 (MCP servers)
 *   # → 文件 (cwd 有限深度遍历)
 *
 * 全部走本地文件读取, 不依赖 web server 是否在跑 (CLI 模式 server 不启动).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface MentionItem {
  kind: 'agent' | 'command' | 'skill' | 'plugin' | 'file';
  /** 显示名 / 匹配名 */
  label: string;
  /** 右侧提示 */
  hint: string;
  /** 选中后插入的文本 (不含触发符) */
  insert: string;
}

const HOME = (): string => process.env.HOME || os.homedir() || '/tmp';

// ─── 命令 (CLI 内置) ─────────────────────────────────────────────────────────

const CLI_COMMANDS: MentionItem[] = [
  { kind: 'command', label: 'queue', hint: '切换队列模式', insert: 'queue' },
  { kind: 'command', label: 'dequeue', hint: '出队一条', insert: 'dequeue' },
  { kind: 'command', label: 'help', hint: '显示帮助', insert: 'help' },
  { kind: 'command', label: 'exit', hint: '退出', insert: 'exit' },
  { kind: 'command', label: 'peers', hint: '查看 P2P 节点', insert: 'peers' },
  { kind: 'command', label: 'iroh', hint: '查看 iroh 状态', insert: 'iroh' },
  { kind: 'command', label: 'add_friend', hint: '添加好友 <64位hex公钥>', insert: 'add_friend' },
  // 2026-08-06: 系统命令组
  { kind: 'command', label: 'model', hint: '模型供应商选择器 (↑↓ 选择)', insert: 'model' },
  { kind: 'command', label: 'login', hint: '登录 GitHub + Google 账号 (骨架)', insert: 'login' },
  { kind: 'command', label: 'logout', hint: '查看当前供应商', insert: 'logout' },
  { kind: 'command', label: 'now', hint: '当前状态总览', insert: 'now' },
  { kind: 'command', label: 'session', hint: '当前会话信息', insert: 'session' },
  { kind: 'command', label: 'loop', hint: '循环状态 (消息/token)', insert: 'loop' },
  { kind: 'command', label: 'memory', hint: '记忆摘要', insert: 'memory' },
  { kind: 'command', label: 'resume', hint: '恢复上下文', insert: 'resume' },
  { kind: 'command', label: 'goal', hint: '进行中目标', insert: 'goal' },
  { kind: 'command', label: 'tools', hint: '可用工具列表', insert: 'tools' },
  { kind: 'command', label: 'skill', hint: '技能候选', insert: 'skill' },
  { kind: 'command', label: 'mcp', hint: 'MCP 服务器列表', insert: 'mcp' },
  { kind: 'command', label: 'agent', hint: '当前智能体', insert: 'agent' },
  { kind: 'command', label: 'did', hint: 'DID 身份', insert: 'did' },
  { kind: 'command', label: 'ipfs', hint: 'Kubo 状态', insert: 'ipfs' },
  { kind: 'command', label: 'ipns', hint: 'IPNS keys', insert: 'ipns' },
  { kind: 'command', label: 'wallet', hint: '钱包状态', insert: 'wallet' },
  { kind: 'command', label: 'email', hint: '邮件配置', insert: 'email' },
  { kind: 'command', label: 'judgement', hint: '判断力列表', insert: 'judgement' },
  { kind: 'command', label: 'insight', hint: '洞察 (08-Insights)', insert: 'insight' },
  { kind: 'command', label: 'wiki', hint: 'wiki 状态', insert: 'wiki' },
  { kind: 'command', label: 'dream', hint: '随机灵感', insert: 'dream' },
  { kind: 'command', label: 'new agent', hint: '创建新智能体 channel', insert: 'new agent' },
  { kind: 'command', label: 'new session', hint: '创建新会话', insert: 'new session' },
  { kind: 'command', label: 'plan', hint: '循环计划 (创建/查看)', insert: 'plan' },
  { kind: 'command', label: 'todo', hint: '勾选步骤 (循环过程)', insert: 'todo' },
];

/** Web 端斜杠命令 (server /message 路由 → LLM 工具) */
const WEB_COMMANDS: MentionItem[] = [
  { kind: 'command', label: 'review', hint: '审查计划', insert: 'review' },
  { kind: 'command', label: 'task', hint: '创建任务', insert: 'task' },
  { kind: 'command', label: 'skill', hint: '沉淀技能', insert: 'skill' },
  { kind: 'command', label: 'add-friend', hint: '添加好友 (智能体工具)', insert: 'add-friend' },
];

export function loadCommands(): MentionItem[] {
  return [...CLI_COMMANDS, ...WEB_COMMANDS];
}

// ─── 智能体 (@) ──────────────────────────────────────────────────────────────

/** 本地 channels.json (server-types.ts CHANNELS_PATH) + 远端 channel 缓存 */
export async function loadAgents(): Promise<MentionItem[]> {
  const out: MentionItem[] = [];

  // 本地 channels: 优先 ~/.bolloon/sessions/channels.json, 兜底 ~/.bolloon/channels.json
  const channelsPaths = [
    path.join(HOME(), '.bolloon', 'sessions', 'channels.json'),
    path.join(HOME(), '.bolloon', 'channels.json'),
  ];
  for (const p of channelsPaths) {
    try {
      const chs = JSON.parse(await fs.readFile(p, 'utf-8'));
      if (Array.isArray(chs)) {
        for (const c of chs) {
          const name = c?.name;
          if (typeof name === 'string' && name.trim()) {
            out.push({ kind: 'agent', label: name.trim(), hint: '本地智能体', insert: name.trim() });
          }
        }
        break;
      }
    } catch { /* 尝试下一个路径 */ }
  }

  // 远端 channel 缓存: { peerPublicKey: Channel[] }
  try {
    const remote = JSON.parse(await fs.readFile(path.join(HOME(), '.bolloon', 'remote-channels-cache.json'), 'utf-8'));
    if (remote && typeof remote === 'object') {
      for (const [peerPk, channels] of Object.entries(remote)) {
        if (!Array.isArray(channels)) continue;
        for (const c of channels) {
          const name = (c as any)?.name;
          if (typeof name === 'string' && name.trim()) {
            out.push({ kind: 'agent', label: name.trim(), hint: `远端 · ${peerPk.slice(0, 8)}…`, insert: name.trim() });
          }
        }
      }
    }
  } catch { /* 无远端缓存 */ }

  // 去重 (本地优先)
  const seen = new Set<string>();
  return out.filter(i => {
    if (seen.has(i.label)) return false;
    seen.add(i.label);
    return true;
  });
}

// ─── 技能 (/ 弹窗的一部分) ───────────────────────────────────────────────────

/** 3 个 skill 目录 (与 skill-loader.defaultSkillPaths 一致) */
export async function loadSkills(): Promise<MentionItem[]> {
  const out: MentionItem[] = [];
  const dirs = [
    path.join(HOME(), '.bolloon', 'skills'),
    path.join(process.cwd(), '.bolloon', 'skills'),
    path.join(HOME(), '.boll', 'skills'),
  ];
  for (const d of dirs) {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      // 读 frontmatter description 作为提示 (轻量, 不引 skill-loader 依赖)
      let desc = '';
      try {
        const raw = (await fs.readFile(path.join(d, e.name, 'SKILL.md'), 'utf-8')).slice(0, 800);
        const m = raw.match(/^---\r?\n[\s\S]*?^description:\s*(.+)$/m);
        if (m) desc = m[1].trim().replace(/^["']|["']$/g, '').slice(0, 50);
      } catch { /* 无 SKILL.md → 仅目录名 */ }
      out.push({ kind: 'skill', label: e.name, hint: desc || '技能', insert: e.name });
    }
  }
  const seen = new Set<string>();
  return out.filter(i => {
    if (seen.has(i.label)) return false;
    seen.add(i.label);
    return true;
  });
}

// ─── 插件 (/ 弹窗的一部分) — MCP servers ─────────────────────────────────────

/** ~/.mcp.json / cwd/.mcp.json 的 mcpServers 键名 */
export async function loadPlugins(): Promise<MentionItem[]> {
  const out: MentionItem[] = [];
  const paths = [path.join(HOME(), '.mcp.json'), path.join(process.cwd(), '.mcp.json')];
  for (const p of paths) {
    try {
      const data = JSON.parse(await fs.readFile(p, 'utf-8'));
      const servers = data?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const name of Object.keys(servers)) {
          out.push({ kind: 'plugin', label: name, hint: 'MCP 插件', insert: name });
        }
        break;
      }
    } catch { /* 下一个路径 */ }
  }
  return out;
}

// ─── 文件 (#) ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.cache', '.hermes',
  'coverage', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'tmp', 'release',
  '.bolloon', '.boll', '.turbo', '.idea', '.vscode', 'bin', 'lib', 'assets',
]);

/** cwd 有限深度 BFS, 只收文件, 上限 cap 个, 排序稳定; 超时兜底 (冷缓存 fs.readdir 偶发挂起, 2026-08-05) */
export async function loadFiles(
  _query: string,
  base: string = process.cwd(),
  maxDepth = 3,
  cap = 400,
  timeoutMs = 5000,
): Promise<MentionItem[]> {
  const out: MentionItem[] = [];
  const deadline = Date.now() + timeoutMs;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: base, depth: 0 }];
  while (stack.length > 0 && out.length < cap) {
    if (Date.now() > deadline) break; // 超时返回已收集部分, 弹窗不卡"扫描中"
    const { dir, depth } = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    // 目录优先入栈, 文件直接收集; 同层排序保证稳定
    const dirs: Array<{ dir: string; depth: number }> = [];
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) dirs.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        // label/insert 统一用 `/` 分隔 (展示 + matchFileScore split + 弹窗插入一致), 跨平台
        const rel = path.relative(base, full).split(path.sep).join('/');
        out.push({ kind: 'file', label: rel, hint: '', insert: rel });
      }
    }
    dirs.reverse(); // 保证 pop 顺序按字母序
    for (const d of dirs) stack.push(d);
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** 文件匹配评分: basename 前缀 > 全路径前缀 > basename 包含 > 全路径包含 */
export function matchFileScore(label: string, q: string): number {
  const base = label.split('/').pop() || label;
  if (base.startsWith(q)) return 0;
  if (label.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (label.includes(q)) return 3;
  return -1;
}

/**
 * 从输入里检测当前 mention token (最后一个以 @ / # 开头的 token).
 * 返回 { kind, query, start, trigger } — start 是触发符在 input 里的下标.
 *
 * 规则:
 *   @ → agent: token 里最后一个 @, 且 @ 前一个字符不是 ascii 字母数字 (防 email a@b.com)
 *   # → file:  token 里最后一个 #, 允许路径含 / (如 #src/cli/), 前字符非 ascii 字母数字
 *   / → command: 必须是 token 第一个字符 (防 "看看 src/" 误触发), 如 /queue
 */
export function getMention(input: string): { kind: 'agent' | 'command' | 'file'; query: string; start: number; trigger: string } | null {
  // 最后一个 token 的起始下标 (最后一个空白之后)
  let tokenStart = input.length;
  while (tokenStart > 0 && !/\s/.test(input[tokenStart - 1])) tokenStart--;
  const token = input.slice(tokenStart);

  // 从后往前找触发符
  for (let i = token.length - 1; i >= 0; i--) {
    const ch = token[i];
    if (ch !== '@' && ch !== '/' && ch !== '#') continue;
    if (ch === '/') {
      // 命令: 只认 token 第一个字符
      if (i !== 0) continue;
    } else {
      // @ / #: 前一个字符是 ascii 字母数字 → email/url 场景, 跳过
      if (i > 0 && /[A-Za-z0-9]/.test(token[i - 1])) continue;
    }
    const kind = ch === '@' ? 'agent' : ch === '#' ? 'file' : 'command';
    return { kind, query: token.slice(i + 1), start: tokenStart + i, trigger: ch };
  }
  return null;
}
