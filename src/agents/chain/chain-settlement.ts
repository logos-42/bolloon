/**
 * chain-settlement.ts — 「链上到底结算了没有」的唯一判定 (P3, 修 F5)
 *
 * 真问题 F5 (原样引):
 *   `chainSettled = !!txHash` —— 拿到 txHash 就判链上结算, 从不读 receipt/事件/确认数。
 *
 * 本文件的规矩 (硬规则, 不许放宽):
 *   ① 只有 receipt.status == 1 **且** 确认数 >= 配置门槛 **且** 事件对得上 → 才 `chainSettled: true`
 *   ② 拿不到 RPC / receipt 读不到 / 确认数不够 → 一律如实回「未结算 / 不确定」, `chainSettled: false`
 *   ③ 已经被认过的交易「不见了」或「换了块」→ 判重组 (`reorged`), **不是**已结算
 *   ④ `local-dev` 永远进不来这里 (这里只认链上事实)
 *
 * 判定只看链上原始事实 (receipt / logs / 合约状态), 不看谁说的。
 */

import { Interface } from 'ethers';
import {
  EscrowClient,
  V2_EVENT_NAMES,
  ESCROW_STATES,
  type V2EventName,
  type RawLog,
  type EscrowStateName,
} from './escrow-client.js';
import {
  loadChainConfig,
  DEFAULT_CONFIRMATIONS,
  type ChainConfirmations,
  type ChainConfig,
  type LoadChainConfigOptions,
} from './chain-config.js';

export type ChainSettlementStatus =
  | 'not_attempted'      // 没有 txHash: 根本没发过链上交易
  | 'unknown'            // 拿不到 RPC / receipt 读不到 → 不知道 (绝不等于"没付")
  | 'pending'            // 上链了但确认数不够
  | 'confirmed'          // 确认数够 confirmed 门槛 + 事件对得上
  | 'finalized'          // 确认数够 finalized 门槛 + 事件对得上
  | 'reverted'           // receipt.status == 0 (钱一定没动)
  | 'event_mismatch'     // 上链了但不是我们要的那笔 (taskKey/resultHash/收款方对不上)
  | 'reorged'            // 曾有确认, 现在块号变了 / 链上没有这笔了
  | 'config_unavailable';// 链配置取不到 → 无法验证 (诚实报, 不猜地址)

export interface ChainSettlementExpect {
  kind: 'escrow' | 'erc20_transfer' | 'none';
  /** escrow 模式: 必须对得上的 taskKey */
  taskKey?: string;
  /** escrow 模式: 必须对得上的 resultHash (可选, 更严) */
  resultHash?: string;
  /** escrow 模式: 指定事件名 (缺省 = 5 个 v2 事件里任一个 topic 匹配 taskKey 就算) */
  eventName?: V2EventName;
  /** escrow 模式: 交易后合约里 escrow 应处于的状态 (可选) */
  expectEscrowState?: EscrowStateName;
  /** erc20_transfer 模式: token 合约地址 (缺省 → 无法核对, 报 unknown) */
  tokenAddress?: string;
  /** erc20_transfer 模式: 收款方 / 付款方 / 最小金额 */
  to?: string;
  from?: string;
  minAmount?: bigint;
}

export interface ChainSettlementVerdict {
  /** ★ 唯一权威口径: 只有 confirmed / finalized 才是 true */
  chainSettled: boolean;
  status: ChainSettlementStatus;
  reason: string;
  txHash?: string;
  blockNumber?: number | null;
  confirmations?: number;
  /** 这次判定用到的门槛 (审计要说清"几个确认才算数") */
  confirmationsRequired: number;
  requiredGate: 'confirmed' | 'finalized';
  latestBlock?: number;
  taskKey?: string;
  resultHash?: string;
  matchedEvent?: string;
  /** 事件核对结果: true 对得上 / false 对不上 / null 没要求或核不了 */
  eventMatched?: boolean | null;
  escrowState?: EscrowStateName | null;
  rpcAvailable: boolean;
  checkedAt: number;
  /** 判定依据的原始事实 (审计/复盘用) */
  evidence: Record<string, unknown>;
}

export interface VerifyChainSettlementOptions {
  txHash?: string;
  expect?: ChainSettlementExpect;
  /** 判定门槛: 'confirmed'(默认) 或 'finalized' */
  gate?: 'confirmed' | 'finalized';
  confirmations?: ChainConfirmations;
  /** 持久记录里的旧事实 (重组检测用) */
  recorded?: {
    blockNumber?: number | null;
    confirmations?: number;
    status?: string;
  };
}

