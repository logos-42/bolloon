/**
 * dual-source-facts.ts — 双源的**语义核心** (2026-09-26, update-protocol §12)
 *
 * 为什么从 `dual-source.ts` 里抽出这一半: 手机端 WebView **没有 node:**, 但手机端双源更新
 * 必须用**和桌面同一份**交叉校验 / 错误分类 / dev 快照比较 —— 否则同一件事在电脑上和手机上
 * 会长出两套说法 (而"两个源指向不同版本就拒绝"这种事, 两套说法迟早有一处是错的)。
 *
 * 这里只放**纯函数与类型** (不 import 任何 `node:*`, 不在顶层读 `process.env`):
 *   · GitHub 侧错误分类 `classifyGithubError` (§12.3, 与 registry 侧并列不合并)
 *   · stable 的交叉校验 `crossCheckStable` (§12.1)
 *   · dev 的按 sha 比较 `compareDevSnapshots` (§12.1)
 *   · 事实/报告的紧凑视图 `toGithubReport` / `renderGithubReportLine`
 *
 * 需要网络与子进程的那一半 (真调 api.github.com / codeload 下载 / 现场构建 dev 快照)
 * 仍在 `dual-source.ts` —— 它在这份纯模块之上, 且把这些名字原样再导出。
 *
 * 硬口径 (§12.5, 验收核心, 两边共用):
 *   - 源不可达 / 版本不存在 → **拒绝并说清** (带具体分类), 绝不静默装回旧版
 *   - 不编造不存在的路径: 本仓 GitHub 上**真的没有 Release** (0 个), 所以 "Release 缺" 时
 *     如实报 "发布记录缺 Tag / Release" (提醒级), **不是** fake 一个 Release 出来
 */

import { GITHUB_UPSTREAM_SLUG, DEV_BRANCH, DEV_CHANNEL_WARNING } from './version-identity.js';

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
export const GITHUB_REASONS = ['offline', 'rate_limited', 'not_found', 'http_error', 'parse_error'] as const;
export type GithubReason = typeof GITHUB_REASONS[number];

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

// ── 错误分类 ────────────────────────────────────────────────────────────────

export const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_FAIL', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']);

/**
 * 从**错误链**里挖网络类证据。
 *
 * 为什么不能只看 `err.code`: `fetch()` 抛出来的是 `TypeError: fetch failed`, 真正的 socket 错误挂在
 * `err.cause.code` (undici)。只看 `err.code` ⇒ 连不上的端口会被判成 http_error / registry_unavailable,
 * 于是"源不可达"这一条在真跑里变成**分类错误**(真跑抓到过: 死端口 → registry_unavailable)。
 * 浏览器侧则是 `message: 'Failed to fetch'` / `'Load failed'`。
 */
export function collectNetEvidence(err: any): { code: string; message: string; offline: boolean } {
  const codes: string[] = [];
  const msgs: string[] = [];
  let cur: any = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    // AggregateError (多地址并发失败) 的成员各带一个 code
    const inner = Array.isArray(cur.errors) ? cur.errors : [];
    for (const e of inner) { if (e?.code) codes.push(String(e.code)); if (e?.message) msgs.push(String(e.message)); }
    if (cur.code) codes.push(String(cur.code));
    if (cur.errno) codes.push(String(cur.errno));
    if (cur.message) msgs.push(String(cur.message));
    cur = cur.cause;
  }
  const code = codes.find((c) => OFFLINE_CODES.has(c)) || codes[0] || '';
  const message = msgs.join(' · ');
  const offline = codes.some((c) => OFFLINE_CODES.has(c))
    || /timeout|timed out|ENOTFOUND|getaddrinfo|network|socket hang up|超时|Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET/i.test(message);
  return { code, message, offline };
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
  const net = collectNetEvidence(err);
  if (net.offline) {
    return { kind: 'github_unavailable', reason: 'offline', detail: `${net.code || net.message || '网络不可达'}`, retryAt: null };
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
  return { kind: 'github_unavailable', reason: 'http_error', detail: net.code || net.message || '未知错误', retryAt: null };
}

/** registry 侧错误的分类 (§3) —— 与 `classifyGithubError` **并列, 不合并**。 */
export function classifyRegistryError(err: any, httpStatus?: number): { kind: 'offline' | 'registry_unavailable'; detail: string } {
  const net = collectNetEvidence(err);
  if (net.offline) {
    return { kind: 'offline', detail: `${net.code || net.message || '网络不可达'}` };
  }
  if (httpStatus && httpStatus >= 500) return { kind: 'registry_unavailable', detail: `registry 返回 HTTP ${httpStatus}` };
  if (httpStatus === 404) return { kind: 'registry_unavailable', detail: `registry 上没有该包 (HTTP 404)` };
  if (httpStatus && httpStatus >= 400) return { kind: 'registry_unavailable', detail: `registry 返回 HTTP ${httpStatus}` };
  return { kind: 'registry_unavailable', detail: net.code || net.message || '未知错误' };
}

// ── 版本标签比较 ────────────────────────────────────────────────────────────

/** GitHub 上出现过的最高版本号 (Release ∪ Tag, 去掉 v 前缀)。没有 → null。 */
export function newestGithubVersion(facts: GithubFacts): string | null {
  const all = [...facts.releases, ...facts.tags.map((t) => t.name)]
    .map((n) => String(n).trim().replace(/^v/, ''))
    .filter((n) => /^\d+\.\d+\.\d+/.test(n));
  if (all.length === 0) return null;
  return all.sort((a, b) => (numericCompare(a, b) < 0 ? 1 : -1))[0];
}

/** 只比数值段 (与 version-identity 的 compareVersions 同语义, 这里不再反向依赖它)。 */
export function numericCompare(a: string, b: string): -1 | 0 | 1 {
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
