/**
 * dual-source.ts — 双源 (npm registry + GitHub) 的**源事实** (2026-09-25, update-protocol §12)
 *
 * 为什么单独一个模块: §1.4 冻结的是 "npm 是唯一稳定渠道", §12 把它改成**双源但权威顺序不变**。
 * 这件事不该塞进 update-manager (那会让"唯一决策者"同时变成"网络客户端"), 也不该让
 * CLI / 健康检查各自造一份 GitHub 事实。所以:
 *
 *   - 源事实 (GitHub 可达性 / tag / Release / master HEAD) 只在本模块查
 *   - 错误分类 `classifyGithubError` 与 §3 的 `classifyRegistryError` **并列, 不合并**
 *   - dev 快照的**取源与构建**也在这里 (update-manager 只负责"切换 + 验证 + 回滚", 不另造一套)
 *
 * 2026-09-26 拆分 (手机端要复用同一份语义): **纯语义那一半**去 `dual-source-facts.ts`
 * (分类 / 交叉校验 / dev 快照比较 —— 无 `node:`, 因此能打进手机端 WebView bundle);
 * 本文件只留**需要网络与子进程**的那一半 (真调 api.github.com / codeload / 现场构建),
 * 并把纯那一半的名字原样再导出 —— 既有 `from './dual-source.js'` 的 import 一行不用改。
 *
 * 硬口径 (§12.5, 验收核心):
 *   - 源不可达 / 版本不存在 → **拒绝并说清** (带具体分类), 绝不静默装回旧版
 *   - 不编造不存在的路径: 本仓 GitHub 上**真的没有 Release** (0 个), 所以 "Release 缺" 时
 *     如实报 "发布记录缺 Tag / Release" (提醒级), **不是** fake 一个 Release 出来
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { spawnSync } from 'child_process';
import {
  GITHUB_API_BASE, GITHUB_UPSTREAM_SLUG, DEV_BRANCH, devIdentity, baseVersionOf,
  readPackageAt, DEV_CHANNEL_WARNING,
} from './version-info.js';
import {
  classifyGithubError,
  type GithubReason, type GithubTag, type GithubFacts, type GithubResult,
} from './dual-source-facts.js';

/**
 * 纯语义那一半 (错误分类 / 交叉校验 / dev 快照比较 / 报告渲染) —— **唯一一份在
 * `dual-source-facts.ts`** (桌面与手机端共用)。这里原样再导出: 桌面既有 import 路径不变,
 * 手机端 WebView 直接 import 那份纯模块 (没有 `node:` ⇒ 能进 bundle)。
 */
export {
  GITHUB_REASONS, OFFLINE_CODES,
  classifyGithubError, classifyRegistryError,
  newestGithubVersion, numericCompare,
  toGithubReport, renderGithubReportLine,
  crossCheckStable, compareDevSnapshots,
  DEV_CHANNEL_WARNING,
} from './dual-source-facts.js';
export type {
  GithubReason, GithubTag, GithubFacts, GithubResult, GithubReport,
  CrossCheckKind, CrossCheck, DevCheck,
} from './dual-source-facts.js';

// ── HTTP ────────────────────────────────────────────────────────────────────

interface HttpOut { status: number; body: string; headers: Record<string, string> }

/** 可选 GitHub token (只为提配额: 匿名 60 次/小时, 认证 5000 次/小时)。**永不打印、永不入库**。 */
function githubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env.GITHUB_TOKEN || env.GH_TOKEN || env.BOLLOON_GITHUB_TOKEN;
  return t && String(t).trim() ? String(t).trim() : null;
}

function httpGetRaw(url: string, timeoutMs: number, token?: string | null): Promise<HttpOut> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: 'application/vnd.github+json, application/json',
        'User-Agent': 'bolloon-update',
        // token 只进请求头, 不进日志/状态/输出 (凭证红线)
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (c: any) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: (res.headers || {}) as Record<string, string> }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}
// 纯语义那一半 (分类 / 交叉校验 / dev 快照比较) 见文件头的再导出 —— 定义在 dual-source-facts.ts。

// ── 事实查询 ────────────────────────────────────────────────────────────────

export interface FetchGithubOptions {
  /** 注入 (测试 / 受控 API) */
  apiBase?: string;
  slug?: string;
  timeoutMs?: number;
  /** 可选 token (提配额)。传 null 强制匿名。 */
  token?: string | null;
}

/**
 * 查 GitHub 的三个事实: Releases / Tags / master HEAD。
 * **任何一个请求失败 → 整条 `github_unavailable`** (带分类), 但把已拿到的那部分 facts 一起带回去
 * (上层因此能说清"哪些拿到了、哪些没拿到", 而不是一句"更新失败")。
 */
