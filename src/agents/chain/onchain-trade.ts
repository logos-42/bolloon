/**
 * onchain-trade.ts — P4「任务交易闭环」: 把链上 escrow 真正接进任务链路
 * =========================================================================
 * 一条任务的链上闭环 (每一步的「链上到底成没成」都走 P3 的 verifyPaymentOnChain,
 * 本文件**不新写**任何链上判定):
 *
 *   buyer createEscrowV2  →  真执行(可执行 Skill)  →  seller submitProofV2  →  buyer releaseV2
 *        ↓                        ↓                           ↓                     ↓
 *   EscrowCreatedV2          resultHash =                 ProofSubmittedV2      ReleasedV2
 *   (托管已注资)              keccak256(utf8(              (结果已上链承诺)      (钱真到账 seller)
 *                            "sha256:<hex>"))
 *
 * 硬规则 (与 settlement-state.ts 的冻结口径逐条一致, 不许放宽):
 *   ① 只有 `chainSettled === true` (receipt.status==1 **且** 确认数达标 **且**
 *      事件 taskKey/resultHash 对得上 **且** 合约状态是期望值) 才允许把交易标 `verified`;
 *   ② `local-dev` 路径永远产生不了 `fully_settled` (写路径全走 settlement-state 的门);
 *   ③ 非法状态迁移**拒绝**并给出原因, 不静默修正;
 *   ④ `payment uncertain ≠ failed` (读不到 RPC → `unknown`, 保持未结算);
 *      `failed ≠ safe to retry` (明确回滚也只是"钱没动", 要不要重发由人决定);
 *   ⑤ 不自动重付、不静默标 verified、不静默关闭/退款。
 *
 * 重启恢复: 链上事实全在 `~/.bolloon/chain/chain-state.json` (P3 chain-state-store)。
 *   · `recoverOnchainTrade()`  纯读盘重建 → nextAction (不联网、不猜)
 *   · `resumeOnchainTrade()`   拿持久记录重新对账 (RPC 恢复后再判一次) 并安全继续
 */

import { createHash } from 'crypto';
import type { Signer } from 'ethers';
import {
  EscrowClient,
  computeTaskKeyOffChain,
  computeResultHashOffChain,
  computeProofHashOffChain,
  type TxOutcome,
  type EscrowStateName,
} from './escrow-client.js';
import {
  createChainSettlementVerifier,
  type ChainSettlementVerdict,
  type ChainSettlementExpect,
  type ChainSettlementStatus,
} from './chain-settlement.js';
import {
  sendChainTxGuarded,
  chainRequestIdOf,
  type ChainTxMethod,
  type ChainTxIntent,
} from './chain-wallet.js';
import {
  recordVerdict,
  loadChainState,
  chainStatePath,
  type ChainTxRecord,
} from './chain-state-store.js';
import { M1_BUDGET_LIMITS, resolveTaskBudget, checkPurchaseAllowed } from '../task/task-budget.js';
import { isPaymentMode, type PaymentMode } from '../task-contract.js';
import {
  evaluateVerifiedGate,
  canTransitionSettlement,
  checkLifecycleMove,
  type ExecutionEvidence,
} from '../x402/settlement-state.js';
import { readTransaction, updateTransaction } from '../x402/transaction-store.js';
import type { TransactionRecord } from '../x402/transaction-protocol.js';

// ── 摘要口径 (与 MODEL_FREEZE / AgentEscrow.computeResultHash 一致) ───────────

/** `sha256:<hex>` 摘要串 —— 链上 hash 的输入形态 */
export function sha256Digest(input: string | Buffer): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/** 摘要串 → 链上 bytes32 (keccak256(utf8("sha256:<hex>"))) */
export function chainHashOf(digest: string): string {
  return computeResultHashOffChain(digest);
}

/** 任务键 (链上幂等键): keccak256(abi.encode(bytes32("bolloon.task.v1"), taskId)) */
export function onchainTaskKey(taskId: string): string {
  return computeTaskKeyOffChain(taskId);
}

// ── 判定器注入 (缺省 = P3 的 verifyPaymentOnChain) ────────────────────────────

export type OnchainPaymentVerifier = (args: {
  txHash: string;
  chainSettlement?: {
    verifier?: (req: any) => Promise<ChainSettlementVerdict>;
    expect?: ChainSettlementExpect;
    gate?: 'confirmed' | 'finalized';
    recorded?: { blockNumber?: number | null; confirmations?: number; status?: string };
  };
}) => Promise<ChainSettlementVerdict>;

let cachedVerifyPaymentOnChain: OnchainPaymentVerifier | null = null;

/**
 * 链上验真的唯一入口 = P3 的 `verifyPaymentOnChain` (paid-info-store)。
 * 用**动态 import** 拿它: 避免 chain/ ↔ x402/ 的静态环, 也保证"判定只有一份"。
 */
async function defaultVerifyPaymentOnChain(): Promise<OnchainPaymentVerifier> {
  if (!cachedVerifyPaymentOnChain) {
    const mod: any = await import('../x402/paid-info-store.js');
    cachedVerifyPaymentOnChain = mod.verifyPaymentOnChain as OnchainPaymentVerifier;
  }
  return cachedVerifyPaymentOnChain;
}

// ── 预算硬约束 (M1) ─────────────────────────────────────────────────────────

export interface OnchainTradeBudget {
  taskBudget: number;
  perPurchase: number;
}

export interface OnchainBudgetDecision {
  ok: boolean;
  layer?: string;
  reason: string;
  amountUsdc: string;
  budget: OnchainTradeBudget;
  why: string[];
}

