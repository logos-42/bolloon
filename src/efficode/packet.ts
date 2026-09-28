/**
 * efficode/packet - 包封装 (帧结构 + CRC32 尾段 + 严格解析)
 *
 * 布局 (照规范):
 *   [Header 2B] | [DID 验证段 32B] | [指令段 动态] | [数据块 动态] | [CRC32 4B]
 *
 * Header 2B:
 *   byte0: version(高 4 位) | mode(低 4 位)      mode: 0=compact · 1=text
 *   byte1: flags                                bit0=有 DID 段 · bit1=有指令段 · bit2=有数据块
 *                                               bit3=数据块已压缩 · bit4..7=保留 (必须 0)
 *
 * 指令段: [varint opLen][opBytes]        opBytes 见 ops.ts 的逐条形状
 * 数据块: [varint dataLen][dataBytes]    dataBytes[0] = 压缩算法 id (见 compress.ts)
 *
 * 两条硬纪律 (变异 M1/M2 就是拆这两条, 门必须变红):
 *   ① 解析必须**逐段自描述**: 长度对不上就报截断, 不许"能解多少解多少";
 *   ② 尾段 CRC32 覆盖 CRC 之前的**全部**字节, 对不上就报 CRC_MISMATCH,
 *      绝不放行"内容看着像就收下"。
 *
 * 诚实边界:
 *   - "DID 段 32B" 在规范里是固定段; 参考实现允许省略 (省 32B), 省略时 flags 如实写 0,
 *     解码端按 flags 解, **不假设**段存在;
 *   - CRC32 只防传输损坏, **不是**防篡改 (无密钥)。防篡改要真签名 —— 规范中, 见 did.ts 注释。
 */

import { crc32Bytes, readCrc32Bytes, crc32 } from './crc32.js';
import { DID_SEGMENT_BYTES, EfficodeError, EFFICODE_VERSION, CRC_BYTES, MIN_PACKET_BYTES, type CompressionAlgo, type DecodedPacket, type EfficodeMessage, type EfficodeMode, type Instruction } from './types.js';
import { compressBlock, decompressBlock, pickAlgo } from './compress.js';
import { decodeDidSegment, didDigestString, encodeDidSegment } from './did.js';
import { instructionsToSymbolic, opByCode, opBySymbol, symbolicToInstructions } from './ops.js';

const MODE_TO_NUM: Record<EfficodeMode, number> = { compact: 0, text: 1 };
const NUM_TO_MODE: Record<number, EfficodeMode> = { 0: 'compact', 1: 'text' };

const F_HAS_DID = 1 << 0;
const F_HAS_OP = 1 << 1;
const F_HAS_DATA = 1 << 2;
const F_COMPRESSED = 1 << 3;
const FLAG_RESERVED = 0xf0;

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

/** 指令序列 → 指令段字节 (不含外层 varint 长度) */
function encodeInstructions(instructions: Instruction[]): Uint8Array {
  const out: number[] = [];
  for (const ins of instructions) {
    const def = opBySymbol(ins.op);
    out.push(def.code);
    const payload = def.hasPayload ? Buffer.from(String(ins.value ?? ''), 'utf-8') : Buffer.alloc(0);
    if (!def.hasPayload && (ins.value ?? '') !== '') {
      throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `控制指令 ${def.symbol} 不接受载荷`);
    }
    writeVarint(out, payload.length);
    for (const b of payload) out.push(b);
  }
  return Uint8Array.from(out);
}

/** 指令段字节 → 指令序列 (严格: 未知 opcode / 截断都抛) */
function decodeInstructions(buf: Uint8Array): Instruction[] {
  const out: Instruction[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const code = buf[pos];
    const def = opByCode(code, pos); // 未知 opcode → 抛 (变异 M1 拆掉这里 → 门变红)
    pos += 1;
    const len = readVarint(buf, pos);
    pos = len.next;
    if (def.hasPayload) {
      if (pos + len.value > buf.length) {
        throw new EfficodeError('EFFICODE_TRUNCATED', `指令 ${def.symbol} 声明 ${len.value}B 载荷但只剩 ${buf.length - pos}B`, pos);
      }
      out.push({ op: def.symbol, value: Buffer.from(buf.subarray(pos, pos + len.value)).toString('utf-8') });
      pos += len.value;
    } else {
      if (len.value !== 0) {
        throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `控制指令 ${def.symbol} 声明了 ${len.value}B 载荷`, pos);
      }
      out.push({ op: def.symbol });
    }
  }
  return out;
}