/** ERC20 Transfer 事件 topic0 */
export const ERC20_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ERC20_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

function base(partial: Partial<ChainSettlementVerdict> & { status: ChainSettlementStatus; reason: string }): ChainSettlementVerdict {
  return {
    chainSettled: false,
    confirmationsRequired: 0,
    requiredGate: 'confirmed',
    rpcAvailable: true,
    checkedAt: Date.now(),
    evidence: {},
    ...partial,
  } as ChainSettlementVerdict;
}

/**
 * ★ 唯一判定入口。
 * 只用链上原始事实; 任何一步读不到 → `chainSettled: false` + 说明为什么。
 */
export async function verifyChainSettlement(
  client: EscrowClient,
  opts: VerifyChainSettlementOptions,
): Promise<ChainSettlementVerdict> {
  const cfgConf = opts.confirmations || client.confirmations || DEFAULT_CONFIRMATIONS;
  const gate = opts.gate || 'confirmed';
  const required = gate === 'finalized' ? cfgConf.finalized : cfgConf.confirmed;
  const expect = opts.expect || { kind: 'none' as const };
  const txHash = opts.txHash ? String(opts.txHash) : '';

  // ① 没 txHash: 从来没发过链上交易
  if (!txHash) {
    return base({
      status: 'not_attempted',
      reason: '没有 txHash: 这不是一笔链上交易, 不能判链上结算',
      confirmationsRequired: required, requiredGate: gate,
    });
  }

  // ② receipt (读不到 = rpcAvailable false, 不是"没结算")
  let rc: any;
  try {
    rc = await client.getReceipt(txHash);
  } catch (e: any) {
    return base({
      status: 'unknown',
      reason: `读 receipt 失败 (RPC 不可用?): ${String(e?.message || e).slice(0, 160)} —— 付款状态未知, 不等于失败, 也不等于已结算`,
      txHash, confirmationsRequired: required, requiredGate: gate,
      rpcAvailable: false, evidence: { receiptError: String(e?.message || e).slice(0, 200) },
    });
  }

  if (!rc) {
    // 链上没有这笔了 —— 如果之前认过它, 那就是重组
    if (opts.recorded && opts.recorded.blockNumber != null) {
      return base({
        status: 'reorged',
        reason: `曾记在块 ${opts.recorded.blockNumber} 的交易现在链上查不到 (重组?), 不可信, 不能当已结算`,
        txHash, confirmationsRequired: required, requiredGate: gate,
        eventMatched: null, evidence: { recorded: opts.recorded },
      });
    }
    return base({
      status: 'unknown',
      reason: 'receipt 为空: 交易还没被打包 (或在内存池里) —— 未结算, 也不等于失败',
      txHash, confirmationsRequired: required, requiredGate: gate,
      evidence: { receipt: null },
    });
  }

  const blockNumber = Number(rc.blockNumber);

  // ③ latestBlock (数确认数要用; 读不到 = 不知道)
  let latestBlock: number;
  try {
    latestBlock = await client.getLatestBlockNumber();
  } catch (e: any) {
    return base({
      status: 'unknown',
      reason: `读不到最新块高, 无法数确认数: ${String(e?.message || e).slice(0, 160)}`,
      txHash, blockNumber, confirmationsRequired: required, requiredGate: gate,
      rpcAvailable: false, evidence: { receiptStatus: Number(rc.status) },
    });
  }
  const confirmations = latestBlock - blockNumber + 1;

  // ④ receipt status: 0 = 明确失败, 钱一定没动
  if (Number(rc.status) !== 1) {
    return base({
      status: 'reverted',
      reason: `receipt.status = ${Number(rc.status)}: 交易回滚了, 链上没结算 (钱没动)`,
      txHash, blockNumber, confirmations, latestBlock,
      confirmationsRequired: required, requiredGate: gate,
      evidence: { receiptStatus: Number(rc.status) },
    });
  }

  // ⑤ 重组检测: 同一 txHash 出现在**另一个**块里
  if (opts.recorded && opts.recorded.blockNumber != null && Number(opts.recorded.blockNumber) !== blockNumber) {
    return base({
      status: 'reorged',
      reason: `重组: 同一 txHash 上次记在块 ${opts.recorded.blockNumber}, 现在是块 ${blockNumber} —— 链被重排过, 旧确认不可信`,
      txHash, blockNumber, confirmations, latestBlock,
      confirmationsRequired: required, requiredGate: gate,
      evidence: { recordedBlock: opts.recorded.blockNumber, currentBlock: blockNumber },
    });
  }

  // ⑥ 事件核对 (按预期类型)
  const logs: RawLog[] = (rc.logs || []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, index: l.index }));
  let eventMatched: boolean | null = null;
  let matchedEvent: string | undefined;
  let escrowState: EscrowStateName | null = null;
  const evEvidence: Record<string, unknown> = { logCount: logs.length };

  if (expect.kind === 'escrow') {
    if (!expect.taskKey) {
      return base({
        status: 'event_mismatch',
        reason: '要求核对 escrow 事件但没给 taskKey → 核不了, 不敢判已结算',
        txHash, blockNumber, confirmations, latestBlock,
        confirmationsRequired: required, requiredGate: gate, eventMatched: false,
      });
    }
    const decoded = client.decodeV2Events({ txHash, blockNumber, gasUsed: null, status: 1, reverted: false, logs, broadcast: true });
    const wanted = expect.eventName ? decoded.filter((d) => d.name === expect.eventName) : decoded;
    const hit = wanted.find((d) => {
      const tk = String(d.args.taskKey || '').toLowerCase();
      if (tk !== String(expect.taskKey).toLowerCase()) return false;
      if (expect.resultHash) {
        const rh = String(d.args.resultHash || '').toLowerCase();
        if (rh !== String(expect.resultHash).toLowerCase()) return false;
      }
      return true;
    });
    eventMatched = !!hit;
    matchedEvent = hit?.name;
    evEvidence.decodedEvents = decoded.map((d) => d.name);
    evEvidence.expectedTaskKey = expect.taskKey;

    // 读合约里这条 escrow 的真实状态
    try {
      const e = await client.getEscrow(expect.taskKey);
      escrowState = e ? (e.stateName as EscrowStateName) : null;
      evEvidence.escrowPresent = !!e;
      if (e) evEvidence.escrowState = e.stateName;
    } catch (e: any) {
      evEvidence.escrowReadError = String(e?.message || e).slice(0, 160);
    }

    if (!hit) {
      return base({
        status: 'event_mismatch',
        reason: `receipt 里有 ${decoded.length} 条本合约事件, 但没有一条 taskKey=${expect.taskKey}` +
          (expect.eventName ? ` 且事件=${expect.eventName}` : '') +
          (expect.resultHash ? ` 且 resultHash=${expect.resultHash}` : '') + ' —— 这不是我们要的那笔, 不能当已结算',
        txHash, blockNumber, confirmations, latestBlock,
        confirmationsRequired: required, requiredGate: gate,
        taskKey: expect.taskKey, resultHash: expect.resultHash,
        eventMatched, matchedEvent, escrowState, evidence: evEvidence,
      });
    }
    if (expect.expectEscrowState && escrowState !== expect.expectEscrowState) {
      return base({
        status: 'event_mismatch',
        reason: `事件对得上但合约状态是 ${escrowState ?? '(读不到)'}, 期望 ${expect.expectEscrowState}`,
        txHash, blockNumber, confirmations, latestBlock,
        confirmationsRequired: required, requiredGate: gate,
        taskKey: expect.taskKey, eventMatched, matchedEvent, escrowState, evidence: evEvidence,
      });
    }
  } else if (expect.kind === 'erc20_transfer') {
    if (!expect.tokenAddress) {
      return base({
        status: 'unknown',
        reason: '要核对 ERC20 Transfer 但没给 tokenAddress → 核不了, 不能判已结算',
        txHash, blockNumber, confirmations, latestBlock,
        confirmationsRequired: required, requiredGate: gate, eventMatched: null,
      });
    }
    const transfers = logs.filter((l) =>
      String(l.address).toLowerCase() === String(expect.tokenAddress).toLowerCase() &&
      String(l.topics?.[0] || '').toLowerCase() === ERC20_TRANSFER_TOPIC0,
    );
    const match = transfers.find((l) => {
      try {
        const p = ERC20_IFACE.parseLog({ topics: [...l.topics], data: l.data });
        if (!p) return false;
        const from = String(p.args.from).toLowerCase();
        const to = String(p.args.to).toLowerCase();
        const value = BigInt(p.args.value);
        if (expect.to && to !== String(expect.to).toLowerCase()) return false;
        if (expect.from && from !== String(expect.from).toLowerCase()) return false;
        if (expect.minAmount != null && value < expect.minAmount) return false;
        return true;
      } catch { return false; }
    });
    eventMatched = !!match;
    matchedEvent = match ? 'Transfer' : undefined;
    evEvidence.transferLogs = transfers.length;
    if (!match) {
      return base({
        status: 'event_mismatch',
        reason: `receipt 里没有匹配的 ERC20 Transfer (token=${expect.tokenAddress}, 收了 ${transfers.length} 条 Transfer) —— 不是这笔付款, 不能当已结算`,
        txHash, blockNumber, confirmations, latestBlock,
        confirmationsRequired: required, requiredGate: gate, eventMatched, evidence: evEvidence,
      });
    }
  } else {
    eventMatched = null; // 没要求核对事件
  }

  // ⑦ 确认数门槛: 不够 → pending (明确"还没到", 不是"已结算")
  if (confirmations < required) {
    return base({
      status: 'pending',
      reason: `确认数 ${confirmations} < 门槛 ${required} (${gate}) → 还没到可以判结算的程度`,
      txHash, blockNumber, confirmations, latestBlock,
      confirmationsRequired: required, requiredGate: gate,
      taskKey: expect.taskKey, resultHash: expect.resultHash,
      eventMatched, matchedEvent, escrowState, evidence: evEvidence,
    });
  }

  // ⑧ 全过 → 结算成立
  const status: ChainSettlementStatus = confirmations >= cfgConf.finalized ? 'finalized' : 'confirmed';
  return base({
    chainSettled: true,
    status,
    reason: `receipt.status=1, 确认数 ${confirmations} >= ${required} (${gate})` +
      (matchedEvent ? `, 事件 ${matchedEvent} 对得上` : '') + ` → 链上结算成立`,
    txHash, blockNumber, confirmations, latestBlock,
    confirmationsRequired: required, requiredGate: gate,
    taskKey: expect.taskKey, resultHash: expect.resultHash,
    eventMatched, matchedEvent, escrowState, evidence: evEvidence,
  });
}

