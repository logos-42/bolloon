/**
 * routes-mobile-tasks.ts — 手机端「任务协作」的桌面 API (2026-09-25)
 *
 * 为什么需要这一层: 群的 store (OrbitDB) 与公告板 (落盘 + 注册表) 都在**桌面节点**上,
 * 手机 WebView 跑不了它们。所以手机只做三件事 —— **输入 · 展示待发内容 · 设备签名**,
 * 真正的执行一律回到桌面, 而且**调用与 CLI 完全相同的函数**
 * (`gateway-group.ts` / `task-group.ts` / `task-board.ts`), 因此:
 *   同一份存储 · 同一套协议 · 同一条隐私闸 —— 手机**不是**第二个权威源。
 *
 * 三条硬纪律 (与项目「手机=授权, 桌面=执行」的分工一致):
 *   1. **高风险动作必须带设备签名** (`verdict` 由 `mobile-task-actions-verify.ts` 给出):
 *      入群/退群/建群/发公告/公告入群/过程留痕 一律先验签, 且签名**绑定内容摘要** —— 换类型/换内容都验不过。
 *   2. **读接口只回脱敏事实**: 群里只有短引用, 板上的 buyerDid 不出门 (手机按自己的一份视图投影再挡一道)。
 *   3. **失败如实说**: 群不存在/没入群/桌面没身份/注册表不可达 → 结构化失败 + 人话原因, 不静默降级成"只写本地"。
 */

import type { Express } from 'express';
import { ContactChain } from '../agents/contacts/chain.js';
import { verifyTaskAction } from '../agents/mobile-task-actions-verify.js';
import type { DeviceKey } from '../agents/contacts/grants.js';
import type { SignedTaskAction, TaskActionRequest } from '../agents/mobile-task-actions.js';
import { buildMobileFlywheelView } from '../agents/mobile-flywheel-view.js';
import { shortId } from '../agents/mobile-task-views.js';

export interface MobileTaskRouteOpts {
  /** 测试注入: 设备公钥列表 (默认走 ContactChain) */
  devices?: DeviceKey[];
  home?: string;
  ownerDid?: string;
  /** 现在 (测试注入) */
  now?: () => number;
}

function fail(res: any, status: number, code: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ ok: false, code, error, ...extra });
}

/** 把任意异常翻成人话 (不吞: 原文截断带上) */
function reasonOf(e: any, max = 200): string {
  return String(e?.message || e || '未知原因').slice(0, max);
}

/** 「本机身份」——公告必须有可追责的买方; 没有身份就拒 (与 CLI publish 一致) */
async function localSignerOrNull(): Promise<{ did: string; publicKeyHex: string; keypair: unknown } | null> {
  try {
    const { loadLocalSigner } = await import('../agents/local-signer.js');
    const s = await loadLocalSigner();
    return s ? { did: s.did, publicKeyHex: s.publicKeyHex, keypair: s.keypair } : null;
  } catch { return null; }
}