export async function fetchGithubFacts(opts: FetchGithubOptions = {}): Promise<GithubResult> {
  const base = (opts.apiBase || GITHUB_API_BASE).replace(/\/+$/, '');
  const slug = opts.slug || GITHUB_UPSTREAM_SLUG;
  const timeout = opts.timeoutMs ?? 10000;
  // 有 token 就用 (配额 60/h → 5000/h); 没有也能跑, 只是可能 403 限流
  const token = opts.token !== undefined ? opts.token : githubToken();
  const missing: string[] = [];
  let releases: string[] = [];
  let tags: GithubTag[] = [];
  let headSha: string | null = null;
  /** 失败累积 (第一个失败决定分类, 但所有失败都记进 missing) */
  const failures: { reason: GithubReason; detail: string; retryAt: string | null }[] = [];
  const note = (e: { reason: GithubReason; detail: string; retryAt: string | null }, what: string) => {
    missing.push(what);
    failures.push({ reason: e.reason, detail: `${what}: ${e.detail}`, retryAt: e.retryAt });
  };

  // 1. Releases (本仓真的没有 → 200 + [] , 不是错误)
  try {
    const r = await httpGetRaw(`${base}/repos/${slug}/releases?per_page=100`, timeout, token);
    if (r.status >= 200 && r.status < 300) {
      const arr = JSON.parse(r.body);
      releases = Array.isArray(arr) ? arr.map((x: any) => String(x?.tag_name || '')).filter(Boolean) : [];
    } else {
      note(classifyGithubError(null, r.status, r.headers), 'releases');
    }
  } catch (e: any) {
    note(classifyGithubError(e), 'releases');
  }

  // 2. Tags
  try {
    const r = await httpGetRaw(`${base}/repos/${slug}/tags?per_page=100`, timeout, token);
    if (r.status >= 200 && r.status < 300) {
      const arr = JSON.parse(r.body);
      tags = Array.isArray(arr)
        ? arr.map((x: any) => ({ name: String(x?.name || ''), sha: x?.commit?.sha ? String(x.commit.sha) : null })).filter((t: GithubTag) => t.name)
        : [];
    } else {
      note(classifyGithubError(null, r.status, r.headers), 'tags');
    }
  } catch (e: any) {
    note(classifyGithubError(e), 'tags');
  }

  // 3. master HEAD (dev 通道的身份来源)
  try {
    const r = await httpGetRaw(`${base}/repos/${slug}/commits/${DEV_BRANCH}`, timeout, token);
    if (r.status >= 200 && r.status < 300) {
      const j = JSON.parse(r.body);
      headSha = j?.sha ? String(j.sha) : null;
      if (!headSha) note({ reason: 'parse_error', detail: 'commits/master 没有 sha 字段', retryAt: null }, 'head');
    } else {
      // 404 在这里的语义就是"没有 master 分支"(§12.3)
      note(classifyGithubError(null, r.status, r.headers), 'head');
    }
  } catch (e: any) {
    note(classifyGithubError(e), 'head');
  }

  const facts: GithubFacts = {
    slug, ref: `refs/heads/${DEV_BRANCH}`, headSha, releases, tags,
    fetchedAt: new Date().toISOString(), partial: missing.length > 0, missing,
  };
  if (failures.length > 0) {
    const first = failures[0];
    return { ok: false, kind: 'github_unavailable', reason: first.reason, detail: first.detail, retryAt: first.retryAt, facts };
  }
  return { ok: true, facts };
}

// ── dev: 快照取源与构建 ─────────────────────────────────────────────────────

export interface DevSnapshotOptions {
  sha: string;
  /** 工作目录 (临时) */
  workDir: string;
  env?: NodeJS.ProcessEnv;
  onStage?: (stage: string, detail: string) => void;
  runNpm?: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };
  /** 跳过构建 (源码树里已有 dist) 的判断开关, 默认按 dist 是否存在判断 */
  timeoutMs?: number;
}

export type DevSnapshotResult =
  | { ok: true; dir: string; tarball: string; identity: string; sha: string; baseVersion: string; source: string; built: boolean }
  | { ok: false; kind: 'github_unavailable' | 'dev_source_failed'; reason: string; detail: string };

