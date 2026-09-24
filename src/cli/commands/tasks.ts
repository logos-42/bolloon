/**
 * tasks.ts — P3 `bolloon task send|list|status|cancel|retry|result|inbox|accept|reject|run|complete`
 *
 * **今天真能包的** (薄包装, 不重实现):
 *   list     → `x402/transaction-store.listTransactions()` + `goal-store.listGoals()` + 本机任务台账/收件箱
 *   status   → 收件箱 / 本机台账 (bolloon-task/1) → `readTransaction` / `findByRequestId` / `task-runner.decideTaskRecovery()`
 *   retry    → `x402/payment-recovery.planTransactionRecovery()` (**只出计划, 绝不代付款**)
 *   result   → 已存结果 (task-inbox: 内容哈希/CID + 签名验真) 或 `readTransaction` + `settlement-state.verifyDelivery()`
 *   run      → `task/task-runner.runTask()` (M1 唯一入口的同一条路径)
 *
 * **2026-09-21 (P3 收尾) 真接出来的 5 条** (契约层 + 现成传输, 不再是 C_NOT_IMPLEMENTED):
 *   send     → 构造 + **签名** TaskRequest (`taskRequestId` 确定性幂等) → `task-transport` 发到目标节点
 *   inbox    → `~/.bolloon/tasks/inbox/` 待处理请求 (发送方摘要/capability/截止时间/状态; `dedupeInbox` 去重)
 *   accept   → 校验 (capability 已知 · 预算够 · policy 允许 · requestId 未重复) + 签名接受 + 落盘 + 回执
 *   reject   → 记原因 + 签名 + 落盘; **不执行、不付款**
 *   (result 与上面同一套落盘; complete/cancel 仍如实报未实现)
 *
 * 红线 (P1 §5): local-dev 永远不许被输出成链上结算; 有支付证据不许重付 (计划里 `mustNotRepay` 原样透出);
 * **本文件任何路径都不发起付款** —— `send/accept/reject` 里没有一行付款调用, 付款只能由持钱包的一方
 * 走同一 requestId 的 x402 幂等路径 (计划透出 `paid:false`)。任务正文只在本机落盘 (私有一层)。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  type CliFlags, type CommandResult, type Code, type Envelope, type NextAction,
  okEnvelope, failEnvelope, notImplemented, envelopeForState,
  line, title, hint, plain, opt, has, failHuman,
  publicStatusForTask, publicStatusForTrade, settlementLabel, isTradeSuccessful,
} from '../protocol-envelope.js';

export const TASK_USAGE = `
${title('bolloon task')}
  bolloon task "<任务>" --budget 0.05      M1 唯一入口: 买能力 + 执行 + 报告卡 (推荐)
  bolloon task run "<任务>" [--budget 0.05] [--request-id <id>]   同上, 显式走信封输出
  bolloon task list [--json]               本地任务/交易一览 (状态 + 支付事实, 不含任务正文)
  bolloon task status <transactionId|requestId|goalId> [--json]
  bolloon task result <transactionId|requestId|taskId> [--json]   已存结果 (内容哈希/CID + 签名 + 验真状态)
  bolloon task retry <id> [--json]         恢复计划 (planTransactionRecovery; 只出计划, 不代付款)

  ── bolloon-task/1 真收发 (2026-09-21 P3 收尾: 契约层 + 现成传输) ──
  bolloon task send --capability research --instruction "调研 X" \\
      [--budget 0.05] [--network base-sepolia] [--currency USDC] [--deadline +24h] \\
      [--provider <did>] [--endpoint http://host:port] [--reply-to http://me:port] [--peer <iroh nodeId>] [--via gateway]
  bolloon task inbox [--json] [--all]      收件箱: 待处理请求 (发送方摘要 · capability · 截止时间 · 状态)
  bolloon task accept <requestId|taskId> [--deliver <file>] [--reply-to <url>] [--eta <ms>]
  bolloon task reject <requestId|taskId> --reason "<原因>"
  bolloon task complete|cancel              仍未实现 → 如实报 C_NOT_IMPLEMENTED

  ── 任务对外发布 + 接单 (C1/C2, 2026-09-23: 公告板) ──
  bolloon task publish --capability research --instruction "调研 X" --budget 0.05 \\
      [--currency USDC] [--network base-sepolia] [--deadline +24h] [--reply-to http://me:port]
      发布一条**待接单**任务: 落盘 ~/.bolloon/tasks/board/<announcementId>.json +
      向 agent-registry 公告 (service.name = task.announce) + 记脉冲事件 task_announced;
      输出稳定 announcementId (同一 能力+正文+买方+预算 → 同一个 id, 重发幂等)
  bolloon task board [--json] [--capability <名>] [--open] [--local]
      板上可接单的任务: **本地公告 + 注册表发现的远端公告**, 按 announcementId 去重
  bolloon task claim <announcementId> [--price 0.02] [--group <群链接|groupId>]
      provider 接单: 记认领者 DID + 时间 + 声明价格 (不执行、不付款、不标 verified);
      重复认领 / 已取消 / 不存在的 id → 一律拒绝并给原因;
      带 --group 时: 往群里发一条极短接单声明 (群非法 → 整条命令拒绝, 不静默降级)

  ── 群聊通道 (C7, 2026-09-23: 过程留痕) ──
  bolloon task announce --group <群链接|groupId> [--announcement-id <id>] [--capability <名>]
      [--round <期号>] [--criteria "<验收判据摘要>"] [--from <短显示名>] [--json]
      把板上**一条待接单公告**压成一行极短事实 (期号 · capability · 预算 · 判据摘要 · 公告 id) 发进群;
      正文不进群; 缺 --group / 群非法 / 本机没这个群 → 拒绝执行 (绝不降级为只写本地)
  bolloon task trail --group <群链接|groupId> [--announcement-id <id>] [--limit 300] [--json]
      从群消息读回本期过程留痕 (公告/接单/交付/初筛/终审) → 按时间排序的时间线, 每条带时间 + 发送者标记
  bolloon task post --kind deliver|screen|final --group <群链接|groupId> --announcement-id <id> \\
      [--hash sha256:<hex>] [--bytes <n>] [--checks "渠道结构=pass,价格带=fail"] [--verdict accept|reject|unknown]
      [--round <期号>] [--from <短显示名>] [--json]
      交付只贴哈希 · 初筛逐条结果 · 终审结论; 群消息一律无钱包地址/DID/peerId/multiaddr/IP/私钥形态
      (命中任一条 → 拒发并报出命中的规则)

  ── 群管理 (2026-09-24: 外部接单者的自助入群入口) ──
  bolloon task group create --name <群名> [--from <短显示名>] [--json]
      建群 → 打印**邀请链接** (发给要入群的人) + groupId; 落 ~/.bolloon/gateway-groups.json
      (ACL write:['*'] = 成员可广播, 建群时写进 store manifest)
  bolloon task group join <群链接|groupId> [--json]
      用**链接**自助入群 (幂等: 已在群里 → already=true, 仍 exit 0);
      store 拿不到区块 → 大声失败 (TRANSPORT_FAILED + storeCode=STORE_UNREACHABLE), 绝不显示成空群
  bolloon task group list [--json]         本机已加入的群 (groupId · 群名 · 加入时间); 没有群 → 空列表
  bolloon task group link <groupId|群名>   显式取回邀请链接 (list 里不放链接)
  bolloon task group leave <groupId|群名>  退群 (只摘本机记录)
      群管理输出不含原始 DID/钱包地址/peerId/节点 multiaddr/IP (脱敏口径与群消息同源)

选项: --json · --quiet · --request-id <id> · --timeout <ms> · --resume <goalId> (同 bolloon task)
说明: 收件箱落盘 ~/.bolloon/tasks/inbox/; 本机发出的任务台账 ~/.bolloon/tasks/local/;
      结果 ~/.bolloon/tasks/results/, 交付正文 ~/.bolloon/tasks/bodies/ (私有层, 不进 stdout);
      任务公告 ~/.bolloon/tasks/board/ (正文只在本地, 注册表里只有 sha256 摘要 + 60 字预览);
      群里的过程痕迹**只在群里** (群消息就是留痕本体, 本机不留影子副本); 结算仍只在链上。
`;

type Rec = import('../../agents/x402/transaction-protocol.js').TransactionRecord;

/** 交易记录判定 (P1 §5.1 红线: local-dev 永不 verified; 成功判据见 §7.1) */
function judge(rec: Rec): { code: Code; ok: boolean; next: NextAction } {
  const fact = String(rec.settlementFact || '');
  const status = String(rec.status);
  // 红线: local-dev 的记录出现 verified → 就是红线被破坏, 如实报 (绝不顺着说成功)
  if (rec.paymentMode === 'local-dev' && status === 'verified') {
    return { code: 'LOCAL_DEV_NOT_CHAIN', ok: false, next: null };
  }
  if (isTradeSuccessful(rec)) return { code: 'TASK_VERIFIED', ok: true, next: null };
  switch (status) {
    case 'verified': return { code: 'RESULT_UNVERIFIED', ok: false, next: 'needs_human' };   // verified 了但支付事实不够链上口径
    case 'delivered': return { code: 'TASK_COMPLETED', ok: true, next: 'verify_result' };
    case 'paying': return { code: 'PAYMENT_PENDING', ok: false, next: 'reconcile' };
    case 'payment_required': return { code: 'PAYMENT_REQUIRED', ok: false, next: 'approve_payment' };
    case 'policy_denied': return { code: 'POLICY_DENIED', ok: false, next: 'needs_human' };
    case 'delivery_failed': return { code: 'DELIVERY_FAILED', ok: false, next: 'needs_human' };
    case 'verification_failed': return { code: 'RESULT_UNVERIFIED', ok: false, next: 'needs_human' };
    case 'disputed': return { code: 'DISPUTE_OPEN', ok: false, next: 'needs_human' };
    default:
      if (fact === 'unknown') return { code: 'PAYMENT_UNCERTAIN', ok: false, next: 'reconcile' };
      if (status === 'failed') return { code: 'TASK_FAILED', ok: false, next: 'needs_human' };
      return { code: 'OK', ok: true, next: 'wait' };      // discovered/quoted/settled: 还在走
  }
}

/** 一条记录 → 对外可见摘要 (camelCase; 不含任务正文/私钥) */
function recSummary(rec: Rec) {
  const j = judge(rec);
  return {
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    goalId: rec.goalId || null,
    runId: rec.runId || null,
    lifecycle: String(rec.status),
    settlementFact: String(rec.settlementFact || ''),
    paymentMode: String(rec.paymentMode),
    chainSettled: rec.chainSettled === true,
    settlement: settlementLabel(rec),                     // 'chain' | 'local-dev' | 'none' —— local-dev 永不冒充链上
    publicStatus: rec.status === 'verified' || rec.status === 'delivered'
      ? publicStatusForTask(String(rec.status), j.next)
      : publicStatusForTrade(String(rec.status), j.next),
    success: isTradeSuccessful(rec),
    txHash: rec.txHash || null,
    contentHash: rec.contentHash || null,
    deliveryHash: rec.deliveryHash || null,
    receiptHash: rec.receiptHash || null,
    amount: rec.amount || null,
    currency: rec.currency || null,
    network: rec.network || null,
    startedAt: rec.startedAt,
    code: j.code,
    next_action: j.next,
  };
}

async function loadRecords(): Promise<Rec[]> {
  const { listTransactions } = await import('../../agents/x402/transaction-store.js');
  return await listTransactions(os.homedir());
}

/** 解析一个 id: transactionId → requestId → goalId (goalId 走 decideTaskRecovery 找交易) */
async function resolveTarget(id: string): Promise<{ rec: Rec | null; goalId?: string; plan?: { action: string; reason: string; mustNotRepay: boolean; transactionId?: string } }> {
  const { readTransaction, findByRequestId } = await import('../../agents/x402/transaction-store.js');
  const home = os.homedir();
  if (/^tx-/.test(id)) {
    return { rec: await readTransaction(id, home) };
  }
  // 任意 requestId (不一定是 treq- 前缀) 也能直接查到交易
  const byReq = await findByRequestId(id, home);
  if (byReq) return { rec: byReq };
  // 其它一律当 goalId (M1 的 goal id 形如 g-xxxx)
  const { decideTaskRecovery } = await import('../../agents/task/task-runner.js');
  const d = await decideTaskRecovery({ goalId: id });
  const rec = d.transactionId ? await readTransaction(d.transactionId, home) : null;
  return { rec, goalId: id, plan: { action: d.action, reason: d.reason, mustNotRepay: d.mustNotRepay, transactionId: d.transactionId } };
}

