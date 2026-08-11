/**
 * delegate-handle.ts — 委派句柄 (借鉴 Hermes Agent `agent/subagent_lifecycle.py` 的 handle 设计)
 *
 * Hermes 模式: 子任务 handle 是不可变契约 + HMAC 签名 capability,
 *   `capability = HMAC(secret, subagent_id|parent_session_id|created_at)`,
 *   校验时 strict 类型检查 + `hmac.compare_digest` 定时安全比对 + 父 session 必须匹配。
 *   子 agent 拿到 handle 也伪造不了、跨 session 用不了 — 防提权。
 *
 * Bolloon 对应物: delegate_to_engine 的委派记录。
 *   - 父身份用 `ownerDid` (agent 的 DID, 稳定跨重启; 比 sessionId 更适合防跨 channel)
 *   - handle 写入 sidechain JSONL 落盘, 可事后验证记录真实性 (防伪造委派记录)
 *   - correlationId 支持幂等去重 (同一 parent+correlation 只允许一次)
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

/** 契约版本: 结构不兼容时递增, 旧 handle 直接拒绝而不是猜字段 */
export const DELEGATE_CONTRACT_VERSION = 1;

export interface DelegateHandle {
  contractVersion: number;
  delegateId: string;
  /** 父 agent DID — 跨 agent/channel 使用即拒绝 */
  ownerDid: string;
  /** 幂等去重键 (同一 owner 重复 correlation 应复用/拒绝) */
  correlationId?: string;
  createdAt: number;
  engineId: string;
  model?: string;
  /** HMAC-SHA256(secret, delegateId|ownerDid|createdAt) 的 hex */
  capability: string;
}

/**
 * 进程级随机密钥 (与 Hermes `_SECRET = secrets.token_bytes(32)` 同思路):
 * 每次启动重新生成 → 重启后的旧 handle 全部失效, 序列化 handle 不可重放。
 */
const _SECRET: Buffer = randomBytes(32);

function _capability(delegateId: string, ownerDid: string, createdAt: number): string {
  return createHmac('sha256', _SECRET)
    .update(`${delegateId}|${ownerDid}|${createdAt}`)
    .digest('hex');
}

export interface CreateDelegateHandleOptions {
  ownerDid: string;
  engineId: string;
  correlationId?: string;
  model?: string;
}

/** 创建委派句柄 (与 Hermes launch() 返回 SubagentHandle 对应) */
export function createDelegateHandle(opts: CreateDelegateHandleOptions): DelegateHandle {
  const delegateId = randomUUID();
  const createdAt = Date.now();
  return {
    contractVersion: DELEGATE_CONTRACT_VERSION,
    delegateId,
    ownerDid: opts.ownerDid,
    correlationId: opts.correlationId,
    createdAt,
    engineId: opts.engineId,
    model: opts.model,
    capability: _capability(delegateId, opts.ownerDid, createdAt),
  };
}

/**
 * 校验句柄真实性。
 * @param ownerDid 传当前活跃父 DID → 额外强制匹配 (防跨 channel/跨 agent 使用)
 */
export function verifyDelegateHandle(handle: unknown, ownerDid?: string): handle is DelegateHandle {
  if (!handle || typeof handle !== 'object') return false;
  const h = handle as Record<string, unknown>;
  // strict 类型检查 (Hermes `_record` 同款): 类型不对直接拒, 不猜
  if (h.contractVersion !== DELEGATE_CONTRACT_VERSION) return false;
  if (typeof h.delegateId !== 'string' || h.delegateId === '') return false;
  if (typeof h.ownerDid !== 'string' || h.ownerDid === '') return false;
  if (typeof h.createdAt !== 'number' || !Number.isFinite(h.createdAt)) return false;
  if (typeof h.engineId !== 'string' || h.engineId === '') return false;
  if (typeof h.capability !== 'string' || h.capability === '') return false;
  if (ownerDid !== undefined && h.ownerDid !== ownerDid) return false;

  // 定时安全比对 (与 hmac.compare_digest 等价)
  const expected = _capability(h.delegateId, h.ownerDid, h.createdAt);
  const a = Buffer.from(h.capability, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
