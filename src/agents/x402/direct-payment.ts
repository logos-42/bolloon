/**
 * direct-payment.ts — x402 **去中心化直付**模式 (settlement mode = 'direct')
 *
 * 一句话: **买方自己发 USDC 到卖方地址, 把 txHash 交回; 卖方端点只读链核验** ——
 * 全程**不经过任何第三方托管 / facilitator / 平台账号**。钱从买方钱包直达 payTo。
 *
 * 为什么单开一个模块 (而不是塞进 paid-info-store 的 facilitator 分支):
 *   facilitator 模式是「我们(或别人)的 relayer 替买方发交易, 再拿回执」——
 *   链路里有一个**中间人**。direct 模式把中间人删掉了: 交易由买方签、买方发,
 *   服务器只是**一条链上事实的读者**。这两件事的钱动路径不同, 判定口径也不同:
 *     · facilitator: 判 facilitator 的回执 (它说成功才算)
 *     · direct:      判**链上原始事实** (receipt / Transfer 事件 / 确认数), 而且
 *                    **两条不同 RPC 各查一遍且一致**才算过 —— 单条 RPC 不构成事实。
 *
 * 硬规则 (与 chain-settlement.ts 同一口径, 但零 npm 依赖: 只走 JSON-RPC):
 *   ① chainId 必须与 item 的 network 对得上 (base = 8453)
 *   ② receipt 必须存在, 且 receipt.status == 1 (0 = 回滚, 钱没动)
 *   ③ 日志里必须有 **USDC 合约** 的 Transfer, 且 to == payTo (逐字节比地址), value >= accepts.amount
 *   ④ 确认数 >= 门槛 (缺省 2)
 *   ⑤ **两条不同 RPC** 都说 ok 且事实一致 (blockNumber/to/from/value 全一致) → 才算 verified
 *      任何一条 RPC 说"没这回事"→ 不一致 = 不确定 = **不通过** (fail-closed)
 *   ⑥ 同一 txHash 只能交付一次 (幂等台账, 落盘 0600); 同一个 txHash 拿去换**另一条**资源 → 拒
 *   ⑦ **订单标识 (EIP-3009 nonce, 约定 v1 标签 "BOL1")** —— 普通转账在链上**没有"买的是哪件"的痕迹**,
 *      所以如果这笔交易的日志里还有 `AuthorizationUsed(payer, nonce)` 且 nonce 按 v1 编了
 *      "本店 item + orderSeq"的哈希, 就**在同一笔交易里自证**了订单身份 (见 order-identity.ts)。
 *      没有该事件 / 哈希对不上本店 item → **如实降级为「直转(无订单标识)」**,
 *      **绝不假装自证** (降级不影响交付, 影响的是"这笔付款对应哪件东西"能不能被链上证明)。
 *      ★ 同一 (payer, nonce) 在 EIP-3009 里只能用一次 (链上 authorizationState 置位, 再用必 revert);
 *        台账另加一道 `NONCE_ALREADY_USED`: 同一个 (payer, nonce) 出现在**另一笔 txHash** 上 → 拒。
 *
 * 诚实边界 (不许美化):
 *   · 本模式**不退不追**: 买方发错金额/发错地址, 服务器只会拒 (钱在链上, 谁也拿不回来)。
 *   · 核验**不是托管**: 服务器没有私钥, 也不经手钱; 它只是"看链"。
 *   · 谁拿到 txHash 谁就能自己上链复核 —— 所以 direct 模式下的取件 token
 *     (由回执哈希派生) **买方自己能算出来**, 不提供保密性。这是设计使然, 不是缺陷:
 *     direct 模式里"付款事实"本来就是公开的。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { buildPaymentRequired, listInfo } from './paid-info-store.js';
import { resolvePaidDelivery, paidInfoRetrievePath } from './seller-signing.js';
// 复用既有哈希实现 (paid-info-protocol.js 已在服务器上, 且只依赖 node:crypto —— 不拖 ethers)
import { sha256Hex, type PaidInfoItem } from './paid-info-protocol.js';
// ★ 订单标识 (约定 v1, 标签 BOL1): 纯 TS 零依赖 (自带 keccak-256), 服务器上没有 node_modules 也能跑
import {
  orderIdentityFromLogs, computeOrderNonce, decodeOrderNonce,
  ORDER_IDENTITY_PROTOCOL, ORDER_NONCE_TAG, ORDER_NONCE_TAG_ASCII,
  EIP3009_AUTHORIZATION_USED_TOPIC0, EIP3009_TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  type OrderIdentity,
} from './order-identity.js';

// 让"卖方核验这一条路"只需 import 一个模块 (订单标识的实现留在 order-identity.ts, 单一实现)
export {
  ORDER_IDENTITY_PROTOCOL, ORDER_NONCE_TAG, ORDER_NONCE_TAG_ASCII,
  EIP3009_AUTHORIZATION_USED_TOPIC0, EIP3009_TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  computeOrderNonce, decodeOrderNonce, orderIdentityFromLogs,
};
export type { OrderIdentity };


export const DIRECT_PROTOCOL = 'bolloon-x402-direct/1';
/** 幂等台账 (txHash → 交付事实), 落盘 0600 */
export const DIRECT_TX_LEDGER_FILE = 'x402-direct-txs.json';

/**
 * ERC20 Transfer 事件 topic0。
 * ★ 与 chain-settlement.ts 的 ERC20_TRANSFER_TOPIC0 **必须一致** (测试里有等式断言)。
 * 这里抄一份常量而不是 import: chain-settlement.ts 顶层 import ethers, 而本模块要能
 * 在**没有 node_modules 的服务器**上跑 (ECS 只放编译产物) —— 顶层拖进 ethers 就起不来。
 */