/** 原子单位 → 十进制 USDC 字符串 (不四舍五入到别的数, 只是位移) */
export function atomicToUsdc(amountAtomic: bigint, decimals: number): string {
  const s = amountAtomic.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * ★ M1 预算硬约束: 单任务 0.05 USDC / 单次购买 0.02 USDC (所有层取最小值)。
 * 超了 → 拒绝并**指明哪一层** (不静默改金额, 也不"就近取小")。
 */
export function checkOnchainAmount(opts: {
  amountAtomic: bigint;
  decimals: number;
  budget?: Partial<OnchainTradeBudget>;
}): OnchainBudgetDecision {
  const budget: OnchainTradeBudget = {
    taskBudget: opts.budget?.taskBudget ?? M1_BUDGET_LIMITS.task,
    perPurchase: opts.budget?.perPurchase ?? M1_BUDGET_LIMITS.perPurchase,
  };
  const parsed = resolveTaskBudget({ taskBudget: budget.taskBudget, perPurchase: budget.perPurchase });
  if (!parsed.ok || !parsed.plan) {
    return { ok: false, reason: `预算不合法: ${parsed.error}`, amountUsdc: '', budget, why: [] };
  }
  const plan = parsed.plan;
  const amountUsdc = atomicToUsdc(opts.amountAtomic, opts.decimals);
  const amount = Number(amountUsdc);
  const why = [...plan.why];
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, layer: 'amount', reason: `金额非法: ${amountUsdc}`, amountUsdc, budget, why };
  }
  const decision = checkPurchaseAllowed({ amount: amountUsdc, plan });
  if (!decision.allowed) {
    return { ok: false, layer: decision.layer, reason: decision.reason || '预算门拒绝', amountUsdc, budget, why };
  }
  why.push(`本次托管 ${amountUsdc} USDC ≤ 单次上限 ${plan.perPurchase} / 任务预算 ${plan.taskBudget} (M1 硬约束)`);
  return { ok: true, reason: `预算门通过: ${amountUsdc} USDC (M1 单次上限 ${M1_BUDGET_LIMITS.perPurchase})`, amountUsdc, budget, why };
}

// ── 请求 ────────────────────────────────────────────────────────────────────

export type OnchainStage = 'create' | 'execute' | 'proof' | 'release';

export interface OnchainTradeRequest {
  client: EscrowClient;
  /** 状态根目录 (chain-state.json / 交易记录都在它下面) */
  home: string;
  /** 任务标识 → taskKey */
  taskId: string;
  /** seller/agent 收款地址 */
  agentAddress: string;
  /** 托管金额 (原子单位) */
  amountAtomic: bigint;
  /** 支付资产地址 (USDC / MockERC20) */
  paymentAsset: string;
  /** 链下摘要 (sha256:<hex>); 上链前会包成 keccak256(utf8(...)) */
  termsDigest: string;
  quoteDigest: string;
  inputDigest: string;
  manifestDigest?: string;
  /** proofVersion (口径的一部分: proofHash = keccak256(abi.encode(tag, resultHash, version))) */
  proofVersion?: number;
  /** 托管截止时间 (unix 秒) */
  deadline: bigint | number;
  /** 确认窗口 (秒): 买方确认期, 过后卖方才能 claimAfterTimeout */
  confirmationWindow: number;
  budget?: Partial<OnchainTradeBudget>;
  /** 判定门槛 (缺省 confirmed=1) */
  gate?: 'confirmed' | 'finalized';
  network?: string;
  tokenDecimals?: number;
  /**
   * 授权意图: 支付模式 (调用方显式声明)。缺省沿用历史口径 `agent-authorized`。
   * ★ 它**只能收紧, 不可能放权**: 放行闸 `authorizeWalletSignature` 的 `modeIsAutonomous`
   *   只认 `autonomous` / `agent-authorized` —— 声明 `manual` / `policy` 会被闸直接拒。
   */
  paymentMode?: PaymentMode;
  /**
   * 授权意图: 调用方显式给的幂等/授权键。它参与放行闸 requestId 的**确定性派生**
   * (`chainRequestIdOf`), 于是「同一个声明只签一次」(重复 → `notDuplicate` 拒)。
   * 不给 = 沿用原派生 (老行为不变)。
   */
  intentNonce?: string;
  buyerSigner?: Signer;
  sellerSigner?: Signer;
  env?: NodeJS.ProcessEnv;
  /** 每次链上判定都落盘到 chain-state.json (缺省 true) */
  persistState?: boolean;
  /** 注入验真器 (测试); 缺省 = P3 verifyPaymentOnChain */
  verifyOnChain?: OnchainPaymentVerifier;
}

export interface OnchainStepResult {
  stage: OnchainStage;
  method: ChainTxMethod | null;
  /** 这一步的链上事实成立没成立 (拿 verifyPaymentOnChain 的结论) */
  ok: boolean;
  chainSettled: boolean;
  chainStatus: ChainSettlementStatus | null;
  txHash: string;
  blockNumber: number | null;
  gasUsed?: string | null;
  requestId: string | null;
  /** 放行闸 (chain-wallet) 是否放行 */
  authorized: boolean;
  authReason?: string;
  auditWritten?: boolean;
  verdict: ChainSettlementVerdict | null;
  escrowState: EscrowStateName | null;
  reason: string;
  /** 判定是否落了盘 (审计) */
  recorded: boolean;
  /** ★ 只有 release 全过才 true: 下游才有资格把交易标 verified */
  grantsVerified: boolean;
}

// ── 单步: 放行闸 → 真发交易 → verifyPaymentOnChain → 落盘 ────────────────────

function intentOf(req: OnchainTradeRequest, taskKey: string, method: ChainTxMethod, amountAtomic: string): ChainTxIntent {
  return {
    method,
    taskKey,
    amountAtomic,
    network: req.network || 'unknown',
    capability: 'chain.escrow',
    // 调用方显式声明才用它 (非法值不做任何解释, 直接退回历史口径 → 由放行闸判)
    mode: isPaymentMode(req.paymentMode) ? req.paymentMode : 'agent-authorized',
    taskId: req.taskId,
    ...(req.intentNonce ? { intentNonce: String(req.intentNonce) } : {}),
  };
}

function emptyStep(stage: OnchainStage, partial: Partial<OnchainStepResult> & { reason: string }): OnchainStepResult {
  return {
    stage, method: null, ok: false, chainSettled: false, chainStatus: null, txHash: '',
    blockNumber: null, requestId: null, authorized: false, verdict: null, escrowState: null,
    recorded: false, grantsVerified: false, ...partial,
  };
}

/** 用 P3 的 verifyPaymentOnChain 判一次 (本文件唯一的链上判定入口) */
async function judge(
  req: OnchainTradeRequest,
  taskKey: string,
  txHash: string,
  expect: ChainSettlementExpect,
  recorded?: { blockNumber?: number | null; confirmations?: number; status?: string },
): Promise<ChainSettlementVerdict> {
  const gate = req.gate || 'confirmed';
  const verify = req.verifyOnChain || (await defaultVerifyPaymentOnChain());
  return verify({
    txHash,
    chainSettlement: {
      verifier: createChainSettlementVerifier(req.client, { gate }),
      expect,
      gate,
      recorded,
    },
  });
}

