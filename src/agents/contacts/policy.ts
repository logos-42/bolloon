/**
 * contacts/policy.ts — 联系方式调用策略门 (2026-09-19, Phase 6)
 *
 * 联系方式是高风险动作, **不许直接暴露给 Agent**。调用链固定:
 *   Agent → PiAgentHarness → contact policy → consent → recipient → rate → preview → provider → send → evidence
 *
 * 本文件只做"能不能发/要不要人批"的判定 + 可审计预览, 不碰 provider、不写盘。
 * 判定顺序固定, 每种拒绝都给出**机器可读的 blockKind** (供测试与审计), 不返回泛泛的"不允许"。
 */

import { readGoal } from '../goal-store.js';
import { evaluateGrant, categoriesOf, type ContactGrant, type GrantBlockKind, type GrantLevel } from './grants.js';
import { scanForbidden } from './types.js';
import { type ContactsStore } from './store.js';
import { type ContactLimits, type ContactPreview } from './preview-types.js';
import { type VerifiedContact, scanSensitive, type SensitiveFinding } from './types.js';

export type BlockKind =
  | 'not_found'
  | 'unverified_contact'
  | 'consent_revoked'
  | 'verification_expired'
  | 'contact_blocked'
  | 'provider_not_configured'
  | 'batch_forbidden'
  | 'not_bound_to_task'
  | 'rate_limited'
  | 'goal_closed'
  | 'policy_draft_only'
  | 'duplicate_request'
  | 'missing_content'
  // 2026-09-19 (持久授权)
  | 'grant_denied'                 // 硬拒: 撤销/暂停/范围外/设备不可信/版本冲突/存储损坏
  | 'forbidden_content_category';  // 凭证/资金指令/合同承诺 —— 任何等级都不放行

export interface PolicyInput {
  action: 'send' | 'preview' | 'await_reply' | 'revoke' | 'list';
  contactId?: string;
  goalId?: string;
  runId?: string;
  /** 任务类型 (consentScope.kinds 里匹配) */
  taskKind?: string;
  subject?: string;
  body?: string;
  /** 收件人列表 —— 长度 >1 一律拒绝 (批量永远禁止) */
  recipients?: string[];
  requestId?: string;
}

export interface GrantFinder {
  activeFor(ownerDid: string, now?: number): Promise<ContactGrant | null>;
  /** 管辖 Grant (含撤销/暂停状态) —— 有它才能给出精确的 grant_revoked/grant_suspended */
  latestFor?: (ownerDid: string) => Promise<ContactGrant | null>;
  /** 确保 Grant 事实已载入 (corrupt 标志只有载入后才可信) */
  ready?: () => Promise<void>;
  corrupt?: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  /** 持久授权判定结果 (Phase 5) */
  grant?: { grantId: string; level: GrantLevel; version: number };
  grantBlock?: GrantBlockKind;
  grantMissing?: boolean;
  authorizationMode: 'one_time' | 'persistent' | 'full_contact_access';
  approvalSkipped: boolean;
  policyDecision: string;
  forbiddenCategories: string[];
  blockKind?: BlockKind;
  reason?: string;
  /** 为什么需要批准: first_contact / sensitive_content / policy / each_time / not_auto_authorized */
  approvalReason?: 'first_contact' | 'sensitive_content' | 'policy' | 'each_time';
  sensitive: SensitiveFinding[];
  firstContact: boolean;
  /** 通道是不是"真外发" (本地落盘 = false, 预览与证据都要说清) */
  reallySent: boolean;
  preview?: ContactPreview;
  usage?: { today: number; todayMax: number; forGoal: number; goalMax: number };
}

const CHANNEL_LABEL: Record<string, string> = {
  'local-sink': '本地落盘 (未真实外发)',
  'http-webhook': '短信网关 HTTP (真实外发)',
  smtp: 'SMTP 邮件 (真实外发)',
};

function reallySentFor(provider: string): boolean {
  return provider === 'smtp' || provider === 'http-webhook';
}

