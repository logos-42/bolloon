/**
 * task-runner.ts — M1 薄层 ①: Task Runner (M1–M4 收口版)
 *
 *   `bolloon task "<任务>" --budget 0.05`  →  Goal → (顾问) → 购买 → 执行 → 证据 → 报告卡
 *   `bolloon task --resume <goalId>`       →  统一恢复决策 (与 Supervisor 同一个函数)
 *
 * 收口要点 (leo 2026-09-18 收口计划):
 *   · Goal / Run **先建**: 任何一条失败路径都返回报告卡, 不抛栈、不返回空 runId
 *   · 证据只走 `bridgeTransactionToRunGoal` (不再自己维护第二套证据写法)
 *   · 交易记录写 `resourceOutcome` (安装/执行/契约/判据) + `verificationTrust`
 *   · 失败映射: 付了但资源没跑成 → `delivery_failed`; 跑了但输出不合契约 → `verification_failed`
 *   · local-dev 永远 self-attested, 永不 `verified`
 *   · 非幂等保护: 已有执行证据的任务续跑时**不重复执行**
 *   · 故障注入钩子 `BOLLOON_TASK_FAULT` (仅测试用; 不设即无行为差异)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  createGoal, attachRun, markCriterion, completeGoalIfEligible, readGoal, setCriteria,
} from '../goal-store.js';
import { startRun, recordStep, finishRun, readRun } from '../run-store.js';
import { listTransactions, updateTransaction, setTransactionStatus } from '../x402/transaction-store.js';
import { bridgeTransactionToRunGoal } from '../x402/goal-run-bridge.js';
import { buyInfoAsTransaction } from '../x402/trade.js';
import { publishInfo, listInfo } from '../x402/paid-info-store.js';
import { planTransactionRecovery } from '../x402/payment-recovery.js';
import { executeContractSkill, validateResourceOutput, verifyInstallFidelity, loadResourceContract } from '../x402/resource-contract.js';
import { adviseResource } from './resource-advisor.js';
import { resolveTaskBudget, checkPurchaseAllowed, previewPurchaseImpact, assertNoExpansion, type TaskBudgetPlan } from './task-budget.js';
import { buildReportCard, renderReportCard, type ReportCard, type TaskStage } from './report-card.js';
import { startLocalSeller, ensureSellerIdentity } from './local-seller.js';

/** M1 默认值 (本地 Registry; 价格必须 ≤ 单次上限 0.02) */
export const M1_DEFAULTS = {
  localPrice: '0.012',
  currency: 'USDC' as const,
  network: 'base-sepolia',
  localPayTo: '0x1111111111111111111111111111111111111111',
  buyerDid: 'did:key:zTaskBuyer',
} as const;

export interface RunTaskOptions {
  task: string;
  budget?: string | number;
  perPurchase?: string | number;
  daily?: string | number;
  input?: unknown;
  home?: string;
  cwd?: string;
  skillPaths?: string[];
  allowLocalDev?: boolean;
  walletKey?: string;
  buyerDid?: string;
  payTo?: string;
  requestId?: string;
  /** 续跑时复用已有 Goal (不新开目标) */
  reuseGoalId?: string;
  /** 已有执行证据时不许重复执行非幂等工作 (续跑默认 true) */
  skipExecutionIfDone?: boolean;
  price?: string;
  onStage?: (stage: TaskStage, note: string) => void;
}

export interface StageRecord { stage: TaskStage; note: string; ms: number }