/** 判定落盘 (P3 chain-state-store) */
async function persist(
  req: OnchainTradeRequest,
  method: ChainTxMethod,
  taskKey: string,
  txHash: string,
  amountAtomic: string,
  verdict: ChainSettlementVerdict,
): Promise<boolean> {
  if (req.persistState === false) return false;
  try {
    await recordVerdict(
      {
        requestId: chainRequestIdOf(intentOf(req, taskKey, method, amountAtomic), req.client.chainId),
        method,
        taskKey,
        escrowAddress: req.client.escrowAddress,
        chainId: Number(req.client.chainId ?? 0),
        txHash,
        resultHash: verdict.resultHash,
      },
      verdict,
      req.home,
    );
    return true;
  } catch {
    return false;
  }
}

/** 把 TxOutcome 的原始事实翻成一步结论 (没有 txHash = 交易根本没发出去) */
function outcomeFacts(outcome: TxOutcome | undefined): { txHash: string; blockNumber: number | null; gasUsed: string | null; broadcast: boolean; status: number | null; error?: string } {
  return {
    txHash: String(outcome?.txHash || ''),
    blockNumber: outcome?.blockNumber ?? null,
    gasUsed: outcome?.gasUsed ?? null,
    broadcast: outcome?.broadcast === true,
    status: outcome?.status ?? null,
    error: outcome?.error,
  };
}

/** buyer 侧: createEscrowV2 */
export async function createEscrowStep(req: OnchainTradeRequest): Promise<OnchainStepResult> {
  const taskKey = onchainTaskKey(req.taskId);
  const decimals = req.tokenDecimals ?? 6;
  const budget = checkOnchainAmount({ amountAtomic: req.amountAtomic, decimals, budget: req.budget });
  if (!budget.ok) {
    return emptyStep('create', { method: 'createEscrowV2', reason: `预算门拒绝 (${budget.layer || 'budget'}): ${budget.reason}` });
  }
  const amountAtomic = req.amountAtomic.toString();
  const intent = intentOf(req, taskKey, 'createEscrowV2', amountAtomic);
  const requestId = chainRequestIdOf(intent, req.client.chainId);
  const res = await sendChainTxGuarded<TxOutcome>({
    client: req.client,
    intent,
    home: req.home,
    env: req.env,
    signer: req.buyerSigner,
    execute: (signer) => req.client.createEscrowV2({
      taskKey,
      agent: req.agentAddress,
      amount: req.amountAtomic,
      paymentAsset: req.paymentAsset,
      termsHash: chainHashOf(req.termsDigest),
      quoteHash: chainHashOf(req.quoteDigest),
      inputHash: chainHashOf(req.inputDigest),
      manifestHash: chainHashOf(req.manifestDigest || req.inputDigest),
      deadline: req.deadline,
      confirmationWindow: req.confirmationWindow,
      proofVersion: req.proofVersion ?? 1,
    }, signer),
  });
  if (!res.allowed) {
    return emptyStep('create', { method: 'createEscrowV2', requestId, authorized: false, authReason: res.reason, reason: `签名放行闸拒绝: ${res.reason}` });
  }
  const f = outcomeFacts(res.outcome);
  if (!f.txHash) {
    return emptyStep('create', {
      method: 'createEscrowV2', requestId, authorized: true, auditWritten: res.auditWritten,
      reason: `createEscrowV2 没有发出去 (广播前失败): ${f.error || '无 txHash'}`,
    });
  }
  const verdict = await judge(req, taskKey, f.txHash, { kind: 'escrow', taskKey, eventName: 'EscrowCreatedV2' });
  const recorded = await persist(req, 'createEscrowV2', taskKey, f.txHash, amountAtomic, verdict);
  return {
    stage: 'create', method: 'createEscrowV2', ok: verdict.chainSettled, chainSettled: verdict.chainSettled,
    chainStatus: verdict.status, txHash: f.txHash, blockNumber: verdict.blockNumber ?? f.blockNumber,
    gasUsed: f.gasUsed, requestId, authorized: true, auditWritten: res.auditWritten,
    verdict, escrowState: verdict.escrowState ?? null,
    reason: verdict.reason, recorded, grantsVerified: false,
  };
}

/** seller 侧: submitProofV2 */
export async function submitProofStep(req: OnchainTradeRequest, resultDigest: string, manifestDigest?: string): Promise<OnchainStepResult> {
  const taskKey = onchainTaskKey(req.taskId);
  const resultHash = chainHashOf(resultDigest);
  const manifestHash = chainHashOf(manifestDigest || req.manifestDigest || req.inputDigest);
  const proofVersion = req.proofVersion ?? 1;
  const intent = intentOf(req, taskKey, 'submitProofV2', '0');
  const requestId = chainRequestIdOf(intent, req.client.chainId);
  const res = await sendChainTxGuarded<TxOutcome>({
    client: req.client,
    intent,
    home: req.home,
    env: req.env,
    signer: req.sellerSigner,
    execute: (signer) => req.client.submitProofV2(taskKey, resultHash, manifestHash, proofVersion, signer),
  });
  if (!res.allowed) {
    return emptyStep('proof', { method: 'submitProofV2', requestId, authorized: false, authReason: res.reason, reason: `签名放行闸拒绝: ${res.reason}` });
  }
  const f = outcomeFacts(res.outcome);
  if (!f.txHash) {
    return emptyStep('proof', {
      method: 'submitProofV2', requestId, authorized: true, auditWritten: res.auditWritten,
      reason: `submitProofV2 没有发出去 (广播前失败): ${f.error || '无 txHash'}`,
    });
  }
  // ★ 事件必须同时对上 taskKey + resultHash; 合约状态必须还是 ACTIVE (还没被释放)
  const verdict = await judge(req, taskKey, f.txHash, {
    kind: 'escrow', taskKey, resultHash, eventName: 'ProofSubmittedV2', expectEscrowState: 'ACTIVE',
  });
  const recorded = await persist(req, 'submitProofV2', taskKey, f.txHash, '0', verdict);
  return {
    stage: 'proof', method: 'submitProofV2', ok: verdict.chainSettled, chainSettled: verdict.chainSettled,
    chainStatus: verdict.status, txHash: f.txHash, blockNumber: verdict.blockNumber ?? f.blockNumber,
    gasUsed: f.gasUsed, requestId, authorized: true, auditWritten: res.auditWritten,
    verdict, escrowState: verdict.escrowState ?? null,
    reason: verdict.reason, recorded, grantsVerified: false,
  };
}