/** 打包 (总是产出二进制; mode 记在 header 里) */
export function buildPacket(msg: EfficodeMessage): Uint8Array {
  const mode: EfficodeMode = msg.mode ?? 'compact';
  if (!(mode in MODE_TO_NUM)) {
    // 语音/声波模式等未实现模式 = 显式拒绝, 不静默降级
    throw new EfficodeError('EFFICODE_MODE_NOT_IMPLEMENTED', `模式 ${String(mode)} 未实现 (只有 compact/text)`);
  }
  const instructions = msg.instructions ?? [];
  if (!instructions.length) throw new EfficodeError('EFFICODE_BAD_FLAGS', '指令段不能为空 (至少一条指令)');

  const hasDid = typeof msg.from === 'string' && msg.from.length > 0;
  const didSeg = hasDid ? encodeDidSegment(msg.from as string) : null;
  if (didSeg && didSeg.length !== DID_SEGMENT_BYTES) {
    throw new EfficodeError('EFFICODE_DID_SEGMENT_BAD', `DID 段长度异常 ${didSeg.length}B`);
  }

  const opBytes = encodeInstructions(instructions);
  const rawData = Buffer.from(msg.data ?? '', 'utf-8');
  const algo: CompressionAlgo = msg.compression ?? pickAlgo(new Uint8Array(rawData));
  const dataBlock = rawData.length > 0 ? compressBlock(new Uint8Array(rawData), algo) : new Uint8Array(0);

  let flags = F_HAS_OP;
  if (didSeg) flags |= F_HAS_DID;
  if (dataBlock.length > 0) flags |= F_HAS_DATA;
  if (dataBlock.length > 0 && algo !== 'none') flags |= F_COMPRESSED;

  const out: number[] = [];
  out.push(((EFFICODE_VERSION & 0xf) << 4) | (MODE_TO_NUM[mode] & 0xf));
  out.push(flags);
  if (didSeg) for (const b of didSeg) out.push(b);
  writeVarint(out, opBytes.length);
  for (const b of opBytes) out.push(b);
  if (dataBlock.length > 0) {
    writeVarint(out, dataBlock.length);
    for (const b of dataBlock) out.push(b);
  }
  const head = Uint8Array.from(out);
  const crc = crc32Bytes(head);
  const packet = new Uint8Array(head.length + CRC_BYTES);
  packet.set(head, 0);
  packet.set(crc, head.length);
  return packet;
}

/** 编码成要上网的形态: text 模式 → Base64 串; compact 模式 → 二进制 */
export function encodePacket(msg: EfficodeMessage): string | Uint8Array {
  const packet = buildPacket(msg);
  const mode = msg.mode ?? 'compact';
  return mode === 'text' ? Buffer.from(packet).toString('base64') : packet;
}