/** 任务级 auto_send 授权: 用户明确给某个 Goal 开过才行 (默认没有) */
export function taskAutoAuthorized(goal: { continuation?: any } | null, contact: VerifiedContact): boolean {
  if (!goal) return false;
  const flag = (goal.continuation as any)?.autoSendContacts;
  if (flag !== true) return false;
  if (contact.policy !== 'auto_send' && contact.policy !== 'send_after_approval') return false;
  if (contact.limits.requireApprovalEachTime) return false;
  return true;
}

export interface PolicyCtx {
  store: ContactsStore;
  /** 持久授权事实 (没有 = 退回一次性批准) */
  grants?: GrantFinder;
  /** matching_goals 范围靠它判定 */
  goalMatchesGrant?: (grant: ContactGrant, goalId: string) => boolean;
  /** 设备是否可信 (同步来的 Grant 必须来自已登记设备) */
  deviceTrusted?: (deviceId: string) => boolean;
  /** 注入: 该 contact 是否历史上成功发送过 (首次联系判定) */
  hasSentBefore?: (contactId: string) => Promise<boolean>;
  /** 注入: 这个 requestId 是否已有待批准请求 (避免重复排队) */
  hasPendingConsent?: (requestId: string) => Promise<boolean>;
  now?: () => number;
}

