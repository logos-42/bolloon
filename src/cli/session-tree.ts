/**
 * session-tree.ts — 会话树: 用 git 管理 fork 分支 (leo 2026-09-30)
 *
 * 语义 (leo 确认, 标准 branch 语义):
 *   · `/fork <#|id>` 从某条会话**分叉出一条新会话**: 新会话**继承 fork 点之前的全部历史**,
 *     之后两条各自独立 (各自继续写自己的文件)。
 *   · 树用 **git** 管: `~/.bolloon/sessions/` 变成一个仓库, 每次 fork / 退出存档 = 一次 commit,
 *     commit 里带 `session: <key>` 与 `parent: <源 key>` ⇒ `git log --graph` 就是会话树。
 *
 * 三条纪律:
 *   1. **不吞 git 的输出** —— 成功给 commit 短哈希, 失败给原因 (调用方如实显示)。
 *   2. **仓库是用户的会话历史** —— 只 init (无仓库时) + add/commit; **绝不** reset/checkout/clean。
 *   3. **不阻塞对话** —— git 不可用/失败时, fork 本身仍然成功 (文件已写好), 只是树没记上, 如实标注。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SessionStore } from '../agents/session-store.js';

const pexec = promisify(execFile);

export interface TreeResult {
  ok: boolean;
  /** 成功时的 commit 短哈希 */
  commit?: string;
  /** 失败原因 (ok=false 时一定有) */
  error?: string;
}

/** 会话仓库根 = sessions 目录 (里面 cache/ 与 channels.json 都进树) */
function repoDir(store: SessionStore): string {
  return path.dirname(store.dir);
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await pexec('git', args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: String(stdout), err: String(stderr) };
  } catch (e: any) {
    return { ok: false, out: String(e?.stdout || ''), err: String(e?.stderr || e?.message || e).slice(0, 300) };
  }
}

/** 仓库不存在就建 (并设本地 user.name/email, 不依赖用户全局 git 配置) */
export async function ensureTree(store: SessionStore): Promise<TreeResult> {
  const dir = repoDir(store);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch { /* 已存在 */ }
  const inside = await git(dir, ['rev-parse', '--git-dir']);
  if (!inside.ok) {
    const init = await git(dir, ['init', '-q', '-b', 'main']);
    if (!init.ok) return { ok: false, error: `git init 失败: ${init.err}` };
    await git(dir, ['config', 'user.name', 'bolloon']);
    await git(dir, ['config', 'user.email', 'bolloon@localhost']);
    // 忽略半截临时文件 (session-store 的原子写会留 .tmp 一瞬间)
    try { await fs.writeFile(path.join(dir, '.gitignore'), '*.tmp\n', { flag: 'wx' }); } catch { /* 已存在 */ }
  }
  return { ok: true };
}

/**
 * 把当前状态提交进树。
 * @param subject 形如 `session: <key> · fork from <src>` —— 树里一眼能看出发生了什么
 */
export async function commitTree(store: SessionStore, subject: string, body?: string): Promise<TreeResult> {
  const ens = await ensureTree(store);
  if (!ens.ok) return ens;
  const dir = repoDir(store);
  const add = await git(dir, ['add', '-A', '--', '.']);
  if (!add.ok) return { ok: false, error: `git add 失败: ${add.err}` };
  const args = ['commit', '-q', '--no-verify', '-m', subject];
  if (body) args.push('-m', body);
  const c = await git(dir, args);
  if (!c.ok) {
    // 没有变化 (nothing to commit) 不算失败 —— 如实区分
    if (/nothing to commit|no changes added/i.test(c.err) || /nothing to commit/i.test(c.out)) return { ok: true, commit: '(无变化)' };
    return { ok: false, error: `git commit 失败: ${c.err}` };
  }
  const rev = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, commit: rev.ok ? rev.out.trim() : '' };
}

export interface ForkResult extends TreeResult {
  /** 新会话 key */
  newKey?: string;
  /** 继承的历史条数 (fork 点) */
  inherited?: number;
  /** 源会话 key */
  from?: string;
}

/**
 * fork 一条会话: 继承 fork 点之前的全部历史 + 记 parent 关系 + 落一次 commit。
 * 标准 branch 语义: 之后两条会话各自独立 (各写各的文件)。
 */
export async function forkSession(store: SessionStore, srcKey: string): Promise<ForkResult> {
  let raw: any;
  let srcPath = '';
  for (const cand of [store.pathFor(srcKey), path.join(store.dir, `${srcKey}.json`)]) {
    try { raw = JSON.parse(await fs.readFile(cand, 'utf-8')); srcPath = cand; break; } catch { /* 试下一个 */ }
  }
  if (!raw) return { ok: false, error: `源会话读不到: ${srcKey}` };

  const msgs: any[] = Array.isArray(raw) ? raw : (raw?.messages || []);
  const ts = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}_${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
  let newKey = `${base}_fork`;
  for (let i = 2; i < 50; i++) {
    try { await fs.access(store.pathFor(newKey)); newKey = `${base}_fork${i}`; } catch { break; }
  }

  const out = {
    key: newKey,
    messages: msgs,                       // ← 共享 fork 点之前的全部历史 (标准 branch 语义)
    metadata: {
      ...(Array.isArray(raw) ? {} : (raw?.metadata || {})),
      forkedFrom: srcKey,
      forkPoint: msgs.length,
      forkedAt: Date.now(),
      savedAt: Date.now(),
      cwd: process.cwd(),
      totalCount: msgs.length,
      // 继承来的标题加前缀, /sessions 里一眼看出它是分支
      title: `↳ ${String((Array.isArray(raw) ? {} : raw?.metadata?.title) || srcKey)}`,
      preview: `从 ${srcKey} 分叉 (fork 点 ${msgs.length} 条)`,
    },
  };
  await fs.writeFile(store.pathFor(newKey), JSON.stringify(out, null, 2), 'utf-8');
  const committed = await commitTree(
    store,
    `session: ${newKey} · fork from ${srcKey} @${msgs.length}`,
    `fork 点: ${msgs.length} 条消息\n源文件: ${path.relative(repoDir(store), srcPath) || srcKey}`,
  );
  return { ...committed, newKey, inherited: msgs.length, from: srcKey };
}

/** 会话树概览 (给 `/fork --tree` / 诊断用): 最近 N 次提交 + 分支名 */
export async function treeLog(store: SessionStore, limit = 12): Promise<{ ok: boolean; text: string; error?: string }> {
  const ens = await ensureTree(store);
  if (!ens.ok) return { ok: false, text: '', error: ens.error };
  const dir = repoDir(store);
  const log = await git(dir, ['log', `-n${Math.max(1, limit)}`, '--pretty=format:%h %ad | %s', '--date=format:%m-%d %H:%M']);
  if (!log.ok) return { ok: false, text: '', error: log.err };
  return { ok: true, text: log.out };
}
