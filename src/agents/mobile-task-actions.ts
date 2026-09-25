/**
 * mobile-task-actions.ts — 手机端**高风险任务动作**的授权载荷 (单一规范, 2026-09-25)
 *
 * 为什么需要它: 手机新增的四项能力里, 有三个是**会对外产生后果**的动作 ——
 *   入群 (让本机进入一个公开 store) · 发任务公告 (把公告发进群 / 往注册表公告) · 过程留痕 (接单/交付/初筛/终审)。
 * 这些动作**不能**只凭"手机发了个 HTTP 请求"就执行: 任何能碰到桌面的本地进程都能伪造这样一个请求。
 * 所以沿用联系方式授权已有的那套纪律 (contacts/grant-payload.ts + mobile-contacts.ts):
 *   **手机展示待发内容 → 用户确认 → 设备私钥 (Ed25519) 签一条规范载荷 → 桌面验签后才执行**。
 *
 * 本文件只放**纯函数与类型** (无 node: 导入), 理由与 grant-payload 相同:
 * 手机 (WebCrypto) 与桌面 (Node crypto) 必须对同一条动作算出**同一个字节串**, 否则签名永远验不过。
 *
 * 三条不可回退的性质:
 *   1. **绑定内容**: 载荷里带 `contentDigest` = sha256(规范化后的动作内容)。桌面在执行前**自己重算一遍**,
 *      对不上就拒 —— 签名对"入群"有效, 就不能被换成一个"发公告"的请求 (类型绑定), 也不能被换内容。
 *   2. **短时效**: `expiresAt - createdAt ≤ TASK_ACTION_TTL_MS`。一张"很久以后还能用"的空白批准等于没有批准。
 *   3. **不带私钥材料**: 载荷里只有 deviceId + 摘要 + 时间, 永远不含私钥/明文。
 *
 * 桌面侧验签实现见 `mobile-task-actions-verify.ts` (node crypto); 手机侧签名见 `src/web/mobile-tasks.ts`。
 */

/** 手机可发起的高风险任务动作 (闭集; 每一项都必须走签名纪律) */
export const MOBILE_TASK_ACTION_KINDS = [
  'group_join',       // 入群 (加入一个 OrbitDB 群 store)
  'group_leave',      // 退群
  'group_create',     // 建群 (会自动入群)
  'announce_publish', // 发布任务公告 (落盘公告 + 向注册表公告 + 记脉冲)
  'announce_to_group',// 把板上的公告推进群里 (CLI: bolloon task announce)
  'trail_post',       // 过程留痕: 接单/交付/初筛/终审 (CLI: bolloon task post)
] as const;
export type MobileTaskActionKind = (typeof MOBILE_TASK_ACTION_KINDS)[number];

/** 参与签名的字段 (顺序即规范顺序, 改动等于换协议版本) */
export const TASK_ACTION_SIGNED_FIELDS = [
  'actionId', 'kind', 'deviceId', 'ownerDid', 'targetRef', 'contentDigest',
  'createdAt', 'expiresAt', 'grantedBy', 'via',
] as const;

/** 动作是干什么的 (人话) —— 手机确认页与桌面错误信息共用 */
export const TASK_ACTION_LABELS: Record<MobileTaskActionKind, { zh: string; en: string }> = {
  group_join: { zh: '加入这个群', en: 'Join this group' },
  group_leave: { zh: '退出这个群', en: 'Leave this group' },
  group_create: { zh: '建一个新群', en: 'Create a new group' },
  announce_publish: { zh: '发布任务公告', en: 'Publish a task announcement' },
  announce_to_group: { zh: '把这条公告发进群', en: 'Post this announcement into the group' },
  trail_post: { zh: '往群里留一条过程痕迹', en: 'Post a process trail entry into the group' },
};

/** 动作的时效上限 (10 分钟)。超过 = 拒 (长命批准 = 没有批准) */
export const TASK_ACTION_TTL_MS = 10 * 60_000;
/** 手机侧默认签多长 (5 分钟): 够用户点一下, 又不会留下一张长期通行证 */
export const TASK_ACTION_DEFAULT_TTL_MS = 5 * 60_000;
/** createdAt 允许的时钟偏移 (桌面/手机不是同一块表) */
export const TASK_ACTION_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * 动作内容 (业务字段) —— 桌面据此**重算** digest。
 * 所有字段都必需出现 (允许 null), 这样"签名时绑的内容"与"执行时看到的内容"是同一段规范化文本。
 */