// ── 给 x402 付款路径用的验证器 (可注入; 缺省 = 真链验证) ─────────────────────

export interface ChainVerifierRequest {
  txHash?: string;
  expect?: ChainSettlementExpect;
  gate?: 'confirmed' | 'finalized';
  recorded?: { blockNumber?: number | null; confirmations?: number; status?: string };
}
export type ChainSettlementVerifier = (req: ChainVerifierRequest) => Promise<ChainSettlementVerdict>;

/** 用现成 client 造验证器 */
export function createChainSettlementVerifier(client: EscrowClient, defaults: { gate?: 'confirmed' | 'finalized' } = {}): ChainSettlementVerifier {
  return (req) => verifyChainSettlement(client, { ...req, gate: req.gate || defaults.gate || 'confirmed' });
}

export interface DefaultVerifierOptions extends LoadChainConfigOptions {
  /** 客户端工厂 (测试注入); 缺省 = loadChainConfig() → new EscrowClient */
  clientFactory?: (cfg: ChainConfig) => EscrowClient;
  gate?: 'confirmed' | 'finalized';
}

/**
 * 缺省验证器: 用本机配置 (env → ~/.bolloon/chain.json → 报错) 造 client。
 * 配置取不到 → **不抛** (付款路径不能被配置问题炸掉), 而是返回一个永远
 * `chainSettled: false` + `config_unavailable` 的诚实判定:
 *   「我没法验证 → 不能宣称链上已验证」。
 */
export function createDefaultChainSettlementVerifier(opts: DefaultVerifierOptions = {}): ChainSettlementVerifier {
  let client: EscrowClient | null = null;
  let loadError: string | null = null;
  try {
    const cfg = loadChainConfig({ home: opts.home, env: opts.env });
    client = opts.clientFactory ? opts.clientFactory(cfg) : new EscrowClient({ config: cfg });
  } catch (e: any) {
    loadError = String(e?.message || e).slice(0, 300);
  }
  if (!client) {
    const err = loadError;
    return async (req) => base({
      status: 'config_unavailable',
      reason: `链配置取不到, 无法做真链验证 → 不能判链上结算: ${err}`,
      txHash: req.txHash,
      confirmationsRequired: 0, requiredGate: req.gate || 'confirmed',
      rpcAvailable: false,
      taskKey: req.expect?.taskKey,
      evidence: { configError: err },
    });
  }
  return createChainSettlementVerifier(client, { gate: opts.gate });
}
