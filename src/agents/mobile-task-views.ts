/**
 * mobile-task-views.ts — 手机端「任务」页的**视图投影** (2026-09-25)
 *
 * 桌面 API 返回的是完整事实 (给机器看的); 手机页面要的是**能直接渲染、且不含标识符**的行。
 * 投影集中放在这里 (纯函数), 因为这几条是硬要求, 必须能被单测钉住:
 *   · **不出现** 原始 DID / peerId / IP / 钱包地址 / 群 store 地址 / 任务正文 —— 每条 id 只给缩短形式
 *   · 群消息里的事实本来就由桌面侧 `summarizeTrail` 遮蔽过 (这里只再挡一道, 不重复造规则表)
 *   · 相对时间给**毫秒差**, 由 UI 只改文字节点 (不在投影里拼字符串, 免得时间一成不变)
 *
 * 词汇表 (中文) 与 `task-group.ts` 的 `TRAIL_KIND_LABEL` 对齐 —— 有单测钉住"不许漂移"。
 */

import { scanPublicText } from './task-public-text.js';

/** id 缩短显示 (前 n 位 + 省略号); 空 → 空串 (不显示 `undefined`) */
export function shortId(id: unknown, n = 12): string {
  const s = String(id ?? '').trim();
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * 协议 id (公告号 / 动作号 / OrbitDB 地址) —— 这些不是 DID/地址, 规则表不认,
 * 但**原文一样不许上手机页面**, 一律走 shortened 形式。
 */
export function isProtocolId(s: unknown): boolean {
  const v = String(s ?? '').trim();
  return /^ann-[0-9a-f]{8,}$/i.test(v)
    || /^act-[a-z0-9-]{6,}$/i.test(v)
    || /^zdpu[0-9a-zA-Z]{8,}$/.test(v)
    || /^\/orbitdb\//.test(v);
}

export type Lang = 'zh' | 'en';

/** 「多久以前 / 还有多久」的人话 (毫秒差 → 双语; UI 只把结果写进文字节点) */
export function formatRelative(ms: number | null, lang: Lang): string {
  if (ms === null || !Number.isFinite(ms)) return lang === 'zh' ? '—' : '—';
  const past = ms >= 0;
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60_000);
  const hr = Math.floor(abs / 3_600_000);
  const day = Math.floor(abs / 86_400_000);
  const unit = day >= 1
    ? (lang === 'zh' ? `${day} 天` : `${day} d`)
    : hr >= 1
      ? (lang === 'zh' ? `${hr} 小时` : `${hr} h`)
      : min >= 1
        ? (lang === 'zh' ? `${min} 分钟` : `${min} min`)
        : (lang === 'zh' ? '不到 1 分钟' : 'under a minute');
  if (lang === 'zh') return past ? `${unit}前` : `${unit}后`;
  return past ? `${unit} ago` : `in ${unit}`;
}

// ── 公告板 ──────────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  open: { zh: '可接单', en: 'Open for claims' },
  claimed: { zh: '已被接单', en: 'Claimed' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  unknown: { zh: '状态未知', en: 'Unknown status' },
};

export interface MobileBoardItem {
  /** 缩短后的公告号 (原文由桌面自己拿着; 页面只显示缩短形式) */
  idShort: string;
  /**
   * 完整公告号 —— **只给 JS 内存里驱动动作用, 不许渲染** (要认哪条公告靠它)。
   * 页面上出现的一律是 idShort。
   */
  ref: string;
  capability: string;
  status: string;
  statusLabel: { zh: string; en: string };
  /** 预算人话 (没预算 → 未声明) */
  budgetLabel: string;
  deadlineInMs: number | null;
  createdAtMs: number | null;
  claimCount: number;
  /** 公开预览 (60 字; 与注册表里那份同源) —— 任务正文**不在这里** */
  preview: string | null;
  remote: boolean;
  claimable: boolean;
  signatureVerified: boolean | null;
}

function budgetLabelOf(b: any): string {
  if (!b || typeof b !== 'object') return '';
  const amt = String(b.maxAmount ?? '').trim();
  if (!amt) return '';
  return `${amt} ${String(b.currency || '').toUpperCase()}${b.network ? ` · ${String(b.network)}` : ''}`;
}