export async function taskCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'list': return taskList(flags);
    case 'status': return taskStatus(flags);
    case 'result': return taskResult(flags);
    case 'retry': return taskRetry(flags);
    case 'run': return taskRun(flags);
    case 'send': return taskSend(flags);
    case 'inbox': return taskInbox(flags);
    case 'accept': return taskAccept(flags);
    case 'reject': return taskReject(flags);
    case 'complete': return taskComplete(flags);
    case 'cancel': return taskCancel(flags);
    case 'publish': return taskPublish(flags);
    case 'board': return taskBoard(flags);
    case 'claim': return taskClaim(flags);
    case 'announce': return taskAnnounce(flags);
    case 'trail': return taskTrail(flags);
    case 'post': return taskPost(flags);
    // 2026-09-24: 群管理 (create/join/list/link/leave) —— 外部接单者的自助入群入口
    case 'group': return taskGroup(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 task 子命令: ${sub}` : '缺少 task 子命令', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
        human: TASK_USAGE,
      };
  }
}

// ── list ────────────────────────────────────────────────────────────────────

async function taskList(flags: CliFlags): Promise<CommandResult> {
  const all = await loadRecords();
  const filtered = flags.requestId ? all.filter((r) => r.requestId === flags.requestId) : all;
  let goals: Array<{ goalId: string; status: string; hasTransaction: boolean }> = [];
  try {
    const { listGoals } = await import('../../agents/goal-store.js');
    const gs = await listGoals({ limit: 20 });
    const ids = new Set(all.map((r) => r.goalId).filter(Boolean) as string[]);
    // 只给 id 与状态: goal.objective 是任务正文, **不进 stdout** (P1 §5.6)
    goals = gs.map((g) => ({ goalId: g.goalId, status: String(g.status), hasTransaction: ids.has(g.goalId) }));
  } catch { /* 没有 goal 目录也能列交易 */ }

  const data = {
    count: filtered.length,
    tasks: filtered.map(recSummary),
    goals,
    source: 'transactions (~/.bolloon/transactions) + goals (~/.bolloon/goals)',
    note: 'bolloon-task/1 的收件箱/P2P 任务帧尚未实现 (task-protocol.md §9 Phase 2); 这里列的是本地有交易记录的任务 + 本地 Goal (只给 id/状态, 不含任务正文)',
  };
  const human = [
    title('bolloon task list'),
    line('交易记录', `${filtered.length} 笔${flags.requestId ? ` (requestId=${flags.requestId})` : ''}`),
    ...filtered.slice(0, 20).map((r) => `\n   ${r.transactionId}  [${r.status}/${r.settlementFact}]  ${settlementLabel(r)}  ${isTradeSuccessful(r) ? '✓成功' : ''}\n     requestId: ${r.requestId}${r.goalId ? `\n     goalId:    ${r.goalId}` : ''}`),
    line('本地 Goal', `${goals.length} 个 (只给 id/状态, 不含任务正文)`),
    ...goals.slice(0, 10).map((g) => `      · ${g.goalId} [${g.status}]${g.hasTransaction ? ' (已有交易)' : ''}`),
    `\n  ${data.note}`,
  ].join('\n');
  return { envelope: okEnvelope('OK', `本地任务/交易: ${filtered.length} 笔交易, ${goals.length} 个 Goal`, data, filtered.map((r) => r.transactionId), null), human };
}

// ── bolloon-task/1 层 (收件箱 / 本机台账 / 结果) ──────────────────────────────

/** InboxState → 任务 14 态 (只用于对外 4 态投影; 内部一个字不改) */
const INBOX_TO_TASK: Record<string, string> = {
  pending: 'submitted',
  accepted: 'accepted',
  rejected: 'rejected',
  delivered: 'delivered',
  failed: 'failed',
};

/** 任务层 id 解析: 收件箱 requestId/taskId · 本机台账 requestId · 结果 taskId */
async function findTaskLayer(id: string): Promise<{
  inbox: any | null; local: any | null; result: any | null; requestId: string | null;
} | null> {
  const { readInboxItem, readLocalTask, findResult, listInbox, listLocalTasks } = await import('../../agents/task-inbox.js');
  const home = os.homedir();
  let inbox = readInboxItem(id, home);
  let local = readLocalTask(id, home);
  if (!inbox && !local) {
    // 也可能是 taskId (task-…): 反查
    inbox = listInbox(home).find((i) => i.taskId === id) || null;
    local = listLocalTasks(home).find((t) => t.taskId === id) || null;
  }
  if (!inbox && !local) return null;
  const requestId = local?.requestId || inbox?.requestId || null;
  const found = requestId ? findResult(requestId, home) : findResult(id, home);
  return { inbox, local, result: found?.result || null, requestId };
}

/** `task status` 的任务层分支 (交易层记录若存在 → 只读衔接一起显示, 绝不改交易) */
async function taskLayerStatus(id: string): Promise<CommandResult | null> {
  const l = await findTaskLayer(id);
  if (!l) return null;
  const { inboxSummary } = await import('../../agents/task-inbox.js');
  const { findByRequestId } = await import('../../agents/x402/transaction-store.js');
  const home = os.homedir();
  const { inbox, local, result, requestId } = l;
  const rid = String(requestId || id);

  // ★ 交易层衔接: 同一 requestId 若已有交易, 只**读**出来一起显示 (两层不混, 也不绕过)
  const tx = await findByRequestId(rid, home);
  const txView = tx ? recSummary(tx) : null;

  const inboxState = inbox?.state ?? null;
  const taskState = local?.state ?? (inboxState ? INBOX_TO_TASK[inboxState] : null);
  const next: NextAction = taskState === 'delivered' ? 'verify_result'
    : taskState === 'rejected' ? null
      : inboxState === 'pending' && !local ? 'needs_human'      // 收到待处理请求 → 要人来决定接不接
        : taskState === 'submitted' ? null
          : taskState === 'accepted' ? 'wait'
            : 'needs_human';
  const code: Code = taskState === 'verified' ? 'TASK_VERIFIED'
    : taskState === 'delivered' ? 'TASK_COMPLETED'
      : taskState === 'rejected' ? 'TASK_REJECTED'
        : taskState === 'failed' ? 'TASK_FAILED'
          : taskState === 'accepted' ? 'TASK_ACCEPTED'
            : 'TASK_SUBMITTED';
  const publicStatus = publicStatusForTask(String(taskState || 'submitted'), next);
  const rv = l.result?.contentHash || result?.contentHash || null;

  const data: Record<string, unknown> = {
    layer: local && inbox ? 'both' : local ? 'local' : 'inbox',
    requestId: rid,
    taskId: local?.taskId || inbox?.taskId || null,
    capability: local?.capability || inbox?.capability || null,
    state: taskState,
    inboxState,
    publicStatus,
    direction: local && inbox ? 'both' : local ? 'sent' : 'received',
    buyerDid: local?.buyerDid || inbox?.buyerDid || null,
    providerDid: local?.providerDid || inbox?.providerDid || null,
    paymentMode: local?.paymentMode || inbox?.paymentMode || null,
    deadline: inbox?.deadline ?? null,
    deadlineInMs: inbox?.deadline ? inbox.deadline - Date.now() : null,
    budget: inbox?.budget ?? null,
    requestSignatureVerified: local ? true : (inbox?.requestSignatureVerified ?? null),
    transport: local ? { kind: local.transportKind, target: local.target } : null,
    sentAt: local?.sentAt ?? null,
    receivedAt: inbox?.receivedAt ?? null,
    receipt: local?.receipt ?? null,
    accept: local?.accept || inbox?.accept ? { providerDid: (local?.accept || inbox?.accept)?.providerDid, etaMs: (local?.accept || inbox?.accept)?.etaMs ?? null, signed: true } : null,
    reject: local?.reject || inbox?.reject ? { reason: (local?.reject || inbox?.reject)?.reason } : null,
    result: (local?.result || inbox?.result) ? {
      ok: (local?.result || inbox?.result)?.ok,
      summary: (local?.result || inbox?.result)?.summary,
      contentHash: rv,
      cid: (local?.result || inbox?.result)?.cid ?? null,
      deliveredAt: (local?.result || inbox?.result)?.deliveredAt,
      signed: !!(local?.result || inbox?.result)?.signature,
      signatureVerified: local?.resultVerified ?? inbox?.resultVerified ?? null,
    } : null,
    transaction: txView,
    origin: inbox ? inboxSummary(inbox) : null,
    /** 本命令**没有**发起付款 (任务层命令从不付款; 付款只走持钱包一方的 x402 幂等路径) */
    paid: false,
    transactionLinked: !!tx,
    taskBodyFile: local?.taskId || inbox?.taskId ? `~/.bolloon/tasks/bodies/${local?.taskId || inbox?.taskId}.txt` : null,
    note: '任务层 (bolloon-task/1) 状态与交易层 (x402) 严格分离: 这里只读交易事实, 不改也不绕',
  };

  const human = [
    title(`bolloon task status ${rid}`),
    line('层', data.layer === 'inbox' ? '收件箱 (收到的请求)' : data.layer === 'local' ? '本机台账 (发出的任务)' : '收件箱 + 本机台账'),
    line('任务状态', `${taskState} (对外: ${publicStatus})${inboxState ? ` · 收件箱态 ${inboxState}` : ''}`),
    line('capability', String(data.capability || '(无)')),
    line('发送方', String(data.buyerDid || '(无)').slice(0, 40)),
    ...(data.deadline ? [line('截止时间', `${new Date(Number(data.deadline)).toISOString()} (${Number(data.deadlineInMs) > 0 ? `还剩 ${Math.round(Number(data.deadlineInMs) / 1000)}s` : '已过期'})`)] : []),
    ...(data.transport ? [line('传输', `${(data.transport as any).kind} → ${(data.transport as any).target}`)] : []),
    ...(data.receipt ? [line('发送回执', (data.receipt as any).ok ? '对端收下了' : `失败: ${(data.receipt as any).error || '未知'}`)] : []),
    ...(data.accept ? [line('接受回执', '已签名 (TaskAccept)')] : []),
    ...(data.reject ? [line('拒绝原因', String((data.reject as any).reason))] : []),
    ...(data.result ? [line('结果', `${(data.result as any).ok ? 'ok' : 'not-ok'} · contentHash ${String((data.result as any).contentHash || '').slice(0, 12)}… · 验签 ${(data.result as any).signatureVerified === true ? '通过' : (data.result as any).signatureVerified === false ? '不过' : '未验'}`)] : []),
    line('交易层', txView ? `${txView.transactionId} [${txView.lifecycle}/${txView.settlementFact}] (${txView.settlement})` : '没有同一 requestId 的交易 (本机没为它付过款)'),
    line('本次付款', '没有 (任务层命令不付款)'),
    `\n  ${String(data.note)}`,
  ].join('\n');

  return {
    envelope: okEnvelope(code, `任务 ${rid}: ${taskState} (${publicStatus})`, data, [rid, ...(data.taskId ? [String(data.taskId)] : []), ...(tv(tx) || [])], next),
    human,
  };
}

function tv(rec: Rec | null | undefined): string | null {
  return rec ? rec.transactionId : null;
}

// ── status ──────────────────────────────────────────────────────────────────

async function taskStatus(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 id (transactionId / requestId / goalId) 或 --request-id', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const { rec, goalId, plan } = await resolveTarget(id);
  if (!rec) {
    // ★ 先看任务层 (bolloon-task/1): 收件箱 / 本机台账 —— 真收到的请求与真发出的任务在这里
    const taskLayer = await taskLayerStatus(id);
    if (taskLayer) return taskLayer;
    if (goalId && plan) {
      // goalId 路径: 走 decideTaskRecovery (Supervisor 与 CLI --resume 共用的唯一决策入口)
      const data = {
        goalId, hasTransaction: false, recoveryAction: plan.action, mustNotRepay: plan.mustNotRepay,
        reason: plan.reason, decisionSource: 'task-runner.decideTaskRecovery',
      };
      if (plan.action === 'closed') {
        // 目标压根不存在 (decideTaskRecovery 对找不到的 Goal 给 closed)
        return {
          envelope: failEnvelope('NOT_FOUND', `找不到这个 Goal: ${goalId}`, data, [goalId], 'needs_human'),
          human: `${title(`bolloon task status ${id}`)}\n  找不到这个 Goal\n${line('原因', plan.reason)}`,
        };
      }
      if (plan.action === 'retry_payment') {
        // 目标在, 但没有任何交易 → 还没付过钱 (真的没花钱, 不是失败)
        return {
          envelope: okEnvelope('OK', `Goal ${goalId} 还没有过交易 (没付过钱): ${plan.reason}`, data, [goalId], 'retry_same_request'),
          human: `${title(`bolloon task status ${id}`)}\n${line('goalId', goalId)}\n${line('交易', '还没有 (没付过钱)')}\n${line('恢复动作', plan.action)}\n${line('mustNotRepay', plan.mustNotRepay ? 'true' : 'false')}\n\n${hint('下一步: bolloon task --resume ' + goalId + ' (从头跑, 没有钱可重复付)')}`,
        };
      }
      return {
        envelope: failEnvelope('RESULT_UNVERIFIED', `Goal ${goalId} 不能自动继续: ${plan.reason}`, data, [goalId], 'needs_human'),
        human: failHuman(`bolloon task status ${id}`, { code: 'RESULT_UNVERIFIED', message: plan.reason, next_action: 'needs_human' }),
      };
    }
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到这个 id 对应的任务/交易: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon task status ${id}`)}\n  没找到\n\n${hint('下一步: bolloon task list 看本地有哪些交易/目标')}`,
    };
  }
  const s = recSummary(rec);
  const j = judge(rec);
  const human = [
    title(`bolloon task status ${rec.transactionId}`),
    line('对外状态', s.publicStatus),
    line('生命周期', s.lifecycle),
    line('结算事实', s.settlementFact),
    line('结算口径', s.settlement + (s.settlement === 'local-dev' ? ' (链上没动钱: 协议闭环通过, 不是支付成功)' : '')),
    line('链上结算', s.chainSettled ? '是' : '否'),
    line('算不算成功', s.success ? '算 (verified ∧ 链上口径事实)' : '不算'),
    line('requestId', s.requestId),
    ...(s.goalId ? [line('goalId', s.goalId)] : []),
    ...(s.txHash ? [line('txHash', s.txHash)] : []),
    line('事件', `${rec.events?.length || 0} 条 (bolloon trade events ${rec.transactionId})`),
    ...(goalId && plan ? [line('恢复动作', `${plan.action} — ${plan.reason}`)] : []),
  ].join('\n');
  return {
    envelope: envelopeForState(j.ok, j.code, `任务 ${rec.transactionId}: ${s.lifecycle}/${s.settlementFact} (${s.settlement})`, { ...s, goalRecovery: goalId && plan ? plan : null }, [rec.transactionId, rec.requestId, ...(rec.txHash ? [rec.txHash] : [])], j.next),
    human,
  };
}

// ── result (任务层: 已存结果 + 真验真) ───────────────────────────────────────

/**
 * 任务层结果: 把**已收到/已存**的 TaskResult 读出来 —— 内容哈希/CID + 签名 + 验真状态。
 * 真验真 = 用**存下来的提供方公钥**现场再验一次签名, 并核对正文哈希; 验不过就如实说不过。
 */
async function taskLayerResultEnvelope(id: string): Promise<CommandResult | null> {
  const { findResult, readBody, readInboxItem, readLocalTask, listInbox, listLocalTasks } = await import('../../agents/task-inbox.js');
  const { verifyTaskEnvelope } = await import('../../agents/task-contract.js');
  const { verifierFor } = await import('../../agents/local-signer.js');
  const home = os.homedir();

  const found = findResult(id, home);
  if (!found) return null;
  const { result } = found;

  const inbox = readInboxItem(result.requestId, home) || listInbox(home).find((i) => i.taskId === result.taskId) || null;
  const local = readLocalTask(result.requestId, home) || listLocalTasks(home).find((t) => t.taskId === result.taskId) || null;
  const providerKey = (local as any)?.providerPublicKeyHex || (inbox as any)?.providerPublicKeyHex || null;

  // ★ 现场重验签名 (存下来的公钥就是当时那个签名者的公钥)
  const v = providerKey ? verifierFor(providerKey) : null;
  const signatureVerified = v ? await verifyTaskEnvelope(result as any, v as any) : null;
  const body = readBody(result.taskId, home);
  const trust = signatureVerified === true ? (body.matches === false ? 'signature-ok/body-mismatch' : 'protocol-verified') : signatureVerified === false ? 'signature-invalid' : 'unverified';

  const data = {
    layer: 'task',
    requestId: result.requestId,
    taskId: result.taskId,
    capability: (local as any)?.capability || (inbox as any)?.capability || null,
    providerDid: (local as any)?.providerDid || (inbox as any)?.providerDid || null,
    state: (local as any)?.state || (inbox as any)?.state || 'delivered',
    result: {
      ok: result.ok === true,
      summary: result.summary,
      contentHash: result.contentHash || null,
      cid: result.cid || null,
      deliveredAt: result.deliveredAt,
      signed: !!result.signature,
      signerPublicKeyTrust: providerKey ? 'stored-with-request (收请求/回执时一并存下)' : 'not-on-file (没存到签名者公钥, 无法现场重验)',
    },
    verification: {
      signatureVerified,                               // true / false / null(没有公钥可验)
      trust,                                           // 分档, 绝不把"没验"说成"验过"
      bodyPresent: body.present,
      bodyBytes: body.present ? body.bytes : null,
      bodyHashMatches: body.matches,
      chainSettled: false,
      success: false,                                  // ★ §5.2: 没有链上结算就永远不是"成功"
      why: '任务层结果只到 delivered: 成功判据是 state=verified ∧ 支付事实 ∈ {fully_settled, payment_verified} (P1 §5.2)',
    },
    bodyPrinted: false,
    bodyFile: body.file,
    paid: false,
    note: '交付正文留在本机私有层 (绝不进 stdout/公开投影); 结果签名只证明"提供方交付了这份内容哈希"',
  };

  const human = [
    title(`bolloon task result ${result.requestId}`),
    line('任务号', result.taskId),
    line('结果', `${result.ok ? 'ok' : 'not-ok'} — ${String(result.summary || '').slice(0, 80)}`),
    line('内容哈希', result.contentHash ? `${result.contentHash.slice(0, 16)}…` : '(无)'),
    ...(result.cid ? [line('CID', result.cid)] : []),
    line('签名', result.signature ? (signatureVerified === true ? '有, 现场重验通过' : signatureVerified === false ? '有, 但**验不过**' : '有, 但没有公钥可验 (如实)') : '没有'),
    line('验真分档', trust),
    line('正文在盘', body.present ? `是 (${body.bytes} 字节, 哈希匹配=${body.matches === null ? '无从比对' : body.matches})` : `否 — ${body.reason || '不在盘上'}`),
    line('正文文件', body.file),
    line('正文输出', '未输出 (私有层)'),
    line('算不算成功', '不算 (没有链上结算; 任务层最高 delivered)'),
  ].join('\n');

  return {
    envelope: okEnvelope('TASK_COMPLETED', `任务 ${result.requestId} 的结果 (已交付; 正文未输出)`, data as Record<string, unknown>,
      [result.requestId, result.taskId, ...(result.contentHash ? [result.contentHash] : []), ...(result.cid ? [result.cid] : [])], 'verify_result'),
    human,
  };
}

// ── result ──────────────────────────────────────────────────────────────────

async function taskResult(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 transactionId (或 --request-id)', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  // ★ 先看任务层 (bolloon-task/1): 已存的 TaskResult (内容哈希/CID + 签名 + 现场重验)
  const taskLayer = await taskLayerResultEnvelope(id);
  if (taskLayer) return taskLayer;

  const { rec } = await resolveTarget(id);
  if (!rec) {
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到交易或任务结果: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon task result ${id}`)}\n  没找到这笔交易, 也没有已存的任务结果`,
    };
  }
  const { verifyDelivery } = await import('../../agents/x402/settlement-state.js');
  const dv = verifyDelivery(rec, os.homedir());
  const s = recSummary(rec);
  const j = judge(rec);
  // ★ 交付正文**不进 stdout/日志** (P1 §5.6 私有一层): 只给字节数/哈希/在盘证据
  const data = {
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    lifecycle: s.lifecycle,
    settlementFact: s.settlementFact,
    settlement: s.settlement,
    success: s.success,
    verificationTrust: rec.verificationTrust || 'unverified',
    protocolVerified: rec.protocolVerified === true,
    delivery: {
      present: dv.present,
      bytes: dv.bytes ?? null,
      bytesHash: dv.bytesHash || null,
      matchesRecorded: dv.matchesRecorded,
      reason: dv.reason || null,
      contentHash: rec.contentHash || null,
      deliveryHash: rec.deliveryHash || null,
      receiptHash: rec.receiptHash || null,
      storedAs: `~/.bolloon/x402/deliveries/${rec.transactionId}.txt`,
      bodyPrinted: false,
    },
    note: '正文留在本机交付目录 (公开层/日志永不输出正文); 需要正文请在本机直接读该文件',
  };
  const human = [
    title(`bolloon task result ${rec.transactionId}`),
    line('对外状态', s.publicStatus),
    line('结算口径', s.settlement),
    line('算不算成功', s.success ? '算' : '不算'),
    line('验真分档', data.verificationTrust),
    line('正文在盘', dv.present ? `是 (${dv.bytes ?? '?'} 字节, 哈希匹配=${dv.matchesRecorded})` : `否${dv.reason ? ` — ${dv.reason}` : ''}`),
    line('正文文件', data.delivery.storedAs),
    line('正文输出', '未输出 (私有层: 绝不进 stdout/日志)'),
    `\n  ${data.note}`,
  ].join('\n');
  return {
    envelope: envelopeForState(j.ok, j.code, `任务 ${rec.transactionId} 的交付证据 (正文未输出)`, data, [rec.transactionId, ...(dv.bytesHash ? [dv.bytesHash] : []), ...(rec.contentHash ? [rec.contentHash] : [])], j.next),
    human,
  };
}

// ── retry (只出计划, 绝不代付款) ─────────────────────────────────────────────

const PLAN_NEXT: Record<string, NextAction> = {
  retry_payment: 'approve_payment',
  reconcile: 'reconcile',
  deliver: 'needs_human',
  verify: 'needs_human',
  closed: 'needs_human',
  wait: 'wait',
  complete: null,
};

async function taskRetry(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 transactionId / requestId / goalId', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const { rec, goalId, plan } = await resolveTarget(id);
  if (!rec) {
    if (goalId && plan) {
      // goalId 路径: 走 decideTaskRecovery (Supervisor 与 CLI --resume 共用的唯一决策入口)
      const next: NextAction = plan.action === 'retry_payment'
        ? (plan.transactionId ? `x402_payment_retry:${plan.transactionId}` as NextAction : 'retry_same_request')
        : plan.action === 'already_executed' ? 'needs_human' : (PLAN_NEXT[plan.action] ?? 'needs_human');
      const data = {
        goalId, action: plan.action, reason: plan.reason, mustNotRepay: plan.mustNotRepay,
        transactionId: plan.transactionId ?? null, hasTransaction: !!plan.transactionId,
        decisionSource: 'task-runner.decideTaskRecovery (CLI --resume 与 Supervisor 同一入口)',
        paid: false,
      };
      return {
        envelope: envelopeForState(plan.action === 'complete', 'RECOVERY_PLANNED', `恢复计划: ${plan.action}${plan.mustNotRepay ? ' (绝不重付)' : ''}`, data, plan.transactionId ? [plan.transactionId, goalId] : [goalId], next),
        human: [
          title(`bolloon task retry ${goalId}`),
          line('动作', plan.action),
          line('原因', plan.reason),
          line('绝不重付', plan.mustNotRepay ? 'true (已有支付证据/不确定 → 先对账)' : 'false (确认没付过, 可从同一 requestId 幂等重发)'),
          line('交易', plan.transactionId || '(还没有)'),
          `\n  ${hint('这条命令只出计划, 不代付款 (Supervisor/CLI 都不持有钱包)。要继续: bolloon task --resume ' + goalId)}`,
        ].join('\n'),
      };
    }
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到这个 id: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon task retry ${id}`)}\n  没找到`,
    };
  }
  // 交易路径: 唯一决策点 planTransactionRecovery (绝不自己 if-else, 也绝不绕过去付款)
  const { planTransactionRecovery } = await import('../../agents/x402/payment-recovery.js');
  const p = planTransactionRecovery(rec);
  const next: NextAction = PLAN_NEXT[p.action] === 'approve_payment' && p.mustNotRepay
    ? `x402_payment_retry:${rec.transactionId}` as NextAction
    : (p.action === 'deliver' || p.action === 'verify' ? `x402_continue:${rec.transactionId}` as NextAction : PLAN_NEXT[p.action]);
  const data = {
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    action: p.action,
    settlementFact: p.settlementFact,
    mustNotRepay: p.mustNotRepay,
    needsResponsibility: p.needsResponsibility,
    reason: p.reason,
    lifecycle: String(rec.status),
    settlement: settlementLabel(rec),
    decisionSource: 'x402/payment-recovery.planTransactionRecovery',
    paid: false,
    paidNote: 'CLI 只出计划, 不发付款: 付款必须由**持钱包的一方**走同一 requestId 的幂等路径',
  };
  const human = [
    title(`bolloon task retry ${rec.transactionId}`),
    line('动作', p.action),
    line('原因', p.reason),
    line('结算事实', p.settlementFact),
    line('绝不重付', p.mustNotRepay ? 'true' : 'false'),
    line('结算口径', settlementLabel(rec)),
    line('本次付款', '没有 (只出计划)'),
    `\n  ${hint('下一步: ' + (p.action === 'reconcile' ? '先对账 (trade reconcile) —— 付款不确定绝不当失败' : String(next)))}`,
  ].join('\n');
  return {
    envelope: envelopeForState(p.action === 'complete', 'RECOVERY_PLANNED', `恢复计划: ${p.action}${p.mustNotRepay ? ' (绝不重付)' : ''}`, data, [rec.transactionId, rep(rec)], next),
    human,
  };
}

function rep(rec: Rec): string { return rec.requestId; }

// ── run (M1 唯一入口的同一条路径) ────────────────────────────────────────────

async function taskRun(flags: CliFlags): Promise<CommandResult> {
  const { runTask } = await import('../../agents/task/task-runner.js');
  const task = flags.positionals.slice(1).join(' ').trim();
  if (!task) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少任务正文 (bolloon task run "<任务>" --budget 0.05)', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const r = await runTask({
    task,
    budget: opt(flags, '--budget'),
    perPurchase: opt(flags, '--per-purchase'),
    daily: opt(flags, '--daily'),
    requestId: flags.requestId,
    input: parseInput(opt(flags, '--input')),
    allowLocalDev: true,
  });
  const chainSettled = r.payment?.chainSettled === true;
  const settlement: 'chain' | 'local-dev' | 'none' = r.payment
    ? (chainSettled ? 'chain' : (r.payment.mode === 'local-dev' ? 'local-dev' : 'none'))
    : 'none';
  // ★ local-dev 最高到 delivered: 不许输出成 TASK_VERIFIED (P1 §5.1)
  const code: Code = r.ok ? (chainSettled ? 'TASK_VERIFIED' : 'TASK_COMPLETED') : (r.card.hardGate === 'bought_not_executed' ? 'DELIVERY_FAILED' : 'RESULT_UNVERIFIED');
  const next: NextAction = r.ok ? (chainSettled ? null : 'verify_result') : 'needs_human';
  const data = {
    goalId: r.goalId || null,
    runId: r.runId || null,
    transactionId: r.transactionId || null,
    publicStatus: r.card.status,
    conclusion: r.card.conclusion,
    executed: r.card.executed,
    paid: r.card.paid,
    checks: r.card.checks,
    hardGate: r.card.hardGate || null,
    payment: r.payment || null,
    settlement,
    success: !!(r.ok && chainSettled),
    budget: { taskBudget: r.budget.taskBudget, perPurchase: r.budget.perPurchase, daily: r.budget.daily, clamped: r.budget.clamped },
    outputIssues: r.outputIssues,
    stages: r.stages,
    note: settlement === 'chain'
      ? undefined
      : settlement === 'local-dev'
        ? '本机联调 (local-dev): 协议闭环通过, 链上没动钱 —— 不是"支付成功", 也不算任务成功'
        : '这次没有发生付款 (settlement=none): 没有链上也没有联调结算, 也没有花钱',
  };
  const human = [`${title('bolloon task run')}`, r.text, '', line('对外状态', r.card.status), line('结算口径', settlement)].join('\n');
  const env: Envelope = r.ok
    ? okEnvelope(code, `任务${chainSettled ? '已验真' : '已交付 (local-dev, 链上未结算)'}`, data, [r.goalId, r.runId, r.transactionId].filter(Boolean) as string[], next)
    : failEnvelope(code, `任务没走完: ${r.card.blocker || r.card.conclusion}`, data, [r.goalId, r.runId, r.transactionId].filter(Boolean) as string[], next);
  return { envelope: env, human };
}

function parseInput(raw?: string): unknown {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// ── bolloon-task/1 真收发: send / inbox / accept / reject ────────────────────

/** 人类单位 → 原子单位正整数串 (拒绝 0 / 负 / 超精度; 浮点模糊一律拒) */
function toAtomic(human: string, decimals: number): string | null {
  const s = String(human ?? '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  const n = BigInt(i + (f + '0'.repeat(decimals)).slice(0, decimals));
  return n > 0n ? n.toString() : null;
}

/** `--deadline +2h` / `+30m` / `+45s` / `+1d`, 或未来毫秒时间戳 */
function parseDeadline(v: string | undefined, now = Date.now()): number | string {
  if (v === undefined) return now + 24 * 60 * 60 * 1000;
  const m = /^\+(\d+)(s|m|h|d)$/.exec(String(v).trim());
  if (m) {
    const n = Number(m[1]);
    const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    return now + n * mult;
  }
  const n = Number(v);
  if (Number.isFinite(n) && n > now) return Math.floor(n);
  return `--deadline 不合法: ${v} (要 +30m/+2h/+1d, 或未来的毫秒时间戳)`;
}

/** 本机身份 (签名用)。没有 → 结构化失败 (绝不假签名)。 */
async function requireSigner(head: string): Promise<{ signer: any } | { fail: CommandResult }> {
  const { loadLocalSigner } = await import('../../agents/local-signer.js');
  const signer = await loadLocalSigner();
  if (!signer) {
    const msg = '本机没有可签名的身份 (~/.bolloon/identity.json 不存在或不可读)';
    return {
      fail: {
        envelope: failEnvelope('WALLET_UNAVAILABLE', msg, { identityFile: '~/.bolloon/identity.json', privateKeyPrinted: false }, [], 'needs_human'),
        human: `${title(head)}\n  ${msg}\n\n${hint('下一步: bolloon setup 生成本机身份')}`,
      },
    };
  }
  return { signer };
}

/**
 * 本机对某 capability 的"已知"事实 = 进程内 manifest + 本地注册表 (`~/.bolloon/agent-registry.json`)。
 * 两处都没有 → 未知 (接单会被拒; 绝不假装有能力)。价格取本机为该能力登记的价。
 */
async function localCapabilityFacts(capability: string): Promise<{
  known: boolean; sources: string[]; priceAmount: string | null; currency: string | null; wallet: string | null; services: number;
}> {
  const sources: string[] = [];
  let manifestCaps: string[] = [];
  try {
    const { getLocalManifest } = await import('../../agents/agent-manifest-protocol.js');
    manifestCaps = ((getLocalManifest().agents || []) as any[]).flatMap((a) => a.capabilities || []);
  } catch { /* 没有 manifest 不影响 */ }
  if (manifestCaps.includes(capability)) sources.push('local-manifest');
  let services: any[] = [];
  try {
    const { getAgentRegistry } = await import('../../agents/agent-registry.js');
    services = await getAgentRegistry().list();
  } catch { services = []; }
  const hits = (services || []).filter((s) => (s?.capabilities || []).includes(capability) || s?.service?.name === capability);
  if (hits.length) sources.push(`registry(${hits.length})`);
  const hit = hits.find((s) => s?.service?.price?.amount) || hits[0];
  return {
    known: sources.length > 0,
    sources,
    priceAmount: hit?.service?.price?.amount ?? null,
    currency: hit?.service?.price?.currency ?? null,
    wallet: hit?.wallet ?? null,
    services: services.length,
  };
}

/** 把回执帧发回发送方 (有 replyTo 才发; 失败如实记, 不假装送达) */
async function sendReplyFrames(
  replyTo: string | null,
  frames: any[],
  timeoutMs?: number,
): Promise<{ attempted: boolean; ok: boolean; target: string | null; error?: string; results: Array<{ frame: string; ok: boolean; error?: string; elapsedMs: number }> }> {
  if (!replyTo) {
    return { attempted: false, ok: false, target: null, error: '发送方没有留下回执端点 (--reply-to)', results: [] };
  }
  const { httpTaskTransport } = await import('../../agents/task-transport.js');
  const t = httpTaskTransport();
  const results: Array<{ frame: string; ok: boolean; error?: string; elapsedMs: number }> = [];
  for (const f of frames) {
    const r = await t.send(replyTo, f, timeoutMs);
    results.push({ frame: String(f.frame), ok: r.ok, error: r.error, elapsedMs: r.elapsedMs });
  }
  return { attempted: true, ok: results.every((r) => r.ok), target: replyTo, results, ...(results.every((r) => r.ok) ? {} : { error: '部分/全部回执没送达' }) };
}

/** `--json` 里出现的中转摘要 (不打印私钥/正文全文) */
function transferView(t: any) {
  return t ? { kind: t.kind, target: t.target, ok: t.ok, elapsedMs: t.elapsedMs, duplicate: t.duplicate === true, error: t.error || null, detail: t.detail || null } : null;
}

// ── send ────────────────────────────────────────────────────────────────────

/**
 * 没有匹配的 provider 时: 板上若有**可接单**的公告 → 给可操作提示 (指向 board/claim)。
 * 拿不到板上的事实 → `hint:null` + 如实带 `boardError` (不猜、不假装有公告)。
 */
async function boardHintForCapability(capability: string): Promise<{ count: number; announcements: Array<Record<string, unknown>>; hint: string | null; boardError: string | null }> {
  try {
    const { findOpenAnnouncementsForCapability } = await import('../../agents/task-board.js');
    const open = await findOpenAnnouncementsForCapability(capability);
    if (!open.length) return { count: 0, announcements: [], hint: null, boardError: null };
    const first = open[0];
    return {
      count: open.length,
      announcements: open.slice(0, 5).map((a) => ({
        announcementId: a.announcementId, capability: a.capability, status: a.status,
        budget: a.budget, deadline: a.deadline, buyer: a.buyerShort, remote: a.remote,
        signatureVerified: a.signatureVerified,
      })),
      hint: `板上有 ${open.length} 条可接单的 '${capability}' 任务: 先 bolloon task board 看全, 或直接 bolloon task claim ${first.announcementId}`,
      boardError: null,
    };
  } catch (e: any) {
    return { count: 0, announcements: [], hint: null, boardError: String(e?.message || e).slice(0, 160) };
  }
}

async function taskSend(flags: CliFlags): Promise<CommandResult> {
  const instruction = opt(flags, '--instruction') || flags.positionals.slice(1).join(' ').trim();
  const capability = opt(flags, '--capability');
  if (!instruction || !capability) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少任务正文或 --capability',
        { usage: plain(TASK_USAGE.trim()), got: { instruction: !!instruction, capability: capability || null } }, [], 'needs_human'),
      human: `${TASK_USAGE}\n${hint('示例: bolloon task send --capability research --instruction "调研日本厨房用品市场" --endpoint http://127.0.0.1:54901')}`,
    };
  }

  const s = await requireSigner('bolloon task send');
  if ('fail' in s) return s.fail;
  const signer = s.signer;

  // 预算 / 币种 / 网络 (字段名与 TaskBudget 一致)
  const budgetHuman = opt(flags, '--budget');
  const currency = String(opt(flags, '--currency') || 'USDC').toUpperCase();
  if (currency !== 'USDC' && currency !== 'ETH') {
    return { envelope: failEnvelope('INVALID_ARGUMENT', `--currency 只支持 USDC/ETH (收到 ${currency})`, { currency }, [], 'needs_human'), human: TASK_USAGE };
  }
  const network = opt(flags, '--network') || 'base-sepolia';
  let budget: import('../../agents/task-contract.js').TaskBudget | undefined;
  if (budgetHuman !== undefined) {
    const atomic = toAtomic(budgetHuman, currency === 'USDC' ? 6 : 18);
    if (!atomic) {
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', `--budget 必须是正数 (收到 ${budgetHuman}); 原子单位串由本命令换算, 不接受 0/负/超精度`,
          { budget: budgetHuman, currency, accepted: ['--budget 0.05'] }, [], 'needs_human'),
        human: TASK_USAGE,
      };
    }
    budget = { maxAmount: atomic, currency, network };
  }
  // 支付模式: 缺省 policy (需要人工/策略放行); 本命令**不付款**, 模式只写进信封给对端与后续付款方看
  const modeRaw = opt(flags, '--mode') || 'policy';
  const { isPaymentMode, TASK_PROTOCOL, taskRequestId, newTaskId, validateTaskRequest, signTaskEnvelope } = await import('../../agents/task-contract.js');
  if (!isPaymentMode(modeRaw)) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--mode 非法: ${modeRaw} (要 manual|policy|autonomous|agent-authorized)`, { mode: modeRaw }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const dl = parseDeadline(opt(flags, '--deadline'));
  if (typeof dl === 'string') {
    return { envelope: failEnvelope('INVALID_ARGUMENT', dl, { deadline: opt(flags, '--deadline') }, [], 'needs_human'), human: TASK_USAGE };
  }

  // 确定性幂等键 + taskId (同 requestId 重发不发生第二笔付款)
  const requestId = flags.requestId || taskRequestId({ instruction, capability, buyerDid: signer.did, salt: opt(flags, '--salt') });

  // 目标解析: --endpoint > --peer > --via gateway > registry 发现
  const {
    httpTaskTransport, irohTaskTransport, gatewayTaskTransport, resolveTaskTarget, buildTaskFrame,
  } = await import('../../agents/task-transport.js');
  const { readLocalTask, upsertLocalTask, patchLocalTask } = await import('../../agents/task-inbox.js');

  const endpoint = opt(flags, '--endpoint') || opt(flags, '--url');
  const peer = opt(flags, '--peer');
  const via = opt(flags, '--via');
  let target = '';
  let targetSource = '';
  let transportKind: 'http' | 'iroh' | 'gateway' = 'http';
  let providerDid = opt(flags, '--provider') || '';

  if (endpoint) { target = endpoint; targetSource = 'CLI 显式 --endpoint'; transportKind = 'http'; }
  else if (peer) { target = peer; targetSource = 'CLI 显式 --peer (iroh nodeId)'; transportKind = 'iroh'; }
  else {
    const resolved = await resolveTaskTarget(capability);
    if (resolved.target) {
      target = resolved.target.target;
      targetSource = resolved.target.source;
      transportKind = via === 'gateway' ? 'gateway' : resolved.target.kind;
      providerDid = providerDid || resolved.target.providerDid || '';
    } else if (via === 'gateway') {
      const boardHint = await boardHintForCapability(capability);
      return {
        envelope: failEnvelope('CAPABILITY_NOT_FOUND', `注册表里没有能力 '${capability}' 的 provider (registry ${resolved.registryReady ? '就绪' : '未就绪'}, ${resolved.candidates} 条候选)${boardHint.hint ? `；${boardHint.hint}` : ''}`,
          { capability, registryReady: resolved.registryReady, candidates: resolved.candidates, via: 'gateway', board: boardHint },
          [], 'redefine_capability'),
        human: [
          `${title('bolloon task send')}`,
          `  注册表里没有这个能力的 provider, gateway 传输没有目标`,
          ...(boardHint.hint ? [`\n  ${hint(boardHint.hint)}`] : []),
        ].join('\n'),
      };
    } else {
      const joined = resolved.registryReady;
      const boardHint = await boardHintForCapability(capability);
      return {
        envelope: failEnvelope(joined ? 'CAPABILITY_NOT_FOUND' : 'NETWORK_NOT_JOINED',
          joined
            ? `注册表里没有能力 '${capability}' 的 provider (${resolved.candidates} 条候选, 且都没有 endpoint)${boardHint.hint ? `；${boardHint.hint}` : ''}`
            : `本机 registry 未就绪 (没有入网/没拉过任何服务声明), 无法解析目标`,
          { capability, registryReady: joined, candidates: resolved.candidates, board: boardHint, howTo: '用 --endpoint http://host:port 显式给目标, 或先 bolloon network join / bolloon agent register' },
          [], joined ? 'redefine_capability' : 'rejoin_network'),
        human: [
          `${title('bolloon task send')}`,
          `  ${joined ? '注册表里没有这个能力' : '本机还没入网, 也没有显式 --endpoint'}`,
          ...(boardHint.hint ? [`\n  ${hint(boardHint.hint)}`] : []),
          `\n${hint('示例: bolloon task send --capability research --instruction "…" --endpoint http://127.0.0.1:54901')}`,
        ].join('\n'),
      };
    }
  }
  if (via === 'gateway') transportKind = 'gateway';
  const provider = providerDid || `did:unknown:${String(target).replace(/^https?:\/\//, '').slice(0, 60)}`;

  const existing = readLocalTask(requestId);
  const taskId = existing?.taskId || newTaskId();

  // 构造 + **签名** 请求 (契约层: signTaskEnvelope; 私钥只在本机进程)
  const unsigned = {
    protocol: TASK_PROTOCOL,
    taskId,
    requestId,
    capability,
    instruction,
    ...(budget ? { budget } : {}),
    paymentMode: modeRaw,
    deadline: dl,
    buyerDid: signer.did,
    providerDid: provider,
    signature: '',
  } as import('../../agents/task-contract.js').TaskRequest;
  const signed = await signTaskEnvelope(unsigned, signer.keypair);
  const v = validateTaskRequest(signed, { now: Date.now() });
  if (!v.ok) {
    const issues = v.issues;
    const code: Code = issues.some((x) => x.includes('协议版本')) ? 'PROTOCOL_VERSION_UNSUPPORTED'
      : issues.some((x) => x.includes('deadline')) ? 'DEADLINE_EXPIRED'
        : issues.some((x) => x.includes('预算')) ? 'BUDGET_EXCEEDED'
          : issues.some((x) => x.includes('缺签名')) ? 'SIGNATURE_REQUIRED'
            : 'INVALID_ARGUMENT';
    const next: NextAction = code === 'PROTOCOL_VERSION_UNSUPPORTED' ? 'upgrade_client'
      : code === 'DEADLINE_EXPIRED' ? 'retry_same_request'
        : code === 'BUDGET_EXCEEDED' ? 'raise_budget' : 'needs_human';
    return {
      envelope: failEnvelope(code, `请求没通过契约层校验: ${issues.join('; ')}`, { requestId, taskId, issues, paid: false }, [requestId], next),
      human: `${title('bolloon task send')}\n  请求没通过校验:\n${issues.map((i) => `    · ${i}`).join('\n')}`,
    };
  }

  const replyTo = opt(flags, '--reply-to') || null;
  const frame = buildTaskFrame('task_request', signed, { did: signer.did, publicKeyHex: signer.publicKeyHex }, { replyTo });

  // 传输: 不可用 → 结构化诚实失败 (绝不假装已发出)
  const transport = transportKind === 'iroh' ? irohTaskTransport({ startIfNeeded: true })
    : transportKind === 'gateway' ? gatewayTaskTransport()
      : httpTaskTransport();
  const avail = await transport.available();
  if (!avail.ok) {
    return {
      envelope: failEnvelope('TRANSPORT_UNAVAILABLE', `传输不可用 (${transportKind}): ${avail.reason}`,
        { requestId, taskId, target, transport: { kind: transportKind, available: false, reason: avail.reason }, state: 'quoted', paid: false },
        [requestId, taskId], 'needs_human'),
      human: `${title('bolloon task send')}\n  传输不可用 (${transportKind}): ${avail.reason}\n\n${hint('没有真发出任何东西; 收件箱里不会有它')}`,
    };
  }

  const transfer = await transport.send(target, frame, flags.timeoutMs);
  const receipt = { at: Date.now(), ok: transfer.ok, duplicate: transfer.duplicate === true, error: transfer.error || null };

  // 落本机台账 (发出去了/没发出去都要留痕, 但不覆盖已推进的状态)
  upsertLocalTask({
    protocol: TASK_PROTOCOL,
    requestId, taskId, capability, instruction,
    buyerDid: signer.did, providerDid: provider,
    target, transportKind,
    state: 'submitted',
    sentAt: Date.now(), updatedAt: Date.now(),
    requestSignature: signed.signature,
    receipt,
    notes: [transfer.ok ? `已发给 ${target} (${transportKind}, ${transfer.elapsedMs}ms${transfer.duplicate ? ', 对端说是重复' : ''})` : `发送失败: ${transfer.error}`],
  });

  if (!transfer.ok) {
    return {
      envelope: failEnvelope(/超时/.test(String(transfer.error)) ? 'TIMEOUT' : 'TRANSPORT_FAILED',
        `任务没发出去: ${transfer.error}`,
        {
          taskId, requestId, target, targetSource,
          transport: transferView(transfer),
          state: 'submitted', paid: false, localLedger: `~/.bolloon/tasks/local/${requestId}.json`,
          note: '请求已签名但**没有送达**; 收件箱里不会有它 (本命令不重试, 也不假装成功)',
        },
        [requestId, taskId], 'retry_same_request'),
      human: `${title('bolloon task send')}\n  没发出去: ${transfer.error}\n${line('目标', target)}\n${line('幂等键', requestId)}\n\n${hint('同一 requestId 重发是幂等的 (不会产生第二笔付款)')}`,
    };
  }

  // 对端若立刻回了帧 (accept/reject/result) → 走**同一套**收件侧语义落盘
  let applied: Record<string, unknown> | null = null;
  if (transfer.reply) {
    const { handleTaskFrame } = await import('../../web/task-frame-server.js');
    const r = await handleTaskFrame(transfer.reply, { home: os.homedir() });
    applied = { frame: transfer.reply.frame, ok: r.ok, note: r.note || null, error: r.error || null, facts: r.facts || null };
    if (r.error) patchLocalTask(requestId, { notes: [...(readLocalTask(requestId)?.notes || []), `回执处理失败: ${r.error}`] });
  }

  const data = {
    taskId, requestId, target, targetSource, capability,
    state: 'submitted',
    paymentMode: modeRaw,
    budget: budget || null,
    deadline: dl,
    transport: transferView(transfer),
    replyTo,
    receipt,
    reply: applied,
    /** ★ 本命令**没有**发起任何付款 (付款只能由持钱包的一方走同一 requestId 的 x402 幂等路径) */
    transactionId: null,
    paid: false,
    localLedger: `~/.bolloon/tasks/local/${requestId}.json`,
    note: '任务正文只在信封里走这条直连任务通道 (不用公开投影); 默认 policy 模式: 付款要人工/策略放行, 本命令不付钱',
  };
  return {
    envelope: okEnvelope('TASK_SUBMITTED', `任务已签名发出: ${capability} → ${target}`, data, [requestId, taskId], null),
    human: [
      title('bolloon task send'),
      line('任务号', taskId),
      line('幂等键', requestId),
      line('目标', `${target} (${transportKind})`),
      line('capability', capability),
      line('截止时间', new Date(Number(dl)).toISOString()),
      line('结果', transfer.duplicate ? '对端说这是重复请求 (幂等: 不重复接受)' : '对端收下了 (有回执)'),
      line('本次付款', '没有 (发送任务不付款)'),
      `\n  ${hint('下一步: 等对端 bolloon task inbox / accept; 查状态: bolloon task status ' + requestId)}`,
    ].join('\n'),
  };
}

