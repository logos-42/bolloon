/**
 * efficode/types - Efficode 参考实现的公共类型
 *
 * 设计口径 (照 leo 给的规范, 不自行发明新协议):
 *   - 符号化指令集 + 前缀表达式: @DID: 身份 · #DATA: 数据 · #REQ: 请求 · !ACK/!SEND/!END 控制
 *   - 两种模式: 文本模式 (调试/低带宽, 可 Base64) 与 二进制模式 (默认, 高密度)
 *   - 自解压数据块: 数据块自带轻量解码规则 (压缩算法 id + 原始长度), 接收方按规则直接展开
 *   - 包结构: [Header 2B] | [DID 验证段 32B] | [指令段 动态] | [数据块 动态] | [CRC32 4B]
 *
 * 诚实标注 (都写进 docs/wiki/efficode.md, 不在这里当已验证结论):
 *   - 本文件是**参考实现**: 能真编真解、逐字节回环、畸形包报错;
 *   - 语音/声波模式 (ggwave 类) **未实现** —— 只留 `mode` 枚举里的保留位, 编码时显式拒绝;
 *   - 链上签名验证 / ECC 临时会话密钥 **规范中** —— 本实现只做 DID 摘要段, 不做签名;
 *   - 压缩率/信息密度这类宣传数字一律按**实测**写, 见 scripts/verify-efficode.ts 的真测输出。
 */

/** 智能体交流语言声明。除这两个值以外的一切取值都视为"未知语言" */
export type AgentLang = 'natural' | 'efficode';

/** 传输模式 */
export type EfficodeMode = 'compact' | 'text';

/** 压缩层算法 id (数据块第一字节) —— 可插拔 */
export type CompressionAlgo = 'none' | 'lz77' | 'deflate';

export const COMPRESSION_IDS: Record<CompressionAlgo, number> = {
  none: 0,
  lz77: 1,
  deflate: 2,
};

export const COMPRESSION_BY_ID: Record<number, CompressionAlgo> = {
  0: 'none',
  1: 'lz77',
  2: 'deflate',
};

/** 包版本 (Header 高 4 位) */
export const EFFICODE_VERSION = 1;

/** DID 段固定长度 (字节) —— 照规范: 32B */
export const DID_SEGMENT_BYTES = 32;

/** CRC32 尾段固定长度 (字节) */
export const CRC_BYTES = 4;

/** 最短合法包 = Header 2 + 无 DID 段 + 指令段最少 (varint 长度 1 + 一条控制指令 2) + 无数据块 + CRC 4 = 9B
 *  (DID 段 32B 是**可选**省略的, 所以不放进来; 带 DID 的包应 ≥ 41B, 由 flags 驱动逐段校验而不是靠这个下限) */
export const MIN_PACKET_BYTES = 2 + 1 + 2 + CRC_BYTES;

/** 结构化失败码。解码器**只**抛这些, 绝不"猜着解" */
export type EfficodeErrorCode =
  | 'EFFICODE_TOO_SHORT'
  | 'EFFICODE_BAD_VERSION'
  | 'EFFICODE_BAD_MODE'
  | 'EFFICODE_BAD_FLAGS'
  | 'EFFICODE_TRUNCATED'
  | 'EFFICODE_CRC_MISMATCH'
  | 'EFFICODE_TRAILING_BYTES'
  | 'EFFICODE_UNKNOWN_OPCODE'
  | 'EFFICODE_UNKNOWN_COMPRESSION'
  | 'EFFICODE_BAD_BASE64'
  | 'EFFICODE_MODE_NOT_IMPLEMENTED'
  | 'EFFICODE_DID_SEGMENT_BAD'
  | 'EFFICODE_LANG_UNSUPPORTED';

export class EfficodeError extends Error {
  readonly code: EfficodeErrorCode;
  /** 出错位置 (字节偏移); 拿不到时为 -1 */
  readonly offset: number;
  constructor(code: EfficodeErrorCode, message: string, offset = -1) {
    super(`${code}: ${message}${offset >= 0 ? ` (offset=${offset})` : ''}`);
    this.name = 'EfficodeError';
    this.code = code;
    this.offset = offset;
  }
}

/** 指令集里的符号 (前缀表达式) */
export type OpSymbol = '@DID:' | '#DATA:' | '#REQ:' | '!ACK' | '!SEND' | '!END';

/** 一条指令 (前缀表达式的一个节点) */
export interface Instruction {
  op: OpSymbol;
  /** 载荷 —— 控制指令 (!ACK/!SEND/!END) 无载荷 */
  value?: string;
}

/** 解包后的消息 (编码前的语义对象) */
export interface EfficodeMessage {
  /** 发送方身份 (@DID:)。不给则包内不含 DID 段 */
  from?: string;
  /** 指令序列, 至少一条 */
  instructions: Instruction[];
  /** 数据块内容 (#DATA 的正文; 文本按 UTF-8) */
  data?: string;
  /** 传输模式 */
  mode?: EfficodeMode;
  /** 压缩层算法。默认 deflate */
  compression?: CompressionAlgo;
}

/** 解包结果 */
export interface DecodedPacket {
  mode: EfficodeMode;
  /** 从 DID 段还原出的身份摘要 (不是原始 DID 字符串 —— 32B 装不下, 只装摘要) */
  didDigest: string | null;
  /** DID 段的原始 32 字节 (hex), 便于对比 */
  didSegmentHex: string | null;
  instructions: Instruction[];
  data: string;
  compression: CompressionAlgo;
  /** 包总字节数 */
  bytes: number;
  /** 压缩前数据块字节数 (自解压快照) */
  rawDataBytes: number;
}