/** 板上的一条 → 手机行 (buyerDid / claimedBy 一律丢弃: 那是身份, 不是手机该显示的东西) */
export function boardItemOf(e: any, now: number): MobileBoardItem {
  const dl = Number.isFinite(Number(e?.deadline)) ? Number(e.deadline) : null;
  const ca = Number.isFinite(Number(e?.createdAt)) ? Number(e.createdAt) : null;
  const status = String(e?.status || 'unknown');
  return {
    idShort: shortId(e?.announcementId),
    ref: String(e?.announcementId || ''),
    capability: String(e?.capability || ''),
    status,
    statusLabel: STATUS_LABELS[status] || STATUS_LABELS.unknown,
    budgetLabel: budgetLabelOf(e?.budget),
    deadlineInMs: dl === null ? null : dl - now,
    createdAtMs: ca,
    claimCount: Number.isFinite(Number(e?.claimCount)) ? Number(e.claimCount) : 0,
    preview: e?.instructionPreview ? String(e.instructionPreview).slice(0, 120) : null,
    remote: !!e?.remote,
    claimable: !!e?.claimable,
    signatureVerified: e?.signatureVerified === true ? true : (e?.signatureVerified === false ? false : null),
  };
}

export interface MobileBoardView {
  items: MobileBoardItem[];
  localCount: number;
  remoteCount: number;
  registryReady: boolean;
  registryError: string | null;
  notes: string[];
  openCount: number;
}

export function buildBoardView(view: any, now: number): MobileBoardView {
  const items = (Array.isArray(view?.entries) ? view.entries : []).map((e: any) => boardItemOf(e, now));
  return {
    items,
    localCount: Number(view?.localCount) || 0,
    remoteCount: Number(view?.remoteCount) || 0,
    registryReady: view?.registryReady === true,
    registryError: view?.registryError ? String(view.registryError).slice(0, 160) : null,
    notes: Array.isArray(view?.notes) ? view.notes.map((n: any) => String(n)) : [],
    openCount: items.filter((i: MobileBoardItem) => i.claimable).length,
  };
}

// ── 过程痕迹 (trail) ────────────────────────────────────────────────────────

export const TRAIL_KIND_LABELS: Record<string, { zh: string; en: string }> = {
  announce: { zh: '公告', en: 'Announce' },
  claim: { zh: '接单声明', en: 'Claim' },
  deliver: { zh: '交付', en: 'Delivery' },
  screen: { zh: '初筛结果', en: 'Screening' },
  final: { zh: '终审结论', en: 'Final verdict' },
};

export const INCONSISTENCY_LABELS: Record<string, { zh: string; en: string }> = {
  'final-accept-without-delivery': { zh: '说通过了, 但群里没有交付痕迹', en: 'Accepted, but no delivery trace in the group' },
  'screen-without-delivery': { zh: '有初筛结果, 但没有交付痕迹', en: 'Screening exists without a delivery trace' },
  'claim-without-announce': { zh: '有人接单, 但群里没有公告痕迹', en: 'Claim without an announcement trace' },
  'deliver-without-claim': { zh: '有交付, 但没人接过单', en: 'Delivery without a claim' },
  'both-accept-and-reject': { zh: '同时出现通过和拒绝', en: 'Both accepted and rejected appear' },
  'group-message-hit-privacy-rule': { zh: '群里有人发了带标识符的消息 (已遮蔽, 不当事实采用)', en: 'A group message hit a privacy rule (masked, not used as fact)' },
};

export interface MobileTrailEntry {
  /** 缩短后的公告号 (只作引用) */
  idShort: string;
  kind: string;
  kindLabel: { zh: string; en: string };
  sender: string;
  atMs: number;
  facts: Array<{ k: string; v: string }>;
}

export interface MobileTrailView {
  count: number;
  byKind: Record<string, number>;
  entries: MobileTrailEntry[];
  announcementIdsShort: string[];
  flags: Record<string, boolean>;
  inconsistencies: Array<{ code: string; label: { zh: string; en: string } }>;
  redactedCount: number;
  ignoredMessages: number;
  /** 事实是否经过隐私遮蔽 (读回也可能是泄漏面的提醒) */
  privacyHits: boolean;
}

/**
 * 时间线 → 手机行 (字段再过一遍规则表: 命中就只报规则名, 不回显内容)
 *
 * 2026-09-25: 除了规则表,**协议 id 一律缩短**。原因: `ann-<16hex>` 不是 DID/地址, 规则表不认它,
 * 但它就是公告号原文 —— 手机页面上不许出现 (要认哪条公告用缩短形式 + 页面自己按行索引回填)。
 */