// ── inbox ───────────────────────────────────────────────────────────────────

async function taskInbox(flags: CliFlags): Promise<CommandResult> {
  const { listInbox, inboxSummary } = await import('../../agents/task-inbox.js');
  const all = listInbox();
  const showAll = has(flags, '--all');
  const summaries = (showAll ? all : all.filter((i) => i.state === 'pending')).map((i) => inboxSummary(i));
  const pending = all.filter((i) => i.state === 'pending').length;
  const data = {
    count: summaries.length,
    pending,
    total: all.length,
    dir: '~/.bolloon/tasks/inbox',
    filter: showAll ? 'all' : 'pending',
    items: summaries,
    note: '收件箱只落**待处理请求**: 不执行、不付款、不自动接单; 同一 requestId 幂等去重 (dedupeInbox)',
    bodyNote: 'instructionPreview 是本机预览 (60 字); 正文只在本机收件箱文件里, 不进公开投影',
    next: pending > 0 ? '要人决定接不接: bolloon task accept <requestId> / bolloon task reject <requestId> --reason "…"' : null,
  };
  const human = summaries.length
    ? summaries.map((i) => [
      `\n  ${i.requestId}`,
      `    任务号     ${i.taskId}`,
      `    发送方     ${i.sender || '(无)'}`,
      `    capability ${i.capability}`,
      `    截止时间   ${i.deadline ? `${new Date(i.deadline).toISOString()} (${(i.deadlineInMs ?? 0) > 0 ? `还剩 ${Math.round((i.deadlineInMs ?? 0) / 1000)}s` : '已过期'})` : '(无)'}`,
      `    状态       ${i.state}${i.requestSignatureVerified === true ? ' · 请求验签通过' : i.requestSignatureVerified === false ? ' · 请求验签**不过**' : ' · 请求未验签(如实)'}`,
      i.budget ? `    预算       ≤ ${i.budget.maxAmount} (原子) ${i.budget.currency} @ ${i.budget.network}` : '    预算       (无)',
      `    预览       ${i.instructionPreview}`,
    ].join('\n')).join('')
    : '\n  (收件箱空: 没有待处理请求)';
  return {
    envelope: okEnvelope('OK', `收件箱: ${summaries.length} 条${showAll ? ' (全部)' : '待处理'} (共 ${all.length} 条)`, data, summaries.map((i) => i.requestId), pending > 0 && !showAll ? 'needs_human' : null),
    human: [`${title('bolloon task inbox')}${human}`, '', `  ${String(data.note)}`, pending > 0 ? `\n  ${hint('下一步: bolloon task accept ' + (summaries.find((i) => i.state === 'pending')?.requestId || '<requestId>'))}` : ''].join('\n'),
  };
}

