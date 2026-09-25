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

export { DEV_CHANNEL_WARNING };

// ── 类型 ────────────────────────────────────────────────────────────────────

/**
 * GitHub 侧错误的分类 (§12.3) —— 与 registry 的分类**并列且不合并**:
 *   offline       网络不可达 (ENOTFOUND/EAI_AGAIN/ECONNREFUSED/超时)
 *   rate_limited  HTTP 403/429 (限流; 带重试时间)
 *   not_found     HTTP 404 (没有 Release / 没有 master 分支 / 仓库不存在)
 *   http_error    其它 HTTP 状态 (5xx 等) —— 不塞进上面三类, 免得把"服务有问题"说成"网不通"
 *   parse_error   拿到了内容但解析不了
 */
export type GithubReason = 'offline' | 'rate_limited' | 'not_found' | 'http_error' | 'parse_error';

export interface GithubTag { name: string; sha: string | null }

export interface GithubFacts {
  slug: string;
  ref: string;
  /** master HEAD 的 commit sha (dev 通道的身份来源) */
  headSha: string | null;
  /** Release 的 tag_name 列表 (本仓真的为空数组 —— 如实报, 不编造) */
  releases: string[];
  tags: GithubTag[];
  fetchedAt: string;
  /** 有请求没成功时为 true (facts 是残缺的, 用它的地方必须知道) */
  partial: boolean;
  missing: string[];
}

export type GithubResult =
  | { ok: true; facts: GithubFacts }
  | { ok: false; kind: 'github_unavailable'; reason: GithubReason; detail: string; retryAt: string | null; facts: GithubFacts | null };

/** 给 CheckResult / 状态文件用的紧凑视图 (facts 的完整版太大)。 */
export interface GithubReport {
  reachable: boolean;
  reason?: GithubReason;
  detail?: string;
  retryAt?: string | null;
  headSha?: string | null;
  ref?: string;
  /** GitHub 上最新的**版本标签** (release 或 tag), 没有就是 null */
  newestVersion?: string | null;
  releases?: number;
  tags?: number;
  partial?: boolean;
  fetchedAt?: string;
}

export function toGithubReport(r: GithubResult): GithubReport {
  if (!r.ok) {
    return {
      reachable: false, reason: r.reason, detail: r.detail, retryAt: r.retryAt,
      headSha: r.facts?.headSha ?? null, ref: r.facts?.ref ?? `refs/heads/${DEV_BRANCH}`,
      releases: r.facts?.releases.length, tags: r.facts?.tags.length,
      newestVersion: r.facts ? newestGithubVersion(r.facts) : null,
      partial: r.facts?.partial, fetchedAt: r.facts?.fetchedAt,
    };
  }
  return {
    reachable: true, headSha: r.facts.headSha, ref: r.facts.ref,
    releases: r.facts.releases.length, tags: r.facts.tags.length,
    newestVersion: newestGithubVersion(r.facts), partial: r.facts.partial, fetchedAt: r.facts.fetchedAt,
  };
}

export function renderGithubReportLine(g: GithubReport | null | undefined): string {
  if (!g) return 'GitHub 源: 未查询';
  if (!g.reachable) {
    const retry = g.retryAt ? `, 限流重试时间 ${g.retryAt}` : '';
    return `GitHub 源: 不可达 — github_unavailable(${g.reason}) ${g.detail || ''}${retry}`;
  }
  return `GitHub 源: 可达 · master HEAD ${g.headSha ? g.headSha.slice(0, 7) : '未知'} · Release ${g.releases ?? 0} 个 · Tag ${g.tags ?? 0} 个 · 最新版本标签 ${g.newestVersion || '无'}${g.partial ? ' (部分请求失败)' : ''}`;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_FAIL', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']);

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