/** buyer 侧: releaseV2 —— 只有这一步全过才 `grantsVerified` */
export async function releaseStep(req: OnchainTradeRequest): Promise<OnchainStepResult> {
  const taskKey = onchainTaskKey(req.taskId);
  const intent = intentOf(req, taskKey, 'releaseV2', '0');
  const requestId = chainRequestIdOf(intent, req.client.chainId);
  const res = await sendChainTxGuarded<TxOutcome>({
    client: req.client,
    intent,
    home: req.home,
    env: req.env,
    signer: req.buyerSigner,
    execute: (signer) => req.client.releaseV2(taskKey, signer),
  });
  if (!res.allowed) {
    return emptyStep('release', { method: 'releaseV2', requestId, authorized: false, authReason: res.reason, reason: `签名放行闸拒绝: ${res.reason}` });
  }
  const f = outcomeFacts(res.outcome);
  if (!f.txHash) {
    return emptyStep('release', {
      method: 'releaseV2', requestId, authorized: true, auditWritten: res.auditWritten,
      reason: `releaseV2 没有发出去 (广播前失败): ${f.error || '无 txHash'}`,
    });
  }
  const verdict = await judge(req, taskKey, f.txHash, {
    kind: 'escrow', taskKey, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED',
  });
  const recorded = await persist(req, 'releaseV2', taskKey, f.txHash, '0', verdict);
  const grantsVerified = verdict.chainSettled === true
    && (verdict.status === 'confirmed' || verdict.status === 'finalized')
    && verdict.eventMatched === true
    && verdict.escrowState === 'RELEASED';
  return {
    stage: 'release', method: 'releaseV2', ok: verdict.chainSettled, chainSettled: verdict.chainSettled,
    chainStatus: verdict.status, txHash: f.txHash, blockNumber: verdict.blockNumber ?? f.blockNumber,
    gasUsed: f.gasUsed, requestId, authorized: true, auditWritten: res.auditWritten,
    verdict, escrowState: verdict.escrowState ?? null,
    reason: verdict.reason + (grantsVerified ? '; 事件/状态/确认数全过 → 才允许标 verified' : '; 未全过 → 不许标 verified'),
    recorded, grantsVerified,
  };
}

// ── 全闭环 ──────────────────────────────────────────────────────────────────

export interface OnchainTradeExecutor {
  /** 真执行任务 (可执行 Skill) → 产物摘要 `sha256:<hex>` */
  (): Promise<{ ok: boolean; resultDigest?: string; manifestDigest?: string; reason?: string }>;
}

export interface OnchainTradeLoopResult {
  ok: boolean;
  taskId: string;
  taskKey: string;
  amountAtomic: string;
  budget: OnchainTradeBudget;
  steps: OnchainStepResult[];
  create: OnchainStepResult | null;
  proof: OnchainStepResult | null;
  release: OnchainStepResult | null;
  execution: { ok: boolean; resultDigest?: string; reason?: string } | null;
  /** ★ 只有链上 release 成立 + 事件对上 + 合约 RELEASED 才 true */
  verified: boolean;
  verifiedReason: string;
  txHashes: { create?: string; proof?: string; release?: string };
  recovery: OnchainTradeRecovery;
}

/**
 * 走完整条链上闭环: create → 执行 → submitProof → release。
 *
 * 任何一步的链上事实不成立 → **原样停下**, 不执行下一步 (fail-closed);
 * 执行失败但托管已注资 → 如实报, 钱留在托管里, 不自动退款/不重付。
 */
export async function runOnchainTradeLoop(
  req: OnchainTradeRequest,
  execute: OnchainTradeExecutor,
): Promise<OnchainTradeLoopResult> {
  const taskKey = onchainTaskKey(req.taskId);
  const decimals = req.tokenDecimals ?? 6;
  const budgetCheck = checkOnchainAmount({ amountAtomic: req.amountAtomic, decimals, budget: req.budget });
  const budget: OnchainTradeBudget = {
    taskBudget: budgetCheck.budget.taskBudget,
    perPurchase: budgetCheck.budget.perPurchase,
  };
  const steps: OnchainStepResult[] = [];
  const finish = (opts: {
    ok: boolean; verified: boolean; reason: string;
    create: OnchainStepResult | null; proof: OnchainStepResult | null; release: OnchainStepResult | null;
    execution: OnchainTradeLoopResult['execution'];
  }): OnchainTradeLoopResult => {
    let recovery: OnchainTradeRecovery;
    try {
      recovery = recoverOnchainTrade({ home: req.home, taskKey });
    } catch (e: any) {
      recovery = blankRecovery(taskKey, req.home, `重建恢复状态失败: ${String(e?.message || e)}`);
    }
    return {
      ok: opts.ok, taskId: req.taskId, taskKey, amountAtomic: req.amountAtomic.toString(), budget,
      steps, create: opts.create, proof: opts.proof, release: opts.release, execution: opts.execution,
      verified: opts.verified, verifiedReason: opts.reason,
      txHashes: {
        ...(opts.create?.txHash ? { create: opts.create.txHash } : {}),
        ...(opts.proof?.txHash ? { proof: opts.proof.txHash } : {}),
        ...(opts.release?.txHash ? { release: opts.release.txHash } : {}),
      },
      recovery,
    };
  };

  if (!budgetCheck.ok) {
    return finish({ ok: false, verified: false, reason: `预算门拒绝 (${budgetCheck.layer || 'budget'}): ${budgetCheck.reason}`, create: null, proof: null, release: null, execution: null });
  }

  const create = await createEscrowStep(req);
  steps.push(create);
  if (!create.ok) {
    return finish({ ok: false, verified: false, reason: `createEscrowV2 未成立 → 不执行、不提交证明: ${create.reason}`, create, proof: null, release: null, execution: null });
  }

  const exec = await execute();
  if (!exec.ok || !exec.resultDigest) {
    return finish({
      ok: false, verified: false,
      reason: `托管已注资但执行失败 → 钱留在托管里, 不重付/不自动退款: ${exec.reason || '执行未产出结果'}`,
      create, proof: null, release: null,
      execution: { ok: false, resultDigest: exec.resultDigest, reason: exec.reason },
    });
  }

  const proof = await submitProofStep(req, exec.resultDigest, exec.manifestDigest);
  steps.push(proof);
  if (!proof.ok) {
    return finish({
      ok: false, verified: false,
      reason: `submitProofV2 未成立 → 不释放: ${proof.reason}`,
      create, proof, release: null,
      execution: { ok: true, resultDigest: exec.resultDigest },
    });
  }

  const release = await releaseStep(req);
  steps.push(release);
  const verified = release.grantsVerified === true;
  return finish({
    ok: verified, verified,
    reason: verified
      ? `链上闭环成立: create/proof/release 三笔都有 receipt.status=1 + 事件对得上 + 确认数达标 (${release.verdict?.status})`
      : `release 未全过 → 不标 verified: ${release.reason}`,
    create, proof, release,
    execution: { ok: true, resultDigest: exec.resultDigest },
  });
}