function defaultRunNpm(args: string[], cwd: string) {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf-8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 从 GitHub 取 master 的源码快照 (codeload tarball); 解到 destParent。 */
async function downloadGithubSnapshot(sha: string, destParent: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: true; dir: string; source: string } | { ok: false; kind: 'github_unavailable'; reason: string; detail: string }> {
  const template = env.BOLLOON_DEV_TARBALL_URL
    || `https://codeload.github.com/${GITHUB_UPSTREAM_SLUG}/tar.gz/{sha}`;
  const url = template.replace('{sha}', sha).replace('{branch}', DEV_BRANCH);
  await fsp.mkdir(destParent, { recursive: true });
  const file = path.join(destParent, `dev-${sha.slice(0, 7)}.tar.gz`);
  try {
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const tk = githubToken(env);
      const req = client.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'bolloon-update', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) } }, (res: any) => {
        if ((res.statusCode || 0) >= 400) { reject(classifyGithubError(null, res.statusCode, res.headers)); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: any) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
    });
    await fsp.writeFile(file, buf);
  } catch (e: any) {
    const cls = e?.kind === 'github_unavailable' ? e : classifyGithubError(e);
    return { ok: false, kind: 'github_unavailable', reason: cls.reason, detail: `取 ${url} 失败: ${cls.detail}` };
  }
  const extract = path.join(destParent, 'src');
  await fsp.mkdir(extract, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', file, '-C', extract], { encoding: 'utf-8', timeout: 300_000 });
  if (tar.status !== 0) return { ok: false, kind: 'github_unavailable', reason: 'http_error', detail: `解压快照失败: ${String(tar.stderr || '').slice(0, 200)}` };
  const kids = (await fsp.readdir(extract)).filter((f) => !f.startsWith('.'));
  if (kids.length !== 1) return { ok: false, kind: 'github_unavailable', reason: 'http_error', detail: `快照解压后目录数不是 1 (${kids.length})` };
  return { ok: true, dir: path.join(extract, kids[0]), source: 'github-tarball' };
}

/**
 * 把 master HEAD 的一个 commit 变成**可安装的 dev 快照 tarball**:
 *   取源码 → 校验 sha (本地源码树必须对得上) → 版本改成 `<base>+dev.<sha7>` → 需要时构建 → npm pack
 *
 * 复用原则 (§5 的刻意偏差): **不另造一套替换机制** —— 产物仍是 tarball, 仍交给 npm 替换,
 * 仍然"切换后验证 + 失败回滚"。这里只负责"从哪个源取、装出来是什么身份"。
 */
