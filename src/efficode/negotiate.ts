/**
 * efficode/negotiate - 智能体"用哪种语言交流"的声明与协商
 *
 * 三条硬规则 (照 leo 的要求):
 *   ① 只有**双方都声明** efficode 才用 Efficode;
 *   ② 单方声明 / 对端不支持 / 对端声明了本机不认识的字符串 ⇒ **明确回落自然语言**, 并记一笔;
 *   ③ 声明语言**不是** efficode 的载荷, **绝不去解析它** (不猜、不试解) ——
 *      `decodeFromPeer` 里那条 `EFFICODE_LANG_UNSUPPORTED` 就是这条的落地处。
 *
 * 记录: 每次裁决写 ~/.bolloon/efficode-lang.jsonl (只记语言名与原因, **不记正文/DID**)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EfficodeError, type AgentLang, type Instruction, type OpSymbol } from './types.js';
import { buildPacket, parsePacket } from './packet.js';
import { instructionsToSymbolic } from './ops.js';

export const AGENT_LANGS: AgentLang[] = ['natural', 'efficode'];

/** 把任意外来声明归一成两个已知值之一; 其他一律 null (= 未知语言, **不是** natural) */
export function normalizeLang(v: unknown): AgentLang | null {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === 'natural' || s === 'efficode') return s;
    return null;
  }
  if (Array.isArray(v)) {
    // manifest 里的 supportedLangs 形态: 优先 efficode (更专的声明优先)
    if (v.some((x) => x === 'efficode')) return 'efficode';
    if (v.some((x) => x === 'natural')) return 'natural';
    return null;
  }
  return null;
}

/** 声明里出现了哪些**本机不认识**的语言字符串 (用于如实标注, 不当成 natural) */
export function unknownLangNames(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((s) => s && !AGENT_LANGS.includes(s as AgentLang));
}

export interface LangDecision {
  /** 本次交流实际使用的语言 */
  lang: AgentLang;
  /** 是否发生了回落 (有一方想要 efficode 但没被采用) */
  fallback: boolean;
  reason: string;
  /** 解释用: 双方声明的原文 */
  declared: { mine: string | null; theirs: string | null };
  /** 哪一侧声明了本机不认识的字符串 */
  unknownSide: 'mine' | 'theirs' | 'both' | null;
}

/**
 * 协商。`mine`/`theirs` 可以是 'natural' | 'efficode' | 字符串数组 | undefined | 任意外来值。
 * 任何"不是恰好双方 efficode"的情形都落到 natural。
 */
export function negotiateLang(mine: unknown, theirs: unknown): LangDecision {
  const m = normalizeLang(mine);
  const t = normalizeLang(theirs);
  const mUnknown = unknownLangNames(mine);
  const tUnknown = unknownLangNames(theirs);
  const declared = {
    mine: Array.isArray(mine) ? mine.join('|') : mine == null ? null : String(mine),
    theirs: Array.isArray(theirs) ? theirs.join('|') : theirs == null ? null : String(theirs),
  };
  const unknownSide: LangDecision['unknownSide'] =
    mUnknown.length && tUnknown.length ? 'both' : mUnknown.length ? 'mine' : tUnknown.length ? 'theirs' : null;

  if (m === 'efficode' && t === 'efficode') {
    return { lang: 'efficode', fallback: false, reason: '双方都声明 efficode', declared, unknownSide };
  }
  const wanted = m === 'efficode' || t === 'efficode';
  let reason: string;
  if (!m && !t) {
    reason = unknownSide ? '双方都没有可识别的语言声明' : '双方都没声明语言';
  } else if (m === 'efficode') {
    reason = unknownSide
      ? `对端声明了本机不认识的语言 (${tUnknown.join(',')}) → 回落自然语言`
      : '对端没声明 efficode → 回落自然语言';
  } else if (t === 'efficode') {
    reason = '本机没声明 efficode → 回落自然语言';
  } else {
    reason = unknownSide ? '声明里只有本机不认识的语言 → 回落自然语言' : '双方都只声明 natural';
  }
  return { lang: 'natural', fallback: wanted, reason, declared, unknownSide };
}

// ============== 出站 / 入站 ==============

export interface OutgoingResult {
  /** 真正要发到线上的文本 (回落时 = 原文) */
  text: string;
  /** 随消息一起声明的语言 */
  lang: AgentLang;
  decision: LangDecision;
  /** efficode 分支下的包字节数 (回落时为 0) */
  bytes: number;
  /** 条件满足但没用 efficode 时的原因 (人话) */
  note: string;
  /** 调试面可读的符号化指令 (回落时为空) */
  symbolic: string;
}