export async function decideContactAction(input: PolicyInput, ctx: PolicyCtx): Promise<PolicyDecision> {
  const now = ctx.now ? ctx.now() : Date.now();
  const base: PolicyDecision = {
    allowed: false, requiresApproval: false, sensitive: [], firstContact: false, reallySent: false,
    authorizationMode: 'one_time', approvalSkipped: false, policyDecision: 'not_evaluated', forbiddenCategories: [],
  };

  if (input.action === 'list') return { ...base, allowed: true };

  if (!input.contactId) return { ...base, blockKind: 'not_found', reason: '缺少 contactId (禁止按模糊姓名自动发送)' };
  const contact = await ctx.store.getContact(input.contactId);
  if (!contact) return { ...base, blockKind: 'not_found', reason: `contactId=${input.contactId} 不存在` };

  // 1) 验证状态
  if (contact.revokedAt || contact.verificationStatus === 'revoked') {
    return { ...base, blockKind: 'consent_revoked', reason: '授权已被撤销 —— 历史证据保留, 但后续调用一律拒绝' };
  }
  if (contact.verificationStatus === 'blocked') return { ...base, blockKind: 'contact_blocked', reason: '该联系方式已被标记 blocked' };
  if (contact.verificationStatus === 'expired') return { ...base, blockKind: 'verification_expired', reason: '验证已过期, 需重新验证' };
  if (contact.verificationStatus !== 'verified') {
    return { ...base, blockKind: 'unverified_contact', reason: `未验证的联系方式不能用于真实发送 (当前 ${contact.verificationStatus})` };
  }

  // 2) 通道是否配置好
  const reallySent = reallySentFor(contact.provider);
  if (reallySent && contact.secretRef && !(await ctx.store.secrets.has(contact.secretRef))) {
    return { ...base, reallySent, blockKind: 'provider_not_configured', reason: `通道 ${contact.provider} 需要 secretRef=${contact.secretRef}, 但 Secret Store 里没有` };
  }

  // 3) 批量永远禁止
  const recipients = input.recipients || [input.contactId];
  if (recipients.length > 1) {
    return { ...base, reallySent, blockKind: 'batch_forbidden', reason: `批量发送永远禁止 (收到 ${recipients.length} 个收件人)` };
  }

  // 4) 正常发送才要求正文
  if ((input.action === 'send' || input.action === 'preview') && !input.body) {
    return { ...base, reallySent, blockKind: 'missing_content', reason: '缺少正文' };
  }

  // 7) 频率限制
  const limits: ContactLimits = contact.limits || { dailyMax: 5, perTaskMax: 3, requireApprovalEachTime: false };
  const today = await ctx.store.countSentToday(contact.contactId, now);
  const forGoal = input.goalId ? await ctx.store.countSentForGoal(input.goalId) : 0;
  const usage = { today, todayMax: limits.dailyMax, forGoal, goalMax: limits.perTaskMax };
  // 7.5) 持久授权判定 (Phase 5): Grant 是否存在/有效/覆盖 channel·contact·task·content
  const forbidden = scanForbidden(`${input.subject || ''}\n${input.body || ''}`);
  base.forbiddenCategories = forbidden;
  const sensitiveEarly = scanSensitive(`${input.subject || ''}\n${input.body || ''}`);
  const scope0 = contact.consentScope || { kinds: [] as string[], taskRefs: [] as string[], grantedAt: '', grantedBy: '' };
  const limits0: ContactLimits = contact.limits || { dailyMax: 5, perTaskMax: 3, requireApprovalEachTime: false };
  const usage0 = {
    today: await ctx.store.countSentToday(contact.contactId, now),
    todayMax: limits0.dailyMax,
    forGoal: input.goalId ? await ctx.store.countSentForGoal(input.goalId) : 0,
    goalMax: limits0.perTaskMax,
  };
  let grantEval: ReturnType<typeof evaluateGrant> | null = null;
  if (ctx.grants?.ready) await ctx.grants.ready();
  if (ctx.grants?.corrupt) {
    // Grant 存储读不出来 → **拒绝自动发送**, 且大声说出来 (不静默当成"无权限"或"已授权")
    base.grantBlock = 'grant_store_unreadable';
    base.policyDecision = 'grant_store_unreadable:refuse_auto_send';
    base.authorizationMode = 'one_time';
    return { ...base, reallySent, usage: usage0, allowed: true, requiresApproval: true,
      approvalReason: 'policy',
      reason: '联系方式授权文件损坏/不可读 → 已拒绝自动发送, 需要人工批准并修复 grants.json (不会静默当成无权限或已授权)' };
  }
  if (ctx.grants) {
    // 优先拿"管辖 Grant"(含撤销/暂停) 以给出精确原因; 拿不到再退到 activeFor
    const g = ctx.grants.latestFor
      ? await ctx.grants.latestFor(contact.ownerDid)
      : await ctx.grants.activeFor(contact.ownerDid, now);
    grantEval = evaluateGrant(g, {
      ownerDid: contact.ownerDid,
      channel: contact.kind,
      contactId: contact.contactId,
      contactVerified: contact.verificationStatus === 'verified',
      contactRevoked: !!contact.revokedAt,
      taskBoundToGoal: !!input.goalId && scope0.taskRefs.includes(input.goalId!),
      goalId: input.goalId,
      goalMatchesGrant: ctx.goalMatchesGrant,
      sensitiveCategories: categoriesOf(sensitiveEarly),
      hasForbiddenContent: forbidden.length > 0,
      deviceTrusted: ctx.deviceTrusted,
    }, now);
    if (grantEval.grant) base.grant = { grantId: grantEval.grant.grantId, level: grantEval.grant.level, version: grantEval.grant.grantVersion };
    base.authorizationMode = grantEval.authorizationMode;
    base.approvalSkipped = grantEval.approvalSkipped;
    base.policyDecision = grantEval.policyDecision;
    if (!grantEval.ok) {
      // 硬拒 (撤销/暂停/范围外/禁放行类别/设备不可信) → 直接不允许
      // 例外: grant_missing / grant_suspended / grant_sensitive_content_denied → 退回人工批准 (不是"不允许")
      const soft = grantEval.needsHumanApproval && (grantEval.block === 'grant_missing' || grantEval.block === 'grant_suspended' || grantEval.block === 'grant_sensitive_content_denied');
      base.grantBlock = grantEval.block;
      base.grantMissing = grantEval.block === 'grant_missing';
      if (!soft) {
        return { ...base, reallySent, usage: usage0,
          blockKind: grantEval.block === 'forbidden_content_category' ? 'forbidden_content_category' : 'grant_denied',
          reason: grantEval.reason };
      }
      base.approvalReason = grantEval.block === 'grant_sensitive_content_denied' ? 'sensitive_content' : 'policy';
    }
  }

  // 8) contact 级硬禁 (与任务无关): draft_only
  if (contact.policy === 'draft_only' && input.action === 'send') {
    return { ...base, reallySent, usage, blockKind: 'policy_draft_only', reason: '该联系方式策略为 draft_only (只允许起草, 不允许发送)' };
  }

  // 8.5) 同一 requestId 不得重复发送 (幂等)
  if (input.action === 'send' && input.requestId) {
    const prior = await ctx.store.findSend(input.requestId);
    if (prior && prior.status === 'sent') {
      return { ...base, reallySent, usage, blockKind: 'duplicate_request', reason: `requestId=${input.requestId} 已经发送过 (状态 ${prior.status}), 不重复发送` };
    }
    if (ctx.hasPendingConsent && await ctx.hasPendingConsent(input.requestId)) {
      return { ...base, reallySent, usage, blockKind: 'duplicate_request', reason: `requestId=${input.requestId} 已有待批准请求, 不重复排队` };
    }
  }

  // 8.6) 频率限制 (contact 级 + 任务级)
  if (input.action === 'send' && today >= limits.dailyMax) {
    return { ...base, reallySent, usage, blockKind: 'rate_limited', reason: `今日已发 ${today}/${limits.dailyMax} 条, 超出发送频率` };
  }
  if (input.action === 'send' && input.goalId && forGoal >= limits.perTaskMax) {
    return { ...base, reallySent, usage, blockKind: 'rate_limited', reason: `本任务已发 ${forGoal}/${limits.perTaskMax} 条, 超出任务上限` };
  }

  // 8.7) 任务边界: 是否绑定到这个任务 (发送必须有任务归属)
  let goal: Awaited<ReturnType<typeof readGoal>> = null;
  if (input.goalId) {
    goal = await readGoal(input.goalId);
    if (!goal) return { ...base, reallySent, blockKind: 'not_bound_to_task', reason: `goalId=${input.goalId} 不存在` };
    if (goal.status === 'completed' || goal.status === 'failed') {
      return { ...base, reallySent, usage, blockKind: 'goal_closed', reason: `任务已 ${goal.status}, 不允许再对外发送` };
    }
  }
  const scope = contact.consentScope || { kinds: [], taskRefs: [], grantedAt: '', grantedBy: '' };
  const boundToTask = !!input.goalId && (scope.taskRefs.includes(input.goalId) || (!!input.taskKind && scope.kinds.includes(input.taskKind)) || scope.kinds.includes('any'));
  // "范围被授权覆盖" = 授权有效, 或只是内容敏感/暂停这类**软**情形 (软情形退回一次性人工批准,
  //   而不是报"未绑定任务"这种会误导人的原因)
  const SOFT_GRANT_COVER = new Set(['grant_sensitive_content_denied', 'grant_suspended']);
  const coveredByGrant = !!(grantEval && (grantEval.ok || (!!grantEval.block && SOFT_GRANT_COVER.has(grantEval.block))));
  if (input.action === 'send' && !boundToTask && !coveredByGrant) {
    return { ...base, reallySent, usage, blockKind: 'not_bound_to_task',
      reason: `该联系方式没有授权给任务 ${input.goalId || '(未指定)'} (未绑定任务联系人, 也没有覆盖它的长期授权)` };
  }

  // 9) 需要人工批准的几种情况
  const sensitive = sensitiveEarly;
  const firstContact = !(ctx.hasSentBefore ? await ctx.hasSentBefore(contact.contactId) : (await ctx.store.listSends()).some((s) => s.contactId === contact.contactId && s.status === 'sent'));
  let requiresApproval = false;
  let approvalReason: PolicyDecision['approvalReason'];
  // 持久授权命中且允许自动发送 → 跳过人工批准 (但下面的检查一个都不少)
  if (grantEval && grantEval.ok && grantEval.approvalSkipped) {
    requiresApproval = false;
    approvalReason = undefined;
  } else if (firstContact && !(grantEval && grantEval.needsHumanApproval)) {
    requiresApproval = true; approvalReason = 'first_contact';
  } else if (grantEval && !grantEval.ok && grantEval.needsHumanApproval) {
    requiresApproval = true; approvalReason = base.approvalReason || 'policy';
  }
  else if (sensitive.length > 0) { requiresApproval = true; approvalReason = 'sensitive_content'; }
  else if (limits.requireApprovalEachTime) { requiresApproval = true; approvalReason = 'each_time'; }
  else if (contact.policy === 'send_after_approval' && !taskAutoAuthorized(goal, contact)) { requiresApproval = true; approvalReason = 'policy'; }

  return {
    allowed: true,
    requiresApproval,
    approvalReason,
    sensitive,
    firstContact,
    reallySent,
    usage,
    grant: base.grant,
    grantBlock: base.grantBlock,
    grantMissing: base.grantMissing,
    authorizationMode: base.authorizationMode,
    approvalSkipped: requiresApproval ? false : base.approvalSkipped,
    policyDecision: base.policyDecision,
    forbiddenCategories: base.forbiddenCategories,
    preview: buildPreview({ contact, input, reallySent, sensitive, firstContact, requiresApproval, approvalReason, usage, goal }),
  };
}