export const ERC20_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** network 名 → chainId (核验必须比 chainId: 只认网络的"名字"等于没认) */
export const CHAIN_ID_BY_NETWORK: Record<string, number> = {
  base: 8453,
  'base-sepolia': 84532,
  mainnet: 1,
  sepolia: 11155111,
};

/**
 * 缺省两条 RPC —— **故意用两家**: 单条 RPC 说"钱到了"不构成事实。
 * base 这一对是**实测可达**的 (2026-09-28 从卖方端点所在的 ECS 与卖方本机各测一次,
 * eth_chainId 都回 0x2105=8453): mainnet.base.org + base.drpc.org。
 * 踩过的两个坑 (不是"应该能用", 是实测不能用):
 *   · base.llamarpc.com   → 两边都回 Cloudflare 525/HTML
 *   · base.publicnode.com → 免费档对稍旧的交易收据直接拒绝:
 *     `-32602 Archive requests require a personal token` ⇒ 当前能过、过几十个块就不行, 不能当缺省
 * base-sepolia 这一对**未实测** (本部署只用 base) —— 用到它之前必须先测, 不许想当然。
 */
export const DEFAULT_DIRECT_RPCS: Record<string, string[]> = {
  base: ['https://mainnet.base.org', 'https://base.drpc.org'],
  'base-sepolia': ['https://sepolia.base.org', 'https://base-sepolia.publicnode.com'],
};

/** 至少几条 RPC 一致才算过 (不可下调到 1: 那就退化成"信一家") */
export const DIRECT_MIN_RPCS = 2;
export const DEFAULT_DIRECT_CONFIRMATIONS = 2;
const DEFAULT_TIMEOUT_MS = 12_000;

// ────────────────────────────────────────────────────────────── 开关 / 配置

export function directPaymentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.BOLLOON_X402_DIRECT || '') === '1';
}

/** 这条 network 用哪几条 RPC (env 覆盖优先) */
export function directRpcUrls(network: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.BOLLOON_X402_DIRECT_RPCS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length) return raw;
  return DEFAULT_DIRECT_RPCS[network] || [];
}

export function directMinConfirmations(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BOLLOON_X402_DIRECT_CONFIRMATIONS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_DIRECT_CONFIRMATIONS;
}

/** 只留主机名 (RPC URL 里可能带 key, 不许进响应/日志) */
function rpcLabel(url: string): string {
  try { return new URL(url).host; } catch { return 'invalid-url'; }
}

// ────────────────────────────────────────────────────────────── JSON-RPC

async function rpcCall(
  url: string, method: string, params: unknown[],
  fetchImpl: typeof fetch, timeoutMs: number,
): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    if (j?.error) throw new Error(`RPC error: ${String(j.error?.message || 'unknown').slice(0, 120)}`);
    return j?.result;
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────── 单条 RPC 的核查

export type DirectRpcStatus =
  | 'confirmed'        // 事实成立 + 确认数够
  | 'finalized'        // 事实成立 + 确认数 >= 12
  | 'reverted'         // receipt.status = 0 (钱没动)
  | 'event_mismatch'   // 没有匹配的 USDC Transfer → 不是这笔付款
  | 'chain_mismatch'   // RPC 在别的链上
  | 'pending'          // 还没打包 / 确认数不够
  | 'unreachable';     // RPC 读不到 (不等于没付)

export interface DirectRpcCheck {
  /** 只记主机名: RPC URL 里可能带 key */
  rpc: string;
  ok: boolean;
  status: DirectRpcStatus;
  detail: string;
  chainId?: number;
  blockNumber?: number;
  confirmations?: number;
  latestBlock?: number;
  from?: string;
  to?: string;
  value?: string;
  /** ★ 订单标识 (约定 v1): 从**同一条交易**的日志里读出 (没有 AuthorizationUsed 就是降级那条) */
  orderIdentity?: OrderIdentity;
}

export interface DirectVerifyInput {
  txHash: string;
  network: string;
  chainId: number;
  /** 必须收钱的 token 合约 (USDC) */
  asset: string;
  /** 必须收钱的一方 (item.price.payTo) */
  to: string;
  /** 最小金额 (原子单位字符串) */
  minAmount: string;
  minConfirmations: number;
  rpcUrls: string[];
  /**
   * ★ 本店真实 item 的 id 列表 —— 订单标识自证要拿它**复算** nonce 里的哈希。
   *   缺省时调用方应传 `[item.id]`; 传全量可以额外区分"买的是本店别的 item"与"完全对不上"。
   */
  orderItemIds?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}


/** 取地址最后 20 字节 (去掉 0x + 32 字节 topic 的左填充) */
function topicToAddress(topic: string): string {
  const h = String(topic || '').replace(/^0x/, '').toLowerCase();
  return h.length >= 40 ? `0x${h.slice(-40)}` : '';
}