export interface TaskActionRequest {
  kind: MobileTaskActionKind;
  /** 群 (邀请链接或 groupId) */
  groupRef: string | null;
  /** 公告号 */
  announcementId: string | null;
  /** announce_publish: 能力名 */
  capability: string | null;
  /** announce_publish: 任务正文 (私有, 不进群) */
  instruction: string | null;
  /** announce_publish: 人类单位预算 (如 "0.05") */
  budgetHuman: string | null;
  currency: string | null;
  /** announce_publish: 截止时间 (未来毫秒时间戳) */
  /** 截止时间: 人类写法 (`+2h`/`+1d`) 或未来毫秒时间戳串 —— **由桌面 parseDeadline 解析**, 手机不算时间 */
  deadline: string | null;
  /** 公告的验收判据摘要 (极短, 公开) */
  criteria: string | null;
  /** 群消息附加字段 (round/price/hash/bytes/checks/verdict) */
  round: string | null;
  price: string | null;
  hash: string | null;
  bytes: number | null;
  checks: string | null;
  verdict: string | null;
  /** trail_post 专用: 这条痕迹是哪一类 (claim/deliver/screen/final) */
  trailKind: 'claim' | 'deliver' | 'screen' | 'final' | null;
}

/** 空值一律折成 `-` 并转义分隔符, 保证同一份请求算出的文本**逐字节稳定** */
function tok(v: unknown): string {
  if (v === null || v === undefined) return '-';
  const s = String(v);
  if (!s) return '-';
  // 换行会破坏"一行一字段"的稳定性 (也不该出现在摘要输入里)
  return s.replace(/\r?\n/g, '\\n');
}

/**
 * 规范化动作内容 (唯一实现; 手机与桌面都调它, 再各自做 sha256)。
 * 字段顺序固定 —— 顺序变了等于换协议。
 */
export function taskActionContentText(req: TaskActionRequest): string {
  const kind = String(req?.kind ?? '');
  const base = [
    `kind=${tok(kind)}`,
    `group=${tok(req?.groupRef)}`,
    `ann=${tok(req?.announcementId)}`,
  ];
  if (kind === 'announce_publish') {
    base.push(`cap=${tok(req?.capability)}`);
    base.push(`budget=${tok(req?.budgetHuman)}${req?.currency ? `@${tok(req.currency)}` : ''}`);
    base.push(`deadline=${tok(req?.deadline)}`);
    base.push(`instruction=${tok(req?.instruction)}`);
  } else if (kind === 'announce_to_group') {
    base.push(`criteria=${tok(req?.criteria)}`);
  } else if (kind === 'trail_post') {
    base.push(`trail=${tok(req?.trailKind)}`);
    base.push(`round=${tok(req?.round)}`);
    base.push(`price=${tok(req?.price)}`);
    base.push(`hash=${tok(req?.hash)}`);
    base.push(`bytes=${tok(req?.bytes)}`);
    base.push(`checks=${tok(req?.checks)}`);
    base.push(`verdict=${tok(req?.verdict)}`);
  }
  return base.join('\n');
}

/** 参与签名的动作 (签名副本才有 signature) */
export interface SignableTaskAction {
  actionId: string;
  kind: MobileTaskActionKind;
  /** 手机设备 id (dev-…; 桌面按它查已登记公钥) */
  deviceId: string;
  /** 谁批准的 (本机 owner did; 桌面只用来记账, 不当作身份凭证 —— 身份由签名证明) */
  ownerDid: string;
  /** 动作对象 (群 ref / 公告号; 无对象则空串) */
  targetRef: string;
  /** sha256(规范化动作内容) 的 hex —— 把"要执行的事"钉死在签名里 */
  contentDigest: string;
  createdAt: string;
  expiresAt: string;
  grantedBy: string;
  via: 'mobile';
}

/** 设备签名 (与 contacts 的 GrantSignature 同形, 复用同一套设备登记) */
export interface TaskActionSignature {
  deviceId: string;
  alg: 'ed25519';
  payloadHash: string;
  sig: string;
}

/** 带签名的动作 (手机 → 桌面的请求体) */
export interface SignedTaskAction {
  action: SignableTaskAction;
  signature: TaskActionSignature;
}

/**
 * 规范载荷 (逐字节稳定: 显式字段序 + 空值折 `''`, 不含 signature 自身)。
 * 与 `canonicalGrantPayload` 同风格 —— 两端算出的字节串必须完全一致。
 */
export function canonicalTaskActionPayload(a: SignableTaskAction): string {
  return JSON.stringify({
    actionId: a.actionId, kind: a.kind, deviceId: a.deviceId, ownerDid: a.ownerDid,
    targetRef: a.targetRef || '', contentDigest: a.contentDigest,
    createdAt: a.createdAt, expiresAt: a.expiresAt, grantedBy: a.grantedBy, via: a.via,
  });
}

