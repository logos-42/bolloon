// src/git-transport/chat-repo.ts
// 负责 .comm/ 目录初始化、消息写盘、commit/pull/push、状态持久化.
// 全部用 child_process.spawn('git', ...) — 不引 simple-git / nodegit.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  chatPaths,
  ChatMessage,
  ChatFrontmatter,
  CHAT_PROTOCOL_VERSION,
  CHAT_BODY_MAX_BYTES,
  COMMIT_MESSAGE_MAX,
  CHAT_P2P_NOTIFY_THRESHOLD,
} from './chat-types.js';
import { parseMessageFile, dedupeKey } from './chat-render.js';

// ---------- helpers ----------

function runGit(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ stdout, stderr: stderr + '\n[killed: timeout]', code: 124 });
    }, opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + err.message, code: 127 });
    });
  });
}

async function mkdirp(p: string): Promise<void> {
  await fs.promises.mkdir(p, { recursive: true });
}

// 原子获取 lock — 用 mkdir 互斥, 失败重试最多 30s
async function acquireLock(lockPath: string, timeoutMs = 30_000): Promise<() => Promise<void>> {
  const start = Date.now();
  while (true) {
    try {
      await fs.promises.mkdir(lockPath);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // 锁超过 60s 视为僵尸, 强行清掉
      try {
        const st = await fs.promises.stat(lockPath);
        if (Date.now() - st.mtimeMs > 60_000) {
          await fs.promises.rmdir(lockPath).catch(() => {});
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error(`acquire git lock timeout: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return async () => {
    try { await fs.promises.rmdir(lockPath); } catch {}
  };
}

function readJsonSafe<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(p: string, v: any): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
}

// ---------- identity ----------

import { loadOrCreateKeyPair } from '../network/p2p-secret.js';

export interface ResolvedIdentity {
  role: string;
  publicKey: string; // 64-hex
  email: string;
  name: string;
}

export async function resolveIdentity(roleOverride?: string): Promise<ResolvedIdentity> {
  const role = roleOverride || process.env.BOLLOON_ROLE || process.env.IROH_ROLE || 'default';
  // loadOrCreateKeyPair 读 ~/.bolloon/p2p-direct-secret-{role}.json
  const kp = await loadOrCreateKeyPair(role);
  // 关键: 让 git author 反映 Ed25519 公钥, 这样 git log 一眼能认出"谁写的"
  return {
    role,
    publicKey: kp.publicKey,
    name: role,
    email: `${kp.publicKey.slice(0, 12)}@bolloon.local`,
  };
}

// ---------- init ----------

export interface InitResult {
  ok: boolean;
  role: string;
  publicKey: string;
  remote?: string;
  branch?: string;
  messages: string[];
}

export async function chatInit(repoDir: string, opts: { remote?: string; branch?: string; roleOverride?: string } = {}): Promise<InitResult> {
  const id = await resolveIdentity(opts.roleOverride);
  const paths = chatPaths(repoDir);
  await mkdirp(path.join(paths.root, id.role));
  await mkdirp(paths.stateDir);
  await mkdirp(paths.inboxDir);

  // README.md
  const readme = [
    '# .comm/ — 跨机聊天收件箱',
    '',
    'Bolloon chat transport: commits-as-messages.',
    '每条消息 = 一个 markdown 文件 + 一次 git commit + push.',
    '',
    '## 目录约定',
    '',
    '- `<role>/` — 每个 role 一个子目录, 里面是该角色发的所有消息',
    '- `_state/` — 本地运行态 (cursor, seen, lock), 不 commit',
    '- `_inbox/` — 看门狗把对方消息反写到本地, 不 commit',
    '',
    '## 子命令',
    '',
    '```',
    'bolloon --chat-init',
    'bolloon --chat-send "..."',
    'bolloon --chat-pull',
    'bolloon --chat-list',
    'bolloon --chat-watch',
    'bolloon --chat-status',
    '```',
    '',
  ].join('\n');
  await fs.promises.writeFile(paths.readmeFile, readme, 'utf8');

  // REMOTE 文件
  if (opts.remote) {
    await fs.promises.writeFile(paths.remoteFile, opts.remote.trim() + '\n', 'utf8');
  }

  // 探测 remote / branch
  const remote = opts.remote || (await runGit(['remote', 'get-url', 'origin'], { cwd: repoDir })).stdout.trim() || undefined;
  const branch = opts.branch || (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim() || 'master';

  // 配 git user.name/user.email
  await runGit(['config', 'user.name', id.name], { cwd: repoDir });
  await runGit(['config', 'user.email', id.email], { cwd: repoDir });

  // 首次 rebase
  const pull = await runGit(['pull', '--rebase', '--autostash'], { cwd: repoDir });

  // 把 README + REMOTE 第一次 commit 上去 (若有变更)
  await runGit(['add', '.comm/README.md'], { cwd: repoDir });
  if (fs.existsSync(paths.remoteFile)) {
    await runGit(['add', '.comm/REMOTE'], { cwd: repoDir });
  }
  const diff = await runGit(['diff', '--cached', '--name-only'], { cwd: repoDir });
  const messages: string[] = [];
  if (diff.stdout.trim()) {
    const msg = `[chat-init] role=${id.role} pk=${id.publicKey.slice(0, 12)}`;
    const commit = await runGit(['commit', '-m', msg], { cwd: repoDir });
    if (commit.code === 0) {
      messages.push(`created initial commit: ${msg}`);
      if (remote) {
        const push = await runGit(['push', remote, branch], { cwd: repoDir });
        if (push.code === 0) messages.push(`pushed to ${remote}/${branch}`);
        else messages.push(`push failed (will retry on next chat-send): ${push.stderr.trim().split('\n').slice(-1)[0]}`);
      } else {
        messages.push('no remote configured, will only commit locally');
      }
    }
  } else {
    messages.push('.comm/ already initialized, no changes');
  }

  return {
    ok: true,
    role: id.role,
    publicKey: id.publicKey,
    remote,
    branch,
    messages: [
      `role: ${id.role}`,
      `publicKey: ${id.publicKey.slice(0, 16)}...`,
      ...(remote ? [`remote: ${remote}`] : []),
      ...(branch ? [`branch: ${branch}`] : []),
      ...messages,
      ...(pull.code !== 0 ? [`pull warning: ${pull.stderr.trim().split('\n').slice(-1)[0] || 'unknown'}`] : []),
    ],
  };
}

// ---------- send ----------

export interface SendResult {
  ok: boolean;
  sha?: string;
  pushed?: boolean;
  reason?: string;
  p2pNotifyEligible: boolean;
  filePath: string;
}

function sanitizeRoleName(role: string): string {
  // 文件名只允许 [A-Za-z0-9._-]
  return role.replace(/[^A-Za-z0-9._-]/g, '_');
}

function buildMessageFile(frontmatter: ChatFrontmatter, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`v: ${frontmatter.v}`);
  lines.push(`from: ${frontmatter.from}`);
  lines.push(`fromPk: ${frontmatter.fromPk}`);
  if (frontmatter.to) lines.push(`to: ${frontmatter.to}`);
  lines.push(`ts: ${frontmatter.ts}`);
  if (frontmatter.p2pRef) lines.push(`p2pRef: ${frontmatter.p2pRef}`);
  if (frontmatter.git?.sha) {
    lines.push('git:');
    if (frontmatter.git.branch) lines.push(`  branch: ${frontmatter.git.branch}`);
    if (frontmatter.git.sha) lines.push(`  sha: ${frontmatter.git.sha}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n') + body.trimEnd() + '\n';
}

export async function chatSend(opts: {
  repoDir: string;
  body: string;
  to?: string;
  roleOverride?: string;
}): Promise<SendResult> {
  const { repoDir, body } = opts;
  if (!body || !body.trim()) return { ok: false, reason: 'empty body', p2pNotifyEligible: false, filePath: '' };
  if (Buffer.byteLength(body, 'utf8') > CHAT_BODY_MAX_BYTES) {
    return { ok: false, reason: `body too large (${Buffer.byteLength(body, 'utf8')} > ${CHAT_BODY_MAX_BYTES})`, p2pNotifyEligible: false, filePath: '' };
  }

  const id = await resolveIdentity(opts.roleOverride);
  const paths = chatPaths(repoDir);
  await mkdirp(path.join(paths.root, id.role));
  await mkdirp(paths.stateDir);

  const ts = new Date().toISOString();
  const shortHash = require('crypto').createHash('sha256').update(`${id.publicKey}|${ts}|${body}`).digest('hex').slice(0, 8);
  const safeTs = ts.replace(/[:.]/g, '-');
  const filename = `${safeTs}-${shortHash}.md`;
  const relPath = path.join('.comm', sanitizeRoleName(id.role), filename);

  const fm: ChatFrontmatter = {
    v: CHAT_PROTOCOL_VERSION,
    from: id.role,
    fromPk: id.publicKey,
    to: opts.to,
    ts,
  };
  const content = buildMessageFile(fm, body);

  const release = await acquireLock(paths.lockFile);
  try {
    // 1) 写盘
    await fs.promises.writeFile(path.join(repoDir, relPath), content, 'utf8');

    // 2) git add (限定 .comm/<self>/, 避免把别人未 push 的修改带进来)
    await runGit(['add', '--', relPath], { cwd: repoDir });

    // 3) commit
    const commitMsg = `chat(${id.role}): ${body.split('\n')[0].slice(0, 60)}`.slice(0, COMMIT_MESSAGE_MAX);
    const commit = await runGit(['commit', '-m', commitMsg], { cwd: repoDir });
    if (commit.code !== 0) {
      return { ok: false, reason: `git commit failed: ${commit.stderr.trim()}`, p2pNotifyEligible: false, filePath: relPath };
    }
    const shaLine = (await runGit(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    // 4) rebase + push (失败不回滚 commit, 让本地 commit 留下, 下次 send 重试 push)
    await runGit(['pull', '--rebase', '--autostash'], { cwd: repoDir });
    let pushed = false;
    const push = await runGit(['push'], { cwd: repoDir });
    if (push.code === 0) pushed = true;

    // 5) 自己的 cursor 推进
    await writeJsonSafe(paths.cursorFile, { lastHead: shaLine, lastSelfTs: ts, role: id.role });

    return {
      ok: true,
      sha: shaLine,
      pushed,
      p2pNotifyEligible: Buffer.byteLength(body, 'utf8') <= CHAT_P2P_NOTIFY_THRESHOLD,
      filePath: relPath,
    };
  } finally {
    await release();
  }
}

// ---------- pull (一次性) ----------

export interface PullResult {
  ok: boolean;
  newCommits: number;
  newMessages: ChatMessage[];
  reason?: string;
}

export async function chatPull(opts: { repoDir: string; since?: string; roleOverride?: string }): Promise<PullResult> {
  const { repoDir } = opts;
  const paths = chatPaths(repoDir);
  await mkdirp(paths.stateDir);

  const fetch = await runGit(['fetch', '--all', '--prune'], { cwd: repoDir });
  if (fetch.code !== 0) {
    return { ok: false, newCommits: 0, newMessages: [], reason: `git fetch failed: ${fetch.stderr.trim().split('\n').slice(-1)[0]}` };
  }
  const rebase = await runGit(['pull', '--rebase', '--autostash'], { cwd: repoDir });

  // 收集新增消息: 对比 rev-list HEAD~ <self-cursor-sha>..HEAD 的 .comm/* 变更
  const cursor = readJsonSafe<{ lastHead?: string }>(paths.cursorFile, {});
  let range = 'HEAD';
  if (cursor.lastHead) {
    range = `${cursor.lastHead}..HEAD`;
  }
  const rev = await runGit(['rev-list', range, '--', '.comm'], { cwd: repoDir });
  if (rev.code !== 0) {
    return { ok: false, newCommits: 0, newMessages: [], reason: `rev-list failed: ${rev.stderr.trim()}` };
  }
  const shas = rev.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const newMessages: ChatMessage[] = [];
  const seen = readJsonSafe<Record<string, number>>(paths.seenFile, {});
  const id = await resolveIdentity(opts.roleOverride);

  for (const sha of shas) {
    const show = await runGit(['show', '--name-only', '--pretty=format:', sha, '--', '.comm'], { cwd: repoDir });
    const fileLines = show.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const f of fileLines) {
      if (!f.endsWith('.md')) continue;
      if (f.includes(`${path.sep}_state${path.sep}`) || f.includes(`${path.sep}_inbox${path.sep}`)) continue;
      const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
      const msg = parseMessageFile(abs, sha);
      if (!msg) continue;
      // 不是自己发的: 收
      if (msg.frontmatter.fromPk !== id.publicKey) {
        const key = dedupeKey(msg);
        if (!seen[key]) {
          newMessages.push(msg);
          seen[key] = Date.now();
        }
      }
    }
  }
  await writeJsonSafe(paths.seenFile, seen);

  // 推进 cursor
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
  await writeJsonSafe(paths.cursorFile, { ...cursor, lastHead: head });

  return { ok: true, newCommits: shas.length, newMessages };
}

// ---------- status ----------

export interface ChatStatus {
  role: string;
  publicKey: string;
  repoDir: string;
  remote?: string;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  mode: 'synced' | 'local-only' | 'no-remote';
  lastError?: string;
  fileCount: number;
  byRole: Record<string, number>;
}

export async function chatStatus(opts: { repoDir: string; roleOverride?: string }): Promise<ChatStatus> {
  const { repoDir } = opts;
  const id = await resolveIdentity(opts.roleOverride);
  const remote = (await runGit(['remote', 'get-url', 'origin'], { cwd: repoDir })).stdout.trim() || undefined;
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim() || undefined;
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim() || undefined;

  let ahead: number | undefined;
  let behind: number | undefined;
  if (remote && branch) {
    const rev = await runGit(['rev-list', '--left-right', '--count', `${branch}...${remote}/${branch}`], { cwd: repoDir });
    if (rev.code === 0) {
      const [a, b] = rev.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      ahead = a; behind = b;
    }
  }

  const files = listMessageFilesLocal(repoDir);
  const byRole: Record<string, number> = {};
  for (const f of files) {
    const m = /[\\/].comm[\\/]([^\\/]+)[\\/]/.exec(f);
    const role = m ? m[1] : '?';
    byRole[role] = (byRole[role] || 0) + 1;
  }

  let mode: ChatStatus['mode'] = 'synced';
  if (!remote) mode = 'no-remote';
  else if (ahead && ahead > 0) mode = 'local-only';

  return {
    role: id.role,
    publicKey: id.publicKey,
    repoDir,
    remote,
    branch,
    head: head ? head.slice(0, 12) : undefined,
    ahead,
    behind,
    mode,
    fileCount: files.length,
    byRole,
  };
}

function listMessageFilesLocal(repoDir: string): string[] {
  const { listMessageFiles } = require('./chat-render.js');
  return listMessageFiles(repoDir);
}