/** 一条 RPC 上把「这笔交易是不是我们要的付款」查到底 */
export async function checkOneRpc(input: DirectVerifyInput, rpcUrl: string): Promise<DirectRpcCheck> {
  const f = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = rpcLabel(rpcUrl);
  const base = { rpc: label, ok: false as const };

  let chainIdHex: string;
  let receipt: any;
  let latestHex: string;
  try {
    // chainId 必须对得上 —— RPC 可能在别的链上 (或被人指到了测试网)
    chainIdHex = await rpcCall(rpcUrl, 'eth_chainId', [], f, timeoutMs);
    const gotChain = Number(BigInt(chainIdHex));
    if (gotChain !== input.chainId) {
      return { ...base, status: 'chain_mismatch', chainId: gotChain, detail: `chainId=${gotChain} 与期望 ${input.chainId} 不一致 —— 换链了, 不能当这笔付款` };
    }
    receipt = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [input.txHash], f, timeoutMs);
    latestHex = await rpcCall(rpcUrl, 'eth_blockNumber', [], f, timeoutMs);
  } catch (e: any) {
    return { ...base, status: 'unreachable', detail: `RPC 读不到: ${String(e?.message || e).slice(0, 160)} (≠ 没付钱, 但也 ≠ 已付)` };
  }

  if (!receipt) {
    return { ...base, status: 'pending', detail: '链上还没有这个 txHash 的 receipt (没打包 / 或在内存池) —— 未结算' };
  }

  const blockNumber = Number(BigInt(receipt.blockNumber));
  const latestBlock = Number(BigInt(latestHex));
  const confirmations = latestBlock - blockNumber + 1;
  const logs: any[] = Array.isArray(receipt.logs) ? receipt.logs : [];

  // ★ 订单标识 (约定 v1): 只读日志。**先算出来再判交付** —— 这样连"付款没到/事件对不上"的
  //   响应里也能给出「这笔交易声明的订单身份是什么」, 排查时不用另开一轮。
  //   payerHint 留空: 此时还不知道 Transfer.from, 事件里的 authorizer 才是权威付款方。
  const orderIdentity = orderIdentityFromLogs(logs, {
    itemIds: input.orderItemIds || [],
    asset: String(input.asset),
  });

  if (Number(BigInt(receipt.status ?? '0x0')) !== 1) {
    return { ...base, status: 'reverted', blockNumber, confirmations, latestBlock, orderIdentity, detail: `receipt.status=0 (交易回滚) —— 钱没动` };
  }

  // 找 USDC 合约上、to == payTo、value >= 要求的 Transfer
  const wantAsset = String(input.asset).toLowerCase();
  const wantTo = String(input.to).toLowerCase();
  const minAmount = BigInt(input.minAmount);
  let transferLogs = 0;
  let matched: { from: string; to: string; value: bigint } | null = null;
  for (const l of logs) {
    if (String(l?.address || '').toLowerCase() !== wantAsset) continue;
    const topics: string[] = Array.isArray(l?.topics) ? l.topics : [];
    if (String(topics[0] || '').toLowerCase() !== ERC20_TRANSFER_TOPIC0) continue;
    transferLogs += 1;
    if (topics.length < 3) continue;
    const from = topicToAddress(topics[1]);
    const to = topicToAddress(topics[2]);
    let value = 0n;
    try { value = BigInt(String(l?.data || '0x0')); } catch { continue; }
    if (to === wantTo && value >= minAmount) matched = { from, to, value };
  }

  if (!matched) {
    return {
      ...base, status: 'event_mismatch', blockNumber, confirmations, latestBlock, orderIdentity,
      detail: `receipt 里 ${transferLogs} 条 ${label} USDC Transfer, 没有一条 to=${input.to} 且 value>=${input.minAmount} 的 —— 不是这笔付款`,
    };
  }

  // 付款方已知 ⇒ 用 Transfer.from 给订单标识补上 payer (事件里 authorizer 已是权威值, 这里只是兜底)
  const withPayer = orderIdentity.payer ? orderIdentity : { ...orderIdentity, payer: matched.from };

  const status: DirectRpcStatus = confirmations >= 12 ? 'finalized' : 'confirmed';
  if (confirmations < input.minConfirmations) {
    return {
      ...base, status: 'pending', blockNumber, confirmations, latestBlock, orderIdentity: withPayer,
      from: matched.from, to: matched.to, value: matched.value.toString(),
      detail: `付款事实成立但确认数 ${confirmations} < ${input.minConfirmations} —— 还没到可以判交付的程度`,
    };
  }
  return {
    rpc: label, ok: true, status, blockNumber, confirmations, latestBlock, orderIdentity: withPayer,
    from: matched.from, to: matched.to, value: matched.value.toString(),
    detail: `receipt.status=1, USDC Transfer to=${matched.to} value=${matched.value} 确认数 ${confirmations}`,
  };
}

// ────────────────────────────────────────────────────────────── 交叉核对

export interface DirectVerifyVerdict {
  ok: boolean;
  status:
    | 'confirmed' | 'finalized'
    | 'reverted' | 'event_mismatch' | 'chain_mismatch' | 'pending'
    | 'rpc_disagreement' | 'rpc_insufficient' | 'no_rpc_configured' | 'txhash_invalid';
  reason: string;
  txHash: string;
  network: string;
  chainId: number;
  asset: string;
  to: string;
  minAmount: string;
  minConfirmations: number;
  /** 交叉核对**通过**的 RPC (主机名, >= 2 条才算 ok) */
  verifiedBy: string[];
  /** 每一条 RPC 各自看到的 (审计用) */
  rpcChecks: DirectRpcCheck[];
  payer?: string;
  amount?: string;
  blockNumber?: number;
  confirmations?: number;
  /** ★ 订单标识 (约定 v1): 两条 RPC 一致时的那个。没带订单标识就是降级那条 */
  orderIdentity?: OrderIdentity;
  /** 两条 RPC 看到的 nonce 必须一致 (不一致 = 不敢判) */
  orderNonce?: string | null;
}

const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * ★ 直付核验的唯一入口。
 * 两条(以上)不同 RPC **各自独立**查一遍, 事实完全一致且都 ok 才算过。
 */