// ── accept ──────────────────────────────────────────────────────────────────

async function taskAccept(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', '缺少 requestId (或 taskId)', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'), human: TASK_USAGE };
  }
  const { readInboxItem, listInbox, patchInboxItem, saveBody, saveResult } = await import('../../agents/task-inbox.js');
  const { TASK_PROTOCOL, signTaskEnvelope } = await import('../../agents/task-contract.js');
  const item = readInboxItem(id) || listInbox().find((i) => i.taskId === id) || null;
  if (!item) {
    return {
      envelope: failEnvelope('NOT_FOUND', `收件箱里没有这个请求: ${id}`, { id, dir: '~/.bolloon/tasks/inbox' }, [], 'needs_human'),
      human: `${title('bolloon task accept ' + id)}\n  收件箱里没有它\n\n${hint('下一步: bolloon task inbox 看有哪些待处理的请求')}`,
    };
  }
  // 幂等: 已经处理过 → 返回既有事实, 不重复接受/不重复执行/不重复收费
  if (item.state !== 'pending') {
    return {
      envelope: failEnvelope('DUPLICATE_REQUEST', `这个 requestId 已经处理过了 (state=${item.state}); 幂等: 不重复接受`,
        { requestId: item.requestId, taskId: item.taskId, state: item.state, accept: item.accept ? { providerDid: item.accept.providerDid } : null, reject: item.reject ? { reason: item.reject.reason } : null, result: item.result ? { contentHash: item.result.contentHash || null } : null, paid: false },
        [item.requestId], null),
      human: `${title('bolloon task accept ' + item.requestId)}\n  已经处理过了: state=${item.state}\n\n${hint('幂等: 不重复接受, 不会产生第二条记录/第二笔付款')}`,
    };
  }

  // ① capability 已知 (本机 manifest / 本地注册表声明过)
  const caps = await localCapabilityFacts(item.capability);
  if (!caps.known) {
    return {
      envelope: failEnvelope('CAPABILITY_NOT_FOUND', `本机没有声明过能力 '${item.capability}' → 不接 (拒, 不假装能做)`,
        { requestId: item.requestId, capability: item.capability, declaredSources: caps.sources, registryServices: caps.services, howTo: `bolloon agent register --capability ${item.capability} --price 0.01` },
        [item.requestId], 'redefine_capability'),
      human: `${title('bolloon task accept ' + item.requestId)}\n  本机没有声明过能力 '${item.capability}' → 拒绝接单\n\n${hint('先声明能力: bolloon agent register --capability ' + item.capability + ' --price 0.01')}`,
    };
  }
  // ② 预算足够 (本机为该能力登记的价 ≤ 请求预算)
  if (item.budget && caps.priceAmount) {
    const priceAtomic = toAtomic(String(caps.priceAmount), String(caps.currency || 'USDC').toUpperCase() === 'ETH' ? 18 : 6);
    if (priceAtomic && BigInt(priceAtomic) > BigInt(item.budget.maxAmount)) {
      return {
        envelope: failEnvelope('BUDGET_EXCEEDED', `本机报价 ${caps.priceAmount} 超过请求预算 ${item.budget.maxAmount} (原子)`,
          { requestId: item.requestId, priceAtomic, budget: item.budget }, [item.requestId], 'raise_budget'),
        human: `${title('bolloon task accept ' + item.requestId)}\n  本机报价 ${caps.priceAmount} 超请求预算 (原子 ${item.budget.maxAmount}) → 拒\n\n${hint('对端要提预算 (改预算不换 requestId, 幂等保护仍有效)')}`,
      };
    }
  }
  // ③ policy 允许 (既有 payment-gate YAML 规则链; deny → 直接拒)
  let gateView: Record<string, unknown> | null = null;
  try {
    const { getPaymentGate } = await import('../../agents/payment-gate.js');
    const verdict = getPaymentGate().evaluate({ service: item.capability, amount: Number(caps.priceAmount || 0), recipient: caps.wallet || '' });
    gateView = { decision: verdict.decision, reason: verdict.reason };
    if (verdict.decision === 'deny') {
      return {
        envelope: failEnvelope('POLICY_DENIED', `本地策略拒绝: ${verdict.reason}`,
          { requestId: item.requestId, policy: gateView, policyFile: '~/.bolloon/../payment-policy.yaml (getPaymentGate)' }, [item.requestId], 'needs_human'),
        human: `${title('bolloon task accept ' + item.requestId)}\n  本地策略拒绝: ${verdict.reason}`,
      };
    }
  } catch (e: any) {
    // 策略读不出来 → 不假装放行 (但也不因此判死; 如实标注)
    gateView = { decision: 'unavailable', reason: String(e?.message || e).slice(0, 160) };
  }
  // ④ requestId 未重复 (收件箱里这条就是唯一一条 —— 幂等去重保证)
  const dup = listInbox().filter((i) => i.requestId === item.requestId).length;
  if (dup !== 1) {
    return {
      envelope: failEnvelope('DUPLICATE_REQUEST', `收件箱里同一 requestId 有 ${dup} 条 (幂等前提被破坏) → 拒`,
        { requestId: item.requestId, count: dup }, [item.requestId], 'needs_human'),
      human: `${title('bolloon task accept ' + item.requestId)}\n  收件箱里同一 requestId 有 ${dup} 条 → 拒`,
    };
  }

  // 交付文件先验证存在 (避免"接受了却没有正文"的半截状态)
  const deliverFile = opt(flags, '--deliver');
  let bodyText: string | null = null;
  if (deliverFile) {
    try { bodyText = fs.readFileSync(deliverFile, 'utf8'); } catch (e: any) {
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', `--deliver 文件读不出来: ${String(e?.message || e).slice(0, 160)}`, { file: deliverFile, requestId: item.requestId }, [item.requestId], 'retry_same_request'),
        human: `${title('bolloon task accept ' + item.requestId)}\n  交付文件读不出来: ${deliverFile}`,
      };
    }
  }

  const s = await requireSigner('bolloon task accept');
  if ('fail' in s) return s.fail;
  const signer = s.signer;

  const etaMs = opt(flags, '--eta') ? Number(opt(flags, '--eta')) : undefined;
  type TaskAcceptT = import('../../agents/task-contract.js').TaskAccept;
  const acceptInput: TaskAcceptT = {
    protocol: TASK_PROTOCOL, taskId: item.taskId, requestId: item.requestId, accepted: true,
    providerDid: signer.did, ...(Number.isFinite(etaMs as number) ? { etaMs: etaMs as number } : {}), signature: '',
  };
  const signedAccept = await signTaskEnvelope(acceptInput, signer.keypair);

  let result: any = null;
  let resultVerified: boolean | null = null;
  let bodyFacts: Record<string, unknown> | null = null;
  if (bodyText !== null) {
    const saved = saveBody(item.taskId, bodyText);
    if (!saved.ok) {
      return {
        envelope: failEnvelope('INTERNAL_ERROR', `交付正文落盘失败: ${saved.error}`, { requestId: item.requestId, file: deliverFile }, [item.requestId], 'retry_same_request'),
        human: `${title('bolloon task accept ' + item.requestId)}\n  交付正文落盘失败: ${saved.error}`,
      };
    }
    // ★ 内容哈希**由真实字节算出** (不是调用方随口给)
    type TaskResultT = import('../../agents/task-contract.js').TaskResult;
    const resultInput: TaskResultT = {
      protocol: TASK_PROTOCOL, taskId: item.taskId, requestId: item.requestId, ok: true,
      summary: `交付正文 ${saved.bytes} 字节 (sha256 ${String(saved.contentHash).slice(0, 12)}…)`,
      contentHash: saved.contentHash, deliveredAt: Date.now(), signature: '',
    };
    const signedResult = await signTaskEnvelope(resultInput, signer.keypair);
    // ★ 立刻用本机公钥**真验一次**自己刚签的结果 (不是硬编 true)
    const { verifyTaskEnvelope } = await import('../../agents/task-contract.js');
    const { verifierFor } = await import('../../agents/local-signer.js');
    const vf = verifierFor(signer.publicKeyHex);
    resultVerified = vf ? await verifyTaskEnvelope(signedResult as any, vf as any) : null;
    saveResult(signedResult);
    result = signedResult;
    bodyFacts = { contentHash: saved.contentHash, bytes: saved.bytes, file: saved.file, signatureSelfVerified: resultVerified };
  }

  const patched = patchInboxItem(item.requestId, {
    state: result ? 'delivered' : 'accepted',
    accept: signedAccept,
    ...(result ? { result, resultVerified } : {}),
    ...(signer.publicKeyHex ? { providerPublicKeyHex: signer.publicKeyHex } : {}),
  } as any);
  if (!patched.ok) {
    return {
      envelope: failEnvelope('INTERNAL_ERROR', `接单状态落盘失败: ${patched.error}`, { requestId: item.requestId }, [item.requestId], 'retry_same_request'),
      human: `${title('bolloon task accept ' + item.requestId)}\n  落盘失败: ${patched.error}`,
    };
  }

  // 回执: 把签名接受 (+ 结果) 发回发送方
  const replyTo = opt(flags, '--reply-to') || item.replyTo || null;
  const frames: any[] = [];
  const { buildTaskFrame } = await import('../../agents/task-transport.js');
  const signerInfo = { did: signer.did, publicKeyHex: signer.publicKeyHex };
  frames.push(buildTaskFrame('task_accept', signedAccept, signerInfo));
  if (result) {
    frames.push(buildTaskFrame('task_result', result, signerInfo, bodyText !== null ? { body: bodyText } : {}));
  }
  const reply = await sendReplyFrames(replyTo, frames, flags.timeoutMs);

  const data = {
    requestId: item.requestId,
    taskId: item.taskId,
    capability: item.capability,
    providerDid: signer.did,
    state: result ? 'delivered' : 'accepted',
    rejected: false,
    executed: false,           // 本命令**不执行**任务 (只签名接受/交付已有的正文)
    paid: false,               // 本命令**不付款**
    checks: {
      capabilityKnown: caps.known, capabilitySources: caps.sources,
      priceAmount: caps.priceAmount, budget: item.budget || null,
      policy: gateView, requestIdUnique: dup === 1,
    },
    accepted: { signed: true, providerDid: signedAccept.providerDid, etaMs: signedAccept.etaMs ?? null },
    delivered: result ? { signed: true, ...bodyFacts } : null,
    reply: { attempted: reply.attempted, ok: reply.ok, target: reply.target, error: reply.error || null, results: reply.results },
    inboxFile: `~/.bolloon/tasks/inbox/${item.requestId}.json`,
    note: '接受 = 签名声明"我来做"; 交付正文哈希由真实字节算出; 本命令不执行任务、不付款',
  };
  return {
    envelope: okEnvelope('TASK_ACCEPTED', `已接受 ${item.requestId}${result ? ' 并交付结果' : ''}${reply.ok ? ' (回执已送达)' : reply.attempted ? ' (回执没送达)' : ''}`,
      data, [item.requestId, item.taskId, ...(bodyFacts?.contentHash ? [String(bodyFacts.contentHash)] : [])], result ? null : 'wait'),
    human: [
      title('bolloon task accept ' + item.requestId),
      line('任务号', item.taskId),
      line('capability', `${item.capability} (已知: ${caps.sources.join('+') || '—'})`),
      line('报价/预算', `${caps.priceAmount ?? '(未登记价)'} ≤ ${item.budget ? item.budget.maxAmount + ' 原子' : '(无预算)'}`),
      line('策略', gateView ? `${(gateView as any).decision} — ${(gateView as any).reason}` : '(未读)'),
      line('已签名接受', '是 (TaskAccept)'),
      ...(result ? [line('已交付', `contentHash ${String(bodyFacts?.contentHash).slice(0, 16)}… (${bodyFacts?.bytes} 字节)`)] : []),
      line('回执', reply.attempted ? (reply.ok ? `已送达 ${reply.target}` : `没送达: ${reply.error}`) : `没有回执通道 (${reply.error})`),
      line('本次付款', '没有 (接单不付款)'),
      line('本次执行', '没有 (本命令只签名接受/交付已备好的正文)'),
    ].join('\n'),
  };
}