/** 网络类 → offline; 403/429 → rate_limited; 404 → not_found; 其它 → http_error。 */
export function classifyGithubError(
  err: any,
  httpStatus?: number,
  headers: Record<string, string> = {},
): { kind: 'github_unavailable'; reason: GithubReason; detail: string; retryAt: string | null } {
  const retryAt = headers['x-ratelimit-reset']
    ? new Date(Number(headers['x-ratelimit-reset']) * 1000).toISOString()
    : null;
  const code = String(err?.code || '');
  if (OFFLINE_CODES.has(code) || /timeout|timed out|ENOTFOUND|getaddrinfo|network|socket hang up|超时/i.test(String(err?.message || ''))) {
    return { kind: 'github_unavailable', reason: 'offline', detail: `${code || err?.message || '网络不可达'}`, retryAt: null };
  }
  if (httpStatus === 403 || httpStatus === 429) {
    return { kind: 'github_unavailable', reason: 'rate_limited', detail: `GitHub 返回 HTTP ${httpStatus} (限流/权限)`, retryAt };
  }
  if (httpStatus === 404) {
    return { kind: 'github_unavailable', reason: 'not_found', detail: `GitHub 上没有 ${GITHUB_UPSTREAM_SLUG} 的该项记录 (HTTP 404)`, retryAt: null };
  }
  if (httpStatus && httpStatus >= 400) {
    return { kind: 'github_unavailable', reason: 'http_error', detail: `GitHub 返回 HTTP ${httpStatus}`, retryAt };
  }
  return { kind: 'github_unavailable', reason: 'http_error', detail: code || err?.message || '未知错误', retryAt: null };
}

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

/** GitHub 上出现过的最高版本号 (Release ∪ Tag, 去掉 v 前缀)。没有 → null。 */
export function newestGithubVersion(facts: GithubFacts): string | null {
  const all = [...facts.releases, ...facts.tags.map((t) => t.name)]
    .map((n) => String(n).trim().replace(/^v/, ''))
    .filter((n) => /^\d+\.\d+\.\d+/.test(n));
  if (all.length === 0) return null;
  return all.sort((a, b) => (numericCompare(a, b) < 0 ? 1 : -1))[0];
}