export async function verifyDirectTransfer(input: Omit<DirectVerifyInput, 'minConfirmations' | 'rpcUrls'> & {
  minConfirmations?: number; rpcUrls?: string[]; timeoutMs?: number;
}): Promise<DirectVerifyVerdict> {
  const txHash = String(input.txHash || '').trim();
  const minConfirmations = input.minConfirmations ?? DEFAULT_DIRECT_CONFIRMATIONS;
  const rpcUrls = input.rpcUrls ?? directRpcUrls(input.network);
  const shell = {
    txHash, network: input.network, chainId: input.chainId, asset: input.asset,
    to: input.to, minAmount: String(input.minAmount), minConfirmations,
    verifiedBy: [] as string[], rpcChecks: [] as DirectRpcCheck[],
  };
  if (!TXHASH_RE.test(txHash)) {
    return { ...shell, ok: false, status: 'txhash_invalid', reason: `txHash 形状不对 (要 0x + 64 hex): ${txHash.slice(0, 40)}` };
  }
  if (rpcUrls.length < DIRECT_MIN_RPCS) {
    return { ...shell, ok: false, status: 'no_rpc_configured', reason: `network=${input.network} 只配了 ${rpcUrls.length} 条 RPC, 少于要求的 ${DIRECT_MIN_RPCS} 条 —— 单条 RPC 不构成事实, 拒判` };
  }

  const checks = await Promise.all(rpcUrls.map((u) => checkOneRpc({ ...input, minConfirmations, rpcUrls } as DirectVerifyInput, u)));
  const ok = checks.filter((c) => c.ok);
  const negative = checks.filter((c) => !c.ok && (c.status === 'reverted' || c.status === 'event_mismatch' || c.status === 'chain_mismatch'));
  // ★ 订单标识也从各条 RPC 的核查结果上带出来 (任一分支都带上; 没有则 undefined) ——
  //   这样"付款没到/事件对不上"的 402 里也能给出"这笔交易声明的订单身份", 排查不用另开一轮
  const verdict = { ...shell, rpcChecks: checks, orderIdentity: checks.find((c) => c.orderIdentity)?.orderIdentity };

  // ① 两条以上都 ok → 还要事实**完全一致** (比 blockNumber/from/to/value + ★ 订单 nonce)
  if (ok.length >= DIRECT_MIN_RPCS) {
    const first = ok[0];
    const disagree = ok.find((c) =>
      c.blockNumber !== first.blockNumber || c.from !== first.from || c.to !== first.to || c.value !== first.value
      // ★ 订单标识也要一致: 一条 RPC 看到 AuthorizationUsed 另一条没看到 ⇒ 不确定, 不许挑好的信
      || (c.orderIdentity?.nonce || null) !== (first.orderIdentity?.nonce || null)
      || (c.orderIdentity?.mode || null) !== (first.orderIdentity?.mode || null));
    if (disagree) {
      return {
        ...verdict, ok: false, status: 'rpc_disagreement',
        reason: `RPC 之间事实不一致 (${first.rpc}: 块 ${first.blockNumber}/value ${first.value} vs ${disagree.rpc}: 块 ${disagree.blockNumber}/value ${disagree.value}) —— 不敢判交付`,
      };
    }
    return {
      ...verdict, ok: true, status: first.status === 'finalized' ? 'finalized' : 'confirmed',
      reason: `两条 RPC 一致: receipt.status=1, USDC Transfer to=${first.to} value=${first.value}, 确认数 ${first.confirmations} >= ${minConfirmations}; 订单标识=${first.orderIdentity?.mode || 'unknown'}`,
      verifiedBy: ok.map((c) => c.rpc),
      payer: first.from, amount: first.value, blockNumber: first.blockNumber, confirmations: first.confirmations,
      orderIdentity: first.orderIdentity, orderNonce: first.orderIdentity?.nonce ?? null,
    };
  }

  // ② 只有一条 ok → 另一条不同意/读不到 = 不一致 (fail-closed, 绝不用单条 RPC 交付)
  if (ok.length > 0) {
    const failed = checks.filter((c) => !c.ok);
    return {
      ...verdict, ok: false, status: 'rpc_disagreement',
      reason: `只有 ${ok.length} 条 RPC 认这笔付款 (${ok.map((c) => c.rpc).join(', ')}), ${failed.map((c) => `${c.rpc}:${c.status}`).join(', ')} —— 不一致 = 不确定, 不交付`,
    };
  }

  // ③ 全部否: 两条以上给出同一个**确定性否定** (回滚/事件对不上/换链) 才敢下这个结论
  if (negative.length >= DIRECT_MIN_RPCS) {
    const first = negative[0];
    return {
      ...verdict, ok: false, status: first.status as 'reverted' | 'event_mismatch' | 'chain_mismatch',
      reason: `${negative.length} 条 RPC 一致否定 (${negative.map((c) => `${c.rpc}:${c.status}`).join(', ')}): ${first.detail}`,
    };
  }
  if (negative.length > 0) {
    return {
      ...verdict, ok: false, status: 'rpc_disagreement',
      reason: `RPC 结论不一致 (${checks.map((c) => `${c.rpc}:${c.status}`).join(', ')}) —— 不确定, 不交付`,
    };
  }
  // ④ 全部说"还没到" (还没打包 / 确认数不够) 且至少两条这么说 → pending (明确的"未结算", 不是"不知道")
  const pendingChecks = checks.filter((c) => c.status === 'pending');
  if (pendingChecks.length >= DIRECT_MIN_RPCS) {
    return {
      ...verdict, ok: false, status: 'pending',
      reason: `${pendingChecks.length} 条 RPC 一致: ${pendingChecks[0].detail}`,
    };
  }
  return {
    ...verdict, ok: false, status: 'rpc_insufficient',
    reason: `没有任何两条 RPC 能确认这笔付款 (${checks.map((c) => `${c.rpc}:${c.status}`).join(', ')})`,
  };
}

// ────────────────────────────────────────────────────────────── 幂等台账 (同一 txHash 只交付一次)

export interface DirectTxRecord {
  txHash: string;
  itemId: string;
  network: string;
  chainId: number;
  asset: string;
  to: string;
  from: string;
  amount: string;
  blockNumber: number;
  confirmations: number;
  verifiedBy: string[];
  /** ★ 首次核验通过的时间 (第二次提交同一 txHash 会**复用**它 ⇒ 回执逐字相同 ⇒ 同一条待办) */
  settledAt: string;
  receiptHash: string;
  /**
   * ★ 订单标识 (约定 v1)。**有才有**: 老台账 / 普通转账没有这个键 (读法必须容忍 undefined)。
   *   有了它, "谁付·多少·给谁"之外还能在链上自证"买的是哪件"。
   */
  orderIdentity?: OrderIdentity;
}