// ── reject ──────────────────────────────────────────────────────────────────

async function taskReject(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  const reason = opt(flags, '--reason');
  if (!id) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', '缺少 requestId (或 taskId)', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'), human: TASK_USAGE };
  }
  if (!reason) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --reason (契约要求: 拒绝必须给原因)', { requestId: id, accepted: ['--reason "预算不够"'] }, [], 'needs_human'),
      human: `${TASK_USAGE}\n${hint('示例: bolloon task reject ' + id + ' --reason "这个能力本机没声明"')}`,
    };
  }
  const { readInboxItem, listInbox, patchInboxItem } = await import('../../agents/task-inbox.js');
  const { TASK_PROTOCOL, signTaskEnvelope } = await import('../../agents/task-contract.js');
  const item = readInboxItem(id) || listInbox().find((i) => i.taskId === id) || null;
  if (!item) {
    return {
      envelope: failEnvelope('NOT_FOUND', `收件箱里没有这个请求: ${id}`, { id, dir: '~/.bolloon/tasks/inbox' }, [], 'needs_human'),
      human: `${title('bolloon task reject ' + id)}\n  收件箱里没有它`,
    };
  }
  if (item.state !== 'pending') {
    return {
      envelope: failEnvelope('DUPLICATE_REQUEST', `这个 requestId 已经处理过了 (state=${item.state}); 幂等: 不重复拒绝`,
        { requestId: item.requestId, state: item.state, reject: item.reject ? { reason: item.reject.reason } : null, paid: false, executed: false }, [item.requestId], null),
      human: `${title('bolloon task reject ' + item.requestId)}\n  已经处理过了: state=${item.state}`,
    };
  }
  const s = await requireSigner('bolloon task reject');
  if ('fail' in s) return s.fail;
  const signer = s.signer;

  type TaskRejectT = import('../../agents/task-contract.js').TaskReject;
  const rejectInput: TaskRejectT = {
    protocol: TASK_PROTOCOL, taskId: item.taskId, requestId: item.requestId, accepted: false,
    reason: String(reason).slice(0, 500), signature: '',
  };
  const signedReject = await signTaskEnvelope(rejectInput, signer.keypair);
  const patched = patchInboxItem(item.requestId, { state: 'rejected', reject: signedReject });
  if (!patched.ok) {
    return { envelope: failEnvelope('INTERNAL_ERROR', `拒绝原因落盘失败: ${patched.error}`, { requestId: item.requestId }, [item.requestId], 'retry_same_request'), human: `${title('bolloon task reject')}\n  落盘失败` };
  }
  const replyTo = opt(flags, '--reply-to') || item.replyTo || null;
  const { buildTaskFrame } = await import('../../agents/task-transport.js');
  const reply = await sendReplyFrames(replyTo, [buildTaskFrame('task_reject', signedReject, { did: signer.did, publicKeyHex: signer.publicKeyHex })], flags.timeoutMs);

  const data = {
    requestId: item.requestId,
    taskId: item.taskId,
    capability: item.capability,
    state: 'rejected',
    reason: String(reason),
    signed: true,
    executed: false,        // ★ 不执行
    paid: false,            // ★ 不付款
    reply: { attempted: reply.attempted, ok: reply.ok, target: reply.target, error: reply.error || null },
    inboxFile: `~/.bolloon/tasks/inbox/${item.requestId}.json`,
    note: '拒绝只记原因 + 签名 + 落盘: 不执行、不付款 (没有交易被创建)',
  };
  return {
    envelope: okEnvelope('TASK_REJECTED', `已拒绝 ${item.requestId} (原因已记录, 未执行未付款)`, data,
      [item.requestId, item.taskId], null),
    human: [
      title('bolloon task reject ' + item.requestId),
      line('原因', String(reason)),
      line('已签名', '是 (TaskReject)'),
      line('回执', reply.attempted ? (reply.ok ? `已送达 ${reply.target}` : `没送达: ${reply.error}`) : `没有回执通道 (${reply.error})`),
      line('本次执行', '没有'),
      line('本次付款', '没有'),
    ].join('\n'),
  };
}

// ── publish / board / claim (C1/C2 任务对外发布 + 接单, 2026-09-23) ──────────

/** 板上一行的对外投影 (不含正文; 远端认领数的诚实标注) */
function boardEntryView(e: any) {
  return {
    announcementId: e.announcementId,
    capability: e.capability,
    buyer: e.buyerShort,
    status: e.status,
    budget: e.budget,
    deadline: e.deadline,
    deadlineInMs: e.deadlineInMs,
    claimCount: e.claimCount,
    claimedBy: e.claimedBy,
    claimedAt: e.claimedAt,
    remote: e.remote,
    source: e.source,
    signatureVerified: e.signatureVerified,
    claimable: e.claimable,
    instructionDigest: e.instructionDigest,
    instructionPreview: e.instructionPreview,
  };
}

async function taskPublish(flags: CliFlags): Promise<CommandResult> {
  const capability = opt(flags, '--capability');
  const instruction = opt(flags, '--instruction') || flags.positionals.slice(1).join(' ').trim();
  const budgetHuman = opt(flags, '--budget');
  if (!capability || !instruction) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --capability 或 --instruction (公告必须有能力和任务正文)',
        { usage: plain(TASK_USAGE.trim()), got: { capability: capability || null, instruction: !!instruction } }, [], 'needs_human'),
      human: `${TASK_USAGE}\n${hint('示例: bolloon task publish --capability research --instruction "调研某类厨房用品的日本市场" --budget 0.05')}`,
    };
  }
  const currency = String(opt(flags, '--currency') || 'USDC').toUpperCase();
  if (currency !== 'USDC' && currency !== 'ETH') {
    return { envelope: failEnvelope('INVALID_ARGUMENT', `--currency 只支持 USDC/ETH (收到 ${currency})`, { currency }, [], 'needs_human'), human: TASK_USAGE };
  }
  const network = opt(flags, '--network') || 'base-sepolia';
  if (budgetHuman === undefined) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --budget (待接单的公告必须带预算: 没有预算就没有可核验的委托口径)',
        { usage: plain(TASK_USAGE.trim()), accepted: ['--budget 0.05'] }, [], 'needs_human'),
      human: `${TASK_USAGE}\n${hint('示例: bolloon task publish --capability research --instruction "…" --budget 0.05')}`,
    };
  }
  const atomic = toAtomic(budgetHuman, currency === 'USDC' ? 6 : 18);
  if (!atomic) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--budget 必须是正数 (收到 ${budgetHuman}); 原子单位串由本命令换算, 不接受 0/负/超精度`,
        { budget: budgetHuman, currency, accepted: ['--budget 0.05'] }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const modeRaw = opt(flags, '--mode') || 'policy';
  const { isPaymentMode } = await import('../../agents/task-contract.js');
  if (!isPaymentMode(modeRaw)) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--mode 非法: ${modeRaw} (要 manual|policy|autonomous|agent-authorized)`, { mode: modeRaw }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const dl = parseDeadline(opt(flags, '--deadline'));
  if (typeof dl === 'string') {
    return { envelope: failEnvelope('INVALID_ARGUMENT', dl, { deadline: opt(flags, '--deadline') }, [], 'needs_human'), human: TASK_USAGE };
  }

  const s = await requireSigner('bolloon task publish');
  if ('fail' in s) return s.fail;
  const signer = s.signer;

  const { publishAnnouncement } = await import('../../agents/task-board.js');
  const r = await publishAnnouncement({
    capability, instruction,
    buyerDid: signer.did,
    buyerPublicKeyHex: signer.publicKeyHex,
    budget: { maxAmount: atomic, currency, network },
    deadline: dl,
    paymentMode: modeRaw,
    replyTo: opt(flags, '--reply-to') || null,
    signerKeypair: signer.keypair,
  });
  if (!r.ok || !r.announcement) {
    return {
      envelope: failEnvelope('INTERNAL_ERROR', `公告没发布成功: ${r.error || '未知原因'}`,
        { capability, announcementId: null, paid: false, fundsMoved: false }, [], 'needs_human'),
      human: `${title('bolloon task publish')}\n  没发布成功: ${r.error || '未知原因'}`,
    };
  }
  const a = r.announcement;
  const data = {
    announcementId: a.announcementId,
    capability: a.capability,
    buyerDid: a.buyerDid,
    status: a.status,
    budget: a.budget,
    deadline: a.deadline,
    paymentMode: a.paymentMode,
    instructionDigest: a.instructionDigest,
    instructionPreview: a.instructionPreview,
    signed: r.signed,
    duplicate: r.dup,
    registry: r.registry,
    pulse: r.pulse,
    file: r.file || `~/.bolloon/tasks/board/${a.announcementId}.json`,
    registryService: 'task.announce (agent-registry; description 里只有摘要+预览, 没有正文)',
    paid: false,
    fundsMoved: false,
    note: '公告只是"把待接单的任务放出去": 不执行、不付款、不产生交易; 接单: bolloon task claim <announcementId>',
  };
  const human = [
    title('bolloon task publish'),
    line('公告号', a.announcementId),
    line('capability', a.capability),
    line('预算', a.budget ? `≤ ${a.budget.maxAmount} 原子 (${a.budget.currency} @ ${a.budget.network})` : '(无)'),
    line('截止时间', new Date(a.deadline).toISOString()),
    line('签名', r.signed ? '已签名 (覆盖公开载荷: 能力/预算/截止/正文摘要)' : '**没有签名** (没有本机身份 → 接单会被拒)'),
    line('注册表', r.registry.attempted ? (r.registry.announced ? `已公告 (${r.registry.entries} 条 capability)` : `没公告: ${r.registry.error || '未知'}`) : '没有尝试 (离线)'),
    line('脉冲事件', r.pulse.attempted ? (r.pulse.ok ? 'task_announced 已记' : `没记: ${r.pulse.reason || '未知'}`) : '没有尝试 (离线)'),
    r.dup ? line('重复发布', '同一 (能力+正文+买方+预算) → 复用既有公告 (幂等), 没覆盖既有认领') : '',
    line('本次付款', '没有 (发布公告不付款)'),
    `\n  ${hint('下一步: 别人看板 bolloon task board · 接单 bolloon task claim ' + a.announcementId)}`,
  ].filter(Boolean).join('\n');
  return {
    envelope: okEnvelope('OK', `已发布待接单任务 ${a.announcementId} (${a.capability})${r.dup ? ' — 复用既有公告 (幂等)' : ''}`,
      data, [a.announcementId], null),
    human,
  };
}

