/**
 * task-onchain-runner.ts — P4: 把链上 escrow **接进任务链路**的任务级入口
 * =========================================================================
 * 与 `runTask()` (x402/local-dev 支付) 并列的一条任务链路 —— 区别只在钱的走法:
 *
 *   预算闸(M1) → 荐资源 → beginTransaction → [createEscrowV2 → 装+真跑技能 → submitProofV2 → releaseV2]
 *                                              ↑ 每一步都走 verifyPaymentOnChain
 *            → 验真门(只有 chainSettled=true 才 verified) → 报告卡
 *
 * 借用的都是任务侧既有件: task-budget / resource-advisor / installBundle /
 * executeContractSkill / resource-contract 保真校验 / report-card / transaction-store。
 * 不重写任何支付判定: 链上判定只有 P3 chain-settlement 一份, 钱的状态只有
 * settlement-state 一份, 链上事实只有 chain-state-store 一份。
 *
 * 三条硬规则 (与 runTask 一致):
 *   ① local-dev 永远到不了 fully_settled; ② chainSettled!==true 永远不 verified;
 *   ③ 非法迁移拒绝并给原因, 不静默修正。
 * 另加一条 (链上特有): 任何一步链上事实不成立 → 原样停下, **不重付/不自动退款**;
 * 重启时先读 chain-state.json 重建 (recoverOnchainTrade) 再决定续跑。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Signer } from 'ethers';
import { resolveTaskBudget, type TaskBudgetPlan } from './task-budget.js';
import { adviseResource } from './resource-advisor.js';
import { defaultRequestId, installBundle, deriveSkillInput, extractSources, extractConclusion } from './task-runner.js';
import { buildReportCard, renderReportCard, type ReportCard } from './report-card.js';
import {
  loadResourceContract, executeContractSkill, validateResourceOutput, validateResourceInput, verifyInstallFidelity,
} from '../x402/resource-contract.js';
import { beginTransaction, readTransaction, updateTransaction } from '../x402/transaction-store.js';
import { writeDeliveryContent } from '../x402/settlement-state.js';
import { computeContentHash, sha256Hex } from '../x402/paid-info-protocol.js';
import type { EscrowClient } from '../chain/escrow-client.js';
import {
  runOnchainTradeLoop, resumeOnchainTrade, recoverOnchainTrade, sha256Digest, checkOnchainAmount, onchainTaskKey,
  applyChainSettlementToTransaction, type OnchainPaymentVerifier, type OnchainTradeRecovery,
} from '../chain/onchain-trade.js';

export interface RunTaskOnchainOptions {
  task: string;
  home: string;
  budget?: string | number;
  perPurchase?: string | number;
  cwd?: string;
  skillPaths?: string[];
  // ── 链上依赖 (由调用方解析: 环境变量 → ~/.bolloon/chain.json → 报错, 见 chain-config) ──
  client: EscrowClient;
  agentAddress: string;
  paymentAsset: string;
  tokenDecimals?: number;
  buyerSigner?: Signer;
  sellerSigner?: Signer;
  deadline?: bigint | number;
  confirmationWindow?: number;
  proofVersion?: number;
  network?: string;
  env?: NodeJS.ProcessEnv;
  persistState?: boolean;
  verifyOnChain?: OnchainPaymentVerifier;
  /** 未定/读偏判定的有界重读 (公共 RPC 后端偶发旧值); 透传给链上交易链路 */
  settleRetryAttempts?: number;
  settleRetryDelayMs?: number;
  // ── 任务侧选项 ──
  buyerDid?: string;
  requestId?: string;
  input?: unknown;
  onStage?: (stage: string, note: string) => void;
  /** 重启续跑时若已执行过, 把执行产物摘要给它 → 才可能继续 submit_proof */
  pendingResultDigest?: string;
  /** 注入资源选择 (测试/离线); 缺省 = adviseResource() */
  choose?: () => Promise<{ name: string; version?: string; dir: string; contract?: any; why?: string[] } | null>;
}

export interface RunTaskOnchainResult {
  ok: boolean;
  taskKey: string;
  requestId: string;
  transactionId: string;
  card: ReportCard;
  text: string;
  skill?: { name: string; version?: string; dir: string };
  amountUsdc?: string;
  budget: TaskBudgetPlan | null;
  chain: {
    verified: boolean;
    reason: string;
    create?: string;
    proof?: string;
    release?: string;
    statuses: string[];
  };
  execution?: { ok: boolean; reason?: string };
  outputIssues: string[];
  recovery: OnchainTradeRecovery;
  stages: Array<{ stage: string; note: string; ms: number }>;
}