export interface DirectClaimResult {
  ok: boolean;
  code?: 'TXHASH_ALREADY_USED' | 'NONCE_ALREADY_USED';
  detail?: string;
  record?: DirectTxRecord;
  /** true = 这个 txHash 之前就交付过 (幂等命中, 不是新交付) */
  reused?: boolean;
}

export function directTxLedgerPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', DIRECT_TX_LEDGER_FILE);
}

export class DirectTxLedger {
  private readonly file: string;
  private txs: Record<string, DirectTxRecord> = {};
  private loaded = false;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(file: string) { this.file = file; }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      if (parsed?.txs && typeof parsed.txs === 'object') this.txs = parsed.txs;
    } catch { /* 首次运行没有台账 = 空台账 */ }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify({ protocol: DIRECT_PROTOCOL, txs: this.txs }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch(() => undefined);
    await this.writeChain;
  }

  async get(txHash: string): Promise<DirectTxRecord | null> {
    await this.ensureLoaded();
    return this.txs[String(txHash).toLowerCase()] || null;
  }

  /**
   * 认领一笔交付事实。
   *   · 同 txHash + 同 itemId  → 幂等命中 (复用首次时间 ⇒ 回执哈希稳定 ⇒ 同一条待办, 不产生第二条)
   *   · 同 txHash + 别的 itemId → **拒** (拿一笔付款去换另一条资源 = 跨资源复用)
   *   · 同一 (payer, nonce) 出现在**另一笔 txHash** → **拒** (EIP-3009 里 (payer,nonce) 只能用一次;
   *     链上第二笔本来就必 revert, 能走到这里说明有人在换 txHash 蹭同一份授权 —— 不能认)
   */
  async claim(input: {
    txHash: string; itemId: string; network: string; chainId: number; asset: string;
    to: string; from: string; amount: string; blockNumber: number; confirmations: number;
    verifiedBy: string[]; receiptHash: string; settledAt?: string; now?: number;
    orderIdentity?: OrderIdentity;
  }): Promise<DirectClaimResult> {
    await this.ensureLoaded();
    const key = String(input.txHash).toLowerCase();
    const existing = this.txs[key];
    if (existing) {
      if (existing.itemId !== input.itemId) {
        return {
          ok: false, code: 'TXHASH_ALREADY_USED',
          detail: `这笔交易 (${key.slice(0, 18)}…) 已经用来交付过 ${existing.itemId} —— 同一笔付款不能换别的资源`,
        };
      }
      return { ok: true, record: existing, reused: true };
    }
    // ★ (payer, nonce) 唯一性: 与**别的 txHash** 撞同一个 nonce = 重放/换 txHash 蹭授权, 拒
    const nonce = input.orderIdentity?.nonce || '';
    if (nonce) {
      const payer = String(input.orderIdentity?.payer || input.from || '').toLowerCase();
      for (const [otherKey, other] of Object.entries(this.txs)) {
        if (otherKey === key) continue;
        const otherNonce = other.orderIdentity?.nonce || '';
        if (!otherNonce || otherNonce !== nonce) continue;
        const otherPayer = String(other.orderIdentity?.payer || other.from || '').toLowerCase();
        if (otherPayer !== payer) continue;
        return {
          ok: false, code: 'NONCE_ALREADY_USED',
          detail: `同一个 (payer=${payer}, nonce=${nonce.slice(0, 18)}…) 已经用在另一笔交易 ${otherKey.slice(0, 18)}… 上 —— EIP-3009 的 (payer, nonce) 只能用一次, 重复用链上必 revert`,
        };
      }
    }
    const record: DirectTxRecord = {
      txHash: key, itemId: input.itemId, network: input.network, chainId: input.chainId,
      asset: input.asset, to: input.to, from: input.from, amount: input.amount,
      blockNumber: input.blockNumber, confirmations: input.confirmations,
      verifiedBy: input.verifiedBy,
      settledAt: input.settledAt || new Date(input.now ?? Date.now()).toISOString(),
      receiptHash: input.receiptHash,
      // 没有订单标识时不写这个键 (老记录回执逐字不变)
      ...(input.orderIdentity ? { orderIdentity: input.orderIdentity } : {}),
    };
    this.txs[key] = record;
    await this.persist();
    return { ok: true, record, reused: false };
  }
}

/**
 * 直付回执 (**确定性**: 同一个 txHash 永远得到同一串字节 ⇒ 同一 receiptHash ⇒ 同一 pendingId)。
 * 键序固定 (不能用 canonicalize 之外的随机顺序); settledAt 取台账首见时间, 不是"现在"。
 */