async function taskBoard(flags: CliFlags): Promise<CommandResult> {
  const { listBoard } = await import('../../agents/task-board.js');
  const capFilter = opt(flags, '--capability');
  const openOnly = has(flags, '--open');
  const localOnly = has(flags, '--local');
  const view = await listBoard({ openOnly, localOnly });
  const capLower = String(capFilter || '').trim().toLowerCase();
  const entries = capLower ? view.entries.filter((e) => String(e.capability).trim().toLowerCase() === capLower) : view.entries;
  const data = {
    count: entries.length,
    local: view.localCount,
    remote: view.remoteCount,
    duplicatesDeduped: view.duplicates,
    filter: { capability: capFilter || null, openOnly, localOnly },
    registryReady: view.registryReady,
    registryError: view.registryError,
    dir: '~/.bolloon/tasks/board',
    entries: entries.map(boardEntryView),
    notes: view.notes,
    note: '板上只有摘要/预览: 任务正文只在买方本地; 接单: bolloon task claim <announcementId>',
    next: entries.some((e) => e.claimable) ? `bolloon task claim ${entries.find((e) => e.claimable)!.announcementId}` : null,
  };
  const human = entries.length
    ? entries.map((e) => [
      `\n  ${e.announcementId}${e.remote ? ' (远端公告)' : ''}`,
      `    capability ${e.capability}`,
      `    买方       ${e.buyerShort || '(无)'}`,
      `    状态       ${e.status}${e.claimable ? ' · 可接单' : e.status === 'open' ? ' · 已过期' : ''}`,
      `    预算       ${e.budget ? `≤ ${e.budget.maxAmount} 原子 ${e.budget.currency} @ ${e.budget.network}` : '(无)'}`,
      `    截止时间   ${e.deadline ? `${new Date(e.deadline).toISOString()}${e.deadlineInMs !== null ? ` (${e.deadlineInMs > 0 ? `还剩 ${Math.round(e.deadlineInMs / 1000)}s` : '已过期'})` : ''}` : '(无)'}`,
      `    认领       ${e.claimCount === 0 ? '还没有人接' : `${e.claimCount} 人 (最近: ${String(e.claimedBy).slice(0, 24)})`}${e.remote ? ' · 远端的认领数本机看不到' : ''}`,
      `    签名       ${e.signatureVerified === true ? '验签通过' : e.signatureVerified === false ? '**验签不过** (接不了单)' : '未验签(如实)'}`,
      `    预览       ${e.instructionPreview || '(无)'}`,
    ].join('\n')).join('')
    : '\n  (板上没有可接单的任务)';
  return {
    envelope: okEnvelope('OK', `板上 ${entries.length} 条${openOnly ? '可接单' : ''}公告 (本地 ${view.localCount} · 远端 ${view.remoteCount})${capFilter ? ` [capability=${capFilter}]` : ''}`,
      data, entries.map((e) => e.announcementId), null),
    human: [
      `${title('bolloon task board')}${human}`,
      '',
      `  ${String(data.note)}`,
      view.registryError ? `  ${hint(`注册表读取失败 (远端公告可能不全): ${view.registryError}`)}` : '',
      data.next ? `\n  ${hint('下一步: ' + data.next)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

async function taskClaim(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || opt(flags, '--announcement-id') || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 announcementId (bolloon task claim <announcementId>)',
        { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: `${TASK_USAGE}\n${hint('先看板: bolloon task board')}`,
    };
  }
  const s = await requireSigner('bolloon task claim');
  if ('fail' in s) return s.fail;
  const signer = s.signer;

  // ★ C7: 带 --group 时**在认领之前**把群定死 —— 群非法/没加入 → 整条命令拒绝 (绝不"认领落本地 + 悄悄不发群")
  const wantsGroup = opt(flags, '--group') !== undefined;
  const gctx = wantsGroup ? await requireGroup('bolloon task claim ' + id, flags) : null;
  if (gctx && !gctx.ok) return gctx.result;

  // 声明价格 (可选): 不声明 → null, 不替它猜
  const priceHuman = opt(flags, '--price');
  const currency = String(opt(flags, '--currency') || 'USDC').toUpperCase();
  let priceAtomic: string | null = null;
  if (priceHuman !== undefined) {
    priceAtomic = toAtomic(priceHuman, currency === 'USDC' ? 6 : 18);
    if (!priceAtomic) {
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', `--price 必须是正数 (收到 ${priceHuman})`,
          { price: priceHuman, currency, accepted: ['--price 0.02'] }, [], 'needs_human'),
        human: TASK_USAGE,
      };
    }
  }

  const { claimAnnouncement } = await import('../../agents/task-board.js');
  const r = await claimAnnouncement(id, {
    providerDid: signer.did,
    providerPublicKeyHex: signer.publicKeyHex,
    priceAmountAtomic: priceAtomic,
    currency,
    network: opt(flags, '--network') || '',
    signerKeypair: signer.keypair,
  });

  const baseData = {
    announcementId: id,
    reason: r.reason,
    remote: r.remote,
    // ★ 本命令任何路径都不动钱、不执行、不标 verified
    executed: false,
    paid: r.paid,
    fundsMoved: r.fundsMoved,
    verified: r.verified,
    deliveredToBuyer: r.deliveredToBuyer,
  };

  if (!r.ok) {
    const code: Code = r.reason === 'not_found' ? 'NOT_FOUND'
      : r.reason === 'already_claimed' ? 'DUPLICATE_REQUEST'
        : r.reason === 'cancelled' ? 'TASK_CANCELLED'
          : r.reason === 'signature_invalid' || r.reason === 'instruction_digest_mismatch' ? 'SIGNATURE_INVALID'
            : r.reason === 'deadline_expired' ? 'DEADLINE_EXPIRED'
              : 'INVALID_ARGUMENT';
    return {
      envelope: failEnvelope(code, `没接成单: ${r.message}`,
        { ...baseData, status: r.status ?? null, existingClaim: r.existingClaim ?? null }, [id], 'needs_human'),
      human: `${title('bolloon task claim ' + id)}\n  ${r.message}\n${line('本次付款', '没有')}\n\n${hint('看板: bolloon task board')}`,
    };
  }

  const c = r.claim!;
  // ★ C7: 认领成功 → 往群里发一条极短接单声明 (群已在认领**之前**定死; 这里最坏也只是"发失败")
  let groupPost: Record<string, unknown> | null = null;
  if (gctx && gctx.ok) {
    const TG: any = await import('../../agents/task-group.js');
    const priceTok = c.priceAmountAtomic ? `${c.priceAmountAtomic}${String(c.currency || '').toUpperCase()}` : null;
    const built = TG.buildPostMessage({ kind: 'claim', announcementId: id, price: priceTok });
    const sent = built.ok
      ? await TG.sendTrailMessage(gctx.group.groupId, built.text, gctx.fromTag)
      : { ok: false, sent: false, error: built.message, violations: null };
    groupPost = {
      requested: true,
      posted: sent.sent === true,
      error: sent.sent ? null : (sent.error || '未知原因'),
      message: built.ok ? built.text : null,
      group: gctx.group.groupId,
      senderTag: gctx.fromTag,
      localFallback: false,
      /** 群消息没发出去**不等于**认领没发生: 认领事实已写进本地账 (上面那步真写过了) */
      claimStillRecorded: true,
    };
  } else if (!wantsGroup) {
    groupPost = { requested: false, posted: false, reason: '没有 --group: 本命令原有语义不变 (只记本地认领账); 群里留痕要显式给 --group' };
  }
  const data = {
    ...baseData,
    claim: {
      providerDid: c.providerDid,
      providerPublicKeyHex: c.providerPublicKeyHex ? `${String(c.providerPublicKeyHex).slice(0, 16)}…` : null,
      claimedAt: c.claimedAt,
      priceAmountAtomic: c.priceAmountAtomic,
      currency: c.currency,
      network: c.network,
      signed: !!c.signature,
    },
    status: r.status ?? null,
    file: r.file,
    priceNote: r.priceNote ?? null,
    /** C7 群聊侧: 认领有没有在群里留下接单声明 (发失败也如实标; 认领事实不受影响) */
    group: groupPost,
    honestyNote: r.remote
      ? '远端公告的认领只落本机台账 (**没有投递给买方**); 真交接走 bolloon task send → 对方 task accept'
      : '认领只是"我来做"的本地事实: 不执行任务、不付款、不标 verified (释放/验真另走裁决函数)',
  };
  const groupNext: NextAction = groupPost && groupPost.requested === true && groupPost.posted !== true ? 'needs_human' : null;
  return {
    envelope: okEnvelope('OK', `${r.message}${groupPost && groupPost.requested === true ? (groupPost.posted === true ? ' (接单声明已进群)' : ' (接单声明没发进群)') : ''}`,
      data, [id], groupNext ?? (r.remote ? 'needs_human' : null)),
    human: [
      title('bolloon task claim ' + id),
      line('认领者', c.providerDid),
      line('认领时间', new Date(c.claimedAt).toISOString()),
      line('声明价格', c.priceAmountAtomic ? `${c.priceAmountAtomic} 原子 ${c.currency}` : '(没声明价)'),
      line('公告来源', r.remote ? '注册表 (远端)' : '本地公告文件'),
      line('投递给买方', r.deliveredToBuyer ? '已投递' : '**没有** (本版没有远端认领投递通道; 真交接走 task send/accept)'),
      ...(groupPost ? [line('群聊留痕', groupPost.requested === true
        ? (groupPost.posted === true ? `接单声明已进群 (发送者标记 ${String(groupPost.senderTag)})` : `**没发进群**: ${String(groupPost.error)} — 认领事实已记账, 但群里没有这条痕迹`)
        : `没有 --group: 只记本地账 (${String(groupPost.reason)})`)] : []),
      line('本次执行', '没有 (接单不执行任务)'),
      line('本次付款', '没有 (接单不付款)'),
      r.remote ? `\n  ${hint('下一步: 让买方把任务发过来 (bolloon task send); 对方 accept 后才有执行/交付')}` : `\n  ${hint('下一步: 等买方的 task send/accept; 交付后用 decideAnnouncementRelease 判是否可释放 (未交付不得释放)')}`,
    ].join('\n'),
  };
}

// ── 群聊通道 (C7: announce / trail / post, 2026-09-23) ───────────────────────

/** C7 群上下文: 群必须先定下来 (缺/非法/没加入 → 拒跑); 发送者标记只用短假名 */
async function requireGroup(head: string, flags: CliFlags): Promise<
  { ok: true; group: any; fromTag: string; fromSource: 'flag' | 'identity' } | { ok: false; result: CommandResult }
> {
  const TG: any = await import('../../agents/task-group.js');
  const ref = opt(flags, '--group');
  const g = await TG.resolveGroupRef(ref);
  if (!g.ok) {
    return {
      ok: false,
      result: {
        envelope: failEnvelope(g.code, `${g.message}`,
          { group: ref ?? null, ...g.detail, sent: false, localFallback: false, why: '缺群/群非法/群没加入一律拒绝执行: 本命令不做"只写本地"的降级' },
          [], 'needs_human'),
        human: [
          title(head),
          `  群没定下来: ${g.message}`,
          '',
          hint('群聊通道就是留痕的地方: 没有群就没有留痕 —— 这里不会静默降级成只写本地'),
          ...(Array.isArray((g.detail as any).joined) && (g.detail as any).joined.length
            ? [line('本机已加入的群', (g.detail as any).joined.map((x: any) => `${x.id}${x.name ? ` (${x.name})` : ''}`).join(' · '))]
            : [line('本机已加入的群', '(没有)')]),
        ].join('\n'),
      },
    };
  }
  const s = await TG.resolveSenderTag(opt(flags, '--from'));
  if (!s.ok) {
    return {
      ok: false,
      result: {
        envelope: failEnvelope(s.code, `${s.message}`, { ...s.detail, group: g.group, sent: false, localFallback: false }, [], 'needs_human'),
        human: `${title(head)}\n  发送者标记定不下来: ${s.message}\n\n${hint('群里只出现短假名 (agent-xxxxxxxx) 或 --from 给的短显示名; 原始 DID 永不进群')}`,
      },
    };
  }
  return { ok: true, group: g.group, fromTag: s.tag, fromSource: s.source };
}

/** 时间线条目 → 对外投影 (不含原消息文本; 字段已被遮蔽过) */
function trailEntryView(e: any) {
  return { kind: e.kind, at: e.at, atIso: e.at ? new Date(e.at).toISOString() : null, sender: e.sender, announcementId: e.announcementId, fields: e.fields };
}

/**
 * `bolloon task announce --group <群链接|groupId>` —— 把板上一条待接单公告压成一行极短事实发进群。
 * 内容只有: 期号 · capability · 预算 · 验收判据摘要 · 公告 id (任务正文不进群)。
 */
async function taskAnnounce(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task announce';
  const ctx = await requireGroup(head, flags);
  if (!ctx.ok) return ctx.result;
  const TG: any = await import('../../agents/task-group.js');

  const picked = TG.pickAnnouncement({ announcementId: opt(flags, '--announcement-id'), capability: opt(flags, '--capability') });
  if (!picked.ok) {
    return {
      envelope: failEnvelope(picked.code, picked.message, { ...picked.detail, group: ctx.group, sent: false, localFallback: false }, [], 'needs_human'),
      human: `${title(head)}\n  没得可发: ${picked.message}\n\n${hint('先看板: bolloon task board; 发公告: bolloon task publish --capability … --instruction "…" --budget 0.05')}`,
    };
  }
  const a = picked.announcement;
  const text = TG.buildAnnounceMessage(a, { round: opt(flags, '--round'), criteria: opt(flags, '--criteria') });
  const sent = await TG.sendTrailMessage(ctx.group.groupId, text, ctx.fromTag);
  if (!sent.ok) {
    const violations = sent.violations || null;
    return {
      envelope: failEnvelope(violations ? 'POLICY_DENIED' : 'TRANSPORT_FAILED',
        violations ? `公告命中隐私红线, 拒绝发进群: ${violations.map((v: any) => v.rule).join(', ')}` : `群消息没发出去: ${sent.error}`,
        { announcementId: a.announcementId, group: ctx.group.groupId, message: text, sent: false, violations, localFallback: false, paid: false },
        [a.announcementId], 'needs_human'),
      human: [
        title(head),
        `  ${violations ? '命中隐私红线, 拒发' : '没发出去'}: ${sent.error}`,
        ...(violations ? violations.map((v: any) => `    · ${v.rule} — ${v.why} (${v.masked}, ${v.chars} 字符)`) : []),
        '',
        hint(violations ? '把公告的预览/判据摘要改成不含标识符的短事实后重发 (本命令不静默脱敏: 脱敏后的公告不是你要发的那条)' : '群 store 不可达时不会落本地: 就是没发出去'),
      ].join('\n'),
    };
  }
  const data = {
    announcementId: a.announcementId,
    capability: a.capability,
    budget: a.budget,
    deadline: a.deadline,
    round: opt(flags, '--round') || null,
    judgeStated: !!opt(flags, '--criteria'),
    message: sent.text,
    group: { id: ctx.group.groupId, name: ctx.group.name, via: ctx.group.via },
    sender: { tag: ctx.fromTag, source: ctx.fromSource, didPrinted: false },
    /** 群里只有过程事实: 不执行、不付款、不标 verified */
    executed: false,
    paid: false,
    fundsMoved: false,
    localFallback: false,
    note: '公告入群只发极短事实 (期号/capability/预算/判据摘要/公告 id): 任务正文不进群; 群里的话不替代链上 releaseV2',
  };
  return {
    envelope: okEnvelope('OK', `已把公告 ${a.announcementId} 发进群 (${a.capability})`, data, [a.announcementId], null),
    human: [
      title(head),
      line('公告号', a.announcementId),
      line('capability', a.capability),
      line('预算', a.budget ? `≤ ${a.budget.maxAmount} 原子 (${a.budget.currency} @ ${a.budget.network})` : '(无)'),
      line('期号', opt(flags, '--round') || '(未标)'),
      line('判据摘要', opt(flags, '--criteria') || `未声明 (只放任务书摘要 sha256:${String(a.instructionDigest || '').slice(0, 16)}…)`),
      line('群', `${ctx.group.name || '(无名)'} · ${ctx.group.groupId}`),
      line('发送者标记', `${ctx.fromTag} (${ctx.fromSource === 'identity' ? '本机身份派生假名' : '--from 显式'}; 原始 DID 未进群)`),
      line('本次执行/付款', '没有 (公告入群只是过程留痕)'),
      '',
      hint(`下一步: 别人 bolloon task claim ${a.announcementId} --group <群链接>; 回看留痕: bolloon task trail --group <群链接>`),
    ].join('\n'),
  };
}

/** `bolloon task trail --group <群链接|groupId>` —— 从群消息读回本期过程痕迹并汇总成时间线 */
async function taskTrail(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task trail';
  const ctx = await requireGroup(head, flags);
  if (!ctx.ok) return ctx.result;
  const TG: any = await import('../../agents/task-group.js');

  const limitRaw = opt(flags, '--limit');
  const limit = limitRaw === undefined ? 300 : Number(limitRaw);
  if (limitRaw !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--limit 必须是正数 (收到 ${limitRaw})`, { limit: limitRaw }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  let summary: any;
  try {
    summary = await TG.readTrail(ctx.group.groupId, { limit, announcementId: opt(flags, '--announcement-id') });
  } catch (e: any) {
    return {
      envelope: failEnvelope('TRANSPORT_FAILED', `群消息读不出来: ${String(e?.message || e).slice(0, 160)}`,
        { group: ctx.group.groupId, read: false, localFallback: false }, [], 'needs_human'),
      human: `${title(head)}\n  群消息读不出来: ${String(e?.message || e).slice(0, 160)}\n\n${hint('群不可达时如实报错: 不用本地缓存假装读过群')}`,
    };
  }
  const data = {
    group: { id: ctx.group.groupId, name: ctx.group.name, via: ctx.group.via },
    count: summary.count,
    byKind: summary.byKind,
    announcements: summary.announcements,
    flags: summary.flags,
    inconsistencies: summary.inconsistencies,
    redacted: summary.redacted,
    ignoredMessages: summary.ignoredMessages,
    timeline: summary.entries.map(trailEntryView),
    limit,
    announcementFilter: opt(flags, '--announcement-id') || null,
    readOnly: true,
    localFallback: false,
    note: '时间线只汇总群里真发过的事实 (公告/接单/交付/初筛/终审); 没发过的环节不会凭空出现; 发送者只显示短标记 (原始 DID 不在输出里)',
  };
  const label = (k: string) => `${TG.TRAIL_KIND_LABEL[k]}=${(summary.byKind as any)[k]}`;
  const human = [
    title(`${head} (${ctx.group.name || ctx.group.groupId})`),
    line('条目', `${summary.count} 条 (${TG.TRAIL_KINDS.map(label).join(' · ')})`),
    ...(summary.announcements.length ? [line('涉及公告', summary.announcements.join(' · '))] : []),
    ...(summary.inconsistencies.length ? [line('事实矛盾/遮蔽', summary.inconsistencies.join(' · '))] : []),
    ...(summary.redacted.length ? [line('被遮蔽的字段', summary.redacted.join(' · ') + ' (别人发的消息里含标识符形态, 读回时已遮蔽)')] : []),
    '',
    ...(summary.entries.length
      ? summary.entries.map((e: any) => `  ${TG.formatTrailLine(e)}`)
      : ['  (群里还没有本期的过程痕迹: 先用 bolloon task announce --group … 发公告)']),
    '',
    `  ${String(data.note)}`,
  ].join('\n');
  return {
    envelope: okEnvelope('OK',
      summary.count
        ? `群里本期 ${summary.count} 条过程痕迹 (${summary.announcements.length} 个公告)`
        : '群里本期没有过程痕迹 (群里真没有, 不是读失败)',
      data, summary.announcements, null),
    human,
  };
}

/** `bolloon task post --kind deliver|screen|final --group <…> --announcement-id <id>` —— 交付/初筛/终审的群消息 */
async function taskPost(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task post';
  const kind = String(opt(flags, '--kind') || '').trim().toLowerCase();
  if (!['deliver', 'screen', 'final'].includes(kind)) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--kind 必须是 deliver|screen|final (收到 ${kind || '(空)'})`,
        {
          accepted: ['--kind deliver --hash sha256:<hex>', '--kind screen --checks "渠道结构=pass,价格带=fail"', '--kind final --verdict accept'],
          claimKindNote: kind === 'claim'
            ? '接单痕迹不用 task post 发: 用 `bolloon task claim <announcementId> --group <群>` —— 这样"接单痕迹"必定对应一笔真认领账, 不会出现没有认领者却挂在群里的接单声明 (反过来也不会有认领了却没有任何群痕迹的静默)'
            : null,
          why: '群里只认这四种过程事实: 公告 / 交付 / 初筛 / 终审 (接单走 task claim)',
        }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const ctx = await requireGroup(head, flags);
  if (!ctx.ok) return ctx.result;
  const TG: any = await import('../../agents/task-group.js');

  const bytesRaw = opt(flags, '--bytes');
  const built = TG.buildPostMessage({
    kind,
    announcementId: opt(flags, '--announcement-id'),
    round: opt(flags, '--round'),
    price: opt(flags, '--price'),
    hash: opt(flags, '--hash'),
    bytes: bytesRaw === undefined ? null : Number(bytesRaw),
    checksRaw: opt(flags, '--checks'),
    verdict: opt(flags, '--verdict'),
  });
  if (!built.ok) {
    return {
      envelope: failEnvelope(built.code, built.message, { ...built.detail, kind, group: ctx.group, sent: false, localFallback: false }, [], 'needs_human'),
      human: `${title(head)}\n  ${built.message}\n\n${TASK_USAGE.split('选项:')[0].trim().split('\n').slice(-6).join('\n')}`,
    };
  }
  const sent = await TG.sendTrailMessage(ctx.group.groupId, built.text, ctx.fromTag);
  if (!sent.ok) {
    const violations = sent.violations || null;
    return {
      envelope: failEnvelope(violations ? 'POLICY_DENIED' : 'TRANSPORT_FAILED',
        violations ? `过程痕迹命中隐私红线, 拒绝发进群: ${violations.map((v: any) => v.rule).join(', ')}` : `群消息没发出去: ${sent.error}`,
        { kind, group: ctx.group.groupId, message: built.text, sent: false, violations, localFallback: false }, [], 'needs_human'),
      human: [
        title(head),
        `  ${violations ? '命中隐私红线, 拒发' : '没发出去'}: ${sent.error}`,
        ...(violations ? violations.map((v: any) => `    · ${v.rule} — ${v.why} (${v.masked}, ${v.chars} 字符)`) : []),
        '',
        hint('群里不放钱包地址/DID/peerId/multiaddr/IP/私钥形态; 换个不含标识符的短事实重发'),
      ].join('\n'),
    };
  }
  const onBoard = !!TG.readBoardAnnouncement(String(opt(flags, '--announcement-id') || ''));
  const data = {
    kind,
    announcementId: opt(flags, '--announcement-id'),
    message: sent.text,
    checks: built.checks ? built.checks : null,
    group: { id: ctx.group.groupId, name: ctx.group.name, via: ctx.group.via },
    sender: { tag: ctx.fromTag, source: ctx.fromSource, didPrinted: false },
    announcementOnLocalBoard: onBoard,
    /** 群里只是留痕: 不执行、不付款、也不标 verified (终审结论不替代链上 release) */
    executed: false,
    paid: false,
    fundsMoved: false,
    verified: false,
    localFallback: false,
    note: kind === 'deliver'
      ? '交付痕迹只贴内容哈希 (群里没有正文); 真交接仍走 bolloon task send → 对方 task accept'
      : kind === 'screen'
        ? '初筛通过 ≠ 已验收: 终审结论另发 (--kind final); 线上一分钱都没动'
        : '终审结论只是过程事实: 结算仍只在链上 (群里的话不替代 releaseV2; 争议期不自动重付/不标 verified)',
  };
  return {
    envelope: okEnvelope('OK', `已把${TG.TRAIL_KIND_LABEL[kind]}发进群 (${opt(flags, '--announcement-id')})`, data,
      [String(opt(flags, '--announcement-id'))], null),
    human: [
      title(`${head} --kind ${kind}`),
      line('公告号', String(opt(flags, '--announcement-id'))),
      line('群消息', sent.text),
      ...(built.checks ? [line('初筛逐条', built.checks.map((c: any) => `${c.name}=${c.result}`).join(' · '))] : []),
      line('群', `${ctx.group.name || '(无名)'} · ${ctx.group.groupId}`),
      line('发送者标记', `${ctx.fromTag} (原始 DID 未进群)`),
      line('本地板上有这条公告吗', onBoard ? '有' : '没有 (本机不是买方; 只发痕迹不假装认识这条公告)'),
      line('本次执行/付款/验真', '都没有 (群消息只是过程留痕)'),
      '',
      `  ${data.note}`,
    ].join('\n'),
  };
}

// ── 群管理 (group create|join|list|link|leave, 2026-09-24) ────────────────────
//
// 为什么补这一段 (真缺口): `createGroup` / `joinGroup` / `listGroups` 一直只存在于
// `src/agents/gateway-group.ts`, **CLI 里没有任何入口** —— 外部接单者拿到群链接后
// 无法自助入群, 只能等对方把话转达。这里把它们接出来 (薄包装, 不重实现密钥学/存储),
// 并补 `link` (取回邀请链接) 与 `leave` (退群)。
//
// 脱敏口径 (与群消息同一张表, 只去掉 orbitdb 那一档 —— 见 `TG.NODE_IDENTITY_RULES`):
//   · 原始 DID · 钱包地址 · peerId · 节点 multiaddr (`/ip4` `/p2p` …) · IPv4/IPv6 · URL · 邮箱
//     —— 一律不出现在群管理输出里;
//   · 群 store 地址 (`/orbitdb/zdpu…`) 是**群自己的公开标识**, 邀请链接必须能打印
//     → `list` 只出短事实 (groupId/群名/时间), 要链接就显式 `bolloon task group link <groupId>`。
//   · `create` 的 `--name` 与 `list` 的**输出**都再过一遍 `scanNodeIdentity`: 命中 → 拒 (不静默脱敏)。

const GROUP_ACTIONS = ['create', 'join', 'list', 'link', 'leave'] as const;

const GROUP_USAGE = `
${title('bolloon task group')}
  bolloon task group create --name <群名> [--from <短显示名>] [--json]
      建一个可被邀请的群 (OrbitDB events store, ACL write:['*'] = 成员可广播);
      打印**邀请链接** (把它发给要入群的人) 与 groupId; 落 ~/.bolloon/gateway-groups.json (重启不忘)
  bolloon task group join <群链接|groupId> [--json]
      用链接自助入群 (幂等: 已在群里 → already=true, 仍然 exit 0);
      拿不到区块时**大声失败** (TRANSPORT_FAILED + storeCode=STORE_UNREACHABLE), 绝不把"读不到"说成"群里没东西"
  bolloon task group list [--json]
      本机已加入的群 (groupId · 群名 · 加入时间); 没有群 → 空列表 (不是错误)
  bolloon task group link <groupId|群名> [--json]
      显式取回邀请链接 (list 里不放链接: 群 store 地址只在你要分享时打印)
  bolloon task group leave <groupId|群名> [--json]
      退群 (只摘本机记录; 群 store 是公共 append-only, 别人那边不会因为你退出而改)

选项: --json · --quiet; --name/--from 见上
说明: 群管理输出不含原始 DID / 钱包地址 / peerId / multiaddr / IP (脱敏口径与群消息同源);
      跨机**互相看见消息**仍需区块/日志复制 (bitswap + block broker, 不在本命令范围);
      本机跨进程重开同一群链接读回既有消息已支持。
`;

/**
 * 群管理输出过一遍节点身份闸 (命中 → 拒输出并如实报, 不静默脱敏后再当成没事)。
 *
 * `allow` = 本命令**故意打印**的群自身标识 (store 地址 / 邀请链接): 扫之前按**精确串**摘掉。
 * 为什么要摘 (2026-09-24 想清楚的一个真坑): 群 store 地址是 base58 的 CID (`zdpu…`), 而 base58
 * 字母表里**同时有 `Q` 和 `m`** —— 几十位里偶然出现 `Qm`, 后面又跟够 30 个 base58 字符时,
 * 就会撞上 `Qm…` 这个 peerId 形状 → 建群**随机**被判成"输出泄漏了 peerId"。
 * 摘掉的是"我们自己刚给出的那一个串", **规则一个字没放宽**: 别处再出现任何
 * DID / 钱包 / peerId / 节点 multiaddr / IP 形状, 照样命中。
 */
async function guardGroupOutput(payload: unknown, allow: string[] = []): Promise<
  { ok: true; exempted: number } | { ok: false; hits: any[] }
> {
  const TG: any = await import('../../agents/task-group.js');
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const tokens = allow.filter((t) => typeof t === 'string' && t.length > 0);
  for (const t of tokens) text = text.split(t).join('');
  const hits = TG.scanNodeIdentity(text);
  return hits.length ? { ok: false, hits } : { ok: true, exempted: tokens.length };
}

/** 群管理输出命中节点身份闸时的统一失败 (如实列出命中规则, 不回显被命中的原文) */
function groupGuardFail(head: string, hits: any[], extra: Record<string, unknown> = {}): CommandResult {
  return {
    envelope: failEnvelope('POLICY_DENIED',
      `本机群列表里含节点身份形态, 拒绝输出 (${hits.map((h: any) => h.rule).join(', ')}) —— 已遮住原文, 不把标识符打出来`,
      { violations: hits, ...extra },
      [], 'needs_human'),
    human: [
      title(head),
      `  拒绝输出: 本机群记录里含 ${hits.map((h: any) => h.rule).join(', ')}`,
      ...hits.map((h: any) => `    · ${h.rule} — ${h.why} (${h.masked}, ${h.chars} 字符)`),
      '',
      hint('群名/记录里被写进了标识符 → 改成不含标识符的名字 (本命令不静默脱敏: 脱敏后的群名不是你要看的那个)'),
    ].join('\n'),
  };
}

/** 群上下文解析: groupId 或群名 → 本机已加入的群 (都没有 → NOT_FOUND, 不猜) */
async function resolveLocalGroup(raw: string): Promise<{ ok: true; group: any } | { ok: false; result: CommandResult }> {
  const GG: any = await import('../../agents/gateway-group.js');
  const groups: any[] = await GG.listGroups();
  const s = String(raw || '').trim();
  const hit = groups.find((g) => g.id === s) || groups.find((g) => g.name === s) || null;
  if (hit) return { ok: true, group: hit };
  return {
    ok: false,
    result: {
      envelope: failEnvelope('NOT_FOUND',
        `本机没有这个群: ${s ? `${s.slice(0, 24)}${s.length > 24 ? '…' : ''}` : '(空)'} (既不是已加入群的 groupId, 也不是群名)`,
        {
          joinedCount: groups.length,
          howTo: '入群: bolloon task group join <群链接>; 看已加入的群: bolloon task group list',
        }, [], 'needs_human'),
      human: '',
    },
  };
}

async function taskGroup(flags: CliFlags): Promise<CommandResult> {
  const action = String(flags.positionals[1] ?? '').trim();
  // 用查表而不是 switch: `case 'create':` 这种字面量不属于 task 的**顶层**子命令,
  // 免得将来有人把这段挪到 taskCommand 前面时被源级一致性门 (task-subcommands.test.ts) 误认。
  const table: Record<string, (f: CliFlags) => Promise<CommandResult>> = {
    create: taskGroupCreate,
    join: taskGroupJoin,
    list: taskGroupList,
    link: taskGroupLink,
    leave: taskGroupLeave,
  };
  const fn = table[action];
  if (fn) return fn(flags);
  return {
    envelope: failEnvelope('INVALID_ARGUMENT',
      action ? `未知 group 动作: ${action}` : '缺少 group 动作 (create | join | list | link | leave)',
      { usage: plain(GROUP_USAGE.trim()), accepted: [...GROUP_ACTIONS] }, [], 'needs_human'),
    human: GROUP_USAGE,
  };
}

/** `task group create --name <群名>` —— 建群 + 打印邀请链接 */
async function taskGroupCreate(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task group create';
  const TG: any = await import('../../agents/task-group.js');
  const GG: any = await import('../../agents/gateway-group.js');
  const name = String(opt(flags, '--name') ?? '').trim();
  if (!name) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --name (群名)', { accepted: ['--name 测试群'], usage: plain(GROUP_USAGE.trim()) }, [], 'needs_human'),
      human: GROUP_USAGE,
    };
  }
  // 群名会进群消息与 list 输出 → 先过节点身份闸 (标识符形状的名字一律拒, 不静默改名)
  const nameHits = TG.scanNodeIdentity(name);
  if (nameHits.length) {
    return {
      envelope: failEnvelope('POLICY_DENIED', `群名含节点身份形态, 拒绝建群 (${nameHits.map((h: any) => h.rule).join(', ')})`,
        { violations: nameHits, accepted: ['--name 测试群'] }, [], 'needs_human'),
      human: `${title(head)}\n  群名不能含 ${nameHits.map((h: any) => h.rule).join(', ')}\n\n${hint('群名是公开事实 (会进群消息与 list): 换个不含标识符的名字')}`,
    };
  }
  const s = await TG.resolveSenderTag(opt(flags, '--from'));
  if (!s.ok) {
    return {
      envelope: failEnvelope(s.code, s.message, { ...s.detail, group: { name }, created: false }, [], 'needs_human'),
      human: `${title(head)}\n  群主标记定不下来: ${s.message}\n\n${hint('建群会写一条欢迎消息 (要一个诚实的发送者标记): 先 bolloon identity init 或 --from <短显示名>')}`,
    };
  }
  const r = await GG.createGroup(name, { from: s.tag });
  if (!r.ok || !r.group) {
    return {
      envelope: failEnvelope('TRANSPORT_FAILED', `建群失败: ${r.error ?? '未知原因'}`,
        { group: { name }, created: false, storeReachable: false }, [], 'needs_human'),
      human: `${title(head)}\n  建群失败: ${r.error ?? '未知原因'}\n\n${hint('建群要写 OrbitDB store: 落盘目录不可写 / store 打不开都会在这里如实失败')}`,
    };
  }
  const data: Record<string, unknown> = {
    group: { id: r.group.id, name: r.group.name, link: r.group.link, createdAt: r.group.createdAt },
    sender: { tag: s.tag, source: s.source, didPrinted: false },
    file: '~/.bolloon/gateway-groups.json',
    acl: { write: ['*'], note: '成员可广播: 入群的人都能往群里发消息 (建群时写进 store manifest)' },
    created: true,
    executed: false,
    paid: false,
    localFallback: false,
  };
  const guard = await guardGroupOutput(data, [r.group.id, r.group.link]);
  if (!guard.ok) return groupGuardFail(head, guard.hits, { group: { name }, created: true });
  data.nodeIdentityGuard = { scanned: true, exemptedGroupTokens: guard.exempted };
  return {
    envelope: okEnvelope('OK', `已建群「${r.group.name}」(${r.group.id.slice(0, 12)}…)`, data, [r.group.id], null),
    human: [
      title(head),
      line('群名', r.group.name),
      line('groupId', r.group.id),
      line('邀请链接', r.group.link),
      line('群主标记', `${s.tag} (${s.source === 'identity' ? '本机身份派生假名' : '--from 显式'}; 原始 DID 未进群)`),
      line('本机记录', '~/.bolloon/gateway-groups.json (重启后仍记得这个群)'),
      '',
      hint(`把链接发给要入群的人: bolloon task group join "<链接>"`),
      hint(`回看过程痕迹: bolloon task trail --group <链接>  ·  取回链接: bolloon task group link ${r.group.id.slice(0, 12)}…`),
      '',
      '  跨机**互相看见消息**仍需区块/日志复制 (bitswap + block broker, 不在本命令范围);',
      '  本机跨进程用同一链接重开读回既有消息已支持。',
    ].join('\n'),
  };
}

/** `task group join <群链接|groupId>` —— 自助入群 (幂等) */
async function taskGroupJoin(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task group join';
  const GG: any = await import('../../agents/gateway-group.js');
  const raw = String(flags.positionals[2] ?? '').trim() || String(opt(flags, '--group') ?? '').trim();
  if (!raw) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少群链接或 groupId',
        { accepted: ['bolloon task group join orbitdb:///orbitdb/<store>?type=group&name=<群名>', 'bolloon task group join <groupId>'], usage: plain(GROUP_USAGE.trim()) }, [], 'needs_human'),
      human: GROUP_USAGE,
    };
  }

  // 链接 → 真入群 (打开 store); groupId/群名 → 必须已经在本地列表里 (不能凭 id 凭空入群)
  if (!/^orbitdb:\/\//i.test(raw)) {
    // 别的 scheme (`https://…` / `ipfs://…`): 这是**不是群链接**, 不是"本机没有这个群" —— 分开报
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return {
        envelope: failEnvelope('INVALID_ARGUMENT',
          `这不是群链接 (${raw.split(':')[0]}://…) —— 群链接形如 orbitdb:///orbitdb/<store>?type=group&name=<群名>`,
          { scheme: raw.split(':')[0], accepted: ['bolloon task group join orbitdb:///orbitdb/<store>?type=group&name=<群名>'] }, [], 'needs_human'),
        human: `${title(head)}\n  这不是群链接: ${raw.slice(0, 12)}…\n\n${hint('群邀请链接形如 orbitdb:///orbitdb/<store>?type=group&name=<群名> (bolloon task group create 会打印它)')}`,
      };
    }
    const loc = await resolveLocalGroup(raw);
    if (!loc.ok) {
      return {
        envelope: failEnvelope('NOT_FOUND',
          `本机没有这个群: ${raw} —— 用 id/群名**不能**入群, 只有群链接才能入群`,
          { accepted: 'bolloon task group join <群链接>', howTo: '拿到群链接后再试; 看已加入的群: bolloon task group list' }, [], 'needs_human'),
        human: `${title(head)}\n  本机没有这个群: ${raw}\n\n${hint('id/群名只能引用**已加入**的群; 要入群请用邀请链接')}`,
      };
    }
    const data = { group: { id: loc.group.id, name: loc.group.name }, already: true, joined: true, storeOpened: false };
    return {
      envelope: okEnvelope('OK', `已在群里「${loc.group.name}」(${loc.group.id.slice(0, 12)}…)`, data, [loc.group.id], null),
      human: [title(head), line('群名', loc.group.name), line('groupId', loc.group.id), line('状态', 'already=true (早就加入过, 没有重复入群)')].join('\n'),
    };
  }

  const r = await GG.joinGroup(raw);
  if (!r.ok || !r.group) {
    const unreachable = r.code === 'STORE_UNREACHABLE';
    return {
      envelope: failEnvelope(unreachable ? 'TRANSPORT_FAILED' : 'INVALID_ARGUMENT',
        unreachable ? `群 store 不可达: ${r.error ?? '未知原因'}` : `不是有效的群链接: ${r.error ?? '未知原因'}`,
        {
          storeCode: r.code ?? null,
          joined: false,
          storeOpened: false,
          localFallback: false,
          why: unreachable
            ? '链接能解析但区块不在本机且没有 block broker → 如实失败 (绝不把"读不到"说成"群里没东西")'
            : '链接不是 orbitdb://…?type=group&name=… 形状 → 拒绝 (不猜你想进哪个群)',
        }, [], 'needs_human'),
      human: [
        title(head),
        `  ${unreachable ? '群 store 不可达' : '链接非法'}: ${r.error ?? ''}`,
        '',
        hint(unreachable
          ? '区块不在本机: 跨机同步 (bitswap/block broker) 还没接; 同机请确认对方的区块目录可读'
          : '群链接形如 orbitdb:///orbitdb/<store>?type=group&name=<群名>'),
      ].join('\n'),
    };
  }
  const data: Record<string, unknown> = {
    group: { id: r.group.id, name: r.group.name },
    already: !!r.already,
    joined: true,
    storeOpened: true,
    linkKeptLocally: true,
    note: '入群只改本机群列表 + 打开群 store: 不执行任务、不付款',
  };
  const guard = await guardGroupOutput(data, [r.group.id]);
  if (!guard.ok) return groupGuardFail(head, guard.hits, { joined: true });
  data.nodeIdentityGuard = { scanned: true, exemptedGroupTokens: guard.exempted };
  return {
    envelope: okEnvelope('OK',
      r.already ? `已在群里「${r.group.name}」(${r.group.id.slice(0, 12)}…)` : `已入群「${r.group.name}」(${r.group.id.slice(0, 12)}…)`,
      data, [r.group.id], null),
    human: [
      title(head),
      line('群名', r.group.name),
      line('groupId', r.group.id),
      line('状态', r.already ? 'already=true (幂等: 早就加入过)' : '新加入'),
      '',
      hint(`现在可以: bolloon task trail --group ${r.group.id.slice(0, 12)}…  /  bolloon task claim <announcementId> --group <链接>`),
    ].join('\n'),
  };
}

