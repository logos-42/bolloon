/**
 * chain-wallet.ts — 链上交易的**签名放行闸** (P3, ③)
 *
 * 硬规则:
 *   「链上交易签名走 `authorizeWalletSignature` 这个唯一放行闸 (fail-closed)
 *     + 写 `~/.bolloon/wallet-signatures.jsonl` 审计 (不记私钥、不记任务正文);
 *     未授权一律拒。」
 *
 * 所以这个文件里**没有第二条**"要不要签"的判断: 任何链上写操作都必须先过
 * `authorizeChainTransaction()`, 它内部只有 `task-contract.authorizeWalletSignature` 一个权威。
 * 未授权 → 不造 signer、不发交易、不写审计, 直接拒绝并说明哪一条没过。
 *
 * 三层授权来源 (与 CLI `bolloon wallet sign` 完全一致, 只是入口不同):
 *   ① `~/.bolloon/signing-policy.json` 的 `agentAuthorized: true`
 *   ② 环境变量 `BOLLOON_AGENT_AUTHORIZED=1`
 *   ③ (钱包本身) `BOLLOON_WALLET_PRIVATE_KEY` / `~/.bolloon/wallet.json`
 * 程序参数**只能收紧** (更小额度 / 白名单交集), 不能凭空授予。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Signer } from 'ethers';
import {
  authorizeWalletSignature,
  recordSignatureAudit,
  readSignatureAudit,
  isPaymentMode,
  type WalletSignDecision,
  type PaymentMode,
} from '../task-contract.js';
import { fingerprintOf, payloadDigest } from '../local-signer.js';
import { bolloonHome, walletAvailable, assertNotForeignWalletPath } from './chain-config.js';
import type { EscrowClient, TxOutcome } from './escrow-client.js';

/** 链上签名的能力名 (授权白名单里用这个) */
export const CHAIN_SIGN_CAPABILITY = 'chain.escrow';

export interface ChainSigningPolicy {
  agentAuthorized: boolean;
  allowedNetworks?: string[];
  allowedCapabilities?: string[];
  maxPerTxAtomic?: string;
  dailyLimitAtomic?: string;
  source: string;
  fileError?: string;
}

export function chainSigningPolicyPath(home?: string): string {
  return path.join(bolloonHome(home), 'signing-policy.json');
}

/**
 * 读本机签名授权策略 (语义与 `src/cli/commands/wallet.ts:readSigningPolicy` 一致;
 * 两处都必须只有这 ①② 两个授予源)。
 */
export function readChainSigningPolicy(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): ChainSigningPolicy {
  const env = opts.env || process.env;
  const envOn = String(env.BOLLOON_AGENT_AUTHORIZED || '') === '1';
  const out: ChainSigningPolicy = {
    agentAuthorized: envOn,
    source: envOn ? 'env BOLLOON_AGENT_AUTHORIZED=1' : 'default (未授权)',
  };
  const f = chainSigningPolicyPath(opts.home);
  assertNotForeignWalletPath(f);
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j?.agentAuthorized === true) { out.agentAuthorized = true; out.source = `${f} (agentAuthorized=true)`; }
      if (Array.isArray(j?.allowedNetworks)) out.allowedNetworks = j.allowedNetworks.map(String);
      if (Array.isArray(j?.allowedCapabilities)) out.allowedCapabilities = j.allowedCapabilities.map(String);
      if (typeof j?.maxPerTxAtomic === 'string') out.maxPerTxAtomic = j.maxPerTxAtomic;
      if (typeof j?.dailyLimitAtomic === 'string') out.dailyLimitAtomic = j.dailyLimitAtomic;
    }
  } catch (e: any) {
    out.fileError = String(e?.message || e).slice(0, 160);
  }
  return out;
}

const ATOMIC = /^[0-9]+$/;
const minAtomic = (a?: string, b?: string): string | undefined => {
  const okv = (v?: string) => !!v && ATOMIC.test(v);
  if (!okv(a)) return okv(b) ? b : undefined;
  if (!okv(b)) return a;
  return BigInt(a!) <= BigInt(b!) ? a : b;
};