/**
 * 出站: **双方都声明** efficode 才编码; 否则原文直发 (声明 natural)。
 * 走的是文本模式 (整个包 Base64), 所以线上仍是可打印文本, 任何文本通道都能带。
 *
 * 指令构造 (照规范的前缀表达式): `@DID:<身份> <op> !SEND`
 *   —— 正文进**数据块**, 指令段只放"这是什么"。
 */
export function encodeForPeer(opts: {
  text: string;
  mine: unknown;
  theirs: unknown;
  from?: string;
  op?: OpSymbol;
}): OutgoingResult {
  const decision = negotiateLang(opts.mine, opts.theirs);
  if (decision.lang !== 'efficode') {
    return { text: opts.text, lang: 'natural', decision, bytes: 0, note: decision.reason, symbolic: '' };
  }
  const instructions: Instruction[] = [];
  if (opts.from) instructions.push({ op: '@DID:', value: opts.from });
  instructions.push({ op: opts.op ?? '#DATA:', value: '' });
  instructions.push({ op: '!SEND' });
  const packed = buildPacket({
    from: opts.from,
    instructions,
    data: opts.text,
    mode: 'text',
    compression: 'deflate',
  });
  return {
    text: Buffer.from(packed).toString('base64'),
    lang: 'efficode',
    decision,
    bytes: packed.length,
    note: '',
    symbolic: instructionsToSymbolic(instructions),
  };
}

export interface IncomingResult {
  /** 要展示/处理的文本 */
  text: string;
  /** 对端声明的语言 (归一后; 未知语言 = null) */
  declaredLang: AgentLang | null;
  /** 对端声明的语言原文 */
  declaredRaw: string | null;
  /** 是否真做了解码 */
  decoded: boolean;
  /** 没解码时的原因 (人话; 解码成功为 '') */
  note: string;
  /** 解码成功时的包字节数 */
  bytes: number;
}

/**
 * 入站:**严格**按对端声明的语言分派。
 * - 声明 efficode 且本机也声明支持 → 真解包 (畸形/CRC 不符 → 抛, 不许"解一半");
 * - 声明不是 efficode (含未知字符串) → 原样返回, **不进解码器**。
 */
export function decodeFromPeer(opts: { payload: string; declaredLang: unknown; mine: unknown }): IncomingResult {
  const raw = Array.isArray(opts.declaredLang)
    ? opts.declaredLang.join('|')
    : opts.declaredLang == null
      ? null
      : String(opts.declaredLang);
  const declared = normalizeLang(opts.declaredLang);
  const mineOk = normalizeLang(opts.mine) === 'efficode';

  if (declared !== 'efficode') {
    return {
      text: opts.payload,
      declaredLang: declared,
      declaredRaw: raw,
      decoded: false,
      note:
        raw && declared === null
          ? `对端声明的语言「${raw}」本机不认识 → 不解析, 原样呈现`
          : '对端未声明 efficode → 原样呈现',
      bytes: 0,
    };
  }
  if (!mineOk) {
    throw new EfficodeError(
      'EFFICODE_LANG_UNSUPPORTED',
      '对端声明 efficode, 但本机未声明支持 → 拒绝解码 (不许硬解)'
    );
  }
  const p = parsePacket(opts.payload);
  return { text: p.data, declaredLang: declared, declaredRaw: raw, decoded: true, note: '', bytes: p.bytes };
}

/** 本机默认声明哪种语言 (没给 = natural; 声明不变量绝不会"猜"成 efficode) */
export function defaultDeclaredLang(env: NodeJS.ProcessEnv = process.env): AgentLang {
  const v = String(env.BOLLOON_EFFICODE_LANG ?? '').trim();
  return normalizeLang(v) ?? 'natural';
}

// ============== 裁决记录 (只记语言与原因, 不记正文) ==============

export function langDecisionLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.BOLLOON_HOME || path.join(os.homedir() || '/tmp', '.bolloon');
  return path.join(home, 'efficode-lang.jsonl');
}

/** 记一笔 (失败绝不打断主路径 —— 记录是旁路) */
export function recordLangDecision(decision: LangDecision, meta: { channel: string; peer?: string }): boolean {
  try {
    const file = langDecisionLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      channel: meta.channel,
      peer: meta.peer ? String(meta.peer).slice(0, 64) : null,
      lang: decision.lang,
      fallback: decision.fallback,
      reason: decision.reason,
      unknownSide: decision.unknownSide,
      declared: decision.declared,
    });
    fs.appendFileSync(file, line + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 读回记录 (门用来断言"真记了一笔") */
export function readLangDecisionLog(env: NodeJS.ProcessEnv = process.env): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(langDecisionLogPath(env), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}