/** `task group list [--json]` —— 本机已加入的群 (脱敏: 不出链接/地址/DID/peerId/IP) */
async function taskGroupList(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task group list';
  const GG: any = await import('../../agents/gateway-group.js');
  const groups: any[] = await GG.listGroups();
  const rows = groups.map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt ?? null }));
  const data: Record<string, unknown> = {
    count: rows.length,
    groups: rows,
    note: '只出群标识/群名/加入时间: 邀请链接与 store 地址不进 list (要链接用 bolloon task group link <groupId>); '
      + '本输出不含原始 DID/钱包地址/peerId/节点 multiaddr/IP',
  };
  const guard = await guardGroupOutput(data, rows.map((r) => r.id));
  if (!guard.ok) return groupGuardFail(head, guard.hits, { count: rows.length });
  data.nodeIdentityGuard = { scanned: true, exemptedGroupTokens: guard.exempted };
  return {
    envelope: okEnvelope('OK',
      rows.length ? `本机已加入 ${rows.length} 个群` : '本机还没有加入任何群 (空列表, 不是错误)',
      data, rows.map((r) => r.id), null),
    human: [
      title(head),
      ...(rows.length
        ? rows.map((r) => `  ${String(r.id).slice(0, 12)}…  ${String(r.name ?? '(无名)').padEnd(20)}  ${r.createdAt ?? '(无时间)'}`)
        : ['  (本机还没有加入任何群)']),
      '',
      hint('建群: bolloon task group create --name <群名>  ·  入群: bolloon task group join <群链接>  ·  取链接: bolloon task group link <groupId>'),
    ].join('\n'),
  };
}