// ── 重启恢复 (纯读盘) ───────────────────────────────────────────────────────

export type OnchainNextAction =
  | 'create_escrow'   // 还没建托管 → 可以安全从头走
  | 'submit_proof'    // 托管在, 还没提交证明 (需要调用方提供执行产物摘要)
  | 'release'         // 证明已上链 → 可以安全释放 (钱已经在托管里, 不是第二次付款)
  | 'verify_only'     // 有交易但结论没定 (确认数不够 / RPC 读不到) → 只能再验, 不许重发
  | 'done'            // 链上已释放且可信
  | 'needs_human';    // 必须人工介入 (回滚 / 可疑 / 缺证据)

export interface OnchainTradeRecovery {
  found: boolean;
  taskId: string | null;
  taskKey: string;
  nextAction: OnchainNextAction;
  /** ★ 有支付证据 (托管/释放过) → 绝不重付 */
  mustNotRepay: boolean;
  /** 只有链上释放且未被标可疑才 true */
  verified: boolean;
  reason: string;
  create: ChainTxRecord | null;
  proof: ChainTxRecord | null;
  release: ChainTxRecord | null;
  /** 其它方法 (claim/dispute/refund) 的记录 —— 只报不处理 */
  others: ChainTxRecord[];
  records: ChainTxRecord[];
  statePath: string;
  /** 让它停下的证据 (审计) */
  blockedBy: string[];
  /** 执行产物摘要 (调用方给过才有) */
  pendingResultDigest?: string;
}

function blankRecovery(taskKey: string, home: string, reason: string): OnchainTradeRecovery {
  return {
    found: false, taskId: null, taskKey, nextAction: 'needs_human', mustNotRepay: false, verified: false,
    reason, create: null, proof: null, release: null, others: [], records: [],
    statePath: chainStatePath(home), blockedBy: [reason],
  };
}

export interface RecoverOnchainTradeOptions {
  home: string;
  taskId?: string;
  taskKey?: string;
  /** 执行产物摘要 (重启后由调用方从 Run/Goal 里读出来); 没有它 → 只能报待人工 */
  pendingResultDigest?: string;
  persistState?: boolean;
}

function settledRec(r: ChainTxRecord | null): boolean {
  return !!r && (r.status === 'confirmed' || r.status === 'finalized') && r.suspect !== true;
}

/**
 * ★ 重启后第一步: 纯读 `~/.bolloon/chain/chain-state.json` 重建状态, 给出下一步。
 * 不联网、不猜、不改任何记录。判定顺序即安全性顺序。
 */
export function recoverOnchainTrade(opts: RecoverOnchainTradeOptions): OnchainTradeRecovery {
  const taskKey = opts.taskKey || (opts.taskId ? onchainTaskKey(opts.taskId) : '');
  const statePath = chainStatePath(opts.home);
  if (!taskKey) return blankRecovery('', opts.home, '既没给 taskKey 也没给 taskId → 不知道要恢复哪条交易 (不猜)');
  const all = Object.values(loadChainState(opts.home).records).filter(
    (r) => String(r.taskKey).toLowerCase() === taskKey.toLowerCase(),
  );
  const by = (m: ChainTxMethod) => all.find((r) => r.method === m) || null;
  const create = by('createEscrowV2');
  const proof = by('submitProofV2');
  const release = by('releaseV2');
  const others = all.filter((r) => !['createEscrowV2', 'submitProofV2', 'releaseV2'].includes(r.method));
  const base = {
    found: all.length > 0, taskId: opts.taskId ?? null, taskKey, create, proof, release, others, records: all,
    statePath, pendingResultDigest: opts.pendingResultDigest,
  };
  const blockedBy: string[] = [];

  // 0) 从来没有链上交易 → 可以安全从头走 (没花过钱)
  if (!create) {
    return { ...base, nextAction: 'create_escrow', mustNotRepay: false, verified: false, blockedBy: [], reason: 'chain-state.json 里没有这笔任务的链上交易 → 可以安全从头走 (没有支付事实)' };
  }
  // 1) 任何一条被标可疑 (重组) → 人工介入, 绝不当已结算
  const suspectOne = all.find((r) => r.suspect === true);
  if (suspectOne) {
    blockedBy.push(`记录 ${suspectOne.requestId} 被标可疑: ${suspectOne.suspectReason || suspectOne.reason}`);
    return { ...base, nextAction: 'needs_human', mustNotRepay: true, verified: false, blockedBy, reason: `有链上记录被标不可信 (重组/事件消失) → 待人工: ${blockedBy[0]}` };
  }
  // 2) 托管创建明确回滚 → 钱没动, 但重发要人决定 (failed ≠ safe to retry)
  if (create.status === 'reverted') {
    blockedBy.push(`createEscrowV2 回滚 (receipt.status=0): ${create.reason}`);
    return { ...base, nextAction: 'needs_human', mustNotRepay: false, verified: false, blockedBy, reason: '托管创建回滚了 (钱没动) —— 回滚≠可以自动重发, 待人工确认后重走' };
  }
  // 3) 托管创建但结论没定 (确认数不够 / RPC 读不到) → 只能再验, 不许重发
  if (!settledRec(create)) {
    blockedBy.push(`createEscrowV2 状态=${create.status}: ${create.reason}`);
    return { ...base, nextAction: 'verify_only', mustNotRepay: true, verified: false, blockedBy, reason: `托管创建尚无确定结论 (${create.status}) —— 不确定≠失败, 先重新对账, 不许重发` };
  }
  // 4) 托管已确认 → 钱在链上托管里, 从这里开始都不许重付
  if (!proof) {
    if (opts.pendingResultDigest) {
      return { ...base, nextAction: 'submit_proof', mustNotRepay: true, verified: false, blockedBy: [], reason: '托管已确认, 且执行产物摘要在手 → 可以安全提交证明 (不会再付一次钱)' };
    }
    blockedBy.push('托管已注资但没有已上链的证明, 且拿不到执行产物摘要');
    return { ...base, nextAction: 'needs_human', mustNotRepay: true, verified: false, blockedBy, reason: '托管已注资 (EscrowCreatedV2 已确认) 但没有可提交的结果 → 钱留在托管里, 待人工处理 (不重付/不自动退款)' };
  }
  if (proof.status === 'reverted') {
    blockedBy.push(`submitProofV2 回滚: ${proof.reason}`);
    return { ...base, nextAction: 'needs_human', mustNotRepay: true, verified: false, blockedBy, reason: '证明提交回滚 (托管里的钱没动) —— 待人工决定是否重提' };
  }
  if (!settledRec(proof)) {
    blockedBy.push(`submitProofV2 状态=${proof.status}: ${proof.reason}`);
    return { ...base, nextAction: 'verify_only', mustNotRepay: true, verified: false, blockedBy, reason: `证明提交尚无确定结论 (${proof.status}) —— 先重新对账` };
  }
  if (!release) {
    return { ...base, nextAction: 'release', mustNotRepay: true, verified: false, blockedBy: [], reason: '证明已在链上确认 → 可以安全释放 (释放的是托管里的钱, 不是第二次付款)' };
  }
  if (release.status === 'reverted') {
    blockedBy.push(`releaseV2 回滚: ${release.reason}`);
    return { ...base, nextAction: 'needs_human', mustNotRepay: true, verified: false, blockedBy, reason: '释放交易回滚 (钱仍在托管) —— 待人工决定是否重发' };
  }
  if (!settledRec(release)) {
    blockedBy.push(`releaseV2 状态=${release.status}: ${release.reason}`);
    return { ...base, nextAction: 'verify_only', mustNotRepay: true, verified: false, blockedBy, reason: `释放尚无确定结论 (${release.status}) —— 不确定≠失败, 重新对账后才可能标 verified` };
  }
  const stateOk = release.escrowState === 'RELEASED';
  if (!stateOk) blockedBy.push(`合约状态=${release.escrowState ?? '(读不到)'}, 期望 RELEASED`);
  return {
    ...base,
    nextAction: stateOk ? 'done' : 'needs_human',
    mustNotRepay: true,
    verified: stateOk,
    blockedBy,
    reason: stateOk
      ? `链上释放已确认 (${release.status}, ${release.confirmations} 个确认), 合约状态 RELEASED → 可信`
      : `释放交易确认了但合约状态不是 RELEASED → 待人工核对`,
  };
}