// ── 可审计预览 ──────────────────────────────────────────────────────────────

export interface PreviewBuild {
  contact: VerifiedContact;
  input: PolicyInput;
  reallySent: boolean;
  sensitive: SensitiveFinding[];
  firstContact: boolean;
  requiresApproval: boolean;
  approvalReason?: PolicyDecision['approvalReason'];
  usage: { today: number; todayMax: number; forGoal: number; goalMax: number };
  goal: { goalId: string; objective: string } | null;
}

export function buildPreview(b: PreviewBuild): ContactPreview {
  const name = (b.contact.aliases && b.contact.aliases[0]) || b.contact.displayValue;
  return {
    contactName: name,
    channel: b.contact.kind,
    provider: b.contact.provider,
    channelLabel: CHANNEL_LABEL[b.contact.provider] || b.contact.provider,
    reallySent: b.reallySent,
    recipient: b.contact.displayValue,      // 只有脱敏值
    subject: b.input.subject,
    goalId: b.input.goalId,
    goalObjective: b.goal?.objective,
    permission: '单条发送 (批量永远禁止)',
    usage: b.usage,
    replyExpected: undefined,
    firstContact: b.firstContact,
    requiresApproval: b.requiresApproval,
    approvalReason: b.approvalReason,
    sensitive: b.sensitive.map((s) => `${s.kind}: ${s.hint}`),
    lines: [
      '将联系:',
      `  联系人: ${name}`,
      `  通道: ${b.contact.kind === 'phone' ? '手机号' : '邮箱'} · ${CHANNEL_LABEL[b.contact.provider] || b.contact.provider}`,
      `  收件人: ${b.contact.displayValue} (脱敏)`,
      b.input.subject ? `  主题: ${b.input.subject}` : '  主题: (无)',
      `  任务: ${b.input.goalId || '(未绑定任务)'}${b.goal?.objective ? ` — ${String(b.goal.objective).slice(0, 60)}` : ''}`,
      `  权限: 单条发送 (今日 ${b.usage.today}/${b.usage.todayMax} · 本任务 ${b.usage.forGoal}/${b.usage.goalMax})`,
      `  首次联系: ${b.firstContact ? '是 (必须人工批准)' : '否'}`,
      `  敏感内容: ${b.sensitive.length ? b.sensitive.map((s) => s.kind).join(', ') + ' (必须人工批准)' : '无'}`,
      `  是否需要批准: ${b.requiresApproval ? `是 (${b.approvalReason || 'policy'})` : '否'}`,
    ],
  };
}

/** 人读渲染 (CLI / Web 卡片 / 审批流程都用这一份) */
export function renderPreview(p: ContactPreview): string {
  return p.lines.join('\n');
}

export { type ContactPreview, type ContactLimits } from './preview-types.js';