/** `task group link <groupId|群名>` —— 显式取回邀请链接 */
async function taskGroupLink(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task group link';
  const raw = String(flags.positionals[2] ?? '').trim() || String(opt(flags, '--group') ?? '').trim();
  if (!raw) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 groupId (或群名)', { accepted: ['bolloon task group link <groupId>'], usage: plain(GROUP_USAGE.trim()) }, [], 'needs_human'),
      human: GROUP_USAGE,
    };
  }
  const loc = await resolveLocalGroup(raw);
  if (!loc.ok) {
    return {
      envelope: failEnvelope('NOT_FOUND', `本机没有这个群: ${raw} (取不到链接)`,
        { howTo: '看已加入的群: bolloon task group list' }, [], 'needs_human'),
      human: `${title(head)}\n  本机没有这个群: ${raw}\n\n${hint('先 bolloon task group list 看有哪些群 (或 join 入群)')}`,
    };
  }
  const data: Record<string, unknown> = { group: { id: loc.group.id, name: loc.group.name, link: loc.group.link } };
  const guard = await guardGroupOutput(data, [loc.group.id, loc.group.link]);
  if (!guard.ok) return groupGuardFail(head, guard.hits, { group: { name: loc.group.name } });
  data.nodeIdentityGuard = { scanned: true, exemptedGroupTokens: guard.exempted };
  return {
    envelope: okEnvelope('OK', `群「${loc.group.name}」的邀请链接已取出`, data, [loc.group.id], null),
    human: [title(head), line('群名', loc.group.name), line('groupId', loc.group.id), line('邀请链接', loc.group.link)].join('\n'),
  };
}

/** `task group leave <groupId|群名>` —— 退群 (只摘本机记录) */
async function taskGroupLeave(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon task group leave';
  const GG: any = await import('../../agents/gateway-group.js');
  const raw = String(flags.positionals[2] ?? '').trim() || String(opt(flags, '--group') ?? '').trim();
  if (!raw) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 groupId (或群名)', { accepted: ['bolloon task group leave <groupId>'], usage: plain(GROUP_USAGE.trim()) }, [], 'needs_human'),
      human: GROUP_USAGE,
    };
  }
  const r = await GG.leaveGroup(raw);
  if (!r.ok) {
    return {
      envelope: failEnvelope('NOT_FOUND', `退群失败: ${r.error ?? '未知原因'}`, { removed: false }, [], 'needs_human'),
      human: `${title(head)}\n  ${r.error ?? '未知原因'}\n\n${hint('看已加入的群: bolloon task group list')}`,
    };
  }
  return {
    envelope: okEnvelope('OK', `已退出群 ${String(r.removed).slice(0, 12)}… (只摘本机记录)`,
      { removed: true, groupId: r.removed, localOnly: true, note: '群 store 是公共 append-only: 别人那边不会因为你退出而改 (本命令没有踢人/解散权限, 也不假装有)' },
      [String(r.removed)], null),
    human: [
      title(head),
      line('已退出', `${String(r.removed).slice(0, 12)}…`),
      line('范围', '只摘本机记录 (~/.bolloon/gateway-groups.json)'),
      '',
      `  群 store 是公共 append-only: 别人那边不会因为你退出而改 (本命令没有踢人/解散权限, 也不假装有)`,
    ].join('\n'),
  };
}

// ── 仍未实现的两个 (任务书没点名; 如实报, 不假装) ────────────────────────────

async function taskComplete(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task complete 还没实现: 没有任务状态存储可写 (交易层有非法迁移保护, 不许绕过)', {
    plannedCapability: 'task.complete',
    contractLayer: 'src/agents/task-contract.ts checkTaskMove (:73-80) 非法迁移拒绝, 不静默修正',
    alternative: '点 M1 闭环的进展: bolloon task status <id> / bolloon task --resume <goalId>',
  });
  return { envelope: env, human: `${title('bolloon task complete')}\n  未实现 (没有可写的任务状态存储; 交易状态机有非法迁移保护, 不许绕过)` };
}

async function taskCancel(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task cancel 还没实现: 交易层没有 cancelled 态, 也没有取消服务 (不许绕过状态机硬写)', {
    plannedCapability: 'task.cancel',
    contractLayer: '任务 14 态有 cancelled (:40) / 交易 11 态没有 cancelled (transaction-protocol.ts:39-51)',
    alternative: '付款不确定时**先对账**: bolloon trade reconcile <transactionId> (绝不重付)',
  });
  return { envelope: env, human: `${title('bolloon task cancel')}\n  未实现 (交易层没有 cancelled 态; 硬写会绕过状态机)\n\n${hint('付款不确定 → bolloon trade reconcile <transactionId> (先对账, 绝不重付)')}` };
}

export { judge as judgeTransaction, recSummary as transactionSummary };
