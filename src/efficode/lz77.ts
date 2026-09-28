/**
 * efficode/lz77 - 自解压数据块用的轻量 LZ77 (真实实现, 不是占位)
 *
 * 数据块布局 (自解压头 + 码流):
 *   [varint origLen][varint compLen][token stream]
 *
 *   token stream = 控制字节 + 载荷, 每控制字节管 8 个 token, MSB 在前:
 *     控制位 0 → 后接 1 字节字面量
 *     控制位 1 → 后接 2 字节匹配 (12 位 offset, 4 位 length-3)
 *
 *   origLen 在头里 ⇒ 解码器**不需要**猜结束位置 (靠输出长度收敛), 尾随多余码流一律报错。
 *
 * 匹配查找用 deflate 那套**哈希链**: 3 字节前缀哈希 → 链上回溯 (最多 MAX_CHAIN 个候选).
 * 第一版是"从 pos-1 逐个往前比"的朴素写法, 在 `...\n` 这种周期 > 16 的重复文本上**找不到匹配**
 * (300 行重复文本压完反而膨胀 1538B —— 实测出来的, 已换掉)。
 *
 * 诚实边界 (写进 wiki 时按实测数字):
 *   - 参考实现: 窗口 4095B / 最短匹配 3B / 最长匹配 18B, **没有**哈夫曼那一层;
 *   - 对重复度高的结构化文本有效, 对**随机字节**会膨胀 (控制位占 1/8);
 *   - 真实压缩率对比见 scripts/verify-efficode.ts 的真测输出, 不许在文档里编。
 */

import { EfficodeError } from './types.js';

const WINDOW = 4095;      // 12 位 offset (0 保留为非法)
const MIN_MATCH = 3;      // length-3 存 4 位 ⇒ 3..18
const MAX_MATCH = 18;
const MAX_CHAIN = 16;     // 哈希链回溯上限 (控制最坏耗时)
const HASH_SIZE = 1 << 16; // 3 字节前缀哈希表大小

function writeVarint(out: number[], n: number): void {
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0xff);
}

function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) throw new EfficodeError('EFFICODE_TRUNCATED', 'varint 未读完就到底', i);
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new EfficodeError('EFFICODE_TRUNCATED', 'varint 超过 32 位上限', i);
  }
  return { value: value >>> 0, next: i };
}

/** 压缩。返回 [varint origLen][varint compLen][tokens] */
export function lz77Compress(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  writeVarint(out, input.length);
  const bodyStart = out.length;
  out.push(0); // 占位 (1B, varint(0)); 最后整体重拼, 不依赖占位宽度

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(input.length).fill(-1);

  const insertAt = (pos: number): void => {
    if (pos + MIN_MATCH > input.length) return;
    const h = hash3(input, pos);
    prev[pos] = head[h];
    head[h] = pos;
  };

  const findMatch = (pos: number): { offset: number; length: number } | null => {
    if (pos + MIN_MATCH > input.length) return null;
    const h = hash3(input, pos);
    const maxLen = Math.min(MAX_MATCH, input.length - pos);
    let cand = head[h];
    let chain = 0;
    let bestLen = 0;
    let bestOff = 0;
    while (cand >= 0 && chain < MAX_CHAIN) {
      const distance = pos - cand;
      if (distance > WINDOW) break;
      let len = 0;
      while (len < maxLen && input[cand + len] === input[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestOff = distance;
        if (len === maxLen) break;
      }
      cand = prev[cand];
      chain++;
    }
    return bestLen >= MIN_MATCH ? { offset: bestOff, length: bestLen } : null;
  };

  let i = 0;
  while (i < input.length) {
    const controlIdx = out.length;
    let control = 0;
    out.push(0);
    for (let bit = 7; bit >= 0 && i < input.length; bit--) {
      const match = findMatch(i);
      if (match) {
        control |= 1 << bit;
        const v = ((match.offset & 0xfff) << 4) | ((match.length - MIN_MATCH) & 0xf);
        out.push((v >>> 8) & 0xff, v & 0xff);
        for (let k = 0; k < match.length; k++) insertAt(i + k);
        i += match.length;
      } else {
        out.push(input[i]);
        insertAt(i);
        i += 1;
      }
    }
    out[controlIdx] = control;
  }

  // compLen = 码流字节数 (= 占位字节之后的所有字节); 之前这里把占位字节也算进去了 ⇒ 声明比实际多 1 ⇒ 解码必报截断
  const body = out.slice(bodyStart + 1);
  const filled: number[] = [];
  writeVarint(filled, input.length);
  writeVarint(filled, body.length);
  filled.push(...body);
  return Uint8Array.from(filled);
}

function hash3(b: Uint8Array, i: number): number {
  return (((b[i] << 10) ^ (b[i + 1] << 5) ^ b[i + 2]) & (HASH_SIZE - 1)) >>> 0;
}

/** 解压 (严格)。码流不足 / 长度对不上 / 超长一律抛, 不做任何"尽量解" */
export function lz77Decompress(block: Uint8Array): Uint8Array {
  const head = readVarint(block, 0);
  const origLen = head.value;
  const head2 = readVarint(block, head.next);
  const compLen = head2.value;
  const bodyEnd = head2.next + compLen;
  if (bodyEnd > block.length) {
    throw new EfficodeError('EFFICODE_TRUNCATED', `LZ77 码流声明 ${compLen}B 但只剩 ${block.length - head2.next}B`, head2.next);
  }
  const out: number[] = [];
  let pos = head2.next;
  while (out.length < origLen) {
    if (pos >= bodyEnd) {
      throw new EfficodeError('EFFICODE_TRUNCATED', `LZ77 码流提前结束 (期望 ${origLen}B, 实得 ${out.length}B)`, pos);
    }
    const control = block[pos++];
    for (let bit = 7; bit >= 0 && out.length < origLen; bit--) {
      if (control & (1 << bit)) {
        if (pos + 2 > bodyEnd) {
          throw new EfficodeError('EFFICODE_TRUNCATED', 'LZ77 匹配 token 缺字节', pos);
        }
        const v = (block[pos] << 8) | block[pos + 1];
        pos += 2;
        const offset = (v >>> 4) & 0xfff;
        const length = (v & 0xf) + MIN_MATCH;
        if (offset === 0 || offset > out.length) {
          throw new EfficodeError('EFFICODE_TRUNCATED', `LZ77 匹配 offset=${offset} 越界 (已解 ${out.length}B)`, pos);
        }
        for (let k = 0; k < length; k++) out.push(out[out.length - offset]);
      } else {
        if (pos >= bodyEnd) {
          throw new EfficodeError('EFFICODE_TRUNCATED', 'LZ77 字面量 token 缺字节', pos);
        }
        out.push(block[pos++]);
      }
    }
  }
  return Uint8Array.from(out);
}