export function buildDirectReceipt(record: DirectTxRecord): string {
  const obj = {
    protocol: DIRECT_PROTOCOL,
    mode: 'direct',
    success: true,
    network: record.network,
    chainId: record.chainId,
    txHash: record.txHash,
    payer: record.from,
    payTo: record.to,
    asset: record.asset,
    amount: record.amount,
    blockNumber: record.blockNumber,
    confirmations: record.confirmations,
    verifiedBy: [...record.verifiedBy].sort(),
    settledAt: record.settledAt,
    custody: 'none',
    note: '买方直付: 买方自己在钱包里发 USDC 到 payTo, 卖方端点按 txHash 读链核验 (两条 RPC 交叉); 不经过任何第三方托管/facilitator',
    // ★ 订单标识 (约定 v1): **只有带上时才写这个键** —— 普通转账/老记录的回执逐字不变
    //   (键序固定, 键在最后 ⇒ 旧台账重算回执得到的是同一串字节 ⇒ 同一 receiptHash ⇒ 同一 pendingId)
    ...(record.orderIdentity ? {
      orderIdentity: {
        protocol: record.orderIdentity.protocol,
        selfAttested: record.orderIdentity.selfAttested,
        mode: record.orderIdentity.mode,
        nonce: record.orderIdentity.nonce,
        orderSeq: record.orderIdentity.orderSeq,
        itemIdHash: record.orderIdentity.itemIdHash,
        // 自证命中的本店 item (排序: 台账/回执要可复现)
        items: [...record.orderIdentity.matchedItemIds].sort(),
        note: record.orderIdentity.selfAttested
          ? '订单自证: nonce 按约定 v1 (标签 BOL1) 编入 keccak256(itemId‖orderSeq), 卖方用本店 item 复算哈希一致'
          : '未自证 (如实降级): 该交易没有带本店可复算的 BOL1 订单标识 —— 只有「谁付·多少·给谁」',
      },
    } : {}),
  };
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

// ────────────────────────────────────────────────────────────── 结算: 核验 → 认领 → 回执

export interface DirectSettleResult {
  ok: boolean;
  code?:
    | 'DIRECT_MODE_DISABLED' | 'ITEM_PRICE_UNSUPPORTED' | 'DIRECT_PAYMENT_NOT_VERIFIED'
    | 'TXHASH_ALREADY_USED' | 'NONCE_ALREADY_USED' | 'TXHASH_INVALID';
  detail: string;
  mode: 'direct';
  receipt?: string;
  txHash?: string;
  payer?: string;
  network: string;
  amount: string;
  currency: string;
  confirmations?: number;
  blockNumber?: number;
  verifiedBy?: string[];
  reused?: boolean;
  verdict?: DirectVerifyVerdict;
  /** ★ 订单标识 (约定 v1): 「这笔付款对应哪件东西」能不能被链上证明 —— 不能就如实降级 */
  orderIdentity?: OrderIdentity;
  /** true = 订单自证成功 (只有这一种情况才算) */
  orderIdentitySelfAttested?: boolean;
}

export interface DirectSettleOptions {
  item: PaidInfoItem;
  txHash: string;
  home?: string;
  resourceUrl?: string;
  fetchImpl?: typeof fetch;
  rpcUrls?: string[];
  minConfirmations?: number;
  timeoutMs?: number;
  ledger?: DirectTxLedger;
  now?: number;
  /** ★ 本店真实 item id 列表 (订单标识自证拿它复算哈希); 缺省 = [item.id] */
  orderItemIds?: string[];
  /** 测试用: 绕过 env 开关 (生产代码不传) */
  allowDisabled?: boolean;
}

export async function settleDirectPayment(opts: DirectSettleOptions): Promise<DirectSettleResult> {
  const item = opts.item;
  const home = opts.home ?? os.homedir();
  const network = String(item.price?.network || 'base');
  const currency = String(item.price?.currency || 'USDC');
  const shell = { mode: 'direct' as const, network, amount: String(item.price?.amount ?? '0'), currency };

  if (!opts.allowDisabled && !directPaymentEnabled()) {
    return { ...shell, ok: false, code: 'DIRECT_MODE_DISABLED', detail: '本部署未开启直付模式 (BOLLOON_X402_DIRECT=1 才开) —— 这条路径上没有链上核验能力' };
  }
  const chainId = CHAIN_ID_BY_NETWORK[network];
  if (!chainId) {
    return { ...shell, ok: false, code: 'ITEM_PRICE_UNSUPPORTED', detail: `不认识的 network=${network} → 无法确定 chainId, 不敢核验` };
  }

  // 要求逐字来自既有 buildPaymentRequired (与 402 的 accepts 同源, 绝不另算一份)
  const requirements = buildPaymentRequired(item, opts.resourceUrl);
  const req = requirements.accepts[0] as any;
  const txHash = String(opts.txHash || '').trim();
  if (!TXHASH_RE.test(txHash)) {
    return { ...shell, ok: false, code: 'TXHASH_INVALID', detail: `txHash 形状不对 (要 0x + 64 hex): ${txHash.slice(0, 40)}` };
  }

  const verdict = await verifyDirectTransfer({
    txHash,
    network,
    chainId,
    asset: String(req.asset),
    to: String(req.payTo),
    minAmount: String(req.amount),
    minConfirmations: opts.minConfirmations ?? directMinConfirmations(),
    rpcUrls: opts.rpcUrls ?? directRpcUrls(network),
    // ★ 订单标识自证要拿本店真实 item 复算哈希 —— 缺省只比"正在买的这一件",
    //   调用方给全量列表时可额外区分「买的是本店另一件」与「完全对不上」
    orderItemIds: opts.orderItemIds ?? [item.id],
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  if (!verdict.ok) {
    return {
      ...shell, ok: false, code: 'DIRECT_PAYMENT_NOT_VERIFIED', detail: verdict.reason, txHash, verdict,
      orderIdentity: verdict.orderIdentity, orderIdentitySelfAttested: !!verdict.orderIdentity?.selfAttested,
    };
  }

  const ledger = opts.ledger ?? new DirectTxLedger(directTxLedgerPath(home));
  // 回执的 settledAt 取**台账首见时间** (第二次提交同一 txHash 会复用同一个时间 ⇒ 回执逐字相同 ⇒
  // 同一 receiptHash ⇒ 同一 pendingId ⇒ 幂等命中同一条待办, 不会因"现在几点"而变出第二条)
  const prior = await ledger.get(verdict.txHash);
  const settledAt = prior?.settledAt ?? new Date(opts.now ?? Date.now()).toISOString();
  // 先在内存里拼出整条记录 (含订单标识), 再算回执哈希 —— 回执与台账**同源**, 不各算一份
  const draft: DirectTxRecord = {
    txHash: verdict.txHash.toLowerCase(), itemId: item.id, network, chainId,
    asset: String(req.asset), to: String(req.payTo), from: verdict.payer || '',
    amount: verdict.amount || '0', blockNumber: verdict.blockNumber ?? 0,
    confirmations: verdict.confirmations ?? 0, verifiedBy: verdict.verifiedBy,
    settledAt, receiptHash: '',
    ...(verdict.orderIdentity ? { orderIdentity: verdict.orderIdentity } : {}),
  };
  const receiptHash = `sha256:${sha256Hex(buildDirectReceipt(draft))}`;
  const claim = await ledger.claim({ ...draft, receiptHash, now: opts.now });
  if (!claim.ok || !claim.record) {
    return {
      ...shell, ok: false, code: claim.code || 'DIRECT_PAYMENT_NOT_VERIFIED', detail: claim.detail || '认领失败', txHash, verdict,
      orderIdentity: verdict.orderIdentity, orderIdentitySelfAttested: !!verdict.orderIdentity?.selfAttested,
    };
  }
  const receipt = buildDirectReceipt(claim.record);
  const orderIdentity = claim.record.orderIdentity ?? verdict.orderIdentity;

  return {
    ...shell, ok: true, detail: claim.reused ? '同一笔交易已交付过 (幂等: 回执逐字相同)' : '链上核验通过 (两条 RPC 交叉一致)',
    receipt, txHash: claim.record.txHash, payer: claim.record.from,
    confirmations: claim.record.confirmations, blockNumber: claim.record.blockNumber,
    verifiedBy: claim.record.verifiedBy, reused: !!claim.reused, verdict,
    orderIdentity, orderIdentitySelfAttested: !!orderIdentity?.selfAttested,
  };
}

// ────────────────────────────────────────────────────────────── HTTP 面 (POST /api/x402/info/:id/payment)

export function directPaymentPath(itemId: string): string {
  return `/api/x402/info/${encodeURIComponent(itemId)}/payment`;
}

export interface DirectPaymentHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function jsonRes(status: number, obj: unknown, headers: Record<string, string> = {}): DirectPaymentHttpResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    body: JSON.stringify(obj, null, 2),
  };
}

export interface DirectPaymentRequest {
  /** 已解析的 item (调用方负责 404) */
  item: PaidInfoItem;
  /** POST body 原文 ({ "txHash": "0x…" }) */
  bodyText?: string;
  home?: string;
  resourceUrl?: string;
  fetchImpl?: typeof fetch;
  rpcUrls?: string[];
  minConfirmations?: number;
  timeoutMs?: number;
  ledger?: DirectTxLedger;
  now?: number;
  allowDisabled?: boolean;
  /**
   * ★ 本店真实 item id 列表 (订单标识自证复算哈希用)。
   *   不传时**自己从 store 列一遍** (本店现有全部 item) —— 这样"对不上本店任何 item"
   *   与"买的是本店另一件"才分得开; store 列不出来时退回 `[item.id]` (只认正在买的这一件)。
   */
  orderItemIds?: string[];
}

/**
 * 处理「提交付款凭据」这件事。**服务器侧唯一实现** (仓内 route 与 ECS server.mjs 共用同一份,
 * 保证两边行为逐字相同)。
 *
 *   202 → 已核验付款, 落待办, 给取件 token (卖方还没签)
 *   200 → 卖方已签: 直接给信封 (幂等)
 *   410 → 待办过期
 *   402 → 核验不通过 (附 accepts 逐字 + 原因) —— 资源仍未付款
 *   400 → txHash 形状不对 / body 不是 JSON
 *   409 → 这个 txHash 已经用来交付过别的资源
 *   503 → 本部署没开直付模式
 */
export async function handleDirectPayment(req: DirectPaymentRequest): Promise<DirectPaymentHttpResult> {
  let txHash = '';
  try {
    const parsed = JSON.parse(String(req.bodyText || ''));
    txHash = String(parsed?.txHash ?? parsed?.transactionHash ?? '').trim();
  } catch {
    return jsonRes(400, { ok: false, code: 'INVALID_ARGUMENT', error: '请求体不是合法 JSON (期望 {"txHash":"0x…"})' });
  }
  if (!txHash) {
    return jsonRes(400, { ok: false, code: 'INVALID_ARGUMENT', error: '缺少 txHash (body: {"txHash":"0x…"} —— 买方自己发的 USDC 转账交易哈希)' });
  }

  // ★ 本店真实 item 列表: 没显式给就自己列一遍 (store 列不出来只退回正在买的这一件, 不阻止交付)
  let orderItemIds = req.orderItemIds;
  if (!orderItemIds || orderItemIds.length === 0) {
    try {
      const all = await listInfo(req.home);
      const ids = all.map((i) => i.id).filter(Boolean);
      orderItemIds = ids.length && ids.includes(req.item.id) ? ids : [req.item.id];
    } catch {
      orderItemIds = [req.item.id];
    }
  }

  const settled = await settleDirectPayment({
    item: req.item,
    txHash,
    home: req.home,
    resourceUrl: req.resourceUrl,
    fetchImpl: req.fetchImpl,
    rpcUrls: req.rpcUrls,
    minConfirmations: req.minConfirmations,
    timeoutMs: req.timeoutMs,
    ledger: req.ledger,
    now: req.now,
    allowDisabled: req.allowDisabled,
    orderItemIds,
  });

  if (!settled.ok) {
    if (settled.code === 'DIRECT_MODE_DISABLED') {
      return jsonRes(503, { ok: false, code: settled.code, error: settled.detail, hint: '本部署是只发 402 的口径; 要直付需 BOLLOON_X402_DIRECT=1' });
    }
    if (settled.code === 'TXHASH_INVALID') {
      return jsonRes(400, { ok: false, code: settled.code, error: settled.detail });
    }
    if (settled.code === 'TXHASH_ALREADY_USED') {
      return jsonRes(409, { ok: false, code: settled.code, error: settled.detail, hint: '一笔链上付款只能换一条资源' });
    }
    if (settled.code === 'NONCE_ALREADY_USED') {
      return jsonRes(409, {
        ok: false, code: settled.code, error: settled.detail,
        hint: 'EIP-3009 的 (payer, nonce) 只能用一次 —— 买家要重复购买请换 orderSeq 重签授权',
        orderIdentity: settled.orderIdentity,
      });
    }
    // 核验没过: 仍然返回 402 (资源未付款), accepts 与 GET 的 402 逐字同源
    const requirements = buildPaymentRequired(req.item, req.resourceUrl);
    return jsonRes(402, {
      ...requirements,
      error: settled.detail,
      code: settled.code || 'DIRECT_PAYMENT_NOT_VERIFIED',
      paymentAttempt: {
        mode: 'direct',
        verified: false,
        status: settled.verdict?.status,
        rpcChecks: settled.verdict?.rpcChecks,
        minConfirmations: settled.verdict?.minConfirmations,
        // 核验没过时也如实给出"这笔交易声明的订单身份"(方便买家自己看哪里错了)
        orderIdentity: settled.orderIdentity,
      },
    }, { 'X-PAYMENT-REQUIRED': JSON.stringify(requirements.accepts) });
  }

  const delivery = await resolvePaidDelivery({
    item: req.item as any,
    payment: {
      mode: 'direct',
      receipt: String(settled.receipt || ''),
      txHash: settled.txHash,
      payer: settled.payer,
      network: settled.network,
      amount: settled.amount,
      currency: settled.currency,
    },
  }, req.home, req.now);

  if (delivery.kind === 'envelope') {
    return jsonRes(200, delivery.envelope, {
      'X-PAYMENT-RESPONSE': String(settled.receipt || ''),
      'X-BOLLOON-SELLER-DID': delivery.envelope?.proof?.did || '',
    });
  }
  if (delivery.kind === 'expired') {
    return jsonRes(410, {
      ok: false, status: 'pending_expired', pendingId: delivery.pendingId, itemId: req.item.id,
      error: '这条待办已过期 (卖方长期未签名) — 请人工处理, **不要重复付款**', hint: delivery.hint,
    });
  }

  return jsonRes(202, {
    ok: true,
    status: 'paid_awaiting_signature',
    pendingId: delivery.pendingId,
    itemId: req.item.id,
    title: req.item.title,
    contentHash: req.item.contentHash,
    // ★ 订单标识 (约定 v1): 「这笔付款对应哪件东西」能不能在链上自证 —— 这里只报事实, 不美化
    orderIdentity: settled.orderIdentity,
    payment: {
      mode: 'direct',
      receiptHash: delivery.pending?.payment?.receiptHash,
      txHash: settled.txHash,
      payer: settled.payer || null,
      network: settled.network,
      amount: settled.amount,
      currency: settled.currency,
      confirmed: true,
      confirmations: settled.confirmations,
      blockNumber: settled.blockNumber,
      verifiedBy: settled.verifiedBy,
      custody: 'none',
      onchainVerification: 'receipt.status=1 + USDC Transfer to=payTo + value>=accepts.amount + 两条 RPC 一致 (不经过任何第三方托管)',
      orderIdentitySelfAttested: !!settled.orderIdentitySelfAttested,
      orderIdentityMode: settled.orderIdentity?.mode,
      reused: !!settled.reused,
    },
    retrieval: {
      token: delivery.pendingId,
      path: paidInfoRetrievePath(req.item.id, delivery.pendingId),
      note: '卖方不在线时这里一直回 202 (已付款待签名); 签好后回 200 + 信封',
    },
    hint: delivery.hint,
    retry: '卖方签好后, 用 retrieval.path 再取一次 (**不要重复付款**)',
  }, { 'X-PAYMENT-RESPONSE': String(settled.receipt || '') });
}

/** 这条路径在当前配置下**能**核验吗 (health 用; 只报事实, 不美化) */
export function directHealth(env: NodeJS.ProcessEnv = process.env, network = 'base'): Record<string, unknown> {
  const enabled = directPaymentEnabled(env);
  const rpcs = directRpcUrls(network, env).map(rpcLabel);
  return {
    enabled,
    onchain: enabled,
    custody: 'none',
    detail: enabled
      ? `链上核验: 买方直付到 payTo, 服务器按 txHash 查链 (${rpcs.length} 条 RPC 交叉, 确认数 >= ${directMinConfirmations(env)}); **不经过任何第三方托管/facilitator**`
      : '直付模式未开启 (BOLLOON_X402_DIRECT=1 才开)',
    rpcs,
    minRpcAgreement: DIRECT_MIN_RPCS,
    minConfirmations: directMinConfirmations(env),
    paymentPath: '/api/x402/info/:id/payment',
    // ★ 订单标识 (约定 v1): 让机器也能读到"本部署懂这个约定"; 不懂 = index 线不该在页面上声称
    orderIdentity: {
      protocol: ORDER_IDENTITY_PROTOCOL,
      tag: ORDER_NONCE_TAG_ASCII,
      tagHex: ORDER_NONCE_TAG,
      layout: 'tag(4B "BOL1") ‖ orderSeq(uint32 BE, 4B) ‖ keccak256(utf8(itemId)‖uint256be(orderSeq))[0..23](24B)',
      event: 'EIP-3009 AuthorizationUsed(authorizer, nonce)',
      eventTopic0: EIP3009_AUTHORIZATION_USED_TOPIC0,
      note: '自证 = 买方把订单身份编进 EIP-3009 nonce, 与付款在同一笔交易里; 没有该事件 / 哈希对不上本店 item ⇒ 如实降级为「直转(无订单标识)」',
    },
  };
}
