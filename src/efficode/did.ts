/**
 * efficode/did - DID 验证段 (固定 32B)
 *
 * 布局 (32 字节):
 *   [0]      algo id (= 1, sha256-截断)
 *   [1..3]   原始身份串字节数 (24 位大端, 上限 16MB)
 *   [4..31]  sha256(身份串) 的**前 28 字节**
 *
 * 诚实边界 (必须写进 wiki, 不许含糊):
 *   - 32B **装不下**一个 DID / 公钥, 所以本段是**摘要**, 只能做"是不是同一个身份"的比对,
 *     **不能**从段里还原身份, 也**不能**独立证明持有私钥;
 *   - 真正的"链上签名验证 + ECC 临时会话密钥"属**规范中/未实现** —— 本模块没有签名函数,
 *     也没有密钥交换函数 (不写假实现)。签名校验的接线点在 packet 层的 `verifyDid` 回调,
 *     现成可用的只有摘要比对这一条。
 */

import { createHash } from 'node:crypto';
import { DID_SEGMENT_BYTES, EfficodeError } from './types.js';

export const DID_ALGO_SHA256_TRUNC28 = 1;

export interface DidSegment {
  algo: number;
  /** 原始身份串的字节数 */
  origLen: number;
  /** 28 字节摘要 */
  digest: Uint8Array;
}

/** 编: 身份串 → 32B 段 */
export function encodeDidSegment(did: string): Uint8Array {
  const raw = Buffer.from(String(did), 'utf-8');
  if (raw.length === 0) throw new EfficodeError('EFFICODE_DID_SEGMENT_BAD', '身份串为空');
  if (raw.length > 0xffffff) throw new EfficodeError('EFFICODE_DID_SEGMENT_BAD', `身份串过长 (${raw.length}B > 16MB)`);
  const full = createHash('sha256').update(raw).digest();
  const seg = new Uint8Array(DID_SEGMENT_BYTES);
  seg[0] = DID_ALGO_SHA256_TRUNC28;
  seg[1] = (raw.length >>> 16) & 0xff;
  seg[2] = (raw.length >>> 8) & 0xff;
  seg[3] = raw.length & 0xff;
  seg.set(full.subarray(0, DID_SEGMENT_BYTES - 4), 4);
  return seg;
}

/** 解: 32B 段 → 结构。长度不足 / algo 未知 → 抛 */
export function decodeDidSegment(seg: Uint8Array): DidSegment {
  if (seg.length !== DID_SEGMENT_BYTES) {
    throw new EfficodeError('EFFICODE_DID_SEGMENT_BAD', `DID 段应为 ${DID_SEGMENT_BYTES}B, 实得 ${seg.length}B`);
  }
  const algo = seg[0];
  if (algo !== DID_ALGO_SHA256_TRUNC28) {
    throw new EfficodeError('EFFICODE_DID_SEGMENT_BAD', `未知 DID 摘要算法 id=${algo}`, 0);
  }
  const origLen = (seg[1] << 16) | (seg[2] << 8) | seg[3];
  return { algo, origLen, digest: seg.slice(4) };
}

/** 摘要段的稳定文本形式: `algo1:<56 hex>` —— 可安全落日志 (单向, 不可还原身份) */
export function didDigestString(seg: DidSegment): string {
  return `algo${seg.algo}:${Buffer.from(seg.digest).toString('hex')}`;
}

/**
 * 校验一条身份声明是否与段匹配。
 * 这是**明文比对** (拿原身份串再算一遍摘要), 不是签名验证 —— 返回值里如实标出方式。
 */
export function matchesDidSegment(did: string, seg: Uint8Array): { match: boolean; method: 'digest'; signed: false } {
  const expected = encodeDidSegment(did);
  let match = expected.length === seg.length;
  if (match) {
    for (let i = 0; i < seg.length; i++) if (expected[i] !== seg[i]) { match = false; break; }
  }
  return { match, method: 'digest', signed: false };
}
