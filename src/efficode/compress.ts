/**
 * efficode/compress - 可插拔压缩层
 *
 * 三个算法 (数据块第一字节 = 算法 id):
 *   0 none     原样 (小消息用 —— 头上开箱代价为 0)
 *   1 lz77     本仓实现, 纯 JS 可跑任何运行面 (含手机 WebView)
 *   2 deflate  node:zlib deflateRaw (真压缩, 真数字)
 *
 * 默认策略 `pickAlgo`: 先按内容选, 选完**真压一遍**, 压不小就退回 `none`
 * (小消息硬压一定更贵 —— 这是实测结论, 见 wiki §"更高效吗")。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { lz77Compress, lz77Decompress } from './lz77.js';
import { COMPRESSION_IDS, COMPRESSION_BY_ID, EfficodeError, type CompressionAlgo } from './types.js';

export const COMPRESSION_ALGOS: CompressionAlgo[] = ['none', 'lz77', 'deflate'];

/** 压缩。返回 [1B 算法 id][载荷] 的完整数据块体 */
export function compressBlock(raw: Uint8Array, algo: CompressionAlgo): Uint8Array {
  const body = compressPayload(raw, algo);
  const out = new Uint8Array(body.length + 1);
  out[0] = COMPRESSION_IDS[algo];
  out.set(body, 1);
  return out;
}

function compressPayload(raw: Uint8Array, algo: CompressionAlgo): Uint8Array {
  switch (algo) {
    case 'none':
      return raw;
    case 'lz77':
      return lz77Compress(raw);
    case 'deflate':
      return new Uint8Array(deflateRawSync(raw));
    default:
      throw new EfficodeError('EFFICODE_UNKNOWN_COMPRESSION', `未知压缩算法 ${String(algo)}`);
  }
}

/** 解压 [1B 算法 id][载荷]。未知算法 id → 报错, 绝不"跳过解压直接给原文" */
export function decompressBlock(block: Uint8Array): { algo: CompressionAlgo; data: Uint8Array } {
  if (block.length < 1) throw new EfficodeError('EFFICODE_TRUNCATED', '数据块空 (缺算法 id)');
  const algo = COMPRESSION_BY_ID[block[0]];
  if (!algo) {
    throw new EfficodeError('EFFICODE_UNKNOWN_COMPRESSION', `数据块声明未知压缩算法 id=${block[0]}`, 0);
  }
  const payload = block.subarray(1);
  switch (algo) {
    case 'none':
      return { algo, data: payload.slice() };
    case 'lz77':
      return { algo, data: lz77Decompress(payload) };
    case 'deflate': {
      try {
        return { algo, data: new Uint8Array(inflateRawSync(payload)) };
      } catch (e) {
        throw new EfficodeError('EFFICODE_TRUNCATED', `deflate 解压失败: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
    }
    default:
      throw new EfficodeError('EFFICODE_UNKNOWN_COMPRESSION', `未知压缩算法 ${String(algo)}`);
  }
}

/**
 * 默认算法选择: 结构化文本 (重复多) 用 deflate; 其余先用 lz77 试;
 * 压缩后**不小于**原长就退回 none (省下的不该是负数)。
 */
export function pickAlgo(raw: Uint8Array, preferred: CompressionAlgo = 'deflate'): CompressionAlgo {
  if (raw.length < 32) return 'none'; // 小消息: 头上开箱代价 > 收益
  const got = compressPayload(raw, preferred);
  return got.length < raw.length ? preferred : 'none';
}

/** 真测: 三个算法分别压出来的字节数 (给门和 wiki 用真实数字, 不许估) */
export function measureAll(raw: Uint8Array): Record<CompressionAlgo, number> {
  const out = {} as Record<CompressionAlgo, number>;
  for (const a of COMPRESSION_ALGOS) out[a] = compressPayload(raw, a).length + 1; // +1 = 算法 id 字节
  return out;
}