export function buildTrailView(summary: any): MobileTrailView {
  const entries: MobileTrailEntry[] = (Array.isArray(summary?.entries) ? summary.entries : []).map((e: any) => {
    const facts: Array<{ k: string; v: string }> = [];
    for (const [k, v] of Object.entries(e?.fields || {})) {
      if (k === 'kind') continue;
      const raw = String(v ?? '');
      const hit = scanPublicText(raw);
      if (hit.length) { facts.push({ k: String(k), v: `[已遮蔽:${hit[0].rule}]` }); continue; }
      facts.push({ k: String(k), v: k === 'id' || isProtocolId(raw) ? shortId(raw) : raw });
    }
    const kind = String(e?.kind || '');
    return {
      idShort: shortId(e?.announcementId),
      kind,
      kindLabel: TRAIL_KIND_LABELS[kind] || { zh: kind, en: kind },
      sender: String(e?.sender || 'unknown'),
      atMs: Number.isFinite(Number(e?.at)) ? Number(e.at) : 0,
      facts,
    };
  });
  const inc: Array<{ code: string; label: { zh: string; en: string } }> =
    (Array.isArray(summary?.inconsistencies) ? summary.inconsistencies : []).map((c: any) => ({
      code: String(c),
      label: INCONSISTENCY_LABELS[String(c)] || { zh: String(c), en: String(c) },
    }));
  return {
    count: Number(summary?.count) || entries.length,
    byKind: (summary?.byKind || {}) as Record<string, number>,
    entries,
    announcementIdsShort: (Array.isArray(summary?.announcements) ? summary.announcements : []).map((a: any) => shortId(a)),
    flags: (summary?.flags || {}) as Record<string, boolean>,
    inconsistencies: inc,
    redactedCount: Array.isArray(summary?.redacted) ? summary.redacted.length : 0,
    ignoredMessages: Number(summary?.ignoredMessages) || 0,
    privacyHits: inc.some((x) => x.code === 'group-message-hit-privacy-rule') || (Array.isArray(summary?.redacted) && summary.redacted.length > 0),
  };
}

// ── 群列表 ──────────────────────────────────────────────────────────────────

export interface MobileGroupItem { idShort: string; name: string; joinedAt: string }

/** 本机已加入的群 → 手机行 (store 地址/邀请链接都不在这里: 要链接得显式取, 与 CLI 同一纪律) */
export function buildGroupsView(groups: any[]): MobileGroupItem[] {
  return (Array.isArray(groups) ? groups : []).map((g: any) => ({
    idShort: shortId(g?.id),
    name: String(g?.name || ''),
    joinedAt: String(g?.createdAt || ''),
  }));
}

// ── 动作请求 → 确认页文案 (展示待发内容) ────────────────────────────────────

/** 把动作请求压成"你将要发出什么"的人话 (确认页用; 文案里不含标识符) */
export function describeTaskActionForConfirm(
  kind: string, req: any,
): { titleZh: string; titleEn: string; lines: Array<{ k: string; kEn: string; v: string }> } {
  const lines: Array<{ k: string; kEn: string; v: string }> = [];
  const push = (k: string, kEn: string, v: unknown) => { const s = String(v ?? '').trim(); if (s && s !== '-') lines.push({ k, kEn, v: s }); };
  push('群', 'group', req?.groupRef ? shortId(req.groupRef, 24) : '');
  push('公告号', 'announcement', req?.announcementId ? shortId(req.announcementId) : '');
  push('能力', 'capability', req?.capability);
  push('预算', 'budget', req?.budgetHuman ? `${req.budgetHuman} ${String(req?.currency || '').toUpperCase()}` : '');
  push('任务正文', 'instruction', req?.instruction);
  push('截止', 'deadline', req?.deadline);
  push('验收判据', 'criteria', req?.criteria);
  push('期号', 'round', req?.round);
  push('痕迹类型', 'trail kind', req?.trailKind ? (TRAIL_KIND_LABELS[String(req.trailKind)]?.zh || String(req.trailKind)) : '');
  push('声明价格', 'declared price', req?.price);
  push('交付哈希', 'delivery hash', req?.hash);
  push('字节数', 'bytes', req?.bytes);
  push('逐条初筛', 'per-item screen', req?.checks);
  push('终审结论', 'final verdict', req?.verdict);
  const titles: Record<string, { zh: string; en: string }> = {
    group_join: { zh: '加入这个群', en: 'Join this group' },
    group_leave: { zh: '退出这个群', en: 'Leave this group' },
    group_create: { zh: '建一个新群', en: 'Create a new group' },
    announce_publish: { zh: '发布任务公告', en: 'Publish a task announcement' },
    announce_to_group: { zh: '把这期公告发进群', en: 'Post this announcement into the group' },
    trail_post: { zh: '往群里留一条过程痕迹', en: 'Post a process trail entry into the group' },
  };
  const t = titles[String(kind)] || { zh: '执行这个动作', en: 'Run this action' };
  return { titleZh: t.zh, titleEn: t.en, lines };
}