export interface TaskRunResult {
  ok: boolean;
  card: ReportCard;
  text: string;
  goalId?: string;
  runId?: string;
  transactionId?: string;
  stages: StageRecord[];
  budget: TaskBudgetPlan;
  advisor?: { needed: boolean; reason: string; skill?: string; why: string[] };
  payment?: { mode: string; amount: string; currency: string; network: string; txHash?: string; chainSettled: boolean; trust: string; reused?: boolean };
  execution?: { ok: boolean; reason?: string; output?: unknown; reused?: boolean };
  outputIssues: string[];
  listingCreated?: boolean;
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 同一个 (任务 + 预算) 派生**同一个 requestId** —— 这是"重跑不重复付款"的关键:
 * 进程被杀后重新执行同样的任务, trade 层的幂等短路会复用已有交易, 不会第二次扣款。
 */
export function defaultRequestId(task: string, taskBudget: number): string {
  const h = crypto.createHash('sha256').update(`${task.trim()}|${taskBudget}`).digest('hex').slice(0, 16);
  return `task-${h}`;
}

/** 故障注入 (只给验收用; 未设置 = 完全无行为差异) */
function faultPoint(name: string): void {
  const want = process.env.BOLLOON_TASK_FAULT;
  if (!want || want !== name) return;
  if (process.env.BOLLOON_TASK_FAULT_MODE === 'exit') process.exit(97);       // 模拟进程被杀
  process.kill(process.pid, 'SIGKILL');
}

/**
 * 数值字段的锚点词: 字段名本身 + 常见别名 —— 只有「锚点词紧邻数字」才算, 数字不搬家。
 * 为什么需要: 早先的实现把「任务文本里第一个数字」塞给**每一个**数值字段。任务里出现
 * 技术符号 (如 `μ0H_P`) 时第一个数字就是那个 `0` → field_T/tc_K/factor 全被编成 0 →
 * 技能判「输入不合格→未知」→ 输出缺 required 字段 → 托管已注资但拿不到 proof (钱卡住)。
 * 编造数字比缺输入更糟: 宁可让 inputSchema 报「缺字段」, 也不给一个看着像真值的假数字。
 */
const NUMBER_ANCHORS: Record<string, string[]> = {
  budgetusd: ['预算', 'budget'], budget: ['预算', 'budget'],
  price: ['价格', '单价', 'price'], amount: ['金额', 'amount'], usd: ['美元', 'usd'],
  count: ['数量', 'count'], qty: ['数量', 'qty'], quantity: ['数量', 'quantity'],
  tol: ['容差', 'tol'], tolerance: ['容差', 'tolerance'],
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 只在任务里该字段有明确锚点 (字段名/别名 后紧跟数字) 时才取数; 取不到 = 不填, 不编 */
function anchoredNumber(task: string, key: string): number | undefined {
  const anchors = [key, ...(NUMBER_ANCHORS[key.toLowerCase()] || [])].filter(Boolean);
  for (const a of anchors) {
    const m = task.match(new RegExp(`${escapeRe(a)}[^0-9\\n]{0,6}?(\\d+(?:\\.\\d+)?)`, 'i'));
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** 从任务文本 + 契约 inputSchema 推导输入 (确定性; M1 不做语义抽取, 用 --input 兜底) */
export function deriveSkillInput(contract: any, task: string): Record<string, unknown> {
  const schema = contract?.inputSchema || {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const props: Record<string, any> = schema.properties || {};
  const MARKET_RE = /(日本|美国|欧盟|东南亚|韩国|德国|英国|法国|加拿大|澳大利亚|印度|中东|拉美|巴西|越南|泰国)/;
  const market = (task.match(MARKET_RE) || [])[0] || '';
  const cleanProduct = (t: string) =>
    t
      .replace(MARKET_RE, ' ')
      .replace(/判断|这款|这个|是否|适合|不适合|进入|市场|帮我|看下|看一下|能不能|可否|调研|建议/g, ' ')
      .replace(/[，。、,.?!？!：:；;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const fields = Array.from(new Set([...required, ...Object.keys(props)]));
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    const p = props[key] || {};
    const isRequired = required.includes(key);
    const type = String(p.type || 'string');
    if (type === 'number' || type === 'integer') {
      const n = anchoredNumber(task, key);        // 任务里该字段有明确锚点才填 (可选字段也不硬塞)
      if (n !== undefined) out[key] = n;
      continue;
    }
    if (/market|国家|市场|地区|country|region/i.test(key)) {
      if (market) out[key] = market;
      else if (isRequired) out[key] = task.slice(0, 40);
      continue;
    }
    if (/product|商品|品名|item|name/i.test(key)) {
      const prod = cleanProduct(task);
      if (prod.length >= 2) out[key] = prod.slice(0, 60);
      else if (isRequired) out[key] = task.slice(0, 60);
      continue;
    }
    if (isRequired) out[key] = task.slice(0, 200);
  }
  return out;
}

/** 结论抽取: 优先显式字段, 不猜语义 */
export function extractConclusion(output: any): { conclusion?: string; detail?: string } {
  if (!output || typeof output !== 'object') return {};
  const o = output as any;
  for (const k of ['conclusion', 'verdict', 'recommendation', 'summary', '结论']) {
    if (typeof o[k] === 'string' && o[k].trim()) return { conclusion: o[k].trim().slice(0, 160) };
  }
  if (typeof o.suitable === 'boolean') return { conclusion: o.suitable ? '适合' : '不适合' };
  return {};
}

export function extractSources(output: any): string[] {
  const o = output as any;
  if (!o || typeof o !== 'object') return [];
  const raw = o.sources || o.findings?.map((f: any) => f?.source).filter(Boolean) || [];
  const list: string[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (typeof s === 'string') list.push(s);
    else if (s && typeof s === 'object') list.push(String((s as any).url || (s as any).ref || (s as any).name || JSON.stringify(s).slice(0, 60)));
  }
  return list;
}

/** 默认判据 (来自资源契约, 可判定) */
export function defaultCriteria(contract: any): string[] {
  const v = contract?.verification || {};
  const req = (v.requiredFields || []).slice(0, 4).join(', ');
  const ev = (v.evidenceFields || []).slice(0, 3).join(', ');
  return [
    `输出包含契约要求字段 (${req || 'requiredFields'})`,
    `输出带可核验来源 (${ev || 'sources'})`,
    '结论可读 (conclusion/verdict)',
  ];
}

function safeJoin(dir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.includes('..')) return null;
  const full = path.join(dir, rel);
  if (!full.startsWith(dir)) return null;
  return full;
}

export function installBundle(content: string, installDir: string): { ok: boolean; files: number; error?: string } {
  let bundle: any;
  try {
    bundle = JSON.parse(content);
  } catch (e: any) {
    return { ok: false, files: 0, error: `交付内容不是合法 JSON 包: ${String(e?.message || e).slice(0, 80)}` };
  }
  const files = bundle?.files || {};
  const rels = Object.keys(files);
  if (rels.length === 0) return { ok: false, files: 0, error: '交付包里没有文件' };
  try {
    for (const rel of rels) {
      const dest = safeJoin(installDir, rel);
      if (!dest) return { ok: false, files: 0, error: `包内路径非法 (越界): ${rel}` };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, String(files[rel]), 'utf8');
    }
  } catch (e: any) {
    return { ok: false, files: 0, error: `安装失败: ${String(e?.message || e).slice(0, 80)}` };
  }
  return { ok: true, files: rels.length };
}

/** 本地 Registry: 若技能没有报价, 就按技能目录发布一条本地报价 (确定性 id = 技能名) */
export async function ensureLocalListing(opts: {
  skillName: string; skillDir: string; home: string; price?: string; payTo?: string; version?: string;
}): Promise<{ itemId: string; created: boolean; error?: string }> {
  const existing = (await listInfo(opts.home)).find((i) => String(i.id) === opts.skillName);
  if (existing) return { itemId: existing.id, created: false };

  const SHARE: any = await import('../skill-share.js');
  const collected = await SHARE.collectSkillBundle(opts.skillDir, { name: opts.skillName });
  if (!collected?.ok || !collected?.bundle) return { itemId: '', created: false, error: `打包技能失败: ${collected?.error || '未知'}` };
  const did = (await ensureSellerIdentity(opts.home)).did || 'did:key:zLocalSeller';
  const item = await publishInfo(
    {
      id: opts.skillName,
      title: opts.skillName,
      category: 'skill',
      content: JSON.stringify(collected.bundle),
      description: `本地可执行技能 ${opts.skillName}`,
      price: { amount: String(opts.price ?? M1_DEFAULTS.localPrice), currency: M1_DEFAULTS.currency, network: M1_DEFAULTS.network, payTo: String(opts.payTo ?? M1_DEFAULTS.localPayTo) },
      source: { kind: 'self', refs: [opts.skillDir], note: `skill=${opts.skillName}@${opts.version || ''}` },
      provider: { did, name: '本机卖方' },
    },
    { home: opts.home },
  );
  return { itemId: item.id, created: true };
}

/**
 * "只补交付, 不重付" (M2 第 ② 类恢复点):
 * 付款已经发生过 (记录里有凭据), 但内容没拿到 → 拿**同一个支付凭据**再向卖方取一次内容。
 * 卖方会重新校验这个凭据 (幂等), 不会再产生一笔付款。
 */
export async function refetchDeliveredContent(opts: { url: string; receipt: string }): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!opts.receipt) return { ok: false, error: '记录里没有支付凭据, 无法补交付 (需要人工/对账)' };
  try {
    const res = await fetch(opts.url, { headers: { 'X-PAYMENT': opts.receipt } });
    if (!res.ok) return { ok: false, error: `补交付被卖方拒绝: HTTP ${res.status}` };
    const env: any = await res.json().catch(() => null);
    const content = String(env?.content ?? '');
    if (!content) return { ok: false, error: '卖方返回里没有内容' };
    return { ok: true, content };
  } catch (e: any) {
    return { ok: false, error: `补交付请求失败: ${String(e?.message || e).slice(0, 100)}` };
  }
}

/**
 * M4 出口口径 (纯函数, 可单测): 技能**产出了输出**但契约不过 → 验真失败; 压根没产出 → 交付失败。
 */
export function mapFailureStatus(opts: { producedOutput: boolean; contractOk: boolean }): 'verification_failed' | 'delivery_failed' {
  return opts.producedOutput && !opts.contractOk ? 'verification_failed' : 'delivery_failed';
}

/** 失败阶段 (M4 归责用): 装不上 → install; 没产出 → execute; 产出但不合契约 → output_contract */
export function failureStageFor(opts: { installOk: boolean; producedOutput: boolean; contractOk: boolean }): 'install' | 'execute' | 'output_contract' | undefined {
  if (!opts.installOk) return 'install';
  if (!opts.producedOutput) return 'execute';
  if (!opts.contractOk) return 'output_contract';
  return undefined;
}

/** 判断一笔交易是否已经有"资源被执行过"的证据 (用于非幂等保护) */
export function hasExecutionEvidence(rec: any): boolean {
  return rec?.resourceOutcome?.executed === true || rec?.execution?.ok === true;
}

/**
 * 非幂等保护的完整判据: 交易记录**或** Run 轨迹里任一证明"执行过" → 不许再执行一遍。
 * (真跑抓到过: 只查交易记录时, "执行完但还没写回交易就被杀"的任务续跑会重复执行非幂等技能。)
 */
export async function goalAlreadyExecuted(goal: any): Promise<boolean> {
  for (const runId of (goal?.runs || [])) {
    try {
      const run = await readRun(runId);
      const hit = (run?.steps || []).some((st: any) => st.tool === 'skill_exec' && st.ok === true);
      if (hit) return true;
    } catch { /* 读不到就当没有, 但交易记录那边还会兜一层 */ }
  }
  return false;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

export async function runTask(opts: RunTaskOptions): Promise<TaskRunResult> {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const stages: StageRecord[] = [];
  const t0 = Date.now();
  let lastMs = t0;
  const mark = (stage: TaskStage, note: string) => {
    const now = Date.now();
    stages.push({ stage, note, ms: now - lastMs });
    lastMs = now;
    opts.onStage?.(stage, note);
  };
  const blankBudget = (why: string[]): TaskBudgetPlan => ({ taskBudget: 0, perPurchase: 0, daily: 0, requested: {}, clamped: { task: false, perPurchase: false, daily: false }, why });

  // ① 预算 (唯一可以在没有 Goal 的情况下返回失败的一步: 预算非法 == 记账本身无意义)
  const parsed = resolveTaskBudget({ taskBudget: opts.budget, perPurchase: opts.perPurchase, daily: opts.daily });
  if (!parsed.ok || !parsed.plan) {
    const card = buildReportCard({ task: opts.task, executed: false, paid: false, blocker: `预算不合法: ${parsed.error}`, evidenceRef: {} });
    return { ok: false, card, text: renderReportCard(card), stages, budget: blankBudget([String(parsed.error)]), outputIssues: [] };
  }
  const budget = parsed.plan;
  mark('prepare', `任务: ${opts.task} · 预算 ${budget.taskBudget} USDC`);

  // ② Goal + Run 先建 (此后每条失败路径都带 goalId/runId, 且可续跑)
  const criteria0 = ['任务完成并留下完整证据'];
  const reusedGoal = opts.reuseGoalId ? await readGoal(opts.reuseGoalId) : null;
  let goal: any = reusedGoal;
  if (!goal) {
    try {
      goal = await createGoal({ objective: opts.task, successCriteria: criteria0, constraints: [`预算 ≤ ${budget.taskBudget} ${M1_DEFAULTS.currency}`], createdBy: 'cli:task' });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 200);
      mark('report', '初始化未就绪 → 没有创建 Goal, 也没有花钱');
      const card = buildReportCard({ task: opts.task, executed: false, paid: false, conclusion: '证据不足', blocker: `本机还没初始化好, 无法记账也不会花钱: ${msg}`, evidenceRef: {}, budgetLines: budget.why });
      return { ok: false, card, text: renderReportCard(card), stages, budget, outputIssues: [] };
    }
  }
  const run = await startRun({ surface: 'cli', goal: opts.task, goalId: goal.goalId });
  await attachRun(goal.goalId, run.runId);
  const fail = async (stage: TaskStage, note: string, cardOpts: Parameters<typeof buildReportCard>[0], runStatus: 'needs_human' | 'failed' = 'needs_human') => {
    mark(stage, note);
    await finishRun(run.runId, { status: runStatus, summary: note.slice(0, 200) });
    const card = buildReportCard({ ...cardOpts, evidenceRef: { goalId: goal.goalId, runId: run.runId, transactionId: cardOpts.evidenceRef?.transactionId }, budgetLines: [...budget.why, ...(cardOpts.budgetLines || [])] });
    return { ok: false, card, text: renderReportCard(card), goalId: goal.goalId, runId: run.runId, transactionId: card.evidenceRef.transactionId, stages, budget, outputIssues: cardOpts.blocker ? [cardOpts.blocker] : [] } as TaskRunResult;
  };

  // ③ 顾问: 自动判断缺什么能力
  const advisor = await adviseResource({ task: opts.task, home, cwd, skillPaths: opts.skillPaths });
  const advisorBrief = { needed: advisor.needed, reason: advisor.reason, skill: advisor.chosen?.name, why: advisor.chosen?.why || [] };
  await recordStep(run.runId, { tool: 'resource_advise', ok: advisor.needed, summary: advisor.chosen ? `选中 ${advisor.chosen.name}@${advisor.chosen.version} (分数 ${advisor.chosen.score})` : advisor.reason, error: advisor.needed ? undefined : advisor.reason });
  if (!advisor.needed || !advisor.chosen) {
    const r = await fail('report', '没有可用的可执行资源 → 不买, 如实报告', {
      task: opts.task, executed: false, paid: false, conclusion: '证据不足',
      blocker: `缺少能完成这个任务的外部能力, 且本地 Registry 里没有匹配的可执行 Skill。${advisor.reason}`,
      evidenceRef: {},
    });
    return { ...r, advisor: advisorBrief };
  }
  const chosen = advisor.chosen;
  mark('prepare', `顾问判断缺能力 → 选 "${chosen.name}" (分数 ${chosen.score}): ${chosen.why.slice(0, 2).join(' / ') || '名字匹配'}`);

  // ④ 报价 (本地 Registry 没报价就发布一条, 如实留痕)
  let listing = chosen.listing;
  let listingCreated = false;
  if (!listing) {
    const pub = await ensureLocalListing({ skillName: chosen.name, skillDir: chosen.dir, home, price: opts.price, payTo: opts.payTo, version: chosen.version });
    if (!pub.itemId) {
      const r = await fail('report', `无法把技能变成可购买资源: ${pub.error}`, {
        task: opts.task, executed: false, paid: false, conclusion: '证据不足',
        blocker: `技能 "${chosen.name}" 无法变成可购买资源: ${pub.error}`,
        skill: { name: chosen.name, version: chosen.version, dir: chosen.dir }, evidenceRef: {},
      });
      return { ...r, advisor: advisorBrief };
    }
    listingCreated = pub.created;
    mark('acquire', `本地 Registry 里没有 "${chosen.name}" 的报价 → 已按技能目录发布本地报价 (itemId=${pub.itemId})`);
    listing = { itemId: pub.itemId, title: chosen.name, amount: String(opts.price ?? M1_DEFAULTS.localPrice), currency: M1_DEFAULTS.currency, network: M1_DEFAULTS.network, payTo: String(opts.payTo ?? M1_DEFAULTS.localPayTo) };
  }

  // ⑤ 预算门 (付款前必须看得到价格与影响; 三层各自会拦)
  const impact = previewPurchaseImpact(budget, listing.amount);
  const decision = checkPurchaseAllowed({ amount: listing.amount, plan: budget });
  if (!decision.allowed) {
    const r = await fail('report', `预算门拒绝 (${decision.layer}): ${decision.reason}`, {
      task: opts.task, executed: false, paid: false, conclusion: '证据不足',
      blocker: `购买被预算门拦下 (${decision.layer}): ${decision.reason}`,
      skill: { name: chosen.name, version: chosen.version },
      cost: { amount: listing.amount, currency: listing.currency, network: listing.network },
      evidenceRef: {}, budgetLines: impact,
    });
    return { ...r, advisor: advisorBrief };
  }

  // ⑤.5 判据 (合同契约生成, 确认后才可能判完成)
  const criteria = defaultCriteria(chosen.contract);
  if (!reusedGoal) await setCriteria(goal.goalId, { criteria, source: 'user', confirm: true, by: 'cli:task' });

  // ⑥ 买 (支付逻辑全在 trade.ts; 这里只给本地卖方地址)
  mark('acquire', impact.join(' · '));
  faultPoint('before_payment');
  const seller = await startLocalSeller();
  const requestId = opts.requestId || defaultRequestId(opts.task, budget.taskBudget);
  let trade: any;
  try {
    trade = await buyInfoAsTransaction({
      url: `${seller.url}/api/x402/info/${listing.itemId}`,
      requestId,
      buyerDid: opts.buyerDid || M1_DEFAULTS.buyerDid,
      privateKey: opts.walletKey,
      allowLocalDev: opts.allowLocalDev ?? true,
      maxPaymentAmount: String(budget.perPurchase),
      taskBudget: String(budget.taskBudget),
      network: listing.network,
      expectItemId: listing.itemId,
      service: 'x402-skill',
      goalId: goal.goalId,
      runId: run.runId,
      home,
    });
  } finally {
    await seller.close();
  }
  faultPoint('after_payment');

  const trust = trade?.record?.chainSettled === true ? 'verified' : 'self-attested';
  const payment = {
    mode: String(trade?.record?.paymentMode || 'none'),
    amount: listing.amount,
    currency: listing.currency,
    network: listing.network,
    txHash: trade?.record?.txHash,
    chainSettled: trade?.record?.chainSettled === true,
    trust,
    reused: trade?.reused === true,
  };
  const paid = payment.mode !== 'none' && (payment.chainSettled || payment.mode === 'local-dev');
  await recordStep(run.runId, {
    tool: 'x402_buy',
    ok: trade?.ok === true,
    summary: `${payment.mode} · ${listing.amount} ${listing.currency} · 结算=${payment.chainSettled}`,
    error: trade?.ok ? undefined : String(trade?.error || trade?.status || '').slice(0, 160),
  });

  // 内容没拿到 (复用的交易不带内容, 或交付阶段被打断) → 补交付, 不重付
  let deliveredContent = String(trade?.envelope?.content ?? '');
  let redelivered = false;
  if (!deliveredContent && (trade?.record as any)?.paymentReceipt) {
    const seller2 = await startLocalSeller();
    let ref: { ok: boolean; content?: string; error?: string };
    try {
      ref = await refetchDeliveredContent({ url: `${seller2.url}/api/x402/info/${listing.itemId}`, receipt: String((trade.record as any).paymentReceipt) });
    } finally {
      await seller2.close();
    }
    if (ref.ok) {
      deliveredContent = String(ref.content || '');
      redelivered = true;
      trade = { ...trade, ok: true };
      mark('acquire', '已付款但没交付 → 用同一支付凭据补交付 (没有再付款)');
      await recordStep(run.runId, { tool: 'x402_redeliver', ok: true, summary: '补交付成功 (同一凭据, 无第二笔付款)' });
    } else {
      await recordStep(run.runId, { tool: 'x402_redeliver', ok: false, summary: ref.error });
    }
  }

  if (!trade?.ok) {
    // 失败映射 (M4): 付款事实不确定 → needs_human, 绝不自动重付
    const rec = trade?.record;
    if (rec) {
      const r2 = await bridgeTransactionToRunGoal(rec, { runId: run.runId, goalId: goal.goalId, executionOk: false, goalCriteriaHit: false, summary: `${chosen.name}@${chosen.version}` });
      void r2;
    }
    const uncertain = String(trade?.status || '') === 'payment_required' && trade?.payment?.settlementUncertain === true;
    return {
      ...(await fail('report', `付款/交付失败: ${trade?.error || trade?.status} → 不执行, 不伪装成功`, {
        task: opts.task, executed: false, paid, conclusion: '证据不足',
        blocker: `${uncertain ? '付款状态不确定 (先对账, 不许重付): ' : '卡在购买这一步: '}${String(trade?.error || trade?.status)}`,
        skill: { name: chosen.name, version: chosen.version },
        cost: { amount: listing.amount, currency: listing.currency, network: listing.network },
        lifecycle: String(trade?.status || ''), evidenceRef: { transactionId: trade?.transactionId },
      }, uncertain ? 'needs_human' : 'failed')),
      advisor: advisorBrief, payment,
    };
  }

  // ⑦ 保真 + 安装
  const content = deliveredContent;
  const installDir = path.join(home, '.bolloon', 'tasks', run.runId, 'skills', chosen.name);
  fs.mkdirSync(installDir, { recursive: true });
  const installed = installBundle(content, installDir);
  let fidelityScore: '通过' | '未通过' = '未通过';
  let fidelityIssues: string[] = [];
  if (installed.ok) {
    const fidelity = await verifyInstallFidelity({ content, rec: trade?.record, installDir });
    fidelityScore = fidelity.ok ? '通过' : '未通过';
    fidelityIssues = fidelity.issues || [];
  } else {
    fidelityIssues = [installed.error || '安装失败'];
  }
  await recordStep(run.runId, { tool: 'resource_install', ok: fidelityScore === '通过', summary: `${installed.files} 个文件 → ${installDir}`, error: fidelityIssues[0] });
  faultPoint('after_install');

  // ⑧ 执行 (真跑技能代码) + 输出契约校验
  mark('execute', `执行 ${chosen.name}`);
  faultPoint('before_execute');
  const loaded = await loadResourceContract(installDir);
  const contract = loaded.ok && loaded.contract ? loaded.contract : chosen.contract;
  const input = opts.input ?? deriveSkillInput(contract, opts.task);
  const exec = await executeContractSkill({
    contract,
    skillDir: installDir,
    input,
    allowedTools: ['skill_exec', 'read_file'],
    allowCodeExecution: true,
  });
  const outChk = validateResourceOutput(contract, exec.output);
  const sources = extractSources(exec.output);
  const concl = extractConclusion(exec.output);
  await recordStep(run.runId, {
    tool: 'skill_exec',
    ok: exec.execution.ok === true && outChk.ok,
    summary: `输出契约=${outChk.ok ? '通过' : '未通过'} · 来源 ${sources.length} 个`,
    error: (outChk.issues || [])[0] || exec.execution.reason,
    args: input,
  });
  faultPoint('after_execute');      // 执行事实已进 Run 轨迹后才允许被杀 (续跑据此判定"已执行过")

  // ⑨ 统一的"资源结果" + 失败映射 + 证据桥
  const executionOk = exec.execution.ok === true && outChk.ok;
  const goalCriteriaHit = outChk.ok && sources.length > 0 && !!concl.conclusion;
  const evidenceOk = fidelityScore === '通过' && executionOk && goalCriteriaHit;

  let rec = (await updateTransaction(trade.transactionId, {
    execution: { ...(exec.execution as any), ok: exec.execution.ok === true, reason: exec.execution.reason },
    verificationTrust: trust as any,
    resourceOutcome: {
      installed: fidelityScore === '通过',
      executed: exec.execution.ok === true,
      outputContract: outChk.ok ? 'pass' : 'fail',
      criteriaHit: goalCriteriaHit,
      failureStage: evidenceOk ? undefined : failureStageFor({ installOk: fidelityScore === '通过', producedOutput: exec.output !== undefined, contractOk: outChk.ok }),
    },
    event: { kind: 'resource_outcome', detail: `installed=${fidelityScore === '通过'} executed=${exec.execution.ok === true} contract=${outChk.ok ? 'pass' : 'fail'} criteria=${goalCriteriaHit}` },
  }, home)) ?? trade.record;

  if (paid && !evidenceOk) {
    // M4 口径: 技能**产出了输出**但契约不过 → verification_failed; 压根没产出 (崩/超时/没装上) → delivery_failed
    const producedOutput = exec.output !== undefined;
    const target = mapFailureStatus({ producedOutput, contractOk: outChk.ok });
    rec = (await setTransactionStatus(trade.transactionId, target as any, `资源未达标: install=${fidelityScore} exec=${exec.execution.ok === true} contract=${outChk.ok ? 'pass' : 'fail'}`, home)) ?? rec;
  }

  const bridge = await bridgeTransactionToRunGoal(rec, {
    runId: run.runId,
    goalId: goal.goalId,
    executionOk,
    goalCriteriaHit,
    summary: `${chosen.name}@${chosen.version}`,
  });
  await markCriterion(goal.goalId, 0, outChk.ok, `输出契约 ${outChk.ok ? '通过' : '未通过'}`);
  await markCriterion(goal.goalId, 1, sources.length > 0, `来源 ${sources.length} 个`);
  await markCriterion(goal.goalId, 2, !!concl.conclusion, concl.conclusion || '无结论字段');

  // ⑩ 报告卡
  const card = buildReportCard({
    task: opts.task,
    conclusion: evidenceOk ? concl.conclusion || '已完成' : '证据不足',
    conclusionDetail: evidenceOk ? undefined : (outChk.ok ? fidelityIssues[0] : (outChk.issues || [])[0]),
    skill: { name: chosen.name, version: chosen.version, dir: installDir },
    cost: { amount: listing.amount, currency: listing.currency, network: listing.network },
    payment: { mode: payment.mode, chainSettled: payment.chainSettled, trust: payment.trust, txHash: payment.txHash },
    sources,
    outputContract: outChk.ok ? '通过' : '未通过',
    resourceVerified: fidelityScore,
    evidenceComplete: evidenceOk,
    executed: exec.execution.ok === true,
    paid,
    stage: 'report',
    durationMs: Date.now() - t0,
    evidenceRef: { goalId: goal.goalId, runId: run.runId, transactionId: trade?.transactionId },
    budgetLines: [...budget.why, ...impact],
    blocker: evidenceOk ? undefined : (outChk.ok ? undefined : `输出不符合资源契约: ${(outChk.issues || [])[0] || '未知'}`),
  });

  await finishRun(run.runId, {
    status: evidenceOk ? 'done' : 'needs_human',
    summary: evidenceOk ? `任务完成: ${concl.conclusion || '已产出'}` : '未达标 (证据/契约不完整)',
    evidence: [`bridge: step=${bridge.stepWritten} evidence=${bridge.evidenceWritten} goal=${bridge.goalEvidenceWritten}`],
  });
  if (evidenceOk) await completeGoalIfEligible(goal.goalId);

  mark('report', card.status);
  return {
    ok: card.status === '已完成',
    card,
    text: renderReportCard(card),
    goalId: goal.goalId,
    runId: run.runId,
    transactionId: trade?.transactionId,
    stages,
    budget,
    advisor: advisorBrief,
    payment,
    execution: { ok: exec.execution.ok === true, reason: exec.execution.reason, output: exec.output },
    outputIssues: [...(outChk.issues || []), ...fidelityIssues],
    listingCreated,
  };
}

// ── 续跑: 唯一恢复决策入口 (CLI 与 Supervisor 共用) ─────────────────────────

export interface RecoveryDecision {
  action: string;
  reason: string;
  mustNotRepay: boolean;
  /** 是否已有"执行过"的证据 (非幂等保护: 有就绝不重跑) */
  alreadyExecuted: boolean;
  transactionId?: string;
}

/**
 * 任务的恢复决策 —— **CLI 的 `task --resume` 与 Supervisor 都只能调这一个函数**。
 * 它把交易层 `planTransactionRecovery` 的结论与 Goal/Run 的现状合起来, 给出唯一行动。
 */
export async function decideTaskRecovery(opts: { goalId: string; home?: string }): Promise<RecoveryDecision> {
  const home = opts.home ?? os.homedir();
  const goal = await readGoal(opts.goalId);
  if (!goal) return { action: 'closed', reason: `找不到 Goal ${opts.goalId}`, mustNotRepay: true, alreadyExecuted: false };
  const all = await listTransactions(home);
  let txs = all.filter((t) => (t as any).goalId === opts.goalId);
  if (txs.length === 0) {
    // 同 (任务+预算) 派生的 requestId 是幂等的: 目标可能是"复用已有交易"跑出来的,
    // 那笔交易的 goalId 还是最早的 Goal → 按 requestId 找回它 (否则会误判成"没付过"而重复付款)。
    const m = String((goal.constraints || []).join(' ')).match(/预算 ≤ ([0-9.]+)/);
    const budget = m ? Number(m[1]) : 0.05;
    const rid = defaultRequestId(goal.objective, budget);
    txs = all.filter((t) => (t as any).requestId === rid);
  }
  const latest = txs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (!latest) {
    return { action: 'retry_payment', reason: '这个目标还没有过交易 → 从头跑 (没有钱可重复付)', mustNotRepay: false, alreadyExecuted: false };
  }
  const plan = planTransactionRecovery(latest as any);
  const alreadyExecuted = hasExecutionEvidence(latest) || await goalAlreadyExecuted(goal);
  if (alreadyExecuted && plan.action !== 'complete') {
    // 非幂等保护: 已经执行过就别再跑一遍, 只报告现状
    return { action: 'already_executed', reason: `这笔交易的资源已经执行过 (${latest.status}), 不重复执行非幂等操作 — ${plan.reason}`, mustNotRepay: true, alreadyExecuted: true, transactionId: latest.transactionId };
  }
  return { action: plan.action, reason: plan.reason, mustNotRepay: !!plan.mustNotRepay, alreadyExecuted, transactionId: latest.transactionId };
}

export interface ResumeResult {
  ok: boolean;
  resumed: boolean;
  action: string;
  reason: string;
  mustNotRepay: boolean;
  card: ReportCard;
  text: string;
  goalId: string;
  runId?: string;
  transactionId?: string;
}

/** 按 `decideTaskRecovery` 的结论接着做 (CLI 与 Supervisor 共用同一条路径) */
export async function resumeTask(opts: { goalId: string; home?: string; cwd?: string; skillPaths?: string[]; input?: unknown; allowLocalDev?: boolean; walletKey?: string; onStage?: (s: TaskStage, n: string) => void }): Promise<ResumeResult> {
  const home = opts.home ?? os.homedir();
  const goal = await readGoal(opts.goalId);
  if (!goal) {
    const card = buildReportCard({ task: `(goal ${opts.goalId})`, executed: false, paid: false, conclusion: '证据不足', blocker: `找不到这个 Goal: ${opts.goalId}`, evidenceRef: { goalId: opts.goalId } });
    return { ok: false, resumed: false, action: 'closed', reason: 'goal 不存在', mustNotRepay: false, card, text: renderReportCard(card), goalId: opts.goalId };
  }
  const decision = await decideTaskRecovery({ goalId: opts.goalId, home });
  const base = { action: decision.action, reason: decision.reason, mustNotRepay: decision.mustNotRepay, goalId: opts.goalId, transactionId: decision.transactionId };

  const rec = decision.transactionId ? (await listTransactions(home)).find((t) => t.transactionId === decision.transactionId) : undefined;

  if (decision.action === 'complete') {
    const card = buildReportCard({
      task: goal.objective, conclusion: '已完成', executed: true, paid: true, lifecycle: rec?.status,
      outputContract: '通过', resourceVerified: '通过', evidenceComplete: true,
      payment: rec ? { mode: String(rec.paymentMode), chainSettled: rec.chainSettled === true, trust: String(rec.verificationTrust || '') } : undefined,
      evidenceRef: { goalId: opts.goalId, transactionId: decision.transactionId },
    });
    return { ...base, ok: true, resumed: false, card, text: renderReportCard(card) };
  }

  // 可自动继续的三类: 没付过(retry_payment) / 已付未交付(deliver) / 已交付待执行验真(verify)
  const continuable = ['retry_payment', 'deliver', 'verify'].includes(decision.action);
  if (!continuable) {
    const card = buildReportCard({
      task: goal.objective, executed: decision.alreadyExecuted, paid: true, conclusion: '证据不足',
      blocker: decision.alreadyExecuted
        ? `资源已经执行过, 但这次结果不达标 (${decision.reason}) → 需要你处理, 我没有重复执行也没有再花钱`
        : `这笔交易不能自动继续 (${decision.reason}) → 需要你处理, 我没有再花钱`,
      lifecycle: rec?.status, evidenceRef: { goalId: opts.goalId, transactionId: decision.transactionId },
    });
    return { ...base, ok: false, resumed: false, card, text: renderReportCard(card) };
  }

  // retry_payment / deliver / verify → 走同一条闭环 (requestId 派生确定 ⇒ 不会重复扣款)
  const r = await runTask({ task: goal.objective, home, cwd: opts.cwd, skillPaths: opts.skillPaths, input: opts.input, allowLocalDev: opts.allowLocalDev, walletKey: opts.walletKey, reuseGoalId: opts.goalId, onStage: opts.onStage });
  return { ...base, ok: r.ok, resumed: true, card: r.card, text: r.text, runId: r.runId, transactionId: r.transactionId || decision.transactionId };
}