export function registerMobileTaskRoutes(app: Express, opts: MobileTaskRouteOpts = {}): void {
  const now = () => (opts.now ? opts.now() : Date.now());

  const chainFor = (ownerDid?: string) => new ContactChain({
    home: opts.home,
    ownerDid: ownerDid || opts.ownerDid || 'did:bolln:local',
    displayName: '本机用户',
  });

  /** 已登记设备公钥 (手机签名只认这些) —— 注入优先 (单测不起真实 store) */
  async function deviceKeyOf(deviceId: string, ownerDid: string): Promise<DeviceKey | null> {
    if (opts.devices) return opts.devices.find((d) => d.deviceId === deviceId) || null;
    try {
      const list = await chainFor(ownerDid).grants.listDevices();
      return list.find((d) => d.deviceId === deviceId) || null;
    } catch { return null; }
  }

  /**
   * 高风险动作的统一入口: 形状 → 设备已登记 → 签名 → 时效 → 内容摘要。
   * 任何一项不过都**不执行** (fail-closed)。
   */
  async function authorize(req: any, res: any, kind: TaskActionRequest['kind']): Promise<{ ok: false } | { ok: true; req: TaskActionRequest }> {
    const request = (req?.body?.request || {}) as TaskActionRequest;
    const signed = { action: req?.body?.action, signature: req?.body?.signature } as unknown as SignedTaskAction;
    if (!request || String(request.kind || '') !== String(kind)) {
      fail(res, 400, 'REQUEST_KIND_MISMATCH', `请求类型与路由不一致 (路由要求 ${kind}, 收到 ${String(request?.kind || '无')})`);
      return { ok: false };
    }
    const deviceId = String((signed as any)?.action?.deviceId || '');
    const pub = deviceId ? await deviceKeyOf(deviceId, String((signed as any)?.action?.ownerDid || '')) : null;
    const v = verifyTaskAction(signed, pub, { req: request, now: now() });
    if (!v.ok) {
      fail(res, 403, 'SIGNATURE_REJECTED', `手机签名没通过: ${v.message || v.reason}`, { reason: v.reason, action: shortId((signed as any)?.action?.actionId, 16) });
      return { ok: false };
    }
    return { ok: true, req: request };
  }

  // ── ① 群 (与 CLI `bolloon task group …` 同一份 store) ─────────────────────

  /** 本机已加入的群 (脱敏: 只给 groupId/群名/时间 —— 不放链接与 store 地址) */
  app.get('/api/mobile/tasks/groups', async (_req, res) => {
    try {
      const { listGroups } = await import('../agents/gateway-group.js');
      const groups = await listGroups();
      res.json({
        ok: true,
        groups: groups.map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt })),
        note: '只给群标识/群名/加入时间; 邀请链接要显式取 (与 CLI task group list 同一纪律)',
      });
    } catch (e: any) {
      fail(res, 500, 'GROUP_LIST_FAILED', `读群列表失败: ${reasonOf(e)}`);
    }
  });

  /** 群列表 (给手机确认页做 ref 校验用; 不放链接) */
  app.get('/api/mobile/tasks/groups/resolve', async (req, res) => {
    try {
      const { resolveGroupRef } = await import('../agents/task-group.js');
      const r = await resolveGroupRef(String(req.query?.group || ''));
      if (!r.ok) return fail(res, 404, r.code, r.message, { detail: r.detail });
      res.json({ ok: true, group: { id: r.group.groupId, name: r.group.name, via: r.group.via } });
    } catch (e: any) {
      fail(res, 500, 'GROUP_RESOLVE_FAILED', `解析群失败: ${reasonOf(e)}`);
    }
  });

  // ── ② 公告: 看板 (只读, 与 CLI `task board` 同一份事实) ─────────────────

  app.get('/api/mobile/tasks/board', async (req, res) => {
    try {
      const { listBoard } = await import('../agents/task-board.js');
      const localOnly = String(req.query?.local || '') === '1';
      const openOnly = String(req.query?.open || '') === '1';
      const view = await listBoard({ home: opts.home, now: now(), localOnly, openOnly });
      // 只回手机要用的字段: buyerDid / claimedBy 是身份, **不出门** (手机侧再投影一次)
      res.json({
        ok: true,
        entries: view.entries.map((e) => ({
          announcementId: e.announcementId, capability: e.capability, status: e.status,
          budget: e.budget, deadline: e.deadline, createdAt: e.createdAt, claimCount: e.claimCount,
          instructionDigest: e.instructionDigest, instructionPreview: e.instructionPreview,
          remote: e.remote, source: e.source, signatureVerified: e.signatureVerified, claimable: e.claimable,
        })),
        localCount: view.localCount, remoteCount: view.remoteCount, registryReady: view.registryReady,
        registryError: view.registryError, notes: view.notes,
      });
    } catch (e: any) {
      fail(res, 500, 'BOARD_FAILED', `读看板失败: ${reasonOf(e)}`);
    }
  });

  /** 群里的一期过程痕迹 (只读, 与 CLI `task trail --group …` 同一份汇总) */
  app.get('/api/mobile/tasks/trail', async (req, res) => {
    try {
      const { resolveGroupRef, readTrail } = await import('../agents/task-group.js');
      const ref = await resolveGroupRef(String(req.query?.group || ''));
      if (!ref.ok) return fail(res, 404, ref.code, ref.message, { detail: ref.detail });
      const limit = Number(req.query?.limit) || 300;
      const announcementId = req.query?.announcementId ? String(req.query.announcementId) : null;
      const summary = await readTrail(ref.group.groupId, { limit, announcementId });
      res.json({ ok: true, group: { id: ref.group.groupId, name: ref.group.name }, summary });
    } catch (e: any) {
      fail(res, 500, 'TRAIL_FAILED', `读群痕迹失败: ${reasonOf(e)}`);
    }
  });

  /** 预览: 用**将要发送的同一个构造器**生成那一行 (只展示, 不发送, 不需要签名) */
  app.post('/api/mobile/tasks/preview', async (req, res) => {
    try {
      const request = (req?.body?.request || {}) as TaskActionRequest;
      const built = await buildGroupText(request, opts.home);
      if (!built.ok) return fail(res, 400, built.code, built.error);
      res.json({ ok: true, text: built.text, note: '预览由桌面的构造器生成: 与你确认后真正发进群的那一行同源' });
    } catch (e: any) {
      fail(res, 500, 'PREVIEW_FAILED', `生成预览失败: ${reasonOf(e)}`);
    }
  });

  // ── 执行 (验签 → 调用与 CLI 相同的函数) ───────────────────────────────────

  app.post('/api/mobile/tasks/execute', async (req, res) => {
    try {
      const kind = String(req?.body?.request?.kind || '') as TaskActionRequest['kind'];
      const auth = await authorize(req, res, kind);
      if (!auth.ok) return;
      const request = auth.req;
      const ownerDid = String((req?.body?.action?.ownerDid || '') || '');

      if (kind === 'group_create' || kind === 'group_join' || kind === 'group_leave') {
        const { createGroup, joinGroup, leaveGroup } = await import('../agents/gateway-group.js');
        if (kind === 'group_create') {
          const r = await createGroup(String(request.groupRef || '').trim());
          if (!r.ok || !r.group) return fail(res, 409, 'GROUP_CREATE_FAILED', `建群失败: ${r.error || '未知原因'}`);
          return res.json({ ok: true, kind, group: { id: r.group.id, name: r.group.name }, text: `已建群「${r.group.name}」` });
        }
        if (kind === 'group_join') {
          const { parseGroupLink } = await import('../agents/gateway-group.js');
          const raw = String(request.groupRef || '').trim();
          if (!/^orbitdb:\/\//i.test(raw)) return fail(res, 400, 'INVALID_GROUP_LINK', '入群需要群邀请链接 (orbitdb://…?type=group&name=…)');
          if (!parseGroupLink(raw)) return fail(res, 400, 'INVALID_GROUP_LINK', '邀请链接解析失败 → 拒 (不猜你要进哪个群)');
          const r = await joinGroup(raw);
          if (!r.ok || !r.group) return fail(res, 409, 'GROUP_JOIN_FAILED', `入群失败: ${r.error || '未知原因'}`);
          return res.json({ ok: true, kind, group: { id: r.group.id, name: r.group.name }, already: !!r.already, text: r.already ? `本来就在「${r.group.name}」` : `已入群「${r.group.name}」` });
        }
        const r = await leaveGroup(String(request.groupRef || '').trim());
        if (!r.ok) return fail(res, 409, 'GROUP_LEAVE_FAILED', `退群失败: ${r.error || '未知原因'}`);
        return res.json({ ok: true, kind, text: `已退群 (只摘本机记录)`, removed: r.removed });
      }

      if (kind === 'announce_publish') {
        const signer = await localSignerOrNull();
        if (!signer) return fail(res, 400, 'NO_LOCAL_IDENTITY', '本机没有可签名的身份 (~/.bolloon/identity.json) → 公告没有可追责的买方, 拒发');
        const { toAtomic, parseDeadline } = await import('../cli/commands/tasks.js');
        const currency = String(request.currency || 'USDC').toUpperCase();
        if (currency !== 'USDC' && currency !== 'ETH') return fail(res, 400, 'INVALID_CURRENCY', `币种只支持 USDC/ETH (收到 ${currency})`);
        const atomic = toAtomic(String(request.budgetHuman || ''), currency === 'USDC' ? 6 : 18);
        if (!atomic) return fail(res, 400, 'INVALID_BUDGET', '预算必须是正数 (原子单位由桌面换算, 不接受 0/负/超精度)');
        const dl = parseDeadline(request.deadline === null || request.deadline === undefined || request.deadline === '' ? undefined : String(request.deadline), now());
        if (typeof dl === 'string') return fail(res, 400, 'INVALID_DEADLINE', dl);
        const { publishAnnouncement } = await import('../agents/task-board.js');
        const r = await publishAnnouncement({
          capability: String(request.capability || ''),
          instruction: String(request.instruction || ''),
          buyerDid: signer.did,
          buyerPublicKeyHex: signer.publicKeyHex,
          budget: { maxAmount: atomic, currency, network: 'base-sepolia' },
          deadline: dl,
          paymentMode: 'policy',
          signerKeypair: signer.keypair,
        }, { home: opts.home, now: now() });
        if (!r.ok || !r.announcement) return fail(res, 500, 'ANNOUNCE_PUBLISH_FAILED', `公告没发布成功: ${r.error || '未知原因'}`);
        return res.json({
          ok: true, kind, announcementId: r.announcement.announcementId, dup: !!r.dup,
          registryAnnounced: r.registry?.announced === true, registryError: r.registry?.error || null,
          text: r.dup ? '这条公告本来就在板上 (幂等, 没有重复发)' : '公告已发布 (落盘 + 尽力向注册表公告)',
        });
      }

      // announce_to_group / trail_post: 生成那一行 → 隐私闸 → 发进群
      const built = await buildGroupText(request, opts.home);
      if (!built.ok) return fail(res, 400, built.code, built.error);
      const { sendTrailMessage, resolveSenderTag } = await import('../agents/task-group.js');
      const tag = await resolveSenderTag(null);
      if (!tag.ok) return fail(res, 400, tag.code, tag.message);
      const sent = await sendTrailMessage(built.groupId, built.text, tag.tag);
      if (!sent.sent) {
        return fail(res, 409, 'GROUP_SEND_REFUSED', sent.error || '群消息没发出去', { violations: sent.violations || [] });
      }
      return res.json({ ok: true, kind, text: sent.text, senderTag: tag.tag });
    } catch (e: any) {
      fail(res, 500, 'EXECUTE_FAILED', `执行失败: ${reasonOf(e)}`);
    }
  });

  // ── ③ 飞轮进度 (只读消费 goal-flywheel 冻结类型; 投影在桌面做, 手机只渲染) ──

  app.get('/api/mobile/tasks/flywheel', async (_req, res) => {
    try {
      const { listGoals } = await import('../agents/goal-store.js');
      const { buildMobileFlywheelView, findInternalFieldLeaks } = await import('../agents/mobile-flywheel-view.js');
      const { GOAL_TERMINAL_STATES } = await import('../agents/goal-flywheel/types.js');
      const goals = await listGoals({ limit: 20 });
      const t = now();
      let decisionReadFailures = 0;
      const items = [];
      for (const g of goals as any[]) {
        const status = String(g?.status || '');
        // 终态判据来自冻结面 (不在这里重列一遍 completed/failed/abandoned)
        const terminal = (GOAL_TERMINAL_STATES as readonly string[]).includes(status);
        // 只读消费: goal-store 的 continuation 可整体读作 goal-flywheel 的 GoalContinuationRecord (冻结面)。
        // 终态目标在 store 里没有 continuation (冻结语义), 但 toUserVisibleState 判"已结束"要读 state ——
        // 所以把 **store 里的真实 status** 装进它要的形状, 不新增任何状态、不编造下一步。
        const continuation: any = (g?.continuation && typeof g.continuation === 'object')
          ? {
            nextAction: String(g.continuation.nextAction || ''),
            wakeAt: g.continuation.wakeAt || null,
            wakeReason: String(g.continuation.wakeReason || ''),
            autoContinue: g.continuation.autoContinue === true,
            requiredAgent: g.continuation.requiredAgent || null,
            pendingReports: [],
            unresolvedItems: Array.isArray(g.unresolvedItems) ? g.unresolvedItems.map((x: any) => String(x)) : [],
            lastDecisionId: g.continuation.lastDecisionId || null,
            state: status || 'active',
            updatedAt: String(g.continuation.updatedAt || g.updatedAt || new Date(t).toISOString()),
          }
          : (terminal
            ? {
              nextAction: '', wakeAt: null, wakeReason: '', autoContinue: false, requiredAgent: null,
              pendingReports: [], unresolvedItems: [], lastDecisionId: null,
              state: status, updatedAt: String(g?.updatedAt || new Date(t).toISOString()),
            }
            : null);
        // 决策记录: 用飞轮接线自己的读函数 (只读; 没有/还没接线 → null, 不编造)
        let decision: any = null;
        try {
          const w: any = await import('../agents/goal-flywheel-wiring.js');
          if (typeof w?.readDecisionRecords === 'function') {
            const recs = await w.readDecisionRecords(String(g?.goalId || g?.id || ''), opts.home);
            const last = Array.isArray(recs) && recs.length ? recs[recs.length - 1] : null;
            decision = last?.decision ?? null;
          }
        } catch {
          decisionReadFailures++;
          decision = null;
        }
        // 阻塞清单: 今天的飞轮没有可供手机读的阻塞存储 (monitor 状态归飞轮接线) → 如实空表, 不假装
        const view = buildMobileFlywheelView({ continuation, blocks: [], decision, now: t });
        items.push({
          objectiveShort: String(g?.objective || '').slice(0, 40),
          status,
          terminal,
          view,
        });
      }
      // 自检: 投影里出现内部字段名 → 宁可不给数据 (findInternalFieldLeaks 来自冻结面)
      const leaks = findInternalFieldLeaks(JSON.stringify(items));
      if (leaks.length) return fail(res, 500, 'VIEW_LEAK', `飞轮投影里混进了内部字段: ${leaks.join(', ')} → 拒发`);
      res.json({
        ok: true, goals: items,
        hint: items.length ? null : '还没有 Goal 记录: 在桌面/CLI 立一个长期目标后, 这里会显示它在第几类状态 (只读)',
        note: decisionReadFailures
          ? '本页只读消费 goal-flywheel 的五类用户可见状态; 有目标的决策记录这次没读到 (不影响状态判定)'
          : '本页只读消费 goal-flywheel 的五类用户可见状态 (toUserVisibleState); 阻塞清单要等飞轮接线把 detectBlocks 的产物落盘后才有数据',
      });
    } catch (e: any) {
      fail(res, 500, 'FLYWHEEL_FAILED', `读飞轮进度失败: ${reasonOf(e)}`);
    }
  });
}

