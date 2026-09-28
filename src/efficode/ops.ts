/**
 * efficode/ops - 指令集 / 词典 (符号 ↔ 二进制操作码)
 *
 * 照 leo 的规范: 符号化指令集 + 前缀表达式。
 *   @DID:  身份      1  载荷 = 身份串
 *   #DATA: 数据      2  载荷 = 数据正文
 *   #REQ:  请求      3  载荷 = 请求内容
 *   !ACK   确认      4  无载荷
 *   !SEND  发送      5  无载荷
 *   !END   结束      6  无载荷
 *
 * 指令段二进制形状 (逐条): [1B opcode][varint payloadLen][payload UTF-8]
 * 末尾**没有**隐式终止符 —— 靠 payloadLen 自描述; 少一个字节就报截断。
 *
 * 严格性: 任何不在表里的 opcode 一律抛 EFFICODE_UNKNOWN_OPCODE。
 * (变异 M1 会把这里改成"宽容跳过", 门必须变红 —— 这就是那条断言存在的意义。)
 */

import { EfficodeError, type Instruction, type OpSymbol } from './types.js';

export interface OpDef {
  symbol: OpSymbol;
  code: number;
  /** 是否带载荷 */
  hasPayload: boolean;
  /** 前缀表达式里的字面前缀 (控制指令为整串) */
  prefix: string;
}

export const OP_TABLE: OpDef[] = [
  { symbol: '@DID:', code: 1, hasPayload: true, prefix: '@DID:' },
  { symbol: '#DATA:', code: 2, hasPayload: true, prefix: '#DATA:' },
  { symbol: '#REQ:', code: 3, hasPayload: true, prefix: '#REQ:' },
  { symbol: '!ACK', code: 4, hasPayload: false, prefix: '!ACK' },
  { symbol: '!SEND', code: 5, hasPayload: false, prefix: '!SEND' },
  { symbol: '!END', code: 6, hasPayload: false, prefix: '!END' },
];

const BY_SYMBOL = new Map<OpSymbol, OpDef>(OP_TABLE.map((d) => [d.symbol, d]));
const BY_CODE = new Map<number, OpDef>(OP_TABLE.map((d) => [d.code, d]));

export function opBySymbol(symbol: OpSymbol): OpDef {
  const d = BY_SYMBOL.get(symbol);
  if (!d) throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `未知符号 ${String(symbol)}`);
  return d;
}

/** 按 opcode 取定义; 未知一律抛 (不返回 undefined 让上层"随便处理") */
export function opByCode(code: number, offset = -1): OpDef {
  const d = BY_CODE.get(code);
  if (!d) throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `操作码 ${code} 不在指令表内`, offset);
  return d;
}

export function isKnownOpCode(code: number): boolean {
  return BY_CODE.has(code);
}

/** 指令序列 → 前缀表达式文本 (调试/文本模式可读形态) */
export function instructionsToSymbolic(instructions: Instruction[]): string {
  return instructions
    .map((ins) => {
      const def = opBySymbol(ins.op);
      return def.hasPayload ? `${def.prefix}${ins.value ?? ''}` : def.prefix;
    })
    .join(' ');
}

/**
 * 前缀表达式文本 → 指令序列。
 *
 * 解析规则 (写死, 免得被当成"随便切"):
 *   ① 按空白切词;
 *   ② 词首是 sigil 字符 (@ / # / !) → 必须匹配一条**已知**前缀, 否则抛 UNKNOWN_OPCODE;
 *   ③ 不带 sigil 的词 → 追加到**上一条**指令的载荷后面 (没有上一条 → 抛);
 *   ④ 控制指令 (!ACK/!SEND/!END) 后面不许跟载荷。
 */
export function symbolicToInstructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  for (const token of words) {
    const isSigil = /^[@#!]/.test(token);
    if (!isSigil) {
      const last = out[out.length - 1];
      if (!last || !opBySymbol(last.op).hasPayload) {
        throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `前缀表达式含未知指令: ${token.slice(0, 24)}`);
      }
      last.value = `${last.value ?? ''} ${token}`.trim();
      continue;
    }
    const def = OP_TABLE.find((d) => token.startsWith(d.prefix));
    if (!def) throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `前缀表达式含未知指令: ${token.slice(0, 24)}`);
    if (def.hasPayload) out.push({ op: def.symbol, value: token.slice(def.prefix.length) });
    else if (token === def.prefix) out.push({ op: def.symbol });
    else throw new EfficodeError('EFFICODE_UNKNOWN_OPCODE', `控制指令 ${def.prefix} 不接受载荷: ${token.slice(0, 24)}`);
  }
  return out;
}