/**
 * 跑一条"链上托管"的任务: 买(托管) → 真执行 → 卖方上链承诺 → 买方释放 → 验真。
 */
export async function runTaskOnchain(opts: RunTaskOnchainOptions): Promise<RunTaskOnchainResult> {
  const stages: Array<{ stage: string; note: string; ms: number }> = [];
  let last = Date.now();
  const mark = (stage: string, note: string) => {
    const now = Date.now();
    stages.push({ stage, note, ms: now - last });
    last = now;
    opts.onStage?.(stage, note);
  };
  const decimals = opts.tokenDecimals ?? 6;
  const requestId = opts.requestId || defaultRequestId(opts.task, Number(opts.budget ?? 0.05));
  const taskId = requestId;                       // 任务键 = 幂等键 (重复跑同一任务不会新开托管)
  const taskKey = onchainTaskKey(taskId);
  const outputIssues: string[] = [];

  // ① 预算闸 (M1: 单任务 0.05 / 单次 0.02, 所有层取最小值; 非法 → 不记账不花钱)
  const parsed = resolveTaskBudget({ taskBudget: opts.budget, perPurchase: opts.perPurchase });
  if (!parsed.ok || !parsed.plan) {
    const card = buildReportCard({ task: opts.task, executed: false, paid: false, evidenceRef: {}, blocker: `预算不合法: ${parsed.error}` });
    mark('report', '预算非法 → 没有托管, 没有花钱');
    return {
      ok: false, taskKey, requestId, transactionId: '', card, text: renderReportCard(card), budget: null,
      chain: { verified: false, reason: '预算非法', statuses: [] }, outputIssues: [String(parsed.error)],
      recovery: recoverOnchainTrade({ home: opts.home, taskKey }), stages,
    };
  }
  const budget = parsed.plan;
  mark('prepare', `任务: ${opts.task} · 任务预算 ${budget.taskBudget} / 单次上限 ${budget.perPurchase} USDC`);

  // ② 荐资源 (用户不点名; 没有可执行资源就不买)
  let chosen = opts.choose ? await opts.choose() : null;
  if (!chosen && !opts.choose) {
    const advised = await adviseResource({ task: opts.task, home: opts.home, cwd: opts.cwd, skillPaths: opts.skillPaths });
    if (advised.needed && advised.chosen) {
      chosen = {
        name: advised.chosen.name, version: advised.chosen.version, dir: advised.chosen.dir,
        contract: advised.chosen.contract, why: advised.chosen.why,
      };
    } else {
      const card = buildReportCard({ task: opts.task, executed: false, paid: false, evidenceRef: {}, blocker: `没有可用的可执行资源: ${advised.reason}` });
      mark('report', '没有可执行资源 → 不买, 如实报告');
      return {
        ok: false, taskKey, requestId, transactionId: '', card, text: renderReportCard(card), budget,
        chain: { verified: false, reason: '没有可执行资源', statuses: [] }, outputIssues: [advised.reason],
        recovery: recoverOnchainTrade({ home: opts.home, taskKey }), stages,
      };
    }
  }
  if (!chosen) {
    const card = buildReportCard({ task: opts.task, executed: false, paid: false, evidenceRef: {}, blocker: '注入的资源选择器没有给出候选' });
    return {
      ok: false, taskKey, requestId, transactionId: '', card, text: renderReportCard(card), budget,
      chain: { verified: false, reason: '没有候选', statuses: [] }, outputIssues: ['没有候选'],
      recovery: recoverOnchainTrade({ home: opts.home, taskKey }), stages,
    };
  }
  mark('acquire', `选中 ${chosen.name} (${(chosen.why || []).slice(0, 2).join(' / ') || '名字匹配'})`);

  // ②.5 输入预检 (不花钱的前置门): 输入建不出来/不合 inputSchema → **绝不先注资**
  // 教训: 先注资再执行, 执行不达标 → 钱卡在托管里 (只能 dispute+refund 才拿得回)。
  // 契约的 inputSchema 在这里就能判, 所以把这道门放在任何链上写操作之前。
  const preContract = chosen.contract || (await loadResourceContract(chosen.dir)).contract;
  const preInput = opts.input ?? deriveSkillInput(preContract, opts.task);
  const preChk = preContract ? validateResourceInput(preContract, preInput) : { ok: true, issues: [] as string[] };
  if (!preChk.ok) {
    const blocker = `输入不符合 inputSchema (${preChk.issues[0] || '未知'}) → 未开托管, 没花钱`;
    const card = buildReportCard({ task: opts.task, executed: false, paid: false, evidenceRef: {}, blocker });
    mark('report', '输入不完整 → 不开托管, 不花钱 (给 --input 或把数字写进任务文本)');
    return {
      ok: false, taskKey, requestId, transactionId: '', card, text: renderReportCard(card), budget,
      skill: { name: chosen.name, version: chosen.version, dir: chosen.dir },
      chain: { verified: false, reason: blocker, statuses: [] }, outputIssues: [...preChk.issues, blocker],
      recovery: recoverOnchainTrade({ home: opts.home, taskKey }), stages,
    };
  }

  // ③ 金额 = 单次购买上限 (与 M1 硬约束一致); 转原子单位
  const amountAtomic = BigInt(Math.round(budget.perPurchase * 10 ** decimals));
  const amountChk = checkOnchainAmount({ amountAtomic, decimals, budget: { taskBudget: budget.taskBudget, perPurchase: budget.perPurchase } });
  if (!amountChk.ok) {
    const card = buildReportCard({ task: opts.task, executed: false, paid: false, evidenceRef: {}, blocker: `预算门拒绝 (${amountChk.layer}): ${amountChk.reason}` });
    return {
      ok: false, taskKey, requestId, transactionId: '', card, text: renderReportCard(card), budget,
      chain: { verified: false, reason: amountChk.reason, statuses: [] }, outputIssues: [amountChk.reason],
      recovery: recoverOnchainTrade({ home: opts.home, taskKey }), stages,
    };
  }

  // ④ 交易记录 (任务链路侧) —— 链上事实与它分开记, 最后一起进报告卡
  const { record: created } = await beginTransaction({
    requestId,
    metadata: { itemId: chosen.name, price: amountChk.amountUsdc, currency: 'USDC', network: opts.network || 'unknown', payTo: opts.agentAddress, providerDid: 'did:key:zLocalSeller' },
    buyerDid: opts.buyerDid || 'did:key:zTaskBuyer',
  }, opts.home);
  const transactionId = created.transactionId;
  if (created.status === 'discovered') await updateTransaction(transactionId, { status: 'quoted' } as any, opts.home);
  await updateTransaction(transactionId, {
    status: 'paying', paymentMode: 'escrow', settlementFact: 'payment_submitted', amount: amountChk.amountUsdc,
    event: { kind: 'escrow:intent', detail: `${amountChk.amountUsdc} USDC → escrow ${opts.client.escrowAddress}` },
  } as any, opts.home);

  const tradeReq: any = {
    client: opts.client, home: opts.home, taskId, agentAddress: opts.agentAddress,
    amountAtomic, paymentAsset: opts.paymentAsset,
    termsDigest: sha256Digest(`terms:${taskId}`), quoteDigest: sha256Digest(`quote:${taskId}`),
    inputDigest: sha256Digest(`input:${taskId}`), manifestDigest: sha256Digest(`manifest:${taskId}`),
    proofVersion: opts.proofVersion ?? 1,
    deadline: opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
    confirmationWindow: opts.confirmationWindow ?? 3600,
    budget: { taskBudget: budget.taskBudget, perPurchase: budget.perPurchase },
    network: opts.network || 'unknown', tokenDecimals: decimals,
    buyerSigner: opts.buyerSigner, sellerSigner: opts.sellerSigner,
    env: opts.env, persistState: opts.persistState, verifyOnChain: opts.verifyOnChain,
    settleRetryAttempts: opts.settleRetryAttempts, settleRetryDelayMs: opts.settleRetryDelayMs,
  };

  // ⑤ 幂等/恢复: 已经链上走过的任务**不新开托管** (先读盘重建)
  const before = recoverOnchainTrade({ home: opts.home, taskKey });
  let loopVerified = false, loopReason = '';
  const txHashes: { create?: string; proof?: string; release?: string } = {};
  const statuses: string[] = [];
  let execResult: { ok: boolean; reason?: string } | undefined;
  let resultDigest: string | undefined;
  let deliveredContent = '';
  let fidelity: { ok: boolean; issues?: string[] } = { ok: false };
  let outChk: { ok: boolean; issues?: string[] } = { ok: false };
  let conclusion = '';
  let sources: string[] = [];
  let contract: any = chosen.contract;

  /** 真执行 (装 + 跑 + 契约校验) —— 与 runTask 同一套件, 不下链 */
  const doExecute = async (): Promise<{ ok: boolean; resultDigest?: string; manifestDigest?: string; reason?: string }> => {
    const SHARE: any = await import('../skill-share.js');
    const collected = await SHARE.collectSkillBundle(chosen!.dir, { name: chosen!.name });
    if (!collected?.ok || !collected?.bundle) return { ok: false, reason: `技能打包失败: ${collected?.error || '未知'}` };
    deliveredContent = JSON.stringify(collected.bundle);
    const contentHash = computeContentHash(deliveredContent);
    const installDir = path.join(opts.home, '.bolloon', 'tasks', taskId, 'skills', chosen!.name);
    fs.mkdirSync(installDir, { recursive: true });
    const installed = installBundle(deliveredContent, installDir);
    fidelity = installed.ok ? await verifyInstallFidelity({ content: deliveredContent, rec: { contentHash }, installDir }) : { ok: false, issues: [installed.error!] };
    if (!installed.ok) { outputIssues.push(installed.error || '安装失败'); return { ok: false, reason: installed.error }; }
    const loaded = await loadResourceContract(installDir);
    if (loaded.ok && loaded.contract) contract = loaded.contract;
    const input = opts.input ?? deriveSkillInput(contract, opts.task);
    const exec = await executeContractSkill({ contract, skillDir: installDir, input, allowedTools: ['skill_exec', 'read_file'], allowCodeExecution: true });
    outChk = validateResourceOutput(contract, exec.output);
    sources = extractSources(exec.output);
    conclusion = extractConclusion(exec.output).conclusion || '';
    const execution = { ok: exec.execution.ok === true && outChk.ok === true, reason: exec.execution.reason };
    // 交易记录补执行证据
    await updateTransaction(transactionId, {
      execution: { ...(exec.execution as any), ok: exec.execution.ok === true, schemaOk: outChk.ok === true },
      resourceOutcome: { installed: fidelity.ok, executed: exec.execution.ok === true, outputContract: outChk.ok ? 'pass' : 'fail', criteriaHit: outChk.ok && sources.length > 0 && !!conclusion },
      event: { kind: 'resource_outcome', detail: `installed=${fidelity.ok} executed=${exec.execution.ok === true} contract=${outChk.ok ? 'pass' : 'fail'}` },
    } as any, opts.home);
    if (!execution.ok) outputIssues.push(...(outChk.issues || []), exec.execution.reason || '执行未达标');
    // ★ 链上结果承诺 = 我手上这份交付内容的摘要 (买方可以自己复算)
    return {
      ok: execution.ok,
      resultDigest: sha256Digest(deliveredContent),
      manifestDigest: sha256Digest(`manifest:${taskId}`),
      reason: execution.reason,
    };
  };

  if (!before.found) {
    const loop = await runOnchainTradeLoop(tradeReq, doExecute);
    txHashes.create = loop.txHashes.create; txHashes.proof = loop.txHashes.proof; txHashes.release = loop.txHashes.release;
    loopVerified = loop.verified; loopReason = loop.verifiedReason;
    execResult = loop.execution ? { ok: loop.execution.ok, reason: loop.execution.reason } : undefined;
    resultDigest = loop.execution?.resultDigest;
    for (const s of loop.steps) statuses.push(`${s.method}:${s.chainStatus}`);
    mark('acquire', loop.verified ? '链上闭环成立 (create/proof/release)' : `链上闭环未成立: ${loopReason.slice(0, 60)}`);
  } else {
    // 已有链上事实 → 只做安全续跑 (绝不重付)
    mark('acquire', `发现已有链上事实 (nextAction=${before.nextAction}) → 走恢复路径, 不新开托管`);
    const resumed = await resumeOnchainTrade({ ...tradeReq, pendingResultDigest: opts.pendingResultDigest });
    loopVerified = resumed.verified;
    loopReason = resumed.reason;
    for (const s of resumed.steps) statuses.push(`${s.method}:${s.chainStatus}`);
    txHashes.create = before.create?.txHash; txHashes.proof = before.proof?.txHash; txHashes.release = before.release?.txHash;
  }

  // ⑥ 验真门 + 报告卡
  const afterRecovery = recoverOnchainTrade({ home: opts.home, taskKey });
  const releaseRec = afterRecovery.release;
  const payment = {
    mode: 'escrow', chainSettled: loopVerified, trust: loopVerified ? 'verified' : 'self-attested',
    txHash: txHashes.release,
  };
  let gateVerified = false;
  let gateReason = loopReason;
  if (loopVerified && releaseRec?.txHash) {
    // 用**链上判定**重算一遍 (重放判定, 不新写判定逻辑): 释放记录 → 验真门
    const { verifyChainSettlement } = await import('../chain/chain-settlement.js');
    const verdict = await verifyChainSettlement(opts.client, {
      txHash: releaseRec.txHash,
      expect: { kind: 'escrow', taskKey, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED' },
      recorded: { blockNumber: releaseRec.blockNumber, confirmations: releaseRec.confirmations, status: releaseRec.status },
    });
    const recNow = await readTransaction(transactionId, opts.home);
    const delivered = deliveredContent || (() => { try { return fs.readFileSync(path.join(opts.home, '.bolloon', 'x402', 'deliveries', `${transactionId}.txt`), 'utf8'); } catch { return ''; } })();
    if (delivered) {
      const contentHash = computeContentHash(delivered);
      const wr = writeDeliveryContent(transactionId, delivered, opts.home);
      await updateTransaction(transactionId, {
        contentHash, deliveryHash: contentHash, deliveryBytesHash: wr.hash, protocolVerified: true,
        event: { kind: 'delivery_hash', detail: `deliveryHash=${contentHash.slice(0, 14)}… (与链上 resultHash 同源)` },
      } as any, opts.home);
    }
    const gated = await applyChainSettlementToTransaction({
      rec: (await readTransaction(transactionId, opts.home))!,
      home: opts.home, verdict, taskKey,
      execution: recNow?.execution as any,
      goalCriteriaMet: outChk.ok && sources.length > 0 && !!conclusion,
      receipt: `chain-release:${releaseRec.txHash}`,
    });
    gateVerified = gated.verified;
    gateReason = gated.verified ? gated.reason : `${gated.reason} (${gated.blockedBy.join(' | ')})`;
  } else if (!loopVerified) {
    gateReason = `${loopReason} —— 链上没确定结算 → 不标 verified`;
  }

  const evidenceComplete = fidelity.ok && (execResult?.ok === true) && outChk.ok && sources.length > 0 && !!conclusion && gateVerified;
  const card = buildReportCard({
    task: opts.task,
    conclusion: evidenceComplete ? (conclusion || '已完成') : '证据不足',
    conclusionDetail: evidenceComplete ? undefined : ((outChk.issues || [])[0] || loopReason.slice(0, 120)),
    skill: { name: chosen.name, version: chosen.version, dir: chosen.dir },
    cost: { amount: amountChk.amountUsdc, currency: 'USDC', network: opts.network || 'unknown' },
    payment,
    sources,
    outputContract: outChk.ok ? '通过' : '未通过',
    resourceVerified: fidelity.ok ? '通过' : '未通过',
    evidenceComplete,
    executed: execResult?.ok === true,
    paid: !!txHashes.create,
    stage: 'report',
    durationMs: stages.reduce((a, s) => a + s.ms, 0),
    evidenceRef: { transactionId },
    budgetLines: [...budget.why, ...amountChk.why],
    blocker: evidenceComplete ? undefined : (loopVerified ? (outChk.ok ? undefined : `输出不符合资源契约: ${(outChk.issues || [])[0] || '未知'}`) : `链上未成立: ${loopReason.slice(0, 140)}`),
  });
  mark('report', card.status);

  return {
    ok: card.status === '已完成',
    taskKey, requestId, transactionId, card, text: renderReportCard(card),
    skill: { name: chosen.name, version: chosen.version, dir: chosen.dir },
    amountUsdc: amountChk.amountUsdc, budget,
    chain: { verified: gateVerified, reason: gateReason, ...txHashes, statuses },
    execution: execResult,
    outputIssues,
    recovery: afterRecovery,
    stages,
  };
}