/** 只比数值段 (与 update-manager 的 compareVersions 同语义, 这里不反向依赖它)。 */
function numericCompare(a: string, b: string): -1 | 0 | 1 {
  const p = (v: string) => v.split('-')[0].split('.').map((x) => parseInt(x.replace(/\D.*$/, ''), 10) || 0);
  const pa = p(a); const pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ── stable: npm ↔ GitHub 交叉校验 ───────────────────────────────────────────

export type CrossCheckKind = 'agree' | 'missing_record' | 'no_record_at_all' | 'mismatch';

export interface CrossCheck {
  kind: CrossCheckKind;
  /** npm 权威给的版本 (dist-tags.latest) */
  registryLatest: string | null;
  /** GitHub 上最高的版本标签 */
  githubVersion: string | null;
  hasTag: boolean;
  hasRelease: boolean;
  releases: number;
  tags: number;
  /** mismatch = 必须拒绝 (阻塞) */
  blocking: boolean;
  detail: string;
}

function hasName(names: string[], v: string): boolean {
  const set = new Set(names.map((n) => String(n).trim().replace(/^v/, '')));
  return set.has(v.replace(/^v/, ''));
}

/**
 * stable 的交叉校验 (§12.1/§12.5): npm 仍是权威, GitHub 只回答"这次发布的记录在不在"。
 *
 *   agree            npm 的 latest 在 GitHub 上有同名 tag/Release → 两条记录指向同一版
 *   mismatch         GitHub 记录了**更新的**版本而 registry 上没有 → 拒绝 (不许按 tag 去装)
 *   missing_record   registry 有该版本但 GitHub 缺这条记录 → **提醒级, 不阻塞** (§12.5 原文:
 *                    "报发布记录缺 Tag (提醒级, 不阻塞 stable 更新)")
 *   no_record_at_all GitHub 上一条版本记录都没有 → 如实报"暂无 tag 可交叉校验"(不编造路径)
 */
export function crossCheckStable(registryLatest: string | null, facts: GithubFacts): CrossCheck {
  const common = {
    registryLatest, githubVersion: newestGithubVersion(facts),
    releases: facts.releases.length, tags: facts.tags.length,
  };
  if (!registryLatest) {
    return { ...common, kind: 'no_record_at_all', hasTag: false, hasRelease: false, blocking: false, detail: 'npm 没有给出 latest, 无从交叉校验' };
  }
  const allNames = [...facts.releases, ...facts.tags.map((t) => t.name)];
  const hasTag = hasName(facts.tags.map((t) => t.name), registryLatest);
  const hasRelease = hasName(facts.releases, registryLatest);
  const ghNewest = common.githubVersion;

  /**
   * **先判"GitHub 记录了比 registry 更新的发布"** —— 这是 §12.5 的 "Release 存在但 registry 上没有该版本 → cross_check_mismatch"。
   * 放在 agree 之前: 即使 registry 的 latest 自己也有 tag, 只要 GitHub 上还多出一条更新的发布记录, 两个源对
   * "当前最新是哪一版"就是不一致的 —— 这种不一致必须拦住, 不能因为"latest 有 tag"就宣布一致。
   */
  if (ghNewest && numericCompare(ghNewest, registryLatest) > 0) {
    return {
      ...common, kind: 'mismatch', hasTag, hasRelease, blocking: true,
      detail: `GitHub 上有 ${ghNewest} 的发布记录, 但 npm registry 的 latest 还是 ${registryLatest} — 拒绝按 GitHub 的记录安装`,
    };
  }
  if (hasTag || hasRelease) {
    return {
      ...common, kind: 'agree', hasTag, hasRelease, blocking: false,
      detail: `npm latest=${registryLatest} 在 GitHub 上有同名记录 (${hasRelease ? `Release v${registryLatest}` : `Tag v${registryLatest}`}) — 两个源指向同一版`,
    };
  }
  if (allNames.length === 0) {
    return {
      ...common, kind: 'no_record_at_all', hasTag: false, hasRelease: false, blocking: false,
      detail: `GitHub 上暂无任何 tag / Release (0 个) — 暂无可交叉校验的记录, npm 仍是权威 (latest=${registryLatest})`,
    };
  }
  return {
    ...common, kind: 'missing_record', hasTag, hasRelease, blocking: false,
    detail: `npm latest=${registryLatest} 在 GitHub 上没有对应记录 (GitHub 最新版本标签 ${ghNewest || '无'}; Release ${facts.releases.length} 个 / Tag ${facts.tags.length} 个) — 发布记录缺 Tag, 不阻塞 stable 更新`,
  };
}

// ── dev: git ref + commit sha 的比较 (不用 semver) ──────────────────────────

export interface DevCheck {
  ref: string;
  /** GitHub master HEAD */
  headSha: string | null;
  /** 当前安装的 dev 快照 sha (非 dev 安装 = null) */
  installedSha: string | null;
  /** 是否同一个 commit */
  same: boolean;
  /** 当前快照落后于 master HEAD (sha 不同) */
  behind: boolean;
  detail: string;
}

export function compareDevSnapshots(installedSha: string | null, headSha: string | null, ref = `refs/heads/${DEV_BRANCH}`): DevCheck {
  const short = (s: string | null) => (s ? s.slice(0, 7) : '未知');
  if (!headSha) {
    return { ref, headSha, installedSha, same: false, behind: false, detail: `${ref} 的 HEAD 读不到 — 无法判定 dev 快照新旧` };
  }
  if (!installedSha) {
    return { ref, headSha, installedSha, same: false, behind: false, detail: `当前不是 dev 快照 (stable 安装) — 切到 dev 将得到 ${ref} @ ${short(headSha)}` };
  }
  const same = installedSha.slice(0, 7) === headSha.slice(0, 7);
  return {
    ref, headSha, installedSha, same, behind: !same,
    detail: same
      ? `已是最新的 dev 快照 (${ref} @ ${short(headSha)}) — 同一个 commit`
      : `dev 快照落后: 已装 ${short(installedSha)} → master HEAD ${short(headSha)} (按 commit sha 判定, 不看版本号)`,
  };
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