/** 动作 id 形状 (幂等/追溯用; 不含任何身份材料) */
export function isTaskActionId(id: string): boolean {
  return /^act-[A-Za-z0-9._-]{4,64}$/.test(String(id || '').trim());
}

/** sha256 hex 形状 */
export function isDigestHex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(String(s || '').trim());
}

/** ISO 时间串形状 (可被 Date.parse 解出) */
function isIso(s: unknown): boolean {
  return typeof s === 'string' && s.length >= 20 && Number.isFinite(Date.parse(s));
}

export interface FreshnessResult { ok: boolean; reason?: 'expired' | 'not_yet_valid' | 'ttl_too_long' | 'bad_time' }

/**
 * 时效检查 (桌面与手机都跑):
 *   · createdAt/expiresAt 必须是能解析的 ISO 串
 *   · expiresAt - createdAt ≤ TTL 上限
 *   · now 落在 [createdAt - skew, expiresAt] 之内
 */
export function checkTaskActionFreshness(a: Pick<SignableTaskAction, 'createdAt' | 'expiresAt'>, now: number): FreshnessResult {
  if (!isIso(a?.createdAt) || !isIso(a?.expiresAt)) return { ok: false, reason: 'bad_time' };
  const created = Date.parse(a.createdAt);
  const expires = Date.parse(a.expiresAt);
  if (expires - created > TASK_ACTION_TTL_MS) return { ok: false, reason: 'ttl_too_long' };
  if (expires < created) return { ok: false, reason: 'bad_time' };
  if (now > expires) return { ok: false, reason: 'expired' };
  if (now < created - TASK_ACTION_CLOCK_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
  return { ok: true };
}

/** 载荷形状检查 (验签前的形状闸: 少了字段就别去碰公钥) */
export function checkTaskActionShape(input: unknown): { ok: true; action: SignableTaskAction } | { ok: false; reason: string } {
  const a: any = (input as any)?.action || input;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'missing_action' };
  if (!isTaskActionId(a.actionId)) return { ok: false, reason: 'bad_action_id' };
  if (!(MOBILE_TASK_ACTION_KINDS as readonly string[]).includes(String(a.kind))) return { ok: false, reason: 'unknown_kind' };
  if (!/^dev-[A-Za-z0-9._-]{4,40}$/.test(String(a.deviceId || ''))) return { ok: false, reason: 'bad_device_id' };
  if (!isDigestHex(a.contentDigest)) return { ok: false, reason: 'bad_content_digest' };
  if (a.via !== 'mobile') return { ok: false, reason: 'bad_via' };
  if (!isIso(a.createdAt) || !isIso(a.expiresAt)) return { ok: false, reason: 'bad_time' };
  return { ok: true, action: a as SignableTaskAction };
}

/** 桌面侧: 请求里必须只有**属于这个 kind** 的业务字段 (防止一次入群签名被塞进发公告的字段) */
export function actionKindAllowsRequest(kind: MobileTaskActionKind, req: TaskActionRequest): { ok: boolean; error?: string } {
  const hasGroup = !!(req?.groupRef && String(req.groupRef).trim());
  const hasAnn = !!(req?.announcementId && String(req.announcementId).trim());
  switch (kind) {
    case 'group_join':
      return hasGroup ? { ok: true } : { ok: false, error: '入群需要群链接 (groupRef)' };
    case 'group_leave':
      return hasGroup ? { ok: true } : { ok: false, error: '退群需要群 (groupRef)' };
    case 'group_create':
      return { ok: true };
    case 'announce_publish':
      return hasGroup ? { ok: false, error: '发布公告不进群 (要发进群请用 announce_to_group) —— 这类动作必须分开签' } : { ok: true };
    case 'announce_to_group':
      return hasGroup && hasAnn ? { ok: true } : { ok: false, error: '公告入群需要群 (groupRef) 与公告号 (announcementId)' };
    case 'trail_post':
      if (!hasGroup || !hasAnn) return { ok: false, error: '过程留痕要挂在某一条公告上, 且要指定群 (groupRef + announcementId)' };
      return (['claim', 'deliver', 'screen', 'final'] as readonly string[]).includes(String(req?.trailKind))
        ? { ok: true }
        : { ok: false, error: '过程留痕需要 trailKind (claim|deliver|screen|final)' };
    default:
      return { ok: false, error: `未知动作: ${String((kind as any) || '')}` };
  }
}