export async function prepareDevSnapshot(opts: DevSnapshotOptions): Promise<DevSnapshotResult> {
  const env = opts.env ?? process.env;
  const runNpm = opts.runNpm || defaultRunNpm;
  const stage = (s: string, d: string) => { try { opts.onStage?.(s, d); } catch { /* 回调不许影响流程 */ } };
  const sha = String(opts.sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, kind: 'github_unavailable', reason: 'not_found', detail: `master HEAD 的 sha 不合法 (${sha || '空'}) — 拒绝按未知 commit 安装` };
  }

  let dir = '';
  let source = '';
  const envDir = env.BOLLOON_DEV_SOURCE_DIR;
  if (envDir) {
    if (!fs.existsSync(path.join(envDir, 'package.json'))) {
      return { ok: false, kind: 'dev_source_failed', reason: 'source_dir_missing', detail: `BOLLOON_DEV_SOURCE_DIR=${envDir} 下没有 package.json` };
    }
    // 本地源码树必须**真的**是这个 commit —— 否则不许把它当 master HEAD 的快照
    const local = spawnSync('git', ['-C', envDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const localSha = (local.stdout || '').trim();
    if (local.status !== 0 || !localSha) {
      if (env.BOLLOON_DEV_ALLOW_UNVERIFIED_SOURCE !== '1') {
        return { ok: false, kind: 'dev_source_failed', reason: 'sha_unverifiable', detail: `${envDir} 不是 git 检出, 无法核对 sha=${sha.slice(0, 7)} (要强制使用请设 BOLLOON_DEV_ALLOW_UNVERIFIED_SOURCE=1)` };
      }
    } else if (!localSha.startsWith(sha.slice(0, 7)) && !sha.startsWith(localSha.slice(0, 7))) {
      return { ok: false, kind: 'dev_source_failed', reason: 'sha_mismatch', detail: `${envDir} 的 HEAD 是 ${localSha.slice(0, 7)}, 与 master HEAD ${sha.slice(0, 7)} 不是同一个 commit — 拒绝用错的源码做 dev 快照` };
    }
    dir = envDir; source = `local-tree@${(localSha || sha).slice(0, 7)}`;
  } else {
    stage('downloading', `取 GitHub master @ ${sha.slice(0, 7)}`);
    const dl = await downloadGithubSnapshot(sha, opts.workDir, env, opts.timeoutMs ?? 120_000);
    if (!dl.ok) return dl;
    dir = dl.dir; source = dl.source;
  }

  // 身份 = 源码树自己的版本号 + dev.<sha>
  const pkg = readPackageAt(dir);
  if (!pkg?.version) return { ok: false, kind: 'dev_source_failed', reason: 'no_version', detail: `${dir}/package.json 读不到版本` };
  const baseVersion = baseVersionOf(String(pkg.version));
  const identity = devIdentity(baseVersion, sha);
  stage('staged', `打上 dev 身份 ${identity}`);

  // 需要时构建 (GitHub tarball 里没有 dist/; 本地树通常已构建)
  let built = false;
  if (!fs.existsSync(path.join(dir, 'dist', 'cli-entry.js'))) {
    stage('staged', '源码树缺少 dist/, 先装依赖再构建 (npm run build:main)');
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      /**
       * 验收加速开关: 把已有 node_modules 直接软链进来, 跳过 `npm install` (本仓依赖 889MB)。
       * **只省"装依赖"这一步**, 构建与打包仍然真跑 —— 刻意留给验收脚本用, 别在生产路径上设。
       */
      const reuse = env.BOLLOON_DEV_REUSE_NODE_MODULES;
      if (reuse && fs.existsSync(path.join(reuse, '.bin'))) {
        stage('staged', `复用现成依赖 (${reuse}) 跳过 npm install`);
        try { fs.symlinkSync(reuse, path.join(dir, 'node_modules'), 'dir'); } catch { /* 已存在就跳过 */ }
      } else {
        const inst = runNpm(['install', '--no-audit', '--no-fund', '--loglevel=error', '--fetch-retries=5'], dir);
        if (inst.code !== 0) {
          return { ok: false, kind: 'dev_source_failed', reason: 'npm_install_failed', detail: `dev 快照装依赖失败: ${(inst.stderr || inst.stdout).slice(0, 400)}` };
        }
      }
    }
    /**
     * 从 git 源码树构建要**两步** (真跑踩到的坑):
     *   ① `npm run build --workspaces --if-present` —— 先建 workspace 依赖 (@bolloon/constraint-runtime),
     *      否则根包 tsc 会因为 `../constraint-runtime/dist/tools/...` 不存在而直接报 TS2307;
     *   ② `npm run build:main` —— 再建根包 (tsc + copy-constraint-runtime)。
     * 原来只跑 ②, 在**干净源码树**上必失败 —— 这个坑只有真从 git 建一次才会暴露。
     */
    const buildWs = runNpm(['run', 'build', '--workspaces', '--if-present', '--loglevel=error'], dir);
    if (buildWs.code !== 0) {
      return { ok: false, kind: 'dev_source_failed', reason: 'build_failed', detail: `dev 快照构建 workspace 依赖失败: ${(buildWs.stderr || buildWs.stdout).slice(0, 400)}` };
    }
    const build = runNpm(['run', 'build:main'], dir);
    if (build.code !== 0) {
      return { ok: false, kind: 'dev_source_failed', reason: 'build_failed', detail: `dev 快照构建失败: ${(build.stderr || build.stdout).slice(0, 400)}` };
    }
    built = true;
  }

  // 写身份 (改 package.json 的版本身份 + 一个可核对的标记文件)
  const pkgPath = path.join(dir, 'package.json');
  const raw = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
  raw.version = identity;
  await fsp.writeFile(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(dir, '.bolloon-dev-snapshot.json'), JSON.stringify({
    channel: 'dev', ref: `refs/heads/${DEV_BRANCH}`, sha, identity, source, built,
    builtAt: new Date().toISOString(),
    warning: DEV_CHANNEL_WARNING,
  }, null, 2) + '\n', 'utf8');

  // 打包 (产物仍是 tarball → 交给 npm 替换, 不另造一套)
  const pack = runNpm(['pack', dir, '--pack-destination', opts.workDir, '--loglevel=error'], opts.workDir);
  if (pack.code !== 0) {
    return { ok: false, kind: 'dev_source_failed', reason: 'pack_failed', detail: `dev 快照打包失败: ${(pack.stderr || pack.stdout).slice(0, 400)}` };
  }
  const tgzs = (await fsp.readdir(opts.workDir)).filter((f) => f.endsWith('.tgz') && f.includes('bolloon-agent'));
  if (tgzs.length === 0) return { ok: false, kind: 'dev_source_failed', reason: 'no_tarball', detail: 'npm pack 没有产出 tarball' };
  const tarball = path.join(opts.workDir, tgzs.sort()[tgzs.length - 1]);

  return { ok: true, dir, tarball, identity, sha, baseVersion, source, built };
}