// ── 群消息文本构造 (announce / post) ────────────────────────────────────────
// 与 CLI 走**同一批函数**: pickAnnouncement → buildAnnounceMessage / buildPostMessage → sendTrailMessage。

type BuiltText = { ok: true; text: string; groupId: string } | { ok: false; code: string; error: string };

async function buildGroupText(request: TaskActionRequest, home?: string): Promise<BuiltText> {
  const TG: any = await import('../agents/task-group.js');
  const ref = await TG.resolveGroupRef(String(request.groupRef || ''));
  if (!ref.ok) return { ok: false, code: ref.code, error: ref.message };

  if (request.kind === 'announce_to_group') {
    const a = TG.pickAnnouncement({
      home,
      announcementId: request.announcementId,
      capability: null,
    });
    if (!a.ok) return { ok: false, code: a.code, error: a.message };
    return { ok: true, groupId: ref.group.groupId, text: TG.buildAnnounceMessage(a.announcement, { round: request.round, criteria: request.criteria }) };
  }

  if (request.kind === 'trail_post') {
    const kind = String(request.trailKind || '') as 'claim' | 'deliver' | 'screen' | 'final';
    const built = TG.buildPostMessage({
      kind,
      announcementId: request.announcementId,
      round: request.round,
      price: request.price,
      hash: request.hash,
      bytes: request.bytes,
      checksRaw: request.checks,
      verdict: request.verdict,
    });
    if (!built.ok) return { ok: false, code: built.code, error: built.message };
    return { ok: true, groupId: ref.group.groupId, text: built.text };
  }

  return { ok: false, code: 'INVALID_ARGUMENT', error: `这一类动作没有群消息文本: ${String(request.kind)}` };
}

export default { registerMobileTaskRoutes };