export type ChainTxMethod =
  | 'createEscrowV2' | 'submitProofV2' | 'releaseV2' | 'claimAfterTimeoutV2' | 'disputeV2';

export interface ChainTxIntent {
  method: ChainTxMethod;
  /** 上链的任务键 (也是幂等键的主体) */
  taskKey: string;
  /** 金额 (原子单位)。只 createEscrowV2 有; 其它方法传 '0' */
  amountAtomic?: string;
  network?: string;
  capability?: string;
  mode?: PaymentMode;
  /** 同一意图需要多次签名时显式区分 (缺省 = 确定性幂等键, 同一意图只签一次) */
  intentNonce?: string;
  taskId?: string;
  /** 可收紧的额度 (程序参数) */
  maxPerTxAtomic?: string;
  dailyLimitAtomic?: string;
}

/** 意图 → 幂等 requestId (同一 method+taskKey+金额+链 = 同一个请求, 只签一次) */
export function chainRequestIdOf(intent: ChainTxIntent, chainId?: number): string {
  const basis = [intent.method, intent.taskKey.toLowerCase(), intent.amountAtomic || '0', chainId ?? '?', intent.intentNonce || ''].join('|');
  return `chaintx-${intent.method}-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}

export interface ChainAuthResult {
  allowed: boolean;
  requestId: string;
  reason?: string;
  checks: Record<string, boolean>;
  policy: ChainSigningPolicy;
  walletAvailable: boolean;
  walletSource: string;
  amountAtomic: string;
  network: string;
  capability: string;
  spentTodayAtomic: string;
  privateKeyTouched: false;
}

export interface AuthorizeChainTxOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  chainId?: number;
  /** 注入的审计 (测试); 缺省读 ~/.bolloon/wallet-signatures.jsonl */
  auditReader?: (home?: string, limit?: number) => Promise<Array<{ at: number; amountAtomic?: string; requestId: string }>>;
}

/**
 * ★ 链上签名的唯一放行判断 (fail-closed)。
 * 任何一条不满足 → `allowed: false` 且给出原因; 调用方**必须**原样停下。
 */
export async function authorizeChainTransaction(intent: ChainTxIntent, opts: AuthorizeChainTxOptions = {}): Promise<ChainAuthResult> {
  const policy = readChainSigningPolicy({ home: opts.home, env: opts.env });
  const mode: PaymentMode = isPaymentMode(intent.mode) ? intent.mode! : 'agent-authorized';
  const amountAtomic = String(intent.amountAtomic ?? '0');
  const network = String(intent.network || 'unknown');
  const capability = String(intent.capability || CHAIN_SIGN_CAPABILITY);

  const readAudit = opts.auditReader || readSignatureAudit;
  let audit: Array<{ at: number; amountAtomic?: string; requestId: string }> = [];
  try { audit = await readAudit(opts.home, 1000); } catch { audit = []; }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const spentTodayAtomic = audit
    .filter((a) => a.at >= dayStart.getTime())
    .reduce((acc, a) => acc + (ATOMIC.test(String(a.amountAtomic || '')) ? BigInt(String(a.amountAtomic)) : 0n), 0n)
    .toString();
  const signedRequestIds = audit.map((a) => a.requestId);

  const w = walletAvailable({ home: opts.home, env: opts.env });
  const requestId = chainRequestIdOf(intent, opts.chainId);

  const decision: WalletSignDecision = authorizeWalletSignature({
    mode,
    agentAuthorized: policy.agentAuthorized,
    amountAtomic,
    network,
    capability,
    requestId,
    signedRequestIds,
    allowedNetworks: policy.allowedNetworks,
    allowedCapabilities: policy.allowedCapabilities,
    maxPerTxAtomic: minAtomic(policy.maxPerTxAtomic, intent.maxPerTxAtomic),
    dailyLimitAtomic: minAtomic(policy.dailyLimitAtomic, intent.dailyLimitAtomic),
    spentTodayAtomic,
    walletAvailable: w.available,
  });

  return {
    allowed: decision.allowed,
    requestId,
    reason: decision.reason,
    checks: decision.checks,
    policy,
    walletAvailable: w.available,
    walletSource: w.source,
    amountAtomic, network, capability, spentTodayAtomic,
    privateKeyTouched: false,
  };
}

/** 审计 kind 映射 (schema 只有 4 种, 这里如实映射, 不新增字段) */
function auditKindOf(method: ChainTxMethod): 'task_payment' | 'task_result' | 'task_request' {
  if (method === 'submitProofV2') return 'task_result';
  if (method === 'disputeV2') return 'task_request';
  return 'task_payment'; // createEscrowV2 / releaseV2 / claimAfterTimeoutV2 都是钱的移动
}

export interface GatedSendResult<T> {
  allowed: boolean;
  reason?: string;
  auth: ChainAuthResult;
  /** 交易结果 (只有 allowed 且真发了才有) */
  outcome?: T;
  auditWritten: boolean;
  auditEntry?: Record<string, unknown>;
}

/**
 * ★ 受控发交易: 放行闸 → (只在这里) 取私钥造 signer → 执行 → 写审计。
 * 放行闸拒绝时: 不取私钥、不发交易、不写审计。
 *
 * `execute` 拿到的 signer 是唯一能用私钥的对象, 调用方不许把它带出作用域。
 */
export async function sendChainTxGuarded<T>(params: {
  client: EscrowClient;
  intent: ChainTxIntent;
  execute: (signer: Signer) => Promise<T>;
  /** 注入 signer (测试); 不给则用放行闸通过后从本机钱包造 */
  signer?: Signer;
  signerFactory?: (client: EscrowClient) => Signer;
  home?: string;
  env?: NodeJS.ProcessEnv;
  auditReader?: AuthorizeChainTxOptions['auditReader'];
  recordAudit?: typeof recordSignatureAudit;
}): Promise<GatedSendResult<T>> {
  const auth = await authorizeChainTransaction(params.intent, {
    home: params.home, env: params.env, chainId: params.client.chainId, auditReader: params.auditReader,
  });
  if (!auth.allowed) {
    return { allowed: false, reason: auth.reason, auth, auditWritten: false };
  }

  // ★ 只有走到这里才碰私钥 (局部变量, 不外泄)
  let signer: Signer;
  try {
    signer = params.signer
      || (params.signerFactory ? params.signerFactory(params.client) : params.client.localSigner({ home: params.home }));
  } catch (e: any) {
    return {
      allowed: false,
      reason: `放行闸过了但取不到本机钱包: ${String(e?.message || e).slice(0, 200)}`,
      auth, auditWritten: false,
    };
  }

  const outcome = await params.execute(signer);

  // 审计: 只记摘要 (意图摘要, 不含私钥 / 不含任务正文)
  const digest = payloadDigest(JSON.stringify({
    method: params.intent.method, taskKey: params.intent.taskKey, amountAtomic: auth.amountAtomic,
  }));
  const entry = {
    kind: auditKindOf(params.intent.method),
    mode: (isPaymentMode(params.intent.mode) ? params.intent.mode : 'agent-authorized') as PaymentMode,
    requestId: auth.requestId,
    taskId: params.intent.taskId,
    amountAtomic: auth.amountAtomic,
    currency: 'USDC',
    network: auth.network,
    capability: auth.capability,
    signerFingerprint: fingerprintOf(String(params.client.escrowAddress)),
    payloadDigest: digest,
  };
  let auditWritten = false;
  try {
    const rec = params.recordAudit || recordSignatureAudit;
    await rec(entry as any, params.home);
    auditWritten = true;
  } catch { auditWritten = false; }

  return { allowed: true, auth, outcome, auditWritten, auditEntry: entry };
}

/** 便捷包装: 让 4 个 v2 写方法都只能从放行闸过 */
export async function gatedEscrowWrite(
  client: EscrowClient,
  intent: ChainTxIntent,
  run: (signer: Signer) => Promise<TxOutcome>,
  opts: Parameters<typeof sendChainTxGuarded>[0] extends infer P ? Partial<Omit<P, 'client' | 'intent' | 'execute'>> : never = {},
): Promise<GatedSendResult<TxOutcome>> {
  return sendChainTxGuarded({ client, intent, execute: run, ...(opts as any) });
}