// ── 重启后继续 (重新对账 + 安全推进) ────────────────────────────────────────

export interface ResumeOnchainTradeOptions extends OnchainTradeRequest {
  /** 执行产物摘要 (重启后如果已经执行过, 调用方从这里给) */
  pendingResultDigest?: string;
  pendingManifestDigest?: string;
  /** 只对账不推进 (只想看状态时用) */
  dryRun?: boolean;
}

export interface OnchainTradeResumeResult {
  recoveryBefore: OnchainTradeRecovery;
  reverified: Array<{ method: ChainTxMethod; txHash: string; status: ChainSettlementStatus; chainSettled: boolean; reason: string }>;
  steps: OnchainStepResult[];
  recovery: OnchainTradeRecovery;
  done: boolean;
  verified: boolean;
  reason: string;
}

/**
 * ★ 重启后继续: 拿 chain-state.json 里的旧事实**重新对账** (RPC 恢复后再判一次),
 * 然后只在"安全"的动作上推进 (submit_proof / release) —— 其它一律停下如实报。
 */
export async function resumeOnchainTrade(opts: ResumeOnchainTradeOptions): Promise<OnchainTradeResumeResult> {
  const taskKey = onchainTaskKey(opts.taskId);
  const recoveryBefore = recoverOnchainTrade({ home: opts.home, taskKey, taskId: opts.taskId, pendingResultDigest: opts.pendingResultDigest });
  const reverified: OnchainTradeResumeResult['reverified'] = [];
  const steps: OnchainStepResult[] = [];

  // ① 重新对账: 每条旧记录都拿 P3 判定重算一遍 (重组/掉 RPC 在这里暴露)
  //    注意 expect 的口径: create/proof 这两笔**历史**交易不再要求"合约当前状态是 ACTIVE" ——
  //    释放之后状态本来就变成 RELEASED 了, 拿今天的状态去否定昨天的事实会造出假 negative。
  //    只有 release 自己必须落在 RELEASED 上 (那是它的终态)。
  for (const rec of recoveryBefore.records) {
    if (!rec.txHash) continue;
    const expect: ChainSettlementExpect = rec.method === 'submitProofV2'
      ? { kind: 'escrow', taskKey, resultHash: rec.resultHash, eventName: 'ProofSubmittedV2' }
      : rec.method === 'releaseV2'
        ? { kind: 'escrow', taskKey, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED' }
        : { kind: 'escrow', taskKey, eventName: 'EscrowCreatedV2' };
    let verdict: ChainSettlementVerdict;
    try {
      verdict = await judge(opts, taskKey, rec.txHash, expect, {
        blockNumber: rec.blockNumber, confirmations: rec.confirmations, status: rec.status,
      });
    } catch (e: any) {
      verdict = {
        chainSettled: false, status: 'unknown',
        reason: `重新对账失败 (RPC?): ${String(e?.message || e).slice(0, 160)}`,
        txHash: rec.txHash, confirmationsRequired: 0, requiredGate: opts.gate || 'confirmed',
        rpcAvailable: false, checkedAt: Date.now(), evidence: {},
      };
    }
    await persist(opts, rec.method, taskKey, rec.txHash, rec.method === 'createEscrowV2' ? opts.amountAtomic.toString() : '0', verdict);
    reverified.push({ method: rec.method, txHash: rec.txHash, status: verdict.status, chainSettled: verdict.chainSettled, reason: verdict.reason });
  }

  let recovery = recoverOnchainTrade({ home: opts.home, taskKey, taskId: opts.taskId, pendingResultDigest: opts.pendingResultDigest });
  if (opts.dryRun) {
    return { recoveryBefore, reverified, steps, recovery, done: recovery.nextAction === 'done', verified: recovery.verified, reason: `(dry-run) ${recovery.reason}` };
  }

  // ② 只在安全动作上推进
  if (recovery.nextAction === 'submit_proof' && opts.pendingResultDigest) {
    const step = await submitProofStep(opts, opts.pendingResultDigest, opts.pendingManifestDigest);
    steps.push(step);
    recovery = recoverOnchainTrade({ home: opts.home, taskKey, taskId: opts.taskId, pendingResultDigest: opts.pendingResultDigest });
    if (!step.ok) {
      return { recoveryBefore, reverified, steps, recovery, done: false, verified: false, reason: `恢复中提交证明未成立 → 停在这里: ${step.reason}` };
    }
  }
  if (recovery.nextAction === 'release') {
    const step = await releaseStep(opts);
    steps.push(step);
    recovery = recoverOnchainTrade({ home: opts.home, taskKey, taskId: opts.taskId, pendingResultDigest: opts.pendingResultDigest });
    return {
      recoveryBefore, reverified, steps, recovery,
      done: recovery.nextAction === 'done', verified: recovery.verified,
      reason: step.ok ? '恢复流程已推进到链上释放成立' : `恢复中释放未成立: ${step.reason}`,
    };
  }
  return {
    recoveryBefore, reverified, steps, recovery,
    done: recovery.nextAction === 'done', verified: recovery.verified,
    reason: `nextAction=${recovery.nextAction}: ${recovery.reason}`,
  };
}

// ── 验真门: 链上事实 → 交易记录 (只有全过才 verified) ───────────────────────

export interface ChainVerifiedGateInput {
  rec: TransactionRecord;
  home: string;
  verdict: ChainSettlementVerdict;
  taskKey: string;
  execution?: ExecutionEvidence | null;
  goalCriteriaMet?: boolean;
  /** 目标结算事实 (缺省 fully_settled; 只有链上释放成立才允许) */
  targetFact?: 'payment_verified' | 'fully_settled';
}

export interface ChainVerifiedGateResult {
  verified: boolean;
  blockedBy: string[];
  reason: string;
  targetFact: 'payment_verified' | 'fully_settled';
  chainSettled: boolean;
}

/**
 * ★ 验真门 (纯判定, 不写盘)。
 * 只有 `chainSettled === true` + 事件对得上 + 合约 RELEASED + 八项门全过 → verified。
 * 任何一项不过都列出原因, 绝不"就近算过"。
 */
export function evaluateChainVerifiedGate(input: ChainVerifiedGateInput): ChainVerifiedGateResult {
  const { rec, verdict } = input;
  const blockedBy: string[] = [];
  const targetFact: 'payment_verified' | 'fully_settled' = input.targetFact === 'payment_verified' ? 'payment_verified' : 'fully_settled';

  if (verdict.chainSettled !== true) {
    blockedBy.push(`chainSettled !== true (status=${verdict.status}): ${verdict.reason}`);
    return { verified: false, blockedBy, reason: `链上没有确定结算 → 不许标 verified`, targetFact, chainSettled: false };
  }
  if (verdict.status !== 'confirmed' && verdict.status !== 'finalized') blockedBy.push(`判定状态是 ${verdict.status}, 不是 confirmed/finalized`);
  if (!verdict.txHash) blockedBy.push('判定里没有 txHash');
  if (verdict.eventMatched !== true) blockedBy.push('事件与 taskKey/resultHash 对不上 (eventMatched !== true)');
  if (verdict.escrowState !== 'RELEASED') blockedBy.push(`合约状态是 ${verdict.escrowState ?? '(读不到)'}, 期望 RELEASED`);
  if (verdict.confirmations == null || verdict.confirmations < verdict.confirmationsRequired) {
    blockedBy.push(`确认数 ${verdict.confirmations ?? '(未知)'} < 门槛 ${verdict.confirmationsRequired}`);
  }

  // 结算事实迁移必须合法 (local-dev 想写 fully_settled 会在这里被拒)
  const from = String(rec.settlementFact || 'unpaid');
  const factChk = canTransitionSettlement(from, targetFact, {
    paymentMode: rec.paymentMode, chainSettled: verdict.chainSettled, txHash: verdict.txHash,
  });
  if (!factChk.ok) blockedBy.push(`结算事实迁移被拒: ${factChk.reason}`);

  // 八项门 (chainSettled + protocolVerified + 正文在盘上 + 哈希对上 + 回执绑定 + 执行成功 + 输出合契约 + Goal 判据)
  const effective = { ...rec, chainSettled: true, txHash: verdict.txHash, settlementFact: targetFact } as TransactionRecord;
  const pre = checkLifecycleMove(effective, 'verified');
  if (!pre.ok) blockedBy.push(`生命周期迁移被拒: ${pre.reason}`);
  const gate = evaluateVerifiedGate({ rec: effective, home: input.home, execution: input.execution, goalCriteriaMet: input.goalCriteriaMet });
  if (!gate.verified) blockedBy.push(...gate.missing.map((m) => `八项门: ${m}`));

  if (blockedBy.length) {
    return { verified: false, blockedBy, reason: `未达 verified: ${blockedBy[0]}`, targetFact, chainSettled: true };
  }
  return {
    verified: true, blockedBy: [], targetFact, chainSettled: true,
    reason: `链上结算成立 (${verdict.status}, 确认数 ${verdict.confirmations}) + 事件/状态对上 + 八项门全过 → verified`,
  };
}

export interface ApplyChainSettlementOptions extends ChainVerifiedGateInput {
  /** 协议验真 (缺省沿用记录里的 protocolVerified) */
  protocolVerified?: boolean;
  /** 回执绑定: 链上释放交易的凭据 (缺省用 release txHash) */
  receipt?: string;
  /** 写 verified 时同时补的记录字段 (执行证据/资源结果/哈希等) */
  patch?: Partial<TransactionRecord>;
  /** 只判定不写盘 */
  dryRun?: boolean;
}

export interface ApplyChainSettlementResult {
  ok: boolean;
  verified: boolean;
  chainSettled: boolean;
  chainStatus: ChainSettlementStatus;
  settlementFact: string | null;
  status: string | null;
  blockedBy: string[];
  reason: string;
  events: string[];
  record: TransactionRecord | null;
}

/**
 * ★ 唯一把"链上判定"写进交易记录的地方。
 *   · chainSettled false → 只更新链上事实字段 (保持未结算; unknown 不改结算事实)
 *   · chainSettled true 且八项门全过 → 一次原子写: chainSettled + txHash + fully_settled + verified
 *   · 任何一条不过 → 只写能写的部分, 如实报原因 (不静默标 verified)
 */
export async function applyChainSettlementToTransaction(opts: ApplyChainSettlementOptions): Promise<ApplyChainSettlementResult> {
  const rec = await readTransaction(opts.rec.transactionId, opts.home);
  if (!rec) {
    return {
      ok: false, verified: false, chainSettled: opts.verdict.chainSettled, chainStatus: opts.verdict.status,
      settlementFact: null, status: null, blockedBy: ['交易记录不存在'], reason: `交易记录不存在: ${opts.rec.transactionId}`, events: [], record: null,
    };
  }
  const verdict = opts.verdict;
  const chainPatch: Partial<TransactionRecord> = {
    ...(verdict.txHash ? { txHash: verdict.txHash } : {}),
    chainSettled: verdict.chainSettled === true,
    ...(opts.protocolVerified === true ? { protocolVerified: true } : {}),
    ...(opts.receipt ? { receiptHash: `chain-receipt:${createHash('sha256').update(opts.receipt).digest('hex')}` } : {}),
    ...(opts.patch || {}),
  } as any;

  const judged = evaluateChainVerifiedGate({
    rec: { ...rec, ...chainPatch } as TransactionRecord,
    home: opts.home,
    verdict,
    taskKey: opts.taskKey,
    execution: opts.execution,
    goalCriteriaMet: opts.goalCriteriaMet,
    targetFact: opts.targetFact,
  });

  const events: string[] = [];

  // ① 链上没有确定结算 → 只写事实, 绝不 verified
  if (!verdict.chainSettled) {
    // 不确定 ≠ 失败: 只有明确"没发过/回滚"才把事实往回写, unknown 保持原值
    const factPatch: Partial<TransactionRecord> = {};
    if (verdict.status === 'reverted' || verdict.status === 'not_attempted') {
      const alreadyPaid = ['payment_submitted', 'payment_verified', 'partially_settled', 'fully_settled'].includes(String(rec.settlementFact || ''));
      if (!alreadyPaid && String(rec.settlementFact || '') !== 'unknown') factPatch.settlementFact = 'unknown';
    }
    if (opts.dryRun) {
      return {
        ok: false, verified: false, chainSettled: false, chainStatus: verdict.status,
        settlementFact: String(factPatch.settlementFact ?? rec.settlementFact ?? ''), status: String(rec.status),
        blockedBy: judged.blockedBy, reason: `(dry-run) ${judged.reason}`, events, record: rec,
      };
    }
    const saved = await updateTransaction(rec.transactionId, {
      ...chainPatch,
      ...factPatch,
      event: {
        kind: `chain:${verdict.status}`,
        detail: `链上判定 ${verdict.status} (确认数 ${verdict.confirmations ?? '未知'}/${verdict.confirmationsRequired}): ${verdict.reason}`,
      },
    } as any, opts.home);
    events.push(`chain:${verdict.status}`);
    if (factPatch.settlementFact) events.push(`settlement:${factPatch.settlementFact}`);
    return {
      ok: false, verified: false, chainSettled: false, chainStatus: verdict.status,
      settlementFact: String(saved?.settlementFact ?? factPatch.settlementFact ?? rec.settlementFact ?? ''),
      status: String(saved?.status ?? rec.status),
      blockedBy: judged.blockedBy, reason: judged.reason, events, record: saved,
    };
  }

  // ② 链上成立但门没过 → 只写链上事实 + 到 payment_verified, 不标 verified
  if (!judged.verified) {
    if (opts.dryRun) {
      return {
        ok: false, verified: false, chainSettled: true, chainStatus: verdict.status,
        settlementFact: String(rec.settlementFact ?? ''), status: String(rec.status),
        blockedBy: judged.blockedBy, reason: `(dry-run) ${judged.reason}`, events, record: rec,
      };
    }
    const fact = 'payment_verified' as any;
    const canUpgrade = canTransitionSettlement(String(rec.settlementFact || 'unpaid'), fact, {
      paymentMode: rec.paymentMode, chainSettled: true, txHash: verdict.txHash,
    }).ok && String(rec.settlementFact) !== fact;
    const saved = await updateTransaction(rec.transactionId, {
      ...chainPatch,
      ...(canUpgrade ? { settlementFact: fact } : {}),
      event: { kind: 'chain:settled_unverified', detail: `链上结算成立但未达 verified: ${judged.blockedBy[0]}` },
    } as any, opts.home);
    events.push('chain:settled_unverified');
    if (canUpgrade) events.push(`settlement:${fact}`);
    return {
      ok: false, verified: false, chainSettled: true, chainStatus: verdict.status,
      settlementFact: String(saved?.settlementFact ?? rec.settlementFact ?? ''), status: String(saved?.status ?? rec.status),
      blockedBy: judged.blockedBy, reason: judged.reason, events, record: saved,
    };
  }

  // ③ 全过 → 先写链上事实与结算事实, 再单独写 verified
  //   (transaction-store 的门要求: 记录里**已经**有 chainSettled=true 才允许迁到 verified ——
  //    所以这里刻意分两步写, 不把两件事塞进一次调用去绕门)
  if (opts.dryRun) {
    return {
      ok: true, verified: true, chainSettled: true, chainStatus: verdict.status,
      settlementFact: judged.targetFact, status: 'verified',
      blockedBy: [], reason: `(dry-run) ${judged.reason}`, events, record: rec,
    };
  }
  const withFacts = await updateTransaction(rec.transactionId, {
    ...chainPatch,
    settlementFact: judged.targetFact,
    verificationTrust: 'verified' as any,
    event: { kind: 'chain:settled', detail: judged.reason },
  } as any, opts.home);
  events.push('chain:settled', `settlement:${judged.targetFact}`);
  const saved = await updateTransaction(rec.transactionId, {
    status: 'verified',
    verifiedAt: new Date().toISOString(),
    event: { kind: 'status:verified', detail: `链上事实已在记录里 (txHash=${verdict.txHash}), 迁移到 verified` },
  } as any, opts.home);
  events.push('status:verified');
  return {
    ok: true, verified: true, chainSettled: true, chainStatus: verdict.status,
    settlementFact: String(saved?.settlementFact ?? withFacts?.settlementFact ?? judged.targetFact),
    status: String(saved?.status ?? 'verified'),
    blockedBy: [], reason: judged.reason, events, record: saved,
  };
}