/** 解析 (严格)。入参可以是二进制包或 text 模式的 Base64 串 */
export function parsePacket(input: string | Uint8Array): DecodedPacket {
  let mode: EfficodeMode;
  let buf: Uint8Array;
  if (typeof input === 'string') {
    mode = 'text';
    const cleaned = input.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
      throw new EfficodeError('EFFICODE_BAD_BASE64', '文本模式载荷不是合法 Base64');
    }
    buf = new Uint8Array(Buffer.from(cleaned, 'base64'));
    if (buf.length === 0) throw new EfficodeError('EFFICODE_BAD_BASE64', 'Base64 解出 0 字节');
  } else {
    mode = 'compact';
    buf = input;
  }

  if (buf.length < MIN_PACKET_BYTES) {
    throw new EfficodeError('EFFICODE_TOO_SHORT', `包 ${buf.length}B < 最短合法 ${MIN_PACKET_BYTES}B`);
  }

  const version = (buf[0] >> 4) & 0xf;
  if (version !== EFFICODE_VERSION) {
    throw new EfficodeError('EFFICODE_BAD_VERSION', `包版本 ${version} 不被支持 (本实现只认 ${EFFICODE_VERSION})`, 0);
  }
  const modeNum = buf[0] & 0xf;
  const declaredMode = NUM_TO_MODE[modeNum];
  if (!declaredMode) throw new EfficodeError('EFFICODE_BAD_MODE', `未知模式 id=${modeNum}`, 0);
  if (declaredMode !== mode) {
    throw new EfficodeError('EFFICODE_BAD_MODE', `传输形态(${mode})与包头声明(${declaredMode})不一致`, 0);
  }

  const flags = buf[1];
  if ((flags & FLAG_RESERVED) !== 0) {
    throw new EfficodeError('EFFICODE_BAD_FLAGS', `flags 保留位被置位: 0x${flags.toString(16)}`, 1);
  }

  let pos = 2;
  let didDigest: string | null = null;
  let didSegmentHex: string | null = null;
  if (flags & F_HAS_DID) {
    if (pos + DID_SEGMENT_BYTES > buf.length) {
      throw new EfficodeError('EFFICODE_TRUNCATED', `声明有 DID 段但只剩 ${buf.length - pos}B`, pos);
    }
    const seg = buf.subarray(pos, pos + DID_SEGMENT_BYTES);
    const parsed = decodeDidSegment(seg); // algo 未知 → 抛
    didDigest = didDigestString(parsed);
    didSegmentHex = Buffer.from(seg).toString('hex');
    pos += DID_SEGMENT_BYTES;
  }

  let instructions: Instruction[] = [];
  if (flags & F_HAS_OP) {
    const opLen = readVarint(buf, pos);
    pos = opLen.next;
    if (pos + opLen.value > buf.length) {
      throw new EfficodeError('EFFICODE_TRUNCATED', `指令段声明 ${opLen.value}B 但只剩 ${buf.length - pos}B`, pos);
    }
    instructions = decodeInstructions(buf.subarray(pos, pos + opLen.value));
    pos += opLen.value;
  } else {
    throw new EfficodeError('EFFICODE_BAD_FLAGS', 'flags 声明无指令段 —— 本实现不接受无指令的包', 1);
  }

  let data = '';
  let compression: CompressionAlgo = 'none';
  let rawDataBytes = 0;
  if (flags & F_HAS_DATA) {
    const dataLen = readVarint(buf, pos);
    pos = dataLen.next;
    if (pos + dataLen.value > buf.length) {
      throw new EfficodeError('EFFICODE_TRUNCATED', `数据块声明 ${dataLen.value}B 但只剩 ${buf.length - pos}B`, pos);
    }
    const block = buf.subarray(pos, pos + dataLen.value);
    const un = decompressBlock(block);
    compression = un.algo;
    rawDataBytes = un.data.length;
    data = Buffer.from(un.data).toString('utf-8');
    pos += dataLen.value;
  }

  const expectCrcAt = buf.length - CRC_BYTES;
  if (pos !== expectCrcAt) {
    throw new EfficodeError('EFFICODE_TRAILING_BYTES', `解析在 ${pos}B 结束, 但 CRC 段在 ${expectCrcAt}B —— 中间有 ${expectCrcAt - pos}B 垃圾`, pos);
  }
  const head = buf.subarray(0, expectCrcAt);
  const want = readCrc32Bytes(buf, expectCrcAt);
  const got = crc32(head);
  if (want !== got) {
    throw new EfficodeError('EFFICODE_CRC_MISMATCH', `CRC32 不符: 包内 0x${want.toString(16)}, 实算 0x${got.toString(16)}`, expectCrcAt);
  }

  return {
    mode: declaredMode,
    didDigest,
    didSegmentHex,
    instructions,
    data,
    compression,
    bytes: buf.length,
    rawDataBytes,
  };
}

/** 便捷: 包 → 语义消息 (保留符号化形态, 供文本模式/调试面读取) */
export function packetToMessage(input: string | Uint8Array): EfficodeMessage & { bytes: number; symbolic: string } {
  const p = parsePacket(input);
  return {
    instructions: p.instructions,
    data: p.data || undefined,
    mode: p.mode,
    compression: p.compression,
    bytes: p.bytes,
    symbolic: instructionsToSymbolic(p.instructions),
  };
}

/** 从符号化文本造一条消息 (调试/文本模式入口) */
export function messageFromSymbolic(text: string, data?: string): EfficodeMessage {
  return { instructions: symbolicToInstructions(text), data, mode: 'compact' };
}
